/**
 * A Private repository refuses a stranger's clone (docs/adr/0013).
 *
 * Tested at `createHttpHandler`, the seam the whole front door already lives
 * behind: routing, the deployment credential and the Private gate are one
 * ordering question, and only a test that asks the real handler can catch the
 * two being put on the wrong sides of each other. The signature verifier is
 * injected exactly as the push-certificate one is, so nothing here spawns a
 * subprocess — the real `ssh-keygen` wrapper is exercised once, with a real
 * key, in `ssh-signature.test.ts`.
 */
import { describe, expect, test } from 'bun:test'

import { CHALLENGE_PATH, PROVENANCE_PATH, READ_VERDICT_PATH } from '../shared/protocol'
import { createHttpHandler, type HttpHandlerDeps } from './http'
import { acceptedNonces, readChallengeNonce } from './private'
import type { Claim } from './wal-index'

const SEED = 'read-seed'
const NOW = 1_757_000_000_000
const SIGNER = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const READER = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const STRANGER = 'SHA256:ccccccccccccccccccccccccccccccccccccccccccc'
const TOKEN = 's3cret'

const PRIVATE_CLAIM: Claim = {
  signers: [SIGNER],
  readers: [READER],
  ts: '2026-09-12T00:00:00.000Z',
}
/** Claimed, and world-readable: no `readers` file, so nothing is gated. */
const OPEN_CLAIM: Claim = { signers: [SIGNER], ts: '2026-09-12T00:00:00.000Z' }

/**
 * A signature, as this test spells one: `<key> over <nonce>`.
 *
 * The stand-in verifier below is the only thing that reads it, and it is what
 * lets a test say "this key signed that nonce" without a keypair. It carries no
 * colon, exactly as an armoured SSH signature carries none — which is what
 * makes the fingerprint in the Basic userid recoverable at all.
 */
const signature = (fingerprint: string, nonce: string) =>
  `${fingerprint.replace('SHA256:', '')} over ${nonce}`

const verifyRead = (message: string, sig: string): string | null => {
  const [key, nonce] = sig.split(' over ')
  return key && nonce === message ? `SHA256:${key}` : null
}

/** What git sends: `Basic base64(<fingerprint>:<signature>)`. */
const credentialFor = (fingerprint: string, nonce: string) =>
  `Basic ${btoa(`${fingerprint}:${signature(fingerprint, nonce)}`)}`

function deployment(
  claim: Claim | undefined,
  overrides: Partial<HttpHandlerDeps> = {},
): (path: string, authorization?: string | null, method?: string) => Promise<Response> {
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens: [],
    public: true,
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran', { status: 200 }),
    readProvenance: async () => ({ provenance: {}, ...(claim ? { claim } : {}) }),
    privateReads: {
      seed: SEED,
      readClaim: async () => claim,
      verifyRead,
      now: () => NOW,
    },
    ...overrides,
  })
  return (path, authorization = null, method = 'GET') =>
    handler(
      new Request(`https://walgit.test${path}`, {
        method,
        headers: authorization ? { authorization } : undefined,
      }),
    )
}

/** The three reads, and the one write that is NOT one. */
const READS = [
  ['info/refs', '/alpha.git/info/refs?service=git-upload-pack', 'GET'],
  ['upload-pack', '/alpha.git/git-upload-pack', 'POST'],
  ['provenance', `${PROVENANCE_PATH}?repo=alpha`, 'GET'],
] as const

describe('the challenge', () => {
  test('answers the nonce for the current window', async () => {
    const res = await deployment(PRIVATE_CLAIM)(CHALLENGE_PATH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ nonce: readChallengeNonce(SEED, NOW) })
  })

  test('is not cachable: it stops being true in ten minutes', async () => {
    const res = await deployment(PRIVATE_CLAIM)(CHALLENGE_PATH)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('needs no credential — it is what a credential is built from', async () => {
    const gated = deployment(PRIVATE_CLAIM, { tokens: [TOKEN], public: false })
    expect((await gated(CHALLENGE_PATH)).status).toBe(200)
  })

  test('does not exist on a deployment with no seed', async () => {
    const res = await deployment(PRIVATE_CLAIM, { privateReads: undefined })(CHALLENGE_PATH)
    expect(res.status).toBe(404)
  })
})

describe('a Private repository', () => {
  for (const [label, path, method] of READS) {
    test(`refuses ${label} with a challenge, and names the repository rather than hiding it`, async () => {
      const res = await deployment(PRIVATE_CLAIM)(path, null, method)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe(
        `walgit-ssh nonce=${readChallengeNonce(SEED, NOW)}`,
      )
      const body = await res.text()
      expect(body).toContain('agentgit credential')
      expect(body).toContain('credential.https://walgit.test.helper')
    })

    test(`lets a listed reader do ${label}`, async () => {
      const nonce = readChallengeNonce(SEED, NOW)
      const res = await deployment(PRIVATE_CLAIM)(path, credentialFor(READER, nonce), method)
      expect(res.status).toBe(200)
    })

    test(`lets a Signer do ${label} without being listed`, async () => {
      const nonce = readChallengeNonce(SEED, NOW)
      const res = await deployment(PRIVATE_CLAIM)(path, credentialFor(SIGNER, nonce), method)
      expect(res.status).toBe(200)
    })

    test(`refuses a stranger's ${label} even with a good signature`, async () => {
      const nonce = readChallengeNonce(SEED, NOW)
      const res = await deployment(PRIVATE_CLAIM)(path, credentialFor(STRANGER, nonce), method)
      expect(res.status).toBe(401)
    })
  }

  test('still takes a push: writes are the Signer List’s question, not this one', async () => {
    const res = await deployment(PRIVATE_CLAIM)('/alpha.git/git-receive-pack', null, 'POST')
    expect(res.status).toBe(200)
  })

  /**
   * The advertisement a push BEGINS with is still a read: it hands over every
   * ref name and oid. Leaving it open would publish the shape of every Private
   * repository to anyone who appended a query parameter.
   */
  test('refuses the ref advertisement even when it is a push asking', async () => {
    const path = '/alpha.git/info/refs?service=git-receive-pack'
    expect((await deployment(PRIVATE_CLAIM)(path)).status).toBe(401)
    const nonce = readChallengeNonce(SEED, NOW)
    expect((await deployment(PRIVATE_CLAIM)(path, credentialFor(SIGNER, nonce))).status).toBe(200)
  })

  test('accepts the previous window and refuses one older', async () => {
    const [current, previous] = acceptedNonces(SEED, NOW)
    const stale = readChallengeNonce(SEED, NOW - 2 * 300_000)
    expect(previous).not.toBe(current)
    const read = deployment(PRIVATE_CLAIM)
    expect((await read(READS[0][1], credentialFor(READER, previous!))).status).toBe(200)
    expect((await read(READS[0][1], credentialFor(READER, stale))).status).toBe(401)
  })

  test('refuses a signature that does not verify, and one that is not there', async () => {
    const read = deployment(PRIVATE_CLAIM)
    expect((await read(READS[0][1], 'Basic ' + btoa(`${READER}:garbage`))).status).toBe(401)
    expect((await read(READS[0][1], 'Basic not-base64!!')).status).toBe(401)
    expect((await read(READS[0][1], 'Bearer ')).status).toBe(401)
  })

  /**
   * The second question, asked after the first. A deployment token proves the
   * request may reach this host; it says nothing about which keys a repository
   * lets read it, and a host that let it stand in for one would have handed
   * every Private repository to everyone holding the instance credential.
   */
  test('is not opened by the deployment credential', async () => {
    const gated = deployment(PRIVATE_CLAIM, { tokens: [TOKEN], public: false })
    expect((await gated(READS[0][1], `Bearer ${TOKEN}`)).status).toBe(401)
    // …and the deployment credential is still required in front of it: a
    // stranger with a good signature and no token gets no further than before.
    const nonce = readChallengeNonce(SEED, NOW)
    expect((await gated(READS[0][1], credentialFor(READER, nonce))).status).toBe(401)
  })

  test('is refused when its Reader List cannot be read at all', async () => {
    const broken = deployment(PRIVATE_CLAIM, {
      privateReads: {
        seed: SEED,
        readClaim: async () => {
          throw new Error('index unreachable')
        },
        verifyRead,
        now: () => NOW,
      },
    })
    expect((await broken(READS[0][1])).status).toBe(401)
  })

  /**
   * The provenance read reaches the Index through its own reader, so its
   * outage is a second path to the same question — and it must answer the same
   * way rather than throwing past the router into a 500 the edge would count as
   * walgit having failed to refuse at all.
   */
  test('is refused when the provenance read itself cannot reach the Index', async () => {
    const broken = deployment(PRIVATE_CLAIM, {
      readProvenance: async () => {
        throw new Error('index unreachable')
      },
    })
    const res = await broken(`${PROVENANCE_PATH}?repo=alpha`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('walgit-ssh nonce=')
  })
})

describe('a repository that is not Private', () => {
  for (const [label, path, method] of READS) {
    test(`serves ${label} to anyone when there is no Reader List`, async () => {
      expect((await deployment(OPEN_CLAIM)(path, null, method)).status).toBe(200)
      expect((await deployment(undefined)(path, null, method)).status).toBe(200)
    })

    test(`serves ${label} to anyone when the deployment has no seed`, async () => {
      const off = deployment(PRIVATE_CLAIM, { privateReads: undefined })
      expect((await off(path, null, method)).status).toBe(200)
    })
  }
})

/**
 * The verdict route: the Worker's half of the same gate (docs/adr/0013).
 *
 * The edge cannot verify a signature — it has no subprocess — so it forwards
 * the credential a subscriber presented and the repositories it named, and
 * spends the answer on the socket. One route, one verdict function, so a Watch
 * and a clone cannot come to different conclusions about the same key.
 */
describe('the read verdict route', () => {
  const ANNOUNCE_SECRET = 'announce-secret'

  /** Claims by repository, so one call can be asked about several at once. */
  function host(claims: Record<string, Claim | undefined>) {
    const handler = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: [],
      public: true,
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      privateReads: {
        seed: SEED,
        announceSecret: ANNOUNCE_SECRET,
        readClaim: async (repoId) => {
          if (repoId === 'unreadable') throw new Error('index unreachable')
          return claims[repoId]
        },
        verifyRead,
        now: () => NOW,
      },
    })
    return (body: unknown, authorization: string | null = `Bearer ${ANNOUNCE_SECRET}`) =>
      handler(
        new Request(`https://walgit.test${READ_VERDICT_PATH}`, {
          method: 'POST',
          headers: authorization ? { authorization } : undefined,
          body: JSON.stringify(body),
        }),
      )
  }

  const CLAIMS = { secret: PRIVATE_CLAIM, open: OPEN_CLAIM, unclaimed: undefined }

  test('answers one verdict per repository for the key that signed', async () => {
    const nonce = readChallengeNonce(SEED, NOW)
    const res = await host(CLAIMS)({
      credential: credentialFor(READER, nonce),
      repos: ['secret', 'open', 'unclaimed'],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      verdicts: { secret: true, open: true, unclaimed: true },
    })
  })

  test('a stranger is refused the Private one and keeps the rest', async () => {
    const nonce = readChallengeNonce(SEED, NOW)
    const res = await host(CLAIMS)({
      credential: credentialFor(STRANGER, nonce),
      repos: ['secret', 'open'],
    })
    expect(await res.json()).toEqual({ verdicts: { secret: false, open: true } })
  })

  test('no credential at all reads a Private repository as refused', async () => {
    const res = await host(CLAIMS)({ credential: null, repos: ['secret'] })
    expect(await res.json()).toEqual({ verdicts: { secret: false } })
  })

  test('a Signer is a reader here too, as it is on a clone', async () => {
    const nonce = readChallengeNonce(SEED, NOW)
    const res = await host(CLAIMS)({
      credential: credentialFor(SIGNER, nonce),
      repos: ['secret'],
    })
    expect(await res.json()).toEqual({ verdicts: { secret: true } })
  })

  test('an Index it cannot read is refused, never served', async () => {
    const nonce = readChallengeNonce(SEED, NOW)
    const res = await host(CLAIMS)({
      credential: credentialFor(READER, nonce),
      repos: ['unreadable'],
    })
    expect(await res.json()).toEqual({ verdicts: { unreadable: false } })
  })

  test('a name walgit would not serve is refused rather than resolved', async () => {
    const res = await host(CLAIMS)({ credential: null, repos: ['../etc'] })
    expect(await res.json()).toEqual({ verdicts: { '../etc': false } })
  })

  test('it is the announce secret that opens it, and nothing else', async () => {
    for (const authorization of [null, 'Bearer read-token', `Bearer ${TOKEN}`]) {
      const res = await host(CLAIMS)({ credential: null, repos: ['open'] }, authorization)
      expect(res.status).toBe(404)
    }
  })

  test('does not exist on a deployment with no seed', async () => {
    const off = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: [],
      public: true,
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
    })
    const res = await off(
      new Request(`https://walgit.test${READ_VERDICT_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ANNOUNCE_SECRET}` },
        body: JSON.stringify({ credential: null, repos: ['open'] }),
      }),
    )
    expect(res.status).toBe(404)
  })
})
