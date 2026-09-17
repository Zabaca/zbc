# cloudflare — upgrade

**Consumers:** ceo, foothill-metabolic (2 independent implementations)
**Deployed in production by:** both
**Forked from:** `e83bf83` (both)

## What they needed

Two unrelated things, and the first is a live defect.

### 1. `wrangler secret put` targets a script that does not exist

Upstream sends **both** flags (`index.ts:537-539`):

```ts
const secretArgs = ['secret', 'put', name]
if (config.wranglerEnv) secretArgs.push('--env', config.wranglerEnv)
if (config.workerName) secretArgs.push('--name', config.workerName)
```

Wrangler derives the legacy `<name>-<env>` script from `--env` and ignores
`--name`. So whenever an instance sets both, every secret lands on a phantom
script while the deploy serves the real one — and `wrangler` exits 0.

The deploy path at `:499-500` has the identical shape and survives it only
because `:515-522` asserts on wrangler's `Deployed …` output. The secret push
has no equivalent check. That asymmetry is the bug.

Both consumers found it in production, independently:

- **foothill, 2026-07-16** — GCAL secrets landed on a nonexistent
  `foothill-metabolic-production` while the deploy served `foothill-metabolic`.
  Fix: `--name` alone when `workerName` is set, `--env` only as fallback
  (`packages/infra/modules/cloudflare/index.ts:190-197`, `:215-219`).
- **ceo** — same conclusion, recorded at `index.ts:348-352`.

Similarity 0.953 on foothill's fork: this is a two-line change carrying two
production incidents.

### 2. Account- and zone-scoped state the Worker sits inside

ceo's fork is 545 lines against the 242 they took. Everything added is state
*around* the Worker, not the Worker: zone settings, Zero Trust org identity,
Access applications and policies, and pre-deploy R2 bucket creation.

Two outages drove it, both recorded in their comments:

- `always_use_https` was off on roamside.com, so `http://` served a non-secure
  context and killed Geolocation — **8 of 8 insecure drives produced zero
  chapters** (`index.ts:155-160`).
- **recon.zabaca.com was public for twenty minutes on 2026-07-30** because
  Access was a manual dashboard step (`index.ts:171-180`).

They also learned that Access `service_token` includes require
`decision: 'non_identity'` — adding one to an `allow` policy silently does
nothing and the request still redirects to login (`index.ts:243-258`).

Their whole diff is deliberately forward-only: `destroy` never touches zone
settings or Access, with one exception — an empty `serviceTokens` deletes the
machine policy (`index.ts:259-271`).

## The interface, from 2 implementations

Both agree on the six core keys. ceo alone adds `zoneName`, `zoneSettings`,
`access`, `accessOrganization` — it folded zone and Access config into the one
module rather than composing `cloudflare-zone` and `cloudflare-access` as
separate instances. That is a real architectural question for zbc, not a
preference: see [engine-output-wiring](./engine-output-wiring.md) for why
cross-module ordering pushed them there.

foothill's fork predates `r2Bindings`/`workerVars`, so its `wrangler.jsonc`
hardcodes the R2 bucket name, the D1 `database_id`, a `TELEGRAM_CHAT_ID` var
and a custom-domain route. That is staleness, not a gap.

## What it takes upstream

1. **Send `--name` alone when `workerName` is set.** Two lines, two production
   incidents, no design question. Do this first.
2. **Assert on the secret push the way the deploy asserts.** The deploy is
   safe only because it checks wrangler's output; the secret push should not
   be trusted more than the deploy is.
3. Zone settings and Access are a larger question — decide whether `cloudflare`
   grows them or whether `cloudflare-zone`/`cloudflare-access` become
   composable enough that ceo would not have inlined them.

## Evidence

- upstream defect: `packages/cli/templates/infra/modules/cloudflare/index.ts:537-539`, contrast `:499-500` + `:515-522`
- foothill fix: `packages/infra/modules/cloudflare/index.ts:190-197`, `:215-219`
- ceo fix + zone/Access surface: `packages/infra/modules/cloudflare/index.ts:121`, `:165-167`, `:210-274`, `:302-313`, `:348-356`, `:407-519`
- ceo instances: `production/recon.ts:45,49-69`, `production/tour-guide.ts:29-38`, `production/household-ledger.ts:43-53`, `production/claude-sandbox.ts:39-45`
