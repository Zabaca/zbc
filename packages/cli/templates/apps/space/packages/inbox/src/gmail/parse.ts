import { CALENDAR_SUMMARY_PART_MAX, type CalendarSummary } from '@space/workspace'
import { eventOf } from '../calendar-event'
import { isCalendarPart, summaryOfCalendar } from '../calendar-summary'
import { decodeBody } from '../charset'
import type { AttachmentInfo } from '../types'
import type { GmailMessage, GmailPart, ParsedAddress, ParsedMessage } from './types'

/**
 * A Gmail message, as the API returns it, becoming the row the store keeps: pure
 * functions over plain data, so what a message looks like once stored is a table
 * test with no store and no network.
 *
 * ── A WORKER'S PARSER, NOT A NODE SCRIPT'S ──────────────────────────────
 * `bodyOf` and `attachmentsOf` are a Worker-sized take on the usual command-line Gmail reader,
 * with its test cases in test/gmail-parse.test.ts. What differs from the Node version: no Node `Buffer` (the Worker has none, and
 * `nodejs_compat` is not worth turning on for four calls), the body is decoded in
 * the charset its part names rather than assumed UTF-8 (src/charset.ts: a Latin label on UTF-8 bytes is read as UTF-8), character references
 * beyond the five named ones are decoded, and the result is capped.
 *
 * ── PLAIN TEXT ONLY, ALWAYS ──────────────────────────────────────────────
 * A sender's HTML is never kept and never rendered (a stranger's markup is not ours to run): when a
 * message has no text/plain part, its HTML is reduced to text here, and the
 * markup is gone before anything is stored. Attachments are a name, a size and the
 * type the sender declared. No byte of one is stored: an image is fetched from Gmail when
 * someone asks to see it (Mailroom.readAttachment, and ADR 0001).
 *
 * ── MAIL IS UNTRUSTED INPUT ──────────────────────────────────────────────
 * Every string out of here is something a stranger wrote. Nothing here
 * interprets it; the store binds it as data and the UI renders it as text.
 */

/** How much of a body is stored. Past it the conversation links to Gmail. */
export const BODY_CAP = 100_000

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

/**
 * One line of text from outside: control characters (a line break, a tab, a NUL) become
 * spaces, runs of whitespace collapse, and the ends are trimmed. For a subject a stranger
 * wrote that is about to become the default subject of OUR reply, which must be one plain
 * line (the MIME builder refuses anything else, and a reply must not fail for the sender's
 * odd header).
 */
export function tidyLine(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
}

const header = (m: GmailMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** A part's own header, such as the Content-Type that names its charset. */
const partHeader = (p: GmailPart, name: string): string =>
  p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/**
 * Gmail's base64url (and plain base64) as bytes. An indexed loop into an array of the right length, never
 * `Uint8Array.from(binary, fn)`: that builds a list of every byte first, and a picture of a few MB run through it
 * takes the Durable Object's 128 MB heap, and the sync or send it is serving, down with it.
 */
export function base64Bytes(data: string): Uint8Array {
  const standard = data.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const charsetOf = (contentType: string): string => /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? 'utf-8'

const decodePart = (p: GmailPart): string =>
  decodeBody(base64Bytes(p.body?.data ?? ''), charsetOf(partHeader(p, 'Content-Type')))

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const codePoint = (n: number): string => {
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The readable body: text/plain if any part has it, else text/html reduced to text. */
export function bodyOf(part: GmailPart): string {
  const all: GmailPart[] = []
  const walk = (p: GmailPart) => {
    all.push(p)
    p.parts?.forEach(walk)
  }
  walk(part)
  const inline = all.filter((p) => !p.filename && p.body?.data)
  const plain = inline.find((p) => p.mimeType === 'text/plain')
  if (plain) return decodePart(plain).replace(/\r\n?/g, '\n').trim()
  const html = inline.find((p) => p.mimeType === 'text/html')
  return html ? htmlToText(decodePart(html).replace(/\r\n?/g, '\n')) : ''
}

/**
 * The calendar event a message is about (src/calendar-event.ts), read from the parts as they arrived: the iCalendar part when its bytes
 * are in the message, and the text and HTML parts for Google Calendar's links (the stored body has had its markup removed, so the
 * links are read here). Never throws: a part that cannot be decoded is not read.
 */
export function eventOfMessage(m: GmailMessage): ReturnType<typeof eventOf> {
  if (!m.payload) return null
  const all: GmailPart[] = []
  const walk = (p: GmailPart) => {
    all.push(p)
    p.parts?.forEach(walk)
  }
  walk(m.payload)
  const read = (types: string[]): string[] =>
    all
      .filter((p) => p.body?.data && types.includes((p.mimeType ?? '').toLowerCase()))
      .flatMap((p) => {
        try {
          return [decodePart(p)]
        } catch {
          return []
        }
      })
  return eventOf({
    calendars: read(['text/calendar']),
    texts: read(['text/plain', 'text/html']),
    subject: decodeWords(header(m, 'Subject')).trim(),
    sender: header(m, 'Sender'),
    listId: header(m, 'List-Id'),
    answersAnother: header(m, 'In-Reply-To').trim() !== '' || header(m, 'References').trim() !== '',
  })
}

/** The first calendar part of a message, inline or a file (`isCalendarPart`: text/calendar, application/ics or a name ending in .ics), or null. */
export function calendarPartOf(m: GmailMessage): GmailPart | null {
  if (!m.payload) return null
  const all: GmailPart[] = []
  const walk = (p: GmailPart) => {
    all.push(p)
    p.parts?.forEach(walk)
  }
  walk(m.payload)
  return all.find((p) => isCalendarPart(p.mimeType, p.filename)) ?? null
}

/** What a calendar part's bytes say (src/calendar-summary.ts), decoded in the charset the part names. Never throws: bytes that cannot be read are no summary. */
export function summaryOfBytes(part: GmailPart, bytes: Uint8Array): CalendarSummary | null {
  try {
    return summaryOfCalendar(decodeBody(bytes, charsetOf(partHeader(part, 'Content-Type'))))
  } catch {
    return null
  }
}

/**
 * What the message's calendar part says, from the message as Gmail returned it: `null` when it has no calendar part, the part is over the limit or holds no event; the summary when the part's bytes are in the message; and `undefined` when
 * Gmail keeps them apart (an `attachmentId`, as it does for a part with a file name and sometimes without one), which the Mailroom asks Gmail for once (`Mailroom.parse`). Never throws.
 */
export function calendarOfMessage(m: GmailMessage): CalendarSummary | null | undefined {
  const part = calendarPartOf(m)
  if (part === null) return null
  if ((part.body?.size ?? 0) > CALENDAR_SUMMARY_PART_MAX) return null
  if (part.body?.data) {
    try {
      return summaryOfBytes(part, base64Bytes(part.body.data))
    } catch {
      return null
    }
  }
  return part.body?.attachmentId ? undefined : null
}

/**
 * The parts of a message that are attachments (a part with a filename), in the order they are listed. The stored
 * list is this order, so an attachment is named by its place in it: `attachmentParts(...)[n]` is the part that
 * `message.attachments[n]` was made from, which is how an attachment is found again in Gmail when it is asked for.
 */
export function attachmentParts(part: GmailPart): GmailPart[] {
  const out: GmailPart[] = []
  const walk = (p: GmailPart) => {
    if (p.filename) out.push(p)
    p.parts?.forEach(walk)
  }
  walk(part)
  return out
}

/**
 * Attachment names and sizes, so a reader knows they exist, with the type the sender's client declared for each (a
 * hint for what to show: nothing is served on its word, see image.ts). The type is left out when the part names none.
 */
export function attachmentsOf(part: GmailPart): AttachmentInfo[] {
  return attachmentParts(part).map((p) => ({
    name: p.filename ?? '',
    size: p.body?.size ?? 0,
    ...(p.mimeType ? { mimeType: p.mimeType } : {}),
  }))
}

// ─── headers ─────────────────────────────────────────────────────────────

/**
 * RFC 2047 encoded words ("=?UTF-8?B?...?=" and the Q form) decoded, which is how
 * a subject or a name with an accent or an emoji arrives. Whitespace between two
 * adjacent encoded words is dropped, as the RFC says. A word whose charset the
 * runtime does not know is left as written rather than guessed at.
 */
export function decodeWords(value: string): string {
  const joined = value.replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bq]\?[^?\s]*\?=)/gi, '$1')
  return joined.replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (whole, charset: string, enc: string, text: string) => {
    try {
      if (enc.toLowerCase() === 'b') return new TextDecoder(charset).decode(base64Bytes(text))
      const bytes: number[] = []
      const q = text.replace(/_/g, ' ')
      for (let i = 0; i < q.length; i += 1) {
        if (q[i] === '=' && /^[0-9a-f]{2}$/i.test(q.slice(i + 1, i + 3))) {
          bytes.push(Number.parseInt(q.slice(i + 1, i + 3), 16))
          i += 2
        } else {
          bytes.push(q.charCodeAt(i))
        }
      }
      return new TextDecoder(charset).decode(Uint8Array.from(bytes))
    } catch {
      return whole
    }
  })
}

/** Split on commas that are outside a quoted string and outside angle brackets. */
function splitAddresses(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string
    if (quoted) {
      current += ch
      if (ch === '\\') {
        current += value[i + 1] ?? ''
        i += 1
      } else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '<') depth += 1
    else if (ch === '>') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

const unquote = (s: string): string => {
  const t = s.trim()
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t
}

/**
 * The people a To, Cc or From header names, with the names decoded. Lenient on
 * purpose: mail in the wild has bare addresses, a name in a trailing comment, and
 * lists such as "undisclosed-recipients:;" that name nobody. An item with no
 * address in it is dropped, and the address is returned as written (the store
 * normalizes it, and refuses what is not an email address).
 */
export function parseAddressList(value: string): ParsedAddress[] {
  const out: ParsedAddress[] = []
  for (const raw of splitAddresses(value)) {
    // "Group: a@x.example.com" and a trailing ";" are group syntax; keep what is inside.
    const item = raw
      .replace(/^[^<>@"]*:(?=\s*[^\s])/, '')
      .replace(/;\s*$/, '')
      .trim()
    if (item === '') continue
    const bracketed = /^(.*?)<([^<>]*)>\s*$/s.exec(item)
    if (bracketed) {
      const address = (bracketed[2] ?? '').trim()
      if (address !== '') out.push({ name: decodeWords(unquote(bracketed[1] ?? '')), address })
      continue
    }
    const commented = /^([^()\s]+)\s*\((.*)\)\s*$/.exec(item)
    if (commented?.[1]?.includes('@')) {
      out.push({ name: decodeWords(unquote(commented[2] ?? '')), address: commented[1] })
      continue
    }
    if (item.includes('@')) out.push({ name: '', address: item })
  }
  return out
}

// ─── the message ─────────────────────────────────────────────────────────

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** Cut at `cap` characters without splitting a surrogate pair. */
function capped(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  let end = cap
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/**
 * What is stored when a body cannot be decoded. A message whose body is
 * malformed (a base64 part that is not base64) must still be stored: one such
 * message in a page would otherwise fail the whole page, and so the sync, on every
 * retry, forever. The reader is told, and the Gmail link has the real thing.
 */
export const UNREADABLE_BODY = '(The inbox could not read this message. Open it in Gmail.)'

/** The body, or the marker when it cannot be decoded. Never throws. */
function safeBody(m: GmailMessage): string {
  try {
    return m.payload ? bodyOf(m.payload) : ''
  } catch {
    return UNREADABLE_BODY
  }
}

export function parseMessage(m: GmailMessage, cap: number = BODY_CAP): ParsedMessage {
  const from = parseAddressList(header(m, 'From'))
  const body = capped(safeBody(m), cap)
  const internal = /^\d+$/.test(m.internalDate ?? '') ? Number(m.internalDate) : Number.NaN
  const decoded = (name: string) => decodeWords(header(m, name)).trim()

  return {
    gmailId: m.id,
    threadId: m.threadId,
    rfcMessageId: header(m, 'Message-ID').trim() || null,
    inReplyTo: header(m, 'In-Reply-To').trim() || null,
    from: from[0] ?? null,
    to: parseAddressList(header(m, 'To')),
    cc: parseAddressList(header(m, 'Cc')),
    fromHeader: decoded('From'),
    toHeader: decoded('To'),
    ccHeader: decoded('Cc'),
    replyToHeader: decoded('Reply-To'),
    subject: decoded('Subject'),
    snippet: m.snippet ?? '',
    body: body.text,
    bodyTruncated: body.truncated,
    attachments: m.payload ? attachmentsOf(m.payload) : [],
    labels: [...(m.labelIds ?? [])],
    receivedAt: isoOrNull(internal),
    senderDate: isoOrNull(Date.parse(header(m, 'Date'))),
    listUnsubscribe: header(m, 'List-Unsubscribe').trim() !== '',
    event: eventOfMessage(m),
    calendar: calendarOfMessage(m),
  }
}
