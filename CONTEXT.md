# Infrastructure

Zabaca's infrastructure-as-code system: modules provision/deploy resources, instances bind a module to config for one environment.

One of two contexts — see [`CONTEXT-MAP.md`](./CONTEXT-MAP.md). This glossary stays at the root because the context spans `packages/cli/` and `packages/infra/`. The vocabulary below does not apply to `packages/agent/`, which keeps its own.

## Principles

**Single-tenant everything**:
zbc is open source; consumers fork the repo or install just the CLI. Either way, every consumer instantiates their own copy of modules, app templates, and any supporting services (relay workers, inboxes, …). There is no centralized Zabaca-hosted service in the loop.

**Scaffold freely, deploy only through the graph**:
CLI commands may automate as much as they like (vendor modules, copy templates, even generate instance files) — but everything they do must land as committed declarative files, and real-world convergence happens only via `zbc apply`. A fresh clone plus `zbc apply` must reproduce the world.

**An app earns a template when most software companies would want it — or when the zbc workflow itself requires it**:
`inbox` and `warehouse` are here because mail and a data warehouse are near-universal needs, not because Zabaca happened to need them. `secret-relay` is the second case: no company wants a relay for its own sake, but every zbc consumer needs one for `zbc secret request` to work at all ([ADR-0003](./docs/adr/0003-secret-request-relay.md)). Anything specific to one project belongs in that project, consuming zbc. This is the test to apply before adding a new `kind: "app"` template — the **App Template** entry below says what one *is*, not what earns one.

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
A `kind: "app"` template that scaffolds a full package into the consumer's `packages/<name>/` — real application code (worker routes, business logic), not just a resource's config schema. Declares its module dependencies in `registry.json`, which `zbc add <app>` auto-vendors. `inbox`, `secret-relay`, and `warehouse` are app templates. What earns a template is the third principle above, not this structural definition.
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

**Materialize** (warehouse sense):
One `dlt` extract + `dbt run` pass inside the warehouse container, triggered by the Worker's own Cloudflare Cron Trigger. No daemon, no Dagster, no external scheduler.
_Disambiguate_: walgit uses the same word for rebuilding a git Cache from its Write-Ahead Log — see **Materialize** under walgit below. The two are unrelated, and a bare "materialize" is ambiguous across the repo: say which subsystem, or name the file (`packages/warehouse/` vs `packages/walgit/src/materialize.ts`).

## walgit (ADR-0007, [ADR-0008](./docs/adr/0008-walgit-runs-on-a-cloudflare-container-without-ssh.md))

`walgit` is a git host where object storage holds the write-ahead log and is the source of truth, and the bare repo on local disk is a disposable cache ([ADR-0007](./docs/adr/0007-walgit-object-storage-holds-the-log.md)). Every term below is a consequence of that sentence, and each names a file under `packages/walgit/src/`. It serves git smart-HTTP — the only transport — from a Cloudflare Container behind a thin Worker ([ADR-0008](./docs/adr/0008-walgit-runs-on-a-cloudflare-container-without-ssh.md)).

**Shared Kernel** (`shared/`):
The runtime-neutral third directory beside `src/` (the container process) and `worker/` (the Cloudflare Worker). Its rule is one sentence — *`shared/` imports no runtime, and both halves may import it* — and it is enforced rather than asserted: `shared/` is the only directory in both TypeScript programs, so a module there is typechecked against bun's ambient types and against the Workers runtime's ([ADR-0010](./docs/adr/0010-walgit-shared-kernel.md)). It holds what both halves have to agree on exactly: the wire contract (`protocol.ts`), credential reading, limit reading and formatting, and the ref-event, telemetry and landing-page logic.
_Avoid_: common, util, lib — none of them says why a module qualifies

**Write-Ahead Log** (the WAL):
The ordered sequence of packfiles under `repos/<repo_id>/wal/`, and the source of truth for a repository. A push is not acknowledged until its entry is published to it. Object storage, not a filesystem and not a database — swappable through one adapter (`store.ts`).
_Avoid_: the bucket (names the backend, not the log), the archive

**Index**:
`index.json` — one object per repository carrying the sequence number, every WAL Entry, the **full ref state**, the Compaction Frontier and outstanding Tombstones. Refs live here rather than in a relational store, which is the point: there is no database to operate. Publishing a push means winning a conditional PUT on this object.
_Avoid_: the manifest, the metadata, the database

**WAL Entry**:
One packfile published to the log, by one push or by one compaction, identified by a monotonic `seq` and content-addressed by its sha256. Uploading a pack does not make it an entry — only the Index naming it does.

**Cache**:
The bare git repo on local disk. Disposable by definition: it can be deleted at any moment and rebuilt from the log, it is reconciled against the Index on every access, and nothing may be served from it that the log has not confirmed. Provisioned by `cache.ts`; git's own housekeeping is disabled on it, because a cache that repacks itself behind the log's back is a cache that disagrees with it.
_Avoid_: the repo (ambiguous with the repository the log describes), the replica, local state

**Reconcile**:
Force the Cache's refs to match the Index. Always one-directional — whatever the disk believes is discarded — and written as a single `packed-refs` file. A ref whose object is absent is reported rather than written: a stale clone is survivable, a broken one is not.

**Materialize** (walgit sense):
Rebuild a Cache from the Write-Ahead Log: download every WAL Entry above the Compaction Frontier, place its pack, then Reconcile. The container sleeps when idle and its disk is wiped on restart, so this is the normal path on ordinary first access after an idle pause, not disaster recovery.
_Disambiguate_: unrelated to the warehouse's **Materialize** above. See that entry.

**Compaction**:
Repack a repository into a single WAL Entry that supersedes everything at or below the sequence number it started from, so a cold Materialize replays one entry however many pushes the repository has taken. A repack, never a rewrite: the history it encodes is identical, object for object, and refs are never touched.

**Compaction Frontier**:
The sequence number at or below which entries are superseded and no longer needed to restore. Materialize downloads from it forward; it only ever advances.

**Lease**:
The per-repository claim a node takes before compacting, so two nodes cannot both repack and both advance the frontier. It expires, because its holder is a process in a container the platform may stop at any moment — a lease only a graceful release could clear would wedge compaction for a repository permanently.

**Tombstone**:
A superseded WAL object recorded in the Index as scheduled for deletion, with the instant before which it must not be deleted. The delay is the whole mechanism: a compaction's compare-and-swap is instantaneous and a restore that read the Index a moment earlier is not.

**Orphan**:
A WAL object under a repository's prefix that the Index does not name — almost always a pack uploaded by a push that then lost the compare-and-swap, since rejecting at `reference-transaction` does not unwind the upload. Discovered by diffing the prefix against the Index rather than recorded at rejection time, and collected only once provably older than the slowest plausible restore.
_Avoid_: garbage (says nothing about why it is there), leaked object
