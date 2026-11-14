import { describe, expect, test } from 'bun:test'
import type { InboxPeople, InboxScope } from '@space/workspace'
import { cut, isBelow, type Place, placeText, readPlace } from '../src/store/paging'
import { QUEUE_PAGE } from '../src/types'
import { ACME } from '../test-support/clients-part'
import { asker, harness } from '../test-support/harness'

/**
 * How a list reads further than its newest screen, and how a mailbox's list is made.
 *
 * Every list the space shows is the newest QUEUE_PAGE conversations of its view. Two things were wrong with that: a mailbox's list was cut out of the newest screen of the WHOLE inbox,
 * so a mailbox whose mail is all older than that screen had a count in the menu and an empty list; and there was no way to the older conversations but a search. The inbox now narrows (a mailbox, a Client,
 * the unread ones) BEFORE it cuts, and a reader hands back the position it has read down to (`floor`, as `through`) to be answered everything at or after it, with `older` for one more screen.
 * These tests drive the real store behind the contract (`InboxForSpace.people`), over more conversations than a screen.
 */

const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}

const place = (at: string, seq: number): Place => ({ at, seq })

describe('a position in a list, and the cut at it (pure)', () => {
  // A list newest first, as the store has it: the same time on two of them, told apart by the number.
  const list = [
    place('2026-10-20T12:00:05.000Z', 9),
    place('2026-10-20T12:00:04.000Z', 8),
    place('2026-10-20T12:00:04.000Z', 7),
    place('2026-10-20T12:00:03.000Z', 6),
    place('2026-10-20T12:00:02.000Z', 5),
    place('2026-10-20T12:00:01.000Z', 4),
  ]
  const at = (n: number) => placeText(list[n] as Place)
  const read = (n: number) => readPlace(at(n)) as Place

  test('a position is text that reads back to the place it was made from, and anything else is no position', () => {
    expect(readPlace(placeText(place('2026-10-20T12:00:04.000Z', 7)))).toEqual(place('2026-10-20T12:00:04.000Z', 7))
    for (const bad of [
      '',
      '7',
      '|7',
      '2026-10-20T12:00:04.000Z|',
      '2026-10-20T12:00:04.000Z|-1',
      'drop table|1',
      '2026-10-20T12:00:04.000Z|1|2',
      `${'a'.repeat(60)}|1`,
    ])
      expect([bad, readPlace(bad)]).toEqual([bad, null])
  })

  test('older is a smaller time, or the same time and a smaller number', () => {
    expect(isBelow(list[1] as Place, list[0] as Place)).toBe(true)
    expect(isBelow(list[2] as Place, list[1] as Place)).toBe(true)
    expect(isBelow(list[1] as Place, list[2] as Place)).toBe(false)
    expect(isBelow(list[1] as Place, list[1] as Place)).toBe(false)
  })

  test('with no position it is the newest screen, with more when there were others, and the floor is its last', () => {
    const page = cut(list, (p) => p, {}, 4)
    expect(page.shown).toEqual(list.slice(0, 4))
    expect(page.more).toBe(true)
    expect(page.floor).toBe(at(3))
    const all = cut(list, (p) => p, {}, 10)
    expect([all.shown.length, all.more, all.floor]).toEqual([6, false, at(5)])
    expect(cut([], (p) => p, {}, 4)).toEqual({ shown: [], more: false, floor: null })
  })

  test('with a position it is everything down to it, and with older one more screen below it, with no gap and no repeat', () => {
    const first = cut(list, (p) => p, {}, 2)
    const second = cut(list, (p) => p, { through: readPlace(first.floor as string) as Place, older: true }, 2)
    // The two tied at 12:00:04 are told apart by their numbers: the floor is the one numbered 8, so the one numbered 7 is below it.
    expect(second.shown).toEqual(list.slice(0, 4))
    expect(second.more).toBe(true)
    const third = cut(list, (p) => p, { through: readPlace(second.floor as string) as Place, older: true }, 2)
    expect(third.shown).toEqual(list.slice(0, 6))
    expect(third.more).toBe(false)
    // Read again at the same position and without older: the same answer, nothing added.
    expect(cut(list, (p) => p, { through: readPlace(second.floor as string) as Place }, 2).shown).toEqual(second.shown)
    // And a position from the middle of a tie keeps the tied one above it and drops the one below.
    expect(cut(list, (p) => p, { through: read(1) }, 1).shown).toEqual(list.slice(0, 2))
    expect(cut(list, (p) => p, { through: read(2) }, 1).shown).toEqual(list.slice(0, 3))
  })

  test('a position that mail arriving has moved down is still a place: newer mail is above it and shifts nothing below', () => {
    const grown = [place('2026-10-20T12:00:09.000Z', 10), ...list]
    const page = cut(grown, (p) => p, { through: read(2), older: true }, 2)
    // The new one on top, the three down to the position, and one more screen (two) below it.
    expect(page.shown).toEqual(grown.slice(0, 6))
  })

  test('a list that shrank below its position still answers a full screen of what is older than it', () => {
    // The reader had the first four and the position of the fourth; two of those were closed since.
    const shrunk = [list[0], list[3], list[4], list[5]] as Place[]
    const page = cut(shrunk, (p) => p, { through: read(3), older: true }, 2)
    expect(page.shown).toEqual(shrunk)
    expect(page.more).toBe(false)
  })
})

type Conv = { id: string; at: number }

/**
 * A store with more open conversations than two screens: 430 of Gmail's, a minute apart, newest first, and the older mail of the one business mailbox, which is older than every one
 * of them. Built once for the tests that only read.
 */
const T = Date.parse('2026-11-10T12:00:00.000Z')
const GMAIL_COUNT = 2 * QUEUE_PAGE + 30
const ridgewayMail = (n: number, from: string, name: string) =>
  `Return-Path: <${from}>\nMIME-Version: 1.0\nFrom: ${name} <${from}>\nDate: Mon, ${10 + n} Aug 2026 13:00:00 -0700\nMessage-ID: <old${n}@example.org>\nSubject: Old matter ${n}\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\nStill waiting on this.\n`

async function bigWorld() {
  const h = harness({}, { ai: null })
  const g = h.google.mailbox
  for (let i = 0; i < GMAIL_COUNT; i++)
    g.add({
      id: `g${i}`,
      threadId: `tg${i}`,
      from: `Person ${i} <p${i}@example.com>`,
      subject: `Matter ${i}`,
      body: 'Hello',
      at: T - i * 60_000,
      labels: ['INBOX'],
    })
  // One more, far older than the rest and still unread, from a person we link to a Client.
  g.add({
    id: 'old',
    threadId: 'told',
    from: 'Cora Lund <cora@acme.example>',
    subject: 'The contract',
    body: 'Here it is',
    at: T - (GMAIL_COUNT + 50) * 60_000,
    labels: ['INBOX', 'UNREAD'],
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  // Every conversation but the old one is read, so Unread is the old one alone.
  for (let i = 0; i < GMAIL_COUNT; i++) g.labelThread(`tg${i}`, { remove: ['UNREAD'] })
  expect((await h.push()).status).toBe(204)
  await h.drain()
  // The business mailbox's mail, all older than every Gmail conversation above.
  for (const [n, from, name] of [
    [1, 'priya.n@example.org', 'Priya Nair'],
    [2, 'omar.k@example.org', 'Omar Khan'],
    [3, 'lena.s@example.org', 'Lena Stahl'],
  ] as const) {
    expect((await h.deliver(ridgewayMail(n, from, name), { from, to: 'info@ridgewaycycles.example' })).entered).toBe(
      'filed',
    )
  }
  await h.drain()
  const cora = (
    h.db.query(`SELECT contact_id FROM identity WHERE address = 'cora@acme.example'`).get() as { contact_id: string }
  ).contact_id
  expect((await h.space().linkClient(asker(), cora, ACME.id)).ok).toBe(true)
  const mailbox = (kind: string) => (h.db.query(`SELECT id FROM mailbox WHERE kind = ?`).get(kind) as { id: string }).id
  return { h, a: asker(), ridgeway: mailbox('cloudflare'), gmail: mailbox('gmail') }
}

type Big = Awaited<ReturnType<typeof bigWorld>>
let shared: Promise<Big> | undefined
const big = () => (shared ??= bigWorld())

const people = async (w: Big, scope?: InboxScope): Promise<InboxPeople> => unwrap(await w.h.space().people(w.a, scope))
/** The conversations an answer holds, each once, in the order the list reads them: newest first. */
const conversationsOf = (answer: InboxPeople): Conv[] => {
  const seen = new Map<string, Conv>()
  for (const p of answer.people)
    for (const c of p.conversations) seen.set(c.conversationId, { id: c.conversationId, at: c.at })
  return [...seen.values()].sort((a, b) => b.at - a.at)
}
const lineCount = (answer: InboxPeople): number => conversationsOf(answer).length

describe('a list is narrowed before it is cut, so it holds what the menu counts', () => {
  test('a mailbox whose mail is all older than the newest screen of the inbox is listed, and its list equals its count', async () => {
    const w = await big()
    const nav = unwrap(await w.h.space().navigation(w.a))
    const ridgeway = nav.mailboxes.find((m) => m.id === w.ridgeway)
    expect(ridgeway?.count).toBe(3)
    // The main list is the newest screen, all Gmail's: Ridgeway's three are below it, which is the defect.
    const main = await people(w)
    expect(lineCount(main)).toBe(QUEUE_PAGE)
    expect(main.more).toBe(true)
    expect(main.people.some((p) => p.conversations.some((c) => c.mailbox?.id === w.ridgeway))).toBe(false)
    // Narrowed by the inbox, the mailbox's list is its three conversations and nothing is left to load.
    const own = await people(w, { mailbox: w.ridgeway })
    expect(own.people.map((p) => p.name).sort()).toEqual(['Lena Stahl', 'Omar Khan', 'Priya Nair'])
    expect(own.people.length).toBe(ridgeway?.count as number)
    expect(own.more).toBe(false)
  })

  test('a Gmail account is a mailbox like any other: its own list is its newest screen, with more', async () => {
    const w = await big()
    const own = await people(w, { mailbox: w.gmail })
    expect(lineCount(own)).toBe(QUEUE_PAGE)
    expect(own.more).toBe(true)
    expect(own.people.some((p) => p.conversations.some((c) => c.mailbox?.id === w.ridgeway))).toBe(false)
  })

  test('the unread ones are listed though they are older than the newest screen, and only they are', async () => {
    const w = await big()
    const nav = unwrap(await w.h.space().navigation(w.a))
    expect(nav.views.unread.count).toBeGreaterThanOrEqual(1)
    const unread = await people(w, { unread: true })
    expect(unread.people.map((p) => p.name)).toContain('Cora Lund')
    expect(unread.people.every((p) => p.conversations.every((c) => c.unread))).toBe(true)
    expect(unread.people.length).toBe(nav.views.unread.count)
    expect(unread.more).toBe(false)
  })

  test('a Client’s people are listed though their only conversation is older than the newest screen', async () => {
    const w = await big()
    const nav = unwrap(await w.h.space().navigation(w.a))
    expect(nav.clients.find((c) => c.id === ACME.id)?.count).toBe(1)
    const client = await people(w, { include: ['bulk'], client: ACME.id })
    expect(client.people.map((p) => p.name)).toEqual(['Cora Lund'])
    expect(client.more).toBe(false)
    // A Client nobody is linked to has an empty list, not the newest screen.
    expect((await people(w, { include: ['bulk'], client: 999 })).people).toEqual([])
  })
})

describe('reading further down a list: a position, never an offset', () => {
  test('the newest screen says there is more and where it ends; read down to there with older, it holds two screens, then every one', async () => {
    const w = await big()
    const first = await people(w)
    expect(first.more).toBe(true)
    expect(typeof first.floor).toBe('string')
    const one = conversationsOf(first)
    expect(one.length).toBe(QUEUE_PAGE)

    const second = await people(w, { through: first.floor as string, older: true })
    const two = conversationsOf(second)
    expect(two.length).toBe(2 * QUEUE_PAGE)
    expect(second.more).toBe(true)
    // The first screen is the top of the second, in the same order: nothing moved, nothing is repeated.
    expect(two.slice(0, QUEUE_PAGE).map((c) => c.id)).toEqual(one.map((c) => c.id))
    expect(new Set(two.map((c) => c.id)).size).toBe(two.length)

    const third = await people(w, { through: second.floor as string, older: true })
    const three = conversationsOf(third)
    // All of them: the 430 Gmail ones, the old one, and Ridgeway's three, which are open mail of the main list too.
    expect(three.length).toBe(GMAIL_COUNT + 1 + 3)
    expect(third.more).toBe(false)
    expect(new Set(three.map((c) => c.id)).size).toBe(three.length)
    expect(three.slice(0, 2 * QUEUE_PAGE).map((c) => c.id)).toEqual(two.map((c) => c.id))
    // Newest first all the way down.
    expect(three.every((c, n) => n === 0 || (three[n - 1] as Conv).at >= c.at)).toBe(true)
  })

  test('a list read again at its position keeps what was loaded: the same screens, not the newest one', async () => {
    const w = await big()
    const first = await people(w)
    const second = await people(w, { through: first.floor as string, older: true })
    expect(conversationsOf(second).length).toBe(2 * QUEUE_PAGE)
    const again = await people(w, { through: second.floor as string })
    expect(conversationsOf(again).length).toBe(2 * QUEUE_PAGE)
    expect(conversationsOf(again).map((c) => c.id)).toEqual(conversationsOf(second).map((c) => c.id))
    expect(again.more).toBe(second.more)
    expect(again.floor).toBe(second.floor)
  })

  test('mail that arrives, and mail that is closed, between one read and the next move nothing and repeat nothing', async () => {
    const w = await big()
    const g = w.h.google.mailbox
    const first = await people(w)
    const was = conversationsOf(first)
    // Every conversation, read from the oldest position there could be: what the list is, to be compared with what the paging gives.
    const every = conversationsOf(await people(w, { through: '2000-01-01T00:00:00.000Z|0' }))
    expect(every.length).toBeGreaterThan(2 * QUEUE_PAGE)
    // A new conversation arrives on top, and one of the first screen is closed.
    g.add({
      id: 'fresh',
      threadId: 'tfresh',
      from: 'New Person <fresh@example.com>',
      subject: 'Just arrived',
      body: 'Hi',
      at: T + 60_000,
      labels: ['INBOX'],
    })
    g.labelThread(`tg5`, { remove: ['INBOX'] })
    expect((await w.h.push()).status).toBe(204)
    await w.h.drain()
    const closed = (
      w.h.db
        .query(`SELECT c.id FROM conversation c JOIN message m ON m.conversation_id = c.id WHERE m.gmail_id = 'g5'`)
        .get() as { id: string }
    ).id
    const second = await people(w, { through: first.floor as string, older: true })
    const got = conversationsOf(second)
    const fresh = got[0] as Conv
    expect(fresh.at).toBe(T + 60_000)
    expect(new Set(got.map((c) => c.id)).size).toBe(got.length)
    // The conversations the reader had are all still there (but the closed one), in order, and the screen below them is whole: the 200 that were next, none skipped, none repeated.
    const expected = [
      fresh.id,
      ...was.map((c) => c.id).filter((id) => id !== closed),
      ...every.slice(QUEUE_PAGE, 2 * QUEUE_PAGE).map((c) => c.id),
    ]
    expect(got.map((c) => c.id)).toEqual(expected)
  })
})

describe('the Sent list pages by the owner’s send, not by what arrived after it', () => {
  test('230 sent conversations: the newest screen, then the rest below its position, each once, newest send first', async () => {
    const h = harness({}, { ai: null })
    const g = h.google.mailbox
    for (let i = 0; i < QUEUE_PAGE + 30; i++)
      g.add({
        id: `s${i}`,
        threadId: `ts${i}`,
        labels: ['SENT'],
        from: 'Tessa Marlow <tessa@northfield.example>',
        to: `p${i}@example.com`,
        subject: `Sent ${i}`,
        body: 'Done.',
        at: T - i * 60_000,
      })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const a = asker()
    const first = unwrap(await h.space().people(a, { sent: true }))
    expect(first.more).toBe(true)
    expect(conversationsOf(first).length).toBe(QUEUE_PAGE)
    const second = unwrap(await h.space().people(a, { sent: true, through: first.floor as string, older: true }))
    const all = conversationsOf(second)
    expect(all.length).toBe(QUEUE_PAGE + 30)
    expect(second.more).toBe(false)
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    expect(all.slice(0, QUEUE_PAGE).map((c) => c.id)).toEqual(conversationsOf(first).map((c) => c.id))
    // A reply that comes in after the owner's send moves nothing: the list is by the send.
    g.add({
      id: 'late',
      threadId: `ts${QUEUE_PAGE + 10}`,
      from: 'P Late <p210@example.com>',
      subject: 'Re: Sent 210',
      body: 'Thanks',
      at: T + 60_000,
      labels: ['INBOX', 'UNREAD'],
    })
    expect((await h.push()).status).toBe(204)
    await h.drain()
    const after = unwrap(await h.space().people(a, { sent: true, through: first.floor as string, older: true }))
    expect(conversationsOf(after).map((c) => c.id)).toEqual(all.map((c) => c.id))
  })
})

describe('what the door takes', () => {
  test('a position is the text an answer gave; anything else is refused, and older goes with a position', async () => {
    const w = await big()
    const space = w.h.space()
    for (const scope of [
      { through: 'not a position' },
      { through: 7 as never },
      { through: '2026-11-10T12:00:00.000Z|1;drop', older: true },
      { older: true },
      { through: '2026-11-10T12:00:00.000Z|1', older: 'yes' as never },
      { mailbox: '../../x' },
      { mailbox: 7 as never },
      { client: 0 },
      { client: 1.5 },
      { unread: 'yes' as never },
    ] as InboxScope[]) {
      const r = await space.people(w.a, scope)
      expect([JSON.stringify(scope), r.ok]).toEqual([JSON.stringify(scope), false])
    }
  })

  test('a position with a person’s own lists is ignored: their history is not cut by a screen', async () => {
    const w = await big()
    const first = await people(w)
    const cora = (
      w.h.db.query(`SELECT contact_id FROM identity WHERE address = 'cora@acme.example'`).get() as {
        contact_id: string
      }
    ).contact_id
    const one = await people(w, { contactIds: [cora], through: first.floor as string, older: true })
    expect(one.people.map((p) => p.name)).toEqual(['Cora Lund'])
  })
})
