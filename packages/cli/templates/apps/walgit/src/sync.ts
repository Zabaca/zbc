/**
 * Bring a cached repo up to date with the log before serving it.
 *
 * Called on every access, not on a timer: the disk is a cache with no
 * invalidation of its own, and a node that serves what it happens to hold is a
 * node that answers a fetch with refs another node published over. The cost is
 * one conditional GET of `index.json`, which answers `304` in the common case.
 */

import type { ObjectStore } from './store'
import type { ResolvedRepo } from './repo'
import { reconcile, type ReconcileResult } from './reconcile'
import { loadIndex } from './wal-index'

export async function syncRepo(
  store: ObjectStore | null,
  repo: ResolvedRepo,
): Promise<ReconcileResult | null> {
  // No store means no log: this deployment is disk-only, and there is nothing
  // to reconcile against. The push path refuses separately rather than here,
  // because reading a stale cache is survivable and acknowledging an
  // unpersisted push is not.
  if (!store) return null
  const { index } = await loadIndex(store, repo.repoId)
  return reconcile(repo.dir, index)
}
