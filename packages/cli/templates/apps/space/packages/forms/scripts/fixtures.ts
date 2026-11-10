/**
 * The spike's PDF fixtures (where PDF work runs): no client data,
 * built here with LibPDF's own low-level API and written to .fixtures/ (gitignored, rebuilt when missing). Only
 * the IRS W-9 (public domain) is committed, in fixtures/.
 *
 *   bun scripts/make-fixtures.ts          build them all
 *
 * Each entry says what it is and what the service must do with it (`expect`): the spike's pass criteria are
 * checked against these, in bun (test/pdf-engine.test.ts) and in workerd (e2e/spike.test.ts).
 */
import { CryptoKeySigner, PDF, PdfArray, PdfDict, PdfName, PdfNumber, PdfRef, PdfString, rgb } from '@libpdf/core'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { syntheticScan } from '../src/pdf/synthetic'
import { makeSealCerts } from './certs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const FIXTURE_DIR = `${ROOT}.fixtures/`
export const COMMITTED_DIR = `${ROOT}fixtures/`

export const PASSWORD = 'open-sesame'

export type Expect =
  | { ok: true; pages: number; rotations?: number[]; scanned?: number[]; restrictionsOnly?: boolean; fields?: boolean; signatures?: number; recovered?: boolean; xfa?: 'with-fields' }
  | { ok: false; code: 'password-needed' | 'xfa-only' | 'too-large' }

export interface Fixture {
  file: string
  what: string
  expect: Expect
  /** A password to give when the file needs one. */
  password?: string
}

export const FIXTURES: Record<string, Fixture> = {
  letter: { file: 'letter.pdf', what: 'two plain Letter pages', expect: { ok: true, pages: 2 } },
  rot90: { file: 'rot90.pdf', what: 'Letter pages turned 90 degrees', expect: { ok: true, pages: 2, rotations: [90, 90] } },
  rot180: { file: 'rot180.pdf', what: 'Letter pages turned 180 degrees', expect: { ok: true, pages: 2, rotations: [180, 180] } },
  rot270: { file: 'rot270.pdf', what: 'Letter pages turned 270 degrees', expect: { ok: true, pages: 2, rotations: [270, 270] } },
  mixed: { file: 'mixed.pdf', what: 'Letter, Legal and A4 pages, one landscape', expect: { ok: true, pages: 4 } },
  cropoffset: { file: 'cropoffset.pdf', what: 'a crop box that does not start at zero, a media box that does not either, and a turned page with both', expect: { ok: true, pages: 3, rotations: [0, 0, 90] } },
  scan: { file: 'scan.pdf', what: 'image-only pages, about 19 MB (the size cap is 20 MB)', expect: { ok: true, pages: 3, scanned: [0, 1, 2] } },
  restricted: { file: 'restricted.pdf', what: 'an owner password and no user password: change restrictions only', expect: { ok: true, pages: 2, restrictionsOnly: true } },
  password: { file: 'password.pdf', what: 'needs a password to open', expect: { ok: false, code: 'password-needed' } },
  passwordOpened: { file: 'password.pdf', what: 'the same file, opened with its password', expect: { ok: true, pages: 2 }, password: PASSWORD },
  w9: { file: 'fw9.pdf', what: 'the IRS Form W-9, a fillable government form (public domain; Designer 6.5 hybrid with XFA)', expect: { ok: true, pages: 6, fields: true, xfa: 'with-fields' } },
  xfa: { file: 'xfa.pdf', what: 'a form with both XFA and an ordinary field', expect: { ok: true, pages: 1, fields: true, xfa: 'with-fields' } },
  xfaOnly: { file: 'xfa-only.pdf', what: 'a form that is XFA alone', expect: { ok: false, code: 'xfa-only' } },
  damaged: { file: 'damaged.pdf', what: 'a damaged cross-reference table', expect: { ok: true, pages: 2, recovered: true } },
  signed: { file: 'signed.pdf', what: 'already carrying a signature', expect: { ok: true, pages: 1, fields: true, signatures: 1 } },
  tooLarge: { file: 'too-large.pdf', what: 'over the 20 MB cap', expect: { ok: false, code: 'too-large' } },
}

const SIZES = { letter: [612, 792], legal: [612, 1008], a4: [595.28, 841.89] } as const

function labelled(pdf: PDF, width: number, height: number, label: string) {
  const page = pdf.addPage({ width, height })
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 })
  page.drawText(label, { x: 48, y: height - 72, size: 20 })
  page.drawText('The quick brown fox jumps over the lazy dog.', { x: 48, y: height - 100, size: 11 })
  return page
}

const num = (n: number) => PdfNumber.of(n)
const box = (a: number, b: number, c: number, d: number) => new PdfArray([num(a), num(b), num(c), num(d)])

async function plain(pages: number, rotate: 0 | 90 | 180 | 270 = 0): Promise<Uint8Array> {
  const pdf = PDF.create()
  for (let i = 0; i < pages; i++) {
    const p = labelled(pdf, 612, 792, `Letter page ${i + 1}, turned ${rotate}`)
    if (rotate) p.setRotation(rotate)
  }
  return pdf.save()
}

async function mixed(): Promise<Uint8Array> {
  const pdf = PDF.create()
  labelled(pdf, ...SIZES.letter, 'Letter')
  labelled(pdf, ...SIZES.legal, 'Legal')
  labelled(pdf, ...SIZES.a4, 'A4')
  labelled(pdf, SIZES.letter[1], SIZES.letter[0], 'Letter, landscape')
  return pdf.save()
}

async function cropOffset(): Promise<Uint8Array> {
  const pdf = PDF.create()
  const a = labelled(pdf, 612, 792, 'Crop box starts at 36, 72')
  a.dict.set('CropBox', box(36, 72, 540, 700))
  // A media box whose origin is not zero: the content is drawn relative to that origin.
  const b = pdf.addPage({ width: 612, height: 792 })
  b.dict.set('MediaBox', box(-20, -30, 592, 762))
  b.drawRectangle({ x: -10, y: -20, width: 592, height: 772, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 })
  b.drawText('Media box starts at -20, -30', { x: 40, y: 700, size: 20 })
  // Both, and turned.
  const c = pdf.addPage({ width: 612, height: 792 })
  c.dict.set('MediaBox', box(10, 20, 622, 812))
  c.dict.set('CropBox', box(60, 100, 500, 700))
  c.drawRectangle({ x: 70, y: 110, width: 420, height: 580, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 })
  c.drawText('Crop 60,100 in media 10,20, turned 90', { x: 90, y: 640, size: 16 })
  c.setRotation(90)
  return pdf.save()
}

async function scan(totalMegabytes = 19, pages = 3): Promise<Uint8Array> {
  return syntheticScan(totalMegabytes, pages)
}

async function restricted(): Promise<Uint8Array> {
  const pdf = PDF.load(await plain(2))
  const doc = await pdf
  doc.setProtection({ ownerPassword: 'the-owner', userPassword: '', permissions: { modify: false, copy: false, print: true } } as never)
  return doc.save()
}

async function password(): Promise<Uint8Array> {
  const doc = await PDF.load(await plain(2))
  doc.setProtection({ ownerPassword: 'the-owner', userPassword: PASSWORD } as never)
  return doc.save()
}

async function xfa(onlyXfa: boolean): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = labelled(pdf, 612, 792, onlyXfa ? 'XFA only: please wait' : 'XFA and an ordinary field')
  if (!onlyXfa) {
    const form = pdf.getOrCreateForm()
    const field = form.createTextField('name', {} as never)
    page.drawField(field, { x: 72, y: 600, width: 200, height: 24 })
  } else {
    pdf.getOrCreateForm()
  }
  const afRaw = pdf.getCatalog().get('AcroForm')
  const af = (afRaw instanceof PdfRef ? pdf.getObject(afRaw) : afRaw) as PdfDict
  const xdp = pdf.createStream({}, new TextEncoder().encode('<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'))
  af.set('XFA', new PdfArray([PdfString.fromString('template'), xdp]))
  return pdf.save()
}

async function damaged(): Promise<Uint8Array> {
  const good = await plain(2)
  // Garble the cross-reference table: the last 400 bytes hold xref, trailer and startxref.
  const text = new TextDecoder('latin1').decode(good)
  const at = text.lastIndexOf('startxref')
  const tail = new TextEncoder().encode('startxref\n99999999\n%%EOF\n')
  const cut = new Uint8Array(at + tail.length)
  cut.set(good.subarray(0, at))
  cut.set(tail, at)
  // Also break the first xref entries, when the file has a plain table rather than a stream.
  const xr = text.lastIndexOf('xref\n0 ')
  if (xr > 0) for (let i = xr + 10; i < xr + 70 && i < cut.length; i++) cut[i] = 0x78
  return cut
}

async function signedFixture(): Promise<Uint8Array> {
  const base = await PDF.load(await plain(1))
  const certs = await makeSealCerts(new Date(), 2048)
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(certs.seal.keyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signer = new CryptoKeySigner(key, certs.seal.certDer, 'RSA', 'RSASSA-PKCS1-v1_5', [certs.root.certDer])
  const { bytes } = await base.sign({ signer, reason: 'An earlier signature', fieldName: 'EarlierSignature' })
  return bytes
}

async function tooLarge(): Promise<Uint8Array> {
  return scan(21, 3)
}

/** Builds every fixture that is missing; returns the directory. */
export async function ensureFixtures(force = false): Promise<string> {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const make: Record<string, () => Promise<Uint8Array>> = {
    'letter.pdf': () => plain(2),
    'rot90.pdf': () => plain(2, 90),
    'rot180.pdf': () => plain(2, 180),
    'rot270.pdf': () => plain(2, 270),
    'mixed.pdf': mixed,
    'cropoffset.pdf': cropOffset,
    'scan.pdf': () => scan(),
    'restricted.pdf': restricted,
    'password.pdf': password,
    'xfa.pdf': () => xfa(false),
    'xfa-only.pdf': () => xfa(true),
    'damaged.pdf': damaged,
    'signed.pdf': signedFixture,
    'too-large.pdf': tooLarge,
  }
  for (const [file, build] of Object.entries(make)) {
    if (!force && existsSync(`${FIXTURE_DIR}${file}`)) continue
    writeFileSync(`${FIXTURE_DIR}${file}`, await build())
  }
  return FIXTURE_DIR
}

/** A fixture's bytes (built first when missing). */
export async function fixtureBytes(name: keyof typeof FIXTURES): Promise<Uint8Array> {
  await ensureFixtures()
  const f = FIXTURES[name]!
  const dir = f.file === 'fw9.pdf' ? COMMITTED_DIR : FIXTURE_DIR
  return new Uint8Array(readFileSync(`${dir}${f.file}`))
}

export { PdfName, PdfRef }
