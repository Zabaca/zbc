/**
 * The hook scripts installed into every bare repo.
 *
 * git's hooks are the only place a push can be intercepted at the two moments
 * that matter — after the objects have arrived but before anything can see
 * them, and after the ref update is staged but before it is committed — so the
 * push path lives inside them rather than in a wrapper around
 * `git-receive-pack`, which sees neither moment.
 *
 * They are re-written on every `ensureBareRepo`, not only at creation: the disk
 * is a cache and a repo may appear on a node by any route, including one that
 * predates this code. A repo without these hooks accepts pushes that are never
 * persisted, which is the one outcome walgit must never have.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Resolved at install time so the hook does not depend on `bun` being on git's PATH. */
const BUN = process.execPath
const HOOK_MAIN = path.join(import.meta.dir, 'hook-main.ts')

/**
 * `post-receive` is here for compaction and for ref events. It runs after the
 * refs have moved and after the push is durable, which makes it the only hook
 * where doing work cannot cost correctness — compaction is handed to a detached
 * process so it does not cost latency either, and the ref-event announcement is
 * bounded and swallows its own failures (src/announce.ts).
 */
const HOOKS = ['pre-receive', 'reference-transaction', 'post-receive'] as const

function script(hook: string, repoId: string, hookMain: string, bun: string): string {
  return [
    '#!/bin/sh',
    '# Installed by walgit (src/hooks.ts). Regenerated on every repo access.',
    'set -e',
    `WALGIT_REPO_ID=${shellQuote(repoId)}`,
    'export WALGIT_REPO_ID',
    `exec ${shellQuote(bun)} ${shellQuote(hookMain)} ${hook} "$@"`,
    '',
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function installHooks(gitDir: string, repoId: string, hookMain = HOOK_MAIN): void {
  const dir = path.join(gitDir, 'hooks')
  fs.mkdirSync(dir, { recursive: true })
  for (const hook of HOOKS) {
    const body = script(hook, repoId, hookMain, BUN)
    const file = path.join(dir, hook)
    // Rewritten only when it differs: a push is not the moment to churn files
    // in the directory git is about to execute out of.
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      fs.writeFileSync(file, body)
    }
    fs.chmodSync(file, 0o755)
  }
}
