/**
 * Discovery, which is the whole reason this is a package rather than a snippet.
 *
 * Every case here is a thing that is true of a real checkout — a remote with
 * credentials in the URL, a clone whose `origin` is GitHub and whose second
 * remote is the handoff, a detached HEAD — and the assertion is always what the
 * client would end up watching, never how it decided.
 */

import { describe, expect, test } from 'bun:test'

import { conflictPaths, parseHead, parseRemote, parseRemoteList, pickRemote } from './remote'

describe('parseRemote', () => {
  test('reads the host and the repository out of a walgit remote', () => {
    expect(parseRemote('https://agentgit.zabaca.com/study-42.git')).toEqual({
      host: 'agentgit.zabaca.com',
      repo: 'study-42',
    })
  })

  test('tolerates a missing .git, a trailing slash and inline credentials', () => {
    expect(parseRemote('https://agentgit.zabaca.com/study-42')?.repo).toBe('study-42')
    expect(parseRemote('https://agentgit.zabaca.com/study-42.git/')?.repo).toBe('study-42')
    expect(parseRemote('https://walgit:tok@host.example/thing.git')).toEqual({
      host: 'host.example',
      repo: 'thing',
    })
  })

  test('keeps a port, because a self-hosted deployment has one', () => {
    expect(parseRemote('http://localhost:8787/thing.git')).toEqual({
      host: 'localhost:8787',
      repo: 'thing',
    })
  })

  test('refuses what is not smart-HTTP rather than guessing a hostname', () => {
    expect(parseRemote('git@github.com:you/thing.git')).toBeNull()
    expect(parseRemote('ssh://git@host.example/thing.git')).toBeNull()
    expect(parseRemote('https://host.example/nested/thing.git')).toBeNull()
  })

  test('refuses a name walgit would refuse', () => {
    expect(parseRemote('https://host.example/-leading.git')).toBeNull()
  })
})

describe('pickRemote', () => {
  const list = (text: string) => pickRemote(parseRemoteList(text))

  test('origin wins', () => {
    const found = list(
      'origin\thttps://agentgit.zabaca.com/a.git (fetch)\n' +
        'origin\thttps://agentgit.zabaca.com/a.git (push)\n' +
        'other\thttps://agentgit.zabaca.com/b.git (fetch)\n',
    )
    expect(found).toEqual({ name: 'origin', host: 'agentgit.zabaca.com', repo: 'a' })
  })

  test('a GitHub origin does not stop the handoff remote being found', () => {
    const found = list(
      'origin\tgit@github.com:you/thing.git (fetch)\n' +
        'handoff\thttps://agentgit.zabaca.com/study-42.git (fetch)\n',
    )
    expect(found).toEqual({ name: 'handoff', host: 'agentgit.zabaca.com', repo: 'study-42' })
  })

  test('no walgit remote at all is null, not a guess', () => {
    expect(list('origin\tgit@github.com:you/thing.git (fetch)\n')).toBeNull()
    expect(list('')).toBeNull()
  })
})

describe('parseHead', () => {
  test('names the branch a checkout is on', () => {
    expect(parseHead('refs/heads/main\n')).toBe('refs/heads/main')
    expect(parseHead('refs/heads/feat/thing\n')).toBe('refs/heads/feat/thing')
  })

  test('a detached HEAD names nothing', () => {
    expect(parseHead('')).toBeNull()
    expect(parseHead('refs/tags/v1\n')).toBeNull()
  })
})

describe('conflictPaths', () => {
  test('takes the paths and leaves the tree oid and git prose behind', () => {
    const stdout = [
      '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
      'src/index.ts',
      'README.md',
      '',
      'CONFLICT (content): Merge conflict in src/index.ts',
      '',
    ].join('\n')
    expect(conflictPaths(stdout)).toEqual(['src/index.ts', 'README.md'])
  })

  test('a merge with no paths reports none', () => {
    expect(conflictPaths('0a1b2c3d\n')).toEqual([])
  })
})
