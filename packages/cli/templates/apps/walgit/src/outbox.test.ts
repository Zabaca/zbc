/**
 * The backpressure policy, driven against a fake socket.
 *
 * `bufferedAmount` is the only thing the real policy reads, so a fake that lets
 * a test set it is a complete stand-in — which is the point of keeping the
 * policy out of the Durable Object: none of this needs a Workers runtime.
 */

import { describe, expect, test } from 'bun:test'

import type { RefEvent } from '../shared/events'
import {
  COALESCE_WATERMARK,
  MAX_BUFFERED_BYTES,
  Outbox,
  SLOW_CONSUMER_CLOSE_CODE,
} from '../shared/outbox'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function event(ref: string, sha: string | null, repo = 'demo'): RefEvent {
  return { repo, ref, sha }
}

/** A socket whose drain the test drives by hand. */
class FakeSink {
  bufferedAmount = 0
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

describe('a reader that keeps up', () => {
  test('gets every event, in order', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)

    outbox.offer([event('refs/heads/main', SHA_A)])
    outbox.offer([event('refs/heads/main', SHA_B)])

    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_A),
      event('refs/heads/main', SHA_B),
    ])
    expect(outbox.size).toBe(0)
    expect(sink.closed).toBeNull()
  })
})

describe('a reader that is behind', () => {
  // The whole reason events are latest-state: the intermediate sha has no
  // reader, so queueing it would be work nobody asked for.
  test('two rapid pushes to one ref deliver the newest sha once', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = COALESCE_WATERMARK

    expect(outbox.offer([event('refs/heads/main', SHA_A)]).sent).toBe(0)
    const second = outbox.offer([event('refs/heads/main', SHA_B)])

    expect(second.coalesced).toBe(1)
    expect(outbox.size).toBe(1)
    expect(sink.sent).toEqual([])

    // …and when it drains, one message carrying the latest.
    sink.bufferedAmount = 0
    outbox.flush()
    expect(sink.received()).toEqual([event('refs/heads/main', SHA_B)])
  })

  test('coalesces per repository and ref, not across them', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = COALESCE_WATERMARK

    outbox.offer([event('refs/heads/main', SHA_A), event('refs/heads/next', SHA_A, 'other')])
    outbox.offer([event('refs/heads/main', SHA_B), event('refs/heads/next', SHA_B, 'other')])

    expect(outbox.size).toBe(2)

    sink.bufferedAmount = 0
    outbox.flush()
    expect(sink.received()).toEqual([
      event('refs/heads/main', SHA_B),
      event('refs/heads/next', SHA_B, 'other'),
    ])
  })

  // Memory behind a slow reader is bounded by the refs it watches, not by how
  // hard anyone is pushing.
  test('a queue does not grow with the push rate', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = COALESCE_WATERMARK

    for (let i = 0; i < 1000; i++) outbox.offer([event('refs/heads/main', SHA_A)])

    expect(outbox.size).toBe(1)
  })

  test('a deletion supersedes a queued sha', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = COALESCE_WATERMARK

    outbox.offer([event('refs/heads/gone', SHA_A)])
    outbox.offer([event('refs/heads/gone', null)])

    sink.bufferedAmount = 0
    outbox.flush()
    expect(sink.received()).toEqual([event('refs/heads/gone', null)])
  })
})

describe('a reader that will not drain', () => {
  test('is closed, and its queue is dropped', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = MAX_BUFFERED_BYTES

    const result = outbox.offer([event('refs/heads/main', SHA_A)])

    expect(result.closed).toBe(true)
    expect(outbox.isClosed).toBe(true)
    expect(outbox.size).toBe(0)
    expect(sink.closed?.code).toBe(SLOW_CONSUMER_CLOSE_CODE)
    expect(sink.closed?.reason).toContain('reconnect')
  })

  test('takes no further work, and buffers nothing after the close', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.bufferedAmount = MAX_BUFFERED_BYTES
    outbox.offer([event('refs/heads/main', SHA_A)])

    for (let i = 0; i < 100; i++) outbox.offer([event(`refs/heads/b${i}`, SHA_C)])

    expect(outbox.size).toBe(0)
    expect(sink.sent).toEqual([])
  })

  // A socket the runtime has already torn down throws on send. That is the same
  // situation as one that will not drain, and gets the same answer.
  test('a socket that throws on send is dropped rather than retried', () => {
    const sink = new FakeSink()
    const outbox = new Outbox(sink)
    sink.throwOnSend = true

    const result = outbox.offer([event('refs/heads/main', SHA_A)])

    expect(result.closed).toBe(true)
    expect(outbox.isClosed).toBe(true)
    expect(outbox.size).toBe(0)
    expect(sink.closed?.code).toBe(SLOW_CONSUMER_CLOSE_CODE)
  })
})
