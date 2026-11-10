// Documents in a conversation, driven through the real router with stand-in apps behind the bindings. What is asserted is what a person sees: a document
// sent from a conversation is a card in that conversation and in no other, a completed one says the signed copy is back, a private answer is never on a card,
// Send for signature is filled in from the conversation's people, and forms not answering (or not yet knowing the read) leaves the history as it is.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { DocumentSummary, FormsForSpace } from '@space/workspace'
import { lane, northfield } from '../../workspace/test/helpers'
import { blocksOf } from '../src/client/convo'
import { type ConversationAnswer, type SigningFrom, addressesInUse } from '../src/conversation'
import { mergeHistory } from '../src/history'
import { standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { LANE_TEAM, NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

const doc = (id: string, title: string, state: DocumentSummary['state'], made: number, over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  title,
  state,
  createdAt: made,
  sentAt: state === 'draft' ? null : made + 60_000,
  completedAt: null,
  signers: 1,
  signed: 0,
  notSigned: [],
  ...over,
})

const DANA = { app: 'inbox', id: 'c-dana' } as const
const MARCUS = { app: 'inbox', id: 'c-marcus' } as const

async function setup(documents: DocumentSummary[], forms?: Partial<FormsForSpace> | 'none') {
  const inbox = standInInbox(
    [contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example')],
    [
      thread('t-dana', ago(100), ['c-dana'], { subject: 'Homepage copy', messages: [{ id: 'm1', at: ago(300), direction: 'out', from: 'Tessa', text: 'Here is the copy.' }, { id: 'm2', at: ago(100), direction: 'in', from: 'Dana Reyes <dana@harbor.example>', text: 'Looks right.' }] }),
      thread('t-marcus', ago(500), ['c-marcus'], { subject: 'Hello', messages: [{ id: 'm3', at: ago(500), direction: 'in', from: 'Marcus Chen <marcus@harbor.example>', text: 'Hi.' }] }),
    ],
  )
  const meet = standInMeet({ direct: [dm(12, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(50))], channels: [channel(21, 'web-team', ago(30))] }, {})
  const stand = standInForms(documents)
  const reads = forms === 'none' ? undefined : ({ ...stand, ...forms } as FormsForSpace)
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet, ...(reads && { parts: { forms: reads } }) }, undefined, { answerWithinMs: 60 })
  const jwt = await w.signIn('tessa@northfield.example')
  const open = async (key: string): Promise<ConversationAnswer> => {
    const res = await w.call(`/api/conversation?key=${encodeURIComponent(key)}`, { jwt })
    expect([key, res.status]).toEqual([key, 200])
    return (await res.json()) as ConversationAnswer
  }
  return { w, jwt, open, stand }
}

const ids = (a: ConversationAnswer): string[] => (a.documents.state === 'ok' ? a.documents.documents.map((d) => d.id) : [])

describe('a document sent from a conversation is a card there and nowhere else', () => {
  test('it shows in the conversation it carries and in no other, and a document sent from Forms to the same person is not a card', async () => {
    const s = await setup([
      doc('e-dana', 'Photo release', 'sent', ago(200), { conversation: DANA }),
      doc('e-marcus', 'Hosting renewal', 'sent', ago(200), { conversation: MARCUS }),
      doc('e-forms', 'Website agreement', 'sent', ago(200)),
    ])
    expect(ids(await s.open('dana@harbor.example'))).toEqual(['e-dana'])
    expect(ids(await s.open('marcus@harbor.example'))).toEqual(['e-marcus'])
    expect(ids(await s.open('chat:channel:21'))).toEqual([])
  })

  test('forms is asked for every ref the conversation has: the mail contact and the direct message, or the channel', async () => {
    const s = await setup([doc('e-chat', 'Chat-sent', 'sent', ago(200), { conversation: { app: 'meet', id: '12' } }), doc('e-room', 'Room-sent', 'sent', ago(200), { conversation: { app: 'meet', id: '21' } })])
    const dana = await s.open('dana@harbor.example')
    expect(ids(dana)).toEqual(['e-chat'])
    expect(s.stand.asked.in.at(-1)).toEqual([DANA, { app: 'meet', id: '12' }])
    expect(ids(await s.open('chat:channel:21'))).toEqual(['e-room'])
    expect(s.stand.asked.in.at(-1)).toEqual([{ app: 'meet', id: '21' }])
  })

  test('the card sits among the messages at the time it last moved', async () => {
    const s = await setup([doc('e-dana', 'Photo release', 'sent', ago(200), { conversation: DANA })])
    const answer = await s.open('dana@harbor.example')
    const order = blocksOf(answer, mergeHistory(answer.sources).entries).flatMap((b) => b.items.map((i) => (i.kind === 'entry' ? i.entry.message.text : i.kind)))
    // Sent 199 minutes ago: after the copy (300) and before Dana's answer (100), which is the twenty minutes of the DM between.
    expect(order.indexOf('document')).toBeGreaterThan(order.indexOf('Here is the copy.'))
    expect(order.indexOf('document')).toBeLessThan(order.indexOf('Looks right.'))
  })
})

describe('items at the same moment', () => {
  test('one tie order for the history: a message, then a call’s card, then a draft, then a document’s card', () => {
    const T = ago(5)
    const answer = {
      row: { type: 'channel', name: 'launch', privacy: 'open', memberCount: 3, conversationId: 21, key: 'chat:channel:21' },
      threads: [],
      drafts: [{ id: 'd-1', conversationId: null, subject: '', text: 'x', rev: 1, author: 'claude', stuck: false, at: T, to: 'a@x.example', toName: 'A', cc: [], through: null, sendable: true }],
      calls: [{ name: 'call-1', link: 'https://meet/x', kind: 'link', title: null, madeBy: { name: 'J', mine: true }, madeAt: T, conversationId: null, home: 'dana@x.example', startsAt: null, invitees: [], present: 0, people: 0, messages: 0, endedAt: null, openedAt: null }],
      documents: { state: 'ok', documents: [{ id: 'e-1', title: 'Doc', state: 'sent', signers: 1, signed: 0, at: T }], more: false },
    } as unknown as ConversationAnswer
    const entry = { kind: 'chat' as const, key: 'chat:21:1', at: T, message: { id: 1, conversationId: 21, authorName: 'P', mine: false, at: T, text: 'hello', edited: false } }
    const kinds = blocksOf(answer, [entry]).flatMap((b) => b.items.map((i) => i.kind))
    expect(kinds).toEqual(['entry', 'call', 'draft', 'document'])
  })
})

describe('when it completes the card shows the signed copy is back', () => {
  test('a completed document is the same card in its completed state, at the time it came back', async () => {
    const s = await setup([doc('e-dana', 'Photo release', 'completed', ago(1000), { conversation: DANA, signers: 2, signed: 2, completedAt: ago(20) })])
    const answer = await s.open('dana@harbor.example')
    expect(answer.documents).toMatchObject({ state: 'ok', documents: [{ id: 'e-dana', state: 'completed', signers: 2, signed: 2, at: ago(20) }] })
    // It comes back further down than the message it followed.
    const blocks = blocksOf(answer, mergeHistory(answer.sources).entries)
    const last = blocks.at(-1)!.items.at(-1)!
    expect(last.kind).toBe('document')
  })

  test('the history cutoff holds a card back with the messages it came after', async () => {
    const s = await setup([doc('e-old', 'Old agreement', 'completed', ago(5000), { conversation: DANA, completedAt: ago(4000) })])
    const answer = await s.open('dana@harbor.example')
    const entries = mergeHistory(answer.sources).entries
    expect(blocksOf(answer, entries, null).flatMap((b) => b.items).some((i) => i.kind === 'document')).toBe(true)
    expect(blocksOf(answer, entries, ago(2000)).flatMap((b) => b.items).some((i) => i.kind === 'document')).toBe(false)
  })
})

describe('a private answer is never on a card', () => {
  test('the page is given a title, a state, counts and a time for a document, and no name, address, link or answer', async () => {
    const s = await setup([doc('e-dana', 'Tax intake', 'sent', ago(200), { conversation: DANA, signers: 2, signed: 1, notSigned: ['Dana Reyes'] })])
    const answer = await s.open('dana@harbor.example')
    if (answer.documents.state !== 'ok') throw new Error('documents did not come')
    expect(Object.keys(answer.documents.documents[0]!).sort()).toEqual(['at', 'id', 'signed', 'signers', 'state', 'title'])
    const text = JSON.stringify(answer.documents)
    expect(text).not.toContain('Dana Reyes') // the name of one who has not signed is Today's, not a card's
    expect(text).not.toContain('notSigned')
    expect(text).not.toContain('conversation') // nor which conversation it carries: the card is in it
  })
})

describe('forms not answering leaves the history as it is', () => {
  test('forms that fails: the emails and messages are all there, with a line that documents could not be shown', async () => {
    const s = await setup([], {
      documentsIn: async () => {
        throw new Error('forms is down')
      },
    })
    const answer = await s.open('dana@harbor.example')
    expect(answer.documents).toMatchObject({ state: 'could-not-be-reached' })
    expect(mergeHistory(answer.sources).entries.map((e) => e.message.text)).toEqual(['Here is the copy.', 'Looks right.'])
  })

  test('an older forms, that does not have the read yet, is the same: a line, never an error, and the conversation opens', async () => {
    const s = await setup([], { documentsIn: undefined })
    const answer = await s.open('dana@harbor.example')
    expect(answer.documents).toMatchObject({ state: 'could-not-be-reached', message: expect.stringContaining('Forms could not be reached') })
    expect(mergeHistory(answer.sources).entries.map((e) => e.message.text)).toEqual(['Here is the copy.', 'Looks right.'])
  })

  test('no forms binding at all is the same', async () => {
    const s = await setup([], 'none')
    expect((await s.open('dana@harbor.example')).documents.state).toBe('could-not-be-reached')
  })

  test('forms that says no is a line that documents are not open to the person', async () => {
    const s = await setup([], { documentsIn: async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'no' }) })
    expect((await s.open('dana@harbor.example')).documents).toMatchObject({ state: 'not-open-to-you' })
  })

  test('forms that answers in a shape the contract does not have is not half read', async () => {
    const s = await setup([], { documentsIn: async () => ({ ok: true, value: { documents: [{ id: 'x', title: 'T', state: 'shipped' }], more: false } }) as never })
    expect((await s.open('dana@harbor.example')).documents.state).toBe('could-not-be-reached')
  })

  test('a forms that predates conversations sends summaries with no conversation field: still read', async () => {
    const s = await setup([], { documentsIn: async () => ({ ok: true, value: { documents: [doc('e-1', 'Plain', 'sent', ago(10))], more: false } }) })
    expect(ids(await s.open('dana@harbor.example'))).toEqual(['e-1'])
  })
})

describe('Send for signature is filled in from the conversation', () => {
  test('a person: their name and every address the space knows, and the conversation a new document carries', async () => {
    const s = await setup([])
    const res = await s.w.call(`/api/conversation/signers?key=${encodeURIComponent('dana@harbor.example')}`, { jwt: s.jwt })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect((await res.json()) as SigningFrom).toEqual({ key: 'dana@harbor.example', name: 'Dana Reyes', channel: false, conversation: { app: 'inbox', id: 'c-dana' }, people: [{ name: 'Dana Reyes', addresses: ['dana@harbor.example'] }] })
  })

  test('a person who moved to a new address is offered the address they write from now, not the alphabetically first', async () => {
    const inbox = standInInbox(
      [contact('c-eve', 'Eve Old', 'a-old@harbor.example', 'z-new@harbor.example')],
      [thread('t-eve', ago(10), ['c-eve'], { subject: 'Hello', messages: [{ id: 'e1', at: ago(900), direction: 'in', from: 'Eve <a-old@harbor.example>', text: 'From the old one.' }, { id: 'e2', at: ago(10), direction: 'in', from: 'Eve <Z-New@Harbor.example>', text: 'From the new one.' }] })],
    )
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }, {}) }, undefined, { answerWithinMs: 60 })
    const res = await w.call(`/api/conversation/signers?key=${encodeURIComponent('a-old@harbor.example')}`, { jwt: await w.signIn('tessa@northfield.example') })
    expect(((await res.json()) as SigningFrom).people[0]!.addresses).toEqual(['z-new@harbor.example', 'a-old@harbor.example'])
  })

  test('the address in use comes from who wrote the newest mail, or who we wrote to; with none it is the sorted list', () => {
    const row = { type: 'person', addresses: ['a@x.example', 'm@x.example', 'z@x.example'] } as never
    expect(addressesInUse(row, { direction: 'in', from: 'Eve <m@x.example>' })).toEqual(['m@x.example', 'a@x.example', 'z@x.example'])
    expect(addressesInUse(row, { direction: 'out', from: 'Tessa', to: 'Eve <z@x.example>, Bob <b@y.example>' })).toEqual(['z@x.example', 'a@x.example', 'm@x.example'])
    expect(addressesInUse(row, { direction: 'in', from: 'someone@else.example' })).toEqual(['a@x.example', 'm@x.example', 'z@x.example'])
    expect(addressesInUse(row, null)).toEqual(['a@x.example', 'm@x.example', 'z@x.example'])
  })

  test('someone with only a direct message carries meet’s conversation', async () => {
    const meet = standInMeet({ direct: [dm(31, person('p-gus', 'Gus Guest', 'gus@x.example'), ago(5))], channels: [] }, {})
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: standInInbox([], []), meet: meet }, undefined, { answerWithinMs: 60 })
    const res = await w.call(`/api/conversation/signers?key=${encodeURIComponent('gus@x.example')}`, { jwt: await w.signIn('tessa@northfield.example') })
    expect(((await res.json()) as SigningFrom).conversation).toEqual({ app: 'meet', id: '31' })
  })

  test('a channel names no one to sign, and carries the channel', async () => {
    const s = await setup([])
    const res = await s.w.call(`/api/conversation/signers?key=${encodeURIComponent('chat:channel:21')}`, { jwt: s.jwt })
    expect((await res.json()) as SigningFrom).toEqual({ key: 'chat:channel:21', name: '# web-team', channel: true, conversation: { app: 'meet', id: '21' }, people: [] })
  })

  test('no such conversation is a 404, a key that is none is a 400, and nothing is written to forms', async () => {
    const s = await setup([])
    expect((await s.w.call('/api/conversation/signers?key=nobody%40x.example', { jwt: s.jwt })).status).toBe(404)
    expect((await s.w.call('/api/conversation/signers?key=', { jwt: s.jwt })).status).toBe(400)
    expect(s.w.forwarded).toEqual([])
  })

  test('no sign-in is refused, with the cookie alone too, and nothing is asked of any app', async () => {
    const s = await setup([])
    const asked = s.stand.asked.in.length
    expect((await s.w.call('/api/conversation/signers?key=dana%40harbor.example')).status).toBe(401)
    expect((await s.w.call('/api/conversation/signers?key=dana%40harbor.example', { cookieJwt: s.jwt })).status).toBe(401)
    expect(s.stand.asked.in.length).toBe(asked)
  })

  test('a write on it is not allowed: it only reads', async () => {
    const s = await setup([])
    const res = await s.w.call('/api/conversation/signers?key=dana%40harbor.example', { method: 'POST', jwt: s.jwt, headers: { origin: 'https://space.northfield.example', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(405)
  })
})

describe('a second company', () => {
  test('reads its own documents in its own conversations, as a card, and its Send reads its own people', async () => {
    const inbox = standInInbox([contact('c-dana', 'Dana Lane', 'dana@pinecrest.test')], [thread('t-d', ago(30), ['c-dana'], { subject: 'Engagement', messages: [{ id: 'l1', at: ago(30), direction: 'in', from: 'Dana Lane <dana@pinecrest.test>', text: 'Hello.' }] })])
    const forms = standInForms([doc('e-lane', 'Engagement letter', 'completed', ago(500), { conversation: DANA, completedAt: ago(10) })])
    const w = await world(lane(), LANE_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }, {}), parts: { forms } }, undefined, { answerWithinMs: 60 })
    const jwt = await w.signIn('lane@pinecrest.test')
    const opened = (await (await w.call(`/api/conversation?key=${encodeURIComponent('dana@pinecrest.test')}`, { jwt })).json()) as ConversationAnswer
    expect(ids(opened)).toEqual(['e-lane'])
    expect(opened.documents).toMatchObject({ state: 'ok', documents: [{ title: 'Engagement letter', state: 'completed' }] })
    const signers = (await (await w.call(`/api/conversation/signers?key=${encodeURIComponent('dana@pinecrest.test')}`, { jwt })).json()) as SigningFrom
    expect(signers).toMatchObject({ conversation: DANA, people: [{ addresses: ['dana@pinecrest.test'] }] })
    // Northfield's person is nobody here, whatever Cloudflare signed.
    expect((await w.call('/api/conversation/signers?key=x', { jwt: await w.signIn('tessa@northfield.example') })).status).toBeGreaterThanOrEqual(401)
  })
})

describe('Send for signature is a conversation’s, not a call’s or the phone’s', () => {
  test('the New call and Phone screens have no such button, and only the conversation view draws it', () => {
    const src = (name: string) => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
    for (const screen of ['CallPane.tsx', 'PhonePane.tsx']) {
      expect(src(screen), screen).not.toContain('send-for-signature')
      expect(src(screen), screen).not.toContain('sendFromPath')
    }
    expect(src('Conversation.tsx')).toContain('send-for-signature')
  })
})
