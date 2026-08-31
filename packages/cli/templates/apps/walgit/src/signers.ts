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
 * **This module refuses nothing for being unsigned or unlisted.** Enforcement
 * is a later slice; what is decided here is only whether the list a push WRITES
 * is one walgit can record, and the two answers that are not are both about
 * losing a name rather than defending it:
 *
 *   - an EMPTY list would leave the name claimable by the next stranger, so a
 *     compromised key could give a name away rather than merely keep it;
 *   - an UNREADABLE one would leave an agent believing it holds a name it does
 *     not.
 *
 * Both are refused on claimed and unclaimed repositories alike, because both
 * are wrong before ownership means anything.
 *
 * Off unless the instance turns it on, like append-only beside it: the package
 * ships every capability off, and this one deliberately does not ride
 * `WALGIT_PUSH_CERT_SEED` — a deployment that took signed pushes yesterday must
 * not acquire ownership today as a side effect.
 */

import { isFingerprint } from '../shared/provenance'
import { flagEnabled } from '../shared/policy'
import { SIGNERS_REF, ZERO_OID } from '../shared/protocol'
import { git } from './git'
import type { RefChange } from './wal-index'

/** The env flag an instance sets to give its repositories Signer Lists. */
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

export type SignerListVerdict =
  /** `signers` is the list this push writes, or `null` when it writes none. */
  | { ok: true; signers: string[] | null }
  | { ok: false; kind: 'empty-list' | 'unreadable-list'; message: string }

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

const refuse = (
  repoId: string,
  kind: 'empty-list' | 'unreadable-list',
  why: string,
): SignerListVerdict => ({ ok: false, kind, message: rejectionMessage(repoId, kind, why) })

/**
 * The message a refused list push reads. Product copy, like the append-only
 * one: it states what walgit found, the format it wanted, and the one thing to
 * do next — an agent that cannot act on a refusal has been told nothing.
 */
function rejectionMessage(
  repoId: string,
  kind: 'empty-list' | 'unreadable-list',
  why: string,
): string {
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
