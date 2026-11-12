/**
 * Revoking a repository's scoped tokens: "tokens valid since" (docs/adr/0021).
 *
 * A scoped token is stateless — nothing about it is stored, so nothing can be
 * deleted to end it, and without this a leaked one is good until `exp`. What is
 * stored instead is one instant per repository, `tokens_valid_since` in its
 * Index: every scoped token for that repository whose `iat` is earlier is
 * refused. One admin write (`POST /_walgit/admin/repos/<name>/revoke-tokens`)
 * revokes every token minted for the name so far, and a token minted after it
 * works.
 *
 * Runtime-neutral, beside `scoped-token.ts`, because all three halves ask it:
 * the edge Worker before anything else is decided, the container on whatever
 * reaches it, and the event fan-out when a watch arrives. Each reads the Index
 * itself, through the same reader, so the answer cannot differ between them.
 *
 * **The propagation bound is the next request.** Nothing here caches the
 * verdict: every scoped request makes one conditional read of the Index, and a
 * memoised copy is used only after the store has said it is still current
 * (`304`). A revocation is therefore in force for the very next request on
 * every surface, and a store that cannot be read refuses the token (503) rather
 * than letting a stale copy — or no copy — pass it. A socket already open when
 * the revocation lands is closed by the announcement the revoke makes
 * (`tokensRevoked`, `shared/events.ts`); where no event stream is configured
 * there is no socket to close.
 */

import type { ObjectStore } from './store'
import { loadIndex, loadIndexIfChanged } from './wal-index'

/**
 * Is a token issued at `iat` (seconds) revoked by `since` (an ISO instant)?
 *
 * Strictly earlier, compared in milliseconds. `iat` is whole seconds, so a
 * token minted in the same second as the revocation but after it reads as
 * earlier and is refused too — the safe direction: rounding the other way
 * would let a token minted a moment BEFORE the revocation through. An issuer
 * that meets this mints again a second later.
 */
export function tokenRevoked(iat: number, since: string | null | undefined): boolean {
  if (since === null || since === undefined) return false
  const sinceMs = Date.parse(since)
  // An instant that does not parse is not a revocation anyone could have
  // meant to be lenient about: it was written by an admin, so it fails closed.
  if (!Number.isFinite(sinceMs)) return true
  return iat * 1000 < sinceMs
}

/** The 401 body for a revoked token. */
export function revokedMessage(repo: string, since: string): string {
  return `walgit: this token for "${repo}" was issued before ${since}, when the repository's tokens were revoked — ask its issuer for a new one\n`
}

/**
 * How many repositories one reader remembers. The memo only saves the body of
 * an unchanged Index — every lookup still asks the store — so a bound costs
 * a full read on the next request for an evicted name, and nothing more.
 */
export const MAX_REMEMBERED_REPOS = 1024

/**
 * Reads a repository's `tokens_valid_since`, one conditional GET per call.
 *
 * Held for an isolate's or a process's life. Never answers from memory alone:
 * the memo is the last Index body's verdict keyed by its etag, and is used only
 * when the store answers `not-modified` for that etag.
 */
export class TokenRevocationReader {
  private readonly seen = new Map<string, { etag: string; since: string | null }>()

  constructor(private readonly maxRepos: number = MAX_REMEMBERED_REPOS) {}

  /** The repository's revocation instant, or `null` when none. Throws when the store does. */
  async validSince(store: ObjectStore, repo: string): Promise<string | null> {
    const known = this.seen.get(repo)
    if (known) {
      const res = await loadIndexIfChanged(store, repo, known.etag)
      if (res === 'current') return known.since
      return this.remember(repo, res.etag, res.index.tokens_valid_since ?? null)
    }
    const res = await loadIndex(store, repo)
    return this.remember(repo, res.etag, res.index.tokens_valid_since ?? null)
  }

  private remember(repo: string, etag: string | null, since: string | null): string | null {
    this.seen.delete(repo)
    // An absent Index has no etag to ask about next time, so nothing is kept.
    if (etag === null) return since
    if (this.seen.size >= this.maxRepos) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.seen.set(repo, { etag, since })
    return since
  }
}

export type RevocationVerdict =
  | { kind: 'valid' }
  | { kind: 'revoked'; since: string }
  /** The Index could not be read, so revocation could not be ruled out. */
  | { kind: 'unknown'; reason: string }

/**
 * Judge one verified token against its repository's revocation instant.
 *
 * The repository is the token's own claim, whatever the request names: a
 * scoped token reaches one repository and nothing else (the scope gate refuses
 * the rest), so its claim is the only Index whose revocation can apply.
 */
export async function revocationOf(
  claims: { repo: string; iat: number },
  store: ObjectStore | null,
  reader: TokenRevocationReader,
): Promise<RevocationVerdict> {
  if (!store) {
    return {
      kind: 'unknown',
      reason: 'walgit: no object store configured here, so token revocation cannot be checked',
    }
  }
  let since: string | null
  try {
    since = await reader.validSince(store, claims.repo)
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `walgit: could not check token revocation: ${(error as Error).message}`,
    }
  }
  return since !== null && tokenRevoked(claims.iat, since)
    ? { kind: 'revoked', since }
    : { kind: 'valid' }
}
