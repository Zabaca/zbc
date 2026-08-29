/**
 * Orphaned WAL objects.
 *
 * Every rejected push leaves one behind: `pre-receive` uploads the pack before
 * anything can fail, and a lost compare-and-swap at `reference-transaction`
 * then rejects the push without unwinding that upload. That is the correct
 * trade — the alternative is publishing before persisting — but it means the
 * WAL prefix always holds objects `index.json` does not reference.
 *
 * They are DISCOVERED rather than recorded: an orphan is any key under the
 * repo's WAL prefix that no index entry names. A tombstone written at rejection
 * time would be a write on the push path, in the exact window where a process
 * is most likely to be dying, and it would still miss the orphan left by a
 * crash before the tombstone. The diff misses nothing and costs nothing until
 * someone asks.
 *
 * Reclaiming them is the compaction milestone's job; this is the half the push
 * path owes it — the guarantee that a rejected push is findable, not silent
 * garbage.
 */

import { siblingIdx, walPrefix } from './keys'
import type { ObjectStore } from './store'
import { loadIndex } from './wal-index'

export interface Orphan {
  key: string
  /** Milliseconds since this object was uploaded, if the store reports it. */
  ageMs?: number
}

/**
 * Keys under the WAL prefix that `index.json` does not reference.
 *
 * A `.pack` is referenced by an entry directly; its sibling `.idx` is
 * referenced implicitly, so it is not an orphan while the pack is live.
 */
export async function findOrphans(store: ObjectStore, repoId: string): Promise<string[]> {
  const [{ index }, keys] = await Promise.all([
    loadIndex(store, repoId),
    store.list(walPrefix(repoId)),
  ])

  const live = new Set<string>()
  for (const entry of index.entries) {
    live.add(entry.key)
    live.add(siblingIdx(entry.key))
  }
  return keys.filter((key) => !live.has(key))
}
