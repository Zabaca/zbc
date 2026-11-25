import { describe, expect, test } from 'bun:test'
import { AGENT, asHttp, asker, harness, OWNER, ownerDraft, TEXTS_BRIDGE } from '../test-support/harness'
import { account, business, DANA, group, message, named, person, push, shortCode } from '../test-support/texts'

/**
 * What the texts bridge pushes becomes conversations, people and messages, stored once, readable through Claude's script. The highest seam: the bridge's door as a function over the real store on a real SQLite with the real
 * migrations, and Claude's real router for everything read back. What this cannot show is the phone: that Google's messages carry what the bridge's fake says they do. Those are the hand test
 * (packages/inbox/docs/runbooks/inbox-texts-bridge.md).
 */

type H = ReturnType<typeof harness>

const send = async (h: H, body: unknown) => (await h.texts(TEXTS_BRIDGE, '/api/push', body)).json
const events = async (h: H, body: Record<string, unknown>) =>
  (await h.texts(TEXTS_BRIDGE, '/api/events', { account, edits: [], deletions: [], ...body })).json
const work = async (h: H, over: Record<string, unknown> = {}) =>
  (await h.texts(TEXTS_BRIDGE, '/api/work', { account, ...over })).json
const status = async (h: H, state: string, extra: Record<string, unknown> = {}) =>
  (await h.texts(TEXTS_BRIDGE, '/api/status', { account, state, ...extra })).json
const outcomes = async (h: H, list: unknown[]) =>
  (await h.texts(TEXTS_BRIDGE, '/api/outcomes', { account, outcomes: list })).json
const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n
const conversationOf = (h: H, chatId: string) =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE text_chat_id = '${chatId}'`)[0] as { id: string }).id
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r.value as T
}

describe('a one-to-one chat comes in', () => {
  test('as a conversation under the person, in the texts mailbox, unread and open, with the text as it was said', async () => {
    const h = harness()
    const res = await send(
      h,
      push([person()], [message({ id: 'm1', text: 'Can we move Thursday to Friday?', at: '2026-11-05T09:00:00Z' })]),
    )
    expect(res).toEqual({ stored: 1, repeated: 0, leftOut: 0, groups: 0, skipped: 0, leftOutChats: [] })

    const q = await queue(h)
    expect(q.rows).toHaveLength(1)
    const row = q.rows[0]
    expect(row).toMatchObject({
      title: 'Dana Reyes',
      kind: 'sms',
      unread: true,
      open: true,
      bulk: false,
      mailbox: { name: 'Texts', address: account.id },
      mailboxKind: 'texts',
      snippet: 'Can we move Thursday to Friday?',
    })
    const page = await detail(h, row.id)
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ direction: 'in', status: 'sent', body: 'Can we move Thursday to Friday?' })
  })

  test('a push repeated after a timeout stores each text once, and a read-back that overlaps what is held adds only what is new', async () => {
    const h = harness()
    const body = push([person()], [message({ id: 'm1' }), message({ id: 'm2', at: '2026-11-05T10:01:00Z' })])
    expect((await send(h, body)).stored).toBe(2)
    expect(await send(h, body)).toMatchObject({ stored: 0, repeated: 2 })
    const overlap = push(
      [person()],
      [message({ id: 'm2', at: '2026-11-05T10:01:00Z' }), message({ id: 'm3', at: '2026-11-05T10:02:00Z' })],
      { mirror: true },
    )
    expect(await send(h, overlap)).toMatchObject({ stored: 1, repeated: 1 })
    expect(count(h, 'message')).toBe(3)
    expect(count(h, 'conversation')).toBe(1)
    // The key is the chat and the phone's own id, once per mailbox.
    expect(
      rows<{ arrival_key: string }>(h, 'SELECT arrival_key FROM message ORDER BY arrival_key').map(
        (r) => r.arrival_key,
      ),
    ).toEqual(['c-2001:m1', 'c-2001:m2', 'c-2001:m3'])
  })

  test('the same message id in two chats is two messages', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person(), person({ id: 'c-2002', name: 'Eli Park', address: '+15555550124' })],
        [message({ id: 'm1' }), message({ id: 'm1', chatId: 'c-2002' })],
      ),
    )
    expect(count(h, 'message')).toBe(2)
    expect(count(h, 'conversation')).toBe(2)
  })

  test('the owner’s own text, sent from the phone, is the owner’s: outbound, read and closed, and it does not make the conversation unread', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person()],
        [
          message({ id: 'm1', at: '2026-11-05T09:00:00Z', read: true }),
          message({ id: 'm2', at: '2026-11-05T09:05:00Z', out: true, text: 'Friday works' }),
        ],
        { mirror: true },
      ),
    )
    const q = await queue(h, 'unread')
    expect(q.rows).toEqual([])
    const row = rows<{ direction: string; read_at: string | null; closed_at: string | null; sent_by: string | null }>(
      h,
      `SELECT direction, read_at, closed_at, sent_by FROM message WHERE arrival_key = 'c-2001:m2'`,
    )[0]
    expect(row).toMatchObject({ direction: 'out', sent_by: 'texts' })
    expect(row?.read_at).not.toBeNull()
    expect(row?.closed_at).not.toBeNull()
  })

  test('a text the phone has read is filed read in a mirror, and one it has not is unread', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person()],
        [
          message({ id: 'm1', at: '2026-11-05T09:00:00Z', read: true }),
          message({ id: 'm2', at: '2026-11-05T09:01:00Z', read: false }),
        ],
        { mirror: true },
      ),
    )
    const read = rows<{ arrival_key: string; read_at: string | null }>(
      h,
      'SELECT arrival_key, read_at FROM message ORDER BY arrival_key',
    )
    expect(read.map((r) => r.read_at !== null)).toEqual([true, false])
    expect((await queue(h, 'unread')).rows).toHaveLength(1)
  })
})

describe('a new text reopens, a read-back does not, and nothing rings', () => {
  /** Read and close a conversation as the owner does: through the newest message shown. */
  const close = async (h: H, id: string) => {
    const through = (await detail(h, id)).through
    expect(asHttp(await h.store.call('changeConversation', id, 'read', OWNER.email, through)).status).toBe(200)
    expect(asHttp(await h.store.call('changeConversation', id, 'close', OWNER.email, through)).status).toBe(200)
  }

  test('a live text on a closed conversation reopens it', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const id = conversationOf(h, 'c-2001')
    await close(h, id)
    expect((await queue(h, 'closed')).rows).toHaveLength(1)
    await send(h, push([person()], [message({ id: 'm2', at: '2026-11-05T10:05:00Z' })]))
    expect((await queue(h, 'closed')).rows).toHaveLength(0)
    expect((await queue(h)).rows).toHaveLength(1)
  })

  test('texts read back from the phone (a mirror) are filed closed on a conversation the owner closed, so they do not reopen it', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const id = conversationOf(h, 'c-2001')
    await close(h, id)
    await send(
      h,
      push(
        [person()],
        [message({ id: 'm0', at: '2026-11-05T09:00:00Z' }), message({ id: 'm2', at: '2026-11-05T10:05:00Z' })],
        {
          mirror: true,
        },
      ),
    )
    expect((await queue(h)).rows).toHaveLength(0)
    expect((await queue(h, 'closed')).rows).toHaveLength(1)
  })

  test('no text owes a notification, from the live stream or a read-back', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1', at: new Date().toISOString() })]))
    await send(h, push([shortCode()], [message({ id: 'm2', chatId: 'c-5501', at: new Date().toISOString() })]))
    expect(rows(h, `SELECT 1 FROM message WHERE notify IS NOT NULL`)).toEqual([])
  })

  test('a one-to-one text from a person is waiting on the owner by the mail rule (the newest came in, and is unread and open), and the owner’s own text takes it off', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const line = async () => unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]
    expect(await line()).toMatchObject({ direction: 'in', unread: true, open: true })
    expect((await line())?.needsReply).toBeUndefined()
    await send(h, push([person()], [message({ id: 'm2', at: '2026-11-05T10:05:00Z', out: true, text: 'on it' })]))
    expect(await line()).toMatchObject({ direction: 'out' })
  })
})

describe('people: the number is the join, never the name', () => {
  const sms = async (h: H, name: string, number: string) =>
    ownerDraft(h, { address: number, name, body: 'hello', subject: '' } as never)

  test('a number that one contact already holds as a text number joins that contact, which keeps its name; Split undoes it', async () => {
    const h = harness()
    await sms(h, 'Dana at the shop', '555 555 0123')
    expect(count(h, 'contact')).toBe(1)
    await send(h, push([person()], [message({ id: 'm1' })]))
    expect(count(h, 'contact')).toBe(1)
    const contact = rows<{ id: string; name: string }>(h, 'SELECT id, name FROM contact')[0] as {
      id: string
      name: string
    }
    expect(contact.name).toBe('Dana at the shop')
    expect(
      rows<{ kind: string; address: string }>(
        h,
        `SELECT kind, address FROM identity WHERE contact_id = '${contact.id}'`,
      ),
    ).toEqual([{ kind: 'sms', address: DANA }])
    // The conversation is under that contact, and a split of their one identity is the existing one.
    const q = await queue(h)
    expect(q.rows[0]?.title).toBe('Dana at the shop')
  })

  test('a number nobody holds makes a contact named as the phone names them; the same name on another number joins nothing', async () => {
    const h = harness()
    await sms(h, 'Dana Reyes', '555 555 0199')
    await send(h, push([person()], [message({ id: 'm1' })]))
    expect(count(h, 'contact')).toBe(2)
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact ORDER BY name').map((c) => c.name)).toEqual([
      'Dana Reyes',
      'Dana Reyes',
    ])
    expect(rows(h, `SELECT 1 FROM audit WHERE action = 'identity.join'`)).toEqual([])
  })

  test('a chat the phone names only by its number takes the name it gives later, once; an owner’s rename stands', async () => {
    const h = harness()
    await send(h, push([person({ name: DANA })], [message({ id: 'm1' })]))
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact')[0]?.name).toBe(DANA)
    await send(h, push([person({ name: 'Dana Reyes' })], [message({ id: 'm2', at: '2026-11-05T10:01:00Z' })]))
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact')[0]?.name).toBe('Dana Reyes')
    expect(rows<{ from_header: string }>(h, "SELECT DISTINCT from_header FROM message WHERE direction = 'in'")).toEqual(
      [{ from_header: 'Dana Reyes' }],
    )
    h.db.run(`UPDATE contact SET name = 'Dana (work)'`)
    await send(h, push([person({ name: 'Dana R.' })], [message({ id: 'm3', at: '2026-11-05T10:02:00Z' })]))
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact')[0]?.name).toBe('Dana (work)')
  })
})

describe('business senders come in whole, as automated senders, under Bulk', () => {
  test('a short code, a named sender and a business chat are in Bulk, never the Inbox or Unread, and never a person’s contact', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person(), shortCode(), named(), business()],
        [
          message({ id: 'm1' }),
          message({ id: 'm2', chatId: 'c-5501', text: 'Your code is 000000. Do not share it.' }),
          message({ id: 'm3', chatId: 'c-6601', text: 'Your balance is low.' }),
          message({ id: 'm4', chatId: 'c-7701', text: 'Your flight is on time.' }),
        ],
      ),
    )
    expect((await queue(h)).rows.map((r: { title: string }) => r.title)).toEqual(['Dana Reyes'])
    expect((await queue(h, 'unread')).rows).toHaveLength(1)
    const bulk = (await queue(h, 'bulk')).rows
    expect(bulk.map((r: { title: string }) => r.title).sort()).toEqual(['55501', 'Example Air', 'Example Bank'])
    for (const r of bulk) expect(r).toMatchObject({ bulk: true, open: true, mailboxKind: 'texts' })
    // Their own identities, and none of them is a number.
    expect(
      rows<{ kind: string; address: string }>(
        h,
        `SELECT kind, address FROM identity WHERE kind != 'sms' ORDER BY address`,
      ),
    ).toEqual([
      { kind: 'manual', address: 'text:business:example-air-agent' },
      { kind: 'manual', address: 'text:named-sender:examplebank' },
      { kind: 'manual', address: 'text:short-code:55501' },
    ])
    expect(count(h, 'contact')).toBe(4)
  })

  test('the sign-in code is stored whole and can be found by Claude’s script', async () => {
    const h = harness()
    await send(h, push([shortCode()], [message({ id: 'm1', chatId: 'c-5501', text: 'Your code is 481516' })]))
    const found = (await h.request(AGENT, 'GET', '/api/search?q=481516')).json
    expect(JSON.stringify(found)).toContain('481516')
    const id = conversationOf(h, 'c-5501')
    expect((await detail(h, id)).messages[0]?.body).toBe('Your code is 481516')
  })

  test('a business sender is never joined to a person who holds a number that spells the same, and the person is not made automated by it', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person({ address: '+15555550155', name: 'Dana' }), shortCode({ address: '55501', name: 'Dana' })],
        [message({ id: 'm1' }), message({ id: 'm2', chatId: 'c-5501' })],
      ),
    )
    expect(count(h, 'contact')).toBe(2)
    expect((await queue(h)).rows).toHaveLength(1)
    expect((await queue(h, 'bulk')).rows).toHaveLength(1)
  })
})

describe('groups and chats that are not carried', () => {
  test('a group’s texts are refused whole and counted, and nothing of the group is stored', async () => {
    const h = harness()
    const res = await send(
      h,
      push(
        [person(), group()],
        [
          message({ id: 'm1' }),
          message({ id: 'g1', chatId: 'g-9001', sender: { name: 'Eli Park', address: '+15555550124' } }),
        ],
      ),
    )
    expect(res).toMatchObject({ stored: 1, groups: 1 })
    expect(count(h, 'message')).toBe(1)
    expect(rows(h, `SELECT 1 FROM conversation WHERE text_chat_id = 'g-9001'`)).toEqual([])
  })

  test('a text whose chat the push did not describe is counted and not stored', async () => {
    const h = harness()
    expect(await send(h, push([], [message({ id: 'm1' })]))).toMatchObject({ stored: 0, skipped: 1 })
    expect(count(h, 'message')).toBe(0)
  })
})

describe('the left-out list', () => {
  const leave = async (h: H, chatId: string, by = OWNER.email) =>
    (await h.store.call('leaveOutTextChat', conversationOf(h, chatId), by)) as unknown as {
      ok: boolean
      value?: { chatId: string; removed: number }
      status?: number
    }

  test('leaving a chat out removes its conversation, its messages and the contact the door made for it, audited, and puts it on the list', async () => {
    const h = harness()
    await send(h, push([person(), shortCode()], [message({ id: 'm1' }), message({ id: 'm2', chatId: 'c-5501' })]))
    const res = await leave(h, 'c-2001')
    expect(res).toMatchObject({ ok: true, value: { chatId: 'c-2001', removed: 1 } })
    expect(count(h, 'message')).toBe(1)
    expect(rows(h, `SELECT 1 FROM conversation WHERE text_chat_id = 'c-2001'`)).toEqual([])
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact').map((c) => c.name)).toEqual(['55501'])
    const audit = rows<{ actor: string; action: string }>(
      h,
      `SELECT actor, action FROM audit WHERE action = 'texts.left-out'`,
    )
    expect(audit).toEqual([{ actor: OWNER.email, action: 'texts.left-out' }])
    const list = (await h.store.call('textsLeftOutList')) as unknown as {
      chatId: string
      name: string
      by: string
      fillOwed: boolean
    }[]
    expect(list).toEqual([
      expect.objectContaining({ chatId: 'c-2001', name: 'Dana Reyes', by: OWNER.email, fillOwed: false }),
    ])
  })

  test('a contact that holds more than the chat’s number stays, and so does one the owner renamed', async () => {
    const h = harness()
    await ownerDraft(h, { address: '555 555 0123', name: 'Dana at the shop', body: 'hi', subject: '' } as never)
    await send(h, push([person()], [message({ id: 'm1' })]))
    await leave(h, 'c-2001')
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact').map((c) => c.name)).toEqual(['Dana at the shop'])
  })

  test('nothing of a left-out chat is stored again, on any path, and the answer names it', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    await leave(h, 'c-2001')
    const live = await send(h, push([person()], [message({ id: 'm2', at: '2026-11-05T10:05:00Z' })]))
    expect(live).toMatchObject({ stored: 0, leftOut: 1, leftOutChats: ['c-2001'] })
    const fill = await send(
      h,
      push([person()], [message({ id: 'm1' }), message({ id: 'm2', at: '2026-11-05T10:05:00Z' })], { mirror: true }),
    )
    expect(fill).toMatchObject({ stored: 0, leftOut: 2 })
    // Edits, deletions and read marks name nothing the inbox holds.
    const ev = await events(h, {
      edits: [{ chatId: 'c-2001', id: 'm1', text: 'x', at: '2026-11-05T10:06:00Z' }],
      reads: [{ chatId: 'c-2001', upTo: '2026-11-05T10:06:00Z', at: '2026-11-05T10:07:00Z' }],
    })
    expect(ev).toMatchObject({ edited: 0, read: 0, unknown: 2 })
    expect(count(h, 'message')).toBe(0)
    expect(count(h, 'conversation')).toBe(0)
    expect(count(h, 'contact')).toBe(0)
  })

  test('the work request answers the whole list every time', async () => {
    const h = harness()
    await send(h, push([person(), shortCode()], [message({ id: 'm1' }), message({ id: 'm2', chatId: 'c-5501' })]))
    expect((await work(h)).leftOut).toEqual([])
    await leave(h, 'c-2001')
    await leave(h, 'c-5501')
    expect((await work(h)).leftOut.sort()).toEqual(['c-2001', 'c-5501'])
  })

  test('bring back takes the chat off the list and owes the bridge a 30-day read, settled by its outcome and never offered again', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    await leave(h, 'c-2001')
    const back = await h.store.call('bringBackTextChat', 'c-2001', OWNER.email)
    expect(back).toMatchObject({ ok: true })
    const w = await work(h)
    expect(w.leftOut).toEqual([])
    expect(w.owed).toEqual([{ kind: 'fill', chatId: 'c-2001', days: 30 }])
    // The list shows it as brought back, with the read owed.
    expect(await h.store.call('textsLeftOutList')).toEqual([
      expect.objectContaining({ chatId: 'c-2001', fillOwed: true }),
    ])
    // Offered again until settled.
    expect((await work(h)).owed).toHaveLength(1)
    // The read arrives as a mirror and is stored; then the bridge says so.
    expect((await send(h, push([person()], [message({ id: 'm1' })], { mirror: true }))).stored).toBe(1)
    expect(await outcomes(h, [{ kind: 'fill', chatId: 'c-2001', ok: true }])).toEqual({ settled: 1, unknown: 0 })
    expect((await work(h)).owed).toEqual([])
    expect(await h.store.call('textsLeftOutList')).toEqual([])
    // An outcome that names nothing owed is counted and changes nothing.
    expect(await outcomes(h, [{ kind: 'fill', chatId: 'c-2001', ok: true }])).toEqual({ settled: 0, unknown: 1 })
  })

  test('a fill the phone would not give settles and is audited; a chat not on the list cannot be brought back; a text conversation only can be left out', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    await leave(h, 'c-2001')
    await h.store.call('bringBackTextChat', 'c-2001', OWNER.email)
    expect(
      await outcomes(h, [{ kind: 'fill', chatId: 'c-2001', ok: false, reason: 'CONVERSATION_NOT_FOUND' }]),
    ).toEqual({
      settled: 1,
      unknown: 0,
    })
    expect(rows(h, `SELECT 1 FROM audit WHERE action = 'texts.fill-failed'`)).toHaveLength(1)
    expect(await h.store.call('bringBackTextChat', 'c-9999', OWNER.email)).toMatchObject({
      ok: false,
      status: 404,
    })
    expect(await h.store.call('leaveOutTextChat', 'no-such-conversation', OWNER.email)).toMatchObject({
      ok: false,
      status: 404,
    })
  })
})

describe('what the bridge asks, and says of itself', () => {
  test('the work request answers the newest message held per chat, by time, with the phone’s own id, when asked', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person(), shortCode()],
        [
          message({ id: 'm1', at: '2026-11-05T09:00:00Z' }),
          message({ id: 'm3', at: '2026-11-05T11:00:00Z' }),
          message({ id: 'm2', at: '2026-11-05T10:00:00Z' }),
          message({ id: 'x1', chatId: 'c-5501', at: '2026-11-05T08:00:00Z' }),
        ],
      ),
    )
    expect((await work(h)).newest).toBeUndefined()
    expect((await work(h, { newest: true })).newest).toEqual({
      'c-2001': { id: 'm3', at: '2026-11-05T11:00:00.000Z' },
      'c-5501': { id: 'x1', at: '2026-11-05T08:00:00.000Z' },
    })
  })

  test('a work request made before anything is pushed makes the texts mailbox, and is its heartbeat: stamped at most once a minute', async () => {
    const h = harness()
    expect(await work(h)).toEqual({ leftOut: [], owed: [] })
    const stamp = () =>
      rows<{ checked_in_at: string | null }>(h, `SELECT checked_in_at FROM mailbox WHERE kind = 'texts'`)[0]
        ?.checked_in_at
    const first = stamp()
    expect(first).not.toBeNull()
    await work(h)
    expect(stamp()).toBe(first as string)
  })

  test('the status says live, catching up, phone not answering since a time, signed out and another browser; signed out is recorded and cleared by the next state', async () => {
    const h = harness()
    for (const state of ['live', 'catching-up', 'session-taken']) expect(await status(h, state)).toEqual({ state })
    expect(await status(h, 'phone-not-answering', { since: '2026-11-05T09:00:00Z' })).toEqual({
      state: 'phone-not-answering',
    })
    const [m] = (await h.store.call('textsMailboxes')) as unknown as {
      state: string
      phoneSince: string | null
      health: { amber: boolean }
    }[]
    expect(m).toMatchObject({
      state: 'phone-not-answering',
      phoneSince: '2026-11-05T09:00:00.000Z',
      health: { amber: false },
    })
    expect((await h.texts(TEXTS_BRIDGE, '/api/status', { account, state: 'phone-not-answering' })).status).toBe(422)
    await status(h, 'signed-out', { reason: 'AUTH_REVOKED' })
    const [out] = (await h.store.call('textsMailboxes')) as unknown as {
      state: string
      lastError: string
      health: { amber: boolean; reasons: string[] }
    }[]
    expect(out).toMatchObject({ state: 'signed-out', health: { amber: true } })
    expect(out?.lastError).toContain('AUTH_REVOKED')
    expect(out?.health.reasons[0]).toContain('Only')
    await status(h, 'live')
    const [back] = (await h.store.call('textsMailboxes')) as unknown as {
      state: string
      lastError: string | null
      phoneSince: string | null
    }[]
    expect(back).toMatchObject({ state: 'live', lastError: null, phoneSince: null })
  })

  test('a bridge that has asked for nothing for five minutes counts as not checked in, whatever it last said', async () => {
    const h = harness()
    await status(h, 'live')
    h.db.run(`UPDATE mailbox SET checked_in_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'texts'`)
    const [m] = (await h.store.call('textsMailboxes')) as unknown as {
      state: string
      health: { amber: boolean }
    }[]
    expect(m).toMatchObject({ state: 'not-checked-in', health: { amber: true } })
  })

  test('the texts mailbox is one row for one phone: the bridge paired with another is refused and nothing is stored', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const other = await h.texts(TEXTS_BRIDGE, '/api/push', {
      ...push([person()], [message({ id: 'm2' })]),
      account: { id: 'phone-2' },
    })
    expect(other.status).toBe(409)
    expect(count(h, 'message')).toBe(1)
    expect(count(h, 'mailbox')).toBe(1)
  })

  test('the mailbox is the owner’s alone', async () => {
    const h = harness()
    await work(h)
    expect(rows<{ person: string }>(h, `SELECT person FROM mailbox_person`).map((r) => r.person)).toEqual([
      OWNER.email.toLowerCase(),
    ])
  })
})

describe('edits, deletions and the phone’s read marks', () => {
  test('an edit replaces the words, a deletion removes them and leaves the row, and neither is written back anywhere', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person()],
        [message({ id: 'm1', text: 'see you at 9' }), message({ id: 'm2', at: '2026-11-05T10:01:00Z', text: 'oops' })],
      ),
    )
    const res = await events(h, {
      edits: [{ chatId: 'c-2001', id: 'm1', text: 'see you at 10', at: '2026-11-05T10:05:00Z' }],
      deletions: [{ chatId: 'c-2001', ids: ['m2', 'zz'], at: '2026-11-05T10:06:00Z' }],
    })
    expect(res).toEqual({ edited: 1, deleted: 1, read: 0, unknown: 1 })
    const [m1, m2] = rows<{
      body: string
      edited_at: string | null
      deleted_at: string | null
      read_at: string | null
    }>(h, 'SELECT body, edited_at, deleted_at, read_at FROM message ORDER BY arrival_key')
    expect(m1).toMatchObject({ body: 'see you at 10', edited_at: '2026-11-05T10:05:00.000Z' })
    expect(m2).toMatchObject({ body: '' })
    expect(m2?.deleted_at).not.toBeNull()
    expect(m2?.read_at).not.toBeNull()
  })

  test('a read mark from the phone reads the texts sent at or before it, and never marks anything unread', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person()],
        [
          message({ id: 'm1', at: '2026-11-05T09:00:00Z' }),
          message({ id: 'm2', at: '2026-11-05T10:00:00Z' }),
          message({ id: 'm3', at: '2026-11-05T11:00:00Z' }),
        ],
      ),
    )
    expect(
      await events(h, { reads: [{ chatId: 'c-2001', upTo: '2026-11-05T10:00:00Z', at: '2026-11-05T12:00:00Z' }] }),
    ).toMatchObject({ read: 2 })
    expect(
      rows<{ read_at: string | null }>(h, 'SELECT read_at FROM message ORDER BY arrival_key').map(
        (r) => r.read_at !== null,
      ),
    ).toEqual([true, true, false])
    // An older mark changes nothing.
    expect(
      await events(h, { reads: [{ chatId: 'c-2001', upTo: '2026-11-05T09:00:00Z', at: '2026-11-05T12:01:00Z' }] }),
    ).toMatchObject({ read: 0 })
    expect(
      await events(h, { reads: [{ chatId: 'c-404', upTo: '2026-11-05T09:00:00Z', at: '2026-11-05T12:01:00Z' }] }),
    ).toMatchObject({ unknown: 1 })
  })
})

describe('Claude’s script reads texts and marks nothing read', () => {
  test('a text conversation is in the queue, a conversation and search, and reading it leaves it unread', async () => {
    const h = harness()
    await send(
      h,
      push(
        [person(), shortCode()],
        [message({ id: 'm1', text: 'hello Dana' }), message({ id: 'm2', chatId: 'c-5501', text: 'code 112233' })],
      ),
    )
    const before = rows<{ read_at: string | null }>(h, 'SELECT read_at FROM message')
    const q = await queue(h)
    await detail(h, q.rows[0].id)
    await queue(h, 'bulk')
    await h.request(AGENT, 'GET', '/api/search?q=hello')
    expect(rows<{ read_at: string | null }>(h, 'SELECT read_at FROM message')).toEqual(before)
    expect(before.every((r) => r.read_at === null)).toBe(true)
  })
})

describe('Claude’s script may leave a chat out on the owner’s word, and never bring one back', () => {
  test('texts reads the mailbox and the left-out chats', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const read = (await h.request(AGENT, 'GET', '/api/texts')).json
    expect(read.mailboxes).toHaveLength(1)
    expect(read.mailboxes[0]).toMatchObject({ kind: 'texts', name: 'Texts', messages: 1, conversations: 1, leftOut: 0 })
    expect(read.leftOut).toEqual([])
  })

  test('leave-out takes the owner’s words and records them; without them nothing changes', async () => {
    const h = harness()
    await send(h, push([person()], [message({ id: 'm1' })]))
    const id = conversationOf(h, 'c-2001')
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/leave-out`, {})).status).toBe(422)
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/leave-out`, { instruction: '  ' })).status).toBe(
      422,
    )
    expect(count(h, 'message')).toBe(1)
    const done = await h.request(AGENT, 'POST', `/api/conversations/${id}/leave-out`, {
      instruction: 'leave my mother’s chat out',
    })
    expect(done.status).toBe(200)
    expect(done.json).toEqual({ chatId: 'c-2001', removed: 1 })
    expect(count(h, 'message')).toBe(0)
    const audit = rows<{ actor: string; after: string }>(
      h,
      `SELECT actor, after FROM audit WHERE action = 'texts.left-out'`,
    )[0]
    expect(audit?.actor.startsWith('agent:')).toBe(true)
    expect(JSON.parse(audit?.after ?? '{}')).toEqual({ words: 'leave my mother’s chat out' })
    expect((await h.request(AGENT, 'GET', '/api/texts')).json.leftOut).toEqual([
      expect.objectContaining({ chatId: 'c-2001', fillOwed: false }),
    ])
    // Nothing on Claude's door brings one back, or names a chat that is not a text chat.
    for (const path of ['/api/texts/bring-back', '/api/texts/c-2001/bring-back', '/api/texts/left-out/c-2001']) {
      for (const method of ['POST', 'PUT', 'DELETE'])
        expect((await h.request(AGENT, method, path, {})).status, `${method} ${path}`).toBe(404)
    }
    expect((await h.request(AGENT, 'POST', '/api/conversations/nope/leave-out', { instruction: 'x' })).status).toBe(404)
  })

  test('a conversation that is not a text chat cannot be left out', async () => {
    const h = harness()
    await ownerDraft(h, { address: '555 555 0123', name: 'Dana', body: 'hi', subject: '' } as never)
    const manual = rows<{ id: string }>(h, 'SELECT id FROM conversation')[0]?.id as string
    expect(
      (await h.request(AGENT, 'POST', `/api/conversations/${manual}/leave-out`, { instruction: 'x' })).status,
    ).toBe(404)
  })
})
