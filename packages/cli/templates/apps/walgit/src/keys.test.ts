/**
 * The storage layout, tested as a layout.
 *
 * These are the strings the bucket is addressed by, so they are not an
 * implementation detail of whichever module writes them: a repository whose
 * keys changed shape would be a repository the previous version of this code
 * cannot read, and there is no migration for an object store that IS the source
 * of truth (docs/adr/0007). So the exact spellings are pinned here rather than
 * asserted incidentally through the modules that build them.
 *
 * The round trip matters as much as the spelling. `gc.ts` used to take a WAL
 * key apart by hand, six modules away from the code that assembled it, which is
 * why `walKeyUlid` and `walKey` are tested against each other.
 */
import { describe, expect, test } from 'bun:test'

import {
  indexKey,
  leaseKey,
  listRepoIds,
  repoPrefix,
  siblingIdx,
  walKey,
  walKeyUlid,
  walKeyUploadedAt,
  walPrefix,
} from './keys'
import { MemoryStore, type ObjectStore } from './store'
import { ulid } from './ulid'

describe('the layout', () => {
  test('everything for one repository is under one prefix', () => {
    const prefix = repoPrefix('ses_01J')
    expect(prefix).toBe('repos/ses_01J/')
    for (const key of [
      indexKey('ses_01J'),
      leaseKey('ses_01J'),
      walPrefix('ses_01J'),
      walKey('ses_01J', 1, 'ULID', 'pack'),
    ]) {
      expect(key.startsWith(prefix)).toBe(true)
    }
  })

  test('the spellings are the ones already in every bucket', () => {
    expect(indexKey('r')).toBe('repos/r/index.json')
    expect(leaseKey('r')).toBe('repos/r/compaction.lease')
    expect(walPrefix('r')).toBe('repos/r/wal/')
    expect(walKey('r', 42, 'ULID', 'pack')).toBe('repos/r/wal/000000000042-ULID.pack')
  })

  test('wal keys zero-pad so lexicographic order is numeric order', () => {
    const a = walKey('r', 9, 'ulid', 'pack')
    const b = walKey('r', 10, 'ulid', 'pack')
    expect(a).toContain('000000000009')
    expect([b, a].sort()).toEqual([a, b])
  })

  test('the sibling idx is the pack with one extension swapped', () => {
    expect(siblingIdx(walKey('r', 1, 'ULID', 'pack'))).toBe(walKey('r', 1, 'ULID', 'idx'))
  })
})

describe('reading a key back', () => {
  test('a wal key round-trips its ulid, from either extension', () => {
    const id = ulid(Date.now())
    expect(walKeyUlid(walKey('r', 7, id, 'pack'))).toBe(id)
    expect(walKeyUlid(walKey('r', 7, id, 'idx'))).toBe(id)
  })

  test('the upload time comes out of the key, with no metadata call', () => {
    const at = Date.now()
    const key = walKey('r', 7, ulid(at), 'pack')
    // ULID timestamps are whole milliseconds, so this is exact, not close.
    expect(walKeyUploadedAt(key)).toBe(at)
  })

  // Null is "leave it alone", not "it is ancient" — the collector is the only
  // caller, and the asymmetry there is that under-retaining loses data silently.
  test('a key this file did not write dates to null rather than to zero', () => {
    expect(walKeyUlid('repos/r/wal/000000000004-nope.pack')).toBe('nope')
    expect(walKeyUploadedAt('repos/r/wal/000000000004-nope.pack')).toBeNull()
    expect(walKeyUlid('repos/r/index.json')).toBeNull()
    expect(walKeyUploadedAt('repos/r/wal/plain.pack')).toBeNull()
  })
})

describe('listRepoIds', () => {
  test('derives ids from a full listing when the store has no delimiter support', async () => {
    const store = new MemoryStore()
    await store.put(indexKey('alpha'), new Uint8Array([1]))
    await store.put(walKey('beta', 1, 'x', 'pack'), new Uint8Array([1]))
    expect(await listRepoIds(store)).toEqual(['alpha', 'beta'])
  })

  test('prefers the delimited listing when the store offers one', async () => {
    const inner = new MemoryStore()
    let listed = 0
    const store: ObjectStore = {
      get: (key) => inner.get(key),
      getIfNoneMatch: (key, etag) => inner.getIfNoneMatch(key, etag),
      put: (key, body, cond) => inner.put(key, body, cond),
      delete: (key) => inner.delete(key),
      list: async (prefix) => {
        listed += 1
        return inner.list(prefix)
      },
      listPrefixes: async () => [repoPrefix('alpha'), repoPrefix('beta')],
    }
    expect(await listRepoIds(store)).toEqual(['alpha', 'beta'])
    expect(listed).toBe(0)
  })
})
