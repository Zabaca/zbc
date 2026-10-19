# distribution-drift — product

**Consumers:** cedarpad, foundry, games, agent-lab, croft, railmid, claude-mitm-proxy, lofi, varnick, ceo, foothill-metabolic, crux, leeandco, web, qom, lov, varnick-app, youbuzz  ·  **Deployed in production by:** all except varnick, which has never run (foundry's live environment is named `ryzen-9`; youbuzz's clone, fetched 2026-05-07, ends at 2026-04-28)

A consumer runs two things that "version independently" (`resolve.ts:83-93`):
the CLI (the engine) and the vendored tree (`vendor/zbc/`, or
`packages/infra/{src,modules}` in copy mode).

## What they needed

- **`zbc update` to leave a tree that loads.** Main recommends it on every
  copy-mode apply (`vendor-stamp.ts:124-135`), as ceo's production log shows.
  On scratch copies it exits 0 but leaves two of ceo's fourteen production
  files, three of foothill-metabolic's seven (inherited from ceo's tree) and
  both of crux's unresolvable: it re-lays modules that import
  `../cloudflare-api` without installing it. Discovery imports every file
  first (`engine/apply.ts:188`, `discover.ts:25-31`), so the next apply stops
  before applying anything. It also swaps ceo's own d1, older than upstream's
  ([d1](./d1.md)), and its cloudflare fork ([cloudflare](./cloudflare.md)) for
  main's, whose cloudflare schema, a plain `z.object`, silently strips the
  Access, R2, D1 or zone keys of six production instances (`engine/apply.ts:60`).
- **The engine pinned to the vendored vintage, and a refusal when they
  disagree.** cedarpad built this and deploys production through it:
  `check-zbc-pin.ts` refuses unless the `zbc-core-v*` tag in
  `vendor/zbc/VENDORING.md` equals an exact `@zabaca/zbc` pin in
  `package.json`, because, unpinned, "the engine converging production was
  decided by the clock". games pins without a check; agent-lab pins only `zbc
  secret get`, which loads no module; foundry pins apart on purpose (CLI 0.7.0
  over `zbc-core-v0.12.0`). The rest, youbuzz aside, run npm's latest, as
  main's scaffold does.
- **Edits inside `vendor/zbc/` to survive an update.** railmid edited
  cloudflare, cloudflare-email and r2 and added d1 and cloudflare-redirect,
  all five in production, inside its prefix: 13 files, none upstream (zbc-core
  has never had a pull request). Replaying `zbc update`'s subtree pull to
  `zbc-core-v0.23.1` stops on ten conflicted files. games went the other way:
  its prefix took zbc's d1 `apiToken` change (30815b1) byte for byte 11.5
  hours before `zbc-core-v0.23.0` shipped it, since zbc-core gets content only
  on `/release` (`.github/workflows/publish-core.yml:7-14`).
- **A retired module to keep working, or to be told it won't.** youbuzz
  (artsmedia-dev, the only consumer outside the Zabaca org) is zbc's origin:
  zbc's first commit, 42de911 (2026-04-24), extracted the CLI, turso and
  vercel youbuzz wrote on 2026-04-10/11. Its modules match zbc's 2026-04-29
  revisions, which took youbuzz's own changes back, so the survey calls them
  `stale`. zbc deleted vercel in feee322 (2026-07-10; last shipped in 0.4.0).
  youbuzz still wires it into production, through an in-repo CLI no npm
  release reaches (as of its last commit we can read, 2026-04-28); ceo's verbatim copy of zbc's has been unused since
  2026-08-18.

## The interface, from 2 implementations

cedarpad (gated) and games (a release-script literal) pin the applying CLI and
share no code; main's stamp (a93d074, 0.16.0) is a separate design.

- **Where they agree:** one exact version, equal to the vendored tag, in the
  repo. cedarpad and main also compare before anything applies, and neither
  reads a missing record as current (`vendor-stamp.ts:137-145`).
- **Where they disagree:** fatal (cedarpad) or "never fatal" (main,
  `vendor-stamp.ts:91-95`); lockstep, or held back (foundry's engine is five
  minors behind); a hand-written `VENDORING.md` or the CLI's
  `.zbc-vendor.json`. Inside the prefix, railmid edits by design (its ADR 21),
  games mirrors upstream, and cedarpad forbids any edit.
- **Copy mode:** no consumer built its own; `zbc add` has the interface.

## What it takes upstream

### 1. Copy-mode `zbc update`

`copy-refresh.ts` reads only npm dependencies from a refreshed manifest
(`:92-111`) and picks built-ins by directory name (`:158-169`). Two offline
changes fix it: walk each manifest's `modules` as `zbc add` does
(`add.ts:207-224`), installing, or at least naming, a missing library
(`update.ts:83-90` names only npm ones); and refresh a same-named directory
only if it has `zbc add`'s `registry.json` marker (`add.ts:244, 272-276`),
naming and skipping the rest, eleven today across ceo, foothill-metabolic,
crux, web, qom, leeandco and youbuzz. `update-copy.test.ts` covers neither. A
marked fork is still re-laid whole, by design, guarded only by the clean-tree
check (`update.ts:69-76`) and "review the diff" (`:93`): three production
forks in leeandco, one in qom.

Copy mode is still `zbc init`'s default (`init.ts:51-56`), kept by the very
ADR-0005:18-20 sentence that rejects it "as the default". Three of the seven
stamps written since 0.16.0 chose it (qom, varnick-app, lov), none saying why.

### 2. Engine and vintage

- **The comparison.** `vendorVintage` compares version strings
  (`vendor-stamp.ts:147-161`), so agent-lab warns though zbc-core's v0.23.0
  and v0.23.1 are one commit, and games' v0.23.0 d1 under a v0.22.0 stamp goes
  unseen. Comparing content with the running CLI's templates answers
  cedarpad's question (`vendor-audit.ts:58-63` walks them, for paths only), and as an
  opt-in refusal like `update --strict` (`update.ts:31-35`) it would spare
  foundry. The vintage line runs only in `apply` (`apply.ts:41-49`), from
  0.16.0, so cedarpad and foundry never see it.
- **The scaffold.** `templates/root/package.json` has no `@zabaca/zbc`;
  `templates/workflows/production.yml:28`, `preview.yml:41,86` and
  `templates/CLAUDE.md:23-28` run it unpinned. The change: scaffold an exact
  devDependency, run it from the workflows, and have `zbc update` move it with
  the stamp, letting a project hold it back.
- **cedarpad's record.** `zbc update` writes `.zbc-vendor.json`
  (`update.ts:110`), never the `VENDORING.md` cedarpad keeps inside its
  prefix, so after a newer CLI's update the gate would still pass and 0.12.0
  would run the newer tree, a skew main says "cannot be fixed from here"
  (`resolve.ts:89-93`). The zbc-core README in every prefix teaches a raw `git
  subtree pull` (`templates/infra/README.md:24-28`), which skips the stamp.
- **Declarations an old engine drops.** A `defineModule` older than 0.16.0
  copies only `apply` and `destroy`, so the engine holds nothing for `ready`
  (`readiness.ts:113-114`), redacts no `secretOutputs`
  (`secret-outputs.ts:198`) and finds no `actions`, though `zbc run`'s hint
  names `vendor/zbc/src` even in copy mode (`engine/actions.ts:88-93`); a CLI
  that old has none of the three. Eleven surveyed consumers vendor one (stiqr
  too), six in copy mode, where `zbc add` keeps an existing `define-module.ts`
  (`add.ts:255-266`). Adding `d1`, `cloudflare-token` or
  `gcp-service-account` there gives a probe that never runs, and the last two
  a credential nothing redacts, flagged only by the generic vintage line; no
  consumer has yet.
- **Tags.** Nine npm versions released before e19c70a (#178) began tagging
  every release have no zbc-core tag. On them `init --subtree` and `update`
  fail without `--core-ref` (`init.ts:86-94`, `update.ts:102-108`), and the
  vintage warning names a tag that does not exist (`vendor-stamp.ts:159`).
  croft, vendoring under 0.21.1 before its tag existed, took v0.19.0, which
  then reads as current. No consumer runs one of the nine; tagging each at its
  release commit's split closes the gap.
- **A hand copy.** varnick hand-copied `vendor/zbc` when `git subtree add`
  could not reach v0.10.2, which now resolves. `update` would take it for a
  subtree (`isVendorMode` checks only for `src/define-module.ts`,
  `subtree.ts:20-23`, and nothing on main reads subtree history) and fail in
  git. Detecting the missing squash commit and printing the conversion would
  serve one consumer, never run and dormant since 2026-08-15.

### 3. Edits inside `vendor/zbc/`

- **What `update` does to them.** The prefix audit (`vendor-audit.ts:58-63`)
  runs only after a successful pull (`update.ts:105-116`), compares paths, not
  content, and skips `*.test.ts`. railmid's pull fails, and resolving it toward
  upstream silently drops `d1Bindings`, `pruneCustomDomains` and r2's
  `lifecycle` from production, since main's schemas lack them
  (`cloudflare/index.ts:456`, `r2/index.ts:33-43`); only the email `zone` key
  fails loudly (`cloudflare-email/index.ts:220`). The change is the content
  check above, run offline on `apply`.
- **Where an edit is meant to go** is the human's call; the docs disagree.
  ADR-0005 makes modules "consumer-editable" (`:21-23`) with contributions by
  `git subtree push` (`:11`). `templates/infra/README.md` says to push and
  open a zbc-core PR (`:30-38`) and not to open PRs there (`:5-7`); ADR-0005
  closes such PRs "on principle" (`:35-36`); `templates/CLAUDE.md:15` forbids
  your own files under the prefix. Two of railmid's commits (#168, #271) and
  cedarpad's a0a6f1b mix prefix and consumer files, which a push half-splits
  (ADR-0005:30-31).

### 4. Retired built-ins

`vercel` appears nowhere under `packages/cli`, and copy-mode refresh leaves a
retired module alone (`copy-refresh.ts:169`) while replacing the `src/` it was
written against. Copy-mode `update` and `apply` could name retired modules and
their last release; that reaches ceo's dead copy, and nothing reaches youbuzz.

Shipping a Vercel deploy again is a product call (would other companies want
one?), and this evidence barely informs it: one lineage, one dormant
production consumer (whether its project still serves is unverified), and
code whose `destroy` reads a 401 as "not found" and whose PRs share one
preview project, deleted by the first to close. Fly, dropped in the same
commit, returned as a `fly deploy` wrapper (ADR-0006), not REST provisioning.

## Evidence

Main is at 0ef349d. Copy-mode results are main's CLI run on a scratch copy of
the snapshot named.

**Copy-mode update**

- ceo (1de32a3): `packages/infra/modules/` has r2, cloudflare-email and d1, no
  cloudflare-api; `environments/production/roamside-email.ts` and
  `tour-guide-cache.ts` stop resolving. `cloudflare` (forked from e83bf83) and
  `d1` have no `registry.json`; dropped keys at `recon.ts:45,50,66`,
  `tax.ts:29,31,36`, `tour-guide.ts:29-30`, `ceo.ts:35`, `claude-sandbox.ts:39`,
  `household-ledger.ts:43`. `.github/workflows/production.yml:77,101` run
  `bunx @zabaca/zbc`; run 39123075056 (deploy-recon, 2026-10-18) prints both
  copy-mode lines.
- foothill-metabolic (1e391b9): the same, with `foothill-email.ts`,
  `foothill-inbox-auth-db.ts` and `foothill-inbox-raw.ts`; its infra package is
  still `@ceo/infra`; `production.yml:62,82`, whose last run (2026-09-06)
  predates 0.16.0, so no run has printed the line.
- crux (dabea8b): own d1, no marker, no cloudflare-api; `production/cloud.ts`
  and `d1.ts`.
- web, qom: own d1, no marker. qom's cloudflare-email is a production fork of
  74c795d with the marker (`production/qualityom-email.ts`).
- leeandco: cloudflare-email, cloudflare-token and r2 diverge with the marker;
  cloudflare-access, cloudflare-zone and d1 have none.
- youbuzz: `packages/infra/modules/turso/` has no `registry.json`.
- main: `r2/index.ts:3`, `d1/index.ts:4` and `cloudflare-email/index.ts:4`
  import `../cloudflare-api`, and each `registry.json` lists it in `modules`.
- Copy-mode stamps: qom 0.16.0 (2026-09-14), varnick-app 0.23.1
  (`deploy/.zbc-vendor.json`, 2026-10-10), lov 0.23.1 (2026-10-15).

**Engine and vintage**

| consumer | vendored | stamp | CLI that applies |
|---|---|---|---|
| foundry | zbc-core-v0.12.0 | none | 0.7.0, `package.json:33` |
| cedarpad | v0.12.0, plus `VENDORING.md` | none | 0.12.0, `package.json:17`, gated |
| railmid | v0.12.0, plus its 13 files | none | unpinned, `README.md:2828` |
| claude-mitm-proxy | v0.15.0 | none | unpinned, `AGENTS.md:59` |
| croft | v0.19.0 (same commit as v0.21.1) | 0.21.1 / v0.19.0 | unpinned, `CLAUDE.md:19` |
| lofi | v0.22.0 | 0.22.0 | unpinned, `CLAUDE.md:19` |
| games | v0.22.0, d1 at v0.23.0 | 0.22.0 | 0.22.0, `scripts/release.mjs:27` |
| agent-lab | v0.23.0 (same commit as v0.23.1) | 0.23.0 | unpinned, `docs/hosting.md:89`; `secret get` at 0.23.0, `tools/data/cli.ts:33` |
| varnick | hand copy of v0.10.2, turso from 8a558a4 (registry mode `hand-copy`) | none | none (no `zbc.config.ts`) |

Each prefix matches its tag file for file except as noted. Beyond foundry and
cedarpad, `docs/consumers/registry.json` records no `@zabaca/zbc` pin
(`cliPin`); games' is the script literal.

- cedarpad: `package.json:12,17`; `packages/infra/check-zbc-pin.ts:1-40, 46-55,
  74-119`; `vendor/zbc/VENDORING.md:28-39`; production deploys through `bun
  run apply` (`packages/canvas/scripts/deploy.sh:134-142`).
- foundry: `CLAUDE.md:183-193, 202-204`, where bumping the engine "is a
  separate decision". 0.7.0 hands modules `{ secrets, imports, projectRoot }`
  (`zbc-cli-v0.7.0:packages/cli/src/engine/apply.ts:22`), the shape v0.12.0's
  `ApplyContext` declares, so the split works.
- games: `scripts/release.mjs:25-27` pins "so a deploy doesn't depend on any
  checkout of zbc". 1c01065 (2026-10-08 04:32:50Z) touches only the prefix and
  is byte-identical to zbc's 30815b1 (04:32:56Z), whose message names games-db
  its first consumer; `zbc-core-v0.23.0` was pushed at 16:00Z. Production:
  `production/games-db.ts:26`.
- croft: `.zbc-vendor.json`, vendored 2026-09-23 05:13Z; publish-core run
  35925510447 pushed `zbc-core-v0.21.1` at 21:57Z.
- varnick: `README.md:50-55`. Without a `zbc.config.ts` every command stops at
  `find-project-root.ts:14`; with one, `update` dies on git's `can't
  squash-merge: 'vendor/zbc' was never added` and `init --subtree` on `prefix
  'vendor/zbc' already exists` (both reproduced in a scratch repo). The
  conversion is `git rm -r vendor/zbc`, commit, `git subtree add … --squash`;
  `zbc-core-v0.10.2` resolves (`git ls-remote`). On main, `git-subtree-dir`
  appears only in tests.
- 0.16.0: `ready` (ae34961), `secretOutputs` (40ef706), `actions` (5521bc7).
  Main declares `ready` in `d1/index.ts:272`, `cloudflare-token/index.ts:332`
  and `gcp-service-account/index.ts:273`, and `secretOutputs` in
  `cloudflare-token/index.ts:237` and `gcp-service-account/index.ts:168`.
- Old `defineModule` (as ceo's `packages/infra/src/define-module.ts:15-20`):
  `vendor/zbc/src/` in cedarpad, foundry, railmid, claude-mitm-proxy and
  varnick; `packages/infra/src/` in ceo, crux, foothill-metabolic, leeandco,
  web and stiqr (copy mode, outside this case, dormant since 2026-07-30).
  youbuzz's is the original zbc extracted, run by its own CLI. No module in
  those trees declares `ready` or `secretOutputs`; the consumers whose modules
  declare `ready` (agent-lab, croft, games, lofi, qom) all run a `defineModule`
  that carries it.
- 0.12.0 over a newer tree: its engine passes `{ secrets, imports, projectRoot
  }` (781333f `packages/cli/src/engine/apply.ts:22`), which the newer
  `defineModule` completes through `ensureApplyContext`
  (`templates/infra/src/define-module.ts:84`).
- npm: 0.16.1–0.16.4, 0.17.0, 0.18.0, 0.19.1, 0.20.0 and 0.21.0, from
  zbc-core's `git ls-remote --tags` against `npm view @zabaca/zbc versions`.

**Edits inside vendor/zbc**

- railmid: subtree added at `zbc-core-v0.12.0` (2aff39b, 2026-08-29). Forks:
  cloudflare from f064805, cloudflare-email from 9224fda, r2 from 9f13268; d1
  converged with upstream (railmid ce97881, 2026-09-05; zbc 7e3ba65,
  2026-09-08); cloudflare-redirect is novel. Commits (2026-09-05 to 09-07):
  23519c2 (#168, 4 of 16 files in the prefix), ce97881 and 9410da7 (prefix
  only), 274248a (#271, 2 of 7). The replayed pull conflicts in cloudflare,
  cloudflare-email and r2, and add/add on d1's three files and r2's test. ADR
  21, "the rule is a field on the vendored module":
  `docs/adr/0021-every-human-match-is-recorded-and-nobody-can-watch-yet.md:191`.
  Production keys: `environments/production/railmid.ts:149-150`,
  `railmid-tapes.ts:45`, `railmid-email.ts:64`. Capabilities:
  [cloudflare](./cloudflare.md), [cloudflare-email](./cloudflare-email.md),
  [d1](./d1.md), [r2](./r2.md), [cloudflare-redirect](./cloudflare-redirect.md).
- cedarpad: a0a6f1b added `vendor/zbc/VENDORING.md`, the only file differing
  from `zbc-core-v0.12.0` (snapshot f95b302), with 15 files outside the prefix.
- zbc-core: one branch, zero pull requests ever.
- main: the audit's `*.test.ts` skip is `vendor-audit.ts:62`.

**Retired built-ins**

- youbuzz (artsmedia-dev/youbuzz at f3e9bac, a local clone last fetched
  2026-05-07): f1a4f99 (CLI and module system, 2026-04-10), 4d4eb96 (turso),
  8b19e1f (vercel, 04-11); its module changes 287b260, 0b2a591, 8ef8c4d
  (04-26/27). zbc's 42de911 "Extracts the zbc CLI … and the infrastructure
  modules (turso, vercel) from the initial youbuzz setup"; a4d2546 shares
  youbuzz's age recipients. c2cd4fc ("Sourced from improvements made in
  artsmedia/youbuzz"), b85f5a6 and 667e033 (04-29) took those changes;
  youbuzz's bbb9aab (04-26) had backported zbc's c31b6bc. Both modules are
  formatting-only matches to d82840f (04-29). Production:
  `environments/production/web.ts:4-18`; `.github/workflows/production.yml:31`
  runs `packages/cli/src/index.ts`. Sharp edges: `vercel/index.ts:48-58,
  344-357`; `environments/preview/web.ts:8`;
  `.github/workflows/preview.yml:88-91`.
- ceo: `packages/infra/modules/vercel/{index.ts,registry.json}`, byte-identical
  to d82840f; no instance since c4f34ba.
- main: `zbc-cli-v0.4.0` is the last tag shipping vercel, and `git grep -il
  vercel` finds nothing under `packages/cli`; feee322 also removed the
  `nats-server` module that deployed to Fly;
  `docs/adr/0006-fly-returns-as-a-deploy-module.md:5-20`.
