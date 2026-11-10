// People in a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts): the directory, a client's profile, an outsider's
// with the inbox's suggestion, a teammate's, the same three fields beside a conversation, and a merge with its undo, at a computer's width and a phone's. What no bun test can show: that the
// page's own CSS gives each of them room, that nothing runs off the side of a phone, and that the profile opens on top of the list there and goes back.
//
//   bun test e2e/people.test.ts
//   PEOPLE_SHOTS=/tmp/shots bun test e2e/people.test.ts   also writes each screen at 1440px and 390px
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
// A page in a browser is slower than a function: each test may take a while, and each window is closed after it whether or not the test got that far.
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.PEOPLE_SHOTS
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
  const open = async (key: string) => {
    await page.goto(`${space.base}/people/${encodeURIComponent(key)}`)
    await page.waitForSelector('[data-testid="person-page"]')
  }
  return { ctx, page, errors, shot, open }
}

for (const size of ['1440', '390'] as const) {
  describe(`People at ${size}px`, () => {
    test('the directory lists Clients, Outside and Team and fits the screen', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/people`)
      await w.page.waitForSelector('[data-testid="person"]')
      expect(await w.page.locator('[data-testid="person"]').count()).toBeGreaterThanOrEqual(10)
      expect(await w.page.locator('h2.p-group').allTextContents()).toEqual(['Clients 3', 'Outside 12', 'Team 3'])
      expect(await fits(w.page)).toBe(true)
      await w.shot('people')
      expect(w.errors).toEqual([])
    })

    test('a client’s profile has the three fields, the button to their conversation, the Client and their documents; on a phone it takes the screen and goes back', async () => {
      const w = await openWindow(size)
      await w.open('dana@harbordental.example')
      expect(await w.page.inputValue('[data-testid="field-business"]')).toBe('Harbor Dental')
      expect(await w.page.getAttribute('[data-testid="open-email"]', 'href')).toBe('/inbox/dana%40harbordental.example')
      expect(await w.page.locator('[data-testid="document"]').count()).toBe(3)
      expect(await w.page.locator('[data-testid="client-name"]').textContent()).toContain('Harbor Dental')
      expect(await fits(w.page)).toBe(true)
      await w.shot('client-profile')
      await w.page.evaluate(() => document.querySelector('.detail')?.scrollTo(0, 99999))
      await w.shot('client-profile-lower')
      if (size === '390') {
        expect(await w.page.locator('[data-testid="person"]').first().isVisible()).toBe(false)
        await w.page.click('[data-testid="back-to-people"]')
        await w.page.waitForSelector('[data-testid="person"]')
        expect(await w.page.locator('[data-testid="person-page"]').count()).toBe(0)
      }
      expect(w.errors).toEqual([])
    })

    test('an outsider with a suggested Client, and a teammate with no boxes to fill', async () => {
      const w = await openWindow(size)
      await w.open('lena@fischerbakery.example')
      expect(await w.page.locator('[data-testid="suggestion"]').textContent()).toContain('Tamarack Print Supply')
      expect(await fits(w.page)).toBe(true)
      await w.shot('outside-profile')
      await w.open('priya@northfield.example')
      expect(await w.page.locator('[data-testid="profile-fields"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('team-profile')
      expect(w.errors).toEqual([])
    })

    test('the same fields beside the conversation, saved from there', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/${encodeURIComponent('lena@fischerbakery.example')}`)
      await w.page.waitForSelector('[data-testid="profile"]', { state: 'attached' })
      if (size === '390') await w.page.click('[data-testid="open-profile"]')
      await w.page.waitForSelector('[data-testid="profile-beside"]')
      // A role of its own for each size: the fixtures keep what was saved, and a save of what is already there is no change to save.
      const role = `Owner and baker at ${size}`
      await w.page.fill('[data-testid="field-role"]', role)
      await w.page.click('[data-testid="save-profile"]')
      await w.page.waitForSelector('[data-testid="saved"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('beside-conversation')
      // And People has it.
      await w.open('lena@fischerbakery.example')
      expect(await w.page.inputValue('[data-testid="field-role"]')).toBe(role)
      expect(w.errors).toEqual([])
    })

    test('a merge asks first, says what was merged with a way back, and the undo puts the other person back', async () => {
      const w = await openWindow(size)
      await w.open('dreyes.dental@mail.example')
      await w.page.click('[data-testid="open-merge"]')
      await w.page.selectOption('[data-testid="merge-select"]', 'c-dana')
      await w.page.click('[data-testid="merge-ask"]')
      await w.page.waitForSelector('[data-testid="ask"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('merge-question')
      await w.page.click('[data-testid="ask-yes"]')
      await w.page.waitForSelector('[data-testid="merged"]')
      expect(await w.page.locator('[data-testid="merged"]').textContent()).toContain('Merged Dana Reyes into Dana R.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('merged')
      await w.page.click('[data-testid="undo-merge"]')
      await w.page.waitForSelector('[data-testid="undone"]')
      await w.open('dana@harbordental.example')
      expect(await w.page.textContent('[data-testid="person-name"]')).toBe('Dana Reyes')
      expect(w.errors).toEqual([])
    })
  })
}
