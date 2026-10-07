import { describe, expect, test } from 'bun:test'

import {
  configuredClaimedExpiryMs,
  configuredExpiryMs,
  decideExpiry,
  expireRepos,
  lastWriteAt,
} from './expire'
import { MemoryStore } from '../shared/store'
import { ZERO_OID } from '../shared/protocol'
import { emptyIndex, loadIndex, type WalEntry, type WalIndex } from '../shared/wal-index'
import { publishPush } from './push'
import { commitIndex } from './wal-index'

const HOUR = 3_600_000
const WINDOW = 24 * HOUR
const NOW = new Date('2026-08-29T12:00:00.000Z')

function entry(ts: string, seq = 1): WalEntry {
  return { seq, key: `repos/r/wal/${seq}.pack`, kind: 'push', size: 1, sha256: 'x', ts }
}

function indexWith(entries: WalEntry[], repoId = 'alpha'): WalIndex {
  return { ...emptyIndex(repoId), seq: entries.length, entries }
}

const WEEK = 7 * 24 * HOUR
const CLAIM = { signers: [`SHA256:${'a'.repeat(43)}`], ts: '2026-08-20T00:00:00.000Z' }

function claimedWith(entries: WalEntry[], repoId = 'alpha'): WalIndex {
  return { ...indexWith(entries, repoId), claim: CLAIM }
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

// A claim buys a longer window, and only a claim does: the unclaimed repository
// beside it, idle for the same time, still goes.
describe('decideExpiry — the claimed window', () => {
  const threeDaysAgo = '2026-08-26T12:00:00.000Z'

  test('a claimed repository past the base window but inside its own is retained', () => {
    const decision = decideExpiry(claimedWith([entry(threeDaysAgo)]), {
      now: NOW,
      windowMs: WINDOW,
      claimedWindowMs: WEEK,
    })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('inside the claimed 168h window')
  })

  test('an unclaimed repository idle as long is collected', () => {
    const decision = decideExpiry(indexWith([entry(threeDaysAgo)]), {
      now: NOW,
      windowMs: WINDOW,
      claimedWindowMs: WEEK,
    })
    expect(decision.verdict).toBe('collect')
    expect(decision.reason).not.toContain('claimed')
  })

  test('a claimed repository past its own window is collected, and says which window', () => {
    const decision = decideExpiry(claimedWith([entry('2026-08-20T00:00:00.000Z')]), {
      now: NOW,
      windowMs: WINDOW,
      claimedWindowMs: WEEK,
    })
    expect(decision.verdict).toBe('collect')
    expect(decision.reason).toContain('past the claimed 168h window')
  })

  test('with no claimed window, a claim changes nothing', () => {
    const index = claimedWith([entry(threeDaysAgo)])
    expect(decideExpiry(index, { now: NOW, windowMs: WINDOW }).verdict).toBe('collect')
    expect(decideExpiry(index, { now: NOW, windowMs: WINDOW, claimedWindowMs: null }).verdict).toBe(
      'collect',
    )
  })

  test('a claimed window does not switch expiry on by itself', () => {
    const decision = decideExpiry(claimedWith([entry('2020-01-01T00:00:00.000Z')]), {
      now: NOW,
      windowMs: null,
      claimedWindowMs: WEEK,
    })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('not configured')
  })
})

// The second daily sweep finishes what the first started and starts nothing.
describe('decideExpiry — collect only', () => {
  test('a repository past the window is not tombstoned, and says who will', () => {
    const decision = decideExpiry(indexWith([entry('2026-08-01T00:00:00.000Z')]), {
      now: NOW,
      windowMs: WINDOW,
      collectOnly: true,
    })
    expect(decision.verdict).toBe('retain')
    expect(decision.reason).toContain('next full sweep')
  })

  test('a tombstoned repository past its grace is still collected', () => {
    const index: WalIndex = {
      ...indexWith([entry('2026-08-01T00:00:00.000Z')]),
      deletion: {
        requested_at: '2026-08-29T10:00:00.000Z',
        collect_after: '2026-08-29T11:00:00.000Z',
      },
    }
    const decision = decideExpiry(index, { now: NOW, windowMs: WINDOW, collectOnly: true })
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

describe('configuredClaimedExpiryMs', () => {
  // The rules are capabilitiesFrom's, so only the two that matter here: it is
  // on with everything it needs, and off without expiry.
  const CLAIMABLE = {
    WALGIT_SIGNER_LISTS: '1',
    WALGIT_PUSH_CERT_SEED: 'seed',
    WALGIT_RETENTION_HOURS: '24',
  }
  test('the claimed window, on a deployment where names can be claimed', () => {
    expect(
      configuredClaimedExpiryMs({
        ...CLAIMABLE,
        WALGIT_CLAIMED_RETENTION_HOURS: '168',
      } as NodeJS.ProcessEnv),
    ).toBe(WEEK)
  })
  test('off without a base window', () => {
    expect(
      configuredClaimedExpiryMs({
        ...CLAIMABLE,
        WALGIT_RETENTION_HOURS: '',
        WALGIT_CLAIMED_RETENTION_HOURS: '168',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })
})

async function seed(
  store: MemoryStore,
  repoId: string,
  ts: string,
  claimed = false,
): Promise<void> {
  const base = indexWith([entry(ts)], repoId)
  const index = claimed ? { ...base, claim: CLAIM } : base
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

  test('a claimed repository outlives an unclaimed one idle as long', async () => {
    const store = new MemoryStore()
    await seed(store, 'kept', '2026-08-26T12:00:00.000Z', true)
    await seed(store, 'gone', '2026-08-26T12:00:00.000Z')

    const result = await expireRepos(store, {
      now: () => NOW,
      windowMs: WINDOW,
      claimedWindowMs: WEEK,
      dryRun: false,
    })
    expect(result.collected.map((c) => c.repoId)).toEqual(['gone'])
    expect(result.retained.map((r) => r.repoId)).toEqual(['kept'])
    expect(result.claimedWindowMs).toBe(WEEK)
  })

  // The two daily sweeps end to end: tombstone at the first, collect at the
  // second a grace period later — the same day, not the next one.
  test('the collect-only sweep finishes the first one and starts nothing', async () => {
    const store = new MemoryStore()
    await seed(store, 'stale', '2026-08-01T00:00:00.000Z')

    const first = await expireRepos(store, {
      now: () => NOW,
      windowMs: WINDOW,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(first.collected[0]!.deletion?.status).toBe('tombstoned')

    // A repository that went idle between the two sweeps.
    await seed(store, 'late', '2026-08-28T12:30:00.000Z')

    const second = await expireRepos(store, {
      now: () => new Date(NOW.getTime() + 75 * 60_000),
      windowMs: WINDOW,
      collectOnly: true,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(second.collectOnly).toBe(true)
    expect(second.collected.map((c) => c.repoId)).toEqual(['stale'])
    expect(second.collected[0]!.deletion?.status).toBe('collected')
    expect(await store.get('repos/stale/index.json')).toBeNull()
    // Past its window, but left untouched: no tombstone written.
    expect(second.retained.map((r) => r.repoId)).toEqual(['late'])
    const late = await store.get('repos/late/index.json')
    expect(JSON.parse(new TextDecoder().decode(late!.body)).deletion).toBeUndefined()
  })

  // The bug this guards: a push between the two sweeps used to be
  // acknowledged and then collected with the rest of the repository.
  test('a push after the mark lifts it, and the next sweep keeps the push', async () => {
    const store = new MemoryStore()
    await seed(store, 'revived', '2026-08-01T00:00:00.000Z')

    const first = await expireRepos(store, {
      now: () => NOW,
      windowMs: WINDOW,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(first.collected[0]!.deletion?.status).toBe('tombstoned')
    expect((await loadIndex(store, 'revived')).index.deletion?.by).toBe('expiry')

    const pushed = await publishPush(
      store,
      'revived',
      {
        entry: {
          key: 'repos/revived/wal/000000000002-y.pack',
          kind: 'push',
          size: 1,
          sha256: 'y',
          ts: '2026-08-29T12:30:00.000Z',
        },
      },
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40) }],
    )
    expect(pushed.ok).toBe(true)
    expect((await loadIndex(store, 'revived')).index.deletion).toBeUndefined()

    const second = await expireRepos(store, {
      now: () => new Date(NOW.getTime() + 75 * 60_000),
      windowMs: WINDOW,
      collectOnly: true,
      dryRun: false,
      graceMs: HOUR,
    })
    expect(second.collected).toEqual([])
    expect(second.retained[0]!.decision.reason).toContain('inside the')
    expect(await store.get('repos/revived/index.json')).not.toBeNull()
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
