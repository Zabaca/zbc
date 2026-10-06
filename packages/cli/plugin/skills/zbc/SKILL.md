---
name: zbc
description: Operating a zbc project — infrastructure declared as module instances under packages/infra/environments/<env>/ and converged by `zbc apply`. Use when a repo has zbc.config.ts, .zbc-vendor.json or vendor/zbc/; when adding or changing a resource (database, bucket, Worker, DNS zone, token, host service); when wiring one instance's outputs into another or into a Worker; when a secret is needed in secrets.yaml; when running zbc apply, destroy, list, run, add, update or secret; or when an apply fails.
---

zbc is infrastructure as committed files. A **module** knows how to converge one
kind of resource. An **instance** binds a module to config for one environment,
in a file under `packages/infra/environments/<env>/`. `zbc apply <env>` discovers
every instance there, sorts them by `imports`, decrypts the environment's
secrets and converges each one. A fresh clone plus `zbc apply` must reproduce
the world, so every change you make lands as a file in the repo, and the world
changes only through `zbc apply`.

Call the CLI as `bunx @zabaca/zbc <command>` (or `zbc` where the project pins
it). Every command and flag: [cli.md](cli.md).

## Orient first

Before changing anything, establish three facts:

1. **Mode** — `cat .zbc-vendor.json`. `subtree` means the engine and built-in
   modules live in `vendor/zbc/` with upstream history; `copy` means they were
   copied into `packages/infra/`. No stamp: check whether `vendor/zbc/src/`
   exists.
2. **Environments** — `zbc.config.ts` lists them.
3. **What is declared** — `bunx @zabaca/zbc list <env>` prints every instance in
   apply order with its module, imports, `ephemeral`, and actions. It calls no
   provider.

Paths differ by mode:

| | subtree | copy |
| --- | --- | --- |
| Engine (`defineModule`, types) | `vendor/zbc/src/` | `packages/infra/src/` |
| Built-in module | `vendor/zbc/modules/<name>/` | `packages/infra/modules/<name>/` |
| Instance file imports a built-in as | `'../../../../vendor/zbc/modules/<name>'` | `'../../modules/<name>'` |
| The project's own modules | `packages/infra/modules/<name>/` | `packages/infra/modules/<name>/` |

The vendored `src/types.ts` is the truth about which engine features this
project has. When something this skill describes — `ctx.outputValue`,
`actions`, `secretOutputs`, `ready` — is absent from it, the engine is behind:
upgrade with `zbc update` rather than building the feature again locally.
`zbc apply` also prints a vintage warning when the vendored engine and the CLI
disagree.

## Adding a resource

1. **Find the module.** [modules.md](modules.md) lists every built-in. Then read
   that module's `index.ts`: the doc comments on its `configSchema` are its
   manual, and its `outputs` schema names what it emits. No built-in fits →
   write one with the **zbc-module** skill.
2. **`bunx @zabaca/zbc add <name>`.** In subtree mode the module is already on
   disk and this installs its npm dependencies. In copy mode it copies the
   module in. Either way it installs the libraries the module imports and
   prints the secrets the module reads plus any setup instructions — read them.
   For an app template (`inbox`, `secret-relay`, `warehouse`, `walgit`) it
   scaffolds the whole package into `packages/<name>/`.
3. **Write the instance file** — `packages/infra/environments/<env>/<instance>.ts`:

   ```ts
   import { d1Module } from '../../../../vendor/zbc/modules/d1' // copy mode: '../../modules/d1'

   export default d1Module.instance({
     name: 'app-db',
     config: {
       accountId: '<cloudflare account id>',
       databaseName: 'myapp-production',
       statements: ['CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)'],
     },
   })
   ```

   One instance per file, default-exported, the file named after the instance.
   Every `.ts` file in an environment directory must default-export an
   instance, so put shared helpers somewhere else.
4. **Supply its secrets** (see [Secrets](#secrets)).
5. **Converge it**: `bunx @zabaca/zbc apply <env> <instance>` applies that
   instance and everything it imports.

Done when `zbc list <env>` shows the instance and its apply succeeds.

## Imports: the only way outputs flow

`imports: [other]` takes the sibling instance's default export
(`import appDb from './app-db'`). The engine applies `other` first and passes its
outputs to this instance. A config field then names one of those outputs with a
`{ from, output }` reference:

```ts
import appDb from './app-db'

export default cloudflareModule.instance({
  name: 'api',
  imports: [appDb],
  config: {
    // …
    bindings: [
      { type: 'd1_databases', binding: 'DB', field: 'database_id', from: 'app-db', output: 'databaseId' },
    ],
  },
})
```

- `from` is an instance **name**, and it must be in `imports`. `output` must be
  a key that instance emits. Either mistake is a hard error naming both.
- Never copy an id that an instance emits (a `database_id`, a bucket name, a
  zone id, a token) into config or `wrangler.jsonc`. Reference it, so a
  recreated resource is picked up on the next apply.
- An import with no reference still orders the apply. A Worker whose route
  needs a DNS record imports the `cloudflare-zone` instance for that reason.
- Importing an instance the environment doesn't declare is an error, and so is a
  cycle.

Deploying a Cloudflare Worker — `workerSecrets`, `workerVars`, `bindings`,
`routes`, per-PR preview names — is its own topic: [wiring.md](wiring.md).

## Ephemeral instances and previews

- `ephemeral: true` belongs on the **instance**, next to `name`, not inside
  `config`. The engine destroys the instance and re-applies it on every run. It
  is refused when the module has no `destroy`, and when the module emits a
  credential declared `rotates: 'never'`.
- Preview environments name resources per PR with
  `` `myapp-pr-${process.env.PR_NUMBER ?? 'local'}` ``. The scaffolded workflow
  runs `zbc apply preview` on each push and `zbc destroy preview` when the PR
  closes.

## Secrets

Secrets live in `packages/infra/environments/<env>/secrets.yaml`, encrypted
with SOPS + age and committed. The engine decrypts them at apply time, and a
module reads one with `ctx.secret('KEY')`. A value that isn't secret, such as an
account id, goes in instance config.

**Keep secret values out of your own context.** To get one into the file, ask
the human through the Secret Relay:

```bash
bunx @zabaca/zbc secret request CLOUDFLARE_API_TOKEN --env production --reason "d1 module needs Account → D1: Edit"
```

It prints a URL and a pairing code for the human, waits until they submit, and
writes the value through `sops`, so you never see it. Keys that are already set
are skipped. It needs a deployed `secret-relay` app (`zbc add secret-relay`).
If the project has none, ask the human to run
`sops packages/infra/environments/<env>/secrets.yaml` themselves. Never ask them
to paste a value into the conversation.

- `zbc secret list --env <env>` shows which keys are set and which are missing,
  without printing values.
- `zbc secret get <env> <key>` prints one value on stdout. It exists for scripts
  (`TOKEN=$(bunx @zabaca/zbc secret get production X)`), not for you to read.
- Plaintext never touches disk: no `sops -d > file`, no unencrypted
  `secrets.yaml` once `.sops.yaml` exists.

## The vendor prefix (subtree mode)

`vendor/zbc/` belongs to upstream, and `git subtree push` sends any commit that
touches it to upstream.

- Keep every commit wholly inside `vendor/zbc/` or wholly outside it. A mixed
  commit gets half-split.
- Put the project's own files outside the prefix. Modules go in
  `packages/infra/modules/`, notes go anywhere but `vendor/zbc/`.
- To upgrade, start from a clean git tree and run `bunx @zabaca/zbc@<version> update`.
  It pulls the zbc-core tag matching that CLI version. Review the squash commit.
  It names any file under the prefix that zbc-core doesn't ship (`--strict`
  makes those fatal).
- A fix to the engine or to a built-in module belongs upstream in
  `Zabaca/zbc` (`packages/cli/templates/infra/`). Ask the user before pushing
  anything upstream.

In copy mode, `zbc update` re-copies the engine and the built-in modules the
project already uses (clean tree required). Copy mode never receives updates on
its own, and `zbc init --subtree` is the way out of it.

## Verbs that change the world

- **`apply`** is idempotent: run it twice and the second run changes nothing
  except the code it deploys. `zbc apply <env> <instance>` or `--only a,b`
  narrows the run to those instances plus what they import.
- **`destroy`**: `zbc destroy <env>` tears down every instance that defines a
  `destroy`, in reverse order. `zbc destroy <env> <instance>` tears down only
  that instance, never what it imports.
- **`run`**: `zbc run <env> <instance>` lists the instance's actions, and
  `zbc run <env> <instance> <action>` runs one. An irreversible action (it
  spends money, registers a name, sends mail) is refused without `--yes`.

Before applying to a shared environment such as `production`, destroying
anything, or passing `--yes`, get the user's go-ahead unless they already gave
it for this change. `preview`-style environments and your own scratch
environments are fair game.

## When an apply fails

The engine's errors name the field, the instance and the fix:

| Message contains | Fix |
| --- | --- |
| `Secret "X" is missing from this environment's secrets.yaml` (or `is empty`) | `zbc secret request X --env <env>` |
| `references instance "Y", which is not in this instance's imports` | Add Y to `imports` |
| `references output "o" on instance "Y", which doesn't emit it` | Wrong output name. Check Y's module `outputs` schema |
| `emits an array, not a string — read it with ctx.outputValue` | The reading module must call `ctx.outputValue` |
| `Instance "A" imports "B", which is not in <env>` | B has no instance file in this environment |
| `does not export a valid module instance as its default export` | A `.ts` file in the environment directory that isn't an instance |
| `is ephemeral but module "m" has no destroy` | Drop `ephemeral`, or give the module a `destroy` |
| `Circular dependency detected` | Two instances import each other |
| A `ZodError` | The instance config doesn't match the module's `configSchema` |
| A timeout that quotes a "proves" claim | A readiness probe never passed. Usually a missing token scope, sometimes slow provider propagation |
| `Unknown environment` | Add it to `zbc.config.ts` |

`[redacted: <instance>.<output>]` in a message is the engine hiding a minted
credential. It isn't the bug.

## Writing or changing a module

Use the **zbc-module** skill. It covers `defineModule`, `registry.json`, the
`ctx` rules, readiness, secret outputs, actions and tests.
