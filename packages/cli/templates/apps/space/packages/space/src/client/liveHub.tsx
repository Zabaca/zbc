// The shell's side of live updates (the space's ADR 0019): the ONE connection per tab, and the hook a screen uses to be told that a part it draws moved.
//
// `LiveProvider` is mounted once, by the page (App.tsx), above every tab, so a person who changes tab keeps the same connection. It opens the socket, routes what it hears to the screens (live.ts `LiveHub`) and tries the
// connection again when the page is shown or the network comes back. A screen that is not under a provider (a test that draws one screen alone, the dev server with no live object) is told nothing and reads as it
// always has: when it opens, when the page is shown again and every ten minutes.

import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { LivePart } from '@space/workspace'
import { type LiveEvent, LiveHub, type LiveStatus, browserLink } from './live'
import { SAFETY_NET_MS, useKeepFresh } from './notify'

/** Exported so a test can give a screen a hub of its own (test/refresh.test.tsx); the page uses `LiveProvider`. */
export const LiveContext = createContext<LiveHub | null>(null)

export function LiveProvider({ children }: { children: ReactNode }) {
  const hub = useMemo(() => new LiveHub({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }), [])
  useEffect(() => {
    const link = browserLink({ told: (frame) => hub.told(frame), reconnected: () => hub.everything(), status: (s) => hub.setStatus(s) })
    const wake = () => {
      if (document.visibilityState === 'visible') link.wake()
    }
    link.start()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      link.stop()
      hub.setStatus('off')
    }
  }, [hub])
  return <LiveContext.Provider value={hub}>{children}</LiveContext.Provider>
}

/**
 * Be called when a part this screen draws moves, or the connection comes back after a gap. `onEvent` says what to read again: the screen reads what it is showing for the part, and its open conversation only if
 * `readsOpen(event, openKey)` (live.ts) is true. Every screen that draws a part says so here; none opens a socket of its own.
 */
export function useLive(parts: readonly LivePart[], onEvent: (event: LiveEvent) => void): void {
  const hub = useContext(LiveContext)
  const latest = useRef(onEvent)
  latest.current = onEvent
  const key = parts.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the parts, by value.
  useEffect(() => (hub ? hub.subscribe(parts, (e) => latest.current(e)) : undefined), [hub, key])
}

/**
 * What a screen that reads ONE thing does to stay fresh, in one call: `reload` when a part it draws moves or the connection comes back, when the page is shown again, when a notification was kept
 * quiet because this page shows it, and every ten minutes as the net for a message that was lost. A screen whose reads are not one (the lists, which also read their open conversation) calls
 * `useLive` and `useKeepFresh` itself.
 */
export function useFresh(parts: readonly LivePart[], reload: () => void): void {
  useLive(parts, () => reload())
  useKeepFresh(() => reload(), SAFETY_NET_MS)
}

/** Whether the connection is up, for a screen that says so. 'off' where there is no provider. */
export function useLiveStatus(): LiveStatus {
  const hub = useContext(LiveContext)
  return useSyncExternalStore(
    (listener) => (hub ? hub.onStatus(listener) : () => {}),
    () => hub?.status ?? 'off',
    () => 'off',
  )
}
