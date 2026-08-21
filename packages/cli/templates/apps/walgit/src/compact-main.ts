#!/usr/bin/env bun
/**
 * The detached compaction worker.
 *
 * It is a separate process, spawned and disowned by `post-receive`, because
 * compaction repacks the entire repository and the push it follows must not
 * wait for it. `post-receive` runs after the refs have moved but the client is
 * still connected, so anything synchronous here would land as push latency —
 * on the one path this project promises to keep fast.
 *
 * Failures are logged and swallowed. Compaction is an optimisation: a repo
 * that fails to compact serves every request correctly and merely restores
 * more slowly, so a crash here must never be able to affect a push.
 */

import { compact } from './compact'
import { collectGarbage } from './gc'
import { requireStore } from './store-env'

const gitDir = process.argv[2]
const repoId = process.argv[3]

async function main(): Promise<void> {
  if (!gitDir || !repoId) throw new Error('usage: compact-main <git-dir> <repo-id>')
  const store = requireStore()
  const result = await compact(store, { repoId, dir: gitDir })
  if (!process.env.WALGIT_QUIET) {
    console.error(`walgit compact ${JSON.stringify({ repoId, ...result })}`)
  }
  // GC follows compaction rather than running on its own schedule: compaction
  // is the only thing that creates tombstones, so this is the moment the
  // PREVIOUS compaction's grace period has most likely elapsed.
  if (result.status === 'compacted') {
    const gc = await collectGarbage(store, repoId)
    if (!process.env.WALGIT_QUIET) {
      console.error(
        `walgit gc ${JSON.stringify({
          repoId,
          collected: gc.collected.length,
          retained: gc.retained.length,
          orphansCollected: gc.orphansCollected.length,
          orphansHeld: gc.orphansHeld.length,
        })}`,
      )
    }
  }
}

try {
  await main()
} catch (err) {
  process.stderr.write(`walgit compact: ${(err as Error).message}\n`)
  process.exit(1)
}
