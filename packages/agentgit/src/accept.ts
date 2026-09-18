/**
 * `agentgit accept <id>` — the sugar ADR-0018 named, and nothing more.
 *
 * The ADR is explicit that the host never accepts: there is no merge endpoint
 * and no fast-forward endpoint, because a ref moved by the host would be a
 * write with no Push Certificate behind it. Acceptance is therefore an ordinary
 * push, judged by the Signer List, and a conflict is resolved where git
 * resolves conflicts — in the accepter's working tree. All this command does is
 * assemble the three steps nobody should have to type: fetch the Proposal's
 * ref, merge it, push the target signed.
 *
 * Two targets, two paths. A BRANCH is accepted where it is checked out, in the
 * accepter's tree. The SIGNER LIST — the one non-branch target, and how a
 * stranger asks to be listed — is accepted without a checkout at all, because
 * nobody has the list checked out and an agent's own work must not be moved to
 * accept one. See `acceptSignerList`.
 *
 * Which makes the refusals the substance. A `git merge` run over a working tree
 * somebody is in the middle of, or a conflict quietly aborted, would each cost
 * an agent work it cannot get back, so both stop here: the tree is checked
 * before a single byte is asked for, and a conflict is left exactly as git left
 * it. Nothing here squashes or rebases — under ADR-0018's definition of merged
 * ("this commit is an ancestor of the target"), a squash does not merge a
 * Proposal and never will.
 */

import { readAuthorization, realCredentialDeps } from './credential'
import { type GitResult, git, symbolicHead, toplevel } from './git'
import { originOf, parseHead, parseRemoteList, pickRemote } from './remote'

/** The clone `accept` was run in, reduced to what the three steps need. */
export interface AcceptClone {
  root: string
  /** The remote the Proposal is fetched from and the target pushed to. */
  remoteName: string
  /** Scheme, host and port — what the Proposals read is addressed to. */
  origin: string
  repo: string
  /** The branch HEAD is on, or `null` on a detached HEAD. */
  branch: string | null
}

/**
 * One Proposal, as `GET /<name>.git/proposals` reports it (docs/adr/0018).
 *
 * Restated here rather than imported: nothing in this package imports walgit,
 * because a client that depended on the server's source would be a client
 * nobody outside that repository could build.
 */
export interface ProposalListing {
  id: string
  target: string
  tip: string
  pusher: string | null
  merged: boolean
}

export interface AcceptDeps {
  /** Where this was run, or `null` if it was not run in a walgit clone. */
  discover(): AcceptClone | null
  /** The Proposals the host holds for this repository. */
  proposals(clone: AcceptClone): Promise<ProposalListing[]>
  /** `git …`, in the clone. */
  git(args: readonly string[]): GitResult
}

export interface AcceptRequest {
  /** The Proposal's id — the pusher's word, the last segment of its ref. */
  id: string
}

export interface AcceptResult {
  stdout: string
  stderr: string
  code: number
}

/** The ref a Proposal is, spelled the one way ADR-0018 spells it. */
export function proposalRef(target: string, id: string): string {
  return `refs/walgit/proposals/${target}/${id}`
}

/**
 * The Signer List, and the one target that is not a branch (docs/adr/0018).
 *
 * A stranger asks to be listed by proposing the list itself, so accepting one
 * is still an ordinary signed push by a Signer — to this ref rather than to a
 * branch. Spelled here rather than imported, for the reason `ProposalListing`
 * is: nothing in this package imports walgit.
 */
export const SIGNERS_REF = 'refs/walgit/signers'
export const SIGNERS_TARGET = 'walgit/signers'

const refuse = (message: string, code = 2): AcceptResult => ({
  stdout: '',
  stderr: `agentgit: ${message}\n`,
  code,
})

export async function runAccept(request: AcceptRequest, deps: AcceptDeps): Promise<AcceptResult> {
  const clone = deps.discover()
  if (clone === null) {
    return refuse(
      'not inside a clone of a walgit repository — run accept where the target branch is checked out',
    )
  }
  let listing: ProposalListing[]
  try {
    listing = await deps.proposals(clone)
  } catch (err) {
    // Refused rather than treated as "no such Proposal". A host we could not
    // read is a repository whose Proposals we do not know, and an agent told
    // its id does not exist would go and push a duplicate.
    return refuse(`could not read the Proposals of ${clone.repo}: ${(err as Error).message}`, 1)
  }

  // Matched by id alone, then checked against the branch — so a Proposal for
  // another target is reported as what it is, rather than as an id that does
  // not exist on a repository that holds it.
  const found = listing.filter((entry) => entry.id === request.id)
  if (found.length === 0) {
    const held = listing.map((entry) => `${entry.id} → ${entry.target}`)
    return refuse(
      `no Proposal ${JSON.stringify(request.id)} on ${clone.repo}.\n` +
        (held.length === 0 ? '  it holds no Proposals' : `  it holds: ${held.join(', ')}`),
    )
  }

  // The Signer List first, because it is the one target with no checkout to
  // match against: a list Proposal is accepted from wherever the Signer
  // happens to be standing.
  const list = found.find((entry) => entry.target === SIGNERS_TARGET)
  if (list && found.length > 1) {
    // One id, two targets, and this command accepts one thing. Which is asked
    // rather than guessed: quietly preferring either would move a ref the
    // Signer did not name.
    const targets = found.map((entry) => entry.target).join(', ')
    return refuse(
      `Proposal ${JSON.stringify(request.id)} is held for more than one target on ${clone.repo}: ${targets}.\n` +
        '  accept them one at a time, from a clone where only one is open',
    )
  }
  if (list) return acceptSignerList(clone, list, deps)

  const branch = clone.branch
  if (branch === null) {
    return refuse('HEAD is detached: check out the branch the Proposal targets, then accept it')
  }
  const proposal = found.find((entry) => entry.target === branch)
  if (!proposal) {
    const targets = found.map((entry) => entry.target).join(', ')
    return refuse(
      `Proposal ${JSON.stringify(request.id)} targets ${targets}, and you are on ${branch}.\n` +
        `  check out ${targets} and accept it there`,
    )
  }

  // Before the merge, and before a single object is fetched: a `git merge` run
  // over a tree somebody is in the middle of costs work that cannot be got
  // back. It is asked here rather than at the top — after the listing, which is
  // one read of the host — because whether the tree matters at all depends on
  // the target: the Signer List path never touches it.
  const status = deps.git(['status', '--porcelain'])
  if (status.code !== 0) {
    return refuse(`could not read the working tree: ${status.stderr.trim()}`, 1)
  }
  if (status.stdout.trim() !== '') {
    return refuse(
      'the working tree is not clean — commit, or stash it (`git stash -u`, which ' +
        'untracked files need too):\n' +
        status.stdout.trimEnd().replace(/^/gm, '  '),
    )
  }

  if (proposal.merged) {
    // Ancestry, computed by the host on read — so this is idempotent by
    // construction: a second `accept` of the same Proposal has nothing to do.
    return {
      stdout: `${request.id} is already merged into ${branch} (${proposal.tip.slice(0, 8)})\n`,
      stderr: '',
      code: 0,
    }
  }

  const ref = proposalRef(branch, proposal.id)
  const fetched = deps.git(['fetch', '--quiet', clone.remoteName, ref])
  if (fetched.code !== 0) {
    return refuse(`could not fetch ${ref}: ${fetched.stderr.trim()}`, 1)
  }

  // What the listing named and what the fetch brought back have to be the same
  // commit. They differ when the Proposal was updated between the two calls —
  // a fast-forward push to the same ref, which append-only permits — and
  // merging the newer one would be accepting work nobody looked at.
  const head = deps.git(['rev-parse', 'FETCH_HEAD']).stdout.trim()
  if (head !== proposal.tip) {
    return refuse(
      `${proposal.id} moved while we were reading it: the host listed ${proposal.tip.slice(0, 8)}, ` +
        `the fetch brought ${head.slice(0, 8) || 'nothing'}. Run accept again.`,
      1,
    )
  }

  // `--no-edit` takes git's own message; no `--ff-only` and no `--no-ff`, so a
  // Proposal that is ahead of the target fast-forwards and one that diverged
  // gets a true merge. Either satisfies ADR-0018's definition of merged; a
  // squash or a rebase would satisfy neither.
  const merged = deps.git(['merge', '--no-edit', proposal.tip])
  if (merged.code !== 0) {
    return refuse(
      `merging ${proposal.id} conflicts — the tree is left as git left it, for you to resolve:\n` +
        `${(merged.stdout + merged.stderr).trimEnd().replace(/^/gm, '  ')}\n` +
        `  then: git push --signed=if-asked ${clone.remoteName} HEAD:refs/heads/${branch}`,
      1,
    )
  }

  // `--signed=if-asked` rather than `=yes`: a client asking for `yes` against a
  // host that does not take push certificates is refused by its OWN git, before
  // a byte reaches the network (walgit README).
  const pushed = deps.git([
    'push',
    '--signed=if-asked',
    clone.remoteName,
    `HEAD:refs/heads/${branch}`,
  ])
  if (pushed.code !== 0) {
    return refuse(
      `the merge is here, but pushing ${branch} was refused: ${(pushed.stderr + pushed.stdout).trim()}`,
      1,
    )
  }

  const local = deps.git(['rev-parse', 'HEAD']).stdout.trim()
  return {
    stdout:
      `accepted ${proposal.id} (${proposal.tip.slice(0, 8)}) into ${branch}` +
      `${local ? ` — ${branch} is now ${local.slice(0, 8)}` : ''}\n`,
    stderr: '',
    code: 0,
  }
}

/**
 * Accepting a Proposal of the Signer List, which is the same act as accepting
 * one of a branch and shares none of its steps.
 *
 * Nothing here touches the working tree. The list is a ref nobody has checked
 * out — it holds one `signers` file and a Signer is in the middle of their own
 * work — so a checkout, a merge and a reset would be three ways to lose that
 * work to an act that has nothing to do with it. The merge is made with
 * `merge-tree` and `commit-tree` instead: a tree and a commit written straight
 * into the object database, and a push of the result.
 *
 * What lands is still exactly what ADR-0018 requires: a fast-forward or a true
 * merge, pushed by a Signer, so the Proposal's tip is an ancestor of the list.
 * A conflict is left to the Signer with the manual recipe, because a `signers`
 * file two people edited is a decision about who holds the name.
 */
async function acceptSignerList(
  clone: AcceptClone,
  proposal: ProposalListing,
  deps: AcceptDeps,
): Promise<AcceptResult> {
  if (proposal.merged) {
    return {
      stdout: `${proposal.id} is already merged into ${SIGNERS_REF} (${proposal.tip.slice(0, 8)})\n`,
      stderr: '',
      code: 0,
    }
  }

  const ref = proposalRef(SIGNERS_TARGET, proposal.id)
  const tip = fetchOid(clone, ref, deps)
  if (typeof tip !== 'string') return tip
  if (tip !== proposal.tip) {
    return refuse(
      `${proposal.id} moved while we were reading it: the host listed ${proposal.tip.slice(0, 8)}, ` +
        `the fetch brought ${tip.slice(0, 8) || 'nothing'}. Run accept again.`,
      1,
    )
  }

  const listTip = fetchOid(clone, SIGNERS_REF, deps)
  if (typeof listTip !== 'string') return listTip

  // A fast-forward where the Proposal already contains the list, and a true merge
  // otherwise. The order matters only for what is pushed: either way the tip
  // ends up an ancestor.
  let push = tip
  if (deps.git(['merge-base', '--is-ancestor', listTip, tip]).code !== 0) {
    const tree = deps.git(['merge-tree', '--write-tree', listTip, tip])
    // Exit 1 is git's "the merge conflicted"; anything else is git failing to
    // do the merge at all — a missing object, unrelated histories, a version
    // without `--write-tree`. Reported apart, because "which lines hold the
    // name is yours to decide" is a false thing to tell a Signer whose git
    // never got as far as comparing them.
    if (tree.code === 1) {
      return refuse(
        `merging ${proposal.id} into ${SIGNERS_REF} conflicts — two commits edited the ` +
          `\`signers\` file, and which lines hold the name is yours to decide:\n` +
          `${(tree.stdout + tree.stderr).trimEnd().replace(/^/gm, '  ')}\n` +
          `  resolve it in a scratch clone, then: git push --signed=if-asked ` +
          `${clone.remoteName} HEAD:${SIGNERS_REF}`,
        1,
      )
    }
    if (tree.code !== 0) {
      return refuse(
        `could not merge ${proposal.id} into ${SIGNERS_REF}: ` +
          `${(tree.stderr + tree.stdout).trim()}`,
        1,
      )
    }
    const merged = tree.stdout.trim().split('\n')[0] ?? ''
    if (merged === '') {
      return refuse(`merging ${proposal.id} produced no tree — nothing was pushed`, 1)
    }
    const commit = deps.git([
      'commit-tree',
      merged,
      '-p',
      listTip,
      '-p',
      tip,
      '-m',
      `accept ${proposal.id} onto the Signer List`,
    ])
    if (commit.code !== 0) {
      return refuse(`could not record the merge: ${commit.stderr.trim()}`, 1)
    }
    push = commit.stdout.trim()
    if (push === '') return refuse('could not record the merge: git wrote no commit', 1)
  }

  const pushed = deps.git(['push', '--signed=if-asked', clone.remoteName, `${push}:${SIGNERS_REF}`])
  if (pushed.code !== 0) {
    return refuse(
      `pushing ${SIGNERS_REF} was refused: ${(pushed.stderr + pushed.stdout).trim()}`,
      1,
    )
  }

  return {
    stdout:
      `accepted ${proposal.id} (${proposal.tip.slice(0, 8)}) onto ${SIGNERS_REF}` +
      ` — it is now ${push.slice(0, 8)}\n`,
    stderr: '',
    code: 0,
  }
}

/**
 * Fetch one ref and say what commit came back, or the refusal to return.
 *
 * `FETCH_HEAD` is read immediately after its own fetch, which is the whole
 * reason this is a function: the two refs this path needs both land there, and
 * reading it once at the end would answer for whichever was fetched last.
 */
function fetchOid(clone: AcceptClone, ref: string, deps: AcceptDeps): string | AcceptResult {
  const fetched = deps.git(['fetch', '--quiet', clone.remoteName, ref])
  if (fetched.code !== 0) {
    return refuse(`could not fetch ${ref}: ${fetched.stderr.trim()}`, 1)
  }
  // An oid we could not read is refused HERE rather than carried onward as an
  // empty string: downstream it would reach `merge-tree`, whose failure this
  // command reports as a conflict in the `signers` file — telling a Signer to
  // decide who holds the name, when all that happened is a fetch we could not
  // read back.
  const read = deps.git(['rev-parse', 'FETCH_HEAD'])
  const oid = read.stdout.trim()
  if (read.code !== 0 || oid === '') {
    return refuse(`fetched ${ref}, but could not read what came back: ${read.stderr.trim()}`, 1)
  }
  return oid
}

/**
 * The Proposals one repository holds, read from the endpoint ADR-0018 named.
 *
 * Addressed at the clone's own origin rather than at a configured host, so a
 * self-hosted deployment on plain http needs nothing said. The credential is
 * the one `watch` presents and `git` itself presents — a deployment token where
 * there is one, otherwise the Read Challenge signature — because on a Private
 * name the Proposals read is gated exactly as a fetch is.
 */
export async function fetchProposals(
  clone: AcceptClone,
  token: string | null,
): Promise<ProposalListing[]> {
  const url = `${clone.origin}/${clone.repo}.git/proposals`
  const authorization = token
    ? `Bearer ${token}`
    : await readAuthorization(clone.origin, realCredentialDeps(clone.root))
  const response = await fetch(url, {
    headers: authorization ? { authorization } : {},
  })
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim()
    // A 404 here is the deployment saying it does not offer Proposals at all —
    // worth saying in those words, because the alternative reading ("this
    // repository has none") is an answer the endpoint would have given as an
    // empty list.
    throw new Error(
      response.status === 404
        ? `${url} answered 404 — this deployment does not offer Proposals`
        : `${url} answered ${response.status}${body ? `: ${body}` : ''}`,
    )
  }
  const body = (await response.json()) as { proposals?: ProposalListing[] }
  return body.proposals ?? []
}

/** The deps as they are on a real machine. */
export function realAcceptDeps(
  cwd: string = process.cwd(),
  token: string | null = null,
): AcceptDeps {
  // Resolved once, and by `git` as well as by `discover`, so the order the two
  // are called in cannot change which directory a subprocess runs in.
  let resolved: string | null | undefined
  const root = () => (resolved ??= toplevel(cwd))
  return {
    discover() {
      const dir = root()
      if (!dir) return null
      const remotes = parseRemoteList(git(dir, ['remote', '-v']).stdout)
      // The same remote `watch` subscribes to and `setup` configures, so the
      // three commands can never disagree about which host a clone belongs to.
      const chosen = pickRemote(remotes)
      if (!chosen) return null
      const url = remotes.find((remote) => remote.name === chosen.name)?.url ?? ''
      const origin = originOf(url)
      if (!origin) return null
      const head = parseHead(symbolicHead(dir))
      return {
        root: dir,
        remoteName: chosen.name,
        origin,
        repo: chosen.repo,
        branch: head === null ? null : head.replace(/^refs\/heads\//, ''),
      }
    },
    proposals: (clone) => fetchProposals(clone, token),
    git: (args) => git(root() ?? cwd, args),
  }
}
