// The five things only the inbox's own page still did, through the real router with a stand-in inbox behind the binding: a search result that opens in the
// space, a send Gmail never confirmed settled, a text or a direct message marked sent by hand and taken back, a contact renamed, an address split off one. What is asserted is what a person sees
// or what is refused, never the Worker's internals: every write goes through the space's one POST guard (this host's Origin, JSON, small, its own name), no sign-in is refused at every new path,
// the assertion the space received is the one it hands on, a body that is not what the write takes asks no one, the inbox's own words for each refusal come through, a write is never retried,
// and what never appears (a person's own address as the key of a hit, the words of a message in an answer that has no use for them) does not.
import { describe, expect, test } from 'bun:test'
import { OWNER_SIGNED_IN } from './signed-in'
import { northfield } from '../../workspace/test/helpers'
import { standInInbox, standInMeet, type StandInDraft } from '../src/stand-ins'
import { hitKey } from '../src/list'
import { WRITE_NAMES, type ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, ago, contact, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }
const NEW_NAMES = ['resolve-send', 'draft-sent', 'draft-unsent', 'contact-rename', 'contact-split'] as const

const stuckDraft: StandInDraft = { id: 'd-stuck', conversationId: 't-a', contactId: 'c-a', subject: 'Re', text: 'The secret figure is 4,100.', author: 'outbox', stuck: true, kind: 'email', at: ago(9) }
const textDraft: StandInDraft = { id: 'd-text', conversationId: null, contactId: 'c-text', subject: '', text: 'Running late.', author: 'claude', kind: 'sms', to: '+16265550142', at: ago(8) }
const mailDraft: StandInDraft = { id: 'd-mail', conversationId: 't-a', contactId: 'c-a', subject: 'Re', text: 'A reply.', author: 'claude', kind: 'email', at: ago(7) }

async function asOwner(options: { drafts?: StandInDraft[]; writeWithinMs?: number } = {}) {
  const inbox = standInInbox(
    [contact('c-a', 'Ana Park', 'ana@x.example', 'ana@home.example'), contact('c-b', 'Bo Lin', 'bo@x.example'), { id: 'c-text', name: '(626) 555-0142', addresses: [] }],
    [thread('t-a', ago(30), ['c-a']), thread('t-b', ago(40), ['c-b'], { subject: 'Quote for the shop', snippet: 'The secret figure is 4,100.' }), thread('t-text', ago(50), ['c-text'], { kind: 'sms', subject: '', snippet: 'On my way' })],
    { drafts: options.drafts ?? [stuckDraft, textDraft, mailDraft], now: () => ago(0) },
  )
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60, writeWithinMs: options.writeWithinMs ?? 200 })
  const jwt = await w.signIn('tessa@northfield.example')
  const post = (path: string, body: unknown, headers: Record<string, string> = JSON_POST) => w.call(path, { method: 'POST', jwt, headers, body: JSON.stringify(body) })
  const write = async <T = unknown>(name: string, body: unknown): Promise<ViewAnswer<T>> => {
    const res = await post(`/api/inbox/${name}`, body)
    expect([name, res.status]).toEqual([name, 200])
    return (await res.json()) as ViewAnswer<T>
  }
  const contactOf = async (id: string) => {
    const got = await inbox.contact(OWNER_SIGNED_IN, id)
    if (!got.ok) throw new Error('no contact')
    return got.value
  }
  return { w, jwt, inbox, post, write, contactOf }
}

describe('every new write goes through the space’s one POST guard', () => {
  test('the five names are writes of the list, and nothing but a POST of their own name reaches them', async () => {
    const s = await asOwner()
    for (const name of NEW_NAMES) expect(WRITE_NAMES).toContain(name)
    for (const name of NEW_NAMES) {
      expect([name, (await s.w.call(`/api/inbox/${name}`, { jwt: s.jwt })).status]).toEqual([name, 404]) // a write name cannot be read
      for (const method of ['PUT', 'DELETE', 'PATCH']) expect([name, method, (await s.w.call(`/api/inbox/${name}`, { method, jwt: s.jwt, headers: JSON_POST, body: '{}' })).status]).toEqual([name, method, 405])
    }
    expect(s.inbox.asked.settled).toEqual([])
    expect(s.inbox.asked.marked).toEqual([])
  })

  test('from this host, as JSON, small and a JSON object: a form on another site cannot settle a send or split a person', async () => {
    const s = await asOwner()
    const body = JSON.stringify({ draftId: 'd-stuck', sent: true })
    const call = (headers: Record<string, string>, b: string = body) => s.w.call('/api/inbox/resolve-send', { method: 'POST', jwt: s.jwt, headers, body: b })
    expect((await call({ 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'draftId=d-stuck&sent=true')).status).toBe(415)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' })).status).toBe(413)
    expect((await call(JSON_POST, 'not json')).status).toBe(400)
    expect((await call(JSON_POST, '[1]')).status).toBe(400)
    expect(s.inbox.asked.settled).toEqual([])
  })

  test('another company’s person is refused at each new write, and nothing is asked of the inbox', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const name of NEW_NAMES) expect([name, (await s.w.call(`/api/inbox/${name}`, { method: 'POST', jwt: stranger, headers: JSON_POST, body: '{}' })).status]).toEqual([name, 403])
    expect(s.inbox.asked.askers).toEqual([])
  })

  test('without a sign-in, whatever the method, every new write is a 401 and the inbox is not asked', async () => {
    const s = await asOwner()
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const name of NEW_NAMES) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await s.w.call(`/api/inbox/${name}`, { method, ...init, headers: JSON_POST, body: method === 'POST' ? '{}' : undefined })
          expect([name, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([name, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(s.inbox.asked.askers).toEqual([])
    expect(s.inbox.views.calls).toEqual([])
  })

  test('a body that is not what the write takes is a 400 and asks no one', async () => {
    const s = await asOwner()
    const bad: [string, unknown][] = [
      ['resolve-send', {}],
      ['resolve-send', { draftId: 'd-stuck' }],
      ['resolve-send', { draftId: 'd-stuck', sent: 'yes' }],
      ['resolve-send', { draftId: '../x', sent: true }],
      ['resolve-send', { draftId: 7, sent: true }],
      ['draft-sent', {}],
      ['draft-sent', { draftId: '../etc' }],
      ['draft-unsent', {}],
      ['draft-unsent', { messageId: 7 }],
      ['contact-rename', { contactId: 'c-a', name: 'X' }],
      ['contact-rename', { contactId: 'c-a', rev: -1, name: 'X' }],
      ['contact-rename', { contactId: 'c-a', rev: 0, name: 7 }],
      ['contact-rename', { contactId: '../x', rev: 0, name: 'X' }],
      ['contact-split', { contactId: 'c-a', rev: 0 }],
      ['contact-split', { contactId: 'c-a', identityId: 'c-a-i1' }],
      ['contact-split', { contactId: 'c-a', rev: 1.5, identityId: 'c-a-i1' }],
      ['contact-split', { contactId: 'c-a', rev: 0, identityId: '../x' }],
    ]
    for (const [name, body] of bad) {
      const res = await s.post(`/api/inbox/${name}`, body)
      expect([name, JSON.stringify(body), res.status]).toEqual([name, JSON.stringify(body), 400])
    }
    expect(s.inbox.views.calls).toEqual([])
    expect(s.inbox.asked.askers).toEqual([])
  })

  test('the person the space named is the one it hands on, to each write', async () => {
    const s = await asOwner()
    await s.write('resolve-send', { draftId: 'd-stuck', sent: false })
    await s.write('draft-sent', { draftId: 'd-text' })
    await s.write('draft-unsent', { messageId: 'd-text' })
    await s.write('contact-rename', { contactId: 'c-b', rev: 0, name: 'Bo L.' })
    await s.write('contact-split', { contactId: 'c-a', rev: 0, identityId: 'c-a-i1' })
    const handed = [...s.inbox.asked.askers, ...s.inbox.views.calls.map((c) => c.asker)]
    expect(handed).toHaveLength(5)
    expect(new Set(handed.map((a) => (typeof a === 'string' ? a : a?.person.address))).size).toBe(1)
    expect(typeof handed[0] === 'string' ? handed[0] : handed[0]?.person.address).toBe('tessa@northfield.example')
  })
})

describe('settling a send Gmail never confirmed', () => {
  test('it went out: the answer says removed, and the draft is no longer one', async () => {
    const s = await asOwner()
    expect(await s.write('resolve-send', { draftId: 'd-stuck', sent: true })).toEqual({ result: 'ok', value: { id: 'd-stuck', status: 'removed' } })
    expect(s.inbox.asked.settled).toEqual([{ draftId: 'd-stuck', sent: true }])
    const left = await s.inbox.drafts(OWNER_SIGNED_IN)
    expect(left.ok && left.value.map((d) => d.id)).toEqual(['d-text', 'd-mail'])
  })

  test('it did not: it is a draft again, no longer stuck', async () => {
    const s = await asOwner()
    expect(await s.write('resolve-send', { draftId: 'd-stuck', sent: false })).toEqual({ result: 'ok', value: { id: 'd-stuck', status: 'draft' } })
    const left = await s.inbox.drafts(OWNER_SIGNED_IN)
    expect(left.ok && left.value.find((d) => d.id === 'd-stuck')?.stuck).toBe(false)
  })

  test('a message that is not waiting on a send is refused in the inbox’s words, and said twice is refused the second time', async () => {
    const s = await asOwner()
    expect(await s.write('resolve-send', { draftId: 'd-mail', sent: true })).toEqual({ result: 'refused', reason: 'conflict', message: 'That message is not waiting on a send.' })
    await s.write('resolve-send', { draftId: 'd-stuck', sent: false })
    expect(await s.write('resolve-send', { draftId: 'd-stuck', sent: false })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(await s.write('resolve-send', { draftId: 'nope', sent: true })).toEqual({ result: 'refused', reason: 'not-found', message: 'No such message.' })
  })

  test('a write the space loses track of is outcome-unknown and is never retried; an inbox that cannot be reached says nothing was changed', async () => {
    const s = await asOwner({ writeWithinMs: 50 })
    let asked = 0
    s.inbox.resolveSend = async () => {
      asked++
      throw new Error('gone')
    }
    expect(await s.write('resolve-send', { draftId: 'd-stuck', sent: true })).toMatchObject({ result: 'outcome-unknown' })
    expect(asked).toBe(1)
    const down = await world(northfield(), NORTHFIELD_TEAM, {}, undefined, { answerWithinMs: 60, writeWithinMs: 50 })
    const res = await down.call('/api/inbox/resolve-send', { method: 'POST', jwt: await down.signIn('tessa@northfield.example'), headers: JSON_POST, body: JSON.stringify({ draftId: 'd-stuck', sent: true }) })
    expect(await res.json()).toEqual({ result: 'failed', message: 'Email is not connected to the space. Nothing was changed.' })
  })

  test('an answer that is not the contract’s shape is not half read: a write is then of unknown outcome', async () => {
    const s = await asOwner()
    s.inbox.resolveSend = async () => ({ ok: true, value: { id: 'd-stuck', status: 'gone' } as never })
    expect(await s.write('resolve-send', { draftId: 'd-stuck', sent: true })).toMatchObject({ result: 'outcome-unknown', message: expect.stringContaining('could not read') })
  })
})

describe('marking a text or a direct message sent by hand, and taking it back', () => {
  test('a text draft is filed as sent, and Not sent after all makes it a draft again', async () => {
    const s = await asOwner()
    expect(await s.write('draft-sent', { draftId: 'd-text' })).toMatchObject({ result: 'ok', value: { messageId: 'd-text' } })
    const history = await s.inbox.messagesWith(OWNER_SIGNED_IN, { contactId: 'c-text' }, { include: ['closed'] })
    expect(history.ok && history.value.messages.find((m) => m.id === 'd-text')).toMatchObject({ direction: 'out', text: 'Running late.', sentByHand: true })
    expect(await s.write('draft-unsent', { messageId: 'd-text' })).toMatchObject({ result: 'ok', value: { messageId: 'd-text' } })
    const drafts = await s.inbox.drafts(OWNER_SIGNED_IN)
    expect(drafts.ok && drafts.value.map((d) => d.id)).toContain('d-text')
  })

  test('an email is refused in the inbox’s words, a stuck send is not a draft, and a message not marked sent cannot be unmarked', async () => {
    const s = await asOwner()
    expect(await s.write('draft-sent', { draftId: 'd-mail' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('An email is sent with Send') })
    expect(await s.write('draft-sent', { draftId: 'd-stuck' })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(await s.write('draft-sent', { draftId: 'nope' })).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(await s.write('draft-unsent', { messageId: 't-a-m1' })).toEqual({ result: 'refused', reason: 'conflict', message: 'Only a message marked sent by hand can be unmarked.' })
    expect(await s.write('draft-unsent', { messageId: 'nope' })).toMatchObject({ result: 'refused', reason: 'not-found' })
    await s.write('draft-sent', { draftId: 'd-text' })
    // Pressed twice: the second finds a message that is no longer a draft.
    expect(await s.write('draft-sent', { draftId: 'd-text' })).toMatchObject({ result: 'refused', reason: 'not-found' })
  })

  test('the answers are two ids: no words of the message appear in them', async () => {
    const s = await asOwner()
    const json = JSON.stringify([await s.write('draft-sent', { draftId: 'd-text' }), await s.write('draft-unsent', { messageId: 'd-text' }), await s.write('resolve-send', { draftId: 'd-stuck', sent: true })])
    for (const never of ['Running late', 'secret figure']) expect(json).not.toContain(never)
  })
})

describe('renaming a contact and splitting an address off one', () => {
  test('a rename names the revision shown, raises it, and answers the contact as it now stands', async () => {
    const s = await asOwner()
    const done = await s.write<{ name: string; rev: number }>('contact-rename', { contactId: 'c-b', rev: 0, name: '  Bo Lin-Park ' })
    expect(done).toMatchObject({ result: 'ok', value: { name: 'Bo Lin-Park', rev: 1 } })
    // A second rename from the same screen is stale, and says so in the inbox's words.
    expect(await s.write('contact-rename', { contactId: 'c-b', rev: 0, name: 'Other' })).toEqual({ result: 'refused', reason: 'conflict', message: 'This person changed since you opened them, so nothing was renamed. They are shown as they are now.' })
    expect((await s.contactOf('c-b')).name).toBe('Bo Lin-Park')
  })

  test('an empty name and a contact that is not there are refused in the inbox’s words, and change nothing', async () => {
    const s = await asOwner()
    expect(await s.write('contact-rename', { contactId: 'c-b', rev: 0, name: '   ' })).toEqual({ result: 'refused', reason: 'bad-request', message: 'A contact needs a name.' })
    expect(await s.write('contact-rename', { contactId: 'nope', rev: 0, name: 'X' })).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(await s.contactOf('c-b')).toMatchObject({ name: 'Bo Lin', rev: 0 })
  })

  test('a split puts the address on a contact of its own, raises the revision of the one it came off, and answers both', async () => {
    const s = await asOwner()
    const done = await s.write<{ from: { addresses: string[]; rev: number }; contact: { name: string; addresses: string[]; rev: number } }>('contact-split', { contactId: 'c-a', rev: 0, identityId: 'c-a-i1' })
    expect(done).toMatchObject({ result: 'ok', value: { from: { addresses: ['ana@x.example'], rev: 1 }, contact: { name: 'ana@home.example', addresses: ['ana@home.example'], rev: 0 } } })
  })

  test('a stale screen, an address that is not that contact’s and a contact’s only address are each refused in the inbox’s words, and nothing moves', async () => {
    const s = await asOwner()
    expect(await s.write('contact-split', { contactId: 'c-a', rev: 5, identityId: 'c-a-i1' })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(await s.write('contact-split', { contactId: 'c-a', rev: 0, identityId: 'c-b-i0' })).toEqual({ result: 'refused', reason: 'not-found', message: 'No such address.' })
    expect(await s.write('contact-split', { contactId: 'c-b', rev: 0, identityId: 'c-b-i0' })).toEqual({ result: 'refused', reason: 'bad-request', message: 'That is this contact’s only address, so there is nothing to split off.' })
    expect((await s.contactOf('c-a')).addresses).toEqual(['ana@home.example', 'ana@x.example'])
    expect((await s.contactOf('c-b')).rev).toBe(0)
  })

  test('the answers carry the contact and no message of theirs', async () => {
    const s = await asOwner()
    const json = JSON.stringify([await s.write('contact-rename', { contactId: 'c-b', rev: 0, name: 'Bo L.' }), await s.write('contact-split', { contactId: 'c-a', rev: 0, identityId: 'c-a-i1' })])
    for (const never of ['secret figure', 'Quote for the shop']) expect(json).not.toContain(never)
  })
})

describe('a search result opens in the space', () => {
  test('a hit carries the key of the first other person on it, never the page it used to open, and a person with no address is found by their contact', async () => {
    const s = await asOwner()
    const res = await s.w.call('/api/search?q=shop', { jwt: s.jwt })
    const answer = (await res.json()) as { mail: { hits: { conversationId: string; key: string | null }[] } }
    expect(answer.mail.hits.map((h) => [h.conversationId, h.key])).toEqual([['t-b', 'bo@x.example']])
    const text = (await (await s.w.call('/api/search?q=on my way', { jwt: s.jwt })).json()) as typeof answer
    expect(text.mail.hits.map((h) => [h.conversationId, h.key])).toEqual([['t-text', 'mail:c-text']])
    expect(JSON.stringify(answer)).not.toContain('inbox.northfield.example')
  })

  test('the key is the first person who is not the one asking, else none: a hit with only him on it does not link', () => {
    const party = (contactId: string, address: string | null) => ({ contactId, name: contactId, address })
    expect(hitKey([party('c-me', 'tessa@northfield.example'), party('c-bo', 'bo@x.example')], ['tessa@northfield.example'])).toBe('bo@x.example')
    expect(hitKey([party('c-me', 'TESSA@northfield.example'), party('c-bo', null)], ['tessa@northfield.example'])).toBe('mail:c-bo')
    expect(hitKey([party('c-me', 'tessa@northfield.example')], ['tessa@northfield.example'])).toBeNull()
    expect(hitKey([], ['tessa@northfield.example'])).toBeNull()
  })
})
