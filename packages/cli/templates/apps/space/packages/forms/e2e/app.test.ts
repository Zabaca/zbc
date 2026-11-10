// End to end against the REAL Worker in workerd, over a real local D1 and R2, serving the production bundle: what
// test/app.test.ts cannot show. That the migration applies under wrangler (triggers included), that the asset router
// serves the pages and hands only the API paths to the Worker, that a client round-trips through real D1 with its
// audit row, that a sealed sample is valid when made in workerd, and that the bypass for local development is not a
// door on any other hostname.
//
// The operator's screens are the space's Forms tab: their end-to-end tests are packages/space/e2e, over this same Worker.
//
// Not covered, deliberately: Cloudflare Access (there is no local Access; the sign-in check is the company layer's, tested in packages/workspace, and the door with signed
// assertions in test/app.test.ts and test/company.test.ts) and R2's customer-key refusal (local R2 stores the object and ignores the key;
// production's storage check is the proof, see README "After the first deploy").
//
//   bun test e2e/app.test.ts     (needs poppler for the seal check; FORMS_E2E_PORT_APP names the port, else a free one is used)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { PDF } from '@libpdf/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { solidPng } from '../test/png'
import { hasPoppler, pdfsig } from '../test/render'
import { setUpClient } from './clients'
import { ROOT, type Server, startServer } from './server'

let server: Server
beforeAll(async () => {
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_APP' })
}, 240_000)
afterAll(() => server?.kill(), 60_000)

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const SLUG = `e2e-${Date.now().toString(36)}`

describe('the pages', () => {
  test('the landing page and the privacy notice are plain pages anyone can open', async () => {
    for (const path of ['/', '/privacy']) {
      const res = await fetch(`${server.base}${path}`)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('<div id="root">')
      expect(html).not.toContain('/admin/')
    }
  })

  test('there is no admin page: the screens are the space\'s, so the build has one entry, the signer\'s, and nothing of the admin\'s code', async () => {
    // The landing page is the only entry; /admin has no page and no redirect (the local Worker runs only the API paths before the asset router).
    const html = await (await fetch(`${server.base}/`)).text()
    expect(html).toContain('<title>Forms</title>')
    expect(html).not.toContain('/forms/assets/')
    expect(html).not.toContain('/admin/')
  })

  test('an unknown API path is the Worker answering, not the page', async () => {
    for (const path of ['/s/api/does-not-exist', '/admin/api/does-not-exist']) {
      const res = await fetch(`${server.base}${path}`)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })
})

describe('the door for local development', () => {
  test('is the operator on localhost, and nobody on any other hostname', async () => {
    expect(await (await fetch(`${server.base}/admin/api/me`)).json()).toMatchObject({ actor: 'local@dev' })
    const other = await fetch(`${server.base}/admin/api/me`, { headers: { host: 'space.northfield.example' } })
    expect(other.status).toBe(401)
  })

  test("the bundle carries one company's declaration: its company name (FORMS_DECLARATION builds another company's)", async () => {
    const file = process.env.FORMS_DECLARATION ?? fileURLToPath(new URL('../../workspace/northfield/workspace.json', import.meta.url))
    const install = createInstall(JSON.parse(readFileSync(file, 'utf8')))
    const me = (await (await fetch(`${server.base}/admin/api/me`)).json()) as { company: string }
    expect(me.company).toBe(install.company.name)
  })
})

describe('a client, through real D1 and R2', () => {
  let id = ''
  test('is created with its audit row and listed', async () => {
    const client = await setUpClient(server.base, { slug: SLUG, display_name: "Pinecrest's Tax", legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#aa3300' })
    id = client.id
    expect(client.client_number).toBeGreaterThan(0)
    const list = (await (await fetch(`${server.base}/admin/api/clients`)).json()) as { slug: string }[]
    expect(list.map((c) => c.slug)).toContain(SLUG)
    const audit = (await (await fetch(`${server.base}/admin/api/audit?client=${id}`)).json()) as { action: string; actor: string }[]
    expect(audit).toEqual([expect.objectContaining({ action: 'create', actor: 'local@dev' })])
  })

  test('a duplicate slug is a conflict and writes nothing', async () => {
    const again = (await (await fetch(`${server.base}/admin/api/dev-clients`, json('POST', { name: 'Again', legalName: 'Again Inc' }))).json()) as { number: number }
    const res = await fetch(`${server.base}/admin/api/clients`, json('POST', { slug: SLUG, client_number: again.number, reply_to: 'a@b.test' }))
    expect(res.status).toBe(409)
    const audit = (await (await fetch(`${server.base}/admin/api/audit?client=${id}`)).json()) as unknown[]
    expect(audit).toHaveLength(1)
  })

  test('a logo is stored in R2 and served to anyone', async () => {
    const png = solidPng(80, 40, [255, 255, 255])
    const put = await fetch(`${server.base}/admin/api/clients/${id}/logo`, { method: 'PUT', body: png as BodyInit })
    expect(put.status).toBe(200)
    const logo = await fetch(`${server.base}/s/api/logo/${id}`)
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await logo.arrayBuffer()).equals(Buffer.from(png))).toBe(true)
  })

  test.skipIf(!hasPoppler)('its sealed sample, made in workerd, is valid over the whole file and carries the client\'s name', async () => {
    const res = await fetch(`${server.base}/admin/api/clients/${id}/sample.pdf`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const sig = pdfsig(bytes)
    expect(sig.valid, `${sig.raw}\n${sig.diagnostics}`).toBe(true)
    expect(sig.coversWholeFile, sig.diagnostics).toBe(true)
    expect(sig.untrusted, sig.diagnostics).toBe(true)
    const pdf = await PDF.load(bytes)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(0)!.extractText().text).toContain("Pinecrest's Tax")
  })

  test('the seal status names the certificate this server was started with', async () => {
    const status = (await (await fetch(`${server.base}/admin/api/seal`)).json()) as { configured: boolean; rootFingerprint: string; certFingerprint: string }
    expect(status.configured).toBe(true)
    expect(status.rootFingerprint).toBe(server.certs.root.fingerprint)
    expect(status.certFingerprint).toBe(server.certs.seal.fingerprint)
  })
})

describe('the migration under wrangler', () => {
  test('an event cannot be rewritten in real D1: a seal check audit row is the only history this slice writes, and it is written', async () => {
    const res = await fetch(`${server.base}/admin/api/seal-check?report=1&mb=2`, { method: 'POST' })
    expect(res.status).toBe(200)
    const audit = (await (await fetch(`${server.base}/admin/api/audit`)).json()) as { action: string }[]
    expect(audit.map((a) => a.action)).toContain('seal-check')
  })
})

describe('a row from before the Clients part, and the number column, under wrangler (migration 0005 on real D1)', () => {
  /** A row as the database held them before 0005: made with SQL, because no route makes a row without a number any more. */
  function insertLegacy(id: string, slug: string) {
    const sql = `INSERT INTO clients (id, slug, display_name, legal_name, reply_to, created_at, updated_at) VALUES ('${id}', '${slug}', 'Legacy Co', 'Legacy Company Inc', 'old@x.example', 'then', 'then')`
    const done = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'execute', 'forms-records', '--local', '--config', 'dev/wrangler.jsonc', '--persist-to', '.wrangler/state', '--command', sql], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe' })
    if (done.exitCode !== 0) throw new Error(`could not insert the row: ${done.stderr.toString()}`)
  }
  const legacyId = '00000000-0000-4000-8000-00000000c501'

  test('is listed with no number, and signing sends for it', async () => {
    insertLegacy(legacyId, `legacy-${Date.now().toString(36)}`)
    const rows = (await (await fetch(`${server.base}/admin/api/clients`)).json()) as { id: string; client_number: number | null; client_archived: boolean | null }[]
    expect(rows.find((r) => r.id === legacyId)).toMatchObject({ client_number: null, client_archived: null })
    const draft = await fetch(`${server.base}/admin/api/envelopes`, json('POST', { client_id: legacyId, source: { type: 'sample' }, order: 'sequential', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }] }))
    expect(draft.status).toBe(201)
  })

  test('is linked to a Client by hand, takes its names, keeps its id; a second row for the same Client is refused by the database’s own unique index', async () => {
    const target = (await (await fetch(`${server.base}/admin/api/dev-clients`, json('POST', { name: 'Legacy Company', legalName: 'Legacy Company Inc' }))).json()) as { number: number }
    const linked = await fetch(`${server.base}/admin/api/clients/${legacyId}/link`, json('PUT', { client_number: target.number }))
    expect(linked.status).toBe(200)
    expect(await linked.json()).toMatchObject({ id: legacyId, client_number: target.number, display_name: 'Legacy Company' })
    // Another row cannot take the same number, whatever the route checks: the index says so in real D1.
    insertLegacy('00000000-0000-4000-8000-00000000c502', `legacy2-${Date.now().toString(36)}`)
    const sql = `UPDATE clients SET client_number = ${target.number} WHERE id = '00000000-0000-4000-8000-00000000c502'`
    const done = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'execute', 'forms-records', '--local', '--config', 'dev/wrangler.jsonc', '--persist-to', '.wrangler/state', '--command', sql], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe' })
    expect(done.exitCode).not.toBe(0)
    expect(done.stderr.toString() + done.stdout.toString()).toMatch(/UNIQUE/)
  })
})
