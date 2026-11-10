import { classifyAddress } from './store/address'
import type { DeliveryNote, DeliveryState } from './types'

/**
 * What Cloudflare reports of the mail the inbox sent as a Cloudflare mailbox, and how it is read. Pure over plain data, so what is believed and what is shown are table tests
 * with no queue and no Worker.
 *
 * ── WHERE THE REPORTS COME FROM ──────────────────────────────────────────
 * Cloudflare's Email Sending publishes an event for each recipient of each message to a Queue the account subscribes to (an "event
 * subscription" on the queue, one per sending domain, made by the install's deploy). The Worker consumes the queue
 * (`keepReports` in src/entrances.ts). The event shapes are Cloudflare's own and are read from its documentation
 * (developers.cloudflare.com/email-service/reference/event-subscriptions); the six names are the ones it lists.
 *
 * ── WHAT IS BELIEVED ─────────────────────────────────────────────────────
 * A queue message is data from outside, so it is read, never trusted: it must be an Email Sending event of a known kind with an id, a message
 * id and a recipient, and its SENDER must be a declared Cloudflare mailbox's address. A sender that is not (the same domain also sends the
 * site's own mail) is not ours, and is dropped here rather than kept. Nothing in it can add anything but a row of text: a reason is cut and
 * stripped of control characters, and the page and the space draw it as text.
 *
 * ── WHAT IS SHOWN ────────────────────────────────────────────────────────
 * One note per recipient: the newest report that settles it. A terminal report (delivered, bounced, failed, rejected, complained) beats a
 * deferred one however late the deferred one arrives, because the queue promises no order; among terminal ones the newest wins, so a
 * complaint that follows a delivery is what shows.
 */

export const DELIVERY_STATES: readonly DeliveryState[] = [
  'delivered',
  'deferred',
  'bounced',
  'failed',
  'rejected',
  'complained',
]

/** One report, read: the row the store keeps. Times are ISO text, as the store keeps them. */
export interface DeliveryEvent {
  /** Cloudflare's id for the report: a report delivered twice (a queue retries) is one. */
  eventId: string
  /** The id Cloudflare gave the message when it accepted it, as the binding reported it, with no angle brackets. */
  providerId: string
  /** Lower case, bare. */
  recipient: string
  state: DeliveryState
  terminal: boolean
  /** Cloudflare's words for why, one line, cut at REASON_CHARS. '' when it gave none. */
  reason: string
  /** When Cloudflare reported it. */
  at: string
}

/** The longest reason kept: a receiving server's refusal is a line; anything longer is a page of something else. */
export const REASON_CHARS = 300

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to strip control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const word = (v: unknown): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim() : '')

/** The bare lower-case address in a header-style value (`Name <a@b.c>` or `a@b.c`), or null. */
function bareAddress(value: unknown): string | null {
  const given = word(value)
  const inner = /<([^<>]+)>/.exec(given)?.[1] ?? given
  const classified = classifyAddress(inner)
  return classified?.kind === 'email' ? classified.address : null
}

/** An id as the store compares it: no angle brackets, no spaces. */
export const providerIdOf = (id: string): string => id.trim().replace(/^<|>$/g, '')

function reasonOf(payload: Record<string, unknown>, state: DeliveryState): string {
  const pieces: string[] = []
  const bounce = record(payload.bounce)
  const delivery = record(payload.delivery)
  const rejection = record(payload.rejection)
  const failure = record(payload.failure)
  const complaint = record(payload.complaint)
  if (state === 'bounced' || state === 'deferred') pieces.push(word(bounce?.reason), word(delivery?.smtpResponse))
  else if (state === 'rejected') pieces.push(word(rejection?.detail), word(rejection?.reason))
  else if (state === 'failed') pieces.push(word(failure?.reason))
  else if (state === 'complained') pieces.push(word(complaint?.type))
  const first = pieces.find((p) => p !== '') ?? ''
  return first.length > REASON_CHARS ? `${first.slice(0, REASON_CHARS - 1)}…` : first
}

/**
 * A queue message read as a report from one of our mailboxes, or null when it is not one: not an Email Sending event, a kind this does not
 * know, a field missing, or a sender that is not a declared mailbox (`senders`, lower case, bare). `now` stands in for a missing or unreadable
 * event time, so a report is always ordered.
 */
export function readDeliveryEvent(body: unknown, senders: readonly string[], now: Date): DeliveryEvent | null {
  const event = record(body)
  const type = word(event?.type)
  const prefix = 'cf.email.sending.message.'
  if (!event || !type.startsWith(prefix)) return null
  const state = type.slice(prefix.length) as DeliveryState
  if (!DELIVERY_STATES.includes(state)) return null
  const payload = record(event.payload)
  if (!payload) return null
  const eventId = word(payload.eventId)
  const providerId = providerIdOf(word(payload.messageId))
  const recipient = bareAddress(payload.recipient)
  const sender = bareAddress(payload.sender)
  if (eventId === '' || providerId === '' || recipient === null || sender === null || !senders.includes(sender))
    return null
  const stamp = Date.parse(word(record(event.metadata)?.eventTimestamp))
  return {
    eventId,
    providerId,
    recipient,
    state,
    // Cloudflare says whether a report is the last word. An event that does not say is terminal unless it is a deferral.
    terminal: typeof payload.terminal === 'boolean' ? payload.terminal : state !== 'deferred',
    reason: reasonOf(payload, state),
    at: new Date(Number.isFinite(stamp) ? stamp : now.getTime()).toISOString(),
  }
}

/** A report as the store holds it, for `notesFor`. */
export interface HeldEvent {
  recipient: string
  state: DeliveryState
  terminal: boolean
  reason: string
  at: string
  keptAt: string
}

/** The notes for one message: one per recipient, the report that settles each, in the order the recipients were first reported. */
export function notesFor(events: readonly HeldEvent[]): DeliveryNote[] {
  const best = new Map<string, HeldEvent>()
  for (const e of events) {
    const held = best.get(e.recipient)
    if (!held || beats(e, held)) best.set(e.recipient, e)
  }
  return [...best.values()].map((e) => ({ recipient: e.recipient, state: e.state, reason: e.reason, at: e.at }))
}

/** Whether `a` settles a recipient better than `b`: terminal over not, then newer, then the one kept later. */
function beats(a: HeldEvent, b: HeldEvent): boolean {
  if (a.terminal !== b.terminal) return a.terminal
  if (a.at !== b.at) return a.at > b.at
  return a.keptAt > b.keptAt
}
