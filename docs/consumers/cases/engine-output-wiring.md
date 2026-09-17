# engine: an output that cannot reach the file that needs it — upgrade

**Consumers:** crux, foothill-metabolic, ceo, web (4)
**Deployed in production by:** crux, foothill-metabolic, ceo

## What they needed

An instance's output written into a *provider config file* — `wrangler.jsonc`,
most of the time — rather than into an environment variable.

zbc resolves outputs across `imports` and into `workerSecrets`/`workerVars`.
It does not resolve them into the file wrangler reads at deploy time. So every
consumer that provisioned a resource needing a **binding** hardcoded the id:

- crux — `apps/cloud/wrangler.jsonc:58`, D1 uuid, with a comment explaining why
- foothill — `packages/foothill-inbox/wrangler.jsonc`, D1 `database_id`, plus
  the R2 bucket name, `TELEGRAM_CHAT_ID`, and a custom-domain route
- ceo — R2 bucket names, worked around differently (below)

Four consumers wrote a `d1` module. **Not one of them closed the gap the module
was written for**, because the module was never the hard part.

## ceo's workaround names the real constraint

ceo provisions R2 two ways inside one production environment:
`production/tour-guide-cache.ts` uses the `r2` module; `production/recon.ts:45`
uses the `cloudflare` module's own `r2Buckets` key. The reason is at
`cloudflare/index.ts:108-116`: **a `wrangler.jsonc` binding to a nonexistent
bucket fails the deploy**, so the bucket has to be created inside the same
module run, ahead of the deploy step.

That is the constraint in one sentence. Cross-module ordering is not enough —
the resource must exist before wrangler reads the config that names it, and the
config must name the id the module just produced. Upstream's answer so far has
been to grow `cloudflare` (`r2Bindings`, `r2Buckets`), which is why ceo also
inlined zone and Access config into it: everything gets absorbed into the
deploying module because that is the only place ordering is guaranteed.

## What it takes upstream

Either a binding resolver that rewrites `wrangler.jsonc` from imported outputs
before deploy — the general form of what `r2Bindings` does for one resource
type — or an explicit pre-deploy phase that other modules can attach to.

The choice matters beyond D1: without it, every future Cloudflare resource type
becomes another key on the `cloudflare` module, and `cloudflare` keeps
absorbing modules that ought to compose.

## Evidence

- crux: `apps/cloud/wrangler.jsonc:50-58`; `environments/production/d1.ts:12-15`
- foothill: `packages/foothill-inbox/wrangler.jsonc`; `production/foothill-email.ts:25-26`
- ceo: `packages/infra/modules/cloudflare/index.ts:108-116`, `:302-313`; `production/recon.ts:45`; `production/tour-guide-cache.ts`
- upstream: `r2Bindings` resolver in `packages/cli/templates/infra/modules/cloudflare/index.ts`, no D1 equivalent
