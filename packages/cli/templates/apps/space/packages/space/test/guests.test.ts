// The guests' and signers' door (src/guests.ts; the space's ADR 0018), driven with real requests through the real router, the way an outsider
// and a signed-in person would: three prefixes answer with no sign-in and nothing else of the host does; a guest path never reads the team's sign-in and a team path never reads a guest's credential; the pages carry a
// policy that keeps them to their own paths. The parts behind the paths (meet's guest routes, forms' public API) have their suites in their packages (packages/meet/test/space-guests.test.ts, packages/forms/test/signer-api-path.test.ts);
// what is held here is which path goes to which part, and what the door adds and takes away.
import { describe, expect, test } from 'bun:test'
import { northfield } from '../../workspace/test/helpers'
import { GUEST_PREFIXES } from '@space/workspace'
import { bundleMark, policyFor } from '../src/guests'
import type { GuestParts } from '../src/guests'
import { world } from './world'

const HOST = 'https://space.northfield.example'
const CALL = 'k7m2qx9frtn4w6hbc8jd'
const TOKEN = 'A'.repeat(43)
const TEAM_PAGE = '<!doctype html><title>Space</title><link rel="manifest" href="/manifest.webmanifest">'

interface Seen {
  method: string
  url: string
  assertion: string | null
  cookie: string | null
  authorization: string | null
}

/** The asset router: the bundles' files where the build puts them, and for any other path the TEAM page, as the real router's fallback does. */
function assets(files: Record<string, { type: string; body: string }>) {
  const asked: string[] = []
  return {
    asked,
    binding: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname
        asked.push(path)
        const f = files[path]
        return f ? new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable' } }) : new Response(TEAM_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      },
    } as unknown as Fetcher,
  }
}

const BUNDLES = {
  '/r/_/': { type: 'text/html', body: `<!doctype html><html><head>${bundleMark('meet')}<title>meet</title></head><body></body></html>` },
  '/r/_/assets/index-a1.js': { type: 'text/javascript', body: 'export {}' },
  '/r/_/assets/index-a1.css': { type: 'text/css', body: 'body{}' },
  '/s/_/': { type: 'text/html', body: `<!doctype html><html><head>${bundleMark('forms')}<title>Northfield Forms</title></head><body></body></html>` },
  '/s/_/assets/index-b2.js': { type: 'application/javascript', body: 'export {}' },
}

function setup(over: { files?: typeof BUNDLES | Record<string, never>; parts?: Partial<GuestParts> | 'none' } = {}) {
  const meetSeen: Seen[] = []
  const signerSeen: Seen[] = []
  const record = (into: Seen[], answer: string) => async (req: Request): Promise<Response> => {
    into.push({ method: req.method, url: req.url, assertion: req.headers.get('cf-access-jwt-assertion'), cookie: req.headers.get('cookie'), authorization: req.headers.get('authorization') })
    return Response.json({ from: answer })
  }
  const guests: GuestParts = over.parts === 'none' ? {} : { meet: record(meetSeen, 'meet'), signer: record(signerSeen, 'forms'), ...over.parts }
  const a = assets(over.files ?? BUNDLES)
  return { a, meetSeen, signerSeen, make: () => world(northfield(), 'northfield.cloudflareaccess.com', { ASSETS: a.binding }, undefined, { guests: () => guests }) }
}

const policy = (res: Response) => res.headers.get('content-security-policy') ?? ''
const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]))

describe('the pages need no sign-in', () => {
  test('a call, the channel guests’ page and a signer’s link each answer with no assertion, from their bundle’s page', async () => {
    const s = setup()
    const w = await s.make()
    for (const [path, mark] of [[`/r/${CALL}`, 'meet'], [`/r/${CALL}/`, 'meet'], ['/w/', 'meet'], [`/s/${TOKEN}`, 'forms'], [`/s/${TOKEN}/`, 'forms']] as const) {
      const res = await w.call(path)
      expect([path, res.status]).toEqual([path, 200])
      expect(await res.text()).toContain(bundleMark(mark))
    }
    // The page is read from the bundle's own folder and nothing of the team's.
    expect([...new Set(s.a.asked)]).toEqual(['/r/_/', '/s/_/'])
  })

  test('a page carries no cache, no referrer, no framing, no indexing, and a policy', async () => {
    const w = await setup().make()
    for (const path of [`/r/${CALL}`, '/w/', `/s/${TOKEN}`]) {
      const res = await w.call(path)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-robots-tag')).toContain('noindex')
      expect(policy(res)).not.toBe('')
    }
  })

  test('a page is GET and HEAD only; `/w` without its slash goes to `/w/`', async () => {
    const w = await setup().make()
    for (const path of [`/r/${CALL}`, '/w/', `/s/${TOKEN}`]) {
      expect([path, (await w.call(path, { method: 'POST' })).status]).toEqual([path, 405])
      const head = await w.call(path, { method: 'HEAD' })
      expect([path, head.status, await head.text()]).toEqual([path, 200, ''])
    }
    const bare = await w.call('/w')
    expect([bare.status, bare.headers.get('location')]).toEqual([308, `${HOST}/w/`])
  })

  test('a path under a prefix that is no page and no API is a 404, never the team’s page', async () => {
    const w = await setup().make()
    for (const path of [`/r/${CALL}/extra`, '/r', '/r/', '/r/api', '/r/_', '/w/x', '/w/_/index.js', '/w/api', '/s', '/s/', '/s/short', `/s/${TOKEN}/more`, '/s/api', '/s/_']) {
      const res = await w.call(path)
      expect([path, [401, 404].includes(res.status)]).toEqual([path, true])
      expect(await res.text()).not.toContain('Space')
    }
  })
})

describe('the page’s files', () => {
  test('are served from their bundle’s folder with no sign-in, a script with the bundle’s policy, and the asset router’s hashing kept', async () => {
    const s = setup()
    const w = await s.make()
    const js = await w.call('/r/_/assets/index-a1.js')
    expect(js.status).toBe(200)
    expect(policy(js)).toBe(policyFor('meet', HOST))
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(js.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    const css = await w.call('/r/_/assets/index-a1.css')
    expect([css.status, policy(css)]).toEqual([200, ''])
    const signer = await w.call('/s/_/assets/index-b2.js')
    expect([signer.status, policy(signer)]).toEqual([200, policyFor('forms', HOST)])
  })

  test('a path that climbs out of the guest folder (an encoded slash or dot, a backslash) is refused (a 404, or the sign-in check’s 401 when the URL itself resolves the dots out of the guest prefix) and never reaches the asset router', async () => {
    const s = setup({ files: { ...BUNDLES, '/assets/team.js': { type: 'text/javascript', body: 'team' } } as typeof BUNDLES })
    const w = await s.make()
    for (const path of ['/r/_/..%2f..%2fassets/team.js', '/s/_/..%2F..%2Fassets/team.js', '/r/_/%2e%2e/%2e%2e/assets/team.js', '/r/_/assets%5c..%5cteam.js']) {
      const res = await w.call(path)
      expect([path, [401, 404].includes(res.status)]).toEqual([path, true])
    }
    expect(s.a.asked.filter((p) => p.includes('team'))).toEqual([])
  })

  test('a file that is not there is a 404, because the asset router would answer with the team’s page', async () => {
    const w = await setup().make()
    for (const path of ['/r/_/assets/gone.js', '/s/_/assets/gone.css']) {
      const res = await w.call(path)
      expect([path, res.status]).toEqual([path, 404])
      expect(await res.text()).not.toContain('manifest')
    }
  })

  test('a bundle that was never built is a 503, and the team’s page is not served in its place', async () => {
    const w = await setup({ files: {} }).make()
    for (const path of [`/r/${CALL}`, '/w/', `/s/${TOKEN}`]) {
      const res = await w.call(path)
      expect([path, res.status]).toEqual([path, 503])
      expect(await res.text()).not.toContain('manifest')
      expect(policy(res)).toBe('')
    }
  })

  test('the team’s own files still need the sign-in, and the guests’ folders hold none of them', async () => {
    const w = await setup().make()
    for (const path of ['/assets/index-abc.js', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png']) expect([path, (await w.call(path)).status]).toEqual([path, 401])
  })
})

describe('the content policy', () => {
  for (const bundle of ['meet', 'forms'] as const) {
    test(`of the ${bundle} pages names only paths of this host: no inline or evaluated script, no whole-host source, no frames, forms, base or plugins`, () => {
      const d = directives(policyFor(bundle, HOST))
      expect(d['default-src']).toEqual(["'none'"])
      expect(d['script-src']).not.toContain("'unsafe-inline'")
      expect(d['script-src']).not.toContain("'unsafe-eval'")
      expect(d['script-src']).not.toContain("'self'")
      for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'worker-src']) {
        for (const source of d[name] ?? []) {
          if (source.startsWith("'") || source === 'data:' || source === 'blob:') continue
          // A source that is the host or a path of it must be a PATH, ending in a slash: the whole origin would take in the team's API.
          expect([name, source, /^(https|wss):\/\/space\.northfield\.example\/[^?#]+\/$/.test(source)]).toEqual([name, source, true])
        }
      }
      expect(d['frame-ancestors']).toEqual(["'none'"])
      expect(d['frame-src']).toEqual(["'none'"])
      expect(d['form-action']).toEqual(["'none'"])
      expect(d['base-uri']).toEqual(["'none'"])
      expect(d['object-src']).toEqual(["'none'"])
      expect(d['manifest-src']).toEqual(["'none'"])
    })
  }

  test('lets a page connect to its own API and its own folder, and to no team path', () => {
    const meet = directives(policyFor('meet', HOST))['connect-src'] ?? []
    expect(meet).toEqual([`${HOST}/r/_/`, `${HOST}/r/api/`, `${HOST}/w/api/`, 'wss://space.northfield.example/w/api/'])
    const forms = directives(policyFor('forms', HOST))['connect-src'] ?? []
    expect(forms).toEqual([`${HOST}/s/_/`, `${HOST}/s/api/`])
    for (const source of [...meet, ...forms]) for (const team of ['/api/me', '/api/today', '/api/conversations', '/forms/api/clients', '/agent/inbox/api/']) expect(`${source}`.endsWith('/') && team.startsWith(new URL(source.replace('wss:', 'https:')).pathname)).toBe(false)
  })

  test('follows the host it is served from', () => {
    expect(policyFor('forms', 'https://space.client.example')).toContain('script-src https://space.client.example/s/_/')
  })
})

describe('the APIs', () => {
  test('go to their part: /r/api and /w/api to meet’s, /s/api to forms’, with the request as it came', async () => {
    const s = setup()
    const w = await s.make()
    expect(await (await w.call(`/r/api/rooms/${CALL}`)).json()).toEqual({ from: 'meet' })
    expect(await (await w.call('/r/api/phone/webhook', { method: 'POST', body: '{}' })).json()).toEqual({ from: 'meet' })
    expect(await (await w.call('/w/api/auth/request', { method: 'POST', body: '{}' })).json()).toEqual({ from: 'meet' })
    expect(await (await w.call(`/s/api/s/${TOKEN}`)).json()).toEqual({ from: 'forms' })
    expect(await (await w.call('/s/api/logo/abc')).json()).toEqual({ from: 'forms' })
    expect(s.meetSeen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([`GET /r/api/rooms/${CALL}`, 'POST /r/api/phone/webhook', 'POST /w/api/auth/request'])
    expect(s.signerSeen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([`GET /s/api/s/${TOKEN}`, 'GET /s/api/logo/abc'])
  })

  test('are handed nothing the team’s sign-in is made of: not the assertion, not the Access cookies, not the token’s headers; the guest’s own cookie goes through', async () => {
    const s = setup()
    const w = await s.make()
    const jwt = await w.signIn('tessa@northfield.example')
    await w.call('/w/api/bootstrap', {
      headers: { 'cf-access-jwt-assertion': jwt, cookie: `CF_Authorization=${jwt}; meet_guest=tok; CF_AppSession=x`, authorization: 'Bearer x', 'cf-access-client-id': 'id', 'cf-access-client-secret': 'secret' },
    })
    await w.call(`/s/api/s/${TOKEN}`, { headers: { 'cf-access-jwt-assertion': jwt, cookie: `CF_Authorization=${jwt}` } })
    expect(s.meetSeen[0]).toMatchObject({ assertion: null, cookie: 'meet_guest=tok', authorization: null })
    expect(s.signerSeen[0]).toMatchObject({ assertion: null, cookie: null })
  })

  test('are 503 where the part is not bound, and say so in no more than a sentence', async () => {
    const w = await setup({ parts: 'none' }).make()
    for (const path of [`/r/api/rooms/${CALL}`, '/w/api/bootstrap', `/s/api/s/${TOKEN}`]) {
      const res = await w.call(path)
      expect([path, res.status]).toEqual([path, 503])
    }
  })
})

describe('everything else is still behind the sign-in', () => {
  const TEAM = ['/', '/today', '/inbox', '/meet', '/forms', '/forms/api/clients', '/people', '/knowledge', '/sw.js', '/search', '/recover', '/work', '/rooms', '/wx', '/api/me', '/api/search?q=a', '/api/w/socket', '/api/rooms/x', '/api/phone/webhook', '/agent/inbox/api/x', '/assets/x.js', '/r.js', '/s.json', '/w.html', '/rx/y', '/ssh', '/R/x']

  test('a look-alike or a team path is refused without a sign-in, and no guest part is asked about it', async () => {
    const s = setup()
    const w = await s.make()
    for (const path of TEAM) for (const method of ['GET', 'POST']) expect([method, path, (await w.call(path, { method })).status]).toEqual([method, path, 401])
    expect(s.meetSeen).toEqual([])
    expect(s.signerSeen).toEqual([])
    expect(s.a.asked).toEqual([])
  })

  test('a guest path can be dotted into a team path, and the team path is then refused: the address is read as the browser reads it', async () => {
    const w = await setup().make()
    for (const path of ['/r/../today', '/r/%2e%2e/api/me', '/w/../api/me', '/s/_/../../api/me']) expect([path, (await w.call(path)).status]).toEqual([path, 401])
  })

  test('a team assertion on a guest path is not read, and a signed-in person is still let in to the team’s paths as ever', async () => {
    const w = await setup().make()
    const jwt = await w.signIn('tessa@northfield.example')
    expect((await w.call(`/r/${CALL}`, { jwt })).status).toBe(200)
    expect((await w.call('/today', { jwt })).status).toBe(200)
    expect((await w.call('/api/me', { jwt })).status).toBe(200)
    // The guest paths do not need it, and the person check is not run for them: a garbage assertion is as good as none.
    expect((await w.call(`/s/${TOKEN}`, { jwt: 'garbage' })).status).toBe(200)
    expect((await w.call('/today', { jwt: 'garbage' })).status).toBe(401)
  })

  test('the prefixes are the layer’s three, which the Access bypass applications are made from', () => {
    expect([...GUEST_PREFIXES]).toEqual(['/r', '/w', '/s'])
  })
})
