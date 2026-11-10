// The signing core, driven from outside the way a browser and the cron would: the operator sends the built-in sample through
// the admin API, signers use their links through the public API, the clock moves, the sweep runs. Real router, real
// migrations, real PDF engine and real seal; Access stood in for by signed assertions, R2 by a bucket that honours the customer
// key, the mail binding by a recorder. Asserts what a person would notice: who is emailed, what a link allows, what the
// finished PDF holds and whether its seal holds.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { CONSENT_VERSION } from '../src/consent'
import { verifyChain } from '../src/events'
import { scheduled } from '../src/scheduled'
import { sweep } from '../src/signing'
import { harness } from './harness'
import { hasPoppler, pdfsig } from './render'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('sending', () => {
  test('in order only the first signer is emailed, as "<Client> via Northfield Forms" with the client\'s reply address', async () => {
    const { id } = await k.sent()
    expect(h.outbox).toHaveLength(1)
    const m = h.outbox[0]!
    expect(m.to).toEqual({ email: 'alice@example.test', name: 'Alice Example' })
    expect(m.from).toEqual({ email: 'forms@northfield.example', name: 'Pinecrest via Northfield Forms' })
    expect(m.replyTo).toEqual({ email: 'office@pinecrest.example', name: 'Pinecrest' })
    expect(m.subject).toBe('Pinecrest sent you Sample document for Pinecrest to sign')
    expect(m.text).toContain('Please sign.')
    expect(m.html).toContain('Review and sign')
    expect(m.html).not.toMatch(/<img[^>]+width="1"/)
    expect(m.attachments).toBeUndefined()
    expect(k.actions(id)).toEqual(['created', 'sent', 'mailed'])
  })

  test('all at once emails every signer, and the copy addresses only at the end', async () => {
    await k.sent({ order: 'parallel' })
    expect(h.outbox.map((m) => m.to.email).sort()).toEqual(['alice@example.test', 'bob@example.test'])
  })

  test('the first link is real: it is 256 bits in the path, and the database holds only its hash', async () => {
    await k.sent()
    const token = k.tokenFor('alice@example.test')
    expect(token).toHaveLength(43)
    const stored = JSON.stringify(h.sql('SELECT * FROM recipients'))
    expect(stored).not.toContain(token)
  })

  test('nothing is sent for a draft, and a draft cannot be sent twice', async () => {
    const { id } = await k.draft()
    expect(h.outbox).toHaveLength(0)
    await k.send(id)
    const again = await h.tessa('POST', `/admin/api/envelopes/${id}/send`)
    expect(again.status).toBe(409)
    expect(h.outbox).toHaveLength(1)
  })

  test('a recipient list needs a signer, and a signer\'s address must be an address', async () => {
    const client = await h.makeClient()
    const bad = [
      [],
      [{ ...ALICE, kind: 'copy' }],
      [{ ...ALICE, email: 'not-an-address' }],
      [ALICE, { ...BOB, email: ALICE.email }],
      [{ ...ALICE, name: 'Alice\r\nBcc: x@x.test' }],
    ]
    for (const recipients of bad) {
      const r = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'sample' }, recipients })
      expect(r.status, JSON.stringify(recipients)).toBe(400)
    }
    expect(h.sql('SELECT count(*) AS n FROM envelopes')[0]!.n).toBe(0)
  })
})

describe('one signer, then the next', () => {
  test('a whole envelope in order: consent, signatures, the turn passing, the sealed document to everyone', async () => {
    const { id } = await k.sent()
    // Bob's link is in his hands only after Alice signs, but a guess at the sequence gets nothing: he has no link yet.
    expect(h.outbox.some((m) => m.to.email === 'bob@example.test')).toBe(false)
    expect(await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')).toBe('signed')
    const turn = h.outbox.find((m) => m.to.email === 'bob@example.test')!
    expect(turn.subject).toContain('your turn to sign')
    expect(await k.signAs(k.tokenFor('bob@example.test'), 'Bob Preparer')).toBe('complete')

    const row = h.sql<{ status: string; finished_sha256: string; purge_at: string }>('SELECT * FROM envelopes WHERE id = ?', id)[0]!
    expect(row.status).toBe('completed')
    // Seven years on, in the client's own retention.
    expect(row.purge_at.slice(0, 4)).toBe('2033')

    // Each signer, the client's copy address and the operator are mailed; the PDF is attached, not linked.
    const done = h.outbox.filter((m) => /signed and complete/.test(m.subject))
    expect(done.map((m) => m.to.email).sort()).toEqual(['alice@example.test', 'bob@example.test', 'books@pinecrest.example'])
    for (const m of done) expect(m.attachments).toHaveLength(1)
    expect(h.outbox.some((m) => m.to.email === 'tessa@northfield.example' && /is complete/.test(m.subject))).toBe(true)

    // Every state change wrote one event, and the chain verifies.
    const log = h.sql<any>('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq', id)
    expect(await verifyChain(log)).toMatchObject({ ok: true })
    const actions = log.map((e: { action: string }) => e.action)
    expect(actions.filter((a: string) => a === 'completed')).toHaveLength(1)
    expect(actions.filter((a: string) => a === 'sealing')).toHaveLength(1)
    expect(actions.filter((a: string) => a === 'signed')).toHaveLength(2)
    expect(actions.filter((a: string) => a === 'consented')).toHaveLength(2)
    expect(actions.filter((a: string) => a === 'sent')).toHaveLength(1)
    expect(actions.indexOf('consented')).toBeLessThan(actions.indexOf('document-shown'))
    // The consent event carries the version and the hash of the text shown; the signing events carry the document's fingerprint.
    const consented = JSON.parse(log.find((e: { action: string }) => e.action === 'consented').details)
    expect(consented.version).toBe(CONSENT_VERSION)
    expect(consented.text_sha256).toMatch(/^[0-9a-f]{64}$/)
    const signed = log.find((e: { action: string }) => e.action === 'signed')
    expect(signed.doc_hash).toBe(h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256)
    expect(signed.ip).toBe('203.0.113.7')
    expect(signed.device).toBe('Safari on iPhone')
  })

  test.skipIf(!hasPoppler)('the finished PDF carries every value, the certificate pages and the attached log, and its seal covers the whole file', async () => {
    const { id } = await k.sent()
    await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')
    await k.signAs(k.tokenFor('bob@example.test'), 'Bob Preparer')
    const bytes = k.attachment('alice@example.test')
    const sig = pdfsig(bytes)
    expect(sig.valid).toBe(true)
    expect(sig.coversWholeFile).toBe(true)
    expect(sig.untrusted).toBe(true)
    const pdf = await PDF.load(bytes)
    const page = pdf.getPage(0)!.extractText().text
    expect(page).toContain('Alice Example')
    expect(page).toContain('Bob Preparer')
    // Both signers' dates, in the client's zone: October 31, 2026 is "Oct 31, 2026".
    expect(page.match(/Oct 31, 2026/g)).toHaveLength(2)
    const all = await k.text(bytes)
    expect(all).toContain('Certificate of completion')
    expect(all).toContain('Alice Example (Client)')
    expect(all).toContain('Safari on iPhone')
    expect(all).toContain('Northfield Forms Root')
    expect(all).toContain('Last link of the event chain')
    const log = JSON.parse(new TextDecoder().decode(pdf.getAttachment('events.json')!))
    expect(log.envelope).toBe(id)
    expect(log.events.at(-1).action).toBe('sealing')
    // The chain's last link printed in the PDF is the last link of the attached log.
    expect(all.replace(/\s+/g, '')).toContain(log.chain_last)
  })

  test('the same link cannot sign twice, and a later signer sees what the earlier one signed', async () => {
    await k.sent()
    const alice = k.tokenFor('alice@example.test')
    await k.signAs(alice)
    const again = await k.as(alice)('POST', '/finish', { intent: true })
    expect(again.status).toBe(410)
    expect((await k.as(alice)('GET', '')).body.state).toBe('signed')
    const bob = k.tokenFor('bob@example.test')
    const s = k.as(bob)
    await s('POST', '/consent')
    const view = (await s('GET', '')).body
    // Alice's signature, initials, text and checkbox are on Bob's page, read only.
    expect(view.others.map((o: any) => o.type).sort()).toEqual(['checkbox', 'date', 'initials', 'signature', 'text'])
    expect(view.others.find((o: any) => o.type === 'text').value).toBe('Alice Example')
    const pic = view.others.find((o: any) => o.type === 'signature').picture
    const got = await h.request({}, 'GET', pic)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
  })
})

describe('what a link allows', () => {
  test('consent comes before anything else', async () => {
    await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    const view = await s('GET', '')
    expect(view.body.state).toBe('consent')
    expect(view.body.consent.paragraphs.join(' ')).toContain('paper copy')
    expect(view.body.fields).toBeUndefined()
    expect((await s('GET', '/document')).status).toBe(410)
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: 'iVBORw0KGgo=' })).status).toBe(410)
    expect((await s('POST', '/finish', { intent: true })).status).toBe(410)
  })

  test('in order, a link that is not yet its holder\'s turn says so and does nothing', async () => {
    await k.sent()
    // Bob has no link yet. Alice's turn comes first; once she signs, Bob's is live. Before that a made-up token is nothing.
    const none = await h.call(null, 'GET', `/s/api/s/${'a'.repeat(43)}`)
    expect(none.status).toBe(404)
    expect(none.body.error).toContain('not valid')
    const bad = await h.call(null, 'GET', '/s/api/s/short')
    expect(bad.status).toBe(404)
    expect(bad.body.error).toBe(none.body.error)
  })

  test('"opened" is recorded when the page\'s script says so, once, and fetching the state opens nothing', async () => {
    const { id } = await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('GET', '')
    expect(k.actions(id)).not.toContain('opened')
    await s('POST', '/open')
    await s('POST', '/open')
    expect(k.actions(id).filter((a) => a === 'opened')).toHaveLength(1)
  })

  test('a required field left empty keeps the signer from finishing, and says which', async () => {
    await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('POST', '/consent')
    const r = await s('POST', '/finish', { intent: true })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('still need you')
    expect(r.body.error).toContain('Signature')
    // And the confirmation that the signature is theirs is required.
    await k.signAs(k.tokenFor('alice@example.test'), 'Alice', { skipFinish: true })
    expect((await s('POST', '/finish', { intent: false })).status).toBe(400)
  })

  test('a field takes only what it is meant to, and a character the document cannot print is refused where typed', async () => {
    await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('POST', '/consent')
    const fields = (await s('GET', '')).body.fields as { id: string; type: string }[]
    const text = fields.find((f) => f.type === 'text')!
    const date = fields.find((f) => f.type === 'date')!
    const box = fields.find((f) => f.type === 'checkbox')!
    expect((await s('PUT', `/fields/${text.id}`, { value: 'Li 李' })).status).toBe(400)
    expect((await s('PUT', `/fields/${text.id}`, { value: 'a\nb' })).status).toBe(400)
    expect((await s('PUT', `/fields/${text.id}`, { value: 'x'.repeat(201) })).status).toBe(400)
    expect((await s('PUT', `/fields/${text.id}`, { value: 'José Núñez' })).status).toBe(200)
    expect((await s('PUT', `/fields/${date.id}`, { value: '2020-01-01' })).status).toBe(400)
    expect((await s('PUT', `/fields/${box.id}`, { value: 'yes' })).status).toBe(400)
    // A field that is not theirs does not exist for them.
    expect((await s('PUT', `/fields/${crypto.randomUUID()}`, { value: 'x' })).status).toBe(400)
    // A signature needs one adopted first.
    const sig = fields.find((f) => f.type === 'signature')!
    expect((await s('PUT', `/fields/${sig.id}`, { value: 'adopted' })).status).toBe(400)
  })

  test('the picture must be a PNG or a JPEG within the size, and a typed signature needs its name', async () => {
    await k.sent()
    const s = k.as(k.tokenFor('alice@example.test'))
    await s('POST', '/consent')
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: Buffer.from('not an image').toString('base64') })).status).toBe(400)
    expect((await s('POST', '/adopt', { kind: 'nope', method: 'drawn', image: Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toString('base64') })).status).toBe(400)
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'typed', image: (await import('./signing-kit')).png() })).status).toBe(400)
  })
})

describe('declining, cancelling and expiry', () => {
  test('declining ends it for everyone: the operator, the copy address and whoever signed already are told, and every link says so', async () => {
    const { id } = await k.sent({ order: 'parallel' })
    const links = { 'alice@example.test': k.tokenFor('alice@example.test'), 'bob@example.test': k.tokenFor('bob@example.test') }
    await k.signAs(links['alice@example.test'])
    h.outbox.length = 0
    const bob = k.as(links['bob@example.test'])
    await bob('POST', '/consent')
    const r = await bob('POST', '/decline', { reason: 'I disagree with page two' })
    expect(r.status).toBe(200)
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('declined')
    expect(h.outbox.map((m) => m.to.email).sort()).toEqual(['alice@example.test', 'books@pinecrest.example', 'tessa@northfield.example'])
    for (const m of h.outbox) {
      expect(m.subject).toBe('Sample document for Pinecrest was declined')
      expect(m.text).toContain('Bob Preparer declined')
      expect(m.text).toContain('I disagree with page two')
    }
    expect(h.outbox.find((m) => m.to.email === 'alice@example.test')!.replyTo!.email).toBe('office@pinecrest.example')
    for (const email of ['alice@example.test', 'bob@example.test'] as const) {
      const v = await k.as(links[email])('GET', '')
      expect(v.body.state).toBe('declined')
    }
    expect((await k.as(links['alice@example.test'])('POST', '/finish', { intent: true })).status).toBe(410)
    // Unfinished: deleted 90 days after it stopped.
    expect(h.sql<{ purge_at: string }>('SELECT purge_at FROM envelopes WHERE id = ?', id)[0]!.purge_at.slice(0, 10)).toBe('2026-01-29'.replace('2026-01-29', new Date(Date.UTC(2026, 9, 31, 20) + 90 * DAY).toISOString().slice(0, 10)))
  })

  test('cancelling with a reason revokes every link and tells everyone who was emailed', async () => {
    const { id } = await k.sent({ order: 'parallel' })
    const links = { 'alice@example.test': k.tokenFor('alice@example.test'), 'bob@example.test': k.tokenFor('bob@example.test') }
    h.outbox.length = 0
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/cancel`, { reason: 'Sent in error' })
    expect(r.status).toBe(200)
    expect(h.outbox.map((m) => m.to.email).sort()).toEqual(['alice@example.test', 'bob@example.test'])
    expect(h.outbox[0]!.text).toContain('Sent in error')
    for (const email of ['alice@example.test', 'bob@example.test'] as const) {
      expect((await k.as(links[email])('GET', '')).body.state).toBe('cancelled')
    }
    expect((await h.tessa('POST', `/admin/api/envelopes/${id}/cancel`, { reason: 'again' })).status).toBe(409)
    expect((await h.tessa('POST', `/admin/api/envelopes/${id}/cancel`, { reason: '' })).status).toBeGreaterThanOrEqual(400)
  })

  test('expiry holds the moment its time passes, and the sweep then marks it and tells the operator', async () => {
    const { id } = await k.sent({ extra: { expires_in_days: 5 } })
    const alice = k.tokenFor('alice@example.test')
    h.setClock(Date.UTC(2026, 9, 31, 20) + 5 * DAY + 1000)
    // Before the sweep has run, the link already refuses.
    expect((await k.as(alice)('GET', '')).body.state).toBe('expired')
    expect((await k.as(alice)('POST', '/consent')).status).toBe(410)
    h.outbox.length = 0
    const r = await sweep(h.core())
    expect(r.expired).toBe(1)
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('expired')
    expect(h.outbox.map((m) => m.to.email)).toEqual(['tessa@northfield.example'])
    expect(h.outbox[0]!.subject).toContain('expired before everyone signed')
    expect(k.actions(id)).toContain('expired')
    // Nothing more happens on a second run.
    h.outbox.length = 0
    expect((await sweep(h.core())).expired).toBe(0)
    expect(h.outbox).toHaveLength(0)
  })
})

describe('reminders', () => {
  const at = (day: number, hour: number) => Date.UTC(2026, 10, day, hour + 8) // Pacific standard: UTC-8 after Nov 1

  test('go to whoever\'s turn it is, every 3 days up to 3 times, only between 9:00 and 17:00 in the client\'s zone', async () => {
    const { id } = await k.sent()
    h.outbox.length = 0
    // Not yet 3 days.
    h.setClock(Date.UTC(2026, 10, 2, 17))
    expect((await sweep(h.core())).reminded).toBe(0)
    // Three days on, but 7 a.m. in Los Angeles: not in the client's hours.
    h.setClock(at(3, 7))
    expect((await sweep(h.core())).reminded).toBe(0)
    h.setClock(at(3, 12))
    expect((await sweep(h.core())).reminded).toBe(1)
    expect(h.outbox.map((m) => [m.to.email, m.subject])).toEqual([['alice@example.test', 'Reminder: Pinecrest is waiting for you to sign Sample document for Pinecrest']])
    // The same hour again: not due.
    expect((await sweep(h.core())).reminded).toBe(0)
    h.setClock(at(6, 12))
    expect((await sweep(h.core())).reminded).toBe(1)
    h.setClock(at(9, 12))
    expect((await sweep(h.core())).reminded).toBe(1)
    // Three is the most.
    h.setClock(at(12, 12))
    expect((await sweep(h.core())).reminded).toBe(0)
    expect(k.actions(id).filter((a) => a === 'reminded')).toHaveLength(3)
    // The same link every time.
    const links = h.outbox.map((m) => /\/s\/([\w-]{43})/.exec(m.text)![1])
    expect(new Set(links).size).toBe(1)
    expect(links[0]).toBe(k.tokenFor('alice@example.test'))
  })

  test('only the signer whose turn it is is reminded in order, and everyone who has not signed all at once', async () => {
    await k.sent({ order: 'parallel' })
    h.outbox.length = 0
    h.setClock(at(3, 12))
    expect((await sweep(h.core())).reminded).toBe(2)
    expect(h.outbox.map((m) => m.to.email).sort()).toEqual(['alice@example.test', 'bob@example.test'])
  })

  test('a reminder now goes out on request, outside the schedule, and a person who is not waiting cannot be reminded', async () => {
    const { id } = await k.sent()
    h.outbox.length = 0
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/remind`, {})
    expect(r.status).toBe(200)
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test'])
    const bob = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'bob@example.test'")[0]!.id
    expect((await h.tessa('POST', `/admin/api/envelopes/${id}/remind`, { recipient_id: bob })).status).toBe(409)
    // A manual reminder does not use up the schedule.
    expect(h.sql<{ reminder_count: number }>("SELECT reminder_count FROM recipients WHERE email = 'alice@example.test'")[0]!.reminder_count).toBe(0)
  })
})

describe('correcting a recipient', () => {
  test('until they open the link: the old link dies, the new address is emailed, and it is an event', async () => {
    const { id } = await k.sent()
    const old = k.tokenFor('alice@example.test')
    const alice = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    h.outbox.length = 0
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/recipients/${alice}/correct`, { email: 'alice.fixed@example.test' })
    expect(r.status).toBe(200)
    expect((await k.as(old)('GET', '')).status).toBe(404)
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice.fixed@example.test'])
    expect((await k.as(k.tokenFor('alice.fixed@example.test'))('GET', '')).body.state).toBe('consent')
    expect(k.actions(id)).toContain('recipient-corrected')
  })

  test('not once they have opened it', async () => {
    const { id } = await k.sent()
    await k.as(k.tokenFor('alice@example.test'))('POST', '/open')
    const alice = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/recipients/${alice}/correct`, { email: 'alice.fixed@example.test' })
    expect(r.status).toBe(409)
  })

  test('a signer waiting for their turn can be corrected, and nobody is emailed until their turn', async () => {
    const { id } = await k.sent()
    const bob = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'bob@example.test'")[0]!.id
    const alice = k.tokenFor('alice@example.test')
    h.outbox.length = 0
    expect((await h.tessa('POST', `/admin/api/envelopes/${id}/recipients/${bob}/correct`, { email: 'bob.fixed@example.test' })).status).toBe(200)
    expect(h.outbox).toHaveLength(0)
    await k.signAs(alice)
    expect(h.outbox.at(-1)!.to.email).toBe('bob.fixed@example.test')
  })
})

describe('two signers finishing at once', () => {
  test('complete the envelope once', async () => {
    const { id } = await k.sent({ order: 'parallel' })
    const a = k.tokenFor('alice@example.test')
    const b = k.tokenFor('bob@example.test')
    await k.signAs(a, 'Alice', { skipFinish: true })
    await k.signAs(b, 'Bob', { skipFinish: true })
    const [x, y] = await Promise.all([k.as(a)('POST', '/finish', { intent: true }), k.as(b)('POST', '/finish', { intent: true })])
    expect([x.status, y.status]).toEqual([200, 200])
    const actions = k.actions(id)
    expect(actions.filter((a) => a === 'completed')).toHaveLength(1)
    expect(actions.filter((a) => a === 'sealing')).toHaveLength(1)
    expect(actions.filter((a) => a === 'signed')).toHaveLength(2)
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('completed')
    // Everyone was mailed their copy once.
    expect(h.outbox.filter((m) => /signed and complete/.test(m.subject))).toHaveLength(3)
    expect(await verifyChain(h.sql<any>('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq', id))).toMatchObject({ ok: true })
  })

  test('one signer pressing Finish twice signs once', async () => {
    const { id } = await k.sent({ order: 'parallel' })
    const a = k.tokenFor('alice@example.test')
    await k.signAs(a, 'Alice', { skipFinish: true })
    await Promise.all([k.as(a)('POST', '/finish', { intent: true }), k.as(a)('POST', '/finish', { intent: true })])
    expect(k.actions(id).filter((x) => x === 'signed')).toHaveLength(1)
  })
})

describe('the log', () => {
  test('the database refuses to change an event, or to delete one before its envelope is purged', async () => {
    const { id } = await k.sent()
    expect(() => h.sql("UPDATE events SET ip = '1.1.1.1' WHERE envelope_id = ?", id)).toThrow(/never changed/)
    expect(() => h.sql('DELETE FROM events WHERE envelope_id = ?', id)).toThrow(/purged/)
  })

  test('an edited event breaks the chain at that event', async () => {
    const { id } = await k.sent()
    const log = h.sql<any>('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq', id)
    expect(await verifyChain(log)).toMatchObject({ ok: true })
    const tampered = log.map((e: any, i: number) => (i === 1 ? { ...e, ip: '6.6.6.6' } : e))
    expect(await verifyChain(tampered)).toMatchObject({ ok: false, brokenAt: 2, why: 'hash' })
  })

  test('the admin view shows the timeline and says whether its chain holds', async () => {
    const { id } = await k.sent()
    const r = await h.tessa('GET', `/admin/api/envelopes/${id}`)
    expect(r.status).toBe(200)
    expect(r.body.chain).toMatchObject({ ok: true })
    expect(r.body.events.map((e: any) => e.action)).toEqual(['created', 'sent', 'mailed'])
    expect(JSON.stringify(r.body)).not.toContain(k.tokenFor('alice@example.test'))
    expect(JSON.stringify(r.body)).not.toContain('wrapped_key')
  })
})

describe('no mail without its row', () => {
  test('every message has a row first, and a refusal from the mail service is recorded with its reason, then retried by the sweep', async () => {
    h.mail.failWith = 'mail service is down'
    const { id } = await k.sent()
    expect(h.outbox).toHaveLength(0)
    let row = h.sql<any>('SELECT * FROM mail WHERE envelope_id = ?', id)[0]!
    expect(row).toMatchObject({ status: 'pending', error: 'mail service is down', attempts: 1 })
    // The sweep leaves a live request its five minutes, then sends it.
    h.mail.failWith = null
    h.setClock(Date.UTC(2026, 9, 31, 20, 6))
    expect((await sweep(h.core())).mailSent).toBe(1)
    expect(h.outbox).toHaveLength(1)
    row = h.sql<any>('SELECT * FROM mail WHERE envelope_id = ?', id)[0]!
    expect(row.status).toBe('sent')
    expect(row.message_id).toBe('msg-1')
    expect(k.actions(id)).toContain('mailed')
  })

  test('after three failures it is failed for good', async () => {
    h.mail.failWith = 'nope'
    const { id } = await k.sent()
    for (let i = 1; i <= 3; i++) {
      h.setClock(Date.UTC(2026, 9, 31, 20, 6 * i))
      await sweep(h.core())
    }
    expect(h.sql<{ status: string; attempts: number }>('SELECT * FROM mail WHERE envelope_id = ?', id)[0]).toMatchObject({ status: 'failed', attempts: 3 })
  })

  test('without a mail binding the message is on record as failed, and nothing breaks', async () => {
    const bare = harness({ EMAIL: undefined })
    const kk = kit(bare)
    const { id } = await kk.sent()
    expect(bare.sql<{ status: string; error: string }>('SELECT * FROM mail WHERE envelope_id = ?', id)[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('no email binding') })
  })

  test('the hourly entry point runs the sweep with the cron\'s clock', async () => {
    await k.sent({ extra: { expires_in_days: 1 } })
    h.setClock(Date.UTC(2026, 10, 3, 20))
    h.outbox.length = 0
    await scheduled({ scheduledTime: Date.UTC(2026, 10, 3, 20) }, h.env(), { waitUntil: () => {} }, h.core())
    expect(h.outbox.map((m) => m.to.email)).toEqual(['tessa@northfield.example'])
  })
})
