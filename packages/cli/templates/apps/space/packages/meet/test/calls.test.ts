// Calls in the space: huddles, call links, New calls, meetings with a time, past calls, the month's usage and the Phone conversation, through
// SpaceMeet's methods over the real cores (the Workspace core, the Rooms and the ledger), with a signed assertion for the SPACE application saying who
// is asking. The seam is the method, as the space calls it. What is checked is what a person sees or what is refused: who may start a huddle, that the
// meter refuses new calls and new joins, that every link opens on meet.northfield.example, that nothing is emailed.
import { describe, expect, test } from 'bun:test'
import {
  type SignedIn,
  type MeetCall,
  MEET_FOR_SPACE_FETCH_PREFIXES,
  NOT_ADMITTED,
  type SpaceReply,
  type WriteReply,
} from '@space/workspace'
import { serveForSpace, spaceMeet } from '../src/space-meet'
import { MEMBER_TIMEOUT_MS } from '../src/model'
import { siteOrigin } from '../src/web/site'
import { callOf } from '../src/web/workspace/links'
import { ANA, BEN, OWNER, T0, harness, signedAs, token } from './helpers'
import { G, actors } from './workspace.helpers'

const MEET = 'https://space.northfield.example'
const key = (n: string) => `compose-${n}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(24, 'x')

async function setup() {
  const h = await harness({ devBypass: false })
  const a = actors(h)
  const meet = spaceMeet({
    install: h.deps.install,
    workspace: h.deps.workspace,
    room: h.deps.room,
    ledger: h.deps.ledger,
    appOrigin: h.deps.appOrigin,
    mailer: h.deps.mailer,
    now: () => h.clock.now,
    randomBytes: h.deps.randomBytes,
  })
  const as = async (email: string, exp = Math.floor(h.clock.now / 1000) + 3600): Promise<SignedIn> => signedAs(h.deps.install, email, exp)
  const idOf = async (email: string): Promise<string> => (await a.tm(email, 'GET', '/bootstrap')).json.me.id
  const dm = async (by: string, withEmail: string): Promise<number> => (await a.tm(by, 'POST', '/dms', { person: await idOf(withEmail) })).json.conversation.id
  const channel = async (by: string, name: string, members: string[] = []): Promise<number> => {
    const id = (await a.tm(by, 'POST', '/channels', { name, privacy: 'private' })).json.conversation.id as number
    for (const m of members) await a.tm(by, 'POST', `/channels/${id}/members`, { person: await idOf(m) })
    return id
  }
  /** Someone joins a call by its link, with no sign-in, as a guest of the call does. */
  const joinCall = async (name: string, who: string) => {
    const r = await h.call('POST', `/r/api/rooms/${name}/join`, { name: who }, { token: token(who) })
    return { status: r.status, generation: r.json.generation as number, tok: token(who), error: r.json.error as string | undefined }
  }
  return { h, a, meet, as, idOf, dm, channel, joinCall }
}
type S = Awaited<ReturnType<typeof setup>>

function ok<T>(r: SpaceReply<T> | WriteReply<T>): T {
  expect(r).toMatchObject({ ok: true })
  return (r as { value: T }).value
}
const refusal = (r: SpaceReply<unknown> | WriteReply<unknown>) => (r.ok ? 'ok' : r.kind === 'refused' ? r.reason : r.reason)

const huddle = (s: S, who: string, conversationId: number, k = 'h1') => s.as(who).then((as) => s.meet.startHuddle(as, { key: key(k), conversationId }))
const messagesIn = (s: S, conv: number) => (s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = ${conv}`)[0] as { n: number }).n
const calls = (s: S) => s.h.workspaceSql.all<{ name: string }>('SELECT name FROM space_calls').length

describe('who may start a huddle', () => {
  test('anyone in a direct message does, and the other person sees the card’s message, unread, with the call’s link', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const made = ok(await huddle(s, OWNER, conv))
    expect(made).toMatchObject({ kind: 'huddle', conversationId: conv, madeBy: { name: 'Tessa', mine: true }, present: 0, endedAt: null })
    expect(made.link).toBe(`${MEET}/r/${made.name}`)
    // The call exists: its link opens with no sign-in.
    expect((await s.h.call('GET', `/r/api/rooms/${made.name}`)).status).toBe(200)
    // Ana sees one message in the conversation naming the call, and one unread.
    const history = ok(await s.meet.history(await s.as(ANA), conv))
    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]).toMatchObject({ huddle: made.name, mine: false, authorName: 'Tessa' })
    expect(history.messages[0]?.text).toBe(`Started a huddle: ${made.link}`)
    const overview = ok(await s.meet.conversations(await s.as(ANA)))
    expect(overview.direct.find((d) => d.conversationId === conv)).toMatchObject({ unread: 1, newest: { text: 'Started a huddle' } })
    // And it is delivered live like any message.
    expect(s.h.delivered.some((d) => d.change.kind === 'message' && (d.change.data as { message: { huddle?: string } }).message.huddle === made.name)).toBe(true)
  })

  test('the other person starts one too, and in a channel any member does', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    expect(ok(await huddle(s, ANA, conv, 'a')).madeBy).toEqual({ name: 'Ana', mine: true })
    const ch = await s.channel(OWNER, 'ops', [ANA])
    expect(ok(await huddle(s, ANA, ch, 'b'))).toMatchObject({ kind: 'huddle', conversationId: ch })
  })

  test('someone who is not in the conversation cannot: it is as if it did not exist, and nothing is made', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const before = { calls: calls(s), messages: messagesIn(s, conv), ledger: (await s.h.deps.ledger().listCalls(10, null)).calls.length }
    expect(refusal(await huddle(s, BEN, conv))).toBe('not-found')
    expect(refusal(await huddle(s, BEN, 9999))).toBe('not-found')
    const after = { calls: calls(s), messages: messagesIn(s, conv), ledger: (await s.h.deps.ledger().listCalls(10, null)).calls.length }
    expect(after).toEqual(before)
  })

  test('not in the Phone conversation, which only the phone posts in', async () => {
    const s = await setup()
    const overview = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(overview.phone?.conversationId).toBeGreaterThan(0)
    expect(refusal(await huddle(s, OWNER, overview.phone?.conversationId as number))).toBe('not-found')
  })

  test('a channel guest starts one from meet’s own page, at their door, and a guest outside the channel cannot; a guest has no way to make any other call', async () => {
    const s = await setup()
    const ch = await s.channel(OWNER, 'clients')
    await s.a.tm(OWNER, 'POST', `/channels/${ch}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const gus = await s.a.signIn('gus@client.test')
    const made = await s.a.gu(gus, 'POST', `/conversations/${ch}/huddle`, { key: key('g') })
    expect(made.status).toBe(201)
    expect(made.json.link).toBe(`${MEET}/r/${made.json.name}`)
    // Once per key.
    expect((await s.a.gu(gus, 'POST', `/conversations/${ch}/huddle`, { key: key('g') })).json).toMatchObject({ repeated: true, name: made.json.name })
    // The teammate sees it as a message in the channel, from Gus.
    const history = ok(await s.meet.history(await s.as(OWNER), ch))
    expect(history.messages[0]).toMatchObject({ huddle: made.json.name, authorName: 'Gus' })
    // Another channel the guest is not in: not found. A guest cannot start a call that is not a huddle, whatever they send the core.
    const other = await s.channel(OWNER, 'private-ops')
    expect((await s.a.gu(gus, 'POST', `/conversations/${other}/huddle`, { key: key('x') })).status).toBe(404)
    const guestActor = { via: 'session' as const, hash: await sha(gus) }
    await expect(Promise.resolve().then(() => s.h.workspaceCore.callBegin(guestActor, key('n'), 'new', null, s.h.clock.now))).rejects.toMatchObject({ status: 403 })
  })

  test('a huddle takes the sender’s place in the rate limit: the seventh in ten seconds is refused, and the same key works once the window has passed', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    for (let i = 0; i < 6; i++) ok(await huddle(s, OWNER, conv, `r${i}`))
    const refused = await huddle(s, OWNER, conv, 'late')
    expect(refusal(refused)).toBe('limit')
    const rooms = (await s.h.deps.ledger().listCalls(50, null)).calls.length
    s.h.clock.now += 11_000
    ok(await huddle(s, OWNER, conv, 'late'))
    expect((await s.h.deps.ledger().listCalls(50, null)).calls.length).toBe(rooms + 1)
  })

  test('pressing twice with one key is one call and one message', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const first = ok(await huddle(s, OWNER, conv, 'once'))
    const second = await huddle(s, OWNER, conv, 'once')
    expect(second).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated', earlier: { state: 'done' } })
    expect((second as { earlier: { reply: { ok: boolean; value: MeetCall } } }).earlier.reply.value.name).toBe(first.name)
    expect(messagesIn(s, conv)).toBe(1)
    expect(calls(s)).toBe(1)
  })
})

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('the meter: new calls and new joins are refused from 800 GB, and people already in carry on', () => {
  test('a huddle, a call, a call link and a meeting are all refused with the day calls resume, and leave nothing behind', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    s.h.spend(800e9)
    const before = { calls: calls(s), messages: messagesIn(s, conv), ledger: (await s.h.deps.ledger().listCalls(50, null)).calls.length }
    const as = await s.as(OWNER)
    const refused = [
      await s.meet.startHuddle(as, { key: key('p1'), conversationId: conv }),
      await s.meet.startCall(as, { key: key('p2') }),
      await s.meet.startCall(as, { key: key('p3'), home: 'corin@client.test' }),
      await s.meet.bookMeeting(as, { key: key('p4'), title: 'Kickoff', startsAt: T0 + 86_400_000, home: 'corin@client.test' }),
    ]
    for (const r of refused) expect(r).toMatchObject({ ok: false, kind: 'refused', reason: 'limit', message: 'Calls are paused until 2026-11-01.' })
    expect({ calls: calls(s), messages: messagesIn(s, conv), ledger: (await s.h.deps.ledger().listCalls(50, null)).calls.length }).toEqual(before)
    // A key a refusal used is free: once the month turns, the same key makes the call.
    s.h.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1)
    ok(await s.meet.startHuddle(await s.as(OWNER), { key: key('p1'), conversationId: conv }))
  })

  test('a call made before the trip refuses a new person at 800 GB, and a person already in it carries on', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const made = ok(await huddle(s, OWNER, conv))
    const ana = await s.joinCall(made.name, 'ana')
    expect(ana.status).toBe(200)
    s.h.spend(800e9)
    const late = await s.joinCall(made.name, 'late')
    expect(late).toMatchObject({ status: 403, error: 'Calls are paused until 2026-11-01.' })
    expect((await s.h.call('POST', `/r/api/rooms/${made.name}/join`, { name: 'ana' }, { token: ana.tok })).status).toBe(200)
  })

  test('the usage is the owner’s to read, and says whether the meter has tripped', async () => {
    const s = await setup()
    expect(ok(await s.meet.usage(await s.as(OWNER)))).toMatchObject({ usedGb: 0, freeGb: 1000, tripGb: 800, paused: false, pausedUntil: null })
    s.h.spend(812e9)
    expect(ok(await s.meet.usage(await s.as(OWNER)))).toMatchObject({ usedGb: 812, paused: true, pausedUntil: '2026-11-01' })
    expect(await s.meet.usage(await s.as(ANA))).toMatchObject({ ok: false, reason: 'not-admitted' })
  })
})

describe('every link is on the one configured address, which is the space’s', () => {
  test('a huddle, a call link, a New call and a meeting each carry a link on the public address, and every list carries the same', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const conv = await s.dm(OWNER, ANA)
    const made = [
      ok(await huddle(s, OWNER, conv)),
      ok(await s.meet.startCall(as, { key: key('l'), home: 'corin@client.test' })),
      ok(await s.meet.startCall(as, { key: key('n'), title: 'Standup' })),
      ok(await s.meet.bookMeeting(as, { key: key('m'), title: 'Kickoff', startsAt: T0 + 3_600_000, home: 'corin@client.test', invitees: [{ name: 'Corin', address: 'Corin@Client.test' }] })),
    ]
    for (const c of made) expect(c.link).toBe(`${MEET}/r/${c.name}`)
    expect(made.map((c) => c.kind)).toEqual(['huddle', 'link', 'new', 'meeting'])
    const everyLink = [
      ...ok(await s.meet.cards(as, { conversationIds: [conv], homes: ['corin@client.test'] })).map((c) => c.link),
      ...ok(await s.meet.calls(as)).calls.map((c) => c.link),
      ...ok(await s.meet.meetings(as, T0, T0 + 86_400_000)).map((c) => c.link),
      ...(ok(await s.meet.conversations(as)).calls ?? []).map((c) => c.link),
    ]
    expect(everyLink.length).toBeGreaterThanOrEqual(8)
    for (const link of everyLink) {
      expect(link.startsWith(`${MEET}/r/`)).toBe(true)
      // The page's decision, for a page at the space: it recognises exactly these links, and builds none of its own.
      expect(callOf(link, siteOrigin({ origin: 'https://space.northfield.example' }))).not.toBeNull()
      expect(link).not.toContain('meet.northfield.example')
    }
  })

  test('a link is made from the Worker’s configured address and from nothing the request carried', async () => {
    const s = await setup()
    const other = spaceMeet({ ...{ install: s.h.deps.install, workspace: s.h.deps.workspace, room: s.h.deps.room, ledger: s.h.deps.ledger, mailer: s.h.deps.mailer, now: () => s.h.clock.now, randomBytes: s.h.deps.randomBytes }, appOrigin: 'https://meet.client.test/' })
    const made = ok(await other.startCall(await s.as(OWNER), { key: key('c') }))
    expect(made.link).toBe(`https://meet.client.test/r/${made.name}`)
  })
})

describe('call links and New calls', () => {
  test('a call link belongs to the conversation it was made from, is seen by the person who made it alone, and a New call has no home', async () => {
    const s = await setup()
    const link = ok(await s.meet.startCall(await s.as(OWNER), { key: key('l'), home: 'corin@client.test' }))
    const solo = ok(await s.meet.startCall(await s.as(OWNER), { key: key('n'), title: '  Weekly   sync ' }))
    expect(link).toMatchObject({ kind: 'link', home: 'corin@client.test', title: null, conversationId: null })
    expect(solo).toMatchObject({ kind: 'new', home: null, title: 'Weekly sync' })
    expect(ok(await s.meet.cards(await s.as(OWNER), { conversationIds: [], homes: ['corin@client.test'] })).map((c) => c.name)).toEqual([link.name])
    // Ana asks for the same home and is told of nothing.
    expect(ok(await s.meet.cards(await s.as(ANA), { conversationIds: [], homes: ['corin@client.test'] }))).toEqual([])
    // The New call is a row of the maker's own, and of nobody else's.
    expect(ok(await s.meet.conversations(await s.as(OWNER))).calls?.map((c) => c.name)).toEqual([solo.name])
    expect(ok(await s.meet.conversations(await s.as(ANA))).calls).toEqual([])
  })

  test('the card says who is in the call, and how long it ran once everyone has left', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const made = ok(await s.meet.startCall(as, { key: key('l'), home: 'corin@client.test' }))
    const card = async () => ok(await s.meet.cards(as, { conversationIds: [], homes: ['corin@client.test'] }))[0] as MeetCall
    expect(await card()).toMatchObject({ present: 0, people: 0, endedAt: null })
    const ana = await s.joinCall(made.name, 'ana')
    const ben = await s.joinCall(made.name, 'ben')
    expect(await card()).toMatchObject({ present: 2, people: 2, endedAt: null })
    s.h.clock.now += 20_000
    // Ben's browser checks in every two seconds; Ana leaves.
    await s.h.call('POST', `/r/api/rooms/${made.name}/checkin`, { generation: ben.generation }, { token: ben.tok })
    await s.h.call('POST', `/r/api/rooms/${made.name}/leave`, { generation: ana.generation }, { token: ana.tok })
    expect(await card()).toMatchObject({ present: 1, endedAt: null })
    s.h.clock.now += 20_000
    const leftAt = s.h.clock.now
    await s.h.call('POST', `/r/api/rooms/${made.name}/leave`, { generation: ben.generation }, { token: ben.tok })
    expect(await card()).toMatchObject({ present: 0, people: 2, endedAt: leftAt })
    // Someone dropped as gone ended it when they were last heard from.
    const second = ok(await s.meet.startCall(as, { key: key('l2'), home: 'corin@client.test' }))
    await s.joinCall(second.name, 'cy')
    const heard = s.h.clock.now
    s.h.clock.now += MEMBER_TIMEOUT_MS + 5_000
    const dropped = ok(await s.meet.cards(as, { conversationIds: [], homes: ['corin@client.test'] })).find((c) => c.name === second.name)
    expect(dropped).toMatchObject({ present: 0, endedAt: heard })
  })

  test('only a teammate makes one, and only for an address the space can name', async () => {
    const s = await setup()
    expect(await s.meet.startCall(await s.as('eve@elsewhere.test'), { key: key('e') })).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(refusal(await s.meet.startCall(await s.as(OWNER), { key: 'short' }))).toBe('bad-request')
    expect(refusal(await s.meet.startCall(await s.as(OWNER), { key: key('t'), home: 'x'.repeat(400) }))).toBe('bad-request')
  })
})

describe('meetings with a time', () => {
  const tomorrow = T0 + 86_400_000

  test('one is booked from an email conversation with a time and the people invited, its call made ahead so the link works from then on, and nothing is emailed', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const mailBefore = s.h.mail.length
    const m = ok(
      await s.meet.bookMeeting(as, {
        key: key('m'),
        title: ' Kickoff  call ',
        startsAt: tomorrow,
        home: 'corin@client.test',
        invitees: [{ name: 'Corin Pike', address: 'Corin@Client.test' }, { name: 'Dana', address: null }],
      }),
    )
    expect(m).toMatchObject({
      kind: 'meeting',
      title: 'Kickoff call',
      startsAt: tomorrow,
      home: 'corin@client.test',
      invitees: [{ name: 'Corin Pike', address: 'corin@client.test' }, { name: 'Dana', address: null }],
      present: 0,
    })
    // The call exists from now on: the link works before anyone has joined and long before the meeting.
    expect((await s.h.call('GET', `/r/api/rooms/${m.name}`)).status).toBe(200)
    expect((await s.joinCall(m.name, 'corin')).status).toBe(200)
    // No email went out: the invitation is text the space puts in the email being written, which a person sends.
    expect(s.h.mail.length).toBe(mailBefore)
    expect(s.h.mail.filter((x) => /corin|invitation|meeting/i.test(`${x.to} ${x.subject}`))).toEqual([])
  })

  test('one made in a direct message or a channel invites the people in it, by their addresses', async () => {
    const s = await setup()
    const ch = await s.channel(OWNER, 'ops', [ANA, BEN])
    const m = ok(await s.meet.bookMeeting(await s.as(OWNER), { key: key('c'), title: 'Ops review', startsAt: tomorrow, conversationId: ch }))
    expect(m.invitees.map((i) => i.address).sort()).toEqual([ANA, BEN])
    expect(m.conversationId).toBe(ch)
    // A member sees it as a card of the channel and on their own meetings; someone outside does not.
    expect(ok(await s.meet.cards(await s.as(ANA), { conversationIds: [ch], homes: [] })).map((c) => c.name)).toEqual([m.name])
    expect(ok(await s.meet.meetings(await s.as(BEN), T0, tomorrow + 1)).map((c) => c.name)).toEqual([m.name])
  })

  test('the people invited see it by address; nobody else does', async () => {
    const s = await setup()
    const m = ok(
      await s.meet.bookMeeting(await s.as(OWNER), { key: key('i'), title: 'Planning', startsAt: tomorrow, home: 'ana@northfield.example', invitees: [{ name: 'Ana', address: ANA }] }),
    )
    const window = [T0, tomorrow + 3_600_000] as const
    expect(ok(await s.meet.meetings(await s.as(OWNER), ...window)).map((c) => c.name)).toEqual([m.name])
    expect(ok(await s.meet.meetings(await s.as(ANA), ...window)).map((c) => c.name)).toEqual([m.name])
    expect(ok(await s.meet.meetings(await s.as(BEN), ...window))).toEqual([])
  })

  test('a window is respected and the soonest comes first', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const late = ok(await s.meet.bookMeeting(as, { key: key('a'), title: 'Late', startsAt: tomorrow + 5 * 3_600_000, home: 'x@x.test' }))
    const early = ok(await s.meet.bookMeeting(as, { key: key('b'), title: 'Early', startsAt: tomorrow, home: 'x@x.test' }))
    const far = ok(await s.meet.bookMeeting(as, { key: key('c'), title: 'Far', startsAt: tomorrow + 20 * 86_400_000, home: 'x@x.test' }))
    expect(ok(await s.meet.meetings(as, T0, tomorrow + 86_400_000)).map((c) => c.name)).toEqual([early.name, late.name])
    expect(ok(await s.meet.meetings(as, tomorrow + 86_400_000, tomorrow + 30 * 86_400_000)).map((c) => c.name)).toEqual([far.name])
  })

  test('a booking is refused when it has no title, no time in range, no home, both homes, or an address that is not one', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const conv = await s.dm(OWNER, ANA)
    const bad = (b: Record<string, unknown>) => s.meet.bookMeeting(as, { key: key(`b${Math.random()}`), title: 'T', startsAt: tomorrow, home: 'x@x.test', ...b } as never)
    for (const [why, r] of Object.entries({
      'no title': await bad({ title: '   ' }),
      'a time long past': await bad({ startsAt: T0 - 3_600_000 }),
      'a time over a year away': await bad({ startsAt: T0 + 400 * 86_400_000 }),
      'a time that is not a whole number': await bad({ startsAt: 1.5 }),
      'no conversation': await bad({ home: null }),
      'two conversations': await bad({ conversationId: conv }),
      'an invitee that is no address': await bad({ invitees: [{ name: 'X', address: 'not an address' }] }),
      'an invitee with nothing': await bad({ invitees: [{ name: '', address: null }] }),
      'too many invitees': await bad({ invitees: Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, address: null })) }),
    })) {
      expect([why, refusal(r)]).toEqual([why, 'bad-request'])
    }
    expect(calls(s)).toBe(0)
  })

  test('pressing Book twice with one key is one meeting', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const first = ok(await s.meet.bookMeeting(as, { key: key('d'), title: 'Once', startsAt: tomorrow, home: 'x@x.test' }))
    const again = await s.meet.bookMeeting(as, { key: key('d'), title: 'Once', startsAt: tomorrow, home: 'x@x.test' })
    expect(again).toMatchObject({ ok: false, reason: 'repeated' })
    expect(calls(s)).toBe(1)
    expect(ok(await s.meet.meetings(as, T0, tomorrow + 86_400_000)).map((c) => c.name)).toEqual([first.name])
  })
})

describe('past calls and their saved chat', () => {
  test('a person sees the calls they made, the huddles of their conversations and the calls made at /start, before it went, for the owner, newest first, and not the calls of other people', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const startPage = await s.h.startCall()
    s.h.clock.now += 1000
    const huddled = ok(await huddle(s, ANA, conv))
    s.h.clock.now += 1000
    const mine = ok(await s.meet.startCall(await s.as(OWNER), { key: key('n'), title: 'Mine' }))
    s.h.clock.now += 1000
    const anas = ok(await s.meet.startCall(await s.as(ANA), { key: key('a'), title: 'Ana alone' }))
    const tessa = ok(await s.meet.calls(await s.as(OWNER))).calls.map((c) => c.name)
    expect(tessa).toEqual([mine.name, huddled.name, startPage])
    const ana = ok(await s.meet.calls(await s.as(ANA))).calls.map((c) => c.name)
    expect(ana).toEqual([anas.name, mine.name === anas.name ? '' : huddled.name].filter(Boolean))
    expect(ok(await s.meet.calls(await s.as(BEN))).calls).toEqual([])
  })

  test('it pages, every call once, with a cursor, and skips the calls of others without losing the page’s size', async () => {
    const s = await setup()
    const as = await s.as(OWNER)
    const mine: string[] = []
    for (let i = 0; i < 7; i++) {
      s.h.clock.now += 1000
      mine.push(ok(await s.meet.startCall(as, { key: key(`m${i}`), title: `M${i}` })).name)
      s.h.clock.now += 1000
      ok(await s.meet.startCall(await s.as(ANA), { key: key(`a${i}`) }))
    }
    const seen: string[] = []
    let after: string | undefined
    for (let page = 0; page < 6; page++) {
      const got = ok(await s.meet.calls(as, after, 3))
      expect(got.calls.length).toBeLessThanOrEqual(3)
      seen.push(...got.calls.map((c) => c.name))
      if (!got.next) break
      after = got.next
    }
    expect(seen).toEqual([...mine].reverse())
    expect(refusal(await s.meet.calls(as, 'not a cursor'))).toBe('bad-request')
  })

  test('a call’s chat is read where the call can be seen, and by no one else; the owner deletes it once nobody is in the call', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const made = ok(await huddle(s, OWNER, conv))
    const ana = await s.joinCall(made.name, 'ana')
    await s.h.call('POST', `/r/api/rooms/${made.name}/chat`, { generation: ana.generation, text: 'can you hear me' }, { token: ana.tok })
    const chat = ok(await s.meet.callChat(await s.as(OWNER), made.name))
    expect(chat.call).toMatchObject({ name: made.name, messages: 1, present: 1 })
    expect(chat.messages).toMatchObject([{ name: 'ana', text: 'can you hear me' }])
    expect(ok(await s.meet.callChat(await s.as(ANA), made.name)).messages).toHaveLength(1)
    expect(refusal(await s.meet.callChat(await s.as(BEN), made.name))).toBe('not-found')
    expect(refusal(await s.meet.callChat(await s.as(OWNER), 'nope'))).toBe('not-found')
    // Deleting is the owner's, and refused while someone is in the call.
    expect(refusal(await s.meet.deleteCallChat(await s.as(ANA), made.name))).toBe('not-admitted')
    expect(refusal(await s.meet.deleteCallChat(await s.as(OWNER), made.name))).toBe('conflict')
    await s.h.call('POST', `/r/api/rooms/${made.name}/leave`, { generation: ana.generation }, { token: ana.tok })
    expect(ok(await s.meet.deleteCallChat(await s.as(OWNER), made.name))).toEqual({ deleted: 1 })
    expect(ok(await s.meet.callChat(await s.as(OWNER), made.name)).messages).toEqual([])
  })
})

describe('Happening now: a huddle in a conversation, a meeting one is invited to, a call one made', () => {
  test('each is shown to the right person with why', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const hud = ok(await huddle(s, OWNER, conv))
    const meeting = ok(await s.meet.bookMeeting(await s.as(OWNER), { key: key('m'), title: 'Sync', startsAt: T0 + 60_000, home: 'ana@northfield.example', invitees: [{ name: 'Ana', address: ANA }] }))
    const own = ok(await s.meet.startCall(await s.as(OWNER), { key: key('n') }))
    for (const [n, who] of [[hud.name, 'a'], [meeting.name, 'b'], [own.name, 'c']] as const) await s.joinCall(n, who)
    const tessa = ok(await s.meet.liveCalls(await s.as(OWNER)))
    expect(Object.fromEntries(tessa.map((c) => [c.name, c.why]))).toEqual({ [hud.name]: 'started', [meeting.name]: 'started', [own.name]: 'started' })
    const ana = ok(await s.meet.liveCalls(await s.as(ANA)))
    expect(Object.fromEntries(ana.map((c) => [c.name, c.why]))).toEqual({ [hud.name]: 'conversation', [meeting.name]: 'invited' })
    expect(ok(await s.meet.liveCalls(await s.as(BEN)))).toEqual([])
  })

  test('a call nobody is in is not listed', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    ok(await huddle(s, OWNER, conv))
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toEqual([])
    expect(ok(await s.meet.liveCalls(await s.as(ANA)))).toEqual([])
  })
})

describe('the Phone conversation in the space', () => {
  test('a voicemail and a missed call are items with their number and Call back data, unread until read, and it is marked read from the space', async () => {
    const s = await setup()
    // The owner is on the phone list from the moment meet first knows them: history from before they came is not unread.
    await s.meet.conversations(await s.as(OWNER))
    const desk = s.h.workspaceCore.phoneDesk()
    const vm = desk.post('Voicemail from (626) 555-0100, 0:42', { kind: 'voicemail', id: 1, number: '+16265550100', display: '(626) 555-0100', seconds: 42 }, T0)
    const missed = desk.post('Missed call from (626) 555-0111', { kind: 'missed', number: '+16265550111', display: '(626) 555-0111' }, T0 + 1000)
    const as = await s.as(OWNER)
    const summary = ok(await s.meet.conversations(as)).phone
    expect(summary).toMatchObject({ unread: 2, newest: { text: 'Missed call from (626) 555-0111' } })
    const phone = ok(await s.meet.phoneConversation(as))
    expect(phone).toMatchObject({ unread: 2, more: false })
    expect(phone.items).toMatchObject([
      { id: vm, kind: 'voicemail', number: '+16265550100', display: '(626) 555-0100', seconds: 42 },
      { id: missed, kind: 'missed', number: '+16265550111', seconds: null },
    ])
    expect(ok(await s.meet.phoneRead(as, missed))).toMatchObject({ upTo: missed })
    expect(ok(await s.meet.phoneConversation(as)).unread).toBe(0)
    // The Phone conversation is not among the direct messages and channels, and cannot be read or written as one.
    expect(ok(await s.meet.conversations(as)).direct.length + ok(await s.meet.conversations(as)).channels.length).toBe(0)
    expect(refusal(await s.meet.history(as, phone.conversationId))).toBe('not-found')
    expect(refusal(await s.meet.post(as, { key: key('p'), target: { conversationId: phone.conversationId }, text: 'hi' }))).toBe('not-found')
  })

  test('a person who is not on the list has no Phone conversation', async () => {
    const s = await setup()
    expect(await s.meet.phoneConversation(await s.as('eve@elsewhere.test'))).toMatchObject({ ok: false, reason: 'not-admitted' })
  })
})

describe('what the space can reach in meet through fetch: the phone under one path', () => {
  const reached: string[] = []
  const route = (r: Request) => {
    reached.push(`${r.method} ${new URL(r.url).pathname}`)
    return new Response('routed')
  }
  const ask = (method: string, path: string) => serveForSpace(new Request(`https://space.northfield.example${path}`, { method }), route)

  test('the paths are the contract’s', () => {
    expect(MEET_FOR_SPACE_FETCH_PREFIXES).toEqual(['/space/phone'])
  })

  test('the phone by any method at its path and under it; everything else of meet is 404, the old team socket included', async () => {
    reached.length = 0
    for (const [m, p] of [['GET', '/space/phone'], ['GET', '/space/phone/'], ['POST', '/space/phone/call'], ['PUT', '/space/phone/address'], ['DELETE', '/space/phone/messages/3'], ['GET', '/space/phone/voicemail/3/audio']] as const) {
      expect([m, p, (await ask(m, p)).status]).toEqual([m, p, 200])
    }
    const before = reached.length
    for (const [m, p] of [
      ['GET', '/api/w/socket'],
      ['POST', '/api/w/socket'],
      ['GET', '/start/api/rooms'],
      ['POST', '/start/api/rooms'],
      ['GET', '/start/api/w/bootstrap'],
      ['GET', '/r/api/rooms/abc'],
      ['POST', '/r/api/phone/webhook'],
      ['GET', '/space/phonebook'],
      ['GET', '/space'],
      ['GET', '/space/other'],
      ['GET', '/space/phone/../start/api/rooms'],
      ['GET', '/space/phone/%2e%2e/start'],
      ['GET', '/'],
    ] as const) {
      expect([m, p, (await ask(m, p)).status]).toEqual([m, p, 404])
    }
    expect(reached.length).toBe(before)
  })

  test('the phone is the person the space’s check named, and nobody else: with no person the route is a 401, with one it answers, and the Worker’s own router has no such route', async () => {
    const s = await setup()
    const path = '/space/phone'
    const noOne = await s.h.callPart(null, 'GET', path)
    const tessa = await s.h.callPart(OWNER, 'GET', path)
    expect([noOne.status, tessa.status]).toEqual([401, 200])
    // The guests' door has no such route, whatever is presented to it.
    for (const p of ['/space/phone', '/space/phone/calls', '/space/phone/token']) {
      expect([p, (await s.h.call('GET', p)).status]).toEqual([p, 404])
    }
    expect(tessa.json).toMatchObject({ available: true, sdk: 'telnyx' })
    expect(G).toBe('/w/api') // the guests' base; a teammate has no socket on meet: the space's live object holds it
  })

  test('a person not on the phone list, and a phone not set up, see not available; the space’s writes need its own Origin', async () => {
    const s = await setup()
    expect((await s.h.callPart(ANA, 'GET', '/space/phone')).json).toEqual({ available: false })
    s.h.phoneOff.on = true
    expect((await s.h.callPart(OWNER, 'GET', '/space/phone')).json).toEqual({ available: false })
    s.h.phoneOff.on = false
    // A write from another site is refused before anything happens.
    const cross = await s.h.callPart(OWNER, 'POST', '/space/phone/ack', undefined, { origin: 'https://evil.test' })
    expect(cross.status).toBe(403)
  })
})

describe('the room remembers when it emptied', () => {
  test('a call nobody joined has no end, and a call someone left ends when they left', async () => {
    const s = await setup()
    const made = ok(await s.meet.startCall(await s.as(OWNER), { key: key('e') }))
    expect((await s.h.deps.room(made.name).summary(s.h.clock.now)).endedAt).toBeNull()
    const a = await s.joinCall(made.name, 'ann')
    expect(await s.h.deps.room(made.name).summary(s.h.clock.now)).toMatchObject({ endedAt: null, openedAt: s.h.clock.now })
    const opened = s.h.clock.now
    s.h.clock.now += 5000
    await s.h.call('POST', `/r/api/rooms/${made.name}/leave`, { generation: a.generation }, { token: a.tok })
    expect((await s.h.deps.room(made.name).summary(s.h.clock.now)).endedAt).toBe(s.h.clock.now)
    // Joining again clears it from view while the person is in, and the call still began when the first person took a seat.
    await s.joinCall(made.name, 'ann')
    expect(await s.h.deps.room(made.name).summary(s.h.clock.now)).toMatchObject({ endedAt: null, openedAt: opened })
  })
})

describe('the same person is one actor whichever door asks', () => {
  test('a huddle Tessa starts as a teammate through the routes is the same call the space lists', async () => {
    const s = await setup()
    const conv = await s.dm(OWNER, ANA)
    const r = await s.a.tm(OWNER, 'POST', `/conversations/${conv}/huddle`, { key: key('t') })
    expect(r.status).toBe(201)
    expect(ok(await s.meet.cards(await s.as(OWNER), { conversationIds: [conv], homes: [] })).map((c) => c.name)).toEqual([r.json.name])
    expect(NOT_ADMITTED).toBeTruthy()
  })
})
