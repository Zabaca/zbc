// A real browser signs a real envelope in the real Worker: the sample is sent to two people in order through the admin
// API, each opens the link Cloudflare's mail binding was handed (workerd's local binding writes the message to a file),
// agrees to sign electronically, adopts a signature and initials, fills a line and a checkbox, finishes, and the second
// sees what the first signed. What no bun test can show: pdf.js drawing the pages, the overlays sitting on the right
// place, the dialogs, signature_pad, the script font, and the signer's page loading nothing from another site.
//
//   bun test e2e/signer.test.ts     (needs poppler and a Chromium or Chrome; FORMS_E2E_PORT_SIGNER names the port, else a free one is used)
//   FORMS_SHOTS=/tmp/shots bun test e2e/signer.test.ts   also writes the screens it passes through
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { PDF } from '@libpdf/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { solidPng } from '../test/png'
import { hasPoppler, pdfsig } from '../test/render'
import { type E2eBrowser, launchBrowser } from './browser'
import { linkIn, newestMail } from './local-mail'
import { agree, typeName } from './signing-steps'
import { setUpClient } from './clients'
import { type Server, startServer } from './server'

let server: Server
let browser: E2eBrowser
beforeAll(async () => {
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_SIGNER' })
  browser = await launchBrowser()
}, 240_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await server?.kill()
}, 60_000)

const shots = process.env.FORMS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }))

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const link = (text: string) => linkIn(server.base, text)

async function signInBrowser(link: string, name: string, tag: string, opts: { second?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const outside: string[] = []
  ctx.on('request', (r) => {
    if (!r.url().startsWith(server.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const response = await page.goto(link)
  // The page may load nothing from another site and send no referrer: the headers say so, and the flow below runs under them.
  expect(response!.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response!.headers()['referrer-policy']).toBe('no-referrer')
  await page.getByRole('heading', { name: /sent you .* to sign/ }).waitFor({ timeout: 30_000 })
  await shot(page, `${tag}-1-consent`)
  await agree(page)
  await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
  // pdf.js has drawn the first page: the canvas holds pixels that are not all white.
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!c || c.width === 0) return false
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, Math.min(c.height, 200)).data
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 200) return true
    return false
  }, null, { timeout: 30_000 })
  await shot(page, `${tag}-2-document`)
  if (opts.second) expect(await page.locator('img[alt="Signed by an earlier signer"]').count()).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Start' }).click()
  expect(await page.getByText(/^0 of 4$/).count()).toBe(1)

  await page.getByRole('button', { name: /^Signature, required/ }).click()
  await typeName(page, name)
  await shot(page, `${tag}-3-adopt`)
  await page.getByRole('button', { name: 'Use this signature' }).click()
  await page.getByRole('button', { name: /^Signature, done/ }).waitFor()
  await page.getByRole('button', { name: /^Initials, required/ }).click()
  await page.getByRole('tab', { name: 'Draw' }).click()
  const pad = page.getByLabel('Draw your initials here')
  const box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + 100, { steps: 8 })
  await page.mouse.move(box.x + 130, box.y + 50, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Use this initials' }).click()
  await page.getByRole('button', { name: /^Initials, done/ }).waitFor()
  await page.getByRole('button', { name: /^Printed name, required/ }).click()
  await page.getByRole('textbox', { name: 'Printed name' }).fill(name)
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: /^Printed name, done/ }).waitFor()
  await page.getByRole('button', { name: /^I have read this sample, required/ }).click()
  await page.getByRole('button', { name: /^I have read this sample, done/ }).waitFor()
  expect(await page.getByText('All done').count()).toBeGreaterThan(0)
  await shot(page, `${tag}-4-filled`)
  await page.getByRole('button', { name: 'Finish' }).click()
  await shot(page, `${tag}-5-confirm`)
  await page.getByRole('button', { name: 'Finish and sign' }).click()
  return { page, ctx, outside, errors }
}

describe('a whole signing in a browser', () => {
  let alice = ''
  let envelope = ''
  test('the sample goes to two people in order, and the first signs on a phone', async () => {
    const made = await setUpClient(server.base, { slug: `browser-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })
    await fetch(`${server.base}/admin/api/clients/${made.id}/logo`, { method: 'PUT', body: solidPng(160, 60, [240, 240, 240]) as BodyInit })
    const draft = (await (await fetch(`${server.base}/admin/api/envelopes`, json('POST', { client_id: made.id, source: { type: 'sample' }, order: 'sequential', note: 'Please sign this sample.', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }, { role: 'CPA', name: 'Bob Preparer', email: 'bob@example.test' }] }))).json()) as { envelope: { id: string } }
    envelope = draft.envelope.id
    await fetch(`${server.base}/admin/api/envelopes/${envelope}/send`, json('POST', {}))
    const mail = newestMail()
    expect(mail.text).toContain('Please sign this sample.')
    // The email in a browser: the client's name, the button, no remote image beyond its own logo.
    expect(mail.html).toContain('Review and sign')
    alice = link(mail.text)

    const { page, ctx, outside, errors } = await signInBrowser(alice, 'Alice Example', 'alice')
    await page.getByRole('heading', { name: 'Thank you, you have signed' }).waitFor({ timeout: 30_000 })
    await shot(page, 'alice-6-signed')
    // The signer's page loaded nothing from any other site and threw nothing.
    expect(outside).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }, 120_000)

  test('the second signer is emailed when it is their turn, sees what the first signed, and finishes the envelope', async () => {
    const mail = newestMail()
    expect(mail.text).toContain('It is your turn to sign')
    const bob = link(mail.text)
    expect(bob).not.toBe(alice)
    const { page, ctx, outside, errors } = await signInBrowser(bob, 'Bob Preparer', 'bob', { second: true })
    await page.getByRole('heading', { name: 'All done' }).waitFor({ timeout: 60_000 })
    await shot(page, 'bob-6-done')
    expect(await page.getByRole('link', { name: 'Download the finished document' }).count()).toBe(1)
    expect(outside).toEqual([])
    expect(errors).toEqual([])
    // The certificate is a page behind the link too.
    await page.getByRole('button', { name: 'See the certificate of completion' }).click()
    await page.getByText('Alice Example (Client)').waitFor()
    await ctx.close()

    // The finished document, downloaded through Bob's link, is sealed over the whole file and carries both names.
    const res = await fetch(`${bob.replace('/s/', '/s/api/s/')}/download`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const pdf = await PDF.load(bytes)
    const text = pdf.getPages().map((p) => p.extractText().text).join('\n')
    expect(text).toContain('Alice Example')
    expect(text).toContain('Bob Preparer')
    expect(text).toContain('Certificate of completion')
    // The certificate prints the consent text each signer agreed to, with its version.
    expect(text).toContain('The consent text, version')
    expect(text).toContain('Open this sample PDF')
    if (hasPoppler) {
      const sig = pdfsig(bytes)
      expect(sig.valid, `${sig.raw}\n${sig.diagnostics}`).toBe(true)
      expect(sig.coversWholeFile, sig.diagnostics).toBe(true)
    }
    // And the operator sees a finished envelope with its chain intact.
    const view = (await (await fetch(`${server.base}/admin/api/envelopes/${envelope}`)).json()) as { envelope: { status: string }; chain: { ok: boolean }; events: { action: string }[] }
    expect(view.envelope.status).toBe('completed')
    expect(view.chain.ok).toBe(true)
    expect(view.events.filter((e) => e.action === 'completed')).toHaveLength(1)
  }, 180_000)
})

describe('the wording the legal gate changed, as a browser shows it', () => {
  async function sentSample(extra: Record<string, unknown> = {}) {
    const made = await setUpClient(server.base, { slug: `gate-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })
    const draft = (await (await fetch(`${server.base}/admin/api/envelopes`, json('POST', { client_id: made.id, source: { type: 'sample' }, order: 'sequential', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }], ...extra }))).json()) as { envelope: { id: string } }
    await fetch(`${server.base}/admin/api/envelopes/${draft.envelope.id}/send`, json('POST', {}))
    return newestMail()
  }

  test('the privacy notice names Cloudflare and Claude, the certificate, private numbers, Do Not Track, changes, and a mailbox that exists', async () => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${server.base}/privacy`)
    await page.getByRole('heading', { name: 'Privacy notice' }).waitFor()
    const text = await page.locator('main').innerText()
    for (const s of ['Cloudflare', 'Claude, an AI assistant made by Anthropic', 'Today Claude has no access to this service', 'Northfield Works does not let Claude read answers, uploaded files, private numbers or finished signed documents', 'This notice will be changed before Claude is given any access', 'The certificate in the finished document', 'Private numbers', 'Do Not Track', 'Changes to this notice', 'or longer if the law or a legal claim requires it', 'info@northfield.example']) expect(text, s).toContain(s)
    expect(text).not.toContain('forms@northfield.example')
    expect(text).not.toContain('\u2014')
    await ctx.close()
  }, 60_000)

  test('the decline dialog says it ends it for everyone and that the reason is seen', async () => {
    const mail = await sentSample()
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await ctx.newPage()
    await page.goto(link(mail.text))
    await page.getByRole('heading', { name: /sent you .* to sign/ }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Decline' }).click()
    await page.getByText('This ends it for everyone. The business, and anyone who already signed, will be told that you declined, and will see the reason if you give one.').waitFor()
    await page.getByRole('button', { name: 'Go back' }).click()
    await ctx.close()
  }, 60_000)

  test('a typed-name-only envelope offers only a blank typed field for the signature', async () => {
    const mail = await sentSample({ typed_only: true })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    await page.goto(link(mail.text))
    await page.getByRole('heading', { name: /sent you .* to sign/ }).waitFor({ timeout: 30_000 })
    await agree(page)
    await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Start' }).click()
    await page.getByRole('button', { name: /^Signature, required/ }).click()
    expect(await page.getByRole('tab', { name: 'Draw' }).count()).toBe(0)
    expect(await page.getByRole('tab', { name: 'Upload' }).count()).toBe(0)
    expect(await page.getByLabel('Your full name').inputValue()).toBe('')
    await page.getByRole('button', { name: 'Use this signature' }).click()
    await page.getByRole('alert').getByText('Type your name first.').waitFor()
    await ctx.close()
  }, 60_000)
})
