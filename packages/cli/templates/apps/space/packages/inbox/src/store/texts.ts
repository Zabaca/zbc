/**
 * The store's texts half: a mailbox fed by the texts bridge (a separate process paired with the owner's phone, as Messages for web is), and turning what it pushes into rows. Synchronous SQL over the same ports as the rest
 * of the store, so every rule here runs under plain `bun` against a real SQLite; the bridge's door (src/texts/app.ts) calls these in short transactions.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `Inbox` → `ArrivalStore` → `TelegramStore` → `TextsStore` → `MailStore`: like telegram.ts, this class sits between so it can use the base's `audit`, `identityFor` and `touchConversation` without making them
 * public, and so mail.ts is not made longer by a fifth kind of mailbox. It is shaped like Telegram's half and shares nothing with it but those helpers: each kind's columns, keys and words are its own.
 *
 * ── THERE IS NO POSITION; THE NEWEST HELD PER CHAT IS THE CATCH-UP'S START ─────────────────────
 * A phone has no account-wide cursor as Telegram has. On every reconnect the bridge asks `work` for `newest` (the newest message held, by time, for every chat), lists the phone's conversations by last activity, and reads each one
 * that is newer back to it. A message is found by (mailbox, arrival key), which is `<chat id>:<the phone's message id>`: a push repeated after a timeout, or a read-back that overlaps what is held, stores one message.
 *
 * ── THE PERSON IS THE TEXT IDENTITY; A BUSINESS SENDER IS NOBODY'S ─────────────────────────────
 * A one-to-one chat's other side is the existing `sms` identity of its number (E.164): the contact that holds the number is that person, else a contact is made, named as the phone names them. Never a join by name. A business
 * sender (a short code, a sender with a name instead of a number, a business chat) is an AUTOMATED sender with an identity of its own (`src/texts/sender.ts`), never joined to a number, and its chat is Bulk by the one rule for
 * automated senders (src/automated.ts), so it is never in the Inbox, Unread or Today's Needs reply and is read in Bulk. Nothing is kept out for being a business sender or looking like a sign-in code (the owner's choice).
 *
 * ── THE LEFT-OUT LIST ──────────────────────────────────────────────
 * The chats the owner left out are one `setting` row each (`texts-left-out:<chat id>`, no table). Leaving a chat out deletes its conversation and its messages from the store (audited); a push of a left-out chat stores nothing
 * and says so; Bring back removes the row and owes the bridge a read of the chat's last 30 days (`texts-fill:<chat id>`), settled by the bridge's outcome. The owner may do both; Claude's script may leave a chat out and never bring one back.
 *
 * ── READ AND CLOSED ARE THE INBOX'S OWN STAMPS, AND NOTHING RINGS ─────────────────────────────────
 * As for Telegram: a message from the other side arrives with neither stamp (unread, open), so a new text reopens a closed conversation; the owner's own is filed read and closed. In a `mirror` (history only: the first fill and a Bring back; a catch-up of a gap is pushed as live) a message is filed with the phone's read state and does not reopen a conversation the owner closed. The phone's own read marks come as events and stamp the messages read; nothing is ever written
 * back to the phone yet. No text owes a notification: the owner's phone already rings for it, and it is the same phone.
 */

import { SNIPPET_CHARS } from '../cloudflare/parse'
import { textsLoginEnded } from '../owner-words'
import { isBulk } from '../queue'
import { textSenderAddress } from '../texts/sender'
import type {
  EventsResult,
  OutcomesResult,
  PushResult,
  TextsChat,
  TextsEvents,
  TextsMessage,
  TextsOutcomes,
  TextsPush,
  TextsRead,
  TextsState,
  TextsStatusReport,
  TextsWork,
  TextsWorkRequest,
} from '../texts/wire'
import { LIMITS, TEXTS_FILL_DAYS } from '../texts/wire'
import { TEXTS_ACTOR, type TextsLeftOut, type TextsMailboxStatus } from '../types'
import { fail, ok, PENDING, type Result, text, textOrNull } from './store'
import { CHECK_IN_EVERY_MS, NOT_CHECKED_IN_AFTER_MS, TelegramStore } from './telegram'

/** The texts mailbox's pill. */
export const TEXTS_MAILBOX_NAME = 'Texts'

/** `texts-left-out:<chat id>`: a chat the owner left out; the value is a `LeftOutRow`. No table and no column. */
export const LEFT_OUT_PREFIX = 'texts-left-out:'
/** `texts-fill:<chat id>`: the owner brought a chat back and the bridge is owed a read of its last 30 days; the value is the time it was asked. Deleted by the bridge's outcome. */
export const FILL_PREFIX = 'texts-fill:'
/** The `setting` row that says since when the phone has not been answering, while it is the bridge's reported state. */
export const PHONE_SINCE_KEY = 'texts-phone-since'

/** What a left-out row holds: the name the chat had when it was left out, when, and by whom. */
interface LeftOutRow {
  name: string
  at: string
  by: string
  /** Only on a `texts-fill:` row whose read the phone refused: when, the short answer, and how many times it has been tried. */
  failed?: { at: string; reason: string; tries: number }
}

/** A refused read of a chat brought back is offered again after this long, and given up after this many tries (the card then says so, and Bring back tries again from the start). */
export const FILL_RETRY_AFTER_MS = 10 * 60_000
export const FILL_TRIES_MAX = 5

/** What the Texts card says of a refused read: plain words, with the phone's short answer, and whether it will try again. */
const fillFailureWords = (f: { reason: string; tries: number }): string =>
  `The phone would not give this chat's last ${TEXTS_FILL_DAYS} days (${f.reason}).${f.tries < FILL_TRIES_MAX ? ' It will try again.' : ' It gave up; press Bring back to try again.'}`

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** A phone gives a chat with no contact its number as its name; that is no name to learn. */
const NUMBER_SHAPED = /^[+\d\s().-]*$/

/** What one push has settled so far, shared by its messages. */
interface Filing {
  mailboxId: string
  at: string
  mirror: boolean
  /** One identity and one conversation per chat in the push, found or made the first time a message needs it. */
  conversations: Map<string, ConversationFound>
  /** Whether a conversation is open as the messages filed so far leave it: a mirror's message must not reopen one the owner closed. */
  openNow: Map<string, boolean>
  touched: Set<string>
}

/** A conversation a push is filing into: found or made, with its one other side. */
interface ConversationFound {
  conversationId: string
  identityId: string
  name: string
  isNew: boolean
}

const leftOutOf = (value: unknown): LeftOutRow | null => {
  try {
    const v = JSON.parse(text(value)) as Partial<LeftOutRow>
    if (!(typeof v.name === 'string' && typeof v.at === 'string' && typeof v.by === 'string')) return null
    const f = v.failed
    const failed =
      f && typeof f.at === 'string' && typeof f.reason === 'string' && typeof f.tries === 'number' ? { failed: f } : {}
    return { name: v.name, at: v.at, by: v.by, ...failed }
  } catch {
    return null
  }
}

export class TextsStore extends TelegramStore {
  // ─── the mailbox ─────────────────────────────────────────────────────

  /**
   * The row of the owner's phone, made by the first thing the bridge says (a push, a work request or a status), and kept after. One row for one phone: the bridge paired with another phone is refused (a 409), because its chats
   * would be filed in a mailbox that is not theirs.
   */
  private textsRow(accountId: string): Result<Record<string, unknown>> {
    const rows = this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'texts' ORDER BY rowid`).toArray()
    const found = rows[0]
    if (found) {
      if (text(found.address) !== accountId) {
        return fail(
          409,
          `This inbox holds the texts of the phone ${text(found.address)}; the bridge is paired with ${accountId}. Nothing was stored.`,
        )
      }
      return ok(found)
    }
    const id = this.ports.newId()
    this.sql.exec(
      `INSERT INTO mailbox (id, kind, address, display_name, connected_at, connected_by) VALUES (?1, 'texts', ?2, ?3, ?4, ?5)`,
      id,
      accountId,
      TEXTS_MAILBOX_NAME,
      this.now(),
      TEXTS_ACTOR,
    )
    this.seatMailbox(id, 'texts', accountId, null)
    this.audit(TEXTS_ACTOR, 'mailbox.create', `mailbox:${id}`, null, {
      kind: 'texts',
      address: accountId,
      name: TEXTS_MAILBOX_NAME,
    })
    return ok(this.sql.exec(`SELECT * FROM mailbox WHERE id = ?1`, id).one())
  }

  // ─── the left-out list ───────────────────────────────────────────────

  /** Every chat id on the list, oldest first. */
  private leftOutIds(): string[] {
    return this.sql
      .exec(`SELECT key FROM setting WHERE key LIKE ?1 ORDER BY updated_at, key`, `${LEFT_OUT_PREFIX}%`)
      .toArray()
      .map((r) => text(r.key).slice(LEFT_OUT_PREFIX.length))
  }

  /** The chats left out, as the list shows them, with whether a Bring back of each is waiting for the bridge. Newest first. */
  textsLeftOutList(): TextsLeftOut[] {
    const owed = new Set(
      this.sql
        .exec(`SELECT key FROM setting WHERE key LIKE ?1`, `${FILL_PREFIX}%`)
        .toArray()
        .map((r) => text(r.key).slice(FILL_PREFIX.length)),
    )
    const left = this.sql
      .exec(`SELECT key, value FROM setting WHERE key LIKE ?1 ORDER BY updated_at DESC, key`, `${LEFT_OUT_PREFIX}%`)
      .toArray()
      .flatMap((r) => {
        const row = leftOutOf(r.value)
        return row
          ? [
              {
                chatId: text(r.key).slice(LEFT_OUT_PREFIX.length),
                name: row.name,
                at: row.at,
                by: row.by,
                fillOwed: false,
                failure: null,
              },
            ]
          : []
      })
    // A chat brought back is off the list and owed a read: it is shown with the owed read until the bridge reports it, so Bring back is seen to be working.
    const brought = [...owed]
      .filter((id) => !left.some((l) => l.chatId === id))
      .map((chatId) => {
        const r = this.sql.exec(`SELECT value, updated_at FROM setting WHERE key = ?1`, `${FILL_PREFIX}${chatId}`).one()
        const row = leftOutOf(r.value)
        return {
          chatId,
          name: row?.name ?? chatId,
          at: row?.at ?? text(r.updated_at),
          by: row?.by ?? TEXTS_ACTOR,
          // Still being tried until it has failed as many times as it may.
          fillOwed: row?.failed === undefined || row.failed.tries < FILL_TRIES_MAX,
          failure: row?.failed ? fillFailureWords(row.failed) : null,
        }
      })
    return [...left, ...brought]
  }

  /**
   * Leave one chat out, by its conversation: the conversation, its messages and the drafts on it are deleted from the store, the chat's id goes on the list so nothing of it is stored again, and the removal is audited (who, the
   * chat, how many messages). A contact this door made for the chat, with nothing else on it, goes with it. `by` is the owner's address, or Claude's actor, which records `words`, the owner's own words as Claude received them. A chat already left out answers ok.
   */
  leaveOutTextChat(conversationId: string, by: string, words?: string): Result<{ chatId: string; removed: number }> {
    return this.ports.transaction(() => {
      const conv = this.sql
        .exec(
          `SELECT id, mailbox_id, text_chat_id FROM conversation WHERE id = ?1 AND text_chat_id IS NOT NULL`,
          conversationId,
        )
        .toArray()[0]
      if (!conv) return fail(404, 'That is not a text conversation, so there is nothing to leave out.')
      const chatId = text(conv.text_chat_id)
      const name = this.chatName(conversationId)
      const at = this.now()
      const removed = Number(
        this.sql.exec(`SELECT count(*) AS n FROM message WHERE conversation_id = ?1`, conversationId).one().n,
      )
      const identities = this.sql
        .exec(`SELECT DISTINCT identity_id FROM participant WHERE conversation_id = ?1`, conversationId)
        .toArray()
        .map((r) => text(r.identity_id))
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        `${LEFT_OUT_PREFIX}${chatId}`,
        JSON.stringify({ name, at, by } satisfies LeftOutRow),
        at,
        by,
      )
      this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${FILL_PREFIX}${chatId}`)
      this.audit(
        by,
        'texts.left-out',
        `conversation:${conversationId}`,
        { chatId, name, messages: removed },
        words === undefined ? null : { words },
      )
      this.deleteTextConversation(conversationId)
      for (const identityId of identities) this.dropIdentityMadeForText(identityId, by)
      return ok({ chatId, removed })
    })
  }

  /**
   * Bring a chat back: it comes off the list and the bridge is owed a read of its last 30 days. The owner's alone (Claude's script has no way to call it). A chat whose read the phone refused and that was given up on is
   * brought back the same way, and its tries start again.
   */
  bringBackTextChat(chatId: string, by: string): Result<{ chatId: string }> {
    return this.ports.transaction(() => {
      let row = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, `${LEFT_OUT_PREFIX}${chatId}`).toArray()[0]
      if (!row) {
        const gaveUp = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, `${FILL_PREFIX}${chatId}`).toArray()[0]
        const held = gaveUp && leftOutOf(gaveUp.value)
        if (!held?.failed || held.failed.tries < FILL_TRIES_MAX)
          return fail(404, 'That chat is not on the left-out list.')
        row = { value: JSON.stringify({ name: held.name, at: held.at, by: held.by } satisfies LeftOutRow) }
      }
      const at = this.now()
      // The fill row keeps the name the chat had, so the list can show it while the read is owed.
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        `${FILL_PREFIX}${chatId}`,
        text(row.value),
        at,
        by,
      )
      this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${LEFT_OUT_PREFIX}${chatId}`)
      this.audit(by, 'texts.brought-back', `chat:${chatId}`, null, { days: TEXTS_FILL_DAYS })
      return ok({ chatId })
    })
  }

  /** The name a chat is shown under: its one other side's contact. */
  private chatName(conversationId: string): string {
    const r = this.sql
      .exec(
        `SELECT ct.name AS name FROM participant p JOIN identity i ON i.id = p.identity_id JOIN contact ct ON ct.id = i.contact_id
          WHERE p.conversation_id = ?1 ORDER BY p.rowid LIMIT 1`,
        conversationId,
      )
      .toArray()[0]
    return r ? text(r.name) : ''
  }

  /** A conversation, its messages and what hangs on them, gone. */
  private deleteTextConversation(conversationId: string): void {
    this.sql.exec(
      `DELETE FROM assist_owed WHERE message_id IN (SELECT id FROM message WHERE conversation_id = ?1) OR conversation_id = ?1`,
      conversationId,
    )
    this.sql.exec(`DELETE FROM message WHERE conversation_id = ?1`, conversationId)
    this.sql.exec(`DELETE FROM participant WHERE conversation_id = ?1`, conversationId)
    this.sql.exec(`DELETE FROM conversation WHERE id = ?1`, conversationId)
  }

  /**
   * A contact the texts door made for a chat, with nothing else on it, is removed with the chat: it holds a name and a number and nothing the owner added. A contact with any other identity, any other conversation or message,
   * a Client, notes or a business is the owner's and stays, as does one the owner made or renamed before.
   */
  private dropIdentityMadeForText(identityId: string, by: string): void {
    const identity = this.sql.exec(`SELECT contact_id FROM identity WHERE id = ?1`, identityId).toArray()[0]
    if (!identity) return
    const contactId = text(identity.contact_id)
    const contact = this.sql
      .exec(`SELECT created_by, client_id, business, role, notes, profile_rev FROM contact WHERE id = ?1`, contactId)
      .toArray()[0]
    if (!contact || text(contact.created_by) !== TEXTS_ACTOR) return
    const untouched =
      contact.client_id === null &&
      text(contact.business) === '' &&
      text(contact.role) === '' &&
      text(contact.notes) === '' &&
      Number(contact.profile_rev) === 0
    const alone =
      Number(this.sql.exec(`SELECT count(*) AS n FROM identity WHERE contact_id = ?1`, contactId).one().n) === 1
    const used =
      this.sql.exec(`SELECT 1 FROM participant WHERE identity_id = ?1 LIMIT 1`, identityId).toArray().length > 0 ||
      this.sql.exec(`SELECT 1 FROM message WHERE identity_id = ?1 LIMIT 1`, identityId).toArray().length > 0 ||
      // A lead is on its contact (made from the side panel, or matched to the number by a site's request): the contact outlives the chat.
      this.sql.exec(`SELECT 1 FROM lead WHERE contact_id = ?1 LIMIT 1`, contactId).toArray().length > 0
    if (!untouched || !alone || used) return
    this.sql.exec(`DELETE FROM identity WHERE id = ?1`, identityId)
    this.sql.exec(`DELETE FROM contact WHERE id = ?1`, contactId)
    this.audit(by, 'contact.delete', `contact:${contactId}`, { madeBy: TEXTS_ACTOR }, null)
  }

  // ─── people ──────────────────────────────────────────────────────────

  /**
   * The identity of a chat's other side, made when it is new. A person is the `sms` identity of their number: the contact that holds the number is them, and a number no contact holds is a new contact named as the phone names it. A
   * business sender is an automated sender's identity of its own, joined to nobody's number. A name the phone gives later replaces a contact's name only while that name is still the number it was made under: a rename by the owner stands.
   */
  private textsIdentity(chat: TextsChat): { id: string; contactId: string } {
    const address = chat.address as string
    const classified =
      chat.kind === 'person'
        ? { kind: 'sms' as const, address }
        : {
            kind: 'manual' as const,
            address: textSenderAddress(chat.kind as 'short-code' | 'named-sender' | 'business', address),
          }
    const name = collapse(chat.name) || address
    const made = this.identityFor(classified, name, TEXTS_ACTOR)
    this.learnTextName(made, address, collapse(chat.name))
    return { id: made.id, contactId: made.contactId }
  }

  /** A contact made under the number (or the sender as the phone gives it) takes the name the phone gives later, once. */
  private learnTextName(identity: { id: string; contactId: string }, address: string, learned: string): void {
    if (learned === '' || NUMBER_SHAPED.test(learned)) return
    const current = text(this.sql.exec(`SELECT name FROM contact WHERE id = ?1`, identity.contactId).one().name)
    if (current !== address || learned === current) return
    this.sql.exec(
      `UPDATE contact SET name = ?2, profile_rev = profile_rev + 1 WHERE id = ?1`,
      identity.contactId,
      learned,
    )
    this.sql.exec(
      `UPDATE message SET from_header = ?2 WHERE identity_id = ?1 AND from_header = ?3`,
      identity.id,
      learned,
      current,
    )
    this.audit(
      TEXTS_ACTOR,
      'contact.name-learned',
      `contact:${identity.contactId}`,
      { name: current },
      { name: learned },
    )
  }

  // ─── filing ──────────────────────────────────────────────────────────

  /**
   * File what the bridge pushed, in ONE transaction: the people, the conversations and the messages. A message already held (the same chat and the phone's id) stores nothing. A message of a chat on the left-out list is
   * refused and counted, and so is a message of a group (not carried yet); the answer names the left-out chats so a bridge that missed the list learns it.
   */
  pushTexts(push: TextsPush): Result<PushResult> {
    return this.ports.transaction(() => {
      const mailbox = this.textsRow(push.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      const left = new Set(this.leftOutIds())
      const chats = new Map(push.chats.map((c) => [c.id, c]))
      const result: PushResult = { stored: 0, repeated: 0, leftOut: 0, groups: 0, skipped: 0, leftOutChats: [] }
      const filing: Filing = {
        mailboxId,
        at,
        mirror: push.mirror === true,
        conversations: new Map(),
        openNow: new Map(),
        touched: new Set(),
      }
      // Oldest first, so the conversation's first message is its oldest and rowid order follows time.
      for (const m of [...push.messages].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
      )) {
        const chat = chats.get(m.chatId)
        if (left.has(m.chatId)) {
          result.leftOut += 1
          if (!result.leftOutChats.includes(m.chatId)) result.leftOutChats.push(m.chatId)
        } else if (!chat) result.skipped += 1
        else if (chat.kind === 'group') result.groups += 1
        else if (this.fileTextsMessage(filing, chat, m)) result.stored += 1
        else result.repeated += 1
      }
      for (const id of filing.touched) this.touchConversation(id)
      this.sql.exec(`UPDATE mailbox SET last_push_at = ?2, last_arrival_at = ?2 WHERE id = ?1`, mailboxId, at)
      return ok(result)
    })
  }

  /** File one message of a push: false when the inbox already holds it (a push repeated after a timeout, or a read-back that overlaps what is held). */
  private fileTextsMessage(f: Filing, chat: TextsChat, m: TextsMessage): boolean {
    const key = `${m.chatId}:${m.id}`
    const held = this.sql
      .exec(`SELECT 1 FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`, f.mailboxId, key)
      .toArray()[0]
    if (held) return false
    let conv = f.conversations.get(chat.id)
    if (!conv) {
      conv = this.textsConversation(f.mailboxId, chat, f.at)
      f.conversations.set(chat.id, conv)
      f.openNow.set(chat.id, conv.isNew ? true : this.conversationState(conv.conversationId).open)
    }
    // In a mirror a message must not reopen a conversation the owner closed: it is filed closed too. A live message from the other side is filed open, which reopens it.
    const closedOnArrival = f.mirror && f.openNow.get(chat.id) === false
    this.insertTextsMessage({ f, conv, chat, m, key, closedOnArrival })
    if (!m.out && !closedOnArrival) f.openNow.set(chat.id, true)
    f.touched.add(conv.conversationId)
    return true
  }

  /** The conversation of a chat, made when it is new, with the chat's one other side (made when new) as its only participant. */
  private textsConversation(mailboxId: string, chat: TextsChat, at: string): ConversationFound {
    const identity = this.textsIdentity(chat)
    const name = collapse(chat.name) || (chat.address as string)
    const existing = this.sql
      .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND text_chat_id = ?2`, mailboxId, chat.id)
      .toArray()[0]
    const conversationId = existing ? text(existing.id) : this.ports.newId()
    if (!existing) {
      this.sql.exec(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, text_chat_id, text_kind) VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
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
   * One message row. Read: the owner's own message always, and another's when the phone has it read. Closed: the owner's own, and (in a mirror) one on a conversation the owner closed. It is filed under the chat's one
   * identity, with the name the phone gives the chat as its sender.
   */
  private insertTextsMessage(a: {
    f: Filing
    conv: ConversationFound
    chat: TextsChat
    m: TextsMessage
    key: string
    closedOnArrival: boolean
  }): void {
    const { f, conv, m } = a
    const id = this.ports.newId()
    const read = m.out || m.read
    const closed = m.out || a.closedOnArrival
    const stampAt = m.out ? m.at : f.at
    this.sql.exec(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, subject, body, why,
                            created_at, created_by, updated_at, updated_by, sent_at, sent_by, source_ref,
                            mailbox_id, from_header, to_header, sender_date, snippet, read_at, read_by, closed_at, closed_by,
                            arrival_key, attachments)
       VALUES (?1, ?2, ?3, ?4, 'sent', '', ?5, '', ?6, ?7, ?6, ?7, ?8, ?9, NULL,
               ?10, ?11, '', ?8, ?12, ?13, ?14, ?15, ?16, ?17, '[]')`,
      id,
      conv.conversationId,
      conv.identityId,
      m.out ? 'out' : 'in',
      m.text,
      f.at,
      TEXTS_ACTOR,
      m.at,
      m.out ? TEXTS_ACTOR : null,
      f.mailboxId,
      m.out ? this.owner.mailName : conv.name,
      collapse(m.text).slice(0, SNIPPET_CHARS),
      read ? stampAt : null,
      read ? TEXTS_ACTOR : null,
      closed ? stampAt : null,
      closed ? TEXTS_ACTOR : null,
      a.key,
    )
  }

  /**
   * Edits, deletions and read marks the phone told the bridge of. An edit replaces the text and stamps when; a deletion is counted (`ignored`) and changes nothing. A read mark stamps the incoming messages sent at or before it read, as the phone has them. Never written back to the phone. A name of a message or chat the inbox does
   * not hold (older than the first fill, never carried, or left out) is counted.
   */
  textsEvents(events: TextsEvents): Result<EventsResult> {
    return this.ports.transaction(() => {
      const mailbox = this.textsRow(events.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      const out: EventsResult = { edited: 0, ignored: 0, read: 0, unknown: 0 }
      const touched = new Set<string>()
      const found = (chatId: string, id: string) =>
        this.sql
          .exec(
            `SELECT id, conversation_id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`,
            mailboxId,
            `${chatId}:${id}`,
          )
          .toArray()[0]
      for (const e of events.edits) {
        const row = found(e.chatId, e.id)
        const changed =
          row &&
          this.sql.exec(
            `UPDATE message SET body = ?2, snippet = ?3, edited_at = ?4, updated_at = ?5, updated_by = ?6 WHERE id = ?1 AND deleted_at IS NULL`,
            text(row.id),
            e.text,
            collapse(e.text).slice(0, SNIPPET_CHARS),
            e.at,
            at,
            TEXTS_ACTOR,
          ).rowsWritten > 0
        if (row && changed) {
          out.edited += 1
          touched.add(text(row.conversation_id))
        } else out.unknown += 1
      }
      // Deleting a text is not carried: the inbox's copy is the only one the owner may have of it. A deletion is heard, counted and changes nothing.
      for (const d of events.deletions) out.ignored += d.ids.length
      const marked = this.applyTextsReads(mailboxId, events.reads ?? [], at, touched)
      out.read += marked.read
      out.unknown += marked.unknown
      for (const id of touched) this.touchConversation(id)
      return ok(out)
    })
  }

  /** The owner read a chat on the phone: the incoming messages of that chat sent at or before the mark are read. Only ever reads; a mark below what is read changes nothing; a chat the inbox does not hold is counted. */
  private applyTextsReads(
    mailboxId: string,
    reads: readonly TextsRead[],
    at: string,
    touched: Set<string>,
  ): { read: number; unknown: number } {
    const out = { read: 0, unknown: 0 }
    for (const r of reads) {
      const conversation = this.sql
        .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND text_chat_id = ?2`, mailboxId, r.chatId)
        .toArray()[0]
      if (!conversation) {
        out.unknown += 1
        continue
      }
      const changed = this.sql.exec(
        `UPDATE message SET read_at = ?3, read_by = ?4, updated_at = ?3, updated_by = ?4
          WHERE conversation_id = ?1 AND direction = 'in' AND status NOT IN ${PENDING}
            AND sender_date <= ?2 AND read_at IS NULL`,
        text(conversation.id),
        r.upTo,
        at,
        TEXTS_ACTOR,
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
   * The bridge's work request, and its heartbeat. It answers the whole left-out list, the newest message held per chat when asked, and what the space owes the bridge (the reads of chats brought back, each offered until its
   * outcome settles it). The "checked in" stamp is written at most once a minute: this is asked every few seconds. The capability flags (`sends`, `media`, `pictures`) are read by later slices; today nothing is offered
   * that needs one.
   */
  textsWork(request: TextsWorkRequest): Result<TextsWork> {
    return this.ports.transaction(() => {
      const mailbox = this.textsRow(request.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const now = this.ports.now()
      this.sql.exec(
        `UPDATE mailbox SET checked_in_at = ?2 WHERE id = ?1 AND (checked_in_at IS NULL OR checked_in_at <= ?3)`,
        mailboxId,
        now.toISOString(),
        new Date(now.getTime() - CHECK_IN_EVERY_MS).toISOString(),
      )
      let newest: TextsWork['newest']
      if (request.newest) {
        newest = {}
        // The key's own chat prefix is stripped: what is answered is the phone's id for the message. SQLite's bare column beside max() takes the row that holds the maximum.
        for (const r of this.sql
          .exec(
            `SELECT c.text_chat_id AS chat, m.arrival_key AS key, max(m.sender_date) AS at
               FROM message m JOIN conversation c ON c.id = m.conversation_id
              WHERE m.mailbox_id = ?1 AND c.text_chat_id IS NOT NULL AND m.arrival_key IS NOT NULL AND m.status NOT IN ${PENDING}
              GROUP BY c.text_chat_id`,
            mailboxId,
          )
          .toArray()) {
          const chat = text(r.chat)
          newest[chat] = { id: text(r.key).slice(chat.length + 1), at: text(r.at) }
        }
      }
      // A read the phone refused is offered again after a pause, and given up after a few tries (the card says so).
      const owed = this.sql
        .exec(`SELECT key, value FROM setting WHERE key LIKE ?1 ORDER BY updated_at, key`, `${FILL_PREFIX}%`)
        .toArray()
        .filter((r) => {
          const failed = leftOutOf(r.value)?.failed
          return (
            failed === undefined ||
            (failed.tries < FILL_TRIES_MAX && now.getTime() - Date.parse(failed.at) >= FILL_RETRY_AFTER_MS)
          )
        })
        .slice(0, LIMITS.owedPerWork)
        .map((r) => ({ kind: 'fill' as const, chatId: text(r.key).slice(FILL_PREFIX.length), days: TEXTS_FILL_DAYS }))
      return ok({ leftOut: this.leftOutIds().slice(0, LIMITS.leftOut), ...(newest && { newest }), owed })
    })
  }

  /**
   * What became of what the bridge was owed: the read of a chat brought back, done or refused. A done one settles it. A refused one is audited and KEPT: it is offered again after `FILL_RETRY_AFTER_MS` (the bridge's memory does not
   * survive a restart, so the space is the one that remembers), up to `FILL_TRIES_MAX` tries, and the Texts card shows the failure in words; after the last the owner's Bring back tries again from the start. An outcome that names nothing owed is counted.
   */
  textsOutcomes(report: TextsOutcomes): Result<OutcomesResult> {
    return this.ports.transaction(() => {
      const mailbox = this.textsRow(report.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const out: OutcomesResult = { settled: 0, unknown: 0 }
      for (const o of report.outcomes) {
        const key = `${FILL_PREFIX}${o.chatId}`
        const held = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, key).toArray()[0]
        if (!held) {
          out.unknown += 1
          continue
        }
        out.settled += 1
        if (o.ok) this.sql.exec(`DELETE FROM setting WHERE key = ?1`, key)
        else {
          const row = leftOutOf(held.value) ?? { name: o.chatId, at: this.now(), by: TEXTS_ACTOR }
          const tries = (row.failed?.tries ?? 0) + 1
          this.sql.exec(
            `UPDATE setting SET value = ?2, updated_at = ?3 WHERE key = ?1`,
            key,
            JSON.stringify({ ...row, failed: { at: this.now(), reason: o.reason, tries } } satisfies LeftOutRow),
            this.now(),
          )
          this.audit(
            TEXTS_ACTOR,
            'texts.fill-failed',
            `mailbox:${mailboxId}`,
            { chatId: o.chatId },
            { reason: o.reason },
          )
        }
      }
      return ok(out)
    })
  }

  /**
   * What the bridge says of itself. `signed-out` records that Google ended the pairing as the mailbox's last error (only the owner can sign in again); `phone-not-answering` keeps since when; any other state clears an error
   * that was only that.
   */
  textsStatus(report: TextsStatusReport): Result<{ state: TextsState }> {
    return this.ports.transaction(() => {
      const mailbox = this.textsRow(report.account.id)
      if (!mailbox.ok) return mailbox
      const mailboxId = text(mailbox.value.id)
      const at = this.now()
      this.sql.exec(
        `UPDATE mailbox SET bridge_state = ?2, bridge_state_at = ?3, checked_in_at = ?3 WHERE id = ?1`,
        mailboxId,
        report.state,
        at,
      )
      if (report.state === 'phone-not-answering' && report.since) {
        this.sql.exec(
          `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          PHONE_SINCE_KEY,
          report.since,
          at,
          TEXTS_ACTOR,
        )
      } else this.sql.exec(`DELETE FROM setting WHERE key = ?1`, PHONE_SINCE_KEY)
      if (report.state === 'signed-out') {
        this.sql.exec(
          `UPDATE mailbox SET last_error = ?2, last_error_at = ?3 WHERE id = ?1`,
          mailboxId,
          `Google ended the bridge's sign-in${report.reason ? ` (${report.reason})` : ''}`,
          at,
        )
        if (text(mailbox.value.bridge_state) !== 'signed-out')
          this.audit(TEXTS_ACTOR, 'mailbox.signed-out', `mailbox:${mailboxId}`, null, { reason: report.reason ?? null })
      } else {
        this.sql.exec(`UPDATE mailbox SET last_error = NULL, last_error_at = NULL WHERE id = ?1`, mailboxId)
      }
      return ok({ state: report.state })
    })
  }

  /** The texts mailbox, as the script shows it: at most one. Counts come from the same facts as the queue's. */
  textsMailboxes(): TextsMailboxStatus[] {
    return this.sql
      .exec(`SELECT * FROM mailbox WHERE kind = 'texts' ORDER BY rowid`)
      .toArray()
      .map((r) => this.textsStatusOf(r))
  }

  private textsStatusOf(r: Record<string, unknown>): TextsMailboxStatus {
    const id = text(r.id)
    const count = (table: string) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE mailbox_id = ?1`, id).one().n)
    const open = this.queueFacts(id).filter((f) => f.open && !isBulk(f))
    const checkedInAt = textOrNull(r.checked_in_at)
    const reportedState = textOrNull(r.bridge_state) as TextsState | null
    const stale = checkedInAt === null || this.ports.now().getTime() - Date.parse(checkedInAt) > NOT_CHECKED_IN_AFTER_MS
    // A signed-out bridge has stopped asking by design, so it is told as signed out and not as silent.
    const state: TextsMailboxStatus['state'] =
      reportedState === 'signed-out' ? 'signed-out' : stale ? 'not-checked-in' : (reportedState ?? 'live')
    const reasons: string[] = []
    if (state === 'signed-out') {
      reasons.push(textsLoginEnded(this.owner.name))
    } else if (state === 'not-checked-in') {
      reasons.push(
        checkedInAt === null
          ? 'The texts bridge has not checked in yet.'
          : `The texts bridge has not checked in since ${checkedInAt}.`,
      )
    }
    const since = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, PHONE_SINCE_KEY).toArray()[0]
    return {
      id,
      kind: 'texts',
      address: text(r.address),
      name: text(r.display_name),
      createdAt: text(r.connected_at),
      state,
      reported: reportedState === null ? null : { state: reportedState, at: text(r.bridge_state_at) },
      phoneSince: reportedState === 'phone-not-answering' && since ? text(since.value) : null,
      checkedInAt,
      lastPushAt: textOrNull(r.last_push_at),
      lastError: textOrNull(r.last_error),
      lastErrorAt: textOrNull(r.last_error_at),
      leftOut: this.leftOutIds().length,
      fillsOwed: Number(
        this.sql.exec(`SELECT count(*) AS n FROM setting WHERE key LIKE ?1`, `${FILL_PREFIX}%`).one().n,
      ),
      messages: count('message'),
      conversations: count('conversation'),
      open: open.length,
      unreadOpen: open.filter((f) => f.unread).length,
      health: { amber: reasons.length > 0, reasons },
    }
  }
}
