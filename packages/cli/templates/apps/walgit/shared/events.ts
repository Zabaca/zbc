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
 * Everything decidable lives here, pure: whether a credential is good, what a
 * `watch` message means, and which sockets an announcement reaches.
 * `worker/events-do.ts` is the shell that owns the sockets and makes none of
 * those decisions — which is why this file lives in `shared/` and is tested
 * from `src/` with the rest of the suite rather than behind a Workers runtime.
 * The paths, the grammars and the zero oid are `shared/protocol.ts`'s, because
 * the socket is not the only transport that validates a repository name.
 */

import { authorizedBy } from './credentials'
import { REF_NAME, REPO_ID, ZERO_OID } from './protocol'

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
 * How many watch entries and refs one message may carry.
 *
 * A cap rather than an unbounded list because one connection asking to watch
 * every repository on the host is the operator's problem, not the client's: the
 * handshake alone reads the Index once per repository named. Exported so the
 * refusal, the tests and any future advertisement of the limit all read the
 * same number.
 *
 * There is deliberately no wildcard beside these — no `repo: "*"`, no
 * `watch: "all"`. On a public deployment that would be a firehose of strangers'
 * pushes, and `REPO_ID` rejects `*` for the same reason a URL path does.
 */
export const MAX_WATCH_ENTRIES = 64
export const MAX_REFS_PER_ENTRY = 256

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
  /**
   * What this subscriber asked to watch, when it has asked yet.
   *
   * It has not at the upgrade — a `watch` message arrives on the socket after
   * it is open — so the deployment credential is the whole question there, and
   * the repositories are judged on the message that names them.
   */
  watch?: readonly WatchEntry[]
  /**
   * Per-repository read verdicts for the key this subscriber PROVED
   * (docs/adr/0013), from the container, which is the only half that can
   * verify a signature.
   *
   * Absent means this deployment gates no reads — every deployment until an
   * operator sets `WALGIT_PRIVATE_REPOS` — and the watch is judged exactly as
   * it always was. Present means every named repository must be answered
   * `true`: a verdict that did not arrive is not a verdict of yes.
   */
  readable?: Readonly<Record<string, boolean>>
}): boolean {
  if (!input.isPublic && !authorizedBy(input.authorization, input.tokens)) return false
  if (!input.watch || !input.readable) return true
  // Whole, never narrowed. A subscriber silently stripped of one repository
  // waits forever on a stream it believes it is on, which is the worse failure
  // — and the refusal is the same `unauthorized` a clone of it would get.
  const readable = input.readable
  return watchedRepos(input.watch).every((repo) => readable[repo] === true)
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
  return secret !== '' && authorizedBy(authorization, [secret])
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
    // Both numbers, because a client over the cap has to know how far over it
    // is to split its subscription — a bare limit makes it guess.
    return {
      ok: false,
      error: `at most ${MAX_WATCH_ENTRIES} watch entries, asked for ${watch.length}`,
    }
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
        error: `at most ${MAX_REFS_PER_ENTRY} refs per repository, asked for ${refs.length} on ${repo}`,
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

/**
 * One push, as the push path publishes it.
 *
 * `readersChanged` is the revocation signal (docs/adr/0013): the repositories
 * whose `refs/walgit/signers` this push moved, and therefore whose Reader List
 * may no longer name a key that is reading right now. It rides the
 * announcement rather than a second endpoint because it is the same event —
 * that ref moved — read for a second purpose, and because the Fan-out is the
 * only thing that can act on it.
 *
 * It is INTERNAL to the announce wire. Nothing derived from it appears in a
 * subscriber's handshake or in an event; what a revoked subscriber sees is its
 * socket closing, which ADR-0009's frozen wire already allows.
 */
export interface Announcement {
  events: RefEvent[]
  readersChanged: string[]
}

/** The announcement the push path publishes, validated at the door. */
export function parseAnnounce(body: unknown): Parsed<Announcement> {
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: 'body is not an object' }
  const events = (body as { events?: unknown }).events
  if (!Array.isArray(events)) return { ok: false, error: 'expected an "events" array' }
  const changed = (body as { readersChanged?: unknown }).readersChanged ?? []
  if (!Array.isArray(changed)) return { ok: false, error: '"readersChanged" is not an array' }
  for (const repo of changed) {
    // The same grammar the events go through, and for the same reason: a name
    // this door accepts and the rest of walgit refuses is a repository half
    // the service can see.
    if (typeof repo !== 'string' || !REPO_ID.test(repo)) {
      return {
        ok: false,
        error: `invalid repository name in "readersChanged": ${JSON.stringify(repo ?? null)}`,
      }
    }
  }

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
  return { ok: true, value: { events: parsed, readersChanged: [...(changed as string[])] } }
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
  // `oldOid` is accepted and ignored: callers hand this whole `RefChange`s
  // straight from the push path, and a parameter narrower than what they hold
  // would make every call site build a second object to drop one field.
  changes: readonly { ref: string; oldOid?: string; newOid: string }[],
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
