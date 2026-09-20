/**
 * Writing `index.json` — the compare-and-swap that publishes a push.
 *
 * The Index’s types and its reader are in `shared/wal-index.ts`, because both
 * halves of walgit read the log (docs/adr/0010). Everything here belongs to the
 * process that holds the disk: the next-state helpers, the conditional write
 * that makes a push durable, and `sha256`, which is the one piece of this file
 * that could not move — it hashes through `Bun.CryptoHasher`.
 *
 * See this repository’s docs/adr/0007-walgit-object-storage-holds-the-log.md.
 */

import { SIGNERS_REF, ZERO_OID } from '../shared/protocol'
import { indexKey } from '../shared/keys'
import type { ObjectStore, PutResult } from '../shared/store'
import { loadIndex } from '../shared/wal-index'
import type {
  Claim,
  Provenance,
  PushRecord,
  RefChange,
  WalEntry,
  WalIndex,
} from '../shared/wal-index'

/**
 * A WAL object's content address, as `WalEntry.sha256` carries it.
 *
 * It lives beside the field it fills rather than with whichever caller happens
 * to compute it: the push path stamps it on upload, compaction stamps it on the
 * pack it publishes, and materialize checks a download against it — a truncated
 * transfer being the failure a restore actually has. Three callers, one
 * definition of what the digest is over.
 */
export function sha256(body: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex')
}

/** A push that records neither. The overwhelming majority of them. */
const NO_RECORD: PushRecord = { provenance: null, claim: null }

// ── Writing ─────────────────────────────────────────────────────────────────

/** Apply ref changes to a ref map. Deleting to ZERO_OID removes the ref. */
export function applyRefChanges(
  refs: Record<string, string>,
  changes: readonly RefChange[],
): Record<string, string> {
  const next = { ...refs }
  for (const c of changes) {
    if (c.newOid === ZERO_OID) delete next[c.ref]
    else next[c.ref] = c.newOid
  }
  return next
}

/**
 * Apply one push's provenance: the Signer of every ref it moved.
 *
 * The map answers exactly one question — *who moved this ref to the sha it
 * holds now* — and both clearing rules follow from that being the question:
 *
 *   - A deleted ref loses its entry, because the ref it described is gone.
 *     Keeping it would grow the map forever with refs nothing can look up.
 *   - An UNSIGNED push over a signed ref loses it too. The alternative is worse
 *     than useless: the ref would keep naming whoever last signed for it while
 *     pointing at a sha that key never signed, which is the Index stating
 *     something false rather than stating nothing.
 *
 * `undefined` when the result is empty, so the field is absent from an index no
 * signed push has touched instead of appearing as `{}`.
 */
export function applyProvenance(
  current: Record<string, Provenance> | undefined,
  changes: readonly RefChange[],
  provenance: Provenance | null,
): Record<string, Provenance> | undefined {
  const next = { ...current }
  for (const c of changes) {
    if (provenance === null || c.newOid === ZERO_OID) delete next[c.ref]
    else next[c.ref] = provenance
  }
  return Object.keys(next).length === 0 ? undefined : next
}

/**
 * Apply one push's Signer List, if it wrote one — and drop the claim if the
 * push took the list ref away.
 *
 * Writing is gated on the push actually moving `SIGNERS_REF` in THIS set of
 * changes, not merely on a resolved list being in hand. git updates refs one
 * transaction at a time unless the client asked for `--atomic`, so a push
 * moving a branch and the list together publishes across several
 * compare-and-swaps — and writing the field in the first of them would leave
 * the Index naming a list the ref does not yet hold, and still naming it if a
 * later transaction is refused.
 *
 * The deletion rule is here rather than left to the refusal in
 * `src/signers.ts`, even though that refusal makes it unreachable, because the
 * refusal only exists while `WALGIT_SIGNER_LISTS` is on. A deployment that
 * turns the flag off can delete the ref, and an Index that went on naming a
 * list nothing holds would state something false — the same reason
 * `applyProvenance` clears a deleted ref rather than keeping the last Signer
 * for it.
 *
 * It does NOT make the derived copy self-healing, and nothing here does: only a
 * push that moves the ref while the flag is on writes the field. A list pushed
 * before the flag was turned on, or a ref force-moved while it was off, leaves
 * the Index behind the ref, and the ref is the one that is authoritative.
 */
export function applyClaim(
  current: Claim | undefined,
  changes: readonly RefChange[],
  claim: Claim | null,
): Claim | undefined {
  const deleted = changes.some((c) => c.ref === SIGNERS_REF && c.newOid === ZERO_OID)
  if (deleted) return undefined
  if (claim === null) return current
  const moves = changes.some((c) => c.ref === SIGNERS_REF && c.newOid !== ZERO_OID)
  return moves ? claim : current
}

/**
 * Build the successor index for one push: bump seq, append the entry, apply the
 * ref changes and whatever the push recorded about who made it. Pure, so the
 * caller can validate before anything is written.
 */
export function nextIndex(
  current: WalIndex,
  entry: Omit<WalEntry, 'seq'>,
  changes: readonly RefChange[],
  record: PushRecord = NO_RECORD,
): WalIndex {
  const seq = current.seq + 1
  return {
    ...current,
    seq,
    entries: [...current.entries, { ...entry, seq }],
    refs: applyRefChanges(current.refs, changes),
    provenance: applyProvenance(current.provenance, changes, record.provenance),
    claim: applyClaim(current.claim, changes, record.claim),
  }
}

export type CommitResult =
  | { ok: true; index: WalIndex; etag: string }
  /** Someone else published first. The caller must re-read and decide again. */
  | { ok: false; reason: 'contended' }

/**
 * Publish a new index under compare-and-swap. `expectedEtag` is `null` to mean
 * "this repository has no index yet", which becomes an if-absent write — so two
 * nodes initialising the same repository at once cannot both succeed.
 *
 * One attempt, no retry: on the push path a loss must reach `reference-
 * transaction` as a non-zero exit so git aborts the ref update. Retrying inside
 * the commit would acknowledge a push whose ref state was computed against an
 * index that no longer exists.
 */
export async function commitIndex(
  store: ObjectStore,
  index: WalIndex,
  expectedEtag: string | null,
): Promise<CommitResult> {
  const body = new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`)
  const res: PutResult = await store.put(
    indexKey(index.repo_id),
    body,
    expectedEtag === null ? { ifAbsent: true } : { ifMatch: expectedEtag },
  )
  if (!res.ok) return { ok: false, reason: 'contended' }
  return { ok: true, index, etag: res.etag }
}

/**
 * Read-modify-write with bounded retry, for callers that are NOT the push path:
 * compaction, orphan GC, administrative ref edits. `mutate` re-runs against the
 * freshly read index on every attempt, so it must be a pure function of what it
 * is given rather than of anything captured earlier.
 */
export async function updateIndex(
  store: ObjectStore,
  repoId: string,
  mutate: (current: WalIndex) => WalIndex,
  attempts = 8,
): Promise<CommitResult> {
  let lastContended: CommitResult = { ok: false, reason: 'contended' }
  for (let i = 0; i < attempts; i += 1) {
    const { index, etag } = await loadIndex(store, repoId)
    const result = await commitIndex(store, mutate(index), etag)
    if (result.ok) return result
    lastContended = result
  }
  return lastContended
}
