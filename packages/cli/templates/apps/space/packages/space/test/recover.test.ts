// A first visit to /forms with no space session must recover, not go blank (src/recover.ts), and a Forms sign-in that ends under a
// screen must reload the whole page, which Access can send to its sign-in (src/client/forms/session.ts). The inline script is run here as
// the browser would run it, with a stand-in page, because it is the one piece that executes before anything else and cannot be seen to fail.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RENEW_ONCE_MS, renewSignIn, signInEnded } from '../src/client/forms/session'
import { RECOVER_AT, RECOVER_KEEP_MS, RECOVER_ONCE_MS, RECOVER_SCRIPT, RECOVER_TO, recoverScriptHash, takeRecovery } from '../src/recover'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'

const ORIGIN = 'https://space.northfield.example'

function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

/** The inline script, run against a stand-in page. Returns what it did when a file of the page fails to load. */
function page(path: { pathname: string; search?: string; hash?: string }, store = storage(), now = 1_000_000) {
  let onError: ((e: unknown) => void) | undefined
  const replaced: string[] = []
  const location = { origin: ORIGIN, pathname: path.pathname, search: path.search ?? '', hash: path.hash ?? '', replace: (to: string) => void replaced.push(to) }
  const window = {}
  const FakeDate = { now: () => now }
  new Function('addEventListener', 'location', 'sessionStorage', 'window', 'Date', RECOVER_SCRIPT)((_: string, fn: (e: unknown) => void) => (onError = fn), location, store, window, FakeDate)
  return {
    store,
    replaced,
    fails: (target: { tagName: string; src?: string; href?: string } | typeof window) => onError!({ target }),
    window,
  }
}

describe('the recovery script', () => {
  test('sends a first visit to /forms through /today when a file of the page fails, and remembers where it was', () => {
    const p = page({ pathname: '/forms/clients/abc' })
    p.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/assets/index-abc.js` })
    expect(p.replaced).toEqual(['/today'])
    expect(p.store.m.get(RECOVER_TO)).toBe('/forms/clients/abc')
    expect(p.store.m.get(RECOVER_AT)).toBe('1000000')
  })

  test('does the same for the page’s stylesheet, and under /forms', () => {
    const p = page({ pathname: '/forms/', search: '?x=1' })
    p.fails({ tagName: 'LINK', href: `${ORIGIN}/assets/index-abc.css` })
    expect(p.replaced).toEqual(['/today'])
    expect(p.store.m.get(RECOVER_TO)).toBe('/forms/?x=1')
  })

  test('does nothing for any other failure: another tab, another file, another origin, the window itself', () => {
    for (const path of ['/today', '/inbox', '/meet', '/people', '/formsx']) {
      const p = page({ pathname: path })
      p.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/assets/index-abc.js` })
      expect([path, p.replaced]).toEqual([path, []])
    }
    const p = page({ pathname: '/forms' })
    p.fails({ tagName: 'SCRIPT', src: 'https://elsewhere.test/assets/x.js' })
    p.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/other/x.js` })
    p.fails({ tagName: 'IMG', src: `${ORIGIN}/assets/x.png` })
    p.fails(p.window)
    expect(p.replaced).toEqual([])
  })

  test('tries once: a second failure within two minutes does not loop, and one after it may try again', () => {
    const store = storage({ [RECOVER_AT]: String(1_000_000 - 1000) })
    const soon = page({ pathname: '/forms' }, store, 1_000_000)
    soon.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/assets/index-abc.js` })
    expect(soon.replaced).toEqual([])
    const later = page({ pathname: '/forms' }, store, 1_000_000 - 1000 + RECOVER_ONCE_MS + 1)
    later.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/assets/index-abc.js` })
    expect(later.replaced).toEqual(['/today'])
  })

  test('does not loop where storage refuses', () => {
    const broken = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => {}, m: new Map() }
    const p = page({ pathname: '/forms' }, broken as never)
    p.fails({ tagName: 'SCRIPT', src: `${ORIGIN}/assets/index-abc.js` })
    expect(p.replaced).toEqual([])
  })
})

describe('coming back', () => {
  test('a remembered place in the Forms tab is taken once, and sends the person back', () => {
    const s = storage({ [RECOVER_TO]: '/forms/clients/abc', [RECOVER_AT]: '1000' })
    expect(takeRecovery(s, 1000 + 5000)).toBe('/forms/clients/abc')
    expect(takeRecovery(s, 1000 + 5000)).toBeNull()
  })

  test('is forgotten when it is old, and is never a place outside the Forms tab', () => {
    expect(takeRecovery(storage({ [RECOVER_TO]: '/forms', [RECOVER_AT]: '1000' }), 1000 + RECOVER_KEEP_MS + 1)).toBeNull()
    for (const to of ['https://evil.test/', '//evil.test', '/today', '/formsx', 'javascript:alert(1)', '']) {
      expect([to, takeRecovery(storage({ [RECOVER_TO]: to, [RECOVER_AT]: '1000' }), 2000)]).toEqual([to, null])
    }
    expect(takeRecovery(storage(), 1)).toBeNull()
  })
})

describe('the page and its content security policy carry the same script', () => {
  test('the built page has exactly this script, ahead of its files, and the policy allows its hash and nothing else inline', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const built = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, env: { ...process.env, SPACE_DECLARATION: NORTHFIELD_DECLARATION_FILE }, stderr: 'pipe', stdout: 'pipe' })
    expect(built.exitCode, built.stderr.toString()).toBe(0)
    const html = readFileSync(`${root}dist/client/index.html`, 'utf8')
    expect(html).toContain(`<script>${RECOVER_SCRIPT}</script>`)
    expect(html.indexOf(RECOVER_SCRIPT)).toBeLessThan(html.indexOf('type="module"'))
    expect([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)]).toHaveLength(1)
    expect(await recoverScriptHash()).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/)
  }, 120_000)
})

describe('the Forms sign-in ending under a screen', () => {
  test('reloads the whole page to renew, once per window; a persistent loss is told to the person, not looped, however slow a reload is', () => {
    const s = storage()
    let reloads = 0
    expect(renewSignIn(s, 1_000_000, () => reloads++)).toBe(true)
    expect(renewSignIn(s, 1_000_500, () => reloads++)).toBe(false)
    // A phone whose reload takes half a minute, and a refusal that does not go away: still not a second reload inside the window.
    expect(renewSignIn(s, 1_000_000 + 30_000, () => reloads++)).toBe(false)
    expect(renewSignIn(s, 1_000_000 + RENEW_ONCE_MS - 1, () => reloads++)).toBe(false)
    expect(reloads).toBe(1)
    expect(RENEW_ONCE_MS).toBeGreaterThanOrEqual(120_000)
    expect(renewSignIn(s, 1_000_000 + RENEW_ONCE_MS + 1, () => reloads++)).toBe(true)
    expect(reloads).toBe(2)
  })

  test('with no storage to remember a try in, it does not reload at all', () => {
    let reloads = 0
    expect(renewSignIn(null, 1, () => reloads++)).toBe(false)
    expect(renewSignIn({ getItem: () => { throw new Error('x') }, setItem: () => {} }, 1, () => reloads++)).toBe(false)
    expect(reloads).toBe(0)
  })

  test('a call that failed is the sign-in ending only when Access redirected or forms said 401: a dropped connection is a blip and keeps what the person typed', async () => {
    const real = globalThis.fetch
    const answer = (fn: () => Promise<unknown>) => ((globalThis as { fetch: unknown }).fetch = fn)
    try {
      answer(async () => ({ type: 'opaqueredirect', status: 0 }))
      expect(await signInEnded()).toBe(true)
      answer(async () => ({ type: 'basic', status: 401 }))
      expect(await signInEnded()).toBe(true)
      answer(async () => ({ type: 'basic', status: 200 }))
      expect(await signInEnded()).toBe(false)
      answer(async () => ({ type: 'basic', status: 500 }))
      expect(await signInEnded()).toBe(false)
      answer(async () => {
        throw new TypeError('Failed to fetch')
      })
      expect(await signInEnded()).toBe(false)
    } finally {
      globalThis.fetch = real
    }
  })

  test('it asks forms’ own /me, through the space, with the redirect left unfollowed', async () => {
    const real = globalThis.fetch
    let asked: { url: string; init: RequestInit } | undefined
    ;(globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => ((asked = { url, init }), { type: 'basic', status: 200 })
    try {
      await signInEnded()
      expect(asked?.url).toBe('/forms/api/me')
      expect(asked?.init).toMatchObject({ redirect: 'manual', cache: 'no-store' })
    } finally {
      globalThis.fetch = real
    }
  })
})
