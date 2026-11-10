import { describe, expect, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Migration 16 (store version 17), the third kind of mailbox: the mailbox table made again, as migration 8 did it, over a store holding every other kind of row with the
 * checks enforced. The pin of the version is in schema.test.ts.
 */

describe('migration 16: the Telegram bridge’s mailbox', () => {
  /** A deployed store at version 16 holding every other kind of row, with the references that point at the mailbox table. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 16)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 16)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, refresh_token, history_id, connected_at, connected_by, display_name, grant_lapsed_at, assistant, assistant_set_by, assistant_set_at, last_arrival_at, job)
       VALUES ('gm', 'gmail', 'tessa@northfield.example', 'tok', '5', 't', 'tessa@northfield.example', 'northfield', 'lapsed', 0, NULL, NULL, NULL, '{"kind":"fill"}'),
              ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, NULL, 't', 'cloudflare', 'Ridgeway Cycles', NULL, 1, 'tessa@northfield.example', 'at', 'la', NULL)`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('cv', 't', 't', 'gm', 'th1'), ('cf', 't', 't', 'fb', NULL)`,
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

  test('every row of every other kind survives column for column with the checks enforced, and nothing that pointed at the mailbox table dangles', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    const counts = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(migrate(sql)).toBe(INBOX_VERSION)
    const after = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    expect(after).toEqual(
      before.map((row) => ({ ...row, checked_in_at: null, bridge_state: null, bridge_state_at: null })),
    )
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect([counts('conversation'), counts('message'), counts('arrival_owed')]).toEqual([2, 2, 1])
    // The references still point at the table by name.
    expect(() =>
      db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('x', 't', 't', 'nope')`),
    ).toThrow(/FOREIGN KEY/)
    expect(db.query(`SELECT telegram_msg_id, edited_at, deleted_at FROM message ORDER BY id`).all()).toEqual([
      { telegram_msg_id: null, edited_at: null, deleted_at: null },
      { telegram_msg_id: null, edited_at: null, deleted_at: null },
    ])
  })

  test('it takes a Telegram mailbox once per account and no other kind, and the bridge’s state is one of three words', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name, bridge_state) VALUES ('tg', 'telegram', '7000000001', 't', 'telegram', 'Telegram', 'live')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'telegram', '7000000001', 't', 'x')`,
      ),
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('y', 'signal', '1', 't', 'x')`,
      ),
    ).toThrow(/CHECK/)
    expect(() => db.run(`UPDATE mailbox SET bridge_state = 'asleep' WHERE id = 'tg'`)).toThrow(/CHECK/)
  })

  test('a Telegram chat is one conversation per mailbox, and a Telegram person has one row', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('tg', 'telegram', '7000000001', 't', 'telegram')`,
    )
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, telegram_chat_id) VALUES ('t1', 't', 't', 'tg', '2001')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, telegram_chat_id) VALUES ('t2', 't', 't', 'tg', '2001')`,
      ),
    ).toThrow(/UNIQUE/)
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, telegram_chat_id) VALUES ('t3', 't', 't', 'tg', '2002')`,
    )
    // Conversations that are not Telegram's are not constrained by it.
    db.run(`INSERT INTO conversation (id, created_at, last_activity_at) VALUES ('m1', 't', 't'), ('m2', 't', 't')`)
    db.run(`INSERT INTO identity VALUES ('tp', 'c1', 'telegram', '2001', 't')`)
    db.run(`INSERT INTO telegram_person (identity_id, bot, username) VALUES ('tp', 0, NULL)`)
    expect(() => db.run(`INSERT INTO telegram_person (identity_id, bot, username) VALUES ('tp', 1, NULL)`)).toThrow(
      /UNIQUE|PRIMARY/,
    )
    expect(() => db.run(`INSERT INTO telegram_person (identity_id, bot, username) VALUES ('nope', 1, NULL)`)).toThrow(
      /FOREIGN KEY/,
    )
    expect(() => db.run(`UPDATE telegram_person SET bot = 2`)).toThrow(/CHECK/)
  })
})

/**
 * Migration 17 (store version 18), groups and channels: four nullable columns over a store that already holds one-to-one Telegram chats, which are left exactly as they were.
 */
describe('migration 17: groups and channels', () => {
  /** A store at version 17 holding a Telegram mailbox with a person's chat and a message in it. */
  function atSeventeen() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 17)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 17)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name) VALUES ('tg', 'telegram', '7000000001', 't', 'telegram', 'Telegram')`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Dana', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'telegram', '2001', 't')`)
    db.run(`INSERT INTO telegram_person (identity_id, bot, username) VALUES ('i1', 0, NULL)`)
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, telegram_chat_id) VALUES ('cv', 't', 't', 'tg', '2001')`,
    )
    db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, arrival_key, telegram_msg_id)
       VALUES ('m1', 'cv', 'i1', 'in', 'sent', 'hi', 't', 'telegram', 't', 'telegram', 'tg', '2001:1', 1)`,
    )
    return { sql, db }
  }

  test('a store at version 17 takes the four columns and nothing that was there changes', () => {
    const { sql, db } = atSeventeen()
    const before = {
      conversation: db.query(`SELECT * FROM conversation`).all() as Record<string, unknown>[],
      person: db.query(`SELECT * FROM telegram_person`).all() as Record<string, unknown>[],
      message: db.query(`SELECT * FROM message`).all() as Record<string, unknown>[],
    }
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT * FROM conversation`).all()).toEqual(
      before.conversation.map((r) => ({ ...r, telegram_kind: null, telegram_pts: null, jmap_thread_id: null })),
    )
    expect(db.query(`SELECT * FROM telegram_person`).all()).toEqual(before.person.map((r) => ({ ...r, chat: null })))
    expect(db.query(`SELECT * FROM message`).all()).toEqual(
      before.message.map((r) => ({ ...r, telegram_to_me: null, jmap_id: null })),
    )
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('a build before it refuses the store it made', () => {
    const { sql } = atSeventeen()
    migrate(sql)
    sql.exec(`UPDATE inbox_meta SET applied = ${INBOX_MIGRATIONS.length + 1}`)
    expect(() => migrate(sql)).toThrow(/older deploy/)
  })
})
