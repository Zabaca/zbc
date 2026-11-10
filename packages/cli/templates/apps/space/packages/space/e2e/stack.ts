// What the end-to-end tests of the Forms tab stand on: the space's production bundle (server.ts), forms' real Worker beside it (a local D1
// and R2, its own server from packages/forms/e2e), and a browser whose calls to `/forms/api/*` and `/forms/logo/*` are handed to forms.
//
// In production the space's Worker hands those two prefixes to forms over a service binding, with the Access assertion passed along
// (src/forms.ts, pinned by test/app.test.ts). A local preview has no such binding, so the BROWSER does the handing: a route on the context
// answers a call to the space's address with forms' answer at the path the Worker would have asked for (`formsPathFor`, the Worker's own function), and
// says the Origin forms' cross-site check will compare with, as the Worker's forwarded request does. Everything else is the space: its
// page, its files, its CSP, its `/api/me`.
import type { Browser, BrowserContext, Page, Route } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type MadeClient, setUpClient } from '@space/forms/e2e/clients'
import { type Server as FormsServer, startServer as startForms } from '@space/forms/e2e/server'
import { formsPathFor } from '../src/forms'
import { type Space, startSpace } from './server'

type ContextOptions = Parameters<Browser['newContext']>[0]

export interface Stack {
  /** forms' Worker: the operator API at /admin/api, the signer's pages at /s, mail written to disk (packages/forms/e2e/local-mail.ts). */
  forms: FormsServer
  /** The space's bundle. */
  space: Space
  browser: E2eBrowser
  /** A signed-in operator's window on the space: its Forms calls go to forms. `errors` collects what the page threw. */
  operator(options?: ContextOptions): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }>
  /** A Client made in the space's preview (Settings' own write, so both agree on it) with signing set up for it in forms: its names are `display_name` and `legal_name`, the rest are the signing settings. */
  setUpClient(fields: Record<string, unknown>): Promise<MadeClient>
  /** forms' operator API, called directly (to set a test up and to check what a screen did), as the local operator. */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>
  stop(): Promise<void>
}

/** The request headers a call carries to forms: the page's own, without the ones the transport sets. */
const DROPPED = new Set(['host', 'origin', 'referer', 'cookie', 'content-length', 'connection', 'accept-encoding'])

async function handToForms(route: Route, forms: string): Promise<void> {
  const req = route.request()
  const url = new URL(req.url())
  const path = formsPathFor(url.pathname)
  if (!path) return route.continue()
  const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !DROPPED.has(k)))
  try {
    await route.fulfill({ response: await route.fetch({ url: `${forms}${path}${url.search}`, headers: { ...headers, origin: forms } }) })
  } catch {
    // The window was closed while its call was in flight (a test ended): there is nobody to answer.
  }
}

export async function startStack(ports: { forms?: string; space?: string } = {}): Promise<Stack> {
  const forms = await startForms({ ...(ports.forms && { portEnv: ports.forms }) })
  const space = await startSpace({ ...(ports.space && { portEnv: ports.space }), formsUrl: forms.base })
  // The two run side by side and must agree on which Clients exist: forms reads them from the space's preview (its fixtures, and the ones made in Settings while a suite runs).
  const linked = await fetch(`${forms.base}/admin/api/dev-clients-from`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: space.base }) })
  if (!linked.ok) throw new Error(`forms could not be pointed at the space's Clients: ${linked.status}`)
  const browser = await launchBrowser()
  return {
    forms,
    space,
    browser,
    async operator(options) {
      const ctx = await browser.newContext(options)
      await ctx.route(/\/forms\/(api|logo)\//, (route) => handToForms(route, forms.base))
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      return { ctx, page, errors }
    },
    setUpClient: (fields) => setUpClient(forms.base, fields, { space: space.base }),
    async api(method, path, body) {
      const res = await fetch(`${forms.base}/admin/api${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
      return JSON.parse(text)
    },
    async stop() {
      await browser.stop()
      await space.kill()
      await forms.kill()
    },
  }
}
