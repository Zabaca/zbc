// In a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts): Tessa attaches or pastes ONE
// picture into a Telegram reply box, sees it small with Take out before anything is sent, is told the limits, and sends it; the picture is in the conversation as his. Its own server, because a picture sent changes the
// chat it is sent into, which another file counts.
//
//   bun test e2e/telegram-pictures.test.ts
//   TELEGRAM_SHOTS=/tmp/shots bun test e2e/telegram-pictures.test.ts   also writes each screen at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', fixtures: 'telegram-pictures' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

const shots = process.env.TELEGRAM_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

/** A 1x1 PNG: a picture the browser really decodes, so the thumbnail and the sent picture can be proved to have loaded. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

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
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/${name}-${size}.png` })
  }
  return { page, errors, shot, base: space.base }
}

/** A paste whose clipboard holds these files and this plain text, dispatched on the words box as the browser does. Answers whether the page took it over. */
const paste = (page: Page, o: { picture?: boolean; words?: string }) =>
  page.evaluate(
    ({ bytes, picture, words }) => {
      const data = new DataTransfer()
      if (picture) data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }))
      if (words) data.setData('text/plain', words)
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      document.querySelector('[data-testid="compose-text"]')?.dispatchEvent(event)
      return event.defaultPrevented
    },
    { bytes: [...PNG], picture: o.picture === true, words: o.words ?? '' },
  )

for (const size of ['1440', '390'] as const) {
  describe(`a picture in a Telegram reply at ${size}px`, () => {
    test('Attach picture shows the picture small with Take out and the limits said, words under it are its caption, and Send puts the picture in the conversation as his', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="compose-text"]')
      expect(await w.page.locator('[data-testid="picture-limits"]').textContent()).toContain('One picture, PNG or JPEG, at most 10 MB')
      const before = await w.page.locator('[data-testid="entry"]').count()

      await w.page.setInputFiles('[data-testid="picture-input"]', { name: 'Screenshot.png', mimeType: 'image/png', buffer: PNG })
      await w.page.waitForSelector('[data-testid="picture-preview"]')
      // The preview is the picture itself, really decoded, and Send is on with no words at all.
      expect(await w.page.evaluate(() => (document.querySelector('[data-testid="picture-preview"]') as HTMLImageElement).naturalWidth)).toBe(1)
      expect(await w.page.locator('[data-testid="picture-name"]').textContent()).toContain('Screenshot.png')
      expect(await w.page.locator('[data-testid="send"]').isDisabled()).toBe(false)
      await w.page.fill('[data-testid="compose-text"]', 'The red box is the bug.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-picture-chosen')

      // Taking it out puts the box back, and the picture can be chosen again.
      await w.page.click('[data-testid="picture-take-out"]')
      expect(await w.page.locator('[data-testid="picture-chosen"]').count()).toBe(0)
      await w.page.setInputFiles('[data-testid="picture-input"]', { name: 'Screenshot.png', mimeType: 'image/png', buffer: PNG })
      await w.page.waitForSelector('[data-testid="picture-preview"]')

      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="compose-notice"]')
      expect(await w.page.locator('[data-testid="compose-notice"]').textContent()).toContain('Sending on Telegram. It shows in the conversation when Telegram has it.')
      expect(await w.page.locator('[data-testid="picture-chosen"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="compose-text"]').inputValue()).toBe('')
      await w.page.waitForFunction((n) => document.querySelectorAll('[data-testid="entry"]').length === n + 1, before)
      // The sent message is his, with the words under the picture, and the picture really loaded (the Worker served it).
      const sent = w.page.locator('[data-testid="entry"]').last()
      expect(await sent.textContent()).toContain('The red box is the bug.')
      await w.page.waitForFunction(() => {
        const entries = document.querySelectorAll('[data-testid="entry"]')
        const img = entries[entries.length - 1]?.querySelector('[data-file="picture"] img') as HTMLImageElement | null
        return img !== null && img.complete && img.naturalWidth === 1
      })
      expect(await sent.getAttribute('class')).toContain('mine')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-picture-sent')
      expect(w.errors).toEqual([])
    })

    test('a screenshot pasted into the words is the picture, a paste with words is the words even with a picture riding along, and a picture alone goes with no words', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="compose-text"]')
      const before = await w.page.locator('[data-testid="entry"]').count()

      expect(await paste(w.page, { picture: true, words: 'A1\tB1' })).toBe(false)
      expect(await w.page.locator('[data-testid="picture-chosen"]').count()).toBe(0)
      expect(await paste(w.page, { picture: true })).toBe(true)
      await w.page.waitForSelector('[data-testid="picture-preview"]')
      expect(await w.page.locator('[data-testid="picture-name"]').textContent()).toContain('image.png')
      await w.shot('telegram-picture-pasted')

      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="compose-notice"]')
      await w.page.waitForFunction((n) => document.querySelectorAll('[data-testid="entry"]').length === n + 1, before)
      expect(await w.page.locator('[data-testid="entry"]').last().locator('[data-file="picture"]').count()).toBe(1)
      expect(w.errors).toEqual([])
    })

    test('a file that is not a picture is refused in words before Send, Send waits, and a chat that takes no picture has no control for one', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-maria')}`)
      await w.page.waitForSelector('[data-testid="compose-text"]')
      await w.page.setInputFiles('[data-testid="picture-input"]', { name: 'cat.png', mimeType: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') })
      await w.page.waitForSelector('[data-testid="picture-why"]')
      expect(await w.page.locator('[data-testid="picture-why"]').textContent()).toBe('cat.png is not a PNG or a JPEG, so Telegram would not take it as a picture.')
      expect(await w.page.locator('[data-testid="send"]').isDisabled()).toBe(true)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-picture-refused')

      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-status')}`)
      await w.page.waitForSelector('[data-testid="composer-none"]')
      expect(await w.page.locator('[data-testid="attach-picture"]').count()).toBe(0)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('dana@harbordental.example')}`)
      await w.page.waitForSelector('[data-testid="composer"]')
      expect(await w.page.locator('[data-testid="attach-picture"]').count()).toBe(0)
      expect(w.errors).toEqual([])
    })
  })

  describe(`a picture on a Telegram draft at ${size}px`, () => {
    /** The draft's picture on its card really loaded (the owner's own route served it). */
    const loaded = (page: Page) =>
      page.waitForFunction(() => {
        const img = document.querySelector('[data-testid="draft"] [data-testid="draft-picture"] img') as HTMLImageElement | null
        return img !== null && img.complete && img.naturalWidth > 0
      })

    test('Claude’s draft shows its picture and says it is Claude’s; Edit puts another on, takes it out and attaches one again, each change shown on the card', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="draft"] [data-testid="draft-picture"]')
      await loaded(w.page)
      // Claude's picture is Claude's until Tessa changes the draft (the first run); after that it is simply the draft's.
      expect(await w.page.locator('[data-testid="draft-picture-note"]').textContent()).toContain(size === '1440' ? 'Claude attached this picture.' : 'This draft carries a picture.')
      expect(await w.page.locator('[data-testid="send-draft"]').textContent()).toBe('Send as it stands')
      expect(await fits(w.page)).toBe(true)
      await w.page.locator('[data-testid="draft"]').scrollIntoViewIfNeeded()
      await w.shot('telegram-draft-picture')

      // Another picture put on: the card shows it (a different revision, so not the browser's old copy).
      await w.page.click('[data-testid="edit-draft"]')
      await w.page.waitForSelector('[data-testid="edit-picture"]')
      const before = await w.page.locator('[data-testid="edit-picture"] [data-testid="draft-picture"] img').getAttribute('src')
      await w.page.setInputFiles('[data-testid="edit-picture"] [data-testid="picture-input"]', { name: 'Receipt.png', mimeType: 'image/png', buffer: PNG })
      await w.page.waitForSelector('[data-testid="edit-picture"] [data-testid="picture-preview"]')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-draft-picture-edit')
      await w.page.click('[data-testid="save-draft"]')
      await w.page.waitForSelector('[data-testid="draft-saved"]')
      await loaded(w.page)
      const after = await w.page.locator('[data-testid="draft"] [data-testid="draft-picture"] img').getAttribute('src')
      expect(after).not.toBe(before)
      expect(await w.page.locator('[data-testid="draft-picture-note"]').textContent()).toContain('This draft carries a picture.')

      // Taken out in a save of its own, the card has none, and the editor offers to attach one.
      await w.page.click('[data-testid="edit-draft"]')
      await w.page.waitForSelector('[data-testid="remove-picture"]')
      await w.page.click('[data-testid="remove-picture"]')
      await w.page.click('[data-testid="save-draft"]')
      await w.page.waitForFunction(() => document.querySelector('[data-testid="draft"] [data-testid="draft-picture"]') === null)
      await w.page.click('[data-testid="edit-draft"]')
      await w.page.waitForSelector('[data-testid="edit-picture"] [data-testid="picture-button"]')
      expect(await w.page.locator('[data-testid="edit-picture"] [data-testid="picture-button"]').textContent()).toBe('Attach picture')
      await w.page.setInputFiles('[data-testid="edit-picture"] [data-testid="picture-input"]', { name: 'Receipt.png', mimeType: 'image/png', buffer: PNG })
      await w.page.waitForSelector('[data-testid="edit-picture"] [data-testid="picture-preview"]')
      await w.page.click('[data-testid="save-draft"]')
      await w.page.waitForSelector('[data-testid="draft"] [data-testid="draft-picture"]')
      await loaded(w.page)
      expect(w.errors).toEqual([])
    })

    if (size === '390') {
      test('the card’s Send sends the draft with its picture: the picture is in the conversation as his and the card is gone', async () => {
        const w = await openWindow(size)
        await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
        await w.page.waitForSelector('[data-testid="draft"] [data-testid="draft-picture"]')
        const before = await w.page.locator('[data-testid="entry"]').count()
        await w.page.click('[data-testid="send-draft"]')
        await w.page.waitForFunction((n) => document.querySelectorAll('[data-testid="entry"]').length === n + 1, before)
        await w.page.waitForFunction(() => {
          const entries = document.querySelectorAll('[data-testid="entry"]')
          const img = entries[entries.length - 1]?.querySelector('[data-file="picture"] img') as HTMLImageElement | null
          return img !== null && img.complete && img.naturalWidth > 0
        })
        expect(await w.page.locator('[data-testid="entry"]').last().textContent()).toContain('Here is the receipt you asked for.')
        expect(await w.page.locator('[data-testid="draft"]').count()).toBe(0)
        expect(await fits(w.page)).toBe(true)
        expect(w.errors).toEqual([])
      })
    }
  })
}
