import { describe, expect, test } from 'bun:test'
import { MemoryStore } from './store'
import {
  ZERO_OID,
  applyRefChanges,
  commitIndex,
  emptyIndex,
  indexKey,
  loadIndex,
  loadIndexIfChanged,
  nextIndex,
  updateIndex,
  walKey,
  type RefChange,
  type WalIndex,
} from './wal-index'

const entry = (n: number) => ({
  key: `wal/${n}.pack`,
  kind: 'push' as const,
  size: 100,
  sha256: 'x'.repeat(64),
  ts: '2026-08-20T00:00:00Z',
})

/** Random suspension, so concurrent commits actually interleave rather than
 *  each running to completion in submission order. */
const jitter = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)))

describe('keys', () => {
  test('index key is per repo', () => {
    expect(indexKey('ses_01J')).toBe('repos/ses_01J/index.json')
  })

  test('wal keys zero-pad so lexicographic order is numeric order', () => {
    const a = walKey('r', 9, 'ulid', 'pack')
    const b = walKey('r', 10, 'ulid', 'pack')
    expect(a).toContain('000000000009')
    expect([b, a].sort()).toEqual([a, b])
  })
})

describe('ref changes', () => {
  test('creates, updates, and deletes', () => {
    const changes: RefChange[] = [
      { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'aaa' },
      { ref: 'refs/tags/v1', oldOid: ZERO_OID, newOid: 'bbb' },
    ]
    const refs = applyRefChanges({}, changes)
    expect(refs).toEqual({ 'refs/heads/main': 'aaa', 'refs/tags/v1': 'bbb' })

    const updated = applyRefChanges(refs, [
      { ref: 'refs/heads/main', oldOid: 'aaa', newOid: 'ccc' },
    ])
    expect(updated['refs/heads/main']).toBe('ccc')

    const deleted = applyRefChanges(updated, [
      { ref: 'refs/tags/v1', oldOid: 'bbb', newOid: ZERO_OID },
    ])
    expect(deleted).not.toHaveProperty('refs/tags/v1')
  })

  test('does not mutate its input', () => {
    const refs = { 'refs/heads/main': 'aaa' }
    applyRefChanges(refs, [{ ref: 'refs/heads/main', oldOid: 'aaa', newOid: 'zzz' }])
    expect(refs['refs/heads/main']).toBe('aaa')
  })
})

describe('nextIndex', () => {
  test('bumps seq and stamps the entry with it', () => {
    const next = nextIndex(emptyIndex('r'), entry(1), [
      { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'aaa' },
    ])
    expect(next.seq).toBe(1)
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0]!.seq).toBe(1)
    expect(next.refs['refs/heads/main']).toBe('aaa')
  })
})

describe('load and commit', () => {
  test('a repo with no index reads as empty with a null etag', async () => {
    const store = new MemoryStore()
    const { index, etag } = await loadIndex(store, 'r')
    expect(etag).toBeNull()
    expect(index).toEqual(emptyIndex('r'))
  })

  test('first commit is if-absent, and a second if-absent loses', async () => {
    const store = new MemoryStore()
    const first = await commitIndex(store, nextIndex(emptyIndex('r'), entry(1), []), null)
    expect(first.ok).toBe(true)

    const second = await commitIndex(store, nextIndex(emptyIndex('r'), entry(1), []), null)
    expect(second).toEqual({ ok: false, reason: 'contended' })
  })

  test('a stale etag loses and leaves the stored value untouched', async () => {
    const store = new MemoryStore()
    const first = await commitIndex(store, nextIndex(emptyIndex('r'), entry(1), []), null)
    if (!first.ok) throw new Error('setup failed')

    const second = await commitIndex(store, nextIndex(first.index, entry(2), []), first.etag)
    if (!second.ok) throw new Error('setup failed')

    // Third writer still holds the FIRST etag.
    const stale = await commitIndex(store, nextIndex(first.index, entry(99), []), first.etag)
    expect(stale).toEqual({ ok: false, reason: 'contended' })

    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(2)
    expect(index.entries.map((e) => e.key)).toEqual(['wal/1.pack', 'wal/2.pack'])
  })

  test('rejects an index whose repo_id does not match its key', async () => {
    const store = new MemoryStore()
    const wrong: WalIndex = { ...emptyIndex('someone-else'), seq: 1 }
    await store.put(indexKey('r'), new TextEncoder().encode(JSON.stringify(wrong)))
    await expect(loadIndex(store, 'r')).rejects.toThrow(/declares repo_id "someone-else"/)
  })

  test('conditional read reports current without transferring the body', async () => {
    const store = new MemoryStore()
    const first = await commitIndex(store, nextIndex(emptyIndex('r'), entry(1), []), null)
    if (!first.ok) throw new Error('setup failed')

    expect(await loadIndexIfChanged(store, 'r', first.etag)).toBe('current')

    const second = await commitIndex(store, nextIndex(first.index, entry(2), []), first.etag)
    if (!second.ok) throw new Error('setup failed')

    const changed = await loadIndexIfChanged(store, 'r', first.etag)
    expect(changed).not.toBe('current')
    if (changed === 'current') throw new Error('unreachable')
    expect(changed.index.seq).toBe(2)
  })
})

// ── The Milestone 1 acceptance criterion ────────────────────────────────────

describe('100 concurrent index writers', () => {
  test('from one base, exactly one wins and the rest lose cleanly', async () => {
    const store = new MemoryStore(jitter)
    const seeded = await commitIndex(store, nextIndex(emptyIndex('r'), entry(0), []), null)
    if (!seeded.ok) throw new Error('setup failed')

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        commitIndex(store, nextIndex(seeded.index, entry(i + 1), []), seeded.etag),
      ),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === 'contended')).toHaveLength(99)
    // No third outcome: a race must not surface as an exception or a partial write.
    expect(results.every((r) => r.ok || r.reason === 'contended')).toBe(true)

    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(2)
    expect(index.entries).toHaveLength(2)
  })

  test('with retry, all 100 land — contiguous seq, no lost updates', async () => {
    const store = new MemoryStore(jitter)

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        updateIndex(store, 'r', (current) => nextIndex(current, entry(i), []), 500),
      ),
    )
    expect(results.every((r) => r.ok)).toBe(true)

    const { index } = await loadIndex(store, 'r')
    // Every writer's entry survived: the lost-update failure would show up here
    // as a short list, with seq nonetheless counted up to 100.
    expect(index.seq).toBe(100)
    expect(index.entries).toHaveLength(100)
    expect(index.entries.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    // Each writer contributed exactly once.
    expect(new Set(index.entries.map((e) => e.key)).size).toBe(100)
  })

  test('concurrent creation of the same repo produces one winner', async () => {
    const store = new MemoryStore(jitter)
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        commitIndex(store, nextIndex(emptyIndex('r'), entry(i), []), null),
      ),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })
})
