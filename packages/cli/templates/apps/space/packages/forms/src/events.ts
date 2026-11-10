/**
 * The event log: what happened to an envelope, in order, in a chain nobody can quietly edit.
 *
 * Each event's hash is SHA-256 over its own fields in a fixed order plus the hash of the event before it, so a
 * changed or removed event breaks every hash after it, and the last link is printed in the sealed PDF every party
 * holds. The database refuses any UPDATE of an event and any DELETE until the envelope has a tombstone
 * (migrations/0001_init.sql); this module is the other half: events are appended in the SAME batch as the change
 * they record, and a sequence number is unique per envelope, so two writes racing for the same place fail one of
 * them, which retries from the new tail.
 *
 * Tamper-evident, not tamper-proof: someone with direct database access could rewrite an UNFINISHED envelope's
 * history. Once the document is finished and sealed, every party's copy would disagree with the rewrite.
 */
import { hex } from './bytes'
import { type Db, type Stmt, isUniqueViolation, isoAt } from './records'

/** The previous hash of the first event. */
export const GENESIS = '0'.repeat(64)

export type ActorKind = 'operator' | 'recipient' | 'system' | 'agent'

/** The actions the log records (the append-only event log). */
export const ACTIONS = [
  'created',
  'draft-edited',
  'sent',
  'mailed',
  'opened',
  'consented',
  'consent-sample-opened',
  'document-shown',
  'answered',
  'prepared',
  'signature-adopted',
  'signed',
  'declined',
  'reminded',
  'recipient-corrected',
  'cancelled',
  'expired',
  'sealing',
  'completed',
  'copy-downloaded',
  'sensitive-answer-revealed',
] as const
export type Action = (typeof ACTIONS)[number]

export interface EventInput {
  action: Action
  actorKind: ActorKind
  actorEmail?: string | null
  actorName?: string | null
  ip?: string | null
  userAgent?: string | null
  /** A short description made from the browser string (see `describeDevice`). */
  device?: string | null
  details?: Record<string, unknown>
  /** The fingerprint of the document at this moment (shown, signed, finished). */
  docHash?: string | null
}

export interface EventRow {
  envelope_id: string
  client_id: string
  seq: number
  at: string
  actor_kind: ActorKind
  actor_email: string | null
  actor_name: string | null
  action: string
  ip: string | null
  user_agent: string | null
  device: string | null
  details: string
  doc_hash: string | null
  prev_hash: string
  hash: string
}

/** JSON with object keys in a fixed order, so the same details are always the same text. */
export const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

/**
 * The hash of an event: ALL its fields (the client's id included, so an event cannot be moved to another client) in a fixed
 * order, as a JSON array (unambiguous, unlike a joined string), and the previous hash.
 */
export async function eventHash(e: Omit<EventRow, 'hash'>): Promise<string> {
  const material = JSON.stringify([e.envelope_id, e.client_id, e.seq, e.at, e.actor_kind, e.actor_email, e.actor_name, e.action, e.ip, e.user_agent, e.device, e.details, e.doc_hash, e.prev_hash])
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)))
}

const COLUMNS = 'envelope_id, client_id, seq, at, actor_kind, actor_email, actor_name, action, ip, user_agent, device, details, doc_hash, prev_hash, hash'
const MARKS = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?'
const INSERT = `INSERT INTO events (${COLUMNS}) VALUES (${MARKS})`
const MARKS_BEFORE_HASH = MARKS.slice(0, MARKS.length - 3)
// A guarded insert puts its guard in the hash column: `CASE WHEN <guard> THEN ? END` is NULL when the guard fails, the column is NOT NULL,
// and the error takes the whole batch back, the caller's own changes with it. (A guard in a WHERE clause would insert nothing and let
// the changes after it run anyway, on the strength of someone else's identical event.)
const GUARD_LOST = /NOT NULL constraint failed: events\.hash/i

export interface Appended {
  events: EventRow[]
  /** The chain's last link after this write. */
  last: string
  /** False only when `whenStatus` was given and the envelope was no longer in it: nothing was written. */
  applied: boolean
}

/**
 * Appends events to an envelope's log in one batch together with `changes`, the statements that make the change
 * the events record. All of it lands or none of it does. A sequence collision (another write took the next place)
 * retries from the new tail, with the same `changes`.
 *
 * `whenRecipient` is the same guard on one recipient's status (the signer who double-clicks Finish writes one `signed` event).
 * `whenRecipient.valuesVersion` also requires the signer's saved values to be what the caller read (Finish hashes them).
 * `whenTail` makes the write conditional on the log still ending at that sequence number: nothing was appended since the caller
 * read the state it decided on (an agent's send, whose instruction covers the draft as it stood, is written only if the draft has
 * not been edited, and an edit is an event, since the fingerprint was computed).
 *
 * `whenSql` is one more condition of the caller's own, tested by the first event with the rest (a change that is only worth recording if
 * it will take effect: a file removed that is still there).
 *
 * `whenStatus` makes the write conditional on the envelope still being in one of those statuses when the batch runs:
 * the events are inserted only then, and they run BEFORE `changes` so that a change which moves the envelope on does
 * not hide the state they were guarded by. The caller's own change statements carry the same guard (`UPDATE envelopes
 * SET status = 'completed' WHERE id = ? AND status = 'sealing'`). Two finishers racing for one envelope therefore
 * write ONE 'completed' event between them, and the loser gets `applied: false` and writes nothing: a lost guard fails
 * the whole batch (see GUARD_LOST), so none of the loser's `changes` run, whatever else is in the log.
 */
export async function appendEvents(
  db: Db,
  envelope: { id: string; client_id: string },
  events: EventInput[],
  opts: { now: number; changes?: Stmt[] | ((anchor: { seq: number; hash: string }) => Stmt[]); whenStatus?: string[]; whenRecipient?: { id: string; status: string[]; valuesVersion?: number }; whenTail?: number; whenSql?: { sql: string; binds: unknown[] }; retries?: number },
): Promise<Appended> {
  const tries = opts.retries ?? 6
  let lastError: unknown
  for (let attempt = 0; attempt < tries; attempt++) {
    const tail = await db.prepare('SELECT seq, hash FROM events WHERE envelope_id = ? ORDER BY seq DESC LIMIT 1').bind(envelope.id).first<{ seq: number; hash: string }>()
    let seq = tail?.seq ?? 0
    let prev = tail?.hash ?? GENESIS
    const rows: EventRow[] = []
    for (const e of events) {
      const base: Omit<EventRow, 'hash'> = {
        envelope_id: envelope.id,
        client_id: envelope.client_id,
        seq: ++seq,
        at: isoAt(opts.now),
        actor_kind: e.actorKind,
        actor_email: e.actorEmail ?? null,
        actor_name: e.actorName ?? null,
        action: e.action,
        ip: e.ip ?? null,
        user_agent: e.userAgent ?? null,
        device: e.device ?? null,
        details: stableJson(e.details ?? {}),
        doc_hash: e.docHash ?? null,
        prev_hash: prev,
      }
      const hash = await eventHash(base)
      rows.push({ ...base, hash })
      prev = hash
    }
    const values = (r: EventRow) => [r.envelope_id, r.client_id, r.seq, r.at, r.actor_kind, r.actor_email, r.actor_name, r.action, r.ip, r.user_agent, r.device, r.details, r.doc_hash, r.prev_hash, r.hash]
    const who = opts.whenRecipient
    const conditional = opts.whenStatus !== undefined || who !== undefined || opts.whenTail !== undefined || opts.whenSql !== undefined
    const inserts = rows.map((r, i) => {
      if (!conditional) return db.prepare(INSERT).bind(...values(r))
      const envelopeIn = opts.whenStatus ? ` AND EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND status IN (${opts.whenStatus.map(() => '?').join(', ')}))` : ''
      const recipientIn = who ? ` AND EXISTS (SELECT 1 FROM recipients WHERE id = ? AND status IN (${who.status.map(() => '?').join(', ')})${who.valuesVersion !== undefined ? ' AND values_version = ?' : ''})` : ''
      // The first event is held to the tail the caller read; each later one to the event before it having been written, so a write
      // that loses the race writes none of its events and not just the first.
      const tailIs = opts.whenTail === undefined ? '' : i === 0 ? ' AND (SELECT COALESCE(MAX(seq), 0) FROM events WHERE envelope_id = ?) = ?' : ' AND EXISTS (SELECT 1 FROM events WHERE envelope_id = ? AND seq = ? AND hash = ?)'
      const tailBinds = opts.whenTail === undefined ? [] : i === 0 ? [envelope.id, opts.whenTail] : [envelope.id, rows[i - 1]!.seq, rows[i - 1]!.hash]
      const [hash, ...beforeHash] = [...values(r)].reverse()
      return db
        .prepare(`INSERT INTO events (${COLUMNS}) SELECT ${MARKS_BEFORE_HASH}, CASE WHEN 1 = 1${envelopeIn}${recipientIn}${tailIs}${opts.whenSql && i === 0 ? ` AND (${opts.whenSql.sql})` : ''} THEN ? END`)
        .bind(...beforeHash.reverse(), ...(opts.whenStatus ? [envelope.id, ...opts.whenStatus] : []), ...(who ? [who.id, ...who.status, ...(who.valuesVersion !== undefined ? [who.valuesVersion] : [])] : []), ...tailBinds, ...(opts.whenSql && i === 0 ? opts.whenSql.binds : []), hash)
    })
    try {
      // A function builds the changes from this attempt's first event, so each one can depend on that event having been
      // written (src/signing/support.ts, `Guarded.onEvent`): the guard is then tested once, by the event, and no statement
      // needs to be ordered around the status it changes.
      const changes = typeof opts.changes === 'function' ? opts.changes({ seq: rows[0]!.seq, hash: rows[0]!.hash }) : (opts.changes ?? [])
      await db.batch(conditional ? [...inserts, ...changes] : [...changes, ...inserts])
    } catch (e) {
      if (conditional && GUARD_LOST.test(String((e as Error)?.message ?? e))) return { events: [], last: tail?.hash ?? GENESIS, applied: false }
      if (!isUniqueViolation(e)) throw e
      lastError = e
      continue
    }
    return { events: rows, last: prev, applied: true }
  }
  throw lastError ?? new Error('could not append events')
}

/** The sequence number an envelope's log ends at (0 when it has no events): what `whenTail` is given. */
export async function tailSeq(db: Db, envelopeId: string): Promise<number> {
  return (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE envelope_id = ?').bind(envelopeId).first<{ n: number }>())!.n
}

/** An envelope's events, oldest first. */
export async function readEvents(db: Db, envelopeId: string): Promise<EventRow[]> {
  return (await db.prepare('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq').bind(envelopeId).all<EventRow>()).results
}

export type ChainVerdict = { ok: true; count: number; last: string } | { ok: false; brokenAt: number; why: 'hash' | 'link' | 'sequence' }

/** Recomputes every hash and link. A changed field, a removed or reordered event, or a wrong sequence says where it broke. */
export async function verifyChain(rows: EventRow[]): Promise<ChainVerdict> {
  let prev = GENESIS
  let expected = 1
  for (const r of rows) {
    if (r.seq !== expected) return { ok: false, brokenAt: r.seq, why: 'sequence' }
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.seq, why: 'link' }
    const { hash, ...rest } = r
    if ((await eventHash(rest)) !== hash) return { ok: false, brokenAt: r.seq, why: 'hash' }
    prev = hash
    expected++
  }
  return { ok: true, count: rows.length, last: prev }
}

export async function checkChain(db: Db, envelopeId: string): Promise<ChainVerdict> {
  return verifyChain(await readEvents(db, envelopeId))
}

/** A short description of a browser string: "Safari on iPhone". Unknown strings say so rather than guess. */
export function describeDevice(ua: string | null | undefined): string | null {
  if (!ua) return null
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? 'Unrecognized browser'
}

