---
name: release-core
description: Cut a zbc-core release — the `zbc-core-v*` tag consumers pin their vendored subtree to. Use when commits have landed under `packages/cli/templates/infra/` and there is no tag naming them, when a consumer asks what version a module change is in, or when a change under that prefix alters behaviour consumers depend on. Runs `bun scripts/release-core.ts`, which refuses the six ways a release goes wrong.
user-invocable: true
---

A release here is **one line**: the `version` field in `packages/cli/package.json`.
Everything that makes it a release happens in CI afterwards.

## What actually happens

`.github/workflows/publish-core.yml` fires on a push to `main` touching
`packages/cli/templates/infra/**` or `packages/cli/package.json`:

1. `git subtree split --prefix=packages/cli/templates/infra -b core-main`
2. push `core-main` to `Zabaca/zbc-core`'s `main`
3. read `version` from `packages/cli/package.json`, tag `zbc-core-v<version>`
   — **only if that tag does not already exist**

Step 3's condition is the one to understand. It is correct, and it is also how a
release silently does not happen.

## The failure this exists to prevent

Between `v0.10.6` and `v0.10.7` two commits landed under the prefix and neither
got a tag. The split pushed both times; the tag step printed
`already published — skipping`, because the version field had not moved. So:

- `zbc-core`'s `main` advanced past its newest tag.
- Consumers pinning tags saw nothing. Consumers tracking `main` got the change
  with no version to name it.
- One of the two commits renamed `provision-core`'s `MARKER_DIR` from
  `/var/lib/foundry-provision` to `/var/lib/zbc-provision` — which makes every
  already-provisioned guest read as **never provisioned** and re-runs
  provisioning across a consumer's whole fleet on a dependency bump.

Nothing was broken. The workflow did exactly what it says. That is the point:
the gap is invisible from CI, so it has to be checked before the push.

## Cutting one

```sh
bun scripts/release-core.ts                 # dry run — prints the plan, writes nothing
bun scripts/release-core.ts --push          # patch bump, commit, push main
bun scripts/release-core.ts minor --push
```

Dry run is the default deliberately: pushing `main` here publishes to another
repository, so the real thing takes a flag.

## What it refuses, and why each one is a real bug

| code | meaning |
| --- | --- |
| `not-main` | `publish-core.yml` fires on a push to main and nowhere else |
| `dirty` | names the paths, so the reader knows what to look at |
| `not-synced` | releasing from behind tags a split of history the remote lacks |
| `tag-exists` | that version is already published on `zbc-core` |
| `nothing-to-release` | no commit since the last tag touched the prefix — the new tag would point at the previous tag's commit and tell consumers to upgrade to what they already have |
| `not-ahead` | the target version does not exceed the current one |

Every reason is reported at once, not the first found: somebody on a dirty
feature branch should learn both facts in one run.

## After the push

The workflow takes under a minute. Verify the tag actually landed rather than
assuming the run's green tick covers it:

```sh
gh run list --workflow=publish-core.yml --limit 1
git ls-remote --tags git@github.com:Zabaca/zbc-core.git 'refs/tags/zbc-core-v<version>'
```

**Expect the tag to point at `zbc-core`'s existing `main` head.** The version
bump touches `packages/cli/package.json`, which is *outside* the split prefix,
so the split produces no new commit and `core-main`'s head does not move. A
consumer already tracking `main` therefore has nothing to re-pull — the tag just
gives them a name for the commit they have. Verified on `v0.10.7`, which landed
on `10cdfd5`, the head `main` already had.

## Two things this does not do

**It does not publish to npm.** No workflow runs `npm publish`; the CLI package
has a `publish:npm` script that a person runs. npm's latest `@zabaca/zbc` has
been behind the repo's version field for several bumps, so the field names the
`zbc-core` tag reliably and the published CLI only incidentally.

**It does not tell consumers what changed.** A behaviour change under the prefix
— a renamed path, a dropped default, a required field — needs saying in the
commit body, because the tag is the only signal a consumer gets and a version
number does not carry a migration. The generated body lists the covered commits;
add the migration note by hand when one is needed.
