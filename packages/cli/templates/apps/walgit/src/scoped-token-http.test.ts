/**
 * Scoped tokens at the container's front door (docs/adr/0021).
 *
 * Asked of `createHttpHandler`, the seam every repository surface the container
 * serves already lives behind: smart HTTP, the browse route the web pages and
 * raw files are read through, the provenance read (which the MCP endpoint's
 * `status` and `provenance` tools also go through) and Proposals. The edge runs
 * the same verifier first (`shared/scoped-token.ts`); this is what holds the
 * rule for whatever reaches the container.
 */
import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { BROWSE_PATH, PROVENANCE_PATH } from '../shared/protocol'
import { base64UrlEncode, mintScopedToken, type ScopedClaims } from '../shared/scoped-token'
import { createHttpHandler, type BrowseReads, type HttpHandlerDeps } from './http'

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
    mode: 'write',
    iat: NOW - 10,
    exp: NOW + 600,
    ...over,
  })

const MAIN = 'a'.repeat(40)

const browse: BrowseReads = {
  readIndex: async () => ({ refs: { 'refs/heads/main': MAIN }, lastPush: null }),
  listTree: async () => [{ name: 'README.md', kind: 'blob', oid: '2'.repeat(40), size: 6 }],
  statBlob: async () => ({ oid: '2'.repeat(40), size: 6 }),
  readBlob: async () => new TextEncoder().encode('hello\n'),
  listCommits: async () => [],
}

/** Every repository surface on, so each can be asked about. */
const EVERYTHING: CapabilityEnv = {
  WALGIT_WEB: '1',
  WALGIT_SIGNER_LISTS: '1',
  WALGIT_PUSH_CERT_SEED: 'seed',
  WALGIT_PROPOSALS: '1',
}

function deployment(
  opts: { keys?: string; public?: boolean; overrides?: Partial<HttpHandlerDeps> } = {},
) {
  const created: string[] = []
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens: opts.public ? [] : ['admin-token'],
    public: opts.public ?? false,
    capabilities: capabilitiesFrom({
      ...EVERYTHING,
      ...(opts.public ? { WALGIT_PUBLIC: '1' } : {}),
    }),
    scopedTokenKeys: 'keys' in opts ? opts.keys : PUBLIC_KEY,
    tokenNow: () => NOW_MS,
    ensureRepo: (repo) => {
      created.push(repo.repoId)
      return repo
    },
    runBackend: async () => new Response('backend ran'),
    readProvenance: async () => ({ provenance: {} }),
    readProposals: async () => [],
    browse,
    ...opts.overrides,
  })
  const ask = (path: string, credential: string | null, method = 'GET') =>
    handler(
      new Request(`https://walgit.test${path}`, {
        method,
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      }),
    )
  return { ask, created }
}

/** Every repository surface the container serves, for one name. */
const surfaces = (repo: string): [string, string][] => [
  [`/${repo}.git/info/refs?service=git-upload-pack`, 'GET'],
  [`/${repo}.git/git-upload-pack`, 'POST'],
  [`/${repo}.git/info/refs?service=git-receive-pack`, 'GET'],
  [`/${repo}.git/git-receive-pack`, 'POST'],
  [`/${repo}.git/proposals`, 'GET'],
  [`${PROVENANCE_PATH}?repo=${repo}`, 'GET'],
  [`${BROWSE_PATH}?repo=${repo}&op=refs`, 'GET'],
  [`${BROWSE_PATH}?repo=${repo}&op=tree&ref=refs/heads/main`, 'GET'],
  [`${BROWSE_PATH}?repo=${repo}&op=raw&ref=refs/heads/main/README.md`, 'GET'],
]

describe('a write token for alpha', () => {
  test('reaches every surface of alpha', async () => {
    const { ask } = deployment()
    const credential = await token()
    for (const [path, method] of surfaces('alpha')) {
      const res = await ask(path, credential, method)
      expect({ path, status: res.status }).toEqual({ path, status: 200 })
    }
  })

  test('is a 403 on every surface of beta', async () => {
    const { ask, created } = deployment()
    const credential = await token()
    for (const [path, method] of surfaces('beta')) {
      const res = await ask(path, credential, method)
      expect({ path, status: res.status }).toEqual({ path, status: 403 })
      expect(await res.text()).toContain('scoped to the repository "alpha"')
    }
    // Refused before anything was created for the name it reached for.
    expect(created).toEqual([])
  })

  test('may create its own repository on first push, like an admin token', async () => {
    const { ask, created } = deployment()
    const res = await ask('/alpha.git/git-receive-pack', await token(), 'POST')
    expect(res.status).toBe(200)
    expect(created).toEqual(['alpha'])
  })

  test('is still refused elsewhere on a public deployment, where anonymous is served', async () => {
    const { ask } = deployment({ public: true })
    expect((await ask('/beta.git/info/refs?service=git-upload-pack', null)).status).toBe(200)
    const res = await ask('/beta.git/info/refs?service=git-upload-pack', await token())
    expect(res.status).toBe(403)
    expect((await ask('/alpha.git/git-receive-pack', await token(), 'POST')).status).toBe(200)
  })
})

describe('a read token for alpha', () => {
  test('reads alpha and may not push to it', async () => {
    const { ask, created } = deployment()
    const credential = await token({ mode: 'read' })
    expect((await ask('/alpha.git/info/refs?service=git-upload-pack', credential)).status).toBe(200)
    expect((await ask('/alpha.git/git-upload-pack', credential, 'POST')).status).toBe(200)
    const advert = await ask('/alpha.git/info/refs?service=git-receive-pack', credential)
    expect(advert.status).toBe(403)
    expect(await advert.text()).toContain('may read "alpha" but not push')
    expect((await ask('/alpha.git/git-receive-pack', credential, 'POST')).status).toBe(403)
    expect(created).toEqual(['alpha', 'alpha'])
  })
})

describe('a token that does not verify', () => {
  test('is a 401 with the Basic challenge: expired, wrong key, malformed', async () => {
    const { ask } = deployment()
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const wrongKey = await mintScopedToken(other.privateKey, {
      repo: 'alpha',
      mode: 'write',
      iat: NOW,
      exp: NOW + 600,
    })
    for (const credential of [await token({ exp: NOW - 3600 }), wrongKey, 'eyJx.eyJy.zzzz']) {
      const res = await ask('/alpha.git/info/refs?service=git-upload-pack', credential)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Basic realm="walgit"')
    }
  })
})

describe('without WALGIT_TOKEN_PUBLIC_KEYS', () => {
  test('a scoped token is just an unknown credential, exactly as before', async () => {
    const { ask } = deployment({ keys: undefined })
    const res = await ask('/alpha.git/info/refs?service=git-upload-pack', await token())
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('unauthorized\n')
  })

  test('a public deployment ignores it, exactly as before', async () => {
    const { ask } = deployment({ keys: undefined, public: true })
    const res = await ask('/beta.git/info/refs?service=git-upload-pack', await token())
    expect(res.status).toBe(200)
  })
})

describe('the admin token', () => {
  test('keeps its full reach with scoped tokens on', async () => {
    const { ask } = deployment()
    for (const repo of ['alpha', 'beta']) {
      for (const [path, method] of surfaces(repo)) {
        expect((await ask(path, 'admin-token', method)).status).toBe(200)
      }
    }
  })
})
