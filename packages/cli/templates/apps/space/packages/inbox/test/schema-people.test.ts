import { describe, expect, test } from 'bun:test'
import { type PeopleSource, peopleOnMailbox, settleMailboxPeople } from '../src/store/people'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * Migration 19 (store version 20), the people of every mailbox: run over a store with today's schema (version 19) holding a row of every kind of mailbox, with
 * the checks enforced. It adds one table and fills only what the store knows on its own (a Gmail account is its connector's); `settleMailboxPeople` then fills the rest from what the install says. The pin of the version is in schema.test.ts.
 */

const OWNER = 'tessa@northfield.example'

/** A deployed store at version 19 holding one row of every kind, with the conversation and message that point at each. */
function deployed() {
  const { sql, db } = memoryDatabase()
  sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
  for (const step of INBOX_MIGRATIONS.slice(0, 19)) sql.exec(step)
  sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 19)`)
  db.run(
    `INSERT INTO mailbox (id, kind, address, refresh_token, connected_at, connected_by, display_name)
     VALUES ('gm1', 'gmail', 'tessa@northfield.example', 'tok', '2026-11-01T00:00:00.000Z', 'tessa@northfield.example', 'northfield'),
            ('gm2', 'gmail', 'tessa@ashgrove.example', 'tok2', '2026-11-04T00:00:00.000Z', 'Tessa@Northfield.example ', 'ashgrove'),
            ('gm3', 'gmail', 'odd@example.com', NULL, '2026-11-05T00:00:00.000Z', 'agent:x', 'odd'),
            ('fb', 'cloudflare', 'info@ridgewaycycles.example', NULL, '2026-11-02T00:00:00.000Z', 'cloudflare', 'Ridgeway'),
            ('rc', 'cloudflare', 'hello@shiftlantern.example', NULL, '2026-11-02T00:00:00.000Z', 'cloudflare', 'ShiftLantern'),
            ('tg', 'telegram', '7000000001', NULL, '2026-11-03T00:00:00.000Z', 'telegram', 'Telegram'),
            ('jm', 'jmap', 'test@harborline.example', NULL, '2026-11-04T00:00:00.000Z', 'jmap', 'harborline')`,
  )
  db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
  db.run(`INSERT INTO identity VALUES ('i1', 'c1', 'email', 'a@example.com', 't')`)
  db.run(
    `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id) VALUES ('cv1', 't', 't', 'gm1'), ('cv2', 't', 't', 'fb')`,
  )
  db.run(
    `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by, mailbox_id)
     VALUES ('m1', 'cv1', 'i1', 'in', 'sent', 'hello', 't', 'gmail', 't', 'gmail', 'gm1'), ('m2', 'cv2', 'i1', 'in', 'sent', 'hi', 't', 'cloudflare', 't', 'cloudflare', 'fb')`,
  )
  return { sql, db }
}

const tables = [
  'mailbox',
  'conversation',
  'message',
  'contact',
  'identity',
  'participant',
  'setting',
  'audit',
  'device',
]

describe('migration 19: the people of every mailbox', () => {
  test('it adds one table and changes nothing else, and fills a Gmail account with its connector, lower case', () => {
    const { sql, db } = deployed()
    // Without the column a later migration added to `message` (migration 20, `calendar`): this test is about what migration 19 changes.
    const rowsOf = (t: string) =>
      db
        .query(`SELECT * FROM ${t} ORDER BY rowid`)
        .all()
        .map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => k !== 'calendar')))
    const before = Object.fromEntries(tables.map((t) => [t, rowsOf(t)]))
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(INBOX_VERSION).toBeGreaterThanOrEqual(20)
    for (const t of tables) expect(rowsOf(t), t).toEqual(before[t] as never)
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.query(`SELECT mailbox_id, person, added_by FROM mailbox_person ORDER BY mailbox_id`).all()).toEqual([
      { mailbox_id: 'gm1', person: OWNER, added_by: 'migration 19' },
      { mailbox_id: 'gm2', person: OWNER, added_by: 'migration 19' },
    ])
    // A person is on a mailbox once.
    expect(() =>
      db.run(
        `INSERT INTO mailbox_person (mailbox_id, person, added_at, added_by) VALUES ('gm1', '${OWNER}', 't', 'x')`,
      ),
    ).toThrow()
  })

  test('it is applied once, and a build from before it refuses the store it made', () => {
    const { sql } = deployed()
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT count(*) AS n FROM mailbox_person`).one().n).toBe(2)
  })

  test('the rest are filled when the object starts, from what the install says: the declared people, else the owner, and a mailbox nobody is on is the owner’s', () => {
    const { sql } = deployed()
    migrate(sql)
    const source: PeopleSource = {
      owner: OWNER,
      team: [OWNER, 'bea@northfield.example'],
      peopleOf: (kind, address) =>
        kind === 'telegram'
          ? [OWNER]
          : kind === 'cloudflare' && address === 'hello@shiftlantern.example'
            ? [OWNER, 'bea@northfield.example']
            : kind === 'gmail'
              ? null
              : [OWNER],
    }
    expect(settleMailboxPeople(sql, source, 'now')).toBe(6)
    const on = (id: string) => peopleOnMailbox(sql, id).sort()
    expect(on('gm1')).toEqual([OWNER])
    expect(on('gm2')).toEqual([OWNER])
    // A Gmail account the migration found no connector for (an agent's) is the owner's.
    expect(on('gm3')).toEqual([OWNER])
    expect(on('fb')).toEqual([OWNER])
    expect(on('rc')).toEqual(['bea@northfield.example', OWNER].sort())
    expect(on('tg')).toEqual([OWNER])
    expect(on('jm')).toEqual([OWNER])
    // Settled: nothing more to write, and a second start changes nothing.
    expect(settleMailboxPeople(sql, source, 'later')).toBe(0)
  })

  test('a person a source stops naming is taken off, a source that says nothing leaves a list as it is, and a source that does name people for a Gmail account (people kept by the space, later) is followed', () => {
    const { sql } = deployed()
    migrate(sql)
    const first: PeopleSource = {
      owner: OWNER,
      team: [OWNER, 'bea@northfield.example'],
      peopleOf: (kind) => (kind === 'cloudflare' ? [OWNER, 'bea@northfield.example'] : null),
    }
    settleMailboxPeople(sql, first, 'a')
    expect(peopleOnMailbox(sql, 'fb').sort()).toEqual(['bea@northfield.example', OWNER].sort())
    // Saying nothing of Gmail leaves the connector on it.
    expect(peopleOnMailbox(sql, 'gm1')).toEqual([OWNER])
    const second: PeopleSource = {
      owner: OWNER,
      team: [OWNER, 'someone@else.example'],
      peopleOf: (kind) => (kind === 'cloudflare' ? [OWNER] : kind === 'gmail' ? ['someone@else.example'] : null),
    }
    settleMailboxPeople(sql, second, 'b')
    expect(peopleOnMailbox(sql, 'fb')).toEqual([OWNER])
    expect(peopleOnMailbox(sql, 'gm1')).toEqual(['someone@else.example'])
  })

  test('an address that is no person of the install cannot see anything, so it is taken off and the mailbox is the owner’s: an actor that was never a person, or one who has left', () => {
    const { sql, db } = deployed()
    // A Gmail account somebody connected as an address that is no person of Northfield's install (a dev identity, say): the migration filled it with them.
    db.run(`UPDATE mailbox SET connected_by = 'dev@localhost' WHERE id = 'gm2'`)
    migrate(sql)
    expect(peopleOnMailbox(sql, 'gm2')).toEqual(['dev@localhost'])
    const source: PeopleSource = { owner: OWNER, team: [OWNER], peopleOf: () => null }
    settleMailboxPeople(sql, source, 'now')
    expect(peopleOnMailbox(sql, 'gm2')).toEqual([OWNER])
    // One who was on a list and has left the install is taken off it as well.
    db.run(
      `INSERT INTO mailbox_person (mailbox_id, person, added_at, added_by) VALUES ('fb', 'gone@northfield.example', 't', 'x')`,
    )
    settleMailboxPeople(sql, source, 'later')
    expect(peopleOnMailbox(sql, 'fb')).toEqual([OWNER])
  })
})
