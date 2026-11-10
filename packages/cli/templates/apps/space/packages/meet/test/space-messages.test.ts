// What only /start still did in chat: the people a first direct message can go to, editing and deleting a message, and a person's own
// settings (name, the 15-minute nudge, the privacy note). SpaceMeet's methods over the real Workspace core, with a signed assertion for the SPACE application as the one thing
// that says who is asking. The seam is the method, as the space calls it over a service binding: /start's rules and words, asked as the same teammate; what a person outside a
// conversation is never told; the compose key on the first message to someone (one direct message, one message); and that no sign-in is refused at every new method.
import { describe, expect, test } from 'bun:test'
import { MEET_FOR_SPACE_METHODS, NOT_ADMITTED, type SignedIn, type SpaceReply } from '@space/workspace'
import { type SpaceMeetDeps, spaceMeet } from '../src/space-meet'
import { ANA, BEN, OWNER, harness, signedAs } from './helpers'
import { actors } from './workspace.helpers'

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
  /** A channel made at /start's door, so the test does not lean on the space's own channel admin. */
  const channel = async (by: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<number> => (await a.tm(by, 'POST', '/channels', { name, privacy })).json.conversation.id
  const add = async (by: string, conv: number, person: string) => a.tm(by, 'POST', `/channels/${conv}/members`, { person })
  const say = async (by: string, conv: number, text: string): Promise<number> => {
    const r = await a.tm(by, 'POST', `/conversations/${conv}/messages`, { text })
    expect(r.status).toBe(201)
    return r.json.message.id
  }
  const invite = async (by: string, conv: number, email = DANA, name = 'Dana Reyes') => (await a.tm(by, 'POST', `/channels/${conv}/invite`, { email, name })).json.person.id as string
  return { h, a, meet, deps, as, idOf, key, channel, add, say, invite }
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
      await s.meet.peopleToMessage(stranger),
      await s.meet.editMessage(stranger, { messageId: 1, text: 'x' }),
      await s.meet.deleteMessage(stranger, 1),
      await s.meet.me(stranger),
      await s.meet.updateMe(stranger, { name: 'X' }),
      await s.meet.acknowledgePrivacy(stranger),
    ]
    for (const r of rs) expect(r).toEqual({ ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
  })

  test('a channel guest never reaches the space: not-admitted at every new method, whatever the check named', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    await s.invite(OWNER, ops)
    const m = await s.say(OWNER, ops, 'hello')
    const dana = await s.as(DANA)
    const rs = [
      await s.meet.peopleToMessage(dana),
      await s.meet.editMessage(dana, { messageId: m, text: 'x' }),
      await s.meet.deleteMessage(dana, m),
      await s.meet.me(dana),
      await s.meet.updateMe(dana, { nudgesOff: true }),
      await s.meet.acknowledgePrivacy(dana),
    ]
    for (const r of rs) expect(r).toEqual({ ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
    // Nothing of the guest's was touched, and the message is as it was.
    expect(s.h.workspaceSql.all<{ text: string }>('SELECT text FROM messages WHERE id = ?', m)[0]?.text).toBe('hello')
  })

  test('the methods are exactly the contract’s, and none of the new ones is named for an email', async () => {
    const s = await setup()
    expect(Object.keys(s.meet).sort()).toEqual([...MEET_FOR_SPACE_METHODS].sort())
    for (const m of ['peopleToMessage', 'editMessage', 'deleteMessage', 'me', 'updateMe', 'acknowledgePrivacy']) expect(m).not.toMatch(/send|invite|email|mail/i)
  })
})

describe('a first direct message: who the asker may open one with, and the post that opens it', () => {
  test('every teammate but the asker is listed; a guest only when they share a channel with the asker', async () => {
    const s = await setup()
    await s.idOf(ANA)
    await s.idOf(BEN)
    const people = ok(await s.meet.peopleToMessage(await s.as(OWNER)))
    expect(people.map((p) => p.person.address)).toEqual(expect.arrayContaining([ANA, BEN]))
    expect(people.map((p) => p.person.address)).not.toContain(OWNER)
    expect(people.every((p) => p.direct === false)).toBe(true)
    // Dana is invited into Ana's channel: Ana shares it with her, Tessa does not.
    const theirs = await s.channel(ANA, 'theirs')
    await s.invite(ANA, theirs)
    expect(ok(await s.meet.peopleToMessage(await s.as(ANA))).find((p) => p.person.address === DANA)).toMatchObject({ person: { kind: 'guest' }, direct: false })
    expect(ok(await s.meet.peopleToMessage(await s.as(OWNER))).map((p) => p.person.address)).not.toContain(DANA)
    // The owner joins the channel and now shares it with her.
    await s.add(ANA, theirs, await s.idOf(OWNER))
    expect(ok(await s.meet.peopleToMessage(await s.as(OWNER))).map((p) => p.person.address)).toContain(DANA)
  })

  test('a person removed from the workspace is not listed; one with a direct message that has something in it says so', async () => {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const ops = await s.channel(OWNER, 'ops')
    const dana = await s.invite(OWNER, ops)
    const listed = async () => ok(await s.meet.peopleToMessage(await s.as(OWNER)))
    expect((await listed()).find((p) => p.person.id === dana)).toBeTruthy()
    const dm = (await s.a.tm(OWNER, 'POST', '/dms', { person: ana })).json.conversation.id
    expect((await listed()).find((p) => p.person.id === ana)?.direct).toBe(false)
    await s.say(OWNER, dm, 'hi')
    expect((await listed()).find((p) => p.person.id === ana)?.direct).toBe(true)
    expect((await s.a.tm(OWNER, 'POST', `/people/${dana}/remove`)).status).toBe(200)
    expect((await listed()).find((p) => p.person.id === dana)).toBeUndefined()
  })

  test('the first message to someone is `post` by personId: one direct message, one message, whatever the key is pressed with', async () => {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const owner = await s.as(OWNER)
    const k = s.key('first')
    const first = ok(await s.meet.post(owner, { key: k, target: { personId: ana }, text: 'hello Ana' }))
    expect(first.message).toMatchObject({ text: 'hello Ana', mine: true, may: { edit: true, delete: true } })
    const again = await s.meet.post(owner, { key: k, target: { personId: ana }, text: 'hello Ana' })
    expect(again).toMatchObject({ ok: false, reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: { conversationId: first.conversationId } } } })
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)[0]?.n).toBe(1)
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?`, first.conversationId)[0]?.n).toBe(1)
    // The other side sees it in their overview, unread.
    expect(ok(await s.meet.conversations(await s.as(ANA))).direct.find((d) => d.conversationId === first.conversationId)).toMatchObject({ unread: 1, person: { address: OWNER } })
  })

  test('a refused first message opens no direct message and releases its key', async () => {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const owner = await s.as(OWNER)
    const k = s.key('long')
    expect(refusal(await s.meet.post(owner, { key: k, target: { personId: ana }, text: 'x'.repeat(2001) }))).toMatchObject({ reason: 'bad-request', message: 'A message is at most 2,000 characters.' })
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)[0]?.n).toBe(0)
    expect(ok(await s.meet.post(owner, { key: k, target: { personId: ana }, text: 'short' })).message.text).toBe('short')
  })

  test('a guest the asker shares no channel with is not found, and nothing is opened; a person who is not there is the same', async () => {
    const s = await setup()
    const ops = await s.channel(ANA, 'ops')
    const dana = await s.invite(ANA, ops)
    const owner = await s.as(OWNER)
    const none = refusal(await s.meet.post(owner, { key: s.key('g'), target: { personId: dana }, text: 'hi' }))
    const gone = refusal(await s.meet.post(owner, { key: s.key('h'), target: { personId: 'nobody-here' }, text: 'hi' }))
    expect(none).toMatchObject({ reason: 'not-found', message: 'There is no such person.' })
    expect(gone).toEqual({ ...none, ...{ ok: false } })
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'dm'`)[0]?.n).toBe(0)
  })
})

describe('editing a message', () => {
  test('a person edits their own: the words change, it says edited, and the answer says what they may do', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const m = await s.say(OWNER, ops, 'first draft')
    s.h.clock.now += 60_000
    const edited = ok(await s.meet.editMessage(await s.as(OWNER), { messageId: m, text: '  better   words  ' }))
    expect(edited).toMatchObject({ id: m, conversationId: ops, text: 'better   words', editedAt: s.h.clock.now, mine: true, may: { edit: true, delete: true } })
    expect(ok(await s.meet.history(await s.as(OWNER), ops)).messages.map((x) => [x.id, x.text, x.editedAt])).toEqual([[m, 'better   words', s.h.clock.now]])
    // The same words again are the same message, not an error.
    expect(ok(await s.meet.editMessage(await s.as(OWNER), { messageId: m, text: 'better   words' })).text).toBe('better   words')
  })

  test('the refusals are /start’s, in /start’s words: only your own, not empty, not over 2,000 characters', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    await s.add(OWNER, ops, await s.idOf(ANA))
    const m = await s.say(OWNER, ops, 'mine')
    const ana = await s.as(ANA)
    expect(refusal(await s.meet.editMessage(ana, { messageId: m, text: 'not yours' }))).toMatchObject({ reason: 'not-admitted', message: 'You can edit only your own messages.' })
    const owner = await s.as(OWNER)
    expect(refusal(await s.meet.editMessage(owner, { messageId: m, text: '   ' }))).toMatchObject({ reason: 'bad-request', message: 'A message cannot be empty. Delete it instead.' })
    expect(refusal(await s.meet.editMessage(owner, { messageId: m, text: 'x'.repeat(2001) }))).toMatchObject({ reason: 'bad-request', message: 'A message is at most 2,000 characters.' })
    expect(refusal(await s.meet.editMessage(owner, { messageId: 'one' as never, text: 'x' }))).toMatchObject({ reason: 'bad-request' })
    expect(refusal(await s.meet.editMessage(owner, { messageId: 1.5, text: 'x' }))).toMatchObject({ reason: 'bad-request' })
    expect(ok(await s.meet.history(owner, ops)).messages.map((x) => x.text)).toEqual(['mine'])
  })

  test('a message in a conversation the asker is not in is "no such message", the same words as one that is not there', async () => {
    const s = await setup()
    const secret = await s.channel(ANA, 'secret')
    const m = await s.say(ANA, secret, 'the plan')
    const owner = await s.as(OWNER)
    const hidden = refusal(await s.meet.editMessage(owner, { messageId: m, text: 'tampered' }))
    const missing = refusal(await s.meet.editMessage(owner, { messageId: 999_999, text: 'tampered' }))
    expect(hidden).toEqual(missing)
    expect(hidden).toMatchObject({ reason: 'not-found', message: 'There is no such message.' })
    // The same for a teammate who left the channel, and for an archived one.
    const open = await s.channel(ANA, 'open', 'open')
    const o = await s.say(ANA, open, 'old news')
    expect((await s.a.tm(ANA, 'POST', `/channels/${open}/archive`)).status).toBe(200)
    expect(refusal(await s.meet.editMessage(await s.as(ANA), { messageId: o, text: 'x' })).reason).toBe('not-found')
    expect(s.h.workspaceSql.all<{ text: string }>('SELECT text FROM messages WHERE id = ?', m)[0]?.text).toBe('the plan')
  })

  test('the Phone conversation is not edited through the space: no such message', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const owner = await s.idOf(OWNER)
    s.h.workspaceSql.run(`INSERT INTO conversations (kind, created_at) SELECT 'phone', ? WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE kind = 'phone')`, s.h.clock.now)
    const phone = s.h.workspaceSql.all<{ id: number }>(`SELECT id FROM conversations WHERE kind = 'phone'`)[0]?.id as number
    s.h.workspaceSql.run('INSERT OR IGNORE INTO conv_members (conv_id, person_id, added_at) VALUES (?, ?, ?)', phone, owner, s.h.clock.now)
    s.h.workspaceSql.run(`INSERT INTO messages (conv_id, person_id, text, at) VALUES (?, ?, 'a voicemail', ?)`, phone, owner, s.h.clock.now)
    const id = s.h.workspaceSql.all<{ id: number }>(`SELECT id FROM messages WHERE conv_id = ?`, phone)[0]?.id as number
    expect(refusal(await s.meet.editMessage(await s.as(OWNER), { messageId: id, text: 'x' })).reason).toBe('not-found')
    expect(refusal(await s.meet.deleteMessage(await s.as(OWNER), id)).reason).toBe('not-found')
    expect(ops).toBeGreaterThan(0)
  })
})

describe('deleting a message', () => {
  test('a person deletes their own for everyone, and it is gone from history and from the other person’s overview', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    await s.add(OWNER, ops, await s.idOf(ANA))
    await s.say(OWNER, ops, 'keep')
    const m = await s.say(OWNER, ops, 'oops')
    expect(ok(await s.meet.deleteMessage(await s.as(OWNER), m))).toEqual({ conversationId: ops, messageId: m })
    for (const who of [OWNER, ANA]) expect(ok(await s.meet.history(await s.as(who), ops)).messages.map((x) => x.text)).toEqual(['keep'])
    expect(s.h.workspaceSql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE text = 'oops'`)[0]?.n).toBe(0)
    // A second press finds nothing.
    expect(refusal(await s.meet.deleteMessage(await s.as(OWNER), m))).toMatchObject({ reason: 'not-found', message: 'There is no such message.' })
  })

  test('the owner deletes another person’s in a conversation he is in; no one else does', async () => {
    const s = await setup()
    const ops = await s.channel(ANA, 'ops')
    await s.add(ANA, ops, await s.idOf(OWNER))
    await s.add(ANA, ops, await s.idOf(BEN))
    const m = await s.say(ANA, ops, 'ana wrote this')
    expect(refusal(await s.meet.deleteMessage(await s.as(BEN), m))).toMatchObject({ reason: 'not-admitted', message: 'You can delete only your own messages.' })
    expect(ok(await s.meet.history(await s.as(ANA), ops)).messages).toHaveLength(1)
    expect(ok(await s.meet.deleteMessage(await s.as(OWNER), m)).messageId).toBe(m)
    expect(ok(await s.meet.history(await s.as(ANA), ops)).messages).toEqual([])
  })

  test('the owner outside a private conversation does not delete in it, nor learn it exists: tighter than /start, never looser', async () => {
    const s = await setup()
    const secret = await s.channel(ANA, 'secret')
    const m = await s.say(ANA, secret, 'the plan')
    const hidden = refusal(await s.meet.deleteMessage(await s.as(OWNER), m))
    expect(hidden).toEqual(refusal(await s.meet.deleteMessage(await s.as(OWNER), 999_999)))
    expect(hidden).toMatchObject({ reason: 'not-found', message: 'There is no such message.' })
    expect(ok(await s.meet.history(await s.as(ANA), secret)).messages).toHaveLength(1)
  })

  test('what the page is told it may do: your own, the owner’s over another’s, a huddle’s announcement included', async () => {
    const s = await setup()
    const ops = await s.channel(ANA, 'ops')
    await s.add(ANA, ops, await s.idOf(OWNER))
    await s.say(ANA, ops, 'from ana')
    await s.say(OWNER, ops, 'from tessa')
    const started = await s.meet.startHuddle(await s.as(ANA), { key: s.key('huddle'), conversationId: ops })
    expect(started).toMatchObject({ ok: true })
    const mayOf = async (who: string) => ok(await s.meet.history(await s.as(who), ops)).messages.map((m) => [m.text.slice(0, 7), m.may])
    const edit = { edit: true, delete: true }
    const del = { edit: false, delete: true }
    const none = { edit: false, delete: false }
    // A huddle's announcement is a message like any other, as at /start: its author edits and deletes it, the owner deletes it, no one else does.
    expect(await mayOf(OWNER)).toEqual([['from an', del], ['from te', edit], ['Started', del]])
    expect(await mayOf(ANA)).toEqual([['from an', edit], ['from te', none], ['Started', edit]])
    expect(none).toEqual({ edit: false, delete: false })
    // And it is done: the owner deletes the announcement, its author edits it, through the space.
    const history = ok(await s.meet.history(await s.as(OWNER), ops)).messages
    const announced = history.find((m) => m.huddle !== undefined)
    expect(ok(await s.meet.editMessage(await s.as(ANA), { messageId: announced?.id as number, text: 'Huddle, join us' })).text).toBe('Huddle, join us')
    expect(ok(await s.meet.deleteMessage(await s.as(OWNER), announced?.id as number)).messageId).toBe(announced?.id as number)
  })
})

describe('a person’s own settings', () => {
  test('they read their own, and a name is changed in /start’s way: one line of at most 40, never empty', async () => {
    const s = await setup()
    const me = ok(await s.meet.me(await s.as(ANA)))
    expect(me).toMatchObject({ person: { address: ANA, kind: 'teammate' }, owner: false, nudgesOff: false, privacyAcked: false })
    const renamed = ok(await s.meet.updateMe(await s.as(ANA), { name: `  Ana   B\n${'x'.repeat(60)}` }))
    expect(renamed.person.name.length).toBeLessThanOrEqual(40)
    expect(renamed.person.name.startsWith('Ana')).toBe(true)
    expect(refusal(await s.meet.updateMe(await s.as(ANA), { name: '   ' }))).toMatchObject({ reason: 'bad-request', message: 'Your name cannot be empty.' })
    expect(ok(await s.meet.me(await s.as(ANA))).person.name).toBe(renamed.person.name)
    expect(ok(await s.meet.me(await s.as(OWNER))).owner).toBe(true)
  })

  test('the name is the name on their messages, and nobody else’s changes', async () => {
    const s = await setup()
    const ops = await s.channel(ANA, 'ops')
    await s.say(ANA, ops, 'hello')
    ok(await s.meet.updateMe(await s.as(ANA), { name: 'Ana Brooks' }))
    expect(ok(await s.meet.history(await s.as(ANA), ops)).messages[0]?.authorName).toBe('Ana Brooks')
    expect(ok(await s.meet.me(await s.as(BEN))).person.name).not.toBe('Ana Brooks')
  })

  test('the nudge: off stops the email that says a direct message has waited, on starts it again, and a value that is not a boolean is refused rather than read as on', async () => {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const owner = await s.as(OWNER)
    ok(await s.meet.post(owner, { key: s.key('nudge'), target: { personId: ana }, text: 'a very private sentence' }))
    const due = () => s.h.workspaceCore.dueNudges(s.h.clock.now, [...s.h.online])
    s.h.clock.now += 16 * 60_000
    expect(due()).toHaveLength(1)
    expect(ok(await s.meet.updateMe(await s.as(ANA), { nudgesOff: true })).nudgesOff).toBe(true)
    expect(due()).toEqual([])
    for (const bad of ['false', 0, null, 'no']) {
      expect(refusal(await s.meet.updateMe(await s.as(ANA), { nudgesOff: bad as never })).reason).toBe('bad-request')
    }
    expect(ok(await s.meet.me(await s.as(ANA))).nudgesOff).toBe(true)
    expect(ok(await s.meet.updateMe(await s.as(ANA), { nudgesOff: false })).nudgesOff).toBe(false)
    expect(due()).toHaveLength(1)
    // Setting it changes a setting and sends nothing.
    expect(s.h.mail).toEqual([])
  })

  test('a patch that changes nothing is refused, not quietly done', async () => {
    const s = await setup()
    const ana = await s.as(ANA)
    for (const bad of [{}, null, 'name', 7, []]) expect(refusal(await s.meet.updateMe(ana, bad as never)).reason).toBe('bad-request')
  })

  test('the privacy note is acknowledged once, and asking again changes nothing', async () => {
    const s = await setup()
    const ana = await s.as(ANA)
    expect(ok(await s.meet.me(ana)).privacyAcked).toBe(false)
    expect(ok(await s.meet.acknowledgePrivacy(ana)).privacyAcked).toBe(true)
    const stamp = () => s.h.workspaceSql.all<{ at: number }>('SELECT acked_privacy_at AS at FROM people WHERE email = ?', ANA)[0]?.at
    const first = stamp()
    s.h.clock.now += 60_000
    expect(ok(await s.meet.acknowledgePrivacy(ana)).privacyAcked).toBe(true)
    expect(stamp()).toBe(first)
    expect(ok(await s.meet.me(await s.as(BEN))).privacyAcked).toBe(false)
  })
})

describe('a write whose outcome the Worker cannot know is thrown, never answered `broken`', () => {
  test('edit, delete and the settings: the object commits, then the hop back fails', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const a = await s.say(OWNER, ops, 'one')
    const b = await s.say(OWNER, ops, 'two')
    const real = s.deps.workspace()
    const lose = <K extends 'spaceEdit' | 'spaceDelete' | 'spaceUpdateMe' | 'spaceAckPrivacy'>(method: K) => {
      const flaky = () => ({
        ...real,
        [method]: async (...args: never[]) => {
          await (real[method] as (...a: never[]) => Promise<unknown>)(...args)
          throw new Error('the object was reset')
        },
      })
      return spaceMeet({ ...s.deps, workspace: flaky as never })
    }
    const owner = await s.as(OWNER)
    await expect(lose('spaceEdit').editMessage(owner, { messageId: a, text: 'one, edited' })).rejects.toThrow('the object was reset')
    await expect(lose('spaceDelete').deleteMessage(owner, b)).rejects.toThrow('the object was reset')
    await expect(lose('spaceUpdateMe').updateMe(owner, { nudgesOff: true })).rejects.toThrow('the object was reset')
    await expect(lose('spaceAckPrivacy').acknowledgePrivacy(owner)).rejects.toThrow('the object was reset')
    // All four were done.
    expect(ok(await s.meet.history(owner, ops)).messages.map((m) => m.text)).toEqual(['one, edited'])
    expect(ok(await s.meet.me(owner))).toMatchObject({ nudgesOff: true, privacyAcked: true })
    // A refusal of meet's own is still a refusal, never thrown.
    expect(refusal(await lose('spaceEdit').editMessage(owner, { messageId: 999_999, text: 'x' })).reason).toBe('not-found')
  })

  test('none of them sends an email', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const m = await s.say(OWNER, ops, 'one')
    const owner = await s.as(OWNER)
    ok(await s.meet.peopleToMessage(owner))
    ok(await s.meet.editMessage(owner, { messageId: m, text: 'two' }))
    ok(await s.meet.updateMe(owner, { name: 'Tessa Y' }))
    ok(await s.meet.acknowledgePrivacy(owner))
    ok(await s.meet.deleteMessage(owner, m))
    expect(s.h.mail).toEqual([])
  })
})
