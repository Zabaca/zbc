import { bytesOf } from './base64url'

/**
 * A device as a browser hands it over when the owner turns notifications on, checked before anything is kept: the push
 * service address and the browser's two keys, and the
 * label the device is listed by.
 *
 * ── WHICH PUSH SERVICES ──────────────────────────────────────────────────
 * Only Chrome's (fcm.googleapis.com, on Android and on desktop alike), over https. The address is one the request
 * supplied, and the Worker later sends to it, so anything else is refused: the Worker never calls an address a request
 * chose. Safari or Firefox later is adding their push service's host here.
 */

export const PUSH_SERVICE_HOSTS: readonly string[] = ['fcm.googleapis.com']

/** What the inbox says to a browser whose push service is not on the list. */
export const UNKNOWN_PUSH_SERVICE =
  'This browser’s notifications go through a service the inbox does not send to. Use Chrome, on Android or the Mac.'

/** The longest push address kept. Chrome's are a few hundred characters. */
const MAX_ENDPOINT = 1024

export interface DeviceInput {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * A device as the browser hands it over (`PushSubscription.toJSON()`: `{ endpoint, keys: { p256dh, auth } }`), checked:
 * an https address on a push service the inbox sends to, a 65-byte uncompressed P-256 key and a 16-byte secret.
 */
export function checkDevice(
  body: Record<string, unknown>,
): { ok: true; value: DeviceInput } | { ok: false; error: string } {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const keys = body.keys !== null && typeof body.keys === 'object' ? (body.keys as Record<string, unknown>) : {}
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return {
      ok: false,
      error: 'Send the device as the browser gives it: {"endpoint": ..., "keys": {"p256dh": ..., "auth": ...}}.',
    }
  }
  if (url.protocol !== 'https:' || !PUSH_SERVICE_HOSTS.includes(url.hostname) || url.port !== '' || url.username !== '')
    return { ok: false, error: UNKNOWN_PUSH_SERVICE }
  if (endpoint.length > MAX_ENDPOINT) return { ok: false, error: 'That push address is longer than any browser’s.' }
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : ''
  const auth = typeof keys.auth === 'string' ? keys.auth : ''
  const pub = bytesOf(p256dh)
  const secret = bytesOf(auth)
  if (pub?.length !== 65 || pub[0] !== 4 || secret?.length !== 16) {
    return { ok: false, error: 'The device’s keys are not the ones a browser gives for notifications.' }
  }
  return { ok: true, value: { endpoint, p256dh, auth } }
}

/** Browsers and systems by the mark each leaves in a User-Agent, the first that matches naming it (Edge says Chrome too). */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

/**
 * The name a device is listed by, from the User-Agent of the browser that turned notifications on: "Chrome on
 * Android", "Chrome on macOS". Only a label for a person to tell their devices apart; nothing is decided by it.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? ''
  const browser = BROWSERS.find(([mark]) => mark.test(ua))?.[1] ?? 'A browser'
  const system = SYSTEMS.find(([mark]) => mark.test(ua))?.[1]
  return system === undefined ? browser : `${browser} on ${system}`
}
