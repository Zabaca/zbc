# gcp — new

**Consumers:** ceo, foothill-metabolic (one lineage)  ·  **Deployed in production by:** foothill-metabolic

## What they needed

The Foothill scheduler books sessions onto a Google Calendar a service account owns and checks a person's primary calendar through a free/busy share to the account. It chose a service account over an OAuth refresh token for least privilege and no silent token expiry on a customer-facing endpoint (foothill `docs/decisions/0017-own-scheduling-replace-reclaim.md:38-42`). One `gcp` apply creates the account if absent, mints a key and, as that key, finds or creates the calendar; the Worker gets `saKey`, `saEmail` and `calendarId` as `GCAL_*` secrets. Minting the deployer key, enabling the Calendar API and granting the share stay manual, the last with the person's own OAuth credential (`gcp/index.ts:10-12,23-25`; `production/gcal.ts:11-12`).

## The interface, from 1 implementation

One implementation in two copies: foothill's is byte-identical to ceo's, carried over when foothill was extracted on 2026-07-27, and main's `gcp-service-account` descends from it (`index.ts:16-22`). None of it is convergence.

**The Calendar half.** `calendarSummary` is title and identity: apply finds the calendar by exact title, so a rename creates a second and leaves the first (`gcp/index.ts:157-176`). `calendarTimeZone` (default `America/Los_Angeles`) is set only at creation. The output is `calendarId`; there is no `destroy` (`:180`).

**The service-account half** has the same keys on both sides, `projectId`, `serviceAccountId`, `displayName`, `maxKeys` → `saEmail`, `saKey`. Main names the bootstrap key with `credentialSecret` where the consumers hard-code `GCP_DEPLOYER_KEY` (`index.ts:151`; `gcp/index.ts:100-101`), defaults `maxKeys` to 3, not 5 (`index.ts:148`), prunes before the mint rather than after (`index.ts:62-86`; `gcp/index.ts:131-143`), makes `displayName` optional, limits `serviceAccountId` to 6-30 characters (`index.ts:135-142`), and adds a `saKeyId` output and a `destroy` (`index.ts:297-314`).

## What it takes upstream

### The Calendar half

A consumer can write it today, with no zbc change, as a module importing `gcp-service-account` (`index.ts:19-22`). It imports `gcp-api` (`plugin/skills/zbc-module/SKILL.md:37`), reads `saKey` with `ctx.output` (as `cloudflare-access/index.ts:87,817` and `d1/index.ts:135,151` read `apiToken`), and drops its token-grant retry (`gcp/index.ts:145-156`) for the readiness gate (`engine/apply.ts:86-91`; `gcp-service-account/index.ts:273-285`). No test runs a dependent against this module (`engine/apply.test.ts:302` is generic; `index.test.ts:326-342` calls the probe directly), and no example dependent ships.

Upstream it would be a new `google-calendar` module with `"modules": ["gcp-api"]` and a Calendar API base beside `IAM_API` (`gcp-api/index.ts:17`), leaving the bootstrap manual as main does for enabling an API (`gcp-service-account/registry.json:12`). Open: identity by title, a time zone never converged, and whether a calendar gets a `destroy` now its account has one.

The bar question is whether most companies running zbc would provision a calendar a service account owns. One lineage and one application want it. Main declined it in 5b8d011, and a test pins both key sets (`index.test.ts:344-365`). ADR 0017 deferred a zbc `gcp` module "until a second GCP resource exists" (`0017-own-scheduling-replace-reclaim.md:41-42`); ceo wrote one the same day and never revised the line. No surveyed consumer provisions another Google resource; the fleet's other Google use is runtime API calls and OAuth consent scripts.

### gcp-service-account, as foothill would meet it

No surveyed consumer instantiates it, nor does zbc; foothill is the one that would.

**A PR-shared preview account is deleted when any PR closes.** foothill's preview shares one account, apart from production, across every open PR (`preview/gcal.ts:6-9,18`), and `zbc destroy preview` removes a PR's Worker and database when it closes (`.github/workflows/preview.yml:80-97`). The account survives only because foothill's module has no `destroy`. Main's has one, `zbc destroy` runs every instance's (`engine/destroy.ts:53-58`), and main's shipped workflow runs it on PR close (`packages/cli/templates/workflows/preview.yml:69-86`), so closing one PR would delete the account every other open preview signs in as.

Main's guidance, one account per environment with `ephemeral: true` for preview (`index.ts:37-42,129-134`; `registry.json:12`; `README.md:222`), is foothill's setup plus a flag that would also delete a shared account on every apply. The engine allows it: only `rotates: 'never'` blocks `ephemeral` (`engine/resolve.ts:128-140`), and `saKey`'s `'each-apply'` assumes no holder outside the run (`src/types.ts:216-219`), though every other open PR's Worker is one. The change is one of two:

- **Per-PR accounts**, main's generic preview rule (`plugin/skills/zbc/SKILL.md:123-126`), which this module mentions only to skip IAM's undelete (`index.ts:292-295`). They make the destroy safe, but each needs its free/busy share granted by hand (`preview/gcal.ts:11-12`), by the person's OAuth credential held in CI, or skipped, in which case preview ignores the primary calendar.
- **A way for an instance to stay out of `zbc destroy`**, which [d1](./d1.md) records for a database. The shared account then caps the previews holding a working key at `maxKeys`, at most 10, Google's ceiling (`index.ts:145-148`).

Preview and production can also share an account, since each apply sees one environment (`engine/apply.ts:188`), and at the default `maxKeys` three preview applies in a row delete production's live key. That is [engine-credential-lifecycle](./engine-credential-lifecycle.md)'s.

**The header comment misdescribes a retry.** `index.ts:32-35`, `README.md:214` and `src/types.ts:61-66` make a new account's 404ing keys endpoint `ready`'s job. `apply` retries it by design (`index.ts:99-103,230-239`), as the consumers do (`gcp/index.ts:117-126`); `ready` proves the minted key gets a token (`index.ts:266-285`), as `README.md:222` says. The fix is to those three passages.

Adopting it also takes `zbc update`, since foothill's `defineModule` predates `ready` and `secretOutputs` and drops both ([distribution-drift](./distribution-drift.md)). The update brings main's `cloudflare` (`utils/copy-refresh.ts:158-169`), which takes an explicit `{ name, from, output }` per secret (main `cloudflare/index.ts:44-54`) where foothill's syncs `GCAL_*` from imports implicitly (foothill `cloudflare/index.ts:202-214`), and nothing upstream emits `calendarId`. `credentialSecret: 'GCP_DEPLOYER_KEY'` and `maxKeys: 5` keep foothill's key name and retention, though ceo calls the project holding both accounts legacy (ceo `CLAUDE.md:315-317`).

## Closed since 2026-09-02

- **No Google module:** `gcp-service-account` and the `gcp-api` library for the JWT grant (ADR-0015), 5b8d011 (#132, 2026-09-08), in 0.16.0.
- **Welded halves:** ordering was never the gap; a new key the token endpoint refuses was, and the readiness gate (ADR-0013) with this module's probe now covers it.
- **A minted key on disk:** `saKey` is a secret output (ADR-0016).
- **No `destroy`:** closed the other way; the next apply undeletes the account (`index.ts:203-214`).

## Evidence

- ceo: `packages/infra/modules/gcp/index.ts:5-26,79-98,100-180`, written in 0e24a4f on 2026-07-16, the day ADR 0017 landed (31d1378). Unapplied since 3f5ef1d (2026-07-27) removed both `gcal.ts` instances with foothill.
- foothill-metabolic: the same file, via e97dc04 (2026-07-27).
  - Instances `packages/infra/environments/{production,preview}/gcal.ts:3-22`, imported by `production/foothill-metabolic-cf.ts:3,46-47` and `preview/foothill-metabolic-cf.ts:3,49,52-54`, read by `packages/foothill-metabolic/src/lib/gcal.ts:1-13,37-42`.
  - `.github/workflows/preview.yml:80-97`, `packages/infra/environments/preview/turso.ts:7-13`, `packages/infra/src/define-module.ts:4-20`, `packages/infra/modules/cloudflare/index.ts:202-214`.
  - Production: `.github/workflows/production.yml:59-62` applies it as a dependency of `foothill-metabolic-cf`; the last successful run, 32630528738 (2026-08-23), applied `gcp:gcal` and set the three `GCAL_*` secrets.
- Vendored at main's current revision, never instantiated: agent-lab, croft, games and lofi, at `vendor/zbc/modules/gcp-service-account/`.
- Other Google use, none of it provisioning: foundry `services/pipeline/scripts/gmail-oauth.ts`, `services/pipeline/scripts/google-ads-oauth.ts` and `services/pipeline/packages/pipeline/src/zabaca_data/dlt_sources/gmail_source/helpers.py`; ceo `scripts/gmail-draft.ts`; leeandco `packages/leeandco/src/lib/address-autocomplete.ts:1-8`, a Maps browser key.
- Fork reading: novel in both, one lineage, not a fork.
- main paths: bare `index.ts`, `registry.json` and `index.test.ts` are in `packages/cli/templates/infra/modules/gcp-service-account/`, beside `cloudflare/`, `cloudflare-access/`, `d1/` and `gcp-api/`; `src/types.ts` is under `packages/cli/templates/infra/`; `engine/` and `utils/` are under `packages/cli/src/`; `plugin/` is `packages/cli/plugin/`; `README.md` is the repository root's.
