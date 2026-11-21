// What the booking page does with moments (booking/src/time.ts): the days of a month for a grid, a time drawn in a zone, and which page a path is. All pure, so literal moments in any zone.
import { describe, expect, test } from 'bun:test'
import { BOOKING_RESERVED_SLUGS } from '@space/workspace'
import { RESERVED, routeOf } from '../booking/src/App'
import { byDay, clock, dayKey, isZone, monthCells, monthOf, stepMonth, weekdayNames, zoneLabel, zonesOf } from '../booking/src/time'

describe('the days of a month', () => {
  test('a month is whole weeks of seven, from the first day of the week, with the days of the month marked', () => {
    // November 2026 begins on a Sunday and has 30 days.
    const sunday = monthCells(2026, 11, true)
    expect(sunday).toHaveLength(35)
    expect(sunday[0]).toEqual({ key: '2026-11-01', day: 1, inMonth: true })
    expect(sunday.filter((c) => c.inMonth)).toHaveLength(30)
    expect(sunday[34]).toEqual({ key: '2026-12-05', day: 5, inMonth: false })
    // With the week beginning on Monday the first is the last cell of its row, and the row before it is October's.
    const monday = monthCells(2026, 11, false)
    expect(monday[0]).toEqual({ key: '2026-10-26', day: 26, inMonth: false })
    expect(monday[6]).toEqual({ key: '2026-11-01', day: 1, inMonth: true })
    expect(monday.length % 7).toBe(0)
    // February of a leap year.
    expect(monthCells(2028, 2, true).filter((c) => c.inMonth)).toHaveLength(29)
  })

  test('months step across a year, and a day names its month', () => {
    expect(stepMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(stepMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(monthOf('2026-11-05')).toEqual({ year: 2026, month: 11 })
  })

  test('the week is named from its first day', () => {
    expect(weekdayNames(true)[0]).toMatch(/^Sun/)
    expect(weekdayNames(false)[0]).toMatch(/^Mon/)
    expect(weekdayNames(true)).toHaveLength(7)
  })
})

describe('moments in a zone', () => {
  const t = Date.UTC(2026, 10, 6, 18, 0)

  test('a moment is on the day the zone’s clock says, and times are grouped by that day in order', () => {
    expect(dayKey(t, 'America/Los_Angeles')).toBe('2026-11-06')
    expect(dayKey(t, 'Pacific/Auckland')).toBe('2026-11-07')
    const days = byDay([t + 3_600_000, t, Date.UTC(2026, 10, 7, 20, 0)], 'America/Los_Angeles')
    expect([...days.keys()]).toEqual(['2026-11-06', '2026-11-07'])
    expect(days.get('2026-11-06')).toEqual([t, t + 3_600_000])
    // The same moments in another zone are on other days.
    expect([...byDay([t, t + 8 * 3_600_000], 'Pacific/Auckland').keys()]).toEqual(['2026-11-07'])
  })

  test('a time of day is drawn on the zone’s clock', () => {
    expect(clock(t, 'America/Los_Angeles')).toMatch(/10:00.AM/)
    expect(clock(t, 'Asia/Calcutta')).toMatch(/11:30.PM/)
  })

  test('a zone is named once beside a time, and a zone the browser does not know is no zone', () => {
    expect(zoneLabel(t, 'America/Los_Angeles')).toBe('PST, America / Los Angeles')
    expect(zoneLabel(t, 'UTC')).toBe('UTC')
    expect(isZone('America/Los_Angeles')).toBe(true)
    for (const bad of ['', 'Mars/Olympus', '<script>', 'America/Los_Angeles; drop']) expect(isZone(bad)).toBe(false)
    expect(zonesOf(['Europe/London', 'America/Los_Angeles'])[0]).toBe('Europe/London')
    expect(new Set(zonesOf(['America/Los_Angeles'])).size).toBe(zonesOf(['America/Los_Angeles']).length)
  })
})

describe('which page a path is', () => {
  test('a link’s page, a booking’s own, and nothing else', () => {
    expect(routeOf('/book/intro-call')).toEqual({ kind: 'link', slug: 'intro-call' })
    expect(routeOf('/book/intro-call/')).toEqual({ kind: 'link', slug: 'intro-call' })
    expect(routeOf('/book/manage/abc123def456')).toEqual({ kind: 'manage', secret: 'abc123def456' })
    expect([...RESERVED]).toEqual([...BOOKING_RESERVED_SLUGS])
    for (const other of ['/', '/book', '/book/', '/today', '/book/a/b/c', '/book/manage', '/books/x', '/book/%E0%A4%A']) expect([other, routeOf(other).kind]).toEqual([other, 'none'])
  })
})
