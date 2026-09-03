# cloudflare-token — upgrade

**Consumers:** leeandco (1, but five instances and three measured failures)
**Deployed in production by:** leeandco
**Forked from:** `3a5bf854`

## What they needed

leeandco spans **two Cloudflare accounts**. Zabaca's holds
`CLOUDFLARE_API_TOKEN`; the client's holds exactly one credential at rest — a
root that can mint tokens and read nothing. Everything else is minted per apply
and reaches its consumer through `imports`. Upstream cannot express that.

## Three failures, one already ours

### 1. The root secret name is a constant — **live**

`ctx.secret('CLOUDFLARE_ROOT_TOKEN')` at `index.ts:152` and `:233`. One
hardcoded name cannot serve two accounts. All five leeandco token instances
override it with a `rootTokenSecret` key (default preserved).

### 2. Permission-group name collision — **already fixed upstream, better**

Cloudflare permission-group names are not unique: `Access: Apps and Policies
Read/Write` exist twice, once under `com.cloudflare.api.account.zone` and once
under `com.cloudflare.api.account` (measured 2026-08-15). The old
`available.find((g) => g.name === name)` took the zone-scoped twin,
`buildPolicies` filed it under a zone wildcard, and the minted token
authenticated fine then returned `403 1010 auth.forbidden` on
`POST /accounts/{id}/access/apps`.

leeandco tie-breaks on `zones.length > 0` and throws when that cannot settle it.
**Upstream already does better**: `index.ts:174-182` now grants *every* match
and lets `buildPolicies` split them by scope, which is what selecting the
permission in the dashboard does. The upstream comment at `:160-173` records the
same incident, found independently.

No action — but note the shape: a consumer's *rationale* can be as stale as
their code.

### 3. A minted token is not immediately usable — **live, and nothing upstream models it**

Upstream mints a token and hands it straight to a dependent. leeandco measured:

- a fresh token holding `D1 Read`/`D1 Write` refused by
  `GET /accounts/{id}/d1/database` with error `10000`, accepted ~5s later
  (2026-08-14)
- **`/tokens/verify` went green at 112/111/202 ms while the scope-gated call was
  still refusing at 1621/610/808 ms** (three trials, 2026-08-15)

So verify-only waiting is documented as insufficient. Their `readinessProbe`
derives its probe from granted **read** groups, because write does not imply
read on Cloudflare.

Grep confirms upstream has no readiness, retry, verify or wait logic of any
kind in this module.

## What it takes upstream

1. `rootTokenSecret` config key, defaulting to `CLOUDFLARE_ROOT_TOKEN` — the
   change is small and unblocks any multi-account consumer.
2. A readiness probe before returning the token. This is the Cloudflare
   instance of a pattern four consumers hit across four providers — see
   [engine-api-consistency](./engine-api-consistency.md) before solving it
   here alone.

## Evidence

- upstream: `packages/cli/templates/infra/modules/cloudflare-token/index.ts:152,233` (hardcoded secret), `:174-182` + `:160-173` (collision, fixed), no propagation handling anywhere
- leeandco: `packages/infra/modules/cloudflare-token/index.ts:281,337-470,400,534,557`
- instances: `production/leeandco-deploy-token.ts:98-99`, `leeandco-access-token.ts:114-115`, `leeandco-members-token.ts:58-59`, `leeandcoconstruction-email-token.ts:93-94`, `leeandcoconstruction-dns-token.ts:59`
