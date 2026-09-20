/**
 * The object-store key namespace — walgit's storage layout, in one file.
 *
 * `repos/<repo_id>/…` is the one thing every module agrees on and the one thing
 * a bucket cannot be migrated away from: the WAL is the source of truth
 * (docs/adr/0007), so a key is not an implementation detail of whichever module
 * happens to write it. It used to be authored in six places and read back by
 * hand in two more — `gc.ts` reconstructed a ULID out of a WAL key with a
 * `split`, a `pop`, a `replace`, an `indexOf` and a `slice`, reversing a format
 * `walKey` produced six modules away without saying so.
 *
 * So: every prefix, every key builder, the `.pack` → `.idx` sibling rule, and
 * the parse back out of a WAL key live here, and nothing else builds one. The
 * layout is:
 *
 *     repos/<repo_id>/index.json                     the Index — the log's head
 *     repos/<repo_id>/wal/<seq>-<ulid>.pack          one push's objects
 *     repos/<repo_id>/wal/<seq>-<ulid>.idx           its sibling index
 *     repos/<repo_id>/compaction.lease               who is compacting, until when
 *
 * Enumerating repositories lives here too, and that is a move rather than a new
 * function: `listRepoIds` was in `usage.ts`, the read-only reporting command,
 * because that is where it was first needed — which left `expire.ts`, whose job
 * is deleting repositories, importing the usage reporter to find them. Nothing
 * about listing a prefix is a usage concern.
 */

import type { ObjectStore } from './store'
import { ulidTime } from './ulid'

/** Where every repository's state lives. One flat level: `repos/<repo_id>/`. */
export const REPOS_PREFIX = 'repos/'

/** Everything walgit stores for one repository lives under this prefix. */
export function repoPrefix(repoId: string): string {
  return `${REPOS_PREFIX}${repoId}/`
}

/** The write-ahead log's objects for one repository. */
export function walPrefix(repoId: string): string {
  return `${repoPrefix(repoId)}wal/`
}

/** The Index: the compare-and-swap target that makes a push durable. */
export function indexKey(repoId: string): string {
  return `${repoPrefix(repoId)}index.json`
}

/** Who holds the compaction lease for this repository, and until when. */
export function leaseKey(repoId: string): string {
  return `${repoPrefix(repoId)}compaction.lease`
}

/** Zero-padded to 12 digits so lexicographic key order is numeric order. */
export function walKey(repoId: string, seq: number, ulid: string, ext: 'pack' | 'idx'): string {
  return `${walPrefix(repoId)}${String(seq).padStart(12, '0')}-${ulid}.${ext}`
}

/**
 * The `.idx` uploaded beside a pack.
 *
 * Deleted with its pack and never separately, and never an orphan while the
 * pack is live: an entry in the Index names the `.pack` directly and its
 * sibling only implicitly, so every reader that walks entries has to be able to
 * derive one from the other the same way.
 */
export function siblingIdx(packKey: string): string {
  return packKey.replace(/\.pack$/, '.idx')
}

/**
 * The ULID a WAL key carries, or `null` when it does not carry one.
 *
 * `null` is the "this is not a key this file wrote" answer, not the "it is
 * ancient" one — which matters because the only caller is the collector, and
 * the asymmetry there is that over-retaining costs storage while
 * under-retaining loses data with no error anywhere.
 */
export function walKeyUlid(key: string): string | null {
  const stem =
    key
      .split('/')
      .pop()
      ?.replace(/\.(pack|idx)$/, '') ?? ''
  const dash = stem.indexOf('-')
  if (dash === -1) return null
  const id = stem.slice(dash + 1)
  return id === '' ? null : id
}

/**
 * When a WAL object was uploaded, from the ULID in its key.
 *
 * The upload time is in the key rather than read from the store because not
 * every store reports one, and a restore has to be able to reason about age
 * from the listing alone.
 */
export function walKeyUploadedAt(key: string): number | null {
  const id = walKeyUlid(key)
  return id === null ? null : ulidTime(id)
}

/**
 * Which repositories does this bucket hold?
 *
 * `listPrefixes` when the store has it — one delimited LIST instead of walking
 * every key in the bucket — and otherwise derived from the keys themselves, so
 * a store that cannot roll up prefixes still answers correctly rather than not
 * at all.
 */
export async function listRepoIds(store: ObjectStore): Promise<string[]> {
  if (store.listPrefixes) {
    const prefixes = await store.listPrefixes(REPOS_PREFIX)
    return prefixes
      .map((p) => p.slice(REPOS_PREFIX.length).replace(/\/$/, ''))
      .filter((id) => id.length > 0)
      .sort()
  }
  const keys = await store.list(REPOS_PREFIX)
  const ids = new Set<string>()
  for (const key of keys) {
    const id = key.slice(REPOS_PREFIX.length).split('/')[0]
    if (id) ids.add(id)
  }
  return [...ids].sort()
}
