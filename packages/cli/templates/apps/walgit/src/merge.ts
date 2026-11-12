/**
 * A merge the host performs, on a deployment that opted in (docs/adr/0022):
 * one branch into another, by fast-forward or by squash, as a compare-and-swap
 * on the target.
 *
 * **A merge is a push, not a write.** The result is built in a scratch
 * repository that borrows the Cache's objects (`objects/info/alternates`) and
 * pushed into the Cache over git's local transport — the path `src/admin.ts`
 * seeds a repository through — so `pre-receive` and `reference-transaction`
 * judge it exactly as they judge a client's push: a Signer List, append-only,
 * the size caps, and the compare-and-swap on `index.json` that publishes it.
 * `post-receive` then announces the move, so a Watcher and the webhook hear of
 * it as they hear of any push. Nothing in this file writes the Index, a ref or
 * an object into the served repository itself.
 *
 * **The compare-and-swap is two-layered.** The caller names the commit the
 * target is expected to be at. It is checked against the Index first (a stale
 * expectation costs nothing), and then held by git itself: the push carries
 * `--force-with-lease=<target>:<expected>`, so receive-pack moves the ref only
 * from that commit, and the publish's own CAS refuses a ref the Index moved in
 * the meantime. Of two merges racing for one target, exactly one lands.
 *
 * The routing and the credential are `src/http.ts`'s; this is what the route
 * does once it has been reached.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { COMPARE_MAX_FILES, OID, resolveRef, type CompareFile } from '../shared/browse'
import type { ObjectStore } from '../shared/store'
import { loadIndex } from '../shared/wal-index'
import { identPart } from './admin'
import { compareRevs } from './browse'
import { gitAsync, gitAsyncWithin, type GitOptions } from './git'
import type { ResolvedRepo } from './repo'

/** The largest merge request body walgit will read: a message, not a payload. */
export const MAX_MERGE_BODY_BYTES = 64 * 1024

/**
 * How long the file summary a merge answers with may take: ten seconds, the
 * compare's own budget. Past it the merge still stands and answers with no
 * summary — the summary is a courtesy, the ref move is the result.
 */
const MERGE_SUMMARY_TIMEOUT_MS = 10_000

/**
 * How long the git work that BUILDS one merge may take, together: twenty
 * seconds — peeling, the merge base, ancestry and a squash's three-way merge.
 *
 * A caller can make that work arbitrarily large (a squash of two big diverged
 * histories), it runs on the one container that serves every clone and push,
 * and a refusal costs it nothing to repeat — so it is bounded, and a merge
 * that needs longer is refused (503) rather than waited out. The push itself
 * is not under this deadline: killing a push between its upload and its
 * publish is the one interruption the hooks are not built to be the victim of
 * on purpose, and what it does is bounded by the size caps a push already
 * meets.
 */
const MERGE_BUILD_TIMEOUT_MS = 20_000

/** The build deadline passed. Caught in `mergeInCache`, never thrown past it. */
class MergeTimedOut extends Error {}

export type MergeMethod = 'fast-forward' | 'squash'

/** A merge, as the request names it. */
export interface MergeRequest {
  /** The ref whose work is merged: a branch (`feature/x`) or any Index ref. */
  source: string
  /** The branch that moves. `main` and `refs/heads/main` both name it. */
  target: string
  method: MergeMethod
  /** The full commit id the target is expected to stand at. Required. */
  expected: string
  /** Squash only: the new commit's message. */
  message?: string
  /** Squash only: the new commit's author, who is also its committer. */
  author?: { name: string; email: string }
}

export type MergeParse = { ok: true; request: MergeRequest } | { ok: false; message: string }

/**
 * Read a merge request's body. Strict, for the reason a seed is: every field
 * ends in a git object or a ref move that cannot be taken back.
 */
export function parseMergeRequest(text: string): MergeParse {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, message: 'the body is not JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'the body must be a JSON object' }
  }
  const fields = body as Record<string, unknown>
  const { source, target, method, expected } = fields
  if (typeof source !== 'string' || source === '') {
    return { ok: false, message: '"source" must name a ref' }
  }
  if (typeof target !== 'string' || target === '') {
    return { ok: false, message: '"target" must name a branch' }
  }
  if (method !== 'fast-forward' && method !== 'squash') {
    return { ok: false, message: '"method" must be "fast-forward" or "squash"' }
  }
  // A full oid and nothing else: an abbreviation or a ref name here would make
  // the compare-and-swap compare against something resolved on this side.
  if (typeof expected !== 'string' || !OID.test(expected)) {
    return {
      ok: false,
      message: '"expected" must be the full commit id the target stands at',
    }
  }
  if (method === 'fast-forward') return { ok: true, request: { source, target, method, expected } }

  const { message, author } = fields
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, message: 'a squash needs "message", a non-empty string' }
  }
  // git refuses a NUL in a commit message, and no other control character but
  // a newline or a tab belongs in one: refused here, as the caller's mistake,
  // rather than met as `commit-tree` failing halfway through the merge.
  if (hasStrayControl(message)) {
    return {
      ok: false,
      message: '"message" may not contain control characters other than a newline or a tab',
    }
  }
  if (typeof author !== 'object' || author === null || Array.isArray(author)) {
    return { ok: false, message: 'a squash needs "author": { name, email }' }
  }
  const { name, email } = author as Record<string, unknown>
  if (!identPart(name) || !identPart(email)) {
    return {
      ok: false,
      message:
        '"author.name" and "author.email" must be non-empty strings without <, > or a newline',
    }
  }
  return {
    ok: true,
    request: { source, target, method, expected, message, author: { name, email } },
  }
}

/** A C0 control character or DEL, other than a newline or a tab. */
function hasStrayControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return true
  }
  return false
}

/** What one merge did, or why it did nothing. */
export type MergeResult =
  | {
      kind: 'merged'
      repo: string
      method: MergeMethod
      source: { ref: string; oid: string }
      /** The target before (`previous`, the expected commit) and after. */
      target: { ref: string; previous: string; oid: string }
      /** The commit the target now stands at. For a fast-forward, the source's. */
      commit: string
      /**
       * What the merge changed on the target, as the compare summarises it —
       * `null` when the summary could not be computed in time, which does not
       * undo a merge that has already landed.
       */
      summary: {
        files: CompareFile[]
        totals: { files: number; additions: number; deletions: number }
        truncated: boolean
      } | null
    }
  /** No Index for this name, or a ref it does not hold. */
  | { kind: 'not-found'; message: string }
  /** The request named something a merge cannot be: a target that is no branch. */
  | { kind: 'invalid'; message: string }
  /** The target is not at `expected`. Nothing was written. */
  | { kind: 'stale'; ref: string; expected: string; actual: string }
  /** Another write to the target won while this one was in flight. */
  | { kind: 'contended'; ref: string; message: string }
  | { kind: 'not-fast-forward'; ref: string }
  /** The target already holds everything the source would bring. */
  | { kind: 'up-to-date'; ref: string }
  /** A squash whose three-way merge conflicts. No markers were written. */
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'unrelated' }
  /**
   * The repository holds a Signer List, so only a listed key may move a ref,
   * and the host holds none.
   */
  | { kind: 'signed'; message: string }
  /** The push's own rules refused it — a size cap, append-only, a deletion. */
  | { kind: 'refused'; message: string }
  /** Building the merge would take longer than `MERGE_BUILD_TIMEOUT_MS`. */
  | { kind: 'too-large' }
  /**
   * The push failed for a reason that is not a rule's: receive-pack or a hook
   * died, the store was unreachable. Nothing is known to have moved; retry.
   */
  | { kind: 'unavailable'; message: string }

export interface MergeOps {
  merge(repo: ResolvedRepo, request: MergeRequest): Promise<MergeResult>
}

export interface MergeDeps {
  store: ObjectStore
  ensureRepo: (repo: ResolvedRepo) => ResolvedRepo
  syncRepo: (repo: ResolvedRepo) => Promise<unknown>
  /** `WALGIT_SIGNER_LISTS`, read once by the caller. */
  signerLists: boolean
  now?: () => Date
}

export function createMergeOps(deps: MergeDeps): MergeOps {
  const now = () => (deps.now ?? (() => new Date()))()
  return {
    async merge(resolved, request) {
      // The Index FIRST, before the Cache is touched: a name nobody has pushed
      // to is a 404 that creates nothing, exactly as a browse of one is.
      const { index, etag } = await loadIndex(deps.store, resolved.repoId)
      if (etag === null) {
        return { kind: 'not-found', message: `there is no repository "${resolved.repoId}"` }
      }

      // The Signer List before anything about the refs: a host merge on a
      // claimed name is refused whatever it would have done, and saying so
      // first is the refusal its caller can act on. `pre-receive` would refuse
      // the push anyway — the host's push carries no certificate — but only
      // after a scratch repository and a three-way merge had been paid for, and
      // in words about a signature the caller never had a chance to make.
      if (deps.signerLists && index.claim) {
        return {
          kind: 'signed',
          message:
            `"${resolved.repoId}" holds a Signer List, so a ref here moves only by a push a listed key signed — ` +
            'the host holds no such key and does not merge on a claimed name. Merge in a clone and push it signed',
        }
      }

      const target = resolveRef(index.refs, request.target)
      if (target === null || OID.test(request.target)) {
        return {
          kind: 'not-found',
          message: `there is no branch ${JSON.stringify(request.target)}`,
        }
      }
      if (!target.startsWith('refs/heads/')) {
        return { kind: 'invalid', message: `${target} is not a branch; a merge moves a branch` }
      }
      const source = resolveRef(index.refs, request.source)
      if (source === null || OID.test(request.source)) {
        return { kind: 'not-found', message: `there is no ref ${JSON.stringify(request.source)}` }
      }
      if (source === target) {
        return { kind: 'invalid', message: 'the source and the target are the same ref' }
      }
      const actual = index.refs[target]!
      if (actual !== request.expected) {
        return { kind: 'stale', ref: target, expected: request.expected, actual }
      }
      const sourceOid = index.refs[source]!

      const repo = deps.ensureRepo(resolved)
      await deps.syncRepo(repo)
      return mergeInCache(deps, repo, request, {
        target,
        source,
        sourceOid,
        when: now(),
      })
    },
  }
}

async function mergeInCache(
  deps: MergeDeps,
  repo: ResolvedRepo,
  request: MergeRequest,
  at: { target: string; source: string; sourceOid: string; when: Date },
): Promise<MergeResult> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-merge-'))
  // No message leaving here names a directory on this machine.
  const scrub = (text: string) =>
    text.trim().replaceAll(scratch, '<merge>').replaceAll(repo.dir, '<repository>')
  const gitDir = path.join(scratch, 'merge.git')
  // Every git call that builds the merge runs under one deadline.
  const deadline = Date.now() + MERGE_BUILD_TIMEOUT_MS
  const timed = async (args: string[], opts: GitOptions = {}) => {
    const res = await gitAsyncWithin(args, deadline - Date.now(), { gitDir, ...opts })
    if (res.timedOut) throw new MergeTimedOut()
    return res
  }
  const run = async (args: string[], opts: GitOptions = {}) => {
    const res = await timed(args, opts)
    if (res.status !== 0) {
      throw new Error(`walgit merge: git ${args[0]} failed: ${scrub(res.stderr)}`)
    }
    return res.stdout
  }
  // `merge-base --is-ancestor`: 0 is yes, 1 is no, and anything else is git
  // failing to walk the history, which is not an answer to the question.
  const isAncestor = async (a: string, b: string) => {
    const res = await timed(['merge-base', '--is-ancestor'], { operands: [a, b] })
    if (res.status === 0) return true
    if (res.status === 1) return false
    throw new Error(`walgit merge: git could not walk the history: ${scrub(res.stderr)}`)
  }
  try {
    await gitAsync(['init', '--bare', '--quiet'], { operands: [gitDir] })
    // Borrow the Cache's objects rather than copy them: the merge reads every
    // object it needs from there, and writes the few it makes (a squash's
    // trees and merged blobs, its commit) here, where `git push` finds them
    // and receive-pack receives them into quarantine like any pack.
    fs.writeFileSync(
      path.join(gitDir, 'objects', 'info', 'alternates'),
      `${path.join(repo.dir, 'objects')}\n`,
    )

    // Peeled to the commit: an annotated tag as the source names a tag object.
    const peel = async (rev: string) => {
      const res = await timed(['rev-parse', '--verify', '--quiet'], {
        operands: [`${rev}^{commit}`],
      })
      const oid = res.stdout.trim()
      return res.status === 0 && OID.test(oid) ? oid : null
    }
    const sourceCommit = await peel(at.sourceOid)
    const targetCommit = await peel(request.expected)
    if (sourceCommit === null || targetCommit === null) {
      return { kind: 'invalid', message: 'the source or the target is not a commit' }
    }

    // Exit 1 with no output is "no common ancestor": two histories, both real.
    // Anything else that is not success is git failing — a missing object, an
    // incomplete Cache — and is not something to tell the caller about their
    // branches.
    const mb = await timed(['merge-base'], { operands: [targetCommit, sourceCommit] })
    if (mb.status === 1 && mb.stdout.trim() === '') return { kind: 'unrelated' }
    if (mb.status !== 0) {
      throw new Error(`walgit merge: git merge-base failed: ${scrub(mb.stderr)}`)
    }

    // Everything the source would bring is already in the target.
    if (await isAncestor(sourceCommit, targetCommit)) {
      return { kind: 'up-to-date', ref: at.target }
    }

    let commit: string
    if (request.method === 'fast-forward') {
      const ff = await isAncestor(targetCommit, sourceCommit)
      if (!ff) return { kind: 'not-fast-forward', ref: at.target }
      commit = sourceCommit
    } else {
      // The three-way merge, as git computes it, with no working tree and no
      // index: `merge-tree --write-tree` writes the result tree and lists the
      // conflicted paths, and exits 1 when there are any. With `-z
      // --name-only --no-messages` the output is the tree, then one path per
      // conflicted file, NUL-separated — never a marker in any file.
      const merged = await timed(
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z'],
        { operands: [targetCommit, sourceCommit] },
      )
      const [tree = '', ...rest] = merged.stdout.split('\0')
      if (merged.status === 1) {
        const paths = [...new Set(rest.filter((name) => name !== ''))]
        return { kind: 'conflict', paths }
      }
      if (merged.status !== 0 || !OID.test(tree)) {
        throw new Error(`walgit merge: git merge-tree failed: ${scrub(merged.stderr)}`)
      }
      const targetTree = (await run(['rev-parse'], { operands: [`${targetCommit}^{tree}`] })).trim()
      if (tree === targetTree) return { kind: 'up-to-date', ref: at.target }

      // Author and committer are the one ident the request named, as a seed's
      // are: the caller asked for this commit, and it should say who did.
      const date = `${Math.floor(at.when.getTime() / 1000)} +0000`
      const message = request.message!.endsWith('\n') ? request.message! : `${request.message}\n`
      commit = (
        await run(['commit-tree', tree, '-p', targetCommit, '-F', '-'], {
          input: message,
          env: {
            GIT_AUTHOR_NAME: request.author!.name,
            GIT_AUTHOR_EMAIL: request.author!.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: request.author!.name,
            GIT_COMMITTER_EMAIL: request.author!.email,
            GIT_COMMITTER_DATE: date,
          },
        })
      ).trim()
    }

    // The push. The lease is the compare-and-swap git holds: receive-pack is
    // told the target's old value is `expected`, so it moves the ref only from
    // there, and the publish in `reference-transaction` refuses it again if
    // the Index has moved. Every refusal a client's push could meet, this
    // push meets in the same words.
    const pushed = await gitAsync(
      [
        'push',
        '--porcelain',
        `--force-with-lease=${at.target}:${request.expected}`,
        repo.dir,
        `${commit}:${at.target}`,
      ],
      { gitDir },
    )
    if (pushed.status !== 0) {
      const refusal = await refusalOf(
        deps,
        repo,
        { target: at.target, expected: request.expected, commit },
        scrub(`${pushed.stdout}\n${pushed.stderr}`),
      )
      // `landed`: the Index already holds this merge's commit, so the push
      // published and failed after — the merge stands, and is answered as one.
      if (refusal !== 'landed') return refusal
    }

    // What the merge changed on the target — the compare's summary of the new
    // commit against the old one, without the diff text. Best-effort: the
    // merge has landed, and a summary that ran out of time must not read as a
    // merge that failed.
    let summary: Extract<MergeResult, { kind: 'merged' }>['summary'] = null
    try {
      const compared = await compareRevs(repo.dir, targetCommit, commit, {
        maxFiles: COMPARE_MAX_FILES,
        maxDiffBytes: 0,
        timeoutMs: MERGE_SUMMARY_TIMEOUT_MS,
      })
      if (compared !== null && typeof compared === 'object') {
        summary = {
          files: compared.files,
          totals: compared.totals,
          truncated: compared.files.length < compared.totals.files,
        }
      }
    } catch {
      summary = null
    }

    return {
      kind: 'merged',
      repo: repo.repoId,
      method: request.method,
      source: { ref: at.source, oid: sourceCommit },
      target: { ref: at.target, previous: request.expected, oid: commit },
      commit,
      summary,
    }
  } catch (err) {
    if (err instanceof MergeTimedOut) return { kind: 'too-large' }
    throw err
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Why the push was refused, in the caller's terms — or `'landed'`, when it was
 * not refused at all.
 *
 * The Index is read again first, because it decides: if it holds this merge's
 * commit the merge published (and something failed after); if the target
 * moved, that is the answer whatever git said, the same 409 a stale
 * expectation gets up front; if a Claim landed since the up-front check, it is
 * the Signer List refusal. Otherwise git's own words decide between a lost race
 * (a lease that no longer holds, a ref another push has locked, the publish's
 * own compare-and-swap), a rule's refusal — passed through as it was written,
 * a hook's `walgit:` line or git's own size-cap refusal — and anything else, which is a failure
 * rather than a verdict and is answered as one.
 */
async function refusalOf(
  deps: MergeDeps,
  repo: ResolvedRepo,
  at: { target: string; expected: string; commit: string },
  output: string,
): Promise<MergeResult | 'landed'> {
  try {
    const { index } = await loadIndex(deps.store, repo.repoId)
    const actual = index.refs[at.target]
    if (actual === at.commit) return 'landed'
    if (actual !== undefined && actual !== at.expected) {
      return { kind: 'stale', ref: at.target, expected: at.expected, actual }
    }
    if (deps.signerLists && index.claim) {
      return {
        kind: 'signed',
        message:
          `"${repo.repoId}" was claimed by a Signer List while this merge was in flight, so a ref here now moves only by a push a listed key signed — ` +
          'merge in a clone and push it signed',
      }
    }
  } catch {
    // The store is what decides; unread, git's words are all there is.
  }
  const lost =
    /stale info|failed to lock|cannot lock|unable to lock|moved under this push|stayed contended|fetch first|non-fast-forward/i
  if (lost.test(output)) {
    return {
      kind: 'contended',
      ref: at.target,
      message: `${at.target} was being moved by another write while this merge was in flight — read it again and retry`,
    }
  }
  // A rule's words: a hook's `walgit:` line, or git's own refusal of a pack
  // over `receive.maxInputSize` — the per-push size cap, which walgit sets on
  // the Cache so an oversized pack is refused before it is read whole.
  const said = output
    .split('\n')
    .map((line) => line.replace(/^remote:\s?/, '').trim())
    .filter((line) => line.startsWith('walgit:') || /pack exceeds maximum allowed size/.test(line))
  if (said.length > 0) return { kind: 'refused', message: said.join(' ') }
  return { kind: 'unavailable', message: `the merge push failed: ${output}` }
}
