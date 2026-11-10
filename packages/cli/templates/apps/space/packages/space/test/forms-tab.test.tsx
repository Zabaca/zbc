// The Forms tab's screens as the page runs them (ADR 0007): where a screen's places are on the address, what a click on one of its links does, and what a
// call that finds the Forms sign-in gone does. The screens' own looks and flows are the end-to-end tests in e2e/ (a real browser over the real forms Worker).
// The DOM is registered for this file only, so React is imported after it (as settings-dom.test.tsx does): a React imported before a DOM exists keeps that for every file after it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from '../src/client/forms/api'
import { documents } from '../src/client/forms/documents/api'
import { formsApi } from '../src/client/forms/formsApi'
import { BASE, href, legacyPlace, placeOf } from '../src/client/forms/route'
import { documentPath } from '../src/client/day'
import { RENEW_ONCE_MS } from '../src/client/forms/session'

const realFetch = globalThis.fetch
beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://space.northfield.example/forms' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

describe('where the screens are on the address', () => {
  test('a place in the tab is a path under /forms, and the tab itself is /forms', () => {
    expect(BASE).toBe('/forms')
    expect(href('/')).toBe('/forms')
    expect(href('/clients/abc')).toBe('/forms/clients/abc')
    expect(href('/envelopes?client=abc')).toBe('/forms/envelopes?client=abc')
    expect(href('/forms')).toBe('/forms/forms')
  })

  test('an address names its place, with its query, and an address outside the tab names none', () => {
    expect(placeOf('/forms')).toBe('/')
    expect(placeOf('/forms/')).toBe('/')
    expect(placeOf('/forms/envelopes', '?status=sent')).toBe('/envelopes?status=sent')
    expect(placeOf('/forms/envelopes/abc/answers/')).toBe('/envelopes/abc/answers')
    expect(placeOf('/forms/forms')).toBe('/forms')
    for (const outside of ['/today', '/formsx', '/inbox/forms', '/']) expect([outside, placeOf(outside)]).toEqual([outside, null])
    for (const place of ['/', '/clients', '/clients/new', '/envelopes/abc', '/forms', '/documents/abc', '/seal', '/history']) expect(placeOf(href(place))).toBe(place === '/clients' ? '/clients' : place)
  })

  test('the admin’s own fragment, from a bookmark of forms.northfield.example/admin/#/clients/abc, names a place; anything else does not', () => {
    expect(legacyPlace('#/clients/abc')).toBe('/clients/abc')
    expect(legacyPlace('#/envelopes?status=sent')).toBe('/envelopes?status=sent')
    expect(legacyPlace('#/')).toBe('/')
    for (const none of ['', '#', '#clients', '##/x', '#//evil.example/x']) expect([none, legacyPlace(none)]).toEqual([none, null])
  })

  test('Today’s link to a document is the envelope’s own screen, a path of the tab (not the old fragment), so the screen it opens is the one named', () => {
    expect(documentPath('e-1')).toBe('/forms/envelopes/e-1')
    expect(placeOf(documentPath('0b1c2d3e-0000-4000-8000-000000000001'))).toBe('/envelopes/0b1c2d3e-0000-4000-8000-000000000001')
    expect(documentPath('a b/c')).toBe('/forms/envelopes/a%20b%2Fc')
  })

  test('no screen writes the address by hand: a move is `go()`, so the page and the address cannot part', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name)) files.push(path)
      }
    }
    walk(fileURLToPath(new URL('../src/client/forms', import.meta.url)))
    expect(files.length).toBeGreaterThan(15)
    for (const file of files.filter((f) => !f.endsWith('/route.ts') && !f.endsWith('/FormsTab.tsx'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/location\.(hash|href|pathname)\s*=[^=]|history\.(push|replace)State|location\.assign|location\.replace/)
    }
  })
})

// ── A screen in a page ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CLIENT = { id: '11111111-1111-4111-8111-111111111111', slug: 'lane', client_number: 1001, client_archived: false, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', accent_color: '#7a2e1d', reply_to: 'office@lane.example', copy_addresses: [], time_zone: 'America/Los_Angeles', retention_years: 7, has_logo: true, logo_type: 'image/png', logo_sha256: 'abc', created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:00Z' }

let unmount: (() => Promise<void>) | null = null
const asked: string[] = []
afterEach(async () => {
  await unmount?.()
  unmount = null
  asked.length = 0
  globalThis.fetch = realFetch
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open(pathname: string, go: (path: string) => void = () => undefined, search = '') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://space.northfield.example')
    asked.push(url.pathname + url.search)
    return Response.json(url.pathname === '/forms/api/clients' ? [CLIENT] : url.pathname === '/forms/api/clients-not-set-up' ? { available: true, clients: [] } : [])
  }) as typeof fetch
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { FormsTab } = await import('../src/client/forms/FormsTab')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  unmount = () => act(async () => root.unmount())
  await act(async () => root.render(<FormsTab pathname={pathname} search={search} go={go} />))
  await act(async () => sleep(20))
  return host
}

describe('a screen of the tab', () => {
  test('asks forms’ API through the space, and shows what it answers', async () => {
    const page = await open('/forms')
    // The Clients section is the one list of Clients joined with their signing settings: the signing settings, and the Clients that have none.
    expect([...asked].sort()).toEqual(['/forms/api/clients', '/forms/api/clients-not-set-up'])
    expect(page.textContent).toContain('Pinecrest')
    // The client's logo is asked for through the space, on its own address.
    expect(page.querySelector('img')?.getAttribute('src')).toBe(`/forms/logo/${CLIENT.id}?v=abc`)
  })

  test('a click on a link to another screen moves inside the page: the page is told where, and the browser does not load it', async () => {
    const went: string[] = []
    const page = await open('/forms', (p) => went.push(p))
    const link = page.querySelector(`a[href="/forms/clients/${CLIENT.id}"]`) as HTMLAnchorElement
    expect(link).toBeTruthy()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(went).toEqual([`/forms/clients/${CLIENT.id}`])
  })

  test('and leaves the browser what is its own: a click that means “open it elsewhere”, a link out, a download, forms’ API and logos', async () => {
    const went: string[] = []
    const page = await open('/forms', (p) => went.push(p))
    const make = (attrs: Record<string, string>) => {
      const a = document.createElement('a')
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
      page.querySelector('[data-testid="forms-tab"]')!.appendChild(a)
      return a
    }
    const click = (a: HTMLAnchorElement, init: MouseEventInit = {}) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
      a.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(click(make({ href: '/forms/envelopes' }), { ctrlKey: true })).toBe(false)
    expect(click(make({ href: '/forms/envelopes' }), { metaKey: true })).toBe(false)
    expect(click(make({ href: '/forms/envelopes' }), { button: 1 })).toBe(false)
    expect(click(make({ href: '/forms/envelopes', target: '_blank' }))).toBe(false)
    expect(click(make({ href: '/forms/envelopes', download: '' }))).toBe(false)
    expect(click(make({ href: 'https://forms.northfield.example/s/token' }))).toBe(false)
    expect(click(make({ href: '/forms/api/envelopes/abc/finished.pdf' }))).toBe(false)
    expect(click(make({ href: '/forms/logo/abc' }))).toBe(false)
    expect(click(make({ href: '/today' }))).toBe(false)
    expect(went).toEqual([])
    expect(click(make({ href: '/forms/envelopes?status=sent' }))).toBe(true)
    expect(went).toEqual(['/forms/envelopes?status=sent'])
  })

  test('says so for an address that is none of its screens', async () => {
    const page = await open('/forms/nonsense')
    expect(page.textContent).toContain('There is nothing at this address.')
    expect(asked).toEqual([])
  })
})

// ── A call that finds the sign-in gone ─────────────────────────────────────────────────────────────────────────────────────

describe('a call that fails to complete', () => {
  let reloads = 0
  const seen: { url: string; redirect?: string }[] = []

  /** `answers` is what each fetch does in turn: the call itself, then the probe of /me. */
  function ending(answers: (() => Response | Promise<Response>)[]) {
    reloads = 0
    seen.length = 0
    window.sessionStorage.clear()
    Object.defineProperty(window.location, 'reload', { configurable: true, value: () => void reloads++ })
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect })
      const next = answers.shift()
      if (!next) throw new TypeError('no more answers')
      return next()
    }) as typeof fetch
  }
  const dropped = () => {
    throw new TypeError('Failed to fetch')
  }
  const opaqueRedirect = () => ({ type: 'opaqueredirect', status: 0 }) as unknown as Response

  test('a dropped connection is not the sign-in ending: the page keeps its state and does not reload', async () => {
    ending([dropped, dropped])
    await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(seen.map((s) => s.url)).toEqual(['/forms/api/clients', '/forms/api/me'])
    expect(reloads).toBe(0)
    // The call fails but the probe answers fine: a blip.
    ending([dropped, () => Response.json({ email: 'tessa@northfield.example' })])
    await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(reloads).toBe(0)
  })

  test('a call that failed because Access redirected is the sign-in ending: the probe sees the redirect unfollowed, and the page reloads to sign in again', async () => {
    ending([dropped, opaqueRedirect])
    await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(seen[1]).toEqual({ url: '/forms/api/me', redirect: 'manual' })
    expect(reloads).toBe(1)
  })

  test('a probe the Worker refuses with a 401 is the sign-in ending too', async () => {
    ending([dropped, () => new Response('no', { status: 401 })])
    await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(reloads).toBe(1)
  })

  test('an answer that is a 401 needs no probe: it is the sign-in ending', async () => {
    ending([() => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })])
    await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(seen).toHaveLength(1)
    expect(reloads).toBe(1)
  })

  test('the reload is once a while, whatever the screens ask next: a loss that does not go away is told to the person, not looped', async () => {
    ending([() => new Response('', { status: 401 }), () => new Response('', { status: 401 }), () => new Response('', { status: 401 })])
    for (let i = 0; i < 3; i++) await expect(api.clients()).rejects.toThrow('Reload the page')
    expect(reloads).toBe(1)
    expect(RENEW_ONCE_MS).toBeGreaterThanOrEqual(120_000)
  })

  test('the other calls (forms, documents) tell it the same way', async () => {
    ending([dropped, dropped])
    await expect(formsApi.forms()).rejects.toThrow('Reload the page')
    ending([dropped, dropped])
    await expect(documents.list()).rejects.toThrow('Reload the page')
    expect(reloads).toBe(0)
    ending([dropped, opaqueRedirect])
    await expect(formsApi.forms()).rejects.toThrow('Reload the page')
    expect(reloads).toBe(1)
  })
})
