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
import type { InstructionsPolicy } from './instructions'
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

/**
 * Open to anyone, deliberately. This is the public service's whole shape: with
 * writes open there is nothing a credential could prove, so demanding one only
 * costs an agent a step. It is an explicit opt-in and NOT the absence of
 * tokens — `createHttpHandler` refuses to serve when neither is configured, so
 * a deployment that loses its secrets fails closed instead of opening to the
 * world. Off unless set, so every existing deployment is unchanged.
 */
const isPublic = process.env.WALGIT_PUBLIC === '1'

/**
 * What `GET /` is allowed to promise. Each limit is read from the same env var
 * that enforces it, so the page states the deployment's real behaviour rather
 * than a copy of it that can drift. Unset means unenforced, and unenforced
 * limits are simply not mentioned.
 */
const instructions: InstructionsPolicy = {
  publicAccess: isPublic,
  appendOnly: process.env.WALGIT_APPEND_ONLY === '1',
  retentionHours: positiveNumber(process.env.WALGIT_RETENTION_HOURS),
  maxPushBytes: positiveNumber(process.env.WALGIT_MAX_PUSH_BYTES),
  maxRepoBytes: positiveNumber(process.env.WALGIT_MAX_REPO_BYTES),
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  // An unparseable cap must not become a stated one: saying "1 MiB" when NaN
  // was configured would be worse than saying nothing.
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const store = storeFromEnv()
if (!store) {
  // Warned, not fatal: reads still work off the local cache, and a push is
  // refused by the hooks themselves rather than by guessing here.
  console.error(
    'walgit: no object store configured — pushes will be REFUSED (see src/store-env.ts)',
  )
}

let handler
try {
  handler = createHttpHandler({
    reposDir,
    tokens,
    public: isPublic,
    ensureRepo: ensureBareRepo,
    syncRepo: (repo) => syncRepo(store, repo),
    runBackend: runGitHttpBackend,
    instructions,
  })
} catch (err) {
  // Refusing to boot beats booting a half-configured git host — either an open
  // one, or one that answers every request with a 401 nobody can satisfy.
  console.error((err as Error).message)
  process.exit(1)
}

Bun.serve({ port, idleTimeout: 0, fetch: handler })
console.log(`walgit smart-HTTP listening on :${port} (repos: ${reposDir})`)
