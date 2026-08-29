/**
 * Compaction and collection end to end, against a repo built by real pushes.
 *
 * The two claims under test are the ones a double cannot make. First, that
 * compaction is a REPACK and not a rewrite: a repo restored from an index
 * snapshotted before it, and one restored from the index after it, must be
 * indistinguishable to git. Second, that the grace period is load-bearing
 * rather than decorative: a restore holding the pre-compaction index still
 * finds every object it names, right up until collection, and stops finding
 * them the moment collection runs — which is the proof that nothing but the
 * delay was protecting it.
 *
 * The fixture is built with the compaction threshold pinned out of reach, so
 * the `post-receive` trigger cannot fire while the log is being constructed and
 * every test below decides for itself when compaction happens.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { acquireLease, compact, DEFAULT_GRACE_MS } from './compact'
import { collectGarbage } from './gc'
import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'
import { materialize, neededEntries } from './materialize'
import { findOrphans } from './orphans'
import { ensureBareRepo } from './cache'
import { resolveRepo } from './repo'
import { FileStore } from './store'
import { syncRepo } from './sync'
import { ulid } from './ulid'
import { walKey } from './keys'
import { loadIndex, type WalIndex } from './wal-index'

const TOKEN = 's3cret'
const BRANCHES = ['main', 'alpha', 'beta']
const PUSHES = 40
const THRESHOLD = 12

let server: ReturnType<typeof Bun.serve>
let reposDir: string
let storeDir: string
let scratch: string
let store: FileStore
let origin: string
const repoId = 'compactable'

/** The index as it stood before any compaction — a restore in flight holds this. */
let indexBefore: WalIndex
/** Refs and history of the repo the pushes built, before anything was repacked. */
let reference: { refs: string; history: string }

const git = async (cwd: string, ...args: string[]) => {
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
  return { status, all: `${out}${err}` }
}

const bareDir = () => path.join(reposDir, `${repoId}.git`)

function refsOf(gitDir: string): string {
  const res = spawnSync(
    'git',
    ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(refname)'],
    { encoding: 'utf8' },
  )
  return res.stdout.trim().split('\n').sort().join('\n')
}

function historyOf(gitDir: string): string {
  const res = spawnSync('git', ['--git-dir', gitDir, 'log', '--all', '--format=%H'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  return res.stdout.trim().split('\n').sort().join('\n')
}

/** Rebuild into a directory of its own, from exactly the index handed in. */
async function restoreFrom(index: WalIndex, name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walgit-restore-${name}-`))
  const repo = resolveRepo(dir, repoId)
  const result = await materialize(store, repo, index)
  return { dir, gitDir: repo.dir, result }
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-compact-repos-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-compact-store-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-compact-work-'))
  store = new FileStore(storeDir)
  process.env.WALGIT_STORE_DIR = storeDir
  process.env.WALGIT_QUIET = '1'
  // Out of reach on purpose: the fixture must not compact itself out from
  // under the tests that decide when compaction happens.
  process.env.WALGIT_COMPACTION_THRESHOLD = '1000000'

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
  origin = `http://walgit:${TOKEN}@127.0.0.1:${server.port}/${repoId}.git`

  const client = path.join(scratch, 'client')
  fs.mkdirSync(client, { recursive: true })
  await git(client, 'init', '--quiet', '--initial-branch=main')
  await git(client, 'config', 'user.email', 'walgit@example.test')
  await git(client, 'config', 'user.name', 'walgit')
  await git(client, 'remote', 'add', 'origin', origin)

  for (let i = 0; i < PUSHES; i += 1) {
    const branch = BRANCHES[i % BRANCHES.length]!
    if (i < BRANCHES.length && branch !== 'main') {
      await git(client, 'checkout', '--quiet', '-b', branch, 'main')
    } else {
      await git(client, 'checkout', '--quiet', branch)
    }
    fs.writeFileSync(path.join(client, `${branch}.txt`), `push ${i}\n`)
    await git(client, 'add', '-A')
    await git(client, 'commit', '--quiet', '-m', `push ${i} on ${branch}`)
    const pushed = await git(client, 'push', '--quiet', 'origin', branch)
    if (pushed.status !== 0) throw new Error(`push ${i} failed: ${pushed.all}`)
  }

  indexBefore = (await loadIndex(store, repoId)).index
  reference = { refs: refsOf(bareDir()), history: historyOf(bareDir()) }
}, 300_000)

afterAll(() => {
  server?.stop(true)
  delete process.env.WALGIT_COMPACTION_THRESHOLD
  for (const dir of [reposDir, storeDir, scratch]) fs.rmSync(dir, { recursive: true, force: true })
})

test('the fixture is a log of one entry per push, uncompacted', () => {
  expect(indexBefore.entries).toHaveLength(PUSHES)
  expect(indexBefore.compaction_frontier).toBe(0)
  expect(neededEntries(indexBefore)).toHaveLength(PUSHES)
})

test('compaction fires, advances the frontier, and leaves one entry to replay', async () => {
  const repo = resolveRepo(reposDir, repoId)
  const result = await compact(store, repo, { threshold: THRESHOLD, holder: 'node-a' })

  expect(result.status).toBe('compacted')
  if (result.status !== 'compacted') return
  expect(result.supersedes_through).toBe(PUSHES)
  expect(result.tombstoned).toHaveLength(PUSHES)

  const { index } = await loadIndex(store, repoId)
  expect(index.compaction_frontier).toBe(PUSHES)
  // The whole point, in one assertion: a restore now replays one entry, not
  // forty, and that number does not grow with the next forty pushes either.
  expect(neededEntries(index)).toHaveLength(1)
  expect(neededEntries(index)[0]!.kind).toBe('compaction')
  expect(index.refs).toEqual(indexBefore.refs)
}, 120_000)

test('a second compaction with the work already done is declined as not due', async () => {
  const repo = resolveRepo(reposDir, repoId)
  const result = await compact(store, repo, { threshold: THRESHOLD, holder: 'node-a' })
  expect(result).toEqual({ status: 'not-due', pending: 1 })
})

test('two nodes compacting at once: one proceeds, the other declines', async () => {
  // The lease is taken directly rather than by racing two `compact` calls,
  // because a race whose outcome depends on which promise resumes first proves
  // nothing on the run where it happens not to overlap. This holds the window
  // open for the whole test, which is the condition the lease exists for.
  const repo = resolveRepo(reposDir, repoId)
  const held = await acquireLease(store, repoId, { holder: 'node-b' })
  expect(held.ok).toBe(true)

  const before = (await loadIndex(store, repoId)).index
  const declined = await compact(store, repo, { force: true, holder: 'node-a' })
  expect(declined).toEqual({ status: 'held', holder: 'node-b' })
  // Declining is not "did nothing visible" — it is "wrote nothing at all".
  const untouched = (await loadIndex(store, repoId)).index
  expect(untouched.seq).toBe(before.seq)
  expect(untouched.entries).toHaveLength(before.entries.length)

  if (held.ok) await held.release()
  const proceeds = await compact(store, repo, { force: true, holder: 'node-a' })
  expect(proceeds.status).toBe('compacted')
}, 120_000)

test('history is identical restored from before, during, and after a compaction', async () => {
  // "During" is not a fourth state: an index read mid-compaction is either the
  // pre-CAS one or the post-CAS one, and a restore that started before the CAS
  // holds the former for its whole run. Both are exercised, plus the live one.
  const { index: after } = await loadIndex(store, repoId)
  const during = indexBefore

  const restored = await Promise.all([
    restoreFrom(indexBefore, 'before'),
    restoreFrom(during, 'during'),
    restoreFrom(after, 'after'),
  ])

  for (const { gitDir, result } of restored) {
    expect(result.reconciled.missing).toEqual([])
    expect(refsOf(gitDir)).toBe(reference.refs)
    expect(historyOf(gitDir)).toBe(reference.history)
  }

  // …and the post-compaction restore did it by downloading a fraction of the
  // entries the pre-compaction one had to.
  expect(restored[2]!.result.stats.fetched).toBeLessThan(restored[0]!.result.stats.fetched)
  for (const { dir } of restored) fs.rmSync(dir, { recursive: true, force: true })
}, 180_000)

test('inside the grace period the superseded entries are all still there', async () => {
  const gc = await collectGarbage(store, repoId)
  expect(gc.collected).toEqual([])
  expect(gc.retained.length).toBeGreaterThan(0)

  // The claim: a restore that read the index before the CAS is not merely
  // "probably fine" — every object it names is present.
  const { gitDir, dir, result } = await restoreFrom(indexBefore, 'graced')
  expect(result.reconciled.missing).toEqual([])
  expect(historyOf(gitDir)).toBe(reference.history)
  fs.rmSync(dir, { recursive: true, force: true })
}, 120_000)

test('an orphan is collected and nothing the index references is', async () => {
  // A rejected push, reproduced: an upload that lost its compare-and-swap. It
  // is dated old so the age guard does not hold it back.
  const orphan = walKey(repoId, 999, ulid(Date.now() - 10 * DEFAULT_GRACE_MS), 'pack')
  await store.put(orphan, new Uint8Array([0xff]))
  expect(await findOrphans(store, repoId)).toContain(orphan)

  const before = (await loadIndex(store, repoId)).index
  const gc = await collectGarbage(store, repoId)

  expect(gc.orphansCollected).toEqual([orphan])
  expect(await store.get(orphan)).toBeNull()
  // Everything the index names survived — including the entries whose grace
  // period has not elapsed, which are unreferenced by NOTHING and must stay.
  for (const entry of before.entries) expect(await store.get(entry.key)).not.toBeNull()
  const after = (await loadIndex(store, repoId)).index
  expect(after.entries.map((e) => e.key)).toEqual(before.entries.map((e) => e.key))
}, 120_000)

test('once the grace period elapses the superseded entries go, and only those', async () => {
  const before = (await loadIndex(store, repoId)).index
  const superseded = new Set((before.tombstones ?? []).map((t) => t.key))
  expect(superseded.size).toBeGreaterThan(0)

  // Time travel rather than sleeping: the grace period is an hour by design.
  const gc = await collectGarbage(store, repoId, {
    now: () => new Date(Date.now() + 2 * DEFAULT_GRACE_MS),
  })
  expect(gc.collected.sort()).toEqual([...superseded].sort())

  const after = (await loadIndex(store, repoId)).index
  expect(after.tombstones).toEqual([])
  for (const entry of after.entries) expect(await store.get(entry.key)).not.toBeNull()

  // The live repo is untouched by any of it: still restorable, still identical.
  const { gitDir, dir, result } = await restoreFrom(after, 'collected')
  expect(result.reconciled.missing).toEqual([])
  expect(refsOf(gitDir)).toBe(reference.refs)
  expect(historyOf(gitDir)).toBe(reference.history)
  fs.rmSync(dir, { recursive: true, force: true })

  // And the grace period really was the only thing protecting the old index:
  // a restore holding it now fails loudly rather than producing a broken repo.
  await expect(restoreFrom(indexBefore, 'too-late')).rejects.toThrow(/missing from the store/)
}, 180_000)

test('post-receive schedules compaction without the client waiting for it', async () => {
  process.env.WALGIT_COMPACTION_THRESHOLD = '2'
  const client = path.join(scratch, 'client')
  const frontierBefore = (await loadIndex(store, repoId)).index.compaction_frontier

  await git(client, 'checkout', '--quiet', 'main')
  for (const i of [0, 1, 2]) {
    fs.writeFileSync(path.join(client, 'trigger.txt'), `trigger ${i}\n`)
    await git(client, 'add', '-A')
    await git(client, 'commit', '--quiet', '-m', `trigger ${i}`)
    const pushed = await git(client, 'push', '--quiet', 'origin', 'main')
    // Git's own words, not just its exit code. A bare `expect(status).toBe(0)`
    // reports "Expected 0, received 128" and nothing else, which does not say
    // whether the client, the pre-receive hook, or the log refused the push —
    // and this failure reproduces only on CI, where nobody can attach a shell.
    if (pushed.status !== 0) {
      throw new Error(`push ${i} exited ${pushed.status}:\n${pushed.all}`)
    }
  }

  // The hook spawns and disowns, so the push returns before the repack does.
  let frontier = frontierBefore
  for (let i = 0; i < 200 && frontier <= frontierBefore; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    frontier = (await loadIndex(store, repoId)).index.compaction_frontier
  }
  expect(frontier).toBeGreaterThan(frontierBefore)
  process.env.WALGIT_COMPACTION_THRESHOLD = '1000000'
}, 180_000)
