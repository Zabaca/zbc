import { describe, expect, test } from 'bun:test'
import { createInboxPartFactory, type InboxPartEnv } from '../src/space-part'
import { AGENT_ID, asker, harness, OWNER, STRANGER, TELEGRAM_ID } from '../test-support/harness'

/**
 * The space's five busiest reads run whole in the store's object (src/space-reads.ts): from the space's Worker each is ONE call to the object, where each was a chain of calls, every one a round trip
 * on Cloudflare. What these hold: the Worker's part makes one call per read, the answer is the same as the part made step by step answers, and a person the object does not admit is refused there.
 */

const T = Date.parse('2026-11-10T12:00:00.000Z')

/** A namespace over the harness's store, as `env.INBOX` is in a Worker, counting each call the Worker makes to the object. */
function countingNamespace(h: ReturnType<typeof harness>, calls: string[]): InboxPartEnv['INBOX'] {
  const stub = {
    call: (method: string, args: unknown[]) => {
      calls.push(method)
      return (h.store.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)
    },
    restart: async () => {},
  }
  return { idFromName: (name: string) => name, get: () => stub } as unknown as InboxPartEnv['INBOX']
}

async function world() {
  const h = harness({}, { ai: null })
  const g = h.google.mailbox
  for (let i = 0; i < 12; i++)
    g.add({
      id: `g${i}`,
      threadId: `t${i % 8}`,
      from: i % 3 === 2 ? 'Shop News <news@shop.example>' : `Dana Reyes <dana@harbor.example>`,
      subject: `Thread ${i % 8} about the hull`,
      at: T - i * 60_000,
      labels: i % 4 === 3 ? [] : ['INBOX', ...(i % 2 === 0 ? ['UNREAD'] : [])],
      headers: i % 3 === 2 ? { 'List-Unsubscribe': '<mailto:out@shop.example>' } : {},
    })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  const calls: string[] = []
  const part = createInboxPartFactory()({
    INBOX: countingNamespace(h, calls),
    clients: h.directory,
    INBOX_ACCESS_CLIENT_ID: AGENT_ID,
    TELEGRAM_ACCESS_CLIENT_ID: TELEGRAM_ID,
  })
  const dana = (
    h.db.query(`SELECT contact_id FROM identity WHERE address = 'dana@harbor.example'`).get() as { contact_id: string }
  ).contact_id
  return { h, part, calls, dana }
}

describe('the space’s five reads, run whole in the object', () => {
  test('each is one call from the Worker, and answers what the part made step by step answers', async () => {
    const { h, part, calls, dana } = await world()
    const a = asker(OWNER)
    // The part as it was: every step a call of its own (the harness's in-process part).
    const stepByStep = h.space()
    const reads: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['readPeople', () => part.people(a), () => stepByStep.people(a)],
      [
        'readPeople',
        () => part.people(a, { include: ['bulk', 'closed'], addresses: ['dana@harbor.example'] }),
        () => stepByStep.people(a, { include: ['bulk', 'closed'], addresses: ['dana@harbor.example'] }),
      ],
      ['readNavigation', () => part.navigation(a), () => stepByStep.navigation(a)],
      [
        'readMessagesWith',
        () => part.messagesWith(a, { contactId: dana }, { include: ['bulk', 'closed'] }),
        () => stepByStep.messagesWith(a, { contactId: dana }, { include: ['bulk', 'closed'] }),
      ],
      ['readDrafts', () => part.drafts(a), () => stepByStep.drafts(a)],
      ['readSearch', () => part.search(a, 'hull'), () => stepByStep.search(a, 'hull')],
    ]
    for (const [name, viaObject, inProcess] of reads) {
      calls.length = 0
      const whole = await viaObject()
      expect([name, calls]).toEqual([name, [name]])
      expect(whole).toMatchObject({ ok: true })
      expect(whole).toEqual(await inProcess())
    }
  })

  test('a person the install does not admit is refused in the object, as in the Worker', async () => {
    const { part, calls } = await world()
    const stranger = asker(STRANGER)
    for (const read of [
      () => part.people(stranger),
      () => part.navigation(stranger),
      () => part.drafts(stranger),
      () => part.search(stranger, 'hull'),
    ]) {
      calls.length = 0
      expect(await read()).toMatchObject({ ok: false, reason: 'not-admitted' })
      expect(calls).toHaveLength(1)
    }
  })
})
