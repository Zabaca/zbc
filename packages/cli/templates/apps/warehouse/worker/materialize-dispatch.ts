// Materialize dispatch, edge side (ADR-0004, CONTEXT.md "Materialize"). A materialize run
// is one dlt-extract + dbt-run pass inside the Warehouse container, triggered by the
// Worker's own Cloudflare Cron Trigger (wrangler.jsonc's `triggers.crons`) or a manual
// POST /materialize. Split pure vs impure the same way cedarpad's warehouse-dispatch.ts /
// sandbox-runtime.ts split kickWarehouseMaterialize from warehouseExec: dispatchMaterialize
// is pure HTTP-shape logic over an injected exec fn (unit-tested below); containerExec is
// the real @cloudflare/sandbox wake-and-run call, an integration seam exercised by deploy,
// not by this test file — same reasoning cedarpad used for warehouseExec.
//
// containerExec's '@cloudflare/sandbox' import is a DYNAMIC import inside the function
// body, not a top-level static import: verified in this repo that a bare top-level
// `import { getSandbox } from '@cloudflare/sandbox'` crashes the Bun process outright
// (a Bus error, not a catchable exception) when run outside the workerd runtime. A
// top-level import here would take down materialize-dispatch.test.ts — and anything
// else that imports this module — the moment it's loaded, not just when containerExec
// actually runs. Keep it lazy.
//
// `Sandbox` below is a type-only import — erased at compile time, never loaded at
// runtime — used only to parameterize DurableObjectNamespace so it structurally
// matches what `getSandbox` expects; it costs nothing on the "don't statically pull
// in @cloudflare/sandbox" guarantee above.
import type { Sandbox } from '@cloudflare/sandbox'

export interface MaterializeExecResult {
  success: boolean
  stdout: string
  stderr: string
}

export interface MaterializeDeps {
  /** One-shot `bun run container/materialize.ts` against the Warehouse container
   *  (containerExec below is the real impl). Injected so dispatchMaterialize stays
   *  pure and testable off the edge runtime. */
  exec: (env: Env) => Promise<MaterializeExecResult>
}

/**
 * Local Env shape for this module only. worker/index.ts (built in a later phase) will
 * import dispatchMaterialize/containerExec FROM this file, not the other way around —
 * importing its Env here would create a cycle — so this is a plain structural subset,
 * kept in sync by field name rather than by a shared import:
 *  - WAREHOUSE_CONTAINER: the DO binding wrangler.jsonc declares under
 *    `durable_objects.bindings` (class_name "Warehouse").
 *  - GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO: the reference connector's secret + vars
 *    (registry.json's `secrets` / the cloudflare instance's `workerVars`).
 *  - WAREHOUSE_BUCKET_NAME/WAREHOUSE_R2_ACCESS_KEY_ID/WAREHOUSE_R2_SECRET_ACCESS_KEY/
 *    WAREHOUSE_R2_ENDPOINT: S3-compatible credentials for the CONTAINER's own upload of
 *    dbt's `external`-materialized parquet. Deliberately separate from the Worker's own
 *    WAREHOUSE_BUCKET R2 binding (wrangler.jsonc's `r2_buckets`, used for the Worker's
 *    edge mart reads via hyparquet) — the container is a separate process outside the
 *    Worker's binding graph, so it can't use that binding and needs real R2 API
 *    credentials instead (same shape as cedarpad's blob-store.ts `s3Backend`). Names
 *    chosen to be plausible, not final — worker/index.ts's real Env is the source of
 *    truth; reconcile these to match it exactly once that phase lands.
 */
export interface Env {
  WAREHOUSE_CONTAINER: DurableObjectNamespace<Sandbox>
  GITHUB_TOKEN?: string
  GITHUB_OWNER?: string
  GITHUB_REPO?: string
  WAREHOUSE_BUCKET_NAME?: string
  WAREHOUSE_R2_ACCESS_KEY_ID?: string
  WAREHOUSE_R2_SECRET_ACCESS_KEY?: string
  WAREHOUSE_R2_ENDPOINT?: string
}

/**
 * Dispatch one materialize run: exec the container (injected), map the result to the
 * HTTP response the caller (the cron handler, or a manual POST /materialize route)
 * returns. 202 on success — a materialize run outlives the request, so this is a
 * kickoff acknowledgment, not a "done" signal. 502 on failure, carrying stderr for
 * diagnosis (mirrors cedarpad's kickWarehouseMaterialize error shape).
 */
export async function dispatchMaterialize(env: Env, deps: MaterializeDeps): Promise<Response> {
  const result = await deps.exec(env)
  if (!result.success) {
    return Response.json({ error: 'materialize failed', stderr: result.stderr }, { status: 502 })
  }
  return Response.json({ materializing: true }, { status: 202 })
}

/**
 * Real exec: wake the WAREHOUSE_CONTAINER DO and run the pipeline's CLI entrypoint
 * one-shot. Not unit-tested here — an integration seam against @cloudflare/sandbox and
 * the container image, not pure logic; dispatchMaterialize's injected-exec seam above
 * is what TDD covers.
 */
export async function containerExec(env: Env): Promise<MaterializeExecResult> {
  const { getSandbox } = await import('@cloudflare/sandbox')
  const sandbox = getSandbox(env.WAREHOUSE_CONTAINER, 'warehouse', { normalizeId: true })
  const result = await sandbox.exec('bun run container/materialize.ts', {
    cwd: '/app',
    env: {
      GITHUB_TOKEN: env.GITHUB_TOKEN ?? '',
      GITHUB_OWNER: env.GITHUB_OWNER ?? '',
      GITHUB_REPO: env.GITHUB_REPO ?? '',
      // R2 upload creds — see the Env doc comment above for why these can't just be
      // the Worker's WAREHOUSE_BUCKET binding.
      WAREHOUSE_BUCKET_NAME: env.WAREHOUSE_BUCKET_NAME ?? '',
      WAREHOUSE_R2_ACCESS_KEY_ID: env.WAREHOUSE_R2_ACCESS_KEY_ID ?? '',
      WAREHOUSE_R2_SECRET_ACCESS_KEY: env.WAREHOUSE_R2_SECRET_ACCESS_KEY ?? '',
      WAREHOUSE_R2_ENDPOINT: env.WAREHOUSE_R2_ENDPOINT ?? '',
    },
  })
  return { success: result.success, stdout: result.stdout, stderr: result.stderr }
}
