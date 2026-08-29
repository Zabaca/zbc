/**
 * The request-level telemetry lives in `worker/`, because the Worker is the
 * only layer that sees every request — including the ones the container never
 * receives. Its classification is pure, though, so it is tested here with the
 * rest of the suite rather than behind a Workers runtime.
 */

import { describe, expect, test } from 'bun:test'

import {
  BLOB_COLUMNS,
  DOUBLE_COLUMNS,
  REJECT_HEADER,
  SERVED_HEADER,
  classifyOutcome,
  classifyRequest,
  toDataPoint,
  type RequestMetric,
} from '../worker/telemetry'
import * as http from './http'

describe('classifyRequest', () => {
  test('separates a clone from the advertisement that precedes it', () => {
    expect(classifyRequest('GET', '/alpha.git/info/refs', '?service=git-upload-pack')).toEqual({
      kind: 'clone-advertise',
      repo: 'alpha',
    })
    expect(classifyRequest('POST', '/alpha.git/git-upload-pack', '')).toEqual({
      kind: 'clone',
      repo: 'alpha',
    })
  })

  test('separates a push from a clone', () => {
    expect(classifyRequest('GET', '/alpha.git/info/refs', '?service=git-receive-pack')).toEqual({
      kind: 'push-advertise',
      repo: 'alpha',
    })
    expect(classifyRequest('POST', '/alpha.git/git-receive-pack', '')).toEqual({
      kind: 'push',
      repo: 'alpha',
    })
  })

  test('names the instructions page and the health check', () => {
    expect(classifyRequest('GET', '/', '').kind).toBe('instructions')
    expect(classifyRequest('GET', '/_walgit/health', '').kind).toBe('health')
  })

  test('dumb-HTTP and unknown paths are other, and name no repository', () => {
    expect(classifyRequest('GET', '/alpha.git/info/refs', '')).toEqual({
      kind: 'other',
      repo: 'alpha',
    })
    expect(classifyRequest('GET', '/alpha.git/objects/info/packs', '')).toEqual({
      kind: 'other',
      repo: '',
    })
  })
})

const headers = (entries: Record<string, string>) => new Headers(entries)

describe('classifyOutcome', () => {
  test('a served success is ok, with no refusal kind', () => {
    expect(classifyOutcome(200, headers({ [SERVED_HEADER]: '1' }))).toEqual({
      outcome: 'ok',
      reject: '',
    })
  })

  test('the kinds stay apart — a size cap is never a collision', () => {
    const sizeCap = classifyOutcome(413, headers({ [SERVED_HEADER]: '1', [REJECT_HEADER]: 'size-cap' }))
    const collision = classifyOutcome(409, headers({ [SERVED_HEADER]: '1', [REJECT_HEADER]: 'collision' }))
    expect(sizeCap.reject).toBe('size-cap')
    expect(collision.reject).toBe('collision')
    expect(sizeCap.reject).not.toBe(collision.reject)
  })

  test('a refusal walgit did not make is edge — the bug signal', () => {
    expect(classifyOutcome(413, headers({}))).toEqual({ outcome: 'reject', reject: 'edge' })
    expect(classifyOutcome(500, headers({}))).toEqual({ outcome: 'reject', reject: 'edge' })
  })

  test('a served refusal with no declared kind falls back to its status', () => {
    expect(classifyOutcome(401, headers({ [SERVED_HEADER]: '1' })).reject).toBe('unauthorized')
    expect(classifyOutcome(404, headers({ [SERVED_HEADER]: '1' })).reject).toBe('not-found')
    expect(classifyOutcome(503, headers({ [SERVED_HEADER]: '1' })).reject).toBe('unavailable')
    expect(classifyOutcome(418, headers({ [SERVED_HEADER]: '1' })).reject).toBe('other')
  })

  test('an unrecognised kind becomes other rather than a new column', () => {
    expect(classifyOutcome(400, headers({ [REJECT_HEADER]: 'wat' })).reject).toBe('other')
  })
})

test('the container and the Worker agree on the header contract', () => {
  expect(http.SERVED_HEADER).toBe(SERVED_HEADER)
  expect(http.REJECT_HEADER).toBe(REJECT_HEADER)
})

describe('toDataPoint', () => {
  const metric: RequestMetric = {
    kind: 'clone',
    repo: 'alpha',
    outcome: 'ok',
    reject: '',
    status: 200,
    served: true,
    cold: true,
    ttfbMs: 1800,
    totalMs: 4200,
    bytesServed: 12_345,
    bytesReceived: 0,
  }

  test('columns line up with their declared names', () => {
    const point = toDataPoint(metric)
    expect(point.blobs).toHaveLength(BLOB_COLUMNS.length)
    expect(point.doubles).toHaveLength(DOUBLE_COLUMNS.length)
    const blob = Object.fromEntries(BLOB_COLUMNS.map((name, i) => [name, point.blobs[i]]))
    const double = Object.fromEntries(DOUBLE_COLUMNS.map((name, i) => [name, point.doubles[i]]))
    expect(blob).toMatchObject({ kind: 'clone', outcome: 'ok', repo: 'alpha', temperature: 'cold' })
    expect(double).toMatchObject({ bytes_served: 12_345, total_ms: 4200, cold: 1 })
  })

  test('indexed by request kind, so refusals are sampled apart from clones', () => {
    expect(toDataPoint(metric).indexes).toEqual(['clone'])
    expect(toDataPoint({ ...metric, kind: 'push', outcome: 'reject', reject: 'size-cap' }).indexes).toEqual(['push'])
  })

  test('records nothing that identifies a caller or carries repository content', () => {
    const serialized = JSON.stringify(toDataPoint(metric))
    for (const forbidden of ['authorization', 'bearer', 'user-agent', 'cf-connecting-ip', '@']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden)
    }
  })
})
