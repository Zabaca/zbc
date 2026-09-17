# Consumer cases

What zbc's consumers had to build themselves, mined from every repo in
[`../registry.json`](../registry.json) by the `consumer-mining` skill.
Derived — regenerate rather than edit. Evidence lives in `.consumer-survey/`.

**Run:** `bun scripts/consumer-survey.ts`, then the skill's fan-out.
**Last run:** 2026-09-02, 11 consumers, all 7 per-repo agents reporting.

## What the survey found

148 consumer modules → **36 material**. The rest are verbatim copies of zbc's
own code: 37 current, 76 stale. Gate 0 — hashing each consumer module against
every historical revision of its template, normalised — removed 76% of the
corpus, including three of the six `cloudflare` "forks" that a diff against
`main` would have presented as consumer insight.

## Cases

### Fix now — live defects with production incidents behind them

| Case | Consumers | Why now |
|---|---|---|
| [cloudflare](./cloudflare.md) | ceo, foothill | `wrangler secret put` sends `--env` **and** `--name`; wrangler ignores `--name`, so secrets land on a phantom script and exit 0. Two independent production incidents. Two-line fix |
| [cloudflare-token](./cloudflare-token.md) | leeandco | root secret name is hardcoded, so one consumer cannot serve two Cloudflare accounts. Five instances override it |

### Engine — where several consumers converged on the same missing thing

| Case | Consumers | The gap |
|---|---|---|
| [engine-credential-lifecycle](./engine-credential-lifecycle.md) | 4, across 4 providers | a credential minted inside apply, flowed through imports in memory, never on disk |
| [engine-api-consistency](./engine-api-consistency.md) | 4, across 3 providers | a resource that exists but is not yet usable; `/tokens/verify` goes green ~1.5s before the scope-gated call works |
| [engine-output-wiring](./engine-output-wiring.md) | 4 | an output that cannot reach `wrangler.jsonc`; why five `d1` modules all still hardcode `database_id` |
| [engine-shared-module-code](./engine-shared-module-code.md) | 2 | no seam for code shared between modules, so libraries are shaped like modules |
| [engine-verbs](./engine-verbs.md) | 2 | only `apply` and `destroy`: no operator one-shot, no set-pruning, string-only outputs, and `destroy` sees `imports: {}` |

### New modules

| Case | Consumers | Status |
|---|---|---|
| [d1](./d1.md) | **5** | interface unanimous; ship it *with* output-wiring or it changes nothing |
| [gcp](./gcp.md) | 2, one lineage | service-account half generalises; Calendar half does not. Do not ship as-is |
| [single-consumer-modules](./single-consumer-modules.md) | 1 each | `vercel`, `posthog`, `obs`, foundry's 13, varnick's 4 — parked with evidence |

### Product surface

| Case | Consumers | The gap |
|---|---|---|
| [cli-gaps](./cli-gaps.md) | 3 | no `secret get` (8 sites shell out to `sops`), no `apply --json`, no provisioned-state inventory, no local/dev mode, no state capture, no module test harness |
| [distribution-drift](./distribution-drift.md) | 3 | consumers stranded on pre-`ctx.output` engines, rebuilding features zbc ships. varnick's subtree add failed silently and left no `zbc update` path |

## Reading order

The four engine cases are the finding. Every module case above depends on at
least one of them: `d1` is blocked by output-wiring, `gcp` is two engine
workarounds in a trenchcoat, `cloudflare-token`'s readiness probe is the
Cloudflare instance of `engine-api-consistency`. Shipping the modules without
the engine work reproduces, upstream, exactly what the consumers already built
by hand.

## Caveats

- **`gcp` is one lineage, not two.** foothill inherited its `packages/infra/`
  tree from ceo. Two data points about the need, one about the interface.
- **varnick has never run.** No environments, no apply script, stubbed tests.
  Design opinion, not production evidence.
- **ceo's `vercel`, `obs` and `d1` are unapplied**, and `obs` targets a
  `workstation` environment, not production.
- **leeandco's `cloudflare-access` is a parallel lineage, not a fork.** Ours
  was promoted from foundry on 2026-08-19; theirs predates it. Its `divergent`
  verdict and `nearestRev` are both misleading — read it as convergence. The
  survey now emits `upstreamFirstSeen` so this is visible rather than inferred.
- foundry's seven remaining modules and leeandco's `cloudflare-account-member`
  are recorded in `.consumer-survey/` only.
