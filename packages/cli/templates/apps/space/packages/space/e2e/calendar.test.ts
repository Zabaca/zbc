// The Calendar tab, Today's events and Settings, Calendars in a real browser, over the production bundle with the dev bypass and the local fixtures (src/stand-in-calendar.ts: four invented Google accounts and a week of
// events, laid on the company's clock around the moment the server started): the agenda by day with each account's colour, the card an event opens, Today's Later today and Tomorrow beside Meet's meetings, Settings, Calendars with its
// switches, and the tab strip with seven tabs and the gear. What no bun test can show: that the strip of seven fits a phone, that the agenda and the card fit both widths, and that nothing runs off the side of a screen.
//
//   bun test e2e/calendar.test.ts
//   CALENDAR_SHOTS=/tmp/shots bun test e2e/calendar.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in. The lapsed account's screens are e2e/calendar-lapsed.test.ts (the fixture is chosen when the bundle is built).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { addDays, dayKey } from '../src/client/calendar-words'
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

const shots = process.env.CALENDAR_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

/** Today on the company's clock, as the fixtures lay their days. */
const TODAY = dayKey(Date.now(), 'America/Los_Angeles')

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
  describe(`The Calendar at ${size}px`, () => {
    test('the strip has seven tabs and the gear, each with room to be pressed, and none runs off the screen', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/calendar`)
      await w.page.waitForSelector('[data-testid="calendar-tab"]')
      const tabs = w.page.locator('nav.rail a.rail-item')
      const labels = await tabs.evaluateAll((els) => els.map((e) => (e.querySelector('.rail-label') as HTMLElement).innerText.trim()))
      expect(labels).toEqual(['Today', 'Inbox', 'Meet', 'Calendar', 'Forms', 'People', 'Knowledge', 'Settings'])
      const boxes = await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, width: r.width })))
      // Every item is inside the window and wide enough to press.
      for (const b of boxes) {
        expect(b.left).toBeGreaterThanOrEqual(0)
        expect(b.right).toBeLessThanOrEqual(SIZES[size].width + 0.5)
      }
      // On a phone the seven tabs have about 49px each and the gear, an icon alone, 42 (the strip is 52px tall).
      if (size === '390') boxes.forEach((b, i) => expect(b.width).toBeGreaterThanOrEqual(i < 7 ? 44 : 40))
      // No label is cut short: Knowledge, the longest, is read whole in its eighth of the strip.
      // Measured on the text itself, since an element can be "just wide enough" and still draw its ellipsis.
      const cut = await w.page.locator('nav.rail .rail-label').evaluateAll((els) =>
        els
          .filter((e) => {
            const range = document.createRange()
            range.selectNodeContents(e)
            const item = (e.parentElement as HTMLElement).getBoundingClientRect().width
            return range.getBoundingClientRect().width > item || e.scrollWidth > e.clientWidth
          })
          .map((e) => { const r = document.createRange(); r.selectNodeContents(e); return `${(e as HTMLElement).innerText} text ${r.getBoundingClientRect().width.toFixed(1)} item ${(e.parentElement as HTMLElement).getBoundingClientRect().width.toFixed(1)} label ${e.clientWidth}/${e.scrollWidth}` }),
      )
      expect(cut).toEqual([])
      expect(await w.page.locator('nav.rail a[data-tab="calendar"][aria-current="page"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('tabs')
      expect(w.errors).toEqual([])
    })

    test('the agenda is today first and then each day with something on it, every account in its own colour, the meetings booked in Meet among them', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/calendar`)
      await w.page.waitForSelector('[data-testid="cal-event"]')
      expect(await w.page.locator('[data-testid="cal-day"]').first().getAttribute('aria-label')).toBe('Today')
      expect(await w.page.locator('[data-testid="cal-legend"] li').allTextContents()).toEqual(['northfield', 'ashgrove', 'tessa_marlow', 'fernway'])
      expect(await w.page.locator('[data-testid="cal-event"]', { hasText: 'Board call' }).count()).toBe(1)
      // Both accounts, as two dots (the names beside them are left out on a phone, where the legend is the key).
      expect(await w.page.locator('[data-testid="cal-event"]', { hasText: 'Board call' }).locator('[data-testid="cal-accounts"] [role="img"]').getAttribute('aria-label')).toBe('northfield, ashgrove')
      expect(await w.page.locator('[data-testid="cal-meeting"]').count()).toBeGreaterThan(0)
      // The colours are the account's: two rows of different accounts do not share a bar colour.
      const colours = await w.page.locator('[data-testid="cal-event"] .cal-bar').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
      expect(new Set(colours).size).toBeGreaterThanOrEqual(3)
      expect(await w.page.locator('[data-testid="cal-event"]', { hasText: 'Observed holiday' }).count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('agenda')
      await w.page.evaluate(() => document.querySelector('main.main')?.scrollTo(0, 99999))
      await w.shot('agenda-lower')
      expect(w.errors).toEqual([])
    })

    test('an event opens its card on the address; on a phone the card takes the screen and the Agenda button comes back', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/calendar`)
      await w.page.waitForSelector('[data-testid="cal-event"]')
      await w.page.locator('[data-testid="cal-event"]', { hasText: 'Intro chat with Arun Mehta' }).click()
      await w.page.waitForSelector('[data-testid="cal-card"]')
      expect(new URL(w.page.url()).pathname).toMatch(/^\/calendar\/event\//)
      expect(await w.page.locator('[data-testid="cal-card-title"]').innerText()).toBe('Intro chat with Arun Mehta')
      expect(await w.page.locator('[data-testid="cal-card-when"]').innerText()).toMatch(/P[SD]T$/)
      expect(await w.page.locator('[data-testid="cal-card-guests"]').innerText()).toContain('Arun Mehta')
      expect(await w.page.locator('[data-testid="cal-card-response"]').innerText()).toContain('Not answered')
      if (size === '390') expect(await w.page.locator('[data-testid="cal-event"]').first().isVisible()).toBe(false)
      expect(await fits(w.page)).toBe(true)
      await w.shot('card')
      // The back button of the browser closes it, as the address holds it.
      await w.page.goBack()
      await w.page.waitForSelector('[data-testid="cal-event"]')
      expect(await w.page.locator('[data-testid="cal-card"]').count()).toBe(0)
      // A meeting on two calendars says both, and its video call opens in a tab of its own.
      await w.page.locator('[data-testid="cal-event"]', { hasText: 'Board call' }).click()
      await w.page.waitForSelector('[data-testid="cal-card"]')
      expect(await w.page.locator('[data-testid="cal-card-accounts"]').innerText()).toContain('the same meeting is on each')
      const video = w.page.locator('[data-testid="cal-card-video"] a')
      expect(await video.getAttribute('target')).toBe('_blank')
      expect(await video.getAttribute('rel')).toContain('noopener')
      expect(await fits(w.page)).toBe(true)
      await w.shot('card-two-accounts')
      expect(w.errors).toEqual([])
    })

    test('Today lists the calendar’s events beside Meet’s meetings, each opening its card', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/today`)
      await w.page.waitForSelector('[data-section="tomorrow"]')
      expect(await w.page.locator('[data-section="tomorrow"] [data-testid="event"]').count()).toBeGreaterThanOrEqual(3)
      expect(await w.page.locator('[data-section="tomorrow"] [data-testid="meeting"]').count()).toBeGreaterThanOrEqual(1)
      expect(await w.page.locator('[data-section="tomorrow"] [data-testid="event"]', { hasText: 'Weekly planning' }).getAttribute('href')).toMatch(/^\/calendar\/event\//)
      expect(await fits(w.page)).toBe(true)
      await w.shot('today')
      await w.page.locator('[data-section="tomorrow"] [data-testid="event"]', { hasText: 'Weekly planning' }).click()
      await w.page.waitForSelector('[data-testid="cal-card"]')
      expect(await w.page.locator('[data-testid="cal-card-title"]').innerText()).toBe('Weekly planning')
      expect(w.errors).toEqual([])
    })

    test('Settings, Calendars: a card for each account with its calendars and switches, and a switch brings a hidden calendar’s events into the agenda', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/calendars`)
      await w.page.waitForSelector('[data-testid="calendar-accounts"]')
      expect(await w.page.locator('[data-testid="calendar-account"]').count()).toBe(4)
      expect(await fits(w.page)).toBe(true)
      await w.shot('settings')
      const holidays = w.page.locator('[data-testid="calendar-row"]', { hasText: 'Holidays in United States' })
      expect(await holidays.getAttribute('data-shown')).toBe('false')
      await holidays.locator('[data-testid="calendar-switch"]').click()
      await w.page.waitForSelector('[data-testid="calendar-row"][data-shown="true"]:has-text("Holidays in United States")')
      expect(await w.page.locator('[data-testid="done"]').innerText()).toContain('It is shown now')
      await w.shot('settings-switched')
      await w.page.goto(`${space.base}/calendar`)
      await w.page.waitForSelector('[data-testid="cal-event"]')
      expect(await w.page.locator('[data-testid="cal-event"]', { hasText: 'Observed holiday' }).count()).toBe(1)
      // Put it back, so the next window starts as the first did.
      await w.page.goto(`${space.base}/settings/calendars`)
      await w.page.locator('[data-testid="calendar-row"]', { hasText: 'Holidays in United States' }).locator('[data-testid="calendar-switch"]').click()
      await w.page.waitForSelector('[data-testid="calendar-row"][data-shown="false"]:has-text("Holidays in United States")')
      expect(w.errors).toEqual([])
    })

    test('the week: a column a day (three on a phone), an all-day row, today lit with a line for now, events as blocks inside their columns; a block opens its card and the address keeps the week', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/calendar?view=week`)
      await w.page.waitForSelector('[data-testid="cal-block"]')
      expect(await w.page.locator('[data-testid="cal-week-col"]').count()).toBe(size === '1440' ? 7 : 3)
      expect(await w.page.locator('[data-testid="cal-week-day"].today').count()).toBe(1)
      expect(await w.page.locator('[data-testid="cal-now"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="cal-allday"]').isVisible()).toBe(true)
      expect(await w.page.locator('[data-testid="cal-range"]').innerText()).toMatch(/^[A-Z][a-z]{2} \d+/)
      // Every block lies inside its own day's column, and the switcher and the arrows are big enough to press.
      const outside = await w.page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="cal-week-col"]')].flatMap((col) => {
          const c = col.getBoundingClientRect()
          return [...col.querySelectorAll('[data-testid="cal-block"]')]
            .filter((b) => {
              const r = b.getBoundingClientRect()
              return r.left < c.left - 1 || r.right > c.right + 1
            })
            .map((b) => b.getAttribute('title'))
        }),
      )
      expect(outside).toEqual([])
      for (const id of ['cal-view-agenda', 'cal-view-week', 'cal-view-month', 'cal-prev', 'cal-next', 'cal-today']) {
        const box = await w.page.locator(`[data-testid="${id}"]`).boundingBox()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(30)
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(SIZES[size].width)
      }
      expect(await fits(w.page)).toBe(true)
      await w.shot('week')
      // The day after tomorrow has three events that overlap at 10: side by side, none hiding another.
      await w.page.goto(`${space.base}/calendar?view=week&date=${addDays(TODAY, 2)}`)
      await w.page.waitForSelector('[data-testid="cal-block"]')
      const lefts = await w.page.evaluate(() => ['Harbor Dental walkthrough', 'Design review', 'Quick sync'].map((t) => (document.querySelector(`[data-testid="cal-block"][title^="${t}"]`) as HTMLElement).getBoundingClientRect().left))
      expect(new Set(lefts.map((l) => Math.round(l))).size).toBe(3)
      await w.shot('week-overlap')
      // Next moves on and the address says so; a reload keeps it.
      await w.page.click('[data-testid="cal-next"]')
      await w.page.waitForFunction(() => location.search.includes('date='))
      const after = new URL(w.page.url()).searchParams
      expect(after.get('view')).toBe('week')
      await w.page.reload()
      await w.page.waitForSelector('[data-testid="cal-week"]')
      expect(new URL(w.page.url()).searchParams.get('date')).toBe(after.get('date'))
      await w.page.goto(`${space.base}/calendar?view=week&date=${addDays(TODAY, 1)}`)
      await w.page.locator('[data-testid="cal-block"][title^="Weekly planning"]').click()
      await w.page.waitForSelector('[data-testid="cal-card"]')
      expect(new URL(w.page.url()).search).toBe(`?view=week&date=${addDays(TODAY, 1)}`)
      expect(await w.page.locator('[data-testid="cal-card-title"]').innerText()).toBe('Weekly planning')
      if (size === '390') expect(await w.page.locator('[data-testid="cal-week"]').isVisible()).toBe(false)
      else expect(await w.page.locator('[data-testid="cal-week"]').isVisible()).toBe(true)
      expect(await fits(w.page)).toBe(true)
      await w.shot('week-card')
      await w.page.goBack()
      await w.page.waitForSelector('[data-testid="cal-week"]')
      expect(w.errors).toEqual([])
    })

    test('the month: a grid of weeks with today lit, chips coloured by account and "+N more" on a crowded day (dots on a phone, the chosen day listed beneath); a day opens', async () => {
      const w = await openWindow(size)
      const crowded = addDays(TODAY, 3)
      await w.page.goto(`${space.base}/calendar?view=month`)
      await w.page.waitForSelector('[data-testid="cal-month"]')
      expect(await w.page.locator('[data-testid="cal-month-week"]').count()).toBeGreaterThanOrEqual(4)
      expect(await w.page.locator('[data-testid="cal-month-day"].today').count()).toBe(1)
      expect(await w.page.locator('[data-testid="cal-range"]').innerText()).toMatch(/^[A-Z][a-z]+ \d{4}$/)
      expect(await fits(w.page)).toBe(true)
      await w.shot('month')
      await w.page.goto(`${space.base}/calendar?view=month&date=${crowded}`)
      await w.page.waitForSelector('[data-testid="cal-month"]')
      const cell = w.page.locator(`[data-testid="cal-month-day"][data-day="${crowded}"]`)
      if (size === '1440') {
        expect(await cell.locator('[data-testid="cal-block"]').count()).toBe(2)
        expect(await cell.locator('[data-testid="cal-day-more"]').innerText()).toMatch(/^\+\d+ more$/)
        // The chips stay inside their cell.
        const wide = await w.page.evaluate(() => [...document.querySelectorAll('[data-testid="cal-month-day"]')].filter((c) => c.scrollWidth > c.clientWidth + 1).length)
        expect(wide).toBe(0)
        await w.shot('month-crowded')
        await cell.locator('[data-testid="cal-day-more"]').click()
        await w.page.waitForSelector('[data-testid="cal-week"]')
        expect(new URL(w.page.url()).search).toBe(`?view=week&date=${crowded}`)
        expect(await w.page.locator(`[data-testid="cal-week-day"][data-day="${crowded}"]`).count()).toBe(1)
        await w.page.goBack()
        await w.page.waitForSelector('[data-testid="cal-month"]')
        await w.page.locator(`[data-testid="cal-month-day"][data-day="${crowded}"] [data-testid="cal-block"]`).first().click()
        await w.page.waitForSelector('[data-testid="cal-card"]')
        expect(new URL(w.page.url()).search).toBe(`?view=month&date=${crowded}`)
        await w.shot('month-card')
      } else {
        expect(await cell.locator('.cal-dot').count()).toBeGreaterThan(0)
        const box = await cell.boundingBox()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(40)
        await cell.click()
        await w.page.waitForSelector(`[data-testid="cal-chosen"] [data-testid="cal-day"][data-day="${crowded}"]`)
        expect(await w.page.locator('[data-testid="cal-chosen"] [data-testid="cal-event"]').count()).toBeGreaterThan(3)
        expect(await fits(w.page)).toBe(true)
        await w.shot('month-day')
        await w.page.locator('[data-testid="cal-chosen"] [data-testid="cal-event"]').first().click()
        await w.page.waitForSelector('[data-testid="cal-card"]')
        expect(await w.page.locator('[data-testid="cal-month"]').isVisible()).toBe(false)
        await w.shot('month-card')
      }
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })

    test('Check now says what it asked and the page still fits', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/calendar`)
      await w.page.waitForSelector('[data-testid="cal-check"]')
      await w.page.click('[data-testid="cal-check"]')
      await w.page.waitForSelector('[data-testid="cal-checked"]')
      expect(await w.page.locator('[data-testid="cal-checked"]').innerText()).toContain('Asked Google about 5 calendars')
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })
  })
}
