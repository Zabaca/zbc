// The front door's Worker, driven with real requests through the real router: who is let in, and what a person sees.
// The sign-in is the company layer's own check, so these prove the Worker's use of it: every path is behind it, the header
// is the only proof, and a person of another install is nobody here even when Cloudflare signed their assertion.
import { beforeEach, describe, expect, test } from 'bun:test'
import { resetJwksCache } from '@space/workspace'
import { AUD, T0, lane, team, northfield } from '../../workspace/test/helpers'
import { SCRIPT_POLICY, meOf } from '../src/app'
import { recoverScriptHash } from '../src/recover'
import { FORMS_AUD, LANE_TEAM, PAGE, NORTHFIELD_TEAM, world } from './world'

const PATHS = ['/', '/today', '/inbox', '/meet', '/conversations', '/conversations/dana%40x.example', '/forms', '/people', '/today/', '/people/ana', '/assets/index-abc.js', '/favicon.svg', '/nonsense', '/api/me', '/api/anything', '/api/conversations', '/api/today', '/api/search?q=dana', '/api/live', '/api/w/socket', '/api/conversation?key=dana%40x.example', '/api/conversation/signers?key=dana%40x.example', '/api/draft?id=d-first', '/inbox/draft/d-first', '/conversations/draft/d-first', '/api/history?mail=c1&before=m1', '/api/email', '/api/chat', '/api/read', '/api/close', '/api/reopen', '/settings', '/settings/notifications', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/api/inbox/mailboxes', '/api/inbox/claude-sending', '/api/inbox/restore-confirm', '/api/meet/cards?conversation=3', '/api/meet/calls', '/api/meet/call?name=k7m2qx9frtn4w6hbc8jd', '/api/meet/usage', '/api/meet/phone', '/api/meet/huddle', '/api/meet/meeting', '/api/meet/delete-chat', '/api/meet/phone-read', '/api/phone', '/api/phone/', '/api/phone/calls', '/api/phone/token', '/api/phone/call', '/api/phone/address', '/api/phone/settings', '/api/phone/voicemail/3/audio', '/api/phone/messages/3', '/api/phonebook', '/api/people', '/api/person?key=dana%40x.example', '/api/inbox/contact-profile', '/api/inbox/contact-merge', '/api/inbox/contact-unmerge', '/api/inbox/client-link', '/people/dana%40x.example']
/** The Forms tab and everything forms answers under it: refused without a sign-in like the rest, and never asked. */
const FORMS_PATHS = ['/forms/', '/forms/clients', '/forms/envelopes/abc', '/forms/logo/abc', '/forms/api/clients', '/forms/api/envelopes/abc/finished.pdf', '/forms/anything']

describe("Northfield's space", () => {
  const z = northfield()
  let w: Awaited<ReturnType<typeof world>>
  beforeEach(async () => {
    w = await world(z, NORTHFIELD_TEAM)
  })

  test('a request without a sign-in is refused at every path, /forms included, and neither the page nor forms is read for it', async () => {
    for (const path of [...PATHS, ...FORMS_PATHS]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await w.call(path, { method })
        expect([method, path, res.status]).toEqual([method, path, 401])
      }
    }
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('the Access cookie alone is not a sign-in: only the header is read', async () => {
    const jwt = await w.signIn('tessa@northfield.example')
    const formsJwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/today', '/api/me', '/assets/index-abc.js']) {
      const res = await w.call(path, { cookieJwt: jwt })
      expect([path, res.status]).toEqual([path, 401])
    }
    for (const path of ['/forms', '/forms/clients', '/forms/api/clients']) {
      const res = await w.call(path, { cookieJwt: formsJwt })
      expect([path, res.status]).toEqual([path, 401])
    }
    expect(w.asked).toEqual([])
    expect(w.forwarded).toEqual([])
  })

  test('Tessa signed in is let in everywhere: the page, its files and the API; the Forms tab with the Forms sign-in', async () => {
    const jwt = await w.signIn('tessa@northfield.example')
    for (const path of ['/today', '/inbox', '/inbox/ana', '/meet', '/meet/phone', '/people', '/people/ana', '/assets/index-abc.js', '/nonsense']) {
      const res = await w.call(path, { jwt })
      expect([path, res.status]).toEqual([path, 200])
    }
    const formsJwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/forms', '/forms/', '/forms/anything']) {
      const res = await w.call(path, { jwt: formsJwt })
      expect([path, res.status]).toEqual([path, 200])
    }
    expect(w.asked).toEqual(['/today', '/inbox', '/inbox/ana', '/meet', '/meet/phone', '/people', '/people/ana', '/assets/index-abc.js', '/nonsense', '/forms', '/forms/', '/forms/anything'])
    expect(w.forwarded).toEqual([]) // those were the space's own page, not forms'
  })

  test('the space opens on Today', async () => {
    const res = await w.call('/', { jwt: await w.access.sign({ email: 'tessa@northfield.example' }) })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/today')
  })

  test('every page carries the headers that keep it from being sniffed, indexed, framed or read from elsewhere', async () => {
    const res = await w.call('/today', { jwt: await w.access.sign({ email: 'tessa@northfield.example' }) })
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    // One inline script is allowed, by its hash: the recovery script (src/recover.ts), and nothing else inline.
    expect(csp).toContain(`script-src 'self' ${await recoverScriptHash()}`)
    expect(csp).not.toContain('unsafe-inline')
    expect(await res.text()).toBe(PAGE)
  })

  test('a script carries a narrow policy of its own, the page its own, and an image none: pdf.js’s worker may compile the WASM that decodes images, and both workers keep limits', async () => {
    const jwt = await w.access.sign({ email: 'tessa@northfield.example' })
    // The scripts: a chunk, pdf.js's worker, the service worker. Their own address, and WebAssembly, and nothing else.
    for (const path of ['/assets/index-abc.js', '/assets/pdf.worker.min-abc.mjs', '/sw.js']) {
      const res = await w.call(path, { jwt })
      expect([path, res.status, res.headers.get('content-type'), res.headers.get('content-security-policy')]).toEqual([path, 200, 'text/javascript', SCRIPT_POLICY])
      // Everything else a file carries is still set.
      expect([path, res.headers.get('x-content-type-options')]).toEqual([path, 'nosniff'])
    }
    expect(SCRIPT_POLICY).toBe("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'")
    // A file that is no script and no page is governed through nothing, so it carries none.
    const icon = await w.call('/icons/icon-192.png', { jwt })
    expect([icon.headers.get('content-type'), icon.headers.get('content-security-policy')]).toEqual(['image/png', null])
    // A page of any tab, and the Forms tab's screens, are the page: its own policy, which does not open WebAssembly to the page's own scripts.
    for (const path of ['/today', '/forms/envelopes/abc']) {
      const res = await w.call(path, { jwt: path.startsWith('/forms') ? await w.signInForms('tessa@northfield.example') : jwt })
      const csp = res.headers.get('content-security-policy') ?? ''
      expect([path, csp.includes("default-src 'self'"), csp.includes('frame-ancestors'), csp.includes('wasm-unsafe-eval')]).toEqual([path, true, true, false])
    }
  })

  test('/api/me tells the page who is signed in, the install’s tabs in order, and where the apps are', async () => {
    const res = await w.call('/api/me', { jwt: await w.access.sign({ email: 'tessa@northfield.example' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toEqual({
      address: 'tessa@northfield.example',
      name: 'Tessa',
      company: { name: 'Northfield Works', timeZone: 'America/Los_Angeles' },
      owner: { name: 'Tessa', address: 'tessa@northfield.example' },
      // Every switch is on in Northfield's install, so the page draws every part, as it always did.
      switches: { gmail: true, hostedMailboxes: true, clientDirectory: true, claudeScript: true, assistant: true, phone: true, manyClients: true, calls: true, telegram: true },
      tabs: [
        { id: 'today', label: 'Today', path: '/today' },
        { id: 'inbox', label: 'Inbox', path: '/inbox' },
        { id: 'meet', label: 'Meet', path: '/meet' },
        { id: 'calendar', label: 'Calendar', path: '/calendar' },
        { id: 'forms', label: 'Forms', path: '/forms', ownSignIn: true },
        { id: 'people', label: 'People', path: '/people' },
        { id: 'knowledge', label: 'Knowledge', path: '/knowledge' },
      ],
      home: 'today',
      origin: 'https://space.northfield.example/',
      // The install's own senders and signing-service names, which the screens that say them read.
      senders: { forms: 'forms@northfield.example', meet: 'meet@northfield.example' },
      forms: { service: 'Northfield Forms', sender: 'forms@northfield.example', runBy: 'Northfield Works' },
    })
  })

  test('an API path the space does not have is a 404, not the page', async () => {
    const res = await w.call('/api/nothing', { jwt: await w.access.sign({ email: 'tessa@northfield.example' }) })
    expect(res.status).toBe(404)
    expect(w.asked).toEqual([])
  })

  test('a signed-in write is refused wherever it is not one of a conversation’s three, and an unsigned one is refused first', async () => {
    const jwt = await w.access.sign({ email: 'tessa@northfield.example' })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const signed = await w.call('/api/me', { method, jwt })
      expect([method, signed.status]).toEqual([method, 405])
      const unsigned = await w.call('/api/me', { method })
      expect([method, unsigned.status]).toEqual([method, 401])
    }
  })

  test('a sign-in that is not good is refused: another application’s audience, expired, forged, or another team’s', async () => {
    const stranger = await team(NORTHFIELD_TEAM) // the same team name, its own keys: a forgery
    const elsewhere = await team(LANE_TEAM)
    const bad = {
      'wrong audience': await w.access.sign({ email: 'tessa@northfield.example', aud: ['b'.repeat(64)] }),
      expired: await w.access.sign({ email: 'tessa@northfield.example' }, { exp: Math.floor(T0 / 1000) - 10 }),
      forged: await stranger.sign({ email: 'tessa@northfield.example' }),
      'another team': await elsewhere.sign({ email: 'tessa@northfield.example' }),
    }
    for (const [why, jwt] of Object.entries(bad)) {
      const res = await w.call('/api/me', { jwt })
      expect([why, res.status]).toEqual([why, 401])
    }
  })

  test('a verified assertion that is not a person of this install is a 403: another company’s owner, a service token, both at once', async () => {
    const cases = {
      "another company's owner": { email: 'lane@pinecrest.test' },
      'a service token': { common_name: 'claude-script-client-id' },
      'a person and a token': { email: 'tessa@northfield.example', common_name: 'claude-script-client-id' },
      "a stranger at Northfield's team": { email: 'someone@elsewhere.test' },
    }
    for (const [who, claims] of Object.entries(cases)) {
      const res = await w.call('/today', { jwt: await w.access.sign(claims) })
      expect([who, res.status]).toEqual([who, 403])
    }
    expect(w.asked).toEqual([])
  })

  test('no audience configured refuses everyone, a real assertion included', async () => {
    const closed = await world(z, NORTHFIELD_TEAM, { CF_ACCESS_AUD: undefined })
    const res = await closed.call('/today', { jwt: await closed.access.sign({ email: 'tessa@northfield.example' }) })
    expect(res.status).toBe(401)
    expect(closed.asked).toEqual([])
  })

  test('the local-dev way in works on localhost with the flag set, and nowhere else', async () => {
    const dev = await world(z, NORTHFIELD_TEAM, { ALLOW_UNAUTHENTICATED: '1' })
    expect((await dev.call('/api/me', { host: 'localhost:4838' })).status).toBe(200)
    expect((await dev.call('/api/me', { host: 'space.northfield.example' })).status).toBe(401)
    expect((await w.call('/api/me', { host: 'localhost:4838' })).status).toBe(401)
  })
})

describe("a second company's space", () => {
  const l = lane()

  test('is on its own address with its own people, and Northfield’s Tessa is nobody there', async () => {
    const w = await world(l, LANE_TEAM)
    const owner = await w.call('/api/me', { jwt: await w.access.sign({ email: 'lane@pinecrest.test' }) })
    expect(owner.status).toBe(200)
    const me = (await owner.json()) as ReturnType<typeof meOf>
    expect(me).toMatchObject({ address: 'lane@pinecrest.test', name: 'Lane', company: { name: 'Pinecrest Test' }, home: 'today' })
    expect(me.origin).toBe('https://space.pinecrest.test/')
    // Corin signs in at his Gmail and is named by his work address; the work address is not a way in.
    const corin = await w.call('/api/me', { jwt: await w.access.sign({ email: 'corin.private@example.com' }) })
    expect(await corin.json()).toMatchObject({ address: 'corin@pinecrest.test', name: 'Corin' })
    expect((await w.call('/api/me', { jwt: await w.access.sign({ email: 'corin@pinecrest.test' }) })).status).toBe(403)
    expect((await w.call('/api/me', { jwt: await w.access.sign({ email: 'tessa@northfield.example' }) })).status).toBe(403)
  })

  test('refuses Northfield’s Tessa even when his own team’s Access signed for him', async () => {
    const w = await world(l, LANE_TEAM)
    const northfieldsAccess = await team(NORTHFIELD_TEAM)
    const res = await w.call('/api/me', { jwt: await northfieldsAccess.sign({ email: 'tessa@northfield.example' }) })
    expect(res.status).toBe(401)
  })
})

describe('the Forms tab', () => {
  const z = northfield()
  const ORIGIN = 'https://space.northfield.example'

  test('its screens are the space’s own page, and only its API and logos are forms’, answered in the Worker for the person the one check named', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const jwt = await w.signInForms('tessa@northfield.example')

    // /forms and every screen under it is the shell, drawn by the space; forms is not asked.
    for (const path of ['/forms', '/forms/clients', '/forms/envelopes/abc', '/forms/documents/abc', '/forms/forms']) expect([path, (await w.call(path, { jwt })).status]).toEqual([path, 200])
    expect(w.forwarded).toEqual([])

    const api = await w.call('/forms/api/clients?limit=5', { jwt })
    expect(api.status).toBe(200)

    // What forms was handed: its own path, the person the one check named and NO assertion, and the address the browser used, so its Origin check agrees.
    const asked = w.forwarded.map((f) => ({ method: f.method, url: new URL(f.url), assertion: f.assertion, who: f.who }))
    expect(asked.map((f) => [f.method, f.url.host, f.url.pathname + f.url.search, f.assertion, f.who])).toEqual([['GET', 'space.northfield.example', '/admin/api/clients?limit=5', null, 'tessa@northfield.example']])
    expect(w.asked).toEqual(['/forms', '/forms/clients', '/forms/envelopes/abc', '/forms/documents/abc', '/forms/forms']) // the shell, once each
  })

  test('forms no longer serves its own page or files through the space: /forms/app and /forms/assets are the space’s page', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const jwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/forms/app', '/forms/app/', '/forms/assets/admin-abc.js']) expect([path, (await w.call(path, { jwt })).status]).toEqual([path, 200])
    expect(w.forwarded).toEqual([])
  })

  test('writes reach forms, with their body and Origin, and the answer comes back as forms gave it', async () => {
    const w = await world(z, NORTHFIELD_TEAM, {}, (req) => Response.json({ method: req.method }, { status: 201 }))
    const jwt = await w.signInForms('tessa@northfield.example')
    const res = await w.call('/forms/api/clients', { method: 'POST', jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'lane' }) })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ method: 'POST' })
    expect(w.forwarded).toHaveLength(1)
    expect(w.forwarded[0]).toMatchObject({ method: 'POST', origin: ORIGIN, assertion: null, who: 'tessa@northfield.example', body: '{"slug":"lane"}' })
    expect(new URL(w.forwarded[0]!.url).pathname).toBe('/admin/api/clients')
  })

  test('forms’ own refusal and errors pass through as they are', async () => {
    const w = await world(z, NORTHFIELD_TEAM, {}, () => Response.json({ error: 'Forbidden' }, { status: 403 }))
    const res = await w.call('/forms/api/me', { jwt: await w.signInForms('tessa@northfield.example') })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  test('neither the cookie nor the assertion goes to forms: the person the check named is the only proof it is given', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const jwt = await w.signInForms('tessa@northfield.example')
    await w.call('/forms/api/me', { jwt, headers: { cookie: 'CF_Authorization=secret; other=1' } })
    expect(w.forwarded).toHaveLength(1)
    expect(w.forwarded[0]!.cookie).toBeNull()
    expect(w.forwarded[0]!.assertion).toBeNull()
    expect(w.forwarded[0]!.who).toBe('tessa@northfield.example')
  })

  test('a client’s logo is forms’ public logo route, forwarded so the screens’ images stay on the space’s address, and cached by the browser alone', async () => {
    const w = await world(z, NORTHFIELD_TEAM, {}, () => new Response('png', { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } }))
    const jwt = await w.signInForms('tessa@northfield.example')
    const logo = await w.call('/forms/logo/abc-123?v=deadbeef', { jwt })
    expect(logo.status).toBe(200)
    expect(logo.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(w.forwarded.map((f) => new URL(f.url).pathname + new URL(f.url).search)).toEqual(['/s/api/logo/abc-123?v=deadbeef'])
    // Signed out, it is as private as the rest of the tab.
    expect((await w.call('/forms/logo/abc-123')).status).toBe(401)
  })

  test('only the operator API and the logos are forms’ to answer: nothing of the signer’s, nothing else', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const jwt = await w.signInForms('tessa@northfield.example')
    const own = ['/forms', '/forms/', '/forms/app/x', '/forms/apix', '/forms/api', '/forms/logo', '/forms/s/token', '/forms/privacy']
    for (const path of own) {
      const res = await w.call(path, { jwt })
      expect([path, res.status]).toEqual([path, 200])
    }
    expect(w.forwarded).toEqual([])
    // Climbing out of /forms/api leaves the Forms tab: the address is normalised before anything is routed, so forms’ signer API is
    // not reachable through the space (and it is not the space’s either).
    const climbed = await w.call('/forms/api/../../api/s/token', { jwt })
    expect(climbed.status).toBe(401) // /api/s/token is not on the Forms path: the Forms sign-in is not the space’s
    const climbedBack = await w.call('/forms/api/../../api/s/token', { jwt: await w.signIn('tessa@northfield.example') })
    expect(climbedBack.status).toBe(404)
    expect(w.forwarded).toEqual([])
  })

  test('the audience follows the path: the Forms sign-in is no good outside /forms and the space’s is no good on it', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const space = await w.signIn('tessa@northfield.example')
    const formsJwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/forms', '/forms/', '/forms/clients', '/forms/api/clients']) {
      const res = await w.call(path, { jwt: space })
      expect([path, res.status]).toEqual([path, 401])
    }
    for (const path of ['/today', '/people', '/api/me', '/assets/index-abc.js', '/formsx', '/forms.html']) {
      const res = await w.call(path, { jwt: formsJwt })
      expect([path, res.status]).toEqual([path, 401])
    }
    expect(w.forwarded).toEqual([])
  })

  test('Access matches /forms without regard to case, so the Worker does too: /FORMS wants the Forms sign-in, and is not forms’ to answer', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const space = await w.signIn('tessa@northfield.example')
    const formsJwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/FORMS', '/Forms/', '/FORMS/clients', '/forms/API/clients']) {
      expect([path, (await w.call(path, { jwt: formsJwt })).status]).toEqual([path, 200]) // the space's own page: only lowercase is forms'
      expect([path, (await w.call(path, { jwt: space })).status]).toEqual([path, 401])
    }
    expect(w.forwarded).toEqual([])
  })

  test('a person who is not of this install is refused on /forms as everywhere, a service token included', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    for (const claims of [{ email: 'lane@pinecrest.test' }, { common_name: 'claude-script-client-id' }, { email: 'someone@elsewhere.test' }]) {
      const res = await w.call('/forms/api/clients', { jwt: await w.access.sign({ ...claims, aud: [FORMS_AUD] }) })
      expect([JSON.stringify(claims), res.status]).toEqual([JSON.stringify(claims), 403])
    }
    expect(w.forwarded).toEqual([])
  })

  test('without the Forms audience configured nobody gets in on /forms, and the rest of the space is unaffected', async () => {
    const w = await world(z, NORTHFIELD_TEAM, { CF_ACCESS_AUD_FORMS: undefined })
    expect((await w.call('/forms/api/clients', { jwt: await w.signInForms('tessa@northfield.example') })).status).toBe(401)
    expect((await w.call('/forms', { jwt: await w.signIn('tessa@northfield.example') })).status).toBe(401)
    expect((await w.call('/today', { jwt: await w.signIn('tessa@northfield.example') })).status).toBe(200)
    expect(w.forwarded).toEqual([])
  })

  test('where forms is not connected (a local run) the tab says so and does not serve the page in its place', async () => {
    const w = await world(z, NORTHFIELD_TEAM, { parts: { formsApi: undefined } })
    const res = await w.call('/forms/api/clients', { jwt: await w.signInForms('tessa@northfield.example') })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Forms is not connected to the space' })
  })

  test('the space still writes nothing of its own: a write on a screen’s address is refused', async () => {
    const w = await world(z, NORTHFIELD_TEAM)
    const jwt = await w.signInForms('tessa@northfield.example')
    for (const path of ['/forms', '/forms/', '/forms/clients', '/forms/apix']) {
      const res = await w.call(path, { method: 'POST', jwt })
      expect([path, res.status]).toEqual([path, 405])
    }
    expect(w.forwarded).toEqual([])
  })
})

describe("a second company's Forms tab", () => {
  test('is on its own address with its own Forms sign-in, and Northfield’s Tessa is nobody there', async () => {
    const l = lane()
    const w = await world(l, LANE_TEAM)
    const jwt = await w.signInForms('lane@pinecrest.test')
    const ok = await w.call('/forms/api/clients', { jwt })
    expect(ok.status).toBe(200)
    expect(w.forwarded.map((f) => new URL(f.url).host + new URL(f.url).pathname)).toEqual(['space.pinecrest.test/admin/api/clients'])
    expect((await w.call('/forms/api/clients', { jwt: await w.signInForms('tessa@northfield.example') })).status).toBe(403)
    expect((await w.call('/forms/api/clients', { jwt: await w.signIn('lane@pinecrest.test') })).status).toBe(401)
  })
})
