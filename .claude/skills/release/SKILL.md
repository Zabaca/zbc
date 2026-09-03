---
name: release
description: Cut a zbc release — CHANGELOG, version bump, npm publish, the zbc-core tag consumers pin to, and the production deploy. Use when commits have landed on main that consumers or production should receive, when someone asks what version a change is in, or when npm and the repo have drifted apart. Nothing releases on merge any more; this is the only path.
user-invocable: true
---

Merging and releasing are two different acts. A merge says the code is right; a
release says now is the moment consumers and production receive it. Until
2026-09-03 they were the same act here, and it went wrong in both directions.

## Why this is manual

Publishing used to fire on a push to main filtered to `packages/cli/package.json`.
So a merge that happened to move the version published; a merge that did not
published nothing and said nothing.

- **#115** shipped the instance-level `ephemeral` rule with no bump. It never
  reached npm. It went out only because #116, a day later, bumped for its own
  reasons and carried it.
- **Between v0.10.6 and v0.10.7** two commits landed under the split prefix with
  no version naming them. The split pushed both times while the tag step printed
  `already published — skipping`. One of the two renamed `provision-core`'s
  marker directory — which makes every already-provisioned guest read as **never
  provisioned** and re-runs provisioning across a consumer's fleet.

Nothing reported either, because nothing was failing. The workflows did exactly
what they said. That is the shape this skill exists to break: a release now
happens because someone decided to release, or it does not happen.

## What a release consists of

| | what it moves | how it goes out |
| --- | --- | --- |
| **npm** | `@zabaca/zbc` — CLI + engine + every template | `bun run publish:npm`, locally |
| **zbc-core** | the vendored subtree, tagged `zbc-core-v<version>` | `publish-core.yml`, dispatched |
| **production** | this repo's own deployed services | `production.yml`, dispatched |
| **CHANGELOG** | what a consumer must read before upgrading | a commit, before the bump |

All four are named by one line: `version` in `packages/cli/package.json`.

## Cutting one

### 1. Preflight

```sh
bun scripts/release.ts                  # dry run — prints the plan, writes nothing
bun scripts/release.ts minor            # …for a minor bump
```

Read what it prints before deciding anything else:

- **`covering N commit(s)`** — what npm would receive. Pick the bump from these:
  patch for fixes, minor for a new command, module or flag, major for a break.
- **`core …`** — whether `templates/infra/` changed. If it says *npm-only
  release*, skip `publish-core` entirely in step 5; dispatching it would tag a
  split commit consumers already have.
- **`changelog …`** — whether `packages/cli/CHANGELOG.md` documents this version.

### 2. Write the CHANGELOG entry — or decide it needs none

The file's own header sets the bar: it is for releases **a consumer has to read
before upgrading**, not a commit log. An additive release correctly has no
entry.

Write one when the release changes something a consumer already depends on: a
behaviour that used to be silent and is now a hard error, a config key that
moved, a default that flipped, a teardown that now touches something it did not.
Say what changed, what breaks, and what to do — the 0.14.0 entries are the
model. Commit it separately, before the bump:

```sh
git commit -m "docs(cli): changelog for <version>"
```

### 3. Bump, commit, tag, push

```sh
bun scripts/release.ts minor --push
```

This writes the version, commits `release(cli): @zabaca/zbc <version>`, tags
`zbc-cli-v<version>`, and pushes main plus the tag. **Nothing is published yet.**

The release commit's subject is load-bearing: `scripts/release.ts` finds it
again to answer "what is unreleased" next time. Do not reword it. (0.15.0 was
bumped inside a feature PR rather than by a release commit, which is why the
first dry run after this lands reports every commit in history as unreleased —
it heals on the first real release.)

### 4. Publish to npm

```sh
cd packages/cli && bun run publish:npm
```

**Never `npm publish`** — npm strips the bun shebang from `bin/zbc.js` and
breaks the CLI for everyone who installs it.

If npm refuses for want of 2FA, dispatch the workflow instead — its credential
carries a bypass a personal login does not, which is the whole reason
`publish-npm.yml` still exists:

```sh
gh workflow run publish-npm.yml
```

### 5. Tag zbc-core — only if the preflight said so

```sh
gh workflow run publish-core.yml
```

Splits `packages/cli/templates/infra/` into `Zabaca/zbc-core`, pushes it, and
tags `zbc-core-v<version>`.

**Expect the tag to land on core's existing `main` head.** The bump touches
`packages/cli/package.json`, which is *outside* the split prefix, so the split
produces no new commit. A consumer tracking main has nothing to re-pull — the
tag just gives them a name for the commit they have.

### 6. Deploy production

Work out the scope from what has landed since the last release, then dispatch:

```sh
bun scripts/affected-instances.ts production $(git diff --name-only <last-release-commit>..HEAD)
gh workflow run production.yml -f instances=<what it printed>
```

The script answers `ALL` whenever it is unsure — a needless apply costs a slow
job, a missed one costs a change that silently never deployed. Do not narrow
past it by hand.

### 7. Verify, rather than trusting the green ticks

```sh
npm view @zabaca/zbc version
git ls-remote --tags git@github.com:Zabaca/zbc-core.git 'refs/tags/zbc-core-v<version>'
gh run list --workflow=production.yml --limit 1
```

## What the preflight refuses, and why each is a real bug

| code | meaning |
| --- | --- |
| `not-main` | a release tags main and nowhere else |
| `dirty` | uncommitted work would not be in the release; an untracked file under `packages/cli/` would ship anyway, because `bun publish` packs from disk |
| `not-synced` | releasing from behind tags a split of history the remote lacks |
| `tag-exists` | that `zbc-core-v*` tag is already published |
| `cli-tag-exists` | that `zbc-cli-v*` tag is already in this repository |
| `npm-published` | npm never lets a version be replaced — caught here it costs nothing, caught by `bun publish` it costs a landed bump, commit, tag and push |
| `nothing-to-release` | no commit since the last release touched `packages/cli/` |
| `not-ahead` | the target version does not exceed the current one |

Every reason is reported at once, not the first found: somebody on a dirty
feature branch should learn both facts in one run.
