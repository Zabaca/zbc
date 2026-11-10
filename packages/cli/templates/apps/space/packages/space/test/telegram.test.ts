// The Telegram bridge's door on the space (src/telegram.ts; packages/workspace/docs/adr/0002, amended), driven with real requests through the real router: only the bridge's service token, on its one path, gets
// through, and the inbox's bridge router in this Worker is handed the request at its own path with no cookie and no assertion, and the token the check verified. The router is a stand-in that records what it
// was handed; the inbox's own half (admitting only the bridge's token by its id, five calls) is proven in packages/inbox/test/telegram-door.test.ts and space-part.test.ts. Claude's door has the same tests in agent.test.ts.
import { beforeEach, describe, expect, test } from 'bun:test'
import { northfield } from '../../workspace/test/helpers'
import { AGENT_AUD, FORMS_AUD, TELEGRAM_AUD, NORTHFIELD_TEAM, world } from './world'

const DOOR = '/agent/telegram'
const TOKEN = { common_name: 'bridge123.access' }

describe('the Telegram bridge’s door on the space', () => {
  const z = northfield()
  let w: Awaited<ReturnType<typeof world>>
  beforeEach(async () => {
    w = await world(z, NORTHFIELD_TEAM)
  })

  test('the token, for the bridge application, is handed to the inbox at the inbox’s own path, with its query, body and method, and Claude’s router is not asked', async () => {
    const jwt = await w.signInBridge()
    const res = await w.call(`${DOOR}/api/push?x=1`, { method: 'POST', jwt, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chats: [] }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: 'the inbox, for the bridge' })
    expect(w.handedToBridge).toHaveLength(1)
    expect(w.handedToBridge[0]).toMatchObject({ method: 'POST', url: 'https://space.northfield.example/api/push?x=1', assertion: null, who: 'bridge123.access', body: '{"chats":[]}' })
    expect(w.handedToClaude).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('the cookie, the token’s own two headers and the assertion are dropped (the check was made here, once)', async () => {
    const jwt = await w.signInBridge()
    await w.call(`${DOOR}/api/work`, { method: 'POST', jwt, headers: { cookie: 'CF_Authorization=secret; other=1', 'cf-access-client-id': 'bridge123.access', 'cf-access-client-secret': 'shh' } })
    expect(w.handedToBridge[0]?.cookie).toBeNull()
    expect(w.handedToBridge[0]?.headers).not.toHaveProperty('cf-access-client-secret')
    expect(w.handedToBridge[0]?.headers).not.toHaveProperty('cf-access-client-id')
    expect(w.handedToBridge[0]?.headers).not.toHaveProperty('cf-access-jwt-assertion')
  })

  test('a person’s sign-in is refused on the door, whatever application it was minted for', async () => {
    for (const jwt of [
      await w.signIn('tessa@northfield.example'),
      await w.signInForms('tessa@northfield.example'),
      await w.signInBridge({ email: 'tessa@northfield.example' }),
    ]) {
      const res = await w.call(`${DOOR}/api/work`, { method: 'POST', jwt })
      expect([401, 403]).toContain(res.status)
    }
    expect(w.handedToBridge).toEqual([])
  })

  test('an assertion naming a person and the token at once is refused', async () => {
    const res = await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: await w.signInBridge({ email: 'tessa@northfield.example', common_name: 'bridge123.access' }) })
    expect(res.status).toBe(403)
    expect(w.handedToBridge).toEqual([])
  })

  test('no assertion, a forged one, and the cookie alone are refused', async () => {
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST' })).status).toBe(401)
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: 'not-a-jwt' })).status).toBe(401)
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST', cookieJwt: await w.signInBridge() })).status).toBe(401)
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: await w.signInBridge(TOKEN, 'c'.repeat(64)) })).status).toBe(401)
    expect(w.handedToBridge).toEqual([])
  })

  test('Claude’s door and the bridge’s are two applications: an assertion minted for one does not verify on the other', async () => {
    // Claude's token, for Claude's application, on the bridge's path.
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: await w.signInAgent() })).status).toBe(401)
    // The bridge's token, for the bridge's application, on Claude's path.
    expect((await w.call('/agent/inbox/api/queue', { jwt: await w.signInBridge() })).status).toBe(401)
    // And neither is the space's or Forms'.
    for (const aud of [FORMS_AUD, AGENT_AUD]) {
      expect((await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: await w.signInBridge(TOKEN, aud) })).status).toBe(401)
    }
    expect((await w.call(`${DOOR}/api/work`, { method: 'POST', jwt: await w.access.sign({ ...TOKEN }) })).status).toBe(401)
    expect(w.handedToBridge).toEqual([])
    expect(w.handedToClaude).toEqual([])
  })

  test('an unset or malformed bridge audience refuses the token itself', async () => {
    for (const aud of [undefined, '', 'placeholder', TELEGRAM_AUD.slice(1)]) {
      const own = await world(z, NORTHFIELD_TEAM, { CF_ACCESS_AUD_TELEGRAM: aud })
      expect((await own.call(`${DOOR}/api/work`, { method: 'POST', jwt: await own.signInBridge() })).status, String(aud)).toBe(401)
      expect(own.handedToBridge).toEqual([])
    }
  })

  test('the token is refused everywhere else on the host, however genuine its assertion', async () => {
    const jwt = await w.signInBridge()
    const spaceJwt = await w.access.sign({ ...TOKEN })
    for (const path of ['/', '/today', '/api/me', '/api/conversations', '/api/inbox/mailboxes', '/forms/api/clients', '/agent', '/agent/', '/agent/other/api/work', '/agent/telegramx/api/work', '/x/agent/telegram/api/work', '/agent/inbox/api/queue']) {
      for (const assertion of [jwt, spaceJwt]) {
        const res = await w.call(path, { jwt: assertion })
        expect([path, res.status === 401 || res.status === 403]).toEqual([path, true])
      }
    }
    expect(w.handedToBridge).toEqual([])
    expect(w.handedToClaude).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('a path under the door that is not the inbox’s API is a 404 and goes nowhere', async () => {
    const jwt = await w.signInBridge()
    for (const path of [DOOR, `${DOOR}/`, `${DOOR}/index.html`, `${DOOR}/assets/x.js`, `${DOOR}/apix`, `${DOOR}/api`]) {
      const res = await w.call(path, { jwt })
      expect([path, res.status]).toEqual([path, 404])
    }
    expect(w.handedToBridge).toEqual([])
  })

  test('a path that climbs out of the door by dot segments or encoding is not the door', async () => {
    const jwt = await w.signInBridge()
    for (const path of [`${DOOR}/../../api/me`, `${DOOR}/%2e%2e/%2e%2e/api/me`, '/agent%2Ftelegram/api/work']) {
      const res = await w.call(path, { method: 'POST', jwt })
      expect([path, res.status === 401 || res.status === 403 || res.status === 404]).toEqual([path, true])
    }
    expect(w.handedToBridge).toEqual([])
  })

  test('the door is case-blind as Access is, and is the same door', async () => {
    const res = await w.call('/AGENT/Telegram/api/work', { method: 'POST', jwt: await w.signInBridge() })
    expect(res.status).toBe(200)
    expect(w.handedToBridge[0]?.url).toBe('https://space.northfield.example/api/work')
  })

  test('where the inbox is not bound, the door says so and stores nothing', async () => {
    const own = await world(z, NORTHFIELD_TEAM, { parts: { telegram: undefined } })
    expect((await own.call(`${DOOR}/api/work`, { method: 'POST', jwt: await own.signInBridge() })).status).toBe(503)
  })

  test('a client’s space has no such door: the path is just a path, and a token is refused on it', async () => {
    const { lane } = await import('../../workspace/test/helpers')
    const own = await world(lane(), 'brightwater.cloudflareaccess.com')
    const res = await own.call(`${DOOR}/api/work`, { method: 'POST', jwt: await own.signInBridge() })
    expect([401, 403, 404]).toContain(res.status)
    expect(own.handedToBridge).toEqual([])
  })
})
