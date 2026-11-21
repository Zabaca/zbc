import { describe, expect, test } from 'bun:test'
import { BOOKING_DEFAULTS, type BookingHours, type BookingRules, wallAt } from '@space/workspace'
import { dayOf, slotStarts, slotStepMinutes } from '../src/booking-slots'
import { DAY, HOUR, T0, ZONE } from '../test-support/harness'

/**
 * The starting times a booking link offers (the space's ADR 0025), as a pure function of the link's rules, the clock and what is busy: no store, so every case is literal rows. The clock starts on Thursday 5 November 2026 at noon in Los Angeles.
 */

const MIN = 60_000
const rules = (over: Partial<BookingRules> = {}): BookingRules => ({ ...BOOKING_DEFAULTS, ...over })
const none: BookingHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
/** A wall time on the company's clock, as a moment. */
const la = (y: number, m: number, d: number, h: number, mi = 0) => {
  // Built from the zone's own clock by search, so a test never repeats the library's arithmetic.
  for (let t = Date.UTC(y, m - 1, d, 0, 0) - 12 * HOUR; t < Date.UTC(y, m - 1, d, 23, 0) + 14 * HOUR; t += MIN) {
    const w = wallAt(t, ZONE)
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi) return t
  }
  throw new Error('no such time')
}
const wall = (ms: number, zone = ZONE) => {
  const w = wallAt(ms, zone)
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`
}
const q = (over: Partial<Parameters<typeof slotStarts>[0]> = {}) => ({ rules: rules(), minutes: 30, now: T0, zone: ZONE, busy: [], taken: [], ...over })

describe('the hours, the notice and the window', () => {
  test('with the defaults the rest of Thursday after four hours’ notice and every half hour of Friday, and no weekend', () => {
    const got = slotStarts(q({ rules: rules({ aheadDays: 6 }) })).map((t) => wall(t))
    expect(got.slice(0, 2)).toEqual(['2026-11-05 16:00', '2026-11-05 16:30'])
    // Friday 9:00 to 16:30 is sixteen starts of a half hour.
    const friday = got.filter((t) => t.startsWith('2026-11-06'))
    expect(friday).toHaveLength(16)
    expect(friday[0]).toBe('2026-11-06 09:00')
    expect(friday[15]).toBe('2026-11-06 16:30')
    expect(got.some((t) => t.startsWith('2026-11-07') || t.startsWith('2026-11-08'))).toBe(false)
    expect(got.some((t) => t.startsWith('2026-11-09'))).toBe(true)
  })

  test('a meeting must END by the close of the hours: a 45 minute meeting last starts at 16:00 when the day closes at 17:00 on a half-hour step', () => {
    const got = slotStarts(q({ minutes: 45 })).map((t) => wall(t)).filter((t) => t.startsWith('2026-11-06'))
    expect(got.at(-1)).toBe('2026-11-06 16:00')
    expect(got[0]).toBe('2026-11-06 09:00')
  })

  test('a meeting shorter than half an hour is offered every quarter, and a meeting longer than the span is never offered', () => {
    expect(slotStepMinutes(20)).toBe(15)
    expect(slotStepMinutes(30)).toBe(30)
    expect(slotStepMinutes(90)).toBe(30)
    const quarters = slotStarts(q({ minutes: 20 })).map((t) => wall(t)).filter((t) => t.startsWith('2026-11-06'))
    expect(quarters.slice(0, 3)).toEqual(['2026-11-06 09:00', '2026-11-06 09:15', '2026-11-06 09:30'])
    expect(slotStarts(q({ minutes: 240, rules: rules({ hours: { ...none, fri: [{ from: 540, to: 660 }] } }) }))).toEqual([])
  })

  test('the least notice moves the first time later, and the window ahead ends the last', () => {
    const next = slotStarts(q({ rules: rules({ noticeMinutes: 24 * 60 }) })).map((t) => wall(t))
    expect(next[0]).toBe('2026-11-06 12:00')
    const short = slotStarts(q({ rules: rules({ aheadDays: 2 }) })).map((t) => wall(t))
    expect(short.every((t) => t < '2026-11-08')).toBe(true)
    expect(short.some((t) => t.startsWith('2026-11-06'))).toBe(true)
    // Not a minute past the window: nothing starts after now plus the days ahead.
    expect(Math.max(...slotStarts(q({ rules: rules({ aheadDays: 3 }) })))).toBeLessThanOrEqual(T0 + 3 * DAY)
  })

  test('several spans in a day, each weekday its own', () => {
    const hours: BookingHours = { ...none, fri: [{ from: 780, to: 960 }, { from: 540, to: 720 }], mon: [{ from: 600, to: 660 }] }
    const got = slotStarts(q({ rules: rules({ hours }), minutes: 60 })).map((t) => wall(t))
    expect(got.filter((t) => t.startsWith('2026-11-06'))).toEqual(['2026-11-06 09:00', '2026-11-06 09:30', '2026-11-06 10:00', '2026-11-06 10:30', '2026-11-06 11:00', '2026-11-06 13:00', '2026-11-06 13:30', '2026-11-06 14:00', '2026-11-06 14:30', '2026-11-06 15:00'])
    expect(got.filter((t) => t.startsWith('2026-11-09'))).toEqual(['2026-11-09 10:00'])
  })

  test('the hours are on the company’s clock, whatever zone a visitor is in', () => {
    // In Kolkata the same rules mean 09:00 there: the moment is five and a half hours before the UTC wall.
    const got = slotStarts(q({ zone: 'Asia/Kolkata', now: Date.UTC(2026, 10, 5, 0, 0) }))
    const first = got.find((t) => wall(t, 'Asia/Kolkata').startsWith('2026-11-06'))
    expect(wall(first as number, 'Asia/Kolkata')).toBe('2026-11-06 09:00')
    expect(first).toBe(Date.UTC(2026, 10, 6, 3, 30))
  })
})

describe('what is busy', () => {
  const friday10 = la(2026, 11, 6, 10)

  test('a busy stretch takes its time and the gap on both sides: with a quarter hour around it 9:30 and 11:00 go and 9:00 and 11:30 stay', () => {
    const got = slotStarts(q({ busy: [{ start: friday10, end: friday10 + HOUR }] })).map((t) => wall(t)).filter((t) => t.startsWith('2026-11-06'))
    expect(got).not.toContain('2026-11-06 09:30')
    expect(got).not.toContain('2026-11-06 10:00')
    expect(got).not.toContain('2026-11-06 10:30')
    expect(got).not.toContain('2026-11-06 11:00')
    expect(got).toContain('2026-11-06 09:00')
    expect(got).toContain('2026-11-06 11:30')
  })

  test('with no gap a meeting may touch another', () => {
    const got = slotStarts(q({ rules: rules({ gapMinutes: 0 }), busy: [{ start: friday10, end: friday10 + HOUR }] })).map((t) => wall(t)).filter((t) => t.startsWith('2026-11-06'))
    expect(got).toContain('2026-11-06 09:30')
    expect(got).toContain('2026-11-06 11:00')
    expect(got).not.toContain('2026-11-06 10:30')
  })

  test('an all-day event takes its whole day, and the next day is untouched', () => {
    const got = slotStarts(q({ busy: [{ start: la(2026, 11, 6, 0), end: la(2026, 11, 7, 0) }] })).map((t) => wall(t))
    expect(got.filter((t) => t.startsWith('2026-11-06'))).toEqual([])
    expect(got.some((t) => t.startsWith('2026-11-09'))).toBe(true)
  })

  test('busy stretches that overlap, touch or come in any order are all kept apart from', () => {
    const busy = [
      { start: la(2026, 11, 6, 14), end: la(2026, 11, 6, 15) },
      { start: la(2026, 11, 6, 10), end: la(2026, 11, 6, 11) },
      { start: la(2026, 11, 6, 10, 30), end: la(2026, 11, 6, 12) },
    ]
    const got = slotStarts(q({ rules: rules({ gapMinutes: 0 }), busy })).map((t) => wall(t)).filter((t) => t.startsWith('2026-11-06'))
    expect(got).toEqual(['2026-11-06 09:00', '2026-11-06 09:30', '2026-11-06 12:00', '2026-11-06 12:30', '2026-11-06 13:00', '2026-11-06 13:30', '2026-11-06 15:00', '2026-11-06 15:30', '2026-11-06 16:00', '2026-11-06 16:30'])
  })
})

describe('the most in a day', () => {
  test('a day that holds its limit offers nothing, and the other days are unaffected', () => {
    const taken = [la(2026, 11, 6, 9), la(2026, 11, 6, 13)]
    const got = slotStarts(q({ rules: rules({ perDay: 2 }), taken })).map((t) => wall(t))
    expect(got.filter((t) => t.startsWith('2026-11-06'))).toEqual([])
    expect(got.some((t) => t.startsWith('2026-11-09'))).toBe(true)
    // One short of the limit, the day is still offered.
    expect(slotStarts(q({ rules: rules({ perDay: 3 }), taken })).map((t) => wall(t)).some((t) => t.startsWith('2026-11-06'))).toBe(true)
  })

  test('a day is the company’s day: a booking at 17:00 on Thursday evening in Los Angeles is on Thursday although it is Friday in UTC', () => {
    expect(dayOf(la(2026, 11, 5, 17), ZONE)).toBe('2026-11-05')
    expect(new Date(la(2026, 11, 5, 17)).toISOString().startsWith('2026-11-06')).toBe(true)
  })
})

describe('the days the clocks change', () => {
  const sunday: BookingHours = { ...none, sun: [{ from: 0, to: 360 }] }

  test('the night the clocks go forward (Los Angeles, 8 March 2026) a time the clocks skip is not offered: 02:00 and 02:30 do not exist', () => {
    const got = slotStarts(q({ rules: rules({ hours: sunday, noticeMinutes: 0, aheadDays: 9 }), now: la(2026, 3, 6, 12) })).map((t) => wall(t)).filter((t) => t.startsWith('2026-03-08'))
    expect(got).toEqual(['2026-03-08 00:00', '2026-03-08 00:30', '2026-03-08 01:00', '2026-03-08 01:30', '2026-03-08 03:00', '2026-03-08 03:30', '2026-03-08 04:00', '2026-03-08 04:30', '2026-03-08 05:00', '2026-03-08 05:30'])
  })

  test('the night the clocks go back (Los Angeles, 1 November 2026) each time is offered once, the first time the clock shows it, and in order', () => {
    const starts = slotStarts(q({ rules: rules({ hours: sunday, noticeMinutes: 0, aheadDays: 4 }), now: la(2026, 10, 30, 12) }))
    const got = starts.filter((t) => wall(t).startsWith('2026-11-01'))
    expect(got.map((t) => wall(t))).toEqual(['2026-11-01 00:00', '2026-11-01 00:30', '2026-11-01 01:00', '2026-11-01 01:30', '2026-11-01 02:00', '2026-11-01 02:30', '2026-11-01 03:00', '2026-11-01 03:30', '2026-11-01 04:00', '2026-11-01 04:30', '2026-11-01 05:00', '2026-11-01 05:30'])
    // 01:30 is the first one (daylight time, 08:30 UTC), and 02:00 is standard time an hour and a half later.
    expect(got[3]).toBe(Date.UTC(2026, 10, 1, 8, 30))
    expect(got[4]).toBe(Date.UTC(2026, 10, 1, 10, 0))
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  test('a busy stretch is real time: a meeting that crosses the change takes its real length', () => {
    // 01:30 PDT to 02:30 PST is two real hours on 1 November (the hour from 01:00 to 02:00 happens twice): the times inside it go, the times either side stay.
    const busy = [{ start: Date.UTC(2026, 10, 1, 8, 30), end: Date.UTC(2026, 10, 1, 10, 30) }]
    const got = slotStarts(q({ rules: rules({ hours: sunday, noticeMinutes: 0, aheadDays: 4, gapMinutes: 0 }), now: la(2026, 10, 30, 12), busy })).filter((t) => wall(t).startsWith('2026-11-01')).map((t) => wall(t))
    expect(got).not.toContain('2026-11-01 01:30')
    expect(got).not.toContain('2026-11-01 02:00')
    expect(got).toContain('2026-11-01 02:30')
    expect(got).toContain('2026-11-01 01:00')
  })
})
