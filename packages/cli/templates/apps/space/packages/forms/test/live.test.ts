// Telling the live object that documents moved: a committed batch tells it, a failed one does not, reads do not, and a live object that is down
// never fails or slows a write. The seam is the `Db` every write in forms goes through (src/live.ts), and the check that the signing core is made over it is a real envelope written through `coreFor`.
import { describe, expect, test } from 'bun:test'
import { watched } from '../src/live'
import { coreFor } from '../src/signing'
import type { Db, Stmt } from '../src/records'
import { bundledInstall } from '../src/workspace'

const settle = () => new Promise((r) => setTimeout(r, 0))

function fakeDb(fail = false) {
  const log: string[] = []
  const stmt = (sql: string): Stmt => ({ bind: () => stmt(sql), first: async () => null, all: async () => ({ results: [] }), run: async () => void log.push(`run ${sql}`) })
  const db: Db = {
    prepare: (sql) => stmt(sql),
    batch: async (statements) => {
      log.push(`batch ${statements.length}`)
      if (fail) throw new Error('D1 refused the batch')
      return []
    },
  }
  return { db, log }
}

function recorder(order?: string[]) {
  const told: unknown[] = []
  const live = {
    idFromName: (n: string) => n,
    get: () => ({
      tell: (m: unknown) => {
        order?.push('told')
        told.push(m)
      },
      openPeople: () => [],
    }),
  }
  return { live, told }
}

describe('the database seam', () => {
  test('tells the team’s pages that documents moved after a batch has committed, and not for a read', async () => {
    const { db } = fakeDb()
    const { live, told } = recorder()
    const w = watched(db, live, bundledInstall)
    await w.prepare('SELECT 1').first()
    await w.prepare('SELECT 1').all()
    await settle()
    expect(told).toEqual([])
    await w.batch([w.prepare('INSERT INTO events VALUES (1)')])
    await settle()
    expect(told).toEqual([{ part: 'documents', people: bundledInstall.people.map((p) => p.address) }])
  })

  test('tells only once the batch is stored', async () => {
    const order: string[] = []
    const { db } = fakeDb()
    const inner = db.batch
    db.batch = async (s) => {
      const r = await inner(s)
      order.push('stored')
      return r
    }
    const { live } = recorder(order)
    const w = watched(db, live, bundledInstall)
    await w.batch([])
    await settle()
    expect(order).toEqual(['stored', 'told'])
  })

  test('a batch that fails tells nothing, and says what it said', async () => {
    const { db } = fakeDb(true)
    const { live, told } = recorder()
    const w = watched(db, live, bundledInstall)
    await expect(w.batch([])).rejects.toThrow('D1 refused the batch')
    await settle()
    expect(told).toEqual([])
  })

  test('a live object that is down never fails or slows the write', async () => {
    const quiet = console.warn
    console.warn = () => {}
    try {
      const { db } = fakeDb()
      const down = {
        idFromName: () => 'live',
        get: () => ({
          tell: () => {
            throw new Error('down')
          },
        }),
      }
      const w = watched(db, down, bundledInstall)
      await expect(w.batch([])).resolves.toEqual([])
      await settle()
    } finally {
      console.warn = quiet
    }
  })

  test('with no live object bound it is the database itself', () => {
    const { db } = fakeDb()
    expect(watched(db, undefined, bundledInstall)).toBe(db)
  })

  test('the signing core is made over it: a request’s core and the sweep’s tell, and without a live object bound the core’s database is the binding', async () => {
    const { db } = fakeDb()
    const { live, told } = recorder()
    const env = { DB: db, FILES: {}, ASSETS: {}, FORMS_DATA_KEY: btoa(String.fromCharCode(...new Uint8Array(32))), LIVE: live } as never
    await coreFor(env, () => 1).db.batch([])
    await settle()
    expect(told).toHaveLength(1)
    expect(coreFor({ ...(env as object), LIVE: undefined } as never, () => 1).db).toBe(db)
  })

  test('a Worker request is kept alive until the message is out', async () => {
    const { db } = fakeDb()
    const { live, told } = recorder()
    const kept: Promise<unknown>[] = []
    const w = watched(db, live, bundledInstall, (p) => void kept.push(p))
    await w.batch([])
    expect(kept).toHaveLength(1)
    await kept[0]
    expect(told).toHaveLength(1)
  })
})
