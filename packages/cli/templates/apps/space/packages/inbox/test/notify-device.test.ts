import { describe, expect, test } from 'bun:test'
import { outcomeOf } from '../src/notify/deliver'
import { checkDevice, deviceLabel, isPushEndpoint, UNKNOWN_PUSH_SERVICE } from '../src/notify/device'
import { newDevice } from '../test-support/push-device'

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
    // An app on an iPhone's or iPad's Home Screen has no Safari/ or Version/ mark; Mobile/<build> is what names it. An iPad says Macintosh, as it has since iPadOS 13.
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Safari on iPadOS',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
      'Safari on iPadOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome on iOS',
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

describe('which push services the inbox sends to', () => {
  const good = [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://web.push.apple.com/QGPb8-xyz',
    'https://WEB.PUSH.APPLE.COM/QGPb8-xyz',
  ]
  const bad = [
    // Apple's look-alikes: a name that only ends the same way, the bare domain, another label after it, a trailing dot.
    'https://evilpush.apple.com/x',
    'https://web.push.apple.com.example.test/x',
    'https://push.apple.com/x',
    'https://web.push.apple.com./x',
    'https://web.push.apple.com@evil.test/x',
    'https://user@web.push.apple.com/x',
    'https://:secret@web.push.apple.com/x',
    'https://web.push.apple.com:8443/x',
    'http://web.push.apple.com/x',
    'https://apple.com/x',
    'https://web.push.apple.test/x',
    // Chrome's, as before.
    'https://fcm.googleapis.com.evil.test/x',
    'https://fcm.googleapis.com:8443/x',
    'http://fcm.googleapis.com/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'not a url',
    '',
  ]
  test('Chrome’s and Apple’s, over https, and nothing that only looks like them', () => {
    for (const endpoint of good) expect([endpoint, isPushEndpoint(endpoint)]).toEqual([endpoint, true])
    for (const endpoint of bad) expect([endpoint, isPushEndpoint(endpoint)]).toEqual([endpoint, false])
  })

  test('a device is added only at one of them, with the browser’s keys', async () => {
    const apple = await newDevice('x', 'apple')
    expect(checkDevice({ endpoint: apple.endpoint, keys: apple.keys })).toEqual({
      ok: true,
      value: { endpoint: apple.endpoint, p256dh: apple.keys.p256dh, auth: apple.keys.auth },
    })
    for (const endpoint of bad.filter((e) => e !== '' && e !== 'not a url')) {
      expect([endpoint, checkDevice({ endpoint, keys: apple.keys })]).toEqual([
        endpoint,
        { ok: false, error: UNKNOWN_PUSH_SERVICE },
      ])
    }
  })

  test('what a refused browser is told names Safari on an iPhone or iPad as well as Chrome', () => {
    expect(UNKNOWN_PUSH_SERVICE).toContain('Chrome on Android or the Mac')
    expect(UNKNOWN_PUSH_SERVICE).toContain('Safari on an iPhone or iPad')
  })
})
