/**
 * The push path: upload, then publish.
 *
 * This is the one file where being wrong loses data, so the ordering is stated
 * plainly and never varies:
 *
 *   1. `pre-receive` — the pushed objects sit in `$GIT_QUARANTINE_PATH` and are
 *      visible to nobody. Upload the packfile to the WAL. Uploading does NOT
 *      publish it: `index.json` is untouched, so a crash here leaves an
 *      unreferenced object and a client that saw a failure.
 *   2. `reference-transaction prepared` — git has the ref update staged but not
 *      committed. Compare-and-swap `index.json`. Winning is what makes the push
 *      real; exit 0 and git commits the ref locally and acknowledges. Losing
 *      must exit non-zero, which aborts the transaction and rejects the push.
 *
 * The invariant the whole design exists to hold: no acknowledgement before the
 * WAL entry is published. A hook that swallows a failure and exits 0 breaks it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { ZERO_OID } from '../shared/protocol'
import { walKey } from './keys'
import { writePending, type PendingPush } from './pending'
import { certSigner } from './push-cert'
import { checkSignerAllowed, describeSigner, type GateRefusal, type PushSigner } from './signers'
import type { ObjectStore } from './store'
import { ulid } from './ulid'
import {
  applyClaim,
  applyProvenance,
  applyRefChanges,
  commitIndex,
  loadIndex,
  nextIndex,
  sha256,
  type Claim,
  type Provenance,
  type PushRecord,
  type RefChange,
  type WalEntry,
  type WalIndex,
} from './wal-index'

/**
 * Parse the `<old-oid> SP <new-oid> SP <refname>` lines both hooks are fed.
 * The refname is taken verbatim to the end of the line: it may contain spaces.
 */
export function parseRefChanges(stdin: string): RefChange[] {
  const changes: RefChange[] = []
  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue
    const match = /^(\S+) (\S+) (.+)$/.exec(line.replace(/\r$/, ''))
    if (!match) throw new Error(`unparseable ref change: ${JSON.stringify(line)}`)
    changes.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! })
  }
  return changes
}

/**
 * The quarantine's packfile, or null when the push carried no objects.
 *
 * `.keep` is never uploaded — it is local bookkeeping telling git not to repack
 * that pack, and it means nothing anywhere else. `.idx` and `.rev` are
 * derivable from the `.pack`, but uploading them costs little and saves a
 * restore from having to run `git index-pack` over every entry.
 */
export function quarantinePack(quarantineDir: string): { pack: string; idx: string | null } | null {
  const dir = path.join(quarantineDir, 'pack')
  if (!fs.existsSync(dir)) return null
  const pack = fs.readdirSync(dir).find((f) => f.endsWith('.pack'))
  if (!pack) return null
  const idx = pack.replace(/\.pack$/, '.idx')
  return {
    pack: path.join(dir, pack),
    idx: fs.existsSync(path.join(dir, idx)) ? path.join(dir, idx) : null,
  }
}

/**
 * The Signer this push establishes, or `null` for "nobody, as far as walgit can
 * tell" — computed once, by the caller, before anything is written.
 *
 * The reader is injected the way `announce`'s `fetchImpl` is: the default reads
 * git's own environment and shells out to `ssh-keygen`, so every decision
 * downstream of this stays testable without a keypair, a subprocess or a
 * running git.
 *
 * The catch is unconditional and it is the fail-open rule itself: a reader that
 * throws is a push with no Signer, not a push with an error (docs/adr/0011).
 * `certSigner` already swallows its own failures, so today this guards the seam
 * rather than the default — but the guarantee belongs to the seam, not to
 * whoever happens to be plugged into it, and the caller is `hook-main`, where an
 * escaping throw is fatal to the push.
 */
export function establishSigner(signer: () => string | null = certSigner): string | null {
  try {
    return signer()
  } catch {
    return null
  }
}

export interface PreReceiveContext {
  store: ObjectStore
  repoId: string
  gitDir: string
  quarantineDir: string | undefined
  now?: () => Date
  /**
   * Who made this push, as `describeSigner(establishSigner())` already answered
   * it — a value and not a thunk. The hook settles the question above this call
   * because a verdict that turns on the Signer has to be able to run before the
   * upload; by the time this function runs there is nothing left to ask.
   *
   * The three-way `PushSigner` rather than the fingerprint alone, because the
   * fingerprint is only what the Index records. The other two answers — no
   * certificate, and a certificate that did not verify — are what a REFUSAL has
   * to be able to tell apart, and the certificate itself is gone by the time
   * the publish runs: it lives in the push's quarantine, and `pre-receive` is
   * the only hook git shows it to. So it is read once here and written down.
   *
   * Required. Optional, it would read as "unsigned" to the compiler and as
   * "forgotten" to nobody — a call site that dropped it would record no
   * Provenance for a push that carried a perfectly good certificate, and
   * typecheck.
   */
  signer: PushSigner
  /**
   * The Signer List this push writes, already resolved by the hook, or `null`
   * when it writes none (docs/adr/0012).
   *
   * Optional, where `signer` beside it is required, and the asymmetry is real
   * rather than an oversight: every push has an answer to "who signed this", so
   * a forgotten argument there would silently discard a good one. Nearly no
   * push has an answer to "what list does this write", so the default IS the
   * answer for every caller that has nothing to say — and the one caller that
   * does is the hook, which had to resolve it before the upload anyway.
   */
  signerList?: readonly string[] | null
}

/**
 * Upload the pushed pack and record it as pending. Nothing is published.
 *
 * The sequence number in the key is a GUESS — the index's current seq plus one
 * — because the real one is only decided when the compare-and-swap lands. It
 * is right in the common case and merely cosmetic when it is wrong: the ULID
 * keeps the key unique, and `index.json` carries the authoritative key for
 * every entry, so a mis-numbered key is never followed by anything.
 *
 * The Signer arrives already established (`ctx.signer`) rather than being read
 * here: the hook has to hold it before it reaches this function, because a
 * verdict that needs it and is reached after the upload would leave an Orphan
 * behind every push it refused.
 */
export async function preReceive(ctx: PreReceiveContext): Promise<void> {
  const now = ctx.now ?? (() => new Date())
  const signer = ctx.signer
  // One reading of the clock for the whole function, because all of it
  // describes one push: the WAL entry, the Signer and the list that push wrote
  // would otherwise be stamped milliseconds apart for no reason anyone reading
  // them back could account for.
  const at = now()
  const ts = at.toISOString()
  // Only a VERIFIED key becomes Provenance. The other two answers are things
  // walgit could not establish, and the Index states what it knows.
  const provenance: Provenance | null =
    signer.kind === 'signed' ? { signer: signer.fingerprint, ts } : null
  // `length` and not truthiness: an empty array is truthy, and recording an
  // empty list is the state `src/signers.ts` refuses a push for reaching.
  const claim: Claim | null = ctx.signerList?.length ? { signers: [...ctx.signerList], ts } : null
  // `signer` unconditionally, unlike the two beside it: the publish re-asks the
  // ownership question and needs the answer whatever it was, including the two
  // shapes that record nothing.
  const recorded = { signer, ...(provenance ? { provenance } : {}), ...(claim ? { claim } : {}) }
  const found = ctx.quarantineDir ? quarantinePack(ctx.quarantineDir) : null
  if (!found) {
    // A ref-only push (a delete, or a branch pointed at an object the server
    // already has) is legitimate and still has to publish its ref change — and
    // its provenance: a branch pointed at objects the repository already has
    // moves a ref, and is signed like any other push. A list ref pointed at a
    // commit the repository already holds is the same case.
    writePending(ctx.gitDir, { entry: null, ...recorded })
    return
  }

  const { index } = await loadIndex(ctx.store, ctx.repoId)
  const id = ulid(at.getTime())
  const packBody = new Uint8Array(fs.readFileSync(found.pack))
  const key = walKey(ctx.repoId, index.seq + 1, id, 'pack')

  await ctx.store.put(key, packBody)
  if (found.idx) {
    await ctx.store.put(
      walKey(ctx.repoId, index.seq + 1, id, 'idx'),
      new Uint8Array(fs.readFileSync(found.idx)),
    )
  }

  const entry: Omit<WalEntry, 'seq'> = {
    key,
    kind: 'push',
    size: packBody.byteLength,
    sha256: sha256(packBody),
    ts,
  }
  writePending(ctx.gitDir, { entry, ...recorded })
}

export type PublishResult =
  | { ok: true; index: WalIndex }
  /** Another push published first and moved a ref this one is updating. */
  | { ok: false; reason: 'ref-conflict'; ref: string; expected: string; actual: string }
  /** Lost every compare-and-swap attempt against an index that kept moving. */
  | { ok: false; reason: 'contended' }
  /**
   * The name was claimed while this push uploaded, and the list that now stands
   * does not name the key that signed it. Carries the gate's own message,
   * because a refusal reached here is the same refusal `pre-receive` makes and
   * has to read like one.
   */
  | { ok: false; reason: 'not-allowed'; kind: GateRefusal; message: string }

export interface PublishOptions {
  /** How many compare-and-swap attempts before giving up. */
  attempts?: number
  /**
   * Re-ask the ownership question at the compare-and-swap, against the Index
   * this attempt is publishing onto. On exactly when the deployment has Signer
   * Lists on — the caller passes `signerListsEnabled()` rather than this file
   * reading the environment, so the gate and the flag that governs it are
   * settled in one place (`hook-main`), for both askings.
   */
  signerLists?: boolean
}

/**
 * Who made this push, as the pending record can still describe them.
 *
 * `pre-receive` writes the full three-way answer down, because the certificate
 * is gone by the time this runs and *sign your push* and *your signature did
 * not verify* are different things to go and do. A record written without one
 * is read back from the Provenance it did record: that recovers a listed key
 * exactly — which is the only answer that lets a push LAND — and collapses the
 * two failures into whichever of them the environment still shows.
 */
function pendingSigner(pending: PendingPush): PushSigner {
  return pending.signer ?? describeSigner(pending.provenance?.signer ?? null)
}

/**
 * Is the list the Index holds the one THIS push installed?
 *
 * git updates refs one transaction at a time unless the client asked for
 * `--atomic`, so a push moving the list and a branch together publishes across
 * several compare-and-swaps — and once the first has landed, the Index holds
 * this push's own list. Re-asking the gate against it would break the grant
 * rule for the one shape that rule exists for: a push may move the list and a
 * branch together, and the list it installs applies from the FOLLOWING push.
 * The founding push that lists somebody else's key would refuse its own branch,
 * and a revocation that removes the pusher would refuse the rest of itself.
 *
 * The whole `Claim` is the identity, timestamp and all: `pre-receive` reads the
 * clock once for a push, so no other push can have written this exact value,
 * and one that raced this one for a free name lost the list ref outright — the
 * ref-conflict check above is what refused it, before this could be asked.
 */
function claimIsThisPush(index: WalIndex, pending: PendingPush): boolean {
  const own = pending.claim
  const held = index.claim
  if (!own || !held || own.ts !== held.ts) return false
  return (
    own.signers.length === held.signers.length && own.signers.every((s, i) => s === held.signers[i])
  )
}

/**
 * Publish the pending entry with the push's ref changes, under CAS.
 *
 * Retry is here rather than inside `commitIndex`, and it is guarded: every
 * attempt re-reads the index and re-checks that each ref this push updates
 * still holds the old oid git computed the update against. Retrying without
 * that check would publish a ref state derived from an index that no longer
 * exists, which is exactly the acknowledgement-of-a-lost-race this project
 * exists to prevent. A conflict is final — the client must fetch and rebase.
 *
 * `index.json` is the source of truth for that check, not the local ref: a
 * local ref disagreeing with the index is a stale cache, and reconcile's job.
 *
 * Ownership is re-asked here too, and it is the one verdict that is. See the
 * comment on the call below for why that is not a general rule.
 */
export async function publishPush(
  store: ObjectStore,
  repoId: string,
  pending: PendingPush,
  changes: readonly RefChange[],
  options: PublishOptions = {},
): Promise<PublishResult> {
  const attempts = options.attempts ?? 5
  for (let i = 0; i < attempts; i += 1) {
    const { index, etag } = await loadIndex(store, repoId)

    for (const change of changes) {
      const actual = index.refs[change.ref] ?? ZERO_OID
      if (actual !== change.oldOid) {
        return {
          ok: false,
          reason: 'ref-conflict',
          ref: change.ref,
          expected: change.oldOid,
          actual,
        }
      }
    }

    // Ownership, asked a SECOND time — the gate already ran in `pre-receive`,
    // and it ran there against an Index read before the pack uploaded. For a
    // real repository that upload is seconds, not microseconds, and a name that
    // was free when the push was judged can be claimed before it publishes.
    // Landing it anyway is a permanent stranger-write, because agentgit is
    // append-only: exactly the thing docs/adr/0012 exists to prevent, arriving
    // in the one moment that design says needs no exception.
    //
    // `index.claim` is the list as it stood BEFORE this push applies its own —
    // `applyClaim` installs that in `next`, below — which is both the gate's
    // own rule (a grant governs the NEXT push) and what lets the founding push
    // through its own re-check. Written against the post-apply value this would
    // refuse every claim ever made — and `claimIsThisPush` is the same rule for
    // the LATER transactions of one push, whose earlier one already applied it.
    //
    // BELOW the ref-conflict check, the opposite order to `pre-receive`'s, and
    // deliberately: a second claim racing this one moves the same ref and is
    // already answered above, in the words any contended ref gets. What reaches
    // this line is a push with no ref conflict to catch it, which is the whole
    // of the exposure.
    //
    // This is a refusal AFTER the upload, which the `pre-receive` placement
    // exists to avoid — and it cannot be moved earlier, because the race is
    // precisely that the earlier answer went stale. The orphaned pack is the
    // accepted cost: `findOrphans` reclaims exactly this shape, and the
    // `aborted` branch in `hook-main` names the key it left behind.
    //
    // Narrow on purpose, and not the start of a rule that every verdict is
    // re-run here. Append-only and the size caps judge what was PUSHED, which
    // cannot change underneath the push. Ownership judges the REPOSITORY, which
    // can.
    if (options.signerLists && !claimIsThisPush(index, pending)) {
      const verdict = checkSignerAllowed(
        repoId,
        pendingSigner(pending),
        index.claim?.signers ?? null,
        changes,
        'publish',
      )
      if (!verdict.ok) {
        return { ok: false, reason: 'not-allowed', kind: verdict.kind, message: verdict.message }
      }
    }

    // A ref-only push bumps no sequence number and appends no entry: there is
    // no log record to append, only new ref state. Keeping seq contiguous with
    // the entry list is what lets a restore trust `entries` by itself.
    //
    // Both records ride on BOTH branches, which is why they are fields on the
    // Index and not on a WAL entry: a ref-only push has no entry to hang them
    // from and is exactly as signed, and exactly as much a claim, as any other.
    const record: PushRecord = {
      provenance: pending.provenance ?? null,
      claim: pending.claim ?? null,
    }
    const next = pending.entry
      ? nextIndex(index, pending.entry, changes, record)
      : {
          ...index,
          refs: applyRefChanges(index.refs, changes),
          provenance: applyProvenance(index.provenance, changes, record.provenance),
          claim: applyClaim(index.claim, changes, record.claim),
        }

    const result = await commitIndex(store, next, etag)
    if (result.ok) return { ok: true, index: next }
  }
  return { ok: false, reason: 'contended' }
}
