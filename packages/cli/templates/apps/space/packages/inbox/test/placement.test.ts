// Which person a thread is listed under (src/store/placement.ts): a table over literal candidates, no store.
import { describe, expect, test } from 'bun:test'
import {
  hasDisplayName,
  isInside,
  type PlacementCandidate,
  placeConversation,
  placedUnder,
} from '../src/store/placement'

const who = (contactId: string, over: Partial<PlacementCandidate> = {}): PlacementCandidate => ({
  contactId,
  name: contactId,
  addresses: [contactId],
  inside: false,
  wroteAt: null,
  touchedAt: null,
  ...over,
})
const named = (contactId: string, over: Partial<PlacementCandidate> = {}) =>
  who(contactId, { name: `Name of ${contactId}`, ...over })

describe('placedUnder', () => {
  test('the person who wrote last gets the thread', () => {
    const list = [named('a', { wroteAt: '2026-11-01T10:00:00Z' }), who('b', { wroteAt: '2026-11-02T10:00:00Z' })]
    expect(placedUnder(list)).toBe('b')
  })

  test('a person who only received mail never beats one who wrote (the Craigslist relay and seller)', () => {
    const relay = who('relay', { touchedAt: '2026-11-03T10:00:00Z' })
    const seller = named('seller', { wroteAt: '2026-11-02T10:00:00Z', touchedAt: '2026-11-02T10:00:00Z' })
    expect(placedUnder([relay, seller])).toBe('seller')
    expect(placedUnder([seller, relay])).toBe('seller')
  })

  test('a tie goes to the person with a name over a bare address', () => {
    const at = '2026-11-02T10:00:00Z'
    expect(placedUnder([who('a', { wroteAt: at }), named('b', { wroteAt: at })])).toBe('b')
  })

  test('when nobody wrote, a name wins, then the newest message with them, then the id', () => {
    expect(placedUnder([who('a', { touchedAt: '2026-11-03T00:00:00Z' }), named('b')])).toBe('b')
    expect(
      placedUnder([who('a', { touchedAt: '2026-11-01T00:00:00Z' }), who('b', { touchedAt: '2026-11-03T00:00:00Z' })]),
    ).toBe('b')
    expect(placedUnder([who('b'), who('a')])).toBe('a')
  })

  test('Tessa’s own addresses and the team never own the row while an outsider is on the thread, though they wrote last', () => {
    const arun = named('arun', { wroteAt: '2026-11-01T10:00:00Z' })
    const tessa = named('tessa', { inside: true, wroteAt: '2026-11-03T10:00:00Z', touchedAt: '2026-11-03T10:00:00Z' })
    const priya = named('priya', { inside: true, wroteAt: '2026-11-04T10:00:00Z' })
    expect(placedUnder([tessa, arun])).toBe('arun')
    expect(placedUnder([priya, tessa, who('cold', { touchedAt: '2026-11-01T00:00:00Z' })])).toBe('cold')
  })

  test('with no outsider on it the thread falls back to the inside ones by the same rule', () => {
    const a = named('a', { inside: true, wroteAt: '2026-11-01T10:00:00Z' })
    const b = who('b', { inside: true, wroteAt: '2026-11-02T10:00:00Z' })
    expect(placedUnder([a, b])).toBe('b')
  })

  test('nobody on it is placed under nobody', () => {
    expect(placedUnder([])).toBeNull()
  })
})

describe('isInside', () => {
  test('any address of the contact being one of ours makes it inside, whatever the case', () => {
    const inside = new Set(['tessa@ashgrove.example', 'priya@northfield.example'])
    expect(isInside(['x@y.example', 'Tessa@Ashgrove.example'], inside)).toBe(true)
    expect(isInside(['x@y.example'], inside)).toBe(false)
    expect(isInside([], inside)).toBe(false)
  })
})

describe('hasDisplayName', () => {
  test('a name that is only one of the contact’s addresses is a bare address', () => {
    expect(hasDisplayName('abc@reply.craigslist.org', ['ABC@reply.craigslist.org'])).toBe(false)
    expect(hasDisplayName('', ['a@x.example'])).toBe(false)
    expect(hasDisplayName('Craigslist seller (Harbour Road roof box)', ['abc@sale.craigslist.org'])).toBe(true)
  })
})

describe('placeConversation', () => {
  const client = (contactId: string, clientId: number | null, over: Partial<PlacementCandidate> = {}) => ({
    ...named(contactId, over),
    clientId,
  })

  test('the Inbox places among everyone and a Client’s list among that Client’s people only', () => {
    const harbor = client('harbor', 7, { wroteAt: '2026-11-01T10:00:00Z' })
    const outsider = client('outsider', null, { wroteAt: '2026-11-02T10:00:00Z' })
    const placed = placeConversation([harbor, outsider])
    expect(placed.everyone).toBe('outsider')
    expect(placed.byClient.get(7)).toBe('harbor')
  })

  test('each Client picks among its own people, and a contact with no Client is in no Client’s list', () => {
    const placed = placeConversation([
      client('a', 7, { wroteAt: '2026-11-01T10:00:00Z' }),
      client('b', 7, { wroteAt: '2026-11-02T10:00:00Z' }),
      client('c', 9, { wroteAt: '2026-11-01T10:00:00Z' }),
      client('d', null, { wroteAt: '2026-11-03T10:00:00Z' }),
    ])
    expect([placed.everyone, placed.byClient.get(7), placed.byClient.get(9), placed.byClient.size]).toEqual([
      'd',
      'b',
      'c',
      2,
    ])
  })
})
