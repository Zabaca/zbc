import { describe, expect, test } from 'bun:test'
import { AGENT, harness, RIDGEWAY, T0 } from '../test-support/harness'
import { ownerRequest } from '../test-support/owner-requests'

/**
 * Claude's draft route takes `from` on a NEW email, the address or name of one of Tessa's mailboxes, as the compose box
 * has always let Tessa choose. Driven through the agent route over the real store with three Gmail accounts and Ridgeway's mailbox. It stays a draft: nothing is sent here,
 * and sending (Claude's switch, Tessa's recorded instruction) is untouched.
 */

type H = ReturnType<typeof harness>

const ASHGROVE = { address: 'tessa@ashgrove.example', token: 'refresh-ashgrove', code: 'code-ashgrove' }
const HOMEMAIL = { address: 'tessa_marlow@gmail.com', token: 'refresh-homemail', code: 'code-homemail' }

async function world() {
  const h = harness({}, { ai: null, mailboxes: [RIDGEWAY] })
  h.google.mailbox.add({ id: 'z1', threadId: 'tz1', from: 'Dana Smith <dana@example.com>', subject: 'Quote', at: T0 })
  h.google.addAccount(ASHGROVE.address, ASHGROVE.token, ASHGROVE.code).add({
    id: 'f1',
    threadId: 'tf1',
    from: 'Arun Mehta <arun@example.org>',
    subject: 'Seed round',
    at: T0,
  })
  h.google.addAccount(HOMEMAIL.address, HOMEMAIL.token, HOMEMAIL.code)
  expect((await h.connect()).ok).toBe(true)
  expect((await h.connect(ASHGROVE.code)).ok).toBe(true)
  expect((await h.connect(HOMEMAIL.code)).ok).toBe(true)
  await h.drain()
  // Ridgeway's mailbox is a row once something has come to it, as in the compose tests.
  const arrived = await h.deliver(
    `Return-Path: <p@example.org>\nMIME-Version: 1.0\nFrom: Priya <p@example.org>\nDate: Mon, 26 Oct 2026 13:00:00 -0700\nMessage-ID: <p1@example.org>\nSubject: Hours\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\nOpen Sundays?\n`,
    { from: 'p@example.org', to: 'info@ridgewaycycles.example' },
  )
  expect(arrived.entered).toBe('filed')
  return h
}

const draft = (h: H, fields: Record<string, unknown>) =>
  h.request(AGENT, 'POST', '/api/drafts', { subject: 'Hello', body: 'A note for you.', why: 'Tessa asked.', ...fields })
const recordedFrom = (h: H, id: string) =>
  (
    h.db.query(`SELECT mb.address FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id WHERE m.id = ?`).get(id) as {
      address: string
    } | null
  )?.address
const pending = (h: H) =>
  (h.db.query(`SELECT count(*) AS n FROM message WHERE status IN ('draft', 'sending')`).get() as { n: number }).n
const contacts = (h: H) => (h.db.query(`SELECT count(*) AS n FROM contact`).get() as { n: number }).n
const conversationOf = (h: H, thread: string) =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(thread) as { id: string }).id
type Listed = Array<{ id: string; sendsFrom?: { name: string; address: string }; sentFrom?: string }>

describe('Claude chooses the From of a new email', () => {
  test('a Gmail account by its address, by its name, and with any case, and the drafts list says which', async () => {
    const h = await world()
    const byAddress = await draft(h, { address: 'carla@example.net', from: 'tessa_marlow@gmail.com' })
    const byName = await draft(h, { address: 'carla2@example.net', from: 'Ashgrove' })
    const cased = await draft(h, { address: 'carla3@example.net', from: 'Tessa_Marlow@Gmail.com' })
    for (const r of [byAddress, byName, cased]) expect(r.status).toBe(201)
    expect(recordedFrom(h, byAddress.json.id)).toBe('tessa_marlow@gmail.com')
    expect(recordedFrom(h, byName.json.id)).toBe('tessa@ashgrove.example')
    expect(recordedFrom(h, cased.json.id)).toBe('tessa_marlow@gmail.com')
    const listed = (await h.request(AGENT, 'GET', '/api/drafts')).json as Listed
    const of = (id: string) => listed.find((d) => d.id === id)
    expect(of(byAddress.json.id)?.sendsFrom).toEqual({ name: 'tessa_marlow', address: 'tessa_marlow@gmail.com' })
    expect(of(byName.json.id)?.sendsFrom).toEqual({ name: 'ashgrove', address: 'tessa@ashgrove.example' })
    // Still a draft: nothing went anywhere.
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(h.email.handed).toHaveLength(0)
  })

  test('it beats the mailbox the contact last wrote to', async () => {
    const h = await world()
    // Arun wrote to ashgrove; without a from the draft goes from there, with one it goes where Claude said.
    const habit = await draft(h, { address: 'arun@example.org' })
    const chosen = await draft(h, { address: 'arun@example.org', from: 'tessa_marlow@gmail.com' })
    expect(recordedFrom(h, habit.json.id)).toBe('tessa@ashgrove.example')
    expect(recordedFrom(h, chosen.json.id)).toBe('tessa_marlow@gmail.com')
  })

  test('a business mailbox by its address or its name, as the compose box can, and the drafts list shows it as sentFrom', async () => {
    const h = await world()
    const a = await draft(h, { address: 'new@example.net', from: 'info@ridgewaycycles.example' })
    const b = await draft(h, { address: 'new2@example.net', from: 'ridgeway cycles' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(recordedFrom(h, a.json.id)).toBe('info@ridgewaycycles.example')
    expect(recordedFrom(h, b.json.id)).toBe('info@ridgewaycycles.example')
    const listed = (await h.request(AGENT, 'GET', '/api/drafts')).json as Listed
    expect(listed.find((d) => d.id === a.json.id)?.sentFrom).toBe('info@ridgewaycycles.example')
  })

  test('absent from keeps today’s rule exactly: the mailbox the contact last wrote to, else the default', async () => {
    const h = await world()
    const toArun = await draft(h, { address: 'arun@example.org' })
    const toStranger = await draft(h, { address: 'fresh@example.net' })
    expect(recordedFrom(h, toArun.json.id)).toBe('tessa@ashgrove.example')
    expect(h.db.query(`SELECT mailbox_id FROM message WHERE id = ?`).get(toStranger.json.id)).toEqual({
      mailbox_id: null,
    })
    const listed = (await h.request(AGENT, 'GET', '/api/drafts')).json as Listed
    expect(listed.find((d) => d.id === toStranger.json.id)?.sendsFrom?.address).toBe('tessa@northfield.example')
  })
})

describe('what is refused, with nothing drafted and no contact made', () => {
  const refused = async (h: H, fields: Record<string, unknown>, says: RegExp) => {
    const people = contacts(h)
    const before = pending(h)
    const r = await draft(h, fields)
    expect(r.status).toBe(422)
    expect(String(r.json.error)).toMatch(says)
    expect(String(r.json.error)).toContain('Nothing was drafted')
    expect(pending(h)).toBe(before)
    expect(contacts(h)).toBe(people)
  }

  test('a mailbox that is none of ours, and a from that is not a name', async () => {
    const h = await world()
    await refused(h, { address: 'x@example.net', from: 'someone@else.example.com' }, /not one of the mailboxes/)
    await refused(h, { address: 'x@example.net', from: '' }, /address or name/)
    await refused(h, { address: 'x@example.net', from: { kind: 'gmail' } }, /address or name/)
    await refused(h, { address: 'x@example.net', from: 42 }, /address or name/)
  })

  test('a Gmail account whose grant lapsed, and one that was disconnected', async () => {
    const h = await world()
    h.google.lapsed.add(ASHGROVE.token)
    h.inbox.markGrantLapsed((h.inbox.mailboxRowAt(ASHGROVE.address) as { id: string }).id)
    await refused(h, { address: 'x@example.net', from: ASHGROVE.address }, /no longer accepts/)
    const homemail = (h.inbox.mailboxRowAt(HOMEMAIL.address) as { id: string }).id
    const gone = await h.mailroom.disconnectMailbox(homemail, 'tessa@northfield.example')
    expect(gone.ok).toBe(true)
    await refused(h, { address: 'x@example.net', from: HOMEMAIL.address }, /disconnected/)
    // The account that works is still chosen.
    expect((await draft(h, { address: 'x@example.net', from: 'tessa@northfield.example' })).status).toBe(201)
  })

  test('from on a reply, even one that names the conversation’s own mailbox', async () => {
    const h = await world()
    const conversationId = conversationOf(h, 'tf1')
    await refused(h, { conversationId, from: 'tessa_marlow@gmail.com', subject: '' }, /reply goes from the mailbox/)
    await refused(h, { conversationId, from: ASHGROVE.address, subject: '' }, /reply goes from the mailbox/)
    // Without it the reply is made, from its conversation's mailbox.
    const reply = await draft(h, { conversationId, subject: '' })
    expect(reply.status).toBe(201)
  })

  test('the compose box’s own field is still not read from the body', async () => {
    const h = await world()
    const r = await draft(h, { address: 'gus@example.net', sendFrom: { kind: 'business', mailboxId: 'x' } })
    expect(r.status).toBe(201)
    expect(h.db.query(`SELECT mailbox_id FROM message WHERE id = ?`).get(r.json.id)).toEqual({ mailbox_id: null })
  })
})

describe('a draft whose account Claude chose is sent from that account', () => {
  // The board's drafts name tessa@ashgrove.example and Tessa (or Claude, at his word) sends
  // them. Until now the choice was tested up to the draft and the compose box's choice through to the send; this holds Claude's choice through Claude's own send.
  const SAID = { text: 'send the Ashgrove outreach', where: 'session main', at: '2026-10-20T12:04:00Z' }

  test("a new email naming tessa@ashgrove.example goes out through Claude's send, on Tessa's instruction, from ashgrove.example and from no other account", async () => {
    const h = await world()
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200) // Tessa's switch
    h.tick(240_000)
    const made = await draft(h, {
      address: 'ana@example.test',
      from: ASHGROVE.address,
      subject: 'Your talk',
      body: 'Ana, your talk on queues stayed with me.',
    })
    expect(made.status).toBe(201)
    h.google.calls.length = 0
    h.google.calledWith.length = 0

    const sent = await h.request(AGENT, 'POST', `/api/drafts/${made.json.id}/send`, {
      rev: made.json.rev,
      instruction: SAID,
    })
    expect(sent.status, JSON.stringify(sent.json)).toBe(200)
    await h.drain()

    // Gmail was asked to send once, with ashgrove.example's grant, and the message is from ashgrove.example; the other two accounts sent nothing and were not asked to.
    const sends = h.google.calls.flatMap((c, i) => (c.startsWith('send') ? [h.google.calledWith[i]] : []))
    expect(sends).toEqual([ASHGROVE.token])
    expect(h.google.mailbox.sent).toHaveLength(0) // tessa@northfield.example's mailbox
    const row = h.db
      .query(
        `SELECT mb.address AS address, m.status AS status, m.from_header AS from_header FROM message m LEFT JOIN mailbox mb ON mb.id = m.mailbox_id WHERE m.id = ?`,
      )
      .get(made.json.id) as {
      address: string
      status: string
      from_header: string
    }
    expect(row.status).toBe('sent')
    expect(row.address).toBe(ASHGROVE.address)
    expect(row.from_header).toContain(ASHGROVE.address)
    expect(row.from_header).not.toContain('northfield.example')
    // Recorded with Tessa's words, where and when, as every one of Claude's sends is.
    const listed = (await h.request(AGENT, 'GET', '/api/claude-sends')).json as {
      message: { id: string; instruction: unknown }
    }[]
    expect(listed.find((x) => x.message.id === made.json.id)?.message.instruction).toEqual({
      ...SAID,
      at: '2026-10-20T12:04:00.000Z',
    })
  })
})
