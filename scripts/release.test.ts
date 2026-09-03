import { describe, expect, test } from 'bun:test'
import {
  type World,
  changelogVersions,
  checkRelease,
  cliTagFor,
  dirtyPaths,
  nextVersion,
  plan,
  releaseBlockingPaths,
  releaseSubject,
  tagFor,
} from './release'

// A release is a one-line version bump, and until 2026-09-03 that line was also
// the trigger: merging a PR that moved it published to npm and tagged zbc-core,
// merging one that did not published nothing and said nothing.
//
// Both halves went wrong in practice. #115 shipped the ephemeral rule with no
// bump and never reached npm. Earlier, two commits landed under the split
// prefix between v0.10.6 and v0.10.7 with no version naming them — the split
// pushed both times while the tag step printed "already published — skipping",
// because the version field had not moved. One of those two renamed a marker
// directory every provisioned guest depends on. Nothing reported either.
//
// Releasing is now deliberate, and the checks below are the things somebody has
// to remember at the moment they are least likely to.

const clean: World = {
  branch: 'main',
  dirty: [],
  localHead: 'aaaa111',
  remoteHead: 'aaaa111',
  version: '0.10.6',
  publishedTags: ['zbc-core-v0.10.5', 'zbc-core-v0.10.6'],
  cliTags: ['zbc-cli-v0.10.5', 'zbc-cli-v0.10.6'],
  publishedNpmVersions: ['0.10.5', '0.10.6'],
  unreleasedCommits: ['ca81b9e a fly deploy module', '77c0de1 apply --only'],
  unreleasedPrefixCommits: ['ca81b9e a fly deploy module'],
  changelogVersions: ['0.10.6'],
}

describe('nextVersion', () => {
  test.each([
    ['0.10.6', 'patch', '0.10.7'],
    ['0.10.6', 'minor', '0.11.0'],
    ['0.10.6', 'major', '1.0.0'],
    ['1.2.3', 'minor', '1.3.0'],
  ] as const)('%s + %s = %s', (current, bump, want) => {
    expect(nextVersion(current, bump)).toBe(want)
  })

  test('minor and major zero the fields below them', () => {
    expect(nextVersion('1.2.9', 'major')).toBe('2.0.0')
    expect(nextVersion('1.2.9', 'minor')).toBe('1.3.0')
  })

  test('refuses a version it cannot parse rather than guessing', () => {
    expect(() => nextVersion('0.10', 'patch')).toThrow()
    expect(() => nextVersion('v0.10.6', 'patch')).toThrow()
  })
})

test('the tags mirror the CLI version, which is the one line a release moves', () => {
  expect(tagFor('0.10.7')).toBe('zbc-core-v0.10.7')
  expect(cliTagFor('0.10.7')).toBe('zbc-cli-v0.10.7')
})

describe('checkRelease', () => {
  const codes = (w: Partial<World>, target = '0.10.7') =>
    checkRelease({ ...clean, ...w }, target).map((r) => r.code)

  test('a clean main with unreleased commits is releasable', () => {
    expect(codes({})).toEqual([])
  })

  test('refuses off main — a release tags main and nowhere else', () => {
    expect(codes({ branch: 'foundry-release-core' })).toContain('not-main')
  })

  test('refuses a dirty tree, and names the paths', () => {
    const refusals = checkRelease({ ...clean, dirty: ['packages/cli/src/x.ts'] }, '0.10.7')
    expect(refusals.map((r) => r.code)).toContain('dirty')
    expect(refusals.find((r) => r.code === 'dirty')?.message).toContain('packages/cli/src/x.ts')
  })

  test('refuses when local main is not what origin has', () => {
    // Releasing from behind tags a split of history the remote does not have,
    // and the push then fails or force-moves core's main.
    expect(codes({ localHead: 'bbbb222' })).toContain('not-synced')
  })

  test('refuses a tag that zbc-core already published', () => {
    expect(codes({}, '0.10.6')).toContain('tag-exists')
  })

  test('refuses a zbc-cli tag this repository already has', () => {
    expect(codes({}, '0.10.6')).toContain('cli-tag-exists')
  })

  // npm is the only publication here that cannot be undone or replaced. Caught
  // now, it is a refusal before anything is written; caught by `bun publish`, it
  // is a failure after the bump, the commit, the tag and the push have landed.
  test('refuses a version npm already has, since npm never lets one be replaced', () => {
    expect(codes({}, '0.10.6')).toContain('npm-published')
  })

  test('a version npm has not seen is fine, even when other checks fail', () => {
    expect(codes({ branch: 'wip' }, '0.10.7')).not.toContain('npm-published')
  })

  // The check that would have caught the actual gap, from the other side: a
  // release with nothing new in it tells a consumer there is something to
  // upgrade to when there is not.
  test('refuses when nothing at all has landed since the last release', () => {
    expect(codes({ unreleasedCommits: [], unreleasedPrefixCommits: [] })).toContain(
      'nothing-to-release',
    )
  })

  // The npm surface is wider than the vendored one. An engine-only change
  // ships a real new CLI while zbc-core has nothing to receive, and refusing
  // that is exactly how #115 went unpublished.
  test('an npm-only release is allowed — nothing under the split prefix is not nothing', () => {
    expect(codes({ unreleasedPrefixCommits: [] })).not.toContain('nothing-to-release')
  })

  test('refuses a target that is not ahead of the current version', () => {
    expect(codes({ version: '0.11.0' })).toContain('not-ahead')
  })

  test('reports every reason at once, not the first', () => {
    // Someone on a dirty feature branch should learn both facts in one run.
    expect(codes({ branch: 'wip', dirty: ['a.ts'] })).toEqual(
      expect.arrayContaining(['not-main', 'dirty']),
    )
  })
})

describe('plan', () => {
  const p = plan(clean, 'patch')

  test('names the version, both tags, and the one file it edits', () => {
    expect(p.version).toBe('0.10.7')
    expect(p.tag).toBe('zbc-core-v0.10.7')
    expect(p.cliTag).toBe('zbc-cli-v0.10.7')
    expect(p.file).toBe('packages/cli/package.json')
  })

  test('needsCore decides whether publish-core has anything to do', () => {
    expect(p.needsCore).toBe(true)
    expect(plan({ ...clean, unreleasedPrefixCommits: [] }, 'patch').needsCore).toBe(false)
  })

  // Not a refusal — the CHANGELOG documents only releases a consumer must read
  // before upgrading, so most correctly have no entry. But "I forgot" and "it
  // does not need one" look identical from here, so the plan reports which.
  test('reports whether the CHANGELOG documents the version being cut', () => {
    expect(p.hasChangelogEntry).toBe(false)
    expect(plan({ ...clean, changelogVersions: ['0.10.7'] }, 'patch').hasChangelogEntry).toBe(true)
  })

  test('an npm-only release says so, rather than implying a subtree pull', () => {
    const npmOnly = plan({ ...clean, unreleasedPrefixCommits: [] }, 'patch')
    expect(npmOnly.commitMessage).toContain('npm-only release')
  })

  test('follows the commit convention every past release used', () => {
    expect(p.commitMessage.split('\n')[0]).toBe('release(cli): @zabaca/zbc 0.10.7')
  })

  test('the body names the commits the tag will cover', () => {
    expect(p.commitMessage).toContain('ca81b9e a fly deploy module')
  })

  test('says which of the covered commits the core tag is for', () => {
    expect(p.commitMessage).toContain('packages/cli/templates/infra/')
    expect(p.commitMessage).toContain('zbc-core-v0.10.7')
  })
})

describe('changelogVersions', () => {
  test('reads the release headings and nothing else', () => {
    const md = ['# @zabaca/zbc', '', '## 0.14.0', '', '### A behaviour change', '', '## 0.13.0']
    expect(changelogVersions(md.join('\n'))).toEqual(['0.14.0', '0.13.0'])
  })

  test('a prose heading that is not a version is not one', () => {
    expect(changelogVersions('## Unreleased\n## 0.1.0\n')).toEqual(['0.1.0'])
  })
})

// A blanket "the tree is clean" refused every release in this repository: it
// permanently carries untracked `.claude/skills/`, `docs/research/` and scratch
// directories, none of which can reach a consumer. A check that is always red is
// one people learn to pass with a flag.
describe('releaseBlockingPaths', () => {
  test('untracked noise outside the package does not block a release', () => {
    expect(releaseBlockingPaths('?? .claude/skills/foo\n?? docs/research/x.md\n')).toEqual([])
  })

  test('an untracked file inside the package does — bun publish packs from disk', () => {
    expect(releaseBlockingPaths('?? packages/cli/secret.txt\n')).toEqual([
      'packages/cli/secret.txt',
    ])
  })

  test('a tracked modification anywhere blocks: it would not be in the release', () => {
    expect(
      releaseBlockingPaths(' M .github/workflows/production.yml\nM  scripts/release.ts\n'),
    ).toEqual(['.github/workflows/production.yml', 'scripts/release.ts'])
  })
})

// The baseline for "what is unreleased" has to be a ref THIS repository has.
//
// The first version of readWorld used the previous zbc-core tag — which is
// published to Zabaca/zbc-core and does not exist here at all, so the very first
// live run died on `fatal: bad revision 'zbc-core-v0.10.7..HEAD'`. Every unit
// test passed: the mistake was in the IO layer, against a world the fixtures
// asserted rather than observed.
//
// What does exist locally is the release commit itself, and its subject is fixed
// by the same convention the plan writes. That makes the two halves one fact:
// the string this script commits is the string it later searches for.
describe('releaseSubject', () => {
  test("is exactly what a release commit's first line says", () => {
    expect(releaseSubject('0.10.7')).toBe('release(cli): @zabaca/zbc 0.10.7')
  })

  test('is the subject plan() writes, so the search can find what the script committed', () => {
    const p = plan({ ...clean, version: '0.10.6' }, 'patch')
    expect(p.commitMessage.split('\n')[0]).toBe(releaseSubject('0.10.7'))
  })

  test('is not a zbc-core tag — that tag is published to another repository', () => {
    expect(releaseSubject('0.10.7')).not.toContain('zbc-core-v')
  })
})

// `git status --porcelain` pads every line to `XY<space><path>`, and an
// unstaged modification makes X a SPACE. Trimming the command's output — which
// the git helper did, reasonably, for every other call — eats that space on the
// first line only, so the first path comes back one character short and every
// later one is fine. Observed as `github/workflows/core-tests.yml` in a refusal
// whose whole job is naming a path the reader has to go and find, and invisible
// in every fixture because fixtures are written already-trimmed.
describe('dirtyPaths', () => {
  test('keeps the leading character of an unstaged modification', () => {
    expect(dirtyPaths(' M .github/workflows/core-tests.yml\n')).toEqual([
      '.github/workflows/core-tests.yml',
    ])
  })

  test('reads staged, unstaged and untracked alike', () => {
    expect(dirtyPaths('M  a.ts\n M .b.ts\n?? c/\nA  d.ts\n')).toEqual([
      'a.ts',
      '.b.ts',
      'c/',
      'd.ts',
    ])
  })

  test('a clean tree is no paths, not one empty string', () => {
    expect(dirtyPaths('')).toEqual([])
    expect(dirtyPaths('\n')).toEqual([])
  })
})
