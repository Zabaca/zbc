# distribution: consumers stranded on old engines — upgrade

**Consumers:** varnick, ceo, foothill-metabolic (3)
**Severity:** they rebuild features zbc already ships

## What happened

Three consumers are running vendored engine code old enough that they
reimplemented parts of it:

- **varnick** — `vendor/zbc` is a **copy, not a subtree**: `git subtree add`
  could not reach `zbc-core-v0.10.2` at split time (`README.md:50-55`). No
  `zbc update` path exists. Its `src/types.ts` exposes only
  `imports: Record<string, unknown>`, so `ctx.output` never arrived and
  `client-core/index.ts:136-154` is a hand-rolled copy of
  `packages/cli/templates/infra/src/context.ts:63-85` — same shape, same three
  failure cases.
- **ceo** — vendored `packages/infra/src/types.ts:9` also predates
  `ctx.output()`. No module in the repo calls it. Its fail-by-name convention
  (`posthog/index.ts:80`, `vercel/index.ts:148-152`) was invented independently.
- **foothill** — inherited its whole `packages/infra/` tree from `Zabaca/ceo`
  rather than scaffolding it, carrying ceo's engine vintage with it. Its `gcp`
  module is byte-shaped identically to ceo's for that reason.

ADR-0005 makes subtree the standard for new consumers precisely so upstream
changes flow down. For these three it did not, and nothing surfaced that.

## The reverse hazard, from the clean consumers

Of the three subtree consumers, all are clean at module level — 74 of 75
vendored files in agent-lab and cedarpad match an upstream revision at the
correct path, and games matches on all 74.

The one exception in each is `vendor/zbc/VENDORING.md`, which **does not exist
anywhere in zbc's template history** — consumer-authored docs written *inside*
the subtree prefix, and different in each repo. It contains no module or engine
code, so module divergence is genuinely zero. But a `git subtree push` from
either repo would carry that file upstream, which is the mixed-commit hazard
CLAUDE.md warns about, arriving from a direction nobody is watching.

## What it takes upstream

1. Make the vintage visible. A consumer cannot currently tell that its engine
   predates `ctx.output`. `zbc` knows its own version and could say so on every
   apply.
2. Make `zbc update` reachable for copy-mode consumers, or make copy mode
   loudly temporary. varnick's subtree add failed silently enough that the
   consequence only surfaced by writing a duplicate of an engine feature.
3. Consider whether the subtree prefix should refuse consumer-authored files,
   or whether `VENDORING.md` should simply be an upstream file.

## Evidence

- varnick: `README.md:50-55`; `client-core/index.ts:136-154`; vendored `src/types.ts:7-11`
- ceo: vendored `packages/infra/src/types.ts:9`; `posthog/index.ts:80`; `vercel/index.ts:148-152`
- foothill: `packages/infra/package.json:2` (inherited tree)
- clean subtree consumers: 74/75 files match upstream history; `vendor/zbc/VENDORING.md` in agent-lab and cedarpad has no upstream ancestor
