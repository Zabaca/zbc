/**
 * Pages laid out from blocks: the certificate of completion, and the pages of a form. A flow layout on Letter
 * pages in a standard font: headings, paragraphs, label and value rows, images and rules, with page breaks where they fall.
 * Part of the engine (src/pdf/engine.ts is its only caller); it is the one place besides the engine that touches LibPDF.
 *
 * The document's font (src/pdf/font.ts) draws Latin with its extended and Vietnamese letters, Greek and Cyrillic. Text is made drawable
 * first (`drawable`): a character the font cannot draw becomes a question mark rather than a blank that reads as if nothing was there.
 * A form's pages refuse such a character at the question, so the layout never has to.
 */
import { PDF, type PDFPage, rgb } from '@libpdf/core'
import { widthOf, fontsOf } from './font'
import { drawable } from './glyphs'

export { drawable }

export type Rgb = [number, number, number]

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; size?: number; bold?: boolean; color?: Rgb }
  | { kind: 'row'; label: string; value: string }
  | { kind: 'image'; bytes: Uint8Array; format: 'png' | 'jpeg'; maxWidth: number; maxHeight: number; caption?: string }
  | { kind: 'space'; height?: number }
  | { kind: 'rule' }

export interface BlockPages {
  title: string
  /** The client's header on the first page: its name in its color, and its logo. */
  brand?: { name: string; /** What follows the name in small type: "via <the service's name>", or empty where the install's Forms sends only for its own company. */ via: string; color: Rgb; logo?: { bytes: Uint8Array; format: 'png' | 'jpeg' } }
  blocks: Block[]
}

const LEFT = 54
const WIDTH = 612 - LEFT * 2
const TOP = 792 - 54
const BOTTOM = 60
const LABEL_WIDTH = 132

export function wrap(text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = []
  // Paragraphs first: a line break is not drawn, and must not be turned into a question mark with the characters that are not.
  for (const para of text.split('\n').map(drawable)) {
    let line = ''
    for (let word of para.split(/\s+/).filter(Boolean)) {
      // A word wider than the line (a hash, an address) is cut where it must be, not drawn off the page.
      while (widthOf(word, size, bold) > width) {
        let cut = word.length - 1
        while (cut > 1 && widthOf(word.slice(0, cut), size, bold) > width) cut--
        if (line) (out.push(line), (line = ''))
        out.push(word.slice(0, cut))
        word = word.slice(cut)
      }
      const next = line ? `${line} ${word}` : word
      if (widthOf(next, size, bold) <= width || !line) line = next
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

export function appendBlocks(pdf: PDF, spec: BlockPages): void {
  const font = fontsOf(pdf)
  let page: PDFPage
  let y = 0
  let first = true
  const images = new Map<Uint8Array, ReturnType<PDF['embedPng']>>()

  const newPage = () => {
    page = pdf.addPage({ size: 'letter' })
    y = TOP
    if (first && spec.brand) {
      const [r, g, b] = spec.brand.color
      page.drawRectangle({ x: 0, y: 792 - 70, width: 612, height: 70, color: rgb(r, g, b) })
      let x = LEFT
      if (spec.brand.logo) {
        const img = spec.brand.logo.format === 'png' ? pdf.embedPng(spec.brand.logo.bytes) : pdf.embedJpeg(spec.brand.logo.bytes)
        const scale = Math.min(44 / img.height, 130 / img.width)
        page.drawImage(img, { x, y: 792 - 70 + (70 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale })
        x += img.width * scale + 14
      }
      page.drawText(drawable(spec.brand.name), { x, y: 792 - 38, size: 16, font: font.bold, color: rgb(1, 1, 1) })
      if (spec.brand.via) page.drawText(drawable(spec.brand.via), { x, y: 792 - 54, size: 9, font: font.regular, color: rgb(1, 1, 1) })
      y = 792 - 70 - 30
    }
    if (first) {
      page.drawText(drawable(spec.title), { x: LEFT, y, size: 18, font: font.bold })
      y -= 30
    } else {
      page.drawText(`${drawable(spec.title)} (continued)`, { x: LEFT, y, size: 9, font: font.regular, color: rgb(0.4, 0.4, 0.4) })
      y -= 24
    }
    first = false
  }
  const room = (h: number) => {
    if (y - h < BOTTOM) newPage()
  }
  newPage()

  for (const b of spec.blocks) {
    switch (b.kind) {
      case 'heading':
        room(40)
        y -= 8
        page!.drawText(drawable(b.text), { x: LEFT, y, size: 12, font: font.bold })
        y -= 18
        break
      case 'text': {
        const size = b.size ?? 10
        const face = b.bold ? font.bold : font.regular
        for (const line of wrap(b.text, WIDTH, size, b.bold)) {
          room(size + 4)
          page!.drawText(line, { x: LEFT, y, size, font: face, color: b.color ? rgb(...b.color) : rgb(0, 0, 0) })
          y -= size + 4
        }
        break
      }
      case 'row': {
        const lines = wrap(b.value, WIDTH - LABEL_WIDTH, 9.5)
        room(Math.min(lines.length, 3) * 13 + 2)
        const labelLines = wrap(b.label, LABEL_WIDTH - 8, 8.5, true)
        page!.drawText(labelLines[0] ?? '', { x: LEFT, y, size: 8.5, font: font.bold, color: rgb(0.35, 0.35, 0.35) })
        lines.forEach((line, i) => {
          if (i > 0) room(13)
          page!.drawText(line, { x: LEFT + LABEL_WIDTH, y, size: 9.5, font: font.regular })
          y -= 13
        })
        if (lines.length === 0) y -= 13
        y -= 2
        break
      }
      case 'image': {
        let img = images.get(b.bytes)
        if (!img) {
          img = b.format === 'png' ? pdf.embedPng(b.bytes) : pdf.embedJpeg(b.bytes)
          images.set(b.bytes, img)
        }
        const scale = Math.min(b.maxWidth / img.width, b.maxHeight / img.height, 1)
        const w = img.width * scale
        const h = img.height * scale
        room(h + (b.caption ? 14 : 4))
        page!.drawImage(img, { x: LEFT + LABEL_WIDTH, y: y - h, width: w, height: h })
        y -= h + 4
        if (b.caption) {
          page!.drawText(drawable(b.caption), { x: LEFT + LABEL_WIDTH, y, size: 8, font: font.regular, color: rgb(0.4, 0.4, 0.4) })
          y -= 12
        }
        break
      }
      case 'space':
        y -= b.height ?? 8
        break
      case 'rule':
        room(10)
        page!.drawLine({ start: { x: LEFT, y }, end: { x: LEFT + WIDTH, y }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) })
        y -= 10
        break
    }
  }
}
