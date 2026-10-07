# zbc CLI reference

Run as `bunx @zabaca/zbc <command>`. Every command finds the project root by
walking up to `zbc.config.ts`, and every `<env>` must be listed in that file's
`environments`.

## Scaffold and vendor

```bash
zbc init [project] [--ci github] [--subtree] [--no-sops] [--core-url <url>] [--core-ref <ref>]
```

The one-time scaffold: `zbc.config.ts`, `.sops.yaml`, `packages/infra/` with
`environments/production` and `environments/preview`, a `CLAUDE.md`, a
`.claude/settings.json`, and, with `--ci github`, `preview.yml` and
`production.yml`. Every file is skip-if-exists. `--subtree` (the standard) first
runs `git subtree add --squash` of Zabaca/zbc-core at `vendor/zbc`, pinned to the
tag `zbc-core-v<cli version>`, so the tree must be clean. It also writes
`.zbc-vendor.json`. The repo needs either no `package.json` or a Bun workspace.

```bash
zbc add <name> [--env production] [--account-id <id>] [--no-prompt]
```

Brings in a built-in module, library or app template. Required libraries are
installed first. It prints the secrets the module reads, the provider signup and
token URLs, and setup instructions. Afterwards it collects any missing
registry-declared secrets through a Secret Request, unless `--no-prompt` is
given or no relay exists. For an app it copies the package to `packages/<name>/`
and runs `bun install`. With `--account-id` it generates the app's instance file
when the app declares one.

```bash
zbc update [--strict] [--core-url <url>] [--core-ref <ref>]
```

- **Subtree mode**: runs `git subtree pull --squash` to the zbc-core tag
  matching this CLI, rewrites `.zbc-vendor.json`, and names any file under
  `vendor/zbc/` that zbc-core does not ship. `--strict` turns that into an
  error.
- **Copy mode**: needs a clean tree. Re-copies `packages/infra/src/` and the
  built-in modules the project already has, and deletes files that are no
  longer shipped. It leaves the project's own modules alone. It names any npm
  dependencies a refreshed module needs but does not install them.

To move to a specific version, run that version of the CLI:
`bunx @zabaca/zbc@0.22.0 update`.

## Converge

```bash
zbc apply <env> [instance] [--only a,b] [--json <path>]
```

Discovers every `*.ts` in `packages/infra/environments/<env>/`, decrypts
`secrets.yaml`, sorts the instances by imports, and applies each one. An
`ephemeral` instance is destroyed first. Naming an instance, or listing several
with `--only`, applies those plus everything they import.

`--json <path>` writes `{ env, instances: [{ name, module, outputs }] }` after a
successful apply. Declared secret outputs appear as `[redacted]`, but treat the
file as sensitive and delete it once read. It is written to a path rather than
stdout because modules run builds with inherited stdio.

```bash
zbc destroy <env> [instance]
```

With no instance, tears down every instance whose module defines `destroy`, in
reverse dependency order. Instances without `destroy` are skipped and say so. If
a destroy needs an import's outputs, the engine applies that import on demand
and tears it down later in the same run. With an instance, tears down only that
instance, never its imports, and refuses if its destroy would need an import
that hasn't been applied.

```bash
zbc run <env> <instance> [action] [--yes]
```

With no action, lists the actions the instance's module declares. With one,
runs that action alone: it is never part of `apply` or `destroy`, it does not
apply the instance itself, and it emits nothing. An `irreversible` action is
refused without `--yes` before anything is applied.

## Inspect

```bash
zbc list <env> [--json]
```

Shows what the environment declares, in apply order: module, `ephemeral`,
whether `destroy` exists, imports, and actions. It runs no module and calls no
provider. `--json` prints `{ env, instances }` on stdout, nothing else.

## Secrets

```bash
zbc secret request <KEY> [KEY…] [--env production] [--reason <text>] [--relay <url>] [--timeout 300]
```

Asks a human for values through the project's Secret Relay. It prints a URL and
a pairing code, opens a browser when there is a TTY, waits for the submission,
and writes the values through `sops`. Keys that are already set are skipped.
The relay URL comes from a `secret-relay` instance (production first) unless
`--relay` is given.

```bash
zbc secret list [--env production]
```

Lists registry-declared and present keys as `set` or `missing`. Never prints
values.

```bash
zbc secret get <env> <key> [--allow-blank]
```

Prints one decrypted value on stdout, for shell substitution. A missing key
exits non-zero with nothing on stdout. A key that is present but empty needs
`--allow-blank`.

```bash
zbc secret edit [env] [--relay <url>] [--timeout 600]
```

Lets a human edit the whole `secrets.yaml` in their browser through the relay.
`sops` decrypts and re-encrypts it.
