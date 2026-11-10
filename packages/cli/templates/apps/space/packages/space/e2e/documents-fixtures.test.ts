// The cards in a conversation as the fixtures show them (the invented people and documents of src/stand-ins.ts, no forms): Dana's conversation has one document out for
// signature and one signed and back, Rosa's a draft, and nobody else's has any. Both widths, nothing off the side of a phone. The browser session over the real forms is
// documents-in-conversation.test.ts.
//
//   bun test e2e/documents-fixtures.test.ts
//   CARD_SHOTS=/tmp/shots bun test e2e/documents-fixtures.test.ts   also writes the conversations at 1440px and 390px
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

const shots = process.env.CARD_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

const fits = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main.main') as HTMLElement
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
  })

for (const size of ['1440', '390'] as const) {
  describe(`cards in a conversation at ${size}px`, () => {
    async function open(key: string, tab: 'inbox' | 'meet' = 'inbox') {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/${tab}/${encodeURIComponent(key)}`)
      await page.waitForSelector('[data-testid="conversation"]')
      return { page, errors }
    }

    test('Dana’s has the document out for signature and the one signed and back, in time order, as cards that open in Forms', async () => {
      const { page, errors } = await open('dana@harbordental.example')
      const cards = page.locator('[data-testid="document-card"]')
      await cards.first().waitFor()
      expect(await cards.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-doc')}: ${e.getAttribute('data-state')}`))).toEqual(['e-photo: sent', 'e-agreement: completed'])
      expect(await page.locator('[data-testid="document-open"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(['/forms/envelopes/e-photo', '/forms/envelopes/e-agreement'])
      // The hosting renewal went from Forms: Dana's page lists it, her conversation does not.
      expect(await page.getByText('Hosting renewal, Harbor Dental').count()).toBe(0)
      expect(await page.locator('[data-testid="document-back"]').count()).toBe(1)
      expect(await fits(page)).toBe(true)
      if (shots) {
        await page.locator('[data-testid="document-card"]').last().scrollIntoViewIfNeeded()
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${shots}/fixture-dana-${size}.png` })
      }
      expect(errors).toEqual([])
    })

    test('Rosa’s has a draft card, and Marcus’s and the channel’s have none', async () => {
      const rosa = await open('rosa_whitfield@yahoo.example')
      await rosa.page.locator('[data-testid="document-card"]').waitFor()
      expect(await rosa.page.locator('[data-testid="document-card"]').getAttribute('data-state')).toBe('draft')
      expect(await rosa.page.locator('[data-testid="document-state"]').textContent()).toContain('Draft, not sent')
      const marcus = await open('marcus@harbordental.example')
      expect(await marcus.page.locator('[data-testid="document-card"]').count()).toBe(0)
      const room = await open('chat:channel:21', 'meet')
      expect(await room.page.locator('[data-testid="document-card"]').count()).toBe(0)
      expect(await fits(rosa.page)).toBe(true)
    })
  })
}
