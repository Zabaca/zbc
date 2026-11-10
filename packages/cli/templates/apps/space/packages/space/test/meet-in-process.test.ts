// Meet's chat, calls and phone, IN the Worker, behind the one sign-in check (packages/workspace/docs/adr/0003).
//
// Everything else in this package's tests puts stand-ins behind the parts. Here meet's part is the real one (`createParts`): meet's own Workspace and Room cores behind the same `invoke` doors the Durable Objects
// have, so what is asserted is what a person gets, and what meet is NOT given: no assertion, no audience, no SFU, no guest door, and no way to ask for anyone the one check did not name.
// (forms and the knowledge app, in the same Worker, are test/in-process.test.ts.)
import { beforeEach, describe, expect, test } from 'bun:test'
import { createInstall, resetJwksCache } from '@space/workspace'
import { harness as meetHarness } from '@space/meet/test/helpers'
import { invokePhone } from '@space/meet/src/phone'
import { LEDGER_NAME, invokeCore } from '@space/meet/src/room'
import { invokeWorkspace } from '@space/meet/src/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { AUD, T0, team } from '../../workspace/test/helpers'
import { createApp } from '../src/app'
import { appOriginOf } from '@space/meet/src/wiring'
import { createParts, meetEnvOf } from '../src/parts'

const TEAM = 'northfield.cloudflareaccess.com'
const ORIGIN = 'https://space.northfield.example'
const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'
const WITH_TEAMMATE = createInstall({ ...declaration, people: [...declaration.people, { address: 'dana@northfield.example', name: 'Dana', role: 'member' }] })
/** The part reads the real clock, as the Worker does, so a sign-in is good for an hour from now (the space's own check is given T0 below). */
const exp = () => Math.floor(Date.now() / 1000) + 3600

beforeEach(() => resetJwksCache())

/** The Worker with meet's two namespaces bound (or not), over the real cores. `operated` records the operator's four. */
async function inTheWorker(opts: { install?: ReturnType<typeof createInstall>; bound?: boolean; env?: Record<string, unknown> } = {}) {
  const install = opts.install ?? createInstall(declaration)
  const access = await team(TEAM)
  const m = await meetHarness({ devBypass: false, install })
  const operated: string[] = []

  const named = (object: string) => ({
    bookmark: async () => (operated.push(`${object} bookmark`), BOOKMARK),
    restoreTo: async (b: string) => (operated.push(`${object} restoreTo ${b}`), BOOKMARK),
    restart: async () => {
      operated.push(`${object} restart`)
      throw new Error('reset')
    },
    counts: async () => (operated.push(`${object} counts`), { people: 2, messages: 7 }),
  })
  const WORKSPACE = {
    idFromName: (n: string) => n,
    get: () => ({
      invoke: (method: string, args: unknown[]) => invokeWorkspace(m.workspaceCore, method, structuredClone(args)),
      invokePhone: (method: string, args: unknown[]) => invokePhone(m.phoneCore, method, structuredClone(args)),
      ...named('workspace'),
    }),
  }
  const ROOMS = {
    idFromName: (n: string) => n,
    get: (name: string) => ({
      invoke: (method: string, args: unknown[]) => {
        const core = m.cores.get(name)
        return core ? invokeCore(core, method, structuredClone(args)) : { ok: false, status: 500, message: 'not used' }
      },
      ...named(name === LEDGER_NAME ? 'ledger' : 'a call'),
    }),
  }
  const deps = { fetch: access.fetch as never, now: () => T0, install }
  const app = createApp({ ...deps, parts: createParts(deps) })
  const env = {
    ASSETS: { fetch: async () => new Response('page', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
    CF_ACCESS_AUD: AUD,
    EMAIL: { send: async () => ({}) },
    ...(opts.bound === false ? {} : { WORKSPACE, ROOMS }),
    ...opts.env,
  }
  const call = (path: string, jwt: string | null, init: RequestInit = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...(init.headers as Record<string, string>) } }), env as never)
  const as = (email: string) => access.sign({ email }, { exp: exp() })
  const post = (path: string, jwt: string, body: unknown) => call(path, jwt, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { call, as, post, access, env, operated, m }
}

describe('meet’s part, in the Worker', () => {
  test('Tessa’s settings are answered in-process by the real core, for the person the check named', async () => {
    const w = await inTheWorker()
    const res = await w.call('/api/meet/me', await w.as('tessa@northfield.example'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: 'ok', value: { person: { address: 'tessa@northfield.example' }, owner: true } })
  })

  test('a teammate is their own person in meet: the same call for Dana is Dana’s, made when she first asks', async () => {
    const w = await inTheWorker({ install: WITH_TEAMMATE })
    const res = await w.call('/api/meet/me', await w.as('dana@northfield.example'))
    expect(await res.json()).toMatchObject({ result: 'ok', value: { person: { address: 'dana@northfield.example' }, owner: false } })
  })

  test('no sign-in, a stranger and a service token never reach meet’s store', async () => {
    const w = await inTheWorker()
    const before = w.m.workspaceCalls.n
    for (const jwt of [null, await w.access.sign({ email: 'eve@elsewhere.test' }, { exp: exp() }), await w.access.sign({ common_name: 'claude-script-client-id' }, { exp: exp() })]) {
      const res = await w.call('/api/meet/me', jwt)
      expect([401, 403]).toContain(res.status)
    }
    expect(w.m.workspaceCalls.n).toBe(before)
  })

  test('where the stores are not bound the Meet tab says chat is not connected, and the rest of the space works', async () => {
    const w = await inTheWorker({ bound: false })
    const jwt = await w.as('tessa@northfield.example')
    expect(await (await w.call('/api/meet/me', jwt)).json()).toMatchObject({ result: 'unreachable', message: expect.stringContaining('not connected') })
    expect((await w.call('/api/me', jwt)).status).toBe(200)
  })
})

describe('the phone comes through the part, for the person handed in, and the guests’ side of meet is not in this Worker', () => {
  test('the guests’ side of meet is NOT in this Worker: the call API, the guests’ door and Telnyx’s webhook answer the page’s 404 or 405, never meet’s', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    for (const path of ['/api/rooms/k7m2qx9frtn4w6hbc8jd/join', '/api/w/auth/request', '/api/phone/webhook']) {
      const res = await w.post(path, jwt, {})
      expect([path, [404, 405].includes(res.status)]).toEqual([path, true])
    }
  })

  test('the phone: the dial pad’s status is answered in-process (no Telnyx secrets means no dial pad for anyone), and a write from another site is refused', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    expect(await (await w.call('/api/phone', jwt)).json()).toEqual({ available: false })
    const cross = await w.call('/api/phone/ack', jwt, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(cross.status).toBe(403)
  })
})

describe('the operator’s four, for a move of meet’s stores', () => {
  test('they reach the two long-lived objects themselves, for the owner, and name no other', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    expect(await (await w.post('/api/meet/store/bookmark', jwt, { object: 'workspace' })).json()).toMatchObject({ result: 'ok', value: { object: 'workspace', bookmark: BOOKMARK } })
    expect(await (await w.post('/api/meet/store/bookmark', jwt, { object: 'ledger' })).json()).toMatchObject({ result: 'ok', value: { object: 'ledger', bookmark: BOOKMARK } })
    expect(await (await w.post('/api/meet/store/restart', jwt, { object: 'workspace' })).json()).toMatchObject({ result: 'ok', value: { object: 'workspace', restarted: true } })
    expect(await (await w.post('/api/meet/store/restore', jwt, { object: 'ledger', bookmark: BOOKMARK })).json()).toMatchObject({ result: 'ok', value: { object: 'ledger', restoring: true } })
    expect(await (await w.post('/api/meet/store/counts', jwt, { object: 'workspace' })).json()).toMatchObject({ result: 'ok', value: { object: 'workspace', counts: { people: 2, messages: 7 } } })
    expect(w.operated).toEqual(['workspace bookmark', 'ledger bookmark', 'workspace restart', `ledger restoreTo ${BOOKMARK}`, 'ledger restart', 'workspace counts'])
    w.operated.length = 0
    for (const [path, body] of [
      ['bookmark', { object: 'a-call' }],
      ['restart', {}],
      ['restore', { object: 'workspace', bookmark: 'latest' }],
      ['counts', { object: 'a-call' }],
    ] as const) {
      expect([path, (await w.post(`/api/meet/store/${path}`, jwt, body)).status]).toEqual([path, 400])
    }
    expect(w.operated).toEqual([])
  })

  test('a teammate who is not the owner is refused all three and no object is touched', async () => {
    const w = await inTheWorker({ install: WITH_TEAMMATE })
    const jwt = await w.as('dana@northfield.example')
    for (const [path, body] of [
      ['bookmark', { object: 'workspace' }],
      ['restart', { object: 'workspace' }],
      ['restore', { object: 'workspace', bookmark: BOOKMARK }],
      ['counts', { object: 'workspace' }],
    ] as const) {
      expect([path, await (await w.post(`/api/meet/store/${path}`, jwt, body)).json()]).toMatchObject([path, { result: 'refused', reason: 'not-admitted' }])
    }
    expect(w.operated).toEqual([])
  })

  test('they are writes like the rest: a GET finds no route and another site’s Origin is a 403', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    expect((await w.call('/api/meet/store/bookmark', jwt)).status).toBe(404)
    const cross = await w.call('/api/meet/store/restart', jwt, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ object: 'workspace' }) })
    expect(cross.status).toBe(403)
    expect(w.operated).toEqual([])
  })
})

describe('what meet is handed', () => {
  test('its own bindings and secrets, and neither the SFU’s secrets, the guests’ limit, forms’ keys nor the Access audiences', () => {
    const env = meetEnvOf({
      ROOMS: 'r',
      WORKSPACE: 'w',
      EMAIL: 'mail',
      TELNYX_NUMBER: '+16265550100',
      CF_ACCESS_AUD: AUD,
      FORMS_DATA_KEY: 'k',
      MEET_REALTIME_APP_SECRET: 's',
    } as never)
    expect(Object.keys(env).sort()).toEqual(['EMAIL', 'ROOMS', 'TELNYX_NUMBER', 'WORKSPACE'])
  })

  test('no var names the address meet’s links are made on: they are on the install’s space host, whatever vars the Worker holds', () => {
    expect(meetEnvOf({ ROOMS: 'r', WORKSPACE: 'w', APP_ORIGIN: 'https://forms.northfield.test', MEET_APP_ORIGIN: 'https://meet.northfield.test' } as never)).not.toHaveProperty('APP_ORIGIN')
    expect(appOriginOf(createInstall(declaration))).toBe('https://space.northfield.example')
  })
})
