import { normalizeAddress } from '@space/workspace'
import { LABEL } from '../gmail/types'
import { isBulk } from '../queue'
import type { Envelope, NotificationPayload, SenderJudgment, SpamCall } from '../types'

/**
 * Which mail makes the owner's phone and laptop show a notification, and what the notification says, as pure functions.
 * Why the rule is these checks, why it reuses
 * the queue's Bulk rule and the contacts' automated-sender rule instead of restating them, and when the store asks it
 * are in the inbox's ADR 0001.
 *
 * The checks that read only the message come first; the two that read the whole store (Bulk, which reads the
 * conversation, and the sender's judgment, which counts every conversation the contact is on) are thunks, asked only
 * when the cheap ones pass. Every check must pass, so their order changes only the reason given.
 */

/** The freshness window and the push request's time to live: one constant, because they are one rule. */
export const NOTIFY_WINDOW_S = 60 * 60

/** Whether Gmail received the message within the window. The one freshness check, for the rule and for delivery. */
export const fresh = (receivedAt: string, now: Date): boolean =>
  now.getTime() - Date.parse(receivedAt) <= NOTIFY_WINDOW_S * 1000

export type NotifyReason = 'sent' | 'own-address' | 'not-in-inbox' | 'read' | 'stale' | 'bulk' | 'automated'

export interface NotifyInput {
  /** Gmail's labels on the message as stored now, after the page's label changes. */
  labels: readonly string[]
  /** The From address, lower case, or null when the message names none. */
  from: string | null
  /** The mailbox's own addresses, lower case. */
  own: ReadonlySet<string>
  /** When Gmail received it (its own time), ISO. */
  receivedAt: string
  now: Date
  /** The conversation's facts as the queue reads them, for Bulk. Asked only when the cheap checks pass. */
  conversation: () => { newestInbound: Envelope | null; clientIds: number[]; spamCall?: SpamCall }
  /** The sender's contact, judged as the contact page judges it. Asked last. */
  sender: () => SenderJudgment
}

/** Notify, or the first reason not to. */
export function notifyDecision(m: NotifyInput): { notify: true } | { notify: false; reason: NotifyReason } {
  const no = (reason: NotifyReason) => ({ notify: false as const, reason })
  // It came in, and not from the mailbox's own address: the owner from Gmail or the inbox, Claude on the owner's word, a note to self.
  if (m.labels.includes(LABEL.sent)) return no('sent')
  if (m.from !== null && m.own.has(m.from)) return no('own-address')
  // In Gmail's Inbox and unread as stored: mail already read in Gmail has been seen.
  if (!m.labels.includes(LABEL.inbox)) return no('not-in-inbox')
  if (!m.labels.includes(LABEL.unread)) return no('read')
  // Found within the hour: anything later came by the daily pass or after an outage, and waits in the Inbox.
  if (!fresh(m.receivedAt, m.now)) return no('stale')
  // A person, by the inbox's own two rules, each of which counts a Client's people as people.
  const facts = m.conversation()
  if (isBulk(facts)) return no('bulk')
  // A person who moved the conversation back to the Inbox has said it is not automated mail: the sender check does not overrule them.
  if (facts.spamCall?.spam !== false && m.sender().automated) return no('automated')
  return { notify: true }
}

export type CloudflareNotifyReason = 'own-address' | 'bulk' | 'closed' | 'read' | 'stale'

/**
 * The notification rule's Cloudflare branch, asked ONCE per message, when
 * its Inbox-or-Bulk question is settled: at filing for mail no judgment is owed on, and after the spam classifier has answered (or failed to)
 * for mail it was asked about (src/cloudflare/arrivals.ts). It has the Gmail rule's shape: Inbox mail notifies and Bulk
 * does not, where Bulk is the queue's one rule (`isBulk` in src/queue.ts: a Client's people always Inbox, then a person's call,
 * a List-Unsubscribe header, an automated sender, the classifier's score), so the Gmail rule's separate sender check is folded into it
 * and is not asked again. It has no labels to read: the conversation is open and unread as the inbox's own stamps have it
 * (the owner opening it first means they have seen it), and Cloudflare received the message within the hour. A message from the
 * mailbox's own address or its domain (a reply of ours coming back, a note to self) never notifies. A message nothing judged
 * (the classifier off, down, slow) is not Bulk, so it notifies: a model outage never hides a customer. A ping to a team chat
 * group, as an earlier setup sent, stops at the switch and is not carried over.
 */
export function cloudflareNotifyDecision(m: {
  /** The conversation is Bulk by the queue's rule, with the message's own score (if any) already stored. */
  bulk: boolean
  /** The sender is the mailbox's own address or on its domain (`belongsToMailbox`). */
  own: boolean
  open: boolean
  unread: boolean
  /** When Cloudflare's handler received the message, ISO. */
  receivedAt: string
  now: Date
}): { notify: true } | { notify: false; reason: CloudflareNotifyReason } {
  const no = (reason: CloudflareNotifyReason) => ({ notify: false as const, reason })
  if (m.own) return no('own-address')
  if (m.bulk) return no('bulk')
  if (!m.open) return no('closed')
  if (!m.unread) return no('read')
  if (!fresh(m.receivedAt, m.now)) return no('stale')
  return { notify: true }
}

export type TelegramNotifyReason = 'not-live' | 'own' | 'muted' | 'not-to-you' | 'bulk' | 'closed' | 'read' | 'stale'

/**
 * The notification rule's Telegram branch, asked ONCE per message, when the push that stored it is filed. It has the Cloudflare
 * branch's shape (the mail rule: a person's message, open and unread as the inbox's own stamps have it, found within the hour, Bulk never rings) and three Telegram checks first:
 *
 * - `live`: only a message Telegram told the bridge of as it happened rings. The first fill, a read-through and a catch-up after a gap bring messages that are not news to the
 *   phone the owner holds, and a gap of an hour or less would otherwise ring a burst of them (the freshness check is an hour wide);
 * - `out`: the owner's own message, sent from their phone, is not news to them;
 * - `muted`: a chat the owner muted in Telegram never rings, as on their phone. The flag is the one the push carried with this message, so a mute made a minute ago counts.
 *
 * A group rings only for a message that mentions the owner or replies to them: the `group` and `toMe` inputs, one more check after the mute. A channel and a bot are
 * Bulk and never ring.
 */
export function telegramNotifyDecision(m: {
  live: boolean
  /** The owner's own message. */
  out: boolean
  muted: boolean
  /** The chat is a group, and `toMe`: the message mentions the owner or replies to one of theirs. Only such a message in a group rings; in a one-to-one chat both are ignored. */
  group?: boolean
  toMe?: boolean
  /** The conversation is Bulk by the queue's one rule (a bot is an automated sender, and so is a channel's contact). */
  bulk: boolean
  open: boolean
  unread: boolean
  /** When the message was sent (Telegram's time), ISO. */
  receivedAt: string
  now: Date
}): { notify: true } | { notify: false; reason: TelegramNotifyReason } {
  const no = (reason: TelegramNotifyReason) => ({ notify: false as const, reason })
  if (!m.live) return no('not-live')
  if (m.out) return no('own')
  if (m.muted) return no('muted')
  if (m.group === true && m.toMe !== true) return no('not-to-you')
  if (m.bulk) return no('bulk')
  if (!m.open) return no('closed')
  if (!m.unread) return no('read')
  if (!fresh(m.receivedAt, m.now)) return no('stale')
  return { notify: true }
}

/**
 * ── MORE THAN THREE AT ONCE ARE ONE ──────────────────────────────────────
 * The rule: when one delivery run has more than COLLAPSE_AFTER notifications to hand on, they
 * arrive as ONE notification ("5 new messages", "From Ines, Owen and 3 others") whose tap opens the Inbox, and none
 * of them is sent on its own afterwards. Up to COLLAPSE_AFTER arrive one by one.
 */
export const COLLAPSE_AFTER = 3

/** How many senders a summary names before "and N others". */
const NAMED_IN_SUMMARY = 2

/** The longest title and body a notification carries. */
export const MAX_TITLE = 80
export const MAX_BODY = 200

/** What a message without a subject shows. */
export const NO_SUBJECT = '(no subject)'

/** The version the service worker reads. A payload of any other is shown as "New mail" with no detail. */
export const PAYLOAD_VERSION = 1

const cut = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/**
 * The notification for one message: the sender's contact name as the inbox shows it (else the address) over the
 * subject, and the ids that let a tap open the conversation; for Cloudflare mail the mailbox's name leads the title.
 * NOTHING ELSE: never the text, the snippet, an address beyond the sender's when it has no name, a Client, the draft
 * or anything Claude or the assistant wrote.
 */
export function messagePayload(m: {
  conversationId: string
  messageId: string
  name: string
  address: string
  subject: string
  receivedAt: string
  /** The Cloudflare mailbox's name, on mail that arrived through one: the title then says which business wrote. */
  mailbox?: string
  /**
   * The key the space opens this person's conversation by, when the sender's address is not an email (a Telegram person: the first email the contact has, else `mail:<contact id>`, the
   * space's own rule in `personRow`). Absent, it is the address in its one spelling.
   */
  person?: string
}): NotificationPayload {
  // The notification also says who wrote (their address, in the one spelling the space opens a conversation by): the space's conversations are
  // one per person, so a tap opens `/inbox/<address>`, and the inbox's conversation id would mean nothing there.
  const person = m.person ?? normalizeAddress(m.address)
  return {
    v: PAYLOAD_VERSION,
    kind: 'message',
    conversationId: m.conversationId,
    ...(person !== null && { person }),
    messageId: m.messageId,
    title: cut(m.mailbox ? `${m.mailbox}: ${m.name.trim() || m.address}` : m.name.trim() || m.address, MAX_TITLE),
    body: cut(m.subject, MAX_BODY) || NO_SUBJECT,
    at: m.receivedAt,
  }
}

/** The test notification Settings sends to one device. It names no conversation, so a tap opens the space's Conversations list. */
export function testPayload(now: Date, company: string): NotificationPayload {
  return {
    v: PAYLOAD_VERSION,
    kind: 'test',
    conversationId: null,
    messageId: `test-${now.getTime()}`,
    title: `${company} Space`,
    body: 'Notifications work on this device.',
    at: now.toISOString(),
  }
}

/** A sender as a summary names them: the first word of the contact's name, else the address. */
const firstName = (name: string, address: string): string => name.trim().split(/\s+/)[0] || address

/**
 * The one notification for more than COLLAPSE_AFTER messages: how many, and from whom (each sender once, in the order
 * their mail arrived), with no conversation, so a tap opens the Inbox. Tagged by the first message, so a run that
 * dies after sending it and sends it again replaces it without sounding twice.
 */
export function summaryPayload(
  messages: readonly { messageId: string; name: string; address: string; receivedAt: string }[],
  now: Date,
): NotificationPayload {
  const senders = [...new Set(messages.map((m) => firstName(m.name, m.address)))]
  const named = senders.slice(0, NAMED_IN_SUMMARY)
  const others = senders.length - named.length
  const from =
    others === 0
      ? named.length === 2
        ? `${named[0]} and ${named[1]}`
        : (named[0] ?? '')
      : `${named.join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`
  return {
    v: PAYLOAD_VERSION,
    kind: 'summary',
    conversationId: null,
    messageId: `summary-${messages[0]?.messageId ?? now.getTime()}`,
    title: `${messages.length} new messages`,
    body: cut(`From ${from}`, MAX_BODY),
    at: now.toISOString(),
  }
}
