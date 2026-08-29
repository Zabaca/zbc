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
 * the Worker's own secrets.
 *
 * It also owns the one thing only this side can see: request-level telemetry.
 * The log is already a usage ledger for pushes and storage, but a clone writes
 * nothing to it, so read volume, latency, cold starts and refusals are counted
 * here instead — off the serving path, and only for what the log cannot answer
 * (worker/telemetry.ts).
 *
 * Reads are proxied like everything else. Serving a fetch straight from R2 at
 * the edge, without waking the container, is a real optimisation and
 * deliberately not in this milestone.
 */

import { Container, getContainer } from '@cloudflare/containers'

import {
  COLD_HEADER,
  INTERNAL_HEADERS,
  SERVED_HEADER,
  classifyOutcome,
  classifyRequest,
  toDataPoint,
  type RequestMetric,
} from './telemetry'

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
   * cannot produce (worker/telemetry.ts). Optional: a deployment without the
   * binding simply records nothing, and serves exactly as before.
   */
  WALGIT_METRICS?: AnalyticsEngineDataset
}

/** Every variable the container is allowed to be told about, and no more. */
const CONTAINER_ENV = [
  'WALGIT_HTTP_TOKENS',
  'WALGIT_S3_ENDPOINT',
  'WALGIT_S3_BUCKET',
  'WALGIT_S3_ACCESS_KEY_ID',
  'WALGIT_S3_SECRET_ACCESS_KEY',
  'WALGIT_S3_REGION',
  'WALGIT_COMPACTION_THRESHOLD',
  'WALGIT_GC_GRACE_MS',
  'WALGIT_DELETE_GRACE_MS',
  // A limit that does not reach the container is a limit `GET /` never states
  // and the push path never enforces — silently, since every one of these is
  // optional and an unset one simply means unenforced.
  'WALGIT_PUBLIC',
  'WALGIT_APPEND_ONLY',
  'WALGIT_RETENTION_HOURS',
  'WALGIT_MAX_PUSH_BYTES',
  'WALGIT_MAX_REPO_BYTES',
] as const

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
  envVars = Object.fromEntries(
    CONTAINER_ENV.map((name) => [name, this.env[name] ?? '']).filter(([, value]) => value !== ''),
  ) as Record<string, string>

  onStart(): void {
    this.freshStart = true
  }

  async fetch(request: Request): Promise<Response> {
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
    const url = new URL(request.url)
    const facts = classifyRequest(request.method, url.pathname, url.search)
    const startedAt = Date.now()

    let response: Response
    try {
      // No id, so one singleton container serves every repository. That is not a
      // scaling ceiling imposed by the design — `index.json` is compare-and-swap
      // and `sync.ts` reconciles on every access, so any container could take any
      // push — it is cache locality: a second instance starts with an empty disk
      // and materializes everything it is asked for from the log.
      response = await getContainer(env.WALGIT_CONTAINER).fetch(request)
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
      return new Response(null, { status: response.status, statusText: response.statusText, headers })
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
    return new Response(counted, { status: response.status, statusText: response.statusText, headers })
  },
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
