import { describe, expect, test } from 'bun:test'
import { KNOWLEDGE_MAX_BODY, KNOWLEDGE_MAX_TITLE, KNOWLEDGE_MOST_PROPOSALS } from '@space/workspace'
import { cleaned, KNOWLEDGE_CHANGED, KnowledgeStore, PROPOSAL_OUT_OF_DATE, SAME_AS_AN_ENTRY } from '../src/store'
import { AGENT, harness, OWNER, T0 } from '../test-support/harness'

/**
 * The knowledge base's rules, over a real SQLite with the real migration (the rules the inbox's knowledge store held per mailbox,
 * re-keyed by business). Prior art: packages/inbox/test/knowledge.test.ts.
 */

const ALL = ['northfield', 'ridgeway-cycles', 'shiftlantern']

const value = <T>(r: { ok: true; value: T } | { ok: false; reason: string; error: string }): T => {
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.error}`)
  return r.value
}
const refusal = (r: { ok: boolean; reason?: string; error?: string }) => {
  if (r.ok) throw new Error('expected a refusal')
  return { reason: r.reason, error: r.error }
}

describe('the owner adds, edits, removes and puts back', () => {
  test('an added entry is active at once, marked for its businesses, with its first version by the owner', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open Saturdays 9 to 1.', ['ridgeway-cycles'], OWNER))
    expect(made).toMatchObject({
      id: 'e1',
      title: 'Hours',
      body: 'Open Saturdays 9 to 1.',
      businesses: ['ridgeway-cycles'],
      status: 'active',
      proposedBy: null,
      replaces: null,
      createdBy: OWNER,
      updatedBy: OWNER,
      version: 1,
    })
    expect(made.versions).toEqual([
      { seq: 1, by: OWNER, at: T0, title: 'Hours', body: 'Open Saturdays 9 to 1.', businesses: ['ridgeway-cycles'] },
    ])
  })

  test('the businesses of an entry are kept in the declaration’s order, once each, whatever order they were named in', () => {
    const h = harness()
    const made = value(h.store.add('Refunds', 'Within 30 days.', ['shiftlantern', 'northfield', 'shiftlantern'], OWNER))
    expect(made.businesses).toEqual(['northfield', 'shiftlantern'])
  })

  test('“every business” is the three ticked and the three are what is stored', () => {
    const h = harness()
    const made = value(h.store.add('Company', 'Northfield Works LLC.', ALL, OWNER))
    expect(made.businesses).toEqual(ALL)
    expect(h.rows<{ business_id: string }>('SELECT business_id FROM knowledge_entry_business ORDER BY business_id').map((r) => r.business_id)).toEqual(
      [...ALL].sort(),
    )
  })

  test('an entry needs at least one business, each one the declaration lists', () => {
    const h = harness()
    for (const bad of [[], undefined, null, 'northfield', [''], ['nobody'], ['northfield', 'nobody'], [1]]) {
      expect([bad, refusal(h.store.add('Hours', 'Open.', bad, OWNER)).reason]).toEqual([bad, 'bad-request'])
    }
    expect(refusal(h.store.add('Hours', 'Open.', [], OWNER)).error).toBe('An entry needs at least one business, so that some assistant reads it.')
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('a title is one line within its cap and a body is there and within its cap', () => {
    const h = harness()
    expect(value(h.store.add('Two\n   lines', '  Body  ', ['northfield'], OWNER))).toMatchObject({ title: 'Two lines', body: 'Body' })
    expect(refusal(h.store.add('  ', 'x', ['northfield'], OWNER)).reason).toBe('bad-request')
    expect(refusal(h.store.add('x', '  ', ['northfield'], OWNER)).reason).toBe('bad-request')
    expect(refusal(h.store.add('t'.repeat(KNOWLEDGE_MAX_TITLE + 1), 'x', ['northfield'], OWNER)).reason).toBe('bad-request')
    expect(refusal(h.store.add('t', 'b'.repeat(KNOWLEDGE_MAX_BODY + 1), ['northfield'], OWNER)).reason).toBe('bad-request')
  })

  test('the same title and body as an active entry is a conflict, whatever its businesses, and says to add the business to that entry', () => {
    const h = harness()
    value(h.store.add('Hours', 'Open Saturdays.', ['ridgeway-cycles'], OWNER))
    const again = refusal(h.store.add('  Hours ', 'Open Saturdays.\n', ['shiftlantern'], OWNER))
    expect(again).toEqual({ reason: 'conflict', error: SAME_AS_AN_ENTRY })
    expect(SAME_AS_AN_ENTRY).toContain('add that business to that entry')
    expect(h.rows('SELECT * FROM knowledge_entry')).toHaveLength(1)
    // A removed entry no longer says it: the same words may be added again.
    const first = value(h.store.entries(null))[0]!
    value(h.store.remove(first.id, 1, OWNER))
    expect(value(h.store.add('Hours', 'Open Saturdays.', ['shiftlantern'], OWNER)).status).toBe('active')
  })

  test('an edit is a new version by the owner, every earlier one kept, and the same words are no change', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open Saturdays 9 to 1.', ['ridgeway-cycles'], OWNER))
    h.tick()
    const edited = value(h.store.edit(made.id, { body: 'Open Saturdays 9 to 2.', version: 1 }, OWNER))
    expect(edited).toMatchObject({ body: 'Open Saturdays 9 to 2.', version: 2, updatedAt: T0 + 60_000 })
    h.tick()
    const retitled = value(h.store.edit(made.id, { title: 'Weekend hours', version: 2 }, OWNER))
    expect(retitled).toMatchObject({ title: 'Weekend hours', body: 'Open Saturdays 9 to 2.', version: 3 })
    expect(retitled.versions.map((v) => [v.seq, v.title, v.body])).toEqual([
      [1, 'Hours', 'Open Saturdays 9 to 1.'],
      [2, 'Hours', 'Open Saturdays 9 to 2.'],
      [3, 'Weekend hours', 'Open Saturdays 9 to 2.'],
    ])
    const same = value(h.store.edit(made.id, { title: 'Weekend hours', body: 'Open Saturdays 9 to 2.', businesses: ['ridgeway-cycles'], version: 3 }, OWNER))
    expect(same.version).toBe(3)
    expect(h.rows('SELECT * FROM knowledge_version')).toHaveLength(3)
  })

  test('a change of businesses alone is a version, with who made it and when, and the entry is read by the new set', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open Saturdays.', ['ridgeway-cycles'], OWNER))
    h.tick(3_600_000)
    const wider = value(h.store.edit(made.id, { businesses: ['shiftlantern', 'ridgeway-cycles'], version: 1 }, OWNER))
    expect(wider).toMatchObject({ businesses: ['ridgeway-cycles', 'shiftlantern'], version: 2, title: 'Hours', body: 'Open Saturdays.' })
    expect(wider.versions[1]).toEqual({
      seq: 2,
      by: OWNER,
      at: T0 + 3_600_000,
      title: 'Hours',
      body: 'Open Saturdays.',
      businesses: ['ridgeway-cycles', 'shiftlantern'],
    })
    // The first version still says who it was for before.
    expect(wider.versions[0]!.businesses).toEqual(['ridgeway-cycles'])
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([{ title: 'Hours', body: 'Open Saturdays.' }])
    // And taking a business back is a version too, after which that business reads nothing of it.
    const narrower = value(h.store.edit(made.id, { businesses: ['northfield'], version: 2 }, OWNER))
    expect(narrower).toMatchObject({ businesses: ['northfield'], version: 3 })
    expect(value(h.store.activeFor('ridgeway-cycles'))).toEqual([])
    expect(value(h.store.activeFor('northfield'))).toEqual([{ title: 'Hours', body: 'Open Saturdays.' }])
    // A change to no business at all is refused, and an undeclared business too.
    expect(refusal(h.store.edit(made.id, { businesses: [], version: 3 }, OWNER)).reason).toBe('bad-request')
    expect(refusal(h.store.edit(made.id, { businesses: ['nobody'], version: 3 }, OWNER)).reason).toBe('bad-request')
  })

  test('an edit over an entry that has moved on is a conflict and changes nothing', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    value(h.store.edit(made.id, { body: 'Open daily.', version: 1 }, OWNER))
    expect(refusal(h.store.edit(made.id, { body: 'Closed.', version: 1 }, OWNER))).toEqual({ reason: 'conflict', error: KNOWLEDGE_CHANGED })
    expect(value(h.store.entries(null))[0]).toMatchObject({ body: 'Open daily.', version: 2 })
    expect(refusal(h.store.edit(made.id, { body: 'x' } as never, OWNER)).reason).toBe('bad-request')
    expect(refusal(h.store.edit('missing', { body: 'x', version: 1 }, OWNER)).reason).toBe('not-found')
  })

  test('a removal keeps the row and every version, the assistants stop reading it, and putting it back is a version by the owner', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield', 'shiftlantern'], OWNER))
    h.tick()
    const removed = value(h.store.remove(made.id, 1, OWNER))
    expect(removed).toMatchObject({ status: 'removed', version: 1 })
    expect(value(h.store.activeFor('northfield'))).toEqual([])
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([])
    expect(refusal(h.store.remove(made.id, 1, OWNER)).error).toBe('This entry is already removed.')
    expect(refusal(h.store.edit(made.id, { body: 'x', version: 1 }, OWNER)).error).toContain('Put it back first')
    h.tick()
    const back = value(h.store.restore(made.id, 1, OWNER))
    expect(back).toMatchObject({ status: 'active', version: 2, businesses: ['northfield', 'shiftlantern'] })
    expect(back.versions[1]).toMatchObject({ by: OWNER, at: T0 + 120_000 })
    expect(value(h.store.activeFor('northfield'))).toEqual([{ title: 'Hours', body: 'Open.' }])
    expect(refusal(h.store.restore(made.id, 2, OWNER)).error).toBe('Only a removed entry is put back.')
  })

  test('only an owner changes the base: anyone else, an agent included, is refused by every write, and nothing is written', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    const proposed = value(h.store.propose({ title: 'Price', body: '$40.', businesses: ['northfield'] }, AGENT))
    for (const actor of [AGENT, 'dana@northfield.example', '']) {
      const attempts = [
        h.store.add('x', 'y', ['northfield'], actor),
        h.store.edit(made.id, { body: 'z', version: 1 }, actor),
        h.store.remove(made.id, 1, actor),
        h.store.restore(made.id, 1, actor),
        h.store.approve(proposed.id, 1, actor),
        h.store.reject(proposed.id, 1, actor),
      ]
      for (const a of attempts) expect([actor, refusal(a).reason]).toEqual([actor, 'not-admitted'])
    }
    expect(value(h.store.entries(null)).map((e) => [e.id, e.status, e.version])).toEqual([
      ['e1', 'active', 1],
      ['e2', 'proposed', 1],
    ])
  })
})

describe('what an assistant reads', () => {
  test('a business reads the active entries marked for it, oldest first, and nothing else', () => {
    const h = harness()
    value(h.store.add('Northfield Works only', 'z', ['northfield'], OWNER))
    h.tick()
    value(h.store.add('Ridgeway only', 'f', ['ridgeway-cycles'], OWNER))
    h.tick()
    value(h.store.add('Ridgeway and ShiftLantern', 'fr', ['shiftlantern', 'ridgeway-cycles'], OWNER))
    h.tick()
    value(h.store.add('ShiftLantern only', 'r', ['shiftlantern'], OWNER))
    value(h.store.propose({ title: 'Waiting', body: 'w', businesses: ['ridgeway-cycles'] }, AGENT))
    const gone = value(h.store.add('Removed', 'x', ['ridgeway-cycles'], OWNER))
    value(h.store.remove(gone.id, 1, OWNER))

    const titles = (b: string) => value(h.store.activeFor(b)).map((t) => t.title)
    expect(titles('ridgeway-cycles')).toEqual(['Ridgeway only', 'Ridgeway and ShiftLantern'])
    expect(titles('shiftlantern')).toEqual(['Ridgeway and ShiftLantern', 'ShiftLantern only'])
    expect(titles('northfield')).toEqual(['Northfield Works only'])
    // What it is given is words and nothing else: no id, no businesses of other mailboxes, no proposer.
    expect(Object.keys(value(h.store.activeFor('northfield'))[0]!).sort()).toEqual(['body', 'title'])
  })

  test('a business with no entry reads none (empty is a state, not an error), and a business the declaration does not list is not found', () => {
    const h = harness()
    expect(value(h.store.activeFor('northfield'))).toEqual([])
    expect(refusal(h.store.activeFor('nobody'))).toEqual({ reason: 'not-found', error: 'No such business.' })
    expect(refusal(h.store.entries('nobody')).reason).toBe('not-found')
  })

  test('a business added to the declaration later starts with no entries, even after “every business” was ticked before it', () => {
    const before = harness({ businesses: ALL })
    value(before.store.add('Company', 'Northfield Works LLC.', ALL, OWNER))
    // The same base, read by a build whose declaration has gained a fourth business.
    const later = new KnowledgeStore({
      sql: before.sql,
      transaction: before.transaction,
      now: () => new Date(T0),
      newId: () => 'x',
      businesses: [...ALL, 'new-business'],
      owners: [OWNER],
      ownerName: 'Tessa',
    })
    expect(value(later.activeFor('new-business'))).toEqual([])
    expect(value(later.activeFor('northfield'))).toHaveLength(1)
  })

  test('the whole base is every status in the tab’s order, and one business’s is the entries marked for it', () => {
    const h = harness()
    const a = value(h.store.add('A', 'a', ['northfield'], OWNER))
    h.tick()
    value(h.store.add('B', 'b', ['ridgeway-cycles'], OWNER))
    h.tick()
    value(h.store.propose({ title: 'P', body: 'p', businesses: ['northfield', 'ridgeway-cycles'] }, AGENT))
    value(h.store.remove(a.id, 1, OWNER))
    expect(value(h.store.entries(null)).map((e) => [e.title, e.status])).toEqual([
      ['B', 'active'],
      ['P', 'proposed'],
      ['A', 'removed'],
    ])
    expect(value(h.store.entries('northfield')).map((e) => e.title)).toEqual(['P', 'A'])
    expect(value(h.store.entries('ridgeway-cycles')).map((e) => e.title)).toEqual(['B', 'P'])
    expect(value(h.store.entries('shiftlantern'))).toEqual([])
  })
})

describe('Claude proposes, and the owner decides', () => {
  test('a proposal is not read by any assistant until it is approved, and approving makes it active as a version by the owner', () => {
    const h = harness()
    const p = value(h.store.propose({ title: 'Price', body: 'The plan is $40 a month.', businesses: ['ridgeway-cycles', 'shiftlantern'] }, AGENT))
    expect(p).toMatchObject({ status: 'proposed', proposedBy: AGENT, createdBy: AGENT, replaces: null, version: 1, businesses: ['ridgeway-cycles', 'shiftlantern'] })
    expect(value(h.store.activeFor('ridgeway-cycles'))).toEqual([])
    h.tick()
    const approved = value(h.store.approve(p.id, 1, OWNER))
    expect(approved).toMatchObject({ status: 'active', version: 2, updatedBy: OWNER, proposedBy: AGENT })
    expect(approved.versions.map((v) => v.by)).toEqual([AGENT, OWNER])
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([{ title: 'Price', body: 'The plan is $40 a month.' }])
    expect(refusal(h.store.approve(p.id, 2, OWNER)).error).toBe('Only a proposal is approved.')
  })

  test('rejecting keeps the proposal, with its history, under Removed, and nothing reads it', () => {
    const h = harness()
    const p = value(h.store.propose({ title: 'Price', body: '$40.', businesses: ['northfield'] }, AGENT))
    expect(value(h.store.reject(p.id, 1, OWNER))).toMatchObject({ status: 'removed', version: 1 })
    expect(value(h.store.activeFor('northfield'))).toEqual([])
    expect(value(h.store.entries(null))).toHaveLength(1)
    expect(refusal(h.store.reject(p.id, 1, OWNER)).error).toBe('Only a proposal is rejected.')
  })

  test('only an agent proposes: the owner is told to add the entry, and nobody else may', () => {
    const h = harness()
    for (const who of [OWNER, 'dana@northfield.example', '', 'agent:']) {
      expect([who, refusal(h.store.propose({ title: 'x', body: 'y', businesses: ['northfield'] }, who)).reason]).toEqual([who, 'not-admitted'])
    }
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('a new entry needs its title, body and businesses, and a proposal with no business is refused', () => {
    const h = harness()
    const no = (p: Record<string, unknown>) => refusal(h.store.propose(p as never, AGENT)).reason
    expect(no({ title: 'x', body: 'y' })).toBe('bad-request')
    expect(no({ title: 'x', body: 'y', businesses: [] })).toBe('bad-request')
    expect(no({ title: 'x', body: 'y', businesses: ['nobody'] })).toBe('bad-request')
    expect(no({ body: 'y', businesses: ['northfield'] })).toBe('bad-request')
    expect(no({ title: 'x', businesses: ['northfield'] })).toBe('bad-request')
    expect(h.rows('SELECT * FROM knowledge_entry')).toEqual([])
  })

  test('a proposed change of the words keeps the entry’s businesses; approving applies it as the owner’s edit and the proposal goes under Removed', () => {
    const h = harness()
    const made = value(h.store.add('Price', 'The plan is $40.', ['ridgeway-cycles', 'shiftlantern'], OWNER))
    h.tick()
    const p = value(h.store.propose({ body: 'The plan is $39.', replaces: made.id }, AGENT))
    expect(p).toMatchObject({ title: 'Price', body: 'The plan is $39.', replaces: made.id, businesses: ['ridgeway-cycles', 'shiftlantern'] })
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([{ title: 'Price', body: 'The plan is $40.' }])
    h.tick()
    const applied = value(h.store.approve(p.id, 1, OWNER))
    expect(applied).toMatchObject({ id: made.id, body: 'The plan is $39.', version: 2, updatedBy: OWNER, status: 'active' })
    expect(applied.versions[1]).toMatchObject({ by: OWNER, body: 'The plan is $39.' })
    const all = value(h.store.entries(null))
    expect(all.find((e) => e.id === p.id)).toMatchObject({ status: 'removed' })
    expect(refusal(h.store.restore(p.id, 1, OWNER)).error).toContain('Ask Claude to propose it again')
  })

  test('a proposed change of the businesses alone, once approved, changes who is told and is a version by the owner', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open Saturdays.', ['ridgeway-cycles'], OWNER))
    const p = value(h.store.propose({ businesses: ['ridgeway-cycles', 'northfield'], replaces: made.id }, AGENT))
    expect(p).toMatchObject({ title: 'Hours', body: 'Open Saturdays.', businesses: ['northfield', 'ridgeway-cycles'] })
    expect(value(h.store.activeFor('northfield'))).toEqual([])
    const applied = value(h.store.approve(p.id, 1, OWNER))
    expect(applied).toMatchObject({ id: made.id, version: 2, businesses: ['northfield', 'ridgeway-cycles'] })
    expect(applied.versions[1]).toMatchObject({ by: OWNER, businesses: ['northfield', 'ridgeway-cycles'] })
    expect(value(h.store.activeFor('northfield'))).toEqual([{ title: 'Hours', body: 'Open Saturdays.' }])
  })

  test('a change says what it changes, and names an entry that is there and not removed', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    expect(refusal(h.store.propose({ replaces: made.id }, AGENT)).reason).toBe('bad-request')
    expect(refusal(h.store.propose({ body: 'x', replaces: 'missing' }, AGENT)).reason).toBe('bad-request')
    value(h.store.remove(made.id, 1, OWNER))
    expect(refusal(h.store.propose({ body: 'x', replaces: made.id }, AGENT)).reason).toBe('bad-request')
    expect(refusal(h.store.propose({ body: 'x', businesses: [], replaces: 'missing' }, AGENT)).reason).toBe('bad-request')
  })

  test('approving a change whose entry has since been removed is a conflict, and rejecting it still works', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    const p = value(h.store.propose({ body: 'Open late.', replaces: made.id }, AGENT))
    value(h.store.remove(made.id, 1, OWNER))
    expect(refusal(h.store.approve(p.id, 1, OWNER)).reason).toBe('conflict')
    expect(value(h.store.reject(p.id, 1, OWNER)).status).toBe('removed')
  })

  test('at most fifty proposals wait at once, across the whole base, and deciding one makes room', () => {
    const h = harness()
    for (let i = 0; i < KNOWLEDGE_MOST_PROPOSALS; i++) {
      // Spread across the businesses: the cap counts the base, not a business.
      value(h.store.propose({ title: `T${i}`, body: `b${i}`, businesses: [ALL[i % 3]!] }, AGENT))
    }
    const over = refusal(h.store.propose({ title: 'One more', body: 'x', businesses: ['northfield'] }, AGENT))
    expect(over.reason).toBe('limit')
    expect(over.error).toContain(`${KNOWLEDGE_MOST_PROPOSALS} proposals waiting`)
    expect(h.rows('SELECT * FROM knowledge_entry')).toHaveLength(KNOWLEDGE_MOST_PROPOSALS)
    value(h.store.reject('e1', 1, OWNER))
    expect(value(h.store.propose({ title: 'One more', body: 'x', businesses: ['northfield'] }, AGENT)).status).toBe('proposed')
  })
})

describe('the record of who did what', () => {
  test('every write is audited with its actor and what changed, and a read writes nothing', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    h.tick()
    value(h.store.edit(made.id, { businesses: ['northfield', 'shiftlantern'], version: 1 }, OWNER))
    const p = value(h.store.propose({ title: 'Price', body: '$40.', businesses: ['shiftlantern'] }, AGENT))
    value(h.store.approve(p.id, 1, OWNER))
    value(h.store.entries(null))
    value(h.store.activeFor('northfield'))
    const audit = h.rows<{ actor: string; action: string; subject: string; before: string | null; after: string | null }>(
      'SELECT actor, action, subject, before, after FROM audit ORDER BY id',
    )
    expect(audit.map((a) => [a.actor, a.action, a.subject])).toEqual([
      [OWNER, 'knowledge.add', 'knowledge:e1'],
      [OWNER, 'knowledge.edit', 'knowledge:e1'],
      [AGENT, 'knowledge.propose', 'knowledge:e2'],
      [OWNER, 'knowledge.approve', 'knowledge:e2'],
    ])
    expect(JSON.parse(audit[1]!.before!)).toMatchObject({ businesses: ['northfield'] })
    expect(JSON.parse(audit[1]!.after!)).toMatchObject({ businesses: ['northfield', 'shiftlantern'] })
  })

  test('a version is never updated or deleted: only appended', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    value(h.store.edit(made.id, { body: 'Open late.', version: 1 }, OWNER))
    value(h.store.remove(made.id, 2, OWNER))
    value(h.store.restore(made.id, 2, OWNER))
    const versions = h.rows<{ seq: number; body: string }>('SELECT seq, body FROM knowledge_version ORDER BY seq')
    expect(versions.map((v) => [v.seq, v.body])).toEqual([
      [1, 'Open.'],
      [2, 'Open late.'],
      [3, 'Open late.'],
    ])
  })
})

test('the cleaning is the one the duplicate check and the store both use', () => {
  expect(cleaned('  A \n  title ', '  body\n')).toEqual({ title: 'A title', body: 'body' })
})

describe('a proposal is written against the entry as it stood', () => {
  test('it records the version of the entry it was written against', () => {
    const h = harness()
    const made = value(h.store.add('Consult', 'The consult is $100.', ['ridgeway-cycles'], OWNER))
    value(h.store.edit(made.id, { body: 'The consult is $110.', version: 1 }, OWNER))
    const p = value(h.store.propose({ businesses: ['ridgeway-cycles', 'shiftlantern'], replaces: made.id }, AGENT))
    expect(p.replacesVersion).toBe(2)
    expect(value(h.store.propose({ title: 'New', body: 'n', businesses: ['northfield'] }, AGENT)).replacesVersion).toBeNull()
  })

  test('approving a proposal over a later edit of the words is a conflict, and the owner’s edit stands', () => {
    const h = harness()
    const made = value(h.store.add('Consult', 'The consult is $100.', ['ridgeway-cycles'], OWNER))
    // Claude proposes extending it to ShiftLantern, copying the entry as it stands: $100.
    const p = value(h.store.propose({ businesses: ['ridgeway-cycles', 'shiftlantern'], replaces: made.id }, AGENT))
    // Tessa then corrects the price.
    value(h.store.edit(made.id, { body: 'The consult is $120.', version: 1 }, OWNER))
    expect(refusal(h.store.approve(p.id, 1, OWNER))).toEqual({ reason: 'conflict', error: PROPOSAL_OUT_OF_DATE })
    const after = value(h.store.entries(null)).find((e) => e.id === made.id)!
    expect(after).toMatchObject({ body: 'The consult is $120.', businesses: ['ridgeway-cycles'], version: 2 })
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([])
    // The proposal is still there to be rejected, and Claude can propose again against the entry as it is now.
    expect(value(h.store.reject(p.id, 1, OWNER)).status).toBe('removed')
    const again = value(h.store.propose({ businesses: ['ridgeway-cycles', 'shiftlantern'], replaces: made.id }, AGENT))
    expect(value(h.store.approve(again.id, 1, OWNER))).toMatchObject({ id: made.id, body: 'The consult is $120.', version: 3, businesses: ['ridgeway-cycles', 'shiftlantern'] })
  })

  test('approving a words-only proposal after the owner took a business off the entry does not put the business back', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open Saturdays.', ['ridgeway-cycles', 'shiftlantern'], OWNER))
    const p = value(h.store.propose({ body: 'Open Saturdays and Sundays.', replaces: made.id }, AGENT))
    expect(p.businesses).toEqual(['ridgeway-cycles', 'shiftlantern'])
    value(h.store.edit(made.id, { businesses: ['ridgeway-cycles'], version: 1 }, OWNER))
    expect(refusal(h.store.approve(p.id, 1, OWNER)).reason).toBe('conflict')
    expect(value(h.store.activeFor('shiftlantern'))).toEqual([])
    expect(value(h.store.activeFor('ridgeway-cycles'))).toEqual([{ title: 'Hours', body: 'Open Saturdays.' }])
  })

  test('a proposal over an entry nobody has touched since is approved as before', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    const p = value(h.store.propose({ body: 'Open late.', replaces: made.id }, AGENT))
    expect(value(h.store.approve(p.id, 1, OWNER))).toMatchObject({ body: 'Open late.', version: 2 })
  })

  test('two proposals against one entry: approving the first makes the second out of date', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    const a = value(h.store.propose({ body: 'Open late.', replaces: made.id }, AGENT))
    const b = value(h.store.propose({ title: 'Opening hours', replaces: made.id }, AGENT))
    value(h.store.approve(a.id, 1, OWNER))
    expect(refusal(h.store.approve(b.id, 1, OWNER)).error).toBe(PROPOSAL_OUT_OF_DATE)
  })

  test('only an active entry is changed by a proposal: not a removed one, and not another proposal', () => {
    const h = harness()
    const made = value(h.store.add('Hours', 'Open.', ['northfield'], OWNER))
    const waiting = value(h.store.propose({ body: 'Open late.', replaces: made.id }, AGENT))
    const newOne = value(h.store.propose({ title: 'Price', body: '$40.', businesses: ['northfield'] }, AGENT))
    for (const target of [waiting.id, newOne.id]) {
      expect([target, refusal(h.store.propose({ body: 'Rewritten.', replaces: target }, AGENT)).reason]).toEqual([target, 'bad-request'])
    }
    value(h.store.remove(made.id, 1, OWNER))
    expect(refusal(h.store.propose({ body: 'x', replaces: made.id }, AGENT)).reason).toBe('bad-request')
    expect(h.rows('SELECT * FROM knowledge_entry')).toHaveLength(3)
  })
})

describe('the sentences name the owner the install names', () => {
  test('a refusal and the cap say the owner’s name from the ports, not a name written into the store', () => {
    const h = harness()
    const other = new KnowledgeStore({
      sql: h.sql,
      transaction: h.transaction,
      now: () => new Date(T0),
      newId: () => 'z',
      businesses: ALL,
      owners: [OWNER],
      ownerName: 'Dana',
    })
    expect(refusal(other.add('x', 'y', ['northfield'], AGENT)).error).toBe('Only Dana changes the knowledge base. Claude proposes an entry and Dana approves it.')
    expect(refusal(other.propose({ title: 'x', body: 'y', businesses: ['northfield'] }, OWNER)).error).toBe('Only Claude proposes an entry; Dana adds one directly.')
  })
})
