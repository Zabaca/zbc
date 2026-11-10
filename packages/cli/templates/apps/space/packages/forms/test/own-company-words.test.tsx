// Where an install's Forms sends only for its own company (Corin's space sends Pinecrest Roofing's documents through Forms that
// Pinecrest Roofing runs), there is no second party: no "via", and no sentence says someone else runs the service. The flag is the declaration's `formsService.ownCompanyOnly`; without it (Northfield's, and
// Brightwater's in service-words.test.ts) every sentence is as it was. This suite runs the same sentences on an invented company that declares the flag, and once more on Northfield's and Brightwater's pages to hold them.
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { createFormsClientNames, ownCompanyProblem } from '../src/client-names'
import { consentParagraphs, consentTextFor } from '../src/consent'
import { FOOTER, renderMail, senderFor } from '../src/mail'
import { certificateBlocks, certificateModel } from '../src/pdf/certificate'
import { sealSubject, viaSuffix } from '../src/service'
import { Landing, Privacy } from '../src/public/service-pages'
import { harness } from './harness'
import { kit } from './signing-kit'
import { BRIGHTWATER_OWN_DECLARATION, BRIGHTWATER_OWN_WORDS, BRIGHTWATER_WORDS, NORTHFIELD_WORDS } from './words'

const NORTHFIELD = /northfield|tessa/i
const VIA = /\bvia\b/i
const SEPARATE_PARTY = /runs the service for|runs the service and is not a party|on behalf of|is the service that sealed|never a party|not a party|is the service, not a party|builds websites/
const own = { display_name: 'Brightwater Builders', legal_name: 'Brightwater Builders Inc.', reply_to: 'ada@brightwater.example', title: 'Contract' }

describe('an install whose Forms sends only for its own company names no second party anywhere', () => {
  test('the flag reaches the words only when declared, and nothing else of them moves', () => {
    expect('ownCompanyOnly' in NORTHFIELD_WORDS).toBe(false)
    expect('ownCompanyOnly' in BRIGHTWATER_WORDS).toBe(false)
    // The company is the runner, by its name as well as its legal name (the declaration refuses a flag on any other runner).
    expect(BRIGHTWATER_OWN_WORDS).toEqual({ ...BRIGHTWATER_WORDS, runBy: { ...BRIGHTWATER_WORDS.runBy, name: 'Brightwater Builders' }, ownCompanyOnly: true })
    expect(viaSuffix(BRIGHTWATER_OWN_WORDS)).toBe('')
    expect(viaSuffix(BRIGHTWATER_WORDS)).toBe('via Brightwater Forms')
  })

  test('the email is from the business’s own name, with no “via” in the header or the footer', () => {
    expect(senderFor('Brightwater Builders', BRIGHTWATER_OWN_WORDS)).toEqual({ email: 'forms@brightwater.example', name: 'Brightwater Builders' })
    expect(senderFor(null, BRIGHTWATER_OWN_WORDS)).toEqual({ email: 'forms@brightwater.example', name: 'Brightwater Forms' })
    const footer = 'Sent through Brightwater Forms by Brightwater Builders Inc., Duluth, Minnesota.'
    expect(FOOTER('Brightwater Builders', BRIGHTWATER_OWN_WORDS)).toBe(footer)
    // A legal name that ends in a period ("Inc.") and no mailing line does not double it.
    expect(FOOTER('Brightwater Builders', { ...BRIGHTWATER_OWN_WORDS, runBy: { ...BRIGHTWATER_OWN_WORDS.runBy, mailingLine: '' } })).toBe('Sent through Brightwater Forms by Brightwater Builders Inc.')
    for (const kind of ['request', 'reminder', 'turn', 'completed', 'declined', 'cancelled', 'expired', 'notice'] as const) {
      const m = renderMail({ kind, service: BRIGHTWATER_OWN_WORDS, brand: { name: 'Brightwater Builders', accent: '#1f4e79', logoUrl: null, replyTo: 'ada@brightwater.example' }, title: 'Contract', toName: 'Alice', link: 'https://space.brightwater.example/s/abc', delivery: 'attached' })
      expect(m.text.endsWith(footer), kind).toBe(true)
      for (const s of [m.subject, m.text, m.html]) {
        expect(s, kind).not.toMatch(VIA)
        expect(s, kind).not.toMatch(SEPARATE_PARTY)
        expect(s, kind).not.toMatch(NORTHFIELD)
      }
    }
  })

  test('the current consent says the business runs the service itself and not that someone else does; the frozen first version is the same words for every install', () => {
    const now = consentParagraphs({ ...own, service: BRIGHTWATER_OWN_WORDS })
    expect(now[0]).toBe('Brightwater Builders (Brightwater Builders Inc.) is using Brightwater Forms, which it runs itself, to send you Contract to sign electronically.')
    for (const s of now) {
      expect(s).not.toMatch(VIA)
      expect(s).not.toMatch(SEPARATE_PARTY)
    }
    // No envelope of an own-company install ever recorded the first consent version (it was current only before the flag), so that version is never edited for it.
    expect(consentTextFor('2026-10-31.1', { ...own, service: BRIGHTWATER_OWN_WORDS })![0]).toContain('runs the service for Brightwater Builders; it is not a party to what you sign.')
    // Everything after the first sentence is what any business is shown.
    expect(now.slice(1)).toEqual(consentParagraphs({ ...own, service: BRIGHTWATER_WORDS }).slice(1))
  })

  test('the certificate, its band and its seal paragraph name no second party', () => {
    const m = certificateModel({
      client: { display_name: 'Brightwater Builders', legal_name: 'Brightwater Builders Inc.', time_zone: 'America/Chicago' },
      envelope: { id: 'e1', title: 'Contract', kind: 'document', order_mode: 'sequential', created_at: '2026-11-01T20:00:00.000Z', sent_at: '2026-11-01T20:00:00.000Z', completed_at: '2026-11-01T21:00:00.000Z', prepared_sha256: 'a'.repeat(64), original_sha256: null },
      sent: { by: 'operator', agent: false, instruction_sha256: null },
      recipients: [],
      consents: [],
      events: [{ seq: 1, at: '2026-11-01T20:00:00.000Z', action: 'sealing', actor_kind: 'system', actor_name: null, actor_email: null, ip: null, device: null, details: '{}' } as never],
      seal: { subject: sealSubject(BRIGHTWATER_OWN_WORDS), rootFingerprint: 'r'.repeat(64) },
      service: BRIGHTWATER_OWN_WORDS,
      principal: 'Ada Brightwater',
    })
    expect(m.sealParagraph).toContain('This document was sealed by Brightwater Forms on')
    expect(JSON.stringify(m)).not.toMatch(VIA)
    expect(JSON.stringify(m)).not.toMatch(SEPARATE_PARTY)
    const pages = certificateBlocks(m, { color: [0, 0, 0], via: viaSuffix(BRIGHTWATER_OWN_WORDS) }, new Map())
    expect(pages.brand?.via).toBe('')
  })

  describe('the landing page and the privacy notice', () => {
    const page = (el: React.ReactElement) =>
      renderToStaticMarkup(el)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, ' ')
    beforeAll(() => {
      ;(globalThis as { location?: unknown }).location = { origin: 'https://space.brightwater.example' }
    })

    test('read as the company using its own signing service, with Cloudflare still named as the host', () => {
      const landing = page(<Landing s={BRIGHTWATER_OWN_WORDS} />)
      const privacy = page(<Privacy s={BRIGHTWATER_OWN_WORDS} />)
      for (const t of [landing, privacy]) {
        expect(t).not.toMatch(VIA)
        expect(t).not.toMatch(SEPARATE_PARTY)
        expect(t).not.toMatch(NORTHFIELD)
        expect(t).toContain('Brightwater Forms')
      }
      expect(landing).toContain('Brightwater Forms is how Brightwater Builders collects signed forms and agreements from its customers.')
      expect(landing).toContain('An email from “Brightwater Builders”, sent from forms@brightwater.example. Replying reaches Brightwater Builders.')
      expect(landing).toContain('Who keeps the record')
      expect(landing).toContain('Brightwater Forms is the signing service of Brightwater Builders.')
      expect(privacy).toContain('Brightwater Builders sent you something to sign through Brightwater Forms')
      expect(privacy).toContain('Brightwater Builders runs the service itself')
      expect(privacy).toContain('Cloudflare, which hosts the service')
      expect(privacy).toContain('write to Brightwater Builders at office@brightwater.example')
    })

    test('and for an install that sends for its clients (Northfield Works, Brightwater without the flag) they say what they always said', () => {
      const landing = page(<Landing s={NORTHFIELD_WORDS} />)
      expect(landing).toContain('Northfield Forms is how the businesses Northfield Works builds websites for collect signed forms and agreements from their customers.')
      expect(landing).toContain('An email from “the business’s name via Northfield Forms”, sent from forms@northfield.example. Replying reaches the business.')
      expect(landing).toContain('Northfield Works is the service, not a party')
      expect(landing).toContain('Northfield Forms is run by Northfield Works LLC for the businesses it builds websites for.')
      const privacy = page(<Privacy s={NORTHFIELD_WORDS} />)
      expect(privacy).toContain('Northfield Works LLC runs the service for the businesses it builds websites for. The business that sent you the document decides what it asks and why; Northfield Works keeps the record for it.')
      expect(privacy).toContain('The business that sent the document and the people named on it; the Northfield Works people who run the service; and Cloudflare')
      expect(privacy).toContain('does not use it for anything but running this service for the business that sent you the document.')
      expect(privacy).toContain('ask the business that sent you the document; it decides what it must keep. You can also write to Northfield Works at info@northfield.example')
      expect(page(<Landing s={BRIGHTWATER_WORDS} />)).toContain('Brightwater is the service, not a party')
    })
  })

  describe('through the Worker', () => {
    const h = harness({}, createInstall({ ...BRIGHTWATER_OWN_DECLARATION }))
    const k = kit(h)
    beforeEach(() => h.reset())

    test('a document is sent from the business’s own name, consented to without a second party, signed and finished, and nothing a signer is sent or shown says “via” or names another runner', async () => {
      const client = await h.makeClient({ display_name: 'Brightwater Builders', legal_name: 'Brightwater Builders Inc.', reply_to: 'ada@brightwater.example', copy_addresses: [] })
      const { id } = await k.sent({ client })
      expect(h.outbox[0]!.from).toEqual({ email: 'forms@brightwater.example', name: 'Brightwater Builders' })
      const view = (await k.as(k.tokenFor('alice@example.test'))('GET', '')).body
      expect(view.consent.paragraphs[0]).toContain('is using Brightwater Forms, which it runs itself, to send you')
      expect(JSON.stringify(view)).not.toMatch(VIA)
      expect(JSON.stringify(view.consent)).not.toMatch(SEPARATE_PARTY)
      await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')
      await k.signAs(k.tokenFor('bob@example.test'), 'Bob Preparer')
      expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('completed')
      expect(h.outbox.length).toBeGreaterThan(2)
      for (const m of h.outbox) {
        expect([m.from.name, m.subject, m.text, m.html].join('\n')).not.toMatch(VIA)
        expect([m.text, m.html].join('\n')).not.toMatch(SEPARATE_PARTY)
        expect([m.from.email, m.from.name, m.subject, m.text, m.html].join('\n')).not.toMatch(NORTHFIELD)
      }
      const pdf = await k.text(k.attachment('alice@example.test'))
      expect(pdf).toContain('Certificate of completion')
      expect(pdf).not.toMatch(VIA)
      expect(pdf).not.toMatch(SEPARATE_PARTY)
    })

    test('signing is set up for the company and for no other business, so the words never describe one as the other', async () => {
      await expect(h.makeClient({ display_name: 'Harbor Co', legal_name: 'Harbor Company LLC' })).rejects.toThrow("sends only for Brightwater Builders, so signing can be set up only for Brightwater Builders. Harbor Co is another business.")
      expect(h.sql('SELECT id FROM clients')).toEqual([])
      // Both names must be the company's: the name alone, or the legal name alone, is another business.
      await expect(h.makeClient({ display_name: 'Brightwater Builders', legal_name: 'Harbor LLC' })).rejects.toThrow('is another business')
      await expect(h.makeClient({ display_name: 'Pinecrest', legal_name: 'Brightwater Builders Inc.' })).rejects.toThrow('is another business')
      expect(h.sql('SELECT id FROM clients')).toEqual([])
      await expect(h.makeClient({ display_name: 'brightwater builders', legal_name: 'Brightwater Builders Inc.' })).resolves.toMatchObject({ display_name: 'brightwater builders' })
    })

    test('renaming the company’s Client into another business, from the Clients part, is refused too, and a rename that keeps it the company goes through', async () => {
      const client = await h.makeClient({ display_name: 'Brightwater Builders', legal_name: 'Brightwater Builders Inc.' })
      const seam = createFormsClientNames({ db: h.env().DB, now: () => Date.parse('2026-11-08T12:00:00Z'), service: BRIGHTWATER_OWN_WORDS })
      const names = { name: 'Harbor Co', legalName: 'Harbor Company LLC' }
      expect(await seam.check(names)).toMatchObject({ ok: false, reason: 'bad-request' })
      expect(await seam.setNames(client.client_number, names, 'clients:test')).toMatchObject({ ok: false, reason: 'bad-request' })
      expect(h.sql<{ display_name: string }>('SELECT display_name FROM clients')[0]!.display_name).toBe('Brightwater Builders')
      expect(await seam.setNames(client.client_number, { name: 'Brightwater Builders', legalName: 'BRIGHTWATER BUILDERS INC.' }, 'clients:test')).toMatchObject({ ok: true })
      // Without the install's words (an install that sends for its clients) the same rename is allowed, as it always was.
      const open = createFormsClientNames({ db: h.env().DB, now: () => Date.parse('2026-11-08T12:00:00Z') })
      expect(await open.setNames(client.client_number, names, 'clients:test')).toMatchObject({ ok: true })
    })

    test('the table of names the rule accepts and refuses', () => {
      const ok = (name: string, legalName: string | null) => ownCompanyProblem(BRIGHTWATER_OWN_WORDS, { name, legalName })
      expect(ok('Brightwater Builders', 'Brightwater Builders Inc.')).toBeNull()
      expect(ok('Brightwater Builders', null)).toBeNull()
      expect(ok('Pinecrest', 'Harbor LLC')).not.toBeNull()
      expect(ok('Brightwater Builders', 'Harbor LLC')).not.toBeNull()
      expect(ok('Harbor Co', 'Brightwater Builders Inc.')).not.toBeNull()
      expect(ownCompanyProblem(BRIGHTWATER_WORDS, { name: 'Harbor Co', legalName: 'Harbor LLC' })).toBeNull()
      expect(ownCompanyProblem(undefined, { name: 'Harbor Co', legalName: 'Harbor LLC' })).toBeNull()
    })

    test('the Send screen’s preview is from the business’s own name, and the service’s public names carry the flag to the pages', async () => {
      const mine = await k.draft({ client: await h.makeClient({ display_name: 'Brightwater Builders', legal_name: 'Brightwater Builders Inc.', reply_to: 'ada@brightwater.example' }) })
      const r = await h.tessa('GET', `/admin/api/envelopes/${mine.id}/preview-email`)
      expect(r.body.from).toBe('Brightwater Builders <forms@brightwater.example>')
      const svc = await h.call(null, 'GET', '/s/api/service', undefined, { headers: { 'cf-connecting-ip': '203.0.113.7' } })
      expect(svc.body).toEqual(BRIGHTWATER_OWN_WORDS)
    })
  })
})
