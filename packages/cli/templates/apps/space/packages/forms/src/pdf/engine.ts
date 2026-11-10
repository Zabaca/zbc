/**
 * The PDF engine: with the rest of src/pdf/ (geometry, the sample, the seal check, the synthetic scans) the ONLY code
 * that touches LibPDF (@libpdf/core, MIT, pinned in package.json). Everything the service does to a PDF goes through
 * here, so replacing the library, or moving this module into a Cloudflare Container, changes nothing else (ADR 0002).
 *
 * What it does, in the order a finished document needs it:
 *   inspect       what a file is (pages as shown, scans, fields, earlier signatures, XFA, a password) or why it is refused;
 *   workingCopy   the file with its password and change restrictions removed and its XFA dropped;
 *   finish        fill the PDF's own fields, flatten everything, stamp values at page fractions, append pages,
 *                 attach files, and seal.
 * Laying out a form's pages and the certificate of completion happen outside the engine; they call `finish` with the
 * pages they drew.
 *
 * A spike ran this in workerd (e2e/spike.test.ts; its results are in docs/adr/0002). It takes and returns bytes, holds no
 * state, and never reads a clock itself (the seal's time is passed in), so a test controls it.
 */
import {
  PDF,
  type PDFPage,
  PdfArray,
  PdfDict,
  PdfNumber,
  PdfRef,
  type Signer,
  type TimestampAuthority,
  type Color,
  ops,
  rgb,
} from '@libpdf/core'
import { sha256Hex } from '../bytes'
import { type BlockPages, appendBlocks, drawable, wrap } from './blocks'
import { type Fonts, fontsOf, subsetFonts, widthOf } from './font'
import { type Box, type FractionBox, type PageGeometry, type Rotation, fractionToShown, shownSize, shownToUser, userRectToFraction, visibleBox } from './geometry'

/** Limits the spec sets and the spike confirmed (see README). A caller may pass lower ones. */
export const LIMITS = {
  /** Source PDFs up to 20 MB and 150 pages. */
  maxBytes: 20 * 1024 * 1024,
  maxPages: 150,
} as const

export type Refusal = {
  code: 'password-needed' | 'wrong-password' | 'xfa-only' | 'unreadable' | 'too-large' | 'too-many-pages' | 'empty'
  /** The plain reason an operator reads. */
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }
const refuse = (code: Refusal['code'], message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { code, message } })

export interface PageInfo {
  index: number
  /** As shown, in points. */
  width: number
  height: number
  rotation: Rotation
  geometry: PageGeometry
  /** Images and no text: a scan. */
  scanned: boolean
}

export type FieldKind = 'text' | 'checkbox' | 'signature' | 'radio' | 'dropdown' | 'other'

export interface DetectedField {
  name: string
  kind: FieldKind
  /** Absent when the widget is not on a page of this file. */
  page: number | null
  box: FractionBox | null
  /** Already signed (a signature field holding a signature). */
  signed: boolean
  readOnly: boolean
  /** The first widget is hidden or marked not to be viewed: a reader shows nothing there. */
  hidden: boolean
  /** The first widget is not wholly on the visible page (a rectangle off the page, or hanging over its edge). */
  clipped: boolean
  /** How many places the field appears; its value is written into every one of them. */
  widgets: number
  /** A text field's character limit (`/MaxLen`), 0 for none. LibPDF cuts a longer value to it without a word. */
  maxLength: number
}

export interface Inspection {
  pageCount: number
  pages: PageInfo[]
  encrypted: boolean
  /** Opened with no password: an owner password restricts changes and nothing more. */
  restrictionsOnly: boolean
  fields: DetectedField[]
  /** How many earlier signatures the file carries. A reader shows them as changed once this service has saved it. */
  signatures: number
  xfa: 'none' | 'with-fields' | 'only'
  /** Mixed sizes as shown, to tell the operator. */
  mixedSizes: boolean
  /** Pages turned sideways. */
  turnedPages: number[]
  scannedPages: number[]
  /** LibPDF rebuilt the file's structure by scanning it: it was damaged. */
  recovered: boolean
  warnings: string[]
}

type Rect4 = [number, number, number, number]
function resolveDict(pdf: PDF, obj: unknown): PdfDict | null {
  let o = obj
  if (o instanceof PdfRef) o = pdf.getObject(o)
  return o instanceof PdfDict ? o : null
}

/**
 * A page box, read from the file's own array [llx lly urx ury], walking up the page tree because MediaBox and
 * CropBox are inheritable. NOT LibPDF's `page.getMediaBox()` and `page.width`: in 0.5.3 `getBox` hands the array's
 * third and fourth numbers back as `width` and `height`, which is right only for a box that starts at the origin.
 * The spike found it on a crop box starting at 36, 72 (test/pdf-engine.test.ts, "cropoffset"); a fix upstream
 * would let this helper go.
 */
function readBox(pdf: PDF, page: PDFPage, name: 'MediaBox' | 'CropBox'): Box | null {
  let node: PdfDict | null = page.dict
  for (let hops = 0; node && hops < 32; hops++) {
    let raw = node.get(name)
    if (raw instanceof PdfRef) raw = pdf.getObject(raw) ?? undefined
    if (raw instanceof PdfArray && raw.length >= 4) {
      const n: number[] = []
      for (let i = 0; i < 4; i++) {
        let v = raw.at(i)
        if (v instanceof PdfRef) v = pdf.getObject(v) ?? undefined
        if (!(v instanceof PdfNumber)) return null
        n.push(v.value)
      }
      return { x0: Math.min(n[0]!, n[2]!), y0: Math.min(n[1]!, n[3]!), x1: Math.max(n[0]!, n[2]!), y1: Math.max(n[1]!, n[3]!) }
    }
    node = resolveDict(pdf, node.get('Parent'))
  }
  return null
}

function geometryOf(pdf: PDF, page: PDFPage): PageGeometry {
  const mediaBox = readBox(pdf, page, 'MediaBox') ?? { x0: 0, y0: 0, x1: 612, y1: 792 }
  const cropBox = readBox(pdf, page, 'CropBox') ?? undefined
  return { mediaBox, cropBox, rotation: normalizedRotation(page.rotation) }
}

function normalizedRotation(r: number): Rotation {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360
  return n as Rotation
}

function pageHasImages(pdf: PDF, page: PDFPage): boolean {
  const resources = resolveDict(pdf, page.dict.get('Resources')) ?? resolveDict(pdf, inheritedResources(pdf, page))
  if (!resources) return false
  const xobjects = resolveDict(pdf, resources.get('XObject'))
  if (!xobjects) return false
  for (const [, value] of xobjects) {
    const x = resolveDict(pdf, value)
    if (x && x.getName('Subtype')?.value === 'Image') return true
  }
  return false
}

function inheritedResources(pdf: PDF, page: PDFPage): unknown {
  let node: PdfDict | null = resolveDict(pdf, page.dict.get('Parent'))
  for (let hops = 0; node && hops < 32; hops++) {
    const r = node.get('Resources')
    if (r) return r
    node = resolveDict(pdf, node.get('Parent'))
  }
  return null
}

function acroFormOf(pdf: PDF): PdfDict | null {
  return resolveDict(pdf, pdf.getCatalog().get('AcroForm'))
}

function xfaState(pdf: PDF, fieldCount: number): Inspection['xfa'] {
  const af = acroFormOf(pdf)
  if (!af || !af.has('XFA')) return 'none'
  return fieldCount > 0 ? 'with-fields' : 'only'
}

function describeFields(pdf: PDF, pages: PageInfo[]): DetectedField[] {
  const form = pdf.hasForm() ? pdf.getForm() : null
  if (!form) return []
  const refIndex = new Map<string, number>()
  pdf.getPages().forEach((p, i) => refIndex.set(`${p.ref.objectNumber}.${p.ref.generation}`, i))
  const out: DetectedField[] = []
  for (const f of form.getFields()) {
    const kind: FieldKind = f.type === 'text' ? 'text' : f.type === 'checkbox' ? 'checkbox' : f.type === 'signature' ? 'signature' : f.type === 'radio' ? 'radio' : f.type === 'dropdown' ? 'dropdown' : 'other'
    let page: number | null = null
    let box: FractionBox | null = null
    let hidden = false
    let clipped = false
    let widgets = 0
    let maxLength = 0
    try {
      if (f.type === 'text') maxLength = (f as unknown as { maxLength: number }).maxLength ?? 0
      const all = f.getWidgets()
      widgets = all.length
      const w = all[0]
      if (w) {
        // Hidden (annotation flag 2) or NoView (32): a reader draws nothing, so a signer must not be asked to fill it.
        hidden = w.isHidden() || (w.flags & 32) !== 0
        const ref = w.pageRef
        page = ref ? (refIndex.get(`${ref.objectNumber}.${ref.generation}`) ?? null) : null
        if (page !== null) {
          const [a, b, c, d] = w.rect as Rect4
          const rect = { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) }
          const seen = visibleBox(pages[page]!.geometry)
          // A point of slack, because a field drawn to the edge of the page is not off it.
          clipped = rect.x0 < seen.x0 - 1 || rect.y0 < seen.y0 - 1 || rect.x1 > seen.x1 + 1 || rect.y1 > seen.y1 + 1
          box = userRectToFraction(pages[page]!.geometry, rect)
        }
      }
    } catch {
      // A widget that will not resolve is a field we cannot place; it is still reported.
    }
    let signed = false
    if (f.type === 'signature') {
      try {
        signed = (f as unknown as { isSigned(): boolean }).isSigned()
      } catch {
        signed = false
      }
    }
    out.push({ name: f.name, kind, page, box, signed, readOnly: f.isReadOnly(), hidden, clipped, widgets, maxLength })
  }
  return out
}

async function openPdf(bytes: Uint8Array, password?: string): Promise<Result<{ pdf: PDF; recovered: boolean }>> {
  if (bytes.length === 0) return refuse('empty', 'The file is empty.')
  if (bytes.length > LIMITS.maxBytes) return refuse('too-large', `The file is ${(bytes.length / 1048576).toFixed(1)} MB; the most that can be signed here is ${LIMITS.maxBytes / 1048576} MB. Ask the client for a smaller copy.`)
  let pdf: PDF
  try {
    pdf = await PDF.load(bytes, password === undefined ? {} : { credentials: password })
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (/password|credential|encrypt|authenticat/i.test(msg)) {
      return password ? refuse('wrong-password', 'That password does not open the file.') : refuse('password-needed', 'The file needs a password to open. Ask the client, then give it here once; it is not kept.')
    }
    return refuse('unreadable', 'The file cannot be read as a PDF. Ask the client for another copy.')
  }
  if (pdf.isEncrypted && !pdf.isAuthenticated) {
    return password ? refuse('wrong-password', 'That password does not open the file.') : refuse('password-needed', 'The file needs a password to open. Ask the client, then give it here once; it is not kept.')
  }
  return { ok: true, value: { pdf, recovered: pdf.recoveredViaBruteForce } }
}

async function describe(pdf: PDF, recovered: boolean, encrypted: boolean, restrictionsOnly: boolean): Promise<Result<Inspection>> {
  const pageObjs = pdf.getPages()
  if (pageObjs.length === 0) return refuse('unreadable', 'The file has no pages.')
  if (pageObjs.length > LIMITS.maxPages) return refuse('too-many-pages', `The file has ${pageObjs.length} pages; the most that can be signed here is ${LIMITS.maxPages}. Ask the client to split it.`)
  const pages: PageInfo[] = pageObjs.map((p, index) => {
    const geometry = geometryOf(pdf, p)
    const size = shownSize(geometry)
    let scanned = false
    try {
      if (pageHasImages(pdf, p)) scanned = p.extractText().text.trim() === ''
    } catch {
      scanned = false
    }
    return { index, width: size.width, height: size.height, rotation: geometry.rotation, geometry, scanned }
  })
  const fields = describeFields(pdf, pages)
  const xfa = xfaState(pdf, fields.length)
  if (xfa === 'only') return refuse('xfa-only', 'This is a dynamic form (XFA) that only Adobe\'s own reader can fill. Ask the client for an ordinary PDF of it.')
  const first = pages[0]!
  const mixedSizes = pages.some((p) => Math.abs(p.width - first.width) > 2 || Math.abs(p.height - first.height) > 2)
  return {
    ok: true,
    value: {
      pageCount: pages.length,
      pages,
      encrypted,
      restrictionsOnly,
      fields,
      signatures: fields.filter((f) => f.kind === 'signature' && f.signed).length,
      xfa,
      mixedSizes,
      turnedPages: pages.filter((p) => p.rotation !== 0).map((p) => p.index),
      scannedPages: pages.filter((p) => p.scanned).map((p) => p.index),
      recovered,
      warnings: [...pdf.warnings],
    },
  }
}

/** What a file is, or why it is refused. A password is used to open it and is not kept. */
export async function inspect(bytes: Uint8Array, opts: { password?: string } = {}): Promise<Result<Inspection>> {
  const opened = await openPdf(bytes, opts.password)
  if (!opened.ok) return opened
  const { pdf, recovered } = opened.value
  return describe(pdf, recovered, pdf.isEncrypted, pdf.isEncrypted && opts.password === undefined)
}

/**
 * The file every later step reads: decrypted, change restrictions removed, a hybrid form's XFA dropped. Saved
 * whole (not incrementally), so an earlier signature will read as changed; the inspection says how many there
 * were so the operator has been told.
 */
export async function workingCopy(bytes: Uint8Array, opts: { password?: string } = {}): Promise<Result<{ bytes: Uint8Array; inspection: Inspection }>> {
  const opened = await openPdf(bytes, opts.password)
  if (!opened.ok) return opened
  const { pdf, recovered } = opened.value
  const encrypted = pdf.isEncrypted
  const restrictionsOnly = encrypted && opts.password === undefined
  const inspection = await describe(pdf, recovered, encrypted, restrictionsOnly)
  if (!inspection.ok) return inspection
  if (encrypted) pdf.removeProtection({ ignorePermissions: true })
  if (inspection.value.xfa === 'with-fields') acroFormOf(pdf)?.delete('XFA')
  try {
    return { ok: true, value: { bytes: await pdf.save(), inspection: inspection.value } }
  } catch {
    return refuse('unreadable', 'The file could not be prepared for signing. Ask the client for another copy.')
  }
}

// ── finishing ──────────────────────────────────────────────────────────────

export type Stamp = { page: number; box: FractionBox } & (
  | { kind: 'text'; text: string; size?: number; color?: [number, number, number] }
  | { kind: 'image'; bytes: Uint8Array; format: 'png' | 'jpeg' }
  | { kind: 'check'; color?: [number, number, number] }
  | { kind: 'rect'; color: [number, number, number] }
)

export interface TextPage {
  title?: string
  lines: string[]
}

/** The seal: a signer and, once the owner buys one, a timestamp authority. See src/seal/sealer.ts. */
export interface SealSpec {
  signer: Signer
  timestampAuthority?: TimestampAuthority
  reason: string
  /** The signing time to record. */
  at: Date
}

export interface FinishPlan {
  /** Values for the PDF's own fields, written into those fields before everything is flattened. */
  fieldFills?: { name: string; value: string | boolean }[]
  stamps?: Stamp[]
  appendPages?: TextPage[]
  /** Pages laid out from blocks: the certificate of completion (and a form's pages). */
  appendBlocks?: BlockPages[]
  attachments?: { name: string; data: Uint8Array; mimeType?: string; description?: string }[]
  seal?: SealSpec
}

const FLOOR_SIZE = 6

/** What a PDF's standard fonts (WinAnsi: Latin-1 and a few more) can show. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–\u2014˜™š›œžŸ'
export const isWinAnsi = (s: string): boolean => [...s].every((ch) => (ch >= ' ' && ch <= '~') || (ch >= '\u00a0' && ch <= 'ÿ') || WIN_ANSI_EXTRA.includes(ch))

const color = ([r, g, b]: [number, number, number]): Color => rgb(r, g, b)

function drawStamp(page: PDFPage, geometry: PageGeometry, s: Stamp, fonts: () => Fonts, embedImage: (stamp: Stamp & { kind: 'image' }) => ReturnType<PDF['embedPng']>): void {
  const m = shownToUser(geometry)
  const b = fractionToShown(geometry, s.box)
  page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(m[0], m[1], m[2], m[3], m[4], m[5])])
  try {
    switch (s.kind) {
      case 'rect':
        page.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, color: color(s.color) })
        break
      case 'text': {
        // Shrunk to fit its box, down to a floor; a value that still does not fit is cut at the box's edge
        // rather than drawn outside it.
        let size = s.size ?? Math.min(12, Math.max(FLOOR_SIZE, b.height * 0.7))
        const text = drawable(s.text)
        while (size > FLOOR_SIZE && widthOf(text, size) > b.width) size -= 0.5
        page.drawText(text, { x: b.x, y: b.y + Math.max(0, (b.height - size) / 2) + size * 0.2, size, font: fonts().regular, color: color(s.color ?? [0, 0, 0]) })
        break
      }
      case 'check': {
        const t = Math.max(1, Math.min(b.width, b.height) / 8)
        const c = color(s.color ?? [0, 0, 0])
        page.drawLine({ start: { x: b.x + b.width * 0.15, y: b.y + b.height * 0.5 }, end: { x: b.x + b.width * 0.4, y: b.y + b.height * 0.15 }, thickness: t, color: c })
        page.drawLine({ start: { x: b.x + b.width * 0.4, y: b.y + b.height * 0.15 }, end: { x: b.x + b.width * 0.88, y: b.y + b.height * 0.85 }, thickness: t, color: c })
        break
      }
      case 'image': {
        const img = embedImage(s)
        // Fitted inside the box, keeping its proportions, centred.
        const scale = Math.min(b.width / img.width, b.height / img.height)
        const w = img.width * scale
        const h = img.height * scale
        page.drawImage(img, { x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h })
        break
      }
    }
  } finally {
    page.drawOperators([ops.popGraphicsState()])
  }
}


/** Wrapped lines laid out down as many Letter pages as they need; a repeated line is a line like any other. */
function appendTextPage(pdf: PDF, tp: TextPage): void {
  const font = fontsOf(pdf)
  const left = 54
  const width = 612 - left * 2
  const lines = tp.lines.flatMap((raw) => wrap(raw, width, 10))
  let at = 0
  let first = true
  do {
    const page = pdf.addPage({ size: 'letter' })
    let y = 792 - 64
    if (first && tp.title) {
      page.drawText(drawable(tp.title), { x: left, y, size: 16, font: font.bold })
      y -= 28
    }
    first = false
    // A page always takes at least one line, so this ends.
    while (at < lines.length && y >= 54) {
      page.drawText(lines[at]!, { x: left, y, size: 10, font: font.regular })
      y -= 14
      at++
    }
  } while (at < lines.length)
}

/**
 * Everything a finished document needs, in one load and one save: fill the PDF's own fields, flatten every
 * field, layer and annotation (so values look the same in every reader and cannot be edited), stamp values at
 * page fractions, append pages, attach files and seal. A refusal comes back as a refusal; a throw is a bug.
 */
export async function finish(bytes: Uint8Array, plan: FinishPlan): Promise<Result<{ bytes: Uint8Array; sealed: boolean }>> {
  const opened = await openPdf(bytes)
  if (!opened.ok) return opened
  const { pdf } = opened.value
  const pages = pdf.getPages()

  if (plan.fieldFills?.length) {
    const form = pdf.getForm()
    for (const fill of plan.fieldFills) {
      const field = form?.getField(fill.name)
      if (!field) continue
      if (field.type === 'checkbox') {
        const box = form!.getCheckbox(fill.name)!
        if (fill.value === true || fill.value === 'true') box.check()
        else box.uncheck()
      } else if (field.type === 'text') {
        // Auto size, whatever the file says: a fixed size in the field's default appearance makes LibPDF keep it and clip a
        // longer value at the field's edge, which would put in the PDF less than the signer typed and the signed event hashed.
        const text = form!.getTextField(fill.name)!
        text.setFontSize(0)
        // The file's fonts are usually the standard ones (WinAnsi, which has no Vietnamese or Cyrillic): a value they cannot show would be
        // written as other characters, while the signer's event hashed the real one. Such a value is written in the document's own font; every
        // other keeps the field's, so the client's form looks as it always did.
        if (!isWinAnsi(String(fill.value))) text.setFont(fontsOf(pdf).regular)
        text.setValue(String(fill.value))
      }
    }
  }

  // Flatten BEFORE stamping, so a stamp sits on top of a flattened field's appearance.
  pdf.flattenAll()

  const geometries = pages.map((p) => geometryOf(pdf, p))
  // The same image on several pages is embedded once, found by the SHA-256 of its bytes: nothing shorter tells two
  // images of the same size apart (a signature must never be drawn in another signer's box).
  const imageKeys = new Map<Stamp, string>()
  for (const s of plan.stamps ?? []) if (s.kind === 'image') imageKeys.set(s, `${s.format}:${await sha256Hex(s.bytes)}`)
  const images = new Map<string, ReturnType<PDF['embedPng']>>()
  const embed = (s: Stamp & { kind: 'image' }) => {
    const key = imageKeys.get(s)!
    let img = images.get(key)
    if (!img) {
      img = s.format === 'png' ? pdf.embedPng(s.bytes) : pdf.embedJpeg(s.bytes)
      images.set(key, img)
    }
    return img
  }
  for (const s of plan.stamps ?? []) {
    const page = pages[s.page]
    if (!page) throw new Error(`stamp on page ${s.page}, but the file has ${pages.length}`)
    drawStamp(page, geometries[s.page]!, s, () => fontsOf(pdf), embed)
  }

  for (const tp of plan.appendPages ?? []) appendTextPage(pdf, tp)
  for (const bp of plan.appendBlocks ?? []) appendBlocks(pdf, bp)
  for (const a of plan.attachments ?? []) pdf.addAttachment(a.name, a.data, { mimeType: a.mimeType, description: a.description, overwrite: true })

  subsetFonts(pdf)
  if (!plan.seal) return { ok: true, value: { bytes: await pdf.save(), sealed: false } }
  const level = plan.seal.timestampAuthority ? 'B-T' : 'B-B'
  const signed = await pdf.sign({
    signer: plan.seal.signer,
    reason: plan.seal.reason,
    signingTime: plan.seal.at,
    subFilter: 'ETSI.CAdES.detached',
    level,
    timestampAuthority: plan.seal.timestampAuthority,
  })
  return { ok: true, value: { bytes: signed.bytes, sealed: true } }
}
