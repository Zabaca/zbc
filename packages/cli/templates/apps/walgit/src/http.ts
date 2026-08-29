/**
 * The smart-HTTP seam.
 *
 * A `(Request) => Promise<Response>` handler, so the whole HTTP front door —
 * auth, routing, and delegation to `git http-backend` — is observable without a
 * socket or a git process. The backend runner is injected for the same reason.
 *
 * Smart-HTTP is the only transport walgit serves. It is also the one every
 * client already has: CI jobs, ephemeral agent sandboxes and `git clone` inside
 * a container hold a token long before they hold an identity of any other kind.
 */

import type { InstructionsPolicy } from './instructions'
import { renderInstructions } from './instructions'
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
  /**
   * Serve every request with no credential at all — the public instance, where
   * writes are open and there is therefore nothing for a credential to prove.
   *
   * Explicit on purpose: an EMPTY `tokens` list does NOT mean public. A
   * deployment that loses its secret would then be indistinguishable from one
   * that chose to be open, and the failure direction is unrecoverable — once
   * strangers have pushed to an accidentally public instance there is no
   * undoing it. So the two must be configured separately, and the combination
   * of neither is refused outright (see below).
   */
  public?: boolean
  ensureRepo: (repo: ResolvedRepo) => ResolvedRepo
  /**
   * Bring the local cache in line with the log before serving. Optional only so
   * the routing can be tested without a store; a deployment without it serves
   * whatever this node's disk happens to hold.
   */
  syncRepo?: (repo: ResolvedRepo) => Promise<unknown>
  runBackend: (req: BackendRequest) => Promise<Response>
  /**
   * What `GET /` tells an agent about this instance. Rendered from the limits
   * actually configured, so the page can never promise a rule the deployment
   * does not enforce.
   */
  instructions?: InstructionsPolicy
}

/**
 * Headers that make a response countable in front of this process.
 *
 * The Worker proxying to this container counts refusals BY KIND, and it cannot
 * derive the kind from a status code several refusals share. So whichever layer
 * refuses names the kind here, and every response this handler produces carries
 * the `served` stamp — its absence is precisely what lets the Worker see that
 * something in FRONT of walgit refused a request walgit should have refused
 * itself. Both are stripped before the response reaches the client
 * (`worker/telemetry.ts` owns the vocabulary and the stripping).
 */
export const SERVED_HEADER = 'x-walgit-served'
export const REJECT_HEADER = 'x-walgit-reject'

/** Every kind of refusal this process distinguishes, as the Worker names them. */
export type RejectKind = 'unauthorized' | 'not-found' | 'unavailable' | 'size-cap' | 'collision'

const UNAUTHORIZED = () =>
  new Response('unauthorized\n', {
    status: 401,
    headers: {
      // git prompts for a credential only when challenged in this scheme, so the
      // header is what makes `git clone https://…` work interactively at all.
      'www-authenticate': 'Basic realm="walgit"',
      [REJECT_HEADER]: 'unauthorized',
    },
  })

/**
 * The smart-HTTP protocol is three endpoints and no more. Everything else a
 * bare repo exposes over HTTP is DUMB http — raw objects, packs, HEAD — which
 * would read the on-disk cache directly and bypass the WAL the cache is derived
 * from. Not routed, so not served.
 */
const SMART_HTTP = /^\/([^/]+)\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/

const NOT_FOUND = () =>
  new Response('not found\n', { status: 404, headers: { [REJECT_HEADER]: 'not-found' } })

/**
 * Stamp a response as walgit's own. Rebuilt rather than mutated because a
 * Response's headers are immutable once constructed — the body is passed
 * through by reference, so a streamed clone is not buffered to do this.
 */
export function stamp(response: Response): Response {
  const stamped = new Response(response.body, response)
  stamped.headers.set(SERVED_HEADER, '1')
  return stamped
}

export function createHttpHandler(deps: HttpHandlerDeps): (req: Request) => Promise<Response> {
  if (!deps.public && deps.tokens.length === 0) {
    // Fail closed. With no tokens every comparison fails, so the instance would
    // serve nothing but 401s while looking, from the client side, exactly like
    // a wrong credential — hours of debugging for a config that is simply
    // absent. Refusing here means the misconfiguration is reported once, at
    // boot, in the words of the thing that is missing.
    throw new Error(
      'walgit: no tokens configured and public mode is off — refusing to serve (set tokens, or opt in to public mode explicitly)',
    )
  }

  const route = createRouter(deps)
  return async (request) => stamp(await route(request))
}

function createRouter(deps: HttpHandlerDeps): (req: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)

    // Unauthenticated on purpose: an external health check carries no
    // credential, and this reveals nothing but that the container is up.
    if (url.pathname === '/_walgit/health') return new Response('ok\n')

    // The instructions are the API surface, so they come BEFORE the credential
    // check: an agent that has to authenticate to learn how to authenticate
    // has nowhere to start. text/plain because the reader is a model with a
    // default fetch, not a browser — no markup to parse to find the endpoint.
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(renderInstructions(publicOrigin(request, url), deps.instructions), {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    if (!deps.public && !isAuthorized(request, deps.tokens)) return UNAUTHORIZED()

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
        return new Response(`walgit: ${(err as Error).message}\n`, {
          status: 503,
          headers: { [REJECT_HEADER]: 'unavailable' },
        })
      }
    }

    return deps.runBackend({ repo, pathInfo: url.pathname, request })
  }
}

/**
 * The host in the example has to be the host the agent typed. Behind a proxy
 * (the deployment is fronted by a Worker) the request URL carries the internal
 * address, so the forwarded headers win when present.
 */
function publicOrigin(request: Request, url: URL): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (!host) return url.origin
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
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
