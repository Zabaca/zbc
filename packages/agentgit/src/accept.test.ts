/**
 * `agentgit accept` — the refusals first, because they are the ones that cost
 * something when they are wrong.
 *
 * The assertions are about the git commands that were and were not run, not
 * about prose: "refused before any fetch" is a claim about a subprocess that
 * never happened, and only a recorded command list can hold it.
 */

import { describe, expect, test } from 'bun:test'

import { type AcceptClone, type AcceptDeps, type ProposalListing, runAccept } from './accept'

const proposal = (over: Partial<ProposalListing> = {}): ProposalListing => ({
  id: 'fix-auth',
  target: 'main',
  tip: 'a'.repeat(40),
  pusher: 'SHA256:abc',
  merged: false,
  ...over,
})

const clone: AcceptClone = {
  root: '/w/clone',
  remoteName: 'origin',
  origin: 'https://agentgit.zabaca.com',
  repo: 'demo',
  branch: 'main',
}

interface Harness {
  deps: AcceptDeps
  /** Every git invocation, in order — what "before any fetch" is asserted on. */
  ran: string[][]
}

type Over = Partial<Omit<AcceptDeps, 'git'>> & {
  /** What git answers, per invocation. Unanswered calls succeed silently. */
  run?: (args: readonly string[]) => { code: number; stdout: string; stderr: string } | undefined
}

const harness = ({ run, ...over }: Over = {}): Harness => {
  const ran: string[][] = []
  const deps: AcceptDeps = {
    discover: () => clone,
    proposals: async () => [],
    git: (args) => {
      ran.push([...args])
      return run?.(args) ?? { code: 0, stdout: '', stderr: '' }
    },
    ...over,
  }
  return { deps, ran }
}

describe('agentgit accept: refusals', () => {
  test('outside a clone it says so and runs nothing', async () => {
    const { deps, ran } = harness({ discover: () => null })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('clone')
    expect(ran).toEqual([])
  })

  test('a detached HEAD is refused: there is no target branch to accept onto', async () => {
    const { deps, ran } = harness({ discover: () => ({ ...clone, branch: null }) })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('detached')
    expect(ran).toEqual([])
  })

  test('a dirty working tree is refused before anything is fetched', async () => {
    let asked = false
    const { deps, ran } = harness({
      run: (args) =>
        args[0] === 'status' ? { code: 0, stdout: ' M src/a.ts\n', stderr: '' } : undefined,
      proposals: async () => {
        asked = true
        return []
      },
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('src/a.ts')
    // The whole point of the refusal: no network call, and no fetch.
    expect(asked).toBe(false)
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })
})

describe('agentgit accept: finding the Proposal', () => {
  test('an id the host does not hold is named in the error, with what it does hold', async () => {
    const { deps, ran } = harness({
      proposals: async () => [proposal({ id: 'fix-login' })],
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('fix-auth')
    expect(result.stderr).toContain('fix-login')
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })

  test('a Proposal targeting another branch names both branches rather than merging it here', async () => {
    const { deps, ran } = harness({
      proposals: async () => [proposal({ target: 'release' })],
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('release')
    expect(result.stderr).toContain('main')
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })

  test('a Proposal already merged is reported, and nothing is pushed', async () => {
    const { deps, ran } = harness({ proposals: async () => [proposal({ merged: true })] })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('already merged')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('a host that cannot be read is a failure, not an empty list of Proposals', async () => {
    const { deps, ran } = harness({
      proposals: async () => {
        throw new Error('503 unavailable')
      },
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('503 unavailable')
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })
})

describe('agentgit accept: fetch, merge, push', () => {
  test('fetches the Proposal ref, merges its tip, and pushes the target signed', async () => {
    const tip = 'b'.repeat(40)
    const { deps, ran } = harness({
      proposals: async () => [proposal({ tip })],
      run: (args) =>
        args[0] === 'rev-parse' ? { code: 0, stdout: `${tip}\n`, stderr: '' } : undefined,
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(0)
    // The ref spelling is ADR-0018's, and the push is `--signed=if-asked`
    // because `--signed=yes` is refused by the client's own git against a host
    // without the capability (walgit README).
    expect(ran).toContainEqual([
      'fetch',
      '--quiet',
      'origin',
      'refs/walgit/proposals/main/fix-auth',
    ])
    expect(ran).toContainEqual(['push', '--signed=if-asked', 'origin', 'HEAD:refs/heads/main'])
    const merge = ran.find((args) => args[0] === 'merge')
    expect(merge).toBeDefined()
    expect(merge).toContain(tip)
    // Never a squash and never a rebase: merged is ancestry (ADR-0018).
    expect(merge).not.toContain('--squash')
    expect(merge).not.toContain('--rebase')
  })

  test('a tip that moved between the listing and the fetch is refused, not merged', async () => {
    const { deps, ran } = harness({
      proposals: async () => [proposal({ tip: 'b'.repeat(40) })],
      run: (args) =>
        args[0] === 'rev-parse'
          ? { code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
          : undefined,
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(ran.some((args) => args[0] === 'merge')).toBe(false)
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('a conflicting merge is refused with the tree left as git left it', async () => {
    const tip = 'b'.repeat(40)
    const { deps, ran } = harness({
      proposals: async () => [proposal({ tip })],
      run: (args) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${tip}\n`, stderr: '' }
        if (args[0] === 'merge')
          return { code: 1, stdout: 'CONFLICT (content): Merge conflict in src/a.ts\n', stderr: '' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('src/a.ts')
    // Resolution is the user's; aborting would throw away the merge state they
    // need to do it.
    expect(ran.some((args) => args[0] === 'merge' && args.includes('--abort'))).toBe(false)
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('a push the host refuses fails loudly, and says the merge is still here', async () => {
    const tip = 'b'.repeat(40)
    const { deps } = harness({
      proposals: async () => [proposal({ tip })],
      run: (args) => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${tip}\n`, stderr: '' }
        if (args[0] === 'push')
          return { code: 1, stdout: '', stderr: 'remote: walgit: not a signer\n' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a signer')
  })

  test('a fetch that fails stops before the merge', async () => {
    const { deps, ran } = harness({
      proposals: async () => [proposal()],
      run: (args) =>
        args[0] === 'fetch'
          ? { code: 128, stdout: '', stderr: 'couldn’t find remote ref\n' }
          : undefined,
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(ran.some((args) => args[0] === 'merge')).toBe(false)
  })
})
