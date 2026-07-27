// The materialize pipeline, container side (ADR-0004, CONTEXT.md "Materialize"): one
// dlt-extract + `dbt run` pass, run one-shot inside the Warehouse container by
// `bun run container/materialize.ts` (worker/materialize-dispatch.ts's `containerExec`
// execs exactly that command). Three steps:
//
//   1. the reference GitHub connector (connectors/github.py) lands raw parquet
//   2. `dbt run` transforms it, `external`-materializing every mart straight to a
//      parquet file dbt itself writes (dbt/models/marts/*.sql's `location` config)
//   3. dbt's own dbt/target/manifest.json — name, description, and per-column
//      name/data_type/description, all sourced from the model's schema.yml — becomes
//      each mart's MartSidecar (worker/mart-contract.ts), validated with
//      `MartSidecarSchema.parse` BEFORE either the parquet or the sidecar is uploaded:
//      an invalid/undescribed mart must throw, not ship (ADR-0004's whole point).
//
// rowCount deliberately does NOT come from dbt/target/catalog.json, despite that being
// the original plan: verified against a real `dbt run` + `dbt docs generate` of this
// package's own dbt/ project (dbt-duckdb==1.10.1) that an `external`-materialized model
// is always a VIEW backed by `read_parquet(...)`, never a persisted table — duckdb's
// adapter reports `has_stats: false` for it and catalog.json carries no row count at
// all. Instead, rowCount is a `SELECT count(*) FROM read_parquet(...)` run through the
// same injected `run()` used for the connector/dbt steps — the same pattern cedarpad's
// warehouse/session-events-mart.ts uses for the identical reason.
//
// Deps are injected (same idea as cedarpad's session-events-mart.ts `run()` helper) so
// the pure orchestration in `materialize()` is testable without a real dlt/dbt/duckdb
// toolchain: materialize.test.ts fakes `run`/`readFile`/`upload` and writes real
// manifest.json-shaped fixtures rather than shelling out.

import { MartSidecarSchema, type MartColumn, type MartSidecar } from '../worker/mart-contract'
import { martKey, martSidecarKey } from '../worker/r2-keys'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface MaterializeDeps {
  /** Run a command to completion (Bun.spawn in the real CLI entrypoint). Used for the
   *  GitHub connector, `dbt run`, and a `duckdb -json` row-count query. */
  run: (cmd: string[]) => Promise<RunResult>
  /** Read a file's raw bytes off disk (manifest.json, a mart's parquet artifact). */
  readFile: (path: string) => Promise<Uint8Array>
  /** Upload one object (mart parquet or sidecar JSON) to R2. */
  upload: (key: string, bytes: Uint8Array) => Promise<void>
  /** The mart's freshness stamp — the time THIS materialize run produced it, not an
   *  inferred file mtime (mart-contract.ts). */
  now: () => string
}

const MANIFEST_PATH = 'dbt/target/manifest.json'

/** The subset of dbt's manifest.json this pipeline reads. Real shape is much larger
 * (486+ macros, full config blocks, etc.) — everything else is ignored. */
interface DbtManifestColumn {
  name: string
  description?: string
  data_type?: string | null
}

interface DbtManifestNode {
  resource_type: string
  name: string
  description?: string
  columns?: Record<string, DbtManifestColumn>
  config?: { materialized?: string; location?: string }
}

interface DbtManifest {
  nodes: Record<string, DbtManifestNode>
}

async function run(deps: MaterializeDeps, cmd: string[], step: string): Promise<RunResult> {
  const result = await deps.run(cmd)
  if (result.code !== 0) {
    // dbt (and several other CLIs this pipeline shells out to) writes its actual error
    // detail to stdout, not stderr — surfacing stderr alone silently drops the real
    // reason and leaves only an empty-looking "(exit N): " message.
    const detail = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n')
    throw new Error(`materialize: ${step} failed (exit ${result.code}): ${detail}`)
  }
  return result
}

/** Every `external`-materialized model in the manifest — dbt's own signal for "this is a
 * published mart, not an intermediate view" (dbt/dbt_project.yml: every model under
 * models/marts/ defaults to `+materialized: external`). */
function martNodes(manifest: DbtManifest): DbtManifestNode[] {
  return Object.values(manifest.nodes).filter(
    (node) => node.resource_type === 'model' && node.config?.materialized === 'external',
  )
}

/** Build and validate one mart's sidecar from its manifest node + row count. Throws
 * (before any upload) if the mart or any of its columns has no description, or if the
 * assembled sidecar otherwise fails MartSidecarSchema — an undescribed or malformed mart
 * must throw, not ship (ADR-0004). */
function buildSidecar(node: DbtManifestNode, rowCount: number, generatedAt: string): MartSidecar {
  if (!node.description || node.description.trim() === '') {
    throw new Error(
      `materialize: mart "${node.name}" has no description in schema.yml — refusing to ship it`,
    )
  }
  const columns: MartColumn[] = Object.values(node.columns ?? {}).map((col) => {
    if (!col.description || col.description.trim() === '') {
      throw new Error(
        `materialize: mart "${node.name}" column "${col.name}" has no description in schema.yml — refusing to ship it`,
      )
    }
    return {
      name: col.name,
      type: col.data_type as MartColumn['type'],
      description: col.description,
    }
  })
  const candidate: MartSidecar = {
    name: node.name,
    description: node.description,
    columns,
    generatedAt,
    rowCount,
  }
  return MartSidecarSchema.parse(candidate)
}

/** `SELECT count(*)` against a mart's produced parquet via the duckdb CLI (see the file
 * header for why this replaces catalog.json). */
async function countRows(deps: MaterializeDeps, parquetPath: string): Promise<number> {
  const result = await run(
    deps,
    [
      'duckdb',
      ':memory:',
      '-json',
      '-c',
      `select count(*) as n from read_parquet('${parquetPath}')`,
    ],
    `row count for ${parquetPath}`,
  )
  const rows = JSON.parse(result.stdout) as Array<{ n: number }>
  return Number(rows[0]?.n ?? 0)
}

/** Run one materialize pass: extract (dlt) → transform (dbt run) → validate + upload
 * every mart's parquet + sidecar. Returns the names of the marts published. Throws (and
 * uploads nothing for the offending mart) on a failed connector run, a failed `dbt run`,
 * or a mart that fails its schema/description contract. */
export async function materialize(deps: MaterializeDeps): Promise<{ marts: string[] }> {
  // dbt-duckdb's `external` materialization (dbt/models/marts/*.sql) COPYs straight to
  // this path — DuckDB does not create missing parent directories on write, so a bare
  // `dbt run` fails with "IO Error: Cannot open file ... No such file or directory" on
  // every fresh container. `marts/` matches every mart model's WAREHOUSE_MART_DIR
  // default (dbt/profiles.yml / models/marts/mart_github_issues.sql).
  await run(deps, ['mkdir', '-p', 'marts'], 'ensure marts directory')
  await run(deps, ['python3', 'connectors/github.py'], 'GitHub connector')
  await run(deps, ['dbt', 'run', '--project-dir', 'dbt', '--profiles-dir', 'dbt'], 'dbt run')

  const manifestBytes = await deps.readFile(MANIFEST_PATH)
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DbtManifest

  const marts: string[] = []
  for (const node of martNodes(manifest)) {
    const location = node.config?.location
    if (!location) {
      throw new Error(
        `materialize: mart "${node.name}" has no config.location — dbt did not write it to a known path`,
      )
    }

    const rowCount = await countRows(deps, location)
    const sidecar = buildSidecar(node, rowCount, deps.now())

    const parquetBytes = await deps.readFile(location)
    await deps.upload(martKey(sidecar.name), parquetBytes)
    await deps.upload(
      martSidecarKey(sidecar.name),
      new TextEncoder().encode(JSON.stringify(sidecar)),
    )

    marts.push(sidecar.name)
  }

  return { marts }
}

if (import.meta.main) {
  const client = new Bun.S3Client({
    accessKeyId: process.env.WAREHOUSE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.WAREHOUSE_R2_SECRET_ACCESS_KEY,
    bucket: process.env.WAREHOUSE_BUCKET_NAME,
    endpoint: process.env.WAREHOUSE_R2_ENDPOINT,
  })

  const deps: MaterializeDeps = {
    run: async (cmd) => {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    },
    readFile: async (path) => await Bun.file(path).bytes(),
    upload: async (key, bytes) => {
      await client.file(key).write(bytes)
    },
    now: () => new Date().toISOString(),
  }

  const result = await materialize(deps)
  console.log(`materialize: wrote ${result.marts.length} mart(s): ${result.marts.join(', ')}`)
}
