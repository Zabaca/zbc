/**
 * Reconcile against a REAL git repository. The whole operation is a claim about
 * what git will report afterwards — `packed-refs` shadowing, loose-ref removal,
 * missing objects — and none of that is observable against a double.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { localRefs, reconcile } from './reconcile'
import { emptyIndex, type WalIndex } from './wal-index'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-reconcile-'))
let bare: string
let mainOid: string
let topicOid: string

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

const indexWith = (refs: Record<string, string>): WalIndex => ({ ...emptyIndex('r'), refs })

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'))
  bare = path.join(root, 'r.git')
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', bare)

  const work = path.join(root, 'work')
  git(root, 'init', '--quiet', '-b', 'main', work)
  git(work, 'config', 'user.email', 'walgit@example.test')
  git(work, 'config', 'user.name', 'walgit')
  fs.writeFileSync(path.join(work, 'a'), 'one\n')
  git(work, 'add', 'a')
  git(work, 'commit', '--quiet', '-m', 'one')
  git(work, 'push', '--quiet', bare, 'main:refs/heads/main')
  mainOid = git(work, 'rev-parse', 'HEAD')

  fs.writeFileSync(path.join(work, 'a'), 'two\n')
  git(work, 'commit', '--quiet', '-am', 'two')
  git(work, 'push', '--quiet', bare, 'main:refs/heads/topic')
  topicOid = git(work, 'rev-parse', 'HEAD')
})

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('reconcile', () => {
  test('an agreeing repo is left alone', () => {
    const result = reconcile(bare, indexWith({ 'refs/heads/main': mainOid, 'refs/heads/topic': topicOid }))
    expect(result.changed).toBe(false)
  })

  test('a deleted local ref comes back from the index', () => {
    fs.rmSync(path.join(bare, 'refs', 'heads', 'main'), { force: true })
    expect(localRefs(bare)['refs/heads/main']).toBeUndefined()

    const result = reconcile(bare, indexWith({ 'refs/heads/main': mainOid, 'refs/heads/topic': topicOid }))

    expect(result.updated).toEqual(['refs/heads/main'])
    expect(localRefs(bare)).toEqual({ 'refs/heads/main': mainOid, 'refs/heads/topic': topicOid })
  })

  test('a local ref the index does not have is removed', () => {
    const result = reconcile(bare, indexWith({ 'refs/heads/main': mainOid }))

    expect(result.removed).toEqual(['refs/heads/topic'])
    expect(localRefs(bare)).toEqual({ 'refs/heads/main': mainOid })
  })

  test('a stale local ref is forced back to what the index says, not the reverse', () => {
    // The push-path race: the index moved main forward, this node did not.
    reconcile(bare, indexWith({ 'refs/heads/main': topicOid }))
    expect(localRefs(bare)['refs/heads/main']).toBe(topicOid)
  })

  test('a loose ref cannot shadow the packed one it disagrees with', () => {
    // git may hold a ref loose OR packed; writing packed-refs alone would be
    // silently undone by a leftover loose file.
    fs.mkdirSync(path.join(bare, 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(path.join(bare, 'refs', 'heads', 'main'), `${topicOid}\n`)

    reconcile(bare, indexWith({ 'refs/heads/main': mainOid }))
    expect(localRefs(bare)['refs/heads/main']).toBe(mainOid)
  })

  test('a ref whose object this node lacks is reported, never written', () => {
    const absent = '0123456789abcdef0123456789abcdef01234567'
    const result = reconcile(bare, indexWith({ 'refs/heads/main': absent }))

    expect(result.missing).toEqual(['refs/heads/main'])
    // Pointing a ref at an object that is not here would hand a client a
    // corrupt clone; keeping the stale oid only hands it an old one.
    expect(localRefs(bare)['refs/heads/main']).toBe(mainOid)
  })

  test('an empty index empties the repo', () => {
    reconcile(bare, emptyIndex('r'))
    expect(localRefs(bare)).toEqual({})
  })
})
