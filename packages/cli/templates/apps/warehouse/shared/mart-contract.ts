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
  // Bounded so a pathological dbt model name can't build a pathological R2 key.
  .max(64, 'mart name: at most 64 characters')

/** DuckDB/Parquet physical types this pipeline emits. Narrower than DuckDB's full type
 * vocabulary on purpose — only what a mart column actually needs. */
export const MartColumnTypeSchema = z.enum(['VARCHAR', 'TIMESTAMP', 'BIGINT', 'DOUBLE', 'BOOLEAN'])
export type MartColumnType = z.infer<typeof MartColumnTypeSchema>

/** `.min(1)` on name and description, not a bare `z.string()`: the "every column is
 * described" rule is ADR-0004's central claim, so it belongs in the schema BOTH sides parse
 * at the boundary — not only in the writer's imperative checks (container/materialize.ts's
 * `buildSidecar`). Without it an empty-string description validates cleanly, and a sidecar
 * written by anything other than buildSidecar (a hand-edited object in R2, a future writer,
 * an older sidecar from before this rule) sails through the reader's parse. `.strict()`
 * rejects unknown keys so a typo'd field fails loudly instead of being silently dropped. */
export const MartColumnSchema = z
  .object({
    name: z.string().min(1, 'mart column: name must not be empty'),
    type: MartColumnTypeSchema,
    description: z.string().min(1, 'mart column: description must not be empty'),
  })
  .strict()
export type MartColumn = z.infer<typeof MartColumnSchema>

/** The sidecar written next to a mart's parquet file at `<mart>.schema.json`. `generatedAt`
 * is the mart's freshness stamp — the time THIS materialize run produced the parquet, not an
 * inferred file mtime. A mart without this sidecar isn't a mart — a partial write reads as
 * absent. */
export const MartSidecarSchema = z
  .object({
    name: MartName,
    description: z.string().min(1, 'mart: description must not be empty'),
    columns: z
      .array(MartColumnSchema)
      .min(1)
      // Duplicate column names would make the declared contract ambiguous about which
      // column a consumer is being promised — and a row object can only carry one of them.
      .refine(
        (cols) => new Set(cols.map((c) => c.name)).size === cols.length,
        'mart: duplicate column names in the declared schema',
      ),
    generatedAt: z.string().datetime(),
    rowCount: z.number().int().nonnegative(),
  })
  .strict()
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
  // `Object.create(null)`, not `{}`: on a normal object literal, `out['__proto__'] = v`
  // invokes the inherited __proto__ SETTER rather than defining an own property, and that
  // setter ignores primitives — so a mart column literally named `__proto__` would vanish
  // from every row with no error at all. A null-prototype object has no such setter, so the
  // column round-trips like any other. (JSON.stringify treats both identically otherwise.)
  const out = Object.create(null) as MartRow
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'bigint') {
      out[key] =
        value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
          ? Number(value)
          : value.toString()
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      // NaN/Infinity in a DOUBLE column have no JSON representation — `JSON.stringify`
      // silently renders them as `null`, which a consumer reads as SQL NULL ("no value")
      // rather than "not a number". Map them explicitly so the lossy step is a decision
      // recorded here, not an accident of the serializer.
      out[key] = null
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
