// What meet answers the space: spaceMeet's methods (src/space-meet.ts) over the real Workspace core, with a signed
// assertion for the SPACE application as the one argument that says who is asking. The seam is the method, as the space calls
// it over a service binding: what comes back for a person (and what never does), what is refused, and what a repeat does.
// The socket and the phone are test/space-part.test.ts and the call links test/call-links.test.ts.
import { describe, expect, test } from 'bun:test'
import {
  type SignedIn,
  type Install,
  createInstall,
  COMPOSE_KEY_KEPT_MS,
  MEET_FOR_SPACE_METHODS,
  type MeetMessage,
  type MeetOverview,
  NOT_ADMITTED,
  SNIPPET_CHARS,
  type SpaceReply,
  normalizeAddress,
} from '@space/workspace'
import { LIVE_CALLS_SCANNED, type SpaceMeetDeps, snippet, spaceMeet } from '../src/space-meet'
import { CHAT_MAX, CHAT_RATE, MEMBER_TIMEOUT_MS } from '../src/model'
import { TICKET_TTL_MS } from '../src/workspace-model'
import lane from '../../workspace/test/fixtures/pinecrest.json'
import { ANA, BEN, OWNER, T0, harness, signedAs } from './helpers'
import { W, actors } from './workspace.helpers'

const STRANGER = 'eve@elsewhere.test'

async function setup(opts: { workspace?: SpaceMeetDeps['workspace']; install?: Install } = {}) {
  const h = await harness({ devBypass: false, ...(opts.install ? { install: opts.install } : {}) })
  const a = actors(h)
  const deps: SpaceMeetDeps = {
    install: h.deps.install,
    workspace: opts.workspace ?? h.deps.workspace,
    room: h.deps.room,
    ledger: h.deps.ledger,
    appOrigin: h.deps.appOrigin,
    mailer: h.deps.mailer,
    now: () => h.clock.now,
    randomBytes: h.deps.randomBytes,
  }
  const meet = spaceMeet(deps)
  /** The person the space's one check would name, as the part is handed them: good for an hour unless `exp` (seconds) says otherwise. */
  const as = async (email: string, exp = Math.floor(h.clock.now / 1000) + 3600): Promise<SignedIn> => signedAs(h.deps.install, email, exp)
  const idOf = async (email: string): Promise<string> => (await a.tm(email, 'GET', '/bootstrap')).json.me.id
  const channel = async (by: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<number> => {
    const r = await a.tm(by, 'POST', '/channels', { name, privacy })
    expect(r.status).toBe(201)
    return r.json.conversation.id
  }
  const add = async (by: string, conv: number, person: string) => expect((await a.tm(by, 'POST', `/channels/${conv}/members`, { person: await idOf(person) })).status).toBe(200)
  const dm = async (by: string, withEmail: string): Promise<number> => {
    const r = await a.tm(by, 'POST', '/dms', { person: await idOf(withEmail) })
    expect(r.status).toBe(201)
    return r.json.conversation.id
  }
  const say = async (by: string, conv: number, text: string) => {
    const r = await a.tm(by, 'POST', `/conversations/${conv}/messages`, { text })
    expect(r.status).toBe(201)
    return r.json.message.id as number
  }
  const count = (q: string) => (h.workspaceSql.all<{ n: number }>(q)[0] as { n: number }).n
  return { h, a, meet, deps, as, idOf, channel, add, dm, say, count }
}

type S = Awaited<ReturnType<typeof setup>>

function ok<T>(r: SpaceReply<T> | { ok: boolean }): T {
  expect(r).toMatchObject({ ok: true })
  return (r as { value: T }).value
}

/** A compose key: 16 to 128 of letters, digits, `_` and `-`. */
const key = (n: string) => `compose-${n}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(24, 'x')

describe('who is asking: the part is handed the person the space’s one check named, and keeps the one rule that is its own', () => {
  const calls = (m: ReturnType<typeof spaceMeet>, who: SignedIn) => ({
    conversations: () => m.conversations(who),
    history: () => m.history(who, 1),
    post: () => m.post(who, { key: key('a'), target: { conversationId: 1 }, text: 'hi' }),
    markRead: () => m.markRead(who, 1, 1),
    liveCalls: () => m.liveCalls(who),
  })

  test('the methods are exactly the contract’s', async () => {
    const { meet } = await setup()
    expect(Object.keys(meet).sort()).toEqual([...MEET_FOR_SPACE_METHODS].sort())
  })

  test('there is no assertion, audience or key fetch in the part: its dependencies are the stores, the sender, the clock and randomness', async () => {
    const { deps } = await setup()
    expect(Object.keys(deps).sort()).toEqual(['appOrigin', 'install', 'ledger', 'mailer', 'now', 'randomBytes', 'room', 'workspace'])
  })

  test('a person who is not of this install is not-admitted at every method, in meet’s own words, and meet’s store is not asked', async () => {
    const s = await setup()
    const before = s.h.workspaceCalls.n
    for (const [method, call] of Object.entries(calls(s.meet, await s.as(STRANGER)))) {
      expect([method, await call()]).toEqual([method, { ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED }])
    }
    expect(s.h.workspaceCalls.n).toBe(before)
  })

  test('a person on the list is asked as themselves: the answer is theirs and nobody else’s', async () => {
    const s = await setup()
    const ch = await s.channel(OWNER, 'ops')
    await s.say(OWNER, ch, 'for the ops channel')
    const tessa = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(tessa.me).toMatchObject({ name: 'Tessa', kind: 'teammate', address: OWNER })
    expect(tessa.channels.map((c) => c.name)).toEqual(['ops'])
    const ana = ok(await s.meet.conversations(await s.as(ANA)))
    expect(ana.me.address).toBe(ANA)
    expect(ana.channels).toEqual([])
  })
})

describe('what meet shows a person: the direct messages they are in and the channels they belong to, nothing else', () => {
  async function scene() {
    const s = await setup()
    const { channel, add, dm, say } = s
    // Tessa and Ana share a private channel, and a direct message.
    const ops = await channel(OWNER, 'ops')
    await add(OWNER, ops, ANA)
    const tessaAna = await dm(OWNER, ANA)
    await say(OWNER, tessaAna, 'Tessa to Ana: lunch?')
    await say(ANA, tessaAna, 'Ana to Tessa: yes')
    await say(OWNER, ops, 'ops says hello')
    // Ben and Ana have a private channel and a direct message Tessa is not in.
    const secret = await channel(BEN, 'ben-ana-private')
    await add(BEN, secret, ANA)
    await say(BEN, secret, 'TOKEN-PRIVATE-CHANNEL')
    const anaBen = await dm(ANA, BEN)
    await say(ANA, anaBen, 'TOKEN-ANA-BEN-DM')
    // Ben made an open channel Tessa has not joined: he can see it exists in meet, but reading it means joining.
    const lounge = await channel(BEN, 'lounge', 'open')
    await say(BEN, lounge, 'TOKEN-OPEN-NOT-JOINED')
    // An archived channel Tessa was in.
    const old = await channel(OWNER, 'old-news')
    await say(OWNER, old, 'TOKEN-ARCHIVED')
    expect((await s.a.tm(OWNER, 'POST', `/channels/${old}/archive`)).status).toBe(200)
    // A guest in ops.
    const invited = await s.a.tm(OWNER, 'POST', `/channels/${ops}/invite`, { email: 'gus@client.test', name: 'Gus' })
    expect(invited.status).toBe(201)
    const gus = await s.a.signIn('gus@client.test')
    const said = await s.a.gu(gus, 'POST', `/conversations/${ops}/messages`, { text: 'Gus here' })
    expect(said.status).toBe(201)
    const phone = (s.h.workspaceSql.all<{ id: number }>(`SELECT id FROM conversations WHERE kind = 'phone'`)[0] as { id: number }).id
    return { ...s, ops, tessaAna, secret, anaBen, lounge, old, phone, gusToken: gus }
  }

  test('Tessa’s overview holds his one direct message and his one channel, and not one word of the others', async () => {
    const s = await scene()
    const r = await s.meet.conversations(await s.as(OWNER))
    const o = ok(r) as MeetOverview
    expect(o.direct.map((d) => d.person.address)).toEqual([ANA])
    expect(o.direct[0]).toMatchObject({ conversationId: s.tessaAna, unread: 1, person: { name: 'Ana', kind: 'teammate' } })
    expect(o.channels.map((c) => c.name)).toEqual(['ops'])
    expect(o.channels[0]).toMatchObject({ conversationId: s.ops, privacy: 'private', memberCount: 3 })
    const all = JSON.stringify(r)
    for (const never of ['TOKEN-PRIVATE-CHANNEL', 'TOKEN-ANA-BEN-DM', 'TOKEN-OPEN-NOT-JOINED', 'TOKEN-ARCHIVED', 'ben-ana-private', 'lounge', 'old-news', 'Phone']) {
      expect([never, all.includes(never)]).toEqual([never, false])
    }
  })

  test('the newest message, who wrote it, whether it is the asker’s, and the unread count', async () => {
    const s = await scene()
    const o = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(o.direct[0]?.newest).toMatchObject({ text: 'Ana to Tessa: yes', authorName: 'Ana', mine: false })
    expect(o.channels[0]?.newest).toMatchObject({ text: 'Gus here', authorName: 'Gus', mine: false })
    const ana = ok(await s.meet.conversations(await s.as(ANA)))
    expect(ana.direct.find((d) => d.person.address === OWNER)?.newest).toMatchObject({ text: 'Ana to Tessa: yes', mine: true })
    expect(ana.direct.find((d) => d.person.address === OWNER)?.unread).toBe(0)
  })

  test('Ana sees both of her direct messages and both channels; Ben sees what is his, including the open channel he made', async () => {
    const s = await scene()
    const ana = ok(await s.meet.conversations(await s.as(ANA)))
    expect(ana.direct.map((d) => d.person.address).sort()).toEqual([BEN, OWNER].sort())
    expect(ana.channels.map((c) => c.name).sort()).toEqual(['ben-ana-private', 'ops'])
    const ben = ok(await s.meet.conversations(await s.as(BEN)))
    expect(ben.direct.map((d) => d.person.address)).toEqual([ANA])
    expect(ben.channels.map((c) => c.name).sort()).toEqual(['ben-ana-private', 'lounge'])
    expect(JSON.stringify(ben)).not.toContain('Gus here')
  })

  test('a conversation the person is not in, an archived one and the Phone conversation are not found, for history, post and mark read alike', async () => {
    const s = await scene()
    const tessa = await s.as(OWNER)
    for (const [what, id] of Object.entries({ 'another pair’s direct message': s.anaBen, 'a private channel': s.secret, 'an open channel not joined': s.lounge, 'an archived channel': s.old, 'the Phone conversation': s.phone, 'one that does not exist': 99999 })) {
      expect([what, await s.meet.history(tessa, id)]).toMatchObject([what, { ok: false, kind: 'refused', reason: 'not-found' }])
      expect([what, await s.meet.markRead(tessa, id, 1)]).toMatchObject([what, { ok: false, kind: 'refused', reason: 'not-found' }])
      expect([what, await s.meet.post(tessa, { key: key(what), target: { conversationId: id }, text: 'let me in' })]).toMatchObject([what, { ok: false, kind: 'refused', reason: 'not-found' }])
    }
    // Nothing was written to any of them.
    expect(s.count(`SELECT COUNT(*) AS n FROM messages WHERE text = 'let me in'`)).toBe(0)
  })

  test('not-found does not tell a conversation that is not theirs from one that is not there', async () => {
    const s = await scene()
    const tessa = await s.as(OWNER)
    const hidden = await s.meet.history(tessa, s.anaBen)
    const missing = await s.meet.history(tessa, 424242)
    expect(hidden).toEqual(missing)
  })

  test('an id that is not a whole number is a bad request, not a crash', async () => {
    const s = await scene()
    const tessa = await s.as(OWNER)
    for (const id of [1.5, Number.NaN, '3', null, {}]) {
      expect([id, await s.meet.history(tessa, id as never)]).toMatchObject([id, { ok: false, reason: 'bad-request' }])
      expect([id, await s.meet.markRead(tessa, id as never, 1)]).toMatchObject([id, { ok: false, reason: 'bad-request' }])
    }
    expect(await s.meet.history(tessa, s.ops, -3)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await s.meet.history(tessa, s.ops, 1.5)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('a channel guest cannot be the one asking: they sign in at meet’s own door, and the space has no door for them', async () => {
    const s = await scene()
    const m = await s.meet.conversations(await s.as('gus@client.test'))
    expect(m).toMatchObject({ ok: false, reason: 'not-admitted' })
  })

  test('a direct message whose other person was removed has no row; the channel is still there', async () => {
    const s = await scene()
    const people = (await s.a.tm(OWNER, 'GET', '/bootstrap')).json.people as Array<{ id: string; name: string }>
    const gus = people.find((p) => p.name === 'Gus')
    expect(gus).toBeTruthy()
    const opened = await s.meet.post(await s.as(OWNER), { key: key('gus-dm'), target: { personId: (gus as { id: string }).id }, text: 'welcome' })
    expect(opened).toMatchObject({ ok: true })
    expect(ok(await s.meet.conversations(await s.as(OWNER))).direct.map((d) => d.person.name).sort()).toEqual(['Ana', 'Gus'])
    expect((await s.a.tm(OWNER, 'POST', `/people/${(gus as { id: string }).id}/remove`)).status).toBe(200)
    const after = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(after.direct.map((d) => d.person.name)).toEqual(['Ana'])
    expect(after.channels.map((c) => c.name)).toEqual(['ops'])
  })
})

describe('history and mark read', () => {
  test('history is oldest first in pages of fifty, with the full words and which are the asker’s', async () => {
    const s = await setup()
    const ch = await s.channel(OWNER, 'ops')
    await s.add(OWNER, ch, ANA)
    const long = `${'long words '.repeat(60)}end`
    const ids: number[] = []
    for (let i = 0; i < 55; i++) {
      s.h.clock.now += 11_000 // six messages in ten seconds would be refused; the space is not the thing under test here
      ids.push(await s.say(i % 2 === 0 ? OWNER : ANA, ch, i === 54 ? long : `m${i}`))
    }
    const tessa = await s.as(OWNER, Math.floor(s.h.clock.now / 1000) + 3600)
    const page1 = ok(await s.meet.history(tessa, ch))
    expect(page1.messages.length).toBe(50)
    expect(page1.more).toBe(true)
    expect(page1.messages.map((m) => m.id)).toEqual(ids.slice(5))
    const last = page1.messages.at(-1) as MeetMessage
    expect(last).toMatchObject({ text: long, conversationId: ch, authorName: 'Tessa', mine: true, editedAt: null })
    expect(last.text.length).toBeGreaterThan(SNIPPET_CHARS)
    expect(page1.messages.find((m) => m.text === 'm53')).toMatchObject({ mine: false, authorName: 'Ana' })
    const page2 = ok(await s.meet.history(tessa, ch, page1.messages[0]?.id))
    expect(page2.messages.map((m) => m.id)).toEqual(ids.slice(0, 5))
    expect(page2.more).toBe(false)
  })

  test('mark read moves the position on every device, answers where it is, never moves back and stops at the newest message', async () => {
    const s = await setup()
    const dm = await s.dm(ANA, OWNER)
    const first = await s.say(ANA, dm, 'one')
    const second = await s.say(ANA, dm, 'two')
    const tessa = await s.as(OWNER)
    expect(ok(await s.meet.conversations(tessa)).direct[0]?.unread).toBe(2)
    const delivered = s.h.delivered.length
    expect(ok(await s.meet.markRead(tessa, dm, first))).toEqual({ conversationId: dm, upTo: first })
    expect(ok(await s.meet.conversations(tessa)).direct[0]?.unread).toBe(1)
    // The person's other devices hear it (their sockets get a read change).
    expect(s.h.delivered.slice(delivered).some((d) => d.change.kind === 'read')).toBe(true)
    // Idempotent, and an older position does not move it back.
    expect(ok(await s.meet.markRead(tessa, dm, first))).toEqual({ conversationId: dm, upTo: first })
    expect(ok(await s.meet.markRead(tessa, dm, 0))).toEqual({ conversationId: dm, upTo: first })
    expect(ok(await s.meet.markRead(tessa, dm, second + 1000))).toEqual({ conversationId: dm, upTo: second })
    expect(ok(await s.meet.conversations(tessa)).direct[0]?.unread).toBe(0)
    expect(await s.meet.markRead(tessa, dm, -1)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await s.meet.markRead(tessa, dm, 1.5)).toMatchObject({ ok: false, reason: 'bad-request' })
  })
})

describe('the snippet and the addresses', () => {
  test('the newest message is one line cut to the contract’s SNIPPET_CHARS, and the history keeps every word', async () => {
    expect(snippet('x'.repeat(5000)).length).toBe(SNIPPET_CHARS)
    expect(snippet('x'.repeat(SNIPPET_CHARS)).length).toBe(SNIPPET_CHARS)
    expect(snippet('x'.repeat(SNIPPET_CHARS - 1))).toBe('x'.repeat(SNIPPET_CHARS - 1))
    expect(snippet('  two\n\n lines\tand   gaps  ')).toBe('two lines and gaps')
    // Never in the middle of a pair of code units.
    const pairs = snippet('😀'.repeat(400))
    expect(pairs.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(pairs).toMatch(/^(?:😀)+…$/u)

    const s = await setup()
    const dm = await s.dm(ANA, OWNER)
    const text = `first line\n${'word '.repeat(300)}`
    await s.say(ANA, dm, text)
    const tessa = await s.as(OWNER)
    const newest = ok(await s.meet.conversations(tessa)).direct[0]?.newest
    expect(newest?.text.length).toBe(SNIPPET_CHARS)
    expect(newest?.text.includes('\n')).toBe(false)
    expect(newest?.text.endsWith('…')).toBe(true)
    expect(ok(await s.meet.history(tessa, dm)).messages[0]?.text).toBe(text.trim())
  })

  test('every address in an answer went through normalizeAddress: a person stored as “Ana Lane <ANA@Northfield.example>” is ana@northfield.example, and a deleted person’s has none', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    await s.say(ANA, dm, 'hi')
    const ch = await s.channel(OWNER, 'ops')
    expect((await s.a.tm(OWNER, 'POST', `/channels/${ch}/invite`, { email: 'gus@client.test', name: 'Gus' })).status).toBe(201)
    await s.a.signIn('gus@client.test')
    const gus = ((await s.a.tm(OWNER, 'GET', '/bootstrap')).json.people as Array<{ id: string; name: string }>).find((p) => p.name === 'Gus') as { id: string }
    const withGus = await s.meet.post(await s.as(OWNER), { key: key('gus'), target: { personId: gus.id }, text: 'welcome' })
    expect(withGus).toMatchObject({ ok: true })
    // Stored in odd spellings, as no door would write them.
    s.h.workspaceSql.run(`UPDATE people SET email = ? WHERE email = ?`, 'Ana Lane <ANA@Northfield.example>', ANA)
    s.h.workspaceSql.run(`UPDATE people SET email = ? WHERE email = ?`, '  Gus@Client.TEST ', 'gus@client.test')
    const o = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(o.direct.map((d) => d.person.address).sort()).toEqual(['ana@northfield.example', 'gus@client.test'])
    for (const d of o.direct) expect(d.person.address).toBe(normalizeAddress(d.person.address))
    expect(o.me.address).toBe(OWNER)
    // A person deleted on request keeps no address at all.
    s.h.workspaceSql.run(`UPDATE people SET email = 'deleted-1@invalid' WHERE email LIKE '%Gus@Client%'`)
    const gone = ok(await s.meet.conversations(await s.as(OWNER)))
    expect(gone.direct.find((d) => d.person.name === 'Gus')?.person.address).toBeNull()
  })

  test('the answer builds every address through normalizeAddress, nowhere else (the source pins it)', async () => {
    const src = await Bun.file(new URL('../src/space-meet.ts', import.meta.url)).text()
    const mentions = src.split('\n').filter((l) => /\bemail\b|address/i.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    // The places an answer takes an address from meet's store are `toPerson` and a meeting's invitees (`toCall`).
    expect(src.match(/normalizeAddress\(/g)?.length).toBe(2)
    expect(src.match(/normalizeAddress\(i\.address\)/g)?.length).toBe(1)
    expect(mentions.some((l) => /address: normalizeAddress\(p\.email\)/.test(l))).toBe(true)
    expect(src.match(/\.email\b/g)?.length).toBe(1)
  })
})

describe('post: meet’s own rules, and a compose key so it goes out at most once', () => {
  test('a post lands in the conversation, is delivered live to the others, and is the asker’s', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const delivered = s.h.delivered.length
    const r = ok(await s.meet.post(await s.as(OWNER), { key: key('one'), target: { conversationId: dm }, text: '  hello there  ' }))
    expect(r).toMatchObject({ conversationId: dm, message: { text: 'hello there', mine: true, authorName: 'Tessa', editedAt: null } })
    const sent = s.h.delivered.slice(delivered).find((d) => d.change.kind === 'message')
    expect(sent?.people.length).toBe(2)
    expect(ok(await s.meet.history(await s.as(ANA), dm)).messages.map((m) => m.text)).toEqual(['hello there'])
  })

  test('meet’s limits refuse: empty, too long, six in ten seconds', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    expect(await s.meet.post(tessa, { key: key('e1'), target: { conversationId: dm }, text: '   ' })).toMatchObject({ ok: false, reason: 'bad-request', message: 'Write something first.' })
    expect(await s.meet.post(tessa, { key: key('e2'), target: { conversationId: dm }, text: 'x'.repeat(CHAT_MAX + 1) })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(ok(await s.meet.post(tessa, { key: key('e3'), target: { conversationId: dm }, text: 'x'.repeat(CHAT_MAX) })).message.text.length).toBe(CHAT_MAX)
    for (let i = 1; i < CHAT_RATE.max; i++) ok(await s.meet.post(tessa, { key: key(`r${i}`), target: { conversationId: dm }, text: `m${i}` }))
    expect(await s.meet.post(tessa, { key: key('r-over'), target: { conversationId: dm }, text: 'one too many' })).toMatchObject({ ok: false, kind: 'refused', reason: 'limit' })
  })

  test('a bad key, or no target, is a bad request', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    for (const bad of ['', 'short', 'has spaces in it 1234567890', 'x'.repeat(129), 'ünïcode-key-1234567890', undefined, 7]) {
      expect([bad, await s.meet.post(tessa, { key: bad as never, target: { conversationId: dm }, text: 'hi' })]).toMatchObject([bad, { ok: false, reason: 'bad-request' }])
    }
    for (const target of [undefined, null, {}, { personId: 5 }, 'x']) {
      expect([target, await s.meet.post(tessa, { key: key('t'), target: target as never, text: 'hi' })]).toMatchObject([target, { ok: false, reason: 'bad-request' }])
    }
    expect(await s.meet.post(tessa, undefined as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(s.count(`SELECT COUNT(*) AS n FROM messages`)).toBe(0)
  })

  test('a held key answers Repeated and posts nothing new: the same key, even with other words or another target', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const ch = await s.channel(OWNER, 'ops')
    const tessa = await s.as(OWNER)
    const first = ok(await s.meet.post(tessa, { key: key('held'), target: { conversationId: dm }, text: 'once' }))
    const again = await s.meet.post(tessa, { key: key('held'), target: { conversationId: dm }, text: 'once' })
    expect(again).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: first } } })
    const other = await s.meet.post(tessa, { key: key('held'), target: { conversationId: ch }, text: 'different words' })
    expect(other).toMatchObject({ ok: false, reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: first } } })
    expect(s.count(`SELECT COUNT(*) AS n FROM messages`)).toBe(1)
    // Held also against the rate limit: a repeat is answered as one even when a new post would be refused.
    for (let i = 0; i < CHAT_RATE.max; i++) await s.meet.post(tessa, { key: key(`fill${i}`), target: { conversationId: dm }, text: `f${i}` })
    expect(await s.meet.post(tessa, { key: key('held'), target: { conversationId: dm }, text: 'once' })).toMatchObject({ reason: 'repeated' })
  })

  test('a repeat to a person opens no second direct message and posts nothing twice', async () => {
    const s = await setup()
    const ben = await s.idOf(BEN)
    const tessa = await s.as(OWNER)
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(0)
    const first = ok(await s.meet.post(tessa, { key: key('person'), target: { personId: ben }, text: 'first words' }))
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(1)
    const again = await s.meet.post(tessa, { key: key('person'), target: { personId: ben }, text: 'first words' })
    expect(again).toMatchObject({ ok: false, reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: first } } })
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(1)
    expect(s.count(`SELECT COUNT(*) AS n FROM messages`)).toBe(1)
    // The next compose (a new key) goes to the same direct message.
    const next = ok(await s.meet.post(tessa, { key: key('person-2'), target: { personId: ben }, text: 'second' }))
    expect(next.conversationId).toBe(first.conversationId)
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(1)
  })

  test('a first use that was refused RELEASES the key: the limit, a bad text, a target that is not there', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    for (let i = 0; i < CHAT_RATE.max; i++) ok(await s.meet.post(tessa, { key: key(`f${i}`), target: { conversationId: dm }, text: `f${i}` }))
    // limit
    const limited = await s.meet.post(tessa, { key: key('K'), target: { conversationId: dm }, text: 'wait' })
    expect(limited).toMatchObject({ ok: false, reason: 'limit' })
    expect(s.count(`SELECT COUNT(*) AS n FROM compose_keys WHERE key = '${key('K')}'`)).toBe(0)
    s.h.clock.now += CHAT_RATE.windowMs
    const tessa2 = await s.as(OWNER)
    const posted = await s.meet.post(tessa2, { key: key('K'), target: { conversationId: dm }, text: 'wait' })
    expect(posted).toMatchObject({ ok: true, value: { message: { text: 'wait' } } })
    // and now it is held
    expect(await s.meet.post(tessa2, { key: key('K'), target: { conversationId: dm }, text: 'wait' })).toMatchObject({ reason: 'repeated' })

    // a bad text, to a person who has no direct message yet: nothing is opened either
    const ben = await s.idOf(BEN)
    const dms = s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)
    expect(await s.meet.post(tessa2, { key: key('L'), target: { personId: ben }, text: ' ' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(dms)
    expect(await s.meet.post(tessa2, { key: key('L'), target: { personId: ben }, text: 'now with words' })).toMatchObject({ ok: true })

    // a target that is not there, then the same key to one that is
    expect(await s.meet.post(tessa2, { key: key('M'), target: { conversationId: 31337 }, text: 'x' })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await s.meet.post(tessa2, { key: key('M'), target: { personId: 'nobody' }, text: 'x' })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await s.meet.post(tessa2, { key: key('M'), target: { conversationId: dm }, text: 'x' })).toMatchObject({ ok: true })
  })

  test('a refused use to a person under the rate limit opens no direct message', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    for (let i = 0; i < CHAT_RATE.max; i++) ok(await s.meet.post(tessa, { key: key(`f${i}`), target: { conversationId: dm }, text: `f${i}` }))
    const dms = s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)
    expect(await s.meet.post(tessa, { key: key('N'), target: { personId: await s.idOf(BEN) }, text: 'too fast' })).toMatchObject({ reason: 'limit' })
    expect(s.count(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)).toBe(dms)
  })

  test('a post whose outcome the Worker cannot know is thrown, never answered `broken`, and a read that fails is `broken` and never thrown', async () => {
    // `broken` promises nothing went out. A fault on the hop to the Workspace object can arrive after the write committed, so
    // for a post it is thrown across the binding and the space reads it as outcome-unknown (and never offers a retry).
    let breakNext = false
    const s0 = await setup()
    const flaky: SpaceMeetDeps['workspace'] = () =>
      new Proxy(s0.deps.workspace(), {
        get(target, prop, receiver) {
          if (prop === 'spacePost' && breakNext) {
            breakNext = false
            return async () => {
              throw new Error('the object was reset')
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    const m = spaceMeet({ ...s0.deps, workspace: flaky })
    const dm = await s0.dm(OWNER, ANA)
    const tessa = await s0.as(OWNER)
    breakNext = true
    await expect(m.post(tessa, { key: key('B'), target: { conversationId: dm }, text: 'try' })).rejects.toThrow('the object was reset')
    // meet's own refusals are still data,.
    expect(await m.post(tessa, { key: key('B'), target: { conversationId: 31337 }, text: 'try' })).toMatchObject({ ok: false, reason: 'not-found' })
    // Reads never throw: a fault is `broken`, since nothing was written.
    const dead = spaceMeet({ ...s0.deps, workspace: () => { throw new Error('no object') } })
    expect(await dead.conversations(tessa)).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect(await dead.markRead(tessa, dm, 1)).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
  })

  test('editing the message updates what a repeat answers with, as deleting blanks it', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    const posted = ok(await s.meet.post(tessa, { key: key('edit'), target: { conversationId: dm }, text: 'first words' }))
    s.h.clock.now += 5000
    expect((await s.a.tm(OWNER, 'PATCH', `/messages/${posted.message.id}`, { text: 'better words' })).status).toBe(200)
    const again = await s.meet.post(await s.as(OWNER), { key: key('edit'), target: { conversationId: dm }, text: 'first words' })
    expect(again).toMatchObject({ reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: { message: { id: posted.message.id, text: 'better words', editedAt: s.h.clock.now } } } } })
    expect(JSON.stringify(again)).not.toContain('first words')
    expect(s.count(`SELECT COUNT(*) AS n FROM messages`)).toBe(1)
  })

  test('a key belongs to the person who used it: another person’s post with the same key is their own first use', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    expect(await s.meet.post(await s.as(OWNER), { key: key('shared'), target: { conversationId: dm }, text: 'from Tessa' })).toMatchObject({ ok: true })
    expect(await s.meet.post(await s.as(ANA), { key: key('shared'), target: { conversationId: dm }, text: 'from Ana' })).toMatchObject({ ok: true })
    expect(await s.meet.post(await s.as(ANA), { key: key('shared'), target: { conversationId: dm }, text: 'from Ana' })).toMatchObject({ reason: 'repeated' })
  })

  test('a key is held for the contract’s whole day, then free; meet’s cron drops the old ones', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const send = async () => s.meet.post(await s.as(OWNER, Math.floor(s.h.clock.now / 1000) + 3600), { key: key('day'), target: { conversationId: dm }, text: 'daily' })
    expect(await send()).toMatchObject({ ok: true })
    s.h.clock.now += COMPOSE_KEY_KEPT_MS - 1
    expect(await send()).toMatchObject({ reason: 'repeated' })
    s.h.clock.now += 2
    expect(await send()).toMatchObject({ ok: true })
    s.h.clock.now += COMPOSE_KEY_KEPT_MS + 1
    s.h.workspaceCore.maintain(s.h.clock.now)
    expect(s.count(`SELECT COUNT(*) AS n FROM compose_keys`)).toBe(0)
  })

  test('deleting the message keeps the key held but keeps none of its words', async () => {
    const s = await setup()
    const dm = await s.dm(OWNER, ANA)
    const tessa = await s.as(OWNER)
    const posted = ok(await s.meet.post(tessa, { key: key('del'), target: { conversationId: dm }, text: 'TOKEN-TO-DELETE' }))
    expect((await s.a.tm(OWNER, 'DELETE', `/messages/${posted.message.id}`)).status).toBe(200)
    const again = await s.meet.post(tessa, { key: key('del'), target: { conversationId: dm }, text: 'TOKEN-TO-DELETE' })
    expect(again).toMatchObject({ reason: 'repeated' })
    expect(JSON.stringify(again)).not.toContain('TOKEN-TO-DELETE')
  })

  test('the Phone conversation takes no post from the space', async () => {
    const s = await setup()
    await s.a.tm(OWNER, 'GET', '/bootstrap')
    const phone = (s.h.workspaceSql.all<{ id: number }>(`SELECT id FROM conversations WHERE kind = 'phone'`)[0] as { id: number }).id
    expect(await s.meet.post(await s.as(OWNER), { key: key('ph'), target: { conversationId: phone }, text: 'hi' })).toMatchObject({ ok: false, reason: 'not-found' })
  })
})


describe('the calls in progress: the ones with someone in them that the person made', () => {
  const startAsOwner = (s: S): Promise<string> => s.h.startCall(OWNER)
  const enter = async (s: S, name: string, who: string) => expect((await s.h.call('POST', `/r/api/rooms/${name}/join`, { name: who }, { token: `${who}-token-`.padEnd(24, 'x') })).status).toBe(200)
  /** A call made by someone else (only the owner can make one through the start page today), put in the index as the page will. */
  const madeBy = async (s: S, who: string | null) => {
    const name = (who === null ? 'k' : 'm').repeat(20) // a name in meet's alphabet
    await s.h.deps.room(name).create(name, s.h.clock.now)
    await s.h.deps.ledger().recordCall(name, s.h.clock.now, who)
    return name
  }

  test('a call Tessa started, with two people in it, is his: its name, when it was made and how many are in it', async () => {
    const s = await setup()
    const name = await startAsOwner(s)
    await enter(s, name, 'dana')
    await enter(s, name, 'ben')
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toEqual([{ name, startedAt: s.h.clock.now, present: 2, why: 'started' }])
    // The start page wrote who made it, which is what keeps the call Tessa's alone when others can make calls.
    expect((await s.h.deps.ledger().listCalls(5, null)).calls).toEqual([{ name, startedAt: s.h.clock.now, startedBy: OWNER }])
  })

  test('a call nobody is in is not listed, and one is not listed once everyone has gone quiet', async () => {
    const s = await setup()
    const name = await startAsOwner(s)
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toEqual([])
    await enter(s, name, 'dana')
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toHaveLength(1)
    s.h.clock.now += MEMBER_TIMEOUT_MS + 1000
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toEqual([])
  })

  test('a call is shown to the person who made it and to nobody else', async () => {
    const s = await setup()
    const tessaCall = await startAsOwner(s)
    const anasCall = await madeBy(s, ANA)
    for (const name of [tessaCall, anasCall]) await enter(s, name, 'dana')
    expect(ok(await s.meet.liveCalls(await s.as(OWNER))).map((c) => c.name)).toEqual([tessaCall])
    expect(ok(await s.meet.liveCalls(await s.as(ANA))).map((c) => c.name)).toEqual([anasCall])
    // Ben made none, and is told of none, though two calls are running.
    expect(ok(await s.meet.liveCalls(await s.as(BEN)))).toEqual([])
  })

  test('a call made before the index recorded who made it was the owner’s, the only person who could', async () => {
    const s = await setup()
    const old = await madeBy(s, null)
    await enter(s, old, 'dana')
    expect(ok(await s.meet.liveCalls(await s.as(OWNER))).map((c) => c.name)).toEqual([old])
    expect(ok(await s.meet.liveCalls(await s.as(ANA)))).toEqual([])
  })

  test('newest first, and only as far back as meet looks', async () => {
    const s = await setup()
    const first = await startAsOwner(s)
    await enter(s, first, 'dana')
    s.h.clock.now += 1000
    const second = await startAsOwner(s)
    await enter(s, second, 'ben')
    expect(ok(await s.meet.liveCalls(await s.as(OWNER))).map((c) => c.name)).toEqual([second, first])
    // Behind LIVE_CALLS_SCANNED newer calls, a call still running is no longer looked for.
    for (let i = 0; i < LIVE_CALLS_SCANNED; i++) {
      s.h.clock.now += 1000
      await startAsOwner(s)
    }
    expect(ok(await s.meet.liveCalls(await s.as(OWNER)))).toEqual([])
  })

  test('the words of the people in the call, and its chat, are not in the answer', async () => {
    const s = await setup()
    const name = await startAsOwner(s)
    await enter(s, name, 'SECRET-GUEST-NAME')
    expect(JSON.stringify(ok(await s.meet.liveCalls(await s.as(OWNER))))).not.toContain('SECRET-GUEST-NAME')
  })
})

async function sha(s: string): Promise<string> {
  const { sha256Hex } = await import('../src/door')
  return sha256Hex(s)
}

// Each company has its own Worker and its own Workspace object, so a second company's meet is the same code with its own
// declaration (packages/workspace/test/fixtures/pinecrest.json): its people are the only ones it admits, and what it holds is
// never Northfield's. The harness holds one company's store, as one deployment does.
describe("a second company's install", () => {
  const LANE = createInstall(lane)
  const LANE_OWNER = 'lane@pinecrest.test'
  const DANA = 'dana@pinecrest.test'
  // Corin signs in with a personal Gmail address and is named by the work address.
  const CORIN_SIGN_IN = 'corin.private@example.com'
  const CORIN = 'corin@pinecrest.test'

  test('its people are asked as themselves, and see only their own conversations', async () => {
    const s = await setup({ install: LANE })
    const ch = await s.channel(LANE_OWNER, 'estimates')
    await s.add(LANE_OWNER, ch, DANA)
    await s.say(LANE_OWNER, ch, 'LANE-ONLY-WORDS')
    const owner = ok(await s.meet.conversations(await s.as(LANE_OWNER)))
    expect(owner.me).toMatchObject({ name: 'Lane', address: LANE_OWNER })
    expect(owner.channels.map((c) => c.name)).toEqual(['estimates'])
    const dana = ok(await s.meet.conversations(await s.as(DANA)))
    expect(dana.channels[0]?.newest?.text).toBe('LANE-ONLY-WORDS')
    // Corin is in no conversation: he sees none, and is known by his work address although he signs in with his Gmail.
    const corin = ok(await s.meet.conversations(await s.as(CORIN_SIGN_IN)))
    expect(corin.me).toMatchObject({ name: 'Corin', address: CORIN })
    expect(corin.channels).toEqual([])
    // Posting works for them and goes into their company's store.
    expect(await s.meet.post(await s.as(DANA), { key: key('lane'), target: { conversationId: ch }, text: 'from Dana' })).toMatchObject({ ok: true })
  })

  test('a Northfield Works person is not admitted, even when Cloudflare signed their assertion, and learns nothing of the company’s conversations', async () => {
    const s = await setup({ install: LANE })
    const ch = await s.channel(LANE_OWNER, 'estimates')
    await s.say(LANE_OWNER, ch, 'LANE-ONLY-WORDS')
    const before = s.count(`SELECT COUNT(*) AS n FROM people`)
    for (const who of [OWNER, ANA, 'gus@client.test']) {
      const a = await s.as(who)
      const answers = [
        await s.meet.conversations(a),
        await s.meet.history(a, ch),
        await s.meet.post(a, { key: key('zab'), target: { conversationId: ch }, text: 'let me in' }),
        await s.meet.markRead(a, ch, 1),
        await s.meet.liveCalls(a),
      ]
      for (const r of answers) expect([who, r]).toEqual([who, { ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED }])
      expect(JSON.stringify(answers)).not.toContain('LANE-ONLY-WORDS')
    }
    // Nobody was let in: no person was made for them and nothing was posted.
    expect(s.count(`SELECT COUNT(*) AS n FROM people`)).toBe(before)
    expect(s.count(`SELECT COUNT(*) AS n FROM messages WHERE text = 'let me in'`)).toBe(0)
  })

  test("and the other way: the second company's person is not admitted at Northfield's meet, and the second company's work address is nobody's sign-in", async () => {
    const s = await setup()
    for (const who of [LANE_OWNER, DANA, CORIN, CORIN_SIGN_IN]) {
      expect([who, await s.meet.conversations(await s.as(who))]).toEqual([who, { ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED }])
    }
    // At the second company's own meet, Corin's work address is not what Access sends the code to.
    const l = await setup({ install: LANE })
    expect(await l.meet.conversations(await l.as(CORIN))).toMatchObject({ ok: false, reason: 'not-admitted' })
  })
})
