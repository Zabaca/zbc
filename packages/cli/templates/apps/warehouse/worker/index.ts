// Warehouse Worker entrypoint (ADR-0004, CONTEXT.md "Data Warehouse"). This is
// wrangler.jsonc's `main` — the module workerd loads directly, and the one that binds
// `class Warehouse extends BaseSandbox {}` to `containers[0].class_name` /
// `durable_objects.bindings[].class_name` ("Warehouse", binding name
// WAREHOUSE_CONTAINER). All the testable logic (bearer auth, GET /marts/:name -> POST
// /materialize routing) lives in ./router and is unit-tested there — see router.ts's
// header comment for why: the static `import ... from '@cloudflare/sandbox'` this file
// needs for the class declaration crashes Bun outright the moment the module loads
// (verified in this repo), so this file itself can never be imported by a bun:test file.
// It stays a thin, untested (like materialize-dispatch.ts's containerExec) integration
// seam — deploy-only code exercised by wrangler dev/deploy, not by `bun test`.

import { Sandbox as BaseSandbox } from '@cloudflare/sandbox'
import { containerExec, dispatchMaterialize } from './materialize-dispatch'
import { handleFetch, type Env } from './router'

export { type Env }

/** The Durable-Object-backed container class wrangler.jsonc's `containers[0]` /
 * `durable_objects.bindings` wire up under the name WAREHOUSE_CONTAINER. */
export class Warehouse extends BaseSandbox {}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, { exec: containerExec })
  },

  /** Cloudflare Cron Trigger handler (wrangler.jsonc's `triggers.crons`) — the same
   * one-shot materialize dispatch as POST /materialize, minus the bearer check (a cron
   * invocation isn't a Request, there's no header to check). ctx.waitUntil keeps the
   * container exec alive past this handler returning. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchMaterialize(env, { exec: containerExec }).then(() => undefined))
  },
}
