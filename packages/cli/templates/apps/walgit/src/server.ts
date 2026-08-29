#!/usr/bin/env bun
/**
 * The smart-HTTP process — the only front door, and the container's only
 * process.
 *
 * It serves the bare repos under WALGIT_REPOS_DIR and goes through src/repo.ts
 * to decide which repo a request means. There used to be a second door (sshd
 * running a forced command), which is what put walgit on a Fly machine with a
 * dedicated IPv4: SSH needs raw inbound TCP. Dropping it is what let the app
 * move onto a Cloudflare Container, where the Worker in worker/index.ts proxies
 * straight to this port.
 */

import { ensureBareRepo } from './cache'
import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'
import { storeFromEnv } from './store-env'
import { syncRepo } from './sync'

const reposDir = process.env.WALGIT_REPOS_DIR ?? '/srv/walgit/repos'
const port = Number(process.env.PORT ?? 8080)

// Comma-separated so one deployment can rotate a credential without a window
// where neither the old nor the new token works.
const tokens = (process.env.WALGIT_HTTP_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)

if (tokens.length === 0) {
  // Refusing to boot beats booting an open git host: with no tokens configured
  // every credential comparison fails closed, which looks identical to a
  // misconfigured client and would be debugged for hours.
  console.error('walgit: WALGIT_HTTP_TOKENS is empty — refusing to start')
  process.exit(1)
}

const store = storeFromEnv()
if (!store) {
  // Warned, not fatal: reads still work off the local cache, and a push is
  // refused by the hooks themselves rather than by guessing here.
  console.error(
    'walgit: no object store configured — pushes will be REFUSED (see src/store-env.ts)',
  )
}

const handler = createHttpHandler({
  reposDir,
  tokens,
  ensureRepo: ensureBareRepo,
  syncRepo: (repo) => syncRepo(store, repo),
  runBackend: runGitHttpBackend,
})

Bun.serve({ port, idleTimeout: 0, fetch: handler })
console.log(`walgit smart-HTTP listening on :${port} (repos: ${reposDir})`)
