/**
 * What the Durable Object does: the store, the sync and the alarm, behind the methods the space's face calls. No runtime import (src/durable.ts has the object), so `bun test` drives it over a real SQLite and a
 * fake Google with a clock the test moves.
 *
 * Reads (`calendars`, `agenda`, `event`) answer from the store and never from Google. A change the owner makes (`setShown`, `syncNow`) is stored and owes the alarm a read; the alarm (`work`) is where Google is asked.
 * A notification (`receivePush`) is one write and an alarm, and answers at once: a slow Google must never make Google's own push wait.
 */

import { CALENDAR_WINDOW_MAX_MS, type CalendarAccountView, type CalendarAgenda, type CalendarEvent, type CalendarView, type RefusalReason } from '@space/workspace'
import { CalendarSync, type PushHeaders, type SyncDeps } from './sync'

export type Result<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason; error: string }
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const no = (reason: RefusalReason, error: string): Result<never> => ({ ok: false, reason, error })

/** How old the inbox's word on who is connected may be before a screen's read asks it again. */
export const GRANTS_FRESH_MS = 30_000

/** What a calendar's or an event's id looks like: the address and Google's ids joined by `|`. The check keeps anything path-shaped or enormous out of a query. */
export const CALENDAR_ID = /^[A-Za-z0-9@._#%+~:=|-]{1,900}$/

export interface EngineDeps extends SyncDeps {
  /** Tell the page the calendar changed (after it is stored). */
  tell: () => void
  /** Ask for the alarm at this time, ms. */
  alarmAt: (at: number) => void | Promise<void>
}

export class CalendarEngine {
  readonly sync: CalendarSync
  private lastRefresh = Number.NEGATIVE_INFINITY
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: EngineDeps) {
    this.sync = new CalendarSync(d)
  }

  /** Ask the inbox who is connected, unless it was asked a moment ago. A new or returning account owes the alarm a read. */
  private async fresh(): Promise<void> {
    const now = this.d.now()
    if (now - this.lastRefresh < GRANTS_FRESH_MS) return
    this.lastRefresh = now
    if (await this.sync.refreshAccounts()) {
      this.d.tell()
      await this.d.alarmAt(this.sync.nextWake())
    }
  }

  async calendars(): Promise<Result<CalendarAccountView[]>> {
    await this.fresh()
    return ok(this.d.store.accountViews())
  }

  async agenda(from: number, to: number): Promise<Result<CalendarAgenda>> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return no('bad-request', 'An agenda is from one moment to a later one.')
    if (to - from > CALENDAR_WINDOW_MAX_MS) return no('bad-request', 'An agenda covers at most 62 days at a time.')
    await this.fresh()
    return ok(this.d.store.agenda(from, to))
  }

  event(id: string): Result<CalendarEvent> {
    if (typeof id !== 'string' || !CALENDAR_ID.test(id)) return no('not-found', 'No such event.')
    const found = this.d.store.event(id)
    return found ? ok(found) : no('not-found', 'That event is gone: it was changed or removed in Google Calendar.')
  }

  async setShown(calendarId: string, shown: boolean): Promise<Result<CalendarView>> {
    if (typeof calendarId !== 'string' || !CALENDAR_ID.test(calendarId)) return no('not-found', 'No such calendar.')
    if (typeof shown !== 'boolean') return no('bad-request', 'Say whether the calendar is shown.')
    const done = this.d.store.setShown(calendarId, shown)
    const view = done.calendar ? this.d.store.calendarView(done.calendar.id) : null
    if (!view) return no('not-found', 'No such calendar.')
    if (done.changed) {
      this.d.tell()
      await this.d.alarmAt(this.d.now())
    }
    return ok(view)
  }

  async syncNow(): Promise<Result<{ asked: number }>> {
    this.lastRefresh = Number.NEGATIVE_INFINITY
    await this.fresh()
    const asked = this.d.store.askAll()
    await this.d.alarmAt(this.d.now())
    return ok({ asked })
  }

  /** Google's notification: one write and an alarm. `false` is "not a channel of ours", which the Worker answers with nothing to learn from. */
  async receivePush(h: PushHeaders): Promise<boolean> {
    const accepted = this.sync.receivePush(h)
    if (accepted) await this.d.alarmAt(this.d.now())
    return accepted
  }

  /** The alarm: everything owed, one run at a time, then the next alarm. */
  work(): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        if (await this.sync.run()) this.d.tell()
      } catch (error) {
        this.d.log?.(`calendar: a run failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // At least a second on: a read that is owed and cannot be done must not spin the alarm.
      await this.d.alarmAt(Math.max(this.sync.nextWake(), this.d.now() + 1000))
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Ask for the first alarm (the object has just started and may have reads owed). */
  async start(): Promise<void> {
    await this.d.alarmAt(this.sync.nextWake())
  }
}

/** The methods the object's `call` runs, and no others. */
export const ENGINE_METHODS = ['calendars', 'agenda', 'event', 'setShown', 'syncNow', 'receivePush'] as const satisfies readonly (keyof CalendarEngine)[]
export type EngineMethod = (typeof ENGINE_METHODS)[number]

/** The typed face of the object's untyped `call`. */
export type EngineApi = {
  call<K extends EngineMethod>(method: K, ...args: Parameters<CalendarEngine[K]>): Promise<Awaited<ReturnType<CalendarEngine[K]>>>
}
