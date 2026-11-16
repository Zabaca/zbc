import { describe, expect, test } from 'bun:test'
import { asker, harness } from '../test-support/harness'

/**
 * The fold of every conversation is made once per state of the store and kept until a row changes (src/store/store.ts `everyQueueFact`): the lists, the menu's counts and a list's rows read it,
 * where each used to fold every conversation again. These tests hold the two things that make keeping it safe: what a list says from the kept fold is what each conversation says on its own,
 * and anything written after a read is in the next read.
 */

const T = Date.parse('2026-11-10T12:00:00.000Z')
const businessMail = (n: number, from: string, name: string) =>
  `Return-Path: <${from}>\nMIME-Version: 1.0\nFrom: ${name} <${from}>\nDate: Mon, ${10 + n} Aug 2026 13:00:00 -0700\nMessage-ID: <kept${n}@example.org>\nSubject: Matter ${n}\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\nStill waiting on this.\n`

const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}

/** Gmail mail from people, a list sender and a no-reply sender, read and unread, open and archived; and a business mailbox's mail. */
async function world() {
  const h = harness({}, { ai: null })
  const g = h.google.mailbox
  const senders = [
    'Dana Reyes <dana@harbor.example>',
    'Shop News <news@shop.example>',
    'Bank Alerts <noreply@bank.example>',
  ]
  for (let i = 0; i < 24; i++)
    g.add({
      id: `g${i}`,
      threadId: `t${i % 18}`,
      from: senders[i % 3],
      subject: `Thread ${i % 18}`,
      at: T - i * 60_000,
      labels: i % 5 === 0 ? [] : ['INBOX', ...(i % 2 === 0 ? ['UNREAD'] : [])],
      headers: i % 3 === 1 ? { 'List-Unsubscribe': '<mailto:out@shop.example>' } : {},
    })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  for (const [n, from, name] of [
    [1, 'priya@example.org', 'Priya Nair'],
    [2, 'no-reply@alerts.example', 'Alerts'],
  ] as const)
    expect((await h.deliver(businessMail(n, from, name), { from, to: 'info@ridgewaycycles.example' })).entered).toBe(
      'filed',
    )
  await h.drain()
  return h
}

describe('the kept fold', () => {
  test('a list read from it says, row for row, what each conversation says read on its own', async () => {
    const h = await world()
    const ids = h.inbox.listQueueFacts().map((f) => f.id)
    expect(ids.length).toBeGreaterThan(10)
    const together = h.inbox.listConversations(ids, ids.length)
    expect(together.map((c) => c.id).sort()).toEqual([...ids].sort())
    for (const row of together) {
      // One id alone is read without the fold.
      const alone = h.inbox.listConversations([row.id], 1)[0]
      expect([row.id, row]).toEqual([row.id, alone as typeof row])
    }
  })

  /** SQLite's count of changed rows made to stand still, as if Cloudflare's SQL counted differently: the store's own count of its writes must still see every change. */
  const stuckChangeCount = (h: Awaited<ReturnType<typeof world>>) => {
    const ports = (h.inbox as unknown as { ports: { sql: { exec: (q: string, ...b: unknown[]) => unknown } } }).ports
    const real = ports.sql
    ports.sql = {
      exec: (q: string, ...b: unknown[]) =>
        /total_changes\(\)/.test(q) ? real.exec('SELECT 0 AS n') : real.exec(q, ...b),
    }
  }

  for (const stuck of [false, true])
    test(`a change made after a read is in the next read: a new email, a close, a read${stuck ? ' (with SQLite’s own count standing still)' : ''}`, async () => {
      const h = await world()
      if (stuck) stuckChangeCount(h)
      const a = asker()
      const before = unwrap(await h.space().navigation(a)).views.inbox
      // Mail arrives: the next read has it.
      h.google.mailbox.add({
        id: 'late',
        threadId: 'tlate',
        from: 'Omar Khan <omar@example.org>',
        subject: 'Late',
        labels: ['INBOX', 'UNREAD'],
        at: T + 60_000,
      })
      h.tick()
      expect((await h.push()).status).toBe(204)
      await h.drain()
      const after = unwrap(await h.space().navigation(a)).views.inbox
      expect(after.count).toBe(before.count + 1)
      expect(after.unread).toBe(before.unread + 1)
      const late = h.inbox.listQueueFacts().find((f) => f.lastActivityAt === new Date(T + 60_000).toISOString())
      expect(late?.unread).toBe(true)
      // Read and closed by the owner: the next read says so, with nothing in between to make the store fold again but the writes themselves.
      const id = late?.id as string
      const conversation = h.inbox.getConversation(id)
      const through = conversation.ok ? conversation.value.through : 0
      unwrap(await h.space().markRead(a, [{ conversationId: id, through }]))
      expect(h.inbox.listQueueFacts().find((f) => f.id === id)?.unread).toBe(false)
      unwrap(await h.space().closeConversations(a, [{ conversationId: id, through }]))
      await h.drain()
      expect(h.inbox.listQueueFacts().find((f) => f.id === id)?.open).toBe(false)
      expect(unwrap(await h.space().navigation(a)).views.inbox.count).toBe(before.count)
    })

  test('what a caller does to the facts it was given does not change what the next caller is given', async () => {
    const h = await world()
    const first = h.inbox.listQueueFacts()
    const id = (first[0] as { id: string }).id
    ;(first[0] as { unread: boolean }).unread = !(first[0] as { unread: boolean }).unread
    ;(first[0] as { clientIds: number[] }).clientIds.push(99)
    const again = h.inbox.listQueueFacts().find((f) => f.id === id)
    expect(again?.unread).toBe(!(first[0] as { unread: boolean }).unread)
    expect(again?.clientIds).not.toContain(99)
  })
})
