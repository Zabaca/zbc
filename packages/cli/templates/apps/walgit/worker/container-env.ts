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
 * replaces the container when they differ (see `WalgitContainer` in index.ts).
 */

/**
 * Every variable the container is allowed to be told about, and no more.
 *
 * A limit that does not reach the container is a limit `GET /` never states and
 * the push path never enforces — silently, since every one of these is optional
 * and an unset one simply means unenforced.
 */
export const CONTAINER_ENV = [
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
  // stranger fabricating events (worker/events.ts).
  'WALGIT_EVENTS_URL',
  'WALGIT_EVENTS_TOKEN',
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
