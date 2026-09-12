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

import { privateReposConfigError, privateReposEnabled, privateReposSeed } from './private'

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
