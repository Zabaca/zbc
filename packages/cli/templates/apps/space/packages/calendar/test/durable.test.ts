// The calendar store's Durable Object (src/durable.ts), driven the way the space's Worker drives it. `cloudflare:workers` exists only in the Workers runtime, so it is stood in for with the one base class; everything
// else is the object's own wiring (the declaration's owners and time zone, the migration, the inbox asked for grants and tokens), over a real SQLite and a fake Google.
//
// What this proves that the logic tests cannot: that the object answers only the engine's own face by name (the runtime exposes every method of a class over RPC, so the class must have exactly `call` and the alarm),
// that it asks the INBOX for who is connected and for a token and nothing else, that it keeps no refresh token, and that a push, then the alarm, reads Google and tells the page.
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { CalendarAccess, CalendarGrant } from '@space/workspace'
import { FakeGoogle } from '../test-support/fake-google'
import { grant, HOUR, T0, ZONE } from '../test-support/harness'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

type Obj = { call(method: string, args: unknown[]): unknown; alarm(): Promise<void> }
let CalendarDO: new (ctx: unknown, env: unknown) => Obj
let pushUrlOf: (v: string | undefined) => string | null

beforeAll(async () => {
  const mod = (await import('../src/durable')) as unknown as { CalendarDO: typeof CalendarDO; pushUrlOf: typeof pushUrlOf }
  CalendarDO = mod.CalendarDO
  pushUrlOf = mod.pushUrlOf
})

const Z = 'tessa@northfield.example'
const iso = (ms: number) => new Date(ms).toISOString()

function environment(options: { push?: string } = {}) {
  const mem = memoryDatabase()
  const google = new FakeGoogle({ t: Date.now() })
  const grants: CalendarGrant[] = [grant(Z)]
  const inboxCalls: string[] = []
  google.account(Z)
  const told: unknown[] = []
  let alarm: number | null = null
  const ctx = {
    storage: {
      sql: mem.sql,
      transactionSync: mem.transaction,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at
      },
    },
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
  }
  const inbox = {
    call: async (method: string, args: unknown[]) => {
      inboxCalls.push(method)
      if (method === 'calendarGrants') return grants
      if (method === 'calendarAccess') return google.access(args[0] as string, args[1] === true) as Promise<CalendarAccess>
      throw new Error(`the calendar asked the inbox for ${method}`)
    },
  }
  // The object reaches Google with the global fetch: stand it in for the fake.
  const realFetch = globalThis.fetch
  globalThis.fetch = ((url: string, init?: RequestInit) => google.fetch(url, init)) as typeof fetch
  const env = {
    CALENDAR_PUSH_URL: options.push ?? 'https://inbox-push.northfield.example/calendar/push',
    INBOX: { idFromName: (n: string) => n, get: () => inbox },
    LIVE: { idFromName: (n: string) => n, get: () => ({ tell: (m: unknown) => told.push(m), openPeople: () => [] }) },
    CALENDAR: undefined,
  }
  const object = new CalendarDO(ctx, env)
  return { mem, object, google, told, inboxCalls, getAlarm: () => alarm, restore: () => (globalThis.fetch = realFetch) }
}

describe('the object', () => {
  test('has `call` and the alarm and nothing else public', () => {
    expect(Object.getOwnPropertyNames(CalendarDO.prototype).filter((n) => n !== 'constructor').sort()).toEqual(['alarm', 'call'])
  })

  test('answers only the engine’s own face by name, and nothing else the class happens to have', () => {
    const { object, restore } = environment()
    try {
      for (const bad of ['constructor', 'alarm', 'work', 'start', 'sync', 'd', 'fresh', 'isOwner']) expect(() => object.call(bad, [])).toThrow('No such method')
    } finally {
      restore()
    }
  })

  test('migrates its storage when it is made, and asks for its first alarm', async () => {
    const { mem, getAlarm, restore } = environment()
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect((mem.db.query(`SELECT applied FROM calendar_meta`).get() as { applied: number }).applied).toBe(2)
      expect(getAlarm()).not.toBeNull()
    } finally {
      restore()
    }
  })

  test('the alarm asks the inbox who is connected and for a token, reads Google, tells the owners’ pages, and the page can then read the agenda from the store', async () => {
    const { object, google, told, inboxCalls, restore } = environment()
    try {
      const now = Date.now()
      google.clock.t = now
      google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
      google.setEvent(Z, Z, { id: 'e', summary: 'Standup', start: iso(now + HOUR), end: iso(now + 2 * HOUR) })
      await object.alarm()
      const got = (await object.call('agenda', [now, now + 24 * HOUR])) as { ok: boolean; value: { events: { title: string }[] } }
      expect(got.value.events.map((e) => e.title)).toEqual(['Standup'])
      // The inbox is asked for grants and tokens and for nothing else (the stand-in throws for any other method).
      expect(new Set(inboxCalls)).toEqual(new Set(['calendarGrants', 'calendarAccess']))
      expect(told).toContainEqual({ part: 'calendar', people: expect.arrayContaining([Z]) })
      // Google was shown a calendar-only token (the stand-in names the account), never anything of the refresh token.
      expect(google.bearers.every((b) => b.startsWith('tok-'))).toBe(true)
    } finally {
      restore()
    }
  })

  test('a notification, then the alarm, reads the change; the notification itself reads nothing', async () => {
    const { object, google, restore } = environment()
    try {
      const now = Date.now()
      google.clock.t = now
      google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
      await object.alarm()
      google.setEvent(Z, Z, { id: 'n', summary: 'New', start: iso(now + HOUR), end: iso(now + 2 * HOUR) })
      const headers = google.notification(Z, Z) as Record<string, string>
      const mark = google.calls.length
      const accepted = await object.call('receivePush', [{ channelId: headers['x-goog-channel-id'], token: headers['x-goog-channel-token'], resourceId: headers['x-goog-resource-id'], state: 'exists' }])
      expect(accepted).toBe(true)
      expect(google.calls.length).toBe(mark)
      await object.alarm()
      expect(google.calls.slice(mark)).toContain(`events.list:${Z}:sync`)
    } finally {
      restore()
    }
  })

  test('keeps no refresh token: nothing in its storage looks like one, whatever it was handed', async () => {
    const { mem, object, google, restore } = environment()
    try {
      google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
      await object.alarm()
      const dump = JSON.stringify(
        ['account', 'calendar', 'event', 'channel'].map((t) => mem.db.query(`SELECT * FROM ${t}`).all()),
      )
      expect(dump).not.toMatch(/refresh/i)
      expect(ZONE).toBe('America/Los_Angeles')
      expect(T0).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })
})

describe('the push address', () => {
  test('is used only when it is a plain https address with a path', () => {
    expect(pushUrlOf('https://inbox-push.northfield.example/calendar/push')).toBe('https://inbox-push.northfield.example/calendar/push')
    for (const bad of [undefined, '', 'http://inbox-push.northfield.example/calendar/push', 'https://inbox-push.northfield.example/', 'https://x.example/p?q=1', 'https://x.example/p#h', 'not a url']) expect(pushUrlOf(bad)).toBeNull()
  })
})
