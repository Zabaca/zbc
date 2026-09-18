/**
 * The request-level telemetry is counted by the Worker, because it is the only
 * layer that sees every request — including the ones the container never
 * receives. Its classification is pure and its vocabulary is shared with the
 * container that names most of the refusals, so it lives in `shared/` and is
 * tested here with the rest of the suite rather than behind a Workers runtime.
 */

import { describe, expect, test } from 'bun:test'

import { REJECT_HEADER, SERVED_HEADER } from '../shared/protocol'
import {
  BLOB_COLUMNS,
  DOUBLE_COLUMNS,
  classifyOutcome,
  classifyRequest,
  otherBucket,
  toDataPoint,
  type RequestMetric,
} from '../shared/telemetry'

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

  test('a provenance read is its own kind, and names the repository it asked about', () => {
    // Not `other`: that is the unroutable bucket, and folding a request walgit
    // answers into it would hide both the demand for the feature and any
    // refusal it produces.
    expect(classifyRequest('GET', '/_walgit/provenance', '?repo=alpha')).toEqual({
      kind: 'provenance',
      repo: 'alpha',
    })
  })

  test('a provenance read records no repository it would not serve', () => {
    // The query string is attacker-controlled and unbounded, unlike a path
    // segment the smart-HTTP grammar already constrained.
    expect(classifyRequest('GET', '/_walgit/provenance', '?repo=../etc').repo).toBe('')
    expect(classifyRequest('GET', '/_walgit/provenance', '').repo).toBe('')
  })

  test('dumb-HTTP and unknown paths are other, and name no repository', () => {
    expect(classifyRequest('GET', '/alpha.git/info/refs', '')).toEqual({
      kind: 'other',
      repo: 'alpha',
      bucket: 'else',
    })
    expect(classifyRequest('GET', '/alpha.git/objects/info/packs', '')).toEqual({
      kind: 'other',
      repo: '',
      bucket: 'else',
    })
  })

  test('an other carries the shape of the path, and only other does', () => {
    // The dataset records no path, so a spike in `other` used to be
    // unattributable — this is the column that names it.
    expect(classifyRequest('GET', '/.env', '').bucket).toBe('dotfile')
    expect(classifyRequest('GET', '/wp-login.php', '').bucket).toBe('php')
    // A kind walgit routes has nothing to explain.
    expect(classifyRequest('GET', '/', '').bucket).toBeUndefined()
    expect(classifyRequest('GET', '/_walgit/health', '').bucket).toBeUndefined()
    expect(classifyRequest('POST', '/alpha.git/git-upload-pack', '').bucket).toBeUndefined()
  })
})

describe('otherBucket', () => {
  test('sorts a path into one of the seven', () => {
    expect(otherBucket('/favicon.ico')).toBe('favicon')
    expect(otherBucket('/apple-touch-icon.png')).toBe('apple-touch')
    expect(otherBucket('/apple-touch-icon-precomposed.png')).toBe('apple-touch')
    expect(otherBucket('/.well-known/security.txt')).toBe('well-known')
    expect(otherBucket('/.env')).toBe('dotfile')
    expect(otherBucket('/.git/config')).toBe('dotfile')
    expect(otherBucket('/wp-login.php')).toBe('php')
    // A `/<name>` with no `.git` — somebody typing a repository's name into a
    // browser, which is a different question from a scanner.
    expect(otherBucket('/alpha')).toBe('bare-name')
    expect(otherBucket('/some/deep/path.html')).toBe('else')
  })

  test('never returns anything the caller supplied', () => {
    const buckets = new Set([
      'favicon',
      'apple-touch',
      'well-known',
      'dotfile',
      'php',
      'bare-name',
      'else',
    ])
    const hostile = [
      '/secret-repo-name',
      '/?token=sk-live-abcdef',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      `/${'a'.repeat(4096)}`,
      '/\u0000',
      '',
    ]
    for (const path of hostile) {
      const bucket = otherBucket(path)
      expect(buckets.has(bucket)).toBe(true)
      // Bounded and never user-controlled: the path itself never reaches the
      // dataset, whatever shape it arrived in.
      expect(path.includes(bucket)).toBe(false)
    }
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
    const sizeCap = classifyOutcome(
      413,
      headers({ [SERVED_HEADER]: '1', [REJECT_HEADER]: 'size-cap' }),
    )
    const collision = classifyOutcome(
      409,
      headers({ [SERVED_HEADER]: '1', [REJECT_HEADER]: 'collision' }),
    )
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
    expect(
      toDataPoint({ ...metric, kind: 'push', outcome: 'reject', reject: 'size-cap' }).indexes,
    ).toEqual(['push'])
  })

  test('the bucket column is a bucket name on an other, and empty everywhere else', () => {
    const blobs = (m: RequestMetric) =>
      Object.fromEntries(BLOB_COLUMNS.map((name, i) => [name, toDataPoint(m).blobs[i]]))
    expect(blobs(metric).bucket).toBe('')
    expect(blobs({ ...metric, kind: 'other', repo: '', bucket: 'dotfile' }).bucket).toBe('dotfile')
    // A kind that carried none still writes the column, so a GROUP BY over it
    // is honest and every existing query is unaffected.
    expect(blobs({ ...metric, kind: 'other', repo: '' }).bucket).toBe('else')
    expect(blobs({ ...metric, kind: 'favicon', repo: '' }).bucket).toBe('')
  })

  test('records nothing that identifies a caller or carries repository content', () => {
    const serialized = JSON.stringify(toDataPoint(metric))
    for (const forbidden of ['authorization', 'bearer', 'user-agent', 'cf-connecting-ip', '@']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden)
    }
  })
})
