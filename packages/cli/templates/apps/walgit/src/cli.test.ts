/**
 * The operator CLI, driven the way an operator drives it: a real log in a real
 * store, a real git, and the exit code as the assertion.
 *
 * Exit codes are what these tests are actually about. `verify` is only useful if
 * a script can branch on it, so "does it print something red" is not the
 * property — "does it exit non-zero and name the ref" is.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { main, parseArgs } from './cli'
import { orphanAgeMs } from './gc'
import { sha256 } from './push'
import { FileStore } from './store'
import { ulid, ulidTime } from './ulid'
import { verifyRepo } from './verify'
import { commitIndex, emptyIndex, walKey, type WalEntry, type WalIndex } from './wal-index'

let scratch: string
let storeDir: string
let reposDir: string
let store: FileStore
let counter = 0
let env: NodeJS.ProcessEnv

let out: string[]
let logged: typeof console.log
let errored: typeof console.error

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

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
  const objects = spawnSync('git', ['rev-list', '--objects', '--all'], {
    cwd: dir,
    encoding: 'utf8',
  })
  const pack = spawnSync('git', ['pack-objects', '--stdout', '-q'], {
    cwd: dir,
    input: objects.stdout,
    maxBuffer: 1 << 28,
  })
  if (pack.status !== 0) throw new Error(`pack-objects: ${pack.stderr?.toString()}`)
  return { dir, head: git(dir, 'rev-parse', 'HEAD').trim(), pack: new Uint8Array(pack.stdout) }
}

async function publish(index: WalIndex): Promise<void> {
  const existing = await store.get(`repos/${index.repo_id}/index.json`)
  await commitIndex(store, index, existing?.etag ?? null)
}

/** A published repo of `commits` commits on main. Returns its id and head oid. */
async function published(commits = 2): Promise<{ repoId: string; head: string }> {
  const repoId = `repo-${(counter += 1)}`
  const src = sourceRepo(commits)
  const key = walKey(repoId, 1, ulid(Date.now()), 'pack')
  await store.put(key, src.pack)
  const entry: WalEntry = {
    seq: 1,
    key,
    kind: 'push',
    size: src.pack.byteLength,
    sha256: sha256(src.pack),
    ts: new Date().toISOString(),
  }
  await publish({
    ...emptyIndex(repoId),
    seq: 1,
    entries: [entry],
    refs: { 'refs/heads/main': src.head },
  })
  return { repoId, head: src.head }
}

beforeAll(() => {
  // `realpathSync` because macOS hands out /var/folders/... which is a symlink
  // to /private/var/..., and a path compared against one git resolved would not
  // match.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-cli-')))
  storeDir = path.join(scratch, 'store')
  reposDir = path.join(scratch, 'repos')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(reposDir, { recursive: true })
  store = new FileStore(storeDir)
  env = { WALGIT_STORE_DIR: storeDir, WALGIT_REPOS_DIR: reposDir, WALGIT_QUIET: '1' }
})

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

beforeEach(() => {
  out = []
  logged = console.log
  errored = console.error
  console.log = (...args: unknown[]) => void out.push(args.join(' '))
  console.error = (...args: unknown[]) => void out.push(args.join(' '))
})

afterEach(() => {
  console.log = logged
  console.error = errored
})

describe('parseArgs', () => {
  test('splits command, positionals and flags', () => {
    const args = parseArgs(['gc', 'alpha', 'beta', '--yes', '--min-age', '30', '--json'])
    expect(args.command).toBe('gc')
    expect(args.positional).toEqual(['alpha', 'beta'])
    expect(args.flags).toEqual({ yes: true, 'min-age': '30', json: true })
  })

  test('a valueless flag does not swallow the next positional', () => {
    // `gc alpha --yes beta` must collect two repos, not one repo named --yes.
    const args = parseArgs(['gc', 'alpha', '--yes', 'beta'])
    expect(args.positional).toEqual(['alpha', 'beta'])
    expect(args.flags.yes).toBe(true)
  })

  test('--flag=value', () => {
    expect(parseArgs(['verify', 'a', '--repos-dir=/tmp/r']).flags['repos-dir']).toBe('/tmp/r')
  })
})

describe('walgit materialize', () => {
  test('into an empty directory produces a repo a client can clone', async () => {
    const { repoId, head } = await published(3)
    const target = path.join(scratch, `out-${repoId}.git`)

    expect(await main(['materialize', repoId, target], env)).toBe(0)

    const clone = path.join(scratch, `clone-${repoId}`)
    git(scratch, 'clone', '--quiet', target, clone)
    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(clone, 'rev-list', '--count', 'HEAD').trim()).toBe('3')
  })

  test('without a path it materializes into the repos directory', async () => {
    const { repoId, head } = await published()
    expect(await main(['materialize', repoId], env)).toBe(0)
    const dir = path.join(reposDir, `${repoId}.git`)
    expect(git(dir, '--git-dir', dir, 'rev-parse', 'refs/heads/main').trim()).toBe(head)
  })

  test('a missing repo id is misuse, not a crash', async () => {
    expect(await main(['materialize'], env)).toBe(2)
  })
})

describe('walgit verify', () => {
  test('a freshly materialized repo agrees with the log', async () => {
    const { repoId } = await published()
    const target = path.join(scratch, `v-ok-${repoId}.git`)
    await main(['materialize', repoId, target], env)

    out = []
    expect(await main(['verify', repoId, target], env)).toBe(0)
    expect(out.join('\n')).toContain('OK')
  })

  test('exits non-zero and names the ref when local refs disagree with index.json', async () => {
    const { repoId, head } = await published()
    const target = path.join(scratch, `v-bad-${repoId}.git`)
    await main(['materialize', repoId, target], env)

    // Publish a branch the disk has never heard of, pointing at an object the
    // disk does have — so the disagreement is purely about refs.
    const { index } = await import('./wal-index').then((m) => m.loadIndex(store, repoId))
    await publish({ ...index, refs: { ...index.refs, 'refs/heads/release': head } })

    out = []
    expect(await main(['verify', repoId, target], env)).toBe(1)
    expect(out.join('\n')).toContain('refs/heads/release')

    const report = await verifyRepo(store, { repoId, dir: target })
    expect(report.ok).toBe(false)
    expect(report.diverged).toEqual([{ ref: 'refs/heads/release', local: null, log: head }])
    expect(report.missingObjects).toEqual([])
  })

  test('a locally-edited ref is reported against the log', async () => {
    const { repoId, head } = await published(3)
    const target = path.join(scratch, `v-local-${repoId}.git`)
    await main(['materialize', repoId, target], env)

    const parent = git(target, '--git-dir', target, 'rev-parse', `${head}^`).trim()
    git(target, '--git-dir', target, 'update-ref', 'refs/heads/main', parent)

    out = []
    expect(await main(['verify', repoId, target], env)).toBe(1)
    expect(out.join('\n')).toContain('DIVERGED refs/heads/main')
  })

  test('a repo that is not on this disk is reported as absent, not as divergence', async () => {
    const { repoId } = await published()
    const target = path.join(scratch, `v-cold-${repoId}.git`)
    expect(await main(['verify', repoId, target], env)).toBe(1)
    const report = await verifyRepo(store, { repoId, dir: target })
    expect(report.exists).toBe(false)
    expect(report.diverged).toEqual([])
  })
})

describe('walgit gc', () => {
  /** An orphan uploaded `ageMinutes` ago: a key under the WAL prefix nobody indexes. */
  async function orphan(repoId: string, seq: number, ageMinutes: number): Promise<string> {
    const key = walKey(repoId, seq, ulid(Date.now() - ageMinutes * 60_000), 'pack')
    await store.put(key, new Uint8Array([1, 2, 3]))
    return key
  }

  test('dry run lists what it would collect and deletes nothing', async () => {
    const { repoId } = await published()
    const key = await orphan(repoId, 99, 120)

    expect(await main(['gc', repoId], env)).toBe(0)
    expect(out.join('\n')).toContain(key)
    expect(out.join('\n')).toContain('re-run with --yes')
    expect(await store.get(key)).not.toBeNull()
  })

  test('--yes deletes the orphan and leaves the live entry alone', async () => {
    const { repoId } = await published()
    const key = await orphan(repoId, 99, 120)
    const live = (await import('./wal-index').then((m) => m.loadIndex(store, repoId))).index
      .entries[0]!.key

    expect(await main(['gc', repoId, '--yes'], env)).toBe(0)
    expect(await store.get(key)).toBeNull()
    expect(await store.get(live)).not.toBeNull()
  })

  test('an orphan younger than --min-age is kept, because a push may still be racing for it', async () => {
    const { repoId } = await published()
    const fresh = await orphan(repoId, 98, 1)

    expect(await main(['gc', repoId, '--yes'], env)).toBe(0)
    expect(await store.get(fresh)).not.toBeNull()
    expect(out.join('\n')).toContain('kept (too-young)')
  })

  test('gc with no repo id is misuse — there is no collect-everything mode', async () => {
    expect(await main(['gc'], env)).toBe(2)
  })
})

describe('object age from the key', () => {
  test('a ULID round-trips its timestamp', () => {
    const now = 1_760_000_000_000
    expect(ulidTime(ulid(now))).toBe(now)
  })

  test('a WAL key yields the age of its object', () => {
    const now = 1_760_000_000_000
    const key = walKey('alpha', 7, ulid(now - 90_000), 'pack')
    expect(orphanAgeMs(key, now)).toBe(90_000)
  })

  test('a key that does not carry a ULID has no age, so gc will not touch it', () => {
    expect(orphanAgeMs('repos/alpha/wal/hand-written.pack', Date.now())).toBeNull()
  })
})

describe('the command surface', () => {
  test('an unknown command is misuse and prints the usage', async () => {
    expect(await main(['frobnicate'], env)).toBe(2)
    expect(out.join('\n')).toContain('walgit serve')
  })

  test('--help succeeds', async () => {
    expect(await main(['--help'], env)).toBe(0)
  })

  test('compact reports the log it would compact and that it cannot yet', async () => {
    const { repoId } = await published()
    expect(await main(['compact', repoId], env)).toBe(2)
    expect(out.join('\n')).toContain('not implemented yet')
  })

  test('an unconfigured store fails with an explanation rather than a stack', async () => {
    expect(await main(['verify', 'alpha'], { WALGIT_REPOS_DIR: reposDir })).toBe(2)
    expect(out.join('\n')).toContain('no object store configured')
  })

  test('an invalid repo name is refused', async () => {
    expect(await main(['verify', '../etc'], env)).toBe(2)
    expect(out.join('\n')).toContain('invalid repository name')
  })
})
