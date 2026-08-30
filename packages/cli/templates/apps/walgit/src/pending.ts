/**
 * The hand-off between the two hook processes of one push.
 *
 * `pre-receive` and `reference-transaction` are separate processes with no
 * channel between them, so what the first uploaded has to be written down for
 * the second to find. That record is what lives here: a file in the repo
 * directory, keyed by the `git-receive-pack` invocation that owns it.
 *
 * It is deliberately NOT a WAL object and knows nothing about object storage —
 * it describes an upload nobody can see yet. Everything in this file is about
 * pids, liveness and local scratch; everything in `push.ts` is about packfiles
 * and compare-and-swap. They were one module and the split is why
 * `cache.ts` can sweep stale records without depending on the write-ahead log.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Provenance, WalEntry } from './wal-index'

/**
 * What `pre-receive` hands to `reference-transaction`.
 */
export interface PendingPush {
  /** Absent for a push that carried no objects, e.g. a branch deletion. */
  entry: Omit<WalEntry, 'seq'> | null
  /**
   * Set once a `reference-transaction` has published (or reported as orphaned)
   * the entry above. A push whose refs arrive in more than one transaction — git
   * updates refs one transaction at a time unless the client asked for
   * `--atomic` — publishes its pack with the first of them and the rest as
   * ref-only changes.
   */
  consumed?: boolean
  /**
   * Who signed this push, when one did and walgit could verify it
   * (docs/adr/0011). Determined in `pre-receive`, because that is the only hook
   * git hands the certificate to — the blob lives in the push's quarantine and
   * is gone by the time the refs move — and carried here for the same reason
   * the entry is: the transaction that publishes it is a different process.
   * Absent for every unsigned push, which is most of them.
   */
  provenance?: Provenance
  /**
   * The `git-receive-pack` that owns this record; see `invocationId`. Optional
   * only because `publishPush` takes a `PendingPush` as a plain argument and
   * has no interest in who wrote it.
   */
  pid?: number
  /** Written for the sweep, which cannot ask a dead process how old it was. */
  ts?: number
}

const PENDING_DIR = 'walgit-pending'

/**
 * The hand-off is per `git-receive-pack` invocation, never per repository.
 *
 * git takes no repository-wide lock on a push — only per-ref locks inside the
 * ref transaction — so two clients pushing one repo at once run two overlapping
 * `pre-receive`/`reference-transaction` pairs. A single file per repository lets
 * one of them read the other's upload, and lets one of them clear the other's
 * state, which ends in a push that git acknowledged and the log never received.
 *
 * `process.ppid` is the discriminator: both hooks are `exec`ed by the same
 * `git-receive-pack` (the hook script `exec`s bun, so no shell survives in
 * between), so it is stable across the two hooks of one push and distinct
 * between concurrent pushes. `GIT_QUARANTINE_PATH` would be the obvious
 * alternative and is not one — git does not guarantee it for
 * `reference-transaction`.
 */
export function invocationId(): number {
  return process.ppid
}

export function pendingDir(gitDir: string): string {
  return path.join(gitDir, PENDING_DIR)
}

export function pendingPath(gitDir: string, invocation: number = invocationId()): string {
  return path.join(pendingDir(gitDir), `${invocation}.json`)
}

export function writePending(
  gitDir: string,
  pending: Omit<PendingPush, 'pid' | 'ts'>,
  invocation: number = invocationId(),
): void {
  fs.mkdirSync(pendingDir(gitDir), { recursive: true })
  const record: PendingPush = { ...pending, pid: invocation, ts: Date.now() }
  fs.writeFileSync(pendingPath(gitDir, invocation), JSON.stringify(record))
}

export function readPending(
  gitDir: string,
  invocation: number = invocationId(),
): PendingPush | null {
  const file = pendingPath(gitDir, invocation)
  if (!fs.existsSync(file)) return null
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingPush
  // A pid is reused eventually. A record left by a dead `git-receive-pack` that
  // happened to hold this pid must not be mistaken for this push's own upload.
  if (record.pid !== invocation) return null
  return record
}

/**
 * Record that the entry has been published, without deleting the record.
 *
 * The record has to outlive the transaction that consumed it: the next thing
 * `hook-main` must be able to tell apart is "no `pre-receive` ran here, this is
 * an administrative ref edit" from "`pre-receive` ran and its record is gone".
 * The first is a legitimate exit 0; the second is the silent acknowledgement
 * this file exists to prevent. Deleting on `committed` erases that distinction,
 * so cleanup happens in `post-receive` and in the sweep, never mid-push.
 */
export function markConsumed(gitDir: string, invocation: number = invocationId()): void {
  const record = readPending(gitDir, invocation)
  if (!record) return
  fs.writeFileSync(pendingPath(gitDir, invocation), JSON.stringify({ ...record, consumed: true }))
}

export function clearPending(gitDir: string, invocation: number = invocationId()): void {
  fs.rmSync(pendingPath(gitDir, invocation), { force: true })
}

/** An hour is far longer than any push and far shorter than any operator cares. */
export const PENDING_MAX_AGE_MS = 60 * 60 * 1000

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Drop records whose `git-receive-pack` is gone, so a killed push leaves no
 * file a later one could read.
 *
 * Liveness AND age, not either alone: liveness is exact but only inside one pid
 * namespace, so a record written before a container restart can name a pid that
 * is alive again as something else; age alone would keep a killed push's record
 * readable for an hour. A live pid younger than the cutoff is left strictly
 * alone — that is a push in flight.
 */
export function sweepPending(gitDir: string, now = Date.now()): string[] {
  const dir = pendingDir(gitDir)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const swept: string[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    let record: PendingPush | null = null
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingPush
    } catch {
      // Unreadable or half-written by a process that died mid-write: it can
      // never be claimed by anyone, so it is garbage by definition.
    }
    const stale =
      !record ||
      typeof record.pid !== 'number' ||
      !isAlive(record.pid) ||
      now - (record.ts ?? 0) > PENDING_MAX_AGE_MS
    if (!stale) continue
    fs.rmSync(file, { force: true })
    swept.push(file)
  }
  return swept
}
