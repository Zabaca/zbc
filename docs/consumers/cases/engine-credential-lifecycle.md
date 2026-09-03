# engine: credentials minted during apply — new

**Consumers:** ceo, foothill-metabolic, foundry, leeandco (4)
**Providers:** Google Cloud, Tailscale, Cloudflare, Incus (4)
**Independent lineages:** 3 (ceo+foothill share one `gcp`)
**Deployed in production by:** all four

This is the largest convergent finding in the survey, and it is not a module.

## What they needed

A credential that is **created inside an apply, handed to a dependent instance
through outputs, and never written to `secrets.yaml`.**

| Implementation | Mints | The hard part they solved |
|---|---|---|
| ceo + foothill `gcp` | GCP service-account key, fresh every apply | prunes to `maxKeys` so in-flight preview Workers keep working |
| foundry `tailscale-authkey` | 15-minute single-use tag-scoped auth key | skips minting when the node is already online, so steady-state apply burns zero keys |
| leeandco `cloudflare-token` | scoped CF token from a root that can only mint | waits until the token can actually act (see [cloudflare-token](./cloudflare-token.md)) |
| foundry `incus-trust` | *deliberately does not mint* | see the counterpoint below |

zbc's only precedent is `cloudflare-token`, and foundry's report puts the gap
exactly: nothing upstream models *"a credential whose whole point is that it
expires inside the apply that created it"*, and nothing upstream flows a secret
from one instance's outputs into another's environment without touching disk.

## Three sub-problems they each solved separately

**Rotation safety.** Rotating on every apply invalidates whatever is still
running. `gcp` keeps `maxKeys` old keys alive; foothill goes further and uses a
*separate service account per environment* so a preview apply's rotation cannot
touch production (`preview/gcal.ts:5-9`).

**Mint avoidance.** foundry's `decideMint` (`tailscale-authkey/index.ts:142-151`)
treats "known but offline" as mint-worthy and online as skip. Getting this wrong
is not free: reading a non-existent `online` field made every device look
offline and minted a key on every apply (`:104-108`).

**Eventual consistency.** All of them hit it. Split into
[engine-api-consistency](./engine-api-consistency.md).

## The counterpoint — do not just build "mint and return"

foundry's `incus-trust` **refuses to return the credential**. It converges a
*state report* — `trusted` / `pending` / `unenrolled`, where `unenrolled` is a
passing apply — because the mint-and-return shape that `cloudflare-token` and
`cloudflare-access` use *"put a live bearer token into an agent's persisted
transcript twice in one morning"* (`incus-trust/index.ts:17-24`).

So the requirement is not "make minting easy". It is: mint, hand the value only
to the instances that import it, and keep it out of logs, transcripts and disk.
An engine feature can enforce that; a per-module convention cannot.

## The other counterpoint — not every credential should rotate

leeandco needed the opposite discipline and had to write a separate module for
it. `cloudflare-access-service-token` creates **once**, prints once, keeps the
secret out of `outputs` entirely, and defines no `destroy`. Their reasoning:
`cloudflare-token` is the wrong shape here because it rolls on every apply, and
the consumer of this credential is *a third party on another cadence* — an
agent holding the token — so rotating it silently breaks every holder.

So the axis is not "ephemeral vs long-lived". It is **who consumes the
credential**: the apply itself (rotate freely) or someone outside it (rotate
never, without a handoff). An engine feature that only models the first is
half a feature.

## What it takes upstream

An engine-level notion of an ephemeral output — a value that flows across an
`imports` edge in memory, is redacted everywhere the engine prints, and is never
persisted. Then rotation policy (`maxKeys`-style retention) and mint-avoidance
become module config rather than four hand-rolled implementations.

## Evidence

- ceo `gcp`: `packages/infra/modules/gcp/index.ts:39-59,109-115,117-126,131-143,145-176,180`
- foothill `gcp`: `packages/infra/modules/gcp/index.ts:79-181`; instances `production/gcal.ts:14-22`, `preview/gcal.ts:5-9,14-22`; consumed `production/foothill-metabolic-cf.ts:47`
- foundry `tailscale-authkey`: `modules/tailscale-authkey/index.ts:35,70-74,104-108,110-124,142-151,153-224`; instances `ryzen-9/agent-vm-authkey.ts:30`, `vultr-authkey.ts`
- foundry `incus-trust`: `modules/incus-trust/index.ts:17-24,122-135,157-169,225-260,263-337`
- leeandco: see [cloudflare-token](./cloudflare-token.md)
