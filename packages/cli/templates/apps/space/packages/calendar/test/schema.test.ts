import { describe, expect, test } from 'bun:test'
import { CALENDAR_MIGRATIONS, CALENDAR_VERSION, migrate } from '../src/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

describe('the calendar’s schema', () => {
  test('the first migration makes the whole store, the second adds whether an account’s grant can change events, and the version is the count of migrations (append, never edit)', () => {
    const mem = memoryDatabase()
    expect(migrate(mem.sql)).toBe(2)
    expect(CALENDAR_VERSION).toBe(CALENDAR_MIGRATIONS.length)
    expect(CALENDAR_VERSION).toBe(2)
    const tables = (mem.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(['account', 'calendar', 'calendar_meta', 'channel', 'event'])
  })

  test('an account a store held before the second migration keeps its row and is not yet said to edit events', () => {
    const mem = memoryDatabase()
    mem.sql.exec(CALENDAR_MIGRATIONS[0] as string)
    mem.sql.exec(`CREATE TABLE "calendar_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    mem.sql.exec(`INSERT INTO calendar_meta (id, applied) VALUES ('version', 1)`)
    mem.db.run(`INSERT INTO account (address, label, hue, state, first_seen_at) VALUES ('a@x.example', 'a', 0, 'live', 1)`)
    expect(migrate(mem.sql)).toBe(2)
    expect(mem.db.query(`SELECT address, events FROM account`).all()).toEqual([{ address: 'a@x.example', events: 0 }])
  })

  test('it holds no refresh token and no column that could: the grant is the inbox’s', () => {
    const mem = memoryDatabase()
    migrate(mem.sql)
    const columns = (mem.db.query(`SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'`).all() as { t: string; c: string }[]).map((r) => `${r.t}.${r.c}`)
    expect(columns.filter((c) => /refresh|secret|password|credential/i.test(c))).toEqual([])
    // The one secret it keeps is a push channel's own token, which Google sends back to prove a notification is for that channel.
    expect(columns).toContain('channel.token')
  })

  test('migrating again changes nothing', () => {
    const mem = memoryDatabase()
    migrate(mem.sql)
    mem.db.run(`INSERT INTO account (address, label, hue, state, first_seen_at) VALUES ('a@x.example', 'a', 0, 'live', 1)`)
    expect(migrate(mem.sql)).toBe(2)
    expect((mem.db.query(`SELECT count(*) AS n FROM account`).get() as { n: number }).n).toBe(1)
  })

  test('a store a newer build migrated is refused, loudly', () => {
    const mem = memoryDatabase()
    migrate(mem.sql)
    mem.db.run(`UPDATE calendar_meta SET applied = 3`)
    expect(() => migrate(mem.sql)).toThrow('deploy forwards rather than back')
  })
})
