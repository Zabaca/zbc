/**
 * Signer Lists: a name can hold the keys allowed to push to it.
 *
 * A repository's list is an ordinary ref — `refs/walgit/signers` — whose tip
 * commit's tree holds a file named `signers`, one `SHA256:…` fingerprint per
 * line. That the mechanism is a ref settles four things with no new machinery
 * (docs/adr/0012): claiming a free name is pushing it, granting is a commit
 * that adds a line, revoking is a commit that removes one, and reading it is
 * `git ls-remote` or a clone.
 *
 * A commit chain rather than a ref pointing straight at a blob, and that was
 * measured rather than assumed: `git merge-base --is-ancestor <blob> <blob>`
 * exits 128 ("is a blob, not a commit"), and the append-only judge next door
 * reads any non-zero exit as a rewrite — so a blob-valued list could be created
 * once and never edited again. No grants, no revocations.
 *
 * There are two decisions here and they are deliberately separate, because they
 * are asked of different bytes and answer different questions:
 *
 *   - `checkSignerList` judges the list a push WRITES, and refuses two shapes
 *     that are both about LOSING a name rather than defending it — an EMPTY
 *     list, which would leave the name claimable by the next stranger, so a
 *     compromised key could give a name away rather than merely keep it; and an
 *     UNREADABLE one, which would leave an agent believing it holds a name it
 *     does not. Both are refused on claimed and unclaimed repositories alike,
 *     because both are wrong before ownership means anything.
 *   - `checkSignerAllowed` is the gate: while a repository HAS a list, a push
 *     not signed by a listed key is refused. It is pure over the Signer this
 *     push established, the list as it stood BEFORE this push, and the ref
 *     changes — no git, no store, no subprocess.
 *
 * **A grant governs the next push.** The list that judges a push is the one
 * that stood before it, which is what lets a single push move the list and a
 * branch together: the new list applies from the following push. The founding
 * push needs no exception, because an unclaimed name refuses nothing.
 *
 * The gate is fail-open's one exception, and it is confined to a claimed
 * repository (docs/adr/0011, docs/adr/0012). Everywhere else an unestablished
 * Signer is the anonymous push walgit has always accepted; here it refuses,
 * because otherwise breaking verification would be how one bypasses the gate.
 *
 * Off unless the instance turns it on, like append-only beside it: the package
 * ships every capability off, and this one deliberately does not ride
 * `WALGIT_PUSH_CERT_SEED` — a deployment that took signed pushes yesterday must
 * not acquire ownership today as a side effect.
 */

import { isFingerprint } from '../shared/provenance'
import { flagEnabled } from '../shared/policy'
import { SIGNERS_REF, ZERO_OID } from '../shared/protocol'
import { suggestName } from './append-only'
import { git } from './git'
import { certificatePresented, signedPushEnabled, type PushCertEnv } from './push-cert'
import type { RefChange } from './wal-index'

/**
 * The env flag an instance sets to give its repositories Signer Lists.
 *
 * Turn it on beside `WALGIT_PUSH_CERT_SEED`, never without it. The seed is what
 * makes `git-receive-pack` advertise certificates at all, so with the flag on
 * and no seed every push to a claimed name is refused as unsigned and no client
 * can sign its way out — every claimed name on that deployment is unpushable
 * until the seed is set. Deliberately not enforced here: the gate refuses an
 * unestablished Signer precisely so that breaking verification is not the way
 * around it (docs/adr/0012), and an operator who unset the seed has broken
 * verification for everyone. Failing closed is loud and recoverable; failing
 * open would hand every claimed name back to the next stranger.
 */
export function signerListsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagEnabled(env.WALGIT_SIGNER_LISTS)
}

// ── The file ────────────────────────────────────────────────────────────────

export type ParsedList =
  | { ok: true; signers: string[] }
  /** A line that is neither blank, a comment, nor a fingerprint. */
  | { ok: false; line: string; lineNumber: number }

/**
 * Read a `signers` file into the fingerprints it names.
 *
 * Blank lines and `#` comments are ignored, whitespace is trimmed, and
 * duplicates collapse to the first mention — an agent appending a key that is
 * already there has written a list that means what it looks like, not an error.
 *
 * A line that survives all of that and is still not a fingerprint fails the
 * WHOLE list rather than being skipped. Skipping is the tempting reading and it
 * is the dangerous one: a typo'd key would drop out silently, and the agent
 * that pushed it would believe it had granted access it had not. Refusing here
 * costs a retry; the lenient reading costs a name.
 *
 * A comment may trail a fingerprint (`SHA256:… # alice's laptop`), which is
 * free — `#` cannot occur in base64, so the two readings cannot collide.
 */
export function parseSignerList(text: string): ParsedList {
  const signers: string[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const entry = line.slice(0, commentAt(line)).trim()
    if (entry === '') continue
    if (!isFingerprint(entry)) return { ok: false, line: entry, lineNumber: i + 1 }
    if (seen.has(entry)) continue
    seen.add(entry)
    signers.push(entry)
  }
  return { ok: true, signers }
}

const commentAt = (line: string) => (line.includes('#') ? line.indexOf('#') : line.length)

// ── Finding the file ────────────────────────────────────────────────────────

export type SignersFile =
  | { found: true; text: string }
  /** Why not, in the words the refusal message repeats back to the pusher. */
  | { found: false; why: string }

/**
 * Read the `signers` file out of the commit a push points the list ref at.
 *
 * Injected rather than called directly so every decision above it is testable
 * without a repository, a subprocess or a running git — the same seam
 * `push-cert.ts` puts in front of its blob reader and `announce.ts` puts in
 * front of `fetch`.
 */
export type SignersSource = (oid: string) => SignersFile

/**
 * The most a `signers` file walgit will read, in bytes — roughly a thousand
 * keys, which is far past any plausible list and far short of a problem.
 *
 * A cap is not optional here, for two reasons that are both about what the file
 * becomes. The resolved list is copied into `index.json`, the hottest object in
 * the system: it is re-read on every push and re-written in full by every
 * compare-and-swap, so a megabyte attached to it by an anonymous pusher is paid
 * for by every later push to that name, forever, with no way to take it off.
 * And reading an unbounded blob through a subprocess buffer is how a file gets
 * silently TRUNCATED into a list that is not the one the ref holds — which is
 * exactly the "a key drops out and nobody notices" failure the strict parser
 * below exists to prevent. Refusing early is the only reading that cannot lie.
 */
export const MAX_SIGNER_LIST_BYTES = 64 * 1024

/**
 * The real source: `git cat-file`, against the repository the hook runs in.
 *
 * The first call is `--batch-check` over BOTH questions at once — is the tip a
 * commit, and what is at `signers` in its tree — because git answers each input
 * line with `<sha> <type> <size>` or `<input> missing`, so one subprocess
 * distinguishes every failure this can have. That matters more than the
 * subprocess it saves: a refusal that could not tell "you pointed the ref at a
 * blob" from "your commit has no such file" from "your file is too big" would
 * send most of its readers looking in the wrong place, and the message is the
 * only documentation the agent being refused has.
 *
 * The size is read BEFORE the content, and nothing over the cap is read at all.
 * `git()` buffers a subprocess's output, and an oversized read there does not
 * reliably fail — it can return truncated bytes with a zero exit, which would
 * resolve a list the ref does not hold.
 *
 * The pushed objects are still in the quarantine when this runs, which needs no
 * special handling: git puts the quarantine on the hook's object path, so
 * `cat-file` sees them exactly as `merge-base` does in `append-only.ts`.
 */
export function gitSignersSource(gitDir: string): SignersSource {
  return (oid) => {
    const checked = git(['--git-dir', gitDir, 'cat-file', '--batch-check'], {
      input: `${oid}\n${oid}:signers\n`,
    })
    const [tip, file] = checked.stdout.split('\n')
    if (checked.status !== 0 || tip === undefined || file === undefined) {
      return { found: false, why: `git could not read ${SIGNERS_REF} at ${oid}` }
    }

    const tipType = batchCheckType(tip)
    if (tipType !== 'commit') {
      return { found: false, why: `${SIGNERS_REF} points at ${tipType ?? 'no such object'}` }
    }

    const fileType = batchCheckType(file)
    if (fileType === null) return { found: false, why: NO_FILE }
    if (fileType !== 'blob') {
      return { found: false, why: '`signers` in that commit is a directory, not a file' }
    }

    const size = batchCheckSize(file)
    if (size === null) return { found: false, why: NO_FILE }
    if (size > MAX_SIGNER_LIST_BYTES) {
      return {
        found: false,
        why:
          `the \`signers\` file is ${size} bytes, and walgit reads at most ` +
          `${MAX_SIGNER_LIST_BYTES}`,
      }
    }

    const blob = git(['--git-dir', gitDir, 'cat-file', 'blob', `${oid}:signers`])
    // It was there a moment ago and a git object is immutable, so this is a
    // read that failed rather than a file that is absent — and saying "add a
    // `signers` file" to someone who just pushed one is worse than saying
    // nothing.
    if (blob.status !== 0) {
      return { found: false, why: `git could not read the \`signers\` file at ${oid}` }
    }
    return { found: true, text: blob.stdout }
  }
}

const NO_FILE = 'that commit has no file named `signers` in it'

/** `<sha> <type> <size>` → the type; `<input> missing` → `null`. */
function batchCheckType(line: string): string | null {
  const type = line.trim().split(' ')[1]
  return type === undefined || type === 'missing' ? null : type
}

function batchCheckSize(line: string): number | null {
  const size = Number(line.trim().split(' ')[2])
  return Number.isSafeInteger(size) ? size : null
}

// ── The verdict ─────────────────────────────────────────────────────────────

/**
 * Every way a Signer List can refuse a push, across both decisions in this
 * file. One union rather than two so a caller — the hook, a test, a future
 * counter in front of the container — can name a refusal without knowing which
 * of the two questions produced it.
 */
export type RefusalKind =
  /** The push is signed, by a key the repository's list does not name. */
  | 'not-listed'
  /** The push carried no certificate at all, on a name that requires one. */
  | 'unsigned'
  /** It carried one walgit could not turn into a key. */
  | 'unverified'
  /** The list this push writes names nobody. */
  | 'empty-list'
  /** walgit could not read a list out of what this push wrote. */
  | 'unreadable-list'

/** The two halves of it: what `checkSignerList` can say, and what the gate can. */
export type ListRefusal = Extract<RefusalKind, 'empty-list' | 'unreadable-list'>
export type GateRefusal = Extract<RefusalKind, 'not-listed' | 'unsigned' | 'unverified'>

export type SignerListVerdict =
  | {
      ok: true
      /** The list this push writes, or `null` when it writes none. */
      signers: string[] | null
    }
  | { ok: false; kind: ListRefusal; message: string }

/**
 * Judge what a push does to a repository's Signer List, and resolve it.
 *
 * One call answers both questions the caller has — *may this push land* and
 * *what should the Index record* — because they are one reading of one file,
 * and asking twice would let the answer that refuses and the answer that is
 * recorded come from different bytes.
 *
 * A push that does not touch the list ref is `{ ok: true, signers: null }`,
 * which is nearly every push. Deleting the ref is refused as `empty-list`: it
 * leaves the name with no list at all, which is the giving-away this refusal
 * exists to prevent, and is not distinguishable from it by anyone downstream.
 */
export function checkSignerList(
  repoId: string,
  changes: readonly RefChange[],
  read: SignersSource,
): SignerListVerdict {
  // The last one wins, matching what the ref will hold: git applies a push's
  // updates in order, and a push naming one ref twice is a client bug rather
  // than a case with a meaning of its own.
  const moved = changes.filter((c) => c.ref === SIGNERS_REF).at(-1)
  if (!moved) return { ok: true, signers: null }

  if (moved.newOid === ZERO_OID) {
    return refuse(repoId, 'empty-list', `this push deletes ${SIGNERS_REF}`)
  }

  const file = read(moved.newOid)
  if (!file.found) return refuse(repoId, 'unreadable-list', file.why)

  const parsed = parseSignerList(file.text)
  if (!parsed.ok) {
    return refuse(
      repoId,
      'unreadable-list',
      `line ${parsed.lineNumber} is not a key fingerprint: ${JSON.stringify(parsed.line)}`,
    )
  }
  if (parsed.signers.length === 0) {
    return refuse(repoId, 'empty-list', 'the file you pushed names no keys')
  }
  return { ok: true, signers: parsed.signers }
}

const refuse = (repoId: string, kind: ListRefusal, why: string): SignerListVerdict => ({
  ok: false,
  kind,
  message: rejectionMessage(repoId, kind, why),
})

/**
 * The message a refused list push reads. Product copy, like the append-only
 * one: it states what walgit found, the format it wanted, and the one thing to
 * do next — an agent that cannot act on a refusal has been told nothing.
 */
function rejectionMessage(repoId: string, kind: ListRefusal, why: string): string {
  const what =
    kind === 'empty-list'
      ? [
          `An empty Signer List would leave ${repoId} claimable by anyone, which is a`,
          'way to lose the name rather than a way to release it. To hand the name on,',
          'push a list naming the other key; to stop using it, simply stop pushing.',
        ]
      : [
          `walgit could not read a Signer List out of what you pushed to ${SIGNERS_REF},`,
          `so it will not record one: an unreadable list would leave ${repoId} looking`,
          'claimed to you and unclaimed to the host.',
        ]
  return [
    `walgit: refused — ${why}.`,
    '',
    ...what,
    '',
    `A Signer List is a COMMIT on ${SIGNERS_REF} whose tree holds a file named`,
    '`signers`, one SSH key fingerprint per line:',
    '',
    '    # laptop',
    '    SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw',
    '',
    'Blank lines and `#` comments are ignored. A fingerprint is what',
    '`ssh-keygen -lf <key>` prints. List at least two keys if you can: there is no',
    'recovery path for a lost one.',
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * What `pre-receive` could establish about who made this push.
 *
 * Three answers where Provenance has two, and the third one is the reason this
 * type exists. `establishSigner` collapses every failure to `null` because a
 * `null` Signer is a push that lands (docs/adr/0011); on a claimed name the two
 * failures need different words, because *sign your push* and *your signature
 * did not verify* are different things to go and do. An agent handed the first
 * when the second is true re-sends the same failing signature.
 */
export type PushSigner =
  /** A certificate walgit verified, and the key it named. */
  | { kind: 'signed'; fingerprint: string }
  | {
      /** No certificate at all — the anonymous push walgit has always taken. */
      kind: 'unsigned'
      /**
       * Could this push have been signed at all — does the deployment set a
       * nonce seed?
       *
       * It changes no verdict and one sentence. With no seed `git-receive-pack`
       * never advertises the capability, so "push with `--signed=yes`" is
       * advice the pusher's own git refuses, and a claimed name on such a
       * deployment refuses everyone including whoever holds it. The gate still
       * refuses — failing open here is precisely the bypass ADR-0012 closes —
       * but the refusal names the misconfiguration instead of sending an agent
       * to retry something that cannot work.
       */
      signable: boolean
    }
  /**
   * A certificate walgit could not turn into a key: bad nonce, bad signature,
   * missing or throwing verifier.
   */
  | { kind: 'unverified' }

/**
 * Read the two answers together: the Signer `establishSigner` settled, and —
 * only when it settled nothing — whether there was a certificate to settle.
 *
 * The env read is deliberately second and deliberately narrow. Who signed is
 * still `establishSigner`'s answer and nothing here revisits it; this only
 * chooses which sentence an unestablished Signer is told.
 */
export function describeSigner(signer: string | null, env: PushCertEnv = process.env): PushSigner {
  if (signer !== null) return { kind: 'signed', fingerprint: signer }
  if (certificatePresented(env)) return { kind: 'unverified' }
  return { kind: 'unsigned', signable: signedPushEnabled(env) }
}

export type SignerGateVerdict = { ok: true } | { ok: false; kind: GateRefusal; message: string }

/**
 * May this push land, given who signed it and the list this name already holds?
 *
 * Pure over its three inputs, with no git, no store and no subprocess in reach:
 * the list arrives already resolved from the Index (`WalIndex.claim`), which is
 * what keeps ownership from depending on the Cache being materialized.
 *
 * `claimed` is **the list as it stood BEFORE this push**, and that is the whole
 * of the grant rule: a push may move the list and a branch together, and the
 * list it installs applies from the following push. The founding push needs no
 * exception written for it, because an unclaimed name refuses nothing.
 *
 * **The Index is what enforces, and the ref is what is authoritative** — the
 * gap ADR-0012 leaves to this slice, answered rather than hidden. The derived
 * copy is maintained only while the flag is on, so a list pushed before it was
 * turned on, or a list ref moved while it was off, leaves the two disagreeing:
 * a name the ref says is claimed refuses nothing until its list is pushed
 * again, and a name whose list moved while the flag was off is judged by the
 * one the Index still holds. Neither is re-derived from the other, because
 * re-deriving means reading a git object out of the Cache — and the Cache is
 * disposable, which would make ownership depend on a node having materialized
 * it. The rule for an operator is the short one: turn the flag on before anyone
 * writes a list, and leave it on.
 *
 * An unclaimed name is `null`. An empty array is read as unclaimed too, and the
 * asymmetry with `checkSignerList` — which refuses writing one — is the point:
 * a list naming nobody cannot be written, so reaching one here means the Index
 * disagrees with what this code can produce, and the two readings of that are
 * "the name is open, as it was before anyone claimed it" and "the name is
 * bricked, for everyone, forever". Only one of those has a way back.
 */
export function checkSignerAllowed(
  repoId: string,
  signer: PushSigner,
  claimed: readonly string[] | null,
  changes: readonly RefChange[],
): SignerGateVerdict {
  if (claimed === null || claimed.length === 0) return { ok: true }
  if (signer.kind === 'signed' && claimed.includes(signer.fingerprint)) return { ok: true }
  return {
    ok: false,
    kind: signer.kind === 'signed' ? 'not-listed' : signer.kind,
    message: heldMessage(repoId, signer, changes),
  }
}

/**
 * The message a stranger reads, and the only place most agents will ever learn
 * that Signer Lists exist.
 *
 * Ownership's failure lands on our server, in our words, at the moment it is
 * relevant — which is why the terse front door does not have to carry it
 * (docs/adr/0012). So this says three things and an agent can act on each: the
 * name is held, here is a free one to use instead, and here is how to be added
 * to this one.
 */
function heldMessage(repoId: string, signer: PushSigner, changes: readonly RefChange[]): string {
  const why =
    signer.kind === 'signed'
      ? [
          `Your push is signed by ${signer.fingerprint}, and ${repoId}'s Signer List does`,
          'not name that key.',
        ]
      : signer.kind === 'unsigned'
        ? signer.signable
          ? [
              'Your push carries no signature, so walgit cannot tell whose it is. A name',
              'that holds a Signer List takes signed pushes only:',
              '',
              '    git push --signed=yes origin HEAD:refs/heads/<branch>',
            ]
          : [
              'Your push carries no signature, and this host is not advertising signed',
              'pushes at all — so no push can satisfy this name, including the one that',
              'claimed it. That is a misconfiguration here, not something you can fix:',
              'whoever runs this host has set WALGIT_SIGNER_LISTS without setting',
              'WALGIT_PUSH_CERT_SEED. Push to a free name, and tell them.',
            ]
        : [
            'Your push carries a certificate walgit could not verify — a stale nonce, or a',
            'signature it could not check. A claimed name does not fall back to an',
            'anonymous push, so re-run the same `git push --signed=yes` to get a fresh',
            'nonce; if it keeps failing, `ssh-keygen -Y check-novalidate` is what walgit',
            'runs.',
          ]
  const refs = describeRefs(changes)
  return [
    `walgit: refused — ${repoId} is held by a Signer List.`,
    '',
    ...(refs === null ? [] : [`This push would have written ${refs}.`]),
    ...why,
    '',
    `${repoId} names the keys that may push to it on ${SIGNERS_REF} — anyone can`,
    'read it, and reads are not gated. Any name nobody has claimed is still free.',
    '',
    'What you can do instead:',
    `  - push to a free name:  git remote set-url origin <same-host>/${suggestName(repoId)}.git`,
    `  - or be added to this one: a listed key pushes a commit on ${SIGNERS_REF}`,
    '    whose `signers` file gains the line `ssh-keygen -lf <your-key>` prints.',
    '    A grant governs the NEXT push, so retry once theirs has landed.',
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

/**
 * The refs this push would have written, named rather than counted: an agent
 * pushing several branches at once needs to know the refusal took all of them.
 * Truncated past three, because past three the list stops being read.
 *
 * `null` for a push naming none, which git does not send and which the sentence
 * is therefore left out of entirely — "this push would have written nothing" is
 * a line that can only confuse whoever manages to read it.
 */
function describeRefs(changes: readonly RefChange[]): string | null {
  const refs = changes.map((c) => c.ref)
  if (refs.length === 0) return null
  if (refs.length <= 3) return refs.join(', ')
  return `${refs.slice(0, 3).join(', ')} and ${refs.length - 3} more`
}
