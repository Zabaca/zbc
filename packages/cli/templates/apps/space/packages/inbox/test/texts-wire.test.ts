import { describe, expect, test } from 'bun:test'
import { LIMITS, parseEvents, parseOutcomes, parsePush, parseStatus, parseWorkRequest } from '../src/texts/wire'

/** The texts bridge's contract (src/texts/wire.ts, docs/texts-bridge-wire.md): the parser takes the documented examples and refuses what is out of shape or bounds. */

const account = { id: 'phone-1' }
const person = { id: 'c-101', kind: 'person', name: 'Dana Whitfield', address: '+15555550123' }
const msg = (over: Record<string, unknown> = {}) => ({
  chatId: 'c-101',
  id: 'm-1',
  at: '2026-01-05T17:03:09Z',
  out: false,
  read: false,
  text: 'hello',
  ...over,
})

describe('push', () => {
  test('takes the documented example and keeps only the fields it knows', () => {
    const parsed = parsePush({
      account,
      mirror: false,
      chats: [
        person,
        { id: 'c-202', kind: 'short-code', name: '55501', address: '55501' },
        { id: 'c-303', kind: 'named-sender', name: 'Example Bank', address: 'ExampleBank', extra: 'dropped' },
        { id: 'c-404', kind: 'business', name: 'Example Air', address: 'example-air-agent' },
      ],
      messages: [
        msg({ sender: { address: '+15555550123', name: 'Dana Whitfield' }, unknown: 1 }),
        msg({ id: 'm-2', out: true, read: false, text: 'ok' }),
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.chats).toHaveLength(4)
    expect((parsed.value.chats[2] as unknown as Record<string, unknown>).extra).toBeUndefined()
    expect(parsed.value.messages[0]).toEqual({
      chatId: 'c-101',
      id: 'm-1',
      at: '2026-01-05T17:03:09.000Z',
      out: false,
      text: 'hello',
      read: false,
      sender: { address: '+15555550123', name: 'Dana Whitfield' },
    })
    // The owner's own text is read, whatever the bridge said, and names no sender.
    expect(parsed.value.messages[1]).toMatchObject({ out: true, read: true })
    expect(parsed.value.messages[1]?.sender).toBeUndefined()
  })

  test('a group is accepted by the parser, with members', () => {
    const parsed = parsePush({
      account,
      chats: [{ id: 'g-1', kind: 'group', name: 'Book club', members: [{ address: '+15555550124', name: 'Eli' }] }],
      messages: [msg({ chatId: 'g-1', sender: { name: 'Eli' } })],
    })
    expect(parsed.ok).toBe(true)
  })

  test.each([
    ['a person with no number', { id: 'c-1', kind: 'person', name: 'x' }],
    ['a person with a number that is not E.164', { id: 'c-1', kind: 'person', name: 'x', address: '5555550123' }],
    ['a short code with letters', { id: 'c-1', kind: 'short-code', name: 'x', address: '55a01' }],
    ['a short code too long', { id: 'c-1', kind: 'short-code', name: 'x', address: '123456789' }],
    ['a group with an address', { id: 'g-1', kind: 'group', name: 'x', address: '+15555550123' }],
    ['a person with members', { ...person, members: [] }],
    ['an unknown kind', { id: 'c-1', kind: 'robot', name: 'x', address: 'x' }],
    ['a colon in the id', { ...person, id: 'a:b' }],
    ['a control character in a name', { ...person, name: 'a\u0000b' }],
    ['a name that is too long', { ...person, name: 'x'.repeat(LIMITS.name + 1) }],
  ])('refuses %s', (_why, chat) => {
    expect(parsePush({ account, chats: [chat], messages: [] }).ok).toBe(false)
  })

  test.each([
    ['no id', msg({ id: undefined })],
    ['a colon in the id', msg({ id: 'a:b' })],
    ['a time that is not ISO', msg({ at: 'yesterday' })],
    ['out that is not a boolean', msg({ out: 'yes' })],
    ['no read state', msg({ read: undefined })],
    ['text that is too long', msg({ text: 'x'.repeat(LIMITS.text + 1) })],
    ['a sender with a bad number', msg({ sender: { address: '12', name: 'x' } })],
  ])('refuses a message with %s', (_why, m) => {
    expect(parsePush({ account, chats: [person], messages: [m] }).ok).toBe(false)
  })

  test('refuses a body past its bounds, a bad account and a non-object', () => {
    expect(parsePush(null).ok).toBe(false)
    expect(parsePush({ account: { id: 'a:b' }, chats: [], messages: [] }).ok).toBe(false)
    expect(parsePush({ account, chats: [], messages: Array(LIMITS.messagesPerPush + 1).fill(msg()) }).ok).toBe(false)
    expect(parsePush({ account, chats: Array(LIMITS.chatsPerPush + 1).fill(person), messages: [] }).ok).toBe(false)
    expect(parsePush({ account, mirror: 'yes', chats: [], messages: [] }).ok).toBe(false)
  })
})

describe('events, work, outcomes and status', () => {
  test('events take edits, deletions and read marks', () => {
    const parsed = parseEvents({
      account,
      edits: [{ chatId: 'c-101', id: 'm-1', text: 'new', at: '2026-01-05T17:06:00Z' }],
      deletions: [{ chatId: 'c-101', ids: ['m-2'], at: '2026-01-05T17:07:00Z' }],
      reads: [{ chatId: 'c-101', upTo: '2026-01-05T17:05:00Z', at: '2026-01-05T17:08:00Z' }],
    })
    expect(parsed.ok).toBe(true)
    expect(
      parseEvents({ account, edits: [], deletions: [{ chatId: 'c-1', ids: [], at: '2026-01-05T17:07:00Z' }] }).ok,
    ).toBe(false)
    expect(parseEvents({ account, edits: [] }).ok).toBe(false)
  })

  test('work carries capability flags, and a flag that is not a boolean is refused', () => {
    expect(parseWorkRequest({ account })).toEqual({ ok: true, value: { account } })
    expect(parseWorkRequest({ account, newest: true, sends: true, media: true, pictures: true, future: 1 })).toEqual({
      ok: true,
      value: { account, newest: true, sends: true, media: true, pictures: true },
    })
    expect(parseWorkRequest({ account, sends: 'yes' }).ok).toBe(false)
  })

  test('outcomes take a fill, done or failed with a short reason, and nothing else', () => {
    expect(
      parseOutcomes({
        account,
        outcomes: [
          { kind: 'fill', chatId: 'c-1', ok: true },
          { kind: 'fill', chatId: 'c-2', ok: false, reason: 'CONVERSATION_NOT_FOUND' },
        ],
      }).ok,
    ).toBe(true)
    expect(
      parseOutcomes({ account, outcomes: [{ kind: 'fill', chatId: 'c-2', ok: false, reason: 'a, b: <x>' }] }).ok,
    ).toBe(false)
    expect(parseOutcomes({ account, outcomes: [{ kind: 'send', chatId: 'c-2', ok: true }] }).ok).toBe(false)
  })

  test('status names one of five states, and a phone not answering says since when', () => {
    for (const state of ['live', 'catching-up', 'signed-out', 'session-taken'])
      expect(parseStatus({ account, state }).ok).toBe(true)
    expect(parseStatus({ account, state: 'phone-not-answering' }).ok).toBe(false)
    expect(parseStatus({ account, state: 'phone-not-answering', since: '2026-01-05T16:40:00Z' })).toEqual({
      ok: true,
      value: { account, state: 'phone-not-answering', since: '2026-01-05T16:40:00.000Z' },
    })
    expect(parseStatus({ account, state: 'asleep' }).ok).toBe(false)
  })
})
