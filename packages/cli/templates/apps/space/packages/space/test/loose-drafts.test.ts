// Drafts that sit on no conversation (a first email to a new address, a first LinkedIn message to a new contact), through the real router with a stand-in inbox behind the binding: the Drafts view lists
// them, `/api/draft` opens one by its id (the address other tools' links name), and each action on one (Send as it stands, Edit, Mark sent) goes by the rules a draft in a conversation
// has. What is asserted is what a person sees or what is refused: the list, the card, what a link becomes once the draft is sent or marked sent, no sign-in refused, the owner alone, a compose key
// that sends once, a revision that is named.
import { describe, expect, test } from 'bun:test'
import { conversationKey, draftIdAt, draftPath } from '../src/client/route'
import { lane, northfield } from '../../workspace/test/helpers'
import type { ConversationsAnswer } from '../src/conversations'
import type { LooseDraft } from '../src/drafts'
import type { WriteOutcome } from '../src/conversation'
import { type StandInDraft, standInInbox, standInMeet } from '../src/stand-ins'
import type { ViewAnswer } from '../src/views'
import type { ConversationAnswer } from '../src/conversation'
import { LANE_TEAM, NORTHFIELD_TEAM, ago, contact, dm, person, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`

const first: StandInDraft = { id: 'd-first', conversationId: null, contactId: 'c-new', subject: 'Websites for caterers', text: 'Hello Nadia, a short note.', author: 'claude', kind: 'email', at: ago(30), why: 'A first email.' }
const linkedin: StandInDraft = { id: 'd-linkedin', conversationId: null, contactId: 'c-grace', subject: '', text: 'Hello Grace.', author: 'claude', kind: 'manual', to: '@graceokafor', at: ago(60) }
const reply: StandInDraft = { id: 'd-reply', conversationId: 't-a', contactId: 'c-a', subject: 'Re', text: 'A reply.', author: 'claude', kind: 'email', at: ago(10) }

async function asOwner(drafts: StandInDraft[] = [first, linkedin, reply]) {
  const inbox = standInInbox(
    [contact('c-a', 'Ana Park', 'ana@x.example'), contact('c-new', 'Nadia Hussain', 'nadia@catering.example'), { id: 'c-grace', name: 'Grace Okafor', addresses: [] }],
    [thread('t-a', ago(20), ['c-a'], { subject: 'Hello' })],
    { drafts, now: () => ago(0) },
  )
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60, writeWithinMs: 200 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = (path: string) => w.call(path, { jwt })
  const post = (path: string, body: unknown) => w.call(path, { method: 'POST', jwt, headers: JSON_POST, body: JSON.stringify(body) })
  const opened = async (id: string) => {
    const res = await get(`/api/draft?id=${encodeURIComponent(id)}`)
    return { status: res.status, body: (await res.json()) as { state?: string; draft?: LooseDraft; key?: string; error?: string } }
  }
  const outcome = async (body: unknown) => (await (await post('/api/email', body)).json()) as WriteOutcome
  const write = async <T = unknown>(name: string, body: unknown) => (await (await post(`/api/inbox/${name}`, body)).json()) as ViewAnswer<T>
  return { w, jwt, inbox, get, post, opened, outcome, write }
}

describe('the Drafts view lists the drafts that sit on no conversation', () => {
  test('they come above the rows, newest first, with who they are to, the words and whether they can be sent here; a draft on a conversation is not among them', async () => {
    const s = await asOwner()
    const answer = (await (await s.get('/api/conversations?view=drafts')).json()) as ConversationsAnswer
    expect(answer.looseDrafts.map((d) => d.id)).toEqual(['d-first', 'd-linkedin'])
    expect(answer.looseDrafts[0]).toMatchObject({ id: 'd-first', conversationId: null, contactId: 'c-new', toName: 'Nadia Hussain', to: 'nadia@catering.example', subject: 'Websites for caterers', rev: 1, kind: 'email', cc: [], through: null, sendable: true })
    // A text or a LinkedIn message is never sent from here: Mark sent is its action.
    expect(answer.looseDrafts[1]).toMatchObject({ id: 'd-linkedin', kind: 'manual', to: '@graceokafor', sendable: false })
    // The person with a draft on a conversation is still a row, with the draft counted on it.
    expect(answer.rows.map((r) => r.key)).toEqual(['ana@x.example'])
  })

  test('every other view has none', async () => {
    const s = await asOwner()
    for (const view of ['main', 'bulk', 'closed']) {
      const answer = (await (await s.get(`/api/conversations?view=${view}`)).json()) as ConversationsAnswer
      expect([view, answer.looseDrafts]).toEqual([view, []])
    }
  })

  test('a draft that cannot be read is said in the mail part, and the rows that could be read still come', async () => {
    const s = await asOwner()
    s.inbox.drafts = async () => ({ ok: false, kind: 'failed', reason: 'broken', message: 'The inbox could not answer.' })
    const answer = (await (await s.get('/api/conversations?view=drafts')).json()) as ConversationsAnswer
    expect(answer.looseDrafts).toEqual([])
    expect(answer.parts.find((p) => p.part === 'mail')?.state).toBe('could-not-be-reached')
    expect(answer.rows.length).toBeGreaterThan(0)
  })
})

describe('the Drafts view lists every conversation that holds a draft, whatever its age or state', () => {
  // The inbox answers a screen of the newest conversations (here 3), as the real one does at QUEUE_PAGE. The three older threads each hold a draft, and the two oldest are past that screen.
  async function crowded() {
    const contacts = [contact('c-new1', 'Newer One', 'n1@x.example'), contact('c-new2', 'Newer Two', 'n2@x.example'), contact('c-old', 'Old Open', 'old@x.example'), contact('c-shut', 'Old Closed', 'shut@x.example'), contact('c-bulk', 'Old Bulk', 'bulk@x.example'), contact('c-none', 'Ancient', 'none@x.example')]
    const threads = [
      thread('t-new1', ago(5), ['c-new1']),
      thread('t-new2', ago(6), ['c-new2']),
      thread('t-old', ago(60 * 24 * 3), ['c-old']),
      thread('t-shut', ago(60 * 24 * 40), ['c-shut'], { open: false }),
      thread('t-bulk', ago(60 * 24 * 50), ['c-bulk'], { bulk: true }),
      thread('t-none', ago(60 * 24 * 60), ['c-none']),
    ]
    const drafts: StandInDraft[] = ['old', 'shut', 'bulk'].map((n, i) => ({ id: `d-${n}`, conversationId: `t-${n}`, contactId: `c-${n}`, subject: 'Re', text: `A reply to ${n}.`, author: 'claude', kind: 'email', at: ago(i + 1) }))
    const inbox = standInInbox(contacts, threads, { drafts, page: 3, now: () => ago(0) })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60 })
    const jwt = await w.signIn('tessa@northfield.example')
    const list = async (view: string) => (await (await w.call(`/api/conversations?scope=mail&view=${view}`, { jwt })).json()) as ConversationsAnswer
    return { list }
  }

  test('a draft on a conversation past the newest screen is a row, open, closed or Bulk alike, and the "newest only" notice is not raised when nothing was cut', async () => {
    const s = await crowded()
    const answer = await s.list('drafts')
    expect(answer.rows.map((r) => r.name).sort()).toEqual(['Old Bulk', 'Old Closed', 'Old Open'])
    expect(answer.more).toBe(false)
  })

  test('the other views are still cut at the newest screen and say so', async () => {
    const s = await crowded()
    const answer = await s.list('main')
    expect(answer.rows.map((r) => r.name).sort()).toEqual(['Newer One', 'Newer Two', 'Old Open'])
    expect(answer.more).toBe(true)
  })
})

describe('a draft by its address', () => {
  test('a draft on no conversation is the card itself, as the list has it', async () => {
    const s = await asOwner()
    const listed = ((await (await s.get('/api/conversations?view=drafts')).json()) as ConversationsAnswer).looseDrafts[0]
    const got = await s.opened('d-first')
    expect(got.status).toBe(200)
    expect(got.body).toEqual({ state: 'draft', draft: listed as LooseDraft })
  })

  test('a draft on a conversation opens that person’s conversation', async () => {
    const s = await asOwner()
    expect(await s.opened('d-reply')).toEqual({ status: 200, body: { state: 'conversation', key: 'mail:c-a' } })
  })

  test('once it is sent, the same address opens the conversation it made; so does a LinkedIn message marked sent', async () => {
    const s = await asOwner()
    expect(await s.outcome({ key: key(1), draftId: 'd-first', rev: 1, through: null })).toEqual({ result: 'done', status: 'sent' })
    expect(await s.opened('d-first')).toEqual({ status: 200, body: { state: 'conversation', key: 'mail:c-new' } })
    expect((await s.write('draft-sent', { draftId: 'd-linkedin' })).result).toBe('ok')
    expect(await s.opened('d-linkedin')).toEqual({ status: 200, body: { state: 'conversation', key: 'mail:c-grace' } })
  })

  test('the conversation it names opens: a person with an address is found by their contact id, whatever their row is keyed by', async () => {
    const s = await asOwner()
    expect(await s.outcome({ key: key(9), draftId: 'd-first', rev: 1, through: null })).toEqual({ result: 'done', status: 'sent' })
    for (const [contact, row] of [['c-new', 'nadia@catering.example'], ['c-a', 'ana@x.example']] as const) {
      const res = await s.get(`/api/conversation?key=${encodeURIComponent(`mail:${contact}`)}`)
      expect([contact, res.status]).toEqual([contact, 200])
      expect(((await res.json()) as { key: string }).key).toBe(row)
    }
  })

  test('a contact’s key asks the inbox for that contact by id, so a person older than the newest screenful of conversations is found', async () => {
    const s = await asOwner()
    await s.get(`/api/conversation?key=${encodeURIComponent('mail:c-a')}`)
    expect(s.inbox.asked.scopes).toEqual([{ include: ['bulk', 'closed'], contactIds: ['c-a'] }])
  })

  test('a person reached by their contact id who also has a direct message in meet opens with both, as they do by their address', async () => {
    const inbox = standInInbox([contact('c-a', 'Ana Park', 'ana@x.example')], [thread('t-a', ago(20), ['c-a'], { subject: 'Hello' })], { drafts: [], now: () => ago(0) })
    const meet = standInMeet({ direct: [dm(11, person('p-ana', 'Ana Park', 'ana@x.example'), ago(5), 1, 'Are you there?')], channels: [] }, { history: { 11: [{ id: 1, at: ago(5), authorId: 'p-ana', authorName: 'Ana', text: 'Are you there?', mine: false }] } })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60, writeWithinMs: 200 })
    const jwt = await w.signIn('tessa@northfield.example')
    for (const key of ['mail:c-a', 'ana@x.example']) {
      const res = await w.call(`/api/conversation?key=${encodeURIComponent(key)}`, { jwt })
      expect([key, res.status]).toEqual([key, 200])
      const answer = (await res.json()) as ConversationAnswer
      expect([key, answer.key, answer.sources.map((src) => src.kind).sort()]).toEqual([key, 'ana@x.example', ['chat', 'mail']])
    }
  })

  test('a draft that is gone, or never was one, is a 404 in words; an id that is not an id is a 400 and asks no one', async () => {
    const s = await asOwner()
    const gone = await s.opened('d-nothing')
    expect(gone.status).toBe(404)
    expect(gone.body.error).toBe('That draft is gone: it was deleted, it never was one, or it was sent from Gmail and the email itself, in the person’s conversation, is now the record.')
    const asked = s.inbox.asked.opened.length
    for (const id of ['../x', 'a/b', '', 'x'.repeat(65), 'a b']) expect([id, (await s.get(`/api/draft?id=${encodeURIComponent(id)}`)).status]).toEqual([id, 400])
    expect((await s.get('/api/draft')).status).toBe(400)
    expect(s.inbox.asked.opened.length).toBe(asked)
  })

  test('a person who is not signed in is refused with a 401 and the inbox is not asked; another company’s person is refused', async () => {
    const s = await asOwner()
    expect((await s.w.call('/api/draft?id=d-first')).status).toBe(401)
    const forms = await s.w.signInForms('tessa@northfield.example')
    expect((await s.w.call('/api/draft?id=d-first', { jwt: forms })).status).toBe(401)
    expect((await s.w.call('/api/draft?id=d-first', { cookieJwt: s.jwt })).status).toBe(401)
    const stranger = await s.w.signIn('lane@pinecrest.test')
    expect((await s.w.call('/api/draft?id=d-first', { jwt: stranger })).status).toBe(403)
    expect(s.inbox.asked.opened).toEqual([])
  })

  test('the inbox is asked with the person the space named, and when it refuses the person (not the owner) the answer is a 403', async () => {
    const s = await asOwner()
    await s.opened('d-first')
    expect(s.inbox.asked.askers[0]).toBe('tessa@northfield.example')
    s.inbox.draftAt = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    const refused = await s.opened('d-first')
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.body)).not.toContain('Hello Nadia')
  })

  test('an inbox that cannot be reached is a 503, not a draft that looks gone', async () => {
    const s = await asOwner()
    s.inbox.draftAt = async () => {
      throw new Error('lost the connection')
    }
    expect((await s.opened('d-first')).status).toBe(503)
  })
})

describe('the actions on a draft on no conversation', () => {
  test('Send as it stands names no position, goes to its address once, and the same key again sends nothing new', async () => {
    const s = await asOwner()
    const send = { key: key(2), draftId: 'd-first', rev: 1, through: null }
    expect(await s.outcome(send)).toEqual({ result: 'done', status: 'sent' })
    expect(await s.outcome(send)).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toEqual([send])
    expect(s.inbox.reached).toEqual([{ draftId: 'd-first', to: 'nadia@catering.example', cc: [] }])
  })

  test('Send names the revision shown: a draft changed since is refused, nothing goes, and the new revision sends under the same key', async () => {
    const s = await asOwner()
    const edited = await s.write<{ rev: number }>('draft-edit', { draftId: 'd-first', rev: 1, text: 'A shorter note.' })
    expect(edited.result).toBe('ok')
    expect(await s.outcome({ key: key(3), draftId: 'd-first', rev: 1, through: null })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(s.inbox.sent).toEqual([])
    expect(await s.outcome({ key: key(3), draftId: 'd-first', rev: 2, through: null })).toEqual({ result: 'done', status: 'sent' })
  })

  test('Edit saves the words at the revision shown and the card shows them; a stale revision is refused in the inbox’s words and changes nothing', async () => {
    const s = await asOwner()
    const done = await s.write<{ text: string; rev: number }>('draft-edit', { draftId: 'd-first', rev: 1, subject: 'Hello Nadia', text: 'New words.' })
    expect(done).toMatchObject({ result: 'ok', value: { text: 'New words.', rev: 2 } })
    const card = (await s.opened('d-first')).body.draft
    expect(card).toMatchObject({ subject: 'Hello Nadia', text: 'New words.', rev: 2, editedBy: 'owner' })
    expect(await s.write('draft-edit', { draftId: 'd-first', rev: 1, text: 'Stale.' })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect((await s.opened('d-first')).body.draft).toMatchObject({ text: 'New words.', rev: 2 })
  })

  test('Mark sent files a LinkedIn message once; an email is refused in the inbox’s words and stays a draft', async () => {
    const s = await asOwner()
    expect(await s.write('draft-sent', { draftId: 'd-first' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('An email is sent with Send') })
    expect((await s.opened('d-first')).body.state).toBe('draft')
    expect((await s.write('draft-sent', { draftId: 'd-linkedin' })).result).toBe('ok')
    expect(await s.write('draft-sent', { draftId: 'd-linkedin' })).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(s.inbox.asked.marked).toEqual(['d-first', 'd-linkedin', 'd-linkedin'])
  })

  test('without a sign-in none of the three is done, and the inbox is not asked', async () => {
    const s = await asOwner()
    for (const [path, body] of [
      ['/api/email', { key: key(4), draftId: 'd-first', rev: 1, through: null }],
      ['/api/inbox/draft-edit', { draftId: 'd-first', rev: 1, text: 'x' }],
      ['/api/inbox/draft-sent', { draftId: 'd-linkedin' }],
    ] as const) {
      expect([path, (await s.w.call(path, { method: 'POST', headers: JSON_POST, body: JSON.stringify(body) })).status]).toEqual([path, 401])
    }
    expect(s.inbox.sent).toEqual([])
    expect(s.inbox.asked.edits).toEqual([])
    expect(s.inbox.asked.marked).toEqual([])
  })

  test('another company’s person cannot reach the draft, send it or edit it', async () => {
    const inbox = standInInbox([contact('c-new', 'Nadia', 'nadia@catering.example')], [], { drafts: [first], now: () => ago(0) })
    const w = await world(lane(), LANE_TEAM, { inbox: inbox }, undefined, { answerWithinMs: 60, writeWithinMs: 200 })
    const stranger = await w.signIn('someone@northfield.example')
    expect((await w.call('/api/draft?id=d-first', { jwt: stranger })).status).toBe(403)
    expect((await w.call('/api/email', { method: 'POST', jwt: stranger, headers: { origin: 'https://space.pinecrest.test', 'content-type': 'application/json' }, body: JSON.stringify({ key: key(5), draftId: 'd-first', rev: 1, through: null }) })).status).toBe(403)
    expect(inbox.sent).toEqual([])
    expect(inbox.asked.askers).toEqual([])
  })
})

describe('the address', () => {
  test('a draft’s id is the second segment after /inbox/draft/, and it is no conversation’s key', () => {
    expect(draftPath('d-first')).toBe('/inbox/draft/d-first')
    expect(draftIdAt('/inbox/draft/d-first')).toBe('d-first')
    expect(draftIdAt('/inbox/draft/d-first/')).toBe('d-first')
    expect(draftIdAt(draftPath('a b'))).toBe('a b')
    expect(conversationKey('/inbox/draft/d-first', 'mail')).toBeNull()
    // A person whose key is the word "draft" is still one segment, and not a draft.
    expect(conversationKey('/inbox/draft', 'mail')).toBe('draft')
    for (const path of ['/inbox', '/inbox/draft', '/inbox/draft/', '/inbox/draft/a/b', '/inbox/ana%40x.example', '/inbox/draft/%E0%A4%A', '/people/draft/x']) expect([path, draftIdAt(path)]).toEqual([path, null])
  })
})
