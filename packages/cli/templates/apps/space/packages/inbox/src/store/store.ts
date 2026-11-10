/**
 * The inbox: everything it owns and every rule about it, behind ports.
 *
 * This class has never seen `env`, `ctx`, `cloudflare:workers` or a Durable
 * Object. It takes PORTS (a `sql`, a `transaction`, a clock, an id source), and
 * the Durable Object in durable.ts is a shell that builds one of these and
 * forwards to it. What that buys is that every rule here runs under plain `bun`
 * against a REAL SQLite with the REAL migrations, so a mistyped column or a
 * conditional write that does not condition fails in a test.
 *
 * ── RESULTS, NOT THROWS ──────────────────────────────────────────────────
 * A refusal is a value: `{ ok: false, status, error }`. An error thrown inside a
 * Durable Object reaches the Worker through RPC as a bare Error with its class
 * and any fields stripped, so a thrown 422 would arrive as a 500. The status is
 * the HTTP one the route will answer with, and the text is safe to show.
 *
 * ── EVERY WRITE IS AUDITED IN ITS OWN TRANSACTION ────────────────────────
 * With the actor, the verified Access identity and never anything from a request
 * body. `actor` is a person's address or `agent:` and a token's client id.
 *
 * ── WHAT IS HERE ─────────────────────────────────────────────────────────
 * Drafts, contacts, conversations and the Outbox carry, and a contact's Client,
 * merge and split (`assignClient` and friends below, which never ask whether a
 * Client exists, because only the Clients part can say). A message a
 * person sends is a draft until it is marked sent BY HAND (`manual-sent`), the
 * Outbox's way; nothing sends yet. The Gmail half (the mailbox, ingesting
 * messages, the cursor and the jobs) is the subclass in ./mail.ts, which extends
 * this class only to share the helpers below without making them public.
 *
 * ── READ AND OPEN ARE DERIVED ────────────────────────────────────────────
 * `conversationState` answers them on every read and stores nothing of its own:
 * for an email conversation from Gmail's labels on its messages, for a manual one
 * from the stamps (migration 3). Changing them is MailStore's, because for email
 * it means writing labels.
 *
 * A MANUAL conversation is one with no mailbox. `manualConversationFor` filters
 * on that, so a Gmail thread with the same person is never filed into by a
 * message marked sent by hand, and the reverse.
 */

import { type InboxFrom, parseCalendarSummary, safeSummaryLine } from '@space/workspace'
import { judgeSender } from '../automated'
import { repairMojibake } from '../charset'
import type { SuggestionContact } from '../clients'
import { reasonLines } from '../cloudflare/spam-check'
import { type DeliveryEvent, type HeldEvent, notesFor } from '../delivery'
import { lapsedReason, workingGrantSql } from '../gmail/health'
import { parseAddressList, tidyLine } from '../gmail/parse'
import { inPlay, LABEL } from '../gmail/types'
import type { MailboxContent } from '../mailbox-content'
import { noMailboxToSendFrom } from '../mailbox-words'
import type { InboxOwner } from '../owner'
import { draftNeedsWhy } from '../owner-words'
import {
  ALL_MAIL,
  type BulkReason,
  bulkReason,
  canSee,
  contactSeen,
  isBulk,
  isSpam,
  type MailScope,
  scopeOf,
} from '../queue'
import { excerptAround, likePattern } from '../search'
import {
  AGENT_PREFIX,
  ASSISTANT_ACTOR,
  type AttachmentInfo,
  type AuditRow,
  type BulkCounts,
  type BulkReport,
  CARRIED_BY,
  type CarryReport,
  type ChatTurn,
  type ContactCard,
  type ContactClient,
  type ContactListItem,
  type ContactRow,
  type ConversationDetail,
  type ConversationReply,
  type ConversationState,
  type ConversationSummary,
  type DraftInput,
  type DraftPatch,
  draftAuthor,
  draftEditedBy,
  type Envelope,
  type IdentityKind,
  type IdentityRow,
  isAgent,
  isClientId,
  isPending,
  MAX_SUBJECT,
  type MailboxMark,
  type MessageRow,
  type MessageStatus,
  type OutboxEntry,
  PENDING_STATUSES,
  QUEUE_PAGE,
  type QueueFact,
  type SenderJudgment,
  type SendsFrom,
  type SpamCall,
} from '../types'
import { type Classified, classifyAddress } from './address'
import { domainIsOurs, EMAIL_KINDS, isEmailKind, isMailboxKind, labelsAreTruth, type MailboxKind } from './kinds'
import { mailboxesOfPerson, peopleOnMailbox, personKey, putPeople, settleMailboxPeople as settlePeople } from './people'
import type { InboxSql } from './schema'
import { MESSAGE_MAILBOX, scopeWhere } from './scope'

/** A contact's profile (migration 12): what is known of the person beyond their addresses, and the revision a write must name. */
export interface ContactProfile {
  business: string
  role: string
  notes: string
  rev: number
}

export interface InboxPorts {
  sql: InboxSql
  /** Commit if `fn` returns, roll back if it throws. A Durable Object's `transactionSync`. */
  transaction: <T>(fn: () => T) => T
  /** Injected so nothing here reads the wall clock, and so tests can fix it. */
  now: () => Date
  newId: () => string
  /** The install's owner (owner.ts): who the owner-only writes admit, the name the refusals say and mail is sent under, and the domain a message id is made under. */
  owner: InboxOwner
  /** The install's mailbox content (src/mailbox-content.ts): a Cloudflare mailbox's spam check runs, and can be switched on, only where it has questions. */
  content: MailboxContent
  /**
   * Who is on the mailboxes the install says the people of (`mailboxPeopleOf`, src/owner.ts): a declared business mailbox's `people`, the owner for the Telegram mailbox, null for what it does not say (a Gmail
   * account is its connector's). Left out, no mailbox is said: every new one is the owner's alone. Read when a mailbox is made and when the object starts (`settleMailboxPeople`).
   */
  mailboxPeople?: (kind: MailboxKind, address: string) => readonly string[] | null
  /** The company's time zone (the declaration's `company.timeZone`), which the one line a calendar email without words is listed under says its time on (`summaryLine`). Left out: UTC. */
  zone?: string
}

/**
 * The statuses a refusal can carry, all HTTP ones the route will answer with.
 * 403: not allowed (the wrong Google account). 502: Google refused. 503: the
 * thing this needs is not configured. 413 and 415 are only the attachment read's:
 * a picture too large to serve, and a file that is not one of the four kinds.
 */
export type Refusal = 403 | 404 | 409 | 413 | 415 | 422 | 502 | 503

export type Result<T> = { ok: true; value: T } | { ok: false; status: Refusal; error: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (status: Refusal, error: string): Result<never> => ({ ok: false, status, error })

/**
 * What an agent's draft must satisfy that the owner's own need not: a one-line why, so they
 * know what it is for, and no em dash in the subject or body. Null when it passes, and
 * for anyone but the agent.
 */
function agentDraftRefusal(
  actor: string,
  subject: string,
  body: string,
  why: string,
  owner: string,
): Result<never> | null {
  if (!isAgent(actor)) return null
  if (why === '') return fail(422, draftNeedsWhy(owner))
  if ((subject + body).includes(EM_DASH)) return fail(422, 'Remove the em dash from the subject and body.')
  return null
}

/**
 * The owner sends these as themselves, and an em dash reads as machine-written. A draft
 * an AGENT writes with one is refused when it is made or edited, as the Outbox
 * refused it, and the text of ANY draft is refused again when it is sent
 * (MailStore.planSend), so a draft the owner typed or one carried in cannot go out with
 * one either. Typing one into a draft is not itself refused. Written as an escape so
 * this file has none.
 */
export const EM_DASH = '\u2014'

const TOO_LONG_SUBJECT = `A subject is one line of at most ${MAX_SUBJECT} characters.`

/** Why an edit or a delete that named a revision was refused: the draft is not the one its sender was shown. */
export const CHANGED_SINCE_SHOWN =
  'This draft was changed after it was shown, so nothing was changed. It is shown as it is now.'

export type Row = Record<string, unknown>

/** Who a draft is to, and the conversation it sits on (null for a new email or a contact's draft). */
type Recipient = Result<{
  identity: { id: string; contactId: string; kind: IdentityKind; address: string }
  conversationId: string | null
}>

/** An Outbox entry that has passed `checkOutboxEntry`: every field is the type it says. */
interface CheckedEntry {
  sourceRef: string
  body: string
  sentAt: string | null
  createdAt: string
  to: string
  classified: { kind: IdentityKind; address: string }
  subject: string
  why: string
}
/** A string, or '' for anything else: JSON from outside is never assumed to be the type it claims. */
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** `PENDING_STATUSES` (types.ts) as the SQL list every query of drafts uses. */
export const PENDING = `(${PENDING_STATUSES.map((s) => `'${s}'`).join(', ')})`

/**
 * The Gmail account a draft that chooses none goes out from: the owner's own address while it holds a token, else the oldest account that does. The ONE spelling of the rule,
 * run by `defaultGmailId` for a send and read inside `MESSAGE_SELECT` so a draft's card names the account the send will use.
 */
const defaultGmailSql = (owner: string, within = '1 = 1'): string =>
  `SELECT id FROM mailbox WHERE kind = 'gmail' AND refresh_token IS NOT NULL AND ${within} ORDER BY address = '${owner.replace(/'/g, "''")}' DESC, rowid LIMIT 1`

/** The select every message read starts from. A function of the owner's address, which the default Gmail account is read against. */
export const messageSelect = (owner: string): string => `
  SELECT m.id, m.conversation_id, m.direction, m.status, m.rev, m.subject, m.body, m.why,
         m.created_at, m.created_by, m.updated_by, m.sent_at, m.sent_by, m.source_ref,
         m.gmail_id, m.jmap_id, m.from_header, m.to_header, m.cc_header, m.snippet, m.body_truncated,
         m.attachments, m.labels, m.instruction_text, m.instruction_where, m.instruction_at, m.raw_key,
         m.edited_at, m.deleted_at, m.calendar,
         i.kind, i.address, i.contact_id, c.name AS contact_name,
         CASE WHEN m.direction = 'out' AND m.status = 'draft' THEN (SELECT value FROM setting WHERE key = 'telegram-send-failed:' || m.id) END AS send_refusal,
         CASE WHEN m.direction = 'out' THEN cf.address END AS sent_from,
         CASE WHEN m.direction = 'out' AND m.status IN ${PENDING} THEN sf.address END AS sends_from_address,
         CASE WHEN m.direction = 'out' AND m.status IN ${PENDING} THEN sf.display_name END AS sends_from_name
    FROM message m
    JOIN identity i ON i.id = m.identity_id
    JOIN contact c ON c.id = i.contact_id
    LEFT JOIN mailbox cf ON cf.id = m.mailbox_id AND cf.kind = 'cloudflare'
    LEFT JOIN conversation sc ON sc.id = m.conversation_id
    LEFT JOIN mailbox sf ON i.kind = 'email' AND sf.id = COALESCE(
      CASE WHEN m.conversation_id IS NOT NULL THEN sc.mailbox_id ELSE m.mailbox_id END,
      (${defaultGmailSql(owner)}))`

/** JSON out of a column the store itself wrote; anything unreadable is the empty value, never a throw. */
export function jsonArray<T>(v: unknown): T[] {
  if (typeof v !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/**
 * The picture a message the inbox sent carries, as Claude is told of it: type, length and fingerprint, never bytes. Present only on a kept photo entry that has a fingerprint (a file that arrived from Telegram has
 * none), read from the row's own `attachments`.
 */
function pictureOf(r: Row): { picture: NonNullable<MessageRow['picture']> } | Record<string, never> {
  if (typeof r.raw_key !== 'string' || !r.raw_key.startsWith('tg/')) return {}
  const file = jsonArray<AttachmentInfo>(r.attachments)[0]
  const tg = file?.tg
  if (!file || !tg || tg.kind !== 'photo' || tg.copy !== 'kept' || typeof tg.sha256 !== 'string') return {}
  return { picture: { type: file.mimeType ?? '', size: file.size, fingerprint: tg.sha256 } }
}

export function messageRow(r: Row): MessageRow {
  const calendar = parseCalendarSummary(r.calendar)
  return {
    id: text(r.id),
    conversationId: textOrNull(r.conversation_id),
    contactId: text(r.contact_id),
    contactName: text(r.contact_name),
    kind: text(r.kind) as IdentityKind,
    address: text(r.address),
    direction: text(r.direction) as 'in' | 'out',
    status: text(r.status) as MessageStatus,
    rev: Number(r.rev),
    subject: text(r.subject),
    body: text(r.body),
    why: text(r.why),
    createdAt: text(r.created_at),
    createdBy: text(r.created_by),
    updatedBy: text(r.updated_by),
    sentAt: textOrNull(r.sent_at),
    sentBy: textOrNull(r.sent_by),
    sourceRef: textOrNull(r.source_ref),
    // The three are written together (migration 6); a row missing any is no instruction at all.
    instruction:
      typeof r.instruction_text === 'string' &&
      typeof r.instruction_where === 'string' &&
      typeof r.instruction_at === 'string'
        ? { text: r.instruction_text, where: r.instruction_where, at: r.instruction_at }
        : null,
    gmailId: textOrNull(r.gmail_id),
    ...(typeof r.jmap_id === 'string' && { jmapId: r.jmap_id }),
    from: text(r.from_header),
    to: text(r.to_header),
    cc: text(r.cc_header),
    snippet: text(r.snippet),
    bodyTruncated: Number(r.body_truncated) === 1,
    attachments: jsonArray<AttachmentInfo>(r.attachments),
    ...(calendar !== null && { calendar }),
    labels: jsonArray<string>(r.labels),
    ...(typeof r.raw_key === 'string' && { rawKey: r.raw_key }),
    ...pictureOf(r),
    ...(typeof r.edited_at === 'string' && { editedAt: r.edited_at }),
    ...(typeof r.deleted_at === 'string' && { deletedAt: r.deleted_at }),
    ...(typeof r.send_refusal === 'string' && { refusal: r.send_refusal }),
    ...(typeof r.sent_from === 'string' && { sentFrom: r.sent_from }),
    ...(typeof r.sends_from_address === 'string' && {
      sendsFrom: { name: text(r.sends_from_name) || r.sends_from_address, address: r.sends_from_address },
    }),
  }
}

/**
 * A full ISO 8601 timestamp: date, time and an offset. Anything shorter is
 * refused, because `new Date('1')` is the year 2001 and a sent time that is a
 * guess is worse than a refusal.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

/** A timestamp from outside, normalized to ISO UTC, or null when it is not a full ISO timestamp. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value.trim())) return null
  const parsed = new Date(value.trim())
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** The columns the read and open rules need of a message, as `FOLD_SELECT` reads them. */
const FOLD_SELECT = `
  SELECT m.conversation_id, m.identity_id, m.gmail_id, m.jmap_id, m.status, m.direction, m.labels, m.list_unsubscribe, m.clef_junk,
         m.read_at, m.read_by, m.closed_at, m.closed_by, coalesce(m.sent_at, m.created_at) AS at
    FROM message m`

interface FoldRow {
  identityId: string | null
  clefJunk: number | null
  /** The server holds it (it has a Gmail or a JMAP id): a message marked sent by hand, or a draft, has neither and takes no part in a labelled conversation. */
  server: boolean
  draft: boolean
  inbound: boolean
  labels: string[]
  listUnsubscribe: boolean
  readAt: string | null
  readBy: string | null
  closedAt: string | null
  closedBy: string | null
  at: string
}

const foldRow = (r: Row): FoldRow => ({
  identityId: textOrNull(r.identity_id),
  clefJunk: typeof r.clef_junk === 'number' ? r.clef_junk : null,
  server: r.gmail_id !== null || r.jmap_id !== null,
  draft: isPending(text(r.status) as MessageStatus),
  inbound: text(r.direction) === 'in',
  labels: jsonArray<string>(r.labels),
  listUnsubscribe: Number(r.list_unsubscribe) === 1,
  readAt: textOrNull(r.read_at),
  readBy: textOrNull(r.read_by),
  closedAt: textOrNull(r.closed_at),
  closedBy: textOrNull(r.closed_by),
  at: text(r.at),
})

/**
 * THE RULES for whether a conversation is read and open, in one place (every
 * caller, one conversation or the whole queue, goes through here).
 *
 * An email conversation (`viaGmail`: it has a mailbox) counts only the messages
 * that came from Gmail, and reads Gmail's labels: unread while any carries UNREAD,
 * open while any carries INBOX. A message in the trash or spam, or a draft, is
 * NOT COUNTED: Gmail keeps it out of the Inbox and out of the unread count, and
 * one thread deleted in Gmail would otherwise stay open here for ever. A message
 * marked sent by hand on an email thread has no Gmail id and takes no part. A
 * manual conversation reads the stamps: unread while a message that is not a draft
 * has no read stamp, open while one has no closed stamp.
 *
 * `readBy` and `closedBy` come from the newest stamp, and only while the state
 * they describe is true of the whole conversation (read, closed), so an unread or
 * open conversation shows nobody. The envelope is the newest message that came IN
 * from Gmail and is counted.
 */
function foldConversation(
  kind: MailboxKind | null,
  all: FoldRow[],
  automated: ReadonlyMap<string, SenderJudgment> = new Map(),
): { state: ConversationState; newestInbound: Envelope | null } {
  // The labels are the truth for Gmail and for JMAP (the server's, mirrored); a Cloudflare, Telegram or manual conversation reads the stamps.
  const viaGmail = labelsAreTruth(kind)
  const counted = all.filter((r) => (viaGmail ? r.server && inPlay(r.labels) : !r.draft))
  const unread = counted.some((r) => (viaGmail ? r.labels.includes(LABEL.unread) : r.readAt === null))
  const open = counted.some((r) => (viaGmail ? r.labels.includes(LABEL.inbox) : r.closedAt === null))

  const newest = (pick: (r: FoldRow) => { at: string | null; by: string | null }) => {
    let found: { at: string | null; by: string | null } = { at: null, by: null }
    for (const r of counted) {
      const stamp = pick(r)
      if (stamp.at !== null && (found.at === null || stamp.at >= found.at)) found = stamp
    }
    return found
  }
  const read = unread ? { at: null, by: null } : newest((r) => ({ at: r.readAt, by: r.readBy }))
  const closed = open ? { at: null, by: null } : newest((r) => ({ at: r.closedAt, by: r.closedBy }))

  // The newest message that came in: from Gmail for a Gmail conversation, and any inbound one for a Cloudflare conversation (which
  // has no Gmail id). Its envelope is what Bulk is judged from; a Cloudflare one adds its sender's judgment and the spam classifier's score.
  let inbound: FoldRow | null = null
  for (const r of counted) {
    const comes = viaGmail ? r.server && r.inbound : (kind === 'cloudflare' || kind === 'telegram') && r.inbound
    if (comes && (inbound === null || r.at >= inbound.at)) inbound = r
  }
  // Every kind carries the sender's judgment; only a Cloudflare message has a score, and only a Gmail one has labels (a Telegram message has neither: a bot is Bulk by the sender's judgment alone).
  const envelope = (r: FoldRow): Envelope => {
    const automatedSender = r.identityId !== null && automated.has(r.identityId)
    return kind === 'cloudflare'
      ? { labels: [], listUnsubscribe: r.listUnsubscribe, automated: automatedSender, clefJunk: r.clefJunk }
      : { labels: r.labels, listUnsubscribe: r.listUnsubscribe, automated: automatedSender }
  }

  return {
    state: { unread, open, readBy: read.by, readAt: read.at, closedBy: closed.by, closedAt: closed.at },
    newestInbound: inbound ? envelope(inbound) : null,
  }
}

/** Somebody a header named: the normalized address, and the name it came with ('' when it came with none). */
interface Person {
  address: string
  name: string
}

/**
 * Where a reply on an email conversation goes and how it is threaded, worked out from
 * the messages the inbox holds. See `Inbox.replyPlan`.
 */
export interface ReplyPlan {
  /** Who a reply goes to: the newest inbound message's Reply-To, else its From, never us. Null when there is nobody but us. */
  to: Person | null
  /** Everyone on the message being answered, less us, the default recipient first: what "copy everyone" works from. */
  everyone: string[]
  /** The subject a reply takes: the conversation's, as one plain line, with a "Re: " unless it has one. */
  subject: string
  /** The Message-ID of the message being answered, or null when none is recorded. */
  inReplyTo: string | null
  /** The Gmail id of the inbound message whose Reply-To was never recorded (stored before Reply-To was recorded), or null. */
  replyToUnknown: string | null
}

/** `{ chat }` for the identity of a Telegram group or channel (`telegram_person.chat`), nothing for any other. */
const chatOf = (v: unknown): { chat: 'group' | 'channel' } | Record<string, never> =>
  v === 'group' || v === 'channel' ? { chat: v } : {}

/** The Client columns off a contact row, as the wire shape. */
function contactClient(r: Row): ContactClient {
  return {
    clientId: r.client_id === null || r.client_id === undefined ? null : Number(r.client_id),
    clientSetBy: textOrNull(r.client_set_by),
    clientSetAt: textOrNull(r.client_set_at),
  }
}

/** What the audit keeps of a contact's Client. */
const clientOf = (c: ContactClient) => ({ clientId: c.clientId, setBy: c.clientSetBy, setAt: c.clientSetAt })

/** The Client ids on some contact rows, each once, ascending. */
const distinctClientIds = (people: Row[]): number[] => {
  const ids = people.map((p) => contactClient(p).clientId).filter((id): id is number => id !== null)
  return [...new Set(ids)].sort((a, b) => a - b)
}

/** A Cloudflare mailbox as the sender of a reply: nothing in it is secret. */
export interface CloudflareSender {
  id: string
  /** Lower case, bare. */
  address: string
  name: string
  /** Lower case: the part after the @. Every address on it is ours. */
  domain: string
}

/**
 * Whether an address is the Cloudflare mailbox's own or on its domain: never a recipient of a reply, never copied, never an
 * outside participant, never a sender whose mail notifies. The one place that says it.
 */
export const belongsToMailbox = (sender: CloudflareSender, address: string): boolean =>
  address === sender.address || address.endsWith(`@${sender.domain}`)

const cloudflareSender = (r: Row): CloudflareSender => {
  const address = text(r.address).toLowerCase()
  return { id: text(r.id), address, name: text(r.display_name), domain: address.split('@')[1] ?? '' }
}

/**
 * What marks a conversation in a mailbox: the mailbox it is in (a Cloudflare mailbox, or one of the owner's Gmail accounts, whose name is its short label)
 * and its kind, and a person's call on it, if there is one. Nothing at all for a manual conversation. Reads
 * `mailbox_kind`, `mailbox_id`, `mailbox_name`, `mailbox_address`, `sort` and `sort_by` off a conversation joined to its mailbox.
 */
function mailboxFacts(r: Row): {
  mailbox?: MailboxMark
  mailboxKind?: MailboxKind
  spamCall?: SpamCall
} {
  // A person's call on Bulk is on a conversation in any kind of mailbox.
  if (!isMailboxKind(r.mailbox_kind)) return {}
  const call = spamCallOf(textOrNull(r.sort), textOrNull(r.sort_by))
  const address = text(r.mailbox_address)
  return {
    mailbox: { id: text(r.mailbox_id), name: text(r.mailbox_name) || address, address },
    mailboxKind: r.mailbox_kind,
    ...(call && { spamCall: call }),
  }
}

/**
 * A person's call on spam, from the two columns migration 11 explains: `sort_by` is whoever set it, and a row the old assistant
 * wrote (its actor, or none) is no call at all. A call is Bulk when `sort` holds one of the words that meant Bulk.
 */
export function spamCallOf(sort: string | null, sortBy: string | null): SpamCall | undefined {
  if (sortBy === null || sortBy === ASSISTANT_ACTOR) return undefined
  return {
    spam: sort === 'spam' || sort === 'promotional' || sort === 'newsletter',
    by: isAgent(sortBy) ? 'claude' : 'owner',
  }
}

export class Inbox {
  constructor(protected readonly ports: InboxPorts) {}

  /** The install's owner, as the parts that say their name or compare an actor with them ask for it. */
  get owner(): InboxOwner {
    return this.ports.owner
  }

  // ─── who is on which mailbox, and so who may see what (src/queue.ts is the rule, src/store/people.ts the lists) ───

  /** Whether an actor is a person of the install: the owner or anyone the declaration lists. Claude's actor (`agent:`) is not a person; it acts for the owner. */
  protected isTeam(actor: string): boolean {
    return this.ports.owner.team.includes(personKey(actor))
  }

  /**
   * What an actor reads with: the mailboxes the person is on, and what belongs to no mailbox only if they are the owner. Claude acts for the owner and reads with the owner's scope. Anyone else (an address no
   * install lists) is on nothing and sees nothing. Public because the space's part asks it once per request (it is on `STORE_METHODS`); it changes nothing.
   */
  mailScope(actor: string): MailScope {
    const who = isAgent(actor) ? this.ports.owner.email : personKey(actor)
    return scopeOf(mailboxesOfPerson(this.sql, who), who === this.ports.owner.email)
  }

  /** The contact an identity (an address, a number, a handle) belongs to, or null for none: what a route that names an identity asks before it asks whether the contact is the caller's to touch. */
  contactIdOfIdentity(identityId: string): string | null {
    const r = this.sql.exec(`SELECT contact_id FROM identity WHERE id = ?1`, identityId).toArray()[0]
    return r ? text(r.contact_id) : null
  }

  /**
   * What a write is checked against: a person's scope, or Claude's (the owner's), and for the store's own jobs (the assistant, a sync, an arrival, a carry: an actor that is neither a person of the install nor Claude)
   * everything, since they act for no person. Nothing a person can name reaches here as an actor but through a gate that admitted them as a person of the install.
   */
  protected writerScope(actor: string): MailScope {
    return this.isTeam(actor) || isAgent(actor) ? this.mailScope(actor) : ALL_MAIL
  }

  /** The people on a mailbox, by the address they sign in as. */
  whoIsOn(mailboxId: string): string[] {
    return peopleOnMailbox(this.sql, mailboxId)
  }

  /** Every mailbox the scope may see, with who is on it: the read behind Claude's `mailbox-people`, for the sitting that checks a deploy (nothing in it is mail). */
  mailboxPeopleList(
    scope: MailScope = ALL_MAIL,
  ): { id: string; kind: MailboxKind; address: string; name: string; people: string[] }[] {
    return this.sql
      .exec(`SELECT id, kind, address, display_name FROM mailbox ORDER BY rowid`)
      .toArray()
      .filter((r) => canSee(scope, text(r.id)))
      .map((r) => ({
        id: text(r.id),
        kind: text(r.kind) as MailboxKind,
        address: text(r.address),
        name: text(r.display_name),
        people: peopleOnMailbox(this.sql, text(r.id)),
      }))
  }

  /**
   * Put the people on a mailbox just made: the install's say for a declared mailbox, the connector for a Gmail account (`connector`), the owner for anything else. Called inside the transaction that made the row, so a
   * mailbox is never seen without its people.
   */
  protected seatMailbox(id: string, kind: MailboxKind, address: string, connector: string | null): void {
    const declared = this.ports.mailboxPeople?.(kind, address) ?? null
    const people =
      declared !== null && declared.length > 0
        ? declared
        : kind === 'gmail' && connector !== null
          ? [connector]
          : [this.ports.owner.email]
    putPeople(this.sql, id, people, kind === 'gmail' ? (connector ?? this.ports.owner.email) : kind, this.now())
  }

  /**
   * Make every mailbox's people agree with what the install says (`mailboxPeople`), and leave none with nobody on it: run when the object starts, before it serves a request. Answers how many rows changed, which is
   * none once it has settled. A person added or taken off a declared mailbox is therefore a deploy of the declaration and nothing more.
   */
  settleMailboxPeople(): number {
    const source = this.ports.mailboxPeople
    return settlePeople(
      this.sql,
      { owner: this.ports.owner.email, team: this.ports.owner.team, peopleOf: source ?? (() => null) },
      this.now(),
    )
  }

  /** The mailbox a conversation is in: `{ mailboxId: null }` for one in none, null for no such conversation. */
  mailboxOfConversation(conversationId: string): { mailboxId: string | null } | null {
    const r = this.sql.exec(`SELECT mailbox_id FROM conversation WHERE id = ?1`, conversationId).toArray()[0]
    return r ? { mailboxId: textOrNull(r.mailbox_id) } : null
  }

  /**
   * The mailbox a message belongs to: its conversation's, and for a draft on no conversation (a new email) the one it records, which is none for a draft from before they recorded one. `{ mailboxId: null }` is
   * none; null is no such message.
   */
  mailboxOfMessage(messageId: string): { mailboxId: string | null } | null {
    const r = this.sql
      .exec(
        `SELECT m.conversation_id, m.mailbox_id, cv.mailbox_id AS conversation_mailbox_id FROM message m LEFT JOIN conversation cv ON cv.id = m.conversation_id WHERE m.id = ?1`,
        messageId,
      )
      .toArray()[0]
    if (!r) return null
    return { mailboxId: textOrNull(r.conversation_id === null ? r.mailbox_id : r.conversation_mailbox_id) }
  }

  /**
   * The mailbox a message goes out from, which is the one that decides whether its sender may send it: its conversation's, and for a draft on no conversation the one it records, else the Gmail account that would
   * send it (the default). Null is none, which only the owner is let send (a draft from before they recorded one, with no Gmail account to send it).
   */
  protected sendingMailboxOf(msg: { id: string; conversationId: string | null }): string | null {
    const where = this.mailboxOfMessage(msg.id)
    if (where === null) return null
    if (where.mailboxId !== null || msg.conversationId !== null) return where.mailboxId
    return this.defaultGmailId()
  }

  private selected?: string

  /** The select of every message read, made once for this owner. */
  protected messageSelect(): string {
    if (this.selected === undefined) this.selected = messageSelect(this.ports.owner.email)
    return this.selected
  }

  protected get sql(): InboxSql {
    return this.ports.sql
  }

  protected now(): string {
    return this.ports.now().toISOString()
  }

  /** Writes one audit entry and answers its id (a merge names its entry, which is what its undo reads back). */
  protected audit(actor: string, action: string, subject: string, before: unknown, after: unknown): number {
    this.sql.exec(
      `INSERT INTO audit (at, actor, action, subject, before, after) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      this.now(),
      actor,
      action,
      subject,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
    )
    return Number(this.sql.exec(`SELECT last_insert_rowid() AS id`).one().id)
  }

  // ─── contacts ────────────────────────────────────────────────────────

  private identitiesOf(contactId: string): IdentityRow[] {
    return this.sql
      .exec(
        `SELECT i.id, i.kind, i.address, tp.bot, tp.chat FROM identity i LEFT JOIN telegram_person tp ON tp.identity_id = i.id
          WHERE i.contact_id = ?1 ORDER BY i.created_at, i.rowid`,
        contactId,
      )
      .toArray()
      .map((r) => ({
        id: text(r.id),
        kind: text(r.kind) as IdentityKind,
        address: text(r.address),
        ...(Number(r.bot) === 1 && { bot: true as const }),
        ...chatOf(r.chat),
      }))
  }

  /**
   * For each contact: how many conversations it is on and how many of those are Bulk, by the queue's one rule
   * (so a conversation with a Client's person on it is never Bulk). What the rule for automated senders reads
   * (src/automated.ts); one read of the whole table, as the queue's counts are.
   */
  protected bulkByContact(): Map<string, { conversations: number; bulk: number }> {
    const bulk = new Set(
      this.queueFacts(null)
        .filter((f) => isBulk(f))
        .map((f) => f.id),
    )
    const out = new Map<string, { conversations: number; bulk: number }>()
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT i.contact_id AS contact_id, p.conversation_id AS conversation_id
           FROM participant p JOIN identity i ON i.id = p.identity_id`,
      )
      .toArray()) {
      const held = out.get(text(r.contact_id)) ?? { conversations: 0, bulk: 0 }
      held.conversations += 1
      if (bulk.has(text(r.conversation_id))) held.bulk += 1
      out.set(text(r.contact_id), held)
    }
    return out
  }

  /** Whether a contact is a person or an automated sender: the one place the store calls the rule (src/automated.ts). */
  private senderOf(
    name: string,
    clientId: number | null,
    identities: IdentityRow[],
    conversations: number,
    bulkConversations: number,
  ): SenderJudgment {
    return judgeSender({ name, clientId, identities, conversations, bulkConversations })
  }

  /**
   * One contact judged as its page judges it (getContact), for a caller that needs the judgment and not the card:
   * the notification rule (MailStore.applyHistoryPage), which must call a person exactly who the contact page calls one.
   */
  protected contactSender(
    id: string,
    name: string,
    clientId: number | null,
    counts: Map<string, { conversations: number; bulk: number }> = this.bulkByContact(),
  ): SenderJudgment {
    const held = counts.get(id) ?? { conversations: 0, bulk: 0 }
    return this.senderOf(name, clientId, this.identitiesOf(id), held.conversations, held.bulk)
  }

  /**
   * The contacts a scope may see (`visibleContactIds`), each with the conversations and drafts the scope may see (the counts and the mailboxes are the scope's, never the whole store's: a count over mail that is not the
   * person's would give it away). The judgment of who is an automated sender reads the whole store, as it always has: it says what a contact is, and shows no mail.
   */
  listContacts(scope: MailScope = ALL_MAIL): ContactListItem[] {
    const counts = this.bulkByContact()
    const seen = this.visibleContactIds(scope)
    const inConv = scopeWhere(scope, 'cv.mailbox_id', 1)
    // The Cloudflare mailboxes each contact is in, one read for all of them.
    const inMailboxes = new Map<string, string[]>()
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT i.contact_id AS contact_id, cv.mailbox_id AS mailbox_id
           FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN conversation cv ON cv.id = p.conversation_id
           JOIN mailbox mb ON mb.id = cv.mailbox_id
          WHERE mb.kind IN ('cloudflare', 'jmap') AND ${inConv.sql}
          ORDER BY mb.rowid`,
        ...inConv.bindings,
      )
      .toArray()) {
      const held = inMailboxes.get(text(r.contact_id)) ?? []
      held.push(text(r.mailbox_id))
      inMailboxes.set(text(r.contact_id), held)
    }
    const convs = scopeWhere(scope, 'sc.mailbox_id', 1)
    const drafts = scopeWhere(scope, MESSAGE_MAILBOX('m', 'dc'), 1 + convs.bindings.length)
    return this.sql
      .exec(
        `SELECT c.id, c.name, c.client_id, c.client_set_by, c.client_set_at,
                (SELECT count(DISTINCT p.conversation_id) FROM participant p
                   JOIN identity i ON i.id = p.identity_id
                   JOIN conversation sc ON sc.id = p.conversation_id
                  WHERE i.contact_id = c.id AND ${convs.sql}) AS conversations,
                (SELECT count(*) FROM message m JOIN identity i ON i.id = m.identity_id
                   LEFT JOIN conversation dc ON dc.id = m.conversation_id
                  WHERE i.contact_id = c.id AND m.status IN ${PENDING} AND ${drafts.sql}) AS drafts
           FROM contact c
          ORDER BY lower(c.name), c.rowid`,
        ...convs.bindings,
        ...drafts.bindings,
      )
      .toArray()
      .filter((r) => seen === null || seen.has(text(r.id)))
      .map((r) => {
        const id = text(r.id)
        const client = contactClient(r)
        const identities = this.identitiesOf(id)
        const conversations = Number(r.conversations)
        // The judgment of who is an automated sender is made over the WHOLE store, both numbers (`getContact`'s too, `contactSender`), so People's list and the contact's page agree whatever the scope; the count shown is the scope's.
        const whole = counts.get(id) ?? { conversations: 0, bulk: 0 }
        return {
          id,
          name: text(r.name),
          ...client,
          sender: this.senderOf(text(r.name), client.clientId, identities, whole.conversations, whole.bulk),
          identities,
          conversations,
          drafts: Number(r.drafts),
          mailboxIds: inMailboxes.get(id) ?? [],
        }
      })
  }

  getContact(id: string, scope: MailScope = ALL_MAIL): Result<ContactCard> {
    const row = this.sql
      .exec(`SELECT id, name, client_id, client_set_by, client_set_at FROM contact WHERE id = ?1`, id)
      .toArray()[0]
    if (!row || !(this.visibleContactIds(scope)?.has(id) ?? true)) return fail(404, 'No such contact.')
    const onDrafts = scopeWhere(scope, MESSAGE_MAILBOX('m', 'sc'), 2)
    const onConversations = scopeWhere(scope, 'c.mailbox_id', 2)
    const drafts = this.sql
      .exec(
        `${this.messageSelect()} WHERE i.contact_id = ?1 AND m.status IN ${PENDING} AND ${onDrafts.sql} ORDER BY m.created_at DESC, m.rowid DESC`,
        id,
        ...onDrafts.bindings,
      )
      .toArray()
      .map(messageRow)
    const client = contactClient(row)
    const identities = this.identitiesOf(id)
    return ok({
      id,
      name: text(row.name),
      ...client,
      sender: this.contactSender(id, text(row.name), client.clientId),
      identities,
      conversations: this.conversationsWhere(
        `c.id IN (SELECT p.conversation_id FROM participant p JOIN identity i ON i.id = p.identity_id WHERE i.contact_id = ?1) AND ${onConversations.sql}`,
        [id, ...onConversations.bindings],
        QUEUE_PAGE,
      ),
      drafts,
      ...this.sendsFromOf(id, scope),
    })
  }

  /**
   * The contacts a scope may see (`contactSeen`, src/queue.ts: on a conversation or holding a draft in a mailbox they are on; the owner also sees one on none), or null for every contact (the scope sees everything, and
   * nothing is read to say so).
   */
  protected visibleContactIds(scope: MailScope): Set<string> | null {
    if (this.scopeCoversEverything(scope)) return null
    const inBoxes = new Map<string, (string | null)[]>()
    const note = (contactId: unknown, mailboxId: unknown) => {
      const held = inBoxes.get(text(contactId)) ?? []
      held.push(textOrNull(mailboxId))
      inBoxes.set(text(contactId), held)
    }
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT i.contact_id AS contact_id, cv.mailbox_id AS mailbox_id
           FROM participant p JOIN identity i ON i.id = p.identity_id JOIN conversation cv ON cv.id = p.conversation_id`,
      )
      .toArray()) {
      note(r.contact_id, r.mailbox_id)
    }
    // A draft on no conversation (a new email) belongs to the mailbox it records, and its person is the one it is to.
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT i.contact_id AS contact_id, m.mailbox_id AS mailbox_id
           FROM message m JOIN identity i ON i.id = m.identity_id WHERE m.conversation_id IS NULL AND m.status IN ${PENDING}`,
      )
      .toArray()) {
      note(r.contact_id, r.mailbox_id)
    }
    return new Set(
      this.sql
        .exec(`SELECT id FROM contact`)
        .toArray()
        .map((r) => text(r.id))
        .filter((id) => contactSeen(scope, inBoxes.get(id) ?? [])),
    )
  }

  /**
   * Whether a scope sees everything the store holds: it has what belongs to no mailbox and every mailbox there is (the owner's, in an install where they are on all of them, as Tessa is in the bundled invented one). Then no cut is
   * needed and none is paid for: a read that would work out what the scope may see answers everything at once.
   */
  protected scopeCoversEverything(scope: MailScope): boolean {
    if (!scope.unfiled) return false
    if (scope.mailboxIds === null) return true
    return (
      this.sql
        .exec(
          `SELECT 1 FROM mailbox WHERE id NOT IN (SELECT value FROM json_each(?1)) LIMIT 1`,
          JSON.stringify(scope.mailboxIds),
        )
        .toArray().length === 0
    )
  }

  /** `sendsFrom` for a contact's card: where a new email to them would go out from, whichever kind of account that is. */
  protected sendsFromOf(contactId: string, scope: MailScope = ALL_MAIL): { sendsFrom?: SendsFrom } {
    const sender = this.newEmailSender(contactId, scope)
    return sender ? { sendsFrom: { name: sender.name || sender.address, address: sender.address } } : {}
  }

  /**
   * The account a new email to this contact goes out from when the person chooses none: the mailbox they last wrote to (while its grant works), else the default Gmail account; null
   * when there is neither (no Gmail account is connected). The one rule behind a card's `sendsFrom` and a draft's recorded account.
   */
  protected newEmailSender(contactId: string, scope: MailScope = ALL_MAIL): CloudflareSender | null {
    const last = this.mailboxContactLastWroteTo(contactId, scope)
    if (last) return last.sender
    const id = this.defaultGmailId(scope)
    return id === null ? null : this.gmailMailboxSender(id)
  }

  /**
   * Rename a contact. The revision goes up with the name (a rename is a change of the contact, like its fields or a merge), so a screen opened before it is refused by any write that names the
   * revision it was shown. `guard` is that revision as the caller saw it (the space's People): a contact that moved on since is refused with 409 and keeps its name. Without it (the inbox's own page)
   * there is no guard, as before.
   */
  renameContact(id: string, name: string, actor: string, guard?: { rev: number }): Result<ContactRow> {
    const clean = name.trim()
    if (clean === '') return fail(422, 'A contact needs a name.')
    return this.ports.transaction(() => {
      const before = this.sql.exec(`SELECT name, profile_rev FROM contact WHERE id = ?1`, id).toArray()[0]
      if (!before) return fail(404, 'No such contact.')
      if (guard && guard.rev !== Number(before.profile_rev)) {
        return fail(
          409,
          'This person changed since you opened them, so nothing was renamed. They are shown as they are now.',
        )
      }
      this.sql.exec(`UPDATE contact SET name = ?2, profile_rev = profile_rev + 1 WHERE id = ?1`, id, clean)
      this.audit(actor, 'contact.rename', `contact:${id}`, { name: text(before.name) }, { name: clean })
      return ok(this.contactRow(id) as ContactRow)
    })
  }

  /** One contact as a row, or null: its name, its addresses and its Client. */
  protected contactRow(id: string): ContactRow | null {
    const r = this.sql
      .exec(`SELECT id, name, client_id, client_set_by, client_set_at FROM contact WHERE id = ?1`, id)
      .toArray()[0]
    return r ? { id, name: text(r.name), ...contactClient(r), identities: this.identitiesOf(id) } : null
  }

  // ─── Clients: assigning, merging, splitting ──────────────────────────

  /**
   * Put a contact under a Client, or take it out (`null`). The ONLY way a contact gets a
   * Client: an explicit assignment by the owner or the agent, audited with its actor and
   * stamped on the contact, and nothing assigns by matching an address (a suggestion is
   * computed elsewhere and takes effect only when somebody accepts it, by calling this).
   * Accepting a suggestion is not a different write.
   *
   * ⚠️ THIS DOES NOT CHECK THAT THE CLIENT EXISTS. It cannot: Clients are the Clients
   * part's, and this store keeps no list. The Worker asks the part first and refuses an
   * id it does not hold, or holds archived, with 422 (src/clients.ts `checkLink`), and that is the only caller. Clearing needs no
   * such check, since nothing is being attached.
   *
   * A repeat of what is already so changes nothing and writes no audit entry, so the
   * stamp keeps saying who FIRST put the contact there.
   */
  assignClient(contactId: string, clientId: number | null, actor: string): Result<ContactRow> {
    if (clientId !== null && !isClientId(clientId)) {
      return fail(422, 'A Client id is a whole number.')
    }
    return this.ports.transaction(() => {
      const before = this.contactRow(contactId)
      if (!before) return fail(404, 'No such contact.')
      if (before.clientId === clientId) return ok(before)
      const at = this.now()
      this.sql.exec(
        `UPDATE contact SET client_id = ?2, client_set_by = ?3, client_set_at = ?4 WHERE id = ?1`,
        contactId,
        clientId,
        clientId === null ? null : actor,
        clientId === null ? null : at,
      )
      const after = this.contactRow(contactId) as ContactRow
      this.audit(
        actor,
        clientId === null ? 'contact.clear-client' : 'contact.assign-client',
        `contact:${contactId}`,
        clientOf(before),
        clientOf(after),
      )
      return ok(after)
    })
  }

  /**
   * Merge two contacts who are the same person. Every address of the absorbed contact
   * moves to the survivor, which keeps its own name and its own Client unless it has none,
   * and then the absorbed contact is deleted. Conversations and messages follow with no
   * rewrite, because they know their people only through identities (migration 0), which is
   * also what makes a merge undoable: `splitIdentity` moves an address back out, and
   * `undoMerge` (src/store/space.ts) puts the whole merge back from the audit entry.
   *
   * The survivor's business, role and note (migration 12) follow the Client's rule: its own
   * stay, and one it leaves blank takes the absorbed contact's. Its revision goes up, because
   * the merge changed it.
   *
   * The audit keeps BOTH contacts as they were (their addresses, their Client and their
   * profile), so what a merge discarded, the absorbed contact's name and a Client the survivor's
   * own displaced, can be read back and restored: by hand, or by `undoMerge`. Two contacts under
   * DIFFERENT Clients merge anyway, under the survivor's: the option says the survivor keeps its
   * own, and the audit is where the other one is recorded.
   *
   * `guard` is the revisions of the two contacts as the caller saw them (the space's People): a
   * merge of a contact that changed since is refused with 409 and changes nothing. Without it
   * (the inbox's own page) there is no guard, as before. The answer carries `mergeId`, the audit
   * entry that `undoMerge` takes.
   */
  mergeContacts(
    survivorId: string,
    absorbedId: string,
    actor: string,
    guard?: { survivorRev: number; absorbedRev: number },
  ): Result<ContactRow & { mergeId: number }> {
    if (survivorId === absorbedId) return fail(422, 'That is one contact; a merge needs two.')
    return this.ports.transaction(() => {
      const survivor = this.contactRow(survivorId)
      const absorbed = this.contactRow(absorbedId)
      if (!survivor || !absorbed) return fail(404, 'No such contact.')
      const survivorProfile = this.profileRow(survivorId) as ContactProfile
      const absorbedProfile = this.profileRow(absorbedId) as ContactProfile
      if (guard && (guard.survivorRev !== survivorProfile.rev || guard.absorbedRev !== absorbedProfile.rev)) {
        return fail(
          409,
          'One of them changed since you opened it, so nothing was merged. They are shown as they are now.',
        )
      }
      const made = this.sql.exec(`SELECT created_at, created_by FROM contact WHERE id = ?1`, absorbedId).one()
      this.sql.exec(`UPDATE identity SET contact_id = ?1 WHERE contact_id = ?2`, survivorId, absorbedId)
      if (survivor.clientId === null && absorbed.clientId !== null) {
        this.sql.exec(
          `UPDATE contact SET client_id = ?2, client_set_by = ?3, client_set_at = ?4 WHERE id = ?1`,
          survivorId,
          absorbed.clientId,
          absorbed.clientSetBy,
          absorbed.clientSetAt,
        )
      }
      this.setProfile(survivorId, {
        business: survivorProfile.business || absorbedProfile.business,
        role: survivorProfile.role || absorbedProfile.role,
        notes: survivorProfile.notes || absorbedProfile.notes,
      })
      this.sql.exec(`DELETE FROM contact WHERE id = ?1`, absorbedId)
      const after = this.contactRow(survivorId) as ContactRow
      const mergeId = this.audit(
        actor,
        'contact.merge',
        `contact:${survivorId}`,
        {
          survivor,
          absorbed,
          profiles: { survivor: survivorProfile, absorbed: absorbedProfile },
          absorbedMade: { at: text(made.created_at), by: text(made.created_by) },
        },
        { survivor: after, profile: this.profileRow(survivorId) },
      )
      return ok({ ...after, mergeId })
    })
  }

  /**
   * Write a contact's business, role and note and raise its revision by one: the one place the fields are written (a save, a merge and an undone merge), so the revision
   * can never fail to move with them. The caller has checked the revision it was given.
   */
  protected setProfile(id: string, fields: { business: string; role: string; notes: string }): void {
    this.sql.exec(
      `UPDATE contact SET business = ?2, role = ?3, notes = ?4, profile_rev = profile_rev + 1 WHERE id = ?1`,
      id,
      fields.business,
      fields.role,
      fields.notes,
    )
  }

  /** A contact's business, role, note and revision (migration 12), or null for no such contact. */
  protected profileRow(id: string): ContactProfile | null {
    const r = this.sql.exec(`SELECT business, role, notes, profile_rev FROM contact WHERE id = ?1`, id).toArray()[0]
    return r
      ? { business: text(r.business), role: text(r.role), notes: text(r.notes), rev: Number(r.profile_rev) }
      : null
  }

  /**
   * Split one address off a contact onto a new contact of its own, with no Client, named by
   * the address (rename it from there). Undoes a wrong merge: the address, its conversations
   * and its messages go with it, and the old contact keeps the rest. A contact's only address
   * cannot be split off: there would be nothing left of it, and a "split" that only renames
   * is a rename.
   *
   * A Gmail thread follows the address by itself, because a conversation knows its people
   * only through identities. A HAND-LOGGED one (a text, a DM) can have two of the contact's
   * addresses on it, because a contact has one conversation per channel; the address's
   * messages in such a shared conversation move onto a conversation of the new contact's, so
   * the two people's histories part as well as their names. One that was only ever this
   * address's needs nothing.
   *
   * The contact it comes off has its revision raised (its addresses changed). `guard` names that
   * contact and the revision the caller was shown (the space's People): an address that is not that
   * contact's is 404 "No such address.", and a contact that moved on since is 409 with nothing split.
   * Without it (the inbox's own page) there is no guard, as before.
   */
  splitIdentity(
    identityId: string,
    actor: string,
    guard?: { contactId: string; rev: number },
  ): Result<{ from: ContactRow; contact: ContactRow }> {
    return this.ports.transaction(() => {
      const identity = this.sql
        .exec(`SELECT id, contact_id, address FROM identity WHERE id = ?1`, identityId)
        .toArray()[0]
      if (!identity) return fail(404, 'No such address.')
      const fromId = text(identity.contact_id)
      if (guard) {
        if (guard.contactId !== fromId) return fail(404, 'No such address.')
        const held = this.profileRow(fromId) as ContactProfile
        if (guard.rev !== held.rev) {
          return fail(
            409,
            'This person changed since you opened them, so nothing was split. They are shown as they are now.',
          )
        }
      }
      const before = this.contactRow(fromId) as ContactRow
      if (before.identities.length < 2) {
        return fail(422, 'That is this contact’s only address, so there is nothing to split off.')
      }
      const contactId = this.ports.newId()
      this.sql.exec(
        `INSERT INTO contact (id, name, created_at, created_by) VALUES (?1, ?2, ?3, ?4)`,
        contactId,
        text(identity.address),
        this.now(),
        actor,
      )
      this.sql.exec(`UPDATE identity SET contact_id = ?2 WHERE id = ?1`, identityId, contactId)
      this.sql.exec(`UPDATE contact SET profile_rev = profile_rev + 1 WHERE id = ?1`, fromId)
      const movedMessages = this.separateManualHistory(identityId)
      const from = this.contactRow(fromId) as ContactRow
      const contact = this.contactRow(contactId) as ContactRow
      this.audit(actor, 'contact.split', `contact:${fromId}`, before, { from, contact, movedMessages })
      return ok({ from, contact })
    })
  }

  /**
   * Take an address's hand-logged messages out of any no-mailbox conversation it shares with
   * another address, onto one conversation of its own (made only if there is something to
   * move), and take it out of the shared ones. Answers how many messages moved. Called by a
   * split once the address belongs to its new contact.
   */
  private separateManualHistory(identityId: string): number {
    const shared = this.sql
      .exec(
        `SELECT c.id FROM conversation c
           JOIN participant p ON p.conversation_id = c.id AND p.identity_id = ?1
          WHERE c.mailbox_id IS NULL
            AND EXISTS (SELECT 1 FROM participant o WHERE o.conversation_id = c.id AND o.identity_id != ?1)
          ORDER BY c.rowid`,
        identityId,
      )
      .toArray()
      .map((r) => text(r.id))
    let ownId: string | null = null
    let moved = 0
    for (const oldId of shared) {
      const count = Number(
        this.sql
          .exec(`SELECT count(*) AS n FROM message WHERE conversation_id = ?1 AND identity_id = ?2`, oldId, identityId)
          .one().n,
      )
      if (count > 0) {
        if (ownId === null) {
          ownId = this.ports.newId()
          this.sql.exec(
            `INSERT INTO conversation (id, created_at, last_activity_at) VALUES (?1, ?2, ?2)`,
            ownId,
            this.now(),
          )
          this.sql.exec(
            `INSERT INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'to')`,
            ownId,
            identityId,
          )
        }
        this.sql.exec(
          `UPDATE message SET conversation_id = ?3 WHERE conversation_id = ?1 AND identity_id = ?2`,
          oldId,
          identityId,
          ownId,
        )
        moved += count
      }
      this.sql.exec(`DELETE FROM participant WHERE conversation_id = ?1 AND identity_id = ?2`, oldId, identityId)
      this.touchConversation(oldId)
    }
    if (ownId !== null) this.touchConversation(ownId)
    return moved
  }

  /**
   * What the Client suggestions are computed from: every contact's Client and its email
   * addresses, nothing else. The rule itself is pure (src/clients.ts, suggestClients).
   */
  suggestionContacts(scope: MailScope = ALL_MAIL): SuggestionContact[] {
    const seen = this.visibleContactIds(scope)
    const emails = new Map<string, string[]>()
    for (const r of this.sql
      .exec(`SELECT contact_id, address FROM identity WHERE kind = 'email' ORDER BY rowid`)
      .toArray()) {
      const list = emails.get(text(r.contact_id)) ?? []
      list.push(text(r.address))
      emails.set(text(r.contact_id), list)
    }
    return this.sql
      .exec(`SELECT id, name, client_id FROM contact ORDER BY rowid`)
      .toArray()
      .filter((r) => seen === null || seen.has(text(r.id)))
      .map((r) => ({
        id: text(r.id),
        name: text(r.name),
        clientId: contactClient(r).clientId,
        emails: emails.get(text(r.id)) ?? [],
      }))
  }

  /**
   * A Client's contacts and the conversations with any of them, open or not, newest first:
   * the latest screen of them (QUEUE_PAGE) and how many there are in all, so a page that cuts
   * says "the latest N of M" and M is the number `clientUsage` counts.
   */
  clientCard(
    clientId: number,
    scope: MailScope = ALL_MAIL,
  ): {
    contacts: ContactListItem[]
    conversations: ConversationSummary[]
    conversationsTotal: number
  } {
    const on = scopeWhere(scope, 'c.mailbox_id', 2)
    const where = `c.id IN (SELECT p.conversation_id FROM participant p
                              JOIN identity i ON i.id = p.identity_id
                              JOIN contact ct ON ct.id = i.contact_id WHERE ct.client_id = ?1) AND ${on.sql}`
    return {
      contacts: this.listContacts(scope).filter((c) => c.clientId === clientId),
      conversations: this.conversationsWhere(where, [clientId, ...on.bindings], QUEUE_PAGE),
      conversationsTotal: Number(
        this.sql.exec(`SELECT count(*) AS n FROM conversation c WHERE ${where}`, clientId, ...on.bindings).one().n,
      ),
    }
  }

  /**
   * For every Client id some contact holds: how many contacts, how many conversations with
   * any of them and how many of those are open. Ids only (the names are the directory's), and
   * every conversation counts, as the queue's counts do, not a screenful.
   */
  clientUsage(
    scope: MailScope = ALL_MAIL,
  ): { clientId: number; contacts: number; conversations: number; open: number }[] {
    const seen = this.visibleContactIds(scope)
    const usage = new Map<number, { clientId: number; contacts: number; conversations: number; open: number }>()
    const of = (clientId: number) => {
      const found = usage.get(clientId) ?? { clientId, contacts: 0, conversations: 0, open: 0 }
      usage.set(clientId, found)
      return found
    }
    for (const r of this.sql.exec(`SELECT id, client_id FROM contact WHERE client_id IS NOT NULL`).toArray()) {
      if (seen === null || seen.has(text(r.id))) of(Number(r.client_id)).contacts += 1
    }
    for (const fact of this.listQueueFacts(scope)) {
      for (const clientId of fact.clientIds) {
        const u = of(clientId)
        u.conversations += 1
        if (fact.open) u.open += 1
      }
    }
    return [...usage.values()].sort((a, b) => a.clientId - b.clientId)
  }

  /**
   * The identity for an address, creating it and its contact when it is new.
   * Every address that is written to becomes a contact, named the way it was
   * given or, failing that, by the address itself.
   */
  protected identityFor(
    classified: { kind: IdentityKind; address: string },
    name: string | undefined,
    actor: string,
    counters?: { contactsCreated: number },
  ): { id: string; contactId: string; kind: IdentityKind; address: string } {
    const found = this.sql
      .exec(`SELECT id, contact_id FROM identity WHERE kind = ?1 AND address = ?2`, classified.kind, classified.address)
      .toArray()[0]
    if (found) {
      return { id: text(found.id), contactId: text(found.contact_id), ...classified }
    }
    const contactId = this.ports.newId()
    const identityId = this.ports.newId()
    const at = this.now()
    const contactName = name?.trim() || classified.address
    this.sql.exec(
      `INSERT INTO contact (id, name, created_at, created_by) VALUES (?1, ?2, ?3, ?4)`,
      contactId,
      contactName,
      at,
      actor,
    )
    this.sql.exec(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      identityId,
      contactId,
      classified.kind,
      classified.address,
      at,
    )
    this.audit(actor, 'contact.create', `contact:${contactId}`, null, { name: contactName, ...classified })
    if (counters) counters.contactsCreated += 1
    return { id: identityId, contactId, ...classified }
  }

  // ─── conversations ───────────────────────────────────────────────────

  /**
   * The conversation a hand-sent message is filed on: one per contact per
   * channel, among the conversations with no mailbox (a Gmail thread is never
   * one). Found through the participants, so it is the same conversation
   * whichever of the contact's addresses on that channel the message went to,
   * and the address is added as a participant when it is new to it.
   *
   * ⚠️ A CONVERSATION THAT IS EXACTLY THIS ADDRESS'S COMES FIRST. After a merge a contact
   * can have two such conversations (Dana's and Pat's, each made before the merge), and
   * "the newest of the contact's" would file a text to Dana on Pat's, which is a conversation
   * a later split could not separate. So a conversation whose only participant is this
   * address is preferred, and only without one does the contact's newest take the address
   * in. That keeps every address's history on its own conversation for as long as it has
   * one, which is what makes a merge undoable; `splitIdentity` separates what the fallback
   * shared.
   */
  private manualConversationFor(identity: { id: string; contactId: string; kind: IdentityKind }): string {
    const found = this.sql
      .exec(
        `SELECT c.id FROM conversation c
          WHERE c.mailbox_id IS NULL
            AND EXISTS (SELECT 1 FROM participant p JOIN identity i ON i.id = p.identity_id
                         WHERE p.conversation_id = c.id AND i.contact_id = ?1 AND i.kind = ?2)
          ORDER BY (EXISTS (SELECT 1 FROM participant own WHERE own.conversation_id = c.id AND own.identity_id = ?3)
                    AND NOT EXISTS (SELECT 1 FROM participant other WHERE other.conversation_id = c.id AND other.identity_id != ?3)) DESC,
                   c.last_activity_at DESC, c.rowid DESC LIMIT 1`,
        identity.contactId,
        identity.kind,
        identity.id,
      )
      .toArray()[0]
    const at = this.now()
    let id: string
    if (found) {
      id = text(found.id)
    } else {
      id = this.ports.newId()
      this.sql.exec(`INSERT INTO conversation (id, created_at, last_activity_at) VALUES (?1, ?2, ?2)`, id, at)
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, 'to')`,
      id,
      identity.id,
    )
    return id
  }

  /** Last activity is the newest message that is not a draft, else when it began. */
  protected touchConversation(id: string): void {
    this.sql.exec(
      `UPDATE conversation SET last_activity_at = coalesce(
         (SELECT max(coalesce(sent_at, created_at)) FROM message WHERE conversation_id = ?1 AND status NOT IN ${PENDING}),
         created_at)
       WHERE id = ?1`,
      id,
    )
  }

  /** A list row's line: the newest message's words, cut to 160 characters, or, when it has none and a calendar summary, the line that summary makes on the company's clock. */
  private listLine(body: string, stored: unknown): string {
    const words = repairMojibake(body).replace(/\s+/g, ' ').trim().slice(0, 160)
    if (words !== '') return words
    const summary = parseCalendarSummary(stored)
    return summary === null ? '' : safeSummaryLine(summary, this.ports.zone ?? 'UTC')
  }

  /**
   * The summaries of the conversations `where` names. Two row facts come with them (the mark
   * and the tag a list row shows, so no row needs a read of its own): whether the newest
   * message that is not a draft is Claude's send (`p` is that message, or a draft only when
   * nothing else is there, which is never a send), and the draft waiting (`w`) with who
   * wrote it: the newest, except that a send Gmail never confirmed comes first, because that is
   * the one that needs the owner.
   */
  protected conversationsWhere(where: string, bindings: unknown[], limit: number): ConversationSummary[] {
    const rows = this.sql
      .exec(
        `SELECT c.id, c.last_activity_at, c.sort, c.sort_by, c.telegram_kind,
                c.mailbox_id, mb.kind AS mailbox_kind,
                mb.display_name AS mailbox_name, mb.address AS mailbox_address,
                (SELECT count(*) FROM message d WHERE d.conversation_id = c.id AND d.status IN ${PENDING}) AS drafts,
                p.subject AS subject, p.body AS body, p.calendar AS calendar,
                (p.status = 'sent' AND p.direction = 'out' AND p.sent_by LIKE '${AGENT_PREFIX}%' AND p.instruction_text IS NOT NULL) AS from_claude,
                w.created_by AS draft_by, w.updated_by AS draft_updated_by, w.rev AS draft_rev,
                w.body AS draft_body, w.status AS draft_status
           FROM conversation c
           LEFT JOIN mailbox mb ON mb.id = c.mailbox_id
           LEFT JOIN message p ON p.id = (
             SELECT l.id FROM message l WHERE l.conversation_id = c.id
              ORDER BY (l.status IN ${PENDING}), coalesce(l.sent_at, l.created_at) DESC, l.rowid DESC LIMIT 1)
           LEFT JOIN message w ON w.id = (
             SELECT d.id FROM message d WHERE d.conversation_id = c.id AND d.status IN ${PENDING}
              ORDER BY (d.status = 'sending') DESC, d.created_at DESC, d.rowid DESC LIMIT 1)
          WHERE ${where}
          ORDER BY c.last_activity_at DESC, c.rowid DESC
          LIMIT ${Math.trunc(limit)}`,
        ...bindings,
      )
      .toArray()

    return rows.map((r) => {
      const facts = this.stateAndEnvelope(text(r.id))
      const people = this.sql
        .exec(
          `SELECT DISTINCT ct.id, ct.name, ct.client_id, i.kind
             FROM participant p
             JOIN identity i ON i.id = p.identity_id
             JOIN contact ct ON ct.id = i.contact_id
            WHERE p.conversation_id = ?1
            ORDER BY ct.rowid`,
          r.id,
        )
        .toArray()
      return {
        id: text(r.id),
        contactIds: people.map((p) => text(p.id)),
        contactNames: people.map((p) => text(p.name)),
        contactClientIds: people.map((p) => contactClient(p).clientId),
        kind: (people.length > 0 ? text(people[0]?.kind) : 'manual') as IdentityKind,
        clientIds: distinctClientIds(people),
        subject: text(r.subject),
        // Repaired before the whitespace is collapsed and the line cut: a no-break space or a cut inside "â€™" would leave it garbled (src/charset.ts).
        // An email with no words of its own that carries a calendar summary is listed under the line the summary makes ("Ines Okafor accepted: Roadmap review, ..."), where the line would otherwise be empty.
        snippet: this.listLine(text(r.body), r.calendar),
        newestFromClaude: Number(r.from_claude) === 1,
        draft:
          r.draft_by === null || r.draft_by === undefined
            ? null
            : {
                stuck: r.draft_status === 'sending',
                author: draftAuthor(text(r.draft_by)),
                editedBy: draftEditedBy(text(r.draft_by), text(r.draft_updated_by), Number(r.draft_rev)),
                excerpt: repairMojibake(text(r.draft_body)).replace(/\s+/g, ' ').trim().slice(0, 160),
              },
        lastActivityAt: text(r.last_activity_at),
        drafts: Number(r.drafts),
        ...facts.state,
        newestInbound: facts.newestInbound,
        ...mailboxFacts(r),
        ...(r.telegram_kind === 'group' || r.telegram_kind === 'channel' ? { telegramChat: r.telegram_kind } : {}),
      }
    })
  }

  /**
   * What Bulk is judged from for one conversation, read as the queue reads it (`queueFacts`): the envelope of its newest
   * inbound message and the Clients of its people. For the notification rule, which asks `isBulk` exactly as the queue does.
   */
  protected bulkFacts(conversationId: string): {
    newestInbound: Envelope | null
    clientIds: number[]
    spamCall?: SpamCall
  } {
    const people = this.sql
      .exec(
        `SELECT ct.client_id FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN contact ct ON ct.id = i.contact_id
          WHERE p.conversation_id = ?1`,
        conversationId,
      )
      .toArray()
    const called = this.sql
      .exec(
        `SELECT c.sort, c.sort_by FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1`,
        conversationId,
      )
      .toArray()[0]
    const spamCall = called && spamCallOf(textOrNull(called.sort), textOrNull(called.sort_by))
    return {
      newestInbound: this.stateAndEnvelope(conversationId).newestInbound,
      clientIds: distinctClientIds(people),
      ...(spamCall && { spamCall }),
    }
  }

  /**
   * Whether a conversation is read and open, and who made it so. DERIVED, never
   * stored, so it cannot disagree with the labels it is read from. The rules are
   * `foldConversation`'s, below, so one conversation and the whole queue cannot
   * disagree about them either.
   */
  protected conversationState(conversationId: string): ConversationState {
    return this.stateAndEnvelope(conversationId).state
  }

  private stateAndEnvelope(conversationId: string): { state: ConversationState; newestInbound: Envelope | null } {
    const rows = this.sql
      .exec(`${FOLD_SELECT} WHERE m.conversation_id = ?1 ORDER BY m.rowid`, conversationId)
      .toArray()
      .map(foldRow)
    const kind = this.mailboxKindOf(conversationId)
    // The newest sender is judged for any kind of mailbox, and only the one: its contact's name and addresses. Not in a Telegram GROUP: a member who is a bot does not make
    // the group an automated sender's (the group's own row is not judged by who last spoke in it).
    const automated =
      kind !== null && !this.isTelegramGroup(conversationId)
        ? this.senderJudgments(
            rows.filter((r) => r.inbound && r.identityId !== null).map((r) => r.identityId as string),
          )
        : undefined
    return foldConversation(kind, rows, automated)
  }

  /**
   * The senders among these identities (every mailbox's inbound ones when none are named) that the contact rules call
   * automated without any history to count: a machine-made name, or only no-reply mailboxes (src/automated.ts, rules 2 and 3;
   * rule 1 is the queue's own exemption for a conversation with a Client's person on it, and rule 4 reads a contact's other
   * conversations, which would make the answer depend on the answer). Keyed by identity, with the judgment's own sentence.
   */
  protected senderJudgments(identityIds: readonly string[] | null): Map<string, SenderJudgment> {
    const rows = this.sql
      .exec(
        `SELECT i.id AS identity_id, ct.name AS name, ci.kind AS kind, ci.address AS address, tp.bot AS bot, tp.chat AS chat
           FROM identity i
           JOIN contact ct ON ct.id = i.contact_id
           JOIN identity ci ON ci.contact_id = ct.id
           LEFT JOIN telegram_person tp ON tp.identity_id = ci.id
          WHERE CASE WHEN ?1 IS NULL
                     THEN i.id IN (SELECT m.identity_id FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
                                    WHERE m.direction = 'in')
                     ELSE i.id IN (SELECT value FROM json_each(?1)) END
          ORDER BY ci.rowid`,
        identityIds === null ? null : JSON.stringify(identityIds),
      )
      .toArray()
    const facts = new Map<
      string,
      { name: string; identities: { kind: IdentityKind; address: string; bot?: true; chat?: 'group' | 'channel' }[] }
    >()
    for (const r of rows) {
      const found = facts.get(text(r.identity_id)) ?? { name: text(r.name), identities: [] }
      found.identities.push({
        kind: text(r.kind) as IdentityKind,
        address: text(r.address),
        ...(Number(r.bot) === 1 && { bot: true as const }),
        ...chatOf(r.chat),
      })
      facts.set(text(r.identity_id), found)
    }
    const judged = new Map<string, SenderJudgment>()
    for (const [id, f] of facts) {
      const judgment = judgeSender({
        name: f.name,
        clientId: null,
        identities: f.identities,
        conversations: 0,
        bulkConversations: 0,
      })
      if (judgment.automated) judged.set(id, judgment)
    }
    return judged
  }

  /**
   * The kind of mailbox a conversation is in: `gmail`, `cloudflare`, or null for a manual conversation (no mailbox) and for one
   * that does not exist. A conversation's read and open state is Gmail's labels only when this is `gmail`; for a manual one and one
   * in a Cloudflare mailbox there is no Gmail behind it and the inbox's own stamps are the whole state. A Cloudflare conversation's
   * sending is a later step's, and Gmail never touches it.
   */
  /** Whether a conversation is a Telegram group's: its messages are filed under the members who wrote them. */
  protected isTelegramGroup(conversationId: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM conversation WHERE id = ?1 AND telegram_kind = 'group'`, conversationId)
        .toArray()[0] !== undefined
    )
  }

  protected mailboxKindOf(conversationId: string): MailboxKind | null {
    const r = this.sql
      .exec(`SELECT m.kind FROM conversation c JOIN mailbox m ON m.id = c.mailbox_id WHERE c.id = ?1`, conversationId)
      .toArray()[0]
    return r === undefined ? null : (r.kind as MailboxKind)
  }

  /**
   * What the queue needs of EVERY conversation, newest activity first: its state,
   * its drafts and the envelope Bulk is judged from, and nothing else, so counting
   * the whole table is two reads and not a read per conversation. The queue's
   * counts come from this (src/queue.ts), so they cover the whole mailbox and the
   * rows shown are the first of the same list.
   */
  listQueueFacts(scope: MailScope = ALL_MAIL): QueueFact[] {
    return this.queueFacts(null, scope)
  }

  /**
   * What Bulk does to the open conversations now (see `BulkReport`): a read of the queue's own rule over every conversation, so
   * the numbers are exactly what the Inbox and Bulk views show. `gmailMovedByAutomatedRule` is how
   * many open Gmail conversations the automated-sender rule alone put in Bulk.
   */
  bulkReport(scope: MailScope = ALL_MAIL): BulkReport {
    const kinds = new Map<string, string>()
    for (const r of this.sql
      .exec(`SELECT c.id, mb.kind FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id`)
      .toArray()) {
      kinds.set(text(r.id), text(r.kind))
    }
    const empty = (): BulkCounts => ({
      open: 0,
      inbox: 0,
      bulk: 0,
      byReason: { unsubscribe: 0, category: 0, automated: 0, clef: 0, moved: 0 },
    })
    const counts = { gmail: empty(), cloudflare: empty() }
    const moved: string[] = []
    for (const f of this.queueFacts(null, scope)) {
      const kind = kinds.get(f.id)
      if (!f.open || (kind !== 'gmail' && kind !== 'cloudflare')) continue
      const c = counts[kind]
      c.open += 1
      const reason: BulkReason | null = bulkReason(f)
      if (reason === null) c.inbox += 1
      else {
        c.bulk += 1
        c.byReason[reason] += 1
        if (kind === 'gmail' && reason === 'automated') moved.push(f.id)
      }
    }
    const senders = new Map<string, { name: string; address: string; conversations: number }>()
    for (const id of moved) {
      const r = this.sql
        .exec(
          `SELECT i.address AS address, ct.name AS name FROM message m
             JOIN identity i ON i.id = m.identity_id JOIN contact ct ON ct.id = i.contact_id
            WHERE m.conversation_id = ?1 AND m.direction = 'in' AND m.gmail_id IS NOT NULL
            ORDER BY m.rowid DESC LIMIT 1`,
          id,
        )
        .toArray()[0]
      if (!r) continue
      const found = senders.get(text(r.address)) ?? { name: text(r.name), address: text(r.address), conversations: 0 }
      found.conversations += 1
      senders.set(found.address, found)
    }
    return {
      ...counts,
      gmailMovedByAutomatedRule: moved.length,
      senders: [...senders.values()].sort(
        (a, b) => b.conversations - a.conversations || a.address.localeCompare(b.address),
      ),
    }
  }

  /**
   * The facts of every conversation, or only of those of one mailbox (the header's counts), cut to what `scope` may see (`canSee`, src/queue.ts) before anything is counted or cut to a screen. The default is everything, for the
   * store's own work; whatever answers a person passes theirs.
   */
  protected queueFacts(mailboxId: string | null, scope: MailScope = ALL_MAIL): QueueFact[] {
    const byConversation = new Map<string, FoldRow[]>()
    for (const r of this.sql.exec(`${FOLD_SELECT} WHERE m.conversation_id IS NOT NULL ORDER BY m.rowid`).toArray()) {
      const id = text(r.conversation_id)
      const list = byConversation.get(id) ?? []
      list.push(foldRow(r))
      byConversation.set(id, list)
    }
    // The Clients of each conversation's people, in one read for the whole table.
    const clientsOf = new Map<string, number[]>()
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT p.conversation_id AS conversation_id, ct.client_id AS client_id
           FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN contact ct ON ct.id = i.contact_id
          WHERE ct.client_id IS NOT NULL
          ORDER BY ct.client_id`,
      )
      .toArray()) {
      const list = clientsOf.get(text(r.conversation_id)) ?? []
      list.push(Number(r.client_id))
      clientsOf.set(text(r.conversation_id), list)
    }
    const automated = this.senderJudgments(null)
    return this.sql
      .exec(
        `SELECT c.id, c.mailbox_id, c.last_activity_at, c.sort, c.sort_by, c.telegram_kind,
                mb.kind AS mailbox_kind,
                mb.display_name AS mailbox_name, mb.address AS mailbox_address,
                (SELECT count(*) FROM message d WHERE d.conversation_id = c.id AND d.status IN ${PENDING}) AS drafts
           FROM conversation c
           LEFT JOIN mailbox mb ON mb.id = c.mailbox_id
          WHERE ?1 IS NULL OR c.mailbox_id = ?1
          ORDER BY c.last_activity_at DESC, c.rowid DESC`,
        mailboxId,
      )
      .toArray()
      .filter((r) => canSee(scope, textOrNull(r.mailbox_id)))
      .map((r) => {
        const { state, newestInbound } = foldConversation(
          isMailboxKind(r.mailbox_kind) ? r.mailbox_kind : null,
          byConversation.get(text(r.id)) ?? [],
          // A Telegram group is not judged by who last spoke in it (see `stateAndEnvelope`).
          r.telegram_kind === 'group' ? new Map() : automated,
        )
        return {
          id: text(r.id),
          lastActivityAt: text(r.last_activity_at),
          drafts: Number(r.drafts),
          ...state,
          newestInbound,
          clientIds: clientsOf.get(text(r.id)) ?? [],
          ...mailboxFacts(r),
        }
      })
  }

  /**
   * The conversations with these ids as the queue shows them, most recently active
   * first, at most a screen of them (QUEUE_PAGE). The ids are the queue's plan for the
   * filter asked for (src/queue.ts), so the cut to a screen is made AFTER the filter
   * and not before it.
   */
  listConversations(ids: string[]): ConversationSummary[] {
    if (ids.length === 0) return []
    // json_each, not one `?` per id: a Durable Object's SQLite takes only 100 bound values.
    return this.conversationsWhere('c.id IN (SELECT value FROM json_each(?1))', [JSON.stringify(ids)], QUEUE_PAGE)
  }

  /**
   * The conversations that have EVERY one of these words (src/search.ts `searchTerms`) somewhere on them, open
   * or closed, newest first, at most a screen (QUEUE_PAGE), with `more` when there were others. A word is found when
   * it is in the name or address of a person on the conversation, or in the subject or text of any of its messages
   * (a waiting draft included: it is text the inbox holds), case ignored for the letters SQLite folds (ASCII).
   * Each hit carries a line of the newest message whose text has one of the words, so a result says why it matched.
   *
   * A READ AND NOTHING ELSE: one SELECT per question, no stamp, no audit entry, no call to Gmail (this class has none).
   * A plain scan with no index, as the option asks, until it is measured to be slow: at one mailbox's volume the
   * table is a few hundred conversations. No terms finds nothing, and the words are bound, never put in the SQL.
   */
  searchConversations(
    terms: string[],
    scope: MailScope = ALL_MAIL,
  ): {
    hits: { conversation: ConversationSummary; match: string | null }[]
    more: boolean
  } {
    if (terms.length === 0) return { hits: [], more: false }
    // Only conversations the scope may see are searched at all, so a word in someone else's mail finds nothing, and the screen is cut from the person's own.
    const on = scopeWhere(scope, 'c.mailbox_id', terms.length + 1)
    const has = (n: number) => `(
      EXISTS (SELECT 1 FROM participant p
                JOIN identity i ON i.id = p.identity_id
                JOIN contact ct ON ct.id = i.contact_id
               WHERE p.conversation_id = c.id AND (ct.name LIKE ?${n} ESCAPE '\\' OR i.address LIKE ?${n} ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM message m
                  WHERE m.conversation_id = c.id AND (m.subject LIKE ?${n} ESCAPE '\\' OR m.body LIKE ?${n} ESCAPE '\\')))`
    const found = this.sql
      .exec(
        `SELECT c.id FROM conversation c
          WHERE ${terms.map((_, n) => has(n + 1)).join(' AND ')} AND ${on.sql}
          ORDER BY c.last_activity_at DESC, c.rowid DESC
          LIMIT ${QUEUE_PAGE + 1}`,
        ...terms.map(likePattern),
        ...on.bindings,
      )
      .toArray()
      .map((r) => text(r.id))
    const ids = found.slice(0, QUEUE_PAGE)
    if (ids.length === 0) return { hits: [], more: false }

    // The newest message with one of the words in its text says why the conversation matched.
    const match = new Map<string, string>()
    for (const r of this.sql
      .exec(
        `SELECT conversation_id, body FROM message
          WHERE conversation_id IN (SELECT value FROM json_each(?1))
            AND (${terms.map((_, n) => `body LIKE ?${n + 2} ESCAPE '\\'`).join(' OR ')})
          ORDER BY coalesce(sent_at, created_at) DESC, rowid DESC`,
        JSON.stringify(ids),
        ...terms.map(likePattern),
      )
      .toArray()) {
      const id = text(r.conversation_id)
      if (match.has(id)) continue
      const line = excerptAround(repairMojibake(text(r.body)), terms)
      if (line !== null) match.set(id, line)
    }
    return {
      hits: this.listConversations(ids).map((conversation) => ({
        conversation,
        match: match.get(conversation.id) ?? null,
      })),
      more: found.length > QUEUE_PAGE,
    }
  }

  /** What a reply on this conversation would be (see ConversationDetail.reply). */
  private replyFor(conversationId: string): ConversationReply | null {
    const plan = this.replyPlan(conversationId)
    if (!plan) return null
    const from = this.cloudflareSenderOf(conversationId)
    return {
      to: plan.to?.address ?? null,
      subject: plan.subject,
      everyone: plan.everyone,
      ...(from && { from: from.address }),
    }
  }

  /**
   * Keep one report Cloudflare published about a message this inbox sent (src/delivery.ts). One row per event id, never updated: a report
   * delivered twice (a queue retries) is one row. Answers whether it was new. Nothing here looks for the message: a report is matched to its
   * message when it is read (`withDelivery`), so one that comes before the send was filed waits for it.
   */
  keepDeliveryEvent(event: DeliveryEvent, keptAt: string): boolean {
    const before = this.sql.exec(`SELECT count(*) AS n FROM delivery_event`).one().n
    this.sql.exec(
      `INSERT OR IGNORE INTO delivery_event (event_id, provider_id, recipient, state, terminal, reason, at, kept_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      event.eventId,
      event.providerId,
      event.recipient,
      event.state,
      event.terminal ? 1 : 0,
      event.reason,
      event.at,
      keptAt,
    )
    return Number(this.sql.exec(`SELECT count(*) AS n FROM delivery_event`).one().n) > Number(before)
  }

  /** Whether the inbox holds a message filed under the id Cloudflare gave a send (`fileCloudflareSent`): false for a report that is early, or about mail that was not this inbox's. */
  holdsSentMessage(providerId: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM message WHERE rfc_message_id IN (?1, ?2) LIMIT 1`, providerId, `<${providerId}>`)
        .toArray().length > 0
    )
  }

  /**
   * The messages with what Cloudflare reported of them added, for those that were sent through Cloudflare. A message is matched to its
   * reports by the id Cloudflare gave it when it accepted it: the sent message is filed under `<that id>` (fileCloudflareSent).
   */
  withDelivery<T extends MessageRow>(rows: readonly T[]): T[] {
    const ids = rows.filter((m) => m.direction === 'out' && m.sentFrom !== undefined).map((m) => m.id)
    if (ids.length === 0) return [...rows]
    const held = this.sql
      .exec(
        `SELECT m.id AS message_id, d.recipient, d.state, d.terminal, d.reason, d.at, d.kept_at
           FROM message m
           JOIN delivery_event d ON d.provider_id = trim(m.rfc_message_id, '<>')
          WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.rfc_message_id IS NOT NULL`,
        JSON.stringify(ids),
      )
      .toArray()
    const byMessage = new Map<string, HeldEvent[]>()
    for (const r of held) {
      const list = byMessage.get(text(r.message_id)) ?? []
      list.push({
        recipient: text(r.recipient),
        state: text(r.state) as HeldEvent['state'],
        terminal: Number(r.terminal) === 1,
        reason: text(r.reason),
        at: text(r.at),
        keptAt: text(r.kept_at),
      })
      byMessage.set(text(r.message_id), list)
    }
    return rows.map((m) => {
      const notes = notesFor(byMessage.get(m.id) ?? [])
      return notes.length > 0 ? { ...m, delivery: notes } : m
    })
  }

  getConversation(id: string): Result<ConversationDetail> {
    const summary = this.conversationsWhere('c.id = ?1', [id], 1)[0]
    if (!summary) return fail(404, 'No such conversation.')
    const addresses = this.sql
      .exec(
        `SELECT i.id, i.kind, i.address FROM participant p JOIN identity i ON i.id = p.identity_id
          WHERE p.conversation_id = ?1 ORDER BY i.rowid`,
        id,
      )
      .toArray()
      .map((r) => ({ id: text(r.id), kind: text(r.kind) as IdentityKind, address: text(r.address) }))
    const messages = this.withDelivery(
      this.sql
        .exec(
          `${this.messageSelect()} WHERE m.conversation_id = ?1 AND m.status NOT IN ${PENDING}
              ORDER BY coalesce(m.sent_at, m.created_at), m.rowid`,
          id,
        )
        .toArray()
        .map(messageRow),
    )
    const drafts = this.sql
      .exec(
        `${this.messageSelect()} WHERE m.conversation_id = ?1 AND m.status IN ${PENDING}
              ORDER BY m.created_at DESC, m.rowid DESC`,
        id,
      )
      .toArray()
      .map(messageRow)
    const chats = this.draftChats(drafts.map((d) => d.id))
    // A conversation in either kind of mailbox says why it is where it is and carries a person's call on it; only a Cloudflare one
    // has the mailbox's mark and always has the lines (even none), where Gmail's has them when a rule holds.
    const inMailbox = summary.mailbox !== undefined
    const viaCloudflare = summary.mailboxKind === 'cloudflare'
    const reasons = inMailbox ? this.reasonsFor(id, summary) : []
    return ok({
      id,
      ...this.conversationState(id),
      through: this.newestPosition(id),
      kind: summary.kind,
      contacts: summary.contactIds.map((cid, n) => ({
        id: cid,
        name: summary.contactNames[n] ?? '',
        clientId: summary.contactClientIds[n] ?? null,
      })),
      addresses,
      messages,
      drafts: drafts.map((d) => (chats.has(d.id) ? { ...d, chat: chats.get(d.id) as ChatTurn[] } : d)),
      ...(summary.mailbox && { mailbox: summary.mailbox }),
      ...(viaCloudflare && { reasons, spam: isSpam(summary) }),
      ...(!viaCloudflare && reasons.length > 0 && { reasons }),
      ...(!viaCloudflare && isSpam(summary) && { spam: true }),
      ...(summary.spamCall && { spamCall: summary.spamCall }),
      gmailUrl: this.gmailUrlFor(id),
      reply: this.replyFor(id),
      bulk: isBulk(summary),
    })
  }

  /**
   * Why a conversation is in the Inbox or in Bulk, as the lines the screen shows (src/cloudflare/spam-check.ts says them): the
   * rules that apply to its newest inbound message, a person's call on it, and, in a Cloudflare mailbox, what the spam classifier said of it, when
   * it judged it. Gmail's has the header, the category tab, the automated sender and a Client's contact, and no score.
   */
  private reasonsFor(conversationId: string, summary: ConversationSummary): string[] {
    const newest = this.sql
      .exec(
        `SELECT identity_id, clef_junk, clef_category, clef_model FROM message
          WHERE conversation_id = ?1 AND direction = 'in' AND status NOT IN ${PENDING}
          ORDER BY coalesce(sent_at, created_at) DESC, rowid DESC LIMIT 1`,
        conversationId,
      )
      .toArray()[0]
    const identityId = newest ? textOrNull(newest.identity_id) : null
    const automated = identityId === null ? undefined : this.senderJudgments([identityId]).get(identityId)
    return reasonLines(
      {
        clientIds: summary.clientIds,
        spamCall: summary.spamCall,
        newest: summary.newestInbound && {
          listUnsubscribe: summary.newestInbound.listUnsubscribe,
          labels: summary.newestInbound.labels,
          automated: automated?.reason ?? null,
          clef:
            newest && typeof newest.clef_junk === 'number'
              ? { junk: newest.clef_junk, category: text(newest.clef_category), model: text(newest.clef_model) }
              : null,
        },
      },
      this.ports.owner.name,
    )
  }

  /** The draft chat of each of these drafts (the ones that have one), oldest turn first: what a conversation's answer shows beside a draft. */
  private draftChats(draftIds: string[]): Map<string, ChatTurn[]> {
    const chats = new Map<string, ChatTurn[]>()
    for (const id of draftIds) {
      const turns = this.sql
        .exec(
          `SELECT seq, at, instruction, note, revised, rev_before, rev_after FROM draft_chat WHERE draft_id = ?1 ORDER BY seq`,
          id,
        )
        .toArray()
        .map(
          (r): ChatTurn => ({
            seq: Number(r.seq),
            at: text(r.at),
            instruction: textOrNull(r.instruction),
            note: text(r.note),
            revised: Number(r.revised) === 1,
            revBefore: Number(r.rev_before),
            revAfter: r.rev_after === null ? null : Number(r.rev_after),
          }),
        )
      if (turns.length > 0) chats.set(id, turns)
    }
    return chats
  }

  /**
   * How far into a conversation a reader is who has been shown everything in it:
   * the storage position of its newest message that is not a draft. A page sends
   * it back with Close and with read, and the Mailroom refuses when something
   * inbound has been stored beyond it, so a change never covers a message its
   * author was not shown. Storage order, not the sender's date: a message that
   * arrives late with an early date is still one nobody was shown.
   */
  protected newestPosition(conversationId: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT coalesce(max(rowid), 0) AS n FROM message WHERE conversation_id = ?1 AND status NOT IN ${PENDING}`,
          conversationId,
        )
        .one().n,
    )
  }

  /** The thread in Gmail's own app, for a conversation that has a mailbox. */
  private gmailUrlFor(conversationId: string): string | null {
    const r = this.sql
      .exec(
        `SELECT c.gmail_thread_id AS thread, m.address FROM conversation c
           JOIN mailbox m ON m.id = c.mailbox_id WHERE c.id = ?1 AND c.gmail_thread_id IS NOT NULL`,
        conversationId,
      )
      .toArray()[0]
    if (!r) return null
    // `authuser` picks the account, so the link opens the right mailbox whichever
    // Google account the browser is signed in to first.
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(text(r.address))}#all/${encodeURIComponent(text(r.thread))}`
  }

  // ─── which mailbox sends ─────────────────────────────────────────────

  /**
   * The Cloudflare mailbox a conversation is in, as what replies go out from: its address, its name and the domain whose
   * addresses are all ours. Null for a conversation in Gmail, for a manual one and for one that does not exist.
   */
  protected cloudflareSenderOf(conversationId: string): CloudflareSender | null {
    const r = this.sql
      .exec(
        `SELECT mb.id, mb.address, mb.display_name FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id
          WHERE c.id = ?1 AND mb.kind = 'cloudflare'`,
        conversationId,
      )
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /**
   * The JMAP mailbox a conversation is in, as what replies go out from: its address, its name and the domain whose addresses are all ours (the same shape as a Cloudflare mailbox's, since
   * the question "who is ours" is the same: `domainIsOurs`). Null for a conversation in any other kind of mailbox, for a manual one and for one that does not exist.
   */
  protected jmapSenderOf(conversationId: string): CloudflareSender | null {
    const r = this.sql
      .exec(
        `SELECT mb.id, mb.address, mb.display_name FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id
          WHERE c.id = ?1 AND mb.kind = 'jmap'`,
        conversationId,
      )
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /** The JMAP mailbox recorded on a message: the one a draft will go out from, is being sent from, or was sent from. Null for everything else. */
  protected jmapSenderOfMessage(messageId: string): CloudflareSender | null {
    const r = this.sql
      .exec(
        `SELECT mb.id, mb.address, mb.display_name FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
          WHERE m.id = ?1 AND mb.kind = 'jmap'`,
        messageId,
      )
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /** The Gmail account a conversation is in, or null (a Cloudflare or manual conversation, one that does not exist). */
  protected gmailMailboxIdOfConversation(conversationId: string): string | null {
    const r = this.sql
      .exec(
        `SELECT mb.id FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1 AND mb.kind = 'gmail'`,
        conversationId,
      )
      .toArray()[0]
    return r ? text(r.id) : null
  }

  /** The Gmail account recorded on a draft (written when it was made), or null when it records none. */
  protected gmailMailboxIdOfMessage(messageId: string): string | null {
    const r = this.sql
      .exec(
        `SELECT mb.id FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id WHERE m.id = ?1 AND mb.kind = 'gmail'`,
        messageId,
      )
      .toArray()[0]
    return r ? text(r.id) : null
  }

  /** A Gmail account by its id, as the sender a new email may be chosen to go out from; null for an id that is none (a Cloudflare mailbox's included). */
  protected gmailMailboxSender(mailboxId: string): CloudflareSender | null {
    const r = this.sql
      .exec(`SELECT id, address, display_name FROM mailbox WHERE id = ?1 AND kind = 'gmail'`, mailboxId)
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /**
   * The Gmail account a draft that chooses none goes out from: the owner's own address while it holds a token, else the oldest account that does; null when none
   * does. The one rule, here, because both a new email's draft (which records it) and the send of a draft that recorded nothing (MailStore.defaultGmail) ask it.
   */
  protected defaultGmailId(scope: MailScope = ALL_MAIL): string | null {
    // The account a send is from is one the person is on: the default is chosen among theirs (the rule is the same, over fewer accounts).
    const on = scopeWhere(scope, 'id', 1)
    return text(this.sql.exec(defaultGmailSql(this.ports.owner.email, on.sql), ...on.bindings).toArray()[0]?.id) || null
  }

  /**
   * Claude's choice of From, said as text: a mailbox's address, its name or its id, as `mailbox` and `mailboxes` list them (case does not matter). Becomes the same `InboxFrom` the compose
   * box makes, so `createDraft` checks and records it as it does that one. Refused, in words that say what to do: on a reply (it goes from its conversation's mailbox), a name that is
   * none of ours or is two (never guessed), a Gmail account that is disconnected, and one whose grant lapsed (a draft that could not be sent is not made).
   */
  private resolveChosenFrom(wanted: string, onConversation: boolean, scope: MailScope): Result<InboxFrom> {
    if (onConversation) {
      return fail(
        422,
        'A reply goes from the mailbox its conversation is in, so it cannot be given a from. Leave from out, or draft a new email instead. Nothing was drafted.',
      )
    }
    const asked = wanted.trim().toLowerCase()
    if (asked === '')
      return fail(
        422,
        'from is the address or name of one of the mailboxes, as `mailbox` and `mailboxes` list them. Nothing was drafted.',
      )
    const rows = this.sql
      .exec(
        `SELECT id, kind, address, display_name, refresh_token, grant_lapsed_at FROM mailbox
          WHERE lower(address) = ?1 OR lower(display_name) = ?1 OR id = ?2 ORDER BY rowid`,
        asked,
        wanted.trim(),
      )
      .toArray()
    // Only mailboxes the sender is on are known to it: another's is not named, listed or chosen.
    const mine = rows.filter((r) => isEmailKind(text(r.kind)) && canSee(scope, text(r.id)))
    if (mine.length === 0) {
      const known = this.sql
        .exec(
          `SELECT id, address FROM mailbox WHERE kind IN (${EMAIL_KINDS.map((k) => `'${k}'`).join(', ')}) ORDER BY rowid`,
        )
        .toArray()
        .filter((r) => canSee(scope, text(r.id)))
        .map((r) => text(r.address))
      return fail(
        422,
        `${wanted.trim()} is not one of the mailboxes this inbox sends from (${known.join(', ')}). Nothing was drafted.`,
      )
    }
    if (mine.length > 1) {
      return fail(
        422,
        `${wanted.trim()} names more than one mailbox (${mine.map((r) => text(r.address)).join(', ')}); say which by its address. Nothing was drafted.`,
      )
    }
    const row = mine[0] as Record<string, unknown>
    const address = text(row.address)
    if (text(row.kind) === 'cloudflare') return ok({ kind: 'business', mailboxId: text(row.id) })
    if (text(row.kind) === 'jmap') {
      if (row.grant_lapsed_at !== null)
        return fail(
          422,
          `The mail server refused the space’s key for ${address}, so nothing can go out from it. Choose another mailbox. Nothing was drafted.`,
        )
      return ok({ kind: 'business', mailboxId: text(row.id) })
    }
    if (row.refresh_token === null)
      return fail(
        422,
        `${address} is disconnected, so nothing can go out from it. Choose another mailbox. Nothing was drafted.`,
      )
    if (row.grant_lapsed_at !== null)
      return fail(422, `${lapsedReason(address)} Choose another mailbox. Nothing was drafted.`)
    return ok({ kind: 'gmail', mailboxId: text(row.id) })
  }

  /**
   * A business mailbox by its id (a Cloudflare one, or a JMAP one on the install's own mail server: the space calls both business mailboxes), as the sender a new email may be chosen to go out from; null for an id that is
   * none (Gmail's included). A JMAP mailbox whose credential the server refused is none either: a draft that could not be sent is not made.
   */
  protected cloudflareMailboxSender(mailboxId: string): CloudflareSender | null {
    const r = this.sql
      .exec(
        `SELECT id, address, display_name FROM mailbox
          WHERE id = ?1 AND (kind = 'cloudflare' OR (kind = 'jmap' AND grant_lapsed_at IS NULL))`,
        mailboxId,
      )
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /**
   * The Cloudflare mailbox recorded on a message: the one a draft will go out from (written when the draft is made), is being
   * sent from, or was sent from. Null for everything in Gmail and for a draft that records none.
   */
  protected cloudflareSenderOfMessage(messageId: string): CloudflareSender | null {
    const r = this.sql
      .exec(
        `SELECT mb.id, mb.address, mb.display_name FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
          WHERE m.id = ?1 AND mb.kind = 'cloudflare'`,
        messageId,
      )
      .toArray()[0]
    return r ? cloudflareSender(r) : null
  }

  /**
   * The mailbox a contact last wrote to, whichever kind, or null when nothing of theirs is in a mailbox: the newest message
   * that came in from any of the contact's addresses. A new email to the contact goes out from it (a customer hears from
   * the business mailbox, a client from the owner's Gmail), and the contact's card says which.
   */
  protected mailboxContactLastWroteTo(
    contactId: string,
    scope: MailScope = ALL_MAIL,
  ): { kind: 'gmail' | 'cloudflare' | 'jmap'; sender: CloudflareSender } | null {
    // A Gmail account whose grant is gone (disconnected or lapsed) cannot send, so it is passed over for the next newest mailbox, or for none (the default account then sends).
    // A mailbox the person is not on is passed over too: nobody sends from a mailbox they are not on.
    const on = scopeWhere(scope, 'mb.id', 2)
    const r = this.sql
      .exec(
        `SELECT mb.id, mb.kind, mb.address, mb.display_name FROM message m
           JOIN identity i ON i.id = m.identity_id
           JOIN mailbox mb ON mb.id = m.mailbox_id
          WHERE m.direction = 'in' AND i.contact_id = ?1 AND ${on.sql}
            AND (mb.kind = 'cloudflare' OR (mb.kind = 'jmap' AND mb.grant_lapsed_at IS NULL) OR (mb.kind = 'gmail' AND ${workingGrantSql('mb')}))
          ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC LIMIT 1`,
        contactId,
        ...on.bindings,
      )
      .toArray()[0]
    return r ? { kind: r.kind as 'gmail' | 'cloudflare' | 'jmap', sender: cloudflareSender(r) } : null
  }

  // ─── replies ─────────────────────────────────────────────────────────

  /** Our own addresses: the owner's and every mailbox's. Never the recipient of a reply, and never copied on one. */
  protected ownAddresses(): Set<string> {
    const own = new Set([this.ports.owner.email])
    for (const r of this.sql.exec(`SELECT address FROM mailbox`).toArray()) own.add(text(r.address).toLowerCase())
    return own
  }

  /**
   * Where a reply on an email conversation goes, and what it is called and threaded
   * on. Null for a conversation with no mailbox (a text, a DM, a carried Outbox
   * entry): there is no thread to reply into, and a draft there is addressed by name.
   *
   * It reads the NEWEST message that came in and is in play (not in the trash, spam
   * or drafts): its Reply-To if it has one, else its From, and never an address of
   * ours (a reply to a message we wrote ourselves, or to a note to self, must not
   * land in our own mailbox). `everyone` is everything that message named, less us.
   * With nothing inbound (we wrote last, and nobody has answered) a follow-up goes
   * to the newest message's To.
   *
   * ⚠️ Mail is untrusted input: these addresses come from headers a stranger wrote.
   * They are only ever DEFAULTS for a draft, which names its recipients in full and
   * shows them before anything is sent. Nothing here sends.
   */
  protected replyPlan(conversationId: string): ReplyPlan | null {
    const kind = this.mailboxKindOf(conversationId)
    // A manual conversation (no mailbox) has no thread to reply into.
    if (kind === null) return null

    // Gmail's: the owner's address and every mailbox's are ours, and only what is in play in Gmail counts. A Cloudflare
    // mailbox's: only its own address and the addresses on its domain are ours (the owner's Gmail address is a person who can
    // write to a business mailbox, and be answered as that mailbox's address), and every message that is not a draft counts, because nothing there
    // has Gmail's labels.
    const sender = domainIsOurs(kind)
      ? (this.cloudflareSenderOf(conversationId) ?? this.jmapSenderOf(conversationId))
      : null
    const gmailOwn = this.ownAddresses()
    const isOwn = (address: string): boolean => (sender ? belongsToMailbox(sender, address) : gmailOwn.has(address))
    const held = labelsAreTruth(kind)
      ? this.sql
          .exec(
            `SELECT gmail_id, direction, labels, subject, rfc_message_id, from_header, to_header, cc_header, reply_to_header
                 FROM message
                WHERE conversation_id = ?1 AND (gmail_id IS NOT NULL OR jmap_id IS NOT NULL)
                ORDER BY coalesce(sent_at, created_at) DESC, rowid DESC`,
            conversationId,
          )
          .toArray()
          .filter((m) => inPlay(jsonArray<string>(m.labels)))
      : this.sql
          .exec(
            `SELECT gmail_id, direction, labels, subject, rfc_message_id, from_header, to_header, cc_header, reply_to_header
                 FROM message
                WHERE conversation_id = ?1 AND mailbox_id IS NOT NULL AND status NOT IN ${PENDING}
                ORDER BY coalesce(sent_at, created_at) DESC, rowid DESC`,
            conversationId,
          )
          .toArray()

    const emails = (header: unknown): Person[] => {
      const out: Person[] = []
      for (const p of parseAddressList(text(header))) {
        const c = classifyAddress(p.address)
        if (c && c.kind === 'email' && !isOwn(c.address) && !out.some((o) => o.address === c.address)) {
          out.push({ address: c.address, name: p.name })
        }
      }
      return out
    }

    // Who the reply is to (`to`) and everyone the message being answered named (`named`).
    // The newest message that came in is the one answered. With nothing inbound, a
    // follow-up goes to whoever the newest message was written to.
    const inbound = held.find((m) => m.direction === 'in')
    const newest = inbound ?? held[0]
    let to: Person | null = null
    let named: Person[] = []
    if (inbound) {
      const replyTo = emails(inbound.reply_to_header)
      const from = emails(inbound.from_header)
      to = replyTo[0] ?? from[0] ?? null
      // The sender is on the list only when the message asked for no other reply address:
      // a form service that says "reply to the customer" is not somebody to copy.
      named = [
        ...replyTo,
        ...(replyTo.length > 0 ? [] : from),
        ...emails(inbound.to_header),
        ...emails(inbound.cc_header),
      ]
    } else if (newest) {
      const recipients = emails(newest.to_header)
      to = recipients[0] ?? null
      named = [...recipients, ...emails(newest.cc_header)]
    }
    const everyone = [...new Set(named.map((p) => p.address))]
    const ordered = to ? [to.address, ...everyone.filter((a) => a !== to?.address)] : everyone

    const subject = tidyLine(text(held.find((m) => tidyLine(text(m.subject)) !== '')?.subject))
    const answered = text(newest?.rfc_message_id) || text(held.find((m) => m.rfc_message_id)?.rfc_message_id)
    let replySubject = subject
    if (subject !== '' && !/^re:/i.test(subject)) replySubject = `Re: ${subject}`
    return {
      to,
      everyone: ordered,
      subject: replySubject,
      inReplyTo: answered === '' ? null : answered,
      replyToUnknown: kind === 'gmail' && inbound && inbound.reply_to_header === null ? text(inbound.gmail_id) : null,
    }
  }

  /** A draft's Cc once `copyEveryone` (when given) is applied: recomputed from its conversation, or cleared. */
  private ccAfterPatch(before: MessageRow, copyEveryone: boolean | undefined): Result<string> {
    if (copyEveryone === undefined) return ok(before.cc)
    if (!copyEveryone) return ok('')
    const plan = before.conversationId ? this.replyPlan(before.conversationId) : null
    if (!plan) return fail(422, 'This draft is not on an email conversation, so there is nobody to copy.')
    return ok(this.copyList(plan, before.address))
  }

  /** The Cc a "copy everyone" draft to `to` takes on this conversation: everyone on the message it answers, less the recipient. */
  private copyList(plan: ReplyPlan, to: string): string {
    return plan.everyone.filter((a) => a !== to).join(', ')
  }

  // ─── drafts ──────────────────────────────────────────────────────────

  /** Everything waiting, on every channel, newest first, that the scope may see: a draft belongs to its conversation's mailbox, or to the one it records when it is on no conversation. */
  listDrafts(scope: MailScope = ALL_MAIL): MessageRow[] {
    const on = scopeWhere(scope, MESSAGE_MAILBOX('m', 'sc'), 1)
    return this.sql
      .exec(
        `${this.messageSelect()} WHERE m.status IN ${PENDING} AND ${on.sql} ORDER BY m.created_at DESC, m.rowid DESC`,
        ...on.bindings,
      )
      .toArray()
      .map(messageRow)
  }

  protected message(id: string): MessageRow | null {
    const r = this.sql.exec(`${this.messageSelect()} WHERE m.id = ?1`, id).toArray()[0]
    return r ? messageRow(r) : null
  }

  /** One message by id, whatever it is now: a draft, or what a draft became once it was sent. The space asks it where a draft's link opens (the part's `draftAt`). */
  messageById(id: string): MessageRow | null {
    return this.message(id)
  }

  /**
   * Which identity a draft is to. A conversation's address, a contact's address,
   * or a bare address (which becomes a contact if it is new). Anything that does
   * not name exactly one is refused rather than guessed at: a draft to the wrong
   * one of a person's two addresses is the mistake this prevents.
   */
  private resolveRecipient(input: DraftInput, actor: string, counters?: { contactsCreated: number }): Recipient {
    const wanted = input.address ? classifyAddress(input.address) : null
    const named = [input.conversationId, input.contactId, input.address].filter((v) => v !== undefined && v !== '')
    if (named.length === 0) return fail(422, 'Say who the draft is to: an address, a contact or a conversation.')
    if (input.conversationId) return this.recipientOnConversation(input.conversationId, wanted, actor, counters)
    if (input.contactId) return this.recipientOnContact(input.contactId, wanted)
    if (!wanted) return fail(422, 'The address is empty.')
    return ok({ identity: this.identityFor(wanted, input.name, actor, counters), conversationId: null })
  }

  /** The one row of `rows` that is `wanted` (or the only row, when none is wanted), or the refusal that says why not. */
  private onlyOne(
    rows: Row[],
    wanted: Classified | null,
    conversationId: string | null,
    refusals: [string, string],
  ): Recipient {
    const pick = wanted ? rows.filter((p) => p.kind === wanted.kind && p.address === wanted.address) : rows
    if (pick.length !== 1) return fail(422, wanted ? refusals[0] : refusals[1])
    const p = pick[0] as Row
    return ok({
      identity: {
        id: text(p.id),
        contactId: text(p.contact_id),
        kind: text(p.kind) as IdentityKind,
        address: text(p.address),
      },
      conversationId,
    })
  }

  private recipientOnContact(contactId: string, wanted: Classified | null): Recipient {
    if (!this.sql.exec(`SELECT 1 FROM contact WHERE id = ?1`, contactId).toArray()[0]) {
      return fail(404, 'No such contact.')
    }
    const all = this.sql
      .exec(`SELECT id, contact_id, kind, address FROM identity WHERE contact_id = ?1 ORDER BY rowid`, contactId)
      .toArray()
    return this.onlyOne(all, wanted, null, [
      'That address is not one of this contact’s.',
      'This contact has several addresses; say which one the draft is to.',
    ])
  }

  private recipientOnConversation(
    conversationId: string,
    wanted: Classified | null,
    actor: string,
    counters?: { contactsCreated: number },
  ): Recipient {
    const people = this.sql
      .exec(
        `SELECT i.id, i.contact_id, i.kind, i.address FROM participant p JOIN identity i ON i.id = p.identity_id
          WHERE p.conversation_id = ?1 ORDER BY i.rowid`,
        conversationId,
      )
      .toArray()
    if (people.length === 0) return fail(404, 'No such conversation.')
    const onThread = wanted !== null && people.some((p) => p.kind === wanted.kind && p.address === wanted.address)
    const reply = this.replyRecipient(conversationId, wanted, onThread, actor, counters)
    if (reply) return reply
    return this.onlyOne(people, wanted, conversationId, [
      'That address is not on this conversation.',
      'This conversation has several addresses; say which one the draft is to.',
    ])
  }

  /**
   * An email conversation has a reply address of its own (the Reply-To, which need not
   * be anyone on the thread). With none named, the draft is a reply to it; one named must
   * be somebody on the thread or on the message being answered, so a draft cannot be
   * pointed at an address the conversation never mentioned. Null when the ordinary rules
   * (the people on the conversation) should decide.
   */
  private replyRecipient(
    conversationId: string,
    wanted: Classified | null,
    onThread: boolean,
    actor: string,
    counters?: { contactsCreated: number },
  ): Recipient | null {
    const plan = this.replyPlan(conversationId)
    if (!plan) return null
    let target: { address: string; name?: string } | null = null
    if (!wanted) target = plan.to
    else if (wanted.kind === 'email' && !onThread && plan.everyone.includes(wanted.address)) target = wanted
    if (target) {
      return ok({
        identity: this.identityFor({ kind: 'email', address: target.address }, target.name, actor, counters),
        conversationId,
      })
    }
    return wanted && !onThread ? fail(422, 'That address is not on this conversation.') : null
  }

  /**
   * `options.empty` lets a draft be made with no words: only the draft chat uses it (a turn on a conversation with no draft gives
   * the assistant an empty one, in the owner's name, to fill), and never over the API, whose route passes no options. Send refuses
   * an empty body and edits cannot blank one, so an empty draft can only wait for words.
   */
  createDraft(rawInput: DraftInput, actor: string, options: { empty?: boolean } = {}): Result<MessageRow> {
    // Claude's choice of From is turned into the compose box's own `sendFrom` here, before anything else, so the one check below (and the one recording) serves both.
    let input = rawInput
    if (rawInput.chooseFrom !== undefined) {
      const picked = this.resolveChosenFrom(
        rawInput.chooseFrom,
        rawInput.conversationId !== undefined,
        this.writerScope(actor),
      )
      if (!picked.ok) return picked
      const { chooseFrom: _text, ...rest } = rawInput
      input = { ...rest, sendFrom: picked.value }
    }
    let subject = (input.subject ?? '').trim()
    const body = (input.body ?? '').trim()
    const why = (input.why ?? '').trim()
    if (body === '' && options.empty !== true) return fail(422, 'A draft needs a body.')
    const refused = agentDraftRefusal(actor, subject, body, why, this.ports.owner.name)
    if (refused) return refused
    if (subject.length > MAX_SUBJECT) return fail(422, TOO_LONG_SUBJECT)
    if (input.copyEveryone && !input.conversationId) {
      return fail(422, 'Copying everyone needs a conversation to copy from: say which one.')
    }
    // A person drafts only on mail they may see and sends only from mailboxes they are on (Claude's scope is the owner's): the same rule as every read (src/queue.ts `canSee`), asked here as well as by the space's part.
    const scope = this.writerScope(actor)
    if (input.conversationId) {
      const where = this.mailboxOfConversation(input.conversationId)
      if (where !== null && !canSee(scope, where.mailboxId)) return fail(404, 'No such conversation.')
    }
    // Checked before anything is made: a refused mailbox must not leave a contact for the address behind.
    const picked = this.chosenSender(input, scope)
    if (!picked.ok) return picked
    const chosen = picked.value
    return this.ports.transaction(() => {
      const to = this.resolveRecipient(input, actor)
      if (!to.ok) return to

      // A reply on an email conversation takes the thread's subject (keeping its "Re:")
      // and, when asked, copies everyone on the message it answers. Both are written
      // into the draft now, so they can be read, and changed, before it is sent.
      const plan = input.conversationId ? this.replyPlan(input.conversationId) : null
      if (input.copyEveryone && !plan)
        return fail(422, 'This conversation is not an email conversation, so there is nobody to copy.')
      if (subject === '' && plan) subject = plan.subject
      if (isAgent(actor) && subject.includes(EM_DASH)) {
        return fail(422, 'The conversation’s subject has an em dash in it; give the draft a subject without one.')
      }
      // The mailbox an email goes out from is decided HERE and recorded on the draft: a reply, the mailbox its conversation is in; a
      // new email, the mailbox the contact last wrote to (a customer hears from the business mailbox, a client from the owner's Gmail). Send uses the
      // recorded one, so a contact who writes to a different mailbox afterwards does not change who a draft in the queue is from.
      const sender = this.senderOfDraft(to.value, input, chosen, scope)
      if (!sender.ok) return sender
      const from = sender.value
      const draft = this.insertMessage({
        identityId: to.value.identity.id,
        conversationId: to.value.conversationId,
        status: 'draft',
        subject,
        body,
        why,
        createdAt: this.now(),
        createdBy: actor,
        sentAt: null,
        sentBy: null,
        sourceRef: null,
        cc: input.copyEveryone && plan ? this.copyList(plan, to.value.identity.address) : '',
        mailboxId: from?.id ?? null,
      })
      if (to.value.conversationId) this.touchConversation(to.value.conversationId)
      this.audit(actor, 'draft.create', `message:${draft.id}`, null, draft)
      return ok(draft)
    })
  }

  /**
   * The mailbox a new email's draft is to go out from, as the person CHOSE it (the space's compose box, or Claude's `from`): a Gmail account or a business mailbox, by id, among the mailboxes they are on. Null when none was chosen
   * or the draft is a reply. Refused (nothing is made) for an id that is none of ours and for one that is not the person's.
   */
  private chosenSender(input: DraftInput, scope: MailScope): Result<CloudflareSender | null> {
    if (input.conversationId) return ok(null)
    if (input.sendFrom?.kind === 'business') {
      const chosen = this.cloudflareMailboxSender(input.sendFrom.mailboxId)
      if (chosen === null)
        return fail(422, 'That is not one of the business mailboxes this inbox sends from. Nothing was drafted.')
      return canSee(scope, chosen.id) ? ok(chosen) : fail(403, noMailboxToSendFrom())
    }
    if (input.sendFrom?.kind === 'gmail') {
      const id = input.sendFrom.mailboxId ?? this.defaultGmailId(scope)
      const chosen = id === null ? null : this.gmailMailboxSender(id)
      if (chosen === null) {
        return fail(422, 'That is not one of the Gmail accounts connected to this inbox. Nothing was drafted.')
      }
      return canSee(scope, chosen.id) ? ok(chosen) : fail(403, noMailboxToSendFrom())
    }
    return ok(null)
  }

  /**
   * The mailbox an email draft goes out from, decided when it is made and recorded on it: a reply, the mailbox its conversation is in; a new email, the one chosen (`chosenSender`), else the mailbox the contact last wrote
   * to among the sender's (a customer hears from the business mailbox, a client from the owner's Gmail), else the Gmail account that would send. The owner's draft in that last case records none (the default is read at send time), as it always has; a person
   * on other mailboxes than the default's records theirs, and one on none a new email could go out from is refused, so a draft is never left that only the owner could see.
   */
  private senderOfDraft(
    to: { identity: { kind: IdentityKind; contactId: string }; conversationId: string | null },
    input: DraftInput,
    chosen: CloudflareSender | null,
    scope: MailScope,
  ): Result<CloudflareSender | null> {
    if (to.identity.kind !== 'email') return ok(null)
    if (to.conversationId) return ok(this.cloudflareSenderOf(to.conversationId) ?? this.jmapSenderOf(to.conversationId))
    // The person chose the mailbox: its own address is the sender (an id that is none of ours was refused before anything was made, so nothing is ever sent from an address that was only typed).
    if (input.sendFrom !== undefined) return ok(chosen)
    const last = this.mailboxContactLastWroteTo(to.identity.contactId, scope)
    if (last) return ok(last.sender)
    const mine = this.defaultGmailId(scope)
    if (mine !== null && (!scope.unfiled || mine !== this.defaultGmailId())) return ok(this.gmailMailboxSender(mine))
    return mine === null && !scope.unfiled ? fail(403, noMailboxToSendFrom()) : ok(null)
  }

  private insertMessage(m: {
    identityId: string
    conversationId: string | null
    status: MessageStatus
    subject: string
    body: string
    why: string
    createdAt: string
    createdBy: string
    sentAt: string | null
    sentBy: string | null
    sourceRef: string | null
    /** The Cc of an email draft, as `a@x.example, b@y.example`; '' for none. */
    cc?: string
    /** The Cloudflare mailbox a draft will go out from, recorded now so the send does not decide it later; null for Gmail's. */
    mailboxId?: string | null
  }): MessageRow {
    const id = this.ports.newId()
    this.sql.exec(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, subject, body, why,
                            created_at, created_by, updated_at, updated_by, sent_at, sent_by, source_ref, cc_header,
                            mailbox_id)
       VALUES (?1, ?2, ?3, 'out', ?4, ?5, ?6, ?7, ?8, ?9, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      id,
      m.conversationId,
      m.identityId,
      m.status,
      m.subject,
      m.body,
      m.why,
      m.createdAt,
      m.createdBy,
      m.sentAt,
      m.sentBy,
      m.sourceRef,
      m.cc ?? '',
      m.mailboxId ?? null,
    )
    return this.message(id) as MessageRow
  }

  updateDraft(id: string, patch: DraftPatch, actor: string): Result<MessageRow> {
    return this.ports.transaction(() => {
      const before = this.message(id)
      if (!before) return fail(404, 'No such message.')
      if (before.status !== 'draft') return fail(409, 'Only a draft can be edited.')
      if (patch.rev !== before.rev) return fail(409, CHANGED_SINCE_SHOWN)
      const subject = patch.subject === undefined ? before.subject : patch.subject.trim()
      const body = patch.body === undefined ? before.body : patch.body.trim()
      const why = patch.why === undefined ? before.why : patch.why.trim()
      // A picture on the draft is what lets its words be none; taken out in this very edit, it is no longer there to speak for itself.
      // Taking out one that is not there (an email draft, a draft that never had one, one already taken out) changes nothing, so it is refused and does not raise the revision.
      if (patch.takeOutPicture === true && before.picture === undefined)
        return fail(409, 'This draft has no picture to take out.')
      const takingOut = patch.takeOutPicture === true
      if (body === '' && (before.picture === undefined || takingOut)) return fail(422, 'A draft needs a body.')
      if (subject.length > MAX_SUBJECT) return fail(422, TOO_LONG_SUBJECT)
      // The same rules as creating one: an agent may not edit a draft into
      // something it could not have written, or blank the why the owner reads.
      const refused = agentDraftRefusal(actor, subject, body, why, this.ports.owner.name)
      if (refused) return refused
      const copied = this.ccAfterPatch(before, patch.copyEveryone)
      if (!copied.ok) return copied
      const cc = copied.value
      // `rev` counts the edit: a send names the revision its author saw (migration 4).
      this.sql.exec(
        `UPDATE message SET subject = ?2, body = ?3, why = ?4, cc_header = ?7, rev = rev + 1, updated_at = ?5, updated_by = ?6 WHERE id = ?1`,
        id,
        subject,
        body,
        why,
        this.now(),
        actor,
        cc,
      )
      if (takingOut) {
        this.sql.exec(`UPDATE message SET attachments = '[]', raw_key = NULL WHERE id = ?1`, id)
        this.releasePicture(before.rawKey)
      }
      const after = this.message(id) as MessageRow
      this.audit(actor, 'draft.update', `message:${id}`, before, after)
      return ok(after)
    })
  }

  /**
   * An object under a `tg/` key that a row no longer names is to be deleted (src/store/telegram.ts says how). Nothing in the base store holds one, so the base does nothing; the Telegram half overrides it. The one
   * place a draft's picture leaves a row through an edit.
   */
  protected releasePicture(_rawKey: string | undefined | null): void {}

  deleteDraft(id: string, actor: string, rev: number): Result<{ id: string }> {
    return this.ports.transaction(() => {
      const before = this.message(id)
      if (!before) return fail(404, 'No such message.')
      if (before.status !== 'draft') return fail(409, 'Only a draft can be deleted.')
      if (rev !== before.rev) return fail(409, CHANGED_SINCE_SHOWN)
      this.sql.exec(`DELETE FROM message WHERE id = ?1`, id)
      this.sql.exec(`DELETE FROM draft_chat WHERE draft_id = ?1`, id)
      // The picture a Telegram draft carries goes with it (the object is deleted by the sweep).
      this.releasePicture(before.rawKey)
      this.tombstone(before.sourceRef, actor)
      if (before.conversationId) this.touchConversation(before.conversationId)
      this.audit(actor, 'draft.delete', `message:${id}`, before, null)
      return ok({ id })
    })
  }

  /**
   * A carried draft that is removed leaves a tombstone, so the next carry run does not bring
   * back what was removed. The carry stays re-runnable until the Outbox is retired, and
   * without this a removal would last until the next run. EVERY path that removes a message
   * must call it with the message's `source_ref`: there are two (a deleted draft, and a stuck
   * send the owner says went out), and a third that forgot would bring a sent email back as a
   * draft to be sent again.
   */
  protected tombstone(sourceRef: string | null, actor: string): void {
    if (sourceRef === null) return
    this.sql.exec(
      `INSERT OR IGNORE INTO outbox_tombstone (source_ref, deleted_at, deleted_by) VALUES (?1, ?2, ?3)`,
      sourceRef,
      this.now(),
      actor,
    )
  }

  /**
   * Record that a draft was sent by hand, and file it on that contact's
   * conversation for its channel. The Outbox's "mark sent", for every channel the
   * inbox cannot send on (a text message, a DM). NOT for email, which the inbox
   * sends itself: an email sent by hand in Gmail arrives by sync as the
   * message it is, and a record of it made here as well would be a second copy of one
   * email, and a draft that could be unmarked and sent again. (The Outbox carry still
   * files an email the Outbox had marked sent: that is history, not a press.)
   */
  markSent(id: string, sentAt: string | undefined, actor: string): Result<MessageRow> {
    const at = sentAt === undefined ? this.now() : isoOrNull(sentAt)
    if (at === null) return fail(422, 'sentAt is not a full ISO timestamp, like 2026-10-20T11:00:00Z.')
    return this.ports.transaction(() => {
      const before = this.message(id)
      if (!before) return fail(404, 'No such message.')
      if (before.status !== 'draft') return fail(409, 'Only a draft can be marked sent.')
      if (before.kind === 'email') {
        return fail(
          422,
          'An email is sent with Send. If you sent this one yourself in Gmail, it will arrive here by itself: delete this draft.',
        )
      }
      const conversationId = this.fileSent(id, before, at, actor)
      this.audit(actor, 'message.mark-sent', `message:${id}`, before, this.message(id))
      this.touchConversation(conversationId)
      return ok(this.message(id) as MessageRow)
    })
  }

  private fileSent(id: string, m: MessageRow, sentAt: string, sentBy: string | null): string {
    const identity = this.sql
      .exec(`SELECT id, contact_id, kind, address FROM identity WHERE kind = ?1 AND address = ?2`, m.kind, m.address)
      .one()
    const conversationId =
      m.conversationId ??
      this.manualConversationFor({ id: text(identity.id), contactId: text(identity.contact_id), kind: m.kind })
    // Filed read and closed: it is something the owner sent, so nothing is owed on it
    // (migration 3 says why). Stamped by whoever filed it, now.
    const by = sentBy ?? m.createdBy
    this.sql.exec(
      `UPDATE message SET status = 'manual-sent', conversation_id = ?2, sent_at = ?3, sent_by = ?4,
                          read_at = ?5, read_by = ?6, closed_at = ?5, closed_by = ?6
        WHERE id = ?1`,
      id,
      conversationId,
      sentAt,
      sentBy,
      this.now(),
      by,
    )
    return conversationId
  }

  /** Mistakes happen: a marked-sent message goes back to being a draft. */
  unmarkSent(id: string, actor: string): Result<MessageRow> {
    return this.ports.transaction(() => {
      const before = this.message(id)
      if (!before) return fail(404, 'No such message.')
      if (before.status !== 'manual-sent') return fail(409, 'Only a message marked sent by hand can be unmarked.')
      this.sql.exec(
        `UPDATE message SET status = 'draft', sent_at = NULL, sent_by = NULL,
                read_at = NULL, read_by = NULL, closed_at = NULL, closed_by = NULL
          WHERE id = ?1`,
        id,
      )
      if (before.conversationId) this.touchConversation(before.conversationId)
      this.audit(actor, 'message.unmark-sent', `message:${id}`, before, this.message(id))
      return ok(this.message(id) as MessageRow)
    })
  }

  // ─── the Outbox carry ────────────────────────────────────────────────

  /**
   * Carry the Outbox's list across. Each entry becomes a message on a contact,
   * found or created from its address: an unsent one a draft that keeps its why
   * and created time, a sent one a manual-sent message with its sent time.
   *
   * IDEMPOTENT, because the Outbox stays in use until the owner has seen the carried
   * messages here, and so the carry is run more than once. An entry is found
   * again by `source_ref` (`outbox:<id>`) and left alone, with one exception: a
   * draft carried earlier that the Outbox has since marked sent is marked sent
   * here too. Nothing is ever deleted, and an edit made here to a carried draft
   * is never overwritten by the Outbox's text, ON PURPOSE: this inbox is where
   * the owner works now, so an edit made here is the newer word, and a re-run that
   * restored the Outbox's version would undo their work. A draft deleted here is
   * remembered (`outbox_tombstone`) and counted as skipped, never brought back.
   *
   * ONE TRANSACTION, so a store failure carries nothing rather than half. An entry
   * it cannot carry (no body, no recipient, a date that is not a date) is not a
   * store failure: it is reported in `problems` and the rest still go, so one bad
   * entry cannot hold the owner's drafts hostage. The report is the comparison to
   * read: what the Outbox held against what now exists.
   *
   * No em dash check: these were written before this inbox existed, the Outbox
   * already applied its own, and a sent message is a record of what went.
   *
   * `created_by` is `outbox` and `sent_by` is empty on a carried message, because
   * the Outbox recorded when and not by whom. The carry's own actor is audited.
   */
  importOutbox(entries: unknown[], actor: string): CarryReport {
    const isSent = (e: unknown) => !!(e !== null && typeof e === 'object' && (e as OutboxEntry).sentAt)
    const report: CarryReport = {
      received: {
        total: entries.length,
        unsent: entries.filter((e) => !isSent(e)).length,
        sent: entries.filter(isSent).length,
      },
      created: { drafts: 0, manualSent: 0 },
      skipped: 0,
      markedSent: 0,
      contactsCreated: 0,
      problems: [],
    }
    const counters = { contactsCreated: 0 }

    this.ports.transaction(() => {
      for (const [index, entry] of entries.entries()) {
        const checked = this.checkOutboxEntry(entry, index)
        if (!checked.ok) report.problems.push({ id: checked.id, reason: checked.reason })
        else this.carryEntry(checked.entry, actor, report, counters)
      }
    })

    report.contactsCreated = counters.contactsCreated
    return report
  }

  /**
   * What an Outbox entry is, or why it is not carryable. The entries are JSON from
   * outside, so nothing about their types is assumed: a field of the wrong type is
   * treated as absent, and what is left must still make a message.
   */
  private checkOutboxEntry(
    raw: unknown,
    index: number,
  ): { ok: true; entry: CheckedEntry } | { ok: false; id: string; reason: string } {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, id: `(entry ${index})`, reason: 'The entry is not an object.' }
    }
    const entry = raw as OutboxEntry
    const id = text(entry.id).trim()
    const bad = (reason: string) => ({ ok: false as const, id: id || '(no id)', reason })
    if (id === '') return bad('The entry has no id.')
    const body = text(entry.body).trim()
    if (body === '') return bad('The entry has no body.')

    const sentAt = entry.sentAt ? isoOrNull(entry.sentAt) : null
    if (entry.sentAt && sentAt === null) return bad(`sentAt "${text(entry.sentAt)}" is not a full ISO timestamp.`)
    const createdAt = entry.created ? isoOrNull(entry.created) : this.now()
    if (createdAt === null) return bad(`created "${text(entry.created)}" is not a full ISO timestamp.`)

    const to = text(entry.to).trim()
    const classified = classifyAddress(text(entry.address).trim() || to)
    if (!classified) return bad('The entry has neither an address nor a recipient.')

    return {
      ok: true,
      entry: {
        sourceRef: `outbox:${id}`,
        body,
        sentAt,
        createdAt,
        to,
        classified,
        subject: text(entry.subject).trim(),
        why: text(entry.why).trim(),
      },
    }
  }

  /** Carry one checked entry: make it, or find it again and leave it (or mark it sent). */
  private carryEntry(e: CheckedEntry, actor: string, report: CarryReport, counters: { contactsCreated: number }): void {
    if (this.sql.exec(`SELECT 1 FROM outbox_tombstone WHERE source_ref = ?1`, e.sourceRef).toArray()[0]) {
      report.skipped += 1
      return
    }
    const existing = this.sql.exec(`SELECT id, status FROM message WHERE source_ref = ?1`, e.sourceRef).toArray()[0]
    if (existing) {
      if (existing.status === 'draft' && e.sentAt) {
        const id = text(existing.id)
        const before = this.message(id) as MessageRow
        this.touchConversation(this.fileSent(id, before, e.sentAt, null))
        this.audit(actor, 'message.mark-sent', `message:${id}`, before, this.message(id))
        report.markedSent += 1
      } else {
        report.skipped += 1
      }
      return
    }

    const identity = this.identityFor(e.classified, e.to || undefined, actor, counters)
    const draft = this.insertMessage({
      identityId: identity.id,
      conversationId: null,
      status: 'draft',
      subject: e.subject,
      body: e.body,
      why: e.why,
      createdAt: e.createdAt,
      createdBy: CARRIED_BY,
      sentAt: null,
      sentBy: null,
      sourceRef: e.sourceRef,
    })
    if (e.sentAt) {
      this.touchConversation(this.fileSent(draft.id, draft, e.sentAt, null))
      report.created.manualSent += 1
    } else {
      report.created.drafts += 1
    }
    this.audit(actor, 'outbox.carry', `message:${draft.id}`, null, {
      sourceRef: e.sourceRef,
      status: e.sentAt ? 'manual-sent' : 'draft',
    })
  }

  // ─── audit ───────────────────────────────────────────────────────────

  /**
   * The latest writes, newest first, that the scope may see: an entry is about a message, a conversation, a mailbox, a contact or the install's own settings, and it is shown when what it is about is in a mailbox the scope
   * may see. One about something that is gone (a draft thrown away, a contact merged in) is placed by the conversation its snapshot names, else it is the owner's (what belongs to no mailbox). Without a scope, every entry.
   */
  listAudit(limit = 100, scope: MailScope = ALL_MAIL): AuditRow[] {
    const mapped = (r: Row): AuditRow => ({
      id: Number(r.id),
      at: text(r.at),
      actor: text(r.actor),
      action: text(r.action),
      subject: text(r.subject),
      before: typeof r.before === 'string' ? JSON.parse(r.before) : null,
      after: typeof r.after === 'string' ? JSON.parse(r.after) : null,
    })
    const cut = Math.trunc(limit)
    if (scope.mailboxIds === null && scope.unfiled) {
      return this.sql
        .exec(`SELECT id, at, actor, action, subject, before, after FROM audit ORDER BY id DESC LIMIT ${cut}`)
        .toArray()
        .map(mapped)
    }
    const contacts = this.visibleContactIds(scope)
    const out: AuditRow[] = []
    let below = Number.MAX_SAFE_INTEGER
    while (out.length < cut) {
      const page = this.sql
        .exec(
          `SELECT id, at, actor, action, subject, before, after FROM audit WHERE id < ?1 ORDER BY id DESC LIMIT 500`,
          below,
        )
        .toArray()
      if (page.length === 0) break
      for (const r of page) {
        below = Number(r.id)
        const row = mapped(r)
        if (this.auditSeen(scope, contacts, row) && out.length < cut) out.push(row)
      }
    }
    return out
  }

  /** Whether the scope may see what an audit entry is about (see `listAudit`). */
  private auditSeen(scope: MailScope, contacts: Set<string> | null, row: AuditRow): boolean {
    const [kind, ...rest] = row.subject.split(':')
    const id = rest.join(':')
    const snapshot = (row.after ?? row.before) as { conversationId?: unknown } | null
    switch (kind) {
      case 'message': {
        const held = this.mailboxOfMessage(id)
        if (held !== null) return canSee(scope, held.mailboxId)
        const conversation =
          typeof snapshot?.conversationId === 'string' ? this.mailboxOfConversation(snapshot.conversationId) : null
        return canSee(scope, conversation?.mailboxId ?? null)
      }
      case 'conversation':
        return canSee(scope, this.mailboxOfConversation(id)?.mailboxId ?? null)
      case 'mailbox':
        return canSee(scope, id)
      case 'contact': {
        const exists = this.sql.exec(`SELECT 1 FROM contact WHERE id = ?1`, id).toArray().length > 0
        return exists ? (contacts?.has(id) ?? true) : scope.unfiled
      }
      default:
        return scope.unfiled
    }
  }
}
