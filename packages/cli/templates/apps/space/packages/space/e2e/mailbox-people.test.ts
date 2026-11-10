// Mailboxes have people, seen in a real browser as two people of one made-up team over the same fixtures (SPACE_FIXTURES=two-people:
// the request says who it is by `x-dev-person`, and the fixture inbox cuts each person's list to the mailboxes they are on by the inbox's own rule, `canSee`): Alex is on every mailbox, Bea on Ridgeway's
// alone, and Cal on none. What no bun test can show: that the Inbox page draws exactly the rows each is given, search finds only theirs, and a person on no mailbox is told so and shown nothing.
//
//   bun test e2e/mailbox-people.test.ts
//
// The real inbox's rule and every method of its part are held by packages/inbox/test/mailbox-people.test.ts; the space's screens over the real inbox by test/mailbox-people.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { type E2eBrowser, launchBrowser } from '@space/forms/e2e/browser'
import { type Space, startSpace } from './server'

let space: Space
let browser: E2eBrowser
beforeAll(async () => {
  space = await startSpace({ portEnv: 'SPACE_E2E_PORT_SPACE', fixtures: 'two-people' })
  browser = await launchBrowser()
}, 300_000)
setDefaultTimeout(90_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await space?.kill()
}, 90_000)

async function as(person: string, size = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport: size, extraHTTPHeaders: { 'x-dev-person': person } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const keys = () => page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  return { page, errors, keys }
}

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  describe(`two people of one team at ${size.width}px`, () => {
    test('Alex, on every mailbox, is shown every row; Bea, on Ridgeway’s alone, is shown only its rows', async () => {
      const alex = await as('alex', size)
      await alex.page.goto(`${space.base}/inbox`)
      await alex.page.waitForSelector('[data-testid="row"]')
      const all = (await alex.keys()) as string[]
      const bea = await as('bea', size)
      await bea.page.goto(`${space.base}/inbox`)
      await bea.page.waitForSelector('[data-testid="row"]')
      const hers = (await bea.keys()) as string[]
      expect(hers.length).toBeGreaterThan(0)
      expect(hers.length).toBeLessThan(all.length)
      for (const key of hers) expect([key, all.includes(key)]).toEqual([key, true])
      expect(alex.errors).toEqual([])
      expect(bea.errors).toEqual([])
    })

    test('search finds a word in the mail the person may see, and nothing of the rest', async () => {
      const search = async (person: string, q: string) => {
        const w = await as(person, size)
        await w.page.goto(`${space.base}/inbox`)
        await w.page.waitForSelector('[data-testid="row"]')
        // The Inbox's rows hold the words they found; a word of Ridgeway's mail and a word of Tessa's own Gmail are told apart by who is searching.
        const answer = await w.page.evaluate(async (query) => (await (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json()) as { mail: { hits: { mailbox: string | null }[] } }, q)
        return answer.mail.hits
      }
      const alexHits = await search('alex', 'the')
      const beaHits = await search('bea', 'the')
      expect(alexHits.length).toBeGreaterThan(beaHits.length)
      for (const hit of beaHits) expect(hit.mailbox).toBe('Ridgeway Cycles')
    })

    test('a person who is on no mailbox is told the Inbox is not open to them and is shown no row', async () => {
      const cal = await as('cal', size)
      await cal.page.goto(`${space.base}/inbox`)
      await cal.page.waitForSelector('[data-notice="refused"][data-part="mail"]')
      expect(await cal.page.locator('[data-testid="row"]').count()).toBe(0)
      expect(cal.errors).toEqual([])
    })
  })
}
