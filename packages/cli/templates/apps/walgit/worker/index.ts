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
 * Reads are proxied like everything else. Serving a fetch straight from R2 at
 * the edge, without waking the container, is a real optimisation and
 * deliberately not in this milestone.
 */

import { Container, getContainer } from '@cloudflare/containers'

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
] as const

export class WalgitContainer extends Container<Env> {
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // No id, so one singleton container serves every repository. That is not a
    // scaling ceiling imposed by the design — `index.json` is compare-and-swap
    // and `sync.ts` reconciles on every access, so any container could take any
    // push — it is cache locality: a second instance starts with an empty disk
    // and materializes everything it is asked for from the log.
    return getContainer(env.WALGIT_CONTAINER).fetch(request)
  },
}
