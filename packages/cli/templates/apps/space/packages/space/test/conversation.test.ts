// A person's conversation, driven through the real router with stand-in apps behind the bindings. What is asserted is what a person sees (the
// history in order, who a reply goes to, what the page is told after a send) or what is refused, never the Worker's internals.
import { describe, expect, test } from 'bun:test'
import { COMPOSE_KEY, INBOX_HISTORY_PAGE, type MeetChannel, type MeetDirect } from '@space/workspace'
import { lane, northfield } from '../../workspace/test/helpers'
import { requestFor } from '../src/client/compose'
import { blocksOf, replyLine, replyTarget, replyWays } from '../src/client/convo'
import type { CloseOutcome, ReopenOutcome, ConversationAnswer, ReadOutcome, WriteOutcome } from '../src/conversation'
import { mergeHistory } from '../src/history'
import { CONFLICT_WORDS, type StandInChatMessage, type StandInContact, type StandInDraft, type StandInThread, standInInbox, standInMeet } from '../src/stand-ins'
import { LANE_TEAM, NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`

interface Setup {
  contacts?: StandInContact[]
  threads?: StandInThread[]
  drafts?: StandInDraft[]
  direct?: MeetDirect[]
  channels?: MeetChannel[]
  history?: Record<number, StandInChatMessage[]>
  writeWithinMs?: number
  /** Another company's install, and who signs in to it, for a person known by two addresses. */
  company?: 'lane'
}

async function asOwner(o: Setup = {}) {
  const inbox = standInInbox(o.contacts ?? [], o.threads ?? [], { drafts: o.drafts })
  const meet = standInMeet({ direct: o.direct ?? [], channels: o.channels ?? [] }, { history: o.history })
  const w = o.company === 'lane' ? await world(lane(), LANE_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60, writeWithinMs: o.writeWithinMs ?? 200 }) : await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60, writeWithinMs: o.writeWithinMs ?? 200 })
  const jwt = await w.signIn(o.company === 'lane' ? 'lane@pinecrest.test' : 'tessa@northfield.example')
  const open = async (k: string): Promise<ConversationAnswer> => {
    const res = await w.call(`/api/conversation?key=${encodeURIComponent(k)}`, { jwt })
    expect([k, res.status]).toEqual([k, 200])
    return (await res.json()) as ConversationAnswer
  }
  const post = (path: string, body: unknown) => w.call(path, { method: 'POST', jwt, headers: { origin: o.company === 'lane' ? 'https://space.pinecrest.test' : ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const outcome = async (path: string, body: unknown) => (await (await post(path, body)).json()) as WriteOutcome
  return { w, jwt, inbox, meet, open, post, outcome }
}

const chat = (id: number, at: number, who: string, text: string, mine = false): StandInChatMessage => ({ id, at, authorId: mine ? 'p-tessa' : `p-${who}`, authorName: who, text, mine })

const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

const harbor = (): Setup => ({
  contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example')],
  threads: [
    thread('t-shared', ago(100), ['c-dana', 'c-marcus'], {
      subject: 'Homepage copy',
      messages: [
        { id: 'm1', at: ago(300), direction: 'out', from: 'Tessa', text: 'Here is the copy.' },
        { id: 'm2', at: ago(100), direction: 'in', from: 'Dana Reyes <dana@harbor.example>', text: 'Looks right to me.' },
      ],
    }),
    thread('t-invoice', ago(500), ['c-dana'], {
      subject: 'Invoice 1042',
      direction: 'out',
      messages: [{ id: 'm0', at: ago(500), direction: 'out', from: 'Tessa', text: 'Invoice attached.' }],
    }),
  ],
  direct: [dm(11, dana, ago(10), 1, 'Can we talk Thursday?')],
  history: { 11: [chat(1, ago(200), 'Dana', 'Hello Tessa'), chat(2, ago(10), 'Dana', 'Can we talk Thursday?')] },
})

describe('a person’s history', () => {
  test('their emails and direct messages are one run by time, oldest first, each email labelled by its subject and "with" the others on a shared thread', async () => {
    const s = await asOwner(harbor())
    const answer = await s.open('dana@harbor.example')
    const merged = mergeHistory(answer.sources)
    expect(merged.entries.map((e) => [e.kind, e.message.text])).toEqual([
      ['email', 'Invoice attached.'],
      ['email', 'Here is the copy.'],
      ['chat', 'Hello Tessa'],
      ['email', 'Looks right to me.'],
      ['chat', 'Can we talk Thursday?'],
    ])
    // The headings change where the conversation moves from one place to another, and say whom a shared thread is with.
    expect(blocksOf(answer, merged.entries).map((b) => b.heading)).toEqual(['Email: Invoice 1042', 'Email: Homepage copy, with Marcus Chen', 'Direct message', 'Email: Homepage copy, with Marcus Chen', 'Direct message'])
    expect(answer.parts).toEqual([
      { part: 'mail', state: 'ok' },
      { part: 'chat', state: 'ok' },
    ])
  })

  test('the same shared thread shows under the other person on it too, with Dana named as who it is with', async () => {
    const s = await asOwner(harbor())
    const answer = await s.open('marcus@harbor.example')
    expect(blocksOf(answer, mergeHistory(answer.sources).entries).map((b) => b.heading)).toEqual(['Email: Homepage copy, with Dana Reyes'])
  })

  test('closed and Bulk conversations are in a person’s history though they are not in the list', async () => {
    const s = await asOwner({
      contacts: [contact('c-a', 'Ana', 'ana@x.example')],
      threads: [thread('t-open', ago(10), ['c-a']), thread('t-closed', ago(900), ['c-a'], { open: false, subject: 'Old matter' })],
    })
    const answer = await s.open('ana@x.example')
    expect(answer.threads.map((t) => [t.conversationId, t.open])).toEqual([
      ['t-open', true],
      ['t-closed', false],
    ])
    expect(s.inbox.asked.histories[0]!.query?.include).toEqual(['bulk', 'closed'])
  })

  test('a teammate known by two addresses is one conversation, a thread under both of their contacts shown once', async () => {
    const s = await asOwner({
      contacts: [contact('c-work', 'Priya', 'priya@northfield.example'), contact('c-gmail', 'Priya (personal)', 'priya_private@gmail.com')],
      threads: [thread('t-both', ago(30), ['c-work', 'c-gmail']), thread('t-work', ago(60), ['c-work'])],
      direct: [dm(12, person('p-priya', 'Priya Natarajan', 'priya_private@gmail.com', 'teammate'), ago(90))],
      history: { 12: [chat(5, ago(90), 'Priya', 'Hi')] },
    })
    // Tessa's declaration has Priya? Whichever address names her, the list's key is the first of her addresses.
    const list = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string; type: string }[] }
    const k = list.rows.find((r) => r.type === 'person')!.key
    const answer = await s.open(k)
    expect(answer.threads.map((t) => t.conversationId).sort()).toEqual(['t-both', 't-work'])
    const entries = mergeHistory(answer.sources).entries.filter((e) => e.kind === 'email')
    expect(entries.filter((e) => e.message.conversationId === 't-both')).toHaveLength(1)
  })

  test('a long history is paged back as the contract pages: the newest page, then the one before the oldest held', async () => {
    const many = Array.from({ length: INBOX_HISTORY_PAGE + 20 }, (_, i) => ({ id: `m${String(i).padStart(3, '0')}`, at: ago(1000 - i), direction: 'in' as const, from: 'Ana', text: `Message ${i}` }))
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(1), ['c-a'], { messages: many })] })
    const answer = await s.open('ana@x.example')
    const source = answer.sources[0]!
    expect(source.messages).toHaveLength(INBOX_HISTORY_PAGE)
    expect(source.messages[0]!.text).toBe('Message 20')
    expect(source.more).toBe(true)
    const res = await s.w.call(`/api/history?mail=c-a&before=${source.messages[0]!.id}`, { jwt: s.jwt })
    const page = (await res.json()) as { messages: { text: string }[]; more: boolean }
    expect(page.messages.map((m) => m.text)).toEqual(many.slice(0, 20).map((m) => m.text))
    expect(page.more).toBe(false)
  })

  test('chat pages back by message id the same way', async () => {
    const history = Object.fromEntries([[11, Array.from({ length: 60 }, (_, i) => chat(i + 1, ago(500 - i), 'Dana', `Hello ${i}`))]])
    const s = await asOwner({ direct: [dm(11, dana, ago(1))], history })
    const answer = await s.open('dana@harbor.example')
    const source = answer.sources[0]!
    expect(source.kind).toBe('chat')
    expect(source.messages).toHaveLength(50)
    expect(source.more).toBe(true)
    const page = (await (await s.w.call(`/api/history?chat=11&before=${source.messages[0]!.id}`, { jwt: s.jwt })).json()) as { messages: { id: number }[]; more: boolean }
    expect(page.messages.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
    expect(page.more).toBe(false)
  })

  test('a channel’s conversation is meet’s channel: its history, no email', async () => {
    const s = await asOwner({ channels: [channel(21, 'launch', ago(5), 2)], history: { 21: [chat(7, ago(30), 'Priya', 'Staging is up'), chat(8, ago(5), 'Priya', 'Click through the form')] } })
    const answer = await s.open('chat:channel:21')
    expect(answer.row.type).toBe('channel')
    expect(mergeHistory(answer.sources).entries.map((e) => e.message.text)).toEqual(['Staging is up', 'Click through the form'])
    expect(answer.threads).toEqual([])
    expect(s.inbox.asked.histories).toEqual([]) // mail is not asked about a channel
    expect(answer.profile).toEqual({ kind: 'channel', name: 'launch', privacy: 'open', memberCount: 4 })
  })

  test('an unknown key is a 404, and one that is no key at all a 400', async () => {
    const s = await asOwner(harbor())
    expect((await s.w.call('/api/conversation?key=nobody%40x.example', { jwt: s.jwt })).status).toBe(404)
    expect((await s.w.call('/api/conversation?key=chat%3Achannel%3A999', { jwt: s.jwt })).status).toBe(404)
    for (const bad of ['', 'not an address', `a${'b'.repeat(400)}@x.example`]) {
      expect([bad.slice(0, 20), (await s.w.call(`/api/conversation?key=${encodeURIComponent(bad)}`, { jwt: s.jwt })).status]).toEqual([bad.slice(0, 20), 400])
    }
    for (const bad of ['', 'mail=c-a', 'mail=c-a&chat=1&before=2', 'chat=x&before=1', 'mail=%2E%2E%2F&before=1']) {
      expect([bad, (await s.w.call(`/api/history?${bad}`, { jwt: s.jwt })).status]).toEqual([bad, 400])
    }
  })
})

describe('one part down, the other’s history shows', () => {
  test('chat that does not answer leaves the emails with a line saying so', async () => {
    const o = harbor()
    const inbox = standInInbox(o.contacts!, o.threads!)
    const meet = standInMeet({ direct: o.direct!, channels: [] }, { history: o.history })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 40 })
    const jwt = await w.signIn('tessa@northfield.example')
    // The overview answers (the row is found); meet's history of the conversation then never does.
    meet.history = () => new Promise(() => undefined)
    const answer = (await (await w.call('/api/conversation?key=dana%40harbor.example', { jwt })).json()) as ConversationAnswer
    expect(answer.parts).toEqual([
      { part: 'mail', state: 'ok' },
      { part: 'chat', state: 'could-not-be-reached', reason: 'timed-out' },
    ])
    expect(mergeHistory(answer.sources).entries.every((e) => e.kind === 'email')).toBe(true)
    expect(answer.sources.some((s) => s.kind === 'chat')).toBe(false)
  })

  test('a conversation whose part cannot be asked at all says that, and is not called missing', async () => {
    const o = harbor()
    const inbox = standInInbox(o.contacts!, o.threads!)
    inbox.people = async () => {
      throw new Error('down')
    }
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: o.direct!, channels: [] }, { history: o.history }) }, undefined, { answerWithinMs: 40 })
    const res = await w.call('/api/conversation?key=marcus%40harbor.example', { jwt: await w.signIn('tessa@northfield.example') })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('Email could not be reached just now')
  })
})

describe('the profile beside it', () => {
  test('an outsider’s is their inbox contact: name, addresses and Client', async () => {
    const s = await asOwner({ contacts: [{ ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } }], threads: [thread('t1', ago(5), ['c-dana'])] })
    expect((await s.open('dana@harbor.example')).profile).toEqual({ kind: 'outside', name: 'Dana Reyes', client: { id: 7, name: 'Harbor Dental', listed: true }, addresses: ['dana@harbor.example'], chat: false })
  })

  test('a teammate’s is the company layer’s person: the team’s name, role and the address their sign-in goes to', async () => {
    const s = await asOwner({ direct: [dm(12, priya, ago(5))], history: { 12: [chat(3, ago(5), 'Priya', 'Hello')] } })
    const list = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string; name: string }[] }
    const row = list.rows[0]!
    const answer = await s.open(row.key)
    expect(answer.profile.kind === 'team' ? [answer.profile.name, answer.profile.chat] : null).toEqual([row.name, true])
  })
})

describe('who a reply goes to, and how', () => {
  test('an outside person is answered by email, in the thread chosen; a teammate by direct message; a channel by a post', async () => {
    const s = await asOwner({ ...harbor(), direct: [dm(11, dana, ago(10)), dm(12, priya, ago(20))], channels: [channel(21, 'launch', ago(30))], history: { 11: [chat(1, ago(10), 'Dana', 'Hi')], 12: [chat(2, ago(20), 'Priya', 'Hi')], 21: [chat(3, ago(30), 'Priya', 'Hi')] } })
    const outside = await s.open('dana@harbor.example')
    expect(replyWays(outside).preferred).toBe('email')
    // The thread Tessa chooses is the one the email goes in: the invoice, not the newer shared one.
    const aim = replyTarget(outside, 'email', 't-invoice')!
    expect(aim).toEqual({ target: { via: 'email', conversationId: 't-invoice', through: 1, copyEveryone: false }, way: 'email' })
    const r1 = requestFor(aim.target, key(1), 'Thanks, Dana.')
    expect(await s.outcome(r1.url, r1.body)).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toEqual([{ key: key(1), conversationId: 't-invoice', through: 1, text: 'Thanks, Dana.' }])
    expect(s.meet.posted).toEqual([])

    const listed = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string; name: string }[] }
    const teammate = await s.open(listed.rows.find((r) => r.name.startsWith('Priya'))!.key)
    expect(replyWays(teammate).preferred).toBe('chat')
    const toPriya = replyTarget(teammate, 'chat', null)!
    const r2 = requestFor(toPriya.target, key(2), 'On my way.')
    expect(await s.outcome(r2.url, r2.body)).toEqual({ result: 'done', status: 'sent' })
    expect(s.meet.posted).toEqual([{ key: key(2), target: { conversationId: 12 }, text: 'On my way.' }])
    expect(s.inbox.sent).toHaveLength(1) // a direct message is never an email

    const launch = await s.open('chat:channel:21')
    const toChannel = replyTarget(launch, 'chat', null)!
    const r3 = requestFor(toChannel.target, key(3), 'Shipping.')
    expect(await s.outcome(r3.url, r3.body)).toEqual({ result: 'done', status: 'sent' })
    expect(s.meet.posted.at(-1)).toEqual({ key: key(3), target: { conversationId: 21 }, text: 'Shipping.' })
  })

  test('email-only people get email, and a person with only a direct message gets a direct message', async () => {
    const s = await asOwner({ contacts: [contact('c-a', 'Ana', 'ana@x.example')], threads: [thread('t1', ago(5), ['c-a'])], direct: [dm(11, dana, ago(10))], history: { 11: [chat(1, ago(10), 'Dana', 'Hi')] } })
    expect(replyWays(await s.open('ana@x.example'))).toMatchObject({ preferred: 'email', chat: null })
    const dmOnly = replyWays(await s.open('dana@harbor.example'))
    expect(dmOnly).toMatchObject({ preferred: 'chat', email: [] })
  })

  test('a person who has both is answered by email by default, with a direct message one tap away', async () => {
    const s = await asOwner(harbor())
    const ways = replyWays(await s.open('dana@harbor.example'))
    expect(ways.preferred).toBe('email')
    expect(ways.chat).toEqual({ conversationId: 11, to: 'Dana Reyes' })
    expect(ways.email.map((t) => t.conversationId)).toEqual(['t-shared', 't-invoice'])
  })

  test('a text or a note cannot be answered from the space, and the box says so', async () => {
    const s = await asOwner({ contacts: [contact('c-text', '(626) 555-0142')], threads: [thread('t-sms', ago(5), ['c-text'], { kind: 'sms' })] })
    const ways = replyWays(await s.open('mail:c-text'))
    expect(ways.preferred).toBeNull()
    expect(ways.none).toContain('cannot be answered from the space')
    expect(ways.none).not.toContain('in the inbox')
    expect(ways.none).toContain('Claude can draft a text')
  })

  test('a reply on a thread shared with others goes to all of them, and a thread of one does not ask for it', async () => {
    const s = await asOwner(harbor())
    const answer = await s.open('dana@harbor.example')
    const shared = replyTarget(answer, 'email', 't-shared')!
    expect(shared.target).toMatchObject({ via: 'email', conversationId: 't-shared', copyEveryone: true })
    const r = requestFor(shared.target, key(10), 'Thanks both.')
    expect(await s.outcome(r.url, r.body)).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toEqual([{ key: key(10), conversationId: 't-shared', through: 2, text: 'Thanks both.', copyEveryone: true }])
    // And the thread Dana is alone on is not asked to copy anyone.
    expect(replyTarget(answer, 'email', 't-invoice')!.target).toMatchObject({ copyEveryone: false })
  })
})

describe('a compose key sends at most once', () => {
  test('the same key again sends nothing new and says how the first went', async () => {
    const s = await asOwner(harbor())
    const email = { key: key(20), conversationId: 't-invoice', through: 1, text: 'Once.' }
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'done', status: 'sent' })
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(await s.outcome('/api/email', { ...email, text: 'Changed my mind.' })).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)

    const post = { key: key(21), conversationId: 11, text: 'Once, in chat.' }
    expect(await s.outcome('/api/chat', post)).toEqual({ result: 'done', status: 'sent' })
    expect(await s.outcome('/api/chat', post)).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.meet.posted).toHaveLength(1)
  })

  test('a repeat that arrives while the first still waits on Gmail is "still being sent", and sends nothing', async () => {
    const s = await asOwner(harbor())
    s.inbox.script.send.push('slow')
    const email = { key: key(22), conversationId: 't-invoice', through: 1, text: 'Slowly.' }
    const first = s.outcome('/api/email', email)
    await new Promise((r) => setTimeout(r, 5))
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'repeated', earlier: 'in-progress' })
    expect(await first).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('Gmail that never says is "sending": a success, with the key held, so a repeat says check Sent and sends nothing', async () => {
    const s = await asOwner(harbor())
    s.inbox.script.send.push('sending')
    const email = { key: key(23), conversationId: 't-invoice', through: 1, text: 'Maybe.' }
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'done', status: 'sending' })
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'repeated', earlier: 'sending' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('a send the inbox refuses is shown in its own words and can be sent again with the same key', async () => {
    const s = await asOwner(harbor())
    // Mail arrived after what Tessa read: the inbox will not let a reply go unseen.
    s.inbox.arrive('t-invoice', { id: 'm-new', at: ago(1), direction: 'in', from: 'Dana', text: 'One more thing.' })
    const email = { key: key(24), conversationId: 't-invoice', through: 1, text: 'Sorry, missed that.' }
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'refused', reason: 'conflict', message: CONFLICT_WORDS })
    expect(s.inbox.sent).toEqual([])
    // He reads it (the page reads again, and now names the thread's new position) and presses Send again: the same key sends.
    const again = await s.open('dana@harbor.example')
    const through = again.threads.find((t) => t.conversationId === 't-invoice')!.through
    expect(through).toBe(2)
    expect(await s.outcome('/api/email', { ...email, through })).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('a failure that sent nothing, and a rate limit, are also given back to be sent again with the same key', async () => {
    const s = await asOwner(harbor())
    s.inbox.script.send.push('broken')
    const email = { key: key(25), conversationId: 't-invoice', through: 1, text: 'Hello.' }
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'failed', message: 'Gmail would not take the message. Nothing was sent.' })
    expect(await s.outcome('/api/email', email)).toEqual({ result: 'done', status: 'sent' })

    s.meet.script.post.push('limit')
    const post = { key: key(26), conversationId: 11, text: 'Fast.' }
    expect(await s.outcome('/api/chat', post)).toMatchObject({ result: 'refused', reason: 'limit' })
    expect(await s.outcome('/api/chat', post)).toEqual({ result: 'done', status: 'sent' })
    expect(s.meet.posted).toHaveLength(1)
  })

  test('a send the space loses track of is "outcome unknown", asked once and never again by the space', async () => {
    const s = await asOwner(harbor())
    s.inbox.script.send.push('throw')
    const email = { key: key(27), conversationId: 't-invoice', through: 1, text: 'Did it go?' }
    const out = await s.outcome('/api/email', email)
    expect(out.result).toBe('outcome-unknown')
    expect(s.inbox.asked.sends).toHaveLength(1)

    // Nothing answers within the time a write is waited for: the same.
    s.inbox.script.send.push('hang')
    const late = await s.outcome('/api/email', { ...email, key: key(28) })
    expect(late.result).toBe('outcome-unknown')
    expect(s.inbox.asked.sends).toHaveLength(2)

    s.meet.script.post.push('throw')
    expect((await s.outcome('/api/chat', { key: key(29), conversationId: 11, text: 'Hello?' })).result).toBe('outcome-unknown')
    expect(s.meet.asked.posts).toHaveLength(1)
  })

  test('an app that is not connected sends nothing, and says so as a failure that can be tried again', async () => {
    const w = await world(northfield(), NORTHFIELD_TEAM, {}, undefined, {})
    const jwt = await w.signIn('tessa@northfield.example')
    const res = await w.call('/api/email', { method: 'POST', jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ key: key(30), conversationId: 'x', through: 0, text: 'Hi' }) })
    expect(await res.json()).toEqual({ result: 'failed', message: 'Email is not connected to the space. Nothing was sent.' })
  })
})

describe('drafts waiting on this person', () => {
  const withDraft = (): Setup => ({
    ...harbor(),
    drafts: [
      { id: 'd-1', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Thank you both. I will send the final today.', author: 'claude', at: ago(60) },
      { id: 'd-other', conversationId: null, contactId: 'c-elsewhere', subject: 'Someone else', text: 'Not Dana’s', at: ago(5) },
    ],
  })

  test('appear in place for the person and nobody else, as the inbox shows them, with the position a send names', async () => {
    const s = await asOwner(withDraft())
    const answer = await s.open('dana@harbor.example')
    expect(answer.drafts).toEqual([
      {
        id: 'd-1',
        conversationId: 't-shared',
        subject: 'Re: Homepage copy',
        text: 'Thank you both. I will send the final today.',
        rev: 1,
        author: 'claude',
        stuck: false,
        at: ago(60),
        why: '',
        editedBy: null,
        canCopyEveryone: true,
        copiesEveryone: false,
        kind: null,
        sentFrom: null,
        sendsFrom: null,
        to: 'dana@harbor.example',
        toName: 'Dana Reyes',
        cc: [],
        through: 2,
        refusal: null,
        sending: false,
        sendable: true,
      },
    ])
    // The shared thread shows the draft under Marcus too, since it is on a conversation he is on.
    expect((await s.open('marcus@harbor.example')).drafts.map((d) => d.id)).toEqual(['d-1'])
  })

  test('say which account they go out from, as the inbox names it, and nothing when it does not', async () => {
    const s = await asOwner({
      ...harbor(),
      drafts: [
        { id: 'd-from', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Final today.', at: ago(60), sendsFrom: { name: 'ashgrove', address: 'tessa@ashgrove.example' } },
        { id: 'd-none', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Older reply.', at: ago(90) },
      ],
    })
    const drafts = (await s.open('dana@harbor.example')).drafts
    expect(drafts.map((d) => [d.id, d.sendsFrom]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['d-from', { name: 'ashgrove', address: 'tessa@ashgrove.example' }],
      ['d-none', null],
    ])
  })

  test('are sent as they stand with the held-draft variant, the revision and the thread’s position, once', async () => {
    const s = await asOwner(withDraft())
    const draft = (await s.open('dana@harbor.example')).drafts[0]!
    const r = requestFor({ via: 'draft', draftId: draft.id, rev: draft.rev, through: draft.through }, key(40), '')
    expect(r.body).toEqual({ key: key(40), draftId: 'd-1', rev: 1, through: 2 })
    expect(await s.outcome(r.url, r.body)).toEqual({ result: 'done', status: 'sent' })
    expect(await s.outcome(r.url, r.body)).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toEqual([{ key: key(40), draftId: 'd-1', rev: 1, through: 2 }])
    expect((await s.open('dana@harbor.example')).drafts).toEqual([])
  })

  test('a draft that moved since it was shown is refused in the inbox’s words and can be sent again once seen', async () => {
    const s = await asOwner(withDraft())
    s.inbox.arrive('t-shared', { id: 'm-3', at: ago(2), direction: 'in', from: 'Marcus Chen', text: 'And one more.' })
    const stale = { key: key(41), draftId: 'd-1', rev: 1, through: 2 }
    expect(await s.outcome('/api/email', stale)).toEqual({ result: 'refused', reason: 'conflict', message: CONFLICT_WORDS })
    const draft = (await s.open('dana@harbor.example')).drafts[0]!
    expect(draft.through).toBe(3)
    expect(await s.outcome('/api/email', { ...stale, through: draft.through })).toEqual({ result: 'done', status: 'sent' })
  })

  test('one Gmail never confirmed is shown, never offered for sending', async () => {
    const s = await asOwner({ ...harbor(), drafts: [{ id: 'd-stuck', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re', text: 'Maybe went.', author: 'outbox', stuck: true, at: ago(9) }] })
    const [draft] = (await s.open('dana@harbor.example')).drafts
    expect([draft!.stuck, draft!.sendable]).toEqual([true, false])
  })
})

describe('opening it marks it read in both apps', () => {
  test('the answer names each unread thread at its position and the chat up to its newest message; marking them reads both', async () => {
    const o = harbor()
    o.threads![0]!.unread = true
    const s = await asOwner(o)
    const answer = await s.open('dana@harbor.example')
    expect(answer.read).toEqual({ mail: [{ conversationId: 't-shared', through: 2 }], chat: { conversationId: 11, upTo: 2 } })
    // Asking only reads: nothing is marked until the page says it has the conversation on screen.
    expect(s.inbox.asked.reads).toEqual([])
    expect(s.meet.asked.reads).toEqual([])

    const out = (await (await s.post('/api/read', answer.read)).json()) as ReadOutcome
    expect(s.inbox.asked.reads).toEqual([[{ conversationId: 't-shared', through: 2 }]])
    expect(s.meet.asked.reads).toEqual([{ conversationId: 11, upTo: 2 }])
    expect(out).toEqual({ mail: { state: 'ok', read: ['t-shared'], notRead: [] }, chat: { state: 'ok' } })

    const list = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string; unread: number }[] }
    expect(list.rows.find((r) => r.key === 'dana@harbor.example')!.unread).toBe(0)
    expect((await s.open('dana@harbor.example')).read).toEqual({ mail: [], chat: null })
  })

  test('mail that arrived after what was read is not marked, and is said to be a conflict so the page shows it first', async () => {
    const o = harbor()
    o.threads![0]!.unread = true
    const s = await asOwner(o)
    const answer = await s.open('dana@harbor.example')
    s.inbox.arrive('t-shared', { id: 'm-3', at: ago(1), direction: 'in', from: 'Marcus', text: 'Wait.' })
    const out = (await (await s.post('/api/read', answer.read)).json()) as ReadOutcome
    expect(out.mail).toMatchObject({ state: 'ok', read: [], notRead: [{ conversationId: 't-shared', reason: 'conflict' }] })
    expect(out.chat).toEqual({ state: 'ok' }) // one app’s trouble never stops the other
  })

  test('a channel is marked read in meet alone', async () => {
    const s = await asOwner({ channels: [channel(21, 'launch', ago(5), 3)], history: { 21: [chat(7, ago(5), 'Priya', 'Hello')] } })
    const answer = await s.open('chat:channel:21')
    expect(answer.read).toEqual({ mail: [], chat: { conversationId: 21, upTo: 7 } })
    await s.post('/api/read', answer.read)
    expect(s.meet.asked.reads).toEqual([{ conversationId: 21, upTo: 7 }])
    expect(s.inbox.asked.reads).toEqual([])
  })
})

describe('closing and reopening', () => {
  const rows = async (s: Awaited<ReturnType<typeof asOwner>>, view: string) => {
    const res = await s.w.call(`/api/conversations?view=${view}`, { jwt: s.jwt })
    return ((await res.json()) as { rows: { key: string }[] }).rows.map((r) => r.key)
  }
  const closeOf = async (s: Awaited<ReturnType<typeof asOwner>>, body: unknown) => (await (await s.post('/api/close', body)).json()) as CloseOutcome
  const reopenOf = async (s: Awaited<ReturnType<typeof asOwner>>, body: unknown) => (await (await s.post('/api/reopen', body)).json()) as ReopenOutcome

  test('the answer names the open email threads on screen, each at its own position; a thread already closed is for Reopen', async () => {
    const o = harbor()
    o.threads!.push(thread('t-old', ago(900), ['c-dana'], { subject: 'Old', open: false, messages: [{ id: 'o1', at: ago(900), direction: 'in', from: 'Dana', text: 'Done.' }] }))
    const s = await asOwner(o)
    const { change } = await s.open('dana@harbor.example')
    expect(change.close).toEqual([
      { conversationId: 't-shared', through: 2 },
      { conversationId: 't-invoice', through: 1 },
    ])
    expect(change.reopen).toEqual(['t-old'])
    expect(change.notShown).toBe(0)
    // Asking only reads: nothing is closed until the page presses Close.
    expect(s.inbox.asked.closes).toEqual([])
  })

  test('a row that is only chat names nothing to close, and a channel too', async () => {
    const s = await asOwner({ ...harbor(), contacts: [], threads: [], channels: [channel(21, 'launch', ago(5))], history: { 21: [chat(7, ago(5), 'Priya', 'Hello')], 11: harbor().history![11]! } })
    expect((await s.open('dana@harbor.example')).change).toEqual({ close: [], notShown: 0, reopen: [] })
    expect((await s.open('chat:channel:21')).change).toEqual({ close: [], notShown: 0, reopen: [] })
  })

  test('Close closes the threads that were drawn, the row leaves the main list and sits under Closed, and Reopen brings it back', async () => {
    const o = harbor()
    // The shared thread is listed under Marcus (he wrote last, say): closing it empties his row, though Dana is on it too.
    ;(o.threads!.find((t) => t.id === 't-shared') as { listedUnder?: string }).listedUnder = 'c-marcus'
    const s = await asOwner(o)
    // Marcus is on the shared thread only and has no direct message: closing it empties his row.
    expect(await rows(s, 'main')).toContain('marcus@harbor.example')
    const answer = await s.open('marcus@harbor.example')
    expect(answer.change.close).toEqual([{ conversationId: 't-shared', through: 2 }])
    expect(await closeOf(s, { mail: answer.change.close })).toEqual({ state: 'ok', closed: ['t-shared'], notClosed: [] })
    expect(s.inbox.asked.closes).toEqual([[{ conversationId: 't-shared', through: 2 }]])
    expect(await rows(s, 'main')).not.toContain('marcus@harbor.example')
    expect(await rows(s, 'closed')).toContain('marcus@harbor.example')

    // Opened from the Closed view, it names what to reopen.
    const closed = await s.open('marcus@harbor.example')
    expect(closed.change.close).toEqual([])
    expect(closed.change.reopen).toEqual(['t-shared'])
    expect(await reopenOf(s, { mail: closed.change.reopen })).toEqual({ state: 'ok', reopened: ['t-shared'], notReopened: [] })
    expect(await rows(s, 'main')).toContain('marcus@harbor.example')
  })

  test('a thread whose newest message came in after what was drawn is not closed, and the answer says why', async () => {
    const s = await asOwner(harbor())
    const answer = await s.open('dana@harbor.example')
    s.inbox.arrive('t-shared', { id: 'm-3', at: ago(1), direction: 'in', from: 'Marcus', text: 'Wait.' })
    const out = await closeOf(s, { mail: answer.change.close })
    // The invoice, which nothing arrived on, is closed; the shared thread is refused and stays open.
    expect(out).toEqual({ state: 'ok', closed: ['t-invoice'], notClosed: [{ conversationId: 't-shared', reason: 'conflict', message: expect.stringContaining('new message') }] })
    expect(s.inbox.threads().find((t) => t.id === 't-shared')?.open ?? true).toBe(true)
    // Read again, its new position closes it.
    expect((await s.open('dana@harbor.example')).change.close).toEqual([{ conversationId: 't-shared', through: 3 }])
  })

  test('Send and close is a send and then a close at the position the reply was written over; our own reply is no reason to refuse the close', async () => {
    const s = await asOwner(harbor())
    const { change } = await s.open('dana@harbor.example')
    const shared = change.close.find((m) => m.conversationId === 't-shared')!
    expect(await s.outcome('/api/email', { key: key(80), conversationId: 't-shared', through: shared.through, text: 'Thanks, done.' })).toEqual({ result: 'done', status: 'sent' })
    expect(await closeOf(s, { mail: [shared] })).toEqual({ state: 'ok', closed: ['t-shared'], notClosed: [] })
    expect(s.inbox.threads().find((t) => t.id === 't-shared')?.open).toBe(false)
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('an open thread that is not on screen is left open and counted, so the page can say so', async () => {
    const history = { 11: Array.from({ length: INBOX_HISTORY_PAGE + 10 }, (_, i) => chat(i + 1, ago(300 - i), 'Dana', `Hello ${i}`)) }
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t-old', ago(900), ['c-dana'], { subject: 'Quote', messages: [{ id: 'q1', at: ago(900), direction: 'in', from: 'Dana', text: 'Quote?' }] })],
      direct: [dm(11, dana, ago(1), 0)],
      history,
    })
    const { change } = await s.open('dana@harbor.example')
    expect(change).toEqual({ close: [], notShown: 1, reopen: [] })
  })

  test('the inbox’s refusal or silence is carried as the words of the part, and nothing is guessed', async () => {
    const s = await asOwner(harbor())
    expect(await closeOf(s, { mail: [{ conversationId: 'nope', through: 1 }] })).toEqual({ state: 'ok', closed: [], notClosed: [{ conversationId: 'nope', reason: 'not-found', message: 'No such conversation.' }] })
    s.inbox.closeConversations = async () => {
      throw new Error('gone')
    }
    expect(await closeOf(s, { mail: [{ conversationId: 't-shared', through: 2 }] })).toEqual({ state: 'unanswered', message: 'Email could not be reached.' })
  })
})

describe('no sign-in is refused at every new path', () => {
  const PATHS = ['/api/conversation?key=dana%40harbor.example', '/api/history?mail=c-dana&before=m1', '/api/history?chat=11&before=2', '/api/email', '/api/chat', '/api/read', '/api/close', '/api/reopen', '/api/email/files', '/api/inbox/draft-edit', '/api/inbox/spam']

  test('without a sign-in, whatever the method, nothing is asked of either app', async () => {
    const s = await asOwner(harbor())
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const path of PATHS) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await s.w.call(path, { method, ...init, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(s.inbox.asked).toEqual({ scopes: [], searches: [], askers: [], histories: [], reads: [], sends: [], closes: [], reopens: [], edits: [], spam: [], settled: [], marked: [], unmarked: [], opened: [] })
    expect(s.meet.asked).toEqual({ askers: [], histories: [], reads: [], posts: [] })
  })

  test('another company’s person is refused too, at the writes as at the reads', async () => {
    const s = await asOwner(harbor())
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const path of PATHS) {
      const res = await s.w.call(path, { method: ['/api/email', '/api/chat', '/api/read', '/api/close', '/api/reopen'].includes(path) ? 'POST' : 'GET', jwt: stranger, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })
      expect([path, res.status]).toEqual([path, 403])
    }
    expect(s.inbox.asked.sends).toEqual([])
  })

  test('a write must come from this host, as JSON, and be small: a form on another site cannot make Tessa send', async () => {
    const s = await asOwner(harbor())
    const body = JSON.stringify({ key: key(50), conversationId: 't-invoice', through: 1, text: 'Hi' })
    const call = (headers: Record<string, string>, b: string = body) => s.w.call('/api/email', { method: 'POST', jwt: s.jwt, headers, body: b })
    expect((await call({ 'content-type': 'application/json' })).status).toBe(403) // no Origin
    expect((await call({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'key=x')).status).toBe(415)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' })).status).toBe(413)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json' }, 'not json')).status).toBe(400)
    expect(s.inbox.asked.sends).toEqual([])
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json' })).status).toBe(200)
  })

  test('a body that is not a send is a 400 and asks no one; writes are POSTs on their three paths only', async () => {
    const s = await asOwner(harbor())
    for (const [path, bad] of [
      ['/api/email', {}],
      ['/api/email', { key: 'short', conversationId: 't', through: 0, text: 'x' }],
      ['/api/email', { key: key(60), conversationId: 't', through: -1, text: 'x' }],
      ['/api/email', { key: key(60), conversationId: 't', through: 0, text: '   ' }],
      ['/api/email', { key: key(60), draftId: 'd', rev: 'one', through: null }],
      ['/api/chat', { key: key(60), text: 'x' }],
      ['/api/chat', { key: key(60), conversationId: 1, personId: 'p', text: 'x' }],
      ['/api/read', { mail: 'all' }],
      ['/api/close', {}],
      ['/api/close', { mail: [] }],
      ['/api/close', { mail: [{ conversationId: 't-shared' }] }],
      ['/api/close', { mail: [{ conversationId: '../x', through: 1 }] }],
      ['/api/reopen', { mail: 'all' }],
      ['/api/reopen', { mail: [] }],
    ] as const) {
      expect([path, JSON.stringify(bad), (await s.post(path, bad)).status]).toEqual([path, JSON.stringify(bad), 400])
    }
    expect(s.inbox.asked.sends).toEqual([])
    expect(s.inbox.asked.closes).toEqual([])
    expect(s.inbox.asked.reopens).toEqual([])
    expect(s.meet.asked.posts).toEqual([])
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await s.w.call('/api/email', { method, jwt: s.jwt })).status).toBe(405)
    expect((await s.w.call('/api/other', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect((await s.w.call('/api/email', { jwt: s.jwt })).status).toBe(404) // a GET of a write’s path is not an answer
  })

  test('the inbox is handed the assertion unchanged, to check again; meet’s part is handed the person the check named', async () => {
    const s = await asOwner(harbor())
    await s.open('dana@harbor.example')
    await s.outcome('/api/email', { key: key(70), conversationId: 't-invoice', through: 1, text: 'Hi' })
    await s.outcome('/api/chat', { key: key(71), conversationId: 11, text: 'Hi' })
    for (const a of s.inbox.asked.askers) expect(a).toBe('tessa@northfield.example')
    for (const a of s.meet.asked.askers) expect(a).toBe('tessa@northfield.example')
    expect(s.inbox.asked.askers.length).toBeGreaterThan(3)
  })
})

test('a compose key made by the page is one the apps take', () => {
  expect(COMPOSE_KEY.test(key(1))).toBe(true)
})

describe('opening it marks read only what is on screen', () => {
  const msg = (id: string, at: number) => ({ id, at, direction: 'in' as const, from: 'Dana', text: `Message ${id}` })

  test('an unread email hidden behind "Earlier messages" by a page of newer direct messages is not marked read', async () => {
    const history = { 11: Array.from({ length: INBOX_HISTORY_PAGE + 10 }, (_, i) => chat(i + 1, ago(300 - i), 'Dana', `Hello ${i}`)) }
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t-old', ago(900), ['c-dana'], { subject: 'Quote', unread: true, messages: [msg('q1', ago(900))] })],
      direct: [dm(11, dana, ago(1), 3)],
      history,
    })
    const answer = await s.open('dana@harbor.example')
    // The page of chat reaches back to ago(251); the email is from ago(900), so it is behind the button: not seen.
    expect(mergeHistory(answer.sources).entries.some((e) => e.kind === 'email')).toBe(false)
    expect(answer.threads.find((t) => t.conversationId === 't-old')!.unread).toBe(true)
    expect(answer.read.mail).toEqual([])
    expect(answer.read.chat).toEqual({ conversationId: 11, upTo: INBOX_HISTORY_PAGE + 10 })
    await s.post('/api/read', answer.read)
    expect(s.inbox.asked.reads).toEqual([]) // nothing was asked of the inbox: the email is still unread in Gmail
    expect(s.inbox.threads().find((t) => t.id === 't-old')?.unread).toBe(true)
  })

  test('thirty unread Bulk threads older than the first page are not marked, and the unread thread that is on screen is', async () => {
    const bulk = Array.from({ length: 30 }, (_, i) => thread(`t-bulk${i}`, ago(5000 + i), ['c-news'], { bulk: true, unread: true, subject: `Newsletter ${i}`, messages: [msg(`b${i}`, ago(5000 + i))] }))
    const recent = Array.from({ length: INBOX_HISTORY_PAGE }, (_, i) => msg(`r${String(i).padStart(3, '0')}`, ago(1000 - i)))
    const s = await asOwner({
      contacts: [contact('c-news', 'Weekly News', 'news@lbw.example')],
      threads: [...bulk, thread('t-now', ago(1), ['c-news'], { subject: 'A real question', unread: true, messages: recent })],
    })
    const answer = await s.open('news@lbw.example')
    expect(answer.sources[0]!.messages).toHaveLength(INBOX_HISTORY_PAGE)
    expect(answer.threads.filter((t) => t.unread)).toHaveLength(31)
    expect(answer.read.mail).toEqual([{ conversationId: 't-now', through: INBOX_HISTORY_PAGE }])
    await s.post('/api/read', answer.read)
    expect(s.inbox.asked.reads).toEqual([[{ conversationId: 't-now', through: INBOX_HISTORY_PAGE }]])
    expect(s.inbox.threads().filter((t) => t.bulk && t.unread)).toHaveLength(30)
  })

  test('chat whose newest message is behind the button is not marked either', async () => {
    const many = Array.from({ length: INBOX_HISTORY_PAGE + 5 }, (_, i) => msg(`m${String(i).padStart(3, '0')}`, ago(500 - i)))
    const s = await asOwner({
      contacts: [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
      threads: [thread('t1', ago(1), ['c-dana'], { messages: many })],
      direct: [dm(11, dana, ago(2000), 1)],
      history: { 11: [chat(1, ago(2000), 'Dana', 'An old unread message')] },
    })
    const answer = await s.open('dana@harbor.example')
    expect(mergeHistory(answer.sources).entries.some((e) => e.kind === 'chat')).toBe(false)
    expect(answer.read.chat).toBeNull()
  })
})

describe('drafts in their thread, at their time', () => {
  test('a draft sits among the messages of the thread it answers, after the message it answers and before what came later', async () => {
    const o = harbor()
    o.drafts = [{ id: 'd-1', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Thank you both.', author: 'claude', at: ago(60) }]
    const s = await asOwner(o)
    const answer = await s.open('dana@harbor.example')
    const blocks = blocksOf(answer, mergeHistory(answer.sources).entries)
    const order = blocks.flatMap((b) => b.items.map((i) => (i.kind === 'entry' ? i.entry.message.text : i.kind === 'call' ? `call:${i.call.name}` : i.kind)))
    expect(order).toEqual(['Invoice attached.', 'Here is the copy.', 'Hello Tessa', 'Looks right to me.', 'draft', 'Can we talk Thursday?'])
    // It is in the same run as the message it answers, under that thread's heading, and the direct message after it has its own.
    const draftBlock = blocks.find((b) => b.items.some((i) => i.kind === 'draft'))!
    expect([draftBlock.heading, draftBlock.items.map((i) => i.kind)]).toEqual(['Email: Homepage copy, with Marcus Chen', ['entry', 'draft']])
    expect(blocks.at(-1)!.heading).toBe('Direct message')
  })

  test('a draft on no thread is a run of its own, under who it is to', async () => {
    const o = harbor()
    o.drafts = [{ id: 'd-new', conversationId: null, contactId: 'c-dana', subject: 'New idea', text: 'A new idea.', author: 'claude', at: ago(5) }]
    const s = await asOwner(o)
    const answer = await s.open('dana@harbor.example')
    expect(blocksOf(answer, mergeHistory(answer.sources).entries).at(-1)).toMatchObject({ heading: 'Draft to Dana Reyes' })
  })
})

describe('who is "also on" a thread', () => {
  // Corin is one team person known by two addresses: their work address, and the one their sign-in code goes to.
  const twoContacts = (): Setup => ({
    company: 'lane',
    contacts: [contact('c-work', 'Corin', 'corin@pinecrest.test'), contact('c-gmail', 'Corin (personal)', 'corin.private@example.com')],
    threads: [
      thread('t-older', ago(300), ['c-work', 'c-gmail'], { subject: 'Payroll' }),
      thread('t-newer', ago(20), ['c-gmail'], { subject: 'Offsite' }),
      thread('t-closed-newest', ago(5), ['c-work'], { subject: 'Done matter', open: false }),
    ],
  })

  test('the row’s own contacts are not named on each other’s threads: no "Reply all to Corin and Corin", nobody copied', async () => {
    const s = await asOwner(twoContacts())
    const list = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string }[] }
    const answer = await s.open(list.rows[0]!.key)
    expect(answer.threads.find((t) => t.conversationId === 't-older')!.alsoOn).toEqual([])
    const aim = replyTarget(answer, 'email', 't-older')!
    expect(aim.target).toMatchObject({ via: 'email', conversationId: 't-older', copyEveryone: false })
    expect(replyLine('Corin', answer.threads.find((t) => t.conversationId === 't-older')!)).toEqual({ all: false, text: 'Email to Corin' })
  })

  test('the default thread to reply in is the newest open one, and a closed thread, however new, comes after the open ones', async () => {
    const s = await asOwner(twoContacts())
    const list = (await (await s.w.call('/api/conversations', { jwt: s.jwt })).json()) as { rows: { key: string }[] }
    const answer = await s.open(list.rows[0]!.key)
    expect(replyWays(answer).email.map((t) => t.conversationId)).toEqual(['t-newer', 't-older', 't-closed-newest'])
    expect(replyTarget(answer, 'email', null)!.target).toMatchObject({ conversationId: 't-newer' })
  })
})

describe('a direct message to someone meet lists with nothing said yet', () => {
  const colleague = person('p-dana-lane', 'Dana', 'dana@pinecrest.test', 'teammate')

  test('a teammate who only emails is written to by personId, once, and meet opens the direct message as it posts', async () => {
    const s = await asOwner({
      company: 'lane',
      contacts: [contact('c-dana', 'Dana', 'dana@pinecrest.test')],
      threads: [thread('t-d', ago(40), ['c-dana'], { subject: 'Payroll' })],
      direct: [dm(12, colleague, null)],
    })
    const answer = await s.open('dana@pinecrest.test')
    expect(answer.row.type === 'person' ? [answer.row.side, answer.row.chat] : 'x').toEqual(['team', null])
    expect(answer.chatPerson).toEqual({ personId: 'p-dana-lane', name: 'Dana' })
    const ways = replyWays(answer)
    expect(ways.preferred).toBe('chat') // a teammate is answered by direct message
    expect(ways.chat).toEqual({ personId: 'p-dana-lane', to: 'Dana' })
    const aim = replyTarget(answer, 'chat', null)!
    expect(aim).toEqual({ target: { via: 'chat', personId: 'p-dana-lane' }, way: 'chat' })
    const r = requestFor(aim.target, key(80), 'Quick question about payroll.')
    expect(r.body).toEqual({ key: key(80), personId: 'p-dana-lane', text: 'Quick question about payroll.' })
    expect(await s.outcome(r.url, r.body)).toEqual({ result: 'done', status: 'sent' })
    expect(await s.outcome(r.url, r.body)).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.meet.posted).toEqual([{ key: key(80), target: { personId: 'p-dana-lane' }, text: 'Quick question about payroll.' }])
    expect(s.inbox.sent).toEqual([])
  })

  test('an address meet holds in the case it was typed is still the person: the direct message is offered', async () => {
    const s = await asOwner({
      company: 'lane',
      contacts: [contact('c-dana', 'Dana', 'dana@pinecrest.test')],
      threads: [thread('t-d', ago(40), ['c-dana'])],
      direct: [dm(12, person('p-dana-lane', 'Dana', 'Dana@Pinecrest.Test', 'teammate'), null)],
    })
    const answer = await s.open('dana@pinecrest.test')
    expect(answer.chatPerson).toEqual({ personId: 'p-dana-lane', name: 'Dana' })
    expect(replyWays(answer).chat).toEqual({ personId: 'p-dana-lane', to: 'Dana' })
  })

  test('a channel guest who emails is answered by email, with a direct message to them one tap away by personId', async () => {
    const s = await asOwner({
      contacts: [contact('c-g', 'Gus Guest', 'gus@harbor.example')],
      threads: [thread('t-g', ago(40), ['c-g'])],
      direct: [dm(14, person('p-gus', 'Gus Guest', 'gus@harbor.example'), null)],
    })
    const ways = replyWays(await s.open('gus@harbor.example'))
    expect(ways.preferred).toBe('email')
    expect(ways.chat).toEqual({ personId: 'p-gus', to: 'Gus Guest' })
  })

  test('someone with no direct message in meet at all offers none: the space cannot name a person meet has not listed', async () => {
    const s = await asOwner({ company: 'lane', contacts: [contact('c-dana', 'Dana', 'dana@pinecrest.test')], threads: [thread('t-d', ago(40), ['c-dana'])] })
    const answer = await s.open('dana@pinecrest.test')
    expect(answer.chatPerson).toBeNull()
    expect(replyWays(answer)).toMatchObject({ preferred: 'email', chat: null })
  })
})

describe('a body is read with a cap', () => {
  test('a chunked body with no Content-Length that runs past the cap is a 413, read no further and asking no one', async () => {
    const s = await asOwner(harbor())
    const chunk = new TextEncoder().encode('x'.repeat(100_000))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await s.w.call('/api/email', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body, duplex: 'half' } as never)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(10) // stopped reading near the cap, not at the end
    expect(s.inbox.asked.sends).toEqual([])
  })
})
