import { describe, expect, test } from 'bun:test'
import { outcomeOf } from '../src/notify/deliver'
import { deviceLabel } from '../src/notify/device'

/** The device's label from a User-Agent, and what each answer of a push service means: pure, as tables. */

describe('the label a device is listed by', () => {
  const table: [string, string][] = [
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge on Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari on macOS',
    ],
    ['', 'A browser'],
  ]
  for (const [ua, label] of table) {
    test(label, () => {
      expect(deviceLabel(ua)).toBe(label)
    })
  }
  test('no User-Agent at all', () => {
    expect(deviceLabel(null)).toBe('A browser')
  })
})

describe('what an answer of the push service means', () => {
  test('in one place, for every status the option names', () => {
    expect([201, 202, 200].map(outcomeOf)).toEqual(['delivered', 'delivered', 'delivered'])
    expect([404, 410].map(outcomeOf)).toEqual(['gone', 'gone'])
    expect([400, 401, 403].map(outcomeOf)).toEqual(['refused', 'refused', 'refused'])
    expect(outcomeOf(413)).toBe('too-large')
    expect([429, 500, 502, 503, 301, null].map(outcomeOf)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ])
  })
})
