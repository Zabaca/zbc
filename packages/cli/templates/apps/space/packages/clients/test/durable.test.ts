// The Clients store's Durable Object (src/durable.ts), driven the way the space's Worker drives it: it is the one object the space reaches, and `call` is the only way in. `cloudflare:workers` exists only in the
// Workers runtime, so it is stood in for here with the one base class; everything else is the object's own wiring (the declaration's owners and source, the migration), with the storage a real SQLite behind the
// real migration.
//
// What this proves that the logic tests cannot: that the object answers only the store's own face by name (the runtime exposes every method of a class over RPC, so the class must have exactly `call` and the
// operator's three), that it tells the live object after a stored change and no other time, and that a source's push through the Clients door's face reaches the owner's Settings (the space's face).
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { createSourceClients } from '../src/source'
import { createSpaceClients } from '../src/space'
import { owner, says, SOURCE, WITH_TEAMMATE, NORTHFIELD } from '../test-support/harness'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

type Obj = { call(method: string, args: unknown[]): unknown; bookmark(): Promise<string>; restart(): void; counts(): { clients: number; schema: number } }
let ClientsDO: new (ctx: unknown, env: unknown) => Obj

beforeAll(async () => {
  ClientsDO = ((await import('../src/durable')) as unknown as { ClientsDO: typeof ClientsDO }).ClientsDO
})

/** The Worker's environment: the one object, in a real SQLite, and a live object that records what it is told. */
function environment() {
  const mem = memoryDatabase()
  const seen: string[] = []
  const ctx = {
    storage: { sql: mem.sql, transactionSync: mem.transaction, getCurrentBookmark: async () => 'BM' },
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    abort: (why: string) => seen.push(`abort ${why}`),
  }
  const told: unknown[] = []
  const LIVE = { idFromName: (n: string) => n, get: () => ({ tell: (m: unknown) => told.push(m) }) }
  const object = new ClientsDO(ctx, { LIVE })
  const store = { call: (method: string, ...args: unknown[]) => Promise.resolve(object.call(method, args)) }
  return { mem, object, told, seen, store: store as never }
}

const tellsSoFar = async (told: unknown[]) => {
  await new Promise((r) => setTimeout(r, 0))
  return told.length
}

describe('the object', () => {
  test('has `call` and the operator’s three and nothing else public', () => {
    expect(Object.getOwnPropertyNames(ClientsDO.prototype).filter((n) => n !== 'constructor').sort()).toEqual(['bookmark', 'call', 'counts', 'restart'])
  })

  test('the bookmark is Cloudflare’s for the storage now, a restart aborts the object, and the counts are the store’s', async () => {
    const { object, seen } = environment()
    expect(await object.bookmark()).toBe('BM')
    object.restart()
    expect(seen).toEqual([expect.stringContaining('abort')])
    expect(object.counts()).toMatchObject({ clients: 0, schema: 1 })
  })

  test('answers only the store’s own face by name, and nothing else the class happens to have', () => {
    const { object } = environment()
    for (const name of ['constructor', 'counts', 'bookmark', 'restart', 'applyOne', 'audit', 'owner', 'isOwner', 'changeCount', 'sql']) {
      expect(() => object.call(name, []), name).toThrow('No such method')
    }
  })

  test('migrates its storage when it is made: a fresh one holds the tables and no Client', () => {
    const { mem } = environment()
    expect((mem.db.query('SELECT count(*) AS n FROM client').get() as { n: number }).n).toBe(0)
    expect((mem.db.query(`SELECT applied FROM clients_meta`).get() as { applied: number }).applied).toBe(1)
  })

  test('knows its owners and its source from the declaration: the owner makes a Client, the declared source pushes one, and neither can do the other’s work', async () => {
    const { store } = environment()
    const space = createSpaceClients({ store, install: NORTHFIELD })
    const source = createSourceClients({ store, source: SOURCE })
    expect(await space.makeClient(owner(), { name: 'Mine' })).toMatchObject({ ok: true, value: { number: 1001 } })
    expect(await source.upsert('a', says('Theirs', { preferredNumber: 7 }))).toMatchObject({ ok: true, value: { number: 7, created: true } })
    expect(await createSourceClients({ store, source: 'somewhere-else' }).upsert('b', says('B'))).toMatchObject({ ok: false, reason: 'not-admitted' })
  })

  test('a push through the Clients door’s face reaches the owner’s Settings: made by the source, listed with its source part', async () => {
    const { store } = environment()
    const space = createSpaceClients({ store, install: WITH_TEAMMATE })
    await createSourceClients({ store, source: SOURCE }).sync([{ id: 'a', ...says('Fernway', { preferredNumber: 7, url: 'https://www.northfield.example/admin#client-7', extra: { subscription: 'active' } }) }])
    const list = await space.clients(owner())
    expect(list).toMatchObject({ ok: true, value: { active: [{ number: 7, name: 'Fernway', createdBy: `source:${SOURCE}`, source: { externalId: 'a', extra: { subscription: 'active' } } }], source: { name: SOURCE, syncedCount: 1 } } })
  })
})

describe('telling the live object', () => {
  test('tells it the Clients moved after a stored change, to the owners, and after nothing else', async () => {
    const { object, told } = environment()
    object.call('list', [])
    object.call('get', [1])
    object.call('make', ['', null, 'tessa@northfield.example'])
    expect(await tellsSoFar(told)).toBe(0)
    object.call('make', ['Fernway', null, 'tessa@northfield.example'])
    expect(await tellsSoFar(told)).toBe(1)
    expect(told[0]).toEqual({ part: 'clients', people: ['tessa@northfield.example'] })
    object.call('edit', [1001, 1, { name: 'Fernway' }, 'tessa@northfield.example'])
    expect(await tellsSoFar(told)).toBe(1)
    object.call('edit', [1001, 1, { name: 'Fernway & Sons' }, 'tessa@northfield.example'])
    expect(await tellsSoFar(told)).toBe(2)
  })

  test('a source’s push tells it once, and the same push again tells no one', async () => {
    const { object, told } = environment()
    const push = () => object.call('upsertExternal', [SOURCE, 'a', says('A'), `source:${SOURCE}`])
    push()
    expect(await tellsSoFar(told)).toBe(1)
    push()
    object.call('syncExternal', [SOURCE, [{ id: 'a', ...says('A') }], `source:${SOURCE}`])
    expect(await tellsSoFar(told)).toBe(1)
    object.call('markGone', [SOURCE, 'a', `source:${SOURCE}`])
    expect(await tellsSoFar(told)).toBe(2)
  })

  test('works where no live object is bound', () => {
    const mem = memoryDatabase()
    const ctx = { storage: { sql: mem.sql, transactionSync: mem.transaction }, blockConcurrencyWhile: (fn: () => Promise<void>) => fn() }
    const object = new ClientsDO(ctx, {})
    expect(object.call('make', ['Fernway', null, 'tessa@northfield.example'])).toMatchObject({ ok: true })
  })
})
