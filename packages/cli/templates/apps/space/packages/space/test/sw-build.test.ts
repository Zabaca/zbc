// What makes the space an app a phone or a Mac can install and send notifications to: its manifest, its icons, and its service worker, which the build writes as ONE file that
// imports nothing (a worker that imports a chunk is one Access can refuse: the inbox found that out on a phone). The built file is read from dist/, so build first
// (`bun run build`); without a build only the sources are checked, and the test says so.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { MESSAGES } from '../src/client/sw-push'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const exists = (path: string) => existsSync(new URL(path, import.meta.url))

describe('the manifest and the icons', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest')) as {
    id: string
    name: string
    short_name: string
    start_url: string
    scope: string
    display: string
    icons: { src: string; sizes: string; type: string; purpose: string }[]
  }

  test('the space installs as its own app at its own address, opening on the root, which opens Today (its name is the install’s: the Worker answers it as "<company> Space", test/manifest.test.ts)', () => {
    expect(manifest).toMatchObject({ id: '/', name: 'Space', short_name: 'Space', start_url: '/', scope: '/', display: 'standalone' })
  })

  test('the icons it names are there, an "any" pair and a maskable one, and the badge the notification shows', () => {
    expect(manifest.icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ])
    for (const icon of manifest.icons) expect([icon.src, exists(`../public${icon.src}`)]).toEqual([icon.src, true])
    expect(exists('../public/icons/badge-96.png')).toBe(true)
  })

  test('the page links the manifest with credentials, or Chrome fetches it with none, meets Access’s sign-in and never offers to install', () => {
    const html = read('../index.html')
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/)
  })
})

describe('the service worker as built', () => {
  const built = exists('../dist/client/sw.js')

  test.skipIf(!built)('is one file at the root with no import, and keeps nothing: its fetch handler answers nothing', () => {
    const sw = read('../dist/client/sw.js')
    expect(sw).not.toMatch(/\bimport\s*[({"'*\w]/)
    expect(sw).not.toMatch(/\bimportScripts\b/)
    expect(sw).not.toMatch(/caches\b/) // it never keeps a mail or a page on the device
    expect(sw).toContain('"fetch"')
    // The words it and the page speak are the ones the source says.
    for (const message of Object.values(MESSAGES)) expect(sw).toContain(message)
  })

  test.skipIf(!built)('the built page and files are there for it: the manifest and the icons beside it', () => {
    for (const file of ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/badge-96.png', 'index.html']) {
      expect([file, exists(`../dist/client/${file}`)]).toEqual([file, true])
    }
  })

  test.skipIf(built)('(no build here: run `bun run build` and the built worker is checked)', () => {
    expect(built).toBe(false)
  })
})
