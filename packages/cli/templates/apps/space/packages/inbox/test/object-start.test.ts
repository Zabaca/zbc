import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION } from '../src/store/schema'
import { deferredStart } from '../test-support/deferred-start'
import { sqlOver } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))
const { InboxDO } = await import('../src/durable')

/**
 * The object's start-up as workerd runs it: `blockConcurrencyWhile`'s callback runs AFTER the constructor returns, so anything that reads the store in the constructor body runs before the migrations and finds no table
 * (proved under miniflare 4.20260714; a constructor that throws on every start). The settling of every mailbox's people was once put there, and this holds it where it belongs: in the callback, right after the migration.
 * The same start, with the real class and the real Worker bundle, from a store as it stood before mailboxes had people, was run under miniflare once.
 */
describe('the object starts from a store as it stood before the people of mailboxes', () => {
  function oldStore() {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    const sql = sqlOver(db)
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 19)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 19)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, refresh_token, connected_at, connected_by, display_name)
       VALUES ('gm1', 'gmail', 'tessa@northfield.example', 'tok', '2026-11-01T00:00:00.000Z', 'tessa@northfield.example', 'northfield'),
              ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, '2026-11-02T00:00:00.000Z', 'cloudflare', 'Ridgeway')`,
    )
    return { db, sql }
  }

  test('the migration runs and then the people are settled, and a mailbox is Tessa’s the moment the object is up', async () => {
    const { db, sql } = oldStore()
    const start = deferredStart()
    const ctx = {
      storage: {
        sql,
        transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
      blockConcurrencyWhile: start.blockConcurrencyWhile,
      waitUntil: () => {},
    }
    // The constructor must not touch the schema itself: it returns, and only then does the callback run.
    expect(
      () =>
        new InboxDO(
          ctx as never,
          { LIVE: { idFromName: (n: string) => n, get: () => ({ tell: () => {}, openPeople: () => [] }) } } as never,
        ),
    ).not.toThrow()
    await start.started()
    expect(db.query('SELECT applied FROM inbox_meta').get()).toEqual({ applied: INBOX_VERSION })
    expect(db.query('SELECT mailbox_id, person FROM mailbox_person ORDER BY mailbox_id').all()).toEqual([
      { mailbox_id: 'fb', person: 'tessa@northfield.example' },
      { mailbox_id: 'gm1', person: 'tessa@northfield.example' },
    ])
  })
})
