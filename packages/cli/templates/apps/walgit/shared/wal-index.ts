/**
 * `index.json` — the source of truth for one repository, and how to READ it.
 *
 * It carries the full ref state, so there is no database beside it. A push is
 * published by writing a new version of this object under a compare-and-swap;
 * until that write lands, the packfile already uploaded to the WAL is present
 * but unpublished, and nothing can see it.
 *
 * The Index’s types and its reader live in the Shared Kernel because reading
 * the log is not a container privilege: the edge answers questions off
 * `index.json` too, and the answer must be the same object model on both sides
 * (docs/adr/0010). Writing it is not here — `src/wal-index.ts` owns the
 * compare-and-swap, the `apply*` helpers and `sha256`, all of which belong to
 * the process that holds the disk.
 *
 * See this repository’s docs/adr/0007-walgit-object-storage-holds-the-log.md.
 */

import { indexKey } from './keys'
import type { ObjectStore } from './store'

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
  /**
   * The repository's Signer List, as the push that last moved `refs/walgit/signers`
   * resolved it (docs/adr/0012). Absent means unclaimed, which is every
   * repository until someone writes one.
   *
   * Repo-level rather than per-ref, unlike `provenance` above it: the list
   * governs the name, not a branch.
   *
   * The ref is authoritative and this is a derived copy, which is safe rather
   * than a second source of truth — it is written by the same compare-and-swap
   * that publishes the ref move, derived from bytes in that same push, and a
   * restore replays the ref and this field together because both live here. The
   * copy exists because the refusal that will read it runs in `pre-receive`,
   * which already loads the Index; resolving from the Cache instead would make
   * ownership depend on the Cache being materialized, and the Cache is
   * disposable by definition (ADR-0007).
   *
   * It cannot be derived from `provenance`, which is latest-state per ref and
   * overwritten by every push — by the time it mattered it would name the most
   * recent Signer rather than the founding one.
   */
  claim?: Claim
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

/** The keys a repository's Signer List names, and when that list landed. */
export interface Claim {
  /**
   * Fingerprints, in the order the file names them and with duplicates already
   * collapsed — the list as `parseKeyList` read it, never the raw file. What
   * is stored is the resolved answer, so a reader never re-parses and cannot
   * reach a different one.
   */
  signers: string[]
  /**
   * The keys the repository lets READ it — its Reader List (docs/adr/0013) —
   * as `parseKeyList` read the `readers` file beside `signers` in the same
   * commit. Absent when that file is absent, which is every repository until
   * someone writes one: presence is the switch, so there is no `private`
   * marker and no third state.
   *
   * `[]` is a value rather than an absence, and the difference is the whole
   * capability: an empty Reader List is valid and means the Signer List reads
   * this repository and nobody else, while no field at all means anyone does.
   *
   * Maintained only while the Private seed is set, exactly as the Claim around
   * it is maintained only under the Signer List flag — the ref is what is
   * authoritative and this is a derived copy (see `applyClaim`).
   */
  readers?: string[]
  /** ISO instant the push that wrote this list was received. */
  ts: string
}

/**
 * What one push records about who made it — applied by the same compare-and-swap
 * that publishes the push, which is why they travel together rather than as two
 * nullable tail arguments nobody can keep straight at a call site.
 */
export interface PushRecord {
  /** The Signer of this push, or `null` for an anonymous one. */
  provenance: Provenance | null
  /** The Signer List this push writes, or `null` when it writes none. */
  claim: Claim | null
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
