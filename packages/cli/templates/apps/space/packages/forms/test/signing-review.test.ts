// What a review found, each pinned: a correction that must not let a retry send the new link to the old address, a
// save that must not land after a signer committed, an instruction that must name what it covers, a purge that must not take a
// draft that was just sent, an agent's send that must not go if the draft changed under it, a stuck seal that gives up, and the
// downloads and fields that must stop where they should.
import { PDF } from '@libpdf/core'
import { beforeEach, describe, expect, test } from 'bun:test'
import { fixtureBytes } from '../scripts/fixtures'
import { appendEvents, tailSeq } from '../src/events'
import { workingCopy } from '../src/pdf/engine'
import { placeValue } from '../src/signing/completion'
import type { Db } from '../src/records'
import { type Actor, finish, flushMail, purgeEnvelope, recordInstruction, remind, send, setAgentSending, sweep, updateDraft, correctRecipient } from '../src/signing'
import { Guarded } from '../src/signing/support'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const DAY = 24 * 3_600_000
const START = Date.UTC(2026, 9, 31, 20)
const TESSA: Actor = { kind: 'operator', email: 'tessa@northfield.example', name: 'Tessa' }
const CLAUDE: Actor = { kind: 'agent', label: 'agent:forms api (claude)', onWordOf: 'tessa@northfield.example' }
const said = (envelopeId: string, action: 'send' | 'remind' | 'cancel' | 'correct-recipient', over: Record<string, unknown> = {}) => ({ envelopeId, action, words: 'Yes, do it.', channel: 'session', saidAt: new Date(START - 60_000).toISOString(), ...over })

/** The same core with its database wrapped, so a test can make something happen between two of its reads and writes. */
function withHook(hooks: { onBatch?: () => Promise<void>; onPrepare?: (sql: string) => Promise<void> | void }) {
  const core = h.core()
  const real = core.db
  const db: Db = {
    prepare(sql) {
      void hooks.onPrepare?.(sql)
      return real.prepare(sql)
    },
    async batch(stmts) {
      const once = hooks.onBatch
      hooks.onBatch = undefined
      await once?.()
      return real.batch(stmts)
    },
  }
  return { ...core, db }
}

describe('a correction supersedes what was waiting for the old address', () => {
  test('a request that failed to reach jon@ is never retried to jon@ with the new live link', async () => {
    h.mail.failWith = 'mail service is down'
    const { id } = await k.sent({ recipients: [{ ...ALICE, email: 'jon@example.test' }, BOB] })
    expect(h.sql<{ status: string; to_email: string }>("SELECT status, to_email FROM mail WHERE kind = 'request'")).toEqual([{ status: 'pending', to_email: 'jon@example.test' }])
    h.mail.failWith = null
    const jon = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'jon@example.test'")[0]!.id
    expect((await h.tessa('POST', `/admin/api/envelopes/${id}/recipients/${jon}/correct`, { email: 'john@example.test' })).status).toBe(200)
    // The correction emailed john@, and the old row says why it will never be sent.
    expect(h.outbox.map((m) => m.to.email)).toEqual(['john@example.test'])
    expect(h.sql<{ status: string; error: string; to_email: string }>("SELECT status, error, to_email FROM mail WHERE to_email = 'jon@example.test'")).toEqual([{ status: 'failed', error: 'superseded by a correction', to_email: 'jon@example.test' }])
    h.setClock(START + 10 * 60_000)
    await sweep(h.core())
    expect(h.outbox.map((m) => m.to.email)).toEqual(['john@example.test'])
  })

  test('a pending reminder for the old address is superseded too', async () => {
    const { id } = await k.sent({ recipients: [{ ...ALICE, email: 'jon@example.test' }, BOB] })
    h.mail.failWith = 'down'
    await h.tessa('POST', `/admin/api/envelopes/${id}/remind`, {})
    h.mail.failWith = null
    const jon = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'jon@example.test'")[0]!.id
    await h.tessa('POST', `/admin/api/envelopes/${id}/recipients/${jon}/correct`, { email: 'john@example.test' })
    h.outbox.length = 0
    h.setClock(START + 10 * 60_000)
    await sweep(h.core())
    expect(h.outbox).toHaveLength(0)
  })

  test('a message is refused if its recipient\'s address is no longer the one it was recorded for', async () => {
    h.mail.failWith = 'down'
    const { id } = await k.sent()
    h.mail.failWith = null
    // The address changed some other way than a correction (a draft edit cannot, but a row can): the row must still not send.
    h.sql("UPDATE recipients SET email = 'someone.else@example.test' WHERE email = 'alice@example.test'")
    const row = h.sql<{ id: string }>("SELECT id FROM mail WHERE kind = 'request'")[0]!.id
    expect(await flushMail(h.core(), row)).toBe('failed')
    expect(h.outbox).toHaveLength(0)
    expect(h.sql<{ error: string }>('SELECT error FROM mail WHERE id = ?', row)[0]!.error).toContain('address changed')
    expect(id).toBeTruthy()
  })
})

describe('a message that carries a link is not sent once the envelope has ended', () => {
  test('a request that was waiting when the envelope was cancelled is failed, not sent; the cancellation notice still goes', async () => {
    h.mail.failWith = 'down'
    const { id } = await k.sent({ order: 'parallel' })
    await h.tessa('POST', `/admin/api/envelopes/${id}/cancel`, { reason: 'Sent in error' })
    h.mail.failWith = null
    h.setClock(START + 10 * 60_000)
    await sweep(h.core())
    expect(h.sql<{ kind: string; status: string }>('SELECT kind, status FROM mail ORDER BY kind, to_email').filter((m) => m.kind === 'request').map((m) => m.status)).toEqual(['failed', 'failed'])
    expect(h.outbox.every((m) => !/\/s\/[\w-]{43}/.test(m.text))).toBe(true)
    expect(h.outbox.filter((m) => /was cancelled/.test(m.subject))).toHaveLength(2)
  })
})

describe('a field saved as a signer goes cannot land after they committed', () => {
  test('the batch itself requires the recipient to be consented', async () => {
    const { id } = await k.sent()
    const alice = k.tokenFor('alice@example.test')
    await k.signAs(alice, 'Alice', { skipFinish: true })
    const recipient = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    const field = h.sql<{ id: string }>("SELECT id FROM fields WHERE recipient_id = ? AND type = 'text'", recipient)[0]!.id
    const write = async (statuses: string[]) => {
      const g = Guarded.onState(h.env().DB, id, ['sent'], { id: recipient, status: statuses })
      g.mutate('DELETE FROM field_values WHERE field_id = ?', field)
      g.insert('field_values', { field_id: field, envelope_id: id, client_id: h.sql<{ client_id: string }>('SELECT client_id FROM envelopes')[0]!.client_id, value_enc: 'e1.late', filled_by: recipient, filled_at: 'now' })
      await h.env().DB.batch(g.stmts)
      return h.sql<{ value_enc: string }>('SELECT value_enc FROM field_values WHERE field_id = ?', field)[0]?.value_enc
    }
    // Once the signer has signed, the same write finds the recipient is not consented and changes nothing.
    expect(await k.as(alice)('POST', '/finish', { intent: true })).toMatchObject({ status: 200 })
    const before = h.sql<{ value_enc: string }>('SELECT value_enc FROM field_values WHERE field_id = ?', field)[0]!.value_enc
    expect(await write(['consented'])).toBe(before)
  })
})

describe('an instruction for a correction names the recipient and the new address', () => {
  test('recording one without them is refused, and the gate refuses a row that somehow has none', async () => {
    const { id } = await k.sent()
    const core = h.core()
    await setAgentSending(core, TESSA, true)
    await expect(recordInstruction(core, CLAUDE, said(id, 'correct-recipient'))).rejects.toMatchObject({ status: 400 })
    const bob = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'bob@example.test'")[0]!.id
    await expect(recordInstruction(core, CLAUDE, said(id, 'correct-recipient', { target: { recipientId: bob } }))).rejects.toMatchObject({ status: 400 })
    // A row written around the app (the database does not forbid it) still does not cover a correction.
    h.sql("INSERT INTO instructions (id, envelope_id, client_id, action, words, channel, said_at, recorded_at, recorded_by, sha256) SELECT 'loose', id, client_id, 'correct-recipient', 'w', 'session', 'a', 'b', 'c', 'd' FROM envelopes")
    await expect(correctRecipient(core, CLAUDE, {}, id, bob, { email: 'x@example.test' }, { instructionId: 'loose' })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('does not name') })
  })

  test('a reminder\'s target stays optional: it may cover everyone who is acting', async () => {
    const { id } = await k.sent()
    const core = h.core()
    await setAgentSending(core, TESSA, true)
    const ins = await recordInstruction(core, CLAUDE, said(id, 'remind'))
    expect(await remind(core, CLAUDE, {}, id, { instructionId: ins.id })).toBe(1)
  })
})

describe('a purge takes only what is due', () => {
  test('a draft that was sent after the sweep read it is left alone, with its files', async () => {
    const { id } = await k.draft()
    expect(h.sql<{ purge_at: string | null }>('SELECT purge_at FROM envelopes WHERE id = ?', id)[0]!.purge_at).not.toBeNull()
    h.setClock(START + 91 * DAY)
    // The sweep read it as due; a person sends it before the purge runs (sending clears the purge time).
    h.sql('UPDATE envelopes SET purge_at = NULL, status = \'sent\' WHERE id = ?', id)
    expect(await purgeEnvelope(h.core(), { kind: 'system' }, id, 'unfinished')).toBe(false)
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toHaveLength(1)
    expect([...h.files().objects.keys()].filter((key) => key.startsWith(`envelopes/${id}/`))).not.toHaveLength(0)
    expect(h.sql('SELECT 1 FROM tombstones')).toHaveLength(0)
  })

  test('if it stops being due between the check and the batch, the batch deletes nothing', async () => {
    const { id } = await k.draft()
    h.setClock(START + 91 * DAY)
    const core = withHook({ onBatch: async () => void h.sql('UPDATE envelopes SET purge_at = NULL WHERE id = ?', id) })
    expect(await purgeEnvelope(core, { kind: 'system' }, id, 'unfinished')).toBe(false)
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toHaveLength(1)
    expect(h.sql('SELECT 1 FROM recipients WHERE envelope_id = ?', id).length).toBeGreaterThan(0)
    expect(h.sql('SELECT 1 FROM tombstones')).toHaveLength(0)
  })

  test('what is due is purged', async () => {
    const { id } = await k.draft()
    h.setClock(START + 91 * DAY)
    expect(await purgeEnvelope(h.core(), { kind: 'system' }, id, 'unfinished')).toBe(true)
    expect(h.sql('SELECT 1 FROM envelopes WHERE id = ?', id)).toHaveLength(0)
  })
})

describe('an agent\'s send is conditioned on the draft it was given', () => {
  test('appendEvents refuses a write whose log has moved on since the caller read it', async () => {
    const { id } = await k.draft()
    const db = h.env().DB
    const e = { id, client_id: h.sql<{ client_id: string }>('SELECT client_id FROM envelopes')[0]!.client_id }
    const tail = await tailSeq(db, id)
    const first = await appendEvents(db, e, [{ action: 'draft-edited', actorKind: 'system' }], { now: START, whenTail: tail })
    expect(first.applied).toBe(true)
    const stale = await appendEvents(db, e, [{ action: 'draft-edited', actorKind: 'system' }, { action: 'draft-edited', actorKind: 'system' }], { now: START, whenTail: tail })
    expect(stale.applied).toBe(false)
    expect(await tailSeq(db, id)).toBe(tail + 1)
    // Several events written at once each follow the one before: a current tail lets all of them in.
    const several = await appendEvents(db, e, [{ action: 'draft-edited', actorKind: 'system' }, { action: 'draft-edited', actorKind: 'system' }], { now: START, whenTail: tail + 1 })
    expect(several.applied).toBe(true)
  })

  test('an edit that lands after the instruction was checked and before the batch stops the send, and emails nobody', async () => {
    const { id } = await k.draft()
    const real = h.core()
    await setAgentSending(real, TESSA, true)
    const ins = await recordInstruction(real, CLAUDE, said(id, 'send'))
    const core = withHook({ onBatch: async () => void (await updateDraft(real, TESSA, id, { note: 'Changed at the last moment' })) })
    await expect(send(core, CLAUDE, {}, id, { instructionId: ins.id })).rejects.toMatchObject({ status: 409 })
    expect(h.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('draft')
    expect(h.outbox).toHaveLength(0)
    expect(h.sql('SELECT 1 FROM instruction_uses')).toHaveLength(0)
  })
})

describe('a reminder to one person is not sent to someone who just signed', () => {
  test('if they sign between the choice and the batch, nothing is written or emailed', async () => {
    const { id } = await k.sent()
    const alice = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    h.outbox.length = 0
    const core = withHook({ onBatch: async () => void h.sql("UPDATE recipients SET status = 'signed' WHERE id = ?", alice) })
    await expect(remind(core, TESSA, {}, id, { recipientId: alice })).rejects.toMatchObject({ status: 409 })
    expect(h.outbox).toHaveLength(0)
    expect(k.actions(id)).not.toContain('reminded')
    expect(h.sql("SELECT 1 FROM mail WHERE kind = 'reminder'")).toHaveLength(0)
  })
})

describe('an envelope that cannot be sealed gives up', () => {
  test('the sweep tries a few times, tells the operator once, stops, and the envelope has a day to be purged', async () => {
    const broken = harness({ FORMS_SEAL_KEY: 'not a key' })
    const kk = kit(broken)
    const { id } = await kk.sent({ order: 'parallel' })
    await kk.signAs(kk.tokenFor('alice@example.test'))
    await kk.signAs(kk.tokenFor('bob@example.test'))
    expect(broken.sql<{ status: string; purge_at: string }>('SELECT status, purge_at FROM envelopes WHERE id = ?', id)[0]).toMatchObject({ status: 'sealing', purge_at: new Date(START + 90 * DAY).toISOString() })
    broken.outbox.length = 0
    let t = START
    const tries: number[] = []
    for (let i = 0; i < 8; i++) {
      t += 11 * 60_000
      broken.setClock(t)
      await sweep(broken.core())
      tries.push(broken.sql<{ n: number }>('SELECT sealing_attempts AS n FROM envelopes WHERE id = ?', id)[0]!.n)
    }
    expect(tries).toEqual([1, 2, 3, 4, 5, 5, 5, 5])
    const told = broken.outbox.filter((m) => m.to.email === 'tessa@northfield.example')
    expect(told).toHaveLength(1)
    expect(told[0]!.subject).toContain('Could not finish')
    expect(told[0]!.text).toContain('stopped trying')
    expect(broken.sql<{ status: string }>('SELECT status FROM envelopes WHERE id = ?', id)[0]!.status).toBe('sealing')
    // Left alone it is deleted: it has had a purge time since it began sealing.
    broken.setClock(START + 91 * DAY)
    expect((await sweep(broken.core())).purged).toBe(1)
  })
})

describe('the certificate on a link stops when the download does', () => {
  test('it names every signer\'s IP and device, so it is shown for 90 days and then not', async () => {
    await k.sent()
    const alice = k.tokenFor('alice@example.test')
    await k.signAs(alice)
    await k.signAs(k.tokenFor('bob@example.test'))
    h.setClock(START + 89 * DAY)
    expect((await k.as(alice)('GET', '/certificate')).status).toBe(200)
    expect((await k.as(alice)('GET', '')).body.certificate).toBe(true)
    h.setClock(START + 91 * DAY)
    expect((await k.as(alice)('GET', '/certificate')).status).toBe(410)
    expect((await k.as(alice)('GET', '')).body.certificate).toBe(false)
  })
})

describe('a field that fills the PDF\'s own field is written into it, a date included', () => {
  test('the W-9\'s own text fields take the signer\'s line and the date, and nothing is stamped over them', async () => {
    const wc = await workingCopy(await fixtureBytes('w9'))
    expect(wc.ok).toBe(true)
    if (!wc.ok) return
    const own = wc.value.inspection.fields.filter((f) => f.kind === 'text' && f.page === 0 && f.box)
    const [nameField, dateField] = [own[0]!, own[1]!]
    const client = await h.makeClient()
    h.sql("INSERT INTO source_documents (id, client_id, name, original_key, original_sha256, original_size, working_key, working_sha256, working_size, page_count, inspection, wrapped_key, key_version, uploaded_by, created_at) VALUES ('w9', ?, 'W-9', 'o', 'h', 1, 'w', 'h', 1, 6, '{}', 'x', 1, 'test', 'now')", client.id)
    const core = h.core()
    const { createEnvelope } = await import('../src/signing')
    const sig = { x: 0.1, y: 0.8, width: 0.3, height: 0.04 }
    const e = await createEnvelope(core, TESSA, {
      clientId: client.id,
      kind: 'document',
      title: 'W-9',
      sourceDocumentId: 'w9',
      recipients: [ALICE],
      prepared: {
        bytes: wc.value.bytes,
        pages: wc.value.inspection.pages.map((p) => ({ index: p.index, width: p.width, height: p.height, rotation: p.rotation })),
        fields: [
          { recipient: 1, type: 'signature', page: 0, box: sig, required: true },
          { recipient: 1, type: 'text', page: 0, box: nameField.box!, required: true, label: 'Name', pdfFieldName: nameField.name },
          { recipient: 1, type: 'date', page: 0, box: dateField.box!, required: true, label: 'Date', pdfFieldName: dateField.name },
        ],
      },
    })
    await send(core, TESSA, {}, e.id)
    await k.signAs(k.tokenFor('alice@example.test'), 'Alice Example')
    const pdf = await PDF.load(k.attachment('alice@example.test'))
    // On the form's own page each value appears once: in its field, not in the field and again stamped over it.
    const first = pdf.getPage(0)!.extractText().text
    expect(first.match(/Alice Example/g)).toHaveLength(1)
    expect(first.match(/Oct 31, 2026/g)).toHaveLength(1)
    expect(pdf.getPageCount()).toBeGreaterThan(6)
  })
})

describe('where a value goes in the finished PDF', () => {
  test('a field with a name in the PDF fills that field, whatever its type; any other is stamped; a picture is a picture', () => {
    expect(placeValue({ type: 'date', pdf_field_name: 'f1' }, '2026-10-31')).toEqual({ kind: 'fill', name: 'f1', value: 'Oct 31, 2026' })
    expect(placeValue({ type: 'date', pdf_field_name: null }, '2026-10-31')).toEqual({ kind: 'stamp', text: 'Oct 31, 2026' })
    expect(placeValue({ type: 'text', pdf_field_name: 'f2' }, 'Alice')).toEqual({ kind: 'fill', name: 'f2', value: 'Alice' })
    expect(placeValue({ type: 'text', pdf_field_name: null }, 'Alice')).toEqual({ kind: 'stamp', text: 'Alice' })
    expect(placeValue({ type: 'checkbox', pdf_field_name: 'c' }, true)).toEqual({ kind: 'fill', name: 'c', value: true })
    expect(placeValue({ type: 'checkbox', pdf_field_name: null }, true)).toEqual({ kind: 'check' })
    expect(placeValue({ type: 'checkbox', pdf_field_name: 'c' }, false)).toEqual({ kind: 'fill', name: 'c', value: false })
    expect(placeValue({ type: 'checkbox', pdf_field_name: null }, false)).toEqual({ kind: 'none' })
    expect(placeValue({ type: 'signature', pdf_field_name: null }, 'adopted')).toEqual({ kind: 'picture' })
  })
})

describe('a save between Finish\'s read and its batch', () => {
  async function ready(order: 'sequential' | 'parallel' = 'parallel') {
    const { id } = await k.sent({ order })
    const token = k.tokenFor('alice@example.test')
    await k.signAs(token, 'Alice Original', { skipFinish: true })
    const recipient = h.sql<{ id: string }>("SELECT id FROM recipients WHERE email = 'alice@example.test'")[0]!.id
    const field = h.sql<{ id: string }>("SELECT id FROM fields WHERE recipient_id = ? AND type = 'text'", recipient)[0]!.id
    return { id, token, field }
  }

  test('is not signed over: Finish says so, writes nothing, and the retry hashes and stamps the new value', async () => {
    const { id, token, field } = await ready()
    // The signer's other tab changes the line after Finish has read their values and before its batch runs.
    const core = withHook({ onBatch: async () => void expect((await k.as(token)('PUT', `/fields/${field}`, { value: 'Alice Changed' })).status).toBe(200) })
    await expect(finish(core, token, {}, { intent: true })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed while you were finishing') })
    expect(k.actions(id)).not.toContain('signed')
    expect(h.sql<{ status: string }>("SELECT status FROM recipients WHERE email = 'alice@example.test'")[0]!.status).toBe('consented')
    // Looking again and pressing Finish signs the value the signer now has, and the event hashes exactly that.
    expect((await k.as(token)('POST', '/finish', { intent: true })).status).toBe(200)
    const hashed = JSON.parse(k.events(id).find((e) => e.action === 'signed')!.details).values_sha256
    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
    await k.signAs(k.tokenFor('bob@example.test'), 'Bob')
    const first = (await (await import('@libpdf/core')).PDF.load(k.attachment('alice@example.test'))).getPage(0)!.extractText().text
    expect(first).toContain('Alice Changed')
    expect(first).not.toContain('Alice Original')
  })

  test('the same value saved again, or a new picture adopted, moves the version too; a signed signer\'s save changes nothing', async () => {
    const { token, field } = await ready()
    const version = () => h.sql<{ v: number }>("SELECT values_version AS v FROM recipients WHERE email = 'alice@example.test'")[0]!.v
    const v0 = version()
    await k.as(token)('PUT', `/fields/${field}`, { value: 'Alice Original' })
    expect(version()).toBe(v0 + 1)
    await k.as(token)('POST', '/adopt', { kind: 'signature', method: 'drawn', image: (await import('./signing-kit')).png(1, 2, 3) })
    expect(version()).toBe(v0 + 2)
    expect((await k.as(token)('POST', '/finish', { intent: true })).status).toBe(200)
    const after = version()
    expect((await k.as(token)('PUT', `/fields/${field}`, { value: 'Too late' })).status).toBe(410)
    expect(version()).toBe(after)
  })
})
