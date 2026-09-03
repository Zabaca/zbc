# engine: no seam for code shared between modules — new

**Consumers:** varnick, foundry (2)
**Deployed in production by:** foundry (varnick has never run — see below)

## What they needed

Somewhere to put code that two modules share. zbc's unit of distribution is a
module directory (`index.ts` + `registry.json`), so a shared library has to be
shaped like a module and parked next to the real ones.

Both consumers did exactly that, independently:

- **varnick `client-core`** — no `defineModule`, no `apply`, no
  `registry.json`. Holds a Cloudflare fetch envelope and a credential resolver.
  Imported by all three real modules. Its own test pins that it imports zod and
  *not even zbc* "because it defines no module of its own".
  Header (`:14-27`) records that three copies of the resolver existed first.
- **foundry `tailscale-core`** — same shape: OAuth client-credentials exchange,
  API root, and the two `secrets.yaml` key names exported as a **zod schema
  fragment** (`oauthFields`) spread into two modules' config schemas. Its header
  names zbc's own `provision-core` as the precedent it copied.

So the pattern already exists upstream (`provision-core`), it is just not a
supported thing — it has no name, no registry entry, and nothing stops
`zbc add` or a future engine change from tripping over a module-shaped
directory that defines no module.

## The sharper half: they rebuilt engine features they never received

varnick's `resolveApiToken` (`client-core/index.ts:136-154`) is a hand-rolled
`ctx.output`. Upstream `packages/cli/templates/infra/src/context.ts:63-85`
implements the same function — same `{from, output}` shape, same three failure
cases, and its test even names the field `apiToken`.

They did not copy it. They could not receive it: **varnick's `vendor/zbc` is a
copy, not a subtree** — `git subtree add` could not reach `zbc-core-v0.10.2` at
split time (`README.md:50-55`) — so there is no `zbc update` path and they are
pinned to a pre-`context.ts` engine whose `src/types.ts` exposes only
`imports: Record<string, unknown>`.

ceo is in the same position from the other direction: its vendored
`packages/infra/src/types.ts:9` also predates `ctx.output()`, no module in the
repo calls it, and its fail-by-name convention in `posthog/index.ts:80` and
`vercel/index.ts:148-152` was **invented independently** rather than derived
from zbc's rule.

Two consumers, two reinventions of the same engine feature, both because the
feature never reached them. See [distribution-drift](./distribution-drift.md).

## What it takes upstream

Name the seam. A declared shared-library kind under `modules/` — or a proper
`lib/` prefix in the template tree — with a registry shape that says "this
exports code, it does not define a module". `provision-core` and
`tailscale-core` are already the design; it just needs to be a supported one.

## Evidence

- varnick: `packages/infra/modules/client-core/index.ts:14-27,40-134,136-154`; consumers `client-account/index.ts:3`, `client-domain/index.ts:3`, `client-preview/index.ts:9`; `client-core/index.test.ts:28`; `README.md:50-55`
- foundry: `modules/tailscale-core/index.ts:5-10,33-92`; consumers `tailscale-authkey/index.ts:3`, `tailscale-acl/index.ts:5`
- upstream equivalents: `packages/cli/templates/infra/src/context.ts:63-85`; `modules/provision-core/`
