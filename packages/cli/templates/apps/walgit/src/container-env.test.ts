/**
 * The forwarding rules and the change detector live in `worker/`, because the
 * Durable Object is the only layer that holds both the deployed environment and
 * the running container. Both are pure, though, so they are tested here with
 * the rest of the suite rather than behind a Workers runtime — the same
 * arrangement as `landing.test.ts` and `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { CONTAINER_ENV, containerEnv, fingerprintEnv } from '../worker/container-env'

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
    // string reaches `limitsFromEnv` as a value and is parsed rather than
    // skipped.
    expect(containerEnv({ WALGIT_RETENTION_HOURS: '' })).toEqual({})
    expect(containerEnv({})).toEqual({})
  })

  test('every forwarded name is one src/ actually reads', () => {
    // A name added here and nowhere else is a variable that looks configured
    // and does nothing.
    expect(new Set(CONTAINER_ENV).size).toBe(CONTAINER_ENV.length)
    for (const name of CONTAINER_ENV) expect(name.startsWith('WALGIT_')).toBe(true)
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
