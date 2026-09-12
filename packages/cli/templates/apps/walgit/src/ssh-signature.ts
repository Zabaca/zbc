/**
 * `ssh-keygen -Y check-novalidate`, once.
 *
 * walgit verifies SSH signatures in two places now — a Push Certificate
 * (namespace `git`, docs/adr/0011) and a Read Challenge (namespace
 * `walgit-read`, docs/adr/0013) — and they are the same subprocess with the
 * same three awkward details: the signature must be a FILE (`-s` takes no
 * `-`), the signed bytes go on stdin so they never reach the disk or the
 * process table, and the verdict is the exit status while the key is only
 * findable in the output text. Written twice, those details would be two
 * chances to get the temporary file's lifetime or the namespace flag wrong.
 *
 * `check-novalidate` and never `-Y verify`: it verifies the signature and
 * reports the key, and does NOT ask whether that key is allowed. Asking would
 * need an allowed-signers file — a key registry, the one thing this design does
 * not have. Who may read is `readAllowed`'s question, over a list that lives in
 * the repository itself.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { fingerprintIn } from '../shared/provenance'
import { READ_CHALLENGE_NAMESPACE } from '../shared/protocol'

/**
 * Verify `signature` over `body` in `namespace`, and name the key, or `null`.
 *
 * Never throws, and every failure is the same answer — a bad signature, a
 * namespace mismatch, output naming no key, and an `ssh-keygen` that is not
 * installed alike. What that `null` COSTS differs by caller and is the
 * caller's to decide: provenance records no Signer and lets the push land,
 * while a Read Challenge refuses the read.
 */
export function checkNovalidate(namespace: string, body: string, signature: string): string | null {
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-sig-'))
    const sigFile = path.join(dir, 'signature.sig')
    fs.writeFileSync(sigFile, signature)
    const res = spawnSync(
      'ssh-keygen',
      ['-Y', 'check-novalidate', '-n', namespace, '-s', sigFile],
      { encoding: 'utf8', input: body },
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
 * The Read Challenge's verifier: did somebody sign this nonce with a key, and
 * which one (docs/adr/0013)?
 *
 * The namespace is the whole security property of the pair. `ssh-keygen` binds
 * it into the signed bytes, so a signature made for a read cannot be replayed
 * as a Push Certificate and a certificate cannot be spent as a read — which is
 * why this may share a subprocess with provenance without sharing a verdict.
 *
 * Fails CLOSED, unlike `sshKeygenVerifier`: an unverifiable signature is a
 * reader that does not get in, where an unverifiable certificate is only a push
 * with no Signer recorded.
 */
export function sshReadVerifier(nonce: string, signature: string): string | null {
  const armour = armouredSignature(signature)
  if (armour === null) return null
  return checkNovalidate(READ_CHALLENGE_NAMESPACE, nonce, armour)
}

const BEGIN = '-----BEGIN SSH SIGNATURE-----'

/**
 * The largest signature worth looking at, in bytes.
 *
 * An armoured ed25519 signature is a few hundred bytes and an RSA one under
 * two thousand; 16 KiB is far above anything real and far below what an
 * attacker would need to make the write itself cost something.
 */
const MAX_SIGNATURE_BYTES = 16 * 1024

/**
 * The presented credential as `ssh-keygen` will take it, or `null`.
 *
 * Two jobs, and the second is why this is not inlined into the verifier.
 *
 * **A single line has to work.** git's credential protocol is `key=value\n`
 * and a newline ends the value, so a credential helper CANNOT hand git a
 * multi-line armoured signature — `git credential approve` rejects one
 * outright. `ssh-keygen` in turn rejects armour with its newlines stripped
 * (`sshsig_dearmor: no header eol`). So the wire form a helper can actually
 * send is the armour base64-encoded once more, which is one line and holds no
 * colon — and therefore survives both git's grammar and the Basic userid split
 * in `presentedSignature`. Both forms are accepted: the by-hand `curl` in the
 * 401 body sends raw armour through a header, where newlines are fine.
 *
 * **Garbage costs nothing.** Anything that is not a signature is refused here,
 * before the temporary directory and the subprocess. Without this, an
 * unauthenticated request to a Private repository with a made-up credential
 * would fork `ssh-keygen` twice — once per accepted nonce — which is a free
 * amplifier for anyone who knows one Private repository's name.
 */
export function armouredSignature(presented: string): string | null {
  const value = presented.trim()
  if (value === '' || value.length > MAX_SIGNATURE_BYTES) return null
  if (value.startsWith(BEGIN)) return value
  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return null
  }
  return decoded.trimStart().startsWith(BEGIN) ? decoded : null
}
