/**
 * Revoking a repository's scoped tokens (`shared/token-revocation.ts`,
 * docs/adr/0021).
 *
 * The container's router with the real admin operations over an in-memory
 * store: the revoke endpoint writes `tokens_valid_since` into the Index, and
 * every repository surface a scoped token reaches — clone and push (smart
 * HTTP), the web view (the browse route the pages are rendered from) and
 * provenance (which the MCP tools read through) — refuses a token issued
 * before it. The edge and the event fan-out call `revocationOf`, tested at the
 * bottom against the same store.
 */
import { describe, expect, test } from 'bun:test'

import { capabilitiesFrom } from '../shared/capabilities'
import { parseAnnounce } from '../shared/events'
import { indexKey } from '../shared/keys'
import { BROWSE_PATH, PROVENANCE_PATH } from '../shared/protocol'
import { base64UrlEncode, mintScopedToken, type ScopedClaims } from '../shared/scoped-token'
import { MemoryStore } from '../shared/store'
import { revocationOf, TokenRevocationReader, tokenRevoked } from '../shared/token-revocation'
import { emptyIndex, loadIndex } from '../shared/wal-index'
import { createAdminOps, parseRevoke } from './admin'
import { createHttpHandler, type BrowseReads } from './http'
import { commitIndex } from './wal-index'

const ADMIN = 'admin-token'
const START_MS = Date.UTC(2026, 10, 11, 12, 0, 0)

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const PUBLIC_KEY = base64UrlEncode(
  new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
)

const browse: BrowseReads = {
  readIndex: async () => ({ refs: { 'refs/heads/main': 'a'.repeat(40) }, lastPush: null }),
  listTree: async () => [{ name: 'README.md', kind: 'blob', oid: '2'.repeat(40), size: 6 }],
  statBlob: async () => ({ oid: '2'.repeat(40), size: 6 }),
  readBlob: async () => new TextEncoder().encode('hello\n'),
  listCommits: async () => [],
}

/** Every repository surface a scoped token reaches in the container. */
const surfaces = (repo: string): [string, string][] => [
  [`/${repo}.git/info/refs?service=git-upload-pack`, 'GET'],
  [`/${repo}.git/git-upload-pack`, 'POST'],
  [`/${repo}.git/info/refs?service=git-receive-pack`, 'GET'],
  [`/${repo}.git/git-receive-pack`, 'POST'],
  [`${PROVENANCE_PATH}?repo=${repo}`, 'GET'],
  [`${BROWSE_PATH}?repo=${repo}&op=refs`, 'GET'],
  [`${BROWSE_PATH}?repo=${repo}&op=tree&ref=refs/heads/main`, 'GET'],
]

async function deployment() {
  const store = new MemoryStore()
  for (const repo of ['alpha', 'beta']) {
    const made = await commitIndex(store, emptyIndex(repo), null)
    if (!made.ok) throw new Error('seed index')
  }
  // One clock for the token checks and the admin's "now", moved by the test.
  let nowMs = START_MS
  const announced: { repo: string; since: string }[] = []
  const reader = new TokenRevocationReader()
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens: [ADMIN],
    public: false,
    capabilities: capabilitiesFrom({ WALGIT_WEB: '1' }),
    scopedTokenKeys: PUBLIC_KEY,
    tokenNow: () => nowMs,
    tokensValidSince: (repoId) => reader.validSince(store, repoId),
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran'),
    readProvenance: async () => ({ provenance: {} }),
    browse,
    admin: createAdminOps({
      store,
      ensureRepo: (repo) => repo,
      syncRepo: async () => undefined,
      graceMs: 60_000,
      now: () => new Date(nowMs),
      announceRevoked: async (repo, since) => {
        announced.push({ repo, since })
      },
    }),
  })
  const ask = (path: string, credential: string | null, method = 'GET', body?: string) =>
    handler(
      new Request(`https://walgit.test${path}`, {
        method,
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
        ...(body === undefined ? {} : { body }),
      }),
    )
  const token = (over: Partial<ScopedClaims> = {}) =>
    mintScopedToken(pair.privateKey, {
      repo: 'alpha',
      mode: 'write',
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600,
      ...over,
    })
  return {
    store,
    ask,
    token,
    announced,
    advance: (ms: number) => {
      nowMs += ms
    },
    revoke: (repo: string, body?: string, credential: string | null = ADMIN) =>
      ask(`/_walgit/admin/repos/${repo}/revoke-tokens`, credential, 'POST', body),
  }
}

describe('revoking alpha', () => {
  test('refuses a token issued before it, 401, on every surface', async () => {
    const d = await deployment()
    const before = await d.token()
    for (const [path, method] of surfaces('alpha')) {
      expect({ path, status: (await d.ask(path, before, method)).status }).toEqual({
        path,
        status: 200,
      })
    }
    d.advance(5_000)
    const revoked = await d.revoke('alpha')
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({
      repo: 'alpha',
      tokensValidSince: new Date(START_MS + 5_000).toISOString(),
    })
    for (const [path, method] of surfaces('alpha')) {
      const res = await d.ask(path, before, method)
      expect({ path, status: res.status }).toEqual({ path, status: 401 })
      expect(res.headers.get('www-authenticate')).toContain('Basic')
      expect(await res.text()).toContain('revoked')
    }
  })

  test('a token issued after it works', async () => {
    const d = await deployment()
    d.advance(5_000)
    await d.revoke('alpha')
    d.advance(1_000)
    const after = await d.token()
    for (const [path, method] of surfaces('alpha')) {
      expect({ path, status: (await d.ask(path, after, method)).status }).toEqual({
        path,
        status: 200,
      })
    }
  })

  test("leaves beta's tokens alone", async () => {
    const d = await deployment()
    const beta = await d.token({ repo: 'beta' })
    d.advance(5_000)
    await d.revoke('alpha')
    for (const [path, method] of surfaces('beta')) {
      expect({ path, status: (await d.ask(path, beta, method)).status }).toEqual({
        path,
        status: 200,
      })
    }
  })

  test('leaves the admin credential alone', async () => {
    const d = await deployment()
    d.advance(5_000)
    await d.revoke('alpha')
    for (const [path, method] of surfaces('alpha')) {
      expect({ path, status: (await d.ask(path, ADMIN, method)).status }).toEqual({
        path,
        status: 200,
      })
    }
  })

  test('is announced so held event sockets close', async () => {
    const d = await deployment()
    d.advance(5_000)
    await d.revoke('alpha')
    expect(d.announced).toEqual([
      { repo: 'alpha', since: new Date(START_MS + 5_000).toISOString() },
    ])
  })
})

describe('the revoke endpoint', () => {
  test('a scoped token cannot call it — even a write token for that repository', async () => {
    const d = await deployment()
    const res = await d.revoke('alpha', undefined, await d.token())
    expect(res.status).toBe(403)
    expect((await loadIndex(d.store, 'alpha')).index.tokens_valid_since).toBeUndefined()
  })

  test('no credential is a 401, and a wrong one too', async () => {
    const d = await deployment()
    expect((await d.revoke('alpha', undefined, null)).status).toBe(401)
    expect((await d.revoke('alpha', undefined, 'nope')).status).toBe(401)
  })

  test('takes a supplied time no later than now, and refuses a later one', async () => {
    const d = await deployment()
    const earlier = new Date(START_MS - 60_000).toISOString()
    const res = await d.revoke('alpha', JSON.stringify({ since: earlier }))
    expect(res.status).toBe(200)
    expect((await res.json()).tokensValidSince).toBe(earlier)
    const later = new Date(START_MS + 60_000).toISOString()
    expect((await d.revoke('alpha', JSON.stringify({ since: later }))).status).toBe(400)
    expect((await d.revoke('alpha', JSON.stringify({ since: 'yesterday' }))).status).toBe(400)
    expect((await d.revoke('alpha', 'not json')).status).toBe(400)
  })

  test('never moves backwards', async () => {
    const d = await deployment()
    await d.revoke('alpha')
    const res = await d.revoke(
      'alpha',
      JSON.stringify({ since: new Date(START_MS - 60_000).toISOString() }),
    )
    expect((await res.json()).tokensValidSince).toBe(new Date(START_MS).toISOString())
  })

  test('is a 404 for a name with no repository, and creates nothing', async () => {
    const d = await deployment()
    expect((await d.revoke('gamma')).status).toBe(404)
    expect(await d.store.get(indexKey('gamma'))).toBeNull()
  })

  test('usage shows tokensValidSince', async () => {
    const d = await deployment()
    const read = async () =>
      (await (await d.ask('/_walgit/admin/repos/alpha/usage', ADMIN)).json()) as {
        tokensValidSince: string | null
      }
    expect((await read()).tokensValidSince).toBeNull()
    await d.revoke('alpha')
    expect((await read()).tokensValidSince).toBe(new Date(START_MS).toISOString())
  })
})

describe('parseRevoke', () => {
  test('empty is now', () => {
    expect(parseRevoke('')).toEqual({ ok: true, since: null })
    expect(parseRevoke('{}')).toEqual({ ok: true, since: null })
  })
  test('refuses a non-string since', () => {
    expect(parseRevoke('{"since": 5}').ok).toBe(false)
    expect(parseRevoke('[]').ok).toBe(false)
  })
})

describe('tokenRevoked', () => {
  test('earlier than since is revoked; at or after is not', () => {
    const since = new Date(START_MS).toISOString()
    expect(tokenRevoked(START_MS / 1000 - 1, since)).toBe(true)
    expect(tokenRevoked(START_MS / 1000, since)).toBe(false)
    expect(tokenRevoked(START_MS / 1000 + 1, since)).toBe(false)
    expect(tokenRevoked(0, null)).toBe(false)
  })
  test('a token minted in the revocation second, but before it, is refused', () => {
    const since = new Date(START_MS + 500).toISOString()
    expect(tokenRevoked(START_MS / 1000, since)).toBe(true)
  })
  test('an instant that does not parse fails closed', () => {
    expect(tokenRevoked(START_MS / 1000, 'garbage')).toBe(true)
  })
})

describe('revocationOf — what the edge and the event fan-out ask', () => {
  const claims = { repo: 'alpha', iat: START_MS / 1000 }

  test('sees a revocation on the very next read, through the etag memo', async () => {
    const store = new MemoryStore()
    await commitIndex(store, emptyIndex('alpha'), null)
    const reader = new TokenRevocationReader()
    expect(await revocationOf(claims, store, reader)).toEqual({ kind: 'valid' })
    // Unchanged: answered from the memo after a not-modified.
    expect(await revocationOf(claims, store, reader)).toEqual({ kind: 'valid' })
    const { index, etag } = await loadIndex(store, 'alpha')
    const since = new Date(START_MS + 1_000).toISOString()
    await commitIndex(store, { ...index, tokens_valid_since: since }, etag)
    expect(await revocationOf(claims, store, reader)).toEqual({ kind: 'revoked', since })
  })

  test('a repository with no Index revokes nothing', async () => {
    const reader = new TokenRevocationReader()
    expect(await revocationOf(claims, new MemoryStore(), reader)).toEqual({ kind: 'valid' })
  })

  test('no store, or a store that fails, is unknown — never valid', async () => {
    const reader = new TokenRevocationReader()
    expect((await revocationOf(claims, null, reader)).kind).toBe('unknown')
    const broken = new MemoryStore()
    broken.get = async () => {
      throw new Error('bucket down')
    }
    expect((await revocationOf(claims, broken, reader)).kind).toBe('unknown')
  })
})

describe('the tokensRevoked announcement', () => {
  test('parses, and defaults to empty', () => {
    const since = new Date(START_MS).toISOString()
    const parsed = parseAnnounce({ events: [], tokensRevoked: [{ repo: 'alpha', since }] })
    expect(parsed.ok && parsed.value.tokensRevoked).toEqual([{ repo: 'alpha', since }])
    const bare = parseAnnounce({ events: [] })
    expect(bare.ok && bare.value.tokensRevoked).toEqual([])
  })

  test('refuses a bad name or instant', () => {
    expect(parseAnnounce({ events: [], tokensRevoked: [{ repo: '../x', since: 'x' }] }).ok).toBe(
      false,
    )
    expect(parseAnnounce({ events: [], tokensRevoked: [{ repo: 'alpha', since: 'x' }] }).ok).toBe(
      false,
    )
    expect(parseAnnounce({ events: [], tokensRevoked: 'alpha' }).ok).toBe(false)
  })
})
