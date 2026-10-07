/**
 * Filesystem snapshots of the container: when one is taken, and when one is
 * trusted enough to start from.
 *
 * A cold start used to cost two things — the container booting, and every
 * repository it was asked for being materialized from the log onto an empty
 * disk. On agentgit that was 12–22 s, and the second half was most of it. The
 * `durable_object` scheduling policy can snapshot a running container's root
 * filesystem and start a later one from it, so the Durable Object snapshots on
 * its way to the idle stop and the next start restores the Cache the last one
 * left (`WalgitDurableContainer`, worker/durable-container.ts).
 *
 * WHY THIS IS SAFE is the Cache's own definition, not anything here. The disk
 * is reconciled against `index.json` on every access (src/sync.ts): the Index
 * is read in full every time, refs are rewritten to match it whatever the disk
 * believed (src/reconcile.ts), and objects a ref needs that the disk lacks are
 * materialized. So a restored disk can be minutes or weeks behind the log and
 * the only thing that varies is how much a first access downloads — a stale
 * snapshot costs a re-sync and can never serve a stale ref. What a disk carries
 * that is NOT reconciled — the hand-off records of a push killed mid-flight, a
 * materialize lock — is cleared by the process at boot, before it serves
 * anything (src/boot-residue.ts).
 *
 * Public beta when this was written, which is why it is a switch rather than
 * the behaviour: `WALGIT_SNAPSHOTS`, off unless set, edge-only. Off means every
 * start is the cold start walgit was built for, which is still correct.
 */

import { fingerprintEnv } from './container-env'
import { flagEnabled } from './policy'

/** `1` or `true` turns snapshots on, like every walgit flag (`shared/policy.ts`). */
export function snapshotsEnabled(env: { WALGIT_SNAPSHOTS?: string }): boolean {
  return flagEnabled(env.WALGIT_SNAPSHOTS)
}

/**
 * What the Durable Object keeps about its one snapshot.
 *
 * The platform has no way to list snapshots, so this record is the only place
 * one is remembered — and with it, the two facts that decide whether it may be
 * restored at all.
 */
export interface SnapshotRecord {
  /** The handle's id — what `start({ containerSnapshot })` is given. */
  id: string
  /** Bytes, as the platform reported them. */
  size: number
  /**
   * The image reference the snapshotted container booted from. A snapshot is
   * tied to its image version and is not portable to another one.
   */
  image: string
  /** Which log the Cache on this disk was reconciled against (`storeIdentity`). */
  store: string
  takenAt: number
  /** Creation, or the most recent restore — the platform's TTL runs from here. */
  refreshedAt: number
}

/**
 * How long the platform keeps a snapshot nobody restores: 30 days from
 * creation or from the last restore, not configurable.
 */
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A day short of the TTL. A restore that names an expired snapshot does not
 * fail cheaply — it fails as a container that never comes up, after the
 * readiness wait — so a record near the edge is treated as gone.
 */
const TTL_MARGIN_MS = 24 * 60 * 60 * 1000

/**
 * The largest snapshot worth restoring: half of `CONTAINER_INSTANCE`'s 8 GB.
 *
 * The bound is on the disk, not on the platform (whose limit is 20 GB). Before
 * snapshots the Cache was emptied by every sleep, which was also the only thing
 * that ever emptied it; restored, it grows to whatever the deployment serves.
 * A disk that is half Cache before the first request leaves the other half for
 * the pushes and materializations that follow, and one past that is started
 * fresh instead — the cold start walgit always paid, once, after which the
 * snapshots are small again.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1000 * 1000 * 1000

/**
 * Which log a Cache was built against, as a short digest.
 *
 * Part of the identity because the disk is a cache OF a log: pointed at another
 * bucket, reconcile would still make the refs right, but packs named after the
 * old log's WAL keys would be on a disk that has nothing to do with the new one.
 * Starting fresh is the honest answer when the log moved.
 */
export function storeIdentity(env: {
  WALGIT_S3_ENDPOINT?: string
  WALGIT_S3_BUCKET?: string
}): string {
  return fingerprintEnv({
    endpoint: env.WALGIT_S3_ENDPOINT ?? '',
    bucket: env.WALGIT_S3_BUCKET ?? '',
  })
}

/** Why a start is not from the snapshot. Logged, so each is its own word. */
export type FreshReason =
  | 'disabled'
  | 'none'
  | 'other-image'
  | 'other-store'
  | 'expired'
  | 'too-large'

export type RestorePlan = { from: 'snapshot'; id: string } | { from: 'image'; reason: FreshReason }

/**
 * Start from the snapshot, or from the image?
 *
 * The snapshot only when every one of these holds, in this order: snapshots
 * are on; one is recorded; it was taken from the image this deploy would start
 * (a snapshot from another image is not portable to this one, and must not be
 * tried); its Cache was built against this log; the platform still has it; and
 * it is small enough to leave the disk room. Anything else is a fresh start,
 * which is never wrong — only slower.
 */
export function restorePlan(state: {
  enabled: boolean
  record: SnapshotRecord | null
  image: string
  store: string
  now: number
}): RestorePlan {
  const { enabled, record, image, store, now } = state
  if (!enabled) return { from: 'image', reason: 'disabled' }
  if (!record) return { from: 'image', reason: 'none' }
  if (record.image !== image) return { from: 'image', reason: 'other-image' }
  if (record.store !== store) return { from: 'image', reason: 'other-store' }
  if (now - record.refreshedAt >= SNAPSHOT_TTL_MS - TTL_MARGIN_MS) {
    return { from: 'image', reason: 'expired' }
  }
  if (record.size > SNAPSHOT_MAX_BYTES) return { from: 'image', reason: 'too-large' }
  return { from: 'snapshot', id: record.id }
}

/**
 * Is the running container worth snapshotting on its way to a stop?
 *
 * Only one that booted from the image this deploy would start — directly, or
 * from a snapshot of that image. One booted from anything older would produce a
 * snapshot `restorePlan` refuses on sight, which costs the time it takes and
 * replaces a record that might still be good.
 */
export function shouldSnapshot(state: {
  enabled: boolean
  bootedImage: string | null
  image: string
}): boolean {
  return state.enabled && state.bootedImage !== null && state.bootedImage === state.image
}

/**
 * Where the container marks its own boot, and what the marker holds.
 *
 * Written by `src/server.ts` once boot residue is cleared and before the port
 * opens, holding the repos directory's path. Every file the cache changes after
 * that is newer than the marker, which is how a stop asks "did anything change
 * since this disk was restored?" without the Durable Object knowing where the
 * cache lives. In `/tmp` and rewritten on every boot, so the copy a snapshot
 * carries is always replaced before it could be compared against.
 */
export const BOOT_MARKER = '/tmp/walgit-booted'

/**
 * The command that answers it: prints a changed path, or nothing.
 *
 * `head -1` rather than `find -quit`, which busybox's `find` may not have.
 * Paths are taken from the marker, so this never names the cache directly.
 */
export const DISK_CHANGED_COMMAND = [
  'sh',
  '-c',
  `find "$(cat ${BOOT_MARKER})" -newer ${BOOT_MARKER} | head -1`,
]

/**
 * Does this stop need a new snapshot, or does the one it booted from still hold?
 *
 * A container booted from a snapshot whose cache did not change since has
 * nothing new to save: the record it restored is the same disk, and taking
 * another costs seconds on every stop — which, with a short idle timeout, is
 * most of what a quiet deployment does. Anything uncertain snapshots: a fresh
 * boot from the image, or a change check that could not answer (`null`).
 */
export function needsNewSnapshot(state: {
  bootedFrom: 'snapshot' | 'image' | null
  changed: boolean | null
}): boolean {
  return state.bootedFrom !== 'snapshot' || state.changed !== false
}

/** The record a fresh snapshot handle becomes. */
export function recordSnapshot(
  handle: { id: string; size: number },
  context: { image: string; store: string; now: number },
): SnapshotRecord {
  return {
    id: handle.id,
    size: handle.size,
    image: context.image,
    store: context.store,
    takenAt: context.now,
    refreshedAt: context.now,
  }
}

/** The same record after a successful restore, which restarts the TTL. */
export function refreshSnapshot(record: SnapshotRecord, now: number): SnapshotRecord {
  return { ...record, refreshedAt: now }
}
