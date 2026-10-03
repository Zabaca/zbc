import { describe, expect, test } from 'bun:test'
import { DEFAULT_SLEEP_AFTER, sleepAfterFrom, sleepAfterMsFrom } from '../shared/sleep-after'

describe('sleepAfterFrom', () => {
  test('takes a duration the library understands', () => {
    for (const value of ['5m', '90s', '1h', ' 10m ']) {
      expect(sleepAfterFrom({ WALGIT_SLEEP_AFTER: value })).toBe(value.trim())
    }
  })

  test('falls back to the default when unset, blank or malformed', () => {
    for (const value of [undefined, '', '0m', '5', '5 m', '5min', '-5m', '1d']) {
      expect(sleepAfterFrom({ WALGIT_SLEEP_AFTER: value })).toBe(DEFAULT_SLEEP_AFTER)
    }
  })
})

describe('sleepAfterMsFrom', () => {
  test('is the same choice in milliseconds', () => {
    expect(sleepAfterMsFrom({ WALGIT_SLEEP_AFTER: '90s' })).toBe(90_000)
    expect(sleepAfterMsFrom({ WALGIT_SLEEP_AFTER: '5m' })).toBe(5 * 60_000)
    expect(sleepAfterMsFrom({ WALGIT_SLEEP_AFTER: '1h' })).toBe(60 * 60_000)
  })

  test('a value sleepAfterFrom ignores is ignored here too', () => {
    expect(sleepAfterMsFrom({ WALGIT_SLEEP_AFTER: '5min' })).toBe(20 * 60_000)
    expect(sleepAfterMsFrom({})).toBe(20 * 60_000)
  })
})
