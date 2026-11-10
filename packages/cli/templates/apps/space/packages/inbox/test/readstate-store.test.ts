import { describe, expect, test } from 'bun:test'
import type { ParsedMessage } from '../src/gmail/types'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { everyConversation, harness } from '../test-support/harness'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Step 3 at the two lowest seams that carry it: the migration that adds the read
 * and closed stamps (and backfills them for what a deployed store already holds),
 * and the store's rules for what arrives and what a label change leaves behind.
 * The behaviour as a person meets it is test/gmail-readstate.test.ts.
 */

const TESSA = 'tessa@northfield.example'

describe('the read and closed stamps (migration 3)', () => {
  /** A store as step 2 left it, holding mail and a hand-sent message, then brought forward. */
  function stepTwoStore() {
    const { db, sql } = memoryDatabase()
    sql.exec(`CREATE TABLE inbox_meta ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const migration of INBOX_MIGRATIONS.slice(0, 3)) sql.exec(migration)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 3)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('mb', 'gmail', 'tessa@northfield.example', 't', 'x')`,
    )
    const gmail = (id: string, labels: string[]) =>
      db.run(
        `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, gmail_id, labels)
         VALUES (?, 'i1', 'in', 'sent', 'b', '2026-10-20T00:00:00Z', 'gmail', 't', 'gmail', 'mb', ?, ?)`,
        [id, id, JSON.stringify(labels)],
      )
    gmail('unread-inbox', ['INBOX', 'UNREAD'])
    gmail('read-inbox', ['INBOX'])
    gmail('read-archived', [])
    gmail('unread-archived', ['UNREAD'])
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, sent_at, sent_by)
       VALUES ('by-hand', 'i1', 'out', 'manual-sent', 'b', '2026-10-19T00:00:00Z', 'outbox', 't', 'x', '2026-10-19T10:00:00Z', 'tessa@northfield.example')`,
    )
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by)
       VALUES ('a-draft', 'i1', 'out', 'draft', 'b', 't', 'x', 't', 'x')`,
    )
    expect(migrate(sql)).toBe(INBOX_VERSION)
    return db
  }

  const stamps = (db: ReturnType<typeof stepTwoStore>, id: string) =>
    db.query(`SELECT read_at, read_by, closed_at, closed_by FROM message WHERE id = ?`).get(id)

  test('a message already held is stamped as Gmail has it: unread has no read stamp, in the Inbox has no closed stamp', () => {
    const db = stepTwoStore()
    const at = '2026-10-20T00:00:00Z'
    expect(stamps(db, 'unread-inbox')).toEqual({ read_at: null, read_by: null, closed_at: null, closed_by: null })
    expect(stamps(db, 'read-inbox')).toEqual({ read_at: at, read_by: 'gmail', closed_at: null, closed_by: null })
    expect(stamps(db, 'read-archived')).toEqual({ read_at: at, read_by: 'gmail', closed_at: at, closed_by: 'gmail' })
    expect(stamps(db, 'unread-archived')).toEqual({ read_at: null, read_by: null, closed_at: at, closed_by: 'gmail' })
  })

  test('a message marked sent by hand is read and closed by whoever sent it, when it was sent; a draft has neither', () => {
    const db = stepTwoStore()
    const at = '2026-10-19T10:00:00Z'
    expect(stamps(db, 'by-hand')).toEqual({
      read_at: at,
      read_by: TESSA,
      closed_at: at,
      closed_by: TESSA,
    })
    expect(stamps(db, 'a-draft')).toEqual({ read_at: null, read_by: null, closed_at: null, closed_by: null })
  })
})

function message(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    gmailId: 'g1',
    threadId: 't1',
    rfcMessageId: '<g1@example.com>',
    inReplyTo: null,
    from: { name: 'Dana Smith', address: 'dana@example.com' },
    to: [{ name: 'Tessa Marlow', address: TESSA }],
    cc: [],
    fromHeader: 'Dana Smith <dana@example.com>',
    toHeader: 'Tessa Marlow <tessa@northfield.example>',
    ccHeader: '',
    replyToHeader: '',
    subject: 'Revised quote',
    snippet: 'Can you send it?',
    body: 'Hi Tessa, can you send it?',
    bodyTruncated: false,
    attachments: [],
    labels: ['INBOX', 'UNREAD'],
    receivedAt: '2026-10-20T12:00:00.000Z',
    senderDate: '2026-10-20T11:59:50.000Z',
    listUnsubscribe: false,
    ...over,
  }
}

function connected() {
  const h = harness()
  const row = h.inbox.connectMailbox(
    { address: TESSA, refreshToken: 'refresh-secret', scopes: ['gmail.modify'], historyId: '500', query: 'q' },
    TESSA,
  )
  return { h, row }
}
type C = ReturnType<typeof connected>

const ingest = (c: C, ...messages: ParsedMessage[]) =>
  c.h.inbox.applyHistoryPage({ mailboxId: c.row.id, messages, deltas: [], cursor: null, notify: true })

/** The conversation for a Gmail thread, with its derived state. */
const summary = (c: C, gmailThreadId = 't1') => {
  const row = c.h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(gmailThreadId) as { id: string }
  const found = everyConversation(c.h.inbox).find((s) => s.id === row.id)
  if (!found) throw new Error('no conversation')
  return found
}

const stampsOf = (c: C, gmailId: string) =>
  c.h.db.query(`SELECT read_at, read_by, closed_at, closed_by FROM message WHERE gmail_id = ?`).get(gmailId)

describe('read and closed stamps on what arrives', () => {
  test('a message that arrives unread and in the Inbox is open and unread, with no stamp', () => {
    const c = connected()
    ingest(c, message())
    expect(stampsOf(c, 'g1')).toEqual({ read_at: null, read_by: null, closed_at: null, closed_by: null })
    expect(summary(c)).toMatchObject({ unread: true, open: true, readBy: null, closedBy: null })
  })

  test('one that arrives already read, or already out of the Inbox, is stamped by Gmail when the inbox learned of it', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'seen', threadId: 'ts', labels: ['INBOX'] }))
    ingest(c, message({ gmailId: 'filed', threadId: 'tf', labels: ['SENT'], from: { name: 'Tessa', address: TESSA } }))
    const at = '2026-10-20T12:00:00.000Z'
    expect(stampsOf(c, 'seen')).toEqual({ read_at: at, read_by: 'gmail', closed_at: null, closed_by: null })
    expect(stampsOf(c, 'filed')).toEqual({ read_at: at, read_by: 'gmail', closed_at: at, closed_by: 'gmail' })
    expect(summary(c, 'ts')).toMatchObject({ unread: false, open: true, readBy: 'gmail' })
    expect(summary(c, 'tf')).toMatchObject({ unread: false, open: false, closedBy: 'gmail' })
  })

  test('a conversation is unread while ANY message in it is, and open while ANY message is in the Inbox', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'old', labels: [] }), message({ gmailId: 'new', labels: ['INBOX', 'UNREAD'] }))
    expect(summary(c)).toMatchObject({ unread: true, open: true })
    c.h.inbox.applyHistoryPage({
      mailboxId: c.row.id,
      messages: [],
      deltas: [{ gmailId: 'new', add: [], remove: ['UNREAD', 'INBOX'] }],
      cursor: null,
      notify: true,
    })
    expect(summary(c)).toMatchObject({ unread: false, open: false })
  })

  test('writing the labels a message already has changes nothing, not even its updated time', () => {
    const c = connected()
    ingest(c, message())
    const before = c.h.db.query(`SELECT * FROM message`).get()
    c.h.tick()
    ingest(c, message())
    c.h.inbox.applyHistoryPage({
      mailboxId: c.row.id,
      messages: [],
      deltas: [{ gmailId: 'g1', add: ['UNREAD'], remove: [] }],
      cursor: null,
      notify: true,
    })
    expect(c.h.db.query(`SELECT * FROM message`).get()).toEqual(before)
  })

  test('a person’s stamp survives Gmail writing the same labels, and the newest stamp is the one shown', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'a', labels: ['INBOX'] }), message({ gmailId: 'b', labels: ['INBOX', 'UNREAD'] }))
    c.h.tick()
    c.h.inbox.applyConversationChange(summary(c).id, 'read', TESSA)
    expect(summary(c)).toMatchObject({ unread: false, readBy: TESSA })
    // Gmail says the same thing again, from a re-read of the thread.
    c.h.tick()
    ingest(c, message({ gmailId: 'b', labels: ['INBOX'] }))
    expect(stampsOf(c, 'b')).toMatchObject({ read_by: TESSA })
    expect(summary(c)).toMatchObject({ readBy: TESSA })
  })

  test('the envelope of the newest inbound message is what Bulk is judged from', () => {
    const c = connected()
    ingest(
      c,
      message({
        gmailId: 'first',
        labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        listUnsubscribe: true,
        receivedAt: '2026-10-20T08:00:00.000Z',
      }),
      message({ gmailId: 'later', labels: ['INBOX', 'CATEGORY_PERSONAL'], receivedAt: '2026-10-20T09:00:00.000Z' }),
    )
    expect(summary(c).newestInbound).toEqual({
      labels: ['CATEGORY_PERSONAL', 'INBOX'],
      listUnsubscribe: false,
      automated: false,
    })
  })

  test('a conversation nothing has come in on has no envelope', () => {
    const c = connected()
    ingest(c, message({ gmailId: 's', labels: ['SENT'], from: { name: 'Tessa', address: TESSA } }))
    expect(summary(c).newestInbound).toBeNull()
  })
})

const position = (c: C, id: string): number =>
  Number((c.h.db.query(`SELECT max(rowid) AS n FROM message WHERE conversation_id = ?`).get(id) as { n: number }).n)

describe('planning and applying a change', () => {
  test('a conversation that is not held is a 404 from both, and nothing is written', () => {
    const c = connected()
    expect(c.h.inbox.planConversationChange('ghost', 'read', 1)).toMatchObject({ ok: false, status: 404 })
    expect(c.h.inbox.applyConversationChange('ghost', 'close', TESSA)).toMatchObject({ ok: false, status: 404 })
    expect(c.h.inbox.listAudit(10).some((a) => a.action.startsWith('conversation.'))).toBe(false)
  })

  test('the plan names the Gmail thread and whether anything is needed', () => {
    const c = connected()
    ingest(c, message())
    const id = summary(c).id
    const through = position(c, id)
    expect(c.h.inbox.planConversationChange(id, 'read', through)).toEqual({
      ok: true,
      value: { threadId: 't1', needed: true },
    })
    expect(c.h.inbox.planConversationChange(id, 'close', through)).toEqual({
      ok: true,
      value: { threadId: 't1', needed: true },
    })
    expect(c.h.inbox.planConversationChange(id, 'reopen', null)).toEqual({
      ok: true,
      value: { threadId: 't1', needed: false },
    })
    c.h.inbox.applyConversationChange(id, 'read', TESSA)
    expect(c.h.inbox.planConversationChange(id, 'read', through)).toEqual({
      ok: true,
      value: { threadId: 't1', needed: false },
    })
  })

  test('it refuses what the person was not shown: inbound beyond `through` is a 409, and no `through` is a 422', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'a' }))
    const id = summary(c).id
    const shown = position(c, id)
    ingest(c, message({ gmailId: 'b', receivedAt: '2026-10-20T13:00:00.000Z' }))
    for (const change of ['read', 'close'] as const) {
      expect(c.h.inbox.planConversationChange(id, change, shown), change).toMatchObject({ ok: false, status: 409 })
      expect(c.h.inbox.planConversationChange(id, change, position(c, id)), change).toMatchObject({ ok: true })
      expect(c.h.inbox.planConversationChange(id, change, null), change).toMatchObject({ ok: false, status: 422 })
    }
    expect(c.h.inbox.planConversationChange(id, 'reopen', null)).toMatchObject({ ok: true })
  })

  test('mail the person sent, a draft, and mail in the trash beyond `through` do not make it stale', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'a' }))
    const id = summary(c).id
    const shown = position(c, id)
    ingest(c, message({ gmailId: 'mine', labels: ['SENT'], from: { name: 'Tessa', address: TESSA } }))
    c.h.inbox.createDraft({ conversationId: id, body: 'Thanks', address: 'dana@example.com' }, TESSA)
    ingest(c, message({ gmailId: 'bin', labels: ['INBOX', 'TRASH'] }))
    expect(c.h.inbox.planConversationChange(id, 'close', shown)).toMatchObject({ ok: true })
  })

  test('an email conversation with no thread id is refused, and a manual one needs neither', () => {
    const c = connected()
    ingest(c, message())
    const id = summary(c).id
    c.h.db.run(`UPDATE conversation SET gmail_thread_id = NULL WHERE id = ?`, [id])
    expect(c.h.inbox.planConversationChange(id, 'close', 1)).toMatchObject({ ok: false, status: 409 })
  })

  test('a reopen needs a message that can go back: all in the trash or spam is a 409', () => {
    const c = connected()
    ingest(c, message(), message({ gmailId: 'g2' }))
    c.h.db.run(`UPDATE message SET labels = '["TRASH"]' WHERE gmail_id = 'g1'`)
    c.h.db.run(`UPDATE message SET labels = '["SPAM"]' WHERE gmail_id = 'g2'`)
    const id = (c.h.db.query(`SELECT id FROM conversation`).get() as { id: string }).id
    expect(c.h.inbox.planConversationChange(id, 'reopen', null)).toMatchObject({ ok: false, status: 409 })
  })

  test('applying a change that is already true writes nothing: no stamp moves and no audit entry is made', () => {
    const c = connected()
    ingest(c, message())
    const id = summary(c).id
    c.h.inbox.applyConversationChange(id, 'read', TESSA)
    const before = JSON.stringify(c.h.db.query(`SELECT * FROM message`).all())
    const audits = c.h.inbox.listAudit(100).length
    c.h.tick()
    c.h.inbox.applyConversationChange(id, 'read', 'agent:other')
    expect(JSON.stringify(c.h.db.query(`SELECT * FROM message`).all())).toBe(before)
    expect(c.h.inbox.listAudit(100)).toHaveLength(audits)
  })

  test('reopen puts INBOX on what is in play and not on a message in the trash', () => {
    const c = connected()
    ingest(c, message({ gmailId: 'a' }), message({ gmailId: 'bin' }))
    c.h.db.run(`UPDATE message SET labels = '[]' WHERE gmail_id = 'a'`)
    c.h.db.run(`UPDATE message SET labels = '["TRASH"]' WHERE gmail_id = 'bin'`)
    const id = summary(c).id
    c.h.inbox.applyConversationChange(id, 'reopen', TESSA)
    const labels = (g: string) =>
      JSON.parse((c.h.db.query(`SELECT labels FROM message WHERE gmail_id = ?`).get(g) as { labels: string }).labels)
    expect(labels('a')).toContain('INBOX')
    expect(labels('bin')).not.toContain('INBOX')
  })
})

describe('the queue facts', () => {
  test('are the same state and envelope the rows carry, for every conversation, newest first', () => {
    const c = connected()
    ingest(
      c,
      message({ gmailId: 'a', threadId: 'ta', receivedAt: '2026-10-20T08:00:00.000Z' }),
      message({
        gmailId: 'b',
        threadId: 'tb',
        labels: ['CATEGORY_PROMOTIONS'],
        receivedAt: '2026-10-20T09:00:00.000Z',
      }),
      message({ gmailId: 'c', threadId: 'tc', labels: ['SENT'], from: { name: 'Tessa', address: TESSA } }),
    )
    const facts = c.h.inbox.listQueueFacts()
    const rows = everyConversation(c.h.inbox)
    expect(facts.map((f) => f.id)).toEqual(rows.map((r) => r.id))
    for (const [n, f] of facts.entries()) {
      expect(f).toEqual(
        expect.objectContaining({
          id: rows[n]?.id,
          unread: rows[n]?.unread,
          open: rows[n]?.open,
          drafts: rows[n]?.drafts,
          newestInbound: rows[n]?.newestInbound,
          lastActivityAt: rows[n]?.lastActivityAt,
        }),
      )
    }
  })

  test('listConversations takes any number of ids, past what a query could bind', () => {
    const c = connected()
    const many = Array.from({ length: 150 }, (_, n) => message({ gmailId: `g${n}`, threadId: `t${n}` }))
    ingest(c, ...many)
    const ids = c.h.inbox.listQueueFacts().map((f) => f.id)
    expect(ids).toHaveLength(150)
    expect(c.h.inbox.listConversations(ids)).toHaveLength(150)
    expect(c.h.inbox.listConversations([])).toEqual([])
    const one = ids[3] as string
    expect(c.h.inbox.listConversations([one]).map((r) => r.id)).toEqual([one])
  })

  test('mail in the trash or spam takes no part in a conversation being read or open', () => {
    const c = connected()
    ingest(
      c,
      message({ gmailId: 'live', labels: ['INBOX'] }),
      message({ gmailId: 'bin', labels: ['INBOX', 'UNREAD', 'TRASH'] }),
    )
    expect(summary(c)).toMatchObject({ unread: false, open: true })
    c.h.db.run(`UPDATE message SET labels = '["INBOX","SPAM"]' WHERE gmail_id = 'live'`)
    expect(summary(c)).toMatchObject({ unread: false, open: false })
  })
})
