# cloudflare-access — upgrade

**Consumers:** ceo, leeandco, qom, lov  ·  **Deployed in production by:** ceo, leeandco, qom, lov
**Independent implementations:** 3 (ceo, leeandco, lov); qom's workaround is two built-in instances.

*main* is `packages/cli/templates/infra/modules/cloudflare-access/index.ts` at 0ef349d.

## What they needed

Deciding in the repo who may reach a hostname, before it serves anything. Main's module does all of it but create the organisation, a console step (main :996-998), and cedarpad, claude-mitm-proxy, games, lov, qom, railmid and web run it unedited in production. All nine repos are Zabaca-run; leeandco and qom are in clients' Cloudflare accounts, the other seven in Zabaca's, which has one Zero Trust organisation.

### 1. One application over several hosts (open: leeandco, qom)

leeandco's cutover left `/admin` answering 403 on the apex and `www` until `additionalDomains` (2471ce2, 2026-10-07). qom, a week earlier and barred from editing its vendored copy, added a second application and audience in its Worker, as the next PUT would wipe a dashboard-added hostname. railmid and web redirect to one host instead; qom also redirects, but gates its apex in case the redirect goes. Main writes one `domain` (main :148) and no `destinations` (main :627-644).

### 2. A service token with its own lifecycle (partly closed: leeandco, ceo)

Main mints a token inline, rotating only under `rotate: true` (main :184-197, :1049-1076), for railmid and web in production and cedarpad's workspace, and admits one minted elsewhere (main :175-183).

- **No built-in mints a token apart from an application**: sharing one means referencing another application instance's `serviceTokenId` (main :803). leeandco's module mints one alone, in production but unused since its CLI was deleted on 2026-09-09. Main fixes the duration at 8760h (main :1055) and the printed key names (main :769-773) and outputs no expiry; ceo names its pairs per application and notes expiry in comments.
- **A missing name is minted** and printed (main :1052-1060). ceo mints in the dashboard and refuses unknown names; foundry got that refusal from main until 2026-09-09 by withholding Service Tokens Write, against main's instructions (main :83-85).
- **Revocation is all or nothing.** ceo's empty list deletes just the token policy (1de85e3, after an empty list left production admitting a token) and leaves other policies alone, household-ledger's hand-added token policy among them. Main reports those as DRIFT on every apply, and `allowDelete` deletes them all (main :1162-1184).

`clientSecret` is printed (main :769-773) and returned undeclared (main :807, :1215): no `secretOutputs` entry, so no `rotates: 'never'` (40ef706). That is [engine-credential-lifecycle](./engine-credential-lifecycle.md)'s.

### 3. The Zero Trust organisation (partly closed: ceo, leeandco, qom)

Main compares `teamDomain` with the live `auth_domain`, refusing a mismatch, and writes only `orgName`, echoing that domain (main :38-44, :854-861, :867-895; [ADR-0016, zone and Access](../../adr/0016-zone-and-access-do-not-belong-in-the-deploying-module.md):53). Only ceo writes `auth_domain`, replacing the team name Cloudflare generated, `falling-snow-60b6` (0ac806d).

- **Every application instance carries the organisation fields** (main :29-36), the arrangement ADR :33 rejected for `cloudflare`: two different `orgName`s rename the organisation on every apply. Conventions hold: ceo declares the organisation on one instance, qom on both with a test pinning them equal, railmid (copied by games and cedarpad), claude-mitm-proxy and lov only `teamDomain`, and web, in Zabaca's account, `identityProviders` too. So recon, "the only instance using Access" by its own comment, alone writes the name and `auth_domain` that six other repos' Workers take their issuer from.
- **`identityProviders` accepts only `onetimepin`** (main :139), the one provider needing no configuration by main's comment (main :129-132); leeandco relies on `cloudflare` too, saying the same of it. Neither claim has been checked against the API.

### 4. Managed OAuth for an MCP client (open: lov)

lov's MCP server signs people in through Access Managed OAuth, which `cloudflare-access` has no key for. Its seven-field body (main :627-644) is PUT on every apply (main :1018-1025), a full replace by its own comment (main :212-214), so lov assumes `oauth_configuration` is dropped and has a second instance, importing `lov-access`, re-PUT the application with it set. Neither repo tests the drop, and main, comparing only the body's keys, would not report it (main :669-684). lov's own targeted applies never run that instance (`packages/cli/src/engine/resolve.ts:37-55`), and a full apply, ordering siblings as discovered (`discover.ts:25-29`), deploys the Worker before it on lov's machine.

### 5. A path Access steps aside for (open: ceo)

recon's runner cannot hold a browser session, so ceo's `bypassPaths` makes `recon.zabaca.com/api/runner` its own application with a `bypass` policy over `everyone`, and the Worker checks a bearer token. ceo's module calls a service token "the tighter answer", skipped because the secret is shown once (2d480e5) and still skipped once a4d7037 admitted hand-minted ones. claude-mitm-proxy, with machine paths on its gated host too, gates only the browser path. Main cannot express a bypass: `decisionFor` returns `allow` or `non_identity` (main :392-394), a matched policy deciding `bypass` (`index.test.ts:155-160`) or including `everyone` (main :304-324) is rewritten, and an application with no principal is refused (main :239-252), the limit foundry's census also records ([engine-undeclared-state](./engine-undeclared-state.md)). The tighter answer works on main, a path-scoped application (main :143-148) admitting a service token, once the runner and recon's deploy script send its headers.

### 6. Access before the deploy, and `aud` into the Worker (closed by composition: ceo)

ceo moved its Access ahead of `wrangler deploy` and deploys `aud` as `CF_ACCESS_AUD`, which tax's Worker checks (ae11c05, 2026-10-09). Main does it by import, per ADR-0016 (ed8ce39; ADR :27): imports apply first (`resolve.ts:159-203`), `aud` (main :784) reaches the Worker as a `workerVars` reference (`templates/infra/modules/cloudflare/index.ts:165-180`, `:725`), and a blank one fails at the importer (`templates/infra/src/context.ts:79-83`). Eight repos wired it, five through `workerVars` and railmid through `workerSecrets`, copied by games and cedarpad, yet nothing documents it (`packages/cli/plugin/skills/zbc/wiring.md:109-111` names `cloudflare-access` only as an `apiToken` example) or flags a routed Worker that imports no Access instance.

## The interface, from 3 implementations

ceo's Access, inline in its `cloudflare` fork (ad586ad, 2026-07-30), and leeandco's module (62f2288, 2026-08-14) were written apart, with different code and names, by one operator. Main's began as foundry's machine-only module (04a73e1, 2026-08-19) and took leeandco's design in 7600753, so leeandco and main count once, and both `divergent` verdicts are convergence comparisons. lov's module only sets one application field (§4).

**Agreed by ceo and leeandco, kept by main:** the application found by `host/path`, PUT idempotently, never destroyed; people on an `allow` policy of emails, machines on a separate `non_identity` one, each found by name; a service token created once, matched by exact name, never rolled by an apply, its secret shown once and stored by hand in `secrets.yaml`; the Worker verifying the assertion against the application's `aud`.

**Where they part** is §1 to §5, plus `apiToken`: ceo reads `CLOUDFLARE_API_TOKEN` from `secrets.yaml`, where leeandco and main take only an import (main :87; [cloudflare-token](./cloudflare-token.md)). ceo has not moved to the built-in. leeandco could, given `additionalDomains`, by pinning `appLauncherVisible: false` and `serviceTokenPolicyName: 'the CLI'`, where main's defaults differ (main :219, :617-624).

## What it takes upstream

Each change stands alone.

1. **`additionalDomains`**, as leeandco's: `host/path`s, each with a path, sent with `domain` first as `destinations`, while `findApp` keeps matching `domain` (main :722-730); `appDiffers` compares whatever the body carries (main :665-667), so `destinations` needs normalising like `domain` (main :676-681). Two client back offices need it; the bar question is whether companies outside Zabaca serve one admin on several hostnames rather than redirect.
2. **`oauthConfiguration`**, sent as `oauth_configuration`, the fix lov's module names. Carrying forward undeclared fields instead would change what converging an application means. One consumer, a two-person app.
3. **Service tokens**: either a `cloudflare-access-service-token` module on leeandco's shape (`name`, `duration`, `secretKeys`, `storeHint`, `apiToken` in; `tokenId`, `clientId`, `expiresAt` out; no secret output, rotate or `destroy`), one consumer, its token unused; or, inline, a `duration` key, an `expiresAt` output, configurable printed names and a refusal for a missing name. Revoking the token policy alone would be a scoped deletion beside `allowDelete`.
4. **The organisation**: either document one instance per account declaring `orgName` and `identityProviders` (in the header and `registry.json`), `teamDomain` staying on every verifying instance as it is only compared and the output copies it (main :1204); or an organisation module that application instances import `teamDomain` from. Add `cloudflare` to `identityProviders` if it needs no configuration. Writing `auth_domain` stays out: only ceo asks.
5. **A bypass decision**: `bypassPaths`, or a declared `bypass` policy over `everyone` on a path-scoped application, which the no-principal refusal would have to count as a way in. One consumer, one path, and a working alternative (§5).
6. **`packages/cli/plugin/skills/zbc/wiring.md`**: importing the Access instance from the deploying one and passing `teamDomain` and `aud` through `workerVars`.

## Evidence

Instance files are under `packages/infra/environments/production/` and modules under `packages/infra/`; other paths are from the repo root.

- **ceo**: the survey's `divergent` for its `cloudflare` is against e83bf83 (2026-07-14), which has no Access code; the Access half is ceo's own (ad586ad, 2026-07-30), so a convergence, not a fork.
  - `modules/cloudflare/index.ts`: bypass :250-264, :428-445 ("the tighter answer" :260-262, hand-minted tokens :269-273); revocation :282-295, :489-492; ahead of the deploy, with `CF_ACCESS_AUD`, :388-393, :503-504; organisation :395-404; unknown name refused :471-479; `CLOUDFLARE_API_TOKEN` from secrets :304-305.
  - `recon.ts:53-69` ("the only instance using Access" :62), `tax.ts:43-44`, `household-ledger.ts:25-31` (the hand-added token policy), `ceo.ts:39-40`; `packages/recon/test/core.test.ts:233-263`; `packages/recon/scripts/deploy.sh:66`, `:138`; `packages/tax/src/access.ts:128`.
  - Commits 2d480e5 and 0ac806d (2026-07-30), a4d7037 and 1de85e3 (2026-08-22), ae11c05 (2026-10-09). Production run 38001135751 (2026-10-09) logged the organisation, the application, the bypass and both policies.
- **leeandco**: its `cloudflare-access` (62f2288, 2026-08-14) predates the survey's nearestRev 7600753, which ported it: a convergence, not a fork.
  - `modules/cloudflare-access/index.ts`: `additionalDomains` :197-218, :533-545, :826-836 (2471ce2, #40, 2026-10-07); the two pins :251, :835; imported `apiToken` :264.
  - `modules/cloudflare-access-service-token/index.ts:10-39`, `:109-152`, `:214-304`, novel (3187025, 2026-08-16), applied by `leeandco-cli-service-token.ts:7-14`, `:37-99`.
  - `leeandco-access.ts:87-97` (client account, `auth_domain` never written), `:135-141`; `docs/runbooks/cutover.md:22-26`.
- **qom** (built-in, `current`; no CI): `qom-access-apex.ts:9-27` (editing the vendored module not allowed, :24-25), `:34-35`, `:48-52` (f1086c3, 2026-09-30); `qom.ts:79-81`; `CONTEXT.md:217-218`.
- **lov** (built-in, `current`; no CI, and the repo records no apply): `modules/access-managed-oauth/index.ts:10-60`, novel (d3954a0, 2026-10-16); `lov-access-oauth.ts:20-34`, importing `lov-access` at :33; targeted applies `lov.ts:13`, `lov-access.ts:20`; on the machine lov deploys from, discovery returns `lov.ts` before `lov-access-oauth.ts`; `packages/lov/src/mcp.ts:5-11`; `PRODUCT.md:9`.
- **The other built-in users**, `current` (claude-mitm-proxy, games) or `stale` (cedarpad, railmid, web) in the survey:
  - inline token: railmid `railmid-access.ts:48-57`, web `web-access.ts:75-101`, cedarpad `packages/infra/environments/workspace/ws-access.ts:63-75`;
  - redirect first: railmid `railmid-access.ts:21-23`, web `web-access.ts:59-63`;
  - `teamDomain` alone: railmid `railmid-access.ts:36-41`, games `games-access.ts:17-20`, cedarpad `admin-access.ts:22-26`, claude-mitm-proxy `fleet-access.ts:17-27`, lov `lov-access.ts:15-18`; web declares `identityProviders` at `web-access.ts:103-108`;
  - browser path only: claude-mitm-proxy `fleet-access.ts:7-10`.
- **`teamDomain` and `aud` into the Worker**: through `workerSecrets` at cedarpad `canvas.ts:98-99`, games `games.ts:32-33` and railmid `railmid.ts:140-141`; through `workerVars` at claude-mitm-proxy `fleet.ts:47-48`, leeandco `leeandco.ts:190-191`, lov `lov.ts:25-26`, qom `qom.ts:79-81` and web `web.ts:49-50`. railmid is named as the model at games `games-access.ts:4-6` and cedarpad `canvas.ts:95-97`, `admin-access.ts:24`.
- **foundry** (witness): `packages/infra/environments/ryzen-9/access-token.ts:37-44`; `packages/infra/environments/ryzen-9-live-access-applications.test.ts:140-149` (the census entry), `:170-179` (agent-host decommissioned 2026-09-09).
- **main** 0ef349d: `index.test.ts` sits beside the module, `resolve.ts` and `discover.ts` are in `packages/cli/src/engine/`, and `templates/` is under `packages/cli/`. ADR-0016, zone and Access, :50-56 finds the last run's three Access asks (the `non_identity` rule, the `auth_domain` echo, a no-sign-in warning) already on main, from 04a73e1 and 7600753 (#39). `git grep` finds no Access use of `bypass`, `destinations` or `oauth_configuration` in `packages/cli/templates/` or `packages/cli/src/` beyond that test, and no call to `access/service_tokens` outside this module.
