#!/usr/bin/env bun
// Cut a zbc release: the npm package and the vendored subtree, in one act.
//
// A release is one line — `packages/cli/package.json`'s `version` — and until
// 2026-09-03 that line was also the trigger. Merging a PR that happened to move
// it published to npm and tagged zbc-core; merging one that did not published
// nothing and said nothing. Both halves went wrong in practice. #115 shipped
// the ephemeral rule with no bump and never reached npm at all. Earlier, two
// commits landed under the split prefix between v0.10.6 and v0.10.7 with no
// version naming them — one of which renamed `provision-core`'s marker
// directory, a change that makes every already-provisioned guest read as never
// provisioned. Nothing reported either, because nothing was failing: the
// workflows did exactly what they said.
//
// So releasing is now deliberate, and this is its preflight. It answers what
// would ship, refuses every way the answer is wrong at once, and — with
// `--push` — writes the bump, the commit and the `zbc-cli-v*` tag. Publishing
// itself is the caller's next step, because it needs credentials this script
// should not assume: see `.claude/skills/release/SKILL.md`.
//
// Dry run by default. `--push` is what makes it real.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const VERSION_FILE = 'packages/cli/package.json'
export const CHANGELOG_FILE = 'packages/cli/CHANGELOG.md'
/** What `publish-core.yml` splits into the repo consumers vendor. */
export const PREFIX = 'packages/cli/templates/infra'
/** What ships to npm as @zabaca/zbc. */
export const PACKAGE = 'packages/cli'
export const CORE_REMOTE = 'git@github.com:Zabaca/zbc-core.git'

export type Bump = 'patch' | 'minor' | 'major'

export interface World {
  /** Current branch. A release tags main and nowhere else. */
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
  /** Every `zbc-cli-v*` tag in this repository. */
  cliTags: string[]
  /** Versions already on npm, so a release cannot name one that is taken. */
  publishedNpmVersions: string[]
  /** Commits under PACKAGE since the last release — what npm would receive. */
  unreleasedCommits: string[]
  /** Commits under PREFIX since the last release — what zbc-core would receive. */
  unreleasedPrefixCommits: string[]
  /** Whether CHANGELOG_FILE already has a section for the target version. */
  changelogVersions: string[]
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

export function cliTagFor(version: string): string {
  return `zbc-cli-v${version}`
}

/**
 * The first line of the commit that made `version` current.
 *
 * This is the baseline for "what is unreleased", and it has to be something
 * THIS repository has. The core tag does not qualify: `zbc-core-v*` is pushed
 * to Zabaca/zbc-core and never exists here, which the first live run of this
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

/**
 * The subset of a dirty tree that can actually spoil a release.
 *
 * A blanket "working tree is clean" refused every release in this repository:
 * it permanently carries untracked `.claude/skills/`, `docs/research/` and
 * scratch directories, none of which can reach a consumer. A check that is
 * always red is a check people learn to pass with `--no-verify`, so it has to
 * mean something.
 *
 * Two things do mean something. A modification to a TRACKED file is work that
 * is about to be released without being committed — the version is cut from
 * HEAD, so whatever is uncommitted silently is not in it. And an UNTRACKED file
 * under the published package ships anyway: `bun publish` packs the directory
 * from disk, not from git, so a stray file there reaches npm precisely because
 * nobody committed it.
 */
export function releaseBlockingPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .filter((line) => !line.startsWith('??') || line.slice(3).startsWith(`${PACKAGE}/`))
    .map((line) => line.slice(3))
}

/** The versions a CHANGELOG names, from its `## <semver>` headings. */
export function changelogVersions(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => /^##\s+(\d+\.\d+\.\d+)\s*$/.exec(line)?.[1])
    .filter((version): version is string => Boolean(version))
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
      message: `on ${world.branch}; a release tags main and nowhere else`,
    })
  }
  if (world.dirty.length > 0) {
    refusals.push({
      code: 'dirty',
      message:
        `uncommitted work that would not be in the release, or would ship unreviewed: ` +
        world.dirty.join(', '),
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
  if (world.cliTags.includes(cliTagFor(target))) {
    refusals.push({
      code: 'cli-tag-exists',
      message: `${cliTagFor(target)} already exists in this repository`,
    })
  }
  // npm is the one publication that cannot be undone or overwritten. Catching
  // it here turns a failed `bun publish` at the very end — after the bump, the
  // commit, the tag and the push — into a refusal before anything is written.
  if (world.publishedNpmVersions.includes(target)) {
    refusals.push({
      code: 'npm-published',
      message: `@zabaca/zbc ${target} is already on npm; npm never lets a version be replaced`,
    })
  }
  if (world.unreleasedCommits.length === 0 && world.unreleasedPrefixCommits.length === 0) {
    refusals.push({
      code: 'nothing-to-release',
      message:
        `no commit since the last release touched ${PACKAGE}/ — the new version would ship ` +
        'byte-for-byte what the last one did, and tell consumers to upgrade to what they have',
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
  cliTag: string
  file: string
  commitMessage: string
  /** Whether zbc-core has anything new to receive — decides if publish-core runs. */
  needsCore: boolean
  /** Whether the CHANGELOG already documents this version. */
  hasChangelogEntry: boolean
}

export function plan(world: World, bump: Bump): Plan {
  const version = nextVersion(world.version, bump)
  const commits = world.unreleasedCommits.map((line) => `  ${line}`).join('\n')
  const needsCore = world.unreleasedPrefixCommits.length > 0
  const commitMessage = [
    releaseSubject(version),
    '',
    `Ships ${world.unreleasedCommits.length} commit(s) under ${PACKAGE}/ that no`,
    'version names yet:',
    '',
    commits,
    '',
    needsCore
      ? `${world.unreleasedPrefixCommits.length} of them touch ${PREFIX}/, so ${tagFor(version)} ` +
        'names them for consumers vendoring the subtree.'
      : `Nothing under ${PREFIX}/ changed, so this is an npm-only release — consumers ` +
        'vendoring the subtree have nothing to re-pull.',
    '',
  ].join('\n')
  return {
    version,
    tag: tagFor(version),
    cliTag: cliTagFor(version),
    file: VERSION_FILE,
    commitMessage,
    needsCore,
    hasChangelogEntry: world.changelogVersions.includes(version),
  }
}

// ── the machine ───────────────────────────────────────────────────────────

const gitRaw = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })
const git = (...args: string[]) => gitRaw(...args).trim()

/**
 * Versions already on npm.
 *
 * Best-effort: a network failure or a package that does not exist yet must not
 * stop a release, so this answers `[]` rather than throwing. The cost of being
 * wrong here is the `bun publish` at the end reporting the collision itself,
 * which is where it would have been reported before this check existed.
 */
function readNpmVersions(): string[] {
  try {
    const out = execFileSync('npm', ['view', '@zabaca/zbc', 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed: unknown = JSON.parse(out)
    if (Array.isArray(parsed)) return parsed as string[]
    return typeof parsed === 'string' ? [parsed] : []
  } catch {
    return []
  }
}

export function readWorld(): World {
  git('fetch', '--quiet', '--tags', 'origin')
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
  // history, so everything counts as unreleased.
  const baseline = git(
    'log',
    '--format=%H',
    '--max-count=1',
    '--fixed-strings',
    `--grep=${releaseSubject(version)}`,
  )
  const since = (dir: string) =>
    git('log', '--oneline', ...(baseline ? [`${baseline}..HEAD`] : []), '--', `${dir}/`)
      .split('\n')
      .filter(Boolean)

  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: releaseBlockingPaths(gitRaw('status', '--porcelain')),
    localHead: git('rev-parse', '--short', 'HEAD'),
    remoteHead: git('rev-parse', '--short', 'origin/main'),
    version,
    publishedTags,
    cliTags: git('tag', '--list', 'zbc-cli-v*').split('\n').filter(Boolean),
    publishedNpmVersions: readNpmVersions(),
    unreleasedCommits: since(PACKAGE),
    unreleasedPrefixCommits: since(PREFIX),
    changelogVersions: existsSync(CHANGELOG_FILE)
      ? changelogVersions(readFileSync(CHANGELOG_FILE, 'utf8'))
      : [],
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
  console.log(`release  ${p.version}  →  ${p.cliTag}${p.needsCore ? ` + ${p.tag}` : ''}`)
  console.log(`covering ${world.unreleasedCommits.length} commit(s) under ${PACKAGE}/`)
  // Bounded, because the count is unbounded when no release commit exists to
  // measure from — a version bumped inside a feature PR rather than by a
  // release leaves no `release(cli):` subject to find, and every commit in
  // history then reads as unreleased. That is the honest answer, and it is
  // still not 153 lines a reader will scroll past.
  const LISTED = 15
  for (const line of world.unreleasedCommits.slice(0, LISTED)) console.log(`  ${line}`)
  if (world.unreleasedCommits.length > LISTED) {
    console.log(`  … and ${world.unreleasedCommits.length - LISTED} more`)
  }
  console.log(
    p.needsCore
      ? `\ncore     ${world.unreleasedPrefixCommits.length} of them touch ${PREFIX}/ — publish-core needed`
      : `\ncore     nothing under ${PREFIX}/ — npm-only release`,
  )
  // Not a refusal. The CHANGELOG's own header says it is for releases a
  // consumer has to read before upgrading, so most releases correctly have no
  // entry — but "I forgot" and "it does not need one" look identical from here,
  // and only the person cutting it can tell them apart.
  console.log(
    p.hasChangelogEntry
      ? `changelog documents ${p.version}`
      : `changelog has no ${p.version} section — correct for an additive release, a gap otherwise`,
  )

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
  git('tag', p.cliTag)
  git('push', 'origin', 'main', p.cliTag)

  console.log(`\npushed main and ${p.cliTag}. Nothing is published yet — that is the point.`)
  console.log('\nNext:')
  console.log(`  cd packages/cli && bun run publish:npm      # never npm publish`)
  if (p.needsCore) console.log(`  gh workflow run publish-core.yml           # tags ${p.tag}`)
  console.log(`  gh workflow run production.yml -f instances=<scope|ALL>`)
}
