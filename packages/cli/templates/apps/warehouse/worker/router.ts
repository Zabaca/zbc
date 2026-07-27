// Pure, testable request routing + bearer auth for the warehouse Worker (ADR-0004,
// CONTEXT.md "Data Warehouse"). Split out of worker/index.ts rather than living there
// directly: index.ts's `export class Warehouse extends BaseSandbox {}` needs a real
// (non-type-only) top-level `import ... from '@cloudflare/sandbox'`, and merely LOADING
// that import crashes the Bun process outright (Bus error / Segfault — not a catchable
// exception, verified against this package's own node_modules) outside the workerd
// runtime. materialize-dispatch.ts hits the same package and solves it by keeping the
// unsafe reference inside a function body (containerExec) that tests never call; that
// trick doesn't extend to a top-level `class ... extends` — the base class must be a
// resolved value the moment the module evaluates, so there's no way to make index.ts
// itself loadable under bun:test. `bun test worker` runs every *.test.ts file in one
// process, so a test file importing index.ts wouldn't just fail its own assertions, it
// would take the whole suite down. This module holds the fetch/scheduled routing and
// authorized() so they're exercisable under bun:test — with only a type-only `Sandbox`
// import (erased at compile time, see materialize-dispatch.ts), never the real one.
// index.ts imports Env/authorized/handleFetch from here and stays a thin, untested (like
// containerExec) wrangler entrypoint.

import type { Sandbox } from '@cloudflare/sandbox'
import {
  dispatchMaterialize,
  type Env as MaterializeEnv,
  type MaterializeDeps,
} from './materialize-dispatch'
import { handleMartRead } from './mart-api'

export interface Env extends MaterializeEnv {
  WAREHOUSE_CONTAINER: DurableObjectNamespace<Sandbox>
  WAREHOUSE_BUCKET: R2Bucket
  /** Bearer token guarding every route (worker secret, pushed by zbc apply). */
  WAREHOUSE_TOKEN?: string
}

/** Constant-time bearer check: compare SHA-256 digests via crypto.subtle.timingSafeEqual
 * so a mismatched length or value can't be distinguished by timing — ported exactly from
 * the inbox app template's `authorized()` (worker/index.ts there). */
export async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.WAREHOUSE_TOKEN) return false
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(env.WAREHOUSE_TOKEN)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

/** GET /marts/:name -> mart-api's handleMartRead; POST /materialize ->
 * materialize-dispatch's dispatchMaterialize; anything else -> 404. Assumes the caller
 * already cleared the bearer-token gate (handleFetch below). */
export async function route(request: Request, env: Env, deps: MaterializeDeps): Promise<Response> {
  const { pathname } = new URL(request.url)

  const martMatch = pathname.match(/^\/marts\/([^/]+)$/)
  if (martMatch && request.method === 'GET') {
    return handleMartRead(env.WAREHOUSE_BUCKET, martMatch[1]!)
  }

  if (pathname === '/materialize' && request.method === 'POST') {
    return dispatchMaterialize(env, deps)
  }

  return Response.json({ error: 'not found' }, { status: 404 })
}

/** The Worker's whole fetch() behavior: 401 before any route handler runs when the
 * bearer check fails, otherwise dispatch via route(). */
export async function handleFetch(
  request: Request,
  env: Env,
  deps: MaterializeDeps,
): Promise<Response> {
  if (!(await authorized(request, env))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return route(request, env, deps)
}
