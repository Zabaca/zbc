/**
 * A form's prepared document: the client's header, the form's title, every visible question with its answer, each
 * agreement text word for word, the uploads listed by name, size and SHA-256, and a signature page with one block per role. The
 * result is what the signing core takes (src/fields.ts `PreparedDocument`): a fixed PDF, its pages as shown, and each signer's
 * fields placed on the signature page.
 *
 * The body is laid out with `appendBlocks` (src/pdf/blocks.ts) in the document's font (src/pdf/font.ts: Latin with its extended and
 * Vietnamese letters, Greek, Cyrillic); text it cannot draw is refused at the question (`refuseText`), so nothing here prints a
 * question mark. A font that covers more (Chinese is the open question) is a change in font.ts, not here. The signature page is drawn directly, because its
 * fields need to know exactly where each block sits.
 *
 * Part of the engine's neighbourhood: with the rest of src/pdf/ it is the only code that touches LibPDF.
 */
import { PDF, rgb } from '@libpdf/core'
import { FIELD_CATALOG, type FieldType, type PreparedDocument, type PreparedField, type PreparedPage } from '../fields'
import { type AnswerValue, type Answers, type FormDefinition, answerText, answerable, isAnswered, visibleQuestions } from '../forms/definition'
import { type ServiceWords, viaSuffix } from '../service'
import { type Block, appendBlocks, drawable } from './blocks'
import { fontsOf, subsetFonts } from './font'

export interface FormUpload {
  questionId: string
  name: string
  size: number
  sha256: string
}

export interface FormLayoutInput {
  /** The envelope's title: the heading of the first page. */
  title: string
  client: { display_name: string; accent_color: string }
  /** The install's names for the service: what follows the business's name on the first page ("via <name>"). */
  service: Pick<ServiceWords, 'name' | 'ownCompanyOnly'>
  logo: { bytes: Uint8Array; type: 'image/png' | 'image/jpeg' } | null
  def: FormDefinition
  /** The filler's answers (a file question holds its uploads' refs). */
  answers: Answers
  uploads: FormUpload[]
  /** The people who sign, by position: the printed name under each role's block. */
  signers: { name: string }[]
}

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0.12, 0.31, 0.47]
}

const GRAY: [number, number, number] = [0.4, 0.4, 0.4]
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/** The blocks of the body: what the signer answered and the agreement text exactly as shown. */
export function bodyBlocks(def: FormDefinition, answers: Answers, uploads: FormUpload[]): Block[] {
  const out: Block[] = []
  for (const q of visibleQuestions(def, answers)) {
    const v: AnswerValue | undefined = answers[q.id]
    if (q.type === 'statement') {
      out.push({ kind: 'text', text: q.text ?? '' }, { kind: 'space', height: 6 })
    } else if (q.type === 'agreement') {
      out.push({ kind: 'rule' }, { kind: 'text', text: q.label || 'Agreement', bold: true, size: 11 }, { kind: 'space', height: 2 }, { kind: 'text', text: q.text ?? '' }, { kind: 'space', height: 2 })
      out.push({ kind: 'text', text: isAnswered(q, v) ? 'The signer checked the box: I agree.' : 'The box was not checked.', bold: true, size: 9.5 }, { kind: 'rule' })
    } else if (answerable(q)) {
      out.push({ kind: 'text', text: q.label, bold: true, size: 8.5, color: GRAY })
      if (q.type === 'file') {
        const n = uploads.filter((u) => u.questionId === q.id).length
        out.push({ kind: 'text', text: n === 0 ? '(no file)' : `${n} ${n === 1 ? 'file' : 'files'}, listed under Uploaded files`, size: 10 })
      } else {
        const text = answerText(q, v)
        out.push(text ? { kind: 'text', text, size: 10 } : { kind: 'text', text: '(no answer)', size: 10, color: GRAY })
      }
      out.push({ kind: 'space', height: 5 })
    }
  }
  if (uploads.length > 0) {
    out.push({ kind: 'heading', text: 'Uploaded files' }, { kind: 'text', text: 'The files themselves are delivered as downloads beside this document; the fingerprints below identify each one.', size: 8.5, color: GRAY })
    for (const u of uploads) out.push({ kind: 'text', text: u.name, bold: true, size: 9.5 }, { kind: 'text', text: `${size(u.size)}. SHA-256 ${u.sha256}`, size: 8, color: GRAY }, { kind: 'space', height: 3 })
  }
  return out
}

/** How tall one role's block is on the signature page, in points: the printed name, a signature and a date, then its own fields. */
export const blockHeight = (ownFields: number): number => 170 + 44 * ownFields

const LEFT = 54
const PAGE_W = 612
const PAGE_H = 792
const BOTTOM = 60
const SIG_TOP = 128
const NEXT_TOP = 90

export async function layoutForm(i: FormLayoutInput): Promise<PreparedDocument> {
  const pdf = PDF.create()
  const [r, g, b] = hexToRgb(i.client.accent_color)
  appendBlocks(pdf, {
    title: i.title,
    brand: { name: i.client.display_name, via: viaSuffix(i.service), color: [r, g, b], logo: i.logo ? { bytes: i.logo.bytes, format: i.logo.type === 'image/png' ? 'png' : 'jpeg' } : undefined },
    blocks: bodyBlocks(i.def, i.answers, i.uploads),
  })
  const bodyPages = pdf.getPages().length

  const font = fontsOf(pdf)
  const fields: PreparedField[] = []
  const dark = rgb(0.25, 0.25, 0.25)
  const gray = rgb(...GRAY)
  let page = pdf.addPage({ size: 'letter' })
  const header = (cont: boolean) => {
    page.drawText(cont ? 'Signatures (continued)' : 'Signatures', { x: LEFT, y: PAGE_H - 70, size: 16, font: font.bold })
    page.drawText(drawable(i.title), { x: LEFT, y: PAGE_H - 86, size: 9, font: font.regular, color: gray })
    if (!cont) page.drawText('By signing below, each person agrees to the answers and the agreement shown on the pages above.', { x: LEFT, y: PAGE_H - 106, size: 9.5, font: font.regular })
  }
  header(false)
  let top = SIG_TOP

  i.def.roles.forEach((role, idx) => {
    const height = blockHeight(role.fields.length)
    if (top + height > PAGE_H - BOTTOM) {
      page = pdf.addPage({ size: 'letter' })
      header(true)
      top = NEXT_TOP
    }
    const pageIndex = pdf.getPages().length - 1
    const y = (fromTop: number) => PAGE_H - (top + fromTop)
    const recipient = idx + 1
    const name = i.signers[idx]?.name ?? ''
    page.drawText(drawable(`${role.name}: ${name}`), { x: LEFT, y: y(10), size: 11, font: font.bold })
    const line = (label: string, at: number, x: number, w: number) => {
      page.drawLine({ start: { x, y: y(at) }, end: { x: x + w, y: y(at) }, thickness: 0.6, color: dark })
      page.drawText(drawable(label), { x, y: y(at + 10), size: 8, font: font.regular, color: gray })
    }
    const place = (type: FieldType, x: number, bottom: number, label: string, required = true) => {
      const s = FIELD_CATALOG[type].defaultSize
      fields.push({ recipient, type, page: pageIndex, box: { x: x / PAGE_W, y: (top + bottom - s.height) / PAGE_H, width: s.width / PAGE_W, height: s.height / PAGE_H }, required, label })
    }
    line('Signature', 66, LEFT, 200)
    place('signature', LEFT, 66, 'Signature')
    line('Date', 66, LEFT + 260, 110)
    place('date', LEFT + 260, 66, 'Date')
    page.drawText(drawable(name), { x: LEFT, y: y(100), size: 11, font: font.regular })
    line('Printed name', 108, LEFT, 200)
    role.fields.forEach((f, k) => {
      const at = 152 + 44 * k
      line(f.label, at, LEFT, 200)
      place('text', LEFT, at, f.label.slice(0, 80), f.required)
    })
    top += height
  })

  const pages: PreparedPage[] = Array.from({ length: pdf.getPages().length }, (_, index) => ({ index, width: PAGE_W, height: PAGE_H, rotation: 0 as const }))
  if (pages.length <= bodyPages) throw new Error('the signature page was not added')
  subsetFonts(pdf)
  return { bytes: await pdf.save(), pages, fields }
}
