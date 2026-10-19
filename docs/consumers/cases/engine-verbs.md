# engine-verbs — engine

**Consumers:** crux, foundry, leeandco, qom, railmid, varnick, web (acts outside zbc); agent-lab (the adopter)  ·  **Deployed in production by:** agent-lab, crux, foundry, leeandco, web; qom's and railmid's acts have no recorded run; varnick's never ran.

Actions shipped in 5521bc7 (#131, [ADR-0017](../../adr/0017-a-third-verb-and-a-value-typed-imports-edge.md), 2026-09-08), first released in zbc-cli-v0.16.0 on 2026-09-14; no built-in declares one. Every act outside zbc predates that release but qom's, whose engine binds actions. agent-lab adopted them the day it vendored zbc-core-v0.23.0 (2026-10-08).

## What they needed

Each needed a deliberate act on one declared resource: crux's production D1 wipe, identity restore and reads; web's signing-link insert, agreement backfill and agents' reads; leeandco's restore of rows from Zabaca's account; qom's row count and deliberate delete; railmid's secret rotation without a deploy; varnick's price-capped domain purchase and founding-operator mint; foundry's single-use incus trust token; agent-lab's mint or roll of a token kept in `secrets.yaml`.

## The interface, from nine implementations

qom's wrapper copies leeandco's; varnick's two acts came from foundry, which no longer carries them. The rest share no code.

**Where they agree, already in `actions`:**

- **A declared instance is the target.** crux reads its d1 instance, foundry its trust declaration, and varnick's apply prints the purchase command from config. web, leeandco, qom, railmid and varnick's control plane retype it.
- **That instance's credential**: `sops -d` (crux, varnick), wrangler's login (web, railmid), or a D1 token minted per command (leeandco, qom); but web's `STRIPE_API` is in no `secrets.yaml`, and agent-lab's root token is another project's ([engine-credential-lifecycle](./engine-credential-lifecycle.md)).
- **Never `apply` or `destroy`.** crux keeps its wipe out of d1's `destroy`, "where `zbc destroy` could reach it"; foundry's script is "the act an apply refuses to be"; railmid needs a push without `/release`'s deploy.
- **By hand**, never from CI.

**Where they disagree, the config surface:**

| | Gate | Input per run |
|---|---|---|
| crux | `--confirm crux-production`, the database's name, "rather than `--yes`" | `--email`, `--name` |
| web | none | names, slug, client id |
| leeandco, qom | none in the wrapper | SQL |
| railmid | none | none: sops holds it |
| varnick, purchase | typed `--max-price`: "a confirmation flag people learn to add reflexively is not a gate" | none: flags mirror config |
| varnick, founding operator | a bootstrap secret, void once an operator exists | email, password, display name |
| foundry | refusals: already enrolled, token pending, tokens never expire | none: its argument names the instance |
| agent-lab | `--yes` on `rotate`; `mint` refuses an existing token | none |

crux, web's backfill and varnick's purchase rehearse: crux by default and credential-free, varnick live. An action returns nothing (`ADR-0017:75-76`); agent-lab's write-back is [cloudflare-token](./cloudflare-token.md)'s, and foundry's printed token and the `incus-trust` it needs are [incus](./incus.md)'s.

## What it takes upstream

1. **Input per run.** main has no channel: `ActionFn` is `(config, ctx)` (`types.ts:8`), and `zbc run` parses and passes on only env, instance, action and `--yes` (`commands/run.ts:20-37`, `engine/actions.ts:147-151`). Unknown flags reach `process.argv` untyped, after the gate. One shape: a zod `args` schema on `ActionDeclaration`, parsed before the gate.
2. **The gate.** ADR-0017 chose `--yes` after both typed gates, on purpose ("the operator typed an instance name and an action name", `ADR-0017:155-158`), though the script it was built for (`:28-38`) rejects it. The alternative: `confirm: (config) => config.databaseName`. main refuses after decrypting `secrets.yaml` (`engine/actions.ts:153`; gate `:109-114`) but before parsing config (`:116`), so refusing needs a key and cannot name the database. Should it refuse first? A rehearsal can already be a second, reversible action.
3. **The environment** on the context. agent-lab restates it in config, unchecked against the one `zbc run` resolves (`commands/run.ts:49`), so an instance copied into `preview/` writes production's `secrets.yaml`: `ApplyContextInput` is `secrets, imports, projectRoot` (`types.ts:98-102`).
4. **`d1`**, one consumer each: a no-input read of `sqlite_master` and row counts for crux's runbook and release checks (`query()` discards rows, `d1/index.ts:90-107`); an irreversible `drop-all` generalising crux's `dropAll`; and qom's deliberate delete. The last two work around [d1](./d1.md)'s migrations and destroy gaps. Agents' open-ended reads (crux, web) need item 1. Should a built-in carry a production wipe?
5. **`cloudflare`**: push `workerSecrets` without the build and deploy the loop follows (`cloudflare/index.ts:754-798`, after `:654-661`, `:731`), keeping its guards against wrangler exiting 0 after writing to a draft or another script (`:771-796`), which railmid's bare `secret put` lacks. railmid's `ANALYTICS_TOKEN`, a `cloudflare-token` output (`railmid.ts:133`), would be re-applied and rolled first (`cloudflare-token/index.ts:291-317`).
6. **A credential that lives as long as the act**, in two lineages: leeandco's per-command D1 token and varnick's 15-minute registrar token, each deleted in a `finally`. main has neither: `cloudflare-token` sets no `expires_on` (main's only one is a comment, `types.ts:17`), and an import an action applies is left standing, `ephemeral` or not (`ADR-0017:94-99`, `engine/actions.ts:73-76`).
7. **A registrar purchase.** None upstream; one lineage, built around Varnick's per-Client accounts ([single-consumer-modules](./single-consumer-modules.md)). The bar question: would most companies running zbc buy domains this way?

**Where an app's own act attaches.** crux's, web's and leeandco's acts write app tables and stay in those repos. Only a module declares actions (`types.ts:255-257`, `:263-278`): a consumer wraps `d1Module`'s bound `apply`, `destroy` and `ready` with its own `actions` (no fork, type-checks, undocumented), forks `d1`, or adds an instance importing the database, whose required `apply` (`define-module.ts:19`) no-ops every `zbc apply`.

**Before any of this reaches them.** qom's wrapper says such an act "cannot take a token from an instance's outputs", which an action body can. crux's, web's and leeandco's copy-mode engines predate actions, and refreshing them replaces their own `d1` ([distribution-drift](./distribution-drift.md)); there, `zbc run`'s "declares none" error names `vendor/zbc/src` (`engine/actions.ts:88-93`), not `packages/infra/src`. railmid, foundry and varnick vendor two verbs, and varnick has no `zbc.config.ts`, which `zbc run` (`commands/run.ts:39-47`) and `zbc secret get` (`commands/secret.ts:327-335`; [cli-gaps](./cli-gaps.md)) need.

## Closed since 2026-09-02

`ctx.outputValue` (`types.ts:153-164`) landed with actions; no built-in reads it, though `cloudflare-zone/index.ts:665` emits `nameServers` as an array, and only an action's test covers it (`commands/run.test.ts:177-212`), not apply's (`engine/apply.ts:92-96`). `destroy` has seen its imports since 736f8d4 (#114), which `ADR-0017:147-149` credits to #124. Set pruning: [engine-undeclared-state](./engine-undeclared-state.md).

## Evidence

Escape hatches and novel modules, not forks, so no `nearestRev`.

- **crux** (5743a02, 2026-09-02): `scripts/rebuild-production-db.ts:5-36,96,119-131,185-239`; `packages/core/src/db/d1/rebuild.ts:3-9,48-99`; `package.json:11-12`; `docs/runbooks/rebuild-production-database.md:50-56,60-67,101-103,123-131`; agents' reads `.claude/agents/crux-product.md:134-136`, `crux-release.md:55-59`; target `packages/infra/environments/production/d1.ts:20`; copy-mode `packages/infra/src/define-module.ts:10-26`. Production: no record of the wipe itself, but PRs #20 and #21 make it part of releasing, and #33 (2026-09-03) describes production as one identity and no Workstreams, the state a wipe and restore leave.
- **web** (mint f13d74a, 2026-08-03; backfill f3031d5, 2026-08-23): `apps/web/scripts/mint-contract-link.ts:11-13,20-34,82-92,125-144,153-162`; `apps/web/scripts/backfill-agreement-text.ts:24-26,104-112,121,136-138,196-207`; `STRIPE_API` `apps/web/src/lib/stripe/payment-link.ts:8-11`, a key its only `secrets.yaml` (production's) lacks; agents' reads `packages/infra/environments/production/web-access.ts:92-94`; target `production/web-contracts-db.ts:18`; copy-mode `packages/infra/src/define-module.ts`, no `actions`. Production: the backfill's first remote run, 2026-09-14 (`backfill-agreement-text.ts:108-112`).
- **leeandco** (d6f065d, 2026-08-14): `packages/leeandco/package.json:22`; `packages/leeandco/data/carried-from-zabaca-account.sql:1-8,15-19`, whose header says the rows are "left in the database"; `packages/infra/scripts/with-client-d1-token.ts:8-24,43-44,177-191`; copy-mode `packages/infra/src/define-module.ts`, no `actions`.
- **qom** (55ffd9f, 2026-10-06; no recorded run): `docs/runbooks/first-rollout-admin.md:108-112,137-140`; `packages/infra/scripts/with-client-d1-token.ts:9-21,27`; `packages/infra/src/define-module.ts:24,95`; `.zbc-vendor.json` (copy mode, 0.16.0, 2026-09-14).
- **railmid** (07d71fa, 2026-09-06; no recorded run): `docs/runbooks/admin-tokens.md:204-228`; `packages/infra/environments/production/railmid.ts:132-133`; `.claude/skills/release/SKILL.md:3`; `vendor/zbc/src/types.ts:3-5` (zbc-core-v0.12.0, d4cb29d).
- **varnick**, no `zbc.config.ts` or `packages/infra/environments/`, engine `vendor/zbc/src/types.ts:3-5`; neither act is in foundry's checkout now:
  - purchase (foundry ef094227, 2026-08-06; varnick 93d7243, 2026-08-15; tests only): `packages/infra/modules/client-domain/purchase.ts:3-14,252-322,467-474,518-552`; `client-domain/index.ts:164-172`; `client-domain/README.md:99-114`; `package.json:14`.
  - founding operator (foundry 5992e6e8, 2026-08-05): `services/varnick-control-plane/README.md:18-19` ("Not yet deployed"), `:1786-1816`; `app.ts:627-655`; `env.ts:31-38`.
- **foundry** (da1a626c, ADR-0027, 2026-08-18): `package.json:15`; `scripts/incus-enrol.ts:17-31,94-101,114-180`; `packages/infra/modules/incus-trust/index.ts:224-266`; `docs/adr/0027-a-trust-token-is-an-act-not-machine-state.md:3,21-24`; `vendor/zbc/src/types.ts:13-20`, no `actions`. Production: ec5c499d (2026-08-19) quotes it refusing to reissue the enrolled cedarpad's token, and `LEARNINGS.md:381-396` records the enrolment of agent-lab against the daemon, 2026-08-23.
- **agent-lab** (9e81f26, 2026-10-08; both production instances minted with `zbc run`, per that commit's message): `.zbc-vendor.json` (zbc-core-v0.23.0); `packages/infra/modules/stored-token/index.ts:20-21,43,161,209-248`; `packages/infra/environments/production/agent-lab-r2-admin.ts`, `agent-lab-data-key.ts`; `docs/hosting.md:91-95`.
- **Engines that bind `actions`:** agent-lab, croft, games, lofi, lov, qom, varnick-app; only agent-lab declares one.
- **main at 0ef349d** (`engine/` and `commands/` under `packages/cli/src/`; `types.ts`, `define-module.ts` under `packages/cli/templates/infra/src/`; modules under `packages/cli/templates/infra/modules/`):
  - `types.ts:8,17,98-102,153-164,255-257,263-278`; `define-module.ts:19`; a scratch module passing `d1Module`'s `apply`, `destroy` and `ready` through, plus one action, type-checks (strict) against it
  - `engine/actions.ts:73-76,88-93,109-116,147-153`; `engine/apply.ts:92-96`
  - `commands/run.ts:20-49`, which accepts `zbc run production db restore-identity --email … --name …` without refusing the flags; `commands/run.test.ts:177-212`; `commands/secret.ts:327-335`
  - `d1/index.ts:90-107`; `cloudflare/index.ts:654-661,731,754-798`; `cloudflare-token/index.ts:291-317`; `cloudflare-zone/index.ts:665`
  - no module declares `actions`: the only `actions:` keys under modules are routing-rule fields, `cloudflare-email/index.ts:100,399,425,488`
  - `docs/adr/0017-a-third-verb-and-a-value-typed-imports-edge.md:28-38,75-76,94-99,147-149,155-158`
  - 5521bc7's first tag is zbc-cli-v0.16.0 (2026-09-14)
