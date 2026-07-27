// The mart contract (ADR-0004, CONTEXT.md "Data Warehouse"): a mart is not a mart without
// its declared column schema + freshness sidecar — never inferred. This is the single
// zod-defined shape both the materialize pipeline (writer) and the mart-read edge handler
// (reader) import and parse at the boundary, so the two sides can't drift.

import { z } from 'zod'

/** A mart's name, as it appears in a storage key (`martKey`/`martSidecarKey`, both
 * `marts/<name>.*` — see r2-keys.ts) and in the mart-read edge route. Lowercase/digits/
 * underscore only, matching dbt's own `mart_*` model naming; no `.`/`/` means no
 * path-segment tricks reach an R2 key. */
export const MART_NAME_RE = /^[a-z][a-z0-9_]*$/
export const MartName = z
  .string()
  .regex(MART_NAME_RE, 'mart name: lowercase letters/digits/_, starting with a letter')

/** DuckDB/Parquet physical types this pipeline emits. Narrower than DuckDB's full type
 * vocabulary on purpose — only what a mart column actually needs. */
export const MartColumnTypeSchema = z.enum(['VARCHAR', 'TIMESTAMP', 'BIGINT', 'DOUBLE', 'BOOLEAN'])
export type MartColumnType = z.infer<typeof MartColumnTypeSchema>

export const MartColumnSchema = z.object({
  name: z.string(),
  type: MartColumnTypeSchema,
  description: z.string(),
})
export type MartColumn = z.infer<typeof MartColumnSchema>

/** The sidecar written next to a mart's parquet file at `<mart>.schema.json`. `generatedAt`
 * is the mart's freshness stamp — the time THIS materialize run produced the parquet, not an
 * inferred file mtime. A mart without this sidecar isn't a mart — a partial write reads as
 * absent. */
export const MartSidecarSchema = z.object({
  name: MartName,
  description: z.string(),
  columns: z.array(MartColumnSchema).min(1),
  generatedAt: z.string().datetime(),
  rowCount: z.number().int().nonnegative(),
})
export type MartSidecar = z.infer<typeof MartSidecarSchema>

/** A mart row as it crosses the boundary out of DuckDB. Values are the JS shapes a caller
 * can hold — never `bigint` (INT64 columns arrive as BigInt and do not `JSON.stringify`),
 * and never a raw `Date` (a parquet reader — e.g. hyparquet in the edge Worker — returns
 * TIMESTAMP/DATE columns as JS `Date` objects; `coerceMartRow` flattens those to ISO
 * strings). */
export type MartRow = Record<string, string | number | boolean | null>

/** Coerce one raw row (as it might arrive from a BIGINT- and Date-producing reader) into a
 * JSON-safe MartRow: `bigint` → `number` when it's within Number.MAX_SAFE_INTEGER, else →
 * its decimal string so precision isn't silently lost; `Date` (a TIMESTAMP/DATE column) →
 * `toISOString()`. */
export function coerceMartRow(raw: Record<string, unknown>): MartRow {
  const out: MartRow = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'bigint') {
      out[key] =
        value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
          ? Number(value)
          : value.toString()
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value
    } else {
      throw new Error(`coerceMartRow: unsupported value type for column "${key}": ${typeof value}`)
    }
  }
  return out
}
