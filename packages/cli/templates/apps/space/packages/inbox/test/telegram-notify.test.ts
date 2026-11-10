import { describe, expect, test } from 'bun:test'
import { messagePayload } from '../src/notify/rule'
import { asHttp, BRIDGE, harness } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { chat, message, push } from '../test-support/telegram'

/**
 * Notifications for Telegram by the mail rule. The store's seam: the bridge's door as a function over the real store on a real SQLite, then what
 * is owed (`owedNotifications`) and the payload a device is sent (`messagePayload`). What this cannot show is a phone ringing: that is the hand test (the runbook).
 */

type H = ReturnType<typeof harness>

// The harness clock starts at 2026-10-20T12:00:00Z: a message is "fresh" when it was sent within the hour before it.
const FRESH = '2026-10-20T11:50:00.000Z'
const STALE = '2026-10-20T10:30:00.000Z'

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const live = (chats: ReturnType<typeof chat>[], messages: ReturnType<typeof message>[]) => ({
  ...push(chats, messages),
  live: true,
})
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const owed = (h: H) => h.inbox.owedNotifications()

describe('a live message rings by the mail rule', () => {
  test('a new message from a person is owed once, and names who and not what was said', async () => {
    const h = harness()
    await send(h, live([chat()], [message({ id: 1, at: FRESH, text: 'the door code is 4412' })]))
    const [n, ...rest] = owed(h)
    expect(rest).toEqual([])
    expect(n).toMatchObject({ name: 'Dana Reyes', mailbox: 'Telegram', subject: 'New Telegram message' })
    const contact = rows<{ id: string }>(h, 'SELECT id FROM contact')[0]?.id
    // A person with no email is opened by the key the space gives a contact with no address.
    expect(n?.person).toBe(`mail:${contact}`)
    const payload = messagePayload(n as NonNullable<typeof n>)
    expect(payload).toMatchObject({
      kind: 'message',
      person: `mail:${contact}`,
      title: 'Telegram: Dana Reyes',
      body: 'New Telegram message',
    })
    expect(JSON.stringify(payload)).not.toContain('door code')
    // Stored once: the same push again owes nothing more.
    expect(await send(h, live([chat()], [message({ id: 1, at: FRESH })]))).toMatchObject({ stored: 0, repeated: 1 })
    expect(owed(h)).toHaveLength(1)
  })

  test('a person who also writes by email is opened by their first email address', async () => {
    const h = harness()
    await send(h, live([chat()], [message({ id: 1, at: FRESH })]))
    const contact = rows<{ id: string }>(h, 'SELECT id FROM contact')[0]?.id
    h.db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('e2', '${contact}', 'email', 'zed@example.com', '2026-10-01T00:00:00Z'), ('e1', '${contact}', 'email', 'dana@example.com', '2026-10-02T00:00:00Z')`,
    )
    await send(h, live([chat()], [message({ id: 2, at: FRESH })]))
    // The space keys a row by the first of the person's addresses as `personRow` sorts them (alphabetically), read when the notification goes out, so both owed ones name it.
    expect(owed(h).map((n) => n.person)).toEqual(['dana@example.com', 'dana@example.com'])
  })

  test('a closed conversation the message reopens rings', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, at: FRESH })]))
    const id = rows<{ id: string }>(h, 'SELECT id FROM conversation')[0]?.id as string
    const through = rows<{ n: number }>(h, `SELECT max(rowid) AS n FROM message WHERE conversation_id = '${id}'`)[0]?.n
    expect(asHttp(await h.store.call('changeConversation', id, 'read', OWNER_EMAIL, through ?? null)).status).toBe(200)
    expect(asHttp(await h.store.call('changeConversation', id, 'close', OWNER_EMAIL, through ?? null)).status).toBe(200)
    expect(owed(h)).toEqual([])
    await send(h, live([chat()], [message({ id: 2, at: FRESH, text: 'Still there?' })]))
    expect(owed(h)).toHaveLength(1)
  })
})

describe('what never rings', () => {
  test('a first fill, a read-through and a catch-up: not live, so a gap shorter than the hour does not ring a burst', async () => {
    const h = harness()
    const batch = [
      message({ id: 1, at: FRESH }),
      message({ id: 2, at: FRESH }),
      message({ id: 3, at: FRESH }),
      message({ id: 4, at: FRESH }),
    ]
    // A catch-up after a gap is an ordinary push the bridge did not mark live.
    await send(h, push([chat()], batch))
    // A fill is a mirror; even marked live it is not news.
    await send(h, {
      ...push([chat({ id: '2002', name: 'Eli' })], [message({ id: 1, chatId: '2002', at: FRESH })], { mirror: true }),
      live: true,
    })
    expect(owed(h)).toEqual([])
  })

  test('a chat Tessa muted in Telegram', async () => {
    const h = harness()
    await send(h, live([chat({ muted: true })], [message({ id: 1, at: FRESH })]))
    expect(owed(h)).toEqual([])
    // The flag is the one the push carried: unmuted in Telegram a minute later, the next message rings.
    await send(h, live([chat({ muted: false })], [message({ id: 2, at: FRESH })]))
    expect(owed(h)).toHaveLength(1)
  })

  test('Tessa’s own message, sent from his phone', async () => {
    const h = harness()
    await send(h, live([chat()], [message({ id: 1, at: FRESH, out: true })]))
    expect(owed(h)).toEqual([])
  })

  test('a bot, which is Bulk', async () => {
    const h = harness()
    await send(
      h,
      live([chat({ id: '5001', name: 'Build Bot', bot: true })], [message({ id: 1, chatId: '5001', at: FRESH })]),
    )
    expect(owed(h)).toEqual([])
  })

  test('a message older than the hour, even a live one: it waits in the Inbox', async () => {
    const h = harness()
    await send(h, live([chat()], [message({ id: 1, at: STALE })]))
    expect(owed(h)).toEqual([])
  })

  test('the door takes live as true or false and nothing else', async () => {
    const h = harness()
    const res = await h.bridge(BRIDGE, '/api/push', { ...push([chat()], [message({ id: 1, at: FRESH })]), live: 'yes' })
    expect(res.status).toBe(422)
    expect(owed(h)).toEqual([])
  })
})

describe('several at once', () => {
  test('each live message in one push is owed, and the delivery run (not the store) collapses more than three into one', async () => {
    const h = harness()
    await send(
      h,
      live(
        [chat(), chat({ id: '2002', name: 'Eli Park' })],
        [
          message({ id: 1, at: FRESH }),
          message({ id: 2, at: FRESH }),
          message({ id: 3, chatId: '2002', at: FRESH }),
          message({ id: 4, chatId: '2002', at: FRESH }),
        ],
      ),
    )
    expect(owed(h)).toHaveLength(4)
  })
})
