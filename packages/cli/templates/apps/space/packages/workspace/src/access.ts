// Who is asking: a Cloudflare Access assertion, VERIFIED here, then looked up as a person of this install.
//
// The one copy of the check. It began as packages/forms/src/access.ts (itself npo's, from tax's), kept to WebCrypto
// with no dependencies, and takes meet's `exp`. Meet's, forms' and the inbox's own copies are gone (S6, S7, S8).
// It reads the Access header only, never a cookie.
//
// Access is an edge control, so the edge's word is not taken for it: every request must carry an RS256 JWT signed
// by the team's published keys, for THIS application's audience, unexpired. FAILS CLOSED at every step. No audience
// configured refuses everyone, real assertion included: a missing audience that meant "do not check it" would
// accept an assertion minted for any app in the organisation. A slow or broken key server is a refusal, not a wait.
//
// A person is decided by sign-in address and ONLY by it. A service token (a common name, no address) is never a
// person; a token is admitted only where the caller says it takes one (`allowServiceTokens`), and then comes back
// as a service, for the app to match against its own token id. An assertion naming both is not something Access
// issues, and is refused.

import type { Person } from './declaration'
import type { Install } from './install'
import { TEAM_DOMAIN } from './declaration'

export type Http = (url: string, init: RequestInit) => Promise<Response>

export interface AccessDeps {
  fetch: Http
  /** This application's audience tag, deployed as the var CF_ACCESS_AUD. */
  aud: string
  /** Milliseconds since the epoch. */
  now: number
}

export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion'
export const JWKS_TTL_MS = 60 * 60 * 1000
/** A forged kid costs at most one key fetch a minute. */
export const JWKS_MIN_REFRESH_MS = 60 * 1000
export const JWKS_TIMEOUT_MS = 3000
export const ASSERTION_MAX = 8192
export const AUD_TAG = /^[0-9a-f]{64}$/

export const jwksUrl = (teamDomain: string) => `https://${teamDomain}/cdn-cgi/access/certs`
export const issuerOf = (teamDomain: string) => `https://${teamDomain}`

/** What a verified assertion says. `exp` is in seconds. */
export type AccessVerdict =
  | { kind: 'ok'; email: string | null; commonName: string | null; exp: number }
  | { kind: 'refused'; why: string }

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  n?: string
  e?: string
}

const cache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>()
/** When a key fetch was last tried per team, success or failure, so a failing key endpoint is hit once a minute at most. */
const attempts = new Map<string, number>()
/**
 * The key fetch under way per team, so requests arriving while it runs wait for it instead of being rate-limited. An entry
 * older than JWKS_TIMEOUT_MS is dead (the request that started it was cancelled, and a cancelled fetch may never settle).
 */
const inflight = new Map<string, { at: number; promise: Promise<Map<string, CryptoKey> | null> }>()

/** For the suite, which counts fetches. */
export function resetJwksCache(): void {
  cache.clear()
  attempts.clear()
  inflight.clear()
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const b64urlToJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(fromB64Url(s)))

async function readKeys(teamDomain: string, deps: AccessDeps): Promise<Map<string, CryptoKey> | null> {
  let res: Response
  try {
    res = await deps.fetch(jwksUrl(teamDomain), { method: 'GET', signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) })
  } catch {
    return null
  }
  if (res.status !== 200) return null
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  const list = (body as { keys?: unknown }).keys
  if (!Array.isArray(list)) return null
  const keys = new Map<string, CryptoKey>()
  for (const k of list as Jwk[]) {
    if (typeof k.kid !== 'string' || k.kty !== 'RSA' || typeof k.n !== 'string' || typeof k.e !== 'string') continue
    if (k.alg !== undefined && k.alg !== 'RS256') continue
    try {
      keys.set(
        k.kid,
        await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      )
    } catch {
      // A key that will not import is one we cannot verify with; skip it.
    }
  }
  return keys
}

async function keyFor(kid: string, teamDomain: string, deps: AccessDeps): Promise<CryptoKey | null> {
  const held = cache.get(teamDomain)
  if (held && deps.now - held.at < JWKS_TTL_MS) {
    const key = held.keys.get(kid)
    if (key) return key
  }
  // The last good keys outlive their hour: a refresh that is rate-limited or fails (a blip at the key server, right after the
  // cache expired) must not shut every request, so the held keys answer until a fetch succeeds. A key Cloudflare has since
  // retired still verifies nothing past its assertions' own expiry, which is checked first.
  const stale = held?.keys.get(kid) ?? null
  // A fetch already under way answers every caller that arrives while it runs. Without this the first caller's attempt stamp
  // would rate-limit the rest (a freshly started isolate, several calls at once) into the stale answer, null on an empty cache.
  // Every caller, the starter included, waits no longer than the fetch's own timeout: the request that started it can be
  // cancelled (a reload, a cancelled service-binding call) and leave it unsettled, and a slow or broken key server is a
  // refusal, not a wait.
  const running = inflight.get(teamDomain)
  const live = running !== undefined && deps.now - running.at < JWKS_TIMEOUT_MS
  const fresh = await within(live ? running.promise : startFetch(teamDomain, deps, running !== undefined), JWKS_TIMEOUT_MS + 500) // a margin past the fetch's own timeout, for reading and importing the keys
  return fresh === null ? stale : (fresh.get(kid) ?? null)
}

type Keys = Map<string, CryptoKey>

/**
 * Begin a key fetch, unless one was tried within the last minute (a null answer, which keyFor takes as stale). A dead
 * entry's replacement (`replacing`) skips that minute: its attempt never answered, so it was not a failed one.
 */
function startFetch(teamDomain: string, deps: AccessDeps, replacing: boolean): Promise<Keys | null> {
  const last = attempts.get(teamDomain)
  if (!replacing && last !== undefined && deps.now - last < JWKS_MIN_REFRESH_MS) return Promise.resolve(null)
  attempts.set(teamDomain, deps.now)
  const entry = {
    at: deps.now,
    promise: readKeys(teamDomain, deps)
      .then((keys) => {
        if (keys !== null) cache.set(teamDomain, { at: deps.now, keys })
        return keys
      })
      .finally(() => {
        // Only this fetch's own entry: a dead one's replacement, or a reset, may have taken the slot.
        if (inflight.get(teamDomain) === entry) inflight.delete(teamDomain)
      }),
  }
  inflight.set(teamDomain, entry)
  return entry.promise
}

/** The promise's answer, or null when it has not settled in `ms`. */
async function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

const label = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null)

/** Check one assertion against a team domain: shape, algorithm, issuer, audience, expiry, then the signature. */
export async function verifyAssertion(jwt: string, teamDomain: string, deps: AccessDeps): Promise<AccessVerdict> {
  if (!TEAM_DOMAIN.test(teamDomain)) return { kind: 'refused', why: 'team domain unconfigured' }
  if (!AUD_TAG.test(deps.aud)) return { kind: 'refused', why: 'audience unconfigured' }
  if (jwt.length === 0 || jwt.length > ASSERTION_MAX) return { kind: 'refused', why: 'shape' }
  const parts = jwt.split('.')
  if (parts.length !== 3) return { kind: 'refused', why: 'shape' }
  const [h, p, s] = parts as [string, string, string]

  let header: { alg?: unknown; kid?: unknown }
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown; common_name?: unknown }
  try {
    header = b64urlToJson(h) as typeof header
    claims = b64urlToJson(p) as typeof claims
  } catch {
    return { kind: 'refused', why: 'shape' }
  }
  if (header === null || typeof header !== 'object' || claims === null || typeof claims !== 'object') {
    return { kind: 'refused', why: 'shape' }
  }
  if (header.alg !== 'RS256') return { kind: 'refused', why: 'alg' }
  if (typeof header.kid !== 'string' || header.kid === '') return { kind: 'refused', why: 'kid' }

  // Claims before the signature: they are free, and a token for another application need not cost a key fetch.
  if (claims.iss !== issuerOf(teamDomain)) return { kind: 'refused', why: 'iss' }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!auds.includes(deps.aud)) return { kind: 'refused', why: 'aud' }
  const nowS = Math.floor(deps.now / 1000)
  if (typeof claims.exp !== 'number' || !(claims.exp > nowS)) return { kind: 'refused', why: 'exp' }
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowS)) {
    return { kind: 'refused', why: 'nbf' }
  }

  const key = await keyFor(header.kid, teamDomain, deps)
  if (key === null) return { kind: 'refused', why: 'keys' }
  let good = false
  try {
    good = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, fromB64Url(s), new TextEncoder().encode(`${h}.${p}`))
  } catch {
    good = false
  }
  if (!good) return { kind: 'refused', why: 'signature' }

  return { kind: 'ok', email: label(claims.email), commonName: label(claims.common_name), exp: claims.exp }
}

/**
 * The assertion on a request: the header Access sets on everything it proxies, and nothing else. A cookie is never read:
 * Access sets the header only on a request it let through, so the header is the proof the edge's door was passed; a
 * cookie arrives on any path, including a spelling of one Access does not cover, and would let a session revoked in
 * Zero Trust keep working there. Not evidence of anything until it is verified.
 */
export function assertionFrom(headers: Headers): string | null {
  const header = headers.get(ACCESS_ASSERTION_HEADER)
  return header ? header : null
}

/** Who a verified assertion is: a person of this install, or (where the caller allows it) a service token. `exp` is in seconds. */
export type Identity =
  | { kind: 'person'; person: Person; exp: number }
  | { kind: 'service'; commonName: string; exp: number }

export type Refusal =
  | 'no-assertion'
  | 'invalid'
  | 'ambiguous'
  | 'service-token'
  | 'not-a-person-here'

export type Outcome = { ok: true; identity: Identity } | { ok: false; refusal: Refusal; detail: string }

/** The status a refusal is answered with: 401 for no proof or a proof that does not verify, 403 for a verified one that is not let in here. */
export const refusalStatus = (refusal: Refusal): 401 | 403 => (refusal === 'no-assertion' || refusal === 'invalid' ? 401 : 403)

/**
 * The identity of the request's sender in this install, or the reason there is none. `detail` is for the Worker tail
 * and is never for a response body: a visitor learns nothing from the difference between refusals.
 *
 * A person of another install, or of none, is `not-a-person-here`, even when Cloudflare signed their assertion.
 */
export async function identify(
  install: Install,
  headers: Headers,
  deps: AccessDeps,
  options: { allowServiceTokens?: boolean } = {},
): Promise<Outcome> {
  return identifyAssertion(install, assertionFrom(headers), deps, options)
}

/**
 * `identify` for an assertion that did not arrive as a request header: the one the space received and passes on to an app
 * over a service binding (`src/asking.ts`). The same checks in the same order, so a caller holding the string gets exactly
 * the verdict a request carrying it as the header would. `null` is no assertion.
 */
export async function identifyAssertion(
  install: Install,
  jwt: string | null,
  deps: AccessDeps,
  options: { allowServiceTokens?: boolean } = {},
): Promise<Outcome> {
  if (jwt === null || jwt === '') return { ok: false, refusal: 'no-assertion', detail: 'no Access assertion on the request' }
  const verdict = await verifyAssertion(jwt, install.teamDomain, deps)
  if (verdict.kind === 'refused') return { ok: false, refusal: 'invalid', detail: `assertion refused: ${verdict.why}` }
  if (verdict.email && verdict.commonName) return { ok: false, refusal: 'ambiguous', detail: 'an assertion naming a person and a token' }
  if (verdict.commonName) {
    if (!options.allowServiceTokens) return { ok: false, refusal: 'service-token', detail: 'a service token where only people may come' }
    return { ok: true, identity: { kind: 'service', commonName: verdict.commonName, exp: verdict.exp } }
  }
  const person = install.personBySignIn(verdict.email)
  if (person === null) return { ok: false, refusal: 'not-a-person-here', detail: 'verified, but not a person of this install' }
  return { ok: true, identity: { kind: 'person', person, exp: verdict.exp } }
}
