// The wording a legal read asked to change before a first client, pinned: the consent text and its versions, the typed-name-only mode, the email warnings
// and footer, the certificate's agent line and printed consent, and the operator's list of what not to send. The browser
// shows the rest (the decline dialog, the privacy notice, the Send screen): e2e/signer.test.ts.
import { PDF } from '@libpdf/core'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { CONSENT_VERSION, consentHash, consentHashOf, consentParagraphs, consentTextFor, intentText } from '../src/consent'
import { sha256Hex } from '../src/bytes'
import { stableJson } from '../src/events'
import { escapeHtml, renderMail } from '../src/mail'
import { type CertificateInput, certificateBlocks, certificateModel } from '../src/pdf/certificate'
import { SEND_WARNING_ITEMS, sendWarningHeading } from '../src/sendWarning'
import { draftFingerprint } from '../src/signing/rules'
import { harness } from './harness'
import { hasTool } from './render'
import { BRIGHTWATER_WORDS, NORTHFIELD_WORDS } from './words'
import { ALICE, BOB, kit, png } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const lane = { display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', title: 'Engagement letter', service: NORTHFIELD_WORDS }

describe('A2: the consent text, in versions', () => {
  test('the current version has the eight paragraphs, with the business, its legal name, the title, the paper address and the sample link', () => {
    const p = consentParagraphs(lane)
    expect(p).toHaveLength(8)
    expect(p[0]).toBe('Pinecrest (Pinecrest Roofing, CPAs) is using Northfield Forms to send you Engagement letter to sign electronically. Northfield Works LLC runs the service for Pinecrest; it is not a party to what you sign.')
    expect(p[1]).toContain('By selecting "I agree, continue" you agree to receive this document, the finished copy and any notices about it electronically')
    expect(p[2]).toContain('contact Pinecrest at office@pinecrest.example. Pinecrest does not charge for paper copies or for withdrawing your consent.')
    expect(p[3]).toContain('after you sign, by contacting Pinecrest. Withdrawing does not undo anything already signed or delivered electronically.')
    expect(p[4]).toBe('If your email address changes before this document is finished, tell Pinecrest at office@pinecrest.example so the link can go to your new address.')
    expect(p[5]).toContain('Safari, Chrome, Edge or Firefox')
    expect(p[6]).toContain('a private link that works for 90 days')
    expect(p[7]).toBe('Open this sample PDF: [Open sample PDF]. By selecting "I agree, continue" you confirm that you could open it, that you can read this page on this device, and that you agree to the terms above.')
    expect(p.join('\n')).not.toContain('\u2014')
  })

  test('an older version still prints its own words, an unknown one prints nothing, and a changed word is a changed hash', async () => {
    const old = consentTextFor('2026-10-31.1', lane)!
    expect(old).toHaveLength(5)
    expect(old[0]).toBe('Pinecrest is using Northfield Forms to send you a document to sign electronically. Northfield Works runs the service for Pinecrest; it is not a party to what you sign.')
    expect(consentTextFor('1999-01-01.1', lane)).toBeNull()
    expect(consentTextFor(CONSENT_VERSION, lane)).toEqual(consentParagraphs(lane))
    expect(await consentHash(lane)).toBe(await consentHashOf(CONSENT_VERSION, consentParagraphs(lane)))
    expect(await consentHash({ ...lane, title: 'Other' })).not.toBe(await consentHash(lane))
    expect(await consentHashOf('2026-10-31.1', old)).not.toBe(await consentHash(lane))
  })

  test('a signer is shown the current text and, on agreeing, its version and hash are recorded', async () => {
    const { id } = await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    const view = (await s('GET', '')).body
    expect(view.state).toBe('consent')
    expect(view.consent.version).toBe(CONSENT_VERSION)
    expect(view.consent.paragraphs).toEqual(consentParagraphs({ service: NORTHFIELD_WORDS, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', title: 'Sample document for Pinecrest' }))
    expect((await s('POST', '/consent')).status).toBe(200)
    const consented = JSON.parse(k.events(id).find((e) => e.action === 'consented')!.details)
    expect(consented).toEqual({ version: CONSENT_VERSION, text_sha256: await consentHash({ service: NORTHFIELD_WORDS, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', reply_to: 'office@pinecrest.example', title: 'Sample document for Pinecrest' }) })
  })

  test('the sample PDF opens and each opening at the consent step is an event; the terms PDF carries the text and its version and is no event', async () => {
    const { id } = await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    const sample = await s('GET', '/sample.pdf')
    expect(sample.status).toBe(200)
    expect(sample.headers.get('content-type')).toBe('application/pdf')
    expect(await PDF.load(new Uint8Array(await sample.res.arrayBuffer())).then((p) => p.getPages().length)).toBe(1)
    const terms = await s('GET', '/terms.pdf')
    expect(terms.status).toBe(200)
    expect(terms.headers.get('content-type')).toBe('application/pdf')
    const text = (await k.text(new Uint8Array(await terms.res.arrayBuffer()))).replace(/\s+/g, ' ')
    expect(text).toContain('Terms for signing electronically')
    expect(text).toContain(`Version of these terms ${CONSENT_VERSION}`)
    expect(text).toContain('Pinecrest does not charge for paper copies')
    expect(k.actions(id).filter((a) => a === 'consent-sample-opened')).toHaveLength(1)
    // After consent, opening it again records nothing more.
    await s('POST', '/consent')
    await s('GET', '/sample.pdf')
    expect(k.actions(id).filter((a) => a === 'consent-sample-opened')).toHaveLength(1)
  })
})

describe('A3: the typed signature starts blank, and the typed-name-only mode', () => {
  test('the intent text is in the signer\'s own name, and Finish records its hash', async () => {
    expect(intentText('Alice Example')).toBe('I am Alice Example. By selecting Finish and sign, I adopt the signature shown as mine and agree it is the legal equivalent of my handwritten signature on this document.')
    const { id } = await k.sent({ recipients: [ALICE] })
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('POST', '/consent')
    expect((await s('GET', '')).body.intent).toBe(intentText('Alice Example'))
    expect((await s('GET', '')).body.typedOnly).toBe(false)
    await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')
    const { createHash } = await import('node:crypto')
    expect(JSON.parse(k.events(id).find((e) => e.action === 'signed')!.details).intent_sha256).toBe(createHash('sha256').update(intentText('Alice Example')).digest('hex'))
  })

  test('typed name only: the page is told, a drawn or uploaded picture is refused, a typed name is taken', async () => {
    const { id } = await k.sent({ recipients: [ALICE], extra: { typed_only: true } })
    expect(h.sql<{ typed_only: number }>('SELECT typed_only FROM envelopes WHERE id = ?', id)[0]!.typed_only).toBe(1)
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('POST', '/consent')
    expect((await s('GET', '')).body.typedOnly).toBe(true)
    for (const method of ['drawn', 'uploaded']) {
      const r = await s('POST', '/adopt', { kind: 'signature', method, image: png() })
      expect(r.status, method).toBe(400)
      expect(r.body.error).toContain('typing your own name')
    }
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'typed', image: png(), typed_text: 'Alice Example', typed_font: 'Dancing Script' })).status).toBe(200)
  })

  test('the mode is set on a draft, changes the draft\'s fingerprint, and is fixed once sent', async () => {
    const { id } = await k.draft({ recipients: [ALICE] })
    expect(h.sql<{ typed_only: number }>('SELECT typed_only FROM envelopes WHERE id = ?', id)[0]!.typed_only).toBe(0)
    const patched = await h.tessa('PATCH', `/admin/api/envelopes/${id}`, { typed_only: true })
    expect(patched.status).toBe(200)
    expect(patched.body.envelope.typed_only).toBe(1)
    await k.send(id)
    expect((await h.tessa('PATCH', `/admin/api/envelopes/${id}`, { typed_only: false })).status).toBe(409)
  })
})

describe('A3: the draft fingerprint', () => {
  const env = { client_id: 'c', kind: 'document' as const, title: 't', order_mode: 'sequential' as const, note: null, expires_in_days: 30, reminder_every_days: 3, reminder_max: 3, sensitive: 0, typed_only: 0, prepared_sha256: 'abc', form_version_id: null, source_document_id: 's' }
  const people = [{ position: 1, role: 'Client', name: 'A', email: 'a@x.test', kind: 'signer' as const }]

  test('a draft without the mode keeps the fingerprint it had before the mode existed, and the mode changes it', async () => {
    const before = await sha256Hex(stableJson({ client: 'c', kind: 'document', title: 't', document: 'abc', source: 's', order: 'sequential', note: '', expiresInDays: 30, reminder: [3, 3], sensitive: 0, recipients: [[1, 'signer', 'Client', 'A', 'a@x.test']] }))
    expect(await draftFingerprint(env, people)).toBe(before)
    expect(await draftFingerprint({ ...env, typed_only: 1 }, people)).not.toBe(before)
  })
})

describe('typed name only keeps a browser from putting its own picture on the page', () => {
  const imageCount = (pdf: Uint8Array): number => {
    const path = join(mkdtempSync(join(tmpdir(), 'forms-img-')), 'f.pdf')
    writeFileSync(path, pdf)
    const out = Bun.spawnSync(['pdfimages', '-list', path]).stdout.toString().trim().split('\n')
    return Math.max(0, out.length - 2)
  }

  /** A signer who claims a typed name in every request but sends a picture that was never rendered from it. */
  async function craftedSign(token: string, typed: string) {
    const s = k.as(token)
    expect((await s('POST', '/consent')).status).toBe(200)
    const view = await s('GET', '')
    const crafted = png(200, 0, 0)
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'typed', image: crafted, typed_text: typed, typed_font: 'Dancing Script' })).status).toBe(200)
    expect((await s('POST', '/adopt', { kind: 'initials', method: 'typed', image: crafted, typed_text: 'CN', typed_font: 'Dancing Script' })).status).toBe(200)
    for (const f of view.body.fields) {
      const value = f.type === 'signature' || f.type === 'initials' ? 'adopted' : f.type === 'text' ? typed : f.type === 'checkbox' ? true : undefined
      if (value !== undefined) expect((await s('PUT', `/fields/${f.id}`, { value })).status).toBe(200)
    }
    expect((await s('POST', '/finish', { intent: true })).status).toBe(200)
  }

  test.skipIf(!hasTool('pdfimages'))('an ordinary envelope stamps the signer\'s picture, a typed-name-only one stamps no picture at all, only the typed name as text', async () => {
    await k.sent({ recipients: [ALICE] })
    await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')
    expect(imageCount(k.attachment('alice@example.test'))).toBeGreaterThan(0)

    h.reset()
    await k.sent({ recipients: [ALICE], extra: { typed_only: true } })
    await craftedSign(k.tokenFor('alice@example.test'), 'Crafted Name')
    const finished = k.attachment('alice@example.test')
    expect(imageCount(finished)).toBe(0)
    expect((await k.text(finished)).match(/Crafted Name/g)!.length).toBeGreaterThanOrEqual(2)
  })

  test('a later signer sees an earlier typed name as text, and the earlier signer\'s picture is not served', async () => {
    const { id } = await k.sent({ extra: { typed_only: true } })
    const aliceToken = k.tokenFor('alice@example.test')
    await craftedSign(aliceToken, 'Crafted Name')
    const bob = k.as(k.tokenFor('bob@example.test'))
    await bob('POST', '/consent')
    const view = (await bob('GET', '')).body
    const sig = view.others.find((o: { type: string }) => o.type === 'signature')
    expect(sig).toMatchObject({ value: 'Crafted Name', picture: null })
    const alice = h.sql<{ id: string }>('SELECT id FROM recipients WHERE envelope_id = ? AND email = ?', id, 'alice@example.test')[0]!
    expect((await bob('GET', `/picture/${alice.id}/signature`)).status).toBe(404)
  })
})

describe('A4: the email warnings and the footer', () => {
  const brand = { name: 'Pinecrest', accent: '#1f4e79', logoUrl: null, replyTo: 'office@pinecrest.example' }
  const link = 'https://space.northfield.example/s/abc'
  const ALONE = 'This link is for you alone. Anyone who has it can open this document and sign it as you, so do not forward this email. If you were not expecting it, do not open the link; contact Pinecrest directly.'

  test('a request, a reminder and a turn each say the link is for the recipient alone', () => {
    for (const kind of ['request', 'reminder', 'turn'] as const) {
      const m = renderMail({ service: NORTHFIELD_WORDS, kind, brand, title: 'Letter', toName: 'Alice', link })
      expect(m.text, kind).toContain(ALONE)
      expect(m.html, kind).toContain(escapeHtml(ALONE))
    }
    for (const kind of ['completed', 'declined', 'cancelled', 'expired', 'notice'] as const) expect(renderMail({ service: NORTHFIELD_WORDS, kind, brand, title: 'Letter', toName: 'Alice', delivery: 'attached', headline: 'h', body: 'b' }).text, kind).not.toContain('This link is for you alone')
  })

  test('a completed email asks for a copy to be saved, and by link says until when, that each download is recorded and who to ask after', () => {
    expect(renderMail({ service: NORTHFIELD_WORDS, kind: 'completed', brand, title: 'Letter', toName: 'Alice', delivery: 'attached' }).text).toContain('The finished document is attached. Save a copy for your records.')
    const byLink = renderMail({ service: NORTHFIELD_WORDS, kind: 'completed', brand, title: 'Letter', toName: 'Alice', delivery: 'link', link, linkUntil: 'February 1, 2027' })
    expect(byLink.text).toContain('The link works until February 1, 2027, and each download is recorded. Download and save a copy before then; after that, ask Pinecrest for a copy.')
  })

  test('every email ends with who Northfield Works LLC is, where, and that it is not a party', () => {
    const footer = 'Sent through Northfield Forms (Northfield Works LLC, Alder Bend, Oregon) on behalf of Pinecrest. Northfield Works runs the service and is not a party to the document.'
    for (const kind of ['request', 'completed', 'declined', 'cancelled', 'expired', 'notice'] as const) {
      const m = renderMail({ service: NORTHFIELD_WORDS, kind, brand, title: 'Letter', toName: 'Alice', link, delivery: 'attached' })
      expect(m.text.endsWith(footer), kind).toBe(true)
      expect(m.html, kind).toContain(escapeHtml(footer))
    }
  })
})

describe('A7: the certificate names Claude and its principal, and prints the consent text', () => {
  const input = (over: Partial<CertificateInput> = {}): CertificateInput => ({
    client: { display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing, CPAs', time_zone: 'America/Los_Angeles' },
    envelope: { id: 'e1', title: 'Letter', kind: 'document', order_mode: 'sequential', created_at: '2026-11-01T20:00:00.000Z', sent_at: '2026-11-01T20:00:00.000Z', completed_at: '2026-11-01T21:00:00.000Z', prepared_sha256: 'a'.repeat(64), original_sha256: null },
    sent: { by: 'tessa@northfield.example', agent: true, instruction_sha256: 'f'.repeat(64) },
    recipients: [],
    consents: [{ version: CONSENT_VERSION, paragraphs: consentParagraphs(lane), note: null }, { version: '2026-10-31.1', paragraphs: consentTextFor('2026-10-31.1', lane), note: 'A note.' }, { version: '1999-01-01.1', paragraphs: null, note: null }],
    events: [],
    seal: { subject: 'Northfield Forms Seal', rootFingerprint: 'r'.repeat(64) },
    service: NORTHFIELD_WORDS,
    principal: 'Tessa Marlow',
    ...over,
  })

  test('an agent send reads as the paralegal wrote it, with the instruction fingerprint', () => {
    const sentBy = certificateModel(input()).summary.find(([k]) => k === 'Sent by')![1]
    expect(sentBy).toBe(`Sent by Claude, an AI assistant made by Anthropic and used by Northfield Works LLC, on the recorded instruction of Tessa Marlow, Northfield Works LLC, for Pinecrest (instruction ${'f'.repeat(64)})`)
    expect(certificateModel(input({ sent: { by: 'tessa@northfield.example', agent: false, instruction_sha256: null } })).summary.find(([k]) => k === 'Sent by')![1]).toBe('tessa@northfield.example')
  })

  test('every consent version is a heading with its full text, and a version no longer held says so', () => {
    const m = certificateModel(input())
    expect(m.consents.map((c) => c.heading)).toEqual(['The consent text, version 2026-11-01.1', 'The consent text, version 2026-10-31.1', 'The consent text, version 1999-01-01.1'])
    expect(m.consents[0]!.paragraphs).toHaveLength(8)
    expect(m.consents[1]!.paragraphs).toHaveLength(5)
    expect(m.consents[1]!.note).toBe('A note.')
    expect(m.consents[2]!.paragraphs).toEqual([])
    expect(m.consents[2]!.note).toContain('not held')
    const pages = certificateBlocks(m, { color: [0, 0, 0], via: 'via Northfield Forms' }, new Map())
    const text = pages.blocks.flatMap((b) => ('text' in b ? [b.text] : []))
    expect(text).toContain(consentParagraphs(lane)[0]!)
    expect(text).toContain(consentParagraphs(lane)[7]!)
  })
})

describe('A8: the operator\'s list of what not to send', () => {
  test('the heading and all eleven items are the paralegal\'s, in order, with no em dash', () => {
    expect(sendWarningHeading(NORTHFIELD_WORDS)).toBe("Do not send these through Northfield Forms without written OK from the client's lawyer:")
    expect(sendWarningHeading(BRIGHTWATER_WORDS)).toBe("Do not send these through Brightwater Forms without written OK from the client's lawyer:")
    expect(SEND_WARNING_ITEMS).toHaveLength(11)
    expect(SEND_WARNING_ITEMS[0]).toBe('wills, trusts, powers of attorney, or anything that needs a notary or witnesses;')
    expect(SEND_WARNING_ITEMS[7]).toBe('IRS Form 8879 or 8878 signed by finger or typed (an uploaded photo of a wet-ink signature is different), and IRS 2848 or 8821 for a new client;')
    expect(SEND_WARNING_ITEMS[10]).toBe('anything negotiated in Spanish, Chinese, Tagalog, Vietnamese or Korean that California requires to be translated.')
    for (const s of [sendWarningHeading(NORTHFIELD_WORDS), ...SEND_WARNING_ITEMS]) expect(s).not.toContain('\u2014')
  })
})
