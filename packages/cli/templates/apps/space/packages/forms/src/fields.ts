/**
 * THE SHARED CONTRACT between authoring and signing (ADR 0001), and the field catalog both ways of authoring draw from.
 * The form path and the PDF path both build on it and change none of it without the other.
 *
 * A PREPARED DOCUMENT is a fixed PDF, its pages as shown, and its fields. Authoring ends by handing one to the signing
 * core (`src/signing`), which stores it encrypted with its SHA-256 and knows nothing about forms or uploads (two exceptions, in `src/signing/index.ts`).
 *
 * A FIELD is a place one signer fills. Its box is FRACTIONS of the page AS SHOWN from the top-left corner, so placement does
 * not depend on how a file stores rotation or crop (`src/pdf/geometry.ts` converts when it stamps). Its recipient is a POSITION:
 * the recipient's place in the envelope (1 is the first), because a prepared document is made before its recipients have ids
 * and a template is placed by role and sent by naming people.
 *
 * Pure and free of LibPDF, so the admin's placement screens and the signer's page import it too.
 */
import type { FractionBox, Rotation } from './pdf/geometry'
import { canDraw, whyNotDrawable } from './pdf/glyphs'

export const FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** How a field gets its value. */
export type FillKind = 'adopted' | 'automatic' | 'typed' | 'checked'

export interface FieldKind {
  type: FieldType
  /** The palette's name for it. */
  label: string
  /** What the signer is told to do. */
  hint: string
  /** A new field's size on a Letter page in points; a placement screen turns it into fractions of the page it lands on. */
  defaultSize: { width: number; height: number }
  fill: FillKind
  /** Text only: the most characters a signer may type (a field is one line). */
  maxLength?: number
}

/** The five field types: what each is, how it is filled and how big it starts. The one place that says so. */
export const FIELD_CATALOG: Readonly<Record<FieldType, FieldKind>> = {
  signature: { type: 'signature', label: 'Signature', hint: 'Sign here', defaultSize: { width: 180, height: 44 }, fill: 'adopted' },
  initials: { type: 'initials', label: 'Initials', hint: 'Initial here', defaultSize: { width: 60, height: 32 }, fill: 'adopted' },
  date: { type: 'date', label: 'Date signed', hint: 'Filled in for you', defaultSize: { width: 110, height: 22 }, fill: 'automatic' },
  text: { type: 'text', label: 'Text', hint: 'Type here', defaultSize: { width: 180, height: 22 }, fill: 'typed', maxLength: 200 },
  checkbox: { type: 'checkbox', label: 'Checkbox', hint: 'Check to agree', defaultSize: { width: 18, height: 18 }, fill: 'checked' },
}

export const isFieldType = (t: unknown): t is FieldType => typeof t === 'string' && (FIELD_TYPES as readonly string[]).includes(t)

export interface PreparedPage {
  index: number
  /** As shown, in points. */
  width: number
  height: number
  rotation: Rotation
}

export interface PreparedField {
  /** The recipient's position in the envelope, 1 for the first. Must be a signer. */
  recipient: number
  type: FieldType
  /** Zero-based. */
  page: number
  box: FractionBox
  required: boolean
  /** Shown to the signer; a text field's name for what to type. */
  label?: string | null
  /** The name of the PDF's own field this one fills, when it was detected in the file (the PDF path). */
  pdfFieldName?: string | null
}

export interface PreparedDocument {
  bytes: Uint8Array
  pages: PreparedPage[]
  fields: PreparedField[]
}

export const MAX_FIELDS = 200
const MIN_SIDE = 0.004

/** What is wrong with a prepared document, in words an operator can act on; empty when it is fine. */
export function checkPrepared(doc: Pick<PreparedDocument, 'pages' | 'fields'>, recipients: { position: number; kind: 'signer' | 'copy' }[]): string[] {
  const problems: string[] = []
  if (doc.pages.length === 0) problems.push('The document has no pages.')
  if (doc.fields.length > MAX_FIELDS) problems.push(`The document has ${doc.fields.length} fields; the most is ${MAX_FIELDS}.`)
  const signers = new Set(recipients.filter((r) => r.kind === 'signer').map((r) => r.position))
  const have = new Set<number>()
  doc.fields.forEach((f, i) => {
    const at = `Field ${i + 1}`
    if (!isFieldType(f.type)) return void problems.push(`${at} has an unknown type.`)
    if (!signers.has(f.recipient)) return void problems.push(`${at} belongs to recipient ${f.recipient}, who is not a signer.`)
    have.add(f.recipient)
    if (!Number.isInteger(f.page) || f.page < 0 || f.page >= doc.pages.length) return void problems.push(`${at} is on page ${f.page + 1}, which the document does not have.`)
    const b = f.box
    const ok = [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
    if (!ok || b.x < 0 || b.y < 0 || b.width < MIN_SIDE || b.height < MIN_SIDE || b.x + b.width > 1.0000001 || b.y + b.height > 1.0000001) problems.push(`${at} does not sit inside its page.`)
    if (f.label != null && f.label.length > 80) problems.push(`${at}'s label is over 80 characters.`)
  })
  for (const p of signers) if (!have.has(p)) problems.push(`Recipient ${p} is a signer with nothing to fill or sign.`)
  return problems
}

/** A new field's box for a placement screen: the catalog's size on this page, centred on a point and kept inside the page. */
export function defaultBox(type: FieldType, page: { width: number; height: number }, at: { x: number; y: number }): FractionBox {
  const size = FIELD_CATALOG[type].defaultSize
  const width = Math.min(1, size.width / page.width)
  const height = Math.min(1, size.height / page.height)
  return { x: Math.min(1 - width, Math.max(0, at.x - width / 2)), y: Math.min(1 - height, Math.max(0, at.y - height / 2)), width, height }
}

// What the document's font can draw (src/pdf/glyphs.ts): a value it cannot draw would be a blank on the signed page, so it is refused
// where it is typed, with a plain reason.
export const isDrawable = canDraw

/** The value a signer may save in a field: null when it is fine, else the plain reason it is not. A signature and initials hold a marker, a date is never typed. */
export function checkFieldValue(type: FieldType, value: unknown): string | null {
  switch (type) {
    case 'signature':
    case 'initials':
      return value === 'adopted' ? null : 'Apply your signature to sign here.'
    case 'date':
      return 'A date fills itself in when you finish.'
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'A checkbox is checked or not.'
    case 'text': {
      if (typeof value !== 'string') return 'Type some text.'
      const max = FIELD_CATALOG.text.maxLength!
      if (value.length > max) return `That is over ${max} characters.`
      if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return 'This takes one line of text.'
      const bad = whyNotDrawable(value)
      if (bad) return bad
      return null
    }
  }
}
