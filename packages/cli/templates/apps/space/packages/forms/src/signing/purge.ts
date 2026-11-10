/**
 * Retention: an envelope is deleted at the end of its keeping period, and deletion is the mechanism (ADR 0004). A purge
 * deletes the R2 objects, then the rows and with them the wrapped key, and keeps a tombstone: the envelope's id, its
 * client, its title, when it completed, the finished document's hash and the chain's last link, enough to say it existed
 * and to match a copy someone still holds. A restored backup brings back ciphertext whose key is gone.
 *
 * It does not write a `purged` event: the events are deleted in the same batch, and the tombstone is the record.
 * R2 goes first: if the rows then fail to delete, the next run finds them still due and finishes. Only what is due is purged,
 * checked before R2 and again inside the batch (item: a draft sent at the top of the hour is not purged).
 */
import { type Actor, type CoreDeps, actorLabel, isoAt, loadEnvelope, requireOperator } from './support'

/** A source document made for one envelope (the built-in sample) is its envelope's to delete; an upload is not. */
export const SAMPLE_SOURCE_OWNER = 'system:sample'

export type PurgeReason = 'retention' | 'unfinished' | 'operator'

export async function purgeEnvelope(d: CoreDeps, actor: Actor, id: string, reason: PurgeReason): Promise<boolean> {
  if (reason === 'operator') requireOperator(actor, 'purge an envelope')
  else if (actor.kind !== 'system') requireOperator(actor, 'purge an envelope')
  const e = await loadEnvelope(d.db, id).catch(() => null)
  if (!e) return false
  const keys = new Set<string>()
  for (const k of [e.prepared_key, e.finished_key]) if (k) keys.add(k)
  for (const row of (await d.db.prepare('SELECT r2_key AS k FROM uploads WHERE envelope_id = ?').bind(id).all<{ k: string }>()).results) keys.add(row.k)
  for (const row of (await d.db.prepare('SELECT image_key AS k FROM signature_adoptions WHERE envelope_id = ? AND image_key IS NOT NULL').bind(id).all<{ k: string }>()).results) keys.add(row.k)
  const source = e.source_document_id ? await d.db.prepare('SELECT id, original_key, working_key, uploaded_by FROM source_documents WHERE id = ?').bind(e.source_document_id).first<{ id: string; original_key: string; working_key: string; uploaded_by: string }>() : null
  const ownsSource = source?.uploaded_by === SAMPLE_SOURCE_OWNER
  if (source && ownsSource) {
    keys.add(source.original_key)
    keys.add(source.working_key)
  }
  // Retention and the sweep purge only what is DUE: an envelope that was sent since the sweep read it (a draft at the top of the
  // hour) has no purge time any more and is left alone. Checked again here, right before anything is deleted, and again by the
  // batch itself, which writes the tombstone only if the envelope is still due.
  const due = (e.purge_at ?? null) !== null && Date.parse(e.purge_at!) <= d.now()
  if (reason !== 'operator') {
    const fresh = await d.db.prepare('SELECT purge_at FROM envelopes WHERE id = ?').bind(id).first<{ purge_at: string | null }>()
    if (!due || !fresh || fresh.purge_at === null || Date.parse(fresh.purge_at) > d.now()) return false
  }
  if (keys.size > 0) await d.files.delete([...keys])

  const db = d.db
  const now = isoAt(d.now())
  // Only if the envelope is still there and (unless an operator asked) still due; everything after it hangs on the tombstone.
  const stillDue = reason === 'operator' ? 'EXISTS (SELECT 1 FROM envelopes WHERE id = ?)' : 'EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND purge_at IS NOT NULL AND purge_at <= ?)'
  const hasStone = 'EXISTS (SELECT 1 FROM tombstones WHERE envelope_id = ?)'
  const stmts = [
    db
      .prepare(`INSERT INTO tombstones (envelope_id, client_id, title, completed_at, finished_sha256, chain_last_hash, purged_at, reason) SELECT ?, ?, ?, ?, ?, (SELECT hash FROM events WHERE envelope_id = ? ORDER BY seq DESC LIMIT 1), ?, ? WHERE ${stillDue}`)
      .bind(id, e.client_id, e.title, e.completed_at, e.finished_sha256, id, now, reason, id, ...(reason === 'operator' ? [] : [now])),
    ...['field_values', 'fields', 'answers', 'uploads', 'signature_adoptions', 'instruction_uses', 'instructions', 'mail', 'events', 'recipients'].map((t) => db.prepare(`DELETE FROM ${t} WHERE envelope_id = ? AND ${hasStone}`).bind(id, id)),
    db.prepare(`DELETE FROM envelopes WHERE id = ? AND ${hasStone}`).bind(id, id),
    ...(source && ownsSource ? [db.prepare(`DELETE FROM source_documents WHERE id = ? AND NOT EXISTS (SELECT 1 FROM envelopes WHERE source_document_id = ?) AND ${hasStone}`).bind(source.id, source.id, id)] : []),
    ...(reason === 'operator' ? [db.prepare(`INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) SELECT ?, ?, ?, ?, ?, ?, NULL WHERE ${hasStone}`).bind(actorLabel(actor), 'purge', e.client_id, 'envelopes', id, JSON.stringify({ title: e.title, status: e.status }), id)] : []),
  ]
  await db.batch(stmts)
  // Nothing deleted means nothing purged: the tombstone is what the batch wrote.
  return (await db.prepare('SELECT 1 AS one FROM tombstones WHERE envelope_id = ?').bind(id).first()) !== null
}

/** Envelopes whose time has come, in a batch the sweep can finish within a run. */
export async function purgeDue(d: CoreDeps): Promise<number> {
  const rows = (await d.db.prepare('SELECT id, status FROM envelopes WHERE purge_at IS NOT NULL AND purge_at <= ? ORDER BY purge_at LIMIT 25').bind(isoAt(d.now())).all<{ id: string; status: string }>()).results
  let n = 0
  for (const r of rows) {
    try {
      if (await purgeEnvelope(d, { kind: 'system' }, r.id, r.status === 'completed' ? 'retention' : 'unfinished')) n++
    } catch (err) {
      console.error(`purging ${r.id} failed; it will be tried again`, err)
    }
  }
  return n
}

