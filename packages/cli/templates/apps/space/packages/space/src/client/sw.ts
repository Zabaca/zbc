import { ASK_WAIT_MS, MESSAGES, notificationFor, readPayload, type Shown, showsEveryPush, stayQuiet, tapTarget } from './sw-push'

/**
 * The space's service worker: what makes it an app Chrome installs on a phone or a Mac, and what shows a notification. Built by Vite as an entry of its
 * own at the fixed address /sw.js (vite.config.ts), so its scope is the whole app. Every rule is in sw-push.ts, which is tested; this is only the glue to
 * the browser's events.
 *
 * ── IT KEEPS NOTHING ─────────────────────────────────────────────────────
 * It has a `fetch` handler, which Chrome wants of an installable app, and the handler does not answer: every request goes to the network as it would with
 * no worker, so Access sees each navigation (a device whose sign-in has lapsed meets its sign-in page on the way in) and nothing that carries mail or a
 * person is ever kept on the device. The inbox's worker keeps the app's own files so it opens offline; the space does not, because it has no offline use.
 * A new build of this file takes over at once (`skipWaiting`, `claim`).
 *
 * ── A NOTIFICATION ───────────────────────────────────────────────────────
 * A push carries the sender and the subject, encrypted to this device. Before showing it the worker asks each visible window of the space which person's
 * conversation it has open, waiting briefly; a window showing that very person is told to read its lists again and, except on Apple's devices (sw-push.ts `showsEveryPush`), nothing is shown. A tap brings a window of
 * the space forward and tells it to open the person's conversation (no reload), or opens the space at that address.
 *
 * Typed with the few shapes it uses rather than the WebWorker library, which conflicts with the DOM and Workers types the rest of the app compiles against.
 */

interface WaitEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface PushMessageEvent extends WaitEvent {
  data: { text(): string } | null
}
interface NotificationClickEvent extends WaitEvent {
  notification: { close(): void; data: { person?: string | null } | null }
}
interface AppWindow {
  url: string
  visibilityState: 'visible' | 'hidden' | 'prerender'
  focused: boolean
  postMessage(message: unknown, transfer?: Transferable[]): void
  focus(): Promise<unknown>
}
interface WorkerScope {
  location: { origin: string }
  navigator: { userAgent: string }
  registration: { showNotification(title: string, options: Shown['options']): Promise<void> }
  skipWaiting(): Promise<void>
  clients: {
    claim(): Promise<void>
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<AppWindow[]>
    openWindow(url: string): Promise<unknown>
  }
  addEventListener(type: 'install' | 'activate', listener: (event: WaitEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: Event) => void): void
  addEventListener(type: 'push', listener: (event: PushMessageEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: NotificationClickEvent) => void): void
}

const worker = self as unknown as WorkerScope

worker.addEventListener('install', (event) => {
  event.waitUntil(worker.skipWaiting())
})

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim())
})

// Present, and answering nothing: the browser fetches every request as though there were no worker (see above).
worker.addEventListener('fetch', () => {})

/** The space's windows on this device, the ones not yet controlled by this worker included. */
const appWindows = () => worker.clients.matchAll({ type: 'window', includeUncontrolled: true })

/** The addresses of the person a window has open, or none when it says none or does not answer in time. */
function openIn(window: AppWindow): Promise<string[]> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve([]), ASK_WAIT_MS)
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      const open = (event.data as { open?: unknown } | null)?.open
      resolve(Array.isArray(open) ? open.filter((a): a is string => typeof a === 'string') : [])
    }
    window.postMessage({ type: MESSAGES.ask }, [channel.port2])
  })
}

worker.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let text: string | null = null
      try {
        text = event.data?.text() ?? null
      } catch {
        text = null
      }
      const shown = notificationFor(readPayload(text))
      const person = shown.options.data.person
      const visible = (await appWindows()).filter((w) => w.visibilityState === 'visible')
      const open = await Promise.all(visible.map(openIn))
      if (stayQuiet(person, open)) {
        visible.forEach((w, i) => {
          if ((open[i] ?? []).includes(person as string)) w.postMessage({ type: MESSAGES.refresh })
        })
        // Chrome lets that stand. Safari takes away the permission of a site whose push shows nothing, so on an iPhone or iPad the notification is shown all the same.
        if (!showsEveryPush(worker.navigator.userAgent)) return
      }
      await worker.registration.showNotification(shown.title, shown.options)
    })(),
  )
})

worker.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const person = event.notification.data?.person ?? null
      const windows = await appWindows()
      const target = tapTarget(person, windows, worker.location.origin)
      if (target.kind === 'open') {
        await worker.clients.openWindow(target.url)
        return
      }
      const window = windows[target.index] as AppWindow
      await window.focus()
      window.postMessage({ type: MESSAGES.open, path: target.path })
    })(),
  )
})
