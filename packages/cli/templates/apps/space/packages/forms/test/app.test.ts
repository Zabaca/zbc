// The Worker's HTTP API, driven from outside the way Access and a browser would: the doors first (who may call what),
// then clients and their logos, the sealed sample, and the operator's checks. Real router, real migration, real PDF
// engine; Access stood in for by signed assertions, R2 by an in-memory bucket that honours the customer key.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { fixtureBytes } from '../scripts/fixtures'
import { AUD } from './keys'
import { createApp } from '../src/app'
import { harness, TESSA } from './harness'
import { solidPng } from './png'
import { hasPoppler, pdfsig } from './render'

const h = harness()
beforeEach(() => h.reset())

describe('the admin door', () => {
  test('refuses a request with no assertion, and a forged, expired or foreign one', async () => {
    expect((await h.call(null, 'GET', '/admin/api/clients')).status).toBe(401)
    expect((await h.call(null, 'GET', '/admin/api/me')).status).toBe(401)
    const forged = h.request({ 'cf-access-jwt-assertion': 'a.b.c' }, 'GET', '/admin/api/clients')
    expect((await forged).status).toBe(401)
    expect((await h.call({ ...TESSA, exp: 1 }, 'GET', '/admin/api/clients')).status).toBe(401)
    const foreign = await h.sign({ ...TESSA }, { aud: 'b'.repeat(64) })
    expect((await h.request({ 'cf-access-jwt-assertion': foreign }, 'GET', '/admin/api/clients')).status).toBe(401)
  })

  test('refuses an address it does not know and a service token, though Access signed them', async () => {
    expect((await h.call({ email: 'abel@abelcpa.example' }, 'GET', '/admin/api/clients')).status).toBe(403)
    expect((await h.call({ common_name: 'abc.access' }, 'GET', '/admin/api/clients')).status).toBe(403)
    expect((await h.call({ email: 'tessa@northfield.example', common_name: 'abc.access' }, 'GET', '/admin/api/clients')).status).toBe(403)
  })

  test('admits Tessa', async () => {
    const r = await h.tessa('GET', '/admin/api/me')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      email: 'tessa@northfield.example',
      name: 'Tessa',
      actor: 'tessa@northfield.example',
      owner: true,
      company: 'Northfield Works',
    })
  })

  test('with no audience configured it refuses everyone, Tessa\'s real assertion included', async () => {
    const strict = harness({ CF_ACCESS_AUD: '' })
    expect((await strict.tessa('GET', '/admin/api/me')).status).toBe(401)
  })

  test('inside the space’s Worker the operator API verifies nothing itself: it asks the one check’s answer, and no answer is a 401', async () => {
    const operator = { email: 'tessa@northfield.example', name: 'Tessa', actor: 'tessa@northfield.example', owner: true }
    let named: typeof operator | null = operator
    const app = createApp({ fetch: () => Promise.reject(new Error('the key server must not be asked')), now: () => Date.now(), install: h.install, named: () => named })
    const ask = () => app.fetch(new Request('https://space.northfield.example/admin/api/me'), h.env())
    const ok = await ask()
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ actor: 'tessa@northfield.example' })
    named = null
    expect((await ask()).status).toBe(401)
  })

  test('the development bypass works only on localhost and only when switched on', async () => {
    const dev = harness({ ALLOW_UNAUTHENTICATED: '1' })
    const local = await dev.call(null, 'GET', '/admin/api/me', undefined, { host: 'localhost:4836' })
    expect(local.status).toBe(200)
    expect(local.body.actor).toBe('local@dev')
    expect((await dev.call(null, 'GET', '/admin/api/me', undefined, { host: 'space.northfield.example' })).status).toBe(401)
    expect((await h.call(null, 'GET', '/admin/api/me', undefined, { host: 'localhost:4836' })).status).toBe(401)
  })

  test('a write from a page on another site is refused', async () => {
    const x = h.clients().add({ name: 'X', legalName: 'X Inc' })
    const body = { slug: 'x1', client_number: x.number, reply_to: 'a@b.test' }
    const cross = await h.call(TESSA, 'POST', '/admin/api/clients', body, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(cross.status).toBe(403)
    const origin = await h.call(TESSA, 'POST', '/admin/api/clients', body, { headers: { origin: 'https://evil.example' } })
    expect(origin.status).toBe(403)
    expect(h.sql('SELECT count(*) AS n FROM clients')[0]!.n).toBe(0)
    const same = await h.call(TESSA, 'POST', '/admin/api/clients', body, { headers: { origin: 'https://space.northfield.example', 'sec-fetch-site': 'same-origin' } })
    expect(same.status).toBe(201)
  })

  test('another spelling of the path never reaches the data without an assertion', async () => {
    const client = await h.makeClient()
    const spellings = ['/%61dmin/api/clients', '/admin/api/%63lients', '//admin/api/clients', '/admin/./api/clients', '/ADMIN/api/clients', '/admin%2Fapi%2Fclients', '/admin/api/clients/', `/admin/api/clients/${client.id}`, '/admin/api/clients%00', '/admin/api/clients;x=1', '/admin/api/clients?a=%2e%2e']
    for (const path of spellings) {
      const res = await h.request({}, 'GET', path)
      const text = await res.text()
      expect(text, path).not.toContain('Pinecrest')
      expect(text, path).not.toContain(client.id)
      expect(res.status, path).not.toBe(200)
    }
  })
})

describe('the public side', () => {
  test('answers with no assertion and a plain 404 for what is not there', async () => {
    const r = await h.call(null, 'GET', '/s/api/nothing-here')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Route not found' })
  })

  test('refuses past the rate limit', async () => {
    const limited = harness({ PUBLIC_LIMIT: { limit: async () => ({ success: false }) } })
    const r = await limited.call(null, 'GET', '/s/api/logo/anything')
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBe('60')
    // The rate limit is the public side's: the admin API has its own door.
    expect((await limited.tessa('GET', '/admin/api/me')).status).toBe(200)
  })

  test('the limiter is keyed by the caller\'s address', async () => {
    const keys: string[] = []
    const spy = harness({ PUBLIC_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: true }) } })
    await spy.call(null, 'GET', '/s/api/logo/x', undefined, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
    expect(keys).toEqual(['203.0.113.9'])
  })
})

describe('clients: a row is a Client’s signing settings', () => {
  const lane = () => h.clients().add({ name: "Pinecrest's Tax", legalName: 'Pinecrest Roofing, CPAs' })

  test('signing is set up for a Client by its number: the names are the Client’s, the settings default, and the audit row is written with it', async () => {
    const client = lane()
    const r = await h.tessa('POST', '/admin/api/clients', { slug: 'pinecrest', client_number: client.number, reply_to: ' Office@Pinecrest.example ', copy_addresses: ['Books@pinecrest.example', 'books@pinecrest.example'] })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ slug: 'pinecrest', client_number: client.number, display_name: "Pinecrest's Tax", legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', copy_addresses: ['books@pinecrest.example'], accent_color: '#1f4e79', time_zone: 'America/Los_Angeles', retention_years: 7, has_logo: false })
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/)
    const audit = h.sql<{ actor: string; action: string; entity: string; client_id: string }>('SELECT * FROM audit')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: 'tessa@northfield.example', action: 'create', entity: 'clients', client_id: r.body.id })
  })

  test('a name in the request is refused with the sentence that says where names are changed, on create and on edit, and nothing is written', async () => {
    const client = lane()
    for (const names of [{ display_name: 'Other' }, { legal_name: 'Other Inc' }]) {
      const r = await h.tessa('POST', '/admin/api/clients', { slug: 'pinecrest', client_number: client.number, reply_to: 'office@lane.example', ...names })
      expect(r.status, JSON.stringify(names)).toBe(400)
      expect(r.body.error).toContain('Settings')
    }
    expect(h.sql('SELECT count(*) AS n FROM clients')[0]!.n).toBe(0)
    const made = await h.makeClient()
    for (const names of [{ display_name: 'Renamed' }, { legal_name: 'Renamed Inc' }]) {
      const r = await h.tessa('PATCH', `/admin/api/clients/${made.id}`, names)
      expect(r.status, JSON.stringify(names)).toBe(400)
      expect(r.body.error).toContain('Settings')
    }
    expect(h.sql('SELECT display_name FROM clients')[0]!.display_name).toBe('Pinecrest')
    expect(h.sql('SELECT count(*) AS n FROM audit')[0]!.n).toBe(1)
  })

  test('refuses what is plainly wrong in the settings, and writes nothing', async () => {
    const client = lane()
    const bad: Record<string, unknown>[] = [
      { reply_to: 'not an address' },
      { reply_to: 'a@b' },
      { reply_to: 'a@b.test, c@d.test' },
      { accent_color: 'red' },
      { accent_color: '#12345' },
      { time_zone: 'Mars/Olympus' },
      { retention_years: 0 },
      { retention_years: 7.5 },
      { retention_years: 51 },
      { copy_addresses: 'books@pinecrest.example' },
      { copy_addresses: ['nope'] },
      { slug: 'Has Caps' },
      { slug: 'a' },
      { slug: '-lead' },
      { client_number: 0 },
      { client_number: 1.5 },
      { client_number: '1001' },
      { client_number: undefined },
    ]
    for (const override of bad) {
      const r = await h.tessa('POST', '/admin/api/clients', { slug: 'pinecrest', client_number: client.number, reply_to: 'office@lane.example', ...override })
      expect(r.status, JSON.stringify(override)).toBe(400)
    }
    expect(h.sql('SELECT count(*) AS n FROM clients')[0]!.n).toBe(0)
    expect(h.sql('SELECT count(*) AS n FROM audit')[0]!.n).toBe(0)
  })

  test('a Client that does not exist, is archived, has no legal name, or has a name Forms cannot send mail under is refused with a sentence', async () => {
    const body = (n: number) => ({ slug: 'x-co', client_number: n, reply_to: 'office@x.example' })
    expect((await h.tessa('POST', '/admin/api/clients', body(999))).status).toBe(404)
    const shelved = h.clients().add({ name: 'Old Co', legalName: 'Old Co Inc', archived: true })
    const refusedArchived = await h.tessa('POST', '/admin/api/clients', body(shelved.number))
    expect(refusedArchived.status).toBe(409)
    expect(refusedArchived.body.error).toContain('archived')
    const bare = h.clients().add({ name: 'Bare Co' })
    const noLegal = await h.tessa('POST', '/admin/api/clients', body(bare.number))
    expect(noLegal.status).toBe(400)
    expect(noLegal.body.error).toContain('legal name')
    const comma = h.clients().add({ name: 'Smith, Jones & Co', legalName: 'Smith Jones LLP' })
    const refusedName = await h.tessa('POST', '/admin/api/clients', body(comma.number))
    expect(refusedName.status).toBe(400)
    expect(refusedName.body.error).toContain('The name may not contain')
    expect(h.sql('SELECT count(*) AS n FROM clients')[0]!.n).toBe(0)
  })

  test('a Client has one set of signing settings, and a slug is taken once; a failed create leaves no audit row', async () => {
    const first = await h.makeClient()
    const again = await h.tessa('POST', '/admin/api/clients', { slug: 'other-slug', client_number: first.client_number, reply_to: 'a@b.test' })
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('already has signing settings')
    const other = lane()
    const sameSlug = await h.tessa('POST', '/admin/api/clients', { slug: 'pinecrest', client_number: other.number, reply_to: 'a@b.test' })
    expect(sameSlug.status).toBe(409)
    expect(h.sql('SELECT count(*) AS n FROM audit')[0]!.n).toBe(1)
  })

  test('without the Clients part to read, setting up signing says so and writes nothing', async () => {
    const bare = harness({ CLIENTS_READ: undefined })
    const r = await bare.tessa('POST', '/admin/api/clients', { slug: 'x-co', client_number: 1001, reply_to: 'a@b.test' })
    expect(r.status).toBe(503)
    expect(r.body.error).toContain('Clients list')
    h.clients().down = true
    const down = await h.tessa('POST', '/admin/api/clients', { slug: 'x-co', client_number: 1001, reply_to: 'a@b.test' })
    expect(down.status).toBe(503)
  })

  test('required fields are required, and an unknown field is refused, not dropped', async () => {
    const client = lane()
    expect((await h.tessa('POST', '/admin/api/clients', { slug: 'abc', client_number: client.number })).status).toBe(400)
    const c = await h.makeClient()
    for (const field of ['slug', 'id', 'logo_key', 'created_at', 'client_number', 'nonsense']) {
      const r = await h.tessa('PATCH', `/admin/api/clients/${c.id}`, { [field]: 'x' })
      expect(r.status, field).toBe(400)
    }
  })

  test('an edit records before and after; saving the same values again writes nothing', async () => {
    const c = await h.makeClient()
    const r = await h.tessa('PATCH', `/admin/api/clients/${c.id}`, { retention_years: 10, accent_color: '#AA0000' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ retention_years: 10, accent_color: '#aa0000' })
    const log = (await h.tessa('GET', `/admin/api/audit?client=${c.id}`)).body as any[]
    expect(log.map((a) => a.action)).toEqual(['update', 'create'])
    expect(log[0].before.retention_years).toBe(7)
    expect(log[0].after.retention_years).toBe(10)
    await h.tessa('PATCH', `/admin/api/clients/${c.id}`, { retention_years: 10 })
    expect(h.sql('SELECT count(*) AS n FROM audit')[0]!.n).toBe(2)
  })

  test('lists clients by name with their Client’s number and whether it is archived, and 404s on an unknown one', async () => {
    const zeta = await h.makeClient({ slug: 'zeta', display_name: 'Zeta Plumbing' })
    const alpha = await h.makeClient({ slug: 'alpha', display_name: 'alpha Roofing' })
    h.clients().change(zeta.client_number, { archived: true })
    const list = (await h.tessa('GET', '/admin/api/clients')).body as { display_name: string; client_number: number; client_archived: boolean | null }[]
    expect(list.map((c) => [c.display_name, c.client_number, c.client_archived])).toEqual([
      ['alpha Roofing', alpha.client_number, false],
      ['Zeta Plumbing', zeta.client_number, true],
    ])
    expect((await h.tessa('GET', '/admin/api/clients/nope')).status).toBe(404)
    expect((await h.tessa('PATCH', '/admin/api/clients/nope', { retention_years: 3 })).status).toBe(404)
  })

  test('the Clients with no signing settings are the active ones no row is linked to', async () => {
    await h.makeClient({ display_name: 'Set Up Co' })
    const open = h.clients().add({ name: 'Open Co', legalName: null })
    h.clients().add({ name: 'Shelved Co', archived: true })
    const out = (await h.tessa('GET', '/admin/api/clients-not-set-up')).body
    expect(out).toEqual({ available: true, clients: [{ number: open.number, name: 'Open Co', legalName: null }] })
    const none = await harness({ CLIENTS_READ: undefined }).tessa('GET', '/admin/api/clients-not-set-up')
    expect(none.body).toEqual({ available: false, clients: [] })
  })
})

describe('reading the Clients list is the owner’s', () => {
  const member = { email: 'dana@northfield.example', name: 'Dana', actor: 'dana@northfield.example', owner: false }
  const asMember = () => createApp({ fetch: () => Promise.reject(new Error('the key server must not be asked')), now: () => Date.now(), install: h.install, named: () => member })
  const ask = (app: ReturnType<typeof createApp>, method: string, path: string, json?: unknown) =>
    app.fetch(new Request(`https://space.northfield.example${path}`, { method, ...(json !== undefined && { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }) }), h.env())

  test('the list of Clients with no signing settings, setting up signing and linking are refused to an operator who is not the owner, and nothing is written', async () => {
    const set = await h.makeClient()
    const open = h.clients().add({ name: 'Open Co', legalName: 'Open Company Inc' })
    const app = asMember()
    const before = h.sql('SELECT count(*) AS n FROM clients')[0]
    const list = await ask(app, 'GET', '/admin/api/clients-not-set-up')
    expect(list.status).toBe(403)
    expect(await list.json()).toEqual({ error: 'Only the owner can read the Clients list.' })
    expect((await ask(app, 'POST', '/admin/api/clients', { client_number: open.number, slug: 'open-co', reply_to: 'office@open.example' })).status).toBe(403)
    expect((await ask(app, 'PUT', `/admin/api/clients/${set.id}/link`, { client_number: open.number })).status).toBe(403)
    expect(h.sql('SELECT count(*) AS n FROM clients')[0]).toEqual(before)
    // The owner still reads and sets up.
    expect((await h.tessa('GET', '/admin/api/clients-not-set-up')).status).toBe(200)
  })

  test('whether a Client is archived is joined for the owner, on the list and on one row, and is unknown (null) for anyone else, who still reads the signing settings', async () => {
    const lane = await h.makeClient({ display_name: 'Pinecrest' })
    h.clients().change(lane.client_number, { archived: true })
    expect((await h.tessa('GET', '/admin/api/clients')).body[0].client_archived).toBe(true)
    expect((await h.tessa('GET', `/admin/api/clients/${lane.id}`)).body).toMatchObject({ id: lane.id, client_number: lane.client_number, client_archived: true })
    h.clients().change(lane.client_number, { archived: false })
    expect((await h.tessa('GET', `/admin/api/clients/${lane.id}`)).body.client_archived).toBe(false)
    const app = asMember()
    const theirs = (await (await ask(app, 'GET', '/admin/api/clients')).json()) as any[]
    expect(theirs[0]).toMatchObject({ id: lane.id, display_name: 'Pinecrest', client_archived: null })
    expect(await (await ask(app, 'GET', `/admin/api/clients/${lane.id}`)).json()).toMatchObject({ id: lane.id, client_archived: null })
  })
})

describe('a row made before the Clients part existed', () => {
  /** What the database once held: a row with a text id, names, branding, and no Client number. */
  async function legacy(over: Record<string, unknown> = {}) {
    const id = crypto.randomUUID()
    await h
      .env()
      .DB.prepare("INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES (?, ?, ?, ?, 'old@x.example', 'then', 'then')")
      .bind(id, (over.slug as string) ?? 'old-co', (over.display_name as string) ?? 'Old Co', (over.legal_name as string) ?? 'Old Company Inc')
      .run()
    return id
  }

  test('lists with no number, signs as it did, and can be edited in its settings', async () => {
    const id = await legacy()
    const row = (await h.tessa('GET', '/admin/api/clients')).body[0]
    expect(row).toMatchObject({ id, client_number: null, client_archived: null, display_name: 'Old Co' })
    expect((await h.tessa('PATCH', `/admin/api/clients/${id}`, { retention_years: 9 })).status).toBe(200)
  })

  test('is linked by hand to a Client the operator picks: it takes the Client’s names, keeps its id, and nothing is matched by name', async () => {
    const id = await legacy({ display_name: 'Old Co' })
    const same = h.clients().add({ name: 'Old Co', legalName: 'Old Company Inc' })
    // A Client with the very same name is not linked on its own.
    expect((await h.tessa('GET', '/admin/api/clients')).body[0].client_number).toBeNull()
    const target = h.clients().add({ name: 'New Name Co', legalName: 'New Name Company LLC' })
    const linked = await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: target.number })
    expect(linked.status).toBe(200)
    expect(linked.body).toMatchObject({ id, client_number: target.number, display_name: 'New Name Co', legal_name: 'New Name Company LLC' })
    const log = (await h.tessa('GET', `/admin/api/audit?client=${id}`)).body as any[]
    expect(log[0]).toMatchObject({ action: 'link', actor: 'tessa@northfield.example' })
    expect(log[0].before.client_number).toBeNull()
    expect(same.number).not.toBe(target.number)
  })

  test('is not linked twice, to a Client that has signing settings, to an archived Client or to one that does not exist', async () => {
    const id = await legacy()
    const taken = await h.makeClient({ slug: 'taken-co', display_name: 'Taken Co' })
    const refusals: [number, number][] = [
      [taken.client_number, 409],
      [h.clients().add({ name: 'Old', archived: true }).number, 409],
      [9999, 404],
    ]
    for (const [n, status] of refusals) expect((await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: n })).status).toBe(status)
    expect((await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: 0 })).status).toBe(400)
    expect((await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: taken.client_number, display_name: 'x' })).status).toBe(400)
    expect((await h.tessa('PUT', '/admin/api/clients/nope/link', { client_number: 1001 })).status).toBe(404)
    const open = h.clients().add({ name: 'Open Co', legalName: 'Open Co Inc' })
    expect((await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: open.number })).status).toBe(200)
    const again = await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: open.number })
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('already linked')
  })

  test('keeps its legal name when the Client has none', async () => {
    const id = await legacy()
    const bare = h.clients().add({ name: 'Bare Co' })
    const r = await h.tessa('PUT', `/admin/api/clients/${id}/link`, { client_number: bare.number })
    expect(r.body).toMatchObject({ display_name: 'Bare Co', legal_name: 'Old Company Inc' })
  })
})

describe('logos', () => {
  async function upload(id: string, bytes: Uint8Array | string) {
    const token = await h.sign({ ...TESSA })
    return h.request({ 'cf-access-jwt-assertion': token }, 'PUT', `/admin/api/clients/${id}/logo`, bytes as BodyInit)
  }

  test('a PNG is stored without a key, shown to the admin as a flag and served to anyone from the public route', async () => {
    const c = await h.makeClient()
    const logo = solidPng(60, 30, [200, 0, 0])
    const res = await upload(c.id, logo)
    expect(res.status).toBe(200)
    const view = (await res.json()) as any
    expect(view).toMatchObject({ has_logo: true, logo_type: 'image/png' })
    expect(view.logo_key).toBeUndefined()
    const stored = [...h.files().objects.entries()].filter(([k]) => k.startsWith('logos/'))
    expect(stored).toHaveLength(1)
    expect(stored[0]![1].key).toBeUndefined()
    const pub = await h.request({}, 'GET', `/s/api/logo/${c.id}`)
    expect(pub.status).toBe(200)
    expect(pub.headers.get('content-type')).toBe('image/png')
    expect(pub.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await pub.arrayBuffer()).equals(Buffer.from(logo))).toBe(true)
  })

  test('a replacement deletes the old object', async () => {
    const c = await h.makeClient()
    await upload(c.id, solidPng(10, 10, [1, 2, 3]))
    await upload(c.id, solidPng(12, 12, [4, 5, 6]))
    expect([...h.files().objects.keys()].filter((k) => k.startsWith('logos/'))).toHaveLength(1)
  })

  test('refuses what is not a PNG or a JPEG whatever it claims, and anything over 256 KB', async () => {
    const c = await h.makeClient()
    expect((await upload(c.id, 'GIF89a not a png')).status).toBe(400)
    expect((await upload(c.id, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).status).toBe(400)
    const big = new Uint8Array(300 * 1024)
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect((await upload(c.id, big)).status).toBe(400)
    expect((await upload(c.id, new Uint8Array(0))).status).toBe(400)
    expect(h.files().objects.size).toBe(0)
  })

  test('the public route 404s for a client with no logo and for no client at all', async () => {
    const c = await h.makeClient()
    expect((await h.request({}, 'GET', `/s/api/logo/${c.id}`)).status).toBe(404)
    expect((await h.request({}, 'GET', '/s/api/logo/nope')).status).toBe(404)
  })
})

describe.skipIf(!hasPoppler)('the sealed sample', () => {
  test('is a PDF in the client\'s branding that pdfsig finds valid over the whole file with an untrusted root', async () => {
    const c = await h.makeClient({ accent_color: '#aa3300' })
    const token = await h.sign({ ...TESSA })
    await h.request({ 'cf-access-jwt-assertion': token }, 'PUT', `/admin/api/clients/${c.id}/logo`, solidPng(80, 40, [255, 255, 255]) as BodyInit)
    const r = await h.request({ 'cf-access-jwt-assertion': await h.sign({ ...TESSA }) }, 'GET', `/admin/api/clients/${c.id}/sample.pdf`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(r.headers.get('content-disposition')).toContain('pinecrest-sealed-sample.pdf')
    const bytes = new Uint8Array(await r.arrayBuffer())
    const sig = pdfsig(bytes)
    expect(sig.valid).toBe(true)
    expect(sig.coversWholeFile).toBe(true)
    expect(sig.untrusted).toBe(true)
    expect(sig.commonName).toBe('Northfield Forms Seal')
    const pdf = await PDF.load(bytes)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(0)!.extractText().text).toContain('Pinecrest')
    expect(pdf.hasAttachment('events.json')).toBe(true)
  })

  test('says the seal is not configured when it is not, rather than failing', async () => {
    const bare = harness({ FORMS_SEAL_KEY: undefined, FORMS_SEAL_CERT_CHAIN: undefined })
    const c = await bare.makeClient()
    const r = await bare.request({ 'cf-access-jwt-assertion': await bare.sign({ ...TESSA }) }, 'GET', `/admin/api/clients/${c.id}/sample.pdf`)
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toContain('FORMS_SEAL_KEY')
  })
})

describe('the operator\'s checks', () => {
  test('the seal status names the certificate, its root and how long it has left', async () => {
    const r = await h.tessa('GET', '/admin/api/seal')
    expect(r.body).toMatchObject({ configured: true, subject: 'Northfield Forms Seal', level: 'B-B' })
    expect(r.body.daysLeft).toBeGreaterThan(1090)
    expect(r.body.rootFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const bare = harness({ FORMS_SEAL_KEY: undefined })
    expect((await bare.tessa('GET', '/admin/api/seal')).body).toMatchObject({ configured: false })
  })

  test('a seal check on a file reports and is written to the audit log', async () => {
    const letter = await fixtureBytes('letter')
    const token = await h.sign({ ...TESSA })
    const r = await h.request({ 'cf-access-jwt-assertion': token }, 'POST', '/admin/api/seal-check?report=1', letter as BodyInit)
    expect(r.status).toBe(200)
    const report = (await r.json()) as any
    expect(report.inspection.pageCount).toBe(2)
    expect(report.seal.level).toBe('B-B')
    const audit = h.sql<{ action: string; entity_id: string }>('SELECT * FROM audit')
    expect(audit).toEqual([expect.objectContaining({ action: 'seal-check', entity_id: report.outputSha256 })])
  })

  test('a file the engine refuses comes back as a plain refusal, not an error', async () => {
    const token = await h.sign({ ...TESSA })
    const r = await h.request({ 'cf-access-jwt-assertion': token }, 'POST', '/admin/api/seal-check', (await fixtureBytes('xfaOnly')) as BodyInit)
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).refused.code).toBe('xfa-only')
  })

  test('with no file it builds the largest scan the service accepts', async () => {
    const token = await h.sign({ ...TESSA })
    const r = await h.request({ 'cf-access-jwt-assertion': token }, 'POST', '/admin/api/seal-check?report=1&mb=4', null)
    expect(r.status).toBe(200)
    const report = (await r.json()) as any
    expect(report.input.synthetic).toBe(true)
    expect(report.input.bytes).toBeGreaterThan(3.5 * 1024 * 1024)
    expect(report.inspection.scannedPages).toEqual([0, 1, 2])
  })

  test('a PDF\'s password travels in a header, never in the URL, and is not kept', async () => {
    const pw = await fixtureBytes('password')
    const go = async (path: string, headers: Record<string, string>) => h.request({ 'cf-access-jwt-assertion': await h.sign({ ...TESSA }), ...headers }, 'POST', path, pw as BodyInit)
    expect((await go('/admin/api/inspect', { 'x-pdf-password': 'open-sesame' })).status).toBe(200)
    expect(((await (await go('/admin/api/inspect', { 'x-pdf-password': 'nope' })).json()) as any).refused.code).toBe('wrong-password')
    // The query string is not read: a password there is as good as none.
    expect(((await (await go('/admin/api/inspect?password=open-sesame', {})).json()) as any).refused.code).toBe('password-needed')
    const sealed = await go('/admin/api/seal-check?report=1', { 'x-pdf-password': 'open-sesame' })
    expect(sealed.status).toBe(200)
    expect(JSON.stringify(h.sql('SELECT * FROM audit'))).not.toContain('open-sesame')
  })

  test('the size cap holds for a body that never says how long it is', async () => {
    const token = await h.sign({ ...TESSA })
    const chunked = (total: number) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024))
          total -= 1024 * 1024
          if (total <= 0) controller.close()
        },
      })
    // No content-length: a stream of 40 MB. The Worker stops reading at 30.
    for (const path of ['/admin/api/seal-check', '/admin/api/inspect']) {
      const res = await h.app.request(`https://space.northfield.example${path}`, { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: chunked(40 * 1024 * 1024), duplex: 'half' } as RequestInit, h.env())
      expect(res.status, path).toBe(413)
    }
    const logo = await h.makeClient()
    const big = await h.app.request(`https://space.northfield.example/admin/api/clients/${logo.id}/logo`, { method: 'PUT', headers: { 'cf-access-jwt-assertion': await h.sign({ ...TESSA }) }, body: chunked(2 * 1024 * 1024), duplex: 'half' } as RequestInit, h.env())
    expect(big.status).toBe(400)
    expect(h.files().objects.size).toBe(0)
  })

  test('inspect describes a PDF without sealing it', async () => {
    const token = await h.sign({ ...TESSA })
    const r = await h.request({ 'cf-access-jwt-assertion': token }, 'POST', '/admin/api/inspect', (await fixtureBytes('rot90')) as BodyInit)
    const body = (await r.json()) as any
    expect(body.pageCount).toBe(2)
    expect(body.turnedPages).toEqual([0, 1])
    const needs = await h.request({ 'cf-access-jwt-assertion': await h.sign({ ...TESSA }) }, 'POST', '/admin/api/inspect', (await fixtureBytes('password')) as BodyInit)
    expect(needs.status).toBe(422)
  })

  test('the storage check stores under a fresh key, reads it back, and is refused without the key or with another', async () => {
    const r = await h.tessa('POST', '/admin/api/storage-check')
    expect(r.body).toEqual({ masterVersion: 1, roundTrip: true, refusedWithoutKey: true, refusedWithAnotherKey: true })
    expect([...h.files().objects.keys()].filter((k) => k.startsWith('checks/'))).toHaveLength(0)
  })

  test('the storage check says so when there is no master key, and stores nothing', async () => {
    const bare = harness({ FORMS_DATA_KEY: undefined })
    const r = await bare.tessa('POST', '/admin/api/storage-check')
    expect(r.status).toBe(503)
    expect(bare.files().objects.size).toBe(0)
  })
})

test('the audience used by the harness is the one the verifier checks', () => {
  expect(AUD).toHaveLength(64)
})
