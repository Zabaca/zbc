// The page's one live socket as the Worker answers it (the space's ADR 0019): `GET /api/live` is a socket upgrade for a person the one sign-in
// check named, same-origin only, handed to the company's one live object with the person's address and the end of their sign-in, and to nothing else. The object is stood in for by a recorder; that a real
// socket reaches the real object is a live check after a deploy.
import { describe, expect, test } from 'bun:test'
import { LIVE_NAME } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { NORTHFIELD_TEAM, world } from './world'

const ORIGIN = 'https://space.northfield.example'

/** A live object namespace that records the requests the Worker hands to the object and answers like an upgrade that went through. */
function live() {
  const handed: { name: string; request: Request }[] = []
  const names: string[] = []
  const LIVE = {
    idFromName: (n: string) => (names.push(n), n),
    get: (id: string) => ({ fetch: async (request: Request) => (handed.push({ name: id, request }), new Response('upgraded', { status: 200 })) }),
  }
  return { LIVE: LIVE as never, handed, names }
}

const socket = (extra: Record<string, string> = {}) => ({ headers: { upgrade: 'websocket', origin: ORIGIN, ...extra } })

describe('the live socket', () => {
  test('a signed-in person’s upgrade is handed to the one live object, as that person, until their sign-in ends', async () => {
    const l = live()
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: l.LIVE })
    const jwt = await w.signIn('tessa@northfield.example')
    const res = await w.call('/api/live', { jwt, ...socket({ cookie: 'CF_Authorization=secret' }) })
    expect(res.status).toBe(200)
    expect(l.names).toEqual([LIVE_NAME])
    expect(l.handed).toHaveLength(1)
    const h = l.handed[0]!.request.headers
    expect(h.get('upgrade')).toBe('websocket')
    expect(h.get('x-live-person')).toBe('tessa@northfield.example')
    // The end of the assertion the check verified (seconds, in the assertion), in milliseconds.
    const ends = Number(h.get('x-live-ends'))
    expect(ends).toBeGreaterThan(T0)
    expect(ends % 1000).toBe(0)
    // The space's own cookie is not what the object is given.
    expect(h.get('cookie')).toBeNull()
  })

  test('the person is the one the check named: a header a browser sends cannot name another', async () => {
    const l = live()
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: l.LIVE })
    const jwt = await w.signIn('tessa@northfield.example')
    await w.call('/api/live', { jwt, ...socket({ 'x-live-person': 'someone@else.example', 'x-live-ends': '99999999999999' }) })
    const h = l.handed[0]!.request.headers
    expect(h.get('x-live-person')).toBe('tessa@northfield.example')
    expect(Number(h.get('x-live-ends'))).toBeLessThan(99999999999999)
  })

  test('no sign-in, only the Access cookie, an assertion for another application, a stranger and a service token never reach the object', async () => {
    const l = live()
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: l.LIVE })
    const cookie = await w.signIn('tessa@northfield.example')
    const forms = await w.signInForms('tessa@northfield.example')
    const stranger = await w.signIn('eve@elsewhere.test')
    const token = await w.signInAgent()
    for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) expect((await w.call('/api/live', { ...init, ...socket() })).status).toBe(401)
    for (const jwt of [stranger, token]) expect([401, 403]).toContain((await w.call('/api/live', { jwt, ...socket() })).status)
    expect(l.handed).toEqual([])
  })

  test('a page on another site cannot open the person’s connection with their cookie: the Origin must be this site’s', async () => {
    const l = live()
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: l.LIVE })
    const jwt = await w.signIn('tessa@northfield.example')
    for (const origin of ['https://evil.example', 'https://space.northfield.example.evil.example', 'http://space.northfield.example']) {
      expect([origin, (await w.call('/api/live', { jwt, ...socket({ origin }) })).status]).toEqual([origin, 403])
    }
    const none = await w.call('/api/live', { jwt, headers: { upgrade: 'websocket' } })
    expect(none.status).toBe(403)
    expect(l.handed).toEqual([])
  })

  test('a request that is not a socket upgrade is refused (426), a write is not accepted, and where no live object is bound the answer is 503', async () => {
    const l = live()
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: l.LIVE })
    const jwt = await w.signIn('tessa@northfield.example')
    expect((await w.call('/api/live', { jwt, headers: { origin: ORIGIN } })).status).toBe(426)
    expect((await w.call('/api/live', { jwt, method: 'POST', ...socket() })).status).toBe(405)
    expect(l.handed).toEqual([])
    const bare = await world(northfield(), NORTHFIELD_TEAM)
    expect((await bare.call('/api/live', { jwt: await bare.signIn('tessa@northfield.example'), ...socket() })).status).toBe(503)
  })

  test('the old team socket of meet is gone: its path answers nothing, and no ticket is made', async () => {
    const w = await world(northfield(), NORTHFIELD_TEAM, { LIVE: live().LIVE })
    const jwt = await w.signIn('tessa@northfield.example')
    expect((await w.call('/api/w/socket?ticket=abc', { jwt, ...socket() })).status).toBe(404)
  })
})
