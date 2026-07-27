# zbc

Zabaca's infrastructure-as-code system: modules provision/deploy resources, instances bind a module to config for one environment.

## Principles

**Single-tenant everything**:
zbc is open source; consumers fork the repo or install just the CLI. Either way, every consumer instantiates their own copy of modules, app templates, and any supporting services (relay workers, inboxes, …). There is no centralized Zabaca-hosted service in the loop.

**Scaffold freely, deploy only through the graph**:
CLI commands may automate as much as they like (vendor modules, copy templates, even generate instance files) — but everything they do must land as committed declarative files, and real-world convergence happens only via `zbc apply`. A fresh clone plus `zbc apply` must reproduce the world.

## Language

**Provisioning Module**:
A module whose `index.ts` fully owns a resource's definition — the config it receives is the complete spec, with no external topology file. `turso` is a provisioning module.
_Avoid_: thick module

**Secret Request**:
A blocking ask, initiated from the CLI (typically by an agent), for a human to supply one or more secret values for a target environment's encrypted secrets file. The requester never sees the values — only whether they arrived.
_Avoid_: secret prompt, secret ask

**Secret Relay**:
The project's own permanent worker that brokers a Secret Request between the CLI and the human's browser. One per project (single-tenant); it carries only ciphertext.

**Channel**:
A single-use, time-limited conduit on the Secret Relay created for one Secret Request. Dies on first submission or expiry.

**Pairing Code**:
A short human-checkable code shown by both the CLI and the browser page so the human can confirm they're answering the request they think they are.

**Deploy Module**:
A module that only orchestrates build+deploy against topology the *consuming package* defines itself (e.g. its own `wrangler.jsonc`, `Dockerfile`). The module doesn't know the shape of what it's deploying. `cloudflare` is the only deploy module.
_Avoid_: thin module

**App Template**:
A `kind: "app"` template that scaffolds a full package into the consumer's `packages/<name>/` — real application code (worker routes, business logic), not just a resource's config schema. Declares its module dependencies in `registry.json`, which `zbc add <app>` auto-vendors. `inbox`, `secret-relay`, and `warehouse` are app templates.
_Avoid_: app module (conflates with Provisioning/Deploy Module, which own only a resource's config, not a scaffolded package)

## Data Warehouse (ADR-0004)

**Warehouse**:
A project's analytical store — the Raw Layer and the Mart parquet files, both under its own R2 bucket. Storage, not a server: DuckDB is a stateless query engine that reads those files inside the container, never a durable file the container keeps on disk.
_Avoid_: "the DuckDB", "the database"

**Connector**:
A declared `dlt` source that lands raw data for one materialize run, run one-shot inside the container. Its third-party secret lives in the environment's `secrets.yaml` and is injected only into that one materialize invocation, never into the Worker's general runtime.
_Avoid_: source (ambiguous with dbt's `source()`), integration

**Raw Layer**:
Append-only parquet under the bucket's `raw/` prefix, written by Connectors through dlt's filesystem destination and read back by dbt over `s3://`. Durable, so a Connector extracts only what changed since its last run — the **Cursor** dlt persists beside the data is what survives the container sleeping, and restoring it is the entire mechanism. Distinct from a Mart: raw is unshaped, unverified, never served.
_Avoid_: staging (means a dbt model layer here), landing zone

**Cursor**:
A Connector's incremental position, persisted by dlt to `_dlt_pipeline_state` in the Raw Layer and restored on every cold container. Durable in both directions: a **bad** cursor is equally permanent, and editing `initial_value` in connector code does not move one that already exists.

**Mart**:
The published unit of meaning — exactly one parquet artifact with a declared column schema and freshness stamp, never inferred. Materialized by dbt-duckdb's `external` materialization; read two ways — DuckDB inside the container, and a pure-JS parquet reader at the edge behind the mart-read API.
_Avoid_: report, dataset, table

**Mart Contract**:
The zod-defined shape (name, description, typed+described columns, `generatedAt`, `rowCount`) written as a sidecar JSON next to a mart's parquet file, derived from dbt's own `schema.yml`/`manifest.json`/`catalog.json` after a run. A mart without its sidecar isn't a mart — a partial write reads as absent.

**Materialize**:
One `dlt` extract + `dbt run` pass inside the warehouse container, triggered by the Worker's own Cloudflare Cron Trigger. No daemon, no Dagster, no external scheduler.
