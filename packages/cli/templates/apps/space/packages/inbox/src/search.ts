/**
 * Search, as pure functions: what a typed query means, and the little text work a result needs. The scan itself is
 * the store's (`searchConversations`, src/store/store.ts) and the route's is `GET /api/search` (src/app.ts); this
 * file holds only the rules that decide them, so each is a table test.
 *
 * WHAT IS SEARCHED: the conversations the inbox holds, open or closed (the last FILL_DAYS days of mail and
 * everything since), by the name and address of the people on them, by each message's subject, and by each message's
 * text. Never Gmail: older mail is Gmail's to search. A query is words, and a conversation matches when EVERY word
 * is found somewhere on it (a person's name or address, or any message's subject or text), in any order and not
 * necessarily the same message, case ignored. Nothing is stemmed, ranked or fuzzy: it is a scan with `LIKE`.
 */

/** The longest query read; anything past it is cut, so a pasted page cannot become a pattern. */
export const MAX_QUERY_CHARS = 100

/** The most words a query uses; later ones are ignored. */
export const MAX_TERMS = 6

/**
 * The words of a query: lower case, split on whitespace, each once, at most MAX_TERMS of them, from the first
 * MAX_QUERY_CHARS characters. Nothing typed is a command or a pattern, so there is nothing to refuse: a query
 * with no words (blank, or not a string) has no terms and finds nothing.
 */
export function searchTerms(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const words = raw.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/u).filter(Boolean)
  return [...new Set(words)].slice(0, MAX_TERMS)
}

/**
 * The `LIKE` pattern that finds `term` anywhere, with `\` as the escape (the store says `ESCAPE '\'`): a `%`, a `_`
 * or a `\` in what was typed is itself, never a wildcard.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** How long a result's excerpt is, in characters, ellipses not counted. */
export const EXCERPT_CHARS = 160

/** How much of the text before the first match an excerpt keeps, so the match is not at the very edge. */
const EXCERPT_LEAD = 30

/**
 * A line of `text` around the first place any of `terms` is found: whitespace collapsed, at most EXCERPT_CHARS long,
 * with an ellipsis where it was cut. Null when none of the terms is in it. Case is ignored.
 */
export function excerptAround(text: string, terms: string[]): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const at = terms.map((t) => lower.indexOf(t)).filter((n) => n >= 0)
  if (at.length === 0) return null
  const first = Math.min(...at)
  const start = Math.max(0, first - EXCERPT_LEAD)
  const end = Math.min(flat.length, start + EXCERPT_CHARS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** A piece of text and whether it is a match: what a result row draws, a match marked. */
export interface Piece {
  text: string
  hit: boolean
}

/**
 * `text` cut into pieces, the places any of `terms` occurs marked as hits, case ignored, text kept exactly as it
 * was written. Overlapping and adjacent matches become one hit. No terms, or none found, is one plain piece.
 */
export function highlight(text: string, terms: string[]): Piece[] {
  const lower = text.toLowerCase()
  const spans: [number, number][] = []
  for (const term of terms) {
    for (let at = lower.indexOf(term); term !== '' && at !== -1; at = lower.indexOf(term, at + 1)) {
      spans.push([at, at + term.length])
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }
  const pieces: Piece[] = []
  let cursor = 0
  for (const [from, to] of merged) {
    if (from > cursor) pieces.push({ text: text.slice(cursor, from), hit: false })
    pieces.push({ text: text.slice(from, to), hit: true })
    cursor = to
  }
  if (cursor < text.length || pieces.length === 0) pieces.push({ text: text.slice(cursor), hit: false })
  return pieces
}
