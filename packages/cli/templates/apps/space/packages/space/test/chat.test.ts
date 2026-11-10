// Messages and a person's own settings in the space, driven through the real router with a stand-in meet behind the binding. What is asserted is what a person
// sees or what is refused: that every new path is behind the sign-in, that a write goes through the one POST guard (this host's Origin, a JSON body), that meet's refusals arrive in meet's words,
// that a first message to someone is one direct message and one message however often it is pressed, that a lost write is never asked again, and where "New" begins. The rules themselves
// (you edit only your own, the owner deletes another's, a message in a conversation you are not in is "no such message", a nudge is a boolean) are meet's, proved in
// packages/meet/test/space-messages.test.ts over the real Workspace core.
import { describe, expect, test } from 'bun:test'
import type { MeetDeleted, MeetMe, MeetMessage, MeetReachable } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import { newFromOf, parseChat, type ConversationAnswer } from '../src/conversation'
import { parseDelete, parseEdit, parseMeUpdate, unreadIn } from '../src/chat'
import type { ConversationsAnswer } from '../src/conversations'
import type { ViewAnswer } from '../src/views'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { NORTHFIELD_TEAM, ago, channel, contact, dm, person, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')
const ben = person('p-ben', 'Ben Walker', 'ben@northfield.example', 'teammate')
const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const rosa = person('p-rosa', 'Rosa Whitfield', 'rosa@yahoo.example')

const mine = (id: number, text: string, at = ago(10)) => ({ id, at, authorId: 'p-tessa', authorName: 'Tessa', text })
const theirs = (id: number, text: string, at = ago(10)) => ({ id, at, authorId: 'p-priya', authorName: 'Priya', text })

async function asOwner(o: { noMeet?: boolean; owner?: boolean; writeWithinMs?: number } = {}) {
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [])
  const meet = standInMeet(
    {
      direct: [dm(11, priya, ago(5), 2, 'Third'), dm(12, dana, null)],
      channels: [{ ...channel(21, 'launch', ago(60), 1), memberCount: 3 }],
    },
    {
      history: {
        11: [theirs(110, 'First', ago(30)), mine(111, 'Reply', ago(20)), theirs(112, 'Second', ago(10)), theirs(113, 'Third', ago(5))],
        21: [mine(210, 'Hello channel', ago(70)), theirs(211, 'Staging: https://staging.example/book', ago(60))],
      },
      channels: {
        owner: o.owner ?? true,
        people: [
          { ...priya, direct: true },
          { ...ben },
          { ...dana },
          { ...rosa },
        ],
        rooms: { 21: { createdByMe: false, members: ['p-priya', 'p-rosa'] } },
      },
    },
  )
  const w = await world(northfield(), NORTHFIELD_TEAM, o.noMeet ? { inbox: inbox } : { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60, writeWithinMs: o.writeWithinMs ?? 200 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await w.call(path, { jwt })
    return { status: res.status, body: (await res.json().catch(() => null)) as T }
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    w.call(path, { method: 'POST', jwt, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const answer = async <T>(path: string, body: unknown): Promise<ViewAnswer<T>> => (await (await post(path, body)).json()) as ViewAnswer<T>
  return { w, jwt, inbox, meet, get, post, answer }
}

const EDIT = '/api/meet/message-edit'
const DELETE = '/api/meet/message-delete'
const UPDATE = '/api/meet/me-update'
const ACK = '/api/meet/privacy-ack'
const READS = ['/api/meet/people', '/api/meet/me', '/api/meet/unread']

describe('every new path is behind the sign-in', () => {
  test('no sign-in is refused at every new path, reads and writes, and meet is never asked', async () => {
    const s = await asOwner()
    for (const path of READS) expect([path, (await s.w.call(path)).status]).toEqual([path, 401])
    const writes: Array<[string, unknown]> = [
      [EDIT, { messageId: 111, text: 'x' }],
      [DELETE, { messageId: 111 }],
      [UPDATE, { nudgesOff: true }],
      [ACK, {}],
      ['/api/chat', { key: key(1), personId: 'p-ben', text: 'hello' }],
    ]
    for (const [path, body] of writes) {
      const res = await s.w.call(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect([path, res.status]).toEqual([path, 401])
    }
    expect(s.meet.asked.askers).toEqual([])
    expect(s.meet.changes).toMatchObject({ edits: [], deletes: [], updates: [], acknowledged: 0 })
    expect(s.meet.posted).toEqual([])
  })

  test('a person Cloudflare signed for who is not of this company, a cookie alone, and an assertion for another application are all refused', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('eve@elsewhere.test')
    const json = { origin: ORIGIN, 'content-type': 'application/json' }
    for (const [path, body] of [[EDIT, { messageId: 111, text: 'x' }], [DELETE, { messageId: 111 }], [UPDATE, { name: 'Eve' }], [ACK, {}]] as const) {
      const cookieOnly = await s.w.call(path, { method: 'POST', cookieJwt: s.jwt, headers: json, body: JSON.stringify(body) })
      const outsider = await s.w.call(path, { method: 'POST', jwt: stranger, headers: json, body: JSON.stringify(body) })
      const forms = await s.w.call(path, { method: 'POST', jwt: await s.w.signInForms('tessa@northfield.example'), headers: json, body: JSON.stringify(body) })
      expect([path, cookieOnly.status, outsider.status, forms.status]).toEqual([path, 401, 403, 401])
    }
    for (const path of READS) {
      expect([path, (await s.w.call(path, { jwt: stranger })).status]).toEqual([path, 403])
      expect([path, (await s.w.call(path, { cookieJwt: s.jwt })).status]).toEqual([path, 401])
    }
    expect(s.meet.asked.askers).toEqual([])
    expect(s.meet.changes).toMatchObject({ edits: [], deletes: [], updates: [], acknowledged: 0 })
  })
})

describe('every write goes through the one POST guard', () => {
  test('another site’s write, a body that is not JSON, other methods and other paths are refused before meet is asked', async () => {
    const s = await asOwner()
    for (const [path, body] of [[EDIT, { messageId: 111, text: 'x' }], [DELETE, { messageId: 111 }], [UPDATE, { nudgesOff: true }], [ACK, {}]] as const) {
      expect([path, (await s.post(path, body, { origin: 'https://evil.example' })).status]).toEqual([path, 403])
      expect([path, (await s.w.call(path, { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status]).toEqual([path, 415])
      expect([path, (await s.w.call(path, { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN } })).status]).toEqual([path, 415])
      expect([path, (await s.w.call(path, { method: 'PUT', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status]).toEqual([path, 405])
      expect([path, (await s.w.call(path, { method: 'DELETE', jwt: s.jwt, headers: { origin: ORIGIN } })).status]).toEqual([path, 405])
      expect([path, (await s.w.call(path, { method: 'PATCH', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status]).toEqual([path, 405])
    }
    // A write path that is not one: nothing is accepted on it. (The reads take no POST either.)
    for (const path of ['/api/meet/message-purge', '/api/meet/people', '/api/meet/me', '/api/meet/unread']) expect([path, (await s.post(path, {})).status]).toEqual([path, 405])
    expect(s.meet.changes).toMatchObject({ edits: [], deletes: [], updates: [], acknowledged: 0 })
  })

  test('a body that is not what the write takes is a 400 and meet is not asked', async () => {
    const s = await asOwner()
    const bad: Array<[string, unknown]> = [
      [EDIT, { text: 'x' }],
      [EDIT, { messageId: '111', text: 'x' }],
      [EDIT, { messageId: -1, text: 'x' }],
      [EDIT, { messageId: 111 }],
      [EDIT, { messageId: 111, text: 7 }],
      [EDIT, { messageId: 111, text: 'x'.repeat(10_001) }],
      [EDIT, []],
      [DELETE, {}],
      [DELETE, { messageId: 'all' }],
      [DELETE, { messageId: 1.5 }],
      [UPDATE, {}],
      [UPDATE, { nudgesOff: 'false' }],
      [UPDATE, { nudgesOff: 0 }],
      [UPDATE, { nudgesOff: null }],
      [UPDATE, { name: 7 }],
      [UPDATE, { name: 'x'.repeat(201) }],
      [UPDATE, []],
    ]
    for (const [path, body] of bad) expect([path, JSON.stringify(body).slice(0, 40), (await s.post(path, body)).status]).toEqual([path, JSON.stringify(body).slice(0, 40), 400])
    expect(s.meet.changes).toMatchObject({ edits: [], deletes: [], updates: [], acknowledged: 0 })
  })

  test('the parsers take only what meet takes', () => {
    expect(parseEdit({ messageId: 5, text: 'words', extra: 'ignored' })).toEqual({ ok: true, value: { messageId: 5, text: 'words' } })
    expect(parseDelete({ messageId: 5 })).toEqual({ ok: true, value: 5 })
    expect(parseMeUpdate({ name: 'Ana', nudgesOff: true })).toEqual({ ok: true, value: { name: 'Ana', nudgesOff: true } })
    expect(parseMeUpdate({ nudgesOff: false })).toEqual({ ok: true, value: { nudgesOff: false } })
    expect(parseMeUpdate({ name: '   ' }).ok).toBe(true) // meet says "Your name cannot be empty." in its own words
    expect(parseMeUpdate({ nudgesOff: undefined, name: undefined }).ok).toBe(false)
    // Too long is said as too long, in meet's words, and not as nothing written.
    expect(parseEdit({ messageId: 5, text: 'x'.repeat(10_001) })).toEqual({ ok: false, message: 'A message is at most 2,000 characters.' })
    expect(parseEdit({ messageId: 5, text: 7 })).toEqual({ ok: false, message: 'A message needs words.' })
    expect(parseMeUpdate({ name: 'x'.repeat(201) })).toEqual({ ok: false, message: 'A name is one line of at most 40 characters.' })
    expect(parseMeUpdate({ name: 7 })).toEqual({ ok: false, message: 'Your name cannot be empty.' })
  })
})

describe('editing and deleting a message', () => {
  test('the history says what the person may do with each message, as meet says it, and the assertion is the request’s own', async () => {
    const s = await asOwner()
    const opened = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    const chat = opened.sources.find((x) => x.kind === 'chat')
    if (chat?.kind !== 'chat') throw new Error('no chat')
    expect(chat.messages.map((m) => [m.id, m.mine, m.may])).toEqual([
      [110, false, { edit: false, delete: true }], // the owner deletes another's
      [111, true, { edit: true, delete: true }],
      [112, false, { edit: false, delete: true }],
      [113, false, { edit: false, delete: true }],
    ])
    expect(s.meet.asked.askers.every((a) => a === 'tessa@northfield.example')).toBe(true)
  })

  test('someone who is not the owner is not told they may delete another’s', async () => {
    const s = await asOwner({ owner: false })
    const opened = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    const chat = opened.sources.find((x) => x.kind === 'chat')
    if (chat?.kind !== 'chat') throw new Error('no chat')
    expect(chat.messages.map((m) => m.may)).toEqual([
      { edit: false, delete: false },
      { edit: true, delete: true },
      { edit: false, delete: false },
      { edit: false, delete: false },
    ])
  })

  test('an edit changes the words and says edited; the next read of the conversation has it', async () => {
    const s = await asOwner()
    const edited = await s.answer<MeetMessage>(EDIT, { messageId: 111, text: 'Reply, with a fix' })
    expect(edited).toMatchObject({ result: 'ok', value: { id: 111, text: 'Reply, with a fix', mine: true } })
    expect((edited as { value: MeetMessage }).value.editedAt).not.toBeNull()
    expect(s.meet.changes.edits).toEqual([{ messageId: 111, text: 'Reply, with a fix' }])
    const opened = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    const chat = opened.sources.find((x) => x.kind === 'chat')
    if (chat?.kind !== 'chat') throw new Error('no chat')
    expect(chat.messages.find((m) => m.id === 111)).toMatchObject({ text: 'Reply, with a fix', edited: true })
    // The list's row shows the newest message as it now stands.
    const edit2 = await s.answer<MeetMessage>(EDIT, { messageId: 113, text: 'not mine' })
    expect(edit2).toMatchObject({ result: 'refused', reason: 'not-admitted', message: 'You can edit only your own messages.' })
  })

  test('meet’s refusals come in meet’s words: nobody else’s, nothing empty, no such message', async () => {
    const s = await asOwner()
    expect(await s.answer(EDIT, { messageId: 112, text: 'mine now' })).toMatchObject({ result: 'refused', reason: 'not-admitted', message: 'You can edit only your own messages.' })
    expect(await s.answer(EDIT, { messageId: 111, text: '   ' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'A message cannot be empty. Delete it instead.' })
    expect(await s.answer(EDIT, { messageId: 999, text: 'x' })).toMatchObject({ result: 'refused', reason: 'not-found', message: 'There is no such message.' })
    expect(await s.answer(DELETE, { messageId: 999 })).toMatchObject({ result: 'refused', reason: 'not-found', message: 'There is no such message.' })
  })

  test('a delete removes the message for good, the owner’s of another’s too, and a second press finds nothing', async () => {
    const s = await asOwner()
    expect(await s.answer<MeetDeleted>(DELETE, { messageId: 111 })).toEqual({ result: 'ok', value: { conversationId: 11, messageId: 111 } })
    expect(await s.answer<MeetDeleted>(DELETE, { messageId: 112 })).toEqual({ result: 'ok', value: { conversationId: 11, messageId: 112 } })
    expect(await s.answer(DELETE, { messageId: 111 })).toMatchObject({ result: 'refused', reason: 'not-found' })
    const opened = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    const chat = opened.sources.find((x) => x.kind === 'chat')
    if (chat?.kind !== 'chat') throw new Error('no chat')
    expect(chat.messages.map((m) => m.id)).toEqual([110, 113])
  })

  test('a delete that is not the owner’s of another person’s message is refused in meet’s words and nothing goes', async () => {
    const s = await asOwner({ owner: false })
    expect(await s.answer(DELETE, { messageId: 112 })).toMatchObject({ result: 'refused', reason: 'not-admitted', message: 'You can delete only your own messages.' })
    expect(await s.answer(DELETE, { messageId: 111 })).toMatchObject({ result: 'ok' })
  })

  test('a write the space loses track of is outcome-unknown and is not asked again; meet not connected is said, not thrown', async () => {
    const s = await asOwner({ writeWithinMs: 40 })
    s.meet.script.write.push('throw', 'hang', 'throw')
    expect(await s.answer(EDIT, { messageId: 111, text: 'x' })).toMatchObject({ result: 'outcome-unknown' })
    expect(await s.answer(DELETE, { messageId: 111 })).toMatchObject({ result: 'outcome-unknown' })
    expect(await s.answer(UPDATE, { nudgesOff: true })).toMatchObject({ result: 'outcome-unknown' })
    expect(s.meet.changes.edits).toHaveLength(1)
    expect(s.meet.changes.deletes).toHaveLength(1)
    expect(s.meet.changes.updates).toHaveLength(1)
    const none = await asOwner({ noMeet: true })
    expect(await none.answer(EDIT, { messageId: 111, text: 'x' })).toMatchObject({ result: 'unreachable' })
    expect(await none.answer(ACK, {})).toMatchObject({ result: 'unreachable' })
    expect((await none.get<ViewAnswer<unknown>>('/api/meet/people')).body).toMatchObject({ result: 'unreachable' })
  })
})

describe('a first direct message', () => {
  test('meet’s list of people: everyone the person may write to, with whether there is a conversation to open', async () => {
    const s = await asOwner()
    const got = (await s.get<ViewAnswer<MeetReachable[]>>('/api/meet/people')).body
    expect(got).toMatchObject({ result: 'ok' })
    const list = (got as { value: MeetReachable[] }).value
    // Priya has a direct message with something in it; Dana has one with nothing in it; Ben is a teammate; Rosa shares #launch.
    expect(list.map((p) => [p.person.name, p.direct])).toEqual([
      ['Ben Walker', false],
      ['Dana Reyes', false],
      ['Priya Natarajan', true],
      ['Rosa Whitfield', false],
    ])
    expect(s.meet.changes.peopleReads).toBe(1)
  })

  test('a guest who shares no channel with the person is not offered', async () => {
    const s = await asOwner()
    s.meet.admin.people.push({ id: 'p-lena', name: 'Lena Ortiz', kind: 'guest', address: 'lena@cafe.example' })
    const list = ((await s.get<ViewAnswer<MeetReachable[]>>('/api/meet/people')).body as { value: MeetReachable[] }).value
    expect(list.map((p) => p.person.name)).not.toContain('Lena Ortiz')
  })

  test('the first message to someone with no conversation opens one, and pressing twice with the same key is one direct message and one message', async () => {
    const s = await asOwner()
    const body = { key: key(1), personId: 'p-ben', text: 'Welcome aboard, Ben' }
    const first = await (await s.post('/api/chat', body)).json()
    const again = await (await s.post('/api/chat', body)).json()
    expect(first).toEqual({ result: 'done', status: 'sent' })
    expect(again).toMatchObject({ result: 'repeated' })
    expect(s.meet.posted).toHaveLength(1)
    // The conversation is now a row, found by the address the page opens it by.
    const list = (await s.get<ConversationsAnswer>('/api/conversations')).body
    expect(list.rows.some((r) => r.type === 'person' && r.addresses.includes('ben@northfield.example'))).toBe(true)
    const opened = await s.get<ConversationAnswer>(`/api/conversation?key=${encodeURIComponent('ben@northfield.example')}`)
    expect(opened.status).toBe(200)
    const chat = opened.body.sources.find((x) => x.kind === 'chat')
    expect(chat?.kind === 'chat' ? chat.messages.map((m) => m.text) : []).toEqual(['Welcome aboard, Ben'])
    const people = ((await s.get<ViewAnswer<MeetReachable[]>>('/api/meet/people')).body as { value: MeetReachable[] }).value
    expect(people.find((p) => p.person.id === 'p-ben')?.direct).toBe(true)
  })

  test('a message meet refuses opens nothing and gives the key back; the same key then sends it', async () => {
    const s = await asOwner()
    s.meet.script.post.push('limit')
    const body = { key: key(2), personId: 'p-ben', text: 'hello' }
    expect(await (await s.post('/api/chat', body)).json()).toMatchObject({ result: 'refused', reason: 'limit' })
    expect(s.meet.posted).toEqual([])
    expect(await (await s.post('/api/chat', body)).json()).toEqual({ result: 'done', status: 'sent' })
    expect(s.meet.posted).toHaveLength(1)
  })

  test('someone the person may not write to is not found, and nothing is made', async () => {
    const s = await asOwner()
    s.meet.admin.people.push({ id: 'p-lena', name: 'Lena Ortiz', kind: 'guest', address: 'lena@cafe.example' })
    expect(await (await s.post('/api/chat', { key: key(3), personId: 'p-lena', text: 'hi' })).json()).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(await (await s.post('/api/chat', { key: key(4), personId: 'p-nobody', text: 'hi' })).json()).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(s.meet.posted).toEqual([])
  })

  test('a first message names a person or a conversation, never both', () => {
    expect(parseChat({ key: key(1), text: 'x', personId: 'p-ben' }).ok).toBe(true)
    expect(parseChat({ key: key(1), text: 'x', personId: 'p-ben', conversationId: 11 }).ok).toBe(false)
  })
})

describe('a person’s own settings', () => {
  test('they are read, and each change is meet’s answer: the name, the nudge, the note', async () => {
    const s = await asOwner()
    expect((await s.get<ViewAnswer<MeetMe>>('/api/meet/me')).body).toMatchObject({ result: 'ok', value: { person: { name: 'Tessa' }, owner: true, nudgesOff: false, privacyAcked: false } })
    expect(await s.answer<MeetMe>(UPDATE, { name: '  Tessa   Y  ' })).toMatchObject({ result: 'ok', value: { person: { name: 'Tessa Y' } } })
    expect(await s.answer<MeetMe>(UPDATE, { nudgesOff: true })).toMatchObject({ result: 'ok', value: { nudgesOff: true, person: { name: 'Tessa Y' } } })
    expect(await s.answer<MeetMe>(ACK, {})).toMatchObject({ result: 'ok', value: { privacyAcked: true } })
    expect((await s.get<ViewAnswer<MeetMe>>('/api/meet/me')).body).toMatchObject({ value: { nudgesOff: true, privacyAcked: true, person: { name: 'Tessa Y' } } })
    expect(s.meet.changes.updates).toEqual([{ name: '  Tessa   Y  ' }, { nudgesOff: true }])
  })

  test('an empty name is refused in meet’s words and the name stays', async () => {
    const s = await asOwner()
    expect(await s.answer(UPDATE, { name: '   ' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'Your name cannot be empty.' })
    expect((await s.get<ViewAnswer<MeetMe>>('/api/meet/me')).body).toMatchObject({ value: { person: { name: 'Tessa' } } })
  })
})

describe('where "New" begins', () => {
  test('the first message from someone else that was unread when the conversation was opened', async () => {
    const s = await asOwner()
    // Priya has 2 unread: her second and third message. Her first was read; Tessa's own reply is not unread, whoever it follows.
    const first = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    expect(first.newFrom).toBe(112)
    // #launch has 1 unread: the last one, Priya's.
    const channelOpened = (await s.get<ConversationAnswer>(`/api/conversation?key=${encodeURIComponent('chat:channel:21')}`)).body
    expect(channelOpened.newFrom).toBe(211)
  })

  test('once it is read there is none, and a conversation nothing is unread in never has one', async () => {
    const s = await asOwner()
    const opened = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    expect(opened.read.chat).toEqual({ conversationId: 11, upTo: 113 })
    await s.post('/api/read', { mail: [], chat: opened.read.chat })
    expect(((await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body).newFrom).toBeNull()
  })

  test('the rule: the unread-th from the end among others’ messages, the oldest of them when the page holds fewer, none for nothing unread', () => {
    const m = (id: number, mine = false) => ({ id, mine })
    expect(newFromOf([m(1), m(2, true), m(3), m(4)], 2)).toBe(3)
    expect(newFromOf([m(1), m(2, true), m(3), m(4)], 3)).toBe(1)
    expect(newFromOf([m(1), m(2), m(3)], 9)).toBe(1)
    expect(newFromOf([m(1, true)], 1)).toBeNull()
    expect(newFromOf([m(1), m(2)], 0)).toBeNull()
    expect(newFromOf([], 3)).toBeNull()
  })
})

describe('the unread count the tab’s title shows', () => {
  test('it is every unread chat message, direct messages, channels and the Phone conversation', async () => {
    const s = await asOwner()
    expect((await s.get<ViewAnswer<{ unread: number }>>('/api/meet/unread')).body).toEqual({ result: 'ok', value: { unread: 3 } })
    expect(unreadIn({ direct: [], channels: [], phone: { conversationId: 9, newest: null, unread: 4 } })).toBe(4)
    expect(unreadIn({ direct: [], channels: [] })).toBe(0)
  })

  test('it falls when a conversation is read, and meet not answering is said, not zero', async () => {
    const s = await asOwner()
    await s.post('/api/read', { mail: [], chat: { conversationId: 11, upTo: 113 } })
    expect((await s.get<ViewAnswer<{ unread: number }>>('/api/meet/unread')).body).toEqual({ result: 'ok', value: { unread: 1 } })
    const none = await asOwner({ noMeet: true })
    expect((await none.get<ViewAnswer<unknown>>('/api/meet/unread')).body).toMatchObject({ result: 'unreachable' })
  })
})
