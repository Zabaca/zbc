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

import { ZERO_OID } from '../shared/protocol'
import { walKey } from './keys'
import { writePending, type PendingPush } from './pending'
import { certSigner } from './push-cert'
import type { ObjectStore } from './store'
import { ulid } from './ulid'
import {
  applyProvenance,
  applyRefChanges,
  commitIndex,
  loadIndex,
  nextIndex,
  sha256,
  type Provenance,
  type RefChange,
  type WalEntry,
  type WalIndex,
} from './wal-index'

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

export interface PreReceiveContext {
  store: ObjectStore
  repoId: string
  gitDir: string
  quarantineDir: string | undefined
  now?: () => Date
  /**
   * Who signed this push, injected the way `announce`'s `fetchImpl` is: the
   * default reads git's own environment and shells out to `ssh-keygen`, so
   * every decision on this path stays testable without a keypair, a subprocess
   * or a running git.
   */
  signer?: () => string | null
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
  // Read before anything else on this path can fail, and behind a catch of its
  // own: the certificate is only readable while the push's quarantine exists,
  // and provenance must never be the reason a push does not land. A signer that
  // throws is a push with no Signer, not a push with an error.
  let signer: string | null = null
  try {
    signer = (ctx.signer ?? certSigner)()
  } catch {
    signer = null
  }
  const provenance: Provenance | null = signer ? { signer, ts: now().toISOString() } : null
  const found = ctx.quarantineDir ? quarantinePack(ctx.quarantineDir) : null
  if (!found) {
    // A ref-only push (a delete, or a branch pointed at an object the server
    // already has) is legitimate and still has to publish its ref change — and
    // its provenance: a branch pointed at objects the repository already has
    // moves a ref, and is signed like any other push.
    writePending(ctx.gitDir, { entry: null, ...(provenance ? { provenance } : {}) })
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
  writePending(ctx.gitDir, { entry, ...(provenance ? { provenance } : {}) })
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
    //
    // Provenance rides on BOTH branches, which is why it is a field on the
    // Index and not on a WAL entry: a ref-only push has no entry to hang it
    // from and is exactly as signed as any other.
    const provenance = pending.provenance ?? null
    const next = pending.entry
      ? nextIndex(index, pending.entry, changes, provenance)
      : {
          ...index,
          refs: applyRefChanges(index.refs, changes),
          provenance: applyProvenance(index.provenance, changes, provenance),
        }

    const result = await commitIndex(store, next, etag)
    if (result.ok) return { ok: true, index: next }
  }
  return { ok: false, reason: 'contended' }
}
