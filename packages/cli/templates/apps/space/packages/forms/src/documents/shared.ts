/**
 * What the PDF path's server and the admin's screens share: the shapes the API returns and the one number both check. Types
 * and a constant only (the type imports are erased), so a browser entry imports it and takes nothing else with it.
 */
import type { FieldType, PreparedField, PreparedPage } from '../fields'
import type { DetectedField } from '../pdf/engine'
import type { FractionBox, Rotation } from '../pdf/geometry'

/**
 * How many signers a document's fields can be given to: what the Send screen can name. It is the same four as the built-in
 * sample's `SAMPLE_MAX_SIGNERS` (src/pdf/sample.ts) and Send.tsx's cap, which this file cannot import (the sample pulls LibPDF into
 * a browser bundle); test/documents.test.ts pins the two equal. A field names its signer by position, 1 for the first.
 */
export const MAX_FIELD_SIGNERS = 4

/** What upload found, kept with the document (no storage keys, no geometry: the engine rereads the file when it stamps). */
export interface StoredInspection {
  pages: { index: number; width: number; height: number; rotation: Rotation; scanned: boolean }[]
  fields: DetectedField[]
  encrypted: boolean
  restrictionsOnly: boolean
  signatures: number
  xfa: 'none' | 'with-fields' | 'only'
  mixedSizes: boolean
  turnedPages: number[]
  scannedPages: number[]
  recovered: boolean
  warnings: string[]
  /** What the operator confirmed at upload. */
  confirmed: { restrictions: boolean; signatures: boolean }
}

/** One of the PDF's own fillable fields, offered in place to a signer: the types it can become and where the file puts it. */
export interface OwnField {
  name: string
  kind: 'text' | 'checkbox' | 'signature'
  page: number
  box: FractionBox
  types: FieldType[]
  /** How many places the field appears in the file; an answer is written into every one, though the signer is shown the first. */
  widgets: number
}

export interface LeftAsIs {
  name: string
  reason: string
}

export interface DocumentSummary {
  id: string
  client_id: string
  name: string
  page_count: number
  size: number
  original_sha256: string
  uploaded_by: string
  created_at: string
  /** How many fields are placed, and for which signers (positions). */
  fields_placed: number
  signers: number[]
  /** Envelopes made from it. */
  envelopes: number
}

export interface DocumentDetail extends DocumentSummary {
  inspection: StoredInspection
  fields: PreparedField[]
  own_fields: OwnField[]
  left_as_is: LeftAsIs[]
}

/** What an upload answers when it cannot go ahead: `code` says what the screen should ask for. */
export type UploadRefusal = { error: string; code: string; confirm?: ('restrictions' | 'signatures')[] }

/** The pages as a prepared document describes them (src/fields.ts): the one mapping from what upload recorded. */
export const preparedPages = (i: Pick<StoredInspection, 'pages'>): PreparedPage[] => i.pages.map(({ index, width, height, rotation }) => ({ index, width, height, rotation }))
