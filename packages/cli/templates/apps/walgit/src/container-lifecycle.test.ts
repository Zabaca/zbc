/**
 * The container's lifetime rules (`shared/container-lifecycle.ts`), tested
 * here because they are pure: `WalgitDurableContainer` only feeds them the
 * clock, its counters and its storage, and does what they say.
 */

import { describe, expect, test } from 'bun:test'

import {
  BOOT_BUDGET_MS,
  CONTAINER_INSTANCE,
  INFLIGHT_MAX_MS,
  MAX_INACTIVITY_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  containerPolicyFrom,
  freshStartTimeoutMs,
  idleVerdict,
  inactivityTimeoutMs,
  mayRetry,
  rearmAt,
} from '../shared/container-lifecycle'

const MIN = 60 * 1000

describe('idleVerdict', () => {
  test('stops a container idle for the whole window', () => {
    expect(
      idleVerdict({ now: 10 * MIN, inflight: 0, lastActivity: 5 * MIN, sleepAfterMs: 5 * MIN }),
    ).toEqual({ stop: true })
  })

  test('re-arms for the true deadline when it fired early', () => {
    // The alarm was left where it was by `rearmAt`'s slack, and a request
    // finished since: the deadline is that request's, not the alarm's.
    expect(
      idleVerdict({ now: 10 * MIN, inflight: 0, lastActivity: 7 * MIN, sleepAfterMs: 5 * MIN }),
    ).toEqual({ stop: false, at: 12 * MIN })
  })

  test('never stops with a request in flight, however old', () => {
    // A clone that has streamed for an hour is one request, started an hour
    // ago. The window is measured from when the last one FINISHED.
    expect(
      idleVerdict({ now: 60 * MIN, inflight: 1, lastActivity: 0, sleepAfterMs: 5 * MIN }),
    ).toEqual({ stop: false, at: 65 * MIN })
  })

  test('an object with no memory of a request is due', () => {
    // Evicted and reconstructed by the alarm itself: nothing was in flight (a
    // request in flight keeps the object resident), and the alarm was armed
    // for the deadline.
    expect(
      idleVerdict({ now: 10 * MIN, inflight: 0, lastActivity: null, sleepAfterMs: 5 * MIN }),
    ).toEqual({ stop: true })
  })
})

describe('rearmAt', () => {
  test('arms when it does not know of an alarm', () => {
    expect(rearmAt({ now: 0, scheduled: null, sleepAfterMs: 5 * MIN })).toBe(5 * MIN)
  })

  test('leaves an alarm already within the slack of the new deadline', () => {
    // A burst of requests costs one storage write, not one per request.
    expect(rearmAt({ now: 1000, scheduled: 5 * MIN, sleepAfterMs: 5 * MIN })).toBeNull()
  })

  test('moves an alarm that would fire well before the new deadline', () => {
    expect(rearmAt({ now: 2 * MIN, scheduled: 5 * MIN, sleepAfterMs: 5 * MIN })).toBe(7 * MIN)
  })

  test('the slack is a tenth of the window, and never more than 30 s', () => {
    // 20 minutes: a tenth would be two minutes, capped at 30 s.
    const sleepAfterMs = 20 * MIN
    expect(rearmAt({ now: 0, scheduled: sleepAfterMs - 30_000, sleepAfterMs })).toBeNull()
    expect(rearmAt({ now: 0, scheduled: sleepAfterMs - 31_000, sleepAfterMs })).toBe(sleepAfterMs)
    // 30 seconds: a tenth is 3 s.
    expect(rearmAt({ now: 0, scheduled: 27_000, sleepAfterMs: 30_000 })).toBeNull()
    expect(rearmAt({ now: 0, scheduled: 26_000, sleepAfterMs: 30_000 })).toBe(30_000)
  })
})

describe('inactivityTimeoutMs', () => {
  test('lands after the alarm, so the platform never stops first', () => {
    expect(inactivityTimeoutMs(5 * MIN)).toBeGreaterThan(5 * MIN)
  })

  test('never exceeds what setInactivityTimeout accepts', () => {
    expect(inactivityTimeoutMs(6 * 60 * MIN)).toBe(MAX_INACTIVITY_TIMEOUT_MS)
    expect(inactivityTimeoutMs(24 * 60 * MIN)).toBe(MAX_INACTIVITY_TIMEOUT_MS)
  })
})

describe('mayRetry', () => {
  test('a bodiless read is retried once', () => {
    expect(mayRetry('GET', 0)).toBe(true)
    expect(mayRetry('HEAD', 0)).toBe(true)
    expect(mayRetry('GET', 1)).toBe(false)
  })

  test('a push is never retried — its body is already spent', () => {
    expect(mayRetry('POST', 0)).toBe(false)
    expect(mayRetry('PUT', 0)).toBe(false)
  })
})

test('the instance is one the durable_object policy accepts', () => {
  // `basic`, the old application's size, is refused by this policy at runtime.
  expect(['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4']).toContain(
    CONTAINER_INSTANCE,
  )
  expect(CONTAINER_INSTANCE).not.toBe('lite')
})

describe('containerPolicyFrom', () => {
  test('unset, blank or anything else is the default-policy container', () => {
    // The deploy that introduces the new application routes nowhere new.
    for (const value of [undefined, '', 'default', 'durable-object', 'DURABLE_OBJECT', '1']) {
      expect(containerPolicyFrom({ WALGIT_CONTAINER_POLICY: value })).toBe('default')
    }
  })

  test('the exact word moves the traffic', () => {
    expect(containerPolicyFrom({ WALGIT_CONTAINER_POLICY: 'durable_object' })).toBe(
      'durable_object',
    )
    expect(containerPolicyFrom({ WALGIT_CONTAINER_POLICY: ' durable_object ' })).toBe(
      'durable_object',
    )
  })
})

describe('freshStartTimeoutMs', () => {
  test('a start is bounded in seconds, not minutes', () => {
    expect(freshStartTimeoutMs(0)).toBe(READY_TIMEOUT_MS)
    expect(READY_TIMEOUT_MS).toBeLessThanOrEqual(BOOT_BUDGET_MS)
  })

  test('a failed restore leaves the fresh start what is left of the budget', () => {
    expect(freshStartTimeoutMs(8_000)).toBe(BOOT_BUDGET_MS - 8_000)
  })

  test('but never too little to come up at all', () => {
    expect(freshStartTimeoutMs(BOOT_BUDGET_MS)).toBe(5_000)
  })
})

test('a request is let go of within the hour, whoever holds its body', () => {
  expect(INFLIGHT_MAX_MS).toBe(60 * 60 * 1000)
})
