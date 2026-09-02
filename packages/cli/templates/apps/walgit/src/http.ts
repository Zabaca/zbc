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

import { capabilitiesFrom, type Capabilities } from '../shared/capabilities'
import { authorizedBy } from '../shared/credentials'
import {
  EXPIRE_PATH,
  HEALTH_PATH,
  INTERNAL_HEADER,
  PROVENANCE_PATH,
  REFS_PATH,
  REJECT_HEADER,
  SERVED_HEADER,
  SMART_HTTP,
  type ContainerRejectKind,
} from '../shared/protocol'
import { renderInstructions } from './instructions'
import type { ResolvedRepo } from './repo'
import { resolveRepo } from './repo'
import type { Claim, Provenance } from './wal-index'

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
   * What `GET /` tells an agent about this instance
   * (`shared/capabilities.ts`), so the page can never promise a rule the
   * deployment does not enforce. Optional so the routing can be tested without
   * one; a handler given none advertises nothing at all, which is the safe
   * direction for a document about what is offered.
   */
  capabilities?: Capabilities
  /**
   * Run one expiry sweep. Optional: an instance that is not given one simply
   * does not answer the endpoint, which is what a deployment with no timer in
   * front of it should do.
   *
   * The sweep lives out here rather than on a timer inside the container
   * because the container sleeps when idle — an internal `setInterval` would
   * stop firing at exactly the moment there is nothing keeping it awake, which
   * is exactly when there are idle repositories to collect. The deployment's
   * Cron Trigger wakes it instead (`worker/index.ts`).
   */
  sweep?: () => Promise<unknown>
  /**
   * The Index's ref state for one repository — what a ref-event subscriber's
   * handshake is answered with (`worker/events-do.ts`).
   *
   * Read from `index.json` rather than from the bare repo on disk, because the
   * Index is the source of truth and the disk is a cache: answering from the
   * cache would tell a subscriber where this node happens to stand, which is
   * exactly the stale answer the whole design exists to avoid. Optional, so an
   * instance with no store — or no event stream — simply does not answer.
   */
  readRefs?: (repoId: string) => Promise<Record<string, string>>
  /**
   * What the Index records about who wrote one repository: the push provenance
   * — ref → the Signer that moved it, and when (docs/adr/0011) — and the Signer
   * List that repository holds, when it holds one (docs/adr/0012). Read from
   * the Index for the same reason `readRefs` is: the Index is where a push
   * records both, and the disk holds no copy of either.
   *
   * One reader for both because they are one object read answering one
   * endpoint. Two readers would double an Index fetch to answer a single
   * request, and would let a caller wire one and forget the other.
   *
   * Optional like every other reader here, and absent means the endpoint does
   * not exist rather than answering an empty map — an instance with no store
   * has no authoritative answer, and inventing "nobody signed anything" out of
   * a missing log is the one wrong answer this feature can give.
   */
  readProvenance?: (repoId: string) => Promise<ProvenanceRead>
}

/** What `GET /_walgit/provenance` answers with, before it is serialized. */
export type ProvenanceRead = {
  provenance: Record<string, Provenance>
  /** Absent for an unclaimed repository, which is most of them. */
  claim?: Claim
}

/**
 * Refuse, and say which kind of refusal it was.
 *
 * The kind is `ContainerRejectKind` rather than a free string because the
 * Worker in front counts refusals by kind and cannot derive one from a status
 * code several refusals share (`shared/telemetry.ts`). A kind this process
 * invented and the Worker did not know would land in its `other` bucket,
 * silently, which is exactly the drift the shared vocabulary exists to stop.
 */
function reject(
  status: number,
  kind: ContainerRejectKind,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...headers, [REJECT_HEADER]: kind } })
}

const UNAUTHORIZED = () =>
  // git prompts for a credential only when challenged in this scheme, so the
  // header is what makes `git clone https://…` work interactively at all.
  reject(401, 'unauthorized', 'unauthorized\n', {
    'www-authenticate': 'Basic realm="walgit"',
  })

const NOT_FOUND = () => reject(404, 'not-found', 'not found\n')

/**
 * What a handler wired without capabilities says it offers: nothing.
 *
 * The empty environment read through the one derivation, rather than an object
 * literal — a hand-written "all off" would be a second place a capability has
 * to be remembered, which is the whole defect `shared/capabilities.ts` exists
 * to remove.
 */
const ADVERTISES_NOTHING = capabilitiesFrom({})

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
    if (url.pathname === HEALTH_PATH) return new Response('ok\n')

    // The sweeper's front door. Not part of the git protocol and not reachable
    // from the internet: the Worker deletes INTERNAL_HEADER from everything it
    // forwards, so a request carrying it can only have been originated by the
    // Worker's scheduled handler. A 404 rather than a 403 for the same reason
    // every other unroutable path gets one — an endpoint nobody may call should
    // not advertise that it exists.
    if (url.pathname === EXPIRE_PATH) {
      if (!deps.sweep || request.method !== 'POST') return NOT_FOUND()
      if (request.headers.get(INTERNAL_HEADER) !== '1') return NOT_FOUND()
      const report = await deps.sweep()
      return new Response(`${JSON.stringify(report)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    // Current ref state, for the event stream's handshake. Internal for the
    // same reason expiry is: it is not part of the git protocol, and the Worker
    // strips INTERNAL_HEADER from everything arriving from the internet, so a
    // request carrying it can only have come from the Worker itself.
    if (url.pathname === REFS_PATH) {
      if (!deps.readRefs || request.method !== 'GET') return NOT_FOUND()
      if (request.headers.get(INTERNAL_HEADER) !== '1') return NOT_FOUND()
      const repoId = requestedRepoId(deps.reposDir, url)
      if (repoId === null) return NOT_FOUND()
      const refs = await deps.readRefs(repoId)
      return new Response(`${JSON.stringify({ repo: repoId, refs })}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    // The instructions are the API surface, so they come BEFORE the credential
    // check: an agent that has to authenticate to learn how to authenticate
    // has nowhere to start. text/plain because the reader is a model with a
    // default fetch, not a browser — no markup to parse to find the endpoint.
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(
        renderInstructions(publicOrigin(request, url), deps.capabilities ?? ADVERTISES_NOTHING),
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }

    if (!deps.public && !authorizedBy(request.headers.get('authorization'), deps.tokens)) {
      return UNAUTHORIZED()
    }

    // Push provenance, read back (docs/adr/0011). Placed HERE — below the
    // credential gate and above the git endpoints — because that position is
    // the requirement: the read is behind exactly the credential a clone of
    // this repository needs, so a public instance answers anyone and a
    // token-gated one answers nobody else, with no second authorization model
    // to keep in agreement with the first.
    if (url.pathname === PROVENANCE_PATH) {
      if (!deps.readProvenance || request.method !== 'GET') return NOT_FOUND()
      const repoId = requestedRepoId(deps.reposDir, url)
      if (repoId === null) return NOT_FOUND()
      // A repository nobody has signed a push to reads as an empty map, not a
      // 404 and not an error: signing is opt-in, so "no Signer recorded" is the
      // ordinary answer here and has to be a cheap one to consume.
      //
      // `claim` is OMITTED rather than null for an unclaimed one, so that the
      // absence a client tests for is the same absence the Index carries and
      // there is no second spelling of "nobody has claimed this name".
      const { provenance, claim } = await deps.readProvenance(repoId)
      const body = { repo: repoId, provenance, ...(claim ? { claim } : {}) }
      return new Response(`${JSON.stringify(body)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

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
        return reject(503, 'unavailable', `walgit: ${(err as Error).message}\n`)
      }
    }

    return deps.runBackend({ repo, pathInfo: url.pathname, request })
  }
}

/**
 * The repository a `?repo=` reader names, or `null` when it names none walgit
 * would serve.
 *
 * Through `resolveRepo`, which is the same gate a path segment goes through —
 * a name accepted here and refused there would be a repository half the service
 * can see, which is exactly what `REPO_ID` exists to stop.
 */
function requestedRepoId(reposDir: string, url: URL): string | null {
  try {
    return resolveRepo(reposDir, url.searchParams.get('repo') ?? '').repoId
  } catch {
    return null
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
