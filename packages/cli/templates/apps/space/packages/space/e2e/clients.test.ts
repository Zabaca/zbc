// Settings › Clients and People's Link to a Client in a real browser, over the production bundle with the dev bypass and the local fixtures (src/stand-in-clients.ts: five Clients a source brought in, one made here): the list
// with its fold of archived Clients and the line for when the source last sent, New Client, a Client's page with the source's part and whether its names follow it, Edit, Archive and Put back, and People's picker with its
// New Client, at a computer's width and a phone's. What no bun test can show: that the page's own CSS gives each of them room, and that nothing runs off the side of a phone.
//
//   bun test e2e/clients.test.ts
//   CLIENTS_SHOTS=/tmp/shots bun test e2e/clients.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.CLIENTS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

async function openWindow(size: keyof typeof SIZES) {
  const ctx = await browser.newContext({ viewport: SIZES[size] })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name: string) => {
    if (!shots) return
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${shots}/${name}-${size}.png` })
  }
  return { ctx, page, errors, shot }
}

const ids = (page: Page, testid: string) => page.locator(`[data-testid="${testid}"] [data-testid="client"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))

for (const size of ['1440', '390'] as const) {
  describe(`Settings, Clients at ${size}px`, () => {
    test('the list: the active Clients, where each came from, the line for the source, the fold of archived ones, and New Client', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/clients`)
      await w.page.waitForSelector('[data-testid="client"]')
      expect(await ids(w.page, 'clients')).toEqual(expect.arrayContaining(['3', '6', '7', '9', '1001']))
      expect(await w.page.locator('[data-testid="source-line"]').textContent()).toContain('northfield.example last sent something')
      expect(await w.page.locator('[data-testid="archived-fold"] summary').textContent()).toContain('Archived (')
      expect(await w.page.locator('[data-testid="new-client"]').textContent()).toBe('New Client')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-list')
      // The fold opened, with the archived Client in it.
      await w.page.locator('[data-testid="archived-fold"] summary').click()
      await w.page.waitForSelector('[data-testid="archived-clients"] [data-testid="client"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-list-archived')
      expect(w.errors).toEqual([])
    })

    test('New Client: a name is all it needs, and the page then shows it as made here', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/clients`)
      await w.page.waitForSelector('[data-testid="new-client"]')
      await w.page.locator('[data-testid="new-client"]').click()
      await w.page.waitForSelector('[data-testid="new-client-form"]')
      expect(await w.page.locator('[data-testid="make-client"]').isDisabled()).toBe(true)
      await w.page.locator('[data-testid="field-name"]').fill(`Sunrise Plumbing ${size}`)
      await w.page.locator('[data-testid="field-legal-name"]').fill('Sunrise Plumbing and Heating LLC')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-new')
      await w.page.locator('[data-testid="make-client"]').click()
      await w.page.waitForSelector('[data-testid="client-page"]')
      expect(await w.page.locator('[data-testid="client-details"]').textContent()).toContain(`Sunrise Plumbing ${size}`)
      expect(await w.page.locator('[data-testid="client-details"]').textContent()).toContain('Made here')
      expect(await w.page.locator('[data-testid="from-source"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })

    test('a Client’s page: the source’s part, whether the names follow it, the people it holds and the people it suggests', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/clients/7`)
      await w.page.waitForSelector('[data-testid="client-page"]')
      const fields = await w.page.locator('[data-testid="source-field"]').allTextContents()
      expect(fields.slice(0, 2)).toEqual(['Client Portal sign-indana@harbordental.example', 'Subscriptionactive'])
      expect(await w.page.locator('[data-testid="follows"]').textContent()).toContain('names follow northfield.example')
      expect(await w.page.locator('[data-testid="client-admin"]').textContent()).toBe('Open in northfield.example’s admin')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-page')
      // A name Tessa edited says what the source calls it; a Client the source stopped listing says since when.
      await w.page.goto(`${space.base}/settings/clients/3`)
      await w.page.waitForSelector('[data-testid="edited-name"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-page-edited-name')
      await w.page.goto(`${space.base}/settings/clients/6`)
      await w.page.waitForSelector('[data-testid="gone"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-page-gone')
      expect(w.errors).toEqual([])
    })

    test('Edit: the boxes open on the Client, Save is not offered until something changed, and the page then shows the new name', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/clients/9`)
      await w.page.waitForSelector('[data-testid="edit-client"]')
      await w.page.locator('[data-testid="edit-client"]').click()
      await w.page.waitForSelector('[data-testid="edit-client-form"]')
      expect(await w.page.locator('[data-testid="save-client"]').isDisabled()).toBe(true)
      await w.page.locator('[data-testid="field-name"]').fill(`Lakeside Printing ${size}`)
      await w.page.locator('[data-testid="field-legal-name"]').fill('Lakeside Print Supply Co.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-edit')
      await w.page.locator('[data-testid="save-client"]').click()
      await w.page.waitForSelector('[data-testid="edited-name"]')
      expect(await w.page.locator('[data-testid="client-details"]').textContent()).toContain(`Lakeside Printing ${size}`)
      expect(await w.page.locator('[data-testid="done"]').textContent()).toContain('Saved.')
      expect(w.errors).toEqual([])
    })

    test('Archive moves a Client into the fold and Put back returns it', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/clients/1001`)
      await w.page.waitForSelector('[data-testid="archive-client"]')
      await w.page.locator('[data-testid="archive-client"]').click()
      await w.page.waitForSelector('[data-testid="archived-note"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('clients-page-archived')
      await w.page.goto(`${space.base}/settings/clients`)
      await w.page.waitForSelector('[data-testid="archived-fold"]')
      expect(await ids(w.page, 'clients')).not.toContain('1001')
      await w.page.goto(`${space.base}/settings/clients/1001`)
      await w.page.waitForSelector('[data-testid="put-back-client"]')
      await w.page.locator('[data-testid="put-back-client"]').click()
      await w.page.waitForSelector('[data-testid="archive-client"]')
      expect(w.errors).toEqual([])
    })
  })

  describe(`People, link to a Client at ${size}px`, () => {
    test('the picker offers the active Clients and New Client, and New Client makes the Client and links the person', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/people/${encodeURIComponent(size === '1440' ? 'lena@fischerbakery.example' : 'tomas.alvarez@mail.example')}`)
      await w.page.waitForSelector('[data-testid="person-page"]')
      await w.page.locator('[data-testid="choose-client"]').click()
      await w.page.waitForSelector('[data-testid="client-select"]')
      const options = await w.page.locator('[data-testid="client-select"] option').allTextContents()
      expect(options).toContain('Harbor Dental')
      expect(options).not.toContain('Old Harbor Marine')
      expect(await fits(w.page)).toBe(true)
      await w.shot('people-link')
      await w.page.locator('[data-testid="new-client-here"]').click()
      await w.page.waitForSelector('[data-testid="new-client-form"]')
      await w.page.locator('[data-testid="new-client-form"] [data-testid="field-name"]').fill(`Fischer Cafe ${size}`)
      expect(await fits(w.page)).toBe(true)
      await w.shot('people-link-new')
      await w.page.locator('[data-testid="make-client"]').click()
      await w.page.waitForSelector('[data-testid="client-link"]')
      expect(await w.page.locator('[data-testid="client-name"]').textContent()).toContain(`Linked to Fischer Cafe ${size}.`)
      expect(await w.page.locator('[data-testid="client-done"]').textContent()).toContain('Made')
      // The pill and the line open the Client's page.
      await w.page.locator('[data-testid="client-link"]').click()
      await w.page.waitForSelector('[data-testid="client-page"]')
      expect(await w.page.locator('[data-testid="client-details"]').textContent()).toContain(`Fischer Cafe ${size}`)
      expect(w.errors).toEqual([])
    })
  })
}
