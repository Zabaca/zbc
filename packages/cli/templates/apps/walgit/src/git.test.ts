/**
 * The git wrapper's hygiene.
 *
 * These tests run real git against a real repository, because the property
 * under test is entirely about what the child process makes of the bytes it is
 * handed: a mocked `spawnSync` would only assert that this file and `git.ts`
 * agree on an argument order, which is not the question. The expected answers
 * come from git's own documented behaviour (`--end-of-options` and `--` are
 * git's fences, and `git ls-tree` refuses an unknown switch), not from
 * recomputing what the wrapper does.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { git } from './git'

let work = ''
let gitDir = ''

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-git-'))
  gitDir = path.join(work, '.git')
  git(['init', '--quiet', '--initial-branch=main', work])
  // Two files whose names are option-shaped. Both are legal POSIX filenames
  // and both are what an untrusted browse request can ask for.
  fs.writeFileSync(path.join(work, '-p'), 'p\n')
  fs.writeFileSync(path.join(work, '--output=x'), 'x\n')
  git(['-C', work, 'add', '-A'])
  git([
    '-C',
    work,
    '-c',
    'user.email=walgit@example.test',
    '-c',
    'user.name=walgit',
    'commit',
    '--quiet',
    '-m',
    'option-shaped names',
  ])
})

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

describe('argument hygiene', () => {
  test('an operand shaped like an option is a revision, not an option', () => {
    // `git cat-file -t --batch` is a usage error (exit 129, "-t is
    // incompatible with batch mode"); behind `--end-of-options` the same
    // string is read as an object name and fails with 128 instead.
    const res = git(['cat-file', '-t'], { gitDir, operands: ['--batch'] })

    expect(res.status).toBe(128)
    expect(res.stderr).toContain('Not a valid object name')
    expect(res.stderr).not.toContain('incompatible with batch mode')
  })

  test('a path shaped like an option is a path, not an option', () => {
    const res = git(['ls-tree', '--name-only'], { gitDir, operands: ['HEAD'], paths: ['-p'] })

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('-p\n')
  })

  test('a path that only looks like a revision option stays a path', () => {
    const res = git(['ls-tree', '--name-only'], {
      gitDir,
      operands: ['HEAD'],
      paths: ['--output=x'],
    })

    expect(res.status).toBe(0)
    expect(res.stdout).toBe('--output=x\n')
  })

  test('the repository is named explicitly rather than discovered', () => {
    // Run from a directory that is not inside the repository: without an
    // explicit --git-dir this command has nothing to resolve HEAD against.
    const res = git(['rev-parse', '--git-dir'], { gitDir })

    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(gitDir)
  })
})

describe('environment hygiene', () => {
  test('a GIT_* variable in the parent environment does not reach the child', () => {
    const before = process.env.GIT_AUTHOR_NAME
    process.env.GIT_AUTHOR_NAME = 'a-name-that-must-not-travel'
    try {
      const res = git(['var', 'GIT_AUTHOR_IDENT'], {
        gitDir,
        env: { GIT_AUTHOR_EMAIL: 'fenced@walgit.test', EMAIL: 'fenced@walgit.test' },
      })

      expect(res.stdout).not.toContain('a-name-that-must-not-travel')
    } finally {
      if (before === undefined) delete process.env.GIT_AUTHOR_NAME
      else process.env.GIT_AUTHOR_NAME = before
    }
  })

  test('a variable the caller names explicitly does reach the child', () => {
    const res = git(['var', 'GIT_AUTHOR_IDENT'], {
      gitDir,
      env: { GIT_AUTHOR_NAME: 'named-by-the-caller', GIT_AUTHOR_EMAIL: 'named@walgit.test' },
    })

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('named-by-the-caller')
  })

  test('the quarantine is visible only to a caller that asks for it', () => {
    // git makes a push's objects visible to `pre-receive` through
    // GIT_OBJECT_DIRECTORY; every other caller must not inherit it, because it
    // would point git at an object store that has nothing to do with the
    // command being run.
    const alternate = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-quarantine-'))
    const before = process.env.GIT_OBJECT_DIRECTORY
    process.env.GIT_OBJECT_DIRECTORY = alternate
    try {
      const stripped = git(['rev-parse', '--git-path', 'objects'], { gitDir })
      const inherited = git(['rev-parse', '--git-path', 'objects'], {
        gitDir,
        inheritObjects: true,
      })

      expect(stripped.stdout.trim()).toBe(path.join(gitDir, 'objects'))
      expect(inherited.stdout.trim()).toBe(alternate)
    } finally {
      if (before === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = before
      fs.rmSync(alternate, { recursive: true, force: true })
    }
  })
})
