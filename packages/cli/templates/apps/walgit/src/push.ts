/**
 * The push path: upload, then publish.
 *
 * This is the one file where being wrong loses data, so the ordering is stated
 * plainly and never varies:
 *
 *   1. `pre-receive` — the pushed objects sit in `$GIT_QUARANTINE_PATH` and are
 *      visible to nobody. Upload the packfile to the WAL. Uploading does NOT
 *      publish it: `index.json` is untouched, so a crash here leaves an
 *      unreferenced object and a client that saw a failure.
 *   2. `reference-transaction prepared` — git has the ref update staged but not
 *      committed. Compare-and-swap `index.json`. Winning is what makes the push
 *      real; exit 0 and git commits the ref locally and acknowledges. Losing
 *      must exit non-zero, which aborts the transaction and rejects the push.
 *
 * The invariant the whole design exists to hold: no acknowledgement before the
 * WAL entry is published. A hook that swallows a failure and exits 0 breaks it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ObjectStore } from './store'
import { ulid } from './ulid'
import {
  ZERO_OID,
  applyRefChanges,
  commitIndex,
  loadIndex,
  nextIndex,
  walKey,
  type RefChange,
  type WalEntry,
  type WalIndex,
} from './wal-index'

/**
 * What `pre-receive` hands to `reference-transaction`.
 *
 * The two hooks are separate processes with no channel between them, so the
 * uploaded entry is written into the repo directory. It is deliberately NOT a
 * WAL object: it is local scratch describing an upload nobody can see yet.
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

/**
 * Parse the `<old-oid> SP <new-oid> SP <refname>` lines both hooks are fed.
 * The refname is taken verbatim to the end of the line: it may contain spaces.
 */
export function parseRefChanges(stdin: string): RefChange[] {
  const changes: RefChange[] = []
  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue
    const match = /^(\S+) (\S+) (.+)$/.exec(line.replace(/\r$/, ''))
    if (!match) throw new Error(`unparseable ref change: ${JSON.stringify(line)}`)
    changes.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! })
  }
  return changes
}

/**
 * The quarantine's packfile, or null when the push carried no objects.
 *
 * `.keep` is never uploaded — it is local bookkeeping telling git not to repack
 * that pack, and it means nothing anywhere else. `.idx` and `.rev` are
 * derivable from the `.pack`, but uploading them costs little and saves a
 * restore from having to run `git index-pack` over every entry.
 */
export function quarantinePack(quarantineDir: string): { pack: string; idx: string | null } | null {
  const dir = path.join(quarantineDir, 'pack')
  if (!fs.existsSync(dir)) return null
  const pack = fs.readdirSync(dir).find((f) => f.endsWith('.pack'))
  if (!pack) return null
  const idx = pack.replace(/\.pack$/, '.idx')
  return {
    pack: path.join(dir, pack),
    idx: fs.existsSync(path.join(dir, idx)) ? path.join(dir, idx) : null,
  }
}

export function sha256(body: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex')
}

export interface PreReceiveContext {
  store: ObjectStore
  repoId: string
  gitDir: string
  quarantineDir: string | undefined
  now?: () => Date
}

/**
 * Upload the pushed pack and record it as pending. Nothing is published.
 *
 * The sequence number in the key is a GUESS — the index's current seq plus one
 * — because the real one is only decided when the compare-and-swap lands. It
 * is right in the common case and merely cosmetic when it is wrong: the ULID
 * keeps the key unique, and `index.json` carries the authoritative key for
 * every entry, so a mis-numbered key is never followed by anything.
 */
export async function preReceive(ctx: PreReceiveContext): Promise<void> {
  const now = ctx.now ?? (() => new Date())
  const found = ctx.quarantineDir ? quarantinePack(ctx.quarantineDir) : null
  if (!found) {
    // A ref-only push (a delete, or a branch pointed at an object the server
    // already has) is legitimate and still has to publish its ref change.
    writePending(ctx.gitDir, { entry: null })
    return
  }

  const { index } = await loadIndex(ctx.store, ctx.repoId)
  const id = ulid(now().getTime())
  const packBody = new Uint8Array(fs.readFileSync(found.pack))
  const key = walKey(ctx.repoId, index.seq + 1, id, 'pack')

  await ctx.store.put(key, packBody)
  if (found.idx) {
    await ctx.store.put(
      walKey(ctx.repoId, index.seq + 1, id, 'idx'),
      new Uint8Array(fs.readFileSync(found.idx)),
    )
  }

  const entry: Omit<WalEntry, 'seq'> = {
    key,
    kind: 'push',
    size: packBody.byteLength,
    sha256: sha256(packBody),
    ts: now().toISOString(),
  }
  writePending(ctx.gitDir, { entry })
}

export type PublishResult =
  | { ok: true; index: WalIndex }
  /** Another push published first and moved a ref this one is updating. */
  | { ok: false; reason: 'ref-conflict'; ref: string; expected: string; actual: string }
  /** Lost every compare-and-swap attempt against an index that kept moving. */
  | { ok: false; reason: 'contended' }

/**
 * Publish the pending entry with the push's ref changes, under CAS.
 *
 * Retry is here rather than inside `commitIndex`, and it is guarded: every
 * attempt re-reads the index and re-checks that each ref this push updates
 * still holds the old oid git computed the update against. Retrying without
 * that check would publish a ref state derived from an index that no longer
 * exists, which is exactly the acknowledgement-of-a-lost-race this project
 * exists to prevent. A conflict is final — the client must fetch and rebase.
 *
 * `index.json` is the source of truth for that check, not the local ref: a
 * local ref disagreeing with the index is a stale cache, and reconcile's job.
 */
export async function publishPush(
  store: ObjectStore,
  repoId: string,
  pending: PendingPush,
  changes: readonly RefChange[],
  attempts = 5,
): Promise<PublishResult> {
  for (let i = 0; i < attempts; i += 1) {
    const { index, etag } = await loadIndex(store, repoId)

    for (const change of changes) {
      const actual = index.refs[change.ref] ?? ZERO_OID
      if (actual !== change.oldOid) {
        return {
          ok: false,
          reason: 'ref-conflict',
          ref: change.ref,
          expected: change.oldOid,
          actual,
        }
      }
    }

    // A ref-only push bumps no sequence number and appends no entry: there is
    // no log record to append, only new ref state. Keeping seq contiguous with
    // the entry list is what lets a restore trust `entries` by itself.
    const next = pending.entry
      ? nextIndex(index, pending.entry, changes)
      : { ...index, refs: applyRefChanges(index.refs, changes) }

    const result = await commitIndex(store, next, etag)
    if (result.ok) return { ok: true, index: next }
  }
  return { ok: false, reason: 'contended' }
}
