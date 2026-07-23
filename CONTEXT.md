# zbc

Zabaca's infrastructure-as-code system: modules provision/deploy resources, instances bind a module to config for one environment.

## Principles

**Single-tenant everything**:
zbc is open source; consumers fork the repo or install just the CLI. Either way, every consumer instantiates their own copy of modules, app templates, and any supporting services (relay workers, inboxes, …). There is no centralized Zabaca-hosted service in the loop.

**Scaffold freely, deploy only through the graph**:
CLI commands may automate as much as they like (vendor modules, copy templates, even generate instance files) — but everything they do must land as committed declarative files, and real-world convergence happens only via `zbc apply`. A fresh clone plus `zbc apply` must reproduce the world.

## Language

**Provisioning Module**:
A module whose `index.ts` fully owns a resource's definition — the config it receives is the complete spec, with no external topology file. `turso` is a provisioning module.
_Avoid_: thick module

**Secret Request**:
A blocking ask, initiated from the CLI (typically by an agent), for a human to supply one or more secret values for a target environment's encrypted secrets file. The requester never sees the values — only whether they arrived.
_Avoid_: secret prompt, secret ask

**Secret Relay**:
The project's own permanent worker that brokers a Secret Request between the CLI and the human's browser. One per project (single-tenant); it carries only ciphertext.

**Channel**:
A single-use, time-limited conduit on the Secret Relay created for one Secret Request. Dies on first submission or expiry.

**Pairing Code**:
A short human-checkable code shown by both the CLI and the browser page so the human can confirm they're answering the request they think they are.

**Deploy Module**:
A module that only orchestrates build+deploy against topology the *consuming package* defines itself (e.g. its own `wrangler.jsonc`, `Dockerfile`). The module doesn't know the shape of what it's deploying. `cloudflare` is the only deploy module.
_Avoid_: thin module
