/**
 * `--ff-on-clean`: take the branch's new commits when they can be taken without
 * running a merge in the working tree.
 *
 * Every other path in this client leaves the branch where it is, and the header
 * of `git.ts` says so. This is the exception the owner asked for by passing the
 * flag, and it is narrow on purpose: the clone moves only when there is nothing
 * in the tree to lose and nothing to decide.
 *
 * The trick is that a diverged branch cannot be fast-forwarded to the remote
 * ref — `git merge --ff-only origin/main` fails, by definition, the moment the
 * clone has a commit of its own. So the merge is made first, in the object
 * database: `merge-tree` writes the merged tree and `commit-tree` wraps it with
 * the local HEAD and the remote ref as parents. HEAD is then an ancestor of
 * that commit, which makes the working-tree step a fast-forward — a ref update
 * and a checkout, with no merge algorithm and no conflict possible. Nothing is
 * written to the stash list and nothing is left half-applied.
 *
 * This is the same technique `acceptSignerList` uses, and for the same reason:
 * a merge made in the object database cannot cost somebody their working tree.
 *
 * Four things stop it, and each of them is the interesting case:
 *
 *   current    the remote ref is already an ancestor. Doing the work anyway
 *              would add an empty merge commit on every unrelated push.
 *   dirty      tracked files are modified. A fast-forward still checks files
 *              out, and uncommitted work is the normal state of an agent
 *              mid-task — the case worth declining, not the edge case.
 *   conflicts  `merge-tree` says no. Whose change survives is a decision about
 *              intent, which is the owner's; `collides` has already reported it.
 *   refused    git declined the checkout. The likeliest cause is an untracked
 *              file the merge would overwrite (see `isDirty` for why untracked
 *              files do not count as dirty), and git's refusal is the guard.
 *
 * `merge-tree` runs here rather than reusing the one the collision check
 * already ran. It costs about 14ms and it keeps this file readable on its own,
 * which is worth more than the 14ms.
 */

import { git } from './git'

export type FfOutcome =
  | { kind: 'current' }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'conflicts' }
  | { kind: 'moved'; commit: string }
  | { kind: 'refused'; reason: string }

/**
 * Tracked changes only.
 *
 * Untracked files are deliberately not "dirty". An agent's scratch output —
 * logs, build products, a notes file — would otherwise hold the flag off for
 * the whole of a session, and the risk they represent is already covered: if
 * the incoming merge adds a file at the same path, git refuses the checkout
 * itself rather than overwriting it, and the outcome is `refused`.
 */
export function isDirty(dir: string): string[] {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no'])
  if (status.code !== 0) return []
  return status.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3))
}

export function fastForwardOnClean(dir: string, remoteRef: string): FfOutcome {
  // `--is-ancestor` is the same definition of "merged" ADR-0018 uses.
  if (git(dir, ['merge-base', '--is-ancestor', remoteRef, 'HEAD']).code === 0) {
    return { kind: 'current' }
  }

  const paths = isDirty(dir)
  if (paths.length > 0) return { kind: 'dirty', paths }

  // Built from HEAD, never from a `stash create` commit. The collision check
  // merges the working tree on purpose, so that it can see uncommitted edits;
  // a commit made from *that* tree and then fast-forwarded onto would commit
  // work the agent never committed, which is the one thing a watcher must not
  // do. Reaching here means the tree is clean and the two are the same anyway.
  const merged = git(dir, ['merge-tree', '--write-tree', 'HEAD', remoteRef])
  if (merged.code === 1) return { kind: 'conflicts' }
  if (merged.code !== 0) {
    return { kind: 'refused', reason: merged.stderr.trim() || `merge-tree exited ${merged.code}` }
  }

  const tree = merged.stdout.trim().split('\n')[0] ?? ''
  if (tree === '') return { kind: 'refused', reason: 'merge-tree wrote no tree' }

  const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim()
  const made = git(dir, [
    'commit-tree',
    tree,
    '-p',
    head,
    '-p',
    remoteRef,
    '-m',
    `Merge ${remoteRef}`,
  ])
  if (made.code !== 0) {
    return { kind: 'refused', reason: made.stderr.trim() || `commit-tree exited ${made.code}` }
  }
  const commit = made.stdout.trim()

  const moved = git(dir, ['merge', '--ff-only', commit])
  if (moved.code !== 0) {
    return {
      kind: 'refused',
      reason: moved.stderr.trim() || `merge --ff-only exited ${moved.code}`,
    }
  }
  return { kind: 'moved', commit }
}
