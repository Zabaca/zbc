/**
 * Operator writes to clients, forms and documents go through this file, and each one is sent in the same D1 batch
 * as its audit row. A batch is one transaction, so a write without its audit row cannot happen, and neither can an
 * audit row for a write that failed. Adapted from an earlier store of the same shape, with a client in place of an
 * organization.
 *
 * A write is first PLANNED (`planCreate`, `planUpdate`): its statements and its audit statement, nothing sent.
 * `run` sends one or several plans as one batch. The audit row carries the actor, the client, and the row before
 * and after, which is the row-level undo; whole-database restore is D1 Time Travel (30 days).
 *
 * Envelope changes are NOT here: the signing core writes those, each in one batch with its event (src/events.ts).
 */
import { HTTPException } from 'hono/http-exception'
import type { Db, Row, Stmt } from './records'

/** The tables operators write. The form path and the PDF path add forms and source documents when they have routes to write them. */
export type Table = 'clients'

/**
 * Every column of every table: the ONLY place a key becomes a SQL identifier. create and update refuse any key
 * not listed, so a request body can never name a column, let alone inject one.
 */
const COLUMNS: Record<Table, readonly string[]> = {
  clients: ['id', 'slug', 'client_number', 'display_name', 'legal_name', 'accent_color', 'logo_key', 'logo_type', 'logo_sha256', 'reply_to', 'copy_addresses', 'time_zone', 'retention_years', 'created_at', 'updated_at'],
}

/**
 * What a request body may set. The logo has its own route; ids, slugs after creation and timestamps come only from here. THE NAMES ARE NOT HERE: a row's display name and legal name are a copy of its Client's, written by the Clients part
 * (src/client-names.ts) and never by a request body; its Client's number is set by create and by Link.
 */
export const WRITABLE: Record<Table, readonly string[]> = {
  clients: ['accent_color', 'reply_to', 'copy_addresses', 'time_zone', 'retention_years'],
}

const JSON_COLUMNS = new Set(['copy_addresses'])

export const badRequest = (message: string) => new HTTPException(400, { message })
export const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` })
export const conflict = (message: string) => new HTTPException(409, { message })

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

function encode(table: Table, row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (!COLUMNS[table].includes(k)) throw new Error(`${table} has no column ${k}`)
    out[k] = JSON_COLUMNS.has(k) && v !== null && v !== undefined ? stable(v) : (v ?? null)
  }
  return out
}

/** A stored row with its JSON columns parsed, which is how the API returns it and the audit records it. */
export function decode<T extends Row | null>(row: T): T {
  if (!row) return row
  const out: Row = { ...row }
  for (const k of JSON_COLUMNS) {
    if (typeof out[k] === 'string') {
      try {
        out[k] = JSON.parse(out[k] as string)
      } catch {
        // Stored by something other than this app; return it as text.
      }
    }
  }
  return out as T
}

const clientOf = (table: Table, row: Row): string | null => (table === 'clients' ? (row.id as string) : ((row.client_id as string | undefined) ?? null))

export async function get(db: Db, table: Table, id: string): Promise<Row | null> {
  return decode(await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first())
}

/** One write, planned: the statements to send and which one returns the row. */
export interface Plan {
  statements: Stmt[]
  /** Index of the statement whose first row is the written row; null when nothing is written. */
  result: number | null
  /** The row as it stands when nothing is written. */
  current?: Row
}

export function planCreate(db: Db, actor: string, table: Table, row: Row, action = 'create'): Plan {
  const enc = encode(table, row)
  if (typeof enc.id !== 'string') throw badRequest(`${table} needs an id`)
  const keys = Object.keys(enc)
  const insert = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`).bind(...keys.map((k) => enc[k]))
  const audit = db
    .prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, after) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(actor, action, clientOf(table, enc), table, enc.id, JSON.stringify(decode(enc)))
  return { statements: [insert, audit], result: 0 }
}

/** The statements for patching one row; none when the patch changes nothing, so a repeated save leaves no audit noise. */
export async function planUpdate(db: Db, actor: string, table: Table, id: string, patch: Row, at: string, action = 'update'): Promise<Plan> {
  const before = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Row>()
  if (!before) throw notFound(`${table} ${id}`)
  const enc = encode(table, patch)
  const changed = Object.keys(enc).filter((k) => enc[k] !== before[k])
  if (changed.length === 0) return { statements: [], result: null, current: decode(before) }
  enc.updated_at = at
  const keys = [...changed, 'updated_at']
  const stmt = db
    .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`)
    .bind(...keys.map((k) => enc[k]), id)
  const audit = db
    .prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(actor, action, clientOf(table, before), table, id, JSON.stringify(decode(before)), JSON.stringify(decode({ ...before, ...enc })))
  return { statements: [stmt, audit], result: 0 }
}

/** Send every plan as one batch. Each plan's written row comes back, in order (or its unchanged row). */
export async function run(db: Db, plans: Plan[]): Promise<Row[]> {
  const statements = plans.flatMap((p) => p.statements)
  const offsets: number[] = []
  let at = 0
  for (const p of plans) {
    offsets.push(at)
    at += p.statements.length
  }
  const results = statements.length > 0 ? await db.batch(statements) : []
  return plans.map((p, i) => (p.result === null ? (p.current ?? {}) : decode(results[offsets[i]! + p.result]!.results[0] as Row)))
}

export async function create(db: Db, actor: string, table: Table, row: Row, action = 'create'): Promise<Row> {
  return (await run(db, [planCreate(db, actor, table, row, action)]))[0]!
}

export async function update(db: Db, actor: string, table: Table, id: string, patch: Row, at: string, action = 'update'): Promise<Row> {
  return (await run(db, [await planUpdate(db, actor, table, id, patch, at, action)]))[0]!
}
