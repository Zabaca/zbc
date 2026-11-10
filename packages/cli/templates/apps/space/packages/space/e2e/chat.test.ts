// Chat in a real browser, over the production bundle and the fixtures (the invented people of src/stand-ins.ts, no meet): links in a message and "Join call", the
// "New" line, the unread count in the tab's title, Edit and Delete, New message, and Settings, Chat. Both widths, nothing off the side of a phone. The rules themselves (you edit only your own,
// the owner deletes another's, what a person outside a conversation is never told) are proved in packages/meet/test/space-messages.test.ts over the real Workspace core; this is what a person sees.
//
//   bun test e2e/chat.test.ts
//   CHAT_SHOTS=/tmp/shots bun test e2e/chat.test.ts   also writes the screens at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
setDefaultTimeout(90_000)

const shots = process.env.CHAT_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

const fits = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main.main') as HTMLElement
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
  })

for (const size of ['1440', '390'] as const) {
  describe(`chat at ${size}px`, () => {
    // The fixtures keep what a press changes for as long as the server runs, so each width has a server of its own (built once, for the first).
    beforeAll(async () => {
      space = await startSpace({ build: size === '1440' })
      browser = await launchBrowser()
    }, 300_000)
    afterEach(() => browser?.closeContexts(), 60_000)
    afterAll(async () => {
      await browser?.stop()
      await space?.kill()
    }, 90_000)

    async function open(path: string) {
      const ctx = await browser.newContext({ viewport: SIZES[size] })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${space.base}${path}`)
      return { page, errors }
    }
    const shot = async (page: Page, name: string) => {
      if (!shots) return
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${shots}/${name}-${size}.png` })
    }
    const conversation = (key: string) => `/meet/${encodeURIComponent(key)}`

    test('links, a call link reading "Join call", and the "New" line where unread begins; the tab’s title counts what is unread', async () => {
      const { page, errors } = await open(conversation('chat:channel:21'))
      await page.waitForSelector('[data-testid="conversation"] [data-testid="new-line"]')
      // The line is before the first message that was unread (Priya's, 328), and nowhere else.
      expect(await page.locator('[data-testid="new-line"]').count()).toBe(1)
      const order = await page.$$eval('[data-testid="new-line"], [data-testid="entry"][data-kind="chat"]', (els) => els.map((e) => (e.getAttribute('data-testid') === 'new-line' ? 'NEW' : (e.getAttribute('data-id') as string))))
      expect(order).toEqual(['325', '326', '327', 'NEW', '328', '329', '330'])
      const call = page.locator('[data-testid="join-call"]')
      expect(await call.textContent()).toBe('Join call')
      expect(await call.getAttribute('href')).toBe('https://space.northfield.example/r/jh4n8qw2xkzr7tbp5mcd')
      expect(await call.getAttribute('target')).toBe('_blank')
      expect(await call.getAttribute('rel')).toBe('noopener noreferrer nofollow')
      const link = page.locator('[data-testid="chat-link"]')
      expect(await link.getAttribute('href')).toBe('https://docs.northfield.example/launch-checklist')
      // Unread: 2 in Dana's direct message and 3 here, until this one was read.
      await page.waitForFunction(() => /^\(\d+\) /.test(document.title))
      await shot(page, 'links-and-new')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('Edit changes your own words and says edited; Delete asks first and takes a message away, the owner’s of another’s too', async () => {
      const { page, errors } = await open(conversation('priya@northfield.example'))
      await page.waitForSelector('[data-testid="conversation"] [data-testid="entry"][data-kind="chat"]')
      const mine = page.locator('[data-testid="entry"][data-id="301"]')
      await mine.hover()
      await shot(page, 'actions')
      await mine.locator('[data-testid="msg-edit"]').click()
      await page.fill('[data-testid="msg-edit-input"]', 'I left the checklist on the board, and a note on Thursday.')
      await shot(page, 'editing')
      await page.click('[data-testid="msg-edit-save"]')
      await page.waitForSelector('[data-testid="edited"]')
      expect(await mine.textContent()).toContain('I left the checklist on the board, and a note on Thursday.')
      // Another person's message: the owner may delete it, and nobody edits it.
      const theirs = page.locator('[data-testid="entry"][data-id="299"]')
      expect(await theirs.locator('[data-testid="msg-edit"]').count()).toBe(0)
      await theirs.hover()
      await theirs.locator('[data-testid="msg-delete"]').click()
      await page.waitForSelector('[data-testid="ask"]')
      expect(await page.locator('[data-testid="ask"]').textContent()).toContain('Delete this message for everyone?')
      await shot(page, 'delete-ask')
      await page.click('[data-testid="ask-no"]')
      expect(await theirs.count()).toBe(1)
      await theirs.hover()
      await theirs.locator('[data-testid="msg-delete"]').click()
      await page.click('[data-testid="ask-yes"]')
      await page.waitForSelector('[data-testid="entry"][data-id="299"]', { state: 'detached' })
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('New message: anyone you can see, a conversation with something in it is opened, and a first message makes one direct message', async () => {
      const { page, errors } = await open('/meet')
      await page.waitForSelector('[data-testid="channel-tools"]')
      await page.click('[data-testid="new-message-button"]')
      await page.waitForSelector('[data-testid="dm-person"]')
      const people = await page.locator('[data-testid="dm-person"]').allTextContents()
      expect(people.some((t) => t.includes('Ben Walker'))).toBe(true)
      await shot(page, 'new-message')
      await page.fill('[data-testid="dm-search"]', 'ben')
      expect(await page.locator('[data-testid="dm-person"]').count()).toBe(1)
      await page.click('[data-testid="dm-person"]')
      await page.waitForSelector('[data-testid="dm-text"]')
      await page.fill('[data-testid="dm-text"]', 'Welcome aboard, Ben. The booking form is in staging.')
      await shot(page, 'new-message-writing')
      await page.click('[data-testid="dm-send"]')
      await page.waitForSelector('[data-testid="conversation"] [data-testid="entry"][data-kind="chat"]')
      expect(decodeURIComponent(new URL(page.url()).pathname)).toBe('/meet/ben@northfield.example')
      expect(await page.locator('[data-testid="convo-title"]').textContent()).toContain('Ben')
      expect(await page.locator('[data-testid="entry"][data-kind="chat"]').allTextContents()).toEqual([expect.stringContaining('Welcome aboard, Ben. The booking form is in staging.')])
      await shot(page, 'new-message-sent')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('Settings, Chat: the name, the 15-minute email and the privacy note with its acknowledgement', async () => {
      const { page, errors } = await open('/settings/chat')
      await page.waitForSelector('[data-testid="chat-settings"]')
      expect(await page.inputValue('[data-testid="chat-name"]')).toBe('Tessa')
      await shot(page, 'settings-chat')
      await page.fill('[data-testid="chat-name"]', 'Tessa Y')
      await page.click('[data-testid="chat-name-save"]')
      await page.waitForSelector('[data-testid="done"]')
      expect(await page.locator('[data-testid="done"]').textContent()).toContain('Saved your name.')
      expect(await page.locator('[data-testid="chat-nudges"]').getAttribute('aria-checked')).toBe('true')
      await page.click('[data-testid="chat-nudges"]')
      await page.waitForFunction(() => document.querySelector('[data-testid="chat-nudges"]')?.getAttribute('aria-checked') === 'false')
      await page.locator('[data-testid="privacy-note"]').scrollIntoViewIfNeeded()
      await shot(page, 'settings-privacy')
      await page.click('[data-testid="privacy-ok"]')
      await page.waitForSelector('[data-testid="privacy-acked"]')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })
  })
}
