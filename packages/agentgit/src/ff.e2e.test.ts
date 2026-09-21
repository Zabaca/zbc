/**
 * `--ff-on-clean` against real git.
 *
 * Doubling git here would prove nothing: the whole claim is about what git does
 * with a commit whose parents are the local HEAD and the remote ref, and that
 * is exactly the part a double would have to assume. So these run against real
 * repositories, and the assertion in three of the four cases is that the clone
 * did *not* move.
 *
 * The first case is the one that needs stating, because it is the reason the
 * feature exists at all: a diverged branch cannot be fast-forwarded onto the
 * remote ref — `git merge --ff-only origin/main` fails by definition once the
 * clone has a commit of its own. Making the merge commit first is what turns it
 * back into a fast-forward.
 *
 * The second is the one an earlier version of these tests missed, and it is the
 * common one: a clone that is merely behind. Every case here used to start from
 * a clone that had already diverged, on the branch being watched, which is
 * exactly the shape in which two bugs could survive ten passing tests. Both are
 * now cases of their own.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { fastForwardOnClean, isDirty } from './ff'
import { git } from './git'

const run = (dir: string, ...args: string[]) => {
  const result = git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ])
  if (result.code !== 0 && !['merge', 'merge-base'].includes(args[0] ?? '')) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  }
  return result
}

const write = (dir: string, file: string, body: string) =>
  fs.writeFileSync(path.join(dir, file), body)

const commit = (dir: string, file: string, body: string, message: string) => {
  write(dir, file, body)
  run(dir, 'add', file)
  run(dir, 'commit', '-m', message)
  return run(dir, 'rev-parse', 'HEAD').stdout.trim()
}

const head = (dir: string) => run(dir, 'rev-parse', 'HEAD').stdout.trim()

let scratch: string
let upstream: string
let clone: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-ff-'))
  upstream = path.join(scratch, 'upstream')
  clone = path.join(scratch, 'clone')
  fs.mkdirSync(upstream)
  run(upstream, 'init', '--quiet', '--initial-branch=main')
  commit(upstream, 'a.txt', 'base\n', 'base')
  run(scratch, 'clone', '--quiet', upstream, clone)
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Move the upstream branch on, then fetch it, as a watcher would. */
const upstreamMoves = (body: string) => {
  commit(upstream, 'a.txt', body, 'upstream')
  run(clone, 'fetch', '--quiet', 'origin', 'main')
}

describe('fastForwardOnClean', () => {
  test('a diverged branch is taken, keeping both sides', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    upstreamMoves('base\nupstream\n')

    // The thing the feature exists for: this is not a fast-forward.
    expect(run(clone, 'merge', '--ff-only', 'origin/main').code).not.toBe(0)

    const outcome = fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')
    expect(outcome).toMatchObject({ kind: 'moved', synthesized: true })
    expect(head(clone)).toBe(outcome.kind === 'moved' ? outcome.commit : '')
    // Both sides survive, and the result is a real merge commit.
    expect(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8')).toBe('base\nupstream\n')
    expect(fs.readFileSync(path.join(clone, 'b.txt'), 'utf8')).toBe('mine\n')
    expect(run(clone, 'rev-list', '--parents', '-1', 'HEAD').stdout.trim().split(' ')).toHaveLength(
      3,
    )
  })

  test('a clone merely behind is fast-forwarded, with no merge commit made for it', () => {
    // The ordinary case. git can do this by itself, and building a merge commit
    // would leave the clone ahead of origin by one commit nobody else holds —
    // again on the next push, and the one after that.
    upstreamMoves('base\nupstream\n')

    const outcome = fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')
    expect(outcome).toMatchObject({ kind: 'moved', synthesized: false })
    expect(head(clone)).toBe(run(clone, 'rev-parse', 'origin/main').stdout.trim())
    // One parent, not two, and nothing of our own on top of origin.
    expect(run(clone, 'rev-list', '--parents', '-1', 'HEAD').stdout.trim().split(' ')).toHaveLength(
      2,
    )
    expect(run(clone, 'rev-list', '--count', 'origin/main..HEAD').stdout.trim()).toBe('0')
  })

  test('a checkout on another branch is held, and that branch is left alone', () => {
    // `--all-refs` makes this the normal case rather than the corner one: the
    // function acts on HEAD, so acting here would merge upstream `main` into
    // `feature` and then report `refs/heads/main` as the thing that moved.
    run(clone, 'checkout', '--quiet', '-b', 'feature')
    commit(clone, 'f.txt', 'mine\n', 'my feature work')
    upstreamMoves('base\nupstream\n')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toEqual({
      kind: 'elsewhere',
      head: 'refs/heads/feature',
    })
    expect(head(clone)).toBe(before)
    expect(fs.existsSync(path.join(clone, 'f.txt'))).toBe(true)
  })

  test('a detached HEAD is held', () => {
    run(clone, 'checkout', '--quiet', '--detach', 'HEAD')
    upstreamMoves('base\nupstream\n')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toEqual({
      kind: 'elsewhere',
      head: 'a detached HEAD',
    })
    expect(head(clone)).toBe(before)
  })

  test('a conflict is left exactly where it was, with no markers written', () => {
    commit(clone, 'a.txt', 'base\nmine\n', 'local edit')
    upstreamMoves('base\ntheirs\n')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toEqual({
      kind: 'conflicts',
    })
    expect(head(clone)).toBe(before)
    expect(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8')).toBe('base\nmine\n')
  })

  test('uncommitted work holds it off, and survives', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    write(clone, 'b.txt', 'work in progress\n')
    upstreamMoves('base\nupstream\n')
    const before = head(clone)

    const outcome = fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')
    expect(outcome).toEqual({ kind: 'dirty', paths: ['b.txt'] })
    expect(head(clone)).toBe(before)
    expect(fs.readFileSync(path.join(clone, 'b.txt'), 'utf8')).toBe('work in progress\n')
  })

  test('a ref already merged adds nothing', () => {
    upstreamMoves('base\nupstream\n')
    run(clone, 'merge', '--ff-only', 'origin/main')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toEqual({ kind: 'current' })
    expect(head(clone)).toBe(before)
  })

  test("the synthesized commit is the owner's, where the owner has an identity", () => {
    // The owner's identity here is the CONFIGURED one, which is what the
    // fallback defers to. `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the ambient
    // environment outrank it — a CI runner and an agent's own box both set
    // them — so a machine that has them would see its own bot named here and
    // learn nothing about whose identity git chose. They are cleared for the
    // length of the test rather than worked around, for the reason the
    // neighbouring test isolates config: an env identity proves nothing.
    const saved = { ...process.env }
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      delete process.env[key]
    }
    try {
      run(clone, 'config', 'user.name', 'Owner')
      run(clone, 'config', 'user.email', 'owner@example.com')
      commit(clone, 'b.txt', 'mine\n', 'local work')
      upstreamMoves('base\nupstream\n')

      expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toMatchObject({
        kind: 'moved',
        synthesized: true,
      })
      expect(run(clone, 'log', '-1', '--format=%cn <%ce>').stdout.trim()).toBe(
        'Owner <owner@example.com>',
      )
    } finally {
      process.env = saved
    }
  })

  test('it is still written where git has no identity of its own', () => {
    // `commit-tree` refuses a commit it cannot sign a name to, which left this
    // path refused on any machine that was never `git config`ured — the normal
    // state of a container an agent runs in, and how CI found it. Config is
    // isolated here rather than faked through GIT_COMMITTER_NAME, because an
    // env identity would take precedence over the fallback and prove nothing.
    const empty = path.join(scratch, 'empty-gitconfig')
    fs.writeFileSync(empty, '')
    const saved = { ...process.env }
    process.env.GIT_CONFIG_GLOBAL = empty
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      commit(clone, 'b.txt', 'mine\n', 'local work')
      upstreamMoves('base\nupstream\n')

      const outcome = fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')
      expect(outcome).toMatchObject({ kind: 'moved', synthesized: true })
      // Whoever it ends up attributed to, it has a committer and it exists.
      expect(run(clone, 'log', '-1', '--format=%cn').stdout.trim()).not.toBe('')
    } finally {
      process.env = saved
    }
  })

  test('it is repeatable: a second call on an unmoved remote is a no-op', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    upstreamMoves('base\nupstream\n')

    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main').kind).toBe('moved')
    const after = head(clone)
    expect(fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')).toEqual({ kind: 'current' })
    expect(head(clone)).toBe(after)
  })
})

describe('isDirty', () => {
  test('a clean tree is not dirty', () => {
    expect(isDirty(clone)).toEqual([])
  })

  test('untracked files are not dirty', () => {
    // An agent's scratch output must not hold the flag off for a whole session.
    write(clone, 'notes.md', 'scratch\n')
    expect(isDirty(clone)).toEqual([])
  })

  test('a modified tracked file is dirty', () => {
    write(clone, 'a.txt', 'edited\n')
    expect(isDirty(clone)).toEqual(['a.txt'])
  })

  test('a staged change is dirty', () => {
    write(clone, 'c.txt', 'new\n')
    run(clone, 'add', 'c.txt')
    expect(isDirty(clone)).toEqual(['c.txt'])
  })

  test('a rename reports the new path, not "old -> new"', () => {
    run(clone, 'mv', 'a.txt', 'renamed.txt')
    expect(isDirty(clone)).toEqual(['renamed.txt'])
  })

  test('a path with a space is not quoted into something else', () => {
    commit(clone, 'two words.txt', 'one\n', 'add a spaced path')
    write(clone, 'two words.txt', 'two\n')
    expect(isDirty(clone)).toEqual(['two words.txt'])
  })

  test('a tree git cannot read holds, rather than reading as clean', () => {
    // null, not []. The two are not the same and only one of them is safe.
    expect(isDirty(path.join(scratch, 'not-a-repo'))).toBeNull()
  })
})

describe('an untracked file the merge would overwrite', () => {
  test('is refused by git rather than clobbered', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    // Upstream adds a file this clone already has, untracked and different.
    commit(upstream, 'shared.txt', 'theirs\n', 'upstream adds shared.txt')
    run(clone, 'fetch', '--quiet', 'origin', 'main')
    write(clone, 'shared.txt', 'my scratch version\n')

    const outcome = fastForwardOnClean(clone, 'refs/heads/main', 'origin/main')
    expect(outcome.kind).toBe('refused')
    expect(fs.readFileSync(path.join(clone, 'shared.txt'), 'utf8')).toBe('my scratch version\n')
  })
})
