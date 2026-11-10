// Call links come from one address, the install's: a path the space opens to anyone with no sign-in (the space's ADR 0018). Meet's pages are served only on the space's host (meet.northfield.example is gone),
// so a page builds a link on the address it was opened at, which IS the install's, and holds no host of its own.
// These drive the two decisions a page makes, which address a link is built on and which links read "Join call".
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { northfieldSettings as bundledSettings } from '../../../kit/northfield'
import { callLink, siteOrigin } from '../src/web/site'
import { callOf, messageParts } from '../src/web/workspace/links'

const SPACE = { origin: 'https://space.northfield.example' }
const OTHER = { origin: 'https://space.brightwater.example' }
const name = 'k7m2qx9frtn4w6hbc8jd'

describe('a link made or copied on the install’s page opens on the install’s space', () => {
  test('the link to a call is built on the address of the page, which is the space’s: Northfield’s and another company’s alike', () => {
    expect(callLink(name, SPACE)).toBe(`https://space.northfield.example/r/${name}`)
    expect(callLink(name, OTHER)).toBe(`https://space.brightwater.example/r/${name}`)
    expect(siteOrigin(SPACE)).toBe('https://space.northfield.example')
  })

  test('a link pasted in a conversation inside the space still reads "Join call", and opens on the space', () => {
    const origin = siteOrigin(SPACE)
    const href = callLink(name, SPACE)
    const parts = messageParts(`come in: ${href}`, origin)
    const link = parts.find((p) => p.kind === 'link')
    expect(link).toMatchObject({ kind: 'link', label: 'Join call', href })
    expect(callOf(href, origin)).toBe(name)
  })

  test('a link to another address is no longer a call here: it is a plain link (meet’s old address was removed at the cutover, and old links are not resent), and another install’s call is not this one’s', () => {
    const origin = siteOrigin(SPACE)
    expect(callOf(`https://meet.northfield.example/r/${name}`, origin)).toBeNull()
    const parts = messageParts(`https://meet.northfield.example/r/${name}`, origin)
    expect(parts.find((p) => p.kind === 'link')).toMatchObject({ label: `https://meet.northfield.example/r/${name}` })
    expect(callOf(callLink(name, OTHER), origin)).toBeNull()
  })

  test('a run on this machine (dev server, the live scripts) builds on its own address, since it has no other', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const page = { origin: `http://${host}:4812` }
      expect(callLink(name, page)).toBe(`http://${host}:4812/r/${name}`)
    }
  })

  test('no setting names the address: the Worker makes every link from the install’s space host, and the page holds no host of its own', () => {
    const wrangler = JSON.stringify(bundledSettings)
    expect(wrangler).not.toContain('MEET_APP_ORIGIN')
    const site = readFileSync(new URL('../src/web/site.ts', import.meta.url), 'utf8')
    // No address of any kind is written into the page's module: a host typed there would be a second source of the install's address.
    expect(site).not.toMatch(/https?:\/\//)
    expect(site).not.toMatch(/['"`][a-z0-9-]+(?:\.[a-z0-9-]+)+['"`/]/i)
  })

  test('no page builds a link from its own address any more', () => {
    const root = fileURLToPath(new URL('../src/web', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const path = join(dir, f)
        if (statSync(path).isDirectory()) walk(path)
        else files.push(path)
      }
    }
    walk(root)
    const offenders = files.filter((f) => /\.(ts|tsx)$/.test(f) && /location\.origin/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
