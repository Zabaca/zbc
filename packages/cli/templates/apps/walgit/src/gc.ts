/**
 * Reclaim the WAL objects nothing references.
 *
 * `orphans.ts` finds them by diffing the WAL prefix against `index.json`; this
 * is the half that deletes, and it is separated from the finding because
 * deletion from the source of truth deserves its own guards:
 *
 *   - **Dry run is the default.** The caller has to say `collect: true`. An
 *     operator reaching for `gc` on a bad day should be able to look before
 *     anything is gone.
 *   - **An orphan younger than `minAgeMs` is never collected.** The push path
 *     uploads a pack BEFORE it publishes it — that ordering is the whole design
 *     — so between the upload and the compare-and-swap a perfectly good pack is
 *     indistinguishable from a rejected one. Deleting inside that window fails a
 *     push that was about to succeed. The age comes from the ULID in the key
 *     (see `ulidTime`), so it costs no extra round trip.
 *   - **An orphan whose age cannot be read is never collected.** A key that does
 *     not parse is a key this code does not understand, and the safe thing to do
 *     with an object you do not understand in the source of truth is leave it.
 *
 * What is NOT here: reclaiming entries below `compaction_frontier`. Those are
 * superseded rather than orphaned, and they only become superseded because a
 * compaction wrote a replacement — so they belong with compaction, which owns
 * both halves of that trade.
 */

import { findOrphans } from './orphans'
import type { ObjectStore } from './store'
import { ulidTime } from './ulid'

/** One hour: far wider than any push, far narrower than "never reclaimed". */
export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000

export interface CollectOptions {
  /** Delete. Without it nothing is removed and the result is a preview. */
  collect?: boolean
  minAgeMs?: number
  now?: number
}

export interface CollectResult {
  repoId: string
  /** Orphans old enough to reclaim — deleted when `collect`, listed otherwise. */
  collectable: string[]
  /** Orphans held back, with why: too young, or an age that could not be read. */
  retained: { key: string; reason: 'too-young' | 'age-unknown' }[]
  deleted: number
  dryRun: boolean
}

/**
 * The age of a WAL object, from the ULID in its key.
 *
 * Keys are `repos/{id}/wal/{seq:012d}-{ulid}.{ext}` — see `walKey`.
 */
export function orphanAgeMs(key: string, now: number): number | null {
  const stem =
    key
      .split('/')
      .pop()
      ?.replace(/\.(pack|idx)$/, '') ?? ''
  const ulid = stem.slice(stem.indexOf('-') + 1)
  const minted = ulidTime(ulid)
  if (minted === null) return null
  return now - minted
}

export async function collectOrphans(
  store: ObjectStore,
  repoId: string,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const { collect = false, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now() } = options

  const orphans = await findOrphans(store, repoId)
  const collectable: string[] = []
  const retained: CollectResult['retained'] = []
  for (const key of orphans) {
    const age = orphanAgeMs(key, now)
    if (age === null) retained.push({ key, reason: 'age-unknown' })
    else if (age < minAgeMs) retained.push({ key, reason: 'too-young' })
    else collectable.push(key)
  }

  let deleted = 0
  if (collect) {
    // Serially, not in parallel: this runs against the store that also carries
    // every live push, and a burst of deletes is not worth the seconds it saves
    // on an operation nobody is waiting on.
    for (const key of collectable) {
      await store.delete(key)
      deleted += 1
    }
  }

  return { repoId, collectable, retained, deleted, dryRun: !collect }
}
