/**
 * The Proposal namespace, judged before anything is stored (docs/adr/0018).
 *
 * Two questions live in `src/proposals.ts` and both are pure: what a ref under
 * `refs/walgit/proposals/` NAMES, and whether the host will hold it. The gate —
 * whether this pusher may write one at all — is the Signer List's, next door in
 * `src/signers.ts`, and is tested there.
 */

import { describe, expect, test } from 'bun:test'

import {
  PROPOSALS_PREFIX,
  checkProposalRefs,
  parseProposalRef,
  mergedProposals,
  proposalsEnabled,
  targetRef,
  type ProposalSource,
} from './proposals'
import { ZERO_OID } from '../shared/protocol'
import type { RefChange } from '../shared/wal-index'

const COMMIT = 'a'.repeat(40)
const TREE = 'b'.repeat(40)

const change = (ref: string, newOid = COMMIT, oldOid = ZERO_OID): RefChange => ({
  ref,
  oldOid,
  newOid,
})

/** A repository holding `refs/heads/main`, where `COMMIT` is the only commit. */
const source: ProposalSource = {
  refs: { 'refs/heads/main': 'c'.repeat(40) },
  objectType: (oid) => (oid === COMMIT ? 'commit' : oid === TREE ? 'tree' : null),
}

describe('the flag', () => {
  test('is off unless the deployment sets it, and reads `1` or `true`', () => {
    expect(proposalsEnabled({})).toBe(false)
    expect(proposalsEnabled({ WALGIT_PROPOSALS: '' })).toBe(false)
    expect(proposalsEnabled({ WALGIT_PROPOSALS: 'yes' })).toBe(false)
    expect(proposalsEnabled({ WALGIT_PROPOSALS: '1' })).toBe(true)
    expect(proposalsEnabled({ WALGIT_PROPOSALS: 'true' })).toBe(true)
  })
})

describe('what a Proposal ref names', () => {
  // The id is the last segment and the target is everything before it, which is
  // what lets a target be a branch with slashes in it — `feat/login` is an
  // ordinary branch name and an agent proposing to one must not have to know
  // that walgit parses this ref at all.
  test('the last segment is the id and the rest is the target', () => {
    expect(parseProposalRef(`${PROPOSALS_PREFIX}main/fix-auth`)).toEqual({
      target: 'main',
      id: 'fix-auth',
    })
    expect(parseProposalRef(`${PROPOSALS_PREFIX}feat/login/fix-auth`)).toEqual({
      target: 'feat/login',
      id: 'fix-auth',
    })
  })

  test('a ref outside the namespace names no Proposal', () => {
    expect(parseProposalRef('refs/heads/main')).toBeNull()
    expect(parseProposalRef('refs/walgit/signers')).toBeNull()
    // The prefix with nothing under it, and a target with no id after it.
    expect(parseProposalRef('refs/walgit/proposals')).toBeNull()
    expect(parseProposalRef(PROPOSALS_PREFIX)).toBeNull()
    expect(parseProposalRef(`${PROPOSALS_PREFIX}main`)).toBeNull()
    expect(parseProposalRef(`${PROPOSALS_PREFIX}main/`)).toBeNull()
    expect(parseProposalRef(`${PROPOSALS_PREFIX}/fix-auth`)).toBeNull()
  })
})

describe('what the hook refuses', () => {
  test('a well-formed Proposal onto an existing branch is held', () => {
    const verdict = checkProposalRefs('alpha', [change(`${PROPOSALS_PREFIX}main/fix-auth`)], source)
    expect(verdict).toEqual({ ok: true })
  })

  test('a target no branch of that name exists for', () => {
    const verdict = checkProposalRefs('alpha', [change(`${PROPOSALS_PREFIX}nope/fix`)], source)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('missing-target')
    expect(verdict.message).toContain('refs/heads/nope')
  })

  /**
   * A target outside `refs/heads/`, which is the refusal that stops anybody
   * proposing a Signer List: `refs/walgit/proposals/refs/walgit/signers/x`
   * names the target `refs/walgit/signers`, and a target that begins `refs/` is
   * not a branch.
   */
  test('a target that is not a branch at all', () => {
    const ref = `${PROPOSALS_PREFIX}refs/walgit/signers/take-it`
    const verdict = checkProposalRefs('alpha', [change(ref)], source)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('not-a-branch')
    expect(verdict.message).toContain('refs/heads/')
  })

  /**
   * The one non-branch target (docs/adr/0018): a stranger asks to be added to
   * a name by proposing the Signer List itself. The spelling is the list's ref
   * with `refs/` dropped, so the ordinary "no target begins with refs/" rule is
   * untouched and the id is still the last segment.
   */
  test('the Signer List is a target, spelled `walgit/signers`', () => {
    expect(parseProposalRef(`${PROPOSALS_PREFIX}walgit/signers/add-me`)).toEqual({
      target: 'walgit/signers',
      id: 'add-me',
    })
    expect(targetRef('walgit/signers')).toBe('refs/walgit/signers')

    const claimed: ProposalSource = {
      ...source,
      refs: { ...source.refs, 'refs/walgit/signers': 'd'.repeat(40) },
    }
    const verdict = checkProposalRefs(
      'alpha',
      [change(`${PROPOSALS_PREFIX}walgit/signers/add-me`)],
      claimed,
    )
    expect(verdict).toEqual({ ok: true })
  })

  test('proposing the Signer List of a name that holds none names that ref', () => {
    const verdict = checkProposalRefs(
      'alpha',
      [change(`${PROPOSALS_PREFIX}walgit/signers/add-me`)],
      source,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('missing-target')
    expect(verdict.message).toContain('refs/walgit/signers does not exist here')
  })

  // `walgit/signers` is the WHOLE target or nothing: a deeper ref is an
  // ordinary branch target, so it is judged against `refs/heads/` like any
  // other and not admitted by being a prefix of the one exception.
  test('a target merely starting with the Signer List spelling is an ordinary branch', () => {
    const claimed: ProposalSource = {
      ...source,
      refs: { ...source.refs, 'refs/walgit/signers': 'd'.repeat(40) },
    }
    const verdict = checkProposalRefs(
      'alpha',
      [change(`${PROPOSALS_PREFIX}walgit/signers/deeper/add-me`)],
      claimed,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('missing-target')
    expect(verdict.message).toContain('refs/heads/walgit/signers/deeper')
  })

  test('a tip that is not a commit', () => {
    const verdict = checkProposalRefs(
      'alpha',
      [change(`${PROPOSALS_PREFIX}main/tree-tip`, TREE)],
      source,
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('not-a-commit')
    expect(verdict.message).toContain('tree')
  })

  test('a ref under the namespace that names no Proposal', () => {
    const verdict = checkProposalRefs('alpha', [change(`${PROPOSALS_PREFIX}main`)], source)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe('grammar')
  })

  // Every other ref is somebody else's question: this judges the namespace and
  // nothing else, so a push to a branch is held here whatever it does.
  test('a push touching no Proposal ref is not this function’s business', () => {
    expect(checkProposalRefs('alpha', [change('refs/heads/whatever', TREE)], source)).toEqual({
      ok: true,
    })
  })

  // A deletion has no tip to be a commit and no Proposal to validate — it is
  // append-only's question, and on a deployment that allows deletions there is
  // nothing here to refuse.
  test('a deletion is left to append-only', () => {
    const deletion = change(`${PROPOSALS_PREFIX}gone/fix`, ZERO_OID, COMMIT)
    expect(checkProposalRefs('alpha', [deletion], source)).toEqual({ ok: true })
  })
})

/**
 * What a target's move MERGED (docs/adr/0018): the ids of Proposals to that
 * target whose tip became an ancestor of the new tip under this push.
 *
 * Ancestry is injected, as it is for `listProposals`, so what is under test
 * here is the selection — which refs are asked about and which answers count —
 * rather than git's answer, which `src/proposals-read.test.ts` pins against a
 * real repository.
 */
describe('mergedProposals', () => {
  const OLD = 'b'.repeat(40)
  const NEW = 'c'.repeat(40)
  const TIP_ONE = '1'.repeat(40)
  const TIP_TWO = '2'.repeat(40)

  const refs = {
    'refs/heads/main': NEW,
    'refs/heads/other': OLD,
    [`${PROPOSALS_PREFIX}main/fix-auth`]: TIP_ONE,
    [`${PROPOSALS_PREFIX}main/add-cache`]: TIP_TWO,
    [`${PROPOSALS_PREFIX}other/elsewhere`]: TIP_TWO,
  }

  /** An explicit table: `tip` reaches each oid listed for it, and nothing else. */
  const ancestry =
    (table: Record<string, string[]>) =>
    (tip: string, ancestorOf: string): boolean =>
      (table[tip] ?? []).includes(ancestorOf)

  test('names the Proposals whose tip became an ancestor of the new tip', () => {
    const merged = mergedProposals(
      [{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }],
      refs,
      ancestry({ [TIP_ONE]: [NEW] }),
    )
    expect(merged).toEqual({ 'refs/heads/main': ['fix-auth'] })
  })

  test('a Proposal already merged before this push is not announced again', () => {
    const merged = mergedProposals(
      [{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }],
      refs,
      ancestry({ [TIP_ONE]: [OLD, NEW] }),
    )
    expect(merged).toEqual({})
  })

  test('a branch created by this push merges everything it already reaches', () => {
    const merged = mergedProposals(
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: NEW }],
      refs,
      ancestry({ [TIP_ONE]: [NEW], [TIP_TWO]: [NEW] }),
    )
    expect(merged).toEqual({ 'refs/heads/main': ['add-cache', 'fix-auth'] })
  })

  test('only Proposals aimed at the branch that moved are considered', () => {
    const merged = mergedProposals(
      [{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }],
      refs,
      // Every Proposal tip reaches the new tip, so only the target filter can
      // exclude the one aimed at `other`.
      ancestry({ [TIP_ONE]: [NEW], [TIP_TWO]: [NEW] }),
    )
    expect(merged).toEqual({ 'refs/heads/main': ['add-cache', 'fix-auth'] })
  })

  test('a deletion and a ref that is not a branch merge nothing', () => {
    expect(
      mergedProposals(
        [
          { ref: 'refs/heads/main', oldOid: OLD, newOid: ZERO_OID },
          { ref: `${PROPOSALS_PREFIX}main/fix-auth`, oldOid: ZERO_OID, newOid: TIP_ONE },
          { ref: 'refs/tags/v1', oldOid: ZERO_OID, newOid: NEW },
        ],
        refs,
        () => true,
      ),
    ).toEqual({})
  })
})
