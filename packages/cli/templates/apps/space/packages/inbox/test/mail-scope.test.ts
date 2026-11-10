import { describe, expect, test } from 'bun:test'
import { ALL_MAIL, canSee, contactSeen, deviceOwnerOf, type MailScope, mayEnter, scopeOf } from '../src/queue'
import { scopeWhere } from '../src/store/scope'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * The visibility rule, as a table (src/queue.ts: who may see which mail), and its translation to SQL held equal to it over a real SQLite.
 */

const OWNER = scopeOf(['desk', 'books', 'alex-gmail'], true)
const BEA = scopeOf(['desk', 'bea-gmail'], false)
const CAL = scopeOf([], false)

describe('canSee: a person sees the mailboxes they are on, and only the owner sees what belongs to none', () => {
  const table: [string, MailScope, string | null, boolean][] = [
    ['the owner, a mailbox they are on', OWNER, 'books', true],
    ['the owner, another person’s mailbox', OWNER, 'bea-gmail', false],
    ['the owner, mail in no mailbox', OWNER, null, true],
    ['a person, the shared mailbox', BEA, 'desk', true],
    ['a person, their own Gmail', BEA, 'bea-gmail', true],
    ['a person, a mailbox that is the owner’s alone', BEA, 'books', false],
    ['a person, mail in no mailbox', BEA, null, false],
    ['a person on nothing, anything', CAL, 'desk', false],
    ['a person on nothing, mail in no mailbox', CAL, null, false],
    ['everything, any mailbox', ALL_MAIL, 'whatever', true],
    ['everything, no mailbox', ALL_MAIL, null, true],
  ]
  for (const [name, scope, mailbox, expected] of table) test(name, () => expect(canSee(scope, mailbox)).toBe(expected))

  test('an undefined mailbox is no mailbox', () => {
    expect(canSee(BEA, undefined)).toBe(false)
    expect(canSee(OWNER, undefined)).toBe(true)
  })
})

describe('a scope is made from the mailboxes a person is on', () => {
  test('each once, in one order, and only the owner has what belongs to none', () => {
    expect(scopeOf(['b', 'a', 'b'], false)).toEqual({ mailboxIds: ['a', 'b'], unfiled: false })
    expect(scopeOf(['a'], true)).toEqual({ mailboxIds: ['a'], unfiled: true })
  })
})

describe('mayEnter: the owner always, anyone else once they are on a mailbox', () => {
  test('the table', () => {
    expect(mayEnter(scopeOf([], true), true)).toBe(true)
    expect(mayEnter(BEA, false)).toBe(true)
    expect(mayEnter(CAL, false)).toBe(false)
    expect(mayEnter(ALL_MAIL, false)).toBe(true)
  })
})

describe('contactSeen: a contact is seen through the mail they are on', () => {
  test('on a conversation or a draft in a mailbox the person is on', () => {
    expect(contactSeen(BEA, ['books', 'desk'])).toBe(true)
    expect(contactSeen(BEA, ['books'])).toBe(false)
    expect(contactSeen(BEA, [null])).toBe(false)
  })
  test('a contact on no mail at all is the owner’s', () => {
    expect(contactSeen(OWNER, [])).toBe(true)
    expect(contactSeen(BEA, [])).toBe(false)
    expect(contactSeen(CAL, [])).toBe(false)
  })
  test('the owner does not see a contact whose mail is all in mailboxes they are not on', () => {
    expect(contactSeen(OWNER, ['bea-gmail'])).toBe(false)
  })
})

describe('deviceOwnerOf: a device is its adder’s, else the owner’s', () => {
  const team = ['alex@x.example', 'bea@x.example']
  test('the table', () => {
    expect(deviceOwnerOf('bea@x.example', team, 'alex@x.example')).toBe('bea@x.example')
    expect(deviceOwnerOf(' BEA@x.example ', team, 'alex@x.example')).toBe('bea@x.example')
    expect(deviceOwnerOf('agent:abc', team, 'alex@x.example')).toBe('alex@x.example')
    expect(deviceOwnerOf('some-old-actor', team, 'alex@x.example')).toBe('alex@x.example')
  })
})

describe('scopeWhere is canSee in SQL', () => {
  const scopes: [string, MailScope][] = [
    ['the owner', OWNER],
    ['a person', BEA],
    ['a person on nothing', CAL],
    ['everything', ALL_MAIL],
    ['every mailbox and no unfiled mail', { mailboxIds: null, unfiled: false }],
  ]
  const values: (string | null)[] = [null, 'desk', 'books', 'alex-gmail', 'bea-gmail', 'not-a-mailbox']

  for (const [name, scope] of scopes) {
    test(`${name}: every value of a mailbox column is kept exactly when canSee says so`, () => {
      const { db } = memoryDatabase()
      db.run('CREATE TABLE t (n INTEGER PRIMARY KEY, mailbox_id TEXT)')
      for (const [n, v] of values.entries()) db.run('INSERT INTO t (n, mailbox_id) VALUES (?, ?)', [n, v])
      // From a placeholder that is not the first, as the callers use it after their own bindings.
      const where = scopeWhere(scope, 't.mailbox_id', 2)
      const kept = db
        .query(`SELECT n FROM t WHERE ?1 = 1 AND ${where.sql} ORDER BY n`)
        .all(1, ...(where.bindings as never[])) as { n: number }[]
      expect(kept.map((r) => values[r.n])).toEqual(values.filter((v) => canSee(scope, v)))
    })
  }

  test('an id that is a SQL fragment is only ever a value', () => {
    const { db } = memoryDatabase()
    db.run('CREATE TABLE t (mailbox_id TEXT)')
    db.run("INSERT INTO t VALUES ('a'), ('b')")
    const where = scopeWhere({ mailboxIds: ["a') OR 1=1 --"], unfiled: false }, 't.mailbox_id', 1)
    expect(db.query(`SELECT mailbox_id FROM t WHERE ${where.sql}`).all(...(where.bindings as never[]))).toEqual([])
  })
})
