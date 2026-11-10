import { describe, expect, test } from 'bun:test'
import { DEFAULT_FILTER, isBulk, parseFilter, planQueue, queueRows } from '../src/queue'
import type { ConversationSummary, Envelope, ListedClient } from '../src/types'
import { ACME, BOLT } from '../test-support/clients-part'

/** The pure queue: rows, filters and counts from one list. */

const convo = (id: string, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  contactIds: [`c-${id}`],
  contactNames: [`Person ${id}`],
  contactClientIds: [null],
  clientIds: [],
  kind: 'email',
  subject: '',
  snippet: '',
  lastActivityAt: '2026-10-20T00:00:00.000Z',
  newestFromClaude: false,
  draft: null,
  drafts: 0,
  unread: false,
  open: true,
  readBy: null,
  readAt: null,
  closedBy: null,
  closedAt: null,
  newestInbound: null,
  ...over,
})

/** What the route does: plan from the facts, then the rows for the ids the plan named, in its order. */
const queue = (
  list: ConversationSummary[],
  requested: string | null | undefined,
  directory: Map<number, ListedClient> = new Map(),
  looseDrafts = 0,
) => {
  const plan = planQueue(list, requested, directory, looseDrafts)
  const byId = new Map(list.map((c) => [c.id, c]))
  return {
    ...plan,
    rows: queueRows(
      plan.ids.map((id) => byId.get(id) as ConversationSummary),
      directory,
    ),
  }
}

const envelope = (labels: string[], listUnsubscribe = false): Envelope => ({ labels, listUnsubscribe })

describe('the queue', () => {
  const list = [convo('a'), convo('b', { drafts: 2 }), convo('c', { drafts: 1 })]

  test('the Inbox shows every open conversation in the order given, and the counts come from the same list', () => {
    const q = queue(list, 'inbox')
    expect(q.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(q.filters).toEqual([
      { id: 'inbox', label: 'Inbox', count: 3, unread: 0 },
      { id: 'unread', label: 'Unread', count: 0, unread: 0 },
      { id: 'drafts', label: 'Drafts', count: 2, unread: 0 },
      { id: 'bulk', label: 'Bulk', count: 0, unread: 0 },
      { id: 'closed', label: 'Closed', count: 0, unread: 0 },
    ])
  })

  test('Drafts shows only conversations with a draft waiting, and its count matches its rows', () => {
    const q = queue(list, 'drafts')
    expect(q.filter).toBe('drafts')
    expect(q.rows.map((r) => r.id)).toEqual(['b', 'c'])
    expect(q.filters.find((f) => f.id === 'drafts')?.count).toBe(q.rows.length)
  })

  test('an unrecognized or missing filter shows the default, not an empty queue', () => {
    // `all` was the Inbox's id before it was renamed; it is not an alias now.
    for (const bad of ['bogus', '', null, undefined, 'ALL', 'all', 'INBOX']) {
      expect(queue(list, bad).filter).toBe(DEFAULT_FILTER)
      expect(queue(list, bad).rows).toHaveLength(3)
    }
    expect(DEFAULT_FILTER).toBe('inbox')
    expect(parseFilter('inbox')).toBe('inbox')
    expect(parseFilter('unread')).toBe('unread')
    expect(parseFilter('drafts')).toBe('drafts')
    expect(parseFilter('bulk')).toBe('bulk')
    expect(parseFilter('closed')).toBe('closed')
  })

  test('an empty list is an empty queue with zero counts', () => {
    const q = queue([], 'inbox')
    expect(q.rows).toEqual([])
    expect(q.filters.map((f) => f.count)).toEqual([0, 0, 0, 0, 0])
  })

  test('a row is titled by its contact, or the first of several', () => {
    const q = queue(
      [
        convo('one'),
        convo('many', { contactNames: ['Ann', 'Bob', 'Cy'], contactClientIds: [null, null, null] }),
        convo('none', { contactNames: [], contactClientIds: [] }),
      ],
      'inbox',
    )
    expect(q.rows.map((r) => r.title)).toEqual(['Person one', 'Ann and 2 more', '(nobody)'])
  })
})

describe('open and closed', () => {
  const list = [
    convo('open-unread', { unread: true }),
    convo('open-read'),
    convo('closed-read', { open: false }),
    convo('closed-unread', { open: false, unread: true }),
  ]

  test('the Inbox holds the open ones and Closed the rest, so every conversation is in exactly one of them', () => {
    expect(queue(list, 'inbox').rows.map((r) => r.id)).toEqual(['open-unread', 'open-read'])
    expect(queue(list, 'closed').rows.map((r) => r.id)).toEqual(['closed-read', 'closed-unread'])
    const counts = Object.fromEntries(queue(list, 'inbox').filters.map((f) => [f.id, f.count]))
    expect((counts.inbox ?? 0) + (counts.closed ?? 0)).toBe(list.length)
  })

  test('Unread is the Inbox unread ones as a view of their own, and its count is the Inbox unread count', () => {
    const news = envelope(['INBOX', 'CATEGORY_PROMOTIONS'])
    const mixed = [...list, convo('news-unread', { unread: true, newestInbound: news })]
    const q = queue(mixed, 'unread')
    expect(q.rows.map((r) => r.id)).toEqual(['open-unread'])
    expect(q.filters.find((f) => f.id === 'unread')?.count).toBe(1)
    expect(q.filters.find((f) => f.id === 'inbox')?.unread).toBe(1)
    // An unread newsletter is Bulk's, not the Unread view's, and a closed unread one is Closed's.
    expect(q.rows.map((r) => r.id)).not.toContain('news-unread')
    expect(q.rows.map((r) => r.id)).not.toContain('closed-unread')
  })

  test('unread is counted per filter, from the same list, and rows carry it', () => {
    const q = queue(list, 'inbox')
    expect(q.filters.find((f) => f.id === 'inbox')).toMatchObject({ count: 2, unread: 1 })
    expect(q.filters.find((f) => f.id === 'closed')).toMatchObject({ count: 2, unread: 1 })
    expect(q.rows.map((r) => r.unread)).toEqual([true, false])
  })

  test('a conversation with a draft is under Drafts whether it is open or closed', () => {
    const q = queue([convo('a', { drafts: 1 }), convo('b', { drafts: 1, open: false }), convo('c')], 'drafts')
    expect(q.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('Drafts counts the drafts that sit on no conversation too, and no other count moves', () => {
    const list = [convo('a', { drafts: 1 }), convo('b')]
    const q = queue(list, 'drafts', new Map(), 3)
    expect(q.rows.map((r) => r.id)).toEqual(['a'])
    expect(q.filters.find((f) => f.id === 'drafts')?.count).toBe(4)
    expect(q.filters.find((f) => f.id === 'inbox')?.count).toBe(2)
    expect(queue(list, 'inbox').filters.find((f) => f.id === 'drafts')?.count).toBe(1)
  })
})

describe('the plan', () => {
  test('counts are over every conversation, and the rows are the first screen of the filter, cut after it', () => {
    const closed = Array.from({ length: 250 }, (_, n) => convo(`closed-${n}`, { open: false }))
    const list = [...closed, convo('old-open-1'), convo('old-open-2', { unread: true })]
    const all = planQueue(list, 'inbox')
    expect(all.ids).toEqual(['old-open-1', 'old-open-2'])
    expect(all.filters[0]).toMatchObject({ id: 'inbox', count: 2, unread: 1 })

    const shut = planQueue(list, 'closed')
    expect(shut.ids).toHaveLength(200)
    expect(shut.ids[0]).toBe('closed-0')
    expect(shut.filters.find((f) => f.id === 'closed')?.count).toBe(250)
  })
})

describe('Bulk', () => {
  test('its newest inbound message in Promotions, Social, Updates or Forums is bulk; Primary is not', () => {
    for (const tab of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']) {
      expect(isBulk({ clientIds: [], newestInbound: envelope(['INBOX', tab]) }), tab).toBe(true)
    }
    expect(isBulk({ clientIds: [], newestInbound: envelope(['INBOX', 'CATEGORY_PERSONAL']) })).toBe(false)
    expect(isBulk({ clientIds: [], newestInbound: envelope(['INBOX']) })).toBe(false)
  })

  test('a List-Unsubscribe header makes it bulk whatever tab it is in', () => {
    expect(isBulk({ clientIds: [], newestInbound: envelope(['INBOX', 'CATEGORY_PERSONAL'], true) })).toBe(true)
    expect(isBulk({ clientIds: [], newestInbound: envelope(['INBOX'], true) })).toBe(true)
  })

  test('nothing has come in on it (a sent-only thread, a manual conversation) is not bulk', () => {
    expect(isBulk({ clientIds: [], newestInbound: null })).toBe(false)
  })

  test('bulk is shown under Bulk alone: not in the Inbox, and in Closed once archived', () => {
    const list = [
      convo('person'),
      convo('news', { newestInbound: envelope(['INBOX', 'CATEGORY_PROMOTIONS']) }),
      convo('news-done', { open: false, newestInbound: envelope(['CATEGORY_PROMOTIONS']) }),
      convo('news-unread', { unread: true, newestInbound: envelope(['INBOX'], true) }),
    ]
    expect(queue(list, 'inbox').rows.map((r) => r.id)).toEqual(['person'])
    expect(queue(list, 'bulk').rows.map((r) => [r.id, r.bulk])).toEqual([
      ['news', true],
      ['news-unread', true],
    ])
    expect(queue(list, 'closed').rows.map((r) => r.id)).toEqual(['news-done'])
    const q = queue(list, 'bulk')
    expect(q.filters.find((f) => f.id === 'bulk')).toMatchObject({ count: 2, unread: 1 })
    expect(q.filters.find((f) => f.id === 'inbox')).toMatchObject({ count: 1 })
  })
})

describe('Clients in the queue', () => {
  const directory = new Map([BOLT, ACME].map((c) => [c.id, c]))
  const list = [
    convo('acme-1', { clientIds: [1], contactClientIds: [1], unread: true }),
    convo('acme-2', { clientIds: [1], contactClientIds: [1] }),
    convo('acme-done', { clientIds: [1], contactClientIds: [1], open: false }),
    convo('bolt', { clientIds: [2], contactClientIds: [2] }),
    convo('both', { clientIds: [1, 2], contactClientIds: [1, 2] }),
    convo('stranger'),
  ]

  test('one filter per Client with an open conversation, after the standing ones, in name order, counted from the same list', () => {
    const q = queue(list, 'inbox', directory)
    expect(q.filters.map((f) => f.id)).toEqual(['inbox', 'unread', 'drafts', 'bulk', 'closed', 'client:1', 'client:2'])
    expect(q.filters.find((f) => f.id === 'client:1')).toMatchObject({ label: 'Acme Legal', count: 3, unread: 1 })
    expect(q.filters.find((f) => f.id === 'client:2')).toMatchObject({ label: 'Bolt Machines', count: 2 })
  })

  test("a Client filter holds that Client's open conversations, newest first, a shared one under both", () => {
    expect(queue(list, 'client:1', directory).rows.map((r) => r.id)).toEqual(['acme-1', 'acme-2', 'both'])
    expect(queue(list, 'client:2', directory).rows.map((r) => r.id)).toEqual(['bolt', 'both'])
    expect(queue(list, 'client:1', directory).filter).toBe('client:1')
  })

  test('a Client with nothing open has no filter, and a link to its filter shows it empty rather than the Inbox', () => {
    const none = [convo('shut', { clientIds: [1], contactClientIds: [1], open: false })]
    expect(planQueue(none, 'inbox', directory).filters.map((f) => f.id)).not.toContain('client:1')
    const asked = planQueue(none, 'client:1', directory)
    expect(asked.filter).toBe('client:1')
    expect(asked.ids).toEqual([])
    expect(asked.filters.find((f) => f.id === 'client:1')).toMatchObject({ label: 'Acme Legal', count: 0 })
  })

  test('with the directory down the Clients are named by number, and still filter', () => {
    const q = queue(list, 'client:1', new Map())
    expect(q.filters.find((f) => f.id === 'client:1')?.label).toBe('Client 1')
    expect(q.rows.map((r) => r.id)).toEqual(['acme-1', 'acme-2', 'both'])
    expect(q.rows[0]?.clients).toEqual([{ id: 1, name: 'Client 1', listed: false }])
  })

  test('rows name their Clients, listed ones by name', () => {
    const q = queue(list, 'inbox', directory)
    expect(q.rows.find((r) => r.id === 'both')?.clients).toEqual([
      { id: 1, name: 'Acme Legal', listed: true },
      { id: 2, name: 'Bolt Machines', listed: true },
    ])
    expect(q.rows.find((r) => r.id === 'stranger')?.clients).toEqual([])
  })

  test('only a well-formed Client filter is recognized; anything else is the Inbox', () => {
    for (const bad of [
      'client:',
      'client:0',
      'client:-1',
      'client:1.5',
      'client:abc',
      'client:01',
      'client:1 ',
      'Client:1',
    ]) {
      expect(parseFilter(bad), bad).toBe(DEFAULT_FILTER)
    }
    expect(parseFilter('client:7')).toBe('client:7')
  })

  describe('the Bulk exemption', () => {
    const news = envelope(['INBOX', 'CATEGORY_PROMOTIONS'], true)

    test("a conversation with a Client's person on it is never Bulk, whatever its newest message looks like", () => {
      expect(isBulk({ clientIds: [1], newestInbound: news })).toBe(false)
      expect(isBulk({ clientIds: [], newestInbound: news })).toBe(true)
    })

    test("it reaches the Inbox and the Client's filter, and leaves Bulk", () => {
      const mixed = [
        convo('receipt-from-client', { clientIds: [1], contactClientIds: [1], newestInbound: news }),
        convo('receipt', { newestInbound: news }),
      ]
      expect(queue(mixed, 'inbox', directory).rows.map((r) => [r.id, r.bulk])).toEqual([['receipt-from-client', false]])
      expect(queue(mixed, 'bulk', directory).rows.map((r) => r.id)).toEqual(['receipt'])
      expect(queue(mixed, 'client:1', directory).rows.map((r) => r.id)).toEqual(['receipt-from-client'])
      expect(queue(mixed, 'inbox', directory).filters.find((f) => f.id === 'bulk')?.count).toBe(1)
    })

    test('it is decided from the ids the store holds, so it does not change with the directory', () => {
      const one = [convo('x', { clientIds: [9], contactClientIds: [9], newestInbound: news })]
      expect(queue(one, 'inbox', new Map()).rows.map((r) => r.bulk)).toEqual([false])
      expect(queue(one, 'inbox', directory).rows.map((r) => r.bulk)).toEqual([false])
    })
  })
})
