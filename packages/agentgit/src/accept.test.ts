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

  // Both refusals below belong to accepting onto a BRANCH, so both are asked
  // once the Proposal's target is known: the Signer List path has no checkout
  // to be detached from and never touches the working tree.
  test('a detached HEAD is refused: there is no target branch to accept onto', async () => {
    const { deps, ran } = harness({
      discover: () => ({ ...clone, branch: null }),
      proposals: async () => [proposal()],
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('detached')
    expect(ran).toEqual([])
  })

  test('a dirty working tree is refused before anything is fetched', async () => {
    const { deps, ran } = harness({
      run: (args) =>
        args[0] === 'status' ? { code: 0, stdout: ' M src/a.ts\n', stderr: '' } : undefined,
      proposals: async () => [proposal()],
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('src/a.ts')
    // The whole point of the refusal: nothing is fetched and nothing is merged.
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
    expect(ran.some((args) => args[0] === 'merge')).toBe(false)
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

/**
 * The Signer List is a target like a branch (docs/adr/0018): a stranger asks to
 * be listed by proposing the list, and accepting it is the Signer's ordinary
 * signed push — to `refs/walgit/signers` rather than to a branch.
 *
 * It gets its own path because the branch flow's every step is wrong for it:
 * there is no checkout of the list, so nothing here may touch the working tree,
 * which is also why a dirty tree and a detached HEAD stop refusing it.
 */
describe('agentgit accept: the Signer List', () => {
  const LIST = 'refs/walgit/signers'
  const listProposal = (over: Partial<ProposalListing> = {}): ProposalListing =>
    proposal({ id: 'add-me', target: 'walgit/signers', tip: 'b'.repeat(40), ...over })

  const TIP = 'b'.repeat(40)
  const LIST_TIP = 'd'.repeat(40)
  const MERGE = 'e'.repeat(40)

  /**
   * A clone whose FETCH_HEAD answers whichever ref was fetched last, so the two
   * fetches this path makes can be told apart.
   */
  const listHarness = (over: Over = {}) => {
    let last = ''
    const base = (args: readonly string[]) => {
      if (args[0] === 'fetch') {
        last = args[args.length - 1] ?? ''
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { code: 0, stdout: `${last === LIST ? LIST_TIP : TIP}\n`, stderr: '' }
      }
      if (args[0] === 'commit-tree') return { code: 0, stdout: `${MERGE}\n`, stderr: '' }
      return undefined
    }
    return harness({ ...over, run: (args) => over.run?.(args) ?? base(args) })
  }

  test('fast-forwards the list when the Proposal already contains it, and pushes it signed', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => [listProposal()],
      // The list's tip is already in the Proposal's history: nothing to merge.
      run: (args) => (args[0] === 'merge-base' ? { code: 0, stdout: '', stderr: '' } : undefined),
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(0)
    expect(ran).toContainEqual([
      'fetch',
      '--quiet',
      'origin',
      'refs/walgit/proposals/walgit/signers/add-me',
    ])
    expect(ran).toContainEqual(['fetch', '--quiet', 'origin', LIST])
    expect(ran).toContainEqual(['push', '--signed=if-asked', 'origin', `${TIP}:${LIST}`])
    // Never the branch, and never the working tree.
    expect(ran.some((args) => args.some((a) => a.includes('refs/heads/')))).toBe(false)
    expect(ran.some((args) => args[0] === 'merge' || args[0] === 'checkout')).toBe(false)
  })

  test('merges without a checkout when the list has moved on, and pushes the merge', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => [listProposal()],
      run: (args) => {
        // The list's tip is NOT in the Proposal's history, so the two diverged.
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'merge-tree') return { code: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(0)
    const commit = ran.find((args) => args[0] === 'commit-tree')
    expect(commit).toBeDefined()
    // Both sides are parents, which is what makes the Proposal an ancestor of
    // the list — ADR-0018's whole definition of merged.
    expect(commit).toContain(LIST_TIP)
    expect(commit).toContain(TIP)
    expect(ran).toContainEqual(['push', '--signed=if-asked', 'origin', `${MERGE}:${LIST}`])
  })

  test('a conflicting list merge is refused, and nothing is pushed', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => [listProposal()],
      run: (args) => {
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'merge-tree')
          return { code: 1, stdout: 'CONFLICT (content): Merge conflict in signers\n', stderr: '' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('signers')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('is accepted from a detached HEAD and a dirty tree, which it never touches', async () => {
    const { deps, ran } = listHarness({
      discover: () => ({ ...clone, branch: null }),
      proposals: async () => [listProposal()],
      run: (args) => {
        if (args[0] === 'status') return { code: 0, stdout: ' M src/a.ts\n', stderr: '' }
        if (args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(0)
    expect(ran).toContainEqual(['push', '--signed=if-asked', 'origin', `${TIP}:${LIST}`])
  })

  test('a list Proposal that moved between the listing and the fetch is refused', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => [listProposal({ tip: 'c'.repeat(40) })],
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(1)
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('an already-merged list Proposal is reported, and nothing is pushed', async () => {
    const { deps, ran } = listHarness({ proposals: async () => [listProposal({ merged: true })] })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('already merged')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })
})
