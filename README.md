# zbc

Zabaca's stack bootstrap. Holds the `zbc` CLI and the infrastructure modules used to provision and deploy Zabaca projects.

Projects live here under `packages/<project>/`; per-environment module instances live under `packages/infra/environments/<env>/`. Applying an environment is one command — `zbc apply <env>` — which discovers every instance in the environment directory, resolves the dependency graph from imports, decrypts secrets, and converges each service to the desired state.

## Layout

```
├── zbc.config.ts                           # project metadata + environment list
├── .sops.yaml                              # age public keys for secrets encryption
├── vercel.json                             # git.deploymentEnabled: false
│
├── packages/
│   ├── cli/                                # zbc — CLI entry point + commands
│   └── infra/                              # infrastructure
│       ├── modules/
│       │   ├── turso/                      # Turso database module
│       │   └── vercel/                     # Vercel project + deploy module
│       └── environments/
│           ├── production/                 # (empty) — add module instances per project
│           └── preview/                    # (empty) — ephemeral preview resources
│
└── .github/
    └── workflows/
        ├── production.yml                  # zbc apply production on push to main
        └── preview.yml                     # zbc apply/destroy preview on PR events
```

## CLI

```bash
zbc apply <env>                             # apply all module instances for an environment
zbc apply <env> <instance>                  # apply a specific instance (+ its dependencies)
zbc destroy <env>                           # tear down ephemeral resources
```

`apply` is declarative and idempotent. Run it the first time — everything is provisioned and deployed. Run it again — no-op except code deploy. Config changed — it converges. Same command locally and in CI.

For ephemeral instances (`ephemeral: true`), `apply` destroys and recreates the resource on every run, ensuring a clean state. `destroy` tears down ephemeral resources (reverse dependency order) and is used for cleanup when a PR is closed.

## Modules

Modules live in `packages/infra/modules/` and define the schema and apply/destroy logic for a type of service:

```ts
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

export const tursoModule = defineModule({
  name: 'turso',
  configSchema: z.object({
    orgName: z.string(),
    dbName: z.string(),
    group: z.string().default('default'),
    primaryLocation: z.string().default('iad'),
    ephemeral: z.boolean().default(false),
  }),
  outputs: z.object({
    databaseUrl: z.string(),
    authToken: z.string(),
  }),
  async apply(config, ctx) {
    // idempotently ensure database exists
    return { databaseUrl, authToken }
  },
})
```

## Instances

Instances live in `packages/infra/environments/<env>/` and wire a module to specific config:

```ts
// packages/infra/environments/production/main-db.ts
import { tursoModule } from '../../modules/turso'

export default tursoModule.instance({
  name: 'main-db',
  config: {
    orgName: 'zabaca',
    dbName: 'myproject-production',
    primaryLocation: 'aws-us-west-2',
  },
})
```

```ts
// packages/infra/environments/production/web.ts
import { vercelModule } from '../../modules/vercel'
import mainDb from './main-db'

export default vercelModule.instance({
  name: 'web',
  imports: [mainDb],
  config: {
    projectName: 'myproject-production',
    domain: 'myproject.com',
  },
})
```

Imports are between instances — typed, refactor-safe, with outputs flowing from dependency to dependent. Outputs from imported instances are synced to the downstream service as environment variables (e.g. `main-db`'s `databaseUrl` → `MAIN_DB_DATABASE_URL` on the Vercel project).

**Ephemeral preview instances** use dynamic naming and destroy+recreate on every apply:

```ts
export default tursoModule.instance({
  name: 'main-db',
  config: {
    dbName: `myproject-preview-pr-${process.env.PR_NUMBER}`,
    ephemeral: true,
  },
})
```

## Environments

- **production** — `zbc apply production`, triggered by main merge via GitHub Actions
- **preview** — `zbc apply preview`, ephemeral per-PR resources, triggered on PR open/push, cleaned up on PR close via `zbc destroy preview`

## Secrets Management

All secrets are committed to the repo, encrypted with SOPS + age. Each developer and CI environment has their own age keypair.

### How it works

- `.sops.yaml` lists all age **public keys** (committed to repo) as recipients
- Secrets are encrypted to all recipients — anyone listed can decrypt
- Each developer's **private key** stays on their machine only (never shared)
- No secrets stored in Vercel dashboard, password managers, or other external systems

### Adding a new developer

1. Developer generates their own keypair: `age-keygen`
2. Developer shares their **public key** (not secret)
3. Add the public key to `.sops.yaml`
4. Re-encrypt all secrets with the new recipient: `sops updatekeys <secrets.yaml>`
5. Developer stores their private key at the default SOPS location:
   - macOS: `~/Library/Application Support/sops/age/keys.txt`
   - Linux: `~/.config/sops/age/keys.txt`

### Removing a developer

1. Remove their public key from `.sops.yaml`
2. Re-encrypt: `sops updatekeys <secrets.yaml>`
3. Rotate any secrets they had access to

### CI (GitHub Actions)

CI has its own age keypair. The private key is stored as a single GitHub Actions secret (`SOPS_AGE_KEY`). The public key is listed in `.sops.yaml` alongside developer keys.

## Onboarding a new project

1. Add the project under `packages/<project>/`.
2. For each environment it needs, add module instances in `packages/infra/environments/<env>/` — typically a Turso database and a Vercel deploy, wired via imports.
3. Put any required secrets (API tokens, provider credentials) into `packages/infra/environments/<env>/secrets.yaml`, encrypted via SOPS.
4. Run `zbc apply <env>` locally to validate. CI will take over on push to main and on PRs.
