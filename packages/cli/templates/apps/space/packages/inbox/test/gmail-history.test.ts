import { describe, expect, test } from 'bun:test'
import { DAY_MS, healthOf, type MailboxStamps, stateOf } from '../src/gmail/health'
import { planHistory } from '../src/gmail/history'
import { belongsInStore, type HistoryRecord } from '../src/gmail/types'
import page from './fixtures/gmail/history-page.json'

/**
 * History pages and the rules that read them, as table tests: what to fetch,
 * which label changes to apply, which messages belong in the store, and when the
 * header goes amber. The history fixture is a PLACEHOLDER (see gmail-parse.test.ts).
 */

const none = () => false

describe('planning a history page', () => {
  test('a message added is a candidate; the same one named twice is one', () => {
    const records: HistoryRecord[] = [
      { id: '10', messagesAdded: [{ message: { id: 'a', threadId: 't1', labelIds: ['INBOX'] } }] },
      { id: '11', messagesAdded: [{ message: { id: 'a', threadId: 't1', labelIds: ['INBOX'] } }] },
    ]
    const plan = planHistory(records, none)
    expect(plan.candidates).toEqual([{ id: 'a', threadId: 't1' }])
    expect(plan.lastRecordId).toBe('11')
  })

  test('a message already stored is not fetched again, which is what makes a duplicate push store once', () => {
    const records: HistoryRecord[] = [
      { id: '10', messagesAdded: [{ message: { id: 'a', threadId: 't1', labelIds: ['INBOX'] } }] },
    ]
    expect(planHistory(records, (id) => id === 'a').candidates).toEqual([])
  })

  test('a message added as spam, trash or a draft is not fetched', () => {
    const records: HistoryRecord[] = ['SPAM', 'TRASH', 'DRAFT'].map((label, n) => ({
      id: String(n),
      messagesAdded: [{ message: { id: `m${n}`, threadId: 't', labelIds: [label] } }],
    }))
    expect(planHistory(records, none).candidates).toEqual([])
  })

  test('a label change is a delta, in history order, for a held message', () => {
    const records: HistoryRecord[] = [
      { id: '10', labelsRemoved: [{ message: { id: 'a', threadId: 't' }, labelIds: ['UNREAD'] }] },
      { id: '11', labelsAdded: [{ message: { id: 'a', threadId: 't' }, labelIds: ['STARRED'] }] },
    ]
    const plan = planHistory(records, (id) => id === 'a')
    expect(plan.deltas).toEqual([
      { gmailId: 'a', add: [], remove: ['UNREAD'] },
      { gmailId: 'a', add: ['STARRED'], remove: [] },
    ])
    expect(plan.candidates).toEqual([])
  })

  test('a label change on a message NOT held makes it a candidate, even when the label it leaves is SPAM', () => {
    const records: HistoryRecord[] = [
      {
        id: '10',
        labelsRemoved: [{ message: { id: 'a', threadId: 't', labelIds: ['SPAM'] }, labelIds: ['SPAM'] }],
      },
    ]
    expect(planHistory(records, none).candidates).toEqual([{ id: 'a', threadId: 't' }])
  })

  test('a message deleted is ignored: nothing is ever removed from the store', () => {
    const records: HistoryRecord[] = [{ id: '10', messagesDeleted: [{ message: { id: 'a', threadId: 't' } }] }]
    expect(planHistory(records, (id) => id === 'a')).toEqual({ candidates: [], deltas: [], lastRecordId: '10' })
  })

  test('an empty page has no last record, and ids compare as numbers', () => {
    expect(planHistory([], none).lastRecordId).toBeNull()
    const plan = planHistory([{ id: '9' }, { id: '100' }, { id: '99' }], none)
    expect(plan.lastRecordId).toBe('100')
  })

  test('the placeholder fixture page: one new message, two label changes, the spam one skipped', () => {
    const plan = planHistory(page.history as HistoryRecord[], none)
    expect(plan.candidates.map((c) => c.id)).toEqual(['19a1f1d4c9e0a512', '19a1f0c2b7d4e801', '19a1e8a0d1c3f777'])
    expect(plan.deltas).toEqual([
      { gmailId: '19a1f0c2b7d4e801', add: [], remove: ['UNREAD'] },
      { gmailId: '19a1e8a0d1c3f777', add: [], remove: ['INBOX'] },
    ])
    expect(plan.lastRecordId).toBe('482970')
  })
})

describe('what belongs in the store', () => {
  test.each([
    [['INBOX', 'UNREAD'], false, true],
    [['SENT'], false, true],
    [['CATEGORY_PROMOTIONS'], false, false],
    [['CATEGORY_PROMOTIONS'], true, true],
    [[], false, false],
    [[], true, true],
    [['INBOX', 'SPAM'], true, false],
    [['INBOX', 'TRASH'], false, false],
    [['DRAFT'], true, false],
    [['SENT', 'DRAFT'], false, false],
  ])('labels %p, thread already held %p -> stored %p', (labels, held, stored) => {
    expect(belongsInStore(labels, held)).toBe(stored)
  })
})

const NOW = new Date('2026-10-20T12:00:00.000Z')
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const live = (over: Partial<MailboxStamps> = {}): MailboxStamps => ({
  address: 'tessa@northfield.example',
  lapsedAt: null,
  connected: true,
  historyId: '100',
  jobKind: null,
  watchExpiry: iso(5 * DAY_MS),
  lastPushAt: iso(-60_000),
  lastSyncAt: iso(-60_000),
  lastError: null,
  pushSuspectAt: null,
  ...over,
})

describe('the mailbox state', () => {
  test.each([
    [{ connected: false, historyId: '1', jobKind: null, lapsedAt: null }, 'disconnected'],
    [{ connected: true, historyId: null, jobKind: null, lapsedAt: null }, 'filling'],
    [{ connected: true, historyId: null, jobKind: 'fill' as const, lapsedAt: null }, 'filling'],
    [{ connected: true, historyId: '1', jobKind: 'resync' as const, lapsedAt: null }, 'resyncing'],
    [{ connected: true, historyId: '1', jobKind: null, lapsedAt: null }, 'live'],
    [{ connected: true, historyId: '1', jobKind: null, lapsedAt: '2026-10-20T00:00:00.000Z' }, 'lapsed'],
  ])('%p is %s', (stamps, state) => {
    expect(stateOf(stamps) as string).toBe(state)
  })
})

describe('when the header turns amber', () => {
  test('a healthy mailbox is not amber, and a disconnected one is not either', () => {
    expect(healthOf(live(), NOW)).toEqual({ amber: false, reasons: [] })
    expect(healthOf(live({ connected: false, lastError: 'old' }), NOW).amber).toBe(false)
  })

  test('the watch running out within a day, lapsed, or never set', () => {
    expect(healthOf(live({ watchExpiry: iso(DAY_MS - 1) }), NOW).reasons).toEqual([
      'The live connection to Gmail runs out within a day.',
    ])
    expect(healthOf(live({ watchExpiry: iso(DAY_MS + 60_000) }), NOW).amber).toBe(false)
    expect(healthOf(live({ watchExpiry: iso(-1) }), NOW).reasons).toEqual(['The live connection to Gmail has lapsed.'])
    expect(healthOf(live({ watchExpiry: null }), NOW).amber).toBe(true)
  })

  test('the last sync failing carries its error', () => {
    const health = healthOf(live({ lastError: 'Gmail refused the history: status 500' }), NOW)
    expect(health.amber).toBe(true)
    expect(health.reasons).toEqual(['The last sync failed: Gmail refused the history: status 500'])
  })

  test('mail found with no push for a day is amber until a push arrives after it', () => {
    const suspected = live({ pushSuspectAt: iso(-1000), lastPushAt: iso(-2 * DAY_MS) })
    expect(healthOf(suspected, NOW).reasons).toEqual([
      'Mail arrived but Gmail has not pushed for over a day, so pushes may be broken.',
    ])
    expect(healthOf({ ...suspected, lastPushAt: null }, NOW).amber).toBe(true)
    expect(healthOf({ ...suspected, lastPushAt: iso(-500) }, NOW).amber).toBe(false)
  })

  test('every cause that holds is listed', () => {
    const health = healthOf(live({ watchExpiry: null, lastError: 'boom' }), NOW)
    expect(health.reasons).toHaveLength(2)
  })
})
