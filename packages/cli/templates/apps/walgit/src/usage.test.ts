/**
 * Usage read out of the log.
 *
 * Two properties carry the whole ticket and both are tested from the failure
 * they prevent: the arithmetic must match a store whose contents are known
 * exactly (an operator who cannot trust the number will not use the command),
 * and the command must never write (it is run precisely when the service is
 * already in trouble).
 */
import { describe, expect, test } from 'bun:test'

import { walKey } from './keys'
import { MemoryStore, type ObjectStore, type PutResult } from './store'
import { collectUsage, formatBytes, formatUsage, parseDuration, usageOfIndex } from './usage'
import { commitIndex, emptyIndex, type WalEntry, type WalIndex } from './wal-index'

const NOW = new Date('2026-08-28T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

function entry(seq: number, size: number, ts: string, kind: WalEntry['kind'] = 'push'): WalEntry {
  return { seq, key: walKey('r', seq, `ulid${seq}`, 'pack'), kind, size, sha256: 'x', ts }
}

/** An index with the given entries, plus one ref per repository. */
function indexOf(repoId: string, entries: WalEntry[], frontier = 0): WalIndex {
  return {
    ...emptyIndex(repoId),
    seq: entries.at(-1)?.seq ?? 0,
    entries: entries.map((e) => ({ ...e, key: e.key.replace('repos/r/', `repos/${repoId}/`) })),
    refs: { 'refs/heads/main': 'a'.repeat(40) },
    compaction_frontier: frontier,
  }
}

async function seed(store: ObjectStore, ...indexes: WalIndex[]): Promise<void> {
  for (const index of indexes) await commitIndex(store, index, null)
}

describe('collectUsage', () => {
  test('counts repositories and total bytes', async () => {
    const store = new MemoryStore()
    await seed(
      store,
      indexOf('alpha', [entry(1, 100, hoursAgo(5)), entry(2, 200, hoursAgo(1))]),
      indexOf('beta', [entry(1, 50, hoursAgo(2))]),
    )

    const report = await collectUsage(store, { now: () => NOW })
    expect(report.repos).toBe(2)
    expect(report.bytes).toBe(350)
    expect(report.entries).toBe(3)
    expect(report.pushes).toBe(3)
  })

  test('orders the largest repositories by bytes, and truncates to --top', async () => {
    const store = new MemoryStore()
    await seed(
      store,
      indexOf('small', [entry(1, 10, hoursAgo(1))]),
      indexOf('huge', [entry(1, 9_000, hoursAgo(1))]),
      indexOf('medium', [entry(1, 500, hoursAgo(1))]),
    )

    const all = await collectUsage(store, { now: () => NOW })
    expect(all.largest.map((r) => r.repoId)).toEqual(['huge', 'medium', 'small'])

    const two = await collectUsage(store, { now: () => NOW, top: 2 })
    expect(two.largest.map((r) => r.repoId)).toEqual(['huge', 'medium'])
    // Truncating the list must not truncate the totals — the whole point of the
    // command is that the invoice is visible even when the offender is not.
    expect(two.bytes).toBe(9_510)
    expect(two.repos).toBe(3)
  })

  test('counts pushes inside the window and excludes those outside it', async () => {
    const store = new MemoryStore()
    await seed(
      store,
      indexOf('alpha', [
        entry(1, 10, hoursAgo(50)), // outside a 24h window
        entry(2, 20, hoursAgo(10)),
        entry(3, 30, hoursAgo(2)),
      ]),
    )

    const day = await collectUsage(store, { now: () => NOW, sinceMs: 24 * 3_600_000 })
    expect(day.pushesInWindow).toBe(2)
    expect(day.bytesInWindow).toBe(50)
    expect(day.pushes).toBe(3)

    const week = await collectUsage(store, { now: () => NOW, sinceMs: 7 * 24 * 3_600_000 })
    expect(week.pushesInWindow).toBe(3)
  })

  test('buckets pushes by hour, ending at now', async () => {
    const store = new MemoryStore()
    await seed(
      store,
      indexOf('alpha', [
        entry(1, 10, hoursAgo(3)),
        entry(2, 20, hoursAgo(3)),
        entry(3, 30, hoursAgo(0.5)),
      ]),
    )

    const report = await collectUsage(store, { now: () => NOW, sinceMs: 6 * 3_600_000 })
    expect(report.window?.bucketHours).toBe(1)
    expect(report.buckets).toHaveLength(6)
    expect(report.buckets.reduce((n, b) => n + b.pushes, 0)).toBe(3)
    // Six one-hour slices ending at now: three hours back is the slice starting
    // at index 3, and the newest push lands in the last one.
    expect(report.buckets[3]!.pushes).toBe(2)
    expect(report.buckets[3]!.bytes).toBe(30)
    expect(report.buckets.at(-1)!.pushes).toBe(1)
  })

  test('separates live bytes from bytes the frontier has superseded', async () => {
    const store = new MemoryStore()
    await seed(store, indexOf('alpha', [entry(1, 100, hoursAgo(9)), entry(2, 400, hoursAgo(1))], 1))

    const report = await collectUsage(store, { now: () => NOW })
    expect(report.bytes).toBe(500)
    expect(report.liveBytes).toBe(400)
    expect(formatUsage(report)).toContain('superseded')
  })

  test('names a prefix whose index is unreadable instead of dropping it', async () => {
    const store = new MemoryStore()
    await seed(store, indexOf('alpha', [entry(1, 10, hoursAgo(1))]))
    // A rejected first push: a pack under the prefix and no index above it.
    await store.put('repos/ghost/wal/000000000001-x.pack', new Uint8Array([1]))

    const report = await collectUsage(store, { now: () => NOW })
    expect(report.repos).toBe(1)
    expect(report.unreadable).toEqual([{ repoId: 'ghost', reason: 'no index.json' }])
    expect(formatUsage(report)).toContain('ghost')
  })

  test('flags a repository that is inside its deletion grace period', async () => {
    const store = new MemoryStore()
    const doomed = indexOf('doomed', [entry(1, 400, hoursAgo(2))])
    await seed(store, indexOf('alpha', [entry(1, 100, hoursAgo(2))]), {
      ...doomed,
      deletion: { requested_at: hoursAgo(1), collect_after: hoursAgo(-1) },
    })

    const report = await collectUsage(store, { now: () => NOW })
    // Its bytes still count — the bucket still holds them — but the total says
    // how much of itself is already on the way out.
    expect(report.bytes).toBe(500)
    expect(report.bytesPendingDeletion).toBe(400)
    expect(formatUsage(report)).toContain('(deleting)')
  })

  test('reports an empty store without failing', async () => {
    const report = await collectUsage(new MemoryStore(), { now: () => NOW })
    expect(report.repos).toBe(0)
    expect(report.bytes).toBe(0)
    expect(report.largest).toEqual([])
  })

  test('reads nothing but the store — no repos directory, no server', async () => {
    // The store double below is the whole environment: if the report needed a
    // local cache or a running node it could not be produced from this.
    const store = new MemoryStore()
    await seed(store, indexOf('alpha', [entry(1, 10, hoursAgo(1))]))
    await expect(collectUsage(store, { now: () => NOW })).resolves.toBeDefined()
  })

  test('is read-only: a store that refuses writes still produces a report', async () => {
    const inner = new MemoryStore()
    await seed(
      inner,
      indexOf('alpha', [entry(1, 10, hoursAgo(1))]),
      indexOf('beta', [entry(1, 20, hoursAgo(1))]),
    )
    const readOnly: ObjectStore = {
      get: (key) => inner.get(key),
      getIfNoneMatch: (key, etag) => inner.getIfNoneMatch(key, etag),
      list: (prefix) => inner.list(prefix),
      put: (): Promise<PutResult> => {
        throw new Error('usage wrote to the store')
      },
      delete: (): Promise<void> => {
        throw new Error('usage deleted from the store')
      },
    }

    const report = await collectUsage(readOnly, { now: () => NOW, sinceMs: 24 * 3_600_000 })
    expect(report.repos).toBe(2)
    expect(report.bytes).toBe(30)
  })
})

describe('usageOfIndex', () => {
  test('does not count a compaction entry as a push', () => {
    const row = usageOfIndex(
      indexOf('alpha', [entry(1, 100, hoursAgo(5)), entry(2, 90, hoursAgo(1), 'compaction')]),
    )
    expect(row.pushes).toBe(1)
    expect(row.pushBytes).toBe(100)
    expect(row.bytes).toBe(190)
    expect(row.lastPush).toBe(hoursAgo(5))
  })

  test('keeps an undatable entry in the totals but out of the window', () => {
    const row = usageOfIndex(indexOf('alpha', [entry(1, 100, 'not-a-date')]), {
      since: NOW.getTime() - 3_600_000,
      until: NOW.getTime(),
    })
    expect(row.bytes).toBe(100)
    expect(row.pushesInWindow).toBe(0)
  })
})

describe('parseDuration', () => {
  test('accepts the forms an operator types', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('24h')).toBe(86_400_000)
    expect(parseDuration('7d')).toBe(604_800_000)
    expect(parseDuration('2w')).toBe(1_209_600_000)
    expect(parseDuration('12')).toBe(43_200_000)
  })

  test('refuses what it cannot mean', () => {
    expect(() => parseDuration('yesterday')).toThrow('not a duration')
  })
})

describe('formatBytes', () => {
  test('reports binary units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GiB')
  })
})
