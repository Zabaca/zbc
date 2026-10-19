# Consumer cases

What zbc's consumers had to build themselves, mined from every repo in
[`../registry.json`](../registry.json) by the `consumer-mining` skill; derived,
so regenerate rather than edit, with evidence in `.consumer-survey/`. **Run
2026-10-18:** 20 consumers registered, 8 added this run (qom, railmid, lov,
claude-mitm-proxy, croft, lofi, varnick-app, youbuzz), 19 surveyed with zbc as
the baseline. 15 per-consumer reports from 14 consumers, each adversarially
verified: 124 findings, 24 confirmed, 91 amended, 9 added by verifiers, 0
refuted.

## What the survey found

273 consumer modules: 155 current, 73 stale, 18 divergent, 27 novel. Each was
hashed, raw and formatting-normalised, against every revision of every path a
built-in has lived at; any match is our own code (`current` if our newest
revision, `stale` if older) and gets no case, which removed 228 (84%). `stale`
does not say who wrote it first (youbuzz, below), and half the 18 `divergent`
are not edits of the module they are scored against: the seven `d1`s grew from
zbc's `r2`, and leeandco's `cloudflare-access` and `cloudflare-zone` are
siblings of `main`'s.

## Cases

### Fix now

| Case | Consumers | Headline |
|---|---|---|
| [distribution-drift](./distribution-drift.md) | 18, all but stiqr | Copy-mode `zbc update`, recommended on every copy-mode apply, exits 0 yet leaves ceo, foothill-metabolic and crux unable to load production |
| [cloudflare](./cloudflare.md) | 9 | Under the Vite plugin, `bindings` ship the unbuilt Worker and `wranglerEnv` the top-level config (traced, not run); nothing proves a deploy landed |
| [turso](./turso.md) | 1: foothill-metabolic | `migrationsDir` reports success after drizzle silently skips a migration, which took `/admin` down in production |

### Engine and CLI

| Case | Consumers | Headline |
|---|---|---|
| [cli-gaps](./cli-gaps.md) | 12, and zbc's own repo | Ten consumers still read secrets with `sops`; `zbc secret get` reads one key and has one adopter; local stand-ins and change-scoped deploys have no surface |
| [engine-verbs](./engine-verbs.md) | 8 | Actions shipped, but only agent-lab declares one; acts built outside zbc need per-run input and a typed gate |
| [engine-undeclared-state](./engine-undeclared-state.md) | 6 | Live resources no instance declares; six of eleven built-in destroys report a failed delete as success |
| [engine-credential-lifecycle](./engine-credential-lifecycle.md) | 2: agent-lab, cedarpad | Credentials needed in another environment or project move by hand; three built-ins leave theirs undeclared |

### Upgrades

leeandco, a client's site in the client's own Cloudflare account, is in all
six; qom, the same shape, in four.

| Case | Consumers | Headline |
|---|---|---|
| [d1](./d1.md) | 9 | Only qom and games fill the id through `bindings`; open: migrations before the deploy, and keeping production databases out of `zbc destroy` |
| [cloudflare-access](./cloudflare-access.md) | 4: ceo, leeandco, lov, qom | Seven repos run it unedited; built around it: several hosts per application, standalone service tokens, Managed OAuth, a bypass path |
| [cloudflare-token](./cloudflare-token.md) | 4: agent-lab, cedarpad, leeandco, lov | Access-only tokens (8 of 11 minting repos) are proven by `/tokens/verify` alone; nothing keeps a token for a reader outside the apply |
| [cloudflare-zone](./cloudflare-zone.md) | 4: ceo, leeandco, qom, varnick | Never creates a zone, so domains registered outside Cloudflare need one made by hand; swapping a record's type needs a manual delete |
| [r2](./r2.md) | 4: agent-lab, ceo, leeandco, railmid | No `apiToken` reference (a client-account bucket) or lifecycle rules (railmid's tapes); create-before-deploy is closed by composition |
| [cloudflare-email](./cloudflare-email.md) | 3: leeandco, qom, railmid | Forked in production by all three: an imported `apiToken` and `zoneId` (leeandco, qom), a zone by name (railmid); `main` drops `apiToken` silently |

### New modules

| Case | Consumers | Headline |
|---|---|---|
| [host-modules](./host-modules.md) | 3: cedarpad, claude-mitm-proxy, foundry | Two recur: owning part of a file another writer edits, and checking that the running process took a change |
| [cloudflare-redirect](./cloudflare-redirect.md) | 2: qom, railmid | A zone's Single Redirects: two independent live modules, split on removing or reporting undeclared rules |
| [tailscale](./tailscale.md) | 2: claude-mitm-proxy, foundry | Auth keys minted only when a device needs one, the policy file written under `If-Match`, serve routes on a shared node |
| [incus](./incus.md) | 1: foundry | The daemon end of `vm`'s remote target, live on ryzen-9; `main` ships only the client half |

### Parked

Recorded for the call against [CLAUDE.md](../../../CLAUDE.md)'s bar: would
most software companies want it?

| Case | Consumers | Headline |
|---|---|---|
| [single-consumer-modules](./single-consumer-modules.md) | 4: ceo, crux, leeandco, varnick | Cloudflare account membership, a required check on `main`, PostHog dashboards, OBS, varnick's never-run client estate |
| [gcp](./gcp.md) | 2: ceo, foothill-metabolic (one lineage) | `main` declined the Calendar half; the `gcp-service-account` it shipped has no adopter, and closing any PR would delete a shared preview account |

## Closed since 2026-09-02

Most landed 2026-09-06 to 09-08 and shipped in zbc-cli-v0.16.0. Each line:
what closed it → where the rest lives. The three retired cases' files are
deleted.

- **cli-gaps**: `secret get`, `apply --json`, `zbc list` (0ae98a2) → [cli-gaps](./cli-gaps.md)
- **cloudflare**: the secret push (dbb60d4); zone and Access kept out ([ADR-0016](../../adr/0016-zone-and-access-do-not-belong-in-the-deploying-module.md)) → [cloudflare](./cloudflare.md), [cloudflare-access](./cloudflare-access.md), [cloudflare-zone](./cloudflare-zone.md), [r2](./r2.md)
- **cloudflare-token**: `rootTokenSecret` (6d23700), readiness (ae34961) → [cloudflare-token](./cloudflare-token.md)
- **d1**: the module (7e3ba65), `bindings` (946d0bd), `apiToken` (30815b1) → [d1](./d1.md)
- **distribution-drift**: stamp, vintage line, copy-mode `update` (a93d074); a core tag per release (e19c70a) → [distribution-drift](./distribution-drift.md)
- **engine-api-consistency**, retired: readiness ([ADR-0013](../../adr/0013-readiness-is-a-precondition-of-the-imports-edge.md)) → [cloudflare-token](./cloudflare-token.md), [gcp](./gcp.md), [distribution-drift](./distribution-drift.md)
- **engine-credential-lifecycle**: secret outputs ([ADR-0016](../../adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md)) → [engine-credential-lifecycle](./engine-credential-lifecycle.md), [tailscale](./tailscale.md)
- **engine-output-wiring**, retired: `bindings` ([ADR-0014](../../adr/0014-a-binding-is-filled-in-by-the-deploying-module.md)) → [cloudflare](./cloudflare.md), [d1](./d1.md)
- **engine-shared-module-code**, retired: the `library` kind ([ADR-0015](../../adr/0015-a-library-is-a-registry-kind.md)) → [distribution-drift](./distribution-drift.md)
- **engine-verbs**: actions ([ADR-0017](../../adr/0017-a-third-verb-and-a-value-typed-imports-edge.md)) → [engine-verbs](./engine-verbs.md), [engine-undeclared-state](./engine-undeclared-state.md)
- **gcp**: `gcp-service-account` (5b8d011) → [gcp](./gcp.md)
- **single-consumer-modules**: `createTestContext`, the `library` kind → [single-consumer-modules](./single-consumer-modules.md); foundry's modules to [host-modules](./host-modules.md), [tailscale](./tailscale.md), [incus](./incus.md); leeandco's to [cloudflare-access](./cloudflare-access.md), [cloudflare-zone](./cloudflare-zone.md), [cloudflare-email](./cloudflare-email.md); `vercel`, zbc's own deleted module, to [distribution-drift](./distribution-drift.md)

## Reading order

Start with [distribution-drift](./distribution-drift.md): most of what the last
run asked for shipped but has not reached consumers, and twelve cases link to
it. Then the live defects in [cloudflare](./cloudflare.md) and
[turso](./turso.md), and [engine-undeclared-state](./engine-undeclared-state.md),
also linked from twelve. Read the Cloudflare upgrades together; new and parked
cases come last, each leaving the bar question to a human.

## Caveats

- **Deployed**, in a case, includes scripts outside zbc (claude-mitm-proxy's
  installers, crux's `gh api` ruleset); varnick has never run.
- **The survey was fixed this run**: it indexes every path a built-in has lived
  at, deleted ones included, and scans `.mjs` files and `sops` and `gh api`
  calls, turning ceo's and youbuzz's `vercel` from novel into stale.
- **youbuzz**, outside the Zabaca org, is where zbc's CLI and module system
  began (f1a4f99, 2026-04-10, before zbc's first commit, 42de911, on
  2026-04-24); zbc took over its `vercel` and later deleted it, while youbuzz's
  production environment still declares it (as of its last commit we can read,
  2026-04-28). Its `stale` modules are the originals.
- **railmid edits zbc's modules inside `vendor/zbc/`**: 13 files in five
  modules, all in production, none upstream; a subtree pull conflicts on ten.
- **youbuzz and agent-lab are surveyed off local clones**: youbuzz's GitHub
  repo is unreadable to us, agent-lab's a diverged leftover.
- **Some implementations are one lineage**, counted once: ceo and
  foothill-metabolic share a tree; both `d1` lineages start from zbc's own
  `r2`; qom copied leeandco's; varnick's were written in foundry.

## For a human

1. **Live check:** do `bindings` and `wranglerEnv` misdeploy under the Vite
   plugin, as traced? One plugin-built deploy settles it
   ([cloudflare](./cloudflare.md)).
2. May `zbc destroy` reach a production database, and if not, is the guard an
   engine option or each module's ([d1](./d1.md))?
3. Where should a consumer's edit to vendored code go, given railmid edits
   inside `vendor/zbc/` and zbc's docs disagree
   ([distribution-drift](./distribution-drift.md))?
4. Do other companies keep API tokens at rest, or share one account root across
   repos ([cloudflare-token](./cloudflare-token.md),
   [engine-credential-lifecycle](./engine-credential-lifecycle.md))?
5. Keep ADR-0017's `--yes` gate, or demand a typed value as crux and varnick
   built ([engine-verbs](./engine-verbs.md))?
