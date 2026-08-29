/**
 * Cold materialize, end to end, against a repo built by a hundred real pushes.
 *
 * Nothing here is a double. The log is written by the real hooks git spawns on
 * a real `git push`; the repo is then deleted from disk exactly as a stopped
 * Fly machine deletes it, and rebuilt from that log alone. The claim under test
 * is the one the whole design rests on — that the disk is disposable — and it
 * is only true if a rebuilt repo is indistinguishable from the original to the
 * three things git uses to tell repos apart: its refs, its reachable history,
 * and `git fsck`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createHttpHandler } from './http'
import { runGitHttpBackend } from './git-backend'
import { materialize } from './materialize'
import { ensureBareRepo } from './cache'
import { resolveRepo } from './repo'
import { FileStore } from './store'
import { syncRepo } from './sync'
import { loadIndex } from './wal-index'

const TOKEN = 's3cret'
const BRANCHES = ['main', 'alpha', 'beta', 'gamma', 'delta']
const TAGS = ['v1', 'v2', 'v3']
const PUSHES = 100

let server: ReturnType<typeof Bun.serve>
let reposDir: string
let storeDir: string
let scratch: string
let store: FileStore
let origin: string
const repoId = 'century'

/** The reference: what the repo looked like before its disk was thrown away. */
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
  return { status, out, err, all: `${out}${err}` }
}

const bareDir = () => path.join(reposDir, `${repoId}.git`)

/** Sorted `oid ref` lines — `git rev-parse --all` plus the names it omits. */
function refsOf(gitDir: string): string {
  const res = spawnSync(
    'git',
    ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(refname)'],
    { encoding: 'utf8' },
  )
  return res.stdout.trim().split('\n').sort().join('\n')
}

/** Every commit reachable from every ref, in a stable order. */
function historyOf(gitDir: string): string {
  const res = spawnSync('git', ['--git-dir', gitDir, 'log', '--all', '--format=%H'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  return res.stdout.trim().split('\n').sort().join('\n')
}

function fsck(gitDir: string): { status: number; output: string } {
  // `--no-dangling`: a dangling object is a normal consequence of a WAL that
  // carries whole packs, not a defect, and it is not what this asserts.
  const res = spawnSync('git', ['--git-dir', gitDir, 'fsck', '--no-dangling', '--strict'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  return { status: res.status ?? 1, output: `${res.stdout}${res.stderr}` }
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-e2e-repos-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-e2e-store-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-mat-e2e-work-'))
  store = new FileStore(storeDir)
  process.env.WALGIT_STORE_DIR = storeDir
  process.env.WALGIT_QUIET = '1'
  // Pinned out of reach: this fixture exists to replay a HUNDRED WAL entries,
  // and the default threshold would compact them into one partway through —
  // correct behaviour, but it would leave nothing here to measure.
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

  // ── Build the repo the hard way: a hundred pushes, five branches, three tags
  const client = path.join(scratch, 'client')
  fs.mkdirSync(client, { recursive: true })
  await git(client, 'init', '--quiet', '--initial-branch=main')
  await git(client, 'config', 'user.email', 'walgit@example.test')
  await git(client, 'config', 'user.name', 'walgit')
  await git(client, 'remote', 'add', 'origin', origin)

  for (let i = 0; i < PUSHES; i += 1) {
    const branch = BRANCHES[i % BRANCHES.length]!
    // The first touch of each branch forks it from whatever main is now, so the
    // history is a real graph rather than five unrelated lines.
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

    if (i === 20) await pushTag(client, TAGS[0]!)
    if (i === 55) await pushTag(client, TAGS[1]!)
    if (i === 90) await pushTag(client, TAGS[2]!)
  }

  reference = { refs: refsOf(bareDir()), history: historyOf(bareDir()) }
}, 300_000)

async function pushTag(client: string, name: string): Promise<void> {
  await git(client, 'tag', '-a', name, '-m', `tag ${name}`)
  const res = await git(client, 'push', '--quiet', 'origin', name)
  if (res.status !== 0) throw new Error(`tag push ${name} failed: ${res.all}`)
}

afterAll(() => {
  server?.stop(true)
  delete process.env.WALGIT_COMPACTION_THRESHOLD
  for (const dir of [reposDir, storeDir, scratch]) fs.rmSync(dir, { recursive: true, force: true })
})

test('the fixture really is a hundred pushes, five branches and three tags', async () => {
  const { index } = await loadIndex(store, repoId)
  const branches = Object.keys(index.refs).filter((r) => r.startsWith('refs/heads/'))
  const tags = Object.keys(index.refs).filter((r) => r.startsWith('refs/tags/'))
  expect(branches.sort()).toEqual(BRANCHES.map((b) => `refs/heads/${b}`).sort())
  expect(tags.sort()).toEqual(TAGS.map((t) => `refs/tags/${t}`).sort())
  // Each push and each tag published a WAL entry, and nothing else did.
  expect(index.entries.length).toBe(PUSHES + TAGS.length)
  expect(index.seq).toBe(PUSHES + TAGS.length)
})

test('a repo rebuilt from the log is indistinguishable from the original', async () => {
  fs.rmSync(bareDir(), { recursive: true, force: true })
  expect(fs.existsSync(bareDir())).toBe(false)

  const repo = resolveRepo(reposDir, repoId)
  const result = await materialize(store, repo)

  expect(result.reconciled.missing).toEqual([])
  expect(result.stats.fetched).toBe(PUSHES + TAGS.length)

  expect(refsOf(bareDir())).toBe(reference.refs)
  expect(historyOf(bareDir())).toBe(reference.history)

  const checked = fsck(bareDir())
  expect(checked.output).not.toMatch(/missing|broken|corrupt/i)
  expect(checked.status).toBe(0)

  // The number this milestone is measured by, isolated from machine wake.
  console.error(
    `walgit materialize fixture: ${result.stats.fetched} entries, ` +
      `${(result.stats.bytes / 1024).toFixed(0)} KiB, ` +
      `fetch ${result.stats.fetchMs.toFixed(0)}ms refs ${result.stats.refsMs.toFixed(0)}ms ` +
      `total ${result.stats.totalMs.toFixed(0)}ms`,
  )
}, 120_000)

test('a fetch against a repo that is not on disk materializes and serves', async () => {
  // A clone taken while the repo is warm, to compare against afterwards.
  const before = path.join(scratch, 'before')
  const cloned = await git(scratch, 'clone', '--quiet', '--mirror', origin, before)
  expect(cloned.status).toBe(0)

  // The machine stopped. Everything this node held is gone.
  fs.rmSync(bareDir(), { recursive: true, force: true })

  const after = path.join(scratch, 'after')
  const fresh = await git(scratch, 'clone', '--quiet', '--mirror', origin, after)
  expect(fresh.status).toBe(0)

  // The client cannot tell. That is the whole claim.
  expect(refsOf(after)).toBe(refsOf(before))
  expect(historyOf(after)).toBe(historyOf(before))

  // And an incremental fetch against the rebuilt node is a no-op, not a resync.
  const again = await git(after, 'fetch', '--prune', 'origin')
  expect(again.status).toBe(0)
  expect(refsOf(after)).toBe(refsOf(before))
}, 120_000)
