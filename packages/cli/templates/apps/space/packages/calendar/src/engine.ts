/**
 * What the Durable Object does: the store, the sync and the alarm, behind the methods the space's face calls. No runtime import (src/durable.ts has the object), so `bun test` drives it over a real SQLite and a
 * fake Google with a clock the test moves.
 *
 * Reads (`calendars`, `agenda`, `event`) answer from the store and never from Google. A change the owner makes (`setShown`, `syncNow`) is stored and owes the alarm a read; the alarm (`work`) is where Google is asked.
 * A notification (`receivePush`) is one write and an alarm, and answers at once: a slow Google must never make Google's own push wait.
 */

import {
  CALENDAR_BY_UID_MOST,
  CALENDAR_UID_MAX,
  CALENDAR_WINDOW_MAX_MS,
  type BookingLinkView,
  type CalendarAccountView,
  type CalendarAgenda,
  type CalendarBlocking,
  type CalendarBookingLinks,
  type CalendarEventCancelled,
  type CalendarClaudeAgenda,
  type BookingCalls,
  type CalendarEvent,
  type CalendarEventAsk,
  type CalendarView,
  type CalendarEventMade,
  type GuestBooked,
  type GuestBookingLink,
  type GuestBookingSlots,
  type GuestBookingView,
  type RefusalReason,
} from '@space/workspace'
import { CalendarBlocks } from './blocks'
import { CalendarBookings } from './bookings'
import type { CalendarWriteApi, RunWriter } from './google'
import { CalendarSync, type PushHeaders, type SyncDeps } from './sync'
import { CalendarWrites } from './writes'

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
  /**
   * Google's writing client, for Claude's invites, moves and cancellations (the space's ADR 0023): a token for `calendar.events` alone, asked for each call. Absent where nothing is wired to write, and every write is then refused in
   * words. The sync never uses it.
   */
  writer?: ((address: string) => CalendarWriteApi) | undefined
  /**
   * The writing client for the calendar's own alarm (the space's ADR 0024): a new one for every run of the busy blocks, its tokens (for `calendar.events` alone) kept for that run and dropped when it ends. Absent where nothing is wired to write: a run
   * with blocks to make or remove then says so. The sync never uses it, and nothing but `src/blocks.ts` asks for one.
   */
  runWriter?: (() => RunWriter) | undefined
  /** The install's declared company id (the busy blocks' install key is hashed from it, so a block is known as this install's across a lost store; so is a booking's event id). */
  installId: string
  /** The company's name, as a visitor to a booking link reads it. */
  company: string
  /** `https://<space host>`: what a booking link's address and a booking's own address are made from. */
  origin: string
  /** Tell the owner a booking was made, in their own notifications (the inbox's, asked in-process by the object). Absent where nothing is wired: nobody is told. Best effort. */
  notify?: ((booking: { id: string; name: string; start: number; end: number; linkName: string }) => Promise<void>) | undefined
  /** A way to make, move and close a call in the space's own Meet, for a booking link that holds its meetings there (the space's ADR 0026). Absent where nothing is wired: such a link cannot be booked, and "Where" is not offered. */
  calls?: BookingCalls | undefined
}

export class CalendarEngine {
  readonly sync: CalendarSync
  private readonly writes: CalendarWrites
  private readonly blocks: CalendarBlocks
  private readonly bookings: CalendarBookings
  private lastRefresh = Number.NEGATIVE_INFINITY
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: EngineDeps) {
    this.sync = new CalendarSync(d)
    this.writes = new CalendarWrites({ store: d.store, writer: d.writer, newId: d.newId, now: d.now, zone: d.zone, tell: d.tell, alarmAt: d.alarmAt, log: d.log })
    this.blocks = new CalendarBlocks({ store: d.store, runWriter: d.runWriter, now: d.now, zone: d.zone, installId: d.installId, tell: d.tell, log: d.log })
    this.bookings = new CalendarBookings({
      store: d.store,
      api: d.api,
      writer: d.writer,
      now: d.now,
      zone: d.zone,
      installId: d.installId,
      company: d.company,
      origin: d.origin,
      newId: d.newId,
      newToken: d.newToken,
      tell: d.tell,
      alarmAt: d.alarmAt,
      notify: d.notify,
      calls: d.calls,
      log: d.log,
    })
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

  /** The events a conversation's calendar mail names, by iCalendar id: one answer per ask, in order. A read of the store; at most `CALENDAR_BY_UID_MOST` asks. */
  eventsByUid(asks: readonly CalendarEventAsk[]): Result<(CalendarEvent | null)[]> {
    if (!Array.isArray(asks) || asks.length > CALENDAR_BY_UID_MOST) return no('bad-request', `Ask for at most ${CALENDAR_BY_UID_MOST} events at a time.`)
    const moment = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isSafeInteger(v))
    const day = (v: unknown): boolean => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    const fine = (a: unknown): a is CalendarEventAsk => {
      if (typeof a !== 'object' || a === null) return false
      const { uid, occurrence } = a as Record<string, unknown>
      if (typeof uid !== 'string' || uid.length > CALENDAR_UID_MAX) return false
      if (occurrence === null) return true
      return typeof occurrence === 'object' && occurrence !== undefined && moment((occurrence as Record<string, unknown>).at) && day((occurrence as Record<string, unknown>).date)
    }
    if (!asks.every(fine)) return no('bad-request', 'Name each event by its iCalendar id, and an occurrence by its moment or its day.')
    return ok(this.d.store.eventsByUid(asks, this.d.now()))
  }

  /**
   * What Claude reads to find free time: the agenda, each event with whether it blocks the owner's time (not free time, not declined), and each account with whether an invite can be made on it. The store alone: nothing is asked of Google.
   * The same span as the agenda's (at most 62 days).
   */
  async claudeEvents(from: number, to: number): Promise<Result<CalendarClaudeAgenda>> {
    const got = await this.agenda(from, to)
    if (!got.ok) return got
    const editable = new Map(this.d.store.accountViews().map((a) => [a.address, a.events && (a.state === 'live' || a.state === 'syncing')]))
    return ok({
      from,
      to,
      accounts: got.value.accounts.map((a) => ({ address: a.address, label: a.label, state: a.state, reason: a.reason, canEdit: editable.get(a.address) === true })),
      events: got.value.events.map((e) => ({ ...e, busy: !e.free && e.response !== 'declined' })),
    })
  }

  /** How the busy blocks stand (the space's ADR 0024). Asks the inbox who is connected first, so an account's trouble is as current as the screen. */
  async blocking(): Promise<Result<CalendarBlocking>> {
    await this.fresh()
    return ok(await this.blocks.view())
  }

  /** The switch. A setting only: it is stored and owes the alarm a run, which is where Google is asked. */
  async setBlocking(on: unknown): Promise<Result<CalendarBlocking>> {
    if (typeof on !== 'boolean') return no('bad-request', 'Say whether the busy blocks are on.')
    await this.fresh()
    this.d.store.setBlockingEnabled(on)
    this.d.tell()
    await this.d.alarmAt(this.d.now())
    return ok(await this.blocks.view())
  }

  /** An account's part in the blocks: a setting like the switch. */
  async setBlockingAccount(address: unknown, takesPart: unknown): Promise<Result<CalendarBlocking>> {
    if (typeof address !== 'string' || typeof takesPart !== 'boolean') return no('bad-request', 'Say which account and whether it takes part.')
    await this.fresh()
    const changed = this.d.store.setAccountBlocks(address.trim().toLowerCase(), takesPart)
    if (changed === null) return no('not-found', 'No such account.')
    if (changed) {
      this.d.tell()
      await this.d.alarmAt(this.d.now())
    }
    return ok(await this.blocks.view())
  }

  // ── Booking links (the space's ADR 0025) ────────────────────────────────────────────────────────────────────────────────

  /** The owner's side: the links and what they did. Settings only; nothing here asks Google. */
  async bookingLinks(): Promise<Result<CalendarBookingLinks>> {
    await this.fresh()
    return this.bookings.links()
  }

  async makeBookingLink(input: unknown): Promise<Result<BookingLinkView>> {
    await this.fresh()
    return this.bookings.makeLink(input)
  }

  async changeBookingLink(id: unknown, input: unknown): Promise<Result<BookingLinkView>> {
    await this.fresh()
    return this.bookings.changeLink(id, input)
  }

  async deleteBookingLink(id: unknown): Promise<Result<{ id: string }>> {
    return this.bookings.deleteLink(id)
  }

  /**
   * The visitor's side, on the open path: nobody the space knows asks these, so none takes a person, and what authorises each is the link's address or the booking's own secret (src/bookings.ts). Who is connected is asked of the inbox first, so an account
   * whose sign-in ended a moment ago is refused in words and not at Google.
   */
  async guestLink(slug: unknown): Promise<Result<GuestBookingLink>> {
    await this.fresh()
    return this.bookings.guestLink(slug)
  }

  async guestSlots(slug: unknown): Promise<Result<GuestBookingSlots>> {
    await this.fresh()
    return this.bookings.guestSlots(slug)
  }

  async guestBook(slug: unknown, input: unknown, network: unknown): Promise<Result<GuestBooked>> {
    await this.fresh()
    return this.bookings.book(slug, input, network)
  }

  async guestBooking(secret: unknown): Promise<Result<GuestBookingView>> {
    await this.fresh()
    return this.bookings.guestBooking(secret)
  }

  async guestBookingSlots(secret: unknown): Promise<Result<GuestBookingSlots>> {
    await this.fresh()
    return this.bookings.guestBookingSlots(secret)
  }

  async guestMove(secret: unknown, start: unknown): Promise<Result<GuestBookingView>> {
    await this.fresh()
    return this.bookings.move(secret, start)
  }

  async guestCancel(secret: unknown): Promise<Result<GuestBookingView>> {
    await this.fresh()
    return this.bookings.cancel(secret)
  }

  /** Make an event on an account's primary calendar, Google sending the invitations (src/writes.ts). Who may ask is the inbox's rule, applied before this is called. */
  async claudeInvite(input: unknown): Promise<Result<CalendarEventMade>> {
    // Who is connected, and with what, as the inbox last said: an account that was disconnected a moment ago is refused here in words and not at Google.
    await this.fresh()
    return this.writes.invite(input)
  }

  async claudeMove(id: unknown, input: unknown): Promise<Result<CalendarEventMade>> {
    await this.fresh()
    return this.writes.move(id, input)
  }

  async claudeCancel(id: unknown): Promise<Result<CalendarEventCancelled>> {
    await this.fresh()
    return this.writes.cancel(id)
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
      // A booking waiting on Google is found by the event the read just brought in (the space's ADR 0025). It never throws.
      if (await this.bookings.run()) this.d.tell()
      // The busy blocks follow the read (the space's ADR 0024): what the sync just brought in is what they are worked out from. They never throw.
      if (await this.blocks.run()) this.d.tell()
      // At least a second on: a read that is owed and cannot be done must not spin the alarm.
      await this.d.alarmAt(Math.max(Math.min(this.sync.nextWake(), this.blocks.nextWake(), this.bookings.nextWake()), this.d.now() + 1000))
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
export const ENGINE_METHODS = ['calendars', 'agenda', 'event', 'eventsByUid', 'setShown', 'syncNow', 'receivePush', 'claudeEvents', 'claudeInvite', 'claudeMove', 'claudeCancel', 'blocking', 'setBlocking', 'setBlockingAccount', 'bookingLinks', 'makeBookingLink', 'changeBookingLink', 'deleteBookingLink', 'guestLink', 'guestSlots', 'guestBook', 'guestBooking', 'guestBookingSlots', 'guestMove', 'guestCancel'] as const satisfies readonly (keyof CalendarEngine)[]
export type EngineMethod = (typeof ENGINE_METHODS)[number]

/** The typed face of the object's untyped `call`. */
export type EngineApi = {
  call<K extends EngineMethod>(method: K, ...args: Parameters<CalendarEngine[K]>): Promise<Awaited<ReturnType<CalendarEngine[K]>>>
}
