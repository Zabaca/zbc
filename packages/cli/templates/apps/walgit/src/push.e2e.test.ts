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
/** How long the server holds a POST before serving it. Reset by `beforeEach`. */
let postDelayMs = 0

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

/**
 * Wait until a `pre-receive` has recorded a pending push in the bare repo.
 *
 * The record is written immediately before the `WALGIT_STALL_MS` sleep, so its
 * appearance means the push under test is past every `pre-receive` verdict and
 * holding with its pack already uploaded. Waiting on that rather than on a
 * clock is what lets a race be DRIVEN instead of hoped for. `post-receive`
 * clears the record, so a finished push leaves nothing to mistake for one.
 */
async function pendingWritten(timeoutMs = 10_000): Promise<void> {
  const dir = path.join(bareDir(), 'walgit-pending')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return
    await Bun.sleep(20)
  }
  throw new Error(`no pending push was recorded in ${dir}`)
}

beforeAll(() => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-repos-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-store-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-work-'))
  store = new FileStore(storeDir)

  // The hooks are spawned by git, not by us: this is how they find the store.
  process.env.WALGIT_STORE_DIR = storeDir

  const handler = createHttpHandler({
    reposDir,
    tokens: [TOKEN],
    ensureRepo: ensureBareRepo,
    syncRepo: (repo) => syncRepo(store, repo),
    runBackend: runGitHttpBackend,
  })

  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      // A push is two requests — the advertisement that mints the push-cert
      // nonce, then the POST that validates it — and how far apart they land is
      // what a slow network, a starved CPU or a cold container vary. Holding
      // the POST here is how a test makes that gap a decision rather than a
      // coin flip; nothing in the server under test knows this wrapper exists.
      if (postDelayMs > 0 && request.method === 'POST') await Bun.sleep(postDelayMs)
      return handler(request)
    },
  })
})

beforeEach(() => {
  // A fresh repo id per test, so one test's published index cannot decide
  // another test's compare-and-swap.
  repoCounter += 1
  repoId = `alpha${repoCounter}`
  origin = `http://walgit:${TOKEN}@127.0.0.1:${server.port}/${repoId}.git`
  postDelayMs = 0
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

  test('is still attributed when the round trip crosses a second boundary', async () => {
    // The fault this test exists for: git mints the nonce from the *unix
    // second* the advertisement was served in, and over smart-HTTP the push is
    // a second process that can only agree by accident. Without a window
    // configured, a push whose POST lands a second later reads as `SLOP` and
    // establishes no Signer — fail-open here, and the owner's own push refused
    // on a claimed name (docs/adr/0012). A real network, a starved CPU or a
    // container waking up all produce that gap; this produces it on purpose.
    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    const { dir, oid } = await clientWithCommit('slow-signed', 'slow signed push\n')

    // Longer than a second, so the boundary is crossed on every run rather than
    // on the unlucky ones: what was intermittent is now certain.
    postDelayMs = 1500
    const pushed = await pushSigned(dir)
    expect(pushed.status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.refs['refs/heads/main']).toBe(oid)
    // Attributed to the pushing key, exactly as the same push is when it is
    // fast. A delayed round trip is a slow push, not an anonymous one.
    expect(index.provenance?.['refs/heads/main']?.signer).toBe(fingerprintOf(`${signingKey}.pub`))
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

/** `ssh-keygen -lf` prints `<bits> SHA256:… <comment> (ED25519)`. */
function fingerprintOf(pub: string): string {
  const printed = Bun.spawnSync(['ssh-keygen', '-lf', pub]).stdout.toString()
  const found = printed.split(/\s+/).find((word) => word.startsWith('SHA256:'))
  if (!found) throw new Error(`no fingerprint in ${JSON.stringify(printed)}`)
  return found
}

/**
 * Signer Lists, against a real `git push` (docs/adr/0012).
 *
 * Every verdict is decided by a pure function and tested as one in
 * `signers.test.ts`; what cannot be tested there is the WIRING — that the list
 * a real push writes reaches `index.json`, that the list `index.json` holds
 * reaches the refusal, that a real certificate over a real nonce is what the
 * gate matches against, and that a grant landed by one push is what judges the
 * next. Two real keys, two identities, one repository.
 */
describe('Signer Lists', () => {
  let alicePub = ''
  let bobPub = ''
  let aliceFp = ''
  let bobFp = ''

  const keypair = (name: string): string => {
    const file = path.join(scratch, `signer-${name}`)
    const keygen = Bun.spawnSync(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', name, '-f', file])
    if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.toString()}`)
    return `${file}.pub`
  }

  beforeAll(() => {
    alicePub = keypair('alice')
    bobPub = keypair('bob')
    aliceFp = fingerprintOf(alicePub)
    bobFp = fingerprintOf(bobPub)
  })

  beforeEach(() => {
    // The seed is what makes `git-receive-pack` advertise certificates at all,
    // so a claimed name needs it; the flag is what makes walgit judge them.
    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    process.env.WALGIT_SIGNER_LISTS = '1'
  })

  afterEach(() => {
    delete process.env.WALGIT_PUSH_CERT_SEED
    delete process.env.WALGIT_SIGNER_LISTS
  })

  /**
   * How long a racing push is held between `pre-receive` and its publish, and
   * how long the tests that drive that race are allowed to take.
   *
   * The stall only has to outlast one local push, because `pendingWritten`
   * — not a clock — is what decides when the interleaved push is sent; it is
   * generous because a stall that expired early would turn a real failure into
   * a flake that looks like one.
   */
  const RACE_STALL_MS = 3_000
  const RACE_TIMEOUT_MS = 30_000

  const pushAs = (dir: string, pub: string, ...refspecs: string[]) =>
    git(
      dir,
      '-c',
      'gpg.format=ssh',
      '-c',
      `user.signingkey=${pub}`,
      'push',
      '--signed=yes',
      'origin',
      ...refspecs,
    )

  /**
   * A working copy of the list itself, with no history in common with the
   * repository's branches — because the list is its own ref and an agent
   * writing one has no reason to have cloned anything.
   */
  async function listWorkdir(name: string): Promise<string> {
    const dir = path.join(scratch, `${repoId}-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    await git(dir, 'init', '--quiet', '--initial-branch=signers')
    await git(dir, 'config', 'user.email', 'walgit@example.test')
    await git(dir, 'config', 'user.name', 'walgit')
    await git(dir, 'remote', 'add', 'origin', origin)
    return dir
  }

  /** Commit a `signers` file naming exactly `keys`. */
  async function writeList(dir: string, keys: string[], message: string): Promise<void> {
    fs.writeFileSync(path.join(dir, 'signers'), keys.map((k) => `${k}\n`).join(''))
    await git(dir, 'add', 'signers')
    await git(dir, 'commit', '--quiet', '-m', message)
  }

  test('claim a free name, refuse a stranger, grant, and be granted', async () => {
    // 1. Alice claims a free name. Nothing judges this push — an unclaimed
    //    name refuses nothing, which is why the founding push needs no
    //    exception written for it.
    const list = await listWorkdir('list')
    await writeList(list, [aliceFp], 'claim')
    expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

    // The ref is authoritative and the Index carries the derived copy the
    // refusal reads, written by the compare-and-swap that published the ref.
    const claimed = await loadIndex(store, repoId)
    expect(claimed.index.claim!.signers).toEqual([aliceFp])
    expect(claimed.index.refs['refs/walgit/signers']).toBeDefined()

    // 2. Alice pushes a branch, signed by the key she listed. It lands.
    const alice = await clientWithCommit('alice', 'alice\n')
    expect((await pushAs(alice.dir, alicePub, 'HEAD:refs/heads/main')).status).toBe(0)

    // 3. Bob is a stranger. His signed push is refused, in words he can act on.
    const bob = await clientWithCommit('bob', 'bob\n')
    const refused = await pushAs(bob.dir, bobPub, 'HEAD:refs/heads/bob')
    expect(refused.status).not.toBe(0)
    expect(refused.out).toContain(`${repoId} is held by a Signer List`)
    expect(refused.out).toContain(bobFp)
    expect(refused.out).toMatch(new RegExp(`${repoId}-[0-9a-f]{8}\\.git`))

    // …and so is an unsigned one, which is fail-open's one exception: if
    // breaking verification landed the push, breaking it would BE the bypass.
    const unsigned = await git(bob.dir, 'push', 'origin', 'HEAD:refs/heads/bob')
    expect(unsigned.status).not.toBe(0)
    expect(unsigned.out).toContain('carries no signature')

    // Neither push cost an object-store write, which is the whole reason the
    // verdict sits above the upload rather than below it.
    const mid = await loadIndex(store, repoId)
    expect(mid.index.refs['refs/heads/bob']).toBeUndefined()
    expect(mid.index.entries).toHaveLength(claimed.index.entries.length + 1)
    expect(await findOrphans(store, repoId)).toEqual([])

    // 4. Alice grants Bob: a commit that adds a line. Her own push is judged by
    //    the list as it stood before it, which still names only her.
    await writeList(list, [aliceFp, bobFp], 'grant bob')
    expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)
    expect((await loadIndex(store, repoId)).index.claim!.signers).toEqual([aliceFp, bobFp])

    // 5. Bob's next push lands — a grant governs the next push, and this is it.
    expect((await pushAs(bob.dir, bobPub, 'HEAD:refs/heads/bob')).status).toBe(0)
    expect((await loadIndex(store, repoId)).index.refs['refs/heads/bob']).toBe(bob.oid)

    // 6. Revoking is a commit that removes a line. Bob is refused again — and
    //    everything he already pushed stays, because append-only still means
    //    append-only and nothing here is retroactive.
    await writeList(list, [aliceFp], 'revoke bob')
    expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

    fs.writeFileSync(path.join(bob.dir, 'README'), 'bob again\n')
    await git(bob.dir, 'commit', '--quiet', '-am', 'bob again')
    const revoked = await pushAs(bob.dir, bobPub, 'HEAD:refs/heads/bob')
    expect(revoked.status).not.toBe(0)
    expect(revoked.out).toContain('is held by a Signer List')

    const final = await loadIndex(store, repoId)
    expect(final.index.refs['refs/heads/bob']).toBe(bob.oid)
    expect(final.index.claim!.signers).toEqual([aliceFp])
    expect(await findOrphans(store, repoId)).toEqual([])
  })

  test('a push that writes the list and a branch at once is judged by the list before it', async () => {
    // The grant rule, in the one shape that could get it wrong: git shows
    // `pre-receive` both refs at once and publishes them across several
    // compare-and-swaps, so a gate reading the list this push installs would
    // let a stranger claim a name out from under the one who holds it.
    const list = await listWorkdir('atomic')
    await writeList(list, [aliceFp], 'claim')
    expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

    await writeList(list, [bobFp], 'bob takes the name')
    const stolen = await pushAs(list, bobPub, 'HEAD:refs/walgit/signers', 'HEAD:refs/heads/bob')
    expect(stolen.status).not.toBe(0)
    expect(stolen.out).toContain('is held by a Signer List')

    const { index } = await loadIndex(store, repoId)
    expect(index.claim!.signers).toEqual([aliceFp])
    expect(index.refs['refs/heads/bob']).toBeUndefined()
  })

  test('a founding push may write the list and a branch at once, and both land', async () => {
    // The grant rule from the side that has to keep working, and the one shape
    // where a publish-time re-check could break it: git publishes the two refs
    // in separate compare-and-swaps, so by the second the Index already holds
    // the list THIS push installed. Judged by it, the push would refuse its own
    // branch — here, a claim Alice signs that lists only Bob's key.
    const list = await listWorkdir('founding-both')
    await writeList(list, [bobFp], 'alice claims the name for bob')

    const pushed = await pushAs(list, alicePub, 'HEAD:refs/walgit/signers', 'HEAD:refs/heads/notes')
    expect(pushed.status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.claim!.signers).toEqual([bobFp])
    expect(index.refs['refs/heads/notes']).toBeDefined()
  })

  test('an unclaimed name refuses nothing, flag or no flag', async () => {
    // Fail open is unchanged everywhere the exception does not reach, and
    // "everywhere" is every repository until someone writes a list. Both of
    // the pushes refused above land here, on a name with no list.
    const anonymous = await clientWithCommit('anon', 'anon\n')
    expect((await git(anonymous.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    const stranger = await clientWithCommit('stranger', 'stranger\n')
    expect((await pushAs(stranger.dir, bobPub, 'HEAD:refs/heads/stranger')).status).toBe(0)

    const { index } = await loadIndex(store, repoId)
    expect(index.claim).toBeUndefined()
    expect(index.refs['refs/heads/stranger']).toBe(stranger.oid)
  })

  test(
    'a push judged against a free name is refused by the claim that lands while it uploads',
    async () => {
      // The window this closes, driven rather than waited for: Bob's push is
      // judged against a name with no list, so nothing refuses him; his pack
      // uploads; Alice claims the name while it does; and his ref transaction
      // would then publish onto a name that is no longer free. Under append-only
      // that branch could never be removed, which is the whole of why it must not
      // land — and the founding push is the one moment ADR-0012 says needs no
      // exception, so this is the one shape that could still slip through it.
      const bob = await clientWithCommit('racer', 'racer\n')
      const list = await listWorkdir('racer-list')
      await writeList(list, [aliceFp], 'claim')

      // Hold Bob's `pre-receive` open past the upload — the same knob the
      // pending-file race uses.
      process.env.WALGIT_STALL_MS = String(RACE_STALL_MS)
      const racing = pushAs(bob.dir, bobPub, 'HEAD:refs/heads/bob')
      await pendingWritten()
      // From here the knob is off for everyone else: Alice's claim must not stall
      // behind the push it is racing.
      delete process.env.WALGIT_STALL_MS

      expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)
      expect((await loadIndex(store, repoId)).index.claim!.signers).toEqual([aliceFp])

      // git kills the connection on a `prepared` hook that exits non-zero — it
      // dies with "ref updates aborted by hook" over its own stderr rather than
      // the sideband `pre-receive` gets — so the client is told the push failed
      // and walgit's words are the server's to log. The verdict itself is
      // asserted in `push.test.ts`, where it can be read.
      const refused = await racing
      expect(refused.status).not.toBe(0)

      // Nothing of Bob's was published: not the ref, and not a WAL entry. The
      // claim that beat him is the one that stands.
      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/bob']).toBeUndefined()
      expect(index.claim!.signers).toEqual([aliceFp])
      expect(localRefs(bareDir())['refs/heads/bob']).toBeUndefined()

      // This refusal is reached AFTER the upload, which the `pre-receive`
      // placement exists to avoid and which this race makes unavoidable — the
      // earlier answer is precisely the one that went stale. The accepted cost is
      // an orphaned pack, and it is recoverable rather than silent garbage.
      expect((await findOrphans(store, repoId)).some((k) => k.endsWith('.pack'))).toBe(true)
    },
    RACE_TIMEOUT_MS,
  )

  test(
    'the claim that lands mid-push does not refuse a key it names',
    async () => {
      // The mirror, and the reason the re-check asks the gate rather than
      // refusing anything that raced a claim: a list moving under a push is not
      // by itself a refusal. Whoever it names is unaffected.
      const list = await listWorkdir('grant-race')
      await writeList(list, [aliceFp, bobFp], 'claim naming both')
      expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

      const bob = await clientWithCommit('granted-racer', 'granted\n')
      process.env.WALGIT_STALL_MS = String(RACE_STALL_MS)
      const racing = pushAs(bob.dir, bobPub, 'HEAD:refs/heads/bob')
      await pendingWritten()
      delete process.env.WALGIT_STALL_MS

      // The list moves while Bob's pack is in flight, and still names his key.
      await writeList(list, [bobFp, aliceFp], 'reorder')
      expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

      expect((await racing).status).toBe(0)
      const { index } = await loadIndex(store, repoId)
      expect(index.refs['refs/heads/bob']).toBe(bob.oid)
      expect(index.claim!.signers).toEqual([bobFp, aliceFp])
    },
    RACE_TIMEOUT_MS,
  )

  test('with the flag off, a claimed name refuses nobody', async () => {
    // The capability ships off, and off has to mean off: a repository that
    // already holds a list on a deployment that has not turned ownership on
    // behaves exactly as it did before any of this existed.
    const list = await listWorkdir('flagless')
    await writeList(list, [aliceFp], 'claim')
    expect((await pushAs(list, alicePub, 'HEAD:refs/walgit/signers')).status).toBe(0)

    delete process.env.WALGIT_SIGNER_LISTS
    const stranger = await clientWithCommit('unenforced', 'unenforced\n')
    expect((await git(stranger.dir, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)
    expect((await loadIndex(store, repoId)).index.refs['refs/heads/main']).toBe(stranger.oid)
  })
})
