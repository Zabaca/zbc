# An app too large to copy once is pulled as a subtree of its own public copy

An app template is copied into a consumer's repository once, by `zbc add`, and is the consumer's from then on: nothing flows after the copy. That suits a small Worker a project reads once and bends to itself. It does not suit `space`, a company's whole workspace (eight packages, a deploy kit, about a thousand files) that keeps changing: a consumer who copied it would be a version behind within the week, with no way to take a fix but a hand diff, which is the failure [ADR-0005](./0005-subtree-distribution-zbc-core.md) names for the engine.

Decided: an app of that size is a **vendored app**. It lives in this repository at `packages/cli/templates/apps/<name>/`, a workflow splits that folder to a public repository of its own on every merge that touches it (`Zabaca/zbc-space`), and a consumer pulls that repository as a squashed git subtree at `vendor/<name>/`: `zbc add <name>` for the first pull, `zbc update <name>` for every later one. The app has versions of its own (a tag on the public copy when the folder's `package.json` version changes), unrelated to the CLI's. It is not in the npm package.

The CLI knows three things about a vendored app: its name, its public copy's address and where it lands. Everything else is the app's own manifest (`zbc-app.json` at the folder's root), read from the pulled copy: its workspace folders, the zbc modules its deploy builds from, and the files a new install starts from. So the app changes any of those without a CLI release.

A consumer may change the folder. Their edits ride through an update as any merge carries them, and after a pull the CLI names the files under the prefix the copy does not ship and the files that differ from the commit pulled. That is information, never a failure: unlike the engine's prefix, nobody pushes this one upstream, so a consumer's file in it endangers nothing. What an update can never touch is the install itself: a consumer's declaration, install file, content and secrets live outside the prefix, in the environment's own folder.

## Considered Options

- **A bundled app template, as the others are.** One copy, no updates, and a thousand files in every `npm install` of the CLI for the consumers who never add it. Rejected.
- **An npm package per part.** Versioned, but read-only: a company could not change its own space, and the space's design is that each company owns its copy.
- **A subtree of this whole repository, or of zbc-core with the app inside it.** Every consumer of the engine would carry the app. The split exists so that each thing a consumer pulls is only that thing.
- **The app's public copy as the place it is written.** Its suites and the kit's are tested against this repository's modules; writing it here keeps one place where a module change and the app's use of it are reviewed together. The public copy is generated and refuses direct changes on principle, as zbc-core does.

## Consequences

- The app's folder is public twice: here, and as its own repository whose history is this repository's commits that touched the folder, messages included. What may be written in it is the README's six rules, and the folder's own check (`bun run check:public`) runs before every split.
- This repository's formatter and linter leave the folder alone. A reformat here would be a diff in every install that pulled it.
- `.zbc-vendor.json` gains an `apps` entry per app: the repository, the ref asked for and the commit it resolved to. The commit is what tells a tag pull from a pull of the newest commit, and what a survey of consumers compares their files against.
- The first pull of an app whose public copy has no version tag needs a ref named (`--ref main`).
- A vendored app is offered by name before the bundled registry is searched, so its name can never be shadowed by a template.
