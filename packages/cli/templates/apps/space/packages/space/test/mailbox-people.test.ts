// Mailboxes have people: the space's own screens (the Inbox list, search, Today and People) over the REAL inbox, for two people of one made-up company who are on
// different mailboxes. What is asserted is what each person is shown: Bea, who is on Desk and nothing else, is shown Desk's mail and nobody else's; Alex, who is on Desk and Books, is shown both; Cal, on none, is told the Inbox is not
// open to him. The inbox's own rule and every method of its part are held by packages/inbox/test/mailbox-people.test.ts; this is the screens reading it.
import { describe, expect, test } from 'bun:test'
import { createInstall, signedIn } from '@space/workspace'
import { harness, TEAM } from '@space/inbox/test-support/harness'
import { MAIN } from '../src/conversations'
import { conversations, search } from '../src/list'
import { people } from '../src/people'
import { today } from '../src/today'

const ALEX = 'alex@harborline.example'
const BEA = 'bea@harborline.example'
const CAL = 'cal@harborline.example'
const DESK = 'desk@harborline.example'
const BOOKS = 'books@harborline-books.example'

const HARBORLINE = createInstall({
  company: { id: 'harborline', name: 'Harborline Boats', domain: 'harborline.example', timeZone: 'America/Los_Angeles' },
  access: { teamDomain: TEAM },
  formsService: { contact: 'help@harborline.example' },
  space: { host: 'space.harborline.example', sessionDuration: '730h' },
  people: [
    { address: ALEX, name: 'Alex', role: 'owner' },
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
})

const mail = (from: string, to: string, subject: string, text: string, id: string) =>
  [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@mail.example>`, 'Date: Mon, 20 Oct 2026 12:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', text, ''].join('\r\n')

async function world() {
  const h = harness({}, { install: HARBORLINE, ai: null, mailboxes: [{ address: DESK, name: 'Desk' }, { address: BOOKS, name: 'Books' }] })
  expect((await h.deliver(mail('Cora Lund <cora@dock.example>', DESK, 'A quote for the dock', 'Can you quote the dock?', 'd1'), { to: DESK })).entered).toBe('filed')
  expect((await h.deliver(mail('Vic Tran <vic@vendor.example>', BOOKS, 'The invoice', 'Our invoice is overdue.', 'b1'), { to: BOOKS })).entered).toBe('filed')
  const as = (who: string) => ({
    apps: { inbox: h.space({ install: HARBORLINE }), meet: undefined },
    install: HARBORLINE,
    signedIn: signedIn(HARBORLINE.person(who) as never, 4_000_000_000),
    self: [who],
    answerWithinMs: 2000,
  })
  return { h, as }
}

describe('the space’s screens show each person only the mailboxes they are on', () => {
  test('the Inbox list', async () => {
    const { as } = await world()
    const names = async (who: string) => (await conversations(as(who), MAIN, 'mail')).rows.map((r) => r.name).sort()
    expect(await names(BEA)).toEqual(['Cora Lund'])
    expect(await names(ALEX)).toEqual(['Cora Lund', 'Vic Tran'])
  })

  test('search finds a word in the mail the person may see, and in no other', async () => {
    const { as } = await world()
    const hits = async (who: string, q: string) => (await search(as(who), q)).mail.hits.map((h) => h.subject)
    expect(await hits(BEA, 'overdue')).toEqual([])
    expect(await hits(ALEX, 'overdue')).toEqual(['The invoice'])
    expect(await hits(BEA, 'quote')).toEqual(['A quote for the dock'])
  })

  test('Today: what waits on the person is their mailboxes’ mail', async () => {
    const { as } = await world()
    const waiting = async (who: string) => (await today(as(who))).waitingOnYou.rows.map((r) => (r.kind === 'mail' ? r.subject : '')).sort()
    expect(await waiting(BEA)).toEqual(['A quote for the dock'])
    expect(await waiting(ALEX)).toEqual(['A quote for the dock', 'The invoice'])
  })

  test('People: the contacts on the person’s mail', async () => {
    const { as } = await world()
    // The install's own people are on the team side of People whatever mail they are on; the others are the mail's.
    const names = async (who: string) => (await people(as(who))).entries.filter((e) => e.side !== 'team').map((e) => e.name).sort()
    expect(await names(BEA)).toEqual(['Cora Lund'])
    expect(await names(ALEX)).toEqual(['Cora Lund', 'Vic Tran'])
  })

  test('a person on no mailbox is told the Inbox is not open to them, on every screen that reads it', async () => {
    const { as } = await world()
    const listed = await conversations(as(CAL), MAIN, 'mail')
    expect(listed.rows).toEqual([])
    expect(listed.parts.find((s) => s.part === 'mail')).toMatchObject({ state: 'not-open-to-you' })
    const now = await today(as(CAL))
    expect(now.sources.find((s) => s.part === 'mail')).toMatchObject({ state: 'not-open-to-you' })
    expect(now.waitingOnYou.rows).toEqual([])
  })
})
