// Tessa's texts in a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts: Eli Park, who only texts; Dana Reyes, who writes by email and by text;
// Example Bank, a business sender in Bulk with a sign-in code; two chats left out): the Text row and its one pill in the Inbox, the Texts entry in the menu, a text conversation with its heading, Leave this chat out and what
// it asks first, the Settings card with the chats left out and Bring back, and the menu's foot and card gone amber, at a computer's width and a phone's. What no bun test can show: that the page's own CSS gives each
// of them room and nothing runs off the side of a phone.
//
//   bun test e2e/texts.test.ts
//   TEXTS_SHOTS=/tmp/shots bun test e2e/texts.test.ts   also writes each screen at 1440px and 390px
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

const shots = process.env.TEXTS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

async function openWindow(size: keyof typeof SIZES, base = space.base) {
  const ctx = await browser.newContext({ viewport: SIZES[size] })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = async (name: string) => {
    if (!shots) return
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/${name}-${size}.png` })
  }
  return { ctx, page, errors, shot, base }
}

for (const size of ['1440', '390'] as const) {
  describe(`Texts at ${size}px`, () => {
    test('the Inbox lists a person who only texts as a row with one Text pill; the bank’s sender is in Bulk; and the Texts entry narrows the list', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox`)
      await w.page.waitForSelector('[data-testid="row"]')
      const eli = w.page.locator('[data-testid="row"][data-key="mail:c-tx-eli"]')
      expect(await eli.count()).toBe(1)
      expect(await eli.textContent()).toContain('Are we still on for Saturday morning?')
      expect(await eli.locator('[data-testid="texts-pill"]').textContent()).toContain('Text')
      expect(await eli.locator('[data-testid="mailbox-tag"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="row"][data-key="mail:c-tx-bank"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('texts-inbox')

      await w.page.goto(`${w.base}/inbox?view=${encodeURIComponent('mailbox:texts')}`)
      await w.page.waitForSelector('[data-testid="row"]')
      const keys = await w.page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
      expect(keys).toContain('mail:c-tx-eli')
      expect(keys).not.toContain('mail:c-tx-bank')
      await w.shot('texts-filter')

      await w.page.goto(`${w.base}/inbox?view=bulk`)
      await w.page.waitForSelector('[data-testid="row"]')
      const bank = w.page.locator('[data-testid="row"][data-key="mail:c-tx-bank"]')
      expect(await bank.count()).toBe(1)
      expect(await bank.textContent()).toContain('Your Example Bank code is 481516')
      expect(await bank.locator('[data-testid="texts-pill"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('texts-bulk')
      expect(w.errors).toEqual([])
    })

    test('a text conversation: the texts as bubbles under Text messages, answered by hand (no Send), with Leave this chat out that asks first and does nothing until it is pressed twice', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tx-eli')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="entry"]').count()).toBe(3)
      expect(await w.page.locator('[data-testid="heading"]').first().textContent()).toContain('Text messages')
      expect(await w.page.locator('[data-testid="send"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('texts-conversation')
      await w.page.click('[data-testid="leave-out"]')
      await w.page.waitForSelector('[data-testid="leave-out-confirm"]')
      expect(await w.page.locator('[data-testid="leave-out-confirm"]').textContent()).toContain('This removes the chat and its texts from the space and nothing of it is stored again. They stay on your phone.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('texts-leave-out-asks')
      await w.page.click('[data-testid="leave-out-no"]')
      expect(await w.page.locator('[data-testid="leave-out-confirm"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="entry"]').count()).toBe(3)
      expect(w.errors).toEqual([])
    })

    test('a person who writes by email and by text is one conversation with both histories, each under its own heading', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('dana@harbordental.example')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      const headings = await w.page.locator('[data-testid="heading"]').allTextContents()
      expect(headings.some((h) => h.includes('Text messages'))).toBe(true)
      expect(headings.some((h) => h.includes('Email:'))).toBe(true)
      expect(await fits(w.page)).toBe(true)
      await w.shot('texts-with-email')
      expect(w.errors).toEqual([])
    })

    test('Settings has a Texts card saying the bridge is live, with the chats left out and Bring back, and the menu’s foot a line for it', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/settings/mailboxes`)
      await w.page.waitForSelector('[data-testid="texts"]')
      const card = w.page.locator('[data-testid="texts"]')
      expect(await card.getAttribute('data-state')).toBe('live')
      expect(await card.locator('[data-testid="texts-words"]').textContent()).toContain('Texts are live, last text')
      expect(await card.textContent()).toContain('58 texts in 5 conversations')
      const rows = card.locator('[data-testid="texts-left-out-row"]')
      expect(await rows.count()).toBe(2)
      expect(await rows.first().textContent()).toContain('Mum')
      expect(await rows.first().locator('[data-testid="bring-back"]').count()).toBe(1)
      expect(await rows.nth(1).textContent()).toContain('Reading its last 30 days...')
      expect(await fits(w.page)).toBe(true)
      await card.scrollIntoViewIfNeeded()
      await w.shot('texts-settings')
      if (size === '1440') {
        const lines = await w.page.locator('[data-testid="status-line"]').allTextContents()
        expect(lines.some((l) => l.startsWith('Texts are live'))).toBe(true)
        const line = w.page.locator('[data-testid="status-line"]', { hasText: 'Texts are live' })
        expect(await line.getAttribute('data-amber')).toBe('false')
      }
      expect(w.errors).toEqual([])
    })
  })
}

// What is done changes the fixtures, which hold their state for as long as a server runs, so leaving a chat out and bringing one back each have a server of their own.
for (const size of ['1440', '390'] as const) {
  describe(`Texts, leaving a chat out and bringing one back, at ${size}px`, () => {
    test('Leave this chat out takes the conversation off the Inbox and puts it on the list in Settings, which brings it back as a read that is on its way', async () => {
      const other = await startSpace({ fixtures: '1' })
      try {
        const w = await openWindow(size, other.base)
        await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tx-eli')}`)
        await w.page.waitForSelector('[data-testid="leave-out"]')
        await w.page.click('[data-testid="leave-out"]')
        await w.page.click('[data-testid="leave-out-yes"]')
        await w.page.waitForSelector('[data-testid="row"]')
        // The list is read again behind the press: the row leaves it.
        await w.page.waitForFunction(() => document.querySelectorAll('[data-testid="row"][data-key="mail:c-tx-eli"]').length === 0)
        await w.page.goto(`${w.base}/settings/mailboxes`)
        await w.page.waitForSelector('[data-testid="texts-left-out-row"]')
        const rows = w.page.locator('[data-testid="texts-left-out-row"]')
        expect(await rows.count()).toBe(3)
        expect(await rows.first().textContent()).toContain('Eli Park')
        await w.page.locator('[data-testid="texts-left-out-row"]', { hasText: 'Mum' }).locator('[data-testid="bring-back"]').click()
        await w.page.waitForFunction(() => document.querySelectorAll('[data-testid="texts-fill-owed"]').length === 2)
        expect(await w.page.locator('[data-testid="bring-back"]').count()).toBe(1)
        expect(await fits(w.page)).toBe(true)
        await w.page.locator('[data-testid="texts"]').scrollIntoViewIfNeeded()
        await w.shot('texts-brought-back')
        expect(w.errors).toEqual([])
      } finally {
        await other.kill()
      }
    })
  })
}

// The three other states need their own servers: the build bakes the dev switches in, so each is built for its mode, and each server is stopped before the next starts.
for (const [mode, state, words, amber] of [
  ['texts-late', 'not-checked-in', 'The texts bridge has not checked in since', true],
  ['texts-signed-out', 'signed-out', 'Google ended the texts bridge’s sign-in. Only you can sign in again.', true],
  ['texts-phone-off', 'phone-not-answering', 'Your phone is not answering since', false],
] as const) {
  for (const size of ['1440', '390'] as const) {
    describe(`Texts, ${mode}, at ${size}px`, () => {
      test('the card and the foot say the same sentence, and it is amber only where something needs a look', async () => {
        const other = await startSpace({ fixtures: mode })
        try {
          const w = await openWindow(size, other.base)
          await w.page.goto(`${w.base}/settings/mailboxes`)
          await w.page.waitForSelector('[data-testid="texts"]')
          const card = w.page.locator('[data-testid="texts"]')
          expect(await card.getAttribute('data-state')).toBe(state)
          const sentence = (await card.locator('[data-testid="texts-words"]').textContent()) ?? ''
          expect(sentence).toContain(words)
          expect((await card.getAttribute('class'))?.includes('amber')).toBe(amber)
          const foot = size === '1440' ? 'status-line' : 'views-sheet'
          if (size === '1440') {
            const lines = await w.page.locator('[data-testid="status-line"]').allTextContents()
            expect(lines).toContain(sentence)
            const mine = w.page.locator('[data-testid="status-line"]', { hasText: sentence })
            expect(await mine.getAttribute('data-amber')).toBe(String(amber))
          } else {
            // On a phone the foot is in the views sheet.
            await w.page.goto(`${w.base}/inbox`)
            await w.page.waitForSelector('[data-testid="views-button"]')
            await w.page.click('[data-testid="views-button"]')
            await w.page.waitForSelector(`[data-testid="${foot}"]`)
            const lines = await w.page.locator('[data-testid="views-sheet"] [data-testid="status-line"]').allTextContents()
            expect(lines).toContain(sentence)
            await w.page.locator('[data-testid="views-sheet"] [data-testid="status-line"]').last().scrollIntoViewIfNeeded()
            await w.shot(`${mode}-menu`)
            await w.page.goto(`${w.base}/settings/mailboxes`)
            await w.page.waitForSelector('[data-testid="texts"]')
          }
          expect(await fits(w.page)).toBe(true)
          await card.scrollIntoViewIfNeeded()
          await w.shot(`${mode}-settings`)
          expect(w.errors).toEqual([])
        } finally {
          await other.kill()
        }
      })
    })
  }
}
