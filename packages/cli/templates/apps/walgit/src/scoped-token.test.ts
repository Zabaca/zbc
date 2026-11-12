/**
 * The scoped-token verifier (`shared/scoped-token.ts`, docs/adr/0021).
 *
 * Real keys, real signatures: every token here is minted with WebCrypto's
 * Ed25519 exactly as an issuer would, so a test that passes is a token a real
 * issuer's library would produce and a real deployment would judge the same.
 */
import { describe, expect, test } from 'bun:test'

import {
  base64UrlEncode,
  mintScopedToken,
  parseTokenPublicKeys,
  type ScopedClaims,
  SCOPED_TOKEN_SKEW_SECONDS,
  scopeAllowsRead,
  scopedAccessOf,
  scopedEdgeAnswer,
  scopeRefusal,
  scopeTargetOf,
  tokenPublicKeysConfigError,
  verifyScopedToken,
} from '../shared/scoped-token'

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0)
const NOW = NOW_MS / 1000

async function keypair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: base64UrlEncode(raw) }
}

const issuer = await keypair()
const stranger = await keypair()

const claims = (over: Partial<ScopedClaims> = {}): ScopedClaims => ({
  repo: 'alpha',
  mode: 'write',
  iat: NOW - 10,
  exp: NOW + 3600,
  ...over,
})

const mint = (over: Partial<ScopedClaims> = {}, key = issuer.privateKey) =>
  mintScopedToken(key, claims(over))

const segment = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))

describe('verifyScopedToken', () => {
  test('accepts a good token and returns its claims, sub included', async () => {
    const token = await mint({ sub: 'tenant-1' })
    expect(await verifyScopedToken(token, issuer.publicKey, NOW_MS)).toEqual({
      ok: true,
      claims: claims({ sub: 'tenant-1' }),
    })
  })

  test('accepts a token signed by any configured key, so a key can rotate', async () => {
    const token = await mint({}, stranger.privateKey)
    const result = await verifyScopedToken(
      token,
      `${issuer.publicKey}, ${stranger.publicKey}`,
      NOW_MS,
    )
    expect(result.ok).toBe(true)
  })

  test('refuses an expired token, allowing the fixed skew and no more', async () => {
    const justExpired = await mint({ exp: NOW - SCOPED_TOKEN_SKEW_SECONDS + 1 })
    expect((await verifyScopedToken(justExpired, issuer.publicKey, NOW_MS)).ok).toBe(true)
    const expired = await mint({ exp: NOW - SCOPED_TOKEN_SKEW_SECONDS })
    expect(await verifyScopedToken(expired, issuer.publicKey, NOW_MS)).toEqual({
      ok: false,
      reason: 'token has expired',
    })
  })

  test('refuses a token whose iat is in the future beyond the skew', async () => {
    const withinSkew = await mint({ iat: NOW + SCOPED_TOKEN_SKEW_SECONDS })
    expect((await verifyScopedToken(withinSkew, issuer.publicKey, NOW_MS)).ok).toBe(true)
    const future = await mint({ iat: NOW + SCOPED_TOKEN_SKEW_SECONDS + 1 })
    expect(await verifyScopedToken(future, issuer.publicKey, NOW_MS)).toEqual({
      ok: false,
      reason: 'token iat is in the future',
    })
  })

  test('refuses a bad signature', async () => {
    const token = await mint()
    const [h, p, s] = token.split('.') as [string, string, string]
    const flipped = `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`
    expect(await verifyScopedToken(`${h}.${p}.${flipped}`, issuer.publicKey, NOW_MS)).toEqual({
      ok: false,
      reason: 'token signature does not verify',
    })
    // A payload swapped under a valid signature is the same failure.
    const other = segment(claims({ repo: 'beta' }))
    expect((await verifyScopedToken(`${h}.${other}.${s}`, issuer.publicKey, NOW_MS)).ok).toBe(false)
  })

  test('refuses a token signed by a key that is not configured', async () => {
    const token = await mint({}, stranger.privateKey)
    expect(await verifyScopedToken(token, issuer.publicKey, NOW_MS)).toEqual({
      ok: false,
      reason: 'token signature does not verify',
    })
  })

  test('refuses malformed tokens with a reason, never a throw', async () => {
    const good = await mint()
    const [h, p] = good.split('.') as [string, string, string]
    for (const token of [
      '',
      'abc',
      'a.b',
      'a.b.c.d',
      `${h}.${p}.`,
      `!!.${p}.sig`,
      `${segment('just a string')}.${p}.${'A'.repeat(86)}`,
      `${base64UrlEncode(new TextEncoder().encode('{not json'))}.${p}.${'A'.repeat(86)}`,
      // A signature of the wrong length is malformed rather than "does not verify".
      `${h}.${p}.${'A'.repeat(10)}`,
    ]) {
      const result = await verifyScopedToken(token, issuer.publicKey, NOW_MS)
      expect(result.ok).toBe(false)
    }
  })

  test('refuses every alg but EdDSA — none and HMAC confusion included', async () => {
    for (const header of [
      { alg: 'none' },
      { alg: 'HS256' },
      { alg: 'RS256' },
      { alg: 'ES256' },
      { alg: 'eddsa' },
      {},
    ]) {
      // Signed with the right key over the forged header, so the ONLY thing
      // wrong with the token is the algorithm it names.
      const signingInput = `${segment(header)}.${segment(claims())}`
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          issuer.privateKey,
          new TextEncoder().encode(signingInput),
        ),
      )
      const result = await verifyScopedToken(
        `${signingInput}.${base64UrlEncode(sig)}`,
        issuer.publicKey,
        NOW_MS,
      )
      expect(result).toEqual({ ok: false, reason: 'token alg must be EdDSA' })
    }
    // `alg: none` with an empty signature does not even have a JWT's shape here.
    const unsigned = `${segment({ alg: 'none' })}.${segment(claims())}.`
    expect((await verifyScopedToken(unsigned, issuer.publicKey, NOW_MS)).ok).toBe(false)
  })

  test('refuses a header naming crit extensions it does not implement', async () => {
    const token = await mintScopedToken(issuer.privateKey, claims(), { crit: ['exp'] })
    expect((await verifyScopedToken(token, issuer.publicKey, NOW_MS)).ok).toBe(false)
  })

  test('refuses missing or ill-typed claims', async () => {
    for (const bad of [
      { repo: undefined },
      { repo: 'team/alpha' },
      { repo: 'alpha*' },
      { repo: 'alpha.git' },
      { mode: 'admin' },
      { mode: undefined },
      { exp: undefined },
      { exp: '9999999999' },
      { iat: undefined },
      { sub: 42 },
    ]) {
      const token = await mintScopedToken(issuer.privateKey, {
        ...claims(),
        ...bad,
      } as unknown as ScopedClaims)
      const result = await verifyScopedToken(token, issuer.publicKey, NOW_MS)
      expect(result.ok).toBe(false)
    }
  })
})

describe('the key list', () => {
  test('parses comma-separated base64url raw keys and drops blanks', () => {
    expect(parseTokenPublicKeys(` ${issuer.publicKey}, ,${stranger.publicKey} `)).toHaveLength(2)
    expect(parseTokenPublicKeys(undefined)).toEqual([])
  })

  test('names a malformed entry rather than ignoring it', () => {
    expect(tokenPublicKeysConfigError(`${issuer.publicKey},nope`)).toContain('entry 2')
    expect(tokenPublicKeysConfigError(issuer.publicKey)).toBeNull()
  })
})

describe('scopedAccessOf', () => {
  const config = { keys: issuer.publicKey, known: ['admin.token.value'], now: () => NOW_MS }

  test('is unscoped for every request while the keys are unset', async () => {
    const token = await mint()
    for (const keys of [undefined, '', '  ']) {
      expect(await scopedAccessOf(`Bearer ${token}`, { ...config, keys })).toEqual({
        kind: 'unscoped',
      })
    }
  })

  test('reads the token from Bearer or from the Basic password', async () => {
    const token = await mint()
    for (const authorization of [
      `Bearer ${token}`,
      `Basic ${btoa(`walgit:${token}`)}`,
      `Basic ${btoa(`anything-at-all:${token}`)}`,
    ]) {
      const access = await scopedAccessOf(authorization, config)
      expect(access.kind).toBe('scoped')
    }
  })

  test('leaves what is not a scoped token to the rules that were there before', async () => {
    for (const authorization of [
      null,
      'Bearer some-admin-token',
      // An admin token that happens to have a JWT's shape keeps its full reach.
      'Bearer admin.token.value',
      // A Read Challenge credential: fingerprint and armoured signature.
      `Basic ${btoa('SHA256:abc:LS0tLS1CRUdJTiBTU0ggU0lHTkFUVVJF')}`,
    ]) {
      expect(await scopedAccessOf(authorization, config)).toEqual({ kind: 'unscoped' })
    }
  })

  test('is invalid for a JWT-shaped credential that does not verify', async () => {
    const access = await scopedAccessOf(`Bearer ${await mint({ exp: NOW - 3600 })}`, config)
    expect(access).toEqual({ kind: 'invalid', reason: 'token has expired' })
  })

  test('is misconfigured, never accepted, when the deployment key list is malformed', async () => {
    const access = await scopedAccessOf(`Bearer ${await mint()}`, { ...config, keys: 'nope' })
    expect(access.kind).toBe('misconfigured')
  })
})

describe('scope', () => {
  const write = claims()
  const read = claims({ mode: 'read' })

  test('names the repository every surface reaches', () => {
    const cases: [string, string, string, ReturnType<typeof scopeTargetOf>][] = [
      [
        'GET',
        '/alpha.git/info/refs',
        '?service=git-upload-pack',
        { kind: 'repo', repo: 'alpha', write: false },
      ],
      [
        'GET',
        '/alpha.git/info/refs',
        '?service=git-receive-pack',
        { kind: 'repo', repo: 'alpha', write: true },
      ],
      ['POST', '/alpha.git/git-upload-pack', '', { kind: 'repo', repo: 'alpha', write: false }],
      ['POST', '/alpha.git/git-receive-pack', '', { kind: 'repo', repo: 'alpha', write: true }],
      // `.git` is a suffix the client chooses: judged as the id it serves.
      ['POST', '/alpha.git.git/git-receive-pack', '', { kind: 'repo', repo: 'alpha', write: true }],
      ['GET', '/alpha.git/proposals', '', { kind: 'repo', repo: 'alpha', write: false }],
      ['GET', '/_walgit/provenance', '?repo=alpha', { kind: 'repo', repo: 'alpha', write: false }],
      [
        'GET',
        '/_walgit/browse',
        '?repo=alpha&op=refs',
        { kind: 'repo', repo: 'alpha', write: false },
      ],
      ['GET', '/alpha', '', { kind: 'repo', repo: 'alpha', write: false }],
      ['GET', '/alpha/raw/main/README.md', '', { kind: 'repo', repo: 'alpha', write: false }],
      ['GET', '/repos', '', { kind: 'list' }],
      ['POST', '/_walgit/mcp', '', { kind: 'per-message' }],
      ['GET', '/_walgit/events', '', { kind: 'per-message' }],
      ['GET', '/_walgit/provenance', '', { kind: 'elsewhere' }],
      ['POST', '/_walgit/announce', '', { kind: 'elsewhere' }],
      ['GET', '/_walgit/challenge', '', { kind: 'elsewhere' }],
    ]
    for (const [method, pathname, search, expected] of cases) {
      expect(scopeTargetOf(method, pathname, search)).toEqual(expected)
    }
  })

  test('a write token reaches its own repository, reading and pushing', () => {
    expect(scopeRefusal(write, { kind: 'repo', repo: 'alpha', write: true })).toBeNull()
    expect(scopeRefusal(write, { kind: 'repo', repo: 'alpha', write: false })).toBeNull()
  })

  test('another repository is a 403, by exact name — no prefix reaches it', () => {
    for (const repo of ['beta', 'alpha2', 'alph', 'Alpha']) {
      expect(scopeRefusal(write, { kind: 'repo', repo, write: false })?.status).toBe(403)
    }
  })

  test('a read token pushing is a 403', () => {
    expect(scopeRefusal(read, { kind: 'repo', repo: 'alpha', write: true })?.status).toBe(403)
    expect(scopeRefusal(read, { kind: 'repo', repo: 'alpha', write: false })).toBeNull()
  })

  test('anywhere else is a 403, even where an anonymous request is served', () => {
    expect(scopeRefusal(write, { kind: 'elsewhere' })?.status).toBe(403)
  })

  test('per-message surfaces judge each name', () => {
    expect(scopeAllowsRead(write, 'alpha')).toBe(true)
    expect(scopeAllowsRead(write, 'alpha.git')).toBe(true)
    expect(scopeAllowsRead(write, 'beta')).toBe(false)
  })
})

describe('scopedEdgeAnswer', () => {
  const target = { kind: 'repo', repo: 'alpha', write: true } as const

  test('passes every unscoped request through untouched', () => {
    expect(scopedEdgeAnswer({ kind: 'unscoped' }, { kind: 'elsewhere' })).toBeNull()
  })

  test('401 with the Basic challenge for a token that does not verify', async () => {
    const res = scopedEdgeAnswer({ kind: 'invalid', reason: 'token has expired' }, target)!
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="walgit"')
    expect(await res.text()).toBe('walgit: token has expired\n')
  })

  test('503 for a malformed key list, 403 out of scope, nothing in scope', () => {
    expect(scopedEdgeAnswer({ kind: 'misconfigured', reason: 'x' }, target)!.status).toBe(503)
    const read = { kind: 'scoped', claims: claims({ mode: 'read' }) } as const
    expect(scopedEdgeAnswer(read, target)!.status).toBe(403)
    expect(scopedEdgeAnswer({ kind: 'scoped', claims: claims() }, target)).toBeNull()
  })
})
