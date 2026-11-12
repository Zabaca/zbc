/**
 * Host merges (docs/adr/0022) over the real thing: a real handler with real
 * hooks over a file store, so a merge is shown to be an ordinary push — the
 * Index moves under the publish's compare-and-swap, and a clone afterwards
 * reads the result back like any other commit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { MERGE_PATH } from '../shared/protocol'
import { base64UrlEncode, mintScopedToken } from '../shared/scoped-token'
import { loadIndex } from '../shared/wal-index'
import { ensureBareRepo } from './cache'
import { runGitHttpBackend } from './git-backend'
import { createHttpHandler } from './http'
import { createMergeOps, parseMergeRequest } from './merge'
import { FileStore } from './store'
import { syncRepo } from './sync'
import { commitIndex } from './wal-index'

const ADMIN = 'admin-s3cret'

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const PUBLIC_KEY = base64UrlEncode(
  new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
)
const now = Math.floor(Date.now() / 1000)
const scoped = (mode: 'read' | 'write', repo: string) =>
  mintScopedToken(pair.privateKey, { repo, mode, iat: now - 10, exp: now + 600 })

const AUTHOR = { name: 'Ada Example', email: 'ada@example.com' }

let server: ReturnType<typeof Bun.serve>
let off: ReturnType<typeof Bun.serve>
let scratch: string
let storeDir: string
let reposDir: string
let store: FileStore

const run = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out}${err}`)
  return out.trim()
}

function handlerFor(env: CapabilityEnv) {
  return createHttpHandler({
    reposDir,
    tokens: [ADMIN],
    public: false,
    scopedTokenKeys: PUBLIC_KEY,
    ensureRepo: ensureBareRepo,
    syncRepo: (repo) => syncRepo(store, repo),
    runBackend: runGitHttpBackend,
    capabilities: capabilitiesFrom(env),
    merge: createMergeOps({
      store,
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(store, repo),
      signerLists: true,
    }),
  })
}

beforeAll(() => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-repos-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-work-'))
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-store-'))
  store = new FileStore(storeDir)
  // The hooks are children of git, a child of this process: this is theirs.
  process.env.WALGIT_STORE_DIR = storeDir
  server = Bun.serve({ port: 0, idleTimeout: 0, fetch: handlerFor({ WALGIT_MERGE: '1' }) })
  off = Bun.serve({ port: 0, idleTimeout: 0, fetch: handlerFor({}) })
})

afterAll(() => {
  server.stop(true)
  off.stop(true)
  delete process.env.WALGIT_STORE_DIR
  for (const dir of [reposDir, scratch, storeDir]) fs.rmSync(dir, { recursive: true, force: true })
})

const remote = (name: string) => `http://walgit:${ADMIN}@127.0.0.1:${server.port}/${name}.git`

/**
 * A repository with `main` and `feature`, pushed over HTTP like any client's.
 * `feature` branches from `main`'s first commit; `diverge` adds a commit to
 * `main` after it, so a fast-forward is no longer possible.
 */
async function makeRepo(
  name: string,
  opts: { diverge?: 'clean' | 'conflict' } = {},
): Promise<{ work: string; main: string; feature: string }> {
  const work = path.join(scratch, `${name}-work`)
  fs.mkdirSync(work)
  await run(work, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(work, 'README.md'), '# base\n')
  fs.writeFileSync(path.join(work, 'shared.txt'), 'one\ntwo\nthree\n')
  await run(work, 'add', '.')
  await run(work, 'commit', '-qm', 'base')
  await run(work, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(work, 'feature.txt'), 'new work\n')
  fs.writeFileSync(path.join(work, 'shared.txt'), 'one\nTWO\nthree\n')
  await run(work, 'add', '.')
  await run(work, 'commit', '-qm', 'feature work')
  await run(work, 'checkout', '-q', 'main')
  if (opts.diverge === 'clean') {
    fs.writeFileSync(path.join(work, 'main.txt'), 'main moved on\n')
    await run(work, 'add', '.')
    await run(work, 'commit', '-qm', 'main moves on')
  } else if (opts.diverge === 'conflict') {
    fs.writeFileSync(path.join(work, 'shared.txt'), 'one\ndeux\nthree\n')
    await run(work, 'add', '.')
    await run(work, 'commit', '-qm', 'main edits the same line')
  }
  await run(work, 'push', '-q', remote(name), 'main', 'feature')
  return {
    work,
    main: await run(work, 'rev-parse', 'main'),
    feature: await run(work, 'rev-parse', 'feature'),
  }
}

const merge = (
  name: string,
  body: unknown,
  credential: string | null = ADMIN,
  port = server.port,
) =>
  fetch(`http://127.0.0.1:${port}${MERGE_PATH}?repo=${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

type Merged = {
  repo: string
  method: string
  commit: string
  source: { ref: string; oid: string }
  target: { ref: string; previous: string; oid: string }
  files: { path: string; status: string }[]
  totals: { files: number }
}

describe('fast-forward', () => {
  test('moves the target to the source, through the log', async () => {
    const { main, feature } = await makeRepo('ff')
    const res = await merge('ff', {
      source: 'feature',
      target: 'main',
      method: 'fast-forward',
      expected: main,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Merged
    expect(body.commit).toBe(feature)
    expect(body.target).toEqual({ ref: 'refs/heads/main', previous: main, oid: feature })
    expect(body.source).toEqual({ ref: 'refs/heads/feature', oid: feature })
    expect(body.files.map((file) => [file.path, file.status])).toEqual([
      ['feature.txt', 'added'],
      ['shared.txt', 'modified'],
    ])
    expect((await loadIndex(store, 'ff')).index.refs['refs/heads/main']).toBe(feature)
  }, 30_000)

  test('refuses a target that is not an ancestor of the source, and writes nothing', async () => {
    const { main } = await makeRepo('non-ff', { diverge: 'clean' })
    const before = await loadIndex(store, 'non-ff')
    const res = await merge('non-ff', {
      source: 'feature',
      target: 'main',
      method: 'fast-forward',
      expected: main,
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('not-fast-forward')
    expect((await loadIndex(store, 'non-ff')).etag).toBe(before.etag)
  }, 30_000)
})

describe('squash', () => {
  test('one commit whose parent is the target and whose tree is the three-way merge', async () => {
    const { main } = await makeRepo('squash', { diverge: 'clean' })
    const res = await merge('squash', {
      source: 'feature',
      target: 'main',
      method: 'squash',
      expected: main,
      message: 'Land the feature',
      author: AUTHOR,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Merged
    expect(body.target.previous).toBe(main)
    expect(body.target.oid).toBe(body.commit)
    expect(body.files.map((file) => file.path).toSorted()).toEqual(['feature.txt', 'shared.txt'])
    expect((await loadIndex(store, 'squash')).index.refs['refs/heads/main']).toBe(body.commit)

    const clone = path.join(scratch, 'squash-clone')
    await run(scratch, 'clone', '-q', remote('squash'), clone)
    expect(await run(clone, 'rev-parse', 'HEAD')).toBe(body.commit)
    // Exactly one parent, and it is the target as it was.
    expect(await run(clone, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(
      `${body.commit} ${main}`,
    )
    expect(await run(clone, 'log', '-1', '--format=%s|%an|%ae|%cn')).toBe(
      'Land the feature|Ada Example|ada@example.com|Ada Example',
    )
    expect((await run(clone, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n')).toEqual([
      'README.md',
      'feature.txt',
      'main.txt',
      'shared.txt',
    ])
    expect(fs.readFileSync(path.join(clone, 'shared.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(fs.readFileSync(path.join(clone, 'main.txt'), 'utf8')).toBe('main moved on\n')
  }, 30_000)

  test('a conflict is a 409 naming the paths, and nothing is written', async () => {
    const { main } = await makeRepo('conflict', { diverge: 'conflict' })
    const before = await loadIndex(store, 'conflict')
    const res = await merge('conflict', {
      source: 'feature',
      target: 'main',
      method: 'squash',
      expected: main,
      message: 'Land the feature',
      author: AUTHOR,
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; conflicts: string[] }
    expect(body.error).toBe('conflict')
    expect(body.conflicts).toEqual(['shared.txt'])
    expect((await loadIndex(store, 'conflict')).etag).toBe(before.etag)
  }, 30_000)
})

describe('the compare-and-swap', () => {
  test('a stale expected id is a 409 and nothing is written', async () => {
    const { feature, main } = await makeRepo('stale')
    const before = await loadIndex(store, 'stale')
    for (const method of ['fast-forward', 'squash'] as const) {
      const res = await merge('stale', {
        source: 'feature',
        target: 'main',
        method,
        expected: feature,
        message: 'm',
        author: AUTHOR,
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; actual: string; expected: string }
      expect(body).toMatchObject({ error: 'stale', actual: main, expected: feature })
    }
    const after = await loadIndex(store, 'stale')
    expect(after.etag).toBe(before.etag)
    expect(after.index.refs['refs/heads/main']).toBe(main)
  }, 30_000)

  test('a target moved after the Index was checked is refused by the push itself', async () => {
    // The up-front check passes; then another push lands before this merge's
    // own push does. What refuses it must be the lease and the publish's
    // compare-and-swap, not the check that already said yes.
    //
    // The interloper moves `main` to a commit that is STILL an ancestor of the
    // source, so the fast-forward would succeed if nothing held the lease — a
    // plain non-fast-forward refusal cannot be what catches it.
    const { main, work } = await makeRepo('in-flight')
    await run(work, 'checkout', '-q', 'feature')
    fs.writeFileSync(path.join(work, 'more.txt'), 'a second feature commit\n')
    await run(work, 'add', '.')
    await run(work, 'commit', '-qm', 'more feature work')
    await run(work, 'push', '-q', remote('in-flight'), 'feature')
    const interloper = await run(work, 'rev-parse', 'feature~1')

    let moved = false
    const ops = createMergeOps({
      store,
      ensureRepo: ensureBareRepo,
      syncRepo: async (repo) => {
        if (!moved) {
          moved = true
          await run(work, 'push', '-q', remote('in-flight'), 'feature~1:refs/heads/main')
        }
        return syncRepo(store, repo)
      },
      signerLists: false,
    })
    const result = await ops.merge(
      { repoId: 'in-flight', dir: path.join(reposDir, 'in-flight.git') },
      { source: 'feature', target: 'main', method: 'fast-forward', expected: main },
    )
    expect(moved).toBe(true)
    expect(result).toMatchObject({ kind: 'stale', expected: main, actual: interloper })
    expect((await loadIndex(store, 'in-flight')).index.refs['refs/heads/main']).toBe(interloper)
  }, 30_000)

  test('of two merges racing for one target, exactly one wins', async () => {
    const { main, work } = await makeRepo('race', { diverge: 'clean' })
    // A second branch, so the two squashes are two different commits.
    await run(work, 'checkout', '-qb', 'other', main)
    fs.writeFileSync(path.join(work, 'other.txt'), 'other work\n')
    await run(work, 'add', '.')
    await run(work, 'commit', '-qm', 'other work')
    await run(work, 'push', '-q', remote('race'), 'other')

    const squash = (source: string) =>
      merge('race', {
        source,
        target: 'main',
        method: 'squash',
        expected: main,
        message: `Land ${source}`,
        author: AUTHOR,
      })
    const results = await Promise.all([squash('feature'), squash('other')])
    const statuses = results.map((res) => res.status).toSorted()
    expect(statuses).toEqual([200, 409])

    const winner = (await results.find((res) => res.status === 200)!.json()) as Merged
    const loser = (await results.find((res) => res.status === 409)!.json()) as { error: string }
    expect(['stale', 'contended']).toContain(loser.error)
    const { index } = await loadIndex(store, 'race')
    expect(index.refs['refs/heads/main']).toBe(winner.commit)
  }, 60_000)
})

describe('a Signer List', () => {
  test('refuses a host merge with a message saying why, and nothing moves', async () => {
    const { main } = await makeRepo('claimed')
    const loaded = await loadIndex(store, 'claimed')
    const claimed = await commitIndex(
      store,
      {
        ...loaded.index,
        claim: { signers: ['SHA256:someListedKey'], ts: new Date().toISOString() },
      },
      loaded.etag,
    )
    expect(claimed.ok).toBe(true)

    const res = await merge('claimed', {
      source: 'feature',
      target: 'main',
      method: 'fast-forward',
      expected: main,
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('signed')
    expect(body.message).toContain('Signer List')
    expect((await loadIndex(store, 'claimed')).index.refs['refs/heads/main']).toBe(main)
  }, 30_000)
})

describe('who may merge', () => {
  let main: string
  const body = () => ({ source: 'feature', target: 'main', method: 'fast-forward', expected: main })

  beforeAll(async () => {
    main = (await makeRepo('authz')).main
  }, 30_000)

  test('no credential is a 401', async () => {
    expect((await merge('authz', body(), null)).status).toBe(401)
  })

  test('a read token for the repository is a 403', async () => {
    const res = await merge('authz', body(), await scoped('read', 'authz'))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('not push to it')
  })

  test("another repository's write token is a 403", async () => {
    const res = await merge('authz', body(), await scoped('write', 'elsewhere'))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('"elsewhere"')
  })

  test('nothing moved on any of those', async () => {
    expect((await loadIndex(store, 'authz')).index.refs['refs/heads/main']).toBe(main)
  })

  test("the repository's write token merges", async () => {
    const res = await merge('authz', body(), await scoped('write', 'authz'))
    expect(res.status).toBe(200)
  }, 30_000)
})

describe('with WALGIT_MERGE off', () => {
  test('the route does not exist', async () => {
    const { main } = await makeRepo('flag-off')
    const res = await merge(
      'flag-off',
      { source: 'feature', target: 'main', method: 'fast-forward', expected: main },
      ADMIN,
      off.port,
    )
    expect(res.status).toBe(404)
    expect((await loadIndex(store, 'flag-off')).index.refs['refs/heads/main']).toBe(main)
  }, 30_000)
})

describe('the request', () => {
  test('a malformed body is a 400 naming what is wrong', async () => {
    const oid = 'a'.repeat(40)
    for (const [bad, says] of [
      ['not json', 'not JSON'],
      [{ target: 'main', method: 'squash', expected: oid }, '"source"'],
      [{ source: 'f', target: 'main', method: 'rebase', expected: oid }, '"method"'],
      [{ source: 'f', target: 'main', method: 'fast-forward', expected: 'abc123' }, '"expected"'],
      [{ source: 'f', target: 'main', method: 'squash', expected: oid, author: AUTHOR }, 'message'],
      [{ source: 'f', target: 'main', method: 'squash', expected: oid, message: 'm' }, '"author"'],
    ] as const) {
      const parsed = parseMergeRequest(typeof bad === 'string' ? bad : JSON.stringify(bad))
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.message).toContain(says)
    }
    const res = await merge('authz', 'not json')
    expect(res.status).toBe(400)
  })

  test('a name nobody has pushed to is a 404 that creates nothing', async () => {
    const res = await merge('never-pushed', {
      source: 'feature',
      target: 'main',
      method: 'fast-forward',
      expected: 'a'.repeat(40),
    })
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(reposDir, 'never-pushed.git'))).toBe(false)
  })
})
