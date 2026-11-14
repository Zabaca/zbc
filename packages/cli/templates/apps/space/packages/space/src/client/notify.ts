// Notifications from the page's side: what Settings says about the browser it runs in, turning notifications on and off in that browser, and the page's half of
// the conversation with the service worker (sw.ts): which person's conversation is open, open this path, read the lists again.
//
// The sender is the INBOX's (a device's notifications are tied to one sender's key, and the space turns them on with the inbox's public key): the space only
// subscribes this browser and hands the subscription to the inbox, which marks it as the space's, so a tap opens the conversation here. The decisions are pure
// functions, tested under bun (test/notify.test.ts). The browser's push and notification calls are the glue: the hand test watches them work.

import { useEffect, useRef } from 'react'
import type { InboxDevice, InboxNotifications } from '@space/workspace'
import { postView } from './views'

/** What the page and the service worker say to each other: the page's copy of sw-push.ts `MESSAGES`, written twice because sw.js imports nothing, and held equal by test. */
export const WINDOW_MESSAGES = {
  ask: 'space:which-conversation',
  open: 'space:open',
  refresh: 'space:refresh',
} as const

/**
 * Where this browser stands, in the order Settings checks it:
 *   `add-to-home-screen`  an iPhone's or iPad's Safari tab, which has no push or notifications at all (the app added to the Home Screen has both, from iOS 16.4): the page says how to add it;
 *   `unsupported`  it has no service worker, push or notifications at all, and the page is not in such a tab (an iPhone or iPad before iOS 16.4, or a browser with none);
 *   `blocked`      the system or the person blocked the space's notifications here;
 *   `no-key`       the inbox has no key to send with, so nothing can be turned on;
 *   `stale-key`    this browser turned them on with a key the inbox no longer has: none arrive;
 *   `off`          this browser is no device, or one the inbox does not list (removed from another device);
 *   `failing`      on, and the last notification to it failed after its last delivery;
 *   `on`           on.
 */
export type BrowserState = 'add-to-home-screen' | 'unsupported' | 'blocked' | 'no-key' | 'stale-key' | 'off' | 'failing' | 'on'

/** The Apple device this page runs on, which decides what "add the space to the Home Screen" says. */
export type AppleDevice = 'iPhone' | 'iPad'

/**
 * An iPhone or an iPad from what the browser says of itself, or null for anything else. An iPad has said Macintosh since iPadOS 13 (a request for the desktop
 * site is its default), so it is told from a Mac by its touch screen: no Mac reports more than one touch point.
 */
export function appleDevice(userAgent: string, touchPoints: number): AppleDevice | null {
  if (/iPhone|iPod/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Macintosh/.test(userAgent) && touchPoints > 1) return 'iPad'
  return null
}

export interface BrowserFacts {
  supported: boolean
  permission: 'default' | 'granted' | 'denied'
  /** The inbox's answer. */
  notifications: Pick<InboxNotifications, 'publicKey' | 'devices'>
  /** Set on an iPhone or iPad: which, and whether this page runs as the app added to the Home Screen (where push exists) and not in a Safari tab (where it does not). */
  apple?: { device: AppleDevice; installed: boolean } | null
  /** This browser as a device: its push address and the key it was turned on with (base64url), or null when it is none. */
  thisBrowser: { endpoint: string; key: string | null } | null
}

/** Whether a device's last notification failed after its last delivery: it has stopped, and says why. */
export const failing = (d: Pick<InboxDevice, 'lastFailedAt' | 'lastDeliveredAt'>): boolean => d.lastFailedAt !== null && (d.lastDeliveredAt === null || d.lastFailedAt > d.lastDeliveredAt)

/** The state of this browser, and the device that is this browser when the inbox lists one. */
export function browserState(f: BrowserFacts): { state: BrowserState; device: InboxDevice | null } {
  if (!f.supported) return { state: f.apple && !f.apple.installed ? 'add-to-home-screen' : 'unsupported', device: null }
  if (f.permission === 'denied') return { state: 'blocked', device: null }
  if (f.notifications.publicKey === null) return { state: 'no-key', device: null }
  const sub = f.thisBrowser
  const device = sub === null ? null : (f.notifications.devices.find((d) => d.endpoint === sub.endpoint) ?? null)
  if (sub !== null && sub.key !== null && sub.key !== f.notifications.publicKey) return { state: 'stale-key', device }
  if (device === null) return { state: 'off', device: null }
  return { state: failing(device) ? 'failing' : 'on', device }
}

// ─── the browser ─────────────────────────────────────────────────────────

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...view)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const bytesOf = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  try {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** The bytes of an uncompressed P-256 public key: 0x04, then x and y. What the push service takes as the inbox's key. */
export const SERVER_KEY_BYTES = 65

/** The inbox's key as `pushManager.subscribe` takes it: exactly the 65 bytes of the point, in a buffer of their own, or null when it is no such key. */
export function serverKey(publicKey: string): Uint8Array<ArrayBuffer> | null {
  const bytes = bytesOf(publicKey)
  if (bytes === null || bytes.length !== SERVER_KEY_BYTES || bytes[0] !== 4) return null
  return new Uint8Array(bytes)
}

/** Whether this browser can receive notifications at all. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Whether this page runs as an app added to the Home Screen (or installed from Chrome), not in a browser tab. Safari says so with `navigator.standalone`, everything else with the display mode. */
function installedApp(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
}

/** What this page knows of being on an iPhone or iPad, as `browserState` reads it, or null anywhere else. */
export function appleFacts(): BrowserFacts['apple'] {
  if (typeof navigator === 'undefined') return null
  const device = appleDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  return device === null ? null : { device, installed: installedApp() }
}

export function permission(): BrowserFacts['permission'] {
  return notificationsSupported() ? Notification.permission : 'default'
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!notificationsSupported()) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

const keyOf = (sub: PushSubscription): string | null => {
  const key = sub.options.applicationServerKey
  return key === null ? null : b64url(key)
}

/** This browser's push registration, as `browserState` reads it. */
export async function thisBrowser(): Promise<BrowserFacts['thisBrowser']> {
  const sub = await (await registration())?.pushManager.getSubscription()
  return sub ? { endpoint: sub.endpoint, key: keyOf(sub) } : null
}

export const NOT_ALLOWED = 'Notifications were not allowed on this device, so nothing was turned on.'

/** The worker's one address, at the root so its scope is the whole app. */
export const SERVICE_WORKER = '/sw.js'

/**
 * How the worker is registered: a classic worker in everything built, and a module worker only in `vite dev`, where /sw.js is the source module with its
 * imports. A module service worker's script is fetched WITHOUT cookies (seen in Chromium for the inbox), so behind Access it would meet the sign-in
 * page, which Chrome refuses behind a redirect: registration fails and nothing on screen says why. The build makes sw.js one file that imports nothing.
 */
const SERVICE_WORKER_TYPE: WorkerType = import.meta.env.DEV ? 'module' : 'classic'

export const registerWorker = (): Promise<ServiceWorkerRegistration> => navigator.serviceWorker.register(SERVICE_WORKER, { type: SERVICE_WORKER_TYPE })

/** Registered once the page has loaded, so it never competes with the page's own first requests. A failure is said in Settings, where notifications need it. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    registerWorker().catch((error: unknown) => console.warn('the service worker did not register', error))
  })
}

/** Why the worker cannot run here, in the browser's words, or null when it registers. */
export async function workerProblem(): Promise<string | null> {
  if (!notificationsSupported()) return null
  try {
    await registerWorker()
    return null
  } catch (error) {
    return `The service worker would not start on this device, and notifications need it. The browser said "${browserSaid(error)}".`
  }
}

/**
 * ── TURNING ON, ONE NAMED STEP AT A TIME ─────────────────────────────────
 * Four steps, and the two that wait on the browser alone can wait forever (the worker never becoming ready, the push service never answering). Each is named
 * while it runs, given a limit, and a step that fails says which it was and what the browser said. Asking for permission has no limit (it waits on the person).
 */
export type TurnOnStep = 'permission' | 'worker' | 'address' | 'device'

export const STEP_NAMES: Record<TurnOnStep, string> = {
  permission: 'asking this device to allow notifications',
  worker: 'starting the app’s service worker',
  address: 'getting a push address from the browser',
  device: 'adding this device to the inbox’s list',
}

export const WORKER_WAIT_MS = 10_000
export const ADDRESS_WAIT_MS = 20_000

export const stoppedAt = (step: TurnOnStep, why: string): string => `Turning notifications on stopped while ${STEP_NAMES[step]}: ${why}. Nothing was turned on.`

/** The browser's own words for a failure, its error's name included, without a closing full stop (the page quotes them inside a sentence of its own). */
export const browserSaid = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\.$/, '')

/** A step of the browser's, given `ms` to finish: its answer, or an error that names the step and says it ran out of time or gives the browser's words. */
export function browserStep<T>(step: TurnOnStep, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stoppedAt(step, `nothing happened for ${Math.round(ms / 1000)} seconds`))), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(new Error(stoppedAt(step, `the browser said "${browserSaid(error)}"`)))
      },
    )
  })
}

/**
 * Turn notifications on here: the browser's permission (asked from the button press, never otherwise: it is the first call, with nothing awaited before it, because an iPhone or iPad
 * asks for permission only from a tap), the app's worker, a push address made with the inbox's
 * key (one made with an old key is dropped first), and the device handed to the inbox, which lists it as the space's. Throws with words to show.
 */
export async function turnOn(publicKey: string, onStep: (step: TurnOnStep) => void = () => {}): Promise<void> {
  const key = serverKey(publicKey)
  if (key === null) throw new Error(stoppedAt('address', 'the inbox’s key is not a P-256 public key'))
  onStep('permission')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error(NOT_ALLOWED)
  onStep('worker')
  const reg = await browserStep('worker', registerWorker().then(() => navigator.serviceWorker.ready), WORKER_WAIT_MS)
  onStep('address')
  const sub = await browserStep(
    'address',
    (async () => {
      const held = await reg.pushManager.getSubscription()
      if (held && keyOf(held) === publicKey) return held
      await held?.unsubscribe()
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    })(),
    ADDRESS_WAIT_MS,
  )
  onStep('device')
  const added = await postView('device-add', sub.toJSON())
  if (!added.ok) throw new Error(added.say.text)
}

/** Turn them off here: the browser's push address given up, and this device removed from the inbox's list. */
export async function turnOff(deviceId: string | null): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription()
  await sub?.unsubscribe()
  if (deviceId !== null) {
    const removed = await postView('device-remove', { id: deviceId })
    if (!removed.ok) throw new Error(removed.say.text)
  }
}

// ─── the page and the worker ─────────────────────────────────────────────

/** The addresses of the person whose conversation is on screen, for the worker to ask. Set by the conversation that is open, cleared when it closes. */
let shown: readonly string[] = []

export function setShownConversation(addresses: readonly string[]): void {
  shown = addresses.map((a) => a.toLowerCase())
}

/** What the worker would be told now: the addresses of the person whose conversation is on screen (a test reads it). */
export const shownConversation = (): readonly string[] => shown

/** Ask every list on screen to read again, as the worker does when it keeps a notification quiet because this page shows it. */
export const REFRESH_EVENT = 'space:refresh'
export const refreshLists = (): void => {
  window.dispatchEvent(new Event(REFRESH_EVENT))
}

/**
 * How often a screen on view reads again with nothing to prompt it: ten minutes, the net for a live message that was lost (the screens are read at once when the part they draw moves,
 * `useLive` in liveHub.tsx). Every screen that draws live data passes this to `useKeepFresh`.
 */
export const SAFETY_NET_MS = 600_000

/**
 * Keep a screen fresh, as every screen that draws live data does: `load(true)` (a quiet read, no spinner) when the page is shown again, every `everyMs` while it is
 * visible, and when the worker kept a notification quiet because this page shows that person. `load` may be a new function on every render: the latest is called, and the
 * timer is not started over by it (a timer that restarted on each render would never reach ten minutes).
 */
export function useKeepFresh(load: (quiet: boolean) => void, everyMs: number): void {
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') latest.current(true)
    }
    const quiet = () => latest.current(true)
    const timer = setInterval(again, everyMs)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    window.addEventListener(REFRESH_EVENT, quiet)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener(REFRESH_EVENT, quiet)
    }
  }, [everyMs])
}

/** A path the worker asks the page to open: the space's own, never another site's or a protocol-relative address. */
export const safePath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')

/**
 * The page's half of the service worker's questions, while mounted: which person's conversation is open (only while the page is on screen), open this path (a
 * tap, with the space already open), and read the lists again (a notification kept quiet because this page shows it).
 */
export function useNotificationBridge(go: (path: string) => void, refresh: () => void): void {
  useEffect(() => {
    if (!notificationsSupported()) return
    const workers = navigator.serviceWorker
    const heard = (event: MessageEvent) => {
      const message = event.data as { type?: string; path?: unknown } | null
      if (message?.type === WINDOW_MESSAGES.ask) {
        event.ports[0]?.postMessage({ open: document.visibilityState === 'visible' ? shown : [] })
      } else if (message?.type === WINDOW_MESSAGES.open && safePath(message.path)) {
        go(message.path)
      } else if (message?.type === WINDOW_MESSAGES.refresh) {
        refresh()
      }
    }
    workers.addEventListener('message', heard)
    // A listener added this way gets nothing until the page says it is ready to (onmessage would say so by itself).
    workers.startMessages()
    return () => workers.removeEventListener('message', heard)
  }, [go, refresh])
}
