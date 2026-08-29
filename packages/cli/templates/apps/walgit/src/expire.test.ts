import { describe, expect, test } from 'bun:test'

import { configuredExpiryMs, decideExpiry, expireRepos, lastWriteAt } from './expire'
import { MemoryStore } from './store'
import { commitIndex, emptyIndex, type WalEntry, type WalIndex } from './wal-index'

const HOUR = 3_600_000
const WINDOW = 24 * HOUR
const NOW = new Date('2026-08-29T12:00:00.000Z')

function entry(ts: string, seq = 1): WalEntry {
  return { seq, key: `repos/r/wal/${seq}.pack`, kind: 'push', size: 1, sha256: 'x', ts }
}

function indexWith(entries: WalEntry[], repoId = 'alpha'): WalIndex {
  return { ...emptyIndex(repoId), seq: entries.length, entries }
}

// The predicate is tested directly, and mostly along the direction that loses
// data: anything it cannot prove must come back RETAIN.
describe('decideExpiry', () => {
  test('collects a repository whose last push is past the window', () => {
    const index = indexWith([entry('2026-08-27T00:00:00.000Z')])
    const decision = decideExpiry(index, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('collect')
    expect(decision.lastPushAt).toBe('2026-08-27T00:00:00.000Z')
    expect(decision.reason).toContain('past the')
  })

  test('retains a repository pushed to inside the window, with a reason', () => {
    const index = indexWith([entry('2026-08-29T09:00:00.000Z')])
    const decision = decideExpiry(index, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('inside the')
  })

  test('a later push extends life — the newest entry is the signal', () => {
    const stale = indexWith([entry('2026-08-01T00:00:00.000Z', 1)])
    expect(decideExpiry(stale, { now: NOW, windowMs: WINDOW }).verdict).toBe('collect')

    const pushed = indexWith([
      entry('2026-08-01T00:00:00.000Z', 1),
      entry('2026-08-29T11:59:00.000Z', 2),
    ])
    expect(decideExpiry(pushed, { now: NOW, windowMs: WINDOW }).verdict).toBe('retain')
  })

  test('an index with no entries is retained, not read as infinitely old', () => {
    const decision = decideExpiry(emptyIndex('alpha'), { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('parseable timestamp')
  })

  test('an unparseable timestamp is retained, not read as epoch zero', () => {
    const index = indexWith([entry('not-a-date')])
    expect(decideExpiry(index, { now: NOW, windowMs: WINDOW }).verdict).toBe('retain')
  })

  test('an unparseable timestamp beside a good one does not shadow it', () => {
    const index = indexWith([entry('not-a-date', 1), entry('2026-08-29T11:00:00.000Z', 2)])
    const decision = decideExpiry(index, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('retain')
    expect(decision.lastPushAt).toBe('2026-08-29T11:00:00.000Z')
  })

  test('a timestamp in the future is clock skew, and says so', () => {
    const index = indexWith([entry('2027-01-01T00:00:00.000Z')])
    const decision = decideExpiry(index, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('clock skew')
  })

  test('a missing index is left to the orphan collector', () => {
    const decision = decideExpiry(null, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('no index.json')
  })

  test('nothing is collected when no window is configured', () => {
    const index = indexWith([entry('2020-01-01T00:00:00.000Z')])
    const decision = decideExpiry(index, { now: NOW, windowMs: null })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('not configured')
  })

  test('a tombstoned repository waits out its grace, then is handed back', () => {
    const inGrace: WalIndex = {
      ...indexWith([entry('2026-08-01T00:00:00.000Z')]),
      deletion: { requested_at: NOW.toISOString(), collect_after: '2026-08-29T13:00:00.000Z' },
    }
    expect(decideExpiry(inGrace, { now: NOW, windowMs: WINDOW }).verdict).toBe('retain')

    const elapsed: WalIndex = {
      ...inGrace,
      deletion: { requested_at: NOW.toISOString(), collect_after: '2026-08-29T11:00:00.000Z' },
    }
    const decision = decideExpiry(elapsed, { now: NOW, windowMs: WINDOW })
    expect(decision.verdict).toBe('collect')
    expect(decision.reason).toContain('grace period elapsed')
  })
})

describe('lastWriteAt', () => {
  test('a compaction entry dates the repository when it is all that is left', () => {
    const index = indexWith([
      { ...entry('2026-08-29T10:00:00.000Z', 7), kind: 'compaction', supersedes_through: 6 },
    ])
    expect(lastWriteAt(index)).toBe('2026-08-29T10:00:00.000Z')
  })
})

describe('configuredExpiryMs', () => {
  test('off unless configured, and off for anything unusable', () => {
    expect(configuredExpiryMs({} as NodeJS.ProcessEnv)).toBeNull()
    expect(configuredExpiryMs({ WALGIT_RETENTION_HOURS: '' } as NodeJS.ProcessEnv)).toBeNull()
    expect(configuredExpiryMs({ WALGIT_RETENTION_HOURS: 'soon' } as NodeJS.ProcessEnv)).toBeNull()
    expect(configuredExpiryMs({ WALGIT_RETENTION_HOURS: '0' } as NodeJS.ProcessEnv)).toBeNull()
    expect(configuredExpiryMs({ WALGIT_RETENTION_HOURS: '24' } as NodeJS.ProcessEnv)).toBe(WINDOW)
  })
})

async function seed(store: MemoryStore, repoId: string, ts: string): Promise<void> {
  const index = indexWith([entry(ts)], repoId)
  const committed = await commitIndex(store, index, null)
  if (!committed.ok) throw new Error(`could not seed ${repoId}`)
  await store.put(`repos/${repoId}/wal/000000000001-x.pack`, new Uint8Array([1]))
}

describe('expireRepos', () => {
  test('sweeps the store, collecting the stale and naming the retained', async () => {
    const store = new MemoryStore()
    await seed(store, 'stale', '2026-08-01T00:00:00.000Z')
    await seed(store, 'fresh', '2026-08-29T11:00:00.000Z')

    const result = await expireRepos(store, { now: () => NOW, windowMs: WINDOW })

    expect(result.collected.map((c) => c.repoId)).toEqual(['stale'])
    expect(result.retained.map((r) => r.repoId)).toEqual(['fresh'])
    expect(result.retained[0]!.decision.reason).toContain('inside the')
    // Dry run by default: the tombstone is described, never written.
    expect(result.dryRun).toBe(true)
    expect(result.collected[0]!.deletion?.status).toBe('tombstoned')
    expect((await store.get('repos/stale/index.json'))!.body).toBeDefined()
    const reread = await expireRepos(store, { now: () => NOW, windowMs: WINDOW })
    expect(reread.collected[0]!.deletion?.status).toBe('tombstoned')
  })

  test('nothing at all happens when expiry is unconfigured', async () => {
    const store = new MemoryStore()
    await seed(store, 'ancient', '2020-01-01T00:00:00.000Z')

    const result = await expireRepos(store, { now: () => NOW, windowMs: null, dryRun: false })
    expect(result.collected).toEqual([])
    expect(result.retained).toEqual([])
    expect(await store.get('repos/ancient/index.json')).not.toBeNull()
  })

  test('--yes tombstones first, and removes only after the grace period', async () => {
    const store = new MemoryStore()
    await seed(store, 'stale', '2026-08-01T00:00:00.000Z')

    const first = await expireRepos(store, {
      now: () => NOW,
      windowMs: WINDOW,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(first.collected[0]!.deletion?.status).toBe('tombstoned')
    // Still here: a clone that read the index a moment ago must finish.
    expect(await store.get('repos/stale/index.json')).not.toBeNull()

    const during = await expireRepos(store, {
      now: () => new Date(NOW.getTime() + 30 * 60_000),
      windowMs: WINDOW,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(during.retained[0]!.decision.reason).toContain('already scheduled')

    const after = await expireRepos(store, {
      now: () => new Date(NOW.getTime() + 2 * HOUR),
      windowMs: WINDOW,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(after.collected[0]!.deletion?.status).toBe('collected')
    expect(await store.get('repos/stale/index.json')).toBeNull()
    expect(await store.list('repos/stale/')).toEqual([])
  })

  test('a push during the sweep window keeps the repository alive', async () => {
    const store = new MemoryStore()
    await seed(store, 'busy', '2026-08-01T00:00:00.000Z')
    // The agent pushes: a new entry lands, and the signal moves with it.
    const current = await store.get('repos/busy/index.json')
    await commitIndex(
      store,
      indexWith([entry('2026-08-29T11:30:00.000Z', 2)], 'busy'),
      current!.etag,
    )

    const result = await expireRepos(store, { now: () => NOW, windowMs: WINDOW, dryRun: false })
    expect(result.collected).toEqual([])
    expect(result.retained.map((r) => r.repoId)).toEqual(['busy'])
  })

  test('a repository with objects but no index is left to the orphan collector', async () => {
    const store = new MemoryStore()
    await store.put('repos/headless/wal/000000000001-x.pack', new Uint8Array([1]))

    const result = await expireRepos(store, { now: () => NOW, windowMs: WINDOW, dryRun: false })
    // Enumerated, but nothing dates it, so expiry keeps its hands off: those
    // objects are orphans, and reclaiming orphans is `gc`'s job.
    expect(result.collected).toEqual([])
    expect(result.retained[0]!.decision.reason).toContain('no index.json')
    expect(await store.get('repos/headless/wal/000000000001-x.pack')).not.toBeNull()
  })
})
