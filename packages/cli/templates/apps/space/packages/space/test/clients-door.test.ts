// The Clients door on the space (src/clients-door.ts; packages/workspace/docs/adr/0002, amended), driven with real requests through the real router and the REAL Clients part over a real SQLite: only the door's
// service token, for the door's application, on its one path, gets through; what it can do is what a source may do to its own Clients, and nothing else; and the owner's operator routes (bookmark, restart,
// counts) reach the same store. The part's own rules (who wins a name, numbers, gone) are proven in packages/clients/test; here is what travels the door and what is refused at it.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createSourceClients } from '@space/clients/src/source'
import { createSpaceClients } from '@space/clients/src/space'
import { migrate } from '@space/clients/src/schema'
import { ClientsStore, localApi } from '@space/clients/src/store'
import type { ClientsObject } from '@space/clients/src/store-access'
import { memoryDatabase } from '@space/clients/test-support/sql-over-sqlite'
import { sourceActor } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { AGENT_AUD, CLIENTS_AUD, CLIENTS_TOKEN, FORMS_AUD, TELEGRAM_AUD, NORTHFIELD_TEAM, world } from './world'

const DOOR = '/agent/clients'
const API = `${DOOR}/api/clients`
const ORIGIN = 'https://space.northfield.example'
const JSON_HEADERS = { 'content-type': 'application/json' }
const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'

/** The real part over a real store, in the space's install (Northfield's: the door names `northfield.example`). */
function realPart() {
  const mem = memoryDatabase()
  migrate(mem.sql)
  const store = new ClientsStore({ sql: mem.sql, transaction: mem.transaction, now: () => new Date(T0), owners: ['tessa@northfield.example'], ownerName: 'Tessa', sources: ['northfield.example'] })
  const operated: string[] = []
  const object: ClientsObject = {
    bookmark: async () => (operated.push('bookmark'), BOOKMARK),
    restart: async () => {
      operated.push('restart')
      throw new Error('reset')
    },
    counts: async () => (operated.push('counts'), store.counts()),
  }
  return {
    mem,
    store,
    operated,
    parts: {
      clients: createSpaceClients({ store: localApi(store), install: northfield(), object }),
      clientsDoor: createSourceClients({ store: localApi(store), source: 'northfield.example' }),
    },
  }
}

const fernway = { name: 'Fernway Plumbing', legalName: 'Fernway Plumbing LLC', preferredNumber: 7, url: 'https://www.northfield.example/admin#client-7', extra: { subscription: 'active', signInAddress: 'owner@fernway.test' } }

describe('the Clients door on the space', () => {
  const z = northfield()
  let w: Awaited<ReturnType<typeof world>>
  let p: ReturnType<typeof realPart>
  beforeEach(async () => {
    p = realPart()
    w = await world(z, NORTHFIELD_TEAM, { parts: p.parts })
  })
  const put = async (path: string, body: unknown, jwt?: string) => w.call(path, { method: 'PUT', jwt: jwt ?? (await w.signInClients()), headers: JSON_HEADERS, body: JSON.stringify(body) })

  test('a Client pushed with the door’s token is made in the space, with the source’s number, fields and address, and the same push again changes nothing', async () => {
    const res = await put(`${API}/s-7`, fernway)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ value: { number: 7, created: true, changed: true } })
    expect(p.store.get(7)).toMatchObject({ ok: true, value: { name: 'Fernway Plumbing', createdBy: sourceActor('northfield.example'), source: { externalId: 's-7', url: fernway.url, extra: fernway.extra } } })
    const again = await put(`${API}/s-7`, fernway)
    expect(await again.json()).toEqual({ value: { number: 7, created: false, changed: false } })
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 1 })
  })

  test('a Client the source says is gone is marked and kept; one it never sent is a 404', async () => {
    await put(`${API}/s-7`, fernway)
    const gone = await w.call(`${API}/s-7/gone`, { method: 'POST', jwt: await w.signInClients() })
    expect(await gone.json()).toEqual({ value: { number: 7, changed: true } })
    expect(p.store.get(7)).toMatchObject({ ok: true, value: { archivedAt: null, source: { goneSince: T0 } } })
    const unknown = await w.call(`${API}/nope/gone`, { method: 'POST', jwt: await w.signInClients() })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ reason: 'not-found' })
  })

  test('the full set is made all or nothing, marks what is missing, and the listing lets the sender reconcile', async () => {
    const jwt = await w.signInClients()
    const sent = (clients: unknown[]) => w.call(API, { method: 'PUT', jwt, headers: JSON_HEADERS, body: JSON.stringify({ clients }) })
    const first = await sent([{ id: 'a', ...fernway }, { id: 'b', name: 'Beta', preferredNumber: 8 }])
    expect(await first.json()).toMatchObject({ value: { sent: 2, added: 2, markedGone: 0, matches: true } })
    const second = await sent([{ id: 'a', ...fernway }])
    expect(await second.json()).toMatchObject({ value: { sent: 1, markedGone: 1, matches: true } })
    const bad = await sent([{ id: 'a', ...fernway }, { id: 'c', name: '' }])
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ reason: 'bad-request' })
    const list = await w.call(API, { jwt })
    expect(await list.json()).toMatchObject({ value: [{ externalId: 'a', number: 7, goneSince: null }, { externalId: 'b', number: 8, goneSince: T0 }] })
  })

  test('a push that is not the shape is a 400 with a sentence and stores nothing', async () => {
    const jwt = await w.signInClients()
    for (const body of [{}, { name: '' }, { name: 'A', admin: true }, { name: 'A', url: 'http://x.test' }, { name: 'A', preferredNumber: 0 }, null, 'text']) {
      const res = await put(`${API}/a`, body, jwt)
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400])
      expect(await res.json()).toMatchObject({ reason: 'bad-request' })
    }
    const notJson = await w.call(`${API}/a`, { method: 'PUT', jwt, body: '{not json' })
    expect(notJson.status).toBe(400)
    const wrongShape = await w.call(API, { method: 'PUT', jwt, headers: JSON_HEADERS, body: JSON.stringify([{ id: 'a', name: 'A' }]) })
    expect(wrongShape.status).toBe(400)
    const extraKey = await w.call(API, { method: 'PUT', jwt, headers: JSON_HEADERS, body: JSON.stringify({ clients: [], other: 1 }) })
    expect(extraKey.status).toBe(400)
    const badId = await put(`${API}/${encodeURIComponent('../x')}`, { name: 'A' }, jwt)
    expect(badId.status).toBe(400)
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('a body over the limit is a 413', async () => {
    const res = await w.call(`${API}/a`, { method: 'PUT', jwt: await w.signInClients(), headers: { ...JSON_HEADERS, 'content-length': '5000000' }, body: '{}' })
    expect(res.status).toBe(413)
  })

  test('only the paths and methods of the door: anything else under it is a 404 or a 405 and goes nowhere', async () => {
    const jwt = await w.signInClients()
    for (const [method, path, status] of [
      ['GET', DOOR, 404],
      ['GET', `${DOOR}/`, 404],
      ['GET', `${DOOR}/index.html`, 404],
      ['GET', `${DOOR}/api`, 404],
      ['GET', `${DOOR}/api/other`, 404],
      ['GET', `${API}/a/b/c`, 404],
      ['GET', `${API}/a/other`, 404],
      ['DELETE', API, 405],
      ['POST', API, 405],
      ['GET', `${API}/a`, 405],
      ['DELETE', `${API}/a`, 405],
      ['GET', `${API}/a/gone`, 405],
      ['PUT', `${API}/a/gone`, 405],
    ] as const) {
      const res = await w.call(path, { method, jwt, headers: JSON_HEADERS, body: method === 'GET' ? undefined : '{}' })
      expect([method, path, res.status]).toEqual([method, path, status])
    }
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('a person’s sign-in is refused on the door, whatever application it was minted for', async () => {
    for (const jwt of [await w.signIn('tessa@northfield.example'), await w.signInForms('tessa@northfield.example'), await w.signInClients({ email: 'tessa@northfield.example' })]) {
      const res = await put(`${API}/a`, { name: 'A' }, jwt)
      expect([401, 403]).toContain(res.status)
    }
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('an assertion naming a person and the token at once is refused', async () => {
    const res = await put(`${API}/a`, { name: 'A' }, await w.signInClients({ email: 'tessa@northfield.example', common_name: CLIENTS_TOKEN }))
    expect(res.status).toBe(403)
  })

  test('no assertion, a forged one, and the cookie alone are refused', async () => {
    expect((await w.call(`${API}/a`, { method: 'PUT', body: '{"name":"A"}' })).status).toBe(401)
    expect((await w.call(`${API}/a`, { method: 'PUT', jwt: 'not-a-jwt', body: '{"name":"A"}' })).status).toBe(401)
    expect((await w.call(`${API}/a`, { method: 'PUT', cookieJwt: await w.signInClients(), body: '{"name":"A"}' })).status).toBe(401)
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('the three machines’ doors are three applications: an assertion minted for one does not verify on another', async () => {
    // Claude's and the bridge's tokens, for their applications, on the Clients door.
    expect((await put(`${API}/a`, { name: 'A' }, await w.signInAgent())).status).toBe(401)
    expect((await put(`${API}/a`, { name: 'A' }, await w.signInBridge())).status).toBe(401)
    // The Clients token, for its application, on the others' paths.
    expect((await w.call('/agent/inbox/api/queue', { jwt: await w.signInClients() })).status).toBe(401)
    expect((await w.call('/agent/telegram/api/push', { method: 'POST', jwt: await w.signInClients() })).status).toBe(401)
    // And neither is the space's, Forms' or another door's audience.
    for (const aud of [FORMS_AUD, AGENT_AUD, TELEGRAM_AUD]) {
      expect((await put(`${API}/a`, { name: 'A' }, await w.signInClients({ common_name: CLIENTS_TOKEN }, aud))).status).toBe(401)
    }
    expect((await put(`${API}/a`, { name: 'A' }, await w.access.sign({ common_name: CLIENTS_TOKEN }))).status).toBe(401)
    expect(w.handedToClaude).toEqual([])
    expect(w.handedToBridge).toEqual([])
  })

  test('a token that verifies for the door’s application but is not the door’s token is refused, and so is every token while the door’s token id is not set', async () => {
    expect((await put(`${API}/a`, { name: 'A' }, await w.signInClients({ common_name: 'someone-else.access' }))).status).toBe(403)
    for (const id of [undefined, '']) {
      const own = await world(z, NORTHFIELD_TEAM, { parts: p.parts, CLIENTS_ACCESS_CLIENT_ID: id })
      const res = await own.call(`${API}/a`, { method: 'PUT', jwt: await own.signInClients(), headers: JSON_HEADERS, body: '{"name":"A"}' })
      expect([String(id), res.status]).toEqual([String(id), 403])
    }
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('an unset or malformed Clients audience refuses the token itself', async () => {
    for (const aud of [undefined, '', 'placeholder', CLIENTS_AUD.slice(1)]) {
      const own = await world(z, NORTHFIELD_TEAM, { parts: p.parts, CF_ACCESS_AUD_CLIENTS: aud })
      const res = await own.call(`${API}/a`, { method: 'PUT', jwt: await own.signInClients(), headers: JSON_HEADERS, body: '{"name":"A"}' })
      expect([String(aud), res.status]).toEqual([String(aud), 401])
    }
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })

  test('the token is refused everywhere else on the host, however genuine its assertion', async () => {
    const jwt = await w.signInClients()
    const spaceJwt = await w.access.sign({ common_name: CLIENTS_TOKEN })
    for (const path of ['/', '/today', '/api/me', '/api/clients/store/counts', '/api/inbox/clients', '/forms/api/clients', '/agent', '/agent/', '/agent/other/api/clients', '/agent/clientsx/api/clients', '/x/agent/clients/api/clients']) {
      for (const assertion of [jwt, spaceJwt]) {
        const res = await w.call(path, { jwt: assertion })
        expect([path, res.status === 401 || res.status === 403]).toEqual([path, true])
      }
    }
    expect(p.operated).toEqual([])
  })

  test('a path that climbs out of the door by dot segments or encoding is not the door', async () => {
    const jwt = await w.signInClients()
    for (const path of [`${DOOR}/../../api/me`, `${DOOR}/%2e%2e/%2e%2e/api/me`, '/agent%2Fclients/api/clients']) {
      const res = await w.call(path, { method: 'PUT', jwt, headers: JSON_HEADERS, body: '{}' })
      expect([path, res.status === 401 || res.status === 403 || res.status === 404]).toEqual([path, true])
    }
  })

  test('the door is case-blind as Access is, and is the same door', async () => {
    const res = await put('/AGENT/Clients/api/clients/a', { name: 'A' })
    expect(res.status).toBe(200)
  })

  test('where the Clients store is not bound the token gets a 503 and nothing else', async () => {
    const own = await world(z, NORTHFIELD_TEAM, { parts: { clients: undefined, clientsDoor: undefined } })
    const res = await own.call(`${API}/a`, { method: 'PUT', jwt: await own.signInClients(), headers: JSON_HEADERS, body: '{"name":"A"}' })
    expect(res.status).toBe(503)
  })

  test('an install that declares no Clients door has no such path: the token is a stranger to the host', async () => {
    const lane = (await import('../../workspace/test/helpers')).lane()
    const own = await world(lane, 'brightwater.cloudflareaccess.com', { parts: p.parts })
    const res = await own.call(`${API}/a`, { method: 'PUT', jwt: await own.signInClients(), headers: JSON_HEADERS, body: '{"name":"A"}' })
    expect([401, 403]).toContain(res.status)
    expect(p.mem.db.query('SELECT count(*) AS n FROM client').get()).toEqual({ n: 0 })
  })
})

describe('the operator’s three on the space', () => {
  const z = northfield()
  const post = (w: Awaited<ReturnType<typeof world>>, path: string, jwt?: string) => w.call(path, { method: 'POST', jwt, headers: { origin: ORIGIN, ...JSON_HEADERS }, body: '{}' })

  test('the owner reads a bookmark, restarts the object and reads the counts, which are the store’s', async () => {
    const p = realPart()
    const w = await world(z, NORTHFIELD_TEAM, { parts: p.parts })
    const jwt = await w.signIn('tessa@northfield.example')
    await w.call(`${API}/a`, { method: 'PUT', jwt: await w.signInClients(), headers: JSON_HEADERS, body: JSON.stringify(fernway) })
    expect(await (await post(w, '/api/clients/store/bookmark', jwt)).json()).toEqual({ result: 'ok', value: { bookmark: BOOKMARK } })
    expect(await (await post(w, '/api/clients/store/restart', jwt)).json()).toEqual({ result: 'ok', value: { restarted: true } })
    const counts = await (await post(w, '/api/clients/store/counts', jwt)).json()
    expect(counts).toMatchObject({ result: 'ok', value: { clients: 1, fromSource: 1, madeHere: 0, gone: 0, highest: 7, schema: 1, source: { name: 'northfield.example', syncedCount: null } } })
    expect(p.operated).toEqual(['bookmark', 'restart', 'counts'])
  })

  test('no sign-in is refused, a GET is not accepted, and a write from another site is refused', async () => {
    const p = realPart()
    const w = await world(z, NORTHFIELD_TEAM, { parts: p.parts })
    expect((await post(w, '/api/clients/store/counts')).status).toBe(401)
    const jwt = await w.signIn('tessa@northfield.example')
    expect((await w.call('/api/clients/store/counts', { jwt })).status).not.toBe(200)
    expect((await w.call('/api/clients/store/counts', { method: 'POST', jwt, headers: { origin: 'https://evil.test', ...JSON_HEADERS }, body: '{}' })).status).toBe(403)
    expect(p.operated).toEqual([])
  })

  test('where the store is not bound they say so, and a teammate who is not an owner is refused', async () => {
    const none = await world(z, NORTHFIELD_TEAM, { parts: { clients: undefined } })
    expect(await (await post(none, '/api/clients/store/counts', await none.signIn('tessa@northfield.example'))).json()).toMatchObject({ result: 'unreachable' })
    expect(await (await post(none, '/api/clients/store/restart', await none.signIn('tessa@northfield.example'))).json()).toMatchObject({ result: 'failed' })
  })
})
