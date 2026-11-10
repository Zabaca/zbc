// Tessa's Telegram chats (one-to-one, and groups and channels) in a real browser, over the production bundle with the dev bypass and the local fixtures (the invented people of src/stand-ins.ts: Maria Lopez, who writes on Telegram
// alone; Dana Reyes, who writes by email and on Telegram; a bot in Bulk; a chat Tessa archived in Telegram, which came in Closed): the Telegram row and its pill in the Inbox, the Telegram entry in
// the menu, a conversation with an edited and a deleted message, a reply box and a draft sent by the inbox (sending, a refusal, a send nobody confirmed), the Settings card and the menu's foot, and the foot and card gone amber when the bridge stops or its login ends, at a
// computer's width and a phone's. What no bun test can show: that the page's own CSS gives each of them room and nothing runs off the side of a phone.
//
//   bun test e2e/telegram.test.ts
//   TELEGRAM_SHOTS=/tmp/shots bun test e2e/telegram.test.ts   also writes each screen at 1440px and 390px
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

const shots = process.env.TELEGRAM_SHOTS
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
  describe(`Telegram at ${size}px`, () => {
    test('the Inbox lists a Telegram person as a row with one Telegram pill; the bot is in Bulk and the archived chat in Closed; and the Telegram entry narrows the list', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox`)
      await w.page.waitForSelector('[data-testid="row"]')
      const maria = w.page.locator('[data-testid="row"][data-key="mail:c-tg-maria"]')
      expect(await maria.count()).toBe(1)
      expect(await maria.textContent()).toContain('Can you come by Friday instead?')
      expect(await maria.locator('[data-testid="telegram-pill"]').textContent()).toContain('Telegram')
      expect((await maria.textContent())?.match(/Telegram/g)?.length).toBe(1)
      expect(await w.page.locator('[data-testid="row"][data-key="mail:c-tg-bot"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="row"][data-key="mail:c-tg-sam"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-inbox')

      // The menu's Telegram entry: its rows alone.
      await w.page.goto(`${w.base}/inbox?view=${encodeURIComponent('mailbox:telegram')}`)
      await w.page.waitForSelector('[data-testid="row"]')
      const keys = await w.page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
      expect(keys).toContain('mail:c-tg-maria')
      expect(keys).not.toContain('mail:c-tg-bot')
      await w.shot('telegram-filter')

      await w.page.goto(`${w.base}/inbox?view=bulk`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(await w.page.locator('[data-testid="row"][data-key="mail:c-tg-bot"]').count()).toBe(1)
      await w.page.goto(`${w.base}/inbox?view=closed`)
      await w.page.waitForSelector('[data-testid="row"]')
      expect(await w.page.locator('[data-testid="row"][data-key="mail:c-tg-sam"]').count()).toBe(1)
      expect(w.errors).toEqual([])
    })

    test('a Telegram conversation: the messages as bubbles, an edited one marked, a deleted one a line, a reply box headed by who it goes to, and Claude’s draft sent by the inbox', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-maria')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="entry"]').count()).toBe(6)
      expect(await w.page.locator('[data-testid="edited"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="deleted-message"]').textContent()).toBe('This message was deleted in Telegram.')
      expect(await w.page.locator('[data-testid="heading"]').first().textContent()).toContain('Telegram')
      expect(await w.page.locator('[data-testid="draft-to"]').textContent()).toBe('To Maria Lopez on Telegram')
      expect(await w.page.locator('[data-testid="copy-address"]').count()).toBe(0)
      // Sent by the inbox through the bridge: Send as it stands, and nothing to copy or mark by hand.
      expect(await w.page.locator('[data-testid="send-draft"]').textContent()).toBe('Send as it stands')
      expect(await w.page.locator('[data-testid="draft-notice"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="copy-words"]').count()).toBe(0)
      // A box to write in, headed by who it goes to.
      expect(await w.page.locator('[data-testid="composer"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="reply-line"]').textContent()).toContain('Telegram message to Maria Lopez')
      expect(await w.page.locator('[data-testid="composer-none"]').count()).toBe(0)
      // Not mail: the button says Send, and no call link or booking (both go by email) is offered in it.
      expect(await w.page.locator('[data-testid="send"]').textContent()).toBe('Send')
      expect(await w.page.locator('[data-testid="add-call-link"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="open-schedule"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-conversation')
      expect(w.errors).toEqual([])
    })

    test('Tessa writes a reply and presses Send: the page says it is sending on Telegram, the box is empty for the next one, and the message is in the conversation', async () => {
      // Sam's chat (the archived one): nothing else in the suite counts its messages, so sending into it changes nothing another test reads.
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="compose-text"]')
      const before = await w.page.locator('[data-testid="entry"]').count()
      await w.page.fill('[data-testid="compose-text"]', 'Friday at ten works. See you then.')
      await w.shot('telegram-compose')
      await w.page.click('[data-testid="send"]')
      await w.page.waitForSelector('[data-testid="compose-notice"]')
      expect(await w.page.locator('[data-testid="compose-notice"]').textContent()).toContain('Sending on Telegram. It shows in the conversation when Telegram has it.')
      expect(await w.page.locator('[data-testid="compose-text"]').inputValue()).toBe('')
      await w.page.waitForFunction((n) => document.querySelectorAll('[data-testid="entry"]').length === n + 1, before)
      expect(await w.page.locator('[data-testid="entry"]').last().textContent()).toContain('Friday at ten works. See you then.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-sent')
      expect(w.errors).toEqual([])
    })

    test('a draft Telegram would not take says why and can be sent again; a send nobody confirmed says to check Telegram and offers the two answers', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('dana@harbordental.example')}`)
      await w.page.waitForSelector('[data-testid="draft-refusal"]')
      expect(await w.page.locator('[data-testid="draft-refusal"]').textContent()).toContain('Telegram would not take this, so nothing was sent. You cannot write in this chat.')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-refused')
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-garden')}`)
      await w.page.waitForSelector('[data-testid="stuck-send"]')
      const stuck = (await w.page.locator('[data-testid="stuck-send"]').textContent()) ?? ''
      expect(stuck).toContain('Sending on Telegram, or the send never finished.')
      expect(stuck).toContain('Check Telegram, then say which it was.')
      expect(await w.page.locator('[data-testid="stuck-out"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="stuck-not"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="send-draft"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-stuck')
      expect(w.errors).toEqual([])
    })

    test('photos and voice notes: a photo is a thumbnail, a voice note is a player that plays, a file left in Telegram says so and where, and the bare placeholder is not drawn over a file that is shown', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="files"]')
      // Four pictures are thumbnails that really loaded (a picture the Worker served): two photos (one with a caption and one without), a picture sent as a file, and a photo Tessa sent himself.
      await w.page.waitForFunction(() => [...document.querySelectorAll('[data-file="picture"] img')].every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))
      expect(await w.page.locator('[data-file="picture"] img').count()).toBe(4)
      // The captionless photo and the voice note show no "[Photo]" or "[Voice note]" over the file; the ones whose file is not shown keep the words they have.
      const texts = await w.page.locator('[data-testid="entry"]').allTextContents()
      expect(texts.filter((t) => t.includes('This is the corner I meant.')).length).toBe(1)
      expect(await w.page.locator('[data-testid="entry"]:has([data-file="voice"]) .msg-text').count()).toBe(0)
      expect(await w.page.locator('[data-testid="entry"]:has([data-file="picture"]) .msg-text').count()).toBe(1)
      // The voice note is a player; the browser decodes the Ogg the Worker served and knows its length (three seconds).
      const player = w.page.locator('[data-testid="voice-player"]')
      expect(await player.count()).toBe(1)
      expect(await w.page.locator('[data-file="voice"] figcaption').textContent()).toMatch(/^Voice note, 0:03 \(/)
      const length = await w.page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const a = document.querySelector('[data-testid="voice-player"]') as HTMLAudioElement
            a.addEventListener('loadedmetadata', () => resolve(a.duration), { once: true })
            a.addEventListener('error', () => reject(new Error('the voice note did not load')), { once: true })
            a.preload = 'metadata'
            a.load()
          }),
      )
      expect(length).toBeGreaterThan(2)
      expect(length).toBeLessThan(4)
      expect(await w.page.locator('[data-testid="voice-failed"]').count()).toBe(0)
      // Asked in pieces, as Safari asks, the Worker answers 206.
      const status = await w.page.evaluate(async (url) => (await fetch(url, { headers: { range: 'bytes=0-9' } })).status, (await player.getAttribute('src')) as string)
      expect(status).toBe(206)
      // What stays in Telegram says so on the page, with the size, and offers nothing to open or save.
      const notes = await w.page.locator('[data-testid="file-note"]').allTextContents()
      expect(notes).toEqual(['Too large to copy. Open it in Telegram.', 'Not copied here. Open it in Telegram.', 'Copying from Telegram.', 'Too large to copy. Open it in Telegram.'])
      const left = await w.page.locator('[data-file="left"] .file-chip').allTextContents()
      expect(left).toEqual(['Photo.jpg (11.0 MB)', 'Video (18.0 MB)', 'Photo.jpg', 'Video.mp4 (48.0 MB)'])
      expect(await w.page.locator('[data-file="left"] a, [data-file="left"] img, [data-file="left"] audio, [data-file="left"] video').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      // The three places of the conversation that tell the story: the photos, the player, and the files left in Telegram.
      await w.page.locator('[data-file="picture"]').first().scrollIntoViewIfNeeded()
      await w.shot('telegram-media-photo')
      await w.page.locator('[data-file="voice"]').scrollIntoViewIfNeeded()
      await w.shot('telegram-media-voice')
      await w.page.locator('[data-file="left"]').first().scrollIntoViewIfNeeded()
      await w.shot('telegram-media-left')
      expect(w.errors).toEqual([])
    })

    test('videos and pictures sent as files: a video is a player that loads and plays in ranges, a heic picture is saved and not drawn, a video over the limit says so, and the bracketed words of any bubble stay on one line', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-sam')}`)
      await w.page.waitForSelector('[data-testid="files"]')
      // The video is a player over the file; the browser decodes the WebM the Worker served and knows its length (one second); no "[Video]" words are drawn over it.
      const player = w.page.locator('[data-testid="video-player"]')
      expect(await player.count()).toBe(1)
      expect(await w.page.locator('[data-file="video"] figcaption').textContent()).toMatch(/^Video, 0:01 \(/)
      expect(await w.page.locator('[data-testid="entry"]:has([data-file="video"]) .msg-text').count()).toBe(0)
      const length = await w.page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const v = document.querySelector('[data-testid="video-player"]') as HTMLVideoElement
            v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true })
            v.addEventListener('error', () => reject(new Error('the video did not load')), { once: true })
            v.preload = 'metadata'
            v.load()
          }),
      )
      expect(length).toBeGreaterThan(0.5)
      expect(length).toBeLessThan(2)
      expect(await w.page.locator('[data-testid="video-failed"]').count()).toBe(0)
      const url = (await player.getAttribute('src')) as string
      const ranged = await w.page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { range: 'bytes=0-9' } })
        return { status: r.status, type: r.headers.get('content-type'), ranges: r.headers.get('accept-ranges') }
      }, url)
      expect(ranged).toEqual({ status: 206, type: 'video/webm', ranges: 'bytes' })
      // A picture sent as a file is a thumbnail; a heic one is a chip to save (no browser here draws it), never an image.
      expect(await w.page.locator('[data-file="download"]').allTextContents()).toEqual(['Image.heic (1 KB)'])
      // Tessa's own bracketed bubbles keep their word whole: "[Video]" over a video left in Telegram is one line as tall as one line of text.
      const bubble = w.page.locator('[data-testid="entry"].mine:has([data-file="left"]) .msg-text').last()
      expect(await bubble.textContent()).toBe('[Video]')
      const box = await bubble.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return { lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, scrolls: el.scrollWidth > el.clientWidth }
      })
      expect(box).toEqual({ lines: 1, scrolls: false })
      expect(await fits(w.page)).toBe(true)
      await w.page.locator('[data-file="video"]').scrollIntoViewIfNeeded()
      await w.shot('telegram-media-video')
      await w.page.locator('[data-file="left"]').last().scrollIntoViewIfNeeded()
      await w.shot('telegram-media-video-left')
      expect(w.errors).toEqual([])
    })

    test('a bracketed word alone in a bubble, with only a short stamp over it, stays on one line (the "[Vide / o]" of Tessa\'s own video message)', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-maria')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      const bubble = w.page.locator('[data-testid="entry"].mine .msg-text', { hasText: '[Video]' })
      expect(await bubble.count()).toBe(1)
      const lines = await bubble.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
      })
      await bubble.scrollIntoViewIfNeeded()
      await w.shot('telegram-bracket-bubble')
      expect(lines).toBe(1)
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
    })

    test('a person who writes by email and on Telegram is one conversation with both', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('dana@harbordental.example')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      const headings = await w.page.locator('[data-testid="heading"]').allTextContents()
      expect(headings.some((h) => h.includes('Telegram'))).toBe(true)
      expect(headings.some((h) => h.includes('Email:'))).toBe(true)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-with-email')
      expect(w.errors).toEqual([])
    })

    test('Settings has a Telegram card saying the bridge is live, and the menu’s foot a line for it', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/settings/mailboxes`)
      await w.page.waitForSelector('[data-testid="telegram"]')
      const card = w.page.locator('[data-testid="telegram"]')
      expect(await card.getAttribute('data-state')).toBe('live')
      expect(await card.locator('[data-testid="telegram-words"]').textContent()).toContain('Telegram is live, last message')
      expect(await card.textContent()).toContain('96 messages in 7 conversations')
      expect(await fits(w.page)).toBe(true)
      await card.scrollIntoViewIfNeeded()
      await w.shot('telegram-settings')
      if (size === '1440') {
        const lines = await w.page.locator('[data-testid="status-line"]').allTextContents()
        expect(lines.some((l) => l.startsWith('Telegram is live'))).toBe(true)
        // The bridge is well: its line is not amber (the fixtures' lapsed Gmail and ShiftLantern's mailbox are).
        const telegram = w.page.locator('[data-testid="status-line"]', { hasText: 'Telegram is live' })
        expect(await telegram.getAttribute('data-amber')).toBe('false')
      }
      expect(w.errors).toEqual([])
    })
  })
}

// Groups and channels, over the same fixtures (Main Street Merchants, a group with a message that mentions Tessa; Garden Club, a group that is only chatter; Cloudflare Status, a channel in Bulk;
// Tomas Vega and Priti Shah, who write only in groups; Maria Lopez, who writes in the merchants' group and to Tessa).
for (const size of ['1440', '390'] as const) {
  describe(`Telegram groups and channels at ${size}px`, () => {
    test('the Inbox lists each group as one row under its own name, tagged Group, the newest message named by who wrote it; no member and no channel is a row; the channel is in Bulk', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox`)
      await w.page.waitForSelector('[data-testid="row"]')
      const merchants = w.page.locator('[data-testid="row"][data-key="mail:c-tg-merchants"]')
      expect(await merchants.count()).toBe(1)
      expect(await merchants.locator('.row-title').textContent()).toBe('Main Street Merchants')
      expect(await merchants.textContent()).toContain('Tomas: @tessa could you look at our site this week?')
      expect(await merchants.locator('[data-testid="telegram-chat-tag"]').textContent()).toBe('Group')
      expect(await merchants.locator('[data-testid="telegram-pill"]').count()).toBe(1)
      const garden = w.page.locator('[data-testid="row"][data-key="mail:c-tg-garden"]')
      expect(await garden.count()).toBe(1)
      expect(await garden.textContent()).toContain('Tomas: Seed swap is moved to the 14th.')
      for (const key of ['mail:c-tg-tomas', 'mail:c-tg-priti', 'mail:c-tg-status']) {
        expect(await w.page.locator(`[data-testid="row"][data-key="${key}"]`).count()).toBe(0)
      }
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-groups-inbox')

      await w.page.goto(`${w.base}/inbox?view=bulk`)
      await w.page.waitForSelector('[data-testid="row"]')
      const status = w.page.locator('[data-testid="row"][data-key="mail:c-tg-status"]')
      expect(await status.count()).toBe(1)
      expect(await status.locator('[data-testid="telegram-chat-tag"]').textContent()).toBe('Channel')
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-groups-bulk')
      expect(w.errors).toEqual([])
    })

    test('a group’s conversation: headed Telegram group, every message named by who wrote it, mine on the right, what is beside it is a kind and nothing to fill in', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-merchants')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      const names = await w.page.locator('[data-testid="entry"] .msg-head b').allTextContents()
      expect(names).toEqual(['Tomas Vega', 'Priti Shah', 'Maria Lopez', 'You', 'Tomas Vega'])
      expect(await w.page.locator('[data-testid="heading"]').first().textContent()).toContain('Telegram group')
      expect(await w.page.locator('[data-testid="reply-line"]').textContent()).toContain('Telegram message to the group Main Street Merchants')
      expect(await w.page.locator('[data-testid="composer-none"]').count()).toBe(0)
      expect(await w.page.locator('[data-testid="send"]').count()).toBe(1)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-group-conversation')
      if (size === '1440') {
        const beside = w.page.locator('[data-testid="profile"]')
        expect(await beside.textContent()).toContain('Telegram group')
        expect(await beside.locator('[data-testid="profile-beside"]').count()).toBe(0)
      }
      expect(w.errors).toEqual([])
    })

    test('a channel has no reply box and says why', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-status')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="heading"]').first().textContent()).toContain('Telegram channel')
      expect(await w.page.locator('[data-testid="composer-none"]').textContent()).toContain('A Telegram channel is one you follow')
      expect(await w.page.locator('[data-testid="send"]').count()).toBe(0)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-channel-conversation')
      expect(w.errors).toEqual([])
    })

    test('People lists the members who write in groups and leaves the groups out; a member’s page lists the groups they write in, each opening the group’s row', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/people`)
      await w.page.waitForSelector('[data-testid="person"]')
      const names = await w.page.locator('[data-testid="person"]').allTextContents()
      const has = (n: string) => names.some((t) => t.includes(n))
      expect(has('Tomas Vega') && has('Priti Shah') && has('Maria Lopez')).toBe(true)
      for (const group of ['Main Street Merchants', 'Garden Club', 'Cloudflare Status']) expect(has(group)).toBe(false)
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-people')

      await w.page.goto(`${w.base}/people/${encodeURIComponent('mail:c-tg-tomas')}`)
      await w.page.waitForSelector('[data-testid="writes-in"]')
      const groups = await w.page.locator('[data-testid="writes-in-group"]').allTextContents()
      expect(groups).toEqual(['Main Street Merchants', 'Garden Club'])
      expect(await fits(w.page)).toBe(true)
      await w.shot('telegram-member-page')
      await w.page.locator('[data-testid="writes-in-group"]').first().click()
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="heading"]').first().textContent()).toContain('Telegram group')
      expect(w.errors).toEqual([])
    })

    test('a member’s own conversation holds only what passed between the two of you, and beside it is the list of their groups', async () => {
      const w = await openWindow(size)
      await w.page.goto(`${w.base}/inbox/${encodeURIComponent('mail:c-tg-maria')}`)
      await w.page.waitForSelector('[data-testid="entry"]')
      expect(await w.page.locator('[data-testid="entry"]').count()).toBe(6)
      expect(await w.page.locator('[data-testid="entry"]').allTextContents()).not.toContain('Lopez Tile used them too')
      if (size === '1440') {
        await w.page.waitForSelector('[data-testid="writes-in"]')
        expect(await w.page.locator('[data-testid="writes-in-group"]').allTextContents()).toEqual(['Main Street Merchants'])
        await w.shot('telegram-member-conversation')
      }
      expect(w.errors).toEqual([])
    })
  })
}

// The two amber states need their own servers (the fixtures hold their state for as long as a server runs): the build bakes the dev switches in, so each is built for its mode, and each server is stopped before the next starts.
for (const [mode, state, words] of [
  ['telegram-late', 'not-checked-in', 'The Telegram bridge has not checked in since'],
  ['telegram-signed-out', 'signed-out', 'Telegram ended the saved login for the bridge. Only you can sign in again.'],
] as const) {
  for (const size of ['1440', '390'] as const) {
    describe(`Telegram, ${mode}, at ${size}px`, () => {
      test('the card and the foot say the same sentence and are amber', async () => {
        const other = await startSpace({ fixtures: mode })
        try {
          const w = await openWindow(size, other.base)
          await w.page.goto(`${w.base}/settings/mailboxes`)
          await w.page.waitForSelector('[data-testid="telegram"]')
          const card = w.page.locator('[data-testid="telegram"]')
          expect(await card.getAttribute('data-state')).toBe(state)
          const sentence = (await card.locator('[data-testid="telegram-words"]').textContent()) ?? ''
          expect(sentence).toContain(words)
          expect(await card.getAttribute('class')).toContain('amber')
          if (size === '1440') {
            const amber = await w.page.locator('[data-testid="status-line"][data-amber="true"]').allTextContents()
            expect(amber).toContain(sentence)
          } else {
            // On a phone the foot is in the views sheet.
            await w.page.goto(`${w.base}/inbox`)
            await w.page.waitForSelector('[data-testid="views-button"]')
            await w.page.click('[data-testid="views-button"]')
            await w.page.waitForSelector('[data-testid="views-sheet"]')
            const amber = await w.page.locator('[data-testid="views-sheet"] [data-testid="status-line"][data-amber="true"]').allTextContents()
            expect(amber).toContain(sentence)
            await w.page.locator('[data-testid="views-sheet"] [data-testid="status-line"]').last().scrollIntoViewIfNeeded()
            await w.shot(`${mode}-menu`)
            await w.page.goto(`${w.base}/settings/mailboxes`)
            await w.page.waitForSelector('[data-testid="telegram"]')
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
