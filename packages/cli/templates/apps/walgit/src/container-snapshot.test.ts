/**
 * When a snapshot is taken and when it is trusted (`shared/container-snapshot.ts`).
 *
 * The rule under all of these is that a wrong answer here may only ever cost a
 * cold start, so every refusal is a fresh start and none is an error — and the
 * one thing that must never happen is restoring a snapshot onto an image or a
 * log it was not taken from.
 */

import { describe, expect, test } from 'bun:test'

import {
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_TTL_MS,
  recordSnapshot,
  refreshSnapshot,
  restorePlan,
  shouldSnapshot,
  snapshotsEnabled,
  storeIdentity,
} from '../shared/container-snapshot'

const DAY = 24 * 60 * 60 * 1000
const IMAGE = 'registry.cloudflare.com/acct/walgit@sha256:' + 'a'.repeat(64)
const NEWER = 'registry.cloudflare.com/acct/walgit@sha256:' + 'b'.repeat(64)
const STORE = storeIdentity({ WALGIT_S3_ENDPOINT: 'https://r2.example', WALGIT_S3_BUCKET: 'wal' })

const record = recordSnapshot(
  { id: 'snap-1', size: 1_000_000 },
  { image: IMAGE, store: STORE, now: 0 },
)

function plan(overrides: Partial<Parameters<typeof restorePlan>[0]> = {}) {
  return restorePlan({ enabled: true, record, image: IMAGE, store: STORE, now: DAY, ...overrides })
}

describe('snapshotsEnabled', () => {
  test('off unless set, on for the two spellings every walgit flag takes', () => {
    expect(snapshotsEnabled({})).toBe(false)
    expect(snapshotsEnabled({ WALGIT_SNAPSHOTS: '' })).toBe(false)
    expect(snapshotsEnabled({ WALGIT_SNAPSHOTS: 'yes' })).toBe(false)
    expect(snapshotsEnabled({ WALGIT_SNAPSHOTS: '1' })).toBe(true)
    expect(snapshotsEnabled({ WALGIT_SNAPSHOTS: 'true' })).toBe(true)
  })
})

describe('restorePlan', () => {
  test('restores a snapshot of this image, this log, inside its lifetime', () => {
    expect(plan()).toEqual({ from: 'snapshot', id: 'snap-1' })
  })

  test('starts fresh when snapshots are off, even with one on record', () => {
    expect(plan({ enabled: false })).toEqual({ from: 'image', reason: 'disabled' })
  })

  test('starts fresh with none on record', () => {
    expect(plan({ record: null })).toEqual({ from: 'image', reason: 'none' })
  })

  test('never restores a snapshot from another image', () => {
    // A snapshot is not portable across image versions — and a deploy that
    // shipped a new image must start it, not the filesystem of the old one.
    expect(plan({ image: NEWER })).toEqual({ from: 'image', reason: 'other-image' })
  })

  test('never restores a Cache built against another log', () => {
    const elsewhere = storeIdentity({
      WALGIT_S3_ENDPOINT: 'https://r2.example',
      WALGIT_S3_BUCKET: 'other',
    })
    expect(plan({ store: elsewhere })).toEqual({ from: 'image', reason: 'other-store' })
  })

  test('treats a snapshot near the end of its 30 days as gone', () => {
    // A restore of an expired snapshot fails slowly — as a container that never
    // comes up — so the record is distrusted a day early.
    expect(plan({ now: SNAPSHOT_TTL_MS - 2 * DAY }).from).toBe('snapshot')
    expect(plan({ now: SNAPSHOT_TTL_MS - DAY })).toEqual({ from: 'image', reason: 'expired' })
  })

  test('a restore restarts the lifetime', () => {
    const restored = refreshSnapshot(record, 20 * DAY)
    expect(plan({ record: restored, now: 40 * DAY }).from).toBe('snapshot')
    expect(restored.takenAt).toBe(0)
  })

  test('starts fresh rather than restoring a disk that is mostly Cache', () => {
    const large = { ...record, size: SNAPSHOT_MAX_BYTES + 1 }
    expect(plan({ record: large })).toEqual({ from: 'image', reason: 'too-large' })
    expect(plan({ record: { ...record, size: SNAPSHOT_MAX_BYTES } }).from).toBe('snapshot')
  })
})

describe('shouldSnapshot', () => {
  test('snapshots a container booted from the image this deploy starts', () => {
    expect(shouldSnapshot({ enabled: true, bootedImage: IMAGE, image: IMAGE })).toBe(true)
  })

  test('not one booted from an older image — that snapshot could never be restored', () => {
    expect(shouldSnapshot({ enabled: true, bootedImage: IMAGE, image: NEWER })).toBe(false)
  })

  test('not one whose boot image is unknown', () => {
    expect(shouldSnapshot({ enabled: true, bootedImage: null, image: IMAGE })).toBe(false)
  })

  test('not when snapshots are off', () => {
    expect(shouldSnapshot({ enabled: false, bootedImage: IMAGE, image: IMAGE })).toBe(false)
  })
})

describe('storeIdentity', () => {
  test('names the log without carrying its credentials', () => {
    const identity = storeIdentity({
      WALGIT_S3_ENDPOINT: 'https://r2.example',
      WALGIT_S3_BUCKET: 'wal',
      // Not part of the identity, and must not be.
      WALGIT_S3_SECRET_ACCESS_KEY: 'secret',
    } as Record<string, string>)
    expect(identity).toBe(STORE)
    expect(identity).not.toContain('wal')
  })
})
