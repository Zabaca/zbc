// The knowledge store's Durable Object (src/durable.ts), driven the way the space's Worker drives it: it is the one object the space reaches, and `call` is the only way in. `cloudflare:workers`
// exists only in the Workers runtime, so it is stood in for here with the one base class; everything else is the object's own wiring (the declaration's businesses, the migration), with the
// storage a real SQLite behind the real migration.
//
// What this proves that the logic tests cannot: that the object answers only the store's own face by name (the runtime exposes every method of a class over RPC, so the class must have exactly
// `call` and the operator's three), and that a proposal made through the inbox's face reaches the space's tab (the knowledge face the space calls in-process) and nothing reads it until it is
// approved there.
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { signedIn } from '@space/workspace'
import { createInboxKnowledge } from '../src/inbox'
import { createSpaceKnowledge } from '../src/space'
import { AGENT, OWNER, NORTHFIELD } from '../test-support/harness'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

let KnowledgeDO: new (ctx: unknown, env: unknown) => { call(method: string, args: unknown[]): unknown }

beforeAll(async () => {
  KnowledgeDO = ((await import('../src/durable')) as unknown as { KnowledgeDO: typeof KnowledgeDO }).KnowledgeDO
})

/** The Worker's environment: the one object, in a real SQLite. */
function environment() {
  const mem = memoryDatabase()
  const ctx = {
    storage: { sql: mem.sql, transactionSync: mem.transaction },
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
  }
  const object = new KnowledgeDO(ctx, {})
  const env = { KNOWLEDGE: { idFromName: (n: string) => n, get: () => object } }
  return { mem, object, env }
}

describe('the object', () => {
  test('has `call` and the operator’s three and nothing else public', () => {
    expect(Object.getOwnPropertyNames(KnowledgeDO.prototype).filter((n) => n !== 'constructor').sort()).toEqual(['bookmark', 'call', 'restart', 'restoreTo'])
  })

  test('the bookmark is Cloudflare’s for the storage now; a restore is armed for the next start; a restart aborts the object', async () => {
    const mem = memoryDatabase()
    const seen: string[] = []
    const ctx = {
      storage: {
        sql: mem.sql,
        transactionSync: mem.transaction,
        getCurrentBookmark: async () => 'BM',
        onNextSessionRestoreBookmark: async (b: string) => (seen.push(`restore ${b}`), 'PREV'),
      },
      blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
      abort: (why: string) => seen.push(`abort ${why}`),
    }
    const object = new KnowledgeDO(ctx, {}) as unknown as { bookmark(): Promise<string>; restoreTo(b: string): Promise<string>; restart(): void }
    expect(await object.bookmark()).toBe('BM')
    expect(await object.restoreTo('B2')).toBe('PREV')
    object.restart()
    expect(seen).toEqual(['restore B2', expect.stringContaining('abort')])
  })

  test('answers only the store’s own face by name, and nothing else the class happens to have', () => {
    const { object } = environment()
    expect(() => object.call('constructor', [])).toThrow('No such method')
    expect(() => object.call('everything', [])).toThrow('No such method')
    expect(() => object.call('audit', [])).toThrow('No such method')
    expect(() => object.call('isOwner', [OWNER])).toThrow('No such method')
  })

  test('migrates its storage when it is made: a fresh one holds the tables and no entry', () => {
    const { mem } = environment()
    expect((mem.db.query('SELECT count(*) AS n FROM knowledge_entry').get() as { n: number }).n).toBe(0)
    expect((mem.db.query(`SELECT applied FROM knowledge_meta`).get() as { applied: number }).applied).toBe(1)
  })
})

describe('across the two faces', () => {
  test('a proposal made through the inbox’s face is waiting in the space’s tab, read by no assistant until the owner approves it there', async () => {
    const { env, mem } = environment()
    // Both faces are called in-process in the space's Worker, over the store it reaches through the same binding and the same name.
    const { storeFor } = await import('../src/store-access')
    const inbox = createInboxKnowledge({ store: storeFor(env as never), install: NORTHFIELD })
    const space = createSpaceKnowledge({ store: storeFor(env as never), install: NORTHFIELD })
    const owner = signedIn(NORTHFIELD.people.find((p) => p.address === OWNER)!, 4_000_000_000)

    const proposed = await inbox.propose(AGENT, { title: 'Hours', body: 'Open Saturdays.', businesses: ['ridgeway-cycles', 'shiftlantern'] })
    expect(proposed).toMatchObject({ ok: true, value: { status: 'proposed', proposedBy: AGENT } })
    expect(await inbox.activeFor('ridgeway-cycles')).toEqual({ ok: true, value: [] })

    const waiting = await space.knowledge(owner, 'ridgeway-cycles')
    expect(waiting).toMatchObject({ ok: true, value: { entries: [{ title: 'Hours', status: 'proposed', version: 1 }] } })

    const id = (proposed as { value: { id: string } }).value.id
    const approved = await space.changeKnowledge(owner, { do: 'approve', id, version: 1 })
    expect(approved).toMatchObject({ ok: true, value: { status: 'active', version: 2, updatedBy: OWNER } })
    expect(await inbox.activeFor('ridgeway-cycles')).toEqual({ ok: true, value: [{ title: 'Hours', body: 'Open Saturdays.' }] })
    expect(await inbox.activeFor('shiftlantern')).toEqual({ ok: true, value: [{ title: 'Hours', body: 'Open Saturdays.' }] })
    expect(await inbox.activeFor('northfield')).toEqual({ ok: true, value: [] })
    expect((mem.db.query('SELECT count(*) AS n FROM audit').get() as { n: number }).n).toBe(2)
  })
})

describe('telling the live object', () => {
  type Obj = { call(method: string, args: unknown[]): unknown }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  /** An object over a real SQLite whose environment binds a live object that records what it is told. */
  function withLive(tell: (m: unknown, mem: ReturnType<typeof memoryDatabase>) => void) {
    const mem = memoryDatabase()
    const ctx = { storage: { sql: mem.sql, transactionSync: mem.transaction }, blockConcurrencyWhile: (fn: () => Promise<void>) => fn() }
    const live = { idFromName: (n: string) => n, get: () => ({ tell: (m: unknown) => tell(m, mem), openPeople: () => [] }) }
    return new KnowledgeDO(ctx, { LIVE: live }) as unknown as Obj
  }

  test('every method of the face is either a read or a change, so a new method is put in one on purpose', async () => {
    const { CHANGING_METHODS, STORE_METHODS } = await import('../src/store')
    const reads = ['activeFor', 'entries']
    expect([...reads, ...CHANGING_METHODS].sort()).toEqual([...STORE_METHODS].sort())
  })

  test('a change that is stored tells the owners’ pages the knowledge moved, and a read tells nobody', async () => {
    const told: unknown[] = []
    const object = withLive((m) => void told.push(m))
    object.call('entries', [])
    object.call('activeFor', ['northfield'])
    await settle()
    expect(told).toEqual([])
    const added = object.call('add', ['Hours', 'Open Saturdays.', ['northfield'], OWNER]) as { ok: boolean }
    await settle()
    expect(added.ok).toBe(true)
    expect(told).toEqual([{ part: 'knowledge', people: [OWNER] }])
  })

  test('the change is already stored when the message goes out, and a live object that fails changes nothing about it', async () => {
    const seenInStore: number[] = []
    const quiet = console.warn
    console.warn = () => {}
    try {
      const object = withLive((_m, mem) => {
        seenInStore.push((mem.db.query('SELECT count(*) AS n FROM knowledge_entry').get() as { n: number }).n)
        throw new Error('the live object is down')
      })
      const added = object.call('add', ['Hours', 'Open Saturdays.', ['northfield'], OWNER]) as { ok: boolean }
      await settle()
      expect(added.ok).toBe(true)
      expect(seenInStore).toEqual([1])
    } finally {
      console.warn = quiet
    }
  })

  test('with no live object bound nothing is told and the call is as it was', () => {
    const { object } = environment()
    expect(() => object.call('entries', [])).not.toThrow()
  })
})
