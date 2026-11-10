/**
 * Which attachments the inbox will show as pictures, and how it knows a file is one. Pure, and shared by the
 * Worker (which decides what it will serve) and the page (which decides what to ask for).
 *
 * ── FOUR KINDS, AND THE BYTES DECIDE ─────────────────────────────────────
 * PNG, JPEG, GIF and WebP, and nothing else: never SVG (which is a document that can carry script), never a
 * PDF, never a type a sender made up. What the sender's client DECLARED (`mimeType`, the file's name) is only a
 * hint for the page about what is worth asking for. The Worker serves a file only after its first bytes say it is
 * one of the four, and it serves it as the type those bytes name, so a file called picture.png that is really
 * HTML is refused, and a JPEG that the sender's client labelled application/octet-stream is served as the JPEG it is.
 */

import { sniffPicture } from './telegram/wire'

export const PREVIEW_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type PreviewType = (typeof PREVIEW_TYPES)[number]

/**
 * The largest image the inbox fetches and serves, by the size Gmail gives it and again by the bytes it gets. A
 * bigger one stays a chip that says to open it in Gmail: this is a thumbnail for a screenshot or a photo of a
 * form, and the Durable Object holds what it reads in memory while it answers. 5 MB and not more because that
 * Durable Object is the whole inbox, with a 128 MB heap shared with any sync or send it is in the middle of, and one
 * picture is held several times over on the way through (Gmail's base64 text, the parsed answer, the decoded string,
 * the bytes); a phone photo is usually under it.
 */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

/** The kind of image these bytes are by their first bytes, or null when they are none of the four. */
export function sniffImage(bytes: Uint8Array): PreviewType | null {
  // PNG and JPEG are told by ONE function, the one the Telegram send uses too (`sniffPicture`, telegram/wire.ts: zero dependencies, so the bridge and the page can hold it as well); GIF and WebP are only ever previews.
  const picture = sniffPicture(bytes)
  if (picture !== null) return picture
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  // WebP is a RIFF container: "RIFF", four bytes of length, then "WEBP".
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

const EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i

/**
 * Whether the page should ask for a preview of an attachment: it declared one of the four types, or declared nothing
 * useful (no type, or the generic octet-stream some clients use for everything) and its name ends in one of the four
 * extensions; and it is not over the size limit. The Worker applies the same rule before it asks Gmail for anything, so
 * a declared SVG or PDF is never fetched; but a "yes" here only gets as far as the bytes, which decide. A wrong guess costs
 * a request that is refused, and the attachment stays a chip.
 */
export function wantsPreview(attachment: { name: string; size: number; mimeType?: string }): boolean {
  if (attachment.size > MAX_PREVIEW_BYTES) return false
  const declared = (attachment.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if ((PREVIEW_TYPES as readonly string[]).includes(declared)) return true
  if (declared !== '' && declared !== 'application/octet-stream') return false
  return EXTENSIONS.test(attachment.name)
}

/**
 * The largest message (the raw copy, with everything attached, as it arrived) the inbox will open a file out of. Opening one parses the WHOLE message in the
 * Durable Object, which is the whole inbox with a 128 MB heap, and a parse costs several times the message: measured in Bun, a 22 MB message
 * of four phone photos took about 120 MB. At 10 MB the parse is about 55 MB, which one read at a time (Mailroom.readKept) leaves room for beside everything else the
 * object holds; four at once, or 22 MB, would not. A message over it still arrives, is kept whole and is listed; only its files cannot be opened here.
 */
export const MAX_OPEN_MESSAGE_BYTES = 10 * 1024 * 1024

/**
 * Whether the files listed on a message that ARRIVED are too much to open, judged from what the store holds (the files' sizes) so the pages can say so before
 * anyone clicks: the files as the message carries them (base64, a third larger) with a margin for the words and headers. The Mailroom checks the kept copy's own
 * size before it reads a byte, which is the last word.
 */
export function tooLargeToOpen(attachments: readonly { size: number }[]): boolean {
  return attachments.reduce((n, a) => n + a.size, 0) * (4 / 3) + 64 * 1024 > MAX_OPEN_MESSAGE_BYTES
}
