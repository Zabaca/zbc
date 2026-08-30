/**
 * The decidable half of push provenance, tested with no git, no keypair and no
 * subprocess — which is the reason `shared/provenance.ts` exists as its own
 * module. Everything below runs against a REAL push certificate captured from
 * `git push --signed=yes` against a repository with `receive.certNonceSeed`
 * set, so the split is checked against the bytes git actually produces rather
 * than against a shape this test invented.
 *
 * A shared/ module, tested from src/ with the rest of the suite — the same
 * arrangement as `events.test.ts` and `policy.test.ts` (ADR-0010).
 */

import { describe, expect, test } from 'bun:test'

import { fingerprintIn, PUSH_CERT_NAMESPACE, splitPushCertificate } from '../shared/provenance'

/** Captured verbatim, signature and all. Ed25519, one ref, nonce status OK. */
const CERTIFICATE = `certificate version 0.1
pusher SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw  1788119864 -0700
pushee ../bare.git
nonce 1788119864-129da0fc98fc872e3cdb7dd82d26d9d6a05760f7

0000000000000000000000000000000000000000 e4f2f160482581591e13b76c5a42b008509a5200 refs/heads/main
-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgiLgfNKpBrzOPxamBdDDVCZeeH8
1Z6kh5TJ2D1adxBbsAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5
AAAAQEizgU7B7HSaGHeVVJtpagtmQZ1oXlhb2rGOBjB4FmqHO1iSw9viSY5r+bPyb6ray7
+XyctYSjMcPOKT4awKNAM=
-----END SSH SIGNATURE-----
`

/** What `ssh-keygen -Y check-novalidate -n git` writes when it verifies one. */
const GOOD_OUTPUT =
  'Good "git" signature with ED25519 key SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw\n'

describe('splitPushCertificate', () => {
  test('the body is every byte before the armour, and nothing else', () => {
    const split = splitPushCertificate(CERTIFICATE)!
    expect(split.body).toBe(CERTIFICATE.slice(0, CERTIFICATE.indexOf('-----BEGIN')))
    // Byte-exact, trailing newline included: this is the message the signature
    // is over, so trimming it here would turn every real push into a forgery.
    expect(split.body.endsWith('refs/heads/main\n')).toBe(true)
    expect(split.body).not.toContain('SSH SIGNATURE')
  })

  test('the signature is the armour, terminated', () => {
    const split = splitPushCertificate(CERTIFICATE)!
    expect(split.signature.startsWith('-----BEGIN SSH SIGNATURE-----\n')).toBe(true)
    expect(split.signature.endsWith('-----END SSH SIGNATURE-----\n')).toBe(true)
  })

  test('anything after the armour is not signature', () => {
    // Whatever a malformed or padded blob carries past the terminator is not
    // part of what `ssh-keygen` is handed.
    const split = splitPushCertificate(`${CERTIFICATE}trailing junk\n`)!
    expect(split.signature.endsWith('-----END SSH SIGNATURE-----\n')).toBe(true)
    expect(split.signature).not.toContain('trailing junk')
  })

  test('the fields above the armour are not parsed, and the pusher is not believed', () => {
    // The certificate names a fingerprint in `pusher`. It is the CLAIM under
    // verification, so nothing here reads it — believing it would make the
    // signature ornamental and the whole feature a self-report.
    const split = splitPushCertificate(CERTIFICATE)!
    expect(split.body).toContain('pusher SHA256:')
    expect(Object.keys(split)).toEqual(['body', 'signature'])
  })

  test('malformed is null, never a partial answer', () => {
    // No armour at all — an ordinary blob, or a certificate truncated mid-flight.
    expect(splitPushCertificate('certificate version 0.1\nnonce abc\n')).toBeNull()
    // Armour that never ends: signing nothing over a signature that is not one.
    expect(
      splitPushCertificate('certificate version 0.1\n-----BEGIN SSH SIGNATURE-----\nU1NI\n'),
    ).toBeNull()
    // A signature with no message under it.
    expect(
      splitPushCertificate(
        '   \n-----BEGIN SSH SIGNATURE-----\nU1NI\n-----END SSH SIGNATURE-----\n',
      ),
    ).toBeNull()
    expect(splitPushCertificate('')).toBeNull()
  })
})

describe('fingerprintIn', () => {
  test('reads the key out of the sentence the verifier writes', () => {
    expect(fingerprintIn(GOOD_OUTPUT)).toBe('SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw')
  })

  test('does not depend on the wording around it', () => {
    // The verdict is the exit status, which the caller checks. This only reads
    // the key — so a differently-worded release still gets one.
    expect(fingerprintIn('SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw')).toBe(
      'SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw',
    )
    expect(fingerprintIn(`\n\n${GOOD_OUTPUT}`)).toContain('SHA256:')
  })

  test('reads a fingerprint whose base64 ends in a non-word character', () => {
    // 43 unpadded base64 characters, and the last of them may be `+` or `/`.
    // An anchored regex would silently drop exactly those keys.
    const slash = `SHA256:${'A'.repeat(42)}/`
    expect(fingerprintIn(`Good "git" signature with ED25519 key ${slash}`)).toBe(slash)
  })

  test('output that names no key is null, not something wrong', () => {
    expect(fingerprintIn('Could not verify signature.\n')).toBeNull()
    expect(fingerprintIn('')).toBeNull()
    // A truncated fingerprint is not a fingerprint: recording a prefix would be
    // recording something wrong, which is the one outcome fail-open forbids.
    expect(fingerprintIn(`SHA256:${'A'.repeat(20)}\n`)).toBeNull()
    // MD5 is the other spelling `ssh-keygen` knows, and it is not this one.
    expect(fingerprintIn('MD5:16:27:ac:a5:76:28:2d:36:63:1b:56:4d:eb:df:a6:48\n')).toBeNull()
  })
})

describe('PUSH_CERT_NAMESPACE', () => {
  test('is `git`, which is what makes a push signature un-replayable elsewhere', () => {
    // `ssh-keygen -Y` binds a signature to its namespace and refuses to verify
    // it under another ("namespace does not match"). Verifying under `git` is
    // what stops a push certificate being replayed against an SSH login.
    expect(PUSH_CERT_NAMESPACE).toBe('git')
  })
})
