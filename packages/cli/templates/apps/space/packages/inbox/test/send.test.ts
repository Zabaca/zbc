import { describe, expect, test } from 'bun:test'
import { GmailAuthError, GmailError, GmailSendUnknown } from '../src/gmail/google'
import { AGENT, AGENT_ID, asHttp, harness, OWNER } from '../test-support/harness'
import { as, ownerRequest } from '../test-support/owner-requests'

/**
 * Step 4: Tessa sending and replying as tessa@northfield.example, through the inbox's Worker
 * as a function with a Google that can fail (the highest seam these tests have).
 * A reply and a new email going out through Gmail with the right
 * recipients and threading; the sent message filed in its conversation; and, the point
 * of most of this file, every way a message could go out twice, go out changed, go to
 * somebody the draft did not name, or be believed sent when it was not.
 *
 * What this cannot show is Google. The fake reads the message the way the documented
 * API says it does, and was written by the same hand as the code under test. Whether
 * Gmail keeps our Message-ID, threads a reply on its thread id and how it answers a
 * send that is lost on the way back is the hand test, and the runbook lists it.
 * The em dash is written as an escape because this repo has none.
 */

type H = ReturnType<typeof harness>

const TESSA = 'tessa@northfield.example'
const DASH = '\u2014'

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

const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

const detail = async (h: H, threadId: string) =>
  (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h, threadId)}`)).json

const drafts = async (h: H) => (await ownerRequest(h, 'GET', '/api/drafts')).json as Draft[]

interface Draft {
  id: string
  rev: number
  status: string
  address: string
  cc: string
  subject: string
  body: string
  conversationId: string | null
}

const WORDS = 'Thanks Dana. Tuesday works for me.'

/** One message in from Dana on thread t1, the usual start. */
const dana =
  (h: H, over: Parameters<H['google']['mailbox']['add']>[0] = {}) =>
  () => {
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote for the shop', ...over })
  }

/** A reply draft on a thread, made as `who`. */
async function reply(
  h: H,
  threadId: string,
  extra: Record<string, unknown> = {},
  who: Record<string, unknown> = OWNER,
): Promise<Draft> {
  const res = await as(h, who, 'POST', '/api/drafts', {
    conversationId: convoId(h, threadId),
    body: WORDS,
    ...(who === AGENT ? { why: 'She asked for a time.' } : {}),
    ...extra,
  })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json
}

/** Press Send as a page would: with the revision it drew the draft from and how far into the thread it reached. */
async function press(
  h: H,
  threadId: string | null,
  draft: Draft,
  over: Record<string, unknown> = {},
  who: Record<string, unknown> = OWNER,
) {
  const through = threadId === null ? undefined : (await detail(h, threadId)).through
  return as(h, who, 'POST', `/api/drafts/${draft.id}/send`, {
    rev: draft.rev,
    ...(through === undefined ? {} : { through }),
    ...over,
  })
}

const sent = (h: H) => h.google.mailbox.sent
const sendCalls = (h: H) => h.google.calls.filter((c) => c.startsWith('send:'))
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const audits = async (h: H) => (await ownerRequest(h, 'GET', '/api/audit')).json as { action: string; actor: string }[]

describe('a reply from the inbox', () => {
  test('goes to the sender, in the same thread, from Tessa, with the threading headers, and nothing else', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    // The draft names its recipient and its subject on its face, before anything is sent.
    expect(draft).toMatchObject({ address: 'dana@example.com', subject: 'Re: Quote for the shop', cc: '', rev: 0 })

    const res = await press(h, 't1', draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)

    expect(sent(h)).toHaveLength(1)
    const out = sent(h)[0]
    expect(out?.threadId).toBe('t1')
    expect(out?.headers).toMatchObject({
      From: 'Tessa Marlow <tessa@northfield.example>',
      To: 'dana@example.com',
      Subject: 'Re: Quote for the shop',
      'In-Reply-To': '<m1@example.com>',
      References: '<m1@example.com>',
      'MIME-Version': '1.0',
    })
    expect(Object.keys(out?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('bcc')
    expect(Object.keys(out?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('cc')
    expect(out?.body).toBe(WORDS)
    expect(sendCalls(h)).toEqual(['send:t1'])
  })

  test('is filed as sent, by Tessa, on the conversation it answered, and Gmail’s echo of it changes nothing', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.tick()
    const res = await press(h, 't1', draft)

    expect(res.json).toMatchObject({
      id: draft.id,
      status: 'sent',
      direction: 'out',
      sentBy: TESSA,
      conversationId: convoId(h, 't1'),
      to: 'dana@example.com',
      from: `Tessa Marlow <${TESSA}>`,
      labels: ['SENT'],
    })
    expect(res.json.gmailId).toBe(sent(h)[0]?.id)

    const after = await detail(h, 't1')
    expect(after.drafts).toEqual([])
    expect(after.messages.map((m: { id: string }) => m.id)).toEqual([expect.any(String), draft.id])
    // Dana's message is still in Gmail's Inbox, so the conversation stays open, as Gmail has it.
    expect(after).toMatchObject({ open: true, unread: true })

    // The message Gmail made for the send arrives in the history; it is held already.
    const rows = () => h.db.query(`SELECT id, labels, read_by, closed_by FROM message ORDER BY rowid`).all()
    const before = JSON.stringify(rows())
    await hear(h)
    expect(JSON.stringify(rows())).toBe(before)
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE gmail_id = ?`).get(sent(h)[0]?.id ?? '')).toEqual({
      n: 1,
    })
    // Sent, so neither unread nor in the Inbox: stamped read and closed by the sender, not by Gmail.
    expect(row(h, draft.id)).toMatchObject({ read_by: TESSA, closed_by: TESSA })
    expect((await audits(h)).filter((a) => a.action.startsWith('message.send')).map((a) => a.action)).toEqual([
      'message.send',
      'message.sending',
    ])
  })

  test('goes to the Reply-To when the message has one, and never to an address of ours', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({
        id: 'm1',
        threadId: 't1',
        from: 'Forms <forms@example.com>',
        headers: { 'Reply-To': 'Pat Customer <pat@example.org>' },
        subject: 'New quote request',
      })
      // A note Tessa sent himself: the only address on it besides ours is none, so there is nobody to reply to.
      h.google.mailbox.add({
        id: 'm2',
        threadId: 't2',
        from: 'Dana <dana@example.com>',
        headers: { 'Reply-To': 'Tessa Marlow <tessa@northfield.example>' },
        subject: 'Odd one',
      })
    })
    const draft = await reply(h, 't1')
    expect(draft.address).toBe('pat@example.org')
    expect((await press(h, 't1', draft)).status).toBe(200)
    expect(sent(h)[0]?.headers.To).toBe('pat@example.org')
    // The form service that asked for replies to go to the customer is not somebody to copy.
    expect((await reply(h, 't1', { copyEveryone: true })).cc).toBe('')

    // A Reply-To that points at us is skipped; the From answers.
    expect((await reply(h, 't2')).address).toBe('dana@example.com')
  })

  test('copies nobody unless asked, and then everyone on the message it answers, less us and the recipient', async () => {
    const h = harness()
    await live(
      h,
      dana(h, {
        to: 'Tessa Marlow <tessa@northfield.example>, Mary Jo <maryjo@example.com>',
        cc: 'Bob <bob@example.com>, Tessa Marlow <tessa@northfield.example>',
      }),
    )
    const plain = await reply(h, 't1')
    expect(plain.cc).toBe('')
    expect((await press(h, 't1', plain)).status).toBe(200)
    expect(Object.keys(sent(h)[0]?.headers ?? {})).not.toContain('Cc')

    const all = await reply(h, 't1', { copyEveryone: true })
    expect(all.cc.split(', ').sort()).toEqual(['bob@example.com', 'maryjo@example.com'])
    expect((await press(h, 't1', all)).status).toBe(200)
    const cc = sent(h)[1]?.headers.Cc ?? ''
    expect(
      cc
        .split(',')
        .map((a) => a.trim())
        .sort(),
    ).toEqual(['bob@example.com', 'maryjo@example.com'])
    expect(sent(h)[1]?.headers.To).toBe('dana@example.com')
    // Everyone copied is now on the conversation, as a contact.
    expect((await detail(h, 't1')).addresses.map((a: { address: string }) => a.address)).toContain('bob@example.com')
  })

  test('the Cc can be switched on and off on the draft, and what is shown is what is sent', async () => {
    const h = harness()
    await live(h, dana(h, { cc: 'Bob <bob@example.com>' }))
    const draft = await reply(h, 't1')
    const on = (await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, copyEveryone: true })).json
    expect(on).toMatchObject({ cc: 'bob@example.com', rev: 1 })
    const off = (await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: on.rev, copyEveryone: false })).json
    expect(off).toMatchObject({ cc: '', rev: 2 })
    expect(
      (await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: off.rev, copyEveryone: true })).json.cc,
    ).toBe('bob@example.com')
    // Copying needs a thread to copy from.
    const lone = (await ownerRequest(h, 'POST', '/api/drafts', { address: 'x@example.com', body: 'Hi' })).json
    expect(
      (await ownerRequest(h, 'PATCH', `/api/drafts/${lone.id}`, { rev: lone.rev, copyEveryone: true })).status,
    ).toBe(422)
    expect(
      (await ownerRequest(h, 'POST', '/api/drafts', { address: 'x@example.com', body: 'Hi', copyEveryone: true }))
        .status,
    ).toBe(422)
  })

  test('keeps the thread’s subject with its Re:, and never doubles it', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote' })
      h.google.mailbox.add({ id: 'm2', threadId: 't2', subject: 'RE: Already a reply' })
    })
    expect((await reply(h, 't1')).subject).toBe('Re: Quote')
    expect((await reply(h, 't2')).subject).toBe('RE: Already a reply')
    expect((await reply(h, 't1', { subject: 'My own subject' })).subject).toBe('My own subject')
  })
})

describe('a new email from a contact', () => {
  test('starts a thread in Gmail, is filed on a conversation of its own, and carries no reply headers', async () => {
    const h = harness()
    await live(h)
    const created = await ownerRequest(h, 'POST', '/api/drafts', {
      address: 'new@example.com',
      name: 'New Person',
      subject: 'Hello',
      body: 'Hi there.',
    })
    const draft = created.json as Draft
    expect(draft.conversationId).toBeNull()

    h.tick()
    const res = await press(h, null, draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(sent(h)[0]?.threadId).toBeNull()
    expect(Object.keys(sent(h)[0]?.headers ?? {})).not.toContain('In-Reply-To')
    expect(Object.keys(sent(h)[0]?.headers ?? {})).not.toContain('References')

    const thread = h.google.mailbox.messages.get(sent(h)[0]?.id ?? '')?.threadId ?? ''
    const conversation = await detail(h, thread)
    expect(conversation.messages).toHaveLength(1)
    expect(conversation.contacts).toEqual([{ id: expect.any(String), name: 'New Person', clientId: null }])
    // Sent-only: out of Gmail's Inbox, so closed, as Gmail has it.
    expect(conversation).toMatchObject({ open: false, unread: false })

    const before = JSON.stringify(h.db.query(`SELECT id, labels FROM message ORDER BY rowid`).all())
    await hear(h)
    expect(JSON.stringify(h.db.query(`SELECT id, labels FROM message ORDER BY rowid`).all())).toBe(before)
  })
})

describe('a second press, a retry and a lost answer never send twice', () => {
  test('two presses at once send once, and the second is told so', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const through = (await detail(h, 't1')).through
    const body = { rev: draft.rev, through }
    const [a, b] = await Promise.all([
      ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, body),
      ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, body),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(sent(h)).toHaveLength(1)
    expect([a, b].find((r) => r.status === 409)?.json.error).toContain('already sent')
  })

  test('a press after it was sent does nothing: nothing more goes out and nothing changes', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    expect((await press(h, 't1', draft)).status).toBe(200)
    const before = JSON.stringify(h.db.query(`SELECT * FROM message ORDER BY rowid`).all())
    const again = await press(h, 't1', draft)
    expect(again.status).toBe(409)
    expect(sent(h)).toHaveLength(1)
    expect(JSON.stringify(h.db.query(`SELECT * FROM message ORDER BY rowid`).all())).toBe(before)
  })

  test('a send Gmail refused leaves a draft, with the reason, and pressing again sends it once', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.google.failNext('send', new GmailError('Gmail refused to send it: Rate Limit Exceeded', 429))
    const refused = await press(h, 't1', draft)
    expect(refused.status).toBe(502)
    expect(refused.json.error).toContain('Rate Limit Exceeded')
    expect(refused.json.error).toContain('still a draft')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', gmail_id: null, sent_by: null })
    expect((await drafts(h)).map((d) => d.status)).toEqual(['draft'])
    expect((await audits(h)).some((a) => a.action === 'message.send-refused')).toBe(true)

    expect((await press(h, 't1', draft)).status).toBe(200)
    expect(sent(h)).toHaveLength(1)
    expect(h.google.count('send')).toBe(2)
  })

  test('Gmail saying the input is bad is a 422 (fix what was typed), the sign-in lapsing a 502, and both leave a draft', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.google.failNext('send', new GmailError('Gmail refused to send it: Invalid To header', 400))
    const bad = await press(h, 't1', draft)
    expect(bad.status).toBe(422)
    expect(bad.json.error).toContain('Invalid To header')
    h.google.failNext('send', new GmailAuthError('invalid_grant'))
    const lapsed = await press(h, 't1', draft)
    expect(lapsed.status).toBe(502)
    expect(lapsed.json.error).toContain('Connect Gmail again')
    expect(row(h, draft.id)?.status).toBe('draft')
    expect(sent(h)).toHaveLength(0)
  })

  describe('when the answer is lost, so it is not known whether it went out', () => {
    async function lost() {
      const h = harness()
      await live(h, dana(h))
      const draft = await reply(h, 't1')
      h.google.loseSendAnswer = true
      const res = await press(h, 't1', draft)
      return { h, draft, res }
    }

    test('it is held as sending, not put back, and the answer says so', async () => {
      const { h, draft, res } = await lost()
      expect(res.status).toBe(502)
      expect(res.json.error).toContain('NOT sent again')
      expect(res.json.error).toContain('check Gmail Sent')
      expect(sent(h)).toHaveLength(1)
      expect(row(h, draft.id)).toMatchObject({ status: 'sending', gmail_id: null })
      // It stays in front of Tessa: in Drafts, and on its conversation, never among the sent.
      expect((await drafts(h)).map((d) => [d.id, d.status])).toEqual([[draft.id, 'sending']])
      const shown = await detail(h, 't1')
      expect(shown.drafts.map((d: Draft) => d.status)).toEqual(['sending'])
      expect(shown.messages.map((m: { id: string }) => m.id)).not.toContain(draft.id)
    })

    test('pressing Send again does not send it again, and nothing else can touch it', async () => {
      const { h, draft } = await lost()
      const again = await press(h, 't1', draft)
      expect(again.status).toBe(409)
      expect(again.json.error).toContain('already being sent')
      expect(sent(h)).toHaveLength(1)
      expect(
        (await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, body: 'Changed' })).status,
      ).toBe(409)
      expect((await ownerRequest(h, 'DELETE', `/api/drafts/${draft.id}?rev=${draft.rev}`)).status).toBe(409)
      expect((await ownerRequest(h, 'POST', `/api/messages/${draft.id}/mark-sent`, {})).status).toBe(409)
      expect(row(h, draft.id)?.status).toBe('sending')
      expect(sent(h)).toHaveLength(1)
    })

    test('Gmail’s own copy arrives by sync, and Tessa saying it went out removes the stuck draft', async () => {
      const { h, draft } = await lost()
      await hear(h)
      const stored = await detail(h, 't1')
      expect(stored.messages).toHaveLength(2)
      expect(stored.messages[1]).toMatchObject({ direction: 'out', gmailId: sent(h)[0]?.id, body: WORDS })

      const resolved = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: true })
      expect(resolved.json).toEqual({ id: draft.id, status: 'removed' })
      expect(await drafts(h)).toEqual([])
      expect(row(h, draft.id)).toBeNull()
      expect((await detail(h, 't1')).messages).toHaveLength(2)
      expect(sent(h)).toHaveLength(1)
    })

    test('Tessa saying it did not go out makes it a draft again, and sending it then is his decision', async () => {
      const { h, draft } = await lost()
      const resolved = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: false })
      expect(resolved.json).toEqual({ id: draft.id, status: 'draft' })
      expect(row(h, draft.id)?.status).toBe('draft')
      expect(sent(h)).toHaveLength(1)
      expect((await press(h, 't1', draft)).status).toBe(200)
      expect(sent(h)).toHaveLength(2)
    })

    // The yes-or-no check was the deleted route's; the space's method has it (test/space-last-five.test.ts, `sent: 'yes'` is bad-request).
    test('only the owner can say, and only about a message in that state', async () => {
      const { h, draft } = await lost()
      // Claude's door has no route for it, and the Mailroom refuses the agent as an actor besides.
      expect((await h.request(AGENT, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: false })).status).toBe(
        404,
      )
      expect(asHttp(await h.store.call('resolveSend', draft.id, false, `agent:${AGENT_ID}`)).status).toBe(403)
      expect(row(h, draft.id)?.status).toBe('sending')
      const plain = await reply(h, 't1')
      expect((await ownerRequest(h, 'POST', `/api/messages/${plain.id}/resolve-send`, { sent: true })).status).toBe(409)
      expect(row(h, plain.id)?.status).toBe('draft')
    })
  })

  test('an answer that cannot be told from a refusal (the module’s unknown) is held, whatever the cause', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.google.failNext('send', new GmailSendUnknown('Gmail answered the send with 503: Backend Error'))
    const res = await press(h, 't1', draft)
    expect(res.status).toBe(502)
    expect(row(h, draft.id)?.status).toBe('sending')
    expect((await press(h, 't1', draft)).status).toBe(409)
    expect(h.google.count('send')).toBe(1)
  })

  test('an error nobody expected is treated as not known, never as a refusal', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.google.failNext('send', new TypeError('something broke inside'))
    const res = await press(h, 't1', draft)
    expect(res.status).toBe(502)
    expect(row(h, draft.id)?.status).toBe('sending')
  })

  test('no sync can store Gmail’s copy between Gmail making it and the inbox filing it', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    let queued: Promise<void> | null = null
    // The moment the send reaches Gmail, a push arrives and its sync is asked for.
    h.google.onCall = (call) => {
      if (call.startsWith('send:') && queued === null) {
        h.inbox.markSyncOwed()
        queued = h.mailroom.runAlarm()
      }
    }
    const res = await press(h, 't1', draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    await queued
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE gmail_id = ?`).get(sent(h)[0]?.id ?? '')).toEqual({
      n: 1,
    })
    expect(row(h, draft.id)).toMatchObject({ status: 'sent' })
  })
})

describe('only what was shown is sent', () => {
  test('a draft edited after it was shown is refused with the new text, and sent only at the revision shown', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1', {}, AGENT)
    // The page drew revision 0; Claude then rewrites it.
    const edited = await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, {
      rev: draft.rev,
      body: 'Actually, Wednesday.',
    })
    expect(edited.json.rev).toBe(1)

    const stale = await press(h, 't1', draft)
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('changed after you last saw it')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)?.status).toBe('draft')

    const fresh = (await drafts(h))[0] as Draft
    expect(fresh).toMatchObject({ rev: 1, body: 'Actually, Wednesday.' })
    expect((await press(h, 't1', fresh)).status).toBe(200)
    expect(sent(h)[0]?.body).toBe('Actually, Wednesday.')
  })

  test('a send names the revision, so one that does not is refused', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const through = (await detail(h, 't1')).through
    for (const body of [{ through }, { through, rev: null }, { through, rev: '0' }, { through, rev: 0.5 }]) {
      const res = await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
    }
    expect((await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, { through, rev: 99 })).status).toBe(409)
    expect(sent(h)).toHaveLength(0)
  })

  test('a reply is refused when something arrived after the page was shown, and the message is shown now', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const shown = (await detail(h, 't1')).through

    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })
    await hear(h)
    const res = await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev, through: shown })
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('new message arrived')
    expect(sent(h)).toHaveLength(0)
    expect((await press(h, 't1', draft)).status).toBe(200)
  })

  test('so is one over a message Gmail has but the inbox has not heard of yet, and that message is stored', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const shown = (await detail(h, 't1')).through
    h.google.mailbox.add({ id: 'm2', threadId: 't1', labels: ['INBOX', 'UNREAD'], subject: 'Re: Quote for the shop' })

    const res = await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev, through: shown })
    expect(res.status).toBe(409)
    expect(sent(h)).toHaveLength(0)
    expect((await detail(h, 't1')).messages).toHaveLength(2)
    expect((await press(h, 't1', draft)).status).toBe(200)
  })

  test('a reply says how far it was shown, and a new email needs no such thing', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const res = await ownerRequest(h, 'POST', `/api/drafts/${draft.id}/send`, { rev: draft.rev })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('through')
    expect(sent(h)).toHaveLength(0)
  })

  test('if Gmail will not say what is in the thread, nothing is sent and the draft is untouched', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.google.failNext('getThreadLabels', new GmailError('Backend Error', 500))
    const res = await press(h, 't1', draft)
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('nothing was sent')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)?.status).toBe('draft')
  })
})

describe('only Tessa, and Claude on his word, send, and only to who the draft names', () => {
  test('Claude can draft, and its send is refused while the switch is off, which is how it starts', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1', {}, AGENT)
    expect(draft).toMatchObject({ status: 'draft' })
    const before = JSON.stringify(h.db.query(`SELECT * FROM message ORDER BY rowid`).all())
    const calls = h.google.calls.length

    const instruction = { text: 'send it', where: 'session 1', at: '2026-10-20T11:59:00Z' }
    const refused = await press(h, 't1', draft, { instruction }, AGENT)
    expect(refused.status).toBe(403)
    expect(refused.json.error).toContain('switched off')
    expect(h.google.calls).toHaveLength(calls)
    expect(JSON.stringify(h.db.query(`SELECT * FROM message ORDER BY rowid`).all())).toBe(before)
    expect(sent(h)).toHaveLength(0)
  })

  test('the store refuses a send by anyone who is neither Tessa nor the agent', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const other = 'teammate@example.com'
    expect(h.inbox.planSend(draft.id, { rev: 0, through: 0 }, other)).toMatchObject({ ok: false, status: 403 })
    expect(await h.mailroom.sendDraft(draft.id, { rev: 0, through: 0 }, other)).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(sent(h)).toHaveLength(0)
  })

  test('mail that came in is not a draft: status sent with direction in is never sent', async () => {
    const h = harness()
    await live(h, dana(h))
    const received = h.db.query(`SELECT id, status, direction FROM message WHERE gmail_id = 'm1'`).get() as {
      id: string
      status: string
      direction: string
    }
    expect(received).toMatchObject({ status: 'sent', direction: 'in' })
    const res = await ownerRequest(h, 'POST', `/api/drafts/${received.id}/send`, { rev: 0, through: 0 })
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('came in')
    expect(sent(h)).toHaveLength(0)
    expect(h.google.count('send')).toBe(0)
  })

  test('a draft with an em dash is refused at the send, even one Tessa wrote or one carried in, and goes after the edit', async () => {
    const h = harness()
    await live(h, dana(h))
    // Tessa is not policed when he writes a draft; what is SENT is.
    const draft = await reply(h, 't1', { body: `Thanks ${DASH} Tuesday works.` })
    const res = await press(h, 't1', draft)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('em dash')
    expect(sent(h)).toHaveLength(0)
    expect(row(h, draft.id)?.status).toBe('draft')

    // The subject counts as much as the body.
    const edited = (
      await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, {
        rev: draft.rev,
        body: WORDS,
        subject: `Quote ${DASH} yes`,
      })
    ).json as Draft
    expect((await press(h, 't1', edited)).status).toBe(422)
    const fixed = (
      await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: edited.rev, subject: 'Quote: yes' })
    ).json as Draft
    expect((await press(h, 't1', fixed)).status).toBe(200)
    expect(sent(h)[0]?.headers.Subject).toBe('Quote: yes')

    // Claude's drafts are refused earlier, as ever.
    const agent = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      body: `Hi ${DASH} there`,
      why: 'x',
    })
    expect(agent.status).toBe(422)
  })

  test('a message with no subject, no body, or one the inbox cannot send on is refused', async () => {
    const h = harness()
    await live(h)
    const blankSubject = (await ownerRequest(h, 'POST', '/api/drafts', { address: 'a@example.com', body: 'Hi' }))
      .json as Draft
    const none = await press(h, null, blankSubject)
    expect(none.status).toBe(422)
    expect(none.json.error).toContain('subject')

    const text = (await ownerRequest(h, 'POST', '/api/drafts', { address: '+1 555 010 0000', body: 'Hi' }))
      .json as Draft
    const sms = await press(h, null, text)
    expect(sms.status).toBe(422)
    expect(sms.json.error).toContain('email only')
    expect(sent(h)).toHaveLength(0)
  })

  test('an address of ours is never a recipient, on the To or the Cc', async () => {
    const h = harness()
    await live(h)
    const toUs = (
      await ownerRequest(h, 'POST', '/api/drafts', { address: 'Tessa@Northfield.example', subject: 'Note', body: 'Hi' })
    ).json as Draft
    const a = await press(h, null, toUs)
    expect(a.status).toBe(422)
    expect(a.json.error).toContain('your own address')

    const ok = (await ownerRequest(h, 'POST', '/api/drafts', { address: 'a@example.com', subject: 'Hi', body: 'Hi' }))
      .json as Draft
    h.db.run(`UPDATE message SET cc_header = 'b@example.com, tessa@northfield.example' WHERE id = ?`, [ok.id])
    expect((await press(h, null, ok)).status).toBe(422)
    expect(sent(h)).toHaveLength(0)
  })

  test('nothing but the draft’s own address and Cc can become a recipient: a header injected into the store is refused', async () => {
    const h = harness()
    await live(h)
    const draft = (
      await ownerRequest(h, 'POST', '/api/drafts', { address: 'a@example.com', subject: 'Hi', body: 'Hi' })
    ).json as Draft
    for (const cc of [
      'b@example.com\r\nBcc: evil@example.com',
      'b@example.com\nBcc: evil@example.com',
      'Evil <evil@example.com>',
      'b@example.com;c@example.com',
      '"b@example.com"',
      'b@exämple.test',
      'b@example.com, b@example.com',
      'a@example.com',
    ]) {
      h.db.run(`UPDATE message SET cc_header = ? WHERE id = ?`, [cc, draft.id])
      expect((await press(h, null, draft)).status, cc).toBe(422)
    }
    // A subject carrying a line break cannot add a header either.
    h.db.run(`UPDATE message SET cc_header = '', subject = ? WHERE id = ?`, ['Hi\r\nBcc: evil@example.com', draft.id])
    expect((await press(h, null, draft)).status).toBe(422)
    expect(sent(h)).toHaveLength(0)
    expect(h.google.count('send')).toBe(0)

    // The Bcc is not a thing a draft or a request can carry: a press that brings recipients
    // (or any text) is refused outright, and the draft's own go when it is pressed plainly.
    h.db.run(`UPDATE message SET subject = 'Hi' WHERE id = ?`, [draft.id])
    for (const extra of [{ bcc: 'evil@example.com' }, { to: 'evil@example.com' }, { cc: 'evil@example.com' }]) {
      expect((await press(h, null, draft, extra)).status).toBe(422)
    }
    expect(sent(h)).toHaveLength(0)
    expect((await press(h, null, draft)).status).toBe(200)
    expect(sent(h)[0]?.headers.To).toBe('a@example.com')
    expect(Object.keys(sent(h)[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('bcc')
    expect(sent(h)[0]?.raw).not.toContain('evil@example.com')
  })

  test('a reply can only be addressed to somebody on the thread or on the message it answers', async () => {
    const h = harness()
    await live(h, dana(h, { cc: 'Bob <bob@example.com>' }))
    const bad = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      address: 'stranger@example.net',
      body: 'Hi',
    })
    expect(bad.status).toBe(422)
    const bob = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      address: 'bob@example.com',
      body: 'Hi',
    })
    expect(bob.status).toBe(201)
    expect(bob.json.address).toBe('bob@example.com')
  })

  test('with Gmail not connected, or no Google on the Worker, nothing is sent and the draft is untouched', async () => {
    const h = harness()
    const draft = (
      await ownerRequest(h, 'POST', '/api/drafts', { address: 'a@example.com', subject: 'Hi', body: 'Hi' })
    ).json as Draft
    const none = await press(h, null, draft)
    expect(none.status).toBe(503)
    expect(none.json.error).toContain('not connected')
    expect(row(h, draft.id)?.status).toBe('draft')

    const bare = harness({}, { googleConfigured: false })
    const d2 = (
      await ownerRequest(bare, 'POST', '/api/drafts', { address: 'a@example.com', subject: 'Hi', body: 'Hi' })
    ).json as Draft
    expect((await press(bare, null, d2)).status).toBe(503)
    expect(row(bare, d2.id)?.status).toBe('draft')
  })

  test('a Send that Access did not let in is not a send', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    const res = await h.request(null, 'POST', `/api/drafts/${draft.id}/send`, { rev: 0, through: 0 })
    expect(res.status).toBe(401)
    const cross = await h.request(
      AGENT,
      'POST',
      `/api/drafts/${draft.id}/send`,
      { rev: 0, through: 0 },
      { origin: 'https://evil.example' },
    )
    expect(cross.status).toBe(403)
    expect(sent(h)).toHaveLength(0)
  })
})

describe('where a reply goes for a message stored before Reply-To was recorded', () => {
  const legacy = (h: H) => h.db.run(`UPDATE message SET reply_to_header = NULL`)

  test('the first reply drafted reads that one message back from Gmail, and the draft goes to its Reply-To', async () => {
    const h = harness()
    await live(h, dana(h, { from: 'Forms <forms@example.com>', headers: { 'Reply-To': 'Pat <pat@example.org>' } }))
    legacy(h)
    const draft = await reply(h, 't1')
    expect(draft.address).toBe('pat@example.org')
    expect(h.google.calls.filter((c) => c === 'getMessage:m1')).toHaveLength(2)
    // Recorded, so the next one needs no read.
    expect(h.db.query(`SELECT reply_to_header FROM message WHERE gmail_id = 'm1'`).get()).toEqual({
      reply_to_header: 'Pat <pat@example.org>',
    })
    const calls = h.google.calls.length
    await reply(h, 't1')
    expect(h.google.calls).toHaveLength(calls)
  })

  test('if Gmail will not say, the draft is to the sender, and shows it', async () => {
    const h = harness()
    await live(h, dana(h, { from: 'Forms <forms@example.com>', headers: { 'Reply-To': 'Pat <pat@example.org>' } }))
    legacy(h)
    h.google.failNext('getMessage', new GmailError('Backend Error', 500))
    const draft = await reply(h, 't1')
    expect(draft.address).toBe('forms@example.com')
  })

  test('a draft whose address is named needs no read', async () => {
    const h = harness()
    await live(h, dana(h))
    legacy(h)
    const calls = h.google.calls.length
    const res = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: convoId(h, 't1'),
      address: 'dana@example.com',
      body: 'Hi',
    })
    expect(res.status).toBe(201)
    expect(h.google.calls).toHaveLength(calls)
  })
})

describe('what Tessa says about a send that was never answered', () => {
  const resolve = (h: H, id: string, sent: boolean) =>
    ownerRequest(h, 'POST', `/api/messages/${id}/resolve-send`, { sent })

  async function lost(rewrite = false) {
    const h = harness()
    await live(h, dana(h))
    h.google.mailbox.rewriteMessageId = rewrite
    const draft = await reply(h, 't1')
    h.google.loseSendAnswer = true
    expect((await press(h, 't1', draft)).status).toBe(502)
    return { h, draft }
  }

  test('"it did not go out" is refused once Gmail’s own copy, with the same Message-ID, is in the inbox', async () => {
    const { h, draft } = await lost()
    // Before Gmail's copy has arrived there is nothing to say it did go out.
    await hear(h)
    const no = await resolve(h, draft.id, false)
    expect(no.status).toBe(409)
    expect(no.json.error).toContain('did go out')
    expect(row(h, draft.id)?.status).toBe('sending')
    expect(sent(h)).toHaveLength(1)
    expect((await resolve(h, draft.id, true)).json).toEqual({ id: draft.id, status: 'removed' })
  })

  test('with no copy to match, Tessa’s word stands, and so does a Message-ID Gmail rewrote', async () => {
    const early = await lost()
    expect((await resolve(early.h, early.draft.id, false)).status).toBe(200)

    // Gmail kept its own Message-ID instead of ours: nothing can be matched, so it is Tessa's call.
    const rewritten = await lost(true)
    await hear(rewritten.h)
    expect((await resolve(rewritten.h, rewritten.draft.id, false)).status).toBe(200)
  })
})

describe('a carried draft that went out is not carried back as a draft', () => {
  const entries = [
    {
      id: 'o-1',
      to: 'Dana',
      address: 'dana@example.com',
      subject: 'Hello',
      body: 'Carried words',
      created: '2026-10-19T10:00:00Z',
      sentAt: null,
    },
  ]

  async function carriedAndLost() {
    const h = harness()
    await live(h)
    expect(h.inbox.importOutbox(entries, 'carry').created.drafts).toBe(1)
    const draft = (await drafts(h))[0] as Draft
    h.google.loseSendAnswer = true
    expect((await press(h, null, draft)).status).toBe(502)
    return { h, draft }
  }

  test('saying it went out leaves the tombstone a deleted draft leaves, so a re-run cannot bring it back to be sent twice', async () => {
    const { h, draft } = await carriedAndLost()
    expect(sent(h)).toHaveLength(1)
    const resolved = await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: true })
    expect(resolved.json.status).toBe('removed')
    expect(h.db.query(`SELECT source_ref FROM outbox_tombstone`).all()).toEqual([{ source_ref: 'outbox:o-1' }])

    const again = h.inbox.importOutbox(entries, 'carry')
    expect(again).toMatchObject({ skipped: 1, created: { drafts: 0, manualSent: 0 } })
    expect(await drafts(h)).toEqual([])
    expect(sent(h)).toHaveLength(1)
  })

  test('saying it did not go out keeps the row, so a re-run finds it and leaves it', async () => {
    const { h, draft } = await carriedAndLost()
    await ownerRequest(h, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent: false })
    expect(h.db.query(`SELECT count(*) AS n FROM outbox_tombstone`).get()).toEqual({ n: 0 })
    expect(h.inbox.importOutbox(entries, 'carry')).toMatchObject({ skipped: 1, created: { drafts: 0 } })
    expect((await drafts(h)).map((d) => d.id)).toEqual([draft.id])
  })

  test('a carried draft that was sent normally stays as the sent message, which a re-run leaves alone', async () => {
    const h = harness()
    await live(h)
    h.inbox.importOutbox(entries, 'carry')
    const draft = (await drafts(h))[0] as Draft
    expect((await press(h, null, draft)).status).toBe(200)
    expect(h.inbox.importOutbox(entries, 'carry')).toMatchObject({ skipped: 1, created: { drafts: 0 } })
    expect(await drafts(h)).toEqual([])
    expect(sent(h)).toHaveLength(1)
  })
})

describe('the message as it is sent', () => {
  test('carries a Date header that is the moment it was filed under', async () => {
    const h = harness()
    await live(h, dana(h))
    const draft = await reply(h, 't1')
    h.tick(90_000)
    const res = await press(h, 't1', draft)
    expect(res.json.sentAt).toBe('2026-10-20T12:01:30.000Z')
    expect(sent(h)[0]?.headers.Date).toBe('Tue, 20 Oct 2026 12:01:30 +0000')
    expect(row(h, draft.id)?.sender_date).toBe(res.json.sentAt)
  })

  test('a reply’s default subject is the conversation’s as one plain line, with its Re:', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: '  Quote\tfor \u0001the   shop \u007f ' })
    })
    expect((await reply(h, 't1')).subject).toBe('Re: Quote for the shop')
  })

  test('an email is not marked sent by hand: Send, or Gmail, is how it is sent; a text still is', async () => {
    const h = harness()
    await live(h)
    const email = (await ownerRequest(h, 'POST', '/api/drafts', { address: 'a@example.com', subject: 's', body: 'b' }))
      .json as Draft
    const refused = await ownerRequest(h, 'POST', `/api/messages/${email.id}/mark-sent`, {})
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('Send')
    expect(row(h, email.id)?.status).toBe('draft')

    const text = (await ownerRequest(h, 'POST', '/api/drafts', { address: '626-555-0100', body: 'b' })).json as Draft
    expect((await ownerRequest(h, 'POST', `/api/messages/${text.id}/mark-sent`, {})).status).toBe(200)
  })
})
