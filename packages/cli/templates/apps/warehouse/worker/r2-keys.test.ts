import { describe, expect, test } from 'bun:test'
import { martKey, martSidecarKey, rawKey } from './r2-keys'

describe('rawKey', () => {
  test('prefixes the given path with raw/', () => {
    expect(rawKey('github/issues/2026-07-26.jsonl')).toBe('raw/github/issues/2026-07-26.jsonl')
  })
})

describe('martKey', () => {
  test('builds a marts/<name>.parquet path', () => {
    expect(martKey('session_events')).toBe('marts/session_events.parquet')
  })
})

describe('martSidecarKey', () => {
  test('builds a marts/<name>.schema.json path', () => {
    expect(martSidecarKey('session_events')).toBe('marts/session_events.schema.json')
  })
})

describe('martKey vs martSidecarKey', () => {
  test('never collide for the same mart name', () => {
    const name = 'session_events'
    expect(martKey(name)).not.toBe(martSidecarKey(name))
  })
})
