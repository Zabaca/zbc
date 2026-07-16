# {{PROJECT_NAME}}

This project uses [zbc](https://github.com/Zabaca/zbc) for infrastructure scaffolding.

## Layout

- `packages/infra/` — infrastructure code (zbc modules)
- `packages/infra/environments/` — per-environment config (`production`, `preview`)
- `packages/infra/modules/` — vendored infra modules (do not edit by hand)
- `zbc.config.ts` — project-level zbc config
- `.sops.yaml` — SOPS encryption rules for secrets

## Common commands

- `bun install` — install dependencies
- `bunx @zabaca/zbc add <module>` — vendor an infra module (`turso`, `cloudflare`, `cloudflare-email`) or scaffold an app template (`inbox` — an agent-accessible email inbox; auto-vendors its module dependencies)
- `bunx @zabaca/zbc apply <env>` — apply infrastructure for an environment
- `bunx @zabaca/zbc destroy <env>` — tear down an ephemeral environment

## Conventions

- `packages/infra/modules/*` is vendored from `@zabaca/zbc`. Re-vendor with `zbc add` rather than editing in place.
- Secrets are SOPS-encrypted under `packages/infra/environments/<env>/`. Decrypt only when needed; never commit plaintext.
