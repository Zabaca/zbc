# cloudflare-redirect — new

**Consumers:** qom, railmid (2, independent)  ·  **Deployed in production by:** qom, railmid
**The same need, written as Worker code instead:** web, cedarpad (production); varnick (deployed from foundry until 2026-10-09); read for this case, not survey findings

## What they needed

A zone's Single Redirects, the entrypoint ruleset of the `http_request_dynamic_redirect` phase, declared in an instance file instead of the dashboard. Both instances are the canonical-host redirect: qom's apex-to-`www` 301, and railmid's `www`-to-apex 302, previously a runbook's dashboard step, never taken (180a334). Both chose a zone rule because the edge runs it before any code (qom ADR-0010:23-25) and before the asset layer, which answers railmid's `www` ahead of its Worker (`railmid-redirect.ts:7-10`). No built-in touches rulesets: `cloudflare-zone` converges records and zone settings (main `cloudflare-zone/index.ts:5-15,56-66`), and `cloudflare` runs wrangler.

web keeps the redirect in code because zbc "can neither see nor reproduce dashboard state" (`apps/web/src/lib/apex-redirect.ts:4-7`), so it runs its Worker before every static asset (`apps/web/wrangler.jsonc:42-51`). cedarpad's misses prerendered pages (6b01271) and covers only the homepage. varnick's, written for the same reason (`services/varnick-site/src/index.ts:9-11`), did not survive the move to varnick-app.

## The interface, from 2 implementations

**Independence.** Convergence, not a fork. railmid wrote `cloudflare-redirect` on 2026-09-05 (9410da7), qom wrote `cloudflare-redirect-rules` on 2026-09-30 (86390e3), and nothing in qom's tree or its 68 commits mentions railmid. What they share came from Cloudflare's API (the phase, four status codes, `from_value` body) or from the `cloudflare-zone` both vendor: its zone lookup by name, wrong-account refusal and "as repo state instead of dashboard state" header (main `cloudflare-zone/index.ts:5,680-698`).

**Agreed:** one phase; `accountId`, `zone` by name, `apiToken` as `{ from, output }`, and `rules[]`; per rule `description`, `expression`, a target, `statusCode` and `preserveQueryString`; no `destroy`, deliberately (qom `index.ts:59-60`, railmid `index.ts:22-24`); a 10000 reported as the missing scope (qom `:264-272`, railmid `:146-153`); and a module of its own, not a key on `cloudflare-zone` (qom runs one beside it; railmid runs none), with its own token from `cloudflare-token`, not a widened deploy token (qom `qualityom-redirect-token.ts:9-13`, railmid `railmid-redirect-token.ts:6-12`).

**Disagreed:**

| | qom `cloudflare-redirect-rules` | railmid `cloudflare-redirect` |
|---|---|---|
| Undeclared live rules | reported; deleted only with `allowDelete`, default false (`:28-34,370-384`) | removed by the next apply (`:19-24`) |
| Writes | per rule, then checked by a read-back (`:36-50,337-368,389-402`) | a whole-entrypoint PUT on every apply (`:138-145`) |
| Rule identity | `ref`, required and unique (`:69-73,124-136`) | none: the body is the set |
| Order | not converged; new rules append | as declared |
| Target | `{ value }` or `{ expression }` (`:83-86`) | an expression (`:39`) |
| `preserveQueryString` | required (`:93-98`) | default false; the schema refuses a query carried twice or dropped (`:42-47,77-89,102-107`) |
| `enabled` | always true, undoing a dashboard switch-off (`:162-166`) | a field, default true (`:48-49`) |
| `apiToken` | required import (`:110-114`) | optional, else `CLOUDFLARE_API_TOKEN` (`:26-30,116-119`) |
| Token, beyond Zone Read | Dynamic URL Redirects Read and Write, since it reads first and write does not imply read (`qualityom-redirect-token.ts:24-26`); `zones` set | Write; `zones` unset, as its root lacks Zone Read ([cloudflare-token](./cloudflare-token.md)) |

The first row decides the next three. qom's ADR-0010:26-31 rejects the whole-set PUT because it re-sends every rule the repo does not own, rebuilt from a GET, on every apply; railmid chose it so a dashboard-only rule cannot outlive an apply. On main, every PUT replaces one declared object (`cloudflare-access:892,1025,1138`, `cloudflare-email:407,419`, `cloudflare-token:307`, `cloudflare-tunnel:305-322`), while undeclared members of a zone- or account-wide set others also write are reported or left alone, deleted only on opt-in (`cloudflare-zone:9-15,225`, `cloudflare-access:46-52,232`, `cloudflare-email:109-110,384-412`), and no such set is replaced whole. railmid treats the entrypoint as the first kind, qom as the second. railmid's precedent, its own `r2` lifecycle PUT, which main lacks ([r2](./r2.md)), was forced: that API "has no per-rule endpoint" (railmid `vendor/zbc/modules/r2/index.ts:108`), and the Rulesets API has them. The cross-provider question is [engine-undeclared-state](./engine-undeclared-state.md).

**Where only one went.** railmid's query-string check, a real edge case, composes with qom's required flag; it knows only `http.request.uri` and `.uri.path` (`:83-88`), so a static `{ value }` target would pass unchecked. railmid's `/.well-known/` exclusion, sparing `www`'s HTTP certificate validation, and its 302, still awaiting the planned 301 (`railmid-redirect.ts:31-33,38-42`), are instance policy that fits either schema.

## What it takes upstream

A new module at `packages/cli/templates/infra/modules/<name>/`: `index.ts` converging one zone's entrypoint from the agreed config, `registry.json` with `modules: ["cloudflare-api"]`, and the catalog row in `packages/cli/plugin/skills/zbc/modules.md` that `packages/cli/src/plugin.test.ts:99-101` requires. The parts are on main: the zone lookup and refusal (`cloudflare-zone/index.ts:680-698`), `cf()` with `CfOptions.hints` for the 10000 message (`cloudflare-api/index.ts:133-149`), `ctx.output`, `createTestContext` (`templates/infra/src/testing.ts:53`), and `cloudflare-token`, which resolves permission names at apply time (`cloudflare-token/index.ts:196-201,245-249`). Both modules' tests pass unedited on main's `src/` and `cloudflare-api` (25 of 25, 0ef349d).

Open decisions, each constraining the next:

1. **Undeclared rules removed or reported.** Removal can be one PUT; reporting needs a stable identity per rule, such as qom's `ref`.
2. **Order:** free with a PUT; with per-rule writes, the `position` field qom names and omits (`:52-57`).
3. **`apiToken` required or optional.** Main does both: the zone family requires an import (`cloudflare-zone/index.ts:207-212`), the deploy family falls back to `CLOUDFLARE_API_TOKEN` (`d1/index.ts:134-136`).
4. **Smaller:** `enabled`, the target, and the outputs, which share only `rulesetId`; nothing imports either instance yet.

**The name.** Either existing name collides with one consumer. railmid's `cloudflare-redirect` sits in its subtree prefix ([distribution-drift](./distribution-drift.md)). Until zbc-core ships that path, `zbc update`'s post-pull audit names railmid's `index.ts` and `registry.json` as foreign, fatal under `--strict` (`update.ts:113-116`, `vendor-audit.ts:62,68`); once it does, `git subtree pull --squash` (`subtree.ts:54-56`) stops on an add/add conflict in each file that differs from railmid's. qom's copy-mode `zbc update` would overwrite `cloudflare-redirect-rules`, deleting the non-test files upstream does not ship (`copy-refresh.ts:80-90,158-175`), as qom's header expects (`index.ts:8-14`).

**The bar.** zbc ships to other companies, so whether zone redirects belong in core is a human call. Neither module is specific to its site or to Zabaca; qom's zone is a client's, in the client's own account (qom `CLAUDE.md:3-5`); every redirect here is the canonical-host case; nothing touches another ruleset phase, Bulk Redirects or Page Rules.

## Evidence

- **qom** (copy mode; Zabaca/qom @ 278e207): `packages/infra/modules/cloudflare-redirect-rules/index.ts:5-60,67-136,162-182,226-272,293-326,337-412`, `registry.json:1-11`, apply tests on a stubbed Rulesets API `index.test.ts:159-291`, where a second apply writes nothing (`:200-209`) and an undeclared rule is in no request (`:236-250`); `environments/production/qualityom-redirects.ts:46-64`, `qualityom-redirect-token.ts:9-29,39-47`, and the zone instance beside them, `qualityom-zone.ts`; `docs/adr/0010-www-is-canonical-and-the-apex-redirects-by-rule.md:23-31`. 86390e3 was committed "Not applied", so production rests on the live check. The 301 is the rule's: the Worker has no host redirect and runs first only for `/api/*` and `/admin` (`packages/qom/wrangler.jsonc:36`).
- **railmid** (subtree d4cb29d; Zabaca/railmid @ 2216089): `vendor/zbc/modules/cloudflare-redirect/index.ts:5-31,33-89,93-168`, `registry.json:5,7`, helper and schema tests only `index.test.ts:18-80`; `environments/production/railmid-redirect.ts:7-10,26-68`, `railmid-redirect-token.ts:6-12,21-30,36-43`; no `cloudflare-zone` instance. The module came in the vendor-only 9410da7 ("this subtree goes upstream on its own"), which also edited the vendored `cloudflare` and left `cloudflare-zone` alone. 180a334 declared the instance; its message says the runbook's dashboard rule "had never been clicked". Never upstream: zbc-core has no `modules/cloudflare-redirect`, and no zbc PR mentions it. The test comment at `index.test.ts:4-7` credits the instance gate to Zabaca/games, but the gate is railmid's own `packages/infra/test/redirect.ts`, a path games has never had.
- **Outputs:** qom `rulesetId`, `ruleIds`, `created`, `updated`, `deleted`, `undeclared`, `changed` (`:293-303`); railmid `zoneId`, `zoneName`, `rulesetId` and a `rules` count (`:109-113`).
- **Survey:** `index.json` files the two as one-consumer modules because the names differ. Its `configKeys` are empty for qom (`configSchema` is a top-level const, `:104-123`) and miss railmid's `rules`.
- **Worker code:** web `apps/web/src/lib/apex-redirect.ts:4-21`, `apps/web/wrangler.jsonc:42-51`, `apps/web/src/worker.ts:26,29` (the redirect since b0e8313, 2026-07-30); cedarpad `packages/www/src/middleware.ts:3-13`, `src/pages/index.astro:2-5`; varnick `services/varnick-site/src/index.ts:9-11,80-91`; foundry (on ryzen-9) `README.md:136`, `CLAUDE.md:237-240`, and 2321824d (2026-10-09), which removed `packages/infra/environments/ryzen-9/varnick-site.ts`; varnick-app `site/src/index.ts:4-14`, `site/wrangler.jsonc:2,6-9`, the same Worker name with no redirect.
- **Live, 2026-10-18 (HEAD):** `qualityom.com/x?y=1` → 301 `www.qualityom.com/x?y=1`; `www.railmid.com/` → 302 `railmid.com/`; `zabaca.com/favicon.svg` (web) → 301 `www.zabaca.com/favicon.svg`; `www.cedarpad.com/` → 301, `/why/` and `/changelog/` → 200; `varnick.com/` and `www.varnick.com/` → 200.
- **main (0ef349d):** module paths above are under `packages/cli/templates/infra/modules/`, and `update.ts`, `vendor-audit.ts`, `subtree.ts` and `copy-refresh.ts` under `packages/cli/src/`. `git grep -i -E 'redirect|rulesets|dynamic_redirect'` over `packages/cli/` finds one unrelated comment (`templates/apps/walgit/src/git.ts:27`). The add/add case was reproduced on a scratch subtree: differing content exits 1, identical content merges cleanly.
