/**
 * When the container stops, how it is sized, and which failed request may be
 * tried again — the decisions `WalgitDurableContainer` (worker/durable-container.ts)
 * makes about the container's lifetime, as pure functions.
 *
 * They used to be `@cloudflare/containers`' decisions, made inside its
 * `Container` class: a `sleepAfter` timer, an alarm loop that polled the
 * container every few minutes for as long as it ran, and a 500 the library
 * wrote itself when a request landed on a container that had just exited. That
 * class does not support the `durable_object` scheduling policy, so the
 * Durable Object now drives `ctx.container` directly and owns every one of
 * those rules. Here, rather than beside the runtime calls, for the reason
 * `container-env.ts` is: the ORDER of a lifecycle is only observable from
 * outside the object performing it, and a rule that can only be tested by
 * deploying is a rule nobody tests.
 */

/**
 * The instance size the container is started with.
 *
 * `standard-1` — ½ vCPU, 4 GiB, 8 GB of disk — and it is the smallest size
 * that fits, not a choice between two that do. The `default`-policy
 * application ran `basic` (¼ vCPU, 1 GiB, 4 GB), which the `durable_object`
 * policy does not accept at runtime, and Cloudflare's own mapping offers `lite`
 * or `standard-1` in its place. `lite` is 256 MiB: below the ~330 MiB a
 * compaction of a `WALGIT_MAX_REPO_BYTES`-sized repository peaks at even after
 * its extra pack copy is gone, and far below the ~583 MiB it peaks at with it
 * (the sizing note in wrangler.jsonc). A container killed for memory in the
 * middle of a compaction loses nothing — the lease and the CAS see to that —
 * but it does it again on the next push, forever. A custom size cannot go
 * between the two: custom instances start at 1 vCPU.
 *
 * The disk is the other half of the choice, and it matters more than it did.
 * With snapshots on, the Cache survives a sleep, so it grows to what the
 * deployment serves rather than to what one waking hour touched; 8 GB holds a
 * `SNAPSHOT_MAX_BYTES` restore with as much again free beside it.
 *
 * Changing it needs a new container, and nothing here forces one: the size is
 * read at the next start. Ship it with the deploy that changes it, and the
 * deploy's own `WALGIT_BUILD_ID` replaces the running container.
 */
export const CONTAINER_INSTANCE = 'standard-1'

/** src/server.ts's PORT default, and the Dockerfile's. */
export const CONTAINER_PORT = 8080

/**
 * The longest `start()` may take to produce a container answering on
 * `CONTAINER_PORT`. `start()` returns before the process is up, so readiness
 * is asked of the port itself. The library allowed 8 s to obtain a container
 * and 20 s more for its port; one budget covering both is the same allowance
 * without a second number to keep in step.
 */
export const READY_TIMEOUT_MS = 28_000

/** Between two readiness probes. The library's interval. */
export const READY_POLL_MS = 300

/** One readiness probe. The library's: a port that has not answered in 5 s is not up. */
export const READY_PROBE_TIMEOUT_MS = 5_000

/**
 * How long a SIGTERM'd container has to exit before it is killed.
 *
 * The idle stop only ever fires with nothing in flight (`idleVerdict`), and
 * src/server.ts drains and exits on SIGTERM, so in practice the process is gone
 * well inside this. It is a bound for the case where it is not — a detached
 * compaction holding the process up — and a compaction killed here loses
 * nothing: its lease expires and the next push re-triggers it.
 */
export const STOP_GRACE_MS = 15_000

/**
 * The ceiling `setInactivityTimeout` accepts. A longer timeout makes the
 * promise reject, which would surface as a start that failed for a reason
 * unrelated to starting.
 */
export const MAX_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000

/**
 * What the platform's own inactivity timeout is set to, given the idle stop.
 *
 * The two are not the same mechanism and must not race. The ALARM is the stop
 * walgit wants: it fires `sleepAfterMs` after the last request finished,
 * snapshots the disk and stops the container gracefully. The INACTIVITY TIMEOUT
 * is the platform's: without one, Cloudflare stops the container shortly after
 * the Durable Object goes idle — seconds, not minutes — so it is what lets the
 * object sleep while its container stays up. It runs from when the object
 * became inactive, which is at or after the last request, so `sleepAfterMs`
 * plus a margin lands after the alarm, every time.
 *
 * It is therefore a backstop and never the normal path: it stops the container
 * only if the alarm did not, and a container stopped that way leaves no
 * snapshot behind. That costs a cold start, never correctness.
 */
export function inactivityTimeoutMs(sleepAfterMs: number): number {
  const margin = 2 * 60 * 1000
  return Math.min(sleepAfterMs + margin, MAX_INACTIVITY_TIMEOUT_MS)
}

/** What the idle alarm decided. */
export type IdleVerdict = { stop: true } | { stop: false; at: number }

/**
 * Has the container been idle for `sleepAfterMs`?
 *
 * Idle means NOTHING IN FLIGHT, and that is the rule the old timer broke in
 * spirit if not in letter: a clone of a large repository is one request that
 * streams for minutes, a push is one request whose body uploads for as long,
 * and neither may be cut off because the request that STARTED it is older than
 * the window. So any request in flight postpones the verdict by a whole window,
 * and the window is measured from when the last request FINISHED.
 *
 * `lastActivity` is null when the object has no memory of a request — it was
 * evicted and reconstructed by the alarm itself. An evicted object had nothing
 * in flight (a request in flight keeps it resident), and the alarm that woke it
 * was armed for `sleepAfterMs` after its last request, so it is due.
 */
export function idleVerdict(state: {
  now: number
  inflight: number
  lastActivity: number | null
  sleepAfterMs: number
}): IdleVerdict {
  const { now, inflight, lastActivity, sleepAfterMs } = state
  if (inflight > 0) return { stop: false, at: now + sleepAfterMs }
  if (lastActivity === null) return { stop: true }
  const due = lastActivity + sleepAfterMs
  return due <= now ? { stop: true } : { stop: false, at: due }
}

/**
 * Where the alarm should be after a request finishes — or `null` to leave it.
 *
 * Every finished request moves the deadline, and `setAlarm` is a storage write,
 * so moving it on every request would put a write on the end of every clone.
 * Instead an alarm already armed within `slack` of the new deadline is left
 * where it is: when it fires early, `idleVerdict` reads the newer
 * `lastActivity` and re-arms for the true deadline. The only cost of the slack
 * is the one case where that memory is gone — an object evicted between the
 * request and its alarm stops the container up to `slack` early, which is a
 * tenth of the window and never more than half a minute.
 *
 * `scheduled` is what this object last armed, or null when it does not know
 * (it was constructed since). Not knowing re-arms, which is always correct.
 */
export function rearmAt(state: {
  now: number
  scheduled: number | null
  sleepAfterMs: number
}): number | null {
  const { now, scheduled, sleepAfterMs } = state
  const deadline = now + sleepAfterMs
  const slack = Math.min(sleepAfterMs / 10, 30_000)
  if (scheduled !== null && scheduled >= deadline - slack) return null
  return deadline
}

/**
 * May a request that failed to reach the container be sent again?
 *
 * Once, after a beat, and only a bodiless read. The failure this exists for is
 * the gap between a container exiting — the platform's backstop stop, a crash,
 * a host going away — and the object noticing: the proxy's connection fails
 * where the container was, and a second attempt starts a fresh one. Under the
 * `Container` class that gap surfaced as a 500 the library wrote itself, and
 * the same rule retried it (8a6c4fe); here it surfaces as the proxy's own
 * thrown error, and the rule is unchanged.
 *
 * A push is never retried: its body has been consumed by the first attempt, and
 * a pack is not something to replay on a guess. `HEAD` and `GET` carry none.
 */
export function mayRetry(method: string, attempt: number): boolean {
  return attempt === 0 && (method === 'GET' || method === 'HEAD')
}

/** How long to wait before that one retry. */
export const RETRY_DELAY_MS = 500
