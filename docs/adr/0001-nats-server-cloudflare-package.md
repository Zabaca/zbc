# NATS moves off Fly.io onto Cloudflare as a package, not a new provisioning module

The `nats-server` module hand-rolled the Fly Machines API directly (create app, allocate IPs, create/update a Machine running `nats:latest`) — a Provisioning Module in this repo's vocabulary. As part of the broader move off Vercel/Fly onto Cloudflare, we're deleting that module outright (no back-compat) and replacing it with a `packages/nats-server` app — its own `wrangler.jsonc` + Dockerfile running NATS as a Durable-Object-bound Container — deployed through the existing generic `cloudflare` Deploy Module, the same pattern cedarpad's `canvas` package already uses.

## Considered Options

- **New thick module** (`nats-server-cloudflare`): keep the self-contained-module style, just targeting Cloudflare's API instead of Fly's. Rejected — duplicates logic the `cloudflare` module already provides, and the `cloudflare` module's own design intent is explicitly to support "container-backed payloads" like this.

## Consequences

Cloudflare Durable Objects can idle-evict; whether the bound Container process survives that eviction (vs. being killed and respawned, dropping all live NATS WebSocket subscriptions) is unverified. We're accepting that risk rather than researching it upfront — if long-lived pub/sub connections turn out to drop on idle gaps, that's a follow-up problem, not a blocker to shipping this.
