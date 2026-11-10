import { CALENDAR_SUMMARY_PART_MAX, type CalendarSummary } from '@space/workspace'
import PostalMime, { type Address, type Email } from 'postal-mime'
import { type CalendarMail, eventOf } from '../calendar-event'
import { isCalendarPart, summaryOfCalendar } from '../calendar-summary'
import { repairMojibake } from '../charset'
import { BODY_CAP, htmlToText, tidyLine } from '../gmail/parse'
import type { ParsedAddress } from '../gmail/types'
import type { AttachmentInfo } from '../types'

/**
 * A message as Cloudflare hands it over (raw RFC 5322 bytes) becoming the row the store keeps: the parser
 * already proven on real mail (postal-mime), then the same reductions the Gmail side makes, so a
 * message looks the same in the inbox whichever way it arrived.
 *
 * ── PLAIN TEXT ONLY, ALWAYS ──────────────────────────────────────────────
 * The sender's HTML is never kept and never rendered: with no text part, the HTML is reduced to
 * text here and the markup is gone before anything is stored. Attachments are a name, a size and the type their sender
 * declared; no byte of one is kept in the store (the exact message, attachments and all, is the raw copy in the
 * bucket). The body is capped as a Gmail one is.
 *
 * ── MAIL IS UNTRUSTED INPUT ──────────────────────────────────────────────
 * Every string out of here is something a stranger wrote. Nothing here interprets it. The one thing that is
 * computed from it, the Message-ID, is only ever compared as text.
 */
export interface ParsedArrival {
  /** The Message-ID with its angle brackets, or null when the message has none (it is then identified by its raw bytes). */
  messageId: string | null
  /** The Message-ID this answers, bracketed, or null. */
  inReplyTo: string | null
  /** Every Message-ID in References, bracketed, oldest first. */
  references: string[]
  from: ParsedAddress | null
  to: ParsedAddress[]
  cc: ParsedAddress[]
  /** The people headers as they read, one line each. '' when absent. */
  fromHeader: string
  toHeader: string
  ccHeader: string
  replyToHeader: string
  subject: string
  body: string
  bodyTruncated: boolean
  attachments: AttachmentInfo[]
  /** The Date header as ISO, or null when it is missing or not a date. */
  senderDate: string | null
  listUnsubscribe: boolean
  /** The calendar event the message is an invitation, update or cancellation of (src/calendar-event.ts), or null. Left out by a caller that has no calendar mail. */
  event?: CalendarMail | null
  /** What the first calendar part says (src/calendar-summary.ts), or null: no calendar part, no event in it, or one that cannot be read. Left out by a caller that has no calendar mail. */
  calendar?: CalendarSummary | null
}

/** How much of a body the list row's line keeps, as Gmail's snippet is a line. */
export const SNIPPET_CHARS = 200

/** Every Message-ID in a header value, bracketed, in order. Anything not shaped like one is dropped. */
export function messageIds(value: string | undefined): string[] {
  const found = (value ?? '').match(/<[^\s<>]+>/g)
  return found ? [...found] : []
}

const special = /[,;:<>()[\]@\\".]/

/** A person as a header would write them, quoted where the name needs it, so `parseAddressList` reads it back as it was. */
export function formatAddress(a: ParsedAddress): string {
  const name = tidyLine(a.name)
  if (name === '') return a.address
  return special.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${a.address}>` : `${name} <${a.address}>`
}

/** The mailboxes in a parsed address list: a group is flattened to its members, an entry with no address dropped. */
function people(list: Address[] | Address | undefined): ParsedAddress[] {
  const out: ParsedAddress[] = []
  for (const a of Array.isArray(list) ? list : list ? [list] : []) {
    if (a.group) for (const m of a.group) if (m.address) out.push({ name: m.name ?? '', address: m.address })
    if (a.address) out.push({ name: a.name ?? '', address: a.address })
  }
  return out
}

function capped(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  let end = cap
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

const sizeOf = (content: Email['attachments'][number]['content']): number =>
  typeof content === 'string' ? content.length : content.byteLength

const asText = (content: Email['attachments'][number]['content']): string =>
  typeof content === 'string' ? content : new TextDecoder().decode(content)

/** The calendar event a parsed message is about: its iCalendar parts (postal-mime lists them with the attachments) and its text and HTML as the sender wrote them. */
function eventOfEmail(email: Email, answersAnother: boolean): CalendarMail | null {
  try {
    return eventOf({
      calendars: email.attachments
        .filter((a) => a.mimeType?.toLowerCase() === 'text/calendar')
        .map((a) => asText(a.content)),
      texts: [email.text ?? '', email.html ?? ''].filter((t) => t !== ''),
      subject: email.subject ?? '',
      sender: email.sender?.address ?? '',
      listId: email.headers.find((h) => h.key === 'list-id')?.value ?? '',
      answersAnother,
    })
  } catch {
    return null
  }
}

/**
 * What the message's first calendar part says (src/calendar-summary.ts): the part, inline or a file (`isCalendarPart`), as postal-mime lists it with the attachments, read as text. `null` when there is none, it is over the limit, or it holds no event.
 * Never throws: a part that cannot be read leaves the email stored as it always was.
 */
function calendarOfEmail(email: Email): CalendarSummary | null {
  try {
    const part = email.attachments.find((a) => isCalendarPart(a.mimeType, a.filename))
    if (!part || sizeOf(part.content) > CALENDAR_SUMMARY_PART_MAX) return null
    return summaryOfCalendar(asText(part.content))
  } catch {
    return null
  }
}

/** Parse one raw message. Throws only when the parser does, which the caller treats as "kept, owed a filing". */
export async function parseRaw(raw: ArrayBuffer | Uint8Array): Promise<ParsedArrival> {
  const email = await PostalMime.parse(raw)
  const header = (name: string): string => email.headers.find((h) => h.key === name)?.value.trim() ?? ''

  // postal-mime reads a Latin label on UTF-8 bytes as windows-1252 and has no hook to say otherwise (src/charset.ts), so the text is put right after.
  const text = repairMojibake(email.text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const body = capped(
    text !== '' ? text : htmlToText(repairMojibake(email.html ?? '').replace(/\r\n?/g, '\n')),
    BODY_CAP,
  )

  const from = people(email.from)
  const to = people(email.to)
  const cc = people(email.cc)
  const date = email.date ? Date.parse(email.date) : Number.NaN

  const inReplyTo = messageIds(email.inReplyTo)[0] ?? null
  return {
    messageId: messageIds(email.messageId)[0] ?? null,
    inReplyTo,
    references: messageIds(email.references),
    from: from[0] ?? null,
    to,
    cc,
    fromHeader: from.map(formatAddress).join(', '),
    toHeader: to.map(formatAddress).join(', '),
    ccHeader: cc.map(formatAddress).join(', '),
    replyToHeader: people(email.replyTo).map(formatAddress).join(', '),
    subject: tidyLine(repairMojibake(email.subject ?? '')),
    body: body.text,
    bodyTruncated: body.truncated,
    attachments: email.attachments
      // As Gmail's list is: a part with a file name. A picture an HTML body embeds has none.
      .filter((a) => a.filename)
      .map((a) => ({
        name: a.filename ?? '',
        size: sizeOf(a.content),
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      })),
    senderDate: Number.isFinite(date) ? new Date(date).toISOString() : null,
    listUnsubscribe: header('list-unsubscribe') !== '',
    event: eventOfEmail(email, inReplyTo !== null || messageIds(email.references).length > 0),
    calendar: calendarOfEmail(email),
  }
}

/**
 * One attachment of a kept raw message, by its place in the list `parseRaw` stored (a part with a file name, in the order the message has them),
 * or null when the message has none there. The file name and size come back so the caller can check them against what the store kept before
 * handing out a byte: the same bytes parse the same way, so a mismatch means the copy is not the message the row was made from.
 */
export async function keptAttachment(
  raw: ArrayBuffer | Uint8Array,
  index: number,
): Promise<{ name: string; size: number; bytes: Uint8Array } | null> {
  const email = await PostalMime.parse(raw)
  const part = email.attachments.filter((a) => a.filename)[index]
  if (!part) return null
  const content = part.content
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content as ArrayBuffer)
  return { name: part.filename ?? '', size: sizeOf(content), bytes }
}
