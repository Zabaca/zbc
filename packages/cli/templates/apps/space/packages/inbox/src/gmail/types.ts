import type { CalendarMail } from '../calendar-event'
import type { AttachmentInfo } from '../types'

/**
 * The shapes of Gmail's API that the inbox reads, and the shapes it turns them
 * into. Only the fields something here actually uses are declared: a type that
 * lists everything Google documents would make a fixture that includes it all
 * look like a faithful one (the option's rule is trimmed REAL responses, never
 * documentation).
 *
 * Plain data only, so these cross the Durable Object boundary and the tests
 * unchanged.
 */

/** One part of a message, as `messages.get?format=full` returns it. */
export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  /** Milliseconds since the epoch, as a string: when Gmail received or accepted it. */
  internalDate?: string
  payload?: GmailPart
}

/** What a history record names about one message. `labelIds` is the message's labels at that event. */
export interface HistoryMessageRef {
  id: string
  threadId: string
  labelIds?: string[]
}

export interface HistoryRecord {
  id: string
  messagesAdded?: { message: HistoryMessageRef }[]
  messagesDeleted?: { message: HistoryMessageRef }[]
  labelsAdded?: { message: HistoryMessageRef; labelIds: string[] }[]
  labelsRemoved?: { message: HistoryMessageRef; labelIds: string[] }[]
}

export interface HistoryPage {
  history: HistoryRecord[]
  nextPageToken: string | null
  /** The mailbox's current history id, when this response was made. */
  historyId: string
}

/** A person as a header names them. `address` is as written; the store normalizes it. */
export interface ParsedAddress {
  name: string
  address: string
}

/** A Gmail message as the store keeps it. */
export interface ParsedMessage {
  gmailId: string
  threadId: string
  /** The RFC 5322 Message-ID header, or null. */
  rfcMessageId: string | null
  inReplyTo: string | null
  from: ParsedAddress | null
  to: ParsedAddress[]
  cc: ParsedAddress[]
  /** The three headers decoded for reading, as written. */
  fromHeader: string
  toHeader: string
  ccHeader: string
  /** The Reply-To header decoded, '' when there is none. */
  replyToHeader: string
  subject: string
  snippet: string
  body: string
  bodyTruncated: boolean
  attachments: AttachmentInfo[]
  labels: string[]
  /** Gmail's own time for it, as ISO. Null only when Gmail sent none. */
  receivedAt: string | null
  /** The Date header as ISO, or null when it is missing or not a date. */
  senderDate: string | null
  listUnsubscribe: boolean
  /** The calendar event the message is an invitation, update or cancellation of (src/calendar-event.ts), or null. Left out by a caller that has no calendar mail. */
  event?: CalendarMail | null
}

/** Gmail's label ids that the inbox acts on. Everything else is stored and ignored. */
export const LABEL = {
  inbox: 'INBOX',
  sent: 'SENT',
  unread: 'UNREAD',
  spam: 'SPAM',
  trash: 'TRASH',
  draft: 'DRAFT',
} as const

/**
 * Gmail's category tabs that mean "not a person writing to you": Promotions, Social,
 * Updates and Forums. A message in one of them is Bulk (src/queue.ts). Primary
 * (CATEGORY_PERSONAL) is not on the list. Gmail files into these itself, which is
 * why the inbox reads them and never decides them.
 */
export const BULK_CATEGORY_LABELS: readonly string[] = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]

/** The labels that keep a message out of the store whatever else is true of it. */
export const EXCLUDED_LABELS: readonly string[] = [LABEL.spam, LABEL.trash, LABEL.draft]

/**
 * Whether a message is in play: not in the trash, not spam, not an unfinished draft. The one
 * place that says so; what is not in play is never stored, takes no part in whether a
 * conversation is read or open, and is never put back in the Inbox.
 */
export function inPlay(labels: Iterable<string>): boolean {
  for (const l of labels) if (EXCLUDED_LABELS.includes(l)) return false
  return true
}

/**
 * Whether a message belongs in the store: it is in the Inbox or in Sent, or it is
 * in a conversation already stored; and it is never spam, trash or one of the owner's
 * unfinished drafts. Mail a Gmail filter files away on arrival, in no stored
 * conversation, is skipped on purpose.
 */
export function belongsInStore(labels: readonly string[], threadStored: boolean): boolean {
  if (!inPlay(labels)) return false
  return threadStored || labels.includes(LABEL.inbox) || labels.includes(LABEL.sent)
}
