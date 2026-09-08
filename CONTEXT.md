# Infrastructure

Zabaca's infrastructure-as-code system: modules provision/deploy resources, instances bind a module to config for one environment.

One of four contexts — see [`CONTEXT-MAP.md`](./CONTEXT-MAP.md). This glossary stays at the root because the context spans `packages/cli/` and `packages/infra/`. The vocabulary below does not apply to `packages/agent/`, `packages/walgit/` or `packages/agentgit/`, each of which keeps its own.

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

**Import**:
A typed reference from one Instance to another in the same environment. The engine applies the imported Instance first and hands its outputs to the importer through the context — `ctx.output({ from, output }, field)` — which is the only way a Module learns another Module's result. A Module never reads another Module's resource directly. At destroy time the same call still answers: a full-environment destroy applies the imported Instance on demand — only if the destroy asks, and only because the same run tears it down again afterwards. A targeted destroy refuses, since the Instance it would create is shared infra nothing in that run would remove.
An output is a string when read with `ctx.output` — what a worker secret, a `--var` or a binding field needs — and any shape when read with `ctx.outputValue`, for the outputs whose shape is the point (`nameServers: string[]`). Absence fails identically either way.
_Avoid_: dependency (says nothing about outputs flowing), link

**Binding**:
A named handle a Worker reads a resource through (`env.DB`, `env.RAW`), declared in the consuming package's own `wrangler.jsonc`. Its *identifier* — `database_id`, `bucket_name`, a queue name — is not the package's business: the `cloudflare` module's `bindings` config fills it in from an **Import**'s outputs before deploy, by patching a throwaway copy of that file. The declaration must already exist; zbc supplies the identifier, never the binding. See [ADR-0014](./docs/adr/0014-a-binding-is-filled-in-by-the-deploying-module.md).
_Avoid_: env var (a binding is not in the environment — that is `workerSecrets`/`workerVars`), resource reference

**Readiness Probe**:
A Module's declaration of what proves its just-applied resource *usable*, as opposed to merely created — `ready: { proves, probe }`. The engine holds that Instance's outputs at every **Import** edge until the probe succeeds, retrying while it throws or returns `false`. It belongs to the Module, not the engine, because readiness is a claim about the capability the importer is about to exercise: a Cloudflare token answers `/tokens/verify` long before it may act on the scope it was granted. An Instance nothing imports is never probed. See [ADR-0013](./docs/adr/0013-readiness-is-a-precondition-of-the-imports-edge.md).
_Avoid_: health check (says nothing about which capability), retry loop (the retrying is the least interesting part)

**Action**:
A named verb a Module declares beside `apply`/`destroy` for something an operator does to one Instance, once, on purpose — registering a domain, rotating a key. Run only by `zbc run <env> <instance> <action>`, never by `zbc apply` or `zbc destroy`, and it emits nothing: an Instance's outputs are its `apply`'s. One marked `irreversible` is refused without `--yes`, before anything is applied. Its **Import**s resolve as a full-environment destroy's do — applied when the body asks — except for an irreversible one, whose imports are applied before it starts so the body is never re-entered. See [ADR-0017](./docs/adr/0017-a-third-verb-and-a-value-typed-imports-edge.md).
_Avoid_: task, script, command (an action is not a shell entry point — the whole point is that it is inside the graph, the secrets and the imports edge)

**Ephemeral**:
An Instance the engine destroys and re-applies on every `zbc apply`, so each run starts from a clean resource. A property of the Instance, not of the Module — any Module with a `destroy` can be ephemeral, and an Instance marked ephemeral whose Module has none is refused before anything is applied. Distinct from `zbc destroy`, which tears down every Instance with a `destroy`, ephemeral or not.
_Avoid_: temporary, disposable (the Agent context's Workspace owns "disposable")

**Shared Library**:
A `kind: "library"` directory under `modules/` holding code the Modules beside it import as `../<name>` — an API envelope, a host `exec` seam, a zod schema fragment — and defining no Module of its own. It has no config, no `apply` and no Instance; `zbc add` installs it like a Module and says so. A Module or Library names the ones it imports in its manifest's `modules` key, and `zbc add` installs that graph first. See [ADR-0015](./docs/adr/0015-a-library-is-a-registry-kind.md).
_Avoid_: core module (the four bundled ones are named `*-core`, but "module" is the thing it is not), util

**Secret Output**:
An Output a Module declares as a *credential* — `secretOutputs: { tokenValue: { rotates: 'each-apply' } }`. It crosses an **Import** edge in memory exactly like any other Output; what changes is everywhere else: the engine replaces the literal with `[redacted: <instance>.<output>]` in the text it prints and throws, and writes `[redacted]` in its place in `zbc apply --json` — by declared key on the minting Instance, and by value everywhere else in that document — so a minted credential does not land on disk. It cannot reach a Module's own logging or a child process's stdio. `rotates` names *who consumes it* — `'each-apply'` (the apply itself, so rolling is free) or `'never'` (a holder outside the apply, so an **Ephemeral** Instance of that Module is refused). See [ADR-0016](./docs/adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md).
_Avoid_: sensitive output (says it should be handled carefully; this says where it may go), ephemeral output (collides with the Instance-level `ephemeral`)

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
_Disambiguate_: walgit uses the same word for rebuilding a git Cache from its Write-Ahead Log — see **Materialize** in [`packages/walgit/CONTEXT.md`](./packages/walgit/CONTEXT.md). The two are unrelated, and a bare "materialize" is ambiguous across the repo: say which subsystem, or name the file (`packages/warehouse/` vs `packages/walgit/src/materialize.ts`).
