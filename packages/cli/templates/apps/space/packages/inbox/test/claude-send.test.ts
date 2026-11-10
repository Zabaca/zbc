import { describe, expect, test } from 'bun:test'
import { GmailError } from '../src/gmail/google'
import type { ClaudeSend, ClaudeSending, MessageRow } from '../src/types'
import { AGENT, AGENT_ID, harness, OWNER, STRANGER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { as, ownerRequest } from '../test-support/owner-requests'

/**
 * Step 6: Claude sends on Tessa's instruction, through the inbox's Worker as a function with
 * a Google that can fail (the highest seam these tests have). The point of
 * this file is the pair of gates and the record: Claude's send is refused without Tessa's
 * instruction and while the switch is off (which is how it ships), an accepted one carries
 * its instruction with it everywhere it is shown, and every safeguard of Tessa's own send
 * (send.test.ts) applies to Claude's unchanged. Only the owner flips the switch or says how a
 * send of unknown outcome went.
 *
 * What this cannot show is Google, nor that an instruction was ever given: the inbox cannot
 * see a chat, so the record is Claude's own account, and nothing here pretends otherwise.
 * The em dash is written as an escape because this repo has none.
 */

type H = ReturnType<typeof harness>

const AGENT_ACTOR = `agent:${AGENT_ID}`
const DASH = '\u2014'
const WORDS = 'Thanks Dana. Tuesday works for me.'

/** What Claude records: Tessa's words as it received them, where, and when (four minutes after the harness clock starts, after every message the tests store, and inside the five minutes of skew allowed). */
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }

async function live(h: H, setup?: () => void) {
  setup?.()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

/** A push as Google delivers it, then the alarm it sets: the echo of whatever just happened in Gmail. */
async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
}

const dana = (h: H) => () => {
  h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote for the shop' })
}

const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

const detail = async (h: H, threadId: string) =>
  (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h, threadId)}`)).json

const sent = (h: H) => h.google.mailbox.sent
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const audits = async (h: H) =>
  (await ownerRequest(h, 'GET', '/api/audit')).json as {
    action: string
    actor: string
    before: unknown
    after: unknown
  }[]
const bySent = async (h: H, who: Record<string, unknown> = OWNER) =>
  (await as(h, who, 'GET', '/api/claude-sends')).json as ClaudeSend[]
const sendingState = async (h: H, who: Record<string, unknown> = AGENT) =>
  (await as(h, who, 'GET', '/api/settings/claude-sending')).json as ClaudeSending

/** Tessa turns Claude's sending on (or off), as the page does. */
async function allow(h: H, enabled = true) {
  const res = await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
}

/** A reply draft on thread t1, made by Claude (it always drafts, so Tessa can see it). */
async function claudeReply(h: H, extra: Record<string, unknown> = {}): Promise<MessageRow> {
  const res = await h.request(AGENT, 'POST', '/api/drafts', {
    conversationId: convoId(h, 't1'),
    body: WORDS,
    why: 'She asked for a time.',
    ...extra,
  })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json
}

/** Claude's send as its script makes it: the revision and `through` it read, and the instruction. */
async function claudeSends(
  h: H,
  draft: MessageRow,
  over: Record<string, unknown> = {},
  through: number | null | undefined = undefined,
) {
  const reached = through === undefined ? (await detail(h, 't1')).through : through
  return h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
    rev: draft.rev,
    ...(reached === null ? {} : { through: reached }),
    instruction: SAID,
    ...over,
  })
}

/** Everything a failed send must leave alone, as one string to compare. */
const snapshot = (h: H) =>
  JSON.stringify([
    h.db.query(`SELECT * FROM message ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM conversation ORDER BY rowid`).all(),
  ])

describe('the switch', () => {
  test('ships OFF: Claude sends nothing, says why, and changes nothing', async () => {
    const h = harness()
    await live(h, dana(h))
    expect(await sendingState(h)).toEqual({ enabled: false, changedAt: null, changedBy: null })
    expect(await sendingState(h, OWNER)).toMatchObject({ enabled: false })
    const draft = await claudeReply(h)
    const before = snapshot(h)
    const calls = h.google.calls.length

    const res = await claudeSends(h, draft)
    expect(res.status).toBe(403)
    expect(res.json.error).toContain('switched off')
    expect(res.json.error).toContain('Only Tessa can switch it on')
    expect(h.google.calls).toHaveLength(calls)
    expect(snapshot(h)).toBe(before)
    expect(sent(h)).toHaveLength(0)
    expect((await audits(h)).some((a) => a.action === 'message.sending')).toBe(false)
  })

  test('only Tessa flips it, and he is audited; Claude, a stranger and a bad body cannot', async () => {
    const h = harness()
    await live(h)
    // Claude's door has no route for the switch at all (it was Tessa's page's, and is the space's now), so the agent finds nothing there.
    expect((await h.request(AGENT, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(404)
    expect((await h.request(STRANGER, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(403)
    expect((await h.request(null, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(401)
    expect(await sendingState(h)).toMatchObject({ enabled: false })
    // (A yes or a no, never an empty body or a word, was the deleted route's check; the space's method takes a boolean, test/space-views.test.ts.)

    h.tick()
    await allow(h)
    expect(await sendingState(h)).toEqual({
      enabled: true,
      changedAt: '2026-10-20T12:01:00.000Z',
      changedBy: OWNER_EMAIL,
    })
    const flips = (await audits(h)).filter((a) => a.action === 'setting.claude-sending')
    expect(flips).toHaveLength(1)
    expect(flips[0]).toMatchObject({
      actor: OWNER_EMAIL,
      before: { enabled: false },
      after: { enabled: true, changedBy: OWNER_EMAIL },
    })
  })

  test('the store refuses everyone but the owner too, whatever route reaches it', async () => {
    const h = harness()
    for (const actor of [AGENT_ACTOR, 'teammate@example.com', '']) {
      expect(h.inbox.setClaudeSending(true, actor)).toMatchObject({ ok: false, status: 403 })
    }
    expect(h.inbox.claudeSending().enabled).toBe(false)
    expect(h.inbox.setClaudeSending(true, OWNER_EMAIL)).toMatchObject({ ok: true })
    expect(h.inbox.claudeSending().enabled).toBe(true)
  })

  test('switching it off stops Claude sending and leaves its drafting alone', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const first = await claudeReply(h)
    expect((await claudeSends(h, first)).status).toBe(200)

    h.tick()
    await allow(h, false)
    const second = await claudeReply(h, { body: 'And one more thing.' })
    expect(second).toMatchObject({ status: 'draft', createdBy: AGENT_ACTOR })
    expect(
      (await h.request(AGENT, 'PATCH', `/api/drafts/${second.id}`, { rev: second.rev, body: 'Edited.' })).status,
    ).toBe(200)
    const refused = await claudeSends(h, { ...second, rev: second.rev + 1 })
    expect(refused.status).toBe(403)
    expect(sent(h)).toHaveLength(1)
    // Tessa's own Send does not look at it.
    const mine = (await ownerRequest(h, 'GET', '/api/drafts')).json as MessageRow[]
    const draft = mine.find((d) => d.id === second.id) as MessageRow
    const through = (await detail(h, 't1')).through
    expect((await ownerRequest(h, 'POST', `/api/drafts/${second.id}/send`, { rev: draft.rev, through })).status).toBe(
      200,
    )
    expect(sent(h)).toHaveLength(2)
  })

  test('flipped off while Gmail is being asked about the thread, the claim still refuses and nothing goes out', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const through = (await detail(h, 't1')).through
    h.google.onCall = (call) => {
      if (call.startsWith('getThreadLabels')) h.inbox.setClaudeSending(false, OWNER_EMAIL)
    }

    const res = await claudeSends(h, draft, {}, through)
    expect(res.status).toBe(403)
    expect(res.json.error).toContain('switched off')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null })
  })
})

describe('Claude sends on an instruction', () => {
  test('a reply goes out like Tessa’s, in the thread, and is filed as sent by Claude with the instruction', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)

    const res = await claudeSends(h, draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({
      status: 'sent',
      sentBy: AGENT_ACTOR,
      createdBy: AGENT_ACTOR,
      instruction: { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00.000Z' },
    })

    // What Gmail was given is exactly what Tessa's own send gives it: from him, to Dana, in the thread.
    expect(sent(h)).toHaveLength(1)
    expect(sent(h)[0]?.threadId).toBe('t1')
    expect(sent(h)[0]?.headers).toMatchObject({
      From: 'Tessa Marlow <tessa@northfield.example>',
      To: 'dana@example.com',
      Subject: 'Re: Quote for the shop',
      'In-Reply-To': '<m1@example.com>',
    })
    expect(sent(h)[0]?.body).toBe(WORDS)

    // The draft it came from and the message that went out are one record, shown with the words.
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      sent_by: AGENT_ACTOR,
      instruction_text: 'send it',
      instruction_where: 'session main',
      instruction_at: '2026-10-20T12:04:00.000Z',
    })
    const shown = await detail(h, 't1')
    const message = shown.messages.find((m: MessageRow) => m.id === draft.id)
    expect(message.instruction).toEqual({ text: 'send it', where: 'session main', at: '2026-10-20T12:04:00.000Z' })
    expect(shown.drafts).toHaveLength(0)

    // The list of Claude's sends has it, for Tessa and for Claude, once, and Gmail's echo adds nothing.
    await hear(h)
    for (const who of [OWNER, AGENT]) {
      const list = await bySent(h, who)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ proof: 'filed', message: { id: draft.id, instruction: { text: 'send it' } } })
    }
    expect(sent(h)).toHaveLength(1)
    expect((await detail(h, 't1')).messages).toHaveLength(2)
  })

  test('the record is written before Gmail is asked and audited with the instruction, the draft and its revision', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, body: 'Tuesday at ten works for me.' })
    const edited = (await ownerRequest(h, 'GET', '/api/drafts')).json[0] as MessageRow
    expect(edited.rev).toBe(1)

    let atClaim: Record<string, unknown> | null = null
    h.google.onCall = (call) => {
      if (call.startsWith('send')) atClaim = row(h, draft.id)
    }
    expect((await claudeSends(h, edited)).status).toBe(200)
    // At the moment Gmail was asked, the draft was already claimed with the words on it.
    expect(atClaim).toMatchObject({ status: 'sending', instruction_text: 'send it' })

    const log = await audits(h)
    const claim = log.find((a) => a.action === 'message.sending')
    expect(claim).toMatchObject({
      actor: AGENT_ACTOR,
      after: { rev: 1, subject: 'Re: Quote for the shop', instruction: { text: 'send it', where: 'session main' } },
    })
    const filed = log.find((a) => a.action === 'message.send')
    expect(filed).toMatchObject({
      actor: AGENT_ACTOR,
      after: { id: draft.id, body: 'Tuesday at ten works for me.', instruction: { text: 'send it' } },
    })
  })

  test('a new email to a contact, drafted by Claude, is sent the same way and needs no through', async () => {
    const h = harness()
    await live(h)
    await allow(h)
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'new@example.com',
      name: 'New Person',
      subject: 'Hello',
      body: 'Nice to meet you.',
      why: 'He asked for an intro.',
    })
    const draft = made.json as MessageRow
    const res = await h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev, instruction: SAID })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(sent(h)[0]?.headers.To).toBe('new@example.com')
    expect(sent(h)[0]?.headers['In-Reply-To']).toBeUndefined()
    expect((await bySent(h))[0]?.message).toMatchObject({ address: 'new@example.com', sentBy: AGENT_ACTOR })
  })

  test('a draft Tessa wrote can be sent on his word too, and the record says who wrote it', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const made = await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: WORDS })
    const res = await claudeSends(h, made.json)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ createdBy: OWNER_EMAIL, sentBy: AGENT_ACTOR })
  })

  test('the list of Claude’s sends is every Claude send, newest first, and never Tessa’s own', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const one = await claudeReply(h)
    expect((await claudeSends(h, one)).status).toBe(200)
    h.tick()
    const two = await claudeReply(h, { body: 'Second.' })
    expect((await claudeSends(h, two, { instruction: { ...SAID, text: 'just send it' } })).status).toBe(200)
    h.tick()
    const mine = await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: 'Mine.' })
    const through = (await detail(h, 't1')).through
    expect(
      (await ownerRequest(h, 'POST', `/api/drafts/${mine.json.id}/send`, { rev: mine.json.rev, through })).status,
    ).toBe(200)

    const list = await bySent(h)
    expect(list.map((e) => e.message.id)).toEqual([two.id, one.id])
    expect(list.map((e) => e.message.instruction?.text)).toEqual(['just send it', 'send it'])
  })
})

describe('a send with no instruction is refused, and so is every instruction that says nothing', () => {
  test('missing, empty, not an object or without words: 403, and nothing is read, claimed or sent', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const before = snapshot(h)
    const calls = h.google.calls.length

    const through = (await detail(h, 't1')).through
    const bare = await h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev, through })
    expect(bare.status).toBe(403)
    expect(bare.json.error).toContain('no instruction')
    for (const instruction of [
      null,
      '',
      'Tessa said send it',
      ['send it'],
      {},
      { text: '   ' },
      { where: 'x', at: SAID.at },
    ]) {
      const res = await claudeSends(h, draft, { instruction }, through)
      expect(res.status, JSON.stringify(instruction)).toBe(403)
    }
    expect(h.google.calls).toHaveLength(calls)
    expect(snapshot(h)).toBe(before)
    expect(sent(h)).toHaveLength(0)
  })

  test('words with no place, no time, a time that is not one, or one in the future: 422', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const through = (await detail(h, 't1')).through
    for (const instruction of [
      { text: 'send it', at: SAID.at },
      { text: 'send it', where: '  ', at: SAID.at },
      { text: 'send it', where: 'two\nlines', at: SAID.at },
      { text: 'send it', where: 'x'.repeat(201), at: SAID.at },
      { text: 'send it', where: 'a session' },
      { text: 'send it', where: 'a session', at: 'yesterday' },
      { text: 'send it', where: 'a session', at: '2026-10-20' },
      { text: 'send it', where: 'a session', at: '2026-10-20T13:00:00Z' },
      { text: 'x'.repeat(2001), where: 'a session', at: SAID.at },
    ]) {
      const res = await claudeSends(h, draft, { instruction }, through)
      expect(res.status, JSON.stringify(instruction).slice(0, 80)).toBe(422)
    }
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null })
  })

  test('Tessa’s own send needs none, and one handed to it is ignored and never recorded', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const made = await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: WORDS })
    const through = (await detail(h, 't1')).through
    const res = await ownerRequest(h, 'POST', `/api/drafts/${made.json.id}/send`, {
      rev: made.json.rev,
      through,
      instruction: SAID,
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ sentBy: OWNER_EMAIL, instruction: null })
    expect(row(h, made.json.id)).toMatchObject({ instruction_text: null })
    expect(await bySent(h)).toEqual([])
  })
})

describe('Claude sends a stored draft, never text of its own', () => {
  test('a press carrying words or recipients is refused outright, and a draft that is not there is a 404', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    for (const extra of [
      { body: 'Something else entirely.' },
      { subject: 'Another subject' },
      { text: 'Something else entirely.' },
      { to: 'evil@example.com' },
      { cc: 'evil@example.com' },
      { bcc: 'evil@example.com' },
    ]) {
      expect((await claudeSends(h, draft, extra)).status, JSON.stringify(extra)).toBe(422)
    }
    expect(
      (await h.request(AGENT, 'POST', '/api/drafts/no-such-draft/send', { rev: 0, instruction: SAID })).status,
    ).toBe(404)
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
  })

  test('mail that came in is not a draft, so there is nothing to send', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const inbound = (await detail(h, 't1')).messages[0] as MessageRow
    expect(inbound.direction).toBe('in')
    const res = await h.request(AGENT, 'POST', `/api/drafts/${inbound.id}/send`, {
      rev: 0,
      through: 0,
      instruction: SAID,
    })
    expect(res.status).toBe(409)
    expect(sent(h)).toHaveLength(0)
  })

  test('a draft edited after Claude read it is refused with a 409 and sent only at the revision it read', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    expect(
      (await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, body: 'Tessa changed this.' }))
        .status,
    ).toBe(200)

    const res = await claudeSends(h, draft)
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('changed after you last saw it')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null })
    const read = ((await h.request(AGENT, 'GET', '/api/drafts')).json as MessageRow[])[0] as MessageRow
    expect(read).toMatchObject({ rev: 1, body: 'Tessa changed this.' })
    expect((await claudeSends(h, read)).status).toBe(200)
    expect(sent(h)[0]?.body).toBe('Tessa changed this.')
  })
})

describe('every safeguard of Tessa’s send holds for Claude’s', () => {
  test('without the revision, or for a reply without through, it is a 422 and nothing is sent', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const noRev = await h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
      through: (await detail(h, 't1')).through,
      instruction: SAID,
    })
    expect(noRev.status).toBe(422)
    const noThrough = await claudeSends(h, draft, {}, null)
    expect(noThrough.status).toBe(422)
    expect(noThrough.json.error).toContain('through')
    expect(sent(h)).toHaveLength(0)
  })

  test('a reply over a message that arrived after Tessa’s instruction is refused, read again or not, until he says it anew', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const read = (await detail(h, 't1')).through
    // Tessa says "send it" about this draft, with Dana's first message the only one in the thread.
    const before = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })
    await hear(h)

    // Without reading the new message the through check stops it.
    const stale = await claudeSends(h, draft, { instruction: before }, read)
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('new message arrived')

    // Read again, with the new through and the OLD instruction: still refused, because what Tessa
    // agreed to was a draft written without that message, and the answer says to go back to him.
    const again = await claudeSends(h, draft, { instruction: before })
    expect(again.status).toBe(409)
    expect(again.json.error).toContain('after Tessa gave the instruction')
    expect(again.json.error).toContain('Do not retry')
    expect(again.json.error).toContain('new instruction from him')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null })
    expect((await audits(h)).some((a) => a.action === 'message.sending')).toBe(false)

    // He is shown the new message and the draft, and says it again: that is a new instruction.
    expect(
      (await claudeSends(h, draft, { instruction: { ...SAID, at: new Date(h.now()).toISOString() } })).status,
    ).toBe(200)
    expect(sent(h)).toHaveLength(1)
  })

  test('so is one Gmail has but the inbox has not heard of yet, which is stored first, and Tessa’s own press is not held to it', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const read = (await detail(h, 't1')).through
    const before = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })

    const refused = await claudeSends(h, draft, { instruction: before }, read)
    expect(refused.status).toBe(409)
    expect(sent(h)).toHaveLength(0)
    expect((await detail(h, 't1')).messages).toHaveLength(2)
    expect(
      (await claudeSends(h, draft, { instruction: { ...SAID, at: new Date(h.now()).toISOString() } })).status,
    ).toBe(200)
  })

  test('an instruction given after a reply arrived is not held to it: Tessa had the thread in front of him', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    h.tick()
    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })
    await hear(h)
    const res = await claudeSends(h, draft, { instruction: { ...SAID, at: new Date(h.now()).toISOString() } })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
  })

  test('a draft anyone but Claude changed after Tessa’s instruction is refused until he says it anew; Claude’s own edits and Tessa’s earlier ones are not', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    // Tessa edits the draft BEFORE he says "send it": he agreed to what he had edited.
    h.tick()
    const edited = (
      await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, body: 'Tessa’s earlier words.' })
    ).json
    h.tick()
    const said = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    // Claude changing its own draft after the instruction does not matter to the rule.
    const own = (
      await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: edited.rev, body: 'Claude’s own words.' })
    ).json
    expect(own.body).toBe('Claude’s own words.')
    // Tessa changes it AFTER the instruction (he now has not agreed to these words).
    h.tick()
    const later = (
      await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: own.rev, body: 'Tessa’s later words.' })
    ).json
    // Claude then edits again on top: it cannot hide Tessa's edit by being the last to touch the draft.
    h.tick()
    const hidden = (
      await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: later.rev, body: 'Claude on top.' })
    ).json
    const before = snapshot(h)
    const refused = await claudeSends(h, hidden, { instruction: said })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('after Tessa gave the instruction')
    expect(refused.json.error).toContain('go back to Tessa')
    expect(snapshot(h)).toBe(before)
    expect(sent(h)).toHaveLength(0)
    expect((await audits(h)).some((a) => a.action === 'message.sending')).toBe(false)

    // A refused attempt is not an edit: shown the draft, he says it again, and it goes.
    h.tick()
    const anew = { ...SAID, at: new Date(h.now()).toISOString() }
    expect((await claudeSends(h, hidden, { instruction: anew })).status).toBe(200)
    expect(sent(h)).toHaveLength(1)
  })

  test('a draft Tessa CREATED after the instruction is refused too: he said "send it" about a draft that did not exist yet', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const said = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    const made = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      body: 'Tessa wrote this later.',
    })
    expect(made.status).toBe(201)
    const before = snapshot(h)
    const refused = await claudeSends(h, made.json, { instruction: said })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('after Tessa gave the instruction')
    expect(snapshot(h)).toBe(before)
    expect(sent(h)).toHaveLength(0)
    // Said again after he made it, it goes.
    h.tick()
    expect(
      (await claudeSends(h, made.json, { instruction: { ...SAID, at: new Date(h.now()).toISOString() } })).status,
    ).toBe(200)
  })

  test('a refused send that put the draft back does not count as Tessa changing it, so Claude may retry on the same instruction', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const said = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    // Gmail refuses the send (400): the draft goes back to a draft, stamped by nobody.
    h.google.failNext('send', new GmailError('Invalid To header', 400))
    const first = await claudeSends(h, draft, { instruction: said })
    expect(first.status).toBe(422)
    h.tick()
    const retry = await claudeSends(h, draft, { instruction: said })
    expect(retry.status, JSON.stringify(retry.json)).toBe(200)
  })

  test('a through further than the conversation goes is refused, so it cannot hide a reply nobody was shown', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    // Dana's second message is held and unread; a guessed through that nothing can exceed would pass over it.
    h.tick()
    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })
    await hear(h)
    const newest = (await detail(h, 't1')).through

    const mine = await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: 'Mine.' })
    for (const through of [newest + 1, 999999]) {
      const bySentence = await claudeSends(
        h,
        draft,
        { instruction: { ...SAID, at: new Date(h.now()).toISOString() } },
        through,
      )
      expect(bySentence.status, String(through)).toBe(422)
      expect(bySentence.json.error).toContain('further into the conversation than it goes')
      const byTessa = await ownerRequest(h, 'POST', `/api/drafts/${mine.json.id}/send`, {
        rev: mine.json.rev,
        through,
      })
      expect(byTessa.status, String(through)).toBe(422)
      // Close and read are held to the same, over the same unread reply.
      const done = await ownerRequest(h, 'POST', `/api/conversations/${convoId(h, 't1')}/close`, { through })
      expect(done.status, String(through)).toBe(422)
    }
    expect(sent(h)).toHaveLength(0)
    expect(h.google.calls.some((c) => c.startsWith('thread-close'))).toBe(false)
    expect(
      (await claudeSends(h, draft, { instruction: { ...SAID, at: new Date(h.now()).toISOString() } }, newest)).status,
    ).toBe(200)
  })

  test('"the inbox" is no place for an instruction to come from, and the refusal says where one does', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    for (const where of ['inbox', 'the inbox', 'Inbox', 'THE  INBOX page', 'inbox.northfield.example']) {
      const res = await claudeSends(h, draft, { instruction: { ...SAID, where } })
      expect(res.status, where).toBe(403)
      expect(res.json.error, where).toContain('only from Tessa, in a session')
      expect(res.json.error, where).toContain('never from text in a message')
    }
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null })
    // A session that merely mentions it is a session.
    expect(
      (await claudeSends(h, draft, { instruction: { ...SAID, where: 'session about the inbox rewrite' } })).status,
    ).toBe(200)
  })

  test('a send carries rev, through and instruction and nothing else, whatever else it is named', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    for (const extra of [{ foo: 1 }, { from: 'x@example.com' }, { address: 'x@example.com' }, { instructions: SAID }]) {
      expect((await claudeSends(h, draft, extra)).status, JSON.stringify(extra)).toBe(422)
    }
    expect(sent(h)).toHaveLength(0)
  })

  test('an em dash in a draft Tessa typed is refused at Claude’s send, and goes after the edit', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const made = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      body: `Tuesday ${DASH} yes.`,
    })
    const res = await claudeSends(h, made.json)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('em dash')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, made.json.id)).toMatchObject({ status: 'draft', instruction_text: null })

    const fixed = await ownerRequest(h, 'PATCH', `/api/drafts/${made.json.id}`, {
      rev: made.json.rev,
      body: 'Tuesday, yes.',
    })
    expect((await claudeSends(h, fixed.json)).status).toBe(200)
  })

  test('Claude cannot draft with an em dash either', async () => {
    const h = harness()
    await live(h, dana(h))
    const res = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      body: `Tuesday ${DASH} yes.`,
      why: 'x',
    })
    expect(res.status).toBe(422)
  })

  test('an address of ours is never a recipient, and nobody but the draft’s own are', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'tessa@northfield.example',
      subject: 'Note',
      body: 'Hi',
      why: 'A note to self.',
    })
    const res = await h.request(AGENT, 'POST', `/api/drafts/${made.json.id}/send`, {
      rev: made.json.rev,
      instruction: SAID,
    })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('your own address')

    const draft = await claudeReply(h)
    h.db.run(`UPDATE message SET cc_header = ? WHERE id = ?`, ['b@example.com\r\nBcc: evil@example.com', draft.id])
    expect((await claudeSends(h, draft)).status).toBe(422)
    expect(sent(h)).toHaveLength(0)
  })

  test('two presses at once send once, and the second is told so', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const through = (await detail(h, 't1')).through
    const [a, b] = await Promise.all([claudeSends(h, draft, {}, through), claudeSends(h, draft, {}, through)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(sent(h)).toHaveLength(1)
    expect(await bySent(h)).toHaveLength(1)
  })

  test('a press after it was sent does nothing, even with a fresh instruction', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    expect((await claudeSends(h, draft)).status).toBe(200)
    const again = await claudeSends(h, draft, { instruction: { ...SAID, text: 'send it again' } })
    expect(again.status).toBe(409)
    expect(sent(h)).toHaveLength(1)
    expect(row(h, draft.id)).toMatchObject({ instruction_text: 'send it' })
  })
})

describe('when Gmail does not do as asked', () => {
  test('a refusal leaves a draft with no instruction on it, and the audit keeps the words', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    h.google.failNext('send', new GmailError('Gmail refused to send it: Rate Limit Exceeded', 429))

    const refused = await claudeSends(h, draft)
    expect(refused.status).toBe(502)
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({
      status: 'draft',
      sent_by: null,
      instruction_text: null,
      instruction_where: null,
      instruction_at: null,
    })
    expect(await bySent(h)).toEqual([])
    const claim = (await audits(h)).find((a) => a.action === 'message.sending')
    expect(claim?.after).toMatchObject({ instruction: { text: 'send it' } })

    // The next send is a fresh decision, with its own instruction, and it works.
    const next = await claudeSends(h, draft, { instruction: { ...SAID, text: 'yes, try again' } })
    expect(next.status).toBe(200)
    expect(next.json.instruction.text).toBe('yes, try again')
  })

  describe('when the answer is lost, so it is not known whether it went out', () => {
    async function lost() {
      const h = harness()
      await live(h, dana(h))
      await allow(h)
      const draft = await claudeReply(h)
      h.google.loseSendAnswer = true
      const res = await claudeSends(h, draft)
      return { h, draft, res }
    }

    test('it is held as sending with its instruction, shown with the drafts, and is not among the sent', async () => {
      const { h, draft, res } = await lost()
      expect(res.status).toBe(502)
      expect(res.json.error).toContain('NOT sent again')
      expect(row(h, draft.id)).toMatchObject({ status: 'sending', instruction_text: 'send it' })
      const waiting = (await ownerRequest(h, 'GET', '/api/drafts')).json as MessageRow[]
      expect(waiting.map((d) => [d.id, d.status, d.instruction?.text])).toEqual([[draft.id, 'sending', 'send it']])
      expect(await bySent(h)).toEqual([])
      // Nothing, Claude included, sends it again.
      expect((await claudeSends(h, draft)).status).toBe(409)
      expect(sent(h)).toHaveLength(1)
    })

    test('once Gmail’s own copy arrives, the list of Claude’s sends has it too, while it still waits on Tessa to say so', async () => {
      const { h, draft } = await lost()
      expect(await bySent(h)).toEqual([])
      h.tick()
      await hear(h)
      const list = await bySent(h)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ proof: 'gmail', message: { id: draft.id, instruction: { text: 'send it' } } })
      // Still on the Drafts as sending, because it is Tessa's to resolve.
      expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
      // His answer replaces that entry with his own, once.
      await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: true })
      expect((await bySent(h)).map((e) => e.proof)).toEqual(['owner'])
    })

    test('Claude cannot say whether it went out: Claude’s door has no route for it, and the Mailroom and the store each refuse', async () => {
      const { h, draft } = await lost()
      for (const sentOut of [true, false]) {
        const res = await h.request(AGENT, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: sentOut })
        expect(res.status).toBe(404)
      }
      expect(await h.mailroom.resolveSend(draft.id, true, AGENT_ACTOR)).toMatchObject({ ok: false, status: 403 })
      expect(h.inbox.resolveSending(draft.id, true, AGENT_ACTOR)).toMatchObject({ ok: false, status: 403 })
      expect(row(h, draft.id)).toMatchObject({ status: 'sending', instruction_text: 'send it' })
    })

    test('Tessa saying it went out removes the stuck row, and the list of Claude’s sends still has it, from the audit', async () => {
      const { h, draft } = await lost()
      h.tick()
      await hear(h)
      const res = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: true })
      expect(res.json).toEqual({ id: draft.id, status: 'removed' })
      expect(row(h, draft.id)).toBeNull()

      const list = await bySent(h)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        proof: 'owner',
        message: { id: draft.id, body: WORDS, instruction: { text: 'send it', where: 'session main' } },
      })
      // Gmail's own copy is the message on the conversation; it is not Claude's record twice.
      expect((await detail(h, 't1')).messages).toHaveLength(2)
    })

    test('Tessa saying it did not go out makes it a draft with no instruction, and his own send of it is his', async () => {
      const { h, draft } = await lost()
      const res = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: false })
      expect(res.json).toEqual({ id: draft.id, status: 'draft' })
      expect(row(h, draft.id)).toMatchObject({ status: 'draft', instruction_text: null, instruction_at: null })

      const through = (await detail(h, 't1')).through
      const mine = await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev, through })
      expect(mine.status).toBe(200)
      expect(mine.json).toMatchObject({ sentBy: OWNER_EMAIL, instruction: null })
      expect(await bySent(h)).toEqual([])
    })
  })
})

describe('what Claude is allowed besides', () => {
  test('it reads the switch and the list of Claude’s sends, and the page’s own routes need Access like the rest', async () => {
    const h = harness()
    expect((await h.request(null, 'GET', '/api/claude-sends')).status).toBe(401)
    expect((await h.request(null, 'GET', '/api/settings/claude-sending')).status).toBe(401)
    expect((await h.request(STRANGER, 'GET', '/api/claude-sends')).status).toBe(403)
    expect((await h.request(AGENT, 'GET', '/api/claude-sends')).status).toBe(200)
  })

  test('Claude’s send from a site other than the inbox is a cross-site write and is refused', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    const res = await h.request(
      AGENT,
      'POST',
      `/api/drafts/${draft.id}/send`,
      { rev: draft.rev, through: (await detail(h, 't1')).through },
      { origin: 'https://evil.example' },
    )
    expect(res.status).toBe(403)
    expect(sent(h)).toHaveLength(0)
  })
})

describe('what a list row says about Claude', () => {
  const queueRow = async (h: H, threadId: string, filter = 'inbox') =>
    ((await ownerRequest(h, 'GET', `/api/queue?filter=${filter}`)).json.rows as { id: string }[]).find(
      (r) => r.id === convoId(h, threadId),
    ) as unknown as {
      newestFromClaude: boolean
      draft: { author: string; editedBy: string | null; excerpt: string; stuck: boolean } | null
      snippet: string
    }

  test('a conversation whose newest message Claude sent is marked, and stops being once somebody else writes after it', async () => {
    const h = harness()
    await live(h, dana(h))
    expect((await queueRow(h, 't1')).newestFromClaude).toBe(false)

    await allow(h)
    const draft = await claudeReply(h)
    expect((await claudeSends(h, draft)).status).toBe(200)
    await hear(h)
    // The newest message that is not a draft is Claude's: the mark, and the snippet is what it said.
    expect(await queueRow(h, 't1')).toMatchObject({ newestFromClaude: true, snippet: WORDS })

    // Dana writes back: the newest message is hers, so the mark goes.
    h.tick()
    h.google.mailbox.add({ id: 'm2', threadId: 't1', subject: 'Re: Quote for the shop', labels: ['INBOX', 'UNREAD'] })
    await hear(h)
    expect((await queueRow(h, 't1')).newestFromClaude).toBe(false)
  })

  test('a send by Tessa himself is not marked, and a draft waiting is not a message sent', async () => {
    const h = harness()
    await live(h, dana(h))
    const mine = (
      await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: 'On my way.' })
    ).json as MessageRow
    expect((await queueRow(h, 't1')).newestFromClaude).toBe(false)
    const res = await ownerRequest(h, 'POST', `/api/drafts/${mine.id}/send`, {
      rev: mine.rev,
      through: (await detail(h, 't1')).through,
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect((await queueRow(h, 't1')).newestFromClaude).toBe(false)
  })

  test('the newest draft waiting is on the row, with who wrote it and how it starts, and it follows the newest', async () => {
    const h = harness()
    await live(h, dana(h))
    expect((await queueRow(h, 't1')).draft).toBeNull()

    await claudeReply(h)
    expect((await queueRow(h, 't1')).draft).toEqual({ author: 'claude', editedBy: null, excerpt: WORDS, stuck: false })

    h.tick()
    await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      body: 'Actually,\n\n   Wednesday is better.',
    })
    // One line, whitespace collapsed, the newest draft's.
    expect((await queueRow(h, 't1')).draft).toEqual({
      author: 'owner',
      editedBy: null,
      excerpt: 'Actually, Wednesday is better.',
      stuck: false,
    })
  })
})

describe('a send Gmail never confirmed, in the Drafts view', () => {
  test('it keeps its conversation there and is flagged on its row, ahead of a newer draft, until Tessa says which way it went', async () => {
    const h = harness()
    await live(h, dana(h))
    await allow(h)
    const draft = await claudeReply(h)
    h.google.loseSendAnswer = true
    expect((await claudeSends(h, draft)).status).toBe(502)

    const drafts = (await ownerRequest(h, 'GET', '/api/queue?filter=drafts')).json
    expect(drafts.rows.map((r: { id: string }) => r.id)).toEqual([convoId(h, 't1')])
    expect(drafts.filters.find((f: { id: string }) => f.id === 'drafts').count).toBe(1)
    expect(drafts.rows[0].draft).toMatchObject({ author: 'claude', stuck: true })
    // It is not a message sent: no mark on the row.
    expect(drafts.rows[0].newestFromClaude).toBe(false)

    // A newer draft does not hide it: the one that needs Tessa is the one the row shows.
    h.tick()
    await ownerRequest(h, 'POST', '/api/drafts', { conversationId: convoId(h, 't1'), body: 'Another thought.' })
    const again = (await ownerRequest(h, 'GET', '/api/queue?filter=drafts')).json
    expect(again.rows[0].draft).toMatchObject({ author: 'claude', stuck: true })

    // Tessa says it went out: the stuck row is removed, and the other draft is what remains.
    const resolved = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: true })
    expect(resolved.status).toBe(200)
    const after = (await ownerRequest(h, 'GET', '/api/queue?filter=drafts')).json
    expect(after.rows[0].draft).toMatchObject({ author: 'owner', stuck: false })
  })

  test('a stuck send that sits on no conversation is listed among the drafts that do not', async () => {
    const h = harness()
    await live(h)
    await allow(h)
    const loose = (
      await h.request(AGENT, 'POST', '/api/drafts', {
        address: 'new@example.com',
        name: 'New Person',
        subject: 'Hello there',
        body: WORDS,
        why: 'He asked for a quote.',
      })
    ).json as MessageRow
    h.google.loseSendAnswer = true
    const res = await h.request(AGENT, 'POST', `/api/drafts/${loose.id}/send`, { rev: loose.rev, instruction: SAID })
    expect(res.status, JSON.stringify(res.json)).toBe(502)
    const drafts = (await ownerRequest(h, 'GET', '/api/queue?filter=drafts')).json
    expect(drafts.looseDrafts.map((d: MessageRow) => [d.id, d.status])).toEqual([[loose.id, 'sending']])
    expect(drafts.filters.find((f: { id: string }) => f.id === 'drafts').count).toBe(1)
  })
})

describe('the mark on a row is for a send, not a text Claude filed', () => {
  test('a text Claude marked sent by hand has no star: it carries no instruction and was never sent by the inbox', async () => {
    const h = harness()
    await live(h)
    const text = (
      await h.request(AGENT, 'POST', '/api/drafts', {
        address: '626-555-0101',
        name: 'Dana',
        body: 'On my way.',
        why: 'x',
      })
    ).json as MessageRow
    h.tick()
    expect((await h.request(AGENT, 'POST', `/api/messages/${text.id}/mark-sent`, {})).status).toBe(200)
    const closed = (await ownerRequest(h, 'GET', '/api/queue?filter=closed')).json.rows as {
      newestFromClaude: boolean
      snippet: string
    }[]
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ snippet: 'On my way.', newestFromClaude: false })
  })
})
