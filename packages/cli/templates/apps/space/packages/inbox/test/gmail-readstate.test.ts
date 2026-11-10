import { describe, expect, test } from 'bun:test'
import { GmailAuthError, GmailError } from '../src/gmail/google'
import { AGENT, AGENT_ID, asHttp, firstGmail, harness, ownerDraft } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * Step 3: read and closed kept in step with Gmail, through the inbox's Worker as a
 * function, with a Google that can fail (the highest seam these tests have).
 * Opening a conversation, Close and Reopen from the inbox; a read, an
 * archive, a Mark unread and a reply made in Gmail; the echo of the inbox's own
 * change; Claude's reads; what Bulk and the header counts say.
 *
 * What this cannot show is Google. The fake applies a thread change to every
 * message in it and records history for the ones that changed, as the documented
 * API says, and was written by the same hand as the code under test. Whether
 * Gmail does exactly that (and how fast the echo comes) is the hand test.
 */

type H = ReturnType<typeof harness>

const TESSA = 'tessa@northfield.example'
const CLAUDE = `agent:${AGENT_ID}`

async function live(h: H, setup?: () => void) {
  setup?.()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

/** The inbox's id for a Gmail thread. */
const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

const detail = async (h: H, threadId: string, who = AGENT) =>
  (await h.request(who, 'GET', `/api/conversations/${convoId(h, threadId)}`)).json

const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const ids = (q: { rows: { id: string }[] }) => q.rows.map((r) => r.id)

/**
 * Press read, Close or Reopen as a page would: it sends how far into the
 * conversation it was shown, which is what a fresh GET of it says. A test that
 * wants a page that is out of date passes `through` itself (null for none).
 */
const post = async (
  h: H,
  threadId: string,
  what: 'read' | 'close' | 'reopen',
  who: Record<string, unknown> | typeof OWNER_EMAIL = OWNER_EMAIL,
  through?: number | null,
) => {
  const shown = through === undefined ? (await detail(h, threadId)).through : through
  // The owner (Tessa) works through the space, which calls the Mailroom as him (the inbox has no router for a person): the same call, with his address as the actor.
  if (who === OWNER_EMAIL)
    return asHttp(await h.store.call('changeConversation', convoId(h, threadId), what, OWNER_EMAIL, shown))
  return h.request(
    who as Record<string, unknown>,
    'POST',
    `/api/conversations/${convoId(h, threadId)}/${what}`,
    shown === null ? {} : { through: shown },
  )
}

/** What the store holds: Gmail id, labels and the stamps, in storage order. */
const rows = (h: H) =>
  h.db
    .query(`SELECT gmail_id, labels, read_at, read_by, closed_at, closed_by, updated_at FROM message ORDER BY rowid`)
    .all() as {
    gmail_id: string
    labels: string
    read_at: string | null
    read_by: string | null
    closed_at: string | null
    closed_by: string | null
    updated_at: string
  }[]

/** The invariant of the whole step: what the store holds is what Gmail holds. */
function expectInStepWithGmail(h: H) {
  for (const r of rows(h)) {
    const theirs = [...(h.google.mailbox.messages.get(r.gmail_id)?.labelIds ?? [])].sort()
    expect(JSON.parse(r.labels), `labels of ${r.gmail_id}`).toEqual(theirs)
  }
}

/** A push as Google delivers it, then the alarm it sets: the echo of whatever just happened in Gmail. */
async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
}

/** Two conversations, one thread with two messages (one unread), and a sent-only one. */
const mailbox = (h: H) => () => {
  h.google.mailbox.add({ id: 'a1', threadId: 'ta', from: 'Ann <ann@example.com>', subject: 'First' })
  h.google.mailbox.add({
    id: 'a2',
    threadId: 'ta',
    labels: ['INBOX'],
    from: 'Ann <ann@example.com>',
    subject: 'Re: First',
  })
  h.google.mailbox.add({
    id: 'b1',
    threadId: 'tb',
    labels: ['INBOX'],
    from: 'Bob <bob@example.com>',
    subject: 'Second',
  })
}

describe('opening a conversation marks it read, in Gmail first', () => {
  test('Gmail is asked to take UNREAD off the thread, then the inbox does and stamps who', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect((await detail(h, 'ta')).unread).toBe(true)
    expect((await queue(h)).filters[0]).toMatchObject({ id: 'inbox', count: 2, unread: 1 })

    h.tick()
    const res = await post(h, 'ta', 'read')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ unread: false, open: true, readBy: TESSA, readAt: '2026-10-20T12:01:00.000Z' })
    expect(h.google.calls.filter((c) => c.startsWith('thread-read'))).toEqual(['thread-read:ta'])

    expect((await detail(h, 'ta')).unread).toBe(false)
    expect((await queue(h)).filters[0]).toMatchObject({ count: 2, unread: 0 })
    expectInStepWithGmail(h)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json.find(
      (e: { action: string }) => e.action === 'conversation.read',
    )
    expect(audit).toMatchObject({ actor: TESSA, before: { unread: true }, after: { unread: false, readBy: TESSA } })
  })

  test('the history event that echoes the change finds it already made and changes nothing, the stamp included', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    await post(h, 'ta', 'read')
    const before = JSON.stringify(rows(h))
    await hear(h)
    expect(JSON.stringify(rows(h))).toBe(before)
    expect(rows(h).find((r) => r.gmail_id === 'a1')?.read_by).toBe(TESSA)
    expect(h.google.count('thread-read')).toBe(1)
  })

  test('a conversation that is already read costs no Gmail call, and a second press sends nothing', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await post(h, 'tb', 'read')
    expect(h.google.count('thread-read')).toBe(0)
    await post(h, 'ta', 'read')
    await post(h, 'ta', 'read')
    expect(h.google.count('thread-read')).toBe(1)
    const audits = (await h.request(AGENT, 'GET', '/api/audit')).json.filter(
      (e: { action: string }) => e.action === 'conversation.read',
    )
    expect(audits).toHaveLength(1)
  })

  test('when Gmail refuses, nothing changes here, the person is told why, and a retry works', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const before = JSON.stringify(rows(h))
    h.google.failNext('thread-read', new GmailError('Backend Error', 500))
    const res = await post(h, 'ta', 'read')
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('Nothing was changed here')
    expect(res.json.error).toContain('Backend Error')
    expect(JSON.stringify(rows(h))).toBe(before)
    expect((await detail(h, 'ta')).unread).toBe(true)
    expect(
      (await h.request(AGENT, 'GET', '/api/audit')).json.some(
        (e: { action: string }) => e.action === 'conversation.read',
      ),
    ).toBe(false)

    expect((await post(h, 'ta', 'read')).status).toBe(200)
    expect((await detail(h, 'ta')).unread).toBe(false)
  })

  test('a grant Gmail no longer accepts says to connect again, and changes nothing', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const before = JSON.stringify(rows(h))
    h.google.failNext('thread-read', new GmailAuthError('invalid_grant'))
    const res = await post(h, 'ta', 'read')
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('Connect Gmail again')
    expect(JSON.stringify(rows(h))).toBe(before)
  })

  test('with Gmail disconnected an email conversation cannot be changed, and nothing is asked of Google', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect(asHttp(await h.store.call('disconnectMailbox', firstGmail(h.inbox)?.id as string, OWNER_EMAIL)).status).toBe(
      200,
    )
    const calls = h.google.calls.length
    for (const what of ['read', 'close', 'reopen'] as const) {
      const res = await post(h, 'ta', what)
      expect(res.status, what).toBe(what === 'reopen' ? 200 : 503)
    }
    // Reopening an open conversation is nothing to do, so it never reached the connection check.
    expect(h.google.calls).toHaveLength(calls)
    expect((await detail(h, 'ta')).unread).toBe(true)
    expect((await detail(h, 'ta')).open).toBe(true)
  })

  test('an unknown or malformed conversation is a 404', async () => {
    const h = harness()
    await live(h, mailbox(h))
    // Close and Reopen are Claude's door's; there is no read there (Claude never marks anything read), so the owner's read is the Mailroom's.
    for (const what of ['close', 'reopen']) {
      expect((await h.request(AGENT, 'POST', `/api/conversations/nope/${what}`, {})).status).toBe(404)
      expect((await h.request(AGENT, 'POST', `/api/conversations/${'x'.repeat(65)}/${what}`, {})).status).toBe(404)
    }
    for (const id of ['nope', 'x'.repeat(65)]) {
      expect(asHttp(await h.store.call('changeConversation', id, 'read', OWNER_EMAIL, null)).status).toBe(404)
    }
  })

  test('a write from another site is refused like every other', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const res = await h.request(
      AGENT,
      'POST',
      `/api/conversations/${convoId(h, 'ta')}/close`,
      {},
      { origin: 'https://evil.example' },
    )
    expect(res.status).toBe(403)
    expect(h.google.count('thread-close')).toBe(0)
  })
})

describe('Claude never marks anything read', () => {
  test('Claude’s door has no read endpoint at all, and Gmail and the store are untouched', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const before = JSON.stringify(rows(h))
    const calls = h.google.calls.length
    const res = await post(h, 'ta', 'read', AGENT)
    expect(res.status).toBe(404)
    expect(h.google.calls).toHaveLength(calls)
    expect(JSON.stringify(rows(h))).toBe(before)
  })

  test('reading the queue, a conversation, a contact and the mailbox as the agent leaves every conversation unread', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const calls = h.google.calls.length
    const before = JSON.stringify(rows(h))
    const q = (await h.request(AGENT, 'GET', '/api/queue')).json
    expect(q.filters[0]).toMatchObject({ count: 2, unread: 1 })
    const a = q.rows.find((r: { unread: boolean }) => r.unread)
    const one = (await h.request(AGENT, 'GET', `/api/conversations/${a.id}`)).json
    expect(one.unread).toBe(true)
    await h.request(AGENT, 'GET', `/api/contacts/${one.contacts[0].id}`)
    await h.request(AGENT, 'GET', '/api/mailbox')
    await h.request(AGENT, 'GET', '/api/drafts')
    await h.request(AGENT, 'GET', '/api/audit')
    expect(h.google.calls).toHaveLength(calls)
    expect(JSON.stringify(rows(h))).toBe(before)
    expect((await detail(h, 'ta')).unread).toBe(true)
  })

  test('the agent may close and reopen, which archives and unarchives in Gmail, stamped as the agent', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    const closed = await post(h, 'tb', 'close', AGENT)
    expect(closed.json).toMatchObject({ open: false, closedBy: CLAUDE })
    expect(h.google.calls).toContain('thread-close:tb')
    h.tick()
    const reopened = await post(h, 'tb', 'reopen', AGENT)
    expect(reopened.json).toMatchObject({ open: true, closedBy: null })
    expect(h.google.calls).toContain('thread-reopen:tb')
    expectInStepWithGmail(h)
  })
})

describe('Close and Reopen', () => {
  test('Close archives the thread in Gmail, and the conversation moves from the Inbox to Closed', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    const res = await post(h, 'tb', 'close')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ open: false, closedBy: TESSA })
    expect(h.google.calls).toContain('thread-close:tb')
    expect(h.google.mailbox.messages.get('b1')?.labelIds).not.toContain('INBOX')

    expect(ids(await queue(h, 'inbox'))).toEqual([convoId(h, 'ta')])
    expect(ids(await queue(h, 'closed'))).toEqual([convoId(h, 'tb')])
    expectInStepWithGmail(h)
    expect(
      (await h.request(AGENT, 'GET', '/api/audit')).json.find(
        (e: { action: string }) => e.action === 'conversation.close',
      ),
    ).toMatchObject({ actor: TESSA, before: { open: true }, after: { open: false } })
  })

  test('Close changes only the inbox label and not the read state: an unread conversation closed stays unread', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await post(h, 'ta', 'close')
    expect(await detail(h, 'ta')).toMatchObject({ open: false, unread: true })
    expect(h.google.mailbox.messages.get('a1')?.labelIds).toContain('UNREAD')
    expect((await queue(h, 'closed')).filters.find((f: { id: string }) => f.id === 'closed')).toMatchObject({
      count: 1,
      unread: 1,
    })
  })

  test('the echo of Close changes nothing, and Reopen puts the thread back in Gmail and in the Inbox', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    await post(h, 'tb', 'close')
    const before = JSON.stringify(rows(h))
    await hear(h)
    expect(JSON.stringify(rows(h))).toBe(before)
    expect(rows(h).find((r) => r.gmail_id === 'b1')?.closed_by).toBe(TESSA)

    h.tick()
    const reopened = await post(h, 'tb', 'reopen')
    expect(reopened.json).toMatchObject({ open: true, closedBy: null, closedAt: null })
    expect(h.google.calls).toContain('thread-reopen:tb')
    expect(ids(await queue(h, 'inbox'))).toContain(convoId(h, 'tb'))
    await hear(h)
    expect((await detail(h, 'tb')).open).toBe(true)
    expectInStepWithGmail(h)
  })

  test('closing a closed conversation and reopening an open one ask Gmail for nothing', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await post(h, 'tb', 'reopen')
    expect(h.google.count('thread-reopen')).toBe(0)
    await post(h, 'tb', 'close')
    await post(h, 'tb', 'close')
    expect(h.google.count('thread-close')).toBe(1)
  })

  test('when Gmail refuses to archive, the conversation stays open here', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.failNext('thread-close', new GmailError('Rate Limit Exceeded', 429))
    const res = await post(h, 'tb', 'close')
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('Nothing was changed here')
    expect(res.json.error).toContain('Rate Limit Exceeded')
    expect((await detail(h, 'tb')).open).toBe(true)
    expect(ids(await queue(h, 'inbox'))).toContain(convoId(h, 'tb'))
    expect(h.google.mailbox.messages.get('b1')?.labelIds).toContain('INBOX')
  })

  test('reopening a thread with a message Tessa sent puts INBOX on every message in it, as Gmail does', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'q1', threadId: 'tq', labels: ['INBOX'], from: 'Ann <ann@example.com>' })
      h.google.mailbox.add({ id: 'q2', threadId: 'tq', labels: ['SENT'], from: TESSA, to: 'ann@example.com' })
    })
    expect((await detail(h, 'tq')).open).toBe(true)
    await post(h, 'tq', 'close')
    expect((await detail(h, 'tq')).open).toBe(false)
    await post(h, 'tq', 'reopen')
    expect(h.google.mailbox.messages.get('q2')?.labelIds).toContain('INBOX')
    expectInStepWithGmail(h)
  })

  test('it only ever changes the unread and inbox labels: every other label survives every change', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({
        id: 'z1',
        threadId: 'tz',
        labels: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'CATEGORY_PERSONAL', 'Label_7'],
      })
    })
    for (const what of ['read', 'close', 'reopen'] as const) await post(h, 'tz', what)
    expect(h.google.mailbox.messages.get('z1')?.labelIds?.slice().sort()).toEqual(
      ['CATEGORY_PERSONAL', 'IMPORTANT', 'INBOX', 'Label_7', 'STARRED'].sort(),
    )
    expectInStepWithGmail(h)
  })

  test('only the conversations the inbox holds can be changed: an id it does not hold is a 404 and Google hears nothing', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const calls = h.google.calls.length
    expect((await h.request(AGENT, 'POST', '/api/conversations/some-thread-id/close', {})).status).toBe(404)
    expect(h.google.calls).toHaveLength(calls)
  })
})

describe('what happens in Gmail arrives here', () => {
  test('a message read on the phone reads the conversation, stamped as Gmail', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.mailbox.label('a1', { remove: ['UNREAD'] })
    await hear(h)
    expect(await detail(h, 'ta')).toMatchObject({ unread: false, readBy: 'gmail' })
    expect(rows(h).find((r) => r.gmail_id === 'a1')).toMatchObject({ read_by: 'gmail' })
    expect((await queue(h)).filters[0]).toMatchObject({ unread: 0 })
    expect(h.google.count('thread-read')).toBe(0)
  })

  test('a conversation archived on the phone closes here, stamped as Gmail, and moves to Closed', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    h.google.mailbox.label('b1', { remove: ['INBOX'] })
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: false, closedBy: 'gmail' })
    expect(ids(await queue(h, 'closed'))).toEqual([convoId(h, 'tb')])
    expect(ids(await queue(h, 'inbox'))).toEqual([convoId(h, 'ta')])
    expect(h.google.count('thread-close')).toBe(0)
  })

  test('Mark unread on the phone makes it unread here and takes the read stamp off', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect((await detail(h, 'tb')).unread).toBe(false)
    h.google.mailbox.label('b1', { add: ['UNREAD'] })
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ unread: true, readBy: null, readAt: null })
    expect(rows(h).find((r) => r.gmail_id === 'b1')).toMatchObject({ read_at: null, read_by: null })
  })

  test('moving a thread back to the Inbox on the phone reopens it here', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.mailbox.label('b1', { remove: ['INBOX'] })
    await hear(h)
    h.google.mailbox.label('b1', { add: ['INBOX'] })
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: true, closedBy: null })
  })

  test('a new reply brings a closed, read conversation back, open and unread, with no rule saying so', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.tick()
    await post(h, 'tb', 'read')
    await post(h, 'tb', 'close')
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: false, unread: false })

    h.tick()
    h.google.mailbox.add({ id: 'b2', threadId: 'tb', from: 'Bob <bob@example.com>', subject: 'Re: Second' })
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: true, unread: true, readBy: null, closedBy: null })
    expect(ids(await queue(h, 'inbox'))).toContain(convoId(h, 'tb'))
    expect((await queue(h)).filters[0]).toMatchObject({ unread: 2 })
    expect(h.google.count('thread-read') + h.google.count('thread-reopen')).toBe(0)
  })

  test('a reply Tessa sends from Gmail into an archived thread does not reopen it', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await post(h, 'tb', 'close')
    await hear(h)
    h.google.mailbox.add({ id: 'b-reply', threadId: 'tb', labels: ['SENT'], from: TESSA, to: 'bob@example.com' })
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: false })
  })

  test('a conversation that is only mail Tessa sent is closed and read, as Gmail has it', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 's1', threadId: 'ts', labels: ['SENT'], from: TESSA, to: 'cy@example.com' })
    })
    expect(await detail(h, 'ts')).toMatchObject({ open: false, unread: false })
    expect(ids(await queue(h, 'closed'))).toEqual([convoId(h, 'ts')])
  })

  test('a person and Gmail both acting in the same minute leave one consistent state', async () => {
    const h = harness()
    await live(h, mailbox(h))
    // Tessa opens it here while, at the same moment, Gmail archives it on the phone.
    h.google.mailbox.label('a1', { remove: ['INBOX'] })
    h.google.mailbox.label('a2', { remove: ['INBOX'] })
    h.tick()
    await post(h, 'ta', 'read')
    await hear(h)
    expect(await detail(h, 'ta')).toMatchObject({ unread: false, open: false, readBy: TESSA, closedBy: 'gmail' })
    expectInStepWithGmail(h)
  })
})

describe('nothing unseen is read or archived', () => {
  const reply = (h: H, thread: string, id: string) =>
    h.google.mailbox.add({ id, threadId: thread, from: 'Bob <bob@example.com>', subject: 'A reply' })

  test('Close is refused when a reply the inbox holds is beyond what the page showed, and nothing changes anywhere', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const shown = (await detail(h, 'tb')).through
    h.tick()
    reply(h, 'tb', 'b2')
    await hear(h)

    const res = await post(h, 'tb', 'close', OWNER_EMAIL, shown)
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('A new message arrived')
    expect(h.google.count('thread-close')).toBe(0)
    expect(h.google.mailbox.messages.get('b1')?.labelIds).toContain('INBOX')
    expect(await detail(h, 'tb')).toMatchObject({ open: true })
    expect(
      (await h.request(AGENT, 'GET', '/api/audit')).json.some(
        (e: { action: string }) => e.action === 'conversation.close',
      ),
    ).toBe(false)

    // The page reloads, shows it, and Tessa decides.
    expect((await post(h, 'tb', 'close')).status).toBe(200)
    expect(h.google.mailbox.messages.get('b2')?.labelIds).not.toContain('INBOX')
    expectInStepWithGmail(h)
  })

  test('opening is refused the same way: a reply that came after the page was shown is not marked read', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const shown = (await detail(h, 'ta')).through
    h.tick()
    reply(h, 'ta', 'a3')
    await hear(h)

    const res = await post(h, 'ta', 'read', OWNER_EMAIL, shown)
    expect(res.status).toBe(409)
    expect(h.google.count('thread-read')).toBe(0)
    expect(h.google.mailbox.messages.get('a1')?.labelIds).toContain('UNREAD')
    expect(h.google.mailbox.messages.get('a3')?.labelIds).toContain('UNREAD')
    expect((await detail(h, 'ta')).unread).toBe(true)

    // The page reloads, which shows a3, and asks again with what it now shows.
    expect((await post(h, 'ta', 'read')).status).toBe(200)
    expect((await detail(h, 'ta')).unread).toBe(false)
  })

  test('a reply Gmail has that the inbox has not heard of is stored on the spot, Close is refused, and the thread is untouched', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const shown = (await detail(h, 'tb')).through
    reply(h, 'tb', 'b2') // no push, no sync: only Gmail knows
    expect(rows(h).some((r) => r.gmail_id === 'b2')).toBe(false)

    const res = await post(h, 'tb', 'close', OWNER_EMAIL, shown)
    expect(res.status).toBe(409)
    expect(h.google.count('thread-close')).toBe(0)
    expect(h.google.mailbox.messages.get('b1')?.labelIds).toContain('INBOX')
    const shownNow = await detail(h, 'tb')
    expect(shownNow.messages.map((m: { gmailId: string }) => m.gmailId)).toEqual(['b1', 'b2'])
    expect(shownNow.through).toBeGreaterThan(shown)

    expect((await post(h, 'tb', 'close')).status).toBe(200)
    await hear(h)
    expect(rows(h).filter((r) => r.gmail_id === 'b2')).toHaveLength(1)
    expectInStepWithGmail(h)
  })

  test('a message Tessa sent from his phone in the meantime does not stop Close', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const shown = (await detail(h, 'tb')).through
    h.google.mailbox.add({ id: 'b-sent', threadId: 'tb', labels: ['SENT'], from: TESSA, to: 'bob@example.com' })
    expect((await post(h, 'tb', 'close', OWNER_EMAIL, shown)).status).toBe(200)
    expect(h.google.calls).toContain('thread-close:tb')
    expectInStepWithGmail(h)
  })

  test('a read or Close that does not say how far the page reached is refused for an email conversation, and Reopen needs none', async () => {
    const h = harness()
    await live(h, mailbox(h))
    for (const what of ['read', 'close'] as const) {
      const res = await post(h, 'ta', what, OWNER_EMAIL, null)
      expect(res.status, what).toBe(422)
    }
    expect((await post(h, 'ta', 'close', AGENT, null)).status).toBe(422)
    expect(h.google.count('thread-read') + h.google.count('thread-close')).toBe(0)
    expect((await post(h, 'ta', 'reopen', OWNER_EMAIL, null)).status).toBe(200)
  })

  test('a message that arrives late with an early date is still one nobody was shown', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const shown = (await detail(h, 'tb')).through
    h.tick()
    h.google.mailbox.add({
      id: 'b-old',
      threadId: 'tb',
      from: 'Bob <bob@example.com>',
      at: Date.parse('2026-10-01T00:00:00Z'),
    })
    await hear(h)
    expect((await post(h, 'tb', 'close', OWNER_EMAIL, shown)).status).toBe(409)
  })

  test('an old message from before the fill, archived and read, is stored and does not stop a first read or a first Close', async () => {
    const old = (h: H) => () => {
      const before = h.google.mailbox.clock - 60 * 24 * 60 * 60 * 1000
      h.google.mailbox.add({ id: 'c0', threadId: 'tc', labels: [], at: before, from: 'Carol <carol@example.com>' })
      h.google.mailbox.add({ id: 'c1', threadId: 'tc', labels: ['INBOX', 'UNREAD'], from: 'Carol <carol@example.com>' })
    }
    const read = harness()
    await live(read, old(read))
    expect((await detail(read, 'tc')).messages.map((m: { gmailId: string }) => m.gmailId)).toEqual(['c1'])
    expect((await post(read, 'tc', 'read')).status).toBe(200)
    expect(read.google.calls).toContain('thread-read:tc')
    expect((await detail(read, 'tc')).messages.map((m: { gmailId: string }) => m.gmailId)).toEqual(['c0', 'c1'])
    expect((await detail(read, 'tc')).unread).toBe(false)

    const done = harness()
    await live(done, old(done))
    expect((await post(done, 'tc', 'close')).status).toBe(200)
    expect(done.google.calls).toContain('thread-close:tc')
    expectInStepWithGmail(done)
  })

  test('an old message that IS unread stops a read, and one that is not in the Inbox does not stop a Close', async () => {
    const arrange = async () => {
      const h = harness()
      await live(h, () => {
        const before = h.google.mailbox.clock - 60 * 24 * 60 * 60 * 1000
        h.google.mailbox.add({
          id: 'u0',
          threadId: 'tu',
          labels: ['UNREAD'],
          at: before,
          from: 'Una <una@example.com>',
        })
        h.google.mailbox.add({ id: 'u1', threadId: 'tu', labels: ['INBOX', 'UNREAD'], from: 'Una <una@example.com>' })
      })
      return h
    }
    const read = await arrange()
    expect((await post(read, 'tu', 'read')).status).toBe(409) // u0 is unread and nobody was shown it
    expect(read.google.mailbox.messages.get('u0')?.labelIds).toContain('UNREAD')

    const done = await arrange()
    expect((await post(done, 'tu', 'close')).status).toBe(200) // u0 is not in the Inbox: Close leaves it as it is
  })

  test('a Close that Gmail refused after old messages were stored can be pressed again with the same page, without a false refusal', async () => {
    const h = harness()
    await live(h, () => {
      const before = h.google.mailbox.clock - 60 * 24 * 60 * 60 * 1000
      h.google.mailbox.add({ id: 'c0', threadId: 'tc', labels: [], at: before, from: 'Carol <carol@example.com>' })
      h.google.mailbox.add({ id: 'c1', threadId: 'tc', labels: ['INBOX'], from: 'Carol <carol@example.com>' })
    })
    const shown = (await detail(h, 'tc')).through
    h.google.failNext('thread-close', new GmailError('Backend Error', 500))
    expect((await post(h, 'tc', 'close', OWNER_EMAIL, shown)).status).toBe(502)
    expect((await post(h, 'tc', 'close', OWNER_EMAIL, shown)).status).toBe(200)
  })

  test('a Reopen that Gmail did part of says so; the inbox shows it open once Gmail reports it, and Reopen again finishes it before that', async () => {
    const arrange = async () => {
      const h = harness()
      await live(h, () => {
        for (const id of ['p1', 'p2', 'p3']) {
          h.google.mailbox.add({ id, threadId: 'tp', labels: ['INBOX'], from: 'Pat <pat@example.com>' })
        }
      })
      await post(h, 'tp', 'close')
      h.google.reopenFailsAfter = 1
      const res = await post(h, 'tp', 'reopen')
      expect(res.status).toBe(502)
      expect(res.json.error).toContain('partly reopened')
      expect(res.json.error).toContain('1 of 3')
      expect(res.json.error).not.toContain('Nothing was changed')
      // Nothing is written here by the refused request itself.
      expect((await detail(h, 'tp')).open).toBe(false)
      return h
    }

    const reported = await arrange()
    await hear(reported) // Gmail reports the one message that did move
    expect((await detail(reported, 'tp')).open).toBe(true)
    expectInStepWithGmail(reported)

    const pressedAgain = await arrange()
    expect((await post(pressedAgain, 'tp', 'reopen')).status).toBe(200)
    for (const id of ['p1', 'p2', 'p3'])
      expect(pressedAgain.google.mailbox.messages.get(id)?.labelIds).toContain('INBOX')
    expectInStepWithGmail(pressedAgain)
  })

  test('a thread with no thread id is refused, not changed here alone', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.db.run(`UPDATE conversation SET gmail_thread_id = NULL WHERE id = ?`, [convoId(h, 'tb')])
    const res = asHttp(
      await h.store.call(
        'changeConversation',
        (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id IS NULL`).get() as { id: string }).id,
        'close',
        OWNER_EMAIL,
        1,
      ),
    )
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('no thread in Gmail')
    expect(
      (h.db.query(`SELECT labels FROM message WHERE gmail_id = 'b1'`).get() as { labels: string }).labels,
    ).toContain('INBOX')
  })
})

describe('a conversation Gmail no longer has, and one that is in the trash', () => {
  const gone = (h: H, ...ids: string[]) => {
    for (const id of ids) h.google.mailbox.messages.delete(id)
  }

  test('Close works on a thread deleted in Gmail, here, without a request to change it', async () => {
    const h = harness()
    await live(h, mailbox(h))
    gone(h, 'b1')
    h.tick()
    const res = await post(h, 'tb', 'close')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ open: false, closedBy: TESSA })
    expect(h.google.count('thread-close')).toBe(0)
    expect(ids(await queue(h, 'closed'))).toContain(convoId(h, 'tb'))
  })

  test('opening one marks it read here, and a 404 when the change itself is made counts the same', async () => {
    const h = harness()
    await live(h, mailbox(h))
    gone(h, 'a1', 'a2')
    h.tick()
    expect((await post(h, 'ta', 'read')).json).toMatchObject({ unread: false, readBy: TESSA })

    const raced = harness()
    await live(raced, mailbox(raced))
    raced.google.failNext('thread-close', new GmailError('Gmail no longer has that conversation.', 404))
    expect((await post(raced, 'tb', 'close')).json).toMatchObject({ open: false, closedBy: TESSA })
  })

  test('reopening one is refused: there is nothing to put back', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await post(h, 'tb', 'close')
    gone(h, 'b1')
    const res = await post(h, 'tb', 'reopen')
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('no longer has that conversation')
    expect((await detail(h, 'tb')).open).toBe(false)
  })

  test('a message in the trash takes no part: a thread whose only message is trashed is closed and read, not stuck', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.mailbox.label('b1', { add: ['TRASH'] }) // Gmail keeps INBOX on it here; the inbox must not count it
    await hear(h)
    expect(await detail(h, 'tb')).toMatchObject({ open: false, unread: false })
    expect(ids(await queue(h, 'closed'))).toContain(convoId(h, 'tb'))
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0].open).toBe(1)
  })

  test('a trashed unread message does not hold a conversation unread or open', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.mailbox.label('a1', { add: ['TRASH'] }) // a1 is the unread one; a2 is read and in the Inbox
    await hear(h)
    expect(await detail(h, 'ta')).toMatchObject({ open: true, unread: false })
  })

  test('reopen puts INBOX on what is in play and leaves a trashed message where it is, in Gmail and here', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 't1', threadId: 'tt', labels: ['INBOX'], from: 'Ann <ann@example.com>' })
      h.google.mailbox.add({ id: 't2', threadId: 'tt', labels: ['SENT'], from: TESSA, to: 'ann@example.com' })
      h.google.mailbox.add({ id: 't3', threadId: 'tt', labels: ['INBOX'], from: 'Ann <ann@example.com>' })
    })
    h.google.mailbox.label('t3', { add: ['TRASH'], remove: ['INBOX'] })
    await hear(h)
    await post(h, 'tt', 'close')
    await post(h, 'tt', 'reopen')
    expect(h.google.mailbox.messages.get('t1')?.labelIds).toContain('INBOX')
    expect(h.google.mailbox.messages.get('t2')?.labelIds).toContain('INBOX')
    expect(h.google.mailbox.messages.get('t3')?.labelIds).not.toContain('INBOX')
    expectInStepWithGmail(h)
    expect(await detail(h, 'tt')).toMatchObject({ open: true })
  })

  test('reopening a conversation of which everything is in the trash is refused before Gmail is asked', async () => {
    const h = harness()
    await live(h, mailbox(h))
    h.google.mailbox.label('b1', { add: ['TRASH'], remove: ['INBOX'] })
    await hear(h)
    const calls = h.google.calls.length
    const res = await post(h, 'tb', 'reopen')
    expect(res.status).toBe(409)
    expect(res.json.error).toContain('trash or spam')
    expect(h.google.calls).toHaveLength(calls)
  })
})

describe('the queue counts the whole mailbox, and shows the first screen of the filter asked for', () => {
  test('open conversations older than a screenful of closed mail are still in the Inbox, and every count is the whole table', async () => {
    const h = harness()
    const base = Date.parse('2026-10-05T00:00:00Z')
    await live(h, () => {
      for (const n of [1, 2, 3]) {
        h.google.mailbox.add({ id: `open-${n}`, threadId: `to-${n}`, labels: ['INBOX', 'UNREAD'], at: base + n * 1000 })
      }
      for (let n = 0; n < 205; n += 1) {
        h.google.mailbox.add({
          id: `sent-${n}`,
          threadId: `ts-${n}`,
          labels: ['SENT'],
          from: TESSA,
          to: 'x@example.com',
          at: base + 10_000 + n * 1000,
        })
      }
    })
    const all = await queue(h, 'inbox')
    expect(all.rows).toHaveLength(3)
    expect(all.filters[0]).toMatchObject({ id: 'inbox', count: 3, unread: 3 })

    const closed = await queue(h, 'closed')
    expect(closed.rows).toHaveLength(200)
    expect(closed.filters.find((f: { id: string }) => f.id === 'closed')).toMatchObject({ count: 205 })

    // The queue and the Gmail connection in Settings agree about what is open.
    const open =
      all.filters.find((f: { id: string }) => f.id === 'inbox').count +
      all.filters.find((f: { id: string }) => f.id === 'bulk').count
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0].open).toBe(open)
  })
})

describe('Bulk, from the mail the inbox holds', () => {
  const news = (h: H) => () => {
    h.google.mailbox.add({
      id: 'n1',
      threadId: 'tn',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
      from: 'Hosting Weekly <news@hosting.example>',
      headers: { 'List-Unsubscribe': '<https://hosting.example/unsub>' },
    })
    h.google.mailbox.add({
      id: 'r1',
      threadId: 'tr',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      from: 'Bank <alerts@bank.example>',
    })
    h.google.mailbox.add({
      id: 'p1',
      threadId: 'tp',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
      from: 'Dana <dana@example.com>',
    })
  }

  test('a newsletter, a category tab and a person: Bulk holds the first two and the Inbox the third', async () => {
    const h = harness()
    await live(h, news(h))
    expect(ids(await queue(h, 'bulk')).sort()).toEqual([convoId(h, 'tn'), convoId(h, 'tr')].sort())
    expect(ids(await queue(h, 'inbox'))).toEqual([convoId(h, 'tp')])
    expect((await queue(h)).filters.map((f: { id: string; count: number }) => [f.id, f.count])).toEqual([
      ['inbox', 1],
      ['unread', 1],
      ['drafts', 0],
      ['bulk', 2],
      ['closed', 0],
    ])
    expect((await queue(h, 'bulk')).rows.every((r: { bulk: boolean }) => r.bulk)).toBe(true)
  })

  test('a person writing on a newsletter thread makes it ordinary mail, because only the newest inbound counts', async () => {
    const h = harness()
    await live(h, news(h))
    h.google.mailbox.add({
      id: 'n2',
      threadId: 'tn',
      from: 'Hosting Weekly <news@hosting.example>',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    })
    await hear(h)
    expect(ids(await queue(h, 'inbox'))).toContain(convoId(h, 'tn'))
  })

  test('archiving a newsletter takes it out of Bulk and into Closed, and never into the Inbox', async () => {
    const h = harness()
    await live(h, news(h))
    await post(h, 'tn', 'close')
    expect(ids(await queue(h, 'bulk'))).toEqual([convoId(h, 'tr')])
    expect(ids(await queue(h, 'closed'))).toEqual([convoId(h, 'tn')])
    expect(ids(await queue(h, 'inbox'))).not.toContain(convoId(h, 'tn'))
  })

  test('opening a bulk conversation marks it read in Gmail like any other', async () => {
    const h = harness()
    await live(h, news(h))
    await post(h, 'tn', 'read')
    expect(h.google.calls).toContain('thread-read:tn')
    expect((await queue(h, 'bulk')).filters.find((f: { id: string }) => f.id === 'bulk')).toMatchObject({
      count: 2,
      unread: 1,
    })
  })
})

describe('the numbers to compare with Gmail', () => {
  test('the header counts Gmail-Inbox conversations and the unread ones among them, bulk included, and they follow every change', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'a1', threadId: 'ta' })
      h.google.mailbox.add({ id: 'a2', threadId: 'ta', labels: ['INBOX'] })
      h.google.mailbox.add({ id: 'b1', threadId: 'tb', labels: ['INBOX'] })
      h.google.mailbox.add({ id: 'c1', threadId: 'tc', labels: ['INBOX', 'UNREAD'] })
      h.google.mailbox.add({ id: 'd1', threadId: 'td', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] })
      h.google.mailbox.add({ id: 'e1', threadId: 'te', labels: ['SENT'], from: TESSA, to: 'x@example.com' })
    })
    const status = async () => (await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0]
    h.google.mailbox.label('c1', { remove: ['INBOX'] })
    await hear(h)
    // ta (open, unread), tb (open), td (open, unread, bulk); tc is archived and unread; te is sent-only.
    expect(await status()).toMatchObject({ conversations: 5, open: 3, unreadOpen: 2 })

    await post(h, 'ta', 'read')
    expect(await status()).toMatchObject({ open: 3, unreadOpen: 1 })
    await post(h, 'td', 'close')
    expect(await status()).toMatchObject({ open: 2, unreadOpen: 0 })
    h.google.mailbox.label('c1', { add: ['INBOX'] })
    await hear(h)
    expect(await status()).toMatchObject({ open: 3, unreadOpen: 1 })
  })

  test('a mailbox that holds nothing counts zero, not nothing', async () => {
    const h = harness()
    await live(h)
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0]).toMatchObject({ open: 0, unreadOpen: 0 })
  })
})

describe('a conversation with no Gmail side', () => {
  async function marked(h: H) {
    const d = (await ownerDraft(h, { address: '626-555-0142', name: 'Marcus', body: 'hi' })).json
    return asHttp(await h.store.call('markSent', d.id, undefined, OWNER_EMAIL)).json.conversationId as string
  }

  test('it is filed read and closed, can be reopened and closed again, and Google is never asked', async () => {
    const h = harness()
    const id = await marked(h)
    expect((await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json).toMatchObject({
      open: false,
      unread: false,
    })

    h.tick()
    const reopened = asHttp(await h.store.call('changeConversation', id, 'reopen', OWNER_EMAIL, null))
    expect(reopened.json).toMatchObject({ open: true, closedBy: null })
    expect(ids(await queue(h, 'inbox'))).toEqual([id])

    h.tick()
    const closed = asHttp(await h.store.call('changeConversation', id, 'close', OWNER_EMAIL, null))
    expect(closed.json).toMatchObject({ open: false, closedBy: TESSA })
    expect(h.google.calls).toEqual([])
  })

  test('the agent can close and reopen it and has no way to read it', async () => {
    const h = harness()
    const id = await marked(h)
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/reopen`, {})).json).toMatchObject({ open: true })
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/close`, {})).json).toMatchObject({
      open: false,
      closedBy: CLAUDE,
    })
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/read`, {})).status).toBe(404)
  })

  test('marking it sent, unmarking it and marking it again leaves a draft with no stamps and a filed message with them', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: '626-555-0100', body: 'one' })).json
    const stamps = () =>
      h.db.query(`SELECT status, read_at, read_by, closed_at, closed_by FROM message WHERE id = ?`).get(d.id) as Record<
        string,
        string | null
      >
    expect(stamps()).toMatchObject({ status: 'draft', read_at: null, closed_at: null })
    await h.store.call('markSent', d.id, undefined, OWNER_EMAIL)
    expect(stamps()).toMatchObject({ status: 'manual-sent', read_by: TESSA, closed_by: TESSA })
    await h.store.call('unmarkSent', d.id, OWNER_EMAIL)
    expect(stamps()).toMatchObject({ status: 'draft', read_at: null, read_by: null, closed_at: null, closed_by: null })
    await h.store.call('markSent', d.id, undefined, OWNER_EMAIL)
    expect(stamps()).toMatchObject({ status: 'manual-sent', read_by: TESSA })
  })

  test('a draft waiting on an email conversation takes no part in whether it is read or open', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const id = convoId(h, 'tb')
    await ownerDraft(h, { conversationId: id, body: 'Thanks Bob' })
    expect(await detail(h, 'tb')).toMatchObject({ open: true, unread: false })
    await post(h, 'tb', 'close')
    expect(await detail(h, 'tb')).toMatchObject({ open: false })
    expect(ids(await queue(h, 'drafts'))).toEqual([id])
  })
})
