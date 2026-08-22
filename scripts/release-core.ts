#!/usr/bin/env bun
// Cut a zbc-core release.
//
// A release is one line: `packages/cli/package.json`'s `version`. Everything
// that makes it a release happens in CI. `publish-core.yml` fires on a push to
// main touching `packages/cli/templates/infra/**` or `packages/cli/package.json`,
// splits the prefix into `Zabaca/zbc-core`, pushes it, and tags
// `zbc-core-v<version>` — but **only when that tag does not already exist**.
//
// That skip is the reason this file exists. Between v0.10.6 and v0.10.7 two
// commits landed under the prefix and neither got a tag: the split pushed both
// times and the tag step printed "already published — skipping", because the
// version field had not moved. Main advanced, consumers had no version to pin,
// and one of the two renamed `provision-core`'s marker directory — a change that
// makes every already-provisioned guest read as never-provisioned. Nothing
// reported any of it, because nothing was wrong: the workflow did exactly what
// it says.
//
// So the checks below are not ceremony. They are the things a person has to
// remember at the moment they are least likely to, and `nothing-to-release` is
// the same gap seen from the other side — a tag cut with no prefix change points
// at the previous tag's commit and tells consumers to upgrade to what they have.
//
// Dry run by default. `--push` is what makes it real, because pushing main here
// triggers a workflow that publishes to another repository.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export const VERSION_FILE = 'packages/cli/package.json'
export const PREFIX = 'packages/cli/templates/infra'
export const CORE_REMOTE = 'git@github.com:Zabaca/zbc-core.git'

export type Bump = 'patch' | 'minor' | 'major'

export interface World {
  /** Current branch. publish-core.yml only fires on main. */
  branch: string
  /** Paths git reports as dirty; empty means clean. Paths, not a boolean, so a
   *  refusal tells the reader what to go and look at. */
  dirty: string[]
  localHead: string
  remoteHead: string
  /** `version` as it stands in VERSION_FILE. */
  version: string
  /** Every `zbc-core-v*` tag already on the distribution repo. */
  publishedTags: string[]
  /** Commits under PREFIX since the last published tag, as "<sha> <subject>". */
  unreleasedPrefixCommits: string[]
}

export interface Refusal {
  code: string
  message: string
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function parse(version: string): [number, number, number] {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`not a semver version: ${JSON.stringify(version)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function nextVersion(current: string, bump: Bump): string {
  const [major, minor, patch] = parse(current)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function tagFor(version: string): string {
  return `zbc-core-v${version}`
}

/**
 * The first line of the commit that made `version` current.
 *
 * This is the baseline for "what is unreleased", and it has to be something
 * THIS repository has. The tag does not qualify: `zbc-core-v*` is published to
 * Zabaca/zbc-core by CI and never exists here, which the first live run of this
 * script found by dying on `fatal: bad revision 'zbc-core-v0.10.7..HEAD'`.
 *
 * Using the subject also ties the two halves together — the string `plan()`
 * commits is the string this later searches for, so the convention cannot drift
 * on one side only.
 */
export function releaseSubject(version: string): string {
  return `release(cli): @zabaca/zbc ${version}`
}

/**
 * The paths in `git status --porcelain` output.
 *
 * Every line is `XY<space><path>`, and X is a SPACE for an unstaged
 * modification — so this must be handed the command's output UNTRIMMED. The
 * first version trimmed it along with every other git call and returned
 * `github/workflows/core-tests.yml` for `.github/workflows/core-tests.yml`:
 * the leading space vanished, the slice shifted by one, and only the first line
 * was affected. In a refusal whose entire purpose is naming a path somebody has
 * to open, that is worse than not printing the path at all.
 */
export function dirtyPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
}

function isAhead(target: string, current: string): boolean {
  const a = parse(target)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/** Every reason this release cannot go, together — not the first one found. */
export function checkRelease(world: World, target: string): Refusal[] {
  const refusals: Refusal[] = []
  if (world.branch !== 'main') {
    refusals.push({
      code: 'not-main',
      message: `on ${world.branch}; publish-core.yml fires on a push to main and nowhere else`,
    })
  }
  if (world.dirty.length > 0) {
    refusals.push({
      code: 'dirty',
      message: `working tree is not clean: ${world.dirty.join(', ')}`,
    })
  }
  if (world.localHead !== world.remoteHead) {
    refusals.push({
      code: 'not-synced',
      message:
        `local main (${world.localHead}) is not origin/main (${world.remoteHead}) — ` +
        'releasing from behind tags a split of history the remote does not have',
    })
  }
  if (world.publishedTags.includes(tagFor(target))) {
    refusals.push({
      code: 'tag-exists',
      message: `${tagFor(target)} is already published on zbc-core`,
    })
  }
  if (world.unreleasedPrefixCommits.length === 0) {
    refusals.push({
      code: 'nothing-to-release',
      message:
        `no commit since the last tag touched ${PREFIX}/ — the new tag would point at the ` +
        'same split commit as the previous one, which tells consumers to upgrade to what they have',
    })
  }
  if (!isAhead(target, world.version)) {
    refusals.push({
      code: 'not-ahead',
      message: `${target} is not ahead of the current version ${world.version}`,
    })
  }
  return refusals
}

export interface Plan {
  version: string
  tag: string
  file: string
  commitMessage: string
}

export function plan(world: World, bump: Bump): Plan {
  const version = nextVersion(world.version, bump)
  const commits = world.unreleasedPrefixCommits.map((line) => `  ${line}`).join('\n')
  const commitMessage = [
    `release(cli): @zabaca/zbc ${version}`,
    '',
    `Tags ${tagFor(version)} over the commits that have been on core's main since`,
    `${tagFor(world.version)} with no version naming them:`,
    '',
    commits,
    '',
    `The bump touches ${VERSION_FILE}, which is outside the split prefix, so`,
    "core-main's head does not move — the new tag lands on the commit anyone",
    'tracking main already has, and there is nothing to re-pull.',
    '',
  ].join('\n')
  return { version, tag: tagFor(version), file: VERSION_FILE, commitMessage }
}

// ── the machine ───────────────────────────────────────────────────────────

const gitRaw = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })
const git = (...args: string[]) => gitRaw(...args).trim()

export function readWorld(): World {
  git('fetch', '--quiet', 'origin')
  const version = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version as string
  const publishedTags = execFileSync('git', ['ls-remote', '--tags', CORE_REMOTE], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter((tag): tag is string => Boolean(tag) && tag.startsWith('zbc-core-v'))

  // The commit that made this version current — see releaseSubject. `-F` because
  // the subject contains `@` and `.`, which --grep would otherwise read as a
  // pattern. An empty result means no release commit for this version is in
  // history, so everything under the prefix counts as unreleased.
  const baseline = git(
    'log',
    '--format=%H',
    '--max-count=1',
    '--fixed-strings',
    `--grep=${releaseSubject(version)}`,
  )
  const unreleasedPrefixCommits = git(
    'log',
    '--oneline',
    ...(baseline ? [`${baseline}..HEAD`] : []),
    '--',
    `${PREFIX}/`,
  )
    .split('\n')
    .filter(Boolean)

  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: dirtyPaths(gitRaw('status', '--porcelain')),
    localHead: git('rev-parse', '--short', 'HEAD'),
    remoteHead: git('rev-parse', '--short', 'origin/main'),
    version,
    publishedTags,
    unreleasedPrefixCommits,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const push = args.includes('--push')
  const bump = (args.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch') as Bump

  const world = readWorld()
  const p = plan(world, bump)
  const refusals = checkRelease(world, p.version)

  console.log(`current  ${world.version}`)
  console.log(`release  ${p.version}  →  ${p.tag}`)
  console.log(`covering ${world.unreleasedPrefixCommits.length} commit(s) under ${PREFIX}/`)
  for (const line of world.unreleasedPrefixCommits) console.log(`  ${line}`)

  if (refusals.length > 0) {
    console.error('\nrefused:')
    for (const r of refusals) console.error(`  ${r.code}: ${r.message}`)
    process.exit(1)
  }

  if (!push) {
    console.log('\ndry run — nothing written. Re-run with --push to cut it.')
    console.log('\nThe commit would be:\n')
    console.log(p.commitMessage.replace(/^/gm, '    '))
    process.exit(0)
  }

  const source = readFileSync(VERSION_FILE, 'utf8')
  const needle = `"version": "${world.version}"`
  if (!source.includes(needle)) throw new Error(`${VERSION_FILE} does not contain ${needle}`)
  writeFileSync(VERSION_FILE, source.replace(needle, `"version": "${p.version}"`))
  git('add', '--', VERSION_FILE)
  execFileSync('git', ['commit', '-F', '-'], {
    input: p.commitMessage,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  git('push', 'origin', 'main')
  console.log(`\npushed. publish-core.yml will split, push core-main and tag ${p.tag}.`)
  console.log(`Verify: git ls-remote --tags ${CORE_REMOTE} refs/tags/${p.tag}`)
}
