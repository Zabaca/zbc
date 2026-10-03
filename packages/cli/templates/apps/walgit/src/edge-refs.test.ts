/**
 * The edge's ref checks (`shared/edge-refs.ts`) against the git they stand in
 * for.
 *
 * Three layers, and each answers a different doubt:
 *
 *   - **Golden** — a real bare repository and real `git upload-pack`: for every
 *     request shape the edge answers, the renderer's bytes are git's bytes.
 *   - **Decisions** — every shape the edge must NOT answer falls through, with
 *     the request it forwards still carrying the client's bytes.
 *   - **End to end** — real `git ls-remote` and `git clone` through a server
 *     that answers what it can at the edge and forwards the rest to the real
 *     container handler (`src/http.ts` + `git http-backend` + a log), compared
 *     with the same commands sent straight to the container.
 *
 * Every git here runs with the developer's own config excluded, so the
 * advertisement captured is the one a stock git gives.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { capabilitiesFrom } from '../shared/capabilities'
import {
  answerAdvertisement,
  parseLsRefsRequest,
  parseUploadPackRecord,
  refsAtEdge,
  renderLsRefs,
  REQUEST_TYPE,
  serializeUploadPackRecord,
  speaksV2,
  uploadPackKeyFor,
  type EdgeRefsDeps,
  type UploadPackFacts,
  type UploadPackRecord,
} from '../shared/edge-refs'
import { indexKey, UPLOAD_PACK_PREFIX } from '../shared/keys'
import { MemoryStore, type ObjectStore } from '../shared/store'
import { emptyIndex, loadIndex, type WalIndex } from '../shared/wal-index'
import { ensureBareRepo } from './cache'
import { captureUploadPack, publishUploadPack } from './edge-refs'
import { runGitHttpBackend } from './git-backend'
import { createHttpHandler } from './http'
import { ensureHead } from './materialize'
import { FileStore } from './store'
import { syncRepo } from './sync'

/** git, with no config of the developer's leaking in. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'walgit',
  GIT_AUTHOR_EMAIL: 'walgit@example.test',
  GIT_COMMITTER_NAME: 'walgit',
  GIT_COMMITTER_EMAIL: 'walgit@example.test',
}

const git = (cwd: string, ...args: string[]): string => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/**
 * git ASYNCHRONOUSLY, for the end-to-end half: the server answering it lives in
 * this process, and a synchronous child would block the loop it is waiting on.
 */
const gitAsync = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
    env: { ...GIT_ENV, GIT_ASKPASS: '/usr/bin/false' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0) throw new Error(`git ${args.join(' ')} exited ${status}: ${err}`)
  return out
}

/** One pkt-line. */
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`

/**
 * An `ls-refs` request, shaped as git 2.52's client sends it: capabilities with
 * no trailing newline, arguments with one.
 */
const lsRefsBody = (args: string[], caps = ['agent=git/2.52.0-Darwin', 'object-format=sha1']) =>
  `${pkt('command=ls-refs\n')}${caps.map(pkt).join('')}0001${args
    .map((arg) => pkt(`${arg}\n`))
    .join('')}0000`

/** The exact body `git ls-remote` sent, captured off the wire from git 2.52. */
const LS_REMOTE_BODY =
  '0014command=ls-refs\n001bagent=git/2.52.0-Darwin0016object-format=sha100010009peel\n000csymrefs\n000bunborn\n0000'

/** What `git clone` sends: the same, narrowed to the three prefixes a clone needs. */
const CLONE_BODY = lsRefsBody([
  'peel',
  'symrefs',
  'unborn',
  'ref-prefix refs/heads/',
  'ref-prefix refs/tags/',
  'ref-prefix HEAD',
])

/** What `git upload-pack` itself answers one v2 request with. */
function upload(gitDir: string, body: string): string {
  const res = spawnSync('git', ['upload-pack', '--stateless-rpc', gitDir], {
    input: body,
    encoding: 'latin1',
    env: { ...GIT_ENV, GIT_PROTOCOL: 'version=2' },
  })
  if (res.status !== 0) throw new Error(`upload-pack: ${res.stderr}`)
  return res.stdout
}

/** The repository's refs, as the Index would carry them. */
function refsOf(gitDir: string): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const line of git(gitDir, 'for-each-ref', '--format=%(objectname) %(refname)').split('\n')) {
    const [oid, name] = line.split(' ')
    if (oid && name) refs[name] = oid
  }
  return refs
}

let scratch: string
let record: UploadPackRecord
let facts: UploadPackFacts

/** A bare repository with two branches, a lightweight tag and an annotated one. */
let tagged: string
/** The same history with no tags at all. */
let branchesOnly: string

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-edge-refs-'))
  const work = path.join(scratch, 'work')
  fs.mkdirSync(work)
  git(work, 'init', '--quiet', '--initial-branch=main')
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'one')
  git(work, 'tag', 'light')
  git(work, 'tag', '-a', '-m', 'annotated', 'v1')
  git(work, 'checkout', '--quiet', '-b', 'feature')
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'two')

  tagged = path.join(scratch, 'tagged.git')
  branchesOnly = path.join(scratch, 'branches.git')
  for (const dir of [tagged, branchesOnly]) {
    git(scratch, 'init', '--quiet', '--bare', '--initial-branch=main', dir)
  }
  git(work, 'push', '--quiet', tagged, 'main', 'feature', 'light', 'v1')
  git(work, 'push', '--quiet', branchesOnly, 'main', 'feature')

  record = await captureUploadPack(scratch)
  facts = parseUploadPackRecord(serializeUploadPackRecord(record))!
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// ── Golden ──────────────────────────────────────────────────────────────────

describe('the advertisement', () => {
  test('is what http-backend answers a v2 client, for a repository with refs', async () => {
    expect(facts).not.toBeNull()
    const direct = await runGitHttpBackend({
      repo: { repoId: 'tagged', dir: tagged },
      pathInfo: '/tagged.git/info/refs',
      request: new Request('http://x/tagged.git/info/refs?service=git-upload-pack', {
        headers: { 'git-protocol': 'version=2' },
      }),
    })
    const index = { ...emptyIndex('tagged'), refs: refsOf(tagged) }
    const answer = answerAdvertisement(facts, index)!
    expect(answer.status).toBe(direct.status)
    expect(answer.headers).toEqual([...direct.headers])
    expect(answer.body).toBe(await direct.text())
  })

  test('carries no `# service=` preamble — that is the v0 shape, which the edge never sends', async () => {
    expect(record.advertisement.body.startsWith('000eversion 2\n')).toBe(true)
    expect(record.advertisement.body).not.toContain('# service=')
    expect(record.advertisement.body.endsWith('0000')).toBe(true)
    const v0 = await runGitHttpBackend({
      repo: { repoId: 'tagged', dir: tagged },
      pathInfo: '/tagged.git/info/refs',
      request: new Request('http://x/tagged.git/info/refs?service=git-upload-pack'),
    })
    expect(await v0.text()).toStartWith('001e# service=git-upload-pack\n0000')
  })

  test('headers are the no-cache set http-backend sends, typed as an advertisement', () => {
    expect(Object.fromEntries(facts.advertisement.headers)).toEqual({
      expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      pragma: 'no-cache',
      'cache-control': 'no-cache, max-age=0, must-revalidate',
      'content-type': 'application/x-git-upload-pack-advertisement',
    })
    expect(Object.fromEntries(facts.resultHeaders)['content-type']).toBe(
      'application/x-git-upload-pack-result',
    )
  })

  test('names the capabilities the record was checked for', () => {
    expect(facts.capabilities.has('ls-refs')).toBe(true)
    expect(facts.capabilities.get('object-format')).toBe('sha1')
  })
})

describe('ls-refs, byte for byte against git upload-pack', () => {
  const golden = (repo: () => string, body: () => string) => () => {
    const request = parseLsRefsRequest(new TextEncoder().encode(body()), facts.capabilities)
    expect(request).not.toBeNull()
    expect(renderLsRefs(refsOf(repo()), request!)).toBe(upload(repo(), body()))
  }

  test(
    'what `git ls-remote` sends (peel, symrefs, unborn)',
    golden(
      () => branchesOnly,
      () => LS_REMOTE_BODY,
    ),
  )
  test(
    'what `git clone` sends (three prefixes)',
    golden(
      () => branchesOnly,
      () => CLONE_BODY,
    ),
  )
  test(
    'no arguments at all, tags included',
    golden(
      () => tagged,
      () => lsRefsBody([]),
    ),
  )
  test(
    'symrefs with tags, no peel',
    golden(
      () => tagged,
      () => lsRefsBody(['symrefs']),
    ),
  )
  test(
    'a prefix of tags only',
    golden(
      () => tagged,
      () => lsRefsBody(['ref-prefix refs/tags/']),
    ),
  )
  test(
    'a partial-name prefix',
    golden(
      () => tagged,
      () => lsRefsBody(['symrefs', 'ref-prefix refs/heads/m']),
    ),
  )
  test(
    'overlapping prefixes list a ref once',
    golden(
      () => tagged,
      () => lsRefsBody(['ref-prefix refs/heads/', 'ref-prefix refs/heads/main', 'ref-prefix HEAD']),
    ),
  )
  test(
    'a prefix that matches nothing',
    golden(
      () => tagged,
      () => lsRefsBody(['symrefs', 'ref-prefix refs/nothing/']),
    ),
  )
  test(
    '`HEAD` without symrefs',
    golden(
      () => branchesOnly,
      () => lsRefsBody(['ref-prefix HEAD']),
    ),
  )
  test(
    'peel over branches only',
    golden(
      () => tagged,
      () => lsRefsBody(['peel', 'ref-prefix refs/heads/']),
    ),
  )
  test('capabilities sent with newlines', () => {
    const body = lsRefsBody(['symrefs'], ['agent=git/2.40.0\n', 'object-format=sha1\n'])
    golden(
      () => tagged,
      () => body,
    )()
  })

  test('peel where tags are listed is not rendered — git peels what the Index cannot', () => {
    const request = parseLsRefsRequest(
      new TextEncoder().encode(LS_REMOTE_BODY),
      facts.capabilities,
    )!
    expect(upload(tagged, LS_REMOTE_BODY)).toContain(' peeled:')
    expect(renderLsRefs(refsOf(tagged), request)).toBeNull()
  })
})

// ── Decisions ───────────────────────────────────────────────────────────────

const REPO = 'alpha'
const KEY = uploadPackKeyFor({ WALGIT_BUILD_ID: 'test', WALGIT_PUBLIC: '1' })!

/** A store holding the captured record and an Index with these fields. */
async function storeWith(index: Partial<WalIndex> | null): Promise<MemoryStore> {
  const store = new MemoryStore()
  await store.put(KEY, serializeUploadPackRecord(record))
  if (index) {
    const full = { ...emptyIndex(REPO), ...index }
    await store.put(indexKey(REPO), new TextEncoder().encode(JSON.stringify(full)))
  }
  return store
}

const BRANCHES = {
  'refs/heads/main': 'a'.repeat(40),
  'refs/heads/feature': 'b'.repeat(40),
}
const WITH_TAG = { ...BRANCHES, 'refs/tags/v1': 'c'.repeat(40) }

const advertise = (headers: Record<string, string> = { 'git-protocol': 'version=2' }) =>
  new Request(`http://edge/${REPO}.git/info/refs?service=git-upload-pack`, { headers })

const lsRefs = (body: string, headers: Record<string, string> = {}) =>
  new Request(`http://edge/${REPO}.git/git-upload-pack`, {
    method: 'POST',
    headers: {
      'git-protocol': 'version=2',
      'content-type': REQUEST_TYPE,
      'content-length': String(body.length),
      ...headers,
    },
    body,
  })

const deps = (store: ObjectStore | null, extra: Partial<EdgeRefsDeps> = {}): EdgeRefsDeps => ({
  publicAccess: true,
  store,
  recordKey: KEY,
  ...extra,
})

/** A store that counts reads, to prove a forwarded request cost none. */
function counting(store: ObjectStore): ObjectStore & { gets: number } {
  const counted = Object.create(store) as ObjectStore & { gets: number }
  counted.gets = 0
  counted.get = async (key) => {
    counted.gets += 1
    return store.get(key)
  }
  return counted
}

describe('what the edge answers', () => {
  test('the advertisement, for a public repository with refs', async () => {
    const out = await refsAtEdge(advertise(), deps(await storeWith({ refs: BRANCHES })))
    expect(out.response?.status).toBe(200)
    expect(await out.response!.text()).toBe(record.advertisement.body)
    expect(out.response!.headers.get('content-type')).toBe(
      'application/x-git-upload-pack-advertisement',
    )
  })

  test('ls-refs, with HEAD on the Default Branch', async () => {
    const out = await refsAtEdge(lsRefs(LS_REMOTE_BODY), deps(await storeWith({ refs: BRANCHES })))
    expect(await out.response!.text()).toBe(
      `${pkt(`${'a'.repeat(40)} HEAD symref-target:refs/heads/main\n`)}` +
        `${pkt(`${'b'.repeat(40)} refs/heads/feature\n`)}` +
        `${pkt(`${'a'.repeat(40)} refs/heads/main\n`)}0000`,
    )
    expect(out.response!.headers.get('content-type')).toBe('application/x-git-upload-pack-result')
  })

  test('a claimed name with no Reader List is world-readable, and answered', async () => {
    const claim = { signers: ['SHA256:x'], ts: '2026-01-01T00:00:00Z' }
    const out = await refsAtEdge(advertise(), deps(await storeWith({ refs: BRANCHES, claim })))
    expect(out.response).not.toBeNull()
  })

  test('tags without peel are listed', async () => {
    const out = await refsAtEdge(
      lsRefs(lsRefsBody(['symrefs'])),
      deps(await storeWith({ refs: WITH_TAG })),
    )
    expect(await out.response!.text()).toContain('refs/tags/v1')
  })
})

describe('what falls through to the container', () => {
  /** Asserts a fall-through, and returns the request that would be forwarded. */
  async function passes(request: Request, d: EdgeRefsDeps): Promise<Request> {
    const out = await refsAtEdge(request, d)
    expect(out.response).toBeNull()
    return (out as { request: Request }).request
  }

  test('a v0 client, and a v1 one', async () => {
    const store = await storeWith({ refs: BRANCHES })
    await passes(advertise({}), deps(store))
    await passes(advertise({ 'git-protocol': 'version=1' }), deps(store))
  })

  test('a token-gated deployment, before anything is read', async () => {
    const store = counting(await storeWith({ refs: BRANCHES }))
    const request = advertise()
    expect(await passes(request, deps(store, { publicAccess: false }))).toBe(request)
    expect(store.gets).toBe(0)
  })

  test('a deployment with no build id — no record key at all', async () => {
    expect(uploadPackKeyFor({ WALGIT_PUBLIC: '1' })).toBeNull()
    expect(uploadPackKeyFor({ WALGIT_BUILD_ID: '', WALGIT_PUBLIC: '1' })).toBeNull()
    const store = await storeWith({ refs: BRANCHES })
    await passes(advertise(), deps(store, { recordKey: null }))
  })

  test('no record published yet, or one that fails its checks', async () => {
    const store = await storeWith({ refs: BRANCHES })
    await store.delete(KEY)
    await passes(advertise(), deps(store))
    await store.put(KEY, new TextEncoder().encode('{"version":1}'))
    await passes(advertise(), deps(store))
    const v0 = {
      ...record,
      advertisement: { ...record.advertisement, body: '001e# service=git-upload-pack\n0000' },
    }
    await store.put(KEY, serializeUploadPackRecord(v0))
    await passes(advertise(), deps(store))
  })

  test('a push and its advertisement', async () => {
    const store = await storeWith({ refs: BRANCHES })
    await passes(
      new Request(`http://edge/${REPO}.git/info/refs?service=git-receive-pack`, {
        headers: { 'git-protocol': 'version=2' },
      }),
      deps(store),
    )
  })

  test('a HEAD request', async () => {
    const store = await storeWith({ refs: BRANCHES })
    const request = new Request(`http://edge/${REPO}.git/info/refs?service=git-upload-pack`, {
      method: 'HEAD',
      headers: { 'git-protocol': 'version=2' },
    })
    await passes(request, deps(store))
  })

  test('a gzipped body, unread', async () => {
    const store = counting(await storeWith({ refs: BRANCHES }))
    const request = lsRefs(LS_REMOTE_BODY, { 'content-encoding': 'gzip' })
    expect(await passes(request, deps(store))).toBe(request)
    expect(request.bodyUsed).toBe(false)
    expect(store.gets).toBe(0)
  })

  test('a body too large to hold, or with no length, unread', async () => {
    const store = await storeWith({ refs: BRANCHES })
    const large = lsRefs(lsRefsBody(['ref-prefix refs/heads/'.padEnd(5000, 'x')]))
    expect(await passes(large, deps(store))).toBe(large)
    expect(large.bodyUsed).toBe(false)
    const chunked = new Request(`http://edge/${REPO}.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'git-protocol': 'version=2', 'content-type': REQUEST_TYPE },
      body: LS_REMOTE_BODY,
    })
    expect(await passes(chunked, deps(store))).toBe(chunked)
  })

  test('a fetch, forwarded with its bytes intact and no store read', async () => {
    const store = counting(await storeWith({ refs: BRANCHES }))
    const body =
      `${pkt('command=fetch')}${pkt('agent=git/2.52.0')}0001${pkt('thin-pack')}` +
      `${pkt(`want ${'a'.repeat(40)}\n`)}${pkt('done\n')}0000`
    const forwarded = await passes(lsRefs(body), deps(store))
    expect(await forwarded.text()).toBe(body)
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('content-type')).toBe(REQUEST_TYPE)
    expect(forwarded.headers.get('git-protocol')).toBe('version=2')
    expect(store.gets).toBe(0)
  })

  test('an ls-refs it declines is forwarded with its bytes intact too', async () => {
    const store = await storeWith({ refs: WITH_TAG })
    const forwarded = await passes(lsRefs(LS_REMOTE_BODY), deps(store))
    expect(await forwarded.text()).toBe(LS_REMOTE_BODY)
  })

  test('a Private name — any Reader List, even an empty one — on both requests', async () => {
    for (const readers of [[], ['SHA256:reader']]) {
      const claim = { signers: ['SHA256:x'], readers, ts: '2026-01-01T00:00:00Z' }
      const store = await storeWith({ refs: BRANCHES, claim })
      await passes(advertise(), deps(store))
      await passes(lsRefs(LS_REMOTE_BODY), deps(store))
    }
  })

  test('peel where a tag is listed', async () => {
    const store = await storeWith({ refs: WITH_TAG })
    await passes(lsRefs(LS_REMOTE_BODY), deps(store))
    await passes(lsRefs(CLONE_BODY), deps(store))
  })

  test('a name nobody has pushed to, and one holding no refs', async () => {
    await passes(advertise(), deps(await storeWith(null)))
    await passes(lsRefs(LS_REMOTE_BODY), deps(await storeWith(null)))
    await passes(advertise(), deps(await storeWith({ refs: {} })))
  })

  test('tags and no branch: HEAD would be unborn', async () => {
    const store = await storeWith({ refs: { 'refs/tags/v1': 'c'.repeat(40) } })
    await passes(lsRefs(lsRefsBody(['symrefs', 'unborn'])), deps(store))
  })

  test('a capability or argument the edge does not render', async () => {
    const store = await storeWith({ refs: BRANCHES })
    await passes(lsRefs(lsRefsBody(['symrefs'], ['agent=x', 'server-option=y'])), deps(store))
    await passes(lsRefs(lsRefsBody(['symrefs'], ['object-format=sha256'])), deps(store))
    await passes(lsRefs(lsRefsBody(['symrefs'], ['bundle-uri'])), deps(store))
    await passes(lsRefs(lsRefsBody(['symrefs', 'exclude-refs'])), deps(store))
  })

  test('a body that does not frame as one request', async () => {
    const store = await storeWith({ refs: BRANCHES })
    // No delimiter, a trailing packet, a response-end, a bad length.
    await passes(lsRefs(`${pkt('command=ls-refs\n')}${pkt('symrefs\n')}0000`), deps(store))
    await passes(lsRefs(`${LS_REMOTE_BODY}0000`), deps(store))
    await passes(lsRefs(LS_REMOTE_BODY.replace(/0000$/, '0002')), deps(store))
    await passes(lsRefs(LS_REMOTE_BODY.replace('0009peel', '0003peel')), deps(store))
  })

  test('a store that fails', async () => {
    const broken = await storeWith({ refs: BRANCHES })
    broken.get = async () => {
      throw new Error('store down')
    }
    await passes(advertise(), deps(broken))
    const forwarded = await passes(lsRefs(LS_REMOTE_BODY), deps(broken))
    expect(await forwarded.text()).toBe(LS_REMOTE_BODY)
  })

  test('a name the container would normalise differently', async () => {
    const store = await storeWith({ refs: BRANCHES })
    const request = new Request(`http://edge/${REPO}.git.git/info/refs?service=git-upload-pack`, {
      headers: { 'git-protocol': 'version=2' },
    })
    await passes(request, deps(store))
  })
})

describe('speaksV2 reads the header the way git does', () => {
  test.each([
    ['version=2', true],
    ['version=1:version=2', true],
    ['version=2:object-format=sha1', true],
    ['version=1', false],
    ['version=20', false],
    ['version=02', false],
    ['', false],
  ])('%p → %p', (header, expected) => {
    expect(speaksV2(header)).toBe(expected)
  })
})

// ── HEAD ────────────────────────────────────────────────────────────────────

describe('ensureHead', () => {
  test('is a function of the Index alone, so a Cache with history agrees with a fresh one', () => {
    const dir = path.join(scratch, 'head.git')
    git(scratch, 'init', '--quiet', '--bare', '--initial-branch=main', dir)
    ensureHead(dir, { 'refs/heads/feature': 'a'.repeat(40) })
    expect(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8')).toBe('ref: refs/heads/feature\n')
    // `main` arrives later. The old rule kept `feature` because it still
    // existed; a container restarted at this point would say `main`.
    ensureHead(dir, { 'refs/heads/feature': 'a'.repeat(40), 'refs/heads/main': 'b'.repeat(40) })
    expect(fs.readFileSync(path.join(dir, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  })
})

// ── End to end ──────────────────────────────────────────────────────────────

describe('a real git client, through the edge and straight to the container', () => {
  let storeDir: string
  let reposDir: string
  let work: string
  let store: FileStore
  let containerServer: ReturnType<typeof Bun.serve>
  let edgeServer: ReturnType<typeof Bun.serve>
  let container: string
  let edge: string
  let key: string
  /** What the edge answered itself, by kind. */
  const answered = { advertise: 0, 'ls-refs': 0 }
  let previousStoreDir: string | undefined

  beforeAll(async () => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-edge-store-'))
    reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-edge-repos-'))
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-edge-work-'))
    // The push hooks find the log through the environment, three processes down.
    previousStoreDir = process.env.WALGIT_STORE_DIR
    process.env.WALGIT_STORE_DIR = storeDir
    store = new FileStore(storeDir)

    // The container, wired as `src/server.ts` wires it for a public deployment.
    const handler = createHttpHandler({
      reposDir,
      tokens: [],
      public: true,
      capabilities: capabilitiesFrom({ WALGIT_PUBLIC: '1' }),
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(store, repo),
      runBackend: runGitHttpBackend,
      readRefs: async (repoId) => (await loadIndex(store, repoId)).index.refs,
    })
    containerServer = Bun.serve({ port: 0, idleTimeout: 0, fetch: handler })

    // What the container publishes at boot, and what the Worker reads it by.
    const env = { WALGIT_BUILD_ID: 'e2e', WALGIT_PUBLIC: '1' }
    key = (await publishUploadPack(store, env, work))!
    expect(key).toBe(uploadPackKeyFor(env)!)
    expect(await store.list(UPLOAD_PACK_PREFIX)).toEqual([key])

    // The Worker's branch, minus the Worker: answer at the edge, or forward
    // what `refsAtEdge` hands back to the container.
    edgeServer = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        const out = await refsAtEdge(request, { publicAccess: true, store, recordKey: key })
        if (out.response) {
          answered[out.route.kind] += 1
          return out.response
        }
        return handler(out.request)
      },
    })
    container = `http://127.0.0.1:${containerServer.port}`
    edge = `http://127.0.0.1:${edgeServer.port}`

    const src = path.join(work, 'src')
    fs.mkdirSync(src)
    git(src, 'init', '--quiet', '--initial-branch=main')
    fs.writeFileSync(path.join(src, 'README'), 'hello\n')
    git(src, 'add', 'README')
    git(src, 'commit', '--quiet', '-m', 'one')
    git(src, 'checkout', '--quiet', '-b', 'feature')
    git(src, 'commit', '--quiet', '--allow-empty', '-m', 'two')
  })

  afterAll(() => {
    containerServer?.stop(true)
    edgeServer?.stop(true)
    if (previousStoreDir === undefined) delete process.env.WALGIT_STORE_DIR
    else process.env.WALGIT_STORE_DIR = previousStoreDir
    for (const dir of [storeDir, reposDir, work]) fs.rmSync(dir, { recursive: true, force: true })
  })

  const v2 = ['-c', 'protocol.version=2']

  test('ls-remote: the same answer, and the edge gave all of it', async () => {
    const src = path.join(work, 'src')
    await gitAsync(src, 'push', '--quiet', `${container}/two.git`, 'main', 'feature')
    const before = { ...answered }
    const viaEdge = await gitAsync(work, ...v2, 'ls-remote', '--symref', `${edge}/two.git`)
    expect(answered.advertise).toBe(before.advertise + 1)
    expect(answered['ls-refs']).toBe(before['ls-refs'] + 1)
    const direct = await gitAsync(work, ...v2, 'ls-remote', '--symref', `${container}/two.git`)
    expect(viaEdge).toBe(direct)
    expect(viaEdge).toContain('ref: refs/heads/main\tHEAD')
  })

  test('the raw responses match the container byte for byte', async () => {
    const pairs: [string, RequestInit][] = [
      ['/two.git/info/refs?service=git-upload-pack', { headers: { 'git-protocol': 'version=2' } }],
      ...[LS_REMOTE_BODY, CLONE_BODY, lsRefsBody(['ref-prefix refs/heads/f'])].map(
        (body): [string, RequestInit] => [
          '/two.git/git-upload-pack',
          {
            method: 'POST',
            headers: { 'git-protocol': 'version=2', 'content-type': REQUEST_TYPE },
            body,
          },
        ],
      ),
    ]
    for (const [route, init] of pairs) {
      const before = answered.advertise + answered['ls-refs']
      const a = await fetch(`${edge}${route}`, init)
      expect(answered.advertise + answered['ls-refs']).toBe(before + 1)
      const b = await fetch(`${container}${route}`, init)
      expect(a.status).toBe(b.status)
      for (const name of ['content-type', 'cache-control', 'expires', 'pragma']) {
        expect(a.headers.get(name)).toBe(b.headers.get(name))
      }
      expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array(await b.arrayBuffer()))
    }
  })

  test('a first push of a branch other than main: both say HEAD is that branch', async () => {
    const src = path.join(work, 'src')
    await gitAsync(src, 'push', '--quiet', `${container}/only-feature.git`, 'feature')
    const viaEdge = await gitAsync(work, ...v2, 'ls-remote', '--symref', `${edge}/only-feature.git`)
    const direct = await gitAsync(
      work,
      ...v2,
      'ls-remote',
      '--symref',
      `${container}/only-feature.git`,
    )
    expect(viaEdge).toBe(direct)
    expect(viaEdge).toContain('ref: refs/heads/feature\tHEAD')
  })

  test('clone: refs at the edge, the fetch through it to the container intact', async () => {
    const before = { ...answered }
    const into = path.join(work, 'cloned')
    await gitAsync(work, ...v2, 'clone', '--quiet', `${edge}/two.git`, into)
    expect(answered['ls-refs']).toBe(before['ls-refs'] + 1)
    expect(fs.readFileSync(path.join(into, 'README'), 'utf8')).toBe('hello\n')
    expect(git(into, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })

  test('with tags, peel falls through and the answer is still the container’s', async () => {
    const src = path.join(work, 'src')
    git(src, 'tag', '-a', '-m', 'annotated', 'v1', 'main')
    await gitAsync(src, 'push', '--quiet', `${container}/two.git`, 'v1')
    const before = answered['ls-refs']
    const viaEdge = await gitAsync(work, ...v2, 'ls-remote', `${edge}/two.git`)
    expect(answered['ls-refs']).toBe(before)
    expect(viaEdge).toBe(await gitAsync(work, ...v2, 'ls-remote', `${container}/two.git`))
    expect(viaEdge).toContain('refs/tags/v1')
  })

  test('a v0 client is never answered at the edge, and still works', async () => {
    const before = { ...answered }
    const out = await gitAsync(work, '-c', 'protocol.version=0', 'ls-remote', `${edge}/two.git`)
    expect(answered).toEqual(before)
    expect(out).toContain('refs/heads/main')
  })

  test('a name nobody has pushed to is left to the container’s empty read', async () => {
    const before = { ...answered }
    const out = await gitAsync(work, ...v2, 'ls-remote', `${edge}/nobody.git`)
    expect(out).toBe('')
    expect(answered).toEqual(before)
    expect(await store.get(indexKey('nobody'))).toBeNull()
  })
})
