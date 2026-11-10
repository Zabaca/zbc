import { describe, expect, test } from 'bun:test'
import { KNOWLEDGE_FOR_INBOX_METHODS, type SpaceReply } from '@space/workspace'
import { createInboxKnowledge } from '../src/inbox'
import { AGENT, harness, OWNER, NORTHFIELD } from '../test-support/harness'

/**
 * The knowledge app's entrypoint for the inbox: what an assistant is given, what Claude's script reads, and what it proposes.
 * No assertion, and no way to change anything an assistant says.
 */

function wired() {
  const h = harness()
  const entry = createInboxKnowledge({ store: h.api, install: NORTHFIELD })
  return { h, entry }
}

const ok = <T>(r: SpaceReply<T>): T => {
  if (!r.ok) throw new Error(`not ok: ${r.kind} ${r.reason}: ${r.message}`)
  return r.value
}
const no = <T>(r: SpaceReply<T>) => {
  if (r.ok) throw new Error('expected a refusal or a failure')
  return { kind: r.kind, reason: r.reason, message: r.message }
}

describe('what an assistant is given', () => {
  test('the active entries of the conversation’s business, and a Ridgeway conversation never holds a ShiftLantern-only or Northfield Works-only one', async () => {
    const { h, entry } = wired()
    h.store.add('Northfield Works only', 'z', ['northfield'], OWNER)
    h.store.add('Ridgeway only', 'f', ['ridgeway-cycles'], OWNER)
    h.store.add('Both', 'fr', ['ridgeway-cycles', 'shiftlantern'], OWNER)
    h.store.add('ShiftLantern only', 'r', ['shiftlantern'], OWNER)
    h.store.propose({ title: 'Waiting', body: 'w', businesses: ['ridgeway-cycles'] }, AGENT)
    expect(ok(await entry.activeFor('ridgeway-cycles')).map((t) => t.title)).toEqual(['Ridgeway only', 'Both'])
    expect(ok(await entry.activeFor('shiftlantern')).map((t) => t.title)).toEqual(['Both', 'ShiftLantern only'])
    expect(ok(await entry.activeFor('northfield')).map((t) => t.title)).toEqual(['Northfield Works only'])
  })

  test('a business with no entry is an empty list, and a business the declaration does not list is not found', async () => {
    const { entry } = wired()
    expect(ok(await entry.activeFor('northfield'))).toEqual([])
    expect(no(await entry.activeFor('nobody')).reason).toBe('not-found')
    expect(no(await entry.activeFor('Northfield Works; DROP')).reason).toBe('not-found')
    expect(no(await entry.activeFor(undefined as never)).reason).toBe('not-found')
  })

  test('it answers words and nothing else', async () => {
    const { h, entry } = wired()
    h.store.add('Hours', 'Open.', ['northfield'], OWNER)
    expect(ok(await entry.activeFor('northfield'))).toEqual([{ title: 'Hours', body: 'Open.' }])
  })
})

describe('Claude’s script, through the inbox', () => {
  test('reads the whole base, or one business’s, every status, with the businesses to choose from', async () => {
    const { h, entry } = wired()
    h.store.add('F', 'f', ['ridgeway-cycles'], OWNER)
    h.store.add('R', 'r', ['shiftlantern'], OWNER)
    h.store.propose({ title: 'P', body: 'p', businesses: ['ridgeway-cycles'] }, AGENT)
    const all = ok(await entry.readBase())
    expect(all.entries.map((e) => [e.title, e.status])).toEqual([
      ['F', 'active'],
      ['R', 'active'],
      ['P', 'proposed'],
    ])
    expect(all.business).toBeNull()
    expect(all.businesses.map((b) => b.id)).toEqual(['northfield', 'ridgeway-cycles', 'shiftlantern', 'quill'])
    const ridgeway = ok(await entry.readBase('ridgeway-cycles'))
    expect(ridgeway.entries.map((e) => e.title)).toEqual(['F', 'P'])
    expect(ridgeway.business).toBe('ridgeway-cycles')
    expect(no(await entry.readBase('nobody')).reason).toBe('not-found')
  })

  test('proposes a new entry for the businesses it is true for: one proposal, not three copies, recorded as Claude’s', async () => {
    const { h, entry } = wired()
    const p = ok(await entry.propose(AGENT, { title: 'Refunds', body: 'Within 30 days.', businesses: ['shiftlantern', 'northfield', 'ridgeway-cycles'] }))
    expect(p).toMatchObject({ status: 'proposed', proposedBy: AGENT, createdBy: AGENT, businesses: ['northfield', 'ridgeway-cycles', 'shiftlantern'] })
    expect(h.rows('SELECT * FROM knowledge_entry')).toHaveLength(1)
    // And nothing reads it yet.
    expect(ok(await entry.activeFor('northfield'))).toEqual([])
    expect(h.rows<{ actor: string }>('SELECT actor FROM audit').map((r) => r.actor)).toEqual([AGENT])
  })

  test('proposes a change to the words or the businesses of an entry, and what it leaves out is the entry’s', async () => {
    const { h, entry } = wired()
    const made = h.store.add('Hours', 'Open.', ['northfield'], OWNER)
    if (!made.ok) throw new Error(made.error)
    const words = ok(await entry.propose(AGENT, { body: 'Open late.', replaces: made.value.id }))
    expect(words).toMatchObject({ title: 'Hours', body: 'Open late.', businesses: ['northfield'], replaces: made.value.id })
    const who = ok(await entry.propose(AGENT, { businesses: ['northfield', 'shiftlantern'], replaces: made.value.id }))
    expect(who).toMatchObject({ body: 'Open.', businesses: ['northfield', 'shiftlantern'] })
  })

  test('a proposal with no business is refused, and so is one from anyone who is not an agent', async () => {
    const { h, entry } = wired()
    expect(no(await entry.propose(AGENT, { title: 't', body: 'b' }))).toMatchObject({ kind: 'refused', reason: 'bad-request' })
    expect(no(await entry.propose(AGENT, { title: 't', body: 'b', businesses: [] })).reason).toBe('bad-request')
    expect(no(await entry.propose(AGENT, { title: 't', body: 'b', businesses: ['nobody'] })).reason).toBe('bad-request')
    expect(no(await entry.propose(OWNER, { title: 't', body: 'b', businesses: ['northfield'] })).reason).toBe('not-admitted')
    expect(no(await entry.propose(undefined as never, { title: 't', body: 'b', businesses: ['northfield'] })).reason).toBe('bad-request')
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('a proposal that is not the contract’s shape is a bad request', async () => {
    const { h, entry } = wired()
    for (const proposal of [null, 'x', { title: 1, body: 'b', businesses: ['northfield'] }, { title: 't', body: 2, businesses: ['northfield'] }, { title: 't', body: 'b', businesses: 'northfield' }, { body: 'b', replaces: 5 }, { body: 'b', replaces: 'a/b' }]) {
      expect([proposal, no(await entry.propose(AGENT, proposal as never)).reason]).toEqual([proposal, 'bad-request'])
    }
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('at most fifty proposals wait at once, across the base: the fifty-first is the limit', async () => {
    const { entry } = wired()
    for (let i = 0; i < 50; i++) ok(await entry.propose(AGENT, { title: `T${i}`, body: `b${i}`, businesses: ['northfield'] }))
    expect(no(await entry.propose(AGENT, { title: 'More', body: 'x', businesses: ['shiftlantern'] })).reason).toBe('limit')
  })

  test('a store that throws is a failure with a sentence, never an exception', async () => {
    const entry = createInboxKnowledge({ store: { call: () => Promise.reject(new Error('gone')) }, install: NORTHFIELD })
    expect(no(await entry.activeFor('northfield'))).toMatchObject({ kind: 'failed', reason: 'broken' })
    expect(no(await entry.readBase())).toMatchObject({ kind: 'failed', reason: 'broken' })
    expect(no(await entry.propose(AGENT, { title: 't', body: 'b', businesses: ['northfield'] }))).toMatchObject({ kind: 'failed', reason: 'broken' })
  })
})

test('its object has exactly the contract’s methods, so nothing that edits, removes or approves can be reached', () => {
  const { entry } = wired()
  expect(Object.keys(entry).sort()).toEqual([...KNOWLEDGE_FOR_INBOX_METHODS].sort())
})
