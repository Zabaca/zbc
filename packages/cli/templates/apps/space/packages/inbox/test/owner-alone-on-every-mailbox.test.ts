import { describe, expect, test } from 'bun:test'
import { ALL_MAIL, planQueue } from '../src/queue'
import { asker, harness, T0 } from '../test-support/harness'
import { rawMail } from '../test-support/raw-mail'

/**
 * For an install whose declaration names no people on any mailbox (the bundled install, as Northfield's), the owner sees and does exactly what the owner did before mailboxes had people. PINNED here over every kind of
 * mailbox the install has (two Gmail accounts, the three business mailboxes, Telegram, the mail server's), by comparing what the owner is shown with what the store holds: nothing is cut. That a real install's
 * declaration names no people on its mailboxes is held by the install's own suite.
 */

const TESSA = 'tessa@northfield.example'

describe('Northfield’s install: Tessa sees and does exactly what the owner did before mailboxes had people', () => {
  async function world() {
    const h = harness(
      {},
      {
        jmap: true,
        ai: null,
        mailboxes: [
          { address: 'info@ridgewaycycles.example', name: 'Ridgeway Cycles' },
          { address: 'hello@shiftlantern.example', name: 'ShiftLantern' },
          { address: 'hello@quill.example', name: 'quill.example' },
        ],
      },
    )
    h.google.mailbox.add({ id: 'z1', threadId: 'tz1', from: 'Dana Smith <dana@example.com>', subject: 'Quote', at: T0 })
    h.google
      .addAccount('tessa@ashgrove.example', 'refresh-ashgrove', 'code-ashgrove')
      .add({ id: 'f1', threadId: 'tf1', from: 'Arun Mehta <arun@example.org>', subject: 'Seed round', at: T0 })
    expect((await h.connect()).ok).toBe(true)
    expect((await h.connect('code-ashgrove')).ok).toBe(true)
    await h.drain()
    for (const to of ['info@ridgewaycycles.example', 'hello@shiftlantern.example', 'hello@quill.example']) {
      expect((await h.deliver(rawMail('first'), { to })).entered).toBe('filed')
    }
    h.jmapServer.deliver({
      from: 'Kim Alder <kim@alder.example>',
      to: 'test@harborline.example',
      subject: 'Walk-ins on Saturday?',
      body: 'Do you take walk-ins?',
    })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(
      h.inbox.pushTelegram({
        account: { id: '7000000001' },
        mirror: true,
        chats: [
          {
            id: '7001',
            kind: 'user' as const,
            person: { id: '7001', name: 'Tess Telegram', bot: false },
            muted: false,
            readInboxMaxId: 0,
          },
        ],
        messages: [
          { chatId: '7001', id: 1, at: '2026-10-20T10:00:00.000Z', out: false, text: 'Can you call me back?' },
        ],
      }).ok,
    ).toBe(true)
    // A note in no mailbox (a text Tessa marked sent by hand), and a draft on a new email.
    expect(
      h.inbox.createDraft(
        { address: '+16265550142', name: 'Hand text', subject: '', body: 'See you at nine.', why: 'x' },
        TESSA,
      ).ok,
    ).toBe(true)
    expect(
      h.inbox.createDraft(
        { address: 'stranger@example.net', name: 'Stranger', subject: 'Hello', body: 'Hi there.', why: 'x' },
        TESSA,
      ).ok,
    ).toBe(true)
    return h
  }

  test('every mailbox Northfield Works has is shared with Tessa alone, and the owner’s scope is every one of them and what belongs to none', async () => {
    const h = await world()
    const rows = h.db.query(`SELECT id, kind, address FROM mailbox ORDER BY rowid`).all() as {
      id: string
      kind: string
      address: string
    }[]
    expect(rows.map((r) => r.kind).sort()).toEqual([
      'cloudflare',
      'cloudflare',
      'cloudflare',
      'gmail',
      'gmail',
      'jmap',
      'telegram',
    ])
    for (const r of rows) expect(h.inbox.whoIsOn(r.id), r.address).toEqual([TESSA])
    const scope = h.inbox.mailScope(TESSA)
    expect(scope.unfiled).toBe(true)
    expect([...(scope.mailboxIds ?? [])].sort()).toEqual(rows.map((r) => r.id).sort())
    // Claude acts for the owner and reads with the same.
    expect(h.inbox.mailScope('agent:abc123.access')).toEqual(scope)
  })

  test('what the store hands Tessa is what it holds, in every read', async () => {
    const h = await world()
    const mine = h.inbox.mailScope(TESSA)
    const everything = h.inbox.listQueueFacts(ALL_MAIL)
    expect(h.inbox.listQueueFacts(mine)).toEqual(everything)
    expect(everything.length).toBeGreaterThanOrEqual(7)
    expect(h.inbox.listContacts(mine)).toEqual(h.inbox.listContacts(ALL_MAIL))
    // The owner's scope covers everything, so no work is done to work out which contacts the owner may see: they are all the owner's.
    expect(
      (h.inbox as unknown as { visibleContactIds: (s: typeof mine) => unknown }).visibleContactIds(mine),
    ).toBeNull()
    expect(h.inbox.listDrafts(mine)).toEqual(h.inbox.listDrafts(ALL_MAIL))
    expect(h.inbox.listDrafts(mine).length).toBe(2)
    expect(h.inbox.suggestionContacts(mine)).toEqual(h.inbox.suggestionContacts(ALL_MAIL))
    expect(h.inbox.clientUsage(mine)).toEqual(h.inbox.clientUsage(ALL_MAIL))
    expect(h.inbox.spaceRowCounts([[TESSA]], mine)).toEqual(h.inbox.spaceRowCounts([[TESSA]], ALL_MAIL))
    expect(h.inbox.searchConversations(['hello'], mine)).toEqual(h.inbox.searchConversations(['hello'], ALL_MAIL))
    expect(h.inbox.searchConversations(['call'], mine).hits.length).toBe(
      h.inbox.searchConversations(['call'], ALL_MAIL).hits.length,
    )
    expect(h.inbox.bulkReport(mine)).toEqual(h.inbox.bulkReport(ALL_MAIL))
    expect(h.inbox.listAudit(100, mine)).toEqual(h.inbox.listAudit(100, ALL_MAIL))
    for (const filter of ['inbox', 'unread', 'drafts', 'bulk', 'closed']) {
      expect(planQueue(h.inbox.listQueueFacts(mine), filter, new Map(), 0, [])).toEqual(
        planQueue(everything, filter, new Map(), 0, []),
      )
    }
    const conversation = (scope: typeof mine) =>
      h.inbox.spaceConversations({ mail: scope, bulk: true, closed: true, team: [TESSA] })
    expect(conversation(mine)).toEqual(conversation(ALL_MAIL))
    expect(h.inbox.spaceContacts(true, mine)).toEqual(h.inbox.spaceContacts(true, ALL_MAIL))
    for (const c of h.inbox.listContacts(ALL_MAIL)) {
      expect(h.inbox.getContact(c.id, mine)).toEqual(h.inbox.getContact(c.id, ALL_MAIL))
    }
  })

  test('the part answers Tessa the same through the owner’s scope as a read of everything: the lists, the menu, search and drafts', async () => {
    const h = await world()
    const inbox = h.space()
    const tessa = asker({ email: TESSA })
    const people = await inbox.people(tessa, { include: ['bulk', 'closed'] })
    expect(people.ok).toBe(true)
    const names = (people as { value: { people: { name: string }[] } }).value.people.map((p) => p.name).sort()
    expect(names).toEqual(['Arun Mehta', 'Dana Smith', 'Kim Alder', 'Tess Telegram', 'Tessa Marlow'])
    // Every conversation in the store is in what the owner is shown.
    const listed = (
      people as { value: { people: { conversations: { conversationId: string }[] }[] } }
    ).value.people.flatMap((p) => p.conversations.map((c) => c.conversationId))
    const stored = (h.db.query(`SELECT id FROM conversation`).all() as { id: string }[]).map((r) => r.id)
    expect(new Set(listed)).toEqual(new Set(stored))
    const nav = await inbox.navigation(tessa)
    expect(nav.ok).toBe(true)
    const menu = (
      nav as { value: { gmailAccounts: unknown[]; mailboxes: unknown[]; jmap: unknown[]; telegram: unknown } }
    ).value
    expect(menu.gmailAccounts).toHaveLength(2)
    expect(menu.mailboxes).toHaveLength(3)
    expect(menu.jmap).toHaveLength(1)
    expect(menu.telegram).not.toBeNull()
    expect((await inbox.drafts(tessa)).ok).toBe(true)
    expect(((await inbox.drafts(tessa)) as { value: unknown[] }).value).toHaveLength(2)
  })

  test('a store from before the migration, whose mailboxes have no people, is Tessa’s alone once the object starts', async () => {
    const h = await world()
    h.db.run('DELETE FROM mailbox_person')
    expect(h.inbox.mailScope(TESSA).mailboxIds).toEqual([])
    expect(h.inbox.settleMailboxPeople()).toBe(7)
    expect(h.inbox.mailScope(TESSA).mailboxIds?.length).toBe(7)
    expect(h.inbox.settleMailboxPeople()).toBe(0)
  })
})
