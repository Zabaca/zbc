// The Worker as the build makes it (`bun run build`, then this): what the deployed bundle must not contain, and what its configuration says. The inbox's own build test (packages/inbox/test/build.test.ts,
// deleted with the inbox's Worker) held the first two; the space builds the inbox's code now, so they are held here.
// Like the service worker's test, it reads dist/ and says so when there is none.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { bundleMark } from '../src/guests'

const WORKER = new URL('../dist/space/index.js', import.meta.url)
const CONFIG = new URL('../dist/space/wrangler.json', import.meta.url)
const built = existsSync(WORKER)

describe('the built Worker', () => {
  test.skipIf(!built)('the dev agent, which needs no sign-in on localhost, and the dev seed are not in it', () => {
    const deployed = readFileSync(WORKER, 'utf8')
    expect(deployed).not.toContain('dev@localhost')
    expect(deployed).not.toContain('__dev/seed')
  })

  test.skipIf(!built)('no dev data is in it: the inbox seed’s people and the dev Client directory are not in the bundle', () => {
    const deployed = readFileSync(WORKER, 'utf8')
    for (const seeded of ['Delphine Barlow', 'castmic.example', 'tamarackprint.test', 'Example Machines (dev)']) expect(deployed).not.toContain(seeded)
  })

  test.skipIf(!built)('its configuration has the push address beside its own, all three crons and the delivery-report consumer', () => {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { routes: { pattern: string }[]; triggers: { crons: string[] }; queues: { consumers: { queue: string }[] } }
    expect(config.routes.map((r) => r.pattern)).toEqual(['space.northfield.example', 'inbox-push.northfield.example'])
    expect(config.triggers.crons).toEqual(['*/5 * * * *', '47 9 * * *', '0 * * * *'])
    expect(config.queues.consumers.map((c) => c.queue)).toEqual(['northfield-inbox-delivery'])
  })

  // The guests' bundles: built into the assets after the space's own, each page marked, each file named under its own folder, no inline script.
  const CLIENT = new URL('../dist/client/', import.meta.url)

  for (const [folder, bundle] of [['r/_/', 'meet'], ['s/_/', 'forms']] as const) {
    test.skipIf(!built)(`the ${bundle} guest bundle is in the assets, marked, and every file its page names is in its own folder, with no inline script`, () => {
      const file = new URL(`${folder}index.html`, CLIENT)
      expect(existsSync(file), 'run bun run build: the guest bundles are built after the first one').toBe(true)
      const html = readFileSync(file, 'utf8')
      expect(html).toContain(bundleMark(bundle))
      const named = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string)
      expect(named.length).toBeGreaterThan(0)
      for (const n of named) expect([n, n.startsWith(`/${folder}`)]).toEqual([n, true])
      for (const script of html.matchAll(/<script\b([^>]*)>/g)) expect(script[1]).toContain('src="')
      expect(existsSync(new URL((named[0] as string).slice(1), CLIENT))).toBe(true)
    })
  }

  test.skipIf(!built)('the team page names none of the guest bundles files', () => {
    const team = readFileSync(new URL('index.html', CLIENT), 'utf8')
    expect(team).not.toContain('/r/_/')
    expect(team).not.toContain('/s/_/')
    expect(team).not.toContain('guest-bundle')
  })

  test.skipIf(built)('(no build here: run `bun run build` and the built Worker is checked)', () => {
    expect(built).toBe(false)
  })
})
