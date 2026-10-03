/**
 * The Durable Object that owns walgit's container, driving `ctx.container`
 * directly under the `durable_object` scheduling policy.
 *
 * It replaces `WalgitContainer` (worker/index.ts), which extends
 * `@cloudflare/containers`' `Container` class. That class cannot run under this
 * policy and is maintained only through 2026-12-31, and the policy is worth
 * moving for on its own: a container starts in well under a second rather than
 * four, and its root filesystem can be snapshotted — so a wake no longer has to
 * rebuild every repository it serves from the log onto an empty disk. On
 * agentgit a cold start cost 12–22 s, and most of it was that rebuild.
 *
 * A NEW CLASS, not the old one with a new base. A container application's
 * scheduling policy is fixed when it is created, one Durable Object namespace
 * attaches to one application, and changing `scheduling_policy` in place fails
 * the deploy AFTER the new Worker is live. So this is a new namespace with its
 * own application, bound as `WALGIT_DURABLE_CONTAINER` and routed to only once
 * `WALGIT_CONTAINER_POLICY` says so (worker/container-binding.ts says why that
 * takes two deploys). The old class stays exported until its application is
 * deleted (README.md, "Deployment", phase 3).
 *
 * Everything the library used to decide is decided here, and each rule is in
 * shared/ where it can be tested without a runtime:
 *
 *   - START: from the last snapshot when it is for this image and this log,
 *     from the image otherwise (shared/container-snapshot.ts), with the
 *     forwarded environment (shared/container-env.ts) at `CONTAINER_INSTANCE`.
 *     `start()` returns before the process listens, so readiness is asked of
 *     the port. A restore that does not come up falls back to a fresh start.
 *   - REPLACE: the environment AND the image a container was booted from are
 *     fingerprinted, and a running container is destroyed the first time this
 *     deploy would boot it differently. The policy has no rollouts, so this is
 *     now the whole of how a new image reaches a running container.
 *   - PROXY: HTTP and WebSocket to port 8080, a bodiless read retried once when
 *     it lands on a container that just exited, and the first response after a
 *     real start stamped cold for the Worker's telemetry.
 *   - STOP: an alarm `WALGIT_SLEEP_AFTER` after the last request FINISHED —
 *     never while one is in flight — that snapshots the disk, SIGTERMs the
 *     process (src/server.ts drains and exits) and kills it if it lingers.
 *
 * What it no longer does is keep itself awake. The library's alarm loop
 * re-armed every few minutes for as long as the container ran, polling it; this
 * object sleeps between requests, wakes once to stop the container, and with
 * the container stopped holds no alarm, no timer and no pending promise.
 */

import { DurableObject } from 'cloudflare:workers'

import {
  bootFingerprint,
  containerEnv,
  reconcileContainerEnv,
  type ContainerEnvName,
} from '../shared/container-env'
import {
  CONTAINER_INSTANCE,
  CONTAINER_PORT,
  READY_POLL_MS,
  READY_PROBE_TIMEOUT_MS,
  INFLIGHT_MAX_MS,
  READY_TIMEOUT_MS,
  RETRY_DELAY_MS,
  STOP_GRACE_MS,
  freshStartTimeoutMs,
  idleVerdict,
  inactivityTimeoutMs,
  mayRetry,
  rearmAt,
} from '../shared/container-lifecycle'
import {
  type SnapshotRecord,
  recordSnapshot,
  refreshSnapshot,
  restorePlan,
  shouldSnapshot,
  needsNewSnapshot,
  DISK_CHANGED_COMMAND,
  snapshotsEnabled,
  storeIdentity,
} from '../shared/container-snapshot'
import { COLD_HEADER, HEALTH_PATH } from '../shared/protocol'
import { sleepAfterMsFrom } from '../shared/sleep-after'

/** Only what this object reads — the Worker's `Env` is a superset. */
export interface ContainerHostEnv extends Partial<Record<ContainerEnvName, string>> {
  /** How long the container idles before it stops (`shared/sleep-after.ts`). */
  WALGIT_SLEEP_AFTER?: string
  /** `1` to snapshot on the idle stop and restore on the next start. Edge-only. */
  WALGIT_SNAPSHOTS?: string
}

/**
 * The key under `containers[].images` in wrangler.jsonc. Wrangler builds the
 * Dockerfile it names and hands this object the digest-pinned reference as
 * `ctx.container.images.walgit` — which changes exactly when the image does.
 */
export const IMAGE_NAME = 'walgit'

/**
 * The one object every request is routed to. `@cloudflare/containers`'
 * `getContainer` default, kept: one container serves every repository, for
 * cache locality rather than correctness (worker/index.ts says why), and this
 * is the name that makes it one.
 */
export const CONTAINER_OBJECT_NAME = 'cf-singleton-container'

/** The stub for that one object. What every caller of the binding uses. */
export function containerHost(
  namespace: DurableObjectNamespace<WalgitDurableContainer>,
): DurableObjectStub<WalgitDurableContainer> {
  return namespace.get(namespace.idFromName(CONTAINER_OBJECT_NAME))
}

/** Where `reconcileEnv` remembers what the container was booted from. */
const ENV_FINGERPRINT_KEY = 'container-env-fingerprint'
/** The one snapshot this object knows about (`SnapshotRecord`). */
const SNAPSHOT_KEY = 'container-snapshot'
/**
 * The image the running container booted from. In storage rather than memory
 * because the object sleeps while its container runs, and the stop that reads
 * this is an alarm that wakes a fresh instance. `inspect()` cannot answer it:
 * it reports an empty image for a container restored from a snapshot.
 */
const BOOTED_IMAGE_KEY = 'container-booted-image'
/** How the running container started (`StartSource`), for `needsNewSnapshot`. */
const BOOTED_FROM_KEY = 'container-booted-from'

const SIGTERM = 15

/**
 * The detached compaction a push can leave running (src/hook-main.ts spawns
 * it), as `pgrep -f` finds it inside the container.
 */
const COMPACTION_PROCESS = 'compact-main'

/** How the running container came to be, for the cold stamp and the logs. */
type StartSource = 'snapshot' | 'image'

export class WalgitDurableContainer extends DurableObject<ContainerHostEnv> {
  /**
   * The forwarded environment, read once per object: a deploy constructs a new
   * one, so this is never staler than the Worker in front of it.
   */
  private readonly envVars = containerEnv(this.env)
  private readonly sleepAfterMs = sleepAfterMsFrom(this.env)
  private readonly snapshots = snapshotsEnabled(this.env)

  /**
   * Did THIS object start the container, and from what? Read and cleared by
   * the next response, which is stamped cold. Null until a start: an object
   * reconstructed in front of a container that was already running started
   * nothing, and stamping its first response cold once counted ~10 phantom
   * cold starts a day.
   */
  private freshStart: StartSource | null = null

  /** Single-flight, so concurrent requests await one check rather than racing. */
  private reconciled: Promise<void> | null = null
  /** Single-flight, so concurrent requests never call `start()` twice. */
  private starting: Promise<void> | null = null
  /** A stop under way; a request that arrives during one waits it out. */
  private stopping: Promise<void> | null = null

  /** Requests between arriving here and their last byte leaving. */
  private inflight = 0
  /** When the last of them finished, if this object has seen one. */
  private lastActivity: number | null = null
  /** What this object last armed the alarm for, if it knows. */
  private alarmAt: number | null = null
  /**
   * The running container's exit, from ONE `monitor()` per start. A pending
   * `monitor()` keeps this object from being evicted for up to 15 minutes, so
   * it is asked for only when an exit is actually being waited on — a start
   * that stopped before it was ready, or a stop — and then shared, rather than
   * asked again on every readiness probe and left pending each time.
   */
  private exit: Promise<string> | null = null

  constructor(ctx: DurableObjectState, env: ContainerHostEnv) {
    super(ctx, env)
    // The platform's inactivity timeout belongs to an object INSTANCE, not to
    // the container: an instance constructed in front of a running container
    // (a deploy, an eviction) starts without one, and without one Cloudflare
    // stops the container shortly after this object next goes idle — before
    // the alarm can snapshot it. So it is set again here, as the docs require.
    const container = ctx.container
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container
          .setInactivityTimeout(inactivityTimeoutMs(this.sleepAfterMs))
          .catch((error: unknown) =>
            console.error(`walgit container: inactivity timeout not set: ${messageOf(error)}`),
          ),
      )
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Before anything is proxied, so a request never reaches a container whose
    // environment or image this deploy already superseded. Memoized: the
    // storage read happens once per object lifetime, not per request.
    //
    // Started only with NOTHING in flight. The first one always is — every
    // request awaits it before it is counted — but a reconcile that failed is
    // cleared to be retried, and by then other requests may be streaming a
    // clone or uploading a push from the very container a retry would destroy.
    // So the retry waits for a request that arrives to an idle object; until
    // then requests are served by the container already running, which is the
    // state the failed reconcile left anyway.
    if (!this.reconciled && this.inflight === 0) {
      this.reconciled = this.reconcileEnv().catch((error) => {
        // Cleared so a later request retries. Never rethrown: a container
        // serving a stale limit is a worse day than an outage only if it is
        // ALSO the reason git stopped working, and it should not be.
        this.reconciled = null
        console.error(`walgit container env reconcile failed: ${messageOf(error)}`)
      })
    }
    if (this.reconciled) await this.reconciled

    // Counted from here, before the start, so an alarm that fires while this
    // request waits for a container sees it and does not stop that container.
    // Released when the response is over — or after `INFLIGHT_MAX_MS`, so a
    // caller that never reads the body cannot pin the container up for good.
    this.inflight += 1
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(cap)
      this.finished()
    }
    const cap = setTimeout(() => {
      if (settled) return
      const path = new URL(request.url).pathname
      console.warn(`walgit container: ${path} open ${INFLIGHT_MAX_MS} ms; no longer in flight`)
      settle()
    }, INFLIGHT_MAX_MS)

    try {
      await this.ensureRunning()
    } catch (error) {
      settle()
      // No `SERVED_HEADER`, so the Worker counts it as the edge refusal it is.
      return new Response(`Failed to start container: ${messageOf(error)}`, { status: 500 })
    }

    let response: Response
    try {
      response = await this.forward(request)
    } catch (error) {
      settle()
      console.error(`walgit container: proxy failed: ${messageOf(error)}`)
      return new Response(`Error proxying request to container: ${messageOf(error)}`, {
        status: 500,
      })
    }

    if (response.webSocket) response = this.proxySocket(response, settle)
    else if (response.body) response = this.trackBody(response, settle)
    else settle()

    // Read AFTER the forward: the start happens inside it, so a flag read
    // before was still null for the request that woke the container and
    // stamped the next one cold instead.
    const cold = this.freshStart
    this.freshStart = null
    if (!cold) return response
    // Rebuilt rather than mutated (Response headers are immutable), passing the
    // body by reference so a clone is not buffered to add one header. The value
    // says which kind of cold; the Worker reads only its presence.
    const stamped = new Response(response.body, response)
    stamped.headers.set(COLD_HEADER, cold)
    return stamped
  }

  /**
   * The idle stop, and nothing else: this alarm is armed only while a
   * container runs, and a fire that finds none returns without re-arming —
   * which is what lets the object sleep with its container stopped.
   */
  async alarm(): Promise<void> {
    this.alarmAt = null
    if (!this.ctx.container?.running) return
    const verdict = idleVerdict({
      now: Date.now(),
      inflight: this.inflight,
      lastActivity: this.lastActivity,
      sleepAfterMs: this.sleepAfterMs,
    })
    if (!verdict.stop) {
      await this.arm(verdict.at)
      return
    }
    try {
      await this.stopContainer()
    } catch (error) {
      // Not rethrown: a rethrown alarm is retried on the platform's backoff,
      // which is the wrong schedule for "try the stop again". Re-armed for a
      // minute instead, and the inactivity timeout is the backstop under both.
      console.error(`walgit container: idle stop failed: ${messageOf(error)}`)
      if (this.ctx.container?.running) await this.arm(Date.now() + 60_000)
    }
  }

  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error('no container is configured for this Durable Object')
    return container
  }

  /** The image this Worker version would start, digest-pinned. */
  private image(): string {
    const image = this.container.images[IMAGE_NAME]
    if (!image) {
      throw new Error(
        `no container image named "${IMAGE_NAME}" (wrangler.jsonc containers[].images)`,
      )
    }
    return image
  }

  /**
   * Bind this object to `reconcileContainerEnv`'s rules.
   *
   * The decision — and the two orderings that matter, no-record-is-a-mismatch
   * and record-only-after-a-successful-destroy — lives in
   * `shared/container-env.ts`, where it can be tested without a Workers
   * runtime. What is left here is reaching the container, reaching storage,
   * and logging.
   */
  private async reconcileEnv(): Promise<void> {
    const current = bootFingerprint(this.envVars, this.image())
    let booted: string | undefined
    // Captured so the port's getter below reads this object's state rather
    // than the object literal's.
    const state = this.ctx

    const outcome = await reconcileContainerEnv(
      {
        get running() {
          return state.container?.running ?? false
        },
        read: async () => {
          booted = await state.storage.get<string>(ENV_FINGERPRINT_KEY)
          return booted
        },
        // Killed rather than stopped gracefully, and not snapshotted on the
        // way: this runs before the first request of a new object is proxied,
        // so nothing of this object's is in flight, and the container holds
        // nothing worth draining — every durable effect of a push is in the log
        // before it is acknowledged (docs/adr/0007). The snapshot the last idle
        // stop took is still on record and still restorable when the image is
        // unchanged, so the replacement starts from it and re-syncs.
        destroy: () => this.container.destroy(),
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

  /** A running container, started if there was none. Waits out a stop first. */
  private async ensureRunning(): Promise<void> {
    // A failed stop is the alarm's to report; here it only has to be over.
    while (this.stopping) await this.stopping.catch(() => undefined)
    if (this.starting) return this.starting
    if (this.container.running) return
    const starting = this.boot().finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  /** Start a container — from the snapshot when it qualifies, else from the image. */
  private async boot(): Promise<void> {
    const image = this.image()
    const store = storeIdentity(this.env)
    const record = (await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY)) ?? null
    const plan = restorePlan({ enabled: this.snapshots, record, image, store, now: Date.now() })

    const begun = Date.now()
    if (plan.from === 'snapshot' && record) {
      const failure = await this.startFrom({ snapshotId: plan.id }, READY_TIMEOUT_MS)
      if (failure === null) {
        await this.ctx.storage.put<string | SnapshotRecord>({
          [SNAPSHOT_KEY]: refreshSnapshot(record, Date.now()),
          [BOOTED_IMAGE_KEY]: image,
          [BOOTED_FROM_KEY]: 'snapshot',
        })
        this.started('snapshot')
        return
      }
      // A snapshot that does not come up is not tried twice: forgotten, so the
      // next start goes straight to the image, and the next idle stop records
      // a new one.
      console.error(`walgit container: restore of snapshot ${plan.id} failed (${failure})`)
      await this.ctx.storage.delete(SNAPSHOT_KEY)
    } else if (plan.from === 'image' && record && plan.reason !== 'disabled') {
      console.log(`walgit container: snapshot ${record.id} not restored (${plan.reason})`)
    }

    // ONE fresh start per request, inside what is left of `BOOT_BUDGET_MS`.
    // A failure fails this request (and every request waiting on the same
    // start) in seconds, and the next request makes the next attempt — which
    // is also the retry the docs ask for after a stop, without making any one
    // client wait through several.
    const failure = await this.startFrom({ image }, freshStartTimeoutMs(Date.now() - begun))
    if (failure !== null) {
      console.error(`walgit container: start failed (${failure})`)
      throw new Error(failure)
    }
    await this.ctx.storage.put({ [BOOTED_IMAGE_KEY]: image, [BOOTED_FROM_KEY]: 'image' })
    this.started('image')
  }

  /** A start succeeded: stamp the next response, and make sure a stop is armed. */
  private started(source: StartSource): void {
    this.freshStart = source
    console.log(`walgit container: started from ${source} (${CONTAINER_INSTANCE})`)
    // Armed here as well as when a request finishes, so a container never runs
    // without an alarm that will stop it — even when the request that started
    // it never finishes because this object was reset.
    void this.arm(Date.now() + this.sleepAfterMs)
  }

  /**
   * One `start()` and the wait for its port. Null when the container is up;
   * otherwise why not, with the container no longer running.
   */
  private async startFrom(
    source: { image: string } | { snapshotId: string },
    timeoutMs: number,
  ): Promise<string | null> {
    const container = this.container
    const common = {
      env: this.envVars,
      // The push path writes to object storage and announces to the Worker's
      // public origin, both over the Internet. The `Container` class allowed it
      // by default; this API asks.
      enableInternet: true,
      instance: CONTAINER_INSTANCE,
    } as const
    try {
      if ('image' in source) container.start({ ...common, image: source.image })
      else container.start({ ...common, containerSnapshot: { id: source.snapshotId } })
    } catch (error) {
      return `start refused: ${messageOf(error)}`
    }
    // A new container, so a new exit to wait on — never the last one's.
    this.exit = null
    try {
      await container.setInactivityTimeout(inactivityTimeoutMs(this.sleepAfterMs))
    } catch (error) {
      // Not fatal: the container runs, and only the backstop is missing — it
      // will be stopped when this object idles rather than by the alarm.
      console.error(`walgit container: inactivity timeout not set: ${messageOf(error)}`)
    }
    return this.waitReady(timeoutMs)
  }

  /**
   * Wait for the process to answer on its port.
   *
   * Asked of `HEALTH_PATH`, the one route src/http.ts answers before any
   * credential, policy or repository is looked at — so the probe costs nothing
   * on the container and is never counted as a request for `/`. Any answer is
   * ready. A probe that fails while the container is still running is a
   * process still booting; one that fails after it stopped is a container that
   * will not come up, and `monitor()` — which settles for a container that
   * already stopped — says why.
   */
  private async waitReady(timeoutMs: number): Promise<string | null> {
    const container = this.container
    const port = container.getTcpPort(CONTAINER_PORT)
    const deadline = Date.now() + timeoutMs
    let last = 'no answer'
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch(`http://container${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS),
        })
        await res.body?.cancel()
        return null
      } catch (error) {
        last = messageOf(error)
      }
      if (!container.running) {
        const why = await settledWithin(this.exitOf(container), 1_000)
        // Not yet settled is a container still being placed, not a dead one.
        if (why !== undefined) return `stopped before it was ready: ${why}`
      }
      await sleep(READY_POLL_MS)
    }
    await container.destroy().catch(() => undefined)
    return `not ready after ${timeoutMs} ms: ${last}`
  }

  /** Send a request to the container, once more if it lands on one that just exited. */
  private async forward(request: Request): Promise<Response> {
    // The container speaks plain HTTP; the scheme is the only thing rewritten.
    const url = request.url.replace('https:', 'http:')
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.container.getTcpPort(CONTAINER_PORT).fetch(url, request)
      } catch (error) {
        if (!mayRetry(request.method, attempt)) throw error
        console.warn(`walgit container: ${request.method} failed (${messageOf(error)}); retrying`)
        await sleep(RETRY_DELAY_MS)
        await this.ensureRunning()
      }
    }
  }

  /**
   * Pass a response body through, settling the request when its LAST byte
   * leaves — a clone is one request that streams for as long as it takes, and
   * the idle clock must not start until it is over. No copy and no buffering:
   * the identity stream forwards chunks as they arrive.
   */
  private trackBody(response: Response, settle: () => void): Response {
    const { readable, writable } = new IdentityTransformStream()
    // Settled either way: an abandoned clone is over too, and its rejection is
    // the client's, not something to log.
    response.body!.pipeTo(writable).then(settle, settle)
    return new Response(readable, response)
  }

  /**
   * Proxy a WebSocket by holding both ends, so the request stays in flight for
   * as long as the socket is open. Returning the container's socket as-is would
   * work and would leave the idle clock blind to it. Nothing walgit serves from
   * the container upgrades today — the ref-event stream is answered at the edge
   * (worker/events-do.ts) — but the `Container` class proxied sockets, and a
   * route that one day does must not be cut off mid-conversation.
   */
  private proxySocket(response: Response, settle: () => void): Response {
    const upstream = response.webSocket!
    const [client, server] = Object.values(new WebSocketPair())
    upstream.accept()
    server.accept()
    // 1005 and 1006 are reserved and may not be sent in a close frame.
    const code = (value: number) => (value === 1005 || value === 1006 ? 1000 : value)
    const pipe = (from: WebSocket, to: WebSocket) => {
      from.addEventListener('message', (event) => {
        try {
          to.send(event.data)
        } catch {
          from.close(1011, 'walgit: the other end of the socket is gone')
        }
      })
      from.addEventListener('close', (event) => {
        settle()
        try {
          to.close(code(event.code), event.reason)
        } catch {
          // Already closed from the other side.
        }
      })
      from.addEventListener('error', () => {
        settle()
        try {
          to.close(1011, 'walgit: socket error')
        } catch {
          // Already closed.
        }
      })
    }
    pipe(server, upstream)
    pipe(upstream, server)
    return new Response(null, {
      status: response.status,
      headers: response.headers,
      webSocket: client,
    })
  }

  /** One request is over. The last one out moves the idle deadline. */
  private finished(): void {
    this.inflight = Math.max(0, this.inflight - 1)
    if (this.inflight > 0) return
    const now = Date.now()
    this.lastActivity = now
    if (!this.ctx.container?.running) return
    const at = rearmAt({ now, scheduled: this.alarmAt, sleepAfterMs: this.sleepAfterMs })
    if (at !== null) void this.arm(at)
  }

  private async arm(at: number): Promise<void> {
    this.alarmAt = at
    try {
      await this.ctx.storage.setAlarm(at)
    } catch (error) {
      this.alarmAt = null
      console.error(`walgit container: alarm not armed: ${messageOf(error)}`)
    }
  }

  /** Single-flight: a request that arrives mid-stop waits for it in `ensureRunning`. */
  private stopContainer(): Promise<void> {
    if (this.stopping) return this.stopping
    const stopping = this.stop().finally(() => {
      if (this.stopping === stopping) this.stopping = null
    })
    this.stopping = stopping
    return stopping
  }

  /**
   * Snapshot, then SIGTERM, then — only if it lingers — kill.
   *
   * The snapshot comes first because it needs a running container, and it is
   * taken with nothing in flight and the window of idleness behind it, so the
   * detached work a push can leave running (a compaction) has had that long to
   * finish. A failed snapshot does not stop the stop: the record already held
   * is for this same image or `shouldSnapshot` would have said no, so the next
   * start restores that one and re-syncs a little more.
   */
  private async stop(): Promise<void> {
    const container = this.container
    if (this.snapshots && container.running) {
      try {
        await this.snapshot(container)
      } catch (error) {
        console.error(`walgit container: snapshot failed: ${messageOf(error)}`)
      }
    }

    if (container.running) container.signal(SIGTERM)
    const exited = await settledWithin(this.exitOf(container), STOP_GRACE_MS)
    if (exited === undefined && container.running) {
      console.warn(`walgit container: still running ${STOP_GRACE_MS} ms after SIGTERM; killing`)
      await container.destroy()
    }
    await this.ctx.storage.delete([BOOTED_IMAGE_KEY, BOOTED_FROM_KEY])
    this.freshStart = null
    console.log('walgit container: stopped for idleness')
  }

  /** Snapshot the running container, if it booted from the image this deploy starts. */
  private async snapshot(container: Container): Promise<void> {
    const image = this.image()
    const bootedImage = (await this.ctx.storage.get<string>(BOOTED_IMAGE_KEY)) ?? null
    if (!shouldSnapshot({ enabled: this.snapshots, bootedImage, image })) return
    if (await this.compacting(container)) {
      console.log('walgit container: compaction running; not snapshotting this stop')
      return
    }
    const bootedFrom = (await this.ctx.storage.get<StartSource>(BOOTED_FROM_KEY)) ?? null
    if (bootedFrom === 'snapshot') {
      const changed = await this.diskChanged(container)
      if (!needsNewSnapshot({ bootedFrom, changed })) {
        console.log('walgit container: cache unchanged since restore; keeping the snapshot')
        return
      }
    }
    await this.flushDisk(container)
    const begun = Date.now()
    const handle = await container.snapshotContainer({ name: `walgit-${begun}` })
    await this.ctx.storage.put(
      SNAPSHOT_KEY,
      recordSnapshot(handle, { image, store: storeIdentity(this.env), now: Date.now() }),
    )
    console.log(
      `walgit container: snapshot ${handle.id} (${handle.size} bytes) in ${Date.now() - begun} ms`,
    )
  }

  /**
   * Is a detached compaction still running in the container?
   *
   * It is the one piece of work nothing counts in flight: `post-receive`
   * spawns it disowned so the push can be acknowledged, and it repacks the
   * repository's Cache in place. A snapshot taken mid-repack would still only
   * cost a re-sync — every object stays present throughout `git repack -adf`,
   * and reconcile rewrites refs either way — but packs not yet renamed to their
   * WAL names are packs the next materialize re-downloads. So the stop goes
   * ahead (a killed compaction loses nothing: its lease lapses and the next
   * push re-triggers it) and the snapshot does not: the record already held is
   * for this same image, and the next start restores that one instead.
   *
   * Answered with `pgrep` in the container, which the image's busybox carries.
   * A failed check reads as "not compacting": the cost of being wrong is the
   * re-download above, and the cost of the other answer is a stop that never
   * snapshots.
   */
  private async compacting(container: Container): Promise<boolean> {
    try {
      const check = await container.exec(['pgrep', '-f', COMPACTION_PROCESS], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      return (await settledWithin(check.exitCode, 5_000)) === 0
    } catch {
      return false
    }
  }

  /**
   * Has the repo cache changed since this container booted?
   *
   * `null` when the check could not answer, which `needsNewSnapshot` reads as
   * "snapshot anyway": the cost of a needless snapshot is seconds, and the cost
   * of a missed one is a restore that re-syncs what this run already fetched.
   */
  private async diskChanged(container: Container): Promise<boolean | null> {
    try {
      const run = await container.exec(DISK_CHANGED_COMMAND, { stdout: 'pipe', stderr: 'ignore' })
      const out = await settledWithin(run.output(), 10_000)
      if (out === undefined || out.exitCode !== 0) return null
      return new TextDecoder().decode(out.stdout).trim() !== ''
    } catch {
      return null
    }
  }

  /** The running container's exit, asked of `monitor()` once per start. */
  private exitOf(container: Container): Promise<string> {
    if (!this.exit) this.exit = exitOf(container)
    return this.exit
  }

  /**
   * Ask the kernel to write out what it is still holding, so the snapshot sees
   * the disk the process thinks it wrote. Best-effort: the platform's own
   * snapshot may already do this, and a disk short of its last write is a
   * re-sync, never a wrong answer (shared/container-snapshot.ts).
   */
  private async flushDisk(container: Container): Promise<void> {
    try {
      const sync = await container.exec(['sync'], { stdout: 'ignore', stderr: 'ignore' })
      await settledWithin(sync.exitCode, 10_000)
    } catch (error) {
      console.warn(`walgit container: sync before snapshot failed: ${messageOf(error)}`)
    }
  }
}

/**
 * The container's exit, as a promise that never rejects: its value says how it
 * ended. `monitor()` throws outright on an object that has no container, which
 * reads here as already exited.
 */
function exitOf(container: Container): Promise<string> {
  try {
    return container.monitor().then(
      () => 'exited cleanly',
      (error: unknown) => messageOf(error),
    )
  } catch (error) {
    return Promise.resolve(messageOf(error))
  }
}

/**
 * The promise's value if it settles within `ms`, else undefined — with the
 * timer cleared either way, so nothing is left pending to hold the object in
 * memory after the caller has moved on.
 */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
