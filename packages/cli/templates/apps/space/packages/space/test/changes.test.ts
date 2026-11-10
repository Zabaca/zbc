// The page's queue of closes and reopens (client/changes.ts) on its own: what is shown at once, the order the calls are made in, what a refusal takes with it, and when the overlay may go.
import { describe, expect, test } from 'bun:test'
import { createChanges } from '../src/client/changes'

const held = () => {
  let go!: () => void
  const wait = new Promise<void>((r) => (go = r))
  return { wait, go }
}
const ok = (text: string, done: string[]) => ({ notice: { tone: 'ok' as const, text }, done })
const bad = (text: string) => ({ notice: { tone: 'error' as const, text }, done: [] as string[] })
const refusal = (text: string, refused: string[]) => ({ notice: { tone: 'warn' as const, text }, done: [] as string[], refused })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('a change is shown before the call is made', () => {
  test('the threads are shown changed and the row leaves the lists the moment it is submitted', async () => {
    const c = createChanges()
    const gate = held()
    const ended = c.submit({ kind: 'close', ids: ['a'], row: { key: 'r', leaves: true }, hope: 'Closed.', run: async () => (await gate.wait, ok('Closed.', ['a'])) })
    expect(c.snapshot().threads.get('a')).toBe(false)
    expect(c.snapshot().rows.has('r')).toBe(true)
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['Closed.'])
    expect(c.busy(['a'])).toBe(true)
    gate.go()
    await ended
    expect(c.busy(['a'])).toBe(false)
    // It stays shown until a read that began after it ended has landed.
    expect(c.snapshot().threads.get('a')).toBe(false)
    c.release('threads', Date.now() - 10_000)
    expect(c.snapshot().threads.has('a')).toBe(true)
    c.release('threads', Date.now() + 1)
    expect(c.snapshot().threads.has('a')).toBe(false)
    expect(c.snapshot().rows.has('r')).toBe(true)
    c.release('rows', Date.now() + 1)
    expect(c.snapshot().rows.has('r')).toBe(false)
  })

  test('a change that failed is not shown any more, at once, and says why', async () => {
    const c = createChanges()
    await c.submit({ kind: 'close', ids: ['a'], row: { key: 'r', leaves: true }, hope: 'Closed.', run: async () => bad('Not closed.') })
    expect(c.snapshot().threads.size).toBe(0)
    expect(c.snapshot().rows.size).toBe(0)
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['Not closed.'])
  })
})

describe('the calls are made one at a time in the order pressed', () => {
  test('a second is not made until the first has ended', async () => {
    const c = createChanges()
    const order: string[] = []
    const gate = held()
    c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (order.push('a start'), await gate.wait, order.push('a end'), ok('Closed.', ['a'])) })
    const second = c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => (order.push('b start'), ok('Closed.', ['b'])) })
    await tick()
    expect(order).toEqual(['a start'])
    gate.go()
    await second
    expect(order).toEqual(['a start', 'a end', 'b start'])
  })

  test('a Reopen of what a Close is closing is made after it', async () => {
    const c = createChanges()
    const order: string[] = []
    const gate = held()
    c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (await gate.wait, order.push('close'), ok('Closed.', ['a'])) })
    const re = c.submit({ kind: 'reopen', ids: ['a'], hope: 'Reopened.', run: async () => (order.push('reopen'), ok('Reopened.', ['a'])) })
    // It is shown open at once, though the Close has not been made.
    expect(c.snapshot().threads.get('a')).toBe(true)
    gate.go()
    await re
    expect(order).toEqual(['close', 'reopen'])
    expect(c.snapshot().threads.get('a')).toBe(true)
  })

  test('a Close the inbox refused takes the Reopen behind it out: it is not made, and its words are not told', async () => {
    const c = createChanges()
    const gate = held()
    let reopened = false
    c.submit({ kind: 'close', ids: ['a', 'b'], hope: 'Closed.', run: async () => (await gate.wait, { notice: { tone: 'warn' as const, text: 'Closed 1 of 2.' }, done: ['b'], refused: ['a'] }) })
    const re = c.submit({ kind: 'reopen', ids: ['a'], hope: 'Reopened.', run: async () => ((reopened = true), ok('Reopened.', ['a'])) })
    gate.go()
    await re
    expect(reopened).toBe(false)
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['Closed 1 of 2.'])
    // `a` is open as the inbox has it; `b` is closed.
    expect([...c.snapshot().threads]).toEqual([['b', false]])
  })

  test('a Reopen that is for more than the failed Close is still made for the rest', async () => {
    const c = createChanges()
    const gate = held()
    let asked: readonly string[] = []
    c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (await gate.wait, refusal('no', ['a'])) })
    const re = c.submit({ kind: 'reopen', ids: ['a', 'b'], hope: 'Reopened.', run: async (ids) => ((asked = ids), ok('Reopened.', [...ids])) })
    gate.go()
    await re
    expect(asked).toEqual(['b'])
  })
})

describe('what is told', () => {
  test('a failure is not hidden by a later success, and a success replaces the success before it', async () => {
    const c = createChanges()
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => bad('a failed') })
    await c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => ok('Closed.', ['b']) })
    await c.submit({ kind: 'close', ids: ['c'], hope: 'Closed.', run: async () => ok('Closed.', ['c']) })
    expect(c.snapshot().told.map((t) => [t.ids[0], t.notice.text])).toEqual([['a', 'a failed'], ['c', 'Closed.']])
  })

  test('two failures are both told, and a failure is let go when the same thread is changed again', async () => {
    const c = createChanges()
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => bad('a failed') })
    await c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => bad('b failed') })
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['a failed', 'b failed'])
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => ok('Closed.', ['a']) })
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['b failed', 'Closed.'])
  })

  test('a success that finishes after a newer one was pressed does not take its place', async () => {
    const c = createChanges()
    const gate = held()
    const first = c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (await gate.wait, ok('Closed. Older.', ['a'])) })
    const second = c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => ok('Closed. Newer.', ['b']) })
    gate.go()
    await Promise.all([first, second])
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['Closed. Newer.'])
  })

  test('a call that throws is told as not known, and shows the thread as it stands', async () => {
    const c = createChanges()
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => Promise.reject(new Error('boom')) })
    expect(c.snapshot().threads.size).toBe(0)
    expect(c.snapshot().told[0]?.notice.text).toContain('not known')
  })

  test('idle resolves when everything submitted has ended', async () => {
    const c = createChanges()
    const gate = held()
    let ended = false
    c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (await gate.wait, (ended = true), ok('Closed.', ['a'])) })
    const idle = c.idle()
    gate.go()
    await idle
    expect(ended).toBe(true)
  })
})

describe('a refusal and an outcome not known are not the same', () => {
  test('a Close whose outcome is not known leaves the Reopen behind it to be sent: the close may have gone through', async () => {
    const c = createChanges()
    const gate = held()
    let asked: readonly string[] = []
    c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => (await gate.wait, bad('not known')) })
    const re = c.submit({ kind: 'reopen', ids: ['a'], hope: 'Reopened.', run: async (ids) => ((asked = ids), ok('Reopened.', [...ids])) })
    gate.go()
    await re
    expect(asked).toEqual(['a'])
  })
})

describe('one change that goes wrong does not stop the ones behind it', () => {
  test('a callback that throws when its change ended', async () => {
    const c = createChanges()
    let second = false
    await c.submit({
      kind: 'close',
      ids: ['a'],
      hope: 'Closed.',
      run: async () => ok('Closed.', ['a']),
      settled: () => {
        throw new Error('screen gone')
      },
    })
    await c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => ((second = true), ok('Closed.', ['b'])) })
    expect(second).toBe(true)
  })

  test('a screen that throws when it is told', async () => {
    const c = createChanges()
    c.subscribe(() => {
      throw new Error('redraw failed')
    })
    let second = false
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => ok('Closed.', ['a']) })
    await c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => ((second = true), ok('Closed.', ['b'])) })
    expect(second).toBe(true)
  })
})

describe('dismissing', () => {
  test('a notice is put away by its number, and only that one', async () => {
    const c = createChanges()
    await c.submit({ kind: 'close', ids: ['a'], hope: 'Closed.', run: async () => bad('a failed') })
    await c.submit({ kind: 'close', ids: ['b'], hope: 'Closed.', run: async () => bad('b failed') })
    const [first] = c.snapshot().told
    c.dismiss([first?.seq as number])
    expect(c.snapshot().told.map((t) => t.notice.text)).toEqual(['b failed'])
  })
})
