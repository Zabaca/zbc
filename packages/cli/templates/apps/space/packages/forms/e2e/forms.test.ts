// The form path's customer side in real browsers against the real Worker: a published form is sent (set up over the API; the operator's
// screens, the builder and Send, are the space's end-to-end tests, packages/space/e2e/forms-builder.test.ts); the customer answers on a phone one
// question at a time, changes an answer after seeing the document, and signs; the countersigner fills their line and signs; the finished PDF
// carries the answers and the agreement text word for word and its seal holds. What no bun test can show: the one-question screens, the file
// input, pdf.js drawing the document made from the answers, and the page loading nothing from another site.
//
//   bun test e2e/forms.test.ts     (needs poppler and a Chromium or Chrome; FORMS_E2E_PORT_FORMS names the port, else a free one is used)
//   FORMS_SHOTS=/tmp/shots bun test e2e/forms.test.ts   also writes the screens it passes through
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { PDF } from '@libpdf/core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { solidPng } from '../test/png'
import { hasPoppler, pdfsig } from '../test/render'
import { type E2eBrowser, launchBrowser } from './browser'
import { linkIn, localMail, newestMail } from './local-mail'
import { type Server, startServer } from './server'
import { setUpClient } from './clients'
import { agree, typeName } from './signing-steps'

let server: Server
let browser: E2eBrowser
beforeAll(async () => {
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_FORMS' })
  browser = await launchBrowser()
}, 240_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await server?.kill()
}, 60_000)

const shots = process.env.FORMS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `forms-${name}.png`), fullPage: false }))

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const AGREEMENT = 'We will prepare your 2025 return.\nYou agree to pay our fee of $400, due on delivery.'
let clientId = ''
let envelope = ''
let alice = ''

const admin = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${server.base}/admin/api${path}`, body === undefined ? { method } : json(method, body))
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return JSON.parse(text) as T
}

// The form the builder test in the space builds, as the builder saves it: a second signer after the customer with a line of its own, a condition, a private question,
// an upload and an agreement.
const FORM = {
  title: 'Client intake',
  roles: [
    { name: 'Client', fields: [] },
    { name: 'CPA', fields: [{ label: 'PTIN', required: true }] },
  ],
  questions: [
    { id: 'q1', type: 'short', label: 'Full legal name', required: true },
    { id: 'q2', type: 'yesno', label: 'Do you own a business?', required: true },
    { id: 'q3', type: 'short', label: 'Business name', required: true, show: { match: 'all', rules: [{ question: 'q2', op: 'equals', value: 'yes' }] } },
    { id: 'q4', type: 'tin', label: 'Social Security number', required: true },
    { id: 'q5', type: 'file', label: 'Photo ID', required: true, max: 2, fileKinds: ['jpeg', 'png', 'pdf'] },
    { id: 'q6', type: 'agreement', label: 'Agreement', text: AGREEMENT },
  ],
}

describe('a form is sent', () => {
  test('a published form goes to a customer and a countersigner, and a private question makes the document go by link', async () => {
    clientId = (await setUpClient(server.base, { slug: `forms-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: ['books@pinecrest.example'] })).id
    await fetch(`${server.base}/admin/api/clients/${clientId}/logo`, { method: 'PUT', body: solidPng(160, 60, [240, 240, 240]) as BodyInit })
    const made = await admin<{ form: { id: string } }>('POST', '/forms', { client_id: clientId, title: 'Client intake' })
    await admin('PUT', `/forms/${made.form.id}/draft`, { definition: FORM })
    const published = await admin<{ versions: { id: string }[] }>('POST', `/forms/${made.form.id}/publish`, {})
    const forms = await admin<{ published: { version: number; roles: string[]; sensitive: boolean; questions: number } | null }[]>('GET', `/forms?client=${clientId}`)
    expect(forms[0]!.published).toMatchObject({ version: 1, roles: ['Client', 'CPA'], sensitive: true, questions: 6 })

    const draft = await admin<{ envelope: { id: string } }>('POST', '/envelopes', {
      client_id: clientId,
      source: { type: 'form', form_version_id: published.versions[0]!.id },
      sensitive: true,
      order: 'sequential',
      recipients: [
        { role: 'Client', name: 'Alice Example', email: 'alice@example.test' },
        { role: 'CPA', name: 'Bob Preparer', email: 'bob@example.test' },
      ],
    })
    envelope = draft.envelope.id
    await admin('POST', `/envelopes/${envelope}/send`, {})
    const mail = newestMail()
    expect(mail.text).toContain('Client intake')
    alice = linkIn(server.base, mail.text)
  }, 120_000)
})

async function phone(link: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const outside: string[] = []
  ctx.on('request', (r) => {
    if (!r.url().startsWith(server.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(link)
  return { page, ctx, outside, errors }
}

const next = (page: Page, name = 'Next') => page.getByRole('button', { name, exact: true }).click()

describe('the customer answers and signs', () => {
  test('one question at a time, a condition, a private number, an upload, an agreement, then the document made from the answers', async () => {
    const { page, ctx, outside, errors } = await phone(alice)
    await page.getByRole('heading', { name: /sent you .* to sign/ }).waitFor({ timeout: 30_000 })
    await agree(page)

    await page.getByRole('heading', { name: 'Full legal name' }).waitFor()
    await page.getByText('1 of 5').waitFor()
    await shot(page, '5-first-question')
    // A required question will not let them pass empty.
    await next(page)
    await page.getByRole('alert').getByText('This question needs an answer.').waitFor()
    await page.getByRole('textbox', { name: 'Full legal name' }).fill('陈大文')
    await next(page)
    await page.getByRole('alert').getByText(/Chinese, Japanese and Korean letters cannot be printed/).waitFor()
    await page.getByRole('textbox', { name: 'Full legal name' }).fill('Alice Example')
    await next(page)

    await page.getByRole('heading', { name: 'Do you own a business?' }).waitFor()
    // Answering "yes" brings in a question that was not there.
    await page.getByText('Yes', { exact: true }).click()
    await next(page)
    await page.getByRole('heading', { name: 'Business name' }).waitFor()
    await page.getByText('3 of 6').waitFor()
    await page.getByRole('textbox', { name: 'Business name' }).fill("Alice's Bakery")
    await next(page)

    await page.getByRole('heading', { name: 'Social Security number' }).waitFor()
    await page.getByRole('textbox', { name: 'Social Security number' }).fill('123')
    await next(page)
    await page.getByRole('alert').getByText(/nine digits/).waitFor()
    await page.getByRole('textbox', { name: 'Social Security number' }).fill('123-45-6789')
    await next(page)

    await page.getByRole('heading', { name: 'Photo ID' }).waitFor()
    await page.getByLabel('Choose a file for Photo ID').setInputFiles({ name: 'id front.png', mimeType: 'image/png', buffer: Buffer.from(solidPng(80, 50, [10, 120, 80])) })
    await page.getByText('id front.png').waitFor()
    await shot(page, '6-upload')
    await next(page)

    await page.getByRole('heading', { name: 'Agreement' }).waitFor()
    await next(page, 'Review')
    await page.getByRole('alert').getByText(/Check the box to agree/).waitFor()
    await page.getByLabel('I agree').check()
    await next(page, 'Review')

    await page.getByRole('heading', { name: 'Check your answers' }).waitFor()
    // A private answer is masked even on the customer's own review.
    expect(await page.getByText('123-45-6789').count()).toBe(0)
    await shot(page, '7-review')
    await page.getByRole('button', { name: 'See my document' }).click()

    // The document made from the answers: pdf.js draws it and the filler's own signature fields sit on it.
    await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null
      return !!c && c.width > 0
    })
    await shot(page, '8-document')
    expect(outside).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }, 120_000)

  test('they can come back, see the saved answers, change one, and the document is made again', async () => {
    const { page, ctx } = await phone(alice)
    await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Change an answer' }).click()
    await page.getByRole('heading', { name: 'Check your answers' }).waitFor()
    await page.getByRole('button', { name: 'Change: Full legal name' }).click()
    await page.getByRole('textbox', { name: 'Full legal name' }).fill('Alice B. Example')
    await next(page)
    // The next question is the next one shown, not the next one in the definition.
    await page.getByRole('heading', { name: 'Do you own a business?' }).waitFor()
    await page.getByRole('button', { name: 'Back' }).click()
    await next(page)
    await next(page)
    await next(page)
    await next(page)
    await next(page)
    await next(page, 'Review')
    await page.getByRole('heading', { name: 'Check your answers' }).waitFor()
    await page.getByRole('button', { name: 'Make my document again' }).click()
    await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
    await ctx.close()
    const events = (await (await fetch(`${server.base}/admin/api/envelopes/${envelope}`)).json()) as { events: { action: string }[] }
    expect(events.events.filter((e) => e.action === 'prepared')).toHaveLength(2)
  }, 120_000)

  test('they sign, the countersigner fills the line the form gave them and signs, and the finished document holds it all', async () => {
    const sign = async (link: string, line?: { name: RegExp; value: string }) => {
      const { page, ctx, outside, errors } = await phone(link)
      await page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Start' }).click()
      await page.getByRole('button', { name: /^Signature, required/ }).click()
      await typeName(page, 'Alice Example')
      await page.getByRole('button', { name: 'Use this signature' }).click()
      await page.getByRole('button', { name: /^Signature, done/ }).waitFor()
      if (line) {
        await page.getByRole('button', { name: line.name }).click()
        await page.getByRole('textbox', { name: 'PTIN' }).fill(line.value)
        await page.getByRole('button', { name: 'Save' }).click()
      }
      await page.getByText('All done').first().waitFor()
      await page.getByRole('button', { name: 'Finish' }).click()
      await page.getByRole('button', { name: 'Finish and sign' }).click()
      return { page, ctx, outside, errors }
    }
    // The filler opens the link again: consent is remembered, the document is there.
    const a = await sign(alice)
    await a.page.getByRole('heading', { name: 'Thank you, you have signed' }).waitFor({ timeout: 30_000 })
    // Signed, so the answers are closed.
    expect(await a.page.getByRole('button', { name: 'Change an answer' }).count()).toBe(0)
    expect(a.errors).toEqual([])
    await a.ctx.close()

    const mail = newestMail()
    expect(mail.text).toContain('It is your turn to sign')
    const bobLink = linkIn(server.base, mail.text)
    const b = await phone(bobLink)
    await b.page.getByRole('heading', { name: /sent you .* to sign/ }).waitFor({ timeout: 30_000 })
    await agree(b.page)
    await b.page.getByRole('button', { name: /^Signature, required/ }).waitFor({ timeout: 30_000 })
    // The countersigner reads the document the customer's answers made, not a form to fill.
    expect(await b.page.getByRole('button', { name: 'Change an answer' }).count()).toBe(0)
    await b.page.getByRole('button', { name: 'Start' }).click()
    await b.page.getByRole('button', { name: /^Signature, required/ }).click()
    await typeName(b.page, 'Bob Preparer')
    await b.page.getByRole('button', { name: 'Use this signature' }).click()
    await b.page.getByRole('button', { name: /^PTIN, required/ }).click()
    await b.page.getByRole('textbox', { name: 'PTIN' }).fill('P01234567')
    await b.page.getByRole('button', { name: 'Save' }).click()
    await b.page.getByText('All done').first().waitFor()
    await shot(b.page, '9-countersign')
    await b.page.getByRole('button', { name: 'Finish' }).click()
    await b.page.getByRole('button', { name: 'Finish and sign' }).click()
    await b.page.getByRole('heading', { name: 'All done' }).waitFor({ timeout: 60_000 })
    expect(b.outside).toEqual([])
    expect(b.errors).toEqual([])
    await b.ctx.close()

    // A private question: the finished document is a link, not an attachment, and what it holds is word for word.
    const res = await fetch(`${bobLink.replace('/s/', '/s/api/s/')}/download`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const pdf = await PDF.load(bytes)
    const text = pdf.getPages().map((p) => p.extractText().text).join('\n')
    for (const must of ['Client intake', 'Alice B. Example', "Alice's Bakery", '123-45-6789', 'We will prepare your 2025 return.', 'You agree to pay our fee of $400, due on delivery.', 'id front.png', 'P01234567', 'Certificate of completion']) expect(text, must).toContain(must)
    if (hasPoppler) {
      const sig = pdfsig(bytes)
      expect(sig.valid, `${sig.raw}\n${sig.diagnostics}`).toBe(true)
      expect(sig.coversWholeFile, sig.diagnostics).toBe(true)
    }
    const view = (await (await fetch(`${server.base}/admin/api/envelopes/${envelope}`)).json()) as { envelope: { status: string }; chain: { ok: boolean }; events: { action: string }[] }
    expect(view.envelope.status).toBe('completed')
    expect(view.chain.ok).toBe(true)
  }, 240_000)
})

describe('the client\'s copy address gets the customer\'s files', () => {
  test('its email carries a link and a count only; the page behind it lists the file, downloads it, and the download is on the timeline', async () => {
    const books = localMail().filter((m) => m.text.startsWith('Hello books@pinecrest.example,') && m.text.includes('Everyone has signed')).at(-1)
    expect(books, 'the copy address was emailed').toBeTruthy()
    expect(books!.text).toContain('The same page lists the file the customer uploaded.')
    expect(books!.text + books!.html).not.toContain('id front')
    const link = linkIn(server.base, books!.text)
    const { page, ctx, outside, errors } = await phone(link)
    await page.getByRole('heading', { name: 'All done' }).waitFor({ timeout: 30_000 })
    await page.getByRole('heading', { name: 'Files the customer uploaded' }).waitFor()
    await page.getByText('id front.png (1 KB)').waitFor()
    await shot(page, '11-copy-files')
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download id front.png' }).click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('id front.png')
    expect(outside).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
    const view = (await (await fetch(`${server.base}/admin/api/envelopes/${envelope}`)).json()) as { events: { action: string; actor_email: string | null; details: Record<string, unknown> }[] }
    const mine = view.events.filter((e) => e.action === 'copy-downloaded' && e.actor_email === 'books@pinecrest.example')
    expect(mine).toHaveLength(1)
    expect(Object.keys(mine[0]!.details).sort()).toEqual(['recipient_id', 'sha256', 'upload_id'])
    // The customer's own link shows no files, and lists none.
    const hers = await fetch(`${alice.replace('/s/', '/s/api/s/')}/uploads`)
    expect((await hers.json()) as unknown).toEqual({ files: [] })
  }, 120_000)
})
