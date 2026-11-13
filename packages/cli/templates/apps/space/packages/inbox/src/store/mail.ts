/**
 * The store's Gmail half: the mailbox, the cursor, the resumable jobs, and turning
 * a Gmail message into a row. Everything here is synchronous SQL over the same
 * ports as the rest of the store, so every rule runs under plain `bun` against a
 * real SQLite; the network lives in ../gmail/mailroom.ts, which calls these in
 * short transactions between its awaits.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `MailStore extends Inbox` so it can use the base's `audit`, `identityFor` and
 * `touchConversation` without making them public. It is not a second kind of
 * store: the Durable Object builds one of these and nothing else.
 *
 * ── THE TOKEN ────────────────────────────────────────────────────────────
 * `mailboxRow()` returns the refresh token and is for the Mailroom only. It is
 * deliberately NOT in STORE_METHODS (app.ts), so no route can reach it; what a
 * route can reach is `mailboxStatus()`, whose shape has no field for it. No
 * audit entry here ever carries it.
 *
 * ── EVERY INGEST IS AN UPSERT ────────────────────────────────────────────
 * A message is found by (mailbox, Gmail id). A message already held keeps
 * everything it has and takes only Gmail's current labels, so a duplicate push, a
 * fill that overlaps a sync and a resync that overlaps both each store it once.
 * Nothing here ever deletes a message.
 *
 * ── READ AND CLOSE ────────────────────────────────────────────────────────
 * For an email conversation Gmail's labels are the truth and the inbox's stamps
 * (`read_at`, `closed_at` and who) say who made each change. EVERY write of a
 * message's labels goes through `writeLabels`, which keeps the stamps true to
 * them, so a label change that arrives from Gmail and one the inbox made itself
 * leave the same shape behind. A change the inbox makes is applied here only
 * AFTER Gmail accepted it (the Mailroom's `changeConversation` orders that), and
 * the history event that echoes it finds the labels already set and changes
 * nothing, which is also why it leaves the person's name on the stamp and does
 * not replace it with `gmail`.
 *
 * ── WHAT GETS IN ─────────────────────────────────────────────────────────
 * `belongsInStore`: in the Inbox or in Sent, or in a thread already held, and
 * never spam, trash or one of the owner's unfinished drafts.
 */

import { type CalendarSummary, INBOX_MOST_RECIPIENTS } from '@space/workspace'
import { keptCalendar } from '../calendar-summary'
import { messageIdOf } from '../cloudflare/send'
import { subjectKey } from '../cloudflare/thread'
import { accountLabel } from '../gmail/account'
import type { SentMessage } from '../gmail/google'
import { healthOf, lapsedReason, type MailboxStamps, stateOf, workingGrantSql } from '../gmail/health'
import type { LabelDelta } from '../gmail/history'
import { isBareAddress, MESSAGE_ID } from '../gmail/mime'
import { belongsInStore, inPlay, LABEL, type ParsedAddress, type ParsedMessage } from '../gmail/types'
import { notOnThatMailbox } from '../mailbox-words'
import { cloudflareNotifyDecision, notifyDecision } from '../notify/rule'
import {
  claudeSendingOff,
  draftChangedAfterInstruction,
  instructionBeforeReply,
  instructionInTheFuture,
  instructionOnlyFromOwnerInSession,
  noInstruction,
  onlyOwnerNotifications,
  onlyOwnerOrClaudeSends,
  onlyOwnerResolves,
  onlyOwnerSwitches,
  pictureNamedButNone,
  pictureNotNamed,
  pictureNotTheOneNamed,
  recipientsChangedAfterInstruction,
  recordOwnersWords,
  sayWhenOwnerSaid,
  sayWhereOwnerTold,
} from '../owner-words'
import { ALL_MAIL, CLEF_JUNK_THRESHOLD, canSee, deviceOwnerOf, isBulk, type MailScope } from '../queue'
import { TELEGRAM_CAPTION_MAX, TELEGRAM_TEXT_MAX } from '../telegram/wire'
import {
  AGENT_PREFIX,
  type AttachmentInfo,
  CALENDAR_ACTOR,
  type ClaudeSend,
  type ClaudeSending,
  type ConversationChange,
  type ConversationState,
  type DeliveryOutcome,
  type Device,
  GMAIL_ACTOR,
  type IdentityKind,
  isAgent,
  MAX_INSTRUCTION_TEXT,
  MAX_INSTRUCTION_WHERE,
  type MailboxStatus,
  type MessageRow,
  ONLY_CLAUDE_CARRIES_INSTRUCTION,
  type SendInstruction,
  type SendRequest,
} from '../types'
import { classifyAddress } from './address'
import {
  belongsToMailbox,
  domainIsOurs,
  heldOnServer,
  idColumns,
  isOurs,
  labelsAreTruth,
  type MailboxKind,
  sentIsAFolder,
  serverActorOf,
  whereHeldWords,
} from './kinds'
import { personKey } from './people'
import { MESSAGE_MAILBOX, scopeWhere } from './scope'
import {
  type CloudflareSender,
  ccAddressesOf,
  EM_DASH,
  fail,
  isoOrNull,
  jsonArray,
  messageRow,
  ok,
  PENDING,
  type Result,
  text,
  textOrNull,
} from './store'
import { type PictureFacts, type SendPicture, type TelegramChatFacts, TelegramStore } from './telegram'

/** What a message from Gmail is stored as; see MessageStatus for why `sent`. */
const RECEIVED_STATUS = 'sent'

/**
 * Work too long for one Worker invocation, kept in the mailbox row so the next
 * alarm picks it up. A fill and a resync are the same walk (list a window of
 * mail, store it), and a resync then re-reads the labels of the open
 * conversations so an archive made during the gap is caught.
 */
export interface SyncJob {
  kind: 'fill' | 'resync'
  /** The Gmail search that bounds the window. */
  query: string
  /** The history id read BEFORE listing. It becomes the cursor when the job completes. */
  cursorAfter: string
  stage: 'list' | 'labels'
  pageToken: string | null
  /** The label stage's thread ids still to re-read; null until that stage begins. */
  threads: string[] | null
}

export interface MailboxRow {
  id: string
  kind: 'gmail'
  address: string
  /** The pill its conversations carry (the address when none was given). */
  name: string
  /** Null after a disconnect. The only copy of the key lives in this field. */
  refreshToken: string | null
  scopes: string[]
  historyId: string | null
  watchExpiry: string | null
  connectedAt: string
  lastPushAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastResyncAt: string | null
  retryCount: number
  pushSeq: number
  syncedSeq: number
  pushSuspectAt: string | null
  /** When Google said the grant is gone; null while it works. */
  lapsedAt: string | null
  job: SyncJob | null
}

function parseJob(v: unknown): SyncJob | null {
  if (typeof v !== 'string') return null
  try {
    const job = JSON.parse(v) as SyncJob
    return job && typeof job === 'object' && (job.kind === 'fill' || job.kind === 'resync') ? job : null
  } catch {
    return null
  }
}

function mailboxFrom(r: Record<string, unknown>): MailboxRow {
  return {
    id: text(r.id),
    kind: 'gmail',
    address: text(r.address),
    name: text(r.display_name) || text(r.address),
    refreshToken: textOrNull(r.refresh_token),
    scopes: text(r.scopes).split(/\s+/).filter(Boolean),
    historyId: textOrNull(r.history_id),
    watchExpiry: textOrNull(r.watch_expiry),
    connectedAt: text(r.connected_at),
    lastPushAt: textOrNull(r.last_push_at),
    lastSyncAt: textOrNull(r.last_sync_at),
    lastError: textOrNull(r.last_error),
    lastErrorAt: textOrNull(r.last_error_at),
    lastResyncAt: textOrNull(r.last_resync_at),
    retryCount: Number(r.retry_count),
    pushSeq: Number(r.push_seq),
    syncedSeq: Number(r.synced_seq),
    pushSuspectAt: textOrNull(r.push_suspect_at),
    lapsedAt: textOrNull(r.grant_lapsed_at),
    job: parseJob(r.job),
  }
}

/** An error message kept short and one line: it is shown in the header. */
const brief = (message: string): string => message.replace(/\s+/g, ' ').trim().slice(0, 300)

const sortedLabels = (labels: Iterable<string>): string => JSON.stringify([...new Set(labels)].sort())

/** The addresses in a header that are email addresses, normalized; anything else (a list name) is dropped. */
function emailPeople(list: ParsedAddress[]): { kind: IdentityKind; address: string; name: string }[] {
  return list.flatMap((p) => {
    const c = classifyAddress(p.address)
    return c && c.kind === 'email' ? [{ kind: c.kind, address: c.address, name: p.name }] : []
  })
}

/**
 * The most a message can say before the inbox refuses to send it. A body this long is
 * not an email the owner wrote; Gmail's own limit is far above it and a Worker's memory is not.
 */
export const MAX_SEND_BODY = 100_000

/** Whether an audit entry's draft before and after go to different people: another recipient, or another set of Cc addresses (order and names do not matter). An entry with no draft before it (its creation) changes nobody. */
function recipientsDiffer(before: unknown, after: unknown): boolean {
  const read = (v: unknown): { address: string; cc: string[] } | null => {
    if (typeof v !== 'string') return null
    try {
      const row = JSON.parse(v) as { address?: unknown; cc?: unknown }
      return { address: text(row.address), cc: ccAddressesOf(text(row.cc)).sort() }
    } catch {
      return null
    }
  }
  const was = read(before)
  const now = read(after)
  if (was === null || now === null) return false
  return was.address !== now.address || was.cc.join(',') !== now.cc.join(',')
}

/**
 * Everything a send needs, read and checked in one place BEFORE anything is claimed
 * or asked of Gmail. What goes to Gmail is this and nothing else: the recipients are
 * the draft's own, the text is the draft's at the revision named.
 */
interface SendPlanBase {
  id: string
  rev: number
  mailboxId: string
  /** The mailbox's address, which the message is sent from. */
  from: string
  to: string
  cc: string[]
  subject: string
  body: string
  /** The Message-ID of the message answered, or null. */
  inReplyTo: string | null
  /** The moment of sending, ISO: the Date header, and what the filed message's sent time is, so the two agree. */
  at: string
  /** The owner's instruction, for a send by Claude, which the claim records; null for a send by the owner. */
  instruction: SendInstruction | null
}

/** A send through Gmail, as the owner: into the Gmail thread it answers, under a Message-ID of the inbox's own. */
export interface GmailSendPlan extends SendPlanBase {
  transport: 'gmail'
  /** The Gmail thread to send into, or null for a new email. */
  threadId: string | null
  /** The new message's own Message-ID, which the claim records on the draft. */
  messageId: string
}

/**
 * A send through Cloudflare, as the mailbox's own address (a business's info@). There is no Gmail thread and no Message-ID of the
 * inbox's own: Cloudflare composes the message and sets the Message-ID and the Date itself (its documentation lists both as
 * platform-controlled), so the Message-ID is the one Cloudflare reports once it accepts the message.
 */
export interface CloudflareSendPlan extends SendPlanBase {
  transport: 'cloudflare'
  /** The mailbox's display name, which the From line carries. */
  fromName: string
  /** The Message-IDs the reply is threaded on, oldest first: the answered message's own parent, then the answered message. */
  references: string[]
}

/**
 * A send through Telegram, as the owner: into the chat the draft is on, by the Telegram bridge. Nothing is composed here and nothing is called: the claim stores the send as owed
 * (a random id of Telegram's own repeat key made with it), the bridge takes it on its next work request and reports Telegram's message id or its refusal. Plain text only, the draft's body byte for byte.
 */
export interface TelegramSendPlan {
  transport: 'telegram'
  id: string
  rev: number
  /** The Telegram mailbox. */
  mailboxId: string
  /** The chat it goes to, as the wire spells it. */
  chatId: string
  /** The words, or the caption when a `picture` goes with them. */
  body: string
  at: string
  instruction: SendInstruction | null
  /** The picture the message goes out with (as a Telegram photo), or null for words alone. */
  picture: SendPicture | null
}

/**
 * A send through the mail server over JMAP, as the mailbox's own address: into the server's thread when it is a reply, under a Message-ID of the inbox's own that the
 * claim records (the server keeps the header it is given, and the copy it files in Sent carries it, which is how a send whose answer was lost is recognised later), with the reply headers Cloudflare's plan carries.
 */
export interface JmapSendPlan extends SendPlanBase {
  transport: 'jmap'
  /** The mailbox's display name, which the From line carries (never anything typed). */
  fromName: string
  /** The server's thread the message answers, or null for a new email. */
  threadId: string | null
  /** The new message's own Message-ID, which the claim records on the draft. */
  messageId: string
  /** The Message-IDs the reply is threaded on, oldest first. */
  references: string[]
}

/** What `planSend` has settled by the time it picks the transport. */
interface SendFacts {
  msg: MessageRow
  input: SendRequest
  instruction: SendInstruction | null
  recipients: { to: string; cc: string[] }
}

export type SendPlan = GmailSendPlan | CloudflareSendPlan | JmapSendPlan | TelegramSendPlan

/** Where one attachment of a stored message is to be found (`attachmentRef`): in Gmail, or in the kept copy in the raw-mail bucket. */
export interface AttachmentRef {
  /** The mailbox the message is in: the Gmail account whose message it asks, for a Gmail message. */
  mailboxId: string | null
  gmailId: string | null
  rawKey: string | null
  direction: 'in' | 'out'
  attachment: AttachmentInfo
}

/** The setting row that says the one-time pass over stored calendar mail was done (`MailStore.calendarPassDone`). */
const EVENT_KEYS_BACKFILLED = 'calendar_event_keys_backfilled'
/** The setting row that says the one-time pass over stored Gmail mail for calendar summaries is done (migration 20's sibling of the event-key pass). */
const CALENDAR_SUMMARIES_BACKFILLED = 'calendar_summaries_backfilled'

/** An open conversation that a newer one about the same calendar event has replaced (`MailStore.supersededEvents`). */
export interface Superseded {
  conversationId: string
  mailboxId: string
  /** Which kind of mailbox it is in: a Gmail conversation is closed in Gmail first. A JMAP one is not closed by the sweep at all (not in this phase). */
  kind: 'gmail' | 'cloudflare' | 'jmap'
  /** The conversation that stays. */
  replacedBy: string
  eventKey: string
  /** How far into the conversation to close (what a person's Close names). */
  through: number
}

/** The setting's key for the switch, and the slack allowed between Claude's clock and the inbox's on an instruction's time. */
const CLAUDE_SENDING_KEY = 'claude_sending'
const INSTRUCTION_SKEW_MS = 5 * 60 * 1000

/**
 * "The inbox" as the place an instruction was given. Refused for now: the inbox has no surface
 * where the owner can give one, so a send that says it was told there is either a mistake or a
 * message's text being obeyed (an instruction's place is always a session, never the inbox).
 */
const INBOX_AS_PLACE = /^(the\s+)?inbox\b/i

/** How much of a sent message's body is kept as its snippet. */
const SENT_SNIPPET_CHARS = 100

export interface IngestCounts {
  stored: number
  existing: number
  skipped: number
}

/** A message a page stored for the first time: its row, and its From as the store normalized it. */
export interface StoredMessage {
  id: string
  from: string | null
}

/** A notification the sync marked owed, with what it will carry. */
export interface OwedNotification {
  messageId: string
  conversationId: string
  name: string
  address: string
  subject: string
  receivedAt: string
  /** The mailbox's name, on mail that arrived through a Cloudflare one (the notification says which business wrote) or through one of several Gmail accounts (which account). */
  mailbox?: string
  /** The key the space opens the sender's conversation by, when it is not the address (a Telegram person): see `owedNotifications`. */
  person?: string
}

/** What a Telegram notification says in place of a subject: never the words of the message (src/notify/rule.ts `messagePayload`). */
export const TELEGRAM_NOTIFICATION_BODY = 'New Telegram message'

/** A device with the keys a notification is encrypted to. Never leaves the notifications module. */
export interface DeviceWithKeys extends Device {
  p256dh: string
  auth: string
  /** The person the device is for: who added it, or the owner for one whose adder is no person of the install (`deviceOwnerOf`, src/queue.ts). A notification goes only to devices of people who may see its mail. */
  owner: string
}

/** A message as notifications read it: its labels and subject, Gmail's time, and the sender's identity and contact. */
const NOTIFY_SELECT = `
  SELECT m.id, m.conversation_id, m.labels, m.subject, coalesce(m.sent_at, m.created_at) AS at,
         i.address, ct.id AS contact_id, ct.name, ct.client_id,
         (SELECT mb.display_name FROM mailbox mb WHERE mb.id = m.mailbox_id
             AND (mb.kind IN ('cloudflare', 'telegram', 'jmap') OR (SELECT count(*) FROM mailbox g WHERE g.kind = 'gmail') > 1)) AS cf_mailbox,
         (SELECT mb.kind FROM mailbox mb WHERE mb.id = m.mailbox_id) AS mailbox_kind,
         (SELECT min(e.address) FROM identity e WHERE e.contact_id = ct.id AND e.kind = 'email') AS contact_email,
         (SELECT c.telegram_kind FROM conversation c WHERE c.id = m.conversation_id) AS telegram_kind,
         (SELECT gc.id FROM participant gp JOIN identity gi ON gi.id = gp.identity_id JOIN contact gc ON gc.id = gi.contact_id
           WHERE gp.conversation_id = m.conversation_id ORDER BY gp.rowid LIMIT 1) AS chat_contact_id,
         (SELECT gc.name FROM participant gp JOIN identity gi ON gi.id = gp.identity_id JOIN contact gc ON gc.id = gi.contact_id
           WHERE gp.conversation_id = m.conversation_id ORDER BY gp.rowid LIMIT 1) AS chat_contact_name
    FROM message m JOIN identity i ON i.id = m.identity_id JOIN contact ct ON ct.id = i.contact_id`

const clientIdOf = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/** Who the audit names when the push service said a device is gone. */
export const PUSH_SERVICE_ACTOR = 'push-service'

function deviceFrom(r: Record<string, unknown>): Device {
  return {
    id: text(r.id),
    label: text(r.label),
    endpoint: text(r.endpoint),
    addedAt: text(r.added_at),
    lastDeliveredAt: textOrNull(r.last_delivered_at),
    lastFailedAt: textOrNull(r.last_failed_at),
    lastFailure: textOrNull(r.last_failure),
    lastOutcome: textOrNull(r.last_outcome) as DeliveryOutcome | null,
    delivered: Number(r.delivered ?? 0),
    failed: Number(r.failed ?? 0),
  }
}

export class MailStore extends TelegramStore {
  // ─── the mailbox ─────────────────────────────────────────────────────

  /**
   * Every Gmail account with its token, oldest first. For the Mailroom; never reachable from a route. ONLY the Gmail ones: a Cloudflare
   * mailbox (arrival.ts) has no token, cursor or job.
   */
  gmailMailboxes(): MailboxRow[] {
    return this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'gmail' ORDER BY rowid`).toArray().map(mailboxFrom)
  }

  /** One Gmail account with its token, by its id; null for an id that is none (a Cloudflare mailbox's included). Callers name the account; there is no "the first one". */
  mailboxRow(id: string): MailboxRow | null {
    const r = this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'gmail' AND id = ?1`, id).toArray()[0]
    return r ? mailboxFrom(r) : null
  }

  /** The Gmail account at this address, or null: where a push for an address goes. */
  mailboxRowAt(address: string): MailboxRow | null {
    const r = this.sql
      .exec(`SELECT * FROM mailbox WHERE kind = 'gmail' AND address = ?1`, address.trim().toLowerCase())
      .toArray()[0]
    return r ? mailboxFrom(r) : null
  }

  /**
   * The account a draft that names none goes out from: the owner's own address while it is connected, else the oldest connected account. A draft
   * made before several accounts existed records no mailbox, and sends from here, which is the one account it always sent from.
   */
  defaultGmail(): MailboxRow | null {
    const id = this.defaultGmailId()
    return id === null ? null : this.mailboxRow(id)
  }

  /** What the header shows for one account. No field in it can hold the token. */
  mailboxStatus(id: string): MailboxStatus | null {
    const row = this.mailboxRow(id)
    return row ? this.statusOf(row) : null
  }

  /** Every Gmail account as the header shows it, oldest first. */
  mailboxStatuses(): MailboxStatus[] {
    return this.gmailMailboxes().map((row) => this.statusOf(row))
  }

  private statusOf(row: MailboxRow): MailboxStatus {
    const count = (table: string) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE mailbox_id = ?1`, row.id).one().n)
    // Open and unread-open by the SAME rules as the queue (store.ts foldConversation), over
    // this mailbox's conversations, bulk included, as Gmail's own Inbox count includes it:
    // these are the numbers to compare with Gmail's, and with the queue's.
    const facts = this.queueFacts(row.id)
    const open = facts.filter((f) => f.open)
    const stamps: MailboxStamps = {
      address: row.address,
      connected: row.refreshToken !== null,
      watchExpiry: row.watchExpiry,
      lastPushAt: row.lastPushAt,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
      lapsedAt: row.lapsedAt,
      historyId: row.historyId,
      jobKind: row.job?.kind ?? null,
      pushSuspectAt: row.pushSuspectAt,
    }
    // The judged fields are the status's own; the three that are not shown stay out.
    const { historyId: _cursor, jobKind: _job, pushSuspectAt: _suspect, ...shown } = stamps
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      ...shown,
      state: stateOf(stamps),
      sendsByDefault: row.id === this.defaultGmailId(),
      connectedAt: row.connectedAt,
      lastErrorAt: row.lastErrorAt,
      lastResyncAt: row.lastResyncAt,
      messages: count('message'),
      conversations: count('conversation'),
      open: open.length,
      unreadOpen: open.filter((f) => f.unread).length,
      health: healthOf(stamps, this.ports.now()),
    }
  }

  /**
   * Save a verified grant for the account that granted it (any address; the Mailroom has checked that the actor is the owner and the scope is
   * the one the inbox needs). A first connection of an address makes its row, labels it (the pill, src/gmail/account.ts) and starts the fill; a
   * reconnect (the row survives a disconnect, so its cursor does too) keeps its cursor and is marked for a catch-up sync instead, which is cheaper
   * and cannot lose what arrived in between: if the cursor has gone stale, Gmail says so and the resync runs. A reconnect also ends a lapse.
   */
  connectMailbox(
    input: { address: string; refreshToken: string; scopes: string[]; historyId: string; query: string },
    actor: string,
  ): MailboxRow {
    return this.ports.transaction(() => {
      const at = this.now()
      const existing = this.sql
        .exec(`SELECT id, history_id FROM mailbox WHERE kind = 'gmail' AND address = ?1`, input.address)
        .toArray()[0]
      const fill: SyncJob = {
        kind: 'fill',
        query: input.query,
        cursorAfter: input.historyId,
        stage: 'list',
        pageToken: null,
        threads: null,
      }
      // The labels the other accounts wear, so this one never wears the same.
      const taken = this.sql
        .exec(
          `SELECT display_name FROM mailbox WHERE kind = 'gmail' AND address != ?1 AND display_name != ''`,
          input.address,
        )
        .toArray()
        .map((r) => text(r.display_name))
      let id: string
      if (existing) {
        id = text(existing.id)
        const resumed = textOrNull(existing.history_id) !== null
        this.sql.exec(
          `UPDATE mailbox SET refresh_token = ?2, scopes = ?3, connected_at = ?4, connected_by = ?5,
                  last_error = NULL, last_error_at = NULL, retry_count = 0, push_seq = push_seq + 1,
                  grant_lapsed_at = NULL,
                  display_name = CASE WHEN display_name = '' THEN ?7 ELSE display_name END,
                  job = CASE WHEN history_id IS NULL THEN ?6 ELSE job END
            WHERE id = ?1`,
          id,
          input.refreshToken,
          input.scopes.join(' '),
          at,
          actor,
          JSON.stringify(fill),
          accountLabel(input.address, taken),
        )
        this.audit(actor, 'mailbox.connect', `mailbox:${id}`, null, {
          address: input.address,
          scopes: input.scopes,
          resumed,
        })
      } else {
        id = this.ports.newId()
        this.sql.exec(
          `INSERT INTO mailbox (id, kind, address, refresh_token, scopes, connected_at, connected_by, job, display_name)
           VALUES (?1, 'gmail', ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          id,
          input.address,
          input.refreshToken,
          input.scopes.join(' '),
          at,
          actor,
          JSON.stringify(fill),
          accountLabel(input.address, taken),
        )
        this.audit(actor, 'mailbox.connect', `mailbox:${id}`, null, {
          address: input.address,
          scopes: input.scopes,
          resumed: false,
        })
      }
      // A Gmail account is its connector's: the person who connected it is on it (a row that somehow has nobody is put right, never left unseen).
      if (this.whoIsOn(id).length === 0) this.seatMailbox(id, 'gmail', input.address, actor)
      return this.mailboxRow(id) as MailboxRow
    })
  }

  /**
   * Forget one account's token and stop its work. The row stays, with its cursor, because
   * conversations point at it and because a reconnect then only has to catch up.
   */
  disconnectMailbox(mailboxId: string, actor: string, revoked: boolean): void {
    this.ports.transaction(() => {
      const row = this.mailboxRow(mailboxId)
      if (!row) return
      this.sql.exec(
        `UPDATE mailbox SET refresh_token = NULL, watch_expiry = NULL, job = NULL, last_error = NULL,
                last_error_at = NULL, retry_count = 0, push_suspect_at = NULL, grant_lapsed_at = NULL, synced_seq = push_seq
          WHERE id = ?1`,
        row.id,
      )
      this.audit(actor, 'mailbox.disconnect', `mailbox:${row.id}`, { address: row.address }, { revoked })
    })
  }

  /**
   * Google said this account's grant is gone. Stamped once (the first finding stands until the account is connected again), audited, and the
   * work it was doing is dropped: a lapsed account does not sync, renew or send, and retrying would only hammer Google.
   */
  markGrantLapsed(mailboxId: string): void {
    this.ports.transaction(() => {
      const row = this.mailboxRow(mailboxId)
      if (!row || row.lapsedAt !== null) return
      this.sql.exec(
        `UPDATE mailbox SET grant_lapsed_at = ?2, retry_count = 0, synced_seq = push_seq WHERE id = ?1`,
        mailboxId,
        this.now(),
      )
      this.audit(GMAIL_ACTOR, 'mailbox.lapse', `mailbox:${mailboxId}`, null, { address: row.address })
    })
  }

  // ─── what is owed ────────────────────────────────────────────────────

  /** A push arrived for this account: remember when, and that changes are owed. */
  recordPush(mailboxId: string): void {
    this.sql.exec(
      `UPDATE mailbox SET last_push_at = ?2, push_seq = push_seq + 1
        WHERE id = ?1 AND ${workingGrantSql()}`,
      mailboxId,
      this.now(),
    )
  }

  /** Someone asked for a sync (of one account, or of every one with none named): changes are owed, and it is not a push. */
  markSyncOwed(mailboxId?: string): void {
    this.sql.exec(
      `UPDATE mailbox SET push_seq = push_seq + 1, retry_count = 0
        WHERE kind = 'gmail' AND ${workingGrantSql()} AND (?1 IS NULL OR id = ?1)`,
      mailboxId ?? null,
    )
  }

  setWatch(mailboxId: string, expiry: string): void {
    this.sql.exec(`UPDATE mailbox SET watch_expiry = ?2 WHERE id = ?1`, mailboxId, expiry)
  }

  /**
   * A successful step. The error is cleared unless the caller says a failure that
   * is still true (the watch could not be renewed) happened in the same pass.
   * `syncedSeq` is recorded only when the sync COMPLETED, so a budget-limited run
   * leaves the rest owed.
   */
  recordSyncSuccess(mailboxId: string, syncedSeq: number | null, keepError = false): void {
    this.sql.exec(
      `UPDATE mailbox SET last_sync_at = ?2, retry_count = 0,
              last_error = CASE WHEN ?4 = 1 THEN last_error ELSE NULL END,
              last_error_at = CASE WHEN ?4 = 1 THEN last_error_at ELSE NULL END,
              synced_seq = CASE WHEN ?3 IS NULL THEN synced_seq ELSE max(synced_seq, ?3) END
        WHERE id = ?1`,
      mailboxId,
      this.now(),
      syncedSeq,
      keepError ? 1 : 0,
    )
  }

  /** A failed step. Answers the new retry count, which the caller turns into a backoff. */
  recordFailure(mailboxId: string, message: string): number {
    this.sql.exec(
      `UPDATE mailbox SET last_error = ?2, last_error_at = ?3, retry_count = retry_count + 1 WHERE id = ?1`,
      mailboxId,
      brief(message),
      this.now(),
    )
    return Number(this.sql.exec(`SELECT retry_count AS n FROM mailbox WHERE id = ?1`, mailboxId).one().n)
  }

  /** The daily pass found new mail while no push had come for a day. */
  markPushSuspect(mailboxId: string): void {
    this.sql.exec(`UPDATE mailbox SET push_suspect_at = ?2 WHERE id = ?1`, mailboxId, this.now())
  }

  // ─── what is held ────────────────────────────────────────────────────

  knownGmailIds(mailboxId: string, ids: string[]): Set<string> {
    const column = this.idColumnsOf(mailboxId).message
    const known = new Set<string>()
    for (const id of ids) {
      if (this.sql.exec(`SELECT 1 FROM message WHERE mailbox_id = ?1 AND ${column} = ?2`, mailboxId, id).toArray()[0]) {
        known.add(id)
      }
    }
    return known
  }

  /** The kind of mailbox a conversation is in: `gmail`, `cloudflare`, `telegram`, `jmap`, or null for a manual conversation and for one that does not exist. */
  conversationMailboxKind(conversationId: string): MailboxKind | null {
    return this.mailboxKindOf(conversationId)
  }

  /** The columns the server ids of this mailbox's messages and threads are kept in (JMAP's for a JMAP mailbox, Gmail's for any other). */
  protected idColumnsOf(mailboxId: string): ReturnType<typeof idColumns> {
    const r = this.sql.exec(`SELECT kind FROM mailbox WHERE id = ?1`, mailboxId).toArray()[0]
    return idColumns(r === undefined ? null : (text(r.kind) as MailboxKind))
  }

  /** Threads with any message in Gmail's Inbox: the open conversations a resync re-reads. */
  openThreadIds(mailboxId: string): string[] {
    return this.sql
      .exec(
        `SELECT DISTINCT c.gmail_thread_id AS t FROM conversation c
           JOIN message m ON m.conversation_id = c.id
          WHERE c.mailbox_id = ?1 AND c.gmail_thread_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM json_each(m.labels) WHERE value = ?2)
          ORDER BY c.rowid`,
        mailboxId,
        LABEL.inbox,
      )
      .toArray()
      .map((r) => text(r.t))
  }

  /** The newest message held, by Gmail's own time. A resync starts a day before it. */
  newestMessageAt(mailboxId: string): string | null {
    return textOrNull(
      this.sql
        .exec(`SELECT max(sent_at) AS t FROM message WHERE mailbox_id = ?1 AND gmail_id IS NOT NULL`, mailboxId)
        .one().t,
    )
  }

  /**
   * Which attachment of which message `index` names, from what the store holds: the attachments are kept in the order the message lists them
   * (parse.ts, `attachmentParts`; cloudflare/parse.ts for mail Cloudflare delivered), so the index is a place in that list.
   *
   * A Gmail message (`gmailId`) is then asked of Gmail, and the part at that place is checked against the name and size kept here before any
   * of its bytes are fetched. A message that came through Cloudflare has no Gmail: its `rawKey` names the kept copy in the raw-mail bucket
   * (`in/<hash>` for mail that arrived, `out/<id>` for mail the inbox sent, whose files are kept beside it as `out/<id>/<n>`), and
   * `direction` says which. A draft, a note and a message marked sent by hand have neither, and so have no attachment to give; neither has an index past the end.
   */
  attachmentRef(messageId: string, index: number): Result<AttachmentRef> {
    const row = this.sql
      .exec(
        // A draft has no file to give, except the picture a Telegram draft carries: its card shows it, to the owner alone (the kept-file read refuses Claude's token).
        `SELECT mailbox_id, gmail_id, raw_key, direction, attachments FROM message
          WHERE id = ?1 AND (status NOT IN ${PENDING} OR (direction = 'out' AND raw_key LIKE 'tg/%'))`,
        messageId,
      )
      .toArray()[0]
    const gmailId = row ? textOrNull(row.gmail_id) : null
    const rawKey = row ? textOrNull(row.raw_key) : null
    if (!row || (gmailId === null && rawKey === null)) return fail(404, 'No such attachment.')
    const attachment = jsonArray<AttachmentInfo>(row.attachments)[index]
    if (!attachment) return fail(404, 'No such attachment.')
    return ok({
      mailboxId: textOrNull(row.mailbox_id),
      gmailId,
      rawKey,
      direction: text(row.direction) === 'out' ? 'out' : 'in',
      attachment,
    })
  }

  // ─── applying what Gmail said ────────────────────────────────────────

  /**
   * One page of history, applied in ONE transaction: the messages fetched for it,
   * the label changes it named, and the cursor. The cursor moves only here, so it
   * cannot move past a page that was not stored.
   *
   * `notify` says whether each message the page stores for the first time is put to
   * the notification rule, after the page's label changes are applied (so a message
   * read in Gmail within the same page makes no sound): true for the history sync (a
   * push's, or the daily pass's) and for the thread read before Close or Send when
   * CLAUDE is acting, since the owner is not looking then; false for the thread read before
   * the owner's own Read, Close or Send, which happens while they are looking at that
   * conversation. The fill and the resync go through `applyJobStep` and never notify.
   * A message is stored once by its Gmail id, so a push delivered twice or a page read
   * again decides nothing twice.
   */
  applyHistoryPage(input: {
    mailboxId: string
    messages: ParsedMessage[]
    deltas: LabelDelta[]
    cursor: string | null
    notify: boolean
  }): { counts: IngestCounts; labelsChanged: number; owed: number } {
    return this.ports.transaction(() => {
      const fresh: StoredMessage[] = []
      const counts = this.ingest(input.mailboxId, input.messages, fresh)
      let labelsChanged = 0
      for (const delta of input.deltas) labelsChanged += this.applyDelta(input.mailboxId, delta)
      if (input.cursor !== null) {
        this.sql.exec(`UPDATE mailbox SET history_id = ?2 WHERE id = ?1`, input.mailboxId, input.cursor)
      }
      const owed = input.notify ? this.markOwed(fresh) : 0
      return { counts, labelsChanged, owed }
    })
  }

  // ─── notifications ───────────────────────────────────────────────────

  /**
   * Put each message the sync has just stored to the notification rule (src/notify/rule.ts) and mark the ones it
   * passes as owed. The rule's inputs are read as the rest of the inbox reads them: the labels as stored now, Bulk as
   * the queue judges the conversation, and the sender as the contact page judges the contact. Answers how many are owed.
   */
  protected markOwed(fresh: StoredMessage[]): number {
    if (fresh.length === 0) return 0
    const own = this.ownAddresses()
    const now = this.ports.now()
    // Counting every contact's conversations is the one costly read; it is made once a page, and only when asked.
    let counts: ReturnType<MailStore['bulkByContact']> | null = null
    let owed = 0
    for (const m of fresh) {
      const r = this.sql.exec(`${NOTIFY_SELECT} WHERE m.id = ?1`, m.id).one()
      const decision = notifyDecision({
        labels: jsonArray<string>(r.labels),
        from: m.from,
        own,
        receivedAt: text(r.at),
        now,
        conversation: () => this.bulkFacts(text(r.conversation_id)),
        sender: () => {
          counts ??= this.bulkByContact()
          return this.contactSender(text(r.contact_id), text(r.name), clientIdOf(r.client_id), counts)
        },
      })
      if (!decision.notify) continue
      this.sql.exec(`UPDATE message SET notify = 'owed' WHERE id = ?1`, m.id)
      owed += 1
    }
    return owed
  }

  /**
   * Put one message Cloudflare delivered to the notification rule (src/notify/rule.ts), and mark it owed when it passes. The one
   * place for every Cloudflare notification, asked once per message when its Inbox-or-Bulk question is settled: right after it
   * is filed when no judgment is owed on it, and after the spam classifier has answered or failed when one was (src/cloudflare/arrivals.ts). Bulk
   * is the queue's rule over what is stored now, so the message's own score is in it. A message is marked once (a second call
   * finds it marked). Answers whether it was marked.
   */
  markFiledNotification(messageId: string): boolean {
    const r = this.sql.exec(`${NOTIFY_SELECT} WHERE m.id = ?1`, messageId).toArray()[0]
    if (!r) return false
    const sender = this.cloudflareSenderOf(text(r.conversation_id))
    if (!sender) return false
    const state = this.conversationState(text(r.conversation_id))
    const decision = cloudflareNotifyDecision({
      bulk: isBulk(this.bulkFacts(text(r.conversation_id))),
      own: belongsToMailbox(sender, text(r.address).toLowerCase()),
      open: state.open,
      unread: state.unread,
      receivedAt: text(r.at),
      now: this.ports.now(),
    })
    if (!decision.notify) return false
    return (
      this.sql.exec(`UPDATE message SET notify = 'owed' WHERE id = ?1 AND notify IS NULL`, messageId).rowsWritten > 0
    )
  }

  /**
   * The notifications owed, oldest first: what each carries (the sender's contact name and address, the subject) and
   * when Gmail received the message, which is what the hour is counted from.
   */
  owedNotifications(): OwedNotification[] {
    return this.sql
      .exec(`${NOTIFY_SELECT} WHERE m.notify = 'owed' ORDER BY m.rowid`)
      .toArray()
      .map((r) => ({
        messageId: text(r.id),
        conversationId: text(r.conversation_id),
        // In a Telegram group the title says who wrote it and where ("Dana in Founders").
        name:
          r.telegram_kind === 'group' && typeof r.chat_contact_name === 'string'
            ? `${text(r.name)} in ${r.chat_contact_name}`
            : text(r.name),
        address: text(r.address),
        // A Telegram message has no subject: the notification says there is a message and from whom, and a tap opens the person the way the space keys them (the first email the contact has,
        // else `mail:<contact id>`: packages/space/src/conversations.ts `personRow`), never the Telegram user id the identity holds.
        subject: r.mailbox_kind === 'telegram' ? TELEGRAM_NOTIFICATION_BODY : text(r.subject),
        receivedAt: text(r.at),
        ...(typeof r.cf_mailbox === 'string' && { mailbox: r.cf_mailbox }),
        // A group is opened by its own contact (the sender's page is not the group's row), which has no email address.
        ...(r.mailbox_kind === 'telegram' && {
          person:
            r.telegram_kind === 'group' && typeof r.chat_contact_id === 'string'
              ? `mail:${r.chat_contact_id}`
              : (textOrNull(r.contact_email) ?? `mail:${text(r.contact_id)}`),
        }),
      }))
  }

  /** An owed notification was sent to every device, or dropped. Only an owed one changes. */
  markNotified(messageId: string, outcome: 'sent' | 'dropped'): void {
    this.sql.exec(
      `UPDATE message SET notify = ?2, notified_at = ?3 WHERE id = ?1 AND notify = 'owed'`,
      messageId,
      outcome,
      this.now(),
    )
  }

  /**
   * The notifications that stopped being owed since `since` (ISO): sent, and dropped (past the hour, or nowhere to go).
   * The first week's comparison (packages/inbox/docs/runbooks/inbox-notifications.md) reads these against the mail that arrived.
   */
  notifiedSince(since: string, scope: MailScope = ALL_MAIL): { sent: number; dropped: number } {
    // Counted over the mail the scope may see, so a person's week is theirs.
    const on = scopeWhere(scope, MESSAGE_MAILBOX('message', 'cv'), 2)
    const r = this.sql
      .exec(
        `SELECT count(*) FILTER (WHERE notify = 'sent') AS sent, count(*) FILTER (WHERE notify = 'dropped') AS dropped
           FROM message LEFT JOIN conversation cv ON cv.id = message.conversation_id WHERE notified_at >= ?1 AND ${on.sql}`,
        since,
        ...on.bindings,
      )
      .one()
    return { sent: Number(r.sent ?? 0), dropped: Number(r.dropped ?? 0) }
  }

  /** The devices, oldest first, as Settings shows them: never their keys. With a person, only theirs (`DeviceWithKeys.owner`); without, every one (the store's own reads). */
  listDevices(person?: string): Device[] {
    return this.deviceRows()
      .filter((d) => person === undefined || d.owner === personKey(person))
      .map(({ p256dh: _key, auth: _auth, owner: _owner, ...device }) => device)
  }

  /** Every device with the two keys a notification is encrypted to. For the notifications module only; no route reaches it. */
  deviceKeys(): DeviceWithKeys[] {
    return this.deviceRows()
  }

  /** One device with its keys, for the test notification. */
  deviceWithKeys(id: string): DeviceWithKeys | null {
    return this.deviceRows(id)[0] ?? null
  }

  /** The one read of the device table: every device, oldest first, or the one with this id. */
  private deviceRows(id: string | null = null): DeviceWithKeys[] {
    return this.sql
      .exec(`SELECT d.* FROM device d WHERE ?1 IS NULL OR d.id = ?1 ORDER BY d.added_at, d.rowid`, id)
      .toArray()
      .map((r) => ({
        ...deviceFrom(r),
        p256dh: text(r.p256dh),
        auth: text(r.auth),
        owner: deviceOwnerOf(text(r.added_by), this.owner.team, this.owner.email),
      }))
  }

  /**
   * The owner turned notifications on in a browser: added, or updated when this push address is already a device (turning
   * them on again in the same browser, with new keys after the key was replaced). Its failure is cleared, since the keys
   * it failed with are gone. Never the agent's (the route refuses it too). Audited without the keys or the address.
   */
  addDevice(input: { endpoint: string; p256dh: string; auth: string; label: string }, actor: string): Result<Device> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.owner.name))
    return this.ports.transaction(() => {
      const at = this.now()
      const held = this.sql.exec(`SELECT id FROM device WHERE endpoint = ?1`, input.endpoint).toArray()[0]
      const id = held ? text(held.id) : this.ports.newId()
      this.sql.exec(
        `INSERT INTO device (id, endpoint, p256dh, auth, label, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
             added_at = excluded.added_at, added_by = excluded.added_by, last_failed_at = NULL, last_failure = NULL,
             last_outcome = NULL`,
        id,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.label,
        at,
        actor,
      )
      const device = this.listDevices().find((d) => d.id === id) as Device
      this.audit(actor, held ? 'device.renew' : 'device.add', `device:${id}`, null, { label: device.label })
      return ok(device)
    })
  }

  /** The owner removes a device, from this device or any other (a lost phone). Never the agent's. Audited. */
  removeDevice(id: string, actor: string): Result<{ id: string }> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.owner.name))
    return this.ports.transaction(() => {
      const row = this.sql.exec(`SELECT * FROM device WHERE id = ?1`, id).toArray()[0]
      // A device is its person's: someone else's is not told apart from one that is not there.
      if (!row || deviceOwnerOf(text(row.added_by), this.owner.team, this.owner.email) !== personKey(actor))
        return fail(404, 'No such device.')
      this.sql.exec(`DELETE FROM device WHERE id = ?1`, id)
      this.audit(actor, 'device.remove', `device:${id}`, { label: text(row.label) }, null)
      return ok({ id })
    })
  }

  /**
   * What the push service said to one request, on the device (src/notify/deliver.ts reads the answer): a delivery is
   * stamped; a device the push service says is gone is deleted, and the audit says it went and why; anything else is
   * stamped as its last failure. Nothing is retried.
   */
  recordDelivery(deviceId: string, outcome: DeliveryOutcome, detail: string): void {
    this.ports.transaction(() => {
      const at = this.now()
      if (outcome === 'delivered') {
        this.sql.exec(`UPDATE device SET last_delivered_at = ?2, delivered = delivered + 1 WHERE id = ?1`, deviceId, at)
        return
      }
      if (outcome === 'gone') {
        const row = this.sql.exec(`SELECT label FROM device WHERE id = ?1`, deviceId).toArray()[0]
        if (!row) return
        this.sql.exec(`DELETE FROM device WHERE id = ?1`, deviceId)
        this.audit(PUSH_SERVICE_ACTOR, 'device.gone', `device:${deviceId}`, { label: text(row.label) }, { detail })
        return
      }
      this.sql.exec(
        `UPDATE device SET last_failed_at = ?2, last_failure = ?3, last_outcome = ?4, failed = failed + 1 WHERE id = ?1`,
        deviceId,
        at,
        brief(detail),
        outcome,
      )
    })
  }

  /**
   * One step of a fill or a resync, in one transaction: store what was listed,
   * set the labels that were re-read, and either save the job's progress or, when
   * `job` is null, complete it: the cursor becomes the history id read before the
   * job began, and a sync is owed to pick up whatever arrived meanwhile.
   */
  applyJobStep(input: {
    mailboxId: string
    kind: SyncJob['kind']
    cursorAfter: string
    messages: ParsedMessage[]
    labels: { gmailId: string; labels: string[] }[]
    job: SyncJob | null
  }): IngestCounts {
    return this.ports.transaction(() => {
      const counts = this.ingest(input.mailboxId, input.messages)
      for (const l of input.labels) this.setLabels(input.mailboxId, l.gmailId, l.labels)
      if (input.job) {
        this.sql.exec(`UPDATE mailbox SET job = ?2 WHERE id = ?1`, input.mailboxId, JSON.stringify(input.job))
        return counts
      }
      const at = this.now()
      this.sql.exec(
        `UPDATE mailbox SET job = NULL, history_id = ?2, push_seq = push_seq + 1,
                last_resync_at = CASE WHEN ?3 = 'resync' THEN ?4 ELSE last_resync_at END
          WHERE id = ?1`,
        input.mailboxId,
        input.cursorAfter,
        input.kind,
        at,
      )
      this.audit(
        GMAIL_ACTOR,
        input.kind === 'fill' ? 'mailbox.fill-complete' : 'mailbox.resync-complete',
        `mailbox:${input.mailboxId}`,
        null,
        { cursor: input.cursorAfter },
      )
      return counts
    })
  }

  /** Begin a resync because the cursor went stale. The cursor itself is left alone until it completes. */
  startResync(mailboxId: string, job: SyncJob, reason: string): void {
    this.ports.transaction(() => {
      this.sql.exec(`UPDATE mailbox SET job = ?2 WHERE id = ?1`, mailboxId, JSON.stringify(job))
      this.audit(GMAIL_ACTOR, 'mailbox.resync-start', `mailbox:${mailboxId}`, null, { reason, query: job.query })
    })
  }

  /** Begin a fill for a mailbox that has none (a connected row with no cursor and no job). */
  startFill(mailboxId: string, job: SyncJob): void {
    this.sql.exec(`UPDATE mailbox SET job = ?2 WHERE id = ?1`, mailboxId, JSON.stringify(job))
  }

  /**
   * Write a message's labels and keep its stamps true to them, answering whether
   * anything changed. THE ONLY PLACE a message's labels are written.
   *
   * A message with UNREAD has no read stamp; one without has one, and a stamp that
   * is already there is KEPT, so the person who read it stays on it when Gmail's
   * echo of the same change arrives. The same for INBOX and the closed stamp. The
   * comparison is of the sorted JSON, so writing the labels a message already has
   * is not a change and touches nothing.
   */
  protected writeLabels(messageId: string, labels: Iterable<string>, actor: string): boolean {
    const set = new Set(labels)
    const next = sortedLabels(set)
    return (
      this.sql.exec(
        `UPDATE message SET labels = ?2, updated_at = ?3, updated_by = ?4,
                read_at = CASE WHEN ?5 = 1 THEN NULL ELSE coalesce(read_at, ?3) END,
                read_by = CASE WHEN ?5 = 1 THEN NULL ELSE coalesce(read_by, ?4) END,
                closed_at = CASE WHEN ?6 = 1 THEN NULL ELSE coalesce(closed_at, ?3) END,
                closed_by = CASE WHEN ?6 = 1 THEN NULL ELSE coalesce(closed_by, ?4) END
          WHERE id = ?1 AND labels != ?2`,
        messageId,
        next,
        this.now(),
        actor,
        set.has(LABEL.unread) ? 1 : 0,
        set.has(LABEL.inbox) ? 1 : 0,
      ).rowsWritten > 0
    )
  }

  /** Replace a message's labels outright (a thread re-read). A message not held is ignored. */
  protected setLabels(mailboxId: string, gmailId: string, labels: string[]): void {
    const row = this.sql
      .exec(
        `SELECT id FROM message WHERE mailbox_id = ?1 AND ${this.idColumnsOf(mailboxId).message} = ?2`,
        mailboxId,
        gmailId,
      )
      .toArray()[0]
    if (row) this.writeLabels(text(row.id), labels, this.actorOf(mailboxId))
  }

  /** Who a change the server told the inbox of is stamped as: the JMAP mailbox's, or Gmail's. */
  protected actorOf(mailboxId: string): string {
    const r = this.sql.exec(`SELECT kind FROM mailbox WHERE id = ?1`, mailboxId).toArray()[0]
    return serverActorOf(r === undefined ? null : (text(r.kind) as MailboxKind))
  }

  /** Apply one label event to a held message. Answers 1 when it changed something. */
  private applyDelta(mailboxId: string, delta: LabelDelta): number {
    const row = this.sql
      .exec(`SELECT id, labels FROM message WHERE mailbox_id = ?1 AND gmail_id = ?2`, mailboxId, delta.gmailId)
      .toArray()[0]
    if (!row) return 0
    const labels = new Set(jsonArray<string>(row.labels))
    for (const l of delta.add) labels.add(l)
    for (const l of delta.remove) labels.delete(l)
    return this.writeLabels(text(row.id), labels, GMAIL_ACTOR) ? 1 : 0
  }

  // ─── read and closed, as the inbox changes them ────────────────────────

  /**
   * What a person's change to a conversation needs, worked out BEFORE anything is
   * asked of Gmail: the Gmail thread to change (null for a manual conversation,
   * which has no Gmail side), and whether the change is needed at all. A conversation
   * already read, already closed or already open needs nothing, and so costs no
   * Gmail call: opening one that is read must not spend a request, and a double
   * press must not send two.
   *
   * ── IT REFUSES WHAT THE PERSON WAS NOT SHOWN ─────────────────────────────
   * Read and close act on the whole thread in Gmail, so a message that arrived after
   * the page was loaded would be marked read, or archived, unseen. `through` is how
   * far into the conversation the page reached (Inbox.newestPosition). When
   * something inbound the change would affect (unread, for a read; in the Inbox, for a
   * close) has been stored beyond it, the answer is a 409, and nothing is changed
   * anywhere. An email conversation with no `through` is a 422, so no caller
   * can leave the check out; a manual conversation has no Gmail thread and needs none.
   *
   * An email conversation with no thread id is refused (409): there is nothing in
   * Gmail to change, and changing only the inbox would be the two disagreeing
   * because of the inbox. A reopen needs a message that can go back to the Inbox.
   */
  planConversationChange(
    conversationId: string,
    change: ConversationChange,
    through: number | null,
  ): Result<{ threadId: string | null; needed: boolean }> {
    const conversation = this.sql
      .exec(`SELECT mailbox_id, gmail_thread_id, jmap_thread_id FROM conversation WHERE id = ?1`, conversationId)
      .toArray()[0]
    if (!conversation) return fail(404, 'No such conversation.')
    const state = this.conversationState(conversationId)
    const needed = change === 'read' ? state.unread : change === 'close' ? state.open : !state.open
    if (conversation.mailbox_id === null) return ok({ threadId: null, needed })
    // Cloudflare's and Telegram's conversations have no server thread: the inbox's own stamps are the whole state, and Telegram's own folders and read marks are not written.
    const kind = this.mailboxKindOf(conversationId)
    if (kind === 'cloudflare' || kind === 'telegram')
      return this.planStampChange(conversationId, change, through, needed)

    // Gmail's and JMAP's: the server's labels are the truth, and the change is made on the server's thread first.
    const threadId = textOrNull(conversation[idColumns(kind).thread])
    if (threadId === null) {
      return fail(409, `This conversation has no thread ${whereHeldWords(kind)}, so it cannot be changed there.`)
    }
    if (change !== 'reopen') {
      if (through === null) return fail(422, 'Say how far into the conversation you have read (through).')
      const reached = this.checkThrough(conversationId, through)
      if (!reached.ok) return reached
      if (this.arrivedAfter(conversationId, through, change === 'read' ? LABEL.unread : LABEL.inbox)) {
        return fail(409, 'A new message arrived on this conversation, so nothing was changed. It is shown now.')
      }
    } else if (needed && !this.hasMessageThatCanReturn(conversationId)) {
      return fail(409, 'Everything in this conversation is in the trash or spam, so nothing can go back to the Inbox.')
    }
    return ok({ threadId, needed })
  }

  /**
   * A change to a conversation in a Cloudflare mailbox: there is no Gmail thread (null), the stamps are the whole state, and
   * the same refusal of what the person was not shown applies as for Gmail mail. A read or a close names how far into the
   * conversation the page reached (`through`), and is refused (409, nothing changed) when something inbound the change
   * would affect has been stored beyond it: unread, for a read; still open, for a close. Without it that is a 422, so no
   * caller can leave the check out. A manual conversation needs none, since everything on it is something the owner filed themselves.
   */
  private planStampChange(
    conversationId: string,
    change: ConversationChange,
    through: number | null,
    needed: boolean,
  ): Result<{ threadId: string | null; needed: boolean }> {
    if (change !== 'reopen') {
      if (through === null) return fail(422, 'Say how far into the conversation you have read (through).')
      const reached = this.checkThrough(conversationId, through)
      if (!reached.ok) return reached
      const stamp = change === 'read' ? 'read_at' : 'closed_at'
      const beyond = this.sql
        .exec(
          `SELECT 1 FROM message
            WHERE conversation_id = ?1 AND direction = 'in' AND status NOT IN ${PENDING} AND rowid > ?2 AND ${stamp} IS NULL
            LIMIT 1`,
          conversationId,
          through,
        )
        .toArray()[0]
      if (beyond) {
        return fail(409, 'A new message arrived on this conversation, so nothing was changed. It is shown now.')
      }
    }
    return ok({ threadId: null, needed })
  }

  /**
   * Whether an inbound Gmail message is stored beyond `through` that the change would
   * affect: one that is unread, for a read, or in the Inbox, for a close. A message
   * the change would leave as it is (an old one, archived and read, that the inbox only
   * now heard of because it predates the first fill) is not a reason to refuse. One
   * in the trash, spam or drafts is not in play.
   */
  private arrivedAfter(conversationId: string, through: number, affected: string): boolean {
    return this.sql
      .exec(
        `SELECT labels FROM message
          WHERE conversation_id = ?1 AND direction = 'in' AND ${heldOnServer()} AND rowid > ?2`,
        conversationId,
        through,
      )
      .toArray()
      .some((m) => {
        const labels = jsonArray<string>(m.labels)
        return inPlay(labels) && labels.includes(affected)
      })
  }

  private hasMessageThatCanReturn(conversationId: string): boolean {
    return this.sql
      .exec(`SELECT labels FROM message WHERE conversation_id = ?1 AND ${heldOnServer()}`, conversationId)
      .toArray()
      .some((m) => inPlay(jsonArray<string>(m.labels)))
  }

  /**
   * Do the change here. For an email conversation the Mailroom has ALREADY had
   * Gmail make it (Gmail first, as a send is), so this applies the same change to
   * every Gmail message held in the conversation, the way Gmail applied it to the
   * thread, and stamps the actor. Idempotent: a state already reached changes
   * nothing and writes no audit entry.
   *
   * For a manual conversation there is no Gmail, and the stamps ARE the state.
   */
  applyConversationChange(
    conversationId: string,
    change: ConversationChange,
    actor: string,
  ): Result<ConversationState> {
    return this.ports.transaction(() => {
      const conversation = this.sql
        .exec(`SELECT mailbox_id FROM conversation WHERE id = ?1`, conversationId)
        .toArray()[0]
      if (!conversation) return fail(404, 'No such conversation.')
      const before = this.conversationState(conversationId)
      const kind = this.mailboxKindOf(conversationId)
      // The owner opening a Telegram conversation in the space marks it read in Telegram too, up to exactly the newest message this read stamps (worked out BEFORE the stamps are written). Only
      // the owner's read owes it: Claude's script has no read, and its actor is not the owner's.
      const owedToTelegram =
        kind === 'telegram' && change === 'read' && actor === this.owner.email
          ? this.telegramReadToOwe(conversationId)
          : null
      if (labelsAreTruth(kind)) this.relabelThread(conversationId, change, actor, sentIsAFolder(kind))
      else this.stampManual(conversationId, change, actor)
      if (owedToTelegram) this.oweTelegramRead(owedToTelegram.chatId, owedToTelegram.upTo, actor)
      const after = this.conversationState(conversationId)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.audit(actor, `conversation.${change}`, `conversation:${conversationId}`, before, after)
      }
      return ok(after)
    })
  }

  /** The label change a person's request is, applied to every Gmail message held in the conversation. */
  private relabelThread(conversationId: string, change: ConversationChange, actor: string, onMailServer = false): void {
    const messages = this.sql
      .exec(`SELECT id, labels FROM message WHERE conversation_id = ?1 AND ${heldOnServer()}`, conversationId)
      .toArray()
    for (const m of messages) {
      const labels = new Set(jsonArray<string>(m.labels))
      if (change === 'read') labels.delete(LABEL.unread)
      else if (change === 'close') labels.delete(LABEL.inbox)
      // Back to the Inbox is for what is in play: a message in the trash or spam
      // stays out of it, as it does in Gmail (the Gmail module does the same). On the mail server a message the mailbox sent
      // stays in Sent, which is a folder of its own and not a label (the JMAP module moves nothing out of it).
      else if (inPlay(labels) && !(onMailServer && labels.has(LABEL.sent))) labels.add(LABEL.inbox)
      this.writeLabels(text(m.id), labels, actor)
    }
  }

  /** The same three changes on a conversation with no Gmail side, where the stamps are all there is. */
  private stampManual(conversationId: string, change: ConversationChange, actor: string): void {
    const at = this.now()
    if (change === 'reopen') {
      this.sql.exec(
        `UPDATE message SET closed_at = NULL, closed_by = NULL, updated_at = ?2, updated_by = ?3
          WHERE conversation_id = ?1 AND status NOT IN ${PENDING} AND closed_at IS NOT NULL`,
        conversationId,
        at,
        actor,
      )
      return
    }
    const column = change === 'read' ? 'read' : 'closed'
    this.sql.exec(
      `UPDATE message SET ${column}_at = ?2, ${column}_by = ?3, updated_at = ?2, updated_by = ?3
        WHERE conversation_id = ?1 AND status NOT IN ${PENDING} AND ${column}_at IS NULL`,
      conversationId,
      at,
      actor,
    )
  }

  // ─── a newer update of a calendar event replaces the older ones ──────

  /**
   * The open conversations that a newer conversation about the SAME calendar event has replaced, oldest first within an
   * event. Google Calendar mails every update of a meeting as a thread of its own (its subject carries the time), so the space showed one
   * meeting several times. The event is `message.event_key` (src/calendar-event.ts); within one mailbox, the conversation whose event mail
   * is newest is the one that stays, and each of the others is listed here when ALL of these hold:
   *   - it is open (an archived one is already out of the way);
   *   - nothing in it is the owner's: no reply, no draft (a message of theirs is `out`);
   *   - every message in it is event mail (a person's reply in the thread has no event key, and a conversation with a person in it stays);
   *   - it was not reopened after this sweep closed it (a reopened one stays open: `replaceable`).
   * The one that stays is picked among messages in play only: mail in Spam or the Trash, or that the spam classifier judged unsolicited, replaces nothing.
   * Nothing is changed here. A Gmail conversation is closed by the Mailroom, which has Gmail close the thread first; a Cloudflare one is
   * closed by `closeSupersededLocal`. A cancellation is event mail like an update: it replaces the older ones and is itself replaced by a later update.
   * `through` is how far into the conversation to close (as a person's Close names it), so a message that arrives meanwhile refuses the close.
   */
  supersededEvents(): Superseded[] {
    const rows = this.sql
      .exec(
        `SELECT m.conversation_id AS conversation_id, m.mailbox_id AS mailbox_id, m.event_key AS event_key,
                coalesce(m.sent_at, m.created_at) AS at, m.rowid AS pos, mb.kind AS kind
           FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
          WHERE m.event_key IS NOT NULL AND m.conversation_id IS NOT NULL
            AND m.labels NOT LIKE '%"TRASH"%' AND m.labels NOT LIKE '%"SPAM"%'
            AND (m.clef_junk IS NULL OR m.clef_junk < ${CLEF_JUNK_THRESHOLD})
            AND (m.mailbox_id, m.event_key) IN
                (SELECT mailbox_id, event_key FROM message WHERE event_key IS NOT NULL
                  GROUP BY mailbox_id, event_key HAVING count(DISTINCT conversation_id) > 1)`,
      )
      .toArray()
    // Per event: each conversation's newest event mail, then the order of those.
    type Newest = { at: string; pos: number; mailboxId: string; kind: 'gmail' | 'cloudflare' | 'jmap' }
    const events = new Map<string, Map<string, Newest>>()
    for (const r of rows) {
      const key = `${text(r.mailbox_id)}\u0000${text(r.event_key)}`
      const conversations = events.get(key) ?? new Map<string, Newest>()
      const cid = text(r.conversation_id)
      const at = text(r.at)
      const pos = Number(r.pos)
      const seen = conversations.get(cid)
      if (!seen || at > seen.at || (at === seen.at && pos > seen.pos)) {
        conversations.set(cid, {
          at,
          pos,
          mailboxId: text(r.mailbox_id),
          kind: text(r.kind) as 'gmail' | 'cloudflare' | 'jmap',
        })
      }
      events.set(key, conversations)
    }
    const out: Superseded[] = []
    for (const [key, conversations] of events) {
      const ordered = [...conversations].sort((a, b) =>
        a[1].at === b[1].at ? a[1].pos - b[1].pos : a[1].at < b[1].at ? -1 : 1,
      )
      const keeper = ordered[ordered.length - 1]
      if (!keeper) continue
      for (const [cid, facts] of ordered.slice(0, -1)) {
        if (!this.replaceable(cid)) continue
        out.push({
          conversationId: cid,
          mailboxId: facts.mailboxId,
          kind: facts.kind,
          replacedBy: keeper[0],
          eventKey: key.slice(key.indexOf('\u0000') + 1),
          through: this.newestPosition(cid),
        })
      }
    }
    return out
  }

  /**
   * Whether an older conversation of an event may be closed for a newer one: open, and nothing of the owner's or of a person in it, and not left open on
   * purpose. A conversation this sweep closed (a `conversation.replaced` entry) and that is open again was reopened, and it STAYS open if either
   *   - a person reopened it after the last such entry (a `conversation.reopen` by anyone but the calendar: the space's Reopen), or
   *   - nothing new has arrived in it since (the only way it can be open then is a reopen in Gmail itself, which leaves no entry of ours).
   * New mail in it since is another matter: that is a new update, and it is replaced like any other when a newer one comes. So an old entry does not
   * protect a thread for ever.
   */
  private replaceable(conversationId: string): boolean {
    if (!this.conversationState(conversationId).open) return false
    const other = this.sql
      .exec(
        `SELECT 1 FROM message WHERE conversation_id = ?1 AND (direction = 'out' OR (event_key IS NULL AND status NOT IN ${PENDING})) LIMIT 1`,
        conversationId,
      )
      .toArray()[0]
    if (other !== undefined) return false
    const subject = `conversation:${conversationId}`
    const last = this.sql
      .exec(
        `SELECT id, at FROM audit WHERE action = 'conversation.replaced' AND subject = ?1 ORDER BY id DESC LIMIT 1`,
        subject,
      )
      .toArray()[0]
    if (last === undefined) return true
    const reopened = this.sql
      .exec(
        `SELECT 1 FROM audit WHERE action = 'conversation.reopen' AND subject = ?1 AND actor != ?2 AND id > ?3 LIMIT 1`,
        subject,
        CALENDAR_ACTOR,
        Number(last.id),
      )
      .toArray()[0]
    if (reopened !== undefined) return false
    const newMail = this.sql
      .exec(
        `SELECT 1 FROM message WHERE conversation_id = ?1 AND created_at > ?2 LIMIT 1`,
        conversationId,
        text(last.at),
      )
      .toArray()[0]
    return newMail !== undefined
  }

  /** Say, in the audit trail, that a conversation was closed because a newer update of its event arrived. The close itself is audited by `applyConversationChange` as the calendar's. */
  noteSuperseded(s: Superseded): void {
    this.audit(CALENDAR_ACTOR, 'conversation.replaced', `conversation:${s.conversationId}`, null, {
      replacedBy: s.replacedBy,
      eventKey: s.eventKey,
    })
  }

  /**
   * Close, in the inbox alone, the replaced conversations of a Cloudflare mailbox: they have no Gmail side, so the stamps are the whole state
   * (the same change a person's Close makes). Answers how many. Gmail's are the Mailroom's, which asks Gmail first.
   */
  closeSupersededLocal(): number {
    let closed = 0
    for (const s of this.supersededEvents()) {
      if (s.kind !== 'cloudflare') continue
      this.ports.transaction(() => {
        if (this.applyConversationChange(s.conversationId, 'close', CALENDAR_ACTOR).ok) {
          this.noteSuperseded(s)
          closed += 1
        }
      })
    }
    return closed
  }

  // ─── the one-time pass over mail stored before the event key existed ──

  /**
   * Whether the one-time pass is done (a setting row says so). Whether a stored message is Google's own calendar mail turns on its `Sender` and `List-Id`
   * headers, and the store keeps neither, so the pass cannot read the stored text alone: the Mailroom reads each candidate again from Gmail
   * (`Mailroom.keyStoredCalendarMail`), which is why it is async and why it runs from the alarm. A Cloudflare mailbox's stored mail is not passed over (its
   * raw copies are in the bucket, but the pass would have to read them there, and the mail it holds is a few messages): its new mail is keyed as it is filed.
   */
  calendarPassDone(): boolean {
    return this.sql.exec(`SELECT 1 FROM setting WHERE key = ?1`, EVENT_KEYS_BACKFILLED).toArray()[0] !== undefined
  }

  /**
   * Up to `limit` stored Gmail messages of one account that the pass has not looked at and that could be calendar mail: inbound, no key and not marked
   * looked at, and the stored text has one of Google Calendar's event links (`eid=`) or the message has a calendar attachment.
   */
  calendarCandidates(mailboxId: string, limit: number): { id: string; gmailId: string }[] {
    return this.sql
      .exec(
        `SELECT id, gmail_id FROM message
          WHERE mailbox_id = ?1 AND gmail_id IS NOT NULL AND direction = 'in' AND event_key IS NULL AND event_kind IS NULL
            AND (body LIKE '%eid=%' OR attachments LIKE '%text/calendar%')
          ORDER BY rowid LIMIT ?2`,
        mailboxId,
        limit,
      )
      .toArray()
      .map((r) => ({ id: text(r.id), gmailId: text(r.gmail_id) }))
  }

  /** Record what the pass found for one message: its event, or `none` (looked at, not calendar mail) so it is not looked at again. */
  recordEventKey(messageId: string, event: { key: string; kind: string } | null): void {
    this.sql.exec(
      `UPDATE message SET event_key = ?2, event_kind = ?3 WHERE id = ?1 AND event_key IS NULL`,
      messageId,
      event?.key ?? null,
      event?.kind ?? 'none',
    )
  }

  /** The pass is done: every account with a working grant has no candidate left. Said once, in the setting and in the audit trail. */
  markCalendarPassDone(looked: number): void {
    this.ports.transaction(() => {
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'done', ?2, ?3)
         ON CONFLICT(key) DO NOTHING`,
        EVENT_KEYS_BACKFILLED,
        this.now(),
        CALENDAR_ACTOR,
      )
      this.audit(CALENDAR_ACTOR, 'message.event-keys-backfilled', `setting:${EVENT_KEYS_BACKFILLED}`, null, { looked })
    })
  }

  // ─── the one-time pass over mail stored before the calendar summary existed ──

  /**
   * Whether the one-time summary pass is done (a setting row says so). Its sibling is the event-key pass above and it is shaped the same: a stored Gmail message's calendar part was never kept, so the Mailroom reads each candidate again from Gmail
   * (`Mailroom.summariseStoredCalendarMail`) and parses it as new mail is. A business mailbox's and the mail server's stored mail is NOT passed over (as that pass decided: few such emails, and each would mean reading its whole kept copy): it shows
   * its card only if its calendar part arrives again, and keeps the chip it has.
   */
  calendarSummariesDone(): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM setting WHERE key = ?1`, CALENDAR_SUMMARIES_BACKFILLED).toArray()[0] !== undefined
    )
  }

  /**
   * Up to `limit` stored Gmail messages of one account that have no summary and have not been looked at (`calendar` NULL: a message looked at holds `none`), inbound, that could carry a calendar part: they list a calendar file (by its declared type or a name ending
   * in .ics), carry an event key, or have no words at all.
   */
  calendarSummaryCandidates(mailboxId: string, limit: number): { id: string; gmailId: string }[] {
    return this.sql
      .exec(
        `SELECT id, gmail_id FROM message
          WHERE mailbox_id = ?1 AND gmail_id IS NOT NULL AND direction = 'in' AND calendar IS NULL
            AND (attachments LIKE '%text/calendar%' OR attachments LIKE '%application/ics%' OR attachments LIKE '%.ics"%'
                 OR event_key IS NOT NULL OR trim(body) = '')
          ORDER BY rowid LIMIT ?2`,
        mailboxId,
        limit,
      )
      .toArray()
      .map((r) => ({ id: text(r.id), gmailId: text(r.gmail_id) }))
  }

  /** Record what the pass found for one message: its summary, or `none` (looked at, nothing to show) so it is never read twice. A message that already has one is left as it is. */
  recordCalendarSummary(messageId: string, summary: CalendarSummary | null): void {
    this.sql.exec(
      `UPDATE message SET calendar = ?2 WHERE id = ?1 AND calendar IS NULL`,
      messageId,
      keptCalendar(summary),
    )
  }

  /** The pass is done: every account with a working grant has no candidate left. Said once, in the setting and in the audit trail. */
  markCalendarSummariesDone(looked: number): void {
    this.ports.transaction(() => {
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, 'done', ?2, ?3)
         ON CONFLICT(key) DO NOTHING`,
        CALENDAR_SUMMARIES_BACKFILLED,
        this.now(),
        CALENDAR_ACTOR,
      )
      this.audit(
        CALENDAR_ACTOR,
        'message.calendar-summaries-backfilled',
        `setting:${CALENDAR_SUMMARIES_BACKFILLED}`,
        null,
        { looked },
      )
    })
  }

  // ─── a Gmail message becoming a row ──────────────────────────────────

  /** Store a page's messages; each one stored for the first time is added to `fresh`, when given. */
  protected ingest(mailboxId: string, messages: ParsedMessage[], fresh?: StoredMessage[]): IngestCounts {
    const counts: IngestCounts = { stored: 0, existing: 0, skipped: 0 }
    if (messages.length === 0) return counts
    const mailbox = this.sql.exec(`SELECT id, address, kind FROM mailbox WHERE id = ?1`, mailboxId).one()
    const own = text(mailbox.address).toLowerCase()
    const kind = text(mailbox.kind) as MailboxKind
    const domain = own.split('@')[1] ?? ''
    // Gmail: only the mailbox's own address is ours here. JMAP: the address and every address on its domain (the aliases info@ and postmaster@ arrive in the mailbox as the address does).
    const isOwn = domainIsOurs(kind) ? (a: string) => a === own || a.endsWith(`@${domain}`) : (a: string) => a === own
    const actor = serverActorOf(kind)
    for (const m of messages) {
      const outcome = this.ingestOne(mailboxId, own, isOwn, idColumns(kind), actor, m)
      if (typeof outcome === 'string') counts[outcome] += 1
      else {
        counts.stored += 1
        fresh?.push(outcome)
      }
    }
    return counts
  }

  /** One message: `existing`, `skipped`, or the row it was stored as. */
  private ingestOne(
    mailboxId: string,
    own: string,
    isOwn: (address: string) => boolean,
    cols: ReturnType<typeof idColumns>,
    actor: string,
    m: ParsedMessage,
  ): 'existing' | 'skipped' | StoredMessage {
    // `m.gmailId` and `m.threadId` are the SERVER's ids, whichever server it is: the columns they go in are the mailbox kind's (src/store/kinds.ts).
    const held = this.sql
      .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND ${cols.message} = ?2`, mailboxId, m.gmailId)
      .toArray()[0]
    if (held) {
      this.setLabels(mailboxId, m.gmailId, m.labels)
      return 'existing'
    }

    const thread = this.sql
      .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND ${cols.thread} = ?2`, mailboxId, m.threadId)
      .toArray()[0]
    if (!belongsInStore(m.labels, thread !== undefined)) return 'skipped'

    const at = this.now()
    const when = m.receivedAt ?? m.senderDate ?? at
    const conversationId = thread ? text(thread.id) : this.ports.newId()
    if (!thread) {
      this.sql.exec(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, ${cols.thread})
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        conversationId,
        at,
        when,
        mailboxId,
        m.threadId,
      )
    }

    // Who is on it. OUR OWN address is not a participant (it would be on every
    // conversation and make "who is this with" meaningless), unless it is the only
    // address there is, as in a note to self.
    const outbound = m.labels.includes(LABEL.sent)
    const from = emailPeople(m.from ? [m.from] : [])
    const to = emailPeople(m.to)
    const cc = emailPeople(m.cc)
    const others = (list: typeof from) => list.filter((p) => !isOwn(p.address))
    const identity = (p: (typeof from)[number]) => this.identityFor({ kind: p.kind, address: p.address }, p.name, actor)

    // The message's own identity: who it is FROM when it came in, and who it went
    // TO when we sent it (the first of To, then Cc).
    const primary =
      (outbound ? [...others(to), ...others(cc), ...others(from)] : [...from, ...others(to)])[0] ??
      from[0] ??
      to[0] ??
      cc[0] ??
      ({ kind: 'email', address: own, name: '' } as const)
    const primaryIdentity = identity(primary)

    const people: { who: (typeof from)[number]; role: 'from' | 'to' | 'cc' }[] = [
      ...others(from).map((who) => ({ who, role: 'from' as const })),
      ...others(to).map((who) => ({ who, role: 'to' as const })),
      ...others(cc).map((who) => ({ who, role: 'cc' as const })),
    ]
    if (people.length === 0) people.push({ who: primary, role: outbound ? 'to' : 'from' })
    for (const { who, role } of people) {
      this.sql.exec(
        `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, ?3)`,
        conversationId,
        identity(who).id,
        role,
      )
    }

    const messageId = this.ports.newId()
    this.sql.exec(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, subject, body, why,
                            created_at, created_by, updated_at, updated_by, sent_at, sent_by, source_ref,
                            mailbox_id, ${cols.message}, rfc_message_id, in_reply_to, from_header, to_header, cc_header,
                            sender_date, snippet, body_truncated, attachments, labels, list_unsubscribe,
                            read_at, read_by, closed_at, closed_by, reply_to_header, event_key, event_kind, calendar)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?8, ?9, ?10, ?9, NULL,
               ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
               CASE WHEN ?24 = 1 THEN NULL ELSE ?8 END, CASE WHEN ?24 = 1 THEN NULL ELSE ?9 END,
               CASE WHEN ?25 = 1 THEN NULL ELSE ?8 END, CASE WHEN ?25 = 1 THEN NULL ELSE ?9 END, ?26, ?27, ?28, ?29)`,
      messageId,
      conversationId,
      primaryIdentity.id,
      outbound ? 'out' : 'in',
      RECEIVED_STATUS,
      m.subject,
      m.body === '' ? m.snippet : m.body,
      at,
      actor,
      when,
      mailboxId,
      m.gmailId,
      m.rfcMessageId,
      m.inReplyTo,
      m.fromHeader,
      m.toHeader,
      m.ccHeader,
      m.senderDate,
      m.snippet,
      m.bodyTruncated ? 1 : 0,
      JSON.stringify(m.attachments),
      sortedLabels(m.labels),
      m.listUnsubscribe ? 1 : 0,
      m.labels.includes(LABEL.unread) ? 1 : 0,
      m.labels.includes(LABEL.inbox) ? 1 : 0,
      m.replyToHeader,
      m.event?.key ?? null,
      m.event?.kind ?? null,
      keptCalendar(m.calendar),
    )
    this.touchConversation(conversationId)
    return { id: messageId, from: from[0]?.address ?? null }
  }

  // ─── sending ─────────────────────────────────────────────────────────

  /**
   * THE SEND, IN THREE STEPS THAT THE MAILROOM RUNS IN ORDER (gmail/mailroom.ts,
   * `sendDraft`): `planSend` reads and checks, `claimSend` moves the draft to
   * `sending`, and `fileSentMessage` records what Gmail made. Nothing in here talks to
   * Gmail; the order around the network call is the Mailroom's.
   *
   * ── WHAT MAKES A DOUBLE SEND IMPOSSIBLE ──────────────────────────────────
   * The claim is ONE conditional write: draft to sending, only while the row is still
   * a draft, still an outbound message with no Gmail id, and still at the revision
   * the press named. A second press (a double click, a retried request, another tab)
   * finds `sending` or `sent` and is refused. The Mailroom runs all three steps
   * inside its `exclusive`, so no sync can store the message Gmail has just made
   * between Gmail accepting it and `fileSentMessage` recording it. The status is checked
   * with the DIRECTION, because mail that came in is also stored as `sent`.
   *
   * ── WHAT IT REFUSES, AND WHY EACH IS A REFUSAL ───────────────────────────
   * Only the owner sends, and Claude on their instruction (below); nobody else (403). Only a
   * draft that is an email, at the revision named
   * (409 if it was edited since it was shown). A subject and a body, no em dash in
   * either (the owner's mail must not read as machine-written, and a draft from before
   * this check, or one carried from the Outbox, is caught here too). Recipients that
   * are printable-ASCII bare addresses, none of them ours, no repeats, at most
   * INBOX_MOST_RECIPIENTS. A reply is refused (409) when something has come in on the
   * conversation since the page was shown (`through`, as Close is): a reply
   * must not go out over a message its author has not read.
   *
   * ── CLAUDE SENDS ON THE OWNER'S WORD, UNDER THE SAME RULES ───────────────
   * Everything above applies to Claude's send unchanged: the same claim, the same revision
   * and `through` (which Claude's script passes back from what it read and never looks up),
   * the same recipients, em dash refusal, own-address refusal and exclusive. On top of
   * them, FIRST, before the draft is even looked at, the agent must clear two gates: the
   * switch is on (off by default, and only the owner flips it) and the send carries the owner's
   * instruction. Either missing is a 403 that changes nothing. It sends a stored draft by
   * id and never text of its own, so the exact message is on record before it leaves.
   * `claimSend` checks the switch again, because the owner can flip it while Gmail is being
   * asked about the thread. A reply is also refused to Claude when a message has arrived on
   * the conversation AFTER the instruction (`threadFor`): "send it" was said about a draft
   * written without that message, so Claude goes back to the owner rather than sending again
   * with the same words.
   *
   * It writes nothing. The recipients are the draft's own address and Cc, which were
   * written into the draft and shown on it; there is no Bcc and no other source.
   */
  planSend(id: string, input: SendRequest, actor: string, attaching: PictureFacts | null = null): Result<SendPlan> {
    let instruction: SendInstruction | null = null
    if (isAgent(actor)) {
      if (!this.claudeMaySend()) return fail(403, claudeSendingOff(this.owner.name))
      const heard = this.checkInstruction(input.instruction)
      if (!heard.ok) return heard
      instruction = heard.value
    } else if (actor !== this.owner.email && !this.isTeam(actor)) {
      return fail(403, onlyOwnerOrClaudeSends(this.owner.name))
    }
    const msg = this.message(id)
    if (!msg) return fail(404, 'No such message.')
    // A send goes out only from a mailbox the sender is on (Claude's is the owner's): a person of the install is let send, and only from theirs. Checked here, where every route to a send passes, as the rest of the rule is.
    if (!canSee(this.mailScope(actor), this.sendingMailboxOf(msg))) return fail(403, notOnThatMailbox())
    const via = this.sendVia(msg)
    if (via.kind === 'telegram') return this.planTelegramSend(msg, via.chat, input, instruction, attaching)
    // A picture goes on Telegram only: any other transport that is handed one (it never is: the Mailroom refuses files there first) sends nothing.
    if (attaching !== null) return fail(422, 'A picture goes out on Telegram only. Nothing was sent.')
    const sendable = this.checkSendable(msg, input.rev)
    if (!sendable.ok) return sendable
    // For Claude: the draft is the one the owner agreed to. Their instruction covers it as it stood, so a draft anybody but Claude
    // changed after they gave it, or whose recipients Claude changed, is refused, like a reply that arrived: go back to them.
    const voided = instruction === null ? null : this.instructionVoidedBy(msg, instruction.at)
    if (voided !== null) return fail(409, voided)
    // Ours, for the recipients: the owner's own mail never goes to an address of theirs or of a mailbox's; a business mailbox's goes to anyone
    // but its own address and its domain's, the owner's Gmail address included (it is a person who writes to the business, and the
    // reply from the mailbox's address to it is how the path is proved).
    const recipients = this.checkRecipients(msg, via.kind === 'gmail' ? null : via.sender)
    if (!recipients.ok) return recipients

    const facts = { msg, input, instruction, recipients: recipients.value }
    if (via.kind === 'jmap') return this.planJmapSend(facts, via.sender)
    if (via.kind === 'cloudflare') return this.planCloudflareSend(facts, via.sender)
    return this.planGmailSend(facts, via.mailboxId)
  }

  /** A send through the mail server: refused while it refuses the space's key; otherwise into the server's thread, under a Message-ID of the inbox's own. */
  private planJmapSend(f: SendFacts, sender: CloudflareSender): Result<SendPlan> {
    const mailbox = this.sql.exec(`SELECT grant_lapsed_at FROM mailbox WHERE id = ?1`, sender.id).toArray()[0]
    if (mailbox && mailbox.grant_lapsed_at !== null) {
      return fail(
        503,
        `The mail server refused the space’s key for ${sender.address}, so nothing was sent. The draft is unchanged.`,
      )
    }
    const thread = this.threadFor(f.msg, sender.id, f.input.through, f.instruction)
    if (!thread.ok) return thread
    return ok({
      transport: 'jmap' as const,
      id: f.msg.id,
      rev: f.msg.rev,
      mailboxId: sender.id,
      from: sender.address,
      fromName: sender.name,
      to: f.recipients.to,
      cc: f.recipients.cc,
      subject: f.msg.subject.trim(),
      body: f.msg.body.trim(),
      threadId: thread.value.threadId,
      inReplyTo: thread.value.inReplyTo,
      references: thread.value.references,
      messageId: `<${this.ports.newId()}@${sender.domain || this.owner.domain}>`,
      at: this.now(),
      instruction: f.instruction,
    })
  }

  private planCloudflareSend(f: SendFacts, sender: CloudflareSender): Result<SendPlan> {
    const thread = this.threadFor(f.msg, sender.id, f.input.through, f.instruction)
    if (!thread.ok) return thread
    return ok({
      transport: 'cloudflare' as const,
      id: f.msg.id,
      rev: f.msg.rev,
      mailboxId: sender.id,
      from: sender.address,
      fromName: sender.name,
      to: f.recipients.to,
      cc: f.recipients.cc,
      subject: f.msg.subject.trim(),
      body: f.msg.body.trim(),
      inReplyTo: thread.value.inReplyTo,
      references: thread.value.references,
      at: this.now(),
      instruction: f.instruction,
    })
  }

  private planGmailSend(f: SendFacts, mailboxId: string | null): Result<SendPlan> {
    // The account it goes out from: a reply's is the one its conversation came through, a new email's is the one recorded on the draft when it was made,
    // and a draft that records none (made before there were several) goes from the default account.
    const mailbox = mailboxId === null ? this.defaultGmail() : this.mailboxRow(mailboxId)
    if (!mailbox || mailbox.refreshToken === null) {
      return fail(
        503,
        `${mailbox ? mailbox.address : 'Gmail'} is not connected, so nothing was sent. The draft is unchanged.`,
      )
    }
    if (mailbox.lapsedAt !== null) {
      return fail(503, `${lapsedReason(mailbox.address)} Nothing was sent. The draft is unchanged.`)
    }
    const thread = this.threadFor(f.msg, mailbox.id, f.input.through, f.instruction)
    if (!thread.ok) return thread

    return ok({
      transport: 'gmail' as const,
      id: f.msg.id,
      rev: f.msg.rev,
      mailboxId: mailbox.id,
      from: mailbox.address,
      to: f.recipients.to,
      cc: f.recipients.cc,
      subject: f.msg.subject.trim(),
      body: f.msg.body.trim(),
      threadId: thread.value.threadId,
      inReplyTo: thread.value.inReplyTo,
      messageId: `<${this.ports.newId()}@${mailbox.address.split('@')[1] ?? this.owner.domain}>`,
      at: this.now(),
      instruction: f.instruction,
    })
  }

  /**
   * Which mailbox a draft goes out from, and so which way it is sent (Gmail's API, or Cloudflare's sending binding): a reply, the
   * mailbox its conversation is in (Gmail for the owner's own, Cloudflare for a business's); a new email, the mailbox RECORDED on the draft
   * when it was made (the one the contact last wrote to then), Gmail when none is. The two never cross: a business mailbox's draft is never
   * sent through Gmail as the owner, and the owner's is never sent as the business's address.
   */
  private sendVia(
    msg: MessageRow,
  ):
    | { kind: 'gmail'; mailboxId: string | null }
    | { kind: 'cloudflare'; sender: CloudflareSender }
    | { kind: 'jmap'; sender: CloudflareSender }
    | { kind: 'telegram'; chat: TelegramChatFacts } {
    // A draft on a Telegram conversation goes out through the bridge. One on no conversation has no chat to go to and is a hand draft.
    const chat = msg.conversationId ? this.telegramChatOf(msg.conversationId) : null
    if (chat) return { kind: 'telegram', chat }
    // A mailbox on the install's own mail server: the draft goes out through the server's submission, as that mailbox, and never through anyone else's.
    const jmap = msg.conversationId ? this.jmapSenderOf(msg.conversationId) : this.jmapSenderOfMessage(msg.id)
    if (jmap) return { kind: 'jmap', sender: jmap }
    const sender = msg.conversationId
      ? this.cloudflareSenderOf(msg.conversationId)
      : this.cloudflareSenderOfMessage(msg.id)
    if (sender) return { kind: 'cloudflare', sender }
    // Gmail: the account the conversation is in, else the one recorded on the draft, else none (the default account sends it).
    return {
      kind: 'gmail',
      mailboxId: msg.conversationId
        ? this.gmailMailboxIdOfConversation(msg.conversationId)
        : this.gmailMailboxIdOfMessage(msg.id),
    }
  }

  /** Which way a draft's send goes, decided before anything else (the Mailroom branches on it). Gmail for a draft that is not found. */
  sendTransportOf(id: string): 'gmail' | 'cloudflare' | 'jmap' | 'telegram' {
    const msg = this.message(id)
    return msg ? this.sendVia(msg).kind : 'gmail'
  }

  /**
   * The owner's instruction as Claude gives it, or why it will not do. It arrives from outside,
   * so nothing about its shape is assumed. None at all, or no words, is the 403 of "Claude
   * sends only what the owner told it to send"; words with no place or no time are a 422,
   * because it is a gap in what Claude wrote down, not a missing instruction. The time must
   * be a full ISO timestamp and cannot be in the future (a few minutes of clock skew
   * allowed). The place is one line. All of it is Claude's account and the inbox cannot
   * check it, so this only makes sure there IS an account to read back later.
   */
  checkInstruction(raw: unknown): Result<SendInstruction> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(403, noInstruction(this.owner.name))
    const given = raw as Record<string, unknown>
    const words = text(given.text).trim()
    if (words === '') return fail(403, noInstruction(this.owner.name))
    if (words.length > MAX_INSTRUCTION_TEXT) {
      return fail(422, recordOwnersWords(this.owner.name, MAX_INSTRUCTION_TEXT))
    }
    const where = text(given.where).trim()
    if (where === '') {
      return fail(422, sayWhereOwnerTold(this.owner.name))
    }
    if (where.length > MAX_INSTRUCTION_WHERE || /[\r\n]/.test(where)) {
      return fail(422, `instruction.where is one line of at most ${MAX_INSTRUCTION_WHERE} characters.`)
    }
    if (INBOX_AS_PLACE.test(where))
      return fail(403, instructionOnlyFromOwnerInSession(this.owner.name, this.owner.email))
    const said = isoOrNull(given.at)
    if (said === null) {
      return fail(422, sayWhenOwnerSaid(this.owner.name))
    }
    if (Date.parse(said) > Date.parse(this.now()) + INSTRUCTION_SKEW_MS) {
      return fail(422, instructionInTheFuture(this.owner.name))
    }
    return ok({ text: words, where, at: said })
  }

  /**
   * Whether Claude may send on the owner's instruction. OFF until the owner turns it on: no row is
   * off, so a store that never had one, or was restored from a copy that predates it,
   * cannot send.
   */
  private claudeMaySend(): boolean {
    return this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, CLAUDE_SENDING_KEY).toArray()[0]?.value === 'on'
  }

  /** The switch as the page and Claude's script show it. */
  claudeSending(): ClaudeSending {
    const row = this.sql
      .exec(`SELECT value, updated_at, updated_by FROM setting WHERE key = ?1`, CLAUDE_SENDING_KEY)
      .toArray()[0]
    return {
      enabled: row?.value === 'on',
      changedAt: textOrNull(row?.updated_at),
      changedBy: textOrNull(row?.updated_by),
    }
  }

  /**
   * The owner switches Claude's sending on or off. OWNER ONLY, and checked here and not only in
   * the route: it is a default-deny on the actor (the owner's address, nothing else), so no
   * route added later and no agent can flip it. Audited with before and after. Drafting is
   * not touched: the switch is read by the send and by nothing else.
   */
  setClaudeSending(enabled: boolean, actor: string): Result<ClaudeSending> {
    if (actor !== this.owner.email) return fail(403, onlyOwnerSwitches(this.owner.name))
    return this.ports.transaction(() => {
      const before = this.claudeSending()
      this.sql.exec(
        `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                          updated_by = excluded.updated_by`,
        CLAUDE_SENDING_KEY,
        enabled ? 'on' : 'off',
        this.now(),
        actor,
      )
      const after = this.claudeSending()
      this.audit(actor, 'setting.claude-sending', `setting:${CLAUDE_SENDING_KEY}`, before, after)
      return ok(after)
    })
  }

  /**
   * Every message Claude sent, newest first, each with the instruction it went out on: the
   * messages filed as sent by the agent; those still `sending` whose Gmail copy has arrived
   * (they are on the Drafts too, until the owner resolves them); and those whose outcome Gmail
   * never reported and which the owner then said DID go out (the stuck row is removed then,
   * because Gmail's own copy is the record, so its instruction is read back from the audit
   * entry of their answer). A `sending` row with no Gmail copy is not here: it may not have
   * gone out, and it stays on the Drafts, with its instruction, until the owner says which way.
   */
  listClaudeSends(): ClaudeSend[] {
    const filed = this.sql
      .exec(
        `${this.messageSelect()} WHERE m.direction = 'out' AND m.status = 'sent' AND (m.gmail_id IS NOT NULL OR m.mailbox_id IS NOT NULL)
            AND m.sent_by LIKE ?1 AND m.instruction_text IS NOT NULL`,
        `${AGENT_PREFIX}%`,
      )
      .toArray()
      .map(messageRow)
      .map((message): ClaudeSend => ({ message, proof: 'filed', at: message.sentAt ?? message.createdAt }))
    // A send nobody has resolved whose Gmail copy has arrived: it did go out, though the row
    // is still waiting for the owner to say so, and it belongs here as much as the filed ones.
    const arrived = this.sql
      .exec(
        `${this.messageSelect()} WHERE m.direction = 'out' AND m.status = 'sending' AND m.instruction_text IS NOT NULL`,
      )
      .toArray()
      .map(messageRow)
      .flatMap((message): ClaudeSend[] => {
        const at = this.gmailCopyTime(message.id)
        return at === null ? [] : [{ message, proof: 'gmail', at }]
      })
    const resolved = this.sql
      .exec(`SELECT at, before, after FROM audit WHERE action = 'message.send-resolved'`)
      .toArray()
      .flatMap((r): ClaudeSend[] => {
        try {
          const before = JSON.parse(text(r.before)) as MessageRow | null
          const after = JSON.parse(text(r.after)) as { wentOut?: boolean; kept?: boolean } | null
          // A Cloudflare send the owner said went out is kept as a sent message (the first list has it), not removed.
          return before?.instruction && after?.wentOut === true && after.kept !== true
            ? [{ message: before, proof: 'owner', at: text(r.at) }]
            : []
        } catch {
          return []
        }
      })
    return [...filed, ...arrived, ...resolved].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  /**
   * Whether this message is a draft that may be sent at the revision named: an outbound
   * draft (status AND direction, because mail that came in is also stored as `sent`), an
   * email, unchanged since it was shown, with a subject, a body and no em dash.
   */
  private checkSendable(msg: MessageRow, rev: number | null, telegram = false, withPicture = false): Result<null> {
    if (msg.direction !== 'out') {
      return fail(409, 'That message came in; it is not a draft, and there is nothing to send.')
    }
    if (msg.status === 'sending') {
      return fail(
        409,
        telegram
          ? 'This message is already being sent on Telegram. If it has been like this for more than five minutes, Telegram never said whether it went out: check Telegram.'
          : 'This message is already being sent. If it has been like this for more than a minute, Gmail never said whether it went out: check Gmail Sent (or the mailbox’s Sent, for a mailbox on the mail server).',
      )
    }
    if (msg.status === 'sent') return fail(409, 'This message was already sent. Nothing was sent again.')
    if (msg.status !== 'draft') return fail(409, 'Only a draft can be sent.')
    // A draft has no Gmail id. One that does is already in Gmail, whatever its status says.
    if (msg.gmailId !== null) return fail(409, 'This message is already in Gmail, so it was not sent again.')
    if (msg.jmapId !== undefined)
      return fail(409, 'This message is already on the mail server, so it was not sent again.')
    if (msg.kind === 'telegram' && !telegram) {
      return fail(
        422,
        'A Telegram message goes in the chat it answers, and this draft is on none. Send it yourself in Telegram, then press Mark sent.',
      )
    }
    if (msg.kind !== 'email' && !telegram) {
      return fail(422, 'The inbox sends email only. Copy this one, send it yourself, and press Mark sent.')
    }
    if (rev === null || !Number.isInteger(rev))
      return fail(422, 'Say which version of the draft you are sending (rev).')
    if (rev !== msg.rev) {
      return fail(409, 'The draft was changed after you last saw it, so nothing was sent. It is shown as it is now.')
    }
    // A Telegram message has no subject: plain text, the draft's body byte for byte, at most what Telegram takes in one message.
    const subject = telegram ? '' : msg.subject.trim()
    const body = telegram ? msg.body : msg.body.trim()
    if (!telegram && subject === '') return fail(422, 'Add a subject before sending.')
    // Words are needed, except under a picture, which can speak for itself.
    if (body.trim() === '' && !withPicture) return fail(422, 'There is nothing in the body to send.')
    if (telegram && withPicture && body.length > TELEGRAM_CAPTION_MAX) {
      // Never split into a second message: one press, one message.
      return fail(
        422,
        `Telegram takes at most ${TELEGRAM_CAPTION_MAX} characters under a picture. Shorten the words, or send them as a message of their own. Nothing was sent.`,
      )
    }
    if (telegram && !withPicture && body.length > TELEGRAM_TEXT_MAX) {
      return fail(
        422,
        `Telegram takes at most ${TELEGRAM_TEXT_MAX} characters in a message. Shorten it, or send it yourself in Telegram.`,
      )
    }
    if (!telegram && body.length > MAX_SEND_BODY) {
      return fail(422, `The body is longer than the inbox sends (${MAX_SEND_BODY} characters).`)
    }
    if ((subject + body).includes(EM_DASH)) {
      return fail(
        422,
        telegram
          ? 'Remove the em dash from the message before sending: it reads as machine-written.'
          : 'Remove the em dash from the subject and body before sending: it reads as machine-written.',
      )
    }
    return ok(null)
  }

  /** The picture a Telegram message goes with: the one this press attaches, or the one the draft already carries (never both: one picture per message), or none. */
  private chooseSendPicture(msg: MessageRow, attaching: PictureFacts | null): Result<SendPicture | null> {
    const carried = this.pictureOfDraft(msg)
    if (attaching !== null && carried !== null) {
      return fail(422, 'This draft already carries a picture, and a message carries one. Nothing was sent.')
    }
    if (attaching !== null) return ok({ ...attaching, fresh: true })
    return ok(carried === null ? null : { ...carried, fresh: false })
  }

  /**
   * Claude's send of a draft that carries a picture names it by its fingerprint: none named is a 422 (go and read `drafts`), another is a 409 (the picture is not the one the owner approved), and one named for a draft that
   * carries none is a 409. A check and not content: the send still carries no words of its own.
   */
  private checkPictureNamed(picture: SendPicture | null, named: unknown): Result<null> {
    const given = named === undefined || named === null ? null : String(named).trim().toLowerCase()
    if (picture === null) {
      return given === null ? ok(null) : fail(409, pictureNamedButNone(this.owner.name))
    }
    if (given === null) {
      return fail(422, pictureNotNamed(this.owner.name))
    }
    return given === picture.sha256 ? ok(null) : fail(409, pictureNotTheOneNamed(this.owner.name))
  }

  /**
   * The checks of a send into a Telegram chat, the same ones the email send makes, in the order they are made: the draft is one that may be sent at the revision named, an instruction from
   * the owner covers it as it stands, a channel has no reply box, the chat is not one the bridge may write to, and a conversation is not answered over a message its sender has not read (`through`; and for
   * Claude, nothing came in after the owner spoke). There are no recipients to check: the chat is the conversation's.
   */
  private planTelegramSend(
    msg: MessageRow,
    chat: TelegramChatFacts,
    input: SendRequest,
    instruction: SendInstruction | null,
    attaching: PictureFacts | null,
  ): Result<SendPlan> {
    const chosen = this.chooseSendPicture(msg, attaching)
    if (!chosen.ok) return chosen
    const picture = chosen.value
    const sendable = this.checkSendable(msg, input.rev, true, picture !== null)
    if (!sendable.ok) return sendable
    const voided = instruction === null ? null : this.instructionVoidedBy(msg, instruction.at)
    if (voided !== null) return fail(409, voided)
    // Claude's send names the picture it is sending, so the owner's word covers the picture they approved and no other (a picture the owner puts on, replaces or takes out after they spoke is an edit by someone else, found just above; Claude's own is not held against it, its naming the fingerprint is its check).
    if (instruction !== null) {
      const named = this.checkPictureNamed(picture, input.picture)
      if (!named.ok) return named
    }
    if (chat.kind === 'channel') return fail(422, 'A Telegram channel is one you follow: there is nothing to reply to.')
    if (!this.telegramMaySendTo(chat.chatId, chat.account)) {
      return fail(422, 'The inbox never writes to Telegram’s own service chat or to your Saved Messages.')
    }
    const conversationId = msg.conversationId as string
    const through = input.through
    if (through === null || !Number.isInteger(through)) {
      return fail(422, 'Say how far into the conversation you have read (through).')
    }
    const reached = this.checkThrough(conversationId, through)
    if (!reached.ok) return reached
    if (this.inboundBeyond(conversationId, through)) {
      return fail(
        409,
        'A new message arrived on this conversation, so nothing was sent. It is shown now; read it and press Send again.',
      )
    }
    if (instruction !== null && this.inboundAfter(conversationId, instruction.at)) {
      return fail(409, instructionBeforeReply(this.owner.name))
    }
    return ok({
      transport: 'telegram' as const,
      id: msg.id,
      rev: msg.rev,
      mailboxId: chat.mailboxId,
      chatId: chat.chatId,
      body: picture !== null && msg.body.trim() === '' ? '' : msg.body,
      at: this.now(),
      instruction,
      picture,
    })
  }

  /** The draft's To and Cc, each a bare address that is not ours (`isOurs`, for the business mailbox it goes out through, if it is one), none twice, no more than INBOX_MOST_RECIPIENTS. */
  private checkRecipients(msg: MessageRow, business: CloudflareSender | null): Result<{ to: string; cc: string[] }> {
    const own = this.ownAddresses()
    const to = msg.address
    const cc = msg.cc
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '')
    for (const a of [to, ...cc]) {
      if (!isBareAddress(a)) return fail(422, `That is not an address the inbox can send to: ${a.slice(0, 80)}`)
      if (isOurs(business, own, a.toLowerCase())) {
        return fail(422, `${a} is your own address, so it would arrive in your own mailbox. Take it off the draft.`)
      }
    }
    if (new Set([to, ...cc].map((a) => a.toLowerCase())).size !== cc.length + 1) {
      return fail(422, 'An address appears twice on this draft.')
    }
    if (cc.length + 1 > INBOX_MOST_RECIPIENTS)
      return fail(422, `A message goes to at most ${INBOX_MOST_RECIPIENTS} people.`)
    return ok({ to, cc })
  }

  /**
   * Where the message goes in Gmail. A draft on an email conversation is a REPLY: it joins
   * that thread, answers the message the thread's reply plan names, and is refused when
   * something has arrived on the conversation since the page was shown (`through`). A draft
   * with no conversation, or on one with no mailbox (a text, a carried Outbox entry), is a
   * new email.
   */
  private threadFor(
    msg: MessageRow,
    mailboxId: string,
    through: number | null,
    instruction: SendInstruction | null,
  ): Result<{ threadId: string | null; inReplyTo: string | null; references: string[] }> {
    const conversation = msg.conversationId
      ? this.sql
          .exec(
            `SELECT mailbox_id, gmail_thread_id, jmap_thread_id FROM conversation WHERE id = ?1`,
            msg.conversationId,
          )
          .toArray()[0]
      : undefined
    if (!msg.conversationId || !conversation || conversation.mailbox_id === null) {
      return ok({ threadId: null, inReplyTo: null, references: [] })
    }
    const kind = this.mailboxKindOf(msg.conversationId)
    const threadId = textOrNull(conversation[idColumns(kind).thread])
    // A Cloudflare conversation has no Gmail thread: it is threaded on the Message-IDs, which the answer below names. So is a JMAP one (it also has the server's thread, which the send files the reply into).
    const viaCloudflare = domainIsOurs(kind)
    if (conversation.mailbox_id !== mailboxId || (threadId === null && !viaCloudflare)) {
      return fail(
        409,
        'This conversation is not on the connected Gmail account, so a reply cannot be threaded. Nothing was sent.',
      )
    }
    if (through === null || !Number.isInteger(through)) {
      return fail(422, 'Say how far into the conversation you have read (through).')
    }
    const reached = this.checkThrough(msg.conversationId, through)
    if (!reached.ok) return reached
    if (this.inboundBeyond(msg.conversationId, through)) {
      return fail(
        409,
        'A new message arrived on this conversation, so nothing was sent. It is shown now; read it and press Send again.',
      )
    }
    // For Claude, also: nothing in play came in after the owner spoke. `through` says what Claude
    // read, and a re-read makes it current, so on its own it would let the same words go out
    // over a reply the owner never saw. The instruction is what the owner agreed to; this is the check
    // that it was agreed to without that message in the thread.
    if (instruction !== null && this.inboundAfter(msg.conversationId, instruction.at)) {
      return fail(409, instructionBeforeReply(this.owner.name))
    }
    const answered = this.replyPlan(msg.conversationId)?.inReplyTo ?? null
    const inReplyTo = answered !== null && MESSAGE_ID.test(answered) ? answered : null
    return ok({
      threadId,
      inReplyTo,
      references: viaCloudflare ? this.referencesFor(msg.conversationId, inReplyTo) : [],
    })
  }

  /**
   * The Message-IDs a reply to a Cloudflare conversation is threaded on: the answered message's own parent when it named
   * one (so a customer's mail client sees the chain it knows), then the answered message. The inbox does not keep a thread's
   * whole References, so a long chain is not reproduced; In-Reply-To is what clients thread on.
   */
  private referencesFor(conversationId: string, answered: string | null): string[] {
    if (answered === null) return []
    const parent = this.sql
      .exec(
        `SELECT in_reply_to FROM message WHERE conversation_id = ?1 AND rfc_message_id = ?2 AND in_reply_to IS NOT NULL
          ORDER BY rowid LIMIT 1`,
        conversationId,
        answered,
      )
      .toArray()[0]
    const before = parent ? text(parent.in_reply_to) : ''
    return before !== '' && before !== answered && MESSAGE_ID.test(before) ? [before, answered] : [answered]
  }

  /**
   * Why the owner's instruction at `at` no longer covers the draft, in words for Claude, or null when it still does. Two things void it, both found in the audit (every creation and every edit is there, with who and
   * when, and ANY such change counts, not only the last, so a later edit by Claude cannot hide an earlier one): somebody other than Claude wrote or edited the draft after it, or ANYBODY, Claude included, changed who the
   * draft goes to (its To or Cc: the owner agreed to a message for those people). Claude's own edit of the words is not held against it.
   */
  private instructionVoidedBy(msg: MessageRow, at: string): string | null {
    const since = Date.parse(at)
    let voided: string | null = null
    for (const a of this.sql
      .exec(
        `SELECT actor, at, before, after FROM audit WHERE subject = ?1 AND action IN ('draft.create', 'draft.update')`,
        `message:${msg.id}`,
      )
      .toArray()) {
      if (Date.parse(text(a.at)) <= since) continue
      if (!isAgent(text(a.actor))) return draftChangedAfterInstruction(this.owner.name)
      if (recipientsDiffer(a.before, a.after)) voided = recipientsChangedAfterInstruction(this.owner.name)
    }
    return voided
  }

  /**
   * A `through` is how far into the conversation its sender read, so it can be no further than
   * the conversation goes. One that is (a guess, a typo, a number from another conversation)
   * is refused, because "nothing arrived after it" is trivially true of a number nothing can
   * exceed, and the check it feeds would pass over a message nobody was shown.
   */
  private checkThrough(conversationId: string, through: number): Result<null> {
    if (through > this.newestPosition(conversationId)) {
      return fail(
        422,
        'That is further into the conversation than it goes. Use the through that `conversation` printed (or the page showed).',
      )
    }
    return ok(null)
  }

  /** Whether a conversation is in a mailbox that is not Gmail's (Cloudflare's or Telegram's): its messages carry no Gmail id or labels. */
  private hasNoGmailSide(conversationId: string): boolean {
    const kind = this.mailboxKindOf(conversationId)
    return kind === 'cloudflare' || kind === 'telegram'
  }

  /**
   * Whether something inbound and in play arrived after `at` (an ISO time): by Gmail's own
   * time for it, or by the time the inbox stored it, whichever is later, so neither a message
   * whose push was late nor one Gmail stamped late can slip under an earlier instruction.
   */
  private inboundAfter(conversationId: string, at: string): boolean {
    // Cloudflare's and Telegram's: nothing there has Gmail's id or labels, so every message that came in counts.
    if (this.hasNoGmailSide(conversationId)) {
      return (
        this.sql
          .exec(
            `SELECT 1 FROM message WHERE conversation_id = ?1 AND direction = 'in' AND mailbox_id IS NOT NULL
                AND (coalesce(sent_at, created_at) > ?2 OR created_at > ?2) LIMIT 1`,
            conversationId,
            at,
          )
          .toArray().length > 0
      )
    }
    return this.sql
      .exec(
        `SELECT labels FROM message
          WHERE conversation_id = ?1 AND direction = 'in' AND ${heldOnServer()}
            AND (coalesce(sent_at, created_at) > ?2 OR created_at > ?2)`,
        conversationId,
        at,
      )
      .toArray()
      .some((m) => inPlay(jsonArray<string>(m.labels)))
  }

  /** Whether something inbound, in play, is stored beyond what the page showed (`through`). */
  private inboundBeyond(conversationId: string, through: number): boolean {
    if (this.hasNoGmailSide(conversationId)) {
      return (
        this.sql
          .exec(
            `SELECT 1 FROM message WHERE conversation_id = ?1 AND direction = 'in' AND mailbox_id IS NOT NULL AND rowid > ?2 LIMIT 1`,
            conversationId,
            through,
          )
          .toArray().length > 0
      )
    }
    return this.sql
      .exec(
        `SELECT labels FROM message
          WHERE conversation_id = ?1 AND direction = 'in' AND ${heldOnServer()} AND rowid > ?2`,
        conversationId,
        through,
      )
      .toArray()
      .some((m) => inPlay(jsonArray<string>(m.labels)))
  }

  /**
   * Claim the draft for sending: ONE conditional write, draft to sending, true only
   * while it is still the draft that was planned. The refusal (409) means somebody
   * got there first (or edited it), and nothing was sent. The Message-ID the message
   * will carry is recorded now, so a send whose outcome is never known can be matched
   * with Gmail's Sent folder by hand.
   */
  claimSend(plan: SendPlan, actor: string): Result<null> {
    return this.ports.transaction(() => {
      // Claude's send is claimed only while the owner still has the switch on and only with the
      // instruction the plan was made with: the same two gates as the plan, asked again
      // because the owner can flip the switch between the two, and a plan is not a permission.
      // The instruction is written with the claim, before Gmail is asked, so a send whose
      // outcome is never known still carries the words it went out on.
      if (isAgent(actor)) {
        if (!this.claudeMaySend()) return fail(403, claudeSendingOff(this.owner.name))
        if (plan.instruction === null) return fail(403, noInstruction(this.owner.name))
      } else if (plan.instruction !== null) {
        return fail(403, ONLY_CLAUDE_CARRIES_INSTRUCTION)
      }
      const claimed = this.sql.exec(
        `UPDATE message SET status = 'sending', rfc_message_id = ?3,
                instruction_text = ?4, instruction_where = ?5, instruction_at = ?6
          WHERE id = ?1 AND rev = ?2 AND status = 'draft' AND direction = 'out' AND gmail_id IS NULL AND jmap_id IS NULL`,
        plan.id,
        plan.rev,
        // A Cloudflare send has no Message-ID of its own to record: Cloudflare makes it and reports it on acceptance. A Gmail or JMAP one records the Message-ID the inbox chose.
        plan.transport === 'gmail' || plan.transport === 'jmap' ? plan.messageId : null,
        plan.instruction?.text ?? null,
        plan.instruction?.where ?? null,
        plan.instruction?.at ?? null,
      )
      if (claimed.rowsWritten === 0) {
        return fail(409, 'This draft was changed or sent by something else a moment ago, so nothing was sent.')
      }
      if (plan.transport === 'telegram') {
        // The send is owed to the bridge from here: its repeat key is made now and kept with it, in the same transaction as the claim.
        // A picture attached by this very press is named on the draft in the same transaction as the claim (its object was written to the bucket first): a kept Telegram photo with its true length and its
        // fingerprint, under the draft's own key, which the sent message keeps.
        if (plan.picture?.fresh) this.namePicture(plan.id, plan.picture)
        this.oweTelegramSend(plan.id, plan.chatId, actor, plan.picture)
        this.audit(actor, 'message.sending', `message:${plan.id}`, null, {
          chat: plan.chatId,
          rev: plan.rev,
          ...(plan.instruction && { instruction: plan.instruction }),
          ...(plan.picture && { picture: plan.picture.sha256 }),
        })
        return ok(null)
      }
      this.audit(actor, 'message.sending', `message:${plan.id}`, null, {
        to: plan.to,
        cc: plan.cc,
        subject: plan.subject,
        rev: plan.rev,
        // What a Cloudflare send was threaded on is on record here, so the owner's answer about a send whose outcome was never
        // known files it with exactly these (resolveCloudflare), and not with what the conversation says later.
        ...((plan.transport === 'cloudflare' || plan.transport === 'jmap') && {
          from: plan.from,
          inReplyTo: plan.inReplyTo,
          references: plan.references,
        }),
        ...(plan.instruction && { instruction: plan.instruction }),
      })
      return ok(null)
    })
  }

  /**
   * Gmail refused: the draft goes back to being a draft, with the reason in the
   * audit. Conditional on `sending`, so it can undo only its own claim. Never used
   * for a send whose outcome is unknown: that one stays `sending`.
   */
  releaseClaim(id: string, reason: string, actor: string): void {
    this.ports.transaction(() => {
      const released = this.sql.exec(
        `UPDATE message SET status = 'draft',
                instruction_text = NULL, instruction_where = NULL, instruction_at = NULL
          WHERE id = ?1 AND status = 'sending'`,
        id,
      )
      if (released.rowsWritten > 0) this.audit(actor, 'message.send-refused', `message:${id}`, null, { reason })
    })
  }

  /**
   * Gmail accepted it: the draft becomes the sent message, under Gmail's id, in the
   * conversation Gmail put it in (the thread it answered, or a new conversation for a
   * new email), with who sent it. Read and closed by the sender, because a message
   * with neither UNREAD nor INBOX is exactly that (writeLabels keeps the stamps true
   * to the labels). The history event for this id that arrives later finds it held
   * and changes nothing.
   *
   * What is stored is what was sent, from what the plan held and not from anything
   * Gmail said back, except its id, thread and labels.
   */
  fileSentMessage(plan: GmailSendPlan, sent: SentMessage, actor: string): Result<MessageRow> {
    return this.ports.transaction(() => {
      const draft = this.sql
        .exec(`SELECT identity_id FROM message WHERE id = ?1 AND status = 'sending'`, plan.id)
        .toArray()[0]
      if (!draft) return fail(409, 'This message is no longer waiting to be filed.')
      // Cannot happen while the send runs inside the Mailroom's `exclusive` (no sync can
      // store the message first), but a unique index is not the place to find out.
      if (
        this.sql
          .exec(`SELECT 1 FROM message WHERE mailbox_id = ?1 AND gmail_id = ?2`, plan.mailboxId, sent.id)
          .toArray()[0]
      ) {
        return fail(
          409,
          'The inbox already holds this message from Gmail, so the draft was left as it is: check Gmail Sent.',
        )
      }
      const at = plan.at
      const threadId = sent.threadId === '' ? plan.threadId : sent.threadId
      if (threadId === null) return fail(502, 'Gmail did not say which thread the message is in.')

      const existing = this.sql
        .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND gmail_thread_id = ?2`, plan.mailboxId, threadId)
        .toArray()[0]
      const conversationId = existing ? text(existing.id) : this.ports.newId()
      if (!existing) {
        this.sql.exec(
          `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id)
           VALUES (?1, ?2, ?2, ?3, ?4)`,
          conversationId,
          at,
          plan.mailboxId,
          threadId,
        )
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'to')`,
        conversationId,
        text(draft.identity_id),
      )
      for (const address of plan.cc) {
        const who = this.identityFor({ kind: 'email', address: address.toLowerCase() }, undefined, actor)
        this.sql.exec(
          `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'cc')`,
          conversationId,
          who.id,
        )
      }

      const labels = new Set([...sent.labels, LABEL.sent])
      this.sql.exec(
        `UPDATE message SET status = 'sent', conversation_id = ?2, mailbox_id = ?3, gmail_id = ?4, in_reply_to = ?5,
                from_header = ?6, to_header = ?7, cc_header = ?8, sender_date = ?9, snippet = ?10, labels = ?11,
                sent_at = ?9, sent_by = ?12,
                read_at = CASE WHEN ?13 = 1 THEN NULL ELSE ?9 END, read_by = CASE WHEN ?13 = 1 THEN NULL ELSE ?12 END,
                closed_at = CASE WHEN ?14 = 1 THEN NULL ELSE ?9 END, closed_by = CASE WHEN ?14 = 1 THEN NULL ELSE ?12 END
          WHERE id = ?1 AND status = 'sending'`,
        plan.id,
        conversationId,
        plan.mailboxId,
        sent.id,
        plan.inReplyTo,
        `${this.owner.mailName} <${plan.from}>`,
        plan.to,
        plan.cc.join(', '),
        at,
        plan.body.replace(/\s+/g, ' ').slice(0, SENT_SNIPPET_CHARS),
        sortedLabels(labels),
        actor,
        labels.has(LABEL.unread) ? 1 : 0,
        labels.has(LABEL.inbox) ? 1 : 0,
      )
      this.touchConversation(conversationId)
      const filed = this.message(plan.id) as MessageRow
      this.audit(actor, 'message.send', `message:${plan.id}`, null, filed)
      return ok(filed)
    })
  }

  /**
   * The mail server accepted the message: the draft becomes the sent message, under the server's id, in the conversation the server put it in (the thread it answered, or a conversation of its own for a new email), from the
   * mailbox's address, read and closed by the sender (its labels are SENT alone: a mail app shows it in the mailbox's Sent). What is stored is what was sent, from what the plan held and not from anything the server said
   * back except the id and the thread. The next sync finds the server's copy held and changes nothing.
   */
  fileJmapSent(plan: JmapSendPlan, sent: { emailId: string; threadId: string }, actor: string): Result<MessageRow> {
    return this.ports.transaction(() => {
      const draft = this.sql
        .exec(`SELECT identity_id FROM message WHERE id = ?1 AND status = 'sending'`, plan.id)
        .toArray()[0]
      if (!draft) return fail(409, 'This message is no longer waiting to be filed.')
      if (
        this.sql
          .exec(`SELECT 1 FROM message WHERE mailbox_id = ?1 AND jmap_id = ?2`, plan.mailboxId, sent.emailId)
          .toArray()[0]
      ) {
        return fail(
          409,
          'The inbox already holds this message from the mail server, so the draft was left as it is: check the mailbox’s Sent.',
        )
      }
      const at = plan.at
      const threadId = sent.threadId === '' ? plan.threadId : sent.threadId
      if (threadId === null) return fail(502, 'The mail server did not say which thread the message is in.')
      const existing = this.sql
        .exec(`SELECT id FROM conversation WHERE mailbox_id = ?1 AND jmap_thread_id = ?2`, plan.mailboxId, threadId)
        .toArray()[0]
      const conversationId = existing ? text(existing.id) : this.ports.newId()
      if (!existing) {
        this.sql.exec(
          `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, jmap_thread_id) VALUES (?1, ?2, ?2, ?3, ?4)`,
          conversationId,
          at,
          plan.mailboxId,
          threadId,
        )
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'to')`,
        conversationId,
        text(draft.identity_id),
      )
      for (const address of plan.cc) {
        const who = this.identityFor({ kind: 'email', address: address.toLowerCase() }, undefined, actor)
        this.sql.exec(
          `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'cc')`,
          conversationId,
          who.id,
        )
      }
      this.sql.exec(
        `UPDATE message SET status = 'sent', conversation_id = ?2, mailbox_id = ?3, jmap_id = ?4, in_reply_to = ?5,
                from_header = ?6, to_header = ?7, cc_header = ?8, sender_date = ?9, snippet = ?10, labels = ?11,
                sent_at = ?9, sent_by = ?12, read_at = ?9, read_by = ?12, closed_at = ?9, closed_by = ?12
          WHERE id = ?1 AND status = 'sending'`,
        plan.id,
        conversationId,
        plan.mailboxId,
        sent.emailId,
        plan.inReplyTo,
        plan.fromName ? `${plan.fromName} <${plan.from}>` : plan.from,
        plan.to,
        plan.cc.join(', '),
        at,
        plan.body.replace(/\s+/g, ' ').slice(0, SENT_SNIPPET_CHARS),
        sortedLabels([LABEL.sent]),
        actor,
      )
      this.touchConversation(conversationId)
      const filed = this.message(plan.id) as MessageRow
      this.audit(actor, 'message.send', `message:${plan.id}`, null, filed)
      return ok(filed)
    })
  }

  /**
   * Cloudflare accepted the message: the draft becomes the sent message, in the conversation it answered (or a conversation of
   * its own, for a new email), under the Message-ID Cloudflare reported, from the mailbox's address, read and closed by the
   * sender (a message with neither stamp would reopen the conversation it answers), with the key of the copy kept in the
   * bucket. What is stored is what was sent, from what the plan held and nothing Cloudflare said back but its id.
   *
   * A copy that could not be kept does not undo the send: the message is out, so it is filed without the key and the audit says
   * the copy is missing.
   */
  fileCloudflareSent(
    plan: CloudflareSendPlan,
    done: {
      reportedId: string | null
      rawKey: string | null
      copyError: string | null
      attachments?: AttachmentInfo[]
    },
    actor: string,
  ): Result<MessageRow> {
    return this.ports.transaction(() => this.fileCloudflare(plan, done, actor))
  }

  private fileCloudflare(
    plan: CloudflareSendPlan,
    done: {
      reportedId: string | null
      rawKey: string | null
      copyError: string | null
      attachments?: AttachmentInfo[]
    },
    actor: string,
  ): Result<MessageRow> {
    const draft = this.sql
      .exec(`SELECT identity_id, conversation_id FROM message WHERE id = ?1 AND status = 'sending'`, plan.id)
      .toArray()[0]
    if (!draft) return fail(409, 'This message is no longer waiting to be filed.')
    const at = plan.at
    let conversationId = textOrNull(draft.conversation_id)
    if (conversationId === null) {
      conversationId = this.ports.newId()
      const key = subjectKey(plan.subject)
      this.sql.exec(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, subject_key) VALUES (?1, ?2, ?2, ?3, ?4)`,
        conversationId,
        at,
        plan.mailboxId,
        key === '' ? null : key,
      )
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'to')`,
      conversationId,
      text(draft.identity_id),
    )
    for (const address of plan.cc) {
      const who = this.identityFor({ kind: 'email', address: address.toLowerCase() }, undefined, actor)
      this.sql.exec(
        `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'cc')`,
        conversationId,
        who.id,
      )
    }
    this.sql.exec(
      `UPDATE message SET status = 'sent', conversation_id = ?2, mailbox_id = ?3, rfc_message_id = ?4, in_reply_to = ?5,
              from_header = ?6, to_header = ?7, cc_header = ?8, sender_date = ?9, snippet = ?10, labels = '[]',
              sent_at = ?9, sent_by = ?11, read_at = ?9, read_by = ?11, closed_at = ?9, closed_by = ?11, raw_key = ?12,
              attachments = ?13
        WHERE id = ?1 AND status = 'sending'`,
      plan.id,
      conversationId,
      plan.mailboxId,
      messageIdOf(done.reportedId),
      plan.inReplyTo,
      plan.fromName ? `${plan.fromName} <${plan.from}>` : plan.from,
      plan.to,
      plan.cc.join(', '),
      at,
      plan.body.replace(/\s+/g, ' ').slice(0, SENT_SNIPPET_CHARS),
      actor,
      done.rawKey,
      JSON.stringify(done.attachments ?? []),
    )
    this.touchConversation(conversationId)
    const filed = this.message(plan.id) as MessageRow
    this.audit(actor, 'message.send', `message:${plan.id}`, null, filed)
    if (done.copyError !== null) {
      this.audit(actor, 'message.copy-failed', `message:${plan.id}`, null, { error: brief(done.copyError) })
    }
    return ok(filed)
  }

  /**
   * The owner's answer about a Cloudflare send whose outcome Cloudflare never reported. There is no Sent folder and no copy that
   * will arrive by itself, so unlike a Gmail one the message is not removed when it went out: it is KEPT, filed as sent on the owner's
   * word (by whoever claimed it, with the instruction it went out on), because the inbox is the only record there is. Not
   * sent: a draft again.
   */
  private resolveCloudflare(
    before: MessageRow,
    sender: CloudflareSender,
    wentOut: boolean,
    actor: string,
    kept: { reportedId: string | null; rawKey: string | null },
  ): Result<{ id: string; status: 'sent' | 'draft' }> {
    if (!wentOut) {
      this.sql.exec(
        `UPDATE message SET status = 'draft',
                instruction_text = NULL, instruction_where = NULL, instruction_at = NULL WHERE id = ?1`,
        before.id,
      )
      this.audit(actor, 'message.send-resolved', `message:${before.id}`, before, { wentOut })
      return ok({ id: before.id, status: 'draft' as const })
    }
    const claim = this.sql
      .exec(
        `SELECT actor, at, after FROM audit WHERE subject = ?1 AND action = 'message.sending' ORDER BY rowid DESC LIMIT 1`,
        `message:${before.id}`,
      )
      .toArray()[0]
    // What the send was threaded on, as the claim recorded it (the same words the message went out with), and so not worked
    // out again from a conversation that may have changed since.
    let threaded: { inReplyTo: string | null; references: string[] } = { inReplyTo: null, references: [] }
    try {
      const said = JSON.parse(text(claim?.after)) as { inReplyTo?: unknown; references?: unknown } | null
      threaded = {
        inReplyTo: typeof said?.inReplyTo === 'string' ? said.inReplyTo : null,
        references: Array.isArray(said?.references)
          ? said.references.filter((r): r is string => typeof r === 'string')
          : [],
      }
    } catch {
      // A claim with nothing readable on it files with no threading, which is what the message was given if it had none.
    }
    const filed = this.fileCloudflare(
      {
        transport: 'cloudflare',
        id: before.id,
        rev: before.rev,
        mailboxId: sender.id,
        from: sender.address,
        fromName: sender.name,
        to: before.address,
        cc: before.cc
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a !== ''),
        subject: before.subject.trim(),
        body: before.body.trim(),
        inReplyTo: threaded.inReplyTo,
        references: threaded.references,
        at: claim ? text(claim.at) : this.now(),
        instruction: before.instruction,
      },
      { reportedId: kept.reportedId, rawKey: kept.rawKey, copyError: null },
      claim ? text(claim.actor) : actor,
    )
    if (!filed.ok) return filed
    this.audit(actor, 'message.send-resolved', `message:${before.id}`, before, { wentOut, kept: true })
    return ok({ id: before.id, status: 'sent' as const })
  }

  /**
   * The owner says how a send whose outcome was never known went (Mailroom.resolveSend).
   * It went out: the stuck draft is removed, because Gmail's own copy arrives by sync
   * and is the record, and a carried draft leaves its tombstone as any removal of one does
   * (see `tombstone`), so a re-run of the carry cannot bring back an email that went out.
   * It did not: the draft is a draft again, and the next Send is the owner's decision after they
   * looked in Gmail Sent, and it is REFUSED when Gmail's copy of this very message (the
   * same Message-ID) is already held, which says it did go out. Only a `sending` row can
   * be resolved.
   */
  resolveSending(
    id: string,
    wentOut: boolean,
    actor: string,
    /** For a Cloudflare send: what the kept copy says (the id Cloudflare reported, the copy's key), read by the Mailroom. */
    kept: { reportedId: string | null; rawKey: string | null } = { reportedId: null, rawKey: null },
  ): Result<{ id: string; status: 'removed' | 'draft' | 'sent' }> {
    if (isAgent(actor)) return fail(403, onlyOwnerResolves(this.owner.name))
    return this.ports.transaction(() => {
      this.expireUnofferedSends()
      const before = this.message(id)
      if (!before) return fail(404, 'No such message.')
      if (before.status !== 'sending') return fail(409, 'That message is not waiting on a send.')
      const cloudflare = this.cloudflareSenderOfMessage(id)
      if (cloudflare) return this.resolveCloudflare(before, cloudflare, wentOut, actor, kept)
      // A Telegram send is owed to the bridge, which may be sending it right now: while it is still being offered it is not the owner's to answer for (a "did not go out" now could be followed by the send).
      const telegram = before.kind === 'telegram'
      const owed = telegram ? this.telegramSendOwed(id) : null
      if (owed && this.telegramSendInFlight(owed)) {
        return fail(
          409,
          'The bridge may still be sending this on Telegram. Wait until it shows in the conversation or this card says to check Telegram, then answer here.',
        )
      }
      if (!wentOut && telegram && this.telegramHoldsCopyOf(before)) {
        return fail(
          409,
          'Your own message with these words is already in the Telegram chat here (it arrived after you pressed Send), so it did go out. Say that it went out, to remove this one.',
        )
      }
      if (!wentOut && !telegram && this.gmailHoldsCopyOf(id)) {
        return fail(409, this.serverCopyHeldWords(before))
      }
      if (telegram) this.clearTelegramSend(id)
      if (wentOut) {
        this.sql.exec(`DELETE FROM message WHERE id = ?1 AND status = 'sending'`, id)
        // The picture it carried goes with it (the copy in the stream, if one arrives, has its own).
        this.releasePicture(before.rawKey)
        this.tombstone(before.sourceRef, actor)
        if (before.conversationId) this.touchConversation(before.conversationId)
      } else {
        // An instruction covered that attempt, which did not go out: it is not left on the
        // draft, or the draft would read "sent by Claude on the owner's word" when the owner sends it
        // themselves. The audit entry below keeps it.
        this.sql.exec(
          `UPDATE message SET status = 'draft',
                  instruction_text = NULL, instruction_where = NULL, instruction_at = NULL WHERE id = ?1`,
          id,
        )
      }
      this.audit(actor, 'message.send-resolved', `message:${id}`, before, { wentOut })
      return ok({ id, status: wentOut ? ('removed' as const) : ('draft' as const) })
    })
  }

  /** What is said when the server's own copy of a stuck send is already held: it went out. Gmail's, or the mail server's. */
  private serverCopyHeldWords(draft: MessageRow): string {
    const onMailServer =
      this.jmapSenderOfMessage(draft.id) || (draft.conversationId && this.jmapSenderOf(draft.conversationId))
    const server = onMailServer ? 'The mail server’s' : 'Gmail’s'
    return `${server} own copy of this message is already in the inbox (it has the same Message-ID), so it did go out. Say that it went out, to remove this one.`
  }

  /** Whether a message from Gmail with the Message-ID this draft was claimed under is held: it went out. */
  private gmailHoldsCopyOf(id: string): boolean {
    return this.gmailCopyTime(id) !== null
  }

  /** When Gmail's own copy of this claimed draft was sent (the same Message-ID), or null while none is held. */
  private gmailCopyTime(id: string): string | null {
    const copy = this.sql
      .exec(
        `SELECT coalesce(m.sent_at, m.created_at) AS at FROM message m
          WHERE m.id != ?1 AND (m.gmail_id IS NOT NULL OR m.jmap_id IS NOT NULL) AND m.rfc_message_id IS NOT NULL
            AND m.rfc_message_id = (SELECT rfc_message_id FROM message WHERE id = ?1)`,
        id,
      )
      .toArray()[0]
    return copy ? text(copy.at) : null
  }

  // ─── where a reply goes, for messages stored before it was recorded ───

  /** The Gmail id of the newest inbound message on this conversation whose Reply-To was never recorded, or null. */
  replyToToLearn(conversationId: string): string | null {
    return this.replyPlan(conversationId)?.replyToUnknown ?? null
  }

  /** Record a Reply-To read back from Gmail, only where none was recorded (in the account it was read from: Gmail ids are one account's). */
  recordReplyTo(mailboxId: string, gmailId: string, header: string): void {
    this.sql.exec(
      `UPDATE message SET reply_to_header = ?3 WHERE mailbox_id = ?1 AND gmail_id = ?2 AND reply_to_header IS NULL`,
      mailboxId,
      gmailId,
      header,
    )
  }

  /** The Gmail account a conversation is in, with its token, or null (a Cloudflare or manual conversation). For the Mailroom. */
  mailboxRowOfConversation(conversationId: string): MailboxRow | null {
    const id = this.gmailMailboxIdOfConversation(conversationId)
    return id === null ? null : this.mailboxRow(id)
  }
}
