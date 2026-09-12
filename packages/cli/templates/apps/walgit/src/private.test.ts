/**
 * The Private flag: a seed, and the one pairing the container refuses to boot
 * without (docs/adr/0013).
 *
 * Tested at the same seam as every other policy read in this package — a pure
 * function over a literal environment — because the container reads
 * `process.env` once at boot and a test that set one would be asserting about
 * this process rather than about the deployment.
 */

import { describe, expect, test } from 'bun:test'

import {
  acceptedNonces,
  privateReposConfigError,
  privateReposEnabled,
  privateReposSeed,
  readAllowed,
  readChallengeNonce,
} from './private'

const GATE = { WALGIT_SIGNER_LISTS: '1' }

describe('the seed', () => {
  test('is the capability: unset and blank are both off', () => {
    expect(privateReposSeed({})).toBe(null)
    expect(privateReposSeed({ WALGIT_PRIVATE_REPOS: '' })).toBe(null)
    expect(privateReposSeed({ WALGIT_PRIVATE_REPOS: '   ' })).toBe(null)
  })

  test('is the value, trimmed — the nonce is derived from it', () => {
    expect(privateReposSeed({ WALGIT_PRIVATE_REPOS: '  read-seed  ' })).toBe('read-seed')
  })

  /**
   * Read gating is ownership spent, so it cannot stand on its own: without the
   * Signer List flag there is no list to read a Reader List beside, and a
   * deployment in that state is misconfigured rather than half-on.
   */
  test('is on only with the gate beside it', () => {
    expect(privateReposEnabled({ ...GATE, WALGIT_PRIVATE_REPOS: 'read-seed' })).toBe(true)
    expect(privateReposEnabled({ WALGIT_PRIVATE_REPOS: 'read-seed' })).toBe(false)
    expect(privateReposEnabled(GATE)).toBe(false)
    expect(privateReposEnabled({})).toBe(false)
  })
})

describe('the boot refusal', () => {
  test('names the missing variable, so the operator can act on it', () => {
    const error = privateReposConfigError({ WALGIT_PRIVATE_REPOS: 'read-seed' })
    expect(error).toContain('WALGIT_PRIVATE_REPOS')
    expect(error).toContain('WALGIT_SIGNER_LISTS')
  })

  test('is silent for every configuration that is not that one', () => {
    expect(privateReposConfigError({})).toBe(null)
    expect(privateReposConfigError(GATE)).toBe(null)
    expect(privateReposConfigError({ ...GATE, WALGIT_PRIVATE_REPOS: 'read-seed' })).toBe(null)
    // Blank is unset, here as everywhere: a variable cleared to nothing is a
    // capability turned off, not one asking for a gate it has not got.
    expect(privateReposConfigError({ WALGIT_PRIVATE_REPOS: '' })).toBe(null)
  })
})

/**
 * The Read Challenge's nonce (docs/adr/0013).
 *
 * The expected values are not recomputed the way the code computes them: they
 * come from `openssl dgst -sha256 -hmac read-seed` over the window number,
 * which is the independent statement of "HMAC of the seed and the window".
 */
describe('the nonce', () => {
  const SEED = 'read-seed'
  // 2026-09-04T14:13:20Z. floor(1757000000 / 300) = 5856666.
  const NOW = 1_757_000_000_000
  const CURRENT = '2b32635014b8ae8cb63ec2637f5462cde610829a59d414e756a97b40105ee082'
  const PREVIOUS = '401f56ee69bb4bcf0189dd116f6dbea5cbc6eb8913de3e0362612a676f544c76'

  test('is the HMAC of the seed and the five-minute window', () => {
    expect(readChallengeNonce(SEED, NOW)).toBe(CURRENT)
  })

  test('is stable across the window and moves at its boundary', () => {
    // 5856666 * 300 s is the instant the window opens; one second before it is
    // the previous one.
    const opened = 5_856_666 * 300_000
    expect(readChallengeNonce(SEED, opened)).toBe(CURRENT)
    expect(readChallengeNonce(SEED, opened + 299_999)).toBe(CURRENT)
    expect(readChallengeNonce(SEED, opened - 1)).toBe(PREVIOUS)
  })

  test('accepts this window and the one before it, and no older one', () => {
    expect(acceptedNonces(SEED, NOW)).toEqual([CURRENT, PREVIOUS])
  })

  test('is a different value for a different seed', () => {
    expect(readChallengeNonce('other-seed', NOW)).not.toBe(CURRENT)
  })
})

/**
 * The read verdict: one pure function, the same one for all three reads.
 */
describe('the read gate', () => {
  const READER = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const SIGNER = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const STRANGER = 'SHA256:ccccccccccccccccccccccccccccccccccccccccccc'
  const PRIVATE = { signers: [SIGNER], readers: [READER], ts: '2026-09-12T00:00:00.000Z' }

  test('lets a listed reader and a Signer in, and refuses a stranger', () => {
    expect(readAllowed({ enabled: true, claim: PRIVATE, presented: READER })).toBe(true)
    expect(readAllowed({ enabled: true, claim: PRIVATE, presented: SIGNER })).toBe(true)
    expect(readAllowed({ enabled: true, claim: PRIVATE, presented: STRANGER })).toBe(false)
    expect(readAllowed({ enabled: true, claim: PRIVATE, presented: null })).toBe(false)
  })

  test('an empty Reader List is Private, and the Signer List reads it', () => {
    const onlyMine = { ...PRIVATE, readers: [] }
    expect(readAllowed({ enabled: true, claim: onlyMine, presented: SIGNER })).toBe(true)
    expect(readAllowed({ enabled: true, claim: onlyMine, presented: READER })).toBe(false)
  })

  test('a repository with no Reader List is world-readable, claimed or not', () => {
    const claimed = { signers: [SIGNER], ts: '2026-09-12T00:00:00.000Z' }
    expect(readAllowed({ enabled: true, claim: claimed, presented: null })).toBe(true)
    expect(readAllowed({ enabled: true, claim: undefined, presented: null })).toBe(true)
  })

  test('gates nothing at all when the deployment has no seed', () => {
    expect(readAllowed({ enabled: false, claim: PRIVATE, presented: null })).toBe(true)
  })
})
