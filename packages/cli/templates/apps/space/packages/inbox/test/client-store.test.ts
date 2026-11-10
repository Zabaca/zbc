import { describe, expect, test } from 'bun:test'
import type { ParsedMessage } from '../src/gmail/types'
import { type ContactRow, QUEUE_PAGE } from '../src/types'
import { count, harness } from '../test-support/harness'

/**
 * The store's Client half over a real SQLite: a contact's Client (assigned, stamped,
 * audited), merge and split, and what the queue's facts and a Client's page are made of.
 * Everything is asserted through the store's own methods or a row count. That a Client
 * EXISTS is not the store's to say (the site's directory vouches for it, in the Worker),
 * so these tests assign plain ids.
 */

const TESSA = 'tessa@northfield.example'
const CLAUDE = 'agent:abc123.access'

function message(over: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    gmailId: 'g1',
    threadId: 't1',
    rfcMessageId: '<g1@example.com>',
    inReplyTo: null,
    from: { name: 'Dana Smith', address: 'dana@example.com' },
    to: [{ name: 'Tessa Marlow', address: TESSA }],
    cc: [],
    fromHeader: 'Dana Smith <dana@example.com>',
    toHeader: 'Tessa Marlow <tessa@northfield.example>',
    ccHeader: '',
    replyToHeader: '',
    subject: 'Revised quote',
    snippet: 'Can you send it?',
    body: 'Hi Tessa, can you send it?',
    bodyTruncated: false,
    attachments: [],
    labels: ['INBOX', 'UNREAD'],
    receivedAt: '2026-10-20T12:00:00.000Z',
    senderDate: '2026-10-20T11:59:50.000Z',
    listUnsubscribe: false,
    ...over,
  }
}

function arranged() {
  const h = harness()
  const row = h.inbox.connectMailbox(
    { address: TESSA, refreshToken: 'refresh-secret', scopes: ['gmail.modify'], historyId: '500', query: 'q' },
    TESSA,
  )
  const ingest = (...messages: ParsedMessage[]) =>
    h.inbox.applyHistoryPage({ mailboxId: row.id, messages, deltas: [], cursor: null, notify: true })
  return { h, ingest }
}

/** The contact an address belongs to. */
const contactOf = (h: ReturnType<typeof harness>, address: string): string =>
  (h.db.query(`SELECT contact_id AS id FROM identity WHERE address = ?`).get(address) as { id: string }).id

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r.value
}

const auditFor = (h: ReturnType<typeof harness>, action: string) =>
  h.inbox.listAudit().filter((a) => a.action === action)

describe('assigning a contact to a Client', () => {
  test('a contact has no Client until somebody assigns one, and the assignment says who and when', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const dana = contactOf(h, 'dana@example.com')
    expect(must(h.inbox.getContact(dana))).toMatchObject({ clientId: null, clientSetBy: null, clientSetAt: null })

    h.tick()
    const done = must(h.inbox.assignClient(dana, 7, CLAUDE))
    expect(done).toMatchObject({ id: dana, clientId: 7, clientSetBy: CLAUDE })
    expect(done.clientSetAt).toBe(new Date(h.now()).toISOString())
    expect(must(h.inbox.getContact(dana))).toMatchObject({ clientId: 7, clientSetBy: CLAUDE })
    expect(h.inbox.listContacts().find((c) => c.id === dana)).toMatchObject({ clientId: 7 })
  })

  test('nothing assigns by itself: ingesting mail from an address a Client uses leaves the contact alone', () => {
    const { h, ingest } = arranged()
    ingest(message())
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 7, TESSA)
    ingest(
      message({
        gmailId: 'g2',
        threadId: 't2',
        from: { name: 'Sam', address: 'sam@example.com' },
        fromHeader: 'Sam <sam@example.com>',
      }),
    )
    expect(must(h.inbox.getContact(contactOf(h, 'sam@example.com'))).clientId).toBeNull()
  })

  test('the audit keeps the actor, before and after; a repeat changes nothing and writes nothing', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const dana = contactOf(h, 'dana@example.com')
    h.inbox.assignClient(dana, 7, TESSA)
    const first = h.inbox.listContacts().find((c) => c.id === dana)
    h.tick()
    h.inbox.assignClient(dana, 7, CLAUDE)
    expect(auditFor(h, 'contact.assign-client')).toHaveLength(1)
    expect(h.inbox.listContacts().find((c) => c.id === dana)).toMatchObject({
      clientSetBy: first?.clientSetBy,
      clientSetAt: first?.clientSetAt,
    })
    expect(auditFor(h, 'contact.assign-client')[0]).toMatchObject({
      actor: TESSA,
      subject: `contact:${dana}`,
      before: { clientId: null, setBy: null, setAt: null },
      after: { clientId: 7, setBy: TESSA },
    })

    h.tick()
    h.inbox.assignClient(dana, 8, CLAUDE)
    expect(auditFor(h, 'contact.assign-client')[0]).toMatchObject({
      actor: CLAUDE,
      before: { clientId: 7 },
      after: { clientId: 8, setBy: CLAUDE },
    })
  })

  test('taking a contact out clears the Client and the stamp, and is audited as its own action', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const dana = contactOf(h, 'dana@example.com')
    h.inbox.assignClient(dana, 7, TESSA)
    expect(must(h.inbox.assignClient(dana, null, CLAUDE))).toMatchObject({
      clientId: null,
      clientSetBy: null,
      clientSetAt: null,
    })
    expect(auditFor(h, 'contact.clear-client')[0]).toMatchObject({
      actor: CLAUDE,
      before: { clientId: 7 },
      after: { clientId: null },
    })
    // Clearing what is not set is nothing.
    h.inbox.assignClient(dana, null, CLAUDE)
    expect(auditFor(h, 'contact.clear-client')).toHaveLength(1)
  })

  test('an unknown contact is 404, and a Client id that is not a whole number is 422 with nothing written', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const dana = contactOf(h, 'dana@example.com')
    expect(h.inbox.assignClient('nobody', 7, TESSA)).toMatchObject({ ok: false, status: 404 })
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(h.inbox.assignClient(dana, bad, TESSA), String(bad)).toMatchObject({ ok: false, status: 422 })
    }
    expect(auditFor(h, 'contact.assign-client')).toHaveLength(0)
  })

  test('a rename keeps the Client', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const dana = contactOf(h, 'dana@example.com')
    h.inbox.assignClient(dana, 7, TESSA)
    expect(must(h.inbox.renameContact(dana, 'Dana S.', TESSA))).toMatchObject({ name: 'Dana S.', clientId: 7 })
  })
})

describe('what the queue is told of Clients', () => {
  test("a conversation carries the Clients of its contacts, each once and in order, and each person's own", () => {
    const { h, ingest } = arranged()
    ingest(
      message({
        cc: [{ name: 'Sam', address: 'sam@example.com' }],
        ccHeader: 'Sam <sam@example.com>',
      }),
      message({
        gmailId: 'g2',
        threadId: 't2',
        from: { name: 'Pat', address: 'pat@other.example' },
        fromHeader: 'Pat <pat@other.example>',
      }),
    )
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 9, TESSA)
    h.inbox.assignClient(contactOf(h, 'sam@example.com'), 3, TESSA)

    const facts = h.inbox.listQueueFacts()
    const byThread = (thread: string) => {
      const id = (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(thread) as { id: string }).id
      return { fact: facts.find((f) => f.id === id), summary: h.inbox.listConversations([id])[0], id }
    }
    expect(byThread('t1').fact?.clientIds).toEqual([3, 9])
    expect(byThread('t1').summary?.clientIds).toEqual([3, 9])
    expect(byThread('t2').fact?.clientIds).toEqual([])

    const detail = must(h.inbox.getConversation(byThread('t1').id))
    expect(detail.contacts.map((c) => [c.name, c.clientId]).sort()).toEqual(
      [
        ['Dana Smith', 9],
        ['Sam', 3],
      ].sort(),
    )
  })

  test('two contacts of one Client are that Client once', () => {
    const { h, ingest } = arranged()
    ingest(message({ cc: [{ name: 'Sam', address: 'sam@example.com' }], ccHeader: 'Sam <sam@example.com>' }))
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 9, TESSA)
    h.inbox.assignClient(contactOf(h, 'sam@example.com'), 9, TESSA)
    expect(h.inbox.listQueueFacts()[0]?.clientIds).toEqual([9])
  })

  test("a Client's usage counts its contacts and every conversation with them, open or closed", () => {
    const { h, ingest } = arranged()
    ingest(
      message(),
      message({ gmailId: 'g2', threadId: 't2', labels: ['SENT'], subject: 'Old, archived' }),
      message({
        gmailId: 'g3',
        threadId: 't3',
        from: { name: 'Pat', address: 'pat@other.example' },
        fromHeader: 'Pat <pat@other.example>',
      }),
    )
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 9, TESSA)
    expect(h.inbox.clientUsage()).toEqual([{ clientId: 9, contacts: 1, conversations: 2, open: 1 }])

    const card = h.inbox.clientCard(9)
    expect(card.contacts.map((p) => p.name)).toEqual(['Dana Smith'])
    expect(card.conversations.map((c) => c.subject).sort()).toEqual(['Old, archived', 'Revised quote'])
    expect(h.inbox.clientCard(5)).toEqual({ contacts: [], conversations: [], conversationsTotal: 0 })
    expect(card.conversationsTotal).toBe(2)
  })

  test('a Client with more conversations than a screen shows the latest screen and counts them all, as the usage does', () => {
    const { h, ingest } = arranged()
    const many = Array.from({ length: QUEUE_PAGE + 5 }, (_, n) =>
      message({ gmailId: `g${n}`, threadId: `t${n}`, subject: `Thread ${n}` }),
    )
    ingest(...many)
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 9, TESSA)
    const card = h.inbox.clientCard(9)
    expect(card.conversations).toHaveLength(QUEUE_PAGE)
    expect(card.conversationsTotal).toBe(QUEUE_PAGE + 5)
    expect(h.inbox.clientUsage()).toEqual([
      { clientId: 9, contacts: 1, conversations: QUEUE_PAGE + 5, open: QUEUE_PAGE + 5 },
    ])
  })
})

describe("the suggestions' facts", () => {
  test('every contact with its Client and its EMAIL addresses only', () => {
    const { h, ingest } = arranged()
    ingest(message())
    h.inbox.createDraft({ address: '626-555-0100', name: 'Dana', body: 'a text' }, TESSA)
    h.inbox.assignClient(contactOf(h, 'dana@example.com'), 9, TESSA)
    const facts = h.inbox.suggestionContacts()
    expect(facts.find((f) => f.name === 'Dana Smith')).toMatchObject({ clientId: 9, emails: ['dana@example.com'] })
    expect(facts.find((f) => f.name === 'Dana')).toMatchObject({ clientId: null, emails: [] })
  })
})

describe('merging contacts', () => {
  function twoDanas() {
    const a = arranged()
    a.ingest(
      message(),
      message({
        gmailId: 'g2',
        threadId: 't2',
        from: { name: 'D. Smith', address: 'dana@work.example' },
        fromHeader: 'D. Smith <dana@work.example>',
        subject: 'From the office',
      }),
    )
    const survivor = contactOf(a.h, 'dana@example.com')
    const absorbed = contactOf(a.h, 'dana@work.example')
    return { ...a, survivor, absorbed }
  }

  test('every address moves to the survivor, which keeps its name; the other contact is gone and its conversations follow', () => {
    const { h, survivor, absorbed } = twoDanas()
    const merged = must(h.inbox.mergeContacts(survivor, absorbed, CLAUDE))
    expect(merged.name).toBe('Dana Smith')
    expect(merged.identities.map((i) => i.address).sort()).toEqual(['dana@example.com', 'dana@work.example'])
    expect(h.inbox.getContact(absorbed)).toMatchObject({ ok: false, status: 404 })
    expect(h.inbox.listContacts().filter((c) => c.name === 'D. Smith')).toHaveLength(0)

    const card = must(h.inbox.getContact(survivor))
    expect(card.conversations.map((c) => c.subject).sort()).toEqual(['From the office', 'Revised quote'])
    expect(count(h, 'message')).toBe(2)
  })

  test("the survivor keeps its own Client, takes the other's when it has none, and a differing one is only in the audit", () => {
    const { h, survivor, absorbed } = twoDanas()
    h.inbox.assignClient(absorbed, 9, TESSA)
    h.tick()
    const merged = must(h.inbox.mergeContacts(survivor, absorbed, CLAUDE))
    expect(merged).toMatchObject({ clientId: 9, clientSetBy: TESSA })

    const again = twoDanas()
    again.h.inbox.assignClient(again.survivor, 3, TESSA)
    again.h.inbox.assignClient(again.absorbed, 9, TESSA)
    const kept = must(again.h.inbox.mergeContacts(again.survivor, again.absorbed, CLAUDE))
    expect(kept.clientId).toBe(3)
    const entry = auditFor(again.h, 'contact.merge')[0]
    expect(entry).toMatchObject({ actor: CLAUDE })
    expect(JSON.stringify(entry?.before)).toContain('"clientId":9')
    expect(JSON.stringify(entry?.before)).toContain('D. Smith')
  })

  test('a merge is refused for the same contact twice and for one that is not there, and changes nothing', () => {
    const { h, survivor } = twoDanas()
    expect(h.inbox.mergeContacts(survivor, survivor, TESSA)).toMatchObject({ ok: false, status: 422 })
    expect(h.inbox.mergeContacts(survivor, 'nobody', TESSA)).toMatchObject({ ok: false, status: 404 })
    expect(h.inbox.mergeContacts('nobody', survivor, TESSA)).toMatchObject({ ok: false, status: 404 })
    expect(auditFor(h, 'contact.merge')).toHaveLength(0)
    expect(h.inbox.listContacts().find((c) => c.id === survivor)?.identities).toHaveLength(1)
  })

  test('a merged person on one thread is one person, and drafts to either address are now theirs', () => {
    const { h, survivor, absorbed } = twoDanas()
    const draft = must(h.inbox.createDraft({ address: 'dana@work.example', body: 'hi', why: 'w' }, TESSA))
    expect(draft.contactId).toBe(absorbed)
    must(h.inbox.mergeContacts(survivor, absorbed, TESSA))
    expect(must(h.inbox.getContact(survivor)).drafts.map((d) => d.id)).toEqual([draft.id])
  })
})

describe('splitting an address off', () => {
  test('the address moves to a new contact named by it, with no Client, and takes its conversations with it', () => {
    const { h, ingest } = arranged()
    ingest(
      message(),
      message({
        gmailId: 'g2',
        threadId: 't2',
        from: { name: 'D. Smith', address: 'dana@work.example' },
        fromHeader: 'D. Smith <dana@work.example>',
        subject: 'From the office',
      }),
    )
    const survivor = contactOf(h, 'dana@example.com')
    const absorbed = contactOf(h, 'dana@work.example')
    h.inbox.assignClient(survivor, 9, TESSA)
    must(h.inbox.mergeContacts(survivor, absorbed, TESSA))
    const identity = (h.db.query(`SELECT id FROM identity WHERE address = 'dana@work.example'`).get() as { id: string })
      .id

    const split = must(h.inbox.splitIdentity(identity, CLAUDE))
    expect(split.contact).toMatchObject({ name: 'dana@work.example', clientId: null, clientSetBy: null })
    expect(split.contact.identities.map((i) => i.address)).toEqual(['dana@work.example'])
    expect(split.from).toMatchObject({ id: survivor, clientId: 9 })
    expect(split.from.identities.map((i) => i.address)).toEqual(['dana@example.com'])
    expect(must(h.inbox.getContact(split.contact.id)).conversations.map((c) => c.subject)).toEqual(['From the office'])
    expect(must(h.inbox.getContact(survivor)).conversations.map((c) => c.subject)).toEqual(['Revised quote'])
    expect(auditFor(h, 'contact.split')[0]).toMatchObject({ actor: CLAUDE, subject: `contact:${survivor}` })
  })

  test("a contact's only address cannot be split off, and an address that is not there is 404", () => {
    const { h, ingest } = arranged()
    ingest(message())
    const only = (h.db.query(`SELECT id FROM identity WHERE address = 'dana@example.com'`).get() as { id: string }).id
    expect(h.inbox.splitIdentity(only, TESSA)).toMatchObject({ ok: false, status: 422 })
    expect(h.inbox.splitIdentity('nothing', TESSA)).toMatchObject({ ok: false, status: 404 })
    expect(auditFor(h, 'contact.split')).toHaveLength(0)
  })

  test('a merge then a split leaves the same contacts with the same addresses', () => {
    const { h, ingest } = arranged()
    ingest(
      message(),
      message({
        gmailId: 'g2',
        threadId: 't2',
        from: { name: 'D. Smith', address: 'dana@work.example' },
        fromHeader: 'D. Smith <dana@work.example>',
        subject: 'From the office',
      }),
    )
    const before = h.inbox.listContacts().map((c) =>
      c.identities
        .map((i) => i.address)
        .sort()
        .join(','),
    )
    const a = contactOf(h, 'dana@example.com')
    const b = contactOf(h, 'dana@work.example')
    must(h.inbox.mergeContacts(a, b, TESSA))
    const moved = (h.db.query(`SELECT id FROM identity WHERE address = 'dana@work.example'`).get() as { id: string }).id
    must(h.inbox.splitIdentity(moved, TESSA))
    const after = h.inbox.listContacts().map((c) =>
      c.identities
        .map((i) => i.address)
        .sort()
        .join(','),
    )
    expect(after.sort()).toEqual(before.sort())
  })
})

describe('merge and split of contacts texted by hand', () => {
  const DANA = '626-555-0100'
  const PAT = '626-555-0101'

  /** A text to `address`, marked sent, and the conversation it was filed on. */
  function text(h: ReturnType<typeof harness>, address: string, body: string): string {
    const draft = must(h.inbox.createDraft({ address, name: address, body }, TESSA))
    h.tick()
    const sent = must(h.inbox.markSent(draft.id, undefined, TESSA))
    h.tick()
    return sent.conversationId as string
  }

  const bodiesOf = (h: ReturnType<typeof harness>, conversationId: string) =>
    must(h.inbox.getConversation(conversationId)).messages.map((m) => m.body)
  const addressesOf = (h: ReturnType<typeof harness>, conversationId: string) =>
    must(h.inbox.getConversation(conversationId)).addresses.map((a) => a.address)
  const identityId = (h: ReturnType<typeof harness>, address: string) =>
    (h.db.query(`SELECT id FROM identity WHERE address = ?`).get(address) as { id: string }).id
  const manualConversations = (h: ReturnType<typeof harness>) =>
    (h.db.query(`SELECT count(*) AS n FROM conversation WHERE mailbox_id IS NULL`).get() as { n: number }).n

  test("after a merge, a text to each number still files on that number's own conversation, so a split undoes the merge", () => {
    const h = harness()
    const danas = text(h, DANA, 'dana one')
    const pats = text(h, PAT, 'pat one')
    expect(danas).not.toBe(pats)
    must(h.inbox.mergeContacts(contactOf(h, '+16265550100'), contactOf(h, '+16265550101'), TESSA))

    // The newest conversation is Pat's; a text to Dana must not land on it.
    expect(text(h, DANA, 'dana two')).toBe(danas)
    expect(text(h, PAT, 'pat two')).toBe(pats)

    must(h.inbox.splitIdentity(identityId(h, '+16265550101'), TESSA))
    expect(bodiesOf(h, danas)).toEqual(['dana one', 'dana two'])
    expect(addressesOf(h, danas)).toEqual(['+16265550100'])
    expect(bodiesOf(h, pats)).toEqual(['pat one', 'pat two'])
    expect(addressesOf(h, pats)).toEqual(['+16265550101'])
    // And every later text still files with its own person.
    expect(text(h, DANA, 'dana three')).toBe(danas)
    expect(text(h, PAT, 'pat three')).toBe(pats)
    expect(manualConversations(h)).toBe(2)
  })

  test("a merged number that had no conversation of its own joins the contact's, and a split takes its messages back out", () => {
    const h = harness()
    const danas = text(h, DANA, 'dana one')
    h.inbox.createDraft({ address: PAT, name: 'Pat', body: 'unsent' }, TESSA)
    must(h.inbox.mergeContacts(contactOf(h, '+16265550100'), contactOf(h, '+16265550101'), TESSA))
    expect(text(h, PAT, 'pat one')).toBe(danas)
    expect(bodiesOf(h, danas)).toEqual(['dana one', 'pat one'])

    const split = must(h.inbox.splitIdentity(identityId(h, '+16265550101'), TESSA))
    expect(bodiesOf(h, danas)).toEqual(['dana one'])
    expect(addressesOf(h, danas)).toEqual(['+16265550100'])
    const mine = must(h.inbox.getContact(split.contact.id)).conversations
    expect(mine).toHaveLength(1)
    expect(bodiesOf(h, mine[0]?.id as string)).toEqual(['pat one'])
    expect(addressesOf(h, mine[0]?.id as string)).toEqual(['+16265550101'])
    expect(text(h, PAT, 'pat two')).toBe(mine[0]?.id as string)
    expect(text(h, DANA, 'dana two')).toBe(danas)
  })

  test('a contact with two numbers, both texted, keeps one conversation until one number is split off, and then they part', () => {
    const h = harness()
    const first = must(h.inbox.createDraft({ address: DANA, name: 'Dana', body: 'to the first' }, TESSA))
    h.db.run(
      `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('arranged-sms', ?, 'sms', '+16265550142', ?)`,
      [first.contactId, new Date(0).toISOString()],
    )
    h.tick()
    const shared = must(h.inbox.markSent(first.id, undefined, TESSA)).conversationId as string
    expect(text(h, '626-555-0142', 'to the second')).toBe(shared)
    expect(bodiesOf(h, shared)).toEqual(['to the first', 'to the second'])

    const split = must(h.inbox.splitIdentity('arranged-sms', TESSA))
    expect(bodiesOf(h, shared)).toEqual(['to the first'])
    expect(addressesOf(h, shared)).toEqual(['+16265550100'])
    const moved = must(h.inbox.getContact(split.contact.id)).conversations
    expect(moved.map((c) => c.id)).not.toContain(shared)
    expect(bodiesOf(h, moved[0]?.id as string)).toEqual(['to the second'])
    expect(text(h, '626-555-0142', 'to the second again')).toBe(moved[0]?.id as string)
    expect(text(h, DANA, 'to the first again')).toBe(shared)
    expect(manualConversations(h)).toBe(2)
    expect(auditFor(h, 'contact.split')[0]?.after).toMatchObject({ movedMessages: 1 })
  })

  test('a split of an address that never shared a conversation moves nothing and invents no conversation', () => {
    const h = harness()
    text(h, DANA, 'dana one')
    text(h, PAT, 'pat one')
    must(h.inbox.mergeContacts(contactOf(h, '+16265550100'), contactOf(h, '+16265550101'), TESSA))
    must(h.inbox.splitIdentity(identityId(h, '+16265550101'), TESSA))
    expect(manualConversations(h)).toBe(2)
    expect(auditFor(h, 'contact.split')[0]?.after).toMatchObject({ movedMessages: 0 })
  })
})

describe('a contact as a row', () => {
  test('the type says what a contact row holds', () => {
    const { h, ingest } = arranged()
    ingest(message())
    const row: ContactRow = must(h.inbox.renameContact(contactOf(h, 'dana@example.com'), 'Dana', TESSA))
    expect(Object.keys(row).sort()).toEqual(['clientId', 'clientSetAt', 'clientSetBy', 'id', 'identities', 'name'])
  })
})
