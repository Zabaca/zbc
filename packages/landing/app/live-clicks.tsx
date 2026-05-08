'use client'

import { useEffect, useRef, useState } from 'react'
import { connect, type NatsConnection } from 'nats.ws'
import { Stack, Measure, PrimaryButton } from '@zbc/design-system'

const SUBJECT = 'landing.demo.clicks'

type Status = 'idle' | 'connecting' | 'live' | 'unavailable' | 'error'

export function LiveClicks() {
  const [status, setStatus] = useState<Status>('idle')
  const [count, setCount] = useState(0)
  const ncRef = useRef<NatsConnection | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      setStatus('connecting')
      const cfgRes = await fetch('/api/nats-config')
      if (!cfgRes.ok) {
        setStatus('unavailable')
        return
      }
      const cfg = (await cfgRes.json()) as { url: string; user: string; password: string }

      try {
        const nc = await connect({
          servers: [cfg.url],
          user: cfg.user,
          pass: cfg.password,
        })
        if (cancelled) {
          await nc.close()
          return
        }
        ncRef.current = nc
        setStatus('live')

        const sub = nc.subscribe(SUBJECT)
        ;(async () => {
          for await (const _msg of sub) {
            setCount((c) => c + 1)
          }
        })()
      } catch {
        setStatus('error')
      }
    }

    run()
    return () => {
      cancelled = true
      ncRef.current?.close()
      ncRef.current = null
    }
  }, [])

  function publish() {
    ncRef.current?.publish(SUBJECT)
  }

  return (
    <Stack gap="sm">
      <Measure as="h2">Live clicks across every open tab: {count}</Measure>
      <Measure as="p">
        Status: <code>{status}</code>. Open this page in a second tab — every click in either tab
        increments the counter on both, fanning out through the self-hosted NATS server over
        WebSocket.
      </Measure>
      <PrimaryButton type="button" onClick={publish} disabled={status !== 'live'}>
        Click me
      </PrimaryButton>
    </Stack>
  )
}
