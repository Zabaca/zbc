import { bytesOf } from './base64url'

/**
 * A device as a browser hands it over when the owner turns notifications on, checked before anything is kept: the push
 * service address and the browser's two keys, and the
 * label the device is listed by.
 *
 * ── WHICH PUSH SERVICES ──────────────────────────────────────────────────
 * Chrome's (fcm.googleapis.com, on Android and on desktop alike) and Apple's (a host under push.apple.com, which is
 * where Safari on an iPhone, an iPad and a Mac sends: web.push.apple.com today), over https. The address is one the
 * request supplied, and the Worker later sends to it, so anything else is refused: the Worker never calls an address
 * a request chose. Apple's is matched as a subdomain of push.apple.com (a dot before it), so a look-alike such as
 * `evilpush.apple.com` or `web.push.apple.com.example` is not one. Firefox's would be added the same way.
 */

/** Push services that are one host, matched exactly. */
export const PUSH_SERVICE_HOSTS: readonly string[] = ['fcm.googleapis.com']

/** Push services that are a domain, matched as any host under it (never the bare domain, never a longer name that merely ends the same way). */
export const PUSH_SERVICE_DOMAINS: readonly string[] = ['push.apple.com']

/** What the inbox says to a browser whose push service is not on the list. */
export const UNKNOWN_PUSH_SERVICE =
  'This browser’s notifications go through a service the inbox does not send to. Use Chrome on Android or the Mac, or Safari on an iPhone or iPad with the space added to the Home Screen.'

/** Whether a host name (as `URL.hostname` gives it: lower case) is a push service the inbox sends to. */
export const isPushServiceHost = (hostname: string): boolean =>
  PUSH_SERVICE_HOSTS.includes(hostname) || PUSH_SERVICE_DOMAINS.some((domain) => hostname.endsWith(`.${domain}`))

/**
 * Whether an address is one the Worker may send to: https, a push service's host, the default port and no credentials.
 * Asked when a device is added and again at every send, so nothing stored can make the Worker call another address.
 */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    isPushServiceHost(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

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
  try {
    new URL(endpoint)
  } catch {
    return {
      ok: false,
      error: 'Send the device as the browser gives it: {"endpoint": ..., "keys": {"p256dh": ..., "auth": ...}}.',
    }
  }
  if (!isPushEndpoint(endpoint)) return { ok: false, error: UNKNOWN_PUSH_SERVICE }
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

/**
 * Browsers and systems by the mark each leaves in a User-Agent, the first that matches naming it (Edge says Chrome too).
 * An app added to an iPhone's or an iPad's Home Screen carries no `Safari/` or `Version/` mark, only `Mobile/<build>`, which
 * Chrome on Android (`Mobile Safari`) and every Mac browser lack; so that alone, after the others, is Safari.
 */
const BROWSERS: [RegExp, string][] = [
  [/Edg\/|EdgiOS\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/Mobile\//, 'Safari'],
]
/** An iPad has said Macintosh since iPadOS 13; in its Home Screen app the `Mobile/` mark is what tells it from a Mac. */
const IPAD_AS_MAC = /Macintosh.*Mobile\//
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPad/, 'iPadOS'],
  [IPAD_AS_MAC, 'iPadOS'],
  [/iPhone|iPod/, 'iOS'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

/**
 * The name a device is listed by, from the User-Agent of the browser that turned notifications on: "Chrome on
 * Android", "Chrome on macOS", "Safari on iOS", "Safari on iPadOS". Only a label for a person to tell their devices apart; nothing is decided by it.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? ''
  const browser = BROWSERS.find(([mark]) => mark.test(ua))?.[1] ?? 'A browser'
  const system = SYSTEMS.find(([mark]) => mark.test(ua))?.[1]
  return system === undefined ? browser : `${browser} on ${system}`
}
