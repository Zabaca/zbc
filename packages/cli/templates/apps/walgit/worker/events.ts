/**
 * The ref-event wire, and every decision it needs.
 *
 * A client that wants to know when a ref moves has no endpoint of its own — it
 * runs in a sandbox with no ingress — so the connection is outbound and stays
 * open, and walgit talks down it. That is the whole feature: one WebSocket, a
 * list of what you care about, and the current sha of each, followed by the new
 * sha every time one of them moves.
 *
 * Events are LATEST STATE, not a log. There is no cursor, no `since` and no
 * sequence number anywhere in this file, deliberately: a subscriber that
 * reconnects gets the current state in its handshake, which is the only answer
 * a client acting on "is my main current?" can use. Replay would be a second
 * source of truth beside `index.json`, and the Index already is one.
 *
 * Everything decidable lives here, pure: which paths exist, whether a
 * credential is good, what a `watch` message means, and which sockets an
 * announcement reaches. `worker/events-do.ts` is the shell that owns the
 * sockets and makes none of those decisions — the arrangement `landing.ts` and
 * `telemetry.ts` already use, and the reason this is tested from `src/` with
 * the rest of the suite rather than behind a Workers runtime.
 */

/** Where a subscriber connects. A WebSocket upgrade, and nothing else. */
export const EVENTS_PATH = '/_walgit/events'

/**
 * Where the container publishes a push it has already made durable.
 *
 * The container is a separate process that reaches the Worker over the public
 * internet, so unlike the expiry sweep this cannot ride on a stripped header —
 * it carries a shared secret instead (`WALGIT_EVENTS_TOKEN`).
 */
export const ANNOUNCE_PATH = '/_walgit/announce'

/** One repository, and optionally the refs within it that matter. */
export interface WatchEntry {
  repo: string
  /** Omitted means every ref in that repository. */
  refs?: string[]
}

/** A ref at a moment. `sha: null` is a deletion — the ref is gone. */
export interface RefEvent {
  repo: string
  ref: string
  sha: string | null
}

/** The answer to a `watch`: current state, before any event can fire. */
export interface Handshake {
  ok: true
  refs: RefEvent[]
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * The same repo-id gate `src/repo.ts` applies to a URL path.
 *
 * Duplicated rather than imported because this half runs in the Worker, which
 * does not bundle `src/` — and a repo name arriving over a socket is
 * attacker-controlled in exactly the way one arriving in a path is. The tests
 * assert the two agree.
 */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A ref name, as git writes it. Full name only: `main` is not a ref. */
const REF_NAME = /^refs\/[A-Za-z0-9._\-/]+$/

/** The all-zeroes oid git reports for a creation or a deletion. */
export const ZERO_OID = '0'.repeat(40)

/** How many watch entries and refs one message may carry. */
const MAX_WATCH_ENTRIES = 64
const MAX_REFS_PER_ENTRY = 256

/**
 * Is the stream configured at all?
 *
 * Off unless a deployment says otherwise: without the announce secret there is
 * nothing that could publish an event, so the endpoints do not exist rather
 * than existing and never firing. A subscriber then gets the same 404 as any
 * other unrouted path, which is the honest answer.
 */
export function eventsEnabled(announceToken: string | undefined): boolean {
  return typeof announceToken === 'string' && announceToken.trim() !== ''
}

/** The credential list, read exactly as `src/server.ts` reads it. */
export function parseTokens(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

/**
 * May this request watch?
 *
 * Exactly the credential a read needs, and for the same reason: an event says
 * that a ref moved and what it moved to, which is a strict subset of what a
 * fetch of that repository hands over. A public deployment therefore has a
 * public stream — anything else would be a lock on the announcement of data
 * anyone may already clone.
 */
export function authorizeSubscribe(input: {
  authorization: string | null
  tokens: string[]
  isPublic: boolean
}): boolean {
  if (input.isPublic) return true
  const presented = presentedCredential(input.authorization ?? '')
  if (!presented) return false
  return input.tokens.some((token) => constantTimeEquals(token, presented))
}

/**
 * May this caller announce?
 *
 * A separate secret from the read tokens, because the two answer different
 * questions: a read token says "you may see this repository", and this says
 * "you are walgit's own push path". Handing a subscriber the power to fabricate
 * events for a repository it can read would make the stream unusable as a
 * trigger for anything.
 */
export function authorizeAnnounce(authorization: string | null, secret: string): boolean {
  const presented = presentedCredential(authorization ?? '')
  return presented !== null && secret !== '' && constantTimeEquals(secret, presented)
}

/**
 * What a client asked to watch.
 *
 * Rejected with a reason rather than ignored: a subscriber whose message was
 * dropped silently waits forever for events about a repository it never
 * successfully named, and looks — from the client side — exactly like a
 * repository nobody is pushing to.
 */
export function parseWatch(raw: string): Parsed<WatchEntry[]> {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'message is not JSON' }
  }
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: 'message is not an object' }

  const watch = (body as { watch?: unknown }).watch
  if (!Array.isArray(watch)) return { ok: false, error: 'expected a "watch" array' }
  if (watch.length === 0) return { ok: false, error: '"watch" is empty' }
  if (watch.length > MAX_WATCH_ENTRIES) {
    return { ok: false, error: `at most ${MAX_WATCH_ENTRIES} watch entries` }
  }

  const entries: WatchEntry[] = []
  for (const item of watch) {
    if (typeof item !== 'object' || item === null)
      return { ok: false, error: 'watch entry is not an object' }
    const { repo, refs } = item as { repo?: unknown; refs?: unknown }
    if (typeof repo !== 'string' || !REPO_ID.test(repo)) {
      return {
        ok: false,
        error: `invalid repository name: ${JSON.stringify(repo ?? null)}`,
      }
    }
    if (refs === undefined) {
      entries.push({ repo })
      continue
    }
    if (!Array.isArray(refs)) return { ok: false, error: `"refs" for ${repo} is not an array` }
    if (refs.length > MAX_REFS_PER_ENTRY) {
      return {
        ok: false,
        error: `at most ${MAX_REFS_PER_ENTRY} refs per repository`,
      }
    }
    for (const ref of refs) {
      if (typeof ref !== 'string' || !REF_NAME.test(ref)) {
        return {
          ok: false,
          error: `invalid ref: ${JSON.stringify(ref ?? null)}`,
        }
      }
    }
    entries.push({ repo, refs: [...(refs as string[])] })
  }
  return { ok: true, value: entries }
}

/** The announcement the push path publishes, validated at the door. */
export function parseAnnounce(body: unknown): Parsed<RefEvent[]> {
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: 'body is not an object' }
  const events = (body as { events?: unknown }).events
  if (!Array.isArray(events)) return { ok: false, error: 'expected an "events" array' }

  const parsed: RefEvent[] = []
  for (const item of events) {
    if (typeof item !== 'object' || item === null)
      return { ok: false, error: 'event is not an object' }
    const { repo, ref, sha } = item as {
      repo?: unknown
      ref?: unknown
      sha?: unknown
    }
    if (typeof repo !== 'string' || !REPO_ID.test(repo)) {
      return {
        ok: false,
        error: `invalid repository name: ${JSON.stringify(repo ?? null)}`,
      }
    }
    if (typeof ref !== 'string' || !REF_NAME.test(ref)) {
      return {
        ok: false,
        error: `invalid ref: ${JSON.stringify(ref ?? null)}`,
      }
    }
    if (sha !== null && (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha))) {
      return { ok: false, error: `invalid sha for ${ref}` }
    }
    parsed.push({ repo, ref, sha })
  }
  return { ok: true, value: parsed }
}

/**
 * Does this subscription cover this ref?
 *
 * An entry with no `refs` covers the whole repository. That is not a
 * convenience: an agent watching a repository it did not create does not know
 * which branches exist, and enumerating them to subscribe would be the fetch
 * this feature exists to avoid.
 */
export function watchCovers(
  watch: readonly WatchEntry[],
  event: { repo: string; ref: string },
): boolean {
  return watch.some(
    (entry) =>
      entry.repo === event.repo && (entry.refs === undefined || entry.refs.includes(event.ref)),
  )
}

/** Every repository a subscription names — what the handshake has to look up. */
export function watchedRepos(watch: readonly WatchEntry[]): string[] {
  return [...new Set(watch.map((entry) => entry.repo))]
}

/**
 * The handshake: current state for everything watched.
 *
 * Connect and catch-up are one operation on purpose. A subscriber that had to
 * fetch first to learn where it stands would pay exactly the cost this feature
 * removes, and would have a window between the fetch and the subscription in
 * which a push is missed by both.
 *
 * A watched ref that does not exist is reported as `sha: null` only when the
 * client named it explicitly — the client asked about that ref, so "it is not
 * there" is an answer. A whole-repository watch lists what exists and invents
 * nothing.
 */
export function handshake(
  watch: readonly WatchEntry[],
  refsByRepo: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Handshake {
  const refs: RefEvent[] = []
  for (const entry of watch) {
    const known = refsByRepo[entry.repo] ?? {}
    if (entry.refs === undefined) {
      for (const ref of Object.keys(known).sort())
        refs.push({ repo: entry.repo, ref, sha: known[ref]! })
      continue
    }
    for (const ref of entry.refs) refs.push({ repo: entry.repo, ref, sha: known[ref] ?? null })
  }
  return { ok: true, refs }
}

/**
 * The events a ref transaction publishes.
 *
 * git reports a deletion as an all-zeroes new oid; the wire says `null`,
 * because a client comparing shas should never have to know that the zero oid
 * is not a commit.
 */
export function eventsFromChanges(
  repo: string,
  changes: readonly { ref: string; newOid: string }[],
): RefEvent[] {
  return changes
    .filter((change) => REF_NAME.test(change.ref))
    .map((change) => ({
      repo,
      ref: change.ref,
      sha: change.newOid === ZERO_OID ? null : change.newOid,
    }))
}

/** One message on the wire. Serialized in one place so its shape is one thing. */
export function encode(message: Handshake | RefEvent | { error: string }): string {
  return JSON.stringify(message)
}

/** `Bearer <token>`, or git's `Basic <user>:<token>` — the same two forms a read accepts. */
function presentedCredential(header: string): string | null {
  const bearer = /^Bearer (.+)$/i.exec(header)
  if (bearer) return bearer[1]!
  const basic = /^Basic (.+)$/i.exec(header)
  if (basic) {
    // Undecodable base64 is a malformed credential, not a crash: `atob` throws
    // on one, and a header a stranger controls must not be able to do that.
    let decoded: string
    try {
      decoded = atob(basic[1]!)
    } catch {
      return null
    }
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
