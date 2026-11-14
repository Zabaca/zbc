// The Conversations list, driven through the real router with stand-in apps behind the bindings. What is asserted is what a person
// sees in the list (the rows, their order and counts, the notice) or what is refused, never the merge's internals.
import { beforeEach, describe, expect, test } from 'bun:test'
import { type MeetChannel, type MeetDirect, SNIPPET_CHARS } from '@space/workspace'
import { T0, lane, northfield } from '../../workspace/test/helpers'
import type { ConversationsAnswer, ListedPerson } from '../src/conversations'
import { type StandInContact, type StandInThread, standInInbox, standInMeet } from '../src/stand-ins'
import { RIDGEWAY, LANE_TEAM, NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

async function asOwner(opts: { contacts?: StandInContact[]; threads?: StandInThread[]; direct?: MeetDirect[]; channels?: MeetChannel[]; inboxDelayMs?: number; meetDelayMs?: number } = {}, within = 60) {
  const inbox = standInInbox(opts.contacts ?? [], opts.threads ?? [], { delayMs: opts.inboxDelayMs })
  const meet = standInMeet({ direct: opts.direct ?? [], channels: opts.channels ?? [] }, { delayMs: opts.meetDelayMs })
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: within })
  const jwt = await w.signIn('tessa@northfield.example')
  const list = async (query = ''): Promise<ConversationsAnswer> => {
    const res = await w.call(`/api/conversations${query}`, { jwt })
    expect(res.status).toBe(200)
    return (await res.json()) as ConversationsAnswer
  }
  return { w, jwt, inbox, meet, list }
}

const people = (a: ConversationsAnswer) => a.rows.filter((r): r is ListedPerson => r.type === 'person')
const names = (a: ConversationsAnswer) => a.rows.map((r) => r.name)

describe('one row per person', () => {
  test('a person with two email threads and a direct message is one row, at the time of the newest of the three', async () => {
    const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t1', ago(300), ['c-dana']), thread('t2', ago(90), ['c-dana'])],
      direct: [dm(11, dana, ago(5), 0, 'Can we talk Thursday?')],
    })
    const answer = await s.list()
    expect(answer.rows).toHaveLength(1)
    const row = people(answer)[0]!
    expect(row.name).toBe('Dana Reyes')
    expect(row.at).toBe(ago(5))
    expect(row.came).toBe('chat')
    expect(row.text).toBe('Can we talk Thursday?')
    expect(row.addresses).toEqual(['dana@harbor.example'])
    expect(row.key).toBe('dana@harbor.example')
    expect(row.side).toBe('outside')
    // Both of what the row is made of are still there for the conversation opened from it.
    expect(row.mail.map((m) => m.contactId)).toEqual(['c-dana'])
    expect(row.chat?.conversationId).toBe(11)
  })

  test('the newest item names how it came: an email newer than the chat makes the row an email', async () => {
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t1', ago(2), ['c-dana'], { subject: 'Hours on the homepage' })],
      direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(60))],
    })
    const row = people(await s.list())[0]!
    expect([row.came, row.at, row.mail[0]!.newest.subject]).toEqual(['email', ago(2), 'Hours on the homepage'])
  })

  test('the join is by lowercase address: "Dana@Harbor.Example" on one side and "dana@harbor.example" on the other are one person', async () => {
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana', 'Dana@Harbor.Example')],
      threads: [thread('t1', ago(30), ['c-dana'])],
      direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(10))],
    })
    // The apps spell an address their own way on the way out (normalizeAddress); the space joins what they answer.
    expect((await s.list()).rows).toHaveLength(1)
  })

  test('rows are newest first, people and channels together, and a person or channel with nothing said has no row', async () => {
    const s = await asOwner({
      contacts: [contact('c-a', 'Ana', 'ana@x.example'), contact('c-b', 'Ben', 'ben@x.example')],
      threads: [thread('t-a', ago(50), ['c-a']), thread('t-b', ago(10), ['c-b'])],
      direct: [dm(11, person('p-p', 'Priya', 'priya@northfield.example', 'teammate'), ago(30)), dm(12, person('p-q', 'Quiet', 'quiet@northfield.example', 'teammate'), null)],
      channels: [channel(21, 'launch', ago(20)), channel(22, 'empty', null)],
    })
    expect(names(await s.list())).toEqual(['Ben', 'launch', 'Priya', 'Ana'])
  })

  test('a contact with no email address (a text) is a row of its own, named by its contact id', async () => {
    const s = await asOwner({ contacts: [contact('c-text', '(626) 555-0142')], threads: [thread('t1', ago(5), ['c-text'], { kind: 'sms' })] })
    const row = people(await s.list())[0]!
    expect([row.key, row.addresses, row.came]).toEqual(['mail:c-text', [], 'sms'])
  })

  test('a teammate is joined on BOTH their addresses: the inbox knows them by one and meet by the other, and the row is one', async () => {
    const inbox = standInInbox(
      [contact('c-work', 'Corin', 'corin@pinecrest.test'), contact('c-gmail', 'Corin (personal)', 'corin.private@example.com')],
      [thread('t-work', ago(40), ['c-work']), thread('t-gmail', ago(20), ['c-gmail'], { unread: true })],
    )
    // Meet knows a teammate by the address their sign-in code goes to.
    const meet = standInMeet({ direct: [dm(11, person('p-corin', 'Corin', 'corin.private@example.com', 'teammate'), ago(90), 1)], channels: [] })
    const w = await world(lane(), LANE_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60 })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('lane@pinecrest.test') })).json()) as ConversationsAnswer
    expect(answer.rows).toHaveLength(1)
    const row = people(answer)[0]!
    expect(row.name).toBe('Corin') // the team's name for a teammate
    expect(row.side).toBe('team')
    expect(row.addresses).toEqual(['corin.private@example.com', 'corin@pinecrest.test'])
    expect(row.mail.map((m) => m.contactId).sort()).toEqual(['c-gmail', 'c-work'])
    expect(row.unread).toBe(2) // the personal thread, and the one direct message
  })
})

describe('unread', () => {
  test('is the sum of the email conversations that are unread and the chat messages not yet read, and the row keeps both parts', async () => {
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t1', ago(300), ['c-dana'], { unread: true }), thread('t2', ago(90), ['c-dana'], { unread: true }), thread('t3', ago(80), ['c-dana'])],
      direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(5), 3)],
    })
    const row = people(await s.list())[0]!
    expect(row.unread).toBe(5)
    expect([row.mail[0]!.unread, row.chat!.unread]).toEqual([2, 3])
  })

  test('a channel carries meet’s own count', async () => {
    const s = await asOwner({ channels: [channel(21, 'launch', ago(5), 4)] })
    expect((await s.list()).rows[0]!.unread).toBe(4)
  })

  test('an unread thread that two contacts of one teammate are both on counts once', async () => {
    const inbox = standInInbox(
      [contact('c-work', 'Corin', 'corin@pinecrest.test'), contact('c-gmail', 'Corin (personal)', 'corin.private@example.com')],
      [thread('t-both', ago(5), ['c-work', 'c-gmail'], { unread: true })],
    )
    const w = await world(lane(), LANE_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60 })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('lane@pinecrest.test') })).json()) as ConversationsAnswer
    expect(answer.rows).toHaveLength(1)
    expect(answer.rows[0]!.unread).toBe(1)
  })
})

describe('Bulk and Closed sit behind filters, and a business mailbox is a filter that narrows the list', () => {
  const contacts = [
    contact('c-ana', 'Ana', 'ana@x.example'),
    contact('c-news', 'Local Business Weekly', 'news@lbw.example'),
    contact('c-old', 'Grace', 'grace@law.example'),
    contact('c-lead', 'Tomas', 'tomas@mail.example'),
  ]
  const threads = [
    thread('t-ana', ago(10), ['c-ana']),
    thread('t-news', ago(5), ['c-news'], { bulk: true, unread: true }),
    thread('t-old', ago(7), ['c-old'], { open: false }),
    thread('t-lead', ago(3), ['c-lead'], { mailbox: RIDGEWAY, unread: true }),
  ]
  let s: Awaited<ReturnType<typeof asOwner>>
  beforeEach(async () => {
    s = await asOwner({ contacts, threads, direct: [dm(11, person('p-pri', 'Priya', 'priya@northfield.example', 'teammate'), ago(20))] })
  })

  test('the main list holds every open mail that is not Bulk, a business mailbox’s customers beside everyone else’s, and chat; neither Bulk nor Closed', async () => {
    expect(names(await s.list())).toEqual(['Tomas', 'Ana', 'Priya'])
  })

  test('a person whose newest mail came to a business mailbox says which, and one on Tessa’s own mail does not', async () => {
    const rows = people(await s.list())
    expect(rows.map((r) => [r.name, r.mailbox])).toEqual([['Tomas', 'Ridgeway Cycles'], ['Ana', null], ['Priya', null]])
  })

  test('a person with mail in Gmail and in a business mailbox is one row in the main list, and the mailbox filter narrows to the mailbox’s own mail', async () => {
    const both = await asOwner({
      contacts: [contact('c-t', 'Tomas', 'tomas@mail.example')],
      threads: [thread('t-own', ago(50), ['c-t'], { unread: true }), thread('t-box', ago(10), ['c-t'], { mailbox: RIDGEWAY, unread: true })],
    })
    const all = people(await both.list())
    expect(all).toHaveLength(1)
    expect([all[0]!.unread, all[0]!.at, all[0]!.mailbox]).toEqual([2, ago(10), 'Ridgeway Cycles'])
    const narrowed = people(await both.list('?view=mailbox&mailbox=ridgeway'))
    expect(narrowed).toHaveLength(1)
    expect([narrowed[0]!.unread, narrowed[0]!.at]).toEqual([1, ago(10)])
  })

  test('each filter holds its own and asks the inbox for what it needs', async () => {
    expect(names(await s.list('?view=bulk'))).toEqual(['Local Business Weekly'])
    expect(names(await s.list('?view=closed'))).toEqual(['Grace'])
    const mailbox = await s.list('?view=mailbox&mailbox=ridgeway')
    expect(names(mailbox)).toEqual(['Tomas'])
    // A mailbox is narrowed by the inbox, before it cuts the list to a screen, so the inbox is asked for it by name.
    expect(s.inbox.asked.scopes).toEqual([{ include: ['bulk'] }, { include: ['closed'] }, { mailbox: 'ridgeway' }])
  })

  test('Sent is the conversations Tessa sent in, open or closed, Bulk or not, each as of his newest send ("You:"), ordered by it; it asks the inbox for its sent scope', async () => {
    const mine = (id: string, at: number, text: string) => ({ id, at, direction: 'out' as const, from: 'Tessa', text })
    const theirs = (id: string, at: number, text: string) => ({ id, at, direction: 'in' as const, from: 'Ana', text })
    const sent = await asOwner({
      contacts: [contact('c-ana', 'Ana', 'ana@x.example'), contact('c-old', 'Grace', 'grace@law.example'), contact('c-quiet', 'Quin', 'quin@x.example')],
      threads: [
        // Ana wrote again after Tessa's answer: the row is still his answer, at his send time.
        thread('t-ana', ago(5), ['c-ana'], { messages: [theirs('a1', ago(20), 'A question'), mine('a2', ago(10), 'My answer'), theirs('a3', ago(5), 'Thanks')] }),
        thread('t-old', ago(30), ['c-old'], { open: false, messages: [mine('o1', ago(30), 'Filed in the spring')] }),
        thread('t-quiet', ago(2), ['c-quiet'], { messages: [theirs('q1', ago(2), 'Only wrote')] }),
      ],
    })
    const answer = await sent.list('?view=sent')
    expect(names(answer)).toEqual(['Ana', 'Grace'])
    expect(people(answer).map((r) => [r.at, r.text, r.lastBy])).toEqual([[ago(10), 'My answer', 'you'], [ago(30), 'Filed in the spring', 'you']])
    expect(sent.inbox.asked.scopes).toEqual([{ sent: true }])
  })

  test('a filter is mail only: it does not ask meet, and shows no direct message or channel', async () => {
    const before = s.meet.asked.askers.length
    const answer = await s.list('?view=bulk')
    expect(answer.parts.map((p) => p.part)).toEqual(['mail'])
    expect(s.meet.asked.askers.length).toBe(before)
  })

  test('the mailboxes seen are the filters, with their unread counts, whichever view was asked', async () => {
    for (const q of ['', '?view=bulk', '?view=closed']) {
      expect((await s.list(q)).mailboxes).toEqual([{ ...RIDGEWAY, unread: 1 }])
    }
  })

  test('an unknown view, or a mailbox with no name, is a 400 and asks nobody', async () => {
    const asked = s.inbox.asked.scopes.length
    for (const q of ['?view=everything', '?view=mailbox', '?view=main&mailbox=ridgeway', '?view=mailbox&mailbox=../x']) {
      const res = await s.w.call(`/api/conversations${q}`, { jwt: s.jwt })
      expect([q, res.status]).toEqual([q, 400])
    }
    expect(s.inbox.asked.scopes.length).toBe(asked)
  })
})

describe('a thread with several people on it is listed once', () => {
  const world = () => ({
    contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'), contact('c-lena', 'Lena', 'lena@bakery.example')],
    threads: [thread('t-shared', ago(10), ['c-dana', 'c-marcus']), thread('t-alone', ago(20), ['c-lena'])],
  })

  test('a shared thread is one row, under the person the inbox listed it under, naming who else is on it, and a private thread names no one', async () => {
    const s = await asOwner(world())
    const rows = people(await s.list())
    expect(rows.map((r) => [r.name, r.at, r.sharedWith])).toEqual([
      ['Dana Reyes', ago(10), ['Marcus Chen']],
      ['Lena', ago(20), []],
    ])
  })

  test('which person it is listed under is the inbox’s word, and the other has no row for it', async () => {
    const o = world()
    o.threads[0] = thread('t-shared', ago(10), ['c-dana', 'c-marcus'], { listedUnder: 'c-marcus' })
    const rows = people(await (await asOwner(o)).list())
    expect(rows.map((r) => [r.name, r.sharedWith])).toEqual([
      ['Marcus Chen', ['Dana Reyes']],
      ['Lena', []],
    ])
  })

  test('a Client’s list places the thread among the Client’s people: the outsider has the Inbox row, the Client’s person the Client row', async () => {
    const o = world()
    o.contacts[0] = { ...o.contacts[0]!, client: { id: 7, name: 'Harbor Dental' } }
    o.threads[0] = thread('t-shared', ago(10), ['c-dana', 'c-marcus'], { listedUnder: 'c-marcus' })
    const s = await asOwner(o)
    expect(people(await s.list()).map((r) => r.name)).toEqual(['Marcus Chen', 'Lena'])
    const inClient = people(await s.list('?view=client&client=7')).filter((r) => r.clients.some((c) => c.id === 7))
    expect(inClient.map((r) => [r.name, r.sharedWith])).toEqual([['Dana Reyes', ['Marcus Chen']]])
  })

  test('the signed-in person is never listed as someone else on their own thread', async () => {
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-tessa', 'Tessa', 'tessa@northfield.example')],
      threads: [thread('t1', ago(10), ['c-dana', 'c-tessa'])],
    })
    const dana = people(await s.list()).find((r) => r.name === 'Dana Reyes')!
    expect(dana.sharedWith).toEqual([])
  })
})

describe('one part down, the other shows', () => {
  const full = {
    contacts: [contact('c-ana', 'Ana', 'ana@x.example')],
    threads: [thread('t-ana', ago(10), ['c-ana'])],
    direct: [dm(11, person('p-pri', 'Priya', 'priya@northfield.example', 'teammate'), ago(20))],
    channels: [channel(21, 'launch', ago(5))],
  }

  test('with both answering, both parts are ok', async () => {
    const s = await asOwner(full)
    const answer = await s.list()
    expect(answer.parts.map((p) => [p.part, p.state])).toEqual([['mail', 'ok'], ['chat', 'ok']])
    expect(names(answer)).toEqual(['launch', 'Ana', 'Priya'])
  })

  test('an inbox that does not answer in time leaves meet’s rows, and says email took too long', async () => {
    const s = await asOwner({ ...full, inboxDelayMs: 500 }, 40)
    const t0 = Date.now()
    const answer = await s.list()
    expect(Date.now() - t0).toBeLessThan(400) // it did not wait for the slow part
    expect(names(answer)).toEqual(['launch', 'Priya'])
    expect(answer.parts).toEqual([
      { part: 'mail', state: 'could-not-be-reached', reason: 'timed-out' },
      { part: 'chat', state: 'ok' },
    ])
  })

  test('a meet that does not answer in time leaves the inbox’s rows', async () => {
    const s = await asOwner({ ...full, meetDelayMs: 500 }, 40)
    const answer = await s.list()
    expect(names(answer)).toEqual(['Ana'])
    expect(answer.parts).toEqual([
      { part: 'mail', state: 'ok' },
      { part: 'chat', state: 'could-not-be-reached', reason: 'timed-out' },
    ])
  })

  test('a binding that throws is unreachable, and its message is not passed on', async () => {
    const inbox = standInInbox([], [])
    inbox.people = async () => {
      throw new Error('secret internals of the inbox')
    }
    const meet = standInMeet({ direct: full.direct, channels: [] })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet })
    const body = await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).text()
    expect(body).not.toContain('secret internals')
    const answer = JSON.parse(body) as ConversationsAnswer
    expect(names(answer)).toEqual(['Priya'])
    expect(answer.parts[0]).toEqual({ part: 'mail', state: 'could-not-be-reached', reason: 'unreachable' })
  })

  test('a part that is not bound at all is unreachable too', async () => {
    const meet = standInMeet({ direct: full.direct, channels: [] })
    const w = await world(northfield(), NORTHFIELD_TEAM, { meet: meet })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).json()) as ConversationsAnswer
    expect(names(answer)).toEqual(['Priya'])
    expect(answer.parts[0]).toMatchObject({ part: 'mail', state: 'could-not-be-reached', reason: 'unreachable' })
  })

  test('an answer that is not the contract’s shape is not half read: that part is not-understood and the other shows', async () => {
    const inbox = standInInbox([], [])
    inbox.people = (async () => ({ ok: true, value: { people: [{ contactId: 'c1' }], more: false } })) as never
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: full.direct, channels: [] }) })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).json()) as ConversationsAnswer
    expect(names(answer)).toEqual(['Priya'])
    expect(answer.parts[0]).toMatchObject({ part: 'mail', state: 'could-not-be-reached', reason: 'not-understood' })
  })

  test('a refusal is a different thing from a part that could not be reached, and carries the app’s words', async () => {
    const inbox = standInInbox([], [])
    inbox.people = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: full.direct, channels: [] }) })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).json()) as ConversationsAnswer
    expect(names(answer)).toEqual(['Priya'])
    expect(answer.parts[0]).toEqual({ part: 'mail', state: 'not-open-to-you', refusal: { ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' } })
  })

  test('an app’s own fault (broken) is "could not be reached" with its reason, not a refusal', async () => {
    const meet = standInMeet({ direct: [], channels: [] })
    meet.conversations = async () => ({ ok: false, kind: 'failed', reason: 'broken', message: 'Chat could not answer.' })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: standInInbox(full.contacts, full.threads), meet: meet })
    const answer = (await (await w.call('/api/conversations', { jwt: await w.signIn('tessa@northfield.example') })).json()) as ConversationsAnswer
    expect(names(answer)).toEqual(['Ana'])
    expect(answer.parts[1]).toEqual({ part: 'chat', state: 'could-not-be-reached', reason: 'broken' })
  })
})

describe('the assertion the space received is what the apps are given', () => {
  test('both apps are handed the very header the request carried, and the cookie is never what is forwarded', async () => {
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(1), ['c-a'])], direct: [] })
    await s.list()
    expect(s.inbox.asked.askers).toEqual(['tessa@northfield.example'])
    expect(s.meet.asked.askers).toEqual(['tessa@northfield.example'])
  })
})

describe('search', () => {
  test('is the inbox’s, and the results are by source: email hits, and chat said to be not searchable yet', async () => {
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t1', ago(10), ['c-dana'], { subject: 'Spring promotion', snippet: 'Hours for the promotion' }), thread('t2', ago(5), ['c-dana'], { subject: 'Invoice' })],
    })
    const res = await s.w.call('/api/search?q=promotion', { jwt: s.jwt })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { query: string; mail: { status: { state: string }; hits: { conversationId: string; people: string[]; subject: string }[] }; chat: { searchable: boolean } }
    expect(body.query).toBe('promotion')
    expect(body.mail.status.state).toBe('ok')
    expect(body.mail.hits.map((h) => [h.conversationId, h.subject, h.people])).toEqual([['t1', 'Spring promotion', ['Dana Reyes']]])
    expect(body.chat).toEqual({ searchable: false })
    expect(s.inbox.asked.searches).toEqual(['promotion'])
    expect(s.inbox.asked.askers).toEqual(['tessa@northfield.example'])
  })

  test('an inbox that cannot be reached is said so beside the results, not turned into "no results"', async () => {
    const s = await asOwner({}, 30)
    s.inbox.search = () => new Promise(() => undefined)
    const body = (await (await s.w.call('/api/search?q=anything', { jwt: s.jwt })).json()) as { mail: { status: unknown; hits: unknown[] } }
    expect(body.mail.status).toEqual({ part: 'mail', state: 'could-not-be-reached', reason: 'timed-out' })
    expect(body.mail.hits).toEqual([])
  })

  test('an empty or enormous search is a 400 and asks nobody', async () => {
    const s = await asOwner()
    for (const q of ['', '%20%20', 'x'.repeat(201)]) {
      const res = await s.w.call(`/api/search?q=${q}`, { jwt: s.jwt })
      expect([q.slice(0, 5), res.status]).toEqual([q.slice(0, 5), 400])
    }
    expect(s.inbox.asked.searches).toEqual([])
  })
})

describe('a snippet stays within the contract’s length', () => {
  test('the stand-ins keep what the apps send; the row carries it whole', async () => {
    const text = 'x'.repeat(SNIPPET_CHARS)
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(1), ['c-a'], { snippet: text })] })
    expect(people(await s.list())[0]!.text).toHaveLength(SNIPPET_CHARS)
  })
})

describe('no sign-in is refused at every new path, and nobody behind them is asked', () => {
  const NEW_PATHS = ['/api/conversations', '/api/conversations?view=bulk', '/api/conversations?view=closed', '/api/conversations?view=mailbox&mailbox=ridgeway', '/api/search?q=dana', '/api/live']

  test('with no assertion, with only the Access cookie, and with an assertion for another application', async () => {
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(1), ['c-a'])], direct: [dm(11, person('p', 'Priya', 'priya@northfield.example', 'teammate'), ago(1))] })
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const path of NEW_PATHS) {
      for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
        const res = await s.w.call(path, init)
        expect([path, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, Object.keys(init)[0] ?? 'none', 401])
      }
    }
    expect(s.inbox.asked).toEqual({ scopes: [], searches: [], askers: [], histories: [], reads: [], sends: [], closes: [], reopens: [], edits: [], spam: [], settled: [], marked: [], unmarked: [], opened: [] })
    expect(s.meet.asked.askers).toEqual([])
    expect(s.meet.forwarded).toEqual([])
  })

  test('a person of another install is refused (403) and nobody is asked', async () => {
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(1), ['c-a'])] })
    const stranger = await s.w.signIn('someone@elsewhere.example')
    for (const path of NEW_PATHS) {
      const res = await s.w.call(path, { jwt: stranger })
      expect([path, res.status]).toEqual([path, 403])
    }
    expect(s.inbox.asked.scopes).toEqual([])
    expect(s.meet.forwarded).toEqual([])
  })

  test('the fixtures need the dev switch on localhost: SPACE_FIXTURES alone on a real address changes nothing', async () => {
    const s = await asOwner()
    const w = await world(northfield(), NORTHFIELD_TEAM, { SPACE_FIXTURES: '1', ALLOW_UNAUTHENTICATED: '1' })
    const res = await w.call('/api/conversations', {})
    expect(res.status).toBe(401) // the bypass is localhost only, and so are the fixtures
    void s
  })
})
