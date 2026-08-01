# Context Map

zbc holds two bounded contexts. They share a repository and a runtime, not a
vocabulary — the same word means different things on either side of the line, so
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

## Relationships

- **Agent → Infrastructure**: none yet, and deliberately so. An agent that could
  call `zbc apply` would hold provisioning credentials, which is exactly what the
  Agent context's containment exists to deny it. Any future link is a Custom Tool
  on the host side, never a widened sandbox — see
  [ADR-0001](./packages/agent/docs/adr/0001-coding-agents-work-in-a-disposable-clone.md).
- **Shared vocabulary**: none. Note the collisions rather than trying to
  reconcile them — Infrastructure's *Module* is a resource definition, while the
  Agent context's nearest equivalent is a Profile; Infrastructure's *ephemeral*
  means "destroyed and recreated on every apply", while a Workspace is disposable
  in a different sense (thrown away after one run, never recreated).

## Decisions

- Repository-wide decisions: [`docs/adr/`](./docs/adr/)
- Agent-context decisions: [`packages/agent/docs/adr/`](./packages/agent/docs/adr/)
