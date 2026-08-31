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
import { describeSigner, type PushSigner } from './signers'
import { SIGNERS_REF, ZERO_OID } from '../shared/protocol'
import { loadIndex, type RefChange } from './wal-index'

/**
 * The two answers `pre-receive` reaches in this file, spelled once. The third —
 * a certificate walgit could not verify — is `signers.test.ts`'s, because
 * nothing on the push path treats it differently from an unsigned one until a
 * name is claimed.
 */
const anonymous: PushSigner = { kind: 'unsigned', signable: false }
const signedBy = (fingerprint: string): PushSigner => ({ kind: 'signed', fingerprint })

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
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: quarantine,
      signer: anonymous,
    })

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
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      signer: anonymous,
    })

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
    await preReceive({
      store,
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      signer: anonymous,
    })

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
  const preReceiveSigned = async (store: MemoryStore, signer: PushSigner) => {
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
    const recorded = await preReceiveSigned(store, signedBy(KEY))
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
      signer: signedBy(KEY),
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
    const recorded = await preReceiveSigned(store, anonymous)
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
      signer: describeSigner(signer, {}),
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
    const recorded = await preReceiveSigned(store, signedBy(KEY))

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

/**
 * Recording a Signer List (docs/adr/0012).
 *
 * The same path Provenance takes, one level up: resolved in `pre-receive` from
 * the quarantine, carried through the pending record, applied by the
 * compare-and-swap that publishes the ref move. What is asserted here is that
 * the Index ends up holding the list. Deciding WHETHER a list may be written is
 * `signers.test.ts`'s, along with the hook-level proof that a refusal is
 * reached before the pack is uploaded. A real `git push` of one belongs to the
 * enforcement slice, which is the first thing with an end-to-end story worth
 * telling — claim a free name, be refused as a stranger, be granted, succeed.
 */
describe('the Signer List', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-claim-'))
  const KEY = `SHA256:${'A'.repeat(43)}`
  const OTHER = `SHA256:${'B'.repeat(43)}`
  const AT = '2026-08-30T12:00:00.000Z'
  const LIST_OID = 'd'.repeat(40)

  const claimOf = (...signers: string[]) => ({ signers, ts: AT })
  const listMove = (oldOid = ZERO_OID, newOid = LIST_OID) => change(SIGNERS_REF, oldOid, newOid)

  /** `pre-receive` for a push carrying a pack and writing `signerList`. */
  const preReceiveListing = async (store: MemoryStore, signerList: string[] | null) => {
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
      signer: anonymous,
      signerList,
    })
    return readPending(dir)!
  }

  test('a push that writes a list records it, alongside the ref it moved', async () => {
    const store = new MemoryStore()
    const recorded = await preReceiveListing(store, [KEY, OTHER])
    expect(recorded.claim).toEqual(claimOf(KEY, OTHER))

    expect((await publishPush(store, 'r', recorded, [listMove()])).ok).toBe(true)

    const { index } = await loadIndex(store, 'r')
    expect(index.claim).toEqual(claimOf(KEY, OTHER))
    // The ref and the field land in one compare-and-swap, which is what makes
    // the derived copy safe — and what makes a repository rebuilt from the log
    // still hold its list, because a restore replays both from here.
    expect(index.refs[SIGNERS_REF]).toBe(LIST_OID)
  })

  test('a push that writes no list leaves index.json exactly as it was', async () => {
    const store = new MemoryStore()
    const recorded = await preReceiveListing(store, null)
    expect(recorded.claim).toBeUndefined()

    await publishPush(store, 'r', recorded, [change('refs/heads/main', ZERO_OID, OID_A)])
    const { index } = await loadIndex(store, 'r')
    expect(index.claim).toBeUndefined()
    // Absent from the serialized object rather than present as null: an Index
    // written before this field existed reads as unclaimed, and an instance
    // where nobody claims anything writes byte-for-byte what it wrote before.
    const body = new TextDecoder().decode((await store.get('repos/r/index.json'))!.body)
    expect(body).not.toContain('claim')
  })

  test('an ordinary push to a claimed repository leaves the list alone', async () => {
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, claim: claimOf(KEY) }, [listMove()])
    await publishPush(store, 'r', { entry: null }, [change('refs/heads/main', ZERO_OID, OID_A)])

    // Unlike provenance beside it, there is no clearing rule: a claim is a fact
    // about the name, not about the last push.
    expect((await loadIndex(store, 'r')).index.claim).toEqual(claimOf(KEY))
  })

  test('deleting the list ref takes the claim with it', async () => {
    // Unreachable while the flag is on — `checkSignerList` refuses the deletion
    // first — and that is exactly why the rule lives on the Index instead of
    // resting on the refusal. A deployment that turns the flag off can delete
    // the ref, and an Index that went on naming a list nothing holds would
    // state something false, which is worse than stating nothing.
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, claim: claimOf(KEY) }, [listMove()])
    await publishPush(store, 'r', { entry: null }, [listMove(LIST_OID, ZERO_OID)])
    expect((await loadIndex(store, 'r')).index.claim).toBeUndefined()
  })

  test('a later list replaces the earlier one entirely', async () => {
    // Revoking is a commit that removes a line, so the new list is the whole
    // answer — a merge of the two would make a revocation impossible.
    const store = new MemoryStore()
    await publishPush(store, 'r', { entry: null, claim: claimOf(KEY, OTHER) }, [listMove()])
    await publishPush(store, 'r', { entry: null, claim: claimOf(OTHER) }, [
      listMove(LIST_OID, OID_C),
    ])
    expect((await loadIndex(store, 'r')).index.claim).toEqual(claimOf(OTHER))
  })

  test('the field is written by the transaction that moves the list ref, not an earlier one', async () => {
    // A push moving a branch and the list together publishes across several
    // compare-and-swaps, and `hook-main` hands the resolved list to every one
    // of them. Writing it in the first would leave the Index naming a list the
    // ref does not yet hold — and still naming it if the second is refused.
    const store = new MemoryStore()
    const recorded = await preReceiveListing(store, [KEY])

    await publishPush(store, 'r', recorded, [change('refs/heads/main', ZERO_OID, OID_A)])
    expect((await loadIndex(store, 'r')).index.claim).toBeUndefined()

    await publishPush(store, 'r', { entry: null, claim: recorded.claim }, [listMove()])
    expect((await loadIndex(store, 'r')).index.claim).toEqual(claimOf(KEY))
  })

  test('a push recording both a Signer and a list stamps them at one instant', async () => {
    const dir = scratch()
    await preReceive({
      store: new MemoryStore(),
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      now: () => new Date(AT),
      signer: signedBy(KEY),
      signerList: [KEY],
    })
    const recorded = readPending(dir)!
    // One push, one moment. Two readings of the clock would date the Signer and
    // the list it wrote a millisecond apart, for no reason a reader could ever
    // account for.
    expect(recorded.provenance!.ts).toBe(recorded.claim!.ts)
  })

  test('two pushes racing for a free name: the loser gets a plain ref conflict', async () => {
    // Claiming is pushing a ref, so the race is the one every push already
    // runs, resolved by the same compare-and-swap. Both computed their update
    // against a name with no list, so the second one's `oldOid` no longer
    // matches what the Index holds — and it is told that, in the words any
    // contended ref gets. There is no claim-specific race, and inventing one
    // would be a second answer to a question already answered.
    const store = new MemoryStore()
    const alice = { entry: null, claim: claimOf(KEY) }
    const bob = { entry: null, claim: claimOf(OTHER) }

    expect((await publishPush(store, 'r', alice, [listMove()])).ok).toBe(true)
    const lost = await publishPush(store, 'r', bob, [listMove()])
    expect(lost).toEqual({
      ok: false,
      reason: 'ref-conflict',
      ref: SIGNERS_REF,
      expected: ZERO_OID,
      actual: LIST_OID,
    })

    // And the winner's list is the one that stands: the loser published nothing.
    expect((await loadIndex(store, 'r')).index.claim).toEqual(claimOf(KEY))
  })
})

/**
 * The gate, re-asked at the compare-and-swap (docs/adr/0012).
 *
 * `pre-receive` judges ownership before the pack uploads, which is where a
 * refusal is free — and for a real repository that upload is seconds, so the
 * answer can be stale by the time the push publishes. What is asserted here is
 * that the verdict is true at the moment the push lands: the interleaving is
 * driven directly, by publishing a claim between the two askings, because that
 * is the whole of the race and a test that waited for it to happen by luck
 * would pass for the wrong reason. The same interleaving through two real
 * `git push`es is `push.e2e.test.ts`'s.
 */
describe('ownership is re-asked at publish', () => {
  const KEY = `SHA256:${'A'.repeat(43)}`
  const OTHER = `SHA256:${'B'.repeat(43)}`
  const AT = '2026-08-30T12:00:00.000Z'
  const LIST_OID = 'd'.repeat(40)

  const claimOf = (...signers: string[]) => ({ signers, ts: AT })
  const listMove = (oldOid = ZERO_OID, newOid = LIST_OID) => change(SIGNERS_REF, oldOid, newOid)
  const branch = (ref = 'refs/heads/topic') => change(ref, ZERO_OID, OID_A)
  const gated = { signerLists: true }

  /** Somebody claims the name — the push whose landing opens the window. */
  const claim = async (store: MemoryStore, ...signers: string[]) => {
    const published = await publishPush(store, 'r', { entry: null, claim: claimOf(...signers) }, [
      listMove(),
    ])
    expect(published.ok).toBe(true)
  }

  test('a push judged against an unclaimed name is refused once the name was claimed', async () => {
    // The window: `pre-receive` saw no claim and allowed this push, the pack
    // uploaded, and the claim landed while it did. Under append-only, letting
    // it publish would be a permanent stranger-write into someone's name.
    const store = new MemoryStore()
    await claim(store, KEY)

    const refused = await publishPush(store, 'r', pending(), [branch()], gated)

    expect(refused).toMatchObject({ ok: false, reason: 'not-allowed', kind: 'unsigned' })
    // And it published nothing: the branch is not in the log, and the claim
    // that beat it is untouched.
    const { index } = await loadIndex(store, 'r')
    expect(index.refs['refs/heads/topic']).toBeUndefined()
    expect(index.entries).toEqual([])
    expect(index.claim).toEqual(claimOf(KEY))
  })

  test('the refusal is the gate’s own, and never dressed as a ref conflict', async () => {
    // A ref conflict tells the pusher to fetch and rebase, which cannot help:
    // the ref is free and the NAME is held. Sending them there would hide the
    // only fact they can act on.
    const store = new MemoryStore()
    await claim(store, KEY)

    const refused = await publishPush(
      store,
      'r',
      { entry: null, signer: signedBy(OTHER), provenance: { signer: OTHER, ts: AT } },
      [branch()],
      gated,
    )

    expect(refused).toMatchObject({ ok: false, reason: 'not-allowed', kind: 'not-listed' })
    const message = (refused as { message: string }).message
    expect(message).toContain('r is held by a Signer List')
    expect(message).toContain(OTHER)
    expect(message).not.toContain('fetch and retry')
    // It also says why it is late, and it does not claim nothing was uploaded —
    // the pack went up before the claim landed, and a refusal that lies about
    // what it did with your objects is worse than one that says nothing.
    expect(message).toContain("Signer List moved while this push's objects were uploading")
    expect(message).not.toContain('Nothing was uploaded')
    expect(message).not.toContain('the repository is unchanged')
  })

  test('the late refusal says the list MOVED, never that the name was claimed', async () => {
    // Both ways of moving reach this refusal, and only one of them is a claim.
    // Here the pusher was on the list and a revocation landed mid-push: an
    // agent told the name had been claimed would go looking for a squatter
    // instead of asking to be listed again.
    const store = new MemoryStore()
    await claim(store, OTHER)

    const revoked = await publishPush(
      store,
      'r',
      { entry: null, signer: signedBy(KEY), provenance: { signer: KEY, ts: AT } },
      [branch()],
      gated,
    )

    const message = (revoked as { message: string }).message
    expect(message).not.toContain('was free when this push')
    expect(message).not.toContain('was claimed while')
  })

  test('the founding push is not refused by its own re-check', async () => {
    // At its own compare-and-swap the Index still carries no claim — the one it
    // writes is installed by `applyClaim` in the successor — so the list this
    // push is judged against is the empty one it found. A re-check written
    // against the post-apply value would refuse every claim ever made.
    const store = new MemoryStore()

    const founding = await publishPush(
      store,
      'r',
      { entry: null, signer: signedBy(KEY), claim: claimOf(KEY) },
      [listMove()],
      gated,
    )

    expect(founding.ok).toBe(true)
    expect((await loadIndex(store, 'r')).index.claim).toEqual(claimOf(KEY))
  })

  test('a push does not judge its own later transactions by the list it just installed', async () => {
    // git updates refs one transaction at a time unless the client asked for
    // `--atomic`, so a push moving the list and a branch together publishes
    // across several compare-and-swaps — and by the second one the Index holds
    // this push's own list. Judging by it would break the grant rule in exactly
    // the shape that rule exists for: here, a founding push listing somebody
    // else's key would refuse its own branch.
    const store = new MemoryStore()
    const own = { entry: null, signer: signedBy(KEY), claim: claimOf(OTHER) }

    expect((await publishPush(store, 'r', own, [listMove()], gated)).ok).toBe(true)
    const rest = await publishPush(store, 'r', own, [branch()], gated)

    expect(rest.ok).toBe(true)
    expect((await loadIndex(store, 'r')).index.refs['refs/heads/topic']).toBe(OID_A)
  })

  test('a revocation does not refuse the rest of the push that made it', async () => {
    // The same rule from the other side: a listed key may push a list that
    // removes itself. Its own remaining refs are judged by the list that stood
    // before the push, which still named it.
    const store = new MemoryStore()
    await claim(store, KEY)
    const stepping = {
      entry: null,
      signer: signedBy(KEY),
      claim: { signers: [OTHER], ts: '2026-08-30T13:00:00.000Z' },
    }

    expect((await publishPush(store, 'r', stepping, [listMove(LIST_OID, OID_C)], gated)).ok).toBe(
      true,
    )
    expect((await publishPush(store, 'r', stepping, [branch()], gated)).ok).toBe(true)
  })

  test('a claim written by SOMEONE ELSE mid-push is not mistaken for this push’s own', async () => {
    // The guard above keys on the whole `Claim`, timestamp included, so it
    // cannot be satisfied by a list that merely names the same keys: one push,
    // one reading of the clock.
    const store = new MemoryStore()
    await claim(store, KEY)
    const racer = {
      entry: null,
      signer: signedBy(OTHER),
      claim: { signers: [KEY], ts: '2026-08-30T13:00:00.000Z' },
    }

    const refused = await publishPush(store, 'r', racer, [branch()], gated)
    expect(refused).toMatchObject({ ok: false, reason: 'not-allowed', kind: 'not-listed' })
  })

  test('an unsigned founding push claims a free name too', async () => {
    // An unclaimed name refuses nothing, and that has to survive the re-check
    // as literally as it survives the gate: walgit takes a claim from whoever
    // pushes one first, signed or not, because there is nobody yet to prefer.
    const store = new MemoryStore()

    const founding = await publishPush(
      store,
      'r',
      { entry: null, signer: anonymous, claim: claimOf(KEY) },
      [listMove()],
      gated,
    )

    expect(founding.ok).toBe(true)
  })

  test('a listed key still lands when the list moved under it and still names it', async () => {
    // The grant that landed mid-push is not a refusal for everyone: it is a
    // refusal for a stranger. Whoever it names is unaffected.
    const store = new MemoryStore()
    await claim(store, KEY, OTHER)

    const landed = await publishPush(
      store,
      'r',
      { entry: null, signer: signedBy(OTHER), provenance: { signer: OTHER, ts: AT } },
      [branch()],
      gated,
    )

    expect(landed.ok).toBe(true)
    expect((await loadIndex(store, 'r')).index.refs['refs/heads/topic']).toBe(OID_A)
  })

  test('no new refusal reaches an unclaimed name', async () => {
    // Every repository until someone writes a list. The re-check is asked on
    // all of them and answers the same way the gate does: nothing.
    const store = new MemoryStore()

    const landed = await publishPush(store, 'r', pending(), [branch()], gated)

    expect(landed.ok).toBe(true)
    expect((await loadIndex(store, 'r')).index.claim).toBeUndefined()
  })

  test('with the flag off the re-check is never asked, on a claimed name either', async () => {
    // Off has to mean off, at both askings. `hook-main` passes the same
    // `signerListsEnabled()` to the gate and to the publish, so a deployment
    // that has not turned ownership on behaves exactly as it did before.
    const store = new MemoryStore()
    await claim(store, KEY)

    const landed = await publishPush(store, 'r', pending(), [branch()])

    expect(landed.ok).toBe(true)
    expect((await loadIndex(store, 'r')).index.refs['refs/heads/topic']).toBe(OID_A)
  })

  test('a second claim racing the first is still a plain ref conflict', async () => {
    // The re-check sits BELOW the ref-conflict check for this: two claims move
    // the same ref, so the loser's `oldOid` no longer matches and the question
    // is already answered, in the words any contended ref gets. Answering it
    // twice would be a second answer to a settled question.
    const store = new MemoryStore()
    await claim(store, KEY)

    const lost = await publishPush(
      store,
      'r',
      { entry: null, signer: signedBy(OTHER), claim: claimOf(OTHER) },
      [listMove()],
      gated,
    )

    expect(lost).toEqual({
      ok: false,
      reason: 'ref-conflict',
      ref: SIGNERS_REF,
      expected: ZERO_OID,
      actual: LIST_OID,
    })
  })

  test('a record with no Signer written down is read back from its Provenance', async () => {
    // `pre-receive` always writes the three-way answer, so this is the shape a
    // hand-built record has — and the one answer that can let a push LAND, a
    // verified key, is recoverable from the Provenance beside it exactly.
    const store = new MemoryStore()
    await claim(store, KEY)

    const landed = await publishPush(
      store,
      'r',
      { entry: null, provenance: { signer: KEY, ts: AT } },
      [branch()],
      gated,
    )
    expect(landed.ok).toBe(true)

    const refused = await publishPush(
      store,
      'r',
      { entry: null },
      [branch('refs/heads/other')],
      gated,
    )
    expect(refused).toMatchObject({ ok: false, reason: 'not-allowed' })
  })

  test('`pre-receive` writes the Signer down for the publish to re-read', async () => {
    // The certificate lives in the push's quarantine and `pre-receive` is the
    // only hook git shows it to, so what is not written here cannot be asked
    // again later.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-recheck-'))
    await preReceive({
      store: new MemoryStore(),
      repoId: 'r',
      gitDir: dir,
      quarantineDir: undefined,
      now: () => new Date(AT),
      signer: signedBy(KEY),
    })
    expect(readPending(dir)!.signer).toEqual(signedBy(KEY))

    // Including the two answers that record no Provenance at all — which is the
    // reason the field exists rather than being derived from `provenance`.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-recheck-'))
    await preReceive({
      store: new MemoryStore(),
      repoId: 'r',
      gitDir: plain,
      quarantineDir: undefined,
      now: () => new Date(AT),
      signer: { kind: 'unverified' },
    })
    expect(readPending(plain)!.signer).toEqual({ kind: 'unverified' })
    expect(readPending(plain)!.provenance).toBeUndefined()
  })
})
