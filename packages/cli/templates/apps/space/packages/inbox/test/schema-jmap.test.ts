import { describe, expect, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Migration 18 (store version 19), the fourth kind of mailbox: the mailbox table made again, as migrations 8 and 16 did it, over a store holding every other kind of row with the checks
 * enforced, plus the two JMAP id columns. The pin of the version is in schema.test.ts.
 */

describe('migration 18: a mailbox on Northfield’s own mail server, read over JMAP', () => {
  /** A deployed store at version 18 holding all three other kinds of row, with the references that point at the mailbox table. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 18)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 18)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, refresh_token, history_id, connected_at, connected_by, display_name, grant_lapsed_at, assistant, assistant_set_by, assistant_set_at, last_arrival_at, job, checked_in_at, bridge_state, bridge_state_at)
       VALUES ('gm', 'gmail', 'tessa@northfield.example', 'tok', '5', 't', 'tessa@northfield.example', 'northfield', 'lapsed', 0, NULL, NULL, NULL, '{"kind":"fill"}', NULL, NULL, NULL),
              ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, NULL, 't', 'cloudflare', 'Ridgeway Cycles', NULL, 1, 'tessa@northfield.example', 'at', 'la', NULL, NULL, NULL, NULL),
              ('tg', 'telegram', '7000000001', NULL, '{"pts":1}', 't', 'telegram', 'Telegram', NULL, 0, NULL, NULL, NULL, NULL, 'c', 'live', 'b')`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('cv', 't', 't', 'gm', 'th1'), ('cf', 't', 't', 'fb', NULL), ('ct', 't', 't', 'tg', NULL)`,
    )
    db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, gmail_id, arrival_key)
       VALUES ('m1', 'cv', 'i1', 'in', 'sent', 'hello', 't', 'gmail', 't', 'gmail', 'gm', 'g1', NULL),
              ('m2', 'cf', 'i1', 'in', 'sent', 'hi', 't', 'cloudflare', 't', 'cloudflare', 'fb', NULL, '<a@b>')`,
    )
    db.run(
      `INSERT INTO arrival_owed (raw_key, mailbox_id, envelope_from, envelope_to, received_at, owed_at, next_try_at) VALUES ('in/x', 'fb', 'a', 'b', 't', 't', 't')`,
    )
    return { sql, db }
  }

  test('every row of every other kind survives column for column with the checks enforced, and the table gains no column', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    const columns = (db.query(`PRAGMA table_info(mailbox)`).all() as { name: string }[]).map((c) => c.name)
    const counts = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT * FROM mailbox ORDER BY id`).all()).toEqual(before)
    expect((db.query(`PRAGMA table_info(mailbox)`).all() as { name: string }[]).map((c) => c.name)).toEqual(columns)
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect([counts('conversation'), counts('message'), counts('arrival_owed')]).toEqual([3, 2, 1])
    // The references still point at the table by name.
    expect(() =>
      db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('x', 't', 't', 'nope')`),
    ).toThrow(/FOREIGN KEY/)
    // The two new id columns are empty on everything that was there.
    expect(db.query(`SELECT jmap_id FROM message ORDER BY id`).all()).toEqual([{ jmap_id: null }, { jmap_id: null }])
    expect(db.query(`SELECT jmap_thread_id FROM conversation ORDER BY id`).all()).toEqual([
      { jmap_thread_id: null },
      { jmap_thread_id: null },
      { jmap_thread_id: null },
    ])
  })

  test('a JMAP mailbox is one per address, and the table still takes no other kind', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name) VALUES ('jm', 'jmap', 'test@harborline.example', 't', 'jmap', 'harborline')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'jmap', 'test@harborline.example', 't', 'x')`,
      ),
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('y', 'signal', '1', 't', 'x')`,
      ),
    ).toThrow(/CHECK/)
    // an old kind is still taken
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('g2', 'gmail', 'second@example.com', 't', 'x')`,
    )
  })

  test('a JMAP thread is one conversation per mailbox and a JMAP id one message per mailbox, in two mailboxes alike', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('jm', 'jmap', 'test@harborline.example', 't', 'x'), ('jn', 'jmap', 'other@harborline.example', 't', 'x')`,
    )
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, jmap_thread_id) VALUES ('a', 't', 't', 'jm', 'T1'), ('b', 't', 't', 'jn', 'T1')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, jmap_thread_id) VALUES ('c', 't', 't', 'jm', 'T1')`,
      ),
    ).toThrow(/UNIQUE/)
    const insert = (id: string, box: string, jmap: string | null, conv: string) =>
      db.run(
        `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, jmap_id)
         VALUES ('${id}', '${conv}', 'i1', 'in', 'sent', 'x', 't', 'jmap', 't', 'jmap', '${box}', ${jmap === null ? 'NULL' : `'${jmap}'`})`,
      )
    insert('n1', 'jm', 'E1', 'a')
    insert('n2', 'jn', 'E1', 'b')
    expect(() => insert('n3', 'jm', 'E1', 'a')).toThrow(/UNIQUE/)
    // messages with no JMAP id (every drafts, every other kind) are many
    insert('n4', 'jm', null, 'a')
    insert('n5', 'jm', null, 'a')
  })

  test('the Gmail columns keep meaning Gmail: a Gmail thread and id are still unique per mailbox and a JMAP row does not share them', () => {
    const { sql, db } = deployed()
    migrate(sql)
    expect(() =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('d', 't', 't', 'gm', 'th1')`,
      ),
    ).toThrow(/UNIQUE/)
  })
})
