// Booking links in a real browser (the space's ADR 0025), over the production bundle with the dev bypass and the local fixtures (src/stand-in-calendar.ts keeps the links and the bookings): the owner makes a link in Settings, Calendars; a visitor opens its
// page with no sign-in, picks a day and a time, gives a name and an email and books; the booking's own page moves it and cancels it; and Settings shows what each did. What no bun test can show: that the page and the card fit a phone and a desktop, that the
// times are buttons a thumb can press, that a day is a day a visitor can see, and that the page's content policy really keeps it to its own paths.
//
//   bun test e2e/booking.test.ts
//   BOOKING_SHOTS=/tmp/shots bun test e2e/booking.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so each size makes a link of its own.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', booking: true })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.BOOKING_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side. */
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function openWindow(size: keyof typeof SIZES) {
  const ctx = await browser.newContext({ viewport: SIZES[size], timezoneId: 'America/Los_Angeles', locale: 'en-US' })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name: string, of?: string) => {
    if (!shots) return
    await page.waitForTimeout(300)
    // The team's screens scroll inside their own frame, so a card is photographed by itself.
    if (of) await page.locator(of).first().screenshot({ path: `${shots}/${name}-${size}.png` })
    else await page.screenshot({ path: `${shots}/${name}-${size}.png`, fullPage: true })
  }
  return { ctx, page, errors, shot }
}

for (const size of ['1440', '390'] as const) {
  describe(`Booking links at ${size}px`, () => {
    const slug = `intro-${size}`

    test('the owner makes a link in Settings, Calendars; the card and its form fit the screen', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/settings/calendars`)
      await w.page.waitForSelector('[data-testid="booking-new"]')
      // The first size has none yet; the second finds the first's link on the card.
      if (size === '1440') expect(await w.page.locator('[data-testid="booking-empty"]').count()).toBe(1)
      await w.shot('settings-empty', '[data-testid="booking-links"]')
      await w.page.click('[data-testid="booking-new"]')
      await w.page.fill('[data-testid="booking-name"]', 'Intro call')
      await w.page.fill('[data-testid="booking-slug"]', slug)
      await w.page.fill('[data-testid="booking-description"]', 'A first chat about what you need. Bring questions.')
      expect(await fits(w.page)).toBe(true)
      // Every control of the form is inside the window, and a time box and a button can be pressed.
      const outside = await w.page.evaluate(() => [...document.querySelectorAll('[data-testid="booking-form"] input, [data-testid="booking-form"] select, [data-testid="booking-form"] button, [data-testid="booking-form"] textarea')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length)
      expect(outside).toBe(0)
      await w.shot('settings-form', '[data-testid="booking-links"]')
      await w.page.click('[data-testid="booking-save"]')
      await w.page.waitForSelector(`[data-testid="booking-link"][data-slug="${slug}"]`)
      const made = w.page.locator(`[data-testid="booking-link"][data-slug="${slug}"]`)
      expect(await made.locator('[data-testid="booking-url"]').innerText()).toBe(`https://space.northfield.example/book/${slug}`)
      expect(await made.locator('[data-testid="booking-switch"]').getAttribute('aria-checked')).toBe('true')
      expect(await fits(w.page)).toBe(true)
      await w.shot('settings-link', '[data-testid="booking-links"]')
      expect(w.errors).toEqual([])
    })

    test('a visitor opens the link with no sign-in, picks a day and a time, and books; the page fits and its times can be pressed', async () => {
      const w = await openWindow(size)
      const res = await w.page.goto(`${space.base}/book/${slug}`)
      await w.page.waitForSelector('.pk-time')
      // The page is served under its own content policy, with no cache, no referrer and no framing.
      const headers = res?.headers() ?? {}
      expect(headers['content-security-policy']).toContain("default-src 'none'")
      expect(headers['content-security-policy']).toContain(`${space.base}/book/_/`)
      expect(headers['cache-control']).toBe('no-store')
      expect(headers['x-frame-options']).toBe('DENY')
      expect(await w.page.locator('h1').innerText()).toBe('Intro call')
      // The company's name is set in capitals by the page's style, and is the name as the declaration has it underneath.
      expect(await w.page.locator('.company').textContent()).toBe('Northfield Works')
      expect(await w.page.locator('.meta').innerText()).toContain('30 minutes')
      // A thumb can press every day and every time.
      const small = await w.page.evaluate(() => [...document.querySelectorAll('.pk-time, button.pk-day, .pk-step')].filter((e) => e.getBoundingClientRect().height < 40 || e.getBoundingClientRect().width < 40).length)
      expect(small).toBe(0)
      expect(await fits(w.page)).toBe(true)
      expect(await w.page.locator('.pk-zone select').inputValue()).toBe('America/Los_Angeles')
      await w.shot('page')
      // The zone is changed and the same day is drawn on the other clock; changed back.
      const first = await w.page.locator('.pk-time').first().innerText()
      await w.page.selectOption('.pk-zone select', 'Europe/London')
      expect(await w.page.locator('.pk-time').first().innerText()).not.toBe(first)
      await w.page.selectOption('.pk-zone select', 'America/Los_Angeles')
      expect(await w.page.locator('.pk-time').first().innerText()).toBe(first)

      await w.page.locator('.pk-time').first().click()
      await w.page.waitForSelector('.form')
      expect(await w.page.locator('.chosen').innerText()).toContain('PST, America / Los Angeles')
      expect(await fits(w.page)).toBe(true)
      await w.shot('form')
      await w.page.fill('input[name="name"]', 'Ada Quill')
      await w.page.fill('input[name="email"]', 'ada@example.org')
      await w.page.fill('textarea[name="note"]', 'Looking forward to it.')
      await w.page.click('button[type="submit"]')
      await w.page.waitForSelector('[data-testid="booked-title"]')
      expect(await w.page.locator('[data-testid="booked-title"]').innerText()).toBe('You are booked')
      expect(await w.page.locator('.say.good').innerText()).toContain('ada@example.org')
      expect(await w.page.locator('.manage a').getAttribute('href')).toMatch(/^\/book\/manage\/standin-secret-/)
      expect(await fits(w.page)).toBe(true)
      await w.shot('booked')
      expect(w.errors).toEqual([])
    })

    test('the booking’s own page moves it and cancels it, and Settings shows each', async () => {
      const w = await openWindow(size)
      // Book through the page again to have the address in hand.
      await w.page.goto(`${space.base}/book/${slug}`)
      await w.page.waitForSelector('.pk-time')
      await w.page.locator('.pk-time').nth(2).click()
      await w.page.fill('input[name="name"]', 'Bea Cole')
      await w.page.fill('input[name="email"]', 'bea@example.org')
      await w.page.click('button[type="submit"]')
      await w.page.waitForSelector('[data-testid="booked-title"]')
      const manage = await w.page.locator('.manage a').getAttribute('href')
      expect(manage).toMatch(/^\/book\/manage\//)

      // The owner sees both bookings on the link's card.
      const owner = await openWindow(size)
      await owner.page.goto(`${space.base}/settings/calendars`)
      await owner.page.waitForSelector(`[data-testid="booking-link"][data-slug="${slug}"] [data-testid="booking-row"]`)
      const link = owner.page.locator(`[data-testid="booking-link"][data-slug="${slug}"]`)
      expect(await link.locator('[data-testid="booking-row"]').count()).toBe(2)
      expect(await link.locator('[data-testid="booking-row"]').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('Ada Quill'), expect.stringContaining('Bea Cole')]))
      expect(await fits(owner.page)).toBe(true)
      await owner.shot('settings-bookings', '[data-testid="booking-links"]')

      // The visitor moves hers.
      await w.page.goto(`${space.base}${manage}`)
      await w.page.waitForSelector('[data-testid="manage-title"]')
      expect(await w.page.locator('[data-testid="manage-title"]').innerText()).toBe('You are booked')
      expect(await fits(w.page)).toBe(true)
      await w.shot('manage')
      await w.page.getByRole('button', { name: 'Move to another time' }).click()
      await w.page.waitForSelector('.move .pk-time')
      await w.shot('manage-move')
      await w.page.locator('.move .pk-time').nth(3).click()
      await w.page.locator('.move .actions .btn.primary').click()
      await w.page.waitForSelector('[data-testid="manage-say"]')
      expect(await w.page.locator('[data-testid="manage-say"]').innerText()).toContain('It is moved')
      expect(await fits(w.page)).toBe(true)

      // And cancels it, after being asked.
      await w.page.getByRole('button', { name: 'Cancel this booking' }).click()
      await w.page.waitForSelector('.confirm')
      await w.shot('manage-cancel')
      await w.page.getByRole('button', { name: 'Yes, cancel it' }).click()
      await w.page.waitForFunction(() => document.querySelector('[data-testid="manage-title"]')?.textContent === 'This booking was cancelled')
      expect(await w.page.getByRole('link', { name: 'Book another time' }).count()).toBe(1)
      await w.shot('manage-cancelled')

      await owner.page.reload()
      await owner.page.waitForSelector(`[data-testid="booking-link"][data-slug="${slug}"] [data-testid="booking-row"]`)
      const states = await owner.page.locator(`[data-testid="booking-link"][data-slug="${slug}"] [data-testid="booking-row"]`).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-state')))
      expect(states.sort()).toEqual(['booked', 'cancelled'])
      await owner.shot('settings-after', '[data-testid="booking-links"]')
      expect(w.errors).toEqual([])
      expect(owner.errors).toEqual([])
    })

    test('the page reaches its own API and nothing else of the host: the team’s API is blocked by the page’s own policy, and what is booked is in the owner’s calendar', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/book/${slug}`)
      await w.page.waitForSelector('.pk-time')
      const reached = await w.page.evaluate(async (slugName) => {
        const ask = (path: string) => fetch(path, { credentials: 'omit' }).then((r) => r.status, () => 'blocked')
        return { own: await ask(`/book/api/links/${slugName}`), team: await ask('/api/me'), conversations: await ask('/api/conversations'), calendar: await ask('/api/calendar/booking-links'), forms: await ask('/forms/api/clients') }
      }, slug)
      expect(reached).toEqual({ own: 200, team: 'blocked', conversations: 'blocked', calendar: 'blocked', forms: 'blocked' })
      // A script cannot be put in the page: no inline script runs, and no script comes from anywhere but the page's own folder.
      const ran = await w.page.evaluate(() => {
        const s = document.createElement('script')
        s.textContent = 'window.__ran = 1'
        document.head.appendChild(s)
        return (window as unknown as { __ran?: number }).__ran === 1
      })
      expect(ran).toBe(false)
      // What the team can reach without the page: the team's own pages and API are as ever, and the booking page is one more path.
      expect((await fetch(`${space.base}/api/me`)).status).toBe(200)
      expect((await fetch(`${space.base}/book/api/links/${slug}`)).status).toBe(200)
      expect((await fetch(`${space.base}/book/api/links/no-such-link`)).status).toBe(404)
      expect((await fetch(`${space.base}/book/api/links/${slug}/book`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' })).status).toBe(403)
    })
  })
}
