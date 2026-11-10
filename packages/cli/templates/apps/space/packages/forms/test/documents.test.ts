// The PDF path, driven from outside through the real admin API over the real migrations (seam 1), with the real engine and the
// fixtures (seam 2): what an upload accepts, asks about and refuses; what the PDF's own fields offer; the rules placement keeps;
// what Send makes of a document; and, rendered, that a signed value lands where the operator put the field on every rotation and
// crop box.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { FIXTURES, PASSWORD, fixtureBytes } from '../scripts/fixtures'
import { sha256Hex } from '../src/bytes'
import type { PreparedField } from '../src/fields'
import { SAMPLE_SOURCE_OWNER } from '../src/signing'
import { TESSA, NOON, harness } from './harness'
import { findColor, hasPoppler, pdfsig, renderPages } from './render'
import { type Recipient, ALICE, BOB, kit } from './signing-kit'
import { ccittPdf, imagePdf, jbig2Pdf, upload, uploaded } from './document-kit'

const h = harness()
const k = kit(h)
let client: { id: string; slug: string; display_name: string }
beforeEach(async () => {
  h.reset()
  client = await h.makeClient({ copy_addresses: [] })
})

const put = (id: string, fields: unknown) => h.tessa('PUT', `/admin/api/documents/${id}/fields`, { fields })
const sig = (over: Partial<PreparedField> = {}): PreparedField => ({ recipient: 1, type: 'signature', page: 0, box: { x: 0.1, y: 0.7, width: 0.3, height: 0.06 }, required: true, label: 'Sign here', ...over })

async function draftFrom(documentId: string, recipients: Recipient[], extra: Record<string, unknown> = {}) {
  return h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'document', documentId }, recipients, order: 'sequential', ...extra })
}

describe('upload', () => {
  test('a plain PDF is stored as received beside its working copy, and described', async () => {
    const bytes = await fixtureBytes('letter')
    const doc = await uploaded(h, bytes, { clientId: client.id, name: 'Engagement letter.pdf' })
    expect(doc.name).toBe('Engagement letter')
    expect(doc.page_count).toBe(2)
    expect(doc.original_sha256).toBe(await sha256Hex(bytes))
    expect(doc.inspection.pages.map((p) => [p.width, p.height, p.rotation])).toEqual([[612, 792, 0], [612, 792, 0]])
    expect(doc.fields).toEqual([])
    expect(doc.envelopes).toBe(0)
    // The sample's own source document is never listed as an upload.
    const list = await h.tessa('GET', `/admin/api/documents?client=${client.id}`)
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual([doc.id])
    expect(list.body.limits).toEqual({ maxBytes: 20 * 1024 * 1024, maxPages: 150 })
    expect((await h.tessa("GET", "/admin/api/documents")).body.documents).toHaveLength(1)
  })

  test('both files are encrypted under the document\'s own key: R2 holds nothing readable without it', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id })
    const objects = h.files().objects
    expect([...objects.keys()].filter((key) => key.startsWith(`sources/${doc.id}/`)).sort()).toEqual([`sources/${doc.id}/original`, `sources/${doc.id}/working`])
    await expect(h.files().get(`sources/${doc.id}/working`)).rejects.toThrow()
    const [row] = h.sql<{ wrapped_key: string; inspection: string }>('SELECT wrapped_key, inspection FROM source_documents WHERE id = ?', doc.id)
    expect(row!.wrapped_key.length).toBeGreaterThan(20)
    // What the viewer reads back is the working copy, intact.
    const res = await h.request({ 'cf-access-jwt-assertion': await h.sign({ exp: Math.floor(NOON / 1000) + 600, ...TESSA }) }, 'GET', `/admin/api/documents/${doc.id}/pdf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await PDF.load(new Uint8Array(await res.arrayBuffer()))).getPageCount()).toBe(2)
  })

  test('the upload needs an operator and a client', async () => {
    const bytes = await fixtureBytes('letter')
    const res = await h.request({}, 'POST', `/admin/api/documents?client=${client.id}`, bytes as BodyInit)
    expect(res.status).toBe(401)
    expect((await upload(h, bytes, { clientId: crypto.randomUUID() })).status).toBe(404)
    expect((await h.request({ 'cf-access-jwt-assertion': await h.sign({ exp: Math.floor(NOON / 1000) + 600, ...TESSA }) }, 'POST', '/admin/api/documents', bytes as BodyInit)).status).toBe(400)
  })

  test('a file that needs a password asks for one, opens with it, and the password is kept nowhere', async () => {
    const need = await upload(h, 'password', { clientId: client.id })
    expect(need.status).toBe(422)
    expect(need.body.code).toBe('password-needed')
    expect((await upload(h, 'password', { clientId: client.id, password: 'nope' })).body.code).toBe('wrong-password')
    expect(h.sql('SELECT id FROM source_documents')).toHaveLength(0)
    expect(h.files().objects.size).toBe(0)

    const doc = await uploaded(h, 'password', { clientId: client.id, password: PASSWORD, name: 'Locked' })
    expect(doc.inspection.encrypted).toBe(true)
    expect(doc.inspection.restrictionsOnly).toBe(false)
    // The working copy opens with no password; the original is as received and still needs it.
    const row = h.sql<{ id: string }>('SELECT id FROM source_documents')[0]!
    expect(JSON.stringify(h.sql('SELECT * FROM source_documents WHERE id = ?', row.id))).not.toContain(PASSWORD)
    expect(JSON.stringify(h.sql('SELECT * FROM audit'))).not.toContain(PASSWORD)
    const working = await readStored(row.id, 'working')
    expect((await PDF.load(working)).isEncrypted).toBe(false)
    const original = await readStored(row.id, 'original')
    expect((await PDF.load(original, { credentials: 'wrong' }).catch(() => null)?.then((p) => p?.isAuthenticated))).not.toBe(true)
  })

  async function readStored(id: string, which: 'original' | 'working'): Promise<Uint8Array> {
    const [row] = h.sql<{ wrapped_key: string; key_version: number }>('SELECT wrapped_key, key_version FROM source_documents WHERE id = ?', id)
    const key = await h.core().vault.unwrap(row!.wrapped_key, row!.key_version, `source:${id}`)
    const { getSealed } = await import('../src/vault')
    return (await getSealed(h.files(), `sources/${id}/${which}`, key))!
  }

  test('a file with only change restrictions is held until the operator confirms, then its restrictions are dropped from the working copy', async () => {
    const first = await upload(h, 'restricted', { clientId: client.id })
    expect(first.status).toBe(409)
    expect(first.body.code).toBe('confirm')
    expect(first.body.confirm).toEqual(['restrictions'])
    expect(first.body.error).toContain('restricts changes')
    expect(h.sql('SELECT id FROM source_documents')).toHaveLength(0)
    expect(h.files().objects.size).toBe(0)

    const doc = await uploaded(h, 'restricted', { clientId: client.id, confirm: ['restrictions'] })
    expect(doc.inspection.restrictionsOnly).toBe(true)
    expect(doc.inspection.confirmed).toEqual({ restrictions: true, signatures: false })
    const working = await PDF.load(await readStored(doc.id, 'working'))
    expect(working.isEncrypted).toBe(false)
    const [audit] = h.sql<{ after: string }>("SELECT after FROM audit WHERE action = 'upload'")
    expect(JSON.parse(audit!.after)).toMatchObject({ restrictions_removed: true, confirmed: { restrictions: true } })
  })

  test('a file already carrying a signature is held until the operator confirms the warning, which is recorded', async () => {
    const first = await upload(h, 'signed', { clientId: client.id })
    expect(first.status).toBe(409)
    expect(first.body.confirm).toEqual(['signatures'])
    expect(first.body.error).toContain('1 signature')
    const doc = await uploaded(h, 'signed', { clientId: client.id, confirm: ['signatures'] })
    expect(doc.inspection.signatures).toBe(1)
    const [audit] = h.sql<{ after: string }>("SELECT after FROM audit WHERE action = 'upload'")
    expect(JSON.parse(audit!.after)).toMatchObject({ signatures: 1, confirmed: { signatures: true } })
    // The earlier signature is not offered as a field to fill.
    expect(doc.own_fields).toEqual([])
    expect(doc.left_as_is.map((u) => u.reason)).toContain('already signed')
  })

  test('refused with a plain reason: an XFA-only form, a file over the cap, text that is not a PDF, an empty file', async () => {
    const xfa = await upload(h, 'xfaOnly', { clientId: client.id })
    expect(xfa.status).toBe(422)
    expect(xfa.body.code).toBe('xfa-only')
    expect(xfa.body.error).toContain('XFA')
    const big = await upload(h, 'tooLarge', { clientId: client.id })
    expect(big.status).toBe(422)
    expect(big.body.code).toBe('too-large')
    expect(big.body.error).toContain('20 MB')
    const text = await upload(h, new TextEncoder().encode('hello, this is not a PDF'), { clientId: client.id })
    expect(text.body.code).toBe('unreadable')
    const empty = await h.request({ 'cf-access-jwt-assertion': await h.sign({ exp: Math.floor(NOON / 1000) + 600, ...TESSA }) }, 'POST', `/admin/api/documents?client=${client.id}`, new Uint8Array(0) as BodyInit)
    expect(empty.status).toBe(400)
    expect(h.sql('SELECT id FROM source_documents')).toHaveLength(0)
    expect(h.files().objects.size).toBe(0)
  })

  test('a body past what the Worker will read is refused as it arrives', async () => {
    const res = await h.request({ 'cf-access-jwt-assertion': await h.sign({ exp: Math.floor(NOON / 1000) + 600, ...TESSA }) }, 'POST', `/admin/api/documents?client=${client.id}`, new Uint8Array(31 * 1024 * 1024) as BodyInit)
    expect(res.status).toBe(413)
  })

  test('a hybrid XFA form loses its XFA and keeps its fields; a damaged file the engine recovers is accepted', async () => {
    const xfa = await uploaded(h, 'xfa', { clientId: client.id })
    expect(xfa.inspection.xfa).toBe('with-fields')
    expect(xfa.own_fields.map((s) => s.name)).toEqual(['name'])
    const working = await PDF.load(await readStored(xfa.id, 'working'))
    const af = working.getCatalog().get('AcroForm') as never
    expect(JSON.stringify(Object.keys((working.getObject(af) as unknown as { entries: Map<unknown, unknown> }).entries ?? {}))).not.toContain('XFA')
    const damaged = await uploaded(h, 'damaged', { clientId: client.id })
    expect(damaged.inspection.recovered).toBe(true)
  })

  test('a scan is accepted up to the cap and its pages are reported as scans', async () => {
    const doc = await uploaded(h, 'scan', { clientId: client.id })
    expect(doc.inspection.scannedPages).toEqual([0, 1, 2])
    expect(doc.own_fields).toEqual([])
  }, 60_000)

  test('a name is a title: no folder, no extension, no control characters, and never empty', async () => {
    const a = await uploaded(h, 'letter', { clientId: client.id, name: 'C:\\Users\\x\\W-9 (Lane).PDF' })
    expect(a.name).toBe('W-9 (Lane)')
    const b = await uploaded(h, 'letter', { clientId: client.id, name: '.pdf' })
    expect(b.name).toBe('Untitled document')
    const c = await uploaded(h, 'letter', { clientId: client.id, name: `${'long '.repeat(60)}.pdf` })
    expect(c.name.length).toBeLessThanOrEqual(120)
  })
})

describe('images pdf.js decodes with WASM (JPEG 2000, JBIG2, CCITT fax): the files copiers and legacy systems make', () => {
  const cases: [string, () => Promise<Uint8Array>, (r: ReturnType<typeof renderPages>[number]) => boolean][] = [
    ['JPEG 2000', () => imagePdf('JPXDecode'), (r) => nonWhite(r, 150, 150, 250, 250) > 5000],
    ['CCITT fax (Group 4, as a scanner writes it)', async () => ccittPdf(), (r) => findColor(r, [0, 0, 0], 30) !== null],
    ['JBIG2', jbig2Pdf, (r) => findColor(r, [0, 0, 0], 30) !== null],
  ]
  // Pixels that are not the white of the page, in a box of the page as rendered (points from the top left).
  const nonWhite = (r: { width: number; rgb: Uint8Array }, x0: number, y0: number, x1: number, y1: number) => {
    let n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((r.rgb[(y * r.width + x) * 3]! + r.rgb[(y * r.width + x) * 3 + 1]! + r.rgb[(y * r.width + x) * 3 + 2]!) / 3 < 235) n++
    return n
  }
  for (const [words, make, drawn] of cases) {
    test.skipIf(!hasPoppler)(`${words}: accepted, signed, sealed, and the finished PDF still shows the image and holds a valid seal`, async () => {
      const source = await make()
      expect(drawn(renderPages(source, 72)[0]!), 'poppler draws the fixture').toBe(true)
      const doc = await uploaded(h, source, { clientId: client.id, name: words.slice(0, 12) })
      expect(doc.page_count).toBe(1)
      expect((await put(doc.id, [sig({ box: { x: 0.1, y: 0.85, width: 0.3, height: 0.05 } })])).status).toBe(200)
      const made = await draftFrom(doc.id, [ALICE])
      await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
      expect(await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')).toBe('complete')
      const finished = k.attachment(ALICE.email)
      const sealed = pdfsig(finished)
      expect(sealed.valid).toBe(true)
      expect(sealed.coversWholeFile).toBe(true)
      expect(drawn(renderPages(finished, 72)[0]!), 'the image survives flattening and sealing').toBe(true)
    }, 60_000)
  }

  test('an image inside a form the page paints is accepted too, and a scan and a page with none', async () => {
    expect((await upload(h, await imagePdf('JPXDecode', { nested: true }), { clientId: client.id })).status).toBe(201)
    expect((await upload(h, 'letter', { clientId: client.id })).status).toBe(201)
    expect((await upload(h, 'scan', { clientId: client.id })).status).toBe(201)
  }, 60_000)
})

describe('the PDF\'s own fields', () => {
  test('the W-9 offers its text, checkbox and signature fields in place, with what each can become', async () => {
    const doc = await uploaded(h, 'w9', { clientId: client.id, name: 'W-9' })
    expect(doc.inspection.xfa).toBe('with-fields')
    const text = doc.own_fields.find((s) => s.kind === 'text')!
    expect(text.types).toEqual(['text', 'date'])
    expect(text.page).toBe(0)
    expect(text.box.width).toBeGreaterThan(0)
    expect(doc.own_fields.find((s) => s.kind === 'checkbox')!.types).toEqual(['checkbox'])
    expect(doc.own_fields.length + doc.left_as_is.length).toBe(doc.inspection.fields.length)
  })

  test('a text field with a character limit is not offered to fill in place, with the reason', async () => {
    const doc = await uploaded(h, 'w9', { clientId: client.id })
    const limited = doc.left_as_is.find((u) => /at most 2 characters/.test(u.reason))
    expect(limited).toBeDefined()
    expect(doc.own_fields.map((s) => s.name)).not.toContain(limited!.name)
    expect(limited!.reason).toContain('place a text field over it')
  })
})

describe('placing fields', () => {
  test('a set of fields is saved whole, shown back, and audited with its before and after', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id })
    const r = await put(doc.id, [sig(), sig({ recipient: 2, type: 'date', page: 1, box: { x: 0.5, y: 0.1, width: 0.2, height: 0.03 }, label: null })])
    expect(r.status).toBe(200)
    expect(r.body.fields_placed).toBe(2)
    expect(r.body.signers).toEqual([1, 2])
    expect((await h.tessa('GET', `/admin/api/documents/${doc.id}`)).body.fields).toHaveLength(2)
    expect(h.sql("SELECT action FROM audit WHERE entity = 'source_documents' ORDER BY id").map((a: any) => a.action)).toEqual(['upload', 'place-fields'])
    const [a] = h.sql<{ before: string; after: string }>("SELECT before, after FROM audit WHERE action = 'place-fields'")
    expect(JSON.parse(a!.before)).toEqual([])
    expect(JSON.parse(a!.after)).toHaveLength(2)
    // Saving the same set again writes no new audit row.
    await put(doc.id, [sig(), sig({ recipient: 2, type: 'date', page: 1, box: { x: 0.5, y: 0.1, width: 0.2, height: 0.03 }, label: null })])
    expect(h.sql("SELECT id FROM audit WHERE action = 'place-fields'")).toHaveLength(1)
  })

  const refused = async (fields: unknown, words: RegExp | string) => {
    const doc = await uploaded(h, 'letter', { clientId: client.id })
    const r = await put(doc.id, fields)
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toMatch(words)
    expect(h.sql("SELECT id FROM audit WHERE action = 'place-fields'")).toHaveLength(0)
  }

  test('a field must sit inside its page, on a page the document has, with a type and a signer', async () => {
    await refused([sig({ box: { x: 0.8, y: 0.7, width: 0.3, height: 0.06 } })], /does not sit inside its page/)
    await refused([sig({ box: { x: -0.1, y: 0.7, width: 0.3, height: 0.06 } })], /does not sit inside its page/)
    await refused([sig({ box: { x: 0.1, y: 0.7, width: 0, height: 0.06 } })], /does not sit inside its page/)
    await refused([sig({ page: 2 })], /page 3, which the document does not have/)
    await refused([sig({ page: -1 })], /does not have/)
    await refused([{ ...sig(), type: 'stamp' }], /unknown type/)
    await refused([sig({ recipient: 0 })], /signer 1 to 4/)
    await refused([sig({ recipient: 5 })], /signer 1 to 4/)
    await refused([sig({ recipient: 1.5 })], /signer 1 to 4/)
    await refused([{ ...sig(), box: undefined }], /needs a page and a box/)
    await refused([{ ...sig(), box: { x: 'a', y: 0, width: 1, height: 1 } }], /does not sit inside/)
    await refused([sig({ label: 'x'.repeat(81) })], /label is over 80/)
    await refused({ not: 'a list' }, /list of fields/)
    await refused(['nope'], /not a field/)
  })

  test('no more than the most fields', async () => {
    await refused(Array.from({ length: 201 }, () => sig()), /201 fields; the most is 200/)
  })

  test('a field of the PDF\'s own takes its page and box from the file, whatever the request says, and is used once', async () => {
    const doc = await uploaded(h, 'w9', { clientId: client.id })
    const own = doc.own_fields.find((s) => s.kind === 'text')!
    const r = await put(doc.id, [{ recipient: 1, type: 'text', page: 3, box: { x: 0.01, y: 0.01, width: 0.1, height: 0.1 }, required: true, label: 'Name', pdfFieldName: own.name }, sig({ recipient: 1 })])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const saved = r.body.fields.find((f: PreparedField) => f.pdfFieldName === own.name)
    expect(saved.page).toBe(own.page)
    expect(saved.box).toEqual(own.box)
    const twice = await put(doc.id, [{ recipient: 1, type: 'text', page: 0, box: own.box, pdfFieldName: own.name }, { recipient: 2, type: 'text', page: 0, box: own.box, pdfFieldName: own.name }])
    expect(twice.status).toBe(400)
    expect(twice.body.error).toContain('already fills')
  })

  test('a PDF field cannot become a type it does not take, and one that is not offered cannot be named', async () => {
    const doc = await uploaded(h, 'w9', { clientId: client.id })
    const text = doc.own_fields.find((s) => s.kind === 'text')!
    const box = doc.own_fields.find((s) => s.kind === 'checkbox')!
    const wrongType = await put(doc.id, [{ recipient: 1, type: 'checkbox', page: 0, box: text.box, pdfFieldName: text.name }])
    expect(wrongType.status).toBe(400)
    expect(wrongType.body.error).toContain('takes text or date')
    expect((await put(doc.id, [{ recipient: 1, type: 'text', page: 0, box: box.box, pdfFieldName: 'no such field' }])).body.error).toContain('does not have')
    const limited = doc.left_as_is.find((u) => /at most/.test(u.reason))!
    expect((await put(doc.id, [{ recipient: 1, type: 'text', page: 0, box: text.box, pdfFieldName: limited.name }])).status).toBe(400)
    // A date can fill a text field of the file; a signature field takes initials too.
    expect((await put(doc.id, [{ recipient: 1, type: 'date', page: 0, box: text.box, pdfFieldName: text.name }])).status).toBe(200)
  })

  test('a document can be renamed, and deleted until an envelope points at it', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id, name: 'First' })
    expect((await h.tessa('PATCH', `/admin/api/documents/${doc.id}`, { name: 'Second' })).body.name).toBe('Second')
    expect((await h.tessa('PATCH', `/admin/api/documents/${doc.id}`, { name: '  ' })).status).toBe(400)
    await put(doc.id, [sig()])
    const made = await draftFrom(doc.id, [ALICE])
    expect(made.status).toBe(201)
    const refused = await h.tessa('DELETE', `/admin/api/documents/${doc.id}`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('1 envelope was made from this document')
    expect(h.files().objects.has(`sources/${doc.id}/working`)).toBe(true)
    // Once the envelope is deleted, so can the document be, with its files and its key.
    expect((await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/purge`)).body.purged).toBe(true)
    expect((await h.tessa('DELETE', `/admin/api/documents/${doc.id}`)).status).toBe(200)
    expect([...h.files().objects.keys()].filter((key) => key.startsWith('sources/'))).toEqual([])
    expect(h.sql('SELECT id FROM source_documents')).toHaveLength(0)
    expect(h.sql("SELECT action FROM audit WHERE entity = 'source_documents' ORDER BY id").map((a: any) => a.action)).toEqual(['upload', 'rename', 'place-fields', 'delete'])
    expect((await h.tessa('GET', `/admin/api/documents/${doc.id}`)).status).toBe(404)
  })
})

describe('sending a document', () => {
  test('becomes a prepared document: the working copy, as placed, each signer\'s fields on their own; the original stays named by its hash', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id, name: 'Lease' })
    await put(doc.id, [sig(), sig({ recipient: 2, page: 1, box: { x: 0.2, y: 0.5, width: 0.3, height: 0.06 } }), sig({ recipient: 2, type: 'checkbox', page: 1, box: { x: 0.1, y: 0.5, width: 0.03, height: 0.03 }, label: 'Agree' })])
    const made = await draftFrom(doc.id, [ALICE, BOB])
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.envelope).toMatchObject({ kind: 'document', title: 'Lease', status: 'draft' })
    const id = made.body.envelope.id as string
    const [env] = h.sql<{ prepared_sha256: string; source_document_id: string }>('SELECT prepared_sha256, source_document_id FROM envelopes WHERE id = ?', id)
    expect(env!.source_document_id).toBe(doc.id)
    const [working] = h.sql<{ working_sha256: string }>('SELECT working_sha256 FROM source_documents WHERE id = ?', doc.id)
    expect(env!.prepared_sha256).toBe(working!.working_sha256)
    const rows = h.sql<{ position: number; type: string; page: number }>('SELECT r.position, f.type, f.page FROM fields f JOIN recipients r ON r.id = f.recipient_id WHERE f.envelope_id = ? ORDER BY r.position, f.type', id)
    expect(rows).toEqual([{ position: 1, type: 'signature', page: 0 }, { position: 2, type: 'checkbox', page: 1 }, { position: 2, type: 'signature', page: 1 }])
    expect(h.sql<{ details: string }>("SELECT details FROM events WHERE envelope_id = ? AND action = 'created'", id)[0]!.details).toContain('"fields":3')
    // The same document sends again, to someone else, as its own envelope.
    await put(doc.id, [sig()])
    expect((await draftFrom(doc.id, [ALICE])).status).toBe(201)
    expect(h.sql('SELECT id FROM envelopes')).toHaveLength(2)
    expect((await h.tessa('GET', `/admin/api/documents/${doc.id}`)).body.envelopes).toBe(2)
  })

  test('the people named must be the signers the fields were placed for, said in words', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id, name: 'Lease' })
    expect((await draftFrom(doc.id, [ALICE])).body.error).toContain('no fields yet')
    await put(doc.id, [sig(), sig({ recipient: 2, page: 1 })])
    const one = await draftFrom(doc.id, [ALICE])
    expect(one.status).toBe(400)
    expect(one.body.error).toBe('Lease has fields for signers 1 and 2, but one signer is named. Name 2 signers, or change who the fields belong to.')
    await put(doc.id, [sig()])
    const two = await draftFrom(doc.id, [ALICE, BOB])
    expect(two.status).toBe(400)
    expect(two.body.error).toBe('Lease has no fields for signer 2. Remove that signer, or place fields for them.')
    expect(h.sql('SELECT id FROM envelopes')).toHaveLength(0)
  })

  test('another client\'s document, an unknown one, and none at all are refused', async () => {
    const other = await h.makeClient({ slug: 'someone-else', display_name: 'Someone Else' })
    const doc = await uploaded(h, 'letter', { clientId: other.id })
    await put(doc.id, [sig()])
    expect((await draftFrom(doc.id, [ALICE])).body.error).toContain('is not one of Pinecrest')
    expect((await draftFrom(crypto.randomUUID(), [ALICE])).status).toBe(400)
    const none = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'document' }, recipients: [ALICE] })
    expect(none.body.error).toContain('Choose which document')
    // The built-in sample's own source document cannot be sent as an upload.
    const sample = await k.draft({ client })
    const [row] = h.sql<{ id: string; uploaded_by: string }>("SELECT id, uploaded_by FROM source_documents WHERE uploaded_by = ?", SAMPLE_SOURCE_OWNER)
    expect(row!.uploaded_by).toBe(SAMPLE_SOURCE_OWNER)
    expect((await draftFrom(row!.id, [ALICE])).status).toBe(400)
    expect(sample.id).toBeTruthy()
  })

  test('a working copy that no longer matches its hash is not sent', async () => {
    const doc = await uploaded(h, 'letter', { clientId: client.id })
    await put(doc.id, [sig()])
    h.sql("UPDATE source_documents SET working_sha256 = 'tampered' WHERE id = ?", doc.id)
    const r = await draftFrom(doc.id, [ALICE])
    expect(r.status).toBe(500)
    expect(h.sql('SELECT id FROM envelopes')).toHaveLength(0)
  })
})

describe('signing a document: the value lands where the operator put the field', () => {
  const TOL = 3
  for (const name of ['letter', 'rot90', 'rot180', 'rot270', 'mixed', 'cropoffset'] as const) {
    test.skipIf(!hasPoppler)(`${name}: a signature on every page is drawn inside its box, on the page as shown`, async () => {
      const doc = await uploaded(h, name, { clientId: client.id, name })
      const fields: PreparedField[] = doc.inspection.pages.map((p) => sig({ page: p.index, box: { x: 0.12 + 0.05 * p.index, y: 0.2 + 0.12 * (p.index % 3), width: 0.34, height: 0.07 }, label: `Page ${p.index + 1}` }))
      expect((await put(doc.id, fields)).status).toBe(200)
      const made = await draftFrom(doc.id, [ALICE])
      await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
      expect(await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')).toBe('complete')
      const pages = renderPages(k.attachment(ALICE.email))
      doc.inspection.pages.forEach((shown, i) => {
        const raster = pages[i]!
        expect(Math.abs(raster.width - shown.width)).toBeLessThanOrEqual(1)
        expect(Math.abs(raster.height - shown.height)).toBeLessThanOrEqual(1)
        const b = fields[i]!.box
        const want = { x0: b.x * shown.width, y0: b.y * shown.height, x1: (b.x + b.width) * shown.width, y1: (b.y + b.height) * shown.height }
        const found = findColor(raster, [20, 30, 120], 20)
        expect(found, `${name} page ${i + 1}`).not.toBeNull()
        // The picture keeps its proportions inside the box: its middle is the box's middle and it never leaves the box.
        expect(Math.abs((found!.x0 + found!.x1) / 2 - (want.x0 + want.x1) / 2), `${name} p${i + 1} centre x`).toBeLessThanOrEqual(TOL)
        expect(Math.abs((found!.y0 + found!.y1) / 2 - (want.y0 + want.y1) / 2), `${name} p${i + 1} centre y`).toBeLessThanOrEqual(TOL)
        expect(found!.x0).toBeGreaterThanOrEqual(want.x0 - TOL)
        expect(found!.x1).toBeLessThanOrEqual(want.x1 + TOL)
        expect(found!.y0).toBeGreaterThanOrEqual(want.y0 - TOL)
        expect(found!.y1).toBeLessThanOrEqual(want.y1 + TOL)
      })
    }, 60_000)
  }

  test('the W-9: the PDF\'s own fields take the signer\'s line and the date, a checkbox is checked in its own box, and each value appears once', async () => {
    const doc = await uploaded(h, 'w9', { clientId: client.id, name: 'W-9' })
    const [name, date] = doc.own_fields.filter((s) => s.kind === 'text' && s.page === 0)
    const checkbox = doc.own_fields.find((s) => s.kind === 'checkbox' && s.page === 0)!
    const r = await put(doc.id, [
      { recipient: 1, type: 'text', page: 0, box: name!.box, required: true, label: 'Name', pdfFieldName: name!.name },
      { recipient: 1, type: 'date', page: 0, box: date!.box, required: true, label: 'Date', pdfFieldName: date!.name },
      { recipient: 1, type: 'checkbox', page: 0, box: checkbox.box, required: true, label: 'Individual', pdfFieldName: checkbox.name },
      sig({ box: { x: 0.1, y: 0.86, width: 0.3, height: 0.04 } }),
    ])
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const made = await draftFrom(doc.id, [ALICE])
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
    expect(await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')).toBe('complete')
    const pdf = await PDF.load(k.attachment(ALICE.email))
    const first = pdf.getPage(0)!.extractText().text
    expect(first.match(/Alice Example/g)).toHaveLength(1)
    expect(first.match(/Oct 31, 2026/g)).toHaveLength(1)
    expect(pdf.getPageCount()).toBeGreaterThan(6)
  })

  test('a document is signed by two people in order, each with their own fields, and the certificate names the original by hash', async () => {
    const bytes = await fixtureBytes('mixed')
    const doc = await uploaded(h, bytes, { clientId: client.id, name: 'Mixed' })
    await put(doc.id, [sig(), sig({ recipient: 2, page: 2, box: { x: 0.3, y: 0.3, width: 0.3, height: 0.05 } })])
    const made = await draftFrom(doc.id, [ALICE, BOB])
    await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
    expect(await k.signAs(k.tokenFor(ALICE.email), 'Alice Example')).toBe('signed')
    expect(await k.signAs(k.tokenFor(BOB.email), 'Bob Preparer')).toBe('complete')
    const cert = await h.tessa('GET', `/admin/api/envelopes/${made.body.envelope.id}/certificate`)
    expect(JSON.stringify(cert.body.summary)).toContain(await sha256Hex(bytes))
    expect(k.actions(made.body.envelope.id).filter((a) => a === 'completed')).toHaveLength(1)
  })

  test('a signer is shown the working copy exactly as it was prepared: the document endpoint serves bytes whose hash is the recorded one', async () => {
    const doc = await uploaded(h, 'rot90', { clientId: client.id })
    await put(doc.id, [sig()])
    const made = await draftFrom(doc.id, [ALICE])
    await h.tessa('POST', `/admin/api/envelopes/${made.body.envelope.id}/send`)
    const s = k.as(k.tokenFor(ALICE.email))
    await s('POST', '/open')
    await s('POST', '/consent')
    const res = await s('GET', '/document')
    expect(res.status).toBe(200)
    const shown = new Uint8Array(await res.res.arrayBuffer())
    const [row] = h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes WHERE id = ?', made.body.envelope.id)
    expect(await sha256Hex(shown)).toBe(row!.prepared_sha256)
  })
})

describe('the fixtures', () => {
  test('every fixture the engine opens is either accepted or refused for a stated reason, never a crash', async () => {
    for (const name of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
      if (name === 'scan' || name === 'tooLarge') continue
      const f = FIXTURES[name]!
      const r = await upload(h, name, { clientId: client.id, password: f.password, confirm: ['restrictions', 'signatures'] })
      if (f.expect.ok) expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(201)
      else expect(r.status, name).toBe(422)
    }
  })

  test('the pages recorded at upload are the pages of the stored working copy, on every fixture', async () => {
    const { inspect } = await import('../src/pdf/engine')
    for (const name of ['letter', 'rot90', 'rot180', 'rot270', 'mixed', 'cropoffset', 'w9', 'restricted', 'passwordOpened'] as const) {
      const f = FIXTURES[name]!
      const doc = await uploaded(h, name === 'passwordOpened' ? 'password' : name, { clientId: client.id, password: f.password, confirm: ['restrictions'] })
      const row = h.sql<{ wrapped_key: string; key_version: number }>('SELECT wrapped_key, key_version FROM source_documents WHERE id = ?', doc.id)[0]!
      const key = await h.core().vault.unwrap(row.wrapped_key, row.key_version, `source:${doc.id}`)
      const { getSealed } = await import('../src/vault')
      const working = (await getSealed(h.files(), `sources/${doc.id}/working`, key))!
      const again = await inspect(working)
      expect(again.ok, name).toBe(true)
      if (!again.ok) continue
      expect(again.value.pages.map(({ index, width, height, rotation }) => ({ index, width, height, rotation })), name).toEqual(doc.inspection.pages.map(({ index, width, height, rotation }) => ({ index, width, height, rotation })))
      expect(again.value.fields.map((x) => [x.name, x.page, x.box]), name).toEqual(doc.inspection.fields.map((x) => [x.name, x.page, x.box]))
    }
  })
})
