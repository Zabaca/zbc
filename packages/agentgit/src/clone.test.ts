/**
 * Discovery, against real repositories on disk.
 *
 * The three commands agree about which remote a clone belongs to only if they
 * ask one thing, and what that thing answers is a claim about git — about what
 * `rev-parse`, `remote -v` and `symbolic-ref` say in a directory that really
 * exists. A fake git would let this file pass while the claim was false, so
 * every repository here is built by git itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { discoverClone } from './clone'
import { git } from './git'

/** git with an identity and no ambient config, so CI behaves as a laptop does. */
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
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  }
  return result.stdout.trim()
}

let tmp: string

/** A repository with one commit on `main`, and whatever remotes were named. */
const repository = (name: string, remotes: Record<string, string> = {}): string => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  run(dir, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  run(dir, 'add', 'README.md')
  run(dir, 'commit', '-m', 'first')
  for (const [remote, url] of Object.entries(remotes)) run(dir, 'remote', 'add', remote, url)
  return dir
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-clone-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('discoverClone', () => {
  test('a clone of a walgit repository is reported whole', () => {
    const dir = repository('demo', { origin: 'https://agentgit.zabaca.com/demo.git' })

    const found = discoverClone(dir)

    expect(found).toEqual({
      kind: 'clone',
      root: fs.realpathSync(dir),
      remoteName: 'origin',
      host: 'agentgit.zabaca.com',
      origin: 'https://agentgit.zabaca.com',
      repo: 'demo',
      ref: 'refs/heads/main',
    })
  })

  test('a checkout whose only remote is GitHub keeps its ref, and says what it saw', () => {
    const dir = repository('foreign', { origin: 'git@github.com:you/thing.git' })

    const found = discoverClone(dir)

    expect(found).toEqual({
      kind: 'no-remote',
      root: fs.realpathSync(dir),
      ref: 'refs/heads/main',
      remotes: [{ name: 'origin', url: 'git@github.com:you/thing.git' }],
    })
  })

  test('a checkout with no remotes at all is the same arm, with nothing in it', () => {
    const found = discoverClone(repository('bare-of-remotes'))

    expect(found).toMatchObject({ kind: 'no-remote', remotes: [] })
  })

  test('a directory that is not a repository is named as that, not as a clone', () => {
    const dir = path.join(tmp, 'plain')
    fs.mkdirSync(dir)

    expect(discoverClone(dir)).toEqual({ kind: 'no-repository' })
  })

  test('a detached HEAD is a success: the clone is found, and the ref is absent', () => {
    const dir = repository('detached', { origin: 'https://agentgit.zabaca.com/demo.git' })
    run(dir, 'checkout', '--detach')

    expect(discoverClone(dir)).toMatchObject({
      kind: 'clone',
      repo: 'demo',
      ref: null,
    })
  })

  test('a walgit remote is preferred over a GitHub origin, and named', () => {
    const dir = repository('handoff', {
      origin: 'git@github.com:you/thing.git',
      handoff: 'https://agentgit.zabaca.com/study-42.git',
    })

    expect(discoverClone(dir)).toMatchObject({
      kind: 'clone',
      remoteName: 'handoff',
      repo: 'study-42',
      origin: 'https://agentgit.zabaca.com',
    })
  })

  test('a subdirectory discovers the root above it', () => {
    const dir = repository('nested', { origin: 'https://agentgit.zabaca.com/demo.git' })
    const deep = path.join(dir, 'a', 'b')
    fs.mkdirSync(deep, { recursive: true })

    expect(discoverClone(deep)).toMatchObject({ kind: 'clone', root: fs.realpathSync(dir) })
  })
})
