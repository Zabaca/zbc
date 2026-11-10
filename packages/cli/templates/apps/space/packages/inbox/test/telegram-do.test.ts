// A live Telegram push through the real Durable Object class (`InboxDO.call`), over a real SQLite behind the real migrations, with a fake push service in place of the network: the notification the
// store marked owed is delivered to the device (encrypted to it, naming the sender and not the words), and the delivery is handed to `ctx.waitUntil` and never awaited, so a push service that does not
// answer cannot hold the bridge's reply. The class is driven as packages/inbox/test/live.test.ts drives it. What this cannot show is a phone: that is the hand test.
import { Database } from 'bun:sqlite'
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { generateVapidKey } from '../src/notify/webpush'
import { deferredStart } from '../test-support/deferred-start'
import { decrypt, newDevice } from '../test-support/push-device'
import { sqlOver } from '../test-support/sql-over-sqlite'
import { chat, message, push } from '../test-support/telegram'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

type Obj = { call(method: string, args: unknown[]): Promise<unknown> }
let InboxDO: new (ctx: unknown, env: unknown) => Obj
let vapid: string
const realFetch = globalThis.fetch

beforeAll(async () => {
  InboxDO = ((await import('../src/durable')) as unknown as { InboxDO: typeof InboxDO }).InboxDO
  vapid = await generateVapidKey()
})
afterEach(() => {
  globalThis.fetch = realFetch
})

/** The object, with the work it handed to `waitUntil` kept for the test to see. */
async function made() {
  const start = deferredStart()
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  const background: Promise<unknown>[] = []
  const ctx = {
    storage: {
      sql: sqlOver(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: start.blockConcurrencyWhile,
    waitUntil: (p: Promise<unknown>) => void background.push(p),
  }
  const live = { idFromName: (n: string) => n, get: () => ({ tell: () => {}, openPeople: () => [] }) }
  const object = new InboxDO(ctx, { LIVE: live, INBOX_VAPID_KEY: vapid }) as Obj
  await start.started()
  return { object, background }
}

const fresh = () => new Date(Date.now() - 60_000).toISOString()
const livePush = () => ({
  ...push([chat()], [message({ id: 1, at: fresh(), text: 'the door code is 4412' })]),
  live: true,
})

async function withDevice(object: Obj) {
  const device = await newDevice()
  const added = (await object.call('addDevice', [device, null, 'tessa@northfield.example'])) as { ok: boolean }
  expect(added.ok).toBe(true)
  return device
}

describe('a live Telegram push through the Durable Object', () => {
  test('delivers what is owed to the device: who wrote, never what they said, and once', async () => {
    const { object, background } = await made()
    const device = await withDevice(object)
    const sent: { url: string; body: Uint8Array }[] = []
    globalThis.fetch = (async (url: string, init: { body: Uint8Array }) => {
      sent.push({ url, body: init.body })
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch

    const res = (await object.call('pushTelegram', [livePush()])) as { ok: boolean; value: { stored: number } }
    expect(res.ok && res.value.stored).toBe(1)
    await Promise.all(background)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(device.endpoint)
    const payload = JSON.parse((await decrypt(device, sent[0]?.body as Uint8Array)).text)
    expect(payload).toMatchObject({ kind: 'message', title: 'Telegram: Dana Reyes', body: 'New Telegram message' })
    expect(JSON.stringify(payload)).not.toContain('door code')
    // The same push again stores nothing and delivers nothing more.
    await object.call('pushTelegram', [livePush()])
    await Promise.all(background)
    expect(sent).toHaveLength(1)
  })

  test('a fill or a catch-up (a push not marked live) delivers nothing', async () => {
    const { object, background } = await made()
    await withDevice(object)
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
    await object.call('pushTelegram', [push([chat()], [message({ id: 1, at: fresh() })])])
    await Promise.all(background)
    expect(calls).toBe(0)
  })

  test('the reply does not wait for the push service: one that never answers leaves the push stored and answered', async () => {
    const { object, background } = await made()
    await withDevice(object)
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    const res = (await Promise.race([
      object.call('pushTelegram', [livePush()]),
      new Promise((r) => setTimeout(() => r('timed out'), 2000)),
    ])) as { ok: boolean }
    expect(res).not.toBe('timed out')
    expect(res.ok).toBe(true)
    // The delivery was handed to `waitUntil` and is still waiting on the push service.
    expect(background).toHaveLength(1)
  })

  test('a delivery that fails is logged and never reaches the push', async () => {
    const { object, background } = await made()
    await withDevice(object)
    globalThis.fetch = (async () => {
      throw new Error('the network is gone')
    }) as unknown as typeof fetch
    const res = (await object.call('pushTelegram', [livePush()])) as { ok: boolean }
    expect(res.ok).toBe(true)
    await expect(Promise.all(background)).resolves.toBeDefined()
  })
})
