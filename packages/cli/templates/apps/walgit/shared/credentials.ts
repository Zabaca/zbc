/**
 * Reading a credential off the wire, once.
 *
 * Three functions, and all three used to exist twice — in `src/http.ts` for the
 * git transport and in `shared/events.ts` for the event socket. They are the
 * same question asked on two transports: a client presents a token, and walgit
 * decides whether it is one of the ones configured. The event stream's answer
 * is deliberately the SAME answer a read gets (an event says a ref moved and
 * what to; that is a strict subset of what a fetch of the repository hands
 * over), so two implementations were never two policies — only two chances to
 * drift.
 *
 * Runtime-neutral, which is what lets both halves import it: `atob` is a
 * standard global in bun and in the Workers runtime alike, and nothing here
 * touches a buffer, a socket or a clock.
 */

/**
 * The token a request presents: `Bearer <token>`, or git's
 * `Basic base64(<user>:<token>)`.
 *
 * The user half of Basic is ignored — there is one trust boundary in v0, and a
 * per-user model needs the repo namespace milestone 3 introduces. git sends the
 * credential this way, so accepting it is what makes `git clone https://…`
 * work with a bare token at all.
 */
export function presentedCredential(header: string): string | null {
  const bearer = /^Bearer (.+)$/i.exec(header)
  if (bearer) return bearer[1]!
  const basic = /^Basic (.+)$/i.exec(header)
  if (basic) {
    // Undecodable base64 is a malformed credential, not a crash: `atob` throws
    // on one, and a header a stranger controls must not be able to do that.
    let decoded: string
    try {
      decoded = atob(basic[1]!)
    } catch {
      return null
    }
    const colon = decoded.indexOf(':')
    return colon === -1 ? decoded : decoded.slice(colon + 1)
  }
  return null
}

/**
 * The credential list.
 *
 * Comma-separated so one deployment can rotate a credential without a window
 * where neither the old nor the new token works. Blank entries are dropped
 * rather than kept as an empty token, which would match an empty credential.
 */
export function parseTokens(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

/** Length-independent comparison, so a wrong token leaks nothing by timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % a.length || 0) || 0) ^ (b.charCodeAt(i % b.length || 0) || 0)
  }
  return diff === 0
}

/**
 * Does this request carry one of these tokens?
 *
 * The whole check in one place, because the ordering matters and is easy to get
 * subtly wrong: a missing credential is refused before any comparison runs, and
 * every configured token is compared in constant time rather than short-
 * circuiting on the first mismatch.
 */
export function authorizedBy(authorization: string | null, tokens: readonly string[]): boolean {
  const presented = presentedCredential(authorization ?? '')
  if (!presented) return false
  return tokens.some((token) => constantTimeEquals(token, presented))
}
