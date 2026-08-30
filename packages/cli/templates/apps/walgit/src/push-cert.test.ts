import { describe, expect, test } from 'bun:test'

import { pushCertSeed, signedPushEnabled } from './push-cert'

describe('pushCertSeed', () => {
  test('is the configured seed when one is set', () => {
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: 'a-long-random-seed' })).toBe('a-long-random-seed')
    expect(signedPushEnabled({ WALGIT_PUSH_CERT_SEED: 'a-long-random-seed' })).toBe(true)
  })

  test('is off unset, and off blank', () => {
    // Blank has to read as unset rather than as a seed of "": git would take an
    // empty seed and advertise the capability on it, so a deployment that
    // cleared the variable would still take signed pushes.
    expect(pushCertSeed({})).toBeNull()
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '' })).toBeNull()
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '   ' })).toBeNull()
    expect(signedPushEnabled({})).toBe(false)
  })

  test('does not treat the seed as a boolean flag', () => {
    // Every other capability here is turned on by `1`/`true`. This one is not a
    // flag: the string IS the secret git derives its nonce from, so `1` is a
    // (terrible) seed and not the word "on".
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '1' })).toBe('1')
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: 'false' })).toBe('false')
  })
})
