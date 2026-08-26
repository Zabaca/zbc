import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { MemoryStore } from './store'
import {
  PENDING_MAX_AGE_MS,
  parseRefChanges,
  preReceive,
  publishPush,
  readPending,
  sweepPending,
  writePending,
  type PendingPush,
} from './push'
import { ZERO_OID, loadIndex, type RefChange } from './wal-index'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

const pending = (key = 'repos/r/wal/000000000001-X.pack'): PendingPush => ({
  entry: { key, kind: 'push', size: 12, sha256: 'f'.repeat(64), ts: '2026-08-21T00:00:00Z' },
})

const change = (ref: string, oldOid: string, newOid: string): RefChange => ({ ref, oldOid, newOid })

const jitter = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)))

describe('parseRefChanges', () => {
  test('reads the three-field form git writes', () => {
    expect(parseRefChanges(`${ZERO_OID} ${OID_A} refs/heads/main\n`)).toEqual([
      change('refs/heads/main', ZERO_OID, OID_A),
    ])
  })

  test('a refname containing spaces survives', () => {
    expect(parseRefChanges(`${OID_A} ${OID_B} refs/heads/a b`)[0]!.ref).toBe('refs/heads/a b')
  })

  test('a malformed line is fatal rather than skipped', () => {
    expect(() => parseRefChanges('nonsense\n')).toThrow(/unparseable/)
  })
})

describe('publishPush', () => {
  test('publishes the entry and the ref state together', async () => {
    const store = new MemoryStore()
    const result = await publishPush(store, 'r', pending(), [
      change('refs/heads/main', ZERO_OID, OID_A),
    ])

    expect(result.ok).toBe(true)
    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(1)
    expect(index.entries).toHaveLength(1)
    expect(index.refs['refs/heads/main']).toBe(OID_A)
  })

  test('rejects when the index moved the ref under this push', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', pending(), [change('refs/heads/main', ZERO_OID, OID_A)])

    // A second push that believes main is still absent: exactly what a client
    // racing on a stale advertisement sends.
    const result = await publishPush(store, 'r', pending('repos/r/wal/000000000002-Y.pack'), [
      change('refs/heads/main', ZERO_OID, OID_B),
    ])

    expect(result).toMatchObject({ ok: false, reason: 'ref-conflict', actual: OID_A })
    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(1)
    expect(index.refs['refs/heads/main']).toBe(OID_A)
  })

  test('two concurrent pushes to one ref: exactly one wins, seq stays contiguous', async () => {
    const store = new MemoryStore(jitter)
    await publishPush(store, 'r', pending(), [change('refs/heads/main', ZERO_OID, OID_A)])

    const [first, second] = await Promise.all([
      publishPush(store, 'r', pending('repos/r/wal/000000000002-Y.pack'), [
        change('refs/heads/main', OID_A, OID_B),
      ]),
      publishPush(store, 'r', pending('repos/r/wal/000000000002-Z.pack'), [
        change('refs/heads/main', OID_A, OID_C),
      ]),
    ])

    expect([first!.ok, second!.ok].filter(Boolean)).toHaveLength(1)
    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(2)
    expect(index.entries.map((e) => e.seq)).toEqual([1, 2])
    expect([OID_B, OID_C]).toContain(index.refs['refs/heads/main'])
  })

  test('concurrent pushes to different refs both land', async () => {
    const store = new MemoryStore(jitter)
    const [first, second] = await Promise.all([
      publishPush(store, 'r', pending('repos/r/wal/000000000001-Y.pack'), [
        change('refs/heads/one', ZERO_OID, OID_A),
      ]),
      publishPush(store, 'r', pending('repos/r/wal/000000000001-Z.pack'), [
        change('refs/heads/two', ZERO_OID, OID_B),
      ]),
    ])

    expect(first!.ok && second!.ok).toBe(true)
    const { index } = await loadIndex(store, 'r')
    expect(index.seq).toBe(2)
    expect(index.refs).toEqual({ 'refs/heads/one': OID_A, 'refs/heads/two': OID_B })
  })

  test('a ref-only push publishes the ref without inventing a log entry', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', pending(), [change('refs/heads/main', ZERO_OID, OID_A)])

    const result = await publishPush(store, 'r', { entry: null }, [
      change('refs/heads/main', OID_A, ZERO_OID),
    ])

    expect(result.ok).toBe(true)
    const { index } = await loadIndex(store, 'r')
    expect(index.refs['refs/heads/main']).toBeUndefined()
    expect(index.seq).toBe(1)
    expect(index.entries).toHaveLength(1)
  })

  test('a multi-ref push is one entry with several ref changes', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', pending(), [
      change('refs/heads/main', ZERO_OID, OID_A),
      change('refs/heads/topic', ZERO_OID, OID_B),
    ])

    const { index } = await loadIndex(store, 'r')
    expect(index.entries).toHaveLength(1)
    expect(index.refs).toEqual({ 'refs/heads/main': OID_A, 'refs/heads/topic': OID_B })
  })
})

describe('preReceive', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-prerecv-'))

  test('uploads the pack and the idx, never the keep, and records them pending', async () => {
    const dir = scratch()
    const quarantine = path.join(dir, 'tmp_objdir-incoming-abc')
    fs.mkdirSync(path.join(quarantine, 'pack'), { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.pack'), 'PACKDATA')
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.idx'), 'IDXDATA')
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.keep'), '')

    const store = new MemoryStore()
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: quarantine })

    const keys = await store.list('repos/r/wal/')
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => k.endsWith('.pack'))).toBe(true)
    expect(keys.some((k) => k.endsWith('.idx'))).toBe(true)
    expect(keys.some((k) => k.endsWith('.keep'))).toBe(false)

    // Uploading is not publishing.
    expect(await store.get('repos/r/index.json')).toBeNull()

    const recorded = readPending(dir)
    expect(recorded!.entry!.size).toBe(8)
    expect(recorded!.entry!.key).toContain('000000000001')
  })

  test('a push with no objects records a pending with no entry', async () => {
    const dir = scratch()
    const store = new MemoryStore()
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: undefined })

    expect(readPending(dir)!.entry).toBeNull()
    expect(await store.list('repos/r/wal/')).toEqual([])
  })
})

describe('the pending hand-off is private to one receive-pack', () => {
  const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-pending-'))

  /** A pid that is certainly gone: one we waited on. */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn(['true'])
    const pid = child.pid
    await child.exited
    return pid
  }

  test('one invocation cannot read another invocation record', async () => {
    const dir = scratchDir()
    const other = 424242
    const store = new MemoryStore()
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: undefined })

    // The other push's record exists and is intact...
    writePending(dir, { entry: null }, other)
    expect(readPending(dir, other)).not.toBeNull()
    // ...and is nothing this invocation can see, in either direction.
    expect(readPending(dir)!.pid).toBe(process.ppid)
  })

  test('a record left by a dead receive-pack is swept and never read', async () => {
    const dir = scratchDir()
    const dead = await deadPid()
    writePending(dir, { entry: null }, dead)

    expect(sweepPending(dir)).toHaveLength(1)
    expect(readPending(dir, dead)).toBeNull()
  })

  test('a live push in flight is left alone by the sweep', () => {
    const dir = scratchDir()
    writePending(dir, { entry: null }, process.pid)

    expect(sweepPending(dir)).toEqual([])
    expect(readPending(dir, process.pid)).not.toBeNull()
  })

  test('a record older than the cutoff is swept even if its pid is alive again', () => {
    const dir = scratchDir()
    writePending(dir, { entry: null }, process.pid)

    // A container restart recycles pids; age is what catches the record whose
    // pid now belongs to someone else entirely.
    expect(sweepPending(dir, Date.now() + PENDING_MAX_AGE_MS + 1)).toHaveLength(1)
    expect(readPending(dir, process.pid)).toBeNull()
  })
})
