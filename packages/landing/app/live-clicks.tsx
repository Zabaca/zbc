'use client'

import { useEffect, useState } from 'react'
import { useNats } from '@zbc/pubsub/client'
import { Stack, Measure, PrimaryButton } from '@zbc/design-system'

const SUBJECT = 'landing.demo.clicks'

export function LiveClicks() {
  const { status, publish, subscribe } = useNats({ tokenEndpoint: '/api/nats-token' })
  const [count, setCount] = useState(0)

  useEffect(() => {
    return subscribe(SUBJECT, () => {
      setCount((c) => c + 1)
    })
  }, [subscribe])

  function onClick() {
    publish(SUBJECT)
  }

  return (
    <Stack gap="sm">
      <Measure as="h2">Live clicks across every open tab: {count}</Measure>
      <Measure as="p">
        Status: <code>{status}</code>. Open this page in a second tab — every click in either tab
        increments the counter on both, fanning out through the self-hosted NATS server over
        WebSocket. Each browser session uses its own JWT, scoped to <code>landing.demo.&gt;</code>{' '}
        and expiring in 1 hour.
      </Measure>
      <PrimaryButton type="button" onClick={onClick} disabled={status !== 'live'}>
        Click me
      </PrimaryButton>
    </Stack>
  )
}
