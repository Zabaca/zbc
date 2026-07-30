# zbc

Zabaca's stack bootstrap. Holds the `zbc` CLI and the infrastructure modules used to provision and deploy Zabaca projects.

Projects live here under `packages/<project>/`; per-environment module instances live under `packages/infra/environments/<env>/`. Applying an environment is one command — `zbc apply <env>` — which discovers every instance in the environment directory, resolves the dependency graph from imports, decrypts secrets, and converges each service to the desired state.

## Layout

```
├── zbc.config.ts                           # project metadata + environment list
├── .sops.yaml                              # age public keys for secrets encryption
│
├── packages/
│   ├── cli/                                # zbc — CLI source + bundled module templates
│   │   ├── src/
│   │   │   ├── commands/                   # init, add, apply, destroy
│   │   │   ├── engine/                     # apply graph + secret loading
│   │   │   └── utils/
│   │   └── templates/                      # source of truth scaffolded by `zbc init` / `zbc add`
│   │       ├── infra/
│   │       │   ├── modules/                # turso, cloudflare, … (each with registry.json)
│   │       │   └── src/                    # defineModule helpers + shared types
│   │       ├── workflows/                  # CI workflows (preview.yml, production.yml)
│   │       ├── root/                       # package.json, tsconfig.json scaffolds
│   │       ├── sops.yaml
│   │       └── zbc.config.ts
│   └── infra/                              # live consumer of the templates above
│       ├── modules → ../cli/templates/infra/modules    # symlink
│       ├── src → ../cli/templates/infra/src            # symlink
│       └── environments/
│           ├── production/                 # add module instances per project
│           └── preview/                    # ephemeral preview resources
│
└── .github/
    └── workflows/
        ├── production.yml                  # zbc apply production on push to main
        └── preview.yml                     # zbc apply/destroy preview on PR events
```

## CLI

```bash
zbc init [project] [--ci github]            # scaffold zbc into a repo (greenfield or existing)
zbc add <module>                            # add a built-in module (turso, cloudflare, …)
zbc apply <env>                             # apply all module instances for an environment
zbc apply <env> <instance>                  # apply a specific instance (+ its dependencies)
zbc destroy <env>                           # tear down ephemeral resources
```

**`init`** is the one-time scaffold. It drops `zbc.config.ts`, `.sops.yaml`, the `packages/infra/` skeleton, and (with `--ci github`) the workflows. It does not add modules — those come on demand.

**`add`** brings in a single module: copies the module's `index.ts` into `packages/infra/modules/<name>/`, runs `bun add` for its declared dependencies, and prints the secrets you need to put in `secrets.yaml` along with the provider's signup/token URLs.

**`apply`** is declarative and idempotent. Run it the first time — everything is provisioned and deployed. Run it again — no-op except code deploy. Config changed — it converges. Same command locally and in CI.

For ephemeral instances (`ephemeral: true`), `apply` destroys and recreates the resource on every run, ensuring a clean state. `destroy` tears down ephemeral resources (reverse dependency order) and is used for cleanup when a PR is closed.

## Modules

Modules live in `packages/infra/modules/` (consumer-side) — really at `packages/cli/templates/infra/modules/<name>/` (source of truth). Each module is a directory with two files:

- `index.ts` — schema (zod) + `apply`/`destroy` logic via `defineModule`
- `registry.json` — manifest read by `zbc add`: files to copy, npm dependencies, required secrets, signup/token URLs, post-install instructions

A new built-in module = drop a directory under `packages/cli/templates/infra/modules/<name>/` containing those two files. It's then available via `zbc add <name>` in any consumer repo.

Module shape (`index.ts`):

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
import { cloudflareModule } from '../../modules/cloudflare'

export default cloudflareModule.instance({
  name: 'web',
  config: {
    workdir: 'packages/web',
    accountId: '<cloudflare account id>',
    build: {
      command: 'bun run build -- --filter=@myproject/web',
      cwd: '.',
    },
    workerSecrets: ['SOME_RUNTIME_SECRET'],
  },
})
```

Imports (`imports: [mainDb]`) are between instances, typed, refactor-safe, with outputs flowing from dependency to dependent, and a module's `apply` receives them as `ctx.imports`. Whether they're wired into the deployed service is up to the module and is explicit per entry: the `cloudflare` module lets each `workerSecrets`/`workerVars` entry be either a plain name (a key in this environment's `secrets.yaml`) or a `{ name, from, output }` reference that pulls a value from an imported instance's outputs — `from` must be an instance listed in this instance's `imports`, and `output` a key that instance emits, or apply fails with a hard error naming both. Secrets are pushed via `wrangler secret put` (stdin-piped); vars via `wrangler deploy --var` (command-line visible — never route sensitive values through `workerVars`).

**`cloudflare-email`** provisions Cloudflare Email Service (public beta) for a domain via the REST API (the first REST-direct CF module — wrangler has no Email onboarding surface): outbound sending (SPF/DKIM/DMARC/bounce-MX auto-provisioned) and inbound routing (literal rules + catch-all → `forward` / `worker` / `drop`). It reuses `CLOUDFLARE_API_TOKEN` but needs extra token scopes (Email Routing Rules Edit, Zone Settings Edit, and DNS Edit on the zone; Email Sending Edit and Email Routing Addresses Edit on the account) and a Workers Paid plan for sending. Beta caveats: 5 MiB outbound cap, unpublished rate limits (pilot before high-volume use), and `forward` destinations require a manual email-click verification — apply triggers the email, then fails with instructions until you re-run. In this repo it powers `mail.cedarpad.com`, whose catch-all routes into the `zbc-inbox` worker (`packages/inbox/`) — an agent-accessible inbox with a bearer-authed JSON API (threads/messages/search/send/drafts/scheduled/webhooks/labels), an MCP server at `/mcp` (Streamable HTTP, same bearer token — point Claude Code or claude.ai at it directly), and a minimal web UI.

**`inbox` (app template)** — the inbox worker above is also available to any zbc project as a scaffoldable app: `zbc add inbox` auto-vendors its module dependencies (`cloudflare`, `cloudflare-email`, `r2`), copies the full package verbatim into `packages/inbox/`, runs `bun install`, and prints the three instance files to create. App templates live at `packages/cli/templates/apps/<name>/` and declare `kind: "app"`, a `targetDir`, and their `modules` dependencies in `registry.json`. The template is placeholder-free: all per-project identity lives in the instance files (cloudflare module `workerName`, `r2Bindings` → an `r2` module instance, and a `workerVars` literal for `DEFAULT_FROM`), so this repo's `packages/inbox/` is a plain symlink into the template (the template path is also an explicit workspace entry in the root package.json, since bun's workspace glob doesn't follow symlinks) — no mirroring needed.

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
- No secrets stored in provider dashboards, password managers, or other external systems

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
2. For each environment it needs, add module instances in `packages/infra/environments/<env>/` — typically a Turso database and a Cloudflare Worker deploy, wired via imports.
3. Put any required secrets (API tokens, provider credentials) into `packages/infra/environments/<env>/secrets.yaml`, encrypted via SOPS.
4. Run `zbc apply <env>` locally to validate. CI will take over on push to main and on PRs.

## Releasing the CLI

`@zabaca/zbc` is published from `packages/cli/`. Tags follow `zbc-cli-v<version>`; release commits follow `release(cli): @zabaca/zbc <version>`.

1. **Bump the version** in `packages/cli/package.json` (semver — patch for template/bugfix tweaks, minor for new commands or modules).
2. **Commit** the bump (plus any code/template changes shipping with it):

   ```bash
   git commit -m "release(cli): @zabaca/zbc <version>"
   ```

3. **Tag** the release commit and push both:

   ```bash
   git tag zbc-cli-v<version>
   git push origin main zbc-cli-v<version>
   ```

4. **Publish to npm** with Bun (never `npm publish` — npm strips the bun shebang from `bin/zbc.js` and breaks the CLI):

   ```bash
   cd packages/cli && bun run publish:npm
   ```

   Requires npm auth (`npm whoami` to verify) and publish rights on the `@zabaca` scope.

5. **Verify** the new version is live:

   ```bash
   npm view @zabaca/zbc version
   ```

Note: existing scaffolded repos have their own checked-in workflows from whenever they last ran `zbc init` — template changes do not flow into them automatically. They need a re-scaffold or manual patch to pick up workflow updates.

## Design system

The Prose design system is split across two packages:

- `packages/design-system/` — pure component library. No build, no app. Exports React components + CSS tokens.
- `packages/design-system-viewer/` — Astro showcase app that consumes the library via `@zbc/design-system`. The first proving ground for the consumer pattern.

**Run the viewer locally:**

```bash
bun run dev   # turbo dispatches to @zbc/design-system-viewer
```

Opens at [http://localhost:3000](http://localhost:3000). The viewer shows all components and pages in isolation, with dark/light toggle.

## Working with this repo

- **Module/src layout:** `packages/infra/modules/` and `packages/infra/src/` are symlinks into `packages/cli/templates/infra/`. The `cli/templates/` tree is the source of truth (it's what `zbc init` scaffolds into new projects); this repo is a live consumer of its own templates. Edit modules at `packages/cli/templates/infra/modules/<name>/`, not via the symlink.
- **Runtime:** [Bun](https://bun.sh) — use `bun` everywhere (`bun install`, `bun run`, `bunx`). Do not use npm or yarn.
- **Publishing `@zabaca/zbc`:** use `bun publish`, never `npm publish`. npm strips non-node shebangs from bin entries, breaking the CLI. Run: `cd packages/cli && bun run publish:npm`.
- **Styling:** Tailwind CSS v4 — uses the new `@import "tailwindcss"` syntax and CSS-first config. No `tailwind.config.js`.
- **No shadcn/ui** — this is a deliberate choice. Components are hand-authored to match the Prose design system exactly.
- **Single-tenant design system** — `packages/design-system/` is purpose-built for Zabaca. Do not treat it as a generic component library.
- **`.claude/` directory** — mostly gitignored. The exception is `.claude/skills/`, which is committed and contains AI slash command definitions.
- **Mode A vs Mode B** — design system authoring (Mode A) happens in [claude.ai/design](https://claude.ai/design); implementation (Mode B) happens here, governed by `/mode-b` and `/visual-review`.

## Agent skills

### Issue tracker

Issues live in **Fredrin** as tickets, managed via the `fredrin` CLI — not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
