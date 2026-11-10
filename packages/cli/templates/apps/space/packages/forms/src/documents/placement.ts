/**
 * Field placement, as pure rules: which of a PDF's own fields can be given to a signer, and whether a set of placed fields is
 * one the signing core can take. No LibPDF, no storage, so both the API and its tests use it directly.
 *
 * A placed field is a `PreparedField` (src/fields.ts): a signer's position, a type, a page, a box as fractions of the shown
 * page. One that fills a field the PDF already has also carries that field's name, and then its page and box are the PDF's
 * own: the server takes them from the file and ignores what the request says, because the value is written into that field
 * and the signer must be shown it where the file puts it.
 */
import { FIELD_TYPES, type FieldType, type PreparedField, checkPrepared, isFieldType } from '../fields'
import { badRequest } from '../store'
import { type LeftAsIs, MAX_FIELD_SIGNERS, type OwnField, type StoredInspection, preparedPages } from './shared'

const TYPES_FOR: Record<OwnField['kind'], FieldType[]> = {
  // A text field of the PDF can hold a typed value or the day it was signed.
  text: ['text', 'date'],
  checkbox: ['checkbox'],
  // A signature field is filled with the signer's picture, whichever they adopted.
  signature: ['signature', 'initials'],
}

/** What a PDF's own fields offer, and what is left to the file with the reason (the operator is shown both). */
export function offers(inspection: StoredInspection): { own_fields: OwnField[]; left_as_is: LeftAsIs[] } {
  const own_fields: OwnField[] = []
  const left_as_is: LeftAsIs[] = []
  for (const f of inspection.fields) {
    const why = (reason: string) => left_as_is.push({ name: f.name, reason })
    if (f.kind === 'radio' || f.kind === 'dropdown' || f.kind === 'other') why(`a ${f.kind === 'other' ? 'field of a kind this service does not fill' : f.kind === 'radio' ? 'radio button' : 'dropdown'}; it stays as the file has it`)
    else if (f.readOnly) why('read only')
    else if (f.signed) why('already signed')
    else if (f.hidden) why('hidden in the file, so a reader shows nothing there')
    else if (f.page === null || f.box === null) why('not on any page')
    else if (f.clipped) why('not wholly on the page, so a signer could not see all of it')
    else if (f.kind === 'text' && f.maxLength > 0) why(`it takes at most ${f.maxLength} characters, so a longer answer would be cut; place a text field over it instead`)
    else own_fields.push({ name: f.name, kind: f.kind, page: f.page, box: f.box, types: TYPES_FOR[f.kind], widgets: f.widgets })
  }
  return { own_fields, left_as_is }
}

const asObject = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/**
 * The fields a request places, checked and normalised, or a plain reason as a 400. Every box sits inside its page, every field
 * belongs to a signer position from 1 to MAX_FIELD_SIGNERS, a field of the PDF's own is used once and takes its page and box
 * from the file.
 */
export function checkPlacement(inspection: StoredInspection, raw: unknown): PreparedField[] {
  if (!Array.isArray(raw)) throw badRequest('Expected a list of fields')
  const { own_fields } = offers(inspection)
  const byName = new Map(own_fields.map((s) => [s.name, s]))
  const usedNames = new Set<string>()
  const fields: PreparedField[] = raw.map((item, i) => {
    const at = `Field ${i + 1}`
    const o = asObject(item)
    if (!o) throw badRequest(`${at} is not a field`)
    if (!isFieldType(o.type)) throw badRequest(`${at} has an unknown type; it is one of ${FIELD_TYPES.join(', ')}`)
    const recipient = o.recipient
    if (typeof recipient !== 'number' || !Number.isInteger(recipient) || recipient < 1 || recipient > MAX_FIELD_SIGNERS) throw badRequest(`${at} must belong to signer 1 to ${MAX_FIELD_SIGNERS}`)
    const label = o.label === undefined || o.label === null ? null : typeof o.label === 'string' ? o.label.trim() || null : undefined
    if (label === undefined) throw badRequest(`${at}'s label must be text`)
    if (label !== null && /[\u0000-\u001f\u007f]/.test(label)) throw badRequest(`${at}'s label may not contain control characters`)
    if (o.required !== undefined && typeof o.required !== 'boolean') throw badRequest(`${at}'s required must be true or false`)
    const required = o.required !== false
    const own = o.pdfFieldName
    if (own !== undefined && own !== null) {
      if (typeof own !== 'string') throw badRequest(`${at}'s PDF field name must be text`)
      const s = byName.get(own)
      if (!s) throw badRequest(`${at} names a field the PDF does not have, or one this service does not fill (${own})`)
      if (usedNames.has(own)) throw badRequest(`${at} fills the PDF's field ${own}, which another field of yours already fills`)
      usedNames.add(own)
      if (!s.types.includes(o.type)) throw badRequest(`${at} cannot be a ${o.type}: the PDF's field ${own} takes ${s.types.join(' or ')}`)
      return { recipient, type: o.type, page: s.page, box: { ...s.box }, required, label, pdfFieldName: own }
    }
    const b = asObject(o.box)
    const page = o.page
    if (!b || typeof page !== 'number') throw badRequest(`${at} needs a page and a box`)
    return { recipient, type: o.type, page, box: { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }, required, label, pdfFieldName: null }
  })
  const signers = [...new Set(fields.map((f) => f.recipient))].map((position) => ({ position, kind: 'signer' as const }))
  const problems = checkPrepared({ pages: preparedPages(inspection), fields }, signers)
  if (problems.length > 0) throw badRequest(problems.join(' '))
  return fields
}

/** The signers (positions) a set of fields is given to, in order. */
export const signersOf = (fields: Pick<PreparedField, 'recipient'>[]): number[] => [...new Set(fields.map((f) => f.recipient))].sort((a, b) => a - b)
