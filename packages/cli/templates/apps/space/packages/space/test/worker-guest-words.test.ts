// The two public reads that carry the install's words to people who are not signed in, driven through the path the deployed Worker takes: `createWorker` over the router made exactly as src/index.ts makes it
// (`createApp()` with its own default deps), the guests' and signers' parts the real ones (src/parts.ts `createGuestParts`, not a stand-in), and the request a bare Cloudflare edge hands the Worker for a visitor
// with no sign-in. The signer's pages (and the "via Northfield Forms" in their header) ask `GET /s/api/service`, the channel guests' pages
// ask `GET /w/api/site`. On the live host, for a while after the deploy that first carried them, both were answered with forms' catch-all 404 and meet's session-guard 401 (what a Worker without the two routes says),
// while the suites that drove forms' or meet's sub-app alone, or a stand-in behind the door, passed. Each is a route that answers only if it is registered ahead of its sub-app's own catch-all, so the answer is
// read here, where the Worker serves it.
import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { createWorker, type WorkerEnv } from '../src/worker'

/** What the Worker's environment holds for the two guest sides to be answered: the stores bound (their being present is all the door asks), the assets, and forms' per-caller limit as a binding would answer it. */
const env = {
  ASSETS: { fetch: async () => new Response('asset') },
  WORKSPACE: {},
  ROOMS: {},
  FORMS_DB: {},
  FORMS_FILES: {},
  PUBLIC_LIMIT: { limit: async () => ({ success: true }) },
} as unknown as WorkerEnv

const app = createApp()
const worker = createWorker<WorkerEnv>({ team: (request, e, ctx) => app.fetch(request, e, ctx) })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

/** A visitor with no sign-in: nothing but what the edge adds. */
const visit = (path: string) => worker.fetch(new Request(`https://space.northfield.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0' } }), env, ctx)

describe('the public reads of the install’s words, through the Worker', () => {
  test('GET /s/api/service answers the service’s words, not the catch-all’s "Route not found"', async () => {
    const res = await visit('/s/api/service')
    expect(res.status).toBe(200)
    const words = (await res.json()) as { name: string; sender: string; runBy: { legalName: string } }
    expect([words.name, words.sender, words.runBy.legalName]).toEqual(['Northfield Forms', 'forms@northfield.example', 'Northfield Works LLC'])
  })

  test('GET /w/api/site answers the company and the owner’s name, not the guests’ "You are signed out."', async () => {
    const res = await visit('/w/api/site')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ company: 'Northfield Works', owner: { name: 'Tessa' } })
  })

  test('the routes registered after them still answer in their own words, so the two above are not an open door', async () => {
    expect(await (await visit('/s/api/nothing')).json()).toEqual({ error: 'Route not found' })
    expect(await (await visit('/w/api/me')).json()).toEqual({ error: 'You are signed out.' })
  })
})
