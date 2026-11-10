// The menu's counts as rows (src/store/row-counts.ts): a table over literal facts, no store.
import { describe, expect, test } from 'bun:test'
import { type RowParty, rowCounts } from '../src/store/row-counts'
import type { QueueFact } from '../src/types'

const fact = (id: string, over: Partial<QueueFact> = {}): QueueFact =>
  ({
    id,
    lastActivityAt: '2026-11-04T00:00:00Z',
    drafts: 0,
    newestInbound: null,
    clientIds: [],
    open: true,
    unread: false,
    ...over,
  }) as QueueFact
const party = (
  conversationId: string,
  contactId: string,
  clientId: number | null = null,
  ...addresses: string[]
): RowParty => ({
  conversationId,
  contactId,
  clientId,
  addresses: addresses.length > 0 ? addresses : [`${contactId}@x.example`],
  placed: true,
  // Alone among its Client's people, a contact is the pick of its Client's list.
  placedInClient: clientId !== null,
})
/** On the conversation, but the lists put it under someone else. */
const alsoOn = (conversationId: string, contactId: string, clientId: number | null = null): RowParty => ({
  ...party(conversationId, contactId, clientId),
  placed: false,
})
const bulk = { newestInbound: { listUnsubscribe: true, labels: [], automated: false } } as unknown as Partial<QueueFact>

describe('rowCounts', () => {
  test('a person on several conversations is one row; a thread two people are on is a row under only the one it is placed under', () => {
    const facts = [fact('a'), fact('b', { unread: true }), fact('c'), fact('d')]
    const parties = [
      party('a', 'dana'),
      party('b', 'dana'),
      party('c', 'dana'),
      party('d', 'seller'),
      alsoOn('d', 'relay'),
    ]
    const { views } = rowCounts(facts, parties, [])
    expect(views.inbox).toEqual({ count: 2, unread: 1 })
    expect(views.unread).toEqual({ count: 1, unread: 1 })
    // Placed under the relay instead, the seller has no row and the relay has: the same two rows.
    expect(
      rowCounts(facts, [...parties.slice(0, 3), alsoOn('d', 'seller'), party('d', 'relay')], []).views.inbox.count,
    ).toBe(2)
  })

  test('each view holds the conversations the lists do: Bulk open, Closed not open, Drafts in any state', () => {
    const facts = [
      fact('a'),
      fact('b', bulk),
      fact('c', { open: false }),
      fact('d', { open: false, drafts: 1 }),
      fact('e', { drafts: 2, unread: true }),
    ]
    const parties = [party('a', 'p1'), party('b', 'p2'), party('c', 'p3'), party('d', 'p3'), party('e', 'p1')]
    const { views } = rowCounts(facts, parties, [])
    expect(views.inbox.count).toBe(1)
    expect(views.bulk.count).toBe(1)
    expect(views.closed.count).toBe(1)
    expect(views.drafts).toEqual({ count: 2, unread: 1 })
  })

  test('a conversation with nobody on it has no row, as the lists draw none', () => {
    expect(rowCounts([fact('a')], [], []).views.inbox.count).toBe(0)
  })

  test('a teammate known by two addresses is one row', () => {
    const facts = [fact('a'), fact('b')]
    const parties = [party('a', 'c1', null, 'priya@northfield.example'), party('b', 'c2', null, 'priya_n@gmail.com')]
    expect(rowCounts(facts, parties, []).views.inbox.count).toBe(2)
    expect(rowCounts(facts, parties, [['priya@northfield.example', 'priya_n@gmail.com']]).views.inbox.count).toBe(1)
  })

  test('a Client counts the people linked to it on open conversations, Bulk included, and a mailbox its open Inbox ones', () => {
    const facts = [
      fact('a', { mailbox: { id: 'ridgeway', name: 'F', address: 'f@x' } }),
      fact('b', { ...bulk, unread: true }),
      fact('c', { open: false }),
    ]
    const parties = [party('a', 'p1', 7), party('b', 'p2', 7), party('c', 'p3', 7), party('b', 'p4', 9)]
    const out = rowCounts(facts, parties, [])
    expect(out.clients[7]).toEqual({ count: 2, unread: 1 })
    expect(out.clients[9]).toEqual({ count: 1, unread: 1 })
    expect(out.mailboxes.ridgeway).toEqual({ count: 1, unread: 0 })
  })

  test('a Client’s list places a thread among that Client’s people: the outsider who wrote last has the Inbox row, the Client’s person has the Client row', () => {
    const facts = [fact('a', { unread: true }), fact('b')]
    const parties = [
      alsoOn('a', 'harbor', 7), // the Client's person: on the thread, not the Inbox's pick
      party('a', 'outsider'), // wrote last
      party('b', 'harbor', 7),
    ]
    const out = rowCounts(facts, parties, [])
    // Inbox: the outsider (thread a) and harbor (thread b): two rows. Client 7: harbor, once, with thread a unread.
    expect(out.views.inbox).toEqual({ count: 2, unread: 1 })
    expect(out.clients[7]).toEqual({ count: 1, unread: 1 })
    // Two people of the same Client on one thread: one Client row, the pick of the two.
    const two = rowCounts([fact('c')], [party('c', 'p1', 7), { ...party('c', 'p2', 7), placedInClient: false }], [])
    expect(two.clients[7]).toEqual({ count: 1, unread: 0 })
  })
})
