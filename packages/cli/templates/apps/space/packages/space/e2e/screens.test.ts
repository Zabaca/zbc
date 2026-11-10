// The Forms tab's screens in the space's own page, in a real browser over the real forms Worker (workerd, a local D1 and R2) behind the
// space's production bundle: the clients, a client with its logo, the envelopes and an envelope's timeline, the forms, the documents and
// the PDF placement screen, the seal and the history, each with the rail's tree beside it and, on a phone, the row of sections above it.
// What no bun test can show: that Tailwind's classes and the space's own CSS agree, that nothing runs off the side of a phone, that the
// page's CSP lets pdf.js draw, and that a screen's links and a lost sign-in move the page the way the space's own tabs do.
//
//   bun test e2e/screens.test.ts     (needs a Chromium or Chrome; SPACE_E2E_PORT_FORMS and SPACE_E2E_PORT_SPACE name the ports, else free ones are used)
//   FORMS_SHOTS=/tmp/shots bun test e2e/screens.test.ts   also writes each screen at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { COMMITTED_DIR } from '@space/forms/scripts/fixtures'
import { linkFor } from '@space/forms/e2e/local-mail'
import { solidPng } from '@space/forms/test/png'
import { type Stack, startStack } from './stack'

let stack: Stack
beforeAll(async () => {
  stack = await startStack({ forms: 'SPACE_E2E_PORT_FORMS', space: 'SPACE_E2E_PORT_SPACE' })
}, 300_000)
afterEach(() => stack?.browser.closeContexts(), 60_000)
afterAll(() => stack?.stop(), 90_000)

const shots = process.env.FORMS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const at = (path: string) => `${stack.space.base}${path}`

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) => page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

// ── What the screens show ────────────────────────────────────────────────────────────────────────────────────────────────

let clientId = ''
let envelope = ''
let documentId = ''

const tokenOf = (link: string) => link.split('/s/')[1]!
const signer = (token: string) => async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${stack.forms.base}/s/api/s/${token}${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

describe('the data the screens read', () => {
  test('a client with a logo, an envelope one signer has signed, a PDF with a field placed on it', async () => {
    clientId = (await stack.setUpClient({ slug: `screens-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: ['books@pinecrest.example'] })).id
    expect((await fetch(`${stack.forms.base}/admin/api/clients/${clientId}/logo`, { method: 'PUT', body: solidPng(160, 60, [210, 150, 60]) as BodyInit })).status).toBe(200)

    const draft = await stack.api<{ envelope: { id: string } }>('POST', '/envelopes', { client_id: clientId, source: { type: 'sample' }, order: 'sequential', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }, { role: 'CPA', name: 'Bob Preparer', email: 'bob@example.test' }] })
    envelope = draft.envelope.id
    await stack.api('POST', `/envelopes/${envelope}/send`, {})
    const s = signer(tokenOf(linkFor(stack.forms.base, 'Alice Example')))
    await s('POST', '/open')
    await s('POST', '/consent')
    const view = (await s('GET', '')).body
    const png = Buffer.from(solidPng(60, 24, [20, 30, 120])).toString('base64')
    await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: png })
    await s('POST', '/adopt', { kind: 'initials', method: 'drawn', image: png })
    for (const f of view.fields) {
      const value = f.type === 'signature' || f.type === 'initials' ? 'adopted' : f.type === 'text' ? 'Alice Example' : f.type === 'checkbox' ? true : undefined
      if (value !== undefined) await s('PUT', `/fields/${f.id}`, { value })
    }
    expect((await s('POST', '/finish', { intent: true })).status).toBe(200)

    const pdf = readFileSync(join(COMMITTED_DIR, 'fw9.pdf'))
    const made = await fetch(`${stack.forms.base}/admin/api/documents?client=${clientId}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-file-name': 'fw9.pdf' }, body: pdf })
    expect(made.ok).toBe(true)
    documentId = ((await made.json()) as { id: string }).id
    await stack.api('PUT', `/documents/${documentId}/fields`, { fields: [{ recipient: 1, type: 'signature', page: 0, required: true, box: { x: 0.12, y: 0.71, width: 0.28, height: 0.05 } }] })
  }, 120_000)
})

/** Scrolls the space's own scrolling area (`main`) so the element is at its top. (`scrollIntoView` would also move the page behind it.) */
const toTop = (el: Element) => {
  const main = document.querySelector('main.main') as HTMLElement
  main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 12
}

/** Each screen, how to tell it is drawn, and the name its screenshot gets. */
const SCREENS: { name: string; path: () => string; ready: (page: Page) => Promise<unknown>; scroll?: (page: Page) => Promise<unknown> }[] = [
  { name: 'clients', path: () => '/forms', ready: (p) => p.getByRole('heading', { name: 'Clients', level: 1 }).waitFor() },
  { name: 'client', path: () => `/forms/clients/${clientId}`, ready: (p) => p.getByAltText('Pinecrest logo').waitFor() },
  { name: 'client-logo', path: () => `/forms/clients/${clientId}`, ready: (p) => p.getByAltText('Pinecrest logo').waitFor(), scroll: (p) => p.getByRole('heading', { name: 'Logo', exact: true }).evaluate(toTop) },
  { name: 'envelopes', path: () => '/forms/envelopes', ready: (p) => p.getByRole('heading', { name: 'Envelopes', level: 1 }).waitFor() },
  { name: 'envelope', path: () => `/forms/envelopes/${envelope}`, ready: (p) => p.getByRole('heading', { name: 'Timeline' }).waitFor() },
  { name: 'envelope-timeline', path: () => `/forms/envelopes/${envelope}`, ready: (p) => p.getByRole('heading', { name: 'Timeline' }).waitFor(), scroll: (p) => p.getByRole('heading', { name: 'Timeline' }).evaluate(toTop) },
  { name: 'forms', path: () => '/forms/forms', ready: (p) => p.getByRole('heading', { name: 'Forms', level: 1 }).waitFor() },
  { name: 'documents', path: () => '/forms/documents', ready: (p) => p.getByRole('heading', { name: 'Documents', level: 1 }).waitFor() },
  {
    name: 'placement',
    path: () => `/forms/documents/${documentId}`,
    ready: (p) => p.waitForFunction(() => document.querySelector('[data-page="0"] canvas[data-drawn="true"]') !== null, null, { timeout: 30_000 }),
  },
  { name: 'send', path: () => `/forms/send?client=${clientId}`, ready: (p) => p.getByRole('heading', { name: 'Send', level: 1 }).waitFor() },
  { name: 'seal', path: () => '/forms/seal', ready: (p) => p.getByRole('heading', { name: 'Seal', level: 1 }).waitFor() },
  { name: 'history', path: () => '/forms/history', ready: (p) => p.getByRole('heading', { name: 'History', level: 1 }).waitFor() },
]

for (const [label, viewport] of [['a computer', DESKTOP], ['a phone', PHONE]] as const) {
  describe(`each screen on ${label}`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name}: drawn in the space's page, nothing off the side, nothing thrown${shots ? ', photographed' : ''}`, async () => {
        const { ctx, page, errors } = await stack.operator({ viewport, deviceScaleFactor: viewport.width < 600 ? 2 : 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 })
        await page.goto(at(screen.path()))
        await screen.ready(page)
        await screen.scroll?.(page)
        // It is the space's own page: its shell is there and no frame is.
        expect(await page.locator('nav.rail').count()).toBe(1)
        expect(await page.locator('iframe').count()).toBe(0)
        // The tree under Forms is the rail's on a computer; the row of sections is above the screen on a phone. Exactly one of them is shown.
        const tree = await page.getByTestId('forms-tree').isVisible()
        const row = await page.getByTestId('forms-sections').isVisible()
        expect([viewport.width < 600 ? 'row' : 'tree', tree, row]).toEqual(viewport.width < 600 ? ['row', false, true] : ['tree', true, false])
        await page.waitForTimeout(400)
        expect(await fits(page), `${screen.name} runs off the side`).toBe(true)
        if (shots) await page.screenshot({ path: join(shots, `forms-${screen.name}-${viewport.width}.png`) })
        expect(errors).toEqual([])
        await ctx.close()
      }, 90_000)
    }
  })
}

describe('what a screen shows', () => {
  test('a client: its name and logo from forms, through the space; the logo is cached by the browser alone', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    const logos: { url: string; type: string | undefined }[] = []
    page.on('response', (r) => r.url().includes('/forms/logo/') && logos.push({ url: r.url(), type: r.headers()['content-type'] }))
    await page.goto(at(`/forms/clients/${clientId}`))
    await page.getByAltText('Pinecrest logo').waitFor()
    expect(logos.length).toBeGreaterThan(0)
    expect(logos.every((l) => l.url.startsWith(stack.space.base) && l.type === 'image/png')).toBe(true)
    expect(await page.getByAltText('Pinecrest logo').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160)
    await ctx.close()
  }, 60_000)

  test('an envelope: its recipients and its timeline, with the chain intact', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(`/forms/envelopes/${envelope}`))
    await page.getByRole('heading', { name: 'Timeline' }).waitFor()
    await page.getByText(/chain of \d+ events is intact/).waitFor()
    const timeline = await page.locator('section', { has: page.getByRole('heading', { name: 'Timeline' }) }).innerText()
    for (const word of ['sent', 'signed']) expect(timeline.toLowerCase(), word).toContain(word)
    await ctx.close()
  }, 60_000)

  test('Send lists everything not to send, in full, before anything goes out', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at('/forms/send'))
    const warning = page.getByTestId('send-warning')
    await warning.waitFor()
    const text = await warning.innerText()
    expect(text).toContain("Do not send these through Northfield Forms without written OK from the client's lawyer:")
    for (let n = 1; n <= 11; n++) expect(text, `(${n})`).toContain(`(${n}) `)
    await ctx.close()
  }, 60_000)

  test('a client is added through Settings’ New Client and then Set up signing, its logo uploaded, and it shows in the list (the one Clients list, C5)', async () => {
    const { ctx, page, errors } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at('/forms'))
    await page.getByRole('link', { name: 'Add a client' }).click()
    // Forms makes no Client of its own: New Client is Settings', and it comes back to Set up signing for the Client it made.
    await page.waitForURL(/\/settings\/clients\/new/)
    await page.getByTestId('field-name').fill('Fresh Start Bakery')
    await page.getByTestId('field-legal-name').fill('Fresh Start Bakery LLC')
    await page.getByTestId('make-client').click()
    await page.waitForURL(/\/forms\/clients\/new\?client=\d+$/)
    await page.getByRole('heading', { name: 'Set up signing for Fresh Start Bakery' }).waitFor()
    await page.getByLabel('Short name').fill(`fresh-${Date.now().toString(36)}`)
    await page.getByLabel('Replies go to').fill('hello@freshstart.example')
    await page.getByRole('button', { name: 'Set up signing' }).click()
    await page.waitForURL(/\/forms\/clients\/[0-9a-f-]{36}$/)
    await page.getByRole('heading', { name: 'Fresh Start Bakery', level: 1 }).waitFor()
    await page.locator('input[type="file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(solidPng(120, 60, [30, 90, 160])) })
    await page.getByAltText('Fresh Start Bakery logo').waitFor()
    await page.getByRole('link', { name: 'Clients' }).first().click()
    await page.getByText('Fresh Start Bakery').waitFor()
    expect(errors).toEqual([])
    await ctx.close()
  }, 90_000)
})

describe('moving around the tab', () => {
  test('a screen’s own links and the rail’s tree move inside the page: the page is not loaded again, and Back works', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at('/forms'))
    await page.getByRole('heading', { name: 'Clients', level: 1 }).waitFor()
    await page.evaluate(() => ((window as unknown as { stays: number }).stays = 1))
    await page.getByRole('link', { name: 'Envelopes' }).first().click()
    await page.getByRole('heading', { name: 'Envelopes', level: 1 }).waitFor()
    expect(page.url()).toBe(at('/forms/envelopes'))
    await page.getByRole('link', { name: /Pinecrest/ }).first().click()
    await page.getByRole('heading', { name: /Pinecrest/, level: 1 }).waitFor()
    expect(page.url()).toMatch(/\/forms\/envelopes\/[0-9a-f-]{36}$/)
    await page.goBack()
    await page.getByRole('heading', { name: 'Envelopes', level: 1 }).waitFor()
    // Over to the Inbox by its tab, and back to a Forms address by Back: still the same page, with the Forms tree again.
    await page.getByRole('link', { name: 'Inbox' }).click()
    await page.waitForURL(/\/inbox$/)
    await page.goBack()
    await page.getByRole('heading', { name: 'Envelopes', level: 1 }).waitFor()
    expect(await page.evaluate(() => (window as unknown as { stays: number }).stays)).toBe(1)
    await ctx.close()
  }, 60_000)

  test('the Forms tab itself is a full page load, so a day’s sign-in is renewed before the screens are drawn', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at('/inbox'))
    await page.getByRole('link', { name: 'Forms', exact: true }).first().waitFor()
    await page.evaluate(() => ((window as unknown as { stays: number }).stays = 1))
    await page.getByRole('link', { name: 'Forms', exact: true }).first().click()
    await page.getByRole('heading', { name: 'Clients', level: 1 }).waitFor()
    expect(await page.evaluate(() => (window as unknown as { stays?: number }).stays)).toBeUndefined()
    await ctx.close()
  }, 60_000)

  test('an address from before the move (the admin’s #/clients/<id> bookmark, kept by the redirect) lands on its screen', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(`/forms#/clients/${clientId}`))
    await page.getByAltText('Pinecrest logo').waitFor()
    expect(page.url()).toBe(at(`/forms/clients/${clientId}`))
    await page.goto(at('/forms#/envelopes?status=completed'))
    await page.getByRole('heading', { name: 'Envelopes', level: 1 }).waitFor()
    expect(page.url()).toBe(at('/forms/envelopes?status=completed'))
    await ctx.close()
  }, 60_000)

  test('an address that is none of the screens says so, and the rest of the tab still works', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at('/forms/nonsense'))
    await page.getByText('There is nothing at this address.').waitFor()
    await page.getByRole('link', { name: 'Back to clients' }).click()
    await page.getByRole('heading', { name: 'Clients', level: 1 }).waitFor()
    await ctx.close()
  }, 60_000)
})

describe('when the Forms sign-in ends under a screen', () => {
  test('a call that finds it gone reloads the page once, to sign in again, and then says so rather than looping', async () => {
    const { ctx, page } = await stack.operator({ viewport: DESKTOP })
    // Access's answer to a call with no session is a redirect to its sign-in, which a fetch cannot follow; here it is the 401 forms' own check gives.
    await ctx.route(/\/forms\/api\//, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) }))
    let navigations = 0
    page.on('request', (r) => r.isNavigationRequest() && r.url() === at('/forms/envelopes') && navigations++)
    await page.goto(at('/forms/envelopes'))
    await page.getByText(/Your sign-in has ended/).waitFor()
    // One page load of its own and one reload to sign in again: the second loss is a sentence, not a third load.
    expect(navigations).toBe(2)
    await page.waitForTimeout(1500)
    expect(navigations).toBe(2)
    await ctx.close()
  }, 60_000)
})
