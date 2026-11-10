// Chat, at the HTTP API with the real rules underneath: who may send and read, the length and the rate, what a
// late joiner sees, what Tessa's page lists and reads and deletes, and that a name nobody started is written to
// nothing. (The browser's pure side, links and unread counts, is in browser.test.ts; two real tabs are
// scripts/chat.ts.)
import { beforeEach, describe, expect, test } from 'bun:test'
import { CHAT_MAX, CHAT_RATE, CHAT_ROOM_CAP, MEMBER_TIMEOUT_MS } from '../src/model'
import { RoomCore, cleanMessage } from '../src/room'
import { type Harness, OWNER, T0, harness, memSql, token } from './helpers'

let h: Harness & { access: Awaited<ReturnType<typeof harness>>['access'] }
let name: string

beforeEach(async () => {
  h = await harness()
  name = await h.startCall()
})

const base = (n = name) => `/r/api/rooms/${n}`

async function join(who: string, displayName = who, room = name) {
  const r = await h.call('POST', `${base(room)}/join`, { name: displayName }, { token: token(who) })
  expect(r.status).toBe(200)
  return { ...r.json, tok: token(who), room } as { memberId: string; generation: number; tok: string; room: string; chatLast: number }
}

const say = (m: { tok: string; generation: number; room?: string }, text: unknown) =>
  h.call('POST', `${base(m.room ?? name)}/chat`, { generation: m.generation, text }, { token: m.tok })

const checkin = (m: { tok: string; generation: number; room?: string }, since = 0) =>
  h.call('POST', `${base(m.room ?? name)}/checkin`, { generation: m.generation, since }, { token: m.tok })

describe('who may send and read', () => {
  test('a member sends, and everyone in the call gets it at their next check-in, with the name and the time', async () => {
    const ana = await join('ana', 'Ana')
    const ben = await join('ben', 'Ben')
    h.clock.now = T0 + 5000
    const sent = await say(ana, 'hello Ben')
    expect(sent.status).toBe(201)
    expect(sent.json.message).toEqual({ id: 1, memberId: ana.memberId, name: 'Ana', text: 'hello Ben', at: T0 + 5000 })
    const seen = (await checkin(ben)).json.chat
    expect(seen.messages).toEqual([sent.json.message])
    expect(seen.last).toBe(1)
    // Asking from the newest id gets nothing more.
    expect((await checkin(ben, 1)).json.chat).toEqual({ messages: [], last: 1 })
  })

  test('someone who joins late is sent the messages so far, in order, whoever sent them and wherever they are now', async () => {
    const ana = await join('ana', 'Ana')
    const ben = await join('ben', 'Ben')
    await say(ana, 'one')
    h.clock.now += 1000
    await say(ben, 'two')
    // Ben leaves; his message stays under the name he had.
    await h.call('POST', `${base()}/leave`, { generation: ben.generation }, { token: ben.tok })
    const cy = await join('cy', 'Cy')
    const history = (await checkin(cy)).json.chat
    expect(history.messages.map((m: any) => [m.name, m.text])).toEqual([
      ['Ana', 'one'],
      ['Ben', 'two'],
    ])
  })

  test("joining says how far the history goes, so what was there when you arrived is never unread", async () => {
    const first = await join('ana', 'Ana')
    expect(first.chatLast).toBe(0)
    await say(first, 'one')
    const ana = first
    h.clock.now += CHAT_RATE.windowMs
    await say(ana, 'two')
    const cy = await h.call('POST', `${base()}/join`, { name: 'Cy' }, { token: token('cy') })
    expect(cy.json.chatLast).toBe(2)
  })

  test('a request with no token, a token that never joined, or an old generation sends nothing', async () => {
    const ana = await join('ana')
    expect((await h.call('POST', `${base()}/chat`, { generation: 1, text: 'hi' })).status).toBe(401)
    expect((await say({ tok: token('stranger'), generation: 1 }, 'hi')).status).toBe(401)
    expect((await say({ ...ana, generation: ana.generation + 1 }, 'hi')).status).toBe(409)
    expect((await checkin(ana)).json.chat.messages).toEqual([])
  })

  test("a member of one call can neither send into another call nor read it, and a message lands only in its own call", async () => {
    const other = await h.startCall()
    const ana = await join('ana', 'Ana')
    await join('ben', 'Ben', other)
    expect((await say({ ...ana, room: other }, 'wrong room')).status).toBe(401)
    expect((await checkin({ ...ana, room: other })).status).toBe(401)
    await say(ana, 'only here')
    const ben = { tok: token('ben'), generation: 1, room: other }
    expect((await checkin(ben)).json.chat.messages).toEqual([])
  })

  test('someone dropped for silence cannot send until they take their seat again', async () => {
    const ana = await join('ana')
    h.clock.now = T0 + MEMBER_TIMEOUT_MS + 1
    expect((await say(ana, 'still here?')).status).toBe(401)
  })

  test('a name nobody started takes no message, creates nothing, and shows up nowhere', async () => {
    const ghost = 'a'.repeat(20)
    expect((await say({ tok: token('x'), generation: 1, room: ghost }, 'hi')).status).toBe(404)
    expect((await checkin({ tok: token('x'), generation: 1, room: ghost })).status).toBe(404)
    expect(h.writes.get(ghost) ?? 0).toBe(0)
  })
})

describe('what a message may be', () => {
  test('it is kept as text exactly as typed, markup included: the browser renders text, the server never rewrites it into HTML', async () => {
    const ana = await join('ana')
    const text = '<img src=x onerror=alert(1)> & "quotes" https://example.com/?a=1&b=2'
    expect((await say(ana, text)).json.message.text).toBe(text)
  })

  test('control characters and text-direction overrides are removed, line breaks are tidied, the ends are trimmed', () => {
    expect(cleanMessage('  hi\u0000 there‮!\r\n\r\n\r\n\r\nbye\u0007  ')).toBe('hi there!\n\nbye')
    expect(cleanMessage('a\tb')).toBe('a\tb')
    expect(cleanMessage(42)).toBe('')
  })

  test('nothing, only spaces, and a non-string are refused; 2,000 characters are kept and 2,001 are refused', async () => {
    const ana = await join('ana')
    for (const empty of ['', '   \n  ', null, 42, { text: 'x' }]) expect((await say(ana, empty)).status).toBe(400)
    h.clock.now += CHAT_RATE.windowMs
    expect((await say(ana, 'x'.repeat(CHAT_MAX))).status).toBe(201)
    const long = await say(ana, 'x'.repeat(CHAT_MAX + 1))
    expect(long.status).toBe(400)
    expect(long.json.error).toContain('2,000')
    expect((await say(ana, 'x'.repeat(CHAT_MAX * 5 + 1))).status).toBe(400)
  })

  test('the length is checked after cleaning, so characters that are removed do not count', async () => {
    const ana = await join('ana')
    expect((await say(ana, `${'x'.repeat(CHAT_MAX)}\u0000\u0000\u0000`)).status).toBe(201)
  })
})

describe('the rate limit', () => {
  test('six messages in ten seconds, then a wait; it is per person and survives a refresh', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    for (let i = 0; i < CHAT_RATE.max; i++) expect((await say(ana, `m${i}`)).status).toBe(201)
    const refused = await say(ana, 'too many')
    expect(refused.status).toBe(429)
    expect(refused.json.error).toContain('too fast')
    // Ben is not held up by Ana.
    expect((await say(ben, 'hi')).status).toBe(201)
    // A refresh is the same person: the window is still open.
    const again = await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok })
    expect((await say({ ...ana, generation: again.json.generation }, 'sneaky')).status).toBe(429)
    // The next window.
    h.clock.now = T0 + CHAT_RATE.windowMs
    expect((await say({ ...ana, generation: again.json.generation }, 'ok now')).status).toBe(201)
    // The refused one was not stored.
    const texts = (await checkin(ben)).json.chat.messages.map((m: any) => m.text)
    expect(texts).not.toContain('too many')
    expect(texts).not.toContain('sneaky')
  })

  test('a call keeps at most 2,000 messages: a leaked link cannot fill its storage', () => {
    const sql = memSql()
    const core = new RoomCore(sql)
    core.create('k7m2qx9frtn4w6hbc8jd', T0)
    core.join('ha', 'ma', 'Ana', T0, null)
    for (let i = 0; i < CHAT_ROOM_CAP; i++) sql.run("INSERT INTO messages (member_id, name, text, at) VALUES ('ma', 'Ana', 'x', ?)", T0)
    expect(() => core.chat('ha', 1, 'one more', T0)).toThrow('This chat is full.')
  })
})

describe('catching up', () => {
  test('a check-in carries 200 messages at most, so a long history arrives over a few of them, in order, with no gap', () => {
    const sql = memSql()
    const core = new RoomCore(sql)
    core.create('k7m2qx9frtn4w6hbc8jd', T0)
    core.join('ha', 'ma', 'Ana', T0, null)
    for (let i = 1; i <= 450; i++) sql.run("INSERT INTO messages (member_id, name, text, at) VALUES ('ma', 'Ana', ?, ?)", `m${i}`, T0)
    const flags = { muted: false, cameraOff: false }
    const now = T0 + 1000
    let since = 0
    const seen: number[] = []
    for (let pass = 0; pass < 5; pass++) {
      const { chat } = core.checkIn('ha', 1, flags, now, since)
      expect(chat.last).toBe(450)
      for (const m of chat.messages) seen.push(m.id)
      since = chat.messages.at(-1)?.id ?? since
    }
    expect(seen).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
  })
})

describe('a tab that sends no `since`', () => {
  test('a tab that sends no `since` (code from before chat) is sent no messages, only the newest id', async () => {
    const ana = await join('ana', 'Ana')
    await say(ana, 'one')
    const r = await h.call('POST', `${base()}/checkin`, { generation: ana.generation }, { token: ana.tok })
    expect(r.json.chat).toEqual({ messages: [], last: 1 })
    expect((await checkin(ana, 0)).json.chat.messages).toHaveLength(1)
  })
})
