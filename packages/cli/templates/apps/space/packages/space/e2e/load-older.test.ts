// Load older in a real browser, over the production bundle with the dev bypass and the local fixtures (SPACE_FIXTURES=short-screen: the fixture inbox cuts its lists at four conversations, as the real one
// does at 200): the foot of a list that has more says so and has the one control; pressing it shows the next conversations below the ones shown, and again until there are none, when the control goes; a
// list read again (the page shown again) keeps every row it loaded. At a computer's width and a phone's. What no bun test can show: that the control has room, sits below the rows and nothing runs off
// the side of a phone.
//
//   bun test e2e/load-older.test.ts
//   LOAD_OLDER_SHOTS=/tmp/shots bun test e2e/load-older.test.ts   also writes the list at 1440px and 390px
//
// Nothing here is sent anywhere: the inbox is a stand-in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', fixtures: 'short-screen' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.LOAD_OLDER_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  describe(`Load older at ${size.width}px`, () => {
    test('the foot has the control below the rows; each press shows more below the rows shown, once each, until none is left', async () => {
      const ctx = await browser.newContext({ viewport: size })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/inbox`)
      await page.waitForSelector('[data-testid="row"]')
      const keys = () => page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
      const first = (await keys()) as string[]
      expect(first.length).toBeGreaterThan(0)
      const control = page.locator('[data-testid="load-older"]')
      await control.waitFor()
      expect(await control.textContent()).toBe('Load older')
      expect(await page.locator('[data-testid="load-older-row"]').textContent()).toContain('These are the newest email conversations.')
      expect(await page.locator('body').textContent()).not.toContain('Showing the newest email conversations only.')
      // Below the last row, inside the list, and on screen where a finger or a pointer can reach it.
      const box = await control.boundingBox()
      const last = await page.locator('[data-testid="row"]').last().boundingBox()
      expect(box && last && box.y >= last.y + last.height - 1).toBe(true)
      expect(box && box.width > 40 && box.height >= 28).toBe(true)
      if (shots) await page.screenshot({ path: `${shots}/list-foot-${size.width}.png` })

      let held = first
      for (let press = 0; press < 12 && (await control.count()) > 0; press++) {
        await control.scrollIntoViewIfNeeded()
        await control.click()
        await page.waitForFunction((n) => document.querySelectorAll('[data-testid="row"]').length > n || !document.querySelector('[data-testid="load-older"]'), held.length)
        const now = (await keys()) as string[]
        // What was shown stays where it was, in the same order, and nothing is shown twice.
        expect(now.slice(0, held.length)).toEqual(held)
        expect(new Set(now).size).toBe(now.length)
        held = now
      }
      expect(await control.count()).toBe(0)
      expect(held.length).toBeGreaterThan(first.length)
      if (shots) await page.screenshot({ path: `${shots}/list-all-${size.width}.png` })

      // The page shown again reads the list again, down to where it was: every row is still there, once.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForTimeout(600)
      expect(await keys()).toEqual(held)
      // Nothing runs off the side of the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(errors).toEqual([])
    })
  })
}
