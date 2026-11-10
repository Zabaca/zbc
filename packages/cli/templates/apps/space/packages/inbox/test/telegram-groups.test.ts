import { describe, expect, test } from 'bun:test'
import { AGENT, asHttp, asker, BRIDGE, harness, OWNER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { account, channel, chat, group, groupMessage, member, message, POSITION, push } from '../test-support/telegram'

/**
 * Groups and channels. Two of these are the owner's call: a group is one conversation under its own name and every member who writes is a
 * person; a group rings, needs a reply and reopens only for a message that mentions him or replies to him. The seam is the same as the store's tests (telegram-store.test.ts): the bridge's door as a function over the real
 * store on a real SQLite, then Claude's script and the space's own views for what comes back. What this cannot show is Telegram: that a group message carries the flags the bridge says it does.
 */

type H = ReturnType<typeof harness>

const FRESH = '2026-10-20T11:50:00.000Z'

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const live = (chats: ReturnType<typeof chat>[], messages: ReturnType<typeof message>[]) => ({
  ...push(chats, messages),
  live: true,
})
const events = async (h: H, body: Record<string, unknown>) =>
  (await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], ...body })).json
const work = async (h: H) => (await h.bridge(BRIDGE, '/api/work', { account })).json
const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const owed = (h: H) => h.inbox.owedNotifications()
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const idOf = (h: H, name: string) =>
  (rows<{ id: string }>(h, `SELECT id FROM contact WHERE name = '${name}'`)[0] as { id: string }).id
const conversationOf = (h: H, chatId: string) =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n

const ANA = member('3001', 'Ana Ruiz')
const BEN = member('3002', 'Ben Cole')
const G = '-1001234567'

/** Close a conversation the way Tessa does (read it, then close it), through the store. */
async function close(h: H, conversationId: string) {
  const through = rows<{ n: number }>(
    h,
    `SELECT max(rowid) AS n FROM message WHERE conversation_id = '${conversationId}'`,
  )[0]?.n
  expect(
    asHttp(await h.store.call('changeConversation', conversationId, 'read', OWNER_EMAIL, through ?? null)).status,
  ).toBe(200)
  expect(
    asHttp(await h.store.call('changeConversation', conversationId, 'close', OWNER_EMAIL, through ?? null)).status,
  ).toBe(200)
}

describe('a group comes in as one conversation under its own name', () => {
  test('one conversation and one row named by the title, with each message showing who wrote it', async () => {
    const h = harness()
    const res = await send(
      h,
      push(
        [group()],
        [
          groupMessage({ id: 1, text: 'Lunch?', sender: ANA }),
          groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', text: 'Yes', sender: BEN }),
          groupMessage({ id: 3, at: '2026-11-05T10:02:00Z', text: 'On my way', out: true }),
        ],
      ),
    )
    expect(res).toEqual({ stored: 3, repeated: 0, skipped: 0 })
    const q = await queue(h)
    expect(q.rows).toHaveLength(1)
    expect(q.rows[0]).toMatchObject({
      title: 'Founders',
      kind: 'telegram',
      mailbox: { name: 'Telegram' },
      telegramChat: 'group',
      unread: true,
      open: true,
      bulk: false,
    })
    const page = (await h.request(AGENT, 'GET', `/api/conversations/${q.rows[0].id}`)).json
    expect(page.messages.map((m: { from: string; direction: string }) => [m.from, m.direction])).toEqual([
      ['Ana Ruiz', 'in'],
      ['Ben Cole', 'in'],
      ['Tessa Marlow', 'out'],
    ])
    // The conversation's only participant is the group's own contact: a member is not a participant.
    expect(page.contacts.map((c: { name: string }) => c.name)).toEqual(['Founders'])
    expect(rows(h, 'SELECT * FROM participant')).toHaveLength(1)
  })

  test('the same group pushed again stores once, and a second group is a second conversation', async () => {
    const h = harness()
    const body = push([group()], [groupMessage({ id: 1, sender: ANA })])
    await send(h, body)
    expect(await send(h, body)).toEqual({ stored: 0, repeated: 1, skipped: 0 })
    await send(
      h,
      push([group({ id: '-4455', title: 'Neighbours' })], [groupMessage({ chatId: '-4455', id: 1, sender: ANA })]),
    )
    expect(count(h, 'conversation')).toBe(2)
    // The message key is the chat and Telegram's id: message 1 of two chats is two messages.
    expect(count(h, 'message')).toBe(2)
  })

  test('a title is never a person, and a group id can never be taken for a user id', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat({ id: '1001234567', name: 'Real Person' }), group()],
        [message({ id: 1, chatId: '1001234567' }), groupMessage({ id: 1, sender: ANA })],
      ),
    )
    expect(count(h, 'conversation')).toBe(2)
    expect(
      rows<{ address: string }>(h, `SELECT address FROM identity WHERE kind = 'telegram' ORDER BY address`).map(
        (r) => r.address,
      ),
    ).toEqual(['-1001234567', '1001234567', '3001'])
  })
})

describe('every member who writes is a person', () => {
  test('a contact per sender, once, the same contact as their one-to-one chat, and Tessa himself is none', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat({ id: '3001', name: 'Ana Ruiz', phone: '16265550123' })],
        [message({ id: 1, chatId: '3001', text: 'hi Tessa' })],
      ),
    )
    await send(
      h,
      push(
        [group()],
        [
          groupMessage({ id: 1, sender: ANA }),
          groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: ANA }),
          groupMessage({ id: 3, at: '2026-11-05T10:02:00Z', sender: BEN }),
          groupMessage({ id: 4, at: '2026-11-05T10:03:00Z', out: true }),
        ],
      ),
    )
    // Ana (one contact for her chat and her group messages), Ben, and the group's own contact.
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact ORDER BY name').map((r) => r.name)).toEqual([
      'Ana Ruiz',
      'Ben Cole',
      'Founders',
    ])
    const ana = idOf(h, 'Ana Ruiz')
    expect(rows(h, `SELECT 1 FROM identity WHERE contact_id = '${ana}' AND kind = 'telegram'`)).toHaveLength(1)
    // Each group message is filed under its sender's identity.
    expect(
      rows<{ n: number }>(
        h,
        `SELECT count(*) AS n FROM message m JOIN identity i ON i.id = m.identity_id WHERE i.contact_id = '${ana}' AND m.conversation_id = '${conversationOf(h, G)}'`,
      )[0]?.n,
    ).toBe(2)
  })

  test('People lists the members and leaves the group out, and does not count it among the automated senders', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group(), channel()],
        [
          groupMessage({ id: 1, sender: ANA }),
          groupMessage({ id: 1, chatId: '-1009876543', text: 'Incident resolved' }),
        ],
      ),
    )
    const a = await asker(OWNER)
    const { contacts, automated } = unwrap(await h.space().contacts(a))
    expect(contacts.map((c) => c.name)).toEqual(['Ana Ruiz'])
    expect(automated).toBe(0)
  })

  test('a person’s own history holds only what passed between the two of them: the group is a list beside it, each opening the group’s row', async () => {
    const h = harness()
    await send(h, push([chat({ id: '3001', name: 'Ana Ruiz' })], [message({ id: 1, chatId: '3001', text: 'just us' })]))
    await send(
      h,
      push(
        [group()],
        [
          groupMessage({ id: 1, text: 'in the group', sender: ANA }),
          groupMessage({ id: 2, at: '2026-11-05T11:00:00Z', text: 'later', sender: ANA }),
        ],
      ),
    )
    const a = await asker(OWNER)
    const ana = idOf(h, 'Ana Ruiz')
    const history = unwrap(await h.space().messagesWith(a, { contactId: ana }, { include: ['bulk', 'closed'] }))
    expect(history.messages.map((m) => m.text)).toEqual(['just us'])
    expect(history.threads).toHaveLength(1)
    const profile = unwrap(await h.space().contact(a, ana))
    expect(profile.groups).toEqual([
      { contactId: idOf(h, 'Founders'), name: 'Founders', lastWroteAt: Date.parse('2026-11-05T11:00:00Z') },
    ])
    expect(unwrap(await h.space().contacts(a)).contacts.find((c) => c.contactId === ana)?.groups).toHaveLength(1)
    // The group's own page holds the whole group, each message named.
    const groupHistory = unwrap(await h.space().messagesWith(a, { contactId: idOf(h, 'Founders') }))
    expect(groupHistory.messages.map((m) => [m.from, m.text])).toEqual([
      ['Ana Ruiz', 'in the group'],
      ['Ana Ruiz', 'later'],
    ])
    expect(groupHistory.threads[0]).toMatchObject({ kind: 'telegram', telegramChat: 'group' })
  })

  test('a member who has only ever written in groups is a person with no conversation of their own', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA })]))
    const a = await asker(OWNER)
    const c = unwrap(await h.space().contacts(a)).contacts.find((x) => x.name === 'Ana Ruiz')
    expect(c).toMatchObject({ conversations: 0 })
    expect(c?.groups?.map((g) => g.name)).toEqual(['Founders'])
  })

  test('the phone-number rule joins a member to a contact that has the number as a text identity', async () => {
    const h = harness()
    h.db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c-ana', 'Ana R.', 't', 'x')`)
    h.db.run(`INSERT INTO identity VALUES ('i-ana', 'c-ana', 'sms', '+16265550123', 't')`)
    await send(
      h,
      push([group()], [groupMessage({ id: 1, sender: member('3001', 'Ana Ruiz', { phone: '16265550123' }) })]),
    )
    expect(
      rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE kind = 'telegram' AND address = '3001'`)[0]
        ?.contact_id,
    ).toBe('c-ana')
  })

  test('a bot that speaks in a group does not make the group an automated sender’s', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: member('5001', 'Build Bot', { bot: true }) })]))
    const q = await queue(h)
    expect(q.rows).toHaveLength(1)
    expect(q.rows[0]).toMatchObject({ title: 'Founders', bulk: false })
  })
})

describe('where the group’s row is', () => {
  test('under the group’s own contact whoever wrote last, never under a member', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group()],
        [groupMessage({ id: 1, sender: ANA }), groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: BEN })],
      ),
    )
    const a = await asker(OWNER)
    const people = unwrap(await h.space().people(a))
    expect(people.people.map((p) => p.name)).toEqual(['Founders'])
    const line = people.people[0]?.conversations[0]
    expect(line).toMatchObject({ listed: true, telegramChat: 'group', kind: 'telegram' })
  })
})

describe('a group rings, needs a reply and reopens only for a message to Tessa', () => {
  test('an ordinary message in an open group is an unread open row and rings nothing', async () => {
    const h = harness()
    await send(h, live([group()], [groupMessage({ id: 1, at: FRESH, sender: ANA })]))
    expect(owed(h)).toEqual([])
    const q = await queue(h)
    expect(q.rows[0]).toMatchObject({ unread: true, open: true })
    const line = unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]
    expect(line?.needsReply).toBe(false)
  })

  test('a message that mentions him rings once, names who and where and not what, and is opened by the group’s row', async () => {
    const h = harness()
    await send(
      h,
      live(
        [group()],
        [groupMessage({ id: 1, at: FRESH, sender: ANA, mentionsMe: true, text: 'the door code is 4412' })],
      ),
    )
    const [n, ...rest] = owed(h)
    expect(rest).toEqual([])
    expect(n).toMatchObject({
      name: 'Ana Ruiz in Founders',
      mailbox: 'Telegram',
      subject: 'New Telegram message',
      person: `mail:${idOf(h, 'Founders')}`,
    })
    expect(JSON.stringify(n)).not.toContain('door code')
    const line = unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]
    expect(line?.needsReply).toBe(true)
  })

  test('a reply to one of his own messages is addressed to him, even when Telegram sets no mention', async () => {
    const h = harness()
    await send(
      h,
      push([group()], [groupMessage({ id: 5, at: '2026-10-20T11:00:00Z', out: true, text: 'Who has the keys?' })]),
    )
    await send(
      h,
      live(
        [group()],
        [
          groupMessage({ id: 6, at: FRESH, sender: ANA, replyTo: 5 }),
          groupMessage({ id: 7, at: FRESH, sender: BEN, replyTo: 99 }),
        ],
      ),
    )
    expect(owed(h)).toHaveLength(1)
    expect(
      rows<{ telegram_msg_id: number; telegram_to_me: number | null }>(
        h,
        'SELECT telegram_msg_id, telegram_to_me FROM message ORDER BY telegram_msg_id',
      ).map((r) => [r.telegram_msg_id, r.telegram_to_me]),
    ).toEqual([
      [5, null],
      [6, 1],
      [7, 0],
    ])
  })

  test('a reply to somebody else’s message is not addressed to him', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 5, at: '2026-10-20T11:00:00Z', sender: BEN })]))
    await send(h, live([group()], [groupMessage({ id: 6, at: FRESH, sender: ANA, replyTo: 5 })]))
    expect(owed(h)).toEqual([])
  })

  test('a muted group never rings, even for a mention', async () => {
    const h = harness()
    await send(h, live([group({ muted: true })], [groupMessage({ id: 1, at: FRESH, sender: ANA, mentionsMe: true })]))
    expect(owed(h)).toEqual([])
    // The row still needs a reply: a mute is the sound and nothing else.
    expect(unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]?.needsReply).toBe(true)
  })

  test('a fill never rings, mention or not', async () => {
    const h = harness()
    await send(h, {
      ...push([group()], [groupMessage({ id: 1, at: FRESH, sender: ANA, mentionsMe: true })], { mirror: true }),
      live: true,
    })
    expect(owed(h)).toEqual([])
  })

  test('a closed group stays closed for chatter and reopens for a message to him', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA })]))
    const id = conversationOf(h, G)
    await close(h, id)
    expect((await queue(h, 'closed')).rows).toHaveLength(1)

    await send(h, live([group()], [groupMessage({ id: 2, at: FRESH, sender: BEN, text: 'anyone?' })]))
    expect((await queue(h, 'inbox')).rows).toEqual([])
    expect((await queue(h, 'closed')).rows).toHaveLength(1)
    expect(owed(h)).toEqual([])

    await send(h, live([group()], [groupMessage({ id: 3, at: FRESH, sender: ANA, mentionsMe: true })]))
    expect((await queue(h, 'inbox')).rows).toHaveLength(1)
    expect(owed(h)).toHaveLength(1)
  })

  test('chatter after a mention in an open group does not take the mention away, and his own reply does', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group()],
        [
          groupMessage({ id: 1, at: '2026-11-05T10:00:00Z', sender: ANA, mentionsMe: true }),
          groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: BEN }),
        ],
      ),
    )
    const needs = async () => unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]?.needsReply
    expect(await needs()).toBe(true)
    await send(h, push([group()], [groupMessage({ id: 3, at: '2026-11-05T10:02:00Z', out: true, text: 'here' })]))
    expect(await needs()).toBe(false)
    await send(h, push([group()], [groupMessage({ id: 4, at: '2026-11-05T10:03:00Z', sender: BEN, mentionsMe: true })]))
    expect(await needs()).toBe(true)
  })

  test('an unaddressed message leaves the group not needing a reply, whatever direction its newest message went', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA })]))
    const line = unwrap(await h.space().people(await asker(OWNER))).people[0]?.conversations[0]
    // Direction alone would say "in", the one-to-one rule for Needs reply; the group's own flag decides.
    expect(line).toMatchObject({ direction: 'in', needsReply: false })
  })
})

describe('a channel he follows is Bulk', () => {
  test('its posts are in Bulk, never the Inbox or Unread, and ring nothing', async () => {
    const h = harness()
    await send(
      h,
      live([channel()], [groupMessage({ chatId: '-1009876543', id: 1, at: FRESH, text: 'Incident resolved' })]),
    )
    expect((await queue(h, 'inbox')).rows).toEqual([])
    expect((await queue(h, 'unread')).rows).toEqual([])
    const bulk = (await queue(h, 'bulk')).rows
    expect(bulk).toHaveLength(1)
    expect(bulk[0]).toMatchObject({ title: 'Cloudflare Status', bulk: true, telegramChat: 'channel' })
    expect(owed(h)).toEqual([])
  })

  test('the channel’s conversation is in Bulk by the one rule and says why', async () => {
    const h = harness()
    await send(h, push([channel()], [groupMessage({ chatId: '-1009876543', id: 1 })]))
    const detail = (await h.request(AGENT, 'GET', `/api/conversations/${conversationOf(h, '-1009876543')}`)).json
    expect(detail.reasons).toEqual(['Automated sender: A Telegram channel: broadcasts, filed in Bulk.'])
  })

  test('a channel with an archive flag comes in closed in a mirror, as any chat', async () => {
    const h = harness()
    await send(
      h,
      push([channel({ archived: true })], [groupMessage({ chatId: '-1009876543', id: 1 })], { mirror: true }),
    )
    expect((await queue(h, 'closed')).rows).toHaveLength(1)
  })

  test('there is no reply box: the thread is not answerable', async () => {
    const h = harness()
    await send(h, push([channel()], [groupMessage({ chatId: '-1009876543', id: 1 })]))
    const a = await asker(OWNER)
    const history = unwrap(
      await h.space().messagesWith(a, { contactId: idOf(h, 'Cloudflare Status') }, { include: ['bulk', 'closed'] }),
    )
    expect(history.threads[0]).toMatchObject({ telegramChat: 'channel', canReply: false })
  })
})

describe('a position of its own for each supergroup and channel', () => {
  test('is stored with the batch it follows, asked for by the next work request and never moved back', async () => {
    const h = harness()
    expect((await work(h)).chatPositions).toEqual({})
    await send(
      h,
      push(
        [group(), channel()],
        [groupMessage({ id: 1, sender: ANA }), groupMessage({ chatId: '-1009876543', id: 1 })],
        { position: POSITION, chatPositions: { [G]: 100, '-1009876543': 40 } },
      ),
    )
    expect((await work(h)).chatPositions).toEqual({ [G]: 100, '-1009876543': 40 })
    await send(
      h,
      push([group()], [groupMessage({ id: 2, at: '2026-11-05T10:05:00Z', sender: ANA })], {
        chatPositions: { [G]: 120 },
      }),
    )
    await send(h, push([group()], [], { chatPositions: { [G]: 90 } }))
    expect((await work(h)).chatPositions[G]).toBe(120)
  })

  test('a push that is refused stores none of it, and a basic group has none to store', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA })], { chatPositions: { [G]: 5 } }))
    const refused = await h.bridge(BRIDGE, '/api/push', {
      ...push([group()], [], { chatPositions: { [G]: 99 } }),
      messages: [{ nope: true }],
    })
    expect(refused.status).toBe(422)
    expect((await work(h)).chatPositions[G]).toBe(5)
    const basic = await h.bridge(
      BRIDGE,
      '/api/push',
      push([group({ id: '-777' })], [], { chatPositions: { '-777': 3 } }),
    )
    expect(basic.status).toBe(422)
  })

  test('a position for a chat with no conversation yet keeps none: the bridge reads that chat again', async () => {
    const h = harness()
    await send(h, push([], [], { chatPositions: { '-1005550000': 8 } }))
    expect((await work(h)).chatPositions).toEqual({})
  })

  test('edits and deletions carry them too', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA })], { chatPositions: { [G]: 5 } }))
    await events(h, {
      edits: [],
      deletions: [{ chatId: G, ids: [1], at: '2026-11-05T11:00:00Z' }],
      chatPositions: { [G]: 6 },
    })
    expect((await work(h)).chatPositions[G]).toBe(6)
  })
})

describe('edits and deletions in a group or a channel', () => {
  test('an edit and a deletion name the chat and find the message by it', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group()],
        [
          groupMessage({ id: 1, text: 'Thursday', sender: ANA }),
          groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', text: 'secret', sender: BEN }),
        ],
      ),
    )
    const res = await events(h, {
      edits: [{ chatId: G, id: 1, text: 'Friday', at: '2026-11-05T10:10:00Z' }],
      deletions: [{ chatId: G, ids: [2], at: '2026-11-05T10:11:00Z' }],
    })
    expect(res).toEqual({ edited: 1, deleted: 1, read: 0, unknown: 0 })
    const bodies = rows<{ body: string; deleted_at: string | null }>(
      h,
      'SELECT body, deleted_at FROM message ORDER BY telegram_msg_id',
    )
    expect(bodies.map((b) => b.body)).toEqual(['Friday', ''])
    expect(bodies[1]?.deleted_at).not.toBeNull()
  })

  test('a deletion that names no chat is the account’s own sequence: a basic group’s message is found, a supergroup’s or a channel’s id is never taken for it', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group({ id: '-777', title: 'Old friends' }), group(), channel()],
        [
          groupMessage({ chatId: '-777', id: 50, sender: ANA }),
          groupMessage({ id: 50, sender: ANA, at: '2026-11-05T10:01:00Z' }),
          groupMessage({ chatId: '-1009876543', id: 50, at: '2026-11-05T10:02:00Z' }),
        ],
      ),
    )
    const res = await events(h, { deletions: [{ ids: [50], at: '2026-11-05T11:00:00Z' }] })
    expect(res).toEqual({ edited: 0, deleted: 1, read: 0, unknown: 0 })
    const gone = rows<{ chat: string }>(
      h,
      `SELECT c.telegram_chat_id AS chat FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE m.deleted_at IS NOT NULL`,
    )
    expect(gone.map((r) => r.chat)).toEqual(['-777'])
  })
})

describe('the first fill and a read-through of groups', () => {
  test('a group comes in read as far as Telegram has it read, and a group in the archive comes in closed', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group({ readInboxMaxId: 2 }), group({ id: '-4455', title: 'Neighbours', archived: true, readInboxMaxId: 9 })],
        [
          groupMessage({ id: 1, sender: ANA }),
          groupMessage({ id: 3, at: '2026-11-05T10:03:00Z', sender: ANA }),
          groupMessage({ chatId: '-4455', id: 1, sender: BEN }),
        ],
        { mirror: true },
      ),
    )
    expect((await queue(h, 'inbox')).rows.map((r: { title: string }) => r.title)).toEqual(['Founders'])
    expect((await queue(h, 'closed')).rows.map((r: { title: string }) => r.title)).toEqual(['Neighbours'])
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM message WHERE read_at IS NULL`)[0]?.n).toBe(1)
  })
})

describe('Claude and a group', () => {
  test('a draft on a group is to the group by name, and its send is refused while Tessa’s switch is off, claiming nothing; Claude reads who wrote each message', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, text: 'Lunch?', sender: ANA })]))
    const id = conversationOf(h, G)
    const draft = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: id,
      body: 'Noon works.',
      why: 'Ana asked.',
    })
    expect(draft.status).toBe(201)
    expect(draft.json).toMatchObject({ kind: 'telegram', status: 'draft', address: G })
    const sent = await h.request(AGENT, 'POST', `/api/drafts/${draft.json.id}/send`, {
      rev: draft.json.rev,
      through: (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json.through,
      instruction: { text: 'send it', where: 'a session', at: '2026-11-05T10:00:00Z' },
    })
    expect(sent.status).toBe(403)
    expect(rows<{ status: string }>(h, `SELECT status FROM message WHERE id = '${draft.json.id}'`)[0]?.status).toBe(
      'draft',
    )
    const search = (await h.request(AGENT, 'GET', '/api/search?q=Lunch')).json
    expect(JSON.stringify(search)).toContain('Founders')
  })

  test('a message that says Telegram’s service account wrote it in a group is filed under the group and makes no person', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, text: 'hello', sender: member('777000', 'Telegram') })]))
    expect(rows<{ name: string }>(h, 'SELECT name FROM contact').map((r) => r.name)).toEqual(['Founders'])
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM identity WHERE address = '777000'`)[0]?.n).toBe(0)
  })
})

describe('what the bridge may push', () => {
  test('a group needs a title, a channel needs a channel’s id, and only a group message has a sender', async () => {
    const h = harness()
    const post = async (chats: unknown[], messages: unknown[] = []) =>
      (await h.bridge(BRIDGE, '/api/push', { account, chats, messages })).status
    expect(await post([{ id: G, kind: 'group', muted: false }])).toBe(422)
    expect(await post([{ id: '-777', kind: 'channel', title: 'x', muted: false }])).toBe(422)
    expect(await post([{ id: '3001', kind: 'group', title: 'x', muted: false }])).toBe(422)
    expect(await post([{ id: G, kind: 'group', title: 'x', muted: false, person: ANA }])).toBe(422)
    expect(
      await post([
        { id: '3001', kind: 'user', person: { id: '3001', name: 'Ana', bot: false }, muted: false, title: 'x' },
      ]),
    ).toBe(422)
    expect(
      await post(
        [group()],
        [{ chatId: '3001', id: 1, at: '2026-11-05T10:00:00Z', out: false, text: 'x', sender: ANA }],
      ),
    ).toBe(422)
    expect(
      await post(
        [group()],
        [{ chatId: G, id: 1, at: '2026-11-05T10:00:00Z', out: false, text: 'x', sender: ANA, replyTo: 0 }],
      ),
    ).toBe(422)
    expect(
      await post(
        [group()],
        [{ chatId: G, id: 1, at: '2026-11-05T10:00:00Z', out: false, text: 'x', sender: ANA, mentionsMe: 'yes' }],
      ),
    ).toBe(422)
    expect(
      await post(
        [group()],
        [
          {
            chatId: G,
            id: 1,
            at: '2026-11-05T10:00:00Z',
            out: false,
            text: 'x',
            sender: ANA,
            mentionsMe: true,
            replyTo: 4,
          },
        ],
      ),
    ).toBe(200)
    expect((await h.bridge(BRIDGE, '/api/push', { ...push([group()], []), chatPositions: { '3001': 4 } })).status).toBe(
      422,
    )
  })

  test('Telegram’s service chat and Saved Messages are refused in a group’s shoes too: a user id is never carried as a chat of Tessa’s own', async () => {
    const h = harness()
    const res = await send(
      h,
      push(
        [chat({ id: '777000', name: 'Telegram' }), chat({ id: account.id, name: 'Saved' })],
        [message({ id: 1, chatId: '777000', text: 'login code 12345' }), message({ id: 2, chatId: account.id })],
      ),
    )
    expect(res).toMatchObject({ stored: 0, skipped: 4 })
    expect(count(h, 'message')).toBe(0)
  })
})

describe('a sender known only by id, and a deleted mention', () => {
  const idOnly = { id: '5001', name: '' }

  test('a message whose sender the bridge could not describe leaves a known bot a bot and keeps its username; a stranger known only by id is a person, made once', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: member('5001', 'Build Bot', { bot: true }) })]))
    h.db.run(`UPDATE telegram_person SET username = 'buildbot' WHERE bot = 1`)
    const res = await h.bridge(
      BRIDGE,
      '/api/push',
      push(
        [group()],
        [
          groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: idOnly }),
          groupMessage({ id: 3, at: '2026-11-05T10:02:00Z', sender: { id: '6001', name: '' } }),
        ],
      ),
    )
    expect(res.status).toBe(200)
    const people = rows<{ address: string; bot: number; username: string | null }>(
      h,
      `SELECT i.address AS address, tp.bot AS bot, tp.username AS username FROM telegram_person tp JOIN identity i ON i.id = tp.identity_id WHERE tp.chat IS NULL ORDER BY i.address`,
    )
    expect(people).toEqual([
      { address: '5001', bot: 1, username: 'buildbot' },
      { address: '6001', bot: 0, username: null },
    ])
    // The bot is still not a person in People, and the group is not Bulk for what it said.
    const a = await asker(OWNER)
    expect(unwrap(await h.space().contacts(a)).contacts.map((c) => c.name)).toEqual(['6001'])
    expect((await queue(h)).rows).toHaveLength(1)
  })

  test('the door takes a sender with no bot flag, and still refuses one with a flag that is not true or false; a person’s chat still needs the flag', async () => {
    const h = harness()
    const post = async (sender: unknown) =>
      (
        await h.bridge(BRIDGE, '/api/push', {
          account,
          chats: [group()],
          messages: [{ chatId: G, id: 1, at: '2026-11-05T10:00:00Z', out: false, text: 'x', sender }],
        })
      ).status
    expect(await post({ id: '5001', name: '' })).toBe(200)
    expect(await post({ id: '5001', name: '', bot: 'yes' })).toBe(422)
    const chatStatus = (
      await h.bridge(BRIDGE, '/api/push', {
        account,
        chats: [{ id: '3001', kind: 'user', person: { id: '3001', name: 'Ana' }, muted: false }],
        messages: [],
      })
    ).status
    expect(chatStatus).toBe(422)
  })

  test('a mention its sender deleted is not waiting on Tessa', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: ANA, mentionsMe: true })]))
    const a = await asker(OWNER)
    const needs = async () => unwrap(await h.space().people(a)).people[0]?.conversations[0]?.needsReply
    expect(await needs()).toBe(true)
    await events(h, { deletions: [{ chatId: G, ids: [1], at: '2026-11-05T11:00:00Z' }] })
    expect(await needs()).toBe(false)
  })
})

describe('names for a sender the update named by id alone, and the back-read marker', () => {
  const nameless = { id: '3001', name: '' }
  const fromHeaders = (h: H) =>
    rows<{ from_header: string }>(h, `SELECT from_header FROM message ORDER BY telegram_msg_id`).map(
      (r) => r.from_header,
    )

  test('a person the inbox already knows is named by their contact, never by the number: in the history, on the group’s row and in the notification', async () => {
    const h = harness()
    await send(h, push([chat({ id: '3001', name: 'Ana Ruiz' })], [message({ id: 1, chatId: '3001' })]))
    await send(
      h,
      live([group()], [groupMessage({ id: 1, at: FRESH, sender: nameless, mentionsMe: true, text: 'Lunch?' })]),
    )
    expect(fromHeaders(h)).toContain('Ana Ruiz')
    expect(fromHeaders(h)).not.toContain('3001')
    const a = await asker(OWNER)
    expect(unwrap(await h.space().people(a)).people.find((p) => p.name === 'Founders')?.conversations[0]?.snippet).toBe(
      'Ana: Lunch?',
    )
    expect(owed(h)[0]?.name).toBe('Ana Ruiz in Founders')
  })

  test('a person first seen with no name is the number until a push describes them: then the contact takes the name, their earlier messages are headed by it, and a name Tessa set is never replaced', async () => {
    const h = harness()
    await send(h, push([group()], [groupMessage({ id: 1, sender: nameless, text: 'first' })]))
    expect(rows<{ name: string }>(h, `SELECT name FROM contact WHERE name = '3001'`)).toHaveLength(1)
    expect(fromHeaders(h)).toEqual(['3001'])
    const before = rows<{ profile_rev: number }>(h, `SELECT profile_rev FROM contact WHERE name = '3001'`)[0]
      ?.profile_rev as number

    await send(h, push([group()], [groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: ANA, text: 'second' })]))
    expect(
      rows<{ name: string; profile_rev: number }>(h, `SELECT name, profile_rev FROM contact WHERE name = 'Ana Ruiz'`),
    ).toEqual([{ name: 'Ana Ruiz', profile_rev: before + 1 }])
    expect(fromHeaders(h)).toEqual(['Ana Ruiz', 'Ana Ruiz'])
    expect(rows(h, `SELECT 1 FROM audit WHERE action = 'contact.name-learned'`)).toHaveLength(1)

    // Tessa renames her; a later description does not take it back.
    h.db.run(`UPDATE contact SET name = 'Ana from the shop' WHERE name = 'Ana Ruiz'`)
    await send(
      h,
      push([group()], [groupMessage({ id: 3, at: '2026-11-05T10:02:00Z', sender: member('3001', 'Ana R.') })]),
    )
    expect(rows<{ name: string }>(h, `SELECT name FROM contact WHERE name LIKE 'Ana%'`)).toEqual([
      { name: 'Ana from the shop' },
    ])
  })

  test('described in the same push as the nameless one: the name is learned there too', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group()],
        [groupMessage({ id: 1, sender: nameless }), groupMessage({ id: 2, at: '2026-11-05T10:01:00Z', sender: ANA })],
      ),
    )
    expect(rows<{ name: string }>(h, `SELECT name FROM contact WHERE name != 'Founders'`)).toEqual([
      { name: 'Ana Ruiz' },
    ])
    expect(fromHeaders(h)).toEqual(['Ana Ruiz', 'Ana Ruiz'])
  })

  test('a basic group read back is marked once, in the same write as its messages, and the work request says which are marked', async () => {
    const h = harness()
    const first = async () => (await h.bridge(BRIDGE, '/api/work', { account, newest: true })).json
    expect((await first()).backRead).toEqual([])
    expect((await work(h)).backRead).toBeUndefined()
    await send(h, {
      ...push([group({ id: '-9' })], [groupMessage({ chatId: '-9', id: 1, sender: ANA })]),
      backRead: ['-9'],
    })
    await send(h, { ...push([group({ id: '-9' })], []), backRead: ['-9'] })
    expect((await first()).backRead).toEqual(['-9'])
    expect(rows(h, `SELECT 1 FROM setting WHERE key LIKE 'telegram-back-read:%'`)).toHaveLength(1)
    // A push that is refused marks nothing.
    const refused = await h.bridge(BRIDGE, '/api/push', {
      ...push([group({ id: '-10' })], []),
      backRead: ['-10'],
      messages: [{ nope: true }],
    })
    expect(refused.status).toBe(422)
    expect((await first()).backRead).toEqual(['-9'])
  })

  test('only a basic group is marked: a person, a supergroup and a long list are refused', async () => {
    const h = harness()
    const post = async (backRead: unknown) =>
      (await h.bridge(BRIDGE, '/api/push', { ...push([], []), backRead })).status
    expect(await post(['-9'])).toBe(200)
    expect(await post(['3001'])).toBe(422)
    expect(await post(['-1001234567'])).toBe(422)
    expect(await post('-9')).toBe(422)
    expect(await post(Array.from({ length: 201 }, (_, i) => `-${i + 1}`))).toBe(422)
  })
})
