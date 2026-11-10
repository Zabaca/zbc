// The Calendar tab's reads and Settings, Calendars, asked of the calendar app (packages/calendar), which runs in this Worker over the store it owns (parts.ts).
//
// Every call is the person this request's one sign-in check named (packages/workspace/docs/adr/0003), whom the calendar admits if they are the install's owner and no one else. The calendar decides who may do what and
// every rule of what it keeps; the space only carries the question and refuses an answer that is not the shape the contract says. NOTHING HERE ASKS GOOGLE: the calendar answers from its own store (the sync is its alarm's).
//
// The agenda is the calendar's events AND the meetings booked in Meet (they are on no Google calendar), merged by the page by time. Meet's are asked in parallel and may fail alone: the agenda then says they are not listed.
//
// A READ waits `ANSWER_WITHIN_MS` and is `unreachable` when the app does not answer. A WRITE (showing or hiding a calendar, Check now) waits `WRITE_WITHIN_MS` and is NEVER retried. Both answer a `ViewAnswer`, the same words the
// inbox's views and the knowledge base use (views.ts).

import {
  ANSWER_WITHIN_MS,
  CALENDAR_ACCOUNT_STATES,
  CALENDAR_RESPONSES,
  type CalendarAccountView,
  type CalendarAgenda,
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
