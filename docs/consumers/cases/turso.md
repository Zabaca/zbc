# turso — upgrade

**Consumers:** foothill-metabolic  ·  **Deployed in production by:** foothill-metabolic (the `leads` instance's `migrationsDir`, and the backfill)

Both needs were written in `Zabaca/ceo` and moved to foothill with the app on 2026-07-27. foothill's `turso` is a stale copy of d82840f, not a fork; main's `migrationsDir` branch differs from it in behaviour only by a reachability retry (`turso/index.ts:186`).

## What they needed

### 1. Proof the migrations ran

`migrationsDir` runs drizzle's `migrate()`, then prints `✓ Migrations applied` (main `turso/index.ts:188-190`). drizzle runs only journal entries whose `when` is later than every `when` recorded in `__drizzle_migrations`, so once a future-dated entry has run, a later migration dated before it is skipped and reported as applied. A failing migration still fails the apply.

On 2026-06-03 that skipped 0004 in production, behind a 0002 dated 2026-06-08, and `/admin` returned 500s until production was patched by hand. ceo then added the guard foothill still runs, a test on every PR that fails unless the journal's `when` values strictly increase. Within two weeks ceo's build workflow future-dated 0008–0010 by up to two days. They still increase, so the guard passed them; any migration generated before 2026-06-21 would have tripped it instead of being skipped.

### 2. A credential for a one-off script

foothill's `backfill-rmr.ts` rewrites stored results in production, dry-running without `--apply`. It reads the `leads` instance's two outputs, which its comment says to set from `turso db show foothillmetabolic --url` and "a minted token", one minted by hand outside zbc. It ran against production on 2026-06-15 and is to be re-run whenever the calibration is re-fit.

## The interface, from one implementation per need

### 1. One guard

It checks a precondition, the journal's order, not the outcome, which a CI test cannot see.

youbuzz, the one consumer outside the Zabaca org, is zbc's origin, not a copy: its CLI and module system (f1a4f99), `turso` and `vercel` were written on 2026-04-10/11, before zbc's first commit (42de911, 2026-04-24), and zbc took its `migrationsDir` branch two days after youbuzz wrote it. youbuzz applies that branch to production on every push to main, unguarded; its journal was in order at the last commit we can read (2026-04-28).

D1 consumers that run versioned migrations use wrangler's ledger ([d1](./d1.md)), which diffs by file name and cannot skip a file this way.

### 2. A comment on Turso, a wrapper on D1

On Turso the only implementation is that comment. youbuzz's seed CLI also reads a URL and token from the environment, but only for local and preview databases; nothing in the repo runs it remotely. On D1 it is leeandco's `with-client-d1-token.ts`, which qom copied ([d1](./d1.md)): a D1-only credential minted for one command, passed only through the child's environment, never printed (it forbids a `--print-token` flag: a copied token outlives its reason), and deleted afterwards. It shares foothill's channel, not its lifetime: `turso db tokens create` defaults to `--expiration never`, so foothill's token outlives the script unless the operator set an expiry.

## What it takes upstream

### 1. Check the outcome

In `packages/cli/templates/infra/modules/turso/index.ts:172-193`:

- After `migrate()`, read `__drizzle_migrations` back and fail, naming the tags, on any journal entry without a row (drizzle writes one per entry it runs, with the file's sha256 as `hash`). Print the tags that ran.
- Before `migrate()`, refuse a journal whose `when` values do not strictly increase: foothill's test, where it cannot be skipped.

Main fails a `wrangler deploy` that exits 0 without deploying (`cloudflare/index.ts:735-743`) but trusts `migrate()`: the schema comment calls `migrationsDir` "Idempotent" (`turso/index.ts:99-103`), and the plugin lists it without a caveat (`plugin/skills/zbc/modules.md:38`). The defect is the success line every `migrationsDir` user reads, in the built-in and in youbuzz's original; only the trigger was one consumer's journal.

### 2. A credential without an apply

No command on main reads an output without applying its instance (`src/index.ts:19-28`), and none of the routes added since 2026-09-02 fits:

- `zbc apply production leads --json <path>` (`commands/apply.ts:31-36, 98-115`) mints another full-access token (`turso/index.ts:165-168`) and migrates production from the operator's checkout (`:179-189`). It writes the token out only because `authToken` is not a declared secret output (`engine/apply.ts:203-213`), which [engine-credential-lifecycle](./engine-credential-lifecycle.md) proposes changing.
- `zbc secret get` reads `secrets.yaml` (`commands/secret.ts:304-354`); outputs are never persisted (`:107-111`).
- An action returns nothing (`templates/infra/src/types.ts:8, 29-31`), `zbc run` passes it no arguments and runs no operator command (`commands/run.ts:20-37`), and a token the module prints is beyond redaction (ADR-0016 `:41`).

The change has two parts; only the first is turso's:

1. **In turso:** issue a credential without converging, with the `authorization` (read-only for the dry run) and `expiration` the client already takes; the module always asks for full-access and passes no expiry. With no token id and no single-token revoke in the client (only a database-wide `rotateTokens`), "for one command" means a short expiry, not leeandco's delete.
2. **Into one process's environment:** a command that runs another with the credential in its environment, a CLI surface in [cli-gaps](./cli-gaps.md).

The Turso evidence is one hand-run script; the D1 lineage and the operator acts in [engine-verbs](./engine-verbs.md) say more about the path's shape. The open decision is whether zbc, which other companies run against their own production, should own an operator path to a module's credential at all.

## Carried by other cases

A local database per worktree (`turso dev`) is in [cli-gaps](./cli-gaps.md). `destroy` deletes unconditionally (`turso/index.ts:200-212`), so `zbc destroy production` reaches a production database ([d1](./d1.md)), and logs every failed delete as "not found — skipping" (`:206-211`; [engine-undeclared-state](./engine-undeclared-state.md)).

## Evidence

- **foothill-metabolic** (HEAD 1e391b9): `packages/infra/modules/turso/index.ts:80-95`, stale at d82840f (2026-04-29), which ceo took in acb4b13 (2026-05-18); `packages/infra/environments/production/turso.ts:3-10`. Guard: `packages/foothill-metabolic/src/lib/schema.migration.test.ts:55-75`, `packages/foothill-metabolic/package.json:15`, `.github/workflows/test.yml:8-11, 38-39`; journal `packages/foothill-metabolic/drizzle/meta/_journal.json`. Backfill: `packages/foothill-metabolic/scripts/backfill-rmr.ts:6-7, 12-16, 57-60`, whose `LEADS_*` names are the `leads` outputs (`packages/infra/environments/production/foothill-metabolic-cf.ts:29-33`).
- **ceo**: a87fce0 (2026-06-02) dated 0002 to 2026-06-08; f1f0649 (2026-06-03) is the journal fix and hand repair, e2487a2 the guard, 6191b6c (2026-06-15) the backfill and its production run; 1e16f72 and 2255b11 (2026-06-16, -18) date 0008–0010 ahead. The move: ceo 3f5ef1d, foothill e97dc04.
- **youbuzz** (local clone, last commit 2026-04-28; its GitHub repo is not readable with our credentials): f1a4f99 (2026-04-10) is its CLI and module system, 4d4eb96 (2026-04-10) its `turso`, which zbc's 42de911 copied byte for byte, 8b19e1f (2026-04-11) its `vercel`, and 0b2a591 (2026-04-27) its `migrationsDir`, which zbc's c2cd4fc (2026-04-29) credits: "Sourced from improvements made in artsmedia/youbuzz". Its `stale` verdict at d82840f is a formatting-only match with zbc's revision of youbuzz's code, not a copy of ours. `packages/infra/modules/turso/index.ts:80-98`; `packages/infra/environments/production/main-db.ts:3-10`; `.github/workflows/production.yml:3-5, 31`; `packages/db/migrations/meta/_journal.json`; seed CLI `packages/db/src/seed/run.ts:6-8, 26-29`, `docs/data-model.md:413`.
- **leeandco**: `packages/infra/scripts/with-client-d1-token.ts:16-23, 30-32`; **qom**'s copy says so at `:27`.
- **Dependencies:** drizzle-orm `libsql/migrator.js:14-28` and `migrator.js:22-23`, the same in 0.36.4 (foothill) and 0.45.2 (youbuzz); turso declares `^0.36.0` (`registry.json:9-12`). wrangler 4.113.0 `wrangler-dist/cli.js:240956-240964`. `@tursodatabase/api` 2.0.5 `dist/index.d.ts:216-218, 275-284`. Turso CLI v1.0.19 `turso db tokens create --help`.
- **main** (0ef349d), under `packages/cli/`: `templates/infra/modules/{turso,cloudflare}/index.ts`, `src/index.ts`, `src/commands/{apply,secret,run}.ts`, `src/engine/apply.ts`, `templates/infra/src/types.ts`, `plugin/skills/zbc/modules.md`. ADR-0016 is `docs/adr/0016-a-credential-is-an-output-the-engine-refuses-to-write-down.md`, one of two numbered 0016. turso has no `secretOutputs` or `actions`, and nothing under `packages/cli/` reads a journal. `secret get` and `--json` shipped in 0ae98a2 (2026-09-06), actions in 5521bc7 (2026-09-08).
