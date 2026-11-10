/**
 * THE PDF PATH: a client's own PDF, uploaded once, with fields placed on its pages for each signer, kept until an
 * operator deletes it and sent as many times as it is wanted. Sending turns it into a prepared document and hands that to the
 * signing core (src/documents/source.ts), so a signer gets the same guided experience as for any document.
 *
 *   uploadDocument   inspect, ask for the confirmations a file needs, store
 *                    the file as received and its working copy, each encrypted under the document's own key
 *   listDocuments, documentDetail, workingCopyOf   what the admin's screens read
 *   placeFields, renameDocument, deleteDocument    the operator's changes, each one batch with its audit row
 *
 * A document is a `source_documents` row (migration 0001). An upload's `uploaded_by` is the operator; the built-in sample
 * uses the same table and belongs to its envelope (`SAMPLE_SOURCE_OWNER`), so the sample is never listed here.
 */
import { sha256Hex } from '../bytes'
import { text } from '../clients'
import type { PreparedField } from '../fields'
import { workingCopy } from '../pdf/engine'
import { newId } from '../records'
import { SAMPLE_SOURCE_OWNER, type Actor, type CoreDeps } from '../signing'
import { actorLabel, isoAt, loadClient, requireOperator } from '../signing/support'
import { badRequest, conflict, notFound } from '../store'
import { getSealed, putSealed } from '../vault'
import { checkPlacement, offers, signersOf } from './placement'
import type { DocumentDetail, DocumentSummary, StoredInspection, UploadRefusal } from './shared'

/** The most a document's name may be: it becomes an envelope's title, which the core limits to 120. */
const MAX_NAME = 120

export interface DocumentRow {
  id: string
  client_id: string
  name: string
  original_key: string
  original_sha256: string
  original_size: number
  working_key: string
  working_sha256: string
  working_size: number
  page_count: number
  inspection: string
  fields: string
  wrapped_key: string
  key_version: number
  uploaded_by: string
  created_at: string
}

const keyContext = (id: string) => `source:${id}`

/** A document's name from a file name: no folder, no ".pdf", no control characters, at most MAX_NAME. */
export function documentName(raw: string | null | undefined): string {
  let s = (raw ?? '').replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).trim()
  return s
}

const checkedName = (raw: unknown): string => text(raw, 'The name', MAX_NAME)

const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export async function loadDocumentRow(d: CoreDeps, id: string): Promise<DocumentRow> {
  const row = await d.db.prepare('SELECT * FROM source_documents WHERE id = ? AND uploaded_by <> ?').bind(id, SAMPLE_SOURCE_OWNER).first<DocumentRow>()
  if (!row) throw notFound('Document')
  return row
}

const envelopesFrom = async (d: CoreDeps, id: string): Promise<number> => (await d.db.prepare('SELECT COUNT(*) AS n FROM envelopes WHERE source_document_id = ?').bind(id).first<{ n: number }>())?.n ?? 0

function summary(row: DocumentRow, envelopes: number): DocumentSummary {
  const fields = parse<PreparedField[]>(row.fields, [])
  return { id: row.id, client_id: row.client_id, name: row.name, page_count: row.page_count, size: row.working_size, original_sha256: row.original_sha256, uploaded_by: row.uploaded_by, created_at: row.created_at, fields_placed: fields.length, signers: signersOf(fields), envelopes }
}

async function detailOf(d: CoreDeps, row: DocumentRow): Promise<DocumentDetail> {
  const inspection = parse<StoredInspection>(row.inspection, null as never)
  return { ...summary(row, await envelopesFrom(d, row.id)), inspection, fields: parse<PreparedField[]>(row.fields, []), ...offers(inspection) }
}

export async function listDocuments(d: CoreDeps, clientId: string | null): Promise<DocumentSummary[]> {
  const rows = (await d.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM envelopes e WHERE e.source_document_id = s.id) AS envelopes FROM source_documents s WHERE s.uploaded_by <> ? AND (?2 IS NULL OR s.client_id = ?2) ORDER BY s.created_at DESC, s.id').bind(SAMPLE_SOURCE_OWNER, clientId).all<DocumentRow & { envelopes: number }>()).results
  return rows.map((r) => summary(r, r.envelopes))
}

export async function documentDetail(d: CoreDeps, id: string): Promise<DocumentDetail> {
  return detailOf(d, await loadDocumentRow(d, id))
}

/** A document's working copy: the bytes a signer is shown and fields are placed on. Checked against the hash stored beside it. */
export async function workingCopyOf(d: CoreDeps, row: DocumentRow): Promise<Uint8Array> {
  const key = await d.vault.unwrap(row.wrapped_key, row.key_version, keyContext(row.id))
  const bytes = await getSealed(d.files, row.working_key, key)
  if (!bytes) throw new Error(`The working copy of document ${row.id} is missing from storage`)
  if ((await sha256Hex(bytes)) !== row.working_sha256) throw new Error(`The working copy of document ${row.id} does not match its recorded hash`)
  return bytes
}

export async function readWorkingCopy(d: CoreDeps, id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const row = await loadDocumentRow(d, id)
  return { bytes: await workingCopyOf(d, row), name: row.name }
}

export interface UploadInput {
  clientId: string
  bytes: Uint8Array
  name: string
  /** The file's own password, used to open it and never kept. */
  password?: string
  /** What the operator has confirmed so far: the upload asks for the rest. */
  confirm: ReadonlySet<string>
}

export type UploadOutcome = { ok: true; document: DocumentDetail } | ({ ok: false; status: 409 | 422 } & UploadRefusal)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Takes an upload. Nothing is stored unless the file can be signed from start to finish: it opens (a password is asked for,
 * never kept), is not an XFA-only form, is within the engine's limits, and the operator has confirmed what a file with a restriction
 * or an earlier signature needs. Images in any encoding are accepted: the signer's page decodes JPEG 2000, JBIG2 and CCITT fax with the
 * WASM files vite.config.ts ships. The original is kept as received beside
 * the working copy; both are encrypted under a key of this document's own, and the upload is one audit row with the batch.
 */
export async function uploadDocument(d: CoreDeps, actor: Actor, input: UploadInput): Promise<UploadOutcome> {
  requireOperator(actor, 'upload a document')
  const client = await loadClient(d.db, input.clientId)
  const name = checkedName(documentName(input.name) || 'Untitled document')
  const made = await workingCopy(input.bytes, { password: input.password })
  if (!made.ok) return { ok: false, status: 422, error: made.refusal.message, code: made.refusal.code }
  const { inspection: seen, bytes: working } = made.value

  const confirm: ('restrictions' | 'signatures')[] = []
  if (seen.restrictionsOnly && !input.confirm.has('restrictions')) confirm.push('restrictions')
  if (seen.signatures > 0 && !input.confirm.has('signatures')) confirm.push('signatures')
  if (confirm.length > 0) {
    const words: string[] = []
    if (confirm.includes('restrictions')) words.push('This file restricts changes (it is protected against editing or filling in). Fields can only be placed and values written after those restrictions are removed from our working copy. Confirm that the client may have this document filled in and signed here.')
    if (confirm.includes('signatures')) words.push(`This file already carries ${plural(seen.signatures, 'signature', 'signatures')}. Once it is signed here, a PDF reader shows ${seen.signatures === 1 ? 'that signature' : 'those signatures'} as changed, because the sealed copy is saved whole. Confirm that this is acceptable.`)
    return { ok: false, status: 409, error: words.join(' '), code: 'confirm', confirm }
  }


  const stored: StoredInspection = {
    pages: seen.pages.map(({ index, width, height, rotation, scanned }) => ({ index, width, height, rotation, scanned })),
    fields: seen.fields,
    encrypted: seen.encrypted,
    restrictionsOnly: seen.restrictionsOnly,
    signatures: seen.signatures,
    xfa: seen.xfa,
    mixedSizes: seen.mixedSizes,
    turnedPages: seen.turnedPages,
    scannedPages: seen.scannedPages,
    recovered: seen.recovered,
    // A damaged file can warn at length, and this goes in one D1 row.
    warnings: seen.warnings.slice(0, 50).map((w) => w.slice(0, 300)),
    confirmed: { restrictions: seen.restrictionsOnly, signatures: seen.signatures > 0 },
  }

  const id = newId()
  const { key, wrapped, version } = await d.vault.newDataKey(keyContext(id))
  const originalSha = await sha256Hex(input.bytes)
  const workingSha = await sha256Hex(working)
  const originalKey = `sources/${id}/original`
  const workingKey = `sources/${id}/working`
  await putSealed(d.files, originalKey, key, input.bytes, 'application/pdf')
  await putSealed(d.files, workingKey, key, working, 'application/pdf')
  const now = isoAt(d.now())
  try {
    await d.db.batch([
      d.db
        .prepare(
          'INSERT INTO source_documents (id, client_id, name, original_key, original_sha256, original_size, working_key, working_sha256, working_size, page_count, inspection, fields, wrapped_key, key_version, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, client.id, name, originalKey, originalSha, input.bytes.length, workingKey, workingSha, working.length, stored.pages.length, JSON.stringify(stored), '[]', wrapped, version, actorLabel(actor), now),
      d.db
        .prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, after) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(actorLabel(actor), 'upload', client.id, 'source_documents', id, JSON.stringify({ name, original_sha256: originalSha, original_size: input.bytes.length, pages: stored.pages.length, signatures: seen.signatures, restrictions_removed: seen.restrictionsOnly, confirmed: stored.confirmed, xfa_dropped: seen.xfa === 'with-fields', recovered: seen.recovered })),
    ])
  } catch (e) {
    await d.files.delete([originalKey, workingKey])
    throw e
  }
  return { ok: true, document: await documentDetail(d, id) }
}

/** Replaces a document's placed fields (the whole set), after the rules in placement.ts. One audit row holds the before and after. */
export async function placeFields(d: CoreDeps, actor: Actor, id: string, raw: unknown): Promise<DocumentDetail> {
  requireOperator(actor, 'place fields')
  const row = await loadDocumentRow(d, id)
  const fields = checkPlacement(parse<StoredInspection>(row.inspection, null as never), raw)
  const after = JSON.stringify(fields)
  if (after !== row.fields) {
    await d.db.batch([
      d.db.prepare('UPDATE source_documents SET fields = ? WHERE id = ?').bind(after, id),
      d.db.prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(actorLabel(actor), 'place-fields', row.client_id, 'source_documents', id, row.fields, after),
    ])
  }
  return documentDetail(d, id)
}

export async function renameDocument(d: CoreDeps, actor: Actor, id: string, rawName: unknown): Promise<DocumentDetail> {
  requireOperator(actor, 'rename a document')
  const row = await loadDocumentRow(d, id)
  const name = checkedName(rawName)
  if (name !== row.name) {
    await d.db.batch([
      d.db.prepare('UPDATE source_documents SET name = ? WHERE id = ?').bind(name, id),
      d.db.prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(actorLabel(actor), 'rename', row.client_id, 'source_documents', id, JSON.stringify({ name: row.name }), JSON.stringify({ name })),
    ])
  }
  return documentDetail(d, id)
}

/**
 * Deletes a document and its stored files, and with its row the key that opened them. Refused while any envelope still
 * points at it: an envelope keeps its own copy of the prepared document, but its certificate names the original upload by hash,
 * and a purge of the envelope is what lets the document go.
 */
export async function deleteDocument(d: CoreDeps, actor: Actor, id: string): Promise<void> {
  requireOperator(actor, 'delete a document')
  const row = await loadDocumentRow(d, id)
  // The row goes first and only if no envelope points at it (so an envelope made a moment ago is never left without its source);
  // the files follow, and without the row's wrapped key they could not be opened if the delete below were to fail.
  await d.db.batch([
    d.db.prepare('DELETE FROM source_documents WHERE id = ? AND NOT EXISTS (SELECT 1 FROM envelopes WHERE source_document_id = ?)').bind(id, id),
    d.db
      .prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) SELECT ?, ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM source_documents WHERE id = ?)')
      .bind(actorLabel(actor), 'delete', row.client_id, 'source_documents', id, JSON.stringify({ name: row.name, original_sha256: row.original_sha256, pages: row.page_count }), id),
  ])
  if (await d.db.prepare('SELECT 1 AS one FROM source_documents WHERE id = ?').bind(id).first()) {
    const n = await envelopesFrom(d, id)
    throw conflict(`${plural(n, 'envelope was', 'envelopes were')} made from this document. It can be deleted once ${n === 1 ? 'that envelope is' : 'those envelopes are'} deleted.`)
  }
  await d.files.delete([row.original_key, row.working_key])
}
