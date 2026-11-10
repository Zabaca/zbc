import { describe, expect, test } from 'bun:test'
import { CLIENTS_MIGRATIONS, CLIENTS_VERSION, migrate } from '../src/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/** The migration runner, copied from the knowledge app's, and the version this build knows. Prior art: packages/knowledge/test/schema.test.ts. */

const tables = (db: ReturnType<typeof memoryDatabase>['db']) =>
  (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)

describe('the schema', () => {
  test('is at version 1: one migration, appended to and never edited (change this number only by appending)', () => {
    expect(CLIENTS_VERSION).toBe(1)
    expect(CLIENTS_MIGRATIONS).toHaveLength(1)
  })

  test('a fresh store gets the Clients’ tables and nothing of mail: clients, their source parts, the source’s state, the audit', () => {
    const { db, sql } = memoryDatabase()
    expect(migrate(sql)).toBe(1)
    expect(tables(db)).toEqual(['audit', 'client', 'client_source', 'client_source_state', 'clients_meta'])
  })

  test('running it again changes nothing, and a store at the current version reads one row and writes nothing', () => {
    const { db, sql } = memoryDatabase()
    migrate(sql)
    db.run(`INSERT INTO audit (at, actor, action, subject) VALUES ('t', 'a', 'x', 's')`)
    expect(migrate(sql)).toBe(1)
    expect((db.query('SELECT count(*) AS n FROM audit').get() as { n: number }).n).toBe(1)
    expect((db.query(`SELECT applied FROM clients_meta WHERE id = 'version'`).get() as { applied: number }).applied).toBe(1)
  })

  test('a store a newer build migrated is refused, loudly, and not read as if it were this build’s', () => {
    const { sql } = memoryDatabase()
    migrate(sql)
    sql.exec(`UPDATE clients_meta SET applied = 2 WHERE id = 'version'`)
    expect(() => migrate(sql)).toThrow(/version 2, but this build only knows 1/)
  })

  test('a Client’s number is a whole number from 1, its name is 1 to 80 characters and its legal name none or 1 to 120, and a source part cannot name a Client that is not there or one Client twice', () => {
    const { db, sql } = memoryDatabase()
    migrate(sql)
    const insert = (number: number, name: string, legal: string | null) =>
      db.run(`INSERT INTO client (number, name, legal_name, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 't', 'a', 't', 'a')`, [number, name, legal])
    expect(() => insert(0, 'Zero', null)).toThrow()
    expect(() => insert(1, '', null)).toThrow()
    expect(() => insert(1, 'x'.repeat(81), null)).toThrow()
    expect(() => insert(1, 'Ok', '')).toThrow()
    expect(() => insert(1, 'Ok', 'x'.repeat(121))).toThrow()
    insert(1, 'Ok', null)
    expect(() => insert(1, 'Again', null)).toThrow()
    const source = (number: number, externalId: string) =>
      db.run(`INSERT INTO client_source (source, external_id, client_number, said, extra) VALUES ('s', ?, ?, '{}', '{}')`, [externalId, number])
    expect(() => source(9, 'a')).toThrow()
    source(1, 'a')
    expect(() => source(1, 'b')).toThrow()
  })
})
