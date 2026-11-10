// A Forms client row is a Client's signing settings. What this proves, over the real migrations: migration 0005 is additive and rewrites no row; the Clients part is
// the one writer of the copy of a Client's names (the seam it calls: list the linked rows, check a name, set it, audited with the actor); a row made before the Clients part existed is not linked on its own, signs exactly as it did, and
// keeps its id and everything it has signed when it is linked.
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createFormsClientNames } from '../src/client-names'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const seam = () => createFormsClientNames({ db: h.env().DB, now: () => Date.parse('2026-11-08T12:00:00Z') })

describe('migration 0005 is additive', () => {
  const dir = new URL('../migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  test('it is the fifth migration, and adds one nullable column and one index', () => {
    expect(files[4]).toBe('0005_client_number.sql')
    const sql = readFileSync(new URL(files[4]!, dir), 'utf8').replace(/--.*$/gm, '')
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1)
    expect(sql).toMatch(/ADD COLUMN client_number INTEGER CHECK/)
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|INSERT)\b/i)
    expect(sql).toMatch(/CREATE UNIQUE INDEX clients_client_number ON clients\(client_number\) WHERE client_number IS NOT NULL/)
  })

  test('rows and envelopes made before it keep every column and every id, and have no Client; the old code’s insert still works', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    for (const f of files.slice(0, 4)) db.run(readFileSync(new URL(f, dir), 'utf8'))
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c1', 'cc', 'C', 'C Inc', '#112233', 'a@b.example', 'now', 'now')")
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c2', 'dd', 'D', 'D Inc', '#445566', 'd@b.example', 'now', 'now')")
    db.run("INSERT INTO envelopes (id, client_id, kind, title, wrapped_key, key_version, created_by, created_at) VALUES ('e1', 'c1', 'document', 'Before', 'w', 1, 'x', 'now')")
    const before = { clients: db.query('SELECT * FROM clients ORDER BY id').all() as Record<string, unknown>[], envelopes: db.query('SELECT * FROM envelopes').all() }
    db.run(readFileSync(new URL(files[4]!, dir), 'utf8'))
    const after = db.query('SELECT * FROM clients ORDER BY id /* after */').all() as Record<string, unknown>[]
    expect(after.map(({ client_number, ...rest }) => rest)).toEqual(before.clients)
    expect(after.map((r) => r.client_number)).toEqual([null, null])
    expect(db.query('SELECT * FROM envelopes').all()).toEqual(before.envelopes)
    // The code before this change inserts a row without the column.
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c3', 'ee', 'E', 'E Inc', '#778899', 'e@b.example', 'now', 'now')")
    expect(db.query("SELECT client_number FROM clients WHERE id = 'c3'").get()).toEqual({ client_number: null })
  })

  test('a number is a whole number from 1 and belongs to one row; many rows may have none', () => {
    const db = new Database(':memory:')
    for (const f of files) db.run(readFileSync(new URL(f, dir), 'utf8'))
    const add = (id: string, number: number | null) => db.query("INSERT INTO clients (id, slug, display_name, legal_name, reply_to, client_number, created_at, updated_at) VALUES (?, ?, 'N', 'N Inc', 'a@b.example', ?, 'now', 'now')").run(id, `s-${id}`, number)
    add('a', null)
    add('b', null)
    add('c', 1001)
    expect(() => add('d', 1001)).toThrow(/UNIQUE/)
    expect(() => add('e', 0)).toThrow(/CHECK/)
    expect(() => add('f', -4)).toThrow(/CHECK/)
  })
})

describe('the seam the Clients part calls', () => {
  test('lists the rows linked to a Client with Forms’ copy of their names, and not the rows that are not', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing' })
    await h.env().DB.prepare("INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('old', 'old-co', 'Old Co', 'Old Co Inc', 'o@x.example', 't', 't')").run()
    const out = await seam().linked()
    expect(out).toEqual({ ok: true, value: [{ id: lane.id, number: lane.client_number, name: 'Pinecrest', legalName: 'Pinecrest Roofing', replyTo: 'office@pinecrest.example' }] })
  })

  test('writes the copy of the names of the linked row, audited with the actor, in the row’s history', async () => {
    const lane = await h.makeClient()
    const out = await seam().setNames(lane.client_number, { name: 'Pinecrest Tax', legalName: 'Pinecrest Roofing CPAs, Inc.' }, 'tessa@northfield.example')
    expect(out).toEqual({ ok: true, value: { changed: true } })
    expect(h.sql('SELECT display_name, legal_name FROM clients WHERE id = ?', lane.id)).toEqual([{ display_name: 'Pinecrest Tax', legal_name: 'Pinecrest Roofing CPAs, Inc.' }])
    const log = (await h.tessa('GET', `/admin/api/audit?client=${lane.id}`)).body as any[]
    expect(log[0]).toMatchObject({ actor: 'tessa@northfield.example', action: 'client-names' })
    expect(log[0].before.display_name).toBe('Pinecrest')
    expect(log[0].after.display_name).toBe('Pinecrest Tax')
  })

  test('the same names again change nothing and write no audit row; a Client with no legal name leaves Forms’ as it is', async () => {
    const lane = await h.makeClient()
    await seam().setNames(lane.client_number, { name: 'Pinecrest Tax', legalName: null }, 'tessa@northfield.example')
    expect(h.sql('SELECT display_name, legal_name FROM clients WHERE id = ?', lane.id)).toEqual([{ display_name: 'Pinecrest Tax', legal_name: 'Pinecrest Roofing, CPAs' }])
    const again = await seam().setNames(lane.client_number, { name: 'Pinecrest Tax', legalName: null }, 'clients:repair')
    expect(again).toEqual({ ok: true, value: { changed: false } })
    expect(h.sql('SELECT count(*) AS n FROM audit WHERE action = ?', 'client-names')[0]).toEqual({ n: 1 })
  })

  test('a name is measured in characters, as the Clients part and the column count it, not in UTF-16 units: the longest name a Client may have is one Forms keeps', async () => {
    const lane = await h.makeClient()
    const longest = { name: '😀'.repeat(80), legalName: '😀'.repeat(120) }
    expect(await seam().check(longest)).toEqual({ ok: true, value: null })
    expect(await seam().setNames(lane.client_number, longest, 'clients:repair')).toEqual({ ok: true, value: { changed: true } })
    expect(h.sql('SELECT length(display_name) AS a, length(legal_name) AS b FROM clients WHERE id = ?', lane.id)).toEqual([{ a: 80, b: 120 }])
    expect(await seam().check({ name: '😀'.repeat(81), legalName: null })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await seam().check({ name: 'Fine', legalName: '😀'.repeat(121) })).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('a number no row is linked to is not found, and a name Forms cannot send mail under is refused whole, before anything is written', async () => {
    const lane = await h.makeClient()
    expect(await seam().setNames(4242, { name: 'Nobody', legalName: null }, 'x')).toMatchObject({ ok: false, reason: 'not-found' })
    for (const name of ['Lane, Co', 'Lane <office@lane.example>', 'Lane\r\nBcc: x@y.example', 'x'.repeat(81), '']) {
      const out = await seam().setNames(lane.client_number, { name, legalName: 'Fine Inc' }, 'x')
      expect(out, name).toMatchObject({ ok: false, reason: 'bad-request' })
      expect(await seam().check({ name, legalName: null }), name).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(await seam().setNames(lane.client_number, { name: 'Fine', legalName: 'x'.repeat(121) }, 'x')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.sql('SELECT display_name, legal_name FROM clients WHERE id = ?', lane.id)).toEqual([{ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs' }])
    expect(await seam().check({ name: "Joe's Plumbing & Sons", legalName: 'Joe Smith LLC' })).toEqual({ ok: true, value: null })
  })
})

describe('a row made before the Clients part existed', () => {
  test('sends and signs exactly as before, linked or not, under the same id', async () => {
    const id = 'legacy-0000-0000-0000-000000000001'
    await h.env().DB.prepare("INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES (?, 'legacy-co', 'Legacy Co', 'Legacy Company Inc', 'old@x.example', 't', 't')").bind(id).run()
    const sent = await k.sent({ client: { id }, recipients: [ALICE, BOB] })
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.sql('SELECT client_id FROM envelopes WHERE id = ?', sent.id)).toEqual([{ client_id: id }])
    const mail = h.outbox.find((m) => m.to.email === ALICE.email)!
    expect(mail.from.name).toContain('Legacy Co')
    // Linking it changes its names to the Client's and nothing else: the envelope still points at the same id.
    const target = h.clients().add({ name: 'Legacy Company', legalName: 'Legacy Company Inc' })
    expect((await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: target.number })).status).toBe(200)
    expect(h.sql('SELECT client_id FROM envelopes WHERE id = ?', sent.id)).toEqual([{ client_id: id }])
    expect(h.sql('SELECT id, client_number, display_name FROM clients')).toEqual([{ id, client_number: target.number, display_name: 'Legacy Company' }])
  })
})
