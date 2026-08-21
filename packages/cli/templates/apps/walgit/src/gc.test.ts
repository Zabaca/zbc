/**
 * What may be deleted, and — far more importantly — what may not.
 *
 * Every test here is written from the failure it prevents rather than the
 * behaviour it describes, because the failure mode is silence: a collected
 * object does not error until some later restore asks for it.
 */
import { describe, expect, test } from 'bun:test'

import { collectGarbage, keyAgeMs } from './gc'
import { MemoryStore } from './store'
import { ulid } from './ulid'
import { commitIndex, emptyIndex, loadIndex, walKey, type WalIndex } from './wal-index'

const GRACE = 60 * 60 * 1000
const NOW = new Date('2026-08-21T12:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

/** A WAL key whose ULID says it was uploaded `agoMs` ago. */
function keyAged(seq: number, agoMs: number): string {
  return walKey('r', seq, ulid(NOW.getTime() - agoMs), 'pack')
}

async function seed(store: MemoryStore, index: WalIndex, keys: string[]): Promise<void> {
  for (const key of keys) {
    await store.put(key, new Uint8Array([1]))
    await store.put(key.replace(/\.pack$/, '.idx'), new Uint8Array([2]))
  }
  await commitIndex(store, index, null)
}

describe('tombstoned entries', () => {
  const live = keyAged(3, 5 * GRACE)
  const superseded = keyAged(1, 5 * GRACE)

  function compacted(collectAfter: string): WalIndex {
    return {
      ...emptyIndex('r'),
      seq: 3,
      compaction_frontier: 1,
      entries: [
        {
          seq: 1,
          key: superseded,
          kind: 'push',
          size: 1,
          sha256: 'a'.repeat(64),
          ts: '2026-08-21T00:00:00Z',
        },
        {
          seq: 3,
          key: live,
          kind: 'compaction',
          size: 1,
          sha256: 'b'.repeat(64),
          ts: '2026-08-21T00:00:00Z',
          supersedes_through: 1,
        },
      ],
      refs: { 'refs/heads/main': 'c'.repeat(40) },
      tombstones: [{ key: superseded, superseded_by: 3, collect_after: collectAfter }],
    }
  }

  test('inside the grace period nothing is touched, however superseded it is', async () => {
    const store = new MemoryStore()
    await seed(store, compacted(at(30 * 60 * 1000).toISOString()), [live, superseded])

    const result = await collectGarbage(store, 'r', { now: () => NOW, graceMs: GRACE })
    expect(result.collected).toEqual([])
    expect(result.retained).toEqual([superseded])
    // This is the assertion the whole design turns on: a restore that read the
    // pre-compaction index a moment ago can still download what it named.
    expect(await store.get(superseded)).not.toBeNull()
  })

  test('after the grace period the key and its sibling idx go, and the entry with them', async () => {
    const store = new MemoryStore()
    await seed(store, compacted(at(-1).toISOString()), [live, superseded])

    const result = await collectGarbage(store, 'r', { now: () => NOW, graceMs: GRACE })
    expect(result.collected).toEqual([superseded])
    expect(await store.get(superseded)).toBeNull()
    expect(await store.get(superseded.replace(/\.pack$/, '.idx'))).toBeNull()

    const { index } = await loadIndex(store, 'r')
    expect(index.entries.map((e) => e.seq)).toEqual([3])
    expect(index.tombstones).toEqual([])
    // The compaction entry that superseded it is untouched — it is the only
    // thing standing between the log and an unrestorable repository.
    expect(await store.get(live)).not.toBeNull()
  })

  test('a dry run reports the same set and deletes none of it', async () => {
    const store = new MemoryStore()
    await seed(store, compacted(at(-1).toISOString()), [live, superseded])

    const result = await collectGarbage(store, 'r', {
      now: () => NOW,
      graceMs: GRACE,
      dryRun: true,
    })
    expect(result.collected).toEqual([superseded])
    expect(await store.get(superseded)).not.toBeNull()
    expect((await loadIndex(store, 'r')).index.entries).toHaveLength(2)
  })
})

describe('orphans', () => {
  test('an old unreferenced upload is collected and a referenced one is not', async () => {
    const store = new MemoryStore()
    const live = keyAged(1, 5 * GRACE)
    const orphan = keyAged(2, 5 * GRACE)
    await seed(
      store,
      {
        ...emptyIndex('r'),
        seq: 1,
        entries: [
          {
            seq: 1,
            key: live,
            kind: 'push',
            size: 1,
            sha256: 'a'.repeat(64),
            ts: '2026-08-21T00:00:00Z',
          },
        ],
      },
      [live, orphan],
    )

    const result = await collectGarbage(store, 'r', { now: () => NOW, graceMs: GRACE })
    expect(result.orphansCollected.sort()).toEqual(
      [orphan, orphan.replace(/\.pack$/, '.idx')].sort(),
    )
    expect(await store.get(orphan)).toBeNull()
    expect(await store.get(live)).not.toBeNull()
    expect(await store.get(live.replace(/\.pack$/, '.idx'))).not.toBeNull()
  })

  test('a young orphan is held — it may belong to a push still in flight', async () => {
    const store = new MemoryStore()
    const inFlight = keyAged(1, 5_000)
    await store.put(inFlight, new Uint8Array([1]))

    const result = await collectGarbage(store, 'r', { now: () => NOW, graceMs: GRACE })
    expect(result.orphansCollected).toEqual([])
    expect(result.orphansHeld).toEqual([inFlight])
    expect(await store.get(inFlight)).not.toBeNull()
  })

  test('a key whose age cannot be read is held forever rather than guessed at', async () => {
    const store = new MemoryStore()
    await store.put('repos/r/wal/not-a-walgit-key', new Uint8Array([1]))

    const result = await collectGarbage(store, 'r', { now: () => NOW, graceMs: GRACE })
    expect(result.orphansCollected).toEqual([])
    expect(result.orphansHeld).toEqual(['repos/r/wal/not-a-walgit-key'])
  })
})

describe('keyAgeMs', () => {
  test('reads the upload time out of the key, with no metadata call', () => {
    expect(keyAgeMs(keyAged(4, 90_000), NOW.getTime())).toBe(90_000)
    expect(keyAgeMs('repos/r/wal/000000000004-nope.pack', NOW.getTime())).toBeNull()
  })
})
