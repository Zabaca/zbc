// The record's own rules, at the database and the event log: an event is appended in the same batch as the change it
// records, in a hash chain that breaks when anything is edited, and the database itself refuses to change or remove one
// (until its envelope is purged). Over the real migration, so the triggers under test are the ones D1 will run.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { GENESIS, appendEvents, checkChain, describeDevice, eventHash, readEvents, stableJson, verifyChain } from '../src/events'
import type { Db } from '../src/records'
import { openLocalD1 } from './local-d1'

let sqlite: Database
let d1: Db
beforeEach(() => {
  const local = openLocalD1()
  sqlite = local.db
  d1 = local.d1
  sqlite.run(`INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('c1', 'lane', 'Lane', 'Larch Co', 'a@b.test', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`)
  sqlite.run(`INSERT INTO source_documents (id, client_id, name, original_key, original_sha256, original_size, working_key, working_sha256, working_size, page_count, inspection, wrapped_key, key_version, uploaded_by, created_at) VALUES ('s1', 'c1', 'letter.pdf', 'k', 'h', 1, 'k', 'h', 1, 1, '{}', 'w', 1, 'j', 'x')`)
  sqlite.run(`INSERT INTO envelopes (id, client_id, kind, source_document_id, title, status, created_by, created_at, wrapped_key, key_version) VALUES ('e1', 'c1', 'document', 's1', 'Engagement letter', 'draft', 'tessa@northfield.example', '2026-10-31T00:00:00Z', 'w', 1)`)
})

const env = { id: 'e1', client_id: 'c1' }
const NOW = Date.UTC(2026, 9, 31, 20, 0)

describe('the chain', () => {
  test('events are chained from a fixed start, each hash covering its own fields and the one before', async () => {
    const a = await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator', actorEmail: 'tessa@northfield.example', ip: '203.0.113.5', device: 'Safari on iPhone', details: { b: 2, a: 1 } }], { now: NOW })
    expect(a.events[0]).toMatchObject({ seq: 1, prev_hash: GENESIS, details: '{"a":1,"b":2}', at: '2026-10-31T20:00:00.000Z' })
    const b = await appendEvents(d1, env, [{ action: 'sent', actorKind: 'operator' }, { action: 'mailed', actorKind: 'system', docHash: 'ab'.repeat(32) }], { now: NOW + 1000 })
    expect(b.events.map((e) => e.seq)).toEqual([2, 3])
    expect(b.events[0]!.prev_hash).toBe(a.events[0]!.hash)
    expect(b.events[1]!.prev_hash).toBe(b.events[0]!.hash)
    expect(await checkChain(d1, 'e1')).toEqual({ ok: true, count: 3, last: b.last })
    expect((await readEvents(d1, 'e1')).map((e) => e.action)).toEqual(['created', 'sent', 'mailed'])
  })

  test('the hash is the SHA-256 of a fixed JSON array of ALL the fields (the client id included), so a sealed PDF\'s last link can be recomputed anywhere', async () => {
    const { events } = await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator', actorEmail: 'tessa@northfield.example', actorName: 'Tessa', ip: '203.0.113.5', userAgent: 'UA', device: 'D', details: { x: 1 }, docHash: 'ff' }], { now: NOW })
    const e = events[0]!
    const material = JSON.stringify(['e1', 'c1', 1, '2026-10-31T20:00:00.000Z', 'operator', 'tessa@northfield.example', 'Tessa', 'created', '203.0.113.5', 'UA', 'D', '{"x":1}', 'ff', GENESIS])
    expect(e.hash).toBe(createHash('sha256').update(material).digest('hex'))
    expect(await eventHash({ ...e, hash: undefined } as never)).toBe(e.hash)
  })

  test('a change to any recorded field, a removed or reordered event, or a wrong sequence is found, and where', async () => {
    await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator' }], { now: NOW })
    await appendEvents(d1, env, [{ action: 'sent', actorKind: 'operator' }], { now: NOW + 1 })
    await appendEvents(d1, env, [{ action: 'opened', actorKind: 'recipient', actorEmail: 'x@y.test', ip: '198.51.100.1' }], { now: NOW + 2 })
    await appendEvents(d1, env, [{ action: 'signed', actorKind: 'recipient', actorEmail: 'x@y.test' }], { now: NOW + 3 })
    const rows = await readEvents(d1, 'e1')
    expect((await verifyChain(rows)).ok).toBe(true)

    const edited = rows.map((r) => ({ ...r }))
    edited[1]!.ip = '203.0.113.99'
    expect(await verifyChain(edited)).toEqual({ ok: false, brokenAt: 2, why: 'hash' })

    const rewritten = rows.map((r) => ({ ...r }))
    rewritten[2]!.actor_email = 'someone-else@y.test'
    rewritten[2]!.hash = await eventHash({ ...rewritten[2]! })
    // Re-hashing the edited event hides that event but not the next: its link no longer matches.
    expect(await verifyChain(rewritten)).toEqual({ ok: false, brokenAt: 4, why: 'link' })

    expect(await verifyChain([rows[0]!, rows[2]!, rows[3]!])).toMatchObject({ ok: false, brokenAt: 3, why: 'sequence' })
    expect(await verifyChain([rows[1]!, rows[0]!, rows[2]!, rows[3]!])).toMatchObject({ ok: false })
    expect(await verifyChain([])).toEqual({ ok: true, count: 0, last: GENESIS })
  })

  test('the change and its event land together or not at all', async () => {
    const change = d1.prepare("UPDATE envelopes SET status = 'sent', sent_by = ?, sent_at = ? WHERE id = 'e1'").bind('tessa@northfield.example', '2026-10-31T20:00:00Z')
    await appendEvents(d1, env, [{ action: 'sent', actorKind: 'operator' }], { now: NOW, changes: [change] })
    expect(sqlite.query("SELECT status FROM envelopes WHERE id = 'e1'").get()).toEqual({ status: 'sent' })
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })

    // An event the schema refuses rolls the change back with it.
    const second = d1.prepare("UPDATE envelopes SET status = 'completed' WHERE id = 'e1'")
    await expect(appendEvents(d1, env, [{ action: 'completed', actorKind: 'nobody' as never }], { now: NOW + 1, changes: [second] })).rejects.toThrow(/CHECK constraint/)
    expect(sqlite.query("SELECT status FROM envelopes WHERE id = 'e1'").get()).toEqual({ status: 'sent' })
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
  })

  test('writers racing for the same place each get one, in order, and the chain holds', async () => {
    const writers = Array.from({ length: 6 }, (_, i) => appendEvents(d1, env, [{ action: 'reminded', actorKind: 'system', details: { n: i } }], { now: NOW + i }))
    const done = await Promise.all(writers)
    expect(done).toHaveLength(6)
    const rows = await readEvents(d1, 'e1')
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await verifyChain(rows)).ok).toBe(true)
  })

  test('a sequence number is unique per envelope at the database', async () => {
    await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator' }], { now: NOW })
    expect(() =>
      sqlite.run(`INSERT INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) VALUES ('e1', 'c1', 1, 'x', 'system', 'created', '{}', '${GENESIS}', 'h')`),
    ).toThrow(/UNIQUE|PRIMARY KEY/)
  })

  test('details are hashed as the stable text they are stored as', () => {
    expect(stableJson({ b: { d: 1, c: 2 }, a: [3, { z: 1, y: 2 }] })).toBe('{"a":[3,{"y":2,"z":1}],"b":{"c":2,"d":1}}')
  })
})

describe('the chain cannot be broken without the database or the verifier noticing', () => {
  beforeEach(async () => {
    await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator' }, { action: 'sent', actorKind: 'operator' }], { now: NOW })
  })
  const row = (seq: number, prev: string, hash = 'h', client = 'c1') =>
    `INSERT OR REPLACE INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) VALUES ('e1', '${client}', ${seq}, 'x', 'system', 'created', '{}', '${prev}', '${hash}')`

  test('INSERT OR REPLACE over an existing event is refused, and the row is the one that was there', async () => {
    const before = await readEvents(d1, 'e1')
    expect(() => sqlite.run(row(1, GENESIS, 'forged'))).toThrow(/UNIQUE constraint failed/)
    expect(() => sqlite.run(row(2, before[0]!.hash, 'forged'))).toThrow(/UNIQUE constraint failed/)
    expect(() => sqlite.run(`REPLACE INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) VALUES ('e1', 'c1', 1, 'x', 'system', 'created', '{}', '${GENESIS}', 'forged')`)).toThrow(/UNIQUE constraint failed/)
    expect(await readEvents(d1, 'e1')).toEqual(before)
    expect((await checkChain(d1, 'e1')).ok).toBe(true)
  })

  test('an event must follow the last one: no gap, and the previous hash must be the last hash', async () => {
    const [first, second] = await readEvents(d1, 'e1')
    expect(() => sqlite.run(row(5, second!.hash))).toThrow(/UNIQUE constraint failed/)
    expect(() => sqlite.run(row(3, first!.hash))).toThrow(/UNIQUE constraint failed/)
    expect(() => sqlite.run(row(3, GENESIS))).toThrow(/UNIQUE constraint failed/)
    sqlite.run(row(3, second!.hash, 'ok'))
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 3 })
  })

  test('the first event of an envelope has the fixed start as its previous hash', () => {
    sqlite.run(`INSERT INTO envelopes (id, client_id, kind, source_document_id, title, status, created_by, created_at, wrapped_key, key_version) VALUES ('e2', 'c1', 'document', 's1', 'Other', 'draft', 'j', 'x', 'w', 1)`)
    expect(() => sqlite.run(`INSERT INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) VALUES ('e2', 'c1', 1, 'x', 'system', 'created', '{}', 'not-the-start', 'h')`)).toThrow(/UNIQUE constraint failed/)
  })

  test('an event carries the client of its envelope', () => {
    sqlite.run(`INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('c2', 'other', 'O', 'O', 'a@b.test', 'x', 'x')`)
    return readEvents(d1, 'e1').then((rows) => {
      expect(() => sqlite.run(row(3, rows[1]!.hash, 'h', 'c2'))).toThrow(/carries its envelope/)
    })
  })

  test('the client is part of what an event\'s hash covers: an event moved to another client breaks the chain', async () => {
    const rows = await readEvents(d1, 'e1')
    const moved = rows.map((r) => ({ ...r }))
    moved[0]!.client_id = 'c2'
    expect(await verifyChain(moved)).toEqual({ ok: false, brokenAt: 1, why: 'hash' })
  })

  test('a tombstone cannot be changed or removed, so events cannot be deleted by writing one and taking it away', async () => {
    sqlite.run("INSERT INTO tombstones (envelope_id, client_id, title, purged_at, reason) VALUES ('e1', 'c1', 't', '2026-10-31T21:00:00Z', 'retention')")
    expect(() => sqlite.run("DELETE FROM tombstones WHERE envelope_id = 'e1'")).toThrow(/never deleted/)
    expect(() => sqlite.run("UPDATE tombstones SET reason = 'operator' WHERE envelope_id = 'e1'")).toThrow(/never changed/)
    expect(() => sqlite.run("INSERT OR REPLACE INTO tombstones (envelope_id, client_id, title, purged_at, reason) VALUES ('e1', 'c1', 'other', 'x', 'operator')")).toThrow(/never replaced/)
    expect(sqlite.query("SELECT title FROM tombstones WHERE envelope_id = 'e1'").get()).toEqual({ title: 't' })
    expect(sqlite.query("SELECT count(*) AS n FROM tombstones WHERE envelope_id = 'e1'").get()).toEqual({ n: 1 })
  })

  test('two finishers racing for one envelope write one completed event between them', async () => {
    sqlite.run("UPDATE envelopes SET status = 'sealing' WHERE id = 'e1'")
    const finish = (who: string) =>
      appendEvents(d1, env, [{ action: 'completed', actorKind: 'system', details: { who } }], {
        now: NOW + 5,
        whenStatus: ['sealing'],
        changes: [d1.prepare("UPDATE envelopes SET status = 'completed', completed_at = ? WHERE id = 'e1' AND status = 'sealing'").bind('2026-10-31T20:00:05Z')],
      })
    const results = await Promise.all([finish('a'), finish('b'), finish('c')])
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(results.filter((r) => !r.applied).every((r) => r.events.length === 0)).toBe(true)
    const rows = await readEvents(d1, 'e1')
    expect(rows.filter((r) => r.action === 'completed')).toHaveLength(1)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect((await verifyChain(rows)).ok).toBe(true)
    expect(sqlite.query("SELECT status FROM envelopes WHERE id = 'e1'").get()).toEqual({ status: 'completed' })
    // Later still, with the envelope already completed, nothing is written.
    expect((await finish('d')).applied).toBe(false)
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 3 })
  })

  test('with no status condition an append is always applied', async () => {
    expect((await appendEvents(d1, env, [{ action: 'reminded', actorKind: 'system' }], { now: NOW })).applied).toBe(true)
  })
})

describe('the database refuses to rewrite history', () => {
  beforeEach(async () => {
    await appendEvents(d1, env, [{ action: 'created', actorKind: 'operator' }, { action: 'sent', actorKind: 'operator' }], { now: NOW })
  })

  test('no event is ever updated, not even to the value it has', () => {
    expect(() => sqlite.run("UPDATE events SET ip = '1.2.3.4' WHERE seq = 1")).toThrow(/never changed/)
    expect(() => sqlite.run('UPDATE events SET seq = seq')).toThrow(/never changed/)
    expect(() => sqlite.run("UPDATE events SET hash = 'x'")).toThrow(/never changed/)
  })

  test('no event is deleted while its envelope stands', () => {
    expect(() => sqlite.run("DELETE FROM events WHERE seq = 2")).toThrow(/only when its envelope has been purged/)
    expect(() => sqlite.run('DELETE FROM events')).toThrow(/only when its envelope has been purged/)
    expect(() => sqlite.run("DELETE FROM envelopes WHERE id = 'e1'")).toThrow(/FOREIGN KEY/)
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 })
  })

  test('once a tombstone exists the events of that envelope (and only that one) can go', () => {
    sqlite.run(`INSERT INTO envelopes (id, client_id, kind, source_document_id, title, status, created_by, created_at, wrapped_key, key_version) VALUES ('e2', 'c1', 'document', 's1', 'Other', 'draft', 'j', '2026-10-31T00:00:00Z', 'w', 1)`)
    sqlite.run(`INSERT INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) VALUES ('e2', 'c1', 1, 'x', 'system', 'created', '{}', '${GENESIS}', 'h')`)
    sqlite.run("INSERT INTO tombstones (envelope_id, client_id, title, purged_at, reason) VALUES ('e1', 'c1', 'Engagement letter', '2026-10-31T21:00:00Z', 'retention')")
    sqlite.run("DELETE FROM events WHERE envelope_id = 'e1'")
    expect(sqlite.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
    expect(() => sqlite.run("DELETE FROM events WHERE envelope_id = 'e2'")).toThrow(/only when its envelope has been purged/)
    sqlite.run("DELETE FROM envelopes WHERE id = 'e1'")
    expect(sqlite.query('SELECT count(*) AS n FROM envelopes').get()).toEqual({ n: 1 })
  })

  test('a tombstone says only why and what is left to match a copy against', () => {
    expect(() => sqlite.run("INSERT INTO tombstones (envelope_id, client_id, title, purged_at, reason) VALUES ('e9', 'c1', 't', 'x', 'because')")).toThrow(/CHECK/)
  })
})

describe('a published form version never changes', () => {
  beforeEach(() => {
    sqlite.run(`INSERT INTO forms (id, client_id, title, created_at, updated_at) VALUES ('f1', 'c1', 'Intake', 'x', 'x')`)
    sqlite.run(`INSERT INTO form_versions (id, client_id, form_id, version, definition, definition_hash, created_at) VALUES ('v1', 'c1', 'f1', 1, '{"q":[]}', 'h1', 'x')`)
  })

  test('a draft may be edited and published; after that it is frozen', () => {
    sqlite.run(`UPDATE form_versions SET definition = '{"q":[1]}', definition_hash = 'h2' WHERE id = 'v1'`)
    sqlite.run(`UPDATE form_versions SET published_at = '2026-10-31T00:00:00Z' WHERE id = 'v1'`)
    expect(() => sqlite.run(`UPDATE form_versions SET definition = '{"q":[2]}' WHERE id = 'v1'`)).toThrow(/never changes/)
    expect(() => sqlite.run(`UPDATE form_versions SET published_at = NULL WHERE id = 'v1'`)).toThrow(/never changes/)
    expect(() => sqlite.run(`DELETE FROM form_versions WHERE id = 'v1'`)).toThrow(/never deleted/)
  })

  test('a published version cannot be swapped out with INSERT OR REPLACE either', () => {
    sqlite.run(`UPDATE form_versions SET published_at = '2026-10-31T00:00:00Z' WHERE id = 'v1'`)
    expect(() => sqlite.run(`INSERT OR REPLACE INTO form_versions (id, client_id, form_id, version, definition, definition_hash, created_at) VALUES ('v1', 'c1', 'f1', 1, '{"q":["forged"]}', 'hx', 'x')`)).toThrow(/never replaced/)
    expect(() => sqlite.run(`INSERT OR REPLACE INTO form_versions (id, client_id, form_id, version, definition, definition_hash, created_at) VALUES ('other', 'c1', 'f1', 1, '{"q":["forged"]}', 'hx', 'x')`)).toThrow(/never replaced/)
    expect(sqlite.query(`SELECT definition_hash FROM form_versions WHERE id = 'v1'`).get()).toEqual({ definition_hash: 'h1' })
  })

  test('a version number is taken once per form', () => {
    expect(() => sqlite.run(`INSERT INTO form_versions (id, client_id, form_id, version, definition, definition_hash, created_at) VALUES ('v1b', 'c1', 'f1', 1, '{}', 'h', 'x')`)).toThrow(/UNIQUE/)
  })
})

describe('the schema holds the line the code relies on', () => {
  test('a field\'s box lies on the page; recipients are numbered once per envelope; a form envelope names its version', () => {
    sqlite.run(`INSERT INTO recipients (id, envelope_id, client_id, role, name, email, position, created_at) VALUES ('r1', 'e1', 'c1', 'Client', 'A', 'a@b.test', 1, 'x')`)
    expect(() => sqlite.run(`INSERT INTO recipients (id, envelope_id, client_id, role, name, email, position, created_at) VALUES ('r2', 'e1', 'c1', 'CPA', 'B', 'b@b.test', 1, 'x')`)).toThrow(/UNIQUE/)
    const field = (x: number, w: number) => `INSERT INTO fields (id, envelope_id, client_id, recipient_id, type, page, x, y, width, height) VALUES ('f${x}${w}', 'e1', 'c1', 'r1', 'signature', 0, ${x}, 0.5, ${w}, 0.1)`
    sqlite.run(field(0.1, 0.3))
    expect(() => sqlite.run(field(0.9, 0.3))).toThrow(/CHECK/)
    expect(() => sqlite.run(field(-0.1, 0.3))).toThrow(/CHECK/)
    expect(() => sqlite.run(field(0.1, 0))).toThrow(/CHECK/)
    expect(() => sqlite.run(`INSERT INTO envelopes (id, client_id, kind, title, status, created_by, created_at, wrapped_key, key_version) VALUES ('e3', 'c1', 'form', 't', 'sent', 'j', 'x', 'w', 1)`)).toThrow(/CHECK/)
  })

  test('a client\'s slug, color, retention and copy list are checked by the table itself', () => {
    const insert = (set: string) => () =>
      sqlite.run(`INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at${set.split('|')[0]}) VALUES ('cx', 'ok-slug', 'D', 'L', 'a@b.test', 'x', 'x'${set.split('|')[1] ?? ''})`)
    expect(insert(", accent_color|, 'blue'")).toThrow(/CHECK/)
    expect(insert(", accent_color|, '#12345g'")).toThrow(/CHECK/)
    expect(insert(", accent_color|, '123456#'")).toThrow(/CHECK/)
    expect(insert(", accent_color|, '#AbCdEf'")).not.toThrow()
    expect(insert(', retention_years|, 0')).toThrow(/CHECK/)
    expect(insert(', copy_addresses|, \'{}\'')).toThrow(/CHECK/)
    expect(() => sqlite.run(`INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('cx', 'Bad Slug', 'D', 'L', 'a@b.test', 'x', 'x')`)).toThrow(/CHECK/)
    expect(() => sqlite.run(`INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('cx', 'ok', 'D', 'L', 'not-an-address', 'x', 'x')`)).toThrow(/CHECK/)
  })

  test('every table a client owns carries the client id, so a later client login is a scope and not a migration', () => {
    const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    const owned = ['forms', 'form_versions', 'source_documents', 'envelopes', 'recipients', 'fields', 'field_values', 'answers', 'uploads', 'signature_adoptions', 'events', 'mail', 'audit', 'tombstones']
    for (const t of owned) {
      expect(tables.map((x) => x.name), t).toContain(t)
      const cols = (sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      expect(cols, `${t}.client_id`).toContain('client_id')
    }
  })

  test('answers, field values and tokens are stored as ciphertext columns, never as plain ones', () => {
    const cols = (t: string) => (sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('answers')).toContain('value_enc')
    expect(cols('answers')).not.toContain('value')
    expect(cols('field_values')).toContain('value_enc')
    expect(cols('field_values')).not.toContain('value')
    expect(cols('recipients')).toContain('token_enc')
    expect(cols('recipients')).not.toContain('token')
  })
})

test('no LIKE or GLOB pattern in a migration is longer than D1 allows (50 bytes), which bun:sqlite does not enforce', () => {
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(new URL(file, dir), 'utf8')
    for (const m of sql.matchAll(/\b(?:NOT\s+)?(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)) expect(new TextEncoder().encode(m[1]!).length, `${file}: ${m[0]}`).toBeLessThanOrEqual(50)
  }
})

test('a browser string becomes a short description, and an unknown one says so', () => {
  expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
  expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('Chrome on macOS')
  expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge on Windows')
  expect(describeDevice('curl/8.4.0')).toBe('Unrecognized browser')
  expect(describeDevice(null)).toBeNull()
})
