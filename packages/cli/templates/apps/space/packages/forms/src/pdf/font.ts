/**
 * The document's font: Noto Sans (SIL Open Font License 1.1, src/pdf/fonts/OFL.txt), regular and bold, covering Latin and its extended
 * and Vietnamese letters, Greek and Cyrillic. Part of the engine: the only code that hands the font bytes to LibPDF, which embeds just the
 * glyphs a document uses (a subset), so a finished PDF carries a few KB of it, not the font.
 *
 * `fontsOf(pdf)` embeds once per document; `widthOf` measures with the same font without a document, so line breaks can be decided
 * before anything is drawn. What the font cannot draw is src/pdf/glyphs.ts.
 */
import { type EmbeddedFont, PDF } from '@libpdf/core'
import { fromBase64 } from '../bytes'
import { BOLD_BASE64, REGULAR_BASE64 } from './font-data'

export interface Fonts {
  regular: EmbeddedFont
  bold: EmbeddedFont
}

let bytes: { regular: Uint8Array; bold: Uint8Array } | null = null
/** Decoded once per isolate, not per document. */
const fontBytes = () => (bytes ??= { regular: fromBase64(REGULAR_BASE64), bold: fromBase64(BOLD_BASE64) })

const perDocument = new WeakMap<PDF, Fonts>()

/** The font embedded in this document (once; every later call returns the same one). */
export function fontsOf(pdf: PDF): Fonts {
  let f = perDocument.get(pdf)
  if (!f) {
    const b = fontBytes()
    f = { regular: pdf.embedFont(b.regular), bold: pdf.embedFont(b.bold) }
    perDocument.set(pdf, f)
  }
  return f
}

let meter: Fonts | null = null

/** The width of a text in points, measured with the document's font. */
export function widthOf(text: string, size: number, bold = false): number {
  meter ??= fontsOf(PDF.create())
  return (bold ? meter.bold : meter.regular).widthOfTextAtSize(text, size)
}

/**
 * Keeps only the glyphs this document uses, in each embedded font. LibPDF does it when asked at save (`save({ subsetFonts: true })`), but
 * `pdf.sign` saves on its own, so a document that is sealed would carry the whole font (about 70 KB for each of two fonts): this asks first.
 * `fonts.finalize` is not in LibPDF's typings, so test/font.test.ts pins the result (a few KB), and the library is pinned exactly.
 * Call it once, after everything is drawn. A document with no embedded font is left alone.
 */
export function subsetFonts(pdf: PDF): void {
  if (!perDocument.has(pdf)) return
  ;(pdf as unknown as { fonts: { finalize(subset: boolean): void } }).fonts.finalize(true)
}
