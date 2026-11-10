/**
 * Forms and their versions: what an operator builds. A form has a title and versions; a version is the whole frozen
 * definition (src/forms/definition.ts) and its SHA-256. The newest version is a DRAFT while it has no `published_at` and may change;
 * publishing freezes it and nothing changes it after (the database refuses an update, a replace or a delete of a published version,
 * migrations/0001), so a sent form is pinned to exactly what its signer answered. Editing a published form starts a draft of the next
 * version.
 *
 * Every write is one D1 batch together with its audit row (as src/store.ts does for clients, which has no table for these).
 */
import { sha256Hex } from '../bytes'
import { stableJson } from '../events'
import type { Db, Row } from '../records'
import { isoAt, newId } from '../records'
import { badRequest, conflict, notFound } from '../store'
import { type FormDefinition, blankDefinition, hasSensitive, readDefinition } from './definition'

export interface VersionInfo {
  id: string
  version: number
  definition_hash: string
  published_at: string | null
  created_at: string
}

export interface FormSummary {
  id: string
  client_id: string
  client_name: string
  title: string
  updated_at: string
  /** The newest published version, which is what Send offers. */
  published: { id: string; version: number; published_at: string; roles: string[]; sensitive: boolean; questions: number } | null
  /** A draft is being built beyond it. */
  draft: { id: string; version: number } | null
}

interface VersionRow extends VersionInfo {
  client_id: string
  form_id: string
  definition: string
}

const audit = (db: Db, actor: string, action: string, clientId: string, entity: string, entityId: string, before: unknown, after: unknown) =>
  db.prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(actor, action, clientId, entity, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after))

const parse = (row: Pick<VersionRow, 'definition'>): FormDefinition => JSON.parse(row.definition) as FormDefinition

/** Every form, newest change first, with its newest published version and any draft past it. */
export async function listForms(db: Db, clientId: string | null): Promise<FormSummary[]> {
  const forms = (await db.prepare('SELECT f.id, f.client_id, c.display_name AS client_name, f.title, f.updated_at FROM forms f JOIN clients c ON c.id = f.client_id WHERE (?1 IS NULL OR f.client_id = ?1) ORDER BY f.updated_at DESC LIMIT 500').bind(clientId).all<Omit<FormSummary, 'published' | 'draft'>>()).results
  const versions = (await db.prepare('SELECT v.id, v.form_id, v.version, v.published_at, v.definition FROM form_versions v WHERE (?1 IS NULL OR v.client_id = ?1) ORDER BY v.version').bind(clientId).all<Pick<VersionRow, 'id' | 'form_id' | 'version' | 'published_at' | 'definition'>>()).results
  return forms.map((f) => {
    const mine = versions.filter((v) => v.form_id === f.id)
    const pub = [...mine].reverse().find((v) => v.published_at)
    const draft = mine.find((v) => !v.published_at)
    const def = pub ? parse(pub) : null
    return {
      ...f,
      published: pub && def ? { id: pub.id, version: pub.version, published_at: pub.published_at!, roles: def.roles.map((r) => r.name), sensitive: hasSensitive(def), questions: def.questions.length } : null,
      draft: draft ? { id: draft.id, version: draft.version } : null,
    }
  })
}

export async function createForm(db: Db, actor: string, now: number, input: { clientId: string; title: string }): Promise<string> {
  const client = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(input.clientId).first()
  if (!client) throw notFound('Client')
  const { def, problems } = readDefinition(blankDefinition(input.title))
  if (problems.length > 0) throw badRequest(problems.join(' '))
  const id = newId()
  const versionId = newId()
  const at = isoAt(now)
  const json = stableJson(def)
  await db.batch([
    db.prepare('INSERT INTO forms (id, client_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, input.clientId, def.title, at, at),
    db.prepare('INSERT INTO form_versions (id, client_id, form_id, version, definition, definition_hash, published_at, created_at) VALUES (?, ?, ?, 1, ?, ?, NULL, ?)').bind(versionId, input.clientId, id, json, await sha256Hex(json), at),
    audit(db, actor, 'create', input.clientId, 'forms', id, null, { title: def.title }),
  ])
  return id
}

/** A form with its versions and the definition to work on: the draft, or else the newest published version. */
export async function getForm(db: Db, id: string) {
  const form = await db.prepare('SELECT f.id, f.client_id, c.display_name AS client_name, f.title, f.created_at, f.updated_at FROM forms f JOIN clients c ON c.id = f.client_id WHERE f.id = ?').bind(id).first<Row>()
  if (!form) throw notFound('Form')
  const rows = (await db.prepare('SELECT * FROM form_versions WHERE form_id = ? ORDER BY version DESC').bind(id).all<VersionRow>()).results
  const working = rows[0]!
  return {
    form,
    versions: rows.map(({ id, version, definition_hash, published_at, created_at }): VersionInfo => ({ id, version, definition_hash, published_at, created_at })),
    working: { versionId: working.id, version: working.version, published: working.published_at !== null, definition: parse(working) },
  }
}

/** One frozen version's definition, for Send's picker and the filler's screens. Only a published version is returned. */
export async function publishedVersion(db: Db, versionId: string): Promise<{ row: VersionRow; def: FormDefinition } | null> {
  const row = await db.prepare('SELECT * FROM form_versions WHERE id = ? AND published_at IS NOT NULL').bind(versionId).first<VersionRow>()
  return row ? { row, def: parse(row) } : null
}

/**
 * Saves the draft (the definition as the builder holds it). Everything wrong with it is said at once; a definition that
 * is not finished may still be saved, since only publishing needs it complete. When the newest version is published, this starts
 * the next one.
 */
export async function saveDraft(db: Db, actor: string, now: number, formId: string, raw: unknown): Promise<{ versionId: string; version: number }> {
  const { def, problems } = readDefinition(raw)
  if (problems.length > 0) throw badRequest(problems.join(' '))
  const form = await db.prepare('SELECT id, client_id FROM forms WHERE id = ?').bind(formId).first<{ id: string; client_id: string }>()
  if (!form) throw notFound('Form')
  const latest = await db.prepare('SELECT * FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1').bind(formId).first<VersionRow>()
  const at = isoAt(now)
  const json = stableJson(def)
  const hash = await sha256Hex(json)
  if (latest && !latest.published_at) {
    await db.batch([
      db.prepare('UPDATE form_versions SET definition = ?, definition_hash = ? WHERE id = ? AND published_at IS NULL').bind(json, hash, latest.id),
      db.prepare('UPDATE forms SET title = ?, updated_at = ? WHERE id = ?').bind(def.title, at, formId),
      audit(db, actor, 'save-draft', form.client_id, 'form_versions', latest.id, { hash: latest.definition_hash }, def),
    ])
    return { versionId: latest.id, version: latest.version }
  }
  const versionId = newId()
  const version = (latest?.version ?? 0) + 1
  await db.batch([
    db.prepare('INSERT INTO form_versions (id, client_id, form_id, version, definition, definition_hash, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)').bind(versionId, form.client_id, formId, version, json, hash, at),
    db.prepare('UPDATE forms SET title = ?, updated_at = ? WHERE id = ?').bind(def.title, at, formId),
    audit(db, actor, 'start-draft', form.client_id, 'form_versions', versionId, null, def),
  ])
  return { versionId, version }
}

/** Freezes the draft. What is checked here is what a signer will meet: a form that cannot be answered is not published. */
export async function publish(db: Db, actor: string, now: number, formId: string): Promise<{ versionId: string; version: number; hash: string }> {
  const draft = await db.prepare('SELECT * FROM form_versions WHERE form_id = ? AND published_at IS NULL').bind(formId).first<VersionRow>()
  if (!draft) throw conflict('There is no draft to publish. Change the form first, and it becomes a new version.')
  const { def, problems } = readDefinition(JSON.parse(draft.definition), { publish: true })
  if (problems.length > 0) throw badRequest(problems.join(' '))
  const json = stableJson(def)
  const hash = await sha256Hex(json)
  const at = isoAt(now)
  await db.batch([
    db.prepare('UPDATE form_versions SET definition = ?, definition_hash = ?, published_at = ? WHERE id = ? AND published_at IS NULL').bind(json, hash, at, draft.id),
    db.prepare('UPDATE forms SET updated_at = ? WHERE id = ?').bind(at, formId),
    db
      .prepare("INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) SELECT ?, 'publish', ?, 'form_versions', ?, NULL, ? WHERE EXISTS (SELECT 1 FROM form_versions WHERE id = ? AND published_at = ?)")
      .bind(actor, draft.client_id, draft.id, JSON.stringify({ version: draft.version, hash }), draft.id, at),
  ])
  const done = await db.prepare('SELECT published_at FROM form_versions WHERE id = ?').bind(draft.id).first<{ published_at: string | null }>()
  if (done?.published_at !== at) throw conflict('That version was published a moment ago by someone else.')
  return { versionId: draft.id, version: draft.version, hash }
}
