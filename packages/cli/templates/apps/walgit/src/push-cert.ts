/**
 * Signed pushes: the one seed the capability hangs off.
 *
 * A push certificate is a claim about *who moved this ref*, signed by the
 * pusher and carrying a nonce this server issued (docs/adr/0011). Everything
 * about it is a `receive-pack` capability rather than a transport feature —
 * which is why it works over smart-HTTP with no SSH anywhere (ADR-0008) — and
 * `git-receive-pack` advertises that capability if, and only if, the receiving
 * repository has `receive.certNonceSeed` set. With no seed a client asking for
 * `--signed=yes` is refused by its OWN git, before a byte reaches the network:
 * `fatal: the receiving end does not support --signed push`. That refusal is
 * the correct answer for a deployment that has not turned provenance on, and it
 * is why this needs no flag of its own — the seed IS the flag.
 *
 * Configuration, never generated. The nonce is an HMAC of the seed and a
 * timestamp, and a client holds one across the round trip between advertisement
 * and push. The container's disk is a cache that is wiped on every restart
 * (ADR-0007), so a seed minted at boot would be a different seed on the other
 * side of a restart and would reject every certificate in flight. It therefore
 * arrives as an environment variable, and joins the forward list in
 * `shared/container-env.ts` like every other value the container boots with.
 *
 * The seed turns the capability on; the second half of this file is what walgit
 * then does with a certificate — read it, verify it itself, and name the key
 * that signed it. It refuses nothing on the strength of that: a signed push
 * lands exactly as an unsigned one does, and every way this can go wrong
 * records no Signer rather than failing the push. See `shared/provenance.ts`
 * for why git's own verdict on the signature is unusable.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  fingerprintIn,
  PUSH_CERT_NAMESPACE,
  pushCertSeed as seedFrom,
  splitPushCertificate,
  type SplitCertificate,
} from '../shared/provenance'
import { git } from './git'

/**
 * The seed this deployment configures, or `null` when it configures none.
 *
 * The reading itself lives in `shared/provenance.ts`: the Worker renders both
 * agent-facing documents from the same answer and cannot import this module at
 * all (it spawns a subprocess, and `shared/` has no runtime — ADR-0010). A
 * document that advertised signed pushes from a second reading of the variable
 * would be one spelling away from promising a capability the push path does
 * not have, which is the exact drift `flagEnabled` was extracted to end. What
 * stays here is only where the container finds it.
 */
export function pushCertSeed(env: Record<string, string | undefined> = process.env): string | null {
  return seedFrom(env.WALGIT_PUSH_CERT_SEED)
}

/** Does this instance take signed pushes? The seed, read as a yes/no. */
export function signedPushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return pushCertSeed(env) !== null
}

// ── Reading the certificate, and verifying it ───────────────────────────────

/**
 * What `git-receive-pack` leaves for the hook, as this module reads it.
 *
 * Only two of the seven `GIT_PUSH_CERT_*` variables are used, and the five
 * omitted ones are omitted for one reason each: `_SIGNER`, `_KEY` and `_STATUS`
 * are git's own GPG verdict, which is `N` for every SSH signature (see
 * `shared/provenance.ts`); `_NONCE` is the value whose verdict `_NONCE_STATUS`
 * already is.
 */
export interface PushCertEnv {
  /** Blob object name of the certificate, readable with `git cat-file`. */
  GIT_PUSH_CERT?: string | undefined
  /** `OK`, `SLOP`, `MISSING`, `BAD` or `UNSOLICITED`. Only `OK` counts. */
  GIT_PUSH_CERT_NONCE_STATUS?: string | undefined
  /** Open, so `process.env` — an index signature and nothing else — fits it. */
  [name: string]: string | undefined
}

/** Verify a split certificate and name the key that signed it, or `null`. */
export type CertVerifier = (cert: SplitCertificate) => string | null

/** Read a blob out of the repository the hook is running in. */
export type BlobReader = (oid: string) => string | null

/**
 * `git cat-file blob <oid>` in the repository this hook belongs to.
 *
 * The certificate blob is written before `pre-receive` runs and lands in the
 * push's quarantine, which is on the hook's object path — so this reads it with
 * no special handling, and returns `null` rather than throwing once the
 * quarantine is gone (which is what makes calling this from a later hook a
 * no-op rather than a crash).
 */
function catBlob(oid: string): string | null {
  const res = git(['cat-file', 'blob', oid])
  return res.status === 0 ? res.stdout : null
}

/**
 * Did this push offer a certificate at all — whatever became of it?
 *
 * Provenance never needed this question: a certificate that cannot be turned
 * into a key and a push that carried none are both `null`, and `null` is a push
 * that lands. The gate in `src/signers.ts` does need it, because on a claimed
 * repository the two are different refusals with different fixes — *sign your
 * push* and *your signature did not verify, push again* — and an agent told the
 * first when the second is true will keep re-sending a signature that keeps
 * failing.
 *
 * git sets `GIT_PUSH_CERT` to the certificate's blob whenever one arrived, and
 * reports what it thinks of the nonce separately, so this stays true for the
 * stale-nonce case that `readPushCertificate` refuses just below.
 */
export function certificatePresented(env: PushCertEnv = process.env): boolean {
  return (env.GIT_PUSH_CERT ?? '').trim() !== ''
}

/**
 * The certificate this push carries, split and ready to verify, or `null`.
 *
 * The nonce gate is here rather than after verification because it is a
 * different question with a different answer: the signature says *who*, the
 * nonce says *this server, now*. A certificate with a stale, missing or
 * unsolicited nonce may carry a perfectly good signature over a push directed
 * somewhere else, and recording its key as the Signer here would attribute one
 * host's push to a ref on another. git already decided that question — its
 * verdict is `GIT_PUSH_CERT_NONCE_STATUS`, and only `OK` is one.
 *
 * `SLOP` is deliberately not accepted. It means the nonce is ours but older
 * than `receive.certNonceSlop` allows, which git tolerates for clients that sat
 * on an advertisement; walgit does not, because provenance is optional metadata
 * and the strict reading costs a signed push nothing but a retry.
 */
export function readPushCertificate(
  env: PushCertEnv = process.env,
  readBlob: BlobReader = catBlob,
): SplitCertificate | null {
  if (!certificatePresented(env)) return null
  const oid = (env.GIT_PUSH_CERT ?? '').trim()
  if ((env.GIT_PUSH_CERT_NONCE_STATUS ?? '').trim() !== 'OK') return null
  const text = readBlob(oid)
  if (text === null) return null
  return splitPushCertificate(text)
}

/**
 * The real verifier: `ssh-keygen -Y check-novalidate -n git`.
 *
 * `check-novalidate` is the whole point — it verifies the signature and reports
 * the key, and does NOT ask whether that key is allowed. `-Y verify` would, and
 * would need an allowed-signers file to ask against: a key registry, which is
 * the one thing this design does not have. walgit is recording who pushed, not
 * deciding whether they may.
 *
 * The signature must be a file (`-s` takes no `-`), so it is written to a
 * private temporary directory and removed; the body goes on stdin, which keeps
 * the bytes that were signed off the disk and out of the process table.
 *
 * Never throws, and returns `null` for every failure alike — a bad signature, a
 * namespace mismatch, and an `ssh-keygen` that is not installed are all "no
 * Signer", because none of them may cost the pusher their push.
 */
export function sshKeygenVerifier(cert: SplitCertificate): string | null {
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-cert-'))
    const sigFile = path.join(dir, 'push-cert.sig')
    fs.writeFileSync(sigFile, cert.signature)
    const res = spawnSync(
      'ssh-keygen',
      ['-Y', 'check-novalidate', '-n', PUSH_CERT_NAMESPACE, '-s', sigFile],
      { encoding: 'utf8', input: cert.body },
    )
    // A missing binary leaves `status` null and `error` set, which is the same
    // answer as a refusal: exit 0 is the only verdict that names a key.
    if (res.status !== 0) return null
    return fingerprintIn(`${res.stdout ?? ''}\n${res.stderr ?? ''}`)
  } catch {
    return null
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Who signed this push, or `null` for "nobody, as far as walgit can tell".
 *
 * This is the fail-open seam, and the failing open is the feature. A push with
 * no certificate, a malformed one, a bad nonce, an unverifiable signature,
 * verifier output naming no key, an `ssh-keygen` that is absent, and a verifier
 * that throws all return the same `null` — and a `null` Signer is a push that
 * lands exactly as it always has. Provenance is metadata; it must never become
 * a new way for a push to fail, which is why the catch here is unconditional
 * rather than a list of anticipated errors.
 */
export function certSigner(
  env: PushCertEnv = process.env,
  verify: CertVerifier = sshKeygenVerifier,
  readBlob: BlobReader = catBlob,
): string | null {
  try {
    const cert = readPushCertificate(env, readBlob)
    if (!cert) return null
    return verify(cert)
  } catch {
    return null
  }
}
