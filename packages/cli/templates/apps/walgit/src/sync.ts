/**
 * Bring a cached repo up to date with the log before serving it.
 *
 * Called on every access, not on a timer: the disk is a cache with no
 * invalidation of its own, and a node that serves what it happens to hold is a
 * node that answers a fetch with refs another node published over. The cost is
 * one conditional GET of `index.json`, which answers `304` in the common case.
 *
 * There are two ways the cache can be behind, and this is the one place that
 * decides between them:
 *
 *   - **Refs disagree, objects are present** — reconcile. One `packed-refs`
 *     write, no network beyond the index read.
 *   - **The objects themselves are absent** — materialize. Reconcile reports a
 *     ref it will not write because the object is missing, and that report is
 *     exactly the signal that the WAL has to be replayed.
 *
 * A cold disk is only the extreme of the second case: every ref is missing, so
 * every entry above the compaction frontier is fetched. A warm disk pays a
 * `readdir` and nothing else, which is why the restore path can sit on every
 * request rather than behind a flag.
 */

import type { ObjectStore } from '../shared/store'
import type { ResolvedRepo } from './repo'
import { ensureHead, isPartial, materialize, type MaterializeStats } from './materialize'
import { reconcile, type ReconcileResult } from './reconcile'
import { loadIndex } from '../shared/wal-index'

export type SyncResult = ReconcileResult & {
  /** Present only when the WAL was actually replayed onto this disk. */
  materialize?: MaterializeStats
}

export async function syncRepo(
  store: ObjectStore | null,
  repo: ResolvedRepo,
): Promise<SyncResult | null> {
  // No store means no log: this deployment is disk-only, and there is nothing
  // to reconcile against. The push path refuses separately rather than here,
  // because reading a stale cache is survivable and acknowledging an
  // unpersisted push is not.
  if (!store) return null
  const { index } = await loadIndex(store, repo.repoId)
  const reconciled = reconcile(repo.dir, index)

  // `isPartial` covers the case reconcile cannot see: an interrupted restore
  // that happened to finish placing the packs its refs need, but died before
  // the rest. The marker is the only evidence, so it is trusted over the refs.
  if (reconciled.missing.length === 0 && !isPartial(repo.dir)) {
    // HEAD as well as the refs, on every access and not only on a restore: a
    // push moves refs without touching HEAD, so a first push of `feature`
    // leaves it on the unborn `main` `git init` chose until something points
    // it at the Default Branch — and the edge, answering `ls-refs` from the
    // Index, already reports that branch (`shared/edge-refs.ts`).
    ensureHead(repo.dir, index.refs)
    return reconciled
  }

  const result = await materialize(store, repo, index)
  return { ...result.reconciled, materialize: result.stats }
}
