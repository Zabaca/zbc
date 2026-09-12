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
import { authorizedBy, presentedSignature } from '../shared/credentials'
import {
  CHALLENGE_PATH,
  EXPIRE_PATH,
  HEALTH_PATH,
  INTERNAL_HEADER,
  PROVENANCE_PATH,
  READ_CHALLENGE_SCHEME,
  REFS_PATH,
  REJECT_HEADER,
  SERVED_HEADER,
  SMART_HTTP,
  type ContainerRejectKind,
} from '../shared/protocol'
import { renderInstructions } from './instructions'
import { acceptedNonces, readAllowed, readChallengeNonce, renderReadChallenge } from './private'
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
  /**
   * Read gating for Private repositories (docs/adr/0013), or `undefined` for a
   * deployment that does none — which is every deployment until an operator
   * sets `WALGIT_PRIVATE_REPOS`.
   *
   * One group rather than four sibling options, because the four are worthless
   * apart: a seed with no Claim reader would gate nothing while advertising a
   * challenge, and a Claim reader with no verifier would refuse everyone. Half
   * a gate is the failure this shape makes unrepresentable.
   */
  privateReads?: PrivateReads
}

/** Everything the Private gate needs, present or absent as a whole. */
export type PrivateReads = {
  /** `WALGIT_PRIVATE_REPOS`. The nonce is derived from it. */
  seed: string
  /**
   * The Claim the Index holds for one repository, or `undefined` when it holds
   * none. Read from the Index rather than from the disk for the same reason
   * `readRefs` is: the ref is authoritative and the cache is a cache, and
   * serving a repository on a stale copy of its Reader List is exactly the
   * revocation that does not take.
   */
  readClaim: (repoId: string) => Promise<Claim | undefined>
  /**
   * Verify an SSH signature over `message` in the `walgit-read` namespace and
   * name the key that made it, or `null`.
   *
   * Injected exactly as the push-certificate verifier is, so the routing above
   * is testable without a subprocess — and so the one place that spawns
   * `ssh-keygen` stays one place (`src/ssh-signature.ts`).
   */
  verifyRead: ReadVerifier
  /** The clock, injectable so a test can stand still inside a window. */
  now?: () => number
}

/** Verify a `walgit-read` signature over a message; name the key, or `null`. */
export type ReadVerifier = (message: string, signature: string) => string | null

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
  headers: HeadersInit = {},
): Response {
  const merged = new Headers(headers)
  merged.set(REJECT_HEADER, kind)
  return new Response(body, { status, headers: merged })
}

const UNAUTHORIZED = () =>
  // git prompts for a credential only when challenged in this scheme, so the
  // header is what makes `git clone https://…` work interactively at all.
  reject(401, 'unauthorized', 'unauthorized\n', {
    'www-authenticate': 'Basic realm="walgit"',
  })

const NOT_FOUND = () => reject(404, 'not-found', 'not found\n')

/**
 * The Claim a repository is treated as holding when its real one cannot be
 * read: Private, and nobody is listed.
 *
 * The failure direction is what makes this the only defensible default. Reading
 * "no Reader List" out of an Index we could not reach would serve a Private
 * repository to a stranger, which is unrecoverable; reading it as locked costs
 * a reader a retry while the store is down.
 */
const LOCKED: Claim = { signers: [], readers: [], ts: '' }

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
  const priv = deps.privateReads

  /**
   * Refuse this read, or don't — the Private gate, for all three reads
   * (docs/adr/0013).
   *
   * `null` means serve it. A `Response` is the challenge, and it is a 401
   * carrying the current nonce rather than a 404: answering "no such
   * repository" would hide a name that ownership already made public, and
   * would break every credential helper, which keys on the 401.
   *
   * The verdict itself is `readAllowed` — one pure function, the same one for
   * the clone, the fetch and the provenance read, so there is no second
   * authorization model to keep in agreement with the first.
   */
  async function refuseRead(
    request: Request,
    url: URL,
    claim: Claim | undefined,
  ): Promise<Response | null> {
    if (!priv) return null
    if (!claim?.readers) return null
    const presented = provedFingerprint(priv, request)
    if (readAllowed({ enabled: true, claim, presented })) return null
    const nonce = readChallengeNonce(priv.seed, priv.now?.() ?? Date.now())
    // TWO challenges, and the Basic one is not decoration: git speaks the
    // schemes curl knows, and a 401 offering only `walgit-ssh` is one git
    // reports as `Authentication failed` without ever asking a credential
    // helper for a password. The Read Challenge is what a reader ANSWERS —
    // the nonce is in it — and `Basic` is what makes git willing to carry the
    // answer. Two header lines rather than one comma-joined value, because
    // the nonce's `=` inside a comma-separated list is where parsers differ.
    return reject(401, 'unauthorized', renderReadChallenge(publicOrigin(request, url)), [
      ['www-authenticate', 'Basic realm="walgit"'],
      ['www-authenticate', `${READ_CHALLENGE_SCHEME} nonce=${nonce}`],
    ])
  }

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

    // The Read Challenge's nonce. Above the credential gate, like the
    // instructions below it and for the same reason: it is what a credential
    // for a Private repository is BUILT from, so a reader that had to
    // authenticate for it would have nowhere to start. It exists only where
    // there is a seed to derive one from — a deployment doing no read gating
    // should not answer as though it might.
    if (url.pathname === CHALLENGE_PATH) {
      if (!priv || request.method !== 'GET') return NOT_FOUND()
      const nonce = readChallengeNonce(priv.seed, priv.now?.() ?? Date.now())
      return new Response(`${JSON.stringify({ nonce })}\n`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // The body is only true for ten minutes. A cache that outlived that
          // would hand every client a nonce the server has stopped accepting —
          // a challenge nobody can answer, from a response that looks fine.
          'cache-control': 'no-store',
        },
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
      // Read inside a try/catch for the same reason the git path has one: an
      // Index this instance cannot reach must refuse the read rather than
      // throw past the router, which would answer 500 with no `served` stamp
      // and be counted at the edge as walgit failing to refuse at all.
      let read: ProvenanceRead
      try {
        read = await deps.readProvenance(repoId)
      } catch {
        read = { provenance: {}, claim: LOCKED }
      }
      const { provenance, claim } = read
      // Gated on the Claim this read already loaded. ADR-0011 put the
      // provenance read behind exactly the credential a clone needs, and a
      // Private repository's provenance is who pushed to a repository the
      // asker may not read.
      const refused = await refuseRead(request, url, claim)
      if (refused) return refused
      const body = { repo: repoId, provenance, ...(claim ? { claim } : {}) }
      return new Response(`${JSON.stringify(body)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    const route = SMART_HTTP.exec(url.pathname)
    if (!route) return NOT_FOUND()

    // A read of a Private repository, refused before anything is created or
    // synced — `git-receive-pack` is deliberately not one of these: what a
    // push may do is the Signer List's question (docs/adr/0012), asked in the
    // hooks, and asking it twice in two places is how the two answers drift.
    //
    // `info/refs` IS one, including the `?service=git-receive-pack`
    // advertisement a push begins with. That advertisement hands over every ref
    // name and oid in the repository, which is a read whatever the client
    // intends to do next, and leaving it open would publish the shape of every
    // Private repository to anyone who appended a query parameter. The cost is
    // that pushing to a Private repository needs the same credential reading it
    // does — the same key the pusher already signs with, and the helper the 401
    // names.
    if (priv && route[2] !== 'git-receive-pack') {
      let claim: Claim | undefined
      let repoId: string
      try {
        repoId = resolveRepo(deps.reposDir, route[1]!).repoId
      } catch {
        // A bad name is a 404 here exactly as it is below, rather than a
        // challenge for a repository that could not exist.
        return NOT_FOUND()
      }
      try {
        claim = await priv.readClaim(repoId)
      } catch {
        // A repository whose Reader List cannot be read must not be served on
        // the assumption that it has none: the failure direction here is
        // handing out a Private repository, which is unrecoverable. Refused
        // with the challenge, as an unproven reader is.
        claim = LOCKED
      }
      const refused = await refuseRead(request, url, claim)
      if (refused) return refused
    }

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
 * The fingerprint this request PROVED, or `null`.
 *
 * The reader presents `Basic base64(<fingerprint>:<signature>)`, read by
 * `presentedSignature` — and the username half is deliberately not what is
 * trusted: a fingerprint is public, so the answer comes from the verifier,
 * which reports the key it actually verified the signature against.
 *
 * Both accepted nonces are tried, newest first, because a reader that fetched
 * its challenge just before a window boundary signed the older one and must not
 * be refused for the network's timing.
 */
function provedFingerprint(priv: PrivateReads, request: Request): string | null {
  const signature = presentedSignature(request.headers.get('authorization') ?? '')
  if (!signature) return null
  for (const nonce of acceptedNonces(priv.seed, priv.now?.() ?? Date.now())) {
    const fingerprint = priv.verifyRead(nonce, signature)
    if (fingerprint) return fingerprint
  }
  return null
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
