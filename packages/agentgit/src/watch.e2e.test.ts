/**
 * `agentgit watch --proposals` against real git: a Proposal really pushed from
 * a second clone, really accepted from the first, and the two things a watcher
 * is supposed to say about that.
 *
 * The host is doubled only where it computes — the Ref Events a walgit push
 * path would publish are derived here from the bare repository the clones
 * actually push to, with `merge-base --is-ancestor` for `merged`, which is the
 * definition ADR-0018 gives and the one `src/proposals.ts` in walgit
 * implements. Everything else is git.
 *
 * The claim under test is `route`'s: what a watcher reports, and — the reason
 * the flag is opt-in — what it leaves alone. The working clone's branch is
 * asserted untouched while the Proposal stands.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  type AcceptClone,
  type AcceptDeps,
  type ProposalListing,
  proposalRef,
  runAccept,
} from './accept'
import { git } from './git'
import { route } from './watch'

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
  if (result.code !== 0 && !['merge', 'push', 'merge-base', 'cat-file'].includes(args[0] ?? '')) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  }
  return result
}

const commit = (dir: string, file: string, body: string, message: string) => {
  fs.writeFileSync(path.join(dir, file), body)
  run(dir, 'add', file)
  run(dir, 'commit', '-m', message)
  return run(dir, 'rev-parse', 'HEAD').stdout.trim()
}

let scratch: string
let host: string
let watcher: string
let proposer: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-watch-'))
  host = path.join(scratch, 'host.git')
  watcher = path.join(scratch, 'watcher')
  proposer = path.join(scratch, 'proposer')

  run(scratch, 'init', '--bare', '--initial-branch=main', host)
  run(scratch, 'clone', host, watcher)
  commit(watcher, 'README.md', 'one\n', 'first')
  run(watcher, 'push', 'origin', 'main')
  run(scratch, 'clone', host, proposer)
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** What the interested watcher is: standing on `main`, Proposals on. */
const INTEREST = { refs: ['refs/heads/main'], proposals: true }

/**
 * The Ref Event walgit would publish for a ref, as the push path builds it:
 * the ref, its new sha, and — for a branch — the Proposals this move made
 * ancestors of it that were not ancestors before (docs/adr/0018).
 */
const refEvent = (ref: string, before: string | null) => {
  const sha = run(host, 'rev-parse', ref).stdout.trim()
  const merged: string[] = []
  for (const line of run(
    host,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/walgit/proposals/',
  )
    .stdout.trim()
    .split('\n')) {
    if (!line || !ref.startsWith('refs/heads/')) continue
    const [name, tip] = line.split(' ') as [string, string]
    const id = name.slice(name.lastIndexOf('/') + 1)
    const target = name.slice('refs/walgit/proposals/'.length, name.lastIndexOf('/'))
    if (`refs/heads/${target}` !== ref) continue
    const now = run(host, 'merge-base', '--is-ancestor', tip, sha).code === 0
    const was = before !== null && run(host, 'merge-base', '--is-ancestor', tip, before).code === 0
    if (now && !was) merged.push(id)
  }
  return { ref, sha, merged }
}

const listing = (): ProposalListing[] => {
  const out: ProposalListing[] = []
  for (const line of run(
    host,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/walgit/proposals/',
  )
    .stdout.trim()
    .split('\n')) {
    if (!line) continue
    const [name, tip] = line.split(' ') as [string, string]
    const id = name.slice(name.lastIndexOf('/') + 1)
    const target = name.slice('refs/walgit/proposals/'.length, name.lastIndexOf('/'))
    const targetTip = run(host, 'rev-parse', `refs/heads/${target}`).stdout.trim()
    out.push({
      id,
      target,
      tip,
      pusher: 'SHA256:proposer',
      merged: run(host, 'merge-base', '--is-ancestor', tip, targetTip).code === 0,
    })
  }
  return out
}

const clone: AcceptClone = {
  kind: 'clone',
  root: '',
  remoteName: 'origin',
  host: 'walgit.example',
  origin: 'https://walgit.example',
  repo: 'demo',
  ref: 'refs/heads/main',
}

const deps = (): AcceptDeps => ({
  discover: () => ({ ...clone, root: watcher }),
  proposals: async () => ({ kind: 'proposals', proposals: listing() }),
  git: (args) => run(watcher, ...args),
})

describe('watch --proposals, live', () => {
  test('a Proposal pushed from another clone is reported, and never enters this one', async () => {
    const mainBefore = run(host, 'rev-parse', 'refs/heads/main').stdout.trim()
    const tip = commit(proposer, 'a.ts', 'a\n', 'add a')
    run(proposer, 'push', 'origin', `HEAD:${proposalRef('main', 'fix-auth')}`)

    const event = refEvent(proposalRef('main', 'fix-auth'), null)
    expect(event.sha).toBe(tip)
    expect(route(INTEREST, event)).toEqual({ kind: 'proposal', id: 'fix-auth', target: 'main' })

    // The reason the flag is opt-in: the watching clone has not moved, and does
    // not even hold the commit somebody else proposed.
    expect(run(watcher, 'rev-parse', 'HEAD').stdout.trim()).toBe(mainBefore)
    expect(run(watcher, 'cat-file', '-e', tip).code).not.toBe(0)
  })

  test('accepting it makes the branch’s own event name what it merged', async () => {
    commit(proposer, 'a.ts', 'a\n', 'add a')
    run(proposer, 'push', 'origin', `HEAD:${proposalRef('main', 'fix-auth')}`)
    const before = run(host, 'rev-parse', 'refs/heads/main').stdout.trim()

    const accepted = await runAccept({ id: 'fix-auth' }, deps())
    expect(accepted.code).toBe(0)

    const event = refEvent('refs/heads/main', before)
    expect(route(INTEREST, event)).toEqual({ kind: 'ref', merged: ['fix-auth'] })
    // …and the same event tells a watcher without the flag nothing new.
    expect(route({ refs: ['refs/heads/main'], proposals: false }, event)).toEqual({
      kind: 'ref',
      merged: [],
    })
  })

  test('a Proposal aimed at a branch this clone is not on is not reported', async () => {
    run(watcher, 'push', 'origin', 'main:refs/heads/release')
    commit(proposer, 'a.ts', 'a\n', 'add a')
    run(proposer, 'push', 'origin', `HEAD:${proposalRef('release', 'other')}`)

    expect(route(INTEREST, refEvent(proposalRef('release', 'other'), null))).toEqual({
      kind: 'ignore',
    })
  })
})
