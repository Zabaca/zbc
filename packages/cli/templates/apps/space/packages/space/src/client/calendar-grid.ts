// What the Calendar tab's Week and Month views are made of, as plain functions (no React, no clock of its own, so test/calendar-grid.test.ts checks them on their own): which view and day the address names, which days a view
// shows and so which span it reads, where the Previous and Next buttons go, the title, which events fall on a day, and how a day's overlapping events share its width.
//
// Every day is a day KEY (`2026-11-05`) on the company's clock, as in calendar-words.ts; a key has no zone, so adding to it is calendar arithmetic. Weeks begin on Sunday, as Google Calendar's do for a US company.
import type { CalendarEvent } from '@space/workspace'
import { momentAt } from '@space/workspace'
import type { AgendaMeeting } from '../calendar'
import { addDays, type AgendaItem, clock, dayKey, daysOf, shortDay } from './calendar-words'

// ── Which view, which day: the address ──────────────────────────────────────────────────────────────────────────────────

export const VIEWS = ['agenda', 'week', 'month'] as const
export type CalView = (typeof VIEWS)[number]
export const VIEW_LABEL: Record<CalView, string> = { agenda: 'Agenda', week: 'Week', month: 'Month' }

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether `key` is a real day (`2026-02-30` is not). */
export function isDayKey(key: string): boolean {
  const m = KEY.exec(key)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

export interface Focus {
  view: CalView
  /** The day the view is about: any day of the week or month shown, the first day of a phone's three, the agenda's first day. */
  date: string
}

/** What the address (`?view=week&date=<day>`) names. Anything it cannot read is the default: the agenda, today. */
export function parseFocus(search: string, today: string): Focus {
  const q = new URLSearchParams(search)
  const v = q.get('view')
  const view = (VIEWS as readonly string[]).includes(v ?? '') ? (v as CalView) : 'agenda'
  const d = q.get('date')
  return { view, date: d !== null && isDayKey(d) ? d : today }
}

/** The query that names a focus: nothing for the default (agenda, today), no date for today, so "this week" stays this week on the next day. */
export function focusSearch(f: Focus, today: string): string {
  const q = new URLSearchParams()
  if (f.view !== 'agenda') q.set('view', f.view)
  if (f.date !== today) q.set('date', f.date)
  const s = q.toString()
  return s === '' ? '' : `?${s}`
}

// ── Days and spans ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** 0 for Sunday. */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The Sunday on or before `key`. */
export const weekStart = (key: string): string => addDays(key, -weekdayOf(key))

/** The first of the month `n` months from the one that holds `key`. */
export function monthStart(key: string, n = 0): string {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)
}

/** How many days the month that holds `key` has. */
export function daysInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The moment a day begins on the company's clock. */
export function keyStart(key: string, zone: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return momentAt(y, m, d, 0, 0, zone)
}

export interface Shape {
  /** A phone: the week is three days, and the month is dots. */
  narrow: boolean
  /** The agenda's length in days. */
  agendaDays: number
}

/** The days a view draws, first to last (a month's are whole weeks, so its edges are the neighbouring months'). */
export function daysShown(f: Focus, shape: Shape): string[] {
  const n = (count: number, first: string) => Array.from({ length: count }, (_, i) => addDays(first, i))
  switch (f.view) {
    case 'agenda':
      return n(shape.agendaDays, f.date)
    case 'week':
      return shape.narrow ? n(3, f.date) : n(7, weekStart(f.date))
    case 'month': {
      const first = monthStart(f.date)
      const start = weekStart(first)
      return n(Math.ceil((weekdayOf(first) + daysInMonth(first)) / 7) * 7, start)
    }
  }
}

/** The span to read for the days shown: from the start of the first to the start of the day after the last. */
export function spanOf(days: readonly string[], zone: string): { from: number; to: number } {
  const first = days[0] as string
  const last = days[days.length - 1] as string
  return { from: keyStart(first, zone), to: keyStart(addDays(last, 1), zone) }
}

/** Where Previous (-1) and Next (+1) go: a day for the agenda (its length), three for a phone's week, seven for a week, and the first of the neighbouring month for a month. */
export function stepFocus(f: Focus, dir: -1 | 1, shape: Shape): Focus {
  switch (f.view) {
    case 'agenda':
      return { view: f.view, date: addDays(f.date, dir * shape.agendaDays) }
    case 'week':
      return { view: f.view, date: addDays(f.date, dir * (shape.narrow ? 3 : 7)) }
    case 'month':
      return { view: f.view, date: monthStart(f.date, dir) }
  }
}

const parts = (key: string) => key.split('-').map(Number) as [number, number, number]
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The title over the range: "November 2026", "Nov 1 to 7, 2026", "Oct 26 to Nov 1, 2026", "Dec 28, 2026 to Jan 3, 2027". */
export function titleOf(f: Focus, days: readonly string[]): string {
  if (f.view === 'month') {
    const [y, m] = parts(f.date)
    return `${MONTHS[m - 1]} ${y}`
  }
  const first = days[0] as string
  const last = days[days.length - 1] as string
  const [fy, fm] = parts(first)
  const [ly, lm, ld] = parts(last)
  if (fy !== ly) return `${shortDay(first)}, ${fy} to ${shortDay(last)}, ${ly}`
  if (fm !== lm) return `${shortDay(first)} to ${shortDay(last)}, ${ly}`
  return first === last ? `${shortDay(first)}, ${ly}` : `${shortDay(first)} to ${ld}, ${ly}`
}

// ── What is on a day ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A booked meeting has a start and no end in the agenda; the grid draws it this long. */
export const MEETING_MINUTES = 30
const MINUTE = 60_000

/** The end of a thing, as the grid draws it. */
export const endOf = (i: AgendaItem): number => (i.kind === 'event' ? i.event.end : i.meeting.startsAt + MEETING_MINUTES * MINUTE)

/** Every event and meeting as one list of things to place, earliest first. */
export function itemsOf(events: readonly CalendarEvent[], meetings: readonly AgendaMeeting[]): AgendaItem[] {
  const all: AgendaItem[] = [
    ...events.map((event): AgendaItem => ({ kind: 'event', at: event.start, allDay: event.allDay, event })),
    ...meetings.map((meeting): AgendaItem => ({ kind: 'meeting', at: meeting.startsAt, allDay: false, meeting })),
  ]
  return all.sort((a, b) => a.at - b.at || endOf(a) - endOf(b))
}

export const titleOfItem = (i: AgendaItem): string => (i.kind === 'event' ? i.event.title : i.meeting.title)

/** The days an event is drawn on in a grid: an all-day event every day it covers, a timed one every day it runs into (an evening that ends after midnight is on both). */
export function coverDays(i: AgendaItem, zone: string): string[] {
  if (i.kind === 'event' && i.event.allDay) return daysOf(i.event, zone)
  const start = dayKey(i.at, zone)
  const end = endOf(i)
  const last = end > i.at ? dayKey(end - 1, zone) : start
  const days: string[] = []
  for (let d = start, n = 0; d <= last && n < 62; d = addDays(d, 1), n++) days.push(d)
  return days
}

/** The things on each of `days`, all-day first and then by start. A thing on several days is on each. */
export function byDay(items: readonly AgendaItem[], days: readonly string[], zone: string): Map<string, AgendaItem[]> {
  const out = new Map<string, AgendaItem[]>(days.map((d) => [d, []]))
  for (const item of items) for (const d of coverDays(item, zone)) out.get(d)?.push(item)
  for (const list of out.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.at - b.at || endOf(a) - endOf(b) || titleOfItem(a).localeCompare(titleOfItem(b)))
  return out
}

// ── A day's column in the week ──────────────────────────────────────────────────────────────────────────────────────────

export const MINUTES_IN_DAY = 24 * 60
/** The shortest a block is drawn, in minutes, so a ten minute call is still a block with its title in it. */
export const LEAST_MINUTES = 30

export interface Placed {
  item: AgendaItem
  /** Minutes after the day began on the clock on the wall, and how many the block spans. */
  top: number
  span: number
  /** Which of `cols` side-by-side columns this block is in. */
  col: number
  cols: number
}

/**
 * Side-by-side columns for blocks that overlap: blocks are taken in order of start; each goes in the first column whose last block is over, and a group of blocks that touch one another (directly or through others) shares
 * its widest count of columns. Returns each block's column and its group's count, in the order given. `spans` are [start, end) in any one unit.
 */
export function shareWidth(spans: readonly { start: number; end: number }[]): { col: number; cols: number }[] {
  const order = spans.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start || a.end - b.end || a.i - b.i)
  const out = new Array<{ col: number; cols: number }>(spans.length)
  let group: { i: number; col: number }[] = []
  let ends: number[] = []
  let reach = Number.NEGATIVE_INFINITY
  const close = () => {
    for (const g of group) out[g.i] = { col: g.col, cols: ends.length }
    group = []
    ends = []
  }
  for (const s of order) {
    if (s.start >= reach) close()
    let col = ends.findIndex((end) => end <= s.start)
    if (col < 0) col = ends.length
    ends[col] = s.end
    group.push({ i: s.i, col })
    reach = group.length === 1 ? s.end : Math.max(reach, s.end)
  }
  close()
  return out
}

/** The minutes after the day began, on the clock on the wall. A moment at or after the day's end is 24:00; one before its start is 0. */
function wallMinutes(ms: number, dayFrom: number, dayTo: number, zone: string): number {
  if (ms <= dayFrom) return 0
  if (ms >= dayTo) return MINUTES_IN_DAY
  const w = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(ms)
  const n = (t: string) => Number(w.find((p) => p.type === t)?.value)
  return n('hour') * 60 + n('minute')
}

/** A day's timed blocks (what the all-day row does not hold), placed on a 24 hour column. */
export function placeDay(items: readonly AgendaItem[], day: string, zone: string): Placed[] {
  const from = keyStart(day, zone)
  const to = keyStart(addDays(day, 1), zone)
  const timed = items.filter((i) => !i.allDay)
  const blocks = timed.map((item) => {
    const top = wallMinutes(item.at, from, to, zone)
    // At least LEAST_MINUTES long, but never past the end of the day (the style sheet gives a block that would be a sliver its own least height).
    return { item, top, bottom: Math.min(Math.max(wallMinutes(endOf(item), from, to, zone), top + LEAST_MINUTES), MINUTES_IN_DAY) }
  })
  const shared = shareWidth(blocks.map((b) => ({ start: b.top, end: b.bottom })))
  return blocks.map((b, i) => ({ item: b.item, top: b.top, span: b.bottom - b.top, col: shared[i]?.col ?? 0, cols: shared[i]?.cols ?? 1 }))
}

/** "9a", "9:30a", "12p": a time short enough for a chip in a month's cell. */
export const shortClock = (ms: number, zone: string): string => clock(ms, zone).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p')

/** How many lines a month's cell has for chips: all of them up to this many, else one fewer than this and "+N more". */
export const CELL_CHIPS = 3
/** What a cell of the month shows of its day's things, and how many it leaves for "+N more". */
export function cellSplit<T>(things: readonly T[]): { shown: T[]; more: number } {
  if (things.length <= CELL_CHIPS) return { shown: [...things], more: 0 }
  return { shown: things.slice(0, CELL_CHIPS - 1), more: things.length - (CELL_CHIPS - 1) }
}

/** The minutes after midnight the wall clock reads at `ms`, for the line that marks now. */
export const minutesOnTheWall = (ms: number, zone: string): number => wallMinutes(ms, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, zone)
