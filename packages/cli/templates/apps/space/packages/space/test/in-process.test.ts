// Forms and the knowledge app, IN the Worker, behind the one sign-in check (packages/workspace/docs/adr/0003).
//
// Everything else in this package's tests puts stand-ins behind the parts. Here the parts are the real ones (`createParts`): the knowledge app over its real store (the very
// functions the Durable Object runs), and forms' own app over its real migration, a local D1 and an in-memory bucket. What is asserted is what a person gets, and what the parts
// are NOT given: no assertion, no audience and no way to ask for anyone the one check did not name.
import { beforeEach, describe, expect, test } from 'bun:test'
import { resetJwksCache } from '@space/workspace'
import { harness as formsHarness } from '@space/forms/test/harness'
import { harness as clientsHarness, says } from '@space/clients/test-support/harness'
import { harness as knowledgeHarness } from '@space/knowledge/test-support/harness'
import { createInstall } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { AUD, T0, team } from '../../workspace/test/helpers'
import { createApp } from '../src/app'
import { createParts, formsEnvOf, runClientNamesRepair } from '../src/parts'

const TEAM = 'northfield.cloudflareaccess.com'
const FORMS_AUD = 'f'.repeat(64)
const ORIGIN = 'https://space.northfield.example'
const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'
const WITH_TEAMMATE = createInstall({ ...declaration, people: [...declaration.people, { address: 'dana@northfield.example', name: 'Dana', role: 'member' }] })

beforeEach(() => resetJwksCache())

async function inTheWorker(install = createInstall(declaration)) {
  const access = await team(TEAM)
  const knowledge = knowledgeHarness()
  const object: string[] = []
  const forms = formsHarness()
  // The Clients store, through a namespace that reaches the real store's methods (the very functions the Durable Object runs), over a real SQLite.
  const clients = clientsHarness()
  const deps = { fetch: access.fetch as never, now: () => T0, install }
  const app = createApp({ ...deps, parts: createParts(deps) })
  // Only what the Worker has bound: the store through a namespace that reaches the real object's methods, forms' database and bucket by their own names.
  const env = {
    ASSETS: { fetch: async () => new Response('page', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_AUD_FORMS: FORMS_AUD,
    KNOWLEDGE: {
      idFromName: (n: string) => n,
      get: () => ({
        call: (method: string, args: unknown[]) => (knowledge.api.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
        bookmark: async () => (object.push('bookmark'), BOOKMARK),
        restoreTo: async (b: string) => (object.push(`restoreTo ${b}`), BOOKMARK),
        restart: async () => {
          object.push('restart')
          throw new Error('reset')
        },
      }),
    } as never,
    CLIENTS_STORE: { idFromName: (n: string) => n, get: () => ({ call: (method: string, args: unknown[]) => (clients.api.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args) }) } as never,
    FORMS_DB: forms.env().DB,
    FORMS_FILES: forms.env().FILES,
  }
  const call = (path: string, jwt: string | null, init: RequestInit = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...(init.headers as Record<string, string>) } }), env)
  const as = (email: string) => access.sign({ email })
  const asForms = (email: string) => access.sign({ email, aud: [FORMS_AUD] })
  return { call, as, asForms, knowledge, forms, clients, access, env, object }
}

describe('the knowledge app, in the Worker', () => {
  test('the owner reads the base and changes it, through the real store, with the owner’s own address as the actor', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    const read = await w.call('/api/knowledge', jwt)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ result: 'ok', value: { entries: [] } })

    const added = await w.call('/api/knowledge', jwt, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ change: { do: 'add', title: 'Hours', body: 'Open Saturdays.', businesses: ['ridgeway-cycles'] } }) })
    expect(await added.json()).toMatchObject({ result: 'ok', value: { title: 'Hours', createdBy: 'tessa@northfield.example', version: 1 } })
    expect(w.knowledge.rows<{ actor: string }>('SELECT actor FROM audit').map((r) => r.actor)).toEqual(['tessa@northfield.example'])
  })

  test('the operator’s three reach the object itself, for the owner: a bookmark, a restart whose reset is the answer, and a restore armed then restarted', async () => {
    const w = await inTheWorker()
    const jwt = await w.as('tessa@northfield.example')
    const post = (path: string, body: unknown = {}) => w.call(`/api/knowledge/store/${path}`, jwt, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await (await post('bookmark')).json()).toMatchObject({ result: 'ok', value: { bookmark: BOOKMARK } })
    expect(await (await post('restart')).json()).toMatchObject({ result: 'ok', value: { restarted: true } })
    expect(await (await post('restore', { bookmark: BOOKMARK })).json()).toMatchObject({ result: 'ok', value: { restoring: true } })
    expect(w.object).toEqual(['bookmark', 'restart', `restoreTo ${BOOKMARK}`, 'restart'])
  })

  test('and only for the owner: a teammate is refused all three and the object is not touched', async () => {
    const w = await inTheWorker(WITH_TEAMMATE)
    const jwt = await w.as('dana@northfield.example')
    for (const path of ['bookmark', 'restart', 'restore']) {
      const res = await w.call(`/api/knowledge/store/${path}`, jwt, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ bookmark: BOOKMARK }) })
      expect([path, await res.json()]).toMatchObject([path, { result: 'refused', reason: 'not-admitted' }])
    }
    expect(w.object).toEqual([])
  })

  test('a teammate who is not an owner is signed in and not admitted: the part’s own rule, after the one check', async () => {
    const w = await inTheWorker(WITH_TEAMMATE)
    const res = await w.call('/api/knowledge', await w.as('dana@northfield.example'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: 'refused', reason: 'not-admitted' })
    expect(w.knowledge.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('no sign-in, a cookie alone, forms’ audience, a stranger and a service token never reach the store', async () => {
    const w = await inTheWorker()
    const seen = { n: 0 }
    const spy = { ...w.env, KNOWLEDGE: { idFromName: () => 'x', get: () => ({ call: () => (seen.n++, Promise.reject(new Error('the store must not be asked'))) }) } as never }
    const app = createApp({ fetch: w.access.fetch as never, now: () => T0, install: createInstall(declaration), parts: createParts({ fetch: w.access.fetch as never, now: () => T0, install: createInstall(declaration) }) })
    for (const jwt of [null, await w.asForms('tessa@northfield.example'), await w.access.sign({ email: 'eve@elsewhere.test' }), await w.access.sign({ common_name: 'claude-script-client-id' })]) {
      const res = await app.fetch(new Request(`${ORIGIN}/api/knowledge`, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} }), spy)
      expect([jwt === null ? 'none' : 'some', [401, 403].includes(res.status)]).toEqual([jwt === null ? 'none' : 'some', true])
    }
    expect(seen.n).toBe(0)
  })

  test('where the store is not bound (between the transfer’s steps 3 and 5) the tab says it is not connected and the rest of the space works', async () => {
    const w = await inTheWorker()
    const { KNOWLEDGE: _gone, ...unbound } = w.env
    const app = createApp({ fetch: w.access.fetch as never, now: () => T0, install: createInstall(declaration), parts: createParts({ fetch: w.access.fetch as never, now: () => T0, install: createInstall(declaration) }) })
    const jwt = await w.as('tessa@northfield.example')
    const res = await app.fetch(new Request(`${ORIGIN}/api/knowledge`, { headers: { 'cf-access-jwt-assertion': jwt } }), unbound)
    expect(await res.json()).toMatchObject({ result: 'unreachable', message: expect.stringContaining('not connected') })
    expect((await app.fetch(new Request(`${ORIGIN}/api/me`, { headers: { 'cf-access-jwt-assertion': jwt } }), unbound)).status).toBe(200)
  })
})

describe('forms, in the Worker', () => {
  test('the operator API answers for the person the Forms sign-in named, over forms’ own database, and records them as the actor', async () => {
    const w = await inTheWorker()
    const jwt = await w.asForms('tessa@northfield.example')
    expect(await (await w.call('/forms/api/me', jwt)).json()).toMatchObject({ email: 'tessa@northfield.example', actor: 'tessa@northfield.example' })
    const lane = w.clients.make('Pinecrest', 'Larch and Co LLP')
    expect(lane.ok).toBe(true)
    const made = await w.call('/forms/api/clients', jwt, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'lane', client_number: lane.ok ? lane.value.number : 0, reply_to: 'office@lane.example' }),
    })
    expect(made.status).toBe(201)
    const rows = (await w.forms.env().DB.prepare('SELECT actor FROM audit').all<{ actor: string }>()).results
    expect(rows.map((r) => r.actor)).toEqual(['tessa@northfield.example'])
    expect(((await (await w.call('/forms/api/clients', jwt)).json()) as unknown[]).length).toBe(1)
  })

  test('the Forms sign-in is checked once, here: no sign-in, the space’s own audience on /forms, and a stranger are all refused before forms is asked', async () => {
    const w = await inTheWorker()
    for (const jwt of [null, await w.as('tessa@northfield.example')]) expect((await w.call('/forms/api/clients', jwt)).status).toBe(401)
    expect((await w.call('/forms/api/clients', await w.access.sign({ email: 'eve@elsewhere.test', aud: [FORMS_AUD] }))).status).toBe(403)
    expect((await w.forms.env().DB.prepare('SELECT count(*) AS n FROM clients').first<{ n: number }>())?.n).toBe(0)
  })

  test('forms’ own cross-site check still holds on a write: the Origin must be the space’s', async () => {
    const w = await inTheWorker()
    const res = await w.call('/forms/api/clients', await w.asForms('tessa@northfield.example'), { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(403)
  })

  test('forms is handed its own bindings and secrets, and none of the Access audiences or the dev bypass', () => {
    const env = formsEnvOf({ FORMS_DB: 'db' as never, FORMS_FILES: 'files' as never, EMAIL: 'mail' as never, FORMS_DATA_KEY: 'k', ALLOW_UNAUTHENTICATED: '1', CF_ACCESS_AUD: AUD } as never)
    expect(Object.keys(env).sort()).toEqual(['ASSETS', 'DB', 'EMAIL', 'FILES', 'FORMS_DATA_KEY'])
    // With the Clients store bound, forms is also handed the Clients part's inbox face (read only), where a Client's names come from.
    const withClients = formsEnvOf({ FORMS_DB: 'db' as never, FORMS_FILES: 'files' as never, CLIENTS_STORE: { idFromName: () => 'x', get: () => ({}) } as never } as never)
    expect(Object.keys(withClients.CLIENTS_READ ?? {}).sort()).toEqual(['get', 'list'])
  })

  test('Forms and the Clients part, in the Worker: signing is set up for a Client by its number with the Client’s own names, Settings writes the copy in the same request, and the tick puts right what a source changed', async () => {
    const w = await inTheWorker()
    const jwt = await w.asForms('tessa@northfield.example')
    const spaceJwt = await w.as('tessa@northfield.example')
    const post = (path: string, jwt: string, body: unknown) => w.call(path, jwt, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const rowNames = () => w.forms.sql<{ display_name: string; legal_name: string; client_number: number }>('SELECT display_name, legal_name, client_number FROM clients')
    // The owner makes a Client in Settings (a name and a legal name); Forms is asked to sign for its number.
    const made = (await (await post('/api/clients/make', spaceJwt, { name: 'Sunrise Plumbing', legalName: 'Sunrise Plumbing LLC' })).json()) as { value: { number: number; revision: number } }
    const number = made.value.number
    const created = await post('/forms/api/clients', jwt, { slug: 'sunrise', client_number: number, reply_to: 'office@sunrise.example' })
    expect(created.status).toBe(201)
    expect(rowNames()).toEqual([{ display_name: 'Sunrise Plumbing', legal_name: 'Sunrise Plumbing LLC', client_number: number }])
    // Forms' own edit takes no name.
    const row = (await created.json()) as { id: string }
    expect((await w.call(`/forms/api/clients/${row.id}`, jwt, { method: 'PATCH', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'Nope' }) })).status).toBe(400)
    // An edit in Settings writes Forms' copy in the same request, as the person who edited.
    const edited = await post('/api/clients/edit', spaceJwt, { number, revision: made.value.revision, name: 'Sunrise Plumbing and Heating' })
    expect(await edited.json()).toMatchObject({ result: 'ok' })
    expect(rowNames()[0]).toMatchObject({ display_name: 'Sunrise Plumbing and Heating' })
    expect(w.forms.sql<{ actor: string; action: string }>("SELECT actor, action FROM audit WHERE action = 'client-names'")).toEqual([{ actor: 'tessa@northfield.example', action: 'client-names' }])
    // The Client's page says Forms signs for it, with the way into the settings.
    const page = (await (await w.call(`/api/clients/one?number=${number}`, spaceJwt)).json()) as { value: { signing: { available: boolean; settings: { id: string } | null } } }
    expect(page.value.signing).toMatchObject({ available: true, settings: { id: row.id } })
    // A source renames a Client it brought in (the Clients door changes the Client alone); the tick puts the copy right.
    const sourced = w.clients.push('77', says('Harbor Dental', { preferredNumber: 77, legalName: 'Harbor Dental Group' }))
    expect(sourced.ok).toBe(true)
    expect((await post('/forms/api/clients', jwt, { slug: 'harbor', client_number: 77, reply_to: 'office@harbor.example' })).status).toBe(201)
    w.clients.push('77', says('Harbor Dentistry', { preferredNumber: 77, legalName: 'Harbor Dental Group' }))
    expect(rowNames().find((r) => r.client_number === 77)?.display_name).toBe('Harbor Dental')
    await runClientNamesRepair(w.env as never, () => T0)
    expect(rowNames().find((r) => r.client_number === 77)?.display_name).toBe('Harbor Dentistry')
    expect(w.forms.sql<{ actor: string }>("SELECT actor FROM audit WHERE action = 'client-names' ORDER BY id DESC LIMIT 1")).toEqual([{ actor: 'clients:repair' }])
    expect(rowNames().find((r) => r.client_number === number)?.display_name).toBe('Sunrise Plumbing and Heating')
  })

  test('Today and a person’s page read forms’ documents in-process, for the person named, with the real reads', async () => {
    const w = await inTheWorker()
    const res = await w.call('/api/today', await w.as('tessa@northfield.example'))
    expect(res.status).toBe(200)
    // Forms answered (no documents yet): the part is "connected", not "could not be reached".
    expect(JSON.stringify(await res.json())).not.toContain('Forms could not be reached')
  })
})
