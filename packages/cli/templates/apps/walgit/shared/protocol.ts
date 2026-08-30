/**
 * The wire contract walgit's two halves speak.
 *
 * walgit is one service in two processes: a container running git behind
 * `src/`, and a Cloudflare Worker in front of it (`worker/`). They cannot share
 * a bundle — `@types/bun` and `@cloudflare/workers-types` are contradictory
 * ambient declarations, so each half gets its own tsconfig — but every fact in
 * this file is a fact BOTH halves have to agree on exactly: a header one sets
 * and the other reads, a path one strips and the other trusts, a grammar one
 * validates a name against and the other validates the same name against on a
 * different transport.
 *
 * Those facts used to be written twice, once on each side, with a comment
 * explaining that the copy was deliberate. Two of them had already drifted by
 * the time anyone looked (docs/adr/0010). What is actually true is narrower
 * than "the halves cannot share code": a module that imports NO runtime is
 * valid under both type systems, and `shared/` is exactly that category —
 * compiled by `tsconfig.json` and `tsconfig.worker.json` both, so "this is
 * runtime-neutral" is something the build fails on rather than a comment.
 *
 * The rule for this directory is one sentence: **`shared/` imports no runtime,
 * and both halves may import it.**
 */

// ── Headers ─────────────────────────────────────────────────────────────────

/**
 * Headers that make a response countable in front of the container.
 *
 * The Worker counts refusals BY KIND, and it cannot derive the kind from a
 * status code several refusals share. So whichever layer refuses names the kind
 * here, and every response the container produces carries the `served` stamp —
 * its absence is precisely what lets the Worker see that something in FRONT of
 * walgit refused a request walgit should have refused itself.
 */
export const SERVED_HEADER = 'x-walgit-served'
export const REJECT_HEADER = 'x-walgit-reject'

/** Header the container sets on the first response after it started. */
export const COLD_HEADER = 'x-walgit-cold'

/**
 * The header that marks a REQUEST as coming from the Worker's own handlers
 * rather than from the internet.
 *
 * Expiry DELETES repositories and the container is world-reachable by design,
 * so the endpoints that run it must not be. The Worker strips this header from
 * every request it proxies from a client and sets it only on the ones it
 * originates itself, which makes "the Worker asked" unforgeable from outside
 * without inventing a second credential for a service whose whole point is not
 * having one.
 */
export const INTERNAL_HEADER = 'x-walgit-internal'

/** Stripped before the response leaves the Worker — internal, not protocol. */
export const INTERNAL_HEADERS = [SERVED_HEADER, REJECT_HEADER, COLD_HEADER] as const

// ── Paths ───────────────────────────────────────────────────────────────────

/** Liveness. Unauthenticated: it reveals nothing but that the container is up. */
export const HEALTH_PATH = '/_walgit/health'

/** The sweeper's front door. `INTERNAL_HEADER` only — see above. */
export const EXPIRE_PATH = '/_walgit/expire'

/** One repository's ref state, for the event stream's handshake. Internal. */
export const REFS_PATH = '/_walgit/refs'

/**
 * One repository's push provenance: ref → the Signer that moved it, and when
 * (docs/adr/0011).
 *
 * Unlike `REFS_PATH` beside it, this one is for CLIENTS — an agent asking the
 * host who pushed — so it is gated by the ordinary read credential rather than
 * by `INTERNAL_HEADER`. Deliberately not on the ref-event stream: ADR-0009
 * froze that wire to "a ref moved, and to what", and provenance is separate
 * state with a different lifetime and a different reader.
 *
 * The repository is a query parameter rather than a path segment because
 * `SMART_HTTP` is the three git endpoints and no more; widening that grammar
 * to carry a fourth would change what the Worker counts as a clone.
 */
export const PROVENANCE_PATH = '/_walgit/provenance'

/** Where a subscriber connects. A WebSocket upgrade, and nothing else. */
export const EVENTS_PATH = '/_walgit/events'

/**
 * Where the container publishes a push it has already made durable.
 *
 * The container reaches the Worker over the public internet, so unlike the
 * expiry sweep this cannot ride on a stripped header — it carries a shared
 * secret instead (`WALGIT_EVENTS_TOKEN`).
 */
export const ANNOUNCE_PATH = '/_walgit/announce'

// ── Grammar ─────────────────────────────────────────────────────────────────

/**
 * The smart-HTTP protocol is three endpoints and no more.
 *
 * Everything else a bare repo exposes over HTTP is DUMB http — raw objects,
 * packs, HEAD — which would read the on-disk cache directly and bypass the WAL
 * the cache is derived from. Not routed, so not served.
 *
 * Group 1 is the repository; group 2 is the endpoint. The container routes on
 * the first and the Worker classifies on both, which is why there is one regex
 * and not one per reader: a path the Worker counts as a clone and the container
 * declines to route would be a metric describing traffic that never happened.
 */
export const SMART_HTTP = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/

/**
 * A repo id is one flat segment.
 *
 * Flat because the WAL keys repositories by id (docs/adr/0007), not by a
 * directory tree, and a hierarchy on disk that the log cannot express would
 * drift the moment a repo is rebuilt from the log. The same gate applies to a
 * name arriving in a URL path (`src/repo.ts`) and to one arriving over the
 * event socket (`shared/events.ts`) — both are attacker-controlled, and a name
 * one accepts and the other rejects is a repository half the service can see.
 */
export const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A ref name, as git writes it. Full name only: `main` is not a ref. */
export const REF_NAME = /^refs\/[A-Za-z0-9._\-/]+$/

/** The all-zeroes oid: creation when it is `oldOid`, deletion when `newOid`. */
export const ZERO_OID = '0'.repeat(40)

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * Every refusal walgit distinguishes. Aligned with the messages it emits.
 *
 * Counted by kind, never as an aggregate error rate, because the kinds mean
 * different things to whoever is reading:
 *
 *   - `size-cap`     a client pushing more than the instance allows — abuse, or
 *                    a misconfigured client
 *   - `collision`    a name already taken — a product signal about naming
 *   - `unauthorized` a bad or missing credential
 *   - `edge`         walgit did not refuse; something in front of it did. This
 *                    one is a BUG SIGNAL: every refusal walgit means to make it
 *                    should make itself, with an explanation. Absorbing it into
 *                    a general error count is how it would stay invisible.
 */
export type RejectKind =
  | 'size-cap'
  | 'collision'
  | 'unauthorized'
  | 'not-found'
  | 'unavailable'
  | 'edge'
  | 'other'

/**
 * The kinds the container itself can name in `REJECT_HEADER`.
 *
 * `edge` is excluded by construction — it means "something in front of walgit
 * refused", which the thing in front is the only one able to observe — and
 * `other` is the Worker's fallback for a kind it does not recognise, never a
 * kind anything sets deliberately. Stating the subset as a type is the point:
 * it used to be a second, shorter hand-maintained union in `src/http.ts`, and
 * nothing checked that the two lists stayed related.
 */
export type ContainerRejectKind = Exclude<RejectKind, 'edge' | 'other'>

/** An unrecognised kind becomes `other` rather than a new column nobody reads. */
const KINDS = new Set<RejectKind>([
  'size-cap',
  'collision',
  'unauthorized',
  'not-found',
  'unavailable',
  'edge',
  'other',
])

export function normalizeReject(value: string): RejectKind {
  const kind = value.trim().toLowerCase()
  return KINDS.has(kind as RejectKind) ? (kind as RejectKind) : 'other'
}
