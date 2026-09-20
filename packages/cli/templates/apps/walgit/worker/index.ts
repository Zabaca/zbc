/**
 * The Worker half of walgit: a thin proxy in front of the Container.
 *
 * Thin is the whole design. Every decision about a request — which repository
 * it names, whether the credential is good, whether the cache is current
 * against the log — already lives in `src/http.ts` and is unit-tested there
 * without a socket. Re-deciding any of it here would be a second copy of the
 * gate, and the two would drift.
 *
 * What this file DOES own is the environment the container boots with: the
 * container runs outside the Worker's binding graph, so the object store's
 * credentials can only reach it as environment variables, forwarded here from
 * the Worker's own secrets (shared/container-env.ts) — and, because a container
 * reads them exactly once at start, it owns replacing the container when a
 * deploy changes them (`reconcileEnv`).
 *
 * It also owns the one thing only this side can see: request-level telemetry.
 * The log is already a usage ledger for pushes and storage, but a clone writes
 * nothing to it, so read volume, latency, cold starts and refusals are counted
 * here instead — off the serving path, and only for what the log cannot answer
 * (shared/telemetry.ts).
 *
 * Reads are proxied like everything else. Serving a fetch straight from R2 at
 * the edge, without waking the container, is a real optimisation and
 * deliberately not in this milestone.
 */

import { AwsClient } from 'aws4fetch'
import { Container, getContainer } from '@cloudflare/containers'

import { capabilitiesFrom, type Capabilities } from '../shared/capabilities'
import { containerEnv, fingerprintEnv, reconcileContainerEnv } from '../shared/container-env'
import { parseTokens } from '../shared/credentials'
import { authorizeAnnounce, authorizeSubscribe } from '../shared/events'
import { renderLanding, wantsLanding } from '../shared/landing'
import { renderLlms, wantsLlms } from '../shared/llms'
import {
  FAVICON_BODY,
  FAVICON_CONTENT_TYPE,
  ICON_CACHE_CONTROL,
  TOUCH_ICON_STATUS,
  wantsFavicon,
  wantsTouchIcon,
} from '../shared/favicon'
import { OG_IMAGE_CACHE_CONTROL, OG_IMAGE_CONTENT_TYPE, wantsOgImage } from '../shared/og-image'
import { analyticsFrom } from '../shared/analytics'
import { operatorFrom } from '../shared/operator'
import { renderRobots, wantsRobots } from '../shared/robots'
import { repoListResponse, wantsRepoList } from '../shared/repo-list'
import { s3StoreFrom, type ObjectStore } from '../shared/store'
import {
  ANNOUNCE_PATH,
  BASIC_CHALLENGE,
  COLD_HEADER,
  EVENTS_PATH,
  BROWSE_PATH,
  EXPIRE_PATH,
  INTERNAL_HEADER,
  INTERNAL_HEADERS,
  MCP_PATH,
  REJECT_HEADER,
  SERVED_HEADER,
  wantsBrowse,
  type RejectKind,
} from '../shared/protocol'
import {
  classifyOutcome,
  classifyRequest,
  toDataPoint,
  type RequestMetric,
} from '../shared/telemetry'
import { browseResponse } from '../shared/browse'
import { BROADCAST_PATH, EVENTS_OBJECT_NAME, WalgitEvents } from './events-do'
import { handleMcp } from './mcp'
// The card's picture, as bytes in the bundle (wrangler.jsonc's `Data` rule).
// Rendered once by `scripts/render-og-image.ts` in the zbc repository and
// committed — never drawn per request.
import OG_IMAGE_BYTES from '../assets/agentgit-og.png'

export interface Env {
  WALGIT_CONTAINER: DurableObjectNamespace<WalgitContainer>
  /**
   * The commit this Worker was deployed from, set by the cloudflare module's
   * `deployIdVar`. Nothing reads it: it exists so that a deploy which changes
   * only the container image still changes the environment the container is
   * fingerprinted on, and `reconcileEnv` below replaces the running container
   * (shared/container-env.ts). Absent on a deployment that does not set
   * `deployIdVar`, which then behaves exactly as before.
   */
  WALGIT_BUILD_ID?: string
  /** Comma-separated bearer tokens; git sends one as the Basic-auth password. */
  WALGIT_HTTP_TOKENS?: string
  /** The write-ahead log's home — see src/store-env.ts. */
  WALGIT_S3_ENDPOINT?: string
  WALGIT_S3_BUCKET?: string
  WALGIT_S3_ACCESS_KEY_ID?: string
  WALGIT_S3_SECRET_ACCESS_KEY?: string
  WALGIT_S3_REGION?: string
  /** Optional knobs, not secrets (see the app README). */
  WALGIT_COMPACTION_THRESHOLD?: string
  WALGIT_GC_GRACE_MS?: string
  WALGIT_DELETE_GRACE_MS?: string
  /**
   * The policy the documents state and the push path enforces. Read ONLY
   * through `capabilitiesFrom` (`shared/capabilities.ts`) — a second read here
   * is how the three spellings of `WALGIT_PUBLIC` drifted apart.
   */
  WALGIT_PUBLIC?: string
  WALGIT_APPEND_ONLY?: string
  /**
   * The web view (`shared/repo-list.ts`). Read ONLY through `capabilitiesFrom`,
   * like the policy above it — the route below and the two documents that
   * advertise it must not be able to disagree about whether it exists.
   */
  WALGIT_WEB?: string
  WALGIT_RETENTION_HOURS?: string
  WALGIT_MAX_PUSH_BYTES?: string
  WALGIT_MAX_REPO_BYTES?: string
  /**
   * What one source may spend in a window (src/rate-limit.ts). All off unless
   * set; the window defaults when a count is set without one. Forwarded to the
   * container, which is where the verdict is reached — this side only states
   * them on the two documents below.
   */
  WALGIT_RATE_WINDOW_SECONDS?: string
  WALGIT_MAX_NEW_REPOS_PER_SOURCE?: string
  WALGIT_MAX_PUSHES_PER_SOURCE?: string
  WALGIT_MAX_PUSH_BYTES_PER_SOURCE?: string
  /**
   * Where request-level telemetry goes — the half of observability the log
   * cannot produce (shared/telemetry.ts). Optional: a deployment without the
   * binding simply records nothing, and serves exactly as before.
   */
  WALGIT_METRICS?: AnalyticsEngineDataset
  /**
   * The ref-event stream (shared/events.ts). Off unless BOTH are set: the
   * token is the shared secret the container's push path presents when it
   * announces, and the URL is where it announces TO. With only the token the
   * socket is claimed, the handshake answers with current refs, and no event
   * ever arrives, because `post-receive` has nowhere to send one — so the
   * endpoints do not exist unless both halves are configured
   * (`shared/capabilities.ts`). The container gets both through the forward
   * list.
   */
  WALGIT_EVENTS_TOKEN?: string
  WALGIT_EVENTS_URL?: string
  /**
   * The nonce seed that makes signed pushes possible (src/push-cert.ts). Unset
   * is the default and means the container never advertises the capability, so
   * a client asking for `--signed=yes` is refused by its own git. A secret:
   * the nonce it derives is what makes a push certificate un-replayable.
   */
  WALGIT_PUSH_CERT_SEED?: string
  /**
   * `1` to give repositories Signer Lists (src/signers.ts, docs/adr/0012).
   * Its own variable rather than a consequence of the seed above: signing is
   * refused client-side where it is not offered, while ownership is a
   * server-side refusal that would otherwise arrive on a deployment that
   * already set a seed, unasked.
   */
  WALGIT_SIGNER_LISTS?: string
  /**
   * The seed that gives repositories Reader Lists (src/private.ts,
   * docs/adr/0013) — and the value the Read Challenge's nonce will be derived
   * from, which is why it is a seed rather than a flag. Requires
   * `WALGIT_SIGNER_LISTS`: the container refuses to boot without it, because a
   * Reader List on a name anyone may write to protects nothing. Unset by
   * default, and a secret.
   */
  WALGIT_PRIVATE_REPOS?: string
  /**
   * Who runs this deployment, and where to write about it
   * (`shared/operator.ts`). Read ONLY through `operatorFrom`, like the policy
   * above is read only through `capabilitiesFrom`.
   *
   * Deliberately absent from `CONTAINER_ENV`: nothing the container serves
   * names an operator, and a name there would cost a container restart on
   * every copy edit. Unset means the two edge documents carry no operator
   * block at all, rather than a placeholder nobody reads.
   */
  WALGIT_OPERATOR?: string
  WALGIT_CONTACT?: string
  /**
   * Browser analytics on the landing page (`shared/analytics.ts`). Edge-only,
   * like the two above and for the same reason. Read ONLY through
   * `analyticsFrom`.
   */
  WALGIT_POSTHOG_KEY?: string
  WALGIT_POSTHOG_HOST?: string
  WALGIT_POSTHOG_UI_HOST?: string
  WALGIT_EVENTS: DurableObjectNamespace<WalgitEvents>
}

export { WalgitEvents }

/** Where `reconcileEnv` remembers the environment the container booted with. */
const ENV_FINGERPRINT_KEY = 'container-env-fingerprint'

export class WalgitContainer extends Container<Env> {
  /**
   * Was this instance's container only just started?
   *
   * Cold start is the latency an operator most needs to see and the one a spike
   * test cannot show them in production, and only this side knows it: from the
   * Worker every request is a `fetch` that took as long as it took. So the
   * first response after a start is stamped, once, and the Worker reads it off.
   */
  private freshStart = true

  // src/server.ts's PORT default, and the Dockerfile's.
  defaultPort = 8080

  // A clone of a cold repository has to materialize it from the log first, and
  // a large push writes a pack before it is acknowledged. Neither is fast, and
  // both are the normal path here rather than an edge case.
  sleepAfter = '20m'

  // The container is a separate process on a separate machine: `wrangler secret
  // put` reaches this Worker and stops there. Forwarding is what gives the push
  // path an object store at all — without it every push is REFUSED, correctly
  // but confusingly, by hooks three processes down (src/store-env.ts).
  //
  // Read here rather than in `shared/container-env.ts` only because `this.env`
  // is what the class has; the shape and the exclusion rules live there.
  envVars = containerEnv(this.env)

  /**
   * Has the container been checked against the environment this Worker version
   * would boot it with, since this Durable Object was constructed?
   *
   * One promise rather than a boolean so concurrent requests await the same
   * check instead of each racing to replace the container.
   */
  private reconciled: Promise<void> | null = null

  onStart(): void {
    this.freshStart = true
  }

  /**
   * Bind this Durable Object to `reconcileContainerEnv`'s rules.
   *
   * The decision — and the two orderings that matter, no-record-is-a-mismatch
   * and record-only-after-a-successful-destroy — lives in
   * `shared/container-env.ts`, where it can be tested without a Workers
   * runtime. What is left here is exactly the three things only this side can
   * do: reach the container, reach Durable Object storage, and log.
   */
  private async reconcileEnv(): Promise<void> {
    const current = fingerprintEnv(this.envVars ?? {})
    let booted: string | undefined
    // Captured so the port's getter below reads `this` Durable Object's state
    // rather than the object literal's.
    const state = this.ctx

    const outcome = await reconcileContainerEnv(
      {
        // A getter, not a snapshot: it is read after the storage lookup above
        // it, exactly where the original code read it.
        get running() {
          return state.container?.running ?? false
        },
        read: async () => {
          booted = await state.storage.get<string>(ENV_FINGERPRINT_KEY)
          return booted
        },
        // SIGKILL rather than a graceful stop: the container serves git over
        // HTTP and holds nothing worth draining — every durable effect of a
        // push is in the log before it is acknowledged (docs/adr/0007) — and
        // `sleepAfter` already covers the polite path. `destroy` triggers
        // `onStop`; the next `containerFetch` starts a fresh one.
        destroy: () => this.destroy(),
        write: (fingerprint) => state.storage.put(ENV_FINGERPRINT_KEY, fingerprint),
      },
      current,
    )

    if (outcome === 'replaced') {
      console.log(
        `walgit container env changed (${booted ?? 'unrecorded'} -> ${current}); container replaced`,
      )
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Before anything is proxied, so a request never reaches a container whose
    // policy this deploy already superseded. Single-flight and memoized: the
    // storage read happens once per Durable Object lifetime, not per request.
    if (!this.reconciled) {
      this.reconciled = this.reconcileEnv().catch((error) => {
        // Cleared so the next request retries. Never rethrown: a container
        // serving a stale limit is a worse day than an outage only if it is
        // ALSO the reason git stopped working, and it should not be.
        this.reconciled = null
        console.error(`walgit container env reconcile failed: ${(error as Error).message}`)
      })
    }
    await this.reconciled

    const cold = this.freshStart
    this.freshStart = false
    const response = await super.fetch(request)
    if (!cold) return response
    // Rebuilt rather than mutated (Response headers are immutable), passing the
    // body by reference so a clone is not buffered to add one header.
    const stamped = new Response(response.body, response)
    stamped.headers.set(COLD_HEADER, '1')
    return stamped
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now()
    const url = new URL(request.url)

    // What this deployment offers, derived once for the whole request
    // (`shared/capabilities.ts`). The two documents below state themselves
    // from it and the event route is claimed from it, so the page, the manual
    // and the socket cannot describe three different deployments — they used
    // to read the environment three times, and only the size caps were shared.
    const caps = capabilitiesFrom(env)
    // Who is answerable for this deployment (`shared/operator.ts`). Derived
    // beside the capabilities and passed to both documents, so the page and
    // the manual cannot name two different operators.
    const operator = operatorFrom(env)
    // Browser analytics for the page (`shared/analytics.ts`), off unless the
    // instance set a key. Read beside the two reads it mirrors.
    const analytics = analyticsFrom(env)

    // The browser half of `/`, answered at the edge (shared/landing.ts). Placed
    // before every other decision on purpose: a link on an aggregator points at
    // this exact URL, and none of that traffic should wake the container, queue
    // behind a clone, or count against the one instance serving git. git never
    // asks for HTML, so a clone cannot land here.
    const accept = request.headers.get('accept') ?? ''
    if (wantsLanding(request.method, url.pathname, accept)) {
      // The host is passed beside the capabilities rather than folded into
      // them: this document and `/llms.txt` want a bare hostname they prefix
      // with `https://`/`wss://` themselves, while `GET /` needs a full origin
      // including the scheme, and one field could not serve both.
      const page = renderLanding(url.host, caps, operator, analytics)
      const bytes = new TextEncoder().encode(page)
      record(env, ctx, {
        kind: 'landing',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: 200,
        // Neither is a lie by omission: the container was not involved at all,
        // which is the property this branch exists to create and the one an
        // operator should be able to see in the data.
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Short, and deliberately not longer: the page renders the limits
          // this deployment enforces, so a stale copy at the edge would state a
          // cap the push path no longer has. A minute absorbs a launch spike
          // without outliving a config change by anything that matters.
          'cache-control': 'public, max-age=60',
        },
      })
    }

    // `/llms.txt`, answered at the edge for the same reasons the page is, and
    // for one more: it is the LONG document, so serving it from the container
    // would trade a cold start for text that changes only on deploy. It is
    // rendered from the same environment the push path enforces, so the manual
    // cannot promise a cap this deployment does not have.
    //
    // No collision with a repository: smart-HTTP paths are `/<name>.git/…`, so
    // `/llms.txt` is not reachable as a repo route even for a repository called
    // `llms.txt`.
    if (wantsLlms(request.method, url.pathname)) {
      const doc = renderLlms(url.host, caps, operator)
      const bytes = new TextEncoder().encode(doc)
      record(env, ctx, {
        kind: 'landing',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: 200,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          // Same minute as the page, and for the same reason: it states the
          // limits this deployment enforces, so a stale copy would outlive a
          // config change.
          'cache-control': 'public, max-age=60',
        },
      })
    }

    // `/robots.txt`, beside the manual it points at and for the same reasons.
    // Until this branch existed the path was answered by Cloudflare's managed
    // Content Signals file, which says nothing either way — and a crawler that
    // reads silence as a refusal will not fetch a host that exists to be read
    // by agents. This says yes in the protocol's own words. Same collision
    // argument as `/llms.txt`: a repository called `robots.txt` is reached at
    // `/robots.txt.git/…`, so the document cannot shadow one.
    if (wantsRobots(request.method, url.pathname)) {
      const doc = renderRobots(url.host)
      const bytes = new TextEncoder().encode(doc)
      record(env, ctx, {
        kind: 'landing',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: 200,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      })
    }

    // `/agentgit-og.png` — the picture the card the head advertises is made
    // of (shared/og-image.ts). At the edge for the reason the page is, and
    // more so: the traffic is crawlers, arriving in a burst when a link is
    // posted, and not one of them should wake the container for a picture
    // that changes only on deploy. The bytes are in the bundle, so nothing is
    // fetched to serve it. Same collision argument as `/llms.txt` and
    // `/robots.txt`: a repository called `agentgit-og.png` is reached at
    // `/agentgit-og.png.git/…`, so this route cannot shadow one.
    if (wantsOgImage(request.method, url.pathname)) {
      record(env, ctx, {
        kind: 'og-image',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: 200,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        // A HEAD is answered with headers only, so it served no bytes.
        bytesServed: request.method === 'HEAD' ? 0 : OG_IMAGE_BYTES.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : OG_IMAGE_BYTES, {
        status: 200,
        headers: {
          'content-type': OG_IMAGE_CONTENT_TYPE,
          // A day, where the page and the manual get a minute: the picture
          // states no capability and no limit, so nothing in it can outlive a
          // config change.
          'cache-control': OG_IMAGE_CACHE_CONTROL,
          // A HEAD must answer the size the GET would send; a Response built
          // from a null body would otherwise report none.
          'content-length': String(OG_IMAGE_BYTES.byteLength),
        },
      })
    }

    // `/favicon.ico` — the request a browser makes on every first view of the
    // page whatever the head declares, and the one the container was answering
    // 404 to ~282 times in the two hours after the launch link went up. The
    // bytes are the mark the head already inlines, read from one constant
    // (shared/favicon.ts → shared/landing.ts), so the tab and the masthead
    // cannot drift. Same collision argument as `/llms.txt`, `/robots.txt` and
    // `/agentgit-og.png`: a repository called `favicon.ico` is reached at
    // `/favicon.ico.git/…`, so this route cannot shadow one.
    if (wantsFavicon(request.method, url.pathname)) {
      const bytes = new TextEncoder().encode(FAVICON_BODY)
      record(env, ctx, {
        kind: 'favicon',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: 200,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: request.method === 'HEAD' ? 0 : bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: {
          'content-type': FAVICON_CONTENT_TYPE,
          'cache-control': ICON_CACHE_CONTROL,
          // A HEAD must answer the size the GET would send.
          'content-length': String(bytes.byteLength),
        },
      })
    }

    // The touch icons iOS asks for when a page is bookmarked, which the head
    // does not declare and no raster exists for. 204 rather than 404 because a
    // 404 is what a client retries; with the day-long cache header above, this
    // is asked once a day instead of once a page. Same collision argument.
    if (wantsTouchIcon(request.method, url.pathname)) {
      record(env, ctx, {
        kind: 'favicon',
        repo: '',
        outcome: 'ok',
        reject: '',
        status: TOUCH_ICON_STATUS,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: 0,
        bytesReceived: 0,
      })
      return new Response(null, {
        status: TOUCH_ICON_STATUS,
        headers: { 'cache-control': ICON_CACHE_CONTROL },
      })
    }

    // `/repos` — the repository list (`shared/repo-list.ts`), answered at the
    // edge off the log. Placed after the icon routes and before anything that
    // could be a repository, so `/robots.txt` and `/favicon.ico` keep being
    // answered by the branches above rather than by a browse route.
    //
    // Claimed from `caps.web` — the same field the two documents advertise it
    // from — so with the capability off the path falls through to the
    // container, which does not route it, and the client gets the 404 it got
    // before this route existed.
    //
    // The store is built here rather than in `shared/`: the reading is shared
    // (`s3StoreFrom`), but the signer belongs to whichever half has
    // `aws4fetch` to hand. A deployment with the view on and no object store
    // configured is answered 503 below rather than proxied.
    if (caps.web && wantsRepoList(request.method, url.pathname)) {
      const store = edgeStore(env)
      // A deployment that turned the view on without configuring an object
      // store has no log to list. Answered here rather than proxied: falling
      // through would wake the container for a path it does not route, which
      // is the one thing this route exists not to do, and a 404 would say the
      // view does not exist when what is missing is the bucket.
      const answer = !store
        ? {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
            body: 'walgit: no object store configured, so there is no log to list\n',
          }
        : await repoListResponse(
            {
              method: request.method,
              accept,
              authorization: request.headers.get('authorization'),
              search: url.search,
            },
            { store, caps, tokens: parseTokens(env.WALGIT_HTTP_TOKENS) },
          )
      const bytes = new TextEncoder().encode(answer.body)
      record(env, ctx, {
        kind: 'list',
        repo: '',
        outcome: answer.status < 400 ? 'ok' : 'reject',
        reject: answer.status < 400 ? '' : answer.status === 401 ? 'unauthorized' : 'unavailable',
        status: answer.status,
        // The container was not involved at all, which is the property this
        // branch exists to create — the same claim the landing page makes.
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: request.method === 'HEAD' ? 0 : bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: answer.status,
        headers: answer.headers,
      })
    }

    // `/<name>` and `/<name>/tree/…` — the two repository pages
    // (`shared/browse.ts`). Placed after the list and before anything that
    // could be a repository, for the same reason the list is: the icon and
    // document routes above keep answering their own paths rather than being
    // claimed as a repository called `robots.txt`.
    //
    // Unlike the list this cannot be answered off the log: a tree is git
    // objects, and only the Cache holds those. So the edge asks the container's
    // `/_walgit/browse` and renders the answer — one round trip, because
    // `op=tree` carries the ref list with it — and a refusal is passed through
    // verbatim, which is what keeps the browse gate the clone gate and not a
    // second one (docs/adr/0013).
    //
    // Claimed from `caps.web`, the same field the list and the two documents
    // read, so with `WALGIT_WEB` off the path falls through to the container
    // exactly as it did before this route existed.
    const browseRoute = caps.web ? wantsBrowse(request.method, url.pathname) : null
    if (browseRoute) {
      const answer = await browseResponse(
        browseRoute,
        { method: request.method, accept },
        {
          caps,
          ask: async (query) => {
            const asked = new Request(`https://walgit.internal${BROWSE_PATH}${query}`, {
              // The client's own credential, and nothing else: the container
              // answers this behind the deployment token and then the Read
              // Challenge, and the edge must not be able to open a door the
              // client could not.
              headers: authorizationOf(request),
            })
            const res = await getContainer(env.WALGIT_CONTAINER).fetch(asked)
            return {
              status: res.status,
              text: await res.text(),
              contentType: res.headers.get('content-type') ?? '',
              served: res.headers.get(SERVED_HEADER) !== null,
              reject: res.headers.get(REJECT_HEADER) ?? '',
              // One value, already comma-joined by the runtime: a Private
              // repository is refused with two `WWW-Authenticate` lines, and
              // what arrives here is the joined header. Passed on as it came
              // rather than re-split, because the split is what a parser gets
              // wrong on a nonce containing `=`.
              challenges: [res.headers.get('www-authenticate')].filter(
                (value): value is string => value !== null,
              ),
            }
          },
        },
      )
      const bytes = new TextEncoder().encode(answer.body)
      record(env, ctx, {
        kind: 'browse',
        repo: browseRoute.repo,
        outcome: answer.status < 400 ? 'ok' : 'reject',
        // The container's own words for the refusal, so a browse refused by
        // the Private gate is counted as the `unauthorized` it is rather than
        // re-derived from a status several refusals share — and so a refusal
        // the container never made still reads as `edge`.
        reject: answer.status < 400 ? '' : upstreamReject(answer.upstream),
        status: answer.status,
        // The CONTAINER answered the question this page was rendered from, and
        // saying otherwise would make the `edge` refusal signal unreadable.
        served: answer.upstream.served,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: request.method === 'HEAD' ? 0 : bytes.byteLength,
        bytesReceived: 0,
      })
      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: answer.status,
        headers: answer.headers,
      })
    }

    // The ref-event stream, answered at the edge for the same reason the
    // landing page is: a subscription is a socket the container has no reason
    // to hold, and holding one would keep the single container awake for as
    // long as anybody is watching. When the feature is unconfigured neither
    // path is claimed at all — the request falls through to the container,
    // which does not route it, and the client gets the same 404 as for any
    // other path that does not exist.
    //
    // Claimed from the same `caps.events` the two documents advertise from, so
    // the route and the documents cannot disagree. That takes BOTH halves: with
    // only the token this used to claim the socket, answer the handshake with
    // current refs, and then deliver nothing forever, because the container's
    // `post-receive` had no URL to announce to.
    if ((url.pathname === EVENTS_PATH || url.pathname === ANNOUNCE_PATH) && caps.events) {
      return events(request, url, env, caps)
    }

    // The MCP endpoint (`shared/mcp.ts`), answered at the edge like the two
    // documents above: a tool call is a question about a name, and the manual
    // it also serves is rendered from these same capabilities rather than
    // fetched. Unconditionally routed, unlike the socket above — the endpoint
    // is a read surface that exists on every deployment, and the one tool that
    // needs the stream (`agentgit_watch`) says so itself where it is off.
    //
    // Same collision argument as `/llms.txt` and its neighbours, and stronger:
    // `/_walgit/` is reserved, and a repository called `mcp` is reached at
    // `/mcp.git/…`, so this route cannot shadow one.
    if (url.pathname === MCP_PATH) {
      const response = await handleMcp(request, env, caps, operator, url.host)
      record(env, ctx, {
        // Classified rather than hand-labelled, so the kind this row carries
        // and the kind `shared/telemetry.ts` names for this path cannot become
        // two facts.
        ...classifyRequest(request.method, url.pathname, url.search),
        // From the HTTP status, and deliberately not from the JSON-RPC body:
        // a tool that REFUSED — a Private name an unproven reader asked about —
        // answers 200 carrying `isError`, and is counted `ok` here. That is the
        // honest reading of this column (the request was served) and the only
        // affordable one: seeing the refusal would mean buffering and parsing
        // every response body to label a row. A refusal the endpoint makes at
        // the HTTP level, a malformed JSON-RPC body's 400, is counted.
        outcome: response.ok ? 'ok' : 'reject',
        reject: response.ok ? '' : 'other',
        status: response.status,
        // The container answers `agentgit_status` and `agentgit_provenance`
        // behind this, but the REQUEST was answered here — `served` is about
        // which layer produced the response, and saying otherwise would make
        // the `edge` refusal signal unreadable.
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        // Not counted: an MCP body is small and may be a stream held open for
        // five minutes by `agentgit_watch`, and wrapping it to weigh it would
        // hold the datapoint for the length of the wait.
        bytesServed: 0,
        bytesReceived: Number(request.headers.get('content-length') ?? '0') || 0,
      })
      return response
    }

    const facts = classifyRequest(request.method, url.pathname, url.search)

    // The container's expiry endpoint trusts INTERNAL_HEADER to mean "the
    // scheduled handler asked". That is only true because this line makes it
    // true: every request arriving from the internet has the header removed
    // before it is proxied, whatever the client set it to. Done for ALL paths,
    // not just the one, so a future internal endpoint inherits the guarantee
    // instead of having to remember it.
    const forwarded = stripInternal(request)

    let response: Response
    try {
      // No id, so one singleton container serves every repository. That is not a
      // scaling ceiling imposed by the design — `index.json` is compare-and-swap
      // and `sync.ts` reconciles on every access, so any container could take any
      // push — it is cache locality: a second instance starts with an empty disk
      // and materializes everything it is asked for from the log.
      response = await getContainer(env.WALGIT_CONTAINER).fetch(forwarded)
    } catch (error) {
      // The container never answered, so nothing downstream can name this
      // refusal — it is an `edge` one by construction, and counting it as such
      // is the point: walgit refusing things itself, with an explanation, is
      // the product, so a refusal made in front of it is a bug signal.
      record(env, ctx, {
        ...base(facts, request),
        outcome: 'reject',
        reject: 'edge',
        status: 0,
        served: false,
        cold: false,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        bytesServed: 0,
      })
      throw error
    }

    const ttfbMs = Date.now() - startedAt
    const { outcome, reject } = classifyOutcome(response.status, response.headers)
    const metric: RequestMetric = {
      ...base(facts, request),
      outcome,
      reject,
      status: response.status,
      served: response.headers.get(SERVED_HEADER) !== null,
      cold: response.headers.get(COLD_HEADER) !== null,
      ttfbMs,
      totalMs: ttfbMs,
      bytesServed: 0,
    }

    const headers = new Headers(response.headers)
    for (const name of INTERNAL_HEADERS) headers.delete(name)

    if (!response.body) {
      record(env, ctx, metric)
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    // Bytes served and total time are only known when the last byte is written,
    // and a clone is a long stream. Counting them in a pass-through transform
    // adds no copy and no buffering: the chunk is measured and forwarded, and
    // the datapoint is written after the client already has its response.
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          metric.bytesServed += chunk.byteLength
          controller.enqueue(chunk)
        },
        flush() {
          metric.totalMs = Date.now() - startedAt
          record(env, ctx, metric)
        },
        cancel() {
          // An abandoned clone still cost what it cost; recording it as if it
          // completed would quietly under-count the bytes this service serves.
          metric.totalMs = Date.now() - startedAt
          record(env, ctx, metric)
        },
      }),
    )
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },

  /**
   * The expiry sweeper's timer (`wrangler.jsonc` → `triggers.crons`).
   *
   * It lives here rather than inside the container because the container SLEEPS
   * when idle: an interval running in there would stop firing precisely when
   * nothing is keeping it awake, which is exactly the state a repository has to
   * be in to be collectable. The Cron Trigger wakes it instead, and the wake is
   * the only cost — a sweep with nothing to collect is one delimited LIST.
   *
   * The report is logged rather than swallowed, because "the sweeper runs on a
   * schedule and its output is visible" is the requirement, and a sweep that
   * deletes repositories silently is the one failure mode nobody notices until
   * the repositories are gone. A deployment with no `WALGIT_RETENTION_HOURS`
   * has no sweep endpoint at all: the container answers 404, this logs it, and
   * nothing is collected — which is correct for an instance that never promised
   * a retention window.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(event, env))
  },
}

/**
 * What kind of refusal a browse was, in the container's own vocabulary.
 *
 * `classifyOutcome` (`shared/telemetry.ts`) rather than a second reading of the
 * same two headers — the page module carries them back as values because
 * `shared/` holds no `Headers`, and this is where they become one again.
 */
function upstreamReject(upstream: { status: number; served: boolean; reject: string }): RejectKind {
  const headers = {
    get: (name: string): string | null => {
      if (name === REJECT_HEADER) return upstream.reject === '' ? null : upstream.reject
      if (name === SERVED_HEADER) return upstream.served ? '1' : null
      return null
    },
  }
  return classifyOutcome(upstream.status, headers).reject || 'other'
}

/**
 * The credential the CLIENT presented, and nothing else.
 *
 * The container answers the browse behind the deployment token and then the
 * Read Challenge, so the edge must forward what the reader sent rather than
 * anything of its own: a browse that opened a door the client could not open
 * for itself would be the second authorization model ADR-0013 refuses.
 */
function authorizationOf(request: Request): HeadersInit {
  const authorization = request.headers.get('authorization')
  return authorization ? { authorization } : {}
}

/**
 * The two ends of the ref-event stream: a subscriber connecting, and the push
 * path publishing.
 *
 * Both are gated here rather than inside the Durable Object, because this is
 * the layer that holds the environment — the read tokens and the announce
 * secret — and the object should not carry a second copy of either. What it
 * gets is a request that has already been allowed.
 *
 * The capabilities are PASSED IN rather than derived again, so the socket
 * cannot reach a different verdict from the route that claimed it or from the
 * documents that advertised it.
 */
async function events(request: Request, url: URL, env: Env, caps: Capabilities): Promise<Response> {
  const stub = env.WALGIT_EVENTS.get(env.WALGIT_EVENTS.idFromName(EVENTS_OBJECT_NAME))

  if (url.pathname === ANNOUNCE_PATH) {
    if (request.method !== 'POST') return new Response('method not allowed\n', { status: 405 })
    if (!authorizeAnnounce(request.headers.get('authorization'), env.WALGIT_EVENTS_TOKEN ?? '')) {
      return new Response('unauthorized\n', { status: 401 })
    }
    return stub.fetch(
      new Request(`https://walgit.internal${BROADCAST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request.body,
      }),
    )
  }

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade\n', { status: 426 })
  }
  // Exactly the credential a read of the repository needs — see
  // `authorizeSubscribe`. The challenge header is sent for the same reason the
  // container sends it: a client that can be prompted should be.
  //
  // `caps.publicAccess`, not `env.WALGIT_PUBLIC === '1'`. This line used to
  // read the variable a third way: `flagEnabled` (`1` or `true`) fed
  // `/llms.txt`'s access claim, `=== '1'` fed this socket and the container's
  // git auth. On a deployment spelling it `true` the manual told an agent that
  // reads need no credential while every subscribe answered 401 — the exact
  // hazard `flagEnabled` was written for (`shared/policy.ts`).
  const allowed = authorizeSubscribe({
    authorization: request.headers.get('authorization'),
    tokens: parseTokens(env.WALGIT_HTTP_TOKENS),
    isPublic: caps.publicAccess,
  })
  if (!allowed) {
    return new Response('unauthorized\n', {
      status: 401,
      headers: { 'www-authenticate': BASIC_CHALLENGE },
    })
  }
  return stub.fetch(request)
}

async function sweep(event: ScheduledController, env: Env): Promise<void> {
  const request = new Request(`https://walgit.internal${EXPIRE_PATH}`, {
    method: 'POST',
    headers: { [INTERNAL_HEADER]: '1' },
  })
  try {
    const response = await getContainer(env.WALGIT_CONTAINER).fetch(request)
    const body = (await response.text()).trim()
    console.log(`walgit expire [cron ${event.cron}]: ${response.status} ${body}`)
  } catch (error) {
    // Logged, never thrown: a failed sweep is storage that stays a little
    // longer, and over-retaining is the safe direction. Throwing would only
    // turn it into an unhandled rejection nobody reads.
    console.error(`walgit expire [cron ${event.cron}] failed: ${(error as Error).message}`)
  }
}

/**
 * The object store, as the edge reads it — or `null` when this deployment has
 * not configured one.
 *
 * The reading itself is the shared one (`s3StoreFrom`, `shared/store.ts`), the
 * same the container makes; what is here is only the dependency it takes, since
 * the signer belongs to whichever half has `aws4fetch` to hand.
 */
function edgeStore(env: Env): ObjectStore | null {
  return s3StoreFrom(env, (credentials) => new AwsClient(credentials))
}

/**
 * The same request with any client-supplied INTERNAL_HEADER removed.
 *
 * Rebuilt rather than mutated — a Request's headers are immutable — with the
 * body passed through by reference, so a 90 MiB push is not buffered to drop
 * one header.
 */
function stripInternal(request: Request): Request {
  if (!request.headers.has(INTERNAL_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(INTERNAL_HEADER)
  return new Request(request, { headers })
}

/** The facts known before the container answers. */
function base(
  facts: { kind: RequestMetric['kind']; repo: string; bucket?: RequestMetric['bucket'] },
  request: Request,
): Pick<RequestMetric, 'kind' | 'repo' | 'bucket' | 'bytesReceived'> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  return {
    kind: facts.kind,
    repo: facts.repo,
    // Only `other` carries one, and only `other` writes it to the datapoint —
    // which is the one kind that reaches this helper without a route to name.
    bucket: facts.bucket,
    bytesReceived: Number.isFinite(declared) ? declared : 0,
  }
}

/**
 * Write one datapoint, off the serving path.
 *
 * `waitUntil` is what keeps the promise in the acceptance criteria — the client
 * is never waiting on a metric — and the try/catch is what keeps telemetry from
 * ever being the reason a git request failed.
 */
function record(env: Env, ctx: ExecutionContext, metric: RequestMetric): void {
  if (!env.WALGIT_METRICS) return
  try {
    ctx.waitUntil(Promise.resolve(env.WALGIT_METRICS.writeDataPoint(toDataPoint(metric))))
  } catch {
    // Deliberately silent: a dropped datapoint is a gap in a chart, and
    // anything louder would turn one into a failed clone.
  }
}
