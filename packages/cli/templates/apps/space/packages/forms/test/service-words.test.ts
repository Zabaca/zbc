// The names the service says about itself are the install's. Northfield's words are held by the suites that run on Northfield's declaration
// (signing.test.ts, signing-rules.test.ts, legal-gate.test.ts: "via Northfield Forms", forms@northfield.example, "Northfield Works LLC runs the service"); this one runs the same sentences on an invented company whose Forms is its own
// and proves that "Northfield Works", "Tessa" and northfield.example are said nowhere in what a signer is sent or shown.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createInstall, parseDeclaration } from '@space/workspace'
import { consentParagraphs, consentTextFor } from '../src/consent'
import { FOOTER, renderMail, senderFor } from '../src/mail'
import { certificateBlocks, certificateModel } from '../src/pdf/certificate'
import { claudeNotice, runnerPlace, sealReason, sealRootName, sealSubject, viaSuffix } from '../src/service'
import { serviceWordsOf } from '../src/workspace'
import { harness } from './harness'
import { kit } from './signing-kit'
import { BRIGHTWATER_DECLARATION, BRIGHTWATER_WORDS, NORTHFIELD_WORDS } from './words'

const NORTHFIELD = /northfield|tessa/i
const client = { display_name: 'Harbor Co', legal_name: 'Harbor Company LLC', reply_to: 'office@harbor.example', title: 'Engagement letter' }

describe('the service’s words, from the declaration', () => {
  test('Northfield’s are the ones every email, consent and seal said before they were declared', () => {
    expect(NORTHFIELD_WORDS).toEqual({
      name: 'Northfield Forms',
      contact: 'info@northfield.example',
      sender: 'forms@northfield.example',
      runBy: { name: 'Northfield Works', legalName: 'Northfield Works LLC', mailingLine: 'Alder Bend, Oregon', site: 'northfield.example' },
      company: { name: 'Northfield Works', legalName: 'Northfield Works LLC' },
      owner: 'Tessa Marlow',
    })
    expect([viaSuffix(NORTHFIELD_WORDS), sealReason(NORTHFIELD_WORDS), sealSubject(NORTHFIELD_WORDS), sealRootName(NORTHFIELD_WORDS), runnerPlace(NORTHFIELD_WORDS)]).toEqual([
      'via Northfield Forms',
      'Sealed by Northfield Forms',
      'Northfield Forms Seal',
      'Northfield Forms Root',
      'Northfield Works LLC, Alder Bend, Oregon',
    ])
  })

  test('another company’s are its own, and a declaration that says nothing has the company run its own service from its own domain', () => {
    expect(BRIGHTWATER_WORDS.name).toBe('Brightwater Forms')
    expect(BRIGHTWATER_WORDS.sender).toBe('forms@brightwater.example')
    const quiet = serviceWordsOf(
      createInstall({
        company: { id: 'quiet', name: 'Quiet Co', domain: 'quiet.example', timeZone: 'America/Chicago' },
        access: { teamDomain: 'example.cloudflareaccess.com' },
        space: { host: 'space.quiet.example', sessionDuration: '730h' },
        formsService: { contact: 'help@quiet.example' },
        people: [{ address: 'q@quiet.example', name: 'Q', role: 'owner' }],
      }),
    )
    expect(quiet).toEqual({ name: 'Quiet Co Forms', contact: 'help@quiet.example', sender: 'forms@quiet.example', runBy: { name: 'Quiet Co', legalName: 'Quiet Co', mailingLine: '', site: 'quiet.example' }, company: { name: 'Quiet Co', legalName: 'Quiet Co' }, owner: 'Q' })
    expect(runnerPlace(quiet)).toBe('Quiet Co')
  })

  test('a declaration that sends from another company’s domain, or sends both apps from one address, is refused', () => {
    const bad = (senders: unknown) => () => parseDeclaration({ ...BRIGHTWATER_DECLARATION, senders })
    expect(bad({ forms: 'forms@northfield.example' })).toThrow('is not on brightwater.example')
    expect(bad({ forms: 'same@brightwater.example', meet: 'same@brightwater.example' })).toThrow('each send from an address of their own')
    expect(() => parseDeclaration({ ...BRIGHTWATER_DECLARATION, formsService: { name: 'Two\nLines' } })).toThrow('formsService.name')
    expect(() => parseDeclaration({ ...BRIGHTWATER_DECLARATION, formsService: { contact: 'not an address' } })).toThrow('formsService.contact')
  })

  test('the service’s contact is published, so it is declared and never taken from the owner’s own address', () => {
    const { formsService: _declared, ...without } = BRIGHTWATER_DECLARATION
    expect(() => parseDeclaration(without)).toThrow('formsService.contact: required')
    expect(() => parseDeclaration({ ...without, formsService: { name: 'Brightwater Forms' } })).toThrow('formsService.contact: required')
  })
})

describe('what a signer is shown and sent, on another company’s install', () => {
  test('the consent, in both versions, names the install’s service and who runs it, with the sentences unchanged', () => {
    const now = consentParagraphs({ ...client, service: BRIGHTWATER_WORDS })
    expect(now[0]).toBe('Harbor Co (Harbor Company LLC) is using Brightwater Forms to send you Engagement letter to sign electronically. Brightwater Builders Inc. runs the service for Harbor Co; it is not a party to what you sign.')
    const old = consentTextFor('2026-10-31.1', { ...client, service: BRIGHTWATER_WORDS })!
    expect(old[0]).toBe('Harbor Co is using Brightwater Forms to send you a document to sign electronically. Brightwater runs the service for Harbor Co; it is not a party to what you sign.')
    expect([...now, ...old].join('\n')).not.toMatch(NORTHFIELD)
  })

  test('every email is from the install’s forms address as “<business> via <service>”, ends with who runs it and where, and names nobody of Northfield’s', () => {
    expect(senderFor('Harbor Co', BRIGHTWATER_WORDS)).toEqual({ email: 'forms@brightwater.example', name: 'Harbor Co via Brightwater Forms' })
    expect(senderFor(null, BRIGHTWATER_WORDS)).toEqual({ email: 'forms@brightwater.example', name: 'Brightwater Forms' })
    const footer = 'Sent through Brightwater Forms (Brightwater Builders Inc., Duluth, Minnesota) on behalf of Harbor Co. Brightwater runs the service and is not a party to the document.'
    expect(FOOTER('Harbor Co', BRIGHTWATER_WORDS)).toBe(footer)
    for (const kind of ['request', 'reminder', 'turn', 'completed', 'declined', 'cancelled', 'expired', 'notice'] as const) {
      const m = renderMail({ kind, service: BRIGHTWATER_WORDS, brand: { name: 'Harbor Co', accent: '#1f4e79', logoUrl: null, replyTo: 'office@harbor.example' }, title: 'Letter', toName: 'Alice', link: 'https://space.brightwater.example/s/abc', delivery: 'attached' })
      expect(m.text.endsWith(footer), kind).toBe(true)
      expect(m.html, kind).toContain('via Brightwater Forms')
      for (const s of [m.subject, m.text, m.html]) expect(s, kind).not.toMatch(NORTHFIELD)
    }
  })

  test('the certificate calls the service that sealed the document, and who Claude acted for, by the install’s names', () => {
    const m = certificateModel({
      client: { display_name: 'Harbor Co', legal_name: 'Harbor Company LLC', time_zone: 'America/Chicago' },
      envelope: { id: 'e1', title: 'Letter', kind: 'document', order_mode: 'sequential', created_at: '2026-11-01T20:00:00.000Z', sent_at: '2026-11-01T20:00:00.000Z', completed_at: '2026-11-01T21:00:00.000Z', prepared_sha256: 'a'.repeat(64), original_sha256: null },
      sent: { by: 'agent', agent: true, instruction_sha256: 'f'.repeat(64) },
      recipients: [],
      consents: [],
      events: [{ seq: 1, at: '2026-11-01T20:00:00.000Z', action: 'sealing', actor_kind: 'system', actor_name: null, actor_email: null, ip: null, device: null, details: '{}' } as never],
      seal: { subject: sealSubject(BRIGHTWATER_WORDS), rootFingerprint: 'r'.repeat(64) },
      service: BRIGHTWATER_WORDS,
      principal: 'Ada Brightwater',
    })
    const text = JSON.stringify(m)
    expect(m.sealParagraph).toContain('This document was sealed by Brightwater Forms on')
    expect(m.sealParagraph).toContain('was issued by Brightwater Forms Root')
    expect(text).toContain('used by Brightwater Builders Inc., on the recorded instruction of Ada Brightwater')
    expect(text).not.toMatch(NORTHFIELD)
    const pages = certificateBlocks(m, { color: [0, 0, 0], via: viaSuffix(BRIGHTWATER_WORDS) }, new Map())
    expect(pages.brand?.via).toBe('via Brightwater Forms')
  })
})

/**
 * Claude's principal is the install's own company, not whoever runs the service: a company whose Forms is run by another (none is today; the test makes one up) is told, in the certificate and in the
 * privacy notice, that Claude acts for it and takes its owner's instructions, and nothing of the runner's.
 */
describe('Claude acts for the install’s company, which is not who runs the service where another does', () => {
  const RUN_BY_ANOTHER = serviceWordsOf(
    createInstall({
      ...BRIGHTWATER_DECLARATION,
      formsService: { ...BRIGHTWATER_DECLARATION.formsService, runBy: { name: 'Harbor Software', legalName: 'Harbor Software LLC', mailingLine: 'Duluth, Minnesota', site: 'harbor-software.example' } },
    }),
  )

  test('the privacy notice’s section on Claude says the install’s company, and for Northfield Works reads exactly as it did', () => {
    expect(claudeNotice(RUN_BY_ANOTHER)).toContain('Brightwater Builders may later let Claude send a document')
    expect(claudeNotice(RUN_BY_ANOTHER)).toContain('only when Ada Brightwater tells it to')
    expect(claudeNotice(RUN_BY_ANOTHER)).toContain('As a rule Brightwater Builders sets for itself, not a technical guarantee: Brightwater Builders does not let Claude read')
    expect(claudeNotice(RUN_BY_ANOTHER)).not.toMatch(/Harbor Software/)
    expect(claudeNotice(NORTHFIELD_WORDS)).toBe(
      'Today Claude has no access to this service. Northfield Works may later let Claude send a document, send a reminder, cancel one or correct an email address, only when Tessa Marlow tells it to and with each instruction recorded. If it does, Claude would see only a document’s title and status, the names and email addresses of the people on it, the record of its steps (times, IP addresses and device types) and the business’s name and addresses, and the service would refuse it answers, uploaded files, private numbers and finished documents. As a rule Northfield Works sets for itself, not a technical guarantee: Northfield Works does not let Claude read answers, uploaded files, private numbers or finished signed documents. This notice will be changed before Claude is given any access.',
    )
  })

  test('the certificate says Claude acted for the install’s company, on its owner’s instruction, and the service that sealed it is still the runner’s', () => {
    const m = certificateModel({
      client: { display_name: 'Harbor Co', legal_name: 'Harbor Company LLC', time_zone: 'America/Chicago' },
      envelope: { id: 'e1', title: 'Letter', kind: 'document', order_mode: 'sequential', created_at: '2026-11-01T20:00:00.000Z', sent_at: '2026-11-01T20:00:00.000Z', completed_at: '2026-11-01T21:00:00.000Z', prepared_sha256: 'a'.repeat(64), original_sha256: null },
      sent: { by: 'agent', agent: true, instruction_sha256: 'f'.repeat(64) },
      recipients: [],
      consents: [],
      events: [
        { seq: 1, at: '2026-11-01T20:00:00.000Z', action: 'sent', actor_kind: 'agent', actor_name: null, actor_email: null, ip: null, device: null, details: '{}' } as never,
        { seq: 2, at: '2026-11-01T20:00:01.000Z', action: 'sealing', actor_kind: 'system', actor_name: null, actor_email: null, ip: null, device: null, details: '{}' } as never,
      ],
      seal: { subject: sealSubject(RUN_BY_ANOTHER), rootFingerprint: 'r'.repeat(64) },
      service: RUN_BY_ANOTHER,
      principal: 'Ada Brightwater',
    })
    const text = JSON.stringify(m)
    expect(text).toContain('Sent by Claude, an AI assistant made by Anthropic and used by Brightwater Builders Inc., on the recorded instruction of Ada Brightwater, Brightwater Builders Inc., for Harbor Co')
    expect(text).toContain('Claude, an AI assistant made by Anthropic, for Brightwater Builders Inc., on the recorded instruction of Ada Brightwater')
    expect(text).not.toMatch(/Harbor Software/)
    expect(m.sealParagraph).toContain('sealed by Brightwater Forms')
  })
})

describe('through the Worker, on another company’s install', () => {
  const install = createInstall({ ...BRIGHTWATER_DECLARATION, formsService: { ...BRIGHTWATER_DECLARATION.formsService } })
  const h = harness({}, install)
  const k = kit(h)
  beforeEach(() => h.reset())

  test('a signing email is sent from the install’s sender with a link on the install’s space host, and the signer’s consent is in the install’s words', async () => {
    await k.sent()
    const m = h.outbox[0]!
    expect(m.from).toEqual({ email: 'forms@brightwater.example', name: 'Pinecrest via Brightwater Forms' })
    expect(m.text).toContain('https://space.brightwater.example/s/')
    expect([m.from.email, m.from.name, m.subject, m.text, m.html].join('\n')).not.toMatch(NORTHFIELD)
    const view = (await k.as(k.tokenFor('alice@example.test'))('GET', '')).body
    expect(view.consent.paragraphs.join('\n')).toContain('is using Brightwater Forms to send you')
    expect(JSON.stringify(view)).not.toMatch(NORTHFIELD)
  })

  test('the signer’s pages learn the service’s names from one public call, which holds nothing but them', async () => {
    const r = await h.call(null, 'GET', '/s/api/service', undefined, { headers: { 'cf-connecting-ip': '203.0.113.7' } })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(BRIGHTWATER_WORDS)
    expect(JSON.stringify(r.body)).not.toMatch(NORTHFIELD)
  })

  test('the Send screen’s preview shows the email as it will arrive, from the install’s sender', async () => {
    const { id } = await k.draft()
    const r = await h.tessa('GET', `/admin/api/envelopes/${id}/preview-email`)
    expect(r.status).toBe(200)
    expect(r.body.from).toBe('Pinecrest via Brightwater Forms <forms@brightwater.example>')
  })
})
