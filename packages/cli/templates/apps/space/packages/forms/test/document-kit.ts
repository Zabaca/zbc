// What the PDF path's tests share: uploads through the real admin API (the PDF is the body, headers carry the rest), and PDFs
// the fixtures do not cover (images in the filters pdf.js decodes with WASM: JPEG 2000, JBIG2 and CCITT fax).
import { PDF, PdfArray, PdfDict, PdfName, PdfNumber, ops } from '@libpdf/core'
import { FIXTURES, fixtureBytes } from '../scripts/fixtures'
import type { DocumentDetail } from '../src/documents/shared'
import { TESSA, NOON, type harness } from './harness'

type Harness = ReturnType<typeof harness>

// A 48 by 48 JPEG 2000 image (red to blue), 258 bytes, made once with ImageMagick and OpenJPEG.
export const JP2_BASE64 =
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAMAAAADAAAwcHAAAAAAAPY29scgEAAAAAABAAAAC1anAyY/9P/1EALwAAAAAAMAAAADAAAAAAAAAAAAAAADAAAAAwAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAQUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAALgAB/5PPpBgIkIrRAAs8/mCAA+QHAYCAgICAgICAgICAgICAgP/Z'

// A whole one-page PDF holding a 200 by 200 point CCITT Group 4 fax image (a checkerboard) at 206, 296: 1,741 bytes, made once with
// ImageMagick and libtiff's tiff2pdf. A scanner's own output has this encoding. The upload never decodes it; poppler does.
export const CCITT_PDF_BASE64 =
  'JVBERi0xLjEgCiXi48/TCjEgMCBvYmoKPDwgCi9UeXBlIC9DYXRhbG9nIAovUGFnZXMgMyAwIFIgCj4+CmVuZG9iagoyIDAgb2JqCjw8IAovQ3JlYXRpb25EYXRlIChEOjIwMjYxMDMxMTkzMzA5KQovTW9kRGF0ZSAoRDoyMDI2MTAzMTE5MzMwOSkKL1Byb2R1Y2VyIChsaWJ0aWZmIC8gdGlmZjJwZGYgLSAyMDI2MDYyNykKPj4gCmVuZG9iagozIDAgb2JqCjw8IAovVHlwZSAvUGFnZXMgCi9LaWRzIFsgNCAwIFIgXSAKL0NvdW50IDEgCj4+IAplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZSAKL1BhcmVudCAzIDAgUiAKL01lZGlhQm94IFswLjAwMDAgMC4wMDAwIDYxMi4wMDAwIDc5Mi4wMDAwXSAKL0NvbnRlbnRzIDUgMCBSIAovUmVzb3VyY2VzIDw8IAovWE9iamVjdCA8PAovSW0xIDcgMCBSID4+Ci9Qcm9jU2V0IFsgL0ltYWdlQiBdCj4+Cj4+CmVuZG9iago1IDAgb2JqCjw8IAovTGVuZ3RoIDYgMCBSIAogPj4Kc3RyZWFtCnEgIDIwMC4wMDAwIDAuMDAwMCAwLjAwMDAgMjAwLjAwMDAgMjA2LjAwMDAgMjk2LjAwMDAgY20gL0ltMSBEbyBRCgplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKNjYKZW5kb2JqCjcgMCBvYmoKPDwgCi9MZW5ndGggOCAwIFIgCi9UeXBlIC9YT2JqZWN0IAovU3VidHlwZSAvSW1hZ2UgCi9OYW1lIC9JbTEKL1dpZHRoIDIwMAovSGVpZ2h0IDIwMAovQml0c1BlckNvbXBvbmVudCAxCi9Db2xvclNwYWNlIC9EZXZpY2VHcmF5IAovRmlsdGVyIC9DQ0lUVEZheERlY29kZSAvRGVjb2RlUGFybXMgPDwgL0sgLTEgL0NvbHVtbnMgMjAwIC9Sb3dzIDIwMCAvQmxhY2tJczEgdHJ1ZSA+PgogPj4Kc3RyZWFtCiahg6hg6hg6hg6hg6hg6hj//////////////////////////////////+dQwdQwdQwdQwdQwdQwdT////////////////////////////////8moYOoYOoYOoYOoYOoYOoY///////////////////////////////////nUMHUMHUMHUMHUMHUMHU/////////////////////////////////JqGDqGDqGDqGDqGDqGDqGP//////////////////////////////////51DB1DB1DB1DB1DB1DB1P////////////////////////////////yahg6hg6hg6hg6hg6hg6hj//////////////////////////////////+dQwdQwdQwdQwdQwdQwdT////////////////////////////////8moYOoYOoYOoYOoYOoYOoY///////////////////////////////////nUMHUMHUMHUMHUMHUMHU/////////////////////////////////JqGDqGDqGDqGDqGDqGDqGP//////////////////////////////////51DB1DB1DB1DB1DB1DB1P////////////////////////////////yahg6hg6hg6hg6hg6hg6hj//////////////////////////////////+dQwdQwdQwdQwdQwdQwdT/////////wAQAQCmVuZHN0cmVhbQplbmRvYmoKOCAwIG9iago1NjAKZW5kb2JqCnhyZWYKMCA5IAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA2OCAwMDAwMCBuIAowMDAwMDAwMTk0IDAwMDAwIG4gCjAwMDAwMDAyNTggMDAwMDAgbiAKMDAwMDAwMDQzNCAwMDAwMCBuIAowMDAwMDAwNTU2IDAwMDAwIG4gCjAwMDAwMDA1NzQgMDAwMDAgbiAKMDAwMDAwMTM4OSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDkKL1Jvb3QgMSAwIFIgCi9JbmZvIDIgMCBSIAovSURbPDAwMDA0MUE3MTBENjNBRjE2MEI3QUNEOTNBQjUwQzJBPjwwMDAwNDFBNzEwRDYzQUYxNjBCN0FDRDkzQUI1MEMyQT5dCj4+CnN0YXJ0eHJlZgoxNDA4CiUlRU9GCg=='

export const ccittPdf = (): Uint8Array => Uint8Array.from(atob(CCITT_PDF_BASE64), (c) => c.charCodeAt(0))

/** A Letter page holding one image whose stream says it is encoded with `filter`, drawn 200 points across at (100, 500). */
export async function imagePdf(filter: 'JPXDecode' | 'JBIG2Decode' | 'CCITTFaxDecode', opts: { nested?: boolean; data?: Uint8Array; pixels?: number } = {}): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  const data = opts.data ?? Uint8Array.from(atob(JP2_BASE64), (c) => c.charCodeAt(0))
  const image = pdf.createStream(
    { Type: PdfName.of('XObject'), Subtype: PdfName.of('Image'), Width: PdfNumber.of(opts.pixels ?? 48), Height: PdfNumber.of(opts.pixels ?? 48), ColorSpace: PdfName.of(filter === 'JBIG2Decode' ? 'DeviceGray' : 'DeviceRGB'), BitsPerComponent: PdfNumber.of(filter === 'JBIG2Decode' ? 1 : 8), Filter: PdfName.of(filter) },
    data,
  )
  if (opts.nested) {
    // The image sits inside a Form XObject the page paints, as a scanner's or a layout program's output often has it.
    const form = pdf.createStream({ Type: PdfName.of('XObject'), Subtype: PdfName.of('Form'), BBox: PdfArray.of(PdfNumber.of(0), PdfNumber.of(0), PdfNumber.of(48), PdfNumber.of(48)), Resources: PdfDict.of({ XObject: PdfDict.of({ Im0: image }) }) }, new TextEncoder().encode('q 48 0 0 48 0 0 cm /Im0 Do Q'))
    page.dict.set('Resources', PdfDict.of({ XObject: PdfDict.of({ Fm0: form }) }))
    page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(4, 0, 0, 4, 100, 500), ops.paintXObject('Fm0'), ops.popGraphicsState()])
  } else {
    page.dict.set('Resources', PdfDict.of({ XObject: PdfDict.of({ Im0: image }) }))
    page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(200, 0, 0, 200, 100, 500), ops.paintXObject('Im0'), ops.popGraphicsState()])
  }
  return pdf.save()
}

/** The control for imagePdf: the same page with the same image in the same place, as raw RGB pixels (no filter), which every viewer draws. */
export async function rawImagePdf(rgb: [number, number, number]): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  const data = new Uint8Array(48 * 48 * 3)
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i)
  const image = pdf.createStream({ Type: PdfName.of('XObject'), Subtype: PdfName.of('Image'), Width: PdfNumber.of(48), Height: PdfNumber.of(48), ColorSpace: PdfName.of('DeviceRGB'), BitsPerComponent: PdfNumber.of(8) }, data)
  page.dict.set('Resources', PdfDict.of({ XObject: PdfDict.of({ Im0: image }) }))
  page.drawOperators([ops.pushGraphicsState(), ops.concatMatrix(200, 0, 0, 200, 100, 500), ops.paintXObject('Im0'), ops.popGraphicsState()])
  return pdf.save()
}

export type UploadOptions = { name?: string; password?: string; confirm?: string[]; clientId: string }

/** An upload as the admin page makes it: the PDF is the body, the rest travels in headers. */
export async function upload(h: Harness, bytes: Uint8Array | string, o: UploadOptions) {
  const data = typeof bytes === 'string' ? await fixtureBytes(bytes as keyof typeof FIXTURES) : bytes
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': await h.sign({ exp: Math.floor(NOON / 1000) + 600, ...TESSA }), 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(o.name ?? 'Upload.pdf') }
  if (o.password) headers['x-pdf-password'] = encodeURIComponent(o.password)
  if (o.confirm?.length) headers['x-confirm'] = o.confirm.join(',')
  const res = await h.request(headers, 'POST', `/admin/api/documents?client=${o.clientId}`, data as BodyInit)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any, res }
}

/** A document uploaded and expected to be accepted. */
export async function uploaded(h: Harness, bytes: Uint8Array | string, o: UploadOptions): Promise<DocumentDetail> {
  const r = await upload(h, bytes, o)
  if (r.status !== 201) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body as DocumentDetail
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/**
 * A real JBIG2 image (the checkerboard of ccittPdf, 200 by 200) on a Letter page at (100, 500), 200 points across. No JBIG2 encoder was
 * to hand, so the stream is written by hand in the format PDF embeds: a page information segment and an immediate generic region
 * segment whose data is MMR, which is the same Group 4 coding the CCITT fixture holds. Poppler and pdf.js both decode it.
 */
export async function jbig2Pdf(): Promise<Uint8Array> {
  const fax = ccittPdf()
  const text = new TextDecoder('latin1').decode(fax)
  const start = text.indexOf('stream\n', text.indexOf('/CCITTFaxDecode')) + 'stream\n'.length
  const g4 = fax.subarray(start, start + 560)
  const page = [...be32(0), 0x30, 0x00, 0x01, ...be32(19), ...be32(200), ...be32(200), ...be32(0), ...be32(0), 0x00, 0x00, 0x00]
  const region = [...be32(200), ...be32(200), ...be32(0), ...be32(0), 0x00, 0x01]
  const header = [...be32(1), 0x26, 0x00, 0x01, ...be32(region.length + g4.length)]
  const data = new Uint8Array(page.length + header.length + region.length + g4.length)
  data.set(page)
  data.set(header, page.length)
  data.set(region, page.length + header.length)
  data.set(g4, page.length + header.length + region.length)
  return imagePdf('JBIG2Decode', { data, pixels: 200 })
}

/**
 * A two-page form for the PDF's own fields, each with the quirk a real form has (the reviewer's probes, kept as tests):
 *   addr     a text field 100 by 20 points whose default appearance fixes the font at 12 (a longer answer is clipped unless it is sized to fit)
 *   optin    a checkbox that is TICKED in the file
 *   twice    a text field shown in two places (page 1 at y 400, page 2 at y 300)
 *   hidden   a text field whose widget is marked Hidden
 *   noview   a text field whose widget is marked NoView
 *   off      a text field wholly off the page
 *   hangs    a text field hanging over the right edge
 */
export async function formPdf(): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  const second = pdf.addPage({ size: 'letter' })
  const form = pdf.getOrCreateForm()
  const text = (name: string, at: { x: number; y: number; width: number; height: number }, flags?: number) => {
    const f = form.createTextField(name, { fontSize: name === 'addr' ? 12 : 0 } as never)
    page.drawField(f, at)
    if (flags !== undefined) f.getWidgets()[0]!.dict.set('F', PdfNumber.of(flags))
    return f
  }
  text('addr', { x: 72, y: 600, width: 100, height: 20 })
  const optin = form.createCheckbox('optin', { defaultChecked: true } as never)
  page.drawField(optin, { x: 72, y: 500, width: 18, height: 18 })
  const twice = text('twice', { x: 72, y: 400, width: 120, height: 20 })
  second.drawField(twice, { x: 72, y: 300, width: 120, height: 20 })
  text('hidden', { x: 300, y: 600, width: 100, height: 20 }, 2)
  text('noview', { x: 300, y: 560, width: 100, height: 20 }, 32)
  text('off', { x: -250, y: 400, width: 100, height: 20 })
  text('hangs', { x: 560, y: 700, width: 100, height: 20 })
  return pdf.save()
}
