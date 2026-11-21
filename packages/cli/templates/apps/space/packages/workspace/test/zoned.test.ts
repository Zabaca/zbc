import { describe, expect, test } from 'bun:test'
import { CLOCKS_KEPT, clocksKept, isoAt, momentAt, wallAt } from '../src'

// The zone's clock (src/zoned.ts) is read through a formatter kept for each zone, and the map of them is bounded, because a zone name also comes from outside (an email's calendar attachment, in any capitalisation).
describe('the zone clock’s formatters', () => {
  const at = Date.UTC(2026, 10, 6, 18, 0)

  test('many spellings of zone names leave no more than the bound kept, and every reading stays right as it turns over', () => {
    const spellings: string[] = []
    // Capitalisation variants of real zones: each is a distinct key, and each is accepted.
    for (const zone of ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney']) {
      for (let mask = 0; mask < 64; mask++) spellings.push([...zone].map((c, i) => ((mask >> (i % 6)) & 1 ? c.toUpperCase() : c.toLowerCase())).join(''))
    }
    const distinct = [...new Set(spellings)]
    expect(distinct.length).toBeGreaterThan(CLOCKS_KEPT * 2)
    const expected = (zone: string) => (/los_angeles/i.test(zone) ? 10 : /london/i.test(zone) ? 18 : /tokyo/i.test(zone) ? 3 : 5)
    for (const zone of distinct) {
      expect(clocksKept()).toBeLessThanOrEqual(CLOCKS_KEPT)
      const w = wallAt(at, zone)
      // Hour of 18:00 UTC in each: Los Angeles 10, London 18, Tokyo 03 the next day, Sydney 05 the next day.
      expect(w.h).toBe(expected(zone))
    }
    expect(clocksKept()).toBeLessThanOrEqual(CLOCKS_KEPT)
    expect(clocksKept()).toBeGreaterThan(0)
  })

  test('after the map turns over the same zone reads the same, and the arithmetic built on it is unchanged', () => {
    const zone = 'America/Los_Angeles'
    const before = wallAt(at, zone)
    // Enough other spellings to turn the map over at least once.
    for (let mask = 0; mask < CLOCKS_KEPT + 5; mask++) wallAt(at, [...'Europe/London'].map((c, i) => ((mask >> (i % 7)) & 1 ? c.toUpperCase() : c)).join(''))
    expect(clocksKept()).toBeLessThanOrEqual(CLOCKS_KEPT)
    expect(wallAt(at, zone)).toEqual(before)
    expect(isoAt(at, zone)).toBe('2026-11-06T10:00:00-08:00')
    expect(momentAt(2026, 11, 6, 10, 0, zone)).toBe(at)
  })
})
