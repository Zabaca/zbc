import { useCallback, useEffect, useRef, useState } from 'react'
import { connect, jwtAuthenticator, type NatsConnection, type Subscription } from 'nats.ws'
import type { MintedCreds } from './shared'

export interface UseNatsOpts {
  tokenEndpoint: string
}

export type NatsStatus = 'connecting' | 'live' | 'reconnecting' | 'error'

export interface UseNatsResult {
  status: NatsStatus
  publish: (subject: string, payload?: Uint8Array | string) => void
  subscribe: (subject: string, onMsg: (data: Uint8Array, subject: string) => void) => () => void
}

interface ActiveSub {
  subject: string
  onMsg: (data: Uint8Array, subject: string) => void
  sub?: Subscription
}

export function useNats(opts: UseNatsOpts): UseNatsResult {
  const { tokenEndpoint } = opts
  const [status, setStatus] = useState<NatsStatus>('connecting')
  const ncRef = useRef<NatsConnection | null>(null)
  const subsRef = useRef<ActiveSub[]>([])
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    let attempt = 0

    async function fetchCreds(): Promise<MintedCreds> {
      const res = await fetch(tokenEndpoint)
      if (!res.ok) throw new Error(`token endpoint ${tokenEndpoint} returned ${res.status}`)
      return (await res.json()) as MintedCreds
    }

    function attachSub(active: ActiveSub, nc: NatsConnection): void {
      const sub = nc.subscribe(active.subject)
      active.sub = sub
      ;(async () => {
        for await (const m of sub) {
          active.onMsg(m.data, m.subject)
        }
      })()
    }

    async function connectOnce(initial: boolean): Promise<void> {
      try {
        if (!initial) setStatus('reconnecting')
        const creds = await fetchCreds()
        if (cancelledRef.current) return

        const nc = await connect({
          servers: [creds.url],
          authenticator: jwtAuthenticator(creds.jwt, new TextEncoder().encode(creds.seed)),
        })
        if (cancelledRef.current) {
          await nc.close()
          return
        }

        ncRef.current = nc
        attempt = 0
        setStatus('live')

        // Re-attach any subscriptions established before/across reconnects
        for (const active of subsRef.current) {
          attachSub(active, nc)
        }

        // Schedule a proactive token refresh + reconnect at 80% of lifetime
        const lifetime = creds.expiresAt - Date.now()
        const refreshIn = Math.max(5_000, Math.floor(lifetime * 0.8))
        refreshTimerRef.current = setTimeout(() => {
          void rotate()
        }, refreshIn)
      } catch (err) {
        if (cancelledRef.current) return
        console.error('useNats: connect failed', err)
        attempt++
        setStatus('reconnecting')
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5))
        refreshTimerRef.current = setTimeout(() => {
          void connectOnce(false)
        }, delay)
      }
    }

    async function rotate(): Promise<void> {
      const prev = ncRef.current
      ncRef.current = null
      for (const active of subsRef.current) {
        active.sub = undefined
      }
      try {
        await prev?.close()
      } catch {
        // ignore close errors during rotation
      }
      if (cancelledRef.current) return
      await connectOnce(false)
    }

    void connectOnce(true)

    return () => {
      cancelledRef.current = true
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      const nc = ncRef.current
      ncRef.current = null
      void nc?.close()
    }
  }, [tokenEndpoint])

  const publish = useCallback((subject: string, payload?: Uint8Array | string): void => {
    const nc = ncRef.current
    if (!nc) return
    const data =
      payload === undefined
        ? undefined
        : typeof payload === 'string'
          ? new TextEncoder().encode(payload)
          : payload
    nc.publish(subject, data)
  }, [])

  const subscribe = useCallback(
    (subject: string, onMsg: (data: Uint8Array, subject: string) => void): (() => void) => {
      const active: ActiveSub = { subject, onMsg }
      subsRef.current.push(active)
      const nc = ncRef.current
      if (nc) {
        const sub = nc.subscribe(subject)
        active.sub = sub
        ;(async () => {
          for await (const m of sub) {
            onMsg(m.data, m.subject)
          }
        })()
      }
      return () => {
        const idx = subsRef.current.indexOf(active)
        if (idx >= 0) subsRef.current.splice(idx, 1)
        active.sub?.unsubscribe()
      }
    },
    [],
  )

  return { status, publish, subscribe }
}
