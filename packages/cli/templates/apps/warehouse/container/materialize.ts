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

import {
  MartColumnTypeSchema,
  MartSidecarSchema,
  type MartColumn,
  type MartSidecar,
} from '../shared/mart-contract'
import { martKey, martSidecarKey } from '../shared/r2-keys'
import { CONNECTORS, type Connector } from './connectors'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface MaterializeDeps {
  /** Run a command to completion (Bun.spawn in the real CLI entrypoint). Used for the
   *  GitHub connector, `dbt run`, and the `duckdb -json` count/describe queries. `env`
   *  entries are overlaid on the process environment for that one command — used to scope
   *  the multiprocessing-lock workaround to dbt alone (see sitecustomize.py). */
  run: (cmd: string[], env?: Record<string, string>) => Promise<RunResult>
  /** Read a file's raw bytes off disk (manifest.json, a mart's parquet artifact). */
  readFile: (path: string) => Promise<Uint8Array>
  /** Upload one object (mart parquet or sidecar JSON) to R2. */
  upload: (key: string, bytes: Uint8Array) => Promise<void>
  /** Delete one object from R2. Used to retire a mart's stale sidecar before rewriting it
   *  (see `publishMart`) and to reap marts the dbt project no longer declares. Must treat
   *  an already-absent key as success. */
  remove: (key: string) => Promise<void>
  /** List object keys under a prefix — the input to orphan reaping. */
  list: (prefix: string) => Promise<string[]>
  /** Read one environment variable — the input to each connector's `requiredEnv` check.
   *  Injected rather than reading `process.env` directly so the skip/run decision is
   *  testable without mutating the test process's environment. */
  env: (name: string) => string | undefined
  /** The mart's freshness stamp — the time THIS materialize run produced it, not an
   *  inferred file mtime (mart-contract.ts). */
  now: () => string
  /** Connector list override — defaults to the declared CONNECTORS registry. Tests use this
   *  to exercise the framework without depending on the shipped GitHub sample. */
  connectors?: Connector[]
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

async function run(
  deps: MaterializeDeps,
  cmd: string[],
  step: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  const result = await deps.run(cmd, env)
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
    // dbt's `data_type` is free-form author text validated against nothing, and it is
    // simply absent (null) whenever schema.yml omits it — so without this check the value
    // reaches MartSidecarSchema as `undefined`/`'bigint'`/`'INTEGER'` and surfaces as a raw
    // ZodError naming a numeric column index and no mart. Uppercase first (dbt authors
    // routinely write lowercase types), then name the accepted vocabulary in the error, so
    // the most common schema.yml mistake gets the same quality of message the description
    // checks above already produce.
    const declared = (col.data_type ?? '').trim().toUpperCase()
    const parsedType = MartColumnTypeSchema.safeParse(declared)
    if (!parsedType.success) {
      throw new Error(
        `materialize: mart "${node.name}" column "${col.name}" declares data_type ` +
          `"${col.data_type ?? '(none)'}" in schema.yml, which this mart contract does not accept. ` +
          `Use one of: ${MartColumnTypeSchema.options.join(', ')}.`,
      )
    }
    return {
      name: col.name,
      type: parsedType.data,
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
/** dbt hands us `config.location` as free text from the consumer's own model config, and it
 * goes into a single-quoted DuckDB string literal below. A `'` in that value would break out
 * of the literal into a CLI that can read and write the filesystem (`COPY … TO`, `read_text`,
 * `INSTALL`). Today the value is config-controlled rather than request-controlled, but the
 * template encourages setting config via `workerVars`, so this is one wiring change away from
 * being externally influenced — validate rather than rely on that staying true. */
const SAFE_PARQUET_PATH_RE = /^[A-Za-z0-9._/-]+$/

function assertSafeParquetPath(martName: string, parquetPath: string): void {
  if (!SAFE_PARQUET_PATH_RE.test(parquetPath)) {
    throw new Error(
      `materialize: mart "${martName}" has an unsafe config.location ("${parquetPath}") — ` +
        'only letters, digits, and . _ - / are allowed',
    )
  }
}

/** Where the raw layer lives, resolved ONCE here and handed to both halves of the run.
 *
 * This is deliberately not read independently by the connector and by dbt. They must agree
 * exactly — dbt reads back what dlt just wrote — and two sides each deriving a location from
 * overlapping env vars is precisely how they silently stop agreeing (dbt reading a stale
 * local `./raw` while dlt writes to R2 would rebuild yesterday's mart and stamp it fresh,
 * which is the failure `extracted === 0` further down exists to prevent in the other
 * direction). So: computed here, exported as WAREHOUSE_RAW_URL, injected into the connector
 * step and the dbt step from the same variable.
 *
 * Durable (R2) whenever the bucket is configured — which is always, in a deployed container,
 * since materialize.ts's entrypoint refuses to start without it. The `file://`-less local
 * fallback keeps `python3 connectors/github.py` runnable standalone on a laptop with no R2
 * credentials, which is how the connector is developed. */
function resolveRawUrl(deps: MaterializeDeps): string {
  const bucket = deps.env('WAREHOUSE_BUCKET_NAME')
  return bucket ? `s3://${bucket}/raw` : (deps.env('WAREHOUSE_RAW_DIR') ?? './raw')
}

/** As SAFE_PARQUET_PATH_RE, plus the `s3://` scheme the durable raw layer needs. Same
 * threat: WAREHOUSE_RAW_URL is interpolated into a single-quoted DuckDB string literal in
 * the staging model, so a `'` in the bucket name would escape into arbitrary SQL. Bucket
 * names come from an instance file rather than a request, but so did WAREHOUSE_RAW_DIR. */
const SAFE_RAW_URL_RE = /^(s3:\/\/)?[A-Za-z0-9._/-]+$/

function assertSafeRawUrl(rawUrl: string): void {
  if (!SAFE_RAW_URL_RE.test(rawUrl)) {
    throw new Error(
      `materialize: raw location ("${rawUrl}") is interpolated into dbt SQL and must be a ` +
        'plain path or s3:// URL containing only letters, digits, and . _ - / — check ' +
        'WAREHOUSE_BUCKET_NAME / WAREHOUSE_RAW_DIR on the warehouse instance',
    )
  }
}

/** Directory env vars that dbt models interpolate DIRECTLY into DuckDB string literals
 * (`read_parquet('{{ env_var("WAREHOUSE_RAW_DIR") }}/...')` in the staging model, and the
 * `location=` config on every external mart model). A `'` in either escapes the literal into
 * a DuckDB session that can `COPY … TO`, `read_text`, and `INSTALL`/`LOAD` — i.e. arbitrary
 * container filesystem read/write, and a forged row in a published mart that passes every
 * downstream schema check because its column names and types are unchanged.
 *
 * This has to run BEFORE the dbt step. `assertSafeParquetPath` validates `config.location`
 * too, but it reads that value out of the manifest dbt produces — by which point dbt has
 * already executed the injected SQL, so it cannot prevent this, only notice afterwards. */
const DBT_PATH_ENV_VARS = ['WAREHOUSE_RAW_DIR', 'WAREHOUSE_MART_DIR'] as const

function assertSafeDbtPathEnv(deps: MaterializeDeps): void {
  for (const name of DBT_PATH_ENV_VARS) {
    const value = deps.env(name)
    if (value !== undefined && !SAFE_PARQUET_PATH_RE.test(value)) {
      throw new Error(
        `materialize: ${name} is interpolated into dbt SQL and must contain only letters, ` +
          `digits, and . _ - / — refusing to run dbt with ${name}="${value}"`,
      )
    }
  }
}

/**
 * Remove dbt-duckdb's empty-relation sentinel row.
 *
 * `external.sql` (dbt-duckdb 1.10.1) does this deliberately:
 *
 *     -- if relation is empty, write a non-empty table with column names and null values
 *     {% if row_count[0][0] == 0 %} insert into {{ temp_relation }} values (NULL, …) {% endif %}
 *
 * So a mart that legitimately has no rows ships as ONE row of all-NULLs. Upstream's reason
 * is to keep column names in the file, but for this pipeline it is a data-correctness bug:
 * the mart-read API would serve that row, a consumer would read it as a real record, and the
 * sidecar's rowCount would say 1. Empty has to mean empty.
 *
 * Detected narrowly — exactly one row, every declared column NULL — which is precisely the
 * sentinel's shape, so a real single all-NULL record (already meaningless, and impossible
 * here since the mart's key columns are non-nullable) is the only false positive available.
 * Rewrites via a temp file because DuckDB cannot COPY over a file it is reading.
 */
async function stripEmptySentinelRow(
  deps: MaterializeDeps,
  columns: MartColumn[],
  parquetPath: string,
): Promise<void> {
  const allNull = columns.map((c) => `"${c.name}" is null`).join(' and ')
  const probe = await run(
    deps,
    [
      'duckdb',
      ':memory:',
      '-json',
      '-c',
      `select count(*) as total, count(*) filter (where ${allNull}) as blanks from read_parquet('${parquetPath}')`,
    ],
    `sentinel probe for ${parquetPath}`,
  )
  const [row] = parseDuckdbJson(probe.stdout, `sentinel probe for ${parquetPath}`) as Array<{
    total: number
    blanks: number
  }>
  if (Number(row?.total) !== 1 || Number(row?.blanks) !== 1) return

  const tmpPath = `${parquetPath}.compacted`
  await run(
    deps,
    [
      'duckdb',
      ':memory:',
      '-c',
      `copy (select * from read_parquet('${parquetPath}') where not (${allNull})) to '${tmpPath}' (format parquet)`,
    ],
    `strip empty sentinel from ${parquetPath}`,
  )
  await run(deps, ['mv', tmpPath, parquetPath], `replace ${parquetPath}`)
  console.log(`materialize: stripped dbt-duckdb's empty-relation sentinel row from ${parquetPath}`)
}

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
  const rows = parseDuckdbJson(result.stdout, `row count for ${parquetPath}`) as Array<{
    n: number
  }>
  return Number(rows[0]?.n ?? 0)
}

/** duckdb's `-json` output is the only thing we parse from a CLI, and a stray notice on
 * stdout (extension autoload, a warning) turns `JSON.parse` into a bare SyntaxError naming
 * nothing. Wrap it so the failure says which step produced the unparseable output. */
function parseDuckdbJson(stdout: string, step: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(
      `materialize: ${step} produced output that is not JSON: ${stdout.slice(0, 300)}`,
    )
  }
}

/** The check that makes the declared schema mean something. `buildSidecar` derives columns
 * purely from dbt's manifest (i.e. from schema.yml); nothing else ever looks at the parquet
 * dbt actually wrote. ADR-0004's central claim is "a mart is not a mart without its declared
 * column schema" — declaring it is not the same as it being TRUE, and the two drift the first
 * time someone edits a model's SELECT without editing its schema.yml (or vice versa). A
 * declared column absent from the data is the worse direction: any consumer generated from
 * the contract breaks at runtime on a column that never existed. */
async function assertSidecarMatchesParquet(
  deps: MaterializeDeps,
  sidecar: MartSidecar,
  parquetPath: string,
): Promise<void> {
  const result = await run(
    deps,
    ['duckdb', ':memory:', '-json', '-c', `describe select * from read_parquet('${parquetPath}')`],
    `describe ${parquetPath}`,
  )
  const described = parseDuckdbJson(result.stdout, `describe ${parquetPath}`) as Array<{
    column_name: string
    column_type: string
  }>

  const actual = described.map((c) => c.column_name)
  const declared = sidecar.columns.map((c) => c.name)

  const missing = declared.filter((name) => !actual.includes(name))
  const undeclared = actual.filter((name) => !declared.includes(name))
  if (missing.length > 0 || undeclared.length > 0) {
    throw new Error(
      `materialize: mart "${sidecar.name}" schema.yml does not match the parquet dbt wrote` +
        (missing.length > 0 ? `; declared but absent from the data: ${missing.join(', ')}` : '') +
        (undeclared.length > 0
          ? `; present in the data but undeclared: ${undeclared.join(', ')}`
          : ''),
    )
  }

  // Types too — a column declared VARCHAR that DuckDB wrote as BIGINT is a contract a
  // consumer will trust and be wrong about. Compared case-insensitively against DuckDB's
  // own spelling (it reports `bigint`/`varchar`/`timestamp` lowercase).
  const actualTypes = new Map(described.map((c) => [c.column_name, c.column_type.toUpperCase()]))
  const mismatched = sidecar.columns
    .filter((c) => {
      const got = actualTypes.get(c.name)
      return got !== undefined && got !== c.type
    })
    .map((c) => `${c.name} (declared ${c.type}, actual ${actualTypes.get(c.name)})`)
  if (mismatched.length > 0) {
    throw new Error(
      `materialize: mart "${sidecar.name}" declares column types that do not match the parquet: ${mismatched.join('; ')}`,
    )
  }
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
  assertSafeDbtPathEnv(deps)

  const rawUrl = resolveRawUrl(deps)
  assertSafeRawUrl(rawUrl)
  console.log(`materialize: raw layer at ${rawUrl}`)

  await run(deps, ['mkdir', '-p', 'marts'], 'ensure marts directory')

  // Every declared connector, in order (container/connectors.ts). A connector whose required
  // env is missing is SKIPPED, not failed: a project that scaffolded this template and never
  // wired GitHub should not get a daily failing cron for a sample it doesn't use.
  //
  // NORMALIZE__WORKERS=1 makes dlt's normalize step resolve pool_type to "none" instead of
  // its default "process". That matters on Cloudflare's Firecracker runtime, where there is
  // no working /dev/shm and any POSIX-semaphore-backed multiprocessing primitive raises
  // FileNotFoundError the moment it is constructed — so a real ProcessPoolExecutor would
  // fail there regardless. Pinning it makes single-process extraction an explicit invariant
  // rather than something that currently holds only because this connector's row count
  // happens to keep dlt on its single-threaded map path.
  const declared = deps.connectors ?? CONNECTORS
  let extracted = 0
  for (const connector of declared) {
    const missing = connector.requiredEnv.filter((name) => !deps.env(name))
    if (missing.length > 0) {
      console.log(
        `materialize: skipping connector "${connector.name}" — missing ${missing.join(', ')}`,
      )
      continue
    }
    await run(deps, ['python3', connector.script], `connector "${connector.name}"`, {
      NORMALIZE__WORKERS: '1',
      WAREHOUSE_RAW_URL: rawUrl,
    })
    extracted++
  }

  // Skipping connectors is fine; skipping EVERY connector while still publishing is not. In
  // a warm container `./raw` still holds the previous run's extract, so dbt happily rebuilds
  // the identical mart and we would stamp it with a fresh `generatedAt` and upload — a mart
  // that reports itself as current forever while no new data has been fetched since the
  // config broke. (In a cold container the same path fails on missing raw input instead, so
  // the symptom depends on scheduling, which is worse.) Freshness must mean "an extract
  // happened", so refuse rather than republish.
  if (declared.length > 0 && extracted === 0) {
    throw new Error(
      `materialize: every declared connector was skipped (${declared
        .map((c) => c.name)
        .join(', ')}) — refusing to republish marts with a fresh timestamp when nothing was ` +
        'extracted. Configure at least one connector, or remove the unused ones from ' +
        'container/connectors.ts.',
    )
  }

  // WAREHOUSE_PATCH_MP_LOCKS is read by sitecustomize.py and set for THIS command only —
  // dbt is the one tool here that needs the multiprocessing-lock workaround, and the one
  // for which it is provably safe (it never spawns a real process). See sitecustomize.py.
  await run(deps, ['dbt', 'run', '--project-dir', 'dbt', '--profiles-dir', 'dbt'], 'dbt run', {
    WAREHOUSE_PATCH_MP_LOCKS: '1',
    WAREHOUSE_RAW_URL: rawUrl,
  })

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

    assertSafeParquetPath(node.name, location)

    // Before counting: dbt-duckdb writes an all-NULL placeholder row for an empty mart, so
    // the count (and the published data) would otherwise report one phantom record.
    const declaredColumns = buildSidecar(node, 0, deps.now()).columns
    await stripEmptySentinelRow(deps, declaredColumns, location)

    const rowCount = await countRows(deps, location)
    const sidecar = buildSidecar(node, rowCount, deps.now())
    await assertSidecarMatchesParquet(deps, sidecar, location)

    const parquetBytes = await deps.readFile(location)

    // Publish order is deliberate: RETIRE the old sidecar, then write the parquet, then
    // write the new sidecar. The obvious order (parquet, then sidecar) is what makes a
    // failed sidecar upload leave TODAY'S parquet described by YESTERDAY'S sidecar — the
    // reader finds both objects, returns 200, and every consumer gets a stale rowCount and
    // a columns list that no longer matches the data. That is silently wrong, which is
    // strictly worse than missing. Deleting the sidecar first means any failure from here
    // on leaves the mart with no sidecar at all, which `readMart` already treats as absent
    // — the documented "a partial write reads as absent" behaviour, now true on every
    // write rather than only the first one. Cost: the mart is briefly unreadable mid-run.
    await deps.remove(martSidecarKey(sidecar.name))
    await deps.upload(martKey(sidecar.name), parquetBytes)
    await deps.upload(
      martSidecarKey(sidecar.name),
      new TextEncoder().encode(JSON.stringify(sidecar)),
    )

    marts.push(sidecar.name)
  }

  // A dbt project that declares no external models means the consumer has deleted the
  // sample marts and not yet written their own — or a selector silently matched nothing.
  // Returning `{marts: []}` with exit 0 is indistinguishable from a healthy run that
  // published everything, especially on the cron path where nobody reads stdout.
  if (marts.length === 0) {
    throw new Error(
      'materialize: dbt produced no external (mart) models — nothing to publish. Declare at ' +
        "least one model with materialized='external' under dbt/models/marts/.",
    )
  }

  await reapOrphanedMarts(deps, marts)

  return { marts }
}

/** Delete mart artifacts the dbt project no longer declares. Without this, removing a model
 * leaves its parquet + sidecar in R2 forever and `GET /marts/<name>` keeps returning 200
 * with data frozen at the last successful run — a mart that no longer exists still serving
 * confidently stale answers. Runs only after every mart published successfully, so a failed
 * run never reaps. */
async function reapOrphanedMarts(deps: MaterializeDeps, published: string[]): Promise<void> {
  const live = new Set(published)
  const keys = await deps.list('marts/')
  for (const key of keys) {
    const name = key.replace(/^marts\//, '').replace(/\.(parquet|schema\.json)$/, '')
    if (name !== key && !live.has(name)) {
      await deps.remove(key)
    }
  }
}

if (import.meta.main) {
  // Fail before the extract, not after it. These four arrive from the Worker's env via
  // containerExec (worker/materialize-dispatch.ts), which defaults each to '' — so a deploy
  // that never wired them up would otherwise run the full dlt + dbt pipeline and only die
  // at the final upload, burning minutes and a GitHub rate-limit budget to report a
  // configuration mistake that was knowable at startup.
  const REQUIRED_R2_ENV = [
    'WAREHOUSE_R2_ACCESS_KEY_ID',
    'WAREHOUSE_R2_SECRET_ACCESS_KEY',
    'WAREHOUSE_BUCKET_NAME',
    'WAREHOUSE_R2_ENDPOINT',
  ] as const
  const missingEnv = REQUIRED_R2_ENV.filter((name) => !process.env[name])
  if (missingEnv.length > 0) {
    throw new Error(
      `materialize: missing required R2 configuration: ${missingEnv.join(', ')}. ` +
        'These are set on the warehouse instance (workerSecrets/workerVars) and forwarded ' +
        'into the container — see the warehouse app template registry.json instructions.',
    )
  }

  const client = new Bun.S3Client({
    accessKeyId: process.env.WAREHOUSE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.WAREHOUSE_R2_SECRET_ACCESS_KEY,
    bucket: process.env.WAREHOUSE_BUCKET_NAME,
    endpoint: process.env.WAREHOUSE_R2_ENDPOINT,
  })

  const deps: MaterializeDeps = {
    run: async (cmd, env) => {
      const proc = Bun.spawn(cmd, {
        stdout: 'pipe',
        stderr: 'pipe',
        env: env ? { ...process.env, ...env } : undefined,
      })
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
    // An already-absent key is success: `publishMart`'s retire-then-write ordering deletes
    // a sidecar that legitimately may not exist yet on a mart's very first run.
    remove: async (key) => {
      await client
        .file(key)
        .unlink()
        .catch(() => undefined)
    },
    list: async (prefix) => {
      const listed = await client.list({ prefix })
      return (listed.contents ?? []).map((o) => o.key)
    },
    env: (name) => process.env[name] || undefined,
    now: () => new Date().toISOString(),
  }

  const result = await materialize(deps)
  console.log(`materialize: wrote ${result.marts.length} mart(s): ${result.marts.join(', ')}`)
}
