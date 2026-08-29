/**
 * Build the object store from the environment.
 *
 * Every entry point needs the same store — the smart-HTTP server, the operator
 * CLI, and both hook processes — and the hooks are spawned by git, not by us,
 * so configuration can only travel as environment. One reader keeps them in
 * agreement. The container gets that environment from the Worker, which
 * forwards it in worker/index.ts.
 *
 * Returning `null` for "not configured" is deliberate: the push path treats
 * that as fatal (there is nowhere to persist to, so nothing may be
 * acknowledged) while the read paths treat it as "serve the local cache".
 */

import { AwsClient } from 'aws4fetch'

import { FileStore, S3Store, type ObjectStore } from './store'

export type Env = Record<string, string | undefined>

export function storeFromEnv(env: Env = process.env): ObjectStore | null {
  if (env.WALGIT_STORE_DIR) return new FileStore(env.WALGIT_STORE_DIR)

  const endpoint = env.WALGIT_S3_ENDPOINT
  const bucket = env.WALGIT_S3_BUCKET
  const accessKeyId = env.WALGIT_S3_ACCESS_KEY_ID
  const secretAccessKey = env.WALGIT_S3_SECRET_ACCESS_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    // R2 ignores the region but the SigV4 signature does not: an absent region
    // signs differently and every request 403s with nothing useful in the body.
    region: env.WALGIT_S3_REGION ?? 'auto',
  })
  return new S3Store({
    endpoint: endpoint.replace(/\/$/, ''),
    bucket,
    fetch: (input, init) => client.fetch(input, init),
  })
}

/** The store, or a thrown explanation. For paths that must not proceed without one. */
export function requireStore(env: Env = process.env): ObjectStore {
  const store = storeFromEnv(env)
  if (!store) {
    throw new Error(
      'no object store configured — set WALGIT_S3_ENDPOINT, WALGIT_S3_BUCKET, ' +
        'WALGIT_S3_ACCESS_KEY_ID and WALGIT_S3_SECRET_ACCESS_KEY (or WALGIT_STORE_DIR for local use). ' +
        'Refusing to accept a push that cannot be persisted.',
    )
  }
  return store
}
