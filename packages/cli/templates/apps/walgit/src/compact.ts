/**
 * Compaction: collapse the write-ahead log back down to one entry.
 *
 * Restore replays every WAL entry above the compaction frontier, so without
 * this, restore latency grows linearly with the number of pushes a repository
 * has ever taken — and the disk-is-a-cache premise dies with it, because a
 * cache you cannot cheaply rebuild is a disk you cannot afford to lose. Git
 * degrades on the same axis for its own reason: every object lookup may open
 * every pack index.
 *
 * The operation is a REPACK, never a rewrite. `git repack -adf` produces a
 * single pack containing everything reachable from the refs `index.json`
 * publishes; the history it encodes is identical, object for object, which is
 * why "restore from before, during and after a compaction" must produce the
 * same `git log`. Nothing here ever touches `refs`.
 *
 * Two safety properties carry the whole file:
 *
 *   - **The lease, not optimism, is what makes one node compact.** Two nodes
 *     repacking the same repository would both upload a full copy of it and
 *     both advance the frontier, and the loser's CAS would tombstone entries
 *     the winner's pack does not contain. With one replica per repository the
 *     lease is nearly free today; it is what lets replicas arrive later.
 *   - **Superseded entries are tombstoned, never deleted here.** The CAS is
 *     instantaneous and a restore that read the previous index is not. See
 *     `Tombstone` in `wal-index.ts` and `gc.ts`, which does the deleting a
 *     grace period later.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { materialize, packBasename } from './materialize'
import { sha256 } from './push'
import type { ResolvedRepo } from './repo'
import type { ObjectStore } from './store'
import { ulid } from './ulid'
import {
  loadIndex,
  updateIndex,
  walKey,
  type Tombstone,
  type WalEntry,
  type WalIndex,
} from './wal-index'

/**
 * How many un-superseded entries a repository may accumulate before it is
 * compacted. 50 is the design's starting point: high enough that a burst of
 * pushes does not repack the world repeatedly, low enough that a cold restore
 * never replays more than fifty packs.
 */
export const DEFAULT_THRESHOLD = 50

/**
 * How long a superseded object outlives the compare-and-swap that superseded
 * it. It must exceed the slowest plausible restore by a wide margin — the cost
 * of being generous is storage, and the cost of being tight is a silently
 * failed restore, so this is deliberately lopsided.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000

/** How long a compaction may hold its lease before another node may steal it. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000

export function configuredThreshold(env = process.env): number {
  const raw = Number(env.WALGIT_COMPACTION_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD
}

export function configuredGraceMs(env = process.env): number {
  const raw = Number(env.WALGIT_GC_GRACE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GRACE_MS
}

/** Entries a restore would have to replay right now. */
export function pendingEntries(index: WalIndex): WalEntry[] {
  return index.entries.filter((entry) => entry.seq > index.compaction_frontier)
}

/**
 * Below two pending entries there is nothing to win: compacting one entry into
 * one entry re-uploads the whole repository to save a restore exactly nothing.
 */
export function isCompactionDue(index: WalIndex, threshold = configuredThreshold()): boolean {
  return pendingEntries(index).length >= Math.max(2, threshold)
}

// ── The lease ───────────────────────────────────────────────────────────────

export function leaseKey(repoId: string): string {
  return `repos/${repoId}/compaction.lease`
}

interface Lease {
  holder: string
  acquired: string
  expires: string
}

function leaseBody(lease: Lease): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(lease, null, 2)}\n`)
}

export type LeaseResult =
  | { ok: true; release: () => Promise<void> }
  /** Another node is compacting this repository. Not an error — decline. */
  | { ok: false; reason: 'held'; holder: string }

/**
 * Take the per-repository compaction lease.
 *
 * The lease EXPIRES because the holder is a process on a machine Fly may stop
 * at any moment: a lease that only a graceful release could clear would wedge
 * compaction for a repository permanently, and the failure would present as
 * restores quietly getting slower forever. Stealing an expired lease is a
 * compare-and-swap against the lease object's own ETag, so two nodes noticing
 * the same expiry cannot both take it.
 */
export async function acquireLease(
  store: ObjectStore,
  repoId: string,
  opts: { holder: string; now?: Date; ttlMs?: number },
): Promise<LeaseResult> {
  const now = opts.now ?? new Date()
  const ttl = opts.ttlMs ?? DEFAULT_LEASE_MS
  const key = leaseKey(repoId)
  const lease: Lease = {
    holder: opts.holder,
    acquired: now.toISOString(),
    expires: new Date(now.getTime() + ttl).toISOString(),
  }

  const current = await store.get(key)
  const release = async () => {
    // Only the holder clears it: a node whose lease already expired and was
    // stolen must not delete the thief's.
    const held = await store.get(key)
    if (!held) return
    try {
      const parsed = JSON.parse(new TextDecoder().decode(held.body)) as Lease
      if (parsed.holder !== opts.holder) return
    } catch {
      return
    }
    await store.delete(key)
  }

  if (!current) {
    const put = await store.put(key, leaseBody(lease), { ifAbsent: true })
    return put.ok ? { ok: true, release } : { ok: false, reason: 'held', holder: 'unknown' }
  }

  let existing: Lease | null = null
  try {
    existing = JSON.parse(new TextDecoder().decode(current.body)) as Lease
  } catch {
    existing = null
  }
  // An unparseable lease is treated as expired rather than as permanent: it is
  // a corrupted object, and refusing to compact forever is the worse outcome.
  if (existing && Date.parse(existing.expires) > now.getTime()) {
    return { ok: false, reason: 'held', holder: existing.holder }
  }

  const put = await store.put(key, leaseBody(lease), { ifMatch: current.etag })
  return put.ok
    ? { ok: true, release }
    : { ok: false, reason: 'held', holder: existing?.holder ?? 'unknown' }
}

// ── Compaction ──────────────────────────────────────────────────────────────

export type CompactResult =
  | {
      status: 'compacted'
      /** The seq the new compaction entry landed at. */
      seq: number
      /** Entries at or below this are now superseded. */
      supersedes_through: number
      /** Keys tombstoned by this compaction. */
      tombstoned: string[]
      bytes: number
      ms: number
    }
  | { status: 'not-due'; pending: number }
  | { status: 'held'; holder: string }
  /** The repack produced no pack: an empty repository has nothing to compact. */
  | { status: 'empty' }

export interface CompactOptions {
  /** Identifies this node in the lease. Defaults to hostname:pid. */
  holder?: string
  threshold?: number
  graceMs?: number
  leaseMs?: number
  now?: () => Date
  /** Compact even when the threshold is not met. The CLI's `--force`. */
  force?: boolean
}

/**
 * Repack `repo` and publish the result as a single WAL entry.
 *
 * The repository must be materialized first — `repack` packs what is on disk,
 * so repacking a partially restored cache would publish a pack missing objects
 * the log says exist, and the frontier advance would then make that loss
 * permanent. `materialize` is idempotent and near-free on a warm repo, so this
 * is a check, not a cost.
 */
export async function compact(
  store: ObjectStore,
  repo: ResolvedRepo,
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const startedAt = performance.now()
  const now = opts.now ?? (() => new Date())
  const graceMs = opts.graceMs ?? configuredGraceMs()

  const { index } = await loadIndex(store, repo.repoId)
  if (!opts.force && !isCompactionDue(index, opts.threshold ?? configuredThreshold())) {
    return { status: 'not-due', pending: pendingEntries(index).length }
  }

  const holder = opts.holder ?? `${process.env.FLY_MACHINE_ID ?? 'local'}:${process.pid}`
  const lease = await acquireLease(store, repo.repoId, {
    holder,
    now: now(),
    ttlMs: opts.leaseMs,
  })
  if (!lease.ok) return { status: 'held', holder: lease.holder }

  try {
    await materialize(store, repo, index)

    // Everything at or below the seq we read is what this repack subsumes.
    // Pushes landing while we repack append above it and are untouched — which
    // is why the snapshot is taken here and not re-read after.
    const supersedesThrough = index.seq

    const packDir = path.join(repo.dir, 'objects', 'pack')
    run('git', ['--git-dir', repo.dir, 'repack', '-adfq'])

    const onDisk = fs.readdirSync(packDir)
    // A cruft pack is not a second copy of the repository — it is git's
    // holding pen for UNREACHABLE objects, marked by a sibling `.mtimes`, and
    // `git repack -adf` never writes one (it drops unreachable objects
    // instead). One can still be lying here from a `git gc` that ran before
    // this repo learned to refuse them, and counting it as a kept-back pack
    // would make compaction refuse this repository forever.
    const isCruft = (pack: string) => onDisk.includes(`${pack.replace(/\.pack$/, '')}.mtimes`)
    const packs = onDisk.filter((f) => f.endsWith('.pack') && !isCruft(f))
    if (packs.length === 0) return { status: 'empty' }
    // `-a -d` collapses to exactly one pack. More than one means something on
    // this disk kept a pack back (a `.keep`), and uploading only part of the
    // repository would be published data loss, so refuse loudly instead.
    if (packs.length > 1) {
      throw new Error(
        `walgit: repack of ${repo.repoId} left ${packs.length} packs (${packs.join(', ')}); ` +
          'refusing to publish a partial compaction',
      )
    }
    const produced = packs[0]!

    const packPath = path.join(packDir, produced)
    const packBody = new Uint8Array(fs.readFileSync(packPath))
    const idxPath = packPath.replace(/\.pack$/, '.idx')
    const idxBody = fs.existsSync(idxPath) ? new Uint8Array(fs.readFileSync(idxPath)) : null

    const id = ulid(now().getTime())
    const key = walKey(repo.repoId, supersedesThrough + 1, id, 'pack')
    await store.put(key, packBody)
    if (idxBody) await store.put(walKey(repo.repoId, supersedesThrough + 1, id, 'idx'), idxBody)

    const entryBase: Omit<WalEntry, 'seq'> = {
      key,
      kind: 'compaction',
      size: packBody.byteLength,
      sha256: sha256(packBody),
      ts: now().toISOString(),
      supersedes_through: supersedesThrough,
    }

    const collectAfter = new Date(now().getTime() + graceMs).toISOString()
    let landedSeq = 0
    let tombstoned: string[] = []

    // `updateIndex`, not `commitIndex`: unlike the push path a loss here is not
    // a client-visible rejection, it is a concurrent push that must simply be
    // re-read and re-merged. Only the frontier and the entry list move; `refs`
    // is carried through untouched from whatever the freshest read said.
    const committed = await updateIndex(store, repo.repoId, (current) => {
      const seq = current.seq + 1
      landedSeq = seq
      const already = new Set((current.tombstones ?? []).map((t) => t.key))
      const fresh: Tombstone[] = current.entries
        .filter((entry) => entry.seq <= supersedesThrough && !already.has(entry.key))
        .map((entry) => ({
          key: entry.key,
          superseded_by: seq,
          collect_after: collectAfter,
        }))
      tombstoned = fresh.map((t) => t.key)
      return {
        ...current,
        seq,
        entries: [...current.entries, { ...entryBase, seq }],
        compaction_frontier: Math.max(current.compaction_frontier, supersedesThrough),
        tombstones: [...(current.tombstones ?? []), ...fresh],
      }
    })
    if (!committed.ok) {
      // The pack is uploaded but unpublished, which is exactly the shape of a
      // rejected push: `findOrphans` recovers it, so nothing leaks.
      throw new Error(`walgit: compaction of ${repo.repoId} lost the index CAS; entry is orphaned`)
    }

    // Rename the repack output to the name a restore would give it, so the
    // node that just compacted does not turn around and re-download its own
    // pack on the next materialize.
    adoptLocally(packDir, produced, packBasename({ ...entryBase, seq: landedSeq }))

    return {
      status: 'compacted',
      seq: landedSeq,
      supersedes_through: supersedesThrough,
      tombstoned,
      bytes: packBody.byteLength,
      ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
    }
  } finally {
    await lease.release()
  }
}

/**
 * Give the freshly repacked files the names `materialize` derives from the WAL
 * key, so the node that just compacted does not re-download its own pack.
 *
 * `.pack` moves before `.idx`, the same order `materialize` places them in and
 * for the same reason: git finds packs by scanning for `.idx` files, so an
 * index without its pack is the broken half, not the harmless one. Siblings
 * git generated under the old stem (`.rev`, `.bitmap`) are removed rather than
 * renamed — they are caches git rebuilds, and a stale one beside a renamed
 * pack is worse than none.
 */
function adoptLocally(packDir: string, produced: string, basename: string): void {
  const oldStem = produced.replace(/\.pack$/, '')
  if (oldStem === basename) return
  const siblings = fs.readdirSync(packDir).filter((f) => f.startsWith(`${oldStem}.`))
  const move = (ext: string) => {
    const from = path.join(packDir, `${oldStem}.${ext}`)
    if (fs.existsSync(from)) fs.renameSync(from, path.join(packDir, `${basename}.${ext}`))
  }
  move('pack')
  move('idx')
  for (const file of siblings) {
    if (file.endsWith('.pack') || file.endsWith('.idx')) continue
    fs.rmSync(path.join(packDir, file), { force: true })
  }
}

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr?.toString().trim()}`)
  }
}
