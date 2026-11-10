// THE SPIKE (where PDF work runs): LibPDF in the real Workers runtime.
//
// Every fixture goes through the Worker's operator seal check (POST /admin/api/seal-check) in workerd: inspected,
// given a working copy, flattened, stamped in all four corners of every page, given an appended page and an attached
// file, and sealed with an RSA-2048 key through Web Crypto, or refused with its intended message. It passes when
//   - poppler's pdfsig reports the seal valid over the whole file, with an untrusted certificate,
//   - a render shows every stamp where it was placed on every rotation and crop box,
//   - the scanned file completes.
// It also prints the numbers the spike must report: the bundle's size, and each fixture's wall time, workerd's CPU
// seconds and its resident memory. Local workerd does not enforce Cloudflare's 128 MB, so the memory figure is a
// measurement and the production seal check is the proof.
//
//   bun test e2e/spike.test.ts     (needs poppler for the checks; FORMS_E2E_PORT_SPIKE names the port, else a free one is used)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { FIXTURES, fixtureBytes } from '../scripts/fixtures'
import { inspect } from '../src/pdf/engine'
import { CORNERS } from '../src/pdf/seal-check'
import { type Rgb, findColor, hasPoppler, pdfsig, renderPages } from '../test/render'
import { type Server, ROOT, startServer } from './server'

let server: Server
beforeAll(async () => {
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_SPIKE' })
}, 240_000)
afterAll(() => server?.kill(), 60_000)

interface Row {
  fixture: string
  inputKb: number
  outputKb: number
  wallMs: number
  cpuSeconds: number
  rssPeakMb: number
  rssBaselineMb: number
}
const rows: Row[] = []

async function sealThroughWorker(bytes: Uint8Array, password?: string) {
  const before = server.sample()
  let peak = before.rssKb
  let running = true
  const sampler = (async () => {
    while (running) {
      peak = Math.max(peak, server.sample().rssKb)
      await Bun.sleep(25)
    }
  })()
  const t0 = performance.now()
  const res = await fetch(`${server.base}/admin/api/seal-check`, { method: 'POST', body: bytes as BodyInit, headers: password ? { 'x-pdf-password': password } : {} })
  const body = new Uint8Array(await res.arrayBuffer())
  const wallMs = performance.now() - t0
  running = false
  await sampler
  const after = server.sample()
  return { res, body, wallMs, cpuSeconds: after.cpuSeconds - before.cpuSeconds, rssPeakKb: peak, rssBaselineKb: before.rssKb }
}

const toRgb = (c: readonly number[]): Rgb => [Math.round(c[0]! * 255), Math.round(c[1]! * 255), Math.round(c[2]! * 255)]

describe('the bundle', () => {
  test('size', () => {
    const file = `${ROOT}dist/forms_dev/index.js`
    const raw = statSync(file).size
    const gz = gzipSync(readFileSync(file)).length
    console.log(`SPIKE bundle: ${(raw / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gzip (Cloudflare's limit is 10 MB compressed on the paid plan)`)
    expect(gz).toBeLessThan(10 * 1024 * 1024)
  })
})

describe('every fixture, in workerd', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    test(`${name}: ${f.what}`, async () => {
      const input = await fixtureBytes(name as keyof typeof FIXTURES)
      const r = await sealThroughWorker(input, f.password)
      rows.push({ fixture: name, inputKb: Math.round(input.length / 1024), outputKb: Math.round(r.body.length / 1024), wallMs: Math.round(r.wallMs), cpuSeconds: Number(r.cpuSeconds.toFixed(2)), rssPeakMb: Math.round(r.rssPeakKb / 1024), rssBaselineMb: Math.round(r.rssBaselineKb / 1024) })

      if (!f.expect.ok) {
        expect(r.res.status).toBe(422)
        const refusal = (JSON.parse(new TextDecoder().decode(r.body)) as { refused: { code: string; message: string } }).refused
        expect(refusal.code).toBe(f.expect.code)
        expect(refusal.message.length).toBeGreaterThan(20)
        return
      }
      expect(r.res.status).toBe(200)
      const report = JSON.parse(decodeURIComponent(r.res.headers.get('x-seal-report')!))
      expect(report.inspection.pageCount).toBe(f.expect.pages)
      if (f.expect.scanned) expect(report.inspection.scannedPages).toEqual(f.expect.scanned)
      if (!hasPoppler) return

      // The seal: valid over the whole file, untrusted. A file that already carried a signature shows two; the last is ours.
      const sig = pdfsig(r.body)
      expect(sig.signatures).toBeGreaterThanOrEqual(1)
      const mine = sig.raw.split(/Signature #\d+:/).filter((s) => s.includes('Northfield Forms Seal')).pop()!
      expect(/Signature Validation: Signature is Valid\./.test(mine), `${name} seal valid`).toBe(true)
      expect(/Total document signed/.test(mine), `${name} seal covers the whole file`).toBe(true)
      expect(/Certificate issuer isn't Trusted|not trusted|unknown/i.test(mine), `${name} certificate untrusted`).toBe(true)

      // The stamps, on every original page: rendered, found, and compared with where they were placed.
      const local = await inspect(input, { password: f.password })
      expect(local.ok).toBe(true)
      if (!local.ok) return
      const pages = renderPages(r.body)
      expect(pages.length).toBe(report.inspection.pageCount + 1)
      for (let p = 0; p < report.inspection.pageCount; p++) {
        const raster = pages[p]!
        const shown = local.value.pages[p]!
        expect(Math.abs(raster.width - shown.width), `${name} p${p} width`).toBeLessThanOrEqual(1)
        expect(Math.abs(raster.height - shown.height), `${name} p${p} height`).toBeLessThanOrEqual(1)
        for (const c of CORNERS) {
          const found = findColor(raster, toRgb(c.color))
          expect(found, `${name} p${p} ${c.name}`).not.toBeNull()
          const want = { x0: c.box.x * raster.width, y0: c.box.y * raster.height, x1: (c.box.x + c.box.width) * raster.width, y1: (c.box.y + c.box.height) * raster.height }
          for (const [k, v] of Object.entries({ x0: found!.x0, y0: found!.y0, x1: found!.x1, y1: found!.y1 })) {
            expect(Math.abs(v - want[k as keyof typeof want]), `${name} p${p} ${c.name} ${k}`).toBeLessThanOrEqual(2)
          }
        }
      }
    }, 180_000)
  }
})

describe('the operator\'s check with no file', () => {
  test('builds and seals the largest thing the service accepts, and the seal is valid', async () => {
    const before = server.sample()
    const t0 = performance.now()
    const res = await fetch(`${server.base}/admin/api/seal-check`, { method: 'POST' })
    const body = new Uint8Array(await res.arrayBuffer())
    const wallMs = performance.now() - t0
    const after = server.sample()
    expect(res.status).toBe(200)
    const report = JSON.parse(decodeURIComponent(res.headers.get('x-seal-report')!))
    expect(report.input.synthetic).toBe(true)
    expect(report.input.bytes).toBeGreaterThan(18 * 1024 * 1024)
    console.log(`SPIKE operator check (synthetic ${(report.input.bytes / 1048576).toFixed(1)} MB scan): wall ${Math.round(wallMs)} ms, workerd CPU ${(after.cpuSeconds - before.cpuSeconds).toFixed(2)} s, rss ${Math.round(after.rssKb / 1024)} MB`)
    if (hasPoppler) expect(pdfsig(body).valid).toBe(true)
  }, 180_000)
})

afterAll(() => {
  if (rows.length === 0) return
  const w = (s: string, n: number) => s.padEnd(n)
  const lines = [w('fixture', 16) + w('in KB', 8) + w('out KB', 8) + w('wall ms', 9) + w('cpu s', 7) + w('rss base MB', 12) + 'rss peak MB']
  for (const r of rows) lines.push(w(r.fixture, 16) + w(String(r.inputKb), 8) + w(String(r.outputKb), 8) + w(String(r.wallMs), 9) + w(String(r.cpuSeconds), 7) + w(String(r.rssBaselineMb), 12) + String(r.rssPeakMb))
  console.log(`SPIKE results (workerd under vite preview, one request at a time)\n${lines.join('\n')}`)
  writeFileSync(`${ROOT}.fixtures/spike-results.json`, JSON.stringify(rows, null, 2))
})
