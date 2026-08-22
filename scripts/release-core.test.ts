import { describe, expect, test } from 'bun:test'
import {
  type World,
  checkRelease,
  dirtyPaths,
  nextVersion,
  plan,
  releaseSubject,
  tagFor,
} from './release-core'

// A release here is a one-line version bump, and everything that makes it a
// release happens in CI afterwards: publish-core.yml splits
// packages/cli/templates/infra into Zabaca/zbc-core, pushes it, and tags
// zbc-core-v<version> — but only when that tag does not already exist.
//
// That skip is why this script exists. Between v0.10.6 and v0.10.7 two commits
// landed under the split prefix and neither got a tag: the split pushed both
// times and the tag step printed "already published — skipping", because the
// version field had not moved. Main advanced, consumers had no version to pin,
// and one of those commits renamed a marker directory every provisioned guest
// depends on. Nothing reported it. The checks below are the things somebody has
// to remember otherwise.

const clean: World = {
  branch: 'main',
  dirty: [],
  localHead: 'aaaa111',
  remoteHead: 'aaaa111',
  version: '0.10.6',
  publishedTags: ['zbc-core-v0.10.5', 'zbc-core-v0.10.6'],
  unreleasedPrefixCommits: ['ca81b9e a fly deploy module'],
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

test('the tag mirrors the CLI version, which is what publish-core.yml reads', () => {
  expect(tagFor('0.10.7')).toBe('zbc-core-v0.10.7')
})

describe('checkRelease', () => {
  const codes = (w: Partial<World>, target = '0.10.7') =>
    checkRelease({ ...clean, ...w }, target).map((r) => r.code)

  test('a clean main with unreleased prefix commits is releasable', () => {
    expect(codes({})).toEqual([])
  })

  test('refuses off main — publish-core.yml only fires on a push to main', () => {
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

  // The check that would have caught the actual gap, from the other side: a
  // release with nothing new under the prefix produces a tag pointing at the
  // same split commit as the previous one, which tells a consumer there is
  // something to upgrade to when there is not.
  test('refuses when no commit since the last tag touched the split prefix', () => {
    expect(codes({ unreleasedPrefixCommits: [] })).toContain('nothing-to-release')
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

  test('names the version, the tag, and the one file it edits', () => {
    expect(p.version).toBe('0.10.7')
    expect(p.tag).toBe('zbc-core-v0.10.7')
    expect(p.file).toBe('packages/cli/package.json')
  })

  test('follows the commit convention every past release used', () => {
    expect(p.commitMessage.split('\n')[0]).toBe('release(cli): @zabaca/zbc 0.10.7')
  })

  test('the body names the commits the tag will cover', () => {
    expect(p.commitMessage).toContain('ca81b9e a fly deploy module')
  })

  test('says the split head does not move, because the bump is outside the prefix', () => {
    // The single most useful fact for a consumer already tracking main: the new
    // tag lands on the commit they have, so there is nothing to re-pull.
    expect(p.commitMessage).toMatch(/outside the split prefix|head does not move/)
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
