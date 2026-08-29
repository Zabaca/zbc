/**
 * Expiry — collecting repositories nobody has pushed to for a while.
 *
 * On the free tier this is the ONLY removal path, and it is what lets the
 * service promise append-only refs without unbounded storage: nothing can ever
 * be destroyed inside the window, and everything leaves at the end of it.
 *
 * Idle means the time of the LAST PUSH, never the last access:
 *
 *   - It is free. The most recent WAL entry's `ts` is already in `index.json`,
 *     so the signal costs no write and no instrumentation.
 *   - It cannot be gamed. Recording a last-access would mean a write on every
 *     clone, through an endpoint deliberately left unauthenticated — a daily
 *     `git clone` from a cron job could then pin any repository alive forever.
 *   - It is the promise `GET /` already makes, from the same environment
 *     variable this file reads: "deleted N hours after its LAST PUSH. Cloning
 *     does not extend it; pushing does."
 *
 * The predicate below is the dangerous part of walgit, because its failure is
 * silent: over-retaining costs storage, and under-retaining deletes somebody's
 * work with no error anywhere. So every branch it cannot prove resolves toward
 * RETAIN — an index with no entries is not "infinitely old", and a timestamp
 * that will not parse is not "long ago". Deciding is all this file does; the
 * removal itself is `delete-repo.ts`, and what runs this on a timer belongs to
 * the deployment, not here.
 */

import { deleteRepo, type DeleteResult } from './delete-repo'
import type { ObjectStore } from './store'
import { listRepoIds } from './usage'
import { loadIndex, type WalIndex } from './wal-index'

/**
 * Expiry is off unless a window is configured. Absent means "this instance
 * keeps repositories forever", which is also what makes `GET /` stay silent
 * about a retention window it does not enforce — the same variable drives both.
 */
export function configuredExpiryMs(env = process.env): number | null {
  const hours = Number(env.WALGIT_RETENTION_HOURS)
  if (!Number.isFinite(hours) || hours <= 0) return null
  return hours * 60 * 60 * 1000
}

export type ExpiryVerdict = 'collect' | 'retain'

export interface ExpiryDecision {
  verdict: ExpiryVerdict
  /** Why. On a retention this is the question an operator arrives with. */
  reason: string
  /** The signal, when there was a usable one. */
  lastPushAt?: string
  idleMs?: number
}

/**
 * The most recent WAL entry's timestamp, or null when the index carries none
 * that parses.
 *
 * Every entry counts, not only `kind: 'push'`. A compaction is only ever
 * produced BY a push crossing the entry threshold, so it can never be newer
 * than the push that caused it in any way that matters — and after `gc` has
 * removed superseded entries, a compaction entry may be the only record left of
 * when the repository was last written to. Filtering it out would date a busy
 * repository by an entry that no longer exists, which is the under-retaining
 * direction.
 */
export function lastWriteAt(index: WalIndex): string | null {
  let newest: { ts: string; at: number } | null = null
  for (const entry of index.entries ?? []) {
    const at = Date.parse(entry.ts)
    // An unparseable timestamp is skipped rather than treated as epoch zero:
    // zero would read as ancient and take the repository with it.
    if (!Number.isFinite(at)) continue
    if (!newest || at > newest.at) newest = { ts: entry.ts, at }
  }
  return newest?.ts ?? null
}

export interface DecideOptions {
  now: Date
  /** Null means expiry is not configured, so nothing is ever collected. */
  windowMs: number | null
}

/**
 * Decide one repository's fate. Pure — no store, no clock, no environment — so
 * the edge cases that matter can be tested directly rather than through a
 * sweep that would hide them.
 */
export function decideExpiry(index: WalIndex | null, opts: DecideOptions): ExpiryDecision {
  const { now, windowMs } = opts

  if (windowMs === null) {
    return { verdict: 'retain', reason: 'expiry is not configured (WALGIT_RETENTION_HOURS unset)' }
  }

  // No index at all. Objects may still sit under the prefix, but they are
  // orphans by `orphans.ts`'s definition and reclaiming those is `gc`'s job;
  // resurrecting an index.json here to tombstone it would be worse.
  if (!index) {
    return { verdict: 'retain', reason: 'no index.json — nothing here for expiry to date' }
  }

  if (index.deletion) {
    // Already tombstoned, by an operator or by an earlier sweep. The decision
    // has been made; all that is left is whether its grace period has run out.
    // Handing it back to `deleteRepo` once it has is what finishes the job —
    // reporting "already scheduled" forever would leave every expired
    // repository tombstoned and none of them collected.
    const due = Date.parse(index.deletion.collect_after)
    if (Number.isFinite(due) && due <= now.getTime()) {
      return {
        verdict: 'collect',
        reason: `deletion grace period elapsed at ${index.deletion.collect_after}`,
      }
    }
    return {
      verdict: 'retain',
      reason: `already scheduled for deletion after ${index.deletion.collect_after}`,
    }
  }

  const lastPushAt = lastWriteAt(index)
  if (lastPushAt === null) {
    // An index with no entries, or with none whose `ts` parses. It is either
    // brand new (created by a push whose pack is landing right now) or damaged.
    // Both are reasons to leave it alone.
    return {
      verdict: 'retain',
      reason: 'no entry carries a parseable timestamp — nothing to date the repository by',
    }
  }

  const idleMs = now.getTime() - Date.parse(lastPushAt)

  // A timestamp in the future is clock skew or a corrupted index, never
  // staleness. Reading it as "idle for a negative time" happens to be safe, but
  // saying so out loud is what makes the skew visible to whoever has to fix it.
  if (idleMs < 0) {
    return {
      verdict: 'retain',
      reason: `last push ${lastPushAt} is in the future — clock skew, refusing to judge`,
      lastPushAt,
      idleMs,
    }
  }

  if (idleMs < windowMs) {
    return {
      verdict: 'retain',
      reason: `last push ${lastPushAt} is ${describe(idleMs)} ago, inside the ${describe(windowMs)} window`,
      lastPushAt,
      idleMs,
    }
  }

  return {
    verdict: 'collect',
    reason: `last push ${lastPushAt} is ${describe(idleMs)} ago, past the ${describe(windowMs)} window`,
    lastPushAt,
    idleMs,
  }
}

function describe(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 1) return `${Math.round(hours * 10) / 10}h`
  return `${Math.round(ms / 60_000)}m`
}

/** One repository's outcome, as the sweep reports it. */
export interface ExpiryOutcome {
  repoId: string
  decision: ExpiryDecision
  /** Present only for a collected repository: what `deleteRepo` did. */
  deletion?: DeleteResult
}

export interface ExpireResult {
  /** Repositories the sweep acted on — tombstoned, or collected outright. */
  collected: ExpiryOutcome[]
  /** Repositories deliberately kept, each carrying the reason it was kept. */
  retained: ExpiryOutcome[]
  windowMs: number | null
  dryRun: boolean
}

export interface ExpireOptions {
  now?: () => Date
  /** Null (the default when unconfigured) sweeps nothing. */
  windowMs?: number | null
  dryRun?: boolean
  /** Only consider these repositories, instead of every one in the store. */
  repoIds?: readonly string[]
  /** Where cached bare repos live, so a collection can drop the disk copy too. */
  reposDir?: string
  /** How long a collected repository sits tombstoned. `deleteRepo`'s default otherwise. */
  graceMs?: number
}

/**
 * Sweep the store and collect what has gone idle.
 *
 * Dry run by default, like `gc` and `delete`: this is the operator surface for
 * destruction, and looking before anything goes should never require care.
 * Collection is delegated to `deleteRepo`, so an expired repository gets the
 * same deferred, tombstone-first treatment as one deleted by hand — the clone
 * that read the index a second ago still finishes.
 */
export async function expireRepos(
  store: ObjectStore,
  opts: ExpireOptions = {},
): Promise<ExpireResult> {
  const now = opts.now ?? (() => new Date())
  const windowMs = opts.windowMs ?? null
  const dryRun = opts.dryRun !== false

  const result: ExpireResult = { collected: [], retained: [], windowMs, dryRun }

  // Unconfigured stops before the LIST, not after it: an instance that does not
  // expire should not be walking its bucket on a timer either.
  if (windowMs === null) return result

  // `usage.ts` already knows how to enumerate repositories cheaply — one
  // delimited LIST rather than a walk of every packfile. A repository it names
  // that has no `index.json` is retained by the predicate, not deleted.
  const repoIds = opts.repoIds ?? (await listRepoIds(store))
  for (const repoId of repoIds) {
    const loaded = await loadIndex(store, repoId)
    const index = loaded.etag === null ? null : loaded.index
    const decision = decideExpiry(index, { now: now(), windowMs })

    if (decision.verdict === 'retain') {
      result.retained.push({ repoId, decision })
      continue
    }

    const deletion = await deleteRepo(store, repoId, {
      now,
      dryRun,
      graceMs: opts.graceMs,
      dir: opts.reposDir ? `${opts.reposDir}/${repoId}.git` : undefined,
    })
    result.collected.push({ repoId, decision, deletion })
  }

  return result
}
