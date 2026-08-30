/**
 * `index.json` — the source of truth for one repository.
 *
 * It carries the full ref state, so there is no database beside it. A push is
 * published by writing a new version of this object under a compare-and-swap;
 * until that write lands, the packfile already uploaded to the WAL is present
 * but unpublished, and nothing can see it.
 *
 * See this repository's docs/adr/0007-walgit-object-storage-holds-the-log.md.
 */

import { ZERO_OID } from '../shared/protocol'
import { indexKey } from './keys'
import type { ObjectStore, PutResult } from './store'

export type WalEntryKind = 'push' | 'compaction'

export interface WalEntry {
  seq: number
  /** Object key of the packfile, e.g. `wal/000000000042-01J….pack`. */
  key: string
  kind: WalEntryKind
  size: number
  sha256: string
  ts: string
  /** Compaction only: entries at or below this seq are no longer needed. */
  supersedes_through?: number
}

/**
 * A superseded WAL object, scheduled for deletion but not yet deleted.
 *
 * The delay is the whole point. A compaction's compare-and-swap advances the
 * frontier instantly, but a restore that read `index.json` a moment earlier is
 * still downloading the entries that CAS just superseded — and deleting them
 * out from under it fails the restore with a missing object, which is ranked
 * risk #2 in docs/adr/0007 precisely because nothing shouts. So the CAS records
 * an intent to delete, and collection happens later, out of band.
 */
export interface Tombstone {
  /** The object key. Its sibling `.idx` is collected with it. */
  key: string
  /** The compaction entry whose pack now contains these objects. */
  superseded_by: number
  /** ISO instant before which this key must not be deleted. */
  collect_after: string
}

/**
 * A repository scheduled for deletion.
 *
 * Deletion is deferred for the same reason a tombstone is: a clone that read
 * this index a moment ago is still downloading the packs it names, and pulling
 * them out from under it fails the clone with a missing object. The marker is
 * written under compare-and-swap like everything else, so an operator asking
 * twice does not shorten the wait — the first request's `collect_after` stands.
 */
export interface RepoDeletion {
  /** ISO instant the operator asked for the repository to go. */
  requested_at: string
  /** ISO instant before which nothing under the repo prefix may be deleted. */
  collect_after: string
}

export interface WalIndex {
  version: 1
  repo_id: string
  /** Highest WAL entry applied. Monotonic. */
  seq: number
  entries: WalEntry[]
  /** Full ref state after applying every entry. `refs/heads/main` → oid. */
  refs: Record<string, string>
  /** Entries below this are not needed to restore. */
  compaction_frontier: number
  /**
   * Superseded keys awaiting collection. Optional because an index written
   * before compaction existed does not have the field; absent reads as empty.
   */
  tombstones?: Tombstone[]
  /**
   * Set when this repository has been scheduled for deletion. Its presence is
   * what makes the second run of `walgit delete` a collection rather than a
   * second request.
   */
  deletion?: RepoDeletion
  /**
   * Push provenance: ref → who signed the push that moved it to the sha `refs`
   * currently holds, and when (docs/adr/0011).
   *
   * A second map beside `refs` rather than a widening of it, for three reasons
   * that each rule out the alternatives. It is not hung off a `WalEntry`: a
   * ref-only push appends none, so provenance would be blind to a whole class
   * of push. It is not kept on the certificate blob: that lives on the Cache,
   * which is wiped on restart. And it is not a richer value inside `refs`,
   * because every existing reader of the Index — reconcile, materialize, the
   * event handshake — would then have to change to keep reading a sha.
   *
   * Latest-state per ref, like everything else here: there is no provenance
   * history, because the audit trail of *content* is the commit graph and a
   * second ledger would be a second thing to keep true.
   *
   * Optional and absent when empty, so an unsigned deployment's index.json is
   * byte-for-byte what it was before this field existed.
   */
  provenance?: Record<string, Provenance>
}

/** Who moved a ref, and when it landed. */
export interface Provenance {
  /**
   * The SSH key fingerprint that signed the push, as `ssh-keygen` spells it:
   * `SHA256:` and 43 characters of base64. A key, never a user or an account —
   * neither exists here, and naming it either would imply a registry walgit
   * deliberately does not have.
   */
  signer: string
  /** ISO instant the push was received. */
  ts: string
}

/** A ref change as `reference-transaction` reports it on stdin. */
export interface RefChange {
  ref: string
  oldOid: string
  newOid: string
}

export function emptyIndex(repoId: string): WalIndex {
  return {
    version: 1,
    repo_id: repoId,
    seq: 0,
    entries: [],
    refs: {},
    compaction_frontier: 0,
    tombstones: [],
  }
}

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

// ── Reading ─────────────────────────────────────────────────────────────────

export interface LoadedIndex {
  index: WalIndex
  /** ETag to guard the next write with. `null` when the object does not exist. */
  etag: string | null
}

export async function loadIndex(store: ObjectStore, repoId: string): Promise<LoadedIndex> {
  const found = await store.get(indexKey(repoId))
  if (!found) return { index: emptyIndex(repoId), etag: null }
  return { index: parseIndex(found.body, repoId), etag: found.etag }
}

/**
 * Cheap currency check for the read path: `not-modified` costs one metadata
 * round trip, which is what lets a node serve from its local cache without
 * trusting it blindly.
 */
export async function loadIndexIfChanged(
  store: ObjectStore,
  repoId: string,
  knownEtag: string,
): Promise<LoadedIndex | 'current'> {
  const res = await store.getIfNoneMatch(indexKey(repoId), knownEtag)
  if (res.status === 'not-modified') return 'current'
  if (res.status === 'absent') return { index: emptyIndex(repoId), etag: null }
  return { index: parseIndex(res.body, repoId), etag: res.etag }
}

function parseIndex(body: Uint8Array, repoId: string): WalIndex {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as WalIndex
  // Guard the two invariants a corrupted or misrouted object would break. A
  // wrong repo_id means the key routing is wrong, which silently serving would
  // turn into cross-repository data loss.
  if (parsed.version !== 1) throw new Error(`index.json: unsupported version ${parsed.version}`)
  if (parsed.repo_id !== repoId) {
    throw new Error(`index.json at ${repoId} declares repo_id "${parsed.repo_id}"`)
  }
  return parsed
}

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
 * Build the successor index for one push: bump seq, append the entry, apply the
 * ref changes and the push's Signer. Pure, so the caller can validate before
 * anything is written.
 */
export function nextIndex(
  current: WalIndex,
  entry: Omit<WalEntry, 'seq'>,
  changes: readonly RefChange[],
  provenance: Provenance | null = null,
): WalIndex {
  const seq = current.seq + 1
  return {
    ...current,
    seq,
    entries: [...current.entries, { ...entry, seq }],
    refs: applyRefChanges(current.refs, changes),
    provenance: applyProvenance(current.provenance, changes, provenance),
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
