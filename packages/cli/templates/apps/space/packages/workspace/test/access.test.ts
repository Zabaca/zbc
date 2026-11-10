import { beforeEach, describe, expect, test } from 'bun:test'
import { assertionFrom, identify, JWKS_TIMEOUT_MS, resetJwksCache } from '../src'
import { asserted, AUD, lane, T0, team, northfield } from './helpers'

beforeEach(() => resetJwksCache())

const deps = (fetch: (u: string) => Promise<Response>, aud = AUD, now = T0) => ({ fetch: fetch as never, aud, now })

/** A fetch that holds its answer until `release()`, to start several checks while the key fetch is still under way. */
function gated(answer: (u: string) => Promise<Response>) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let asked = 0
  return {
    fetch: async (u: string) => {
      asked++
      await gate
      return answer(u)
    },
    release,
    asked: () => asked,
  }
}
const down = async () => new Response('down', { status: 503 })

describe('the sign-in check', () => {
  test("a good assertion names a person of this install, with the assertion's expiry", async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const r = await identify(northfield(), asserted(await t.sign({ email: 'tessa@northfield.example' })), deps(t.fetch))
    expect(r.ok && r.identity.kind === 'person' && r.identity.person.address).toBe('tessa@northfield.example')
    expect(r.ok && r.identity.exp).toBe(Math.floor(T0 / 1000) + 3600)
  })

  test('only the header Access sets is read: a cookie, even a valid token in the exact name, is no assertion', async () => {
    expect(assertionFrom(new Headers({ cookie: 'a=1; CF_Authorization=tok; b=2' }))).toBeNull()
    expect(assertionFrom(new Headers({ 'cf-access-jwt-assertion': 'h', cookie: 'CF_Authorization=c' }))).toBe('h')
    expect(assertionFrom(new Headers())).toBeNull()
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    const r = await identify(northfield(), new Headers({ cookie: `CF_Authorization=${jwt}` }), deps(t.fetch))
    expect(r).toMatchObject({ ok: false, refusal: 'no-assertion' })
    expect((await identify(northfield(), asserted(jwt), deps(t.fetch))).ok).toBe(true)
  })

  test('no assertion, a forged one, an expired one and one for another application are all refused', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const stranger = await team('northfield.cloudflareaccess.com')
    const cases: Record<string, Headers> = {
      none: new Headers(),
      'signed by a key Access does not publish': asserted(await t.sign({ email: 'tessa@northfield.example' }, { key: stranger.privateKey })),
      expired: asserted(await t.sign({ email: 'tessa@northfield.example' }, { exp: Math.floor(T0 / 1000) - 10 })),
      "another application's audience": asserted(await t.sign({ email: 'tessa@northfield.example', aud: ['b'.repeat(64)] })),
      'another team': asserted(await t.sign({ email: 'tessa@northfield.example', iss: 'https://your-team.cloudflareaccess.com' })),
      'an unknown key id': asserted(await t.sign({ email: 'tessa@northfield.example' }, { kid: 'nope' })),
      garbage: asserted('not.a.jwt'),
    }
    for (const [why, headers] of Object.entries(cases)) {
      const r = await identify(northfield(), headers, deps(t.fetch))
      expect([why, r.ok]).toEqual([why, false])
    }
  })

  test('fails closed with no audience configured, real assertion or not', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    for (const aud of ['', 'nope']) {
      expect((await identify(northfield(), asserted(jwt), deps(t.fetch, aud))).ok).toBe(false)
    }
  })

  test('a broken key server is a refusal, not a wait', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    const r = await identify(northfield(), asserted(jwt), deps(async () => new Response('down', { status: 503 })))
    expect(r.ok).toBe(false)
  })

  test('the keys are fetched once for many requests', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    for (let i = 0; i < 3; i++) await identify(northfield(), asserted(await t.sign({ email: 'tessa@northfield.example' })), deps(t.fetch))
    expect(t.fetches()).toBe(1)
  })

  test('a failing key server is asked once a minute at most, not once a request', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    let asked = 0
    const down = async () => {
      asked++
      return new Response('down', { status: 503 })
    }
    const at = (now: number) => ({ fetch: down as never, aud: AUD, now })
    for (let i = 0; i < 5; i++) expect((await identify(northfield(), asserted(jwt), at(T0 + i * 1000))).ok).toBe(false)
    expect(asked).toBe(1)
    expect((await identify(northfield(), asserted(jwt), at(T0 + 61_000))).ok).toBe(false)
    expect(asked).toBe(2)
  })

  test('concurrent checks on an empty cache share one key fetch and all pass', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    const slow = gated(t.fetch)
    const calls = Array.from({ length: 5 }, () => identify(northfield(), asserted(jwt), deps(slow.fetch)))
    slow.release()
    expect((await Promise.all(calls)).map((r) => r.ok)).toEqual([true, true, true, true, true])
    expect(t.fetches()).toBe(1)
    // The in-flight entry is gone and the keys are cached: later checks fetch nothing.
    expect((await identify(northfield(), asserted(jwt), deps(t.fetch))).ok).toBe(true)
    expect(t.fetches()).toBe(1)
  })

  test('two team domains checked at once each get their own fetch', async () => {
    const z = await team('northfield.cloudflareaccess.com')
    const l = await team('brightwater.cloudflareaccess.com')
    const zJwt = await z.sign({ email: 'tessa@northfield.example' })
    const lJwt = await l.sign({ email: 'lane@pinecrest.test' })
    const zSlow = gated(z.fetch)
    const lSlow = gated(l.fetch)
    const calls = [
      identify(northfield(), asserted(zJwt), deps(zSlow.fetch)),
      identify(lane(), asserted(lJwt), deps(lSlow.fetch)),
      identify(northfield(), asserted(zJwt), deps(zSlow.fetch)),
      identify(lane(), asserted(lJwt), deps(lSlow.fetch)),
    ]
    zSlow.release()
    lSlow.release()
    expect((await Promise.all(calls)).map((r) => r.ok)).toEqual([true, true, true, true])
    expect([z.fetches(), l.fetches()]).toEqual([1, 1])
  })

  test('a failed in-flight fetch refuses every waiter, then the minute limit holds and the next minute retries', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    const failing = gated(down)
    const calls = Array.from({ length: 4 }, () => identify(northfield(), asserted(jwt), deps(failing.fetch)))
    failing.release()
    expect((await Promise.all(calls)).map((r) => r.ok)).toEqual([false, false, false, false])
    expect(failing.asked()).toBe(1)
    // Settled: the failure is not retried within the minute, and is after it.
    expect((await identify(northfield(), asserted(jwt), deps(failing.fetch, AUD, T0 + 1000))).ok).toBe(false)
    expect(failing.asked()).toBe(1)
    expect((await identify(northfield(), asserted(jwt), deps(t.fetch, AUD, T0 + 61_000))).ok).toBe(true)
    expect(t.fetches()).toBe(1)
  })

  test('waiters on a failing refresh, with expired keys held, fall back to them', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const hour = 60 * 60 * 1000
    const jwt = await t.sign({ email: 'tessa@northfield.example' }, { exp: Math.floor(T0 / 1000) + 10 * 3600 })
    expect((await identify(northfield(), asserted(jwt), deps(t.fetch))).ok).toBe(true)
    const failing = gated(down)
    const later = T0 + hour + 1000
    const calls = Array.from({ length: 3 }, () => identify(northfield(), asserted(jwt), deps(failing.fetch, AUD, later)))
    failing.release()
    expect((await Promise.all(calls)).map((r) => r.ok)).toEqual([true, true, true])
    expect(failing.asked()).toBe(1)
  })

  test('after a completed fetch an unknown key id is still limited to one fetch a minute', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const good = await t.sign({ email: 'tessa@northfield.example' })
    const unknown = await t.sign({ email: 'tessa@northfield.example' }, { kid: 'nope' })
    expect((await identify(northfield(), asserted(good), deps(t.fetch))).ok).toBe(true)
    expect(t.fetches()).toBe(1)
    // Concurrent forged kids: the minute is not up, so no fetch at all.
    const forged = await Promise.all(Array.from({ length: 3 }, () => identify(northfield(), asserted(unknown), deps(t.fetch))))
    expect(forged.map((r) => r.ok)).toEqual([false, false, false])
    expect(t.fetches()).toBe(1)
    // Past the minute they share a single refresh.
    await Promise.all(Array.from({ length: 3 }, () => identify(northfield(), asserted(unknown), deps(t.fetch, AUD, T0 + 61_000))))
    expect(t.fetches()).toBe(2)
  })

  test('a key fetch that never settles (its request was cancelled) refuses its waiters within the timeout and does not wedge later checks', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const jwt = await t.sign({ email: 'tessa@northfield.example' })
    let asked = 0
    const hangs = () => {
      asked++
      return new Promise<Response>(() => {})
    }
    const started = Date.now()
    const calls = Array.from({ length: 3 }, () => identify(northfield(), asserted(jwt), deps(hangs)))
    expect((await Promise.all(calls)).map((r) => r.ok)).toEqual([false, false, false])
    expect(Date.now() - started).toBeLessThan(JWKS_TIMEOUT_MS + 1500)
    expect(asked).toBe(1)
    // Within the timeout the dead entry is still waited on; past it, the next check starts a fetch of its own, minute limit or not.
    const r = await identify(northfield(), asserted(jwt), deps(t.fetch, AUD, T0 + JWKS_TIMEOUT_MS))
    expect(r.ok).toBe(true)
    expect(t.fetches()).toBe(1)
  }, 10_000)

  test('a failed refresh after the keys expire falls back to the last good keys, and a good one replaces them', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const hour = 60 * 60 * 1000
    const jwt = await t.sign({ email: 'tessa@northfield.example' }, { exp: Math.floor(T0 / 1000) + 10 * 3600 })
    expect((await identify(northfield(), asserted(jwt), deps(t.fetch))).ok).toBe(true)
    let asked = 0
    const down = async () => {
      asked++
      return new Response('down', { status: 503 })
    }
    const at = (now: number, fetch: (u: string) => Promise<Response>) => ({ fetch: fetch as never, aud: AUD, now })
    // The hour is up and the key server is down: still in, and the failure is not retried within the minute.
    expect((await identify(northfield(), asserted(jwt), at(T0 + hour + 1000, down))).ok).toBe(true)
    expect((await identify(northfield(), asserted(jwt), at(T0 + hour + 2000, down))).ok).toBe(true)
    expect(asked).toBe(1)
    // A key the held set does not have is still refused while the server is down.
    const unknown = await t.sign({ email: 'tessa@northfield.example' }, { kid: 'k2', exp: Math.floor(T0 / 1000) + 10 * 3600 })
    expect((await identify(northfield(), asserted(unknown), at(T0 + hour + 120_000, down))).ok).toBe(false)
    // When the server answers again the keys are replaced.
    expect((await identify(northfield(), asserted(jwt), at(T0 + hour + 240_000, t.fetch))).ok).toBe(true)
    expect(t.fetches()).toBe(2)
  })

  test('a person of the other company is refused, though Cloudflare signed it', async () => {
    // One Zero Trust organisation could serve both, so the signature alone proves nothing about membership.
    const t = await team('northfield.cloudflareaccess.com')
    const asLane = await t.sign({ email: 'lane@pinecrest.test' })
    const r = await identify(northfield(), asserted(asLane), deps(t.fetch))
    expect(r).toMatchObject({ ok: false, refusal: 'not-a-person-here' })
  })

  test("each install trusts only its own team's keys", async () => {
    const zTeam = await team('northfield.cloudflareaccess.com')
    const lTeam = await team('brightwater.cloudflareaccess.com')
    const laneJwt = await lTeam.sign({ email: 'lane@pinecrest.test' })
    const tessaJwt = await zTeam.sign({ email: 'tessa@northfield.example' })

    const ok = await identify(lane(), asserted(laneJwt), deps(lTeam.fetch))
    expect(ok.ok && ok.identity.kind === 'person' && ok.identity.person.name).toBe('Lane')

    // Northfield's own signed assertion, presented to Lane's install, fails on issuer and on membership.
    expect((await identify(lane(), asserted(tessaJwt), deps(lTeam.fetch))).ok).toBe(false)
    expect((await identify(northfield(), asserted(laneJwt), deps(zTeam.fetch))).ok).toBe(false)
  })

  test('a person signs in at their declared address, not their work address', async () => {
    const t = await team('brightwater.cloudflareaccess.com')
    const viaGmail = await identify(lane(), asserted(await t.sign({ email: 'corin.private@example.com' })), deps(t.fetch))
    expect(viaGmail.ok && viaGmail.identity.kind === 'person' && viaGmail.identity.person.address).toBe('corin@pinecrest.test')
    const viaWork = await identify(lane(), asserted(await t.sign({ email: 'corin@pinecrest.test' })), deps(t.fetch))
    expect(viaWork).toMatchObject({ ok: false, refusal: 'not-a-person-here' })
  })

  test('a service token is no person, and comes back only where the app takes one', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const token = asserted(await t.sign({ common_name: 'abc.access' }))
    expect(await identify(northfield(), token, deps(t.fetch))).toMatchObject({ ok: false, refusal: 'service-token' })
    const r = await identify(northfield(), token, deps(t.fetch), { allowServiceTokens: true })
    expect(r.ok && r.identity).toMatchObject({ kind: 'service', commonName: 'abc.access' })
    // A token whose name is Tessa's address is still not Tessa.
    const named = asserted(await t.sign({ common_name: 'tessa@northfield.example' }))
    const n = await identify(northfield(), named, deps(t.fetch), { allowServiceTokens: true })
    expect(n.ok && n.identity.kind).toBe('service')
  })

  test('an assertion naming a person and a token is refused', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    const both = asserted(await t.sign({ email: 'tessa@northfield.example', common_name: 'abc.access' }))
    expect(await identify(northfield(), both, deps(t.fetch), { allowServiceTokens: true })).toMatchObject({ ok: false, refusal: 'ambiguous' })
  })

  test('verified, but neither a person nor a token, is refused', async () => {
    const t = await team('northfield.cloudflareaccess.com')
    expect((await identify(northfield(), asserted(await t.sign({})), deps(t.fetch), { allowServiceTokens: true })).ok).toBe(false)
  })
})
