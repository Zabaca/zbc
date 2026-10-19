# cloudflare — upgrade

**Consumers:** cedarpad, ceo, crux, foothill-metabolic, games, leeandco, qom, railmid, web  ·  **Deployed in production by:** all nine

ceo's fork also provisions Access, zone settings, R2 and D1, which ADR-0016 (zone and Access) and ADR-0014 keep out of this module ([cloudflare-access](./cloudflare-access.md), [cloudflare-zone](./cloudflare-zone.md), [r2](./r2.md), [d1](./d1.md)); railmid's detach of undeclared custom domains is in [engine-undeclared-state](./engine-undeclared-state.md).

## What they needed

Past the module's `Deployed … triggers` and `Uploaded secret` guards, consumers built a pre-apply check, a deploy proof and a faithful build (§1–§3). Nobody has asked for `bindings` that survive a Vite build: nobody could use them (item 1). Six surveyed Workers build through `@cloudflare/vite-plugin` and bind D1: crux, foothill-metabolic's inbox, web, leeandco and cedarpad's www paste the id on copies older than `bindings`, and ceo's tax binds by name, forgoing what ADR-0014 is for.

## The interface, from ten implementations

### 1. `wrangler.jsonc` checked against the instances: 3 implementations, 2 lineages

leeandco's test and qom's copy are one lineage, railmid's gates another; all test production instances (qom's a client's site), only railmid's in CI. They agree:

- **zbc-filled values stay out of the file**, a rule for deploys that bypass zbc, since zbc's own refuses an empty output (`packages/cli/templates/infra/src/context.ts:79`): empty or absent Access vars, and no real binding id (leeandco, on a stale copy, rules out only the retired account's).
- **Every hostname matches another declaration**: routes match the zone (leeandco, qom), Access hosts the routes (leeandco), custom domains a redirect rule (railmid).
- **The sender is at the domain the `cloudflare-email` instance onboards**, since `send_email` reads as bound when that domain is in another account; it cost leeandco a day of notifications.

They disagree on parsing: leeandco and qom strip comments by hand; railmid runs the module's own functions, exported from its fork, to exercise them offline (item 4). qom and railmid turn workers.dev off, railmid because it bypasses Access; leeandco keeps it as its DNS-independent address. leeandco and qom ban wildcard routes, and ceo route patterns altogether, since a wildcard took its zone's other hostnames on 2026-06-26, most likely the incident both ceo and leeandco record. All three keep hostnames in `wrangler.jsonc`, against main's guidance:

| Hostnames declared as | Consumers |
|---|---|
| routes in `wrangler.jsonc` | leeandco, qom, varnick, varnick-app |
| custom domains in `wrangler.jsonc` | ceo, cedarpad, crux, foothill-metabolic, lofi, lov, railmid, stiqr, web |
| instance `routes` | croft, claude-mitm-proxy, games; zbc's `landing`, `walgit-public` |

Most custom-domain copies predate `routes`; lov chose custom domains anyway, since nothing else claims its zone, lofi following stiqr, and qom pins `routes` empty.

Only leeandco refuses a `vars` key that a `workerSecrets` entry also names, which Cloudflare rejects with 10053 once the Worker is live. railmid's gates also hold migration numbering ([d1](./d1.md)), lifecycle ([r2](./r2.md)) and one source file per binding, its own rule.

### 2. Proof the deploy took effect: 5 implementations, 4 lineages

cedarpad's and ceo's are one lineage; crux's, leeandco's and games' are independent, and main's `deployIdVar`, which games uses, converges with leeandco's. Each reads an identity back from the deployed hostname without auth except ceo's; all but leeandco fail the release on a mismatch:

| | Identity, shipped as | Read at | Run from |
|---|---|---|---|
| cedarpad | commit and version, an image file | `/api/buildrev` | deploy script |
| ceo | commit with dirty-diff hash; inlined, and in the image | `/api/runner/buildrev` | deploy script |
| crux | package version, inlined | `/health` | release skill |
| games | commit, by `deployIdVar`; `-dirty` fails | `/api/health` | release script |
| leeandco | commit or bare `-dirty`, a var | `/api/version` | deploy skill |

ceo also requires its separately rolled container to agree five checks running: ceo's and cedarpad's have each served a stale build under a green apply. crux's first poll after 0.3.0 answered 0.2.0. cedarpad's poll is skipped while that container is self-hosted.

### 3. Building the commit, for its environment: 2 implementations

cedarpad refuses a dirty tree and an unpushed HEAD and builds from a `git worktree` snapshot of HEAD, after shipping conflict markers and an unpushed commit. games releases only from a clean worktree detached at the release commit, refusing even ignored files its build would copy. foothill-metabolic shipped a laptop's `.env` test Stripe key to production on 2026-08-01 and guards in app code; ceo fingerprints dirty trees instead.

leeandco prefixes `PUBLIC_POSTHOG_*` onto `build.command` for Astro, and cedarpad a load-bearing `CLOUDFLARE_ENV=preview` (item 2). Both ways of keeping a preview in one `wrangler.jsonc` took production's custom domains: a named env inherits top-level `routes` (cedarpad's canvas preview, 2026-10-09), and a per-PR `workerName` deploys the top-level block (foothill-metabolic, 2026-07-16). Neither follows main's answer: instance `routes`, no custom domains.

## What it takes upstream

In `packages/cli/templates/infra/modules/cloudflare/index.ts` unless named; bare line numbers are main's.

1. **Patch the built config.** Main deploys a patched copy of the source config with `--config` (`:697-713`, `:720`), so wrangler skips the plugin's redirect to the built one and ships the unbuilt `main`; under `wranglerEnv` it patches an `env.<name>` block a redirected config cannot have (`:434-440`). Patch the redirect's target at the top level, with a test: no zbc package uses the plugin. `wrangler.toml` stays refused (`:702-706`); no consumer has one.
2. **Make `wranglerEnv` safe.** Without `CLOUDFLARE_ENV` the plugin's build records no `targetEnvironment`, and wrangler silently ships its flattened top-level config under any `--env`. Main never passes `wranglerEnv` to the build (`:660`, `:721`, `:769`), and `build` has no env (`:135-138`): set `CLOUDFLARE_ENV` from it, or refuse a mismatched redirect. wrangler's output prints only on failure (`:69-87`, `:729-752`), which hid the warning naming the domains cedarpad's preview took: print it, or fail on that warning.
3. **Check the package before the build.** Main reads the config only for `bindings`, after the build (`:698`, `:655-661`), refusing an undeclared binding (`:447-449`) but overwriting a filled-in field (`:450`). `routes` accepts a wildcard, skipped only for `deployUrl` (`:140-155`), and main's rules for the file are prose (`:607-626`; `packages/cli/plugin/skills/zbc/wiring.md:66-76`). On every apply, refuse a filled-in id, a custom domain, a wildcard route, and a var a secret also names (resolved before the deploy, `:663-669`, pushed after, `:758-798`).
4. **Export an offline plan**: the resolved bindings, generated config and argv, from a pure function callable with `createTestContext`. ADR-0014 kept the resolver private until shared module code had a seam; ADR-0015's `kind: library` is one.
5. **Feed §1's cross-instance rules.** `cloudflare-zone` outputs only the records it does not declare (`cloudflare-zone/index.ts:661-672`), and the declared ones would have to cross as a value (ADR-0017) to an importing deploy, which qom's is not and a zabaca.com hostname, zoned in zbc's own repo, cannot be. `workerVars` can carry `cloudflare-email`'s `domain` (`:165-180`, `:220`; `cloudflare-email/index.ts:239-240`), but nothing compares its `accountId`.
6. **Prove the deploy.** Main checks only the triggers line (`:735-744`); readiness cannot, since `cloudflare` has no `ready` and ADR-0013 never probes an unimported instance. Either (a) a key naming a `deployUrl` path to poll for the `deployIdVar` value (games has both and still polls itself), which proves the Worker but not its container (`:552-583`, as main's walgit 0.16.1 found) and finds no `deployUrl` on a custom-domain Worker like crux's (`:750-752`) unless it reads wrangler's trigger list; or (b) an action, `zbc run <env> <instance> verify` ([engine-verbs](./engine-verbs.md)), as the five wrappers are; or both.
7. **Build the commit**: an opt-in dirty-tree refusal, or a `git worktree add` build of HEAD. Main builds in the checkout (`:655-661`) and only labels a dirty tree, under `deployIdVar` (`:119-132`). cedarpad's unpushed rule is its own branch policy.
8. **Docker.** cedarpad and ceo, one lineage, pass a `credsStore`-free `DOCKER_CONFIG` so a headless session on one operator's Mac can build the image; main says only that Docker must run (`:27-30`). Whether a module other companies vendor needs that is the bar question.

**Left open:**

- Item 1 is traced in code, not run: one plugin-built deploy settles it.
- Whether main should delete a secret dropped from `workerSecrets`: it only puts (`:758-798`), and ceo removed `RECLAIM_WEBHOOK_SECRET` by hand.

## Closed since 2026-09-02

The secret push passes `--name` alone when `workerName` is set, since wrangler joins it with `--env` into a script nothing deployed; it requires `Uploaded secret <KEY>`, and with `workerName` checks the script wrangler names (`dbb60d4`; `:758-798`). That closes `ceo:cloudflare:8` and `foothill-metabolic:cloudflare`, whose forks keep their own patch ([distribution-drift](./distribution-drift.md)). `routes` plus a zone record (`931919a`) closed web's hand-deleted DNS records for a custom domain (error 100117); web has not moved.

## Evidence

Consumer paths are at each repo's survey ref (games at `a22d7ef`), copy bases per `.consumer-survey/<id>.json`, and main is `0ef349d`. Bundle lines were read, not run: wrangler 4.147.0 and 4.110.0 (`wrangler-dist/cli.js` under this repo's `node_modules/.bun/`), `@cloudflare/vite-plugin` 1.53.1 and `@astrojs/cloudflare` 14.2.3, which builds through it (web's checkout).

- **The six Vite builds:** crux `apps/cloud/wrangler.jsonc:50-58`, `apps/cloud/src/index.ts:7`, `packages/infra/environments/production/cloud.ts:13-22`; foothill-metabolic `packages/foothill-inbox/wrangler.jsonc:20`; web `apps/web/wrangler.jsonc:74-97`; leeandco `packages/leeandco/wrangler.jsonc:50-52`, `:170-181`; cedarpad `packages/www/wrangler.jsonc:30-36`, `:62`; ceo `packages/tax/wrangler.jsonc:25-28`. Their copies are at `9f13268`, `f064805` or `e83bf83`, all before `bindings` (`946d0bd`).
- **Bundles:** plugin `dist/index.mjs:102665-102687` (writes the redirect), `:109638-109668` (flattens for `CLOUDFLARE_ENV`); wrangler 4.147.0 `cli.js:3520-3538` (an explicit `--config` is taken as given), `:3539-3611` and `:290561` (`deploy` follows the redirect otherwise), `:20389-20400` (no environments in a redirected config), `:20401-20414` (the `targetEnvironment` check; 4.110.0 `:30079-30088`), `:20899-20920` (the inheritance warning; 4.110.0 `:30596`), `:159370-159390` (custom-domain trigger lines).
- **leeandco**, `packages/infra/tests/production-instances.test.ts`: reader `:604-621`; routes `:591-603`, `:623-680`; Access hosts `:885-895`; binding id `:682-699`; Access vars and 10053 `:1142-1163`; the stamp's bare `-dirty` `:1165-1173`; sender and the lost day `:1200-1252`. Also `packages/leeandco/wrangler.jsonc:56-68` (workers.dev kept as the DNS-independent address), `:106-195`; `docs/research/worker-route-wildcard-incident.md:3-20`; `packages/infra/environments/production/leeandco.ts:100-105`, `:192-198` (stamp, `b153890` on 2026-09-10, before main's `b72a35c` on 2026-09-16), `:113-137` (build env); `packages/leeandco/src/pages/api/version.ts:6-17` (credential-free); `.claude/skills/deploy-leeandco/SKILL.md:80-96`; `.github/workflows/ci.yml:27-29` (CI tests only `packages/leeandco`).
- **qom**, a client site (`docs/consumers/registry.json`): `packages/infra/tests/qom-site.test.ts:46-58` (leeandco's reader), `:93-109`, `:125-143`, `:146-188` (`routes` pinned empty `:159-160`, workers.dev off `:173-175`); `qualityom-email.test.ts:53-57`; `packages/qom/wrangler.jsonc:29-52`, `:69-106` (no wildcard, citing ceo, `:95-98`); `docs/adr/0009-plain-routes-and-an-originless-placeholder.md:22-26`; `packages/infra/environments/production/qom.ts:26-34`, `:84` (no zone import), `qualityom-email.ts:28-32`; no `.github/workflows`.
- **railmid**, a fork of `f064805` (similarity 0.664): `packages/infra/test/d1.ts:1-23`, `:111-118`, `:139-150` (migrations); `tapes.ts:1-31` (lifecycle; offline because the module's round trip otherwise first runs in a production deploy, `:8-13`), `:194-208` and `email.ts:120-134` (one file per binding); `redirect.ts:57-130` (workers.dev behind Access `:120-130`), `:155-157` (Access vars absent); `email.ts:103-112`; `.github/workflows/ci.yml:288-293`; the exported internals `vendor/zbc/modules/cloudflare/index.ts:204`, `:263`, `:286`, `:326`, `:366`, `:415`, `:460`.
- **ceo**: `docs/decisions/0020-poc-deploys-on-zabaca-subdomains.md:9-10` (zabaca.com joined the account on 2026-07-28, so leeandco's `*.zabaca.com/*` is most likely ceo's `*.cedarpad.com/*`), `:30`, `:71-75`; `packages/recon/scripts/deploy.sh:1-27` (the stale container, and cedarpad's on 2026-07-28), `:16-20` ("Borrowed from cedarpad"), `:89-95` (Docker), `:108-195` (the poll sends a bearer token, `:138`); `wait-rollout.ts:54-79`; `build-rev.ts:1-25` (diff hash `:14-20`); `src/app.ts:410-438`, bearer-gated at `:144-153`. The fork, of `e83bf83` (similarity 0.382): `packages/infra/modules/cloudflare/index.ts:121`, `:137`, `:183-185`, `:234-242` (R2, D1, zone and Access keys), `:529-536`, `:554-558`; `90f3972` (2026-07-16) records `RECLAIM_WEBHOOK_SECRET` removed by hand; Access and D1 moved ahead of the deploy in `ae11c05` (2026-10-09).
- **cedarpad**: `packages/canvas/scripts/deploy.sh:17-31`, `:55-72` (the two incidents and refusals), `:74-100` (snapshot), `:117-119`, `:142` (Docker), `:144-169` (public poll, skipped at `:152-157`); `.claude/skills/release/SKILL.md:17-28`; `packages/infra/environments/preview/www.ts:10-14`, `:23-24`, `preview/canvas.ts:37-38`; `packages/canvas/wrangler.jsonc:13-18`, `:144-158` (`4b436a7`, 2026-10-09, with wrangler 4.147.0 pinned at `4b436a7^:packages/canvas/package.json:77`). The lineage runs from ceo `1c2eb98` (2026-06-26) to cedarpad `3fd476a` (2026-06-29).
- **crux**: `.claude/skills/release/SKILL.md:270-301`; `.claude/agents/crux-release.md:61-63` (0.2.0), `:84-86` (no `deployUrl`); `apps/cloud/src/index.ts:9-12`, `:60-77`, `:130-145` (`/health` first, without auth); `apps/cloud/wrangler.jsonc:32-42` (custom domain).
- **games**: `scripts/release.mjs:1-30`, `:95-134` (refusals, ignored files `:125-134`), `:305-325` (polls every 5 s for 3 minutes; `-dirty-` fails); `packages/api/src/worker.ts:83`, `:117`; `packages/infra/environments/production/games.ts:12-15` (its record is in zbc's zone), `:24` (`routes`), `:29` (`deployIdVar`); `games-access.ts:29` (Access only on `/admin`).
- **foothill-metabolic**: `packages/foothill-metabolic/src/lib/stripe.ts:94-99`; `packages/foothill-metabolic/wrangler.jsonc:27-32`; the fork, of `e83bf83` (similarity 0.953, ceo's edit via `e97dc04`): `packages/infra/modules/cloudflare/index.ts:181-200`, `packages/infra/environments/production/foothill-metabolic-cf.ts:20-25`.
- **web**: `docs/runbooks/dns-cutover-zabaca.md:3`, `:36-61`, `:107-129`; `apps/web/wrangler.jsonc:29-35`.
- **Hostname census**, beyond the above: varnick `services/varnick-site/wrangler.jsonc:28-31`; varnick-app `site/wrangler.jsonc:6-9`; stiqr `apps/frontend/wrangler.jsonc:16`; railmid `apps/server/wrangler.jsonc:56-57`; lov `packages/lov/wrangler.jsonc:12-14` (nothing else claims the zone) and lofi `wrangler.jsonc:9-12` (as stiqr), on copies with `routes` (`3f30e5f`, `b72a35c`); croft `packages/infra/environments/production/site.ts:20`; claude-mitm-proxy `packages/infra/environments/production/fleet.ts:34`; zbc `packages/infra/environments/production/landing.ts:26`, `walgit-public.ts:68`, `zabaca-zone.ts:77-78` (web's hostnames), `:85` (games').
- **main**: `packages/cli/templates/infra/modules/cloudflare/index.ts:523-551` (`deployIdVar`), `:562-565` (walgit 0.16.1's old image after a `completed` rollout); `packages/cli/src/engine/readiness.ts:5-15`; `docs/adr/0013-readiness-is-a-precondition-of-the-imports-edge.md:27`; `docs/adr/0016-zone-and-access-do-not-belong-in-the-deploying-module.md` (`ed8ce39`, #128); ADR-0014 (`946d0bd`, #125); ADR-0015 (`6030286`). No `package.json` depends on either plugin, and no test writes `.wrangler/deploy/config.json`. No surveyed checkout has a `wrangler.toml`.
