import { describe, expect, test } from 'bun:test'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * The runner and the schema it builds. The version is pinned on purpose: the
 * list is append-only, and a test that fails when someone inserts or edits an
 * entry in the middle is the only enforcement there is.
 */

describe('migrations', () => {
  test('a fresh store is brought to the current version, and again is a no-op', () => {
    const { sql } = memoryDatabase()
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT applied FROM inbox_meta`).one().applied).toBe(INBOX_VERSION)
  })

  test('the applied version is pinned: appending moves it, editing in the middle must not', () => {
    // Step 1 shipped TWO migrations (the second is the carry's tombstones), step 2
    // appended the third (Gmail), step 3 the fourth (the read and closed stamps) and
    // step 4 the fifth (a draft's revision and a message's Reply-To) and step 5 the
    // sixth (a contact's Client) and step 6 the seventh (Claude's sending switch and the
    // instruction a send carries), and notifications the eighth (devices and a message's
    // notification marks), and Ridgeway's mailbox the ninth (the mailbox table made again for a
    // second kind), and the assistant the tenth (what it owes, what each call cost, the knowledge base's shape), and the draft chat
    // the eleventh (its turns, and the entry a proposed change would change), and Ridgeway's spam check the twelfth (what Clef said
    // of a message), and the People fields the thirteenth, and the delivery reports of the mail sent as a Cloudflare mailbox the fourteenth, and several Gmail accounts the fifteenth, and the calendar event key the sixteenth, and the Telegram bridge's mailbox the seventeenth, and its groups and channels the eighteenth, and the JMAP mailbox the nineteenth, and the people of every mailbox the twentieth, and what an email's calendar part says the twenty-first.
    // When a later step appends, update this number in the same change; if it moves without an append, an entry was deleted.
    expect(INBOX_MIGRATIONS).toHaveLength(21)
  })

  test('a store at step 4 takes the Client columns and every contact it had is under no Client', () => {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 5)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 5)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)

    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT client_id, client_set_by, client_set_at FROM contact`).one()).toEqual({
      client_id: null,
      client_set_by: null,
      client_set_at: null,
    })
  })

  test('a store at step 5 takes the switch and the instruction columns: Claude cannot send, and no message has an instruction', () => {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 6)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 6)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('i1', 'c1', 'email', 'a@x.example.com', 't')`,
    )
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by)
       VALUES ('m1', 'i1', 'out', 'draft', 'Hi', 't', 'x', 't', 'x')`,
    )

    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT count(*) AS n FROM setting`).one().n).toBe(0)
    expect(sql.exec(`SELECT instruction_text, instruction_where, instruction_at FROM message`).one()).toEqual({
      instruction_text: null,
      instruction_where: null,
      instruction_at: null,
    })
  })

  test('a store before notifications takes the device table and the marks: nothing it held owes a notification', () => {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 7)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 7)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('i1', 'c1', 'email', 'a@x.example.com', 't')`,
    )
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, labels)
       VALUES ('m1', 'i1', 'in', 'sent', 'Hi', 't', 'x', 't', 'x', '["INBOX","UNREAD"]')`,
    )

    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT notify, notified_at FROM message`).one()).toEqual({ notify: null, notified_at: null })
    expect(sql.exec(`SELECT count(*) AS n FROM device`).one().n).toBe(0)
  })

  test('a notification mark outside owed, sent and dropped is refused, and a push address is one device', () => {
    const { sql, db } = memoryDatabase()
    migrate(sql)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('i1', 'c1', 'email', 'a@x.example.com', 't')`,
    )
    expect(() =>
      db.run(
        `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, notify)
         VALUES ('m1', 'i1', 'in', 'sent', 'Hi', 't', 'x', 't', 'x', 'maybe')`,
      ),
    ).toThrow()
    const device = (id: string) =>
      db.run(
        `INSERT INTO device (id, endpoint, p256dh, auth, label, added_at, added_by)
         VALUES ('${id}', 'https://fcm.googleapis.com/fcm/send/x', 'k', 'a', 'Chrome', 't', 'x')`,
      )
    device('d1')
    expect(() => device('d2')).toThrow()
  })

  test('a store migrated by a newer deploy is refused, loudly', () => {
    const { sql } = memoryDatabase()
    migrate(sql)
    sql.exec(`UPDATE inbox_meta SET applied = ?1`, INBOX_VERSION + 1)
    expect(() => migrate(sql)).toThrow(/older deploy/)
  })

  test('only part of the way applied resumes from where it stopped', () => {
    const { sql } = memoryDatabase()
    sql.exec(`CREATE TABLE inbox_meta ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT count(*) AS n FROM contact`).one().n).toBe(0)
  })
})

describe('the constraints that carry rules', () => {
  const arranged = () => {
    const h = memoryDatabase()
    migrate(h.sql)
    h.db.run(
      `INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x'), ('c2', 'Bob', 't', 'x')`,
    )
    h.db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    return h
  }

  test('an address belongs to exactly one contact', () => {
    const { db } = arranged()
    expect(() => db.run(`INSERT INTO identity VALUES ('i2', 'c2', 'email', 'a@example.com', 't')`)).toThrow(/UNIQUE/)
    expect(() => db.run(`INSERT INTO identity VALUES ('i3', 'c2', 'sms', 'a@example.com', 't')`)).not.toThrow()
  })

  test('foreign keys are on: an identity cannot point at a contact that is not there', () => {
    const { db } = arranged()
    expect(() => db.run(`INSERT INTO identity VALUES ('i4', 'ghost', 'email', 'g@example.com', 't')`)).toThrow(
      /FOREIGN KEY/,
    )
  })

  test('a message status outside the option’s list is refused, and a source_ref is unique', () => {
    const { db } = arranged()
    const insert = (id: string, status: string, ref: string | null) =>
      db.run(
        `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, source_ref)
         VALUES (?, 'i1', 'out', ?, 'b', 't', 'x', 't', 'x', ?)`,
        [id, status, ref],
      )
    expect(() => insert('m1', 'sent-ish', null)).toThrow(/CHECK/)
    expect(() => insert('m2', 'manual-sent', 'outbox:1')).not.toThrow()
    expect(() => insert('m3', 'draft', 'outbox:1')).toThrow(/UNIQUE/)
    expect(() => insert('m4', 'draft', null)).not.toThrow()
    expect(() => insert('m5', 'draft', null)).not.toThrow()
  })
})

describe('the Gmail columns', () => {
  const arranged = () => {
    const h = memoryDatabase()
    migrate(h.sql)
    h.db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    h.db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    h.db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('mb', 'gmail', 'tessa@northfield.example', 't', 'x')`,
    )
    return h
  }

  test('a mailbox is unique per kind and address, and only Gmail is a kind', () => {
    const { db } = arranged()
    const insert = (id: string, kind: string) =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES (?, ?, 'tessa@northfield.example', 't', 'x')`,
        [id, kind],
      )
    expect(() => insert('mb2', 'gmail')).toThrow(/UNIQUE/)
    expect(() => insert('mb3', 'slack')).toThrow(/CHECK/)
  })

  test('a Gmail thread is unique per mailbox, and manual conversations (no mailbox) are not constrained', () => {
    const { db } = arranged()
    const insert = (id: string, mailbox: string | null, thread: string | null) =>
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES (?, 't', 't', ?, ?)`,
        [id, mailbox, thread],
      )
    expect(() => insert('v1', 'mb', 't1')).not.toThrow()
    expect(() => insert('v2', 'mb', 't1')).toThrow(/UNIQUE/)
    expect(() => insert('v3', null, null)).not.toThrow()
    expect(() => insert('v4', null, null)).not.toThrow()
  })

  test('a Gmail message id is unique per mailbox, which is what makes an ingest an upsert', () => {
    const { db } = arranged()
    const insert = (id: string, gmailId: string | null) =>
      db.run(
        `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id, gmail_id)
         VALUES (?, 'i1', 'in', 'sent', 'b', 't', 'gmail', 't', 'gmail', 'mb', ?)`,
        [id, gmailId],
      )
    expect(() => insert('m1', 'g1')).not.toThrow()
    expect(() => insert('m2', 'g1')).toThrow(/UNIQUE/)
    expect(() => insert('m3', null)).not.toThrow()
    expect(() => insert('m4', null)).not.toThrow()
  })

  test('a store that already held step 1 data is brought forward without losing it', () => {
    const { db, sql } = memoryDatabase()
    // Apply only the first two migrations, as a step 1 deploy would have.
    sql.exec(`CREATE TABLE inbox_meta ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const migration of INBOX_MIGRATIONS.slice(0, 2)) sql.exec(migration)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 2)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by)
       VALUES ('m1', 'i1', 'out', 'draft', 'carried', 't', 'outbox', 't', 'outbox')`,
    )

    expect(migrate(sql)).toBe(INBOX_VERSION)
    const row = db.query(`SELECT body, labels, attachments, mailbox_id, gmail_id FROM message WHERE id = 'm1'`).get()
    expect(row).toEqual({ body: 'carried', labels: '[]', attachments: '[]', mailbox_id: null, gmail_id: null })
  })

  test('step 4 is additive: a message held before it has revision 0 and no recorded Reply-To (unknown, not empty)', () => {
    const { db, sql } = memoryDatabase()
    sql.exec(`CREATE TABLE inbox_meta ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const migration of INBOX_MIGRATIONS.slice(0, 4)) sql.exec(migration)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 4)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO message (id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by)
       VALUES ('m1', 'i1', 'out', 'draft', 'held', 't', 'x', 't', 'x')`,
    )
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT body, rev, reply_to_header FROM message WHERE id = 'm1'`).get()).toEqual({
      body: 'held',
      rev: 0,
      reply_to_header: null,
    })
  })

  describe('migration 8: the mailbox table made again for a second kind', () => {
    /** A deployed store at version 8 (everything before the rebuild) holding Tessa's Gmail mailbox and mail that points at it, checks enforced. */
    function deployed() {
      const { sql, db } = memoryDatabase()
      sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
      for (const step of INBOX_MIGRATIONS.slice(0, 8)) sql.exec(step)
      sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 8)`)
      db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
      db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
      db.run(
        `INSERT INTO mailbox (id, kind, address, refresh_token, scopes, history_id, watch_expiry, connected_at, connected_by,
                              last_push_at, last_sync_at, last_error, last_error_at, last_resync_at, retry_count, push_seq,
                              synced_seq, push_suspect_at, job)
         VALUES ('mb', 'gmail', 'tessa@northfield.example', 'the-refresh-token', 'gmail.modify', '777', 'w', 'ct', 'tessa@northfield.example',
                 'lp', 'ls', 'oops', 'le', 'lr', 3, 9, 8, 'ps', '{"kind":"fill"}')`,
      )
      db.run(
        `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, gmail_thread_id) VALUES ('cv', 't', 't', 'mb', 'th1')`,
      )
      db.run(
        `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at,
                              updated_by, mailbox_id, gmail_id, labels)
         VALUES ('m1', 'cv', 'i1', 'in', 'sent', 'hello', 't', 'gmail', 't', 'gmail', 'mb', 'g1', '["INBOX"]')`,
      )
      return { sql, db }
    }

    test('Tessa’s Gmail row, his conversation and his message all survive with the checks enforced, and nothing dangles', () => {
      const { sql, db } = deployed()
      const before = db.query(`SELECT * FROM mailbox`).all()
      expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })

      expect(migrate(sql)).toBe(INBOX_VERSION)

      const after = db.query(`SELECT * FROM mailbox`).all() as Record<string, unknown>[]
      expect(after).toHaveLength(1)
      // Column for column, token, cursor and job included, with only the new columns added: the two of migration 8, and
      // migration 9's three (the assistant never runs on a row that was there before it).
      expect(after[0]).toEqual({
        ...(before[0] as object),
        // Migration 14 labels the Gmail row that already exists, and adds the column that says a grant lapsed.
        display_name: 'northfield',
        grant_lapsed_at: null,
        // Migration 16: the bridge's three, on a row that is not Telegram's.
        checked_in_at: null,
        bridge_state: null,
        bridge_state_at: null,
        last_arrival_at: null,
        assistant: 0,
        assistant_set_by: null,
        assistant_set_at: null,
      })
      expect(db.query(`SELECT mailbox_id FROM conversation`).get()).toEqual({ mailbox_id: 'mb' })
      expect(db.query(`SELECT mailbox_id, gmail_id, labels FROM message`).get()).toEqual({
        mailbox_id: 'mb',
        gmail_id: 'g1',
        labels: '["INBOX"]',
      })
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
      // The references still point at the table, by name: a conversation for a mailbox that does not exist is refused.
      expect(() =>
        db.run(
          `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('x', 't', 't', 'nope')`,
        ),
      ).toThrow(/FOREIGN KEY/)
    })

    test('it takes a Cloudflare mailbox and nothing else, once per address, and Gmail’s rows keep working', () => {
      const { sql, db } = deployed()
      migrate(sql)
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name)
         VALUES ('fb', 'cloudflare', 'info@ridgewaycycles.example', 't', 'cloudflare', 'Ridgeway Cycles')`,
      )
      expect(() =>
        db.run(
          `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'imap', 'a@x.example.com', 't', 'x')`,
        ),
      ).toThrow(/CHECK/)
      expect(() =>
        db.run(
          `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('y', 'cloudflare', 'info@ridgewaycycles.example', 't', 'x')`,
        ),
      ).toThrow(/UNIQUE/)
      db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('cf', 't', 't', 'fb')`)
      expect(db.query(`SELECT count(*) AS n FROM conversation`).get()).toEqual({ n: 2 })
    })

    test('it does not matter whether the store holds a mailbox at all: a fresh store and one with no Gmail connected migrate', () => {
      const { sql } = memoryDatabase()
      expect(migrate(sql)).toBe(INBOX_VERSION)
      const { sql: older, db } = memoryDatabase()
      older.exec(
        `CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`,
      )
      for (const step of INBOX_MIGRATIONS.slice(0, 8)) older.exec(step)
      older.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 8)`)
      expect(migrate(older)).toBe(INBOX_VERSION)
      expect(db.query(`SELECT count(*) AS n FROM mailbox`).get()).toEqual({ n: 0 })
    })

    test('a message and a conversation held before it have no sort, no subject key, no arrival key and no raw copy', () => {
      const { sql, db } = deployed()
      migrate(sql)
      expect(db.query(`SELECT sort, subject_key FROM conversation`).get()).toEqual({ sort: null, subject_key: null })
      expect(db.query(`SELECT arrival_key, raw_key FROM message`).get()).toEqual({ arrival_key: null, raw_key: null })
    })

    test('a sort is one of the four words, and a message is unique per mailbox by its arrival key', () => {
      const { sql, db } = deployed()
      migrate(sql)
      expect(() => db.run(`UPDATE conversation SET sort = 'maybe'`)).toThrow(/CHECK/)
      db.run(`UPDATE conversation SET sort = 'customer'`)
      const insert = (id: string, key: string) =>
        db.run(
          `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at,
                                updated_by, mailbox_id, arrival_key)
           VALUES (?, 'cv', 'i1', 'in', 'sent', 'b', 't', 'x', 't', 'x', 'mb', ?)`,
          [id, key],
        )
      insert('a', '<one@x>')
      expect(() => insert('b', '<one@x>')).toThrow(/UNIQUE/)
      insert('c', '<two@x>')
    })
  })
})

describe('migration 9: the assistant', () => {
  /** A deployed store at version 9 (everything before the assistant) holding Tessa's Gmail mailbox, a Ridgeway one and mail on both. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 9)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 9)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name)
       VALUES ('gm', 'gmail', 'tessa@northfield.example', 't', 'x', ''), ('fb', 'cloudflare', 'info@ridgewaycycles.example', 't', 'cloudflare', 'Ridgeway Cycles')`,
    )
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, sort) VALUES ('cf', 't', 't', 'fb', 'spam')`,
    )
    db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at,
                            updated_by, mailbox_id, arrival_key)
       VALUES ('m1', 'cf', 'i1', 'in', 'sent', 'hello', 't', 'cloudflare', 't', 'cloudflare', 'fb', '<a@x>')`,
    )
    return { sql, db }
  }

  test('the rows held before keep everything, the assistant is off on every one of them, and a sort held has nobody who set it', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM mailbox ORDER BY id`).all()
    expect(migrate(sql)).toBe(INBOX_VERSION)
    const after = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    expect(after).toEqual(
      (before as Record<string, unknown>[]).map((row) => ({
        ...row,
        // Migration 14: the Gmail row is labelled; a Cloudflare row keeps its name; none has lapsed.
        display_name: row.kind === 'gmail' ? 'northfield' : row.display_name,
        grant_lapsed_at: null,
        checked_in_at: null,
        bridge_state: null,
        bridge_state_at: null,
        assistant: 0,
        assistant_set_by: null,
        assistant_set_at: null,
      })),
    )
    expect(
      db.query(`SELECT sort, sort_by, sort_at, assist_failed_at, assist_failed_reason FROM conversation`).get(),
    ).toEqual({
      sort: 'spam',
      sort_by: null,
      sort_at: null,
      assist_failed_at: null,
      assist_failed_reason: null,
    })
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    for (const table of ['assist_owed', 'assistant_usage', 'knowledge_entry', 'knowledge_version']) {
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  test('the work owed is one row per message, and a row names a message, a conversation and a mailbox that exist', () => {
    const { sql, db } = deployed()
    migrate(sql)
    const owe = (message: string, conversation = 'cf', mailbox = 'fb') =>
      db.run(
        `INSERT INTO assist_owed (message_id, conversation_id, mailbox_id, owed_at, next_try_at) VALUES (?, ?, ?, 't', 't')`,
        [message, conversation, mailbox],
      )
    owe('m1')
    expect(() => owe('m1')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => owe('nope')).toThrow(/FOREIGN KEY/)
    expect(db.query(`SELECT attempts, notify FROM assist_owed`).get()).toEqual({ attempts: 0, notify: 1 })
  })

  test('a call to the model is one of three outcomes, and the knowledge base keeps its versions apart from its entries', () => {
    const { sql, db } = deployed()
    migrate(sql)
    const use = (outcome: string) =>
      db.run(
        `INSERT INTO assistant_usage (at, mailbox_id, conversation_id, message_id, operation, model, outcome) VALUES ('t', 'fb', 'cf', 'm1', 'sort-draft', 'm', ?)`,
        [outcome],
      )
    use('ok')
    use('error')
    use('unreadable')
    expect(() => use('fine')).toThrow(/CHECK/)

    const entry = (status: string, ref: string | null = null) =>
      db.run(
        `INSERT INTO knowledge_entry (id, mailbox_id, title, body, status, created_at, created_by, updated_at, updated_by, source_ref)
         VALUES (?, 'fb', 'Prices', 'Tune-up $40', ?, 't', 'tessa', 't', 'tessa', ?)`,
        [`e-${status}-${ref}`, status, ref],
      )
    entry('active', 'ridgeway:1')
    entry('proposed')
    entry('removed')
    expect(() => entry('draft')).toThrow(/CHECK/)
    expect(() => entry('active', 'ridgeway:1')).toThrow(/UNIQUE/)
    db.run(
      `INSERT INTO knowledge_version (entry_id, by, at, title, body) VALUES ('e-active-ridgeway:1', 'tessa', 't', 'Prices', 'Tune-up $40')`,
    )
    expect(() =>
      db.run(`INSERT INTO knowledge_version (entry_id, by, at, title, body) VALUES ('nope', 'x', 't', 't', 'b')`),
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('migration 10: the draft chat and a proposed change', () => {
  /** A deployed store at the assistant's migration holding a Ridgeway mailbox and an entry with a version. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 10)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 10)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name)
       VALUES ('fb', 'cloudflare', 'info@ridgewaycycles.example', 't', 'cloudflare', 'Ridgeway Cycles')`,
    )
    db.run(
      `INSERT INTO knowledge_entry (id, mailbox_id, title, body, status, created_at, created_by, updated_at, updated_by)
       VALUES ('e1', 'fb', 'Prices', 'Tune-up $40', 'active', 't', 'tessa', 't', 'tessa')`,
    )
    db.run(
      `INSERT INTO knowledge_version (entry_id, by, at, title, body) VALUES ('e1', 'tessa', 't', 'Prices', 'Tune-up $40')`,
    )
    return { sql, db }
  }

  test('what was held is kept as it was, an entry replaces nothing, and the chat starts empty', () => {
    const { sql, db } = deployed()
    const entries = db.query(`SELECT * FROM knowledge_entry`).all()
    const versions = db.query(`SELECT * FROM knowledge_version`).all()
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT * FROM knowledge_version`).all()).toEqual(versions)
    expect(db.query(`SELECT * FROM knowledge_entry`).all()).toEqual(
      entries.map((e) => ({ ...(e as object), replaces: null })),
    )
    expect(db.query(`SELECT count(*) AS n FROM draft_chat`).get()).toEqual({ n: 0 })
  })

  test('a chat turn needs its draft, its time, who asked, an answer and the revision it started from', () => {
    const { sql, db } = deployed()
    migrate(sql)
    const turn = (over: Record<string, unknown> = {}) => {
      const v = { draft_id: 'd1', at: 't', by: 'tessa', instruction: 'shorter', note: 'ok', rev_before: 0, ...over }
      db.run(
        `INSERT INTO draft_chat (draft_id, at, by, instruction, note, revised, rev_before, rev_after)
         VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
        [v.draft_id, v.at, v.by, v.instruction, v.note, v.rev_before] as never,
      )
    }
    turn()
    // An assistant's own note has no words of Tessa's.
    turn({ by: 'assistant', instruction: null })
    expect(() => turn({ note: null })).toThrow(/NOT NULL/)
    expect(() => turn({ rev_before: null })).toThrow(/NOT NULL/)
    expect(db.query(`SELECT seq FROM draft_chat ORDER BY seq`).all()).toEqual([{ seq: 1 }, { seq: 2 }])
  })
})

describe('migration 11: what Clef said of a message (Ridgeway’s spam check, decision 22)', () => {
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 11)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 11)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name)
       VALUES ('fb', 'cloudflare', 'info@ridgewaycycles.example', 't', 'cloudflare', 'Ridgeway Cycles')`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('i1', 'c1', 'email', 'ann@x.example', 't')`,
    )
    db.run(
      `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, sort, sort_by, sort_at)
       VALUES ('cv', 't', 't', 'fb', 'promotional', 'assistant', 't')`,
    )
    db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id)
       VALUES ('m1', 'cv', 'i1', 'in', 'sent', 'Hello', 't', 'cloudflare', 't', 'cloudflare', 'fb')`,
    )
    return { sql, db }
  }

  test('a message held before has nothing judged, which is NULL and not a score, and nothing else is touched', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM message`).all() as Record<string, unknown>[]
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT * FROM message`).all()).toEqual(
      before.map((m) => ({
        ...m,
        clef_junk: null,
        clef_category: null,
        clef_model: null,
        event_key: null,
        event_kind: null,
        // Migration 16: Telegram's own message id, an edit and a deletion; none on mail that is not Telegram's.
        telegram_msg_id: null,
        edited_at: null,
        deleted_at: null,
        // Migration 17: whether a group message is addressed to Tessa; none on mail that is not a Telegram group message.
        telegram_to_me: null,
        // Migration 18: the JMAP server's own id of a message; none on mail that is not a JMAP mailbox's.
        jmap_id: null,
        // Migration 20: what the email's calendar part says; NULL on mail stored before it (not looked at).
        calendar: null,
      })),
    )
  })

  test('the sort columns are left as they were: nothing is dropped, rewritten or backfilled', () => {
    const { sql, db } = deployed()
    migrate(sql)
    expect(db.query(`SELECT sort, sort_by, sort_at FROM conversation`).get()).toEqual({
      sort: 'promotional',
      sort_by: 'assistant',
      sort_at: 't',
    })
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('a score is a real number, a category and a model are text, and each may be absent', () => {
    const { sql, db } = deployed()
    migrate(sql)
    db.run(`UPDATE message SET clef_junk = 0.84, clef_category = 'vendor_pitch', clef_model = '@cf/cloudflare/clef'`)
    expect(db.query(`SELECT clef_junk, clef_category, clef_model FROM message`).get()).toEqual({
      clef_junk: 0.84,
      clef_category: 'vendor_pitch',
      clef_model: '@cf/cloudflare/clef',
    })
  })
})

describe('migration 14: several Gmail accounts', () => {
  /** A deployed store at version 14 with Tessa's one Gmail row, a Gmail row of a gmail.com address and a Cloudflare row, the Gmail ones unlabelled. */
  function deployed() {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 14)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 14)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, refresh_token, history_id, connected_at, connected_by, display_name)
       VALUES ('gm', 'gmail', 'tessa@northfield.example', 'tok', '5', 't', 'tessa@northfield.example', ''),
              ('g2', 'gmail', 'tessa_marlow@gmail.com', NULL, NULL, 't', 'tessa@northfield.example', ''),
              ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, NULL, 't', 'cloudflare', 'Ridgeway Cycles')`,
    )
    return { sql, db }
  }

  test('each Gmail row is labelled by the part of its address that tells accounts apart, a Cloudflare row keeps its name, and nothing else on any row moves', () => {
    const { sql, db } = deployed()
    const before = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    expect(migrate(sql)).toBe(INBOX_VERSION)
    const after = db.query(`SELECT * FROM mailbox ORDER BY id`).all() as Record<string, unknown>[]
    const names = Object.fromEntries(after.map((r) => [r.id, r.display_name]))
    expect(names).toEqual({ gm: 'northfield', g2: 'tessa_marlow', fb: 'Ridgeway Cycles' })
    expect(after).toEqual(
      before.map((row) => ({
        ...row,
        display_name: names[row.id as string],
        grant_lapsed_at: null,
        checked_in_at: null,
        bridge_state: null,
        bridge_state_at: null,
      })),
    )
  })

  test('a second Gmail row on the same address is still refused, and one on another domain is not', () => {
    const { sql, db } = deployed()
    migrate(sql)
    expect(() =>
      db.run(
        `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('x', 'gmail', 'tessa@northfield.example', 't', 'x')`,
      ),
    ).toThrow(/UNIQUE/)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by) VALUES ('y', 'gmail', 'tessa@ashgrove.example', 't', 'x')`,
    )
    expect(db.query(`SELECT count(*) AS n FROM mailbox WHERE kind = 'gmail'`).get()).toEqual({ n: 3 })
  })
})

describe('migration 15: which calendar event a message is about', () => {
  test('two nullable columns and a partial index on a store at version 15; no message is rewritten', () => {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 15)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 15)`)
    db.run(
      `INSERT INTO mailbox (id, kind, address, connected_at, connected_by, display_name)
       VALUES ('fb', 'cloudflare', 'info@ridgewaycycles.example', 't', 'cloudflare', 'Ridgeway Cycles')`,
    )
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('i1', 'c1', 'email', 'ann@x.example', 't')`,
    )
    db.run(`INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('cv', 't', 't', 'fb')`)
    db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id)
       VALUES ('m1', 'cv', 'i1', 'in', 'sent', 'Hello', 't', 'cloudflare', 't', 'cloudflare', 'fb')`,
    )
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(db.query(`SELECT event_key, event_kind, body FROM message`).all()).toEqual([
      { event_key: null, event_kind: null, body: 'Hello' },
    ])
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'message_event_idx'`).all()).toHaveLength(1)
  })
})
