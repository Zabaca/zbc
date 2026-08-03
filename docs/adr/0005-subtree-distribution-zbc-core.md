# Consumers vendor zbc as a git subtree of zbc-core, replacing template copies as the standard

Copy-mode distribution (`zbc init`/`zbc add` copying templates into consumer
repos) has a structural flaw this repo already documents: "template changes do
not flow into them automatically" — every scaffolded repo drifts from the
moment it's created. Decided 2026-08-03: the standard consumer flow becomes a
**git subtree** of [Zabaca/zbc-core](https://github.com/Zabaca/zbc-core) at
`vendor/zbc`. zbc-core is a generated split of `packages/cli/templates/infra/`
(engine `src/` + built-in `modules/`), published by CI on every main push and
tagged `zbc-core-v<cli version>`. Updates are `zbc update` (`git subtree pull`
from a tag); contributions are `git subtree push` of prefix-scoped commits.
Consumer-owned modules live **outside** the prefix (`packages/infra/modules/`),
committed normally — the prefix boundary, not gitignore, is what separates
"theirs" from "ours". Apps stay CLI-bundled: the split carries only infra.

## Considered Options

- **Keep copy mode only**: no history in vendored code, upgrades are manual
  diffs, drift permanent. Rejected as the default; kept working (`zbc init`
  without `--subtree`) for consumers who want zero git coupling.
- **npm package for modules**: versioned, but modules become read-only
  dependencies — against the design intent that modules are consumer-editable
  infrastructure code.
- **Subtree of the whole zbc monorepo**: works (foundry does it for authoring)
  but drags design-system, apps, and agent code into every consumer. Rejected
  for consumers; the slim split exists precisely for them.

## Consequences

Consumers must keep commits purely inside or purely outside `vendor/zbc/` —
a mixed commit gets half-split on `subtree push` upstream. `git subtree split`
determinism means CI publishes are fast-forward; rewriting zbc main history
would break that and is now effectively forbidden. The engine exists in two
import shapes (copied `packages/infra/src` vs `vendor/zbc/src`), so engine
changes must stay path-relative. zbc-core is generated — PRs there are closed
on principle; the authoring home stays `packages/cli/templates/infra/`.
