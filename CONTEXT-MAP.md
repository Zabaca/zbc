# Context Map

zbc holds four bounded contexts of its own, and carries a fifth thing that keeps its own. They share a repository and a runtime, not a
vocabulary — the same word means different things on either side of a line, so
each keeps its own glossary.

## Contexts

- [Infrastructure](./CONTEXT.md) — provisions and deploys resources. Modules
  define a resource, instances bind a module to config for one environment,
  `zbc apply` converges them. Spans `packages/cli/` (the CLI and the module
  templates that are its source of truth) and `packages/infra/` (this repo's own
  consumption of them), so it stays at the repository root rather than under a
  single package.
- [Agent](./packages/agent/CONTEXT.md) — runs Claude Agent SDK agents with a
  known token cost and a known blast radius. Lives entirely in
  `packages/agent/`.
- [walgit](./packages/walgit/CONTEXT.md) — a git host whose write-ahead log in
  object storage is the source of truth and whose bare repos on disk are a
  disposable cache. An app template, so its glossary lives with the package and
  ships to any consumer who runs `zbc add walgit`. Note the path is a symlink
  into `packages/cli/templates/apps/walgit/`, which is where the file is edited.
- [agentgit](./packages/agentgit/CONTEXT.md) — the public git host for agents at
  `agentgit.zabaca.com`. One deployment of walgit, plus the client-side pieces
  that only make sense against it. Lives in `packages/agentgit/`.
- [The space](./packages/cli/templates/apps/space/README.md): a small company's
  workspace in one Worker, a vendored app
  ([ADR-0020](./docs/adr/0020-an-app-too-large-to-copy-is-a-subtree-of-its-own-public-copy.md)).
  It is not one context but eight packages, each with a `CONTEXT.md` of its own
  under `packages/cli/templates/apps/space/packages/`, and it ships whole to
  every company that runs `zbc add space`. Its words are its own: an "install"
  there is a company's deployed space, not a module instance.

## Relationships

- **The space → Infrastructure**: the space's kit is handed a project's zbc
  modules (`cloudflare`, `cloudflare-access`, `queue`, `r2`, `d1`) and builds
  its instances from them; it imports none. A module change the kit depends on
  is reviewed here, where both are, and `worker-install-shape.test.ts` in the
  modules holds the shape the kit needs.

- **Agent → Infrastructure**: none yet, and deliberately so. An agent that could
  call `zbc apply` would hold provisioning credentials, which is exactly what the
  Agent context's containment exists to deny it. Any future link is a Custom Tool
  on the host side, never a widened sandbox — see
  [ADR-0001](./packages/agent/docs/adr/0001-coding-agents-work-in-a-disposable-clone.md).
- **agentgit → walgit**: agentgit is one deployment of the walgit mechanism.
  Every capability the service has is instance configuration in
  `packages/infra/environments/production/`, pointed at the walgit package
  unchanged. walgit knows nothing of agentgit, and the rule that keeps it that
  way is **walgit may gain capabilities, never opinions** — a change that cannot
  be expressed as instance configuration does not belong in walgit. The first
  change that genuinely cannot be (per-agent tenancy is the likely candidate) is
  the signal to reconsider the arrangement rather than bend it.
- **walgit → Infrastructure**: walgit is deployed by the `cloudflare` module like
  any other package, and is otherwise independent. Its own terms are not
  Infrastructure terms: walgit's *Index* is a repository's ref state, nothing to
  do with a module registry.
- **Shared vocabulary**: none. Note the collisions rather than trying to
  reconcile them — Infrastructure's *Module* is a resource definition, while the
  Agent context's nearest equivalent is a Profile; Infrastructure's *ephemeral*
  means "destroyed and recreated on every apply", while a Workspace is disposable
  in a different sense (thrown away after one run, never recreated); *Materialize*
  means a `dlt` extract plus `dbt run` in the warehouse and rebuilding a git cache
  from the log in walgit; and *Agent* is a Claude Agent SDK run in one context and
  agentgit's entire audience in another.

## Decisions

- Repository-wide decisions: [`docs/adr/`](./docs/adr/) — including walgit's
  ([ADR-0007](./docs/adr/0007-walgit-object-storage-holds-the-log.md),
  [ADR-0008](./docs/adr/0008-walgit-runs-on-a-cloudflare-container-without-ssh.md),
  [ADR-0009](./docs/adr/0009-walgit-ref-events-are-latest-state.md),
  [ADR-0010](./docs/adr/0010-walgit-shared-kernel.md),
  [ADR-0011](./docs/adr/0011-walgit-records-who-pushed-and-refuses-nothing.md),
  [ADR-0018](./docs/adr/0018-a-proposal-is-a-ref-and-merged-is-ancestry.md)),
  which stay at the root because they were taken here and predate the split.
- Agent-context decisions: [`packages/agent/docs/adr/`](./packages/agent/docs/adr/)
