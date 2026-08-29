/**
 * The append-only decision and the words it produces.
 *
 * The ancestry test runs against a real repository, because the thing under
 * test IS git's fast-forward rule and a double for it would just be the bug
 * restated. The message is asserted on because it is product copy: an agent
 * that cannot act on it has been told nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { appendOnlyEnabled, checkAppendOnly, rejectionMessage, suggestName } from './append-only'
import { git, gitOrThrow } from './git'
import { ZERO_OID } from '../shared/protocol'

let work: string
let gitDir: string
let first = ''
let second = ''
let unrelated = ''

const commit = (message: string): string => {
  fs.writeFileSync(path.join(work, 'file'), `${message}\n`)
  gitOrThrow(['-C', work, 'add', 'file'])
  gitOrThrow([
    '-C',
    work,
    '-c',
    'user.email=walgit@example.test',
    '-c',
    'user.name=walgit',
    'commit',
    '--quiet',
    '-m',
    message,
  ])
  return git(['-C', work, 'rev-parse', 'HEAD']).stdout.trim()
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-append-only-'))
  gitOrThrow(['init', '--quiet', '--initial-branch=main', work])
  gitDir = path.join(work, '.git')
  first = commit('one')
  second = commit('two')
  // A second root: no commit in it descends from `first`, which is what an
  // agent pushing its own fresh repo over an existing name actually sends.
  gitOrThrow(['-C', work, 'checkout', '--quiet', '--orphan', 'other'])
  unrelated = commit('elsewhere')
})

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

const change = (oldOid: string, newOid: string, ref = 'refs/heads/main') => ({
  oldOid,
  newOid,
  ref,
})

describe('the flag', () => {
  test('is off unless the instance sets it', () => {
    expect(appendOnlyEnabled({})).toBe(false)
    expect(appendOnlyEnabled({ WALGIT_APPEND_ONLY: '0' })).toBe(false)
    expect(appendOnlyEnabled({ WALGIT_APPEND_ONLY: '1' })).toBe(true)
    expect(appendOnlyEnabled({ WALGIT_APPEND_ONLY: 'true' })).toBe(true)
  })
})

describe('the decision', () => {
  test('allows a new ref', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(ZERO_OID, second)]).ok).toBe(true)
  })

  test('allows a fast-forward', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(first, second)]).ok).toBe(true)
  })

  test('refuses a rewrite', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(second, first)]).ok).toBe(false)
  })

  test('refuses unrelated history', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(second, unrelated)]).ok).toBe(false)
  })

  test('refuses a deletion', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(second, ZERO_OID)]).ok).toBe(false)
  })

  test('refuses the whole push when any one ref offends', () => {
    const result = checkAppendOnly(gitDir, 'alpha', [
      change(ZERO_OID, second, 'refs/heads/new'),
      change(second, first),
    ])
    expect(result.ok).toBe(false)
  })

  test('holds for tags as well as branches', () => {
    expect(checkAppendOnly(gitDir, 'alpha', [change(second, first, 'refs/tags/v1')]).ok).toBe(false)
  })
})

describe('the message', () => {
  const message = (kind: 'delete' | 'rewrite') =>
    rejectionMessage('alpha', { allowed: false, kind, ref: 'refs/heads/main' })

  test('names the repository and states the rule', () => {
    expect(message('rewrite')).toContain('alpha is append-only')
  })

  test('offers a concrete alternative name', () => {
    expect(message('rewrite')).toMatch(/alpha-[0-9a-f]{8}\.git/)
  })

  test('says nothing was uploaded, because nothing was', () => {
    expect(message('delete')).toContain('Nothing was uploaded')
  })

  test('suggests a different name each time, so a wave of agents does not collide', () => {
    const names = new Set(Array.from({ length: 20 }, () => suggestName('test')))
    expect(names.size).toBe(20)
  })
})
