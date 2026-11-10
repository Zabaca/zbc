import { describe, expect, test } from 'bun:test'
import type { CalendarEvent } from '@space/workspace'
import {
  byDay,
  cellSplit,
  daysShown,
  focusSearch,
  isDayKey,
  itemsOf,
  keyStart,
  minutesOnTheWall,
  monthStart,
  parseFocus,
  placeDay,
  type Shape,
  shareWidth,
  shortClock,
  spanOf,
  stepFocus,
  titleOf,
  weekStart,
} from '../src/client/calendar-grid'

/**
 * What the Week and Month views are made of, on the company's clock (Los Angeles; the clocks go back on Sunday 1 November 2026): the view and day the address names, the days each view draws, where Previous and Next go, the
 * title, which day a thing is on (an evening that runs past midnight is on both), and how overlapping things share a column.
 */

const ZONE = 'America/Los_Angeles'
const TODAY = '2026-11-05' // a Thursday
const WIDE: Shape = { narrow: false, agendaDays: 14 }
const PHONE: Shape = { narrow: true, agendaDays: 14 }
const la = (iso: string): number => Date.parse(iso)

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'a|b|c',
  title: 'Standup',
  start: la('2026-11-05T17:00:00Z'),
  end: la('2026-11-05T17:30:00Z'),
  allDay: false,
  startDate: null,
  endDate: null,
  location: null,
  videoLink: null,
  htmlLink: null,
  description: null,
  status: 'confirmed',
  response: null,
  organizer: null,
  guests: [],
  guestsLeft: 0,
  accounts: [{ address: 'tessa@northfield.example', label: 'northfield', hue: 0 }],
  free: false,
  readAt: null,
  stale: false,
  ...over,
})

describe('the address', () => {
  test('names a view and a day; anything it cannot read is the agenda, today', () => {
    expect(parseFocus('?view=week&date=2026-11-12', TODAY)).toEqual({ view: 'week', date: '2026-11-12' })
    expect(parseFocus('?view=month', TODAY)).toEqual({ view: 'month', date: TODAY })
    expect(parseFocus('', TODAY)).toEqual({ view: 'agenda', date: TODAY })
    expect(parseFocus('?view=year&date=soon', TODAY)).toEqual({ view: 'agenda', date: TODAY })
    expect(parseFocus('?view=week&date=2026-02-30', TODAY)).toEqual({ view: 'week', date: TODAY })
    expect(isDayKey('2026-02-29')).toBe(false)
    expect(isDayKey('2028-02-29')).toBe(true)
  })

  test('writes nothing for the default, and no day for today, so this week stays this week tomorrow', () => {
    expect(focusSearch({ view: 'agenda', date: TODAY }, TODAY)).toBe('')
    expect(focusSearch({ view: 'week', date: TODAY }, TODAY)).toBe('?view=week')
    expect(focusSearch({ view: 'month', date: '2026-12-01' }, TODAY)).toBe('?view=month&date=2026-12-01')
    expect(focusSearch({ view: 'agenda', date: '2026-11-20' }, TODAY)).toBe('?date=2026-11-20')
    for (const f of [{ view: 'week', date: '2026-11-12' }, { view: 'month', date: TODAY }, { view: 'agenda', date: '2026-11-20' }] as const) expect(parseFocus(focusSearch(f, TODAY), TODAY)).toEqual(f)
  })
})

describe('the days a view draws', () => {
  test('a week is Sunday to Saturday, and three days from the chosen one on a phone', () => {
    expect(weekStart('2026-11-05')).toBe('2026-11-01')
    expect(daysShown({ view: 'week', date: TODAY }, WIDE)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])
    expect(daysShown({ view: 'week', date: TODAY }, PHONE)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07'])
  })

  test('a month is whole weeks: five for November 2026, six for August 2026, four for February 2026', () => {
    const nov = daysShown({ view: 'month', date: TODAY }, WIDE)
    expect(nov).toHaveLength(35)
    expect([nov[0], nov[34]]).toEqual(['2026-11-01', '2026-12-05'])
    const aug = daysShown({ view: 'month', date: '2026-08-15' }, WIDE)
    expect(aug).toHaveLength(42)
    expect([aug[0], aug[41]]).toEqual(['2026-07-26', '2026-09-05'])
    expect(daysShown({ view: 'month', date: '2026-02-10' }, WIDE)).toHaveLength(28)
  })

  test('the agenda is its length in days from the chosen day', () => {
    expect(daysShown({ view: 'agenda', date: TODAY }, WIDE)).toHaveLength(14)
    expect(daysShown({ view: 'agenda', date: '2026-11-20' }, { narrow: false, agendaDays: 3 })).toEqual(['2026-11-20', '2026-11-21', '2026-11-22'])
  })

  test('the span read reaches the start of the day after the last: a week that holds the clocks going back is an hour over seven days, and no month is wider than the 62 days an agenda may ask for', () => {
    const week = spanOf(daysShown({ view: 'week', date: TODAY }, WIDE), ZONE)
    expect(week.from).toBe(la('2026-11-01T07:00:00Z')) // midnight Sunday, still summer time
    expect(week.to).toBe(la('2026-11-08T08:00:00Z')) // midnight the next Sunday, winter time
    expect(week.to - week.from).toBe(7 * 24 * 3_600_000 + 3_600_000)
    for (const m of ['2026-08-15', '2026-02-10', '2026-03-10']) {
      const s = spanOf(daysShown({ view: 'month', date: m }, WIDE), ZONE)
      expect(s.to - s.from).toBeLessThanOrEqual(62 * 24 * 3_600_000)
    }
    expect(keyStart('2026-11-05', ZONE)).toBe(la('2026-11-05T08:00:00Z'))
  })
})

describe('Previous and Next', () => {
  test('step the agenda by its length, a week by seven days, a phone’s week by three, and a month to the first of the next', () => {
    expect(stepFocus({ view: 'agenda', date: TODAY }, 1, WIDE).date).toBe('2026-11-19')
    expect(stepFocus({ view: 'week', date: TODAY }, -1, WIDE).date).toBe('2026-10-29')
    expect(stepFocus({ view: 'week', date: TODAY }, 1, PHONE).date).toBe('2026-11-08')
    expect(stepFocus({ view: 'month', date: '2026-11-17' }, 1, WIDE).date).toBe('2026-12-01')
    expect(stepFocus({ view: 'month', date: '2026-01-31' }, -1, WIDE).date).toBe('2025-12-01')
    expect(monthStart('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('the title', () => {
  test('names the month, or the days with the month and year only where they change', () => {
    expect(titleOf({ view: 'month', date: TODAY }, daysShown({ view: 'month', date: TODAY }, WIDE))).toBe('November 2026')
    expect(titleOf({ view: 'week', date: TODAY }, daysShown({ view: 'week', date: TODAY }, WIDE))).toBe('Nov 1 to 7, 2026')
    expect(titleOf({ view: 'week', date: '2026-10-29' }, daysShown({ view: 'week', date: '2026-10-29' }, WIDE))).toBe('Oct 25 to 31, 2026')
    expect(titleOf({ view: 'week', date: '2026-11-30' }, daysShown({ view: 'week', date: '2026-11-30' }, WIDE))).toBe('Nov 29 to Dec 5, 2026')
    expect(titleOf({ view: 'week', date: '2026-12-30' }, daysShown({ view: 'week', date: '2026-12-30' }, WIDE))).toBe('Dec 27, 2026 to Jan 2, 2027')
    expect(titleOf({ view: 'week', date: TODAY }, daysShown({ view: 'week', date: TODAY }, PHONE))).toBe('Nov 5 to 7, 2026')
    expect(titleOf({ view: 'agenda', date: TODAY }, daysShown({ view: 'agenda', date: TODAY }, WIDE))).toBe('Nov 5 to 18, 2026')
  })
})

describe('what is on a day', () => {
  test('an all-day event is on every day it covers, and an evening that runs past midnight is on both days', () => {
    const offsite = event({ id: 'off', title: 'Offsite', allDay: true, startDate: '2026-11-05', endDate: '2026-11-06', start: la('2026-11-05T08:00:00Z'), end: la('2026-11-07T08:00:00Z') })
    const late = event({ id: 'late', title: 'Late call', start: la('2026-11-06T06:00:00Z'), end: la('2026-11-06T09:00:00Z') }) // 10 PM to 1 AM
    const by = byDay(itemsOf([offsite, late], []), ['2026-11-05', '2026-11-06', '2026-11-07'], ZONE)
    expect(by.get('2026-11-05')?.map((i) => (i.kind === 'event' ? i.event.id : ''))).toEqual(['off', 'late'])
    expect(by.get('2026-11-06')?.map((i) => (i.kind === 'event' ? i.event.id : ''))).toEqual(['off', 'late'])
    expect(by.get('2026-11-07')).toEqual([])
  })

  test('an all-day event comes first in its day, then by time', () => {
    const a = event({ id: 'a', title: 'B', start: la('2026-11-05T16:00:00Z'), end: la('2026-11-05T17:00:00Z') })
    const b = event({ id: 'b', title: 'A', start: la('2026-11-05T15:00:00Z'), end: la('2026-11-05T16:00:00Z') })
    const c = event({ id: 'c', title: 'Day', allDay: true, startDate: '2026-11-05', endDate: '2026-11-05', start: la('2026-11-05T08:00:00Z'), end: la('2026-11-06T08:00:00Z') })
    expect(byDay(itemsOf([a, b, c], []), ['2026-11-05'], ZONE).get('2026-11-05')?.map((i) => (i.kind === 'event' ? i.event.id : ''))).toEqual(['c', 'b', 'a'])
  })

  test('a booked meeting is drawn 30 minutes long', () => {
    const items = itemsOf([], [{ id: 'm1', title: 'Intro call', startsAt: la('2026-11-05T18:00:00Z'), link: 'https://meet.example/x', with: [] }])
    const [p] = placeDay(items, '2026-11-05', ZONE)
    expect([p?.top, p?.span]).toEqual([10 * 60, 30])
  })

  test('a cell shows three things, or two and "+N more" past three', () => {
    expect(cellSplit([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 })
    expect(cellSplit([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], more: 3 })
    expect(cellSplit([])).toEqual({ shown: [], more: 0 })
  })

  test('times read short on a chip', () => {
    expect(shortClock(la('2026-11-05T17:00:00Z'), ZONE)).toBe('9a')
    expect(shortClock(la('2026-11-05T22:30:00Z'), ZONE)).toBe('2:30p')
    expect(shortClock(la('2026-11-05T20:00:00Z'), ZONE)).toBe('12p')
  })
})

describe('a day’s column', () => {
  test('places a block by the clock on the wall and cuts one that crosses midnight at the day’s edge', () => {
    const late = event({ id: 'late', start: la('2026-11-06T06:00:00Z'), end: la('2026-11-06T09:00:00Z') }) // 10 PM Thursday to 1 AM Friday
    const items = itemsOf([late], [])
    const thu = placeDay(items, '2026-11-05', ZONE)[0]
    const fri = placeDay(items, '2026-11-06', ZONE)[0]
    expect([thu?.top, thu?.top === undefined ? 0 : thu.top + (thu?.span ?? 0)]).toEqual([22 * 60, 24 * 60])
    expect([fri?.top, fri?.span]).toEqual([0, 60])
  })

  test('a short event is given the least height, but never past the end of the day', () => {
    const quick = event({ id: 'q', start: la('2026-11-05T17:00:00Z'), end: la('2026-11-05T17:10:00Z') })
    const edge = event({ id: 'e', start: la('2026-11-06T07:50:00Z'), end: la('2026-11-06T07:55:00Z') }) // 11:50 PM
    expect(placeDay(itemsOf([quick], []), '2026-11-05', ZONE)[0]?.span).toBe(30)
    const e = placeDay(itemsOf([edge], []), '2026-11-05', ZONE)[0]
    expect((e?.top ?? 0) + (e?.span ?? 0)).toBe(24 * 60)
  })

  test('overlapping blocks share the width and the others keep all of it', () => {
    const at = (id: string, from: string, to: string) => event({ id, start: la(from), end: la(to) })
    const items = itemsOf(
      [
        at('a', '2026-11-05T17:00:00Z', '2026-11-05T18:00:00Z'), // 9 to 10
        at('b', '2026-11-05T17:15:00Z', '2026-11-05T18:15:00Z'), // 9:15 to 10:15
        at('c', '2026-11-05T17:30:00Z', '2026-11-05T18:00:00Z'), // 9:30 to 10
        at('d', '2026-11-05T18:15:00Z', '2026-11-05T19:00:00Z'), // 10:15 to 11, alone
      ],
      [],
    )
    const by = Object.fromEntries(placeDay(items, '2026-11-05', ZONE).map((p) => [p.item.kind === 'event' ? p.item.event.id : '', [p.col, p.cols]]))
    expect(by).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], d: [0, 1] })
  })

  test('a block reuses the first column that is free again', () => {
    expect(
      shareWidth([
        { start: 0, end: 60 },
        { start: 30, end: 90 },
        { start: 60, end: 120 },
      ]),
    ).toEqual([
      { col: 0, cols: 2 },
      { col: 1, cols: 2 },
      { col: 0, cols: 2 },
    ])
    expect(shareWidth([])).toEqual([])
  })

  test('the line for now is at the hour on the wall', () => {
    expect(minutesOnTheWall(la('2026-11-05T23:30:00Z'), ZONE)).toBe(15 * 60 + 30)
  })
})
