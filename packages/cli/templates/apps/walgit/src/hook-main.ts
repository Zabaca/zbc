#!/usr/bin/env bun
/**
 * The single entry point both hooks exec into.
 *
 * Exit codes are the contract with git, and therefore with the client:
 *
 *   - `pre-receive` non-zero  → the push is rejected before any ref moves.
 *   - `reference-transaction prepared` non-zero → git aborts the staged ref
 *     transaction and the push is rejected.
 *   - zero from either → git proceeds, and from `prepared` that means the push
 *     will be acknowledged. Exiting zero without a published WAL entry is the
 *     single failure this project exists to prevent, so every unexpected error
 *     here is fatal rather than logged.
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'

import { configuredThreshold, isCompactionDue } from './compact'
import { clearPending, parseRefChanges, preReceive, publishPush, readPending } from './push'
import { requireStore, storeFromEnv } from './store-env'
import { loadIndex } from './wal-index'

const hook = process.argv[2]
const phase = process.argv[3]
const gitDir = path.resolve(process.env.GIT_DIR ?? '.')
const repoId = process.env.WALGIT_REPO_ID ?? path.basename(gitDir).replace(/\.git$/, '')

/**
 * Test-only kill points, off unless `WALGIT_FAULT` is set. The fault-injection
 * suite needs to stop the process at named moments on this path; simulating
 * them from outside would race the very window being tested.
 */
function fault(point: string): void {
  if (process.env.WALGIT_FAULT === point) {
    process.stderr.write(`walgit: fault injected at ${point}\n`)
    process.exit(9)
  }
}

async function main(): Promise<number> {
  const stdin = await Bun.stdin.text()

  if (hook === 'pre-receive') {
    const store = requireStore()
    await preReceive({
      store,
      repoId,
      gitDir,
      quarantineDir: process.env.GIT_QUARANTINE_PATH || process.env.GIT_OBJECT_DIRECTORY,
    })
    fault('after-upload')
    return 0
  }

  if (hook === 'reference-transaction') {
    const pending = readPending(gitDir)
    // No pending upload means this ref update did not come from a push — an
    // administrative edit on this node. It has nothing to publish, and
    // publishing it would let a stale cache overwrite the index.
    if (!pending) return 0

    if (phase === 'committed' || phase === 'aborted') {
      if (phase === 'aborted' && pending.entry) {
        // The uploaded pack is now unreferenced. It is not lost: `findOrphans`
        // recovers it by diffing the WAL prefix against index.json.
        process.stderr.write(`walgit: push rejected; orphaned WAL object ${pending.entry.key}\n`)
      }
      clearPending(gitDir)
      return 0
    }
    if (phase !== 'prepared') return 0

    const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
    if (changes.length === 0) return 0

    fault('before-cas')
    const store = requireStore()
    const result = await publishPush(store, repoId, pending, changes)
    if (!result.ok) {
      process.stderr.write(
        result.reason === 'ref-conflict'
          ? `walgit: ${result.ref} moved under this push (index has ${result.actual}, ` +
              `push expected ${result.expected}) — fetch and retry\n`
          : 'walgit: the write-ahead log stayed contended — retry the push\n',
      )
      return 1
    }
    fault('after-cas')
    return 0
  }

  if (hook === 'post-receive') {
    // Everything below is best-effort by construction: the push is already
    // acknowledged, so a failure here must be invisible to the client.
    try {
      const store = storeFromEnv()
      if (!store) return 0
      const { index } = await loadIndex(store, repoId)
      if (!isCompactionDue(index, configuredThreshold())) return 0
      // Detached and disowned: `post-receive` holds the client's connection
      // open until it exits, so this hook must exit now, not when the repack
      // finishes. The lease in `compact.ts` is what keeps two of these from
      // repacking the same repository at once.
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dir, 'compact-main.ts'), gitDir, repoId],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
    } catch (err) {
      process.stderr.write(`walgit: compaction not scheduled: ${(err as Error).message}\n`)
    }
    return 0
  }

  process.stderr.write(`walgit: unknown hook ${hook}\n`)
  return 1
}

try {
  process.exit(await main())
} catch (err) {
  process.stderr.write(`walgit: ${(err as Error).message}\n`)
  process.exit(1)
}
