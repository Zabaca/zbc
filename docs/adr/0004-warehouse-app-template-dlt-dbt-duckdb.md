# The warehouse app template runs dlt + dbt-duckdb in a container; marts are parquet-in-R2 with a required schema contract

**Status:** accepted

`zbc add warehouse` scaffolds a data warehouse/BI app template (ported from cedarpad's ADR-0017
design, generalized for any zbc project): a Container-backed Worker running the real `duckdb` CLI
plus a Python venv with `dlt` (extraction) and `dbt-duckdb` (transform). Raw data and marts both
live as parquet under the project's own R2 bucket (the `r2` module) — never a durable DuckDB file
in the container, since disk is capped and the container sleeps at 5 minutes idle. A **materialize**
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
