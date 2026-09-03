# cli: five things consumers work around with shell — new

**Consumers:** ceo, foothill-metabolic, crux (3)
**Deployed in production by:** all three

None of these is a module. Each is a place where zbc knows something and offers
no way to get it out, so consumers reach around the CLI.

## 1. No way to hand one secret to a local script — **8 sites, 2 consumers**

The engine already decrypts `secrets.yaml`. Nothing exposes one value to a
script, so six ceo sites and two foothill sites re-implement
`sops -d … | grep`/`sed` against the plaintext:

- ceo: `packages/infra/scripts/ph.ts:28-33`, `packages/recon/scripts/deploy.sh:56,85`,
  `packages/recon/scripts/local-runner.ts:48`, `packages/recon/runner/run.ts:30`,
  `packages/leads/leads.ts:98-99`
- foothill: `scripts/check-orphan-previews.sh:24-25`

A `zbc secret get <env> <key>` closes all eight.

## 2. `apply` has no machine-readable result

The `cloudflare` module emits a `deployUrl` output. To post it on a PR,
foothill greps it back out of the log:
`grep -Eo 'Deployed: +https://…workers.dev'` over `tee`'d stdout
(`.github/workflows/preview.yml:60`). The value exists in the engine and leaves
only as prose. `zbc apply --json` closes it.

## 3. No way to list what was actually provisioned

foothill runs a cross-provider orphan reconciler (`scripts/check-orphan-previews.sh:37`)
that enumerates live per-PR Workers and Turso databases, cross-references
`gh pr view`, and prints manual delete commands. Its header states the reason:
`zbc destroy preview` *"is cleaning up most of the time, not always"* (`:2-4`),
and there is no way to ask what a module provisioned. That is both a missing
inventory surface and a reliability bug worth reproducing on its own.

## 4. No local/dev mode for a provisioning module

foothill's `scripts/with-worktree-db.sh:95` runs `turso dev` on a name-hashed
port with seed-on-first-use and an `lsof` reap of the orphaned `sqld` child,
because the `turso` module is remote-provision-only and
`@libsql/client/web` rejects `file:` URLs (`:6-10`). It extends into CI, which
curl-installs the Turso CLI (`e2e.yml:30-35`).

## 5. No way to adopt existing state, and no way to test a module

Both from ceo's `obs` module, the only consumer module in the survey with tests:

- `obs/capture.ts` is a **reverse-capture tool** — it reads live provider state
  and writes an instance file. `workstation/obs.ts:9-11` says the instance was
  generated this way, not written. There is no `zbc import`/`capture` upstream,
  so adopting existing infrastructure means hand-transcribing it.
- `defineModule` ships no test harness and no fake `ctx`, so they had to export
  pure helpers (`authString:57`, `collidingSceneNames:72`,
  `WRITABLE_TRANSFORM_KEYS:86`) purely to have something testable outside
  `apply`. varnick hits the same wall from the other side: its tests hand-build
  a context literal (`client-domain/index.test.ts:125-132`).

## Also worth knowing: a rule that lives only in a consumer's comment

crux's `.github/workflows/production.yml:52-57`: *"Deliberately `bunx`, never
`bunx --bun`: wrangler on the Bun runtime exits 0 after uploading a version
while silently skipping the deploy."* The `cloudflare` module's
`Deployed … triggers` assertion (`:467`) is what turns that into a failure
rather than a silent no-op — but the runtime choice that avoids it is owned by
the consumer's YAML, and every consumer has to learn it independently. It
belongs in the module or in the scaffolded workflow.

crux also has a second deploy path that bypasses zbc entirely
(`apps/cloud/package.json:8` — `wrangler deploy` direct: no secrets push, no
deploy assertion) and can reach production.
