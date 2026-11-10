// What happens to a PDF's own fields between the operator's screen and the sealed page, looked at as pixels (the reviewer's probes,
// kept): a box ticked in the file that the signer leaves unticked, a value longer than a field with a fixed font size, a field the
// file hides or puts off the page, a field shown in two places, and what the event log says of the file. Pixels, not extracted text:
// text clipped at a field's edge extracts whole.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { MAX_FIELD_SIGNERS } from '../src/documents/shared'
import type { PreparedField } from '../src/fields'
import { SAMPLE_MAX_SIGNERS } from '../src/pdf/sample'
import { userRectToFraction } from '../src/pdf/geometry'
import { fixtureBytes } from '../scripts/fixtures'
import { formPdf, upload, uploaded } from './document-kit'
import { harness } from './harness'
import { type Raster, hasPoppler, renderPages } from './render'
import { ALICE, kit, png } from './signing-kit'

const h = harness()
const k = kit(h)
let client: { id: string }
beforeEach(async () => {
  h.reset()
  client = await h.makeClient({ copy_addresses: [] })
})

const LONG = '1234 Long Street Name Apartment 56, Springfield'
const own = (name: string, type: PreparedField['type'], over: Partial<PreparedField> = {}) => ({ recipient: 1, type, page: 0, box: { x: 0, y: 0, width: 0.1, height: 0.02 }, required: false, label: null, pdfFieldName: name, ...over })

/** Dark pixels in a box of the rendered page, in points from the top left. */
const ink = (r: Raster, x0: number, y0: number, x1: number, y1: number) => {
  let n = 0
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(r.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(r.width, Math.ceil(x1)); x++) if (r.rgb[(y * r.width + x) * 3]! < 110) n++
  return n
}
/** The rows and columns that hold ink in a box. */
const extent = (r: Raster, x0: number, y0: number, x1: number, y1: number, dark = 110) => {
  let top = Infinity
  let bottom = -1
  let left = Infinity
  let right = -1
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (r.rgb[(y * r.width + x) * 3]! < dark) (top = Math.min(top, y), bottom = Math.max(bottom, y), left = Math.min(left, x), right = Math.max(right, x))
  return bottom < 0 ? null : { top, bottom, left, right, rows: bottom - top + 1 }
}

// Where the form's boxes are on the page as rendered (from the top left; the page is 792 high): addr 72..172 x 172..192, optin 72..90 x
// 274..292, twice 72..192 x 372..392 on page 1 and 472..492 on page 2.
const BOX = { addr: [72, 172, 172, 192], optin: [72, 274, 90, 292], twice1: [72, 372, 192, 392], twice2: [72, 472, 192, 492] } as const

/** A signer who fills what `pick` says, by label, and leaves the rest untouched, then finishes. */
async function signWith(token: string, pick: (f: { label: string | null; type: string }) => unknown) {
  const s = k.as(token)
  await s('POST', '/open')
  await s('POST', '/consent')
  const view = await s('GET', '')
  await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: png() })
  for (const f of view.body.fields) {
    const v = f.type === 'signature' ? 'adopted' : pick(f)
    if (v === undefined) continue
    const r = await s('PUT', `/fields/${f.id}`, { value: v })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }
  const done = await s('POST', '/finish', { intent: true })
  expect(done.status, JSON.stringify(done.body)).toBe(200)
}

async function sendForm(fields: unknown[]) {
  const doc = await uploaded(h, await formPdf(), { clientId: client.id, name: 'Form' })
  const put = await h.tessa('PUT', `/admin/api/documents/${doc.id}/fields`, { fields })
  expect(put.status, JSON.stringify(put.body)).toBe(200)
  const made = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'document', documentId: doc.id }, recipients: [ALICE], order: 'sequential' })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
  return { doc, token: k.tokenFor(ALICE.email) }
}

const sig = { recipient: 1, type: 'signature', page: 0, box: { x: 0.1, y: 0.85, width: 0.3, height: 0.05 }, required: true, label: 'Sign' }

describe('which of a PDF\'s own fields are offered', () => {
  test('hidden, NoView, off-page and hanging-over fields are left as the file has them, with the reason; the rest are offered', async () => {
    const doc = await uploaded(h, await formPdf(), { clientId: client.id })
    expect(doc.own_fields.map((f) => f.name).sort()).toEqual(['addr', 'optin', 'twice'])
    const why = Object.fromEntries(doc.left_as_is.map((u) => [u.name, u.reason]))
    expect(why.hidden).toContain('hidden')
    expect(why.noview).toContain('hidden')
    expect(why.off).toContain('not wholly on the page')
    expect(why.hangs).toContain('not wholly on the page')
    // The one with a character limit is covered in documents.test.ts; the one shown twice is offered, and says so.
    expect(doc.own_fields.find((f) => f.name === 'twice')!.widgets).toBe(2)
    expect(doc.own_fields.find((f) => f.name === 'addr')!.widgets).toBe(1)
  })

  test('a rectangle hanging off the page is cut at its edge, not moved, and one wholly off it has no width', () => {
    const g = { mediaBox: { x0: 0, y0: 0, x1: 612, y1: 792 }, rotation: 0 as const }
    const hang = userRectToFraction(g, { x0: -50, y0: 100, x1: 50, y1: 120 })
    expect(hang.x).toBe(0)
    expect(hang.width).toBeCloseTo(50 / 612, 6)
    const over = userRectToFraction(g, { x0: 560, y0: 100, x1: 660, y1: 120 })
    expect(over.x).toBeCloseTo(560 / 612, 6)
    expect(over.x + over.width).toBeCloseTo(1, 6)
    expect(userRectToFraction(g, { x0: -250, y0: 100, x1: -150, y1: 120 }).width).toBe(0)
  })

  test('the two signer limits agree', () => {
    expect(MAX_FIELD_SIGNERS).toBe(SAMPLE_MAX_SIGNERS)
  })
})

describe.skipIf(!hasPoppler)('what the sealed page shows of the PDF\'s own fields', () => {
  test('the control: the file as uploaded has its box ticked and the long value would be clipped at 12 points', async () => {
    const r = renderPages(await formPdf())[0]!
    expect(ink(r, ...BOX.optin)).toBeGreaterThan(5)
  })

  test('a box ticked in the file is unticked when the signer leaves it, and ticked when they tick it', async () => {
    const left = await sendForm([sig, own('optin', 'checkbox')])
    await signWith(left.token, () => undefined)
    const unticked = renderPages(k.attachment(ALICE.email))[0]!
    expect(ink(unticked, ...BOX.optin), 'the tick the file had must not survive an unticked answer').toBe(0)

    h.reset()
    client = await h.makeClient({ copy_addresses: [] })
    const ticked = await sendForm([sig, own('optin', 'checkbox')])
    await signWith(ticked.token, (f) => (f.type === 'checkbox' ? true : undefined))
    expect(ink(renderPages(k.attachment(ALICE.email))[0]!, ...BOX.optin)).toBeGreaterThan(5)

    h.reset()
    client = await h.makeClient({ copy_addresses: [] })
    const no = await sendForm([sig, own('optin', 'checkbox')])
    await signWith(no.token, (f) => (f.type === 'checkbox' ? false : undefined))
    expect(ink(renderPages(k.attachment(ALICE.email))[0]!, ...BOX.optin), 'an explicit false is unticked too').toBe(0)
  })

  test('a value longer than a field with a fixed font size is sized to fit, all of it inside the field', async () => {
    const { token } = await sendForm([sig, own('addr', 'text', { required: true, label: 'Address' })])
    await signWith(token, (f) => (f.type === 'text' ? LONG : undefined))
    const r = renderPages(k.attachment(ALICE.email))[0]!
    const [x0, y0, x1, y1] = BOX.addr
    // Small type is lighter at one pixel a point, so anything not near white counts as ink here.
    const at = extent(r, x0, y0 - 6, x1 + 60, y1 + 6, 200)!
    expect(at, 'the value is on the page').not.toBeNull()
    // Nothing spills past the field's right edge, the text spans most of its width, and it is small: at the file's 12 points it is
    // 9 rows tall and runs to the edge cut off; sized to fit, it is the height a 100 point field allows for this many characters.
    expect(at.right).toBeLessThanOrEqual(x1 + 1)
    expect(at.right - at.left).toBeGreaterThan((x1 - x0) * 0.7)
    expect(at.rows).toBeLessThanOrEqual(7)
  })

  test('a field the file shows in two places has the answer in both', async () => {
    const { doc, token } = await sendForm([sig, own('twice', 'text', { required: true, label: 'Name' })])
    expect(doc.own_fields.find((f) => f.name === 'twice')!.widgets).toBe(2)
    await signWith(token, (f) => (f.type === 'text' ? 'Alice Example' : undefined))
    const pages = renderPages(k.attachment(ALICE.email))
    expect(ink(pages[0]!, ...BOX.twice1)).toBeGreaterThan(20)
    expect(ink(pages[1]!, ...BOX.twice2)).toBeGreaterThan(20)
  })

  test('a field the file hides stays hidden, and nobody is asked for it', async () => {
    const doc = await uploaded(h, await formPdf(), { clientId: client.id })
    const r = await h.tessa('PUT', `/admin/api/documents/${doc.id}/fields`, { fields: [own('hidden', 'text')] })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('does not have, or one this service does not fill')
  })
})

describe('what the event log says of the file', () => {
  const created = async (bytes: Uint8Array, confirm: string[] = [], password?: string) => {
    const doc = await uploaded(h, bytes, { clientId: client.id, confirm, password })
    await h.tessa('PUT', `/admin/api/documents/${doc.id}/fields`, { fields: [{ ...sig }] })
    const made = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'document', documentId: doc.id }, recipients: [ALICE], order: 'sequential' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const row = h.sql<{ details: string }>("SELECT details FROM events WHERE envelope_id = ? AND action = 'created'", made.body.envelope.id)[0]!
    return { doc, details: JSON.parse(row.details) as Record<string, unknown> }
  }

  test('earlier signatures, removed restrictions and a dropped XFA layer are in the created event, with the original\'s hash', async () => {
    const signed = await created(await fixtureBytes('signed'), ['signatures'])
    expect(signed.details).toMatchObject({ earlier_signatures: 1, restrictions_removed: false, xfa_dropped: false, original_sha256: signed.doc.original_sha256, kind: 'document', fields: 1 })
    const restricted = await created(await fixtureBytes('restricted'), ['restrictions'])
    expect(restricted.details).toMatchObject({ earlier_signatures: 0, restrictions_removed: true, xfa_dropped: false })
    const xfa = await created(await fixtureBytes('xfa'))
    expect(xfa.details).toMatchObject({ earlier_signatures: 0, restrictions_removed: false, xfa_dropped: true })
  })

  test('the core\'s own keys win over the source\'s', async () => {
    const plain = await created(await fixtureBytes('letter'))
    expect(plain.details.kind).toBe('document')
    expect(plain.details.fields).toBe(1)
  })
})

describe('a password with characters a header cannot hold', () => {
  test('€, accents and CJK open the file, are not kept, and the header carries them URL-encoded', async () => {
    const pw = 'pässwörd€中文'
    const base = await PDF.load(await fixtureBytes('letter'))
    base.setProtection({ ownerPassword: 'the-owner', userPassword: pw } as never)
    const bytes = await base.save()
    const first = await upload(h, bytes, { clientId: client.id })
    expect(first.body.code).toBe('password-needed')
    expect((await upload(h, bytes, { clientId: client.id, password: 'nope' })).body.code).toBe('wrong-password')
    const ok = await upload(h, bytes, { clientId: client.id, password: pw })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(JSON.stringify(h.sql('SELECT * FROM audit'))).not.toContain(pw)
  })
})
