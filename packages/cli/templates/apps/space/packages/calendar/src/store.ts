/**
 * The calendar's store: every rule about what is kept of Google's calendars and how it is read back, over a SQL port. No runtime import (the Durable Object is src/durable.ts), so `bun test` drives it over a real SQLite.
 *
 * It holds what Google last said and nothing else: the accounts the inbox told it of, their calendars and which are shown, their events (singleEvents, so repeats are already expanded), the push channels and when each
 * piece is next owed a read. It does no I/O of its own; the sync (src/sync.ts) asks Google and tells the store, and the space's face (src/space.ts) reads it.
 *
 * ── ONE EVENT ONCE ───────────────────────────────────────────────────────
 * A meeting the owner is invited to at two of their addresses is two rows (one per calendar) with the same iCalendar id and start. `agenda` draws one event naming both accounts, never two.
 *
 * ── A COPY THAT SAYS HOW OLD IT IS ───────────────────────────────────────
 * An event carries when its calendar was last brought up to date, and `stale` when its account is lapsed: the grant Google ended means nothing new arrives, so what is drawn is the last picture, marked as one.
 */

import {
  CALENDAR_AHEAD_MS,
  CALENDAR_BACK_MS,
  type CalendarAccountMark,
  type CalendarAccountState,
  type CalendarAccountView,
  type CalendarAgenda,
  type CalendarEvent,
  type CalendarEventAsk,
  type CalendarGrant,
  type CalendarGuest,
  type CalendarResponse,
  type CalendarView,
} from '@space/workspace'
import { cleanText, lastDay, type GoneEvent, type ParsedEvent } from './event-parse'
import type { CalendarSql } from './schema'

// ── The clocks the sync works to ────────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The safety resync in hours, for the words that say it. */
const SAFETY_HOURS = 6

/** A slow safety resync: even when no notification came, every shown calendar is read again by sync token this often (a lost notification costs at most this). */
export const SAFETY_RESYNC_MS = SAFETY_HOURS * HOUR
/** The window of a full read is a rolling one, and a sync token keeps the window it was made with, so each calendar is read in full again this often. */
export const FULL_RESYNC_MS = 7 * DAY
/** A channel is replaced when it has this long left (or, for a channel that lives less than twice as long, when half its life has gone, and never within 5 minutes of its making: Google states a 7 day default and no maximum, so a short grant must not make the calendar replace a channel at every alarm). */
export const RENEW_BEFORE_MS = 24 * HOUR
const RENEW_NOT_SOONER_MS = 5 * MIN

/** When a channel is to be replaced. */
export const renewAtOf = (c: Pick<ChannelRow, 'createdAt' | 'expiresAt'>): number => {
  const before = Math.min(RENEW_BEFORE_MS, (c.expiresAt - c.createdAt) / 2)
  return Math.max(c.expiresAt - before, c.createdAt + RENEW_NOT_SOONER_MS)
}
/** The inbox is asked who is connected this often, besides whenever a screen is read. */
export const ACCOUNTS_CHECK_MS = HOUR
/** The first retry after a failure, doubling to the longest. */
const BACKOFF_FIRST_MS = 30_000
const BACKOFF_LONGEST_MS = HOUR

/** How long to wait after the `n`th failure in a row. */
export const backoffMs = (failures: number): number => Math.min(BACKOFF_LONGEST_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1))

/** The span a full read covers: three months back and half a year ahead of `now`. */
export const windowAround = (now: number): { from: number; to: number } => ({ from: now - CALENDAR_BACK_MS, to: now + CALENDAR_AHEAD_MS })

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccountRow {
  address: string
  label: string
  hue: number
  state: 'live' | 'lapsed' | 'needs-calendar' | 'disconnected'
  /** The grant also includes the permission to change events (as the inbox last said). Nothing reads it yet but Settings' hint. */
  events: boolean
  listToken: string | null
  listSyncedAt: number | null
  listDirty: boolean
  listProblem: string | null
  listRetryAt: number | null
  listFailures: number
  channelProblem: string | null
  channelRetryAt: number | null
  channelFailures: number
  checkedAt: number | null
}

export interface CalendarRow {
  id: string
  account: string
  googleId: string
  name: string
  color: string | null
  primary: boolean
  owned: boolean
  shown: boolean
  shownSet: boolean
  syncToken: string | null
  fullAt: number | null
  /** Where the full read that made the sync token began; null where none is recorded. */
  windowFrom: number | null
  syncedAt: number | null
  dirty: boolean
  problem: string | null
  retryAt: number | null
  failures: number
  channelProblem: string | null
  channelRetryAt: number | null
  channelFailures: number
}

export interface ChannelRow {
  id: string
  account: string
  calendarId: string | null
  resourceId: string
  token: string
  expiresAt: number
  createdAt: number
  pushAt: number | null
  retire: boolean
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => Number(v)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const flag = (v: unknown): boolean => Number(v) === 1

const accountFrom = (r: Record<string, unknown>): AccountRow => ({
  address: text(r.address),
  label: text(r.label),
  hue: num(r.hue),
  state: text(r.state) as AccountRow['state'],
  events: flag(r.events),
  listToken: textOrNull(r.list_token),
  listSyncedAt: numOrNull(r.list_synced_at),
  listDirty: flag(r.list_dirty),
  listProblem: textOrNull(r.list_problem),
  listRetryAt: numOrNull(r.list_retry_at),
  listFailures: num(r.list_failures),
  channelProblem: textOrNull(r.channel_problem),
  channelRetryAt: numOrNull(r.channel_retry_at),
  channelFailures: num(r.channel_failures),
  checkedAt: numOrNull(r.checked_at),
})

const calendarFrom = (r: Record<string, unknown>): CalendarRow => ({
  id: text(r.id),
  account: text(r.account),
  googleId: text(r.google_id),
  name: text(r.name),
  color: textOrNull(r.color),
  primary: flag(r.is_primary),
  owned: flag(r.owned),
  shown: flag(r.shown),
  shownSet: flag(r.shown_set),
  syncToken: textOrNull(r.sync_token),
  fullAt: numOrNull(r.full_at),
  windowFrom: numOrNull(r.window_from),
  syncedAt: numOrNull(r.synced_at),
  dirty: flag(r.dirty),
  problem: textOrNull(r.problem),
  retryAt: numOrNull(r.retry_at),
  failures: num(r.failures),
  channelProblem: textOrNull(r.channel_problem),
  channelRetryAt: numOrNull(r.channel_retry_at),
  channelFailures: num(r.channel_failures),
})

const channelFrom = (r: Record<string, unknown>): ChannelRow => ({
  id: text(r.id),
  account: text(r.account),
  calendarId: textOrNull(r.calendar_id),
  resourceId: text(r.resource_id),
  token: text(r.token),
  expiresAt: num(r.expires_at),
  createdAt: num(r.created_at),
  pushAt: numOrNull(r.push_at),
  retire: flag(r.retire),
})

export interface StorePorts {
  sql: CalendarSql
  /** Run `fn` as one storage transaction. */
  transaction: <T>(fn: () => T) => T
  now: () => number
}

/** The id of a calendar in the store: the account's address and Google's id. */
export const calendarKey = (address: string, googleId: string): string => `${address}|${googleId}`
/** The id of an event in the store: its calendar's and Google's id for it. */
export const eventKey = (calendarId: string, eventId: string): string => `${calendarId}|${eventId}`

/** What Google's calendar list says of one calendar, as far as the store reads it. */
export interface ListedCalendar {
  googleId: string
  name: string
  color: string | null
  primary: boolean
  owned: boolean
  deleted: boolean
}

const COLOR = /^#[0-9a-f]{6}$/i

/** Google's calendar-list entry, read. Null for something with no id. */
export function listedCalendar(raw: unknown): ListedCalendar | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const googleId = text(r.id)
  if (googleId === '' || googleId.length > 500) return null
  return {
    googleId,
    name: cleanText(r.summaryOverride, 200) || cleanText(r.summary, 200) || googleId,
    color: COLOR.test(text(r.backgroundColor)) ? text(r.backgroundColor).toLowerCase() : null,
    primary: r.primary === true,
    owned: r.accessRole === 'owner',
    deleted: r.deleted === true,
  }
}

/** What the store did, for the caller to tell the page about. */
export interface Changed {
  changed: boolean
}

export class CalendarStore {
  constructor(private readonly ports: StorePorts) {}

  private get sql(): CalendarSql {
    return this.ports.sql
  }

  // ── Accounts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  accounts(): AccountRow[] {
    return this.sql.exec(`SELECT * FROM account ORDER BY hue, address`).toArray().map(accountFrom)
  }

  account(address: string): AccountRow | null {
    const r = this.sql.exec(`SELECT * FROM account WHERE address = ?1`, address).toArray()[0]
    return r ? accountFrom(r) : null
  }

  /** The state the inbox's word about an account means here. */
  private stateOf(g: CalendarGrant): AccountRow['state'] {
    if (!g.connected) return 'disconnected'
    if (g.lapsed) return 'lapsed'
    return g.calendar ? 'live' : 'needs-calendar'
  }

  /**
   * The inbox's word on who is connected, applied. A new account is given the next colour slot (once, for good); an account that becomes live is owed a read of its list; one that is disconnected, or that
   * has no calendar permission, loses what it had (there is no longer a grant to read it with, and a picture of a disconnected account would only mislead); a lapsed one keeps its last picture. An address the
   * inbox no longer lists is treated as disconnected. Answers whether anything the page draws changed.
   */
  applyGrants(grants: readonly CalendarGrant[]): Changed {
    const now = this.ports.now()
    return this.ports.transaction(() => {
      let changed = false
      const seen = new Set<string>()
      for (const g of grants) {
        const address = g.address.trim().toLowerCase()
        if (address === '' || seen.has(address)) continue
        seen.add(address)
        const state = this.stateOf({ ...g, address })
        // Editing is a property of a grant the calendar can read with; a grant that cannot be read with has none to speak of.
        const events = g.events === true && g.calendar && g.connected
        const held = this.account(address)
        if (!held) {
          const hue = Number(this.sql.exec(`SELECT count(*) AS n FROM account`).one().n) % 6
          this.sql.exec(
            `INSERT INTO account (address, label, hue, state, events, list_dirty, checked_at, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?6, 1, ?5, ?5)`,
            address,
            cleanText(g.label, 60) || address,
            hue,
            state,
            now,
            events ? 1 : 0,
          )
          changed = true
          continue
        }
        this.sql.exec(`UPDATE account SET checked_at = ?2 WHERE address = ?1`, address, now)
        const label = cleanText(g.label, 60) || address
        if (label !== held.label) {
          this.sql.exec(`UPDATE account SET label = ?2 WHERE address = ?1`, address, label)
          changed = true
        }
        if (state !== held.state) {
          this.setState(address, state)
          changed = true
        }
        if (events !== held.events) {
          this.sql.exec(`UPDATE account SET events = ?2 WHERE address = ?1`, address, events ? 1 : 0)
          changed = true
        }
      }
      for (const a of this.accounts()) {
        if (!seen.has(a.address) && a.state !== 'disconnected') {
          this.setState(a.address, 'disconnected')
          changed = true
        }
      }
      return { changed }
    })
  }

  /** Move an account to a state, with what that costs it: a return to `live` owes a read of the list and of every calendar; a disconnected or permission-less account loses its calendars. */
  private setState(address: string, state: AccountRow['state']): void {
    this.sql.exec(`UPDATE account SET state = ?2 WHERE address = ?1`, address, state)
    if (state === 'live') {
      this.sql.exec(`UPDATE account SET list_dirty = 1, list_retry_at = NULL, list_failures = 0, list_problem = NULL WHERE address = ?1`, address)
      this.sql.exec(`UPDATE calendar SET dirty = 1, retry_at = NULL, failures = 0, problem = NULL WHERE account = ?1`, address)
    } else if (state === 'disconnected' || state === 'needs-calendar') {
      this.purge(address)
    }
  }

  /** Mark an account's state from what a call found out (the grant is lapsed; the permission is missing; it is disconnected). */
  markAccount(address: string, state: AccountRow['state']): Changed {
    const held = this.account(address)
    if (!held || held.state === state) return { changed: false }
    this.ports.transaction(() => this.setState(address, state))
    return { changed: true }
  }

  /** Everything read from an account's Google, forgotten: its calendars, their events, their channels (the rows; ending them at Google is not possible without a token), its tokens. The account stays. */
  private purge(address: string): void {
    this.sql.exec(`DELETE FROM event WHERE calendar_id IN (SELECT id FROM calendar WHERE account = ?1)`, address)
    this.sql.exec(`DELETE FROM channel WHERE account = ?1`, address)
    this.sql.exec(`DELETE FROM calendar WHERE account = ?1`, address)
    this.sql.exec(
      `UPDATE account SET list_token = NULL, list_synced_at = NULL, list_dirty = 0, list_problem = NULL, list_retry_at = NULL, list_failures = 0,
              channel_problem = NULL, channel_retry_at = NULL, channel_failures = 0 WHERE address = ?1`,
      address,
    )
  }

  // ── Calendars ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  calendars(address?: string): CalendarRow[] {
    const rows = address === undefined ? this.sql.exec(`SELECT * FROM calendar ORDER BY account, is_primary DESC, name`) : this.sql.exec(`SELECT * FROM calendar WHERE account = ?1 ORDER BY is_primary DESC, name`, address)
    return rows.toArray().map(calendarFrom)
  }

  calendar(id: string): CalendarRow | null {
    const r = this.sql.exec(`SELECT * FROM calendar WHERE id = ?1`, id).toArray()[0]
    return r ? calendarFrom(r) : null
  }

  /**
   * An account's calendar list as Google gave it, applied. `full` is a read from the beginning: a calendar the list no longer has is dropped with its events and channels. An incremental read names deleted ones.
   * A calendar seen for the first time is shown when it is the account's primary or one the account owns, and hidden otherwise (holidays, birthdays, someone else's); the owner's own choice is never overridden.
   * A shown calendar that is new is owed a first read.
   */
  applyCalendarList(address: string, listed: readonly ListedCalendar[], mode: { full: boolean; token: string | null }): Changed {
    const now = this.ports.now()
    return this.ports.transaction(() => {
      let changed = false
      const keep = new Set<string>()
      for (const c of listed) {
        const id = calendarKey(address, c.googleId)
        if (c.deleted) {
          if (this.calendar(id)) {
            this.dropCalendar(id)
            changed = true
          }
          continue
        }
        keep.add(id)
        const held = this.calendar(id)
        if (!held) {
          const shown = c.primary || c.owned
          this.sql.exec(
            `INSERT INTO calendar (id, account, google_id, name, color, is_primary, owned, shown, shown_set, dirty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?8)`,
            id,
            address,
            c.googleId,
            c.name,
            c.color,
            c.primary ? 1 : 0,
            c.owned ? 1 : 0,
            shown ? 1 : 0,
          )
          changed = true
        } else if (held.name !== c.name || held.color !== c.color || held.primary !== c.primary || held.owned !== c.owned) {
          this.sql.exec(`UPDATE calendar SET name = ?2, color = ?3, is_primary = ?4, owned = ?5 WHERE id = ?1`, id, c.name, c.color, c.primary ? 1 : 0, c.owned ? 1 : 0)
          changed = true
        }
      }
      if (mode.full) {
        for (const held of this.calendars(address)) {
          if (!keep.has(held.id)) {
            this.dropCalendar(held.id)
            changed = true
          }
        }
      }
      this.sql.exec(
        `UPDATE account SET list_token = ?2, list_synced_at = ?3, list_problem = NULL, list_retry_at = NULL, list_failures = 0 WHERE address = ?1`,
        address,
        mode.token,
        now,
      )
      return { changed }
    })
  }

  /** A calendar, its events and its channels, gone from the store. */
  private dropCalendar(id: string): void {
    this.sql.exec(`DELETE FROM event WHERE calendar_id = ?1`, id)
    this.sql.exec(`DELETE FROM channel WHERE calendar_id = ?1`, id)
    this.sql.exec(`DELETE FROM calendar WHERE id = ?1`, id)
  }

  /**
   * The owner's choice to show or hide a calendar. Showing owes it a first full read (the sync is woken by the caller); hiding drops its events and token (a token left for weeks would be stale) and marks its
   * channel to be stopped at Google. Answers the calendar as it now stands, or null for one the store does not have.
   */
  setShown(id: string, shown: boolean): { calendar: CalendarRow | null; changed: boolean } {
    return this.ports.transaction(() => {
      const held = this.calendar(id)
      if (!held) return { calendar: null, changed: false }
      if (held.shown === shown) {
        this.sql.exec(`UPDATE calendar SET shown_set = 1 WHERE id = ?1`, id)
        return { calendar: this.calendar(id), changed: false }
      }
      if (shown) {
        this.sql.exec(
          `UPDATE calendar SET shown = 1, shown_set = 1, sync_token = NULL, full_at = NULL, synced_at = NULL, dirty = 1, problem = NULL, retry_at = NULL, failures = 0 WHERE id = ?1`,
          id,
        )
      } else {
        this.sql.exec(`DELETE FROM event WHERE calendar_id = ?1`, id)
        this.sql.exec(`UPDATE channel SET retire = 1 WHERE calendar_id = ?1`, id)
        this.sql.exec(
          `UPDATE calendar SET shown = 0, shown_set = 1, sync_token = NULL, full_at = NULL, synced_at = NULL, dirty = 0, problem = NULL, retry_at = NULL, failures = 0,
                  channel_problem = NULL, channel_retry_at = NULL, channel_failures = 0 WHERE id = ?1`,
          id,
        )
      }
      return { calendar: this.calendar(id), changed: true }
    })
  }

  /** Ask for every shown calendar of the live accounts (and each live account's list) to be read now. Answers how many calendars. */
  askAll(): number {
    return this.ports.transaction(() => {
      this.sql.exec(`UPDATE account SET list_dirty = 1, list_retry_at = NULL WHERE state = 'live'`)
      this.sql.exec(`UPDATE calendar SET dirty = 1, retry_at = NULL WHERE shown = 1 AND account IN (SELECT address FROM account WHERE state = 'live')`)
      return Number(this.sql.exec(`SELECT count(*) AS n FROM calendar WHERE shown = 1 AND account IN (SELECT address FROM account WHERE state = 'live')`).one().n)
    })
  }

  /**
   * A read of a calendar's events is about to begin: what was owed is taken off, BEFORE Google is asked, so a notification that arrives while the read is under way owes another read and is not lost when this
   * one ends. (A read that fails is owed again by its backoff.)
   */
  beginRead(calendarId: string): void {
    this.sql.exec(`UPDATE calendar SET dirty = 0 WHERE id = ?1`, calendarId)
  }

  /** The same for an account's list of calendars. */
  beginListRead(address: string): void {
    this.sql.exec(`UPDATE account SET list_dirty = 0 WHERE address = ?1`, address)
  }

  /** A calendar Google no longer has, gone with its events and channels. */
  removeCalendar(id: string): void {
    this.ports.transaction(() => this.dropCalendar(id))
  }

  markCalendarDirty(id: string): void {
    this.sql.exec(`UPDATE calendar SET dirty = 1 WHERE id = ?1 AND shown = 1`, id)
  }

  markListDirty(address: string): void {
    this.sql.exec(`UPDATE account SET list_dirty = 1 WHERE address = ?1`, address)
  }

  /** A read of an account's list failed: remember the sentence and when to try again. */
  recordListFailure(address: string, problem: string): void {
    const held = this.account(address)
    if (!held) return
    const failures = held.listFailures + 1
    this.sql.exec(`UPDATE account SET list_problem = ?2, list_failures = ?3, list_retry_at = ?4 WHERE address = ?1`, address, cleanText(problem, 300), failures, this.ports.now() + backoffMs(failures))
  }

  /** A read of a calendar's events failed: remember the sentence and when to try again. The events already held stay. */
  recordCalendarFailure(id: string, problem: string): void {
    const held = this.calendar(id)
    if (!held) return
    const failures = held.failures + 1
    this.sql.exec(`UPDATE calendar SET problem = ?2, failures = ?3, retry_at = ?4 WHERE id = ?1`, id, cleanText(problem, 300), failures, this.ports.now() + backoffMs(failures))
  }

  /** Google would not make a push channel: remember why, and when to try again. The calendar is still read by the safety resync. */
  recordChannelFailure(target: { account: string; calendarId: string | null }, problem: string): void {
    const now = this.ports.now()
    if (target.calendarId === null) {
      const held = this.account(target.account)
      if (!held) return
      const failures = held.channelFailures + 1
      this.sql.exec(`UPDATE account SET channel_problem = ?2, channel_failures = ?3, channel_retry_at = ?4 WHERE address = ?1`, target.account, cleanText(problem, 300), failures, now + backoffMs(failures))
      return
    }
    const held = this.calendar(target.calendarId)
    if (!held) return
    const failures = held.channelFailures + 1
    this.sql.exec(`UPDATE calendar SET channel_problem = ?2, channel_failures = ?3, channel_retry_at = ?4 WHERE id = ?1`, target.calendarId, cleanText(problem, 300), failures, now + backoffMs(failures))
  }

  // ── Events ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private insertEvent(calendarId: string, e: ParsedEvent): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO event (calendar_id, id, ical_uid, title, location, description, start_ms, end_ms, all_day, start_date, end_date, status, response,
                                     organizer_name, organizer_email, guests, guests_left, video_link, html_link, free)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
      calendarId,
      e.id,
      e.iCalUid,
      e.title,
      e.location,
      e.description,
      e.start,
      e.end,
      e.allDay ? 1 : 0,
      e.startDate,
      e.endDate,
      e.status,
      e.response,
      e.organizer?.name ?? null,
      e.organizer?.email ?? null,
      JSON.stringify(e.guests),
      e.guestsLeft,
      e.videoLink,
      e.htmlLink,
      e.free ? 1 : 0,
    )
  }

  /**
   * A first (or renewed) full read, applied in ONE transaction: the calendar's events are replaced by exactly these and the sync token and window are kept with them, so a read that dies halfway leaves the
   * old picture and the old token, never half of each. A cancelled event in a full read is simply not kept.
   */
  replaceEvents(calendarId: string, events: readonly (ParsedEvent | GoneEvent)[], token: string | null, window: { from: number; to: number }): Changed {
    const now = this.ports.now()
    return this.ports.transaction(() => {
      if (!this.calendar(calendarId)) return { changed: false }
      const before = this.eventDigest(calendarId)
      this.sql.exec(`DELETE FROM event WHERE calendar_id = ?1`, calendarId)
      for (const e of events) if (e.kind === 'event') this.insertEvent(calendarId, e)
      this.sql.exec(
        `UPDATE calendar SET sync_token = ?2, window_from = ?3, window_to = ?4, full_at = ?5, synced_at = ?5, problem = NULL, retry_at = NULL, failures = 0 WHERE id = ?1`,
        calendarId,
        token,
        window.from,
        window.to,
        now,
      )
      return { changed: before !== this.eventDigest(calendarId) }
    })
  }

  /** The changes since the sync token, applied in one transaction with the new token. A cancelled or deleted event is removed. */
  applyEventChanges(calendarId: string, changes: readonly (ParsedEvent | GoneEvent)[], token: string | null): Changed {
    const now = this.ports.now()
    return this.ports.transaction(() => {
      if (!this.calendar(calendarId)) return { changed: false }
      let changed = false
      for (const c of changes) {
        if (c.kind === 'gone') {
          const removed = this.sql.exec(`DELETE FROM event WHERE calendar_id = ?1 AND id = ?2`, calendarId, c.id).rowsWritten
          if (removed > 0) changed = true
        } else {
          this.insertEvent(calendarId, c)
          changed = true
        }
      }
      this.sql.exec(`UPDATE calendar SET sync_token = ?2, synced_at = ?3, problem = NULL, retry_at = NULL, failures = 0 WHERE id = ?1`, calendarId, token ?? null, now)
      return { changed }
    })
  }

  /** The sync token a calendar holds is no longer good: read it in full next. */
  forgetToken(calendarId: string): void {
    this.sql.exec(`UPDATE calendar SET sync_token = NULL, dirty = 1 WHERE id = ?1`, calendarId)
  }

  /** The account's list token is no longer good. */
  forgetListToken(address: string): void {
    this.sql.exec(`UPDATE account SET list_token = NULL, list_dirty = 1 WHERE address = ?1`, address)
  }

  /** A cheap fingerprint of a calendar's events, to tell a full read that changed nothing from one that did. */
  private eventDigest(calendarId: string): string {
    return this.sql
      .exec(`SELECT id, title, start_ms, end_ms, response, status, location, guests FROM event WHERE calendar_id = ?1 ORDER BY id`, calendarId)
      .toArray()
      .map((r) => JSON.stringify(r))
      .join('\n')
  }

  // ── Channels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  channels(): ChannelRow[] {
    return this.sql.exec(`SELECT * FROM channel ORDER BY created_at, id`).toArray().map(channelFrom)
  }

  channel(id: string): ChannelRow | null {
    const r = this.sql.exec(`SELECT * FROM channel WHERE id = ?1`, id).toArray()[0]
    return r ? channelFrom(r) : null
  }

  /** The live channels (not retiring) of an account's list (`calendarId` null) or of a calendar's events. */
  channelsOf(account: string, calendarId: string | null): ChannelRow[] {
    const rows =
      calendarId === null
        ? this.sql.exec(`SELECT * FROM channel WHERE account = ?1 AND calendar_id IS NULL AND retire = 0`, account)
        : this.sql.exec(`SELECT * FROM channel WHERE calendar_id = ?1 AND retire = 0`, calendarId)
    return rows.toArray().map(channelFrom)
  }

  addChannel(c: { id: string; account: string; calendarId: string | null; resourceId: string; token: string; expiresAt: number }): void {
    const now = this.ports.now()
    this.ports.transaction(() => {
      this.sql.exec(
        `INSERT INTO channel (id, account, calendar_id, resource_id, token, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        c.id,
        c.account,
        c.calendarId,
        c.resourceId,
        c.token,
        c.expiresAt,
        now,
      )
      if (c.calendarId === null) this.sql.exec(`UPDATE account SET channel_problem = NULL, channel_retry_at = NULL, channel_failures = 0 WHERE address = ?1`, c.account)
      else this.sql.exec(`UPDATE calendar SET channel_problem = NULL, channel_retry_at = NULL, channel_failures = 0 WHERE id = ?1`, c.calendarId)
    })
  }

  /** A channel that has been replaced is stopped at Google and then forgotten; until then it still counts as a way a notification may arrive. */
  retireChannel(id: string): void {
    this.sql.exec(`UPDATE channel SET retire = 1 WHERE id = ?1`, id)
  }

  removeChannel(id: string): void {
    this.sql.exec(`DELETE FROM channel WHERE id = ?1`, id)
  }

  recordPush(id: string): void {
    this.sql.exec(`UPDATE channel SET push_at = ?2 WHERE id = ?1`, id, this.ports.now())
  }

  // ── What is owed, and when ────────────────────────────────────────────────────────────────────────────────────────────

  /** When an account's list is next owed a read: now if it is dirty and not waiting out a failure, else the safety resync. */
  listDueAt(a: AccountRow): number {
    if (a.state !== 'live') return Number.POSITIVE_INFINITY
    if (a.listRetryAt !== null && a.listFailures > 0) return a.listRetryAt
    if (a.listDirty || a.listToken === null) return 0
    return (a.listSyncedAt ?? 0) + SAFETY_RESYNC_MS
  }

  /** When a calendar's events are next owed a read. Never for a hidden one or one of an account that is not live. */
  calendarDueAt(c: CalendarRow, account: AccountRow | null): number {
    if (!c.shown || !account || account.state !== 'live') return Number.POSITIVE_INFINITY
    if (c.retryAt !== null && c.failures > 0) return c.retryAt
    if (c.dirty || c.syncToken === null) return 0
    return Math.min((c.syncedAt ?? 0) + SAFETY_RESYNC_MS, (c.fullAt ?? 0) + FULL_RESYNC_MS)
  }

  /**
   * Whether a calendar's next read should be a full one: no token, the last full read is a week old, or its window starts later than the window now reaches back by more than the week a rolling window
   * lags (a token made when the store kept only a month back would otherwise keep a month for up to a week more).
   */
  needsFull(c: CalendarRow, now: number): boolean {
    if (c.syncToken === null || c.fullAt === null || now - c.fullAt >= FULL_RESYNC_MS) return true
    return c.windowFrom !== null && c.windowFrom - windowAround(now).from > FULL_RESYNC_MS
  }

  // ── What the page is shown ────────────────────────────────────────────────────────────────────────────────────────────

  private reasonFor(a: AccountRow, calendars: readonly CalendarRow[]): string | null {
    switch (a.state) {
      case 'lapsed':
        return `Google no longer accepts the saved sign-in for ${a.address} (a Google app in testing mode loses its grants after 7 days), so what is shown for it is the last picture and nothing new arrives. Connect it again.`
      case 'needs-calendar':
        return `${a.address} is connected for mail without the calendar permission. Press Connect calendar and accept it.`
      case 'disconnected':
        return `${a.address} is not connected. Connect it in Settings, Mailboxes.`
      case 'live': {
        if (a.listProblem) return `The last read of ${a.address}'s calendar list failed: ${a.listProblem}`
        const bad = calendars.find((c) => c.shown && c.problem)
        return bad ? `The last read of ${bad.name} (${a.address}) failed: ${bad.problem}` : null
      }
    }
  }

  private stateView(a: AccountRow, calendars: readonly CalendarRow[]): CalendarAccountState {
    if (a.state !== 'live') return a.state
    // Live, and the first full read of a shown calendar (or of the list) is still owed.
    return a.listToken === null || calendars.some((c) => c.shown && c.syncToken === null && !c.problem) ? 'syncing' : 'live'
  }

  /** The accounts and their calendars, as Settings draws them. */
  accountViews(): CalendarAccountView[] {
    const calendars = this.calendars()
    return this.accounts().map((a) => {
      const own = calendars.filter((c) => c.account === a.address)
      const read = own.filter((c) => c.shown && c.syncedAt !== null).map((c) => c.syncedAt as number)
      return {
        address: a.address,
        label: a.label,
        hue: a.hue,
        events: a.events,
        state: this.stateView(a, own),
        reason: this.reasonFor(a, own),
        readAt: read.length === 0 ? null : Math.min(...read),
        note: a.state === 'live' && a.channelProblem !== null ? `Live updates are off for this account's list of calendars (${a.channelProblem}). A calendar added in Google is found within ${SAFETY_HOURS} hours instead.` : null,
        calendars: own.map(viewOfCalendar),
      }
    })
  }

  calendarView(id: string): CalendarView | null {
    const c = this.calendar(id)
    return c ? viewOfCalendar(c) : null
  }

  private eventFrom(r: Record<string, unknown>, accounts: Map<string, AccountRow>, calendarsById: Map<string, CalendarRow>): { event: CalendarEvent; uid: string | null; account: AccountRow; syncedAt: number | null } | null {
    const calendar = calendarsById.get(text(r.calendar_id))
    const account = calendar ? accounts.get(calendar.account) : undefined
    if (!calendar || !account) return null
    const allDay = flag(r.all_day)
    let guests: CalendarGuest[] = []
    try {
      const parsed: unknown = JSON.parse(text(r.guests))
      if (Array.isArray(parsed)) guests = parsed as CalendarGuest[]
    } catch {
      guests = []
    }
    const organizerName = textOrNull(r.organizer_name)
    const organizerEmail = textOrNull(r.organizer_email)
    const event: CalendarEvent = {
      id: eventKey(text(r.calendar_id), text(r.id)),
      title: text(r.title),
      start: num(r.start_ms),
      end: num(r.end_ms),
      allDay,
      startDate: allDay ? textOrNull(r.start_date) : null,
      endDate: allDay && textOrNull(r.end_date) !== null ? lastDay(text(r.end_date)) : null,
      location: textOrNull(r.location),
      videoLink: textOrNull(r.video_link),
      htmlLink: textOrNull(r.html_link),
      description: textOrNull(r.description),
      status: text(r.status) === 'tentative' ? 'tentative' : 'confirmed',
      response: textOrNull(r.response) as CalendarResponse | null,
      organizer: organizerName === null && organizerEmail === null ? null : { name: organizerName, email: organizerEmail },
      guests,
      guestsLeft: num(r.guests_left),
      accounts: [markOf(account)],
      free: flag(r.free),
      readAt: calendar.syncedAt,
      stale: account.state !== 'live',
    }
    return { event, uid: textOrNull(r.ical_uid), account, syncedAt: calendar.syncedAt }
  }

  /**
   * The events that end after `from` and start before `to`, from the shown calendars of every account that still has a picture (live or lapsed), earliest first, the same event in two calendars once. An all-day
   * event is placed by its days on the company's clock. Nothing here asks Google.
   */
  agenda(from: number, to: number): CalendarAgenda {
    const accounts = new Map(this.accounts().map((a) => [a.address, a]))
    const calendars = new Map(this.calendars().filter((c) => c.shown).map((c) => [c.id, c]))
    const rows = this.sql
      .exec(
        `SELECT * FROM event WHERE (end_ms > ?1 AND start_ms < ?2) OR (start_ms = end_ms AND start_ms >= ?1 AND start_ms < ?2) ORDER BY start_ms, end_ms, title`,
        from,
        to,
      )
      .toArray()
    const merged = new Map<string, CalendarEvent>()
    const order: string[] = []
    for (const r of rows) {
      const got = this.eventFrom(r, accounts, calendars)
      if (!got || got.account.state === 'disconnected' || got.account.state === 'needs-calendar') continue
      // The same meeting in two of the person's calendars shares Google's iCalendar id and start. Anything without an id is its own event.
      const key = got.uid !== null ? `${got.uid}|${got.event.start}` : got.event.id
      const held = merged.get(key)
      if (!held) {
        merged.set(key, got.event)
        order.push(key)
        continue
      }
      if (!held.accounts.some((a) => a.address === got.account.address)) held.accounts.push(markOf(got.account))
      held.accounts.sort((a, b) => a.hue - b.hue)
      held.response = bestResponse(held.response, got.event.response)
      held.readAt = held.readAt === null || got.event.readAt === null ? (held.readAt ?? got.event.readAt) : Math.min(held.readAt, got.event.readAt)
      held.stale = held.stale && got.event.stale
      if (held.guests.length === 0 && got.event.guests.length > 0) {
        held.guests = got.event.guests
        held.guestsLeft = got.event.guestsLeft
      }
    }
    return {
      from,
      to,
      events: order.map((k) => merged.get(k) as CalendarEvent),
      accounts: [...accounts.values()].map((a) => ({
        ...markOf(a),
        state: this.stateView(a, this.calendars(a.address)),
        reason: this.reasonFor(a, this.calendars(a.address)),
        readAt: minRead(this.calendars(a.address)),
      })),
    }
  }

  /** One event by its key. The same meeting in another calendar is added to its accounts, as in the agenda. */
  event(id: string): CalendarEvent | null {
    const cut = id.indexOf('|', id.indexOf('|') + 1)
    if (cut < 0) return null
    const calendarId = id.slice(0, cut)
    const eventId = id.slice(cut + 1)
    const accounts = new Map(this.accounts().map((a) => [a.address, a]))
    const calendars = new Map(this.calendars().filter((c) => c.shown).map((c) => [c.id, c]))
    const r = this.sql.exec(`SELECT * FROM event WHERE calendar_id = ?1 AND id = ?2`, calendarId, eventId).toArray()[0]
    if (!r) return null
    const got = this.eventFrom(r, accounts, calendars)
    if (!got || got.account.state === 'disconnected' || got.account.state === 'needs-calendar') return null
    if (got.uid !== null) {
      for (const other of this.sql.exec(`SELECT * FROM event WHERE ical_uid = ?1 AND start_ms = ?2 AND NOT (calendar_id = ?3 AND id = ?4)`, got.uid, got.event.start, calendarId, eventId).toArray()) {
        const copy = this.eventFrom(other, accounts, calendars)
        if (copy && !got.event.accounts.some((a) => a.address === copy.account.address)) got.event.accounts.push(markOf(copy.account))
        if (copy) got.event.response = bestResponse(got.event.response, copy.event.response)
      }
      got.event.accounts.sort((a, b) => a.hue - b.hue)
    }
    return got.event
  }

  /**
   * The events a mail's calendar part names, by iCalendar id (`event_uid_idx`): for each ask the one event of the calendar's copy it is about, as `event` gives it (the same meeting in another calendar added to its accounts), or null when none is held in a
   * shown calendar of a live account. A part about one OCCURRENCE of a repeating event finds it by its moment (an instance's start) or its day (an all-day one); a part with no occurrence finds a single event as it is, and a repeating one at its next
   * occurrence from `now`, else its latest. Reads the store alone: nothing asks Google.
   */
  eventsByUid(asks: readonly CalendarEventAsk[], now: number): (CalendarEvent | null)[] {
    return asks.map((ask) => {
      if (ask.uid === '') return null
      const rows = this.sql.exec(`SELECT calendar_id, id, start_ms, start_date, all_day FROM event WHERE ical_uid = ?1 ORDER BY start_ms, calendar_id, id`, ask.uid).toArray()
      if (rows.length === 0) return null
      const startOf = (r: Record<string, unknown>): number => num(r.start_ms)
      let chosen: Record<string, unknown> | undefined
      if (ask.occurrence?.at !== null && ask.occurrence?.at !== undefined) chosen = rows.find((r) => startOf(r) === ask.occurrence?.at)
      else if (ask.occurrence?.date !== null && ask.occurrence?.date !== undefined) chosen = rows.find((r) => flag(r.all_day) && textOrNull(r.start_date) === ask.occurrence?.date)
      else chosen = rows.find((r) => startOf(r) >= now) ?? rows[rows.length - 1]
      return chosen ? this.event(eventKey(text(chosen.calendar_id), text(chosen.id))) : null
    })
  }

  /** How many events are held, for the operator and the tests. */
  eventCount(): number {
    return Number(this.sql.exec(`SELECT count(*) AS n FROM event`).one().n)
  }
}

/**
 * The answer of one meeting held in two of the person's calendars, as a person would read it: "accepted" beats "maybe", which beats "not answered", which beats "declined". The same invitation can be answered at one address and
 * declined at another; it is the day's if ANY of them says yes, so Today never drops a meeting because of which row the store happened to read first.
 */
const RESPONSE_RANK: Record<CalendarResponse, number> = { accepted: 3, tentative: 2, needsAction: 1, declined: 0 }
export const bestResponse = (a: CalendarResponse | null, b: CalendarResponse | null): CalendarResponse | null => (a === null ? b : b === null ? a : RESPONSE_RANK[b] > RESPONSE_RANK[a] ? b : a)

const markOf = (a: AccountRow): CalendarAccountMark => ({ address: a.address, label: a.label, hue: a.hue })

const minRead = (calendars: readonly CalendarRow[]): number | null => {
  const read = calendars.filter((c) => c.shown && c.syncedAt !== null).map((c) => c.syncedAt as number)
  return read.length === 0 ? null : Math.min(...read)
}

const viewOfCalendar = (c: CalendarRow): CalendarView => ({
  id: c.id,
  name: c.name,
  color: c.color,
  primary: c.primary,
  shown: c.shown,
  readAt: c.shown ? c.syncedAt : null,
  problem: c.shown ? c.problem : null,
  note: c.shown && c.channelProblem !== null ? `Live updates are off for this calendar (${c.channelProblem}). It is read every ${SAFETY_HOURS} hours instead.` : null,
})
