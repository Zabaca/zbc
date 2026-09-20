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
 * Refusals are counted BY KIND, never as an aggregate error rate — the kinds
 * and what each one means are `shared/protocol.ts`'s, because the container is
 * the layer that names most of them and this is the layer that counts them.
 *
 * Pure on purpose — no Workers types, no bindings, no clock. `worker/index.ts`
 * owns the one side effect (a single `writeDataPoint`), and `src/telemetry.test.ts`
 * exercises everything here without a runtime.
 */

import {
  HEALTH_PATH,
  MCP_PATH,
  PROVENANCE_PATH,
  REJECT_HEADER,
  REPO_ID,
  REPOS_PATH,
  SERVED_HEADER,
  SMART_HTTP,
  normalizeReject,
  wantsBrowse,
  type RejectKind,
} from './protocol'

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
  // The card's picture (`shared/og-image.ts`), answered at the edge like the
  // page and, like the page, its own kind. A crawler burst fetching a 40 KB
  // raster is not a burst of people reading the page, and counting the two
  // together would put the second number into the first — which is the one
  // number a launch is read by.
  | 'og-image'
  // `/favicon.ico` and the touch icons (`shared/favicon.ts`), answered at the
  // edge. Its own kind rather than `other`, because `other` is the unroutable
  // bucket and these are requests walgit now answers — and because the count
  // is the measure of what the route absorbed.
  | 'favicon'
  // The repository list (`shared/repo-list.ts`), answered at the edge off the
  // log. Its own kind for the reason `mcp` and `provenance` are — `other` is
  // the unroutable bucket and this is a request walgit answers — and counted
  // separately from `landing` because the two measure different things: the
  // page is what a stranger reads, the list is what somebody who has decided
  // to look around reads. It is recorded even on a deployment with the
  // capability off, where the path falls through to a container that does not
  // route it: the row is then a 404, which is the honest reading and a useful
  // one (it is demand for a switch nobody has flipped).
  | 'list'
  // One of the two repository pages (`shared/browse.ts`). Its own kind for the
  // reason `list` is — `other` is the unroutable bucket and this is a request
  // walgit answers — and, unlike the list, it NAMES a repository, because it is
  // about exactly one. It is recorded even on a deployment with the capability
  // off, where the path falls through to a container that does not route it:
  // the row is then a 404, which is the honest reading and a useful one.
  | 'browse'
  | 'health'
  // Someone asking who pushed (docs/adr/0011). Its own kind rather than
  // `other`, because `other` is the unroutable bucket and a provenance read is
  // a request walgit answers — folding the two together would hide both the
  // demand for the feature and any refusal it produces, and would lose the
  // repository name with them.
  | 'provenance'
  // An MCP client calling a tool (`shared/mcp.ts`), answered at the edge like
  // the documents above. Its own kind rather than `other` for the reason
  // `provenance` is, and one kind for the whole endpoint rather than one per
  // tool: the tool and the repository it names are inside a JSON-RPC body, and
  // a classifier that read request bodies to label a row would be buffering
  // every push to count it.
  | 'mcp'
  | 'other'

export type Outcome = 'ok' | 'reject'

export interface RequestFacts {
  kind: RequestKind
  /** The repository the path names, or `''` for a request that names none. */
  repo: string
  /**
   * For kind `other` only: which SHAPE of unroutable path this was. Present
   * nowhere else, because nowhere else is a mystery.
   */
  bucket?: OtherBucket
}

/**
 * The shape of an unroutable path, as a closed set.
 *
 * `other` is where every 404 lands, and until this existed a spike in it was
 * unattributable: the dataset records no path, so the 282 rows of the
 * 2026-09-18 launch burst could only be guessed at (browser favicons, plus a
 * scanner baseline). One bounded blob makes the next such question a SQL query.
 *
 * Bounded is the whole design. A path is attacker-controlled and unbounded, so
 * it never reaches the dataset; what reaches it is one of these seven names,
 * and an input that matches none of them is `else`.
 */
export type OtherBucket =
  | 'favicon'
  | 'apple-touch'
  | 'well-known'
  | 'dotfile'
  | 'php'
  | 'bare-name'
  | 'else'

/**
 * Sort a path into one of the seven. Pure, total and never throwing: a bucket
 * is a count, and a count is never worth failing a request over, so anything
 * unexpected is `else`.
 *
 * `favicon` and `apple-touch` should be empty once the edge routes answer them
 * (`shared/favicon.ts`) — they are kept as tripwires, so a route that stops
 * matching shows up as rows rather than as silence.
 */
export function otherBucket(pathname: string): OtherBucket {
  try {
    if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return 'favicon'
    if (pathname.startsWith('/apple-touch-icon')) return 'apple-touch'
    if (pathname.startsWith('/.well-known/')) return 'well-known'
    const segments = pathname.split('/').filter((s) => s.length > 0)
    if (segments.some((s) => s.startsWith('.'))) return 'dotfile'
    if (pathname.endsWith('.php')) return 'php'
    if (segments.length === 1 && !segments[0]!.includes('.')) return 'bare-name'
    return 'else'
  } catch {
    return 'else'
  }
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
  if (pathname === HEALTH_PATH) return { kind: 'health', repo: '' }
  // No repository: the name a tool acts on travels in the JSON-RPC body, and
  // the body is not something this function reads (see `RequestKind`).
  if (pathname === MCP_PATH) return { kind: 'mcp', repo: '' }
  // No repository: the list is about all of them.
  if (pathname === REPOS_PATH) return { kind: 'list', repo: '' }
  if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
    return { kind: 'instructions', repo: '' }
  }
  // The repository is in the query string here, not the path — the one endpoint
  // that names one without going through `SMART_HTTP`. Read anyway, because a
  // provenance read with no repository attached is a row an operator cannot act
  // on, and the name is already recorded for every clone of the same repo. Only
  // a name walgit would actually serve is kept: the query string is
  // attacker-controlled and unbounded, and a datapoint is not the place to find
  // that out.
  if (pathname === PROVENANCE_PATH) {
    const requested = new URLSearchParams(search).get('repo') ?? ''
    return { kind: 'provenance', repo: REPO_ID.test(requested) ? requested : '' }
  }

  const route = SMART_HTTP.exec(pathname)
  if (!route) {
    // `/<name>` and `/<name>/tree/…` — read through the same `wantsBrowse` the
    // edge routes on (`shared/protocol.ts`), so a path one claimed and the
    // other did not cannot become a metric describing traffic that never
    // happened. Below `SMART_HTTP` because a clone URL is not a browse URL and
    // the git grammar is the one that must win.
    //
    // A path whose SHAPE already has a name keeps it. `/wp-login.php` and
    // `/.env` are repository-shaped — a repository may be called `wp-login.php`
    // — but they are the scanner baseline those buckets exist to measure, and
    // counting them as people reading a repository page would put the noise
    // into the one number a launch is read by. The edge still routes them: a
    // browse of a name the log has no Index for is a 404 either way.
    const bucket = otherBucket(pathname)
    const browse =
      bucket === 'bare-name' || bucket === 'else' ? wantsBrowse(method, pathname) : null
    if (browse) return { kind: 'browse', repo: browse.repo }
    return { kind: 'other', repo: '', bucket }
  }
  const repo = route[1]!

  if (route[2] === 'git-upload-pack') return { kind: 'clone', repo }
  if (route[2] === 'git-receive-pack') return { kind: 'push', repo }

  // The advertisement is the same URL for both directions; only `service` says
  // which, and a request without it is dumb-HTTP, which walgit does not serve.
  const service = new URLSearchParams(search).get('service')
  if (service === 'git-receive-pack') return { kind: 'push-advertise', repo }
  if (service === 'git-upload-pack') return { kind: 'clone-advertise', repo }
  // A smart-HTTP-shaped path that named no service: routable enough to name a
  // repository, so the bucket is `else` rather than anything about the shape.
  return { kind: 'other', repo, bucket: 'else' }
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
  return outcomeOf({
    status,
    declared: headers.get(REJECT_HEADER),
    served: headers.get(SERVED_HEADER) !== null,
  })
}

/**
 * The same judgement, from the two facts rather than from a `Headers`.
 *
 * Some callers have already read the stamps into values — the browse page
 * carries them back from the container as `{ served, reject }`
 * (`shared/browse.ts`), because `shared/` has no `Headers` to hand around. They
 * ask this directly rather than building a stand-in object for the reader
 * above to take apart again.
 */
export function outcomeOf(answer: {
  status: number
  /** `REJECT_HEADER`'s value, or `null`/`''` where the layer named no kind. */
  declared: string | null
  /** The container stamped it (`SERVED_HEADER`). */
  served: boolean
}): { outcome: Outcome; reject: RejectKind | '' } {
  if (answer.declared) return { outcome: 'reject', reject: normalizeReject(answer.declared) }
  if (answer.status < 400) return { outcome: 'ok', reject: '' }
  if (!answer.served) return { outcome: 'reject', reject: 'edge' }
  return { outcome: 'reject', reject: fromStatus(answer.status) }
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
  /**
   * For kind `other`: which shape of unroutable path. Every other kind writes
   * `''`, so the column exists on every row and a `GROUP BY` over it is honest.
   */
  bucket?: OtherBucket
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
      // Seventh blob, added after a launch burst of unattributable 404s. A
      // bucket name or `''` — never the path (see `otherBucket`). Appending
      // rather than inserting is what keeps every existing query working.
      metric.kind === 'other' ? (metric.bucket ?? 'else') : '',
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
  'bucket',
] as const
export const DOUBLE_COLUMNS = [
  'status',
  'ttfb_ms',
  'total_ms',
  'bytes_served',
  'bytes_received',
  'cold',
] as const
