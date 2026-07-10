# zbc

Zabaca's infrastructure-as-code system: modules provision/deploy resources, instances bind a module to config for one environment.

## Language

**Provisioning Module**:
A module whose `index.ts` fully owns a resource's definition — the config it receives is the complete spec, with no external topology file. `turso` is a provisioning module.
_Avoid_: thick module

**Deploy Module**:
A module that only orchestrates build+deploy against topology the *consuming package* defines itself (e.g. its own `wrangler.jsonc`, `Dockerfile`). The module doesn't know the shape of what it's deploying. `cloudflare` is the only deploy module.
_Avoid_: thin module
