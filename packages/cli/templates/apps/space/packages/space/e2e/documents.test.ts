// The PDF path's operator screens in the space (they were forms' own admin's, and the same steps): an operator uploads a PDF whose pages are
// turned and cropped off the origin, places a signature with the mouse (tap, drag, resize) and saves; a file that needs a password or carries
// restrictions asks on the page; a PDF's own field is offered in place and given to a signer with a tap; the placement screen fits a phone.
// What no bun test can show: that pdf.js and the engine agree on the shape of a turned, cropped page, that the boxes on screen are the boxes saved,
// and that pdf.js draws under the space's own content security policy, with its worker and its WASM from the space's files.
//
// The signer's side (the link, the finished PDF with the signature inside the box) is forms' own end-to-end test, packages/forms/e2e/documents.test.ts.
//
//   bun test e2e/documents.test.ts     (needs a Chromium or Chrome; SPACE_E2E_PORT_FORMS and SPACE_E2E_PORT_SPACE name the ports, else free ones are used)
//   FORMS_SHOTS=/tmp/shots bun test e2e/documents.test.ts   also writes the screens it passes through
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { COMMITTED_DIR, FIXTURE_DIR, ensureFixtures } from '@space/forms/scripts/fixtures'
import type { DocumentDetail } from '@space/forms/src/documents/shared'
import { imagePdf } from '@space/forms/test/document-kit'
import { type Stack, startStack } from './stack'

let stack: Stack
beforeAll(async () => {
  await ensureFixtures()
  stack = await startStack({ forms: 'SPACE_E2E_PORT_FORMS', space: 'SPACE_E2E_PORT_SPACE' })
}, 300_000)
afterEach(() => stack?.browser.closeContexts(), 60_000)
afterAll(() => stack?.stop(), 90_000)

const shots = process.env.FORMS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `forms-${name}.png`) }))
const at = (path: string) => `${stack.space.base}${path}`
const api = <T = any>(method: string, path: string, body?: unknown) => stack.api<T>(method, path, body)

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) => page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

describe('placing a signature with the mouse on a turned, cropped page', () => {
  let doc: DocumentDetail

  test('an upload through the screen, and pdf.js shows each page in the shape the engine recorded', async () => {
    const made = await stack.setUpClient({ slug: `docs-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })
    expect(made.id).toHaveLength(36)
    const { page, errors } = await stack.operator({ viewport: { width: 1280, height: 1000 } })
    await page.goto(at('/forms/documents'))
    await page.getByRole('heading', { name: 'Documents' }).waitFor()
    await page.setInputFiles('#pdf', join(FIXTURE_DIR, 'cropoffset.pdf'))
    await page.getByLabel('Name').fill('Crop and turn')
    await shot(page, 'docs-1-upload')
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.waitForURL(/\/forms\/documents\/[0-9a-f-]{36}$/)
    const id = /\/forms\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!
    doc = await api<DocumentDetail>('GET', `/documents/${id}`)
    expect(doc.page_count).toBe(3)
    expect(doc.inspection.turnedPages).toEqual([2])

    // Wait until pdf.js has drawn every page, then compare the shape it gave each page with the engine's.
    await page.getByRole('heading', { name: 'Crop and turn' }).waitFor()
    for (let i = 0; i < 3; i++) await page.locator(`[data-page="${i}"]`).scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-drawn="true"]').length === 3, null, { timeout: 30_000 })
    const shapes = await page.$$eval('[data-page]', (els) => els.map((el) => ({ engine: Number((el as HTMLElement).dataset.shape), pdfjs: Number(el.querySelector('canvas')!.dataset.pdfjsShape) })))
    expect(shapes).toHaveLength(3)
    shapes.forEach((s, i) => {
      const want = doc.inspection.pages[i]!.width / doc.inspection.pages[i]!.height
      expect(Math.abs(s.engine - want), `page ${i + 1} engine`).toBeLessThan(1e-6)
      expect(Math.abs(s.pdfjs - s.engine), `page ${i + 1}: pdf.js ${s.pdfjs} against the engine ${s.engine}`).toBeLessThan(0.002)
    })
    expect(errors).toEqual([])
    await shot(page, 'docs-2-viewer')
  }, 120_000)

  test('tap to place, drag to move, drag the corner to resize; what is saved is what is on the screen', async () => {
    const { page } = await stack.operator({ viewport: { width: 1280, height: 1000 } })
    await page.goto(at(`/forms/documents/${doc.id}`))
    await page.getByRole('heading', { name: 'Crop and turn' }).waitFor()
    await page.locator('[data-page="2"]').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('[data-page="2"] canvas[data-drawn="true"]') !== null, null, { timeout: 30_000 })

    const surface = page.locator('[data-page="2"]')
    const rect = async () => (await surface.boundingBox())!
    await page.getByRole('button', { name: 'Signature', exact: true }).click()
    const r0 = await rect()
    // Tap on the turned page, a third of the way across and halfway down.
    await page.mouse.click(r0.x + r0.width * 0.33, r0.y + r0.height * 0.5)
    const field = page.locator('[data-page="2"] [data-field]')
    await field.waitFor()
    expect(await field.getAttribute('data-type')).toBe('signature')
    await shot(page, 'docs-3-placed')

    const before = (await field.boundingBox())!
    expect(Math.abs(before.x + before.width / 2 - (r0.x + r0.width * 0.33))).toBeLessThan(2)
    expect(Math.abs(before.y + before.height / 2 - (r0.y + r0.height * 0.5))).toBeLessThan(2)

    // Drag it right and up.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 - 20, { steps: 6 })
    await page.mouse.move(before.x + before.width / 2 + 90, before.y + before.height / 2 - 60, { steps: 6 })
    await page.mouse.up()
    const moved = (await field.boundingBox())!
    expect(Math.abs(moved.x - before.x - 90)).toBeLessThan(2)
    expect(Math.abs(moved.y - before.y + 60)).toBeLessThan(2)

    // Drag its corner to make it larger.
    const handle = (await page.locator('[data-page="2"] [data-handle="resize"]').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2 + 10, { steps: 6 })
    await page.mouse.up()
    const grown = (await field.boundingBox())!
    expect(Math.abs(grown.width - moved.width - 30)).toBeLessThan(2)
    expect(Math.abs(grown.height - moved.height - 10)).toBeLessThan(2)

    const r1 = await rect()
    await page.getByRole('button', { name: 'Save fields' }).first().click()
    await page.getByRole('button', { name: 'Saved' }).first().waitFor()
    await shot(page, 'docs-4-saved')
    const saved = await api<DocumentDetail>('GET', `/documents/${doc.id}`)
    expect(saved.fields).toHaveLength(1)
    const f = saved.fields[0]!
    expect(f).toMatchObject({ recipient: 1, type: 'signature', page: 2, required: true })
    // The saved fractions are the box on the screen, as a fraction of the page's box on the screen.
    const want = { x: (grown.x - r1.x) / r1.width, y: (grown.y - r1.y) / r1.height, width: grown.width / r1.width, height: grown.height / r1.height }
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(f.box[k] - want[k]), k).toBeLessThan(0.004)
    expect(f.box.width).toBeGreaterThan(0)
  }, 120_000)
})

describe('the screens that ask a question, and the PDF\'s own fields', () => {
  let clientId = ''
  const open = (viewport = { width: 1280, height: 1000 }) => stack.operator({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 })
  const uploadVia = async (page: Page, file: string) => {
    await page.goto(at('/forms/documents'))
    await page.getByRole('heading', { name: 'Documents' }).waitFor()
    await page.setInputFiles('#pdf', file)
  }
  const listed = async () => (await api<{ documents: { id: string; name: string }[] }>('GET', `/documents?client=${clientId}`)).documents

  test('a client for these tests', async () => {
    clientId = (await stack.setUpClient({ slug: `ask-${Date.now().toString(36)}`, display_name: 'Ask & Co', legal_name: 'Ask and Company', reply_to: 'office@ask.example', accent_color: '#1f4e79', copy_addresses: [] })).id
    expect(clientId).toHaveLength(36)
  })

  test('a file that needs a password asks for it, and a restricted one asks for a confirmation, each on the page', async () => {
    const { page, errors } = await open()
    await uploadVia(page, join(FIXTURE_DIR, 'password.pdf'))
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.getByLabel("The file's password").waitFor()
    await page.getByText('needs a password to open').waitFor()
    await shot(page, 'docs-5-password')
    await page.getByLabel("The file's password").fill('wrong')
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.getByText('does not open the file').waitFor()
    await page.getByLabel("The file's password").fill('open-sesame')
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.waitForURL(/\/forms\/documents\/[0-9a-f-]{36}$/)
    expect(await listed()).toHaveLength(1)

    await uploadVia(page, join(FIXTURE_DIR, 'restricted.pdf'))
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.getByText('restricts changes').waitFor()
    // Not stored until it is confirmed, and the button waits for the box.
    expect(await listed()).toHaveLength(1)
    expect(await page.getByRole('button', { name: 'Upload' }).isDisabled()).toBe(true)
    await shot(page, 'docs-6-confirm')
    await page.getByRole('checkbox', { name: /I confirm/ }).check()
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.waitForURL(/\/forms\/documents\/[0-9a-f-]{36}$/)
    expect(await listed()).toHaveLength(2)
    expect(errors).toEqual([])
  }, 120_000)

  test('a PDF\'s own field is offered in place, given to a signer with a tap, and saved where the file puts it', async () => {
    const { page, errors } = await open()
    await uploadVia(page, join(COMMITTED_DIR, 'fw9.pdf'))
    await page.getByRole('button', { name: 'Upload' }).click()
    await page.waitForURL(/\/forms\/documents\/[0-9a-f-]{36}$/)
    const id = /\/forms\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!
    const doc = await api<DocumentDetail>('GET', `/documents/${id}`)
    await page.waitForFunction(() => document.querySelector('[data-page="0"] canvas[data-drawn="true"]') !== null, null, { timeout: 30_000 })
    const offered = doc.own_fields.filter((s) => s.page === 0)
    expect(offered.length).toBeGreaterThan(5)
    const first = offered.find((s) => s.kind === 'text')!
    const own = page.locator(`[data-own-field="${first.name}"]`)
    await own.scrollIntoViewIfNeeded()
    const at = (await own.boundingBox())!
    const surface = (await page.locator('[data-page="0"]').boundingBox())!
    // The dashed box is where the file's own field is, as a fraction of the page.
    expect(Math.abs((at.x - surface.x) / surface.width - first.box.x)).toBeLessThan(0.004)
    expect(Math.abs((at.y - surface.y) / surface.height - first.box.y)).toBeLessThan(0.004)
    await own.click()
    const field = page.locator('[data-page="0"] [data-field]')
    await field.waitFor()
    expect(await field.getAttribute('aria-label')).toContain("the file's own field")
    expect(await page.locator(`[data-own-field="${first.name}"]`).count()).toBe(0)
    await shot(page, 'docs-7-own-field')
    // Dragging it does nothing: it stays where the file has it.
    const b = (await field.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 5 })
    await page.mouse.up()
    expect(await field.boundingBox()).toEqual(b)
    await page.getByRole('button', { name: 'Save fields' }).first().click()
    await page.getByRole('button', { name: 'Saved' }).first().waitFor()
    const saved = await api<DocumentDetail>('GET', `/documents/${id}`)
    expect(saved.fields).toHaveLength(1)
    expect(saved.fields[0]).toMatchObject({ recipient: 1, type: 'text', page: 0, pdfFieldName: first.name })
    expect(saved.fields[0]!.box).toEqual(first.box)
    expect(errors).toEqual([])
  }, 120_000)

  test('the placement screen fits a phone: nothing runs off the side, and a tap places a field', async () => {
    const { page, errors } = await open({ width: 390, height: 844 })
    await page.goto(at(`/forms/documents/${(await listed())[0]!.id}`))
    await page.getByRole('heading', { level: 1 }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-page="0"] canvas[data-drawn="true"]') !== null, null, { timeout: 30_000 })
    expect(await fits(page)).toBe(true)
    await page.getByRole('button', { name: 'Initials', exact: true }).click()
    const r = (await page.locator('[data-page="0"]').boundingBox())!
    await page.touchscreen.tap(r.x + r.width * 0.5, r.y + r.height * 0.4)
    await page.locator('[data-page="0"] [data-type="initials"]').waitFor()
    await shot(page, 'docs-8-phone')
    expect(await fits(page)).toBe(true)
    expect(errors).toEqual([])
  }, 120_000)
})



describe('the placement screen draws a JPEG 2000 image, with the decoder from the space’s own files and under the space’s content security policy', () => {
  // pdf.js decodes JPEG 2000, JBIG2 and CCITT fax images with WASM fetched from `wasmUrl` (PdfPages.tsx; the plugin is packages/forms/pdfjs-wasm.ts), which the space's
  // build serves from its own /assets/pdfjs-wasm/. Forms' own end-to-end test shows it under the signer's policy; this is the same decoder under this page's, which is
  // `script-src 'self'` and one hash. Read from the canvas, not only from the requests: before the files were shipped these were blank pages.
  test('an image in a JPX filter is drawn on the page, by a decoder fetched from this address, and nothing else is asked for elsewhere', async () => {
    const client = (await stack.setUpClient({ slug: `jpx-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })).id
    const made = await fetch(`${stack.forms.base}/admin/api/documents?client=${client}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-file-name': 'jpx.pdf' }, body: (await imagePdf('JPXDecode')) as BodyInit })
    expect(made.ok).toBe(true)
    const id = ((await made.json()) as { id: string }).id

    const { page, errors } = await stack.operator({ viewport: { width: 1280, height: 1000 } })
    const wasm: string[] = []
    const outside: string[] = []
    const policy: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/assets/pdfjs-wasm/')) wasm.push(`${new URL(r.url()).origin === stack.space.base ? 'space' : 'elsewhere'}:${r.url().split('/').pop()}`)
      if (!r.url().startsWith(stack.space.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
    })
    page.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && policy.push(m.text()))
    const response = await page.goto(at(`/forms/documents/${id}`))
    expect(response!.headers()['content-security-policy']).toContain("script-src 'self'")
    await page.waitForFunction(() => document.querySelector('[data-page="0"] canvas[data-drawn="true"]') !== null, null, { timeout: 30_000 })
    // pdf.js draws a page's images last and without a signal; a decoder that is going to fail has failed within this.
    await page.waitForTimeout(2500)
    // The image is at 100..300 by 500..700 points on a 612 by 792 page: a grid of samples over it, the darkest of them.
    const darkest = await page.evaluate(() => {
      const c = document.querySelector('[data-page="0"] canvas') as HTMLCanvasElement
      const g = c.getContext('2d')!
      let low = 255
      for (let i = 1; i < 12; i++)
        for (let j = 1; j < 12; j++) {
          const [R, G, B] = g.getImageData(Math.floor(c.width * ((100 + (200 * i) / 12) / 612)), Math.floor(c.height * ((792 - (500 + (200 * j) / 12)) / 792)), 1, 1).data
          low = Math.min(low, (R! + G! + B!) / 3)
        }
      return low
    })
    expect(darkest, 'the image is not drawn: the page is white where it should be').toBeLessThan(200)
    expect(wasm).toContain('space:openjpeg.wasm')
    // The WASM did the work: the JavaScript twin was not even fetched (it would be, if the worker were refused the compile by a policy of its own).
    expect(wasm).not.toContain('space:openjpeg_nowasm_fallback.js')
    expect(wasm.filter((w) => !w.startsWith('space:'))).toEqual([])
    expect(outside).toEqual([])
    expect(policy).toEqual([])
    expect(errors).toEqual([])
  }, 90_000)
})
