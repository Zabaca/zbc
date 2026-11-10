import { describe, expect, test } from 'bun:test'
import { type Install, NOT_ADMITTED, type SignedIn, type SpaceReply, signedIn } from '@space/workspace'
import { createSpaceKnowledge } from '../src/space'
import type { KnowledgeObject } from '../src/store-access'
import { SAME_AS_AN_ENTRY } from '../src/store'
import { AGENT, harness, OWNER, WITH_TEAMMATE, NORTHFIELD } from '../test-support/harness'

/**
 * The knowledge app as the space calls it, driven the way the space drives it: the person its one sign-in check named, first, over a real store.
 * The sign-in check itself (no assertion, forged, expired, a service token, an unset audience) is the space's now and is proven in packages/space; what is
 * left here is this app's own rule, the owner and no one else.
 */

/** The person the space's check would have named, for an address of `install`. */
const asPerson = (install: Install, address: string): SignedIn => {
  const person = install.people.find((p) => p.address === address)
  if (!person) throw new Error(`no such person: ${address}`)
  return signedIn(person, 4_000_000_000)
}

async function wired(options: { install?: Install } = {}) {
  const h = harness()
  const install = options.install ?? NORTHFIELD
  const entry = createSpaceKnowledge({ store: h.api, install })
  return { h, install, entry, owner: () => asPerson(install, OWNER) }
}

const ok = <T>(r: SpaceReply<T>): T => {
  if (!r.ok) throw new Error(`not ok: ${r.kind} ${r.reason}: ${r.message}`)
  return r.value
}
const no = (r: SpaceReply<unknown>) => {
  if (r.ok) throw new Error('expected a refusal or a failure')
  return { kind: r.kind, reason: r.reason, message: r.message }
}

describe('who is admitted', () => {
  test('the owner reads the base and changes it', async () => {
    const { entry, owner } = await wired()
    const a = await owner()
    const made = ok(await entry.changeKnowledge(a, { do: 'add', title: 'Hours', body: 'Open.', businesses: ['ridgeway-cycles'] }))
    expect(made).toMatchObject({ title: 'Hours', createdBy: OWNER, businesses: ['ridgeway-cycles'] })
    const base = ok(await entry.knowledge(a))
    expect(base.entries.map((e) => e.title)).toEqual(['Hours'])
    expect(base.businesses).toEqual([
      { id: 'northfield', name: 'Northfield Works' },
      { id: 'ridgeway-cycles', name: 'Ridgeway Cycles' },
      { id: 'shiftlantern', name: 'ShiftLantern' },
      { id: 'quill', name: 'quill.example' },
    ])
    expect(base.business).toBeNull()
  })

  test('a teammate who is not an owner is not admitted, though the space signed them in', async () => {
    const { h, entry } = await wired({ install: WITH_TEAMMATE })
    const teammate = asPerson(WITH_TEAMMATE, 'dana@northfield.example')
    for (const a of [teammate]) {
      expect(no(await entry.knowledge(a))).toEqual({ kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
      expect(no(await entry.changeKnowledge(a, { do: 'add', title: 't', body: 'b', businesses: ['northfield'] })).reason).toBe('not-admitted')
    }
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
    // The owner of the same install still gets in.
    expect(ok(await entry.knowledge(asPerson(WITH_TEAMMATE, OWNER))).entries).toEqual([])
  })

  test('the actor stamped on a write is the owner’s address, never anything the caller typed', async () => {
    const { h, entry, owner } = await wired()
    ok(await entry.changeKnowledge(await owner(), { do: 'add', title: 'Hours', body: 'Open.', businesses: ['northfield'], by: AGENT } as never))
    expect(h.rows<{ actor: string }>('SELECT actor FROM audit').map((r) => r.actor)).toEqual([OWNER])
  })
})

describe('reading', () => {
  test('with a business named, the entries marked for it, every status; an unknown business is not found', async () => {
    const { h, entry, owner } = await wired()
    const a = await owner()
    ok(await entry.changeKnowledge(a, { do: 'add', title: 'F', body: 'f', businesses: ['ridgeway-cycles'] }))
    ok(await entry.changeKnowledge(a, { do: 'add', title: 'R', body: 'r', businesses: ['shiftlantern'] }))
    h.store.propose({ title: 'P', body: 'p', businesses: ['ridgeway-cycles'] }, AGENT)
    const ridgeway = ok(await entry.knowledge(a, 'ridgeway-cycles'))
    expect(ridgeway.business).toBe('ridgeway-cycles')
    expect(ridgeway.entries.map((e) => [e.title, e.status])).toEqual([
      ['F', 'active'],
      ['P', 'proposed'],
    ])
    expect(ok(await entry.knowledge(a, 'northfield')).entries).toEqual([])
    expect(no(await entry.knowledge(a, 'nobody')).reason).toBe('not-found')
    expect(no(await entry.knowledge(a, '../etc')).reason).toBe('not-found')
  })
})

describe('changing', () => {
  const add = (title = 'Hours', body = 'Open Saturdays.', businesses = ['ridgeway-cycles']) => ({ do: 'add', title, body, businesses }) as const

  test('adding, editing the words and the businesses, removing, putting back: each as the owner, the version named each time', async () => {
    const { entry, owner } = await wired()
    const a = await owner()
    const made = ok(await entry.changeKnowledge(a, add()))
    const edited = ok(await entry.changeKnowledge(a, { do: 'edit', id: made.id, version: 1, body: 'Open daily.', businesses: ['ridgeway-cycles', 'northfield'] }))
    expect(edited).toMatchObject({ body: 'Open daily.', businesses: ['northfield', 'ridgeway-cycles'], version: 2 })
    const removed = ok(await entry.changeKnowledge(a, { do: 'remove', id: made.id, version: 2 }))
    expect(removed.status).toBe('removed')
    const back = ok(await entry.changeKnowledge(a, { do: 'restore', id: made.id, version: 2 }))
    expect(back).toMatchObject({ status: 'active', version: 3 })
  })

  test('approving and rejecting Claude’s proposals, and the businesses a proposal names are applied by the approval', async () => {
    const { h, entry, owner } = await wired()
    const a = await owner()
    const p = ok(await entry.changeKnowledge(a, add('Hours', 'Open.', ['northfield'])))
    const change = h.store.propose({ body: 'Open late.', businesses: ['northfield', 'shiftlantern'], replaces: p.id }, AGENT)
    if (!change.ok) throw new Error(change.error)
    const applied = ok(await entry.changeKnowledge(a, { do: 'approve', id: change.value.id, version: 1 }))
    expect(applied).toMatchObject({ id: p.id, body: 'Open late.', businesses: ['northfield', 'shiftlantern'], updatedBy: OWNER })
    const second = h.store.propose({ title: 'Price', body: '$40.', businesses: ['northfield'] }, AGENT)
    if (!second.ok) throw new Error(second.error)
    expect(ok(await entry.changeKnowledge(a, { do: 'reject', id: second.value.id, version: 1 })).status).toBe('removed')
  })

  test('the refusals arrive as the contract’s reasons with the words to show: a stale version, a duplicate, no business, an unknown entry', async () => {
    const { entry, owner } = await wired()
    const a = await owner()
    const made = ok(await entry.changeKnowledge(a, add()))
    ok(await entry.changeKnowledge(a, { do: 'edit', id: made.id, version: 1, body: 'Open daily.' }))
    expect(no(await entry.changeKnowledge(a, { do: 'edit', id: made.id, version: 1, body: 'Closed.' }))).toMatchObject({ kind: 'refused', reason: 'conflict' })
    expect(no(await entry.changeKnowledge(a, add('Hours', 'Open daily.', ['shiftlantern'])))).toEqual({ kind: 'refused', reason: 'conflict', message: SAME_AS_AN_ENTRY })
    expect(no(await entry.changeKnowledge(a, add('Other', 'Words.', [])))).toMatchObject({ reason: 'bad-request', message: 'An entry needs at least one business, so that some assistant reads it.' })
    expect(no(await entry.changeKnowledge(a, { do: 'remove', id: 'missing', version: 1 })).reason).toBe('not-found')
  })

  test('a change that is not the contract’s shape is a bad request and changes nothing', async () => {
    const { h, entry, owner } = await wired()
    const a = await owner()
    const bad: unknown[] = [
      null,
      'add',
      {},
      { do: 'burn' },
      { do: 'add', title: 1, body: 'b', businesses: ['northfield'] },
      { do: 'add', title: 't', body: 'b' },
      { do: 'add', title: 't', body: 'b', businesses: 'northfield' },
      { do: 'add', title: 't', body: 'b', businesses: [1] },
      { do: 'edit', id: 'e1', version: 'one' },
      { do: 'edit', id: 'e1', version: 1, title: 5 },
      { do: 'edit', id: 'e1', version: 1, businesses: 'northfield' },
      { do: 'remove', id: 'e1' },
      { do: 'remove', id: 'a/b', version: 1 },
    ]
    for (const change of bad) expect([change, no(await entry.changeKnowledge(a, change as never)).kind]).toEqual([change, 'refused'])
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('a store that throws is a failure with a sentence, not an exception across the binding', async () => {
    const down = createSpaceKnowledge({ store: { call: () => Promise.reject(new Error('the object is gone')) }, install: NORTHFIELD })
    const a = asPerson(NORTHFIELD, OWNER)
    const failure = { kind: 'failed', reason: 'broken', message: 'The knowledge base could not answer that. Nothing was changed.' } as const
    expect(no(await down.knowledge(a))).toEqual(failure)
    expect(no(await down.changeKnowledge(a, { do: 'add', title: 't', body: 'b', businesses: ['northfield'] }))).toEqual(failure)
  })
})

describe('the operator’s three: bookmark, restart and restore', () => {
  const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'
  /** The object, recorded: `restart` throws as an aborted object does under its caller. */
  function object() {
    const calls: string[] = []
    const obj: KnowledgeObject = {
      bookmark: async () => (calls.push('bookmark'), BOOKMARK),
      restoreTo: async (b) => (calls.push(`restoreTo ${b}`), BOOKMARK),
      restart: async () => {
        calls.push('restart')
        throw new Error('Durable Object reset because its code was updated.')
      },
    }
    return { calls, obj }
  }
  const wiredWith = async (install = NORTHFIELD) => {
    const o = object()
    const h = harness()
    return { ...o, entry: createSpaceKnowledge({ store: h.api, install, object: o.obj }), owner: asPerson(install, OWNER) }
  }

  test('the owner takes a bookmark, restarts the object (its reset is the answer, not a failure), and restores to a bookmark: armed, then restarted', async () => {
    const { entry, owner, calls } = await wiredWith()
    expect(ok(await entry.storeBookmark(owner))).toEqual({ bookmark: BOOKMARK })
    expect(ok(await entry.restartStore(owner))).toEqual({ restarted: true })
    expect(ok(await entry.restoreStore(owner, BOOKMARK))).toEqual({ restoring: true })
    expect(calls).toEqual(['bookmark', 'restart', `restoreTo ${BOOKMARK}`, 'restart'])
  })

  test('a teammate who is not an owner is not admitted to any of the three, and the object is not touched', async () => {
    const { entry, calls } = await wiredWith(WITH_TEAMMATE)
    const dana = asPerson(WITH_TEAMMATE, 'dana@northfield.example')
    for (const r of [await entry.storeBookmark(dana), await entry.restartStore(dana), await entry.restoreStore(dana, BOOKMARK)]) expect(no(r).reason).toBe('not-admitted')
    expect(calls).toEqual([])
  })

  test('a restore to anything that is not a bookmark is a bad request and arms nothing', async () => {
    const { entry, owner, calls } = await wiredWith()
    for (const bad of ['', 'latest', '../etc', BOOKMARK.toUpperCase(), `${BOOKMARK}0`, undefined as never]) expect([bad, no(await entry.restoreStore(owner, bad)).reason]).toEqual([bad, 'bad-request'])
    expect(calls).toEqual([])
  })

  test('with no object to reach, each answers a failure with a sentence', async () => {
    const entry = createSpaceKnowledge({ store: harness().api, install: NORTHFIELD })
    const owner = asPerson(NORTHFIELD, OWNER)
    for (const r of [await entry.storeBookmark(owner), await entry.restartStore(owner), await entry.restoreStore(owner, BOOKMARK)]) expect(no(r)).toMatchObject({ kind: 'failed', reason: 'broken' })
  })
})
