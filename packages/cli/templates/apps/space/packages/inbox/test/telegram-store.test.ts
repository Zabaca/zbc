import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, BRIDGE, harness, mint, ownerDraft } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { account, chat, message, POSITION, push } from '../test-support/telegram'

/**
 * What the bridge pushes becomes conversations, people and messages, stored once, readable through Claude's script, with Telegram's position kept
 * beside them. The highest seam: the bridge's door as a function over the real store on a real SQLite with the real migrations, and Claude's real router for everything read back. What this cannot
 * show is Telegram: that its updates carry what the bridge's fake says they do. Those are the hand test (packages/inbox/docs/runbooks/inbox-telegram-bridge.md).
 */

type H = ReturnType<typeof harness>

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const events = async (h: H, body: Record<string, unknown>) =>
  (await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], ...body })).json
const work = async (h: H, newest = false) =>
  (await h.bridge(BRIDGE, '/api/work', { account, ...(newest && { newest: true }) })).json
const status = async (h: H, state: string, reason?: string) =>
  (await h.bridge(BRIDGE, '/api/status', { account, state, ...(reason && { reason }) })).json
const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n
const conversationOf = (h: H, chatId: string) =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id

describe('a one-to-one chat comes in', () => {
  test('as a conversation under the person, in the Telegram mailbox, unread and open, with the text as it was said', async () => {
    const h = harness()
    const res = await send(
      h,
      push(
        [chat({ phone: '16265550123', username: 'dana' })],
        [message({ id: 5, text: 'Can we move Thursday to Friday?', at: '2026-11-05T09:00:00Z' })],
        { position: POSITION },
      ),
    )
    expect(res).toEqual({ stored: 1, repeated: 0, skipped: 0 })

    const q = await queue(h)
    expect(q.rows).toHaveLength(1)
    const row = q.rows[0]
    expect(row).toMatchObject({
      title: 'Dana Reyes',
      kind: 'telegram',
      unread: true,
      open: true,
      bulk: false,
      mailbox: { name: 'Telegram', address: account.id },
      mailboxKind: 'telegram',
      snippet: 'Can we move Thursday to Friday?',
    })
    const page = await detail(h, row.id)
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({
      direction: 'in',
      status: 'sent',
      kind: 'telegram',
      address: '2001',
      body: 'Can we move Thursday to Friday?',
      from: 'Dana Reyes',
      sentAt: '2026-11-05T09:00:00.000Z',
    })
    expect(page.addresses).toEqual([expect.objectContaining({ kind: 'telegram', address: '2001' })])
    expect(page.contacts.map((c: { name: string }) => c.name)).toEqual(['Dana Reyes'])
  })

  test('the person is one contact however many chats and pushes: the same Telegram id is never a second contact', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    await send(h, push([chat({ name: 'D. Reyes' })], [message({ id: 2, at: '2026-11-05T10:05:00Z' })]))
    expect(count(h, 'contact')).toBe(1)
    expect(count(h, 'conversation')).toBe(1)
    expect(count(h, 'message')).toBe(2)
    // A later name in Telegram does not rename a contact Tessa may have renamed.
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact')[0]?.name).toBe('Dana Reyes')
  })

  test('a name Telegram does not give falls back to the username, then to the id', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat({ id: '3001', name: '', username: 'dana_r' }), chat({ id: '3002', name: '' })],
        [message({ id: 1, chatId: '3001' }), message({ id: 2, chatId: '3002' })],
      ),
    )
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact ORDER BY name').map((r) => r.name)).toEqual([
      '3002',
      'dana_r',
    ])
  })

  test('the same push repeated after a timeout stores one message, and says so', async () => {
    const h = harness()
    const body = push([chat()], [message({ id: 1 }), message({ id: 2, at: '2026-11-05T10:01:00Z' })], {
      position: POSITION,
    })
    expect(await send(h, body)).toEqual({ stored: 2, repeated: 0, skipped: 0 })
    expect(await send(h, body)).toEqual({ stored: 0, repeated: 2, skipped: 0 })
    expect(count(h, 'message')).toBe(2)
    expect(count(h, 'conversation')).toBe(1)
  })

  test('Tessa’s own message, sent from his phone, is his: outbound, read and closed, shown as Tessa, and it does not make the conversation unread', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, out: true, text: 'On my way', at: '2026-11-05T08:00:00Z' })]))
    const q = await queue(h, 'closed')
    expect(q.rows).toHaveLength(1)
    expect(q.rows[0]).toMatchObject({ unread: false, open: false })
    const page = await detail(h, q.rows[0].id)
    expect(page.messages[0]).toMatchObject({
      direction: 'out',
      from: 'Tessa Marlow',
      sentBy: 'telegram',
      body: 'On my way',
    })
  })

  test('a new message from the person reopens a closed conversation and makes it unread again', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    const id = conversationOf(h, '2001')
    const through = (await detail(h, id)).through
    expect(asHttp(await h.store.call('changeConversation', id, 'read', OWNER_EMAIL, through)).status).toBe(200)
    expect(asHttp(await h.store.call('changeConversation', id, 'close', OWNER_EMAIL, through)).status).toBe(200)
    expect((await queue(h, 'closed')).rows).toHaveLength(1)
    await send(h, push([chat()], [message({ id: 2, at: '2026-11-05T11:00:00Z', text: 'Still there?' })]))
    const q = await queue(h)
    expect(q.rows.map((r: { id: string }) => r.id)).toEqual([id])
    expect(q.rows[0]).toMatchObject({ unread: true, open: true })
  })

  test('a message the person edited arrives already edited, and a message with no text is stored as the label the bridge gave it', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          message({ id: 1, text: 'fixed', editedAt: '2026-11-05T10:02:00Z' }),
          message({ id: 2, text: '[Photo]', at: '2026-11-05T10:03:00Z' }),
        ],
      ),
    )
    const page = await detail(h, conversationOf(h, '2001'))
    expect(page.messages[0]).toMatchObject({ body: 'fixed', editedAt: '2026-11-05T10:02:00.000Z' })
    expect(page.messages[1].body).toBe('[Photo]')
  })

  test('the history is searchable like mail, and reading it marks nothing read', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, text: 'The invoice is attached' })]))
    const found = (await h.request(AGENT, 'GET', '/api/search?q=invoice')).json
    expect(found.rows).toHaveLength(1)
    expect(found.rows[0]).toMatchObject({ title: 'Dana Reyes', unread: true })
    await detail(h, found.rows[0].id)
    expect((await queue(h, 'unread')).rows).toHaveLength(1)
  })
})

describe('the first fill and a read-through (a mirror)', () => {
  test('each message comes in read when Telegram has it read, and unread above the mark', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat({ readInboxMaxId: 2 })],
        [
          message({ id: 1 }),
          message({ id: 2, at: '2026-11-05T10:01:00Z' }),
          message({ id: 3, at: '2026-11-05T10:02:00Z' }),
        ],
        { mirror: true },
      ),
    )
    const stamps = rows<{ telegram_msg_id: number; read_at: string | null; read_by: string | null }>(
      h,
      'SELECT telegram_msg_id, read_at, read_by FROM message ORDER BY telegram_msg_id',
    )
    expect(stamps.map((s) => [s.telegram_msg_id, s.read_at !== null, s.read_by])).toEqual([
      [1, true, 'telegram'],
      [2, true, 'telegram'],
      [3, false, null],
    ])
    expect((await queue(h, 'unread')).rows).toHaveLength(1)
  })

  test('a chat fully read in Telegram comes in read, and one in Telegram’s archive comes in closed', async () => {
    const h = harness()
    await send(
      h,
      push(
        [
          chat({ id: '2001', readInboxMaxId: 9, archived: false }),
          chat({ id: '2002', name: 'Eli Park', readInboxMaxId: 9, archived: true }),
        ],
        [message({ id: 1 }), message({ id: 2, chatId: '2002', at: '2026-11-05T10:01:00Z' })],
        { mirror: true },
      ),
    )
    expect((await queue(h, 'inbox')).rows.map((r: { title: string }) => r.title)).toEqual(['Dana Reyes'])
    expect((await queue(h, 'closed')).rows.map((r: { title: string }) => r.title)).toEqual(['Eli Park'])
    expect((await queue(h, 'unread')).rows).toEqual([])
  })

  test('a live message does not take Telegram’s read state or archive: it is unread, and open', async () => {
    const h = harness()
    await send(h, push([chat({ readInboxMaxId: 99, archived: true })], [message({ id: 1 })]))
    expect((await queue(h, 'unread')).rows).toHaveLength(1)
  })

  test('a read-through into a conversation that exists does not close it again, however Telegram’s archive stands', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })], { mirror: true }))
    await send(
      h,
      push([chat({ archived: true, readInboxMaxId: 0 })], [message({ id: 2, at: '2026-11-05T10:01:00Z' })], {
        mirror: true,
      }),
    )
    expect((await queue(h, 'inbox')).rows).toHaveLength(1)
  })
})

describe('Telegram’s position', () => {
  test('is stored with the batch it follows and asked for by the next work request; none before a fill is stored', async () => {
    const h = harness()
    expect(await work(h)).toEqual({ position: null, chatPositions: {}, owed: [] })
    await send(h, push([chat()], [message({ id: 1 })], { position: POSITION }))
    expect(await work(h)).toEqual({ position: POSITION, chatPositions: {}, owed: [] })
  })

  test('is not stored by a push that is refused, and is never moved back by a late repeat of an older batch', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })], { position: POSITION }))
    // Refused (a malformed message): the transaction never began.
    await h.bridge(BRIDGE, '/api/push', {
      ...push([chat()], [], { position: { ...POSITION, pts: 9999 } }),
      messages: [{ nope: true }],
    })
    expect((await work(h)).position).toEqual(POSITION)
    await send(
      h,
      push([chat()], [message({ id: 2, at: '2026-11-05T10:01:00Z' })], { position: { ...POSITION, pts: 7300 } }),
    )
    await send(h, push([chat()], [message({ id: 1 })], { position: { ...POSITION, pts: 7000 } }))
    expect((await work(h)).position?.pts).toBe(7300)
  })

  test('a position with no messages (a difference that held only other updates) is stored', async () => {
    const h = harness()
    await send(h, push([], [], { position: POSITION }))
    expect((await work(h)).position).toEqual(POSITION)
  })

  test('the work request can ask for the newest stored message of every chat: what a read-through starts from', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat(), chat({ id: '2002', name: 'Eli Park' })],
        [
          message({ id: 4 }),
          message({ id: 9, at: '2026-11-05T10:01:00Z' }),
          message({ id: 7, chatId: '2002', at: '2026-11-05T10:02:00Z' }),
        ],
      ),
    )
    expect((await work(h, true)).newest).toEqual({ '2001': 9, '2002': 7 })
    expect((await work(h)).newest).toBeUndefined()
  })

  test('the bridge signed in as another account is refused and stores nothing: the mailbox is one account’s', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    const other = await h.bridge(BRIDGE, '/api/push', {
      ...push([chat({ id: '2005', name: 'Someone' })], [message({ id: 1, chatId: '2005' })]),
      account: { id: '9999999999' },
    })
    expect(other.status).toBe(409)
    expect(count(h, 'mailbox')).toBe(1)
    expect(count(h, 'message')).toBe(1)
  })
})

describe('edits and deletions', () => {
  test('an edit replaces the text and says when; the history keeps one row', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, text: 'thursday' })]))
    const res = await events(h, { edits: [{ chatId: '2001', id: 1, text: 'friday', at: '2026-11-05T10:30:00Z' }] })
    expect(res).toEqual({ edited: 1, deleted: 0, read: 0, unknown: 0 })
    const page = await detail(h, conversationOf(h, '2001'))
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ body: 'friday', editedAt: '2026-11-05T10:30:00.000Z' })
    // And the list line follows the new text.
    expect((await queue(h)).rows[0].snippet).toBe('friday')
  })

  test('a deletion for everyone removes the text and leaves the row as a deleted message', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [message({ id: 1, text: 'I never said that' }), message({ id: 2, at: '2026-11-05T10:01:00Z', text: 'ok' })],
      ),
    )
    // A chat with a person gives ids and no chat.
    const res = await events(h, { deletions: [{ ids: [1], at: '2026-11-05T10:30:00Z' }] })
    expect(res).toEqual({ edited: 0, deleted: 1, read: 0, unknown: 0 })
    const page = await detail(h, conversationOf(h, '2001'))
    expect(page.messages).toHaveLength(2)
    expect(page.messages[0]).toMatchObject({ body: '', deletedAt: '2026-11-05T10:30:00.000Z' })
    expect(page.messages[1]).toMatchObject({ body: 'ok' })
    expect(page.messages[1].deletedAt).toBeUndefined()
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE body LIKE '%never said%'`).get()).toEqual({ n: 0 })
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE snippet LIKE '%never said%'`).get()).toEqual({ n: 0 })
  })

  test('a deleted message nobody had read does not hold the conversation unread, and an edit of a deleted one changes nothing', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    await events(h, { deletions: [{ chatId: '2001', ids: [1], at: '2026-11-05T10:30:00Z' }] })
    expect((await queue(h, 'unread')).rows).toEqual([])
    const again = await events(h, {
      edits: [{ chatId: '2001', id: 1, text: 'back', at: '2026-11-05T10:40:00Z' }],
      deletions: [{ ids: [1], at: '2026-11-05T10:41:00Z' }],
    })
    expect(again).toEqual({ edited: 0, deleted: 0, read: 0, unknown: 2 })
    expect((await detail(h, conversationOf(h, '2001'))).messages[0].body).toBe('')
  })

  test('an edit or a deletion of a message the inbox never held is counted and changes nothing', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    const res = await events(h, {
      edits: [{ chatId: '2001', id: 77, text: 'x', at: '2026-11-05T10:30:00Z' }],
      deletions: [{ ids: [78, 79], at: '2026-11-05T10:30:00Z' }],
    })
    expect(res).toEqual({ edited: 0, deleted: 0, read: 0, unknown: 3 })
  })

  test('the position travels with them', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })], { position: POSITION }))
    await events(h, { position: { ...POSITION, pts: 7500 } })
    expect((await work(h)).position?.pts).toBe(7500)
  })
})

describe('people: the phone-number join, and bots', () => {
  const sms = async (h: H, name: string, number: string) =>
    ownerDraft(h, { address: number, name, body: 'hello', subject: '' } as never)

  test('a Telegram person whose number is exactly one contact’s text number joins that contact, audited, and keeps its name; Split undoes it', async () => {
    const h = harness()
    await sms(h, 'Dana at the shop', '626 555 0123')
    expect(count(h, 'contact')).toBe(1)
    await send(h, push([chat({ phone: '16265550123' })], [message({ id: 1 })]))
    expect(count(h, 'contact')).toBe(1)
    const contact = rows<{ id: string; name: string }>(h, 'SELECT id, name FROM contact')[0] as {
      id: string
      name: string
    }
    expect(contact.name).toBe('Dana at the shop')
    expect(
      rows<{ kind: string }>(h, `SELECT kind FROM identity WHERE contact_id = '${contact.id}' ORDER BY kind`).map(
        (r) => r.kind,
      ),
    ).toEqual(['sms', 'telegram'])
    const joined = rows<{ actor: string; after: string }>(
      h,
      `SELECT actor, after FROM audit WHERE action = 'identity.join'`,
    )
    expect(joined).toHaveLength(1)
    expect(joined[0]?.actor).toBe('telegram')
    expect(JSON.parse(joined[0]?.after ?? '{}')).toMatchObject({
      kind: 'telegram',
      address: '2001',
      via: 'phone number',
    })

    // Split puts the Telegram identity on a contact of its own again.
    const telegramIdentity = (
      rows<{ id: string }>(h, `SELECT id FROM identity WHERE kind = 'telegram'`)[0] as { id: string }
    ).id
    const split = await h.request(AGENT, 'POST', `/api/identities/${telegramIdentity}/split`)
    expect(split.status).toBe(200)
    expect(count(h, 'contact')).toBe(2)
  })

  test('a number nobody has, and a bot whose number matches, join nothing: never a join by name', async () => {
    const h = harness()
    await sms(h, 'Dana one', '626 555 0123')
    // The same name, a number nobody has: a new contact.
    await send(h, push([chat({ id: '2001', name: 'Dana one', phone: '16265550198' })], [message({ id: 1 })]))
    // A bot is never joined, even when its number matches.
    await send(
      h,
      push(
        [chat({ id: '2002', name: 'Dana Reyes', bot: true, phone: '16265550123' })],
        [message({ id: 2, chatId: '2002', at: '2026-11-05T10:01:00Z' })],
      ),
    )
    expect(count(h, 'contact')).toBe(3)
    expect(rows(h, `SELECT 1 FROM audit WHERE action = 'identity.join'`)).toEqual([])
  })

  test('a bot’s chat comes in under the bot and is Bulk: out of the Inbox and the unread view, in Bulk, and never a person', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat(), chat({ id: '5001', name: 'Weather Bot', bot: true })],
        [message({ id: 1 }), message({ id: 2, chatId: '5001', at: '2026-11-05T10:01:00Z', text: 'Rain at 4' })],
      ),
    )
    expect((await queue(h, 'inbox')).rows.map((r: { title: string }) => r.title)).toEqual(['Dana Reyes'])
    expect((await queue(h, 'unread')).rows.map((r: { title: string }) => r.title)).toEqual(['Dana Reyes'])
    const bulk = (await queue(h, 'bulk')).rows
    expect(bulk.map((r: { title: string }) => r.title)).toEqual(['Weather Bot'])
    expect(bulk[0]).toMatchObject({ bulk: true })
    const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json as {
      name: string
      sender: { automated: boolean; rule: string; reason: string }
      identities: { bot?: boolean }[]
    }[]
    const bot = contacts.find((c) => c.name === 'Weather Bot')
    expect(bot?.sender).toEqual({ automated: true, rule: 'bot', reason: 'A Telegram bot.' })
    expect(bot?.identities[0]?.bot).toBe(true)
    expect(contacts.find((c) => c.name === 'Dana Reyes')?.sender.automated).toBe(false)
    expect(contacts.find((c) => c.name === 'Dana Reyes')?.identities[0]?.bot).toBeUndefined()
  })

  test('why a bot’s chat is in Bulk is said on the conversation', async () => {
    const h = harness()
    await send(h, push([chat({ id: '5001', name: 'Weather Bot', bot: true })], [message({ id: 2, chatId: '5001' })]))
    const page = await detail(h, conversationOf(h, '5001'))
    expect(page.bulk).toBe(true)
    expect(page.reasons?.join(' ')).toMatch(/automated/i)
  })
})

describe('the bridge’s health, as the script shows it', () => {
  const mailbox = async (h: H) => {
    const res = await h.request(AGENT, 'GET', '/api/telegram')
    expect(res.status).toBe(200)
    return res.json.mailboxes[0]
  }

  test('there is no Telegram mailbox until the bridge has said something', async () => {
    const h = harness()
    expect((await h.request(AGENT, 'GET', '/api/telegram')).json).toEqual({ mailboxes: [] })
  })

  test('a bridge that asks for work is live; its heartbeat is stamped at most once a minute', async () => {
    const h = harness()
    await work(h)
    const first = (await mailbox(h)).checkedInAt
    expect(await mailbox(h)).toMatchObject({
      state: 'live',
      name: 'Telegram',
      address: account.id,
      hasPosition: false,
      health: { amber: false, reasons: [] },
    })
    h.tick(30_000)
    await work(h)
    expect((await mailbox(h)).checkedInAt).toBe(first)
    h.tick(31_000)
    await work(h)
    expect((await mailbox(h)).checkedInAt).not.toBe(first)
  })

  test('catching up is told, and is not amber; the counts are the mailbox’s own', async () => {
    const h = harness()
    await status(h, 'catching-up')
    await send(
      h,
      push([chat()], [message({ id: 1 }), message({ id: 2, out: true, at: '2026-11-05T10:01:00Z' })], {
        position: POSITION,
      }),
    )
    expect(await mailbox(h)).toMatchObject({
      state: 'catching-up',
      messages: 2,
      conversations: 1,
      open: 1,
      unreadOpen: 1,
      hasPosition: true,
      health: { amber: false },
    })
    await status(h, 'live')
    expect(await mailbox(h)).toMatchObject({ state: 'live', reported: { state: 'live' } })
  })

  test('five minutes without a work request is amber, says since when, and a work request clears it', async () => {
    const h = harness()
    await work(h)
    const at = (await mailbox(h)).checkedInAt
    h.tick(4 * 60_000)
    expect((await mailbox(h)).state).toBe('live')
    h.tick(2 * 60_000)
    const late = await mailbox(h)
    expect(late).toMatchObject({ state: 'not-checked-in', health: { amber: true } })
    expect(late.health.reasons[0]).toBe(`The Telegram bridge has not checked in since ${at}.`)
    await work(h)
    expect((await mailbox(h)).state).toBe('live')
  })

  test('a login Telegram ended is told as signed out, with what to do, and stays signed out while the bridge is silent', async () => {
    const h = harness()
    await status(h, 'signed-out', 'AUTH_KEY_UNREGISTERED')
    h.tick(60 * 60_000)
    const m = await mailbox(h)
    expect(m).toMatchObject({
      state: 'signed-out',
      lastError: 'Telegram ended the saved login (AUTH_KEY_UNREGISTERED)',
      health: { amber: true },
    })
    expect(m.health.reasons).toEqual(['Telegram ended the saved login for the bridge. Only Tessa can sign in again.'])
    await status(h, 'live')
    expect(await mailbox(h)).toMatchObject({ state: 'live', lastError: null })
  })
})

describe('what Telegram’s conversations are to the rest of the inbox', () => {
  test('Claude’s draft on one is a draft like any other, and its send is refused while Tessa’s switch is off (how it ships), claiming nothing', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    const id = conversationOf(h, '2001')
    const draft = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: id,
      body: 'Friday works.',
      why: 'She asked to move it.',
    })
    expect(draft.status).toBe(201)
    expect(draft.json).toMatchObject({ kind: 'telegram', address: '2001', status: 'draft' })
    const sent = await h.request(AGENT, 'POST', `/api/drafts/${draft.json.id}/send`, {
      rev: draft.json.rev,
      through: (await detail(h, id)).through,
      instruction: { text: 'send it', where: 'a session', at: '2026-11-05T10:00:00Z' },
    })
    expect(sent.status).toBe(403)
    expect(rows<{ status: string }>(h, `SELECT status FROM message WHERE id = '${draft.json.id}'`)[0]?.status).toBe(
      'draft',
    )
    expect((await work(h)).owed).toEqual([])
  })

  test('Claude’s script reads Telegram as it reads mail: the queue, a conversation, search and the Telegram mailbox', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, text: 'hello from telegram' })]))
    const io: CliIo = {
      env: {
        INBOX_URL: 'https://space.northfield.example',
        INBOX_ACCESS_CLIENT_ID: AGENT_ID,
        INBOX_ACCESS_CLIENT_SECRET: 's',
      },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec) => spec,
      fetch: async (url, init) => {
        const headers = new Headers(init.headers)
        headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
        return h.app.request(url, { ...init, headers }, h.env)
      },
    }
    const script = async (...argv: string[]) => JSON.parse((await runCli(argv, io)).output)
    const q = await script('queue')
    expect(q.rows[0]).toMatchObject({ title: 'Dana Reyes', kind: 'telegram' })
    expect((await script('conversation', q.rows[0].id)).messages[0].body).toBe('hello from telegram')
    expect((await script('search', 'telegram')).rows).toHaveLength(1)
    expect((await script('telegram')).mailboxes[0]).toMatchObject({ kind: 'telegram', messages: 1 })
    expect(JSON.stringify(await script('queue', 'unread'))).toContain('Dana Reyes')
  })

  test('mail that is not Telegram’s is untouched: a store with a Gmail account and a Cloudflare mailbox still files, and Telegram’s conversations are in neither’s view', async () => {
    const h = harness()
    await h.connect()
    await send(h, push([chat()], [message({ id: 1 })]))
    expect(rows<{ kind: string }>(h, 'SELECT kind FROM mailbox ORDER BY kind').map((r) => r.kind)).toEqual([
      'gmail',
      'telegram',
    ])
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts).toHaveLength(1)
    expect((await h.request(AGENT, 'GET', '/api/mailboxes')).json.mailboxes).toEqual([])
    // The queue's filters gain no view for Telegram: its conversations are in the Inbox, Unread and the rest.
    const filters = (await queue(h)).filters.map((f: { id: string }) => f.id)
    expect(filters.filter((f: string) => f.startsWith('mailbox:'))).toEqual([])
  })
})
