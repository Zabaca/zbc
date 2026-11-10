import { describe, expect, test } from 'bun:test'
import { northfieldSettings as bundledSettings } from '../../../kit/northfield'
import { AGENT, AGENT_AUD, harness, mint, mintPush, OWNER, PUSH_ENDPOINT } from '../test-support/harness'

/**
 * The inbox has no address for people: the push hostname answers Gmail's push and nothing
 * else, and its other callers are in the space's Worker, in-process, with no hostname. These drive the router the push hostname gets with
 * requests that used to be answered at inbox.northfield.example and with ones that are Google's, through the real verifier. What an install deploys is pinned by the install's own suite; the push itself in test/push-endpoint.test.ts.
 */

const wrangler = bundledSettings as unknown as {
  routes?: { pattern: string; custom_domain?: boolean }[]
}

/** A request to the push router (the only router a hostname reaches), with whatever headers a test says. */
const hit = async (h: ReturnType<typeof harness>, url: string, init: RequestInit = {}) =>
  h.pushApp.request(url, init, h.env)

describe('nothing answers on inbox.northfield.example', () => {
  test('no route, with or without a genuine assertion of any audience, is answered there: every path is a 404', async () => {
    const h = harness()
    const assertions = [
      await mint(OWNER),
      await mint(OWNER, { audience: AGENT_AUD }),
      await mint(AGENT, { audience: AGENT_AUD }),
    ]
    for (const path of [
      '/',
      '/index.html',
      '/sw.js',
      '/manifest.webmanifest',
      '/assets/index.js',
      '/api/queue',
      '/api/me',
      '/api/gmail/connect',
      '/api/gmail/callback',
      '/api/drafts',
    ]) {
      for (const method of ['GET', 'POST']) {
        const bare = await hit(h, `https://inbox.northfield.example${path}`, { method })
        expect(bare.status, `${method} ${path}`).toBe(404)
        for (const jwt of assertions) {
          const res = await hit(h, `https://inbox.northfield.example${path}`, {
            method,
            headers: { 'cf-access-jwt-assertion': jwt },
          })
          expect(res.status, `${method} ${path} with an assertion`).toBe(404)
        }
      }
    }
  })

  test('not even Google’s push, with a genuine token, is taken on that host', async () => {
    const h = harness()
    const res = await h.push({ host: 'inbox.northfield.example' })
    expect(res.status).toBe(404)
    expect(await h.inbox.listDrafts()).toEqual([])
  })

  test('the space’s configuration binds the push hostname beside its own and no other, and inbox.northfield.example is in neither', () => {
    expect(wrangler.routes).toEqual([
      { pattern: 'space.northfield.example', custom_domain: true },
      { pattern: 'inbox-push.northfield.example', custom_domain: true },
    ])
    expect(JSON.stringify(wrangler.routes)).not.toContain('"inbox.northfield.example"')
  })
})

describe('the push host still works', () => {
  test('Google’s push, with its token, on the push hostname, is taken and acknowledged', async () => {
    const h = harness()
    const res = await h.push()
    expect(res.status).toBe(204)
    expect(new URL(PUSH_ENDPOINT).hostname).toBe('inbox-push.northfield.example')
  })

  test('anything else there is a 404, a push without its token is a 401, and every answer is unframed and unkept', async () => {
    const h = harness()
    const answers = [
      await h.push({ path: '/api/queue' }),
      await h.push({ method: 'GET' }),
      await h.push({ token: null }),
      await h.push({ token: await mintPush({ audience: 'https://elsewhere.example/' }) }),
    ]
    expect(answers.map((a) => a.status)).toEqual([404, 404, 401, 401])
    for (const a of answers) {
      expect(a.headers.get('x-frame-options')).toBe('DENY')
      expect(a.headers.get('cache-control')).toBe('no-store')
      expect(a.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    }
  })
})
