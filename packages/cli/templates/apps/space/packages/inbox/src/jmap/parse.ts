import { repairMojibake } from '../charset'
import { formatAddress, parseRaw, SNIPPET_CHARS } from '../cloudflare/parse'
import { BODY_CAP, tidyLine } from '../gmail/parse'
import type { ParsedAddress, ParsedMessage } from '../gmail/types'
import type { JmapEmail } from './types'

/**
 * A message from the mail server becoming the row the store keeps: the raw bytes go through the inbox's existing raw-mail parser (the Cloudflare arrivals': postal-mime, the charset repair, the calendar
 * event keys, the attachment names), so a message looks the same in the inbox whichever way it arrived, and the result is handed to the store in the shape the Gmail sync hands it (`ParsedMessage`; its
 * `gmailId` and `threadId` carry the SERVER's ids here, and the store files them under the JMAP columns, src/store/mail.ts `idColumns`).
 *
 * ── PLAIN TEXT ONLY, ALWAYS ──────────────────────────────────────────────
 * As everywhere: the sender's HTML is reduced to text and the markup is gone before anything is stored; attachments are a name, a size and the declared type, and no byte of one is kept. Mail is untrusted input.
 *
 * ── WHEN THE BYTES ARE NOT READ ──────────────────────────────────────────
 * A message larger than `MAX_RAW_BYTES` is never downloaded into the Durable Object (a parse costs several times the message in a 128 MB heap shared with everything else the object does), and a message
 * the parser cannot read must not stall the sync for ever. Both are stored from what the server itself says of the message (`structure`: the people, the subject, a preview), with a plain line that says so.
 */

/** The largest message the inbox downloads to read (src/image.ts MAX_OPEN_MESSAGE_BYTES, which it is the same limit as). */
export const MAX_RAW_BYTES = 10 * 1024 * 1024

export const TOO_LARGE_BODY = '(This message is too large for the inbox to open. Read it in a mail app.)'
export const UNREADABLE_BODY = '(The inbox could not read this message. Read it in a mail app.)'

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

const formatAddressList = (list: ParsedAddress[]): string => list.map(formatAddress).join(', ')

const person = (p: { name: string | null; email: string }): ParsedAddress => ({ name: p.name ?? '', address: p.email })

/** A message from what the server says of it alone. */
function fromStructure(email: JmapEmail, labels: string[], body: string): ParsedMessage {
  const s = email.structure
  const from = (s?.from ?? []).map(person)
  const to = (s?.to ?? []).map(person)
  const cc = (s?.cc ?? []).map(person)
  const bracket = (ids: string[] | null): string | null => (ids?.[0] ? `<${ids[0]}>` : null)
  return {
    gmailId: email.id,
    threadId: email.threadId,
    rfcMessageId: bracket(s?.messageId ?? null),
    inReplyTo: bracket(s?.inReplyTo ?? null),
    from: from[0] ?? null,
    to,
    cc,
    fromHeader: formatAddressList(from),
    toHeader: formatAddressList(to),
    ccHeader: formatAddressList(cc),
    replyToHeader: formatAddressList((s?.replyTo ?? []).map(person)),
    subject: tidyLine(s?.subject ?? ''),
    snippet: tidyLine(s?.preview ?? '').slice(0, SNIPPET_CHARS),
    body,
    bodyTruncated: false,
    attachments: [],
    labels,
    receivedAt: isoOrNull(Date.parse(email.receivedAt)),
    senderDate: s?.sentAt ? isoOrNull(Date.parse(s.sentAt)) : null,
    listUnsubscribe: false,
  }
}

/** The message as the store takes it. `raw` is null when the bytes were not read (too large); never throws. */
export async function parseJmapMessage(
  email: JmapEmail,
  raw: Uint8Array | null,
  labels: string[],
): Promise<ParsedMessage> {
  if (raw === null) return fromStructure(email, labels, TOO_LARGE_BODY)
  try {
    const parsed = await parseRaw(raw)
    const body = parsed.body.length > BODY_CAP ? parsed.body.slice(0, BODY_CAP) : parsed.body
    return {
      gmailId: email.id,
      threadId: email.threadId,
      rfcMessageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      fromHeader: parsed.fromHeader,
      toHeader: parsed.toHeader,
      ccHeader: parsed.ccHeader,
      replyToHeader: parsed.replyToHeader,
      subject: parsed.subject,
      snippet: repairMojibake(body).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      body,
      bodyTruncated: parsed.bodyTruncated || parsed.body.length > BODY_CAP,
      attachments: parsed.attachments,
      labels,
      receivedAt: isoOrNull(Date.parse(email.receivedAt)),
      senderDate: parsed.senderDate,
      listUnsubscribe: parsed.listUnsubscribe,
      event: parsed.event ?? null,
      calendar: parsed.calendar ?? null,
    }
  } catch (error) {
    console.warn(
      `jmap: could not read ${email.id}, stored from what the server says of it: ${error instanceof Error ? error.message : String(error)}`,
    )
    return fromStructure(email, labels, UNREADABLE_BODY)
  }
}
