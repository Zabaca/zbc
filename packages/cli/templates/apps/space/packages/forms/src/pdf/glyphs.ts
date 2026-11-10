/**
 * What the document's font can draw, and the plain sentence for what it cannot. Light and free of LibPDF and of the font bytes, so the
 * admin's builder and the filler's screens import it and refuse a character where it is typed, by the same rule the PDF is drawn with
 * (src/pdf/font.ts embeds the font whose character map src/pdf/coverage.ts was generated from).
 *
 * The font covers Latin (with its Extended letters and the Vietnamese ones), Greek and Cyrillic, with common punctuation. It does not
 * cover Chinese, Japanese or Korean, which are out of v1, nor Arabic, Hebrew, Thai, Devanagari or emoji.
 */
import { COVERED } from './coverage'

const covered = (cp: number): boolean => {
  let lo = 0
  let hi = COVERED.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = COVERED[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

/** A character of a line the font can draw (a tab or a line break is whitespace, which the layout turns into a space or a new line). */
export const canDrawChar = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!
  return cp === 9 || cp === 10 || cp === 13 ? true : covered(cp)
}

export const canDraw = (s: string): boolean => [...s].every(canDrawChar)

/** Chinese, Japanese and Korean letters: out of v1, named because a client's customers may type them. */
const CJK = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/

/** What is wrong with a text for the document, as a plain sentence; null when every character can be drawn. */
export function whyNotDrawable(s: string): string | null {
  if (canDraw(s)) return null
  if (CJK.test(s)) return 'Chinese, Japanese and Korean letters cannot be printed on this document yet. Please write it in English letters.'
  const bad = [...s].find((ch) => !canDrawChar(ch))!
  const shown = /[\u0000-\u001f\u007f-\u009f]/.test(bad) ? 'a control character' : `"${bad}"`
  return `This document cannot print ${shown}. It prints Latin, Greek and Cyrillic letters, so please use those.`
}

/** The text with each character the font cannot draw replaced by a question mark, and tabs by spaces: what a layout may safely hand the font. */
export const drawable = (s: string): string => [...s.replace(/\t/g, ' ')].map((ch) => (canDrawChar(ch) ? ch : '?')).join('')
