# The warehouse app template runs dlt + dbt-duckdb in a container; marts are parquet-in-R2 with a required schema contract

**Status:** accepted

`zbc add warehouse` scaffolds a data warehouse/BI app template (ported from cedarpad's ADR-0017
design, generalized for any zbc project): a Container-backed Worker running the real `duckdb` CLI
plus a Python venv with `dlt` (extraction) and `dbt-duckdb` (transform). Both the append-only
**raw layer** (`raw/`) and the published **marts** (`marts/`) live as parquet under the project's
own R2 bucket (the `r2` module) — never a durable DuckDB file in the container, since disk is
capped and the container sleeps at 5 minutes idle. Raw being durable is what lets a connector
extract only what changed since its last run: dlt persists its incremental cursor beside the data
and restores it on each cold start. A **materialize**
run (dlt extract → `dbt run`, external-materialized to parquet) is triggered one-shot by the
Worker's own Cloudflare Cron Trigger — no daemon, no Dagster. Marts are read via a bearer-authed
HTTP API that parses parquet at the edge (no container wake for reads); a mart isn't a mart without
its declared column schema + freshness sidecar, derived from dbt's own
`schema.yml`/`manifest.json`/`catalog.json` after a run.

v1 ships the framework plus one working reference connector (GitHub) — not a connector library.
Connector secrets live in the environment's `secrets.yaml` (same SOPS/age model as everything else
in zbc) and are injected only into the one-shot materialize invocation, never into the Worker's
general runtime env.

## Considered options

- **TS-native connectors, no Python** — avoids a second runtime in the container, but reinvents
  incremental-extraction cursors, pagination/retry, and nested-JSON normalization per source by
  hand. Rejected once the scope was set to "full pipeline with built-in connectors" — dlt's value
  is exactly that hand-rolling.
- **Hand-authored SQL/TS mart files, no dbt** — matches what cedarpad actually shipped, avoids a
  second Python tool. Rejected: dbt-duckdb's `external` materialization writes a model straight to
  a declared parquet path (near-zero glue for "one mart = one artifact"), and `schema.yml`'s
  `name`/`description`/`data_type` per column is already the mart contract's shape — building a
  bespoke framework next to a proven one wasn't justified once dlt (Python) was already in scope.
- **Dagster** — a long-running daemon cannot live in a container that sleeps at 5 minutes. dbt's
  own `ref()`/`source()` graph and `--select` cover selective rebuilds without it.
- **Ad-hoc read-only SQL endpoint** — considered for the read surface (query any mart, join marts
  directly). Rejected for v1: a materially bigger security surface than "read one named,
  schema-declared artifact." Named-mart HTTP API only.
- **Connector secrets on the whole Worker** (`workerSecrets`) — rejected: anything reachable on the
  deployed Worker (e.g. the mart-read API) would then run in a process holding third-party tokens.
  Secrets scope to the materialize invocation only.

## Consequences

- The container image carries two runtimes (Bun for the Worker/orchestration, Python + `uv` for
  `dlt`/`dbt-duckdb`) — a bigger image, and Docker + a Workers Paid plan with Containers enabled
  are apply-time requirements (same as any Container-backed `cloudflare` module instance).
- `INT64`/`TIMESTAMP` columns need the same JSON-safety coercion at the mart-read boundary that
  cedarpad's ADR-0017 identified (`BigInt` doesn't `JSON.stringify`; `Date` needs `toISOString()`).
- Extraction (the GitHub connector, and any future connector) only ever runs inside a materialize
  invocation — a request to the mart-read API can't reach connector secrets even if that API were
  compromised. **Caveat found during implementation:** this is a code-path guarantee, not a
  process-isolation one. Unlike cedarpad's two-container split (a chat-turn container that never
  holds extraction secrets, and a separate warehouse container that does), zbc's `cloudflare`
  module deploys one Worker with one `workerSecrets` channel — `GITHUB_TOKEN` is structurally
  present in the same Worker env object as everything else, just never read outside
  `containerExec`. A compromise of the Worker's own JS runtime (not just the mart-read route)
  could still reach it. Closing that gap fully would need a second, secret-scoped deploy target,
  which is more surface than this ADR's scope covers.
- Ingestion beyond the one reference connector is deliberately out of v1 scope; each additional
  connector is real per-provider work (auth flow, pagination, rate limits) independent of the
  warehouse's own design.
- **Raw is durable, under the bucket's own `raw/` prefix** (amended — v1 shipped raw as
  container-local, which meant every run re-extracted in full and raw history was
  unrecoverable if a transform was later found wrong). dlt's filesystem destination writes
  `s3://<bucket>/raw` directly and dbt reads it back over DuckDB's `httpfs`; the container's
  disk holds nothing that must survive. Raw growth is now proportional to *change volume*
  rather than *run count*, which is what makes an unbounded-looking append-only layer
  bounded in practice.

  The load-bearing part is not the parquet — it is dlt's **cursor**. `_dlt_pipeline_state`
  lands beside the data, and `pipeline.run()` restores it on every cold container; that
  restore is the whole mechanism behind incremental extraction. Keeping raw parquet while
  leaving state on the container's disk would have paid the storage cost for none of the
  saving, since every run would still re-extract from scratch.

  Verified end-to-end against a real R2 bucket, not just unit tests: a cold run landed 18
  rows and advanced the cursor; a second cold container restored it and extracted **nothing**
  (dlt's own `unique_hashes` drops the rows GitHub returns twice, since `since` is
  inclusive); resetting the cursor re-extracted all 18 alongside the originals, and the mart
  still published exactly 18 distinct issues.
- **Raw is append-only, so the mart layer must deduplicate.** `write_disposition: "append"`
  is what makes raw a history rather than a mirror of the current state; the same issue lands
  once per run that touched it. `stg_github_issues.sql` keeps the newest row per `issue_id`,
  tie-broken on `_dlt_load_id`. Two traps: dlt's parquet normalizer omits `_dlt_load_id` by
  default (`add_dlt_load_id=False`, unlike the model normalizer) so it must be turned on
  explicitly, and switching the disposition to `merge` would look like it fixed the
  duplicates while doing nothing — the filesystem destination silently falls back to append.
- **`union_by_name := true` is mandatory when reading the raw glob.** Raw spans files written
  months apart and their schemas diverge as GitHub adds response fields. Measured on duckdb
  1.5.5: the default `read_parquet` binds to the *first* file's schema and **silently drops**
  a column present in every other file — no error, no warning, the data simply isn't there.
  A loud failure would be safe; this isn't.
- **Raw schema drift has two shapes, and only one of them is handled quietly.** A *new*
  column is absorbed: `union_by_name` fills it with NULL for older files, and since the
  staging model selects columns explicitly, the mart is unaffected. A *type change* for an
  existing column name is different — measured on duckdb 1.5.5, `union_by_name` silently
  promotes the conflict to VARCHAR (a BIGINT `5` becomes the string `"5"`), with no error.
  Nothing in the raw layer objects to this.

  **The staging layer is where that is handled, by casting every column explicitly** — the
  reason a staging layer exists at all. `stg_github_issues.sql` casts all eleven columns, not
  just the timestamps that originally needed it, so the mart's types are *declared* rather
  than inherited from whatever type raw happened to hold on the day a file was written. It
  uses `cast`, never `try_cast`: a recoverable drift is recovered (`'5'` → `5`, an ISO string
  → the right instant) and an unrecoverable one aborts the run naming the column and the
  offending value, where `try_cast` would produce a mart full of silent NULLs that satisfies
  every downstream check. Verified end-to-end against a real bucket by injecting a
  type-drifted raw file: recoverable drift republished a correct 18-row mart with
  `comment_count` back to int64, and an unconvertible `'many'` failed with
  `Conversion Error: Could not convert string 'many' to INT64 when casting from source column
  comments`, leaving the previous mart intact.

  The mart contract's type verification remains as the backstop behind it (a column the
  staging model forgets to cast, or casts to something `schema.yml` does not declare, still
  cannot publish) — defence in depth rather than the only guard, which is what it briefly was
  when raw first became durable. (dlt's own schema evolution likely avoids producing the
  conflict at all, by emitting a variant column rather than retyping one; that behaviour is
  *assumed here, not verified*, which is why neither guard leans on it.)
- **A durable cursor is durable when it is wrong, too.** Found the hard way: GitHub answers
  `200` with an empty array for a `since` at or before the Unix epoch
  (`1970-01-01T00:00:00Z` → 0 issues, `1971-01-01T00:00:00Z` → 18), so the obvious spelling
  of "extract everything" means "extract nothing". Worse, that value then persisted as the
  cursor and could never advance — a self-perpetuating dead pipeline reporting success daily,
  with the empty-table bootstrap (below) dutifully covering for it. The initial floor is now
  `2008-01-01T00:00:00Z` (GitHub predates no issue), but the general lesson outlives the
  specific bug: **editing `initial_value` in connector code does not move a cursor that
  already exists.** Resetting one means deleting `raw/<dataset>/_dlt_pipeline_state/`, which
  is safe — raw data is left intact and the next run simply re-extracts and dedupes.
- **The empty-table bootstrap masks a broken first extract.** `_ensure_issues_table_exists`
  exists so a genuinely issue-less repo doesn't fail the run on a missing `read_parquet`
  glob, and it cannot distinguish that from an extract that returned nothing because it was
  misconfigured. Both publish a legitimate-looking 0-row mart. Kept, because failing a quiet
  repo's nightly cron is worse, but it is the reason the epoch bug above survived several
  runs looking like a success.
- **The R2 credentials must be spelled two different ways in the same file**, and this is not
  duplication to be refactored away: dlt's filesystem destination binds them to its own
  `AwsCredentials` config (`aws_access_key_id`/`aws_secret_access_key`/`endpoint_url`), while
  fsspec's `S3FileSystem` — used directly for the empty-table bootstrap — takes
  `key`/`secret`/`client_kwargs.endpoint_url`. dlt raises `ConfigFieldMissingException` on an
  fsspec-shaped dict because it does not read the alien keys at all. dbt needs a third
  spelling: a `secrets:` entry in `profiles.yml` with `url_style: path`, `region: auto`, and
  a *scheme-stripped* endpoint, since DuckDB's `CREATE SECRET` wants a bare host where every
  other consumer wants a URL.
- **The `/dev/shm` workaround is scoped to dbt, not global.** `container/sitecustomize.py` only
  acts when `WAREHOUSE_PATCH_MP_LOCKS=1`, which `container/materialize.ts` sets on the `dbt`
  invocation alone. This matters because the patch is safe for dbt and *not* safe in general:
  reading dbt-core/dbt-adapters/dbt-duckdb source confirms dbt never creates a real OS process
  (its `threads:` is a `ThreadPool`, and every `mp_context` consumer builds a lock used only for
  cross-thread synchronization), whereas dlt's normalize step defaults to `pool_type="process"`
  and builds a genuine `ProcessPoolExecutor` — into which an unpicklable `threading.RLock` would
  fail loudly. dlt therefore runs unpatched and is pinned to `NORMALIZE__WORKERS=1`, making
  single-process extraction an explicit invariant rather than a property that currently holds
  only because the reference connector's row count keeps dlt on its single-threaded path.
- **Mart publication is ordered retire-sidecar → write-parquet → write-sidecar.** The obvious
  order (parquet then sidecar) makes a failed sidecar upload leave *today's* parquet described by
  *yesterday's* sidecar — served as a confident 200 with a stale `rowCount` and a column list that
  no longer matches the data, which is silently wrong rather than merely missing. Deleting the
  sidecar first means any failure leaves the mart with no sidecar at all, which the reader already
  treats as absent — so "a partial write reads as absent" is true on every write, not just the
  first. The reader additionally rejects a sidecar whose `rowCount` disagrees with the parquet, or
  whose `name` disagrees with its storage key.
- **Timestamps are pinned to UTC in three places, because getting it wrong is invisible.**
  dlt lands timestamps as `TIMESTAMP WITH TIME ZONE`, and DuckDB's cast to `TIMESTAMP`
  resolves against the *session* zone before dropping the offset — so a stray `TZ` rewrites
  every timestamp in every mart while the column names, types, and every schema check stay
  valid, and dbt reports success. Measured: `TZ=America/New_York` shifted values four hours
  off the GitHub API's ground truth. Hence the dbt models cast `at time zone 'UTC'`
  explicitly, the Dockerfile sets `ENV TZ=UTC`, and the Worker blocks `TZ` from crossing into
  the container.
- **A short denylist governs what reaches the container**, not just "everything except
  bindings". Forwarding by convention is what makes connector config cheap to add, but
  `TZ`, `WAREHOUSE_RAW_DIR`, `WAREHOUSE_MART_DIR`, `WAREHOUSE_PATCH_MP_LOCKS`, and
  `NORMALIZE__WORKERS` are pipeline-correctness controls rather than configuration, and an
  instance file must not be able to set them. The two `*_DIR` values are additionally
  validated container-side before dbt runs: they are interpolated straight into DuckDB
  string literals inside dbt models, and a quote in either escapes into arbitrary SQL — a
  forged row landed in a published mart passes every downstream schema check, since its
  column names and types are unchanged. (Validating `config.location` *after* dbt returns,
  which the code already did, cannot prevent this — dbt has executed by then.)
- **An empty mart is genuinely empty.** dbt-duckdb's `external` materialization deliberately
  inserts one all-NULL row when a model produces no rows ("write a non-empty table with
  column names and null values"), so a repo with no issues would publish a phantom record
  that the mart-read API serves as real data. The pipeline detects that exact shape — one
  row, every declared column NULL — and rewrites the artifact as truly empty. Relatedly, a
  connector that lands no rows at all now writes an empty typed table rather than no table,
  since dbt's `read_parquet` otherwise fails the whole run on a legitimate state.
- **The declared schema is verified against the parquet at write time.** Declaring a column schema
  is not the same as it being true: `schema.yml` and a model's `SELECT` drift the first time one is
  edited without the other. Each run `DESCRIBE`s the parquet dbt produced and refuses to publish on
  a missing column, an undeclared column, or a type mismatch. Note this is stricter than cedarpad's
  ADR-0017 implementation, which declares but never verifies.
- **DuckDB extensions must be baked into the image, never installed at runtime.** Reading
  raw over `s3://` needs `httpfs`, which DuckDB does not bundle — `LOAD httpfs` fails with
  "Install it first". dbt-duckdb's `extensions:` block would otherwise `INSTALL` it at
  connection time, i.e. download from extensions.duckdb.org on every cold container. That
  download works under plain Docker and failed on Firecracker, so `dbt run` broke in
  production while the identical image passed locally — and because extraction had already
  written raw to R2 by then, the only symptom was an opaque 502 with the previous marts left
  intact. This is the second instance of the same trap as `/dev/shm` below, which is the
  general rule worth extracting: **anything the container fetches or maps at runtime is
  invisible until deployed.** Verified with `--network none` that the CLI and the Python
  binding both `LOAD httpfs` offline, and that `INSTALL` is a no-op once it is present.
- **Production Containers run on Firecracker microVMs with no working `/dev/shm`** (confirmed via
  `wrangler containers info`'s `runtime: "firecracker"`, and by SSHing into a live instance) —
  every POSIX-semaphore-backed `multiprocessing` primitive raises `FileNotFoundError: [Errno 2]`
  the instant one is constructed. dbt-core hits this unconditionally at startup
  (`dbt/mp_context.py` hardcodes `multiprocessing.get_context("spawn")`, no config override;
  `ConnectionManager.__init__` calls `mp_context.RLock()` before running a single model) — so
  every `dbt run` failed in real production even though the identical image worked under plain
  Docker and `wrangler dev` (both are ordinary Docker, not Firecracker, so this gap is invisible
  until you actually deploy). Fixed by `container/sitecustomize.py`, appended to the base image's
  own `/usr/lib/python3.10/sitecustomize.py` (Python only auto-imports the *first*
  `sitecustomize.py` on `sys.path`, and that one resolves before `dist-packages` — a second copy
  placed there silently never loads): it monkeypatches `multiprocessing.context.BaseContext.RLock`
  to a `threading.RLock`-backed shim. Safe here specifically because dbt's own `threads:` config
  is a `ThreadPoolExecutor`, not real OS processes, so nothing in this container ever needs a
  cross-process primitive. **Anything future work adds to this container that genuinely forks a
  real subprocess needing shared-memory synchronization will hit this same wall** and cannot use
  this workaround.
