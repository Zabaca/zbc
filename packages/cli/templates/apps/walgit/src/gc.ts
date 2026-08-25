/**
 * Deleting from the write-ahead log — the only place walgit destroys anything.
 *
 * Two kinds of garbage accumulate, and they are collected together because
 * they share the one mechanism that makes deletion safe: nothing is removed
 * until it has been provably unreferenced for longer than the slowest restore
 * could possibly take.
 *
 *   - **Superseded entries.** Compaction advanced the frontier past them and
 *     tombstoned their keys. A restore that read `index.json` a moment before
 *     that compare-and-swap is still downloading them.
 *   - **Orphans.** A push uploads its pack in `pre-receive` and can still lose
 *     the compare-and-swap at `reference-transaction`; the upload is not
 *     unwound, so the WAL prefix holds objects `index.json` never named. See
 *     `orphans.ts` for why they are discovered rather than recorded.
 *
 * The asymmetry to hold on to: over-retaining costs storage, and
 * under-retaining loses data with no error anywhere. Every judgement call in
 * this file therefore resolves toward keeping the object. An orphan whose age
 * cannot be determined is never collected.
 */

import { configuredGraceMs } from './compact'
import { findOrphans } from './orphans'
import type { ObjectStore } from './store'
import { ulidTime } from './ulid'
import { loadIndex, updateIndex, type WalIndex } from './wal-index'

export interface GcResult {
  /** Superseded keys whose grace period elapsed, now deleted. */
  collected: string[]
  /** Tombstoned keys still inside their grace period. */
  retained: string[]
  /** Unreferenced uploads older than the grace period, now deleted. */
  orphansCollected: string[]
  /** Unreferenced uploads too young, or too unreadable, to collect yet. */
  orphansHeld: string[]
}

export interface GcOptions {
  now?: () => Date
  graceMs?: number
  /** Report what would be deleted without deleting anything. */
  dryRun?: boolean
}

/** The `.idx` uploaded beside a pack. Deleted with it, never separately. */
function siblingIdx(key: string): string {
  return key.replace(/\.pack$/, '.idx')
}

/**
 * The upload time encoded in a WAL key's ULID, or null when the key does not
 * carry one. Null is the "leave it alone" answer, not the "it is ancient" one.
 */
export function keyAgeMs(key: string, now: number): number | null {
  const stem =
    key
      .split('/')
      .pop()
      ?.replace(/\.(pack|idx)$/, '') ?? ''
  const id = stem.includes('-') ? stem.slice(stem.indexOf('-') + 1) : ''
  const time = id ? ulidTime(id) : null
  return time === null ? null : now - time
}

/**
 * Delete what is safely deletable for one repository.
 *
 * Tombstones are cleared before orphans are scanned, and in that order for a
 * reason: a tombstoned key is removed from `index.json` first and deleted from
 * the store second, so a crash between the two leaves an ORPHAN — which the
 * second half of this same function reclaims on its next run. The reverse
 * order would leave `index.json` naming an object that is gone, which is a
 * broken repository rather than a recoverable one.
 */
export async function collectGarbage(
  store: ObjectStore,
  repoId: string,
  opts: GcOptions = {},
): Promise<GcResult> {
  const now = (opts.now ?? (() => new Date()))()
  const graceMs = opts.graceMs ?? configuredGraceMs()

  const { index } = await loadIndex(store, repoId)
  const tombstones = index.tombstones ?? []
  const due = tombstones.filter((t) => Date.parse(t.collect_after) <= now.getTime())
  const retained = tombstones.filter((t) => Date.parse(t.collect_after) > now.getTime())

  const collected: string[] = []
  if (due.length > 0 && !opts.dryRun) {
    const dueKeys = new Set(due.map((t) => t.key))
    // Re-derived inside `mutate` rather than captured, because `updateIndex`
    // re-runs it against a freshly read index on every attempt — a push may
    // have landed since, and its entry must survive.
    const committed = await updateIndex(store, repoId, (current): WalIndex => {
      const stillDue = (current.tombstones ?? []).filter((t) => dueKeys.has(t.key))
      const keys = new Set(stillDue.map((t) => t.key))
      return {
        ...current,
        entries: current.entries.filter(
          (entry) => !(keys.has(entry.key) && entry.seq <= current.compaction_frontier),
        ),
        tombstones: (current.tombstones ?? []).filter((t) => !keys.has(t.key)),
      }
    })
    if (!committed.ok) {
      throw new Error(`walgit: gc for ${repoId} could not update the index; nothing was deleted`)
    }
    for (const t of due) {
      await store.delete(t.key)
      await store.delete(siblingIdx(t.key))
      collected.push(t.key)
    }
  }

  const orphansCollected: string[] = []
  const orphansHeld: string[] = []
  for (const key of await findOrphans(store, repoId)) {
    const age = keyAgeMs(key, now.getTime())
    // An object uploaded seconds ago may belong to a push still in flight —
    // its `pre-receive` has run and its compare-and-swap has not. Collecting
    // it would corrupt a push that is about to succeed.
    if (age === null || age < graceMs) {
      orphansHeld.push(key)
      continue
    }
    if (!opts.dryRun) await store.delete(key)
    orphansCollected.push(key)
  }

  return {
    collected: opts.dryRun ? due.map((t) => t.key) : collected,
    retained: retained.map((t) => t.key),
    orphansCollected,
    orphansHeld,
  }
}
