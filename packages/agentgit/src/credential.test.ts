/**
 * The credential helper, which is the only part of this client git itself
 * calls.
 *
 * Every assertion here is about the bytes on the two pipes — what git wrote to
 * stdin, what came back on stdout — because that is the entire contract: a
 * helper that is right about everything except the shape of its output is a
 * clone that prompts for a password no human has.
 *
 * The expected credential is checked the way walgit reads it off the wire
 * (`shared/credentials.ts` `presentedSignature`, `src/ssh-signature.ts`
 * `armouredSignature`): the last colon splits fingerprint from signature, and
 * the signature must survive base64-decoding back to armour. The rules are
 * restated here as literals rather than imported — agentgit deliberately does
 * not depend on walgit's source — so a drift shows up as a failing test on one
 * side rather than as a passing test on both.
 */

import { describe, expect, test } from 'bun:test'

import { type CredentialDeps, runCredential } from './credential'

const ARMOUR = `-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQ==\n-----END SSH SIGNATURE-----\n`

const deps = (over: Partial<CredentialDeps> = {}): CredentialDeps => ({
  challenge: async () => 'a3f9nonce',
  signingKey: () => '/home/agent/.ssh/id_ed25519',
  fingerprint: () => 'SHA256:1uNCXGZ4mL2p0G8fq2Kf5N0S2vT3iyq1t5nP0hW2xYc',
  sign: () => ARMOUR,
  ...over,
})

const fields = (stdout: string) => {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

const GIT_ASKS = 'protocol=https\nhost=agentgit.zabaca.com\npath=study-42.git\n\n'

describe('agentgit credential get', () => {
  test('answers git with the fingerprint as the user and the signature as the password', async () => {
    const result = await runCredential('get', GIT_ASKS, deps())

    expect(result.code).toBe(0)
    const answered = fields(result.stdout)
    expect(answered.username).toBe('SHA256:1uNCXGZ4mL2p0G8fq2Kf5N0S2vT3iyq1t5nP0hW2xYc')
    // Not the armour itself: git's protocol ends a value at a newline, and
    // walgit's reader splits the Basic userid at the LAST colon, so the wire
    // form is the armour base64-encoded once more — one line, no colon.
    expect(answered.password).not.toContain(':')
    expect(answered.password).not.toContain('\n')
    expect(Buffer.from(answered.password!, 'base64').toString('utf8')).toBe(ARMOUR)
    expect(result.stdout.endsWith('\n')).toBe(true)
  })

  test('signs the nonce this host published, in the walgit-read namespace', async () => {
    const asked: string[] = []
    const signed: string[] = []
    await runCredential(
      'get',
      GIT_ASKS,
      deps({
        challenge: async (origin) => {
          asked.push(origin)
          return 'window-42'
        },
        sign: (_key, nonce) => {
          signed.push(nonce)
          return ARMOUR
        },
      }),
    )

    expect(asked).toEqual(['https://agentgit.zabaca.com'])
    expect(signed).toEqual(['window-42'])
  })

  test('keeps the port a self-hosted deployment answers on', async () => {
    const asked: string[] = []
    await runCredential(
      'get',
      'protocol=http\nhost=127.0.0.1:8787\n\n',
      deps({
        challenge: async (origin) => {
          asked.push(origin)
          return 'n'
        },
      }),
    )
    expect(asked).toEqual(['http://127.0.0.1:8787'])
  })

  test('ignores wwwauth[], because only git >= 2.42 sends it', async () => {
    const result = await runCredential(
      'get',
      `${'protocol=https\nhost=agentgit.zabaca.com\n'}wwwauth[]=walgit-ssh nonce=stale-from-the-header\n\n`,
      deps({ sign: (_key, nonce) => (nonce === 'a3f9nonce' ? ARMOUR : null) }),
    )
    expect(result.code).toBe(0)
    expect(fields(result.stdout).password).toBeDefined()
  })

  test('a host that publishes no challenge is answered with nothing at all', async () => {
    // Not an error: most hosts are not walgit, and a helper that failed here
    // would break every other credential helper configured after it.
    const result = await runCredential('get', GIT_ASKS, deps({ challenge: async () => null }))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
  })

  test('no signing key names user.signingkey rather than prompting', async () => {
    const result = await runCredential('get', GIT_ASKS, deps({ signingKey: () => null }))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('user.signingkey')
  })

  test('a key that will not sign is reported, not swallowed', async () => {
    const result = await runCredential('get', GIT_ASKS, deps({ sign: () => null }))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('/home/agent/.ssh/id_ed25519')
  })

  test('a protocol that is not http asks nothing and signs nothing', async () => {
    const asked: string[] = []
    const result = await runCredential(
      'get',
      'protocol=ssh\nhost=agentgit.zabaca.com\n\n',
      deps({
        challenge: async (origin) => {
          asked.push(origin)
          return 'n'
        },
      }),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(asked).toEqual([])
  })
})

describe('agentgit credential store and erase', () => {
  test('are no-ops: a signature is proof of a key, and there is nothing to keep', async () => {
    for (const operation of ['store', 'erase'] as const) {
      const signed: string[] = []
      const result = await runCredential(
        operation,
        `${GIT_ASKS}username=SHA256:whatever\npassword=cGFzcw==\n\n`,
        deps({
          sign: (_key, nonce) => {
            signed.push(nonce)
            return ARMOUR
          },
        }),
      )
      expect(result).toMatchObject({ code: 0, stdout: '' })
      expect(signed).toEqual([])
    }
  })
})
