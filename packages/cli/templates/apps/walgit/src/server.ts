#!/usr/bin/env bun
/**
 * The smart-HTTP process.
 *
 * One of the two front doors; the other is sshd running the forced command in
 * src/ssh-shell.ts. Both serve the same bare repos out of WALGIT_REPOS_DIR, and
 * both go through src/repo.ts to decide which repo a request means.
 */

import { ensureBareRepo } from './repo'
import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'

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

const handler = createHttpHandler({
  reposDir,
  tokens,
  ensureRepo: ensureBareRepo,
  runBackend: runGitHttpBackend,
})

Bun.serve({ port, idleTimeout: 0, fetch: handler })
console.log(`walgit smart-HTTP listening on :${port} (repos: ${reposDir})`)
