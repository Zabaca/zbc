/**
 * What the write-ahead log cannot see.
 *
 * `src/usage.ts` derives storage, repository count and push volume from the log
 * itself, with no instrumentation to keep in sync. That view has one hole, and
 * it is structural rather than an oversight: a clone writes nothing to the log.
 * Read volume, bytes served, how long a request took, whether it paid for a
 * cold container and every refusal that never became a WAL entry are invisible
 * there and can only be counted where the request is — the Worker in front of
 * the container, which sees even the requests the container never receives.
 *
 * So this file counts exactly that hole and nothing else. Storage, repository
 * count and push bytes are deliberately NOT recorded here: two records of one
 * fact disagree the first time a write fails between them, and the log's copy
 * is the one that cannot drift.
 *
 * Refusals are counted BY KIND, never as an aggregate error rate, because the
 * kinds mean different things to whoever is reading:
 *
 *   - `size-cap`     a client pushing more than the instance allows — abuse, or
 *                    a misconfigured client
 *   - `collision`    a name already taken — a product signal about naming
 *   - `unauthorized` a bad or missing credential
 *   - `edge`         walgit did not refuse; something in front of it did. This
 *                    one is a BUG SIGNAL: every refusal walgit means to make it
 *                    should make itself, with an explanation. Absorbing it into
 *                    a general error count is how it would stay invisible.
 *
 * Pure on purpose — no Workers types, no bindings, no clock. `worker/index.ts`
 * owns the one side effect (a single `writeDataPoint`), and `src/telemetry.test.ts`
 * exercises everything here without a runtime.
 */

/** Header the container stamps on every response it produces itself. */
export const SERVED_HEADER = 'x-walgit-served'
/** Header naming a refusal's kind, set by whichever layer refused. */
export const REJECT_HEADER = 'x-walgit-reject'
/** Header the container sets on the first response after it started. */
export const COLD_HEADER = 'x-walgit-cold'

/**
 * Header marking a REQUEST as originated by this Worker rather than by a
 * client. The value is mirrored in `src/http.ts`, which is what reads it —
 * the same deliberate duplication as the two above, so the container process
 * and the Worker share a vocabulary without sharing a bundle.
 */
export const INTERNAL_REQUEST_HEADER = 'x-walgit-internal'

/** Stripped before the response leaves the Worker — internal, not protocol. */
export const INTERNAL_HEADERS = [SERVED_HEADER, REJECT_HEADER, COLD_HEADER] as const

/**
 * What the request was asking for.
 *
 * Split by protocol endpoint rather than by HTTP verb, because "how many
 * clones?" is the question an operator actually has, and a clone is two
 * requests: the ref advertisement, then the pack. Counting `clone` alone gives
 * the number of repositories actually read; counting `clone-advertise` alone
 * gives the number of clients that looked.
 */
export type RequestKind =
  | 'clone-advertise'
  | 'clone'
  | 'push-advertise'
  | 'push'
  | 'instructions'
  // The browser's `/`, answered at the edge and never proxied — so it is its
  // own kind rather than folded into `instructions`. Counting them together
  // would hide the one number a launch actually turns on: how many people read
  // the page versus how many clients read the protocol.
  | 'landing'
  | 'health'
  | 'other'

/** Every refusal walgit distinguishes. Aligned with the messages it emits. */
export type RejectKind =
  | 'size-cap'
  | 'collision'
  | 'unauthorized'
  | 'not-found'
  | 'unavailable'
  | 'edge'
  | 'other'

export type Outcome = 'ok' | 'reject'

const SMART_HTTP = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/

export interface RequestFacts {
  kind: RequestKind
  /** The repository the path names, or `''` for a request that names none. */
  repo: string
}

/**
 * Which endpoint, and which repository.
 *
 * The repository NAME is recorded. Every repository on a public walgit is
 * world-readable by construction, so a name is not a secret to leak — and
 * without it an operator watching a traffic spike cannot tell one busy
 * repository from a hundred. Nothing else about the caller is recorded: no IP,
 * no user agent, no credential, no bytes of anyone's repository content.
 */
export function classifyRequest(method: string, pathname: string, search: string): RequestFacts {
  if (pathname === '/_walgit/health') return { kind: 'health', repo: '' }
  if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
    return { kind: 'instructions', repo: '' }
  }

  const route = SMART_HTTP.exec(pathname)
  if (!route) return { kind: 'other', repo: '' }
  const repo = route[1]!

  if (route[2] === 'git-upload-pack') return { kind: 'clone', repo }
  if (route[2] === 'git-receive-pack') return { kind: 'push', repo }

  // The advertisement is the same URL for both directions; only `service` says
  // which, and a request without it is dumb-HTTP, which walgit does not serve.
  const service = new URLSearchParams(search).get('service')
  if (service === 'git-receive-pack') return { kind: 'push-advertise', repo }
  if (service === 'git-upload-pack') return { kind: 'clone-advertise', repo }
  return { kind: 'other', repo }
}

/**
 * Was this a refusal, and of what kind?
 *
 * The kind comes from the container when the container refused — it is the only
 * layer that knows the difference between a size cap and a name collision, and
 * naming it in a header beats re-deriving it from a status code that several
 * refusals share. Status is the fallback for a refusal that arrived with no
 * header, and the absence of the "served" stamp is what makes `edge` detectable
 * at all: a refusal walgit never produced is one something in front of it made
 * on walgit's behalf.
 */
export function classifyOutcome(
  status: number,
  headers: { get(name: string): string | null },
): { outcome: Outcome; reject: RejectKind | '' } {
  const declared = headers.get(REJECT_HEADER)
  if (declared) return { outcome: 'reject', reject: normalizeReject(declared) }
  if (status < 400) return { outcome: 'ok', reject: '' }
  if (headers.get(SERVED_HEADER) === null) return { outcome: 'reject', reject: 'edge' }
  return { outcome: 'reject', reject: fromStatus(status) }
}

const KINDS = new Set<RejectKind>([
  'size-cap',
  'collision',
  'unauthorized',
  'not-found',
  'unavailable',
  'edge',
  'other',
])

/** An unrecognised kind becomes `other` rather than a new column nobody reads. */
function normalizeReject(value: string): RejectKind {
  const kind = value.trim().toLowerCase()
  return KINDS.has(kind as RejectKind) ? (kind as RejectKind) : 'other'
}

function fromStatus(status: number): RejectKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not-found'
  if (status === 409) return 'collision'
  if (status === 413) return 'size-cap'
  if (status === 503) return 'unavailable'
  return 'other'
}

export interface RequestMetric {
  kind: RequestKind
  repo: string
  outcome: Outcome
  reject: RejectKind | ''
  status: number
  /** The container answered this one (as opposed to something in front of it). */
  served: boolean
  /** The container had just started when it answered — the cold path. */
  cold: boolean
  /** Time to the response headers: what a client waits before anything moves. */
  ttfbMs: number
  /** Time until the last byte was written: what a clone actually costs. */
  totalMs: number
  /** Response body bytes. The read-volume number the log cannot produce. */
  bytesServed: number
  /** Declared request body bytes, or 0 when the client did not declare one. */
  bytesReceived: number
}

/** The Analytics Engine datapoint shape, kept here so a test can pin it. */
export interface DataPoint {
  indexes: string[]
  blobs: string[]
  doubles: number[]
}

/**
 * One datapoint per request.
 *
 * `indexes` takes the request kind: Analytics Engine samples per index, and
 * sampling clones (the loud thing) independently of refusals (the rare thing
 * an operator is actually hunting) is what keeps a handful of refusals visible
 * under load.
 */
export function toDataPoint(metric: RequestMetric): DataPoint {
  return {
    indexes: [metric.kind],
    blobs: [
      metric.kind,
      metric.outcome,
      metric.reject,
      metric.repo,
      metric.cold ? 'cold' : 'warm',
      metric.served ? 'container' : 'edge',
    ],
    doubles: [
      metric.status,
      metric.ttfbMs,
      metric.totalMs,
      metric.bytesServed,
      metric.bytesReceived,
      metric.cold ? 1 : 0,
    ],
  }
}

/** Column names for the datapoint above — the legend for a SQL API query. */
export const BLOB_COLUMNS = [
  'kind',
  'outcome',
  'reject',
  'repo',
  'temperature',
  'answered',
] as const
export const DOUBLE_COLUMNS = [
  'status',
  'ttfb_ms',
  'total_ms',
  'bytes_served',
  'bytes_received',
  'cold',
] as const
