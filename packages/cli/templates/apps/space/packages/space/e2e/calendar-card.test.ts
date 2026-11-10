// An email's calendar card in a conversation and the list's line, in a real browser over the production bundle built with the fixture `calendar-mail` (src/fixture-calendar-mail.ts: one invented person, Ana Vidal, whose emails carry a calendar
// part and no words of their own): every kind of card at 1440px and 390px, no empty bubble where a card is, the file kept apart from the card, the list's line for an email with no words, and the owner's "Open in Calendar" for an
// event in the Calendar tab (src/stand-in-calendar.ts), which opens that event's card. What no bun test can show: that the cards fit and read at both widths. Following the link on a real Google calendar is the hand test.
//
//   bun test e2e/calendar-card.test.ts
//   CALENDAR_CARD_SHOTS=/tmp/shots bun test e2e/calendar-card.test.ts   also writes each kind of card and the conversation at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', fixtures: 'calendar-mail' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.CALENDAR_CARD_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** One kind of card by what it says, and the name its screenshot is saved under. */
const KINDS: { name: string; heading: RegExp; title?: string }[] = [
  { name: 'invitation', heading: /^Invitation$/, title: 'Roadmap review' },
  { name: 'updated-invitation', heading: /^Updated invitation$/ },
  { name: 'accepted', heading: /^Ana Vidal accepted$/, title: 'Roadmap review' },
  { name: 'declined-with-note', heading: /^Ana Vidal declined$/ },
  { name: 'maybe', heading: /^Ana Vidal said maybe$/ },
  { name: 'new-time-proposed', heading: /^Ana Vidal proposed a new time/ },
  { name: 'bare-answer-with-calendar-link', heading: /^Ana Vidal accepted$/, title: 'Advisory intro: Maria Lopez' },
  { name: 'cancelled', heading: /^Cancelled$/ },
  { name: 'event', heading: /^Event$/, title: 'Bike fitting at Ridgeway Cycles' },
  { name: 'from-you', heading: /^Invitation$/, title: 'Brand review' },
  { name: 'all-day', heading: /^Invitation$/, title: 'Team offsite' },
]

const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

for (const size of ['1440', '390'] as const) {
  describe(`An email with a calendar part at ${size}px`, () => {
    test('a conversation draws a card for each email and no empty bubble, and every kind of card fits and reads', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/inbox/ana@vidalcreative.example`)
      await page.waitForSelector('[data-testid="calendar-card"]')
      const cards = page.locator('[data-testid="calendar-card"]')
      expect(await cards.count()).toBe(15)
      expect(await page.locator('[data-testid="entry"] .msg-text').count()).toBe(0)
      expect(await page.locator('[data-testid="entry"]').count()).toBe(15)

      for (const kind of KINDS) {
        const named = cards.filter({ has: page.locator('[data-testid="calendar-heading"]', { hasText: kind.heading }) })
        const card = (kind.title ? named.filter({ has: page.locator('[data-testid="calendar-title"]', { hasText: kind.title }) }) : named).first()
        expect(await card.count(), kind.name).toBe(1)
        await card.scrollIntoViewIfNeeded()
        // The card is inside the column at this width: it never runs off the screen.
        const box = await card.boundingBox()
        expect(box && box.x >= 0 && box.x + box.width <= SIZES[size].width, kind.name).toBe(true)
        if (shots) await card.screenshot({ path: `${shots}/card-${kind.name}-${size}.png` })
      }

      // A bare answer took its title and time from the Calendar tab, and opens that event there.
      const lent = cards.filter({ has: page.locator('[data-testid="calendar-title"]', { hasText: 'Advisory intro: Maria Lopez' }) })
      expect(await lent.count()).toBe(1)
      expect(await lent.locator('[data-testid="calendar-when"]').innerText()).toMatch(/4:00 PM to 4:30 PM/)
      expect(await page.locator('[data-testid="calendar-open"]').count()).toBe(1)

      expect(await fits(page)).toBe(true)
      if (shots) {
        await page.screenshot({ path: `${shots}/conversation-newest-${size}.png` })
        await page.locator('[data-testid="entry"]').first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${shots}/conversation-oldest-${size}.png` })
      }
      expect(errors).toEqual([])
      await ctx.close()
    })

    test('Open in Calendar opens the event’s card in the Calendar tab', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/inbox/ana@vidalcreative.example`)
      await page.waitForSelector('[data-testid="calendar-open"]')
      await page.locator('[data-testid="calendar-open"]').click()
      await page.waitForURL(/\/calendar\/event\//)
      // The event's own card, and not the agenda's row behind it (at a phone's width one of the two is hidden).
      await page.getByText('Advisory intro: Maria Lopez').last().waitFor({ state: 'visible' })
      expect(await page.locator('body').innerText()).toContain('Advisory intro: Maria Lopez')
      expect(errors).toEqual([])
      await ctx.close()
    })

    test('the Inbox list says what an email with no words says: the line its calendar part makes', async () => {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}/inbox`)
      await page.waitForSelector('text=Ana Vidal')
      const row = page.locator('[data-testid="row"]', { hasText: 'Ana Vidal' }).first()
      // The newest email Ana sent is the invitation Tessa sent her (the stand-in's "Brand review"), whose line is the summary's.
      expect(await row.innerText()).toMatch(/Invitation: Brand review, \w{3}, \w{3} \d{1,2}, 3:00 PM to 3:45 PM P[SD]T/)
      expect(await fits(page)).toBe(true)
      if (shots) {
        await row.scrollIntoViewIfNeeded()
        await row.screenshot({ path: `${shots}/list-line-${size}.png` })
      }
      expect(errors).toEqual([])
      await ctx.close()
    })
  })
}
