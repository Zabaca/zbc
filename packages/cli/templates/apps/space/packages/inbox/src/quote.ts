/**
 * Splits a message body into what its sender wrote now and the earlier email they quoted under it, so the
 * conversation can fold the quote away the way Gmail does. Pure and on text only: nothing here is HTML, and the
 * two halves are put back on screen as text.
 *
 * ── TWO STEPS: A CANDIDATE, THEN PROOF ───────────────────────────────────
 * Looking like a quote is not enough, because folding hides words the reader needs: an Outlook forward has the same
 * "From:/Sent:" block as an Outlook reply, a sender can write "On 10/19 you wrote:" in their own prose, and a
 * mail client can drop the ">" marks. So a candidate is folded only when the quoted text CONTAINS an earlier
 * message of this conversation, which is the one thing a real quote always does and none of those do. A
 * candidate that cannot be proved, or has nothing earlier to be proved against, leaves the message whole.
 *
 * ── STEP ONE: WHAT CAN START A QUOTE ─────────────────────────────────────
 * The first line, scanning down, that is one of:
 *   - an attribution: "On Tue, Mar 3, 2026 at 11:20 AM Tessa Marlow <tessa@northfield.example> wrote:" (Gmail; Apple Mail
 *     writes "On Mar 3, 2026, at 11:20 AM, ..."), which long names make wrap onto a second or third line;
 *   - Outlook's "-----Original Message-----";
 *   - Outlook's separator of underscores, when a "From:" line follows it;
 *   - Outlook's header block with no separator: "From:" then "Sent:" and a "To:" or "Subject:" close below.
 * Everything from that line to the end is the candidate.
 *
 * ── STEP TWO: WHAT IS NEVER HIDDEN ───────────────────────────────────────
 * - A candidate that does not contain an earlier message (see above): a forward, prose, a signature.
 * - Anything under a subject that begins "Fw:" or "Fwd:".
 * - A forward line ("---------- Forwarded message ---------", "Begin forwarded message:"): nothing after it is
 *   searched for a candidate.
 * - The whole message. A message whose candidate starts at its first line has nothing left to show, so it all
 *   stays visible.
 * - Inline replies, in one case. Under an attribution whose quote is marked with ">", a line with no ">" after the first
 *   marked one is the sender answering between the quoted lines, and it is left whole.
 *   KNOWN GAP: an inline reply in an UNMARKED quote (Outlook's header block, or an attribution with no ">") is folded whole,
 *   answers and all, whenever it keeps the first PROOF_LENGTH letters of the earlier message, because that opening is all the
 *   proof asks for. Proving the WHOLE earlier message would refuse it, but was tried on a real mailbox and
 *   unfolded 3 of 31 ordinary replies (a signature's tel or maps link that Gmail's quote adds, "Color" for "Colour") while
 *   finding no inline reply to protect, so it was not kept. Changing this is a choice: test/quote.test.ts pins it.
 * - A ">" in the new text: a bare run of ">" lines with no attribution is not a candidate.
 */
export interface QuoteSplit {
  /** What the sender wrote, without the blank lines and spaces after it. The whole body when nothing is folded. */
  visible: string
  /** The quoted email from its first line to the end, or '' when nothing is folded. */
  quoted: string
}

const ATTRIBUTION_START = /^\s*On\s/i
const ATTRIBUTION_END = /\bwrote:\s*$/i
/** The most lines an attribution wraps onto: Gmail wraps a long name and address before "wrote:". */
const ATTRIBUTION_LINES = 3
const ATTRIBUTION_LONGEST = 400

const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(original message|reply message)\s*-{2,}\s*$/i
const FORWARDED = /^\s*(-{2,}\s*(forwarded message|begin forwarded message)\s*-{2,}|begin forwarded message:)\s*$/i
const UNDERSCORES = /^\s*_{10,}\s*$/
const FROM_LINE = /^\s*(\*\*)?from:/i
const SENT_LINE = /^\s*(\*\*)?sent:/i
const TO_OR_SUBJECT_LINE = /^\s*(\*\*)?(to|subject):/i

const quoteMarked = (line: string): boolean => line.trimStart().startsWith('>')
const blank = (line: string): boolean => line.trim() === ''

/** How many lines the attribution starting at `i` takes, or 0 when none does. */
function attributionAt(lines: string[], i: number): number {
  if (!ATTRIBUTION_START.test(lines[i] ?? '')) return 0
  for (let k = 1; k <= ATTRIBUTION_LINES; k++) {
    const part = lines.slice(i, i + k)
    if (part.length < k || part.some(blank)) return 0
    const joined = part.map((l) => l.trim()).join(' ')
    if (joined.length > ATTRIBUTION_LONGEST) return 0
    // A date or a time always has a digit; "On Monday I wrote:" in the new text has none.
    if (ATTRIBUTION_END.test(joined) && /\d/.test(joined)) return k
  }
  return 0
}

/** Outlook's header block: "From:" with "Sent:" under it, and a "To:" or "Subject:" below that. */
function outlookHeaderAt(lines: string[], i: number): boolean {
  if (!FROM_LINE.test(lines[i] ?? '')) return false
  const near = lines.slice(i + 1, i + 7)
  const sentAt = near.findIndex((l) => SENT_LINE.test(l))
  return sentAt >= 0 && sentAt < 4 && near.slice(sentAt + 1).some((l) => TO_OR_SUBJECT_LINE.test(l))
}

/** Where, in the lines, the quote starts, whether it is marked with ">" and how many lines open it; null for none. */
function findQuote(lines: string[]): { at: number; attribution: boolean; length: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (FORWARDED.test(line)) return null
    const wrapped = attributionAt(lines, i)
    if (wrapped > 0) return { at: i, attribution: true, length: wrapped }
    if (ORIGINAL_MESSAGE.test(line)) return { at: i, attribution: false, length: 1 }
    if (UNDERSCORES.test(line)) {
      const next = lines.slice(i + 1).find((l) => !blank(l))
      if (next !== undefined && FROM_LINE.test(next)) return { at: i, attribution: false, length: 1 }
    }
    if (outlookHeaderAt(lines, i)) return { at: i, attribution: false, length: 1 }
  }
  return null
}

/** True when the lines under an attribution mix quoted lines with unquoted ones: an inline reply. */
function answersInline(under: string[]): boolean {
  const content = under.filter((l) => !blank(l))
  const first = content.findIndex(quoteMarked)
  if (first < 0) return false
  return content.slice(first).some((l) => !quoteMarked(l))
}

/** The words of a text and nothing else, so wrapping, ">" marks, spacing, punctuation and curly quotes cannot differ. */
const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** How much of an earlier message has to be found in the quote: its opening, which is where a client reflows least. */
const PROOF_LENGTH = 200
/** An earlier message shorter than this (in letters and digits) proves nothing: "Thanks!" is in everything. */
const PROOF_LEAST = 12

/** What an earlier message can be recognised by in a quote: its opening, and the opening of what it said itself. */
function openings(earlier: string): string[] {
  const own = candidate(earlier)?.visible ?? earlier
  return [earlier, own].map((text) => letters(text).slice(0, PROOF_LENGTH)).filter((o) => o.length >= PROOF_LEAST)
}

/** True when the quoted text holds the opening of an earlier message of this conversation. */
function quotesEarlier(quoted: string, earlier: readonly string[]): boolean {
  const inQuote = letters(quoted)
  return earlier.some((e) => openings(e).some((o) => inQuote.includes(o)))
}

/** Step one: where a quote could start, as a split of the body; null when nothing in it looks like one. */
function candidate(body: string): QuoteSplit | null {
  const lines = body.split('\n')
  const found = findQuote(lines)
  if (found === null) return null
  if (found.attribution && answersInline(lines.slice(found.at + found.length))) return null
  const start = lines.slice(0, found.at).reduce((offset, l) => offset + l.length + 1, 0)
  const visible = body.slice(0, start).trimEnd()
  // Nothing new above the quote: folding it would hide the whole message.
  if (visible === '') return null
  return { visible, quoted: body.slice(start) }
}

const FORWARD_SUBJECT = /^\s*(fwd?|fw):/i

/**
 * `earlier` is the text of the messages before this one in the same conversation, and `subject` this message's
 * own. With nothing earlier, nothing is folded.
 */
export function splitQuoted(body: string, context: { earlier: readonly string[]; subject: string }): QuoteSplit {
  const whole: QuoteSplit = { visible: body, quoted: '' }
  if (FORWARD_SUBJECT.test(context.subject)) return whole
  const split = candidate(body)
  if (split === null || !quotesEarlier(split.quoted, context.earlier)) return whole
  return split
}
