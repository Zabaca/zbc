// R2 key builders for the warehouse app.
//
// This app is single-tenant per deployed environment: the R2 bucket itself
// is the project+env scope, so keys carry no per-workspace prefix (unlike
// cedarpad's workspaces/<ws>/... layout).

/** Key for a raw (pre-transform) object landed by a connector. */
export const rawKey = (path: string): string => `raw/${path}`

/** Key for a mart's parquet artifact. */
export const martKey = (name: string): string => `marts/${name}.parquet`

/** Key for a mart's schema/freshness sidecar JSON. */
export const martSidecarKey = (name: string): string => `marts/${name}.schema.json`
