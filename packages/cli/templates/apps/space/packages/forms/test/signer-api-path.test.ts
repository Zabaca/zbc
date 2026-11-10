// The signer's public API at /s/api (the space's ADR 0018): the space opens `/s/` to signers and nothing else of its host, so the API they
// use is under it, with the rate limit and the refusals every public route has. The old /api is gone: there is no address of forms' own for it to answer at.
// Driven through the real router like the rest of the signing tests.
import { beforeEach, describe, expect, test } from 'bun:test'
import { SIGNER_API } from '../src/paths'
import { harness } from './harness'
import { solidPng } from './png'
import { kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())
const IP = { 'cf-connecting-ip': '203.0.113.7' }

describe('/s/api', () => {
  test('is the address the page and the emails use', () => {
    expect(SIGNER_API).toBe('/s/api')
  })

  test('answers a signer’s link, and a link that leads nowhere in the same plain words', async () => {
    await k.sent()
    const token = k.tokenFor('alice@example.test')
    const now = await h.call(null, 'GET', `/s/api/s/${token}`, undefined, { headers: IP })
    expect(now.status).toBe(200)
    expect(now.body.state).toBe('consent')
    expect(now.headers.get('cache-control')).toBe('no-store')
    expect(now.headers.get('referrer-policy')).toBe('no-referrer')
    const none = await h.call(null, 'GET', `/s/api/s/${'a'.repeat(43)}`, undefined, { headers: IP })
    expect(none.status).toBe(404)
    expect(none.body.error).toContain('not valid')
  })

  test('the old /api is not a route: a signer’s link, a logo and the rest answer nothing there', async () => {
    await k.sent()
    const token = k.tokenFor('alice@example.test')
    for (const path of [`/api/s/${token}`, '/api/logo/anything', '/api/nothing-here']) {
      const r = await h.call(null, 'GET', path, undefined, { headers: IP })
      expect([path, r.status]).toEqual([path, 404])
    }
  })

  test('takes the signer’s writes: a signer goes through every step at the new address', async () => {
    await k.sent()
    const token = k.tokenFor('alice@example.test')
    const s = (method: string, path: string, body?: unknown) => h.call(null, method, `/s/api/s/${token}${path}`, body, { headers: IP })
    expect((await s('POST', '/open')).status).toBe(200)
    expect((await s('POST', '/consent')).status).toBe(200)
    expect((await s('GET', '/document')).status).toBe(200)
  })

  test('serves a client’s logo with no sign-in, and a missing one is a plain 404', async () => {
    expect((await h.call(null, 'GET', '/s/api/logo/not-there')).status).toBe(404)
  })

  test('is refused past the rate limit and keyed by the caller’s address', async () => {
    const keys: string[] = []
    const spy = harness({ PUBLIC_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: keys.length < 2 }) } })
    await spy.call(null, 'GET', '/s/api/logo/x', undefined, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
    const second = await spy.call(null, 'GET', '/s/api/logo/x', undefined, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
    expect(keys).toEqual(['203.0.113.9', '203.0.113.9'])
    expect(second.status).toBe(429)
  })

  test('opens nothing of the operator’s: /s/admin/api and /s/api/admin/api are not routes, and the admin API still needs its own sign-in', async () => {
    for (const path of ['/s/admin/api/clients', '/s/api/admin/api/clients', '/s/api/../admin/api/clients']) {
      const r = await h.call(null, 'GET', path)
      expect([path, r.status === 404 || r.status === 401]).toEqual([path, true])
      expect(JSON.stringify(r.body)).not.toContain('display_name')
    }
    expect((await h.call(null, 'GET', '/admin/api/clients')).status).toBe(401)
  })

  test('a client’s logo is named under /s/api everywhere it is shown: the page’s view, and the email’s image', async () => {
    const client = await h.makeClient({ copy_addresses: ['books@pinecrest.example'] })
    const put = await h.request({ 'cf-access-jwt-assertion': await h.sign({ email: 'tessa@northfield.example' }) }, 'PUT', `/admin/api/clients/${client.id}/logo`, solidPng(60, 30, [200, 0, 0]) as BodyInit)
    expect(put.status).toBe(200)
    await k.sent({ client })
    const token = k.tokenFor('alice@example.test')
    const view = await h.call(null, 'GET', `/s/api/s/${token}`, undefined, { headers: IP })
    expect(view.body.brand.logo).toMatch(new RegExp(`^/s/api/logo/${client.id}\\?v=[0-9a-f]+$`))
    // What the page shows is served at the address the view names, with no sign-in.
    const served = await h.call(null, 'GET', view.body.brand.logo, undefined, { headers: IP })
    expect(served.status).toBe(200)
    const mail = h.outbox.find((m) => m.to.email === 'alice@example.test')
    expect(mail?.html).toContain(`${h.core().origin}/s/api/logo/${client.id}?v=`)
    expect(mail?.text).toContain(`${h.core().origin}/s/`)
  })
})
