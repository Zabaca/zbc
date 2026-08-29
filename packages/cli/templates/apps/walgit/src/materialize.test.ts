/**
 * Materialize, against a real object store and a real git.
 *
 * The WAL here is built by hand rather than by pushing, because these tests are
 * about what materialize does with a log — a compaction frontier, a corrupt
 * entry, a lock, a half-finished attempt — and a push cannot produce those
 * states on demand. The end-to-end suite covers the log a real push writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { isPartial, markerPath, materialize, neededEntries, packBasename } from './materialize'
import { localRefs } from './reconcile'
import { resolveRepo } from './repo'
import { FileStore } from './store'
import {
  commitIndex,
  emptyIndex,
  sha256,
  walKey,
  type WalEntry,
  type WalIndex,
} from './wal-index'
import { ulid } from './ulid'

let scratch: string
let storeDir: string
let reposDir: string
let store: FileStore
let counter = 0

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/** A source repo with `commits` commits on main, plus its full-object pack. */
function sourceRepo(commits: number): { dir: string; head: string; pack: Uint8Array } {
  const dir = path.join(scratch, `src-${(counter += 1)}`)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'walgit@example.test')
  git(dir, 'config', 'user.name', 'walgit')
  for (let i = 0; i < commits; i += 1) {
    fs.writeFileSync(path.join(dir, 'README'), `commit ${i}\n`)
    git(dir, 'add', 'README')
    git(dir, 'commit', '--quiet', '-m', `commit ${i}`)
  }
  return { dir, head: git(dir, 'rev-parse', 'HEAD').trim(), pack: packOf(dir) }
}

/** Every object reachable from every ref, as one packfile. */
function packOf(dir: string, rev = '--all'): Uint8Array {
  const objects = spawnSync('git', ['rev-list', '--objects', rev], { cwd: dir, encoding: 'utf8' })
  const pack = spawnSync('git', ['pack-objects', '--stdout', '-q'], {
    cwd: dir,
    input: objects.stdout,
    maxBuffer: 1 << 28,
  })
  if (pack.status !== 0) throw new Error(`pack-objects: ${pack.stderr?.toString()}`)
  return new Uint8Array(pack.stdout)
}

/** Upload `pack` as WAL entry `seq` and return the entry it should be indexed as. */
async function upload(repoId: string, seq: number, pack: Uint8Array): Promise<WalEntry> {
  const id = ulid(Date.now())
  const key = walKey(repoId, seq, id, 'pack')
  await store.put(key, pack)
  return { seq, key, kind: 'push', size: pack.byteLength, sha256: sha256(pack), ts: new Date().toISOString() }
}

async function publish(index: WalIndex): Promise<void> {
  const existing = await store.get(`repos/${index.repo_id}/index.json`)
  await commitIndex(store, index, existing?.etag ?? null)
}

const newRepo = () => resolveRepo(reposDir, `repo-${(counter += 1)}`)

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-work-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-store-'))
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-repos-'))
  store = new FileStore(storeDir)
  process.env.WALGIT_QUIET = '1'
})

afterAll(() => {
  for (const dir of [scratch, storeDir, reposDir]) fs.rmSync(dir, { recursive: true, force: true })
})

describe('neededEntries', () => {
  test('drops everything at or below the compaction frontier', () => {
    const index: WalIndex = {
      ...emptyIndex('r'),
      seq: 4,
      compaction_frontier: 2,
      entries: [1, 2, 3, 4].map((seq) => ({ seq, key: `k${seq}`, kind: 'push', size: 0, sha256: '', ts: '' })),
    }
    expect(neededEntries(index).map((e) => e.seq)).toEqual([3, 4])
  })

  test('returns entries in seq order regardless of how they are stored', () => {
    const index: WalIndex = {
      ...emptyIndex('r'),
      entries: [3, 1, 2].map((seq) => ({ seq, key: `k${seq}`, kind: 'push', size: 0, sha256: '', ts: '' })),
    }
    expect(neededEntries(index).map((e) => e.seq)).toEqual([1, 2, 3])
  })
})

describe('materialize', () => {
  test('rebuilds a repo from an empty disk', async () => {
    const src = sourceRepo(3)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    const result = await materialize(store, repo)

    expect(result.stats.fetched).toBe(1)
    expect(result.reconciled.missing).toEqual([])
    expect(localRefs(repo.dir)).toEqual({ 'refs/heads/main': src.head })
    // The whole point: the objects are really here, not just the ref.
    expect(git(repo.dir, '--git-dir', repo.dir, 'rev-list', '--count', 'refs/heads/main').trim()).toBe('3')
  })

  test('places the uploaded .idx rather than rebuilding it', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    // A real push uploads the idx beside the pack; give it a recognisable one.
    const idxKey = entry.key.replace(/\.pack$/, '.idx')
    const staged = path.join(scratch, `idx-${counter}`)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(path.join(staged, 'p.pack'), src.pack)
    git(staged, 'index-pack', 'p.pack')
    const idxBody = new Uint8Array(fs.readFileSync(path.join(staged, 'p.idx')))
    await store.put(idxKey, idxBody)

    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })
    await materialize(store, repo)

    const placed = path.join(repo.dir, 'objects', 'pack', `${packBasename(entry)}.idx`)
    expect(new Uint8Array(fs.readFileSync(placed))).toEqual(idxBody)
  })

  test('never requests an entry at or below the frontier', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const superseded: WalEntry = {
      seq: 1,
      // The key does not exist in the store at all: requesting it would throw.
      key: `repos/${repo.repoId}/wal/000000000001-GONE.pack`,
      kind: 'push',
      size: 0,
      sha256: 'nope',
      ts: new Date().toISOString(),
    }
    const compaction = await upload(repo.repoId, 2, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 2,
      compaction_frontier: 1,
      entries: [superseded, { ...compaction, kind: 'compaction', supersedes_through: 1 }],
      refs: { 'refs/heads/main': src.head },
    })

    const result = await materialize(store, repo)
    expect(result.stats.fetched).toBe(1)
    expect(result.stats.superseded).toBe(1)
  })

  test('is idempotent — a second run downloads nothing', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    await materialize(store, repo)
    const second = await materialize(store, repo)
    expect(second.stats.fetched).toBe(0)
    expect(second.stats.skipped).toBe(1)
    expect(localRefs(repo.dir)).toEqual({ 'refs/heads/main': src.head })
  })

  test('refuses a corrupt entry instead of leaving a truncated repo', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    // Rewrite the object under the log's back — a truncated download.
    await store.put(entry.key, src.pack.slice(0, src.pack.byteLength - 32))
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    await expect(materialize(store, repo)).rejects.toThrow(/corrupt/)
    // And it says so on disk, so the next access re-materializes rather than
    // treating what is there as merely stale.
    expect(isPartial(repo.dir)).toBe(true)
  })

  test('a partial materialize is detectable and recoverable', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    await materialize(store, repo)
    fs.writeFileSync(markerPath(repo.dir), 'interrupted\n')
    expect(isPartial(repo.dir)).toBe(true)

    await materialize(store, repo)
    expect(isPartial(repo.dir)).toBe(false)
  })

  test('two concurrent materializes rebuild the repo once', async () => {
    const src = sourceRepo(3)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    const [a, b] = await Promise.all([materialize(store, repo), materialize(store, repo)])
    // One did the work; the other waited and found it done.
    expect(a.stats.fetched + b.stats.fetched).toBe(1)
    expect(a.stats.waited || b.stats.waited).toBe(true)
    expect(localRefs(repo.dir)).toEqual({ 'refs/heads/main': src.head })
  })

  test('points HEAD at a branch the log actually has', async () => {
    const src = sourceRepo(2)
    git(src.dir, 'branch', '-m', 'main', 'trunk')
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, packOf(src.dir))
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/trunk': src.head },
    })

    await materialize(store, repo)
    expect(fs.readFileSync(path.join(repo.dir, 'HEAD'), 'utf8').trim()).toBe('ref: refs/heads/trunk')
  })

  test('reports its own timings, separate from anything else', async () => {
    const src = sourceRepo(2)
    const repo = newRepo()
    const entry = await upload(repo.repoId, 1, src.pack)
    await publish({
      ...emptyIndex(repo.repoId),
      seq: 1,
      entries: [entry],
      refs: { 'refs/heads/main': src.head },
    })

    const { stats } = await materialize(store, repo)
    expect(stats.fetchMs).toBeGreaterThan(0)
    expect(stats.bytes).toBe(src.pack.byteLength)
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.initMs + stats.fetchMs + stats.refsMs)
  })
})
