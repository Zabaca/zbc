import { describe, expect, test } from 'bun:test'
import { refusedReason } from '../src/jmap/room'
import { harness, T0 } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * Read, Close and Reopen of a conversation in a JMAP mailbox, driven through the Mailroom's `changeConversation` as the space does for Tessa: THE SERVER IS ASKED FIRST, the inbox changes only when it accepts, a
 * message the page was not shown refuses the change, a refusal changes nothing and says why, and a partial change says so. The Mailroom hands a JMAP conversation to the JMAP room whole, so Gmail's chain is never
 * entered (the last test). What this cannot show is Stalwart (the live checks, packages/inbox/docs/runbooks/inbox-jmap-mailbox.md).
 */

type H = ReturnType<typeof harness>

const jh = (options: Parameters<typeof harness>[1] = {}) => harness({}, { jmap: true, ...options })
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string): number =>
  (h.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
const conversationOf = (h: H, jmapId: string): string =>
  (h.db.query(`SELECT conversation_id AS id FROM message WHERE jmap_id = ?`).get(jmapId) as { id: string }).id
const state = (h: H, id: string) => h.inbox.listConversations([id])[0]
const through = (h: H, id: string): number => {
  const detail = h.inbox.getConversation(id)
  if (!detail.ok) throw new Error(detail.error)
  return detail.value.through
}
const labelsOf = (h: H, jmapId: string): string[] =>
  JSON.parse((h.db.query(`SELECT labels FROM message WHERE jmap_id = ?`).get(jmapId) as { labels: string }).labels)
const folderOf = (h: H, jmapId: string): string[] => Object.keys(h.jmapServer.emails.get(jmapId)?.mailboxIds ?? {})
const change = (
  h: H,
  id: string,
  what: 'read' | 'close' | 'reopen',
  over: { through?: number | null; actor?: string } = {},
) =>
  h.mailroom.changeConversation(
    id,
    what,
    over.actor ?? OWNER_EMAIL,
    over.through === undefined ? through(h, id) : over.through,
  )
const asked = (h: H) => h.jmapServer.requests.length

async function live(h: H) {
  await h.jmapRoom.requestJmapSync()
  await h.drain()
  expect(h.jmapRoom.jmapMailboxes()[0]?.state).toBe('live')
}

/** An Inbox thread of two messages from Dana (the first read, the second not), and a single one from Arun. */
async function world() {
  const h = jh()
  const first = h.jmapServer.deliver({
    subject: 'Quote',
    from: 'Dana Smith <dana@example.com>',
    messageId: '<q1@example.com>',
    seen: true,
    at: T0 - 3000,
  })
  const second = h.jmapServer.deliver({
    subject: 'Re: Quote',
    from: 'Dana Smith <dana@example.com>',
    messageId: '<q2@example.com>',
    inReplyTo: '<q1@example.com>',
    threadId: h.jmapServer.emails.get(first)?.threadId,
    at: T0 - 2000,
  })
  const arun = h.jmapServer.deliver({ subject: 'Hello', from: 'Arun Mehta <arun@example.org>', at: T0 - 1000 })
  await live(h)
  return { h, first, second, arun, dana: conversationOf(h, first), arunConversation: conversationOf(h, arun) }
}

describe('opening a conversation', () => {
  test('marks the thread’s messages seen on the server first, then in the inbox; the server’s echo finds it done and keeps the person’s name on the stamp', async () => {
    const { h, first, second, dana } = await world()
    expect(state(h, dana)).toMatchObject({ unread: true })
    const r = await change(h, dana, 'read')
    expect(r).toMatchObject({ ok: true })
    expect(h.jmapServer.emails.get(first)?.keywords.$seen).toBe(true)
    expect(h.jmapServer.emails.get(second)?.keywords.$seen).toBe(true)
    expect(state(h, dana)).toMatchObject({ unread: false, readBy: OWNER_EMAIL })
    // the push the server sends for it, and the sync that follows, change nothing
    await h.drain()
    h.tick(1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(state(h, dana)).toMatchObject({ unread: false, readBy: OWNER_EMAIL })
    expect(labelsOf(h, second)).toEqual(['INBOX'])
  })

  test('a conversation already read asks the server for nothing', async () => {
    const { h, arunConversation, arun } = await world()
    h.jmapServer.markSeen(arun, true)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const before = asked(h)
    expect(await change(h, arunConversation, 'read')).toMatchObject({ ok: true })
    expect(asked(h)).toBe(before)
  })
})

describe('Close and Reopen', () => {
  test('Close moves the thread’s messages from the Inbox to Archive on the server, as a mail app does, and closes it in the inbox; Reopen moves them back', async () => {
    const { h, first, second, dana } = await world()
    expect(await change(h, dana, 'close')).toMatchObject({ ok: true })
    expect(folderOf(h, first)).toEqual([h.jmapServer.folder('archive')])
    expect(folderOf(h, second)).toEqual([h.jmapServer.folder('archive')])
    expect(state(h, dana)).toMatchObject({ open: false, closedBy: OWNER_EMAIL })
    // the server's echo leaves the person's name on the stamp
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(state(h, dana)).toMatchObject({ open: false, closedBy: OWNER_EMAIL })

    expect(await change(h, dana, 'reopen')).toMatchObject({ ok: true })
    expect(folderOf(h, first)).toEqual([h.jmapServer.folder('inbox')])
    expect(folderOf(h, second)).toEqual([h.jmapServer.folder('inbox')])
    expect(state(h, dana)).toMatchObject({ open: true })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(state(h, dana)).toMatchObject({ open: true })
  })

  test('closing is a move to Archive and nothing else: no message is deleted, and the other conversation is untouched', async () => {
    const { h, dana, arun, arunConversation } = await world()
    const messagesBefore = h.jmapServer.emails.size
    await change(h, dana, 'close')
    expect(h.jmapServer.emails.size).toBe(messagesBefore)
    expect(folderOf(h, arun)).toEqual([h.jmapServer.folder('inbox')])
    expect(state(h, arunConversation)).toMatchObject({ open: true })
    expect(h.jmapServer.requests.flatMap((r) => r.calls).some((c) => c.kind === 'remove-unsent')).toBe(false)
  })

  test('a message the mailbox sent stays in Sent when its conversation is closed and opened again, and is never counted as open', async () => {
    const h = jh()
    const theirs = h.jmapServer.deliver({
      subject: 'Question',
      from: 'Dana <dana@example.com>',
      messageId: '<d1@example.com>',
      at: T0 - 3000,
    })
    const ours = h.jmapServer.deliver({
      subject: 'Re: Question',
      from: 'Test <test@harborline.example>',
      to: 'Dana <dana@example.com>',
      folder: 'sent',
      inReplyTo: '<d1@example.com>',
      threadId: h.jmapServer.emails.get(theirs)?.threadId,
      at: T0 - 2000,
    })
    await live(h)
    const id = conversationOf(h, theirs)
    await change(h, id, 'close')
    expect(folderOf(h, theirs)).toEqual([h.jmapServer.folder('archive')])
    expect(folderOf(h, ours)).toEqual([h.jmapServer.folder('sent')])
    await change(h, id, 'reopen')
    expect(folderOf(h, theirs)).toEqual([h.jmapServer.folder('inbox')])
    expect(folderOf(h, ours)).toEqual([h.jmapServer.folder('sent')])
    expect(labelsOf(h, ours)).toEqual(['SENT'])
    expect(state(h, id)).toMatchObject({ open: true })
    // after a sync it is the same
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(labelsOf(h, ours)).toEqual(['SENT'])
  })

  test('a thread that has a message in the trash does not bring it back on Reopen', async () => {
    const { h, first, second, dana } = await world()
    await change(h, dana, 'close')
    h.jmapServer.moveTo(second, 'trash')
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(await change(h, dana, 'reopen')).toMatchObject({ ok: true })
    expect(folderOf(h, first)).toEqual([h.jmapServer.folder('inbox')])
    expect(folderOf(h, second)).toEqual([h.jmapServer.folder('trash')])
  })
})

describe('what the page was not shown', () => {
  test('a message that arrived on the server and is not stored yet is stored on the spot, and the change is refused (nothing changed anywhere)', async () => {
    const { h, first, second, dana } = await world()
    const shown = through(h, dana)
    const late = h.jmapServer.deliver({
      subject: 'Re: Quote',
      from: 'Dana Smith <dana@example.com>',
      inReplyTo: '<q2@example.com>',
      threadId: h.jmapServer.emails.get(first)?.threadId,
      at: T0 - 500,
    })
    const r = await change(h, dana, 'close', { through: shown })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect((r as { error: string }).error).toContain('A new message arrived')
    // nothing was moved, and what the page was not shown is stored now so the reload shows it
    expect(folderOf(h, first)).toEqual([h.jmapServer.folder('inbox')])
    expect(folderOf(h, second)).toEqual([h.jmapServer.folder('inbox')])
    expect(folderOf(h, late)).toEqual([h.jmapServer.folder('inbox')])
    expect(state(h, dana)).toMatchObject({ open: true })
    expect(count(h, 'message')).toBe(4)
    // shown the new message, he can close
    expect(await change(h, dana, 'close')).toMatchObject({ ok: true })
    expect(folderOf(h, late)).toEqual([h.jmapServer.folder('archive')])
  })

  test('a message the inbox holds beyond what the page showed refuses read and close as it does for Gmail, and a close without how far it was read is a 422', async () => {
    const { h, dana } = await world()
    const shown = through(h, dana)
    expect(await change(h, dana, 'read', { through: shown - 1 })).toMatchObject({ ok: false, status: 409 })
    expect(await change(h, dana, 'close', { through: null })).toMatchObject({ ok: false, status: 422 })
    expect(await change(h, dana, 'close', { through: 99999 })).toMatchObject({ ok: false, status: 422 })
    expect(state(h, dana)).toMatchObject({ open: true, unread: true })
  })

  test('old mail the change would leave as it is does not refuse it (a read, archived message from before the fill)', async () => {
    const { h, first, dana } = await world()
    const old = h.jmapServer.deliver({
      subject: 'Re: Quote',
      from: 'Dana <dana@example.com>',
      inReplyTo: '<q1@example.com>',
      threadId: h.jmapServer.emails.get(first)?.threadId,
      folder: 'archive',
      seen: true,
      at: T0 - 40 * 24 * 60 * 60 * 1000,
    })
    const shown = through(h, dana)
    expect(await change(h, dana, 'close', { through: shown })).toMatchObject({ ok: true })
    expect(folderOf(h, old)).toEqual([h.jmapServer.folder('archive')])
  })
})

describe('what the server can do', () => {
  test('refuse the move: nothing changes in the inbox and the answer says why', async () => {
    const { h, first, second, dana } = await world()
    h.jmapServer.refuseUpdatesOf.add(first)
    h.jmapServer.refuseUpdatesOf.add(second)
    const r = await change(h, dana, 'close')
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect((r as { error: string }).error).toContain('Nothing was changed here')
    expect(state(h, dana)).toMatchObject({ open: true })
  })

  test('move some and refuse the rest: the answer says it is partial, the inbox is not changed, and doing it again moves the rest', async () => {
    const { h, first, second, dana } = await world()
    h.jmapServer.refuseUpdatesOf.add(second)
    const r = await change(h, dana, 'close')
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect((r as { error: string }).error).toContain('moved 1 of 2')
    expect((r as { error: string }).error).toContain('partly closed')
    expect(folderOf(h, first)).toEqual([h.jmapServer.folder('archive')])
    expect(state(h, dana)).toMatchObject({ open: true })
    // the server reports its state on the next sync, which is what the inbox shows
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(labelsOf(h, first)).toEqual([])
    expect(state(h, dana)).toMatchObject({ open: true }) // the second is still in the Inbox
    h.jmapServer.refuseUpdatesOf.clear()
    expect(await change(h, dana, 'close')).toMatchObject({ ok: true })
    expect(state(h, dana)).toMatchObject({ open: false })
  })

  test('be unreachable: nothing changes, and it is said', async () => {
    const { h, dana } = await world()
    h.jmapServer.unreachable = true
    const r = await change(h, dana, 'close')
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect((r as { error: string }).error).toContain('could not be reached')
    expect(state(h, dana)).toMatchObject({ open: true })
  })

  test('refuse the key: the mailbox is refused, the change is not made, and nothing more is asked of the server', async () => {
    const { h, dana, arunConversation } = await world()
    h.jmapServer.refuseKey = true
    const r = await change(h, dana, 'close')
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect((r as { error: string }).error).toContain(refusedReason('test@harborline.example'))
    expect(state(h, dana)).toMatchObject({ open: true })
    expect(h.jmapRoom.jmapMailboxes()[0]?.state).toBe('refused')
    const before = asked(h)
    expect(await change(h, arunConversation, 'close')).toMatchObject({ ok: false, status: 503 })
    expect(asked(h)).toBe(before)
  })

  test('have no Archive folder: Close says so in words and changes nothing', async () => {
    const { h, dana } = await world()
    h.jmapServer.folders = h.jmapServer.folders.filter((f) => f.role !== 'archive')
    const r = await change(h, dana, 'close')
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect((r as { error: string }).error).toContain('no Archive folder')
    expect(state(h, dana)).toMatchObject({ open: true })
  })

  test('no longer have the thread (deleted there): Close and read are done in the inbox alone, and Reopen is refused', async () => {
    const { h, first, second, dana } = await world()
    h.jmapServer.destroy(first)
    h.jmapServer.destroy(second)
    expect(await change(h, dana, 'close')).toMatchObject({ ok: true })
    expect(state(h, dana)).toMatchObject({ open: false })
    const reopened = await change(h, dana, 'reopen')
    expect(reopened).toMatchObject({ ok: false, status: 409 })
  })
})

describe('who and what', () => {
  test('Claude’s close is the same path, with its own actor on the stamp, and a reply found there rings (nobody is looking)', async () => {
    const { h, first, dana } = await world()
    const late = h.jmapServer.deliver({
      subject: 'Re: Quote',
      from: 'Dana Smith <dana@example.com>',
      inReplyTo: '<q2@example.com>',
      threadId: h.jmapServer.emails.get(first)?.threadId,
      at: h.now(),
    })
    const agent = 'agent:abc123.access'
    const r = await change(h, dana, 'close', { actor: agent })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(rows<{ notify: string | null }>(h, `SELECT notify FROM message WHERE jmap_id = '${late}'`)[0]?.notify).toBe(
      'dropped',
    )
  })

  test('a Bulk call stays the inbox’s own: it is never written to the server', async () => {
    const { h, arunConversation } = await world()
    const before = asked(h)
    const r = await h.store.call('setSpam', arunConversation, true, OWNER_EMAIL)
    expect(r).toMatchObject({ ok: true })
    expect(asked(h)).toBe(before)
    expect(state(h, arunConversation)).toMatchObject({ spamCall: { spam: true, by: 'owner' } })
  })

  test('a Gmail conversation beside it is changed in Gmail by the Mailroom as it always was, and the mail server is not asked', async () => {
    const h = jh()
    h.google.mailbox.add({ id: 'g1', threadId: 'tg1', subject: 'Gmail mail' })
    h.jmapServer.deliver({ subject: 'Mail server mail', at: T0 - 1000 })
    expect((await h.connect()).ok).toBe(true)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const g = (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = 'tg1'`).get() as { id: string }).id
    const before = asked(h)
    expect(await change(h, g, 'close')).toMatchObject({ ok: true })
    expect(asked(h)).toBe(before)
    expect(h.google.calls.some((c) => c.startsWith('changeThread') || c.includes('close'))).toBe(true)
  })

  test('the draft chat is refused on a mailbox no persona is written for, in words', async () => {
    const { h, dana } = await world()
    const r = await h.store.call(
      'chat',
      dana,
      { instruction: 'Say yes', draftId: null, rev: undefined, body: undefined, subject: undefined } as never,
      OWNER_EMAIL,
    )
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).toContain('nothing written for test@harborline.example')
  })
})
