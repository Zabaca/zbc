// Claude's door on the space (src/agent.ts; packages/workspace/docs/adr/0002), driven with real requests through the real router: only the service token,
// on that one path, gets through, and the inbox's router in this Worker is handed the request at its own path with no cookie
// and no assertion, and the token the check verified. The router is a stand-in that records what it was handed; the inbox's own half (admitting only Claude's token by its id) is proven in
// packages/inbox/test/space-part.test.ts and claude-door.test.ts.
import { beforeEach, describe, expect, test } from 'bun:test'
import { northfield } from '../../workspace/test/helpers'
import { AGENT_AUD, FORMS_AUD, NORTHFIELD_TEAM, world } from './world'

const DOOR = '/agent/inbox'
const TOKEN = { common_name: 'abc123.access' }

describe('Claude’s door on the space', () => {
  const z = northfield()
  let w: Awaited<ReturnType<typeof world>>
  beforeEach(async () => {
    w = await world(z, NORTHFIELD_TEAM)
  })

  test('the token, for the agent application, is handed to the inbox at the inbox’s own path, with its query, body and method', async () => {
    const jwt = await w.signInAgent()
    const res = await w.call(`${DOOR}/api/drafts?x=1`, { method: 'POST', jwt, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Hi' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: 'the inbox' })
    expect(w.handedToClaude).toHaveLength(1)
    expect(w.handedToClaude[0]).toMatchObject({ method: 'POST', url: 'https://space.northfield.example/api/drafts?x=1', assertion: null, who: 'abc123.access', body: '{"body":"Hi"}' })
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('every method Claude’s script uses is handed on: the space’s own write rule is the inbox’s to apply on this path', async () => {
    const jwt = await w.signInAgent()
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await w.call(`${DOOR}/api/drafts/abc`, { method, jwt, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) })
      expect([method, res.status]).toEqual([method, 200])
    }
    expect(w.handedToClaude.map((r) => r.method)).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
  })

  test('the cookie, the token’s own two headers and the assertion are dropped (the check was made here, once), and the answer comes back as the inbox gave it', async () => {
    const jwt = await w.signInAgent()
    await w.call(`${DOOR}/api/queue`, { jwt, headers: { cookie: 'CF_Authorization=secret; other=1', 'cf-access-client-id': 'abc123.access', 'cf-access-client-secret': 'shh' } })
    expect(w.handedToClaude[0]?.cookie).toBeNull()
    expect(w.handedToClaude[0]?.headers).not.toHaveProperty('cf-access-client-secret')
    expect(w.handedToClaude[0]?.headers).not.toHaveProperty('cf-access-client-id')
    expect(w.handedToClaude[0]?.assertion).toBeNull()
    expect(w.handedToClaude[0]?.headers).not.toHaveProperty('cf-access-jwt-assertion')
  })

  test('a person’s sign-in is refused on the door, the space’s, the Forms’ and the agent’s own audience alike', async () => {
    for (const jwt of [
      await w.signIn('tessa@northfield.example'),
      await w.signInForms('tessa@northfield.example'),
      await w.signInAgent({ email: 'tessa@northfield.example' }),
    ]) {
      const res = await w.call(`${DOOR}/api/queue`, { jwt })
      expect([401, 403]).toContain(res.status)
    }
    expect(w.handedToClaude).toEqual([])
  })

  test('an assertion naming a person and the token at once is refused', async () => {
    const res = await w.call(`${DOOR}/api/queue`, { jwt: await w.signInAgent({ email: 'tessa@northfield.example', common_name: 'abc123.access' }) })
    expect(res.status).toBe(403)
    expect(w.handedToClaude).toEqual([])
  })

  test('no assertion, a forged one, and the cookie alone are refused', async () => {
    expect((await w.call(`${DOOR}/api/queue`)).status).toBe(401)
    expect((await w.call(`${DOOR}/api/queue`, { jwt: 'not-a-jwt' })).status).toBe(401)
    expect((await w.call(`${DOOR}/api/queue`, { cookieJwt: await w.signInAgent() })).status).toBe(401)
    expect((await w.call(`${DOOR}/api/queue`, { jwt: await w.signInAgent(TOKEN, 'e'.repeat(64)) })).status).toBe(401)
    expect(w.handedToClaude).toEqual([])
  })

  test('a token for the space’s audience or Forms’ is not the agent’s: the audience is what makes the path', async () => {
    const forSpace = await w.access.sign({ ...TOKEN })
    const forForms = await w.access.sign({ ...TOKEN, aud: [FORMS_AUD] })
    for (const jwt of [forSpace, forForms]) expect((await w.call(`${DOOR}/api/queue`, { jwt })).status).toBe(401)
    expect(w.handedToClaude).toEqual([])
  })

  test('an unset or malformed agent audience refuses the token itself', async () => {
    for (const aud of [undefined, '', 'placeholder', AGENT_AUD.slice(1)]) {
      const own = await world(z, NORTHFIELD_TEAM, { CF_ACCESS_AUD_AGENT: aud })
      expect((await own.call(`${DOOR}/api/queue`, { jwt: await own.signInAgent() })).status, String(aud)).toBe(401)
      expect(own.handedToClaude).toEqual([])
    }
  })

  test('the token is refused everywhere else on the host, however genuine its assertion', async () => {
    const jwt = await w.signInAgent()
    const spaceJwt = await w.access.sign({ ...TOKEN })
    for (const path of ['/', '/today', '/api/me', '/api/conversations', '/api/inbox/mailboxes', '/forms/api/clients', '/api/agent/inbox/api/queue', '/agent', '/agent/', '/agent/other/api/queue', '/agent/inboxx/api/queue', '/x/agent/inbox/api/queue']) {
      for (const assertion of [jwt, spaceJwt]) {
        const res = await w.call(path, { jwt: assertion })
        expect([path, res.status === 401 || res.status === 403]).toEqual([path, true])
      }
    }
    expect(w.handedToClaude).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('a path under the door that is not the inbox’s API is a 404 and goes nowhere; the page is not drawn there', async () => {
    const jwt = await w.signInAgent()
    for (const path of [DOOR, `${DOOR}/`, `${DOOR}/index.html`, `${DOOR}/assets/x.js`, `${DOOR}/apix`, `${DOOR}/api`]) {
      const res = await w.call(path, { jwt })
      expect([path, res.status]).toEqual([path, 404])
    }
    expect(w.handedToClaude).toEqual([])
    expect(w.asked).toEqual([])
  })

  test('a path that climbs out of the door by dot segments or encoding is not the door: it is whatever it resolves to, and the token is refused there', async () => {
    const jwt = await w.signInAgent()
    for (const path of [`${DOOR}/../../api/me`, `${DOOR}/%2e%2e/%2e%2e/api/me`, '/agent%2Finbox/api/queue']) {
      const res = await w.call(path, { jwt })
      expect([path, res.status === 401 || res.status === 403 || res.status === 404]).toEqual([path, true])
    }
    expect(w.handedToClaude).toEqual([])
  })

  test('the door matches without regard to case, as Access does, and keeps what follows it as written', async () => {
    const res = await w.call('/AGENT/Inbox/api/Queue', { jwt: await w.signInAgent() })
    expect(res.status).toBe(200)
    expect(w.handedToClaude[0]?.url).toBe('https://space.northfield.example/api/Queue')
  })

  test('with the inbox’s store not bound the door says so, rather than serve the page', async () => {
    const own = await world(z, NORTHFIELD_TEAM, { parts: { claude: undefined } })
    const res = await own.call(`${DOOR}/api/queue`, { jwt: await own.signInAgent() })
    expect(res.status).toBe(503)
  })

  test('the inbox’s refusal and errors pass through as they are', async () => {
    const own = await world(z, NORTHFIELD_TEAM, { parts: { claude: async () => Response.json({ error: 'no' }, { status: 409 }) } })
    const res = await own.call(`${DOOR}/api/queue`, { jwt: await own.signInAgent() })
    expect([res.status, await res.json()]).toEqual([409, { error: 'no' }])
  })

  test('people are still let in exactly as before: the door took nothing from the person check', async () => {
    const jwt = await w.signIn('tessa@northfield.example')
    expect((await w.call('/today', { jwt })).status).toBe(200)
    expect((await w.call('/api/me', { jwt })).status).toBe(200)
    expect(w.handedToClaude).toEqual([])
  })
})
