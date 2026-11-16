/**
 * What Claude does with the calendar, as the engine does it: read the free time from the store, and make, move and cancel an event at Google (the space's ADR 0023). No runtime import, so `bun test` drives it over a real
 * SQLite and a fake Google.
 *
 * ── THE RULE IS NOT HERE ─────────────────────────────────────────────────
 * Whether Claude may write at all (the owner's switch is on, the call carries the owner's instruction, and both are recorded) is decided and recorded by the INBOX, in its router, before any of the three writes reaches this file
 * (packages/inbox/src/app.ts, `beginCalendarWrite`). This file only does what it is asked and refuses what is not an event it can make: a field that is not the shape, a time that does not make sense, an account that is not
 * connected, an event the account does not organise. It cannot be reached from a screen or a person: the space's face (src/space.ts) has no method that calls it.
 *
 * ── WHAT IT DOES AT GOOGLE ───────────────────────────────────────────────
 * One request each, through the writer (src/google.ts), whose token is for `calendar.events` alone, asked for that request and dropped. Google sends the invitations (`sendUpdates=all`). An invite goes on the account's PRIMARY
 * calendar. A move or a cancel goes to the calendar the event is stored on, and only for an event the account ORGANISES: a guest's copy is not Claude's to move, and a guest's copy of a meeting the owner organises from another of their
 * accounts is found and used instead.
 *
 * ── THE STORE SEES IT AT ONCE ────────────────────────────────────────────
 * After Google has answered, the event Google returned is written into the store (or removed from it) and the calendar is marked for a read, so `events` shows the change in the same breath and the next incremental read, woken by
 * Google's own notification, only confirms it (it replaces the row with the same event). A failure leaves the store as it was: nothing is written before Google has answered.
 *
 * ── WHAT NEVER APPEARS ───────────────────────────────────────────────────
 * No token is in an answer, a log line or an error here: the writer never puts one in a message, and Google's own sentence is all an error carries.
 */

import {
  CALENDAR_INVITE_GUESTS_MAX,
  CALENDAR_INVITE_LONGEST_MS,
  CALENDAR_INVITE_TITLE_MAX,
  CALENDAR_DESCRIPTION_MAX,
  type CalendarEventCancelled,
  type CalendarInvite,
  type CalendarMove,
  type CalendarEventMade,
  isoAt,
  normalizeAddress,
  type RefusalReason,
} from '@space/workspace'
import type { Result } from './engine'
import { cleanText, googleLink, parseEvent } from './event-parse'
import { CalendarAccessError, CalendarError, CalendarGone, CalendarNotFound, CalendarRefused, type CalendarWriteApi } from './google'
import { calendarKey, type CalendarStore, eventKey, type HeldEvent } from './store'

const EM_DASH = '\u2014'

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const no = (reason: RefusalReason, error: string): Result<never> => ({ ok: false, reason, error })

export interface WriteDeps {
  store: CalendarStore
  /** Google's writing client for one account at a time. Absent where nothing is wired to write: every write is then refused in words. */
  writer?: ((address: string) => CalendarWriteApi) | undefined
  /** A fresh id for a Meet request (Google wants each request named once). */
  newId: () => string
  now: () => number
  /** The company's time zone: the zone an event is made in, so its guests read it as the company does. */
  zone: string
  /** Tell the page the calendar changed (after it is stored). */
  tell: () => void
  /** Ask for the alarm at this time, ms: the calendar just written is owed a read. */
  alarmAt: (at: number) => void | Promise<void>
  log?: ((line: string) => void) | undefined
}

/** A sentence for what Google said, in the engine's own reasons. Anything that is not a decision (a timeout, a server error) is thrown for the face to report as an outcome that is not known. */
function fromGoogle(error: unknown): Result<never> {
  if (error instanceof CalendarAccessError) return no('conflict', error.message)
  if (error instanceof CalendarRefused) return no('conflict', `${error.message} Press Connect calendar in Settings, Calendars and accept it.`)
  if (error instanceof CalendarNotFound || error instanceof CalendarGone) return no('not-found', 'Google no longer has that event: it was removed there since the calendar was last read. Nothing was changed.')
  if (error instanceof CalendarError && (error.status === 400 || error.status === 403 || error.status === 409)) return no(error.status === 400 ? 'bad-request' : 'conflict', `${error.message}. Nothing was changed.`)
  throw error
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A moment as the whole number of milliseconds it is, or null. */
const moment = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

/** The title and the description go out in the owner's name: no em dash, as for a message. */
const dashed = (v: string): boolean => v.includes(EM_DASH)

/** Two moments make an event: the end after the start, and not longer than `CALENDAR_INVITE_LONGEST_MS`. */
function checkSpan(start: number | null, end: number | null): Result<{ start: number; end: number }> {
  if (start === null || end === null) return no('bad-request', 'Give a start and an end as moments in time (ISO with an offset, like 2026-11-17T09:30:00-08:00).')
  if (end <= start) return no('bad-request', 'The end must be after the start.')
  if (end - start > CALENDAR_INVITE_LONGEST_MS) return no('bad-request', 'An event is at most 36 hours long: check the dates.')
  return ok({ start, end })
}

/** An invite as the face takes it, or the sentence that refuses it. Unknown fields are refused, so a misspelt `guests` is not an invite with none. */
export function readInvite(raw: unknown): Result<CalendarInvite> {
  if (!isRecord(raw)) return no('bad-request', 'An invite is an object: account, title, start, end, guests, and optionally description and meet.')
  const known = ['account', 'title', 'start', 'end', 'guests', 'description', 'meet']
  const extra = Object.keys(raw).filter((k) => !known.includes(k))
  if (extra.length > 0) return no('bad-request', `An invite carries ${known.join(', ')} only, never ${extra.join(', ')}.`)
  const account = normalizeAddress(raw.account)
  if (account === null) return no('bad-request', 'account is the address of a connected Google account, as `calendar events` lists it under accounts.')
  const title = typeof raw.title === 'string' ? cleanText(raw.title, CALENDAR_INVITE_TITLE_MAX + 1) : ''
  if (title === '' || title.length > CALENDAR_INVITE_TITLE_MAX) return no('bad-request', `title is the event's name, at most ${CALENDAR_INVITE_TITLE_MAX} characters.`)
  const span = checkSpan(moment(raw.start), moment(raw.end))
  if (!span.ok) return span
  if (!Array.isArray(raw.guests)) return no('bad-request', 'guests is a list of email addresses, empty for an event with nobody invited.')
  const guests: string[] = []
  for (const g of raw.guests) {
    const email = normalizeAddress(g)
    if (email === null) return no('bad-request', `That is not an email address: ${String(g).slice(0, 80)}. Nothing was made.`)
    if (email !== account && !guests.includes(email)) guests.push(email)
  }
  if (guests.length > CALENDAR_INVITE_GUESTS_MAX) return no('bad-request', `An invite names at most ${CALENDAR_INVITE_GUESTS_MAX} guests.`)
  let description: string | null = null
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') return no('bad-request', 'description is text.')
    const text = cleanText(raw.description, CALENDAR_DESCRIPTION_MAX + 1, true)
    if (text.length > CALENDAR_DESCRIPTION_MAX) return no('bad-request', `description is at most ${CALENDAR_DESCRIPTION_MAX} characters.`)
    description = text === '' ? null : text
  }
  if (raw.meet !== undefined && typeof raw.meet !== 'boolean') return no('bad-request', 'meet is true or false (a Google Meet link is on unless it is false).')
  if (dashed(title) || (description !== null && dashed(description))) return no('bad-request', 'Remove the em dash from the title and the description: they go out in the owner’s name.')
  return ok({ account, title, start: span.value.start, end: span.value.end, guests, description, meet: raw.meet !== false })
}

/** A move as the face takes it, or the sentence that refuses it. */
export function readMove(raw: unknown): Result<CalendarMove> {
  if (!isRecord(raw)) return no('bad-request', 'A move is an object: start and end.')
  const extra = Object.keys(raw).filter((k) => k !== 'start' && k !== 'end')
  if (extra.length > 0) return no('bad-request', `A move carries start and end only, never ${extra.join(', ')}.`)
  return checkSpan(moment(raw.start), moment(raw.end))
}

export class CalendarWrites {
  constructor(private readonly d: WriteDeps) {}

  /** Ask for the alarm now, because the calendar just written is owed a read. Best effort: Google has already answered, and a write that was done must not be reported as one that was not because the alarm could not be set. */
  private async owe(): Promise<void> {
    try {
      await this.d.alarmAt(this.d.now())
    } catch (error) {
      this.d.log?.(`calendar: the read owed after a write could not be asked for: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private writerFor(address: string): CalendarWriteApi | null {
    return this.d.writer ? this.d.writer(address) : null
  }

  /** Keep what Google answered: the event goes into the store when the store holds the calendar, and the calendar is owed a read either way. Answers the event as the caller is shown it. */
  private keep(held: { account: string; calendarKey: string; stored: boolean }, raw: unknown, intended: { title: string; guests: string[] }): CalendarEventMade {
    const parsed = parseEvent(raw, this.d.zone)
    const rawId = isRecord(raw) && typeof raw.id === 'string' ? raw.id : ''
    // The calendar is owed a read whatever happened below: it confirms the event, and finds what Google adds after it answers (a Meet link that was still being made).
    this.d.store.markCalendarDirty(held.calendarKey)
    if (parsed.kind !== 'event') {
      // Google answered something the calendar cannot draw (never an event it just made, in practice): say what is known, and let the read find the rest.
      return { id: eventKey(held.calendarKey, rawId), eventId: rawId, account: held.account, title: intended.title, start: 0, end: 0, guests: intended.guests, link: null, meetLink: null, stored: false }
    }
    let stored = false
    if (held.stored) stored = this.d.store.putEvent(held.calendarKey, parsed).changed
    this.d.tell()
    return {
      id: eventKey(held.calendarKey, parsed.id),
      eventId: parsed.id,
      account: held.account,
      title: parsed.title,
      start: parsed.start,
      end: parsed.end,
      guests: parsed.guests.filter((g) => !g.self && g.email !== null).map((g) => g.email as string),
      link: googleLink(isRecord(raw) ? raw.htmlLink : null),
      meetLink: parsed.videoLink,
      stored,
    }
  }

  async invite(input: unknown): Promise<Result<CalendarEventMade>> {
    const read = readInvite(input)
    if (!read.ok) return read
    const invite = read.value
    const account = this.d.store.account(invite.account)
    if (!account) {
      const connected = this.d.store.accounts().map((a) => a.address)
      return no('not-found', `${invite.account} is not a connected Google account.${connected.length > 0 ? ` Connected: ${connected.join(', ')}.` : ''}`)
    }
    const writer = this.writerFor(account.address)
    if (!writer) return no('conflict', 'This install cannot change calendar events from here.')
    const primary = this.d.store.calendars(account.address).find((c) => c.primary) ?? null
    const body = {
      summary: invite.title,
      ...(invite.description !== null && { description: invite.description }),
      start: { dateTime: isoAt(invite.start, this.d.zone), timeZone: this.d.zone },
      end: { dateTime: isoAt(invite.end, this.d.zone), timeZone: this.d.zone },
      attendees: invite.guests.map((email) => ({ email })),
      ...(invite.meet && { conferenceData: { createRequest: { requestId: this.d.newId(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }),
    }
    let raw: Record<string, unknown>
    try {
      raw = await writer.insertEvent(primary?.googleId ?? 'primary', body)
    } catch (error) {
      return fromGoogle(error)
    }
    const calendar = primary?.id ?? calendarKey(account.address, account.address)
    // Written into the store only where the store keeps that calendar and shows it: a hidden one holds no events, and the owner's choice to hide it stands.
    const written = this.keep({ account: account.address, calendarKey: calendar, stored: primary?.shown === true }, raw, { title: invite.title, guests: invite.guests })
    await this.owe()
    return ok(written)
  }

  /**
   * The stored event a move or a cancel is about, as the copy the account ORGANISES: the one named if its organiser is its own account (or Google named none), else the same meeting's copy on the organiser's account when that is one of the
   * owner's, else a refusal in words.
   */
  private organised(id: unknown): Result<HeldEvent> {
    if (typeof id !== 'string' || id.length > 900) return no('not-found', 'No such event.')
    const held = this.d.store.held(id)
    if (!held) return no('not-found', 'That event is not in the calendar: it was changed or removed since it was read. Read `calendar events` again.')
    if (held.organizerEmail === null || held.organizerEmail === held.calendar.account) return ok(held)
    const mine = held.iCalUid === null ? null : this.d.store.copyOn(held.iCalUid, held.start, held.organizerEmail)
    if (mine && (mine.organizerEmail === null || mine.organizerEmail === mine.calendar.account)) return ok(mine)
    return no('conflict', `${held.title} is organised by ${held.organizerEmail}, not by an account this calendar can change, so it is theirs to move or cancel. Nothing was changed.`)
  }

  async move(id: unknown, input: unknown): Promise<Result<CalendarEventMade>> {
    const read = readMove(input)
    if (!read.ok) return read
    const found = this.organised(id)
    if (!found.ok) return found
    const held = found.value
    if (held.allDay) return no('bad-request', `${held.title} is an all-day event, which cannot be moved from here: it has days, not a time.`)
    const writer = this.writerFor(held.calendar.account)
    if (!writer) return no('conflict', 'This install cannot change calendar events from here.')
    let raw: Record<string, unknown>
    try {
      raw = await writer.patchEvent(held.calendar.googleId, held.eventId, {
        start: { dateTime: isoAt(read.value.start, this.d.zone), timeZone: this.d.zone },
        end: { dateTime: isoAt(read.value.end, this.d.zone), timeZone: this.d.zone },
      })
    } catch (error) {
      return fromGoogle(error)
    }
    const written = this.keep({ account: held.calendar.account, calendarKey: held.calendar.id, stored: true }, raw, { title: held.title, guests: [] })
    await this.owe()
    return ok(written)
  }

  async cancel(id: unknown): Promise<Result<CalendarEventCancelled>> {
    const found = this.organised(id)
    if (!found.ok) return found
    const held = found.value
    const writer = this.writerFor(held.calendar.account)
    if (!writer) return no('conflict', 'This install cannot change calendar events from here.')
    try {
      await writer.deleteEvent(held.calendar.googleId, held.eventId)
    } catch (error) {
      return fromGoogle(error)
    }
    if (this.d.store.dropEvent(held.calendar.id, held.eventId).changed) this.d.tell()
    this.d.store.markCalendarDirty(held.calendar.id)
    await this.owe()
    return ok({ id: held.id, eventId: held.eventId, account: held.calendar.account, title: held.title })
  }
}
