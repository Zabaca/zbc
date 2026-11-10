/**
 * Where a draft envelope's document comes from: the one contract the Send screen and the admin API use to turn "what to send"
 * into a prepared document (src/fields.ts) or a form version, so the signing core never learns which.
 *
 *   SOURCES.sample    the built-in sample
 *   SOURCES.form      a published form version (the form path)
 *   SOURCES.document  an uploaded PDF with its fields placed (the PDF path)
 *
 * A request names a source by `source.type`; the builder reads the rest of `source` and returns what
 * `createEnvelope` takes. Each kind of source adds ONE line to the table and its builder in its own file.
 */
import { sha256Hex } from './bytes'
import { formSource } from './forms/source'
import type { PreparedDocument } from './fields'
import { documentSource } from './documents/source'
import { SAMPLE_MAX_SIGNERS, buildSampleDocument } from './pdf/sample'
import { newId } from './records'
import { SAMPLE_SOURCE_OWNER } from './signing'
import { type ClientRow, type CoreDeps, isoAt } from './signing/support'
import { badRequest } from './store'
import { putSealed } from './vault'

export interface DraftSource {
  kind: 'form' | 'document'
  title: string
  /** A document envelope's prepared document. */
  prepared?: PreparedDocument
  sourceDocumentId?: string
  /** A form envelope's published form version. */
  formVersionId?: string
  sensitive?: boolean
  /** Recorded in the envelope's `created` event. */
  details?: Record<string, unknown>
  /** Undoes what building the source stored, if creating the envelope then fails. */
  cleanup?: () => Promise<void>
}

export interface SourceRequest {
  d: CoreDeps
  client: ClientRow
  /** The signers, in order: the roles a document's fields are given to. */
  signers: { role: string }[]
  /** The request's `source` object. */
  spec: Record<string, unknown>
}

export type SourceBuilder = (r: SourceRequest) => Promise<DraftSource>

/** The built-in sample: a branded page with a block of all five field types per signer. */
const sampleSource: SourceBuilder = async ({ d, client, signers }) => {
  if (signers.length < 1 || signers.length > SAMPLE_MAX_SIGNERS) throw badRequest(`The sample has room for 1 to ${SAMPLE_MAX_SIGNERS} signers`)
  const logoObject = client.logo_key ? await d.files.get(client.logo_key) : null
  const logo = logoObject && client.logo_type ? { bytes: new Uint8Array(await logoObject.arrayBuffer()), type: client.logo_type } : null
  const prepared = await buildSampleDocument(client, logo, signers, d.service)
  // The sample is its own source document: the same row an uploaded PDF has, owned by the envelope it is made for, so a
  // sample is sent and kept and deleted the way a real document is.
  const id = newId()
  const { key, wrapped, version } = await d.vault.newDataKey(`source:${id}`)
  const sha = await sha256Hex(prepared.bytes)
  const originalKey = `sources/${id}/original`
  const workingKey = `sources/${id}/working`
  await putSealed(d.files, originalKey, key, prepared.bytes, 'application/pdf')
  await putSealed(d.files, workingKey, key, prepared.bytes, 'application/pdf')
  await d.db
    .prepare(
      'INSERT INTO source_documents (id, client_id, name, original_key, original_sha256, original_size, working_key, working_sha256, working_size, page_count, inspection, fields, wrapped_key, key_version, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, client.id, 'Sample document (built in)', originalKey, sha, prepared.bytes.length, workingKey, sha, prepared.bytes.length, prepared.pages.length, JSON.stringify({ sample: true }), '[]', wrapped, version, SAMPLE_SOURCE_OWNER, isoAt(d.now()))
    .run()
  return {
    kind: 'document',
    title: `Sample document for ${client.display_name}`,
    prepared,
    sourceDocumentId: id,
    cleanup: async () => {
      await d.files.delete([originalKey, workingKey])
      await d.db.prepare('DELETE FROM source_documents WHERE id = ?').bind(id).run()
    },
  }
}

/** One line per kind of source. */
export const SOURCES: Record<string, SourceBuilder> = {
  sample: sampleSource,
  form: formSource,
  document: documentSource,
}
