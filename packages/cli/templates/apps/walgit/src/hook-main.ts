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
import * as fs from 'node:fs'
import * as path from 'node:path'

import { announceConfigFromEnv } from './announce'
import { appendOnlyEnabled, checkAppendOnly } from './append-only'
import { configuredThreshold, isCompactionDue } from './compact'
import { checkSize, limitsEnforced, limitsFromEnv, liveBytes } from './limits'
import { clearPending, invocationId, markConsumed, readPending, sweepPending } from './pending'
import { parseRefChanges, preReceive, publishPush, quarantinePack } from './push'
import { requireStore, storeFromEnv } from './store-env'
import { loadIndex, type RefChange } from './wal-index'

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

/**
 * Test-only widening of the window between `pre-receive` finishing and
 * `reference-transaction` running, off unless `WALGIT_STALL_MS` is set. The
 * hand-off race between two `git-receive-pack` invocations is a real race with
 * a window measured in milliseconds; a test that waits for it to happen by luck
 * is a test that passes for the wrong reason.
 */
async function stall(): Promise<void> {
  const ms = Number(process.env.WALGIT_STALL_MS ?? '')
  if (Number.isFinite(ms) && ms > 0) await Bun.sleep(ms)
}

async function main(): Promise<number> {
  const stdin = await Bun.stdin.text()

  if (hook === 'pre-receive') {
    // Before the store is even touched: a push that will be refused must not
    // cost an object-store write. git's own deny rules run after this hook, so
    // leaving it to them would upload a pack nothing will ever reference.
    if (appendOnlyEnabled()) {
      const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
      const verdict = checkAppendOnly(gitDir, repoId, changes)
      if (!verdict.ok) {
        process.stderr.write(`${verdict.message}\n`)
        return 1
      }
    }
    const quarantineDir = process.env.GIT_QUARANTINE_PATH || process.env.GIT_OBJECT_DIRECTORY
    const store = requireStore()

    // Size, for the same reason and at the same moment. The pack is in the
    // quarantine and its size is exact, so the answer costs one stat and (only
    // when a repository total is configured) one index read — against the ~37 s
    // an oversized push otherwise spends uploading before the EDGE refuses it
    // with something that reads like a dropped connection. See src/limits.ts.
    const limits = limitsFromEnv()
    if (limitsEnforced(limits)) {
      const found = quarantineDir ? quarantinePack(quarantineDir) : null
      const pushBytes = found ? fs.statSync(found.pack).size : 0
      // Skipped for a ref-only push: it adds nothing, so neither cap can move.
      if (pushBytes > 0) {
        const repoBytes =
          limits.maxRepoBytes === null ? 0 : liveBytes((await loadIndex(store, repoId)).index)
        const verdict = checkSize({ repoId, pushBytes, repoBytes, limits })
        if (!verdict.ok) {
          process.stderr.write(`${verdict.message}\n`)
          return 1
        }
      }
    }

    await preReceive({
      store,
      repoId,
      gitDir,
      quarantineDir,
    })
    fault('after-upload')
    await stall()
    return 0
  }

  if (hook === 'reference-transaction') {
    const invocation = invocationId()
    const pending = readPending(gitDir, invocation)
    // No pending record for THIS `git-receive-pack` means this ref update did
    // not come from a push — an administrative edit on this node. It has
    // nothing to publish, and publishing it would let a stale cache overwrite
    // the index. A concurrent push's record is invisible here by construction,
    // which is the whole point of keying the record by invocation.
    if (!pending) return 0

    if (phase === 'committed') return 0
    if (phase === 'aborted') {
      if (pending.entry && !pending.consumed) {
        // The uploaded pack is now unreferenced. It is not lost: `findOrphans`
        // recovers it by diffing the WAL prefix against index.json.
        process.stderr.write(`walgit: push rejected; orphaned WAL object ${pending.entry.key}\n`)
        markConsumed(gitDir, invocation)
      }
      // The record is deliberately NOT deleted here: a push whose refs arrive
      // in several transactions still has transactions to come, and a deleted
      // record would make the next one look like an administrative edit — the
      // silent acknowledgement this path exists to prevent. `post-receive` and
      // the sweep clean up.
      return 0
    }
    if (phase !== 'prepared') return 0

    const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
    if (changes.length === 0) return 0

    fault('before-cas')
    const store = requireStore()
    // The pack belongs to the first transaction that publishes; later ones in
    // the same push carry ref changes only.
    const toPublish = pending.consumed ? { entry: null } : pending
    const result = await publishPush(store, repoId, toPublish, changes)
    if (!result.ok) {
      process.stderr.write(
        result.reason === 'ref-conflict'
          ? `walgit: ${result.ref} moved under this push (index has ${result.actual}, ` +
              `push expected ${result.expected}) — fetch and retry\n`
          : 'walgit: the write-ahead log stayed contended — retry the push\n',
      )
      return 1
    }
    if (toPublish.entry) markConsumed(gitDir, invocation)
    fault('after-cas')
    return 0
  }

  if (hook === 'post-receive') {
    // Everything below is best-effort by construction: the push is already
    // acknowledged, so a failure here must be invisible to the client.
    clearPending(gitDir, invocationId())
    sweepPending(gitDir)

    // Ref events, announced here and not from `reference-transaction`, because
    // here is the first moment the push is certainly durable: git only runs
    // this hook once the ref transaction committed, which is only once the
    // compare-and-swap on index.json won. A push that lost it is rejected and
    // never reaches this line, so nobody is ever told about one. See
    // src/announce.ts, which swallows every failure for the same reason the
    // rest of this branch does.
    const events = announceConfigFromEnv()
    if (events) {
      const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
      if (changes.length > 0) spawnAnnounce(repoId, changes)
    }
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

/**
 * Hand the announcement to a detached process and return.
 *
 * `post-receive` holds the client's connection until it exits, so the
 * announcement must not be awaited here: a fan-out that is slow or unreachable
 * would be paid for by the pusher, on the path this project keeps fast. The
 * refs are passed as one JSON argument — a push moves a handful of them, and
 * the alternative (a pipe to a disowned child) would keep this process alive to
 * write it.
 *
 * A spawn that fails is logged and dropped, like every other failure in
 * `post-receive`: the push is already durable and `index.json` already holds
 * what this would have announced, so a subscriber's next handshake reads it
 * there anyway.
 */
function spawnAnnounce(repo: string, changes: readonly RefChange[]): void {
  try {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'announce-main.ts'), repo, JSON.stringify(changes)],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
  } catch (err) {
    process.stderr.write(`walgit: ref-event announce not spawned: ${(err as Error).message}\n`)
  }
}
