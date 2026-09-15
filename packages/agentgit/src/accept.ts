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
  if (clone.branch === null) {
    return refuse('HEAD is detached: check out the branch the Proposal targets, then accept it')
  }
  const branch = clone.branch

  // Before the network, not merely before the merge. A dirty tree is refused
  // whatever the Proposal turns out to be, so asking the host first would be a
  // request made only to throw the answer away.
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
  const proposal = found.find((entry) => entry.target === branch)
  if (!proposal) {
    const targets = found.map((entry) => entry.target).join(', ')
    return refuse(
      `Proposal ${JSON.stringify(request.id)} targets ${targets}, and you are on ${branch}.\n` +
        `  check out ${targets} and accept it there`,
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
