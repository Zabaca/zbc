# cli-gaps — product

**Consumers:** agent-lab, cedarpad, ceo, claude-mitm-proxy, crux, foothill-metabolic, foundry, games, leeandco, qom, railmid, web, zbc (its own repo)  ·  **Deployed in production by:** every consumer except web, whose stand-in is a CI gate (foundry's live environment is `ryzen-9`)

None is a module: zbc already holds each answer, and consumers went around
the CLI.

## What they needed

Secrets for operator commands, a local stand-in, selective deploys and
adoption, one section each.

## 1. Secrets for operator commands

Ten consumers still decrypt with `sops`, nearly all for production: ceo (15
sites) and foothill (two, from ceo's tree), cedarpad, crux
([engine-verbs](./engine-verbs.md)), foundry, railmid, games (railmid's
recipe), claude-mitm-proxy, and leeandco and qom (a D1 wrapper qom copied,
[cloudflare-token](./cloudflare-token.md)). agent-lab's and varnick's
root-token reads are
[engine-credential-lifecycle](./engine-credential-lifecycle.md)'s and
[engine-verbs](./engine-verbs.md)'s.

### The interface, from seven implementations

The seven independent ones read named keys, nearly always from
`packages/infra/environments/<env>/secrets.yaml` and often several at once (up
to five in one cedarpad script), and their scripts never print a value, foundry's
rule since a subagent printed `CLOUDFLARE_ROOT_TOKEN` into a transcript; yet
crux tells its product agent to `sops -d` production's file.

They disagree on delivery (a shell variable; a child's environment, at
cedarpad, ceo's croft wrapper and claude-mitm-proxy; or the script spawning
`sops`) and on the file. claude-mitm-proxy's installers send OAuth tokens and
two service passwords from its root `secrets.yaml`, a token store older than
its zbc, down ssh stdin to its hosts, ryzen-9's production proxy among
them ([host-modules](./host-modules.md)). ceo's `secrets/mac-only.yaml`,
encrypted only to James's Macs, could move into its `workstation` environment
under its own creation rule.

`zbc secret get` (`commands/secret.ts:304-354`) covers single-key reads, most
sites, but not several keys: agent-lab, the one adopter, runs four in
parallel, and on each of three runs one failed at random (one at a time
worked), cause undiagnosed; each call decrypts the whole file
(`secret.ts:337-342`). Nor a child's environment: `exec-env` takes one
`/bin/sh -c` string, in which cedarpad's multi-line loop failed silently for
every item. An ADR-0017 action gets them (`engine/actions.ts:146-155`) but
belongs to a module, and cedarpad's app-data scripts have none
([engine-verbs](./engine-verbs.md)).

### What it takes upstream

`zbc secret exec <env> <KEY>[,<KEY>…] -- <command> [args…]` beside
`getCommand` (`secret.ts:490-496`): decrypt once (`engine/secrets.ts:4-33`),
apply `resolveSecret`'s missing and blank rules to each key
(`templates/infra/src/context.ts:28-49`), spawn from argv, pass only the named
keys, print nothing, return the exit code. Open: named keys
or the whole file, as `sops exec-env` passes it at cedarpad and
claude-mitm-proxy; files outside `packages/infra/environments/`, which no
secret subcommand reads (`secret.ts:337, 370, 407`) and whose two cases are
single-project arrangements; and a module-minted credential, which
[turso](./turso.md) needs delivered the same way.

## 2. A local stand-in for what an environment provisions

Four built one, all test-only: foothill, cedarpad, web and games.

### The interface, from four implementations

foothill's and cedarpad's per-worktree wrappers share a generator and count
once; everything else was written separately. All four build the local
database from the remote one's migrations, which zbc holds for two (foothill's
turso `migrationsDir`, games' d1 `statements`) and `wrangler.jsonc` for the
others. None reads a credential or touches anything remote.

They disagree on the provider (`turso dev` or miniflare), on isolation (per
worktree at foothill and cedarpad, per run at web and games) and on the
Worker's config, which cedarpad derives from `wrangler.jsonc` without routes,
crons, containers or named environments, and web and games use as is; foothill
runs no Worker. Around the tool they hand-wrote generic dev tooling: ports,
state directories, orphan reaping, tool installs, and a Node pin because
wrangler refuses Bun.

### What it takes upstream

Nothing on main covers it: no module hook beyond `apply`, `destroy`, `ready`,
`actions` and `secretOutputs` (`templates/infra/src/types.ts:245-261`), no
local command (`src/index.ts:19-28`), environments as bare strings
(`utils/load-config.ts:3-6`), no local option in turso
(`turso/index.ts:94-105`). 0ae98a2 deferred it to "a new module-level verb",
and ADR-0017's `actions` did not take it up.

The change is a module hook beside `ready` that starts a stand-in and returns
outputs shaped like the real ones, and a verb such as
`zbc dev <env> -- <command>` running a command inside them. turso first:
`turso dev` serving a project file over HTTP (a Worker's libSQL client
rejects `file:`) and the migrator `apply` runs (`turso/index.ts:172-193`;
[turso](./turso.md)), not foothill's seed, which replays every `.sql` file in
name order. For D1, which wrangler's `--local` already serves:
cedarpad's config derivation, the reverse of the cloudflare module's
generated-config patch (`cloudflare/index.ts:692-713`), and a replay of
`statements` as games does, or of the migrations directory [d1](./d1.md)
proposes.

Whether this clears the bar is open: each works on the provider's own local
tool, and zbc holds only half the inputs.

## 3. Selective deploys

### The interface, from two implementations

ceo's `dorny/paths-filter` jobs, copied by foothill to deploy only its site
or inbox, and zbc's `scripts/affected-instances.ts`, whose output `/release`
passes as `--only`, converged three months apart. Both target with the
positional argument or `--only` (`commands/apply.ts:21-30`) and widen the run
for shared infrastructure paths. They disagree on:

- **the map:** hand-written globs, or derived from each instance's file,
  module directory and `workdir`;
- **an unmapped path:** no deploy in foothill, whose filters cover 2 of 7
  production instances, so CI never converges its D1 and R2, which nothing
  imports (omitting `foothill-email`, the MX cutover, may be deliberate);
  ceo's cover 2 of 14, eight others headed "Deploy just this instance";
  zbc's script "fail[s] toward ALL";
- **dependents:** only zbc's redeploys an instance's importers; a targeted
  apply adds only its imports.

crux, railmid, cedarpad, leeandco and web deploy by hand, naming the instance
in three runbooks.

### What it takes upstream

`--only` shipped in 0.16.0; the script did not. It hardcodes zbc's layout
(`scripts/affected-instances.ts:45-55, 162`), nothing in `packages/cli/` uses
it, and `zbc list --json` has no config to read a `workdir` from
(`commands/list.ts:62-69`). Upstream: `zbc affected <env> <file>…`, printing
names or ALL from the consumer's layout (`packages/infra/` or
`vendor/zbc/`), failing toward ALL, with a template workflow using it. The
template on main applies the whole environment on every push
(`templates/workflows/production.yml:3-5, 25-28`), which the script's header
calls the problem (`affected-instances.ts:5-9`) and zbc's own production has
left (`README.md:240`). Whether it should deploy on push at all comes first.

## 4. Adoption of `secret get` and `apply --json`

Both first shipped in zbc-cli-v0.16.0 on 2026-09-14. One consumer uses
`secret get`; none uses `apply --json`. ceo, qom and games added `sops` reads
since, on CLIs with both, and none of them, railmid or claude-mitm-proxy
mentions `zbc secret`. cedarpad and foundry pin 0.12.0 and 0.7.0; foothill's
and crux's last commits predate 0ae98a2. `apply --json`'s one live candidate,
foothill's `preview.yml`, still greps a log for `Deployed:`, as the
template did until 0ae98a2 (`templates/workflows/preview.yml:41-48`).

The adopter, agent-lab, is the one repo in section 1 whose agents are told:
its scaffold enabled the zbc plugin, which points scripts at `secret get`
(`plugin/skills/zbc/SKILL.md:151-152`), and it moved its R2 reads there 34
minutes later. lov, croft and lofi are told too, with nothing to convert. One
adopter is a correlation, not a measurement.

### What it takes upstream

No engine change. `zbc init` writes the plugin entry
(`templates/claude/settings.json:16-18`), the command list
(`templates/CLAUDE.md:24-27`) and the workflows once, skipping existing files
(`commands/init.ts:166-178`), and `zbc update` writes none. So a repo
scaffolded before 0.16.0 hears of neither command, one before 0.23.0 lacks the
plugin, and workflows "need a re-scaffold or manual patch"
(`README.md:311-314`). If reaching existing repos is zbc's job, the smallest
change is `zbc update` reporting a `.claude/settings.json` that does not
enable `zbc@zbc`, as it reports foreign files under `vendor/zbc/`
(`commands/update.ts:114-116`). Pins are [distribution-drift](./distribution-drift.md)'s.

## Also open from 2026-09-02

- **State capture.** ceo's `obs/capture.ts` is still the only tool writing an
  instance file from live state. An ADR-0017 action could host it with no
  CLI change (`templates/infra/src/types.ts:205-208, 257`) once ceo's copied
  `defineModule` stops dropping `actions`. `obs` is parked in
  [single-consumer-modules](./single-consumer-modules.md).
- **`bunx`, never `bunx --bun`.** The cloudflare module fails wrangler's exit-0
  no-deploy (`cloudflare/index.ts:61-65, 735-743`), but the plugin says only
  "Run as `bunx @zabaca/zbc <command>`" (`plugin/skills/zbc/cli.md:3`) and the
  scaffolded CLAUDE.md and workflows nothing, so crux, railmid, games and
  claude-mitm-proxy, whose `--bun` apply the guard caught, restate the rule. A
  line each in `cli.md` and `templates/CLAUDE.md` would cover it.
- **What a provider holds, and what preview destroys miss:**
  [engine-undeclared-state](./engine-undeclared-state.md).
- **crux's direct `wrangler deploy`** is crux's to remove; nothing on main
  detects one (nearest proposal: [cloudflare](./cloudflare.md)'s served-build
  check).

## Closed since 2026-09-02

From 0ae98a2 (#123): `secret get`; `apply --json`, writing declared secret
outputs as `[redacted]` since 40ef706; `zbc list`, the declared half of
inventory; and `createTestContext`.

## Evidence

Main paths are under `packages/cli/` (`commands/`, `engine/` and `utils/` in
`src/`; modules in `templates/infra/modules/`); `README.md` and `scripts/` are
the repo root's. The collector flags a `sops` call only in code under
`scripts/`, `packages/infra/` and `.github/` (`scripts/consumer-survey.ts:231-238,
413-417`), so most sites below were found by reading, and every count is a lower
bound.

**Secrets for operator commands** (production unless noted)

- ceo: `packages/infra/scripts/ph.ts:29-34`; `packages/tax/scripts/api.ts:25-31`, `shot.ts:17-25`; `packages/recon/scripts/deploy.sh:56,85`, `local-runner.ts:46-48`, `shot.ts:25-26`; `packages/recon/runner/run.ts:30`; `packages/recon/README.md:48-49`; `packages/leads/leads.ts:96-101`, `README.md:23-24`; `packages/household-ledger/README.md:63-65`; `packages/lantern/README.md:43-44`; `packages/seo/bin/croft:2-11`; `scripts/gmail-draft.ts:23-28` with `.sops.yaml:13-16`. From acde774 (2026-07-27) to a191b7a and c74790b (2026-10-17); unpinned CLI at `.github/workflows/production.yml:77`.
- foothill-metabolic: `scripts/check-orphan-previews.sh:23-25` (preview tokens); `.claude/commands/foothill-synthesis.md:11`. Both from ceo (2a271a4, 433d766), carried over in e97dc04 and 36543dc (2026-07-27).
- cedarpad: `packages/canvas/scripts/deploy.sh:129-132`; `census-unmigratable.sh:28-29,57,69-77`; `migrate-canvas-rooms.ts:405-413`; `migrate-records.ts:16-28`; `page-census.ts:12-14,27-31`; `repair-note-font-size.ts:25-28,43-61` (five keys); `base-component-census.ts:16-18,32-45`; `.claude/skills/release/SKILL.md:278-279`; pin at `package.json:17`.
- crux: `scripts/rebuild-production-db.ts:90-99`; `docs/runbooks/rebuild-production-database.md:54-55`; `.claude/agents/crux-product.md:134-136`.
- foundry (`ryzen-9`): `packages/infra/environments/ryzen-9-live-access-applications.test.ts:184-192`, registered at `machine-asserted.test.ts:83-85`; `LEARNINGS.md:271-296` (the 2026-08-23 transcript leak); pin at `package.json:33`.
- railmid: `packages/infra/scripts/posthog.sh:8-17`; `apps/client/sfx/render.sh:21-29,82`; `docs/runbooks/admin-tokens.md:69-70`.
- claude-mitm-proxy: `scripts/fleet.ts:63-65,183` (production's file) and `:118-132,535,756` (the root file), run by `packages/menubar/Sources/FleetMenuBar/FleetCLI.swift:80-86`; `package.json:12-14,20` (`exec-env` over the root file, a local run); ADR-0003:13-16. Installers: `scripts/install-proxy.sh:102-125`, `install-memory-server.sh:84-109`, `install-omniroute.sh:74-88`, read on the host by `scripts/remote/lib.sh:140-146`; ryzen-9 as the fleet's proxy and memory server: `docs/adr/0015-one-proxy-on-the-tailnet-per-client-placeholders-self-clients.md:22-26`, `CONTEXT.md:15`. The root file came in 6edfb50, zbc in 8fd3379 (both 2026-09-06 UTC, local checkout).
- leeandco: `packages/infra/scripts/with-client-d1-token.ts:16-17,86-100` (d6f065d, 2026-08-14). qom: the same file, `:17-18,27,68-75` (55ffd9f, 2026-10-06); `.zbc-vendor.json` (copy mode, CLI 0.16.0, 2026-09-14); unpinned at `README.md:15`.
- agent-lab: `tools/data/cli.ts:25-44`; `experiments/2026-10-17-croft-duckdb2-quack/README.md:163-164`; the root token from zbc's file, `docs/hosting.md:91-96`.
- games: `scripts/roadkill-audio.ts:6-7` (e1ace4e, 2026-10-12), against production's file, its output committed under `games/roadkill/game/audio/`; `.zbc-vendor.json` and `README.md:89` (0.22.0).
- varnick (never run): `packages/infra/modules/client-domain/README.md:101-104`.

**Local stand-ins** (test-only; separately written, 2026-07-27 to 2026-10-18)

- foothill-metabolic: `scripts/with-worktree-db.sh:5-25,45-57,59-64,83-108,112-122`; `packages/foothill-metabolic/scripts/seed-dev.ts:22-30`; `packages/infra/environments/production/turso.ts:8`; `packages/infra/modules/turso/index.ts:80-94` (a stale copy); `.github/workflows/e2e.yml:30-41`; `package.json:7-9`. 28f571d and fe68e10 (2026-07-28).
- cedarpad: `packages/canvas/scripts/with-worktree-db.sh:3-16,20-30`; `packages/canvas/scripts/wrangler-local.ts:1-8,43-57`; `packages/canvas/server/dev-worker-config.ts:1-4,55-111`; `packages/canvas/wrangler.jsonc:119`; `.github/workflows/gates.yml:64-68,77-96`; `.github/workflows/e2e.yml:36-53,69-70,80-86`; `packages/canvas/package.json:24`; `packages/www/package.json:13`; `.claude/settings.json:3`. 08044b8 (2026-07-27).
- web: `apps/web/scripts/smoke.ts:1-21,41-140,160-163`; `apps/web/package.json:21-22`; `apps/web/wrangler.jsonc:98`; `.github/workflows/ci.yml:3-8,57-60,116-126`; `.sops.yaml:1-7` (no CI key). 9d579cc (2026-09-12).
- games (a22d7ef): `scripts/online/lib.mjs:1-4,107-156,229-241,385-469`, called at `boot.mjs:147`, `e2e.mjs:47`, `smoke.mjs:67`, `browser.mjs:99` and `legacy.mjs:59`; `scripts/release.mjs:14-15,32-40` and `README.md:80-81` (a release gate, no CI); `packages/infra/environments/production/games-db.ts:5-9,27`; `packages/api/package.json:10`. 8061c88 (2026-10-18, local checkout).
- main: 0ae98a2's message; ADR-0017's "What this does not decide" (`docs/adr/0017-a-third-verb-and-a-value-typed-imports-edge.md:132-149`).

**Selective deploys** (production)

- foothill-metabolic: `.github/workflows/production.yml:6-13,20-42,59-62,79-82`; `packages/infra/environments/production/foothill-email.ts:9-13`, `foothill-inbox-auth-db.ts:8-14`, `foothill-inbox-raw.ts:5-11`. Copied from ceo in e97dc04 (2026-07-27).
- ceo: `.github/workflows/production.yml:6-10,45-56,77,101` (8834030, 2026-06-03); "Deploy just this instance" heads eight of the twelve unfiltered instance files, e.g. `packages/infra/environments/production/campkit.ts:16`.
- zbc: `scripts/affected-instances.ts:2-17,45-55,89-134,160-169` (4bb8c67, 2026-09-02); `.github/workflows/production.yml:1-23,57-61`; `.claude/skills/release/SKILL.md:166-169`.
- By hand: railmid `docs/runbooks/tapes-bucket.md:67-68`; cedarpad `.claude/skills/release/SKILL.md:244`; leeandco `.claude/skills/deploy-leeandco/SKILL.md:29-35`.

**Adoption**

- foothill-metabolic: `.github/workflows/preview.yml:39-66`, from the template at b16dfd3 (0.3.2) via ceo e2eb0be (2026-05-18). Its last commit, 1e391b9, is 2026-09-06 05:05 UTC and crux's, dabea8b, 05:06; 0ae98a2 landed at 10:30.
- agent-lab: `.claude/settings.json:17` from its scaffold d1c2bb2, and `secret get` from b4eff17, 34 minutes later (2026-10-08). lov: `.claude/settings.json:17` and `CLAUDE.md:40-42`; croft and lofi: `CLAUDE.md:20-22`.
- main: the template's `enabledPlugins` arrived in 948207f (2026-10-05), first released in zbc-cli-v0.23.0.

**Also open**

- ceo: `packages/infra/modules/obs/capture.ts:1-26,38-49`; `packages/infra/environments/workstation/obs.ts:9-11`; `packages/infra/src/define-module.ts:15-20` (no `actions`).
- The `--bun` rule restated: crux `README.md:356-360`, `.claude/skills/release/SKILL.md:251-255`; railmid `README.md:2853-2858`, `.claude/skills/release/SKILL.md:301-304`; claude-mitm-proxy `AGENTS.md:59-60`, `docs/adr/0005-a-proxy-host-gets-a-compiled-binary-over-ssh.md:46`, `docs/adr/0008-fleet-control-plane-relays-sealed-tokens.md:45-46` (the guard catching one); games `scripts/release.mjs:16, 25-26` (8061c88).
- crux's second path: `apps/cloud/package.json:8`, unchanged at dabea8b (2026-09-06).

**Closed** (main)

- `commands/secret.ts:304-354`; `commands/apply.ts:31-36, 98-115`; `engine/apply.ts:212` (40ef706); `commands/list.ts:30-94`; `templates/infra/src/testing.ts:53`, exported at `templates/infra/src/index.ts:10`.
