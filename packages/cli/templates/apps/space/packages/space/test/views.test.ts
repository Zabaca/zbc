// The inbox's other views in the space, driven through the real router with a stand-in inbox behind the binding. What is asserted is what a person sees (the
// answers the page is given, what a write came to) or what is refused, never the Worker's internals: no sign-in is refused at every new path and nothing is asked of the
// inbox; the assertion the space received is the one it hands on; a write is never retried; the inbox's own words come through; a reply that is not the contract's shape is
// not half read; and what Tessa opens from a notification is found by whichever address the sender wrote from.
import { describe, expect, test } from 'bun:test'
import { answered } from '@space/workspace'
import { lane, northfield } from '../../workspace/test/helpers'
import type { ConversationAnswer } from '../src/conversation'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { fixtureViews } from '../src/fixture-views'
import { READ_NAMES, WRITE_NAMES, type ViewAnswer } from '../src/views'
import { T0 } from '../../workspace/test/helpers'
import { LANE_TEAM, NORTHFIELD_TEAM, contact, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }

async function asOwner(options: { writeWithinMs?: number; answerWithinMs?: number; noInbox?: boolean } = {}) {
  const inbox = standInInbox([contact('c-x', 'Xavier Moss', 'a@x.example', 'b@x.example')], [thread('t-x', T0 - 60_000, ['c-x'])], { views: fixtureViews(T0), now: () => T0 })
  const w = await world(northfield(), NORTHFIELD_TEAM, options.noInbox ? {} : { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: options.answerWithinMs ?? 60, writeWithinMs: options.writeWithinMs ?? 200, now: () => T0 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async <T = unknown>(path: string): Promise<ViewAnswer<T>> => {
    const res = await w.call(path, { jwt })
    expect([path, res.status]).toEqual([path, 200])
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    return (await res.json()) as ViewAnswer<T>
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = JSON_POST) => w.call(path, { method: 'POST', jwt, headers, body: JSON.stringify(body) })
  const write = async <T = unknown>(name: string, body: unknown): Promise<ViewAnswer<T>> => {
    const res = await post(`/api/inbox/${name}`, body)
    expect([name, res.status]).toEqual([name, 200])
    return (await res.json()) as ViewAnswer<T>
  }
  const calls = () => inbox.views.calls.map((c) => c.method)
  return { w, jwt, inbox, get, post, write, calls }
}

describe('no sign-in is refused at every new path', () => {
  const VIEWS = [...READ_NAMES, ...WRITE_NAMES].map((n) => `/api/inbox/${n}`)
  const PAGES = ['/settings', '/settings/notifications', '/settings/clients/7', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png']

  test('without a sign-in, whatever the method and whatever else rides along, nothing is asked of the inbox and no page is read', async () => {
    const s = await asOwner()
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const path of [...VIEWS, ...PAGES]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await s.w.call(path, { method, ...init, headers: JSON_POST, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(s.inbox.views.calls).toEqual([])
    expect(s.inbox.asked.askers).toEqual([])
    expect(s.w.asked).toEqual([])
  })

  test('another company’s person is refused too, at the writes as at the reads, and a refused person changed nothing', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const name of READ_NAMES) expect([name, (await s.w.call(`/api/inbox/${name}`, { jwt: stranger })).status]).toEqual([name, 403])
    for (const name of WRITE_NAMES) expect([name, (await s.w.call(`/api/inbox/${name}`, { method: 'POST', jwt: stranger, headers: JSON_POST, body: '{}' })).status]).toEqual([name, 403])
    expect(s.inbox.views.calls).toEqual([])
    expect(s.inbox.views.state.claudeSending.enabled).toBe(false)
  })

  test('the page itself, the worker and the manifest are served to Tessa, and only to him', async () => {
    const s = await asOwner()
    for (const path of PAGES) expect([path, (await s.w.call(path, { jwt: s.jwt })).status]).toEqual([path, 200])
    expect(s.w.asked).toEqual(PAGES)
  })
})

describe('what a write has to be', () => {
  test('from this host, as JSON, small and a JSON object: a form on another site cannot flip Tessa’s switches', async () => {
    const s = await asOwner()
    const body = { enabled: true }
    const call = (headers: Record<string, string>, b: string = JSON.stringify(body)) => s.w.call('/api/inbox/claude-sending', { method: 'POST', jwt: s.jwt, headers, body: b })
    expect((await call({ 'content-type': 'application/json' })).status).toBe(403) // no Origin
    expect((await call({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'enabled=true')).status).toBe(415)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' })).status).toBe(413)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json' }, 'not json')).status).toBe(400)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json' }, '[1]')).status).toBe(400)
    expect(s.calls()).toEqual([])
    expect(s.inbox.views.state.claudeSending.enabled).toBe(false)
  })

  test('a read is a GET and a write a POST, on their own names: the wrong method, or a name that is no view, asks no one', async () => {
    const s = await asOwner()
    expect((await s.post('/api/inbox/mailboxes', {})).status).toBe(405) // a read name cannot be written
    expect((await s.w.call('/api/inbox/claude-sending', { method: 'PUT', jwt: s.jwt, headers: JSON_POST, body: '{}' })).status).toBe(405)
    expect((await s.w.call('/api/inbox/nope', { jwt: s.jwt })).status).toBe(404)
    expect((await s.w.call('/api/inbox/gmail', { jwt: s.jwt })).status).toBe(404) // a write name cannot be read
    expect((await s.post('/api/inbox/nope', {})).status).toBe(405)
    expect(s.calls()).toEqual([])
  })

  test('a body that is not what the view takes is a 400 and asks no one', async () => {
    const s = await asOwner()
    const bad: [string, unknown][] = [
      ['claude-sending', { enabled: 'yes' }],
      ['claude-sending', {}],
      ['spam-check', { mailboxId: 'ridgeway' }],
      ['spam-check', { mailboxId: '../x', enabled: true }],
      ['gmail', { change: 'wipe' }],
      ['device-add', { endpoint: 'https://fcm.googleapis.com/x' }],
      ['device-add', { endpoint: 'x', keys: { p256dh: 1, auth: 2 } }],
      ['device-remove', { id: '../etc' }],
      ['device-test', {}],
      ['restore-prepare', {}],
      ['restore-prepare', { time: '2026-10-20T12:00:00Z', bookmark: 'b' }],
      ['restore-confirm', { token: 't' }],
      ['restore-confirm', { bookmark: 'b' }],
      ['client-link', { contactId: 'c-1', clientId: 'seven' }],
      ['client-link', { contactId: 'c-1', clientId: 0 }],
      ['chat', { conversationId: 't-1', draftId: 'd-1', rev: -1, instruction: 'x' }],
      ['chat', { conversationId: 't-1', draftId: 'd-1', rev: 1, instruction: '   ' }],
    ]
    for (const [name, body] of bad) expect([name, JSON.stringify(body), (await s.post(`/api/inbox/${name}`, body)).status]).toEqual([name, JSON.stringify(body), 400])
    for (const path of ['/api/inbox/client', '/api/inbox/client?id=0', '/api/inbox/client?id=x', '/api/inbox/draft-chat?conversation=a', '/api/inbox/draft-chat']) {
      expect([path, (await s.w.call(path, { jwt: s.jwt })).status]).toEqual([path, 400])
    }
    expect(s.calls()).toEqual([])
  })
})

describe('the reads', () => {
  test('each is the inbox’s answer, asked for the person Tessa’s request named, and never kept by the browser', async () => {
    const s = await asOwner()
    const sent = await s.w.signIn('tessa@northfield.example')
    for (const [path, method] of [
      ['/api/inbox/navigation', 'navigation'],
      ['/api/inbox/claude-sending', 'claudeSending'],
      ['/api/inbox/mailboxes', 'mailboxes'],
      ['/api/inbox/notifications', 'notifications'],
      ['/api/inbox/restore', 'restoreReport'],
      ['/api/inbox/clients', 'clients'],
      ['/api/inbox/client?id=7', 'client'],
      ['/api/inbox/draft-chat?conversation=t-1&draft=d-1', 'draftChat'],
    ] as const) {
      const res = await s.w.call(path, { jwt: sent })
      expect([path, res.status]).toEqual([path, 200])
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const answer = (await res.json()) as ViewAnswer<unknown>
      // A draft that is not there is the inbox's refusal, in its words; everything else is a value.
      expect([path, method, answer.result]).toEqual([path, method, method === 'draftChat' ? 'refused' : 'ok'])
    }
    const asked = s.inbox.views.calls
    expect(asked.map((c) => c.method)).toEqual(['navigation', 'claudeSending', 'mailboxes', 'notifications', 'restoreReport', 'clients', 'client', 'draftChat'])
    // The person is Tessa, the one the space's single check named (the workspace ADR 0003).
    expect([...new Set(asked.map((c) => c.asker?.person.address))]).toEqual(['tessa@northfield.example'])
  })

  test('the menu is the inbox’s own counts, drawn from what the inbox holds, and a malformed answer is not half read', async () => {
    const s = await asOwner()
    const menu = await s.get<{ views: { inbox: { count: number } }; mailboxes: { id: string; count: number }[]; clients: { id: number }[]; contacts: number }>('/api/inbox/navigation')
    expect(menu.result).toBe('ok')
    if (menu.result !== 'ok') return
    expect(menu.value.views.inbox.count).toBe(1) // the one open thread of this world
    expect(menu.value.mailboxes.map((m) => m.id)).toEqual(['ridgeway', 'shiftlantern'])
    expect(menu.value.contacts).toBe(1)
    s.inbox.navigation = async () => answered({ views: { inbox: { count: 1 } }, mailboxes: [], clients: [], contacts: 1, gmail: null }) as never
    expect(await s.get('/api/inbox/navigation')).toMatchObject({ result: 'unreachable', message: 'Email answered in a way the space could not read.' })
  })

  test('a Client is asked for by id, and what the inbox does not know is its own refusal, in its own words; the knowledge base is no longer the inbox’s to answer', async () => {
    const s = await asOwner()
    expect(await s.get('/api/inbox/client?id=999')).toEqual({ result: 'refused', reason: 'not-found', message: 'No such Client.' })
  })

  test('the inbox down, slow, not connected or answering something that is not the contract’s shape: said as not reached, and nothing is half read', async () => {
    const s = await asOwner()
    s.inbox.views.script.push('throw')
    expect(await s.get('/api/inbox/mailboxes')).toMatchObject({ result: 'unreachable', message: 'Email could not be reached.' })
    s.inbox.views.script.push('hang')
    expect(await s.get('/api/inbox/clients')).toMatchObject({ result: 'unreachable', message: 'Email took too long to answer.' })
    s.inbox.mailboxes = async () => answered({ gmail: 'connected', mailboxes: [], assistantKey: true }) as never
    expect(await s.get('/api/inbox/mailboxes')).toMatchObject({ result: 'unreachable', message: 'Email answered in a way the space could not read.' })
    s.inbox.notifications = async () => answered({ publicKey: 'k', devices: [{ id: 'd' }], week: { sent: 0, dropped: 0 } }) as never
    expect(await s.get('/api/inbox/notifications')).toMatchObject({ result: 'unreachable' })
    s.inbox.views.script.push('broken')
    expect(await s.get('/api/inbox/restore')).toEqual({ result: 'failed', message: 'The inbox could not answer that. Nothing was changed.' })
    const gone = await asOwner({ noInbox: true })
    expect(await gone.get('/api/inbox/mailboxes')).toMatchObject({ result: 'unreachable', message: 'Email is not connected to the space.' })
  })
})

describe('the writes', () => {
  test('Claude’s sending is flipped by Tessa through the space, and nowhere else is a switch flipped by a read', async () => {
    const s = await asOwner()
    expect(await s.write('claude-sending', { enabled: true })).toMatchObject({ result: 'ok', value: { enabled: true } })
    expect(s.inbox.views.state.claudeSending.enabled).toBe(true)
    expect(await s.write('claude-sending', { enabled: false })).toMatchObject({ result: 'ok', value: { enabled: false } })
    expect(s.calls()).toEqual(['setClaudeSending', 'setClaudeSending'])
    // Reading the switch, or any view, changes none.
    await s.get('/api/inbox/claude-sending')
    await s.get('/api/inbox/mailboxes')
    expect(s.inbox.views.state.claudeSending.enabled).toBe(false)
  })

  test('the spam check, Gmail and a Client’s link each reach the inbox with what the page named', async () => {
    const s = await asOwner()
    expect(await s.write('spam-check', { mailboxId: 'ridgeway', enabled: false })).toMatchObject({ result: 'ok', value: { enabled: false } })
    expect(await s.write('gmail', { change: 'sync' })).toMatchObject({ result: 'ok', value: { change: 'sync', revoked: null } })
    expect(await s.write('client-link', { contactId: 'c-hygienist', clientId: 7 })).toMatchObject({ result: 'ok', value: { contactId: 'c-hygienist', clientId: 7 } })
    expect(s.calls()).toEqual(['setSpamCheck', 'changeGmail', 'linkClient'])
    expect(s.inbox.views.calls[0]?.args).toEqual(['ridgeway', false])
  })

  test('a device is added with the browser’s own name, so the inbox can label it and mark it as the space’s', async () => {
    const s = await asOwner()
    const res = await s.w.call('/api/inbox/device-add', {
      method: 'POST',
      jwt: s.jwt,
      headers: { ...JSON_POST, 'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 8a) Chrome/141.0 Mobile Safari/537.36' },
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/new-phone', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    })
    const added = (await res.json()) as ViewAnswer<{ origin: string; label: string }>
    expect(added).toMatchObject({ result: 'ok', value: { origin: 'space', label: 'Chrome on Android' } })
    expect(s.inbox.views.calls[0]?.args).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/new-phone', keys: { p256dh: 'p', auth: 'a' } }, expect.stringContaining('Pixel 8a')])
    const listed = await s.get<{ devices: { origin: string }[] }>('/api/inbox/notifications')
    expect(listed.result === 'ok' && listed.value.devices.map((d) => d.origin)).toEqual(['inbox', 'inbox', 'space', 'space'])
  })

  test('RESTORE ASKS BEFORE IT ACTS: preparing changes nothing, and the second call must send back the token and the bookmark the first answered', async () => {
    const s = await asOwner()
    const plan = await s.write<{ token: string; target: string }>('restore-prepare', { bookmark: 'bookmark-0001-earlier' })
    expect(plan).toMatchObject({ result: 'ok', value: { target: 'bookmark-0001-earlier' } })
    if (plan.result !== 'ok') throw new Error('no plan')
    expect(s.inbox.views.state.restores.map((r) => r.kind)).toEqual(['restored']) // the one already there: nothing new
    // Without the token, with another bookmark, or with a token that was never given: nothing is restored.
    expect(await s.write('restore-confirm', { token: 'made-up', bookmark: plan.value.target })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(await s.write('restore-confirm', { token: plan.value.token, bookmark: 'bookmark-9999-other' })).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(s.inbox.views.state.restores).toHaveLength(1)
    // The right pair restores once, and the token is spent.
    expect(await s.write('restore-confirm', { token: plan.value.token, bookmark: plan.value.target })).toMatchObject({ result: 'ok', value: { restoredTo: 'bookmark-0001-earlier', undoBookmark: 'bookmark-0002-undo' } })
    expect(s.inbox.views.state.restores).toHaveLength(2)
    expect(await s.write('restore-confirm', { token: plan.value.token, bookmark: plan.value.target })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(s.inbox.views.state.restores).toHaveLength(2)
  })

  test('A WRITE IS NEVER RETRIED: a lost connection is outcome unknown after exactly one try, and so is no answer in time', async () => {
    const s = await asOwner({ writeWithinMs: 80 })
    s.inbox.views.script.push('throw')
    expect(await s.write('claude-sending', { enabled: true })).toMatchObject({ result: 'outcome-unknown', message: expect.stringContaining('did not say whether it went through') })
    expect(s.calls()).toEqual(['setClaudeSending']) // one try, no second
    // An answer that is not the contract's shape is no answer: it may have been done.
    s.inbox.setClaudeSending = async () => answered({ enabled: 'maybe' }) as never
    expect(await s.write('claude-sending', { enabled: true })).toMatchObject({ result: 'outcome-unknown' })
  })

  test('a fault the inbox knows nothing was changed by is failed, and with no inbox bound nothing is changed and it says so', async () => {
    const s = await asOwner()
    s.inbox.views.script.push('broken')
    expect(await s.write('claude-sending', { enabled: true })).toEqual({ result: 'failed', message: 'The inbox could not answer that. Nothing was changed.' })
    const gone = await asOwner({ noInbox: true })
    expect(await gone.write('claude-sending', { enabled: true })).toEqual({ result: 'failed', message: 'Email is not connected to the space. Nothing was changed.' })
  })
})

describe('the draft chat', () => {
  const draft = { id: 'd-1', conversationId: 't-x', contactId: 'c-x', subject: 'Re: hello', text: 'Hi.\n\nTalk soon.', author: 'claude' as const, at: T0 }
  async function withDraft() {
    const s = await asOwner()
    s.inbox.views.calls.length = 0
    return s
  }

  test('a turn names the draft and the revision shown, and the answer is the draft as it stands with the turn kept', async () => {
    const inbox = standInInbox([contact('c-x', 'Xavier', 'a@x.example')], [thread('t-x', T0, ['c-x'])], { drafts: [draft], views: fixtureViews(T0), now: () => T0 })
    const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox }, undefined, { answerWithinMs: 60, writeWithinMs: 200, now: () => T0 })
    const jwt = await w.signIn('tessa@northfield.example')
    const ask = async (rev: number) => (await (await w.call('/api/inbox/chat', { method: 'POST', jwt, headers: JSON_POST, body: JSON.stringify({ conversationId: 't-x', draftId: 'd-1', rev, instruction: 'shorter' }) })).json()) as ViewAnswer<{ rev: number; text: string; turn: { revised: boolean } }>
    expect(await ask(1)).toMatchObject({ result: 'ok', value: { rev: 2, text: 'Hi.', turn: { revised: true } } })
    // The same press made again over the revision the first one moved on: refused, not a second revision.
    expect(await ask(1)).toMatchObject({ result: 'refused', reason: 'conflict' })
    const turns = (await (await w.call('/api/inbox/draft-chat?conversation=t-x&draft=d-1', { jwt })).json()) as ViewAnswer<{ instruction: string }[]>
    expect(turns).toMatchObject({ result: 'ok' })
    expect(turns.result === 'ok' && turns.value.map((t) => t.instruction)).toEqual(['shorter'])
    expect(inbox.sent).toEqual([]) // nothing typed in a chat sends anything
  })

  test('without an assistant key the inbox says so as a fault with its words, and the draft is as it was', async () => {
    const s = await withDraft()
    s.inbox.views.script.push('broken')
    expect(await s.write('chat', { conversationId: 't-x', draftId: 'd-1', rev: 1, instruction: 'shorter' })).toMatchObject({ result: 'failed', message: expect.stringContaining('no key') })
  })
})

describe('opening a conversation from a notification', () => {
  test('a link that names ANY of a person’s addresses opens their conversation, which the list names by the first', async () => {
    const s = await asOwner()
    const open = async (key: string) => s.w.call(`/api/conversation?key=${encodeURIComponent(key)}`, { jwt: s.jwt })
    const byFirst = (await (await open('a@x.example')).json()) as ConversationAnswer
    expect(byFirst.key).toBe('a@x.example')
    // The sender wrote from their other address: the notification names that one, and the same conversation opens.
    const bySecond = await open('b@x.example')
    expect(bySecond.status).toBe(200)
    const answer = (await bySecond.json()) as ConversationAnswer
    expect(answer.key).toBe('a@x.example')
    expect(answer.row.type === 'person' && answer.row.addresses).toEqual(['a@x.example', 'b@x.example'])
    // An address nobody here has is still not a conversation.
    expect((await open('stranger@x.example')).status).toBe(404)
  })

  test('another company’s space finds its people the same way and no one else’s', async () => {
    const inbox = standInInbox([contact('c-x', 'Xavier', 'a@x.example', 'b@x.example')], [thread('t-x', T0, ['c-x'])])
    const w = await world(lane(), LANE_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 60, now: () => T0 })
    const res = await w.call('/api/conversation?key=b%40x.example', { jwt: await w.signIn('lane@pinecrest.test') })
    expect(res.status).toBe(200)
  })
})
