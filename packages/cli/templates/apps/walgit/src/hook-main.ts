#!/usr/bin/env bun
/**
 * The single entry point both hooks exec into.
 *
 * Exit codes are the contract with git, and therefore with the client:
 *
 *   - `pre-receive` non-zero  → the push is rejected before any ref moves.
 *   - `reference-transaction prepared` non-zero → git aborts the staged ref
 *     transaction and the push is rejected.
 *   - zero from either → git proceeds, and from `prepared` that means the push
 *     will be acknowledged. Exiting zero without a published WAL entry is the
 *     single failure this project exists to prevent, so every unexpected error
 *     here is fatal rather than logged.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { capabilitiesFrom } from '../shared/capabilities'
import { announceConfigFromEnv } from './announce'
import { appendOnlyEnabled, checkAppendOnly } from './append-only'
import { configuredThreshold, isCompactionDue } from './compact'
import { checkSize, limitsEnforced, limitsOf, liveBytes } from './limits'
import { clearPending, invocationId, markConsumed, readPending, sweepPending } from './pending'
import {
  establishSigner,
  parseRefChanges,
  preReceive,
  publishPush,
  quarantinePack,
  type PublishResult,
} from './push'
import {
  checkSignerAllowed,
  checkSignerList,
  describeSigner,
  gitSignersSource,
  signerListsEnabled,
} from './signers'
import { requireStore, storeFromEnv } from './store-env'
import { loadIndex, type LoadedIndex, type RefChange } from './wal-index'

const hook = process.argv[2]
const phase = process.argv[3]
const gitDir = path.resolve(process.env.GIT_DIR ?? '.')
const repoId = process.env.WALGIT_REPO_ID ?? path.basename(gitDir).replace(/\.git$/, '')

/**
 * Test-only kill points, off unless `WALGIT_FAULT` is set. The fault-injection
 * suite needs to stop the process at named moments on this path; simulating
 * them from outside would race the very window being tested.
 */
function fault(point: string): void {
  if (process.env.WALGIT_FAULT === point) {
    process.stderr.write(`walgit: fault injected at ${point}\n`)
    process.exit(9)
  }
}

/**
 * Test-only widening of the window between `pre-receive` finishing and
 * `reference-transaction` running, off unless `WALGIT_STALL_MS` is set. The
 * hand-off race between two `git-receive-pack` invocations is a real race with
 * a window measured in milliseconds; a test that waits for it to happen by luck
 * is a test that passes for the wrong reason.
 */
async function stall(): Promise<void> {
  const ms = Number(process.env.WALGIT_STALL_MS ?? '')
  if (Number.isFinite(ms) && ms > 0) await Bun.sleep(ms)
}

async function main(): Promise<number> {
  const stdin = await Bun.stdin.text()

  if (hook === 'pre-receive') {
    // Who signed this push, settled here and handed down. It is read in this
    // hook because this is the only one git shows the certificate to — the
    // blob lives in the push's quarantine and is gone by the time the refs
    // move — and it is settled at the TOP because a verdict that turns on the
    // Signer has to be reachable before the upload: reached after it, every
    // push it refused would leave an Orphan behind. It becomes the Provenance
    // the publish records, and the gate's input just below.
    //
    // Fail-open still (docs/adr/0011): a certificate that is missing, stale,
    // malformed or unverifiable, and an `ssh-keygen` that is absent or throws,
    // are all `null` here — and a `null` Signer is the anonymous push walgit
    // accepted before any of this existed. Its one exception is confined to a
    // repository that holds a Signer List, where `null` refuses, because
    // otherwise breaking verification would be how one bypasses the gate.
    //
    // Described here rather than at the one call that judges it, because the
    // publish judges it a second time and the certificate is gone by then: the
    // three-way answer rides down through the pending record.
    const signer = describeSigner(establishSigner())
    const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))

    const quarantineDir = process.env.GIT_QUARANTINE_PATH || process.env.GIT_OBJECT_DIRECTORY
    const store = requireStore()

    // The Index, read at most once for the whole hook and only by a verdict
    // that needs it. Two of them do — ownership needs the list this name
    // already holds, and the size cap needs the repository's current total —
    // and reading it twice would let them judge one push against two different
    // states of the log for no reason either could explain.
    let loaded: LoadedIndex | null = null
    const index = async () => (loaded ??= await loadIndex(store, repoId)).index

    // Ownership, FIRST, and before the store is written to: while a repository
    // holds a Signer List, a push not signed by a listed key is refused
    // (docs/adr/0012). It leads the verdicts because every one below it is
    // about WHAT was pushed, and telling a stranger their push would rewrite a
    // branch — advice they cannot act on, because they may not push here at
    // all — is a refusal that sends them somewhere there is nothing to find.
    //
    // The list that judges is the one that stood BEFORE this push, which is
    // what makes a grant govern the next push rather than its own. Off entirely
    // without the flag, and on an unclaimed name it refuses nothing.
    //
    // Asked here and asked AGAIN at the compare-and-swap that publishes: this
    // answer is read before the pack uploads, so it can be stale by the time
    // the push lands. Here is where a refusal is free; there is where it is
    // true. See `publishPush`.
    if (signerListsEnabled()) {
      const verdict = checkSignerAllowed(
        repoId,
        signer,
        (await index()).claim?.signers ?? null,
        changes,
      )
      if (!verdict.ok) {
        process.stderr.write(`${verdict.message}\n`)
        return 1
      }
    }

    // Append-only, for the same reason at the same moment: a push that will be
    // refused must not cost an object-store write. git's own deny rules run
    // after this hook, so leaving it to them would upload a pack nothing will
    // ever reference.
    if (appendOnlyEnabled()) {
      const verdict = checkAppendOnly(gitDir, repoId, changes)
      if (!verdict.ok) {
        process.stderr.write(`${verdict.message}\n`)
        return 1
      }
    }

    // The Signer List this push WRITES, resolved here for the same reason and
    // at the same moment. Two of its answers refuse the push — a list that is
    // empty, and one walgit cannot read — and both have to be reachable before
    // the upload or every push they refused would leave an Orphan behind. The
    // third answer is the list itself, which rides down to the compare-and-swap
    // that publishes the ref move.
    //
    // Below the gate, deliberately: whether a stranger's list is well-formed is
    // not the answer a stranger needs. Without the flag `refs/walgit/signers`
    // is an ordinary ref like any other.
    let signerList: string[] | null = null
    if (signerListsEnabled()) {
      const verdict = checkSignerList(repoId, changes, gitSignersSource(gitDir))
      if (!verdict.ok) {
        process.stderr.write(`${verdict.message}\n`)
        return 1
      }
      signerList = verdict.signers
    }

    // Size, for the same reason and at the same moment. The pack is in the
    // quarantine and its size is exact, so the answer costs one stat and (only
    // when a repository total is configured) one index read — against the ~37 s
    // an oversized push otherwise spends uploading before the EDGE refuses it
    // with something that reads like a dropped connection. See src/limits.ts.
    // This is a separate OS process git spawns per hook, with its own
    // `process.env` — so the read is here rather than threaded through
    // `PreReceiveContext`, and it is the same derivation the three documents
    // state their caps from.
    const limits = limitsOf(capabilitiesFrom(process.env))
    if (limitsEnforced(limits)) {
      const found = quarantineDir ? quarantinePack(quarantineDir) : null
      const pushBytes = found ? fs.statSync(found.pack).size : 0
      // Skipped for a ref-only push: it adds nothing, so neither cap can move.
      if (pushBytes > 0) {
        const repoBytes = limits.maxRepoBytes === null ? 0 : liveBytes(await index())
        const verdict = checkSize({ repoId, pushBytes, repoBytes, limits })
        if (!verdict.ok) {
          process.stderr.write(`${verdict.message}\n`)
          return 1
        }
      }
    }

    await preReceive({
      store,
      repoId,
      gitDir,
      quarantineDir,
      signer,
      signerList,
    })
    fault('after-upload')
    await stall()
    return 0
  }

  if (hook === 'reference-transaction') {
    const invocation = invocationId()
    const pending = readPending(gitDir, invocation)
    // No pending record for THIS `git-receive-pack` means this ref update did
    // not come from a push — an administrative edit on this node. It has
    // nothing to publish, and publishing it would let a stale cache overwrite
    // the index. A concurrent push's record is invisible here by construction,
    // which is the whole point of keying the record by invocation.
    if (!pending) return 0

    if (phase === 'committed') return 0
    if (phase === 'aborted') {
      if (pending.entry && !pending.consumed) {
        // The uploaded pack is now unreferenced. It is not lost: `findOrphans`
        // recovers it by diffing the WAL prefix against index.json.
        process.stderr.write(`walgit: push rejected; orphaned WAL object ${pending.entry.key}\n`)
        markConsumed(gitDir, invocation)
      }
      // The record is deliberately NOT deleted here: a push whose refs arrive
      // in several transactions still has transactions to come, and a deleted
      // record would make the next one look like an administrative edit — the
      // silent acknowledgement this path exists to prevent. `post-receive` and
      // the sweep clean up.
      return 0
    }
    if (phase !== 'prepared') return 0

    const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
    if (changes.length === 0) return 0

    fault('before-cas')
    const store = requireStore()
    // The pack belongs to the first transaction that publishes; later ones in
    // the same push carry ref changes only — but they carry the same Signer and
    // the same Signer List, because they are the same push. Dropping the Signer
    // here would attribute the first ref of a multi-ref push and silently leave
    // the rest anonymous; dropping the list would lose a claim outright
    // whenever git happened to move the list ref in a later transaction than
    // the one that published the pack. `applyClaim` is what keeps carrying it
    // in every transaction from writing it in the wrong one. The Signer rides
    // along for the third reason: the publish re-asks the ownership question,
    // and a later transaction dropping it would be judged as an anonymous push.
    const toPublish = pending.consumed
      ? {
          entry: null,
          provenance: pending.provenance,
          claim: pending.claim,
          signer: pending.signer,
        }
      : pending
    const result = await publishPush(store, repoId, toPublish, changes, {
      signerLists: signerListsEnabled(),
    })
    if (!result.ok) {
      process.stderr.write(`${publishRefusal(result)}\n`)
      return 1
    }
    if (toPublish.entry) markConsumed(gitDir, invocation)
    fault('after-cas')
    return 0
  }

  if (hook === 'post-receive') {
    // Everything below is best-effort by construction: the push is already
    // acknowledged, so a failure here must be invisible to the client.
    clearPending(gitDir, invocationId())
    sweepPending(gitDir)

    // Ref events, announced here and not from `reference-transaction`, because
    // here is the first moment the push is certainly durable: git only runs
    // this hook once the ref transaction committed, which is only once the
    // compare-and-swap on index.json won. A push that lost it is rejected and
    // never reaches this line, so nobody is ever told about one. See
    // src/announce.ts, which swallows every failure for the same reason the
    // rest of this branch does.
    const events = announceConfigFromEnv()
    if (events) {
      const changes = parseRefChanges(stdin).filter((c) => c.ref.startsWith('refs/'))
      if (changes.length > 0) spawnAnnounce(repoId, changes)
    }
    try {
      const store = storeFromEnv()
      if (!store) return 0
      const { index } = await loadIndex(store, repoId)
      if (!isCompactionDue(index, configuredThreshold())) return 0
      // Detached and disowned: `post-receive` holds the client's connection
      // open until it exits, so this hook must exit now, not when the repack
      // finishes. The lease in `compact.ts` is what keeps two of these from
      // repacking the same repository at once.
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dir, 'compact-main.ts'), gitDir, repoId],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
    } catch (err) {
      process.stderr.write(`walgit: compaction not scheduled: ${(err as Error).message}\n`)
    }
    return 0
  }

  process.stderr.write(`walgit: unknown hook ${hook}\n`)
  return 1
}

try {
  process.exit(await main())
} catch (err) {
  process.stderr.write(`walgit: ${(err as Error).message}\n`)
  process.exit(1)
}

/**
 * What a refused publish says, in the words its own reason earned.
 *
 * The ownership refusal carries its message from the gate rather than being
 * reworded here, because it IS the gate's refusal — reached late, but the same
 * one, and an agent that met it in `pre-receive` yesterday must not have to
 * recognise a second spelling of it today. Calling it a ref conflict would be
 * worse than terse: it would send the pusher to fetch and rebase, which cannot
 * help, and would hide that the name is now held.
 */
function publishRefusal(result: Extract<PublishResult, { ok: false }>): string {
  switch (result.reason) {
    case 'ref-conflict':
      return (
        `walgit: ${result.ref} moved under this push (index has ${result.actual}, ` +
        `push expected ${result.expected}) — fetch and retry`
      )
    case 'not-allowed':
      return result.message
    case 'contended':
      return 'walgit: the write-ahead log stayed contended — retry the push'
  }
}

/**
 * Hand the announcement to a detached process and return.
 *
 * `post-receive` holds the client's connection until it exits, so the
 * announcement must not be awaited here: a fan-out that is slow or unreachable
 * would be paid for by the pusher, on the path this project keeps fast. The
 * refs are passed as one JSON argument — a push moves a handful of them, and
 * the alternative (a pipe to a disowned child) would keep this process alive to
 * write it.
 *
 * A spawn that fails is logged and dropped, like every other failure in
 * `post-receive`: the push is already durable and `index.json` already holds
 * what this would have announced, so a subscriber's next handshake reads it
 * there anyway.
 */
function spawnAnnounce(repo: string, changes: readonly RefChange[]): void {
  try {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'announce-main.ts'), repo, JSON.stringify(changes)],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
  } catch (err) {
    process.stderr.write(`walgit: ref-event announce not spawned: ${(err as Error).message}\n`)
  }
}
