// Channel admin in the space (the retirement of meet.northfield.example/start), driven through the real router with a stand-in meet behind the binding. What is asserted is what a person
// sees or what is refused, never the Worker's internals: that every new path is behind the sign-in, that a write goes through the one POST guard (this host's Origin, a JSON
// body), that meet's refusals arrive in meet's words, that a channel made and a guest invited carry a key meet holds (so pressing twice is one channel and ONE EMAIL), that the
// invitation is sent by Invite and by nothing else, that a lost write is never retried, and that a channel nobody has written in has its row.
// Who may archive, and what a person outside a channel is never told, are meet's rules and are proved in packages/meet/test/space-channels.test.ts over the real Workspace core.
import { describe, expect, test } from 'bun:test'
import type { MeetBrowsable, MeetChanged, MeetChannelDetail, MeetInvited } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import type { ConversationAnswer } from '../src/conversation'
import type { ConversationsAnswer } from '../src/conversations'
import type { ViewAnswer } from '../src/views'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { NORTHFIELD_TEAM, ago, channel, contact, dm, person, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`
const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

async function asOwner(o: { noMeet?: boolean; owner?: boolean; writeWithinMs?: number } = {}) {
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [])
  const meet = standInMeet(
    { direct: [dm(11, priya, ago(30), 0, 'See you there')], channels: [channel(21, 'launch', ago(60)), { ...channel(22, 'ops', null), privacy: 'private' as const, createdAt: ago(5) }] },
    {
      channels: {
        owner: o.owner ?? true,
        people: [
          { ...priya, direct: true },
          { ...dana, invitedByMe: true, invited: true },
        ],
        rooms: { 21: { createdByMe: false, members: ['p-priya'] }, 22: { createdByMe: true, members: [] } },
        open: [{ conversationId: 31, name: 'design', memberCount: 3 }],
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

const NEW = '/api/meet/channel-create'
const INVITE = '/api/meet/channel-invite'
const CHANGE = '/api/meet/channel-change'

describe('every new path is behind the sign-in', () => {
  test('no sign-in is refused at every new path, reads and writes, and meet is never asked', async () => {
    const s = await asOwner()
    const reads = ['/api/meet/channel?conversation=21', '/api/meet/browse']
    for (const path of reads) expect([path, (await s.w.call(path)).status]).toEqual([path, 401])
    const writes: Array<[string, unknown]> = [
      [NEW, { key: key(1), name: 'ops2', privacy: 'open' }],
      [INVITE, { key: key(2), conversationId: 21, name: 'Dana', address: 'dana@harbor.example' }],
      [CHANGE, { do: 'archive', conversationId: 21 }],
    ]
    for (const [path, body] of writes) {
      const res = await s.w.call(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect([path, res.status]).toEqual([path, 401])
    }
    expect(s.meet.asked.askers).toEqual([])
    expect(s.meet.admin.emailed).toEqual([])
  })

  test('a person Cloudflare signed for who is not of this company, a cookie alone, and an assertion for another application are all refused', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('eve@elsewhere.test')
    const cookieOnly = await s.w.call(NEW, { method: 'POST', cookieJwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ key: key(1), name: 'x', privacy: 'open' }) })
    expect(cookieOnly.status).toBe(401)
    const outsider = await s.w.call(INVITE, { method: 'POST', jwt: stranger, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ key: key(2), conversationId: 21, name: 'Dana', address: 'dana@harbor.example' }) })
    expect(outsider.status).toBe(403)
    const forms = await s.w.call(CHANGE, { method: 'POST', jwt: await s.w.signInForms('tessa@northfield.example'), headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ do: 'archive', conversationId: 21 }) })
    expect(forms.status).toBe(401)
    expect(s.meet.asked.askers).toEqual([])
    expect(s.meet.admin.emailed).toEqual([])
  })
})

describe('every write goes through the one POST guard', () => {
  test('another site’s write, a body that is not JSON, other methods and other paths are refused before meet is asked', async () => {
    const s = await asOwner()
    const body = { key: key(1), name: 'ops2', privacy: 'open' }
    expect((await s.post(NEW, body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await s.w.call(NEW, { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status).toBe(415)
    expect((await s.w.call(NEW, { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN } })).status).toBe(415)
    expect((await s.w.call(NEW, { method: 'PUT', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(405)
    expect((await s.w.call(INVITE, { method: 'DELETE', jwt: s.jwt, headers: { origin: ORIGIN } })).status).toBe(405)
    // A write path that is not one: nothing is accepted on it.
    expect((await s.post('/api/meet/channel-delete', { do: 'archive', conversationId: 21 })).status).toBe(405)
    expect((await s.post('/api/meet/channel', { do: 'archive', conversationId: 21 })).status).toBe(405)
    expect(s.meet.admin.made).toMatchObject({ channels: [], invites: [], changes: [] })
    expect(s.meet.admin.emailed).toEqual([])
  })

  test('a body that is not what the write takes is a 400 and meet is not asked', async () => {
    const s = await asOwner()
    const bad: Array<[string, unknown]> = [
      [NEW, { name: 'ops2', privacy: 'open' }],
      [NEW, { key: 'short', name: 'ops2', privacy: 'open' }],
      [NEW, { key: key(1), name: 7, privacy: 'open' }],
      [NEW, { key: key(1), name: 'ops2', privacy: 'secret' }],
      [INVITE, { key: key(1), conversationId: 21, name: 'Dana', address: 'not an address' }],
      [INVITE, { key: key(1), conversationId: '21', name: 'Dana', address: 'dana@harbor.example' }],
      [INVITE, { key: key(1), conversationId: 21, address: 'dana@harbor.example' }],
      [CHANGE, { do: 'explode', conversationId: 21 }],
      [CHANGE, { do: 'add', conversationId: 21 }],
      [CHANGE, { do: 'add', conversationId: 21, personId: '../../etc' }],
      [CHANGE, { do: 'rename', conversationId: 21 }],
      [CHANGE, { do: 'archive' }],
      [CHANGE, []],
    ]
    for (const [path, body] of bad) expect([path, JSON.stringify(body), (await s.post(path, body)).status]).toEqual([path, JSON.stringify(body), 400])
    expect((await s.get('/api/meet/channel')).status).toBe(400)
    expect((await s.get('/api/meet/channel?conversation=abc')).status).toBe(400)
    expect(s.meet.admin.made).toMatchObject({ channels: [], invites: [], changes: [], channelReads: [] })
  })
})

describe('New channel', () => {
  test('a channel is made with the person in it, answered as meet answers it, and the assertion is the request’s own', async () => {
    const s = await asOwner()
    const made = await s.answer<MeetChannelDetail>(NEW, { key: key(1), name: 'acme', privacy: 'private' })
    expect(made).toMatchObject({ result: 'ok', value: { name: 'acme', privacy: 'private', createdByMe: true, may: { archive: true } } })
    expect(s.meet.admin.made.channels).toEqual([{ key: key(1), name: 'acme', privacy: 'private' }])
    expect(s.meet.asked.askers).toEqual(['tessa@northfield.example'])
    expect(s.meet.admin.emailed).toEqual([])
  })

  test('the new channel has its row in Conversations at once, though nobody has written in it, and opens', async () => {
    const s = await asOwner()
    const made = await s.answer<MeetChannelDetail>(NEW, { key: key(1), name: 'acme', privacy: 'open' })
    if (made.result !== 'ok') throw new Error('not made')
    const list = (await s.get<ConversationsAnswer>('/api/conversations')).body
    const row = list.rows.find((r) => r.type === 'channel' && r.name === 'acme')
    expect(row).toMatchObject({ type: 'channel', key: `chat:channel:${made.value.conversationId}`, privacy: 'open', unread: 0, text: 'No messages yet.' })
    // ops (private, created by the stand-in with a time and no message) has one too, and a channel that meet gives no time for has none.
    expect(list.rows.some((r) => r.type === 'channel' && r.name === 'ops')).toBe(true)
    const opened = await s.get<ConversationAnswer>(`/api/conversation?key=${encodeURIComponent(`chat:channel:${made.value.conversationId}`)}`)
    expect(opened.status).toBe(200)
    expect(opened.body.row).toMatchObject({ type: 'channel', name: 'acme' })
  })

  test('a channel that meet gives no time for, and has no message, has no row (a meet from before the channel admin)', async () => {
    const inbox = standInInbox([], [])
    const old = { ...channel(40, 'quiet', null), createdAt: undefined }
    const meet = standInMeet({ direct: [], channels: [old] })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60 })
    const res = await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })
    expect(((await res.json()) as ConversationsAnswer).rows).toEqual([])
  })

  test('pressing twice is one channel: the second press answers the first, and meet made one', async () => {
    const s = await asOwner()
    const first = await s.answer<MeetChannelDetail>(NEW, { key: key(1), name: 'acme', privacy: 'open' })
    const again = await s.answer<MeetChannelDetail>(NEW, { key: key(1), name: 'acme', privacy: 'open' })
    expect(again).toEqual(first)
    const names = (await s.get<ConversationsAnswer>('/api/conversations')).body.rows.filter((r) => r.type === 'channel' && r.name === 'acme')
    expect(names).toHaveLength(1)
  })

  test('meet’s refusals come in meet’s words, and the key is released, so the same key makes it once the name is fixed', async () => {
    const s = await asOwner()
    expect(await s.answer(NEW, { key: key(1), name: '  ', privacy: 'open' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'Give the channel a name.' })
    expect(await s.answer(NEW, { key: key(2), name: 'LAUNCH', privacy: 'open' })).toMatchObject({ result: 'refused', reason: 'conflict', message: 'There is already a channel with that name.' })
    expect(await s.answer(NEW, { key: key(1), name: 'acme', privacy: 'open' })).toMatchObject({ result: 'ok', value: { name: 'acme' } })
  })

  test('a write the space loses track of is outcome-unknown, and is not asked again', async () => {
    const s = await asOwner({ writeWithinMs: 40 })
    s.meet.admin.steps.push('throw')
    expect(await s.answer(NEW, { key: key(1), name: 'acme', privacy: 'open' })).toMatchObject({ result: 'outcome-unknown' })
    s.meet.admin.steps.push('hang')
    expect(await s.answer(NEW, { key: key(2), name: 'acme', privacy: 'open' })).toMatchObject({ result: 'outcome-unknown' })
    expect(s.meet.admin.made.channels).toHaveLength(2)
  })

  test('meet not connected is said, not thrown', async () => {
    const s = await asOwner({ noMeet: true })
    expect(await s.answer(NEW, { key: key(1), name: 'acme', privacy: 'open' })).toMatchObject({ result: 'unreachable' })
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/browse')).body).toMatchObject({ result: 'unreachable' })
  })
})

describe('Browse channels and Join', () => {
  test('the open channels not joined are a name and a count, and joining one puts the person in it', async () => {
    const s = await asOwner()
    const got = await s.get<ViewAnswer<MeetBrowsable[]>>('/api/meet/browse')
    expect(got.body).toEqual({ result: 'ok', value: [{ conversationId: 31, name: 'design', memberCount: 3 }] })
    const joined = await s.answer<MeetChanged>(CHANGE, { do: 'join', conversationId: 31 })
    expect(joined).toMatchObject({ result: 'ok', value: { conversationId: 31, channel: { name: 'design' } } })
    expect((await s.get<ViewAnswer<MeetBrowsable[]>>('/api/meet/browse')).body).toEqual({ result: 'ok', value: [] })
  })
})

describe('a channel’s people', () => {
  test('meet’s answer for a channel: its people with what the person may do with each, and who can be added', async () => {
    const s = await asOwner()
    const got = await s.get<ViewAnswer<MeetChannelDetail>>('/api/meet/channel?conversation=21')
    expect(got.body).toMatchObject({ result: 'ok', value: { name: 'launch', may: { rename: true, archive: true } } })
    const value = (got.body as { value: MeetChannelDetail }).value
    expect(value.members.map((m) => [m.person.name, m.you])).toEqual([
      ['Tessa', true],
      ['Priya Natarajan', false],
    ])
    expect(value.addable.map((p) => p.name)).toEqual(['Dana Reyes'])
    expect(s.meet.asked.askers).toEqual(['tessa@northfield.example'])
  })

  test('a channel the person is not in is not-found, in the same words as one that does not exist', async () => {
    const s = await asOwner()
    const none = (await s.get<ViewAnswer<unknown>>('/api/meet/channel?conversation=999')).body
    expect(none).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect((await s.get<ViewAnswer<unknown>>('/api/meet/channel?conversation=31')).body).toEqual(none)
  })

  test('meet’s refusal to archive is shown in meet’s words when the person may not, and the channel stays', async () => {
    const s = await asOwner({ owner: false })
    expect(await s.answer(CHANGE, { do: 'archive', conversationId: 21 })).toMatchObject({
      result: 'refused',
      reason: 'not-admitted',
      message: 'Only the person who made a channel, or Tessa, can archive it.',
    })
    expect((await s.get<ViewAnswer<MeetChannelDetail>>('/api/meet/channel?conversation=21')).body).toMatchObject({ result: 'ok', value: { may: { archive: false } } })
  })

  test('archive takes the channel off the list; leave and rename answer as meet does', async () => {
    const s = await asOwner()
    expect(await s.answer(CHANGE, { do: 'rename', conversationId: 21, name: '#liftoff' })).toMatchObject({ result: 'ok', value: { channel: { name: 'liftoff' } } })
    expect(await s.answer(CHANGE, { do: 'archive', conversationId: 21 })).toEqual({ result: 'ok', value: { conversationId: 21, channel: null } })
    const rows = (await s.get<ConversationsAnswer>('/api/conversations')).body.rows
    expect(rows.some((r) => r.type === 'channel' && r.conversationId === 21)).toBe(false)
    expect(await s.answer(CHANGE, { do: 'leave', conversationId: 22 })).toMatchObject({ result: 'ok', value: { channel: null } })
  })
})

describe('Invite a guest: the one email, once, and only when Invite is pressed', () => {
  const invite = (n: number) => ({ key: key(n), conversationId: 22, name: 'Dana Reyes', address: 'Dana@Harbor.Example' })

  test('nothing is emailed by looking, making a channel, joining, renaming, adding, taking out or archiving; one invitation goes when Invite is pressed', async () => {
    const s = await asOwner()
    await s.get('/api/meet/channel?conversation=21')
    await s.get('/api/meet/browse')
    await s.answer(NEW, { key: key(1), name: 'acme', privacy: 'open' })
    await s.answer(CHANGE, { do: 'join', conversationId: 31 })
    await s.answer(CHANGE, { do: 'rename', conversationId: 21, name: 'liftoff' })
    await s.answer(CHANGE, { do: 'add', conversationId: 21, personId: 'p-dana' })
    await s.answer(CHANGE, { do: 'take-out', conversationId: 21, personId: 'p-dana' })
    await s.answer(CHANGE, { do: 'archive', conversationId: 21 })
    expect(s.meet.admin.emailed).toEqual([])
    const done = await s.answer<MeetInvited>(INVITE, invite(2))
    expect(done).toMatchObject({ result: 'ok', value: { conversationId: 22, mailed: true, person: { kind: 'guest', address: 'dana@harbor.example' } } })
    expect(s.meet.admin.emailed).toEqual(['dana@harbor.example'])
    expect(s.meet.admin.made.invites).toEqual([{ key: key(2), conversationId: 22, name: 'Dana Reyes', address: 'dana@harbor.example' }])
  })

  test('the same key twice sends one email: the second answers the first (that the page sends the same key again is channels-dom.test.tsx’s)', async () => {
    const s = await asOwner()
    const first = await s.answer<MeetInvited>(INVITE, invite(2))
    const again = await s.answer<MeetInvited>(INVITE, invite(2))
    expect(again).toEqual(first)
    expect(s.meet.admin.emailed).toEqual(['dana@harbor.example'])
  })

  test('an answer that is lost after meet sent the invitation is outcome unknown, and the same key afterwards sends nothing more and answers the first', async () => {
    const s = await asOwner()
    s.meet.admin.loseAnswer.next = true
    expect(await s.answer(INVITE, invite(2))).toMatchObject({ result: 'outcome-unknown' })
    expect(s.meet.admin.emailed).toEqual(['dana@harbor.example'])
    expect(await s.answer(INVITE, invite(2))).toMatchObject({ result: 'ok', value: { mailed: true, person: { address: 'dana@harbor.example' } } })
    expect(s.meet.admin.emailed).toEqual(['dana@harbor.example'])
    // A different key is a different press, and sends again.
    expect(await s.answer(INVITE, invite(3))).toMatchObject({ result: 'ok' })
    expect(s.meet.admin.emailed).toHaveLength(2)
  })

  test('an invitation that could not be sent leaves the guest in the channel and says so; a new press sends it', async () => {
    const s = await asOwner()
    s.meet.admin.mailFails.next = true
    expect(await s.answer(INVITE, invite(2))).toMatchObject({ result: 'ok', value: { mailed: false } })
    expect(s.meet.admin.emailed).toEqual([])
    expect(await s.answer(INVITE, invite(3))).toMatchObject({ result: 'ok', value: { mailed: true } })
    expect(s.meet.admin.emailed).toEqual(['dana@harbor.example'])
  })

  test('a Northfield Works person’s address and a missing name are refused in meet’s words and nothing is sent', async () => {
    const s = await asOwner()
    expect(await s.answer(INVITE, { ...invite(2), address: 'ben@northfield.example' })).toMatchObject({
      result: 'refused',
      reason: 'conflict',
      message: 'That address belongs to a Northfield Works person. Add them to the channel instead.',
    })
    expect(await s.answer(INVITE, { ...invite(3), name: '   ' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'Give the guest a name.' })
    expect(s.meet.admin.emailed).toEqual([])
  })

  test('the hour’s limit is shown and nothing is sent; a write that is lost is never asked again', async () => {
    const s = await asOwner({ writeWithinMs: 40 })
    s.meet.admin.steps.push('limit')
    expect(await s.answer(INVITE, invite(2))).toMatchObject({ result: 'refused', reason: 'limit' })
    s.meet.admin.steps.push('throw')
    expect(await s.answer(INVITE, invite(3))).toMatchObject({ result: 'outcome-unknown' })
    expect(s.meet.admin.emailed).toEqual([])
    expect(s.meet.admin.made.invites).toHaveLength(2)
  })

  test('the space draws no door for the guest: it answers nothing a guest could sign in by, and no path of it takes a guest', async () => {
    const s = await asOwner()
    const done = await s.answer<MeetInvited>(INVITE, invite(2))
    // Everything the space says of the guest is a name and an address; no link, no code, no session. The guest signs in at meet.northfield.example/w.
    expect(JSON.stringify(done)).not.toMatch(/https?:|\/w\b|code|token|session/i)
  })
})
