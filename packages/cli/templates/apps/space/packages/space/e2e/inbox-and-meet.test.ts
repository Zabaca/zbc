// The Inbox and Meet tabs in a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts): Inbox is email alone,
// Meet is channels, direct messages, calls and the Phone, and every old /conversations address lands on the same thing under the new path. At a computer's width and a phone's.
// What no bun test can show: that the page's own CSS gives each of them room, that nothing runs off the side of a phone, and that the old addresses survive a real browser's redirect.
//
//   bun test e2e/inbox-and-meet.test.ts
//   INBOX_MEET_SHOTS=/tmp/shots bun test e2e/inbox-and-meet.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs; nothing here changes it.
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

const shots = process.env.INBOX_MEET_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(
    () =>
      (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth &&
      document.documentElement.scrollWidth <= window.innerWidth,
  )

async function openWindow(size: keyof typeof SIZES) {
  const ctx = await browser.newContext({ viewport: SIZES[size] })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name: string) => {
    if (!shots) return
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/${name}-${size}.png` })
  }
  const keys = () => page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  const railLabels = () => page.locator('nav.rail > a.rail-item').evaluateAll((els) => els.map((e) => [e.querySelector('.rail-label')?.textContent, e.classList.contains('on')]))
  return { ctx, page, errors, shot, keys, railLabels }
}

for (const size of ['1440', '390'] as const) {
  describe(`Inbox and Meet at ${size}px`, () => {
    test('the Inbox lists email conversations only: no channel, no direct message, no Phone, no call, and its own tools', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(await w.page.locator('h1').textContent()).toBe('Inbox')
      const keys = (await w.keys()) as string[]
      expect(keys.length).toBeGreaterThan(2)
      for (const key of keys) expect([key, key.startsWith('chat:') || key === 'phone' || key.startsWith('call:')]).toEqual([key, false])
      for (const href of await w.page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href?.startsWith('/inbox/')).toBe(true)
      expect(await w.page.locator('[data-testid="new-email-button"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="search"]').count()).toBe(1)
      for (const absent of ['new-call', 'channel-tools', 'live']) expect([absent, await w.page.locator(`[data-testid="${absent}"]`).count()]).toEqual([absent, 0])
      expect(await w.page.locator('body').textContent()).not.toContain('Chat messages cannot be searched')
      expect((await w.railLabels()).map((r) => r[0])).toEqual(['Today', 'Inbox', 'Meet', 'Calendar', 'Forms', 'People', 'Knowledge', 'Settings'])
      expect((await w.railLabels()).filter((r) => r[1]).map((r) => r[0])).toEqual(['Inbox'])
      expect(await w.page.title()).toContain('Inbox | ')
      expect(await fits(w.page)).toBe(true)
      await w.shot('inbox-list')
      expect(w.errors).toEqual([])
    })

    test('an email conversation opens in the Inbox, with its emails and the reply by email', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/${encodeURIComponent('dana@harbordental.example')}`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await w.page.locator('[data-testid="composer"]').getAttribute('data-way')).toBe('email')
      expect(await w.page.locator('[data-testid="way-chat"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="entry"][data-kind="chat"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="send-for-signature"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="back"]').getAttribute('href')).toBe('/inbox')
      expect(await fits(w.page)).toBe(true)
      await w.shot('inbox-conversation')
      expect(w.errors).toEqual([])
    })

    test('Meet lists channels and direct messages, with New call and the channel tools, and no email', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/meet`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(await w.page.locator('h1').textContent()).toBe('Meet')
      const keys = (await w.keys()) as string[]
      expect(keys).toContain('chat:channel:21')
      expect(keys.some((k) => k.includes('@'))).toBe(true)
      for (const row of await w.page.locator('[data-testid="row"]').all()) {
        expect(await row.getAttribute('data-key')).not.toBeNull()
        expect(await row.locator('[data-came="email"]').count()).toBe(0)
      }
      for (const href of await w.page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href?.startsWith('/meet/')).toBe(true)
      expect(await w.page.locator('[data-testid="new-call"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="search"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="new-email-button"]').count()).toBe(0)
      expect((await w.railLabels()).filter((r) => r[1]).map((r) => r[0])).toEqual(['Meet'])
      expect(await w.page.title()).toContain('Meet | ')
      expect(await fits(w.page)).toBe(true)
      await w.shot('meet-list')
      expect(w.errors).toEqual([])
    })

    test('Meet’s menu: All, Chat, Channels and Calls cut its list; Calls is the past calls', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/meet?view=channels`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(((await w.keys()) as string[]).every((k) => k.startsWith('chat:channel:'))).toBe(true)
      await w.page.goto(`${space.base}/meet?view=chat`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(((await w.keys()) as string[]).some((k) => k.startsWith('chat:channel:'))).toBe(false)
      if (size === '1440') {
        const items = await w.page.locator('.rail [data-testid="meet-tree"] [data-testid="tree-item"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-key'), e.getAttribute('aria-current')]))
        // The fixtures give this person a Phone row, so the Phone is in the menu too.
        expect(items.map((i) => i[0])).toEqual(['all', 'chat', 'channels', 'calls', 'phone'])
        expect(items.filter((i) => i[1] === 'page').map((i) => i[0])).toEqual(['chat'])
      } else {
        // On a phone the menu is the button above the list, which says which view is open and opens the sheet.
        expect(await w.page.locator('[data-testid="views-button"]').textContent()).toContain('Chat')
        await w.page.locator('[data-testid="views-button"]').click()
        await w.page.waitForSelector('[data-testid="views-sheet"]')
        await w.shot('meet-menu')
        await w.page.locator('[data-testid="views-sheet"] [data-key="calls"]').click()
        await w.page.waitForURL(/\/meet\?view=calls$/)
      }
      await w.page.goto(`${space.base}/meet?view=calls`)
      await w.page.waitForSelector('[data-testid="calls-list"]')
      expect(await w.page.locator('[data-testid="row"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('meet-calls')
      expect(w.errors).toEqual([])
    })

    test('a channel and a direct message open in Meet, with the chat reply, and no Send for signature', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/meet/${encodeURIComponent('chat:channel:21')}`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await w.page.locator('[data-testid="composer"]').getAttribute('data-way')).toBe('chat')
      expect(await w.page.locator('[data-testid="send-for-signature"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="back"]').getAttribute('href')).toBe('/meet')
      expect(await fits(w.page)).toBe(true)
      await w.shot('meet-channel')
      await w.page.goto(`${space.base}/meet/${encodeURIComponent('priya@northfield.example')}`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await w.page.locator('[data-testid="entry"][data-kind="email"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="way-email"]').count()).toBe(0)
      await w.shot('meet-direct-message')
      expect(w.errors).toEqual([])
    })

    test('the Phone is Meet’s, at /meet/phone, and lit in its menu', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/meet/phone`)
      await w.page.waitForSelector('[data-testid="phone-detail"]')
      expect(await w.page.locator('[data-testid="back"]').getAttribute('href')).toBe('/meet')
      expect(await w.page.locator('[data-testid="back"]').textContent()).toContain('Meet')
      if (size === '1440') expect(await w.page.locator('.rail [data-testid="meet-tree"] [aria-current="page"]').getAttribute('data-key')).toBe('phone')
      expect((await w.railLabels()).filter((r) => r[1]).map((r) => r[0])).toEqual(['Meet'])
      expect(await fits(w.page)).toBe(true)
      await w.shot('meet-phone')
      expect(w.errors).toEqual([])
    })

    test('a person with only the other tab’s side is not found, and the pane points at the other tab', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/${encodeURIComponent('chat:channel:21')}`)
      await w.page.waitForSelector('[data-testid="convo-failed"]')
      expect(await w.page.locator('[data-testid="look-elsewhere"]').getAttribute('href')).toBe('/meet/chat%3Achannel%3A21')
      await w.page.goto(`${space.base}/meet/${encodeURIComponent('tomas.alvarez@mail.example')}`)
      await w.page.waitForSelector('[data-testid="convo-failed"]')
      expect(await w.page.locator('[data-testid="look-elsewhere"]').getAttribute('href')).toBe('/inbox/tomas.alvarez%40mail.example')
      expect(w.errors).toEqual([])
    })

    test('every old /conversations address lands on the same thing under the new path, in a real browser', async () => {
      const w = await openWindow(size)
      const lands = async (from: string) => {
        await w.page.goto(`${space.base}${from}`)
        await w.page.waitForSelector('main.main')
        const at = new URL(w.page.url())
        return at.pathname + at.search
      }
      expect(await lands('/conversations')).toBe('/inbox')
      expect(await lands('/conversations?view=bulk')).toBe('/inbox?view=bulk')
      expect(await lands('/conversations?view=calls')).toBe('/meet?view=calls')
      expect(await lands('/conversations/dana%40harbordental.example')).toBe('/inbox/dana%40harbordental.example')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await lands('/conversations/chat%3Achannel%3A21')).toBe('/meet/chat%3Achannel%3A21')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await lands('/conversations/draft/d-first-email')).toBe('/inbox/draft/d-first-email')
      await w.page.waitForSelector('[data-testid="draft-pane"], [data-testid="convo-failed"], [data-testid="draft"]')
      expect(w.errors).toEqual([])
    })

    test('Today’s rows open in the right tab: mail and email drafts in the Inbox, chat in Meet', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/today`)
      await w.page.waitForSelector('[data-testid="waiting-mail"]')
      for (const href of await w.page.locator('[data-testid="waiting-mail"], [data-testid="draft-email"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href?.startsWith('/inbox/')).toBe(true)
      for (const href of await w.page.locator('[data-testid="waiting-chat"], [data-testid="waiting-phone"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(href?.startsWith('/meet/')).toBe(true)
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })
  })
}
