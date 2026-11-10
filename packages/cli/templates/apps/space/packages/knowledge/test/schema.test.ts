import { describe, expect, test } from 'bun:test'
import { KNOWLEDGE_MIGRATIONS, KNOWLEDGE_VERSION, migrate } from '../src/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * The migration runner, copied from the inbox's, and the version this build knows. Prior art: packages/inbox/test/schema.test.ts.
 */

const tables = (db: ReturnType<typeof memoryDatabase>['db']) =>
  (db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)

describe('the schema', () => {
  test('is at version 1: one migration, appended to and never edited (change this number only by appending)', () => {
    expect(KNOWLEDGE_VERSION).toBe(1)
    expect(KNOWLEDGE_MIGRATIONS).toHaveLength(1)
  })

  test('a fresh store gets the base’s tables and nothing of mail: entries, their businesses, versions, the audit', () => {
    const { db, sql } = memoryDatabase()
    expect(migrate(sql)).toBe(1)
    expect(tables(db)).toEqual(['audit', 'knowledge_entry', 'knowledge_entry_business', 'knowledge_meta', 'knowledge_version'])
  })

  test('running it again changes nothing, and a store at the current version reads one row and writes nothing', () => {
    const { db, sql } = memoryDatabase()
    migrate(sql)
    db.run(`INSERT INTO audit (at, actor, action, subject) VALUES ('t', 'a', 'x', 's')`)
    expect(migrate(sql)).toBe(1)
    expect((db.query('SELECT count(*) AS n FROM audit').get() as { n: number }).n).toBe(1)
    expect((db.query(`SELECT applied FROM knowledge_meta WHERE id = 'version'`).get() as { applied: number }).applied).toBe(1)
  })

  test('a store a newer build migrated is refused, loudly, and not read as if it were this build’s', () => {
    const { sql } = memoryDatabase()
    migrate(sql)
    sql.exec(`UPDATE knowledge_meta SET applied = 2 WHERE id = 'version'`)
    expect(() => migrate(sql)).toThrow(/version 2, but this build only knows 1/)
  })

  test('an entry’s status is one of three, and a version cannot name an entry that is not there', () => {
    const { db, sql } = memoryDatabase()
    migrate(sql)
    expect(() =>
      db.run(`INSERT INTO knowledge_entry (id, title, body, status, created_at, created_by, updated_at, updated_by) VALUES ('e', 't', 'b', 'draft', 't', 'a', 't', 'a')`),
    ).toThrow()
    expect(() => db.run(`INSERT INTO knowledge_version (entry_id, by, at, title, body, businesses) VALUES ('missing', 'a', 't', 't', 'b', '[]')`)).toThrow()
  })
})
