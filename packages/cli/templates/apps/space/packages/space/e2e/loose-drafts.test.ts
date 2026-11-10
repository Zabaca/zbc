// Drafts that sit on no conversation (a first email to a new address, a first LinkedIn message to a new contact) in a real browser, over the production bundle with the dev bypass and the local fixtures:
// the Drafts view lists them, each opens at /inbox/draft/<id> with the card a draft has in a conversation, Edit changes the words, Send as it stands sends once and says so, a LinkedIn message
// is copied and marked sent, and a link made while a message was a draft opens its conversation once it is one. At a computer's width and a phone's. What no bun test can show: that the page's own CSS
// gives the rows and the card room and that nothing runs off the side of a phone.
//
//   bun test e2e/loose-drafts.test.ts
//   LOOSE_SHOTS=/tmp/shots bun test e2e/loose-drafts.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in. Nothing here is sent anywhere: the inbox is a stand-in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

// One server per width, because the fixtures keep what a test changed: the second width would otherwise find the first email already sent.
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

const shots = process.env.LOOSE_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

async function openWindow(size: keyof typeof SIZES) {
  const ctx = await browser.newContext({ viewport: SIZES[size], permissions: ['clipboard-read', 'clipboard-write'] })
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
  describe(`Drafts on no conversation at ${size}px`, () => {
    beforeAll(() => {
      space = servers[size]
    })

    test('the Drafts view lists them above the people with a draft, each a row that opens its own page', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox?view=drafts`)
      await w.page.waitForSelector('[data-testid="loose-draft"]')
      expect(await w.page.locator('[data-testid="loose-draft"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.draft))).toEqual(['d-first-email', 'd-linkedin-1'])
      expect(await w.page.locator('[data-testid="loose-draft"]').first().getAttribute('href')).toBe('/inbox/draft/d-first-email')
      expect(await w.page.locator('[data-testid="loose-drafts"]').textContent()).toContain('Not on a conversation yet')
      expect(await w.page.locator('[data-testid="loose-draft"]').first().textContent()).toContain('To Nadia Hussain')
      expect(await fits(w.page)).toBe(true)
      await w.shot('drafts-view')
      expect(w.errors).toEqual([])
    })

    test('the address opens the card with Edit and Send as it stands, and the Drafts view beside it when the address names no view', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-first-email`)
      await w.page.waitForSelector('[data-testid="draft-pane"]')
      expect(await w.page.locator('[data-testid="draft-title"]').textContent()).toBe('Draft to Nadia Hussain')
      expect(await w.page.locator('[data-testid="draft-to"]').textContent()).toBe('To Nadia Hussain <nadia@hussaincatering.example>')
      expect(await w.page.locator('[data-testid="send-draft"]').textContent()).toBe('Send as it stands')
      expect(await w.page.locator('[data-testid="edit-draft"]').textContent()).toBe('Edit')
      expect(await w.page.locator('[data-testid="mark-sent"]').count()).toBe(0)
      if (size === '1440') {
        // Beside the card the list is the Drafts view, with this draft marked.
        expect(await w.page.locator('[data-testid="loose-draft"][data-draft="d-first-email"]').getAttribute('aria-current')).toBe('true')
      }
      expect(await fits(w.page)).toBe(true)
      await w.shot('card')
      expect(w.errors).toEqual([])
    })

    test('Edit changes the words at the revision shown and the card shows them', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-first-email`)
      await w.page.waitForSelector('[data-testid="edit-draft"]')
      await w.page.click('[data-testid="edit-draft"]')
      await w.page.waitForSelector('[data-testid="draft-editor"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('editing')
      await w.page.fill('[data-testid="edit-text"]', 'Hello Nadia,\n\nA short call this week about a website for the catering business?')
      await w.page.click('[data-testid="save-draft"]')
      await w.page.waitForSelector('[data-testid="draft-saved"]')
      expect(await w.page.locator('[data-testid="draft"]').textContent()).toContain('A short call this week about a website')
      expect(await fits(w.page)).toBe(true)
      await w.shot('saved')
      expect(w.errors).toEqual([])
    })

    test('a LinkedIn message has Copy address, Copy words and Mark sent and no Send; Copy puts them on the clipboard', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-linkedin-1`)
      await w.page.waitForSelector('[data-testid="mark-sent"]')
      expect(await w.page.locator('[data-testid="send-draft"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="draft"]').textContent()).toContain('The inbox cannot send a direct message. Send it yourself, then press Mark sent.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('linkedin-card')
      await w.page.click('[data-testid="copy-address"]')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="copy-address"]')?.textContent === 'Copied address')
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toBe('@graceokafor')
      await w.page.click('[data-testid="copy-words"]')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="copy-words"]')?.textContent === 'Copied words')
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toContain('thank you for the introduction to the printer')
      expect(w.errors).toEqual([])
    })

    test('Mark sent files it and the page moves to the person’s conversation, which holds it with Not sent after all', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-linkedin-1`)
      await w.page.waitForSelector('[data-testid="mark-sent"]')
      await w.page.click('[data-testid="mark-sent"]')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(new URL(w.page.url()).pathname).toBe('/inbox/mail%3Ac-old')
      expect(await w.page.locator('[data-testid="conversation"]').textContent()).toContain('thank you for the introduction to the printer')
      expect(await w.page.locator('[data-testid="not-sent-after-all"]').count()).toBeGreaterThan(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('marked-sent')
      // The link made while it was a draft keeps working: it opens the same conversation.
      await w.page.goto(`${space.base}/inbox/draft/d-linkedin-1`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(new URL(w.page.url()).pathname).toBe('/inbox/mail%3Ac-old')
      expect(w.errors).toEqual([])
    })

    test('a draft that is on a conversation opens that conversation', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-lena-1`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(new URL(w.page.url()).pathname).toBe('/inbox/mail%3Ac-lena')
      expect(await w.page.locator('[data-draft="d-lena-1"]').count()).toBe(1)
      // The view in the address goes with it.
      await w.page.goto(`${space.base}/inbox/draft/d-lena-1?view=drafts`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      const at = new URL(w.page.url())
      expect([at.pathname, at.search]).toEqual(['/inbox/mail%3Ac-lena', '?view=drafts'])
      expect(w.errors).toEqual([])
    })

    test('Send as it stands sends once and says it went, with the way to the conversation it made; the link then opens that conversation', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-first-email`)
      await w.page.waitForSelector('[data-testid="send-draft"]')
      await w.page.click('[data-testid="send-draft"]')
      await w.page.waitForSelector('[data-testid="draft-sent-notice"]')
      expect(await w.page.locator('[data-testid="draft-sent-notice"]').textContent()).toBe('Sent.')
      expect(await w.page.locator('[data-testid="send-draft"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="open-conversation"]').getAttribute('href')).toBe('/inbox/mail%3Ac-new')
      expect(await fits(w.page)).toBe(true)
      await w.shot('sent')
      await w.page.goto(`${space.base}/inbox/draft/d-first-email`)
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(new URL(w.page.url()).pathname).toBe('/inbox/mail%3Ac-new')
      expect(await w.page.locator('[data-testid="conversation"]').textContent()).toContain('A short call this week about a website')
      expect(w.errors).toEqual([])
    })

    test('a draft that is gone says so in words and goes back to Drafts', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/draft/d-nothing`)
      await w.page.waitForSelector('[data-testid="draft-failed"]')
      expect(await w.page.locator('[data-testid="draft-failed"]').textContent()).toContain('That draft is gone')
      expect(await fits(w.page)).toBe(true)
      await w.shot('gone')
      expect(w.errors).toEqual([])
    })
  })
}
