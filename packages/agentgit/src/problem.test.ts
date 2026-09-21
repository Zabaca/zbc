/**
 * When a machine that cannot present a credential says so.
 *
 * The latch is the whole of it: a watcher reconnects with a backoff, so the
 * same misconfiguration is decided again every few seconds, and the difference
 * between one useful sentence and a scrolling wall is entirely here. Driven
 * through the emitter, because that is the only place the behaviour is
 * observable — everything a watcher says goes through one `Emit`.
 */

import { describe, expect, test } from 'bun:test'

import type { Authorization } from './credential'
import { credentialProblems } from './problem'
import type { Emit } from './watch'

const ORIGIN = 'https://agentgit.co'

const NO_KEY: Authorization = {
  kind: 'problem',
  code: 'no-signing-key',
  message: 'this machine has no key to prove',
}

const NO_SIGNATURE: Authorization = {
  kind: 'problem',
  code: 'no-signature',
  message: 'the key could not sign the challenge',
}

const HEADER: Authorization = { kind: 'header', header: 'Basic abc' }

/** The emitter and what it saw, as a watcher's `--json` consumer would see it. */
function sink(): { emit: Emit; events: { event: string; fields: Record<string, unknown> }[] } {
  const events: { event: string; fields: Record<string, unknown> }[] = []
  return { emit: (event, fields) => void events.push({ event, fields }), events }
}

describe('credentialProblems', () => {
  test('a problem is reported once, however many connects decide it again', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, NO_KEY)

    expect(events).toEqual([
      {
        event: 'credential-problem',
        fields: {
          origin: ORIGIN,
          code: 'no-signing-key',
          problem: 'this machine has no key to prove',
        },
      },
    ])
  })

  test('the event carries a human line as well as its fields', () => {
    const said: string[] = []
    const problems = credentialProblems((_event, _fields, human) => void said.push(human))
    problems.report(ORIGIN, NO_KEY)
    expect(said).toEqual([`${ORIGIN}: this machine has no key to prove`])
  })

  test('a header clears the latch, so a later recurrence is reported again', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, HEADER)
    problems.report(ORIGIN, NO_KEY)

    expect(events.map((seen) => seen.event)).toEqual(['credential-problem', 'credential-problem'])
  })

  test('a header on its own says nothing — a working machine is not news', () => {
    const { emit, events } = sink()
    credentialProblems(emit).report(ORIGIN, HEADER)
    expect(events).toEqual([])
  })

  test('nothing to present is the ordinary public case: no event, and no clear', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, { kind: 'none' })
    problems.report(ORIGIN, NO_KEY)

    expect(events.map((seen) => seen.event)).toEqual(['credential-problem'])
  })

  test('two problems on one origin are two latches, each reported once', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, NO_SIGNATURE)
    problems.report(ORIGIN, NO_KEY)
    problems.report(ORIGIN, NO_SIGNATURE)

    expect(events.map((seen) => seen.fields.code)).toEqual(['no-signing-key', 'no-signature'])
  })

  test('the same problem at two origins is reported for each', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report('http://node.local:8080', NO_KEY)

    expect(events.map((seen) => seen.fields.origin)).toEqual([ORIGIN, 'http://node.local:8080'])
  })

  test('a header at one origin does not clear another origin’s problem', () => {
    const { emit, events } = sink()
    const problems = credentialProblems(emit)

    problems.report(ORIGIN, NO_KEY)
    problems.report('http://node.local:8080', HEADER)
    problems.report(ORIGIN, NO_KEY)

    expect(events).toHaveLength(1)
  })
})
