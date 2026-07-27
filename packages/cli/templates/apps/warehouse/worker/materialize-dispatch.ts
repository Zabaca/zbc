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
  /** R2 S3-compatible credentials for the CONTAINER's own mart uploads. Deliberately
   *  separate from the Worker's WAREHOUSE_BUCKET binding (wrangler.jsonc's `r2_buckets`,
   *  used for edge mart reads): the container is a separate process outside the Worker's
   *  binding graph, so it cannot use that binding and needs real API credentials. */
  WAREHOUSE_BUCKET_NAME?: string
  WAREHOUSE_R2_ACCESS_KEY_ID?: string
  WAREHOUSE_R2_SECRET_ACCESS_KEY?: string
  WAREHOUSE_R2_ENDPOINT?: string
  /** Connector configuration and secrets (e.g. GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN for the
   *  shipped reference connector) arrive as ordinary string bindings from the instance's
   *  workerSecrets/workerVars and are forwarded wholesale by `buildContainerEnv`. They are
   *  NOT named individually here: doing so would weld each connector into the framework's
   *  own type, which is exactly what container/connectors.ts exists to avoid. */
  [key: string]: unknown
}

/**
 * Dispatch one materialize run: exec the container (injected), map the result to the HTTP
 * response the caller (the cron handler, or a manual POST /materialize route) returns.
 *
 * NOTE this is SYNCHRONOUS with the run — `deps.exec` is awaited to completion, so the
 * request lasts as long as the whole extract + transform. That is fine at the reference
 * connector's scale (one repo's issues) and it is what makes a failure reportable at all,
 * but it does mean a large warehouse will outgrow the caller's HTTP timeout. If that
 * happens, the fix is to move the await behind `ctx.waitUntil` and expose a last-run
 * record for polling — not to keep pretending the response is a kickoff acknowledgment.
 */
export async function dispatchMaterialize(env: Env, deps: MaterializeDeps): Promise<Response> {
  const result = await deps.exec(env)
  if (!result.success) {
    // stderr is LOGGED, not returned. The container this ran in holds the connector
    // secrets (containerExec injects GITHUB_TOKEN below), and dlt/dbt tracebacks routinely
    // echo client configuration — `BearerTokenAuth(token)` is constructed inside
    // connectors/github.py and can appear in a repr. Returning raw stderr over HTTP would
    // hand that to any bearer holder, which is a wider boundary than ADR-0004's
    // secret-scoping caveat already concedes. The operator gets the detail in the Worker
    // log; the caller gets only that it failed.
    console.error(`materialize failed: ${result.stderr}`)
    return Response.json({ error: 'materialize failed' }, { status: 502 })
  }
  // 200, not 202: `deps.exec` above is awaited to completion, so by the time this returns
  // the run is genuinely finished. A 202 would claim the work was merely accepted and is
  // still in flight, which was never true here and invited callers to poll for a completion
  // that had already happened.
  return Response.json({ materialized: true }, { status: 200 })
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
    env: buildContainerEnv(env),
  })
  return { success: result.success, stdout: result.stdout, stderr: result.stderr }
}

/** The exact set of values that crosses into the container, built in one place and unit
 * tested (see materialize-dispatch.test.ts) so the boundary is asserted rather than assumed.
 *
 * Two rules encoded here. First, the four WAREHOUSE_R2_* / WAREHOUSE_BUCKET_NAME values are
 * always forwarded — the container writes marts to R2 directly over the S3 API because it
 * runs outside the Worker's binding graph and cannot use the WAREHOUSE_BUCKET r2Binding.
 * Second, connector configuration is forwarded by CONVENTION, not by an allowlist naming
 * GitHub: anything the instance sets whose name isn't a Worker-only concern goes through, so
 * adding a connector needs no edit here. WAREHOUSE_TOKEN is deliberately excluded — it gates
 * the edge API and the container has no use for it. */
export function buildContainerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (BLOCKED_FROM_CONTAINER.has(key)) continue
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Names that must never cross into the container, and why each one is here.
 *
 * WAREHOUSE_TOKEN gates the edge API; the container has no use for it, so it has no business
 * sitting in a process whose stderr and filesystem a connector script can reach.
 * WAREHOUSE_CONTAINER / WAREHOUSE_BUCKET are bindings (objects, not strings) and could not
 * cross a process boundary meaningfully anyway.
 *
 * The rest are LOAD-BEARING runtime configuration that the pipeline's own correctness
 * depends on, and forwarding-by-convention would otherwise let an instance file quietly
 * override them:
 *   - TZ silently shifts every timestamp. dlt lands timestamps as TIMESTAMP WITH TIME ZONE
 *     and DuckDB's cast-to-TIMESTAMP resolves against the session zone, so a stray TZ
 *     rewrites the data while every column name, type, and schema check still passes.
 *   - WAREHOUSE_RAW_DIR / WAREHOUSE_MART_DIR are interpolated into DuckDB string literals
 *     inside dbt models; a value containing a quote escapes into arbitrary SQL.
 *     container/materialize.ts validates these too (defence in depth — that check also
 *     covers a value set inside the image), but they should never arrive from instance
 *     config in the first place.
 *   - WAREHOUSE_PATCH_MP_LOCKS / NORMALIZE__WORKERS are set per-command by
 *     container/materialize.ts to scope the multiprocessing-lock workaround to dbt alone;
 *     an ambient value would silently widen or disable it.
 */
const BLOCKED_FROM_CONTAINER = new Set([
  'WAREHOUSE_TOKEN',
  'WAREHOUSE_CONTAINER',
  'WAREHOUSE_BUCKET',
  'TZ',
  'WAREHOUSE_RAW_DIR',
  'WAREHOUSE_MART_DIR',
  'WAREHOUSE_PATCH_MP_LOCKS',
  'NORMALIZE__WORKERS',
])
