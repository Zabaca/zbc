// The small wording functions of a conversation, and the address a conversation lives at.
import { describe, expect, test } from 'bun:test'
import { joined, partNotices, profileFacts, senderName, stamp } from '../src/client/convo'
import { conversationKey, conversationPath, inboxPath, meetPath } from '../src/client/route'
import { parseKey } from '../src/conversation'

const NOW = Date.UTC(2026, 10, 2, 20, 0, 0)

describe('names and times', () => {
  test('a sender is the name on the From line, or the address when there is no name', () => {
    expect(senderName('Dana Reyes <dana@x.example>')).toBe('Dana Reyes')
    expect(senderName('"Reyes, Dana" <dana@x.example>')).toBe('Reyes, Dana')
    expect(senderName('dana@x.example')).toBe('dana@x.example')
    expect(senderName('<dana@x.example>')).toBe('<dana@x.example>')
  })

  test('a time is the clock today, the date and clock before, and the year when it is not this one', () => {
    expect(stamp(NOW, NOW - 3_600_000, 'UTC')).toBe('7:00 PM')
    expect(stamp(NOW, NOW - 3 * 86_400_000, 'UTC')).toBe('Oct 30, 8:00 PM')
    expect(stamp(NOW, Date.UTC(2025, 11, 30, 9, 5), 'UTC')).toBe('Dec 30, 2025, 9:05 AM')
  })

  test('names are joined as a sentence', () => {
    expect([joined([]), joined(['A']), joined(['A', 'B']), joined(['A', 'B', 'C'])]).toEqual(['', 'A', 'A and B', 'A, B and C'])
  })
})

describe('what a part that did not answer says', () => {
  test('a part that could not be reached is a warning naming what is missing; one that said no is quiet and says it does not open to you', () => {
    const [down] = partNotices([{ part: 'chat', state: 'could-not-be-reached', reason: 'timed-out' }])
    expect(down).toEqual({ kind: 'unreachable', part: 'chat', text: 'Chat took too long to answer just now, so its messages are missing here. It will be tried again.' })
    const [no] = partNotices([{ part: 'mail', state: 'not-open-to-you', refusal: { ok: false, kind: 'refused', reason: 'not-admitted', message: 'x' } }])
    expect(no).toEqual({ kind: 'refused', part: 'mail', text: 'Email is not open to you.' })
    expect(partNotices([{ part: 'mail', state: 'ok' }])).toEqual([])
  })
})

describe('the profile', () => {
  test('an outsider’s facts are their Client and addresses; People’s own fields are the editable boxes under them, not facts here', () => {
    expect(profileFacts({ kind: 'outside', name: 'Dana', client: null, addresses: ['d@x.example', 'e@x.example'], chat: false })).toEqual([
      ['Client', 'Not linked to a Client'],
      ['Email', 'd@x.example, e@x.example'],
    ])
  })
  test('a teammate’s are the company layer’s: role, address, and the address their sign-in goes to when it differs', () => {
    expect(profileFacts({ kind: 'team', name: 'Corin', address: 'corin@lane.test', signIn: 'corin_p@gmail.com', role: 'owner', chat: true })).toEqual([
      ['Role', 'Owner'],
      ['Email', 'corin@lane.test'],
      ['Signs in with', 'corin_p@gmail.com'],
    ])
  })
})

describe('where a conversation lives', () => {
  test('its key is one path segment and comes back whatever it holds', () => {
    for (const key of ['dana@x.example', 'chat:channel:21', 'mail:c-text', 'a b@x.example', 'x/y@z.example']) {
      expect(conversationKey(conversationPath('mail', key), 'mail')).toBe(key)
      expect(conversationKey(conversationPath('chat', key), 'chat')).toBe(key)
    }
    expect(inboxPath('dana@x.example')).toBe('/inbox/dana%40x.example')
    expect(meetPath('chat:channel:21')).toBe('/meet/chat%3Achannel%3A21')
  })

  test('the list, another tab and a malformed segment name no conversation', () => {
    for (const path of ['/inbox', '/inbox/', '/today/dana', '/inbox/a/b', '/inbox/%E0%A4%A', '/meet/dana', '/conversations/dana']) expect([path, conversationKey(path, 'mail')]).toEqual([path, null])
    for (const path of ['/meet', '/meet/', '/today/dana', '/meet/a/b', '/meet/%E0%A4%A', '/inbox/dana', '/conversations/dana']) expect([path, conversationKey(path, 'chat')]).toEqual([path, null])
  })

  test('the Worker reads a key as an address, a contact, a person or a channel, and nothing else', () => {
    expect(parseKey('Dana@X.Example')).toEqual({ kind: 'address', address: 'dana@x.example' })
    expect(parseKey('mail:c-text')).toEqual({ kind: 'contact', contactId: 'c-text' })
    expect(parseKey('chat:p-dana')).toEqual({ kind: 'person', personId: 'p-dana' })
    expect(parseKey('chat:channel:21')).toEqual({ kind: 'channel', conversationId: 21 })
    expect(parseKey('dana@x.example|mail:c-2')).toEqual({ kind: 'address', address: 'dana@x.example' })
    for (const bad of ['', 'mail:', 'chat:', 'nobody', 'chat:channel:x']) expect([bad, parseKey(bad)]).toEqual([bad, bad === 'chat:channel:x' ? { kind: 'person', personId: 'channel:x' } : null])
  })
})
