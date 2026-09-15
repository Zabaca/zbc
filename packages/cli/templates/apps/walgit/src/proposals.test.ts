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
  proposalsEnabled,
  type ProposalSource,
} from './proposals'
import { ZERO_OID } from '../shared/protocol'
import type { RefChange } from './wal-index'

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
