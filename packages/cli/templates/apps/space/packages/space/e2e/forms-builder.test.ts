// The form path's operator screens in the space (they were forms' own admin's, and the same steps): the operator builds a form on a desktop
// screen (questions of several types, a condition, a private question, an upload, an agreement, a second signer with a line of its own),
// publishes it, sends it from the Send screen, and later reads what the customer answered. What no bun test can show: the builder's controls, the
// live preview that is the customer's own screen, and the answers screen masking a private number until it is revealed on the record.
//
// The customer's side (answering one question at a time on a phone, signing, the finished PDF) is forms' own end-to-end test in
// packages/forms/e2e/forms.test.ts: forms owns the signer's pages. Here the customer answers over the signer's API, which is all the answers screen needs.
//
//   bun test e2e/forms-builder.test.ts     (needs a Chromium or Chrome; SPACE_E2E_PORT_FORMS and SPACE_E2E_PORT_SPACE name the ports, else free ones are used)
//   FORMS_SHOTS=/tmp/shots bun test e2e/forms-builder.test.ts   also writes the screens it passes through
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
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
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `forms-${name}.png`), fullPage: false }))
const at = (path: string) => `${stack.space.base}${path}`

const AGREEMENT = 'We will prepare your 2025 return.\nYou agree to pay our fee of $400, due on delivery.'
let clientId = ''
let envelope = ''

describe('the operator builds, publishes and sends a form', () => {
  test('the builder: questions of several types, a condition, a second signer with a line of its own, a live preview, publish', async () => {
    clientId = (await stack.setUpClient({ slug: `forms-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: ['books@pinecrest.example'] })).id
    await fetch(`${stack.forms.base}/admin/api/clients/${clientId}/logo`, { method: 'PUT', body: solidPng(160, 60, [240, 240, 240]) as BodyInit })

    const { page, errors } = await stack.operator({ viewport: { width: 1440, height: 900 } })
    await page.goto(at('/forms/forms'))
    await page.getByLabel('Title').fill('Client intake')
    await page.getByRole('button', { name: 'Build it' }).click()
    await page.getByRole('heading', { name: 'Client intake' }).waitFor()
    expect(page.url()).toMatch(/\/forms\/forms\/[0-9a-f-]{36}$/)
    await shot(page, 'builder-empty')

    // A second signer after the customer, with a line of its own.
    await page.getByRole('button', { name: 'Add a signer after them' }).click()
    await page.getByLabel("Signer 2's role").fill('CPA')
    await page.getByRole('button', { name: 'Add a line for CPA to fill' }).click()
    await page.getByLabel('Role 2, line 1', { exact: true }).fill('PTIN')

    const add = async (type: string) => {
      await page.getByLabel('Type of the next question').selectOption({ label: type })
      await page.getByRole('button', { name: 'Add a question' }).click()
    }
    await add('Short text')
    await page.getByLabel('Question 1: the question').fill('Full legal name')
    await add('Yes or no')
    await page.getByLabel('Question 2: the question').fill('Do you own a business?')
    await add('Short text')
    await page.getByLabel('Question 3: the question').fill('Business name')
    // Show it only when the answer to question 2 is yes.
    await page.getByLabel('Question 3', { exact: true }).getByRole('button', { name: 'Only show this question in some cases' }).click()
    await page.getByLabel('Condition 1: question').selectOption({ label: 'Do you own a business?' })
    await page.getByLabel('Condition 1: test').selectOption({ label: 'is' })
    await page.getByLabel('Condition 1: value').selectOption('yes')
    await add('Social Security or tax ID number')
    await page.getByLabel('Question 4: the question').fill('Social Security number')
    await add('File upload')
    await page.getByLabel('Question 5: the question').fill('Photo ID')
    await page.getByLabel('Question 5: most files').fill('2')
    await add('Agreement text with an "I agree" box')
    await page.getByLabel('Question 6: text').fill(AGREEMENT)
    await shot(page, 'builder-filled')

    // The preview is the customer's own screen: the first question, and the condition hides question 3 until it is "yes".
    const preview = page.getByLabel('Preview')
    await preview.getByRole('heading', { name: 'Full legal name' }).waitFor()
    await preview.getByRole('textbox', { name: 'Full legal name' }).fill('Preview Person')
    await preview.getByRole('button', { name: 'Next' }).click()
    await preview.getByText('Yes').click()
    await preview.getByRole('button', { name: 'Next' }).click()
    await preview.getByRole('heading', { name: 'Business name' }).waitFor()
    await shot(page, 'builder-preview')

    await page.getByRole('button', { name: 'Save draft' }).click()
    await page.getByText('Draft saved.').waitFor()
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByRole('button', { name: 'Yes, publish it' }).click()
    await page.getByText(/^Published\./).waitFor()
    expect(errors).toEqual([])

    const forms = await stack.api<{ title: string; published: { version: number; roles: string[]; sensitive: boolean; questions: number } | null }[]>('GET', `/forms?client=${clientId}`)
    expect(forms).toHaveLength(1)
    expect(forms[0]!.published).toMatchObject({ version: 1, roles: ['Client', 'CPA'], sensitive: true, questions: 6 })
  }, 120_000)

  test('Send offers the form, pins its version, and a private question makes the document go by link', async () => {
    const { page, errors } = await stack.operator({ viewport: { width: 1440, height: 900 } })
    await page.goto(at(`/forms/send?client=${clientId}`))
    await page.getByRole('radio', { name: /A form/ }).check()
    await page.getByLabel('Which form').selectOption({ index: 1 })
    await page.getByText(/It asks for private information/).waitFor()
    await page.locator('#name-0').fill('Alice Example')
    await page.locator('#email-0').fill('alice@example.test')
    await page.locator('#name-1').fill('Bob Preparer')
    await page.locator('#email-1').fill('bob@example.test')
    await shot(page, 'send')
    await page.getByRole('button', { name: 'Review the email' }).click()
    await page.getByRole('heading', { name: 'Client intake' }).waitFor()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByRole('button', { name: 'Yes, send it now' }).click()
    await page.getByText('Sent', { exact: true }).waitFor()
    envelope = page.url().split('/envelopes/')[1]!.split(/[?#]/)[0]!
    expect(envelope).toHaveLength(36)
    expect(errors).toEqual([])
  }, 120_000)
})

describe('the operator reads what was answered', () => {
  test('the customer answers over the signer’s API', async () => {
    const token = linkFor(stack.forms.base, 'Alice Example').split('/s/')[1]!
    const s = async (method: string, path: string, body?: unknown, init: RequestInit = {}) => fetch(`${stack.forms.base}/s/api/s/${token}${path}`, body === undefined ? { method, ...init } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await s('POST', '/open')).status).toBe(200)
    expect((await s('POST', '/consent')).status).toBe(200)
    for (const [q, value] of Object.entries({ q1: 'Alice B. Example', q2: true, q3: "Alice's Bakery", q4: '123-45-6789' })) expect((await s('PUT', `/answers/${q}`, { value })).status, q).toBe(200)
    expect((await s('POST', '/uploads/q5', undefined, { headers: { 'x-file-name': 'id%20front.png' }, body: solidPng(80, 50, [10, 120, 80]) as BodyInit })).status).toBe(200)
  }, 60_000)

  test('the answers screen masks the private number until it is revealed on the record, and lists the file to download', async () => {
    const { page, errors } = await stack.operator({ viewport: { width: 1440, height: 900 } })
    await page.goto(at(`/forms/envelopes/${envelope}`))
    await page.getByRole('link', { name: 'Answers and uploaded files' }).click()
    await page.getByRole('heading', { name: 'Answers', level: 1 }).waitFor()
    expect(page.url()).toBe(at(`/forms/envelopes/${envelope}/answers`))
    await page.getByText('Alice B. Example').waitFor()
    expect(await page.getByText('123-45-6789').count()).toBe(0)
    await shot(page, 'answers')
    await page.getByRole('button', { name: 'Reveal: Social Security number' }).click()
    await page.getByText('123-45-6789').waitFor()
    await page.getByText('id front.png').waitFor()
    const view = await stack.api<{ events: { action: string }[] }>('GET', `/envelopes/${envelope}`)
    expect(view.events.filter((e) => e.action === 'sensitive-answer-revealed')).toHaveLength(1)
    expect(errors).toEqual([])
  }, 120_000)
})
