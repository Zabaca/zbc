/**
 * Deleting a repository, and the four ways doing it carelessly loses data.
 *
 * Written from the failure each rule prevents: a clone cut off mid-transfer, an
 * index left naming objects that are gone, an operator who typed the command by
 * accident, and a caller racing another caller over the same repository.
 */
import { describe, expect, test } from 'bun:test'

import { deleteRepo, repoPrefix } from './delete-repo'
import { findOrphans } from './orphans'
import { collectGarbage } from './gc'
import { MemoryStore } from './store'
import { ulid } from './ulid'
import { commitIndex, emptyIndex, loadIndex, walKey, type WalIndex } from './wal-index'

const GRACE = 60 * 60 * 1000
const NOW = new Date('2026-08-28T12:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)
const now = () => NOW

/** A repository with two published entries and their sibling `.idx` objects. */
async function seedRepo(store: MemoryStore, repoId = 'r'): Promise<WalIndex> {
  const keys = [
    walKey(repoId, 1, ulid(NOW.getTime() - 5 * GRACE), 'pack'),
    walKey(repoId, 2, ulid(NOW.getTime() - 4 * GRACE), 'pack'),
  ]
  for (const key of keys) {
    await store.put(key, new Uint8Array([1]))
    await store.put(key.replace(/\.pack$/, '.idx'), new Uint8Array([2]))
  }
  const index: WalIndex = {
    ...emptyIndex(repoId),
    seq: 2,
    entries: keys.map((key, i) => ({
      seq: i + 1,
      key,
      kind: 'push' as const,
      size: 1,
      sha256: 'a'.repeat(64),
      ts: NOW.toISOString(),
    })),
    refs: { 'refs/heads/main': 'c'.repeat(40) },
  }
  await commitIndex(store, index, null)
  return index
}

/** Tombstone, then jump past the grace period. The normal two-step. */
async function scheduleAndCollect(store: MemoryStore, repoId = 'r') {
  await deleteRepo(store, repoId, { now, graceMs: GRACE, dryRun: false })
  return deleteRepo(store, repoId, {
    now: () => at(GRACE + 1),
    graceMs: GRACE,
    dryRun: false,
  })
}

describe('deferral', () => {
  test('the first request only tombstones — a clone in flight keeps its objects', async () => {
    const store = new MemoryStore()
    const index = await seedRepo(store)

    const result = await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false })

    expect(result.status).toBe('tombstoned')
    expect(result.deleted).toEqual([])
    // Every object the index names is still readable.
    for (const entry of index.entries) expect(await store.get(entry.key)).not.toBeNull()
    const stored = await loadIndex(store, 'r')
    expect(stored.index.deletion?.collect_after).toBe(at(GRACE).toISOString())
  })

  test('inside the grace period nothing is deleted, and every object says why', async () => {
    const store = new MemoryStore()
    await seedRepo(store)
    await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false })

    const result = await deleteRepo(store, 'r', {
      now: () => at(GRACE - 1),
      graceMs: GRACE,
      dryRun: false,
    })

    expect(result.status).toBe('retained')
    expect(result.deleted).toEqual([])
    expect(result.retained.length).toBeGreaterThan(0)
    for (const kept of result.retained) {
      expect(kept.reason).toContain(at(GRACE).toISOString())
    }
    expect((await store.list(repoPrefix('r'))).length).toBeGreaterThan(0)
  })

  test('asking again does not restart the clock', async () => {
    const store = new MemoryStore()
    await seedRepo(store)
    await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false })

    await deleteRepo(store, 'r', {
      now: () => at(GRACE / 2),
      graceMs: GRACE,
      dryRun: false,
    })

    const stored = await loadIndex(store, 'r')
    expect(stored.index.deletion?.collect_after).toBe(at(GRACE).toISOString())
  })
})

describe('collection', () => {
  test('removes the index and every entry it names', async () => {
    const store = new MemoryStore()
    const index = await seedRepo(store)

    const result = await scheduleAndCollect(store)

    expect(result.status).toBe('collected')
    for (const entry of index.entries) {
      expect(await store.get(entry.key)).toBeNull()
      expect(await store.get(entry.key.replace(/\.pack$/, '.idx'))).toBeNull()
    }
    expect(await store.list(repoPrefix('r'))).toEqual([])
    expect(result.deleted).toContain('repos/r/index.json')
  })

  test('leaves other repositories untouched', async () => {
    const store = new MemoryStore()
    await seedRepo(store, 'r')
    await seedRepo(store, 'rr')

    await scheduleAndCollect(store, 'r')

    expect((await store.list(repoPrefix('rr'))).length).toBeGreaterThan(0)
  })

  test('removes the cached bare repo from disk', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-delete-'))
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')

    const store = new MemoryStore()
    await seedRepo(store)
    await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false, dir })
    const result = await deleteRepo(store, 'r', {
      now: () => at(GRACE + 1),
      graceMs: GRACE,
      dryRun: false,
      dir,
    })

    expect(result.cacheRemoved).toBe(dir)
    expect(fs.existsSync(dir)).toBe(false)
  })
})

describe('ordering', () => {
  /**
   * The crash that matters: the process dies after the index is gone and
   * before the objects are. What is left must be reclaimable orphans, not an
   * index naming an object that no longer exists.
   */
  test('a crash after the record is cleared leaves orphans, not a broken index', async () => {
    const store = new MemoryStore()
    const index = await seedRepo(store)

    // A store that dies on the first object delete, having already accepted
    // the index delete — the exact window the ordering rule exists for.
    let deletes = 0
    const crashing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== 'delete') return Reflect.get(target, prop, receiver)
        return async (key: string) => {
          deletes += 1
          if (deletes > 1) throw new Error('crash')
          return target.delete(key)
        }
      },
    }) as MemoryStore

    await deleteRepo(crashing, 'r', { now, graceMs: GRACE, dryRun: false })
    await expect(
      deleteRepo(crashing, 'r', { now: () => at(GRACE + 1), graceMs: GRACE, dryRun: false }),
    ).rejects.toThrow('crash')

    // The index is gone and the objects remain — so nothing references a
    // missing object, and everything left is discoverable as an orphan.
    expect(await store.get('repos/r/index.json')).toBeNull()
    const orphans = await findOrphans(store, 'r')
    for (const entry of index.entries) expect(orphans).toContain(entry.key)

    // And the collector reclaims them without any special knowledge.
    const gc = await collectGarbage(store, 'r', { now: () => at(GRACE + 1), graceMs: GRACE })
    expect(gc.orphansCollected.toSorted()).toEqual(orphans.toSorted())
    expect(await store.list(repoPrefix('r'))).toEqual([])
  })
})

describe('safety', () => {
  test('deleting a repository that does not exist is a no-op, not an error', async () => {
    const store = new MemoryStore()

    const result = await deleteRepo(store, 'nope', { now, graceMs: GRACE, dryRun: false })

    expect(result.status).toBe('absent')
    expect(result.deleted).toEqual([])
  })

  test('deleting an already-collected repository is a no-op', async () => {
    const store = new MemoryStore()
    await seedRepo(store)
    await scheduleAndCollect(store)

    const again = await deleteRepo(store, 'r', {
      now: () => at(2 * GRACE),
      graceMs: GRACE,
      dryRun: false,
    })

    expect(again.status).toBe('absent')
  })

  test('objects with no index are left to the collector, not resurrected', async () => {
    const store = new MemoryStore()
    await store.put(walKey('r', 1, ulid(NOW.getTime()), 'pack'), new Uint8Array([1]))

    const result = await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false })

    expect(result.status).toBe('absent')
    expect(await store.get('repos/r/index.json')).toBeNull()
    expect(result.retained[0]?.reason).toContain('walgit gc')
  })

  test('dry run is the default: no marker is written and nothing is deleted', async () => {
    const store = new MemoryStore()
    await seedRepo(store)

    const first = await deleteRepo(store, 'r', { now, graceMs: GRACE })
    expect(first.status).toBe('tombstoned')
    expect((await loadIndex(store, 'r')).index.deletion).toBeUndefined()

    // And a dry run past the grace period reports the objects without removing
    // them — but only once a real request has actually scheduled the deletion.
    await deleteRepo(store, 'r', { now, graceMs: GRACE, dryRun: false })
    const preview = await deleteRepo(store, 'r', { now: () => at(GRACE + 1), graceMs: GRACE })
    expect(preview.status).toBe('collected')
    expect(preview.deleted.length).toBeGreaterThan(0)
    expect((await store.list(repoPrefix('r'))).length).toBe(preview.deleted.length)
  })
})
