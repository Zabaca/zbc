/**
 * The push path end to end: a real `git push`, the real hooks git spawns, and a
 * real object store on disk. Nothing here is a double, because every claim this
 * milestone makes is about what git does at moments a double cannot reproduce —
 * the quarantine directory, the staged ref transaction, and the exit code that
 * decides whether the client is told its push succeeded.
 *
 * The safety property under test, stated once: for every point the process can
 * die, EITHER the client saw a rejection OR the commit is durably in the log.
 * Never neither.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createHttpHandler } from './http'
import { ensureBareRepo } from './cache'
import { resolveRepo } from './repo'
import { runGitHttpBackend } from './git-backend'
import { FileStore } from './store'
import { findOrphans } from './orphans'
import { localRefs } from './reconcile'
import { syncRepo } from './sync'
import { materialize } from './materialize'
import { loadIndex } from './wal-index'

const TOKEN = 's3cret'
let server: ReturnType<typeof Bun.serve>
let reposDir: string
let storeDir: string
let scratch: string
let store: FileStore
let repoCounter = 0
let repoId: string
let origin: string

const git = async (cwd: string, ...args: string[]) => {
  // Asynchronous, not spawnSync: the server under test is in this process, so a
  // synchronous child would block the loop that has to answer it.
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ASKPASS: '/usr/bin/false',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, out: `${out}${err}` }
}

/** A clone with one new commit on main, ready to push. */
async function clientWithCommit(name: string, body: string): Promise<{ dir: string; oid: string }> {
  const dir = path.join(scratch, `${repoId}-${name}`)
  await git(scratch, 'clone', '--quiet', origin, dir)
  await git(dir, 'config', 'user.email', 'walgit@example.test')
  await git(dir, 'config', 'user.name', 'walgit')
  fs.writeFileSync(path.join(dir, 'README'), body)
  await git(dir, 'add', 'README')
  await git(dir, 'commit', '--quiet', '-m', body.trim())
  const oid = (await git(dir, 'rev-parse', 'HEAD')).out.trim()
  return { dir, oid }
}

const bareDir = () => path.join(reposDir, `${repoId}.git`)

beforeAll(() => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-repos-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-store-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-work-'))
  store = new FileStore(storeDir)

  // The hooks are spawned by git, not by us: this is how they find the store.
  process.env.WALGIT_STORE_DIR = storeDir

  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: createHttpHandler({
      reposDir,
      tokens: [TOKEN],
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(store, repo),
      runBackend: runGitHttpBackend,
    }),
  })
})

beforeEach(() => {
  // A fresh repo id per test, so one test's published index cannot decide
  // another test's compare-and-swap.
  repoCounter += 1
  repoId = `alpha${repoCounter}`
  origin = `http://walgit:${TOKEN}@127.0.0.1:${server.port}/${repoId}.git`
  delete process.env.WALGIT_FAULT
  delete process.env.WALGIT_STALL_MS
})

afterAll(() => {
  server.stop(true)
  delete process.env.WALGIT_STORE_DIR
  delete process.env.WALGIT_FAULT
  for (const dir of [reposDir, storeDir, scratch]) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a push that succeeds', () => {
  test('is published to the log and fetchable by another client', async () => {
    const { dir, oid } = await clientWithCommit('first', 'walgit\n')
    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')
    expect(pushed.status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.seq).toBe(1)
    expect(index.refs['refs/heads/main']).toBe(oid)
    expect(index.entries[0]!.key).toContain(`repos/${repoId}/wal/000000000001-`)

    // The pack in the log is the real pack, not a placeholder.
    const stored = await store.get(index.entries[0]!.key)
    expect(stored!.body.byteLength).toBe(index.entries[0]!.size)
    expect(new TextDecoder().decode(stored!.body.subarray(0, 4))).toBe('PACK')

    const second = path.join(scratch, `${repoId}-second`)
    expect((await git(scratch, 'clone', '--quiet', origin, second)).status).toBe(0)
    expect((await git(second, 'rev-parse', 'HEAD')).out.trim()).toBe(oid)

    // Nothing was left behind for the collector to find.
    expect(await findOrphans(store, repoId)).toEqual([])
  })

  test('a second push appends rather than replacing', async () => {
    const { dir } = await clientWithCommit('first', 'one\n')
    await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')
    fs.writeFileSync(path.join(dir, 'README'), 'two\n')
    await git(dir, 'commit', '--quiet', '-am', 'two')
    expect((await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.entries.map((e) => e.seq)).toEqual([1, 2])
    expect(index.refs['refs/heads/main']).toBe((await git(dir, 'rev-parse', 'HEAD')).out.trim())
  })
})

describe('fault injection', () => {
  test('dying after the upload rejects the client and publishes nothing', async () => {
    const { dir } = await clientWithCommit('first', 'one\n')
    process.env.WALGIT_FAULT = 'after-upload'

    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')

    expect(pushed.status).not.toBe(0)
    expect(await store.get(`repos/${repoId}/index.json`)).toBeNull()
    expect(localRefs(bareDir())['refs/heads/main']).toBeUndefined()

    // The upload survives as a findable orphan, not silent garbage.
    const orphans = await findOrphans(store, repoId)
    expect(orphans.some((k) => k.endsWith('.pack'))).toBe(true)
  })

  test('dying before the compare-and-swap rejects the client and publishes nothing', async () => {
    const { dir } = await clientWithCommit('first', 'one\n')
    process.env.WALGIT_FAULT = 'before-cas'

    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')

    expect(pushed.status).not.toBe(0)
    expect(await store.get(`repos/${repoId}/index.json`)).toBeNull()
  })

  test('dying after the compare-and-swap: the client is rejected but the commit is durable', async () => {
    const { dir, oid } = await clientWithCommit('first', 'one\n')
    process.env.WALGIT_FAULT = 'after-cas'

    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')

    // Both halves of the guarantee: the client was NOT told it succeeded, and
    // the commit IS in the log. Never both-negative.
    expect(pushed.status).not.toBe(0)
    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(oid)

    // git aborted the local ref update, so this node now disagrees with the
    // published truth — the exact race reconcile exists to close.
    expect(localRefs(bareDir())['refs/heads/main']).toBeUndefined()
    delete process.env.WALGIT_FAULT

    const result = await syncRepo(store, resolveRepo(reposDir, repoId))
    expect(result!.updated).toEqual(['refs/heads/main'])
    expect(localRefs(bareDir())['refs/heads/main']).toBe(oid)

    // And the pushed commit is now servable to a client that was never involved.
    const second = path.join(scratch, `${repoId}-second`)
    expect((await git(scratch, 'clone', '--quiet', origin, second)).status).toBe(0)
    expect((await git(second, 'rev-parse', 'HEAD')).out.trim()).toBe(oid)
  })
})

describe('contention', () => {
  test('two clients pushing the same ref: one wins, the loser is rejected', async () => {
    const seed = await clientWithCommit('seed', 'seed\n')
    await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')

    const [a, b] = await Promise.all([clientWithCommit('a', 'a\n'), clientWithCommit('b', 'b\n')])
    const [pushA, pushB] = await Promise.all([
      git(a.dir, 'push', 'origin', 'HEAD:refs/heads/main'),
      git(b.dir, 'push', 'origin', 'HEAD:refs/heads/main'),
    ])

    const winners = [pushA, pushB].filter((r) => r.status === 0)
    expect(winners).toHaveLength(1)

    const { index } = await loadIndex(store, repoId)
    // Contiguous: the loser published nothing, so it consumed no sequence number.
    expect(index.entries.map((e) => e.seq)).toEqual([1, 2])
    expect([a.oid, b.oid]).toContain(index.refs['refs/heads/main'])

    // The loser's uploaded pack is recoverable rather than lost.
    expect(await findOrphans(store, repoId)).toHaveLength(2)
  })

  test('a push against a ref the log has already moved is rejected, not merged', async () => {
    const seed = await clientWithCommit('seed', 'seed\n')
    await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')

    const stale = await clientWithCommit('stale', 'stale\n')
    // Someone else publishes while `stale` holds an old advertisement.
    fs.writeFileSync(path.join(seed.dir, 'README'), 'moved\n')
    await git(seed.dir, 'commit', '--quiet', '-am', 'moved')
    await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')

    const rejected = await git(stale.dir, 'push', 'origin', 'HEAD:refs/heads/main')
    expect(rejected.status).not.toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(
      (await git(seed.dir, 'rev-parse', 'HEAD')).out.trim(),
    )
  })
})

describe('concurrent pushes on one node', () => {
  test('every push git acknowledged survives a rebuild from the log alone', async () => {
    const seed = await clientWithCommit('seed', 'seed\n')
    await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')

    // Distinct refs, so none of these is a legitimate ref conflict: every one
    // of them is allowed to succeed, and every one git acknowledges must be in
    // the log. Several at once because the failure is a race between two
    // `git-receive-pack` invocations sharing one hand-off file.
    const clients = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) => clientWithCommit(name, `${name}\n`)),
    )
    // Hold every `pre-receive` open past the others', so the invocations really
    // do overlap rather than overlapping by luck.
    process.env.WALGIT_STALL_MS = '400'
    const results = await Promise.all(
      clients.map((c, i) => git(c.dir, 'push', 'origin', `HEAD:refs/heads/topic-${i}`)),
    )
    delete process.env.WALGIT_STALL_MS

    const acknowledged = clients
      .map((c, i) => ({ ref: `refs/heads/topic-${i}`, oid: c.oid, ok: results[i]!.status === 0 }))
      .filter((c) => c.ok)
    expect(acknowledged.length).toBeGreaterThan(1)

    const { index } = await loadIndex(store, repoId)
    // One acknowledged push, one entry: a push that published another push's
    // upload shows up here as a key claimed twice.
    expect(new Set(index.entries.map((e) => e.key)).size).toBe(index.entries.length)
    expect(index.entries).toHaveLength(1 + acknowledged.length)

    // The claim under test, made the only way that cannot be self-confirming:
    // throw the disk away and rebuild from the log. Every acknowledged commit
    // has to be there, objects and all.
    const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-cold-'))
    const cold = resolveRepo(coldDir, repoId)
    await materialize(store, cold)
    for (const { ref, oid } of acknowledged) {
      expect({ ref, oid: localRefs(cold.dir)[ref] }).toEqual({ ref, oid })
      expect(
        (await git(cold.dir, '--git-dir', cold.dir, 'cat-file', '-e', `${oid}^{commit}`)).status,
      ).toBe(0)
    }
    fs.rmSync(coldDir, { recursive: true, force: true })

    // Nothing an acknowledged push uploaded was left unreferenced.
    expect(await findOrphans(store, repoId)).toEqual([])
  })
})

describe('append-only refs', () => {
  /**
   * A clone whose main has diverged from the server's: the tip commit dropped
   * and a different one put in its place. This — not "a clone with an extra
   * commit" — is what a force push actually carries; a clone that merely added
   * a commit fast-forwards and is allowed.
   */
  async function divergedClient(): Promise<{ dir: string; oid: string }> {
    const dir = path.join(scratch, `${repoId}-divergent`)
    await git(scratch, 'clone', '--quiet', origin, dir)
    await git(dir, 'config', 'user.email', 'walgit@example.test')
    await git(dir, 'config', 'user.name', 'walgit')
    await git(dir, 'reset', '--quiet', '--hard', 'HEAD~1')
    fs.writeFileSync(path.join(dir, 'README'), 'rewritten\n')
    await git(dir, 'add', 'README')
    await git(dir, 'commit', '--quiet', '-m', 'rewritten')
    return { dir, oid: (await git(dir, 'rev-parse', 'HEAD')).out.trim() }
  }

  /** main with two commits, so a client can drop one and still have a history. */
  async function seedMain(): Promise<{ dir: string; oid: string }> {
    const seed = await clientWithCommit('seed', 'seed\n')
    expect((await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)
    fs.writeFileSync(path.join(seed.dir, 'README'), 'seed two\n')
    await git(seed.dir, 'add', 'README')
    await git(seed.dir, 'commit', '--quiet', '-m', 'seed two')
    expect((await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)
    return { dir: seed.dir, oid: (await git(seed.dir, 'rev-parse', 'HEAD')).out.trim() }
  }

  describe('with the instance flag on', () => {
    beforeEach(() => {
      process.env.WALGIT_APPEND_ONLY = '1'
    })
    afterEach(() => {
      delete process.env.WALGIT_APPEND_ONLY
    })

    test('refuses a force push, in walgit’s own words', async () => {
      const seed = await seedMain()
      const { dir } = await divergedClient()

      const forced = await git(dir, 'push', '--force', 'origin', 'HEAD:refs/heads/main')
      expect(forced.status).not.toBe(0)
      // The exit code alone would also be satisfied by git's own refusal, which
      // says nothing an agent can act on. The words are the deliverable.
      expect(forced.out).toContain(`${repoId} is append-only`)
      expect(forced.out).toContain('would rewrite refs/heads/main')
      expect(forced.out).toMatch(new RegExp(`${repoId}-[0-9a-f]{8}\\.git`))

      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/main']).toBe(seed.oid)
    })

    test('a refused push writes nothing to the log — the reason the check is early', async () => {
      await seedMain()
      const before = await loadIndex(store, repoId)
      const { dir } = await divergedClient()

      expect((await git(dir, 'push', '--force', 'origin', 'HEAD:refs/heads/main')).status).not.toBe(
        0,
      )

      const after = await loadIndex(store, repoId)
      expect(after.index.entries).toHaveLength(before.index.entries.length)
      // Not merely unpublished: never uploaded. An orphan here would mean the
      // pack reached the store and `findOrphans` has to reclaim it.
      expect(await findOrphans(store, repoId)).toEqual([])
    })

    test('refuses a ref deletion', async () => {
      const seed = await seedMain()

      const deleted = await git(seed.dir, 'push', 'origin', ':refs/heads/main')
      expect(deleted.status).not.toBe(0)
      expect(deleted.out).toContain('Deleting refs/heads/main')

      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/main']).toBe(seed.oid)
    })

    test('refuses an unrelated history pushed over an existing branch', async () => {
      const seed = await seedMain()
      const dir = path.join(scratch, `${repoId}-unrelated`)
      fs.mkdirSync(dir, { recursive: true })
      await git(dir, 'init', '--quiet', '--initial-branch=main', dir)
      await git(dir, 'config', 'user.email', 'walgit@example.test')
      await git(dir, 'config', 'user.name', 'walgit')
      fs.writeFileSync(path.join(dir, 'README'), 'mine\n')
      await git(dir, 'add', 'README')
      await git(dir, 'commit', '--quiet', '-m', 'mine')

      const pushed = await git(dir, 'push', '--force', origin, 'HEAD:refs/heads/main')
      expect(pushed.status).not.toBe(0)
      expect(pushed.out).toContain(`${repoId} is append-only`)

      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/main']).toBe(seed.oid)
    })

    test('still accepts a new branch and a fast-forward', async () => {
      const seed = await seedMain()
      expect((await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/topic')).status).toBe(0)

      fs.writeFileSync(path.join(seed.dir, 'README'), 'more\n')
      await git(seed.dir, 'add', 'README')
      await git(seed.dir, 'commit', '--quiet', '-m', 'more')
      expect((await git(seed.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/main']).toBe(
        (await git(seed.dir, 'rev-parse', 'HEAD')).out.trim(),
      )
      expect(index.refs['refs/heads/topic']).toBe(seed.oid)
    })

    test('installs git’s own deny rules as the backstop under the hook', async () => {
      await seedMain()
      const config = async (key: string) =>
        (await git(scratch, '--git-dir', bareDir(), 'config', '--get', key)).out.trim()
      expect(await config('receive.denyNonFastForwards')).toBe('true')
      expect(await config('receive.denyDeletes')).toBe('true')
    })
  })

  test('is off by default: an instance without the flag still accepts a force push', async () => {
    await seedMain()
    const { dir, oid } = await divergedClient()

    expect((await git(dir, 'push', '--force', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(oid)
  })
})

describe('size limits', () => {
  /**
   * A commit carrying `bytes` of incompressible data, so the pack git builds is
   * within a rounding error of that number. A compressible blob would make the
   * pack size a property of zlib rather than of the test.
   */
  async function clientWithBlob(name: string, bytes: number): Promise<{ dir: string }> {
    const dir = path.join(scratch, `${repoId}-${name}`)
    await git(scratch, 'clone', '--quiet', origin, dir)
    await git(dir, 'config', 'user.email', 'walgit@example.test')
    await git(dir, 'config', 'user.name', 'walgit')
    fs.writeFileSync(path.join(dir, 'blob'), crypto.randomBytes(bytes))
    await git(dir, 'add', 'blob')
    await git(dir, 'commit', '--quiet', '-m', name)
    return { dir }
  }

  afterEach(() => {
    delete process.env.WALGIT_MAX_PUSH_BYTES
    delete process.env.WALGIT_MAX_REPO_BYTES
  })

  test('refuses a push over the per-push cap, in walgit’s own words', async () => {
    process.env.WALGIT_MAX_PUSH_BYTES = String(64 * 1024)
    // Over the cap, under the `receive.maxInputSize` backstop — which is where
    // a real over-limit push lands, and where the hook must own the message.
    const { dir } = await clientWithBlob('fat', 96 * 1024)

    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')
    expect(pushed.status).not.toBe(0)
    // Not git's `pack exceeds maximum allowed size`, and not the edge's
    // `unexpected disconnect`: an agent must be able to act on this.
    expect(pushed.out).toContain('this push is larger than 65536 bytes')
    expect(pushed.out).toContain('not a network failure')
    expect(pushed.out).toContain('Nothing was uploaded')
  })

  test('a refused push writes nothing to the log — the reason the check is early', async () => {
    process.env.WALGIT_MAX_PUSH_BYTES = String(64 * 1024)
    const before = await loadIndex(store, repoId)
    const { dir } = await clientWithBlob('fat', 96 * 1024)

    expect((await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).not.toBe(0)

    const after = await loadIndex(store, repoId)
    expect(after.index.entries).toHaveLength(before.index.entries.length)
    // Not merely unpublished: never uploaded. The whole point of refusing here
    // rather than after `preReceive` is that there is no orphan to reclaim.
    expect(await findOrphans(store, repoId)).toEqual([])
  })

  test('refuses a push that would take the repository over its total, and says so differently', async () => {
    const seeded = await clientWithBlob('seed', 128 * 1024)
    expect((await git(seeded.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)
    const { index } = await loadIndex(store, repoId)
    const held = index.entries.reduce((n, e) => n + e.size, 0)

    // Room for the seed, not for another one like it. The second push is small
    // enough that a per-push cap would never fire on it.
    process.env.WALGIT_MAX_REPO_BYTES = String(held + 16 * 1024)
    const { dir } = await clientWithBlob('more', 128 * 1024)

    const pushed = await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')
    expect(pushed.status).not.toBe(0)
    expect(pushed.out).toContain(`${repoId} would exceed its`)
    expect(pushed.out).toContain('it is the repository that is full')
    expect(pushed.out).not.toContain('this push is larger than')

    const after = await loadIndex(store, repoId)
    expect(after.index.entries).toHaveLength(index.entries.length)
    expect(await findOrphans(store, repoId)).toEqual([])
  })

  test('a push under both caps is untouched, and the git backstop sits above the cap', async () => {
    process.env.WALGIT_MAX_PUSH_BYTES = String(1024 * 1024)
    process.env.WALGIT_MAX_REPO_BYTES = String(4 * 1024 * 1024)
    const { dir } = await clientWithBlob('small', 32 * 1024)

    expect((await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    // Set to the cap, `index-pack` would refuse before `pre-receive` ever runs
    // and every client would read git's message instead of ours. What the
    // backstop does when it DOES fire is deliberately not asserted here: it
    // kills the stream mid-body, which the client reports as `unexpected
    // disconnect` — the very message this feature exists to stop producing,
    // and the reason the backstop is set far above the cap rather than at it.
    const configured = (
      await git(scratch, '--git-dir', bareDir(), 'config', '--get', 'receive.maxInputSize')
    ).out.trim()
    expect(Number(configured)).toBeGreaterThan(1024 * 1024)
  })

  test('is off by default: an unset cap refuses nothing', async () => {
    // Comfortably past every cap the tests above configure, and deliberately
    // not much larger: a multi-hundred-KiB body through this in-process
    // harness flakes on its own, unrelated to anything under test here.
    const { dir } = await clientWithBlob('unbounded', 128 * 1024)
    expect((await git(dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)
    expect((await loadIndex(store, repoId)).index.entries).toHaveLength(1)
  })
})

/**
 * Signed pushes: the capability, and nothing beyond it.
 *
 * A push certificate is a `receive-pack` capability rather than a transport
 * one, which is why it works here at all — smart-HTTP, no SSH anywhere. git
 * advertises it only when the receiving repository has `receive.certNonceSeed`,
 * so the seed is the whole feature (src/push-cert.ts, docs/adr/0011).
 *
 * A signed push is required to land exactly as an unsigned one does — same
 * entry, same index, same acknowledgement — and to additionally name the key
 * that made it, as the Index's `signers` map (docs/adr/0011). The verification
 * itself runs for real here: a real key, a real certificate, and a real
 * `ssh-keygen -Y check-novalidate -n git` inside `pre-receive`.
 */
describe('signed pushes', () => {
  let signingKey: string

  beforeAll(() => {
    // A real key, because git shells out to `ssh-keygen -Y sign` and a fake one
    // would be caught there rather than here. Ed25519 and no passphrase: this
    // is a client-side detail of the test, not a claim about what walgit takes.
    signingKey = path.join(scratch, 'signing-key')
    const keygen = Bun.spawnSync([
      'ssh-keygen',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'walgit-test',
      '-f',
      signingKey,
    ])
    if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.toString()}`)
  })

  afterEach(() => {
    delete process.env.WALGIT_PUSH_CERT_SEED
  })

  /** The same push every test here makes; only the seed differs. */
  const pushSigned = (dir: string) =>
    git(
      dir,
      '-c',
      'gpg.format=ssh',
      '-c',
      `user.signingkey=${signingKey}.pub`,
      'push',
      '--signed=yes',
      'origin',
      'HEAD:refs/heads/main',
    )

  test('with the seed set, a signed push is accepted and lands like any other', async () => {
    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    const { dir, oid } = await clientWithCommit('signed', 'signed push\n')

    const pushed = await pushSigned(dir)
    expect(pushed.status).toBe(0)

    // Landed in the log, not merely acknowledged: a signed push is not a
    // special path.
    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(oid)
    expect(index.entries).toHaveLength(1)

    // …and is attributed. The fingerprint is the pushing key's own, read out of
    // the certificate by walgit's own verification — git's verdict on an SSH
    // signature is `GIT_PUSH_CERT_STATUS=N`, so anything derived from it would
    // name nobody (shared/provenance.ts).
    const fingerprint = Bun.spawnSync(['ssh-keygen', '-lf', `${signingKey}.pub`])
      .stdout.toString()
      .split(/\s+/)
      .find((word) => word.startsWith('SHA256:'))
    expect(fingerprint).toBeDefined()
    expect(index.provenance!['refs/heads/main']!.signer).toBe(fingerprint!)
    expect(Date.parse(index.provenance!['refs/heads/main']!.ts)).not.toBeNaN()
  })

  test('the repository advertises it because the seed is on the repository', async () => {
    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    const { dir } = await clientWithCommit('seeded', 'seeded\n')
    expect((await pushSigned(dir)).status).toBe(0)

    const configured = (
      await git(scratch, '--git-dir', bareDir(), 'config', '--get', 'receive.certNonceSeed')
    ).out.trim()
    expect(configured).toBe('a-long-random-seed')
  })

  test('without the seed the client refuses, in git’s own words, and nothing is uploaded', async () => {
    const { dir } = await clientWithCommit('unseeded', 'unseeded\n')

    const pushed = await pushSigned(dir)
    expect(pushed.status).not.toBe(0)
    // Refused by the pusher's own git against the capability advertisement —
    // this is what agentgit says today, and what a deployment that has not
    // turned provenance on must keep saying.
    expect(pushed.out).toContain('the receiving end does not support --signed push')

    const { index } = await loadIndex(store, repoId)
    expect(index.entries).toHaveLength(0)
    expect(index.refs['refs/heads/main']).toBeUndefined()
  })

  test('an unsigned push is unchanged, seed or no seed', async () => {
    // The promise the whole goal rests on: anonymous stays first-class. The
    // same push has to behave identically on a host that takes certificates and
    // one that does not.
    const unseeded = await clientWithCommit('plain-unseeded', 'plain\n')
    expect((await git(unseeded.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    fs.writeFileSync(path.join(unseeded.dir, 'README'), 'plain again\n')
    await git(unseeded.dir, 'commit', '--quiet', '-am', 'plain again')
    expect((await git(unseeded.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(
      (await git(unseeded.dir, 'rev-parse', 'HEAD')).out.trim(),
    )
    expect(index.entries).toHaveLength(2)
    // No certificate, so no Signer, and the field never appears — anonymous
    // stays first-class right down to the bytes of index.json.
    expect(index.provenance).toBeUndefined()
  })
})
