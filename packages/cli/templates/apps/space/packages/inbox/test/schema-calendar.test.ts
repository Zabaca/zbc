import { describe, expect, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Migration 20 (store version 21), what an email's calendar part says, kept on the message: run over a store with today's schema (version 20) holding mail of every kind, with the checks
 * enforced. It adds ONE nullable column to `message` and changes nothing else: no row is rewritten, no index is made. The pin of the version is in schema.test.ts.
 */

/** A deployed store at version 20: a Gmail account with an inbound message and a calendar-event one, a business mailbox, a Telegram chat and a draft. */
function deployed() {
  const { sql, db } = memoryDatabase()
  sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
  for (const step of INBOX_MIGRATIONS.slice(0, 20)) sql.exec(step)
  sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 20)`)
  db.run(
    `INSERT INTO mailbox (id, kind, address, refresh_token, connected_at, connected_by, display_name)
     VALUES ('gm1', 'gmail', 'tessa@northfield.example', 'tok', '2026-11-01T00:00:00.000Z', 'tessa@northfield.example', 'northfield'),
            ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, '2026-11-02T00:00:00.000Z', 'cloudflare', 'Ridgeway')`,
  )
  db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ines', 't', 'x')`)
  db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'ines@example.com', 't')`)
  db.run(
    `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('cv1', 't', 't', 'gm1'), ('cv2', 't', 't', 'fb')`,
  )
  db.run(
    `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, event_key, event_kind, attachments)
     VALUES ('m1', 'cv1', 'i1', 'in', 'sent', 'hello', 't', 'gmail', 't', 'gmail', 'gm1', NULL, NULL, '[]'),
            ('m2', 'cv1', 'i1', 'in', 'sent', '', 't', 'gmail', 't', 'gmail', 'gm1', 'google:abc', 'update', '[{"name":"invite.ics","size":1009,"mimeType":"text/calendar"}]'),
            ('m3', 'cv2', 'i1', 'in', 'sent', 'hi', 't', 'cloudflare', 't', 'cloudflare', 'fb', NULL, NULL, '[]')`,
  )
  return { sql, db }
}

describe('migration 20: what an email’s calendar part says', () => {
  test('it adds one nullable column to message and changes nothing else: every row is as it was, with no summary and not looked at', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM message ORDER BY rowid`).all() as Record<string, unknown>[]
    const others = Object.fromEntries(
      ['mailbox', 'conversation', 'contact', 'identity', 'setting', 'audit'].map((t) => [
        t,
        db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
      ]),
    )
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(INBOX_VERSION).toBeGreaterThanOrEqual(21)
    expect(db.query(`SELECT * FROM message ORDER BY rowid`).all()).toEqual(
      before.map((m) => ({ ...m, calendar: null })),
    )
    for (const [t, rows] of Object.entries(others))
      expect(db.query(`SELECT * FROM ${t} ORDER BY rowid`).all(), t).toEqual(rows as never)
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    const columns = db
      .query(
        `SELECT name, type, "notnull" AS required, dflt_value FROM pragma_table_info('message') WHERE name = 'calendar'`,
      )
      .all()
    expect(columns).toEqual([{ name: 'calendar', type: 'TEXT', required: 0, dflt_value: null }])
    // No index was made for it.
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '%"calendar"%'`).all()).toEqual(
      [],
    )
  })

  test('it is applied once, and a build from before it refuses the store it made', () => {
    const { sql } = deployed()
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(migrate(sql)).toBe(INBOX_VERSION)
    sql.exec(`UPDATE inbox_meta SET applied = ${INBOX_MIGRATIONS.length + 1}`)
    expect(() => migrate(sql)).toThrow(/older deploy/)
  })

  test('the column takes a summary, `none` for a message looked at, and NULL for one not looked at', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(`UPDATE message SET calendar = '{"kind":"reply"}' WHERE id = 'm2'`)
    db.run(`UPDATE message SET calendar = 'none' WHERE id = 'm1'`)
    expect(db.query(`SELECT id, calendar FROM message ORDER BY rowid`).all()).toEqual([
      { id: 'm1', calendar: 'none' },
      { id: 'm2', calendar: '{"kind":"reply"}' },
      { id: 'm3', calendar: null },
    ])
  })
})
