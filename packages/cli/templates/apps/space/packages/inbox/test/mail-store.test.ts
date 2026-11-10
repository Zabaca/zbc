import { describe, expect, test } from 'bun:test'
import type { ParsedMessage } from '../src/gmail/types'
import type { SyncJob } from '../src/store/mail'
import { count, everyConversation, firstGmail, firstGmailStatus, harness } from '../test-support/harness'

/**
 * The store's Gmail half over a real SQLite: what a message from Gmail becomes,
 * that ingesting is an upsert, what is kept out, how the cursor and the jobs move,
 * and that the token is held in one place and shown nowhere. Every assertion is
 * through the store's own methods or a row count.
 */

const TESSA = 'tessa@northfield.example'

function message(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    gmailId: 'g1',
    threadId: 't1',
    rfcMessageId: '<g1@example.com>',
    inReplyTo: null,
    from: { name: 'Dana Smith', address: 'Dana@Example.com' },
    to: [{ name: 'Tessa Marlow', address: TESSA }],
    cc: [],
    fromHeader: 'Dana Smith <Dana@Example.com>',
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

const fillJob = (over: Partial<SyncJob> = {}): SyncJob => ({
  kind: 'fill',
  query: '(in:inbox OR in:sent) after:1',
  cursorAfter: '500',
  stage: 'list',
  pageToken: null,
  threads: null,
  ...over,
})

/** A connected mailbox, as a successful sign-in leaves it. */
function connected() {
  const h = harness()
  const row = h.inbox.connectMailbox(
    { address: TESSA, refreshToken: 'refresh-secret', scopes: ['gmail.modify'], historyId: '500', query: 'q' },
    TESSA,
  )
  return { h, row }
}

/** Ingest through the page method, as a sync does, and answer the counts. */
const ingest = (c: ReturnType<typeof connected>, ...messages: ParsedMessage[]) =>
  c.h.inbox.applyHistoryPage({ mailboxId: c.row.id, messages, deltas: [], cursor: null, notify: true }).counts

const thread = (c: ReturnType<typeof connected>, gmailThreadId = 't1') => {
  const row = c.h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(gmailThreadId) as { id: string }
  const detail = c.h.inbox.getConversation(row.id)
  if (!detail.ok) throw new Error('no conversation')
  return detail.value
}

describe('the mailbox and its token', () => {
  test('connecting stores the row, starts a fill, and the status has no field that could hold the token', () => {
    const { h, row } = connected()
    expect(row).toMatchObject({
      address: TESSA,
      refreshToken: 'refresh-secret',
      historyId: null,
      job: { kind: 'fill', cursorAfter: '500', stage: 'list' },
    })
    const status = firstGmailStatus(h.inbox)
    expect(status).toMatchObject({ connected: true, state: 'filling', messages: 0, conversations: 0 })
    expect(JSON.stringify(status)).not.toContain('refresh-secret')
    expect(Object.keys(status ?? {})).not.toContain('refreshToken')
  })

  test('no audit entry ever holds the token, on connect, ingest or disconnect', () => {
    const c = connected()
    ingest(c, message())
    c.h.inbox.disconnectMailbox(c.row.id, TESSA, true)
    const audit = JSON.stringify(c.h.inbox.listAudit(500))
    expect(audit).toContain('mailbox.connect')
    expect(audit).toContain('mailbox.disconnect')
    expect(audit).not.toContain('refresh-secret')
  })

  test('a disconnect forgets the token and the work but keeps the cursor and the mail', () => {
    const c = connected()
    ingest(c, message())
    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'fill',
      cursorAfter: '500',
      messages: [],
      labels: [],
      job: null,
    })
    c.h.inbox.disconnectMailbox(c.row.id, TESSA, true)
    const row = firstGmail(c.h.inbox)
    expect(row).toMatchObject({ refreshToken: null, watchExpiry: null, job: null, historyId: '500' })
    expect(firstGmailStatus(c.h.inbox)).toMatchObject({ connected: false, state: 'disconnected', messages: 1 })
    expect(count(c.h, 'message')).toBe(1)
  })

  test('a reconnect keeps a cursor it has, and is owed a catch-up instead of a second fill', () => {
    const c = connected()
    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'fill',
      cursorAfter: '500',
      messages: [],
      labels: [],
      job: null,
    })
    c.h.inbox.disconnectMailbox(c.row.id, TESSA, true)
    const again = c.h.inbox.connectMailbox(
      { address: TESSA, refreshToken: 'refresh-2', scopes: ['x'], historyId: '999', query: 'q' },
      TESSA,
    )
    expect(again).toMatchObject({ id: c.row.id, refreshToken: 'refresh-2', historyId: '500', job: null })
    expect(again.pushSeq).toBeGreaterThan(again.syncedSeq)
    expect(count(c.h, 'mailbox')).toBe(1)
  })

  test('a reconnect with no cursor (it never finished filling) starts the fill again', () => {
    const c = connected()
    c.h.inbox.disconnectMailbox(c.row.id, TESSA, true)
    const again = c.h.inbox.connectMailbox(
      { address: TESSA, refreshToken: 'refresh-2', scopes: [], historyId: '700', query: 'q2' },
      TESSA,
    )
    expect(again.job).toMatchObject({ kind: 'fill', cursorAfter: '700', query: 'q2' })
  })
})

describe('a Gmail message becoming a row', () => {
  test('an inbound message: a contact named by the header, a conversation on the mailbox, labels kept', () => {
    const c = connected()
    expect(ingest(c, message())).toEqual({ stored: 1, existing: 0, skipped: 0 })
    const detail = thread(c)
    expect(detail.kind).toBe('email')
    expect(detail.contacts.map((x) => x.name)).toEqual(['Dana Smith'])
    expect(detail.addresses.map((a) => a.address)).toEqual(['dana@example.com'])
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]).toMatchObject({
      direction: 'in',
      status: 'sent',
      subject: 'Revised quote',
      body: 'Hi Tessa, can you send it?',
      gmailId: 'g1',
      from: 'Dana Smith <Dana@Example.com>',
      to: 'Tessa Marlow <tessa@northfield.example>',
      address: 'dana@example.com',
      labels: ['INBOX', 'UNREAD'],
      sentAt: '2026-10-20T12:00:00.000Z',
      createdBy: 'gmail',
    })
    expect(detail.gmailUrl).toBe('https://mail.google.com/mail/?authuser=tessa%40northfield.example#all/t1')
    const rows = everyConversation(c.h.inbox)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      contactNames: ['Dana Smith'],
      kind: 'email',
      subject: 'Revised quote',
      lastActivityAt: '2026-10-20T12:00:00.000Z',
    })
  })

  test('our own address is on no conversation as a person, and every other address becomes a contact once', () => {
    const c = connected()
    ingest(c, message({ cc: [{ name: 'Priya', address: 'priya@example.net' }] }))
    ingest(c, message({ gmailId: 'g2', from: { name: 'Dana S.', address: 'dana@example.com' }, cc: [] }))
    const detail = thread(c)
    expect(detail.addresses.map((a) => a.address)).toEqual(['dana@example.com', 'priya@example.net'])
    expect(count(c.h, 'contact')).toBe(2)
    expect(detail.contacts.map((x) => x.name)).toEqual(['Dana Smith', 'Priya'])
  })

  test('a message we sent is to its first recipient, and it makes the conversation closed in Gmail terms by labels alone', () => {
    const c = connected()
    ingest(
      c,
      message({
        gmailId: 'g9',
        from: { name: 'Tessa Marlow', address: TESSA },
        to: [
          { name: 'Dana Smith', address: 'dana@example.com' },
          { name: '', address: 'bob@example.org' },
        ],
        labels: ['SENT'],
      }),
    )
    const detail = thread(c)
    expect(detail.messages[0]).toMatchObject({ direction: 'out', address: 'dana@example.com', labels: ['SENT'] })
    expect(detail.addresses.map((a) => a.address)).toEqual(['dana@example.com', 'bob@example.org'])
  })

  test('a note to oneself has the one address it has', () => {
    const c = connected()
    ingest(
      c,
      message({ from: { name: '', address: TESSA }, to: [{ name: '', address: TESSA }], labels: ['SENT', 'INBOX'] }),
    )
    expect(thread(c).addresses.map((a) => a.address)).toEqual([TESSA])
  })

  test('addresses that are not email addresses are dropped, and a message with none still files', () => {
    const c = connected()
    ingest(c, message({ from: { name: '', address: 'not-an-address' }, to: [{ name: '', address: 'undisclosed' }] }))
    expect(count(c.h, 'message')).toBe(1)
  })

  test('an empty body falls back to the snippet, so a message is never blank', () => {
    const c = connected()
    ingest(c, message({ body: '', snippet: 'Just the snippet' }))
    expect(thread(c).messages[0]?.body).toBe('Just the snippet')
  })

  test('attachments are names and sizes, and a truncated body says so', () => {
    const c = connected()
    ingest(c, message({ attachments: [{ name: 'Quote.pdf', size: 40213 }], bodyTruncated: true }))
    expect(thread(c).messages[0]).toMatchObject({
      attachments: [{ name: 'Quote.pdf', size: 40213 }],
      bodyTruncated: true,
    })
  })

  test('a reply joins the conversation, which then sorts by its newest message', () => {
    const c = connected()
    ingest(c, message())
    ingest(c, message({ gmailId: 'g2', receivedAt: '2026-10-21T09:00:00.000Z', labels: ['INBOX', 'UNREAD'] }))
    ingest(c, message({ gmailId: 'g3', threadId: 't2', receivedAt: '2026-10-20T20:00:00.000Z' }))
    expect(thread(c).messages.map((m) => m.gmailId)).toEqual(['g1', 'g2'])
    const rows = everyConversation(c.h.inbox)
    expect(rows.map((r) => r.lastActivityAt)).toEqual(['2026-10-21T09:00:00.000Z', '2026-10-20T20:00:00.000Z'])
  })
})

describe('an ingest is an upsert', () => {
  test('the same message twice is stored once, and takes only Gmail’s current labels', () => {
    const c = connected()
    expect(ingest(c, message()).stored).toBe(1)
    c.h.tick()
    expect(ingest(c, message({ labels: ['INBOX'], body: 'changed body', subject: 'changed' }))).toEqual({
      stored: 0,
      existing: 1,
      skipped: 0,
    })
    expect(count(c.h, 'message')).toBe(1)
    expect(count(c.h, 'conversation')).toBe(1)
    expect(thread(c).messages[0]).toMatchObject({
      labels: ['INBOX'],
      body: 'Hi Tessa, can you send it?',
      subject: 'Revised quote',
    })
  })

  test('there is one mailbox per address, so a second row for it cannot split the same mail in two', () => {
    const c = connected()
    expect(() =>
      c.h.db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'gmail', ?, 't', 'x')`,
        [TESSA],
      ),
    ).toThrow(/UNIQUE/)
  })
})

describe('what is kept out', () => {
  test.each([
    ['spam', ['SPAM', 'INBOX']],
    ['trash', ['TRASH']],
    ['an unfinished draft', ['DRAFT']],
    ['mail filed away on arrival, in no stored conversation', ['CATEGORY_UPDATES']],
  ])('%s is skipped and leaves no contact behind', (_name, labels) => {
    const c = connected()
    expect(ingest(c, message({ labels }))).toEqual({ stored: 0, existing: 0, skipped: 1 })
    expect(count(c.h, 'message')).toBe(0)
    expect(count(c.h, 'conversation')).toBe(0)
    expect(count(c.h, 'contact')).toBe(0)
  })

  test('mail out of the Inbox is stored when it belongs to a conversation already held', () => {
    const c = connected()
    ingest(c, message())
    expect(ingest(c, message({ gmailId: 'g2', labels: [] })).stored).toBe(1)
    expect(thread(c).messages).toHaveLength(2)
  })

  test('but never a spam reply in a held conversation', () => {
    const c = connected()
    ingest(c, message())
    expect(ingest(c, message({ gmailId: 'g2', labels: ['SPAM'] })).skipped).toBe(1)
  })
})

describe('manual and Gmail conversations stay apart', () => {
  test('an email the Outbox had marked sent never files into a Gmail thread with the same person', () => {
    // Mark sent is for texts and DMs since step 4, so the one way a message without a Gmail id
    // reaches an email address now is the Outbox carry, which files what the Outbox had sent.
    const c = connected()
    ingest(c, message())
    c.h.tick()
    const report = c.h.inbox.importOutbox(
      [{ id: 'o-1', to: 'Dana', address: 'dana@example.com', body: 'by hand', sentAt: '2026-10-20T12:30:00Z' }],
      TESSA,
    )
    expect(report.created.manualSent).toBe(1)
    const filed = c.h.db.query(`SELECT conversation_id FROM message WHERE source_ref = 'outbox:o-1'`).get() as {
      conversation_id: string
    }
    expect(count(c.h, 'conversation')).toBe(2)
    const manual = c.h.db.query(`SELECT mailbox_id FROM conversation WHERE mailbox_id IS NULL`).all()
    expect(manual).toHaveLength(1)
    expect(thread(c).messages).toHaveLength(1)
    expect(c.h.inbox.getConversation(filed.conversation_id)).toMatchObject({ ok: true, value: { gmailUrl: null } })
  })

  test('a Gmail thread is found only by its mailbox and thread id, so the same id twice is one conversation', () => {
    const c = connected()
    ingest(c, message(), message({ gmailId: 'g2' }))
    expect(count(c.h, 'conversation')).toBe(1)
  })
})

describe('history pages and label changes', () => {
  test('a label delta changes a held message, in order, and a message not held is ignored', () => {
    const c = connected()
    ingest(c, message())
    const applied = c.h.inbox.applyHistoryPage({
      mailboxId: c.row.id,
      messages: [],
      deltas: [
        { gmailId: 'g1', add: [], remove: ['UNREAD'] },
        { gmailId: 'g1', add: ['STARRED'], remove: [] },
        { gmailId: 'nobody', add: ['INBOX'], remove: [] },
      ],
      cursor: '501',
      notify: true,
    })
    expect(applied.labelsChanged).toBe(2)
    expect(thread(c).messages[0]?.labels).toEqual(['INBOX', 'STARRED'])
    expect(firstGmail(c.h.inbox)?.historyId).toBe('501')
  })

  test('a delta that changes nothing counts for nothing, so an echo is a no-op', () => {
    const c = connected()
    ingest(c, message())
    const applied = c.h.inbox.applyHistoryPage({
      mailboxId: c.row.id,
      messages: [],
      deltas: [{ gmailId: 'g1', add: ['INBOX'], remove: ['STARRED'] }],
      cursor: null,
      notify: true,
    })
    expect(applied.labelsChanged).toBe(0)
  })

  test('a delta replayed on a message fetched in the same page leaves it where Gmail has it', () => {
    const c = connected()
    // Fetched after both events happened: no UNREAD, STARRED present.
    c.h.inbox.applyHistoryPage({
      mailboxId: c.row.id,
      messages: [message({ labels: ['INBOX', 'STARRED'] })],
      deltas: [
        { gmailId: 'g1', add: [], remove: ['UNREAD'] },
        { gmailId: 'g1', add: ['STARRED'], remove: [] },
      ],
      cursor: null,
      notify: true,
    })
    expect(thread(c).messages[0]?.labels).toEqual(['INBOX', 'STARRED'])
  })

  test('the cursor does not move when none is given, and a page that fails stores nothing', () => {
    const c = connected()
    ingest(c, message())
    expect(firstGmail(c.h.inbox)?.historyId).toBeNull()
    const boom = () =>
      c.h.inbox.applyHistoryPage({
        mailboxId: 'no-such-mailbox',
        messages: [message({ gmailId: 'g7', threadId: 't7' })],
        deltas: [],
        cursor: '999',
        notify: true,
      })
    expect(boom).toThrow()
    expect(count(c.h, 'message')).toBe(1)
    expect(firstGmail(c.h.inbox)?.historyId).toBeNull()
  })
})

describe('jobs', () => {
  test('a step saves progress; the last step sets the cursor to the id read first and owes a sync', () => {
    const c = connected()
    const before = firstGmail(c.h.inbox)
    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'fill',
      cursorAfter: '500',
      messages: [message()],
      labels: [],
      job: fillJob({ pageToken: 'p2' }),
    })
    expect(firstGmail(c.h.inbox)).toMatchObject({ historyId: null, job: { pageToken: 'p2' } })
    expect(firstGmailStatus(c.h.inbox)?.state).toBe('filling')

    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'fill',
      cursorAfter: '500',
      messages: [message({ gmailId: 'g2' })],
      labels: [],
      job: null,
    })
    const after = firstGmail(c.h.inbox)
    expect(after).toMatchObject({ historyId: '500', job: null, lastResyncAt: null })
    expect(after?.pushSeq).toBe((before?.pushSeq ?? 0) + 1)
    expect(firstGmailStatus(c.h.inbox)).toMatchObject({ state: 'live', messages: 2 })
    expect(c.h.inbox.listAudit(10).map((a) => a.action)).toContain('mailbox.fill-complete')
  })

  test('finishing a resync stamps when, and a resync’s labels stage sets labels by message id', () => {
    const c = connected()
    ingest(c, message(), message({ gmailId: 'g2', threadId: 't2' }))
    c.h.tick()
    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'resync',
      cursorAfter: '600',
      messages: [],
      labels: [
        { gmailId: 'g1', labels: ['STARRED'] },
        { gmailId: 'not-held', labels: ['INBOX'] },
      ],
      job: null,
    })
    expect(thread(c).messages[0]?.labels).toEqual(['STARRED'])
    expect(firstGmail(c.h.inbox)).toMatchObject({ historyId: '600', lastResyncAt: '2026-10-20T12:01:00.000Z' })
    expect(c.h.inbox.listAudit(10).map((a) => a.action)).toContain('mailbox.resync-complete')
  })

  test('a resync starts without touching the stale cursor', () => {
    const c = connected()
    c.h.inbox.applyJobStep({
      mailboxId: c.row.id,
      kind: 'fill',
      cursorAfter: '500',
      messages: [],
      labels: [],
      job: null,
    })
    c.h.inbox.startResync(c.row.id, fillJob({ kind: 'resync', cursorAfter: '900' }), 'cursor expired')
    expect(firstGmail(c.h.inbox)).toMatchObject({ historyId: '500', job: { kind: 'resync', cursorAfter: '900' } })
    expect(firstGmailStatus(c.h.inbox)?.state).toBe('resyncing')
  })

  test('the open conversations are the threads with a message in the Inbox', () => {
    const c = connected()
    ingest(
      c,
      message({ gmailId: 'a', threadId: 'open', labels: ['INBOX'] }),
      message({
        gmailId: 'b',
        threadId: 'closed',
        labels: ['SENT'],
        from: { name: '', address: TESSA },
        to: [{ name: 'X', address: 'x@example.com' }],
      }),
      message({
        gmailId: 'c',
        threadId: 'mixed',
        labels: ['SENT'],
        from: { name: '', address: TESSA },
        to: [{ name: 'Y', address: 'y@example.com' }],
      }),
      message({ gmailId: 'd', threadId: 'mixed', labels: ['INBOX'], from: { name: 'Y', address: 'y@example.com' } }),
    )
    expect(c.h.inbox.openThreadIds(c.row.id).sort()).toEqual(['mixed', 'open'])
  })

  test('the newest message held is by Gmail’s own time', () => {
    const c = connected()
    expect(c.h.inbox.newestMessageAt(c.row.id)).toBeNull()
    ingest(c, message(), message({ gmailId: 'g2', receivedAt: '2026-10-22T00:00:00.000Z' }))
    expect(c.h.inbox.newestMessageAt(c.row.id)).toBe('2026-10-22T00:00:00.000Z')
  })

  test('known ids are those already held for this mailbox', () => {
    const c = connected()
    ingest(c, message())
    expect([...c.h.inbox.knownGmailIds(c.row.id, ['g1', 'g2'])]).toEqual(['g1'])
  })
})

describe('what is owed, and how it went', () => {
  test('a push bumps the sequence and stamps when; a sync completed at that sequence settles it', () => {
    const c = connected()
    const base = firstGmail(c.h.inbox)?.pushSeq ?? 0
    c.h.inbox.recordPush(c.row.id)
    c.h.inbox.recordPush(c.row.id)
    expect(firstGmail(c.h.inbox)).toMatchObject({ pushSeq: base + 2, lastPushAt: '2026-10-20T12:00:00.000Z' })
    c.h.inbox.recordSyncSuccess(c.row.id, base + 2)
    c.h.inbox.recordPush(c.row.id)
    const row = firstGmail(c.h.inbox)
    expect(row?.syncedSeq).toBe(base + 2)
    expect((row?.pushSeq ?? 0) > (row?.syncedSeq ?? 0)).toBe(true)
  })

  test('a sync that was cut short does not settle what is owed', () => {
    const c = connected()
    c.h.inbox.recordPush(c.row.id)
    c.h.inbox.recordSyncSuccess(c.row.id, null)
    const row = firstGmail(c.h.inbox)
    expect(row?.syncedSeq).toBe(0)
    expect(row?.lastSyncAt).not.toBeNull()
  })

  test('failures count up, a success clears the error, and a still-true error can be kept', () => {
    const c = connected()
    expect(c.h.inbox.recordFailure(c.row.id, 'Gmail  said\n no')).toBe(1)
    expect(c.h.inbox.recordFailure(c.row.id, 'again')).toBe(2)
    expect(firstGmail(c.h.inbox)).toMatchObject({ lastError: 'again', retryCount: 2 })
    c.h.inbox.recordSyncSuccess(c.row.id, null, true)
    expect(firstGmail(c.h.inbox)).toMatchObject({ lastError: 'again', retryCount: 0 })
    c.h.inbox.recordSyncSuccess(c.row.id, null)
    expect(firstGmail(c.h.inbox)).toMatchObject({ lastError: null, lastErrorAt: null })
  })

  test('an error is kept to one short line', () => {
    const c = connected()
    c.h.inbox.recordFailure(c.row.id, `a\n${'b'.repeat(500)}`)
    const error = firstGmail(c.h.inbox)?.lastError ?? ''
    expect(error).not.toContain('\n')
    expect(error.length).toBeLessThanOrEqual(300)
  })

  test('a push for a mailbox with no token is not recorded', () => {
    const c = connected()
    c.h.inbox.disconnectMailbox(c.row.id, TESSA, true)
    const before = firstGmail(c.h.inbox)?.pushSeq
    c.h.inbox.recordPush(c.row.id)
    c.h.inbox.markSyncOwed()
    expect(firstGmail(c.h.inbox)?.pushSeq).toBe(before)
  })

  test('the watch expiry and the suspect-pushes stamp are kept', () => {
    const c = connected()
    c.h.inbox.setWatch(c.row.id, '2026-10-27T12:00:00.000Z')
    c.h.inbox.markPushSuspect(c.row.id)
    expect(firstGmail(c.h.inbox)).toMatchObject({
      watchExpiry: '2026-10-27T12:00:00.000Z',
      pushSuspectAt: '2026-10-20T12:00:00.000Z',
    })
  })
})
