/**
 * The repository list is answered at the edge, off the log, so rendering it is
 * pure — the module lives in `shared/` and is tested here with the rest of the
 * suite rather than behind a Workers runtime, the arrangement `landing.test.ts`
 * and `telemetry.test.ts` document.
 *
 * Fixtures are a `MemoryStore` holding real `index.json` objects, the way
 * `usage.test.ts` builds its own: the list's whole job is to fold Indexes into
 * rows, and a hand-written row fixture would be a test of the renderer against
 * a shape the log never produces.
 */

import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { indexKey } from '../shared/keys'
import {
  REPO_LIST_MAX_FACTS,
  REPO_LIST_PAGE_SIZE,
  repoListResponse,
  wantsRepoList,
  type RepoListRequest,
  type RepoRow,
} from '../shared/repo-list'
import { MemoryStore, type ObjectStore } from '../shared/store'
import { emptyIndex, type WalIndex } from '../shared/wal-index'

const caps = (env: CapabilityEnv) => capabilitiesFrom(env)
/** The shape this whole file assumes unless it is about the gate. */
const OPEN = caps({ WALGIT_WEB: '1', WALGIT_PUBLIC: '1' })
/** A deployment that asks for a token, with the view on. */
const GATED = caps({ WALGIT_WEB: '1' })
const TOKENS = ['s3cret']

const HTML: RepoListRequest = {
  method: 'GET',
  accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  authorization: null,
}
const JSON_REQ: RepoListRequest = { method: 'GET', accept: '*/*', authorization: null }

/** `Basic base64(walgit:<token>)` — the credential git and a browser both send. */
const basic = (token: string) => `Basic ${btoa(`walgit:${token}`)}`

interface RepoFixture {
  refs?: Record<string, string>
  /** One push entry per timestamp, each of this many bytes. */
  pushes?: { ts: string; size: number }[]
  /** Entries at or below this are compacted away — they are not live bytes. */
  frontier?: number
  claimed?: boolean
  readers?: string[]
  deletionPending?: boolean
}

function indexFor(repoId: string, fixture: RepoFixture): WalIndex {
  const index = emptyIndex(repoId)
  index.refs = fixture.refs ?? { 'refs/heads/main': 'a'.repeat(40) }
  index.entries = (fixture.pushes ?? []).map((push, i) => ({
    seq: i + 1,
    key: `repos/${repoId}/wal/${String(i + 1).padStart(12, '0')}-01J.pack`,
    kind: 'push' as const,
    size: push.size,
    sha256: 'x'.repeat(64),
    ts: push.ts,
  }))
  index.seq = index.entries.length
  index.compaction_frontier = fixture.frontier ?? 0
  if (fixture.claimed || fixture.readers) {
    index.claim = {
      signers: ['SHA256:aaa'],
      readers: fixture.readers,
      ts: '2026-09-01T00:00:00.000Z',
    }
  }
  if (fixture.deletionPending) {
    index.deletion = {
      requested_at: '2026-09-19T00:00:00.000Z',
      collect_after: '2026-09-20T00:00:00.000Z',
    }
  }
  return index
}

async function storeWith(repos: Record<string, RepoFixture>): Promise<MemoryStore> {
  const store = new MemoryStore()
  for (const [repoId, fixture] of Object.entries(repos)) {
    await store.put(
      indexKey(repoId),
      new TextEncoder().encode(JSON.stringify(indexFor(repoId, fixture))),
    )
  }
  return store
}

/** A store whose Index bytes are not an Index at all. */
async function storeWithBrokenIndex(repoId: string): Promise<MemoryStore> {
  const store = new MemoryStore()
  await store.put(indexKey(repoId), new TextEncoder().encode('{ this is not json'))
  return store
}

const list = (req: RepoListRequest, store: ObjectStore, deployment = OPEN) =>
  repoListResponse(req, { store, caps: deployment, tokens: TOKENS })

describe('wantsRepoList', () => {
  test('only the one path, and only a read', () => {
    expect(wantsRepoList('GET', '/repos')).toBe(true)
    expect(wantsRepoList('HEAD', '/repos')).toBe(true)
    expect(wantsRepoList('POST', '/repos')).toBe(false)
    expect(wantsRepoList('GET', '/repos/alpha')).toBe(false)
    expect(wantsRepoList('GET', '/')).toBe(false)
  })

  // The collision argument every edge-answered path carries: a repository is
  // reached at `/<name>.git/…`, so this route cannot shadow one.
  test('a repository called repos keeps its clone URL', () => {
    expect(wantsRepoList('GET', '/repos.git/info/refs')).toBe(false)
  })
})

describe('the gate', () => {
  /**
   * The same credential a read takes, checked with the same `authorizedBy` the
   * event socket uses — and answered BEFORE the store is touched, which is why
   * the fixture store throws on every operation.
   */
  const refusingStore: ObjectStore = {
    get: () => Promise.reject(new Error('the gate let a read through')),
    getIfNoneMatch: () => Promise.reject(new Error('the gate let a read through')),
    put: () => Promise.reject(new Error('the gate let a write through')),
    delete: () => Promise.reject(new Error('the gate let a write through')),
    list: () => Promise.reject(new Error('the gate let a read through')),
  }

  test('a credentialed deployment refuses a stranger with a challenge a browser can answer', async () => {
    const res = await list(HTML, refusingStore, GATED)
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Basic realm="walgit"')
    // A refusal is never cached: the next request carries a credential.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  test('a wrong token is refused the same way', async () => {
    const res = await list({ ...HTML, authorization: basic('wrong') }, refusingStore, GATED)
    expect(res.status).toBe(401)
  })

  test('a good token is served, and the answer is never shared at the edge', async () => {
    const store = await storeWith({ alpha: { pushes: [{ ts: '2026-09-19T00:00:00Z', size: 10 }] } })
    const res = await repoListResponse(
      { ...HTML, authorization: basic('s3cret') },
      { store, caps: GATED, tokens: TOKENS },
    )
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body).toContain('alpha')
  })

  test('a public deployment asks for nothing and lets the edge hold the page for a minute', async () => {
    const store = await storeWith({ alpha: {} })
    const res = await list(HTML, store)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=60')
    expect(res.headers['www-authenticate']).toBeUndefined()
  })
})

describe('the rows', () => {
  test('one row per name the log holds, newest push first', async () => {
    const store = await storeWith({
      middle: { pushes: [{ ts: '2026-09-10T00:00:00.000Z', size: 1 }] },
      oldest: { pushes: [{ ts: '2026-01-01T00:00:00.000Z', size: 1 }] },
      newest: { pushes: [{ ts: '2026-09-19T12:00:00.000Z', size: 1 }] },
    })
    const res = await list(JSON_REQ, store)
    const body = JSON.parse(res.body) as { repos: { name: string; lastPush: string | null }[] }
    expect(body.repos.map((r) => r.name)).toEqual(['newest', 'middle', 'oldest'])
    expect(body.repos[0]!.lastPush).toBe('2026-09-19T12:00:00.000Z')
  })

  /**
   * A repository whose Index holds no push entry at all — a ref-only push
   * appends none (`shared/wal-index.ts`) — has no last push to sort on. It is
   * sorted after every repository that does, and never dropped: no name the log
   * holds is omitted.
   */
  test('a name with no push entry sorts last and is still listed', async () => {
    const store = await storeWith({
      quiet: {},
      loud: { pushes: [{ ts: '2026-01-01T00:00:00.000Z', size: 1 }] },
    })
    const body = JSON.parse((await list(JSON_REQ, store)).body) as {
      repos: { name: string; lastPush: string | null }[]
    }
    expect(body.repos.map((r) => r.name)).toEqual(['loud', 'quiet'])
    expect(body.repos[1]!.lastPush).toBeNull()
  })

  test('the facts on a row are the ones the Index holds', async () => {
    const store = await storeWith({
      alpha: {
        refs: { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/topic': 'b'.repeat(40) },
        // Two entries, the first of them compacted away: live bytes are what a
        // restore would download, which is the second entry only.
        pushes: [
          { ts: '2026-09-01T00:00:00.000Z', size: 4096 },
          { ts: '2026-09-02T00:00:00.000Z', size: 1024 },
        ],
        frontier: 1,
      },
    })
    const body = JSON.parse((await list(JSON_REQ, store)).body) as { repos: RepoRow[] }
    expect(body.repos).toEqual([
      {
        name: 'alpha',
        lastPush: '2026-09-02T00:00:00.000Z',
        refs: 2,
        liveBytes: 1024,
        claimed: false,
        private: false,
        deletionPending: false,
      },
    ])
  })

  test('claimed, Private and deletion-pending are each marked', async () => {
    const store = await storeWith({
      claimed: { claimed: true },
      // A Reader List is what makes a name Private — its presence is the
      // switch, and `[]` is a value (`shared/wal-index.ts`).
      hidden: { readers: [] },
      leaving: { deletionPending: true },
      plain: {},
    })
    const body = JSON.parse((await list(JSON_REQ, store)).body) as {
      repos: { name: string; claimed: boolean; private: boolean; deletionPending: boolean }[]
    }
    const row = (name: string) => body.repos.find((r) => r.name === name)!
    expect(row('claimed')).toMatchObject({ claimed: true, private: false })
    expect(row('hidden')).toMatchObject({ claimed: true, private: true })
    expect(row('leaving')).toMatchObject({ deletionPending: true })
    expect(row('plain')).toMatchObject({ claimed: false, private: false, deletionPending: false })
  })

  test('a deployment holding nothing says so rather than rendering an empty table', async () => {
    const res = await list(HTML, new MemoryStore())
    expect(res.status).toBe(200)
    expect(res.body).toContain('No repositories yet')
  })

  test('an Index that cannot be read is the bare name, with no facts', async () => {
    const store = await storeWithBrokenIndex('broken')
    const body = JSON.parse((await list(JSON_REQ, store)).body) as { repos: RepoRow[] }
    expect(body.repos).toEqual([
      {
        name: 'broken',
        lastPush: null,
        refs: null,
        liveBytes: null,
        claimed: false,
        private: false,
        deletionPending: false,
        unreadable: true,
      },
    ])
  })
})

describe('pagination', () => {
  const NAMES = Array.from(
    { length: REPO_LIST_PAGE_SIZE + 30 },
    (_, i) =>
      // Zero-padded so name order is the order a human would write, and the
      // timestamps below run the other way so sorting is observable.
      `repo-${String(i).padStart(3, '0')}`,
  )

  const manyRepos = () =>
    storeWith(
      Object.fromEntries(
        NAMES.map((name, i) => [
          name,
          { pushes: [{ ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), size: 1 }] },
        ]),
      ),
    )

  test('a page holds a hundred rows, and the last page holds the remainder', async () => {
    const store = await manyRepos()
    const first = JSON.parse((await list(JSON_REQ, store)).body) as {
      repos: { name: string }[]
      page: number
      pages: number
      total: number
    }
    expect(first.repos).toHaveLength(REPO_LIST_PAGE_SIZE)
    expect(first.total).toBe(NAMES.length)
    expect(first.pages).toBe(2)
    // Newest push first: the last name created is the first row.
    expect(first.repos[0]!.name).toBe('repo-129')

    const second = JSON.parse(
      (await list({ ...JSON_REQ, search: '?page=2' }, store)).body,
    ) as typeof first
    expect(second.page).toBe(2)
    expect(second.repos).toHaveLength(30)
    expect(second.repos.at(-1)!.name).toBe('repo-000')
  })

  test('a page number that is not one is clamped rather than refused', async () => {
    const store = await manyRepos()
    for (const search of ['?page=0', '?page=-4', '?page=lots', '?page=']) {
      const body = JSON.parse((await list({ ...JSON_REQ, search }, store)).body) as { page: number }
      expect(body.page).toBe(1)
    }
    const past = JSON.parse((await list({ ...JSON_REQ, search: '?page=99' }, store)).body) as {
      page: number
    }
    expect(past.page).toBe(2)
  })
})

describe('more names than one listing can carry facts for', () => {
  /**
   * Past `REPO_LIST_MAX_FACTS` names, reading every Index to sort by last push
   * would be one request fanning out into thousands. The listing stays in the
   * order the store gave it — name order — only the requested page's Indexes
   * are read, and the page says so rather than presenting name order as if it
   * were recency.
   */
  const NAMES = Array.from(
    { length: REPO_LIST_MAX_FACTS + 5 },
    (_, i) => `repo-${String(i).padStart(4, '0')}`,
  )

  async function hugeStore(): Promise<{ store: ObjectStore; reads: string[] }> {
    const store = await storeWith(
      Object.fromEntries(
        NAMES.map((name, i) => [
          name,
          { pushes: [{ ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), size: 1 }] },
        ]),
      ),
    )
    const reads: string[] = []
    // Delegating explicitly rather than spreading the instance: a class's
    // methods live on its prototype, so a spread would hand back an object
    // with none of them and the test would be asserting against a store that
    // cannot read.
    const counting: ObjectStore = {
      get: (key) => {
        reads.push(key)
        return store.get(key)
      },
      getIfNoneMatch: (key, etag) => store.getIfNoneMatch(key, etag),
      put: (key, body, condition) => store.put(key, body, condition),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
    }
    return { store: counting, reads }
  }

  test('order stays name order, and the page says why', async () => {
    const { store } = await hugeStore()
    const res = await list(HTML, store)
    expect(res.body).toContain('name order')
    const body = JSON.parse((await list(JSON_REQ, store)).body) as {
      repos: { name: string }[]
      sortedBy: string
      total: number
    }
    expect(body.total).toBe(NAMES.length)
    expect(body.sortedBy).toBe('name')
    expect(body.repos[0]!.name).toBe('repo-0000')
  })

  test('only the page being rendered has its Index read', async () => {
    const { store, reads } = await hugeStore()
    await list({ ...JSON_REQ, search: '?page=2' }, store)
    expect(reads).toHaveLength(REPO_LIST_PAGE_SIZE)
    expect(reads).toContain(indexKey('repo-0100'))
    expect(reads).not.toContain(indexKey('repo-0000'))
  })
})

describe('the page a browser gets', () => {
  test('is HTML, and anything that did not ask for HTML gets JSON', async () => {
    const store = await storeWith({ alpha: {} })
    expect((await list(HTML, store)).headers['content-type']).toBe('text/html; charset=utf-8')
    expect((await list(JSON_REQ, store)).headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
  })

  test('keeps itself out of search results and off the network', async () => {
    const res = await list(HTML, await storeWith({ alpha: {} }))
    // A list of names is not a page anyone should reach from a search engine,
    // and on a credentialed deployment it is not one a crawler can read at all.
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.body).toContain('<meta name="robots" content="noindex">')
    // The filter is the only script, so nothing else may load or connect.
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
  })

  test('every row links to the repository it names', async () => {
    const res = await list(HTML, await storeWith({ alpha: {} }))
    expect(res.body).toContain('href="/alpha"')
  })

  test('a repository being removed says so', async () => {
    const res = await list(HTML, await storeWith({ leaving: { deletionPending: true } }))
    expect(res.body).toContain('being removed')
  })

  // A name is one path segment and the grammar constrains it, but the page is
  // rendered from bytes in a bucket rather than from a path the grammar
  // checked — so it escapes anyway.
  test('a name is escaped rather than trusted', async () => {
    const store = new MemoryStore()
    const nasty = '<script>x</script>'
    await store.put(indexKey(nasty), new TextEncoder().encode(JSON.stringify(indexFor(nasty, {}))))
    const res = await list(HTML, store)
    expect(res.body).not.toContain('<script>x</script>')
    expect(res.body).toContain('&lt;script&gt;')
  })
})

describe('the view is read-only', () => {
  test('nothing in it writes', async () => {
    const store = await storeWith({ alpha: { pushes: [{ ts: '2026-09-01T00:00:00Z', size: 1 }] } })
    const readOnly: ObjectStore = {
      get: (key) => store.get(key),
      getIfNoneMatch: (key, etag) => store.getIfNoneMatch(key, etag),
      list: (prefix) => store.list(prefix),
      put: () => Promise.reject(new Error('the list wrote to the store')),
      delete: () => Promise.reject(new Error('the list deleted from the store')),
    }
    const res = await list(HTML, readOnly)
    expect(res.status).toBe(200)
  })
})
