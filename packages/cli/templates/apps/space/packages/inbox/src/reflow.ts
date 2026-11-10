/**
 * Puts back the paragraphs a mail client broke into short lines, so a message reads the way Gmail shows it. Pure
 * and on text only, and DISPLAY ONLY: it runs on the way to the screen (Conversation.tsx) and never on what is
 * stored, so the body Claude's script reads, the composer's reply and the quote folding (quote.ts) all see the
 * sender's text exactly as it arrived.
 *
 * ── WHERE THE BREAKS COME FROM ───────────────────────────────────────────
 * The inbox shows a message's text/plain part, and prefers it to the HTML (parse.ts, `bodyOf`). Many senders' text/plain
 * is a hard-wrapped copy of what they wrote: a client that writes both parts (Gmail's own alternative part, Outlook,
 * Thunderbird and most newsletter tools) wraps the plain one at 72 to 78 characters, while its HTML flows freely, which
 * is what Gmail shows. So "And when a\nphoto is swapped for a new one" is the sender's client wrapping, not a line
 * the sender typed. A second source is RFC 3676 `format=flowed`, where a line that ends in a space is a soft break; the
 * stored body keeps those trailing spaces, but not the header that says the part is flowed, so the space is read
 * as the signal on its own (below). Apple Mail does not wrap, and its text passes through untouched.
 *
 * ── HOW A WRAP IS TOLD FROM A LINE THE SENDER TYPED ──────────────────────
 * Two lines are joined only on evidence, because a join that is wrong runs two lines of an address or a list together:
 *   1. The wrap width W is found from the text itself, paragraph by paragraph: the longest line (between MIN_WRAP and
 *      MAX_WRAP characters) that has another line of the same kind of text right under it. Typed paragraphs have no
 *      such line, so text with none is left alone.
 *   2. The line that set W is not evidence on its own: a sender types one long line and then "Let me know", a short
 *      address or a name, and that line is the longest by itself. So a paragraph is joined only when at least two of
 *      its lines are near W (two lines of about the same length close to a wrap width are the wrap), or, for a list
 *      item, when the line under it is indented to where the item's text starts, which is how a client wraps an item.
 *   3. A line is joined to the next only when the next line's first word would NOT have fitted on it at width W (had
 *      it fitted, the client would have put it there, so the break is the sender's own), and the line is itself near
 *      that width (not a short line that happens to precede a long word).
 *   4. Or the line ends in a single space after at least FLOWED_LEAST characters: format=flowed's soft break.
 * Whichever the evidence, a line is never joined to a one- or two-word line under it (a sign-off, "Thanks", a name)
 * unless that line starts in lower case and the line above does not end a sentence: the tail of a wrapped sentence
 * ("somewhere else?") goes on, a line the sender typed by itself stays one.
 *
 * ── WHAT IS NEVER JOINED ─────────────────────────────────────────────────
 * A blank line (the paragraph boundary), a quoted line (">"), a list item or a line under one that starts one, a line
 * that is indented (code, a preformatted block), a line that looks like a table or code (tabs, pipes, columns of
 * spaces, a rule of dashes), a line that is only a URL, and everything from a signature delimiter ("-- ") to the end.
 * A line much shorter than the paragraph's width is never the first of a join, whatever follows it.
 */

/** The shortest wrap width believed. Below it, a pair of short lines (an address) is never read as a wrapped paragraph. */
export const MIN_WRAP = 60
/** The longest a line can be and still count as evidence of the wrap width: past it, it is a long line the sender typed. */
export const MAX_WRAP = 100
/** How long a line ending in a space has to be to be format=flowed's soft break and not a stray trailing space. */
export const FLOWED_LEAST = 40
/** A line counts as full when it is within this many characters of the wrap width. */
const FULL_WITHIN = 10
/** A line must be at least this fraction of the wrap width to be the first of a join. */
const NEAR_WIDTH = 0.6

type Kind = 'blank' | 'quote' | 'rule' | 'url' | 'list' | 'indented' | 'table' | 'prose'

const QUOTED = /^\s*>/
const RULE = /^\s*[-=_*#~+.]{3,}\s*$/
const URL_ONLY = /^\s*<?(https?:\/\/|www\.)\S+>?[.,;]?\s*$/i
const LIST_MARKER = /^\s*(?:[-*•◦▪+]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/
const LIST_ITEM = new RegExp(`${LIST_MARKER.source}\\S`)
const INDENTED = /^(?:\t| {2,})\S/
const COLUMNS = /\S {3,}\S/
const CODE_ENDING = /[{};]\s*$/
const CODE_START = /^\s*(?:\$ |#|\/\/)/
const SENTENCE_END = /[.!?:]["')\]”’]*\s*$/
/** "-- " and "--": the signature delimiter. */
const SIGNATURE = /^-- ?$/

function kindOf(line: string): Kind {
  if (line.trim() === '') return 'blank'
  if (QUOTED.test(line)) return 'quote'
  if (RULE.test(line)) return 'rule'
  if (URL_ONLY.test(line)) return 'url'
  if (LIST_ITEM.test(line)) return 'list'
  if (INDENTED.test(line)) return 'indented'
  if (line.includes('\t') || (line.match(/\|/g)?.length ?? 0) >= 2 || COLUMNS.test(line)) return 'table'
  if (CODE_ENDING.test(line) || CODE_START.test(line)) return 'table'
  return 'prose'
}

/** What a line can be part of a wrapped paragraph as: prose, a list item, or an indented line that continues one. */
type Wrappable = 'prose' | 'list' | 'continuation'

/** Each line's kind, with an indented line under a list item (or under its continuation) read as that item's continuation. */
function classify(lines: readonly string[]): (Wrappable | Exclude<Kind, 'prose' | 'list'>)[] {
  const out: (Wrappable | Exclude<Kind, 'prose' | 'list'>)[] = []
  lines.forEach((line, i) => {
    const kind = kindOf(line)
    const before = out[i - 1]
    if (kind === 'indented' && (before === 'list' || before === 'continuation')) out.push('continuation')
    else out.push(kind)
  })
  return out
}

const isWrappable = (k: string | undefined): k is Wrappable => k === 'prose' || k === 'list' || k === 'continuation'
const firstWord = (line: string): string => line.trim().split(/\s+/)[0] ?? ''
const wordCount = (line: string): number => line.trim().split(/\s+/).length

/** Whether line B may be the second half of a join: plain text, or the continuation of a list item. */
const joinsOnto = (kindA: string | undefined, kindB: string | undefined): boolean =>
  isWrappable(kindA) && (kindB === 'prose' || (kindB === 'continuation' && kindA !== 'prose'))

/** A paragraph's wrap width and how many of its lines are near it. */
interface Wrap {
  width: number
  full: number
}

/**
 * The wrap width of the paragraph each line is in: a paragraph is a run of lines each of which could continue onto the
 * next, and its width is its longest line between MIN_WRAP and MAX_WRAP. Per paragraph and not per message, because one
 * long line the sender typed elsewhere (a list item) must not stop a wrapped paragraph from being joined. A line whose
 * paragraph shows no width has null.
 */
function wrapWidths(lines: readonly string[], kinds: readonly string[]): (Wrap | null)[] {
  const widths: (Wrap | null)[] = lines.map(() => null)
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    const continues = joinsOnto(kinds[i], kinds[i + 1])
    if (continues) continue
    // The paragraph is lines[start..i]; every line in it but the last continues onto the next.
    const lengths: number[] = []
    for (let k = start; k < i; k++) {
      const length = (lines[k] as string).trimEnd().length
      if (length >= MIN_WRAP && length <= MAX_WRAP) lengths.push(length)
    }
    if (lengths.length > 0) {
      const width = Math.max(...lengths)
      const wrap = { width, full: lengths.filter((n) => n >= width - FULL_WITHIN).length }
      for (let k = start; k <= i; k++) widths[k] = wrap
    }
    start = i + 1
  }
  return widths
}

/** Where a line's text starts: after a list item's marker, else after its indent. */
const textColumn = (line: string): number => (LIST_MARKER.exec(line)?.[0] ?? /^\s*/.exec(line)?.[0] ?? '').length
const indentOf = (line: string): number => (/^ */.exec(line)?.[0] ?? '').length

/** A one- or two-word line that is not the lower-case tail of a sentence: a sign-off, "Thanks", a name. */
const standsAlone = (above: string, line: string): boolean =>
  wordCount(line) <= 2 && (SENTENCE_END.test(above) || !/^\s*\p{Ll}/u.test(line))

/** Whether line `i` is a hard wrap of the paragraph that goes on in line `i + 1`. */
function wrapsOnto(lines: readonly string[], kinds: readonly string[], i: number, wrap: Wrap | null) {
  if (!joinsOnto(kinds[i], kinds[i + 1])) return false
  const a = lines[i] as string
  const b = lines[i + 1] as string
  const length = a.trimEnd().length
  const sentenceEnd = SENTENCE_END.test(a)
  if (standsAlone(a, b)) return false
  // format=flowed: a soft break is a line that ends in a space, if it is long enough to have been wrapped.
  if (/\S $/.test(a) && length >= FLOWED_LEAST) return true
  if (wrap === null) return false
  if (length < wrap.width * NEAR_WIDTH) return false
  if (length + 1 + firstWord(b).length <= wrap.width) return false
  // Evidence beyond the line that set the width: a second near-full line, or a list item's hanging indent.
  if (wrap.full >= 2) return true
  return !sentenceEnd && kinds[i + 1] === 'continuation' && indentOf(b) === textColumn(a)
}

/**
 * The text with its hard-wrapped paragraphs joined back into lines the page can wrap itself, and everything else
 * (blank lines, lists, quotes, code, tables, URLs, signatures, short lines) exactly as it was.
 */
export function reflow(text: string): string {
  const all = text.split(/\r?\n/)
  const cut = all.findIndex((l) => SIGNATURE.test(l))
  const lines = cut < 0 ? all : all.slice(0, cut)
  const kinds = classify(lines)
  const widths = wrapWidths(lines, kinds)

  const out: string[] = []
  lines.forEach((line, i) => {
    if (i > 0 && wrapsOnto(lines, kinds, i - 1, widths[i - 1] ?? null)) {
      out[out.length - 1] = `${(out[out.length - 1] as string).trimEnd()} ${line.trimStart()}`
    } else {
      out.push(line)
    }
  })
  return (cut < 0 ? out : [...out, ...all.slice(cut)]).join('\n')
}
