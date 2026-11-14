import { describe, expect, test } from 'bun:test'
import { createInstall, type InboxForSpace, type SignedIn } from '@space/workspace'
import { putPeople } from '../src/store/people'
import { AGENT, asker, harness, T0, TEAM } from '../test-support/harness'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'
import { sqlOver } from '../test-support/sql-over-sqlite'

/**
 * A mailbox has people: every read the inbox answers a person is cut to the mailboxes they are on, an id they may not see is a 404 like one that
 * does not exist, and a person sends only from a mailbox they are on. Behaviour from outside: what each person is SHOWN or REFUSED by the inbox's part of the space and by Claude's door, over a made-up company of three people
 * and four mailboxes, with the real store, Mailroom and arrivals (the harness) and nothing of Northfield's in it.
 *
 *   Alex (owner)   on Desk (shared), Books (his alone), his own Gmail
 *   Bea            on Desk (shared) and her own Gmail
 *   Cal            on nothing
 */

const ALEX = 'alex@harborline.example'
const BEA = 'bea@harborline.example'
const CAL = 'cal@harborline.example'
const DESK = 'desk@harborline.example'
const BOOKS = 'books@harborline-books.example'

const HARBORLINE = createInstall({
  company: {
    id: 'harborline',
    name: 'Harborline Boats',
    domain: 'harborline.example',
    timeZone: 'America/Los_Angeles',
  },
  // The harness's Access (its keys and its team) stands in for the company's own, so Claude's door can be driven in this install too.
  access: { teamDomain: TEAM },
  formsService: { contact: 'help@harborline.example' },
  space: { host: 'space.harborline.example', sessionDuration: '730h' },
  people: [
    { address: ALEX, name: 'Alex', mailName: 'Alex Rowe', role: 'owner' },
    { address: BEA, name: 'Bea', role: 'member' },
    { address: CAL, name: 'Cal', role: 'member' },
  ],
  businesses: [
    { id: 'harborline', name: 'Harborline Boats', mailboxes: [DESK] },
    { id: 'books', name: 'Harborline Books', mailboxes: [BOOKS] },
  ],
  cloudflareMailboxes: [
    { address: DESK, name: 'Desk', people: [ALEX, BEA] },
    { address: BOOKS, name: 'Books' },
  ],
  agent: { path: '/agent/inbox' },
  switches: { claudeScript: true },
})

type H = ReturnType<typeof harness>

const BEA_GMAIL = { address: BEA, token: 'refresh-bea', code: 'code-bea' }

/** Cloudflare's raw message, by hand, with an optional file. */
function raw(o: { from: string; to: string; subject: string; text: string; id: string; file?: boolean }): string {
  const head = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}@mail.example>`,
    'Date: Mon, 20 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
  ]
  if (!o.file) return [...head, 'Content-Type: text/plain; charset="UTF-8"', '', o.text, ''].join('\r\n')
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    o.text,
    '--b1',
    'Content-Type: application/pdf; name="ledger.pdf"',
    'Content-Disposition: attachment; filename="ledger.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa('%PDF-1.4 a ledger nobody else reads'),
    '--b1--',
    '',
  ].join('\r\n')
}

const ids = (h: H, subject: string): { conversation: string; message: string } => {
  const c = h.db
    .query(
      `SELECT c.id AS conversation, (SELECT m.id FROM message m WHERE m.conversation_id = c.id ORDER BY m.rowid LIMIT 1) AS message
         FROM conversation c WHERE EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id AND m.subject = ?)`,
    )
    .get(subject) as { conversation: string; message: string } | null
  if (!c) throw new Error(`no conversation with the subject ${subject}`)
  return c
}

/** How far into a conversation a sender has read, as the page gives it (`through`). */
const throughOf = async (h: H, conversationId: string): Promise<number> =>
  ((await h.store.call('getConversation', conversationId)) as { ok: true; value: { through: number } }).value.through

const contactOf = (h: H, address: string): string =>
  (h.db.query(`SELECT contact_id FROM identity WHERE address = ?`).get(address) as { contact_id: string }).contact_id

const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}
const refusalOf = (reply: unknown): string => {
  const r = reply as { ok: boolean; reason?: string }
  expect(r.ok, JSON.stringify(reply)).toBe(false)
  return r.reason as string
}

/**
 * The company's mail, delivered: Desk (shared), Books (Alex's, one with a file), Alex's Gmail and Bea's Gmail (connected by the owner, as only the owner connects, then handed to Bea, as people kept by the
 * space will do: a Gmail account a person connected is theirs alone).
 */
async function world() {
  const h = harness(
    {},
    {
      install: HARBORLINE,
      mailboxes: [
        { address: DESK, name: 'Desk' },
        { address: BOOKS, name: 'Books' },
      ],
    },
  )
  h.google.mailbox.address = ALEX
  h.google.mailbox.add({
    id: 'ga1',
    threadId: 'tga1',
    subject: 'Alex only: the survey',
    from: 'Sam Ortiz <sam@harbor.example>',
    to: ALEX,
    at: T0,
  })
  const beaAccount = h.google.addAccount(BEA_GMAIL.address, BEA_GMAIL.token, BEA_GMAIL.code)
  beaAccount.add({
    id: 'gb1',
    threadId: 'tgb1',
    subject: 'Bea only: the hull',
    from: 'Ben Okafor <ben@yard.example>',
    to: BEA,
    at: T0,
  })
  expect((await h.connect()).ok).toBe(true)
  expect((await h.connect(BEA_GMAIL.code)).ok).toBe(true)
  await h.drain()
  const beaGmail = (h.inbox.mailboxRowAt(BEA) as { id: string }).id
  // The account was connected by the owner, who is on it; it is Bea's alone from here (what people kept by the space will do).
  putPeople(sqlOver(h.db), beaGmail, [BEA], 'test', new Date(h.now()).toISOString())

  expect(
    (
      await h.deliver(
        raw({
          from: 'Cora Lund <cora@dock.example>',
          to: DESK,
          subject: 'Desk: a quote for the dock',
          text: 'Can you quote the dock?',
          id: 'd1',
        }),
        { to: DESK },
      )
    ).entered,
  ).toBe('filed')
  expect(
    (
      await h.deliver(
        raw({
          from: 'Vic Tran <vic@vendor.example>',
          to: BOOKS,
          subject: 'Books: the invoice',
          text: 'Our invoice is attached.',
          id: 'b1',
          file: true,
        }),
        { to: BOOKS },
      )
    ).entered,
  ).toBe('filed')
  return Object.assign(h, { beaAccount })
}

const as = (who: string): SignedIn => asker({ email: who }, HARBORLINE)
const part = (h: H): InboxForSpace => h.space({ install: HARBORLINE })

const names = (people: { name: string }[]): string[] => people.map((p) => p.name).sort()
const subjects = (people: { conversations: { subject: string }[] }[]): string[] =>
  people.flatMap((p) => p.conversations.map((c) => c.subject)).sort()

describe('who is on each mailbox, and who is let into the inbox', () => {
  test('the declaration says it for the business mailboxes, the connector for a Gmail account, and the owner for the rest', async () => {
    const h = await world()
    const on = (address: string) => h.inbox.whoIsOn((h.inbox.mailboxRowAt(address) as { id: string }).id).sort()
    const business = (address: string) =>
      (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(address) as { id: string }).id
    expect(h.inbox.whoIsOn(business(DESK)).sort()).toEqual([ALEX, BEA])
    expect(h.inbox.whoIsOn(business(BOOKS))).toEqual([ALEX])
    expect(on(ALEX)).toEqual([ALEX])
    expect(on(BEA)).toEqual([BEA])
  })

  test('the owner is let in, Bea is let in (she is on mailboxes), and Cal, who is on none, is refused everything the inbox answers a person', async () => {
    const h = await world()
    const inbox = part(h)
    expect((await inbox.people(as(ALEX))).ok).toBe(true)
    expect((await inbox.people(as(BEA))).ok).toBe(true)
    for (const reply of [
      await inbox.people(as(CAL)),
      await inbox.drafts(as(CAL)),
      await inbox.search(as(CAL), 'quote'),
      await inbox.navigation(as(CAL)),
      await inbox.contacts(as(CAL)),
      await inbox.mailboxes(as(CAL)),
      await inbox.clients(as(CAL)),
      await inbox.notifications(as(CAL)),
    ]) {
      expect(refusalOf(reply)).toBe('not-admitted')
    }
    // Somebody the install does not list is refused too, as before.
    expect(refusalOf(await inbox.people(as('stranger@example.com')))).toBe('not-admitted')
  })

  test('what only the owner does stays the owner’s: Bea is refused Claude’s switch, the Gmail connection, restore and the operator’s three', async () => {
    const h = await world()
    const inbox = part(h)
    expect((await inbox.claudeSending(as(ALEX))).ok).toBe(true)
    expect(refusalOf(await inbox.claudeSending(as(BEA)))).toBe('not-admitted')
    expect(refusalOf(await inbox.setClaudeSending(as(BEA), true))).toBe('not-admitted')
    expect(refusalOf(await inbox.gmailSignIn(as(BEA), 'a'.repeat(32)))).toBe('not-admitted')
    expect(refusalOf(await inbox.gmailConnect(as(BEA), 'code'))).toBe('not-admitted')
    expect(refusalOf(await inbox.restoreReport(as(BEA)))).toBe('not-admitted')
    expect(refusalOf(await inbox.storeBookmark(as(BEA)))).toBe('not-admitted')
    expect(refusalOf(await inbox.storeCounts(as(BEA)))).toBe('not-admitted')
    expect(refusalOf(await inbox.restartStore(as(BEA)))).toBe('not-admitted')
    expect(refusalOf(await inbox.linkClient(as(BEA), contactOf(h, 'cora@dock.example'), null))).toBe('not-admitted')
    expect(refusalOf(await inbox.setSpamCheck(as(BEA), 'x', true))).toBe('not-admitted')
  })
})

describe('lists, people, counts and search show a person only their mailboxes', () => {
  test('people: Bea is shown Desk and her own Gmail, never Books or Alex’s Gmail; Alex is shown his three and not Bea’s Gmail', async () => {
    const h = await world()
    const inbox = part(h)
    const bea = unwrap(await inbox.people(as(BEA), { include: ['bulk', 'closed'] }))
    expect(subjects(bea.people)).toEqual(['Bea only: the hull', 'Desk: a quote for the dock'])
    expect(names(bea.people)).toEqual(['Ben Okafor', 'Cora Lund'])
    const alex = unwrap(await inbox.people(as(ALEX), { include: ['bulk', 'closed'] }))
    expect(subjects(alex.people)).toEqual(['Alex only: the survey', 'Books: the invoice', 'Desk: a quote for the dock'])
  })

  test('a person asked for by address or by id who has mail only in mailboxes the asker is not on is not found, and a person is never confirmed to exist', async () => {
    const h = await world()
    const inbox = part(h)
    const vic = contactOf(h, 'vic@vendor.example')
    expect(refusalOf(await inbox.messagesWith(as(BEA), { contactId: vic }))).toBe('not-found')
    expect(refusalOf(await inbox.messagesWith(as(BEA), { address: 'vic@vendor.example' }))).toBe('not-found')
    expect(refusalOf(await inbox.messagesWith(as(BEA), { contactId: 'no-such-contact' }))).toBe('not-found')
    expect(unwrap(await inbox.messagesWith(as(ALEX), { contactId: vic })).messages.map((m) => m.subject)).toEqual([
      'Books: the invoice',
    ])
    // The people scope finds nobody it may not show, however it names them.
    const asked = unwrap(
      await inbox.people(as(BEA), {
        addresses: ['vic@vendor.example', 'cora@dock.example'],
        include: ['closed', 'bulk'],
      }),
    )
    expect(names(asked.people)).toEqual(['Cora Lund'])
    const byId = unwrap(
      await inbox.people(as(BEA), {
        contactIds: [vic, contactOf(h, 'cora@dock.example')],
        include: ['closed', 'bulk'],
      }),
    )
    expect(names(byId.people)).toEqual(['Cora Lund'])
  })

  test('reading further down a list, and narrowing it to a mailbox, show a person only their mailboxes', async () => {
    const h = await world()
    const inbox = part(h)
    // The position of the oldest conversation there could be, with one more screen below it: everything the person may see, and nothing else.
    const down = {
      through: '2000-01-01T00:00:00.000Z|0',
      older: true,
      include: ['bulk', 'closed'] as ('bulk' | 'closed')[],
    }
    expect(subjects(unwrap(await inbox.people(as(BEA), down)).people)).toEqual([
      'Bea only: the hull',
      'Desk: a quote for the dock',
    ])
    expect(subjects(unwrap(await inbox.people(as(ALEX), down)).people)).toEqual([
      'Alex only: the survey',
      'Books: the invoice',
      'Desk: a quote for the dock',
    ])
    // A mailbox the person is not on is an empty list for them, and the same mailbox is Alex's to list.
    const books = (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(BOOKS) as { id: string }).id
    expect(unwrap(await inbox.people(as(BEA), { mailbox: books })).people).toEqual([])
    expect(subjects(unwrap(await inbox.people(as(ALEX), { mailbox: books })).people)).toEqual(['Books: the invoice'])
  })

  test('search finds a word in a mailbox only where the person is on it, and a screen is cut from their own mail', async () => {
    const h = await world()
    const inbox = part(h)
    expect(unwrap(await inbox.search(as(BEA), 'invoice')).hits).toEqual([])
    expect(unwrap(await inbox.search(as(BEA), 'ledger')).hits).toEqual([])
    expect(unwrap(await inbox.search(as(BEA), 'quote')).hits.map((x) => x.subject)).toEqual([
      'Desk: a quote for the dock',
    ])
    expect(unwrap(await inbox.search(as(ALEX), 'invoice')).hits.map((x) => x.subject)).toEqual(['Books: the invoice'])
    expect(unwrap(await inbox.search(as(ALEX), 'hull')).hits).toEqual([])
    expect(unwrap(await inbox.search(as(BEA), 'hull')).hits.map((x) => x.subject)).toEqual(['Bea only: the hull'])
  })

  test('the menu counts, lists its mailboxes and Gmail accounts and counts its contacts over what the person may see, and its numbers are the lists’', async () => {
    const h = await world()
    const inbox = part(h)
    const bea = unwrap(await inbox.navigation(as(BEA)))
    expect(bea.views.inbox.count).toBe(2)
    expect(bea.mailboxes.map((m) => m.name)).toEqual(['Desk'])
    expect(bea.gmailAccounts.map((g) => g.address)).toEqual([BEA])
    expect(bea.contacts).toBe(2)
    expect(bea.telegram).toBeNull()
    const listed = unwrap(await inbox.people(as(BEA)))
    expect(listed.people.length).toBe(bea.views.inbox.count)
    const alex = unwrap(await inbox.navigation(as(ALEX)))
    expect(alex.views.inbox.count).toBe(3)
    expect(alex.mailboxes.map((m) => m.name).sort()).toEqual(['Books', 'Desk'])
    expect(alex.gmailAccounts.map((g) => g.address)).toEqual([ALEX])
    expect(alex.contacts).toBe(3)
  })

  test('the mailboxes page lists the person’s own and nothing of the others', async () => {
    const h = await world()
    const inbox = part(h)
    const bea = unwrap(await inbox.mailboxes(as(BEA)))
    expect(bea.mailboxes.map((m) => m.address)).toEqual([DESK])
    expect(bea.gmailAccounts.map((g) => g.address)).toEqual([BEA])
    const alex = unwrap(await inbox.mailboxes(as(ALEX)))
    expect(alex.mailboxes.map((m) => m.address).sort()).toEqual([BOOKS, DESK])
    expect(alex.gmailAccounts.map((g) => g.address)).toEqual([ALEX])
  })

  test('People shows the contacts on the person’s mail, with counts that are over that mail', async () => {
    const h = await world()
    const inbox = part(h)
    const bea = unwrap(await inbox.contacts(as(BEA)))
    expect(names(bea.contacts)).toEqual(['Ben Okafor', 'Cora Lund'])
    expect(bea.contacts.every((c) => c.conversations === 1)).toBe(true)
    const alex = unwrap(await inbox.contacts(as(ALEX)))
    expect(names(alex.contacts)).toEqual(['Cora Lund', 'Sam Ortiz', 'Vic Tran'])
    // A contact's page is a 404 for a person who may not see them, as a contact that is not there.
    expect(refusalOf(await inbox.contact(as(BEA), contactOf(h, 'vic@vendor.example')))).toBe('not-found')
    expect(unwrap(await inbox.contact(as(ALEX), contactOf(h, 'vic@vendor.example'))).name).toBe('Vic Tran')
    // A contact who writes to both mailboxes is shown with the conversations the person may see only.
    expect(
      (
        await h.deliver(
          raw({
            from: 'Cora Lund <cora@dock.example>',
            to: BOOKS,
            subject: 'Books: cora pays',
            text: 'Paid.',
            id: 'b2',
          }),
          { to: BOOKS },
        )
      ).entered,
    ).toBe('filed')
    expect(unwrap(await inbox.contact(as(BEA), contactOf(h, 'cora@dock.example'))).conversations).toBe(1)
    expect(unwrap(await inbox.contact(as(ALEX), contactOf(h, 'cora@dock.example'))).conversations).toBe(2)
  })

  test('whether a contact is an automated sender is judged over the whole store, so People’s list and the contact’s page agree for a person who sees only part of their mail', async () => {
    const h = await world()
    const inbox = part(h)
    // Cora also writes to Books, a newsletter-looking message (Bulk) Bea cannot see: one of her two conversations is Bulk, so she is a person.
    const bulk = raw({
      from: 'Cora Lund <cora@dock.example>',
      to: BOOKS,
      subject: 'Books: weekly digest',
      text: 'Digest.',
      id: 'b3',
    }).replace('MIME-Version: 1.0', 'List-Unsubscribe: <mailto:u@dock.example>\r\nMIME-Version: 1.0')
    expect((await h.deliver(bulk, { to: BOOKS })).entered).toBe('filed')
    const cora = contactOf(h, 'cora@dock.example')
    const listed = unwrap(await inbox.contacts(as(BEA), { automated: true })).contacts.find((c) => c.contactId === cora)
    expect(listed?.automated).toBe(false)
    expect(listed?.conversations).toBe(1)
    expect(unwrap(await inbox.contact(as(BEA), cora)).automated).toBe(false)
    expect(unwrap(await inbox.contact(as(ALEX), cora)).automated).toBe(false)
  })

  test('a contact the owner has made with no mail at all is the owner’s, and the Client counts are over what the person may see', async () => {
    const h = await world()
    const inbox = part(h)
    // Link Cora (on Desk) and Vic (on Books) to the same Client, as the owner.
    for (const who of ['cora@dock.example', 'vic@vendor.example']) {
      unwrap(await inbox.linkClient(as(ALEX), contactOf(h, who), 1))
    }
    const alex = unwrap(await inbox.clients(as(ALEX)))
    expect(alex.clients.find((c) => c.id === 1)).toMatchObject({ contacts: 2, conversations: 2 })
    const bea = unwrap(await inbox.clients(as(BEA)))
    expect(bea.clients.find((c) => c.id === 1)).toMatchObject({ contacts: 1, conversations: 1 })
    const beaPage = unwrap(await inbox.client(as(BEA), 1))
    expect(beaPage.contacts.map((c) => c.name)).toEqual(['Cora Lund'])
    const alexPage = unwrap(await inbox.client(as(ALEX), 1))
    expect(alexPage.contacts.map((c) => c.name).sort()).toEqual(['Cora Lund', 'Vic Tran'])
  })

  test('the Drafts list and a draft by its id: a draft on Books is Alex’s, and Bea is told nothing of it', async () => {
    const h = await world()
    const inbox = part(h)
    const books = ids(h, 'Books: the invoice')
    const desk = ids(h, 'Desk: a quote for the dock')
    const made = (await h.store.call(
      'createDraft',
      { conversationId: books.conversation, body: 'Thanks, paid.', subject: 'Re: invoice', why: 'x' } as never,
      ALEX,
    )) as { ok: true; value: { id: string } }
    const onDesk = (await h.store.call(
      'createDraft',
      { conversationId: desk.conversation, body: 'Quote is on its way.', subject: 'Re: quote', why: 'x' } as never,
      BEA,
    )) as { ok: true; value: { id: string } }
    expect(made.ok && onDesk.ok).toBe(true)
    expect(unwrap(await inbox.drafts(as(BEA))).map((d) => d.id)).toEqual([onDesk.value.id])
    expect(
      unwrap(await inbox.drafts(as(ALEX)))
        .map((d) => d.id)
        .sort(),
    ).toEqual([made.value.id, onDesk.value.id].sort())
    expect(refusalOf(await inbox.draftAt(as(BEA), made.value.id))).toBe('not-found')
    expect(refusalOf(await inbox.draftAt(as(BEA), 'no-such-draft'))).toBe('not-found')
    expect(unwrap(await inbox.draftAt(as(BEA), onDesk.value.id))).toMatchObject({ state: 'draft' })
    // The counts of the menu include only the person's drafts.
    expect(unwrap(await inbox.navigation(as(BEA))).views.drafts.count).toBe(1)
    expect(unwrap(await inbox.navigation(as(ALEX))).views.drafts.count).toBe(2)
  })
})

describe('an id the person may not see answers as one that does not exist, whatever is asked of it', () => {
  test('a file of a message on Books: Alex is given it, Bea is told there is no such file, and Desk’s mail is Bea’s', async () => {
    const h = await world()
    const inbox = part(h)
    const books = ids(h, 'Books: the invoice')
    expect(unwrap(await inbox.attachment(as(ALEX), books.message, 0, 'download')).name).toBe('ledger.pdf')
    expect(refusalOf(await inbox.attachment(as(BEA), books.message, 0, 'download'))).toBe('not-found')
    expect(refusalOf(await inbox.attachment(as(BEA), 'no-such-message', 0, 'download'))).toBe('not-found')
  })

  test('reading, closing and reopening a conversation of another’s mailbox changes nothing and is not found; one’s own works', async () => {
    const h = await world()
    const inbox = part(h)
    const books = ids(h, 'Books: the invoice')
    const desk = ids(h, 'Desk: a quote for the dock')
    const before = JSON.stringify(h.db.query(`SELECT id, status, labels FROM message ORDER BY id`).all())
    const read = unwrap(await inbox.markRead(as(BEA), [{ conversationId: books.conversation, through: 99 }]))
    expect(read.read).toEqual([])
    expect(read.notRead.map((n) => [n.conversationId, (n.outcome as { reason: string }).reason])).toEqual([
      [books.conversation, 'not-found'],
    ])
    const closed = unwrap(
      await inbox.closeConversations(as(BEA), [{ conversationId: books.conversation, through: 99 }]),
    )
    expect(closed.closed).toEqual([])
    expect(closed.notClosed).toHaveLength(1)
    const reopened = unwrap(await inbox.reopenConversations(as(BEA), [books.conversation]))
    expect(reopened.reopened).toEqual([])
    expect(JSON.stringify(h.db.query(`SELECT id, status, labels FROM message ORDER BY id`).all())).toBe(before)
    // Her own is done.
    const through = await throughOf(h, desk.conversation)
    expect(unwrap(await inbox.markRead(as(BEA), [{ conversationId: desk.conversation, through }])).read).toEqual([
      desk.conversation,
    ])
  })

  test('spam and the draft chat are the owner’s, and a draft’s edits, picture, mark-sent and resolution on another’s mailbox are not found', async () => {
    const h = await world()
    const inbox = part(h)
    const books = ids(h, 'Books: the invoice')
    const made = (await h.store.call(
      'createDraft',
      { conversationId: books.conversation, body: 'Thanks, paid.', subject: 'Re: invoice', why: 'x' } as never,
      ALEX,
    )) as { ok: true; value: { id: string; rev: number } }
    // Spam and the draft chat (which spends model money) are the owner's for now: a teammate is refused them even on their own mailbox, and the owner is checked against what they may see.
    const deskId = ids(h, 'Desk: a quote for the dock').conversation
    const beaConversation = ids(h, 'Bea only: the hull').conversation
    expect(refusalOf(await inbox.setSpam(as(BEA), { conversationId: deskId, spam: true }))).toBe('not-admitted')
    expect(refusalOf(await inbox.draftChat(as(BEA), deskId, made.value.id))).toBe('not-admitted')
    expect(
      refusalOf(
        await inbox.chat(as(BEA), {
          conversationId: deskId,
          draftId: made.value.id,
          rev: made.value.rev,
          instruction: 'shorter',
        }),
      ),
    ).toBe('not-admitted')
    expect(refusalOf(await inbox.setSpam(as(ALEX), { conversationId: beaConversation, spam: true }))).toBe('not-found')
    expect(refusalOf(await inbox.draftChat(as(ALEX), beaConversation, made.value.id))).toBe('not-found')
    expect(
      refusalOf(
        await inbox.chat(as(ALEX), {
          conversationId: beaConversation,
          draftId: made.value.id,
          rev: made.value.rev,
          instruction: 'shorter',
        }),
      ),
    ).toBe('not-found')
    expect(
      refusalOf(await inbox.editDraft(as(BEA), { draftId: made.value.id, rev: made.value.rev, text: 'mine now' })),
    ).toBe('not-found')
    expect(
      refusalOf(
        await inbox.putDraftPicture(as(BEA), {
          draftId: made.value.id,
          rev: made.value.rev,
          picture: { name: 'p.png', type: 'image/png', bytes: new Uint8Array([1]) },
        }),
      ),
    ).toBe('not-found')
    expect(refusalOf(await inbox.markDraftSent(as(BEA), made.value.id))).toBe('not-found')
    expect(refusalOf(await inbox.unmarkSent(as(BEA), made.value.id))).toBe('not-found')
    expect(refusalOf(await inbox.resolveSend(as(BEA), { draftId: made.value.id, sent: true }))).toBe('not-found')
    expect(h.db.query(`SELECT body FROM message WHERE id = ?`).get(made.value.id)).toEqual({ body: 'Thanks, paid.' })
    // Alex, who is on it, edits it.
    expect(
      unwrap(await inbox.editDraft(as(ALEX), { draftId: made.value.id, rev: made.value.rev, text: 'Paid, thank you.' }))
        .text,
    ).toBe('Paid, thank you.')
  })
})

describe('a person sends only from the mailboxes they are on', () => {
  const KEY = (n: number) => `compose-key-${n}`.padEnd(24, '0')

  test('Bea replies on Desk, and it goes out as Desk through Cloudflare; her reply on Books is not found and nothing is sent or claimed', async () => {
    const h = await world()
    const inbox = part(h)
    const desk = ids(h, 'Desk: a quote for the dock')
    const books = ids(h, 'Books: the invoice')
    const deskThrough = await throughOf(h, desk.conversation)
    const booksThrough = await throughOf(h, books.conversation)
    expect(
      refusalOf(
        await inbox.send(as(BEA), {
          key: KEY(1),
          conversationId: books.conversation,
          through: booksThrough,
          text: 'Paid, thanks.',
        }),
      ),
    ).toBe('not-found')
    expect(h.email.handed).toEqual([])
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 0 })
    const sent = unwrap(
      await inbox.send(as(BEA), {
        key: KEY(2),
        conversationId: desk.conversation,
        through: deskThrough,
        text: 'The quote is attached to a follow-up.',
      }),
    ) as { status: string }
    expect(sent.status).toBe('sent')
    expect(h.email.handed.map((m) => m.from)).toEqual([expect.stringContaining(DESK)])
    // The message records who pressed Send.
    expect(h.db.query(`SELECT sent_by FROM message WHERE direction = 'out' AND status = 'sent'`).get()).toEqual({
      sent_by: BEA,
    })
  })

  test('a draft by its id on Books is Alex’s to send and not found for Bea, and the store itself refuses a send as a person who is not on the mailbox', async () => {
    const h = await world()
    const inbox = part(h)
    const books = ids(h, 'Books: the invoice')
    const made = (await h.store.call(
      'createDraft',
      { conversationId: books.conversation, body: 'Thanks, paid.', subject: 'Re: invoice', why: 'x' } as never,
      ALEX,
    )) as { ok: true; value: { id: string; rev: number } }
    const through = await throughOf(h, books.conversation)
    expect(
      refusalOf(await inbox.send(as(BEA), { key: KEY(3), draftId: made.value.id, rev: made.value.rev, through })),
    ).toBe('not-found')
    // Underneath the part: the store refuses the person on its own.
    const refused = await h.store.call('sendDraft', made.value.id, { rev: made.value.rev, through } as never, BEA)
    expect(refused).toMatchObject({
      ok: false,
      status: 403,
      error: 'You are not on the mailbox this would go out from, so nothing was sent.',
    })
    expect(h.email.handed).toEqual([])
    expect(h.db.query(`SELECT status FROM message WHERE id = ?`).get(made.value.id)).toEqual({ status: 'draft' })
    // Alex sends it.
    const sent = unwrap(
      await inbox.send(as(ALEX), { key: KEY(4), draftId: made.value.id, rev: made.value.rev, through }),
    ) as { status: string }
    expect(sent.status).toBe('sent')
    expect(h.email.handed.map((m) => m.from)).toEqual([expect.stringContaining(BOOKS)])
  })

  test('a new email goes out from a mailbox the person is on: Books is refused her, Desk and her Gmail are hers, and with no choice it is her Gmail, not Alex’s', async () => {
    const h = await world()
    const inbox = part(h)
    const books = (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(BOOKS) as { id: string }).id
    const desk = (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(DESK) as { id: string }).id
    expect(
      refusalOf(
        await inbox.send(as(BEA), {
          key: KEY(5),
          address: 'new@customer.example',
          subject: 'Hello',
          text: 'Hi',
          from: { kind: 'business', mailboxId: books },
        }),
      ),
    ).toBe('not-admitted')
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE status = 'draft'`).get()).toEqual({ n: 0 })
    // The refused key is free again, so the same key sends from a mailbox that is hers (below it is another).
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 0 })
    expect(
      refusalOf(
        await inbox.send(as(BEA), {
          key: KEY(5),
          address: 'new@customer.example',
          subject: 'Hello',
          text: 'Hi',
          from: { kind: 'business', mailboxId: books },
        }),
      ),
    ).toBe('not-admitted')
    const fromDesk = unwrap(
      await inbox.send(as(BEA), {
        key: KEY(6),
        address: 'new@customer.example',
        subject: 'Hello',
        text: 'Hi',
        from: { kind: 'business', mailboxId: desk },
      }),
    ) as { status: string }
    expect(fromDesk.status).toBe('sent')
    expect(h.email.handed.map((m) => m.from)).toEqual([expect.stringContaining(DESK)])
    // No choice: Alex's own Gmail is the install's default, and it is not hers to send from, so hers is used.
    const none = unwrap(
      await inbox.send(as(BEA), { key: KEY(7), address: 'other@customer.example', subject: 'Hi again', text: 'Hello' }),
    ) as { status: string }
    expect(none.status).toBe('sent')
    expect(h.beaAccount.sent.map((m) => m.headers.From)).toEqual([expect.stringContaining(BEA)])
    expect(h.google.mailbox.sent).toEqual([])
  })

  test('Alex’s Gmail is not hers either: the owner’s account chosen by id is refused', async () => {
    const h = await world()
    const inbox = part(h)
    const alexGmail = (h.inbox.mailboxRowAt(ALEX) as { id: string }).id
    expect(
      refusalOf(
        await inbox.send(as(BEA), {
          key: KEY(8),
          address: 'new@customer.example',
          subject: 'Hello',
          text: 'Hi',
          from: { kind: 'gmail', mailboxId: alexGmail },
        }),
      ),
    ).toBe('not-admitted')
    expect(h.google.mailbox.sent).toEqual([])
    expect(h.beaAccount.sent).toEqual([])
  })
})

describe('notifications go only to the devices of people who may see the mail', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36'
  async function devices(h: H) {
    const alex = await newDevice('alex-phone')
    const bea = await newDevice('bea-phone')
    const inbox = part(h)
    unwrap(await inbox.addDevice(as(ALEX), { endpoint: alex.endpoint, keys: alex.keys } as never, ua))
    unwrap(await inbox.addDevice(as(BEA), { endpoint: bea.endpoint, keys: bea.keys } as never, ua))
    return { alex, bea }
  }
  const sentTo = async (h: H, d: TestDevice): Promise<string[]> =>
    Promise.all(
      h.pushService
        .to(d.endpoint)
        .map(async (r) => (JSON.parse((await decrypt(d, r.body)).text) as { body: string; title: string }).body),
    )

  test('mail on Desk rings both phones, mail on Books only Alex’s, and each person lists only their own devices', async () => {
    const h = await world()
    const { alex, bea } = await devices(h)
    h.pushService.requests.length = 0
    expect(
      (
        await h.deliver(
          raw({ from: 'Dee <dee@dock.example>', to: DESK, subject: 'Desk: new enquiry', text: 'Hello?', id: 'd9' }),
          { to: DESK },
        )
      ).entered,
    ).toBe('filed')
    expect(
      (
        await h.deliver(
          raw({
            from: 'Eve <eve@vendor.example>',
            to: BOOKS,
            subject: 'Books: new statement',
            text: 'Statement.',
            id: 'b9',
          }),
          { to: BOOKS },
        )
      ).entered,
    ).toBe('filed')
    expect(h.pushService.to(alex.endpoint)).toHaveLength(2)
    expect(h.pushService.to(bea.endpoint)).toHaveLength(1)
    expect((await sentTo(h, bea)).join(' ')).not.toContain('statement')
    const inbox = part(h)
    expect(unwrap(await inbox.notifications(as(BEA))).devices.map((d) => d.endpoint)).toEqual([bea.endpoint])
    expect(unwrap(await inbox.notifications(as(ALEX))).devices.map((d) => d.endpoint)).toEqual([alex.endpoint])
  })

  test('a device is its person’s: Bea cannot remove or test Alex’s, as if it were not there', async () => {
    const h = await world()
    const { alex } = await devices(h)
    const inbox = part(h)
    const alexId = unwrap(await inbox.notifications(as(ALEX))).devices[0]?.id as string
    expect(refusalOf(await inbox.removeDevice(as(BEA), alexId))).toBe('not-found')
    expect(refusalOf(await inbox.testDevice(as(BEA), alexId))).toBe('not-found')
    expect(h.pushService.to(alex.endpoint)).toHaveLength(0)
    expect(unwrap(await inbox.testDevice(as(ALEX), alexId)).outcome).toBe('delivered')
  })

  test('a notification with no device that may see it is dropped, and the week’s numbers are over a person’s own mail', async () => {
    const h = await world()
    const bea = await newDevice('bea-only')
    unwrap(await part(h).addDevice(as(BEA), { endpoint: bea.endpoint, keys: bea.keys } as never, ua))
    h.pushService.requests.length = 0
    expect(
      (
        await h.deliver(
          raw({ from: 'Eve <eve@vendor.example>', to: BOOKS, subject: 'Books: nobody to tell', text: 'x', id: 'b8' }),
          { to: BOOKS },
        )
      ).entered,
    ).toBe('filed')
    expect(h.pushService.requests).toEqual([])
    expect(h.db.query(`SELECT notify FROM message WHERE subject = 'Books: nobody to tell'`).get()).toEqual({
      notify: 'dropped',
    })
    const week = (who: string) => part(h).notifications(as(who))
    // Before any device existed the Desk and Books mail of the world was dropped; Bea's week counts Desk's one, Alex's counts Desk's, Books's and this one.
    expect(unwrap(await week(BEA)).week).toEqual({ sent: 0, dropped: 1 })
    expect(unwrap(await week(ALEX)).week).toEqual({ sent: 0, dropped: 3 })
  })
})

describe('Claude’s door reads what the owner may read and no more', () => {
  test('the queue, a conversation by id, search, drafts, the mailbox lists and the audit leave out Bea’s Gmail; Claude’s reads of the owner’s are as before', async () => {
    const h = await world()
    const bea = ids(h, 'Bea only: the hull')
    const books = ids(h, 'Books: the invoice')
    const queue = await h.request(AGENT, 'GET', '/api/queue')
    expect(queue.status).toBe(200)
    expect((queue.json.rows as { subject: string }[]).map((r) => r.subject).sort()).toEqual([
      'Alex only: the survey',
      'Books: the invoice',
      'Desk: a quote for the dock',
    ])
    expect((await h.request(AGENT, 'GET', `/api/conversations/${bea.conversation}`)).status).toBe(404)
    expect((await h.request(AGENT, 'GET', `/api/conversations/${books.conversation}`)).status).toBe(200)
    const search = await h.request(AGENT, 'GET', '/api/search?q=hull')
    expect(search.json.rows).toEqual([])
    const accounts = await h.request(AGENT, 'GET', '/api/mailbox')
    expect((accounts.json.accounts as { address: string }[]).map((a) => a.address)).toEqual([ALEX])
    // Who is on each mailbox Claude may read: Alex's three, not Bea's Gmail.
    const people = await h.request(AGENT, 'GET', '/api/mailbox-people')
    expect(
      (people.json.mailboxes as { address: string; people: string[] }[]).map((m) => [m.address, m.people]).sort(),
    ).toEqual(
      [
        [ALEX, [ALEX]],
        [BOOKS, [ALEX]],
        [DESK, [ALEX, BEA]],
      ].sort(),
    )
    const mailboxes = await h.request(AGENT, 'GET', '/api/mailboxes')
    expect((mailboxes.json.mailboxes as { address: string }[]).map((a) => a.address).sort()).toEqual([BOOKS, DESK])
    // A draft on Bea's mail by Bea is not Claude's to read, edit or send (its scope is the owner's).
    const made = (await h.store.call(
      'createDraft',
      { conversationId: bea.conversation, body: 'Hull is fine.', subject: 'Re: hull', why: 'x' } as never,
      BEA,
    )) as { ok: true; value: { id: string; rev: number } }
    expect(made.ok).toBe(true)
    expect(((await h.request(AGENT, 'GET', '/api/drafts')).json as { id: string }[]).map((d) => d.id)).not.toContain(
      made.value.id,
    )
    expect(
      (await h.request(AGENT, 'PATCH', `/api/drafts/${made.value.id}`, { rev: made.value.rev, body: 'Hijacked.' }))
        .status,
    ).toBe(404)
    expect(
      (await h.request(AGENT, 'POST', `/api/drafts/${made.value.id}/send`, { rev: made.value.rev, through: 1 })).status,
    ).toBe(404)
    expect(
      (await h.request(AGENT, 'POST', '/api/drafts', { conversationId: bea.conversation, body: 'Mine.', why: 'x' }))
        .status,
    ).toBe(404)
    // A contact whose mail is only Bea's is not found, to read, to change or to merge in; the list leaves them out.
    const ben = contactOf(h, 'ben@yard.example')
    const sam = contactOf(h, 'sam@harbor.example')
    expect((await h.request(AGENT, 'GET', `/api/contacts/${ben}`)).status).toBe(404)
    expect((await h.request(AGENT, 'PATCH', `/api/contacts/${ben}`, { name: 'Renamed' })).status).toBe(404)
    expect((await h.request(AGENT, 'POST', `/api/contacts/${sam}/merge`, { absorb: ben })).status).toBe(404)
    expect(
      ((await h.request(AGENT, 'GET', '/api/contacts')).json as { name: string }[]).map((c) => c.name),
    ).not.toContain('Ben Okafor')
    expect((await h.request(AGENT, 'GET', `/api/contacts/${sam}`)).status).toBe(200)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { subject: string }[]
    expect(audit.some((a) => a.subject === `message:${made.value.id}`)).toBe(false)
    expect(audit.length).toBeGreaterThan(0)
  })
})

describe('a mailbox’s people can change by the declaration, and no mailbox is ever left that nobody can see', () => {
  test('settling makes the lists the declaration’s, removes a person who is no longer named, and gives a mailbox with nobody on it to the owner', async () => {
    const h = await world()
    const desk = (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(DESK) as { id: string }).id
    putPeople(sqlOver(h.db), desk, ['former@harborline.example'], 'test', 't')
    expect(h.inbox.whoIsOn(desk)).toEqual(['former@harborline.example'])
    expect(h.inbox.settleMailboxPeople()).toBeGreaterThan(0)
    expect(h.inbox.whoIsOn(desk).sort()).toEqual([ALEX, BEA])
    h.db.run('DELETE FROM mailbox_person WHERE mailbox_id = ?', [(h.inbox.mailboxRowAt(BEA) as { id: string }).id])
    expect(h.inbox.settleMailboxPeople()).toBe(1)
    expect(h.inbox.whoIsOn((h.inbox.mailboxRowAt(BEA) as { id: string }).id)).toEqual([ALEX])
    // Settled: nothing more to do.
    expect(h.inbox.settleMailboxPeople()).toBe(0)
  })

  test('Bea loses Desk when the declaration stops naming her: the mail is no longer shown to her at all', async () => {
    const h = await world()
    const inbox = part(h)
    expect(subjects(unwrap(await inbox.people(as(BEA))).people)).toContain('Desk: a quote for the dock')
    const desk = (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(DESK) as { id: string }).id
    putPeople(sqlOver(h.db), desk, [ALEX], 'test', 't')
    expect(subjects(unwrap(await inbox.people(as(BEA))).people)).not.toContain('Desk: a quote for the dock')
    expect(refusalOf(await inbox.messagesWith(as(BEA), { address: 'cora@dock.example' }))).toBe('not-found')
  })
})
