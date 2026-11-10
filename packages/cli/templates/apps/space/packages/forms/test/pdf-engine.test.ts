// The PDF engine over the spike's fixtures, in bun (the same chain runs in workerd in e2e/spike.test.ts):
// inspection results and refusals, stamp positions on every rotation and crop box, flattening, the appended
// page, the attachment and the seal, checked with poppler's pdfsig and by rendering.
import { PDF } from '@libpdf/core'
import { describe, expect, test } from 'bun:test'
import { FIXTURES, fixtureBytes } from '../scripts/fixtures'
import { finish, inspect, workingCopy } from '../src/pdf/engine'
import { CORNERS, cornerStamps, sealCheck } from '../src/pdf/seal-check'
import { NORTHFIELD_WORDS } from './words'
import { solidPng } from './png'
import { type Rgb, findColor, hasPoppler, pdfsig, renderPages } from './render'
import { testSealer } from './seal-fixture'

const sealer = await testSealer()
const AT = new Date('2026-10-31T20:00:00Z')

describe('inspection and refusal, per fixture', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    test(`${name}: ${f.what}`, async () => {
      const bytes = await fixtureBytes(name as keyof typeof FIXTURES)
      const r = await inspect(bytes, { password: f.password })
      if (!f.expect.ok) {
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.refusal.code).toBe(f.expect.code)
          expect(r.refusal.message.length).toBeGreaterThan(20)
        }
        return
      }
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const i = r.value
      expect(i.pageCount).toBe(f.expect.pages)
      if (f.expect.rotations) expect(i.pages.map((p) => p.rotation)).toEqual(f.expect.rotations as never)
      if (f.expect.scanned) expect(i.scannedPages).toEqual(f.expect.scanned)
      else expect(i.scannedPages).toEqual([])
      if (f.expect.restrictionsOnly) expect(i.restrictionsOnly).toBe(true)
      if (f.expect.fields) expect(i.fields.length).toBeGreaterThan(0)
      if (f.expect.signatures !== undefined) expect(i.signatures).toBe(f.expect.signatures)
      if (f.expect.recovered) expect(i.recovered).toBe(true)
      if (f.expect.xfa) expect(i.xfa).toBe(f.expect.xfa)
    })
  }

  test('a wrong password is refused as wrong, not as needed', async () => {
    const r = await inspect(await fixtureBytes('password'), { password: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe('wrong-password')
  })

  test('a file that is not a PDF is refused as unreadable', async () => {
    const r = await inspect(new TextEncoder().encode('hello, this is a text file'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe('unreadable')
  })

  test('mixed sizes and turned pages are reported as the operator needs to hear them', async () => {
    const m = await inspect(await fixtureBytes('mixed'))
    expect(m.ok && m.value.mixedSizes).toBe(true)
    const r = await inspect(await fixtureBytes('rot90'))
    expect(r.ok && r.value.turnedPages).toEqual([0, 1])
    expect(r.ok && [r.value.pages[0]!.width, r.value.pages[0]!.height]).toEqual([792, 612])
  })

  test('the W-9 yields its own fields with places on the page', async () => {
    const r = await inspect(await fixtureBytes('w9'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const placed = r.value.fields.filter((f) => f.box !== null)
    expect(placed.length).toBeGreaterThan(10)
    for (const f of placed) {
      expect(f.box!.x).toBeGreaterThanOrEqual(0)
      expect(f.box!.x + f.box!.width).toBeLessThanOrEqual(1.0001)
    }
  })
})

describe('the working copy', () => {
  test('removes an owner password, so a restricted file is openable and editable', async () => {
    const w = await workingCopy(await fixtureBytes('restricted'))
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const reopened = await PDF.load(w.value.bytes)
    expect(reopened.isEncrypted).toBe(false)
  })

  test('opens a password file with the password and keeps nothing of it', async () => {
    const w = await workingCopy(await fixtureBytes('password'), { password: 'open-sesame' })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const reopened = await PDF.load(w.value.bytes)
    expect(reopened.isEncrypted).toBe(false)
    expect(new TextDecoder('latin1').decode(w.value.bytes)).not.toContain('open-sesame')
  })

  test('drops the XFA of a hybrid form and keeps its fields', async () => {
    const w = await workingCopy(await fixtureBytes('xfa'))
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const again = await inspect(w.value.bytes)
    expect(again.ok && again.value.xfa).toBe('none')
    expect(again.ok && again.value.fields.length).toBeGreaterThan(0)
  })

  test('refuses an XFA-only form, a file over the cap and a file that needs a password with none given', async () => {
    for (const name of ['xfaOnly', 'tooLarge', 'password'] as const) {
      const w = await workingCopy(await fixtureBytes(name))
      expect(w.ok, name).toBe(false)
    }
  })
})

const stampedCorner = (name: string) => CORNERS.find((c) => c.name === name)!
const toRgb = (c: readonly number[]): Rgb => [Math.round(c[0]! * 255), Math.round(c[1]! * 255), Math.round(c[2]! * 255)]

describe.skipIf(!hasPoppler)('stamps land where they were placed, on every rotation and crop box', () => {
  for (const name of ['letter', 'rot90', 'rot180', 'rot270', 'mixed', 'cropoffset'] as const) {
    test(name, async () => {
      const src = await fixtureBytes(name)
      const w = await workingCopy(src)
      expect(w.ok).toBe(true)
      if (!w.ok) return
      const done = await finish(w.value.bytes, { stamps: cornerStamps(w.value.inspection.pageCount) })
      expect(done.ok).toBe(true)
      if (!done.ok) return
      const pages = renderPages(done.value.bytes)
      expect(pages.length).toBe(w.value.inspection.pageCount)
      pages.forEach((raster, p) => {
        const shown = w.value.inspection.pages[p]!
        // The render is at 72 dpi through the crop box: one pixel per point of the page as shown.
        expect(Math.abs(raster.width - shown.width)).toBeLessThanOrEqual(1)
        expect(Math.abs(raster.height - shown.height)).toBeLessThanOrEqual(1)
        for (const corner of CORNERS) {
          const found = findColor(raster, toRgb(corner.color))
          expect(found, `${name} page ${p} ${corner.name}`).not.toBeNull()
          const want = { x0: corner.box.x * shown.width, y0: corner.box.y * shown.height, x1: (corner.box.x + corner.box.width) * shown.width, y1: (corner.box.y + corner.box.height) * shown.height }
          const tol = 2
          expect(Math.abs(found!.x0 - want.x0), `${name} p${p} ${corner.name} left`).toBeLessThanOrEqual(tol)
          expect(Math.abs(found!.y0 - want.y0), `${name} p${p} ${corner.name} top`).toBeLessThanOrEqual(tol)
          expect(Math.abs(found!.x1 - want.x1), `${name} p${p} ${corner.name} right`).toBeLessThanOrEqual(tol)
          expect(Math.abs(found!.y1 - want.y1), `${name} p${p} ${corner.name} bottom`).toBeLessThanOrEqual(tol)
        }
      })
    })
  }

  test('text, a check mark and an image land inside their boxes, on a turned page', async () => {
    const src = await fixtureBytes('rot90')
    const png = solidPng(40, 20, [0, 128, 255])
    const boxes = {
      text: { x: 0.1, y: 0.4, width: 0.3, height: 0.05 },
      check: { x: 0.5, y: 0.4, width: 0.05, height: 0.08 },
      image: { x: 0.6, y: 0.4, width: 0.2, height: 0.2 },
    }
    const done = await finish(src, {
      stamps: [
        { page: 0, kind: 'text', text: 'Jane Q. Signer', color: [1, 0, 0], box: boxes.text },
        { page: 0, kind: 'check', color: [0, 0.7, 0], box: boxes.check },
        { page: 0, kind: 'image', format: 'png', bytes: png, box: boxes.image },
      ],
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const raster = renderPages(done.value.bytes)[0]!
    const inside = (found: { x0: number; y0: number; x1: number; y1: number } | null, b: { x: number; y: number; width: number; height: number }, what: string) => {
      expect(found, what).not.toBeNull()
      expect(found!.x0, `${what} left`).toBeGreaterThanOrEqual(b.x * raster.width - 2)
      expect(found!.y0, `${what} top`).toBeGreaterThanOrEqual(b.y * raster.height - 2)
      expect(found!.x1, `${what} right`).toBeLessThanOrEqual((b.x + b.width) * raster.width + 2)
      expect(found!.y1, `${what} bottom`).toBeLessThanOrEqual((b.y + b.height) * raster.height + 2)
    }
    inside(findColor(raster, [255, 0, 0], 90), boxes.text, 'text')
    inside(findColor(raster, [0, 178, 0], 70), boxes.check, 'check')
    const img = findColor(raster, [0, 128, 255], 40)
    inside(img, boxes.image, 'image')
    // The image is fitted, not stretched: the 2:1 picture keeps its 2:1 shape in a roughly square box.
    expect((img!.x1 - img!.x0) / (img!.y1 - img!.y0)).toBeGreaterThan(1.7)
  })
})

describe('images are told apart by their content', () => {
  test('two signatures of the same size and shape but different colors each draw in their own box', async () => {
    // Find two clearly different colors whose PNGs share a length and the bytes the old cache key looked at (length, first,
    // middle, last): exactly the pair it would have confused.
    const red = solidPng(12, 12, [255, 0, 0])
    const old = (b: Uint8Array) => `${b.length}:${b[b.length >> 1]}:${b[0]}:${b[b.length - 1]}`
    let other: [number, number, number] | null = null
    let seed = 12345
    const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24)
    for (let tries = 0; tries < 50_000 && !other; tries++) {
      const c: [number, number, number] = [next(), next(), next()]
      // Far from red in every channel it can be, so a render tells them apart.
      if (Math.abs(c[0] - 255) + c[1] + c[2] > 300 && old(solidPng(12, 12, c)) === old(red)) other = c
    }
    expect(other, 'a colliding pair exists to test with').not.toBeNull()
    const blue = solidPng(12, 12, other!)
    expect(old(blue)).toBe(old(red))
    const done = await finish(await fixtureBytes('letter'), {
      stamps: [
        { page: 0, kind: 'image', format: 'png', bytes: red, box: { x: 0.1, y: 0.2, width: 0.2, height: 0.15 } },
        { page: 0, kind: 'image', format: 'png', bytes: blue, box: { x: 0.6, y: 0.2, width: 0.2, height: 0.15 } },
        { page: 1, kind: 'image', format: 'png', bytes: red, box: { x: 0.1, y: 0.2, width: 0.2, height: 0.15 } },
      ],
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    // Embedded once per distinct image: two image objects for three stamps.
    const images = (new TextDecoder('latin1').decode(done.value.bytes).match(/\/Subtype\s*\/Image/g) ?? []).length
    expect(images).toBe(2)
    if (!hasPoppler) return
    const [p0, p1] = renderPages(done.value.bytes)
    const at = (r: NonNullable<typeof p0>, fx: number) => {
      const i = (Math.round(0.275 * r.height) * r.width + Math.round(fx * r.width)) * 3
      return [r.rgb[i]!, r.rgb[i + 1]!, r.rgb[i + 2]!]
    }
    expect(at(p0!, 0.2)).toEqual([255, 0, 0])
    expect(at(p0!, 0.7)).toEqual(other!)
    expect(at(p1!, 0.2)).toEqual([255, 0, 0])
  })
})

describe('appended pages', () => {
  test('a long run of repeated lines flows onto as many pages as it needs, each line once', async () => {
    const lines = ['Seal check', ...Array.from({ length: 90 }, () => 'repeat'), ...Array.from({ length: 80 }, () => ''), 'repeat', 'END']
    const done = await finish(await fixtureBytes('letter'), { appendPages: [{ title: 'Heading', lines }] })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const pdf = await PDF.load(done.value.bytes)
    // 2 original pages, then 173 lines at 14 points: 3 pages (the title takes room on the first).
    expect(pdf.getPageCount()).toBe(2 + Math.ceil((lines.length + 2) / 47))
    const text = pdf.getPages().slice(2).map((p) => p.extractText().text).join('\n')
    expect(text.match(/repeat/g)).toHaveLength(91)
    expect(text.match(/END/g)).toHaveLength(1)
    expect(text.match(/Seal check/g)).toHaveLength(1)
    expect(text.match(/Heading/g)).toHaveLength(1)
  })

  test('a single line longer than a page of width wraps and is not lost', async () => {
    const word = 'alpha '
    const done = await finish(await fixtureBytes('letter'), { appendPages: [{ lines: [word.repeat(1500)] }] })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const pdf = await PDF.load(done.value.bytes)
    const text = pdf.getPages().slice(2).map((p) => p.extractText().text).join(' ')
    expect(text.match(/alpha/g)).toHaveLength(1500)
  })
})

describe('flattening', () => {
  test('a filled field becomes page content and the form is gone', async () => {
    const w = await workingCopy(await fixtureBytes('xfa'))
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const done = await finish(w.value.bytes, { fieldFills: [{ name: 'name', value: 'Filled In' }] })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const again = await inspect(done.value.bytes)
    expect(again.ok && again.value.fields.length).toBe(0)
    const reopened = await PDF.load(done.value.bytes)
    expect(reopened.getPage(0)!.extractText().text).toContain('Filled In')
  })
})

describe.skipIf(!hasPoppler)('the seal', () => {
  test('pdfsig finds it valid over the whole file, with an untrusted certificate', async () => {
    const r = await sealCheck({ service: NORTHFIELD_WORDS, bytes: await fixtureBytes('letter'), sealer, at: AT })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sig = pdfsig(r.value.bytes)
    expect(sig.signatures).toBe(1)
    expect(sig.valid).toBe(true)
    expect(sig.coversWholeFile).toBe(true)
    expect(sig.untrusted).toBe(true)
    expect(sig.commonName).toBe('Northfield Forms Seal')
    expect(sig.signatureType).toBe('ETSI.CAdES.detached')
  })

  test('the appended page and the attachment are in the sealed file', async () => {
    const r = await sealCheck({ service: NORTHFIELD_WORDS, bytes: await fixtureBytes('letter'), sealer, at: AT })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const reopened = await PDF.load(r.value.bytes)
    expect(reopened.getPageCount()).toBe(3)
    expect(reopened.hasAttachment('events.json')).toBe(true)
    expect(reopened.getPage(2)!.extractText().text).toContain('Seal check')
  })

  test('one changed byte after sealing is detected', async () => {
    const r = await sealCheck({ service: NORTHFIELD_WORDS, bytes: await fixtureBytes('letter'), sealer, at: AT })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bytes = new Uint8Array(r.value.bytes)
    // Flip one byte inside the first stream's data, well inside the signed range: the file still opens, the seal must not.
    const text = new TextDecoder('latin1').decode(bytes)
    const at = text.indexOf('stream\n') + 'stream\n'.length + 8
    expect(at).toBeGreaterThan(8)
    bytes[at] = bytes[at]! ^ 0xff
    const sig = pdfsig(bytes)
    expect(sig.valid).toBe(false)
  })

  test('every fixture that opens seals, including the scan, the hybrid W-9 and a file that already carried a signature', async () => {
    for (const name of ['letter', 'rot90', 'mixed', 'cropoffset', 'scan', 'restricted', 'passwordOpened', 'w9', 'xfa', 'damaged', 'signed'] as const) {
      const f = FIXTURES[name]!
      const r = await sealCheck({ service: NORTHFIELD_WORDS, bytes: await fixtureBytes(name), password: f.password, sealer, at: AT })
      expect(r.ok, name).toBe(true)
      if (!r.ok) continue
      const sig = pdfsig(r.value.bytes)
      // The newest seal is the last signature; an earlier one reads as changed because the working copy was saved whole.
      expect(sig.signatures, name).toBeGreaterThanOrEqual(1)
      expect(sig.raw, name).toContain('Northfield Forms Seal')
      const mine = sig.raw.split(/Signature #\d+:/).filter((s) => s.includes('Reason') || s.includes('Northfield Forms Seal')).pop()!
      expect(/Signature Validation: Signature is Valid\./.test(mine), name).toBe(true)
      expect(/Total document signed/.test(mine), name).toBe(true)
    }
  }, 120_000)

  test('a file the engine refuses is refused by the seal check too', async () => {
    const r = await sealCheck({ service: NORTHFIELD_WORDS, bytes: await fixtureBytes('xfaOnly'), sealer, at: AT })
    expect(r.ok).toBe(false)
  })
})
