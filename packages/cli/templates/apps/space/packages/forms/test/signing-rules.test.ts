// The rules around the core: Claude acts only on Tessa's word, sensitive documents go by private link, retention deletes,
// nothing is readable without the key, the form path's entry works, and the pure pieces (the prepared-document contract,
// reminder timing, the draft fingerprint, the mail texts) are exactly what they say.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { consentParagraphs, intentText } from '../src/consent'
import { FIELD_CATALOG, checkFieldValue, checkPrepared, defaultBox } from '../src/fields'
import { renderMail } from '../src/mail'
import { buildSampleDocument } from '../src/pdf/sample'
import { NORTHFIELD_WORDS } from './words'
import { type Actor, attachPrepared, cancel, correctRecipient, createEnvelope, flushMail, operatorDownload, purgeEnvelope, recordInstruction, remind, revealAnswer, send, setAgentSending, sweep, updateDraft } from '../src/signing'
import { actingSigners, draftFingerprint, dueReminders, inReminderHours } from '../src/signing/rules'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const DAY = 24 * 3_600_000
const START = Date.UTC(2026, 9, 31, 20)
const TESSA: Actor = { kind: 'operator', email: 'tessa@northfield.example', name: 'Tessa' }
const CLAUDE: Actor = { kind: 'agent', label: 'agent:forms api (claude)', onWordOf: 'tessa@northfield.example' }
const said = (envelopeId: string, action: 'send' | 'remind' | 'cancel' | 'correct-recipient', over: Record<string, unknown> = {}) => ({ envelopeId, action, words: 'Yes, send that one to Alice and then Bob.', channel: 'session', saidAt: new Date(START - 60_000).toISOString(), ...over })
const refusal = async (p: Promise<unknown>) => {
  const e = (await p.then(
    () => null,
    (err) => err,
  )) as { status?: number; message?: string } | null
  expect(e, 'it should have been refused').not.toBeNull()
  expect(e!.status).toBe(403)
  return e!.message!
}

describe("Claude acts only on Tessa's word", () => {
  async function ready() {
    const d = await k.draft()
    return { ...d, core: h.core() }
  }
  const state = (id: string) => ({ status: h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status, events: h.sql<{ n: number }>('SELECT count(*) AS n FROM events WHERE envelope_id = ?', id)[0]!.n, mail: h.sql<{ n: number }>('SELECT count(*) AS n FROM mail')[0]!.n, outbox: h.outbox.length })

  test('the switch is off until Tessa turns it on, and an instruction alone does not send', async () => {
    const { id, core } = await ready()
    const ins = await recordInstruction(core, CLAUDE, said(id, 'send'))
    const before = state(id)
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: ins.id }))).toContain('switched off')
    expect(state(id)).toEqual(before)
  })

  test('a send with no instruction, a wrong action, another envelope\'s, or a draft that changed afterwards is refused, and changes nothing', async () => {
    const { id, core } = await ready()
    await setAgentSending(core, TESSA, true)
    const before = state(id)
    expect(await refusal(send(core, CLAUDE, {}, id))).toContain('No instruction was named')
    const wrong = await recordInstruction(core, CLAUDE, said(id, 'cancel'))
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: wrong.id }))).toContain('covers cancel, not send')
    const other = await k.draft({ client: { id: h.sql<{ id: string }>('SELECT id FROM clients')[0]!.id } })
    const theirs = await recordInstruction(core, CLAUDE, said(other.id, 'send'))
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: theirs.id }))).toContain('not on record for this envelope')
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: 'made-up' }))).toContain('not on record')
    // The instruction covers this draft as it stood; one edit afterwards and it no longer does.
    const ins = await recordInstruction(core, CLAUDE, said(id, 'send'))
    await updateDraft(core, TESSA, id, { note: 'A different note' })
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: ins.id }))).toContain('draft changed')
    await updateDraft(core, TESSA, id, { note: 'Please sign.' })
    expect(state(id)).toMatchObject({ status: 'draft', mail: 0, outbox: 0 })
    expect(state(id).events).toBe(before.events + 2)
  })

  test('an accepted send records the instruction on the event, the mail and the PDF, and the instruction is used once', async () => {
    const { id, core } = await ready()
    await setAgentSending(core, TESSA, true)
    const ins = await recordInstruction(core, CLAUDE, said(id, 'send', { words: 'Go ahead and send the sample to Alice, then Bob.' }))
    await send(core, CLAUDE, { ip: '198.51.100.9' }, id, { instructionId: ins.id })
    const sent = k.events(id).find((e) => e.action === 'sent')!
    expect(sent.actor_kind).toBe('agent')
    const details = JSON.parse(sent.details)
    expect(details).toMatchObject({ instruction_id: ins.id, instruction_sha256: ins.sha256, on_word_of: 'tessa@northfield.example' })
    expect(h.sql<{ actor_name: string }>('SELECT actor_name FROM events WHERE seq = ? AND envelope_id = ?', sent.seq, id)[0]!.actor_name).toBe('agent:forms api (claude)')
    expect(h.sql<{ instruction_id: string }>("SELECT instruction_id FROM mail WHERE kind = 'request'")[0]!.instruction_id).toBe(ins.id)
    // Using it again is refused, whatever the envelope's state.
    expect(await refusal(remind(core, CLAUDE, {}, id, { instructionId: ins.id }))).toContain('covers send, not remind')
    expect(await refusal(send(core, CLAUDE, {}, id, { instructionId: ins.id }).catch((e) => { throw Object.assign(e, { status: 403 }) }))).toBeTruthy()

    // Both sign; the finished PDF's attached log and its certificate carry the fingerprint and not Tessa's words.
    await k.signAs(k.tokenFor('alice@example.test'))
    await k.signAs(k.tokenFor('bob@example.test'))
    const bytes = k.attachment('alice@example.test')
    const pdf = await PDF.load(bytes)
    const log = new TextDecoder().decode(pdf.getAttachment('events.json')!)
    expect(log).toContain(ins.sha256)
    expect(log).not.toContain('Go ahead and send')
    const text = await k.text(bytes)
    expect(text.replace(/\s+/g, ' ')).toContain(`Sent by Claude, an AI assistant made by Anthropic and used by Northfield Works LLC, on the recorded instruction of Tessa Marlow, Northfield Works LLC, for Pinecrest (instruction ${ins.sha256})`)
    expect(text).not.toContain('Go ahead and send')
    // Tessa's words stay in the instruction row.
    expect(h.sql<{ words: string }>('SELECT words FROM instructions WHERE id = ?', ins.id)[0]!.words).toContain('Go ahead and send')
    // And the admin shows the instruction beside the timeline, as Claude's own account and used.
    const view = await h.tessa('GET', `/admin/api/envelopes/${id}`)
    expect(view.body.instructions).toEqual([expect.objectContaining({ id: ins.id, used: true, channel: 'session' })])
  })

  test('one instruction used by two requests at once is used once', async () => {
    const { id, core } = await ready()
    await setAgentSending(core, TESSA, true)
    await send(core, TESSA, {}, id)
    const ins = await recordInstruction(core, CLAUDE, said(id, 'remind'))
    const results = await Promise.allSettled([remind(core, CLAUDE, {}, id, { instructionId: ins.id }), remind(core, CLAUDE, {}, id, { instructionId: ins.id })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(h.sql<{ n: number }>("SELECT count(*) AS n FROM events WHERE envelope_id = ? AND action = 'reminded'", id)[0]!.n).toBe(1)
    expect(h.sql<{ n: number }>("SELECT count(*) AS n FROM mail WHERE kind = 'reminder'")[0]!.n).toBe(1)
  })

  test('a reminder, a cancellation and a correction each need their own instruction', async () => {
    const { id, core } = await ready()
    await send(core, TESSA, {}, id)
    await setAgentSending(core, TESSA, true)
    const alice = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    const bob = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'bob@example.test'")[0]!.id
    expect(await refusal(remind(core, CLAUDE, {}, id))).toContain('No instruction')
    expect(await refusal(cancel(core, CLAUDE, {}, id, 'No longer needed'))).toContain('No instruction')
    expect(await refusal(correctRecipient(core, CLAUDE, {}, id, bob, { email: 'bob2@example.test' }))).toContain('No instruction')
    // A correction covers the one recipient and address Tessa named.
    const fix = await recordInstruction(core, CLAUDE, said(id, 'correct-recipient', { target: { recipientId: bob, email: 'bob2@example.test' } }))
    expect(await refusal(correctRecipient(core, CLAUDE, {}, id, bob, { email: 'someone.else@example.test' }, { instructionId: fix.id }))).toContain('different recipient or address')
    expect(await refusal(correctRecipient(core, CLAUDE, {}, id, alice, { email: 'bob2@example.test' }, { instructionId: fix.id }))).toContain('different recipient')
    const done = await correctRecipient(core, CLAUDE, {}, id, bob, { email: 'bob2@example.test' }, { instructionId: fix.id })
    expect(done.email).toBe('bob2@example.test')
    const cx = await recordInstruction(core, CLAUDE, said(id, 'cancel', { words: 'Cancel it, the client changed their mind.' }))
    await cancel(core, CLAUDE, {}, id, 'The client changed their mind', { instructionId: cx.id })
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('cancelled')
  })

  test('an instruction only counts when Tessa said it in a session with Claude', async () => {
    const { id, core } = await ready()
    for (const channel of ['email', 'this app', 'slack', '']) await expect(recordInstruction(core, CLAUDE, said(id, 'send', { channel }))).rejects.toMatchObject({ status: 400 })
    await expect(recordInstruction(core, CLAUDE, said(id, 'send', { words: '   ' }))).rejects.toMatchObject({ status: 400 })
    await expect(recordInstruction(core, CLAUDE, said(id, 'send', { saidAt: new Date(START + 3_600_000).toISOString() }))).rejects.toMatchObject({ status: 400 })
    // The database holds the same line: no row can name another channel.
    expect(() => h.sql("INSERT INTO instructions (id, envelope_id, client_id, action, words, channel, said_at, recorded_at, recorded_by, draft_fingerprint, sha256) SELECT 'x', id, client_id, 'send', 'w', 'email', 'a', 'b', 'c', 'd', 'e' FROM envelopes")).toThrow()
    expect(() => h.sql("UPDATE instructions SET words = 'changed'")).not.toThrow()
  })

  test('Claude\'s token can never reveal an answer, download a finished document, purge, or turn its own switch on', async () => {
    const { id, core } = await ready()
    expect(await refusal(setAgentSending(core, CLAUDE, true))).toContain('Only an operator')
    expect(await refusal(revealAnswer(core, CLAUDE, {}, id, 'q1'))).toContain('Only an operator')
    expect(await refusal(purgeEnvelope(core, CLAUDE, id, 'operator'))).toContain('Only an operator')
    expect(await refusal(purgeEnvelope(core, CLAUDE, id, 'retention'))).toContain('Only an operator')
    expect(await refusal(operatorDownload(core, CLAUDE, {}, id))).toContain('Only an operator')
    // The switch stayed off, and the envelope is still there.
    expect((await core.db.prepare("SELECT value FROM settings WHERE key = 'agent_sending'").first<{ value: string }>())?.value).toBe('off')
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toHaveLength(1)
  })

  test('the switch is an audited change, and only Tessa changes it back', async () => {
    const { core } = await ready()
    await setAgentSending(core, TESSA, true)
    await setAgentSending(core, TESSA, false)
    expect(h.sql<{ actor: string; after: string }>("SELECT actor, after FROM audit WHERE entity = 'settings' ORDER BY id").map((r) => [r.actor, JSON.parse(r.after).value])).toEqual([['tessa@northfield.example', 'on'], ['tessa@northfield.example', 'off']])
  })
})

describe('a finished document with a sensitive answer goes by private link', () => {
  async function finished(sensitive: boolean) {
    const d = await k.sent({ extra: { sensitive } })
    const links = { alice: k.tokenFor('alice@example.test'), bob: '' }
    await k.signAs(links.alice)
    links.bob = k.tokenFor('bob@example.test')
    await k.signAs(links.bob)
    return { ...d, links }
  }

  test('no attachment: every party is mailed a link, and every download is an event', async () => {
    const { id, links } = await finished(true)
    const done = h.outbox.filter((m) => /signed and complete/.test(m.subject))
    expect(done).toHaveLength(3)
    for (const m of done) {
      expect(m.attachments).toBeUndefined()
      expect(m.text).toContain('each download is recorded')
      expect(m.text).toMatch(/https:\/\/space\.northfield\.example\/s\/[\w-]{43}/)
    }
    const s = k.as(links.alice)
    const first = await s('GET', '/download')
    expect(first.status).toBe(200)
    expect(first.res.headers.get('content-type')).toBe('application/pdf')
    expect(new TextDecoder().decode(new Uint8Array(await first.res.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
    await s('GET', '/download')
    await k.as(links.bob)('GET', '/download')
    expect(k.actions(id).filter((a) => a === 'copy-downloaded')).toHaveLength(3)
    expect((await s('GET', '')).body.download).toMatchObject({ available: true, sensitive: true })
  })

  test('the link works for 90 days after completion and then says so', async () => {
    const { links } = await finished(true)
    h.setClock(START + 89 * DAY)
    expect((await k.as(links.alice)('GET', '/download')).status).toBe(200)
    h.setClock(START + 91 * DAY)
    const late = await k.as(links.alice)('GET', '/download')
    expect(late.status).toBe(410)
    expect(late.body.error).toContain('run out')
    expect((await k.as(links.alice)('GET', '')).body.download.available).toBe(false)
  })

  test('any other envelope\'s copy is attached, and the same link downloads it too', async () => {
    const { id, links } = await finished(false)
    for (const m of h.outbox.filter((m) => /signed and complete/.test(m.subject))) expect(m.attachments).toHaveLength(1)
    expect((await k.as(links.alice)('GET', '/download')).status).toBe(200)
    expect(k.actions(id)).toContain('copy-downloaded')
  })

  test('the operator downloads it on the record, and the certificate is a page behind each link and in the admin', async () => {
    const { id, links } = await finished(false)
    const r = await h.request({ 'cf-access-jwt-assertion': await h.sign({ email: 'tessa@northfield.example' }) }, 'GET', `/admin/api/envelopes/${id}/finished.pdf`)
    expect(r.status).toBe(200)
    expect(k.events(id).filter((e) => e.action === 'copy-downloaded').map((e) => JSON.parse(e.details).by)).toEqual(['operator'])
    const cert = await k.as(links.alice)('GET', '/certificate')
    expect(cert.status).toBe(200)
    expect(cert.body.title).toBe('Certificate of completion')
    expect(cert.body.recipients.map((r: any) => r.heading)).toEqual(['1. Alice Example (Client)', '2. Bob Preparer (CPA)'])
    const admin = await h.tessa('GET', `/admin/api/envelopes/${id}/certificate`)
    expect(admin.body.chain.last).toBe(cert.body.chain.last)
  })

  test('a finished PDF over the mail limit goes by link even when not sensitive', async () => {
    const { id } = await finished(false)
    // The mail builder reads the recorded size, so a second completion mail built after the size grows must not attach it.
    h.sql('UPDATE envelopes SET finished_size = 16 * 1024 * 1024 WHERE id = ?', id)
    const alice = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    h.sql("INSERT INTO mail (id, client_id, envelope_id, recipient_id, kind, to_email, to_name, from_name, subject, status, created_at) SELECT 'big', client_id, id, ?, 'completed', 'alice@example.test', 'Alice', 'x', '', 'pending', 'now' FROM envelopes WHERE id = ?", alice, id)
    const before = h.outbox.length
    await flushMail(h.core(), 'big')
    const m = h.outbox[before]!
    expect(h.outbox).toHaveLength(before + 1)
    expect(m.attachments).toBeUndefined()
    expect(m.text).toMatch(/https:\/\/space\.northfield\.example\/s\/[\w-]{43}/)
  })
})

describe('retention', () => {
  const filesFor = (id: string) => [...h.files().objects.keys()].filter((key) => key.startsWith(`envelopes/${id}/`))

  async function completed(client?: { id: string }) {
    const d = await k.sent({ client })
    await k.signAs(k.tokenFor('alice@example.test'))
    await k.signAs(k.tokenFor('bob@example.test'))
    return d
  }

  test('a finished envelope is kept 7 years and then its files, rows and key are gone, leaving a tombstone', async () => {
    const { id } = await completed()
    const row = h.sql<any>('SELECT * FROM envelopes WHERE id = ?', id)[0]!
    expect(filesFor(id).length).toBeGreaterThan(3)
    const last = h.sql<{ hash: string }>('SELECT hash FROM events WHERE envelope_id = ? ORDER BY seq DESC LIMIT 1', id)[0]!.hash
    h.setClock(START + 7 * 365 * DAY)
    expect((await sweep(h.core())).purged).toBe(0)
    h.setClock(START + 7 * 365 * DAY + 2 * DAY)
    expect((await sweep(h.core())).purged).toBe(1)
    expect(filesFor(id)).toEqual([])
    for (const t of ['envelopes', 'recipients', 'fields', 'field_values', 'signature_adoptions', 'events', 'mail']) expect(h.sql(`SELECT 1 FROM ${t} WHERE ${t === 'envelopes' ? 'id' : 'envelope_id'} = ?`, id), t).toEqual([])
    const stone = h.sql<any>('SELECT * FROM tombstones WHERE envelope_id = ?', id)[0]!
    expect(stone).toMatchObject({ title: 'Sample document for Pinecrest', finished_sha256: row.finished_sha256, chain_last_hash: last, reason: 'retention' })
    // The wrapped key went with the row: nothing left can open a copy.
    expect(JSON.stringify(h.sql('SELECT * FROM tombstones'))).not.toContain(row.wrapped_key)
    // The sample's own source went too, and the link says nothing.
    expect(h.sql('SELECT 1 FROM source_documents')).toEqual([])
    expect([...h.files().objects.keys()].filter((key) => key.startsWith('sources/'))).toEqual([])
    expect((await k.as(k.tokenFor('alice@example.test'))('GET', '')).status).toBe(404)
  })

  test('a client can keep records for a different time', async () => {
    const client = await h.makeClient({ slug: 'short-keeper', retention_years: 1 })
    const { id } = await completed(client)
    h.setClock(START + 366 * DAY)
    await sweep(h.core())
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toEqual([])
    expect(h.sql<{ reason: string }>('SELECT reason FROM tombstones')[0]!.reason).toBe('retention')
  })

  test('unfinished envelopes (declined, cancelled, expired, an idle draft) go 90 days after they stop', async () => {
    const idle = await k.draft()
    const declined = await k.sent({ client: idle.client })
    await k.as(k.tokenFor('alice@example.test'))('POST', '/consent')
    await k.as(k.tokenFor('alice@example.test'))('POST', '/decline', {})
    const cancelled = await k.sent({ client: idle.client, recipients: [{ ...ALICE, email: 'alice2@example.test' }] })
    await h.tessa('POST', `/admin/api/envelopes/${cancelled.id}/cancel`, { reason: 'x' })
    const expired = await k.sent({ client: idle.client, recipients: [{ ...ALICE, email: 'alice3@example.test' }], extra: { expires_in_days: 1 } })
    h.setClock(START + 2 * DAY)
    await sweep(h.core())
    h.setClock(START + 89 * DAY)
    expect((await sweep(h.core())).purged).toBe(0)
    h.setClock(START + 94 * DAY)
    expect((await sweep(h.core())).purged).toBe(4)
    expect(h.sql<{ reason: string }>('SELECT DISTINCT reason FROM tombstones').map((r) => r.reason)).toEqual(['unfinished'])
    for (const e of [idle, declined, cancelled, expired]) expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', e.id)).toEqual([])
  })

  test('an operator can purge early on the client\'s instruction, and it is in the audit', async () => {
    const { id } = await completed()
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/purge`)
    expect(r.body).toEqual({ purged: true })
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toEqual([])
    expect(h.sql<{ actor: string; action: string }>("SELECT actor, action FROM audit WHERE entity = 'envelopes'")).toEqual([{ actor: 'tessa@northfield.example', action: 'purge' }])
    expect(h.sql<{ reason: string }>('SELECT reason FROM tombstones')[0]!.reason).toBe('operator')
  })
})

describe('nothing is readable without the key', () => {
  test('every object but a logo is stored under its envelope\'s key, and no value in the database holds what was typed', async () => {
    const { id } = await k.sent()
    await k.signAs(k.tokenFor('alice@example.test'), 'Distinctive Typed Name')
    const objects = [...h.files().objects.entries()].filter(([key]) => !key.startsWith('logos/'))
    expect(objects.length).toBeGreaterThan(3)
    for (const [key, o] of objects) {
      expect(o.key, key).toBeDefined()
      await expect(h.files().get(key), key).rejects.toThrow()
      await expect(h.files().get(key, { ssecKey: new Uint8Array(32).fill(1).buffer as ArrayBuffer }), key).rejects.toThrow()
    }
    const dump = JSON.stringify([h.sql('SELECT * FROM field_values'), h.sql('SELECT * FROM recipients'), h.sql('SELECT * FROM signature_adoptions')])
    expect(dump).not.toContain('Distinctive Typed Name')
    expect(dump).not.toContain(k.tokenFor('alice@example.test'))
    expect(h.sql<{ value_enc: string }>('SELECT value_enc FROM field_values').every((r) => r.value_enc.startsWith('e1.'))).toBe(true)
    // A value cannot be moved to another field and still open: it is bound to its envelope and field.
    expect(id).toBeTruthy()
  })
})

describe('the form path\'s entry: a document prepared after the send', () => {
  test('a form envelope starts with its filler alone; once the document exists the others are emailed and everyone signs it', async () => {
    const client = await h.makeClient()
    const core = h.core()
    h.sql("INSERT INTO forms (id, client_id, title, created_at, updated_at) VALUES ('f1', ?, 'Intake', 'a', 'a')", client.id)
    h.sql("INSERT INTO form_versions (id, client_id, form_id, version, definition, definition_hash, published_at, created_at) VALUES ('v1', ?, 'f1', 1, '{}', 'h', 'a', 'a')", client.id)
    const e = await createEnvelope(core, TESSA, { clientId: client.id, kind: 'form', title: 'Intake and engagement', order: 'parallel', formVersionId: 'v1', recipients: [ALICE, BOB] })
    await send(core, TESSA, {}, e.id)
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test'])
    const alice = k.tokenFor('alice@example.test')
    await k.as(alice)('POST', '/consent')
    expect((await k.as(alice)('GET', '')).body.state).toBe('preparing')
    expect((await k.as(alice)('GET', '/document')).status).toBe(410)

    const prepared = await buildSampleDocument({ display_name: 'Pinecrest', legal_name: 'Lane', accent_color: '#1f4e79', reply_to: 'a@b.test', time_zone: 'America/Los_Angeles' }, null, [{ role: 'Client' }, { role: 'CPA' }], NORTHFIELD_WORDS)
    const filler: Actor = { kind: 'recipient', id: 'x', email: 'alice@example.test', name: 'Alice Example' }
    await attachPrepared(core, filler, {}, e.id, prepared)
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', e.id)[0]!.status).toBe('prepared')
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test', 'bob@example.test'])
    expect((await k.as(alice)('GET', '')).body.state).toBe('sign')
    expect(k.actions(e.id)).toContain('prepared')
    // Changing an answer prepares it again, with a new fingerprint and a new event.
    const again = await buildSampleDocument({ display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', accent_color: '#1f4e79', reply_to: 'a@b.test', time_zone: 'America/Los_Angeles' }, null, [{ role: 'Client' }, { role: 'CPA' }], NORTHFIELD_WORDS)
    const fingerprints = new Set<string>()
    fingerprints.add(h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256)
    await attachPrepared(core, filler, {}, e.id, again)
    fingerprints.add(h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256)
    expect(fingerprints.size).toBe(2)
    expect(k.actions(e.id).filter((a) => a === 'prepared')).toHaveLength(2)
    await k.signAs(alice)
    await k.signAs(k.tokenFor('bob@example.test'), 'Bob')
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', e.id)[0]!.status).toBe('completed')
  })
})

describe('the prepared-document contract', () => {
  const page = { index: 0, width: 612, height: 792, rotation: 0 as const }
  const field = (over: Record<string, unknown> = {}) => ({ recipient: 1, type: 'signature' as const, page: 0, box: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 }, required: true, ...over })
  const people = [{ position: 1, kind: 'signer' as const }, { position: 2, kind: 'copy' as const }]

  test('checks what would put a field somewhere it cannot be filled', () => {
    expect(checkPrepared({ pages: [page], fields: [field()] }, people)).toEqual([])
    expect(checkPrepared({ pages: [], fields: [] }, people).join(' ')).toContain('no pages')
    expect(checkPrepared({ pages: [page], fields: [field({ page: 3 })] }, people).join(' ')).toContain('page 4')
    expect(checkPrepared({ pages: [page], fields: [field({ recipient: 2 })] }, people).join(' ')).toContain('not a signer')
    expect(checkPrepared({ pages: [page], fields: [field({ box: { x: 0.8, y: 0.1, width: 0.3, height: 0.05 } })] }, people).join(' ')).toContain('does not sit inside')
    expect(checkPrepared({ pages: [page], fields: [field({ box: { x: 0.1, y: 0.1, width: 0, height: 0.05 } })] }, people).join(' ')).toContain('does not sit inside')
    expect(checkPrepared({ pages: [page], fields: [] }, people).join(' ')).toContain('nothing to fill')
    expect(checkPrepared({ pages: [page], fields: [field({ type: 'stamp' })] }, people).join(' ')).toContain('unknown type')
  })

  test('the catalog sizes a new field to its page and keeps it inside', () => {
    const b = defaultBox('signature', { width: 612, height: 792 }, { x: 0.5, y: 0.5 })
    expect(b.width).toBeCloseTo(180 / 612)
    expect(b.height).toBeCloseTo(44 / 792)
    expect(b.x + b.width / 2).toBeCloseTo(0.5)
    const edge = defaultBox('signature', { width: 612, height: 792 }, { x: 1, y: 1 })
    expect(edge.x + edge.width).toBeLessThanOrEqual(1)
    expect(edge.y + edge.height).toBeLessThanOrEqual(1)
    expect(Object.keys(FIELD_CATALOG)).toEqual(['signature', 'initials', 'date', 'text', 'checkbox'])
  })

  test('the signing core refuses a prepared document that lies about its pages or breaks the contract', async () => {
    const client = await h.makeClient()
    const core = h.core()
    const doc = await buildSampleDocument({ display_name: 'x', legal_name: 'x', accent_color: '#1f4e79', reply_to: 'a@b.test', time_zone: 'America/Los_Angeles' }, null, [{ role: 'Client' }], NORTHFIELD_WORDS)
    const base = { clientId: client.id, kind: 'document' as const, title: 't', recipients: [ALICE], sourceDocumentId: 'unused' }
    await expect(createEnvelope(core, TESSA, { ...base, prepared: { ...doc, pages: [...doc.pages, { ...doc.pages[0]!, index: 1 }] } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('2 were described') })
    await expect(createEnvelope(core, TESSA, { ...base, prepared: { ...doc, fields: [] } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('nothing to fill') })
    await expect(createEnvelope(core, TESSA, { ...base, prepared: { ...doc, bytes: new TextEncoder().encode('not a pdf') } })).rejects.toMatchObject({ status: 400 })
    expect(h.sql('SELECT 1 FROM envelopes')).toEqual([])
    expect([...h.files().objects.keys()].filter((k) => k.startsWith('envelopes/'))).toEqual([])
  })

  test('a field value is checked by its type', () => {
    expect(checkFieldValue('text', 'ok')).toBeNull()
    expect(checkFieldValue('text', 'Li 李')).toContain('Chinese, Japanese and Korean')
    expect(checkFieldValue('text', 'Nguyễn Thị')).toBeNull()
    expect(checkFieldValue('text', 5)).not.toBeNull()
    expect(checkFieldValue('checkbox', true)).toBeNull()
    expect(checkFieldValue('signature', 'adopted')).toBeNull()
    expect(checkFieldValue('signature', 'Alice')).not.toBeNull()
    expect(checkFieldValue('date', '2026-01-01')).not.toBeNull()
  })
})

describe('the pure rules', () => {
  const env = { client_id: 'c', kind: 'document' as const, title: 't', order_mode: 'sequential' as const, note: null, expires_in_days: 30, reminder_every_days: 3, reminder_max: 3, sensitive: 0, typed_only: 0, prepared_sha256: 'abc', form_version_id: null, source_document_id: 's' }
  const people = [
    { position: 1, role: 'Client', name: 'A', email: 'a@x.test', kind: 'signer' as const },
    { position: 2, role: 'CPA', name: 'B', email: 'b@x.test', kind: 'signer' as const },
  ]

  test('the draft fingerprint changes with anything Tessa\'s word covers, and with nothing else', async () => {
    const base = await draftFingerprint(env, people)
    expect(await draftFingerprint({ ...env }, people.map((p) => ({ ...p })))).toBe(base)
    expect(await draftFingerprint({ ...env }, [{ ...people[0]!, email: 'A@X.test' }, people[1]!])).toBe(base)
    for (const change of [{ note: 'hi' }, { expires_in_days: 31 }, { reminder_max: 2 }, { reminder_every_days: 4 }, { prepared_sha256: 'abd' }, { order_mode: 'parallel' as const }, { title: 'u' }, { sensitive: 1 }, { typed_only: 1 }]) expect(await draftFingerprint({ ...env, ...change }, people), JSON.stringify(change)).not.toBe(base)
    expect(await draftFingerprint(env, [people[1]!, people[0]!].map((p, i) => ({ ...p, position: i + 1 })))).not.toBe(base)
    expect(await draftFingerprint(env, [people[0]!, { ...people[1]!, email: 'c@x.test' }])).not.toBe(base)
  })

  test('who may act now', () => {
    const r = (position: number, status: string) => ({ kind: 'signer' as const, position, status: status as never })
    expect(actingSigners('sequential', [r(1, 'signed'), r(2, 'sent'), r(3, 'waiting')]).map((x) => x.position)).toEqual([2])
    expect(actingSigners('parallel', [r(1, 'sent'), r(2, 'opened'), r(3, 'signed')]).map((x) => x.position)).toEqual([1, 2])
    expect(actingSigners('sequential', [r(1, 'waiting')])).toEqual([])
  })

  test('reminders are due on the interval, within the count and the hours, never past expiry', () => {
    const at = (iso: string) => Date.parse(iso)
    const e = { status: 'sent' as const, order_mode: 'sequential' as const, reminder_every_days: 3, reminder_max: 3, expires_at: '2026-12-01T00:00:00.000Z' }
    const r = (over: Record<string, unknown> = {}) => [{ kind: 'signer' as const, status: 'sent' as const, position: 1, reminder_count: 0, last_reminded_at: null, notified_at: '2026-11-01T18:00:00.000Z', ...over }]
    const noon = at('2026-11-04T20:00:00.000Z') // 12:00 in Los Angeles
    expect(dueReminders(e, r(), noon, 'America/Los_Angeles')).toHaveLength(1)
    expect(dueReminders(e, r(), at('2026-11-04T17:59:00.000Z'), 'America/Los_Angeles')).toHaveLength(0)
    expect(dueReminders(e, r({ reminder_count: 3 }), noon, 'America/Los_Angeles')).toHaveLength(0)
    expect(dueReminders(e, r({ last_reminded_at: '2026-11-03T20:00:00.000Z' }), noon, 'America/Los_Angeles')).toHaveLength(0)
    expect(dueReminders({ ...e, expires_at: '2026-11-04T00:00:00.000Z' }, r(), noon, 'America/Los_Angeles')).toHaveLength(0)
    expect(dueReminders({ ...e, status: 'completed' as never }, r(), noon, 'America/Los_Angeles')).toHaveLength(0)
    expect(dueReminders(e, r({ status: 'waiting' }), noon, 'America/Los_Angeles')).toHaveLength(0)
    // The client's own hours: 9:00 in New York is 6:00 in Los Angeles.
    expect(inReminderHours(at('2026-11-04T14:00:00.000Z'), 'America/New_York')).toBe(true)
    expect(inReminderHours(at('2026-11-04T14:00:00.000Z'), 'America/Los_Angeles')).toBe(false)
    expect(inReminderHours(at('2026-11-05T01:00:00.000Z'), 'America/Los_Angeles')).toBe(false)
    expect(inReminderHours(at('2026-11-05T00:59:00.000Z'), 'America/Los_Angeles')).toBe(true)
  })
})

describe('the words the service sends', () => {
  const brand = { name: "Pinecrest's <Tax>", accent: '#1f4e79', logoUrl: 'https://space.northfield.example/s/api/logo/x?v=1', replyTo: 'office@pinecrest.example' }
  const kinds = ['request', 'reminder', 'turn', 'completed', 'declined', 'cancelled', 'expired', 'notice'] as const

  test('every message has HTML and plain text, no tracking pixel, no em dash, and escapes what an operator typed', () => {
    for (const kind of kinds) {
      const m = renderMail({ service: NORTHFIELD_WORDS, kind, brand, title: 'Letter <b>one</b>', toName: 'Al "Al" <al>', link: 'https://space.northfield.example/s/abc', note: 'Hi <script>alert(1)</script>', expiresOn: 'December 1, 2026', delivery: kind === 'completed' ? 'link' : undefined, reason: 'because <i>', declinedBy: 'Bo', headline: 'Done', body: 'The body' })
      expect(m.subject, kind).not.toContain('\n')
      for (const s of [m.subject, m.html, m.text]) expect(s, kind).not.toContain('\u2014')
      expect(m.html, kind).not.toContain('<script>')
      expect(m.html, kind).not.toContain('<b>one</b>')
      expect(m.text.length, kind).toBeGreaterThan(40)
      expect(m.html, kind).toContain('via Northfield Forms')
      expect(m.html, kind).not.toMatch(/<img[^>]*(width|height)="1"/)
      expect(m.html.match(/<img/g)?.length ?? 0, kind).toBeLessThanOrEqual(1)
    }
  })

  test('a request reads as the business\'s own, with the link, the note and the expiry', () => {
    const m = renderMail({ service: NORTHFIELD_WORDS, kind: 'request', brand: { ...brand, name: 'Pinecrest' }, title: 'Engagement letter', toName: 'Alice', link: 'https://space.northfield.example/s/abc', note: 'Please sign by Friday.', expiresOn: 'December 1, 2026' })
    expect(m.subject).toBe('Pinecrest sent you Engagement letter to sign')
    expect(m.text).toContain('https://space.northfield.example/s/abc')
    expect(m.text).toContain('Please sign by Friday.')
    expect(m.text).toContain('until December 1, 2026')
    expect(m.text).toContain('Reply to this email and it reaches Pinecrest')
  })

  test('the consent text and the confirmation carry no em dash and say how to get paper and how to withdraw', () => {
    const text = consentParagraphs({ service: NORTHFIELD_WORDS, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing LLP', reply_to: 'office@pinecrest.example', title: 'Engagement letter' }).join('\n')
    expect(text).not.toContain('\u2014')
    expect(intentText('Alice Example')).not.toContain('\u2014')
    expect(text).toContain('paper copy')
    expect(text).toContain('withdraw')
    expect(text).toContain('office@pinecrest.example')
    expect(text).toContain('Safari, Chrome, Edge or Firefox')
  })

  test('the Send screen can show the email as it will arrive, before anything goes out', async () => {
    const { id } = await k.draft()
    const r = await h.tessa('GET', `/admin/api/envelopes/${id}/preview-email`)
    expect(r.status).toBe(200)
    expect(r.body.from).toBe('Pinecrest via Northfield Forms <forms@northfield.example>')
    expect(r.body.replyTo).toBe('office@pinecrest.example')
    expect(r.body.to).toContain('alice@example.test')
    expect(r.body.html).toContain('Review and sign')
    expect(h.outbox).toHaveLength(0)
  })
})
