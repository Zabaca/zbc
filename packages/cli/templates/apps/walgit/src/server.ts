#!/usr/bin/env bun
/**
 * The smart-HTTP process.
 *
 * One of the two front doors; the other is sshd running the forced command in
 * src/ssh-shell.ts. Both serve the same bare repos out of WALGIT_REPOS_DIR, and
 * both go through src/repo.ts to decide which repo a request means.
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

if (tokens.length === 0) {
  // Refusing to boot beats booting an open git host: with no tokens configured
  // every credential comparison fails closed, which looks identical to a
  // misconfigured client and would be debugged for hours.
  console.error('walgit: WALGIT_HTTP_TOKENS is empty — refusing to start')
  process.exit(1)
}

/**
 * What `GET /` is allowed to promise. Each limit is read from the same env var
 * that enforces it, so the page states the deployment's real behaviour rather
 * than a copy of it that can drift. Unset means unenforced, and unenforced
 * limits are simply not mentioned.
 */
const instructions: InstructionsPolicy = {
  publicAccess: process.env.WALGIT_PUBLIC === '1',
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

const handler = createHttpHandler({
  reposDir,
  tokens,
  ensureRepo: ensureBareRepo,
  syncRepo: (repo) => syncRepo(store, repo),
  runBackend: runGitHttpBackend,
  instructions,
})

Bun.serve({ port, idleTimeout: 0, fetch: handler })
console.log(`walgit smart-HTTP listening on :${port} (repos: ${reposDir})`)
