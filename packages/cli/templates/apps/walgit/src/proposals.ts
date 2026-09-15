/**
 * Proposals: the one push a claimed name takes from someone not on its Signer
 * List (docs/adr/0018).
 *
 * A Proposal is a ref under `refs/walgit/proposals/<target>/<id>` naming a
 * commit its pusher wants in `refs/heads/<target>`, plus the Push Certificate
 * behind it, and nothing else. There is no record, no row and no file: whether
 * it is Merged is `merge-base --is-ancestor` against the target, computed on
 * read from the Cache and never written down.
 *
 * Three questions live here and all three are pure:
 *
 *   - `parseProposalRef` — what a ref NAMES. The target is in the ref name
 *     rather than derived from the commit, so `ls-remote` shows it and nothing
 *     has to be parsed to list what is open.
 *   - `checkProposalRefs` — whether the host will hold it. A Proposal aimed at
 *     a branch that does not exist, at something that is not a branch, or
 *     pointing at an object that is not a commit, is refused in `pre-receive`
 *     rather than stored: append-only means a ref written here can never be
 *     deleted, so the one moment to refuse junk is before it lands.
 *   - `listProposals` — what the repository HOLDS, for the read surface
 *     (`GET /<name>.git/proposals`). It is handed the Index's refs, the Index's
 *     provenance and an ancestry predicate, and it stores nothing: Merged is
 *     recomputed on every read, because a Proposal that became merged did so by
 *     someone pushing the target, and nothing told this host about it.
 *
 * WHO may write one is deliberately not here. That is the Signer List gate's
 * question — `checkSignerAllowed` in `src/signers.ts` — because the rule is
 * *whoever may read may propose*, and reading is a Reader List's answer, which
 * that gate already holds. Splitting it the other way would have put half of
 * ownership in this file.
 *
 * Off unless the instance turns it on, like every capability in this package.
 * With the flag off `refs/walgit/proposals/…` is an ordinary ref namespace
 * under the ordinary gate: nothing widens and nothing is validated.
 */

import { flagEnabled } from '../shared/policy'
import { ZERO_OID } from '../shared/protocol'
import { git } from './git'
import type { Provenance, RefChange } from './wal-index'

/** The env flag an instance sets to take Proposals. */
export function proposalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagEnabled(env.WALGIT_PROPOSALS)
}

/**
 * The namespace, with its trailing slash — so `startsWith` cannot match a ref
 * called `refs/walgit/proposalsomething`.
 */
export const PROPOSALS_PREFIX = 'refs/walgit/proposals/'

/** The branch a Proposal wants its commit in, spelled as a ref. */
export const targetRef = (target: string): string => `refs/heads/${target}`

export interface Proposal {
  /** The branch this Proposal is for, WITHOUT the `refs/heads/` prefix. */
  target: string
  /** The pusher's word. The host assigns nothing and collisions are refused. */
  id: string
}

/**
 * What a ref names, or `null` when it names no Proposal.
 *
 * The id is the LAST segment and the target is everything before it, which is
 * the only split that lets a target be a branch with slashes in it — `feat/login`
 * is an ordinary branch name, and an agent proposing to one must not have to
 * know this ref is parsed at all.
 *
 * Both halves must be non-empty, so `…/main` (no id) and `…/main/` (no id) and
 * `…//fix` (no target) name nothing. That is a refusal rather than a guess:
 * every one of them is a client that meant something this host cannot tell.
 */
export function parseProposalRef(ref: string): Proposal | null {
  if (!ref.startsWith(PROPOSALS_PREFIX)) return null
  const rest = ref.slice(PROPOSALS_PREFIX.length)
  const cut = rest.lastIndexOf('/')
  if (cut <= 0) return null
  const target = rest.slice(0, cut)
  const id = rest.slice(cut + 1)
  if (target === '' || id === '') return null
  return { target, id }
}

/** Is this ref in the namespace at all, well-formed or not? */
export const isProposalRef = (ref: string): boolean => ref.startsWith(PROPOSALS_PREFIX)

/**
 * What the shape check is asked of: the refs this repository holds, and what
 * an object is.
 *
 * The refs come from the **Index**, not from the Cache, for the reason the gate
 * reads its Signer List there — the Cache is disposable, and a target that
 * existed only on whichever node happened to have materialized would make a
 * refusal depend on which container answered.
 *
 * The object type is a subprocess against the quarantine, injected so every
 * decision here is testable without a repository — the same seam
 * `src/signers.ts` puts in front of its blob reader.
 */
export interface ProposalSource {
  /** The repository's refs, as the Index holds them: ref → oid. */
  refs: Readonly<Record<string, string>>
  /** `commit`, `tree`, `blob`, `tag` — or `null` for an object git cannot see. */
  objectType: (oid: string) => string | null
}

/** The real object reader: the pushed objects are in the hook's object path. */
export function gitObjectType(gitDir: string): (oid: string) => string | null {
  return (oid) => {
    const res = git(['--git-dir', gitDir, 'cat-file', '-t', oid])
    if (res.status !== 0) return null
    const type = res.stdout.trim()
    return type === '' ? null : type
  }
}

/** Every way a Proposal can be malformed. */
export type ProposalRefusal =
  /** The ref is in the namespace and names no `<target>/<id>`. */
  | 'grammar'
  /** `refs/heads/<target>` is not a ref this repository holds. */
  | 'missing-target'
  /** The target is not a branch — it names something outside `refs/heads/`. */
  | 'not-a-branch'
  /** The tip is a tree, a blob, a tag, or an object the host cannot see. */
  | 'not-a-commit'

export type ProposalVerdict =
  | { ok: true }
  | { ok: false; kind: ProposalRefusal; ref: string; message: string }

/**
 * Judge every Proposal ref a push writes. Refs outside the namespace are
 * somebody else's question and are passed over.
 *
 * A DELETION is passed over too: it has no tip to be a commit and no Proposal
 * to validate, and whether a ref here may be removed at all is append-only's
 * answer rather than this one's. On the deployment ADR-0018 is written for
 * append-only is on, so there is nothing to delete with.
 *
 * The first offending ref decides the push, as append-only's judge does and for
 * the same reason: a push is all or nothing to git, so a second refusal would
 * only make the message longer than an agent reads.
 */
export function checkProposalRefs(
  repoId: string,
  changes: readonly RefChange[],
  source: ProposalSource,
): ProposalVerdict {
  for (const change of changes) {
    if (!isProposalRef(change.ref)) continue
    if (change.newOid === ZERO_OID) continue

    const proposal = parseProposalRef(change.ref)
    if (!proposal) return refuse(repoId, 'grammar', change.ref, 'names no target and id')

    if (proposal.target.startsWith('refs/')) {
      return refuse(
        repoId,
        'not-a-branch',
        change.ref,
        `its target \`${proposal.target}\` is not a branch — a Proposal names one under refs/heads/`,
      )
    }

    const target = targetRef(proposal.target)
    if (source.refs[target] === undefined) {
      return refuse(repoId, 'missing-target', change.ref, `${target} does not exist here`)
    }

    const type = source.objectType(change.newOid)
    if (type !== 'commit') {
      return refuse(
        repoId,
        'not-a-commit',
        change.ref,
        `it points at ${type ?? 'an object this host cannot read'}, not a commit`,
      )
    }
  }
  return { ok: true }
}

const refuse = (
  repoId: string,
  kind: ProposalRefusal,
  ref: string,
  why: string,
): Extract<ProposalVerdict, { ok: false }> => ({
  ok: false,
  kind,
  ref,
  message: rejectionMessage(repoId, ref, why),
})

/**
 * What a malformed Proposal reads. Product copy, like every other refusal on
 * this path: an agent that cannot act on a refusal has been told nothing, and
 * this one is most often read by an agent that has just learned Proposals
 * exist.
 */
function rejectionMessage(repoId: string, ref: string, why: string): string {
  return [
    `walgit: refused — ${ref} is not a Proposal ${repoId} can hold: ${why}.`,
    '',
    'A Proposal is a ref naming the commit you want in an existing branch:',
    '',
    `    git push --signed=yes origin HEAD:${PROPOSALS_PREFIX}<branch>/<your-id>`,
    '',
    'The branch is the one you want it merged into and must already exist here;',
    'the id is your own word for this change, and a taken one is refused as a',
    'non-fast-forward, so pick another. Refs here are append-only like every',
    'other, which is why a Proposal is judged before it is stored rather than',
    'after.',
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

// ── The read surface ────────────────────────────────────────────────────────

/**
 * One Proposal, as `GET /<name>.git/proposals` reports it (docs/adr/0018).
 *
 * Every field is derived: the id and the target from the ref NAME, the tip from
 * the Index, the pusher from the Provenance the Index already records, and
 * `merged` from ancestry at the moment of the read. Nothing here is state
 * walgit keeps — there is no row to go stale and nothing a Materialize could
 * fail to rebuild.
 */
export interface ProposalListing extends Proposal {
  /** The commit the pusher wants in the target. */
  tip: string
  /**
   * The key that signed the push that put the tip there, or `null`.
   *
   * `null` rather than an omitted field, because absence is an ordinary answer
   * here: signing is what a deployment taking Proposals demands, but a
   * repository can hold refs from before the Index recorded provenance at all,
   * and a reader should not have to tell a missing key from a missing field.
   */
  pusher: string | null
  /** Its tip is an ancestor of the target's tip. Computed, never stored. */
  merged: boolean
}

/**
 * Does `tip` reach `ancestorOf`? The one question `merged` is.
 *
 * Injected so the listing is pure and so the ONLY place that spawns git for
 * this is `gitAncestry` below — the same seam `ProposalSource.objectType` puts
 * in front of the hook's object reader.
 */
export type Ancestry = (tip: string, ancestorOf: string) => boolean

/**
 * The real predicate: `merge-base --is-ancestor` against the Cache.
 *
 * The Cache, deliberately, and it is the one thing on this path not read from
 * the Index: the Index knows where refs point and holds no commits, so ancestry
 * cannot be answered from it at all. The caller's job is to have synced the
 * Cache first (`src/sync.ts`) — a cold container Materializes there, which is
 * what makes an answer from a disposable disk as true as one from the log.
 *
 * Exit 0 is yes, 1 is no, and anything else — a commit this disk does not hold
 * — is NOT merged. Reading a missing object as merged would mark a Proposal
 * accepted on the strength of a failed subprocess, which is the one direction a
 * later read cannot take back.
 */
export function gitAncestry(gitDir: string): Ancestry {
  return (tip, ancestorOf) =>
    git(['--git-dir', gitDir, 'merge-base', '--is-ancestor', tip, ancestorOf]).status === 0
}

/**
 * Every Proposal a repository holds, in ref order.
 *
 * Sorted by ref name rather than left in whatever order the Index's object
 * happens to serialize, so a client diffing two reads sees only what changed.
 *
 * A ref in the namespace that names no `<target>/<id>` is SKIPPED rather than
 * reported. `pre-receive` refuses those, so one can only be here from before
 * the flag was on — and the read surface is not the place to litigate a ref
 * that is already written for good.
 *
 * Superseded is not derived. ADR-0018 admits it "if it is free", and it is not:
 * it is ancestry between every pair of Proposals to the same target, which is a
 * second quadratic walk for a field nothing has asked for yet.
 */
/**
 * What a push MERGED, per branch it moved: the ids of Proposals to that branch
 * whose tip became an ancestor of the new tip (docs/adr/0018).
 *
 * The Ref Event a Watcher receives carries this, so an agent watching `main`
 * learns a Proposal landed from the move itself rather than by reading the
 * Proposal list again — the second call this whole stream exists to avoid.
 *
 * NEWLY, and that is the whole of the old oid's job here: a Proposal that was
 * already an ancestor before this push merged on some earlier push, and
 * re-announcing it on every subsequent commit to the branch would make the
 * field a report of state rather than of what happened. A branch this push
 * CREATED has no before, so everything it reaches is news.
 *
 * Only `refs/heads/` moves are asked about, and never a deletion: a branch that
 * is gone is nothing to be an ancestor of, and a Proposal aimed at it is open —
 * which is what `listProposals` reads it as too.
 *
 * Ids are sorted and a branch that merged nothing is left out entirely, so the
 * caller has nothing to decide about an empty array.
 */
export function mergedProposals(
  changes: readonly RefChange[],
  refs: Readonly<Record<string, string>>,
  isAncestor: Ancestry,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const change of changes) {
    if (!change.ref.startsWith('refs/heads/')) continue
    if (change.newOid === ZERO_OID) continue
    const target = change.ref.slice('refs/heads/'.length)
    const ids: string[] = []
    for (const ref of Object.keys(refs).toSorted()) {
      const proposal = parseProposalRef(ref)
      if (!proposal || proposal.target !== target) continue
      const tip = refs[ref]!
      if (!isAncestor(tip, change.newOid)) continue
      const had = change.oldOid !== undefined && change.oldOid !== ZERO_OID
      if (had && isAncestor(tip, change.oldOid!)) continue
      ids.push(proposal.id)
    }
    if (ids.length > 0) merged[change.ref] = ids
  }
  return merged
}

export function listProposals(
  refs: Readonly<Record<string, string>>,
  provenance: Readonly<Record<string, Provenance>>,
  isAncestor: Ancestry,
): ProposalListing[] {
  const listings: ProposalListing[] = []
  for (const ref of Object.keys(refs).toSorted()) {
    const proposal = parseProposalRef(ref)
    if (!proposal) continue
    const tip = refs[ref]!
    const targetTip = refs[targetRef(proposal.target)]
    listings.push({
      ...proposal,
      tip,
      pusher: provenance[ref]?.signer ?? null,
      // A target this repository no longer holds is nothing to be an ancestor
      // of, so the Proposal is open — which is also what it is.
      merged: targetTip !== undefined && isAncestor(tip, targetTip),
    })
  }
  return listings
}
