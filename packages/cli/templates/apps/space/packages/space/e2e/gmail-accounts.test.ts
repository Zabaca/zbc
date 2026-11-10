// Several Gmail accounts in Settings, Mailboxes, in a real browser over the production bundle with the dev bypass and the local fixtures (src/fixture-views.ts: Tessa's northfield account, live, and
// his ashgrove account, whose sign-in has lapsed): a card for each, the lapsed one saying so first and by name, Connect again naming the account, Connect Gmail adding another, and the menu's
// foot with a line for each. What no bun test can show: that the cards fit a phone and the amber lines are seen. Nothing here reaches Google: the inbox is a stand-in, and following Connect
// is the hand test (docs/runbooks/inbox-gmail-accounts.md).
//
//   bun test e2e/gmail-accounts.test.ts
//   GMAIL_SHOTS=/tmp/shots bun test e2e/gmail-accounts.test.ts   also writes each screen at 1440px and 390px
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

const shots = process.env.GMAIL_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

for (const size of ['1440', '390'] as const) {
  describe(`Gmail accounts in Settings at ${size}px`, () => {
    test('each account is a card; the lapsed one says so first, by name, with Connect again as its one move; Connect Gmail adds another; and the page fits', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/settings/mailboxes`)
      await page.waitForSelector('[data-testid="gmail-accounts"]')
      expect(await page.locator('[data-testid="gmail-accounts"]').getAttribute('data-count')).toBe('2')

      const cards = page.locator('[data-testid="gmail"]')
      expect(await cards.count()).toBe(2)
      const live = page.locator('[data-testid="gmail"][data-state="live"]')
      const lapsed = page.locator('[data-testid="gmail"][data-state="lapsed"]')
      expect(await live.textContent()).toContain('tessa@northfield.example')
      expect(await lapsed.textContent()).toContain('tessa@ashgrove.example')
      expect(await lapsed.locator('[data-testid="gmail-lapsed"]').textContent()).toContain('Connect it again')
      expect(await page.locator('[data-testid="gmail-lapsed-summary"]').textContent()).toBe('tessa@ashgrove.example needs to be connected again.')
      // A lapsed account has nothing to sync; a live one has.
      expect(await lapsed.locator('[data-testid="sync-gmail"]').count()).toBe(0)
      expect(await live.locator('[data-testid="sync-gmail"]').count()).toBe(1)
      // Connect again names the account; Connect Gmail names none (Google asks which).
      expect(await lapsed.locator('[data-testid="reconnect-gmail"]').getAttribute('href')).toBe('/api/inbox/gmail/start?account=gmail-ashgrove')
      expect(await page.locator('[data-testid="connect-gmail"]').getAttribute('href')).toBe('/api/inbox/gmail/start')

      expect(await fits(page)).toBe(true)
      if (shots) {
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${shots}/gmail-accounts-${size}.png` })
      }
      expect(errors).toEqual([])
    })

    test('disconnecting asks about the account it was pressed on, and only that one; keeping it puts the card back', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      await page.goto(`${space.base}/settings/mailboxes`)
      await page.waitForSelector('[data-testid="gmail-accounts"]')
      const lapsed = page.locator('[data-testid="gmail"][data-state="lapsed"]')
      await lapsed.locator('[data-testid="disconnect-gmail"]').click()
      expect(await page.locator('[data-testid="gmail"] >> text=Disconnect tessa@ashgrove.example?').count()).toBe(1)
      expect(await page.locator('text=Disconnect tessa@northfield.example?').count()).toBe(0)
      await page.getByRole('button', { name: 'Keep it' }).click()
      expect(await page.locator('text=Disconnect tessa@ashgrove.example?').count()).toBe(0)
      expect(await fits(page)).toBe(true)
    })
  })
}
