// The Calendar tab's reads and Settings, Calendars, asked of the calendar app (packages/calendar), which runs in this Worker over the store it owns (parts.ts).
//
// Every call is the person this request's one sign-in check named (packages/workspace/docs/adr/0003), whom the calendar admits if they are the install's owner and no one else. The calendar decides who may do what and
// every rule of what it keeps; the space only carries the question and refuses an answer that is not the shape the contract says. NOTHING HERE ASKS GOOGLE: the calendar answers from its own store (the sync is its alarm's).
//
// The booking links (the space's ADR 0025) are settings here too: the card's list, and making, changing and deleting a link. A visitor's booking is not asked here: it comes in at the open path (src/booking.ts).
//
// The busy blocks (the space's ADR 0024) are settings here: how they stand, the switch and an account's part in it. None of them writes an event to Google; the calendar's own alarm does that, once the setting says so.
//
// The agenda is the calendar's events AND the meetings booked in Meet (they are on no Google calendar), merged by the page by time. Meet's are asked in parallel and may fail alone: the agenda then says they are not listed.
//
// A READ waits `ANSWER_WITHIN_MS` and is `unreachable` when the app does not answer. A WRITE (showing or hiding a calendar, Check now) waits `WRITE_WITHIN_MS` and is NEVER retried. Both answer a `ViewAnswer`, the same words the
// inbox's views and the knowledge base use (views.ts).

import {
  ANSWER_WITHIN_MS,
  BOOKING_STATES,
  BOOKING_WEEKDAYS,
  type BookingLinkView,
  CALENDAR_ACCOUNT_STATES,
  CALENDAR_RESPONSES,
  type CalendarAccountView,
  type CalendarAgenda,
  type CalendarBlocking,
  type CalendarBookingLinks,
  type CalendarEvent,
  type CalendarView,
  type MeetCall,
  WRITE_WITHIN_MS,
} from '@space/workspace'
import { isBool, isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { isMeetCalls, notConnected, reach, reachWrite } from './reach'
import { answerOf, type ViewAnswer } from './views'

const PART = 'Calendar'

const each = (v: unknown, ok: (x: unknown) => boolean): boolean => isList(v) && v.every(ok)
const textOrNull = (v: unknown): boolean => v === null || isText(v)
const countOrNull = (v: unknown): boolean => v === null || isCount(v)
const states = new Set<string>(CALENDAR_ACCOUNT_STATES)
const responses = new Set<string>(CALENDAR_RESPONSES)

const isMark = (v: unknown): boolean => isRecord(v) && isText(v.address) && isText(v.label) && isCount(v.hue)

export const isCalendarView = (v: unknown): v is CalendarView =>
  isRecord(v) && isText(v.id) && isText(v.name) && textOrNull(v.color) && isBool(v.primary) && isBool(v.shown) && countOrNull(v.readAt) && textOrNull(v.problem) && textOrNull(v.note)

const blockFixes = new Set<string>(['connect-again', 'connect-calendar'])

/** How the busy blocks stand: the switch, the count, the sentence, and each account's part in it and why it cannot take part. */
export const isCalendarBlocking = (v: unknown): v is CalendarBlocking =>
  isRecord(v) &&
  isBool(v.on) &&
  isCount(v.kept) &&
  textOrNull(v.problem) &&
  each(v.accounts, (a) => isRecord(a) && isText(a.address) && isText(a.label) && isCount(a.hue) && isBool(a.takesPart) && textOrNull(a.skipped) && (a.fix === null || (isText(a.fix) && blockFixes.has(a.fix))))

export const isCalendarAccounts = (v: unknown): v is CalendarAccountView[] =>
  each(
    v,
    (a) =>
      isRecord(a) &&
      isText(a.address) &&
      isText(a.label) &&
      isCount(a.hue) &&
      isText(a.state) &&
      states.has(a.state) &&
      textOrNull(a.reason) &&
      countOrNull(a.readAt) &&
      textOrNull(a.note) &&
      each(a.calendars, isCalendarView),
  )

export const isCalendarEvent = (v: unknown): v is CalendarEvent =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.title) &&
  isCount(v.start) &&
  isCount(v.end) &&
  isBool(v.allDay) &&
  textOrNull(v.startDate) &&
  textOrNull(v.endDate) &&
  textOrNull(v.location) &&
  textOrNull(v.videoLink) &&
  textOrNull(v.htmlLink) &&
  textOrNull(v.description) &&
  (v.status === 'confirmed' || v.status === 'tentative') &&
  (v.response === null || (isText(v.response) && responses.has(v.response))) &&
  (v.organizer === null || (isRecord(v.organizer) && textOrNull(v.organizer.name) && textOrNull(v.organizer.email))) &&
  each(v.guests, (g) => isRecord(g) && textOrNull(g.name) && textOrNull(g.email) && isText(g.response) && responses.has(g.response) && isBool(g.organizer) && isBool(g.self)) &&
  isCount(v.guestsLeft) &&
  each(v.accounts, isMark) &&
  isBool(v.free) &&
  countOrNull(v.readAt) &&
  isBool(v.stale)

/** The answer of `eventsByUid`: one entry per ask, an event or null. */
export const isCalendarEventsOrNull = (v: unknown): v is (CalendarEvent | null)[] => each(v, (e) => e === null || isCalendarEvent(e))

export const isCalendarAgenda = (v: unknown): v is CalendarAgenda =>
  isRecord(v) &&
  isCount(v.from) &&
  isCount(v.to) &&
  each(v.events, isCalendarEvent) &&
  each(v.accounts, (a) => isMark(a) && isRecord(a) && isText(a.state) && states.has(a.state) && textOrNull(a.reason) && countOrNull(a.readAt))

/** A meeting booked in Meet, as the agenda draws it beside Google's events (they are on no Google calendar). */
export interface AgendaMeeting {
  id: string
  title: string
  startsAt: number
  /** The call's link, made by meet on this space's address: what Join opens. */
  link: string
  with: string[]
}

/** The agenda as the page is given it: the calendar's events, and Meet's meetings in the same span (or why they are not listed). */
export interface CalendarAgendaAnswer extends CalendarAgenda {
  meetings: AgendaMeeting[]
  /** False where meet did not answer: the page says the meetings are not listed rather than that there are none. */
  meetingsListed: boolean
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** The widest span an agenda is asked for, mirrored from the contract so a bad request is a 400 here and never reaches the app. */
const MAX_SPAN_MS = 62 * 24 * 60 * 60 * 1000

/** The agenda from `from` to `to` (milliseconds, as query strings). */
export async function readAgenda(ask: Asking, query: URLSearchParams): Promise<Parsed<ViewAnswer<CalendarAgendaAnswer>>> {
  const from = Number(query.get('from'))
  const to = Number(query.get('to'))
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > MAX_SPAN_MS) {
    return { ok: false, message: 'Ask for an agenda as ?from=<ms>&to=<ms>, a span of at most 62 days.' }
  }
  const { calendar, meet } = ask.apps
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const a = ask.signedIn
  const [events, meetings] = await Promise.all([
    calendar ? reach(PART, () => calendar.agenda(a, from, to), isCalendarAgenda, ms) : notConnected(PART),
    meet ? reach('Chat', () => meet.meetings(a, from, to), isMeetCalls, ms) : notConnected('Chat'),
  ])
  if (!events.ok) return { ok: true, value: answerOf(events) }
  const listed: AgendaMeeting[] = meetings.ok
    ? meetings.value.flatMap((c: MeetCall) => (c.startsAt === null ? [] : [{ id: c.name, title: c.title ?? 'Meeting', startsAt: c.startsAt, link: c.link, with: c.invitees.map((i) => i.name) }]))
    : []
  return { ok: true, value: { result: 'ok', value: { ...events.value, meetings: listed.sort((x, y) => x.startsAt - y.startsAt || x.id.localeCompare(y.id)), meetingsListed: meetings.ok } } }
}

/** The accounts and their calendars. */
export async function readAccounts(ask: Asking): Promise<ViewAnswer<CalendarAccountView[]>> {
  const { calendar } = ask.apps
  if (!calendar) return answerOf(notConnected(PART))
  const a = ask.signedIn
  return answerOf(await reach(PART, () => calendar.calendars(a), isCalendarAccounts, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

/** The id of an event or a calendar a request names: the address and Google's ids, so a path-shaped or enormous string never reaches the app. */
const KEY = /^[A-Za-z0-9@._#%+~:=|-]{1,900}$/

/** One event by its key. */
export async function readEvent(ask: Asking, id: string | null): Promise<Parsed<ViewAnswer<CalendarEvent>>> {
  if (id === null || !KEY.test(id)) return { ok: false, message: 'Name an event as ?id=<key>.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: answerOf(notConnected(PART)) }
  const a = ask.signedIn
  return { ok: true, value: answerOf(await reach(PART, () => calendar.event(a, id), isCalendarEvent, ask.answerWithinMs ?? ANSWER_WITHIN_MS)) }
}

/** Show or hide a calendar, by the owner, never retried. */
export async function setShown(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<CalendarView>>> {
  if (!isRecord(body) || !isText(body.calendar) || !KEY.test(body.calendar) || !isBool(body.shown)) return { ok: false, message: 'Say which calendar and whether it is shown: {"calendar": "<id>", "shown": true}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const [a, id, shown] = [ask.signedIn, body.calendar, body.shown]
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.setShown(a, id, shown), isCalendarView, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

/** Check now: ask for every calendar to be read again. */
export async function syncNow(ask: Asking): Promise<ViewAnswer<{ asked: number }>> {
  const { calendar } = ask.apps
  if (!calendar) return { result: 'failed', message: 'The calendar is not connected to the space. Nothing was done.' }
  const a = ask.signedIn
  return answerOf(await reachWrite(PART, () => calendar.syncNow(a), (v): v is { asked: number } => isRecord(v) && isCount(v.asked), ask.writeWithinMs ?? WRITE_WITHIN_MS))
}

/** How the busy blocks stand. */
export async function readBlocking(ask: Asking): Promise<ViewAnswer<CalendarBlocking>> {
  const { calendar } = ask.apps
  if (!calendar) return answerOf(notConnected(PART))
  const a = ask.signedIn
  return answerOf(await reach(PART, () => calendar.blocking(a), isCalendarBlocking, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

/** Turn the busy blocks on or off, by the owner, never retried. A setting only: the calendar's alarm makes or removes the blocks. */
export async function setBlocking(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<CalendarBlocking>>> {
  if (!isRecord(body) || !isBool(body.on)) return { ok: false, message: 'Say whether the busy blocks are on: {"on": true}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const [a, on] = [ask.signedIn, body.on]
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.setBlocking(a, on), isCalendarBlocking, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

/** Take an account in or out of the busy blocks, by the owner, never retried. */
export async function setBlockingAccount(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<CalendarBlocking>>> {
  if (!isRecord(body) || !isText(body.account) || !KEY.test(body.account) || !isBool(body.takesPart)) return { ok: false, message: 'Say which account and whether it takes part: {"account": "<address>", "takesPart": true}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const [a, address, takesPart] = [ask.signedIn, body.account, body.takesPart]
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.setBlockingAccount(a, address, takesPart), isCalendarBlocking, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

// ── The booking links (the space's ADR 0025) ────────────────────────────────────────────────────────────────────────────────────

const bookingStates = new Set<string>(BOOKING_STATES)

const isSpans = (v: unknown): boolean => each(v, (s) => isRecord(s) && isCount(s.from) && isCount(s.to))
const isHours = (v: unknown): boolean => isRecord(v) && BOOKING_WEEKDAYS.every((d) => isSpans(v[d]))

const isWhere = (v: unknown): boolean => v === 'meet' || v === 'space'

const isBookingRecord = (v: unknown): boolean =>
  isRecord(v) && isText(v.id) && isWhere(v.where) && isText(v.linkName) && isText(v.name) && isText(v.email) && textOrNull(v.note) && isCount(v.start) && isCount(v.end) && isCount(v.bookedAt) && isText(v.state) && bookingStates.has(v.state) && (v.checked === 'google' || v.checked === 'copy') && textOrNull(v.link)

export const isBookingLink = (v: unknown): v is BookingLinkView =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.slug) &&
  isText(v.name) &&
  typeof v.description === 'string' &&
  isText(v.account) &&
  isText(v.accountLabel) &&
  isCount(v.minutes) &&
  isHours(v.hours) &&
  isCount(v.noticeMinutes) &&
  isCount(v.aheadDays) &&
  isCount(v.gapMinutes) &&
  (v.perDay === null || isCount(v.perDay)) &&
  isBool(v.enabled) &&
  isWhere(v.where) &&
  isText(v.url) &&
  textOrNull(v.problem) &&
  each(v.bookings, isBookingRecord)

export const isBookingLinks = (v: unknown): v is CalendarBookingLinks =>
  isRecord(v) &&
  each(v.links, isBookingLink) &&
  each(v.accounts, (a) => isRecord(a) && isText(a.address) && isText(a.label) && isBool(a.canBook) && textOrNull(a.why)) &&
  isRecord(v.defaults) &&
  isCount(v.defaults.minutes) &&
  isHours(v.defaults.hours) &&
  isText(v.zone) &&
  isText(v.origin) &&
  isBool(v.calls)

/** The booking links with their bookings, for Settings, Calendars. */
export async function readBookingLinks(ask: Asking): Promise<ViewAnswer<CalendarBookingLinks>> {
  const { calendar } = ask.apps
  if (!calendar) return answerOf(notConnected(PART))
  const a = ask.signedIn
  return answerOf(await reach(PART, () => calendar.bookingLinks(a), isBookingLinks, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

/** The calendar's own words refuse a link that is not whole, so the body is passed on as it came: this checks only that there is one. */
const isBody = (v: unknown): v is Record<string, unknown> => isRecord(v)

/** Make a booking link, by the owner, never retried. A setting only: no event is made until a visitor books. */
export async function makeBookingLink(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<BookingLinkView>>> {
  if (!isBody(body)) return { ok: false, message: 'Send the link as an object: {"slug": "intro", "name": "Intro call", ...}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const a = ask.signedIn
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.makeBookingLink(a, body as never), isBookingLink, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

/** Change a booking link (its rules, its account, whether it is on), by the owner, never retried. */
export async function changeBookingLink(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<BookingLinkView>>> {
  if (!isBody(body) || !isText(body.id) || !isBody(body.link)) return { ok: false, message: 'Say which link and what it is now: {"id": "<id>", "link": {...}}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const [a, id, link] = [ask.signedIn, body.id, body.link]
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.changeBookingLink(a, id, link as never), isBookingLink, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

/** Delete a booking link, by the owner, never retried. Its bookings stay as the events they are. */
export async function deleteBookingLink(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<{ id: string }>>> {
  if (!isBody(body) || !isText(body.id)) return { ok: false, message: 'Say which link: {"id": "<id>"}.' }
  const { calendar } = ask.apps
  if (!calendar) return { ok: true, value: { result: 'failed', message: 'The calendar is not connected to the space. Nothing was changed.' } }
  const [a, id] = [ask.signedIn, body.id]
  return { ok: true, value: answerOf(await reachWrite(PART, () => calendar.deleteBookingLink(a, id), (v): v is { id: string } => isRecord(v) && isText(v.id), ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}
