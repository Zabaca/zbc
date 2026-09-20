/**
 * The two browse pages, driven at `browseResponse`.
 *
 * The seam is the same one `src/repo-list.test.ts` uses on the list: the module
 * states a status, headers and a body, the Worker owns the `Response`, and the
 * container arrives as one `ask` callback — so the negotiation, the gate's
 * pass-through, the headers and the markup are all testable with no Workers
 * runtime, no socket and no container.
 *
 * It lives under `src/` for the reason every other `shared/` test does: that
 * directory is the runtime-neutral kernel (docs/adr/0010), and a `.test.ts`
 * beside it would import `bun:test` into the Worker's program.
 */

import { describe, expect, test } from 'bun:test'

import {
  browseResponse,
  expiresIn,
  type BrowseTreeAnswer,
  type ContainerAnswer,
} from '../shared/browse'
import { wantsBrowse } from '../shared/protocol'
import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'

const HTML = 'text/html,application/xhtml+xml'
const OID = '9'.repeat(40)

const ANSWER: BrowseTreeAnswer = {
  repo: 'alpha',
  defaultBranch: 'refs/heads/main',
  ref: 'refs/heads/main',
  path: '',
  lastPush: '2026-09-19T12:00:00.000Z',
  refs: [
    { name: 'refs/heads/main', oid: OID },
    { name: 'refs/heads/feature/x', oid: OID },
    { name: 'refs/tags/v1', oid: OID },
  ],
  entries: [
    { name: 'src', kind: 'tree', oid: OID, size: null },
    { name: 'README.md', kind: 'blob', oid: OID, size: 15 },
    { name: 'link', kind: 'symlink', oid: OID, size: null, target: 'src/index.ts' },
    { name: 'vendor', kind: 'submodule', oid: OID, size: null },
  ],
}

const served = (answer: unknown, status = 200): ContainerAnswer => ({
  status,
  text: `${JSON.stringify(answer)}\n`,
  contentType: 'application/json; charset=utf-8',
  served: true,
  reject: '',
  challenges: [],
})

interface PageOptions {
  accept?: string
  answer?: ContainerAnswer
  env?: CapabilityEnv
}

async function page(pathname: string, options: PageOptions = {}) {
  const route = wantsBrowse('GET', pathname)
  if (!route) throw new Error(`not a browse URL: ${pathname}`)
  const asked: string[] = []
  const res = await browseResponse(
    route,
    { accept: options.accept ?? HTML },
    {
      ask: async (query) => {
        asked.push(query)
        return options.answer ?? served(ANSWER)
      },
      caps: capabilitiesFrom(options.env ?? { WALGIT_PUBLIC: '1' }),
      // Six hours after the fixture's last push, so the retention line below
      // is a fact about the arithmetic rather than about the day this runs.
      now: () => Date.parse('2026-09-19T18:00:00.000Z'),
    },
  )
  return { res, asked }
}

describe('wantsBrowse', () => {
  test('claims the two page URLs, and nothing that is not a repository', () => {
    expect(wantsBrowse('GET', '/alpha')).toEqual({ repo: 'alpha', rest: '' })
    expect(wantsBrowse('GET', '/alpha/tree/feature/x/src')).toEqual({
      repo: 'alpha',
      rest: 'feature/x/src',
    })
    // A clone URL is not a browse URL: `/alpha.git/…` is git's, and the two
    // must not be able to claim each other.
    expect(wantsBrowse('GET', '/alpha.git/info/refs')).toBe(null)
    // A name walgit would not serve never becomes a page about one.
    expect(wantsBrowse('GET', '/_walgit/health')).toBe(null)
    expect(wantsBrowse('GET', '/.env')).toBe(null)
    // A browse is a read.
    expect(wantsBrowse('POST', '/alpha')).toBe(null)
  })
})

describe('the repository page', () => {
  test('asks the container once, for the tree, and names no ref at the root', async () => {
    const { asked } = await page('/alpha')
    expect(asked).toEqual(['?repo=alpha&op=tree'])
  })

  test('carries the ref and the path a directory URL names', async () => {
    const { asked } = await page('/alpha/tree/feature/x/src')
    // Run together, deliberately: only the Index knows where the ref ends.
    expect(asked).toEqual(['?repo=alpha&op=tree&ref=feature%2Fx%2Fsrc'])
  })

  test('renders the entries, and links only the directories', async () => {
    const { res } = await page('/alpha')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    // A directory is a link to the page below it.
    expect(res.body).toContain('<a href="/alpha/tree/main/src">src/</a>')
    // A file is not: there is no file page yet, and a link to one would be a
    // 404 a reader has to discover by clicking.
    expect(res.body).toContain('README.md')
    expect(res.body).not.toContain('href="/alpha/tree/main/README.md"')
    // A symlink shows its target and a gitlink says what it is.
    expect(res.body).toContain('→ src/index.ts')
    expect(res.body).toContain('submodule @ 99999999')
  })

  test('lists every ref, short, and links each to its own root', async () => {
    const { res } = await page('/alpha')
    expect(res.body).toContain('<a href="/alpha/tree/main" class="here">main</a>')
    expect(res.body).toContain('>feature/x</a>')
    // A tag keeps its full name: only `refs/heads/` is dropped, because that
    // is the one prefix a reader can be relied on to supply back.
    expect(res.body).toContain('>refs/tags/v1</a>')
  })

  test('a directory page can walk back up', async () => {
    const { res } = await page('/alpha/tree/main/src/deep', {
      answer: served({ ...ANSWER, path: 'src/deep', entries: [] }),
    })
    expect(res.body).toContain('<a href="/alpha/tree/main/src">..</a>')
    expect(res.body).toContain('Nothing here.')
  })

  test('encodes a link for a URL as well as escaping it for the markup', async () => {
    // A directory may legally be called `a#b`, and `#` ends a URL: escaping
    // alone would produce a link that resolves somewhere else entirely. The
    // slashes that make the path a path have to survive it.
    const { res } = await page('/alpha/tree/main/a%23b', {
      answer: served({
        ...ANSWER,
        path: 'a#b',
        entries: [{ name: 'c d', kind: 'tree', oid: OID, size: null }],
      }),
    })
    expect(res.body).toContain('<a href="/alpha/tree/main/a%23b/c%20d">c d/</a>')
    // …and the ref keeps its own slashes, which are path separators and not
    // part of any one segment.
    const slashed = await page('/alpha/tree/feature/x', {
      answer: served({ ...ANSWER, ref: 'refs/heads/feature/x' }),
    })
    expect(slashed.res.body).toContain('href="/alpha/tree/feature/x/src"')
  })

  test('escapes what came out of the log rather than trusting it', async () => {
    const { res } = await page('/alpha', {
      answer: served({
        ...ANSWER,
        entries: [{ name: '<script>x</script>', kind: 'blob', oid: OID, size: 1 }],
      }),
    })
    expect(res.body).not.toContain('<script>x</script>')
    expect(res.body).toContain('&lt;script&gt;')
  })

  test('is not for crawlers, and says so in the header as well as the markup', async () => {
    const { res } = await page('/alpha')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(res.body).toContain('<meta name="robots" content="noindex">')
    // Nothing may load, connect or post — there is no script on the page at
    // all, so `script-src` is absent rather than permissive.
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['content-security-policy']).not.toContain('script-src')
  })

  test('is cachable only where a read takes no credential', async () => {
    const open = await page('/alpha', { env: { WALGIT_PUBLIC: '1' } })
    expect(open.res.headers['cache-control']).toBe('public, max-age=60')
    // A shared cache must not hold a document that exists because THIS request
    // presented a token.
    const gated = await page('/alpha', { env: {} })
    expect(gated.res.headers['cache-control']).toBe('private, no-store')
  })

  test('shows what is left of the retention window, in the landing page’s words', async () => {
    const { res } = await page('/alpha', {
      env: { WALGIT_PUBLIC: '1', WALGIT_RETENTION_HOURS: '24' },
    })
    expect(res.body).toContain('expires in 18 hours')
  })
})

describe('the answer a client asked for', () => {
  test('is the container’s JSON, verbatim, when the reader is not a browser', async () => {
    const { res } = await page('/alpha', { accept: 'application/json' })
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toEqual(ANSWER)
  })

  test('a refusal is passed through with its challenges, for either reader', async () => {
    const refusal: ContainerAnswer = {
      status: 401,
      text: 'how to prove a key\n',
      contentType: 'text/plain; charset=utf-8',
      served: true,
      reject: 'unauthorized',
      challenges: ['Basic realm="walgit"', 'walgit-ssh nonce=abc'],
    }
    for (const accept of [HTML, 'application/json']) {
      const { res } = await page('/alpha', { accept, answer: refusal })
      expect(res.status).toBe(401)
      expect(res.body).toBe('how to prove a key\n')
      // Both lines, so a credential helper sees the nonce it has to sign.
      expect(res.headers['www-authenticate']).toBe('Basic realm="walgit", walgit-ssh nonce=abc')
      expect(res.headers['cache-control']).toBe('no-store')
      // What the container said about answering, carried back for the
      // datapoint the Worker writes.
      expect(res.upstream).toEqual({ status: 401, served: true, reject: 'unauthorized' })
    }
  })

  test('a 404 from the container is a 404 here, not an empty page', async () => {
    const { res } = await page('/alpha', {
      answer: { ...served('', 404), text: 'not found\n', contentType: 'text/plain' },
    })
    expect(res.status).toBe(404)
    expect(res.body).toBe('not found\n')
  })

  test('an answer this page cannot read is refused rather than rendered', async () => {
    const { res } = await page('/alpha', {
      answer: { ...served(null), text: 'not json at all' },
    })
    expect(res.status).toBe(502)
  })
})

describe('expiresIn', () => {
  const at = (iso: string) => Date.parse(iso)

  test('counts from the last push, in whole hours, rounded up', () => {
    const caps = capabilitiesFrom({ WALGIT_RETENTION_HOURS: '24' })
    // 24 hours from noon is noon the next day; at 18:00 that is 18 hours off.
    expect(expiresIn('2026-09-19T12:00:00.000Z', caps, at('2026-09-19T18:00:00.000Z'))).toBe(
      'expires in 18 hours',
    )
    // Fifty minutes left is not "0 hours", which would read as gone.
    expect(expiresIn('2026-09-19T12:00:00.000Z', caps, at('2026-09-20T11:10:00.000Z'))).toBe(
      'expires in 1 hour',
    )
    expect(expiresIn('2026-09-19T12:00:00.000Z', caps, at('2026-09-20T13:00:00.000Z'))).toBe(
      'expires at any moment',
    )
  })

  test('says nothing where there is no window, and nothing to measure from', () => {
    expect(expiresIn('2026-09-19T12:00:00.000Z', capabilitiesFrom({}), Date.now())).toBe(null)
    expect(expiresIn(null, capabilitiesFrom({ WALGIT_RETENTION_HOURS: '24' }), Date.now())).toBe(
      null,
    )
  })
})
