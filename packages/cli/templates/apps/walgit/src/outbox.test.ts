/**
 * The backpressure policy, driven against a fake socket and a hand-wound clock.
 *
 * The fake has exactly what the Workers runtime gives — `send` and `close` —
 * because that is the point of this policy: it reads nothing off the socket, so
 * a stand-in cannot flatter it. What the tests drive instead is time, which is
 * the only input the policy has.
 */

import { describe, expect, test } from 'bun:test'

import type { RefEvent } from '../shared/events'
import {
  COALESCE_WINDOW_MS,
  DEAD_SOCKET_CLOSE_CODE,
  Outbox,
  type OutboxOptions,
} from '../shared/outbox'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function event(ref: string, sha: string | null, repo = 'demo'): RefEvent {
  return { repo, ref, sha }
}

/** A socket with exactly what the Workers runtime offers: send and close. */
class FakeSink {
  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null
  throwOnSend = false

  send(data: string): void {
    if (this.throwOnSend) throw new Error('socket is gone')
    this.sent.push(data)
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }

  /** What the client actually received, decoded. */
  received(): RefEvent[] {
    return this.sent.map((line) => JSON.parse(line) as RefEvent)
  }
}

/** A clock and timer queue the test winds by hand. */
class TestClock {
  private t = 0
  private timers: { at: number; fn: () => void }[] = []
  /** Every delay the outbox asked for, so a test can assert it armed nothing. */
  readonly scheduled: number[] = []

  /** Timers armed and not yet fired — what a leak would show up as. */
  get live(): number {
    return this.timers.length
  }

  readonly now = (): number => this.t

  readonly schedule = (fn: () => void, ms: number): void => {
    this.scheduled.push(ms)
    this.timers.push({ at: this.t + ms, fn })
  }

  /** Move time forward, running whatever comes due on the way. */
  advance(ms: number): void {
    this.t += ms
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= this.t)
      if (due.length === 0) return
      this.timers = this.timers.filter((timer) => timer.at > this.t)
      for (const timer of due) timer.fn()
    }
  }
}

interface Harness {
  sink: FakeSink
  clock: TestClock
  outbox: Outbox
}

function harness(): Harness {
  const sink = new FakeSink()
  const clock = new TestClock()
  const options: OutboxOptions = { now: clock.now, schedule: clock.schedule }
  return { sink, clock, outbox: new Outbox(sink, options) }
}

describe('a ref moving no faster than its window', () => {
  test('every event goes out immediately, in order', () => {
    const { sink, clock, outbox } = harness()

    outbox.offer([event('refs/heads/main', SHA_A)])
    clock.advance(COALESCE_WINDOW_MS)
    outbox.offer([event('refs/heads/main', SHA_B)])

    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_A),
      event('refs/heads/main', SHA_B),
    ])
    expect(outbox.size).toBe(0)
    expect(sink.closed).toBeNull()
  })

  test('nothing is left waiting on a timer', () => {
    const { clock, outbox } = harness()

    outbox.offer([event('refs/heads/main', SHA_A)])

    expect(clock.scheduled).toEqual([])
  })
})

describe('a ref moving faster than its window', () => {
  // The whole reason events are latest-state: the intermediate sha has no
  // reader, so sending it would be work nobody asked for.
  test('two rapid pushes to one ref deliver the newest sha once', () => {
    const { sink, clock, outbox } = harness()

    expect(outbox.offer([event('refs/heads/main', SHA_A)]).sent).toBe(1)
    clock.advance(1)
    const second = outbox.offer([event('refs/heads/main', SHA_B)])

    expect(second.sent).toBe(0)
    expect(second.pending).toBe(1)
    expect(sink.received()).toEqual([event('refs/heads/main', SHA_A)])

    // …and when the window comes up, one message carrying the latest.
    clock.advance(COALESCE_WINDOW_MS)
    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_A),
      event('refs/heads/main', SHA_B),
    ])
    expect(outbox.size).toBe(0)
  })

  test('a third push inside the window replaces the second, and reports it', () => {
    const { sink, clock, outbox } = harness()

    outbox.offer([event('refs/heads/main', SHA_A)])
    outbox.offer([event('refs/heads/main', SHA_B)])
    const third = outbox.offer([event('refs/heads/main', SHA_C)])

    expect(third.coalesced).toBe(1)
    clock.advance(COALESCE_WINDOW_MS)
    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_A),
      event('refs/heads/main', SHA_C),
    ])
  })

  test('the window is per repository and ref, not across them', () => {
    const { sink, outbox } = harness()

    // main is already inside its window; a first event for another repo's ref
    // must not be held behind it.
    outbox.offer([event('refs/heads/main', SHA_A)])
    const other = outbox.offer([
      event('refs/heads/main', SHA_B),
      event('refs/heads/next', SHA_A, 'other'),
    ])

    expect(other.sent).toBe(1)
    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_A),
      event('refs/heads/next', SHA_A, 'other'),
    ])
  })

  // Memory behind a socket is bounded by the refs it watches, not by how hard
  // anyone is pushing.
  test('a queue does not grow with the push rate', () => {
    const { outbox } = harness()

    for (let i = 0; i < 1000; i++) outbox.offer([event('refs/heads/main', SHA_A)])

    expect(outbox.size).toBe(1)
  })

  // The rate bound is the whole policy, so it gets an assertion of its own:
  // 1000 pushes over four windows can be at most five messages for one ref.
  test('the message rate is bounded by the window, not by the push rate', () => {
    const { sink, clock, outbox } = harness()

    for (let i = 0; i < 1000; i++) {
      outbox.offer([event('refs/heads/main', SHA_A)])
      clock.advance(1)
    }

    expect(sink.sent.length).toBeLessThanOrEqual(5)
    expect(sink.sent.length).toBeGreaterThan(0)
  })

  test('a deletion supersedes a queued sha', () => {
    const { sink, clock, outbox } = harness()

    outbox.offer([event('refs/heads/gone', SHA_A)])
    outbox.offer([event('refs/heads/gone', SHA_B)])
    outbox.offer([event('refs/heads/gone', null)])

    clock.advance(COALESCE_WINDOW_MS)
    expect(sink.received()).toEqual([
      event('refs/heads/gone', SHA_A),
      event('refs/heads/gone', null),
    ])
  })

  // A client that acted on a sha and then received an older one would fetch
  // backwards. The order the shas were pushed in is the independent truth here.
  test('a client never receives a sha older than one it already has', () => {
    const { sink, clock, outbox } = harness()
    const pushed = [SHA_A, SHA_B, SHA_C]

    for (const sha of pushed) {
      outbox.offer([event('refs/heads/main', sha)])
      clock.advance(30)
    }
    clock.advance(COALESCE_WINDOW_MS)

    const seen = sink.received().map((received) => received.sha)
    const order = seen.map((sha) => pushed.indexOf(sha as string))
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(seen.at(-1)).toBe(SHA_C)
  })
})

describe('a socket that will not take writes', () => {
  // A socket the runtime has already torn down throws on send. There is nothing
  // to retry and nothing owed, so the queue goes with it.
  test('is dropped rather than retried', () => {
    const { sink, outbox } = harness()
    sink.throwOnSend = true

    const result = outbox.offer([event('refs/heads/main', SHA_A)])

    expect(result.closed).toBe(true)
    expect(outbox.isClosed).toBe(true)
    expect(outbox.size).toBe(0)
    expect(sink.closed?.code).toBe(DEAD_SOCKET_CLOSE_CODE)
    expect(sink.closed?.reason).toContain('reconnect')
  })

  test('takes no further work, and queues nothing after the drop', () => {
    const { sink, clock, outbox } = harness()
    sink.throwOnSend = true
    outbox.offer([event('refs/heads/main', SHA_A)])
    sink.throwOnSend = false

    for (let i = 0; i < 100; i++) outbox.offer([event(`refs/heads/b${i}`, SHA_C)])
    clock.advance(COALESCE_WINDOW_MS * 10)

    expect(outbox.size).toBe(0)
    expect(sink.sent).toEqual([])
  })
})

describe('the timer behind a held event', () => {
  // A burst across many refs is the shape that leaked: an outbox that re-armed
  // whenever something came due sooner would hold one timer per ref, inside the
  // Durable Object, which is the memory this file exists to bound.
  test('a burst across many refs arms one timer, not one per ref', () => {
    const { clock, outbox } = harness()

    // Stagger the first send of 20 refs, so each has its own deadline…
    for (let i = 0; i < 20; i++) {
      outbox.offer([event(`refs/heads/b${i}`, SHA_A)])
      clock.advance(1)
    }
    // …then move every one of them again, newest deadline first.
    for (let i = 19; i >= 0; i--) outbox.offer([event(`refs/heads/b${i}`, SHA_B)])

    expect(clock.live).toBe(1)
  })

  test('every ref in that burst still ends at its newest sha', () => {
    const { sink, clock, outbox } = harness()

    for (let i = 0; i < 20; i++) {
      outbox.offer([event(`refs/heads/b${i}`, SHA_A)])
      clock.advance(1)
    }
    for (let i = 19; i >= 0; i--) outbox.offer([event(`refs/heads/b${i}`, SHA_B)])
    clock.advance(COALESCE_WINDOW_MS * 2)

    const latest = new Map(sink.received().map((received) => [received.ref, received.sha]))
    expect(latest.size).toBe(20)
    for (let i = 0; i < 20; i++) expect(latest.get(`refs/heads/b${i}`)).toBe(SHA_B)
    expect(outbox.size).toBe(0)
    expect(clock.live).toBe(0)
  })
})
