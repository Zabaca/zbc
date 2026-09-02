/**
 * The size arithmetic and the words it produces.
 *
 * This is tested directly because the failure is asymmetric and silent. A cap
 * that is one comparison too loose accepts a push that then dies at the edge —
 * the exact forty-second failure this file exists to remove — and a cap that is
 * one too tight refuses a push that was fine, with a message that sounds
 * authoritative. Neither shows up as an exception anywhere.
 */
import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom } from '../shared/capabilities'
import { checkSize, limitsEnforced, limitsOf, liveBytes, NO_LIMITS, type Limits } from './limits'
import type { WalEntry, WalIndex } from './wal-index'

const MIB = 1024 ** 2

function index(entries: Array<Pick<WalEntry, 'seq' | 'size'>>, frontier = 0): WalIndex {
  return {
    version: 1,
    repo_id: 'alpha',
    seq: entries.length ? Math.max(...entries.map((e) => e.seq)) : 0,
    entries: entries.map((e) => ({
      seq: e.seq,
      key: `repos/alpha/wal/${e.seq}.pack`,
      kind: 'push',
      size: e.size,
      sha256: 'x',
      ts: '2026-08-28T00:00:00.000Z',
    })),
    refs: {},
    compaction_frontier: frontier,
    tombstones: [],
  }
}

/**
 * The caps are a projection of `Capabilities` (`shared/capabilities.ts`) rather
 * than a second reading of the environment, so what is checked here is that the
 * projection carries the derivation's answers through unchanged — the parsing
 * itself is `capabilities.test.ts`'s.
 */
describe('reading the caps', () => {
  test('unset means unlimited, and unlimited means nothing is checked', () => {
    expect(limitsOf(capabilitiesFrom({}))).toEqual(NO_LIMITS)
    expect(limitsEnforced(NO_LIMITS)).toBe(false)
    // The template default. A deployment opts in; an existing one is unchanged.
    expect(
      checkSize({ repoId: 'alpha', pushBytes: 1e12, repoBytes: 1e12, limits: NO_LIMITS }),
    ).toEqual({
      ok: true,
    })
  })

  test('a garbage or non-positive value reads as unset, never as zero', () => {
    // Zero would refuse every push on the instance. A typo must not do that.
    for (const raw of ['', '  ', 'unlimited', '0', '-1', 'NaN']) {
      expect(limitsOf(capabilitiesFrom({ WALGIT_MAX_PUSH_BYTES: raw })).maxPushBytes).toBeNull()
    }
    expect(limitsOf(capabilitiesFrom({ WALGIT_MAX_PUSH_BYTES: '104857600' })).maxPushBytes).toBe(
      104857600,
    )
    expect(limitsOf(capabilitiesFrom({ WALGIT_MAX_REPO_BYTES: '250000000' })).maxRepoBytes).toBe(
      250000000,
    )
  })
})

describe('what a repository costs', () => {
  test('is the live entries only — compaction shrinks it, it does not double it', () => {
    expect(
      liveBytes(
        index([
          { seq: 1, size: 10 },
          { seq: 2, size: 32 },
        ]),
      ),
    ).toBe(42)
    // Entries at or below the frontier are superseded: gc deletes them, so
    // counting them would charge the repository twice for the same history.
    expect(
      liveBytes(
        index(
          [
            { seq: 1, size: 10 },
            { seq: 2, size: 32 },
          ],
          1,
        ),
      ),
    ).toBe(32)
    expect(liveBytes(index([]))).toBe(0)
  })
})

describe('the per-push cap', () => {
  const limits: Limits = { maxPushBytes: 10 * MIB, maxRepoBytes: null }

  test('the boundary is exclusive: exactly the cap passes, one byte more does not', () => {
    const at = checkSize({ repoId: 'alpha', pushBytes: 10 * MIB, repoBytes: 0, limits })
    expect(at.ok).toBe(true)
    const over = checkSize({ repoId: 'alpha', pushBytes: 10 * MIB + 1, repoBytes: 0, limits })
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.kind).toBe('push')
  })

  test('the message names the limit and the actual size, and does not read like a network fault', () => {
    const verdict = checkSize({ repoId: 'alpha', pushBytes: 25 * MIB, repoBytes: 0, limits })
    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.message).toContain('10 MiB (10485760 bytes)')
    expect(verdict.message).toContain('25 MiB (26214400 bytes)')
    expect(verdict.message).toContain('not a network failure')
    expect(verdict.message).toContain('Nothing was uploaded')
  })
})

describe('the per-repository cap', () => {
  const limits: Limits = { maxPushBytes: null, maxRepoBytes: 100 * MIB }

  test('judges what the repository WOULD hold, not what it holds now', () => {
    // The push alone is small and the repository alone is under; together they
    // are not. Checking either in isolation is the bug this pins.
    const verdict = checkSize({ repoId: 'alpha', pushBytes: MIB, repoBytes: 100 * MIB, limits })
    expect(verdict.ok).toBe(false)
    expect(checkSize({ repoId: 'alpha', pushBytes: MIB, repoBytes: 99 * MIB, limits }).ok).toBe(
      true,
    )
  })

  test('says the repository is full — a different thing from the push being too big', () => {
    const verdict = checkSize({ repoId: 'alpha', pushBytes: 2 * MIB, repoBytes: 99 * MIB, limits })
    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.kind).toBe('repo')
    expect(verdict.message).toContain('alpha would exceed its 100 MiB')
    expect(verdict.message).toContain('it is the repository that is full')
    // An agent told its push was too big would go split the push, which here
    // would not help. The two messages must not be confusable.
    expect(verdict.message).not.toContain('this push is larger than')
  })
})

describe('when both caps are exceeded at once', () => {
  test('the per-push message wins, because splitting is the actionable advice', () => {
    const limits: Limits = { maxPushBytes: MIB, maxRepoBytes: MIB }
    const verdict = checkSize({ repoId: 'alpha', pushBytes: 8 * MIB, repoBytes: 8 * MIB, limits })
    expect(verdict.ok === false && verdict.kind).toBe('push')
  })
})
