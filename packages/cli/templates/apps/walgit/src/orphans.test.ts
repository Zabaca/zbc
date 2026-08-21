import { describe, expect, test } from 'bun:test'

import { MemoryStore } from './store'
import { findOrphans } from './orphans'
import { commitIndex, emptyIndex, walKey } from './wal-index'

describe('findOrphans', () => {
  test('an uploaded pack no index entry names is an orphan, and its idx with it', async () => {
    const store = new MemoryStore()
    const live = walKey('r', 1, 'AAA', 'pack')
    const dead = walKey('r', 2, 'BBB', 'pack')
    for (const key of [live, dead, walKey('r', 1, 'AAA', 'idx'), walKey('r', 2, 'BBB', 'idx')]) {
      await store.put(key, new Uint8Array([1]))
    }
    await commitIndex(
      store,
      {
        ...emptyIndex('r'),
        seq: 1,
        entries: [
          { seq: 1, key: live, kind: 'push', size: 1, sha256: 'x'.repeat(64), ts: '2026-08-21T00:00:00Z' },
        ],
      },
      null,
    )

    expect(await findOrphans(store, 'r')).toEqual([walKey('r', 2, 'BBB', 'idx'), dead])
  })

  test('with no index at all, every uploaded object is an orphan', async () => {
    const store = new MemoryStore()
    await store.put(walKey('r', 1, 'AAA', 'pack'), new Uint8Array([1]))
    expect(await findOrphans(store, 'r')).toHaveLength(1)
  })
})
