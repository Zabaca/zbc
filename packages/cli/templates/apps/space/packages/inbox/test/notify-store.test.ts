import { describe, expect, test } from 'bun:test'
import type { ParsedMessage } from '../src/gmail/types'
import { PUSH_SERVICE_ACTOR } from '../src/store/mail'
import { AGENT_PREFIX } from '../src/types'

/** What Claude is told in Northfield's install, word for word. */
const ONLY_OWNER_NOTIFICATIONS =
  'Notifications are Tessa’s only: Claude cannot turn them on or off, list the devices or send one.'

import { count, harness } from '../test-support/harness'

/**
 * The store's half of notifications over a real SQLite: a message marked owed by the page method and only when told to, the owed and sent marks, the week's
 * counts, and devices added, renewed, removed and stamped by what the push service said. Through the store's own
 * methods, and a row read where a column is the point.
 */

const TESSA = 'tessa@northfield.example'
const CLAUDE = `${AGENT_PREFIX}abc123.access`

const message = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
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
})

function connected() {
  const h = harness()
  const row = h.inbox.connectMailbox(
    { address: TESSA, refreshToken: 'refresh-secret', scopes: ['gmail.modify'], historyId: '500', query: 'q' },
    TESSA,
  )
  const page = (notify: boolean, ...messages: ParsedMessage[]) =>
    h.inbox.applyHistoryPage({ mailboxId: row.id, messages, deltas: [], cursor: null, notify })
  return { h, page }
}

const mark = (h: ReturnType<typeof harness>, gmailId: string) =>
  h.db.query(`SELECT id, notify, notified_at FROM message WHERE gmail_id = ?`).get(gmailId) as {
    id: string
    notify: string | null
    notified_at: string | null
  }

const device = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/a',
  p256dh: 'KEY',
  auth: 'AUTH',
  label: 'Chrome on Android',
}

describe('owed, sent and dropped', () => {
  test('a page marks owed only when told to, and says how many', () => {
    const { h, page } = connected()
    expect(page(false, message({ gmailId: 'quiet', threadId: 'tq' })).owed).toBe(0)
    expect(page(true, message({ gmailId: 'loud', threadId: 'tl' })).owed).toBe(1)
    expect(mark(h, 'quiet').notify).toBeNull()
    expect(mark(h, 'loud').notify).toBe('owed')
    // Stored once: the same message again owes nothing more.
    expect(page(true, message({ gmailId: 'loud', threadId: 'tl' })).owed).toBe(0)
  })

  test('what an owed notification carries, oldest first', () => {
    const { h, page } = connected()
    page(true, message({ gmailId: 'a', threadId: 'ta', subject: 'First' }))
    page(true, message({ gmailId: 'b', threadId: 'tb', subject: 'Second', from: { name: '', address: 'bob@x.test' } }))
    expect(h.inbox.owedNotifications().map(({ conversationId: _c, messageId: _m, ...rest }) => rest)).toEqual([
      { name: 'Dana Smith', address: 'dana@example.com', subject: 'First', receivedAt: '2026-10-20T12:00:00.000Z' },
      { name: 'bob@x.test', address: 'bob@x.test', subject: 'Second', receivedAt: '2026-10-20T12:00:00.000Z' },
    ])
  })

  test('sent or dropped is written once, and only over owed; the week counts them', () => {
    const { h, page } = connected()
    page(true, message({ gmailId: 'a', threadId: 'ta' }), message({ gmailId: 'b', threadId: 'tb' }))
    page(false, message({ gmailId: 'c', threadId: 'tc' }))
    h.inbox.markNotified(mark(h, 'a').id, 'sent')
    h.inbox.markNotified(mark(h, 'b').id, 'dropped')
    h.inbox.markNotified(mark(h, 'a').id, 'dropped')
    h.inbox.markNotified(mark(h, 'c').id, 'sent')
    expect([mark(h, 'a').notify, mark(h, 'b').notify, mark(h, 'c').notify]).toEqual(['sent', 'dropped', null])
    expect(mark(h, 'a').notified_at).toBe('2026-10-20T12:00:00.000Z')
    expect(h.inbox.owedNotifications()).toEqual([])
    expect(h.inbox.notifiedSince('2026-10-13T12:00:00.000Z')).toEqual({ sent: 1, dropped: 1 })
    expect(h.inbox.notifiedSince('2026-10-21T00:00:00.000Z')).toEqual({ sent: 0, dropped: 0 })
  })
})

describe('devices', () => {
  test('added by Tessa, listed without its keys, audited without its keys or address', () => {
    const h = harness()
    const added = h.inbox.addDevice(device, TESSA)
    if (!added.ok) throw new Error(added.error)
    expect(h.inbox.listDevices()).toEqual([added.value])
    expect(JSON.stringify(h.inbox.listDevices())).not.toContain('KEY')
    expect(h.inbox.deviceWithKeys(added.value.id)).toMatchObject({ p256dh: 'KEY', auth: 'AUTH' })
    const audit = JSON.stringify(h.inbox.listAudit(10))
    expect(audit).toContain('device.add')
    expect(audit).not.toContain('KEY')
    expect(audit).not.toContain('fcm.googleapis.com')
  })

  test('the same push address again is the same device, renewed: new keys, its failure cleared', () => {
    const h = harness()
    const first = h.inbox.addDevice(device, TESSA)
    if (!first.ok) throw new Error(first.error)
    h.inbox.recordDelivery(first.value.id, 'refused', 'refused (403)')
    expect(h.inbox.listDevices()[0]).toMatchObject({ lastOutcome: 'refused', failed: 1 })
    h.tick()
    const again = h.inbox.addDevice({ ...device, p256dh: 'NEW' }, TESSA)
    if (!again.ok) throw new Error(again.error)
    expect(again.value.id).toBe(first.value.id)
    expect(again.value).toMatchObject({ lastFailedAt: null, lastFailure: null, lastOutcome: null })
    expect(h.inbox.deviceWithKeys(first.value.id)?.p256dh).toBe('NEW')
    expect(count(h, 'device')).toBe(1)
  })

  test('Claude can neither add nor remove one', () => {
    const h = harness()
    expect(h.inbox.addDevice(device, CLAUDE)).toEqual({ ok: false, status: 403, error: ONLY_OWNER_NOTIFICATIONS })
    const added = h.inbox.addDevice(device, TESSA)
    if (!added.ok) throw new Error(added.error)
    expect(h.inbox.removeDevice(added.value.id, CLAUDE)).toMatchObject({ ok: false, status: 403 })
    expect(count(h, 'device')).toBe(1)
    expect(h.inbox.removeDevice(added.value.id, TESSA)).toEqual({ ok: true, value: { id: added.value.id } })
    expect(h.inbox.removeDevice(added.value.id, TESSA)).toMatchObject({ ok: false, status: 404 })
  })

  test('what the push service said: a delivery counted and stamped, a failure counted with how it was read, gone deleted and audited', () => {
    const h = harness()
    const added = h.inbox.addDevice(device, TESSA)
    if (!added.ok) throw new Error(added.error)
    const id = added.value.id
    h.inbox.recordDelivery(id, 'delivered', 'status 201')
    h.inbox.recordDelivery(id, 'failed', 'The push service did not take the notification (503).')
    expect(h.inbox.listDevices()[0]).toMatchObject({
      delivered: 1,
      failed: 1,
      lastDeliveredAt: '2026-10-20T12:00:00.000Z',
      lastFailedAt: '2026-10-20T12:00:00.000Z',
      lastOutcome: 'failed',
      lastFailure: 'The push service did not take the notification (503).',
    })
    h.inbox.recordDelivery(id, 'gone', 'status 410')
    expect(count(h, 'device')).toBe(0)
    const gone = h.inbox.listAudit(10).find((a) => a.action === 'device.gone')
    expect(gone).toMatchObject({ actor: PUSH_SERVICE_ACTOR, subject: `device:${id}` })
    // A second answer for a device already gone changes nothing.
    h.inbox.recordDelivery(id, 'gone', 'status 410')
    expect(h.inbox.listAudit(10).filter((a) => a.action === 'device.gone')).toHaveLength(1)
  })
})
