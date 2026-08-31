/**
 * Push provenance: the decidable half.
 *
 * A signed push arrives with a **push certificate** — a small text document
 * naming the pusher, the pushee, the nonce this server issued and every ref the
 * push moves, followed by an armoured SSH signature over everything above it
 * (docs/adr/0011 in the zbc repository). walgit reads it, records the key that
 * signed it as that ref's **Signer**, and refuses nothing on the strength of it
 * — except where the repository holds a Signer List and the instance enforces
 * one, which is the gate in `src/signers.ts` and nothing this module decides.
 *
 * Verification cannot use git's own verdict. `git-receive-pack` checks a
 * certificate with GPG unless told otherwise, so an SSH signature reaches the
 * hook as `GIT_PUSH_CERT_STATUS=N` — "no signature" — with `GIT_PUSH_CERT_KEY`
 * and `GIT_PUSH_CERT_SIGNER` both empty. Configuring git for SSH instead does
 * not help: it then demands `gpg.ssh.allowedSignersFile`, a registry of keys
 * allowed to sign, which is precisely the thing this design refuses to have.
 * `ssh-keygen -Y check-novalidate` answers the only question walgit asks — *is
 * this signature good, and which key made it* — with no registry of any kind.
 *
 * What lives here is what is decidable without a keypair, a subprocess or a
 * running git: where the signed bytes end and the signature begins, and which
 * key a verifier's output names. Running the verifier is `src/push-cert.ts`'s,
 * because a subprocess is a runtime and `shared/` has none (ADR-0010).
 */

/**
 * The signature namespace, and it is load-bearing rather than decorative.
 *
 * `ssh-keygen -Y` binds every signature to a namespace and refuses to verify it
 * under any other one ("namespace does not match"). git signs a push
 * certificate under `git`; an SSH authentication handshake is signed under a
 * different namespace entirely. Verifying under `git` is therefore what stops a
 * push signature being replayable as a login, and a verifier that omitted the
 * namespace would silently accept signatures made for something else.
 */
export const PUSH_CERT_NAMESPACE = 'git'

const BEGIN_SIGNATURE = '-----BEGIN SSH SIGNATURE-----'
const END_SIGNATURE = '-----END SSH SIGNATURE-----'

export interface SplitCertificate {
  /**
   * Exactly the bytes the pusher signed: the certificate up to, and not
   * including, the signature block. Byte-exact matters — a stripped trailing
   * newline or a normalized line ending verifies as a forgery.
   */
  body: string
  /** The armoured signature block, as `ssh-keygen -Y … -s <file>` takes it. */
  signature: string
}

/**
 * Split a push certificate into the bytes that were signed and the signature
 * over them, or `null` when the text is not one.
 *
 * git appends the armour to the payload it signed, so the split is positional
 * and needs no parse of the certificate's fields: everything before the BEGIN
 * line is the message, everything from it is the signature. Nothing above the
 * line is interpreted here on purpose — the `pusher` field carries a
 * fingerprint, but it is the *claim* being verified, so believing it would make
 * the signature ornamental.
 *
 * `null` for anything malformed: no armour, no terminator, or a signature with
 * no message under it. The caller records no Signer and accepts the push.
 */
export function splitPushCertificate(text: string): SplitCertificate | null {
  const begin = text.indexOf(BEGIN_SIGNATURE)
  if (begin === -1) return null
  const end = text.indexOf(END_SIGNATURE, begin)
  if (end === -1) return null
  const body = text.slice(0, begin)
  if (body.trim() === '') return null
  // Re-terminated rather than sliced to the end of the text: whatever follows
  // the armour is not signature, and `ssh-keygen` wants the file newline-ended.
  return { body, signature: `${text.slice(begin, end + END_SIGNATURE.length)}\n` }
}

/**
 * An SSH key fingerprint as `ssh-keygen` prints it: `SHA256:` and 43 characters
 * of unpadded base64 (a 256-bit digest). Anchored on neither side, because the
 * verifier writes it inside a sentence:
 *
 *     Good "git" signature with ED25519 key SHA256:BMBEMXbMBsnj…
 *
 * and the wording around it differs between OpenSSH releases while the
 * fingerprint's spelling has not.
 */
const FINGERPRINT = /SHA256:[A-Za-z0-9+/]{43}/

/** The same spelling, anchored — for text that must be nothing else. */
const FINGERPRINT_ONLY = new RegExp(`^${FINGERPRINT.source}$`)

/**
 * Is this text a fingerprint and nothing but one?
 *
 * The Signer List is a file of these, one per line (docs/adr/0012), and it is
 * read strictly: a line that is not exactly a fingerprint makes the whole list
 * unreadable rather than being skipped. Dropping it silently would let a typo
 * cost an agent a key it believes is listed, which is the failure that decision
 * exists to prevent — so this asks the whole-string question, and it is built
 * from the same source as `fingerprintIn` so the two can never disagree about
 * what a fingerprint looks like.
 */
export function isFingerprint(text: string): boolean {
  return FINGERPRINT_ONLY.test(text)
}

/**
 * The key a verifier's output names, or `null` when it names none.
 *
 * Deliberately not a verdict: whether the signature was *good* is the
 * verifier's exit status, which the caller checks before it gets here. This
 * answers only "which key", and answering `null` is how output that verified
 * something but named nothing recognisable records no Signer instead of
 * recording something wrong.
 */
export function fingerprintIn(verifierOutput: string): string | null {
  return FINGERPRINT.exec(verifierOutput)?.[0] ?? null
}

/**
 * The configured seed, or `null` for "this deployment does not take signed
 * pushes".
 *
 * Blank reads as unset, the same collapse `containerEnv` makes at the seam and
 * `positiveNumber` makes for the size caps: a variable cleared to an empty
 * string is a capability turned off, not a capability seeded with nothing. git
 * would take `""` as a seed and derive perfectly usable nonces from it, so the
 * two spellings have to collapse here rather than at the config write.
 *
 * It takes the raw variable rather than an environment, like `flagEnabled` and
 * `positiveNumber` beside it, because the two halves do not have the same
 * environment to hand it: the container has `process.env` and the Worker has a
 * binding object. What they must share is the reading, and that is this.
 */
export function pushCertSeed(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const seed = raw.trim()
  return seed === '' ? null : seed
}

/**
 * Does this deployment take signed pushes? The seed, read as a yes/no.
 *
 * This is what both agent-facing documents render from, and rendering from it
 * is the whole discipline: with no seed, `git-receive-pack` never advertises
 * `push-cert` and a client asking to sign is refused by its own git — so a
 * page that offered signing there would send an agent to a flag that cannot
 * work, which is the same defect as a stated cap nothing enforces.
 */
export function signedPushEnabled(raw: string | undefined): boolean {
  return pushCertSeed(raw) !== null
}
