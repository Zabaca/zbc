// A mailbox on Northfield's own mail server (test@harborline.example, read and written over JMAP) in a real browser, over the production bundle with the dev bypass and the local
// fixtures (the invented people of src/stand-ins.ts: Kim Alder, who asks a question and is unread, and Jo Marsh, whose receipt was archived in a mail app and so came in Closed): the row and its pill in the Inbox, the entry in the menu,
// the Settings card and the menu's foot when the server is well, when the server refused the space's key, and when it is not answering, at a computer's width and a phone's. What no bun test can show: that the page's own CSS gives each of them
// room and nothing runs off the side of a phone.
//
//   bun test e2e/jmap.test.ts
//   JMAP_SHOTS=/tmp/shots bun test e2e/jmap.test.ts   also writes each screen at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let browser: E2eBrowser
beforeAll(async () => {
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
}, 90_000)

/** The space served with one mode of fixtures for the tests inside it. The dev switches are read when the bundle is built, so each mode is built and served alone. */
function serving(fixtures: string): { base: () => string } {
  let space: Space | undefined
  beforeAll(async () => {
    space = await startSpace({ fixtures })
  }, 300_000)
  afterAll(async () => {
    await space?.kill()
  }, 90_000)
  return { base: () => (space as Space).base }
}

const shots = process.env.JMAP_SHOTS
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
  return { ctx, page, errors, shot }
}

for (const size of ['1440', '390'] as const) {
  describe(`A mailbox on the mail server at ${size}px`, () => {
    const live = serving('1')
    test('the Inbox lists a person who wrote to it as a row carrying its name; the menu’s entry narrows the list to it; the receipt archived in a mail app is in Closed', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${live.base()}/inbox`)
      await w.page.waitForSelector('[data-testid="row"]')
      const kim = w.page.locator('[data-testid="row"][data-key="kim@alder.example"]')
      expect(await kim.count()).toBe(1)
      expect(await kim.textContent()).toContain('Do you take walk-ins on Saturdays?')
      expect(await kim.textContent()).toContain('harborline')
      expect(await w.page.locator('[data-testid="row"][data-key="jo@marsh.example"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('jmap-inbox')

      await w.page.goto(`${live.base()}/inbox?view=${encodeURIComponent('mailbox:harborline')}`)
      await w.page.waitForSelector('[data-testid="row"]')
      const keys = await w.page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
      expect(keys).toEqual(['kim@alder.example'])
      await w.shot('jmap-filter')

      await w.page.goto(`${live.base()}/inbox?view=closed`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(await w.page.locator('[data-testid="row"][data-key="jo@marsh.example"]').count()).toBe(1)
      expect(w.errors).toEqual([])
    })

    test('a conversation on it shows the customer’s question, and the reply we sent from the mailbox is in the closed one', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${live.base()}/inbox/${encodeURIComponent('jo@marsh.example')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="entry"]').count()).toBe(2)
      expect(await w.page.locator('[data-testid="entry"]').last().textContent()).toContain('Thank you, that is filed.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('jmap-conversation')
      expect(w.errors).toEqual([])
    })

    test('Settings has a card for it saying the server is live, with what is held and Sync now, and the menu’s foot a line for it that is not amber', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${live.base()}/settings/mailboxes`)
      await w.page.waitForSelector('[data-testid="jmap"]')
      const card = w.page.locator('[data-testid="jmap"]')
      expect(await card.getAttribute('data-state')).toBe('live')
      expect(await card.textContent()).toContain('test@harborline.example')
      expect(await card.textContent()).toContain('14 messages in 9 conversations')
      expect(await card.locator('[data-testid="sync-jmap"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await card.scrollIntoViewIfNeeded()
      await w.shot('jmap-settings-live')
      if (size === '1440') {
        const line = w.page.locator('[data-testid="status-line"]', { hasText: 'harborline live' })
        expect(await line.count()).toBe(1)
        expect(await line.getAttribute('data-amber')).toBe('false')
      }
      expect(w.errors).toEqual([])
    })

  })
}

for (const size of ['1440', '390'] as const) {
  describe(`A mailbox on the mail server whose key the server refused at ${size}px`, () => {
    const refused = serving('jmap-refused')
    test('when the server refused the space’s key the card and the foot are amber and say so, and there is no Sync now to press', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${refused.base()}/settings/mailboxes`)
      await w.page.waitForSelector('[data-testid="jmap"]')
      const card = w.page.locator('[data-testid="jmap"]')
      expect(await card.getAttribute('data-state')).toBe('refused')
      expect(await card.textContent()).toContain('refused the space’s key')
      expect(await card.locator('[data-testid="sync-jmap"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await card.scrollIntoViewIfNeeded()
      await w.shot('jmap-settings-refused')
      if (size === '1440') {
        const line = w.page.locator('[data-testid="status-line"]', { hasText: 'harborline: the mail server refused the space' })
        expect(await line.count()).toBe(1)
        expect(await line.getAttribute('data-amber')).toBe('true')
      }
      expect(w.errors).toEqual([])
    })

  })
}

for (const size of ['1440', '390'] as const) {
  describe(`A mailbox on the mail server that is not answering at ${size}px`, () => {
    const down = serving('jmap-down')
    test('when the server is not answering the card and the foot are amber, say since when, and Sync now is still there to try again', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${down.base()}/settings/mailboxes`)
      await w.page.waitForSelector('[data-testid="jmap"]')
      const card = w.page.locator('[data-testid="jmap"]')
      expect(await card.getAttribute('data-state')).toBe('unreachable')
      expect(await card.locator('[data-testid="jmap-since"]').textContent()).toContain('45 min ago')
      expect(await card.locator('[data-testid="sync-jmap"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await card.scrollIntoViewIfNeeded()
      await w.shot('jmap-settings-down')
      if (size === '1440') {
        const line = w.page.locator('[data-testid="status-line"]', { hasText: 'harborline: mail server not answering' })
        expect(await line.count()).toBe(1)
        expect(await line.getAttribute('data-amber')).toBe('true')
      }
      expect(w.errors).toEqual([])
    })
  })
}
