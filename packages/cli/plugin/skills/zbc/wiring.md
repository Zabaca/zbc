# Wiring a Cloudflare Worker

`cloudflare` is a **deploy module**. The package owns its topology in its own
`wrangler.jsonc`, and the instance supplies identity and values: the account,
the worker name, the secrets, and the ids that other instances emit. The full
schema with its reasons is the doc comments on `configSchema` in
`modules/cloudflare/index.ts`.

```ts
// packages/infra/environments/production/api.ts
import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare' // copy mode: '../../modules/cloudflare'
import appDb from './app-db'
import uploads from './uploads'
import zone from './zone'

export default cloudflareModule.instance({
  name: 'api',
  imports: [appDb, uploads, zone],
  config: {
    workdir: 'packages/api',                       // holds wrangler.jsonc
    accountId: '<cloudflare account id>',          // not a secret: config
    build: { command: 'bun run build -- --filter=@myapp/api', cwd: '.' },
    workerSecrets: [
      'SESSION_SECRET',                                           // secrets.yaml key → env.SESSION_SECRET
      { name: 'DB_TOKEN', secret: 'TURSO_DB_TOKEN' },             // secrets.yaml key under another name
    ],
    workerVars: [
      { name: 'PUBLIC_ORIGIN', value: 'https://api.example.com' },      // literal
      { name: 'UPLOADS_BUCKET', from: 'uploads', output: 'bucketName' }, // an import's output
    ],
    bindings: [
      { type: 'd1_databases', binding: 'DB', field: 'database_id', from: 'app-db', output: 'databaseId' },
    ],
    r2Bindings: [{ binding: 'UPLOADS', from: 'uploads', output: 'bucketName' }],
    routes: ['api.example.com/*'],
  },
})
```

## Where each value goes

| Need | Key | Notes |
| --- | --- | --- |
| A secret the Worker reads as `env.X` | `workerSecrets` | Pushed with `wrangler secret put` over stdin. An entry is a plain secrets.yaml key, `{ name, secret }` to rename one, `{ name, from, output }` for an import's output, or `{ name, value }` for a literal |
| Non-sensitive config as `env.X` | `workerVars` | Same entry shapes. Passed as `--var` on the command line, so it is visible to anyone who can see the process. Sensitive values belong in `workerSecrets` |
| A binding's id (`database_id`, `bucket_name`, a queue, a KV namespace…) | `bindings` | `type` is the wrangler key holding the array (dotted when nested: `queues.producers`). `binding` matches the entry. `field` is the key to set |
| An R2 bucket binding | `r2Bindings` | Shorthand for `bindings` with `r2_buckets` / `bucket_name` |
| The deploy credential | `apiToken: { from, output }` | Optional. Default is `CLOUDFLARE_API_TOKEN` from secrets.yaml. Point it at a `cloudflare-token` instance's `tokenValue` to deploy with a minted, per-apply token |
| A hostname | `routes` | Needs a DNS record. Declare the record in a `cloudflare-zone` instance and import that instance so the record exists first |

## Bindings are filled in, never added

The binding must already be **declared** in the package's `wrangler.jsonc`, with
a placeholder id:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "set-by-zbc" }]
```

zbc copies the config, sets the field from the import, deploys the copy with
`--config`, and deletes it. A `bindings` entry that matches no declared binding
is a hard error before wrangler runs. With `wranglerEnv` set, the declaration
has to be inside that `env.<name>` block, because wrangler does not inherit
binding arrays into a named environment.

Keep real ids out of `wrangler.jsonc`. The resource's own instance is the
source of truth for its id.

## Routes, not custom domains, and not in wrangler.jsonc

A route declared in `wrangler.jsonc` would be claimed by every preview deploy
of that package, and the last PR deployed would take production's traffic.
Routes therefore live only in the production instance's `routes`. A wrangler
"custom domain" creates a managed DNS record that a `cloudflare-zone` instance
then reports as drift, so use `routes` plus a zone record. Cloudflare's
placeholder origin for an edge-only hostname is `AAAA 100::`, proxied.

## Preview workers

```ts
const pr = process.env.PR_NUMBER ?? 'local'

export default cloudflareModule.instance({
  name: 'api',
  config: {
    workdir: 'packages/api',
    accountId: '<cloudflare account id>',
    workerName: `myapp-api-pr-${pr}`,   // own worker + *.workers.dev URL per PR
    // no routes: a preview never claims a production hostname
  },
})
```

`deployUrl` is in the `zbc apply preview --json` output, which is how the
scaffolded workflow comments the URL on the PR. `zbc destroy preview` deletes
the worker when the PR closes.

## Containers

- `immediateContainerRollout: true` rolls the container application to the new
  image on deploy. It does not replace a running instance.
- `deployIdVar: 'DEPLOY_ID'` injects the deployed commit as a var, so the
  payload can tell that a deploy happened and recycle itself.

Use both when the image matters.

## Other modules

The same `{ from, output }` shape is how every module reads an import, as in
`fly`'s `flySecrets` and the `apiToken` refs on `cloudflare-zone`,
`cloudflare-tunnel` and `cloudflare-access`.
