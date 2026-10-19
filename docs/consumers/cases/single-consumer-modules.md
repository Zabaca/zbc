# single-consumer-modules — new

**Consumers:** leeandco, varnick, crux, ceo; web and railmid have two of the
needs without a module  ·  **Deployed in production by:** leeandco and ceo, by
hand; crux's ruleset is live, applied with `gh api`.

None has a module on `main`, whose paths here start at `packages/cli/`.

| Parked need | Where [CLAUDE.md](../../../CLAUDE.md)'s bar is in question |
|---|---|
| [Cloudflare account membership](#cloudflare-account-membership) | Zabaca administering client-owned accounts |
| [A required check on `main`](#a-required-check-on-main) | a code-host setting needing an admin credential |
| [PostHog dashboards](#posthog-dashboards) | analytics configuration on a personal API key |
| [OBS Studio](#obs-studio) | one machine, one person |
| [varnick's client estate](#varnicks-client-estate) | one product, never run |

## Cloudflare account membership

### What they needed

Who may manage a Cloudflare account, as repo state. leeandco's
`cloudflare-account-member`, in production, converges the client account's
members, removing one only with `allowDelete: true`. varnick's
`client-account`, never run, only verifies: it refuses to create anything
unless `transfer.ownerEmail` is an accepted Super Administrator, the role that
lets a Client remove Zabaca, or, with `transfer.ownerHoldsAccount: false`,
prints that exposure every run.

### The interface, from 2 implementations

They share no code: varnick's check left foundry six days before leeandco
ported other Cloudflare modules from it. Both key members by lowercased email,
name roles, count only `accepted` as access, hinge on
`Super Administrator - All Privileges`, take `apiToken: { from, output }` from a
minted `cloudflare-token` with Account Settings Read, and lack `destroy`.

| | leeandco | varnick |
|---|---|---|
| Administrators | also `Administrator`, so the last-admin refusal errs towards refusing | Super Administrator only: Administrators cannot manage members |
| Role match | exact: `Administrator Read Only` exists | prefix: the suffix is "Cloudflare's to change" |
| Address | top-level `email`, run against the client's account | `user.email`, its stub's shape |

Only leeandco measured the API: POST and PUT take opposite role shapes, tested
only on a helper the apply never calls.

### What it takes upstream

A new module at `templates/infra/modules/cloudflare-account-member/` from
leeandco's 512 lines and 292-line test, swapping its private transport and
`resolveRef` for main's `cloudflare-api` and `ctx.output`; nothing on main
touches membership. `cloudflare-token` takes `rootTokenSecret` and since
ae34961 probes Account Settings Read with `GET /accounts/{id}`, where
leeandco's older token probes `/accounts/{id}/roles`
([cloudflare-token](./cloudflare-token.md)). The hard part: adding a member
needs Account Settings Write, which can also create a Super Administrator and
has no narrower group, so leeandco mints a token for this module alone.

Open: which roles count as administrators; whether varnick's verify-only check
is config on the same module; the bar, though leeandco notes Terraform has had
a resource for this "for years".

## A required check on `main`

### What they needed

A `main` that refuses deletion, force-pushes and any change whose check has not
passed. crux's ruleset (`.github/main-ruleset.json`) was applied once by an
admin with `gh api`, as CI's installation token lacks `administration`. web had
classic protection for about an hour on 2026-08-23, until it went private: free
plans protect only public repositories. ceo's plan refuses branch protection
and rulesets outright.

### The interface, from 2 implementations

Two declarations eleven days apart, sharing no text. Both forbid deletion and
force-push, require one check named after a workflow job and no approvals, and
warn that renaming the job blocks every later pull request. Only crux uses a
ruleset, requires a pull request, pins the check to GitHub Actions, and gives
admins an `always` bypass, for its release commit; web left `enforce_admins`
false.

### What it takes upstream

A new module converging a repository ruleset from a declared payload over
GitHub's REST API. No module on main calls `api.github.com`; only the warehouse
app's GitHub reader does. The nearest is `zbc init --ci github` copying
workflows. Three facts bear on it: the credential that converges the rule can
lift it, and crux keeps one off CI; two of three repositories cannot have it on
their plan; the live one is public.

## PostHog dashboards

### What they needed

ceo declares PostHog insights and dashboards in a production instance, applied
by hand: "definitions change in the repo, not the PostHog UI". railmid keeps its
funnel in the console, as CI "must not acquire" a personal API key; leeandco's
ADR-0034 fixes the funnel's events, not the insight. Nine consumer repositories
and main's walgit template load PostHog's snippet and provision nothing.

### The interface, from 1 implementation

Config `projectId`, `host`, `dashboards[{name, description}]` and
`insights[{name, description, query, dashboards}]`; output
`dashboardUrls: string[]`; secret `POSTHOG_FULL`, a personal key with
insight:write, dashboard:write and query:read. Names are the key: PostHog
allows duplicates and tags are paid, so nothing detects orphans or drift. Reads
are separate scripts, ceo's and railmid's, decrypting the key with sops as
`zbc secret get` now does ([cli-gaps](./cli-gaps.md)).

### What it takes upstream

A new module at `templates/infra/modules/posthog/` from ceo's 119 lines, plus
what ceo deferred: pagination past one page of 300, and drift handling without
tags.

## OBS Studio

### What they needed

ceo reconciles OBS Studio's scenes, sources, filters and settings over
obs-websocket against the running app, since OBS rewrites its files on exit,
undoing any `host-file` template. `capture.ts` writes the instance file from
the running OBS, as its workstation instance was.

### The interface, from 1 implementation

Config `host`, `port`, `configPath`, `scenes`, `video`, `currentScene`,
`recordDirectory`, `profileParameters` and `prune` (off by default); outputs
`url`, `scenes`; no secret by default: the password comes from OBS's config.

### What it takes upstream

ceo's 768 lines, applied only from one Mac. The general part is capture, an
instance file written from live state: no other consumer does it, and main has
no capture or import command. As an action ([cli-gaps](./cli-gaps.md)) it could
take no per-run `--out` ([engine-verbs](./engine-verbs.md)).

## varnick's client estate

### What they needed

A Varnick Client's Cloudflare estate, converged into an account the Client owns
and Zabaca operates: `client-account` (the account, zones and holder),
`client-domain` (the registrar record), `client-preview` (Preview Workers) and
their library, `client-core`. None of it has run: no `zbc.config.ts`,
environment or apply script; the tests stub `fetch`. foundry, where it was
written, now refuses `client-*` modules; varnick-app uses none. The 2026-09-02
condition, revisit if varnick ships, is unmet.

main drew on it three times: `client-domain`'s purchase is why actions exist
(ADR-0017:28-38), `client-core` is a precedent for the `library` kind (6030286;
ADR-0015:9-13), and `client-preview` is why ADR-0017 declined a pruning verb
(ADR-0017:134-145).

**A fourth citation does not hold.** ADR-0017:44-49,
`templates/infra/src/context.ts:92-95`, `context.test.ts:86-87` and
`testing.test.ts:23-26` justify `ctx.outputValue` with `client-account`'s
`nameServers: string[]`, which could not cross an imports edge, so the consuming
instance re-derived it. Nothing in varnick reads or re-derives it,
`client-domain` (the "Ticket 05" its comment names) included, and its vendored
zbc-cli-v0.10.2 engine passed importers raw outputs; its only string rule is
`client-core`'s token resolver.

### The interface, from 1 implementation

All three take `apiToken: { from, output }` through `client-core`'s schema and
reject an `accountId` that is not 32 lowercase hex. `client-account` takes
`client`, `accountId`, `accountName`, `apiToken`, `zones`, a required
`transfer` and `failOnDrift` (default true). `client-preview` converges an
unbounded, content-named set of Workers from one instance, pruning inside a
prefix that branded types enforce.

### What it takes upstream

Nothing until a Client exists. main lacks:

- the account-name check `client-account` makes before writing, lest a real but
  wrong id put one Client in another's tenant: every `accountId` is a plain
  `z.string()` (e.g. `templates/infra/modules/cloudflare-zone/index.ts:197`),
  and the zone module checks only its zone's account (`:691-698`);
- a registrar read: the word is only in comments and test descriptions;
- `client-preview`'s deploy from memory over REST multipart: `cloudflare`
  spawns wrangler for one Worker per instance, and nothing uploads over REST;
- `client-core`'s `cfUpload`, 32-hex id check and shared `{ from, output }` zod
  schema. main shares only the `OutputRef` type, five Cloudflare modules
  declare their own `apiToken`, and reading such references through
  `ctx.output` is documented, not enforced: `ctx.imports` is still the raw
  record. The rest of `client-core` is in `cloudflare-api`, newer, from a shared
  ancestor (3a5bf85, 04a73e1).

`client-domain` prints its purchase command, capped at `maxPriceUsd`; as a main
action it would take no arguments and be gated only by `--yes`, which its author
rejected ([engine-verbs](./engine-verbs.md)).
Zone creation is in [cloudflare-zone](./cloudflare-zone.md); undeclared zones
and pruning are in [engine-undeclared-state](./engine-undeclared-state.md).

## Closed since 2026-09-02

- `createTestContext` (0ae98a2) is the harness obs's tests built by hand, short
  of a WebSocket.
- `vercel`, once listed here, was zbc's own deleted built-in, implicit import
  flatten included ([distribution-drift](./distribution-drift.md)).

## Evidence

Consumer paths are relative to that repo's root.

**Cloudflare account membership**

- leeandco (novel): `packages/infra/modules/cloudflare-account-member/index.ts:4-60,62-115,119-164,175-230,251-369,396-466,485-501` and its 292-line `index.test.ts`, whose `:280-292` pin `roleBodyShapes` (`index.ts:334-346`) while the apply builds the PUT body inline (`:462`); `docs/adr/0009-account-membership-is-a-separate-grant.md:45-60`, its three measurements: full role names, opposite role shapes, and roles paging at 20, below Super Administrator, so it asks for 200 (`index.ts:396-409`); instance `packages/infra/environments/production/leeandco-members.ts:59-83` (three Super Administrators, `allowDelete: false`), applied in 9b24dc1 (2026-08-20); token `leeandco-members-token.ts:7-17,36-48,52-61` (no narrower group at `:36-39`; the probe is the module's first call, `:44-48`), with `packages/infra/tests/production-instances.test.ts:808-822` refusing `Account Settings` on every other token.
- varnick (never run, `EXIT.md:309-311`): `packages/infra/modules/client-account/index.ts:49,112-198,274-324,394-441`, `index.test.ts:123-139` (the stub).
- Lineage: varnick's check is foundry 178ebb1c (2026-08-06, author `Foundry` on ryzen-9), gone from foundry in ab0cede2 (2026-08-08); leeandco's port from foundry is 9dc32d4 (2026-08-14), its member module 9b24dc1 (author `uptown`). Neither names the other.
- main: `git grep -i -E '/members|account_members|Super Administrator'` over `templates/` and `src/` finds nothing; `templates/infra/modules/cloudflare-token/index.ts:142-149` is the probe table, its `Account Settings Read` row (`:147`) from ae34961 (2026-09-07), and `:215` is `rootTokenSecret`.

**A required check on `main`**

- crux: `.github/main-ruleset.json:1-28`, `docs/runbooks/protect-main.md:7-21,28-49,81-85`, `.claude/skills/dev-start/SKILL.md:39` (public); 4b21b22 (2026-09-03). Live as ruleset 22273848, read back by the survey's verifier and named at `.claude/agents/crux-release.md:90`.
- web: `WORKSPACE.md:109-154` (`:111`: "about an hour", dated 2026-08-24 in UTC), written in 56b35dd and corrected in 3e726c7 three hours later, when the repository went private (2026-08-23, US Pacific).
- ceo: `.github/workflows/test.yml:16-19`.
- main: `git ls-tree main packages/cli/templates/infra/modules/` lists no GitHub module; `api.github.com` appears only at `templates/apps/warehouse/connectors/github.py:140`; `src/commands/init.ts:166-172` copies the workflows.

**PostHog dashboards**

- ceo (novel): `packages/infra/modules/posthog/index.ts:4-26,44-118`, `registry.json:5-7`; instance `packages/infra/environments/production/roamside-analytics.ts:19-82`, outside CI's `recon` and `tax` (`.github/workflows/production.yml:77,101`), its dashboards recorded at `docs/open-threads.md:303`; `packages/infra/scripts/ph.ts:1-13,29-38`.
- railmid: `docs/analytics/funnel.md:599-602` (82a8f69, 2026-09-01); `packages/infra/scripts/posthog.sh:8-18` (8f3cada, 2026-09-06), five days later, reads with a personal key now in its production `secrets.yaml`.
- leeandco: `docs/adr/0034-the-quote-funnel-events-are-a-contract-the-dashboard-is-built-against.md:10-14`.
- PostHog in the browser: cedarpad, ceo, foothill-metabolic, games, leeandco, railmid, stiqr, varnick-app, web.
- main: `git grep -il posthog main -- packages/cli/templates/infra/` finds nothing; walgit's snippet is `templates/apps/walgit/shared/analytics.ts:83-94`; `zbc secret get` is 0ae98a2.

**OBS Studio**

- ceo (novel): `packages/infra/modules/obs/index.ts:7-34,409-456,494`; `capture.ts:1-27,39-50`, which will not overwrite `profileParameters`, as it cannot read them back; `registry.json:4-11`, which ships `index.ts` and its test but not `capture.ts`; `packages/infra/environments/workstation/obs.ts:9-11` (captured); `zbc.config.ts:9-12` (one Mac); `index.test.ts:1-2,103-112`, whose hand-built context stops before `index.ts:149-150` opens the WebSocket.
- main: `git grep -i -E 'obs-websocket|obsws' main -- packages/cli/` finds nothing; `src/index.ts:19-28` lists every command; an action gets only config and context (`templates/infra/src/types.ts:8`), and `zbc run` takes no other argument (`src/commands/run.ts:20-37`).

**varnick's client estate** (all novel; surveyed at 93d7243, 2026-08-15)

- `client-account`: `packages/infra/modules/client-account/index.ts:13-108,112-198,343-345,365-390,475-492` (creating the account needs a Cloudflare partner entitlement, so a human does it, `:13-33`; `failOnDrift` halts on an undeclared zone and deletes nothing, `:475-492`), `EXIT.md:304-321`.
- `client-domain`: `index.ts:14-64,211-274` (any failed read halts, since a missing domain and a missing grant answer alike, `:43-51`), `purchase.ts:467-474`.
- `client-preview`: `index.ts:23-100,285-314,534-562`, `index.test.ts:1165-1178` (no wrangler, no spawn).
- `client-core`: `index.ts:3-154`, its token resolver's string rule at `:147-152`.
- The citation: outside `vendor/`, `nameServers` appears only in `client-account`; `vendor/zbc/` matches zbc-cli-v0.10.2 by blob hash apart from `modules/turso/index.ts`; `vendor/zbc/src/types.ts:7-11` and that tag's `src/engine/apply.ts:17-22` pass importers raw outputs.
- Lineage: written in foundry from 7d55a3bc (2026-08-05), removed in ab0cede2 (2026-08-08); foundry `packages/infra/environments/ryzen-9-client-isolation.test.ts:70-82` (ef1d3e14). varnick-app: `README.md:8-16`.
- main: actions, `templates/infra/src/types.ts:10-21`; the `library` kind, `src/commands/add.ts:22-31`; "registrar" only at `cloudflare-zone/index.ts:83,664`, `templates/infra/src/types.ts:16` and in `src/commands/run.test.ts`; wrangler, one Worker per instance, at `templates/infra/modules/cloudflare/index.ts:3,74,458,606,802`, and `git grep -E 'FormData|multipart|cfUpload'` over `templates/` and `src/` finds nothing; `OutputRef` at `templates/infra/src/types.ts:105`; their own `apiToken` at `cloudflare-access/index.ts:87`, `cloudflare-tunnel/index.ts:111`, `cloudflare/index.ts:475`, `d1/index.ts:151`, `cloudflare-zone/index.ts:207-212`; `ctx.output` references from 736f8d4 and 948207f, with `ctx.imports` still raw at `templates/infra/src/types.ts:98-100,139`; `cloudflare-api/index.ts:29,52-57,84-103,193-262`; the `--yes` gate at `src/engine/actions.ts:106-114`.

**Closed since 2026-09-02**

- `createTestContext`: `templates/infra/src/testing.ts:53`, exported at `templates/infra/src/index.ts:10`.
- ceo's `packages/infra/modules/vercel/index.ts` is byte-identical to `d82840f:packages/cli/templates/infra/modules/vercel/index.ts`, which feee322 (2026-07-10) deleted; the flatten is `feee322^:packages/cli/templates/infra/modules/vercel/index.ts:269-278`.
