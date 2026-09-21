/**
 * The environment. Every assertion is about which spelling wins, since a
 * variable read one way here and another way there is two deployments' worth
 * of confusion.
 */

import { describe, expect, test } from 'bun:test'

import { envHost, envToken } from './env'

describe('envHost', () => {
  test('AGENTGIT_HOST wins over WALGIT_HOST', () => {
    expect(envHost({ AGENTGIT_HOST: 'a.example', WALGIT_HOST: 'w.example' })).toBe('a.example')
  })

  test('WALGIT_HOST is the fallback', () => {
    expect(envHost({ WALGIT_HOST: 'w.example' })).toBe('w.example')
  })

  test('neither set is null', () => {
    expect(envHost({})).toBe(null)
  })

  test('an exported-but-empty variable is unset, not an empty host', () => {
    expect(envHost({ AGENTGIT_HOST: '', WALGIT_HOST: 'w.example' })).toBe('w.example')
    expect(envHost({ AGENTGIT_HOST: '', WALGIT_HOST: '' })).toBe(null)
  })
})

describe('envToken', () => {
  test('AGENTGIT_TOKEN wins over WALGIT_TOKEN', () => {
    expect(envToken({ AGENTGIT_TOKEN: 'a', WALGIT_TOKEN: 'w' })).toBe('a')
  })

  test('WALGIT_TOKEN is the fallback', () => {
    expect(envToken({ WALGIT_TOKEN: 'w' })).toBe('w')
  })

  test('neither set is null', () => {
    expect(envToken({})).toBe(null)
  })

  // The defect this closes: `AGENTGIT_TOKEN=` used to mean "present no header",
  // and surfaced a request later as a 401 nobody could explain.
  test('an exported-but-empty variable is unset, not a blank credential', () => {
    expect(envToken({ AGENTGIT_TOKEN: '', WALGIT_TOKEN: 'w' })).toBe('w')
    expect(envToken({ AGENTGIT_TOKEN: '', WALGIT_TOKEN: '' })).toBe(null)
  })
})
