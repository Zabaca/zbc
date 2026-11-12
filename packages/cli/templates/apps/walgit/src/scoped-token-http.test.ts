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
import { BROWSE_PATH, PROVENANCE_PATH, READ_CHALLENGE_SCHEME } from '../shared/protocol'
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

describe('what the container does not judge per message', () => {
  test('the MCP and event-stream paths are refused, not let through', async () => {
    const { ask } = deployment()
    for (const path of ['/_walgit/mcp', '/_walgit/events']) {
      expect((await ask(path, await token())).status).toBe(403)
    }
  })
})

describe('a Private repository', () => {
  test('is not opened by a scoped token for it: the Read Challenge still stands', async () => {
    const { ask } = deployment({
      public: true,
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
    const res = await ask('/alpha.git/info/refs?service=git-upload-pack', await token())
    expect(res.status).toBe(401)
    // The challenge a Private repository answers, not the scoped-token refusal.
    expect(res.headers.get('www-authenticate')).toContain(READ_CHALLENGE_SCHEME)
  })
})

/**
 * Per-source rate limits, keyed on the tenant (`src/rate-limit.ts`). Hosted
 * agents share cloud addresses, so a verified token's `sub` is the bucket when
 * it carries one, and the address is when it does not.
 */
describe('rate limits with scoped tokens', () => {
  function limitedDeployment(env: CapabilityEnv = { WALGIT_MAX_PUSHES_PER_SOURCE: '1' }) {
    const refusals: (string | undefined)[] = []
    const handler = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['admin-token'],
      capabilities: capabilitiesFrom(env),
      scopedTokenKeys: PUBLIC_KEY,
      tokenNow: () => NOW_MS,
      ensureRepo: (repo) => repo,
      runBackend: async (req) => {
        refusals.push(req.env?.WALGIT_REFUSE)
        return new Response('backend ran')
      },
    })
    const push = (repo: string, credential: string, ip?: string) =>
      handler(
        new Request(`https://walgit.test/${repo}.git/git-receive-pack`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential}`,
            ...(ip ? { 'cf-connecting-ip': ip } : {}),
          },
          body: '0000',
        }),
      )
    return { push, refusals }
  }

  test('two tenants on one address get separate buckets', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token({ sub: 'tenant-a' }), '203.0.113.7')
    await push('alpha', await token({ sub: 'tenant-b' }), '203.0.113.7')
    expect(refusals).toEqual([undefined, undefined])
    await push('alpha', await token({ sub: 'tenant-a' }), '203.0.113.7')
    expect(refusals[2]).toContain('one tenant push 1 time')
    expect(refusals[2]).toContain("Counted per tenant (your token's sub)")
  })

  test('one tenant on two addresses, across two repositories, shares one bucket', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token({ sub: 'tenant-a' }), '203.0.113.7')
    await push('beta', await token({ repo: 'beta', sub: 'tenant-a' }), '198.51.100.4')
    expect(refusals[0]).toBeUndefined()
    expect(refusals[1]).toContain('walgit: refused')
  })

  test('a tenant is counted even where no address is visible', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token({ sub: 'tenant-a' }))
    await push('alpha', await token({ sub: 'tenant-a' }))
    expect(refusals[1]).toContain('walgit: refused')
  })

  test('a token without sub falls back to its address', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token(), '203.0.113.7')
    await push('beta', await token({ repo: 'beta' }), '198.51.100.4')
    // Same address as the first: one bucket, and the message is the per-client one.
    await push('alpha', await token(), '203.0.113.7')
    expect(refusals[0]).toBeUndefined()
    expect(refusals[1]).toBeUndefined()
    expect(refusals[2]).toContain('one client push 1 time')
    expect(refusals[2]).not.toContain('per tenant')
  })

  test('a sub never shares a bucket with the address it spells', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token(), '203.0.113.7')
    await push('alpha', await token({ sub: '203.0.113.7' }), '198.51.100.4')
    expect(refusals).toEqual([undefined, undefined])
  })

  test('the admin credential is counted by address, as before', async () => {
    const { push, refusals } = limitedDeployment()
    await push('alpha', await token({ sub: 'tenant-a' }), '203.0.113.7')
    await push('alpha', 'admin-token', '203.0.113.7')
    await push('alpha', 'admin-token', '203.0.113.7')
    expect(refusals[0]).toBeUndefined()
    expect(refusals[1]).toBeUndefined()
    expect(refusals[2]).toContain('one client push 1 time')
  })

  test('with no limit set, tenants are not counted at all', async () => {
    const { push, refusals } = limitedDeployment({})
    for (let i = 0; i < 5; i++) await push('alpha', await token({ sub: 'tenant-a' }), '203.0.113.7')
    expect(refusals.every((r) => r === undefined)).toBe(true)
  })
})
