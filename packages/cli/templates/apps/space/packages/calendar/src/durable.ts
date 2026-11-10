import { DurableObject } from 'cloudflare:workers'
import { liveOf, ownersOf, tellLive } from '@space/workspace'
import { CalendarEngine, ENGINE_METHODS, type EngineMethod } from './engine'
import { createCalendarGoogle } from './google'
import { migrate } from './schema'
import { type CalendarEnv, inboxFor } from './store-access'
import { CalendarStore } from './store'
import { bundledInstall } from './workspace'

/** The https address Google's notifications are sent to, or null when the setting is missing or is anything else (no channel is then made, and the safety resync alone keeps the calendar current). */
export function pushUrlOf(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && url.search === '' && url.hash === '' && url.pathname !== '/' ? url.toString() : null
  } catch {
    return null
  }
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The calendar store's Durable Object. The one file of this package that touches the Workers runtime.
 *
 * The space's Worker (packages/space) OWNS the store and runs the Calendar tab, Today's events and Settings, Calendars in-process over it; Google's notifications reach it through the push host
 * (packages/space/src/worker.ts). It is a NEW class, declared as new under `exports` in the space's Worker settings (the install kit's output) with nothing transferred: it starts empty and reads Google in full.
 *
 * Nothing in it is the only copy of anything. It holds no refresh token: the grant is the inbox's, and this object asks the inbox's store (the object found by `INBOX_OBJECT_NAME`, in the same Worker) who is connected and for an
 * access token limited to the calendar permission (packages/space/docs/adr/0020).
 */
export class CalendarDO extends DurableObject<CalendarEnv> {
  private readonly engine: CalendarEngine

  constructor(ctx: DurableObjectState, env: CalendarEnv) {
    super(ctx, env)
    // Before a single request is served, and on every wake from hibernation. A store a newer build migrated throws here.
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
    console.log('calendar: the store object started')
    // Not a stub held from here on: each ask gets its own (src/store-access.ts, `inboxFor`), so an inbox that was restarted is asked again at once.
    const inbox = inboxFor(env)
    const now = () => Date.now()
    const store = new CalendarStore({ sql: ctx.storage.sql, transaction: (fn) => ctx.storage.transactionSync(fn), now })
    this.engine = new CalendarEngine({
      store,
      api: createCalendarGoogle({
        fetch: (url, init) => fetch(url, init),
        access: (address, fresh) => inbox.access(address, fresh),
        now,
      }),
      grants: () => inbox.grants(),
      now,
      zone: bundledInstall.company.timeZone,
      pushUrl: pushUrlOf(env.CALENDAR_PUSH_URL),
      newId: () => crypto.randomUUID(),
      newToken: () => hex(crypto.getRandomValues(new Uint8Array(24))),
      // After the store has it, and never part of it: a message that cannot be delivered changes nothing here (packages/workspace/src/live.ts, `tellLive`).
      tell: () => tellLive(liveOf(env), { part: 'calendar', people: ownersOf(bundledInstall) }),
      alarmAt: async (at) => {
        // Never later than an alarm already waiting: the soonest owed read wins.
        const waiting = await ctx.storage.getAlarm()
        if (waiting === null || waiting <= Date.now() || at < waiting) await ctx.storage.setAlarm(Math.max(at, Date.now()))
      },
      log: (line) => console.log(line),
    })
    // The first alarm of a started object: reads may be owed (a store just made, a restart).
    ctx.blockConcurrencyWhile(() => this.engine.start())
  }

  /**
   * The only way in to the store, and only to the engine's own face (ENGINE_METHODS). Meant to be called by the Worker that owns the class alone, but nothing in the code enforces that: the real boundary is who may
   * deploy to the account, as for every Worker here. The owner check is the space's face (src/space.ts), which takes the person the one sign-in check named; Google's push is checked by the channel's own secret.
   */
  call(method: EngineMethod, args: unknown[]): unknown {
    if (!(ENGINE_METHODS as readonly string[]).includes(method)) throw new Error(`No such method: ${method}`)
    return (this.engine[method] as (...a: unknown[]) => unknown).apply(this.engine, args)
  }

  /** Whatever is owed: who is connected, lists, events, channels. Then the next alarm. */
  override async alarm(): Promise<void> {
    await this.engine.work()
  }
}
