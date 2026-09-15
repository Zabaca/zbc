/**
 * `agentgit accept` against real git: real repositories on disk, a real
 * Proposal ref pushed by somebody else, a real fetch, merge and push.
 *
 * Nothing about acceptance is the host's (docs/adr/0018) — there is no merge
 * endpoint, and `merged` is `merge-base --is-ancestor` computed on read — so
 * the whole claim this command makes is a claim about what git ends up holding.
 * That is what is asserted here, in the bare repository the clones push to, and
 * with git's own ancestry check rather than with anything this package
 * computes.
 *
 * The one double is the Proposals listing, which stands in for the endpoint.
 * It is derived here from the refs the bare repository actually holds, the way
 * `src/proposals.ts` in walgit derives it — so a Proposal this test calls open
 * is one whose ref really is not an ancestor of the target.
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

/** git with an identity and no ambient config, so a CI machine behaves as a laptop does. */
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
  if (result.code !== 0 && !['merge', 'push', 'merge-base'].includes(args[0] ?? '')) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  }
  return result
}

const write = (dir: string, file: string, body: string) => {
  fs.writeFileSync(path.join(dir, file), body)
}

const commit = (dir: string, file: string, body: string, message: string) => {
  write(dir, file, body)
  run(dir, 'add', file)
  run(dir, 'commit', '-m', message)
  return run(dir, 'rev-parse', 'HEAD').stdout.trim()
}

let scratch: string
let host: string
let accepter: string
let proposer: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-accept-'))
  host = path.join(scratch, 'host.git')
  accepter = path.join(scratch, 'accepter')
  proposer = path.join(scratch, 'proposer')

  run(scratch, 'init', '--bare', '--initial-branch=main', host)
  run(scratch, 'clone', host, accepter)
  commit(accepter, 'README.md', 'one\n', 'first')
  run(accepter, 'push', 'origin', 'main')
  run(scratch, 'clone', host, proposer)
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** The Proposal a second agent pushes, exactly as ADR-0018 spells the ref. */
const propose = (id: string, target: string, make: (dir: string) => string): string => {
  const tip = make(proposer)
  run(proposer, 'push', 'origin', `HEAD:${proposalRef(target, id)}`)
  return tip
}

/**
 * The endpoint's answer, derived from the bare repository — ref names for the
 * id and target, `merge-base --is-ancestor` for `merged`.
 */
const listing = (): ProposalListing[] => {
  const refs = run(
    host,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/walgit/proposals/',
  )
  const out: ProposalListing[] = []
  for (const line of refs.stdout.trim().split('\n')) {
    if (!line) continue
    const [ref, tip] = line.split(' ') as [string, string]
    const match = /^refs\/walgit\/proposals\/(.+)\/([^/]+)$/.exec(ref)
    if (!match) continue
    const [, target, id] = match as unknown as [string, string, string]
    const targetTip = run(host, 'rev-parse', `refs/heads/${target}`).stdout.trim()
    out.push({
      id,
      target,
      tip,
      pusher: 'SHA256:test',
      merged: run(host, 'merge-base', '--is-ancestor', tip, targetTip).code === 0,
    })
  }
  return out
}

const clone: AcceptClone = {
  root: '',
  remoteName: 'origin',
  origin: 'https://walgit.example',
  repo: 'demo',
  branch: 'main',
}

const deps = (): AcceptDeps => ({
  discover: () => ({ ...clone, root: accepter }),
  proposals: async () => listing(),
  // The real thing: every fetch, merge and push below is a git subprocess.
  git: (args) => run(accepter, ...args),
})

/** Is the Proposal merged, according to the host? */
const merged = (id: string) => listing().find((entry) => entry.id === id)?.merged

describe('agentgit accept, live', () => {
  test('a Proposal ahead of the target fast-forwards, and reads merged afterwards', async () => {
    const tip = propose('fix-auth', 'main', (dir) => commit(dir, 'a.ts', 'a\n', 'add a'))
    expect(merged('fix-auth')).toBe(false)

    const result = await runAccept({ id: 'fix-auth' }, deps())

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(merged('fix-auth')).toBe(true)
    // A fast-forward, not a merge commit: main IS the Proposal's tip.
    expect(run(host, 'rev-parse', 'refs/heads/main').stdout.trim()).toBe(tip)
  })

  test('a Proposal that diverged gets a true merge, and reads merged afterwards', async () => {
    const tip = propose('fix-auth', 'main', (dir) => commit(dir, 'a.ts', 'a\n', 'add a'))
    // The target moves under it, in another file, so the merge is clean.
    commit(accepter, 'b.ts', 'b\n', 'add b')
    run(accepter, 'push', 'origin', 'main')

    const result = await runAccept({ id: 'fix-auth' }, deps())

    expect(result.code).toBe(0)
    expect(merged('fix-auth')).toBe(true)
    const head = run(host, 'rev-parse', 'refs/heads/main').stdout.trim()
    expect(head).not.toBe(tip)
    // Two parents: the merge is real, and neither history was rewritten.
    expect(
      run(host, 'rev-list', '--parents', '-n', '1', head).stdout.trim().split(' '),
    ).toHaveLength(3)
  })

  test('a conflicting Proposal is refused, and the tree is left mid-merge for the user', async () => {
    propose('fix-auth', 'main', (dir) => commit(dir, 'README.md', 'theirs\n', 'theirs'))
    commit(accepter, 'README.md', 'ours\n', 'ours')
    run(accepter, 'push', 'origin', 'main')

    const result = await runAccept({ id: 'fix-auth' }, deps())

    expect(result.code).toBe(1)
    expect(merged('fix-auth')).toBe(false)
    // Left for the user: the merge is still in progress and the conflict
    // markers are in the file, which is what resolving it needs.
    expect(fs.existsSync(path.join(accepter, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(fs.readFileSync(path.join(accepter, 'README.md'), 'utf8')).toContain('<<<<<<<')
  })

  test('accepting the same Proposal twice is a no-op the second time', async () => {
    propose('fix-auth', 'main', (dir) => commit(dir, 'a.ts', 'a\n', 'add a'))
    await runAccept({ id: 'fix-auth' }, deps())
    const after = run(host, 'rev-parse', 'refs/heads/main').stdout.trim()

    const again = await runAccept({ id: 'fix-auth' }, deps())

    expect(again.code).toBe(0)
    expect(again.stdout).toContain('already merged')
    expect(run(host, 'rev-parse', 'refs/heads/main').stdout.trim()).toBe(after)
  })
})
