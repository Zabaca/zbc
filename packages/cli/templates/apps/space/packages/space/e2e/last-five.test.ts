// The inbox page's last five jobs in the space in a real browser, over the production bundle with the dev bypass and the local fixtures: a search result that
// opens the person's conversation, a send Gmail never confirmed settled on its card, a text and a LinkedIn draft marked sent by hand and taken back, a person renamed, an address split off a
// person. At a computer's width and a phone's. What no bun test can show: that the page's own CSS gives each of them room and that nothing runs off the side of a phone.
//
//   bun test e2e/last-five.test.ts
//   LAST_FIVE_SHOTS=/tmp/shots bun test e2e/last-five.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in. Nothing here is sent anywhere: the inbox is a stand-in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

// One server per width, because the fixtures keep what a test changed: the second width would otherwise find the stuck sends already settled and the drafts already marked sent.
const servers = {} as Record<'1440' | '390', Space>
let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  servers['1440'] = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE' })
  servers['390'] = await startSpace({ build: false })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await servers['390']?.kill()
  await servers['1440']?.kill()
}, 90_000)

const shots = process.env.LAST_FIVE_SHOTS
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

for (const size of ['1440', '390'] as const) {
  describe(`The inbox page's last five jobs at ${size}px`, () => {
    beforeAll(() => {
      space = servers[size]
    })
    test('a search result opens the person’s conversation in the space, with the thread in it', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox`)
      await w.page.waitForSelector('[data-testid="search"]')
      await w.page.fill('[data-testid="search"]', 'parking sign')
      await w.page.waitForSelector('[data-testid="hit"]')
      expect(await w.page.locator('[data-testid="hit"]').first().getAttribute('href')).toBe('/inbox/marcus%40harbordental.example')
      expect(await w.page.locator('[data-testid="hit"]').first().getAttribute('target')).toBeNull()
      expect(await fits(w.page)).toBe(true)
      await w.shot('search-result')
      await w.page.click('[data-testid="hit"]')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(new URL(w.page.url()).origin).toBe(space.base)
      expect(await w.page.locator('[data-testid="convo-title"]').textContent()).toBe('Marcus Chen')
      expect(await w.page.locator('[data-testid="conversation"]').textContent()).toContain('Attached are the three angles you asked for.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('search-opened')
      expect(w.errors).toEqual([])
    })

    test('a send Gmail never confirmed: no Send, two ways to say how it went, the question asks once more, and yes removes it', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/marcus%40harbordental.example`)
      await w.page.waitForSelector('[data-testid="stuck-send"]')
      expect(await w.page.locator('[data-testid="draft"][data-draft="d-marcus-stuck"] [data-testid="send-draft"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('stuck-send')
      await w.page.click('[data-testid="stuck-out"]')
      await w.page.waitForSelector('[data-testid="stuck-ask"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('stuck-send-asking')
      await w.page.click('[data-testid="stuck-yes"]')
      await w.page.waitForFunction(() => document.querySelector('[data-draft="d-marcus-stuck"]') === null)
      expect(w.errors).toEqual([])
    })

    test('a send from a business mailbox says there is no Sent folder', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/tomas.alvarez%40mail.example`)
      await w.page.waitForSelector('[data-draft="d-lead-stuck"] [data-testid="stuck-send"]')
      expect(await w.page.locator('[data-draft="d-lead-stuck"] [data-testid="stuck-send"]').textContent()).toContain('There is no Sent folder for it: ask tomas.alvarez@mail.example')
      expect(await fits(w.page)).toBe(true)
      await w.shot('stuck-send-business')
      await w.page.click('[data-draft="d-lead-stuck"] [data-testid="stuck-not"]')
      await w.page.waitForSelector('[data-testid="stuck-ask"]')
      await w.page.click('[data-testid="stuck-yes"]')
      await w.page.waitForFunction(() => document.querySelector('[data-draft="d-lead-stuck"] [data-testid="stuck-send"]') === null)
      expect(await w.page.locator('[data-draft="d-lead-stuck"] [data-testid="send-draft"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('stuck-send-draft-again')
      expect(w.errors).toEqual([])
    })

    test('a text draft is sent by hand and marked sent; the message it makes has Not sent after all, which puts the draft back', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/mail%3Ac-text`)
      await w.page.waitForSelector('[data-draft="d-text-1"]')
      expect(await w.page.locator('[data-draft="d-text-1"] [data-testid="send-draft"]').count()).toBe(0)
      expect(await w.page.locator('[data-draft="d-text-1"] [data-testid="mark-sent"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('text-draft')
      await w.page.click('[data-draft="d-text-1"] [data-testid="mark-sent"]')
      await w.page.waitForFunction(() => document.querySelector('[data-draft="d-text-1"]') === null)
      expect(await w.page.locator('[data-testid="conversation"]').textContent()).toContain('No problem. The door is open, come straight in.')
      expect(await w.page.locator('[data-testid="not-sent-after-all"]').count()).toBe(2)
      expect(await fits(w.page)).toBe(true)
      await w.shot('text-marked-sent')
      await w.page.locator('[data-testid="not-sent-after-all"]').last().click()
      await w.page.waitForSelector('[data-draft="d-text-1"]')
      expect(await w.page.locator('[data-testid="not-sent-after-all"]').count()).toBe(1)
      expect(w.errors).toEqual([])
    })

    test('a LinkedIn draft on a person with no conversation yet is marked sent too', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/grace%40okaforlaw.example`)
      await w.page.waitForSelector('[data-draft="d-linkedin-1"]')
      expect(await w.page.locator('[data-draft="d-linkedin-1"]').textContent()).toContain('@graceokafor')
      expect(await fits(w.page)).toBe(true)
      await w.shot('linkedin-draft')
      await w.page.click('[data-draft="d-linkedin-1"] [data-testid="mark-sent"]')
      await w.page.waitForFunction(() => document.querySelector('[data-draft="d-linkedin-1"]') === null)
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })

    test('a person is renamed: the box starts from the name, Save shows the new one, and a stale screen is told so', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/people/dana%40harbordental.example`)
      await w.page.waitForSelector('[data-testid="rename"]')
      await w.page.click('[data-testid="rename"]')
      await w.page.waitForSelector('[data-testid="rename-form"]')
      expect(await w.page.inputValue('[data-testid="rename-name"]')).toBe('Dana Reyes')
      expect(await fits(w.page)).toBe(true)
      await w.shot('rename-open')
      await w.page.fill('[data-testid="rename-name"]', '   ')
      await w.page.click('[data-testid="rename-save"]')
      await w.page.waitForSelector('[data-testid="say"]')
      expect(await w.page.locator('[data-testid="say"]').textContent()).toContain('A contact needs a name.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('rename-refused')
      await w.page.fill('[data-testid="rename-name"]', 'Dana Reyes-Chen')
      await w.page.click('[data-testid="rename-save"]')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="person-name"]')?.textContent === 'Dana Reyes-Chen')
      expect(await w.page.locator('[data-testid="rename-form"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('rename-done')
      expect(w.errors).toEqual([])
    })

    test('an address is split off a person who has two: Split off beside each, and the new contact opens', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/people/tomas.alvarez%40mail.example`)
      await w.page.waitForSelector('[data-testid="split-off"]')
      expect(await w.page.locator('[data-testid="split-off"]').count()).toBe(2)
      expect(await fits(w.page)).toBe(true)
      await w.shot('split-off')
      await w.page.locator('[data-testid="split-off"]').nth(1).click()
      await w.page.waitForFunction(() => document.querySelector('[data-testid="person-name"]')?.textContent === 'tomas.alvarez@oldmail.example')
      expect(new URL(w.page.url()).pathname).toBe('/people/tomas.alvarez%40oldmail.example')
      expect(await w.page.locator('[data-testid="split-off"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('split-done')
      expect(w.errors).toEqual([])
    })
  })
}
