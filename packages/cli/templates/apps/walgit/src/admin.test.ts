/**
 * The admin routes over the real thing: a real handler with real hooks over a
 * file store, so a seeded create is shown to be an ordinary push — the clone
 * afterwards reads it back out of the log like any other.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { capabilitiesFrom } from '../shared/capabilities'
import {
  base64UrlEncode,
  mintScopedToken,
  scopedAccessOf,
  scopedEdgeAnswer,
  scopeTargetOf,
} from '../shared/scoped-token'
import { loadIndex } from '../shared/wal-index'
import { createAdminOps, MAX_SEED_BYTES, parseSeed } from './admin'
import { decideExpiry } from './expire'
import { ensureBareRepo } from './cache'
import { runGitHttpBackend } from './git-backend'
import { createHttpHandler } from './http'
import { FileStore } from './store'
import { syncRepo } from './sync'

const ADMIN = 'admin-s3cret'

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const PUBLIC_KEY = base64UrlEncode(
  new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
)
const now = Math.floor(Date.now() / 1000)
const scoped = (mode: 'read' | 'write', repo = 'seeded') =>
  mintScopedToken(pair.privateKey, { repo, mode, iat: now - 10, exp: now + 600 })

let server: ReturnType<typeof Bun.serve>
let scratch: string
let storeDir: string
let reposDir: string
let store: FileStore
let clock = new Date()

const run = async (cwd: string, ...args: string[]) => {
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

function handlerFor(tokens: string[], isPublic = false) {
  return createHttpHandler({
    reposDir,
    tokens,
    public: isPublic,
    scopedTokenKeys: PUBLIC_KEY,
    ensureRepo: ensureBareRepo,
    syncRepo: (repo) => syncRepo(store, repo),
    runBackend: runGitHttpBackend,
    capabilities: capabilitiesFrom(isPublic ? { WALGIT_PUBLIC: '1' } : {}),
    admin: createAdminOps({
      store,
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(store, repo),
      graceMs: 60_000,
      now: () => clock,
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
  server = Bun.serve({ port: 0, idleTimeout: 0, fetch: handlerFor([ADMIN]) })
})

afterAll(() => {
  server.stop(true)
  delete process.env.WALGIT_STORE_DIR
  for (const dir of [reposDir, scratch, storeDir]) fs.rmSync(dir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${server.port}`
const admin = (method: string, route: string, body?: unknown, credential: string | null = ADMIN) =>
  fetch(`${base()}/_walgit/admin/repos/${route}`, {
    method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })

const SEED = {
  files: { 'README.md': '# seeded\n', 'src/index.ts': 'export {}\n' },
  message: 'Initial commit',
  author: { name: 'Ada Example', email: 'ada@example.com' },
}

describe('create', () => {
  test('an empty create claims the name, and a second is a 409', async () => {
    const first = await admin('POST', 'empty')
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ repo: 'empty' })
    const { etag, index } = await loadIndex(store, 'empty')
    expect(etag).not.toBeNull()
    expect(index.refs).toEqual({})

    const again = await admin('POST', 'empty')
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('already exists')
  })

  test('a seeded create clones with the file, the message and the author', async () => {
    const res = await admin('POST', 'seeded', SEED)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { repo: string; commit: string; ref: string }
    expect(body.repo).toBe('seeded')
    expect(body.ref).toBe('refs/heads/main')
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/)

    // Published through the log, not only onto this node's disk.
    const { index } = await loadIndex(store, 'seeded')
    expect(index.refs['refs/heads/main']).toBe(body.commit)
    expect(index.entries).toHaveLength(1)

    const clone = path.join(scratch, 'seeded')
    const cloned = await run(
      scratch,
      'clone',
      `http://walgit:${ADMIN}@127.0.0.1:${server.port}/seeded.git`,
      clone,
    )
    expect(cloned.status).toBe(0)
    expect(fs.readFileSync(path.join(clone, 'README.md'), 'utf8')).toBe('# seeded\n')
    expect(fs.readFileSync(path.join(clone, 'src/index.ts'), 'utf8')).toBe('export {}\n')
    const log = await run(clone, 'log', '-1', '--format=%H|%s|%an|%ae')
    expect(log.out.trim()).toBe(`${body.commit}|Initial commit|Ada Example|ada@example.com`)

    const conflict = await admin('POST', 'seeded', SEED)
    expect(conflict.status).toBe(409)
  }, 30_000)

  test('a seed on another branch lands on that branch', async () => {
    const res = await admin('POST', 'on-trunk', { ...SEED, branch: 'trunk' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ref: string; commit: string }
    expect(body.ref).toBe('refs/heads/trunk')
    expect((await loadIndex(store, 'on-trunk')).index.refs).toEqual({
      'refs/heads/trunk': body.commit,
    })
  }, 30_000)

  test('a malformed seed is a 400 and creates nothing', async () => {
    for (const bad of [
      'not json',
      { files: {}, message: 'm', author: SEED.author },
      { files: { '../escape': 'x' }, message: 'm', author: SEED.author },
      { files: { '.git/hooks/pre-receive': 'x' }, message: 'm', author: SEED.author },
      { files: { a: 'x' }, message: '', author: SEED.author },
      { files: { a: 'x' }, message: 'm', author: { name: 'A <a>', email: 'a@example.com' } },
      { files: { a: 'x' }, message: 'm', author: SEED.author, branch: 'bad..name' },
    ]) {
      const res = await admin('POST', 'malformed', bad)
      expect(res.status).toBe(400)
    }
    expect((await loadIndex(store, 'malformed')).etag).toBeNull()
  })

  test('a name walgit would not serve is a 400', async () => {
    expect((await admin('POST', '-dash')).status).toBe(400)
  })
})

describe('usage', () => {
  test("a repository's usage is its Index, folded", async () => {
    const res = await admin('GET', 'seeded/usage')
    expect(res.status).toBe(200)
    const row = (await res.json()) as Record<string, unknown>
    expect(row).toMatchObject({ repoId: 'seeded', refs: 1, pushes: 1, entries: 1 })
    expect(row.bytes as number).toBeGreaterThan(0)
  })

  test('a name with no Index is a 404', async () => {
    expect((await admin('GET', 'never-made/usage')).status).toBe(404)
  })
})

describe('delete', () => {
  test('tombstones, retains inside the grace, then collects', async () => {
    expect((await admin('POST', 'doomed', SEED)).status).toBe(201)

    const first = await admin('DELETE', 'doomed')
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ repo: 'doomed', status: 'tombstoned' })

    const inside = await admin('DELETE', 'doomed')
    expect(await inside.json()).toMatchObject({ status: 'retained' })
    // Still a repository while it is leaving: a create of the name is a 409.
    expect((await admin('POST', 'doomed')).status).toBe(409)

    clock = new Date(clock.getTime() + 61_000)
    const collected = await admin('DELETE', 'doomed')
    expect(await collected.json()).toMatchObject({ status: 'collected' })
    expect((await loadIndex(store, 'doomed')).etag).toBeNull()
    expect((await admin('GET', 'doomed/usage')).status).toBe(404)
  }, 30_000)

  test('deleting a missing repository is harmless', async () => {
    const res = await admin('DELETE', 'never-made')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ repo: 'never-made', status: 'absent' })
  })
})

describe('who may call it', () => {
  test('no credential is a 401 with the Basic challenge, on every route', async () => {
    for (const [method, route] of [
      ['POST', 'auth-none'],
      ['DELETE', 'seeded'],
      ['GET', 'seeded/usage'],
    ] as const) {
      const res = await admin(method, route, undefined, null)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('Basic')
    }
  })

  test('a wrong credential is a 401', async () => {
    expect((await admin('GET', 'seeded/usage', undefined, 'not-it')).status).toBe(401)
  })

  test('a scoped token is a 403, whatever its mode or repository', async () => {
    for (const token of [
      await scoped('write'),
      await scoped('read'),
      await scoped('write', 'other'),
    ]) {
      for (const [method, route] of [
        ['POST', 'seeded'],
        ['DELETE', 'seeded'],
        ['GET', 'seeded/usage'],
      ] as const) {
        expect((await admin(method, route, undefined, token)).status).toBe(403)
      }
    }
    // And nothing was deleted by the attempts.
    expect((await loadIndex(store, 'seeded')).etag).not.toBeNull()
  })

  test('the admin credential over Basic, as git would send it, is accepted', async () => {
    const res = await fetch(`${base()}/_walgit/admin/repos/seeded/usage`, {
      headers: { authorization: `Basic ${btoa(`walgit:${ADMIN}`)}` },
    })
    expect(res.status).toBe(200)
  })

  test('with no admin credential configured the routes do not exist', async () => {
    const handler = handlerFor([], true)
    for (const [method, route] of [
      ['POST', 'public-made'],
      ['DELETE', 'seeded'],
      ['GET', 'seeded/usage'],
    ] as const) {
      const res = await handler(
        new Request(`https://walgit.test/_walgit/admin/repos/${route}`, { method }),
      )
      expect(res.status).toBe(404)
    }
  })

  test('a public deployment with an admin credential still demands it', async () => {
    const handler = handlerFor([ADMIN], true)
    const res = await handler(new Request('https://walgit.test/_walgit/admin/repos/seeded/usage'))
    expect(res.status).toBe(401)
  })
})

describe('parseSeed', () => {
  test('an empty body is an empty repository, and the branch defaults to main', () => {
    expect(parseSeed('')).toEqual({ ok: true, seed: null })
    const parsed = parseSeed(JSON.stringify(SEED))
    expect(parsed.ok && parsed.seed?.branch).toBe('main')
  })

  test('a path that is both a file and a directory is refused', () => {
    const parsed = parseSeed(JSON.stringify({ ...SEED, files: { a: '1', 'a/b': '2' } }))
    expect(parsed.ok).toBe(false)
  })
})

describe('what a seed may not do', () => {
  test('every spelling of .git is refused before anything is created', async () => {
    for (const name of ['.GIT/config', '.git./config', '.git /config', 'GIT~1/config', 'a/.Git']) {
      const res = await admin('POST', 'dotgit', { ...SEED, files: { [name]: 'x' } })
      expect(res.status).toBe(400)
    }
    expect((await loadIndex(store, 'dotgit')).etag).toBeNull()
  })

  test('a path that begins with a quote is carried verbatim, not unquoted', async () => {
    const name = '"\\056git/config"'
    const res = await admin('POST', 'quoted', { ...SEED, files: { [name]: 'kept\n' } })
    expect(res.status).toBe(201)
    const clone = path.join(scratch, 'quoted')
    expect(
      (
        await run(
          scratch,
          'clone',
          `http://walgit:${ADMIN}@127.0.0.1:${server.port}/quoted.git`,
          clone,
        )
      ).status,
    ).toBe(0)
    expect(fs.readFileSync(path.join(clone, name), 'utf8')).toBe('kept\n')
  }, 30_000)

  test('a body over the cap is a 413 and creates nothing', async () => {
    const res = await admin('POST', 'huge', {
      ...SEED,
      files: { big: 'x'.repeat(MAX_SEED_BYTES + 1) },
    })
    expect(res.status).toBe(413)
    expect((await loadIndex(store, 'huge')).etag).toBeNull()
  })

  test('a seed the hooks refuse is a 422 carrying their words, and leaves no repository', async () => {
    // Read by `pre-receive`, a grandchild of this process.
    process.env.WALGIT_MAX_PUSH_BYTES = '10'
    try {
      const res = await admin('POST', 'over-cap', {
        ...SEED,
        files: { 'big.txt': 'y'.repeat(5000) },
      })
      expect(res.status).toBe(422)
      const text = await res.text()
      expect(text).toContain('the seed push was refused')
      expect(text).not.toContain('walgit-seed-')
    } finally {
      delete process.env.WALGIT_MAX_PUSH_BYTES
    }
    expect((await loadIndex(store, 'over-cap')).etag).toBeNull()
    // So the same name can be asked for again once the body is fixed.
    expect((await admin('POST', 'over-cap', SEED)).status).toBe(201)
  }, 30_000)
})

describe('races and lifetimes', () => {
  test('of two creates racing for one name, exactly one wins', async () => {
    const answers = await Promise.all([admin('POST', 'raced', SEED), admin('POST', 'raced', SEED)])
    expect(answers.map((res) => res.status).toSorted()).toEqual([201, 409])
  }, 30_000)

  test('a 409 for a name being deleted says when it frees up', async () => {
    expect((await admin('POST', 'leaving')).status).toBe(201)
    expect((await admin('DELETE', 'leaving')).status).toBe(200)
    const res = await admin('POST', 'leaving')
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('is being deleted')
  })

  test('a repository created empty is dated by its creation, so expiry can collect it', async () => {
    const created = new Date(clock.getTime())
    expect((await admin('POST', 'idle-empty')).status).toBe(201)
    const { index } = await loadIndex(store, 'idle-empty')
    expect(index.created_at).toBe(created.toISOString())
    const later = new Date(created.getTime() + 2 * 3_600_000)
    expect(decideExpiry(index, { now: later, windowMs: 3_600_000 }).verdict).toBe('collect')
    expect(decideExpiry(index, { now: created, windowMs: 3_600_000 }).verdict).toBe('retain')
  })
})

describe('at the edge', () => {
  test('a scoped token on an admin route is refused 403 before the container wakes', async () => {
    const access = await scopedAccessOf(`Bearer ${await scoped('write')}`, {
      keys: PUBLIC_KEY,
      known: [ADMIN],
    })
    for (const [method, route] of [
      ['POST', '/_walgit/admin/repos/seeded'],
      ['DELETE', '/_walgit/admin/repos/seeded'],
      ['GET', '/_walgit/admin/repos/seeded/usage'],
    ] as const) {
      expect(scopeTargetOf(method, route, '')).toEqual({ kind: 'elsewhere' })
      expect(scopedEdgeAnswer(access, scopeTargetOf(method, route, ''))?.status).toBe(403)
    }
    // The admin token is not a scoped one, and passes through to the container.
    const adminAccess = await scopedAccessOf(`Bearer ${ADMIN}`, {
      keys: PUBLIC_KEY,
      known: [ADMIN],
    })
    expect(scopedEdgeAnswer(adminAccess, { kind: 'elsewhere' })).toBeNull()
  })
})
