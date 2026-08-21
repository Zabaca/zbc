import { describe, expect, test } from 'bun:test'

import {
  acquireLease,
  configuredGraceMs,
  configuredThreshold,
  isCompactionDue,
  leaseKey,
  pendingEntries,
} from './compact'
import { MemoryStore } from './store'
import { ulid, ulidTime } from './ulid'
import { emptyIndex, walKey, type WalEntry, type WalIndex } from './wal-index'

function entry(seq: number): WalEntry {
  return {
    seq,
    key: walKey('r', seq, `E${String(seq).padStart(25, '0')}`, 'pack'),
    kind: 'push',
    size: 1,
    sha256: 'a'.repeat(64),
    ts: '2026-08-21T00:00:00.000Z',
  }
}

function indexWith(count: number, frontier = 0): WalIndex {
  const entries = Array.from({ length: count }, (_, i) => entry(i + 1))
  return { ...emptyIndex('r'), seq: count, entries, compaction_frontier: frontier }
}

describe('when compaction is due', () => {
  test('the frontier, not the entry count, is what counts', () => {
    expect(pendingEntries(indexWith(10, 8))).toHaveLength(2)
    expect(isCompactionDue(indexWith(10, 8), 3)).toBe(false)
    expect(isCompactionDue(indexWith(10, 0), 3)).toBe(true)
  })

  test('a single pending entry is never due — compacting it would win nothing', () => {
    expect(isCompactionDue(indexWith(1, 0), 1)).toBe(false)
    expect(isCompactionDue(indexWith(2, 0), 1)).toBe(true)
  })

  test('the threshold is configurable, and nonsense falls back to the default', () => {
    expect(configuredThreshold({ WALGIT_COMPACTION_THRESHOLD: '7' })).toBe(7)
    expect(configuredThreshold({ WALGIT_COMPACTION_THRESHOLD: 'later' })).toBe(50)
    expect(configuredThreshold({ WALGIT_COMPACTION_THRESHOLD: '0' })).toBe(50)
    expect(configuredGraceMs({ WALGIT_GC_GRACE_MS: '0' })).toBe(0)
    expect(configuredGraceMs({})).toBe(60 * 60 * 1000)
  })
})

describe('the compaction lease', () => {
  const at = (iso: string) => new Date(iso)

  test('one node takes it and the other is told who holds it', async () => {
    const store = new MemoryStore()
    const first = await acquireLease(store, 'r', {
      holder: 'node-a',
      now: at('2026-08-21T00:00:00Z'),
    })
    expect(first.ok).toBe(true)

    const second = await acquireLease(store, 'r', {
      holder: 'node-b',
      now: at('2026-08-21T00:01:00Z'),
    })
    expect(second).toEqual({ ok: false, reason: 'held', holder: 'node-a' })
  })

  test('two nodes racing from nothing produce exactly one holder', async () => {
    // The yield hook is what makes this a race rather than two sequential
    // writes: without a suspension between read and write, a broken CAS passes.
    const store = new MemoryStore(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    const [a, b] = await Promise.all([
      acquireLease(store, 'r', { holder: 'a', now: at('2026-08-21T00:00:00Z') }),
      acquireLease(store, 'r', { holder: 'b', now: at('2026-08-21T00:00:00Z') }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })

  test('an expired lease is stealable — a stopped machine must not wedge the repo', async () => {
    const store = new MemoryStore()
    await acquireLease(store, 'r', {
      holder: 'dead-node',
      now: at('2026-08-21T00:00:00Z'),
      ttlMs: 60_000,
    })
    const stolen = await acquireLease(store, 'r', {
      holder: 'live-node',
      now: at('2026-08-21T00:02:00Z'),
    })
    expect(stolen.ok).toBe(true)
  })

  test('releasing is holder-scoped: the evicted node cannot free the thief', async () => {
    const store = new MemoryStore()
    const dead = await acquireLease(store, 'r', {
      holder: 'dead-node',
      now: at('2026-08-21T00:00:00Z'),
      ttlMs: 60_000,
    })
    const live = await acquireLease(store, 'r', {
      holder: 'live-node',
      now: at('2026-08-21T00:02:00Z'),
    })
    expect(live.ok).toBe(true)
    if (dead.ok) await dead.release()

    // Still held by the thief, so a third node still declines.
    const third = await acquireLease(store, 'r', {
      holder: 'third',
      now: at('2026-08-21T00:02:30Z'),
    })
    expect(third).toEqual({ ok: false, reason: 'held', holder: 'live-node' })

    if (live.ok) await live.release()
    expect(await store.get(leaseKey('r'))).toBeNull()
  })
})

describe('ulidTime', () => {
  test('round-trips the millisecond a WAL object was uploaded', () => {
    const now = 1_755_734_400_000
    expect(ulidTime(ulid(now))).toBe(now)
  })

  test('refuses anything that is not a ULID, so an undatable key is never collected', () => {
    expect(ulidTime('short')).toBeNull()
    expect(ulidTime('UUUUUUUUUU!')).toBeNull()
    expect(ulidTime('0123456U89ZZZZZZZZZZZZZZZZ')).toBeNull()
  })
})
