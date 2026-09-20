/**
 * The browse endpoint the two web pages are rendered from.
 *
 * Tested at `createHttpHandler`, the seam the whole front door already lives
 * behind, for the reason `private-read.test.ts` is: the capability gate, the
 * deployment credential, the Private gate and the ordering that keeps a read
 * from CREATING a repository are one question, and only the real handler can be
 * asked it. Both readers are stubbed, so nothing here spawns git or touches a
 * disk — `ls-tree` itself is exercised against real git in the e2e suite.
 */
import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { BROWSE_PATH } from '../shared/protocol'
import { createHttpHandler, type BrowseReads, type HttpHandlerDeps } from './http'
import type { Commit, TreeEntry } from '../shared/browse'

const MAIN = 'a'.repeat(40)
const FEATURE = 'b'.repeat(40)
const TAG = 'c'.repeat(40)
const SIGNERS = 'd'.repeat(40)

const REFS = {
  'refs/heads/main': MAIN,
  'refs/heads/feature/x': FEATURE,
  'refs/tags/v1': TAG,
  'refs/walgit/signers': SIGNERS,
}

const ENTRIES: TreeEntry[] = [
  { name: 'src', kind: 'tree', oid: '1'.repeat(40), size: null },
  { name: 'README.md', kind: 'blob', oid: '2'.repeat(40), size: 42 },
]

const TEXT = new TextEncoder().encode('hello\nworld\n')

/** 51 commits, so a page of 50 is one short of the whole history. */
const COMMITS: Commit[] = Array.from({ length: 51 }, (_, i) => ({
  oid: i.toString(16).padStart(40, '0'),
  author: 'Ada <ada@example.test>',
  date: '2026-09-19T00:00:00Z',
  subject: `commit ${i}`,
}))

interface Wiring {
  refs?: Record<string, string> | null
  entries?: TreeEntry[] | null
  web?: boolean
  /** What `cat-file --batch-check` would say about the blob asked for. */
  blob?: { oid: string; size: number } | null
  /** The bytes behind it, when the handler decides to read them. */
  bytes?: Uint8Array
  commits?: Commit[] | null
  overrides?: Partial<HttpHandlerDeps>
}

/** What each stub was asked for, so the ORDERING can be asserted, not guessed. */
interface Asked {
  created: string[]
  synced: string[]
  trees: { rev: string; path: string }[]
  blobs: { rev: string; path: string }[]
  reads: { rev: string; path: string }[]
  logs: { rev: string; before: string | null; limit: number }[]
}

function deployment(wiring: Wiring = {}): {
  ask: (query: string) => Promise<Response>
  asked: Asked
} {
  const asked: Asked = { created: [], synced: [], trees: [], blobs: [], reads: [], logs: [] }
  const browse: BrowseReads = {
    readIndex: async () =>
      wiring.refs === null
        ? null
        : { refs: wiring.refs ?? REFS, lastPush: '2026-09-19T00:00:00.000Z' },
    listTree: async (repo, rev, path) => {
      asked.trees.push({ rev, path })
      void repo
      return wiring.entries === undefined ? ENTRIES : wiring.entries
    },
    statBlob: async (_repo, rev, path) => {
      asked.blobs.push({ rev, path })
      return wiring.blob === undefined
        ? { oid: '2'.repeat(40), size: TEXT.byteLength }
        : wiring.blob
    },
    readBlob: async (_repo, rev, path) => {
      asked.reads.push({ rev, path })
      return wiring.bytes ?? TEXT
    },
    listCommits: async (_repo, rev, before, limit) => {
      asked.logs.push({ rev, before, limit })
      return wiring.commits === undefined ? COMMITS.slice(0, limit) : wiring.commits
    },
  }
  const env: CapabilityEnv = wiring.web === false ? {} : { WALGIT_WEB: '1' }
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens: [],
    public: true,
    capabilities: capabilitiesFrom(env),
    ensureRepo: (repo) => {
      asked.created.push(repo.repoId)
      return repo
    },
    syncRepo: async (repo) => {
      asked.synced.push(repo.repoId)
    },
    runBackend: async () => new Response('backend ran'),
    browse,
    ...wiring.overrides,
  })
  return {
    ask: (query) => handler(new Request(`https://walgit.test${BROWSE_PATH}${query}`)),
    asked,
  }
}

const body = async (res: Response) => JSON.parse(await res.text())

describe('GET /_walgit/browse', () => {
  test('does not exist when WALGIT_WEB is off', async () => {
    const res = await deployment({ web: false }).ask('?repo=alpha&op=refs')
    expect(res.status).toBe(404)
  })

  test('names the refs the Index holds, and the default branch it implies', async () => {
    const res = await deployment().ask('?repo=alpha&op=refs')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      repo: 'alpha',
      defaultBranch: 'refs/heads/main',
      lastPush: '2026-09-19T00:00:00.000Z',
      refs: [
        { name: 'refs/heads/feature/x', oid: FEATURE },
        { name: 'refs/heads/main', oid: MAIN },
        { name: 'refs/tags/v1', oid: TAG },
        // `refs/walgit/*` is listed, and browsable: a Signer List is a tree
        // like any other, and hiding it would hide the one ref a reader most
        // often wants to check by hand.
        { name: 'refs/walgit/signers', oid: SIGNERS },
      ],
    })
  })

  test('reads the tree at the default branch when the URL names no ref', async () => {
    const { ask, asked } = deployment()
    const res = await ask('?repo=alpha&op=tree')
    expect(res.status).toBe(200)
    const answer = await body(res)
    expect(answer.ref).toBe('refs/heads/main')
    expect(answer.path).toBe('')
    expect(answer.entries).toEqual(ENTRIES)
    // The Cache is reconciled against the Index before it is read, exactly as
    // a clone's is — a cold repository materializes and this request waits.
    expect(asked.created).toEqual(['alpha'])
    expect(asked.synced).toEqual(['alpha'])
    expect(asked.trees).toEqual([{ rev: MAIN, path: '' }])
  })

  test('a name the log has no Index for is 404, and nothing is created', async () => {
    // The rule a browse shares with a Ref-less Read: pushing is what brings a
    // name into existence, so reading one must not.
    const { ask, asked } = deployment({ refs: null })
    const res = await ask('?repo=alpha&op=tree')
    expect(res.status).toBe(404)
    expect(asked.created).toEqual([])
    expect(asked.synced).toEqual([])
  })

  test('an unroutable name is 404 before the Index is read', async () => {
    const res = await deployment().ask('?repo=..%2f..%2fetc&op=tree')
    expect(res.status).toBe(404)
  })

  test('is a read: a POST is not this document', async () => {
    const handler = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: [],
      public: true,
      capabilities: capabilitiesFrom({ WALGIT_WEB: '1' }),
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      browse: {
        readIndex: async () => ({ refs: REFS, lastPush: null }),
        listTree: async () => ENTRIES,
        statBlob: async () => null,
        readBlob: async () => null,
        listCommits: async () => [],
      },
    })
    const res = await handler(
      new Request(`https://walgit.test${BROWSE_PATH}?repo=alpha&op=refs`, { method: 'POST' }),
    )
    expect(res.status).toBe(404)
  })

  test('a deployment with no reader wired does not answer', async () => {
    const res = await deployment({ overrides: { browse: undefined } }).ask('?repo=alpha&op=refs')
    expect(res.status).toBe(404)
  })

  test('resolves a branch whose name contains a slash, by longest prefix', async () => {
    // `feature/x/src` is a ref and a path run together, and only the Index
    // knows where one ends: `feature` is not a ref here, `feature/x` is.
    const { ask, asked } = deployment()
    const res = await ask('?repo=alpha&op=tree&ref=feature%2Fx%2Fsrc%2Flib')
    expect(res.status).toBe(200)
    const answer = await body(res)
    expect(answer.ref).toBe('refs/heads/feature/x')
    expect(answer.path).toBe('src/lib')
    expect(asked.trees).toEqual([{ rev: FEATURE, path: 'src/lib' }])
  })

  test('where two refs are prefixes of each other, the longer one is the ref', async () => {
    // A repository holding both `feature/x` and `feature/x/deeper`: the URL
    // `/tree/feature/x/deeper` names the second branch's root, never the first
    // branch's `deeper` directory.
    const refs = { 'refs/heads/feature/x': FEATURE, 'refs/heads/feature/x/deeper': TAG }
    const { ask, asked } = deployment({ refs })
    const answer = await body(await ask('?repo=alpha&op=tree&ref=feature%2Fx%2Fdeeper'))
    expect(answer.ref).toBe('refs/heads/feature/x/deeper')
    expect(answer.path).toBe('')
    expect(asked.trees).toEqual([{ rev: TAG, path: '' }])
  })

  test('takes a tag or a branch with the prefix left off, and a full oid', async () => {
    const at = async (ref: string) =>
      (await body(await deployment().ask(`?repo=alpha&op=tree&ref=${encodeURIComponent(ref)}`))).ref
    expect(await at('v1')).toBe('refs/tags/v1')
    expect(await at('refs/tags/v1')).toBe('refs/tags/v1')
    expect(await at('main')).toBe('refs/heads/main')
    // `refs/walgit/*` is browsable: it is a tree like any other, and it is the
    // one ref a reader most often wants to check by hand.
    expect(await at('refs/walgit/signers')).toBe('refs/walgit/signers')
    // A full oid has no ref to name it by, so it stands for itself.
    expect(await at(MAIN)).toBe(MAIN)
  })

  test('a ref that is neither an Index key nor an oid is 404, and git is never asked', async () => {
    const { ask, asked } = deployment()
    // A name that is not in the Index, an abbreviated oid, and two rev-parse
    // expressions git would happily resolve. None of them is a ref.
    for (const ref of ['nope', MAIN.slice(0, 8), 'main%5E', 'HEAD']) {
      expect((await ask(`?repo=alpha&op=tree&ref=${ref}`)).status).toBe(404)
    }
    expect(asked.trees).toEqual([])
    expect(asked.created).toEqual([])
  })

  test('a ref or a path shaped like a git option is refused', async () => {
    const { ask, asked } = deployment()
    // A ref: refused as any unknown ref is, before anything is created.
    expect((await ask('?repo=alpha&op=tree&ref=--output%3D%2Ftmp%2Fx')).status).toBe(404)
    // A path: the ref resolves, so this is the refusal the path rule makes.
    for (const path of ['..', 'src/../../etc', '-p', 'src/-p']) {
      const res = await ask(`?repo=alpha&op=tree&ref=main&path=${encodeURIComponent(path)}`)
      // A 404 like every other refusal here: a rejected shape must not be
      // distinguishable from an absent directory.
      expect(res.status).toBe(404)
    }
    expect(asked.trees).toEqual([])
  })

  test('the default branch is main, else master, else the first branch by name', async () => {
    const head = async (refs: Record<string, string>) =>
      (await body(await deployment({ refs }).ask('?repo=alpha&op=refs'))).defaultBranch

    expect(await head({ 'refs/heads/master': MAIN, 'refs/heads/main': FEATURE })).toBe(
      'refs/heads/main',
    )
    expect(await head({ 'refs/heads/zeta': MAIN, 'refs/heads/master': FEATURE })).toBe(
      'refs/heads/master',
    )
    // First BY NAME, not by the order the Index happens to list them in.
    expect(await head({ 'refs/heads/zeta': MAIN, 'refs/heads/alpha': FEATURE })).toBe(
      'refs/heads/alpha',
    )
    // Tags and walgit refs are not branches, so this repository has no default.
    expect(await head({ 'refs/tags/v1': TAG, 'refs/walgit/signers': SIGNERS })).toBe(null)
  })

  test('a repository with no branch is a page with an empty tree, not a refusal', async () => {
    const { ask, asked } = deployment({ refs: { 'refs/tags/v1': TAG } })
    const res = await ask('?repo=alpha&op=tree')
    expect(res.status).toBe(200)
    const answer = await body(res)
    expect(answer.entries).toEqual([])
    expect(answer.ref).toBe('')
    expect(asked.created).toEqual([])
  })

  test('a path that is not a directory at that ref is 404', async () => {
    const res = await deployment({ entries: null }).ask('?repo=alpha&op=tree&ref=main&path=nope')
    expect(res.status).toBe(404)
  })

  test('refuses when the Cache cannot be reconciled against the log', async () => {
    const res = await deployment({
      overrides: {
        syncRepo: async () => {
          throw new Error('materialize failed')
        },
      },
    }).ask('?repo=alpha&op=tree')
    expect(res.status).toBe(503)
  })

  test('demands the deployment credential, like every other read of a repository', async () => {
    const handler = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      capabilities: capabilitiesFrom({ WALGIT_WEB: '1' }),
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      browse: {
        readIndex: async () => ({ refs: REFS, lastPush: null }),
        listTree: async () => ENTRIES,
        statBlob: async () => null,
        readBlob: async () => null,
        listCommits: async () => [],
      },
    })
    const url = `https://walgit.test${BROWSE_PATH}?repo=alpha&op=refs`
    expect((await handler(new Request(url))).status).toBe(401)
    expect(
      (await handler(new Request(url, { headers: { authorization: 'Bearer s3cret' } }))).status,
    ).toBe(200)
  })
})

describe('the README under a tree', () => {
  test('is carried with the root listing, so the page is one round trip', async () => {
    const { ask, asked } = deployment()
    const answer = await body(await ask('?repo=alpha&op=tree'))
    expect(answer.readme).toEqual({ name: 'README.md', text: 'hello\nworld\n' })
    expect(asked.reads).toEqual([{ rev: MAIN, path: 'README.md' }])
  })

  test("is the root repository's, never a directory's own", async () => {
    // A README in `src/` is a note about that directory, not a second front
    // page — so a directory listing carries none and reads nothing.
    const { ask, asked } = deployment()
    const answer = await body(await ask('?repo=alpha&op=tree&ref=main&path=src'))
    expect(answer.readme).toBeUndefined()
    expect(asked.reads).toEqual([])
  })

  test('takes the plain name before the suffixed ones, whatever the case', async () => {
    const entries: TreeEntry[] = [
      { name: 'readme.txt', kind: 'blob', oid: '3'.repeat(40), size: 10 },
      { name: 'ReadMe', kind: 'blob', oid: '4'.repeat(40), size: 10 },
      { name: 'README.md', kind: 'blob', oid: '5'.repeat(40), size: 10 },
    ]
    const answer = await body(await deployment({ entries }).ask('?repo=alpha&op=tree'))
    expect(answer.readme.name).toBe('ReadMe')
  })

  test('a directory called README is not one', async () => {
    const entries: TreeEntry[] = [{ name: 'README', kind: 'tree', oid: '3'.repeat(40), size: null }]
    const { ask, asked } = deployment({ entries })
    expect((await body(await ask('?repo=alpha&op=tree'))).readme).toBeUndefined()
    expect(asked.reads).toEqual([])
  })

  test('a binary or oversized README is not shown', async () => {
    const big: TreeEntry[] = [
      { name: 'README', kind: 'blob', oid: '3'.repeat(40), size: 1024 * 1024 + 1 },
    ]
    const oversized = deployment({ entries: big })
    expect((await body(await oversized.ask('?repo=alpha&op=tree'))).readme).toBeUndefined()
    expect(oversized.asked.reads).toEqual([])

    const binary = deployment({
      entries: [{ name: 'README', kind: 'blob', oid: '3'.repeat(40), size: 3 }],
      bytes: new Uint8Array([1, 0, 2]),
    })
    expect((await body(await binary.ask('?repo=alpha&op=tree'))).readme).toBeUndefined()
  })
})

describe('op=blob', () => {
  test('carries the file, its size and the ref it was read at', async () => {
    const { ask, asked } = deployment()
    const res = await ask('?repo=alpha&op=blob&ref=main&path=src%2Findex.ts')
    expect(res.status).toBe(200)
    const answer = await body(res)
    expect(answer.path).toBe('src/index.ts')
    expect(answer.ref).toBe('refs/heads/main')
    expect(answer.size).toBe(12)
    expect(answer.text).toBe('hello\nworld\n')
    expect(answer.binary).toBe(false)
    expect(answer.oversize).toBe(false)
    // The refs travel with it, so the page around the file is one round trip.
    expect(answer.defaultBranch).toBe('refs/heads/main')
    expect(asked.blobs).toEqual([{ rev: MAIN, path: 'src/index.ts' }])
  })

  test('above the cap the size is the whole answer, and the content is never read', async () => {
    const { ask, asked } = deployment({ blob: { oid: '2'.repeat(40), size: 1024 * 1024 + 1 } })
    const answer = await body(await ask('?repo=alpha&op=blob&ref=main&path=big.bin'))
    expect(answer.oversize).toBe(true)
    expect(answer.size).toBe(1024 * 1024 + 1)
    expect(answer.text).toBe(null)
    // The point of the cap: a file this big never reaches the container's
    // memory at all.
    expect(asked.reads).toEqual([])
  })

  test('a file exactly at the cap is served', async () => {
    const cap = 1024 * 1024
    const { ask, asked } = deployment({ blob: { oid: '2'.repeat(40), size: cap } })
    const answer = await body(await ask('?repo=alpha&op=blob&ref=main&path=edge.txt'))
    expect(answer.oversize).toBe(false)
    expect(asked.reads).toEqual([{ rev: MAIN, path: 'edge.txt' }])
  })

  test('a NUL byte is what makes it binary, and binary carries no text', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x00, 0x4e, 0x47])
    const { ask } = deployment({ blob: { oid: '2'.repeat(40), size: 5 }, bytes })
    const answer = await body(await ask('?repo=alpha&op=blob&ref=main&path=logo.png'))
    expect(answer.binary).toBe(true)
    expect(answer.text).toBe(null)
    expect(answer.size).toBe(5)
  })

  test('a path that is not a blob at that ref is 404', async () => {
    const res = await deployment({ blob: null }).ask('?repo=alpha&op=blob&ref=main&path=src')
    expect(res.status).toBe(404)
  })

  test('an empty file is an empty page, not an absence', async () => {
    const { ask } = deployment({
      blob: { oid: '2'.repeat(40), size: 0 },
      bytes: new Uint8Array(),
    })
    const res = await ask('?repo=alpha&op=blob&ref=main&path=empty')
    expect(res.status).toBe(200)
    expect((await body(res)).text).toBe('')
  })
})

describe('op=raw', () => {
  const raw = (wiring: Wiring, query: string) => deployment(wiring).ask(query)

  test('text is plain text, and is told not to be sniffed', async () => {
    const res = await raw({}, '?repo=alpha&op=raw&ref=main&path=notes.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBe(null)
    expect(await res.text()).toBe('hello\nworld\n')
  })

  test('the type comes from the CONTENT, never from the name', async () => {
    // The whole security property: a pushed `index.html` served as HTML on the
    // host's own origin is a stored XSS against every other page walgit serves.
    const res = await raw({}, '?repo=alpha&op=raw&ref=main&path=index.html')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('binary is an attachment, and an opaque one', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x00, 0x4e, 0x47])
    const res = await raw(
      { blob: { oid: '2'.repeat(40), size: 5 }, bytes },
      '?repo=alpha&op=raw&ref=main&path=logo.png',
    )
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="logo.png"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  test('has no cap: raw is how a file too big to render is read', async () => {
    const { ask, asked } = deployment({ blob: { oid: '2'.repeat(40), size: 1024 * 1024 + 1 } })
    const res = await ask('?repo=alpha&op=raw&ref=main&path=big.txt')
    expect(res.status).toBe(200)
    expect(asked.reads).toEqual([{ rev: MAIN, path: 'big.txt' }])
  })

  test('a path that is not a blob is 404', async () => {
    expect((await raw({ blob: null }, '?repo=alpha&op=raw&ref=main&path=src')).status).toBe(404)
  })
})

describe('op=log', () => {
  test('is capped at 50, and says where the next page starts', async () => {
    const { ask, asked } = deployment()
    const answer = await body(await ask('?repo=alpha&op=log&ref=main'))
    expect(answer.commits).toHaveLength(50)
    expect(asked.logs).toEqual([{ rev: MAIN, before: null, limit: 50 }])
    // The cursor is the oid a reader would continue FROM — the last commit on
    // this page, which the next page starts at.
    expect(answer.next).toBe(COMMITS[49]!.oid)
  })

  test('a history shorter than a page has no next', async () => {
    const answer = await body(
      await deployment({ commits: COMMITS.slice(0, 3) }).ask('?repo=alpha&op=log&ref=main'),
    )
    expect(answer.commits).toHaveLength(3)
    expect(answer.next).toBe(null)
  })

  test('pages on a full oid', async () => {
    const { ask, asked } = deployment()
    const cursor = COMMITS[49]!.oid
    const res = await ask(`?repo=alpha&op=log&ref=main&before=${cursor}`)
    expect(res.status).toBe(200)
    expect(asked.logs).toEqual([{ rev: MAIN, before: cursor, limit: 50 }])
  })

  test('a malformed cursor is a 400, and git is never asked', async () => {
    const { ask, asked } = deployment()
    for (const cursor of ['nope', 'abc123', `${'a'.repeat(39)}z`, '--output=/tmp/x']) {
      const res = await ask(`?repo=alpha&op=log&ref=main&before=${encodeURIComponent(cursor)}`)
      expect(res.status).toBe(400)
    }
    expect(asked.logs).toEqual([])
  })

  test('a ref the Cache cannot walk is 404', async () => {
    expect((await deployment({ commits: null }).ask('?repo=alpha&op=log&ref=main')).status).toBe(
      404,
    )
  })
})
