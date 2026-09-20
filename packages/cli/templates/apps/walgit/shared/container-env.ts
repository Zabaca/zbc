/**
 * The environment the container boots with, and a fingerprint of it.
 *
 * The container is a separate process on a separate machine: it reads its
 * configuration from `process.env` exactly once, at start. That is a deliberate
 * property — `src/server.ts` resolves the policy at boot "so the page and the
 * sweeper can never disagree" — and re-reading `process.env` per request would
 * not make it any fresher, because a running process's environment is fixed.
 * The only way a new value reaches the container is a new container.
 *
 * A `wrangler deploy` that changes only vars produces no new container image,
 * so `--containers-rollout immediate` has nothing to roll: the Worker picks the
 * value up on its next request and the container keeps serving the old one, for
 * as long as traffic keeps it awake. The fingerprint below is what closes that
 * gap — the Durable Object compares it against the one it last booted with and
 * replaces the container when they differ (see `WalgitContainer` in worker/index.ts).
 */

/**
 * Every variable the container is allowed to be told about, and no more.
 *
 * A limit that does not reach the container is a limit `GET /` never states and
 * the push path never enforces — silently, since every one of these is optional
 * and an unset one simply means unenforced.
 */
export const CONTAINER_ENV = [
  // Which deploy this is, and the one variable here that configures nothing.
  //
  // Everything else on this list changes what the container DOES; this changes
  // only the fingerprint, which is the point. A deploy that ships a new image
  // and no new configuration moves no value above, so the Durable Object sees
  // an unchanged environment and leaves the old container serving — observed
  // on the 0.16.1 production deploy, where `--containers-rollout immediate`
  // reported a completed rollout and the instance answering git was the one
  // started an hour before. The image is not something this side can inspect,
  // so the deploy names itself instead: the cloudflare module's `deployIdVar`
  // passes the deployed commit as a var, and this line is what carries it the
  // last hop into the container.
  //
  // Nothing reads it. It is visible in the container's own environment and on
  // the Worker's variables in the dashboard, which is the second thing it buys
  // — Cloudflare numbers container versions itself (v50, v51) and nothing else
  // in the deploy says which commit that is.
  'WALGIT_BUILD_ID',
  'WALGIT_HTTP_TOKENS',
  'WALGIT_S3_ENDPOINT',
  'WALGIT_S3_BUCKET',
  'WALGIT_S3_ACCESS_KEY_ID',
  'WALGIT_S3_SECRET_ACCESS_KEY',
  'WALGIT_S3_REGION',
  'WALGIT_COMPACTION_THRESHOLD',
  'WALGIT_GC_GRACE_MS',
  'WALGIT_DELETE_GRACE_MS',
  'WALGIT_PUBLIC',
  'WALGIT_APPEND_ONLY',
  'WALGIT_RETENTION_HOURS',
  'WALGIT_MAX_PUSH_BYTES',
  'WALGIT_MAX_REPO_BYTES',
  // The ref-event stream's two halves. The push path announces from inside the
  // container, so it needs both where to announce (the Worker's own public
  // origin) and the secret that proves it is walgit's push path and not a
  // stranger fabricating events (shared/events.ts).
  'WALGIT_EVENTS_URL',
  'WALGIT_EVENTS_TOKEN',
  // Signed pushes. The seed is what `git-receive-pack` derives its nonce from,
  // and receive-pack runs inside the container — so this is the variable that
  // decides whether the capability is advertised at all (src/push-cert.ts).
  'WALGIT_PUSH_CERT_SEED',
  // Signer Lists (docs/adr/0012). Its own variable rather than a consequence of
  // the seed above: the seed is the flag for SIGNING because a client's own git
  // refuses `--signed` where it is unset, so that capability cannot be asked for
  // where it is not offered. Ownership is a server-side refusal with no such
  // coupling, and riding the seed would turn it on for every deployment that
  // already set one.
  'WALGIT_SIGNER_LISTS',
  // Private repositories (docs/adr/0013). A seed rather than a flag, because
  // the Read Challenge's nonce is derived from it — and it reaches the
  // container because the Reader List is read in `pre-receive` and every read
  // will be verified here, where a subprocess exists.
  'WALGIT_PRIVATE_REPOS',
  // Proposals (docs/adr/0018). A plain flag rather than a seed: it carries no
  // nonce and mints nothing — it only widens what `pre-receive` accepts on a
  // claimed name, and the hook that widens runs in the container.
  'WALGIT_PROPOSALS',
  // The web view (`shared/repo-list.ts`). The only variable on this list that
  // nothing inside the container reads: the list is answered at the edge, off
  // the log, precisely so a browse does not wake the container. It is here
  // because it is an Advertised capability, and `CapabilityVar` narrows through
  // this list — a capability the container is never told about would be one the
  // edge advertises and no half could ever enforce. The cost is the one this
  // list buys everywhere else: the deploy that first sets it changes the
  // fingerprint and replaces the running container once.
  'WALGIT_WEB',
  // Per-source rate limits (src/rate-limit.ts). The verdict is reached in the
  // container's own HTTP handler — the only place that sees both the source the
  // edge attributed the request to and the repository it names — so the numbers
  // have to reach the container like every other limit here.
  'WALGIT_RATE_WINDOW_SECONDS',
  'WALGIT_MAX_NEW_REPOS_PER_SOURCE',
  'WALGIT_MAX_PUSHES_PER_SOURCE',
  'WALGIT_MAX_PUSH_BYTES_PER_SOURCE',
] as const

export type ContainerEnvName = (typeof CONTAINER_ENV)[number]

/**
 * The forwarded subset of the Worker's environment.
 *
 * Blank is dropped rather than forwarded as an empty string, because every
 * consumer inside the container reads "unset" and "set to nothing" the same
 * way, and forwarding the difference would make two spellings of one state.
 */
export function containerEnv(
  source: Partial<Record<ContainerEnvName, string>>,
): Record<string, string> {
  const entries: [string, string][] = []
  for (const name of CONTAINER_ENV) {
    const value = source[name]
    if (value !== undefined && value !== '') entries.push([name, value])
  }
  return Object.fromEntries(entries)
}

/**
 * A short, stable digest of an environment — equal exactly when the environment
 * the container would boot with is equal.
 *
 * Hashed rather than stored verbatim on purpose: this value is persisted in
 * Durable Object storage, and half of what it covers is credentials. A digest
 * answers the only question the caller has ("is this the same environment?")
 * without keeping a second copy of the object store's keys anywhere.
 *
 * FNV-1a over a canonical serialization: synchronous (so the constructor and
 * the request path can both use it without a promise), dependency-free, and
 * sufficient here — this is a change detector between values this deployment
 * chose itself, not a defence against a crafted collision.
 */
export function fingerprintEnv(env: Record<string, string>): string {
  // Sorted so key order — which `containerEnv` fixes but a caller need not —
  // cannot make one environment fingerprint two different ways. NUL separates
  // name from value and entry from entry: it can appear in neither (a POSIX
  // environment string is NUL-terminated), so two distinct environments cannot
  // serialize to the same string.
  const canonical = Object.keys(env)
    .sort()
    .map((key) => `${key}\u0000${env[key]}`)
    .join('\u0000')

  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    // The FNV prime, through Math.imul: `hash * 16777619` leaves a double's
    // exact-integer range, which would round and make the digest depend on
    // nothing.
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * The half of a Durable Object that `reconcileContainerEnv` needs: whether a
 * container is running, how to kill it, and where the fingerprint it booted
 * with is kept.
 *
 * A port rather than the `Container` class itself because this module imports
 * no runtime (ADR-0010) — and because the rule below is about ORDER, which is
 * only observable from outside the object performing it.
 */
export interface ContainerReconcileTarget {
  /** Is a container process currently running for this Durable Object? */
  readonly running: boolean
  /** The fingerprint recorded by the last reconcile, if there has been one. */
  read(): Promise<string | undefined>
  /** Kill the running container. The next request starts a fresh one. */
  destroy(): Promise<void>
  /** Record the fingerprint the container is now running. */
  write(fingerprint: string): Promise<void>
}

/** What a reconcile did, for the caller to log. */
export type ContainerReconcileOutcome = 'unchanged' | 'recorded' | 'replaced'

/**
 * Replace the container if it is running an environment this deploy changed.
 *
 * The caller re-reads its own environment on every Durable Object
 * construction, and a `wrangler deploy` constructs a new one — so that side is
 * never stale. The container is: it read `process.env` once at start and cannot
 * be told anything afterwards. Without this, a new value takes effect whenever
 * the container next happens to idle out, which under sustained traffic is
 * never.
 *
 * The fingerprint is persisted rather than held in memory because that is the
 * only state that survives the very event being detected — a redeploy discards
 * every in-memory field, so an in-memory copy would compare the new environment
 * against itself and always agree.
 *
 * Two rules the tests pin, both learned the hard way:
 *
 *   - NO RECORD counts as a mismatch, not as a fresh start. A running container
 *     with no record predates this code, so what it booted with is unknowable,
 *     and on the deploy that ships this it is exactly the container already
 *     serving a superseded environment. A Durable Object that has never started
 *     one arrives here with `running` false and simply records.
 *   - The write happens LAST, and only after a successful destroy. Recording
 *     first would make a failed replacement look reconciled forever.
 */
export async function reconcileContainerEnv(
  target: ContainerReconcileTarget,
  current: string,
): Promise<ContainerReconcileOutcome> {
  const booted = await target.read()
  if (booted === current) return 'unchanged'

  // Only a RUNNING container can be stale. A stopped one has nothing to
  // replace: its next start reads the environment as it now is.
  const replaced = target.running
  if (replaced) await target.destroy()
  await target.write(current)
  return replaced ? 'replaced' : 'recorded'
}
