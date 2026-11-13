// The menu's counts are of rows, the unit the list is drawn in. Tessa saw "Inbox 7" over a list of 4 rows: the queue counted conversations and the list is a person each. The inbox now
// counts rows itself (packages/inbox/src/store/row-counts.ts), written a second time from the space's `inView`/`mergeConversations`, so this test is what holds the two together:
// the REAL inbox store behind the space's real list code, and every number in the menu equals the rows its list holds when opened.
//
// A thread with several people on it is ONE row, under the person who last wrote on it (the inbox says which: src/store/placement.ts). The world has
// a Craigslist-style thread (a relay with no name, then a seller with one), a thread a Client's contact started and another person answered, a Cloudflare mailbox's mail with a third
// person copied, and drafts on threads that are placed under someone else.
import { describe, expect, test } from 'bun:test'
import { ALL_MAIL } from '@space/inbox/src/queue'
import { ACME } from '@space/inbox/test-support/clients-part'
import { harness } from '@space/inbox/test-support/harness'
import type { InboxNav } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import { narrow, requestFor, type ListView } from '../src/client/format'
import { MAIN, parseView } from '../src/conversations'
import { conversations } from '../src/list'
import { readView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

/** Cloudflare hands the Worker a mail for Ridgeway's mailbox, with someone copied. */
const ridgewayMail = (from: string, name: string, cc: string) =>
  `Return-Path: <${from}>\nMIME-Version: 1.0\nFrom: ${name} <${from}>\nDate: Mon, 26 Oct 2026 13:00:00 -0700\nMessage-ID: <p1@example.org>\nSubject: Hours question\nTo: info@ridgewaycycles.example\nCc: ${cc}\nContent-Type: text/plain; charset="UTF-8"\n\nAre you open on Sundays?\n`

async function world(options: { calendar?: boolean; telegram?: boolean; jmap?: boolean } = {}) {
  // The default mailboxes: Ridgeway's, a Cloudflare one.
  const h = harness({}, { ai: null, ...(options.jmap && { jmap: true }) })
  const g = h.google.mailbox
  const T = Date.parse('2026-10-20T12:00:00.000Z')
  const hours = (n: number) => T - n * 3_600_000
  // Dana: three open conversations, one unread. Ben: one open. One Craigslist-style thread with a seller and a relay on it. A newsletter (Bulk) and two closed conversations.
  g.add({ id: 'd1', threadId: 'td1', from: 'Dana Reyes <dana@harbor.example>', subject: 'One', body: 'Hello', labels: ['INBOX'] })
  g.add({ id: 'd2', threadId: 'td2', from: 'Dana Reyes <dana@harbor.example>', subject: 'Two', body: 'Hello', labels: ['INBOX'] })
  g.add({ id: 'd3', threadId: 'td3', from: 'Dana Reyes <dana@harbor.example>', subject: 'Three', body: 'Hello' })
  g.add({ id: 'b1', threadId: 'tb1', from: 'Ben Ortiz <ben@x.example>', subject: 'Ben', body: 'Hello', labels: ['INBOX'] })
  g.add({ id: 'x1', threadId: 'tx', from: 'Seller <seller@sale.example>', to: 'Tessa <tessa@northfield.example>, Relay <relay@reply.example>', subject: 'Roof box', body: 'For sale', labels: ['INBOX'] })
  // One listing on two relay addresses: the bare one wrote first, the seller (with a name) wrote last, so the one row is the seller's.
  g.add({ id: 'cl1', threadId: 'tcl', from: 'abc123@reply.craigslist.example', subject: 'Roof box for sale', body: 'Is it still there?', at: hours(3), labels: ['INBOX'] })
  g.add({ id: 'cl2', threadId: 'tcl', from: 'Craigslist seller (Harbour Road roof box) <abc123@sale.craigslist.example>', subject: 'Re: Roof box for sale', body: 'Yes.', at: hours(2), labels: ['INBOX'] })
  // Cora is linked to a Client and started this thread; Ben answered last, so it is Ben's row and Cora has none for it.
  g.add({ id: 'k1', threadId: 'tk', from: 'Cora Lund <cora@acme.example>', subject: 'Contract', body: 'Here it is', at: hours(5), labels: ['INBOX'] })
  g.add({ id: 'k2', threadId: 'tk', from: 'Ben Ortiz <ben@x.example>', subject: 'Re: Contract', body: 'Signed', at: hours(4), labels: ['INBOX'] })
  g.add({ id: 'n1', threadId: 'tn1', from: 'Brand News <news@brand.example>', subject: 'Deals', body: 'Ten percent off', headers: { 'List-Unsubscribe': '<mailto:u@brand.example>' } })
  g.add({ id: 'c1', threadId: 'tc1', from: 'Old Matter <old@x.example>', subject: 'Old', body: 'Filed' })
  g.add({ id: 'c2', threadId: 'tc2', from: 'Ben Ortiz <ben@x.example>', subject: 'Old Ben', body: 'Filed' })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  for (const t of ['tc1', 'tc2']) g.labelThread(t, { remove: ['INBOX', 'UNREAD'] })
  g.labelThread('td1', { remove: ['UNREAD'] })
  g.labelThread('td2', { remove: ['UNREAD'] })
  g.labelThread('tb1', { remove: ['UNREAD'] })
  expect((await h.push()).status).toBe(204)
  await h.drain()
  // One meeting updated three times by Google Calendar: a thread each, the older two closed when the newer arrive (src/calendar-event.ts).
  if (options.calendar) {
    const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:evtinfra01@google.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    for (const [n, time, who] of [[1, '8am', 'Noah Feld <noah@fernway.example>'], [2, '7am', 'Ana Ruiz <ana@fernway.example>'], [3, '6:45am', 'Sam Park <sam@fernway.example>']] as const) {
      g.add({ id: `cal${n}`, threadId: `tcal${n}`, from: who, headers: { Sender: 'Google Calendar <calendar-notification@google.com>' }, subject: `Updated invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 ${time}`, body: 'Invitation', ics, at: T + n * 60_000, labels: ['INBOX', 'UNREAD'] })
    }
    expect((await h.push()).status).toBe(204)
    await h.drain()
  }
  // Telegram: a person who wrote and has not been answered, a bot (Bulk, filed by the rule for automated senders), and a person whose
  // chat is in Telegram's archive (closed). None has an email address: they are rows of people with only a Telegram identity.
  if (options.telegram) {
    const account = { id: '7000000001' }
    const person = (id: string, name: string, bot = false) => ({ id, name, bot })
    const chat = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, kind: 'user' as const, person: person(id, name), muted: false, ...over })
    const sent = h.inbox.pushTelegram({
      account,
      mirror: true,
      chats: [
        chat('7001', 'Tess Telegram', { readInboxMaxId: 0 }),
        { id: '7002', kind: 'bot' as const, person: person('7002', 'Weather Bot', true), muted: false, readInboxMaxId: 0 },
        chat('7003', 'Eli Archived', { archived: true, readInboxMaxId: 9 }),
        // A group (one row under its own name, the members who write in it are people, not rows), a channel (Bulk) and a group Tessa archived (closed).
        { id: '-1007100', kind: 'group' as const, title: 'Neighbours', muted: false, readInboxMaxId: 0 },
        { id: '-1007101', kind: 'channel' as const, title: 'Status', muted: false, readInboxMaxId: 0 },
        { id: '-7102', kind: 'group' as const, title: 'Old friends', muted: false, archived: true, readInboxMaxId: 9 },
      ],
      messages: [
        { chatId: '7001', id: 1, at: '2026-10-20T10:00:00.000Z', out: false, text: 'Can you call me back?' },
        { chatId: '7002', id: 1, at: '2026-10-20T10:01:00.000Z', out: false, text: 'Rain at 4' },
        { chatId: '7003', id: 1, at: '2026-10-20T10:02:00.000Z', out: false, text: 'Thanks, all set' },
        { chatId: '-1007100', id: 1, at: '2026-10-20T10:03:00.000Z', out: false, text: 'Seed swap on the 14th', sender: person('7201', 'Gus Garden') },
        { chatId: '-1007100', id: 2, at: '2026-10-20T10:04:00.000Z', out: false, text: 'Bring jars', sender: person('7202', 'Hana Hill') },
        { chatId: '-1007101', id: 1, at: '2026-10-20T10:05:00.000Z', out: false, text: 'Resolved' },
        { chatId: '-7102', id: 1, at: '2026-10-20T10:06:00.000Z', out: false, text: 'Happy new year', sender: person('7201', 'Gus Garden') },
      ],
    })
    expect(sent.ok).toBe(true)
  }
  // A mailbox on the mail server (read and written over JMAP): Kim wrote and has not been answered (open, unread), Jo's receipt was archived in a mail app after
  // it arrived (so it is Closed here), and our own reply to Pat is in the mailbox's Sent (filed read and closed). Ben, who has other mail, is copied on Kim's: Kim's row only.
  if (options.jmap) {
    h.jmapServer.deliver({ from: 'Kim Alder <kim@alder.example>', to: 'test@harborline.example', cc: 'Ben Ortiz <ben@x.example>', subject: 'Walk-ins on Saturday?', body: 'Do you take walk-ins?' })
    const receipt = h.jmapServer.deliver({ from: 'Jo Marsh <jo@marsh.example>', to: 'test@harborline.example', subject: 'Receipt', body: 'For your records.' })
    h.jmapServer.deliver({ from: 'harborline <test@harborline.example>', to: 'pat@pat.example', subject: 'Re: Hours', body: 'Nine to five.', folder: 'sent', seen: true })
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    h.jmapServer.moveTo(receipt, 'archive')
    await h.jmapRoom.requestJmapSync()
    await h.drain()
  }
  // Ridgeway's mailbox (Cloudflare): Priya wrote, Ben is copied, so it is Priya's row only.
  expect((await h.deliver(ridgewayMail('priya.n@example.org', 'Priya Nair', 'ben@x.example'), { from: 'priya.n@example.org', to: 'info@ridgewaycycles.example' })).entered).toBe('filed')
  await h.drain()
  const one = <R>(sql: string) => h.db.query(sql).get() as R
  // Cora's Client, and drafts: one on Dana's thread, one on the thread that is Ben's row (Cora is on it too).
  const cora = one<{ contact_id: string }>(`SELECT contact_id FROM identity WHERE address = 'cora@acme.example'`).contact_id
  expect((await h.space().linkClient(OWNER_SIGNED_IN, cora, ACME.id)).ok).toBe(true)
  const dana = one<{ contact_id: string }>(`SELECT contact_id FROM identity WHERE address = 'dana@harbor.example'`).contact_id
  expect((await h.space().linkClient(OWNER_SIGNED_IN, dana, ACME.id)).ok).toBe(true)
  for (const [thread, address, name] of [
    ['td1', 'dana@harbor.example', 'Dana Reyes'],
    ['tk', 'cora@acme.example', 'Cora Lund'],
  ] as const) {
    const conversation = one<{ id: string }>(`SELECT id FROM conversation WHERE gmail_thread_id = '${thread}'`).id
    expect(h.inbox.createDraft({ conversationId: conversation, address, name, subject: 'Re', body: 'Thanks.', why: 'Answered.' }, 'agent:abc123.access').ok).toBe(true)
  }
  const ask = { apps: { inbox: h.space(), meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 2000 }
  const nav = async (): Promise<InboxNav> => {
    const got = await readView(ask, 'navigation', new URLSearchParams())
    if (!got.ok || got.value.result !== 'ok') throw new Error(`navigation: ${JSON.stringify(got)}`)
    return got.value.value as InboxNav
  }
  /** The names of the rows a view holds, for the test that says WHO a thread is under. */
  const named = async (view: ListView) => {
    const query = new URL(requestFor(view), 'http://x').searchParams
    const parsed = parseView(query.get('view') ?? undefined, query.get('mailbox') ?? undefined)
    const answer = await conversations(ask, parsed ?? MAIN, 'mail')
    return narrow(answer.rows, view, 'all').map((r) => r.name).sort()
  }
  /** What the page shows when the view is opened: the list asked for as `requestFor` asks, narrowed as the page narrows it. */
  const rows = async (view: ListView) => {
    const query = new URL(requestFor(view), 'http://x').searchParams
    const parsed = parseView(query.get('view') ?? undefined, query.get('mailbox') ?? undefined)
    const answer = await conversations(ask, parsed ?? MAIN, 'mail')
    const shown = narrow(answer.rows, view, 'all')
    return { count: shown.length, unread: shown.filter((r) => r.unread > 0).length, loose: answer.looseDrafts.length }
  }
  return { nav, rows, named, h }
}

describe('the menu counts rows, as the list does', () => {
  test('every view equals the rows its list holds when opened, and the accent is the rows with something unread', async () => {
    const s = await world()
    const menu = await s.nav()
    const inbox = await s.rows('all')
    expect(menu.views.inbox).toEqual({ count: inbox.count, unread: inbox.unread })
    const unread = await s.rows('unread')
    expect(menu.views.unread.count).toBe(unread.count)
    expect(menu.views.bulk).toEqual({ count: (await s.rows('bulk')).count, unread: (await s.rows('bulk')).unread })
    expect(menu.views.closed).toEqual({ count: (await s.rows('closed')).count, unread: 0 })
    const drafts = await s.rows('drafts')
    expect(menu.views.drafts.count).toBe(drafts.count + drafts.loose)
  })

  test('a meeting updated three times is one row, and the menu still equals the rows (the older updates are closed, not hidden)', async () => {
    const plain = await world()
    const s = await world({ calendar: true })
    const before = await plain.nav()
    const menu = await s.nav()
    const inbox = await s.rows('all')
    expect(menu.views.inbox).toEqual({ count: inbox.count, unread: inbox.unread })
    // Three organizers' threads of one event are one row of the Inbox, the latest sender's, and the two older ones are under Closed.
    expect(inbox.count).toBe(before.views.inbox.count + 1)
    expect(menu.views.closed.count).toBe((await s.rows('closed')).count)
    const names = await s.named('all')
    expect(names).toContain('Sam Park')
    expect(names).not.toContain('Noah Feld')
    expect(names).not.toContain('Ana Ruiz')
  })

  test('so does each business mailbox and each Client, with a thread several people are on counted under one of them', async () => {
    const s = await world()
    const menu = await s.nav()
    expect(menu.mailboxes.length).toBe(1)
    const ridgeway = menu.mailboxes[0]!
    const inMailbox = await s.rows(`mailbox:${ridgeway.id}`)
    expect({ count: ridgeway.count, unread: ridgeway.unread }).toEqual({ count: inMailbox.count, unread: inMailbox.unread })
    const acme = menu.clients.find((c) => c.id === ACME.id)!
    const inClient = await s.rows(`client:${ACME.id}`)
    expect({ count: acme.count, unread: acme.unread }).toEqual({ count: inClient.count, unread: inClient.unread })
  })

  test('a Gmail account is a mailbox of the menu like Ridgeway’s: its own count equals the rows of its list, and the business mailbox’s mail is not in it', async () => {
    const s = await world()
    const menu = await s.nav()
    expect(menu.gmailAccounts.map((g) => g.name)).toEqual(['northfield'])
    const account = menu.gmailAccounts[0]!
    const inAccount = await s.rows(`mailbox:${account.id}`)
    expect({ count: account.count, unread: account.unread }).toEqual({ count: inAccount.count, unread: inAccount.unread })
    // Gmail's open mail that is not Bulk: Dana, Ben, the seller, the Craigslist seller (Priya's is Ridgeway's).
    expect(account.count).toBe(4)
    expect(account.unread).toBeGreaterThan(0)
    expect(await s.named(`mailbox:${account.id}`)).not.toContain('Priya Nair')
    // The account's count and the business mailbox's are the whole Inbox between them.
    expect(account.count + (menu.mailboxes[0]?.count ?? 0)).toBe(menu.views.inbox.count)
  })

  test('the numbers of this world are the rows a person would count', async () => {
    const s = await world()
    const menu = await s.nav()
    // Open, not Bulk: Dana (three threads, one row), Ben (two threads, one row), the seller, the Craigslist seller, and Priya. Not the relay who was only written to, not the
    // bare Craigslist address that wrote first, not Cora who started the contract Ben answered, and not Ben again for Priya's mail he was copied on.
    expect([menu.views.inbox.count, menu.views.bulk.count, menu.views.closed.count]).toEqual([5, 1, 2])
    // Drafts are on Dana's thread and on the contract thread, which is Ben's row: two rows, not three.
    expect(menu.views.drafts.count).toBe(2)
    // Ridgeway's mailbox holds one open conversation, Priya's, and one row though Ben is on it.
    expect(menu.mailboxes[0]?.count).toBe(1)
    // Acme's list places a thread among Acme's people only: Dana, and Cora, whose only thread is the contract Ben answered last. It is Ben's row in the Inbox and Cora's in Acme's list, once each.
    expect(menu.clients.find((c) => c.id === ACME.id)?.count).toBe(2)
  })

  test('a thread a Client’s person is on is once in the Inbox, under the outsider who wrote last, and once in the Client’s list, under the Client’s person', async () => {
    const s = await world()
    const inbox = await s.named('all')
    expect(inbox).toContain('Ben Ortiz')
    expect(inbox).not.toContain('Cora Lund')
    expect(await s.named(`client:${ACME.id}`)).toEqual(['Cora Lund', 'Dana Reyes'])
  })

  test('Telegram’s people, a bot and an archived chat are rows like any other: the menu equals the rows for every view, and the Telegram mailbox’s own count equals its list', async () => {
    const plain = await world()
    const s = await world({ telegram: true })
    const before = await plain.nav()
    const menu = await s.nav()
    const inbox = await s.rows('all')
    expect(menu.views.inbox).toEqual({ count: inbox.count, unread: inbox.unread })
    expect(menu.views.unread.count).toBe((await s.rows('unread')).count)
    expect(menu.views.bulk).toEqual({ count: (await s.rows('bulk')).count, unread: (await s.rows('bulk')).unread })
    expect(menu.views.closed.count).toBe((await s.rows('closed')).count)
    // Tess is one more row of the Inbox (and unread); the bot is one more of Bulk; the archived chat one more under Closed.
    // The group is one more row of the Inbox too (one row for two members), the channel one more of Bulk, and the archived group one more under Closed.
    expect(menu.views.inbox.count).toBe(before.views.inbox.count + 2)
    expect(menu.views.inbox.unread).toBe(before.views.inbox.unread + 2)
    expect(menu.views.bulk.count).toBe(before.views.bulk.count + 2)
    expect(menu.views.closed.count).toBe(before.views.closed.count + 2)
    expect(await s.named('all')).toContain('Tess Telegram')
    expect(await s.named('all')).toContain('Neighbours')
    expect(await s.named('all')).not.toContain('Weather Bot')
    expect(await s.named('all')).not.toContain('Status')
    // The members who write in a group are never rows of their own.
    expect(await s.named('all')).not.toContain('Gus Garden')
    expect(await s.named('all')).not.toContain('Hana Hill')
    expect(await s.named('bulk')).toContain('Weather Bot')
    expect(await s.named('bulk')).toContain('Status')
    expect(await s.named('closed')).toContain('Eli Archived')
    expect(await s.named('closed')).toContain('Old friends')
    // The Telegram mailbox is not one of the business mailboxes of the menu, and its own count is its open rows that are not Bulk, as a list of it holds them.
    expect(menu.mailboxes.map((m) => m.name)).toEqual(['Ridgeway Cycles'])
    const telegram = (s.h.inbox.telegramMailboxes()[0] as { id: string }).id
    const counts = s.h.inbox.spaceRowCounts([], ALL_MAIL)
    const inMailbox = await s.rows(`mailbox:${telegram}`)
    expect(counts.mailboxes[telegram]).toEqual({ count: inMailbox.count, unread: inMailbox.unread })
    expect(inMailbox.count).toBe(2)
  })

  test('a mailbox on the mail server is a mailbox of the menu like Ridgeway’s: its people are rows, a mail app’s Archive is Closed, and its own count equals its list', async () => {
    const plain = await world()
    const s = await world({ jmap: true })
    const before = await plain.nav()
    const menu = await s.nav()
    const inbox = await s.rows('all')
    expect(menu.views.inbox).toEqual({ count: inbox.count, unread: inbox.unread })
    expect(menu.views.unread.count).toBe((await s.rows('unread')).count)
    expect(menu.views.bulk).toEqual({ count: (await s.rows('bulk')).count, unread: (await s.rows('bulk')).unread })
    expect(menu.views.closed.count).toBe((await s.rows('closed')).count)
    // Kim is one more row of the Inbox (and unread); Jo's archived receipt and our reply to Pat are two more under Closed.
    expect(menu.views.inbox.count).toBe(before.views.inbox.count + 1)
    expect(menu.views.inbox.unread).toBe(before.views.inbox.unread + 1)
    expect(menu.views.closed.count).toBe(before.views.closed.count + 2)
    expect(await s.named('all')).toContain('Kim Alder')
    expect(await s.named('closed')).toContain('Jo Marsh')
    // Ben was copied on Kim's mail and is not a row for it
    expect((await s.named('all')).filter((n) => n === 'Ben Ortiz')).toHaveLength(1)
    // Its own entry in the menu (the mail server's, beside the business mailboxes) is its open rows that are not Bulk, as a list of it holds them.
    expect(menu.mailboxes.map((m) => m.name)).toEqual(['Ridgeway Cycles'])
    expect(menu.jmap).toHaveLength(1)
    const box = menu.jmap?.[0]
    const inMailbox = await s.rows(`mailbox:${box?.id}`)
    expect({ count: box?.count, unread: box?.unread }).toEqual({ count: inMailbox.count, unread: inMailbox.unread })
    expect(inMailbox.count).toBe(1)
  })
})
