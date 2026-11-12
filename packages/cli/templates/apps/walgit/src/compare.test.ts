/**
 * The compare: a branch's changes against its merge base, read off the Cache.
 *
 * Real git against a real repository, for the reason `browse.test.ts` runs real
 * git: the property under test is what `merge-base`, `diff --raw --numstat -z`
 * and `diff -M` actually print for an add, a delete, a rename and a binary
 * file. The handler is asked through `createHttpHandler`, the seam every gate
 * lives behind, with the real reader wired to the fixture — so the access
 * matrix is asked of the same code a deployment runs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  COMPARE_MAX_DIFF_BYTES,
  COMPARE_MAX_FILES,
  type BrowseCompareAnswer,
} from '../shared/browse'
import { capabilitiesFrom } from '../shared/capabilities'
import { BROWSE_PATH, READ_CHALLENGE_SCHEME } from '../shared/protocol'
import { base64UrlEncode, mintScopedToken, type ScopedClaims } from '../shared/scoped-token'
import { compareRevs } from './browse'
import { git, gitBounded } from './git'
import { createHttpHandler, type BrowseReads, type HttpHandlerDeps } from './http'

let work = ''
let gitDir = ''
const oids: Record<string, string> = {}

/** Enough lines that a one-line edit still reads as a rename, not a new file. */
const LONG = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff])

function commit(message: string): string {
  git(['-C', work, 'add', '-A'])
  git([
    '-C',
    work,
    '-c',
    'user.email=walgit@example.test',
    '-c',
    'user.name=walgit',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  ])
  return git(['rev-parse', 'HEAD'], { gitDir }).stdout.trim()
}

const write = (name: string, content: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true })
  fs.writeFileSync(path.join(work, name), content)
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-compare-'))
  gitDir = path.join(work, '.git')
  git(['init', '--quiet', '--initial-branch=main', work])
  write('README.md', 'fixture\n')
  write('edit.txt', 'one\ntwo\nthree\n')
  write('gone.txt', 'bye\n')
  write('old-name.txt', LONG)
  write('logo.png', PNG)
  oids.base = commit('base')

  git(['-C', work, 'checkout', '--quiet', '-b', 'feature/x'])
  write('edit.txt', 'one\nTWO\nthree\nfour\n')
  fs.rmSync(path.join(work, 'gone.txt'))
  fs.mkdirSync(path.join(work, 'src'))
  fs.renameSync(path.join(work, 'old-name.txt'), path.join(work, 'src/new-name.txt'))
  write('added.txt', 'hello\n')
  write('logo.png', Uint8Array.from([...PNG, 0x00, 0x42]))
  oids.feature = commit('feature')

  // main moves on after the branch was cut. Three-dot must not show this.
  git(['-C', work, 'checkout', '--quiet', 'main'])
  write('main-only.txt', 'later\n')
  oids.main = commit('main moves on')

  // From the base: a file replaced by a directory of the same name, a name
  // git has to quote, and one more file so a cap can fall between them.
  git(['-C', work, 'checkout', '--quiet', '-b', 'swap', oids.base!])
  fs.rmSync(path.join(work, 'gone.txt'))
  write('gone.txt/inner.txt', 'inside\n')
  write('tab\there.txt', 'tabbed\n')
  write('zzz.txt', 'last\n')
  oids.swap = commit('swap')
  git([
    '-C',
    work,
    '-c',
    'user.email=walgit@example.test',
    '-c',
    'user.name=walgit',
    'tag',
    '-a',
    '-m',
    'annotated',
    'v-feature',
    oids.feature!,
  ])
  oids.tag = git(['rev-parse', 'v-feature'], { gitDir }).stdout.trim()
  git(['-C', work, 'checkout', '--quiet', 'main'])

  // A history sharing nothing with either.
  git(['-C', work, 'checkout', '--quiet', '--orphan', 'island'])
  git(['-C', work, 'rm', '-rf', '--quiet', '.'])
  write('island.txt', 'alone\n')
  oids.island = commit('island')
  git(['-C', work, 'checkout', '--quiet', 'main'])
})

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

const LIMITS = {
  maxFiles: COMPARE_MAX_FILES,
  maxDiffBytes: COMPARE_MAX_DIFF_BYTES,
  timeoutMs: 10_000,
}

/** The comparison, or a failure naming what came back instead. */
function comparison(result: Awaited<ReturnType<typeof compareRevs>>) {
  if (result === null || typeof result === 'string')
    throw new Error(`expected a comparison, got ${result}`)
  return result
}

describe('compareRevs', () => {
  test('diffs the head against the merge base, not against the base', async () => {
    const result = comparison(await compareRevs(gitDir, oids.main!, oids.feature!, LIMITS))
    expect(result.mergeBase).toBe(oids.base!)
    expect(result.diff).not.toContain('main-only.txt')
    expect(result.files.map((file) => file.path)).not.toContain('main-only.txt')
    expect(result.truncated).toBe(false)
  })

  test('names an add, a modify, a delete, a rename and a binary change apart', async () => {
    const result = comparison(await compareRevs(gitDir, oids.main!, oids.feature!, LIMITS))
    const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]))
    expect(byPath['added.txt']).toEqual({
      path: 'added.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
      binary: false,
    })
    expect(byPath['edit.txt']).toEqual({
      path: 'edit.txt',
      status: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
    })
    expect(byPath['gone.txt']).toEqual({
      path: 'gone.txt',
      status: 'deleted',
      additions: 0,
      deletions: 1,
      binary: false,
    })
    expect(byPath['src/new-name.txt']).toEqual({
      path: 'src/new-name.txt',
      previousPath: 'old-name.txt',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      binary: false,
    })
    expect(byPath['logo.png']).toEqual({
      path: 'logo.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      binary: true,
    })
    expect(result.files).toHaveLength(5)
    expect(result.totals).toEqual({ files: 5, additions: 3, deletions: 2 })
  })

  test('the unified diff is git’s own, renames and binaries included', async () => {
    const result = comparison(await compareRevs(gitDir, oids.main!, oids.feature!, LIMITS))
    expect(result.diff).toContain('diff --git a/edit.txt b/edit.txt')
    expect(result.diff).toContain('-two\n+TWO\n')
    expect(result.diff).toContain('rename from old-name.txt\nrename to src/new-name.txt')
    expect(result.diff).toContain('Binary files a/logo.png and b/logo.png differ')
    expect(result.diff).toContain('deleted file mode')
  })

  test('the same ref on both sides is an empty comparison, not a refusal', async () => {
    const result = comparison(await compareRevs(gitDir, oids.feature!, oids.feature!, LIMITS))
    expect(result).toEqual({
      mergeBase: oids.feature!,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      diff: '',
      truncated: false,
      peeled: { base: oids.feature!, head: oids.feature! },
    })
  })

  test('the file cap lists and diffs only the first files, and still counts them all', async () => {
    const result = comparison(
      await compareRevs(gitDir, oids.main!, oids.feature!, {
        ...LIMITS,
        maxFiles: 2,
      }),
    )
    expect(result.truncated).toBe(true)
    expect(result.files).toHaveLength(2)
    expect(result.totals.files).toBe(5)
    const shown = result.diff.match(/^diff --git /gm) ?? []
    expect(shown).toHaveLength(2)
    for (const file of result.files) expect(result.diff).toContain(`b/${file.path}`)
  })

  test('the file cap keeps a listed rename paired', async () => {
    // Capped so the rename is the LAST file listed: its diff is only paired
    // when both of its paths are in the pathspec.
    const all = comparison(await compareRevs(gitDir, oids.main!, oids.feature!, LIMITS))
    const at = all.files.findIndex((file) => file.status === 'renamed')
    const capped = comparison(
      await compareRevs(gitDir, oids.main!, oids.feature!, {
        ...LIMITS,
        maxFiles: at + 1,
      }),
    )
    expect(capped.files[at]?.status).toBe('renamed')
    expect(capped.diff).toContain('rename from old-name.txt\nrename to src/new-name.txt')
  })

  test('the byte cap cuts the diff on a line boundary and says so', async () => {
    const result = comparison(
      await compareRevs(gitDir, oids.main!, oids.feature!, {
        ...LIMITS,
        maxDiffBytes: 200,
      }),
    )
    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(result.diff).byteLength).toBeLessThanOrEqual(200)
    expect(result.diff.endsWith('\n')).toBe(true)
    // The summary is not what was cut.
    expect(result.files).toHaveLength(5)
  })

  test('a capped diff carries only the listed files, not what a pathspec prefix drags in', async () => {
    const all = comparison(await compareRevs(gitDir, oids.base!, oids.swap!, LIMITS))
    expect(all.files.map((file) => file.path)).toEqual([
      'gone.txt',
      'gone.txt/inner.txt',
      'tab\there.txt',
      'zzz.txt',
    ])
    const one = comparison(
      await compareRevs(gitDir, oids.base!, oids.swap!, { ...LIMITS, maxFiles: 1 }),
    )
    expect(one.truncated).toBe(true)
    expect(one.diff).toContain('diff --git a/gone.txt b/gone.txt')
    expect(one.diff).not.toContain('inner.txt')
    // A name git quotes in the header is still recognised as listed.
    const three = comparison(
      await compareRevs(gitDir, oids.base!, oids.swap!, { ...LIMITS, maxFiles: 3 }),
    )
    expect(three.diff).toContain('diff --git "a/tab\\there.txt" "b/tab\\there.txt"')
    expect(three.diff).not.toContain('zzz.txt')
    expect(three.diff.match(/^diff --git /gm)).toHaveLength(3)
  })

  test('an annotated tag is peeled to the commit it names', async () => {
    const result = comparison(await compareRevs(gitDir, oids.main!, oids.tag!, LIMITS))
    expect(oids.tag).not.toBe(oids.feature)
    expect(result.peeled.head).toBe(oids.feature!)
    expect(result.mergeBase).toBe(oids.base!)
  })

  test('past the time budget git is killed, and says so', () => {
    // A command that outlives its budget, deterministically: an alias that
    // sleeps. The compare maps this outcome to `too-large`.
    const res = gitBounded(['-c', 'alias.slow=!sleep 5', 'slow'], { limit: 1024, timeoutMs: 100 })
    expect(res.outcome).toBe('timed-out')
  })

  test('only stdout overrunning is a truncation; stderr overrunning is a failure', () => {
    const out = gitBounded(['-c', 'alias.loud=!yes hello | head -c 100000', 'loud'], {
      limit: 1000,
      timeoutMs: 5000,
    })
    expect(out.outcome).toBe('overflowed')
    expect(out.stdout.byteLength).toBe(1000)
    const err = gitBounded(['-c', 'alias.noisy=!yes hello | head -c 100000 >&2', 'noisy'], {
      limit: 1000,
      timeoutMs: 5000,
    })
    expect(err.outcome).toBe('failed')
  })

  test('an oid the Cache does not hold is null', async () => {
    expect(await compareRevs(gitDir, 'f'.repeat(40), oids.feature!, LIMITS)).toBeNull()
    expect(await compareRevs(gitDir, oids.main!, 'f'.repeat(40), LIMITS)).toBeNull()
  })

  test('two histories with nothing in common are unrelated', async () => {
    expect(await compareRevs(gitDir, oids.main!, oids.island!, LIMITS)).toBe('unrelated')
  })
})

// ── At the front door ───────────────────────────────────────────────────────

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0)
const NOW = NOW_MS / 1000

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const PUBLIC_KEY = base64UrlEncode(
  new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
)
const token = (over: Partial<ScopedClaims> = {}) =>
  mintScopedToken(pair.privateKey, {
    repo: 'alpha',
    mode: 'read',
    iat: NOW - 10,
    exp: NOW + 600,
    ...over,
  })

function deployment(
  opts: { public?: boolean; web?: boolean; overrides?: Partial<HttpHandlerDeps> } = {},
) {
  const created: string[] = []
  const browse: BrowseReads = {
    readIndex: async (repoId) =>
      repoId === 'nobody'
        ? null
        : {
            refs: {
              'refs/heads/main': oids.main!,
              'refs/heads/feature/x': oids.feature!,
              'refs/heads/island': oids.island!,
              'refs/heads/swap': oids.swap!,
              'refs/tags/v-feature': oids.tag!,
            },
            lastPush: null,
          },
    listTree: async () => [],
    statBlob: async () => null,
    readBlob: async () => null,
    listCommits: async () => [],
    // The real reader, on the fixture, whatever repository was named.
    compare: (_repo, base, head, limits) => compareRevs(gitDir, base, head, limits),
  }
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens: opts.public === false ? ['admin-token'] : [],
    public: opts.public ?? true,
    capabilities: capabilitiesFrom(opts.web === false ? {} : { WALGIT_WEB: '1' }),
    scopedTokenKeys: PUBLIC_KEY,
    tokenNow: () => NOW_MS,
    ensureRepo: (repo) => {
      created.push(repo.repoId)
      return repo
    },
    runBackend: async () => new Response('backend ran'),
    browse,
    ...opts.overrides,
  })
  const ask = (query: string, init: { credential?: string; accept?: string } = {}) =>
    handler(
      new Request(`https://walgit.test${BROWSE_PATH}${query}`, {
        headers: {
          ...(init.credential ? { authorization: `Bearer ${init.credential}` } : {}),
          ...(init.accept ? { accept: init.accept } : {}),
        },
      }),
    )
  return { ask, created }
}

const COMPARE = '?repo=alpha&op=compare&base=main&head=feature/x'

describe('GET /_walgit/browse?op=compare', () => {
  test('answers the merge base, both refs, the files, the totals and the diff', async () => {
    const res = await deployment().ask(COMPARE)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const answer = (await res.json()) as BrowseCompareAnswer
    expect(answer.repo).toBe('alpha')
    expect(answer.base).toEqual({ ref: 'refs/heads/main', oid: oids.main! })
    expect(answer.head).toEqual({ ref: 'refs/heads/feature/x', oid: oids.feature! })
    expect(answer.mergeBase).toBe(oids.base!)
    expect(answer.totals).toEqual({ files: 5, additions: 3, deletions: 2 })
    expect(answer.files).toHaveLength(5)
    expect(answer.truncated).toBe(false)
    expect(answer.diff).toContain('diff --git a/edit.txt b/edit.txt')
  })

  test('takes full ref names and full oids, as every browse ref does', async () => {
    const res = await deployment().ask(
      `?repo=alpha&op=compare&base=refs/heads/main&head=${oids.feature!}`,
    )
    expect(res.status).toBe(200)
    const answer = (await res.json()) as BrowseCompareAnswer
    expect(answer.head).toEqual({ ref: oids.feature!, oid: oids.feature! })
    expect(answer.mergeBase).toBe(oids.base!)
  })

  test('the diff alone as text, by ?format=diff or by Accept', async () => {
    const { ask } = deployment()
    for (const res of [
      await ask(`${COMPARE}&format=diff`),
      await ask(COMPARE, { accept: 'text/x-diff' }),
      await ask(COMPARE, { accept: 'text/plain' }),
    ]) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-walgit-truncated')).toBe('false')
      expect(res.headers.get('x-walgit-merge-base')).toBe(oids.base!)
      const text = await res.text()
      expect(text.startsWith('diff --git ')).toBe(true)
    }
  })

  test('a capped diff says so in its header', async () => {
    const capped = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: [],
      public: true,
      capabilities: capabilitiesFrom({ WALGIT_WEB: '1' }),
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      browse: {
        readIndex: async () => ({ refs: { 'refs/heads/main': oids.main! }, lastPush: null }),
        listTree: async () => [],
        statBlob: async () => null,
        readBlob: async () => null,
        listCommits: async () => [],
        compare: (_repo, base, head, limits) =>
          compareRevs(gitDir, base, head, { ...limits, maxDiffBytes: 100 }),
      },
    })
    const res = await capped(
      new Request(
        `https://walgit.test${BROWSE_PATH}?repo=alpha&op=compare&base=main&head=${oids.feature!}&format=diff`,
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walgit-truncated')).toBe('true')
    expect(new TextEncoder().encode(await res.text()).byteLength).toBeLessThanOrEqual(100)
  })

  test('reports the commit a tag names, not the tag object', async () => {
    const res = await deployment().ask('?repo=alpha&op=compare&base=main&head=v-feature')
    const answer = (await res.json()) as BrowseCompareAnswer
    expect(answer.head).toEqual({ ref: 'refs/tags/v-feature', oid: oids.feature! })
  })

  test('a compare too large for its budget is a 503', async () => {
    const { ask } = deployment({
      overrides: {
        browse: {
          readIndex: async () => ({ refs: { 'refs/heads/main': oids.main! }, lastPush: null }),
          listTree: async () => [],
          statBlob: async () => null,
          readBlob: async () => null,
          listCommits: async () => [],
          compare: async () => 'too-large',
        },
      },
    })
    const res = await ask('?repo=alpha&op=compare&base=main&head=main')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('too large')
  })

  test('a client naming JSON, or anything, gets JSON', async () => {
    const { ask } = deployment()
    for (const accept of [
      '*/*',
      'application/json, text/plain, */*',
      'text/plain;q=0',
      'text/plain;q=0.5, application/json',
    ]) {
      const res = await ask(COMPARE, { accept })
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    }
  })

  test('an unknown ref is 404, and the Cache is never touched', async () => {
    const { ask, created } = deployment()
    expect((await ask('?repo=alpha&op=compare&base=main&head=nope')).status).toBe(404)
    expect((await ask('?repo=alpha&op=compare&base=nope&head=main')).status).toBe(404)
    expect((await ask('?repo=alpha&op=compare&base=main&head=--output=x')).status).toBe(404)
    expect(created).toEqual([])
  })

  test('a full oid the Cache does not hold is 404', async () => {
    const res = await deployment().ask(`?repo=alpha&op=compare&base=main&head=${'f'.repeat(40)}`)
    expect(res.status).toBe(404)
  })

  test('a name nobody has pushed to is 404, and nothing is created', async () => {
    const { ask, created } = deployment()
    expect((await ask('?repo=nobody&op=compare&base=main&head=main')).status).toBe(404)
    expect(created).toEqual([])
  })

  test('a compare that names no base or no head is a 400', async () => {
    const { ask } = deployment()
    expect((await ask('?repo=alpha&op=compare&head=main')).status).toBe(400)
    expect((await ask('?repo=alpha&op=compare&base=main')).status).toBe(400)
  })

  test('unrelated histories are a 400 that says why', async () => {
    const res = await deployment().ask('?repo=alpha&op=compare&base=main&head=island')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('share no history')
  })

  test('does not exist when WALGIT_WEB is off, like every browse read', async () => {
    expect((await deployment({ web: false }).ask(COMPARE)).status).toBe(404)
  })

  test('does not exist where no compare reader is wired', async () => {
    const { ask } = deployment({
      overrides: {
        browse: {
          readIndex: async () => ({ refs: { 'refs/heads/main': oids.main! }, lastPush: null }),
          listTree: async () => [],
          statBlob: async () => null,
          readBlob: async () => null,
          listCommits: async () => [],
        },
      },
    })
    expect((await ask('?repo=alpha&op=compare&base=main&head=main')).status).toBe(404)
  })
})

describe('who may compare', () => {
  test('a read or write token for the repository may', async () => {
    const { ask } = deployment({ public: false })
    for (const mode of ['read', 'write'] as const) {
      const res = await ask(COMPARE, { credential: await token({ mode }) })
      expect(res.status).toBe(200)
    }
  })

  test("another repository's token is a 403", async () => {
    const { ask } = deployment({ public: false })
    const res = await ask(COMPARE, { credential: await token({ repo: 'beta' }) })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('"beta", not "alpha"')
  })

  test('a token-gated deployment demands a credential; the admin token may', async () => {
    const { ask } = deployment({ public: false })
    expect((await ask(COMPARE)).status).toBe(401)
    expect((await ask(COMPARE, { credential: 'admin-token' })).status).toBe(200)
  })

  test('a public deployment serves anyone, with no token, as a browse would', async () => {
    expect((await deployment().ask(COMPARE)).status).toBe(200)
  })

  test('a Private repository is refused without access, before git is asked', async () => {
    const { ask, created } = deployment({
      overrides: {
        privateReads: {
          seed: 'private-seed',
          readClaim: async () => ({
            signers: ['SHA256:owner'],
            readers: [],
            ts: '2026-11-01T00:00:00Z',
          }),
          verifyRead: () => null,
          now: () => NOW_MS,
        },
      },
    })
    for (const credential of [undefined, await token()]) {
      const res = await ask(COMPARE, { credential })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain(READ_CHALLENGE_SCHEME)
    }
    expect(created).toEqual([])
  })
})
