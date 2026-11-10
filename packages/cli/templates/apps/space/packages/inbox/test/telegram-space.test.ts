import { describe, expect, test } from 'bun:test'
import { asker, BRIDGE, harness, OWNER } from '../test-support/harness'
import { account, chat, message, push } from '../test-support/telegram'

/**
 * What the inbox tells the space about Telegram (`InboxForSpace`, src/space.ts and src/space-views.ts), driven as the space drives it, over the
 * real store with the bridge's door filling it. The page's words and drawing are the space's tests; this is the facts they stand on.
 */

type H = ReturnType<typeof harness>

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const work = async (h: H) => (await h.bridge(BRIDGE, '/api/work', { account })).json
const status = async (h: H, state: string, reason?: string) =>
  (await h.bridge(BRIDGE, '/api/status', { account, state, ...(reason && { reason }) })).json
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]

async function history(h: H) {
  const contact = rows<{ id: string }>(h, 'SELECT id FROM contact')[0]?.id as string
  return unwrap(await h.space().messagesWith(await asker(OWNER), { contactId: contact }))
}

describe('a Telegram chat in a person’s history', () => {
  test('is a Telegram thread that can be replied to, and its words are drawn whole, never folded as a quoted email', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1, text: 'See below\n> not a quote, just how I write' })]))
    const { threads, messages } = await history(h)
    expect(threads).toHaveLength(1)
    // The space sends on Telegram through the bridge, so a one-to-one chat offers the reply box (a channel does not: test/telegram-send.test.ts).
    expect(threads[0]).toMatchObject({
      kind: 'telegram',
      canReply: true,
      canMarkSpam: false,
      mailbox: { name: 'Telegram' },
    })
    expect(messages[0]?.read).toEqual({ visible: 'See below\n> not a quote, just how I write', quoted: '' })
    expect(messages[0]).not.toHaveProperty('edited')
    expect(messages[0]).not.toHaveProperty('deleted')
  })

  test('an edited message says it was edited, with its new words; a deleted one says it was deleted and keeps no words', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [message({ id: 1, text: 'Thursday' }), message({ id: 2, at: '2026-11-05T10:05:00Z', text: 'secret' })],
      ),
    )
    await h.bridge(BRIDGE, '/api/events', {
      account,
      edits: [{ chatId: '2001', id: 1, text: 'Friday', at: '2026-11-05T10:10:00Z' }],
      deletions: [{ chatId: '2001', ids: [2], at: '2026-11-05T10:11:00Z' }],
    })
    const { messages } = await history(h)
    expect(messages[0]).toMatchObject({ text: 'Friday', read: { visible: 'Friday', quoted: '' }, edited: true })
    expect(messages[1]).toMatchObject({ text: '', deleted: true })
    expect(messages[1]).not.toHaveProperty('edited')
    expect(JSON.stringify(messages)).not.toContain('secret')
  })
})

describe('the menu and Settings say where the bridge stands', () => {
  test('before the bridge has said anything there is no Telegram line and no card', async () => {
    const h = harness()
    const a = await asker(OWNER)
    expect(unwrap(await h.space().navigation(a)).telegram).toBeNull()
    expect(unwrap(await h.space().mailboxes(a)).telegram).toBeNull()
  })

  test('live: the mailbox is in the tree with the rows it holds, and the card has its numbers', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    await work(h)
    await status(h, 'live')
    const a = await asker(OWNER)
    const nav = unwrap(await h.space().navigation(a))
    expect(nav.telegram).toMatchObject({ name: 'Telegram', address: account.id, state: 'live', count: 1, unread: 1 })
    expect(nav.telegram?.checkedInAt).toBeGreaterThan(0)
    expect(nav.telegram?.lastPushAt).toBeGreaterThan(0)
    // The Telegram mailbox is not a business mailbox: the menu's other list and Settings' cards are unchanged.
    expect(nav.mailboxes.map((m) => m.name)).not.toContain('Telegram')
    const card = unwrap(await h.space().mailboxes(a)).telegram
    expect(card).toMatchObject({ state: 'live', messages: 1, conversations: 1, open: 1, unreadOpen: 1, filled: false })
  })

  test('catching up, then not checked in after five quiet minutes, then signed out for good', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 1 })]))
    await status(h, 'catching-up')
    const a = await asker(OWNER)
    expect(unwrap(await h.space().mailboxes(a)).telegram?.state).toBe('catching-up')
    h.tick(6 * 60_000)
    const late = unwrap(await h.space().navigation(a)).telegram
    expect(late?.state).toBe('not-checked-in')
    expect(late?.checkedInAt).toBeGreaterThan(0)
    await status(h, 'signed-out', 'AUTH_KEY_UNREGISTERED')
    h.tick(60 * 60_000)
    expect(unwrap(await h.space().mailboxes(a)).telegram?.state).toBe('signed-out')
  })

  test('the owner alone is told', async () => {
    const h = harness()
    await work(h)
    const stranger = await asker({ email: 'someone@example.com' })
    expect((await h.space().navigation(stranger)).ok).toBe(false)
    expect((await h.space().mailboxes(stranger)).ok).toBe(false)
  })
})
