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

import { s3StoreFrom, type ObjectStore } from '../shared/store'
import { FileStore } from './store'

export type Env = Record<string, string | undefined>

export function storeFromEnv(env: Env = process.env): ObjectStore | null {
  // The one branch only this half can serve: a local directory instead of a
  // bucket, for development and tests.
  if (env.WALGIT_STORE_DIR) return new FileStore(env.WALGIT_STORE_DIR)
  // Everything else is the shared reading (`shared/store.ts`), which the edge
  // makes too — including the region rule, which is the part that used to be
  // commented identically in both copies.
  return s3StoreFrom(env, (credentials) => new AwsClient(credentials))
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
