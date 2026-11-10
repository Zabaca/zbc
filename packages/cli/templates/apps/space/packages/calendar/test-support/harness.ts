import { type CalendarGrant, createInstall, type Install } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { CalendarEngine, type EngineApi } from '../src/engine'
import { createCalendarGoogle } from '../src/google'
import { migrate } from '../src/schema'
import { CalendarStore } from '../src/store'
import { FakeGoogle } from './fake-google'
import { memoryDatabase } from './sql-over-sqlite'

/** The clock tests start at: Thursday 5 November 2026, noon in Los Angeles (20:00 UTC). */
export const T0 = Date.UTC(2026, 10, 5, 20, 0, 0)
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const ZONE = 'America/Los_Angeles'
export const PUSH_URL = 'https://inbox-push.northfield.example/calendar/push'

export const OWNER = 'tessa@northfield.example'
export const NORTHFIELD = createInstall(declaration)
/** Northfield's declaration with a teammate who is not an owner, for the owner-only checks. */
export const WITH_TEAMMATE: Install = createInstall({
  ...declaration,
  people: [...declaration.people, { address: 'dana@northfield.example', name: 'Dana', role: 'member' }],
})

export const grant = (address: string, extra: Partial<CalendarGrant> = {}): CalendarGrant => ({
  address,
  label: address.split('@')[0] as string,
  connected: true,
  lapsed: false,
  calendar: true,
  events: true,
  ...extra,
})

export interface HarnessOptions {
  /** The push address; `null` means none is set (no channels are made). */
  pushUrl?: string | null
  grants?: CalendarGrant[]
}

/**
 * The calendar's engine over a real SQLite with the real migration, a fake Google, a clock that moves only when told, the inbox's word on who is connected (`h.grants`, a list a test edits), and records of what the
 * object was asked to do: the pages told, the alarms asked for.
 */
export function harness(options: HarnessOptions = {}) {
  const mem = memoryDatabase()
  migrate(mem.sql)
  const clock = { t: T0 }
  const google = new FakeGoogle(clock)
  const grants: CalendarGrant[] = options.grants ?? []
  const logs: string[] = []
  const told = { n: 0 }
  const grantAsks = { n: 0 }
  /** While `down` is true the inbox cannot be reached: asking who is connected throws. */
  const inbox = { down: false }
  const alarms: number[] = []
  let ids = 0
  let tokens = 0
  const store = new CalendarStore({ sql: mem.sql, transaction: mem.transaction, now: () => clock.t })
  const engine = new CalendarEngine({
    store,
    api: createCalendarGoogle({ fetch: google.fetch, access: google.access, now: () => clock.t }),
    grants: async () => {
      grantAsks.n += 1
      if (inbox.down) throw new Error('the inbox could not be reached')
      return grants.map((g) => ({ ...g }))
    },
    now: () => clock.t,
    zone: ZONE,
    pushUrl: options.pushUrl === undefined ? PUSH_URL : options.pushUrl,
    newId: () => `channel-${++ids}`,
    newToken: () => `secret-${++tokens}`,
    tell: () => {
      told.n += 1
    },
    alarmAt: (at) => {
      alarms.push(at)
    },
    log: (line) => logs.push(line),
  })
  const api: EngineApi = { call: (method, ...args) => (engine[method] as (...a: unknown[]) => unknown).apply(engine, args) as never }
  return {
    ...mem,
    clock,
    google,
    grants,
    store,
    engine,
    api,
    told,
    /** How many times the engine asked the inbox who is connected. */
    grantAsks,
    /** `inbox.down = true` makes the inbox unreachable. */
    inbox,
    alarms,
    logs,
    /** Move the clock. */
    advance: (ms: number) => {
      clock.t += ms
    },
    /** The alarm's work, once. */
    work: () => engine.work(),
    /** Connect an account the way the inbox would tell it, with Google knowing it too. */
    connect(address: string, extra: Partial<CalendarGrant> = {}) {
      grants.push(grant(address, extra))
      google.account(address)
    },
    rows: <T>(sql: string): T[] => mem.db.query(sql).all() as T[],
  }
}

export type Harness = ReturnType<typeof harness>

/** An Access-free `SignedIn`: the owner, and a teammate who is not one. */
export { signedIn } from '@space/workspace'
export const person = (install: Install, address: string) => {
  const p = install.person(address)
  if (!p) throw new Error(`no person ${address}`)
  return p
}
