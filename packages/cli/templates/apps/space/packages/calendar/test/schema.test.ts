import { describe, expect, test } from 'bun:test'
import { CALENDAR_MIGRATIONS, CALENDAR_VERSION, migrate } from '../src/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

describe('the calendar’s schema', () => {
  test('the first migration makes the whole store, the second adds whether an account’s grant can change events, the third the busy blocks, the fourth whose block it is, the fifth the booking links, the sixth the canonical address the limits count, the seventh where a link’s meetings are held, and the version is the count of migrations (append, never edit)', () => {
    const mem = memoryDatabase()
    expect(migrate(mem.sql)).toBe(7)
    expect(CALENDAR_VERSION).toBe(CALENDAR_MIGRATIONS.length)
    expect(CALENDAR_VERSION).toBe(7)
    const tables = (mem.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(['account', 'blocking', 'booking', 'booking_link', 'booking_meta', 'calendar', 'calendar_meta', 'channel', 'event'])
  })

  test('a link and a booking a build before the calls held keep their rows: they are on Google Meet, with no call', () => {
    const mem = memoryDatabase()
    for (let i = 0; i < 6; i++) mem.sql.exec(CALENDAR_MIGRATIONS[i] as string)
    mem.sql.exec(`CREATE TABLE "calendar_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    mem.sql.exec(`INSERT INTO calendar_meta (id, applied) VALUES ('version', 6)`)
    mem.db.run(`INSERT INTO account (address, label, hue, state, first_seen_at) VALUES ('a@x.example', 'a', 0, 'live', 1)`)
    mem.db.run(`INSERT INTO calendar (id, account, google_id, name, shown) VALUES ('a@x.example|c', 'a@x.example', 'c', 'c', 1)`)
    mem.db.run(
      `INSERT INTO booking_link (id, slug, name, description, account, minutes, hours, notice_minutes, ahead_days, gap_minutes, per_day, enabled, created_at, changed_at) VALUES ('l', 'intro', 'Intro', '', 'a@x.example', 30, '{}', 240, 30, 15, NULL, 1, 1, 1)`,
    )
    mem.db.run(
      `INSERT INTO booking (id, link_id, link_name, account, calendar_id, calendar_google_id, event_id, minutes, start_ms, end_ms, visitor_name, visitor_email, visitor_key, note, manage_hash, state, checked, network, created_at) VALUES ('b', 'l', 'Intro', 'a@x.example', 'a@x.example|c', 'c', 'e', 30, 1, 2, 'Ada', 'ada@x.example', 'ada@x.example', NULL, 'h', 'booked', 'google', 'n', 1)`,
    )
    expect(migrate(mem.sql)).toBe(7)
    expect(mem.db.query(`SELECT where_kind FROM booking_link`).all()).toEqual([{ where_kind: 'meet' }])
    expect(mem.db.query(`SELECT where_kind, call_name, call_link, call_start, call_closed FROM booking`).all()).toEqual([{ where_kind: 'meet', call_name: null, call_link: null, call_start: null, call_closed: 0 }])
  })

  test('a store a build before the busy blocks held keeps its rows: every account takes part, no event is a block, and the switch is off with nothing owed', () => {
    const mem = memoryDatabase()
    mem.sql.exec(CALENDAR_MIGRATIONS[0] as string)
    mem.sql.exec(CALENDAR_MIGRATIONS[1] as string)
    mem.sql.exec(`CREATE TABLE "calendar_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    mem.sql.exec(`INSERT INTO calendar_meta (id, applied) VALUES ('version', 2)`)
    mem.db.run(`INSERT INTO account (address, label, hue, state, first_seen_at) VALUES ('a@x.example', 'a', 0, 'live', 1)`)
    mem.db.run(`INSERT INTO calendar (id, account, google_id, name, shown) VALUES ('a@x.example|c', 'a@x.example', 'c', 'c', 1)`)
    mem.db.run(`INSERT INTO event (calendar_id, id, title, start_ms, end_ms, all_day, status) VALUES ('a@x.example|c', 'e', 'Standup', 1, 2, 0, 'confirmed')`)
    expect(migrate(mem.sql)).toBe(7)
    expect(mem.db.query(`SELECT address, blocks FROM account`).all()).toEqual([{ address: 'a@x.example', blocks: 1 }])
    expect(mem.db.query(`SELECT id, block, block_by FROM event`).all()).toEqual([{ id: 'e', block: null, block_by: null }])
    expect(mem.db.query(`SELECT id, enabled, problem, retry_at, failures FROM blocking`).all()).toEqual([{ id: 'blocking', enabled: 0, problem: null, retry_at: null, failures: 0 }])
  })

  test('an account a store held before the second migration keeps its row and is not yet said to edit events', () => {
    const mem = memoryDatabase()
    mem.sql.exec(CALENDAR_MIGRATIONS[0] as string)
    mem.sql.exec(`CREATE TABLE "calendar_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    mem.sql.exec(`INSERT INTO calendar_meta (id, applied) VALUES ('version', 1)`)
    mem.db.run(`INSERT INTO account (address, label, hue, state, first_seen_at) VALUES ('a@x.example', 'a', 0, 'live', 1)`)
    expect(migrate(mem.sql)).toBe(7)
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
    expect(migrate(mem.sql)).toBe(7)
    expect((mem.db.query(`SELECT count(*) AS n FROM account`).get() as { n: number }).n).toBe(1)
    expect((mem.db.query(`SELECT count(*) AS n FROM blocking`).get() as { n: number }).n).toBe(1)
  })

  test('a store a newer build migrated is refused, loudly', () => {
    const mem = memoryDatabase()
    migrate(mem.sql)
    mem.db.run(`UPDATE calendar_meta SET applied = 8`)
    expect(() => migrate(mem.sql)).toThrow('deploy forwards rather than back')
  })
})
