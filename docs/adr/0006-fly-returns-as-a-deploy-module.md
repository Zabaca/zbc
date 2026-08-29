# Fly returns as a Deploy Module, for payloads Cloudflare cannot serve

**Status:** accepted (2026-08-20). **Superseded for `walgit` by [ADR-0008](./0008-walgit-runs-on-a-cloudflare-container-without-ssh.md)** (2026-08-28): walgit dropped SSH, which removed the raw-TCP requirement that put it here, and moved onto a Cloudflare Container. The `fly` module and everything argued below stand — the option this ADR rejected ("stay on Cloudflare, drop SSH") became right for walgit specifically, once its users turned out to be agents holding tokens rather than humans holding keys.

[ADR-0001](./0001-nats-server-cloudflare-package.md) deleted the `nats-server`
module "as part of the broader move off Vercel/Fly onto Cloudflare". This adds a
`fly` module back. It is a partial reversal and needs arguing rather than
assuming, because the thing ADR-0001 rejected and the thing added here are not
the same shape.

**What ADR-0001 rejected** was a Provisioning Module that "hand-rolled the Fly
Machines API directly (create app, allocate IPs, create/update a Machine running
`nats:latest`)" — a module that owned the topology of what it deployed. Its
stated preference was the opposite: a Deploy Module that "only orchestrates
build+deploy against topology the *consuming package* defines itself".

**What this adds** is that second shape. `fly` runs `fly deploy` against a
package's own `fly.toml`, exactly as `cloudflare` runs `wrangler deploy` against
a package's own `wrangler.jsonc`. The module does not know what it is deploying.
ADR-0001's lesson is applied, not ignored.

## Why now

Cloudflare cannot serve a payload that needs **raw inbound TCP**. Containers are
reachable only through a Worker's `fetch`, and Cloudflare's own docs state that
"end-users cannot make non-HTTP TCP or UDP requests to a Container instance".
Spectrum proxies TCP but only to an origin IP, which a Worker does not have; the
Worker `connect` handler that would bridge the two is in private beta. This is
not a pricing problem — Spectrum SSH is available on Pro and Business — it is an
addressing one.

`walgit` ([ADR-0007](./0007-walgit-object-storage-holds-the-log.md)) needs SSH on
port 22, so it needs somewhere else to run. Measured on Fly, 2026-08-20 (see
[`docs/research/walgit-m0-spike/`](../research/walgit-m0-spike/)): raw TCP
pass-through works with no `handlers` in `fly.toml`, and Fly Proxy **autostarts a
stopped machine on a raw TCP connection** in ~1.35 s — undocumented behaviour,
and the reason scale-to-zero survives the move.

## Considered options

- **Stay on Cloudflare, drop SSH, serve smart-HTTP only.** Rejected: SSH is
  core enough to git's identity for our users that dropping it changes what the
  product is. Smart-HTTP ships too, but as the machine-facing transport
  alongside SSH, not instead of it.
- **Wait for the Cloudflare `connect`-handler beta.** Rejected as a dependency:
  it gates the whole project on someone else's timeline, and an app template
  every consumer must get beta access for is not an app template.
- **A VPS via the existing host primitives** (`host-file`, `systemd-unit`,
  `docker-compose-stack`). Not rejected — it needs no new zbc surface at all and
  stays the documented path for a consumer who already has a box. But it has no
  scale-to-zero, is single-region, and the consumer operates it, so it is the
  alternative rather than the default.
- **A Fly Provisioning Module** (hand-roll the Machines API again). Rejected for
  the reasons ADR-0001 already gave.

## Consequences

- **zbc has two deploy targets to maintain.** A real ongoing cost, accepted
  because the alternative is having no answer for raw-TCP payloads at all.
  `cloudflare` stays the default; `fly` is for what it cannot serve.
- **A dedicated IPv4 is required for any port that is not 80/443** ($2/mo).
  Shared IPv4 is 80/443 only. The module therefore owns IP allocation, which is
  the one piece of topology `fly.toml` cannot express — an IP is account state,
  not app config. Dedicated IPv6 is free but was unreachable from the operator's
  network during the spike, so it is not a substitute.
- **`fly secrets set` triggers a deployment by default.** The module stages them
  (`--stage`) and lets the following `fly deploy` pick them up, so one apply is
  one deployment rather than two. This differs from `cloudflare`, which pushes
  Worker secrets *after* deploy because the script must exist first.
- **Auth is non-interactive** via `FLY_API_TOKEN`, the same shape as
  `CLOUDFLARE_API_TOKEN`. Note that Fly macaroon tokens contain a literal space
  (`FlyV1 fm2_…`) — any code that strips whitespace from the secret will produce
  a token that fails with a bare `401`, which is an expensive thing to debug.
- The token dropped from `secrets.yaml` by the migration commit was still live
  weeks later. Decommissioning a provider should include revoking its
  credential, not only removing it from the file.
