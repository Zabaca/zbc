// Calls in the space, driven through the real router with a stand-in meet behind the binding. What is asserted is what a person sees (a call card in
// a conversation, a row for a New call, the Phone row, meetings on Today in the company's day) or what is refused, never the Worker's internals: that every
// new path is behind the sign-in, that a write carries its key and its own Origin, that the meter's refusal is shown and releases the key, that a link is meet's and
// nothing the space makes, and that the phone's requests reach meet and nothing else of it.
import { describe, expect, test } from 'bun:test'
import { type MeetCall, type MeetCallRef, type MeetPhoneItem } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import type { ConversationAnswer } from '../src/conversation'
import type { ConversationsAnswer } from '../src/conversations'
import type { ViewAnswer } from '../src/views'
import { type StandInChatMessage, standInInbox, standInMeet } from '../src/stand-ins'
import type { TodayAnswer } from '../src/today-shape'
import { MIN, NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const HOUR = 60 * MIN
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`
const NAME = 'k7m2qx9frtn4w6hbc8jd'
const LINK = `https://space.northfield.example/r/${NAME}`

const call = (over: Partial<MeetCall> = {}): MeetCall => ({
  name: NAME,
  link: LINK,
  kind: 'huddle',
  title: null,
  madeBy: { name: 'Tessa', mine: true },
  madeAt: T0 - 20 * MIN,
  conversationId: null,
  home: null,
  startsAt: null,
  invitees: [],
  present: 0,
  people: 0,
  messages: 0,
  endedAt: null,
  openedAt: null,
  ...over,
})

const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')
const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')

interface Setup {
  callsHeld?: MeetCall[]
  newCalls?: MeetCallRef[]
  phone?: { conversationId: number; newest: { at: number; text: string } | null; unread: number } | null
  phoneItems?: MeetPhoneItem[] | null
  history?: Record<number, StandInChatMessage[]>
  threads?: Parameters<typeof standInInbox>[1]
  writeWithinMs?: number
  noMeet?: boolean
}

async function asOwner(o: Setup = {}) {
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-corin', 'Corin Pike', 'corin@client.example')], o.threads ?? [])
  const meet = standInMeet(
    { direct: [dm(11, priya, ago(30), 1, 'See you there'), dm(12, dana, null)], channels: [channel(21, 'launch', ago(60))], phone: o.phone ?? null, calls: o.newCalls },
    { callsHeld: o.callsHeld, history: o.history, phoneItems: o.phoneItems },
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

describe('reads: cards, past calls, a call’s chat, the month’s usage', () => {
  test('the cards of a direct message come as meet answers them, with meet’s own links, and meet is asked for that conversation and nothing else', async () => {
    const s = await asOwner({ callsHeld: [call({ conversationId: 11, present: 2 }), call({ name: 'x'.repeat(20), conversationId: 99 })] })
    const got = await s.get<ViewAnswer<MeetCall[]>>('/api/meet/cards?conversation=11')
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ result: 'ok', value: [{ name: NAME, link: LINK, present: 2 }] })
    expect(s.meet.made.cards).toEqual([{ conversationIds: [11], homes: [] }])
  })

  test('the cards of an email conversation are asked by its row’s key and addresses, and asking for none asks meet nothing', async () => {
    const s = await asOwner({ callsHeld: [call({ kind: 'link', home: 'corin@client.example' })] })
    const got = await s.get<ViewAnswer<MeetCall[]>>('/api/meet/cards?home=corin%40client.example&home=corin%40client.example&home=other%40x.example')
    expect(got.body).toMatchObject({ result: 'ok', value: [{ kind: 'link', home: 'corin@client.example' }] })
    expect(s.meet.made.cards).toEqual([{ conversationIds: [], homes: ['corin@client.example', 'other@x.example'] }])
    const none = await s.get<ViewAnswer<MeetCall[]>>('/api/meet/cards')
    expect(none.body).toEqual({ result: 'ok', value: [] })
    expect(s.meet.made.cards).toHaveLength(1)
    for (const bad of ['/api/meet/cards?conversation=abc', '/api/meet/cards?home=', `/api/meet/cards?home=${'x'.repeat(400)}`]) expect([bad, (await s.get(bad)).status]).toEqual([bad, 400])
  })

  test('past calls page by meet’s own cursor, handed back as it came; a cursor that is not one is refused before meet is asked', async () => {
    const many = Array.from({ length: 25 }, (_, i) => call({ name: String(i + 1).padStart(20, '0'), link: `https://space.northfield.example/r/${String(i + 1).padStart(20, '0')}`, kind: 'new', madeAt: T0 - (i + 1) * MIN }))
    const s = await asOwner({ callsHeld: many })
    const first = (await s.get<ViewAnswer<{ calls: MeetCall[]; next: string | null }>>('/api/meet/calls')).body
    const page1 = (first as { value: { calls: MeetCall[]; next: string } }).value
    expect(page1.next).toMatch(/^\d+:\d{20}$/)
    expect(page1.calls).toHaveLength(20)
    const secondGot = await s.get<ViewAnswer<{ calls: MeetCall[]; next: string | null }>>(`/api/meet/calls?after=${encodeURIComponent(page1.next)}`)
    const second = secondGot.body as { value: { calls: MeetCall[]; next: string | null } }
    expect(second.value.calls).toHaveLength(5)
    expect(second.value.next).toBeNull()
    const asks = s.meet.asked.askers.length
    expect((await s.get('/api/meet/calls?after=nope')).status).toBe(400)
    expect(s.meet.asked.askers.length).toBe(asks)
  })

  test('a call’s chat is read by its name (in meet’s groups of five too), and a name that is not one is refused before meet is asked', async () => {
    const s = await asOwner({ callsHeld: [call({ messages: 1 })] })
    s.meet.chats[NAME] = [{ id: 1, name: 'Dana', text: 'can you hear me', at: T0 }]
    for (const name of [NAME, 'K7M2Q-X9FRT-N4W6H-BC8JD']) {
      const got = await s.get<ViewAnswer<{ messages: unknown[] }>>(`/api/meet/call?name=${name}`)
      expect([name, got.body]).toMatchObject([name, { result: 'ok', value: { messages: [{ text: 'can you hear me' }] } }])
    }
    expect(await s.get<ViewAnswer<unknown>>(`/api/meet/call?name=${'z'.repeat(20)}`)).toMatchObject({ body: { result: 'refused', reason: 'not-found' } })
    const asks = s.meet.asked.askers.length
    expect((await s.get('/api/meet/call?name=short')).status).toBe(400)
    expect(s.meet.asked.askers.length).toBe(asks)
  })

  test('the month’s usage is meet’s, and a refusal is shown as a refusal', async () => {
    const s = await asOwner()
    s.meet.meter.usedGb = 312
    expect((await s.get<ViewAnswer<{ usedGb: number }>>('/api/meet/usage')).body).toMatchObject({ result: 'ok', value: { usedGb: 312, tripGb: 800, paused: false } })
    s.meet.usage = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/usage')).body).toMatchObject({ result: 'refused', reason: 'not-admitted' })
  })

  test('meet not connected, meet failing and an answer that is not the contract’s are each said, never half read', async () => {
    const none = await asOwner({ noMeet: true })
    expect((await none.get<ViewAnswer<unknown>>('/api/meet/usage')).body).toMatchObject({ result: 'unreachable', message: 'Chat is not connected to the space.' })
    const s = await asOwner({ callsHeld: [call()] })
    s.meet.calls = async () => {
      throw new Error('down')
    }
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/calls')).body).toMatchObject({ result: 'unreachable' })
    // A link that is no link, or a kind this space does not know, is an answer it cannot read.
    s.meet.cards = async () => ({ ok: true, value: [{ ...call(), link: 'javascript:alert(1)' }] })
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/cards?conversation=11')).body).toMatchObject({ result: 'unreachable', message: expect.stringContaining('could not read') })
    s.meet.cards = async () => ({ ok: true, value: [{ ...call(), kind: 'webinar' } as never] })
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/cards?conversation=11')).body).toMatchObject({ result: 'unreachable' })
  })

  test('the Phone conversation’s items come as meet answers them; a person with none is told so', async () => {
    const items: MeetPhoneItem[] = [
      { id: 7, at: ago(50), kind: 'voicemail', text: 'Voicemail from (626) 555-0100, 0:42', number: '+16265550100', display: '(626) 555-0100', seconds: 42 },
      { id: 8, at: ago(10), kind: 'missed', text: 'Missed call from (626) 555-0111', number: '+16265550111', display: '(626) 555-0111', seconds: null },
    ]
    const s = await asOwner({ phone: { conversationId: 90, newest: { at: ago(10), text: 'Missed call' }, unread: 2 }, phoneItems: items })
    s.meet.phoneUnread = 2
    expect((await s.get<ViewAnswer<{ items: MeetPhoneItem[]; unread: number }>>('/api/meet/phone')).body).toMatchObject({ result: 'ok', value: { unread: 2, items: [{ id: 7 }, { id: 8 }] } })
    expect((await s.answer('/api/meet/phone-read', { upTo: 8 }))).toEqual({ result: 'ok', value: { upTo: 8 } })
    expect((await s.get<ViewAnswer<{ unread: number }>>('/api/meet/phone')).body).toMatchObject({ value: { unread: 0 } })
    expect((await s.post('/api/meet/phone-read', { upTo: 'x' })).status).toBe(400)
    const nobody = await asOwner({ phoneItems: null })
    expect((await nobody.get<ViewAnswer<unknown>>('/api/meet/phone')).body).toMatchObject({ result: 'refused', reason: 'not-found' })
  })
})

describe('writes: a huddle, a call link, a New call, a meeting', () => {
  test('a huddle is meet’s to make: it is asked with the person’s assertion and the key, and the call comes back with meet’s link', async () => {
    const s = await asOwner()
    const got = await s.answer<MeetCall>('/api/meet/huddle', { key: key(1), conversationId: 11 })
    expect(got).toMatchObject({ result: 'ok', value: { kind: 'huddle', conversationId: 11, link: expect.stringMatching(/^https:\/\/space\.northfield\.example\/r\/\d{20}$/) } })
    expect(s.meet.made.huddles).toEqual([{ key: key(1), conversationId: 11 }])
    expect(s.meet.asked.askers.at(-1)).toBe('tessa@northfield.example')
  })

  test('pressing twice with one key is one call: the second answers the first', async () => {
    const s = await asOwner()
    const a = await s.answer<MeetCall>('/api/meet/huddle', { key: key(2), conversationId: 11 })
    const b = await s.answer<MeetCall>('/api/meet/huddle', { key: key(2), conversationId: 11 })
    expect(b).toEqual(a)
    expect(s.meet.callsHeld.filter((c) => c.kind === 'huddle')).toHaveLength(1)
  })

  test('the meter’s refusal is shown in meet’s words and releases the key, so the same key makes the call once calls resume', async () => {
    const s = await asOwner()
    s.meet.steps.call.push('limit')
    expect(await s.answer('/api/meet/call', { key: key(3), title: 'Weekly' })).toEqual({ result: 'refused', reason: 'limit', message: 'Calls are paused until 2026-12-01.' })
    expect(s.meet.callsHeld).toHaveLength(0)
    expect(await s.answer<MeetCall>('/api/meet/call', { key: key(3), title: 'Weekly' })).toMatchObject({ result: 'ok', value: { kind: 'new', title: 'Weekly', home: null } })
  })

  test('a call link names its conversation and a New call names none', async () => {
    const s = await asOwner()
    expect(await s.answer<MeetCall>('/api/meet/call', { key: key(4), home: 'corin@client.example' })).toMatchObject({ result: 'ok', value: { kind: 'link', home: 'corin@client.example' } })
    expect(await s.answer<MeetCall>('/api/meet/call', { key: key(5) })).toMatchObject({ result: 'ok', value: { kind: 'new', home: null } })
    expect(s.meet.made.calls).toEqual([{ key: key(4), home: 'corin@client.example' }, { key: key(5) }])
  })

  test('a meeting is booked with a time and the people invited, their addresses spelled as the contract spells them, and meet is asked to send nothing', async () => {
    const s = await asOwner()
    const at = T0 + 26 * HOUR
    const got = await s.answer<MeetCall>('/api/meet/meeting', { key: key(6), title: 'Kickoff', startsAt: at, home: 'corin@client.example', invitees: [{ name: 'Corin Pike', address: 'Corin@Client.example' }, { name: 'Dana', address: null }] })
    expect(got).toMatchObject({ result: 'ok', value: { kind: 'meeting', title: 'Kickoff', startsAt: at } })
    expect(s.meet.made.bookings[0]).toEqual({ key: key(6), title: 'Kickoff', startsAt: at, home: 'corin@client.example', invitees: [{ name: 'Corin Pike', address: 'corin@client.example' }, { name: 'Dana', address: null }] })
    // The space has no way to email: nothing was handed to the inbox.
    expect(s.inbox.asked.sends).toEqual([])
  })

  test('a write that is not shaped right is refused before meet is asked', async () => {
    const s = await asOwner()
    const bad: Array<[string, unknown]> = [
      ['/api/meet/huddle', { conversationId: 11 }],
      ['/api/meet/huddle', { key: 'short', conversationId: 11 }],
      ['/api/meet/huddle', { key: key(7) }],
      ['/api/meet/huddle', { key: key(7), conversationId: -1 }],
      ['/api/meet/call', { key: key(7), home: '' }],
      ['/api/meet/call', { key: key(7), title: 'x'.repeat(200) }],
      ['/api/meet/meeting', { key: key(7), title: 'T', startsAt: T0 }],
      ['/api/meet/meeting', { key: key(7), title: 'T', startsAt: T0, home: 'a@b.example', conversationId: 11 }],
      ['/api/meet/meeting', { key: key(7), title: '  ', startsAt: T0, home: 'a@b.example' }],
      ['/api/meet/meeting', { key: key(7), title: 'T', startsAt: 'soon', home: 'a@b.example' }],
      ['/api/meet/meeting', { key: key(7), title: 'T', startsAt: T0, home: 'a@b.example', invitees: [{ name: 'X', address: 'nope' }] }],
      ['/api/meet/meeting', { key: key(7), title: 'T', startsAt: T0, home: 'a@b.example', invitees: Array.from({ length: 21 }, () => ({ name: 'X', address: null })) }],
      ['/api/meet/delete-chat', { name: 'short' }],
    ]
    for (const [path, body] of bad) expect([path, JSON.stringify(body), (await s.post(path, body)).status]).toEqual([path, JSON.stringify(body), 400])
    expect(s.meet.asked.askers).toEqual([])
  })

  test('a write from another site, or not in JSON, is refused; a read name cannot be written and a write name cannot be read', async () => {
    const s = await asOwner()
    const body = { key: key(8), conversationId: 11 }
    expect((await s.post('/api/meet/huddle', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await s.w.call('/api/meet/huddle', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status).toBe(415)
    expect((await s.w.call('/api/meet/huddle', { method: 'POST', jwt: s.jwt, body: JSON.stringify(body) })).status).toBe(403) // no Origin at all
    expect((await s.post('/api/meet/usage', {})).status).toBe(405)
    expect((await s.get('/api/meet/huddle')).status).toBe(404)
    expect((await s.get('/api/meet/anything')).status).toBe(404)
    expect((await s.w.call('/api/meet/huddle', { method: 'PUT', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect(s.meet.made.huddles).toEqual([])
  })

  test('a connection that fails mid-write, or never answers, is outcome unknown, and nothing is retried', async () => {
    const s = await asOwner({ writeWithinMs: 40 })
    s.meet.steps.call.push('throw')
    expect(await s.answer('/api/meet/huddle', { key: key(9), conversationId: 11 })).toMatchObject({ result: 'outcome-unknown' })
    s.meet.steps.call.push('hang')
    expect(await s.answer('/api/meet/call', { key: key(10) })).toMatchObject({ result: 'outcome-unknown' })
    expect(s.meet.made.huddles).toHaveLength(1)
    expect(s.meet.made.calls).toHaveLength(1)
  })

  test('meet saying nothing went out (broken) is a failure that says so, and the key is free', async () => {
    const s = await asOwner()
    s.meet.steps.call.push('broken')
    expect(await s.answer('/api/meet/huddle', { key: key(11), conversationId: 11 })).toMatchObject({ result: 'failed' })
    expect(await s.answer('/api/meet/huddle', { key: key(11), conversationId: 11 })).toMatchObject({ result: 'ok' })
  })

  test('a call’s saved chat is deleted by meet’s rules, and the answer is meet’s', async () => {
    const s = await asOwner({ callsHeld: [call({ messages: 3 })] })
    s.meet.chats[NAME] = [{ id: 1, name: 'A', text: 'x', at: T0 }]
    expect(await s.answer('/api/meet/delete-chat', { name: NAME })).toEqual({ result: 'ok', value: { deleted: 1 } })
    s.meet.callsHeld[0]!.present = 1
    expect(await s.answer('/api/meet/delete-chat', { name: NAME })).toMatchObject({ result: 'refused', reason: 'conflict' })
  })
})

describe('Conversations: a row for a New call, and the Phone', () => {
  const newCall: MeetCallRef = { name: NAME, link: LINK, title: 'Weekly sync', madeAt: ago(15) }

  test('a New call has a row of its own and the Phone is one row, among the people and channels by time, in the main list only', async () => {
    const s = await asOwner({ newCalls: [newCall], phone: { conversationId: 90, newest: { at: ago(5), text: 'Missed call from (626) 555-0111' }, unread: 2 } })
    const list = (await s.get<ConversationsAnswer>('/api/conversations')).body
    expect(list.rows.map((r) => [r.type, r.key])).toEqual([
      ['phone', 'phone'],
      ['call', `call:${NAME}`],
      ['person', 'priya@northfield.example'],
      ['channel', 'chat:channel:21'],
    ])
    expect(list.rows[0]).toMatchObject({ name: 'Phone', unread: 2, text: 'Missed call from (626) 555-0111' })
    expect(list.rows[1]).toMatchObject({ name: 'Weekly sync', link: LINK, unread: 0 })
    const bulk = (await s.get<ConversationsAnswer>('/api/conversations?view=bulk')).body
    expect(bulk.rows.filter((r) => r.type === 'call' || r.type === 'phone')).toEqual([])
  })

  test('a Phone with nothing yet is a row without a time that sorts last, and a meet that predates the Phone leaves no row', async () => {
    const s = await asOwner({ phone: { conversationId: 90, newest: null, unread: 0 } })
    const rows = (await s.get<ConversationsAnswer>('/api/conversations')).body.rows
    expect(rows.at(-1)).toMatchObject({ type: 'phone', at: 0, text: 'Voicemails and missed calls' })
    const old = await asOwner()
    expect((await old.get<ConversationsAnswer>('/api/conversations')).body.rows.some((r) => r.type === 'phone')).toBe(false)
  })

  test('the Phone row is not a conversation to open by key, nor is a call: they are screens of their own', async () => {
    const s = await asOwner({ newCalls: [newCall], phone: { conversationId: 90, newest: null, unread: 0 } })
    for (const k of ['phone', `call:${NAME}`]) {
      const res = await s.get<{ error: string }>(`/api/conversation?key=${encodeURIComponent(k)}`)
      expect([k, res.status]).toEqual([k, 400])
    }
  })
})

describe('a conversation shows its calls as cards', () => {
  test('a direct message carries the huddle’s message flagged and the card, and meet was asked for that conversation', async () => {
    const huddle = call({ conversationId: 11, present: 1, people: 1 })
    const s = await asOwner({
      callsHeld: [huddle],
      history: { 11: [{ id: 110, at: ago(40), authorId: 'p-priya', authorName: 'Priya', text: 'Join me', mine: false }, { id: 111, at: ago(20), authorId: 'p-tessa', authorName: 'Tessa', text: `Started a huddle: ${LINK}`, mine: true, huddle: NAME }] },
    })
    const open = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    expect(open.calls).toEqual([huddle])
    const chatEntries = open.sources.flatMap((x) => (x.kind === 'chat' ? x.messages : []))
    expect(chatEntries.find((m) => m.id === 111)).toMatchObject({ huddle: NAME })
    expect(chatEntries.find((m) => m.id === 110)?.huddle).toBeUndefined()
    expect(s.meet.made.cards).toEqual([{ conversationIds: [11], homes: ['priya@northfield.example'] }])
  })

  test('an email conversation carries the call links and meetings made from it, asked by its key and every address it holds', async () => {
    const link = call({ kind: 'link', home: 'corin@client.example', name: 'a'.repeat(20) })
    const meeting = call({ kind: 'meeting', title: 'Kickoff', home: 'corin@client.example', startsAt: T0 + 26 * HOUR, name: 'b'.repeat(20) })
    const elsewhere = call({ kind: 'link', home: 'dana@harbor.example', name: 'c'.repeat(20) })
    const s = await asOwner({ callsHeld: [link, meeting, elsewhere], threads: [thread('t-corin', ago(30), ['c-corin'], { direction: 'in' })] })
    const open = (await s.get<ConversationAnswer>('/api/conversation?key=corin%40client.example')).body
    expect(open.calls.map((c) => c.kind).sort()).toEqual(['link', 'meeting'])
    expect(s.meet.made.cards.at(-1)).toEqual({ conversationIds: [], homes: ['corin@client.example'] })
  })

  test('meet not answering the cards leaves the conversation and says chat could not be reached', async () => {
    const s = await asOwner()
    s.meet.cards = async () => {
      throw new Error('down')
    }
    const open = (await s.get<ConversationAnswer>('/api/conversation?key=priya%40northfield.example')).body
    expect(open.calls).toEqual([])
    expect(open.parts.find((p) => p.part === 'chat')).toMatchObject({ state: 'could-not-be-reached' })
  })
})

describe('Today: meetings in the company’s day, and why a call is shown', () => {
  // T0 is 12:00 UTC on 1 November 2026, 04:00 in Los Angeles; the company's day runs to 08:00 UTC the next day, tomorrow to 08:00 UTC the day after.
  const meeting = (id: string, startsAt: number, over: Partial<MeetCall> = {}): MeetCall =>
    call({ name: id.padEnd(20, '0'), link: `https://space.northfield.example/r/${id.padEnd(20, '0')}`, kind: 'meeting', title: id, startsAt, home: 'corin@client.example', invitees: [{ name: 'Corin Pike', address: 'corin@client.example' }], ...over })
  const at = (h: number, day = 1) => Date.UTC(2026, 10, day, h)

  test('what starts today after now is Later today, and what starts the company’s next day is Tomorrow, soonest first, each with meet’s link and the people invited', async () => {
    const s = await asOwner({ callsHeld: [meeting('tonight', Date.UTC(2026, 10, 2, 7, 59)), meeting('lunch', at(19)), meeting('breakfast', at(8, 2) + HOUR), meeting('late', at(7, 3) + 59 * MIN), meeting('nextweek', at(8, 9))] })
    const a = (await s.get<TodayAnswer>('/api/today')).body
    expect(a.meetingsListed).toBe(true)
    expect(a.laterToday.map((m) => m.id.slice(0, 5))).toEqual(['lunch', 'tonig'])
    expect(a.tomorrow.map((m) => m.id.slice(0, 5))).toEqual(['break', 'late0'])
    expect(a.laterToday[0]).toMatchObject({ title: 'lunch', link: `https://space.northfield.example/r/${'lunch'.padEnd(20, '0')}`, with: ['Corin Pike'], conversation: 'corin@client.example' })
    // The window meet was asked: from now to the end of tomorrow in the company's zone.
    expect(s.meet.made.meetings).toEqual([[T0, Date.UTC(2026, 10, 3, 8)]])
  })

  test('a meeting in a direct message or a channel opens that conversation’s row', async () => {
    const s = await asOwner({ callsHeld: [meeting('dmmeet', at(20), { home: null, conversationId: 11 }), meeting('chmeet', at(21), { home: null, conversationId: 21 })] })
    const a = (await s.get<TodayAnswer>('/api/today')).body
    expect(a.laterToday.map((m) => [m.title, m.conversation])).toEqual([
      ['dmmeet', 'priya@northfield.example'],
      ['chmeet', 'chat:channel:21'],
    ])
  })

  test('a call someone is in because of a conversation or an invitation is shown with why', async () => {
    const s = await asOwner()
    s.meet.live.push({ name: 'a'.repeat(20), startedAt: T0 - MIN, present: 2, why: 'conversation' }, { name: 'b'.repeat(20), startedAt: T0 - 2 * MIN, present: 1, why: 'invited' }, { name: 'c'.repeat(20), startedAt: T0 - 3 * MIN, present: 1, why: 'comet' as never })
    const a = (await s.get<TodayAnswer>('/api/today')).body
    expect(a.happeningNow.map((c) => c.why)).toEqual(['conversation', 'invited', 'other'])
  })

  test('voicemails and missed calls waiting in the Phone are one row of Waiting on you, only when there are some', async () => {
    const some = await asOwner({ phone: { conversationId: 90, newest: { at: ago(5), text: 'Missed call from (626) 555-0111' }, unread: 2 } })
    const a = (await some.get<TodayAnswer>('/api/today')).body
    expect(a.waitingOnYou.rows.filter((r) => r.kind === 'phone')).toEqual([{ kind: 'phone', key: 'phone', snippet: 'Missed call from (626) 555-0111', at: ago(5), unread: 2 }])
    const none = await asOwner({ phone: { conversationId: 90, newest: { at: ago(5), text: 'Missed call' }, unread: 0 } })
    expect((await none.get<TodayAnswer>('/api/today')).body.waitingOnYou.rows.some((r) => r.kind === 'phone')).toBe(false)
    // A person with no Phone conversation has no row.
    const nobody = await asOwner()
    expect((await nobody.get<TodayAnswer>('/api/today')).body.waitingOnYou.rows.some((r) => r.kind === 'phone')).toBe(false)
  })

  test('meet not listing meetings is said, not “none”', async () => {
    const s = await asOwner()
    s.meet.meetings = async () => {
      throw new Error('down')
    }
    const a = (await s.get<TodayAnswer>('/api/today')).body
    expect(a.meetingsListed).toBe(false)
    expect(a.sources.find((x) => x.source === 'meetings')).toMatchObject({ part: 'chat', state: 'could-not-be-reached' })
  })
})

describe('the phone: the dial pad’s own requests reach meet’s phone and nothing else of meet’s', () => {
  const asked = (s: Awaited<ReturnType<typeof asOwner>>) => s.meet.forwarded.map((r) => `${r.method} ${new URL(r.url).pathname}`)

  test('each is handed to meet’s part at its phone path with the person the check named, the Origin and the body, and without the assertion or the cookie', async () => {
    const s = await asOwner()
    const jwt = s.jwt
    const send = (method: string, path: string, body?: unknown) =>
      s.w.call(path, { method, jwt, headers: { origin: ORIGIN, cookie: 'CF_Authorization=secret', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await send('GET', '/api/phone')
    await send('GET', '/api/phone/calls')
    await send('POST', '/api/phone/call', { to: '6265550100' })
    await send('PUT', '/api/phone/settings', { ringSeconds: 25 })
    await send('DELETE', '/api/phone/messages/7')
    expect(asked(s)).toEqual(['GET /space/phone', 'GET /space/phone/calls', 'POST /space/phone/call', 'PUT /space/phone/settings', 'DELETE /space/phone/messages/7'])
    for (const r of s.meet.forwarded) {
      expect(r.headers.get('cf-access-jwt-assertion')).toBeNull()
      expect(r.headers.get('cookie')).toBeNull()
      expect(new URL(r.url).origin).toBe(ORIGIN)
    }
    expect(s.meet.forwardedFor).toEqual(Array(5).fill('tessa@northfield.example'))
    expect(s.meet.forwarded[2]?.headers.get('origin')).toBe(ORIGIN)
    expect(await s.meet.forwarded[2]?.text()).toBe('{"to":"6265550100"}')
  })

  test('the answer is never kept and carries no cookie', async () => {
    const s = await asOwner()
    const res = await s.w.call('/api/phone/calls', { jwt: s.jwt })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('only /api/phone and what is under it goes: a neighbour, a climb and a missing binding do not', async () => {
    const s = await asOwner()
    for (const path of ['/api/phonebook', '/api/phones', '/api/phone-x']) expect([path, (await s.w.call(path, { jwt: s.jwt })).status]).toEqual([path, 404])
    expect(asked(s)).toEqual([])
    const none = await asOwner({ noMeet: true })
    expect((await none.w.call('/api/phone', { jwt: none.jwt })).status).toBe(503)
  })

  test('a write from another site, or not in JSON, is refused before meet is asked; a DELETE needs no body', async () => {
    const s = await asOwner()
    expect((await s.w.call('/api/phone/call', { method: 'POST', jwt: s.jwt, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect((await s.w.call('/api/phone/call', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN } })).status).toBe(415)
    expect((await s.w.call('/api/phone/messages/7', { method: 'DELETE', jwt: s.jwt, headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect(asked(s)).toEqual([])
    expect((await s.w.call('/api/phone/messages/7', { method: 'DELETE', jwt: s.jwt, headers: { origin: ORIGIN } })).status).toBe(200)
    expect(asked(s)).toEqual(['DELETE /space/phone/messages/7'])
    // PATCH is nobody's.
    expect((await s.w.call('/api/phone/settings', { method: 'PATCH', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
  })
})
