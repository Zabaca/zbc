// An account whose Google sign-in has lapsed, and one connected for mail without the calendar permission, in the Calendar tab, Today and Settings, Calendars, in a real browser over the production bundle built with the fixture `calendar-lapsed` (src/stand-in-calendar.ts: Tessa's ashgrove account
// lapsed, as it is in the inbox's own fixtures, since the grant is one): one amber sentence naming the account on the agenda, its last events marked old, the Connect again that hints that account to Google, and the line at the menu's foot.
// What no bun test can show: that the sentences are seen at both widths. Following Connect again is the hand test (docs/runbooks/calendar-google-setup.md).
//
//   bun test e2e/calendar-lapsed.test.ts
//   CALENDAR_SHOTS=/tmp/shots bun test e2e/calendar-lapsed.test.ts   also writes each screen at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', fixtures: 'calendar-lapsed' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.CALENDAR_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

for (const size of ['1440', '390'] as const) {
  describe(`A lapsed account at ${size}px`, () => {
    test('the agenda names it in one amber sentence with a way to Settings, and its events are marked old', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/calendar`)
      await page.waitForSelector('[data-testid="cal-trouble"]')
      // Two accounts are not whole: ashgrove's sign-in has lapsed, and tessa_marlow is connected for mail without the calendar permission.
      const trouble = page.locator('[data-testid="cal-trouble"] p')
      expect(await trouble.count()).toBe(2)
      expect(await trouble.nth(0).innerText()).toContain('tessa@ashgrove.example')
      expect(await trouble.nth(0).innerText()).toContain('Connect it again')
      expect(await trouble.nth(1).innerText()).toContain('tessa_marlow@gmail.com')
      expect(await trouble.nth(1).innerText()).toContain('Press Connect calendar')
      expect(await page.locator('[data-testid="cal-legend"] li.lapsed').innerText()).toBe('ashgrove')
      const old = page.locator('[data-testid="cal-event"].stale', { hasText: 'Ashgrove all-hands' })
      expect(await old.count()).toBe(1)
      expect(await old.innerText()).toContain('Old')
      expect(await fits(page)).toBe(true)
      if (shots) {
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${shots}/agenda-lapsed-${size}.png` })
      }
      expect(errors).toEqual([])
      await ctx.close()
    })

    test('Settings says it on the account’s own card, and Connect again names the account; the foot of the menu does not say it twice (mail says it)', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/settings/calendars`)
      await page.waitForSelector('[data-testid="calendar-account"][data-state="lapsed"]')
      const card = page.locator('[data-testid="calendar-account"][data-state="lapsed"]')
      expect(await card.getAttribute('data-account')).toBe('tessa@ashgrove.example')
      expect(await card.locator('[data-testid="calendar-reason"]').innerText()).toContain('Connect it again')
      // A lapse is the mailboxes' own sign-in (no purpose): mail is never held behind the calendar.
      expect(await card.locator('a[data-testid="calendar-connect-again"]').getAttribute('href')).toBe('/api/inbox/gmail/start?account=gmail-ashgrove')
      // An account connected for mail without the calendar permission has the calendar's own button, which asks for that one permission.
      const needs = page.locator('[data-testid="calendar-account"][data-state="needs-calendar"]')
      expect(await needs.getAttribute('data-account')).toBe('tessa_marlow@gmail.com')
      expect(await needs.locator('[data-testid="calendar-reason"]').innerText()).toContain('Press Connect calendar')
      expect(await needs.locator('a[data-testid="calendar-connect"]').getAttribute('href')).toBe('/api/inbox/gmail/start?for=calendar')
      expect(await needs.locator('[data-testid="calendar-row"]').count()).toBe(0)
      expect(await fits(page)).toBe(true)
      if (shots) {
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${shots}/settings-lapsed-${size}.png` })
      }
      // The Gmail line already names the lapsed account at the foot, so the calendar adds none for a lapse; it adds one for the account that needs the calendar permission.
      const lines = await page.locator('[data-testid="status-line"]').allInnerTexts()
      expect(lines.filter((l) => l.includes('calendar'))).toEqual(['tessa_marlow calendar: connect it'])
      expect(errors).toEqual([])
      await ctx.close()
    })
  })
}
