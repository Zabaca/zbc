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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createHttpHandler } from './http'
import { ensureBareRepo, resolveRepo } from './repo'
import { runGitHttpBackend } from './git-backend'
import { FileStore } from './store'
import { findOrphans } from './orphans'
import { localRefs } from './reconcile'
import { syncRepo } from './sync'
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
    expect(index.refs['refs/heads/main']).toBe((await git(seed.dir, 'rev-parse', 'HEAD')).out.trim())
  })
})
