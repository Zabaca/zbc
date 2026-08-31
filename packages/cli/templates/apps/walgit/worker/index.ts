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

import { Container, getContainer } from '@cloudflare/containers'

import { containerEnv, fingerprintEnv } from '../shared/container-env'
import { parseTokens } from '../shared/credentials'
import { authorizeAnnounce, authorizeSubscribe, eventsEnabled } from '../shared/events'
import { type LandingFacts, renderLanding, wantsLanding } from '../shared/landing'
import { renderLlms, wantsLlms } from '../shared/llms'
import { flagEnabled, positiveNumber } from '../shared/policy'
import { signedPushEnabled } from '../shared/provenance'
import {
  ANNOUNCE_PATH,
  COLD_HEADER,
  EVENTS_PATH,
  EXPIRE_PATH,
  INTERNAL_HEADER,
  INTERNAL_HEADERS,
  SERVED_HEADER,
} from '../shared/protocol'
import {
  classifyOutcome,
  classifyRequest,
  toDataPoint,
  type RequestMetric,
} from '../shared/telemetry'
import { BROADCAST_PATH, EVENTS_OBJECT_NAME, WalgitEvents } from './events-do'

export interface Env {
  WALGIT_CONTAINER: DurableObjectNamespace<WalgitContainer>
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
  /** The policy `GET /` states and the push path enforces (src/instructions.ts). */
  WALGIT_PUBLIC?: string
  WALGIT_APPEND_ONLY?: string
  WALGIT_RETENTION_HOURS?: string
  WALGIT_MAX_PUSH_BYTES?: string
  WALGIT_MAX_REPO_BYTES?: string
  /**
   * Where request-level telemetry goes — the half of observability the log
   * cannot produce (shared/telemetry.ts). Optional: a deployment without the
   * binding simply records nothing, and serves exactly as before.
   */
  WALGIT_METRICS?: AnalyticsEngineDataset
  /**
   * The ref-event stream (shared/events.ts). Off unless `WALGIT_EVENTS_TOKEN`
   * is set: without it nothing could publish an event, so the endpoints do not
   * exist rather than existing and staying silent. The token is the shared
   * secret the container's push path presents when it announces; the container
   * gets it, and the URL to announce to, through the forward list.
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
   * Replace the container if it is running an environment this deploy changed.
   *
   * `envVars` above is re-read on every Durable Object construction, and a
   * `wrangler deploy` constructs a new one — so this side is never stale. The
   * container is: it read `process.env` once at start and cannot be told
   * anything afterwards, and a vars-only deploy produces no new container image
   * for `--containers-rollout immediate` to roll. Without this, the new value
   * takes effect whenever the container next happens to idle out, which under
   * sustained traffic is never.
   *
   * The fingerprint is persisted in Durable Object storage because that is the
   * only state that survives the very event being detected — a redeploy
   * discards every in-memory field, so an in-memory copy would compare the new
   * environment against itself and always agree.
   */
  private async reconcileEnv(): Promise<void> {
    const current = fingerprintEnv(this.envVars ?? {})
    const booted = await this.ctx.storage.get<string>(ENV_FINGERPRINT_KEY)
    if (booted === current) return

    // Only a RUNNING container can be stale. A stopped one has nothing to
    // replace: its next start reads `envVars` as it now is, which is already
    // the new environment.
    //
    // No recorded fingerprint counts as a mismatch rather than as a fresh
    // start, deliberately. A running container with no record predates this
    // code, so what it booted with is unknowable — and on the deploy that
    // ships this, that container is exactly the one already serving a
    // superseded policy. Assuming it is current would leave the bug live
    // until the next idle. A DO that has never started a container reaches
    // here with `running` false and simply records.
    if (this.ctx.container?.running) {
      // SIGKILL rather than a graceful stop: the container serves git over
      // HTTP and holds nothing worth draining — every durable effect of a push
      // is in the log before it is acknowledged (docs/adr/0007) — and
      // `sleepAfter` already covers the polite path. `destroy` triggers
      // `onStop`; the next `containerFetch` starts a fresh one.
      await this.destroy()
      console.log(
        `walgit container env changed (${booted ?? 'unrecorded'} -> ${current}); container replaced`,
      )
    }
    // Written last, and only after a successful destroy: recording first would
    // make a failed replacement look reconciled forever.
    await this.ctx.storage.put(ENV_FINGERPRINT_KEY, current)
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

    // The browser half of `/`, answered at the edge (shared/landing.ts). Placed
    // before every other decision on purpose: a link on an aggregator points at
    // this exact URL, and none of that traffic should wake the container, queue
    // behind a clone, or count against the one instance serving git. git never
    // asks for HTML, so a clone cannot land here.
    const accept = request.headers.get('accept') ?? ''
    if (wantsLanding(request.method, url.pathname, accept)) {
      const page = renderLanding({
        host: url.host,
        // The same predicate that decides whether the socket path is claimed
        // below, so the page cannot advertise a stream this request would 404.
        events: eventsEnabled(env.WALGIT_EVENTS_TOKEN),
        // Same predicate as `/llms.txt` and `GET /`: git refuses `--signed`
        // against a host without the seed, so a page inviting somebody to sign
        // would be sending them to a refusal it caused.
        signedPushes: signedPushEnabled(env.WALGIT_PUSH_CERT_SEED),
        // Read through the shared flag helper, like append-only beside it: the
        // container enforces the gate from this variable and both documents
        // describe it from the same one, so neither can go on promising that
        // nothing is refused for being unsigned after the hook stopped agreeing.
        signerLists: flagEnabled(env.WALGIT_SIGNER_LISTS),
        ...limitsFromEnv(env),
      })
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
      const doc = renderLlms({
        host: url.host,
        events: eventsEnabled(env.WALGIT_EVENTS_TOKEN),
        // The same predicate the push path enforces with, from the shared
        // kernel, rather than a second reading of the same variables: a
        // document that tells an agent it needs no credential must not be one
        // spelling away from being wrong.
        publicAccess: flagEnabled(env.WALGIT_PUBLIC),
        appendOnly: flagEnabled(env.WALGIT_APPEND_ONLY),
        // Read through the same function the container turns the capability on
        // with (shared/provenance.ts): the seed is what makes `receive-pack`
        // advertise `push-cert` at all, so a manual that offered signing here
        // without one would send an agent to a flag its own git refuses.
        signedPushes: signedPushEnabled(env.WALGIT_PUSH_CERT_SEED),
        // Read through the shared flag helper, like append-only beside it: the
        // container enforces the gate from this variable and both documents
        // describe it from the same one, so neither can go on promising that
        // nothing is refused for being unsigned after the hook stopped agreeing.
        signerLists: flagEnabled(env.WALGIT_SIGNER_LISTS),
        ...limitsFromEnv(env),
      })
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

    // The ref-event stream, answered at the edge for the same reason the
    // landing page is: a subscription is a socket the container has no reason
    // to hold, and holding one would keep the single container awake for as
    // long as anybody is watching. When the feature is unconfigured neither
    // path is claimed at all — the request falls through to the container,
    // which does not route it, and the client gets the same 404 as for any
    // other path that does not exist.
    if (
      (url.pathname === EVENTS_PATH || url.pathname === ANNOUNCE_PATH) &&
      eventsEnabled(env.WALGIT_EVENTS_TOKEN)
    ) {
      return events(request, url, env)
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
 * The two ends of the ref-event stream: a subscriber connecting, and the push
 * path publishing.
 *
 * Both are gated here rather than inside the Durable Object, because this is
 * the layer that holds the environment — the read tokens and the announce
 * secret — and the object should not carry a second copy of either. What it
 * gets is a request that has already been allowed.
 */
async function events(request: Request, url: URL, env: Env): Promise<Response> {
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
  const allowed = authorizeSubscribe({
    authorization: request.headers.get('authorization'),
    tokens: parseTokens(env.WALGIT_HTTP_TOKENS),
    isPublic: env.WALGIT_PUBLIC === '1',
  })
  if (!allowed) {
    return new Response('unauthorized\n', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="walgit"' },
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

/**
 * The limit facts the page is allowed to claim.
 *
 * Literally the same reading as the push path's, because `positiveNumber` is
 * `shared/policy.ts`'s and `src/limits.ts` enforces through it: unset, blank,
 * unparseable or non-positive all mean "this deployment enforces nothing
 * here", so a typo in a variable removes a claim rather than inventing one. The
 * page then omits it (shared/landing.ts) instead of printing a number nobody
 * enforces.
 *
 * The three limits and nothing else: signing and the event stream are
 * capabilities rather than caps, they are read from different variables, and
 * each call site passes its own so a reader can see which predicate decided it.
 */
function limitsFromEnv(
  env: Env,
): Pick<LandingFacts, 'retentionHours' | 'maxPushBytes' | 'maxRepoBytes'> {
  return {
    retentionHours: positiveNumber(env.WALGIT_RETENTION_HOURS),
    maxPushBytes: positiveNumber(env.WALGIT_MAX_PUSH_BYTES),
    maxRepoBytes: positiveNumber(env.WALGIT_MAX_REPO_BYTES),
  }
}

/** The facts known before the container answers. */
function base(
  facts: { kind: RequestMetric['kind']; repo: string },
  request: Request,
): Pick<RequestMetric, 'kind' | 'repo' | 'bytesReceived'> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  return {
    kind: facts.kind,
    repo: facts.repo,
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
