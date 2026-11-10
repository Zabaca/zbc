// The Conversations tab split into Inbox and Meet, driven through the real router with stand-in apps behind the bindings: what each list and each
// conversation holds, which app is asked for it, and where every old /conversations address lands now.
import { describe, expect, test } from 'bun:test'
import type { ConversationAnswer } from '../src/conversation'
import type { ConversationsAnswer } from '../src/conversations'
import { isLegacyPath, legacyTarget, tabOfKey } from '../src/legacy'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'
import { northfield } from '../../workspace/test/helpers'

const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

async function asOwner() {
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example')], [thread('t1', ago(90), ['c-dana'], { subject: 'Homepage copy', snippet: 'Can the hours say Saturdays?', unread: true }), thread('t2', ago(60), ['c-marcus'])])
  const meet = standInMeet({ direct: [dm(11, dana, ago(5), 2, 'Also, can we move Thursday?'), dm(12, priya, ago(200))], channels: [channel(21, 'launch', ago(20), 1)] })
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async <T>(path: string) => {
    const res = await w.call(path, { jwt })
    return { status: res.status, body: (await res.json()) as T }
  }
  return { w, jwt, inbox, meet, get }
}

describe('the lists', () => {
  test('the Inbox asks the inbox alone: email rows, one part, and meet is never asked', async () => {
    const s = await asOwner()
    const { body } = await s.get<ConversationsAnswer>('/api/conversations?scope=mail')
    expect(body.rows.map((r) => r.key).sort()).toEqual(['dana@harbor.example', 'marcus@harbor.example'])
    expect(body.rows.every((r) => r.type === 'person' && r.chat === null)).toBe(true)
    expect(body.parts.map((p) => p.part)).toEqual(['mail'])
    expect(s.meet.asked.askers).toEqual([])
  })

  test('Meet asks meet alone: channels and direct messages, one part, and the inbox is never asked', async () => {
    const s = await asOwner()
    const { body } = await s.get<ConversationsAnswer>('/api/conversations?scope=chat')
    expect(body.rows.map((r) => r.key).sort()).toEqual(['chat:channel:21', 'dana@harbor.example', 'priya@northfield.example'])
    expect(body.rows.every((r) => r.type === 'channel' || (r.type === 'person' && r.mail.length === 0))).toBe(true)
    expect(body.parts.map((p) => p.part)).toEqual(['chat'])
    expect(s.inbox.asked.askers).toEqual([])
  })

  test('no scope is both merged, as before; a scope that is neither, and Meet asked for a view that is the inbox’s, are refused', async () => {
    const s = await asOwner()
    expect((await s.get<ConversationsAnswer>('/api/conversations')).body.rows).toHaveLength(4)
    expect((await s.get('/api/conversations?scope=both')).status).toBe(400)
    expect((await s.get('/api/conversations?scope=chat&view=bulk')).status).toBe(400)
  })
})

describe('a conversation in a tab', () => {
  test('in the Inbox a person has their emails and no direct message (their call cards are still asked of meet: a call link in an email is a mail thing)', async () => {
    const s = await asOwner()
    const { body } = await s.get<ConversationAnswer>('/api/conversation?key=dana%40harbor.example&scope=mail')
    expect(body.sources.map((x) => x.kind)).toEqual(['mail'])
    expect(body.row.type === 'person' && body.row.chat).toBeNull()
    expect(body.parts.map((p) => p.part)).toEqual(['mail'])
    expect(body.read.chat).toBeNull()
  })

  test('in Meet the same person has their direct message and no email, and the inbox is not asked', async () => {
    const s = await asOwner()
    const { body } = await s.get<ConversationAnswer>('/api/conversation?key=dana%40harbor.example&scope=chat')
    expect(body.sources.map((x) => x.kind)).toEqual(['chat'])
    expect(body.threads).toEqual([])
    expect(body.parts.map((p) => p.part)).toEqual(['chat'])
    expect(body.read.mail).toEqual([])
    expect(s.inbox.asked.askers).toEqual([])
  })

  test('a channel opens in Meet and is not in the Inbox; a person with only email is not in Meet; a bad scope is refused', async () => {
    const s = await asOwner()
    expect((await s.get('/api/conversation?key=chat%3Achannel%3A21&scope=chat')).status).toBe(200)
    expect((await s.get('/api/conversation?key=chat%3Achannel%3A21&scope=mail')).status).toBe(404)
    expect((await s.get('/api/conversation?key=marcus%40harbor.example&scope=mail')).status).toBe(200)
    expect((await s.get('/api/conversation?key=marcus%40harbor.example&scope=chat')).status).toBe(404)
    expect((await s.get('/api/conversation?key=marcus%40harbor.example&scope=email')).status).toBe(400)
  })

  test('with no scope a person opens with both, as before', async () => {
    const s = await asOwner()
    const { body } = await s.get<ConversationAnswer>('/api/conversation?key=dana%40harbor.example')
    expect(body.sources.map((x) => x.kind).sort()).toEqual(['chat', 'mail'])
  })
})

describe('an old /conversations address', () => {
  test('lands on the same thing under the new path, with its query', () => {
    const table: [string, string, string][] = [
      ['/conversations', '', '/inbox'],
      ['/conversations/', '', '/inbox'],
      ['/conversations', '?view=bulk', '/inbox?view=bulk'],
      ['/conversations', '?view=mailbox&mailbox=ridgeway', '/inbox?view=mailbox&mailbox=ridgeway'],
      ['/conversations', '?view=calls', '/meet?view=calls'],
      ['/conversations/dana%40harbor.example', '', '/inbox/dana%40harbor.example'],
      ['/conversations/dana%40harbor.example', '?view=closed', '/inbox/dana%40harbor.example?view=closed'],
      ['/conversations/mail%3Ac-9', '', '/inbox/mail%3Ac-9'],
      ['/conversations/draft/msg-2', '', '/inbox/draft/msg-2'],
      ['/conversations/draft/a%20b%2Fc', '', '/inbox/draft/a%20b%2Fc'],
      ['/conversations/chat%3Achannel%3A21', '', '/meet/chat%3Achannel%3A21'],
      ['/conversations/chat%3Ap-dana', '', '/meet/chat%3Ap-dana'],
      ['/conversations/call%3Ak7m2qx9frtn4w6hbc8jd', '', '/meet/call%3Ak7m2qx9frtn4w6hbc8jd'],
      ['/conversations/phone', '', '/meet/phone'],
      ['/CONVERSATIONS/phone', '', '/meet/phone'],
      ['/conversations/a/b/c', '', '/inbox'],
      ['/conversations/%E0%A4%A', '', '/inbox'],
    ]
    for (const [path, search, to] of table) expect([path + search, legacyTarget(path, search)]).toEqual([path + search, to])
  })

  test('only the old tab’s own paths are old', () => {
    for (const p of ['/conversations', '/conversations/x', '/Conversations/x']) expect(isLegacyPath(p)).toBe(true)
    for (const p of ['/inbox', '/meet', '/conversationsx', '/api/conversations', '/forms/conversations', '/today']) expect([p, isLegacyPath(p)]).toEqual([p, false])
    expect([tabOfKey('phone'), tabOfKey('call:x'), tabOfKey('chat:channel:3'), tabOfKey('chat:p-1'), tabOfKey('a@b.example'), tabOfKey('mail:c-1')]).toEqual(['meet', 'meet', 'meet', 'meet', 'inbox', 'inbox'])
  })

  test('the Worker answers it with a redirect, behind the same sign-in as everything else, and never asks an app', async () => {
    const s = await asOwner()
    const none = await s.w.call('/conversations/dana%40harbor.example')
    expect(none.status).toBe(401)
    const res = await s.w.call('/conversations/chat%3Achannel%3A21?view=x', { jwt: s.jwt, redirect: 'manual' } as never)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/meet/chat%3Achannel%3A21?view=x')
    const draft = await s.w.call('/conversations/draft/d-first', { jwt: s.jwt })
    expect(draft.status).toBe(302)
    expect(draft.headers.get('location')).toBe('/inbox/draft/d-first')
    const list = await s.w.call('/conversations', { jwt: s.jwt })
    expect(list.headers.get('location')).toBe('/inbox')
    expect(s.inbox.asked.askers).toEqual([])
    expect(s.meet.asked.askers).toEqual([])
  })
})
