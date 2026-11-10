// Documents in a conversation, in a real browser over the real forms Worker (workerd, a local D1 and R2) behind the space's production bundle: the one
// session the testing decisions describe. An operator opens Dana's conversation, presses Send for signature, lands on Forms' Send screen with
// Dana already the signer, makes the draft and sends it, sees its card in Dana's conversation (and in nobody else's), and when Dana signs sees the same card say the
// signed copy is back.
//
// The conversation is the space's fixtures' (invented people, src/stand-ins.ts); the document is forms' real one: made by forms' own Send, stored in its real
// store with the conversation it carries, and read back through forms' operator API for the card (the stand-in's `documentsIn` asks the real forms: stand-ins.ts,
// `withFormsAt`). The signer's side is the signer's API, called as the signer's page does. forms' own queries (`documentsIn`) are proved against its store in
// packages/forms/test/space-reads.test.ts.
//
//   bun test e2e/documents-in-conversation.test.ts   (needs a Chromium or Chrome; SPACE_E2E_PORT_FORMS and SPACE_E2E_PORT_SPACE name the ports, else free ones are used)
//   CARD_SHOTS=/tmp/shots bun test e2e/documents-in-conversation.test.ts   also writes each state at 1440px and 390px
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { linkFor } from '@space/forms/e2e/local-mail'
import { solidPng } from '@space/forms/test/png'
import { type Stack, startStack } from './stack'

let stack: Stack
beforeAll(async () => {
  stack = await startStack({ forms: 'SPACE_E2E_PORT_FORMS', space: 'SPACE_E2E_PORT_SPACE' })
}, 300_000)
setDefaultTimeout(120_000)
afterEach(() => stack?.browser.closeContexts(), 60_000)
afterAll(() => stack?.stop(), 90_000)

const shots = process.env.CARD_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const at = (path: string) => `${stack.space.base}${path}`
const DANA = '/inbox/dana%40harbordental.example'
const MARCUS = '/inbox/marcus%40harbordental.example'

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main.main') as HTMLElement
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= window.innerWidth
  })

/** The same page on a phone, photographed (and checked to fit), for the states that matter. */
async function onPhone(path: string, name: string, ready: string) {
  const { page, errors } = await stack.operator({ viewport: PHONE })
  await page.goto(at(path))
  await page.waitForSelector(ready, { timeout: 30_000 })
  expect(await fits(page)).toBe(true)
  if (shots) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${shots}/${name}-390.png` })
  }
  expect(errors).toEqual([])
}

async function shot(page: Page, name: string) {
  if (!shots) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${shots}/${name}-1440.png` })
}

const signer = (token: string) => async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${stack.forms.base}/s/api/s/${token}${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

let clientId = ''
let envelopeId = ''

describe('send a document from a conversation and see the signed copy come back', () => {
  test('forms has a client to send for, and Dana’s conversation has no card yet and offers Send for signature', async () => {
    clientId = (await stack.setUpClient({ slug: `conv-${Date.now().toString(36)}`, display_name: 'Harbor Dental', legal_name: 'Harbor Dental Group', reply_to: 'office@harbordental.example', accent_color: '#1f6f8b', copy_addresses: [] })).id
    expect((await fetch(`${stack.forms.base}/admin/api/clients/${clientId}/logo`, { method: 'PUT', body: solidPng(160, 60, [210, 150, 60]) as BodyInit })).status).toBe(200)

    const { page, errors } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(DANA))
    await page.waitForSelector('[data-testid="conversation"]')
    expect(await page.locator('[data-testid="document-card"]').count()).toBe(0)
    // No line about forms: it answered, with nothing for this conversation yet.
    expect(await page.locator('[data-part="documents"]').count()).toBe(0)
    expect(await page.locator('[data-testid="send-for-signature"]').getAttribute('href')).toBe('/forms/send?from=dana%40harbordental.example')
    expect(await fits(page)).toBe(true)
    expect(errors).toEqual([])
    await shot(page, 'card-0-send-button')
    await onPhone(DANA, 'card-0-send-button', '[data-testid="send-for-signature"]')
  })

  test('Send for signature opens Forms’ Send screen with Dana as the signer, and a draft made there carries the conversation', async () => {
    const { page, errors } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(DANA))
    await page.waitForSelector('[data-testid="send-for-signature"]')
    await page.click('[data-testid="send-for-signature"]')
    await page.waitForURL(/\/forms\/send\?from=/)
    const banner = page.locator('[data-testid="send-from"]')
    await banner.waitFor()
    expect(await banner.textContent()).toContain('From your conversation with Dana Reyes')
    expect(await page.inputValue('#name-0')).toBe('Dana Reyes')
    expect(await page.inputValue('#email-0')).toBe('dana@harbordental.example')
    expect(await page.locator('[id^="name-"]').count()).toBe(1)
    await shot(page, 'card-1-send-screen')
    await onPhone('/forms/send?from=dana%40harbordental.example', 'card-1-send-screen', '[data-testid="send-from"]')

    await page.getByRole('button', { name: 'Review the email' }).click()
    await page.waitForURL(/\/forms\/envelopes\/[0-9a-f-]{36}$/)
    envelopeId = /\/forms\/envelopes\/([0-9a-f-]{36})$/.exec(page.url())![1]!
    // Forms' own record: the draft carries the conversation, and it is a draft: nothing was emailed.
    const made = await stack.api<{ envelope: { status: string; conversation_app: string; conversation_id: string } }>('GET', `/envelopes/${envelopeId}`)
    expect(made.envelope).toMatchObject({ status: 'draft', conversation_app: 'inbox', conversation_id: 'c-dana' })
    expect(() => linkFor(stack.forms.base, 'Dana Reyes')).toThrow()
    expect(errors).toEqual([])
  })

  test('a draft is already a card in Dana’s conversation, with a way into Forms to finish it', async () => {
    const { page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(DANA))
    const card = page.locator('[data-testid="document-card"]')
    await card.waitFor()
    expect(await card.getAttribute('data-state')).toBe('draft')
    expect(await card.locator('[data-testid="document-open"]').getAttribute('href')).toBe(`/forms/envelopes/${envelopeId}`)
  })

  test('sent from Forms’ Send, it is a card that says it is out for signature, in Dana’s conversation and in no one else’s', async () => {
    const { page, errors } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(`/forms/envelopes/${envelopeId}`))
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('button', { name: 'Yes, send it now' }).click()
    await page.getByText('Sent', { exact: true }).first().waitFor()
    // The only mail is Forms' own signing email to Dana: nothing went into the conversation.
    expect(linkFor(stack.forms.base, 'Dana Reyes')).toContain('/s/')

    await page.goto(at(DANA))
    const card = page.locator('[data-testid="document-card"]')
    await card.waitFor()
    expect(await card.getAttribute('data-state')).toBe('sent')
    expect(await card.locator('[data-testid="document-state"]').textContent()).toContain('Out for signature, 0 of 1 signed')
    expect(await card.locator('[data-testid="document-title"]').textContent()).not.toBe('')
    expect(await page.locator('[data-testid="document-back"]').count()).toBe(0)
    expect(await fits(page)).toBe(true)
    await shot(page, 'card-2-sent')
    await onPhone(DANA, 'card-2-sent', '[data-testid="document-card"]')

    // Not in Marcus's conversation (the same Client, a document to Dana), and not in the team's.
    await page.goto(at(MARCUS))
    await page.waitForSelector('[data-testid="conversation"]')
    expect(await page.locator('[data-testid="document-card"]').count()).toBe(0)
    await page.goto(at('/meet/priya%40northfield.example'))
    await page.waitForSelector('[data-testid="conversation"]')
    expect(await page.locator('[data-testid="document-card"]').count()).toBe(0)
    expect(errors).toEqual([])
  })

  test('a document sent from Forms to Dana, with no conversation, is not a card in her conversation', async () => {
    await stack.api('POST', '/envelopes', { client_id: clientId, source: { type: 'sample' }, title: 'Sent from Forms', recipients: [{ role: 'Client', name: 'Dana Reyes', email: 'dana@harbordental.example' }] })
    const { page } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(DANA))
    await page.waitForSelector('[data-testid="document-card"]')
    expect(await page.locator('[data-testid="document-card"]').count()).toBe(1)
    expect(await page.locator('[data-testid="document-card"]').textContent()).not.toContain('Sent from Forms')
  })

  test('when Dana signs, the same card says the signed copy is back, and opens it in Forms', async () => {
    const s = signer(linkFor(stack.forms.base, 'Dana Reyes').split('/s/')[1]!)
    await s('POST', '/open')
    await s('POST', '/consent')
    const view = (await s('GET', '')).body
    const png = Buffer.from(solidPng(60, 24, [20, 30, 120])).toString('base64')
    await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: png })
    await s('POST', '/adopt', { kind: 'initials', method: 'drawn', image: png })
    for (const f of view.fields) {
      const value = f.type === 'signature' || f.type === 'initials' ? 'adopted' : f.type === 'text' ? 'Dana Reyes' : f.type === 'checkbox' ? true : undefined
      if (value !== undefined) await s('PUT', `/fields/${f.id}`, { value })
    }
    expect((await s('POST', '/finish', { intent: true })).status).toBe(200)

    const { page, errors } = await stack.operator({ viewport: DESKTOP })
    await page.goto(at(DANA))
    const card = page.locator('[data-testid="document-card"][data-state="completed"]')
    await card.waitFor({ timeout: 30_000 })
    expect(await card.locator('[data-testid="document-back"]').textContent()).toContain('The signed copy is back')
    expect(await card.locator('[data-testid="document-state"]').textContent()).toContain('Signed and back')
    expect(await card.locator('[data-testid="document-open"]').getAttribute('href')).toBe(`/forms/envelopes/${envelopeId}`)
    expect(await fits(page)).toBe(true)
    await shot(page, 'card-3-signed')
    await onPhone(DANA, 'card-3-signed', '[data-testid="document-back"]')

    // The card opens the document in Forms (a full load of the tab, which renews its sign-in).
    await card.locator('[data-testid="document-open"]').click()
    await page.waitForURL(new RegExp(`/forms/envelopes/${envelopeId}$`))
    await page.getByText('completed', { exact: false }).first().waitFor()
    expect(errors).toEqual([])
  })
})
