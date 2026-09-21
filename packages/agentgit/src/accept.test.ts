/**
 * `agentgit accept` — the refusals first, because they are the ones that cost
 * something when they are wrong.
 *
 * The assertions are about the git commands that were and were not run, not
 * about prose: "refused before any fetch" is a claim about a subprocess that
 * never happened, and only a recorded command list can hold it.
 */

import { describe, expect, test } from 'bun:test'

import type { Authorization } from './credential'
import {
  type AcceptClone,
  type AcceptDeps,
  type ProposalListing,
  proposalPusher,
  fetchProposals,
  runAccept,
} from './accept'
import { credentialProblems } from './problem'

const proposal = (over: Partial<ProposalListing> = {}): ProposalListing => ({
  id: 'fix-auth',
  target: 'main',
  tip: 'a'.repeat(40),
  pusher: 'SHA256:abc',
  merged: false,
  ...over,
})

const clone: AcceptClone = {
  kind: 'clone',
  root: '/w/clone',
  remoteName: 'origin',
  origin: 'https://agentgit.zabaca.com',
  repo: 'demo',
  host: 'agentgit.zabaca.com',
  ref: 'refs/heads/main',
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
    proposals: async () => ({ kind: 'proposals', proposals: [] }),
    git: (args) => {
      ran.push([...args])
      return run?.(args) ?? { code: 0, stdout: '', stderr: '' }
    },
    ...over,
  }
  return { deps, ran }
}

describe('agentgit accept: refusals', () => {
  // The two ways there is no clone to accept in are two different things to
  // tell an agent, and one message for both said "wrong directory" to one that
  // was plainly standing in a checkout.
  test('outside a git repository it says that, and runs nothing', async () => {
    const { deps, ran } = harness({ discover: () => ({ kind: 'no-repository' }) })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('not inside a git repository')
    expect(ran).toEqual([])
  })

  test('in a repository with no walgit remote it names the remotes it did find', async () => {
    const { deps, ran } = harness({
      discover: () => ({
        kind: 'no-remote',
        root: '/w/clone',
        ref: 'refs/heads/main',
        remotes: [{ name: 'origin', url: 'git@github.com:you/thing.git' }],
      }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).not.toContain('not inside a git repository')
    expect(result.stderr).toContain('no walgit remote')
    expect(result.stderr).toContain('git@github.com:you/thing.git')
    expect(ran).toEqual([])
  })

  // Both refusals below belong to accepting onto a BRANCH, so both are asked
  // once the Proposal's target is known: the Signer List path has no checkout
  // to be detached from and never touches the working tree.
  test('a detached HEAD is refused: there is no target branch to accept onto', async () => {
    const { deps, ran } = harness({
      discover: () => ({ ...clone, ref: null }),
      proposals: async () => ({ kind: 'proposals', proposals: [proposal()] }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('detached')
    expect(ran).toEqual([])
  })

  test('a dirty working tree is refused before anything is fetched or merged', async () => {
    const { deps, ran } = harness({
      run: (args) =>
        args[0] === 'status' ? { code: 0, stdout: ' M src/a.ts\n', stderr: '' } : undefined,
      proposals: async () => ({ kind: 'proposals', proposals: [proposal()] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ id: 'fix-login' })] }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('fix-auth')
    expect(result.stderr).toContain('fix-login')
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })

  test('a Proposal targeting another branch names both branches rather than merging it here', async () => {
    const { deps, ran } = harness({
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ target: 'release' })] }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('release')
    expect(result.stderr).toContain('main')
    expect(ran.some((args) => args[0] === 'fetch')).toBe(false)
  })

  test('a Proposal already merged is reported, and nothing is pushed', async () => {
    const { deps, ran } = harness({
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ merged: true })] }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('already merged')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  // A 401 on this read has a cause the client already composed a sentence for
  // (`src/credential.ts`), and dropping it is how an agent got "answered 401"
  // and nothing to do about it.
  test('an unauthorized read carries why this machine had no credential', async () => {
    const { deps } = harness({
      proposals: async () => ({
        kind: 'failed',
        message: 'answered 401',
        status: 401,
        problem: {
          kind: 'problem',
          code: 'no-signing-key',
          message: 'this machine has no key to prove',
        },
      }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('answered 401')
    expect(result.stderr).toContain('this machine has no key to prove')
  })

  test('a forbidden read carries it too', async () => {
    const { deps } = harness({
      proposals: async () => ({
        kind: 'failed',
        message: 'answered 403',
        status: 403,
        problem: { kind: 'problem', code: 'no-signature', message: 'the key could not sign' },
      }),
    })
    expect((await runAccept({ id: 'fix-auth' }, deps)).stderr).toContain('the key could not sign')
  })

  // The host's fault and the deployment's shape, neither of which a signing key
  // would have changed — saying so would send an agent to fix the wrong thing.
  test('a 500 is the host’s fault, and says nothing about this machine’s keys', async () => {
    const { deps } = harness({
      proposals: async () => ({
        kind: 'failed',
        message: 'answered 500',
        status: 500,
        problem: { kind: 'problem', code: 'no-signing-key', message: 'no key to prove' },
      }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain('no key to prove')
  })

  test('a 404 means the deployment offers no Proposals, and says nothing either', async () => {
    const { deps } = harness({
      proposals: async () => ({
        kind: 'failed',
        message: 'this deployment does not offer Proposals',
        status: 404,
        problem: { kind: 'problem', code: 'no-signing-key', message: 'no key to prove' },
      }),
    })
    const result = await runAccept({ id: 'fix-auth' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain('no key to prove')
  })

  test('a host that cannot be read is a failure, not an empty list of Proposals', async () => {
    const { deps, ran } = harness({
      proposals: async () => ({ kind: 'failed', message: '503 unavailable' }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ tip })] }),
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
      proposals: async () => ({
        kind: 'proposals',
        proposals: [proposal({ tip: 'b'.repeat(40) })],
      }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ tip })] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [proposal({ tip })] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [proposal()] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
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
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
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
      discover: () => ({ ...clone, ref: null }),
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
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

  test('a merge git could not attempt is not reported as a conflict', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
      run: (args) => {
        if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: '' }
        // Not exit 1: git failed to run the merge at all.
        if (args[0] === 'merge-tree')
          return { code: 128, stdout: '', stderr: 'fatal: not a valid object name\n' }
        return undefined
      },
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a valid object name')
    expect(result.stderr).not.toContain('yours to decide')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('a list tip the fetch did not bring back is refused, not merged', async () => {
    // FETCH_HEAD reads back empty after the list's own fetch. Carried onward it
    // would reach `merge-tree` and come back to the Signer as a conflict in the
    // `signers` file, which is a different thing entirely.
    let fetched = ''
    const { deps, ran } = harness({
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal()] }),
      run: (args) => {
        if (args[0] === 'fetch') {
          fetched = args[args.length - 1] ?? ''
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return fetched === LIST
            ? { code: 0, stdout: '\n', stderr: '' }
            : { code: 0, stdout: `${TIP}\n`, stderr: '' }
        }
        return undefined
      },
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(LIST)
    expect(ran.some((args) => args[0] === 'merge-tree' || args[0] === 'push')).toBe(false)
  })

  test('a list Proposal that moved between the listing and the fetch is refused', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => ({
        kind: 'proposals',
        proposals: [listProposal({ tip: 'c'.repeat(40) })],
      }),
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(1)
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })

  test('an already-merged list Proposal is reported, and nothing is pushed', async () => {
    const { deps, ran } = listHarness({
      proposals: async () => ({ kind: 'proposals', proposals: [listProposal({ merged: true })] }),
    })
    const result = await runAccept({ id: 'add-me' }, deps)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('already merged')
    expect(ran.some((args) => args[0] === 'push')).toBe(false)
  })
})

/**
 * Who pushed a Proposal — the second read a `watch --proposals` makes, because
 * a Ref Event carries a ref and a sha and nothing else (docs/adr/0018).
 *
 * It lives here rather than in the CLI because it is the Proposals read's
 * behaviour, and answering `null` rather than throwing is the whole rule: an
 * event withheld until the host answers is worse than one whose pusher is
 * unknown.
 */
describe('proposalPusher', () => {
  const listing: ProposalListing[] = [
    { id: 'fix-auth', target: 'main', tip: 'abc123', pusher: 'SHA256:aaa', merged: false },
    { id: 'fix-auth', target: 'review', tip: 'def456', pusher: 'SHA256:bbb', merged: false },
  ]

  const scope = {
    targets: new Map([['study-42', '/work/study']]),
    origin: 'https://walgit.example',
    authorize: async () => ({ kind: 'none' }) as Authorization,
  }

  test('names the pusher of the Proposal with that id AND that target', async () => {
    const pusher = proposalPusher(scope, async () => ({ kind: 'proposals', proposals: listing }))
    expect(await pusher({ repo: 'study-42', id: 'fix-auth', target: 'review' })).toBe('SHA256:bbb')
  })

  test('reads the clone the repository was fetched into, at its own origin', async () => {
    const asked: unknown[] = []
    const authorize = async () =>
      ({ kind: 'header', header: 'Bearer deploy-token' }) as Authorization
    const pusher = proposalPusher({ ...scope, authorize }, async (read, given) => {
      asked.push({ clone: read, authorize: given })
      return { kind: 'proposals', proposals: listing }
    })
    await pusher({ repo: 'study-42', id: 'fix-auth', target: 'main' })
    // The one authorization is handed on, not a second opinion about it.
    expect(asked).toEqual([
      {
        clone: { root: '/work/study', origin: 'https://walgit.example', repo: 'study-42' },
        authorize,
      },
    ])
  })

  test('a read the host refused names no pusher, rather than failing the event', async () => {
    const pusher = proposalPusher(scope, async () => ({
      kind: 'failed',
      message: 'answered 403',
    }))
    expect(await pusher({ repo: 'study-42', id: 'fix-auth', target: 'main' })).toBeNull()
  })

  // Swallowed, before: the event said `pusher: null` and the reason the read
  // was refused went nowhere. It goes into the watcher's own latch instead, so
  // whichever of the socket and this read noticed first is the one that says it.
  test('a refused read reports why this machine had no credential, once', async () => {
    const said: { event: string; fields: Record<string, unknown> }[] = []
    const problems = credentialProblems((event, fields) => void said.push({ event, fields }))
    const pusher = proposalPusher({ ...scope, problems }, async () => ({
      kind: 'failed',
      message: 'answered 401',
      status: 401,
      problem: { kind: 'problem', code: 'no-signing-key', message: 'no key to prove' },
    }))

    expect(await pusher({ repo: 'study-42', id: 'fix-auth', target: 'main' })).toBeNull()
    expect(await pusher({ repo: 'study-42', id: 'fix-auth', target: 'main' })).toBeNull()

    expect(said).toEqual([
      {
        event: 'credential-problem',
        fields: {
          origin: 'https://walgit.example',
          code: 'no-signing-key',
          problem: 'no key to prove',
        },
      },
    ])
  })

  test('a 500 is the host’s fault, and reports nothing about this machine’s keys', async () => {
    const said: string[] = []
    const problems = credentialProblems((event) => void said.push(event))
    const pusher = proposalPusher({ ...scope, problems }, async () => ({
      kind: 'failed',
      message: 'answered 500',
      status: 500,
      problem: { kind: 'problem', code: 'no-signing-key', message: 'no key to prove' },
    }))

    await pusher({ repo: 'study-42', id: 'fix-auth', target: 'main' })
    expect(said).toEqual([])
  })

  test('a Proposal the listing does not hold is unknown, not an error', async () => {
    const pusher = proposalPusher(scope, async () => ({ kind: 'proposals', proposals: listing }))
    expect(await pusher({ repo: 'study-42', id: 'nope', target: 'main' })).toBeNull()
  })

  test('a repository this process did not fetch into is not read at all', async () => {
    let reads = 0
    const counting = async () => {
      reads += 1
      return { kind: 'proposals', proposals: listing } as const
    }
    const stranger = proposalPusher(scope, counting)
    expect(await stranger({ repo: 'other', id: 'fix-auth', target: 'main' })).toBeNull()
    expect(reads).toBe(0)
  })
})

/**
 * The Proposals read, which used to build its own credential inside itself —
 * so none of this could be reached from a test without a host and an ssh key.
 *
 * It takes the one authorization thunk now, and a failed read is a VALUE. A
 * 404 and a 403 are different things to tell an agent, and the difference was
 * previously carried in the text of a thrown Error that two callers each
 * caught and discarded.
 */
describe('fetchProposals', () => {
  const where = { root: '/w/clone', origin: 'https://agentgit.zabaca.com', repo: 'demo' }
  const listing: ProposalListing[] = [
    { id: 'fix-auth', target: 'main', tip: 'abc123', pusher: 'SHA256:aaa', merged: false },
  ]

  /** A stubbed `fetch`, recording what it was asked for. */
  const stub = (answer: {
    status: number
    body: string
  }): { fetch: typeof globalThis.fetch; seen: { url: string; authorization?: string }[] } => {
    const seen: { url: string; authorization?: string }[] = []
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), authorization: headers.authorization })
      return new Response(answer.body, { status: answer.status })
    }) as unknown as typeof globalThis.fetch
    return { fetch: fetcher, seen }
  }

  const withFetch = async <T>(fetcher: typeof globalThis.fetch, run: () => Promise<T>) => {
    const real = globalThis.fetch
    globalThis.fetch = fetcher
    try {
      return await run()
    } finally {
      globalThis.fetch = real
    }
  }

  test('presents the header the thunk answers for the directory being read', async () => {
    const { fetch: fetcher, seen } = stub({
      status: 200,
      body: JSON.stringify({ proposals: listing }),
    })
    const asked: string[] = []
    const read = await withFetch(fetcher, () =>
      fetchProposals(where, async (dir) => {
        asked.push(dir)
        return { kind: 'header', header: 'Basic stubbed' }
      }),
    )
    expect(read).toEqual({ kind: 'proposals', proposals: listing })
    // The directory of the repository being read, so a repository-local
    // signing key wins exactly as it does for a push.
    expect(asked).toEqual(['/w/clone'])
    expect(seen).toEqual([
      {
        url: 'https://agentgit.zabaca.com/demo.git/proposals',
        authorization: 'Basic stubbed',
      },
    ])
  })

  test('nothing to present is not a failure: the read is made without a header', async () => {
    const { fetch: fetcher, seen } = stub({ status: 200, body: JSON.stringify({ proposals: [] }) })
    const read = await withFetch(fetcher, () =>
      fetchProposals(where, async () => ({ kind: 'none' })),
    )
    expect(read).toEqual({ kind: 'proposals', proposals: [] })
    expect(seen[0]?.authorization).toBeUndefined()
  })

  test('a 404 is the deployment saying it offers no Proposals at all', async () => {
    const { fetch: fetcher } = stub({ status: 404, body: 'not found' })
    const read = await withFetch(fetcher, () =>
      fetchProposals(where, async () => ({ kind: 'none' })),
    )
    if (read.kind !== 'failed') throw new Error(`expected a failure, got ${read.kind}`)
    expect(read.message).toContain('does not offer Proposals')
  })

  test('any other status is reported with its code and the body', async () => {
    const { fetch: fetcher } = stub({ status: 403, body: 'not on the Reader List' })
    const read = await withFetch(fetcher, () =>
      fetchProposals(where, async () => ({ kind: 'none' })),
    )
    if (read.kind !== 'failed') throw new Error(`expected a failure, got ${read.kind}`)
    expect(read.message).toContain('403')
    expect(read.message).toContain('not on the Reader List')
    expect(read.message).not.toContain('does not offer Proposals')
  })

  test('a host that could not be reached is a value too, not a throw', async () => {
    const fetcher = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const read = await withFetch(fetcher, () =>
      fetchProposals(where, async () => ({ kind: 'none' })),
    )
    if (read.kind !== 'failed') throw new Error(`expected a failure, got ${read.kind}`)
    expect(read.message).toContain('ECONNREFUSED')
  })
})
