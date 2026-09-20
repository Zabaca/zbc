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
import type { TreeEntry } from '../shared/browse'

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

interface Wiring {
  refs?: Record<string, string> | null
  entries?: TreeEntry[] | null
  web?: boolean
  overrides?: Partial<HttpHandlerDeps>
}

/** What each stub was asked for, so the ORDERING can be asserted, not guessed. */
interface Asked {
  created: string[]
  synced: string[]
  trees: { rev: string; path: string }[]
}

function deployment(wiring: Wiring = {}): {
  ask: (query: string) => Promise<Response>
  asked: Asked
} {
  const asked: Asked = { created: [], synced: [], trees: [] }
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
      },
    })
    const url = `https://walgit.test${BROWSE_PATH}?repo=alpha&op=refs`
    expect((await handler(new Request(url))).status).toBe(401)
    expect(
      (await handler(new Request(url, { headers: { authorization: 'Bearer s3cret' } }))).status,
    ).toBe(200)
  })
})
