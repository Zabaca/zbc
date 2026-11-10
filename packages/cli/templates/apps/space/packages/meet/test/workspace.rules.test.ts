// Seam 1, continued: what a person may see and do inside the workspace, through the real router and core. Who may
// make, invite, add and remove; who sees which channel and person; who may edit and delete; what a message goes
// through; what a browser is sent when it catches up; unread; the nudges; and removing and deleting people.
import { beforeEach, describe, expect, test } from 'bun:test'
import { runCron } from '../src/cron'
import { CHANGES_KEEP_MS } from '../src/workspace-model'
import { nextExpiry, parseFrame, signInEnded } from '../src/workspace-sockets'
import { ANA, BEN, OWNER, T0, harness, installFor, memSql } from './helpers'
import { type Actors, DAY, G, HOUR, W, actors } from './workspace.helpers'
import { WorkspaceCore } from '../src/workspace'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let a: Actors

beforeEach(async () => {
  h = await harness({ devBypass: false })
  a = actors(h)
})

async function channel(as: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<number> {
  const r = await a.tm(as, 'POST', '/channels', { name, privacy })
  expect(r.status).toBe(201)
  return r.json.conversation.id
}
async function guest(by: string, conv: number, email: string, name: string): Promise<{ token: string; id: string }> {
  const r = await a.tm(by, 'POST', `/channels/${conv}/invite`, { email, name })
  expect(r.status).toBe(201)
  return { token: await a.signIn(email), id: r.json.person.id }
}
const say = (as: string, conv: number, text: string) => a.tm(as, 'POST', `/conversations/${conv}/messages`, { text })
const gsay = (token: string, conv: number, text: string) => a.gu(token, 'POST', `/conversations/${conv}/messages`, { text })
const me = async (as: string) => (await a.tm(as, 'GET', '/bootstrap')).json.me.id as string
const boot = async (as: string) => (await a.tm(as, 'GET', '/bootstrap')).json
const gboot = async (token: string) => (await a.gu(token, 'GET', '/bootstrap')).json
/** Past the chat's rate window, so a test that sends many messages is not held up by it. */
const wait = () => void (h.clock.now += 11_000)

describe('channels: who makes, sees, joins and leaves', () => {
  test('a teammate makes an open or a private channel; a guest never makes one', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const r = await a.gu(g.token, 'POST', '/channels', { name: 'mine', privacy: 'open' })
    expect(r.status).toBe(403)
    expect((await a.tm(OWNER, 'POST', '/channels', { name: '', privacy: 'open' })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', '/channels', { name: 'x', privacy: 'secret' })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', '/channels', { name: 'acme', privacy: 'open' })).status).toBe(409) // names are unique, in any case
    expect((await a.tm(OWNER, 'POST', '/channels', { name: '# Cleaned‮  name ', privacy: 'open' })).json.conversation.name).toBe('Cleaned name')
  })

  test('a teammate sees every open channel and can join it, and sees a private channel only once in it', async () => {
    const open = await channel(OWNER, 'Everyone', 'open')
    const priv = await channel(OWNER, 'Acme', 'private')
    const ana = await boot(ANA)
    expect(ana.browse.map((c: any) => c.name)).toEqual(['Everyone'])
    // The Phone conversation is every teammate's from the start; nothing else is hers yet.
    expect(ana.conversations.map((c: any) => c.name)).toEqual(['Phone'])
    // Reading an open channel means joining it; a private one does not exist for her.
    expect((await a.tm(ANA, 'GET', `/conversations/${open}/messages`)).status).toBe(404)
    for (const [method, path] of [['POST', `/channels/${priv}/join`], ['GET', `/conversations/${priv}/messages`], ['POST', `/conversations/${priv}/messages`], ['POST', `/channels/${priv}/archive`], ['PATCH', `/channels/${priv}`], ['POST', `/channels/${priv}/leave`]] as const) {
      const r = await a.tm(ANA, method, path, { text: 'x', name: 'y' })
      expect([path, r.status]).toEqual([path, 404])
    }
    expect((await a.tm(ANA, 'POST', `/channels/${open}/join`)).status).toBe(200)
    expect((await boot(ANA)).conversations.map((c: any) => c.name)).toEqual(['Phone', 'Everyone'])
    expect((await boot(ANA)).browse).toEqual([])
    // Added to the private one by someone in it, she sees it.
    await a.tm(OWNER, 'POST', `/channels/${priv}/members`, { person: await me(ANA) })
    expect((await boot(ANA)).conversations.map((c: any) => c.name)).toEqual(['Phone', 'Everyone', 'Acme'])
    // She can leave an open channel and join again.
    expect((await a.tm(ANA, 'POST', `/channels/${open}/leave`)).status).toBe(200)
    expect((await boot(ANA)).browse.map((c: any) => c.name)).toEqual(['Everyone'])
  })

  test('a guest sees only their channels, and no list of channels to browse', async () => {
    const acme = await channel(OWNER, 'Acme')
    await channel(OWNER, 'Everyone', 'open')
    await channel(OWNER, 'Other client')
    const g = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const b = await gboot(g.token)
    expect(b.conversations.map((c: any) => c.name)).toEqual(['Acme'])
    expect(b.browse).toEqual([])
    expect((await a.gu(g.token, 'POST', `/channels/${acme + 1}/join`)).status).toBe(403)
  })

  test('a teammate in a channel renames it; one who is not cannot', async () => {
    const conv = await channel(OWNER, 'Acme')
    expect((await a.tm(OWNER, 'PATCH', `/channels/${conv}`, { name: 'Acme Corp' })).status).toBe(200)
    expect((await boot(OWNER)).conversations.find((c: any) => c.kind !== 'phone').name).toBe('Acme Corp')
    expect((await a.tm(ANA, 'PATCH', `/channels/${conv}`, { name: 'x' })).status).toBe(404)
    await channel(OWNER, 'Other')
    expect((await a.tm(OWNER, 'PATCH', `/channels/${conv}`, { name: 'other' })).status).toBe(409)
  })

  test('the maker or the Owner archives a channel; nobody else; an archived one is gone from lists and takes no message', async () => {
    const mine = await channel(ANA, 'Ana’s', 'open')
    await a.tm(BEN, 'POST', `/channels/${mine}/join`)
    expect((await a.tm(BEN, 'POST', `/channels/${mine}/archive`)).status).toBe(403)
    expect((await a.tm(ANA, 'POST', `/channels/${mine}/archive`)).status).toBe(200)
    expect((await boot(ANA)).conversations.map((c: any) => c.name)).toEqual(['Phone'])
    expect((await boot(BEN)).browse).toEqual([])
    expect((await say(BEN, mine, 'hello?')).status).toBe(404)
    // The Owner archives one he is not in, even a private one.
    const theirs = await channel(BEN, 'Ben’s', 'private')
    expect((await a.tm(ANA, 'POST', `/channels/${theirs}/archive`)).status).toBe(404)
    expect((await a.tm(OWNER, 'POST', `/channels/${theirs}/archive`)).status).toBe(200)
  })
})

describe('inviting, adding and removing people', () => {
  test('a teammate invites a guest only into a channel they are in', async () => {
    const mine = await channel(OWNER, 'Acme')
    const open = await channel(BEN, 'Everyone', 'open')
    const invite = (as: string, conv: number) => a.tm(as, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    expect((await invite(ANA, mine)).status).toBe(404) // a private channel she is not in
    expect((await invite(ANA, open)).status).toBe(404) // an open one she has not joined
    expect(h.mail.filter((m) => m.to === 'gus@client.test')).toHaveLength(0)
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    expect((await invite(ANA, open)).status).toBe(201)
    expect((await a.tm(OWNER, 'POST', `/channels/${mine}/invite`, { email: 'bad', name: 'x' })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', `/channels/${mine}/invite`, { email: 'x@client.test', name: ' ' })).status).toBe(400)
  })

  test('a guest cannot invite, add or remove anyone, or look anyone up', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const h2 = await guest(OWNER, conv, 'gwen@client.test', 'Gwen')
    const before = h.mail.length
    expect((await a.gu(g.token, 'POST', `/channels/${conv}/invite`, { email: 'x@client.test', name: 'X' })).status).toBe(403)
    expect((await a.gu(g.token, 'POST', `/channels/${conv}/members`, { person: await me(OWNER) })).status).toBe(403)
    expect((await a.gu(g.token, 'DELETE', `/channels/${conv}/members/${h2.id}`)).status).toBe(403)
    expect((await a.gu(g.token, 'POST', `/people/${h2.id}/remove`)).status).toBe(403)
    expect((await a.gu(g.token, 'POST', `/channels/${conv}/leave`)).status).toBe(403)
    expect((await a.gu(g.token, 'DELETE', `/people/${h2.id}`)).status).toBe(403)
    expect(h.mail).toHaveLength(before)
  })

  test('a teammate adds another teammate or a guest they can see, and takes a guest out; a guest left in no channel is removed', async () => {
    const acme = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const side = await channel(OWNER, 'Side')
    // Adding a guest by id works only for one the teammate can see.
    expect((await a.tm(OWNER, 'POST', `/channels/${side}/members`, { person: g.id })).status).toBe(200)
    expect((await a.tm(OWNER, 'POST', `/channels/${side}/members`, { person: 'nobody' })).status).toBe(404)
    // A teammate cannot reach a guest she shares nothing with.
    const stray = await guest(OWNER, side, 'stray@else.test', 'Stray')
    const hidden = await guest(OWNER, await channel(OWNER, 'Else'), 'hidden@else.test', 'Hidden')
    await a.tm(ANA, 'POST', `/channels/${side}/members`, { person: stray.id }).then((r) => expect(r.status).toBe(404)) // not in Side
    // A guest comes out of one channel and still has the other.
    expect((await a.tm(OWNER, 'DELETE', `/channels/${side}/members/${g.id}`)).status).toBe(200)
    expect((await gboot(g.token)).conversations.map((c: any) => c.name)).toEqual(['Acme'])
    // Out of the last one, they are removed from the workspace: signed out, and their sockets closed.
    expect((await a.tm(OWNER, 'DELETE', `/channels/${acme}/members/${g.id}`)).status).toBe(200)
    expect((await a.gu(g.token, 'GET', '/bootstrap')).status).toBe(401)
    expect(h.closed.some((c) => c.person === g.id && c.code === 4403)).toBe(true)
    expect(hidden.id).not.toBe(stray.id)
    // A teammate leaves a channel on their own; no one takes them out.
    const ana = await me(ANA)
    await a.tm(OWNER, 'POST', `/channels/${acme}/members`, { person: ana })
    expect((await a.tm(OWNER, 'DELETE', `/channels/${acme}/members/${ana}`)).status).toBe(403)
  })

  test('the Owner removes any guest; a teammate removes a guest they invited and no other; a teammate is taken off the list instead', async () => {
    const open = await channel(OWNER, 'Everyone', 'open')
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    await a.tm(BEN, 'POST', `/channels/${open}/join`)
    const ours = await guest(ANA, open, 'ana-guest@client.test', 'Ana’s guest')
    const theirs = await guest(BEN, open, 'ben-guest@client.test', 'Ben’s guest')
    expect((await a.tm(ANA, 'POST', `/people/${theirs.id}/remove`)).status).toBe(403)
    expect((await a.tm(ANA, 'POST', `/people/${ours.id}/remove`)).status).toBe(200)
    expect((await a.tm(OWNER, 'POST', `/people/${theirs.id}/remove`)).status).toBe(200)
    expect((await a.tm(OWNER, 'POST', `/people/${await me(ANA)}/remove`)).status).toBe(403)
    expect((await a.gu(ours.token, 'GET', '/bootstrap')).status).toBe(401)
    expect((await a.gu(theirs.token, 'GET', '/bootstrap')).status).toBe(401)
  })
})

describe('who sees whom, and direct messages', () => {
  test('a guest sees only the people who share a channel with them, and never another client’s people', async () => {
    const acme = await channel(OWNER, 'Acme')
    const other = await channel(OWNER, 'Other client')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const gwen = await guest(OWNER, acme, 'gwen@client.test', 'Gwen')
    const olga = await guest(OWNER, other, 'olga@other.test', 'Olga')
    const names = async (token: string) => (await gboot(token)).people.map((p: any) => p.name).sort()
    expect(await names(gus.token)).toEqual(['Gus', 'Gwen', 'Tessa'])
    expect(await names(olga.token)).toEqual(['Olga', 'Tessa'])
    // Ana is a teammate who is in neither: a guest does not see her, and she sees no guest.
    await me(BEN)
    expect((await boot(ANA)).people.map((p: any) => p.name).sort()).toEqual(['Ana', 'Ben', 'Tessa'])
    // A teammate sees a guest only where they share a channel; no guest's address leaks to a guest.
    expect((await boot(OWNER)).people.map((p: any) => p.name).sort()).toEqual(['Ana', 'Ben', 'Gus', 'Gwen', 'Olga', 'Tessa'])
    expect((await gboot(gus.token)).people.every((p: any) => p.email === undefined)).toBe(true)
    expect(olga.id).toBeTruthy()
    expect(gwen.id).toBeTruthy()
  })

  test('a guest opens a direct message with exactly the people who share a channel with them', async () => {
    const acme = await channel(OWNER, 'Acme')
    const other = await channel(OWNER, 'Other client')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const gwen = await guest(OWNER, acme, 'gwen@client.test', 'Gwen')
    const olga = await guest(OWNER, other, 'olga@other.test', 'Olga')
    const tessa = await me(OWNER)
    const ana = await me(ANA)
    const dm = (person: string) => a.gu(gus.token, 'POST', '/dms', { person })
    expect((await dm(tessa)).status).toBe(201) // a teammate in the channel
    expect((await dm(gwen.id)).status).toBe(201) // another guest in it
    expect((await dm(olga.id)).status).toBe(404) // another client's person
    expect((await dm(ana)).status).toBe(404) // a teammate who shares nothing
    expect((await dm(gus.id)).status).toBe(404) // oneself
    expect((await dm('nobody')).status).toBe(404)
    // The same direct message again is the same conversation.
    const again = await dm(tessa)
    expect(again.json.conversation.id).toBe((await dm(tessa)).json.conversation.id)
    // Tessa answers in it, and Gwen cannot read it.
    const conv = again.json.conversation.id
    expect((await say(OWNER, conv, 'hello Gus')).status).toBe(201)
    expect((await a.gu(gwen.token, 'GET', `/conversations/${conv}/messages`)).status).toBe(404)
    expect((await gsay(gwen.token, conv, 'let me in')).status).toBe(404)
  })

  test('a teammate opens a direct message with any teammate, and with a guest only where they share a channel', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    await me(ANA)
    expect((await a.tm(ANA, 'POST', '/dms', { person: await me(BEN) })).status).toBe(201)
    expect((await a.tm(ANA, 'POST', '/dms', { person: gus.id })).status).toBe(404)
    expect((await a.tm(OWNER, 'POST', '/dms', { person: gus.id })).status).toBe(201)
    // Ana joins Acme (added by Tessa) and can now.
    await a.tm(OWNER, 'POST', `/channels/${acme}/members`, { person: await me(ANA) })
    expect((await a.tm(ANA, 'POST', '/dms', { person: gus.id })).status).toBe(201)
    // A direct message is one to one: it lists its two people, and no one can add a third.
    const conv = (await a.tm(ANA, 'POST', '/dms', { person: gus.id })).json.conversation
    expect(conv.members).toHaveLength(2)
    expect((await a.tm(ANA, 'POST', `/channels/${conv.id}/members`, { person: await me(BEN) })).status).toBe(400)
  })

  test('a direct message stays open to its two people after they stop sharing a channel', async () => {
    const acme = await channel(OWNER, 'Acme')
    const side = await channel(OWNER, 'Side')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    await a.tm(OWNER, 'POST', `/channels/${side}/members`, { person: gus.id })
    const conv = (await a.gu(gus.token, 'POST', '/dms', { person: await me(OWNER) })).json.conversation.id
    await a.tm(OWNER, 'POST', `/channels/${acme}/leave`)
    await a.tm(OWNER, 'POST', `/channels/${side}/leave`)
    expect((await a.gu(gus.token, 'POST', '/dms', { person: await me(OWNER) })).json.conversation.id).toBe(conv)
    expect((await gsay(gus.token, conv, 'still here?')).status).toBe(201)
  })

  test('a person who may not see a conversation is sent none of its changes, live or in catch-up', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const ana = await me(ANA)
    const since = (await boot(ANA)).seq
    h.delivered.length = 0
    await say(OWNER, acme, 'for Acme only')
    await a.gu(gus.token, 'PATCH', '/me', { nudgesOff: true })
    const messageTo = h.delivered.filter((d) => d.change.kind === 'message').flatMap((d) => d.people)
    expect(messageTo.sort()).toEqual([gus.id, await me(OWNER)].sort())
    expect(messageTo).not.toContain(ana)
    const caught = h.workspaceCore.catchUp({ via: 'socket', person: ana }, since, h.clock.now)
    expect(caught.reload).toBe(false)
    if (!caught.reload) expect(caught.changes.filter((c) => c.kind === 'message')).toEqual([])
    // Nor a direct message between two others.
    const dm = (await a.tm(OWNER, 'POST', '/dms', { person: gus.id })).json.conversation.id
    h.delivered.length = 0
    await say(OWNER, dm, 'between us')
    expect(h.delivered.flatMap((d) => d.people)).not.toContain(ana)
  })
})

describe('messages', () => {
  test('they are cleaned and limited as the in-call chat does, and the 7th in 10 seconds is refused', async () => {
    const conv = await channel(OWNER, 'Acme')
    const sent = await say(OWNER, conv, '  hi‮\u0007 there\r\n\r\n\r\n\r\nline  ')
    expect(sent.json.message.text).toBe('hi there\n\nline')
    expect((await say(OWNER, conv, '   ')).status).toBe(400)
    expect((await say(OWNER, conv, 'x'.repeat(2001))).status).toBe(400)
    expect((await say(OWNER, conv, 'x'.repeat(2000))).status).toBe(201)
    for (let i = 0; i < 4; i++) expect((await say(OWNER, conv, `m${i}`)).status).toBe(201)
    const seventh = await say(OWNER, conv, 'too many')
    expect(seventh.status).toBe(429)
    // Held up only for themselves, and only for the window.
    expect((await say(ANA, await channel(ANA, 'Ana’s'), 'fine')).status).toBe(201)
    wait()
    expect((await say(OWNER, conv, 'again')).status).toBe(201)
  })

  test('markup is stored as the text it is; the workspace never turns it into anything else', async () => {
    const conv = await channel(OWNER, 'Acme')
    const r = await say(OWNER, conv, '<img src=x onerror=alert(1)> [x](javascript:alert(1))')
    expect(r.json.message.text).toBe('<img src=x onerror=alert(1)> [x](javascript:alert(1))')
  })

  test('only the author edits, the author or the Owner deletes, and a deleted message is gone from history and catch-up', async () => {
    const open = await channel(OWNER, 'Everyone', 'open')
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    await a.tm(BEN, 'POST', `/channels/${open}/join`)
    const mine = (await say(ANA, open, 'typo')).json.message
    const theirs = (await say(BEN, open, 'ben says')).json.message
    // Edit: own only, even for the Owner; the latest text only, marked edited.
    expect((await a.tm(OWNER, 'PATCH', `/messages/${mine.id}`, { text: 'forged' })).status).toBe(403)
    const since = (await boot(OWNER)).seq
    const edited = await a.tm(ANA, 'PATCH', `/messages/${mine.id}`, { text: 'fixed' })
    expect(edited.json.message).toMatchObject({ text: 'fixed', editedAt: T0 })
    expect((await a.tm(ANA, 'PATCH', `/messages/${mine.id}`, { text: '   ' })).status).toBe(400)
    const history = (await a.tm(OWNER, 'GET', `/conversations/${open}/messages`)).json.messages
    expect(history.map((m: any) => m.text)).toEqual(['fixed', 'ben says'])
    // Delete: own, or the Owner's; nobody else's.
    expect((await a.tm(ANA, 'DELETE', `/messages/${theirs.id}`)).status).toBe(403)
    expect((await a.tm(OWNER, 'DELETE', `/messages/${theirs.id}`)).status).toBe(200)
    expect((await a.tm(ANA, 'DELETE', `/messages/${mine.id}`)).status).toBe(200)
    expect((await a.tm(OWNER, 'GET', `/conversations/${open}/messages`)).json.messages).toEqual([])
    // Gone from catch-up too: a browser behind sees a delete and no trace of the text.
    const caught = h.workspaceCore.catchUp({ via: 'access', email: OWNER }, since, h.clock.now)
    expect(JSON.stringify(caught)).not.toContain('fixed')
    expect(JSON.stringify(caught)).not.toContain('ben says')
    if (!caught.reload) expect(caught.changes.filter((c) => c.kind === 'delete')).toHaveLength(2)
    // And a message that is gone cannot be edited or deleted again.
    expect((await a.tm(ANA, 'PATCH', `/messages/${mine.id}`, { text: 'back' })).status).toBe(404)
    expect((await a.tm(OWNER, 'DELETE', `/messages/${mine.id}`)).status).toBe(404)
  })

  test('the Owner deletes another’s message only where he is in the conversation; a guest edits and deletes their own', async () => {
    const acme = await channel(ANA, 'Acme')
    const gus = await guest(ANA, acme, 'gus@client.test', 'Gus')
    const m = (await gsay(gus.token, acme, 'hello')).json.message
    expect((await a.tm(OWNER, 'DELETE', `/messages/${m.id}`)).status).toBe(404)
    expect((await a.gu(gus.token, 'PATCH', `/messages/${m.id}`, { text: 'hi' })).json.message.text).toBe('hi')
    expect((await a.tm(ANA, 'DELETE', `/messages/${m.id}`)).status).toBe(403)
    expect((await a.gu(gus.token, 'DELETE', `/messages/${m.id}`)).status).toBe(200)
  })

  test('history comes 50 messages at a time, newest first, then the page before', async () => {
    const conv = await channel(OWNER, 'Acme')
    for (let i = 1; i <= 120; i++) {
      if (i % 6 === 1) wait()
      expect((await say(OWNER, conv, `m${i}`)).status).toBe(201)
    }
    const page1 = (await a.tm(OWNER, 'GET', `/conversations/${conv}/messages`)).json
    expect(page1.more).toBe(true)
    expect(page1.messages.map((m: any) => m.text).slice(0, 2)).toEqual(['m71', 'm72'])
    expect(page1.messages).toHaveLength(50)
    const page2 = (await a.tm(OWNER, 'GET', `/conversations/${conv}/messages?before=${page1.messages[0].id}`)).json
    expect(page2.messages[0].text).toBe('m21')
    const page3 = (await a.tm(OWNER, 'GET', `/conversations/${conv}/messages?before=${page2.messages[0].id}`)).json
    expect(page3).toMatchObject({ more: false })
    expect(page3.messages).toHaveLength(20)
    expect((await a.tm(OWNER, 'GET', `/conversations/${conv}/messages?before=abc`)).status).toBe(400)
  })
})

describe('catch-up', () => {
  test('from a change number returns exactly what came after it that the person may see', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const seq = (await gboot(gus.token)).seq
    await say(OWNER, acme, 'one')
    const priv = await channel(OWNER, 'Private')
    await say(OWNER, priv, 'not for Gus')
    await gsay(gus.token, acme, 'two')
    const caught = h.workspaceCore.catchUp({ via: 'socket', person: gus.id }, seq, h.clock.now)
    expect(caught.reload).toBe(false)
    if (caught.reload) return
    const messages = caught.changes.flatMap((c) => (c.kind === 'message' ? [c.data.message.text] : []))
    expect(messages).toEqual(['one', 'two'])
    // Sequence numbers rise, and a second catch-up from the head returns nothing.
    expect(caught.changes.map((c) => c.seq)).toEqual([...caught.changes.map((c) => c.seq)].sort((x, y) => x - y))
    const none = h.workspaceCore.catchUp({ via: 'socket', person: gus.id }, caught.seq, h.clock.now)
    expect(none).toEqual({ reload: false, changes: [], seq: caught.seq })
  })

  test('a browser more than 1,000 changes behind, behind the 30 days kept, or ahead of the workspace is told to reload', async () => {
    const conv = await channel(OWNER, 'Acme')
    const start = (await boot(OWNER)).seq
    for (let i = 0; i < 1001; i++) {
      if (i % 6 === 0) wait()
      await a.tm(OWNER, 'POST', `/conversations/${conv}/read`, { upTo: 0 }) // not a change
      await say(OWNER, conv, `m${i}`).then((r) => expect(r.status).toBe(201))
    }
    const tessa = { via: 'access', email: OWNER } as const
    expect(h.workspaceCore.catchUp(tessa, start, h.clock.now)).toEqual({ reload: true })
    expect(h.workspaceCore.catchUp(tessa, start + 10_000_000, h.clock.now)).toEqual({ reload: true })
    expect(h.workspaceCore.catchUp(tessa, -1, h.clock.now)).toEqual({ reload: true })
    // Within the thousand it is a catch-up.
    const head = (await boot(OWNER)).seq
    expect(h.workspaceCore.catchUp(tessa, head - 5, h.clock.now).reload).toBe(false)
    // The feed keeps 30 days; a browser behind what was dropped reloads.
    await say(OWNER, conv, 'late')
    const old = (await boot(OWNER)).seq
    h.clock.now += CHANGES_KEEP_MS + DAY
    await say(OWNER, conv, 'newer')
    h.workspaceCore.maintain(h.clock.now)
    expect(h.workspaceCore.catchUp(tessa, 1, h.clock.now)).toEqual({ reload: true })
    expect(h.workspaceCore.catchUp(tessa, old - 1, h.clock.now).reload).toBe(true) // one change of what was dropped is missing
    expect(h.workspaceCore.catchUp(tessa, old, h.clock.now).reload).toBe(false) // holding all of it is not behind
    const fresh = (await boot(OWNER)).seq
    expect(h.workspaceCore.catchUp(tessa, fresh, h.clock.now).reload).toBe(false)
  })
})

describe('unread', () => {
  test('counts follow read positions, and reading on one device clears the count on another', async () => {
    const open = await channel(OWNER, 'Everyone', 'open')
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    await say(OWNER, open, 'one')
    await say(OWNER, open, 'two')
    const unread = async () => (await boot(ANA)).conversations.find((c: any) => c.kind !== 'phone').unread
    // What was said before she joined is not unread; what came after is.
    expect(await unread()).toBe(2)
    expect((await boot(ANA)).conversations.find((c: any) => c.id === open).lastRead).toBe(0)
    await say(ANA, open, 'her own is not unread to her')
    expect(await unread()).toBe(0) // sending reads what is before it
    await say(OWNER, open, 'three')
    await say(OWNER, open, 'four')
    expect(await unread()).toBe(2)
    h.delivered.length = 0
    const upTo = (await a.tm(ANA, 'GET', `/conversations/${open}/messages`)).json.messages.at(-1).id
    expect((await a.tm(ANA, 'POST', `/conversations/${open}/read`, { upTo })).status).toBe(200)
    expect(await unread()).toBe(0)
    // Only her devices are told: a read mark is no news to Tessa.
    const reads = h.delivered.filter((d) => d.change.kind === 'read')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.people).toEqual([await me(ANA)])
    expect(reads[0]?.change.data).toMatchObject({ conv: open, upTo, unread: 0 })
    // Never backwards, never past the newest message.
    await a.tm(ANA, 'POST', `/conversations/${open}/read`, { upTo: 1 })
    expect((await boot(ANA)).conversations.find((c: any) => c.id === open).lastRead).toBe(upTo)
    await a.tm(ANA, 'POST', `/conversations/${open}/read`, { upTo: 999_999 })
    expect((await boot(ANA)).conversations.find((c: any) => c.id === open).lastRead).toBe(upTo)
    expect((await a.tm(ANA, 'POST', `/conversations/${open}/read`, { upTo: 'x' })).status).toBe(400)
  })

  test('a guest’s new direct message counts for them and for nobody else', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const dm = (await a.tm(OWNER, 'POST', '/dms', { person: gus.id })).json.conversation.id
    await say(OWNER, dm, 'hello')
    expect((await gboot(gus.token)).conversations.find((c: any) => c.id === dm).unread).toBe(1)
    expect((await boot(OWNER)).conversations.find((c: any) => c.id === dm).unread).toBe(0)
  })
})

describe('nudges', () => {
  /** Tessa writes Gus a direct message; returns what is needed to look at the nudge. */
  async function waiting() {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const dm = (await a.tm(OWNER, 'POST', '/dms', { person: gus.id })).json.conversation.id
    await say(OWNER, dm, 'a very private sentence')
    return { acme, gus, dm }
  }
  const due = () => h.workspaceCore.dueNudges(h.clock.now, [...h.online])

  test('one is due after 15 minutes unread with no open socket, and not before', async () => {
    const { gus } = await waiting()
    h.clock.now += 14 * 60_000
    expect(due()).toEqual([])
    h.clock.now += 61_000
    expect(due()).toMatchObject([{ person: gus.id, email: 'gus@client.test', kind: 'guest', total: 1, senders: [{ name: 'Tessa', count: 1 }] }])
  })

  test('not while the person has the page open, not when it was read, not when turned off', async () => {
    const { gus, dm } = await waiting()
    h.clock.now += 16 * 60_000
    h.online.add(gus.id)
    expect(due()).toEqual([])
    h.online.delete(gus.id)
    expect(due()).toHaveLength(1)
    await a.gu(gus.token, 'PATCH', '/me', { nudgesOff: true })
    expect(due()).toEqual([])
    await a.gu(gus.token, 'PATCH', '/me', { nudgesOff: false })
    const upTo = (await a.gu(gus.token, 'GET', `/conversations/${dm}/messages`)).json.messages.at(-1).id
    await a.gu(gus.token, 'POST', `/conversations/${dm}/read`, { upTo })
    expect(due()).toEqual([])
  })

  test('never for a channel', async () => {
    const acme = await channel(OWNER, 'Acme')
    await guest(OWNER, acme, 'gus@client.test', 'Gus')
    await say(OWNER, acme, 'in the channel')
    h.clock.now += 2 * HOUR
    expect(due()).toEqual([])
  })

  test('the cron sends one email naming who wrote and how many, at most once an hour, and the email never carries the text', async () => {
    const { gus, dm } = await waiting()
    h.clock.now += 16 * 60_000
    const before = h.mail.length
    await runCron(await cronDeps(h))
    expect(h.mail).toHaveLength(before + 1)
    const m = h.mail.at(-1)!
    expect(m.to).toBe('gus@client.test')
    expect(m.subject).toBe('You have a direct message waiting on meet')
    expect(m.text).toContain('Tessa (1)')
    expect(m.text).not.toContain('private sentence')
    expect(m.text).toContain('https://space.northfield.example/w/') // a guest's own door
    // More arrives; still within the hour: nothing more is sent.
    wait()
    await say(OWNER, dm, 'and another')
    h.clock.now += 20 * 60_000
    await runCron(await cronDeps(h))
    expect(h.mail).toHaveLength(before + 1)
    // An hour after the first, what is new since then goes, naming only that: the one already told of is not told again.
    h.clock.now += 41 * 60_000
    await runCron(await cronDeps(h))
    expect(h.mail).toHaveLength(before + 2)
    expect(h.mail.at(-1)?.text).toContain('Tessa (1)')
    expect(gus.id).toBeTruthy()
  })

  test('a message that waits is told of once: one episode, one email, not one an hour for ever', async () => {
    await waiting()
    h.clock.now += 16 * 60_000
    const before = h.mail.length
    await runCron(await cronDeps(h))
    expect(h.mail).toHaveLength(before + 1)
    for (let hours = 0; hours < 72; hours++) {
      h.clock.now += HOUR
      await runCron(await cronDeps(h))
    }
    expect(h.mail).toHaveLength(before + 1)
  })

  test('nudges count against the hour’s emails, and stop short of the allowance so sign-in codes still get through', async () => {
    const { acme } = await waiting()
    h.clock.now += 16 * 60_000
    const sql = h.workspaceCore['sql']
    for (let i = 0; i < 40; i++) sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, 'x@y.test', 'code')`, h.clock.now, )
    expect(h.workspaceCore.dueNudges(h.clock.now, [])).toEqual([])
    expect(acme).toBeTruthy()
    h.clock.now += HOUR + 1
    expect(h.workspaceCore.dueNudges(h.clock.now, [])).toHaveLength(1)
    // A sent nudge is a row in the log, with the person's address.
    const person = h.workspaceCore.dueNudges(h.clock.now, [])[0]!
    h.workspaceCore.nudgeSent([person.person], h.clock.now)
    expect(sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'nudge' AND email = 'gus@client.test'`)[0]?.n).toBe(1)
  })

  test('names a person chose are kept out of subjects, and out of the body as anything that could pass for a link', async () => {
    const acme = await channel(OWNER, 'Acme')
    const sneaky = await guest(OWNER, acme, 'sneak@client.test', 'Click http://evil.test/pay now')
    const dm = (await a.gu(sneaky.token, 'POST', '/dms', { person: await me(OWNER) })).json.conversation.id
    await gsay(sneaky.token, dm, 'hello')
    h.clock.now += 16 * 60_000
    const before = h.mail.length
    await runCron(await cronDeps(h))
    const m = h.mail.slice(before).find((x) => x.to === OWNER)!
    expect(m.subject).toBe('You have a direct message waiting on meet')
    expect(m.text).toContain('Click http evil test pay now (1)')
    expect(m.text).not.toContain('http://evil')
    expect(m.text).not.toContain('evil.test')
    const invite = h.mail.find((x) => x.to === 'sneak@client.test' && /added to a channel/.test(x.subject))!
    expect(invite.subject).not.toContain('Click')
  })

  test('a guest named like a web address does not show as a link in the nudge body', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'domain@client.test', 'northfield-login.example')
    const dm = (await a.gu(gus.token, 'POST', '/dms', { person: await me(OWNER) })).json.conversation.id
    await gsay(gus.token, dm, 'hello')
    h.clock.now += 16 * 60_000
    const before = h.mail.length
    await runCron(await cronDeps(h))
    const m = h.mail.slice(before).find((x) => x.to === OWNER)!
    expect(m.text).toContain('From: northfield-login example (1)')
    expect(m.text).not.toContain('northfield-login.example')
  })

  test('look-alike dots in a name are broken too', async () => {
    const { plain } = await import('../src/mail')
    for (const dot of ['。', '．', '｡', '․', '﹒']) expect(plain(`northfield-login${dot}com`)).toBe('northfield-login com')
    expect(plain('Sam Jr.')).toBe('Sam Jr.')
  })

  test('the nudge counts new direct messages since the last one and does not claim they are all unread', async () => {
    await waiting()
    h.clock.now += 16 * 60_000
    const before = h.mail.length
    await runCron(await cronDeps(h))
    const m = h.mail.slice(before).find((x) => x.to === 'gus@client.test')!
    expect(m.text).toContain('You have 1 new direct message on meet')
    expect(m.text).not.toContain('not read')
  })

  test('a teammate’s nudge links to the space’s Conversations; a failed send is tried again on the next run', async () => {
    await me(OWNER)
    const ana = await me(ANA)
    const dm = (await a.tm(OWNER, 'POST', '/dms', { person: ana })).json.conversation.id
    await say(OWNER, dm, 'hi Ana')
    h.clock.now += 16 * 60_000
    h.mailFails.on = true
    const before = h.mail.length
    expect(await runCron(await cronDeps(h))).toEqual({ sent: 0, failed: 1 })
    h.mailFails.on = false
    expect(await runCron(await cronDeps(h))).toEqual({ sent: 1, failed: 0 })
    expect(h.mail).toHaveLength(before + 1)
    expect(h.mail.at(-1)?.to).toBe(ANA)
    expect(h.mail.at(-1)?.text).toContain('Read them at https://space.northfield.example/meet\n')
    expect(h.mail.at(-1)?.text).not.toContain('/start')
    expect(h.mail.at(-1)?.text).not.toContain('hi Ana')
  })
})

describe('removing and deleting people', () => {
  test('removing a guest keeps their messages under their name; deleting one removes them, and their name and address', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const gwen = await guest(OWNER, acme, 'gwen@client.test', 'Gwen')
    await gsay(gus.token, acme, 'gus was here')
    await gsay(gwen.token, acme, 'gwen was here')
    await say(OWNER, acme, 'tessa was here')
    // Removed: signed out everywhere, messages kept under the name.
    await a.tm(OWNER, 'POST', `/people/${gus.id}/remove`)
    expect((await a.gu(gus.token, 'GET', '/bootstrap')).status).toBe(401)
    let history = (await a.tm(OWNER, 'GET', `/conversations/${acme}/messages`)).json.messages
    expect(history.map((m: any) => [m.name, m.text])).toContainEqual(['Gus', 'gus was here'])
    expect((await boot(OWNER)).conversations[0].members).not.toContain(gus.id)
    // Deleted: every message they wrote is gone, and so is who they were. Only the Owner.
    expect((await a.tm(ANA, 'DELETE', `/people/${gwen.id}`)).status).toBe(403)
    expect((await a.gu(gwen.token, 'DELETE', `/people/${gwen.id}`)).status).toBe(403)
    expect((await a.tm(OWNER, 'DELETE', `/people/${await me(OWNER)}`)).status).toBe(404)
    expect((await a.tm(OWNER, 'DELETE', `/people/${gwen.id}`)).status).toBe(200)
    history = (await a.tm(OWNER, 'GET', `/conversations/${acme}/messages`)).json.messages
    expect(history.map((m: any) => m.text)).toEqual(['gus was here', 'tessa was here'])
    expect(JSON.stringify(h.workspaceCore.catchUp({ via: 'access', email: OWNER }, 0, h.clock.now))).not.toContain('gwen was here')
    expect((await a.gu(gwen.token, 'GET', '/bootstrap')).status).toBe(401)
    // The address can be invited afresh, as a new person.
    const again = await a.tm(OWNER, 'POST', `/channels/${acme}/invite`, { email: 'gwen@client.test', name: 'Gwen' })
    expect(again.json.person.id).not.toBe(gwen.id)
  })

  test('a direct message with a removed person takes no new message, and opening it again after they are back works', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    const dm = (await a.tm(OWNER, 'POST', '/dms', { person: gus.id })).json.conversation.id
    await say(OWNER, dm, 'before')
    await a.tm(OWNER, 'POST', `/people/${gus.id}/remove`)
    const refused = await say(OWNER, dm, 'to nobody')
    expect(refused.status).toBe(409)
    // Invited back, he can be messaged again in the same conversation, with its history.
    await a.tm(OWNER, 'POST', `/channels/${acme}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const reopened = await a.tm(OWNER, 'POST', '/dms', { person: gus.id })
    expect(reopened.json.conversation.id).toBe(dm)
    expect((await say(OWNER, dm, 'after')).status).toBe(201)
    expect((await a.tm(OWNER, 'GET', `/conversations/${dm}/messages`)).json.messages.map((m: any) => m.text)).toEqual(['before', 'after'])
  })

  test('archiving a guest’s last channel removes the guest, as taking them out of it does; one with another channel stays', async () => {
    const last = await channel(OWNER, 'Only')
    const first = await channel(OWNER, 'First')
    const second = await channel(OWNER, 'Second')
    const alone = await guest(OWNER, last, 'alone@client.test', 'Alone')
    const both = await guest(OWNER, first, 'both@client.test', 'Both')
    await a.tm(OWNER, 'POST', `/channels/${second}/members`, { person: both.id })
    await a.tm(OWNER, 'POST', `/channels/${last}/archive`)
    expect((await a.gu(alone.token, 'GET', '/bootstrap')).status).toBe(401)
    expect(h.closed.some((c) => c.person === alone.id && c.code === 4403)).toBe(true)
    await a.tm(OWNER, 'POST', `/channels/${first}/archive`)
    expect((await gboot(both.token)).conversations.map((c: any) => c.name)).toEqual(['Second'])
    await a.tm(OWNER, 'POST', `/channels/${second}/archive`)
    expect((await a.gu(both.token, 'GET', '/bootstrap')).status).toBe(401)
  })

  test('a teammate is told who invited each guest, so the inviter can remove them; a guest is told nothing of the kind', async () => {
    const open = await channel(OWNER, 'Everyone', 'open')
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    const ours = await guest(ANA, open, 'g@client.test', 'G')
    const ana = await me(ANA)
    const seen = (await boot(OWNER)).people.find((p: any) => p.id === ours.id)
    expect(seen.invitedBy).toBe(ana)
    expect((await boot(ANA)).people.find((p: any) => p.id === ours.id).invitedBy).toBe(ana)
    expect((await gboot(ours.token)).people.every((p: any) => p.invitedBy === undefined && p.email === undefined)).toBe(true)
  })

  test('a removed guest can be invited again and comes back as the same person', async () => {
    const acme = await channel(OWNER, 'Acme')
    const gus = await guest(OWNER, acme, 'gus@client.test', 'Gus')
    await a.tm(OWNER, 'POST', `/people/${gus.id}/remove`)
    const back = await a.tm(OWNER, 'POST', `/channels/${acme}/invite`, { email: 'gus@client.test', name: 'Gus' })
    expect(back.json.person.id).toBe(gus.id)
    const token = await a.signIn('gus@client.test')
    expect((await gboot(token)).conversations.map((c: any) => c.name)).toEqual(['Acme'])
  })
})

describe('storage and the socket helpers', () => {
  test('the workspace opens again over its own storage with everything in it, and migrates by adding, never rebuilding', async () => {
    const sql = memSql()
    const first = new WorkspaceCore(sql, () => installFor([OWNER]))
    const tessa = { via: 'access', email: OWNER } as const
    const { conversation } = first.createChannel(tessa, 'Acme', 'private', T0)
    first.send(tessa, conversation.id, 'kept', T0)
    const second = new WorkspaceCore(sql, () => installFor([OWNER]))
    expect(second.history(tessa, conversation.id, null, T0).messages.map((m) => m.text)).toEqual(['kept'])
    expect(second.bootstrap(tessa, T0).conversations.find((c) => c.kind !== 'phone')?.name).toBe('Acme')
  })

  test('a sign-in ends at its time, and the alarm is set for the earliest', () => {
    const at = (endsAt: number) => ({ person: 'p', session: null, endsAt, ready: true })
    expect(signInEnded(at(1000), 999)).toBe(false)
    expect(signInEnded(at(1000), 1000)).toBe(true)
    expect(nextExpiry([])).toBeNull()
    expect(nextExpiry([at(5), at(3), at(9)])).toBe(3)
  })

  test('only well-formed frames from the browser are read', () => {
    expect(parseFrame('{"t":"hello","since":12}')).toEqual({ t: 'hello', since: 12 })
    expect(parseFrame('{"t":"read","conv":3,"upTo":9}')).toEqual({ t: 'read', conv: 3, upTo: 9 })
    expect(parseFrame('{"t":"ping"}')).toEqual({ t: 'ping' })
    for (const bad of ['', 'x', '{"t":"hello"}', '{"t":"hello","since":1.5}', '{"t":"read","conv":"1","upTo":1}', '{"t":"other"}', '[]', 'null', 5, 'x'.repeat(2000)]) {
      expect(parseFrame(bad)).toBeNull()
    }
  })
})

export { G, W }

/** The pieces `runCron` needs, built from the harness the way index.ts builds them from the bindings. */
async function cronDeps(harness: H) {
  const { workspaceClient, invokeWorkspace } = await import('../src/workspace')
  return {
    now: () => harness.clock.now,
    workspace: () =>
      workspaceClient((method, args) => {
        try {
          return invokeWorkspace(harness.workspaceCore, method, method === 'dueNudges' || method === 'sweep' ? [args[0], [...harness.online]] : args)
        } finally {
          harness.workspaceCore.takeOutbox()
        }
      }),
    mailer: { send: async (m: any) => (harness.mailFails.on ? Promise.reject(new Error('refused')) : (harness.mail.push(m), { messageId: 'x' })) },
    appOrigin: 'https://space.northfield.example',
    install: harness.deps.install,
    phoneCore: harness.deps.phoneCore,
    phone: harness.deps.phone,
  } as unknown as Parameters<typeof runCron>[0]
}
