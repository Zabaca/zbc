/**
 * The one place walgit spawns `ssh-keygen`, exercised once with a real key.
 *
 * Everything above this boundary injects a verifier and never spawns anything
 * (`src/private-read.test.ts`, `src/push-cert.test.ts`), so this file is where
 * the claim "a `walgit-read` signature by this key verifies as this
 * fingerprint" is actually checked against the binary rather than against a
 * stand-in. The expected fingerprint comes from `ssh-keygen -lf` on the public
 * key — `ssh-keygen`'s own statement of it, not this code's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { READ_CHALLENGE_NAMESPACE } from '../shared/protocol'
import { sshReadVerifier } from './ssh-signature'

const NONCE = '2b32635014b8ae8cb63ec2637f5462cde610829a59d414e756a97b40105ee082'

let dir: string
let key: string
let fingerprint: string

/** `ssh-keygen -Y sign`, as a client would run it. */
function sign(message: string, namespace: string, keyFile: string): string {
  const res = spawnSync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', keyFile, '-'], {
    encoding: 'utf8',
    input: message,
  })
  expect(res.status).toBe(0)
  return res.stdout
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-read-test-'))
  key = path.join(dir, 'id_ed25519')
  expect(
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'walgit-test', '-f', key], {
      encoding: 'utf8',
    }).status,
  ).toBe(0)
  // What `ssh-keygen` itself says this key's fingerprint is: `<bits> <fp> …`.
  const listed = spawnSync('ssh-keygen', ['-lf', `${key}.pub`], { encoding: 'utf8' })
  fingerprint = listed.stdout.split(/\s+/)[1]!
  expect(fingerprint).toMatch(/^SHA256:/)
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('sshReadVerifier', () => {
  test('names the key that signed the nonce', () => {
    expect(sshReadVerifier(NONCE, sign(NONCE, READ_CHALLENGE_NAMESPACE, key))).toBe(fingerprint)
  })

  test('refuses a signature over a different nonce', () => {
    const other = NONCE.replace(/^2/, '3')
    expect(sshReadVerifier(other, sign(NONCE, READ_CHALLENGE_NAMESPACE, key))).toBeNull()
  })

  /**
   * The reason the namespace is `walgit-read` and not `git`: a Push
   * Certificate's signature must not be spendable as a read, in either
   * direction.
   */
  test('refuses a signature made in another namespace', () => {
    expect(sshReadVerifier(NONCE, sign(NONCE, 'git', key))).toBeNull()
  })

  test('refuses garbage without throwing', () => {
    expect(sshReadVerifier(NONCE, 'not a signature')).toBeNull()
    expect(sshReadVerifier(NONCE, '')).toBeNull()
    // Long enough to be past the ceiling, and shaped like the real thing: a
    // credential nobody could have signed must not cost a subprocess.
    expect(sshReadVerifier(NONCE, `${'-----BEGIN SSH SIGNATURE-----'}${'A'.repeat(20_000)}`)).toBe(
      null,
    )
  })

  /**
   * The form a credential helper can actually send.
   *
   * git's credential protocol is `key=value\n`, so a multi-line armoured
   * signature is unrepresentable — and `ssh-keygen` refuses armour with the
   * newlines taken out. Base64 of the armour is the one encoding that survives
   * both, so the server takes it; the by-hand `curl` in the 401 body still
   * sends raw armour, and both must verify to the same key.
   */
  test('takes the armour base64-encoded, as a one-line credential', () => {
    const armour = sign(NONCE, READ_CHALLENGE_NAMESPACE, key)
    const oneLine = Buffer.from(armour, 'utf8').toString('base64')
    expect(oneLine).not.toContain('\n')
    expect(sshReadVerifier(NONCE, oneLine)).toBe(fingerprint)
  })

  test('does not take the armour with its newlines merely stripped', () => {
    // `ssh-keygen` refuses it (`sshsig_dearmor: no header eol`), so a helper
    // that "fixed" the multi-line problem this way must fail loudly here
    // rather than appear to work.
    const flattened = sign(NONCE, READ_CHALLENGE_NAMESPACE, key).replace(/\n/g, '')
    expect(sshReadVerifier(NONCE, flattened)).toBeNull()
  })
})
