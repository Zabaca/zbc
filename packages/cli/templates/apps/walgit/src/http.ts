/**
 * The smart-HTTP seam.
 *
 * A `(Request) => Promise<Response>` handler, so the whole HTTP front door —
 * auth, routing, and delegation to `git http-backend` — is observable without a
 * socket or a git process. The backend runner is injected for the same reason.
 *
 * Smart-HTTP exists alongside SSH because not every client can hold a key: CI
 * jobs, ephemeral agent sandboxes and `git clone` inside a container all have a
 * token long before they have an SSH identity.
 */

import type { ResolvedRepo } from './repo'
import { resolveRepo } from './repo'

export type BackendRequest = {
  repo: ResolvedRepo
  /** The path git http-backend sees, e.g. `/alpha.git/info/refs`. */
  pathInfo: string
  request: Request
}

export type HttpHandlerDeps = {
  reposDir: string
  /** Accepted credentials. A request must present one of these. */
  tokens: string[]
  ensureRepo: (repo: ResolvedRepo) => ResolvedRepo
  /**
   * Bring the local cache in line with the log before serving. Optional only so
   * the routing can be tested without a store; a deployment without it serves
   * whatever this node's disk happens to hold.
   */
  syncRepo?: (repo: ResolvedRepo) => Promise<unknown>
  runBackend: (req: BackendRequest) => Promise<Response>
}

const UNAUTHORIZED = () =>
  new Response('unauthorized\n', {
    status: 401,
    // git prompts for a credential only when challenged in this scheme, so the
    // header is what makes `git clone https://…` work interactively at all.
    headers: { 'www-authenticate': 'Basic realm="walgit"' },
  })

/**
 * The smart-HTTP protocol is three endpoints and no more. Everything else a
 * bare repo exposes over HTTP is DUMB http — raw objects, packs, HEAD — which
 * would read the on-disk cache directly and bypass the WAL the cache is derived
 * from. Not routed, so not served.
 */
const SMART_HTTP = /^\/([^/]+)\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/

const NOT_FOUND = () => new Response('not found\n', { status: 404 })

export function createHttpHandler(deps: HttpHandlerDeps): (req: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)

    // Unauthenticated on purpose: Fly's health check has no credential, and it
    // reveals nothing but that a machine is up.
    if (url.pathname === '/_walgit/health') return new Response('ok\n')

    if (!isAuthorized(request, deps.tokens)) return UNAUTHORIZED()

    const route = SMART_HTTP.exec(url.pathname)
    if (!route) return NOT_FOUND()

    let repo
    try {
      repo = deps.ensureRepo(resolveRepo(deps.reposDir, route[1]!))
    } catch {
      // A bad repo name is indistinguishable from a missing one, deliberately.
      return NOT_FOUND()
    }

    if (deps.syncRepo) {
      try {
        await deps.syncRepo(repo)
      } catch (err) {
        // Serving a repo we could not verify against the log would hand out
        // refs that may already have been superseded, which for a fetch is
        // indistinguishable from data loss. Refuse instead.
        return new Response(`walgit: ${(err as Error).message}\n`, { status: 503 })
      }
    }

    return deps.runBackend({ repo, pathInfo: url.pathname, request })
  }
}

function isAuthorized(request: Request, tokens: string[]): boolean {
  const header = request.headers.get('authorization') ?? ''
  const presented = presentedCredential(header)
  if (!presented) return false
  return tokens.some((token) => constantTimeEquals(token, presented))
}

function presentedCredential(header: string): string | null {
  const bearer = /^Bearer (.+)$/i.exec(header)
  if (bearer) return bearer[1]!
  const basic = /^Basic (.+)$/i.exec(header)
  if (basic) {
    // git sends `<user>:<password>`; the user half is ignored — there is one
    // trust boundary in v0, and a per-user model needs the repo namespace that
    // milestone 3 introduces.
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    return colon === -1 ? decoded : decoded.slice(colon + 1)
  }
  return null
}

/** Length-independent comparison, so a wrong token leaks nothing by timing. */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % a.length || 0) || 0) ^ (b.charCodeAt(i % b.length || 0) || 0)
  }
  return diff === 0
}
