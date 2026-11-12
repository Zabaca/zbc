/**
 * Scoped tokens: a credential for one repository, minted by somebody else
 * (docs/adr/0021).
 *
 * An issuer holding an Ed25519 private key signs a compact JWT that grants
 * `read` or `write` on exactly one repository name, for a short time. walgit
 * holds only the public half (`WALGIT_TOKEN_PUBLIC_KEYS`), so a walgit that is
 * compromised can refuse and accept tokens but can never make one.
 *
 * Runtime-neutral, like `credentials.ts` beside it, because both halves ask the
 * same question: the edge Worker verifies BEFORE it wakes the container, so a
 * bad credential never costs a cold start, and the container verifies again on
 * what reaches it, so a request that did not come through the edge is held to
 * the same rule. WebCrypto's Ed25519 is a standard global in bun and in the
 * Workers runtime alike; nothing here touches a buffer, a socket or a disk.
 *
 * ── what counts as a scoped token ───────────────────────────────────────────
 *
 * A credential is judged here only when ALL of these hold: the deployment set
 * `WALGIT_TOKEN_PUBLIC_KEYS`, the credential is JWT-shaped (three base64url
 * segments), and it is not one of the deployment's own secrets (the admin
 * tokens, the announce secret). Everything else takes exactly the path it took
 * before this file existed — which is what "off unless set" means, and why an
 * admin token that happens to contain two dots keeps its full reach.
 */

import { constantTimeEquals, presentedCredential } from './credentials'
import { seedValue } from './policy'
import {
  BASIC_CHALLENGE,
  BROWSE_PATH,
  MERGE_PATH,
  EVENTS_PATH,
  MCP_PATH,
  PROPOSALS_HTTP,
  PROVENANCE_PATH,
  REPO_ID,
  REPOS_PATH,
  SMART_HTTP,
  wantsBrowse,
} from './protocol'

/** The only `alg` accepted. `none`, `HS256` and everything else are refused. */
export const SCOPED_TOKEN_ALG = 'EdDSA'

/**
 * How far apart the issuer's clock and this one may be, in seconds.
 *
 * Applied both ways: a token is still honoured this long after `exp`, and one
 * whose `iat` is up to this far in the future is not yet refused for it.
 */
export const SCOPED_TOKEN_SKEW_SECONDS = 60

export type ScopedMode = 'read' | 'write'

/** What a verified token says. */
export interface ScopedClaims {
  /** The one repository it is for — an exact name, never a prefix or a pattern. */
  repo: string
  mode: ScopedMode
  /** Seconds since the epoch. */
  exp: number
  /** Seconds since the epoch. Kept so a later revocation can cut on it. */
  iat: number
  /** The tenant, when the issuer named one. */
  sub?: string
}

export type VerifyResult = { ok: true; claims: ScopedClaims } | { ok: false; reason: string }

/** Three base64url segments. The signature segment of a JWT is never empty here. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** An Ed25519 public key, raw, is exactly this long. So is half a signature. */
const ED25519_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64

/** Is this deployment configured to accept scoped tokens at all? */
export function scopedTokensEnabled(raw: string | undefined): boolean {
  return seedValue(raw) !== null
}

/** Could this credential be a scoped token? Shape only — nothing is verified. */
export function looksLikeScopedToken(credential: string): boolean {
  return JWT_SHAPE.test(credential)
}

/**
 * Decode base64url (no padding) to bytes, or `null`.
 *
 * Strict about the alphabet because the shape check upstream already is, and
 * about length because `atob` accepts padding a base64url string never has.
 */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // Canonical only. `atob` ignores the spare low bits of the last character,
  // so without this sixteen spellings of one signature would all verify — and
  // anything later keyed on the token string (a cache, a denylist) could be
  // stepped around by re-spelling it.
  return base64UrlEncode(bytes) === text ? bytes : null
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The configured public keys, raw.
 *
 * Comma-separated, like `WALGIT_HTTP_TOKENS`, so a key can be rotated without a
 * window where neither the old nor the new one verifies. Each entry is the
 * key's 32 raw bytes in base64url — the `x` of its JWK, and what `walgit token
 * keygen` prints. A malformed entry THROWS rather than being dropped: a key the
 * operator meant to configure and walgit silently ignored is a rotation that
 * did not happen.
 */
export function parseTokenPublicKeys(raw: string | undefined): Uint8Array<ArrayBuffer>[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.map((entry, i) => {
    const bytes = base64UrlDecode(entry)
    if (!bytes || bytes.length !== ED25519_KEY_BYTES) {
      throw new Error(
        `walgit: WALGIT_TOKEN_PUBLIC_KEYS entry ${i + 1} is not an Ed25519 public key (expected 32 raw bytes, base64url)`,
      )
    }
    return bytes
  })
}

/** A configuration problem, stated once, or `null`. For boot-time checks. */
export function tokenPublicKeysConfigError(raw: string | undefined): string | null {
  try {
    parseTokenPublicKeys(raw)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/**
 * Imported keys, per configured value. The environment is fixed for an isolate
 * or a process's life, so this is read once rather than per request.
 */
const imported = new Map<string, Promise<CryptoKey[]>>()

function importedKeys(raw: string): Promise<CryptoKey[]> {
  let keys = imported.get(raw)
  if (!keys) {
    keys = Promise.all(
      parseTokenPublicKeys(raw).map((bytes) =>
        crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']),
      ),
    )
    // A failed import is not cached: the next request reports it again rather
    // than inheriting a rejected promise forever.
    keys.catch(() => imported.delete(raw))
    imported.set(raw, keys)
  }
  return keys
}

function jsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment)
  if (!bytes) return null
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Verify one token against the configured keys.
 *
 * The signature is checked BEFORE any claim, so a forged token is told it is
 * forged and never learns whether its claims would have passed. Every refusal
 * is a reason a client can act on; none of them is a 500.
 */
export async function verifyScopedToken(
  token: string,
  keysRaw: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  if (!looksLikeScopedToken(token)) return { ok: false, reason: 'malformed token' }
  const [headerPart, payloadPart, signaturePart] = token.split('.') as [string, string, string]

  const header = jsonSegment(headerPart)
  if (!header) return { ok: false, reason: 'malformed token header' }
  // Exactly one algorithm. A verifier that let the header choose would accept
  // `none`, or an HMAC keyed with the public key — the two classic confusions.
  if (header.alg !== SCOPED_TOKEN_ALG) {
    return { ok: false, reason: `token alg must be ${SCOPED_TOKEN_ALG}` }
  }
  // An extension this verifier does not implement must not be silently
  // ignored (RFC 7515 §4.1.11).
  if (header.crit !== undefined) return { ok: false, reason: 'token header names crit extensions' }

  const signature = base64UrlDecode(signaturePart)
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: 'malformed token signature' }
  }

  const keys = await importedKeys(keysRaw)
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  let verified = false
  for (const key of keys) {
    if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signed)) {
      verified = true
      break
    }
  }
  if (!verified) return { ok: false, reason: 'token signature does not verify' }

  const payload = jsonSegment(payloadPart)
  if (!payload) return { ok: false, reason: 'malformed token payload' }
  const { repo, mode, exp, iat, nbf, sub } = payload
  // The canonical id only: `.git` is a suffix a client's URL chooses, not part
  // of a name (`src/repo.ts`), so a claim spelled with one would be a second
  // spelling of a different repository.
  if (typeof repo !== 'string' || !REPO_ID.test(repo) || repo.endsWith('.git')) {
    return { ok: false, reason: 'token repo claim is missing or not a repository name' }
  }
  if (mode !== 'read' && mode !== 'write') {
    return { ok: false, reason: 'token mode claim must be read or write' }
  }
  if (!isTime(exp)) return { ok: false, reason: 'token exp claim is missing' }
  if (!isTime(iat)) return { ok: false, reason: 'token iat claim is missing' }
  if (sub !== undefined && typeof sub !== 'string') {
    return { ok: false, reason: 'token sub claim must be a string' }
  }
  if (nbf !== undefined && !isTime(nbf))
    return { ok: false, reason: 'token nbf claim is not a time' }

  const now = nowMs / 1000
  if (exp + SCOPED_TOKEN_SKEW_SECONDS <= now) return { ok: false, reason: 'token has expired' }
  if (iat - SCOPED_TOKEN_SKEW_SECONDS > now) {
    return { ok: false, reason: 'token iat is in the future' }
  }
  // Optional, but honoured where an issuer sets it (RFC 7519 §4.1.5): a token
  // not valid yet is not valid.
  if (isTime(nbf) && nbf - SCOPED_TOKEN_SKEW_SECONDS > now) {
    return { ok: false, reason: 'token is not valid yet (nbf)' }
  }

  return {
    ok: true,
    claims: { repo, mode, exp, iat, ...(sub === undefined ? {} : { sub }) },
  }
}

/** What the credential on a request turned out to be. */
export type ScopedAccess =
  /** Not a scoped token, or scoped tokens are off: today's rules, unchanged. */
  | { kind: 'unscoped' }
  | { kind: 'scoped'; claims: ScopedClaims }
  /** A scoped token that does not verify. 401. */
  | { kind: 'invalid'; reason: string }
  /** The deployment's own key list is malformed. Refused, never accepted. */
  | { kind: 'misconfigured'; reason: string }

export interface ScopedConfig {
  /** `WALGIT_TOKEN_PUBLIC_KEYS`, verbatim. */
  keys: string | undefined
  /**
   * The deployment's own secrets — admin tokens, the announce secret. A
   * credential equal to one of them is never judged as a scoped token, whatever
   * it looks like.
   */
  known: readonly string[]
  now?: () => number
}

/** Classify the credential an `Authorization` header presents. */
export async function scopedAccessOf(
  authorization: string | null,
  config: ScopedConfig,
): Promise<ScopedAccess> {
  const keys = seedValue(config.keys)
  if (keys === null) return { kind: 'unscoped' }
  const presented = presentedCredential(authorization ?? '')
  if (!presented || !looksLikeScopedToken(presented)) return { kind: 'unscoped' }
  // Every known secret is compared, so the answer takes the same time whichever
  // (if any) it matched.
  let known = false
  for (const secret of config.known) {
    if (secret !== '' && constantTimeEquals(secret, presented)) known = true
  }
  if (known) return { kind: 'unscoped' }
  let result: VerifyResult
  try {
    result = await verifyScopedToken(presented, keys, config.now?.() ?? Date.now())
  } catch (error) {
    return { kind: 'misconfigured', reason: (error as Error).message }
  }
  return result.ok
    ? { kind: 'scoped', claims: result.claims }
    : { kind: 'invalid', reason: result.reason }
}

/**
 * What a request reaches, as far as a scoped token is concerned.
 *
 *   - `repo`: one repository, read or written. Allowed only for the claimed
 *     name, and a write only for a `write` token.
 *   - `list`: the repository list. Allowed, and narrowed to the claimed name.
 *   - `per-message`: the MCP endpoint and the event socket, whose repositories
 *     are named inside the request rather than in its URL. Let through, and
 *     judged on every name there (`scopeRefusal` again, per name).
 *   - `elsewhere`: anything else — refused, even where an anonymous request
 *     would be served. A client that wants the anonymous view sends no
 *     credential.
 *
 * Deny by default: a route added later that is not named here is `elsewhere`,
 * so forgetting it fails closed.
 */
export type ScopeTarget =
  | { kind: 'repo'; repo: string; write: boolean }
  | { kind: 'list' }
  | { kind: 'per-message' }
  | { kind: 'elsewhere' }

/**
 * The id a requested name resolves to, the way `normalizeRepoId` (`src/repo.ts`)
 * resolves it — so `/alpha.git.git/…` is judged as the `alpha` it would serve.
 * Validity is not decided here: a name the container would refuse is compared
 * as-is and simply fails to match.
 */
const canonical = (name: string): string => name.replace(/^\//, '').replace(/\.git$/, '')

export function scopeTargetOf(method: string, pathname: string, search: string): ScopeTarget {
  const git = SMART_HTTP.exec(pathname)
  if (git) {
    // EVERY `service` value, not the first: `git http-backend` acts on the
    // last, so a read token appending a second one must still be judged a push.
    const services = new URLSearchParams(search).getAll('service')
    const write =
      git[2] === 'git-receive-pack' ||
      (git[2] === 'info/refs' && services.includes('git-receive-pack'))
    return { kind: 'repo', repo: canonical(git[1]!), write }
  }
  const proposals = PROPOSALS_HTTP.exec(pathname)
  if (proposals) return { kind: 'repo', repo: canonical(proposals[1]!), write: false }
  // The container's own read routes take the name as a query parameter. The
  // edge forwards the provenance read as-is; the browse route is the
  // container-side shape of the web pages below.
  if (pathname === PROVENANCE_PATH || pathname === BROWSE_PATH) {
    const repo = new URLSearchParams(search).get('repo')
    return repo === null
      ? { kind: 'elsewhere' }
      : { kind: 'repo', repo: canonical(repo), write: false }
  }
  // A host merge (docs/adr/0022) moves a ref, so it is a write whatever the
  // method: a `read` token is refused it exactly as it is refused a push.
  if (pathname === MERGE_PATH) {
    const repo = new URLSearchParams(search).get('repo')
    return repo === null
      ? { kind: 'elsewhere' }
      : { kind: 'repo', repo: canonical(repo), write: true }
  }
  if (pathname === MCP_PATH || pathname === EVENTS_PATH) return { kind: 'per-message' }
  if (pathname === REPOS_PATH) return { kind: 'list' }
  const page = wantsBrowse(method, pathname)
  if (page) return { kind: 'repo', repo: canonical(page.repo), write: false }
  return { kind: 'elsewhere' }
}

/** Why a valid token may not do this, or `null` when it may. Always a 403. */
export function scopeRefusal(
  claims: ScopedClaims,
  target: ScopeTarget,
): { status: 403; message: string } | null {
  if (target.kind === 'list' || target.kind === 'per-message') return null
  if (target.kind === 'elsewhere') {
    return {
      status: 403,
      message: `walgit: this token is scoped to the repository "${claims.repo}" and is not accepted here — send no credential for the anonymous view\n`,
    }
  }
  if (target.repo !== claims.repo) {
    return {
      status: 403,
      message: `walgit: this token is scoped to the repository "${claims.repo}", not "${target.repo}"\n`,
    }
  }
  if (target.write && claims.mode !== 'write') {
    return {
      status: 403,
      message: `walgit: this token may read "${claims.repo}" but not push to it\n`,
    }
  }
  return null
}

/** Shorthand for the per-message surfaces: may this token read this name? */
export function scopeAllowsRead(claims: ScopedClaims, repo: string): boolean {
  return nameInScope(claims.repo, repo)
}

/** Does a requested name resolve to the claimed repository? Exact, by id. */
export function nameInScope(claimed: string, requested: string): boolean {
  return canonical(requested) === claimed
}

/**
 * Mint one token. For `walgit token mint`, docs and tests — an issuer in
 * production uses whatever JWT library it already has, which is the point of
 * the format.
 */
export async function mintScopedToken(
  privateKey: CryptoKey,
  claims: ScopedClaims,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
  const signingInput = `${encode({ alg: SCOPED_TOKEN_ALG, typ: 'JWT', ...header })}.${encode(claims)}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

/**
 * The edge's answer to a scoped credential, or `null` to carry on.
 *
 * `null` for every unscoped request, so a deployment without
 * `WALGIT_TOKEN_PUBLIC_KEYS` never reaches a line of this file past the
 * classification. The 401 carries the same challenge every other walgit
 * refusal of a credential does, so git's credential helpers behave the same.
 */
export function scopedEdgeAnswer(access: ScopedAccess, target: ScopeTarget): Response | null {
  const plain = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  if (access.kind === 'unscoped') return null
  if (access.kind === 'invalid') {
    return new Response(`walgit: ${access.reason}\n`, {
      status: 401,
      headers: { ...plain, 'www-authenticate': BASIC_CHALLENGE },
    })
  }
  if (access.kind === 'misconfigured') {
    return new Response(`${access.reason}\n`, { status: 503, headers: plain })
  }
  const refused = scopeRefusal(access.claims, target)
  return refused ? new Response(refused.message, { status: refused.status, headers: plain }) : null
}

/**
 * Has a token that verified at some earlier moment expired since?
 *
 * For a credential held open — an event-stream socket verified when its
 * `watch` arrived — so it stops being served when the token would have stopped
 * being accepted, with the same skew `verifyScopedToken` allows.
 */
export function scopedTokenExpired(exp: number, nowMs: number = Date.now()): boolean {
  return exp + SCOPED_TOKEN_SKEW_SECONDS <= nowMs / 1000
}

/**
 * The event stream's question: may this credential watch these repositories?
 *
 * `null` when it may — every unscoped credential included, which the Reader
 * List gate judges as before. Otherwise the error the socket is told before it
 * is closed: `unauthorized` for a token that does not verify, `forbidden` for
 * one that names anything outside its claim. Whole, never narrowed: a
 * subscriber silently stripped of one repository waits forever.
 */
export function scopedWatchRefusal(
  access: ScopedAccess,
  repos: readonly string[],
): 'unauthorized' | 'forbidden' | null {
  if (access.kind === 'unscoped') return null
  if (access.kind !== 'scoped') return 'unauthorized'
  return repos.every((repo) => scopeAllowsRead(access.claims, repo)) ? null : 'forbidden'
}
