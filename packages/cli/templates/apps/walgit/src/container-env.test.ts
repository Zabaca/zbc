/**
 * The forwarding rules and the change detector live in `worker/`, because the
 * Durable Object is the only layer that holds both the deployed environment and
 * the running container. Both are pure, though, so they are tested here with
 * the rest of the suite rather than behind a Workers runtime — the same
 * arrangement as `landing.test.ts` and `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import {
  CONTAINER_ENV,
  containerEnv,
  fingerprintEnv,
  reconcileContainerEnv,
} from '../shared/container-env'

describe('containerEnv', () => {
  test('forwards only the names on the list', () => {
    const forwarded = containerEnv({
      WALGIT_S3_BUCKET: 'wal',
      WALGIT_RETENTION_HOURS: '24',
      // Not a container variable: the Worker's own telemetry binding name
      // happens to share the prefix, and prefix matching would forward it.
      WALGIT_METRICS: 'not-forwarded',
    } as Record<string, string>)

    expect(forwarded).toEqual({ WALGIT_S3_BUCKET: 'wal', WALGIT_RETENTION_HOURS: '24' })
  })

  test('drops unset and blank, so a cleared variable reads as unenforced', () => {
    // The two spellings of "no policy" have to collapse into one, or a blank
    // string reaches `capabilitiesFrom` as a value and is parsed rather than
    // skipped.
    expect(containerEnv({ WALGIT_RETENTION_HOURS: '' })).toEqual({})
    expect(containerEnv({})).toEqual({})
  })

  test('the ref-event variables reach the container', () => {
    // The push path announces from INSIDE the container (src/announce.ts), so
    // both the endpoint and the shared secret have to cross this seam. A name
    // missing here is a feature that is configured on the Worker, advertised,
    // and silently never fires.
    const forwarded = containerEnv({
      WALGIT_EVENTS_URL: 'https://walgit.example.com',
      WALGIT_EVENTS_TOKEN: 'announce-secret',
    })

    expect(forwarded).toEqual({
      WALGIT_EVENTS_URL: 'https://walgit.example.com',
      WALGIT_EVENTS_TOKEN: 'announce-secret',
    })
  })

  test('the push-certificate seed reaches the container', () => {
    // `git-receive-pack` runs INSIDE the container, and it is the only thing
    // that ever reads this. A seed that stops at the Worker is a deployment
    // that thinks it takes signed pushes and refuses every one of them, with
    // the refusal coming from the client's own git — nothing on this side would
    // log anything at all.
    expect(containerEnv({ WALGIT_PUSH_CERT_SEED: 'seed' })).toEqual({
      WALGIT_PUSH_CERT_SEED: 'seed',
    })
  })

  test('the Signer List flag reaches the container', () => {
    // The refusals it turns on all run in `pre-receive`, which is inside the
    // container. A flag that stopped at the Worker would be a deployment that
    // believes its names can be claimed and records nothing when they are.
    expect(containerEnv({ WALGIT_SIGNER_LISTS: '1' })).toEqual({ WALGIT_SIGNER_LISTS: '1' })
  })

  test('the Private seed reaches the container', () => {
    // The Reader List is read in `pre-receive` and the nonce will be derived
    // inside the container too (docs/adr/0013). A seed that stopped at the
    // Worker would be a deployment whose documents offer Private repositories
    // and whose push path never records a Reader List.
    expect(containerEnv({ WALGIT_PRIVATE_REPOS: 'read-seed' })).toEqual({
      WALGIT_PRIVATE_REPOS: 'read-seed',
    })
  })

  test('every forwarded name is one src/ actually reads', () => {
    // A name added here and nowhere else is a variable that looks configured
    // and does nothing.
    expect(new Set(CONTAINER_ENV).size).toBe(CONTAINER_ENV.length)
    for (const name of CONTAINER_ENV) expect(name.startsWith('WALGIT_')).toBe(true)
  })
})

test('the build id reaches the container — the image-only deploy case', () => {
  // A deploy that changes only the IMAGE changes no variable, so the
  // fingerprint does not move and the running container is never replaced
  // (observed on the 0.16.1 production deploy: the rollout reported
  // `completed` and the instance serving git was the one started an hour
  // earlier). The cloudflare module's `deployIdVar` injects the deployed
  // commit as a var, and this is the line that lets it reach the container.
  expect(containerEnv({ WALGIT_BUILD_ID: 'd7dec9b' })).toEqual({
    WALGIT_BUILD_ID: 'd7dec9b',
  })
})

describe('fingerprintEnv', () => {
  test('is stable across calls and independent of key order', () => {
    const a = { WALGIT_PUBLIC: '1', WALGIT_RETENTION_HOURS: '24' }
    const b = { WALGIT_RETENTION_HOURS: '24', WALGIT_PUBLIC: '1' }

    expect(fingerprintEnv(a)).toBe(fingerprintEnv(a))
    expect(fingerprintEnv(a)).toBe(fingerprintEnv(b))
  })

  test('changes when a value changes — the case the container must restart for', () => {
    const before = { WALGIT_PUBLIC: '1' }
    const after = { WALGIT_PUBLIC: '1', WALGIT_RETENTION_HOURS: '24' }

    expect(fingerprintEnv(after)).not.toBe(fingerprintEnv(before))
    expect(fingerprintEnv({ WALGIT_RETENTION_HOURS: '48' })).not.toBe(
      fingerprintEnv({ WALGIT_RETENTION_HOURS: '24' }),
    )
    // Removing a variable is a change too: it turns a stated limit off, and a
    // container still enforcing it would refuse pushes the page says it takes.
    expect(fingerprintEnv({})).not.toBe(fingerprintEnv(before))
  })

  test('does not confuse a name/value boundary', () => {
    // The failure a naive concatenation makes: `AB` + `c` and `A` + `Bc`.
    expect(fingerprintEnv({ AB: 'c' })).not.toBe(fingerprintEnv({ A: 'Bc' }))
    expect(fingerprintEnv({ A: 'x', B: 'y' })).not.toBe(fingerprintEnv({ A: 'x', BY: '' }))
  })

  test('reveals nothing about the values it covers', () => {
    // It is persisted in Durable Object storage and half of what it covers is
    // the object store's credentials, so it must not be a copy of them.
    const secret = 'super-secret-access-key'
    const digest = fingerprintEnv({ WALGIT_S3_SECRET_ACCESS_KEY: secret })

    expect(digest).not.toContain(secret)
    expect(digest).toMatch(/^[0-9a-f]{8}$/)
  })
})

/**
 * A stand-in for the Durable Object the real `reconcileContainerEnv` drives:
 * a running (or stopped) container, the fingerprint storage, and an ordered
 * transcript of what was asked of it. The transcript is the point — the rule
 * this function exists to keep is that the new fingerprint is recorded only
 * AFTER a successful destroy, which no pair of end-state assertions can see.
 */
function fakeTarget(options: { running: boolean; booted?: string; destroyFails?: boolean }) {
  const transcript: string[] = []
  let stored = options.booted
  return {
    transcript,
    get stored() {
      return stored
    },
    port: {
      get running() {
        return options.running
      },
      async read() {
        transcript.push('read')
        return stored
      },
      async destroy() {
        transcript.push('destroy')
        if (options.destroyFails) throw new Error('container destroy failed')
      },
      async write(fingerprint: string) {
        transcript.push(`write:${fingerprint}`)
        stored = fingerprint
      },
    },
  }
}

describe('reconcileContainerEnv', () => {
  test('a running container booted on a different environment is replaced', async () => {
    const target = fakeTarget({ running: true, booted: 'aaaaaaaa' })

    expect(await reconcileContainerEnv(target.port, 'bbbbbbbb')).toBe('replaced')
    // Recorded only after the destroy: recording first would make a failed
    // replacement look reconciled forever.
    expect(target.transcript).toEqual(['read', 'destroy', 'write:bbbbbbbb'])
  })

  test('a matching fingerprint touches neither the container nor storage', async () => {
    const target = fakeTarget({ running: true, booted: 'aaaaaaaa' })

    expect(await reconcileContainerEnv(target.port, 'aaaaaaaa')).toBe('unchanged')
    expect(target.transcript).toEqual(['read'])
  })

  test('an unrecorded fingerprint counts as a mismatch, not as a fresh start', async () => {
    // A running container with no record predates this code, so what it booted
    // with is unknowable — and on the deploy that ships this, that container is
    // exactly the one already serving a superseded policy.
    const target = fakeTarget({ running: true })

    expect(await reconcileContainerEnv(target.port, 'bbbbbbbb')).toBe('replaced')
    expect(target.transcript).toEqual(['read', 'destroy', 'write:bbbbbbbb'])
  })

  test('a stopped container is recorded and not destroyed', async () => {
    // Its next start reads the environment as it now is, so there is nothing
    // to replace.
    const target = fakeTarget({ running: false, booted: 'aaaaaaaa' })

    expect(await reconcileContainerEnv(target.port, 'bbbbbbbb')).toBe('recorded')
    expect(target.transcript).toEqual(['read', 'write:bbbbbbbb'])
  })

  test('a failed destroy records nothing, so the next request tries again', async () => {
    const target = fakeTarget({ running: true, booted: 'aaaaaaaa', destroyFails: true })

    await expect(reconcileContainerEnv(target.port, 'bbbbbbbb')).rejects.toThrow(
      'container destroy failed',
    )
    expect(target.transcript).toEqual(['read', 'destroy'])
    expect(target.stored).toBe('aaaaaaaa')
  })
})

describe('the build id closes the image-only deploy', () => {
  test('a new commit moves the fingerprint even when nothing else changed', () => {
    // Every other variable identical — this is exactly the deploy that shipped
    // a new image and left the old container serving.
    const policy = { WALGIT_PUBLIC: '1', WALGIT_RETENTION_HOURS: '24' }

    expect(fingerprintEnv({ ...policy, WALGIT_BUILD_ID: '22294ea' })).not.toBe(
      fingerprintEnv({ ...policy, WALGIT_BUILD_ID: 'd7dec9b' }),
    )
  })

  test('a running container is replaced when only the build id moved', async () => {
    const policy = { WALGIT_PUBLIC: '1' }
    const booted = fingerprintEnv({ ...policy, WALGIT_BUILD_ID: '22294ea' })
    const target = fakeTarget({ running: true, booted })

    const outcome = await reconcileContainerEnv(
      target.port,
      fingerprintEnv({ ...policy, WALGIT_BUILD_ID: 'd7dec9b' }),
    )

    expect(outcome).toBe('replaced')
    expect(target.transcript).toContain('destroy')
  })
})
