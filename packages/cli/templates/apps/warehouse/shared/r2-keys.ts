// R2 key builders for the warehouse app.
//
// This app is single-tenant per deployed environment: the R2 bucket itself
// is the project+env scope, so keys carry no per-workspace prefix (unlike
// cedarpad's workspaces/<ws>/... layout).
//
// MARTS ONLY — there is deliberately no `rawKey` here. Connectors land raw parquet on the
// container's own disk (connectors/github.py writes to ./raw), dbt reads it from there, and
// it is discarded when the container sleeps; nothing uploads it. A `rawKey` builder existed
// briefly with no callers, which made the raw layer look durable when it is not. See
// docs/adr/0004's "raw is container-local" consequence for what that costs (no incremental
// extraction — every run re-extracts in full) before adding one back.

/** Key for a mart's parquet artifact. */
export const martKey = (name: string): string => `marts/${name}.parquet`

/** Key for a mart's schema/freshness sidecar JSON. */
export const martSidecarKey = (name: string): string => `marts/${name}.schema.json`
