// Channel admin in a real browser, over the production bundle and the fixtures (the invented people of src/stand-ins.ts, no meet): New channel, Browse and Join, a channel's
// people, Invite a guest, Archive. Both widths, nothing off the side of a phone. The rules themselves (who may archive, what a person outside a channel is never told, the one
// email) are proved in packages/meet/test/space-channels.test.ts over the real Workspace core and in test/channels*.test.ts; this is what a person sees.
//
//   bun test e2e/channels.test.ts
//   CHANNEL_SHOTS=/tmp/shots bun test e2e/channels.test.ts   also writes the screens at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
setDefaultTimeout(90_000)

const shots = process.env.CHANNEL_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const

const fits = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main.main') as HTMLElement
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
  })

for (const size of ['1440', '390'] as const) {
  describe(`channel admin at ${size}px`, () => {
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
    /** On a phone the channel's people are one tap away (the profile sheet). */
    const people = async (page: Page) => {
      if (size === '390') await page.click('[data-testid="open-profile"]')
      await page.waitForSelector('[data-testid="members"]')
    }

    test('New channel: the form, then the channel made, in the list and open, with its people', async () => {
      const { page, errors } = await open('/meet')
      await page.waitForSelector('[data-testid="channel-tools"]')
      await page.click('[data-testid="new-channel-button"]')
      await page.fill('[data-testid="channel-name"]', 'acme-website')
      await shot(page, 'new-channel')
      await page.click('[data-testid="channel-make"]')
      await page.waitForSelector('[data-testid="conversation"]')
      expect(await page.locator('[data-testid="convo-title"]').textContent()).toBe('# acme-website')
      expect(decodeURIComponent(new URL(page.url()).pathname)).toMatch(/^\/meet\/chat:channel:\d+$/)
      await people(page)
      expect(await page.locator('[data-testid="member"]').count()).toBe(1)
      await shot(page, 'new-channel-made')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('Browse channels and Join', async () => {
      const { page, errors } = await open('/meet')
      await page.click('[data-testid="browse-button"]')
      await page.waitForSelector('[data-testid="browse-channel"]')
      expect(await page.locator('[data-testid="browse-channel"]').count()).toBe(2)
      await shot(page, 'browse')
      await page.locator('[data-testid="join-channel"]').first().click()
      await page.waitForSelector('[data-testid="conversation"]')
      expect(await page.locator('[data-testid="convo-title"]').textContent()).toBe('# design')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('a channel’s people: tags, what the owner may do with each, and Invite a guest', async () => {
      const { page, errors } = await open(`/meet/${encodeURIComponent('chat:channel:21')}`)
      await page.waitForSelector('[data-testid="conversation"]')
      await people(page)
      await page.waitForSelector('[data-testid="member"]')
      expect(await page.locator('[data-testid="member-tag"]').allTextContents()).toEqual(['Northfield Works', 'Northfield Works', 'Northfield Works', 'Guest', 'Invited', 'Guest'])
      await shot(page, 'people')
      await page.fill('[data-testid="invite-name"]', 'Abel Ng')
      await page.fill('[data-testid="invite-email"]', 'abel@abelcpa.example')
      await page.locator('[data-testid="invite-form"]').scrollIntoViewIfNeeded()
      await shot(page, 'invite-ready')
      await page.click('[data-testid="invite-go"]')
      await page.waitForSelector('[data-testid="done"]')
      expect(await page.locator('[data-testid="done"]').textContent()).toContain('Invited Abel Ng. They get an email from meet@northfield.example.')
      expect(await page.locator('[data-testid="member"]').count()).toBe(7)
      await page.locator('[data-testid="done"]').scrollIntoViewIfNeeded()
      await shot(page, 'invited')
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })

    test('Archive asks first, and a yes takes the channel off the list', async () => {
      const { page, errors } = await open(`/meet/${encodeURIComponent('chat:channel:22')}`)
      await page.waitForSelector('[data-testid="conversation"]')
      await people(page)
      await page.click('[data-testid="archive"]')
      await page.waitForSelector('[data-testid="ask"]')
      expect(await page.locator('[data-testid="ask"]').textContent()).toContain("Archive this channel? It leaves everyone's list and takes no new messages.")
      await shot(page, 'archive-ask')
      await page.click('[data-testid="ask-yes"]')
      await page.waitForSelector('[data-testid="rows"]')
      await page.waitForSelector('[data-testid="row"][data-key="chat:channel:22"]', { state: 'detached' })
      expect(await page.locator('[data-testid="row"][data-key="chat:channel:21"]').count()).toBe(1)
      expect(await fits(page)).toBe(true)
      expect(errors).toEqual([])
    })
  })
}
