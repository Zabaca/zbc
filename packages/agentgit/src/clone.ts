/**
 * Which clone this is — asked once, for every command that asks.
 *
 * `watch`, `accept` and `setup` all need the same five facts about the
 * directory they were run in: its root, which remote is the walgit one, that
 * remote's host and origin, the repository name, and the ref HEAD is on. Each
 * used to derive them itself, and the invariant that the three must never
 * disagree about which remote a clone belongs to survived only as a comment in
 * two of them. It is this module instead.
 *
 * The answer is NAMED rather than nullable, because the three ways discovery
 * can come up short are three different things to tell an agent, and a bare
 * `null` made them one: `no-repository` is "you are not in a checkout",
 * `no-remote` is "you are in one, and nothing here points at a walgit host" —
 * which reads as the wrong directory only if we say so. There is deliberately
 * no fourth `no-origin` arm: every URL `parseRemote` accepts, `originOf`
 * accepts too, so a remote with a repository and no origin cannot occur.
 *
 * The ref rides on BOTH arms that have a root. A checkout whose only remote is
 * GitHub still has a branch, and `watch` defaults its subscription to it once a
 * repository is named on the command line.
 */

import { git, symbolicHead, toplevel } from './git'
import { type Remote, originOf, parseHead, parseRemoteList, pickRemote } from './remote'

/** A checkout with a walgit remote: everything the three commands need. */
export interface Clone {
  kind: 'clone'
  root: string
  /** The remote refs are fetched from and pushed to. */
  remoteName: string
  /** Host and port, for the event socket's URL. */
  host: string
  /** Scheme, host and port — what a read is addressed to and a helper keyed on. */
  origin: string
  repo: string
  /** The full ref HEAD is on (`refs/heads/main`), or `null` when detached. */
  ref: string | null
}

/**
 * A checkout with no walgit remote, and the remotes it does have.
 *
 * The remotes are carried because "there is nothing here to take a host from"
 * and "the remotes here are ones we cannot address" are different sentences,
 * and only the caller knows which of them its user needs.
 */
export interface CloneWithoutRemote {
  kind: 'no-remote'
  root: string
  ref: string | null
  remotes: readonly Remote[]
}

/** Not a checkout at all — or no git on the machine to ask. */
export interface NoRepository {
  kind: 'no-repository'
}

export type CloneDiscovery = Clone | CloneWithoutRemote | NoRepository

/**
 * `git remote -v`, which is two lines per remote and a tab nobody should see.
 *
 * Internal: listing remotes is discovery's business and nobody else's, and a
 * shared helper is how the three copies of this sequence stayed plausible.
 */
function remotes(dir: string): Remote[] {
  return parseRemoteList(git(dir, ['remote', '-v']).stdout)
}

/** What the checkout `cwd` is in, named. */
export function discoverClone(cwd: string): CloneDiscovery {
  const root = toplevel(cwd)
  if (root === null) return { kind: 'no-repository' }

  const ref = parseHead(symbolicHead(root))
  const found = remotes(root)
  const chosen = pickRemote(found)
  const url = chosen ? (found.find((remote) => remote.name === chosen.name)?.url ?? '') : ''
  const origin = chosen ? originOf(url) : null
  // `origin === null` with a remote chosen cannot happen — every URL
  // `parseRemote` accepts, `originOf` accepts too — which is why there is no
  // arm for it. It folds in here rather than being asserted, so a future
  // loosening of either parser degrades to "no walgit remote" instead of
  // handing a caller an origin-less clone.
  if (!chosen || origin === null) return { kind: 'no-remote', root, ref, remotes: found }

  return {
    kind: 'clone',
    root,
    remoteName: chosen.name,
    host: chosen.host,
    origin,
    repo: chosen.repo,
    ref,
  }
}
