// Writing from the space in a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts): a new email from a
// business mailbox with a file, a draft edited in its card, and an email thread marked as spam and moved back, at a computer's width and a phone's. What no bun test can show: that the
// page's own CSS gives each of them room, that nothing runs off the side of a phone, and that the box takes the screen there and goes back.
//
//   bun test e2e/compose.test.ts
//   COMPOSE_SHOTS=/tmp/shots bun test e2e/compose.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the server runs, so the tests are in the order they change it in. Nothing here is sent anywhere: the inbox is a stand-in.
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

const shots = process.env.COMPOSE_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

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
  describe(`Writing from the space at ${size}px`, () => {
    test('New email opens a box with To, From, Subject and the words, offers each mailbox, and goes back to the list', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox`)
      await w.page.waitForSelector('[data-testid="new-email-button"]')
      await w.page.click('[data-testid="new-email-button"]')
      await w.page.waitForSelector('[data-testid="new-email"]')
      await w.page.waitForFunction(() => document.querySelectorAll('[data-testid="new-from"] option').length === 5)
      expect(await w.page.locator('[data-testid="new-from"] option').allTextContents()).toEqual([
        'Automatic: where they last wrote to, else your own Gmail',
        'northfield Gmail (tessa@northfield.example)',
        'Ridgeway Cycles (info@ridgewaycycles.example)',
        'ShiftLantern (hello@shiftlantern.example)',
        'harborline (test@harborline.example)',
      ])
      expect(await w.page.locator('[data-testid="send"]').isDisabled()).toBe(true)
      expect(await fits(w.page)).toBe(true)
      await w.shot('new-email-empty')
      if (size === '390') {
        expect(await w.page.locator('[data-testid="rows"]').isVisible()).toBe(false)
        await w.page.click('[data-testid="back"]')
        await w.page.waitForSelector('[data-testid="rows"]')
      }
      expect(w.errors).toEqual([])
    })

    test('a new email from Ridgeway with a file: it is sent once, and the person’s conversation opens with it in', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/new-email`)
      await w.page.waitForSelector('[data-testid="new-email"]')
      await w.page.waitForFunction(() => document.querySelectorAll('[data-testid="new-from"] option').length === 5)
      expect(await w.page.locator('[data-testid="attach"]').count()).toBe(0)
      await w.page.fill('[data-testid="new-to"]', size === '1440' ? 'Mara Quill <mara.quill@example.net>' : 'jonas.quill@example.net')
      await w.page.selectOption('[data-testid="new-from"]', 'business:ridgeway')
      await w.page.waitForSelector('[data-testid="attach"]')
      await w.page.fill('[data-testid="new-subject"]', 'Your drop-off form')
      await w.page.fill('[data-testid="compose-text"]', 'Hello,\n\nThe drop-off form is attached. Please bring it with the bike.\n\nThank you.')
      await w.page.setInputFiles('[data-testid="attach-input"]', { name: 'drop-off form.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') })
      await w.page.waitForSelector('[data-testid="chosen-file"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('new-email-filled')
      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(await w.page.locator('[data-testid="convo-title"]').textContent()).toBe(size === '1440' ? 'Mara Quill' : 'jonas.quill@example.net')
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="entry"]').first().textContent()).toContain('The drop-off form is attached.')
      expect(await w.page.locator('[data-testid="files"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('new-email-sent')
      expect(w.errors).toEqual([])
    })

    test('a new email the inbox refuses for an em dash says so in its words, keeps the words, and a fixed one sends', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/new-email`)
      await w.page.waitForSelector('[data-testid="new-email"]')
      await w.page.fill('[data-testid="new-to"]', 'someone@example.net')
      await w.page.fill('[data-testid="new-subject"]', 'A question')
      await w.page.fill('[data-testid="compose-text"]', 'Are you free Thursday \u2014 or Friday?')
      await w.page.waitForSelector('[data-testid="new-dash"]')
      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="compose-notice"][data-tone="error"]')
      expect(await w.page.locator('[data-testid="compose-notice"]').textContent()).toContain('em dash')
      expect(await w.page.inputValue('[data-testid="new-subject"]')).toBe('A question')
      expect(await fits(w.page)).toBe(true)
      await w.shot('new-email-refused')
      await w.page.fill('[data-testid="compose-text"]', 'Are you free Thursday, or Friday?')
      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="conversation"]')
      expect(w.errors).toEqual([])
    })

    test('a draft is edited in its card: Edit opens the subject and the words, Save shows the new words, and Send waits while it is open', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/lena%40fischerbakery.example`)
      await w.page.waitForSelector('[data-testid="draft"]')
      expect(await w.page.locator('[data-testid="draft"] a[href*="inbox.northfield.example"]').count()).toBe(0)
      await w.shot('draft-card')
      await w.page.click('[data-testid="edit-draft"]')
      await w.page.waitForSelector('[data-testid="draft-editor"]')
      expect(await w.page.locator('[data-testid="send-draft"]').isDisabled()).toBe(true)
      await w.page.fill('[data-testid="edit-text"]', 'Hi Lena,\n\nThank you for the screenshot. I can see the prices running off the edge.\n\nI will fix it today and send you a link to check on your phone.' + (size === '390' ? ' Thank you for waiting.' : ''))
      expect(await fits(w.page)).toBe(true)
      await w.shot('draft-edit')
      await w.page.click('[data-testid="save-draft"]')
      await w.page.waitForSelector('[data-testid="draft-saved"]')
      expect(await w.page.locator('[data-testid="draft"]').textContent()).toContain('Thank you for the screenshot.')
      expect(await w.page.locator('[data-testid="send-draft"]').isDisabled()).toBe(false)
      await w.shot('draft-saved')
      expect(w.errors).toEqual([])
    })

    test('an email thread is marked as spam and moved back, with the notice under the header', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${space.base}/inbox/lena%40fischerbakery.example`)
      await w.page.waitForSelector('[data-testid="spam"]')
      expect(await w.page.locator('[data-testid="spam"]').textContent()).toBe('Mark as spam')
      await w.shot('spam-button')
      await w.page.click('[data-testid="spam"]')
      await w.page.waitForSelector('[data-testid="change-notice"]')
      expect(await w.page.locator('[data-testid="change-notice"]').textContent()).toContain('is in Bulk now')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="spam"]')?.textContent === 'Move to the Inbox')
      expect(await fits(w.page)).toBe(true)
      await w.shot('spam-marked')
      await w.page.click('[data-testid="spam"]')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="spam"]')?.textContent === 'Mark as spam')
      expect(await w.page.locator('[data-testid="change-notice"]').textContent()).toContain('back in the Inbox')
      expect(w.errors).toEqual([])
    })
  })
}
