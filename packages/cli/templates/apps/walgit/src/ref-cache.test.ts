/**
 * The fan-out's copy of ref state (`shared/ref-cache.ts`).
 *
 * A Map with no I/O, so it is tested here with the rest of the suite rather
 * than behind a Workers runtime — the same arrangement as `events.test.ts`.
 * What is asserted is the part that decides whether the container gets woken:
 * what counts as a miss, what a fill records, and what an announcement is
 * allowed to change.
 */

import { describe, expect, test } from 'bun:test'
import { RefCache } from '../shared/ref-cache'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const MAIN = 'refs/heads/main'
const DEV = 'refs/heads/dev'

describe('misses', () => {
  test('an unknown repository is a miss, and is what the container is asked for', () => {
    const cache = new RefCache()
    expect(cache.missing(['alpha', 'beta'])).toEqual(['alpha', 'beta'])
    cache.fill('alpha', { [MAIN]: SHA_A })
    expect(cache.missing(['alpha', 'beta'])).toEqual(['beta'])
  })

  test('a known repository is served without the container', () => {
    // The whole point of the ticket: a connect for a repository this object has
    // already read must not wake a sleeping container.
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A, [DEV]: SHA_B })
    expect(cache.has('alpha')).toBe(true)
    expect(cache.missing(['alpha'])).toEqual([])
    expect(cache.read(['alpha'])).toEqual({ alpha: { [MAIN]: SHA_A, [DEV]: SHA_B } })
  })

  test('a repository with no refs is still known', () => {
    // An empty repository is an answer, not an absence — caching it as a miss
    // would wake the container on every connect for exactly the repositories
    // that have nothing to say.
    const cache = new RefCache()
    cache.fill('empty', {})
    expect(cache.missing(['empty'])).toEqual([])
    expect(cache.read(['empty'])).toEqual({ empty: {} })
  })

  test('read reports only what it knows, and invents nothing', () => {
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha', 'beta'])).toEqual({ alpha: { [MAIN]: SHA_A } })
  })
})

describe('announcements', () => {
  test('an announce updates the copy, so the next connect is served locally', () => {
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A })
    cache.apply([{ repo: 'alpha', ref: MAIN, sha: SHA_B }])
    expect(cache.read(['alpha'])).toEqual({ alpha: { [MAIN]: SHA_B } })
    expect(cache.missing(['alpha'])).toEqual([])
  })

  test('a new ref joins a repository already known', () => {
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A })
    cache.apply([{ repo: 'alpha', ref: DEV, sha: SHA_B }])
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_A, [DEV]: SHA_B })
  })

  test('a deletion removes the ref rather than remembering it', () => {
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A, [DEV]: SHA_B })
    cache.apply([{ repo: 'alpha', ref: DEV, sha: null }])
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_A })
  })

  test('an event for an unknown repository does not start an entry', () => {
    // One ref is not a repository's ref state. An entry built from events alone
    // would answer a whole-repository handshake with whatever happened to have
    // moved, and would look authoritative doing it — so it stays a miss.
    const cache = new RefCache()
    cache.apply([{ repo: 'beta', ref: MAIN, sha: SHA_A }])
    expect(cache.missing(['beta'])).toEqual(['beta'])
    expect(cache.read(['beta'])).toEqual({})
  })

  test("one repository's events never touch another", () => {
    const cache = new RefCache()
    cache.fill('alpha', { [MAIN]: SHA_A })
    cache.fill('beta', { [MAIN]: SHA_A })
    cache.apply([{ repo: 'alpha', ref: MAIN, sha: SHA_B }])
    expect(cache.read(['beta']).beta).toEqual({ [MAIN]: SHA_A })
  })
})

describe('the bound', () => {
  test('the oldest fill is evicted, and becomes a miss again', () => {
    // Losing an entry costs one container round-trip on the next connect, which
    // is the correct price for a cache and the reason there is a bound at all.
    const cache = new RefCache(2)
    cache.fill('a', { [MAIN]: SHA_A })
    cache.fill('b', { [MAIN]: SHA_A })
    cache.fill('c', { [MAIN]: SHA_A })
    expect(cache.size).toBe(2)
    expect(cache.missing(['a', 'b', 'c'])).toEqual(['a'])
  })

  test('a refill moves a repository to the back of the eviction queue', () => {
    const cache = new RefCache(2)
    cache.fill('a', { [MAIN]: SHA_A })
    cache.fill('b', { [MAIN]: SHA_A })
    cache.fill('a', { [MAIN]: SHA_B })
    cache.fill('c', { [MAIN]: SHA_A })
    expect(cache.missing(['a', 'b', 'c'])).toEqual(['b'])
  })

  test('a fill copies, so the caller cannot mutate the cache behind its back', () => {
    const cache = new RefCache()
    const refs = { [MAIN]: SHA_A }
    cache.fill('alpha', refs)
    refs[MAIN] = SHA_B
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_A })
  })
})

/**
 * The window a handshake opens.
 *
 * Reading a repository's ref state is a round-trip to the container, and a push
 * can land inside it — announced from a state newer than the snapshot already
 * in flight. Before this bracket existed, that event was dropped (no entry yet)
 * and the older snapshot then installed over it, so the handshake answered a
 * push behind and the subscriber had no way to find out until the next push.
 */
describe('a read that a push overtakes', () => {
  test('an event announced during a fill survives it', () => {
    const cache = new RefCache()
    cache.beginFill('alpha')
    cache.apply([{ repo: 'alpha', ref: MAIN, sha: SHA_B }])
    // The snapshot the container was already computing when the push landed.
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_B })
  })

  test('a deletion announced during a fill survives it', () => {
    const cache = new RefCache()
    cache.beginFill('alpha')
    cache.apply([{ repo: 'alpha', ref: MAIN, sha: null }])
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha']).alpha).toEqual({})
  })

  test('an event for a repository nobody is reading is still dropped', () => {
    const cache = new RefCache()
    cache.beginFill('alpha')
    cache.apply([{ repo: 'beta', ref: MAIN, sha: SHA_B }])
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.missing(['beta'])).toEqual(['beta'])
  })

  test('two readers of one unknown repository both get the newer state', () => {
    const cache = new RefCache()
    cache.beginFill('alpha')
    cache.beginFill('alpha')
    cache.apply([{ repo: 'alpha', ref: MAIN, sha: SHA_B }])
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_B })
    // The second reader's own snapshot is just as stale, and must not undo it.
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_B })
  })

  test('a failed read leaves the repository unknown rather than empty', () => {
    const cache = new RefCache()
    cache.beginFill('alpha')
    cache.abortFill('alpha')
    expect(cache.missing(['alpha'])).toEqual(['alpha'])
    expect(cache.read(['alpha'])).toEqual({})
  })

  test('a fill with no bracket still works, and buffers nothing', () => {
    const cache = new RefCache()
    cache.endFill('alpha', { [MAIN]: SHA_A })
    expect(cache.read(['alpha']).alpha).toEqual({ [MAIN]: SHA_A })
  })
})
