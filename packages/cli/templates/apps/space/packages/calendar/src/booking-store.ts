/**
 * The booking links' store: what the owner set for each link, and the record of what each did (the space's ADR 0025). Rules about what is kept and how it is read back, over the same SQL port as the calendar's store (src/store.ts); no runtime
 * import, so `bun test` drives it over a real SQLite. It decides nothing about who may ask or what a time is worth: the engine for bookings (src/bookings.ts) does, and the calendar's own copy of Google's events is read through `CalendarStore`.
 *
 * ── A HOLD IS A ROW ──────────────────────────────────────────────────────
 * A visitor's time is taken the moment its row is written, in the same turn of the object as the check that the time was free (no await between them), so two visitors cannot take one time. The row is `held` until Google has made the event.
 */

import type { BookingHours, BookingState } from '@space/workspace'
import type { CalendarSql } from './schema'
import type { StorePorts } from './store'

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => Number(v)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const flag = (v: unknown): boolean => Number(v) === 1

/** A booking link as stored. */
export interface LinkRow {
  id: string
  slug: string
  name: string
  description: string
  account: string
  minutes: number
  hours: BookingHours
  noticeMinutes: number
  aheadDays: number
  gapMinutes: number
  perDay: number | null
  enabled: boolean
  createdAt: number
  changedAt: number
}

/** What a link is written from: every field the owner sets. */
export type LinkWrite = Omit<LinkRow, 'id' | 'createdAt' | 'changedAt'>

/** A booking as stored. */
export interface BookingRow {
  id: string
  linkId: string
  linkName: string
  account: string
  calendarId: string
  calendarGoogleId: string
  eventId: string
  minutes: number
  start: number
  end: number
  movingStart: number | null
  movingEnd: number | null
  movingAt: number | null
  visitorName: string
  visitorEmail: string
  /** The address in its canonical form: what the per-address limits count. */
  visitorKey: string
  note: string | null
  manageHash: string
  state: 'held' | 'booked' | 'cancelled'
  checked: 'google' | 'copy'
  moves: number
  network: string
  createdAt: number
  bookedAt: number | null
  cancelledAt: number | null
}

export type BookingWrite = Omit<BookingRow, 'movingStart' | 'movingEnd' | 'movingAt' | 'moves' | 'bookedAt' | 'cancelledAt' | 'state'>

const linkFrom = (r: Record<string, unknown>): LinkRow => ({
  id: text(r.id),
  slug: text(r.slug),
  name: text(r.name),
  description: text(r.description),
  account: text(r.account),
  minutes: num(r.minutes),
  hours: JSON.parse(text(r.hours)) as BookingHours,
  noticeMinutes: num(r.notice_minutes),
  aheadDays: num(r.ahead_days),
  gapMinutes: num(r.gap_minutes),
  perDay: numOrNull(r.per_day),
  enabled: flag(r.enabled),
  createdAt: num(r.created_at),
  changedAt: num(r.changed_at),
})

const bookingFrom = (r: Record<string, unknown>): BookingRow => ({
  id: text(r.id),
  linkId: text(r.link_id),
  linkName: text(r.link_name),
  account: text(r.account),
  calendarId: text(r.calendar_id),
  calendarGoogleId: text(r.calendar_google_id),
  eventId: text(r.event_id),
  minutes: num(r.minutes),
  start: num(r.start_ms),
  end: num(r.end_ms),
  movingStart: numOrNull(r.moving_start),
  movingEnd: numOrNull(r.moving_end),
  movingAt: numOrNull(r.moving_at),
  visitorName: text(r.visitor_name),
  visitorEmail: text(r.visitor_email),
  visitorKey: text(r.visitor_key),
  note: textOrNull(r.note),
  manageHash: text(r.manage_hash),
  state: text(r.state) as BookingRow['state'],
  checked: text(r.checked) === 'google' ? 'google' : 'copy',
  moves: num(r.moves),
  network: text(r.network),
  createdAt: num(r.created_at),
  bookedAt: numOrNull(r.booked_at),
  cancelledAt: numOrNull(r.cancelled_at),
})

/** A time some other booking has taken: one waiting on Google, or one being moved. */
export interface Hold {
  bookingId: string
  start: number
  end: number
}

export class BookingStore {
  constructor(private readonly ports: StorePorts) {}

  private get sql(): CalendarSql {
    return this.ports.sql
  }

  // ── Links ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  links(): LinkRow[] {
    return this.sql.exec(`SELECT * FROM booking_link ORDER BY created_at, id`).toArray().map(linkFrom)
  }

  link(id: string): LinkRow | null {
    const r = this.sql.exec(`SELECT * FROM booking_link WHERE id = ?1`, id).toArray()[0]
    return r ? linkFrom(r) : null
  }

  linkBySlug(slug: string): LinkRow | null {
    const r = this.sql.exec(`SELECT * FROM booking_link WHERE slug = ?1`, slug).toArray()[0]
    return r ? linkFrom(r) : null
  }

  addLink(id: string, w: LinkWrite): void {
    const now = this.ports.now()
    this.sql.exec(
      `INSERT INTO booking_link (id, slug, name, description, account, minutes, hours, notice_minutes, ahead_days, gap_minutes, per_day, enabled, created_at, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
      id,
      w.slug,
      w.name,
      w.description,
      w.account,
      w.minutes,
      JSON.stringify(w.hours),
      w.noticeMinutes,
      w.aheadDays,
      w.gapMinutes,
      w.perDay,
      w.enabled ? 1 : 0,
      now,
    )
  }

  /** Change a link. Answers whether there was one. */
  changeLink(id: string, w: LinkWrite): boolean {
    return (
      this.sql.exec(
        `UPDATE booking_link SET slug = ?2, name = ?3, description = ?4, account = ?5, minutes = ?6, hours = ?7, notice_minutes = ?8, ahead_days = ?9, gap_minutes = ?10, per_day = ?11, enabled = ?12, changed_at = ?13 WHERE id = ?1`,
        id,
        w.slug,
        w.name,
        w.description,
        w.account,
        w.minutes,
        JSON.stringify(w.hours),
        w.noticeMinutes,
        w.aheadDays,
        w.gapMinutes,
        w.perDay,
        w.enabled ? 1 : 0,
        this.ports.now(),
      ).rowsWritten > 0
    )
  }

  /** Delete a link; its bookings stay. Answers whether there was one. */
  deleteLink(id: string): boolean {
    return this.sql.exec(`DELETE FROM booking_link WHERE id = ?1`, id).rowsWritten > 0
  }

  // ── Bookings ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  booking(id: string): BookingRow | null {
    const r = this.sql.exec(`SELECT * FROM booking WHERE id = ?1`, id).toArray()[0]
    return r ? bookingFrom(r) : null
  }

  bookingByHash(hash: string): BookingRow | null {
    const r = this.sql.exec(`SELECT * FROM booking WHERE manage_hash = ?1`, hash).toArray()[0]
    return r ? bookingFrom(r) : null
  }

  /** A link's bookings that have not ended, then those that ended since `since`, upcoming first (at most `limit`). */
  recentOf(linkId: string, now: number, since: number, limit: number): BookingRow[] {
    return this.sql
      .exec(
        `SELECT * FROM booking WHERE link_id = ?1 AND end_ms > ?3 ORDER BY CASE WHEN end_ms > ?2 THEN 0 ELSE 1 END, CASE WHEN end_ms > ?2 THEN start_ms ELSE -start_ms END LIMIT ?4`,
        linkId,
        now,
        since,
        limit,
      )
      .toArray()
      .map(bookingFrom)
  }

  /** The booked bookings with a move waiting on Google. */
  moving(): BookingRow[] {
    return this.sql.exec(`SELECT * FROM booking WHERE state = 'booked' AND moving_start IS NOT NULL ORDER BY moving_at, id`).toArray().map(bookingFrom)
  }

  /** The bookings waiting on Google, oldest first. */
  held(): BookingRow[] {
    return this.sql.exec(`SELECT * FROM booking WHERE state = 'held' ORDER BY created_at, id`).toArray().map(bookingFrom)
  }

  addBooking(w: BookingWrite): void {
    this.sql.exec(
      `INSERT INTO booking (id, link_id, link_name, account, calendar_id, calendar_google_id, event_id, minutes, start_ms, end_ms, visitor_name, visitor_email, visitor_key, note, manage_hash, state, checked, network, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?18, ?13, ?14, 'held', ?15, ?16, ?17)`,
      w.id,
      w.linkId,
      w.linkName,
      w.account,
      w.calendarId,
      w.calendarGoogleId,
      w.eventId,
      w.minutes,
      w.start,
      w.end,
      w.visitorName,
      w.visitorEmail,
      w.note,
      w.manageHash,
      w.checked,
      w.network,
      w.createdAt,
      w.visitorKey,
    )
  }

  /** A time that was held and is let go: the hold is gone and nothing was made. Only a hold: a booking Google made is never removed from here. */
  removeBooking(id: string): void {
    this.sql.exec(`DELETE FROM booking WHERE id = ?1 AND state = 'held'`, id)
  }

  /** Google made the event: the booking is booked, however it was checked. */
  markBooked(id: string, checked: 'google' | 'copy', at: number): void {
    this.sql.exec(`UPDATE booking SET state = 'booked', checked = ?2, booked_at = ?3 WHERE id = ?1`, id, checked, at)
  }

  /** How the time was checked, kept with the hold. */
  setChecked(id: string, checked: 'google' | 'copy'): void {
    this.sql.exec(`UPDATE booking SET checked = ?2 WHERE id = ?1`, id, checked)
  }

  markCancelled(id: string, at: number): void {
    this.sql.exec(`UPDATE booking SET state = 'cancelled', cancelled_at = ?2, moving_start = NULL, moving_end = NULL, moving_at = NULL WHERE id = ?1`, id, at)
  }

  /** A move asks for a time: it is held until Google answers or the hold runs out. */
  startMove(id: string, start: number, end: number, at: number): void {
    this.sql.exec(`UPDATE booking SET moving_start = ?2, moving_end = ?3, moving_at = ?4 WHERE id = ?1`, id, start, end, at)
  }

  /** The move was refused or abandoned: the booking keeps its time. */
  endMove(id: string): void {
    this.sql.exec(`UPDATE booking SET moving_start = NULL, moving_end = NULL, moving_at = NULL WHERE id = ?1`, id)
  }

  /** Google made the move: the booking has its new time, and one more move is used. */
  finishMove(id: string, start: number, end: number): void {
    this.sql.exec(`UPDATE booking SET start_ms = ?2, end_ms = ?3, moves = moves + 1, moving_start = NULL, moving_end = NULL, moving_at = NULL WHERE id = ?1`, id, start, end)
  }

  /**
   * The times other bookings have taken that Google's copy does not show yet: bookings waiting on Google (until `holdMs` after they were made) and moves waiting on Google (the same). A booked booking is not one: its event is in the calendar's own copy, which is
   * what holds its time. `except` is a booking that asks (a move does not collide with itself).
   */
  holds(now: number, holdMs: number, except?: string): Hold[] {
    const out: Hold[] = []
    // A booking waiting on Google holds its time for as long as it waits: it is let go only when the calendar has been read since and the event is not there (`CalendarBookings.run`), never by the clock alone.
    for (const r of this.sql.exec(`SELECT id, start_ms, end_ms FROM booking WHERE state = 'held' AND id != ?1`, except ?? '').toArray()) out.push({ bookingId: text(r.id), start: num(r.start_ms), end: num(r.end_ms) })
    for (const r of this.sql.exec(`SELECT id, moving_start, moving_end FROM booking WHERE state = 'booked' AND moving_start IS NOT NULL AND moving_at > ?1 AND id != ?2`, now - holdMs, except ?? '').toArray()) {
      out.push({ bookingId: text(r.id), start: num(r.moving_start), end: num(r.moving_end) })
    }
    return out
  }

  /** The starts of a link's bookings that count towards its most-per-day: waiting on Google or booked, and not the one that asks. */
  activeStarts(linkId: string, from: number, to: number, except?: string): number[] {
    return this.sql
      .exec(`SELECT start_ms FROM booking WHERE link_id = ?1 AND state IN ('held', 'booked') AND start_ms >= ?2 AND start_ms < ?3 AND id != ?4`, linkId, from, to, except ?? '')
      .toArray()
      .map((r) => num(r.start_ms))
  }

  // ── What the limits count ───────────────────────────────────────────────────────────────────────────────────────────────

  /** How many bookings an address made since a moment, whatever became of them (an invitation that was sent and cancelled still went out). */
  madeByVisitor(key: string, since: number): number {
    return Number(this.sql.exec(`SELECT count(*) AS n FROM booking WHERE visitor_key = ?1 AND created_at > ?2`, key, since).one().n)
  }

  /** How many meetings an address holds that have not ended (waiting on Google or booked). */
  upcomingOfVisitor(key: string, now: number): number {
    return Number(this.sql.exec(`SELECT count(*) AS n FROM booking WHERE visitor_key = ?1 AND state IN ('held', 'booked') AND end_ms > ?2`, key, now).one().n)
  }

  madeFromNetwork(network: string, since: number): number {
    return Number(this.sql.exec(`SELECT count(*) AS n FROM booking WHERE network = ?1 AND created_at > ?2`, network, since).one().n)
  }

  madeOnLink(linkId: string, since: number): number {
    return Number(this.sql.exec(`SELECT count(*) AS n FROM booking WHERE link_id = ?1 AND created_at > ?2`, linkId, since).one().n)
  }

  // ── The pepper ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The one random value hashes of a network address are keyed with, made on first use. */
  pepper(make: () => string): string {
    const held = this.sql.exec(`SELECT pepper FROM booking_meta WHERE id = 'booking'`).toArray()[0]
    if (held) return text(held.pepper)
    const fresh = make()
    this.sql.exec(`INSERT OR IGNORE INTO booking_meta (id, pepper) VALUES ('booking', ?1)`, fresh)
    return text(this.sql.exec(`SELECT pepper FROM booking_meta WHERE id = 'booking'`).one().pepper)
  }

  /** The state a stored booking is shown in before the calendar's own copy is looked at. */
  stateOf(r: BookingRow): BookingState {
    return r.state === 'held' ? 'pending' : r.state === 'cancelled' ? 'cancelled' : 'booked'
  }
}
