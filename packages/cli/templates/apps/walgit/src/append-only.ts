/**
 * Append-only refs: a stranger may add to a repository, never destroy it.
 *
 * This is the property a public, credential-free git host is safe on. It is
 * enforced twice, and the two layers are not redundant:
 *
 *   - git's own `receive.denyNonFastForwards` / `receive.denyDeletes` are the
 *     backstop. They cannot be bypassed by a bug in this file, and they hold
 *     even for a ref update that never passes through `pre-receive`.
 *   - the check below runs in `pre-receive`, which is EARLIER than git's own
 *     refusal, and that earliness buys two things git cannot give. The wording
 *     — `denying non-fast-forward refs/heads/main` tells an agent nothing about
 *     what walgit is or what to do instead — and the object-store write: git
 *     refuses after `pre-receive`, by which point walgit has already uploaded
 *     the pack for a push that was never going to land, leaving an orphan for
 *     `findOrphans` to reclaim.
 *
 * Off unless the instance turns it on. A private instance may want force-push;
 * this is instance configuration, not a template default.
 */

import * as crypto from 'node:crypto'

import { git } from './git'
import { flagEnabled } from '../shared/policy'
import { ZERO_OID } from '../shared/protocol'
import type { RefChange } from './wal-index'

/** The env flag an instance sets to make its repositories append-only. */
export function appendOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagEnabled(env.WALGIT_APPEND_ONLY)
}

/**
 * A free name to push to instead. Random rather than incrementing, because a
 * wave of agents running near-identical prompts all reach for `test` at once
 * and a counter would hand several of them the same "free" name.
 */
export function suggestName(repoId: string): string {
  return `${repoId}-${crypto.randomBytes(4).toString('hex')}`
}

export type RefVerdict =
  | { allowed: true }
  | { allowed: false; kind: 'delete' | 'rewrite'; ref: string }

/**
 * Is this one ref change append-only?
 *
 * Creating a ref is always allowed; deleting one never is. Updating one is
 * allowed exactly when the old tip is an ancestor of the new tip — which is
 * git's own fast-forward test, asked of the objects sitting in the quarantine
 * where `pre-receive` can already see them. Unrelated history fails it, which
 * is the intended answer: it would drop every commit the ref names today.
 */
export function judgeRefChange(gitDir: string, change: RefChange): RefVerdict {
  if (change.oldOid === ZERO_OID) return { allowed: true }
  if (change.newOid === ZERO_OID) return { allowed: false, kind: 'delete', ref: change.ref }
  const res = git([
    '--git-dir',
    gitDir,
    'merge-base',
    '--is-ancestor',
    change.oldOid,
    change.newOid,
  ])
  if (res.status === 0) return { allowed: true }
  return { allowed: false, kind: 'rewrite', ref: change.ref }
}

/**
 * The message a rejected push reads. This is product copy, not a debug string:
 * for most agents it is the first thing walgit ever says to them, so it states
 * the rule, why the push was refused, and one concrete thing to do next.
 */
export function rejectionMessage(repoId: string, verdict: RefVerdict & { allowed: false }): string {
  const what =
    verdict.kind === 'delete'
      ? `Deleting ${verdict.ref} would destroy history other people can still reach.`
      : `This push would rewrite ${verdict.ref}: its current commits are not in what you pushed.`
  return [
    `walgit: refused — ${repoId} is append-only.`,
    '',
    what,
    'Anyone can push here, so nothing that has landed can be removed or replaced.',
    '',
    'What you can do instead:',
    `  - push to a new branch:      git push origin HEAD:refs/heads/<new-branch>`,
    `  - or use a fresh repository: git remote set-url origin <same-host>/${suggestName(repoId)}.git`,
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

export type AppendOnlyResult = { ok: true } | { ok: false; message: string }

/**
 * Judge a whole push. The first offending ref decides it: a push is all or
 * nothing to git, so reporting them one at a time is enough and keeps the
 * message short enough to be read.
 */
export function checkAppendOnly(
  gitDir: string,
  repoId: string,
  changes: readonly RefChange[],
): AppendOnlyResult {
  for (const change of changes) {
    const verdict = judgeRefChange(gitDir, change)
    if (!verdict.allowed) return { ok: false, message: rejectionMessage(repoId, verdict) }
  }
  return { ok: true }
}
