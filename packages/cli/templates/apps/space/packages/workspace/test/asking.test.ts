import { describe, expect, test } from 'bun:test'
import {
  ANSWER_WITHIN_MS,
  answered,
  COMPOSE_KEY,
  failed,
  NOT_ADMITTED,
  NOT_SIGNED_IN,
  refused,
  repeated,
  type SpaceReply,
  unanswered,
  WRITE_WITHIN_MS,
  type WriteReply,
} from '../src'

describe('what a refusal and a failure look like', () => {
  test('a decision and a fault are told apart by kind, and neither is an exception', () => {
    const replies: SpaceReply<number>[] = [
      answered(1),
      refused('conflict', 'The draft changed.'),
      failed('Gmail would not take it.'),
    ]
    expect(replies.map((r) => (r.ok ? 'value' : r.kind))).toEqual(['value', 'refused', 'failed'])
    // narrowing: a space that handles `kind` handles every reply
    for (const r of replies) {
      if (r.ok) expect(r.value).toBe(1)
      else if (r.kind === 'refused') expect(r.reason).toBe('conflict')
      else expect(r.reason).toBe('broken')
    }
  })

  test('an app can say only `broken`; the other failures are the space’s own type', () => {
    expect(failed('x').reason).toBe('broken')
    const mine = unanswered('outcome-unknown', 'The space lost track of the send.')
    expect(mine).toMatchObject({ ok: false, kind: 'failed', reason: 'outcome-unknown' })
    // @ts-expect-error an app's `Failed` has no other reason
    const notAnApps: ReturnType<typeof failed> = mine
    expect(notAnApps.reason as string).toBe('outcome-unknown')
  })

  test('the space waits a few seconds for a read, and longer than the inbox waits on Gmail for a write', () => {
    expect(ANSWER_WITHIN_MS).toBeGreaterThanOrEqual(2000)
    expect(ANSWER_WITHIN_MS).toBeLessThanOrEqual(5000)
    expect(WRITE_WITHIN_MS).toBeGreaterThan(25_000) // the inbox's SEND_TIMEOUT_MS
  })
})

describe('a write goes out at most once', () => {
  test('a repeated key is a refusal that says how the first went, or that it is still going', () => {
    const done: WriteReply<{ id: string }> = repeated({ state: 'done', reply: answered({ id: 'm1' }) })
    const going: WriteReply<{ id: string }> = repeated({ state: 'in-progress' })
    for (const r of [done, going]) expect(r).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated' })
    expect(done.ok === false && done.reason === 'repeated' && done.earlier).toEqual({ state: 'done', reply: { ok: true, value: { id: 'm1' } } })
    expect(going.ok === false && going.reason === 'repeated' && going.earlier).toEqual({ state: 'in-progress' })
  })

  test('a compose key is 16 to 128 characters of letters, digits, underscore and hyphen', () => {
    expect(COMPOSE_KEY.test(crypto.randomUUID())).toBe(true)
    expect(COMPOSE_KEY.test('a'.repeat(16))).toBe(true)
    for (const bad of ['', 'short', 'a'.repeat(129), 'has space 0123456789', 'no/slash/0123456789']) expect(COMPOSE_KEY.test(bad)).toBe(false)
  })
})
