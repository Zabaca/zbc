// Telling the live object that mail moved: which calls tell it, that it is told only after the change is stored, and that a live object that
// is down changes nothing about the call. The real Durable Object class is driven, over a real SQLite behind the real migrations (as packages/knowledge/test/durable.test.ts drives its own).
import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall } from '@space/workspace'
import {
  ARRIVAL_METHODS,
  ASSISTANT_METHODS,
  JMAP_METHODS,
  MAIL_METHODS,
  NOTIFY_METHODS,
  RESTORE_METHODS,
  SPACE_METHODS,
  STORE_METHODS,
  TELEGRAM_MEDIA_METHODS,
  TELEGRAM_METHODS,
} from '../src/app'
import { CHANGING_CALLS, changesMail, inboxPeople, UNFOLLOWED_CALLS } from '../src/live'
import { deferredStart } from '../test-support/deferred-start'
import { sqlOver } from '../test-support/sql-over-sqlite'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))

type Obj = { call(method: string, args: unknown[]): Promise<unknown>; alarm(): Promise<void> }
let InboxDO: new (ctx: unknown, env: unknown) => Obj

beforeAll(async () => {
  InboxDO = ((await import('../src/durable')) as unknown as { InboxDO: typeof InboxDO }).InboxDO
})

const settle = () => new Promise((r) => setTimeout(r, 0))

/** The object, in a real SQLite, whose environment binds a live object that runs `tell` for each message. */
async function made(tell: (m: unknown, db: Database) => void) {
  const start = deferredStart()
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  const ctx = {
    storage: {
      sql: sqlOver(db),
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: start.blockConcurrencyWhile,
  }
  const live = {
    idFromName: (n: string) => n,
    get: () => ({ tell: (m: unknown) => tell(m, db), openPeople: () => [] }),
  }
  const object = new InboxDO(ctx, { LIVE: live }) as Obj
  await start.started()
  return object
}

describe('which calls tell', () => {
  test('every name the object’s `call` accepts is either one that changes what a screen draws or one that does not, so a new method is put in one on purpose', () => {
    const accepted = [
      ...STORE_METHODS,
      ...SPACE_METHODS,
      ...TELEGRAM_METHODS,
      ...TELEGRAM_MEDIA_METHODS,
      ...MAIL_METHODS,
      ...JMAP_METHODS,
      ...NOTIFY_METHODS,
      ...ARRIVAL_METHODS,
      ...ASSISTANT_METHODS,
      ...RESTORE_METHODS,
    ]
    expect([...CHANGING_CALLS, ...UNFOLLOWED_CALLS].sort()).toEqual([...new Set(accepted)].sort())
    expect(CHANGING_CALLS.filter((m) => (UNFOLLOWED_CALLS as readonly string[]).includes(m))).toEqual([])
  })

  test('the changes the spec names are all there: a sync, a Cloudflare arrival, a send, a read mark, a close, a draft, a contact, a bounce and a restore', () => {
    for (const m of [
      'receivePush',
      'runDaily',
      'fileArrival',
      'sendDraft',
      'finishCompose',
      'changeConversation',
      'createDraft',
      'chat',
      'saveContactProfile',
      'keepDeliveryEvents',
      'confirmRestore',
    ]) {
      expect(changesMail(m), m).toBe(true)
    }
    for (const m of ['listConversations', 'spaceConversations', 'getConversation', 'readAttachment', 'noteCompose'])
      expect(changesMail(m), m).toBe(false)
  })

  test('mail is for the install’s people, the owner first', () => {
    const read = (file: string) => createInstall(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')))
    expect(inboxPeople(read('../../workspace/northfield/workspace.json'))).toEqual(['tessa@northfield.example'])
    // Another company's install has its own owner, and everyone of the install is told that mail moved: which mail each may see is the inbox's own rule (src/queue.ts `canSee`), applied to what their page reads in answer.
    expect(inboxPeople(read('../../workspace/test/fixtures/pinecrest.json'))).toEqual([
      'lane@pinecrest.test',
      'corin@pinecrest.test',
      'dana@pinecrest.test',
    ])
  })
})

describe('the object', () => {
  test('tells the owner’s pages that mail moved once a change has been stored, and a read tells nobody', async () => {
    const told: unknown[] = []
    const object = await made((m) => void told.push(m))
    await settle() // its own start tells once: a new session is where a restore takes effect
    told.length = 0
    await object.call('listDrafts', [])
    await object.call('listContacts', [])
    await settle()
    expect(told).toEqual([])
    await object.call('renameContact', ['no-such-contact', 'New Name', 'tessa@northfield.example']).catch(() => {})
    await settle()
    expect(told).toEqual([{ part: 'mail', people: ['tessa@northfield.example'] }])
  })

  test('a start of the object tells, because a restore takes effect at a new session', async () => {
    const told: unknown[] = []
    await made((m) => void told.push(m))
    await settle()
    expect(told).toEqual([{ part: 'mail', people: ['tessa@northfield.example'] }])
  })

  test('a live object that is down never fails or slows the call that caused the message', async () => {
    const quiet = console.warn
    console.warn = () => {}
    try {
      const object = await made(() => {
        throw new Error('the live object is down')
      })
      await settle()
      await expect(object.call('listDrafts', [])).resolves.toBeDefined()
      await object
        .call('renameContact', ['nobody', 'X', 'tessa@northfield.example'])
        .catch((e: Error) => expect(e.message).not.toContain('live object'))
      await settle()
    } finally {
      console.warn = quiet
    }
  })
})
