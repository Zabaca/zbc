// Today, driven through the real router with stand-in apps behind the bindings. What is asserted is what a person sees on Today (the rows of
// each section, and what is missing when a part does not answer) or what is refused, never the Worker's internals. The sections' sources are
// Today's sources; the company's day is its declared time zone. T0 is 12:00 UTC on 1 November 2026, which is 04:00 in Los Angeles on the
// morning the clocks go back there: that company's day is 25 hours long and began at 07:00 UTC, five hours after UTC's own.
import { describe, expect, test } from 'bun:test'
import { type DocumentSummary, type MeetLiveCall } from '@space/workspace'
import { T0, lane, northfield } from '../../workspace/test/helpers'
import type { ConversationsAnswer } from '../src/conversations'
import { type StandInContact, type StandInDraft, type StandInThread, standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { type Meeting, type TodayAnswer } from '../src/today-shape'
import { bucketMeetings, dayAround } from '../src/today'
import { RIDGEWAY, LANE_TEAM, MIN, NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

const HOUR = 60 * MIN
/** Midnight at the start of 1 November 2026 in Los Angeles: 07:00 UTC, still on daylight time. */
const LA_MIDNIGHT = Date.UTC(2026, 10, 1, 7, 0, 0)

const doc = (id: string, title: string, state: DocumentSummary['state'], over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  title,
  state,
  createdAt: T0 - 3 * 24 * HOUR,
  sentAt: state === 'draft' ? null : T0 - 3 * 24 * HOUR + 5 * MIN,
  completedAt: null,
  signers: 1,
  signed: 0,
  notSigned: [],
  ...over,
})

const liveCall = (name: string, present = 2): MeetLiveCall => ({ name, startedAt: T0 - 18 * MIN, present, why: 'started' })

interface Given {
  contacts?: StandInContact[]
  threads?: StandInThread[]
  drafts?: StandInDraft[]
  direct?: Parameters<typeof standInMeet>[0]['direct']
  channels?: Parameters<typeof standInMeet>[0]['channels']
  calls?: MeetLiveCall[]
  documents?: DocumentSummary[]
  delays?: { inbox?: number; meet?: number; forms?: number }
}

async function asOwner(given: Given = {}, within = 60) {
  const inbox = standInInbox(given.contacts ?? [], given.threads ?? [], { drafts: given.drafts, delayMs: given.delays?.inbox })
  const meet = standInMeet({ direct: given.direct ?? [], channels: given.channels ?? [] }, { calls: given.calls, delayMs: given.delays?.meet })
  const forms = standInForms(given.documents ?? [], { delayMs: given.delays?.forms })
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet, parts: { forms } }, undefined, { answerWithinMs: within })
  const jwt = await w.signIn('tessa@northfield.example')
  const today = async (): Promise<TodayAnswer> => {
    const res = await w.call('/api/today', { jwt })
    expect(res.status).toBe(200)
    return (await res.json()) as TodayAnswer
  }
  const list = async (): Promise<ConversationsAnswer> => (await (await w.call('/api/conversations', { jwt })).json()) as ConversationsAnswer
  return { w, jwt, inbox, meet, forms, today, list }
}

const dana = contact('c-dana', 'Dana Reyes', 'dana@harbor.example')
const marcus = contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example')

describe('Happening now: calls with someone in them', () => {
  test('a call meet says has people in it is a row with its name, when it was made and how many are in it', async () => {
    const s = await asOwner({ calls: [liveCall('k7m2qx9frtn4w6hbc8jd', 3)] })
    expect((await s.today()).happeningNow).toEqual([{ name: 'k7m2qx9frtn4w6hbc8jd', startedAt: T0 - 18 * MIN, present: 3, why: 'started' }])
  })

  test('no call, no row', async () => {
    const s = await asOwner()
    expect((await s.today()).happeningNow).toEqual([])
  })
})

describe('Waiting on you: mail whose newest message came in, unread mail, and unread direct messages', () => {
  const threads = [
    thread('t-in', ago(30), ['c-dana'], { subject: 'Hours on the homepage', snippet: 'Can it say Saturdays?', direction: 'in' }),
    thread('t-unread-out', ago(50), ['c-marcus'], { subject: 'Photos', snippet: 'Sent them over', direction: 'out', unread: true }),
    thread('t-answered', ago(60), ['c-marcus'], { subject: 'Invoice', snippet: 'Paid, thank you', direction: 'out' }),
    thread('t-bulk', ago(10), ['c-news'], { subject: 'This week in marketing', direction: 'in', bulk: true, unread: true }),
    thread('t-closed', ago(20), ['c-old'], { subject: 'Trademark', direction: 'in', open: false, unread: true }),
  ]
  const contacts = [dana, marcus, contact('c-news', 'Weekly News', 'news@x.example'), contact('c-old', 'Grace Okafor', 'grace@x.example')]

  test('an open conversation outside Bulk whose newest message came in is waiting, and so is an unread one; an answered one, Bulk and closed mail are not', async () => {
    const s = await asOwner({ contacts, threads })
    const waiting = (await s.today()).waitingOnYou.rows
    expect(waiting.map((w) => (w.kind === 'mail' ? w.id : w.key))).toEqual(['t-in', 't-unread-out'])
    const [reply, unread] = waiting
    expect(reply).toMatchObject({ kind: 'mail', needsReply: true, unread: false, subject: 'Hours on the homepage', snippet: 'Can it say Saturdays?', people: ['Dana Reyes'], at: ago(30) })
    expect(unread).toMatchObject({ kind: 'mail', needsReply: false, unread: true, people: ['Marcus Chen'] })
  })

  test('a row opens the conversation the Conversations list has for that person', async () => {
    const s = await asOwner({ contacts, threads })
    const rows = (await s.list()).rows.map((r) => r.key)
    for (const w of (await s.today()).waitingOnYou.rows) expect(rows).toContain(w.key)
  })

  test('a Telegram group is waiting only when a message to Tessa is in it; chatter alone, read or not, is not Today’s business', async () => {
    const group = (id: string, name: string): StandInContact => ({ id, name, addresses: [], chat: 'group' })
    const s = await asOwner({
      contacts: [group('c-g-mention', 'Main Street Merchants'), group('c-g-chatter', 'Garden Club')],
      threads: [
        thread('t-g-mention', ago(5), ['c-g-mention'], { kind: 'telegram', telegramChat: 'group', needsReply: true, direction: 'in', unread: true, messages: [{ id: 'm-1', at: ago(5), direction: 'in', from: 'Tomas Vega', text: '@tessa can you look?' }] }),
        thread('t-g-chatter', ago(6), ['c-g-chatter'], { kind: 'telegram', telegramChat: 'group', needsReply: false, direction: 'in', unread: true, messages: [{ id: 'm-2', at: ago(6), direction: 'in', from: 'Priti Shah', text: 'tomatoes?' }] }),
      ],
    })
    const waiting = (await s.today()).waitingOnYou.rows
    expect(waiting.map((w) => (w.kind === 'mail' ? w.id : w.key))).toEqual(['t-g-mention'])
    expect(waiting[0]).toMatchObject({ kind: 'mail', needsReply: true, people: ['Main Street Merchants'], snippet: 'Tomas: @tessa can you look?' })
  })

  test('a business mailbox’s mail is named as it is in the list, and the person’s Client is on the row', async () => {
    const s = await asOwner({
      contacts: [{ ...dana, client: { id: 7, name: 'Harbor Dental' } }],
      threads: [thread('t-f', ago(5), ['c-dana'], { mailbox: RIDGEWAY, direction: 'in' })],
    })
    expect((await s.today()).waitingOnYou.rows[0]).toMatchObject({ mailbox: 'Ridgeway Cycles', client: 'Harbor Dental' })
  })

  test('a thread two contacts are on is one row, naming both', async () => {
    const s = await asOwner({ contacts: [dana, marcus], threads: [thread('t-shared', ago(5), ['c-dana', 'c-marcus'], { direction: 'in' })] })
    const rows = (await s.today()).waitingOnYou.rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'mail', people: expect.arrayContaining(['Dana Reyes', 'Marcus Chen']) })
  })

  test('a shared thread leads with, and opens, the person the lists put it under, whichever order the inbox listed them in', async () => {
    const s = await asOwner({ contacts: [dana, marcus], threads: [thread('t-shared', ago(5), ['c-dana', 'c-marcus'], { direction: 'in', listedUnder: 'c-marcus' })] })
    const rows = (await s.today()).waitingOnYou.rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'mail', key: 'marcus@harbor.example', people: ['Marcus Chen', 'Dana Reyes'] })
  })

  test('an unread direct message is waiting; a read one, a channel’s unread messages and a direct message nobody has written in are not', async () => {
    const s = await asOwner({
      direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(3), 2, 'Can we move Thursday?'), dm(12, person('p-b', 'Ben', 'ben@northfield.example', 'teammate'), ago(9), 0), dm(13, person('p-q', 'Quiet', 'quiet@northfield.example', 'teammate'), null)],
      channels: [channel(21, 'launch', ago(2), 5)],
    })
    const rows = (await s.today()).waitingOnYou.rows
    expect(rows).toEqual([{ kind: 'chat', key: 'dana@harbor.example', person: 'Dana Reyes', snippet: 'Can we move Thursday?', at: ago(3), unread: 2 }])
  })

  test('mail and chat are one list, newest first, and a long list shows its newest and says how many there are', async () => {
    const many = Array.from({ length: 15 }, (_, i) => thread(`t${i}`, ago(100 - i), [`c${i}`], { direction: 'in' }))
    const s = await asOwner({
      contacts: many.map((_, i) => contact(`c${i}`, `Person ${i}`, `p${i}@x.example`)),
      threads: many,
      direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(1), 1)],
    })
    const waiting = (await s.today()).waitingOnYou
    expect(waiting.total).toBe(16)
    expect(waiting.rows).toHaveLength(12)
    expect(waiting.rows[0]).toMatchObject({ kind: 'chat' }) // the newest of all
    expect(waiting.rows.map((r) => r.at)).toEqual([...waiting.rows.map((r) => r.at)].sort((a, b) => b - a))
    // What is left out is counted by the tab it is in: four emails (the Inbox's), no direct message (Meet's).
    expect((await s.today()).waitingOnYouLeft).toEqual({ inbox: 4, meet: 0 })
  })
})

describe('Drafts not sent: the inbox’s drafts and forms’ draft documents', () => {
  const drafts: StandInDraft[] = [
    { id: 'd1', conversationId: 't1', contactId: 'c-dana', subject: 'Re: Hours', text: 'Yes, until two.', author: 'claude', at: ago(80) },
    { id: 'd2', conversationId: null, contactId: 'c-marcus', subject: 'Photos', text: 'Hi', author: 'owner', at: ago(20) },
  ]

  test('each draft is a row naming who it is to, who wrote it, and whether it replies; a document that is a draft sits in the same list, newest first', async () => {
    const s = await asOwner({
      contacts: [dana, marcus],
      threads: [thread('t1', ago(100), ['c-dana'])],
      drafts,
      documents: [doc('e-d', 'Website agreement', 'draft', { createdAt: ago(50), notSigned: ['Rosa Whitfield'] }), doc('e-s', 'Sent one', 'sent')],
    })
    const rows = (await s.today()).drafts.rows
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['email:d2', 'document:e-d', 'email:d1'])
    expect(rows[0]).toMatchObject({ kind: 'email', to: 'Marcus Chen', reply: false, author: 'owner', stuck: false })
    expect(rows[2]).toMatchObject({ kind: 'email', to: 'Dana Reyes', reply: true, author: 'claude', subject: 'Re: Hours' })
    expect(rows[1]).toMatchObject({ kind: 'document', title: 'Website agreement', notSigned: ['Rosa Whitfield'] })
  })

  test('a draft opens its person’s conversation, also when that person has no conversation in the main list', async () => {
    const s = await asOwner({ contacts: [dana, marcus], threads: [thread('t1', ago(100), ['c-dana'])], drafts })
    const rows = (await s.today()).drafts.rows
    expect(rows.find((r) => r.kind === 'email' && r.id === 'd1')).toMatchObject({ key: 'dana@harbor.example' })
    // Marcus has no thread: his draft opens his contact, which the conversation view opens by the contact's own key.
    expect(rows.find((r) => r.kind === 'email' && r.id === 'd2')).toMatchObject({ key: 'mail:c-marcus' })
  })
})

describe('Waiting on others: documents sent and not complete, with who has not signed', () => {
  test('sent, prepared and sealing documents are here, newest first, with the names of those who have not signed; a draft and a finished one are not', async () => {
    const s = await asOwner({
      documents: [
        doc('e-1', 'Hosting renewal', 'sent', { createdAt: ago(60 * 48), sentAt: ago(60 * 48), signers: 2, signed: 1, notSigned: ['Dana Reyes'] }),
        doc('e-2', 'Photo release', 'sent', { createdAt: ago(60 * 5), sentAt: ago(60 * 5), signers: 2, notSigned: ['Dana Reyes', 'Marcus Chen'] }),
        doc('e-3', 'Being sealed', 'sealing', { createdAt: ago(60 * 9), sentAt: ago(60 * 9), signers: 1, signed: 1 }),
        doc('e-4', 'Not out yet', 'draft'),
        doc('e-5', 'Finished', 'completed', { completedAt: ago(5) }),
        doc('e-6', 'Cancelled', 'cancelled'),
      ],
    })
    const out = (await s.today()).waitingOnOthers
    expect(out.rows.map((r) => r.id)).toEqual(['e-2', 'e-3', 'e-1'])
    expect(out.rows[0]).toMatchObject({ title: 'Photo release', state: 'sent', signers: 2, signed: 0, notSigned: ['Dana Reyes', 'Marcus Chen'], at: ago(60 * 5) })
    expect(out.rows[2]).toMatchObject({ signed: 1, notSigned: ['Dana Reyes'] })
  })
})

describe('Signed and back: documents completed today, in the company’s time zone', () => {
  test('a document finished since the company’s midnight is here, one finished a minute before it is not, though in UTC it is the same day', async () => {
    const s = await asOwner({
      documents: [
        doc('e-just', 'Just after midnight', 'completed', { completedAt: LA_MIDNIGHT, signers: 2, signed: 2 }),
        doc('e-late', 'Late last night', 'completed', { completedAt: LA_MIDNIGHT - MIN }),
        doc('e-recent', 'This morning', 'completed', { completedAt: ago(30) }),
        doc('e-week', 'A week ago', 'completed', { completedAt: ago(60 * 24 * 7) }),
      ],
    })
    const back = (await s.today()).signedAndBack
    expect(back.rows.map((r) => r.id)).toEqual(['e-recent', 'e-just'])
    expect(back.rows[0]).toMatchObject({ title: 'This morning', state: 'completed', at: ago(30) })
    // Forms was asked for what was finished since that midnight, not since UTC's.
    expect(s.forms.asked.queries.find((q) => q?.states?.[0] === 'completed')).toMatchObject({ since: LA_MIDNIGHT })
  })

  test('a signed document carries the key of the conversation it was sent from, found by its stored id; one sent from Forms, one whose row is not in the list and one from an older forms carry none', async () => {
    const s = await asOwner({
      contacts: [dana, marcus, contact('c-old', 'Grace Okafor', 'grace@x.example')],
      threads: [thread('t-d', ago(40), ['c-dana'], { direction: 'in' }), thread('t-m', ago(50), ['c-marcus'], { direction: 'in' }), thread('t-closed', ago(20), ['c-old'], { direction: 'in', open: false })],
      direct: [dm(12, person('p-gus', 'Gus Guest', 'gus@x.example'), ago(5))],
      channels: [channel(21, 'launch', ago(3))],
      documents: [
        doc('e-dana', 'Sent from Dana', 'completed', { completedAt: ago(30), conversation: { app: 'inbox', id: 'c-dana' } }),
        doc('e-chat', 'Sent from a direct message', 'completed', { completedAt: ago(31), conversation: { app: 'meet', id: '12' } }),
        doc('e-room', 'Sent from a channel', 'completed', { completedAt: ago(32), conversation: { app: 'meet', id: '21' } }),
        doc('e-forms', 'Sent from Forms', 'completed', { completedAt: ago(33) }),
        doc('e-closed', 'From a closed conversation', 'completed', { completedAt: ago(34), conversation: { app: 'inbox', id: 'c-old' } }),
        doc('e-gone', 'From a contact that is gone', 'completed', { completedAt: ago(35), conversation: { app: 'inbox', id: 'c-merged-away' } }),
      ],
    })
    const rows = (await s.today()).signedAndBack.rows
    const keys = new Map(rows.map((r) => [r.id, r.conversationKey]))
    const list = (await s.list()).rows
    expect(keys.get('e-dana')).toBe('dana@harbor.example')
    expect(list.map((r) => r.key)).toContain(keys.get('e-dana') as string)
    expect(keys.get('e-chat')).toBe('gus@x.example')
    expect(keys.get('e-room')).toBe('chat:channel:21')
    for (const id of ['e-forms', 'e-closed', 'e-gone']) expect([id, keys.get(id)]).toEqual([id, undefined])
    // And the tab it opens in: the Inbox for a document sent from an email conversation, Meet for one sent from a direct message or a channel.
    const tabs = new Map(rows.map((r) => [r.id, r.conversationTab]))
    expect([tabs.get('e-dana'), tabs.get('e-chat'), tabs.get('e-room')]).toEqual(['inbox', 'meet', 'meet'])
    for (const id of ['e-forms', 'e-closed', 'e-gone']) expect([id, tabs.get(id)]).toEqual([id, undefined])
    // Only Signed and back is a conversation's: a document waiting on others still opens in Forms.
    const out = await asOwner({ documents: [doc('e-out', 'Out', 'sent', { conversation: { app: 'inbox', id: 'c-dana' } })], contacts: [dana], threads: [thread('t-d', ago(40), ['c-dana'])] })
    expect((await out.today()).waitingOnOthers.rows[0]).not.toHaveProperty('conversationKey')
  })

  test('a document made today and not finished is not signed and back, though forms’ `since` lets it in', async () => {
    const s = await asOwner({ documents: [doc('e-new', 'Made today', 'completed', { createdAt: ago(60), completedAt: LA_MIDNIGHT - 3 * HOUR })] })
    expect((await s.today()).signedAndBack.rows).toEqual([])
  })

  test('a company in a zone east of UTC begins its day before UTC does: at T0 it is evening of the 1st in Tokyo, whose day began at 15:00 UTC on the 31st', () => {
    expect(dayAround(T0, 'Asia/Tokyo').start).toBe(Date.UTC(2026, 9, 31, 15, 0, 0))
  })
})

describe('the company’s day', () => {
  test('begins at its own midnight and ends at the next, a day long where the clocks change', () => {
    // 1 November 2026: California goes back to standard time at 02:00, so that day is 25 hours; 8 March 2026 is the other way and 23.
    const fall = dayAround(T0, 'America/Los_Angeles')
    expect(fall.start).toBe(LA_MIDNIGHT)
    expect(fall.next).toBe(Date.UTC(2026, 10, 2, 8, 0, 0))
    expect(fall.next - fall.start).toBe(25 * HOUR)
    expect(fall.after - fall.next).toBe(24 * HOUR)
    const spring = dayAround(Date.UTC(2026, 2, 8, 20, 0, 0), 'America/Los_Angeles')
    expect(spring.next - spring.start).toBe(23 * HOUR)
  })

  test('a moment just before the company’s midnight is still the day before, and the moment of it is the new day', () => {
    const before = dayAround(LA_MIDNIGHT - 1, 'America/Los_Angeles')
    const at = dayAround(LA_MIDNIGHT, 'America/Los_Angeles')
    expect(before.next).toBe(LA_MIDNIGHT)
    expect(at.start).toBe(LA_MIDNIGHT)
  })

  test('UTC is not the company’s clock: 03:00 UTC on the 1st is the evening of the 31st in Los Angeles', () => {
    const d = dayAround(Date.UTC(2026, 10, 1, 3, 0, 0), 'America/Los_Angeles')
    expect(d.start).toBe(Date.UTC(2026, 9, 31, 7, 0, 0))
    expect(d.next).toBe(LA_MIDNIGHT)
  })
})

describe('Later today and Tomorrow: meetings with a time, in the company’s time zone', () => {
  const at = (h: number, m = 0, day = 1) => Date.UTC(2026, 10, day, h, m, 0)
  const meeting = (id: string, startsAt: number): Meeting => ({ id, title: id, startsAt })
  // T0 is 12:00 UTC, 04:00 in Los Angeles. Today there runs to 08:00 UTC the next day; tomorrow to 08:00 UTC the day after.
  const sorted = bucketMeetings(
    [
      meeting('after', at(8, 0, 3)),
      meeting('tomorrow-late', at(7, 59, 3)),
      meeting('tomorrow-first', at(8, 0, 2)),
      meeting('tonight', at(7, 59, 2)),
      meeting('later', at(18, 30)),
      meeting('started', at(11, 0)),
      meeting('this-instant', T0),
      meeting('soon', at(12, 1)),
    ],
    T0,
    'America/Los_Angeles',
  )

  test('what starts after now and before the company’s next midnight is later today, soonest first', () => {
    expect(sorted.laterToday.map((m) => m.id)).toEqual(['soon', 'later', 'tonight'])
  })

  test('the following day is tomorrow, and one that has started, or that is a day further, is neither', () => {
    expect(sorted.tomorrow.map((m) => m.id)).toEqual(['tomorrow-first', 'tomorrow-late'])
  })

  test('meet lists no meetings: the answer has none and says it listed them (so the page may say there are none)', async () => {
    const s = await asOwner()
    const a = await s.today()
    expect([a.laterToday, a.tomorrow, a.meetingsListed]).toEqual([[], [], true])
  })
})

describe('a part that does not answer leaves the others, and the answer says which', () => {
  const full: Given = {
    contacts: [dana],
    threads: [thread('t1', ago(5), ['c-dana'], { direction: 'in' })],
    drafts: [{ id: 'd1', conversationId: 't1', contactId: 'c-dana', subject: 'Re', text: 't', author: 'claude', at: ago(2) }],
    direct: [dm(11, person('p-pri', 'Priya', 'priya@northfield.example', 'teammate'), ago(1), 1)],
    calls: [liveCall('k7m2qx9frtn4w6hbc8jd')],
    documents: [doc('e-1', 'Photo release', 'sent', { notSigned: ['Dana Reyes'] })],
  }
  const state = (a: TodayAnswer, source: string) => a.sources.find((s) => s.source === source)

  test('everything answering: every source is ok', async () => {
    const a = await (await asOwner(full)).today()
    expect(a.sources.every((s) => s.state === 'ok')).toBe(true)
    expect(a.sources.map((s) => s.source).sort()).toEqual(['back', 'calls', 'drafts', 'meetings', 'messages', 'out', 'unsent', 'waiting'])
  })

  test('the inbox down: mail and email drafts are missing and chat, calls and documents are all there', async () => {
    const s = await asOwner(full)
    s.inbox.people = async () => {
      throw new Error('inbox is down')
    }
    s.inbox.drafts = async () => {
      throw new Error('inbox is down')
    }
    const a = await s.today()
    expect(a.sources.filter((x) => x.part === 'mail').every((x) => x.state === 'could-not-be-reached')).toBe(true)
    expect(a.waitingOnYou.rows.map((r) => r.kind)).toEqual(['chat'])
    expect(a.drafts.rows).toEqual([])
    expect(a.happeningNow).toHaveLength(1)
    expect(a.waitingOnOthers.rows).toHaveLength(1)
  })

  test('meet refusing: chat is not open to this person, and mail and documents are there', async () => {
    const s = await asOwner(full)
    s.meet.conversations = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    s.meet.liveCalls = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    const a = await s.today()
    expect(state(a, 'messages')).toMatchObject({ part: 'chat', state: 'not-open-to-you' })
    expect(state(a, 'calls')).toMatchObject({ state: 'not-open-to-you' })
    expect(a.waitingOnYou.rows.map((r) => r.kind)).toEqual(['mail'])
    expect(a.happeningNow).toEqual([])
    expect(a.waitingOnOthers.rows).toHaveLength(1)
  })

  test('forms slow past the wait: its three sections are empty, the answer says it took too long, and the rest arrived without waiting for it', async () => {
    const s = await asOwner({ ...full, delays: { forms: 500 } }, 40)
    const t0 = Date.now()
    const a = await s.today()
    expect(Date.now() - t0).toBeLessThan(400)
    for (const id of ['unsent', 'out', 'back']) expect(state(a, id)).toMatchObject({ part: 'documents', state: 'could-not-be-reached', reason: 'timed-out' })
    expect(a.waitingOnOthers.rows).toEqual([])
    expect(a.waitingOnYou.rows.length).toBeGreaterThan(0)
  })

  test('one of forms’ three reads failing leaves the other two', async () => {
    const s = await asOwner({ ...full, documents: [doc('e-1', 'Out', 'sent'), doc('e-2', 'Back', 'completed', { completedAt: ago(5) })] })
    const real = s.forms.documents.bind(s.forms)
    s.forms.documents = async (assertion, query) => (query?.states?.includes('completed') ? { ok: false, kind: 'failed', reason: 'broken', message: 'forms had a problem' } : real(assertion, query))
    const a = await s.today()
    expect(state(a, 'back')).toMatchObject({ state: 'could-not-be-reached', reason: 'broken' })
    expect(state(a, 'out')).toMatchObject({ state: 'ok' })
    expect(a.waitingOnOthers.rows.map((r) => r.id)).toEqual(['e-1'])
  })

  test('an app that is not wired to the space at all is a part that could not be reached, not an empty one', async () => {
    const w = await world(northfield(), NORTHFIELD_TEAM, {}, undefined, { answerWithinMs: 40 })
    const res = await w.call('/api/today', { jwt: await w.signIn('tessa@northfield.example') })
    const a = (await res.json()) as TodayAnswer
    expect(a.sources.every((x) => x.state === 'could-not-be-reached')).toBe(true)
    expect(a.sources.map((x) => x.part).sort()).toEqual(['chat', 'chat', 'chat', 'documents', 'documents', 'documents', 'mail', 'mail'])
  })

  test('a reason for a call that this space does not know (meet adds some, and is deployed first) does not make the answer unreadable: the call is listed', async () => {
    const s = await asOwner(full)
    const known = liveCall('k7m2qx9frtn4w6hbc8jd')
    s.meet.liveCalls = async () => ({ ok: true, value: [known, { ...liveCall('m7m2qx9frtn4w6hbc8jd'), why: 'invited' as never }] })
    const a = await s.today()
    expect(state(a, 'calls')).toMatchObject({ state: 'ok' })
    expect(a.happeningNow.map((c) => c.name)).toEqual(['k7m2qx9frtn4w6hbc8jd', 'm7m2qx9frtn4w6hbc8jd'])
  })

  test('an answer that is not the shape the contract says is not half read', async () => {
    const s = await asOwner(full)
    s.meet.liveCalls = async () => ({ ok: true, value: [{ name: 'x' }] as never })
    const a = await s.today()
    expect(state(a, 'calls')).toMatchObject({ state: 'could-not-be-reached', reason: 'not-understood' })
    expect(a.happeningNow).toEqual([])
  })
})

describe('who is asking: nothing is asked of any app without a sign-in, and each app is given the assertion the space verified', () => {
  test('no sign-in, a forged one, another team’s and a person who is not here are refused, and no app is asked', async () => {
    const s = await asOwner({ calls: [liveCall('k7m2qx9frtn4w6hbc8jd')], documents: [doc('e-1', 'X', 'sent')] })
    const none = await s.w.call('/api/today')
    expect(none.status).toBe(401)
    const forged = await s.w.call('/api/today', { jwt: 'not.a.jwt' })
    expect(forged.status).toBe(401)
    const stranger = await s.w.call('/api/today', { jwt: await s.w.access.sign({ email: 'eve@elsewhere.test' }) })
    expect(stranger.status).toBe(403)
    const token = await s.w.call('/api/today', { jwt: await s.w.access.sign({ common_name: 'claude-script-client-id' }) })
    expect(token.status).toBe(403)
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await s.w.call('/api/today', { method, jwt: s.jwt })).status).toBe(405)
    expect(s.inbox.asked.askers).toEqual([])
    expect(s.meet.asked.askers).toEqual([])
    expect(s.forms.asked.askers).toEqual([])
  })

  test('with a sign-in, every read goes to its app (each given the person the one check named), and the answer is never kept by the browser', async () => {
    const s = await asOwner()
    const res = await s.w.call('/api/today', { jwt: s.jwt })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(new Set(s.inbox.asked.askers)).toEqual(new Set(['tessa@northfield.example']))
    expect(new Set(s.meet.asked.askers)).toEqual(new Set(['tessa@northfield.example']))
    expect(new Set(s.forms.asked.askers)).toEqual(new Set(['tessa@northfield.example']))
    expect(s.forms.asked.askers).toHaveLength(3)
  })

  test('a second company’s space asks the same apps for its own day, and the Northfield Works person is not let in to it', async () => {
    const w = await world(lane(), LANE_TEAM, { inbox: standInInbox([], []), meet: standInMeet({ direct: [], channels: [] }), parts: { forms: standInForms([]) } })
    expect((await w.call('/api/today', { jwt: await w.signIn('tessa@northfield.example') })).status).toBe(403)
    expect((await w.call('/api/today', { jwt: await w.signIn('lane@pinecrest.test') })).status).toBe(200)
  })
})

describe('what Today never carries', () => {
  test('no draft body and no more of a message than the line that was last said (an address appears only as the key of the conversation a row opens, as in the list)', async () => {
    const s = await asOwner({
      contacts: [dana],
      threads: [thread('t1', ago(5), ['c-dana'], { direction: 'in', snippet: 'The words on the row' })],
      drafts: [{ id: 'd1', conversationId: 't1', contactId: 'c-dana', subject: 'Re', text: 'DRAFT-BODY-NOT-FOR-TODAY', author: 'claude', at: ago(2) }],
      documents: [doc('e-1', 'Photo release', 'sent', { notSigned: ['Dana Reyes'] })],
    })
    const text = JSON.stringify(await s.today())
    expect(text).not.toContain('DRAFT-BODY-NOT-FOR-TODAY')
    expect(text).toContain('The words on the row')
  })
})
