// The names an envelope was sent under (migration 0006). A client row's name and legal name are a copy of the Client's, rewritten when the Client is
// renamed; the consent, its terms and the certificate of completion print them. An envelope keeps the two names it was sent under and prints those, so a finished envelope's web certificate and its sealed PDF agree after a rename, and
// nothing a signer was shown changes under them. No event carries the names, so no hash moves.
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { PDF } from '@libpdf/core'
import { createFormsClientNames } from '../src/client-names'
import { appendEvents, checkChain, readEvents, verifyChain } from '../src/events'
import { localD1 } from './local-d1'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const seam = () => createFormsClientNames({ db: h.env().DB, now: () => Date.parse('2026-11-08T12:00:00Z') })
const rename = async (number: number, name: string, legalName: string) => {
  const out = await seam().setNames(number, { name, legalName }, 'tessa@northfield.example')
  expect(out.ok).toBe(true)
}

describe('an envelope prints the names it was sent under', () => {
  test('send keeps the names in the same batch as the send, and writes them into no event', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs' })
    const draft = await k.draft({ client: lane })
    expect(h.sql('SELECT client_display_name, client_legal_name FROM envelopes WHERE id = ?', draft.id)).toEqual([{ client_display_name: null, client_legal_name: null }])
    await k.send(draft.id)
    expect(h.sql('SELECT client_display_name, client_legal_name FROM envelopes WHERE id = ?', draft.id)).toEqual([{ client_display_name: 'Pinecrest', client_legal_name: 'Pinecrest Roofing, CPAs' }])
    // The title is the sample's own and names the business; the legal name is in no event.
    for (const e of k.events(draft.id)) expect(e.details).not.toContain('Pinecrest Roofing')
    expect(Object.keys(JSON.parse(k.events(draft.id).find((e) => e.action === 'sent')!.details)).sort()).toEqual(['draft_fingerprint', 'expires_at', 'notified', 'order', 'recipients'])
  })

  test('a rename after the send changes neither the consent a signer is shown nor its terms PDF, and the hash they agree to is the one of what they saw', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs' })
    const sent = await k.sent({ client: lane })
    const alice = k.as(k.tokenFor(ALICE.email))
    const before = (await alice('GET', '')).body.consent.paragraphs as string[]
    expect(before.join('\n')).toContain('Pinecrest Roofing, CPAs')
    await rename(lane.client_number, 'Lane Tax', 'Lane Tax Advisors Inc.')
    const after = (await alice('GET', '')).body.consent.paragraphs as string[]
    expect(after).toEqual(before)
    const terms = await alice('GET', '/terms.pdf')
    expect(terms.status).toBe(200)
    const text = (await PDF.load(new Uint8Array(await terms.res.arrayBuffer()))).getPages().map((p) => p.extractText().text).join('\n')
    expect(text).toContain('Pinecrest Roofing, CPAs')
    expect(text).not.toContain('Lane Tax')
    expect((await alice('POST', '/consent')).status).toBe(200)
    const consented = JSON.parse(k.events(sent.id).find((e) => e.action === 'consented')!.details)
    expect(consented.text_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a finished envelope’s web certificate and its sealed PDF both name the business as it was sent, whenever it was renamed', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs' })
    const { id } = await k.sent({ client: lane })
    await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')
    // Renamed while the second signer has yet to sign: the seal is made after it.
    await rename(lane.client_number, 'Lane Tax', 'Lane Tax Advisors Inc.')
    await k.signAs(k.tokenFor(BOB.email), 'Bob Preparer')
    expect(h.sql('SELECT status FROM envelopes WHERE id = ?', id)).toEqual([{ status: 'completed' }])
    await rename(lane.client_number, 'Lane Final', 'Lane Final Group LLC')

    const web = (await h.tessa('GET', `/admin/api/envelopes/${id}/certificate`)).body
    expect(web.client).toEqual({ name: 'Pinecrest', legalName: 'Pinecrest Roofing, CPAs' })
    expect(web.consents.map((c: { note: string | null }) => c.note)).toEqual([null])
    const pdf = await k.text(k.attachment(ALICE.email))
    expect(pdf).toContain('Pinecrest (Pinecrest Roofing, CPAs)')
    expect(pdf).not.toContain('Lane Tax')
    expect(pdf).not.toContain('Lane Final')
    // Bob's own link shows the same certificate.
    const theirs = await k.as(k.tokenFor(BOB.email))('GET', '/certificate')
    expect(theirs.body.client).toEqual(web.client)
  })

  test('an envelope sent before the names were kept prints the row as it is now, and the certificate says the business was renamed since a signer agreed', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs' })
    const { id } = await k.sent({ client: lane })
    await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')
    // Made the way an envelope sent by the code before migration 0006 is: no names on it.
    h.sql('UPDATE envelopes SET client_display_name = NULL, client_legal_name = NULL WHERE id = ?', id)
    await rename(lane.client_number, 'Lane Tax', 'Lane Tax Advisors Inc.')
    await k.signAs(k.tokenFor(BOB.email), 'Bob Preparer')
    const web = (await h.tessa('GET', `/admin/api/envelopes/${id}/certificate`)).body
    expect(web.client).toEqual({ name: 'Lane Tax', legalName: 'Lane Tax Advisors Inc.' })
    expect(web.consents[0].note).toContain('name or address has changed since a signer agreed')
    const pdf = await k.text(k.attachment(ALICE.email))
    expect(pdf).toContain('Lane Tax (Lane Tax Advisors Inc.)')
  })
})

describe('migration 0006', () => {
  const dir = new URL('../migrations/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const apply = (db: Database, names: string[]) => names.forEach((f) => db.run(readFileSync(new URL(f, dir), 'utf8')))

  test('it is the sixth migration, and only adds two nullable columns to envelopes', () => {
    expect(files[5]).toBe('0006_envelope_client_names.sql')
    const sql = readFileSync(new URL(files[5]!, dir), 'utf8').replace(/--.*$/gm, '')
    expect(sql.match(/ALTER TABLE envelopes ADD COLUMN/g)).toHaveLength(2)
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|INSERT|CREATE)\b/i)
  })

  test('a store at migration 0005 with events written still verifies its chain, before and after 0006 is applied, and no row changes', async () => {
    const db = new Database(':memory:', { strict: true })
    db.run('PRAGMA foreign_keys = ON')
    apply(db, files.slice(0, 5))
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c1', 'cc', 'C', 'C Inc', '#112233', 'a@b.example', 'now', 'now')")
    db.run("INSERT INTO envelopes (id, client_id, kind, title, wrapped_key, key_version, created_by, created_at) VALUES ('e1', 'c1', 'document', 'Before', 'w', 1, 'x', 'now')")
    const d = localD1(db)
    const envelope = { id: 'e1', client_id: 'c1' }
    const operator = { actorKind: 'operator' as const, actorEmail: 'tessa@northfield.example', actorName: 'Tessa' }
    await appendEvents(d, envelope, [{ ...operator, action: 'created' }], { now: Date.parse('2026-11-01T00:00:00Z') })
    await appendEvents(d, envelope, [{ ...operator, action: 'sent', details: { recipients: 2 } }], { now: Date.parse('2026-11-01T00:01:00Z') })
    const written = await readEvents(d, 'e1')
    expect(await verifyChain(written)).toMatchObject({ ok: true, count: 2 })

    apply(db, files.slice(5))
    expect(await readEvents(d, 'e1')).toEqual(written)
    expect(await checkChain(d, 'e1')).toMatchObject({ ok: true, count: 2 })
    // The envelope made before has no names kept, and writing another event after the migration extends the same chain.
    expect(db.query("SELECT client_display_name, client_legal_name FROM envelopes WHERE id = 'e1'").get()).toEqual({ client_display_name: null, client_legal_name: null })
    await appendEvents(d, envelope, [{ ...operator, action: 'cancelled' }], { now: Date.parse('2026-11-01T00:02:00Z') })
    expect(await checkChain(d, 'e1')).toMatchObject({ ok: true, count: 3 })
  })

  test('the names are kept together or not at all, within the lengths a client row allows', () => {
    const db = new Database(':memory:', { strict: true })
    apply(db, files)
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c1', 'cc', 'C', 'C Inc', '#112233', 'a@b.example', 'now', 'now')")
    db.run("INSERT INTO envelopes (id, client_id, kind, title, wrapped_key, key_version, created_by, created_at) VALUES ('e1', 'c1', 'document', 'T', 'w', 1, 'x', 'now')")
    expect(() => db.run("UPDATE envelopes SET client_display_name = 'C' WHERE id = 'e1'")).toThrow(/CHECK/)
    expect(() => db.run("UPDATE envelopes SET client_display_name = 'C', client_legal_name = 'C Inc' WHERE id = 'e1'")).not.toThrow()
    expect(() => db.run(`UPDATE envelopes SET client_display_name = '${'x'.repeat(81)}', client_legal_name = 'C Inc' WHERE id = 'e1'`)).toThrow(/CHECK/)
  })
})
