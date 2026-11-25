import { describe, expect, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Migration 22 (store version 23), the fifth kind of mailbox: the mailbox table made again, as migrations 8, 16 and 18 did it, over a store holding every other kind of row with the checks
 * enforced, plus the two columns a text conversation needs. The pin of the version is in schema.test.ts.
 */

describe('migration 22: the owner’s phone, read through the texts bridge', () => {
  /** A deployed store at version 22 holding all four other kinds of row, with the references that point at the mailbox table. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 22)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 22)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, refresh_token, history_id, connected_at, connected_by, display_name, grant_lapsed_at, assistant, assistant_set_by, assistant_set_at, last_arrival_at, job, checked_in_at, bridge_state, bridge_state_at)
       VALUES ('gm', 'gmail', 'tessa@northfield.example', 'tok', '5', 't', 'tessa@northfield.example', 'northfield', 'lapsed', 0, NULL, NULL, NULL, '{"kind":"fill"}', NULL, NULL, NULL),
              ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, NULL, 't', 'cloudflare', 'Ridgeway Cycles', NULL, 1, 'tessa@northfield.example', 'at', 'la', NULL, NULL, NULL, NULL),
              ('tg', 'telegram', '7000000001', NULL, '{"pts":1}', 't', 'telegram', 'Telegram', NULL, 0, NULL, NULL, NULL, NULL, 'c', 'live', 'b'),
              ('jm', 'jmap', 'test@harborline.example', NULL, '{"email":"s1"}', 't', 'jmap', 'harborline', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('cv', 't', 't', 'gm', 'th1'), ('cf', 't', 't', 'fb', NULL), ('ct', 't', 't', 'tg', NULL), ('cj', 't', 't', 'jm', NULL)`,
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
    expect(INBOX_VERSION).toBeGreaterThanOrEqual(23)
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT * FROM mailbox ORDER BY id`).all()).toEqual(before)
    expect((db.query(`PRAGMA table_info(mailbox)`).all() as { name: string }[]).map((c) => c.name)).toEqual(columns)
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect([counts('conversation'), counts('message'), counts('arrival_owed')]).toEqual([4, 2, 1])
    // The references still point at the table by name.
    expect(() =>
      db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('x', 't', 't', 'nope')`),
    ).toThrow(/FOREIGN KEY/)
    // The two new columns are empty on everything that was there.
    expect(db.query(`SELECT text_chat_id, text_kind FROM conversation`).all()).toEqual(
      Array(4).fill({ text_chat_id: null, text_kind: null }),
    )
  })

  test('a texts mailbox is one per address, takes the two new bridge states, and the table still takes no other kind', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name, bridge_state) VALUES ('tx', 'texts', 'phone-1', 't', 'texts', 'Texts', 'phone-not-answering')`,
    )
    db.run(`UPDATE mailbox SET bridge_state = 'session-taken' WHERE id = 'tx'`)
    expect(() => db.run(`UPDATE mailbox SET bridge_state = 'asleep' WHERE id = 'tx'`)).toThrow(/CHECK/)
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'texts', 'phone-1', 't', 'x')`,
      ),
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('y', 'signal', '1', 't', 'x')`,
      ),
    ).toThrow(/CHECK/)
    // Telegram's states are still taken, and an old kind too.
    db.run(`UPDATE mailbox SET bridge_state = 'signed-out' WHERE id = 'tg'`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('g2', 'gmail', 'second@example.com', 't', 'x')`,
    )
  })

  test('a chat is one conversation per mailbox, in two mailboxes alike, and a conversation with no chat is many', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('tx', 'texts', 'phone-1', 't', 'x')`,
    )
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, text_chat_id, text_kind) VALUES ('a', 't', 't', 'tx', 'c-1', 'person'), ('b', 't', 't', 'gm', 'c-1', 'person')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, text_chat_id) VALUES ('c', 't', 't', 'tx', 'c-1')`,
      ),
    ).toThrow(/UNIQUE/)
    db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('d', 't', 't', 'tx')`)
    db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('e', 't', 't', 'tx')`)
  })

  test('the Gmail columns keep meaning Gmail, and the earlier kinds’ ids are still unique per mailbox', () => {
    const { sql, db } = deployed()
    migrate(sql)
    expect(() =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('d', 't', 't', 'gm', 'th1')`,
      ),
    ).toThrow(/UNIQUE/)
  })
})
