// What meet's LOCAL Worker is (dev/wrangler.jsonc), pinned: not deployed, with no address, and the paths it runs before the asset router. Meet has no deployed Worker:
// its team side runs in the space's Worker (src/space-part.ts) and its guests' side answers at space.northfield.example/r/ and /w/ (src/space-guests.ts),
// which the space's own tests pin. This file is for the folder `bun run dev` and the live browser checks use, so that it cannot grow a route, a cron or an instance without a test saying so.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { northfieldSettings as bundledSettings } from '../../../kit/northfield'
import { BUNDLED_INSTALL as NORTHFIELD } from '../src/company'

/** wrangler.jsonc without its comments, read with a scanner that knows a "//" inside a string is not one. */
function readJsonc(path: URL) {
  const src = readFileSync(path, 'utf8')
  let out = ''
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (inString) {
      out += c
      if (c === '\\') out += src[++i]!
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const config = readJsonc(new URL('../dev/wrangler.jsonc', import.meta.url))

test('meet is not deployed: there is no wrangler file at the package root and no Worker entry, so nothing can apply it', () => {
  expect(existsSync(new URL('../wrangler.jsonc', import.meta.url))).toBe(false)
  expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(false)
})

test('the local Worker has no address: no route, no Custom Domain, no workers.dev or preview hostname, no cron', () => {
  expect(config.workers_dev).toBe(false)
  expect(config.preview_urls).toBe(false)
  for (const key of ['routes', 'route', 'triggers']) expect(Object.keys(config)).not.toContain(key)
  expect(JSON.stringify(config)).not.toContain('custom_domain')
  expect(JSON.stringify(config)).not.toMatch(/meet\.northfield\.example/)
})

test('every API prefix of the guests’ side runs before the asset router, or the SPA fallback would answer it with index.html; the pages are the fallback’s', () => {
  expect(config.assets.run_worker_first).toEqual(['/r/api/*', '/w/api/*', '/api/dev/*'])
  expect(config.assets.not_found_handling).toBe('single-page-application')
})

test('the classes are declared NEW here (a local store has nothing to receive), and a file that did this to the space’s stores would provision empty ones, which is why this one is never deployed', () => {
  expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['RoomDO', 'WorkspaceDO'] }])
  expect(config.durable_objects.bindings).toEqual([
    { name: 'ROOMS', class_name: 'RoomDO' },
    { name: 'WORKSPACE', class_name: 'WorkspaceDO' },
  ])
})

test('the SFU app id and the TURN key id are plain variables, the same as the space’s, and no secret is in the file', () => {
  const space = bundledSettings as Record<string, any>
  expect(config.vars).toEqual({ REALTIME_APP_ID: space.vars.REALTIME_APP_ID, TURN_KEY_ID: space.vars.TURN_KEY_ID })
  expect(JSON.stringify(config)).not.toMatch(/SECRET|TOKEN|AUD/)
})

// Every link is on the install's space host (the declaration's), which wiring.ts derives (`appOriginOf`); the dev Worker has no address setting to disagree with it.
test('the sign-in team is the declaration’s, and the dev Worker holds no address of its own', () => {
  expect(Object.keys(config.vars)).not.toContain('APP_ORIGIN')
  expect(NORTHFIELD.teamDomain).toBe('northfield.cloudflareaccess.com')
  expect(NORTHFIELD.people.every((p) => p.signIn === p.signIn.toLowerCase())).toBe(true)
})
