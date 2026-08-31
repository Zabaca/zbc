import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { MemoryStore } from './store'
import {
  PENDING_MAX_AGE_MS,
  readPending,
  sweepPending,
  writePending,
  type PendingPush,
} from './pending'
import { establishSigner, parseRefChanges, preReceive, publishPush } from './push'
import { ZERO_OID } from '../shared/protocol'
import { loadIndex, type RefChange } from './wal-index'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

const pending = (key = 'repos/r/wal/000000000001-X.pack'): PendingPush => ({
  entry: { key, kind: 'push', size: 12, sha256: 'f'.repeat(64), ts: '2026-08-21T00:00:00Z' },
})

const change = (ref: string, oldOid: string, newOid: string): RefChange => ({ ref, oldOid, newOid })

/** A pid that is certainly gone: one we waited on. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true'])
  const pid = child.pid
  await child.exited
  return pid
}

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
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: quarantine, signer: null })

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
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: undefined, signer: null })

    expect(readPending(dir)!.entry).toBeNull()
    expect(await store.list('repos/r/wal/')).toEqual([])
  })
})

describe('the pending hand-off is private to one receive-pack', () => {
  const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-pending-'))

  test('one invocation cannot read another invocation record', async () => {
    const dir = scratchDir()
    const other = 424242
    const store = new MemoryStore()
    await preReceive({ store, repoId: 'r', gitDir: dir, quarantineDir: undefined, signer: null })

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

/**
 * Provenance on the push path (docs/adr/0011).
 *
 * The Signer is established above the upload (`establishSigner`) and handed to
 * `preReceive`, so every case below runs with no keypair, no `ssh-keygen` and
 * no git — what a real signed push does end to end is `push.e2e.test.ts`'s.
 */
describe('provenance', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-signer-'))
  const KEY = `SHA256:${'A'.repeat(43)}`
  const OTHER = `SHA256:${'B'.repeat(43)}`

  const AT = '2026-08-30T12:00:00.000Z'
  const by = (signer: string) => ({ signer, ts: AT })

  /** `pre-receive` for a push carrying one pack, signed by `signer` or not. */
  const preReceiveSigned = async (store: MemoryStore, signer: string | null) => {
    const dir = scratch()
    const quarantine = path.join(dir, 'tmp_objdir-incoming-abc')
    fs.mkdirSync(path.join(quarantine, 'pack'), { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'pack', 'pack-1.pack'), 'PACKDATA')
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: quarantine,
      now: () => new Date(AT),
      signer,
    })
    return readPending(dir)!
  }

  test('a signed push records the key as the Signer of every ref it moved', async () => {
    const store = new MemoryStore()
    const recorded = await preReceiveSigned(store, KEY)
    expect(recorded.provenance).toEqual(by(KEY))

    const result = await publishPush(store, 'r', recorded, [
      change('refs/heads/main', ZERO_OID, OID_A),
      change('refs/heads/topic', ZERO_OID, OID_B),
    ])
    expect(result.ok).toBe(true)

    const { index } = await loadIndex(store, 'r')
    expect(index.provenance).toEqual({
      'refs/heads/main': by(KEY),
      'refs/heads/topic': by(KEY),
    })
    // The ref map keeps its shape: still ref → sha, so no existing reader of
    // the Index has anything to change.
    expect(index.refs).toEqual({ 'refs/heads/main': OID_A, 'refs/heads/topic': OID_B })
  })

  test('a ref-only push is recorded too', async () => {
    // The reason this is a field on the Index and not on a WAL entry: a push
    // that adds no objects appends no entry, so an entry-hung provenance would
    // be blind to every branch pointed at objects the server already has.
    const store = new MemoryStore()
    const dir = scratch()
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      now: () => new Date(AT),
      signer: KEY,
    })
    const recorded = readPending(dir)!
    expect(recorded.entry).toBeNull()

    await publishPush(store, 'r', recorded, [change('refs/heads/main', ZERO_OID, OID_A)])
    const { index } = await loadIndex(store, 'r')
    expect(index.entries).toEqual([])
    expect(index.provenance).toEqual({ 'refs/heads/main': by(KEY) })
  })

  test('an unsigned push records nothing, and leaves index.json as it was', async () => {
    const store = new MemoryStore()
    const recorded = await preReceiveSigned(store, null)
    expect(recorded.provenance).toBeUndefined()

    await publishPush(store, 'r', recorded, [change('refs/heads/main', ZERO_OID, OID_A)])
    const { index } = await loadIndex(store, 'r')
    expect(index.provenance).toBeUndefined()
    // Absent from the serialized object, not present as `{}`: a deployment that
    // takes no signed pushes writes byte-for-byte what it wrote before.
    const body = new TextDecoder().decode((await store.get('repos/r/index.json'))!.body)
    expect(body).not.toContain('provenance')
  })

  test('establishing the Signer passes the answer through, and defaults to none', () => {
    expect(establishSigner(() => KEY)).toBe(KEY)
    expect(establishSigner(() => null)).toBeNull()
    // No argument, no certificate in the environment: the ordinary unsigned
    // push, which is what the hook gets on a deployment that takes no signed
    // pushes at all.
    expect(establishSigner()).toBeNull()
  })

  test('a verifier that throws does not fail the push', async () => {
    const store = new MemoryStore()
    const dir = scratch()
    // The catch that fails open lives at the seam the hook calls, above the
    // upload — so this is the whole of what a throwing verifier costs.
    const signer = establishSigner(() => {
      throw new Error('ssh-keygen: not found')
    })
    expect(signer).toBeNull()
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      signer,
    })
    // The push is intact and merely anonymous — which is the whole fail-open
    // rule: provenance is metadata and never a new way for a push to fail.
    expect(readPending(dir)!.provenance).toBeUndefined()
    expect(
      (
        await publishPush(store, 'r', readPending(dir)!, [
          change('refs/heads/main', ZERO_OID, OID_A),
        ])
      ).ok,
    ).toBe(true)
    expect((await loadIndex(store, 'r')).index.refs['refs/heads/main']).toBe(OID_A)
  })

  test('a later unsigned push clears the ref it overwrote', async () => {
    // Otherwise the Index would name a key beside a sha that key never signed —
    // stating something false, which is worse than stating nothing.
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, provenance: by(KEY) }, [
      change('refs/heads/main', ZERO_OID, OID_A),
    ])
    expect((await loadIndex(store, 'r')).index.provenance).toEqual({ 'refs/heads/main': by(KEY) })

    await publishPush(store, 'r', { entry: null }, [change('refs/heads/main', OID_A, OID_B)])
    expect((await loadIndex(store, 'r')).index.provenance).toBeUndefined()
  })

  test('a second signer over the same ref replaces the first', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, provenance: by(KEY) }, [
      change('refs/heads/main', ZERO_OID, OID_A),
    ])
    await publishPush(store, 'r', { entry: null, provenance: by(OTHER) }, [
      change('refs/heads/main', OID_A, OID_B),
    ])
    expect((await loadIndex(store, 'r')).index.provenance).toEqual({ 'refs/heads/main': by(OTHER) })
  })

  test('deleting a ref takes its Signer with it', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, provenance: by(KEY) }, [
      change('refs/heads/main', ZERO_OID, OID_A),
      change('refs/heads/topic', ZERO_OID, OID_B),
    ])
    await publishPush(store, 'r', { entry: null, provenance: by(KEY) }, [
      change('refs/heads/topic', OID_B, ZERO_OID),
    ])

    const { index } = await loadIndex(store, 'r')
    expect(index.refs).toEqual({ 'refs/heads/main': OID_A })
    // In step with `refs`, so the map cannot grow forever with refs nothing can
    // look up.
    expect(index.provenance).toEqual({ 'refs/heads/main': by(KEY) })
  })

  test('a multi-transaction push keeps its Signer past the first transaction', async () => {
    // git updates refs one transaction at a time unless the client asked for
    // `--atomic`, and only the first carries the pack. The rest are the same
    // push and are signed by the same key.
    const store = new MemoryStore()
    const recorded = await preReceiveSigned(store, KEY)

    await publishPush(store, 'r', recorded, [change('refs/heads/main', ZERO_OID, OID_A)])
    // What `hook-main` hands the second transaction once the pack is consumed.
    await publishPush(store, 'r', { entry: null, provenance: recorded.provenance }, [
      change('refs/heads/topic', ZERO_OID, OID_B),
    ])

    const { index } = await loadIndex(store, 'r')
    expect(index.entries).toHaveLength(1)
    expect(index.provenance).toEqual({
      'refs/heads/main': by(KEY),
      'refs/heads/topic': by(KEY),
    })
  })
})
