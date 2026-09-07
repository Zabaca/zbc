# An output reaches a provider config file through the deploying module, not an engine phase

**Status:** accepted (2026-09-07). Extends the Import rule in
[`CONTEXT.md`](../../CONTEXT.md) — `ctx.output` remains the only way a module
learns another module's result, and nothing about the dependency sort,
`ephemeral`, `destroy`, or [ADR-0013](./0013-readiness-is-a-precondition-of-the-imports-edge.md)'s
readiness gate changes. No engine change at all.

The `cloudflare` module gains a general **`bindings`** key:
`{ type, binding, field }` plus a value — either a literal or a
`{ from, output }` reference into an imported instance's outputs. `type` is the
wrangler config key holding the binding array (`d1_databases`,
`kv_namespaces`, `vectorize`, dotted for nested ones like `queues.producers`);
`field` is the key on the matched entry to set. The module patches a generated
copy of the package's wrangler config and deploys it with `--config`.
`r2Bindings` is now sugar over that one code path and keeps working verbatim.

## What was wrong

zbc resolves outputs across `imports` and into `workerSecrets` / `workerVars`.
Both of those reach the **worker's environment**. A binding is not in the
environment — it is a field inside the file wrangler reads at deploy time, and
wrangler has no CLI flag for it. So an output could not reach it.

The consumer survey (`bun scripts/consumer-survey.ts`, #117) found the same
shape four times: four consumers wrote a `d1` module, and **not one closed the
gap it was written for** — every one still hardcodes `database_id` in its
`wrangler.jsonc`, one with a comment explaining why. ceo went further and
provisions R2 two ways inside a single production environment — once through
the `r2` module, once through a `r2Buckets` key on their own copy of
`cloudflare` — because a `wrangler.jsonc` binding pointing at a bucket that
does not exist **fails the deploy**, so they made the bucket inside the same
module run.

Cross-module ordering was never the missing half. `imports` already applies the
provisioning instance first. What was missing is that the config wrangler reads
could not carry the identifier that instance had just produced — so ordering
bought nothing, and the workaround was to collapse the two modules into one.

## The decision

**The deploying module fills the value in, and the identifier crosses the
module boundary the way every other value does: `ctx.output` over an `imports`
edge.** Two consequences follow, and both are the point:

- **`type`/`field` are strings, not an enum of resource types.** The
  alternative — a key per resource type on `cloudflare` (`d1Bindings`,
  `kvBindings`, `queueBindings`, …) — is the thing that is already going wrong:
  per-type keys are how `cloudflare` started absorbing modules that ought to
  compose, and it is why ceo inlined zone and Access config into their copy of
  it. With a general key, shipping `d1` (ZBC-HNDZXY) adds a module and no
  `cloudflare` surface at all.
- **The binding must already be DECLARED in the package's own wrangler config.**
  This only fills in the identifier. Wrangler stays the source of truth for
  worker topology, as it has been since the module was written, and a binding
  no declaration matches is a hard error naming the type and the binding —
  before wrangler runs, so there is no half-deployed worker.

**With `wranglerEnv` set, only that `env.<name>` block is searched.** Wrangler's
binding keys are not inheritable — a `--env preview` deploy reads
`env.preview`'s arrays and ignores the top-level ones — so patching a top-level
declaration and reporting the binding as wired would ship a worker with no such
binding at all, which wrangler answers with a warning and a running worker whose
`env.DB` is `undefined`. That is the exact failure this key exists to prevent,
so a binding declared only at the top level under `wranglerEnv` is an error.

Resolution happens with the other pre-deploy resolutions (`workerVars`,
`workerSecrets`, `apiToken`), so an unresolvable reference fails fast for the
same reason and with the same shape of message.

## What was rejected

**An engine-level pre-deploy phase other modules attach to.** It is the more
general-sounding answer and it is the wrong one here. The engine has two verbs
and a rule about the edge between instances; it does not know what a provider's
config file is, where it lives, or which of its fields is an identifier. A
phase would therefore have to hand a module a callback to do exactly what the
module now does directly — the generality would be in the plumbing rather than
in what anyone can express. (Whether the engine needs more verbs at all is
ZBC-6NYBC9's question, not this one, and this ticket deliberately does not
prejudge it.)

**Provisioning the resource inside `cloudflare`, as ceo did.** It removes the
gap by removing the second module, and it is precisely the absorption this ADR
is trying to stop.

**A shared binding-resolver helper importable by other deploy modules.** `fly`
has the same shape of problem with `fly.toml`. There is no seam for code shared
between modules today — that is ZBC-IWKIES — and inventing one here would put
the decision in the wrong ticket. The resolver stays inside `cloudflare` and
moves when the seam exists.

## Consequences

- `d1` can now ship as an ordinary provisioning module emitting `databaseId`,
  with the worker's instance file wiring it in
  (`{ type: 'd1_databases', binding: 'DB', field: 'database_id', from, output }`).
  Same for KV, Vectorize, Hyperdrive and Queues, with no further change here.
- The generated config is JSON, written next to the original so relative paths
  (`main`, the assets dir) still resolve, and deleted after the deploy. The
  package's own file is never modified; comments do not survive into the copy,
  which nothing reads.
- A binding's identifier is printed on the deploy line. Binding ids are not
  credentials — a bucket name and a database id are both visible in the
  dashboard — but a value that IS sensitive still belongs in `workerSecrets`,
  which is stdin-piped and never logged.
