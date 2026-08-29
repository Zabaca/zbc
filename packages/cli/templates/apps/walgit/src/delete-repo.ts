/**
 * Deleting a whole repository — the only thing in walgit that destroys data on
 * purpose.
 *
 * Everything else that removes anything (`gc.ts`) removes only what is
 * provably unreferenced. This removes what IS referenced, which is why it
 * inherits that file's discipline rather than inventing a faster one:
 *
 *   - **Deferred, not immediate.** The first call tombstones the repository by
 *     writing a `deletion` marker into `index.json`; nothing is removed until a
 *     later call finds that marker's `collect_after` in the past. A clone that
 *     read the index a moment before the request is still downloading the packs
 *     it names, and cutting it off fails it with a missing object — the silent
 *     failure mode docs/adr/0007 ranks as risk #2.
 *   - **Record first, objects second.** Collection deletes `index.json` before
 *     it deletes anything the index names. A crash between the two leaves
 *     unreferenced objects under the WAL prefix — which is exactly what
 *     `findOrphans` discovers and `collectGarbage` reclaims. The reverse order
 *     would leave an index naming objects that are gone, which is a broken
 *     repository rather than a recoverable one.
 *   - **Dry run by default.** This is the operator surface for destruction, so
 *     the safe direction is to print.
 *
 * It takes a repo id and nothing else. Deciding WHICH repositories should go —
 * expiry — is a separate concern and a separate caller.
 */

import * as fs from 'node:fs'

import type { ObjectStore } from './store'
import { indexKey, loadIndex, updateIndex, type WalIndex } from './wal-index'

/**
 * How long a repository sits tombstoned before its objects may be deleted.
 *
 * Its own knob rather than the collector's: compaction's grace covers the
 * slowest restore of a live repository, while this covers a clone of a
 * repository someone has decided to remove. The timescales are unrelated, and
 * tying them together would mean tuning one to fix the other.
 */
export const DEFAULT_DELETE_GRACE_MS = 60 * 60 * 1000

export function configuredDeleteGraceMs(env = process.env): number {
  const raw = Number(env.WALGIT_DELETE_GRACE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELETE_GRACE_MS
}

export type DeleteStatus =
  /** Nothing under this repo's prefix and no index: there was nothing to do. */
  | 'absent'
  /** The marker was written (or would be); the grace period starts now. */
  | 'tombstoned'
  /** Already marked, still inside the grace period. Nothing was removed. */
  | 'retained'
  /** The grace period elapsed; the index and every object under it are gone. */
  | 'collected'

export interface RetainedObject {
  key: string
  /** Why this object is still here — the question an operator arrives with. */
  reason: string
}

export interface DeleteResult {
  repoId: string
  status: DeleteStatus
  /** Keys deleted, or — under a dry run — the keys that would be. */
  deleted: string[]
  /** Keys deliberately kept, each with the reason it was kept. */
  retained: RetainedObject[]
  /** When the objects become collectable. Absent for `absent`. */
  collectAfter?: string
  /** The cached bare repo removed from disk, when one was named and existed. */
  cacheRemoved?: string
  dryRun: boolean
}

export interface DeleteOptions {
  now?: () => Date
  graceMs?: number
  /**
   * Nothing is removed and no marker is written unless this is false. Dry run
   * is the default so `--yes` is a word the operator has to type.
   */
  dryRun?: boolean
  /** The bare repo on disk to remove once the log has let go of it. */
  dir?: string
}

/** Everything walgit stores for one repository lives under this prefix. */
export function repoPrefix(repoId: string): string {
  return `repos/${repoId}/`
}

/**
 * Schedule a repository for deletion, or — once its grace period has elapsed —
 * carry that deletion out.
 *
 * Idempotent in both halves: asking twice inside the grace period does not
 * move `collect_after`, and asking twice after collection reports `absent`.
 */
export async function deleteRepo(
  store: ObjectStore,
  repoId: string,
  opts: DeleteOptions = {},
): Promise<DeleteResult> {
  const now = (opts.now ?? (() => new Date()))()
  const graceMs = opts.graceMs ?? configuredDeleteGraceMs()
  const dryRun = opts.dryRun !== false

  const [{ index, etag }, keys] = await Promise.all([
    loadIndex(store, repoId),
    store.list(repoPrefix(repoId)),
  ])

  // No index and nothing under the prefix: there is no repository here. This
  // is a no-op rather than an error because the caller that will drive this —
  // expiry — races with an operator doing the same thing by hand.
  if (etag === null && keys.length === 0) {
    return { repoId, status: 'absent', deleted: [], retained: [], dryRun }
  }

  // Objects without an index are already orphans by `orphans.ts`'s definition,
  // and reclaiming those is the collector's job, not this one's. Writing a
  // marker here would resurrect an `index.json` for a repository that has
  // none — the opposite of what was asked for.
  if (etag === null) {
    return {
      repoId,
      status: 'absent',
      deleted: [],
      retained: keys.map((key) => ({
        key,
        reason: 'no index.json — already an orphan, reclaimed by `walgit gc`',
      })),
      dryRun,
    }
  }

  const existing = index.deletion
  if (!existing) {
    const collectAfter = new Date(now.getTime() + graceMs).toISOString()
    if (!dryRun) {
      const committed = await updateIndex(
        store,
        repoId,
        (current): WalIndex => ({
          ...current,
          // Re-read inside the mutation: a delete that raced another one must
          // keep the FIRST request's deadline, never restart the clock.
          deletion: current.deletion ?? {
            requested_at: now.toISOString(),
            collect_after: collectAfter,
          },
        }),
      )
      if (!committed.ok) {
        throw new Error(
          `walgit: delete for ${repoId} could not update the index; nothing was changed`,
        )
      }
      return {
        repoId,
        status: 'tombstoned',
        deleted: [],
        retained: keys.map((key) => ({
          key,
          reason: `scheduled for deletion after ${committed.index.deletion?.collect_after}`,
        })),
        collectAfter: committed.index.deletion?.collect_after,
        dryRun,
      }
    }
    return {
      repoId,
      status: 'tombstoned',
      deleted: [],
      retained: keys.map((key) => ({
        key,
        reason: `would be scheduled for deletion after ${collectAfter}`,
      })),
      collectAfter,
      dryRun,
    }
  }

  if (Date.parse(existing.collect_after) > now.getTime()) {
    return {
      repoId,
      status: 'retained',
      deleted: [],
      retained: keys.map((key) => ({
        key,
        reason: `inside the deletion grace period until ${existing.collect_after}`,
      })),
      collectAfter: existing.collect_after,
      dryRun,
    }
  }

  if (dryRun) {
    return {
      repoId,
      status: 'collected',
      deleted: keys,
      retained: [],
      collectAfter: existing.collect_after,
      dryRun,
    }
  }

  // The record goes first. From here on the objects are unreferenced, so a
  // crash at any point below leaves orphans the collector reclaims — never an
  // index naming an object that is gone.
  await store.delete(indexKey(repoId))
  const deleted = [indexKey(repoId)]
  for (const key of keys) {
    if (key === indexKey(repoId)) continue
    await store.delete(key)
    deleted.push(key)
  }

  // The disk is a cache and the log has just stopped describing it, so this is
  // last and its failure is not fatal to the deletion: a cache left behind is
  // reclaimable, whereas a half-deleted log is not.
  let cacheRemoved: string | undefined
  if (opts.dir && fs.existsSync(opts.dir)) {
    fs.rmSync(opts.dir, { recursive: true, force: true })
    cacheRemoved = opts.dir
  }

  return {
    repoId,
    status: 'collected',
    deleted,
    retained: [],
    collectAfter: existing.collect_after,
    cacheRemoved,
    dryRun,
  }
}
