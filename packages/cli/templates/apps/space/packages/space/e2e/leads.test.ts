// The company's leads in a real browser, over the production bundle with the dev bypass and the local fixtures (the stand-in's two invented leads, src/stand-in-leads.ts): the board with a column
// for each of the install's stages, a move by the stage picker, and a person's leads on their page with a lead made by hand, at a computer's width and a phone's. What no bun test can show:
// that the columns fit or stack, that nothing runs off the side of a phone, and that a move and a new lead are drawn where they belong.
//
//   bun test e2e/leads.test.ts
//   LEADS_SHOTS=/tmp/shots bun test e2e/leads.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import type { Page } from 'playwright'
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

const shots = process.env.LEADS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = {
  '1440': { width: 1440, height: 900 },
  '390': { width: 390, height: 844 },
} as const

const fits = (page: Page) =>
  page.evaluate(
    () =>
      (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth,
  )

async function openWindow(size: keyof typeof SIZES) {
  const ctx = await browser.newContext({ viewport: SIZES[size] })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name: string) => {
    if (!shots) return
    await page.waitForTimeout(300)
    await page.screenshot({
      path: `${shots}/${name}-${size}.png`,
      fullPage: true,
    })
  }
  return { page, errors, shot }
}

const stagesOf = (page: Page) => page.$$eval('[data-testid="lead-column"]', (cols) => cols.map((c) => [c.getAttribute('data-stage'), c.querySelectorAll('[data-testid="lead-card"]').length]))

for (const size of ['1440', '390'] as const) {
  describe(`Leads at ${size}px`, () => {
    test('the board has a column for each stage of the install, the leads in theirs, and fits the screen', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/leads`)
      await w.page.waitForSelector('[data-testid="lead-card"]')
      const cols = await stagesOf(w.page)
      expect(cols.map((c) => c[0])).toEqual(['new', 'contacted', 'quoted', 'won', 'lost'])
      expect(cols.reduce((n, c) => n + Number(c[1]), 0)).toBeGreaterThanOrEqual(2)
      expect(await w.page.textContent('[data-testid="lead-requests"]')).toContain('Asked 2 times')
      expect(await fits(w.page)).toBe(true)
      await w.shot('leads-board')
      expect(w.errors).toEqual([])
    })
  })
}

describe('working a lead', () => {
  test('a lead moved by its stage picker is drawn in the new column', async () => {
    const w = await openWindow('1440')
    await w.page.goto(`${space.base}/leads`)
    await w.page.waitForSelector('[data-testid="lead-card"]')
    const card = w.page.locator('[data-testid="lead-column"][data-stage="new"] [data-testid="lead-card"]').first()
    const id = await card.getAttribute('data-lead')
    await card.locator('[data-testid="lead-stage"]').selectOption('quoted')
    await w.page.waitForSelector(`[data-testid="lead-column"][data-stage="quoted"] [data-lead="${id}"]`)
    expect(w.errors).toEqual([])
  })

  test('a person’s page shows their lead, and a lead made by hand appears beside it', async () => {
    for (const size of ['1440', '390'] as const) {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/leads`)
      await w.page.waitForSelector('[data-testid="lead-card"]')
      await w.page.locator('[data-testid="lead-name"]').first().click()
      await w.page.waitForSelector('[data-testid="person-leads"] [data-testid="lead-card"]')
      const before = await w.page.locator('[data-testid="person-leads"] [data-testid="lead-card"]').count()
      await w.page.click('[data-testid="lead-make-open"]')
      await w.page.fill('[data-testid="lead-field-project"]', `Garage ${size}`)
      await w.shot('lead-make')
      await w.page.click('[data-testid="lead-make-save"]')
      await w.page.waitForFunction((n) => document.querySelectorAll('[data-testid="person-leads"] [data-testid="lead-card"]').length === n + 1, before)
      expect(await w.page.textContent('[data-testid="person-leads"]')).toContain(`Garage ${size}`)
      expect(await fits(w.page)).toBe(true)
      await w.shot('person-leads')
      expect(w.errors).toEqual([])
    }
  })
})
