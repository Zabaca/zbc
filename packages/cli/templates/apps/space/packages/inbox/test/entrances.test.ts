import { describe, expect, test } from 'bun:test'
import type { StoreApi } from '../src/app'
import type { InboundEmail } from '../src/cloudflare/entrance'
import { DAILY_CRON, keepReports, runDaily, takeEmail } from '../src/entrances'
import { FakeBucket } from '../test-support/fake-bucket'

/**
 * The machine entrances as functions over a store (src/entrances.ts), which the space's Worker hands its store.
 * What Cloudflare's mail, queue and cron do with them is the live check; what is held here is what each does
 * with the store it is given: which calls it makes, in what order, and what it tells Cloudflare.
 */

const MAILBOXES = [{ address: 'info@ridgewaycycles.example', name: 'Ridgeway Cycles' }]

/** A store that records every call and answers by name. */
function recording(answers: Record<string, unknown> = {}, fail: string[] = []) {
  const calls: string[] = []
  const store = {
    call: async (method: string) => {
      calls.push(method)
      if (fail.includes(method)) throw new Error(`${method} failed`)
      return answers[method]
    },
  } as unknown as StoreApi
  return { store, calls }
}

const waiting = () => {
  const promises: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void promises.push(p) },
    settled: () => Promise.all(promises),
    count: () => promises.length,
  }
}

function mail(to = 'info@ridgewaycycles.example') {
  const rejected: string[] = []
  const bytes = new TextEncoder().encode('From: a@example.net\r\nTo: x\r\nSubject: hi\r\n\r\nhello')
  const message: InboundEmail = {
    from: 'a@example.net',
    to,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
    setReject: (r) => void rejected.push(r),
  }
  return { message, rejected }
}

describe('Cloudflare’s mail', () => {
  test('is kept in the bucket first, filed by the store, and the notification is handed to waitUntil, not awaited by the handler', async () => {
    const bucket = new FakeBucket()
    const { store, calls } = recording({ fileArrival: { ok: true, value: { outcome: 'filed' } } })
    const w = waiting()
    const { message } = mail()
    expect(await takeEmail(message, { RAW: bucket, INBOX_MAILBOXES: MAILBOXES }, store, w.ctx)).toBe('filed')
    expect(bucket.calls.some((c) => c.startsWith('put:in/'))).toBe(true)
    await w.settled()
    expect(calls).toEqual(['fileArrival', 'deliverNotifications'])
    expect(w.count()).toBe(1)
  })

  test('a message that was already filed rings nothing', async () => {
    const { store, calls } = recording({ fileArrival: { ok: true, value: { outcome: 'duplicate' } } })
    const w = waiting()
    await takeEmail(mail().message, { RAW: new FakeBucket(), INBOX_MAILBOXES: MAILBOXES }, store, w.ctx)
    await w.settled()
    expect(calls).toEqual(['fileArrival'])
  })

  test('a notification that fails is logged and never fails the delivery', async () => {
    const { store } = recording({ fileArrival: { ok: true, value: { outcome: 'filed' } } }, ['deliverNotifications'])
    const w = waiting()
    await takeEmail(mail().message, { RAW: new FakeBucket(), INBOX_MAILBOXES: MAILBOXES }, store, w.ctx)
    await w.settled()
  })

  test('an address on no declared domain is refused outright: nothing is kept and the store is not asked', async () => {
    const bucket = new FakeBucket()
    const { store, calls } = recording()
    const { message, rejected } = mail('someone@elsewhere.example')
    expect(await takeEmail(message, { RAW: bucket, INBOX_MAILBOXES: MAILBOXES }, store, waiting().ctx)).toBe('refused')
    expect(rejected).toHaveLength(1)
    expect([bucket.calls, calls]).toEqual([[], []])
  })

  test('with no mailbox declared, every message is refused, and with no bucket bound a declared domain’s message throws, so Cloudflare is told the delivery failed and nothing is bounced', async () => {
    const { store, calls } = recording()
    const refused = mail()
    expect(await takeEmail(refused.message, { RAW: new FakeBucket() }, store, waiting().ctx)).toBe('refused')
    const unkept = mail()
    await expect(takeEmail(unkept.message, { INBOX_MAILBOXES: MAILBOXES }, store, waiting().ctx)).rejects.toThrow(
      'no raw-mail bucket',
    )
    expect(unkept.rejected).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('the delivery reports', () => {
  const batch = (bodies: unknown[]) => {
    const answered: string[] = []
    return {
      answered,
      batch: {
        messages: bodies.map((body) => ({ body })),
        ackAll: () => void answered.push('ack'),
        retryAll: () => void answered.push('retry'),
      },
    }
  }

  test('a batch the store keeps is acknowledged whole', async () => {
    const { store, calls } = recording({ keepDeliveryEvents: { kept: 1, repeated: 0, dropped: 1, unmatched: 0 } })
    const b = batch([{ a: 1 }, { b: 2 }])
    await keepReports(b.batch, store)
    expect([calls, b.answered]).toEqual([['keepDeliveryEvents'], ['ack']])
  })

  test('a store that fails asks the queue for the whole batch again', async () => {
    const { store } = recording({}, ['keepDeliveryEvents'])
    const b = batch([{ a: 1 }])
    await keepReports(b.batch, store)
    expect(b.answered).toEqual(['retry'])
  })
})

describe('the daily pass', () => {
  test('is the store’s daily run, waited for, and its failure is logged and never thrown', async () => {
    const ok = recording()
    const w = waiting()
    runDaily(ok.store, w.ctx)
    await w.settled()
    // Gmail's pass first, then the mail server's own (renew the push subscription, one sync from the cursor).
    expect(ok.calls).toEqual(['runDaily', 'runJmapDaily'])
    const bad = recording({}, ['runDaily'])
    const w2 = waiting()
    runDaily(bad.store, w2.ctx)
    await w2.settled()
  })

  test('the mail server’s pass fails alone: Gmail’s is still asked, and the failure is logged and never thrown', async () => {
    const bad = recording({}, ['runJmapDaily'])
    const w = waiting()
    runDaily(bad.store, w.ctx)
    await w.settled()
    expect(bad.calls).toEqual(['runDaily', 'runJmapDaily'])
  })

  test('has its own expression, which is not meet’s five-minute sweep', () => {
    expect(DAILY_CRON).toBe('47 9 * * *')
  })
})
