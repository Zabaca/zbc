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
 * Both ancestor directions are checked first, and only one of the four cases
 * needs the object database at all:
 *
 *   remoteRef is an ancestor of HEAD   already merged; nothing to do.
 *   HEAD is an ancestor of remoteRef   ordinary "behind"; git fast-forwards it
 *                                      itself, and building a merge commit here
 *                                      would leave the clone permanently ahead
 *                                      of origin, once per push.
 *   neither                            diverged; this is what the trick is for.
 *   both                               same commit; the first check takes it.
 *
 * Four things stop it, and each of them is the interesting case:
 *
 *   elsewhere  HEAD is not on the watched ref. This acts on HEAD, so acting
 *              would merge the watched branch into an unrelated one.
 *   dirty      tracked files are modified. A fast-forward still checks files
 *              out, and uncommitted work is the normal state of an agent
 *              mid-task — the case worth declining, not the edge case.
 *   conflicts  `merge-tree` says no. Whose change survives is a decision about
 *              intent, which is the owner's; `collides` has already reported it.
 *   refused    git declined, or could not read the tree. The likeliest cause is
 *              an untracked file the merge would overwrite (see `isDirty` for
 *              why untracked files do not count as dirty), and git's refusal is
 *              the guard.
 *
 * `merge-tree` runs here rather than reusing the one the collision check
 * already ran. It costs about 14ms and it keeps this file readable on its own,
 * which is worth more than the 14ms.
 */

import { git, symbolicHead } from './git'

export type FfOutcome =
  | { kind: 'current' }
  | { kind: 'elsewhere'; head: string }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'conflicts' }
  | { kind: 'moved'; commit: string; synthesized: boolean }
  | { kind: 'refused'; reason: string }

/**
 * Tracked changes, or `null` where git could not say.
 *
 * Untracked files are deliberately not "dirty". An agent's scratch output —
 * logs, build products, a notes file — would otherwise hold the flag off for
 * the whole of a session, and the risk they represent is already covered: if
 * the incoming merge adds a file at the same path, git refuses the checkout
 * itself rather than overwriting it, and the outcome is `refused`.
 *
 * `null` rather than an empty list when `status` fails, because the two are not
 * the same and only one of them is safe. A tree git cannot read is a tree
 * nothing should be checked out over; reading the failure as "clean" would move
 * the branch at exactly the moment least is known about it.
 *
 * `-z` rather than line splitting: porcelain v1 renders a rename as two records
 * and quotes a path containing spaces, so a line-wise `slice(3)` reports
 * `"old -> new"` as one filename.
 */
export function isDirty(dir: string): string[] | null {
  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  if (status.code !== 0) return null
  const records = status.stdout.split('\0').filter((r) => r !== '')
  const paths: string[] = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as string
    paths.push(record.slice(3))
    // A rename or copy is followed by its source path in its own record.
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') i += 1
  }
  return paths
}

export function fastForwardOnClean(dir: string, ref: string, remoteRef: string): FfOutcome {
  // The watched ref and the checked-out branch are not the same question. This
  // acts on HEAD, so acting while HEAD is on something else would merge the
  // watched branch's work into an unrelated one and then report the watched
  // ref as the thing that moved. `--all-refs` makes that the normal case rather
  // than the corner one.
  const checkedOut = symbolicHead(dir).trim()
  if (checkedOut !== ref) {
    return { kind: 'elsewhere', head: checkedOut === '' ? 'a detached HEAD' : checkedOut }
  }

  // `--is-ancestor` is the same definition of "merged" ADR-0018 uses.
  if (git(dir, ['merge-base', '--is-ancestor', remoteRef, 'HEAD']).code === 0) {
    return { kind: 'current' }
  }

  const paths = isDirty(dir)
  if (paths === null) return { kind: 'refused', reason: 'git could not read the working tree' }
  if (paths.length > 0) return { kind: 'dirty', paths }

  // The other ancestor direction, and the ordinary case: a clone with no work
  // of its own, simply behind. git can fast-forward that by itself, and making
  // a merge commit for it would leave the clone permanently ahead of origin
  // with a commit nobody else holds — once per push, for the life of the
  // session. The object-database merge below is for the case where neither ref
  // is an ancestor of the other, which is the only case it is needed for.
  if (git(dir, ['merge-base', '--is-ancestor', 'HEAD', remoteRef]).code === 0) {
    const moved = git(dir, ['merge', '--ff-only', remoteRef])
    if (moved.code !== 0) {
      return {
        kind: 'refused',
        reason: moved.stderr.trim() || `merge --ff-only exited ${moved.code}`,
      }
    }
    return {
      kind: 'moved',
      commit: git(dir, ['rev-parse', 'HEAD']).stdout.trim(),
      synthesized: false,
    }
  }

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
  return { kind: 'moved', commit, synthesized: true }
}
