/**
 * The store's Telegram half: a mailbox fed by the Telegram bridge (a separate process that holds the Telegram login), and turning what it pushes into rows. Synchronous SQL over the same
 * ports as the rest of the store, so every rule here runs under plain `bun` against a real SQLite; the bridge's door (src/telegram/app.ts) calls these in short
 * transactions.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `Inbox` → `ArrivalStore` → `TelegramStore` → `MailStore`: like arrival.ts, this class sits between so it can use the base's `audit`, `identityFor` and
 * `touchConversation` without making them public, and so mail.ts is not made longer by a third kind of mailbox.
 *
 * ── THE PUSH IS A HINT, THE POSITION IS THE KEEPER ───────────────────────
 * Telegram's position (pts, qts, date, seq) is stored on the mailbox row in the SAME transaction as the batch it follows, so it never gets ahead of what is stored;
 * a restart in between asks Telegram for the difference again and the arrival key makes a repeat store nothing. A message is found by (mailbox, arrival key), which is
 * `<chat id>:<Telegram's message id>`: a push repeated after a timeout stores one message. The bridge is the only writer and its door admits one token.
 *
 * ── THE LOGIN CODE NEVER ARRIVES ─────────────────────────────────────────
 * Telegram's service chat (777000) and the owner's Saved Messages are refused here as well as dropped at the bridge's edge (src/telegram/wire.ts says why). A push
 * that holds one is stored without it and the rest is kept; the count of what was refused comes back.
 *
 * ── READ AND CLOSED ARE THE INBOX'S OWN STAMPS ───────────────────────────
 * As for a Cloudflare mailbox: a message from the other person arrives with neither stamp (unread, open), the owner's own message is filed read and closed, and a new
 * message on a closed conversation has no closed stamp, so it reopens it. In a `mirror` (the first fill, a read-through) a new message is stamped read when Telegram
 * has it read, and a conversation the push makes comes in closed when the chat is archived in Telegram. Telegram's own read marks and folders are never written to.
 *
 * ── GROUPS AND CHANNELS ────────────────────────────────────────
 * A group is ONE conversation under ONE contact that stands for it (named by its title, the conversation's only participant), so under the inbox's rule that a thread is one row under
 * whoever last wrote, the group's row never moves between its members. Every member who writes is a person: a message is filed under its SENDER's identity (the Telegram
 * user id, so the same person as their one-to-one chat), and the sender is not a participant, which is what keeps their own history to what passed between the two of them and the group
 * out of it. A channel is the same with no sender: its posts are filed under the channel's contact, and the contact is judged an automated sender (src/automated.ts), which is what
 * puts its conversation in Bulk by the one Bulk rule. A supergroup and a channel have a position of their own (`conversation.telegram_pts`), stored in the same transaction as the batch it
 * follows, as the account's is.
 *
 * A group message is ADDRESSED to the owner (`message.telegram_to_me`) when Telegram marks it as mentioning them or it replies to one of their own messages. Only an addressed message
 * rings, shows Needs reply, and reopens a closed group: any other message in a closed group is filed closed too (so it does not reopen it), and in an open group it is an ordinary unread one.
 *
 * ── NOTIFICATIONS, BY THE MAIL RULE ──────────────────────────────────────
 * A message stored by a LIVE push (`push.live`: the bridge's live drain, as against a first fill, a read-through or a catch-up) is put to the Telegram branch of the notification
 * rule (src/notify/rule.ts `telegramNotifyDecision`) once, after the push's own transaction has filed it and touched its conversation, and marked `notify = 'owed'` when it passes. The
 * owed mark is delivered by the Durable Object after the call (src/durable.ts), as a Cloudflare arrival's is. A fill or a catch-up marks nothing, so neither can ring a burst; a chat
 * the owner muted in Telegram never rings, by the flag the push carried with that very message (it is stored nowhere: the next message brings Telegram's answer again).
 */

import { SNIPPET_CHARS } from '../cloudflare/parse'
import { telegramNotifyDecision } from '../notify/rule'
import { telegramLoginEnded, telegramPictureOnlyOwner } from '../owner-words'
import { ALL_MAIL, isBulk, type MailScope } from '../queue'
import {
  attachmentOf,
  MEDIA_DROP_PREFIX,
  MEDIA_OWED_FOR_MS,
  MEDIA_OWED_PREFIX,
  mediaKey,
  planTelegramFile,
} from '../telegram/media'
import type {
  EventsResult,
  OutcomesResult,
  PushResult,
  TelegramChat,
  TelegramEvents,
  TelegramMedia,
  TelegramMediaRefusal,
  TelegramMessage,
  TelegramOutcomes,
  TelegramOwed,
  TelegramPosition,
  TelegramPush,
  TelegramRead,
  TelegramSender,
  TelegramState,
  TelegramStatusReport,
  TelegramWork,
  TelegramWorkRequest,
} from '../telegram/wire'
import {
  CHANNEL_ID_PREFIX,
  hasOwnPosition,
  LIMITS,
  SEND_FETCH_TIMEOUT_MS,
  SEND_IN_FLIGHT_MS,
  SEND_RETRY_FOR_MS,
  TELEGRAM_COPIED_KINDS,
  TELEGRAM_PICTURE_TYPES,
  TELEGRAM_SERVICE_CHAT,
  TELEGRAM_SMALL_FILE_MAX_BYTES,
  TELEGRAM_VIDEO_MAX_BYTES,
  type TelegramCopiedKind,
  type TelegramPictureQuery,
  type TelegramPictureType,
} from '../telegram/wire'
import {
  type AttachmentInfo,
  isAgent,
  type MessageRow,
  TELEGRAM_ACTOR,
  type TelegramFile,
  type TelegramMailboxStatus,
} from '../types'
import { classifyAddress } from './address'
import { ArrivalStore } from './arrival'
import { CHANGED_SINCE_SHOWN, fail, jsonArray, ok, PENDING, type Result, text, textOrNull } from './store'

/** How often the bridge's work requests may write the "checked in" stamp: at most once a minute. */
export const CHECK_IN_EVERY_MS = 60_000

/** The `setting` rows that say a basic group has been read back 30 days (`TelegramPush.backRead`): no table and no column, so no migration. */
export const BACK_READ_PREFIX = 'telegram-back-read:'

/**
 * The `setting` rows that say a chat's last 30 days were read again for their files (`TelegramPush.mediaRead`): `telegram-media-read:<chat id>`. An earlier bridge sent no file with any message (a mapping bug),
 * so every message stored then says nothing of its file; this is how they are given it. No table and no column, so no migration.
 */
export const MEDIA_READ_PREFIX = 'telegram-media-read:'

/**
 * The `setting` row that says the videos left for being too large were looked at again for a video limit: `telegram-video-cap:<the limit in bytes>`. The limit went from 10 MB to 50 MB, so a video held
 * as `left` / `too-large` that is within the new limit is owed to the bridge once (`oweVideosWithinLimit`, run by the first `work` request of a bridge that says it takes videos of that size, `videoMax`: a bridge from before would refuse each for good, so its request neither runs the pass nor uses up its one run). The limit is in the key, so a later change of it
 * runs the pass once more, and the pass itself only touches what is still `left` for being too large: running it twice changes nothing. No table and no column, so no migration.
 */
export const VIDEO_LIMIT_PASS_PREFIX = 'telegram-video-cap:'

/**
 * The `setting` rows that say Telegram is owed a read mark for a chat: the value is the newest message id the owner was shown, nothing more. No table and no column, so no migration. A row is
 * offered to the bridge by every work request until its outcome settles it; a later mark for the chat only ever raises it.
 */
export const READ_OWED_PREFIX = 'telegram-read-owed:'

/**
 * The `setting` rows that say Telegram is owed a SEND: `telegram-send:<message id>`, the value a small JSON object (`OwedSend`): the random id that is Telegram's own repeat key (made once, when the
 * draft is claimed, and stored with it), the chat, who pressed Send, when it was claimed and when the bridge was first offered it. No table and no column, so no migration. A row is offered to the bridge by
 * every work request for `SEND_RETRY_FOR_MS` after its first offer and no longer; an outcome (or the owner's own answer about a send that stayed unknown) deletes it.
 */
export const SEND_OWED_PREFIX = 'telegram-send:'

/** `telegram-send-failed:<message id>`: why Telegram would not take a send, in words, kept on the draft that went back to being one so the person sees it. Deleted when the draft is sent again. */
export const SEND_FAILED_PREFIX = 'telegram-send-failed:'

/**
 * The timing of a send is `src/telegram/wire.ts`'s (`SEND_RETRY_FOR_MS`, `SEND_IN_FLIGHT_MS`): offered for five minutes from the first offer (a repeat under the same random id inside this time is safe:
 * Telegram stores a message sent twice with one key once, which a probe against the real service proved for a repeat made at once), never after, and the owner may answer for it only once it can no longer be going out.
 * Past that its outcome is unknown, shown as "check Telegram".
 */

/**
 * How far apart the clocks of the inbox and Telegram may be, for the checks that compare a message's time with the time a send was claimed (two minutes): a copy of a send Telegram stamped a little
 * before the inbox's own clock says it was claimed is still that send.
 */
export const SEND_CLOCK_SKEW_MS = 2 * 60_000

/** What the card says of a send the bridge was never offered in its five minutes (the bridge was not running): plain, and nothing to check. */
export const SEND_NOT_OFFERED_NOTE = 'Not sent: the Telegram bridge was not running. Press Send again.'

/** After this long without a work request the bridge counts as not checked in, whatever it last said of itself (five minutes). */
export const NOT_CHECKED_IN_AFTER_MS = 5 * 60_000

/** The Telegram mailbox's pill. */
export const TELEGRAM_MAILBOX_NAME = 'Telegram'

/** What one push has settled so far, shared by its messages. */
interface Filing {
  mailboxId: string
  at: string
  mirror: boolean
  /** One identity and one conversation per chat in the push, found or made the first time a message needs it. */
  conversations: Map<string, ConversationFound>
  /** A group's senders, once each per push. */
  senders: Map<string, { id: string; name: string }>
  /** Whether a group's conversation is open as the messages filed so far leave it: a message not addressed to the owner must not reopen a closed group. */
  openNow: Map<string, boolean>
  /** The messages this push stored, for the notification rule once their conversations are touched. */
  fresh: FreshMessage[]
}

interface FreshMessage {
  id: string
  conv: ConversationFound
  chat: TelegramChat
  m: TelegramMessage
  toMe: boolean
}

/** A conversation a push is filing into: found or made, with its one person. */
interface ConversationFound {
  conversationId: string
  /** The chat's one identity: the person's, or the contact that stands for a group or a channel. */
  identityId: string
  /** What the chat is called: the person's name as Telegram gives it, or the group's or channel's title. */
  name: string
  isNew: boolean
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The Telegram chat a conversation is, and the account's mailbox it is in. */
export interface TelegramChatFacts {
  mailboxId: string
  /** The owner's Telegram user id (the mailbox's address). */
  account: string
  chatId: string
  /** `user`, `bot`, `group` or `channel`; null for a conversation made before groups were carried. */
  kind: string | null
}

/** A picture a Telegram draft carries: its type by its first bytes, its length and the SHA-256 of its bytes (its fingerprint, lowercase hex). */
export interface PictureFacts {
  type: TelegramPictureType
  size: number
  sha256: string
}

/** The picture a send goes out with. `fresh` is a picture attached by this very press (the owner's composer): its bytes are written to the bucket and named on the draft in the same claim. Otherwise the draft already carries it. */
export interface SendPicture extends PictureFacts {
  fresh: boolean
}

/** What a message that is a picture alone is called, as the bridge's own copy of one is (`mapping.ts`'s label for a photo). */
const PICTURE_ALONE = '[Photo]'

/** What a `telegram-send:` row holds. */
export interface OwedSend {
  /** Telegram's repeat key for this message (a decimal string for a 64-bit number), made when the draft was claimed. */
  randomId: string
  /** The chat it goes to, as the wire spells it. */
  chatId: string
  /** Who pressed Send (the owner's address, or Claude's actor on their recorded instruction): the sent message is filed as theirs. */
  by: string
  claimedAt: string
  /** When the bridge was first offered it; null while it has not asked. */
  offeredAt: string | null
  /** Only on a send that goes out as a photo: the picture, as it was when the draft was claimed (a claimed draft cannot be edited, so this is also what the bucket holds). */
  picture?: PictureFacts
}

/** The row that owes a file: the chat and message to download and what kind it is; null for anything that is not that. */
function parseOwedMedia(value: unknown): { chatId: string; id: number; kind: TelegramCopiedKind } | null {
  if (typeof value !== 'string') return null
  try {
    const v = JSON.parse(value) as Record<string, unknown>
    if (typeof v.chatId !== 'string' || typeof v.id !== 'number' || !Number.isSafeInteger(v.id)) return null
    if (!(TELEGRAM_COPIED_KINDS as readonly unknown[]).includes(v.kind)) return null
    return { chatId: v.chatId, id: v.id, kind: v.kind as TelegramCopiedKind }
  } catch {
    return null
  }
}

const parseOwedSend = (value: unknown): OwedSend | null => {
  try {
    const v = JSON.parse(text(value)) as Partial<OwedSend>
    if (
      !(
        typeof v.randomId === 'string' &&
        typeof v.chatId === 'string' &&
        typeof v.by === 'string' &&
        typeof v.claimedAt === 'string' &&
        (v.offeredAt === null || typeof v.offeredAt === 'string')
      )
    )
      return null
    const p = v.picture
    if (
      p !== undefined &&
      !(TELEGRAM_PICTURE_TYPES.includes(p.type) && Number.isSafeInteger(p.size) && typeof p.sha256 === 'string')
    )
      return null
    return v as OwedSend
  } catch {
    return null
  }
}

/** A random 62-bit positive number as a decimal string: Telegram's `random_id` (a 64-bit number), kept in the range the bridge's probe used. */
function newRandomId(): string {
  const n = BigInt.asUintN(62, crypto.getRandomValues(new BigUint64Array(1))[0] as bigint)
  return (n === 0n ? 1n : n).toString()
}

/**
 * Telegram's short answers to a send, in words for the person. Anything not listed is said as the code, which is all Telegram gave: never a message's text. The codes are those Telegram documents for
 * `messages.sendMessage` (and the bridge's own `NOT_CARRIED` and `UNKNOWN_CHAT`).
 */
const SEND_REFUSALS: Record<string, string> = {
  USER_IS_BLOCKED: 'They have blocked you.',
  USER_PRIVACY_RESTRICTED: 'Their privacy settings do not let you write to them.',
  INPUT_USER_DEACTIVATED: 'That account was deleted.',
  PEER_ID_INVALID: 'Telegram does not know this chat.',
  CHAT_WRITE_FORBIDDEN: 'You cannot write in this chat.',
  CHAT_RESTRICTED: 'You cannot write in this chat.',
  CHAT_ADMIN_REQUIRED: 'Only admins can write in this chat.',
  USER_BANNED_IN_CHANNEL: 'You were banned from writing in this chat.',
  CHANNEL_PRIVATE: 'You can no longer see this chat.',
  MESSAGE_TOO_LONG: 'The message is too long for Telegram.',
  YOU_BLOCKED_USER: 'You blocked this person in Telegram. Unblock them there first.',
  NOT_CARRIED: 'The bridge does not carry this chat.',
  MESSAGE_EMPTY: 'There was nothing to send.',
  NO_RANDOM_ID: 'The bridge could not make this send. Nothing was sent.',
  UNKNOWN_CHAT: 'The bridge does not know this chat.',
  GAVE_UP: 'The bridge tried and Telegram would not take it.',
  // A picture. The codes are Telegram's documented answers to a photo; which ones a real send meets is the hand test.
  CHAT_SEND_PHOTOS_FORBIDDEN: 'This group does not allow pictures.',
  CHAT_SEND_MEDIA_FORBIDDEN: 'This group does not allow pictures.',
  CHAT_SEND_PLAIN_FORBIDDEN: 'This group does not allow messages like this.',
  PHOTO_INVALID_DIMENSIONS: 'Telegram does not take a picture of this shape (it is too tall, too wide or too small).',
  PHOTO_SAVE_FILE_INVALID: 'Telegram could not store this picture.',
  PHOTO_EXT_INVALID: 'Telegram does not take this kind of picture.',
  IMAGE_PROCESS_FAILED: 'Telegram could not process this picture.',
  MEDIA_CAPTION_TOO_LONG: 'The words under the picture are too long for Telegram.',
  MEDIA_EMPTY: 'Telegram says the picture is empty.',
  BAD_PICTURE: 'The picture is not one the bridge will send, so nothing was sent.',
}
const refusalWords = (code: string): string => SEND_REFUSALS[code] ?? `Telegram said ${code}.`

/** A person as the inbox names them: the name Telegram gives, else the username, else the id. */
const personName = (p: TelegramSender): string => collapse(p.name) || p.username || p.id

const positionOf = (value: unknown): TelegramPosition | null => {
  if (typeof value !== 'string') return null
  try {
    const p = JSON.parse(value) as Partial<TelegramPosition>
    return typeof p.pts === 'number' &&
      typeof p.qts === 'number' &&
      typeof p.date === 'number' &&
      typeof p.seq === 'number'
      ? { pts: p.pts, qts: p.qts, date: p.date, seq: p.seq }
      : null
  } catch {
    return null
  }
}

export class TelegramStore extends ArrivalStore {
  // ─── the mailbox ─────────────────────────────────────────────────────

  /**
   * The row of the owner's Telegram account, made by the first thing the bridge says (a push, a work request or a status), and kept after. One row for one account: the bridge
   * signed in as another account is refused (a 409), because its chats would be filed in a mailbox that is not theirs.
   */
  private telegramRow(accountId: string): Result<Record<string, unknown>> {
    const rows = this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'telegram' ORDER BY rowid`).toArray()
    const found = rows[0]
    if (found) {
      if (text(found.address) !== accountId) {
        return fail(
          409,
          `This inbox holds the Telegram account ${text(found.address)}; the bridge is signed in as ${accountId}. Nothing was stored.`,
        )
      }
      return ok(found)
    }
    const id = this.ports.newId()
    this.sql.exec(
      `INSERT INTO mailbox (id, kind, address, display_name, connected_at, connected_by) VALUES (?1, 'telegram', ?2, ?3, ?4, ?5)`,
      id,
      accountId,
      TELEGRAM_MAILBOX_NAME,
      this.now(),
      TELEGRAM_ACTOR,
    )
    this.seatMailbox(id, 'telegram', accountId, null)
    this.audit(TELEGRAM_ACTOR, 'mailbox.create', `mailbox:${id}`, null, {
      kind: 'telegram',
      address: accountId,
      name: TELEGRAM_MAILBOX_NAME,
    })
    return ok(this.sql.exec(`SELECT * FROM mailbox WHERE id = ?1`, id).one())
  }

  /** Telegram's stored position for the account, or null. */
  private storedPosition(row: Record<string, unknown>): TelegramPosition | null {
    return positionOf(row.history_id)
  }

  /** Store a position, but never move backwards: a late repeat of an older batch must not undo a newer one. */
  private keepPosition(mailboxId: string, next: TelegramPosition | undefined, current: TelegramPosition | null): void {
    if (!next) return
    if (current && next.pts < current.pts) return
    this.sql.exec(`UPDATE mailbox SET history_id = ?2 WHERE id = ?1`, mailboxId, JSON.stringify(next))
  }

  // ─── people ──────────────────────────────────────────────────────────

  /**
   * The contact that already has this phone number as a text identity, when exactly one does. Telegram gives a number only for a person in the owner's contacts who
   * allows it; a number two contacts share, or none does, joins nothing (never a join by name).
   */
  private contactByPhone(phone: string): string | null {
    const c = classifyAddress(`+${phone}`)
    if (c?.kind !== 'sms') return null
    const rows = this.sql
      .exec(`SELECT DISTINCT contact_id FROM identity WHERE kind = 'sms' AND address = ?1`, c.address)
      .toArray()
    return rows.length === 1 ? text(rows[0]?.contact_id) : null
  }

  /**
   * The identity of a Telegram person, made when it is new. A new one is put on the contact whose text-message number matches (audited, with the bridge as actor; Split
   * undoes a wrong join), else on a contact of its own named as Telegram names them. A contact that already has the identity keeps its name: a rename by the owner stands.
   */
  private telegramIdentity(person: TelegramSender): { id: string; contactId: string; name: string } {
    const found = this.sql
      .exec(
        `SELECT i.id AS id, i.contact_id AS contact_id, c.name AS name FROM identity i JOIN contact c ON c.id = i.contact_id
          WHERE i.kind = 'telegram' AND i.address = ?1`,
        person.id,
      )
      .toArray()[0]
    let identity: { id: string; contactId: string }
    if (found) {
      identity = { id: text(found.id), contactId: text(found.contact_id) }
      this.learnName(identity, text(found.name), person)
    } else {
      const joinTo = person.bot ? null : person.phone ? this.contactByPhone(person.phone) : null
      if (joinTo) {
        const id = this.ports.newId()
        this.sql.exec(
          `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES (?1, ?2, 'telegram', ?3, ?4)`,
          id,
          joinTo,
          person.id,
          this.now(),
        )
        this.audit(TELEGRAM_ACTOR, 'identity.join', `contact:${joinTo}`, null, {
          kind: 'telegram',
          address: person.id,
          via: 'phone number',
        })
        identity = { id, contactId: joinTo }
      } else {
        const made = this.identityFor(
          { kind: 'telegram', address: person.id },
          collapse(person.name) || person.username || person.id,
          TELEGRAM_ACTOR,
        )
        identity = { id: made.id, contactId: made.contactId }
      }
    }
    // A sender the bridge knows only by id (`bot` absent) never overwrites what is held of a person: a message with no description cannot turn a bot into a person, or back.
    this.sql.exec(
      person.bot === undefined
        ? `INSERT INTO telegram_person (identity_id, bot, username) VALUES (?1, ?2, ?3) ON CONFLICT(identity_id) DO NOTHING`
        : `INSERT INTO telegram_person (identity_id, bot, username) VALUES (?1, ?2, ?3)
           ON CONFLICT(identity_id) DO UPDATE SET bot = excluded.bot, username = excluded.username`,
      identity.id,
      person.bot ? 1 : 0,
      person.username ?? null,
    )
    return { ...identity, name: this.contactName(identity.contactId) }
  }

  private contactName(contactId: string): string {
    return text(this.sql.exec(`SELECT name FROM contact WHERE id = ?1`, contactId).one().name)
  }

  /**
   * A person first seen with no name (a short-form update names the user by id alone) is a contact named by the id. When a later push DESCRIBES them, the contact takes the name, and their
   * earlier messages that were headed by the id are headed by the name. Only a name that is still exactly the id is replaced: a name the owner set, or Telegram gave, stands.
   */
  private learnName(identity: { id: string; contactId: string }, current: string, person: TelegramSender): void {
    const learned = collapse(person.name) || person.username || ''
    if (learned === '' || current !== person.id) return
    this.sql.exec(
      `UPDATE contact SET name = ?2, profile_rev = profile_rev + 1 WHERE id = ?1`,
      identity.contactId,
      learned,
    )
    this.sql.exec(
      `UPDATE message SET from_header = ?2 WHERE identity_id = ?1 AND from_header = ?3`,
      identity.id,
      learned,
      person.id,
    )
    this.audit(
      TELEGRAM_ACTOR,
      'contact.name-learned',
      `contact:${identity.contactId}`,
      { name: current },
      { name: learned },
    )
  }

  // ─── filing ──────────────────────────────────────────────────────────

  /**
   * File what the bridge pushed, in ONE transaction: the people, the conversations, the messages, the mailbox's last push and Telegram's positions (the account's, and each supergroup's
   * and channel's). A message already held (the same chat and Telegram id) stores nothing. Telegram's service chat and Saved Messages are refused.
   */
  pushTelegram(push: TelegramPush): Result<PushResult> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(push.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      const refused = (chatId: string) => chatId === TELEGRAM_SERVICE_CHAT || chatId === push.account.id
      const chats = new Map(push.chats.filter((c) => !refused(c.id)).map((c) => [c.id, c]))
      const result: PushResult = { stored: 0, repeated: 0, skipped: push.chats.length - chats.size }
      const filing: Filing = {
        mailboxId,
        at,
        mirror: push.mirror === true,
        conversations: new Map(),
        senders: new Map(),
        openNow: new Map(),
        fresh: [],
      }
      // Oldest first, so the conversation's first message is its oldest and rowid order follows time.
      for (const m of [...push.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id)) {
        const chat = refused(m.chatId) ? undefined : chats.get(m.chatId)
        if (!chat) result.skipped += 1
        else if (this.fileTelegramMessage(filing, chat, m)) result.stored += 1
        else result.repeated += 1
      }
      for (const { conv } of filing.fresh) this.touchConversation(conv.conversationId)
      if (push.live === true && push.mirror !== true) this.markTelegramOwed(filing.fresh)

      this.keepPosition(mailboxId, push.position, this.storedPosition(mailbox.value))
      this.keepChatPositions(mailboxId, push.chatPositions)
      for (const id of push.backRead ?? []) {
        this.sql.exec(
          `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'done', ?2, ?3)
           ON CONFLICT(key) DO NOTHING`,
          `${BACK_READ_PREFIX}${id}`,
          at,
          TELEGRAM_ACTOR,
        )
      }
      for (const id of push.mediaRead ?? []) {
        this.sql.exec(
          `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'done', ?2, ?3)
           ON CONFLICT(key) DO NOTHING`,
          `${MEDIA_READ_PREFIX}${id}`,
          at,
          TELEGRAM_ACTOR,
        )
      }
      this.sql.exec(`UPDATE mailbox SET last_push_at = ?2, last_arrival_at = ?2 WHERE id = ?1`, mailboxId, at)
      return ok(result)
    })
  }

  /** File one message of a push: false when the inbox already holds it (a push repeated after a timeout). */
  private fileTelegramMessage(f: Filing, chat: TelegramChat, m: TelegramMessage): boolean {
    const key = `${m.chatId}:${m.id}`
    const held = this.sql
      .exec(
        `SELECT id, conversation_id, attachments, deleted_at FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`,
        f.mailboxId,
        key,
      )
      .toArray()[0]
    if (held) {
      // A message held with no file that is pushed again WITH one is given the file (the bridge's re-read, `TelegramPush.mediaRead`); nothing else of a held message changes.
      if (m.media) this.adoptTelegramFile(held, chat, m, f.at)
      return false
    }
    let conv = f.conversations.get(m.chatId)
    if (!conv) {
      conv = this.telegramConversation(f.mailboxId, chat, f.at)
      f.conversations.set(m.chatId, conv)
      if (chat.kind === 'group')
        f.openNow.set(m.chatId, conv.isNew ? true : this.conversationState(conv.conversationId).open)
    }
    // A message in a group is filed under whoever wrote it; every other message under the chat's one identity.
    const who =
      chat.kind === 'group' && !m.out
        ? this.groupMessageFacts(f, chat, m)
        : { identityId: conv.identityId, from: conv.name, toMe: null, closed: false }
    const id = this.insertTelegramMessage({
      mailboxId: f.mailboxId,
      conv,
      chat,
      m,
      key,
      at: f.at,
      mirror: f.mirror,
      identityId: who.identityId,
      from: who.from,
      toMe: who.toMe,
      closedOnArrival: who.closed,
    })
    if (chat.kind === 'group' && !m.out && !who.closed) f.openNow.set(m.chatId, true)
    // The owner's own message from the stream may be the send the space is waiting on.
    if (m.out) this.adoptStreamCopy(conv.conversationId, m)
    f.fresh.push({ id, conv, chat, m, toMe: who.toMe === true })
    return true
  }

  /**
   * A message the inbox already holds, pushed again with a file the inbox never recorded: it gets the file's entry and, when it is one to copy, the bytes are owed as for any message. A message that already
   * names a file, or was deleted for everyone, is left as it is.
   */
  private adoptTelegramFile(held: Record<string, unknown>, chat: TelegramChat, m: TelegramMessage, at: string): void {
    if (held.deleted_at !== null && held.deleted_at !== undefined) return
    if (jsonArray<AttachmentInfo>(held.attachments).length > 0) return
    const media = m.media as TelegramMedia
    const file = planTelegramFile(media, chat.kind)
    this.sql.exec(
      `UPDATE message SET attachments = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1`,
      text(held.id),
      JSON.stringify([attachmentOf(media, file)]),
      at,
      TELEGRAM_ACTOR,
    )
    if (file.copy === 'owed') this.oweTelegramMedia(text(held.id), m.chatId, m.id, file.kind, m.media?.size, at)
    this.touchConversation(text(held.conversation_id))
  }

  /**
   * What a message in a group needs beyond a one-to-one one: who it is filed under (its sender, made a person the first time they write), whether it is addressed to the owner (Telegram marks
   * it as a mention of them, or it replies to one of their own messages), and whether it is filed closed so that it does not reopen a group the owner closed.
   */
  private groupMessageFacts(
    f: Filing,
    chat: TelegramChat,
    m: TelegramMessage,
  ): { identityId: string; from: string; toMe: boolean; closed: boolean } {
    const conv = f.conversations.get(chat.id) as ConversationFound
    let identityId = conv.identityId
    let from = conv.name
    // Telegram's own service account is nobody who writes in a group: a message that says so is filed under the group, as one with no sender.
    if (m.sender && m.sender.id !== TELEGRAM_SERVICE_CHAT) {
      let sender = f.senders.get(m.sender.id)
      // Once per push, unless the held copy is a contact named only by the id and this message describes them (the name is learned).
      if (!sender || (sender.name === m.sender.id && (m.sender.name !== '' || m.sender.username !== undefined))) {
        sender = this.telegramIdentity(m.sender)
        f.senders.set(m.sender.id, sender)
      }
      identityId = sender.id
      // A sender the update named by id alone is headed by the name the inbox holds of them, never by the number.
      from = collapse(m.sender.name) || m.sender.username || sender.name
    }
    const toMe =
      m.mentionsMe === true || (m.replyTo !== undefined && this.isOwnMessage(f.mailboxId, m.chatId, m.replyTo))
    return { identityId, from, toMe, closed: !toMe && f.openNow.get(m.chatId) === false }
  }

  /** Whether the message `<chat>:<id>` is one of the owner's own: what a reply in a group names when it answers them. */
  private isOwnMessage(mailboxId: string, chatId: string, id: number): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2 AND direction = 'out'`,
          mailboxId,
          `${chatId}:${id}`,
        )
        .toArray()[0] !== undefined
    )
  }

  /** Each supergroup's and channel's own position, kept on its conversation and never moved back; a chat with no conversation yet keeps none (the bridge reads it again). */
  private keepChatPositions(mailboxId: string, positions: Record<string, number> | undefined): void {
    for (const [chatId, pts] of Object.entries(positions ?? {})) {
      if (!hasOwnPosition(chatId)) continue
      this.sql.exec(
        `UPDATE conversation SET telegram_pts = ?3 WHERE mailbox_id = ?1 AND telegram_chat_id = ?2 AND (telegram_pts IS NULL OR telegram_pts < ?3)`,
        mailboxId,
        chatId,
        pts,
      )
    }
  }

  /**
   * Put each message a LIVE push stored to the Telegram branch of the notification rule, and mark the ones it passes as owed. The conversation's state is read after its
   * messages were filed and it was touched, so a message that reopened a closed conversation finds it open. Marked once: a message already marked is left as it is.
   */
  private markTelegramOwed(fresh: FreshMessage[]): void {
    const now = this.ports.now()
    for (const { id, conv, chat, m, toMe } of fresh) {
      const state = this.conversationState(conv.conversationId)
      const decision = telegramNotifyDecision({
        live: true,
        out: m.out,
        muted: chat.muted,
        group: chat.kind === 'group',
        toMe,
        bulk: isBulk(this.bulkFacts(conv.conversationId)),
        open: state.open,
        unread: state.unread,
        receivedAt: m.at,
        now,
      })
      if (decision.notify) this.sql.exec(`UPDATE message SET notify = 'owed' WHERE id = ?1 AND notify IS NULL`, id)
    }
  }

  /**
   * The identity that stands for a group or a channel, made when it is new: a contact named by the chat's title, with a `telegram` identity whose address is the chat's marked id (a
   * `-` first, so it can never be a person's) and a `telegram_person` row that says which it is. A title Telegram changes later does not rename a contact the owner may have renamed.
   */
  private chatIdentity(chat: TelegramChat): { id: string; contactId: string } {
    const found = this.sql
      .exec(`SELECT id, contact_id FROM identity WHERE kind = 'telegram' AND address = ?1`, chat.id)
      .toArray()[0]
    const identity = found
      ? { id: text(found.id), contactId: text(found.contact_id) }
      : this.identityFor(
          { kind: 'telegram', address: chat.id },
          collapse(chat.title ?? '') || `Telegram ${chat.kind} ${chat.id}`,
          TELEGRAM_ACTOR,
        )
    this.sql.exec(
      `INSERT INTO telegram_person (identity_id, bot, username, chat) VALUES (?1, 0, NULL, ?2)
       ON CONFLICT(identity_id) DO UPDATE SET chat = excluded.chat`,
      identity.id,
      chat.kind,
    )
    return { id: identity.id, contactId: identity.contactId }
  }

  /** The conversation of a chat, made when it is new, with the chat's one identity (made when new) as its only participant. */
  private telegramConversation(mailboxId: string, chat: TelegramChat, at: string): ConversationFound {
    const person = chat.person
    const identity = person ? this.telegramIdentity(person) : this.chatIdentity(chat)
    const name = person ? personName(person) : collapse(chat.title ?? '') || chat.id
    const existing = this.sql
      .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND telegram_chat_id = ?2`, mailboxId, chat.id)
      .toArray()[0]
    const conversationId = existing ? text(existing.id) : this.ports.newId()
    if (!existing) {
      this.sql.exec(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, telegram_chat_id, telegram_kind) VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
        conversationId,
        at,
        mailboxId,
        chat.id,
        chat.kind,
      )
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'from')`,
      conversationId,
      identity.id,
    )
    return { conversationId, identityId: identity.id, name, isNew: !existing }
  }

  /**
   * One message row. Read: the owner's own message always; another's when this is a mirror and Telegram has it read. Closed: the owner's own, (in a mirror, on a conversation this push made) a
   * chat that is in Telegram's archive, and a group message not addressed to the owner in a group that is closed (`closedOnArrival`). It is filed under `identityId`: the chat's one identity, or,
   * in a group, the sender's.
   */
  private insertTelegramMessage(f: {
    mailboxId: string
    conv: ConversationFound
    chat: TelegramChat
    m: TelegramMessage
    key: string
    at: string
    mirror: boolean
    identityId: string
    from: string
    toMe: boolean | null
    closedOnArrival: boolean
  }): string {
    const { conv, chat, m, at } = f
    const id = this.ports.newId()
    const file = m.media ? planTelegramFile(m.media, chat.kind) : null
    const read = m.out || (f.mirror && chat.readInboxMaxId !== undefined && m.id <= chat.readInboxMaxId)
    const closed = m.out || f.closedOnArrival || (f.mirror && conv.isNew && chat.archived === true)
    const stampAt = m.out ? m.at : at
    this.sql.exec(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, subject, body, why,
                            created_at, created_by, updated_at, updated_by, sent_at, sent_by, source_ref,
                            mailbox_id, from_header, to_header, sender_date, snippet, read_at, read_by, closed_at, closed_by,
                            arrival_key, telegram_msg_id, edited_at, telegram_to_me, attachments)
       VALUES (?1, ?2, ?3, ?4, 'sent', '', ?5, '', ?6, ?7, ?6, ?7, ?8, ?9, NULL,
               ?10, ?11, '', ?8, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
      id,
      conv.conversationId,
      f.identityId,
      m.out ? 'out' : 'in',
      m.text,
      at,
      TELEGRAM_ACTOR,
      m.at,
      m.out ? TELEGRAM_ACTOR : null,
      f.mailboxId,
      m.out ? this.owner.mailName : f.from,
      collapse(m.text).slice(0, SNIPPET_CHARS),
      read ? stampAt : null,
      read ? TELEGRAM_ACTOR : null,
      closed ? stampAt : null,
      closed ? TELEGRAM_ACTOR : null,
      f.key,
      m.id,
      m.editedAt ?? null,
      f.toMe === null ? null : f.toMe ? 1 : 0,
      JSON.stringify(file ? [attachmentOf(m.media as TelegramMedia, file)] : []),
    )
    // The words are stored; the bytes of a photo or a voice note are owed to the bridge, and a failure to get them never touches the message.
    if (file?.copy === 'owed') this.oweTelegramMedia(id, m.chatId, m.id, file.kind, m.media?.size, at)
    return id
  }

  /**
   * Edits and deletions for everyone. An edit replaces the text and stamps when; a deletion removes the text and leaves the row as a deleted message, and a
   * message nobody had read yet is stamped read, so a deleted message never holds a conversation unread. A deletion in a chat with a person names ids and no chat (their ids are
   * one sequence for the account), so it is found by Telegram's id alone. Telegram's position is stored with them.
   */
  telegramEvents(events: TelegramEvents): Result<EventsResult> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(events.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      const out: EventsResult = { edited: 0, deleted: 0, read: 0, unknown: 0 }
      const touched = new Set<string>()
      const conversationOf = (messageKey: string, by: 'key' | 'id') =>
        this.sql
          .exec(
            by === 'key'
              ? `SELECT id, conversation_id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`
              : // Ids with no chat are the account's own sequence: a person's chat and a basic group's. A supergroup's and a channel's ids are their own, so they are never found this way.
                `SELECT m.id, m.conversation_id FROM message m JOIN conversation c ON c.id = m.conversation_id
                  WHERE m.mailbox_id = ?1 AND m.telegram_msg_id = ?2 AND c.telegram_chat_id NOT LIKE ?3`,
            mailboxId,
            by === 'key' ? messageKey : Number(messageKey),
            ...(by === 'key' ? [] : [`${CHANNEL_ID_PREFIX}%`]),
          )
          .toArray()
      for (const e of events.edits) {
        const rows = conversationOf(`${e.chatId}:${e.id}`, 'key')
        const row = rows[0]
        if (!row) {
          out.unknown += 1
          continue
        }
        const changed = this.sql.exec(
          `UPDATE message SET body = ?2, snippet = ?3, edited_at = ?4, updated_at = ?5, updated_by = ?6 WHERE id = ?1 AND deleted_at IS NULL`,
          text(row.id),
          e.text,
          collapse(e.text).slice(0, SNIPPET_CHARS),
          e.at,
          at,
          TELEGRAM_ACTOR,
        )
        if (changed.rowsWritten > 0) {
          out.edited += 1
          touched.add(text(row.conversation_id))
        } else out.unknown += 1
      }
      for (const d of events.deletions) {
        for (const id of d.ids) {
          const rows = d.chatId ? conversationOf(`${d.chatId}:${id}`, 'key') : conversationOf(String(id), 'id')
          // Without a chat, the id is the account's own sequence, so one row at most; more than one would be two chats claiming one id, and none is touched.
          const row = rows.length === 1 ? rows[0] : undefined
          if (!row) {
            out.unknown += 1
            continue
          }
          const changed = this.sql.exec(
            `UPDATE message SET body = '', snippet = '', deleted_at = ?2, updated_at = ?3, updated_by = ?4,
                                read_at = coalesce(read_at, ?3), read_by = CASE WHEN read_at IS NULL THEN ?4 ELSE read_by END
              WHERE id = ?1 AND deleted_at IS NULL`,
            text(row.id),
            d.at,
            at,
            TELEGRAM_ACTOR,
          )
          if (changed.rowsWritten > 0) {
            // A message deleted for everyone takes its file with it: the name goes now, the bytes at the sweep.
            this.dropTelegramMedia(text(row.id), at)
            out.deleted += 1
            touched.add(text(row.conversation_id))
          } else out.unknown += 1
        }
      }
      const marked = this.applyTelegramReads(mailboxId, events.reads ?? [], at, touched)
      out.read += marked.read
      out.unknown += marked.unknown
      for (const id of touched) this.touchConversation(id)
      this.keepPosition(mailboxId, events.position, this.storedPosition(mailbox.value))
      this.keepChatPositions(mailboxId, events.chatPositions)
      return ok(out)
    })
  }

  /**
   * The owner read a chat on another device. Every message of the other side in that chat at or below the mark is read, as Telegram. This is the reverse of opening a conversation in the
   * space, and never an echo of it: nothing here is owed back to Telegram. It only ever reads; a mark below what is already read changes nothing. A chat the space does not hold is counted.
   */
  private applyTelegramReads(
    mailboxId: string,
    reads: readonly TelegramRead[],
    at: string,
    touched: Set<string>,
  ): { read: number; unknown: number } {
    const out = { read: 0, unknown: 0 }
    for (const r of reads) {
      const conversation = this.sql
        .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND telegram_chat_id = ?2`, mailboxId, r.chatId)
        .toArray()[0]
      if (!conversation) {
        out.unknown += 1
        continue
      }
      const changed = this.sql.exec(
        `UPDATE message SET read_at = ?3, read_by = ?4, updated_at = ?3, updated_by = ?4
          WHERE conversation_id = ?1 AND direction = 'in' AND status NOT IN ${PENDING}
            AND telegram_msg_id IS NOT NULL AND telegram_msg_id <= ?2 AND read_at IS NULL`,
        text(conversation.id),
        r.upTo,
        at,
        TELEGRAM_ACTOR,
      )
      if (changed.rowsWritten > 0) {
        out.read += changed.rowsWritten
        touched.add(text(conversation.id))
      }
    }
    return out
  }

  // ─── what the bridge is owed, and how it is ──────────────────────────

  /**
   * The bridge's work request, and its heartbeat. It answers Telegram's stored position (null before the first fill is stored) and, when asked, the newest stored message id
   * of every chat (a read-through starts from there), and what the space owes Telegram: the read marks the owner's opening of a conversation left (`owed`, offered until an outcome settles
   * each) and the sends it owes. The "checked in" stamp is written at most once a minute: this is asked every few seconds.
   */
  telegramWork(request: TelegramWorkRequest): Result<TelegramWork> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(request.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const now = this.ports.now()
      this.sql.exec(
        `UPDATE mailbox SET checked_in_at = ?2 WHERE id = ?1 AND (checked_in_at IS NULL OR checked_in_at <= ?3)`,
        mailboxId,
        now.toISOString(),
        new Date(now.getTime() - CHECK_IN_EVERY_MS).toISOString(),
      )
      // A send the bridge was not asked for in its five minutes is not offered now, whenever it came back.
      this.expireUnofferedSends()
      this.expireOwedMedia(now)
      let newest: Record<string, number> | undefined
      if (request.newest) {
        newest = {}
        for (const r of this.sql
          .exec(
            `SELECT c.telegram_chat_id AS chat, max(m.telegram_msg_id) AS newest
               FROM message m JOIN conversation c ON c.id = m.conversation_id
              WHERE m.mailbox_id = ?1 AND m.telegram_msg_id IS NOT NULL AND c.telegram_chat_id IS NOT NULL
              GROUP BY c.telegram_chat_id`,
            mailboxId,
          )
          .toArray()) {
          newest[text(r.chat)] = Number(r.newest)
        }
      }
      const chatPositions: Record<string, number> = {}
      for (const r of this.sql
        .exec(
          `SELECT telegram_chat_id AS chat, telegram_pts AS pts FROM conversation
            WHERE mailbox_id = ?1 AND telegram_chat_id IS NOT NULL AND telegram_pts IS NOT NULL`,
          mailboxId,
        )
        .toArray()) {
        chatPositions[text(r.chat)] = Number(r.pts)
      }
      // Only a bridge that says it takes videos this large starts the pass (see `oweVideosWithinLimit`).
      const takesBigVideos = request.media === true && (request.videoMax ?? 0) >= TELEGRAM_VIDEO_MAX_BYTES
      if (takesBigVideos) this.oweVideosWithinLimit(now)
      const mediaRead = request.media === true ? this.chatsToReadForFiles(mailboxId, text(mailbox.value.address)) : []
      const backRead = request.newest
        ? this.sql
            .exec(`SELECT key FROM setting WHERE key LIKE ?1`, `${BACK_READ_PREFIX}%`)
            .toArray()
            .map((r) => text(r.key).slice(BACK_READ_PREFIX.length))
        : undefined
      return ok({
        position: this.storedPosition(mailbox.value),
        chatPositions,
        ...(newest && { newest }),
        ...(backRead && { backRead }),
        ...(mediaRead.length > 0 && { mediaRead }),
        owed: this.owedToTelegram(
          text(mailbox.value.address),
          request.media === true,
          takesBigVideos,
          request.pictures === true,
        ),
      })
    })
  }

  // ─── photos and voice notes the bridge is asked for ────────

  /**
   * Once per limit (`VIDEO_LIMIT_PASS_PREFIX`): every video held as left in Telegram for being too large whose length the space holds, and which is now within `TELEGRAM_VIDEO_MAX_BYTES`, becomes `owed` again, with
   * the row that owes the bytes (written as of now, so the week it is asked for starts now, not when the message came). Nothing is re-read from Telegram: the length is the one the message came with. A video
   * the pass does not touch: one with no stated length, one still over the limit, one in a channel or a bot's chat (left for another reason), one deleted for everyone. Inside the work request's transaction, so the
   * marker and the changes land together.
   */
  private oweVideosWithinLimit(now: Date): void {
    const marker = `${VIDEO_LIMIT_PASS_PREFIX}${TELEGRAM_VIDEO_MAX_BYTES}`
    if (this.sql.exec(`SELECT 1 FROM setting WHERE key = ?1`, marker).toArray()[0]) return
    const at = now.toISOString()
    let owed = 0
    for (const r of this.sql
      .exec(
        `SELECT m.id AS id, m.attachments AS attachments, m.telegram_msg_id AS tid, c.telegram_chat_id AS chat, c.id AS conversation
           FROM message m JOIN conversation c ON c.id = m.conversation_id
          WHERE m.telegram_msg_id IS NOT NULL AND c.telegram_chat_id IS NOT NULL AND m.deleted_at IS NULL AND m.raw_key IS NULL
            AND m.attachments LIKE '%"too-large"%'`,
      )
      .toArray()) {
      const files = jsonArray<AttachmentInfo>(r.attachments)
      const file = files[0]
      if (file?.tg?.kind !== 'video' || file.tg.copy !== 'left' || file.tg.why !== 'too-large') continue
      if (!(file.size > 0 && file.size <= TELEGRAM_VIDEO_MAX_BYTES)) continue
      const { why: _why, ...tg } = file.tg
      files[0] = { ...file, tg: { ...tg, copy: 'owed' } }
      this.sql.exec(
        `UPDATE message SET attachments = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1`,
        text(r.id),
        JSON.stringify(files),
        this.now(),
        TELEGRAM_ACTOR,
      )
      this.oweTelegramMedia(text(r.id), text(r.chat), Number(r.tid), 'video', file.size, at)
      this.touchConversation(text(r.conversation))
      owed += 1
    }
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO NOTHING`,
      marker,
      JSON.stringify({ owed }),
      at,
      TELEGRAM_ACTOR,
    )
  }

  /**
   * The chats the bridge is asked to read again for their files (`TelegramWork.mediaRead`): every chat that has a conversation and no marker yet, a few at a time, the most recently active first. Never Telegram's
   * service chat or the account's own chat (nothing of either is held). A chat with nothing to give still gets its marker from the bridge's push, so it is asked once.
   */
  private chatsToReadForFiles(mailboxId: string, account: string): string[] {
    return this.sql
      .exec(
        `SELECT c.telegram_chat_id AS chat FROM conversation c
          WHERE c.mailbox_id = ?1 AND c.telegram_chat_id IS NOT NULL AND c.telegram_chat_id NOT IN (?2, ?3)
            AND NOT EXISTS (SELECT 1 FROM setting s WHERE s.key = ?4 || c.telegram_chat_id)
          ORDER BY c.last_activity_at DESC LIMIT ?5`,
        mailboxId,
        TELEGRAM_SERVICE_CHAT,
        account,
        MEDIA_READ_PREFIX,
        LIMITS.mediaReadPerWork,
      )
      .toArray()
      .map((r) => text(r.chat))
  }

  /**
   * Write the row that says the bridge is owed the bytes of this message's file. One row per message, deleted when the file is kept, refused, or its message deleted. A video over the small files' limit is
   * marked `big`: only a bridge that says it takes videos that large (`TelegramWorkRequest.videoMax`) is offered it, so a bridge from before the 50 MB limit never answers "too large" for it for good.
   */
  private oweTelegramMedia(
    messageId: string,
    chatId: string,
    id: number,
    kind: TelegramFile['kind'],
    size: number | undefined,
    at: string,
  ): void {
    const big = kind === 'video' && size !== undefined && size > TELEGRAM_SMALL_FILE_MAX_BYTES
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO NOTHING`,
      `${MEDIA_OWED_PREFIX}${messageId}`,
      JSON.stringify({ chatId, id, kind, ...(big && { big: true }) }),
      at,
      TELEGRAM_ACTOR,
    )
  }

  /**
   * The files the bridge is asked for now: photos, voice notes, pictures and videos, newest first, a few at a time. Offered by every work request until the upload (or an outcome) settles each. A video marked
   * `big` is left out for a bridge that does not take them, in the query, so it cannot fill the few places a request has and starve the small files.
   */
  private owedMedia(takesBigVideos: boolean): TelegramOwed[] {
    return this.sql
      .exec(
        `SELECT value FROM setting WHERE key LIKE ?1 AND (?3 = 1 OR value NOT LIKE '%"big":true%') ORDER BY updated_at DESC, key LIMIT ?2`,
        `${MEDIA_OWED_PREFIX}%`,
        LIMITS.mediaPerWork,
        takesBigVideos ? 1 : 0,
      )
      .toArray()
      .flatMap((r) => {
        const v = parseOwedMedia(r.value)
        return v ? [{ kind: 'media' as const, chatId: v.chatId, id: v.id, mediaKind: v.kind }] : []
      })
  }

  /** A file asked for and not got in a week is given up on, so a bridge that is down for good does not leave "Copying from Telegram" on a message for ever. */
  private expireOwedMedia(now: Date): void {
    const before = new Date(now.getTime() - MEDIA_OWED_FOR_MS).toISOString()
    for (const r of this.sql
      .exec(`SELECT key FROM setting WHERE key LIKE ?1 AND updated_at < ?2 LIMIT 50`, `${MEDIA_OWED_PREFIX}%`, before)
      .toArray()) {
      this.settleMediaRow(text(r.key).slice(MEDIA_OWED_PREFIX.length), { copy: 'left', why: 'failed' })
    }
  }

  /** The message a bridge call names, when the space is still waiting on its file's bytes; null when it is not (never asked, or already settled). */
  telegramMediaOwedFor(
    account: string,
    chatId: string,
    id: number,
  ): Result<{ messageId: string; kind: TelegramCopiedKind } | null> {
    const mailbox = this.telegramRow(account)
    if (!mailbox.ok) return mailbox
    const row = this.sql
      .exec(
        `SELECT id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2 AND deleted_at IS NULL`,
        text(mailbox.value.id),
        `${chatId}:${id}`,
      )
      .toArray()[0]
    if (!row) return ok(null)
    const owed = this.sql
      .exec(`SELECT value FROM setting WHERE key = ?1`, `${MEDIA_OWED_PREFIX}${text(row.id)}`)
      .toArray()[0]
    const v = owed ? parseOwedMedia(owed.value) : null
    return ok(v ? { messageId: text(row.id), kind: v.kind } : null)
  }

  /**
   * The file is in the bucket under `key`: the message's `raw_key` names it, its entry says it is kept and how many bytes it is, and the row that owed it goes. False (and nothing changed) when the message is
   * gone or nothing was owed for it any more, so the caller deletes the object it just wrote.
   */
  finishTelegramMedia(account: string, chatId: string, id: number, key: string, size: number): Result<boolean> {
    return this.ports.transaction(() => {
      const owed = this.telegramMediaOwedFor(account, chatId, id)
      if (!owed.ok) return owed
      if (owed.value === null) return ok(false)
      const row = this.sql
        .exec(`SELECT attachments, conversation_id FROM message WHERE id = ?1`, owed.value.messageId)
        .toArray()[0]
      const files = jsonArray<AttachmentInfo>(row?.attachments)
      const file = files[0]
      if (!row || !file?.tg) return ok(false)
      const { why: _why, ...tg } = file.tg
      files[0] = { ...file, size, tg: { ...tg, copy: 'kept' } }
      this.sql.exec(
        `UPDATE message SET attachments = ?2, raw_key = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?1`,
        owed.value.messageId,
        JSON.stringify(files),
        key,
        this.now(),
        TELEGRAM_ACTOR,
      )
      this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${MEDIA_OWED_PREFIX}${owed.value.messageId}`)
      this.touchConversation(text(row.conversation_id))
      return ok(true)
    })
  }

  /** The bridge could not get this message's file for the reason given, or it was larger than the limit once downloaded: the space stops asking and the line says why. False when nothing was owed. */
  refuseTelegramMedia(account: string, chatId: string, id: number, why: TelegramMediaRefusal): Result<boolean> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(account)
      if (!mailbox.ok) return mailbox
      return ok(this.leaveTelegramMedia(text(mailbox.value.id), chatId, id, why))
    })
  }

  private leaveTelegramMedia(mailboxId: string, chatId: string, id: number, why: TelegramMediaRefusal): boolean {
    const row = this.sql
      .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`, mailboxId, `${chatId}:${id}`)
      .toArray()[0]
    if (!row) return false
    const settled = this.settleMediaRow(text(row.id), { copy: 'left', why })
    if (settled) this.audit(TELEGRAM_ACTOR, 'telegram.media-left', `message:${text(row.id)}`, null, { why })
    return settled
  }

  /** Mark a message's owed file as left in Telegram for a reason and delete the row that owed it. False when no row owed it. */
  private settleMediaRow(messageId: string, to: { copy: 'left'; why: NonNullable<TelegramFile['why']> }): boolean {
    const key = `${MEDIA_OWED_PREFIX}${messageId}`
    if (!this.sql.exec(`SELECT 1 FROM setting WHERE key = ?1`, key).toArray()[0]) return false
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, key)
    const row = this.sql.exec(`SELECT attachments, conversation_id FROM message WHERE id = ?1`, messageId).toArray()[0]
    const files = jsonArray<AttachmentInfo>(row?.attachments)
    const file = files[0]
    if (!row || !file?.tg) return true
    files[0] = { ...file, tg: { ...file.tg, ...to } }
    this.sql.exec(
      `UPDATE message SET attachments = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1`,
      messageId,
      JSON.stringify(files),
      this.now(),
      TELEGRAM_ACTOR,
    )
    this.touchConversation(text(row.conversation_id))
    return true
  }

  /** A message deleted for everyone: its file's name goes, any row still owing it goes, and the object (when it was kept) is left to the sweep. Runs inside the events transaction. */
  private dropTelegramMedia(messageId: string, at: string): void {
    const row = this.sql.exec(`SELECT raw_key FROM message WHERE id = ?1`, messageId).toArray()[0]
    const key = row ? textOrNull(row.raw_key) : null
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${MEDIA_OWED_PREFIX}${messageId}`)
    this.sql.exec(`UPDATE message SET attachments = '[]', raw_key = NULL WHERE id = ?1`, messageId)
    if (key?.startsWith('tg/')) {
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'drop', ?2, ?3) ON CONFLICT(key) DO NOTHING`,
        `${MEDIA_DROP_PREFIX}${key}`,
        at,
        TELEGRAM_ACTOR,
      )
    }
  }

  /** The objects to delete from the bucket (a few at a time): files of messages deleted for everyone. */
  telegramMediaToDrop(): string[] {
    const keys = this.sql
      .exec(`SELECT key FROM setting WHERE key LIKE ?1 ORDER BY updated_at, key LIMIT 50`, `${MEDIA_DROP_PREFIX}%`)
      .toArray()
      .map((r) => text(r.key).slice(MEDIA_DROP_PREFIX.length))
    // An object some message names again (a picture the copy in the stream took over from its draft) is not to be deleted: its row is forgotten and the object stays.
    return keys.filter((key) => {
      if (!this.sql.exec(`SELECT 1 FROM message WHERE raw_key = ?1 LIMIT 1`, key).toArray()[0]) return true
      this.telegramMediaDropped(key)
      return false
    })
  }

  /** The bucket key a message's kept file is under, or null: what the keeper checks before it deletes an object it just wrote. */
  telegramMediaKeyOf(messageId: string): string | null {
    const row = this.sql.exec(`SELECT raw_key FROM message WHERE id = ?1`, messageId).toArray()[0]
    return row ? textOrNull(row.raw_key) : null
  }

  /** The object is gone from the bucket: forget it. */
  telegramMediaDropped(key: string): void {
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${MEDIA_DROP_PREFIX}${key}`)
  }

  // ─── read marks the space owes Telegram ───────────────────

  /**
   * Opening a Telegram conversation in the space is the one thing that owes Telegram a read mark, and it is the owner's alone: this is called by `applyConversationChange` for a read made by the
   * owner (the space's own mark-read), never for Claude (whose script has no read, and whose actor is not the owner's), never for the bridge's own read marks (`telegramEvents` stamps without it).
   *
   * What is owed is exact. It is read BEFORE the stamps are written: the newest Telegram message among the messages this very read is about to stamp read, which are the unread ones, which the
   * caller has checked are no newer than what the page showed (`planStampChange`: an unread message stored beyond `through` refuses the read, so nothing unseen is ever among them). Never the
   * newest message the chat has. A conversation with nothing unread owes nothing, and neither does one whose unread messages carry no Telegram id.
   */
  protected telegramReadToOwe(conversationId: string): { chatId: string; upTo: number } | null {
    const r = this.sql
      .exec(
        `SELECT c.telegram_chat_id AS chat, max(m.telegram_msg_id) AS up_to
           FROM message m JOIN conversation c ON c.id = m.conversation_id
          WHERE m.conversation_id = ?1 AND m.direction = 'in' AND m.read_at IS NULL AND m.status NOT IN ${PENDING}
            AND m.telegram_msg_id IS NOT NULL AND c.telegram_chat_id IS NOT NULL`,
        conversationId,
      )
      .toArray()[0]
    if (!r || r.chat === null || r.up_to === null) return null
    return { chatId: text(r.chat), upTo: Number(r.up_to) }
  }

  /** Owe Telegram a read mark up to `upTo` in a chat: one row per chat, and a later mark only raises it. */
  protected oweTelegramRead(chatId: string, upTo: number, actor: string): void {
    const key = `${READ_OWED_PREFIX}${chatId}`
    const held = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, key).toArray()[0]
    const was = held ? Number(held.value) : 0
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      String(Math.max(was, upTo)),
      this.now(),
      actor,
    )
  }

  /** What the space owes Telegram now: sends first (the person is waiting on them), then read marks, each oldest first. A work request offers it until an outcome settles it. */
  private owedToTelegram(
    account: string,
    takesMedia: boolean,
    takesBigVideos: boolean,
    takesPictures: boolean,
  ): TelegramOwed[] {
    const sends = this.owedSends(account, takesPictures)
    const reads = this.sql
      .exec(
        `SELECT key, value FROM setting WHERE key LIKE ?1 ORDER BY updated_at, key LIMIT ?2`,
        `${READ_OWED_PREFIX}%`,
        LIMITS.owedPerWork - sends.length,
      )
      .toArray()
      .flatMap((r) => {
        const upTo = Number(r.value)
        return Number.isSafeInteger(upTo) && upTo > 0
          ? [{ kind: 'read' as const, chatId: text(r.key).slice(READ_OWED_PREFIX.length), upTo }]
          : []
      })
    // Files are offered only to a bridge that says it takes them: an older one treats any item that is not a send as a read mark.
    return [...sends, ...reads, ...(takesMedia ? this.owedMedia(takesBigVideos) : [])]
  }

  // ─── sends the space owes Telegram ────────────────────────

  /**
   * Whether a chat is one the bridge may be asked to write to: never Telegram's service chat (where login codes arrive) and never the owner's chat with themselves. They cannot be a conversation here at all
   * (a push refuses them), so this is the second lock, and the bridge makes a third.
   */
  protected telegramMaySendTo(chatId: string, account: string): boolean {
    return chatId !== TELEGRAM_SERVICE_CHAT && chatId !== account
  }

  /** The Telegram chat a conversation is, with the account's mailbox: null for a conversation that is not one. */
  protected telegramChatOf(conversationId: string): TelegramChatFacts | null {
    const r = this.sql
      .exec(
        `SELECT c.mailbox_id AS mailbox_id, mb.address AS account, c.telegram_chat_id AS chat_id, c.telegram_kind AS kind
           FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id AND mb.kind = 'telegram'
          WHERE c.id = ?1 AND c.telegram_chat_id IS NOT NULL`,
        conversationId,
      )
      .toArray()[0]
    return r
      ? { mailboxId: text(r.mailbox_id), account: text(r.account), chatId: text(r.chat_id), kind: textOrNull(r.kind) }
      : null
  }

  /** The picture a draft carries, as it stands: a kept photo under the draft's own key with its fingerprint. Null for a draft with none (or one whose entry is not that). */
  protected pictureOfDraft(msg: MessageRow): PictureFacts | null {
    const file = msg.attachments[0]
    const tg = file?.tg
    if (!file || !tg || tg.kind !== 'photo' || tg.copy !== 'kept' || typeof tg.sha256 !== 'string') return null
    if (msg.rawKey !== mediaKey(msg.id)) return null
    const type = TELEGRAM_PICTURE_TYPES.find((t) => t === file.mimeType)
    return type === undefined ? null : { type, size: file.size, sha256: tg.sha256 }
  }

  /** The file entry of a picture the inbox sends: a kept photo with its type, its true length and its fingerprint. Words, never a name from anywhere. */
  protected pictureEntry(picture: PictureFacts): AttachmentInfo {
    return {
      name: picture.type === 'image/png' ? 'Photo.png' : 'Photo.jpg',
      size: picture.size,
      mimeType: picture.type,
      tg: { kind: 'photo', copy: 'kept', sha256: picture.sha256 },
    }
  }

  /** Name a picture on a draft: its entry and its key, in the caller's transaction (the claim's, or a put of one on a draft). */
  protected namePicture(draftId: string, picture: PictureFacts): void {
    this.sql.exec(
      `UPDATE message SET attachments = ?2, raw_key = ?3 WHERE id = ?1`,
      draftId,
      JSON.stringify([this.pictureEntry(picture)]),
      mediaKey(draftId),
    )
  }

  /**
   * Whether a picture may be put on (or replaced on) this draft, by this person, at this revision: the owner, or Claude (whose put is an edit of the draft like any other and is audited so); a draft (not a message that
   * came in, is going out or went out), on a Telegram chat that takes a picture (a person or a group, never a channel, never the service chat or Saved Messages), at the revision the caller was shown. The draft as it stands.
   */
  planDraftPicture(id: string, rev: unknown, actor: string): Result<MessageRow> {
    if (actor !== this.owner.email && !isAgent(actor)) return fail(403, telegramPictureOnlyOwner(this.owner.name))
    const msg = this.message(id)
    if (!msg) return fail(404, 'No such message.')
    if (msg.direction !== 'out' || msg.status !== 'draft') return fail(409, 'Only a draft carries a picture.')
    const chat = msg.conversationId ? this.telegramChatOf(msg.conversationId) : null
    if (!chat) return fail(422, 'A picture goes on a draft in a Telegram chat only: this one is on none.')
    if (chat.kind === 'channel')
      return fail(422, 'A Telegram channel is one you follow: there is nothing to send a picture to.')
    if (!this.telegramMaySendTo(chat.chatId, chat.account)) {
      return fail(422, 'The inbox never writes to Telegram’s own service chat or to your Saved Messages.')
    }
    if (typeof rev !== 'number' || !Number.isInteger(rev)) {
      return fail(
        422,
        'Say which version of the draft you were shown: the rev `drafts` printed for it. Nothing was changed.',
      )
    }
    if (rev !== msg.rev) return fail(409, CHANGED_SINCE_SHOWN)
    return ok(msg)
  }

  /**
   * The picture is in the bucket under the draft's own key (`putPicture`): name it on the draft, at the revision shown, as an edit of the draft like an edit of its words (the revision rises, the audit says who, and
   * so a picture changed by anyone but Claude after the owner spoke stops Claude's send, as a changed word does; Claude's own change is not held against it, and its send names the fingerprint). A picture put over another replaces it under the same key. Checked again here, in the transaction.
   */
  commitDraftPicture(id: string, rev: unknown, picture: PictureFacts, actor: string): Result<MessageRow> {
    return this.ports.transaction(() => {
      const planned = this.planDraftPicture(id, rev, actor)
      if (!planned.ok) return planned
      this.namePicture(id, picture)
      this.sql.exec(
        `UPDATE message SET rev = rev + 1, updated_at = ?2, updated_by = ?3 WHERE id = ?1`,
        id,
        this.now(),
        actor,
      )
      const after = this.message(id) as MessageRow
      this.audit(actor, 'draft.update', `message:${id}`, planned.value, after)
      return ok(after)
    })
  }

  /** The send owed for a claimed draft, or null. */
  protected telegramSendOwed(messageId: string): OwedSend | null {
    const r = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, `${SEND_OWED_PREFIX}${messageId}`).toArray()[0]
    return r ? parseOwedSend(r.value) : null
  }

  /** Whether the bridge may still be offered this send: it was offered, and not more than `SEND_RETRY_FOR_MS` ago. */
  private telegramSendOffered(owed: OwedSend): boolean {
    return owed.offeredAt !== null && this.ports.now().getTime() - Date.parse(owed.offeredAt) <= SEND_RETRY_FOR_MS
  }

  /**
   * Whether the send may still land: the bridge was offered it and `SEND_IN_FLIGHT_MS` (the retry window, the send's own timeout, the bridge's restart and a margin) have not passed since. The owner may not
   * answer for it until they have: a "did not go out" before then could be followed by the send.
   */
  protected telegramSendInFlight(owed: OwedSend): boolean {
    return owed.offeredAt !== null && this.ports.now().getTime() - Date.parse(owed.offeredAt) <= SEND_IN_FLIGHT_MS
  }

  /**
   * Whether the person is shown "Sending on Telegram" and not "check Telegram": it may still land (`telegramSendInFlight`), or the bridge has not been offered it yet and it was claimed less than
   * five minutes ago (the bridge asks every few seconds; one that has not asked for longer is down, and the send may be taken back at once).
   */
  private telegramSendWaiting(owed: OwedSend): boolean {
    if (owed.offeredAt !== null) return this.telegramSendInFlight(owed)
    return this.ports.now().getTime() - Date.parse(owed.claimedAt) <= SEND_RETRY_FOR_MS
  }

  /** A draft as read, with `sendingOnTelegram` set on a Telegram send that is still going out. */
  private withSendState(m: MessageRow): MessageRow {
    if (m.status !== 'sending' || m.kind !== 'telegram') return m
    const owed = this.telegramSendOwed(m.id)
    return owed && this.telegramSendWaiting(owed) ? { ...m, sendingOnTelegram: true } : m
  }

  override listDrafts(scope: MailScope = ALL_MAIL): MessageRow[] {
    this.expireUnofferedSends()
    return super.listDrafts(scope).map((m) => this.withSendState(m))
  }

  override messageById(id: string): MessageRow | null {
    this.expireUnofferedSends()
    const m = super.messageById(id)
    return m ? this.withSendState(m) : m
  }

  /**
   * A draft has been claimed for sending (`MailStore.claimSend`, inside its transaction): owe the bridge the message, under a random id made now and kept with it. Telegram stores a message sent twice
   * with one random id once, which is the only reason the same offer may be made again. A fresh claim drops the note about an earlier refusal.
   */
  protected oweTelegramSend(messageId: string, chatId: string, by: string, picture: PictureFacts | null = null): void {
    const at = this.now()
    const owed: OwedSend = {
      randomId: newRandomId(),
      chatId,
      by,
      claimedAt: at,
      offeredAt: null,
      ...(picture && { picture: { type: picture.type, size: picture.size, sha256: picture.sha256 } }),
    }
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      `${SEND_OWED_PREFIX}${messageId}`,
      JSON.stringify(owed),
      at,
      by,
    )
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${SEND_FAILED_PREFIX}${messageId}`)
  }

  /** The sends to offer now. The first offer is stamped, which starts the time a repeat is safe for; one past that time is no longer offered (its outcome is unknown). */
  private owedSends(account: string, takesPictures: boolean): TelegramOwed[] {
    const out: TelegramOwed[] = []
    for (const r of this.sql
      .exec(`SELECT key, value FROM setting WHERE key LIKE ?1 ORDER BY updated_at, key`, `${SEND_OWED_PREFIX}%`)
      .toArray()) {
      if (out.length >= LIMITS.owedPerWork) break
      const messageId = text(r.key).slice(SEND_OWED_PREFIX.length)
      const owed = parseOwedSend(r.value)
      const msg = owed ? this.message(messageId) : null
      // A row whose draft is gone or no longer waiting is left for the outcome or the owner's answer to clear; it is never offered.
      if (!owed || !msg || msg.status !== 'sending') continue
      if (!this.telegramMaySendTo(owed.chatId, account)) continue
      // A send that carries a picture is offered only to a bridge that says it sends pictures: an older one would send the caption alone. It is not stamped as offered, so it waits its five minutes from its claim
      // and then goes back to being a draft with its picture (`expireUnofferedSends`).
      if (owed.picture !== undefined && !takesPictures) continue
      if (owed.offeredAt !== null && !this.telegramSendOffered(owed)) continue
      let offeredAt = owed.offeredAt
      if (offeredAt === null) {
        offeredAt = this.now()
        this.sql.exec(
          `UPDATE setting SET value = ?2 WHERE key = ?1`,
          r.key,
          JSON.stringify({ ...owed, offeredAt } satisfies OwedSend),
        )
      }
      out.push({
        kind: 'send',
        messageId,
        chatId: owed.chatId,
        // How long this offer still has; the bridge starts nothing after that, however long the sends ahead of it in its pass took.
        leftMs: Math.max(0, SEND_RETRY_FOR_MS - (this.ports.now().getTime() - Date.parse(offeredAt))),
        // Under a picture, words that are only space are no caption at all.
        text: owed.picture !== undefined && msg.body.trim() === '' ? '' : msg.body,
        randomId: owed.randomId,
        ...(owed.picture !== undefined && { picture: { type: owed.picture.type, size: owed.picture.size } }),
      })
    }
    return out
  }

  /**
   * The seventh call of the bridge's door: the picture of a send the bridge is being offered, and only that. Named by the send's id and the random id it was offered under (both of which only a bridge that was
   * offered the send knows), answered only while the send is still owed, carries a picture, was offered, and may still be offered (`SEND_RETRY_FOR_MS` from its first offer, plus the fetch's own limit); and
   * only for a draft whose chat the bridge may write to. Anything else is a refusal, and the bridge sends nothing. The bytes themselves are read by the keeper (the bucket is the Durable Object's), which
   * checks the object is the length and the fingerprint recorded here.
   */
  telegramPictureFor(query: TelegramPictureQuery): Result<{ key: string; facts: PictureFacts }> {
    const mailbox = this.telegramRow(query.account)
    if (!mailbox.ok) return mailbox
    const refused = fail(409, 'The space is not offering that picture.')
    const owed = this.telegramSendOwed(query.messageId)
    if (!owed || owed.randomId !== query.randomId || owed.picture === undefined || owed.offeredAt === null)
      return refused
    if (this.ports.now().getTime() - Date.parse(owed.offeredAt) > SEND_RETRY_FOR_MS + SEND_FETCH_TIMEOUT_MS)
      return refused
    if (!this.telegramMaySendTo(owed.chatId, text(mailbox.value.address))) return refused
    const draft = this.message(query.messageId)
    if (draft?.status !== 'sending') return refused
    const held = jsonArray<AttachmentInfo>(
      this.sql.exec(`SELECT attachments FROM message WHERE id = ?1`, query.messageId).toArray()[0]?.attachments,
    )[0]
    const key = mediaKey(query.messageId)
    // The row must still name the picture the claim recorded: the object, its fingerprint and its key.
    if (draft.rawKey !== key || held?.tg?.copy !== 'kept' || held.tg.sha256 !== owed.picture.sha256) return refused
    return ok({ key, facts: owed.picture })
  }

  /**
   * Telegram took a send: the claimed draft becomes the sent message, the one whose arrival key the bridge's own stream would give it (`<chat>:<Telegram's id>`), filed as the owner's (or Claude's, on the owner's
   * instruction) and read and closed as every message the owner sends from anywhere. If the copy in the stream got here first (the bridge hears its own message as an update), that message IS the sent one: it
   * takes the draft's sender and instruction and the draft is removed, so the conversation never shows it twice. False when nothing was waiting on it.
   */
  private settleTelegramSend(report: { messageId: string; randomId: string; telegramId: number; at: string }): boolean {
    const owed = this.telegramSendOwed(report.messageId)
    // The claim that holds THIS random id: a late answer for a send the owner took back and sent again names the old key and settles nothing.
    if (!owed || owed.randomId !== report.randomId) return false
    const draft = this.message(report.messageId)
    if (draft?.status !== 'sending' || draft.conversationId === null) return false
    return this.completeTelegramSend(draft, owed, report.telegramId, report.at)
  }

  /**
   * The send is Telegram's message `telegramId`: file it. Reached by Telegram's own outcome (`settleTelegramSend`) and by the copy of it arriving in the bridge's stream (`adoptStreamCopy`), whichever
   * comes first, and the same either way.
   */
  private completeTelegramSend(draft: MessageRow, owed: OwedSend, telegramId: number, at: string): boolean {
    const conversationId = draft.conversationId as string
    const mailboxId = text(
      this.sql.exec(`SELECT mailbox_id FROM conversation WHERE id = ?1`, conversationId).one().mailbox_id,
    )
    const key = `${owed.chatId}:${telegramId}`
    const held = this.sql
      .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`, mailboxId, key)
      .toArray()[0]
    if (held) {
      this.sql.exec(
        `UPDATE message SET sent_by = ?2, instruction_text = ?3, instruction_where = ?4, instruction_at = ?5
          WHERE id = ?1 AND direction = 'out'`,
        held.id,
        owed.by,
        draft.instruction?.text ?? null,
        draft.instruction?.where ?? null,
        draft.instruction?.at ?? null,
      )
      // A picture the draft carried goes to the copy in the stream, which has not kept a file of its own (its download is dropped, and there is one object, not two); a copy that already kept its own object
      // keeps it, and the draft's is deleted with the draft.
      if (owed.picture !== undefined) this.givePictureToCopy(draft, text(held.id))
      this.sql.exec(`DELETE FROM message WHERE id = ?1 AND status = 'sending'`, draft.id)
      this.releasePicture(draft.rawKey)
    } else {
      this.sql.exec(
        `UPDATE message SET status = 'sent', mailbox_id = ?2, arrival_key = ?3, telegram_msg_id = ?4, from_header = ?5, to_header = '', sender_date = ?6,
                snippet = ?7, sent_at = ?6, sent_by = ?8, read_at = ?6, read_by = ?8, closed_at = ?6, closed_by = ?8
          WHERE id = ?1 AND status = 'sending'`,
        draft.id,
        mailboxId,
        key,
        telegramId,
        this.owner.mailName,
        at,
        collapse(draft.body).slice(0, SNIPPET_CHARS),
        owed.by,
      )
      // A picture with no words under it reads as Telegram's own copy of one does.
      if (owed.picture !== undefined && draft.body.trim() === '') {
        this.sql.exec(
          `UPDATE message SET body = ?2, snippet = ?2 WHERE id = ?1 AND status = 'sent'`,
          draft.id,
          PICTURE_ALONE,
        )
      }
    }
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${SEND_OWED_PREFIX}${draft.id}`)
    this.touchConversation(conversationId)
    this.audit(owed.by, 'message.send', `message:${draft.id}`, null, {
      telegramId,
      chat: owed.chatId,
      // Which picture went out on the owner's word, kept with the send (its fingerprint; the sent message's own file entry holds it too).
      ...(owed.picture !== undefined && { picture: owed.picture.sha256 }),
    })
    return true
  }

  /**
   * The copy of a sent picture that came through Telegram's stream first takes the draft's picture (its key and its kept entry, with the true length and the fingerprint), unless it has already kept an object of its
   * own. Either way its own owed download is dropped: there is one object, and no second download.
   */
  private givePictureToCopy(draft: MessageRow, heldId: string): void {
    const copy = this.sql.exec(`SELECT raw_key FROM message WHERE id = ?1`, heldId).toArray()[0]
    if (!copy || draft.rawKey === undefined) return
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${MEDIA_OWED_PREFIX}${heldId}`)
    if (textOrNull(copy.raw_key) !== null) return
    this.sql.exec(
      `UPDATE message SET attachments = ?2, raw_key = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?1`,
      heldId,
      JSON.stringify(draft.attachments),
      draft.rawKey,
      this.now(),
      TELEGRAM_ACTOR,
    )
  }

  /**
   * An object under a `tg/` key that no message names any more is to be deleted from the bucket: its drop row is written, in the same transaction as the removal of the message that named it, and the Durable Object
   * sweeps it after the call. Put in the one place a row that names a picture goes away, not at each caller. A key some other message still names (a copy that took it) is left.
   */
  protected override releasePicture(rawKey: string | undefined | null): void {
    if (typeof rawKey !== 'string' || !rawKey.startsWith('tg/')) return
    if (this.sql.exec(`SELECT 1 FROM message WHERE raw_key = ?1 LIMIT 1`, rawKey).toArray()[0]) return
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'drop', ?2, ?3) ON CONFLICT(key) DO NOTHING`,
      `${MEDIA_DROP_PREFIX}${rawKey}`,
      this.now(),
      TELEGRAM_ACTOR,
    )
  }

  /**
   * A message the owner sent (from anywhere) has just been filed from the bridge's stream. If a send of exactly these words is waiting in the same chat, was offered to the bridge, may still land (`telegramSendInFlight`:
   * `SEND_IN_FLIGHT_MS` from its first offer) and was claimed no more than a clock's skew after the message is stamped, that message IS the send: it is settled as sent now, whether the bridge's outcome comes
   * next or never comes. A send never offered is NOT settled by a phone message (nothing has tried to send it), and neither is one past the bound (the owner settles that one, and "it did not go out" is refused
   * while the copy is held).
   */
  private adoptStreamCopy(
    conversationId: string,
    m: { chatId: string; id: number; at: string; text: string; media?: TelegramMedia | undefined },
  ): void {
    for (const r of this.sql
      .exec(
        `SELECT id, body FROM message WHERE conversation_id = ?1 AND direction = 'out' AND status = 'sending' ORDER BY rowid`,
        conversationId,
      )
      .toArray()) {
      const owed = this.telegramSendOwed(text(r.id))
      const draft = owed ? this.message(text(r.id)) : null
      if (!owed || !draft || owed.chatId !== m.chatId) continue
      // The same words, exactly, and the same kind of message: a send that carries a picture is settled by a photo with its caption, a send of words by a message with no file. A picture with NO caption is never settled
      // from the stream: the only words its copy has are Telegram's own label, which any captionless photo the owner sent from their phone in that chat meanwhile also has, so it waits for the bridge's outcome (which names
      // the message), or for the owner.
      if (owed.picture !== undefined) {
        const caption = text(r.body).trim()
        if (caption === '' || m.media?.kind !== 'photo' || m.text.trim() !== caption) continue
      } else if (m.media !== undefined || text(r.body) !== m.text) continue
      // Only a send the bridge was actually offered, and only while it may still be the one that landed: a phone message with the same words must not settle a send nothing has tried to send, and past the
      // bound the copy is for the owner to see (it makes "it did not go out" impossible to give: `telegramHoldsCopyOf`).
      if (!this.telegramSendInFlight(owed)) continue
      if (Date.parse(m.at) < Date.parse(owed.claimedAt) - SEND_CLOCK_SKEW_MS) continue
      this.completeTelegramSend(draft, owed, m.id, m.at)
      return
    }
  }

  /**
   * Telegram refused a send for good: the claim is undone (the draft is a draft again, with no instruction on it, as when Gmail refuses), the owed row is deleted, and the reason is kept in words on the
   * draft so the person sees why. Nothing went out. False when nothing was waiting on it.
   */
  private refuseTelegramSend(report: { messageId: string; randomId: string; reason: string }): boolean {
    const owed = this.telegramSendOwed(report.messageId)
    if (!owed || owed.randomId !== report.randomId) return false
    const draft = this.message(report.messageId)
    if (draft?.status !== 'sending') return false
    this.returnSendToDraft(
      draft,
      owed,
      `Telegram would not take this, so nothing was sent. ${refusalWords(report.reason)}`,
      `Telegram: ${report.reason}`,
    )
    return true
  }

  /**
   * A send the bridge was never offered within five minutes of its claim must not go out whenever the bridge comes back, possibly an hour later: it is returned to a draft with a plain note, and its owed row
   * goes. Nothing can have gone out (only the bridge sends, and it was never offered this), so no question is asked of the owner. Run before every read of drafts and every work request, so the bridge is never
   * offered one past its window.
   */
  protected expireUnofferedSends(): void {
    const now = this.ports.now().getTime()
    for (const r of this.sql
      .exec(`SELECT key, value FROM setting WHERE key LIKE ?1`, `${SEND_OWED_PREFIX}%`)
      .toArray()) {
      const owed = parseOwedSend(r.value)
      if (!owed || owed.offeredAt !== null || now - Date.parse(owed.claimedAt) <= SEND_RETRY_FOR_MS) continue
      const draft = this.message(text(r.key).slice(SEND_OWED_PREFIX.length))
      if (draft?.status !== 'sending') continue
      this.returnSendToDraft(draft, owed, SEND_NOT_OFFERED_NOTE, 'the bridge was not running')
    }
  }

  /** The claim undone: a draft again with no instruction on it, the owed row gone, `note` kept on the draft for the person to read, and the audit saying why. */
  private returnSendToDraft(draft: MessageRow, owed: OwedSend, note: string, auditReason: string): void {
    this.sql.exec(
      `UPDATE message SET status = 'draft', instruction_text = NULL, instruction_where = NULL, instruction_at = NULL WHERE id = ?1 AND status = 'sending'`,
      draft.id,
    )
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${SEND_OWED_PREFIX}${draft.id}`)
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      `${SEND_FAILED_PREFIX}${draft.id}`,
      note,
      this.now(),
      TELEGRAM_ACTOR,
    )
    if (draft.conversationId) this.touchConversation(draft.conversationId)
    this.audit(owed.by, 'message.send-refused', `message:${draft.id}`, null, { reason: auditReason })
  }

  /**
   * Whether a message the owner sent from anywhere (the bridge's stream) in the same chat, with exactly the words of this claimed draft and after it was claimed, is held: that says it went out. Used only
   * to refuse "it did not go out" when the copy is already here, as Gmail's copy refuses it.
   */
  protected telegramHoldsCopyOf(draft: { id: string; conversationId: string | null; body: string }): boolean {
    const owed = this.telegramSendOwed(draft.id)
    if (!owed || draft.conversationId === null) return false
    // A picture's copy in the stream is a photo: its words are the caption, or Telegram's own label when there is none.
    const words = owed.picture === undefined ? draft.body : draft.body.trim() === '' ? PICTURE_ALONE : draft.body.trim()
    return (
      this.sql
        .exec(
          `SELECT 1 FROM message WHERE conversation_id = ?1 AND direction = 'out' AND status = 'sent' AND telegram_msg_id IS NOT NULL
              AND body = ?2 AND coalesce(sent_at, created_at) >= ?3 AND id != ?4`,
          draft.conversationId,
          words,
          new Date(Date.parse(owed.claimedAt) - SEND_CLOCK_SKEW_MS).toISOString(),
          draft.id,
        )
        .toArray()[0] !== undefined
    )
  }

  /** The owner has said how a send that stayed unknown went (or it was never offered): the owed row goes, so nothing is offered again. */
  protected clearTelegramSend(messageId: string): void {
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${SEND_OWED_PREFIX}${messageId}`)
  }

  /**
   * What became of what the bridge was owed. A mark done settles the row, unless a later mark raised it meanwhile (then the row stays, for the newer one); a mark Telegram refused for good
   * settles it too and is audited, so the failure is on record (the other side keeps showing the chat unread, which is all it costs). An outcome that names no row (already settled) is counted.
   */
  telegramOutcomes(report: TelegramOutcomes): Result<OutcomesResult> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(report.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const out: OutcomesResult = { settled: 0, unknown: 0 }
      for (const o of report.outcomes) {
        if (o.kind === 'send') {
          // Both answers settle a send; one that names nothing waiting (the owner already answered for it, or it was settled) is counted and changes nothing.
          const settled = o.ok
            ? this.settleTelegramSend({
                messageId: o.messageId,
                randomId: o.randomId,
                telegramId: o.telegramId,
                at: o.at,
              })
            : this.refuseTelegramSend({ messageId: o.messageId, randomId: o.randomId, reason: o.reason })
          if (settled) out.settled += 1
          else out.unknown += 1
          continue
        }
        if (o.kind === 'media') {
          // A file the bridge could not get: the space stops asking, and the line under the message says why.
          if (this.leaveTelegramMedia(mailboxId, o.chatId, o.id, o.reason)) out.settled += 1
          else out.unknown += 1
          continue
        }
        const key = `${READ_OWED_PREFIX}${o.chatId}`
        const held = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, key).toArray()[0]
        if (!held || Number(held.value) !== o.upTo) {
          // Nothing owed, or a newer mark replaced it: the newer one is still offered.
          out.unknown += 1
          continue
        }
        this.sql.exec(`DELETE FROM setting WHERE key = ?1`, key)
        out.settled += 1
        if (!o.ok) {
          this.audit(
            TELEGRAM_ACTOR,
            'telegram.read-mark-failed',
            `mailbox:${mailboxId}`,
            { chatId: o.chatId, upTo: o.upTo },
            { reason: o.reason },
          )
        }
      }
      return ok(out)
    })
  }

  /**
   * What the bridge says of itself. `signed-out` records Telegram's answer as the mailbox's last error (the login was ended; only the owner can sign in again); any other state
   * clears an error that was only that.
   */
  telegramStatus(report: TelegramStatusReport): Result<{ state: TelegramState }> {
    return this.ports.transaction(() => {
      const mailbox = this.telegramRow(report.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      this.sql.exec(
        `UPDATE mailbox SET bridge_state = ?2, bridge_state_at = ?3, checked_in_at = ?3 WHERE id = ?1`,
        mailboxId,
        report.state,
        at,
      )
      if (report.state === 'signed-out') {
        this.sql.exec(
          `UPDATE mailbox SET last_error = ?2, last_error_at = ?3 WHERE id = ?1`,
          mailboxId,
          `Telegram ended the saved login${report.reason ? ` (${report.reason})` : ''}`,
          at,
        )
        if (text(mailbox.value.bridge_state) !== 'signed-out')
          this.audit(TELEGRAM_ACTOR, 'mailbox.signed-out', `mailbox:${mailboxId}`, null, {
            reason: report.reason ?? null,
          })
      } else {
        this.sql.exec(`UPDATE mailbox SET last_error = NULL, last_error_at = NULL WHERE id = ?1`, mailboxId)
      }
      return ok({ state: report.state })
    })
  }

  /** The Telegram mailbox, as the script shows it: at most one. Counts come from the same facts as the queue's. */
  telegramMailboxes(): TelegramMailboxStatus[] {
    this.expireUnofferedSends()
    return this.sql
      .exec(`SELECT * FROM mailbox WHERE kind = 'telegram' ORDER BY rowid`)
      .toArray()
      .map((r) => this.telegramStatusOf(r))
  }

  private telegramStatusOf(r: Record<string, unknown>): TelegramMailboxStatus {
    const id = text(r.id)
    const count = (table: string) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE mailbox_id = ?1`, id).one().n)
    const open = this.queueFacts(id).filter((f) => f.open && !isBulk(f))
    const owedRow = this.sql
      .exec(`SELECT count(*) AS n, min(updated_at) AS oldest FROM setting WHERE key LIKE ?1`, `${READ_OWED_PREFIX}%`)
      .one()
    const owedMarks = { n: Number(owedRow.n), oldest: textOrNull(owedRow.oldest) }
    const sendRows = this.sql
      .exec(`SELECT key, value FROM setting WHERE key LIKE ?1`, `${SEND_OWED_PREFIX}%`)
      .toArray()
      .flatMap((row) => {
        const owed = parseOwedSend(row.value)
        return owed ? [owed] : []
      })
    const unknownSends = sendRows.filter((o) => o.offeredAt !== null && !this.telegramSendInFlight(o)).length
    const checkedInAt = textOrNull(r.checked_in_at)
    const reportedState = textOrNull(r.bridge_state) as TelegramState | null
    const stale = checkedInAt === null || this.ports.now().getTime() - Date.parse(checkedInAt) > NOT_CHECKED_IN_AFTER_MS
    // A signed-out bridge has stopped asking by design, so it is told as signed out and not as silent.
    const state: TelegramMailboxStatus['state'] =
      reportedState === 'signed-out' ? 'signed-out' : stale ? 'not-checked-in' : (reportedState ?? 'live')
    const reasons: string[] = []
    if (state === 'signed-out') {
      reasons.push(telegramLoginEnded(this.owner.name))
    } else if (state === 'not-checked-in') {
      reasons.push(
        checkedInAt === null
          ? 'The Telegram bridge has not checked in yet.'
          : `The Telegram bridge has not checked in since ${checkedInAt}.`,
      )
    }
    return {
      id,
      kind: 'telegram',
      address: text(r.address),
      name: text(r.display_name),
      createdAt: text(r.connected_at),
      state,
      reported: reportedState === null ? null : { state: reportedState, at: text(r.bridge_state_at) },
      checkedInAt,
      lastPushAt: textOrNull(r.last_push_at),
      lastError: textOrNull(r.last_error),
      lastErrorAt: textOrNull(r.last_error_at),
      hasPosition: positionOf(r.history_id) !== null,
      readMarksOwed: owedMarks.n,
      oldestReadMarkOwed: owedMarks.oldest,
      sendsOwed: sendRows.length - unknownSends,
      unknownSends,
      messages: count('message'),
      conversations: count('conversation'),
      open: open.length,
      unreadOpen: open.filter((f) => f.unread).length,
      health: { amber: reasons.length > 0, reasons },
    }
  }
}
