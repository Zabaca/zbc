/**
 * The `document` source (src/sources.ts): an uploaded PDF with its fields placed, turned into the prepared document the signing
 * core takes. The prepared document IS the working copy, byte for byte (so its SHA-256 is the working copy's), with the pages the
 * upload recorded and the fields as placed; the original upload stays beside it and the certificate names both by hash.
 *
 * Fields name their signer by position, and a position is a signer in the order Send names them, so the people named at Send
 * must be exactly the signers the fields were placed for: too few leaves fields with nobody to fill them, more leaves a signer
 * with nothing to do. Either is said in words before anything is stored.
 */
import type { PreparedDocument } from '../fields'
import type { SourceBuilder } from '../sources'
import { badRequest } from '../store'
import { loadDocumentRow, workingCopyOf } from './index'
import { signersOf } from './placement'
import { type StoredInspection, preparedPages } from './shared'

const list = (n: number[]) => (n.length === 2 ? `${n[0]} and ${n[1]}` : n.length > 2 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : String(n[0] ?? ''))

export const documentSource: SourceBuilder = async ({ d, client, signers, spec }) => {
  const id = spec.documentId
  if (typeof id !== 'string' || id === '') throw badRequest('Choose which document to send')
  const row = await loadDocumentRow(d, id).catch(() => null)
  if (!row || row.client_id !== client.id) throw badRequest(`That document is not one of ${client.display_name}'s`)
  const inspection = JSON.parse(row.inspection) as StoredInspection
  const fields = JSON.parse(row.fields) as PreparedDocument['fields']
  if (fields.length === 0) throw badRequest(`${row.name} has no fields yet. Place a signature on it first.`)
  const placed = signersOf(fields)
  const want = Array.from({ length: signers.length }, (_, i) => i + 1)
  const missing = want.filter((p) => !placed.includes(p))
  const extra = placed.filter((p) => !want.includes(p))
  if (extra.length > 0) throw badRequest(`${row.name} has fields for signer${placed.length === 1 ? '' : 's'} ${list(placed)}, but ${signers.length === 1 ? 'one signer is' : `${signers.length} signers are`} named. Name ${placed.length === 1 ? 'a signer' : `${placed.length} signers`}, or change who the fields belong to.`)
  if (missing.length > 0) throw badRequest(`${row.name} has no fields for signer${missing.length === 1 ? '' : 's'} ${list(missing)}. Remove ${missing.length === 1 ? 'that signer' : 'those signers'}, or place fields for them.`)
  const prepared: PreparedDocument = {
    bytes: await workingCopyOf(d, row),
    pages: preparedPages(inspection),
    fields,
  }
  // What the upload found, for the event log: a reader will show earlier signatures as changed once this is sealed, and the restrictions
  // and the XFA layer the file had are not in what was signed.
  const details = { original_sha256: row.original_sha256, earlier_signatures: inspection.signatures, restrictions_removed: inspection.restrictionsOnly, xfa_dropped: inspection.xfa === 'with-fields' }
  return { kind: 'document', title: row.name, prepared, sourceDocumentId: row.id, details }
}
