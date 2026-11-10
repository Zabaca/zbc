// What forms' LOCAL Worker is (dev/wrangler.jsonc), pinned: not deployed, with no address, and shaped like the space's bindings for the pieces forms uses. Forms has no deployed Worker:
// it runs in the space's Worker (the Worker's settings (the install kit, kit/worker-settings.ts)), which the space's own tests pin. This file is for the folder
// `bun run dev` and the end-to-end suites use, so that it cannot grow a route, a cron or an instance without a test saying so.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { northfieldSettings as bundledSettings } from '../../../kit/northfield'
import { NORTHFIELD_WORDS } from './words'

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
const space = bundledSettings as Record<string, any>

test('forms is not deployed: there is no wrangler file at the package root and no Worker entry, so nothing can apply it', () => {
  expect(existsSync(new URL('../wrangler.jsonc', import.meta.url))).toBe(false)
  expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(false)
})

test('the local Worker has no address: no route, no Custom Domain, no workers.dev or preview hostname, no cron', () => {
  expect(config.workers_dev).toBe(false)
  expect(config.preview_urls).toBe(false)
  for (const key of ['routes', 'route', 'triggers']) expect(Object.keys(config)).not.toContain(key)
  expect(JSON.stringify(config)).not.toContain('custom_domain')
  expect(JSON.stringify(config)).not.toMatch(/forms\.northfield\.example/)
})

test('only the API paths run before the asset router; the signer’s pages and the public files are plain assets', () => {
  // /s/api/* is the public API (the signer's page calls it; without the entry the asset router's fallback would answer it with the page).
  expect(config.assets.run_worker_first).toEqual(['/admin/api/*', '/s/api/*'])
  expect(config.assets.not_found_handling).toBe('single-page-application')
  expect(config.assets.binding).toBe('ASSETS')
})

test('the database and the bucket are named as the space names them, so a migration or a key written for one is the other’s', () => {
  expect(config.d1_databases).toEqual([{ binding: 'DB', database_name: 'forms-records', migrations_dir: '../migrations' }])
  expect(config.r2_buckets).toEqual([{ binding: 'FILES', bucket_name: 'forms-files' }])
  expect(space.d1_databases).toEqual([{ binding: 'FORMS_DB', database_name: 'forms-records', migrations_dir: '../forms/migrations' }])
  expect(space.r2_buckets).toContainEqual({ binding: 'FORMS_FILES', bucket_name: 'forms-files' })
})

test('the email binding is named EMAIL and allows forms@northfield.example as its only sender', () => {
  expect(config.send_email).toEqual([{ name: 'EMAIL', allowed_sender_addresses: ['forms@northfield.example'] }])
  expect(NORTHFIELD_WORDS.sender).toBe('forms@northfield.example')
})

test('the public API has a rate limit', () => {
  expect(config.ratelimits).toEqual([{ name: 'PUBLIC_LIMIT', namespace_id: '7301', simple: { limit: 120, period: 60 } }])
})

test('the app’s own address is the install’s space host (no var of its own), and no secret is written into the file', () => {
  expect(config.vars).toBeUndefined()
  const raw = readFileSync(new URL('../dev/wrangler.jsonc', import.meta.url), 'utf8')
  expect(raw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  expect(JSON.stringify(config)).not.toContain('FORMS_SEAL_ROOT_KEY')
})
