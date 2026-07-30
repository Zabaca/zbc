#!/usr/bin/env bun
import { render } from 'ink'
import { App } from './app'
import { type Cf, resolveAccountId, resolveToken } from './cf'
import { demoInstances, demoLoad, demoTail } from './fixture'
import type { Kind } from './resources'
import { instances, sshSync, tail } from './wrangler'

const demo = process.argv.includes('--demo')

/**
 * Ink owns the terminal, and so does an ssh session, so they cannot both hold it.
 * Unmount, hand the tty over, then mount a fresh app back on the same kind. The
 * loop is here rather than in App because only the caller holds the Ink instance.
 */
function start(props: Parameters<typeof App>[0]) {
  const app = render(
    <App
      {...props}
      // Demo must stay offline, so it keeps whatever `shell` it was given (none).
      // Wiring the live sshSync in unconditionally would make `s` on a fixture row
      // tear down the UI and run wrangler against the real account.
      shell={
        demo
          ? undefined
          : (appId) => {
              app.unmount()
              // Ink restores the cursor asynchronously on unmount; let it finish first.
              setTimeout(() => {
                sshSync(appId)
                start({ ...props, initialKind: 'containers' })
              }, 50)
            }
      }
    />,
  )
}

if (demo) {
  start({
    account: 'demo',
    load: demoLoad,
    instances: demoInstances,
    tail: demoTail,
  })
} else {
  const token = resolveToken()
  // wrangler reads this from the environment; c9s may have decrypted it from sops.
  process.env.CLOUDFLARE_API_TOKEN = token
  const accountId = await resolveAccountId(token)
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId
  const cf: Cf = { token, accountId }
  start({
    account: accountId.slice(0, 8),
    load: (kind: Kind) => kind.list(cf),
    instances,
    tail: (worker, onLine) => {
      const p = tail(worker, onLine)
      return () => p.kill()
    },
  })
}
