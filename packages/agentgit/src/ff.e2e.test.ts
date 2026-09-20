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

    const outcome = fastForwardOnClean(clone, 'origin/main')
    expect(outcome.kind).toBe('moved')
    expect(head(clone)).toBe(outcome.kind === 'moved' ? outcome.commit : '')
    // Both sides survive, and the result is a real merge commit.
    expect(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8')).toBe('base\nupstream\n')
    expect(fs.readFileSync(path.join(clone, 'b.txt'), 'utf8')).toBe('mine\n')
    expect(run(clone, 'rev-list', '--parents', '-1', 'HEAD').stdout.trim().split(' ')).toHaveLength(
      3,
    )
  })

  test('a conflict is left exactly where it was, with no markers written', () => {
    commit(clone, 'a.txt', 'base\nmine\n', 'local edit')
    upstreamMoves('base\ntheirs\n')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'origin/main')).toEqual({ kind: 'conflicts' })
    expect(head(clone)).toBe(before)
    expect(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8')).toBe('base\nmine\n')
  })

  test('uncommitted work holds it off, and survives', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    write(clone, 'b.txt', 'work in progress\n')
    upstreamMoves('base\nupstream\n')
    const before = head(clone)

    const outcome = fastForwardOnClean(clone, 'origin/main')
    expect(outcome).toEqual({ kind: 'dirty', paths: ['b.txt'] })
    expect(head(clone)).toBe(before)
    expect(fs.readFileSync(path.join(clone, 'b.txt'), 'utf8')).toBe('work in progress\n')
  })

  test('a ref already merged adds nothing', () => {
    upstreamMoves('base\nupstream\n')
    run(clone, 'merge', '--ff-only', 'origin/main')
    const before = head(clone)

    expect(fastForwardOnClean(clone, 'origin/main')).toEqual({ kind: 'current' })
    expect(head(clone)).toBe(before)
  })

  test('it is repeatable: a second call on an unmoved remote is a no-op', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    upstreamMoves('base\nupstream\n')

    expect(fastForwardOnClean(clone, 'origin/main').kind).toBe('moved')
    const after = head(clone)
    expect(fastForwardOnClean(clone, 'origin/main')).toEqual({ kind: 'current' })
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
})

describe('an untracked file the merge would overwrite', () => {
  test('is refused by git rather than clobbered', () => {
    commit(clone, 'b.txt', 'mine\n', 'local work')
    // Upstream adds a file this clone already has, untracked and different.
    commit(upstream, 'shared.txt', 'theirs\n', 'upstream adds shared.txt')
    run(clone, 'fetch', '--quiet', 'origin', 'main')
    write(clone, 'shared.txt', 'my scratch version\n')

    const outcome = fastForwardOnClean(clone, 'origin/main')
    expect(outcome.kind).toBe('refused')
    expect(fs.readFileSync(path.join(clone, 'shared.txt'), 'utf8')).toBe('my scratch version\n')
  })
})
