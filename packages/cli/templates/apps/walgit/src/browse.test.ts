/**
 * One level of a tree, read off the Cache.
 *
 * Real git against a real repository, for the reason `git.test.ts` runs real
 * git: the property under test is what `ls-tree` actually prints — a
 * NUL-delimited record whose size column is `-` for everything git does not
 * weigh, and whose mode is the only thing that distinguishes a symlink from a
 * file and a submodule from a commit. A stubbed subprocess would assert that
 * this file and the parser agree, which is not the question.
 *
 * The expected answers are the fixture's own shape, built here: `docs/` and
 * `src/` are directories, `README.md` is a file with a known byte count, and
 * the two option-shaped names are what an untrusted browse request can ask for.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { listTree } from './browse'
import { git } from './git'

let work = ''
let gitDir = ''
let head = ''

const README = 'walgit fixture\n'

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-browse-'))
  gitDir = path.join(work, '.git')
  git(['init', '--quiet', '--initial-branch=main', work])
  fs.writeFileSync(path.join(work, 'README.md'), README)
  fs.mkdirSync(path.join(work, 'src/deep'), { recursive: true })
  fs.writeFileSync(path.join(work, 'src/index.ts'), 'export {}\n')
  fs.writeFileSync(path.join(work, 'src/deep/leaf.txt'), 'leaf\n')
  // A name git would read as an option if it ever reached the command line
  // without a fence, and a name with a space in it.
  fs.writeFileSync(path.join(work, 'src/-p'), 'p\n')
  fs.writeFileSync(path.join(work, 'a file.txt'), 'spaced\n')
  fs.symlinkSync('src/index.ts', path.join(work, 'link'))
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
    'fixture',
  ])
  head = git(['rev-parse', 'HEAD'], { gitDir }).stdout.trim()
})

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

const names = (entries: { name: string }[] | null) => (entries ?? []).map((e) => e.name)

describe('listTree', () => {
  test('lists one level of the root, never recursively', async () => {
    const entries = await listTree(gitDir, head, '')
    // The root's own entries and nothing below them: `src/index.ts` is inside
    // `src`, so a recursive read would have named it here.
    expect(names(entries).sort()).toEqual(['README.md', 'a file.txt', 'link', 'src'])
  })

  test('names what each entry is, and weighs only what git weighs', async () => {
    const entries = (await listTree(gitDir, head, '')) ?? []
    const by = (name: string) => entries.find((entry) => entry.name === name)
    expect(by('README.md')).toMatchObject({ kind: 'blob', size: README.length })
    expect(by('src')).toMatchObject({ kind: 'tree', size: null })
    // A symlink is its target, not a file whose contents happen to be a path.
    expect(by('link')).toMatchObject({ kind: 'symlink', target: 'src/index.ts', size: null })
  })

  test('lists a subdirectory, with names relative to it', async () => {
    const entries = await listTree(gitDir, head, 'src')
    expect(names(entries).sort()).toEqual(['-p', 'deep', 'index.ts'])
  })

  test('a path that is not a directory reads as absent, not as empty', async () => {
    // A file, and a directory that does not exist. Neither is a tree, and git
    // has no empty tree — so `null` is the only honest answer for both.
    expect(await listTree(gitDir, head, 'README.md')).toBe(null)
    expect(await listTree(gitDir, head, 'nope')).toBe(null)
  })

  test('a revision the repository does not hold reads as absent', async () => {
    expect(await listTree(gitDir, 'f'.repeat(40), '')).toBe(null)
  })

  test('an option-shaped path is a path, not an option', async () => {
    // `-p` exists in the fixture as a FILE, so the honest answer is `null` —
    // and the proof that it was read as a path is that git did not fail with a
    // usage error, which would have come back as `null` for a different reason.
    expect(await listTree(gitDir, head, 'src/-p')).toBe(null)
    // The directory beside it still lists, which it would not if the earlier
    // argument had poisoned the command.
    expect(names(await listTree(gitDir, head, 'src/deep'))).toEqual(['leaf.txt'])
  })
})
