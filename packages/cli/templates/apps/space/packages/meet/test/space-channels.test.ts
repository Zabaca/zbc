// Channel admin for the space (the retirement of /start): New channel, Invite a guest, Archive, and the channel's people, a guest's access, Join, Leave,
// Rename. SpaceMeet's methods over the real Workspace core, with a signed assertion for the SPACE application as the one thing that says who is asking.
// The seam is the method, as the space calls it over a service binding: who may do what (meet's rules, in meet's words), what is sent (one invitation, once),
// what a person outside a channel is never told, and that the guest's own door at /w is still the door a guest comes in by.
import { describe, expect, test } from 'bun:test'
import {
  type SignedIn,
  COMPOSE_KEY_KEPT_MS,
  MEET_FOR_SPACE_METHODS,
  type MeetChannelChange,
  type MeetChannelDetail,
  NOT_ADMITTED,
  type SpaceReply,
} from '@space/workspace'
import { type SpaceMeetDeps, spaceMeet } from '../src/space-meet'
import { SENDS_PER_HOUR } from '../src/workspace-model'
import { ANA, BEN, OWNER, harness, signedAs } from './helpers'
import { G, W, actors } from './workspace.helpers'

const STRANGER = 'eve@elsewhere.test'
const DANA = 'dana@harbordental.example'

async function setup() {
  const h = await harness({ devBypass: false })
  const a = actors(h)
  const deps: SpaceMeetDeps = {
    install: h.deps.install,
    workspace: h.deps.workspace,
    room: h.deps.room,
    ledger: h.deps.ledger,
    appOrigin: h.deps.appOrigin,
    mailer: h.deps.mailer,
    now: () => h.clock.now,
    randomBytes: h.deps.randomBytes,
  }
  const meet = spaceMeet(deps)
  const as = async (email: string, exp = Math.floor(h.clock.now / 1000) + 3600): Promise<SignedIn> => signedAs(h.deps.install, email, exp)
  const idOf = async (email: string): Promise<string> => (await a.tm(email, 'GET', '/bootstrap')).json.me.id
  let n = 0
  const key = (what: string) => `${what}-${++n}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(24, 'x')
  const make = async (by: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<MeetChannelDetail> => {
    const r = await meet.createChannel(await as(by), { key: key('make'), name, privacy })
    return ok(r)
  }
  const invite = async (by: string, conversationId: number, address = DANA, name = 'Dana Reyes') => meet.inviteGuest(await as(by), { key: key('invite'), conversationId, name, address })
  const change = async (by: string, c: MeetChannelChange) => meet.changeChannel(await as(by), c)
  return { h, a, meet, deps, as, idOf, key, make, invite, change }
}

function ok<T>(r: SpaceReply<T> | { ok: boolean }): T {
  expect(r).toMatchObject({ ok: true })
  return (r as { value: T }).value
}

const refusal = (r: unknown) => r as { ok: false; kind: string; reason: string; message: string }

describe('who is asking: every new method is for a person of this install, whatever the space’s check named', () => {
  test('a person who is not of this install is not-admitted at every new method', async () => {
    const s = await setup()
    const stranger = await s.as(STRANGER)
    const rs = [
      await s.meet.channel(stranger, 1),
      await s.meet.browseChannels(stranger),
      await s.meet.createChannel(stranger, { key: s.key('x'), name: 'ops', privacy: 'open' }),
      await s.meet.inviteGuest(stranger, { key: s.key('y'), conversationId: 1, name: 'Dana', address: DANA }),
      await s.meet.changeChannel(stranger, { do: 'join', conversationId: 1 }),
    ]
    for (const r of rs) expect(r).toEqual({ ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
    expect(s.h.mail).toEqual([])
  })

  test('the methods are exactly the contract’s', async () => {
    const s = await setup()
    expect(Object.keys(s.meet).sort()).toEqual([...MEET_FOR_SPACE_METHODS].sort())
  })

  test('a channel guest never reaches the space: their address is not on the list, so it is not-admitted whatever the check named', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    ok(await s.invite(OWNER, ops.conversationId))
    expect(await s.meet.conversations(await s.as(DANA))).toEqual({ ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
    expect(refusal(await s.meet.channel(await s.as(DANA), ops.conversationId)).reason).toBe('not-admitted')
    expect(refusal(await s.meet.createChannel(await s.as(DANA), { key: s.key('g'), name: 'mine', privacy: 'open' })).reason).toBe('not-admitted')
  })
})

describe('New channel: who may make one, and meet’s own refusals in its own words', () => {
  test('a teammate makes an open or a private channel and is in it; the answer says what they may do', async () => {
    const s = await setup()
    const open = await s.make(ANA, 'launch', 'open')
    expect(open).toMatchObject({ name: 'launch', privacy: 'open', createdByMe: true })
    expect(open.members.map((m) => m.person.address)).toEqual([ANA])
    expect(open.members[0]).toMatchObject({ you: true, invited: false, may: { takeOut: false, removeFromWorkspace: false, deleteEverything: false } })
    expect(open.may).toEqual({ rename: true, leave: true, archive: true, add: true, invite: true })
    const priv = await s.make(ANA, 'ops', 'private')
    expect(priv.privacy).toBe('private')
    // A channel with nothing said in it is in the person's overview from the moment it is made, with the time it was made.
    const overview = ok(await s.meet.conversations(await s.as(ANA)))
    expect(overview.channels.map((c) => [c.name, c.newest, c.createdAt])).toEqual(
      expect.arrayContaining([
        ['launch', null, s.h.clock.now],
        ['ops', null, s.h.clock.now],
      ]),
    )
  })

  test('the refusals are meet’s, as /start gave them: a name is needed, open or private, a name is taken (any case), once and for all', async () => {
    const s = await setup()
    const ana = await s.as(ANA)
    expect(refusal(await s.meet.createChannel(ana, { key: s.key('a'), name: '   ', privacy: 'open' }))).toMatchObject({ reason: 'bad-request', message: 'Give the channel a name.' })
    expect(refusal(await s.meet.createChannel(ana, { key: s.key('b'), name: 'ops', privacy: 'secret' as never }))).toMatchObject({ reason: 'bad-request', message: 'A channel is open or private.' })
    await s.make(ANA, 'Ops')
    expect(refusal(await s.meet.createChannel(await s.as(BEN), { key: s.key('c'), name: 'ops', privacy: 'open' }))).toMatchObject({ reason: 'conflict', message: 'There is already a channel with that name.' })
    // A leading # is not part of a name, as at /start.
    expect(ok(await s.meet.createChannel(ana, { key: s.key('d'), name: '#plans', privacy: 'open' })).name).toBe('plans')
  })

  test('the key makes one channel: a second press answers the first and makes nothing; a refused first use releases the key', async () => {
    const s = await setup()
    const ana = await s.as(ANA)
    const k = s.key('once')
    const first = ok(await s.meet.createChannel(ana, { key: k, name: 'ops', privacy: 'private' }))
    const again = await s.meet.createChannel(ana, { key: k, name: 'ops', privacy: 'private' })
    expect(again).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: { conversationId: first.conversationId } } } })
    const count = (await s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'channel'`))[0]?.n
    expect(count).toBe(1)
    // A refusal records nothing: the same key makes the channel once the name is fixed.
    const k2 = s.key('fix')
    expect(refusal(await s.meet.createChannel(ana, { key: k2, name: '', privacy: 'open' })).reason).toBe('bad-request')
    expect(ok(await s.meet.createChannel(ana, { key: k2, name: 'fixed', privacy: 'open' })).name).toBe('fixed')
    // A key is a person's: another person's use of it is their own.
    expect(ok(await s.meet.createChannel(await s.as(BEN), { key: k, name: 'ben-ops', privacy: 'open' })).name).toBe('ben-ops')
    // And a key is held for the contract's day, then is free.
    s.h.clock.now += COMPOSE_KEY_KEPT_MS + 1
    expect(refusal(await s.meet.createChannel(await s.as(ANA), { key: k, name: 'ops', privacy: 'private' })).reason).toBe('conflict')
  })

  test('a malformed key is bad-request and makes nothing', async () => {
    const s = await setup()
    for (const bad of ['', 'short', 'has spaces in it that make it bad', 7 as never, undefined as never]) {
      expect(refusal(await s.meet.createChannel(await s.as(ANA), { key: bad, name: 'ops', privacy: 'open' })).reason).toBe('bad-request')
    }
    expect(ok(await s.meet.browseChannels(await s.as(BEN)))).toEqual([])
  })

  test('nothing is emailed by making a channel, or by anything but inviting a guest', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops', 'open')
    const ana = await s.as(ANA)
    ok(await s.meet.changeChannel(ana, { do: 'join', conversationId: ops.conversationId }))
    ok(await s.change(OWNER, { do: 'rename', conversationId: ops.conversationId, name: 'operations' }))
    ok(await s.change(ANA, { do: 'leave', conversationId: ops.conversationId }))
    ok(await s.change(OWNER, { do: 'archive', conversationId: ops.conversationId }))
    expect(s.h.mail).toEqual([])
  })
})

describe('what is never shown to someone outside a channel', () => {
  test('a private channel does not exist for a teammate who is not in it: not its people, not its guests, not a change to it; an open one is only a name and a count', async () => {
    const s = await setup()
    const secret = await s.make(OWNER, 'client-dana', 'private')
    ok(await s.invite(OWNER, secret.conversationId))
    const lobby = await s.make(OWNER, 'lobby', 'open')
    const ana = await s.as(ANA)

    // Reading: not found, in the same words as a channel that never was.
    const missing = refusal(await s.meet.channel(ana, 99_999))
    expect(refusal(await s.meet.channel(ana, secret.conversationId))).toEqual(missing)
    expect(missing).toMatchObject({ reason: 'not-found' })
    // An open channel is read by joining it.
    expect(refusal(await s.meet.channel(ana, lobby.conversationId)).reason).toBe('not-found')
    // Browsing names only open channels, with a count and nothing else.
    expect(ok(await s.meet.browseChannels(ana))).toEqual([{ conversationId: lobby.conversationId, name: 'lobby', memberCount: 1 }])
    expect(JSON.stringify(await s.meet.browseChannels(ana))).not.toContain('client-dana')
    expect(JSON.stringify(await s.meet.browseChannels(ana))).not.toContain(DANA)
    // Her overview has neither.
    expect(ok(await s.meet.conversations(ana)).channels).toEqual([])

    // Writing: the same not-found for every change, joining a private one included.
    const changes: MeetChannelChange[] = [
      { do: 'join', conversationId: secret.conversationId },
      { do: 'leave', conversationId: secret.conversationId },
      { do: 'rename', conversationId: secret.conversationId, name: 'mine' },
      { do: 'archive', conversationId: secret.conversationId },
      { do: 'add', conversationId: secret.conversationId, personId: await s.idOf(ANA) },
      { do: 'take-out', conversationId: secret.conversationId, personId: secret.members[0]?.person.id as string },
      { do: 'remove-guest', conversationId: secret.conversationId, personId: 'whoever' },
      { do: 'delete-person', conversationId: secret.conversationId, personId: 'whoever' },
      { do: 'archive', conversationId: lobby.conversationId },
    ]
    // Archiving an open channel one is not in is not-found too (the asker must be in the channel, as for removing a guest); a private one is not there at all.
    for (const c of changes) expect([c.do, refusal(await s.meet.changeChannel(ana, c)).reason]).toEqual([c.do, 'not-found'])
    // The owner is no exception: he does not archive, by the API, a private channel he is not in, and it is still there.
    const lonely = await s.make(ANA, 'ana-private', 'private')
    expect(refusal(await s.meet.changeChannel(await s.as(OWNER), { do: 'archive', conversationId: lonely.conversationId }))).toMatchObject({ reason: 'not-found' })
    expect(ok(await s.meet.channel(await s.as(ANA), lonely.conversationId)).name).toBe('ana-private')
    expect(refusal(await s.invite(ANA, secret.conversationId, 'other@example.test', 'Other')).reason).toBe('not-found')
    // Nothing happened to the channel, and nothing was sent but Tessa's own invitation.
    const still = ok(await s.meet.channel(await s.as(OWNER), secret.conversationId))
    expect(still.members.map((m) => m.person.kind).sort()).toEqual(['guest', 'teammate'])
    expect(s.h.mail.map((m) => m.to)).toEqual([DANA])
  })

  test('the guests of a channel are not addable by someone who shares nothing with them, and are by someone who does', async () => {
    const s = await setup()
    const secret = await s.make(OWNER, 'client-dana', 'private')
    const invited = ok(await s.invite(OWNER, secret.conversationId))
    const other = await s.make(ANA, 'ana-only', 'private')
    // A teammate who has never arrived is not a person of the workspace yet, at /start as here.
    await s.idOf(BEN)
    // Ana shares no channel with Dana: she is not offered, and cannot be added by id.
    const anaView = ok(await s.meet.channel(await s.as(ANA), other.conversationId))
    expect(anaView.addable.map((p) => p.address)).not.toContain(DANA)
    expect(refusal(await s.change(ANA, { do: 'add', conversationId: other.conversationId, personId: invited.person.id })).reason).toBe('not-found')
    // Ana is added to Dana's channel; now she shares one, and Tessa, in both, can add Dana to Ana's.
    ok(await s.change(OWNER, { do: 'add', conversationId: secret.conversationId, personId: await s.idOf(ANA) }))
    expect(ok(await s.meet.channel(await s.as(ANA), other.conversationId)).addable.map((p) => p.address)).toContain(DANA)
    // Every teammate is offered, to a teammate.
    expect(anaView.addable.map((p) => p.address)).toEqual(expect.arrayContaining([OWNER, BEN]))
  })

  test('a person removed from a channel stops seeing it, and a guest taken out of their last channel is out of the workspace', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops', 'private')
    const dana = ok(await s.invite(OWNER, ops.conversationId)).person
    ok(await s.change(OWNER, { do: 'add', conversationId: ops.conversationId, personId: await s.idOf(ANA) }))
    expect(ok(await s.meet.channel(await s.as(ANA), ops.conversationId)).members).toHaveLength(3)
    ok(await s.change(ANA, { do: 'leave', conversationId: ops.conversationId }))
    expect(refusal(await s.meet.channel(await s.as(ANA), ops.conversationId)).reason).toBe('not-found')
    // Taking the guest out of their only channel removes them from the workspace.
    const out = ok(await s.change(OWNER, { do: 'take-out', conversationId: ops.conversationId, personId: dana.id }))
    expect(out.channel?.members.map((m) => m.person.address)).toEqual([OWNER])
    expect((await s.a.tm(OWNER, 'GET', '/bootstrap')).json.people.map((p: { id: string }) => p.id)).not.toContain(dana.id)
  })
})

describe('Invite a guest: the one email, once, and only when a teammate presses it', () => {
  test('the guest is added to the channel and one invitation goes to their address, naming who invited, the channel, and the guest’s own door on meet’s address', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'client-dana')
    expect(s.h.mail).toEqual([])
    const done = ok(await s.invite(OWNER, ops.conversationId))
    expect(done).toMatchObject({ conversationId: ops.conversationId, mailed: true, person: { name: 'Dana Reyes', kind: 'guest', address: DANA } })
    expect(s.h.mail).toHaveLength(1)
    const mail = s.h.mail[0]
    expect(mail).toMatchObject({ to: DANA, from: { email: 'meet@northfield.example' }, subject: 'You were added to a channel on meet' })
    expect(mail?.text).toContain('Tessa')
    expect(mail?.text).toContain('"client-dana"')
    // The guest's own door is a path of the space's address that needs no sign-in; the trailing slash is the one the edge opens (`/w/*`).
    expect(mail?.text).toContain(`${s.deps.appOrigin.replace(/\/+$/, '')}/w/ `)
    expect(mail?.text).not.toContain('meet.northfield.example')
    const detail = ok(await s.meet.channel(await s.as(OWNER), ops.conversationId))
    expect(detail.members.find((m) => m.person.address === DANA)).toMatchObject({ invited: true, you: false, may: { takeOut: true, removeFromWorkspace: true, deleteEverything: true } })
  })

  test('a second press of the same key sends nothing and answers the first; a new key to the same guest sends it again', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    const k = s.key('inv')
    const ask = async () => s.meet.inviteGuest(await s.as(OWNER), { key: k, conversationId: ops.conversationId, name: 'Dana', address: DANA })
    const first = ok(await ask())
    const again = await ask()
    expect(again).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: { person: { id: first.person.id }, mailed: true } } } })
    expect(s.h.mail).toHaveLength(1)
    // A new press is a new key: the invitation is sent again, and the guest is still one person in the channel once.
    ok(await s.invite(OWNER, ops.conversationId))
    expect(s.h.mail).toHaveLength(2)
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).members.filter((m) => m.person.address === DANA)).toHaveLength(1)
  })

  test('a refused first use sends nothing and releases the key', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    const k = s.key('fix')
    const owner = await s.as(OWNER)
    expect(refusal(await s.meet.inviteGuest(owner, { key: k, conversationId: ops.conversationId, name: 'Dana', address: 'not an address' }))).toMatchObject({ reason: 'bad-request', message: 'That does not look like an email address.' })
    expect(refusal(await s.meet.inviteGuest(owner, { key: k, conversationId: ops.conversationId, name: '  ', address: DANA }))).toMatchObject({ reason: 'bad-request', message: 'Give the guest a name.' })
    expect(s.h.mail).toEqual([])
    expect(ok(await s.meet.inviteGuest(owner, { key: k, conversationId: ops.conversationId, name: 'Dana', address: DANA })).mailed).toBe(true)
    expect(s.h.mail).toHaveLength(1)
  })

  test('the address of a Northfield Works person is refused in meet’s words, and nothing is sent', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    expect(refusal(await s.invite(OWNER, ops.conversationId, BEN.toUpperCase(), 'Ben'))).toMatchObject({
      reason: 'conflict',
      message: 'That address belongs to a Northfield Works person. Add them to the channel instead.',
    })
    expect(s.h.mail).toEqual([])
  })

  test('an invitation that could not be sent leaves the guest in the channel and says so; inviting again sends it', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    s.h.mailFails.on = true
    const k = s.key('down')
    const owner = await s.as(OWNER)
    const failed = ok(await s.meet.inviteGuest(owner, { key: k, conversationId: ops.conversationId, name: 'Dana', address: DANA }))
    expect(failed.mailed).toBe(false)
    expect(ok(await s.meet.channel(owner, ops.conversationId)).members.map((m) => m.person.address)).toContain(DANA)
    // A repeat of that key does not send, and does not claim it was sent.
    s.h.mailFails.on = false
    const repeat = await s.meet.inviteGuest(owner, { key: k, conversationId: ops.conversationId, name: 'Dana', address: DANA })
    expect(repeat).toMatchObject({ reason: 'repeated', earlier: { reply: { value: { mailed: false } } } })
    expect(s.h.mail).toEqual([])
    ok(await s.invite(OWNER, ops.conversationId))
    expect(s.h.mail).toHaveLength(1)
  })

  test('the hour’s emails are counted as /start counts them: past the limit nothing is sent and the person is told', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    for (let i = 0; i < SENDS_PER_HOUR; i++) ok(await s.invite(OWNER, ops.conversationId, `guest${i}@example.test`, `Guest ${i}`))
    expect(s.h.mail).toHaveLength(SENDS_PER_HOUR)
    expect(refusal(await s.invite(OWNER, ops.conversationId, 'one-more@example.test', 'One more'))).toMatchObject({
      reason: 'limit',
      message: 'meet has sent as many emails as it may this hour. Try again later.',
    })
    expect(s.h.mail).toHaveLength(SENDS_PER_HOUR)
  })

  test('only a teammate in the channel invites: not a teammate outside it, not into a direct message', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    expect(refusal(await s.invite(ANA, ops.conversationId)).reason).toBe('not-found')
    expect(refusal(await s.invite(OWNER, 424_242)).reason).toBe('not-found')
    expect(s.h.mail).toEqual([])
  })

  test('the guest’s own door is meet’s: the invited address signs in at /w with an emailed code, sees only that channel, and the space never serves them', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'client-dana')
    const hidden = await s.make(OWNER, 'internal')
    ok(await s.invite(OWNER, ops.conversationId))
    s.h.mail.length = 0
    const token = await s.a.signIn(DANA)
    const boot = await s.a.gu(token, 'GET', '/bootstrap')
    expect(boot.status).toBe(200)
    expect(boot.json.me).toMatchObject({ kind: 'guest', email: DANA })
    expect(boot.json.conversations.map((c: { name: string }) => c.name)).toEqual(['client-dana'])
    expect(JSON.stringify(boot.json)).not.toContain(String(hidden.conversationId) + ',"name":"internal"')
    // The guest’s session is no way into anything of the space’s, and the space's methods are not theirs.
    expect((await s.h.call('GET', 'https://meet.northfield.example/start/api/w/bootstrap', undefined, { headers: { cookie: `meet_guest=${token}` } })).status).toBe(404)
    expect(await s.meet.conversations(await s.as(DANA))).toMatchObject({ ok: false, reason: 'not-admitted' })
    // A guest cannot make a channel or invite at the guests’ door either.
    expect((await s.a.gu(token, 'POST', '/channels', { name: 'mine', privacy: 'open' })).status).toBe(403)
    void G
  })
})

describe('who may archive, and what archiving does', () => {
  test('the person who made a channel archives it; another member is refused in meet’s words; the owner archives a channel he is in (and not one he is not: see "what is never shown")', async () => {
    const s = await setup()
    const ops = await s.make(ANA, 'ops', 'open')
    ok(await s.change(BEN, { do: 'join', conversationId: ops.conversationId }))
    ok(await s.change(OWNER, { do: 'join', conversationId: ops.conversationId }))
    // What each may do is meet's answer.
    expect(ok(await s.meet.channel(await s.as(ANA), ops.conversationId)).may.archive).toBe(true)
    expect(ok(await s.meet.channel(await s.as(BEN), ops.conversationId)).may.archive).toBe(false)
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).may.archive).toBe(true)
    // And the rule holds if asked anyway.
    expect(refusal(await s.change(BEN, { do: 'archive', conversationId: ops.conversationId }))).toMatchObject({
      reason: 'not-admitted',
      message: 'Only the person who made a channel, or Tessa, can archive it.',
    })
    expect(ok(await s.meet.channel(await s.as(ANA), ops.conversationId)).name).toBe('ops')

    const done = ok(await s.change(OWNER, { do: 'archive', conversationId: ops.conversationId }))
    expect(done).toEqual({ conversationId: ops.conversationId, channel: null })
    for (const who of [ANA, BEN, OWNER]) {
      expect(ok(await s.meet.conversations(await s.as(who))).channels).toEqual([])
      expect(refusal(await s.meet.channel(await s.as(who), ops.conversationId)).reason).toBe('not-found')
    }
    expect(ok(await s.meet.browseChannels(await s.as(BEN)))).toEqual([])
    // An archived channel takes no more messages, and its name is free.
    expect(refusal(await s.meet.post(await s.as(ANA), { key: s.key('p'), target: { conversationId: ops.conversationId }, text: 'hello' })).reason).toBe('not-found')
    expect(ok(await s.meet.createChannel(await s.as(BEN), { key: s.key('again'), name: 'ops', privacy: 'open' })).name).toBe('ops')
  })

  test('archiving removes a guest whose last channel it was, and leaves the guest of another channel in that one', async () => {
    const s = await setup()
    const one = await s.make(OWNER, 'one')
    const two = await s.make(OWNER, 'two')
    const only = ok(await s.invite(OWNER, one.conversationId, 'only@example.test', 'Only One')).person
    const both = ok(await s.invite(OWNER, one.conversationId, 'both@example.test', 'Both')).person
    ok(await s.invite(OWNER, two.conversationId, 'both@example.test', 'Both'))
    ok(await s.change(OWNER, { do: 'archive', conversationId: one.conversationId }))
    const ids = (await s.a.tm(OWNER, 'GET', '/bootstrap')).json.people.map((p: { id: string }) => p.id)
    expect(ids).not.toContain(only.id)
    expect(ids).toContain(both.id)
    expect(ok(await s.meet.channel(await s.as(OWNER), two.conversationId)).members.map((m) => m.person.address)).toContain('both@example.test')
  })
})

describe('the channel’s people and a guest’s access', () => {
  test('rename, leave, join and add are every teammate’s in the channel, in meet’s words', async () => {
    const s = await setup()
    const ops = await s.make(ANA, 'ops', 'open')
    await s.make(ANA, 'taken', 'open')
    expect(refusal(await s.change(ANA, { do: 'rename', conversationId: ops.conversationId, name: 'TAKEN' }))).toMatchObject({ reason: 'conflict', message: 'There is already a channel with that name.' })
    expect(refusal(await s.change(ANA, { do: 'rename', conversationId: ops.conversationId, name: ' ' }))).toMatchObject({ reason: 'bad-request', message: 'Give the channel a name.' })
    expect(ok(await s.change(ANA, { do: 'rename', conversationId: ops.conversationId, name: '#operations' })).channel?.name).toBe('operations')
    // Join an open channel; add a teammate; leave.
    const joined = ok(await s.change(BEN, { do: 'join', conversationId: ops.conversationId }))
    // (People who joined in the same millisecond are listed in the order of their ids, so the order is not asserted.)
    expect(joined.channel?.members.map((m) => m.person.address).sort()).toEqual([ANA, BEN])
    expect(ok(await s.change(BEN, { do: 'add', conversationId: ops.conversationId, personId: await s.idOf(OWNER) })).channel?.members).toHaveLength(3)
    expect(ok(await s.change(BEN, { do: 'leave', conversationId: ops.conversationId }))).toEqual({ conversationId: ops.conversationId, channel: null })
    // A direct message is not a channel: nothing here reads or changes it.
    const dm = (await s.a.tm(ANA, 'POST', '/dms', { person: await s.idOf(OWNER) })).json.conversation.id
    expect(refusal(await s.meet.channel(await s.as(ANA), dm)).reason).toBe('not-found')
    expect(refusal(await s.change(ANA, { do: 'rename', conversationId: dm, name: 'x' })).reason).toBe('bad-request')
  })

  test('take out: a teammate takes a guest out, never another teammate; the buttons are only where meet’s rules allow', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    ok(await s.change(OWNER, { do: 'add', conversationId: ops.conversationId, personId: await s.idOf(ANA) }))
    const dana = ok(await s.invite(OWNER, ops.conversationId)).person
    const ana = ok(await s.meet.channel(await s.as(ANA), ops.conversationId))
    // Ana did not invite Dana, so she may take her out of this channel but not remove her from the workspace; she is not the owner.
    expect(ana.members.find((m) => m.person.id === dana.id)?.may).toEqual({ takeOut: true, removeFromWorkspace: false, deleteEverything: false })
    expect(ana.members.find((m) => m.person.address === OWNER)?.may).toEqual({ takeOut: false, removeFromWorkspace: false, deleteEverything: false })
    expect(refusal(await s.change(ANA, { do: 'take-out', conversationId: ops.conversationId, personId: await s.idOf(OWNER) }))).toMatchObject({ reason: 'not-admitted', message: 'A teammate leaves a channel on their own.' })
    expect(refusal(await s.change(ANA, { do: 'remove-guest', conversationId: ops.conversationId, personId: dana.id }))).toMatchObject({ reason: 'not-admitted', message: 'You can remove only a guest you invited.' })
    expect(refusal(await s.change(ANA, { do: 'delete-person', conversationId: ops.conversationId, personId: dana.id }))).toMatchObject({ reason: 'not-admitted', message: 'Only Tessa can delete a person.' })
    // The owner’s view: every button for a guest, and delete for a teammate too.
    const owner = ok(await s.meet.channel(await s.as(OWNER), ops.conversationId))
    expect(owner.members.find((m) => m.person.id === dana.id)?.may).toEqual({ takeOut: true, removeFromWorkspace: true, deleteEverything: true })
    expect(owner.members.find((m) => m.person.address === ANA)?.may).toEqual({ takeOut: false, removeFromWorkspace: false, deleteEverything: true })
    expect(owner.members.find((m) => m.you)?.may).toEqual({ takeOut: false, removeFromWorkspace: false, deleteEverything: false })
  })

  test('the inviter removes their own guest from the workspace; the owner removes any; the guest is signed out and sees nothing more', async () => {
    const s = await setup()
    const ops = await s.make(ANA, 'ops')
    const dana = ok(await s.invite(ANA, ops.conversationId)).person
    const token = await s.a.signIn(DANA)
    expect((await s.a.gu(token, 'GET', '/bootstrap')).status).toBe(200)
    expect(ok(await s.meet.channel(await s.as(ANA), ops.conversationId)).members.find((m) => m.person.id === dana.id)?.may.removeFromWorkspace).toBe(true)
    const done = ok(await s.change(ANA, { do: 'remove-guest', conversationId: ops.conversationId, personId: dana.id }))
    expect(done.channel?.members.map((m) => m.person.address)).toEqual([ANA])
    expect((await s.a.gu(token, 'GET', '/bootstrap')).status).toBe(401)
    // A second removal finds nobody.
    expect(refusal(await s.change(ANA, { do: 'remove-guest', conversationId: ops.conversationId, personId: dana.id })).reason).toBe('not-found')
  })

  test('remove and delete are asked in a channel the person is in with the guest: a guest in none of the asker’s channels is not found, even by the owner', async () => {
    const s = await setup()
    const theirs = await s.make(ANA, 'theirs')
    const mine = await s.make(OWNER, 'mine')
    const dana = ok(await s.invite(ANA, theirs.conversationId)).person
    for (const op of ['remove-guest', 'delete-person'] as const) {
      expect([op, refusal(await s.change(OWNER, { do: op, conversationId: mine.conversationId, personId: dana.id })).reason]).toEqual([op, 'not-found'])
    }
    // Still there.
    expect(ok(await s.meet.channel(await s.as(ANA), theirs.conversationId)).members.map((m) => m.person.address)).toContain(DANA)
  })

  test('delete everything is the owner’s alone: the person and what they wrote are gone', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    const dana = ok(await s.invite(OWNER, ops.conversationId)).person
    const token = await s.a.signIn(DANA)
    const said = await s.a.gu(token, 'POST', `/conversations/${ops.conversationId}/messages`, { text: 'please delete me' })
    expect(said.status).toBe(201)
    const done = ok(await s.change(OWNER, { do: 'delete-person', conversationId: ops.conversationId, personId: dana.id }))
    expect(done.channel?.members.map((m) => m.person.address)).toEqual([OWNER])
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE text = 'please delete me'`)[0]?.n).toBe(0)
  })

  test('a change whose outcome the Worker cannot know is thrown, never answered `broken`: a committed delete or archive is not reported as not done', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    const dana = ok(await s.invite(OWNER, ops.conversationId)).person
    // The object commits, then the hop back fails (a reset during a deploy, a transport error).
    const real = s.deps.workspace()
    const flaky = () => ({
      ...real,
      spaceChange: async (...args: Parameters<typeof real.spaceChange>) => {
        await real.spaceChange(...args)
        throw new Error('the object was reset')
      },
    })
    const m = spaceMeet({ ...s.deps, workspace: flaky as never })
    await expect(m.changeChannel(await s.as(OWNER), { do: 'delete-person', conversationId: ops.conversationId, personId: dana.id })).rejects.toThrow('the object was reset')
    // It was done: the guest is gone.
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).members.map((p) => p.person.address)).toEqual([OWNER])
    // A refusal of meet's own is still a refusal, never thrown.
    expect(refusal(await m.changeChannel(await s.as(BEN), { do: 'archive', conversationId: ops.conversationId }))).toMatchObject({ reason: 'not-found' })
  })

  test('Message is offered only where a direct message with something in it exists', async () => {
    const s = await setup()
    const ops = await s.make(OWNER, 'ops')
    ok(await s.change(OWNER, { do: 'add', conversationId: ops.conversationId, personId: await s.idOf(ANA) }))
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).members.find((m) => m.person.address === ANA)?.direct).toBe(false)
    const dm = (await s.a.tm(OWNER, 'POST', '/dms', { person: await s.idOf(ANA) })).json.conversation.id
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).members.find((m) => m.person.address === ANA)?.direct).toBe(false)
    expect((await s.a.tm(OWNER, 'POST', `/conversations/${dm}/messages`, { text: 'hi' })).status).toBe(201)
    expect(ok(await s.meet.channel(await s.as(OWNER), ops.conversationId)).members.find((m) => m.person.address === ANA)?.direct).toBe(true)
  })
})
