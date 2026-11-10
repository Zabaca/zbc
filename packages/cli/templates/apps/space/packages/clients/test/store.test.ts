import { describe, expect, test } from 'bun:test'
import { CLIENT_LOCAL_NUMBER_FROM, sourceActor } from '@space/workspace'
import { CLIENT_CHANGED } from '../src/store'
import { harness, must, OWNER, says, SOURCE, SOURCE_ACTOR, T0 } from '../test-support/harness'

/** The rules of the Clients, over a real SQLite with the real migrations. The faces' tests are test/space.test.ts, inbox.test.ts and source.test.ts. */

const audit = (h: ReturnType<typeof harness>) => h.rows<{ actor: string; action: string; subject: string }>('SELECT actor, action, subject FROM audit ORDER BY id')

describe('making a Client', () => {
  test('needs a name only; the legal name may wait', () => {
    const h = harness()
    const c = must(h.make('Fernway Plumbing'))
    expect(c).toMatchObject({ name: 'Fernway Plumbing', legalName: null, revision: 1, source: null, archivedAt: null, createdBy: OWNER, createdAt: T0 })
  })

  test('a name is one line of 1 to 80 characters after trimming, a legal name is empty or up to 120', () => {
    const h = harness()
    expect(must(h.make('  Two   words\n here ')).name).toBe('Two words here')
    expect(h.make('   ')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.make('x'.repeat(81))).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(must(h.make('x'.repeat(80))).name).toHaveLength(80)
    expect(h.make(7 as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.make('Ok', 'y'.repeat(121))).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(must(h.make('Ok', 'y'.repeat(120))).legalName).toHaveLength(120)
    expect(must(h.make('Ok again', '   ')).legalName).toBeNull()
    expect(h.make('Ok', 5 as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('is the owner’s alone: another address, a source’s actor and an agent are refused, and nothing is stored', () => {
    const h = harness()
    for (const actor of ['dana@northfield.example', SOURCE_ACTOR, 'agent:claude.access', '']) {
      expect(h.store.make('Nope', null, actor)).toMatchObject({ ok: false, reason: 'not-admitted' })
    }
    expect(h.rows('SELECT * FROM client')).toEqual([])
    expect(h.rows('SELECT * FROM audit')).toEqual([])
  })

  test('numbers a Client from 1 where the install has no source, and from 1001 where it has one, filling the lowest free number', () => {
    const none = harness({ sources: [] })
    expect([must(none.make('A')).number, must(none.make('B')).number, must(none.make('C')).number]).toEqual([1, 2, 3])
    const some = harness()
    expect([must(some.make('A')).number, must(some.make('B')).number]).toEqual([CLIENT_LOCAL_NUMBER_FROM, CLIENT_LOCAL_NUMBER_FROM + 1])
  })

  test('is kept in the record of who did what', () => {
    const h = harness()
    must(h.make('Fernway', 'Fernway LLC'))
    expect(audit(h)).toEqual([{ actor: OWNER, action: 'client.make', subject: 'client:1001' }])
  })
})

describe('editing a Client', () => {
  test('changes the name, the legal name or both, and the revision moves each time', () => {
    const h = harness()
    const c = must(h.make('Fernway', 'Fernway LLC'))
    h.tick()
    const renamed = must(h.store.edit(c.number, 1, { name: 'Fernway & Sons' }, OWNER))
    expect(renamed).toMatchObject({ name: 'Fernway & Sons', legalName: 'Fernway LLC', revision: 2, updatedBy: OWNER })
    expect(renamed.updatedAt).toBeGreaterThan(c.updatedAt)
    const legal = must(h.store.edit(c.number, 2, { legalName: 'Fernway & Sons Inc.' }, OWNER))
    expect(legal).toMatchObject({ name: 'Fernway & Sons', legalName: 'Fernway & Sons Inc.', revision: 3 })
    expect(must(h.store.edit(c.number, 3, { name: 'H', legalName: '' }, OWNER))).toMatchObject({ name: 'H', legalName: null, revision: 4 })
    expect(must(h.store.edit(c.number, 4, { legalName: 'Back' }, OWNER)).legalName).toBe('Back')
    expect(must(h.store.edit(c.number, 5, { legalName: null }, OWNER)).legalName).toBeNull()
  })

  test('over a screen that is out of date is a conflict, and nothing is saved over a change the person has not seen', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    must(h.store.edit(c.number, 1, { name: 'First' }, OWNER))
    const stale = h.store.edit(c.number, 1, { name: 'Stale' }, OWNER)
    expect(stale).toEqual({ ok: false, reason: 'conflict', error: CLIENT_CHANGED })
    expect(must(h.store.get(c.number)).name).toBe('First')
  })

  test('must say what to change and which revision was shown, and the same words again change nothing and move no revision', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    expect(h.store.edit(c.number, 1, {}, OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.store.edit(c.number, 1, 'no', OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.store.edit(c.number, undefined, { name: 'X' }, OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.store.edit(c.number, 0, { name: 'X' }, OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.store.edit(c.number, 1, { name: '' }, OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.store.edit(c.number, 1, { name: 'x'.repeat(81) }, OWNER)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(must(h.store.edit(c.number, 1, { name: 'Fernway' }, OWNER)).revision).toBe(1)
    expect(audit(h)).toHaveLength(1)
  })

  test('is the owner’s alone, and a number the store does not hold is not found', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    expect(h.store.edit(c.number, 1, { name: 'X' }, 'dana@northfield.example')).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.edit(c.number, 1, { name: 'X' }, SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.edit(77, 1, { name: 'X' }, OWNER)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.store.edit('7' as never, 1, { name: 'X' }, OWNER)).toMatchObject({ ok: false, reason: 'not-found' })
  })
})

describe('archiving and putting back', () => {
  test('an archived Client is kept, with who and when, and put back whole; nothing deletes it', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    h.tick()
    const archived = must(h.store.archive(c.number, OWNER))
    expect(archived).toMatchObject({ archivedBy: OWNER, revision: 2, name: 'Fernway' })
    expect(archived.archivedAt).toBe(h.now())
    h.tick()
    const back = must(h.store.putBack(c.number, OWNER))
    expect(back).toMatchObject({ archivedAt: null, archivedBy: null, revision: 3, name: 'Fernway' })
    expect(h.rows('SELECT count(*) AS n FROM client')).toEqual([{ n: 1 }])
    expect(audit(h).map((a) => a.action)).toEqual(['client.make', 'client.archive', 'client.put-back'])
  })

  test('archiving an archived Client, or putting back an active one, answers it as it is and records nothing', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    expect(must(h.store.putBack(c.number, OWNER)).revision).toBe(1)
    must(h.store.archive(c.number, OWNER))
    const again = must(h.store.archive(c.number, OWNER))
    expect(again.revision).toBe(2)
    expect(audit(h)).toHaveLength(2)
  })

  test('is the owner’s alone, and an unknown number is not found; an archived Client can still be edited', () => {
    const h = harness()
    const c = must(h.make('Fernway'))
    expect(h.store.archive(c.number, 'dana@northfield.example')).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.archive(c.number, SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.putBack(c.number, SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.archive(5, OWNER)).toMatchObject({ ok: false, reason: 'not-found' })
    const archived = must(h.store.archive(c.number, OWNER))
    expect(must(h.store.edit(c.number, archived.revision, { name: 'Renamed' }, OWNER)).archivedAt).not.toBeNull()
  })

  test('the list carries every Client, archived ones included, lowest number first', () => {
    const h = harness({ sources: [] })
    const [a, b, c] = ['A', 'B', 'C'].map((n) => must(h.make(n)))
    must(h.store.archive(b!.number, OWNER))
    const all = must(h.store.list())
    expect(all.map((x) => [x.number, x.archivedAt !== null])).toEqual([[a!.number, false], [b!.number, true], [c!.number, false]])
  })
})

describe('a source’s Client', () => {
  test('is brought in with the source’s name, legal name, address and other fields, as a Client of the space with a source part', () => {
    const h = harness()
    const pushed = must(h.push('s-7', says('Fernway Plumbing', { legalName: 'Fernway Plumbing LLC', url: 'https://www.northfield.example/admin#client-7', preferredNumber: 7, extra: { signInAddress: 'owner@fernway.test', subscription: 'active' } })))
    expect(pushed).toEqual({ number: 7, created: true, changed: true })
    expect(must(h.store.get(7))).toMatchObject({
      number: 7,
      name: 'Fernway Plumbing',
      legalName: 'Fernway Plumbing LLC',
      createdBy: SOURCE_ACTOR,
      revision: 1,
      source: {
        source: SOURCE,
        externalId: 's-7',
        url: 'https://www.northfield.example/admin#client-7',
        said: { name: 'Fernway Plumbing', legalName: 'Fernway Plumbing LLC' },
        extra: { signInAddress: 'owner@fernway.test', subscription: 'active' },
        goneSince: null,
      },
    })
    expect(audit(h)).toEqual([{ actor: SOURCE_ACTOR, action: 'client.source.add', subject: 'client:7' }])
  })

  test('keeps the number the source asks for, so every link already made stays; a Client that asks for none, or whose number is held, takes the lowest free local number from 1001', () => {
    const h = harness()
    expect(must(h.push('a', says('A', { preferredNumber: 3 }))).number).toBe(3)
    expect(must(h.push('b', says('B', { preferredNumber: 1 }))).number).toBe(1)
    expect(must(h.push('c', says('C'))).number).toBe(1001)
    const local = must(h.make('Made here'))
    expect(local.number).toBe(1002)
    // 3 is held, so another Client asking for it takes the next local number and keeps its own id at the source beside it.
    const taken = must(h.push('d', says('D', { preferredNumber: 3 })))
    expect(taken).toEqual({ number: 1003, created: true, changed: true })
    expect(must(h.store.get(1003)).source?.externalId).toBe('d')
    // A number the source asks for later, once a local Client holds it, is not given away: it asks for 1002 and gets the next free one.
    expect(must(h.push('e', says('E', { preferredNumber: 1002 }))).number).toBe(1004)
  })

  test('is found by the source’s id, so the same push twice is one Client and changes nothing the second time', () => {
    const h = harness()
    const fields = says('Fernway', { preferredNumber: 7, extra: { a: 'b' } })
    must(h.push('s-7', fields))
    const before = h.rows('SELECT * FROM audit').length
    h.tick()
    expect(must(h.push('s-7', fields))).toEqual({ number: 7, created: false, changed: false })
    expect(h.rows('SELECT count(*) AS n FROM client')).toEqual([{ n: 1 }])
    expect(h.rows('SELECT * FROM audit')).toHaveLength(before)
    expect(must(h.store.get(7)).revision).toBe(1)
  })

  test('its name follows the source’s until the name is edited in the space; then the space’s name stands, and what the source calls it is kept to be shown', () => {
    const h = harness()
    must(h.push('s', says('Fernway Plumbing', { legalName: 'Fernway Plumbing LLC', preferredNumber: 7 })))
    // Untouched: a rename at the source reaches the Client.
    h.tick()
    expect(must(h.push('s', says('Fernway Plumbing & Heating', { legalName: 'Fernway Plumbing LLC', preferredNumber: 7 })))).toEqual({ number: 7, created: false, changed: true })
    expect(must(h.store.get(7))).toMatchObject({ name: 'Fernway Plumbing & Heating', revision: 2, updatedBy: SOURCE_ACTOR })
    // Edited in the space: the edit stands against every later rename, and the source's name is shown beside it.
    must(h.store.edit(7, 2, { name: 'Fernway' }, OWNER))
    h.tick()
    must(h.push('s', says('Fernway Heating Co', { legalName: 'Fernway Plumbing LLC', preferredNumber: 7 })))
    const c = must(h.store.get(7))
    expect(c.name).toBe('Fernway')
    expect(c.source?.said.name).toBe('Fernway Heating Co')
    expect(c.revision).toBe(3)
    // The legal name is decided on its own: still the source's, so it follows, while the name stays the space's.
    must(h.push('s', says('Fernway Heating Co', { legalName: 'Fernway Heating Co LLC', preferredNumber: 7 })))
    expect(must(h.store.get(7))).toMatchObject({ name: 'Fernway', legalName: 'Fernway Heating Co LLC' })
    // And the other way round: a legal name edited in the space stands while the name goes on following.
    must(h.store.edit(7, 4, { name: 'Fernway Heating Co', legalName: 'Mine Inc.' }, OWNER))
    must(h.push('s', says('Fernway & Co', { legalName: 'Theirs Inc.', preferredNumber: 7 })))
    expect(must(h.store.get(7))).toMatchObject({ name: 'Fernway & Co', legalName: 'Mine Inc.' })
  })

  test('a legal name cleared in the space is not brought back by the source, and a source that drops its legal name clears an untouched one', () => {
    const h = harness()
    must(h.push('s', says('Fernway', { legalName: 'Fernway LLC' })))
    const n = must(h.store.list())[0]!.number
    must(h.store.edit(n, 1, { legalName: '' }, OWNER))
    must(h.push('s', says('Fernway', { legalName: 'Fernway Incorporated' })))
    expect(must(h.store.get(n)).legalName).toBeNull()
    must(h.push('t', says('Other', { legalName: 'Other LLC' })))
    must(h.push('t', says('Other', { legalName: null })))
    expect(must(h.store.list()).find((c) => c.source?.externalId === 't')?.legalName).toBeNull()
  })

  test('a name over 80 characters is cut in the Client’s and kept whole as what the source calls it; it keeps following while it still equals the cut', () => {
    const h = harness()
    const long = `${'Long business name '.repeat(8)}end`
    must(h.push('s', says(long)))
    const c = must(h.store.list())[0]!
    expect(Array.from(c.name).length).toBeLessThanOrEqual(80)
    expect(long.startsWith(c.name)).toBe(true)
    expect(c.source?.said.name).toBe(long.replace(/\s+/g, ' ').trim())
    // The cut is not an edit: it still follows.
    must(h.push('s', says('Short now')))
    expect(must(h.store.get(c.number)).name).toBe('Short now')
  })

  test('everything else the source says is its own: replaced whole on every push and never edited in the space', () => {
    const h = harness()
    must(h.push('s', says('H', { preferredNumber: 7, url: 'https://a.test/1', extra: { subscription: 'active', signInAddress: 'a@b.test' } })))
    h.tick()
    expect(must(h.push('s', says('H', { preferredNumber: 7, url: 'https://a.test/2', extra: { subscription: 'canceled' } })))).toMatchObject({ changed: true })
    expect(must(h.store.get(7)).source).toMatchObject({ url: 'https://a.test/2', extra: { subscription: 'canceled' } })
    expect(Object.keys(must(h.store.get(7)).source!.extra)).toEqual(['subscription'])
    // The space's edit changes the Client's own fields only.
    must(h.store.edit(7, 1, { name: 'Mine' }, OWNER))
    expect(must(h.store.get(7)).source?.extra).toEqual({ subscription: 'canceled' })
  })

  test('archived is the space’s alone: a push never archives, puts back or otherwise touches it', () => {
    const h = harness()
    must(h.push('s', says('H', { preferredNumber: 7 })))
    must(h.store.archive(7, OWNER))
    must(h.push('s', says('H renamed', { preferredNumber: 7 })))
    expect(must(h.store.get(7))).toMatchObject({ name: 'H renamed', archivedBy: OWNER })
    must(h.gone('s'))
    expect(must(h.store.get(7)).archivedAt).not.toBeNull()
  })

  test('a Client the source says is gone is marked with the time and kept, never archived or deleted, and sending it again clears the mark', () => {
    const h = harness()
    must(h.push('s', says('H', { preferredNumber: 7 })))
    h.tick()
    expect(must(h.gone('s'))).toEqual({ number: 7, changed: true })
    const gone = must(h.store.get(7))
    expect(gone).toMatchObject({ name: 'H', archivedAt: null, source: { goneSince: h.now() } })
    h.tick()
    expect(must(h.gone('s'))).toEqual({ number: 7, changed: false })
    expect(must(h.store.get(7)).source?.goneSince).toBe(gone.source!.goneSince)
    h.tick()
    expect(must(h.push('s', says('H', { preferredNumber: 7 })))).toEqual({ number: 7, created: false, changed: true })
    expect(must(h.store.get(7)).source?.goneSince).toBeNull()
    expect(h.rows('SELECT count(*) AS n FROM client')).toEqual([{ n: 1 }])
  })

  test('a Client the space does not hold for the source cannot be marked gone', () => {
    const h = harness()
    expect(h.gone('nope')).toMatchObject({ ok: false, reason: 'not-found' })
    must(h.make('Made here'))
    expect(h.gone('1001')).toMatchObject({ ok: false, reason: 'not-found' })
    // A refused mark is not the source being heard from.
    expect(h.rows('SELECT * FROM client_source_state')).toEqual([])
  })

  test('is accepted only in the declared source’s name and by its own actor; any other source, actor or an install with no source is refused and nothing is stored', () => {
    const h = harness()
    expect(h.store.upsertExternal('somewhere-else', 'a', says('A'), sourceActor('somewhere-else'))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.upsertExternal(SOURCE, 'a', says('A'), sourceActor('somewhere-else'))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.upsertExternal(SOURCE, 'a', says('A'), OWNER)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.markGone('somewhere-else', 'a', SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.syncExternal('somewhere-else', [], sourceActor('somewhere-else'))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.store.listing('somewhere-else', SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.rows('SELECT * FROM client')).toEqual([])
    const none = harness({ sources: [] })
    expect(none.store.upsertExternal(SOURCE, 'a', says('A'), SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(none.store.syncExternal(SOURCE, [], SOURCE_ACTOR)).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(none.rows('SELECT * FROM client')).toEqual([])
  })

  test('a push that is not the shape is refused whole and stores nothing: a missing name, an unknown field, a bad number, a plain-http address, a bad extra field, a bad id', () => {
    const h = harness()
    const bad = (fields: unknown, id = 'a') => h.store.upsertExternal(SOURCE, id, fields, SOURCE_ACTOR)
    expect(bad({})).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: '' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 5 })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', admin: 'x' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', preferredNumber: 0 })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', preferredNumber: 1.5 })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', url: 'http://a.test/1' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', url: 'not a url' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', legalName: 3 })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', extra: { Bad_Key: 'x' } })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', extra: { a: 3 } })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A', extra: [] })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'x'.repeat(501) })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A' }, '../etc')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad({ name: 'A' }, '')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad(null)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.rows('SELECT * FROM client')).toEqual([])
  })
})

describe('the source’s full set', () => {
  const set = (...names: [string, number | null][]) => names.map(([name, n]) => ({ id: `s-${name}`, ...says(name, { preferredNumber: n, url: `https://z.test/${name}`, extra: { status: 'active' } }) }))

  test('brings in every Client with the number it asks for, and the space then holds exactly what was sent', () => {
    const h = harness()
    const report = must(h.sync(set(['A', 1], ['B', 2], ['C', 9])))
    expect(report).toEqual({ sent: 3, added: 3, updated: 0, markedGone: 0, returned: 0, changed: true, matches: true })
    expect(must(h.store.list()).map((c) => [c.number, c.name])).toEqual([[1, 'A'], [2, 'B'], [9, 'C']])
    expect(must(h.store.sourceStatus())).toEqual({ name: SOURCE, lastPushAt: h.now(), lastSyncAt: h.now(), syncedCount: 3 })
  })

  test('is idempotent: the same set again changes nothing, writes no record, and still matches', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2])))
    const before = h.rows('SELECT * FROM audit').length
    h.tick()
    const again = must(h.sync(set(['A', 1], ['B', 2])))
    expect(again).toEqual({ sent: 2, added: 0, updated: 0, markedGone: 0, returned: 0, changed: false, matches: true })
    expect(h.rows('SELECT * FROM audit')).toHaveLength(before)
    expect(must(h.store.list()).map((c) => c.revision)).toEqual([1, 1])
  })

  test('marks the Clients of the source that are not in it as gone, never archived or deleted, and clears the mark of one that is sent again', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2], ['C', 3])))
    h.tick()
    const second = must(h.sync(set(['A', 1], ['C', 3])))
    expect(second).toMatchObject({ sent: 2, markedGone: 1, changed: true, matches: true })
    const b = must(h.store.get(2))
    expect(b).toMatchObject({ name: 'B', archivedAt: null, source: { goneSince: h.now() } })
    h.tick()
    const third = must(h.sync(set(['A', 1], ['B', 2], ['C', 3])))
    expect(third).toMatchObject({ markedGone: 0, returned: 1, updated: 1, changed: true, matches: true })
    expect(must(h.store.get(2)).source?.goneSince).toBeNull()
    expect(must(h.store.list())).toHaveLength(3)
  })

  test('an empty set marks every Client of the source gone and deletes none; a Client made in the space is not the source’s and is left alone', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2])))
    const mine = must(h.make('Made here'))
    expect(must(h.sync([]))).toMatchObject({ sent: 0, markedGone: 2, matches: true })
    expect(must(h.store.list())).toHaveLength(3)
    expect(must(h.store.get(mine.number)).source).toBeNull()
  })

  test('a Client that exists in the space with a number the source asks for does not lose it: the Clients that ask for a free number never take one the set asks for', () => {
    const h = harness()
    // A Client made in the space holds 1001; the source asks for 1001 and 1002, and a third asks for none.
    must(h.make('Made here'))
    const report = must(h.sync([{ id: 'x', ...says('X', { preferredNumber: 1001 }) }, { id: 'y', ...says('Y', { preferredNumber: 1002 }) }, { id: 'z', ...says('Z') }]))
    expect(report.matches).toBe(true)
    const numbers = Object.fromEntries(must(h.store.list()).map((c) => [c.name, c.number]))
    expect(numbers['Made here']).toBe(1001)
    expect(numbers.Y).toBe(1002)
    expect(numbers.X).toBe(1003)
    expect(numbers.Z).toBe(1004)
  })

  test('is all or nothing: a fault anywhere in the send, or too many Clients, or an id twice, changes nothing', () => {
    const h = harness()
    must(h.sync(set(['A', 1])))
    const before = h.rows('SELECT * FROM audit').length
    const bad = (clients: unknown) => h.sync(clients)
    expect(bad('no')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad([{ id: 's-B', ...says('B') }, { id: 's-C', name: '' }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad([{ id: 's-B', ...says('B') }, { id: 's-B', ...says('B again') }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad([null])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad([{ ...says('No id') }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(bad(Array.from({ length: 2001 }, (_, i) => ({ id: `s${i}`, ...says('X') })))).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.rows('SELECT * FROM audit')).toHaveLength(before)
    expect(must(h.store.list()).map((c) => c.name)).toEqual(['A'])
    expect(must(h.store.get(1)).source?.goneSince).toBeNull()
  })

  test('follows the same name rules as a single push: an untouched name follows, an edited one stands', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2])))
    must(h.store.edit(2, 1, { name: 'Mine' }, OWNER))
    must(h.sync([{ id: 's-A', ...says('A renamed', { preferredNumber: 1, url: 'https://z.test/A', extra: { status: 'active' } }) }, { id: 's-B', ...says('B renamed', { preferredNumber: 2, url: 'https://z.test/B', extra: { status: 'active' } }) }]))
    expect(must(h.store.get(1)).name).toBe('A renamed')
    expect(must(h.store.get(2))).toMatchObject({ name: 'Mine', source: { said: { name: 'B renamed' } } })
  })

  test('the listing gives the sender every Client of the source by its id, so it can reconcile', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2])))
    must(h.make('Made here'))
    must(h.gone('s-B'))
    must(h.store.archive(1, OWNER))
    expect(must(h.store.listing(SOURCE, SOURCE_ACTOR))).toEqual([
      { externalId: 's-A', number: 1, name: 'A', legalName: null, archived: true, goneSince: null },
      { externalId: 's-B', number: 2, name: 'B', legalName: null, archived: false, goneSince: h.now() },
    ])
  })

  test('a sender that pushes the same set over and over, as it does every time it starts or retries, writes nothing after the first and never grows the record', () => {
    const h = harness()
    must(h.sync(set(['A', 1], ['B', 2])))
    const size = h.rows('SELECT * FROM audit').length
    for (let i = 0; i < 25; i += 1) {
      h.tick()
      expect(must(h.sync(set(['A', 1], ['B', 2]))).changed).toBe(false)
      must(h.push('s-A', says('A', { preferredNumber: 1, url: 'https://z.test/A', extra: { status: 'active' } })))
    }
    expect(h.rows('SELECT * FROM audit')).toHaveLength(size)
    expect(h.rows('SELECT count(*) AS n FROM client')).toEqual([{ n: 2 }])
  })
})

describe('the counts', () => {
  test('say how many Clients the store holds and of which kinds, for the comparison with the source’s own list', () => {
    const h = harness()
    must(h.sync([{ id: 'a', ...says('A', { preferredNumber: 4 }) }, { id: 'b', ...says('B', { preferredNumber: 5 }) }, { id: 'c', ...says('C', { preferredNumber: 6 }) }]))
    must(h.make('Mine'))
    must(h.gone('b'))
    must(h.store.archive(4, OWNER))
    expect(h.store.counts()).toEqual({
      clients: 4,
      active: 3,
      archived: 1,
      fromSource: 3,
      madeHere: 1,
      gone: 1,
      highest: 1001,
      source: { name: SOURCE, lastPushAt: h.now(), lastSyncAt: h.now(), syncedCount: 3 },
      schema: 1,
    })
  })

  test('an install with no source has none to report', () => {
    const h = harness({ sources: [] })
    must(h.make('A'))
    expect(h.store.counts()).toMatchObject({ clients: 1, fromSource: 0, madeHere: 1, source: null, highest: 1 })
    expect(must(h.store.sourceStatus())).toBeNull()
  })
})

describe('what counts as a change', () => {
  test('the change count moves for every stored change and for nothing else, so the object tells the live object only then', () => {
    const h = harness()
    const n = () => h.store.changeCount
    must(h.make('A'))
    expect(n()).toBe(1)
    h.store.list()
    h.store.get(1001)
    h.make('')
    h.store.edit(1001, 1, {}, OWNER)
    expect(n()).toBe(1)
    must(h.push('s', says('S', { preferredNumber: 5 })))
    expect(n()).toBe(2)
    must(h.push('s', says('S', { preferredNumber: 5 })))
    must(h.sync([{ id: 's', ...says('S', { preferredNumber: 5 }) }]))
    expect(n()).toBe(2)
  })
})
