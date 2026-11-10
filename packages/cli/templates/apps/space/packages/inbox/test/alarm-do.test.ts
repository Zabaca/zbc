// The Durable Object's one alarm through the real class: the order it runs the two sides in (Gmail first, then the mailboxes on the mail server), and that a failure on either side is its own. Gmail's side must behave as it
// did before the mail server's existed: the alarm still FAILS when Gmail's run fails (the runtime retries it), and it is Gmail's run that is skipped only when it asked for a later time. What is new is that
// Gmail failing no longer skips the mail server's pass, which every retry would otherwise repeat for as long as Gmail failed.
import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { deferredStart } from '../test-support/deferred-start'
import { sqlOver } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

interface Alarmed {
  alarm(): Promise<void>
  mailroom: { runAlarm: () => Promise<unknown> }
  jmapRoom: { runAlarm: () => Promise<unknown> }
  wanted: { gmail: number | null; jmap: number | null }
}
let InboxDO: new (ctx: unknown, env: unknown) => Alarmed

beforeAll(async () => {
  InboxDO = ((await import('../src/durable')) as unknown as { InboxDO: typeof InboxDO }).InboxDO
})

async function made() {
  const start = deferredStart()
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  const alarms: (number | null)[] = []
  const ctx = {
    storage: {
      sql: sqlOver(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => null,
      setAlarm: async (at: number) => void alarms.push(at),
    },
    blockConcurrencyWhile: start.blockConcurrencyWhile,
    waitUntil: () => {},
  }
  const told: number[] = []
  const live = {
    idFromName: (n: string) => n,
    get: () => ({ tell: () => void told.push(Date.now()), openPeople: () => [] }),
  }
  const object = new InboxDO(ctx, { LIVE: live }) as Alarmed
  await start.started()
  const order: string[] = []
  return { object, order, alarms, told }
}

describe('the alarm', () => {
  test('runs Gmail first and then the mail server’s mailboxes, once each, and tells the space that mail may have moved', async () => {
    const { object, order, told } = await made()
    spyOn(object.mailroom, 'runAlarm').mockImplementation(async () => void order.push('gmail'))
    spyOn(object.jmapRoom, 'runAlarm').mockImplementation(async () => void order.push('jmap'))
    await object.alarm()
    expect(order).toEqual(['gmail', 'jmap'])
    expect(told.length).toBeGreaterThan(0)
  })

  test('Gmail failing still fails the alarm, as it always did, but only AFTER the mail server’s pass has run, ', async () => {
    const { object, order } = await made()
    const boom = new Error('gmail is down')
    spyOn(object.mailroom, 'runAlarm').mockImplementation(async () => {
      order.push('gmail')
      throw boom
    })
    spyOn(object.jmapRoom, 'runAlarm').mockImplementation(async () => void order.push('jmap'))
    await expect(object.alarm()).rejects.toBe(boom)
    expect(order).toEqual(['gmail', 'jmap'])
  })

  test('the mail server failing never fails Gmail’s alarm and never reaches it: the alarm completes', async () => {
    const { object, order } = await made()
    spyOn(object.mailroom, 'runAlarm').mockImplementation(async () => void order.push('gmail'))
    spyOn(object.jmapRoom, 'runAlarm').mockImplementation(async () => {
      order.push('jmap')
      throw new Error('the mail server is down')
    })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    await object.alarm()
    expect(order).toEqual(['gmail', 'jmap'])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  test('an alarm that is only the mail server’s (Gmail asked for a later time) leaves Gmail’s run to wait, as before, and runs the mail server’s', async () => {
    const { object, order } = await made()
    object.wanted.gmail = Date.now() + 60 * 60 * 1000
    spyOn(object.mailroom, 'runAlarm').mockImplementation(async () => void order.push('gmail'))
    spyOn(object.jmapRoom, 'runAlarm').mockImplementation(async () => void order.push('jmap'))
    await object.alarm()
    expect(order).toEqual(['jmap'])
  })
})
