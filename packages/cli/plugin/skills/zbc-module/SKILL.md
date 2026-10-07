---
name: zbc-module
description: Writing or changing a zbc module — the defineModule + registry.json pair that converges one kind of resource for `zbc apply`. Use when no built-in module covers a resource a zbc project needs, when editing a module's apply/destroy, when adding a readiness probe, a secret output or an operator action to one, or when testing a module with createTestContext.
---

A module is a directory with `index.ts` (a `defineModule` call) and
`registry.json` (its manifest for `zbc add`), plus a test beside them. The
engine owns ordering, secrets, the imports edge, readiness, redaction and
`ephemeral`. A module owns one resource and converges it.

Use the **zbc** skill for instances, wiring and running `apply`. This skill
covers the module itself.

## Before writing one

- **An existing module may already cover it.** Check the catalog in the zbc
  skill's `modules.md`. A missing *option* on a built-in is an upstream change
  to `Zabaca/zbc`, not a fork. Ask the user before taking that route.
- **A one-shot act** (buying a domain, rotating a key) is an `action` on a
  module, not a module of its own and not a script beside the graph.
- **The project's engine must have the feature you plan to use.** Read the
  vendored `src/types.ts` (`vendor/zbc/src/` or `packages/infra/src/`). If
  `ready`, `secretOutputs`, `actions` or `outputValue` is missing, run
  `zbc update` first.

## Steps

### 1. Place it

The project's own modules live in `packages/infra/modules/<name>/` in both
modes. In subtree mode they stay outside `vendor/zbc/`, which is upstream's.

| Import | subtree | copy |
| --- | --- | --- |
| `defineModule` | `'../../../../vendor/zbc/src/define-module'` | `'../../src/define-module'` |
| `createTestContext` | `'../../../../vendor/zbc/src'` | `'../../src'` |
| A built-in library (`cloudflare-api`, `host-exec`, …) | `'../../../../vendor/zbc/modules/<lib>'` | `'../<lib>'` |

Inside zbc itself, built-ins are authored at
`packages/cli/templates/infra/modules/<name>/` and import `'../../src/…'`.

Done when the directory exists with `index.ts`, `registry.json` and
`index.test.ts`.

### 2. Declare config and outputs

```ts
import { z } from 'zod'
import { defineModule } from '../../../../vendor/zbc/src/define-module'

export const acmeBucketModule = defineModule({
  name: 'acme-bucket',
  configSchema: z.object({
    /** Account id — visible in the dashboard, so config rather than a secret. */
    accountId: z.string(),
    bucketName: z.string(),
    /** Which secrets.yaml key holds the API key. */
    apiKeySecret: z.string().default('ACME_API_KEY'),
    /** Optional credential from an imported instance instead. */
    apiKey: z.object({ from: z.string(), output: z.string() }).optional(),
  }),
  outputs: z.object({
    bucketName: z.string(),
    bucketId: z.string(),
  }),
  async apply(config, ctx) { /* step 3 */ },
})
```

- `configSchema` is the complete spec of the resource, and its doc comments are
  the module's manual. Write them for a stranger.
- Non-secret identifiers go in config. Credentials are named, not held: a
  secrets.yaml key name with a default, or a `{ from, output }` reference.
- Outputs are what importers need. Make an output a `string` when it will land
  in a worker secret, a `--var` or a binding field. Make it any shape when the
  shape is the point (`nameServers: string[]`). The engine validates the return
  value against `outputs`.

Done when every field the resource needs is in the schema with a doc comment,
and every value an importer will read is in `outputs`.

### 3. Write `apply` as a converge

`apply` runs on every `zbc apply`: on a fresh world, on a converged world, and
on a drifted one. Read the current state, then create or update to match the
config: list → find → create if absent → patch if different. The second run
must change nothing.

- **Secrets**: `ctx.secret(key, { field })` throws naming the key when it is
  missing or blank. Read secrets only through `ctx.secret`, never from
  `process.env`.
- **Imports**: `ctx.output(ref, 'apiKey')` for a string,
  `ctx.outputValue(ref, 'records')` for any other shape. The second argument is
  the config path to blame in the error. Read imports only through these two
  calls, never through `ctx.imports`.
- **Paths**: resolve against `ctx.projectRoot`, never `process.cwd()`.
- **Credentials**: pass them to child processes on stdin or in `env`, never in
  argv. Never `console.log` one. The engine scrubs its own messages, but it
  can't see your logs or a child's stdio.
- **Errors**: throw with the resource, the call and the token scope that is
  probably missing. A provider's 403 otherwise reads like a bug.

Done when a second apply against the same world makes no write calls. Step 7
asserts this.

### 4. Add `destroy` when the resource can be removed

```ts
async destroy(config, ctx) {
  const key = config.apiKey ? ctx.output(config.apiKey, 'apiKey') : ctx.secret(config.apiKeySecret)
  const existing = await findBucket(key, config)
  if (!existing) return console.log(`  Bucket "${config.bucketName}" already absent`)
  await deleteBucket(key, config, existing.id)
},
```

An absent resource counts as success. A destroy that needs an import calls
`ctx.output`, and in a full-environment destroy the engine applies that import
on demand. Only a module with `destroy` can have `ephemeral` instances or be
cleaned up by `zbc destroy`.

### 5. Declare what the engine needs to know

Add these only when they apply.

**`ready`** — when *created* is not *usable*. A fresh token refused by its own
scope, a database that doesn't answer yet. The engine holds this instance's
outputs at every `imports` edge until the probe passes, retrying while it
throws or returns `false`.

```ts
ready: {
  proves: 'the bucket accepts a write with the minted key',  // the claim a timeout reports
  timeoutMs: 30_000,   // default 60s
  intervalMs: 2_000,   // default 1s
  async probe(outputs, config, ctx) { await putObject(outputs, config, ctx) },
},
```

Probe the capability the importer will use, with the credential it will use.
A generic liveness endpoint passes before the scoped call works. An instance
that nothing imports is never probed.

**`secretOutputs`** — outputs that are credentials:

```ts
secretOutputs: { tokenValue: { rotates: 'each-apply' } },
```

They still cross `imports` in memory, but they are redacted from every engine
message and written as `[redacted]` in `zbc apply --json`. `'each-apply'` means
the apply itself consumes the credential, so minting a fresh one each run is
free. `'never'` means a holder outside the apply keeps it, and the engine then
refuses `ephemeral` instances of the module. Ids that only *name* a credential
(`tokenId`) stay unredacted.

**`actions`** — an operator's one-shot verb, run only by
`zbc run <env> <instance> <action>`:

```ts
actions: {
  purchase: {
    description: 'Register the domain (charges the account)',
    irreversible: true,   // refused without --yes
    async run(config, ctx) { /* read imports via ctx.output first, then act */ },
  },
},
```

An action returns nothing, because outputs come from `apply`. A reversible
action's body can be re-entered once per import it discovers, so resolve every
`ctx.output` before the first side effect. Irreversible actions get their
imports applied up front.

### 6. Write `registry.json`

```json
{
  "name": "acme-bucket",
  "kind": "module",
  "description": "One line: what it converges",
  "files": [{ "path": "index.ts" }],
  "modules": ["cloudflare-api"],
  "dependencies": { "zod": "^3.24.0" },
  "secrets": ["ACME_API_KEY"],
  "signupUrl": "https://…",
  "tokenUrl": "https://…",
  "instructions": "Token scopes it needs, and an instance example."
}
```

`kind` is `module` (the default), `library` (imported by siblings as
`../<name>`, defines no module, has no instance) or `app`. `modules` lists the
siblings this code imports, and `zbc add` installs them first. `secrets` lists
every key the module reads through `ctx.secret` by default. `zbc secret list`
and `zbc add` read it.

Done when `secrets` matches what the test in step 7 records in `ctx.secretsRead`.

### 7. Test the real `apply`

`createTestContext` builds the engine's own context over stubbed secrets and
imports, so `apply` runs exactly as it would in a deploy. Stub the provider at
`globalThis.fetch` (or at `host-exec`'s `withExec` for shell-outs) and assert
on the calls that reached it.

```ts
import { afterEach, expect, test } from 'bun:test'
import { createTestContext } from '../../../../vendor/zbc/src'
import { acmeBucketModule } from './index'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('a second apply against an existing bucket writes nothing', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
    return Response.json({ buckets: [{ id: 'b1', name: 'assets' }] })
  }) as typeof fetch

  const ctx = createTestContext({ secrets: { ACME_API_KEY: 'k' } })
  const config = acmeBucketModule.configSchema.parse({ accountId: 'a', bucketName: 'assets' })
  const out = await acmeBucketModule.apply(config, ctx)

  expect(out).toEqual({ bucketName: 'assets', bucketId: 'b1' })
  expect(calls.every((c) => c.startsWith('GET'))).toBe(true)
  expect(ctx.secretsRead).toEqual(['ACME_API_KEY'])
})
```

Cover the cases that hurt in production: the first apply (creates), the second
(no writes), drift (patches), a missing secret (throws naming the key), a
`destroy` on an absent resource (succeeds), and a `ready` probe that fails and
then passes.

Done when `bun test` and `bun run typecheck` pass in `packages/infra`.

### 8. Use it

Write an instance (see the **zbc** skill) and apply it to a non-production
environment first: `bunx @zabaca/zbc apply preview <instance>`. Apply it a
second time and confirm nothing changed. Get the user's go-ahead before
applying to production.

## Committing (subtree mode)

Module commits touch `packages/infra/modules/` only, never `vendor/zbc/` in the
same commit.
