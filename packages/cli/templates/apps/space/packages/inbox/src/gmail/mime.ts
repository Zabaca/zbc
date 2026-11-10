/**
 * A plain-text email as the bytes Gmail's send call takes: pure functions over
 * plain data, so what leaves the inbox is a table test with no network.
 *
 * ── A WORKER'S MIME, NOT A NODE SCRIPT'S ─────────────────────────────────
 * This is a Worker-sized take on the usual command-line draft script's `mime` (its
 * test cases are in test/gmail-mime.test.ts). It has no attachment fallback: this
 * build sends none. What differs from the Node version:
 * no Node `Buffer` (the Worker has none), plain text only (no multipart), a
 * long non-ASCII subject is split into encoded words that each fit a header
 * line, the body's line endings are made CRLF before it is encoded, the Cc list is
 * folded, and the Message-ID is the caller's (the store records it on the draft
 * before the send).
 *
 * ── THE HEADER GUARD ─────────────────────────────────────────────────────
 * Every header value is one line: a CR or LF in a subject or an address is how a
 * stranger's text would add a Bcc, so any is refused here whatever the caller
 * checked. Addresses are BARE and printable ASCII: no display name to quote, no
 * list syntax to smuggle a second recipient inside, no UTF-8 local part that
 * needs a server extension nobody agreed to. There is no Bcc parameter, so no
 * input can produce one.
 *
 * ── THREADING ────────────────────────────────────────────────────────────
 * A reply carries the Message-ID of the email it answers in In-Reply-To and in
 * References, which is what the other side's mail client threads on. (Gmail
 * threads our own copy by the thread id the send call is given.) Only that one id
 * is carried, as the option says: the inbox does not store the thread's earlier
 * References, so a long chain is not reproduced.
 */

/** Thrown for anything that must not be sent. The message is safe to show. */
export class MimeError extends Error {}

/** Printable ASCII and nothing else: no space, no control character, nothing that needs a header extension. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
/** One `@` pair with a dot after it, and none of the characters that make an address more than one thing: brackets, quotes, commas, colons, semicolons, spaces. */
const ADDRESS_SHAPE = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/
export const MESSAGE_ID = /^<[^\s<>]+@[^\s<>]+>$/

/** A bare address: printable ASCII in the shape above, with no name around it and nothing after it. */
export function isBareAddress(value: string): boolean {
  return PRINTABLE_ASCII.test(value) && ADDRESS_SHAPE.test(value)
}

/** Bytes of text one encoded word carries: 42 is 56 base64 characters, 68 with the 12 around them, which fits a line after "Subject: ". */
const ENCODED_WORD_BYTES = 42
/** A plain subject longer than this is sent as encoded words instead, which can be folded: a header line is 78 at most, less "Subject: " and a margin. */
const SUBJECT_PLAIN_MAX = 67
/** Characters of a base64 line in a MIME body. */
const BASE64_LINE = 76
/** Bytes turned into a string at a time, so a long body does not overflow the argument limit of String.fromCharCode. */
const BASE64_CHUNK = 0x8000

/** A header value: one line, no control characters, so nothing can add a header. */
function oneLine(name: string, value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse control characters
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new MimeError(`${name} must be one plain line.`)
  return value
}

function address(name: string, value: string): string {
  if (!isBareAddress(value))
    throw new MimeError(`${name} is not an email address: ${JSON.stringify(value).slice(0, 80)}`)
  return value
}

const utf8 = new TextEncoder()

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Base64 in lines of BASE64_LINE, each ending CRLF, as MIME wants it. */
const wrap = (b64: string): string => b64.replace(new RegExp(`.{1,${BASE64_LINE}}`, 'g'), '$&\r\n')

/**
 * RFC 2047 for a header value that is not plain: base64 words of at most 75
 * characters, split between characters (never inside a multi-byte one), joined by
 * a folding space so each stays within a header line. Plain means printable ASCII,
 * short enough for one line, and with no `=?` in it, which a reader would take for an
 * encoded word of its own and decode (a subject a stranger shaped could otherwise read as
 * something other than what was written).
 */
export function encodeWords(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && text.length <= SUBJECT_PLAIN_MAX && !text.includes('=?')) return text
  const words: string[] = []
  let chunk: number[] = []
  const flush = () => {
    if (chunk.length > 0) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`)
    chunk = []
  }
  for (const character of text) {
    const bytes = utf8.encode(character)
    if (chunk.length + bytes.length > ENCODED_WORD_BYTES) flush()
    chunk.push(...bytes)
  }
  flush()
  return words.join('\r\n ')
}

/** A display name as a header phrase: plain when it is simple, encoded when it is not. */
const phrase = (name: string): string => (/^[A-Za-z0-9 ._'-]+$/.test(name) ? name : encodeWords(name))

export interface MimeInput {
  from: { name: string; address: string }
  /** One bare address. */
  to: string
  /** Bare addresses; may be empty. */
  cc: string[]
  subject: string
  body: string
  /** The new message's own Message-ID, `<...@...>`. */
  messageId: string
  /** The Message-ID of the message this answers, or null for a new email. */
  inReplyTo: string | null
  /** When it is sent: the same moment the inbox files it under, so the header and the stored copy agree. */
  date: Date
}

/** RFC 5322's date-time, in UTC, with the numeric zone modern readers expect rather than "GMT". */
const rfcDate = (date: Date): string => date.toUTCString().replace(/GMT$/, '+0000')

/** The message as RFC 5322 text with CRLF line endings. Throws MimeError for anything unsafe to send. */
export function buildMime(m: MimeInput): string {
  const to = address('To', m.to)
  const cc = m.cc.map((a) => address('Cc', a))
  if (!MESSAGE_ID.test(m.messageId)) throw new MimeError('The message has no valid Message-ID.')
  if (m.inReplyTo !== null && !MESSAGE_ID.test(m.inReplyTo))
    throw new MimeError('The message it answers has no valid Message-ID.')
  oneLine('Subject', m.subject)
  oneLine('From', m.from.name)

  const head = [
    `From: ${m.from.name ? `${phrase(m.from.name)} ` : ''}<${address('From', m.from.address)}>`,
    `To: ${to}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(',\r\n ')}`] : []),
    `Subject: ${encodeWords(m.subject)}`,
    `Date: ${rfcDate(m.date)}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  const body = m.body.replace(/\r\n?|\n/g, '\r\n')
  return `${head.join('\r\n')}\r\n\r\n${wrap(base64(utf8.encode(body)))}`
}

/** What Gmail's send call takes: the message, base64url without padding. */
export function toRaw(mime: string): string {
  return base64(utf8.encode(mime)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
