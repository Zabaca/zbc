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
}

/** A ref change as `reference-transaction` reports it on stdin. */
export interface RefChange {
  ref: string
  oldOid: string
  newOid: string
}

/** The all-zeroes oid: creation when it is `oldOid`, deletion when `newOid`. */
export const ZERO_OID = '0'.repeat(40)

export function indexKey(repoId: string): string {
  return `repos/${repoId}/index.json`
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

/** Zero-padded to 12 digits so lexicographic key order is numeric order. */
export function walKey(repoId: string, seq: number, ulid: string, ext: 'pack' | 'idx'): string {
  return `repos/${repoId}/wal/${String(seq).padStart(12, '0')}-${ulid}.${ext}`
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
 * Build the successor index for one push: bump seq, append the entry, apply the
 * ref changes. Pure, so the caller can validate before anything is written.
 */
export function nextIndex(
  current: WalIndex,
  entry: Omit<WalEntry, 'seq'>,
  changes: readonly RefChange[],
): WalIndex {
  const seq = current.seq + 1
  return {
    ...current,
    seq,
    entries: [...current.entries, { ...entry, seq }],
    refs: applyRefChanges(current.refs, changes),
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
