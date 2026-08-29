/**
 * Cold materialize: rebuild a serving bare repo from the write-ahead log.
 *
 * This is the operation that makes "the repo on disk is a disposable cache"
 * true rather than aspirational. Given a `repo_id` and an empty disk, the log
 * is sufficient: `index.json` names every packfile still needed and the full
 * ref state that results from applying them.
 *
 * On Fly with `min_machines_running = 0` this is the NORMAL path, not disaster
 * recovery — an idle repo loses its machine routinely, so materialize runs on
 * ordinary first access after a pause. The restore path is therefore exercised
 * continuously instead of only in a crisis, which is the point.
 *
 * Three properties are load-bearing and each has a reason:
 *
 *   - **Download from `compaction_frontier` forward, not from zero.** Entries
 *     at or below the frontier are superseded by a compaction entry that
 *     contains their objects; fetching them is bandwidth and latency spent on
 *     bytes the repo already has.
 *   - **Place the uploaded `.idx`; never rebuild it.** `pre-receive` uploads
 *     the index alongside the pack precisely so the restoring node does not pay
 *     `git index-pack` over every entry, which is the dominant cost of a naive
 *     restore.
 *   - **Write `packed-refs` in one shot** (via `reconcile`), never one
 *     `git update-ref` per ref — a repo with thousands of refs would otherwise
 *     pay thousands of processes, each firing the `reference-transaction` hook
 *     and trying to re-publish the truth it was just told.
 *
 * `git fsck` is deliberately NOT run here. It is too slow to sit on the hot
 * path; the packfile's own sha256 is verified against the log instead, which
 * catches the failure a restore actually has (a truncated download) at a cost
 * proportional to bytes already transferred.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { ensureBareRepo } from './cache'
import { git } from './git'
import { acquireLock, type LockRelease } from './mkdir-lock'
import { reconcile, type ReconcileResult } from './reconcile'
import type { ResolvedRepo } from './repo'
import type { ObjectStore } from './store'
import { loadIndex, sha256, type WalEntry, type WalIndex } from './wal-index'

/**
 * Removed only when a materialize completes. Its presence means a previous
 * attempt died partway, which without this marker is indistinguishable from a
 * valid repo that happens to be missing objects — a truncated repo that reads
 * as merely stale is the failure mode this file must not have.
 */
const MARKER = 'walgit-materializing'

const LOCK = 'walgit-materialize.lock'

export interface MaterializeStats {
  repoId: string
  /** WAL entries downloaded and placed this run. */
  fetched: number
  /** Entries at or above the frontier already on disk, so skipped. */
  skipped: number
  /** Entries below `compaction_frontier`, never requested. */
  superseded: number
  bytes: number
  /** Milliseconds creating the bare repo (`git init --bare` and config). */
  initMs: number
  /** Milliseconds downloading and placing packfiles. This is the WAL replay. */
  fetchMs: number
  /** Milliseconds writing `packed-refs` and HEAD. */
  refsMs: number
  totalMs: number
  /** True when another process held the lock and this one waited on it. */
  waited: boolean
}

export interface MaterializeResult {
  stats: MaterializeStats
  reconciled: ReconcileResult
  index: WalIndex
}

export function markerPath(gitDir: string): string {
  return path.join(gitDir, MARKER)
}

/** True when a previous materialize died before finishing. */
export function isPartial(gitDir: string): boolean {
  return fs.existsSync(markerPath(gitDir))
}

/**
 * The on-disk name for a WAL entry's pack.
 *
 * Derived from the object key, so "do I already have this entry?" is a
 * `readdir`, with no side file to keep in sync — and re-running a materialize
 * over a half-populated directory downloads only what is genuinely absent.
 * The `pack-` prefix is git's convention and some tooling still assumes it.
 */
export function packBasename(entry: WalEntry): string {
  const stem = path.basename(entry.key).replace(/\.pack$/, '')
  return `pack-walgit-${stem}`
}

/** Entries still needed to restore: everything above the compaction frontier. */
export function neededEntries(index: WalIndex): WalEntry[] {
  return index.entries
    .filter((entry) => entry.seq > index.compaction_frontier)
    .sort((a, b) => a.seq - b.seq)
}

/** Where git keeps this repo's packfiles. One knower of that layout. */
export function packDirOf(gitDir: string): string {
  return path.join(gitDir, 'objects', 'pack')
}

/**
 * The entries a restore would still have to fetch: needed by the index, and not
 * already sitting in `objects/pack`.
 *
 * Exported because `verify` asks the same question and must get the same
 * answer. `cli.ts` states the rule it is obeying — the operator commands are a
 * thin front over the functions the server already calls, because a
 * reimplementation "would answer for itself rather than for the server, and
 * would drift silently the first time the real path changed". This predicate is
 * what decides both what materialize downloads and what verify reports missing;
 * two copies of it means a `walgit verify` that can call a node healthy while
 * every access re-downloads its whole log.
 */
export function absentEntries(gitDir: string, index: WalIndex): WalEntry[] {
  const packDir = packDirOf(gitDir)
  const onDisk = new Set(
    fs.existsSync(packDir) ? fs.readdirSync(packDir).filter((f) => f.endsWith('.pack')) : [],
  )
  return neededEntries(index).filter((entry) => !onDisk.has(`${packBasename(entry)}.pack`))
}

/**
 * Rebuild `repo` from the log and reconcile its refs against the index.
 *
 * Idempotent and safe to call on a warm repo: entries already on disk are
 * skipped, so the cost on a node that lost nothing is one `readdir`.
 */
export async function materialize(
  store: ObjectStore,
  repo: ResolvedRepo,
  known?: WalIndex,
): Promise<MaterializeResult> {
  const startedAt = performance.now()

  ensureBareRepo(repo)
  const initMs = performance.now() - startedAt

  const index = known ?? (await loadIndex(store, repo.repoId)).index

  const release = await acquire(repo.dir)
  const waited = release.waited
  try {
    const packDir = packDirOf(repo.dir)
    fs.mkdirSync(packDir, { recursive: true })

    const needed = neededEntries(index)
    const absent = absentEntries(repo.dir, index)

    const fetchStart = performance.now()
    let bytes = 0
    if (absent.length > 0) {
      // The marker goes down before the first byte lands and comes up only
      // after the refs are written, so every window in between is detectable.
      fs.writeFileSync(markerPath(repo.dir), `${new Date().toISOString()}\n`)
      for (const entry of absent) bytes += await placeEntry(store, packDir, entry)
    }
    const fetchMs = performance.now() - fetchStart

    const refsStart = performance.now()
    const reconciled = reconcile(repo.dir, index)
    ensureHead(repo.dir, index)
    const refsMs = performance.now() - refsStart

    fs.rmSync(markerPath(repo.dir), { force: true })

    const stats: MaterializeStats = {
      repoId: repo.repoId,
      fetched: absent.length,
      skipped: needed.length - absent.length,
      superseded: index.entries.length - needed.length,
      bytes,
      initMs,
      fetchMs,
      refsMs,
      totalMs: performance.now() - startedAt,
      waited,
    }
    if (absent.length > 0) report(stats)
    return { stats, reconciled, index }
  } finally {
    release()
  }
}

/**
 * Download one WAL entry and place its pack and index.
 *
 * The `.pack` is renamed into place BEFORE the `.idx`, because git discovers
 * packs by scanning for `.idx` files and then opening the pack beside them: a
 * crash between the two renames leaves a pack with no index, which git ignores
 * entirely. The reverse order leaves an index git will try to use for a pack
 * that is not there.
 */
async function placeEntry(store: ObjectStore, packDir: string, entry: WalEntry): Promise<number> {
  const found = await store.get(entry.key)
  if (!found) {
    throw new Error(`walgit: WAL entry ${entry.seq} is missing from the store (${entry.key})`)
  }
  // A truncated download is the failure a restore actually has, and it would
  // otherwise surface as a corrupt repo long after the fact.
  const digest = sha256(found.body)
  if (digest !== entry.sha256) {
    throw new Error(
      `walgit: WAL entry ${entry.seq} (${entry.key}) is corrupt — ` +
        `sha256 ${digest} does not match the log's ${entry.sha256}`,
    )
  }

  const base = path.join(packDir, packBasename(entry))
  const idxKey = entry.key.replace(/\.pack$/, '.idx')
  const idx = await store.get(idxKey)

  writeAtomic(`${base}.pack`, found.body)
  if (idx) {
    writeAtomic(`${base}.idx`, idx.body)
  } else {
    // Only when the log predates uploading the index, or the sibling was lost.
    // It is the expensive path the `.idx` upload exists to avoid, so it says so.
    const built = git(['index-pack', `${base}.pack`])
    if (built.status !== 0) {
      throw new Error(`walgit: could not index ${entry.key}: ${built.stderr.trim()}`)
    }
  }
  return found.body.byteLength
}

function writeAtomic(target: string, body: Uint8Array): void {
  const tmp = `${target}.walgit-${process.pid}`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, target)
}

/**
 * Point HEAD at a branch that exists.
 *
 * A bare repo is initialised with HEAD on `main`; a repo whose log only carries
 * `master` would then clone successfully into an empty working tree, which
 * reads as data loss. The log's ref state is the only thing that knows.
 */
function ensureHead(gitDir: string, index: WalIndex): void {
  const branches = Object.keys(index.refs).filter((ref) => ref.startsWith('refs/heads/'))
  if (branches.length === 0) return

  const headFile = path.join(gitDir, 'HEAD')
  const current = fs.existsSync(headFile) ? fs.readFileSync(headFile, 'utf8').trim() : ''
  const target = /^ref: (.+)$/.exec(current)?.[1]
  if (target && branches.includes(target)) return

  const preferred =
    branches.find((ref) => ref === 'refs/heads/main') ??
    branches.find((ref) => ref === 'refs/heads/master') ??
    branches.sort()[0]!
  fs.writeFileSync(headFile, `ref: ${preferred}\n`)
}

/**
 * Serialise materialize against itself, per repo.
 *
 * Two fetches arriving at a cold repo would otherwise both rebuild it into the
 * same directory. The renames are atomic so the objects would survive, but the
 * `packed-refs` rewrite is not something two writers should race on, and paying
 * for the same download twice is the latency this milestone is measured by.
 *
 * Six seconds before the lock is broken, not one: unlike a `FileStore` write
 * the holder here is downloading packfiles, so a lock still held after a second
 * usually means a slow restore rather than a dead one. Breaking it eventually
 * is still required — on Fly a machine is stopped whenever it is idle — and
 * still safe, because the loser re-reads the directory and downloads only what
 * is genuinely absent.
 */
function acquire(gitDir: string): Promise<LockRelease> {
  return acquireLock(path.join(gitDir, LOCK), { breakAfter: 1200 })
}

/**
 * One machine-readable line per restore.
 *
 * It is reported separately from anything else on purpose: on Fly, machine wake
 * alone is ~1.35 s (measured in the milestone-0 spike), so a single
 * end-to-end number cannot attribute a regression to either half. This is the
 * materialize half and nothing else.
 *
 * The number is a CONTROL LOOP, not a pass/fail: exceeding the target means the
 * WAL is replaying too many entries, and the knob is the compaction threshold.
 */
function report(stats: MaterializeStats): void {
  if (process.env.WALGIT_QUIET) return
  console.error(`walgit materialize ${JSON.stringify(round(stats))}`)
}

export function round(stats: MaterializeStats): MaterializeStats {
  const ms = (n: number) => Math.round(n * 1000) / 1000
  return {
    ...stats,
    initMs: ms(stats.initMs),
    fetchMs: ms(stats.fetchMs),
    refsMs: ms(stats.refsMs),
    totalMs: ms(stats.totalMs),
  }
}
