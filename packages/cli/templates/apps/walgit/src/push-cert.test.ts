import { describe, expect, test } from 'bun:test'

import {
  certSigner,
  pushCertSeed,
  readPushCertificate,
  signedPushEnabled,
  sshKeygenVerifier,
} from './push-cert'

describe('pushCertSeed', () => {
  test('is the configured seed when one is set', () => {
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: 'a-long-random-seed' })).toBe('a-long-random-seed')
    expect(signedPushEnabled({ WALGIT_PUSH_CERT_SEED: 'a-long-random-seed' })).toBe(true)
  })

  test('is off unset, and off blank', () => {
    // Blank has to read as unset rather than as a seed of "": git would take an
    // empty seed and advertise the capability on it, so a deployment that
    // cleared the variable would still take signed pushes.
    expect(pushCertSeed({})).toBeNull()
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '' })).toBeNull()
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '   ' })).toBeNull()
    expect(signedPushEnabled({})).toBe(false)
  })

  test('does not treat the seed as a boolean flag', () => {
    // Every other capability here is turned on by `1`/`true`. This one is not a
    // flag: the string IS the secret git derives its nonce from, so `1` is a
    // (terrible) seed and not the word "on".
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: '1' })).toBe('1')
    expect(pushCertSeed({ WALGIT_PUSH_CERT_SEED: 'false' })).toBe('false')
  })
})

/**
 * Reading and verifying a certificate. The blob reader and the verifier are
 * both injected, so nothing below needs a keypair, a subprocess or a running
 * git — the parsing they lean on is `src/provenance.test.ts`'s.
 */

const CERTIFICATE = [
  'certificate version 0.1',
  'pusher SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw  1788119864 -0700',
  'pushee https://walgit.example/demo',
  'nonce 1788119864-129da0fc98fc872e3cdb7dd82d26d9d6a05760f7',
  '',
  `${'0'.repeat(40)} ${'e'.repeat(40)} refs/heads/main`,
  '-----BEGIN SSH SIGNATURE-----',
  'U1NIU0lHAAAAAQ==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n')

const FINGERPRINT = 'SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw'

const signedEnv = { GIT_PUSH_CERT: 'cafe1234', GIT_PUSH_CERT_NONCE_STATUS: 'OK' }
const blob = (text: string | null) => () => text

describe('readPushCertificate', () => {
  test('splits the blob git left, addressed by the oid in the environment', () => {
    const seen: string[] = []
    const cert = readPushCertificate(signedEnv, (oid) => {
      seen.push(oid)
      return CERTIFICATE
    })
    expect(seen).toEqual(['cafe1234'])
    expect(cert!.body).toContain('refs/heads/main')
    expect(cert!.signature).toContain('BEGIN SSH SIGNATURE')
  })

  test('an unsigned push carries no certificate and reads nothing', () => {
    expect(readPushCertificate({}, blob(CERTIFICATE))).toBeNull()
    expect(readPushCertificate({ GIT_PUSH_CERT: '  ' }, blob(CERTIFICATE))).toBeNull()
  })

  test('only an OK nonce counts', () => {
    // The signature says WHO; the nonce says THIS server, NOW. A certificate
    // with a good signature and a stale or foreign nonce is a real push
    // directed somewhere else, and attributing it here would put one host's
    // pusher on another host's ref.
    for (const status of ['SLOP', 'BAD', 'MISSING', 'UNSOLICITED', '', 'ok']) {
      const env = { ...signedEnv, GIT_PUSH_CERT_NONCE_STATUS: status }
      expect(readPushCertificate(env, blob(CERTIFICATE))).toBeNull()
    }
  })

  test('an unreadable or malformed blob is null rather than a throw', () => {
    expect(readPushCertificate(signedEnv, blob(null))).toBeNull()
    expect(readPushCertificate(signedEnv, blob('not a certificate\n'))).toBeNull()
  })
})

describe('certSigner', () => {
  test('names the key the verifier verified', () => {
    expect(certSigner(signedEnv, () => FINGERPRINT, blob(CERTIFICATE))).toBe(FINGERPRINT)
  })

  test('hands the verifier the split certificate, not the raw blob', () => {
    let handed: { body: string; signature: string } | null = null
    certSigner(
      signedEnv,
      (cert) => {
        handed = cert
        return FINGERPRINT
      },
      blob(CERTIFICATE),
    )
    expect(handed!.body).not.toContain('SSH SIGNATURE')
    expect(handed!.signature.startsWith('-----BEGIN SSH SIGNATURE-----')).toBe(true)
  })

  test('every way this goes wrong is the same answer: no signer', () => {
    // Fail open, always. None of these may become a way for a push to fail —
    // provenance is metadata, and a push that lands without a Signer is exactly
    // the push walgit accepted before this existed.
    const cases: [string, string | null][] = [
      // No certificate at all: the ordinary, unsigned push.
      ['unsigned', certSigner({}, () => FINGERPRINT, blob(CERTIFICATE))],
      // A verifier that refused — bad signature, wrong namespace, no ssh-keygen.
      ['refused', certSigner(signedEnv, () => null, blob(CERTIFICATE))],
      // A verifier that threw, which is what an absent binary looks like if the
      // spawn helper is ever changed to raise instead of report.
      [
        'threw',
        certSigner(
          signedEnv,
          () => {
            throw new Error('ssh-keygen: not found')
          },
          blob(CERTIFICATE),
        ),
      ],
      // A blob reader that threw: the quarantine is gone.
      [
        'blob threw',
        certSigner(
          signedEnv,
          () => FINGERPRINT,
          () => {
            throw new Error('fatal: Not a valid object name')
          },
        ),
      ],
      // Verified something, named nobody.
      ['nameless', certSigner(signedEnv, () => null, blob(CERTIFICATE))],
    ]
    for (const [name, result] of cases) expect([name, result]).toEqual([name, null])
  })
})

describe('sshKeygenVerifier', () => {
  test('a signature that is not one is refused, and nothing throws', () => {
    // The real binary, on garbage: exercises the spawn, the temporary file and
    // its removal without needing a keypair. A real signed push is `e2e`'s.
    expect(
      sshKeygenVerifier({
        body: 'certificate version 0.1\n',
        signature: '-----BEGIN SSH SIGNATURE-----\nU1NI\n-----END SSH SIGNATURE-----\n',
      }),
    ).toBeNull()
  })
})
