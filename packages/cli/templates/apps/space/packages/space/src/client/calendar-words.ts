// What the Calendar tab says, as plain functions: which day an event is on, how a day and a time read, who answered what. No React and no clock of its own, so the wording is checked on its own
// (test/calendar-words.test.ts). Every time is read on the COMPANY'S clock with the zone named where it matters, as the Schedule form and Today read theirs (a time means one thing everywhere); an all-day
// event has days and no hour, and its days are Google's, never moved by the reader's zone.
import type { CalendarAccountMark, CalendarAgendaAccount, CalendarEvent, CalendarResponse } from '@space/workspace'
import { momentAt, wallAt } from '@space/workspace'
import type { AgendaMeeting } from '../calendar'

const p = (n: number, width = 2): string => String(n).padStart(width, '0')

/** The day a moment is on, on the company's clock: `2026-11-05`. */
export function dayKey(ms: number, zone: string): string {
  const w = wallAt(ms, zone)
  return `${p(w.y, 4)}-${p(w.m)}-${p(w.d)}`
}

/** The moment a day, `days` after the one that holds `ms`, begins on the company's clock. */
export function dayStart(ms: number, zone: string, days = 0): number {
  const w = wallAt(ms, zone)
  return momentAt(w.y, w.m, w.d + days, 0, 0, zone)
}

/** `2026-11-05` plus `n` days. Pure calendar arithmetic on the date, which has no zone. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** "Today", "Tomorrow" or "Friday, Nov 6" (with the year when it is not this one). */
export function dayHeading(key: string, today: string): string {
  if (key === today) return 'Today'
  if (key === addDays(today, 1)) return 'Tomorrow'
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d, 12))
  const text = date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric', ...(y !== Number(today.slice(0, 4)) && { year: 'numeric' }) })
  return text
}

/** "9:00 AM": a time on the company's clock. */
export const clock = (ms: number, zone: string): string => new Date(ms).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })

/** The zone's short name at a moment: "PST". */
export const zoneName = (ms: number, zone: string): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find((x) => x.type === 'timeZoneName')?.value ?? zone

/** "Nov 6" from a day key. */
export function shortDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
}

/** "Fri, Nov 6": a day key with its weekday. */
export function weekdayDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}

type Timed = Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'startDate' | 'endDate'>

/** The days an event is drawn under: a timed event its first day, an all-day event every day it covers. */
export function daysOf(e: Timed, zone: string): string[] {
  if (!e.allDay || e.startDate === null) return [dayKey(e.start, zone)]
  const last = e.endDate ?? e.startDate
  const days: string[] = []
  for (let day = e.startDate, n = 0; day <= last && n < 62; day = addDays(day, 1), n++) days.push(day)
  return days
}

/** "9:00 AM to 9:30 AM", "All day", "All day, Nov 6 to Nov 8"; for a timed event that ends another day, the day is said. */
export function timeRange(e: Timed, zone: string): string {
  if (e.allDay) {
    if (e.startDate === null || e.endDate === null || e.startDate === e.endDate) return 'All day'
    return `All day, ${shortDay(e.startDate)} to ${shortDay(e.endDate)}`
  }
  if (e.end <= e.start) return clock(e.start, zone)
  const sameDay = dayKey(e.start, zone) === dayKey(e.end - 1, zone)
  return sameDay ? `${clock(e.start, zone)} to ${clock(e.end, zone)}` : `${clock(e.start, zone)} to ${shortDay(dayKey(e.end, zone))}, ${clock(e.end, zone)}`
}

/** A row's short time: the start alone ("9:00 AM"), or "All day". */
export const startWords = (e: Timed, zone: string): string => (e.allDay ? 'All day' : clock(e.start, zone))

/** "Fri, Nov 6, 9:00 AM to 9:30 AM PST": the card's line, with the day and the zone named. */
export function cardWhen(e: Timed, zone: string): string {
  if (e.allDay) {
    if (e.startDate === null) return 'All day'
    return `${weekdayDay(e.startDate)}${e.endDate !== null && e.endDate !== e.startDate ? ` to ${weekdayDay(e.endDate)}` : ''}, all day`
  }
  const day = new Date(e.start).toLocaleDateString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' })
  return `${day}, ${timeRange(e, zone)} ${zoneName(e.start, zone)}`
}

/** How the account answered, in the words of a row; null when there is nothing to say (an answered "yes" is not news). */
export function responseTag(r: CalendarResponse | null): string | null {
  switch (r) {
    case 'needsAction':
      return 'Not answered'
    case 'declined':
      return 'Declined'
    case 'tentative':
      return 'Maybe'
    default:
      return null
  }
}

/** How a guest answered, for the card's list. */
export const guestResponse: Record<CalendarResponse, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', needsAction: 'Not answered' }

/** "northfield", "northfield and sales", "northfield, sales and support". */
export function accountsWords(accounts: readonly CalendarAccountMark[]): string {
  const names = accounts.map((a) => a.label)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** One thing in the agenda: an event from Google, or a meeting booked in Meet. */
export type AgendaItem = { kind: 'event'; at: number; allDay: boolean; event: CalendarEvent } | { kind: 'meeting'; at: number; allDay: false; meeting: AgendaMeeting }

/** A day of the agenda. */
export interface AgendaDay {
  key: string
  heading: string
  items: AgendaItem[]
}

/**
 * The agenda by day: every event and meeting under the day (or days) it is on, all-day first and then by time, from `from` (a day key; today unless the Previous and Next buttons moved it) for `count` days. The first day
 * is always a day, even with nothing on it; any other day is there only when something is. A declined invitation is kept (and drawn dimmed): the person may want to see what they said no to.
 */
export function agendaDays(events: readonly CalendarEvent[], meetings: readonly AgendaMeeting[], now: number, zone: string, count: number, from?: string): AgendaDay[] {
  const today = dayKey(now, zone)
  const first = from ?? today
  const last = addDays(first, count - 1)
  const by = new Map<string, AgendaItem[]>([[first, []]])
  const put = (key: string, item: AgendaItem) => {
    if (key < first || key > last) return
    const held = by.get(key)
    if (held) held.push(item)
    else by.set(key, [item])
  }
  for (const event of events) for (const key of daysOf(event, zone)) put(key, { kind: 'event', at: event.start, allDay: event.allDay, event })
  for (const meeting of meetings) put(dayKey(meeting.startsAt, zone), { kind: 'meeting', at: meeting.startsAt, allDay: false, meeting })
  const order = (a: AgendaItem, b: AgendaItem) => Number(b.allDay) - Number(a.allDay) || a.at - b.at || title(a).localeCompare(title(b))
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, items]) => ({ key, heading: dayHeading(key, today), items: items.sort(order) }))
}

const title = (i: AgendaItem): string => (i.kind === 'event' ? i.event.title : i.meeting.title)

/** The amber sentences for the accounts whose picture is not whole, each naming its account (the agenda's, and Settings'). */
export const troubleOf = (accounts: readonly CalendarAgendaAccount[]): { address: string; text: string }[] =>
  accounts.flatMap((a) => (a.reason !== null ? [{ address: a.address, text: a.reason }] : []))
