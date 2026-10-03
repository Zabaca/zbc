import { describe, expect, test } from 'bun:test'
import { DEFAULT_SLEEP_AFTER, sleepAfterFrom } from '../shared/sleep-after'

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
