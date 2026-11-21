import { type BookingCalls, type CalendarGrant, createInstall, type Install } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { CalendarEngine, type EngineApi } from '../src/engine'
import { createCalendarGoogle, createCalendarWriter, createRunWriter } from '../src/google'
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
/** The space's own address in tests (`https://space.northfield.example`). */
export const ORIGIN = `https://${declaration.space.host}`

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

/** A call as the fake Meet keeps it: what it was made for, its window, and whether it was closed. */
export interface FakeCall {
  key: string
  name: string
  link: string
  title: string
  startsAt: number
  opensAt: number
  closesAt: number
  guest: { name: string; email: string }
  closed: boolean
}

/**
 * The space's Meet as the calendar is handed it (`BookingCalls`): one call for each key, a window each call keeps, and the three ways it can fail a test needs (calls switched off, the month's allowance used up, and Meet not answering).
 * `h.calls` is the list of what was made, in order.
 */
export class FakeCalls implements BookingCalls {
  on = true
  /** The words the allowance's refusal says, or null while calls can be made. */
  meter: string | null = null
  /** While true Meet does not answer: every ask throws. */
  down = false
  readonly made: FakeCall[] = []
  /** Every ask, in order, as `op name`. */
  readonly asked: string[] = []

  private byName(name: string): FakeCall | undefined {
    return this.made.find((c) => c.name === name)
  }

  async check() {
    this.asked.push('check')
    if (this.down) throw new Error('Meet did not answer')
    if (!this.on) return { ok: false as const, why: 'Calls are not turned on in this space.' }
    return this.meter === null ? { ok: true as const } : { ok: false as const, why: this.meter }
  }

  async make(call: { key: string; title: string; startsAt: number; guest: { name: string; email: string }; opensAt: number; closesAt: number }) {
    this.asked.push(`make ${call.key}`)
    if (this.down) throw new Error('Meet did not answer')
    if (!this.on) return { ok: false as const, why: 'Calls are not turned on in this space.' }
    if (this.meter !== null) return { ok: false as const, why: this.meter }
    const had = this.made.find((c) => c.key === call.key)
    if (had) return { ok: true as const, name: had.name, link: had.link }
    const name = `call-${this.made.length + 1}`
    const link = `${ORIGIN}/r/${name}`
    this.made.push({ ...call, name, link, closed: false })
    return { ok: true as const, name, link }
  }

  async move(name: string, when: { startsAt: number; opensAt: number; closesAt: number }) {
    this.asked.push(`move ${name}`)
    if (this.down) throw new Error('Meet did not answer')
    const c = this.byName(name)
    if (!c || c.closed) return { ok: false as const, why: 'There is no such call.' }
    c.startsAt = when.startsAt
    c.opensAt = when.opensAt
    c.closesAt = when.closesAt
    return { ok: true as const }
  }

  async close(name: string) {
    this.asked.push(`close ${name}`)
    if (this.down) throw new Error('Meet did not answer')
    const c = this.byName(name)
    if (c) c.closed = true
    return { ok: true as const }
  }
}

export interface HarnessOptions {
  /** The push address; `null` means none is set (no channels are made). */
  pushUrl?: string | null
  grants?: CalendarGrant[]
  /** False for an engine with no writing client wired (a Worker that cannot change events). */
  writer?: boolean
  /** A Google another harness already uses (two spaces on one Google account); the clock is that Google's. */
  google?: FakeGoogle
  /** The install's declared company id (default: Northfield's). */
  installId?: string
  /** Give the engine a way to tell the owner of a booking; what it was told is `h.notified`. */
  notify?: boolean
  /** Give the engine the space's Meet, to make a booking's call in (the fake above; `h.calls`). Left out, no call can be made. */
  calls?: boolean
}

/**
 * The calendar's engine over a real SQLite with the real migration, a fake Google, a clock that moves only when told, the inbox's word on who is connected (`h.grants`, a list a test edits), and records of what the
 * object was asked to do: the pages told, the alarms asked for.
 */
export function harness(options: HarnessOptions = {}) {
  const mem = memoryDatabase()
  migrate(mem.sql)
  const google = options.google ?? new FakeGoogle({ t: T0 })
  const clock = google.clock
  const grants: CalendarGrant[] = options.grants ?? []
  const logs: string[] = []
  const told = { n: 0 }
  const grantAsks = { n: 0 }
  /** While `down` is true the inbox cannot be reached: asking who is connected throws. */
  const inbox = { down: false }
  const alarms: number[] = []
  const calls = options.calls ? new FakeCalls() : null
  const notified: { id: string; name: string; start: number; end: number; linkName: string }[] = []
  let ids = 0
  let tokens = 0
  const store = new CalendarStore({ sql: mem.sql, transaction: mem.transaction, now: () => clock.t })
  const engine = new CalendarEngine({
    store,
    api: createCalendarGoogle({ fetch: google.fetch, access: google.access, now: () => clock.t }),
    // The writer the object builds (src/durable.ts): its own token, for `calendar.events`, asked for each call.
    ...(options.writer !== false && { writer: createCalendarWriter({ fetch: google.fetch, access: (address, fresh) => google.access(address, fresh, 'events') }) }),
    // The writing client of the alarm's own run (the busy blocks, the space's ADR 0024): its token kept for the run and dropped at its end.
    ...(options.writer !== false && { runWriter: createRunWriter({ fetch: google.fetch, access: (address, fresh) => google.access(address, fresh, 'events') }) }),
    grants: async () => {
      grantAsks.n += 1
      if (inbox.down) throw new Error('the inbox could not be reached')
      return grants.map((g) => ({ ...g }))
    },
    now: () => clock.t,
    zone: ZONE,
    installId: options.installId ?? NORTHFIELD.company.id,
    company: NORTHFIELD.company.name,
    origin: ORIGIN,
    ...(options.notify && { notify: async (booking) => void notified.push(booking) }),
    ...(calls && { calls }),
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
    /** The fake Meet (only with `calls: true`). */
    calls,
    /** What the engine told the owner of bookings, in order (only with `notify: true`). */
    notified,
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
