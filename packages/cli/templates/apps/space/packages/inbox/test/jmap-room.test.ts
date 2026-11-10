import { describe, expect, test } from 'bun:test'
import { backoffMs } from '../src/gmail/mailroom'
import { refusedReason } from '../src/jmap/room'
import { present } from '../test-support/fake-jmap'
import { harness, T0 } from '../test-support/harness'

/**
 * The JMAP room (src/jmap/room.ts) and the store's JMAP half (src/store/jmap.ts), driven at the room's interface through the harness: the real store over a real SQLite with the real migrations, the real client, and a
 * mail server that can fail (test-support/fake-jmap.ts). What is proved: the fill (30 days of Inbox and Sent, what is not brought in, the cursor, no notification), a sync after a push (new mail, a read mark from a mail
 * app, an archive, a move back, a message destroyed, junk, a flag), a cursor the server cannot answer from, the push subscription's whole life, a refused key being a state and not a retry, one mailbox's trouble never
 * being Gmail's, and a mailbox taken out of the declaration. Read, Close and sending are in jmap-change.test.ts and jmap-send.test.ts.
 *
 * What this cannot show is Stalwart: that its states, pushes, keywords and moves behave as the fake's do. The live checks (packages/inbox/docs/runbooks/inbox-jmap-mailbox.md) are where the real server is asked.
 */

type H = ReturnType<typeof harness>

/** The harness with the test mailbox declared (test@harborline.example) behind the fake mail server. */
const jh = (options: Parameters<typeof harness>[1] = {}) => harness({}, { jmap: true, ...options })

const DAY = 24 * 60 * 60 * 1000
const ADDRESS = 'test@harborline.example'

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string): number =>
  (h.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
const box = (h: H) => h.inbox.jmapRows()[0] as NonNullable<ReturnType<H['inbox']['jmapRows']>[number]>
const status = (h: H) => h.jmapRoom.jmapMailboxes()[0] as ReturnType<H['jmapRoom']['jmapMailboxes']>[number]
const labelsOf = (h: H, jmapId: string): string[] =>
  JSON.parse(
    (h.db.query(`SELECT labels FROM message WHERE jmap_id = ?`).get(jmapId) as { labels: string } | null)?.labels ??
      '[]',
  )
const messageOf = (h: H, jmapId: string) =>
  h.db.query(`SELECT * FROM message WHERE jmap_id = ?`).get(jmapId) as Record<string, unknown> | null
const conversationOfMessage = (h: H, jmapId: string): string =>
  (h.db.query(`SELECT conversation_id AS id FROM message WHERE jmap_id = ?`).get(jmapId) as { id: string }).id
const summary = (h: H, id: string) => h.inbox.listConversations([id])[0]

/** The first run after a deploy: the alarm the object asks for when it starts, then the fill (and the sync that follows it) run to the end. */
async function start(h: H) {
  expect(await h.jmapRoom.hasJmapWork()).toBe(true)
  await h.jmapRoom.requestJmapSync()
  await h.drain()
}

/** Hand every push the server owes to the push hostname, as the internet would; answers each status. */
async function deliverPushes(h: H): Promise<number[]> {
  const statuses: number[] = []
  await h.jmapServer.drainPushes(async (url, body) => {
    const res = await h.pushApp.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      h.env,
    )
    statuses.push(res.status)
  })
  return statuses
}

/** The server pushes, the door answers at once, and the alarm it asked for runs. */
async function hear(h: H): Promise<number[]> {
  const statuses = await deliverPushes(h)
  h.tick(1000)
  await h.drain()
  return statuses
}

/** A started mailbox whose push subscription the server has verified: the steady state mail then arrives in. */
async function live(h: H) {
  await start(h)
  await hear(h)
  expect(status(h).push).toBe('live')
}

/** A server with a little of everything: unread and read Inbox mail, a sent reply, junk, a very old message, a message filed in Archive on arrival. */
function seed(h: H) {
  const s = h.jmapServer
  const recent = (days: number) => T0 - days * DAY
  return {
    unread: s.deliver({ subject: 'Unread', from: 'Dana Smith <dana@example.com>', at: recent(2) }),
    seen: s.deliver({ subject: 'Seen', from: 'Arun Mehta <arun@example.org>', seen: true, at: recent(3) }),
    sent: s.deliver({
      subject: 'Sent by us',
      from: `Test <${ADDRESS}>`,
      to: 'Lane <lane@example.net>',
      folder: 'sent',
      at: recent(4),
    }),
    junk: s.deliver({ subject: 'Junk', from: 'Spam <spam@example.com>', folder: 'junk', at: recent(1) }),
    old: s.deliver({ subject: 'Old', at: recent(45) }),
    archived: s.deliver({ subject: 'Archived on arrival', folder: 'archive', seen: true, at: recent(5) }),
  }
}

describe('the fill', () => {
  test('lists 30 days of Inbox and Sent, oldest first; brings in neither junk, nor what is older, nor what was filed away; and rings nobody', async () => {
    const h = jh()
    const ids = seed(h)
    await start(h)

    expect(h.inbox.jmapRows().map((r) => [r.address, r.name])).toEqual([[ADDRESS, 'harborline']])
    expect(box(h).job).toBeNull()
    expect(box(h).cursor).not.toBeNull()

    const stored = rows<{ jmap_id: string }>(
      h,
      `SELECT jmap_id FROM message WHERE jmap_id IS NOT NULL ORDER BY rowid`,
    ).map((r) => r.jmap_id)
    expect(stored.sort()).toEqual([ids.unread, ids.seen, ids.sent].sort())
    // each by its JMAP id and thread, in columns of their own, and never in Gmail's
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE gmail_id IS NOT NULL`)).toEqual([{ n: 0 }])
    expect(rows(h, `SELECT count(*) AS n FROM conversation WHERE gmail_thread_id IS NOT NULL`)).toEqual([{ n: 0 }])
    expect(
      rows<{ n: number }>(h, `SELECT count(*) AS n FROM conversation WHERE jmap_thread_id IS NOT NULL`)[0]?.n,
    ).toBe(3)

    // the labels are the mapping's, and the fill rang nobody
    expect(labelsOf(h, ids.unread)).toEqual(['INBOX', 'UNREAD'])
    expect(labelsOf(h, ids.seen)).toEqual(['INBOX'])
    expect(labelsOf(h, ids.sent)).toEqual(['SENT'])
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE notify IS NOT NULL`)).toEqual([{ n: 0 }])

    // the count the fill holds equals the server's own for the window (Inbox and Sent, less the old one)
    expect(h.jmapServer.inFolder('inbox').length + h.jmapServer.inFolder('sent').length - 1).toBe(stored.length)
  })

  test('conversations carry the mailbox’s pill, are read and open by the server’s state, and the status says live', async () => {
    const h = jh()
    seed(h)
    await start(h)
    const list = h.inbox.listConversations(h.inbox.listQueueFacts().map((f) => f.id))
    const byName = (name: string) => list.find((c) => c.contactNames.includes(name))
    expect(byName('Dana Smith')).toMatchObject({
      unread: true,
      open: true,
      mailbox: { name: 'harborline', address: ADDRESS },
      mailboxKind: 'jmap',
    })
    expect(byName('Arun Mehta')).toMatchObject({ unread: false, open: true })
    // mail the mailbox sent is read and closed by its sender
    expect(byName('Lane')).toMatchObject({ unread: false, open: false })
    // our own addresses (the mailbox and its whole domain: the aliases info@ and postmaster@) are nobody's contact
    expect(list.flatMap((c) => c.contactNames)).not.toContain('Test')
    const s = status(h)
    expect(s).toMatchObject({
      state: 'live',
      declared: true,
      messages: 3,
      conversations: 3,
      open: 2,
      unreadOpen: 1,
      health: { amber: true },
    })
    // amber only because the server has not yet confirmed the push address (the next test)
    expect(s.health.reasons.join(' ')).toContain('push address')
    expect(s.lastSyncAt).not.toBeNull()
  })

  test('a mail to an alias of the mailbox is the mailbox’s own mail: the alias is not a person on the conversation', async () => {
    const h = jh()
    h.jmapServer.deliver({
      subject: 'To the alias',
      from: 'Dana <dana@example.com>',
      to: 'Info <info@harborline.example>',
      cc: 'postmaster@harborline.example, Ann <ann@example.org>',
      at: T0 - 1000,
    })
    await start(h)
    const people = rows<{ address: string }>(
      h,
      `SELECT i.address FROM participant p JOIN identity i ON i.id = p.identity_id ORDER BY i.address`,
    ).map((r) => r.address)
    expect(people).toEqual(['ann@example.org', 'dana@example.com'])
  })

  test('a window of more than a run’s budget is walked across alarm runs, and what arrived during the walk is picked up by the sync that follows', async () => {
    const h = jh()
    for (let n = 0; n < 160; n += 1) h.jmapServer.deliver({ subject: `m${n}`, at: T0 - (n + 1) * 60_000 })
    await h.jmapRoom.requestJmapSync()
    // the first run only reads the states and starts the fill
    await h.jmapRoom.runAlarm()
    expect(box(h).job).toMatchObject({ kind: 'fill', stage: 'list', position: 0 })
    expect(box(h).cursor).toBeNull()
    expect(status(h).state).toBe('filling')
    // the second walks two pages and stops at its budget of 100 downloads
    await h.jmapRoom.runAlarm()
    // paged by the time of the last message read (the 148th oldest: each page after the first repeats the last message of the one before, which is read again and not downloaded, so three pages cost 148 downloads and stop at the budget), not by a position
    expect(box(h).job).toMatchObject({ stage: 'list', position: 0, after: new Date(T0 - 13 * 60_000).toISOString() })
    expect(box(h).cursor).toBeNull()
    expect(count(h, 'message')).toBe(148)
    // a message already read is archived on the server while the fill is not done: by position every one after it would move up and one would be skipped for good
    h.jmapServer.moveTo(
      present(rows<{ jmap_id: string }>(h, "SELECT jmap_id FROM message WHERE subject = 'm159'")[0]).jmap_id,
      'archive',
    )
    // mail arrives while the fill is not done: it is not in the fill's states, so the sync after the fill finds it
    h.jmapServer.deliver({ subject: 'during the fill', at: T0 })
    h.alarms.length = 0
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(box(h).job).toBeNull()
    expect(box(h).cursor).not.toBeNull()
    expect(count(h, 'message')).toBe(161)
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'during the fill'`)).toEqual([{ n: 1 }])
    // every one of the 160 is held, the one that moved included (its closed state was read), and none was skipped
    expect(rows(h, "SELECT count(*) AS n FROM message WHERE subject LIKE 'm%'")).toEqual([{ n: 160 }])
    expect(rows(h, "SELECT closed_at IS NOT NULL AS closed FROM message WHERE subject = 'm159'")).toEqual([
      { closed: 1 },
    ])
  })

  test('messages received in the same second, more than a page of them, are all read (the paging falls back to the position when time does not advance)', async () => {
    const h = jh()
    for (let n = 0; n < 130; n += 1) h.jmapServer.deliver({ subject: `s${n}`, at: T0 - 60_000 })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(box(h).job).toBeNull()
    expect(rows(h, "SELECT count(*) AS n FROM message WHERE subject LIKE 's%'")).toEqual([{ n: 130 }])
  })

  test('a message too large to read is stored from what the server says of it, not downloaded', async () => {
    const h = jh()
    const id = h.jmapServer.deliver({ subject: 'A very large one', size: 30_000_000, at: T0 - 1000 })
    await start(h)
    expect(h.jmapServer.downloads).not.toContain(id)
    expect(messageOf(h, id)).toMatchObject({ subject: 'A very large one' })
    expect(String(messageOf(h, id)?.body)).toContain('too large')
  })
})

describe('a sync', () => {
  test('mail that arrives is stored unread, in the conversation the server put it in, and rings (the fill did not)', async () => {
    const h = jh()
    seed(h)
    await live(h)
    const first = h.jmapServer.deliver({ subject: 'Fresh', from: 'Kim <kim@example.com>', at: h.now() })
    expect(await hear(h)).toEqual([204])
    expect(labelsOf(h, first)).toEqual(['INBOX', 'UNREAD'])
    // it was put to the notification rule (no device is registered, so it is dropped, but it was owed)
    expect(messageOf(h, first)?.notify).toBe('dropped')
    expect(summary(h, conversationOfMessage(h, first))).toMatchObject({ unread: true, open: true })
    // a reply in the same server thread is the same conversation
    const reply = h.jmapServer.deliver({
      subject: 'Re: Fresh',
      from: 'Kim <kim@example.com>',
      inReplyTo: '<e7@example.com>',
      threadId: h.jmapServer.emails.get(first)?.threadId,
      at: h.now(),
    })
    await hear(h)
    expect(conversationOfMessage(h, reply)).toBe(conversationOfMessage(h, first))
    expect(count(h, 'conversation')).toBe(4)
  })

  test('read on a phone is read in the space, and unread again is unread again, by the server and with its actor on the stamp', async () => {
    const h = jh()
    const ids = seed(h)
    await live(h)
    const id = conversationOfMessage(h, ids.unread)
    expect(summary(h, id)?.unread).toBe(true)
    h.jmapServer.markSeen(ids.unread, true)
    await hear(h)
    expect(summary(h, id)).toMatchObject({ unread: false, open: true, readBy: 'jmap' })
    expect(labelsOf(h, ids.unread)).toEqual(['INBOX'])
    h.jmapServer.markSeen(ids.unread, false)
    await hear(h)
    expect(summary(h, id)).toMatchObject({ unread: true, open: true })
  })

  test('archived in a mail app is Closed in the space; moved back to the Inbox is open again', async () => {
    const h = jh()
    const ids = seed(h)
    await live(h)
    const id = conversationOfMessage(h, ids.seen)
    h.jmapServer.moveTo(ids.seen, 'archive')
    await hear(h)
    expect(summary(h, id)).toMatchObject({ open: false, closedBy: 'jmap' })
    expect(labelsOf(h, ids.seen)).toEqual([])
    h.jmapServer.moveTo(ids.seen, 'inbox')
    await hear(h)
    expect(summary(h, id)).toMatchObject({ open: true })
    // filed in some other folder it is closed as well
    h.jmapServer.folders.push({ id: 'x', name: 'Receipts', role: null as unknown as string })
    const e = present(h.jmapServer.emails.get(ids.seen))
    e.mailboxIds = { x: true }
    h.jmapServer.markSeen(ids.seen, true)
    await hear(h)
    expect(summary(h, id)).toMatchObject({ open: false })
  })

  test('thrown away is kept and counted for nothing; filed as junk later is the same; destroyed for good is kept as trashed', async () => {
    const h = jh()
    const ids = seed(h)
    await live(h)
    const dana = conversationOfMessage(h, ids.unread)
    h.jmapServer.moveTo(ids.unread, 'trash')
    await hear(h)
    expect(labelsOf(h, ids.unread)).toContain('TRASH')
    expect(summary(h, dana)).toMatchObject({ open: false, unread: false })
    expect(messageOf(h, ids.unread)).not.toBeNull()

    const arun = conversationOfMessage(h, ids.seen)
    h.jmapServer.moveTo(ids.seen, 'junk')
    await hear(h)
    expect(labelsOf(h, ids.seen)).toContain('SPAM')
    expect(summary(h, arun)).toMatchObject({ open: false })

    const sentConversation = conversationOfMessage(h, ids.sent)
    h.jmapServer.destroy(ids.sent)
    await hear(h)
    expect(labelsOf(h, ids.sent)).toEqual(['TRASH'])
    expect(messageOf(h, ids.sent)).not.toBeNull()
    expect(summary(h, sentConversation)).toBeDefined()
    // nothing was deleted from the inbox
    expect(count(h, 'message')).toBe(3)
  })

  test('mail the server files as junk is not brought in, and mail it files in Archive on arrival is not either', async () => {
    const h = jh()
    await live(h)
    const junk = h.jmapServer.deliver({ subject: 'Junk', folder: 'junk', at: h.now() })
    const filed = h.jmapServer.deliver({ subject: 'Filed away', folder: 'archive', seen: true, at: h.now() })
    await hear(h)
    expect(messageOf(h, junk)).toBeNull()
    expect(messageOf(h, filed)).toBeNull()
    expect(count(h, 'message')).toBe(0)
  })

  test('a flag is kept with the message and decides nothing', async () => {
    const h = jh()
    const ids = seed(h)
    await live(h)
    const id = conversationOfMessage(h, ids.unread)
    const before = summary(h, id)
    h.jmapServer.flag(ids.unread, true)
    await hear(h)
    expect(labelsOf(h, ids.unread)).toEqual(['INBOX', 'STARRED', 'UNREAD'])
    expect(summary(h, id)).toMatchObject({ unread: before?.unread, open: before?.open })
    h.jmapServer.flag(ids.unread, false)
    await hear(h)
    expect(labelsOf(h, ids.unread)).toEqual(['INBOX', 'UNREAD'])
  })

  test('a message sent from a mail app lands in Sent: it is stored as the mailbox’s own, read and closed', async () => {
    const h = jh()
    const ids = seed(h)
    await live(h)
    const out = h.jmapServer.deliver({
      subject: 'From my phone',
      from: `Test <${ADDRESS}>`,
      to: 'Dana Smith <dana@example.com>',
      folder: 'sent',
      inReplyTo: '<e1@example.com>',
      threadId: h.jmapServer.emails.get(ids.unread)?.threadId,
      at: h.now(),
    })
    await hear(h)
    expect(messageOf(h, out)).toMatchObject({ direction: 'out' })
    expect(labelsOf(h, out)).toEqual(['SENT'])
    // it rings nobody, and the conversation it joined is still unread (it is Dana's message that is unread)
    expect(messageOf(h, out)?.notify).toBeNull()
    expect(summary(h, conversationOfMessage(h, ids.unread))).toMatchObject({ unread: true })
  })

  test('the same sync twice stores nothing twice', async () => {
    const h = jh()
    seed(h)
    await live(h)
    h.jmapServer.deliver({ subject: 'Once', at: h.now() })
    await hear(h)
    const before = [count(h, 'message'), count(h, 'conversation'), count(h, 'participant')]
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    await h.jmapRoom.runJmapDaily()
    await h.drain()
    expect([count(h, 'message'), count(h, 'conversation'), count(h, 'participant')]).toEqual(before)
  })

  test('a sync is cut short at its budget and carries on at the next alarm, the cursor never ahead of what is stored', async () => {
    const h = jh()
    await live(h)
    for (let n = 0; n < 130; n += 1) h.jmapServer.deliver({ subject: `bulk ${n}`, at: h.now() + n })
    await h.jmapRoom.requestJmapSync()
    await h.jmapRoom.runAlarm()
    // changes come 100 at a time and a run stops once it has downloaded its 100
    expect(count(h, 'message')).toBe(100)
    expect(box(h).pushSeq).toBeGreaterThan(box(h).syncedSeq)
    await h.drain()
    expect(count(h, 'message')).toBe(130)
    expect(box(h).pushSeq).toBe(box(h).syncedSeq)
    expect(box(h).cursor?.email).toBe(h.jmapServer.state)
  })
})

describe('a cursor the server cannot answer from', () => {
  test('starts a resync: the window is read again, an open conversation’s state is read again, and what was destroyed meanwhile is kept as trashed', async () => {
    const h = jh()
    const ids = seed(h)
    const toRead = h.jmapServer.deliver({ subject: 'To be read', from: 'Pat <pat@example.com>', at: T0 - 1000 })
    await live(h)
    // while the inbox was not listening: a message is read, one is archived, one open one destroyed, one arrives, and the server forgets its history
    h.jmapServer.markSeen(toRead, true)
    h.jmapServer.moveTo(ids.seen, 'archive')
    h.jmapServer.destroy(ids.unread)
    const fresh = h.jmapServer.deliver({ subject: 'Arrived in the gap', at: h.now() })
    h.jmapServer.forgetHistory()
    await h.jmapRoom.requestJmapSync()
    await h.jmapRoom.runAlarm()
    expect(box(h).job).toMatchObject({ kind: 'resync', stage: 'list' })
    expect(status(h).state).toBe('resyncing')
    await h.drain()
    expect(box(h).job).toBeNull()
    expect(box(h).lastResyncAt).not.toBeNull()
    expect(labelsOf(h, toRead)).toEqual(['INBOX'])
    expect(labelsOf(h, ids.seen)).toEqual([])
    expect(labelsOf(h, ids.unread)).toEqual(['TRASH'])
    expect(labelsOf(h, fresh)).toEqual(['INBOX', 'UNREAD'])
    expect(count(h, 'message')).toBe(5)
    expect(
      rows<{ action: string }>(h, "SELECT action FROM audit WHERE action LIKE 'mailbox.resync%' ORDER BY id").map(
        (r) => r.action,
      ),
    ).toEqual(['mailbox.resync-start', 'mailbox.resync-complete'])
    // and it is live again on a cursor the server can answer from
    expect(status(h).state).toBe('live')
    h.jmapServer.deliver({ subject: 'After', at: h.now() })
    await hear(h)
    expect(rows(h, "SELECT count(*) AS n FROM message WHERE subject = 'After'")).toEqual([{ n: 1 }])
  })

  test('a cursor the server cannot even read is the same', async () => {
    const h = jh()
    seed(h)
    await live(h)
    h.db.run('UPDATE mailbox SET history_id = \'{"email":"garbage","mailbox":"s1"}\' WHERE kind = \'jmap\'')
    await h.jmapRoom.requestJmapSync()
    await h.jmapRoom.runAlarm()
    expect(box(h).job?.kind).toBe('resync')
  })
})

describe('the push subscription', () => {
  test('is made once, at an address that names the mailbox and carries a token, and the server’s verification completes it', async () => {
    const h = jh()
    seed(h)
    await start(h)
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    const sub = present(h.jmapServer.subscriptions[0])
    expect(sub.url).toMatch(
      new RegExp(`^https://inbox-push\\.northfield\\.example/api/jmap/push/${box(h).id}/[0-9a-f]{32}`),
    )
    expect(sub.types.sort()).toEqual(['Email', 'Mailbox'])
    expect(sub.verified).toBe(false)
    expect(status(h).push).toBe('waiting')
    // the server calls with its code: the door answers at once, the alarm completes the subscription
    expect(await deliverPushes(h)).toEqual([204])
    expect(h.jmapAlarms.length).toBeGreaterThan(0)
    await h.drain()
    expect(h.jmapServer.subscriptions[0]?.verified).toBe(true)
    expect(status(h).push).toBe('live')
    // no second one is made by later runs
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(h.jmapServer.subscriptions).toHaveLength(1)
  })

  test('a subscription whose verification never comes is not renewed for ever: after ten minutes it is removed on the server and made again', async () => {
    const h = jh()
    seed(h)
    await start(h)
    const first = present(h.jmapServer.subscriptions[0])
    // the server's verification is never delivered
    h.jmapServer.owed.length = 0
    // inside ten minutes: left alone
    h.tick(5 * 60 * 1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(h.jmapServer.subscriptions.map((s) => s.id)).toEqual([first.id])
    // past ten minutes, on the next run: the old one is gone from the server and a new one is made under a new token
    h.tick(6 * 60 * 1000)
    await h.jmapRoom.runJmapDaily()
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    const second = present(h.jmapServer.subscriptions[0])
    expect(second.id).not.toBe(first.id)
    expect(second.url).not.toBe(first.url)
    expect(status(h).push).toBe('waiting')
    // and this one, verified, is live
    await hear(h)
    expect(status(h).push).toBe('live')
  })

  test('a verification that reaches the door before the server has answered the call that made the subscription still completes it (seen live: the first one was a 404 and never verified)', async () => {
    const h = jh()
    seed(h)
    const statuses: number[] = []
    h.jmapServer.pushesBeforeAnswer = async (url, body) => {
      const res = await h.pushApp.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        h.env,
      )
      statuses.push(res.status)
    }
    await start(h)
    expect(statuses).toEqual([204])
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(h.jmapServer.subscriptions[0]?.verified).toBe(true)
    expect(status(h).push).toBe('live')
    // nothing is left half-kept: the state names the subscription and holds no code
    expect(h.inbox.jmapPushState(box(h).id)).toMatchObject({
      id: h.jmapServer.subscriptions[0]?.id,
      code: null,
      verified: true,
    })
  })

  test('a verification for another subscription that comes while the call is out is not taken for ours', async () => {
    const h = jh()
    await start(h)
    h.jmapServer.pushesBeforeAnswer = null
    // make the state a call in flight, by hand: the id is not known yet
    const state = present(h.inbox.jmapPushState(box(h).id))
    h.inbox.setJmapPushState(box(h).id, { ...state, id: '', verified: false, code: null, early: null })
    expect(
      await h.jmapRoom.receiveJmapPush(box(h).id, state.token, {
        '@type': 'PushVerification',
        pushSubscriptionId: 'other',
        verificationCode: 'x',
      }),
    ).toBe(true)
    expect(h.inbox.jmapPushState(box(h).id)?.early).toEqual({ id: 'other', code: 'x' })
    // the answer names a different id: the early code is not used
    h.inbox.setJmapPushState(box(h).id, {
      ...state,
      id: '',
      verified: false,
      code: null,
      early: { id: 'other', code: 'x' },
    })
    h.tick(11 * 60 * 1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    // the half-made one was given up (nothing to remove by id) and made again; the new one is unverified until the server calls
    expect(h.jmapServer.subscriptions.every((s) => !s.verified || s.id !== 'other')).toBe(true)
    expect(h.inbox.jmapPushState(box(h).id)?.early).toBeNull()
  })

  test('mail that came before the subscription was verified is read in when it is, without waiting for the next change', async () => {
    const h = jh()
    seed(h)
    await start(h)
    const before = count(h, 'message')
    // the subscription is not live yet, so no push is sent for this
    h.jmapServer.deliver({ subject: 'Came while push was not live', at: h.now() })
    expect(h.jmapServer.owed.every((p) => (p.body as { '@type': string })['@type'] === 'PushVerification')).toBe(true)
    await hear(h)
    expect(status(h).push).toBe('live')
    expect(count(h, 'message')).toBe(before + 1)
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'Came while push was not live'`)).toEqual([
      { n: 1 },
    ])
  })

  test('a subscription whose verification never comes is given up on and made again by an alarm of its own, with no push and no other run', async () => {
    const h = jh()
    seed(h)
    await start(h)
    const first = present(h.jmapServer.subscriptions[0])
    h.jmapServer.owed.length = 0 // the verification is lost
    const wake = present(h.jmapAlarms.at(-1))
    // the alarm is asked for just after ten minutes from the making, not before
    expect(wake.getTime()).toBeGreaterThan(
      Date.parse(present(h.inbox.jmapPushState(box(h).id)).madeAt) + 10 * 60 * 1000,
    )
    expect(wake.getTime()).toBeLessThanOrEqual(
      Date.parse(present(h.inbox.jmapPushState(box(h).id)).madeAt) + 10 * 60 * 1000 + 5000,
    )
    h.tick(9 * 60 * 1000)
    await h.drain()
    expect(h.jmapServer.subscriptions.map((s) => s.id)).toEqual([first.id])
    // the time comes: the alarm runs by itself
    h.tick(wake.getTime() - h.now() + 1)
    expect(await h.drain()).toBeGreaterThan(0)
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(present(h.jmapServer.subscriptions[0]).id).not.toBe(first.id)
    // and the new one has its own alarm, ten minutes on
    expect(present(h.jmapAlarms.at(-1)).getTime()).toBeGreaterThan(h.now() + 9 * 60 * 1000)
    // verified, it is live and asks for no more
    await hear(h)
    expect(status(h).push).toBe('live')
  })

  test('a call with the wrong token, for a mailbox that is none, or on any other path is a 404 and changes nothing', async () => {
    const h = jh()
    await live(h)
    const sub = present(h.jmapServer.subscriptions[0])
    const id = box(h).id
    const post = async (path: string, body: unknown = { '@type': 'StateChange', changed: {} }, method = 'POST') =>
      (
        await h.pushApp.request(
          `https://inbox-push.northfield.example${path}`,
          {
            method,
            headers: { 'content-type': 'application/json' },
            body: method === 'GET' ? undefined : JSON.stringify(body),
          },
          h.env,
        )
      ).status
    const token = present(sub.url.split('/').at(-1))
    const pushSeqBefore = box(h).pushSeq
    expect(await post(`/api/jmap/push/${id}/${'0'.repeat(32)}`)).toBe(404)
    expect(await post(`/api/jmap/push/nobody/${token}`)).toBe(404)
    expect(await post(`/api/jmap/push/${id}/${token}x`)).toBe(404)
    expect(await post(`/api/jmap/push/${id}`)).toBe(404)
    expect(await post(`/api/jmap/${id}/${token}`)).toBe(404)
    expect(await post(`/api/jmap/push/${id}/${token}`, undefined, 'GET')).toBe(404)
    expect(await post('/api/gmail/push')).toBe(401) // Gmail's path is still Google's alone
    expect(box(h).pushSeq).toBe(pushSeqBefore)
    // the right one is accepted, with any body, and only asks for a sync
    expect(await post(`/api/jmap/push/${id}/${token}`, 'not an object')).toBe(204)
    expect(box(h).pushSeq).toBe(pushSeqBefore + 1)
  })

  test('a verification that names another subscription completes nothing, and a forged one cannot turn a subscription on', async () => {
    const h = jh()
    await start(h)
    const sub = present(h.jmapServer.subscriptions[0])
    const token = present(sub.url.split('/').at(-1))
    const call = (body: unknown) => h.jmapRoom.receiveJmapPush(box(h).id, token, body)
    h.jmapServer.owed.length = 0 // the server's own verification is not delivered in this test
    expect(
      await call({ '@type': 'PushVerification', pushSubscriptionId: 'someone-elses', verificationCode: 'x' }),
    ).toBe(true)
    expect(h.inbox.jmapPushState(box(h).id)?.code).toBeNull()
    // with the right subscription but a wrong code, the server refuses it: the inbox drops that subscription and makes a new one on the next run
    expect(await call({ '@type': 'PushVerification', pushSubscriptionId: sub.id, verificationCode: 'wrong' })).toBe(
      true,
    )
    await h.drain()
    expect(h.inbox.jmapPushState(box(h).id)).toBeNull()
    expect(h.jmapServer.subscriptions.some((s) => s.id === sub.id)).toBe(false)
    expect(h.jmapServer.subscriptions.every((s) => !s.verified)).toBe(true)
    h.tick(61 * 60 * 1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(h.jmapServer.subscriptions[0]?.id).not.toBe(sub.id)
  })

  test('the daily pass extends it before it lapses, makes it again when the server dropped it, and runs one sync from the cursor', async () => {
    const h = jh()
    await live(h)
    const first = present(h.jmapServer.subscriptions[0])
    const firstId = first.id
    const firstExpires = first.expires
    // five and a half days on: inside the two-day window before it lapses
    h.tick(5 * DAY + 12 * 60 * 60 * 1000)
    await h.jmapRoom.runJmapDaily()
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(h.jmapServer.subscriptions[0]?.expires).toBeGreaterThan(firstExpires)
    // the server restarted and forgot it
    h.jmapServer.dropSubscriptions()
    h.tick(DAY)
    h.jmapServer.deliver({ subject: 'Mail while no push could come', at: h.now() })
    await h.jmapRoom.runJmapDaily()
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(h.jmapServer.subscriptions[0]?.id).not.toBe(firstId)
    // the daily pass was the net: the message is in
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'Mail while no push could come'`)).toEqual([
      { n: 1 },
    ])
    // and the new subscription is verified the same way
    await hear(h)
    expect(status(h).push).toBe('live')
  })

  test('a server that will not take the subscription leaves the mailbox live, says mail arrives by the daily pass, is not asked again by every run, and is asked again the next day', async () => {
    const h = jh()
    h.jmapServer.failNext(400, (_p, methods) => methods.includes('PushSubscription/set'))
    h.jmapServer.deliver({ subject: 'One', at: T0 - 1000 })
    await start(h)
    expect(h.inbox.jmapPushState(box(h).id)).toBeNull()
    expect(status(h)).toMatchObject({ state: 'live', push: 'off' })
    expect(status(h).health.reasons.join(' ')).toContain('push address')
    const asked = () =>
      h.jmapServer.requests.filter((r) => r.calls.some((c) => c.name === 'PushSubscription/set')).length
    expect(asked()).toBe(1)
    // runs in the next half hour do not ask again
    h.tick(30 * 60 * 1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(asked()).toBe(1)
    // the daily pass does, and it is the net for the mail that came meanwhile
    h.jmapServer.deliver({ subject: 'Two', at: h.now() })
    await h.jmapRoom.runJmapDaily()
    expect(rows(h, 'SELECT count(*) AS n FROM message')).toEqual([{ n: 2 }])
    expect(h.jmapServer.subscriptions).toHaveLength(1)
    expect(asked()).toBe(2)
  })
})

describe('a refused key', () => {
  test('is a state: nothing syncs, nothing retries, a push is only a 204, and a sync asked for is refused in words', async () => {
    const h = jh()
    seed(h)
    await live(h)
    h.jmapServer.refuseKey = true
    h.jmapServer.deliver({ subject: 'Unseen', at: h.now() })
    await h.jmapRoom.requestJmapSync()
    h.tick(1000)
    await h.drain()
    const s = status(h)
    expect(s).toMatchObject({ state: 'refused', health: { amber: true } })
    expect(s.refusedAt).not.toBeNull()
    expect(s.health.reasons).toEqual([refusedReason(ADDRESS)])
    const asked = h.jmapServer.requests.length
    // nothing more is asked of the server, however often it is woken: no hammering, no failed-sign-in ban
    for (let n = 0; n < 5; n += 1) {
      h.tick(2 * 60 * 60 * 1000)
      await h.jmapRoom.runAlarm()
      await h.jmapRoom.runJmapDaily()
    }
    expect(h.jmapServer.requests.length).toBe(asked)
    expect(h.inbox.jmapRow(box(h).id)?.refusedAt).not.toBeNull()
    const sync = await h.jmapRoom.requestJmapSync(box(h).id)
    expect(sync).toMatchObject({ ok: false, status: 409 })
    expect((sync as { error: string }).error).toBe(refusedReason(ADDRESS))
    expect(await h.jmapRoom.hasJmapWork()).toBe(false)
    expect(rows(h, `SELECT action FROM audit WHERE action = 'mailbox.refused'`)).toHaveLength(1)
  })

  test('ends with a deploy that changes the key: the next run tries again and the missed mail arrives', async () => {
    const h = jh()
    await live(h)
    h.jmapServer.refuseKey = true
    h.jmapServer.deliver({ subject: 'While refused', at: h.now() })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h).state).toBe('refused')
    // the key is replaced (on the server and in the Worker's secret), and the Worker is deployed
    h.jmapServer.refuseKey = false
    h.jmapServer.key = 'key-rotated'
    h.jmapSecrets.INBOX_JMAP_HARBORLINE_TEST = 'key-rotated'
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h)).toMatchObject({ state: 'live', refusedAt: null })
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'While refused'`)).toEqual([{ n: 1 }])
    expect(rows(h, `SELECT action FROM audit WHERE action = 'mailbox.accepted-again'`)).toHaveLength(1)
  })

  test('the door refusing the service token is a refusal too, said as Access’s', async () => {
    const h = jh()
    await live(h)
    h.jmapServer.refuseAccess = true
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h).state).toBe('refused')
    expect(status(h).lastError).toContain('Access')
  })

  test('a key the Worker does not hold, or a door token it does not hold, declares the mailbox without a credential and asks nothing', async () => {
    const h = jh()
    delete h.jmapSecrets.INBOX_JMAP_HARBORLINE_TEST
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h)).toMatchObject({ state: 'no-credential' })
    expect(h.jmapServer.requests).toHaveLength(0)
    expect(status(h).health.reasons.join(' ')).toContain('no key')
  })
})

describe('a server that cannot be reached', () => {
  test('is said, backed off like Gmail’s, retried, and mends itself; and Gmail beside it never notices', async () => {
    const h = jh()
    h.google.mailbox.add({ id: 'g1', threadId: 'tg1', subject: 'Gmail mail' })
    h.jmapServer.deliver({ subject: 'Before', at: T0 - 1000 })
    expect((await h.connect()).ok).toBe(true)
    // the one alarm a started object has serves both: Gmail's fill and the mail server's
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    await hear(h)
    expect(status(h)).toMatchObject({ state: 'live', push: 'live' })
    h.jmapServer.unreachable = true
    h.jmapServer.deliver({ subject: 'Waiting', at: h.now() })
    h.google.mailbox.add({ id: 'g2', threadId: 'tg2', subject: 'Gmail while the mail server is down' })
    expect((await h.push()).status).toBe(204)
    await h.jmapRoom.requestJmapSync()
    h.tick(1000)
    await h.drain()
    // Gmail's mail came in all the same
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE gmail_id = 'g2'`)).toEqual([{ n: 1 }])
    const s = status(h)
    expect(s).toMatchObject({ state: 'unreachable', health: { amber: true } })
    expect(s.lastError).toContain('could not be reached')
    expect(box(h).retryCount).toBe(1)
    const firstTrouble = status(h).lastErrorAt
    expect(firstTrouble).not.toBeNull()
    // the next try waits the Gmail backoff, and a longer outage waits longer
    const next = present(h.jmapAlarms.at(-1))
    expect(next.getTime() - h.now()).toBeGreaterThanOrEqual(backoffMs(1) - 5000)
    h.tick(backoffMs(1) + 1000)
    await h.drain()
    expect(box(h).retryCount).toBe(2)
    // the card says "not answering since" the time trouble BEGAN, not the time of the latest try
    expect(status(h).lastErrorAt).toBe(firstTrouble)
    // back up: it catches up and clears
    h.jmapServer.unreachable = false
    h.tick(backoffMs(2) + 1000)
    await h.drain()
    expect(status(h)).toMatchObject({ state: 'live', lastError: null })
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'Waiting'`)).toEqual([{ n: 1 }])
  })

  test('an error the server answers is recorded with its words and backed off, not taken for a refusal', async () => {
    const h = jh()
    await live(h)
    h.jmapServer.failNext(502)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h).state).toBe('unreachable')
    expect(status(h).lastError).toContain('502')
    expect(status(h).refusedAt).toBeNull()
  })
})

describe('a declaration', () => {
  test('a mailbox taken out is kept with its mail, not synced, and says so; declared again it carries on', async () => {
    const h = jh()
    seed(h)
    await live(h)
    const asked = h.jmapServer.requests.length
    const declared = h.jmapDeclared.splice(0)
    h.jmapServer.deliver({ subject: 'Not for us now', at: h.now() })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    await h.jmapRoom.runJmapDaily()
    expect(h.jmapServer.requests.length).toBe(asked)
    expect(count(h, 'message')).toBe(3)
    expect(status(h)).toMatchObject({ state: 'undeclared', declared: false, health: { amber: true } })
    expect(status(h).health.reasons.join(' ')).toContain('no longer declared')
    expect((await h.jmapRoom.requestJmapSync(box(h).id)) as { ok: boolean }).toMatchObject({ ok: false })
    // declared again: nothing was lost, and the mail missed meanwhile arrives
    h.jmapDeclared.push(...declared)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(status(h)).toMatchObject({ state: 'live', declared: true })
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE subject = 'Not for us now'`)).toEqual([{ n: 1 }])
  })

  test('a mailbox is declared under a new name: the pill changes, the mail stays', async () => {
    const h = jh()
    seed(h)
    await live(h)
    present(h.jmapDeclared[0]).name = 'Harborline test'
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(box(h).name).toBe('Harborline test')
    expect(count(h, 'message')).toBe(3)
  })

  test('with nothing declared the room does nothing at all, and Gmail’s alarm is exactly what it was', async () => {
    const h = harness()
    expect(await h.jmapRoom.hasJmapWork()).toBe(false)
    h.google.mailbox.add({ id: 'g1', threadId: 'tg1', subject: 'Gmail mail' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    expect(h.jmapServer.requests).toHaveLength(0)
    expect(h.inbox.jmapRows()).toEqual([])
    expect(h.jmapRoom.jmapMailboxes()).toEqual([])
  })
})
