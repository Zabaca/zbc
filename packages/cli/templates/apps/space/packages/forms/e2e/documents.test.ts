// The PDF path from the signer's side, in a real browser over the real Worker (workerd, the production bundle, a local D1 and R2): a document
// whose pages are turned and cropped off the origin has a signature placed on it, is sent, a signer signs through the link, and the finished PDF,
// rendered, shows the signature where the operator put it; and the signer's page draws the images pdf.js decodes with WASM (JPEG 2000, JBIG2,
// CCITT fax) from our own files, under its CSP. What no bun test can show: that pdf.js and the engine agree on where a box on a turned, cropped
// page is, and that the signer's page loads what it needs from its own folder.
//
// The operator's side (uploading through the screen, placing with the mouse, the password and restriction prompts) is the space's
// end-to-end test, packages/space/e2e/documents.test.ts: the screens are the space's. Here the document and its field are set up over the API.
//
//   bun test e2e/documents.test.ts     (needs poppler and a Chromium or Chrome; FORMS_E2E_PORT_DOCS names the port, else a free one is used)
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { FIXTURE_DIR, ensureFixtures } from '../scripts/fixtures'
import type { DocumentDetail } from '../src/documents/shared'
import { solidPng } from '../test/png'
import { findColor, hasPoppler, renderPages } from '../test/render'
import { ccittPdf, imagePdf, jbig2Pdf, rawImagePdf } from '../test/document-kit'
import { type E2eBrowser, launchBrowser } from './browser'
import { setUpClient } from './clients'
import { linkIn, newestMail } from './local-mail'
import { type Server, startServer } from './server'
import { agree } from './signing-steps'

let server: Server
let browser: E2eBrowser
beforeAll(async () => {
  await ensureFixtures()
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_DOCS' })
  browser = await launchBrowser()
}, 240_000)
afterEach(() => browser?.closeContexts(), 60_000)
afterAll(async () => {
  await browser?.stop()
  await server?.kill()
}, 60_000)

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${server.base}${path}`, body === undefined ? { method } : json(method, body))
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return JSON.parse(text) as T
}

describe('a signature placed on a turned, cropped page, and signed', () => {
  let clientId = ''
  let doc: DocumentDetail
  // Where the operator put it, as fractions of the page as shown (the space's placement screen saves exactly this: packages/space/e2e/documents.test.ts).
  const placed = { x: 0.33, y: 0.4, width: 0.3, height: 0.08 }

  test('a document with a signature placed on its third page', async () => {
    clientId = (await setUpClient(server.base, { slug: `docs-${Date.now().toString(36)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })).id
    const uploaded = await fetch(`${server.base}/admin/api/documents?client=${clientId}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Crop and turn') }, body: readFileSync(join(FIXTURE_DIR, 'cropoffset.pdf')) })
    expect(uploaded.ok).toBe(true)
    const id = ((await uploaded.json()) as { id: string }).id
    await api('PUT', `/admin/api/documents/${id}/fields`, { fields: [{ recipient: 1, type: 'signature', page: 2, required: true, box: placed }] })
    doc = await api<DocumentDetail>('GET', `/admin/api/documents/${id}`)
    expect(doc.page_count).toBe(3)
    expect(doc.inspection.turnedPages).toEqual([2])
    expect(doc.fields).toHaveLength(1)
  }, 60_000)

  test.skipIf(!hasPoppler)('sent and signed through the link, the finished PDF shows the signature inside the box that was placed', async () => {
    const draft = await api<{ envelope: { id: string } }>('POST', '/admin/api/envelopes', { client_id: clientId, source: { type: 'document', documentId: doc.id }, order: 'sequential', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }] })
    await api('POST', `/admin/api/envelopes/${draft.envelope.id}/send`, {})
    const token = /\/s\/([A-Za-z0-9_-]{43})/.exec(newestMail().text)![1]!
    const signer = linkIn(server.base, newestMail().text)
    expect(signer.endsWith(token)).toBe(true)
    const s = (method: string, path: string, body?: unknown) => fetch(`${server.base}/s/api/s/${token}${path}`, body === undefined ? { method } : json(method, body))
    expect((await s('POST', '/open')).status).toBe(200)
    expect((await s('POST', '/consent')).status).toBe(200)
    const view = (await (await s('GET', '')).json()) as { fields: { id: string; type: string; page: number }[] }
    expect(view.fields).toHaveLength(1)
    expect(view.fields[0]!.page).toBe(2)
    const image = Buffer.from(solidPng(60, 24, [20, 30, 120])).toString('base64')
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image })).status).toBe(200)
    expect((await s('PUT', `/fields/${view.fields[0]!.id}`, { value: 'adopted' })).status).toBe(200)
    expect((await s('POST', '/finish', { intent: true })).status).toBe(200)

    const done = await s('GET', '/download')
    expect(done.status).toBe(200)
    const pages = renderPages(new Uint8Array(await done.arrayBuffer()))
    const shown = doc.inspection.pages[2]!
    const raster = pages[2]!
    const found = findColor(raster, [20, 30, 120], 20)
    expect(found).not.toBeNull()
    const b = placed
    const box = { x0: b.x * shown.width, y0: b.y * shown.height, x1: (b.x + b.width) * shown.width, y1: (b.y + b.height) * shown.height }
    expect(Math.abs((found!.x0 + found!.x1) / 2 - (box.x0 + box.x1) / 2)).toBeLessThan(3)
    expect(Math.abs((found!.y0 + found!.y1) / 2 - (box.y0 + box.y1) / 2)).toBeLessThan(3)
    expect(found!.x0).toBeGreaterThanOrEqual(box.x0 - 3)
    expect(found!.x1).toBeLessThanOrEqual(box.x1 + 3)
    expect(found!.y0).toBeGreaterThanOrEqual(box.y0 - 3)
    expect(found!.y1).toBeLessThanOrEqual(box.y1 + 3)
  }, 120_000)
})

describe('the signer\'s page draws the images pdf.js decodes with WASM, from our own files', () => {
  // pdf.js 6 decodes JPEG 2000, JBIG2 and CCITT fax images (what copiers and legacy systems write) with WASM, fetched from the
  // `wasmUrl` PdfPages.tsx sets: /assets/pdfjs-wasm/, copied from the pinned pdfjs-dist by vite.config.ts. Before they were shipped
  // these were blanks on the signer's page, which is why this reads the canvas and not only the requests.
  // What the canvas holds over a region of the page (points from the page's bottom left): the darkest and the lightest grey of a grid of samples.
  type Region = { x0: number; x1: number; y0: number; y1: number }
  const IMAGE: Region = { x0: 100, x1: 300, y0: 500, y1: 700 }
  const inkOver = async (page: Page, r: Region) => {
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null
      return c !== null && c.width > 0
    })
    // pdf.js draws a page's images last and without a signal; a decoder that is going to fail has failed within this.
    await page.waitForTimeout(2500)
    return page.evaluate((r) => {
      const c = document.querySelector('canvas') as HTMLCanvasElement
      const g = c.getContext('2d')!
      let darkest = 255
      let lightest = 0
      let rgb: number[] = []
      for (let i = 1; i < 12; i++)
        for (let j = 1; j < 12; j++) {
          const x = Math.floor(c.width * ((r.x0 + ((r.x1 - r.x0) * i) / 12) / 612))
          const y = Math.floor(c.height * ((792 - (r.y0 + ((r.y1 - r.y0) * j) / 12)) / 792))
          const [R, G, B] = g.getImageData(x, y, 1, 1).data
          const grey = (R! + G! + B!) / 3
          if (i === 6 && j === 6) rgb = [R!, G!, B!]
          darkest = Math.min(darkest, grey)
          lightest = Math.max(lightest, grey)
        }
      return { darkest, lightest, rgb }
    }, r)
  }

  async function signerSees(pdf: Uint8Array, region: Region = IMAGE, opts: { noWasm?: boolean } = {}) {
    const wasm: string[] = []
    const outside: string[] = []
    const errors: string[] = []
    const made = await setUpClient(server.base, { slug: `wasm-${Math.random().toString(36).slice(2, 8)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', reply_to: 'office@pinecrest.example', accent_color: '#7a2e1d', copy_addresses: [] })
    const draft = await api<{ envelope: { id: string } }>('POST', '/admin/api/envelopes', { client_id: made.id, source: { type: 'sample' }, order: 'sequential', recipients: [{ role: 'Client', name: 'Alice Example', email: 'alice@example.test' }] })
    await api('POST', `/admin/api/envelopes/${draft.envelope.id}/send`, {})
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } })
    const page = await ctx.newPage()
    page.on('request', (r) => {
      if (r.url().includes('/assets/pdfjs-wasm/')) wasm.push(r.url().split('/').pop()!)
      if (!r.url().startsWith(server.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
    })
    page.on('pageerror', (e) => errors.push(e.message))
    if (opts.noWasm) await page.route('**/*.wasm', (route) => route.abort())
    await page.route(/\/api\/s\/[^/]+\/document$/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from(pdf) }))
    const response = await page.goto(linkIn(server.base, newestMail().text))
    expect(response!.headers()['content-security-policy']).toContain("script-src 'self';")
    await agree(page)
    const seen = await inkOver(page, region)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await ctx.close()
    return { ...seen, wasm, outside, errors }
  }


  test('the control: an image in no filter is drawn', async () => {
    const [r, g, b] = (await signerSees(await rawImagePdf([200, 20, 20]))).rgb
    expect(r! > 150 && g! < 80 && b! < 80, `the middle of the image is rgb(${r}, ${g}, ${b})`).toBe(true)
  }, 60_000)

  test('the signer\'s CSP is the one it always was: nothing from another site, no eval of any kind', async () => {
    // The decoders run in pdf.js's own worker, which is served from /assets/ and carries no page CSP, so none had to be opened.
    // Read here, from a signer's address (any token reaches the same page and the same headers), so this test needs no other.
    const csp = (await fetch(`${server.base}/s/${'a'.repeat(43)}`)).headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(csp).not.toMatch(/https?:/)
  })

  test('a JPEG 2000 image is drawn, by a decoder fetched from this site', async () => {
    const seen = await signerSees(await imagePdf('JPXDecode'))
    const [r, g, b] = seen.rgb
    // The image runs from red at the top to blue at the bottom: its middle is neither white nor grey.
    expect(seen.darkest, `the lightest sample over the image is ${seen.lightest}; the middle is rgb(${r}, ${g}, ${b})`).toBeLessThan(200)
    expect(seen.wasm).toContain('openjpeg.wasm')
    // The WASM did the work: the JavaScript twin was not even fetched.
    expect(seen.wasm).not.toContain('openjpeg_nowasm_fallback.js')
    expect(seen.outside).toEqual([])
    expect(seen.errors).toEqual([])
  }, 60_000)

  test('where the WASM cannot be had (iOS Lockdown Mode, say), the JavaScript decoders draw the image', async () => {
    const seen = await signerSees(await imagePdf('JPXDecode'), IMAGE, { noWasm: true })
    expect(seen.darkest, `the lightest sample over the image is ${seen.lightest}`).toBeLessThan(200)
    // It is the JavaScript twin that drew it.
    expect(seen.wasm).toContain('openjpeg_nowasm_fallback.js')
    expect(seen.outside).toEqual([])
  }, 60_000)

  test('a CCITT fax image (a scanner\'s) is drawn', async () => {
    const seen = await signerSees(ccittPdf(), { x0: 206, x1: 406, y0: 296, y1: 496 })
    expect(seen.darkest, `the darkest sample over the image is ${seen.darkest}`).toBeLessThan(80)
    expect(seen.wasm).toContain('jbig2.wasm')
    expect(seen.outside).toEqual([])
    expect(seen.errors).toEqual([])
  }, 60_000)

  test('a JBIG2 image is drawn', async () => {
    const seen = await signerSees(await jbig2Pdf())
    expect(seen.darkest, `the darkest sample over the image is ${seen.darkest}`).toBeLessThan(80)
    expect(seen.wasm).toContain('jbig2.wasm')
    expect(seen.outside).toEqual([])
    expect(seen.errors).toEqual([])
  }, 60_000)
})
