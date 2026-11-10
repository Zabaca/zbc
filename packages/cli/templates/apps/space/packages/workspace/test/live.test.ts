// The words the live object and the stores that tell it share: what a message may say, what a page is sent, and that telling can never fail or wait on the change that caused it.
import { describe, expect, test } from 'bun:test'
import { EVERYONE, LIVE_NAME, type LiveMessage, isFor, liveFrame, openPeople, ownersOf, parseLiveFrame, parseLiveMessage, teamOf, tellLive } from '../src'
import { northfield } from './helpers'

/** A namespace that records the messages it is told and the names it was asked for. */
function recorder(opts: { tell?: (m: LiveMessage) => unknown; open?: () => unknown } = {}) {
  const told: LiveMessage[] = []
  const names: string[] = []
  const ns = {
    idFromName: (name: string) => {
      names.push(name)
      return name
    },
    get: () => ({
      tell: (m: LiveMessage) => {
        told.push(m)
        return opts.tell?.(m)
      },
      openPeople: () => opts.open?.() ?? [],
    }),
  }
  return { ns, told, names }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a message', () => {
  test('names a part, the people it is for and perhaps one conversation; anything else is refused', () => {
    expect(parseLiveMessage({ part: 'chat', people: ['A@Northfield.example'], conversation: 'chat:channel:3' })).toEqual({ part: 'chat', people: ['a@northfield.example'], conversation: 'chat:channel:3' })
    expect(parseLiveMessage({ part: 'calls', people: EVERYONE })).toEqual({ part: 'calls', people: EVERYONE })
    for (const bad of [null, 'chat', {}, { part: 'weather', people: [] }, { part: 'mail', people: 'some' }, { part: 'mail', people: [7] }, { part: 'mail', people: [''] }, { part: 'mail', people: [], conversation: '' }, { part: 'mail', people: [], conversation: 4 }]) {
      expect([bad, parseLiveMessage(bad)]).toEqual([bad, null])
    }
    expect(parseLiveMessage({ part: 'mail', people: Array.from({ length: 201 }, (_, i) => `p${i}@x.example.com`) })).toBeNull()
  })

  test('is for the people it names, or for everyone', () => {
    expect(isFor({ part: 'mail', people: ['a@northfield.example'] }, ' A@northfield.example ')).toBe(true)
    expect(isFor({ part: 'mail', people: ['a@northfield.example'] }, 'b@northfield.example')).toBe(false)
    expect(isFor({ part: 'calls', people: EVERYONE }, 'anyone@northfield.example')).toBe(true)
  })

  test('reaches the page as the part and the conversation, and nothing of who it was for', () => {
    const frame = liveFrame({ part: 'chat', people: ['a@northfield.example'], conversation: 'chat:7' })
    expect(JSON.parse(frame)).toEqual({ t: 'changed', part: 'chat', conversation: 'chat:7' })
    expect(frame).not.toContain('northfield.example')
    expect(parseLiveFrame(frame)).toEqual({ part: 'chat', conversation: 'chat:7' })
    expect(parseLiveFrame(liveFrame({ part: 'mail', people: EVERYONE }))).toEqual({ part: 'mail' })
  })

  test('a page reads a frame as a frame only when it is one it knows', () => {
    for (const other of ['pong', 'not json', '{"t":"changed","part":"weather"}', '{"t":"hello"}', '{"t":"changed","part":"mail","conversation":""}', 'null', '7']) expect([other, parseLiveFrame(other)]).toEqual([other, null])
  })
})

describe('telling', () => {
  test('goes to the company’s one object by its fixed name, and returns before the object has answered', async () => {
    const r = recorder({ tell: () => new Promise(() => {}) }) // never answers
    const done = tellLive(r.ns, { part: 'mail', people: ['a@northfield.example'] })
    expect(done).toBeUndefined()
    await settle()
    expect(r.names).toEqual([LIVE_NAME])
    expect(r.told).toEqual([{ part: 'mail', people: ['a@northfield.example'] }])
  })

  test('does nothing where no object is bound', () => {
    expect(() => tellLive(undefined, { part: 'mail', people: EVERYONE })).not.toThrow()
    expect(() => tellLive(null, { part: 'mail', people: EVERYONE })).not.toThrow()
  })

  test('a message that cannot be delivered, in any of the ways it can fail, never throws into the change that caused it', async () => {
    const quiet = console.warn
    const warnings: unknown[][] = []
    console.warn = (...a: unknown[]) => void warnings.push(a)
    try {
      expect(() => tellLive({}, { part: 'mail', people: EVERYONE })).not.toThrow() // not a namespace at all
      expect(() =>
        tellLive(
          recorder({
            tell: () => {
              throw new Error('down')
            },
          }).ns,
          { part: 'mail', people: EVERYONE },
        ),
      ).not.toThrow()
      expect(() => tellLive(recorder({ tell: () => Promise.reject(new Error('refused')) }).ns, { part: 'mail', people: EVERYONE })).not.toThrow()
      await settle()
      await settle()
      expect(warnings.length).toBe(3)
      // The reason is logged, the message (who, what) is not.
      expect(JSON.stringify(warnings)).not.toContain('people')
    } finally {
      console.warn = quiet
    }
  })

  test('a Worker request is kept alive until the message is out', async () => {
    const r = recorder()
    const kept: Promise<unknown>[] = []
    tellLive(r.ns, { part: 'documents', people: ['a@northfield.example'] }, (p) => void kept.push(p))
    expect(kept).toHaveLength(1)
    await kept[0]
    expect(r.told).toHaveLength(1)
  })
})

describe('who has the space open', () => {
  test('is what the object says', async () => {
    expect(await openPeople(recorder({ open: () => ['a@northfield.example', 'b@northfield.example'] }).ns)).toEqual(['a@northfield.example', 'b@northfield.example'])
  })

  test('is nobody where it is not bound, does not answer in time, or fails: never a wait and never an error', async () => {
    const quiet = console.warn
    console.warn = () => {}
    try {
      expect(await openPeople(undefined)).toEqual([])
      expect(await openPeople(recorder({ open: () => new Promise(() => {}) }).ns, 20)).toEqual([])
      expect(await openPeople(recorder({ open: () => Promise.reject(new Error('down')) }).ns)).toEqual([])
      expect(await openPeople(recorder({ open: () => 'nonsense' }).ns)).toEqual([])
    } finally {
      console.warn = quiet
    }
  })
})

test('the owners and the whole team are read from the install', () => {
  const install = northfield()
  expect(ownersOf(install).length).toBeGreaterThan(0)
  expect(ownersOf(install).every((a) => install.people.some((p) => p.address === a && install.isOwner(p)))).toBe(true)
  expect(teamOf(install)).toEqual(install.people.map((p) => p.address))
})
