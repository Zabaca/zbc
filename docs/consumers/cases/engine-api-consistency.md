# engine: a resource that exists but is not yet usable — new

**Consumers:** ceo, foothill-metabolic, foundry, leeandco (4)
**Providers:** Google Cloud, Cloudflare, Tailscale (3)
**Deployed in production by:** all four

## What they needed

Every provider in this survey returns success from a create call before the
created thing works. Four consumers hit it, four hand-rolled retry loops, and
none of them could put the fix anywhere reusable.

| Consumer | The lag |
|---|---|
| ceo + foothill `gcp` | a just-created service account 404s its own keys endpoint for seconds; a just-minted key is briefly rejected by the token grant |
| leeandco `cloudflare-token` | a fresh token with `D1 Read`/`D1 Write` refused with error `10000`, accepted ~5s later |
| foundry `tailscale-authkey` | device state lags; a wrong field read made every device look offline |

leeandco's measurement is the one that settles the design question:
**`/tokens/verify` returned 200 at 112/111/202 ms while the scope-gated call was
still refusing at 1621/610/808 ms.** A generic "is it ready" probe is not
enough — readiness has to be probed *against the capability the caller will
actually use*. Their probe is derived from granted **read** permission groups,
because write does not imply read on Cloudflare.

## What it takes upstream

Not a retry helper — every consumer could have written that, and did. The
missing piece is the contract: a module declares *what proves this resource is
usable*, and the engine will not pass the output across an `imports` edge until
that proof succeeds. That turns four ad-hoc sleep-and-retry loops into one
engine guarantee, and it is the same guarantee
[engine-credential-lifecycle](./engine-credential-lifecycle.md) needs.

Getting this wrong is expensive and quiet: leeandco records the failure shape as
*"a token that authenticates perfectly and then cannot act… the single worst
failure shape this repo has met. It has now met it three times."*

## Evidence

- leeandco timings: `packages/infra/modules/cloudflare-token/index.ts:337-470` (measurements dated 2026-08-14 and 2026-08-15 in comments)
- ceo/foothill `gcp` retries: `packages/infra/modules/gcp/index.ts:119-126,146-156`
- foundry: `modules/tailscale-authkey/index.ts:104-108,110-124`
- upstream: no retry, wait, verify or readiness logic in `cloudflare-token`
