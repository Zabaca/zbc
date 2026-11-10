import { describe, expect, test } from 'bun:test'
import { CLIENTS_FOR_INBOX_METHODS, CLIENTS_FOR_SOURCE_METHODS, CLIENTS_FOR_SPACE_METHODS } from '@space/workspace'
import { createInboxClients } from '../src/inbox'
import { createSourceClients } from '../src/source'
import { createSpaceClients } from '../src/space'
import type { ClientsObject } from '../src/store-access'
import { harness, must, owner, says, SOURCE, teammate, WITH_TEAMMATE } from '../test-support/harness'

/** The three faces over a real store: who is admitted, what each can reach, and that nothing leaves as an exception. */

const reply = <T>(r: { ok: boolean }): T => {
  if (!r.ok) throw new Error(`expected an answer: ${JSON.stringify(r)}`)
  return (r as unknown as { value: T }).value
}

describe('the space’s face (Settings)', () => {
  const object = () => {
    const calls: string[] = []
    const o: ClientsObject = {
      bookmark: async () => (calls.push('bookmark'), '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'),
      restart: async () => {
        calls.push('restart')
        throw new Error('reset under the call')
      },
      counts: async () => (calls.push('counts'), { clients: 0, active: 0, archived: 0, fromSource: 0, madeHere: 0, gone: 0, highest: 0, source: null, schema: 1 }),
    }
    return { o, calls }
  }
  const face = (h = harness(), withObject = true) => {
    const { o, calls } = object()
    return { h, calls, face: createSpaceClients({ store: h.api, install: WITH_TEAMMATE, ...(withObject && { object: o }) }) }
  }

  test('offers exactly the contract’s methods', () => {
    expect(Object.keys(face().face).sort()).toEqual([...CLIENTS_FOR_SPACE_METHODS].sort())
  })

  test('makes, reads, edits, archives and puts back as the owner, with the owner’s address as the actor', async () => {
    const { face: f, h } = face()
    const made = reply<{ number: number; createdBy: string; revision: number }>(await f.makeClient(owner(), { name: 'Fernway', legalName: 'Fernway LLC' }))
    expect(made).toMatchObject({ number: 1001, createdBy: 'tessa@northfield.example', revision: 1 })
    expect(reply<{ name: string }>(await f.client(owner(), made.number))).toMatchObject({ name: 'Fernway' })
    expect(reply<{ revision: number }>(await f.editClient(owner(), made.number, 1, { name: 'Fernway & Sons' }))).toMatchObject({ revision: 2 })
    expect(await f.editClient(owner(), made.number, 1, { name: 'Stale' })).toMatchObject({ ok: false, reason: 'conflict' })
    const list = reply<{ active: { number: number }[]; archived: unknown[] }>(await f.clients(owner()))
    expect(list.active.map((c) => c.number)).toEqual([1001])
    reply(await f.archiveClient(owner(), made.number))
    const after = reply<{ active: unknown[]; archived: { number: number }[]; source: unknown }>(await f.clients(owner()))
    expect([after.active.length, after.archived.map((c) => c.number)]).toEqual([0, [1001]])
    reply(await f.putBackClient(owner(), made.number))
    expect(reply<{ active: unknown[] }>(await f.clients(owner())).active).toHaveLength(1)
    expect(h.rows<{ actor: string }>('SELECT actor FROM audit').every((a) => a.actor === 'tessa@northfield.example')).toBe(true)
  })

  test('the list says when the source was last heard from, and a Client the source brought in carries its source part', async () => {
    const { face: f, h } = face()
    must(h.sync([{ id: 'a', ...says('A', { preferredNumber: 7, extra: { status: 'active' } }) }]))
    const list = reply<{ active: { source: { source: string } | null }[]; source: { name: string; lastSyncAt: number; syncedCount: number } }>(await f.clients(owner()))
    expect(list.source).toMatchObject({ name: SOURCE, lastSyncAt: h.now(), syncedCount: 1 })
    expect(list.active[0]?.source?.source).toBe(SOURCE)
  })

  test('an install with no source has no source to report', async () => {
    const { face: f } = face(harness({ sources: [] }))
    expect(reply<{ source: unknown }>(await f.clients(owner())).source).toBeNull()
  })

  test('admits the owner and no one else: a teammate who is not an owner is refused on every method, and nothing is stored', async () => {
    const { face: f, h, calls } = face()
    const t = teammate()
    const refused = { ok: false, reason: 'not-admitted' }
    expect(await f.clients(t)).toMatchObject(refused)
    expect(await f.client(t, 1)).toMatchObject(refused)
    expect(await f.makeClient(t, { name: 'X' })).toMatchObject(refused)
    expect(await f.editClient(t, 1, 1, { name: 'X' })).toMatchObject(refused)
    expect(await f.archiveClient(t, 1)).toMatchObject(refused)
    expect(await f.putBackClient(t, 1)).toMatchObject(refused)
    expect(await f.storeBookmark(t)).toMatchObject(refused)
    expect(await f.restartStore(t)).toMatchObject(refused)
    expect(await f.storeCounts(t)).toMatchObject(refused)
    expect(h.rows('SELECT * FROM client')).toEqual([])
    expect(calls).toEqual([])
  })

  test('reads what it is handed: a make or an edit that is not the shape is a bad request, and a store that throws answers `broken`, never an exception', async () => {
    const { face: f } = face()
    expect(await f.makeClient(owner(), null as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await f.makeClient(owner(), { name: 3 } as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await f.makeClient(owner(), { name: 'X', legalName: 4 } as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await f.editClient(owner(), 1001, 1, 'no' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await f.editClient(owner(), 1001, 1, { name: 4 } as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    const broken = createSpaceClients({ store: { call: async () => Promise.reject(new Error('disk')) }, install: WITH_TEAMMATE })
    expect(await broken.clients(owner())).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect(await broken.makeClient(owner(), { name: 'X' })).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
  })

  test('the operator’s three: a bookmark, a restart that ends with the object reset under the call, and the counts', async () => {
    const { face: f, calls } = face()
    expect(reply<{ bookmark: string }>(await f.storeBookmark(owner())).bookmark).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/)
    expect(reply(await f.restartStore(owner()))).toEqual({ restarted: true })
    expect(reply<{ schema: number }>(await f.storeCounts(owner())).schema).toBe(1)
    expect(calls).toEqual(['bookmark', 'restart', 'counts'])
  })

  test('the operator’s three answer `broken` where the object is not bound', async () => {
    const { face: f } = face(harness(), false)
    expect(await f.storeBookmark(owner())).toMatchObject({ ok: false, reason: 'broken' })
    expect(await f.restartStore(owner())).toMatchObject({ ok: false, reason: 'broken' })
    expect(await f.storeCounts(owner())).toMatchObject({ ok: false, reason: 'broken' })
  })
})

describe('the inbox’s face', () => {
  test('offers exactly the contract’s methods, and no method that makes, edits or archives', () => {
    const f = createInboxClients({ store: harness().api })
    expect(Object.keys(f).sort()).toEqual([...CLIENTS_FOR_INBOX_METHODS].sort())
  })

  test('reads the list, archived Clients included, and one Client; an unknown number is not found', async () => {
    const h = harness()
    const f = createInboxClients({ store: h.api })
    must(h.make('Mine'))
    must(h.push('s', says('Theirs', { preferredNumber: 7 })))
    must(h.store.archive(7, 'tessa@northfield.example'))
    const list = reply<{ number: number; archivedAt: number | null }[]>(await f.list())
    expect(list.map((c) => [c.number, c.archivedAt !== null])).toEqual([[7, true], [1001, false]])
    expect(reply<{ name: string }>(await f.get(7)).name).toBe('Theirs')
    expect(await f.get(9)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await f.get('7' as never)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a store that throws answers `broken`', async () => {
    const f = createInboxClients({ store: { call: async () => Promise.reject(new Error('disk')) } })
    expect(await f.list()).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect(await f.get(1)).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
  })
})

describe('the source’s face (the Clients door)', () => {
  const face = (h = harness()) => ({ h, face: createSourceClients({ store: h.api, source: SOURCE }) })

  test('offers exactly the contract’s methods', () => {
    expect(Object.keys(face().face).sort()).toEqual([...CLIENTS_FOR_SOURCE_METHODS].sort())
  })

  test('upserts, marks gone, lists and syncs in the source’s name, with the source as the actor', async () => {
    const { face: f, h } = face()
    expect(reply(await f.upsert('a', says('A', { preferredNumber: 7, extra: { status: 'active' } })))).toEqual({ number: 7, created: true, changed: true })
    expect(reply(await f.upsert('a', says('A', { preferredNumber: 7, extra: { status: 'active' } })))).toEqual({ number: 7, created: false, changed: false })
    expect(reply(await f.gone('a'))).toEqual({ number: 7, changed: true })
    expect(reply<{ externalId: string; goneSince: number | null }[]>(await f.list())).toMatchObject([{ externalId: 'a', goneSince: h.now() }])
    expect(reply(await f.sync([{ id: 'a', ...says('A', { preferredNumber: 7, extra: { status: 'active' } }) }, { id: 'b', ...says('B', { preferredNumber: 8 }) }]))).toMatchObject({ sent: 2, added: 1, returned: 1, matches: true })
    expect(h.rows<{ actor: string }>('SELECT DISTINCT actor FROM audit')).toEqual([{ actor: `source:${SOURCE}` }])
  })

  test('can reach the Clients of its own source only: one made in the space is not found to mark gone, and a face made for another source is refused by the store', async () => {
    const { face: f, h } = face()
    must(h.make('Made here'))
    expect(await f.gone('1001')).toMatchObject({ ok: false, reason: 'not-found' })
    const other = createSourceClients({ store: h.api, source: 'somewhere-else' })
    expect(await other.upsert('a', says('A'))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(await other.list()).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(h.rows('SELECT * FROM client_source')).toEqual([])
  })

  test('answers a push that is not the shape as a bad request, and a store that throws as `broken`', async () => {
    const { face: f } = face()
    expect(await f.upsert('a', { name: '' } as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await f.sync('no' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    const broken = createSourceClients({ store: { call: async () => Promise.reject(new Error('disk')) }, source: SOURCE })
    expect(await broken.upsert('a', says('A'))).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
  })
})
