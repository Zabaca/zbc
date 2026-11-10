import { describe, expect, test } from 'bun:test'
import { AGENT, AGENT_ID, asHttp, asker, BRIDGE, harness, OWNER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { account, channel, chat, group, groupMessage, member, message, push } from '../test-support/telegram'

/**
 * Read marks both ways, "like on your phone". Reading a chat on his phone marks it read in the space; opening a conversation in the
 * space marks it read in Telegram, up to exactly the message he was shown. Reading by Claude marks nothing, in either direction, and neither does the bridge's own news of a read.
 *
 * The seam is the same as the store's and the groups' suites: the bridge's door as a function over the real store on a real SQLite, the space's own mark-read for what Tessa does, and Claude's real router for
 * what it can and cannot do. What this cannot show is Telegram: that its read updates carry what the bridge says they do, and that `ReadHistory` marks a chat read. Those are the hand test.
 */

type H = ReturnType<typeof harness>

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const events = async (h: H, body: Record<string, unknown>) =>
  (await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], ...body })).json
const work = async (h: H) => (await h.bridge(BRIDGE, '/api/work', { account })).json
const outcomes = async (h: H, list: unknown[]) =>
  (await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: list })).json
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const conversationOf = (h: H, chatId: string) =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id
const stamps = (h: H, chatId: string) =>
  rows<{ id: number; read_at: string | null; read_by: string | null }>(
    h,
    `SELECT m.telegram_msg_id AS id, m.read_at, m.read_by FROM message m JOIN conversation c ON c.id = m.conversation_id
      WHERE c.telegram_chat_id = '${chatId}' ORDER BY m.telegram_msg_id`,
  )
const unread = (h: H, chatId: string) =>
  stamps(h, chatId)
    .filter((s) => s.read_at === null)
    .map((s) => s.id)
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}

/** What the page shows: how far into the conversation it reached, the number the space sends back with a read. */
const shown = async (h: H, chatId: string): Promise<number> => (await detail(h, conversationOf(h, chatId))).through

/** Tessa opens the conversation in the space: the space's own mark-read, which is the one thing that reads. */
async function open(h: H, chatId: string, through?: number) {
  const a = await asker(OWNER)
  return h
    .space()
    .markRead(a, [{ conversationId: conversationOf(h, chatId), through: through ?? (await shown(h, chatId)) }])
}

const at = (n: number) => `2026-11-05T10:${String(n).padStart(2, '0')}:00Z`
const three = [message({ id: 1 }), message({ id: 2, at: at(1) }), message({ id: 3, at: at(2) })]

describe('opening a conversation in the space marks it read in Telegram, up to what he was shown', () => {
  test('a one-to-one chat: the work the bridge is offered is a read mark up to the newest message he saw', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    expect((await work(h)).owed).toEqual([])

    expect(unwrap(await open(h, '2001')).read).toEqual([conversationOf(h, '2001')])

    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 3 }])
    expect(unread(h, '2001')).toEqual([])
  })

  test('only what he was shown: a message that arrived after the page was drawn refuses the read, and nothing is owed', async () => {
    const h = harness()
    await send(h, push([chat()], three.slice(0, 2)))
    const stale = await shown(h, '2001')
    await send(h, push([chat()], [message({ id: 3, at: at(2) })]))

    const refused = unwrap(await open(h, '2001', stale))
    expect(refused.read).toEqual([])
    expect(refused.notRead).toHaveLength(1)
    expect(unread(h, '2001')).toEqual([1, 2, 3])
    expect((await work(h)).owed).toEqual([])

    // The page reads again and shows message 3: now it is read, and 3 is owed.
    expect(unwrap(await open(h, '2001')).read).toHaveLength(1)
    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 3 }])
  })

  test('only the unread: messages Telegram already had read are not marked again, so the mark is the newest message this read changed', async () => {
    const h = harness()
    // Telegram has 1 and 2 read (the first fill); 3 and 4 came after.
    await send(h, push([chat({ readInboxMaxId: 2 })], three.slice(0, 2), { mirror: true }))
    await send(h, push([chat()], [message({ id: 3, at: at(2) }), message({ id: 4, at: at(3) })]))
    expect(unread(h, '2001')).toEqual([3, 4])

    unwrap(await open(h, '2001'))
    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 4 }])
  })

  test('a conversation with nothing unread owes nothing, however often it is opened', async () => {
    const h = harness()
    await send(h, push([chat({ readInboxMaxId: 3 })], three, { mirror: true }))
    unwrap(await open(h, '2001'))
    unwrap(await open(h, '2001'))
    expect((await work(h)).owed).toEqual([])
    // Tessa's own message is never a reason to mark anything.
    await send(h, push([chat()], [message({ id: 4, at: at(3), out: true })]))
    unwrap(await open(h, '2001'))
    expect((await work(h)).owed).toEqual([])
  })

  test('a later read of the same chat only raises the mark, one row per chat', async () => {
    const h = harness()
    await send(h, push([chat()], three.slice(0, 1)))
    unwrap(await open(h, '2001'))
    await send(h, push([chat()], [message({ id: 2, at: at(1) })]))
    unwrap(await open(h, '2001'))
    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 2 }])
  })

  test('a basic group, a supergroup and a channel each owe their own mark, by their own chat id', async () => {
    const h = harness()
    const basic = '-4455'
    const super_ = '-1001234567'
    const broadcast = '-1009876543'
    await send(
      h,
      push(
        [group({ id: basic, title: 'Family' })],
        [groupMessage({ chatId: basic, id: 7, sender: member('3001', 'Ana') })],
      ),
    )
    await send(
      h,
      push(
        [group({ id: super_ })],
        [
          groupMessage({ id: 11, sender: member('3001', 'Ana') }),
          groupMessage({ id: 12, at: at(1), sender: member('3002', 'Ben') }),
        ],
      ),
    )
    await send(
      h,
      push([channel({ id: broadcast })], [groupMessage({ chatId: broadcast, id: 31, text: 'Status: all green' })]),
    )

    for (const id of [basic, super_, broadcast]) unwrap(await open(h, id))

    const owed = (await work(h)).owed as { kind: string; chatId: string; upTo: number }[]
    expect(owed.map((o) => `${o.chatId}:${o.upTo}`).sort()).toEqual(
      [`${basic}:7`, `${super_}:12`, `${broadcast}:31`].sort(),
    )
    expect(owed.every((o) => o.kind === 'read')).toBe(true)
  })

  test('work offers a mark again until an outcome settles it (a bridge that died between asking and telling is simply offered it again)', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    unwrap(await open(h, '2001'))
    expect((await work(h)).owed).toHaveLength(1)
    expect((await work(h)).owed).toHaveLength(1)
  })

  test('what is still owed is on Claude’s script’s `telegram` read: a count and when the oldest was set, and nothing once the outcome settles it', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    const status = async () => (await h.request(AGENT, 'GET', '/api/telegram')).json.mailboxes[0]
    expect(await status()).toMatchObject({ readMarksOwed: 0, oldestReadMarkOwed: null })

    unwrap(await open(h, '2001'))
    expect(await status()).toMatchObject({ readMarksOwed: 1, oldestReadMarkOwed: expect.any(String) })

    await outcomes(h, [{ kind: 'read', chatId: '2001', upTo: 3, ok: true }])
    expect(await status()).toMatchObject({ readMarksOwed: 0, oldestReadMarkOwed: null })
  })
})

describe('what became of a mark the bridge was owed', () => {
  test('done settles it; a second report of the same is counted and changes nothing', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    unwrap(await open(h, '2001'))

    expect(await outcomes(h, [{ kind: 'read', chatId: '2001', upTo: 3, ok: true }])).toEqual({ settled: 1, unknown: 0 })
    expect((await work(h)).owed).toEqual([])
    expect(await outcomes(h, [{ kind: 'read', chatId: '2001', upTo: 3, ok: true }])).toEqual({ settled: 0, unknown: 1 })
  })

  test('a mark raised while the old one was in flight is kept: the old outcome settles nothing', async () => {
    const h = harness()
    await send(h, push([chat()], three.slice(0, 2)))
    unwrap(await open(h, '2001'))
    await send(h, push([chat()], [message({ id: 3, at: at(2) })]))
    unwrap(await open(h, '2001'))

    expect(await outcomes(h, [{ kind: 'read', chatId: '2001', upTo: 2, ok: true }])).toEqual({ settled: 0, unknown: 1 })
    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 3 }])
  })

  test('a mark Telegram refused for good is settled and put on record with the reason, and the space keeps the chat read', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 5, sender: member('3001', 'Ana') })]))
    unwrap(await open(h, '-1001234567'))

    expect(
      await outcomes(h, [{ kind: 'read', chatId: '-1001234567', upTo: 5, ok: false, reason: 'CHANNEL_PRIVATE' }]),
    ).toEqual({
      settled: 1,
      unknown: 0,
    })
    expect((await work(h)).owed).toEqual([])
    expect(unread(h, '-1001234567')).toEqual([])
    expect(
      rows<{ actor: string; after: string }>(
        h,
        `SELECT actor, after FROM audit WHERE action = 'telegram.read-mark-failed'`,
      ),
    ).toEqual([{ actor: 'telegram', after: JSON.stringify({ reason: 'CHANNEL_PRIVATE' }) }])
  })

  test('an outcome is checked like every call: the shape, the bound, a reason that is plain words', async () => {
    const h = harness()
    const bad = [
      { kind: 'send', chatId: '2001', upTo: 3, ok: true },
      { kind: 'read', chatId: 'dana', upTo: 3, ok: true },
      { kind: 'read', chatId: '2001', upTo: 0, ok: true },
      { kind: 'read', chatId: '2001', upTo: 3 },
      { kind: 'read', chatId: '2001', upTo: 3, ok: false },
      { kind: 'read', chatId: '2001', upTo: 3, ok: false, reason: 'a message text <script>' },
    ]
    for (const o of bad)
      expect((await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: [o] })).status, JSON.stringify(o)).toBe(422)
    const many = Array.from({ length: 101 }, () => ({ kind: 'read', chatId: '2001', upTo: 3, ok: true }))
    expect((await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: many })).status).toBe(422)
  })
})

describe('reading a chat on his phone marks it read in the space', () => {
  test('every message of the other side at or below the mark is read, as Telegram; the ones above stay unread; nothing is owed back', async () => {
    const h = harness()
    await send(h, push([chat()], [...three, message({ id: 4, at: at(3) })]))

    const res = await events(h, { reads: [{ chatId: '2001', upTo: 3, at: at(5) }] })
    expect(res).toEqual({ edited: 0, deleted: 0, read: 3, unknown: 0 })

    expect(stamps(h, '2001')).toEqual([
      { id: 1, read_at: expect.any(String), read_by: 'telegram' },
      { id: 2, read_at: expect.any(String), read_by: 'telegram' },
      { id: 3, read_at: expect.any(String), read_by: 'telegram' },
      { id: 4, read_at: null, read_by: null },
    ])
    expect((await work(h)).owed).toEqual([])
  })

  test('the conversation stops being unread in the queue when the last unread message is read', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=unread')).json.rows).toHaveLength(1)
    await events(h, { reads: [{ chatId: '2001', upTo: 3, at: at(5) }] })
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=unread')).json.rows).toHaveLength(0)
  })

  test('it never marks anything unread, never touches a message already read by Tessa, and a mark below what is read changes nothing', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    unwrap(await open(h, '2001'))
    const before = stamps(h, '2001')
    expect(await events(h, { reads: [{ chatId: '2001', upTo: 2, at: at(5) }] })).toEqual({
      edited: 0,
      deleted: 0,
      read: 0,
      unknown: 0,
    })
    expect(stamps(h, '2001')).toEqual(before)
    expect(before.every((s) => s.read_by === OWNER_EMAIL)).toBe(true)
  })

  test('a group, a supergroup and a channel are marked by their own chat, and one chat’s mark never reaches another’s message with the same id', async () => {
    const h = harness()
    const other = '-1001111111'
    await send(h, push([group()], [groupMessage({ id: 5, sender: member('3001', 'Ana') })]))
    await send(
      h,
      push(
        [group({ id: other, title: 'Other' })],
        [groupMessage({ chatId: other, id: 5, sender: member('3001', 'Ana') })],
      ),
    )
    await send(h, push([chat()], [message({ id: 5 })]))

    expect(await events(h, { reads: [{ chatId: '-1001234567', upTo: 5, at: at(5) }] })).toMatchObject({ read: 1 })
    expect(unread(h, '-1001234567')).toEqual([])
    expect(unread(h, other)).toEqual([5])
    expect(unread(h, '2001')).toEqual([5])
  })

  test('a mark for a chat the space does not hold is counted and stored nowhere', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    expect(await events(h, { reads: [{ chatId: '9999', upTo: 3, at: at(5) }] })).toMatchObject({ read: 0, unknown: 1 })
    expect(unread(h, '2001')).toEqual([1, 2, 3])
  })

  test('a read mark and an edit in one call both apply, and a call from a bridge that sends no reads is as it always was', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    expect(
      await events(h, {
        edits: [{ chatId: '2001', id: 1, text: 'fixed', at: at(4) }],
        reads: [{ chatId: '2001', upTo: 2, at: at(5) }],
      }),
    ).toEqual({ edited: 1, deleted: 0, read: 2, unknown: 0 })
    expect(await events(h, {})).toEqual({ edited: 0, deleted: 0, read: 0, unknown: 0 })
  })

  test('reads are bounded and checked like the rest of a call', async () => {
    const h = harness()
    const bad = [
      { chatId: 'dana', upTo: 3, at: at(5) },
      { chatId: '2001', upTo: 0, at: at(5) },
      { chatId: '2001', upTo: 3, at: 'now' },
    ]
    for (const r of bad)
      expect((await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], reads: [r] })).status).toBe(
        422,
      )
    const many = Array.from({ length: 501 }, () => ({ chatId: '2001', upTo: 3, at: at(5) }))
    expect((await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], reads: many })).status).toBe(422)
  })
})

describe('only Tessa opening a conversation in the space counts', () => {
  test('Claude reading the queue, a conversation and a search marks nothing and owes Telegram nothing, and its door has no read', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    const id = conversationOf(h, '2001')
    const before = JSON.stringify(stamps(h, '2001'))

    await h.request(AGENT, 'GET', '/api/queue')
    await detail(h, id)
    await h.request(AGENT, 'GET', '/api/search?q=message')
    expect(
      (await h.request(AGENT, 'POST', `/api/conversations/${id}/read`, { through: await shown(h, '2001') })).status,
    ).toBe(404)

    expect(JSON.stringify(stamps(h, '2001'))).toBe(before)
    expect((await work(h)).owed).toEqual([])
    expect(rows(h, `SELECT key FROM setting WHERE key LIKE 'telegram-read-owed:%'`)).toEqual([])
  })

  test('closing and reopening, which Claude may do, owe Telegram nothing either', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    const id = conversationOf(h, '2001')
    expect(
      (await h.request(AGENT, 'POST', `/api/conversations/${id}/close`, { through: await shown(h, '2001') })).status,
    ).toBe(200)
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/reopen`, {})).status).toBe(200)
    expect((await work(h)).owed).toEqual([])
  })

  test('a read made by anyone but the owner owes nothing, even if it reached the store (the owner’s actor is the only one that does)', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    const id = conversationOf(h, '2001')
    const through = await shown(h, '2001')
    expect(asHttp(await h.store.call('changeConversation', id, 'read', `agent:${AGENT_ID}`, through)).status).toBe(200)
    expect((await work(h)).owed).toEqual([])
  })

  test('the owner’s read through the store owes the mark exactly as the space’s does', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    const id = conversationOf(h, '2001')
    expect(
      asHttp(await h.store.call('changeConversation', id, 'read', OWNER_EMAIL, await shown(h, '2001'))).status,
    ).toBe(200)
    expect((await work(h)).owed).toEqual([{ kind: 'read', chatId: '2001', upTo: 3 }])
  })

  test('the bridge’s own news of a read, and a first fill or a read-through that finds a chat read, owe nothing back', async () => {
    const h = harness()
    await send(h, push([chat()], three))
    await events(h, { reads: [{ chatId: '2001', upTo: 3, at: at(5) }] })
    await send(
      h,
      push([chat({ readInboxMaxId: 5 })], [message({ id: 4, at: at(3) }), message({ id: 5, at: at(4) })], {
        mirror: true,
      }),
    )
    expect(unread(h, '2001')).toEqual([])
    expect((await work(h)).owed).toEqual([])
  })
})
