// What the inbox and the space both say about a file's name: written once, here, because each puts a stranger's file name into a header and each must clean it the same way.
// (The inbox's own pages and the space's both serve a file from a message; one wrote the rule first and the other copied it, and a copy is how the two drift.)

/**
 * A file name safe to put in a header and to save a file under: what a stranger wrote with the characters that mean something taken out. Control characters and the
 * characters that reorder text go; path separators, quotes and the characters a header or a shell reads specially become underscores; leading dots go (no hidden
 * file, no `..`); at most 120 characters. Letters of any language stay. Never empty.
 */
export function plainFilename(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|;,`$&%#!{}[\]]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s_]+/, '')
    .slice(0, 120)
    .trim()
  return cleaned === '' ? 'attachment' : cleaned
}

/** `Content-Disposition` for a file: an ASCII fallback name and the real one in RFC 5987's form, so nothing a sender wrote can leave the quotes. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const full = plainFilename(name)
  const ascii = full.replace(/[^A-Za-z0-9._ -]+/g, '_')
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ── A part of a file ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A Telegram video is up to 50 MB and a Durable Object's RPC carries 32 MiB at most, so a file is handed from the inbox to the space in parts, and a request's `Range` is understood in ONE place, here: the space
// parses the header, the inbox resolves it against the length it holds (`-n` needs the length) and reads only that part out of the bucket.

/** A byte range as a request names it, before any length is known: `a-b`, `a-` or `-n`. */
export type FileRange = { first: number; last?: number } | { suffix: number }

/**
 * The single byte range of a `Range` header, or null for anything else (a multi-range request, another unit, a range that is not numbers, no header): the caller then answers with the whole file, as if
 * no range had been asked. Only `bytes=a-b`, `bytes=a-` and `bytes=-n` are understood.
 */
export function parseByteRange(header: string | null | undefined): FileRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if ((m[1] !== '' && !Number.isSafeInteger(a)) || (m[2] !== '' && !Number.isSafeInteger(b))) return null
  if (m[1] === '') return { suffix: b }
  return m[2] === '' ? { first: a } : { first: a, last: b }
}

/** Whether a value is a range in the shape `parseByteRange` makes: what the inbox checks of the one the space hands it. */
export function isFileRange(v: unknown): v is FileRange {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if ('suffix' in r) return count(r.suffix) && Object.keys(r).length === 1
  return count(r.first) && (r.last === undefined || count(r.last)) && Object.keys(r).length === (r.last === undefined ? 1 : 2)
}

/** The bytes [first, last] (inclusive) of a file of this length that the range asks for, or `unsatisfiable` when none of the file is in it. A range that runs past the end is cut to the end. */
export function resolveByteRange(range: FileRange, length: number): { first: number; last: number } | 'unsatisfiable' {
  if ('suffix' in range) return range.suffix === 0 || length === 0 ? 'unsatisfiable' : { first: Math.max(0, length - range.suffix), last: length - 1 }
  const last = range.last === undefined ? length - 1 : Math.min(range.last, length - 1)
  return range.first >= length || last < range.first ? 'unsatisfiable' : { first: range.first, last }
}
