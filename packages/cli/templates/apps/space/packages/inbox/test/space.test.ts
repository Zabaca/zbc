import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ANSWER_WITHIN_MS,
  COMPOSE_KEY_KEPT_MS,
  type DraftAuthor as ContractDraftAuthor,
  createInstall,
  INBOX_BOOKMARK,
  INBOX_FOR_SPACE_METHODS,
  INBOX_HISTORY_PAGE,
  INBOX_MOST_MARKS,
  type InboxForSpace,
  type InboxSend,
  type MailKind,
  SNIPPET_CHARS,
  WRITE_WITHIN_MS,
} from '@space/workspace'
import { INBOX_COUNTED } from '../src/counts'
import { GmailError } from '../src/gmail/google'
import { readText, viaGmail } from '../src/read'
import { EXCERPT_CHARS } from '../src/search'
import { copiedTo } from '../src/space'
import type { DraftAuthor, IdentityKind } from '../src/types'
import { AGENT, asHttp, asker, harness, OWNER, ownerDraft, RIDGEWAY, STRANGER, T0 } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * What the inbox answers the space, driven as the space drives it: through `InboxForSpace` (src/space.ts, which the Worker's
 * space's Worker calls in-process), with the person the space's check named, over the real store and the real
 * Mailroom with a Google that can fail. What these cannot show is the runtime: that the Durable Object is a real binding to a class
 * another Worker owns (the transfer) and structured-clones these answers. That is the check after the deploy (docs/runbooks/inbox-space.md).
 *
 * The fixtures hold what must appear (an open conversation of every mailbox, shared threads under each person on them) and
 * what must not (Bulk mail and closed conversations unless asked for, another person's mail in a person's history, anything at
 * all for an asker who is not the inbox's owner).
 */

type H = ReturnType<typeof harness>

const assertion = (who: Record<string, unknown> = OWNER) => asker(who)

const hours = (n: number) => n * 3_600_000
const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}

/** A mail Cloudflare hands the Worker for Ridgeway's mailbox. */
const ridgewayMail = (id: string, name: string, from: string, subject: string, body: string) =>
  `Return-Path: <${from}>\nMIME-Version: 1.0\nFrom: ${name} <${from}>\nDate: Mon, 26 Oct 2026 13:00:00 -0700\nMessage-ID: <${id}@example.org>\nSubject: ${subject}\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\n${body}\n`

/** Gmail told the inbox of whatever just happened in it, and the alarm ran. */
async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
}

/**
 * The inbox of a Tuesday: Dana wrote about a quote (t1), Eli wrote a plan with Dana copied (t2, a thread shared by two people),
 * a newsletter came (t3, Bulk), Fay's old matter was archived (t4, closed), and Priya wrote to Ridgeway (its own mailbox).
 */
async function world() {
  const h = harness({}, { ai: null })
  const g = h.google.mailbox
  g.add({
    id: 'm1',
    threadId: 't1',
    from: 'Dana Smith <Dana@Example.com>',
    subject: 'Quote for the shop',
    body: 'Can you quote the shop front?',
    at: T0 - hours(5),
  })
  g.add({
    id: 'm2',
    threadId: 't2',
    from: 'Eli Park <eli@example.com>',
    cc: 'Dana Smith <dana@example.com>',
    subject: 'Shared plan',
    body: 'Here is the plan for the build, Dana is copied.',
    at: T0 - hours(3),
  })
  g.add({
    id: 'm3',
    threadId: 't3',
    from: 'Brand News <news@brand.example.com>',
    subject: 'Weekly deals',
    body: 'Ten percent off everything this week.',
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@brand.example.com>' },
    at: T0 - hours(2),
  })
  g.add({
    id: 'm4',
    threadId: 't4',
    from: 'Fay Old <fay@example.com>',
    subject: 'Old matter',
    body: 'The deed was filed in the spring.',
    at: T0 - hours(9),
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  g.labelThread('t4', { remove: ['INBOX', 'UNREAD'] })
  await hear(h)
  const arrived = await h.deliver(
    ridgewayMail('p1', 'Priya Nair', 'priya.n@example.org', 'Hours question', 'Are you open on Sundays?'),
    { from: 'priya.n@example.org', to: 'info@ridgewaycycles.example' },
  )
  expect(arrived.entered).toBe('filed')
  return h
}

const arrive = async (h: H, over: Record<string, unknown> = {}) => {
  h.google.mailbox.add({
    id: 'm1b',
    threadId: 't1',
    from: 'Dana Smith <dana@example.com>',
    subject: 'Re: Quote for the shop',
    body: 'Actually, Wednesday suits me better.',
    at: T0 - hours(1),
    ...over,
  })
  await hear(h)
}

const names = (people: { name: string }[]) => people.map((p) => p.name).sort()

describe('the inbox answers the space with the methods the contract names, and no others', () => {
  test('the harness offers exactly those', async () => {
    const h = harness()
    expect(Object.keys(h.space()).sort()).toEqual([...INBOX_FOR_SPACE_METHODS].sort())
  })
})

describe('who is asking: the person the space’s check named', () => {
  const calls = (s: InboxForSpace, a: never) => ({
    people: () => s.people(a),
    messagesWith: () => s.messagesWith(a, { address: 'dana@example.com' }),
    drafts: () => s.drafts(a),
    send: () => s.send(a, { key: 'k'.repeat(20), address: 'x@example.net', subject: 'Hi', text: 'Hello' }),
    sendFromBusinessMailbox: () =>
      s.send(a, {
        key: 'k'.repeat(20),
        address: 'x@example.net',
        subject: 'Hi',
        text: 'Hello',
        from: { kind: 'business', mailboxId: 'ridgeway' },
      }),
    editDraft: () => s.editDraft(a, { draftId: 'd', rev: 0, text: 'x' }),
    setSpam: () => s.setSpam(a, { conversationId: 'c', spam: true }),
    markRead: () => s.markRead(a, []),
    closeConversations: () => s.closeConversations(a, []),
    reopenConversations: () => s.reopenConversations(a, []),
    search: () => s.search(a, 'quote'),
  })

  test('someone Cloudflare knows who is not of this install is not-admitted, and so is a teammate: the inbox admits its owner only', async () => {
    const h = await world()
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'dana@northfield.example', name: 'Dana', role: 'owner' })
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    // The in-process part is handed the person the space's check named, who here is never Tessa: the inbox's own rule refuses each, on every method.
    for (const who of [STRANGER, { email: 'dana@northfield.example' }, { email: 'eve@northfield.example' }]) {
      const a = await assertion(who)
      for (const [method, call] of Object.entries(calls(withTeam, a as never))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason: 'not-admitted' },
        ])
      }
    }
    // And the refused asker changed nothing: no key was taken, no draft made, nothing read.
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 0 })
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE status IN ('draft', 'sending')`).get()).toEqual({ n: 0 })
    expect(h.google.mailbox.sent).toHaveLength(0)
  })
})

describe('the operator’s three, for the move of the store: the owner’s, and numbers and markers only', () => {
  test('a bookmark, a restart and the counts are the owner’s alone, and a refused asker reaches the object not at all', async () => {
    const h = await world()
    const s = h.space()
    for (const who of [STRANGER, { email: 'eve@northfield.example' }]) {
      for (const call of [s.storeBookmark(asker(who)), s.restartStore(asker(who)), s.storeCounts(asker(who))]) {
        expect(await call).toMatchObject({ ok: false, reason: 'not-admitted' })
      }
    }
    expect(h.objectCalls).toEqual([])
  })

  test('the owner reads a bookmark in Cloudflare’s shape, restarts the object (the reset under the call is the answer), and reads counts', async () => {
    const h = await world()
    const s = h.space()
    expect(unwrap(await s.storeBookmark(asker(OWNER))).bookmark).toMatch(INBOX_BOOKMARK)
    expect(unwrap(await s.restartStore(asker(OWNER)))).toEqual({ restarted: true })
    expect(h.objectCalls).toEqual(['bookmark', 'restart'])
    const { counts } = unwrap(await s.storeCounts(asker(OWNER)))
    expect(Object.keys(counts).sort()).toEqual(
      [
        ...INBOX_COUNTED.equal,
        ...INBOX_COUNTED.onlyUp,
        ...INBOX_COUNTED.movesBothWays,
        ...Object.keys(counts).filter((k) => k.startsWith('message:')),
      ].sort(),
    )
    expect(counts.mailbox).toBeGreaterThanOrEqual(2)
    expect(counts.message).toBeGreaterThan(0)
    expect(counts['message:direction:in']).toBeGreaterThan(0)
    // Numbers under names: nothing of a message, a draft or a person is in the answer.
    expect(JSON.stringify(counts)).not.toMatch(/dana|quote|@/i)
    for (const n of Object.values(counts)) expect(Number.isInteger(n) && n >= 0).toBe(true)
  })

  test('the counts follow the store: a new message raises the arrivals’ group and not the group that only Tessa’s acts change', async () => {
    const h = await world()
    const before = unwrap(await h.space().storeCounts(asker(OWNER))).counts
    await arrive(h)
    const after = unwrap(await h.space().storeCounts(asker(OWNER))).counts
    expect(after.message).toBe((before.message ?? 0) + 1)
    expect(after['message:direction:in']).toBe((before['message:direction:in'] ?? 0) + 1)
    for (const t of [...INBOX_COUNTED.equal, ...INBOX_COUNTED.equalValues])
      expect([t, after[t]]).toEqual([t, before[t]])
  })

  test('without the store’s object (a part over a bare store) the operator answers broken and does nothing', async () => {
    const h = await world()
    expect(await h.space({ object: false }).storeCounts(asker(OWNER))).toMatchObject({
      ok: false,
      kind: 'failed',
      reason: 'broken',
    })
  })
})

describe('people: the main list, and what stays out of it', () => {
  test('is the open conversations outside Bulk, of every mailbox, one entry per person, newest first', async () => {
    const h = await world()
    const { people, more } = unwrap(await h.space().people(await assertion()))
    expect(more).toBe(false)
    expect(names(people)).toEqual(['Dana Smith', 'Eli Park', 'Priya Nair'])
    // Never the newsletter (Bulk) or Fay (closed).
    expect(JSON.stringify(people)).not.toContain('news@brand.example.com')
    expect(JSON.stringify(people)).not.toContain('fay@example.com')
    const times = people.map((p) => p.newest.at)
    expect(times).toEqual([...times].sort((a, b) => b - a))

    const dana = people.find((p) => p.name === 'Dana Smith')
    expect(dana).toBeDefined()
    expect(dana?.addresses).toEqual(['dana@example.com'])
    expect(dana?.unread).toBe(2)
    expect(dana?.conversations.map((c) => c.subject)).toEqual(['Shared plan', 'Quote for the shop'])
    expect(dana?.newest).toMatchObject({
      conversationId: dana?.conversations[0]?.conversationId,
      kind: 'email',
      direction: 'in',
      subject: 'Shared plan',
    })
    expect(dana?.conversations[1]).toMatchObject({
      kind: 'email',
      direction: 'in',
      unread: true,
      open: true,
      bulk: false,
      drafts: 0,
      mailbox: { name: 'northfield', address: 'tessa@northfield.example' },
      alsoOn: [],
      snippet: 'Can you quote the shop front?',
    })
  })

  test('a thread shared by two people is under each, with who else is on it', async () => {
    const h = await world()
    const { people } = unwrap(await h.space().people(await assertion()))
    const shared = (who: string) =>
      people.find((p) => p.name === who)?.conversations.find((c) => c.subject === 'Shared plan')
    expect(shared('Eli Park')?.alsoOn).toEqual([
      {
        contactId: people.find((p) => p.name === 'Dana Smith')?.contactId as string,
        name: 'Dana Smith',
        address: 'dana@example.com',
      },
    ])
    expect(shared('Dana Smith')?.alsoOn.map((p) => [p.name, p.address])).toEqual([['Eli Park', 'eli@example.com']])
    expect(shared('Eli Park')?.conversationId).toBe(shared('Dana Smith')?.conversationId)
  })

  test('Ridgeway’s mail is in the main list with its mailbox, and Gmail’s carries its account’s pill', async () => {
    const h = await world()
    const { people } = unwrap(await h.space().people(await assertion()))
    expect(people.find((p) => p.name === 'Priya Nair')?.conversations[0]?.mailbox).toEqual({
      id: expect.any(String),
      name: RIDGEWAY.name,
      address: RIDGEWAY.address,
    })
    for (const p of people.filter((x) => x.name !== 'Priya Nair')) {
      for (const c of p.conversations)
        expect(c.mailbox).toMatchObject({ name: 'northfield', address: 'tessa@northfield.example' })
    }
  })

  test('Bulk and Closed come only when asked, each on its own', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const bulk = unwrap(await s.people(a, { include: ['bulk'] })).people
    expect(names(bulk)).toEqual(['Brand News', 'Dana Smith', 'Eli Park', 'Priya Nair'])
    expect(bulk.find((p) => p.name === 'Brand News')?.conversations[0]).toMatchObject({ bulk: true, open: true })
    const closed = unwrap(await s.people(a, { include: ['closed'] })).people
    expect(names(closed)).toEqual(['Dana Smith', 'Eli Park', 'Fay Old', 'Priya Nair'])
    expect(closed.find((p) => p.name === 'Fay Old')?.conversations[0]).toMatchObject({ open: false, unread: false })
    expect(names(unwrap(await s.people(a, { include: ['bulk', 'closed'] })).people)).toHaveLength(5)
  })

  test('asking for addresses answers those people and no one else, in any spelling, ignoring what is no address', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const one = unwrap(await s.people(a, { addresses: [' ELI@Example.com ', 'not an address', '+15551234567'] })).people
    expect(names(one)).toEqual(['Eli Park'])
    expect(unwrap(await s.people(a, { addresses: ['not an address'] })).people).toEqual([])
    // Dana's list of her conversations still carries the thread she shares with Eli, who is not an entry of his own here.
    const dana = unwrap(await s.people(a, { addresses: ['dana@example.com'] })).people
    expect(names(dana)).toEqual(['Dana Smith'])
    expect(dana[0]?.conversations).toHaveLength(2)
  })

  test('a contact under a Client carries the Client with the directory’s name, and by number when the directory is down', async () => {
    const h = await world()
    const dana = h.db.query(`SELECT contact_id AS id FROM identity WHERE address = 'dana@example.com'`).get() as {
      id: string
    }
    expect(asHttp(await h.store.call('assignClient', dana.id, 1, OWNER_EMAIL)).status).toBe(200)
    const s = h.space()
    const named = unwrap(await s.people(await assertion())).people.find((p) => p.name === 'Dana Smith')
    expect(named?.client).toEqual({ id: 1, name: expect.any(String), listed: true })
    h.directory.failure = new Error('the site is down')
    const bare = unwrap(await s.people(await assertion())).people.find((p) => p.name === 'Dana Smith')
    expect(bare?.client).toEqual({ id: 1, name: 'Client 1', listed: false })
    // Everyone else has none, and the directory is not asked when no one in an answer has a Client.
    expect(unwrap(await s.people(await assertion())).people.find((p) => p.name === 'Eli Park')?.client).toBeNull()
  })

  test('a contact with several addresses carries them all, sorted', async () => {
    const h = await world()
    const aaron = await ownerDraft(h, {
      address: 'aaron@example.com',
      subject: 'Hi',
      body: 'Hello',
    })
    const eli = h.db.query(`SELECT contact_id AS id FROM identity WHERE address = 'eli@example.com'`).get() as {
      id: string
    }
    expect(asHttp(await h.store.call('mergeContacts', eli.id, aaron.json.contactId, OWNER_EMAIL)).status).toBe(200)
    const { people } = unwrap(await h.space().people(await assertion()))
    // The absorbed address was stored after Eli's own; the answer is sorted, not in the order they were made.
    expect(people.find((p) => p.name === 'Eli Park')?.addresses).toEqual(['aaron@example.com', 'eli@example.com'])
  })

  test('a person with more conversations than a screen is cut in the list and told so, and whole in their own history', async () => {
    const h = harness({}, { ai: null })
    for (let n = 0; n < 205; n += 1) {
      h.google.mailbox.add({
        id: `c${n}`,
        threadId: `tc${n}`,
        from: 'Gus Fry <gus@example.net>',
        subject: `Thread ${n}`,
        at: T0 - hours(300) + n * 60_000,
      })
    }
    await h.connect()
    await h.drain()
    const s = h.space()
    const a = await assertion()
    const list = unwrap(await s.people(a, { addresses: ['gus@example.net'] }))
    expect(list.more).toBe(true)
    expect(list.people[0]?.conversations).toHaveLength(200)
    const history = unwrap(await s.messagesWith(a, { address: 'gus@example.net' }))
    expect(history.threads).toHaveLength(205)
    expect(history.messages).toHaveLength(INBOX_HISTORY_PAGE)
    expect(history.more).toBe(true)
  })

  test('a long message is cut to the snippet length on one line', async () => {
    const h = harness({}, { ai: null })
    h.google.mailbox.add({ id: 'm9', threadId: 't9', subject: 'Long one', body: `${'word '.repeat(80)}\n\nand more` })
    await h.connect()
    await h.drain()
    const [p] = unwrap(await h.space().people(await assertion())).people
    const snippet = p?.conversations[0]?.snippet ?? ''
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(snippet).not.toContain('\n')
  })

  test('the copies of the inbox’s own values are pinned equal', () => {
    // The contract's MailKind is a copy of the inbox's IdentityKind, and SNIPPET_CHARS of EXCERPT_CHARS: a kind added here
    // fails to typecheck, a length changed there fails here.
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
    const holds = <_T extends true>(): void => {}
    holds<Equal<MailKind, IdentityKind>>()
    // And the contract's draft authors are the inbox's.
    holds<Equal<ContractDraftAuthor, DraftAuthor>>()
    expect(SNIPPET_CHARS).toBe(EXCERPT_CHARS)
  })
})

describe('people: the Sent view (sent: true)', () => {
  const mineTo = (to: string, threadId: string) => ({
    labels: ['SENT'],
    from: 'Tessa Marlow <tessa@northfield.example>',
    to,
    threadId,
  })

  /** Dana asked, Tessa answered, and Dana wrote again after (so the thread is open and unread); Fay and Gus were only written to (filed read and closed); Eli and a newsletter only wrote. */
  async function sentWorld() {
    const h = harness({}, { ai: null })
    const g = h.google.mailbox
    g.add({
      id: 'd1',
      threadId: 'td',
      from: 'Dana Smith <dana@example.com>',
      subject: 'Quote',
      body: 'Can you quote the shop front?',
      at: T0 - hours(9),
    })
    g.add({
      id: 'd2',
      ...mineTo('dana@example.com', 'td'),
      subject: 'Re: Quote',
      body: 'Yes, forty thousand, ready in March.',
      at: T0 - hours(8),
    })
    g.add({
      id: 'd3',
      threadId: 'td',
      from: 'Dana Smith <dana@example.com>',
      subject: 'Re: Quote',
      body: 'Thanks, Wednesday suits me.',
      at: T0 - hours(1),
    })
    g.add({
      id: 'f1',
      ...mineTo('fay@example.com', 'tf'),
      subject: 'The deed',
      body: 'Filed in the spring, as we said.',
      at: T0 - hours(5),
    })
    g.add({
      id: 'e1',
      threadId: 'te',
      from: 'Eli Park <eli@example.com>',
      subject: 'Plan',
      body: 'Here is the plan.',
      at: T0 - hours(3),
    })
    g.add({
      id: 'n1',
      threadId: 'tn',
      from: 'Brand News <news@brand.example.com>',
      subject: 'Weekly deals',
      body: 'Ten percent off.',
      headers: { 'List-Unsubscribe': '<mailto:unsubscribe@brand.example.com>' },
      at: T0 - hours(2),
    })
    g.add({
      id: 'g1',
      ...mineTo('gus@example.com', 'tg'),
      subject: 'Spacing',
      body: 'First line.\n\n  Second   line.',
      at: T0 - hours(7),
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    return h
  }

  test('is every conversation Tessa sent in, open or closed, newest send first, each as of his newest sent message', async () => {
    const h = await sentWorld()
    const { people, more } = unwrap(await h.space().people(await assertion(), { sent: true }))
    expect(more).toBe(false)
    // Never Eli or the newsletter, who only wrote. Fay's and Gus's threads are closed (sent mail is filed read and closed) and are here.
    expect(people.map((p) => p.addresses[0])).toEqual(['fay@example.com', 'gus@example.com', 'dana@example.com'])
    const dana = people.find((p) => p.addresses.includes('dana@example.com'))
    // Dana wrote after Tessa answered: the line is still Tessa's answer ("You:"), at his send time, and not her newer message.
    expect(dana?.conversations).toHaveLength(1)
    expect(dana?.conversations[0]).toMatchObject({
      subject: 'Re: Quote',
      direction: 'out',
      unread: true,
      open: true,
      snippet: 'Yes, forty thousand, ready in March.',
      at: T0 - hours(8),
      listed: true,
    })
    expect(dana?.newest).toMatchObject({
      direction: 'out',
      snippet: 'Yes, forty thousand, ready in March.',
      at: T0 - hours(8),
    })
    expect(JSON.stringify(people)).not.toContain('news@brand.example.com')
    // The snippet is cut and spaced as a list line's is.
    expect(people.find((p) => p.addresses.includes('gus@example.com'))?.conversations[0]?.snippet).toBe(
      'First line. Second line.',
    )
  })

  test('sent: false or absent is the main list, and a sent that is not a boolean is refused', async () => {
    const h = await sentWorld()
    const s = h.space()
    const a = await assertion()
    const main = ['dana@example.com', 'eli@example.com']
    expect(
      unwrap(await s.people(a, { sent: false }))
        .people.map((p) => p.addresses[0])
        .sort(),
    ).toEqual(main)
    expect(
      unwrap(await s.people(a, {}))
        .people.map((p) => p.addresses[0])
        .sort(),
    ).toEqual(main)
    expect((await s.people(a, { sent: 'yes' } as never)).ok).toBe(false)
  })

  test('is cut at the newest screen of conversations, with more said', async () => {
    const h = harness({}, { ai: null })
    const g = h.google.mailbox
    for (let n = 0; n < 203; n++) {
      g.add({
        id: `s${n}`,
        ...mineTo(`p${n}@example.com`, `ts${n}`),
        subject: `Note ${n}`,
        body: `Hello ${n}`,
        at: T0 - hours(300) + n * 60_000,
      })
    }
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const { people, more } = unwrap(await h.space().people(await assertion(), { sent: true }))
    expect(more).toBe(true)
    expect(people).toHaveLength(200)
    // The newest 200 sends: the three oldest are the ones left out.
    expect(people[0]?.conversations[0]?.subject).toBe('Note 202')
    expect(people.flatMap((p) => p.conversations.map((c) => c.subject))).not.toContain('Note 2')
  })
})

describe('people: the Drafts view (drafts: true)', () => {
  test('is every conversation that holds a draft, open, closed or Bulk, and no other', async () => {
    const h = await world()
    const a = await assertion()
    const idOf = async (address: string) =>
      unwrap(await h.space().people(a, { addresses: [address], include: ['bulk', 'closed'] })).people[0]
        ?.conversations[0]?.conversationId
    for (const address of ['priya.n@example.org', 'news@brand.example.com', 'fay@example.com']) {
      const made = await ownerDraft(h, { conversationId: await idOf(address), body: `About ${address}.` })
      expect([address, made.status]).toEqual([address, 201])
    }
    const { people, more } = unwrap(await h.space().people(a, { drafts: true }))
    expect(more).toBe(false)
    // Priya's is open, the newsletter's is Bulk and Fay's is closed; Dana and Eli have no draft and are not here.
    expect(people.map((p) => p.addresses[0]).sort()).toEqual([
      'fay@example.com',
      'news@brand.example.com',
      'priya.n@example.org',
    ])
    expect(people.flatMap((p) => p.conversations.map((c) => c.drafts))).toEqual([1, 1, 1])
    // The main list, by contrast, holds neither the Bulk nor the closed one.
    expect(
      unwrap(await h.space().people(a))
        .people.map((p) => p.addresses[0])
        .sort(),
    ).not.toContain('fay@example.com')
  })

  test('finds a draft on a conversation older than the newest screen, which the other lists cut', async () => {
    const h = harness({}, { ai: null })
    const g = h.google.mailbox
    g.add({
      id: 'old',
      threadId: 'told',
      from: 'Olga Old <olga@example.com>',
      subject: 'Long ago',
      body: 'Hello.',
      at: T0 - hours(400),
    })
    for (let n = 0; n < 203; n++) {
      g.add({
        id: `n${n}`,
        threadId: `tn${n}`,
        from: `P${n} <p${n}@example.com>`,
        subject: `Note ${n}`,
        body: `Hello ${n}`,
        at: T0 - hours(300) + n * 60_000,
      })
    }
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const a = await assertion()
    const everything = { include: ['bulk', 'closed'] } as const
    const old = unwrap(await h.space().people(a, { addresses: ['olga@example.com'], ...everything })).people[0]
    const made = await ownerDraft(h, {
      conversationId: old?.conversations[0]?.conversationId,
      body: 'Sorry for the wait.',
    })
    expect([made.status, made.json]).toEqual([201, expect.anything()])
    // The lists stop at the newest screen: Olga's conversation is not in it, though it holds a draft the menu counts.
    const cut = unwrap(await h.space().people(a, everything))
    expect(cut.more).toBe(true)
    expect(cut.people.map((p) => p.addresses[0])).not.toContain('olga@example.com')
    expect(unwrap(await h.space().navigation(a)).views.drafts.count).toBe(1)
    // The Drafts view is those conversations and nothing cut: one, and no more.
    const { people, more } = unwrap(await h.space().people(a, { drafts: true }))
    expect(more).toBe(false)
    expect(people.map((p) => p.addresses[0])).toEqual(['olga@example.com'])
  })

  test('a drafts that is not a boolean is refused; false or absent is the main list', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    expect((await s.people(a, { drafts: 'yes' } as never)).ok).toBe(false)
    expect(unwrap(await s.people(a, { drafts: false })).people).toEqual(unwrap(await s.people(a)).people)
  })
})

describe('every address in an answer is in the one spelling', () => {
  test('a stored "Corin Pike <Corin@X.example.com>" comes out as corin@x.example.com, in people, shared threads, search and drafts', async () => {
    const h = await world()
    h.db.query(`UPDATE identity SET address = 'Eli Park <ELI@Example.com>' WHERE address = 'eli@example.com'`).run()
    const s = h.space()
    const a = await assertion()
    const { people } = unwrap(await s.people(a))
    const eli = people.find((p) => p.name === 'Eli Park')
    expect(eli?.addresses).toEqual(['eli@example.com'])
    const dana = people.find((p) => p.name === 'Dana Smith')
    expect(dana?.conversations[0]?.alsoOn.map((x) => x.address)).toEqual(['eli@example.com'])
    const hit = unwrap(await s.search(a, 'plan')).hits[0]
    expect(hit?.people.map((x) => x.address).sort()).toEqual(['dana@example.com', 'eli@example.com'])
    const draft = unwrap(await s.drafts(a))
    expect(draft).toEqual([])
    for (const text of [JSON.stringify(people), JSON.stringify(hit)]) {
      expect(text).not.toContain('ELI@')
      expect(text).not.toContain('Eli Park <')
    }
  })

  test('a draft’s address is spelled the same way', async () => {
    const h = await world()
    const made = await ownerDraft(h, {
      address: 'Gus Lane <GUS@Example.net>',
      subject: 'Hi',
      body: 'Hello',
    })
    expect(made.status).toBe(201)
    h.db.query(`UPDATE identity SET address = 'Gus Lane <GUS@Example.net>' WHERE address = 'gus@example.net'`).run()
    expect(unwrap(await h.space().drafts(await assertion()))[0]?.to).toBe('gus@example.net')
  })
})

describe('messagesWith: a person’s messages across their conversations', () => {
  test('are their conversations and every message on them, oldest first, as each wrote it, with who else is on the thread', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const history = unwrap(await s.messagesWith(a, { address: 'Dana@example.com' }))
    expect(history.more).toBe(false)
    expect(history.threads.map((t) => t.subject)).toEqual(['Shared plan', 'Quote for the shop'])
    expect(history.messages.map((m) => [m.subject, m.direction])).toEqual([
      ['Quote for the shop', 'in'],
      ['Shared plan', 'in'],
    ])
    // As the sender wrote it, spelling and all; Eli's message is on Dana's history because it is on her thread.
    expect(history.messages.map((m) => m.from)).toEqual(['Dana Smith <Dana@Example.com>', 'Eli Park <eli@example.com>'])
    expect(history.messages[0]).toMatchObject({ text: 'Can you quote the shop front?', textCut: false, alsoOn: [] })
    expect(history.messages[1]?.alsoOn.map((p) => p.name)).toEqual(['Eli Park'])
    expect(history.messages[0]?.at).toBe(T0 - hours(5))
    expect(history.threads[1]).toMatchObject({
      unread: true,
      open: true,
      bulk: false,
      mailbox: { name: 'northfield', address: 'tessa@northfield.example' },
      canReply: true,
      canAttach: false,
    })
    // The position a mark-read and a reply name is the store's own.
    for (const t of history.threads) {
      const row = h.db
        .query(`SELECT max(rowid) AS n FROM message WHERE conversation_id = ? AND status NOT IN ('draft', 'sending')`)
        .get(t.conversationId) as { n: number }
      expect(t.through).toBe(row.n)
    }
  })

  test('by contact id is the same answer as by address', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const { people } = unwrap(await s.people(a))
    const dana = people.find((p) => p.name === 'Dana Smith')
    expect(await s.messagesWith(a, { contactId: dana?.contactId ?? '' })).toEqual(
      await s.messagesWith(a, { address: 'dana@example.com' }),
    )
  })

  test('never holds another person’s mail, another mailbox’s, Bulk or Closed, unless asked', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const dana = JSON.stringify(unwrap(await s.messagesWith(a, { address: 'dana@example.com' })))
    for (const never of ['Priya', 'Hours question', 'Weekly deals', 'Old matter', 'Fay'])
      expect(dana).not.toContain(never)
    // Priya's is Ridgeway's, and her history is hers alone.
    const priya = unwrap(await s.messagesWith(a, { address: 'priya.n@example.org' }))
    expect(priya.threads[0]?.mailbox).toMatchObject({ address: RIDGEWAY.address })
    expect(priya.messages.map((m) => m.subject)).toEqual(['Hours question'])
    // Fay's closed conversation: nothing until asked, the whole of it when asked.
    expect(unwrap(await s.messagesWith(a, { address: 'fay@example.com' }))).toEqual({
      threads: [],
      messages: [],
      more: false,
    })
    const fay = unwrap(await s.messagesWith(a, { address: 'fay@example.com' }, { include: ['closed'] }))
    expect(fay.threads).toHaveLength(1)
    expect(fay.threads[0]).toMatchObject({ open: false })
    expect(fay.messages.map((m) => m.subject)).toEqual(['Old matter'])
    // The newsletter's, likewise.
    expect(unwrap(await s.messagesWith(a, { address: 'news@brand.example.com' })).messages).toEqual([])
    expect(
      unwrap(await s.messagesWith(a, { address: 'news@brand.example.com' }, { include: ['bulk'] })).threads[0],
    ).toMatchObject({ bulk: true })
  })

  test('refuses a person who is not there, and what is not a question', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    expect(await s.messagesWith(a, { address: 'nobody@example.com' })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await s.messagesWith(a, { contactId: 'no-such-id' })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await s.messagesWith(a, { address: 'not an address' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await s.messagesWith(a, {} as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(
      await s.messagesWith(a, { address: 'dana@example.com' }, { include: ['everything'] } as never),
    ).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await s.messagesWith(a, { address: 'dana@example.com' }, { before: 'not-a-message-here' })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
  })

  test('a page is the newest INBOX_HISTORY_PAGE messages, and before pages back without a gap or a repeat', async () => {
    const h = harness({}, { ai: null })
    for (let n = 0; n < INBOX_HISTORY_PAGE + 7; n += 1) {
      h.google.mailbox.add({
        id: `g${n}`,
        threadId: 'tg',
        from: 'Gus Fry <gus@example.net>',
        subject: 'Long thread',
        body: `message ${n}`,
        at: T0 - hours(100) + n * 60_000,
      })
    }
    // Another person's mail in between must not be counted into Gus's pages.
    h.google.mailbox.add({
      id: 'o1',
      threadId: 'to',
      from: 'Ola <ola@example.net>',
      subject: 'Elsewhere',
      at: T0 - hours(99),
    })
    await h.connect()
    await h.drain()
    const s = h.space()
    const a = await assertion()
    const first = unwrap(await s.messagesWith(a, { address: 'gus@example.net' }))
    expect(first.messages).toHaveLength(INBOX_HISTORY_PAGE)
    expect(first.more).toBe(true)
    expect(first.messages.at(-1)?.text).toBe(`message ${INBOX_HISTORY_PAGE + 6}`)
    const oldest = first.messages[0]
    const second = unwrap(await s.messagesWith(a, { address: 'gus@example.net' }, { before: oldest?.id }))
    expect(second.more).toBe(false)
    expect(second.messages).toHaveLength(7)
    const all = [...second.messages, ...first.messages].map((m) => m.text)
    expect(all).toEqual(Array.from({ length: INBOX_HISTORY_PAGE + 7 }, (_, n) => `message ${n}`))
    // A message that is not on this person's conversations is no place in their history.
    const elsewhere = h.db.query(`SELECT id FROM message WHERE subject = 'Elsewhere'`).get() as { id: string }
    expect(await s.messagesWith(a, { address: 'gus@example.net' }, { before: elsewhere.id })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
  })
})

const YAHOO_LINK =
  'https://links.example.net/app?from=signature&client=ios&campaign=mail-app&variant=static&next=https%3A%2F%2Fstore.example.net%2Fapps%2Fdetails%3Fid%3Dmail%26listing%3Dsignature'

/** A thread shaped like one that read badly in the space: a customer on Yahoo Mail and Tessa go back and forth, and her reply quotes the two before it, with Yahoo's signature. The people and the words are invented. */
const ROSA = 'Rosa Whitfield <rosa@yahoo.example>'
const FIRST = 'Is the walkthrough still happening this week? I have not heard.'
const OFFER = 'Sorry Rosa, something came up today. Could the walkthrough wait a day? Any time before noon suits me.'
const NEW_TIME = 'Thursday afternoon is open for me too.'
const REPLY = [
  'Hi Tessa, a day later is no good, we are shut for stocktaking.',
  'The sign maker is waiting on us, so what else do you have this week?',
  '',
  'Sent from Yahoo Mail for iPhone',
  `<${YAHOO_LINK}>`,
  '',
  'On Tuesday, March 10, 2026, 9:48 AM, Tessa Marlow <tessa@northfield.example> wrote:',
  '',
  `> ${NEW_TIME}`,
  '>',
  '> On Tuesday, March 10, 2026, 9:05 AM, Tessa Marlow <tessa@northfield.example> wrote:',
  '>',
  `> ${OFFER}`,
  '>',
  `>> ${FIRST}`,
  `>> <${YAHOO_LINK}>`,
].join('\n')

async function rosa() {
  const h = harness({}, { ai: null })
  const g = h.google.mailbox
  const subject = 'Sign proofs for the shop'
  const mine = { labels: ['SENT'], from: 'Tessa Marlow <tessa@northfield.example>', to: ROSA, threadId: 'tm', subject }
  g.add({ id: 'my1', threadId: 'tm', from: ROSA, subject, body: FIRST, at: T0 - hours(9) })
  g.add({ id: 'my2', ...mine, body: OFFER, at: T0 - hours(8) })
  g.add({ id: 'my3', ...mine, body: NEW_TIME, at: T0 - hours(7) })
  g.add({ id: 'my4', threadId: 'tm', from: ROSA, subject: `Re: ${subject}`, body: REPLY, at: T0 - hours(6) })
  g.add({
    id: 'my5',
    ...mine,
    subject: `Re: ${subject}`,
    body: 'Following up. Is the shop open this afternoon?',
    at: T0 - hours(5),
  })
  await h.connect()
  await h.drain()
  return h
}

describe('messagesWith: how the inbox page reads each message (read)', () => {
  test('a reply that quotes three earlier messages folds as the page folds it, and a message with no quote shows whole', async () => {
    const h = await rosa()
    const history = unwrap(await h.space().messagesWith(await assertion(), { address: 'rosa@yahoo.example' }))
    const byText = (start: string) => history.messages.find((m) => m.text.startsWith(start))
    const reply = byText('Hi Tessa, a day later is no')?.read
    // What she wrote now is above the attribution; the rest, signature link and all three quoted messages, is folded.
    expect(reply?.visible).toBe(
      [
        'Hi Tessa, a day later is no good, we are shut for stocktaking.',
        'The sign maker is waiting on us, so what else do you have this week?',
        '',
        'Sent from Yahoo Mail for iPhone',
        `<${YAHOO_LINK}>`,
      ].join('\n'),
    )
    expect(reply?.quoted.startsWith('On Tuesday, March 10, 2026, 9:48 AM')).toBe(true)
    expect(reply?.quoted).toContain(`>> ${FIRST}`)
    expect(`${reply?.visible}\n\n${reply?.quoted}`).toBe(byText('Hi Tessa, a day later is no')?.text ?? '')
    // No quote: the whole message, nothing folded.
    expect(byText('Is the walkthrough still')?.read).toEqual({ visible: FIRST, quoted: '' })
    expect(byText('Following up')?.read).toEqual({
      visible: 'Following up. Is the shop open this afternoon?',
      quoted: '',
    })
  })

  test('is what the conversation page makes of the same text: one function, with the messages before it as the proof', async () => {
    const h = await rosa()
    const history = unwrap(await h.space().messagesWith(await assertion(), { address: 'rosa@yahoo.example' }))
    for (const [i, m] of history.messages.entries()) {
      const row = h.db.query(`SELECT gmail_id, sent_by FROM message WHERE id = ?`).get(m.id) as {
        gmail_id: string | null
        sent_by: string | null
      }
      expect(m.read).toEqual(
        readText(m.text, {
          earlier: history.messages.slice(0, i).map((e) => e.text),
          subject: m.subject,
          viaGmail: viaGmail({ gmailId: row.gmail_id, sentBy: row.sent_by }),
        }),
      )
    }
  })

  test('folds a quote whose proof is on an older page, as it does when the whole thread is on one', async () => {
    const h = harness({}, { ai: null })
    const opening = 'Could you quote the shop front, the side door and the sign above it, and say when you could start?'
    h.google.mailbox.add({
      id: 'p0',
      threadId: 'tp',
      from: 'Gus Fry <gus@example.net>',
      subject: 'Quote',
      body: opening,
      at: T0 - hours(100),
    })
    for (let n = 1; n <= INBOX_HISTORY_PAGE + 2; n += 1) {
      h.google.mailbox.add({
        id: `p${n}`,
        threadId: 'tp',
        from: 'Gus Fry <gus@example.net>',
        subject: 'Re: Quote',
        body: `Filler ${n}`,
        at: T0 - hours(100) + n * 60_000,
      })
    }
    const reply = `Thanks, Wednesday is fine.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Gus Fry <gus@example.net> wrote:\n\n> ${opening}`
    h.google.mailbox.add({
      id: 'pz',
      threadId: 'tp',
      from: 'Gus Fry <gus@example.net>',
      subject: 'Re: Quote',
      body: reply,
      at: T0 - hours(1),
    })
    await h.connect()
    await h.drain()
    const first = unwrap(await h.space().messagesWith(await assertion(), { address: 'gus@example.net' }))
    // The opening message is not on this page, and the reply that quotes it still folds.
    expect(first.messages.some((m) => m.text === opening)).toBe(false)
    expect(first.messages.at(-1)?.read).toEqual({
      visible: 'Thanks, Wednesday is fine.',
      quoted: `On Mon, Oct 26, 2026 at 9:00 AM Gus Fry <gus@example.net> wrote:\n\n> ${opening}`,
    })
  })

  test('an outgoing message says who it went to; a message received does not', async () => {
    const h = await rosa()
    const history = unwrap(await h.space().messagesWith(await assertion(), { address: 'rosa@yahoo.example' }))
    for (const m of history.messages) {
      if (m.direction === 'out') expect(m.to).toContain('rosa@yahoo.example')
      else expect(m.to).toBeUndefined()
    }
  })
})

describe('drafts', () => {
  test('are everything waiting for Tessa, newest first, by who wrote it, with the revision a send names and no position', async () => {
    const h = await world()
    const dana = h.db.query(`SELECT id FROM conversation ORDER BY rowid LIMIT 1`).get() as { id: string }
    const theirs = await ownerDraft(h, { conversationId: dana.id, body: 'Tuesday works.' })
    h.tick()
    const claude = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Nice to meet you.',
      why: 'He asked for an introduction.',
    })
    expect([theirs.status, claude.status]).toEqual([201, 201])
    const list = unwrap(await h.space().drafts(await assertion()))
    expect(list.map((d) => [d.id, d.author, d.stuck, d.rev])).toEqual([
      [claude.json.id, 'claude', false, 0],
      [theirs.json.id, 'owner', false, 0],
    ])
    expect(list[0]).toMatchObject({
      conversationId: null,
      to: 'gus@example.net',
      toName: 'gus@example.net',
      subject: 'Intro',
      text: 'Nice to meet you.',
    })
    expect(list[1]).toMatchObject({ conversationId: dana.id })
    expect(list.map((d) => 'through' in d)).toEqual([false, false])
    expect(list.map((d) => d.cc)).toEqual([[], []])
  })

  test('name everyone a draft copies, with their addresses, so a send as it stands reaches no one the person was not shown', async () => {
    const h = await world()
    const people = unwrap(await h.space().people(await assertion())).people
    const shared = people.find((p) => p.name === 'Eli Park')?.conversations.find((c) => c.subject === 'Shared plan')
    const draft = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: shared?.conversationId,
      body: 'Thanks both, Friday it is.',
      why: 'Reply to the thread.',
      copyEveryone: true,
    })
    expect(draft.status).toBe(201)
    const [listed] = unwrap(await h.space().drafts(await assertion()))
    expect(listed).toMatchObject({ id: draft.json.id, to: 'eli@example.com', toName: 'Eli Park' })
    // The Cc the inbox's own page would show on this draft: Dana, by the name the inbox knows her by.
    expect(listed?.cc).toEqual([{ name: 'Dana Smith', address: 'dana@example.com' }])
    expect(draft.json.cc).toBe('dana@example.com')
  })
})

describe('a draft’s Cc as the people it copies', () => {
  const known = async (address: string) => (address === 'dana@example.com' ? 'Dana Smith' : null)

  test('is each address once, in order, named by the header, else by the inbox, else by the address', async () => {
    expect(
      await copiedTo('dana@example.com, Pat Lane <PAT@X.example.com>, "Smith, Al" <al@y.example.org>, nobody@z.example.net', known),
    ).toEqual([
      { name: 'Dana Smith', address: 'dana@example.com' },
      { name: 'Pat Lane', address: 'pat@x.example.com' },
      { name: 'Smith, Al', address: 'al@y.example.org' },
      { name: 'nobody@z.example.net', address: 'nobody@z.example.net' },
    ])
  })

  test('is empty for no Cc, and never drops an entry that is not an address: it is shown as written', async () => {
    expect(await copiedTo('', known)).toEqual([])
    expect(await copiedTo(' , ', known)).toEqual([])
    expect(await copiedTo('the team', known)).toEqual([{ name: 'the team', address: 'the team' }])
  })
})

describe('markRead', () => {
  test('marks the conversation read in Gmail, as the page does, at the position the caller read to', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const t = unwrap(await s.messagesWith(a, { address: 'dana@example.com' })).threads.find(
      (x) => x.subject === 'Quote for the shop',
    )
    expect(h.google.mailbox.messages.get('m1')?.labelIds).toContain('UNREAD')
    const result = unwrap(await s.markRead(a, [{ conversationId: t?.conversationId ?? '', through: t?.through ?? 0 }]))
    expect(result).toEqual({ read: [t?.conversationId as string], notRead: [] })
    expect(h.google.mailbox.messages.get('m1')?.labelIds).not.toContain('UNREAD')
    expect(h.google.count('thread-read')).toBe(1)
    // Idempotent: again is marking it once, and asks Gmail for nothing.
    expect(
      unwrap(await s.markRead(a, [{ conversationId: t?.conversationId ?? '', through: t?.through ?? 0 }])).read,
    ).toHaveLength(1)
    expect(h.google.count('thread-read')).toBe(1)
    const after = unwrap(await s.people(a)).people.find((p) => p.name === 'Dana Smith')
    expect(after?.unread).toBe(1)
  })

  test('refuses what was not seen: mail that arrived after the position read to is a conflict and nothing is changed anywhere', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const t = unwrap(await s.messagesWith(a, { address: 'dana@example.com' })).threads.find(
      (x) => x.subject === 'Quote for the shop',
    )
    await arrive(h)
    const result = unwrap(await s.markRead(a, [{ conversationId: t?.conversationId ?? '', through: t?.through ?? 0 }]))
    expect(result.read).toEqual([])
    expect(result.notRead).toEqual([
      {
        conversationId: t?.conversationId as string,
        outcome: expect.objectContaining({ ok: false, kind: 'refused', reason: 'conflict' }),
      },
    ])
    expect(h.google.mailbox.messages.get('m1')?.labelIds).toContain('UNREAD')
    expect(h.google.count('thread-read')).toBe(0)
  })

  test('answers each one by itself: a missing one, a position past the end and a Gmail that refuses do not fail the rest', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const { threads } = unwrap(await s.messagesWith(a, { address: 'dana@example.com' }))
    const [shared, quote] = [threads[0], threads[1]]
    const past = await s.markRead(a, [
      { conversationId: 'no-such-conversation', through: 1 },
      { conversationId: quote?.conversationId ?? '', through: (quote?.through ?? 0) + 500 },
    ])
    expect(unwrap(past).notRead.map((n) => n.outcome)).toEqual([
      expect.objectContaining({ kind: 'refused', reason: 'not-found' }),
      expect.objectContaining({ kind: 'refused', reason: 'bad-request' }),
    ])
    h.google.failNext('thread-read', new GmailError('Gmail is having trouble', 500))
    const mixed = unwrap(
      await s.markRead(a, [
        { conversationId: shared?.conversationId ?? '', through: shared?.through ?? 0 },
        { conversationId: quote?.conversationId ?? '', through: quote?.through ?? 0 },
      ]),
    )
    expect(mixed.notRead).toEqual([
      {
        conversationId: shared?.conversationId as string,
        outcome: expect.objectContaining({ ok: false, kind: 'failed', reason: 'broken' }),
      },
    ])
    expect(mixed.read).toEqual([quote?.conversationId as string])
  })

  test('is not a question: a mark without a position, or a list too long, is bad-request and nothing is touched', async () => {
    const h = await world()
    const a = await assertion()
    expect(await h.space().markRead(a, [{ conversationId: 'x' } as never])).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().markRead(a, 'all' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.google.count('thread-read')).toBe(0)
  })
})

describe('closeConversations and reopenConversations', () => {
  const quoteThread = async (h: H) => {
    const t = unwrap(await h.space().messagesWith(await assertion(), { address: 'dana@example.com' })).threads.find(
      (x) => x.subject.endsWith('Quote for the shop'),
    )
    expect(t).toBeDefined()
    return { conversationId: t?.conversationId ?? '', through: t?.through ?? 0 }
  }
  const dana = async (h: H, include?: ('closed' | 'bulk')[]) =>
    unwrap(await h.space().people(await assertion(), { include })).people.find((p) => p.name === 'Dana Smith')

  test('closes the conversation in Gmail, as the inbox’s Close does, at the position the caller read to; it leaves the main list and is under Closed', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const mark = await quoteThread(h)
    expect(h.google.mailbox.messages.get('m1')?.labelIds).toContain('INBOX')
    expect(unwrap(await s.closeConversations(a, [mark]))).toEqual({ closed: [mark.conversationId], notClosed: [] })
    expect(h.google.mailbox.messages.get('m1')?.labelIds).not.toContain('INBOX')
    expect(h.google.count('thread-close')).toBe(1)
    // The main list no longer holds it (Dana still has the shared plan); Closed does.
    expect((await dana(h))?.conversations.map((c) => c.subject)).toEqual(['Shared plan'])
    const closed = unwrap(await s.people(a, { include: ['closed'] })).people.find((p) => p.name === 'Dana Smith')
    expect(closed?.conversations.find((c) => c.conversationId === mark.conversationId)).toMatchObject({ open: false })
    // Idempotent: again is closing it once, and asks Gmail for nothing.
    expect(unwrap(await s.closeConversations(a, [mark])).closed).toEqual([mark.conversationId])
    expect(h.google.count('thread-close')).toBe(1)
  })

  test('refuses what was not seen: mail that arrived after the position read to is a conflict, and nothing is archived anywhere', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const mark = await quoteThread(h)
    await arrive(h)
    const result = unwrap(await s.closeConversations(a, [mark]))
    expect(result.closed).toEqual([])
    expect(result.notClosed).toEqual([
      {
        conversationId: mark.conversationId,
        outcome: expect.objectContaining({ ok: false, kind: 'refused', reason: 'conflict' }),
      },
    ])
    expect(h.google.mailbox.messages.get('m1')?.labelIds).toContain('INBOX')
    expect(h.google.count('thread-close')).toBe(0)
    // Read again at its new position, it closes.
    const again = await quoteThread(h)
    expect(unwrap(await s.closeConversations(a, [again])).closed).toEqual([mark.conversationId])
  })

  test('answers each one by itself: a missing one, a position past the end and a Gmail that refuses do not fail the rest', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const { threads } = unwrap(await s.messagesWith(a, { address: 'dana@example.com' }))
    const [shared, quote] = [threads[0], threads[1]]
    const past = unwrap(
      await s.closeConversations(a, [
        { conversationId: 'no-such-conversation', through: 1 },
        { conversationId: quote?.conversationId ?? '', through: (quote?.through ?? 0) + 500 },
      ]),
    )
    expect(past.notClosed.map((n) => n.outcome)).toEqual([
      expect.objectContaining({ kind: 'refused', reason: 'not-found' }),
      expect.objectContaining({ kind: 'refused', reason: 'bad-request' }),
    ])
    h.google.failNext('thread-close', new GmailError('Gmail is having trouble', 500))
    const mixed = unwrap(
      await s.closeConversations(a, [
        { conversationId: shared?.conversationId ?? '', through: shared?.through ?? 0 },
        { conversationId: quote?.conversationId ?? '', through: quote?.through ?? 0 },
      ]),
    )
    expect(mixed.notClosed).toEqual([
      {
        conversationId: shared?.conversationId as string,
        outcome: expect.objectContaining({ ok: false, kind: 'failed', reason: 'broken' }),
      },
    ])
    expect(mixed.closed).toEqual([quote?.conversationId as string])
  })

  test('reopen puts it back in Gmail’s Inbox and on the main list, and needs no position', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const mark = await quoteThread(h)
    unwrap(await s.closeConversations(a, [mark]))
    expect(unwrap(await s.reopenConversations(a, [mark.conversationId]))).toEqual({
      reopened: [mark.conversationId],
      notReopened: [],
    })
    expect(h.google.mailbox.messages.get('m1')?.labelIds).toContain('INBOX')
    expect((await dana(h))?.conversations.map((c) => c.subject)).toEqual(['Shared plan', 'Quote for the shop'])
    // A conversation that is not there is a refusal for that one alone.
    const mixed = unwrap(await s.reopenConversations(a, ['no-such-conversation', mark.conversationId]))
    expect(mixed.reopened).toEqual([mark.conversationId])
    expect(mixed.notReopened).toEqual([
      {
        conversationId: 'no-such-conversation',
        outcome: expect.objectContaining({ kind: 'refused', reason: 'not-found' }),
      },
    ])
  })

  test('closes a conversation in a business mailbox by its stamps, with the same guard', async () => {
    const h = await world()
    const s = h.space()
    const a = await assertion()
    const priya = unwrap(await s.people(a)).people.find((p) => p.name === 'Priya Nair')
    const line = priya?.conversations[0]
    const t = unwrap(await s.messagesWith(a, { address: 'priya.n@example.org' })).threads[0]
    expect(line?.open).toBe(true)
    expect(
      unwrap(await s.closeConversations(a, [{ conversationId: t?.conversationId ?? '', through: t?.through ?? 0 }]))
        .closed,
    ).toEqual([t?.conversationId as string])
    expect(unwrap(await s.people(a)).people.find((p) => p.name === 'Priya Nair')).toBeUndefined()
    expect(unwrap(await s.reopenConversations(a, [t?.conversationId ?? ''])).reopened).toHaveLength(1)
    expect(unwrap(await s.people(a)).people.find((p) => p.name === 'Priya Nair')).toBeDefined()
  })

  test('is not a question: a bad id, a missing position, or a list too long is bad-request and nothing is touched', async () => {
    const h = await world()
    const a = await assertion()
    const s = h.space()
    expect(await s.closeConversations(a, [{ conversationId: 'x' } as never])).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await s.closeConversations(a, [{ conversationId: '../x', through: 1 }])).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await s.closeConversations(a, 'all' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await s.reopenConversations(a, [3] as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await s.reopenConversations(a, 'all' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    // One more than the contract's limit is refused before anything is asked of Gmail.
    const mark = await quoteThread(h)
    const many = Array.from({ length: INBOX_MOST_MARKS + 1 }, () => mark)
    expect(await s.closeConversations(a, many)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(
      await s.reopenConversations(
        a,
        many.map((m) => m.conversationId),
      ),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.google.count('thread-close')).toBe(0)
    expect(h.google.count('thread-reopen')).toBe(0)
  })
})

describe('search', () => {
  test('is the inbox’s own: open and closed, Bulk or not, with the line that matched, and it never asks Gmail', async () => {
    const h = await world()
    const calls = h.google.calls.length
    const s = h.space()
    const a = await assertion()
    const found = unwrap(await s.search(a, 'deed'))
    expect(found.terms).toEqual(['deed'])
    expect(found.more).toBe(false)
    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]).toMatchObject({
      subject: 'Old matter',
      kind: 'email',
      open: false,
      bulk: false,
      mailbox: { name: 'northfield', address: 'tessa@northfield.example' },
    })
    expect(found.hits[0]?.match).toContain('deed')
    expect(found.hits[0]?.people.map((p) => p.name)).toEqual(['Fay Old'])
    expect(unwrap(await s.search(a, 'percent')).hits[0]).toMatchObject({ subject: 'Weekly deals', bulk: true })
    expect(unwrap(await s.search(a, 'sundays')).hits[0]?.mailbox).toMatchObject({ address: RIDGEWAY.address })
    expect(unwrap(await s.search(a, 'plan dana')).hits.map((x) => x.subject)).toEqual(['Shared plan'])
    expect(h.google.calls).toHaveLength(calls)
  })

  test('a query with no words is an empty answer, not an error', async () => {
    const h = await world()
    expect(unwrap(await h.space().search(await assertion(), '   '))).toEqual({ terms: [], hits: [], more: false })
    expect(unwrap(await h.space().search(await assertion(), 5 as never))).toEqual({ terms: [], hits: [], more: false })
  })
})

// ── send ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const throughOf = async (h: H, address = 'dana@example.com') => {
  const history = unwrap(await h.space().messagesWith(await assertion(), { address }))
  return history.threads.find((t) => t.subject.includes('Quote for the shop'))
}
const pending = (h: H) =>
  (h.db.query(`SELECT count(*) AS n FROM message WHERE status IN ('draft', 'sending')`).get() as { n: number }).n
const messages = (h: H) => (h.db.query(`SELECT count(*) AS n FROM message`).get() as { n: number }).n

interface Variant {
  name: string
  /** The send as the space first makes it. */
  build: (h: H, key: string) => Promise<InboxSend>
  /** A first use the inbox refuses, and the same compose pressed again once what was wrong is put right. */
  refusal: (h: H, send: InboxSend) => Promise<{ first: InboxSend; retry: InboxSend; reason: string }>
}

const variants: Variant[] = [
  {
    name: 'a draft the inbox already holds',
    build: async (h, key) => {
      const t = await throughOf(h)
      const made = await ownerDraft(h, {
        conversationId: t?.conversationId as string,
        body: 'Wednesday it is.',
      })
      expect(made.status).toBe(201)
      return { key, draftId: made.json.id, rev: made.json.rev, through: t?.through ?? 0 }
    },
    refusal: async (_h, send) => ({
      first: { ...send, rev: (send as { rev: number }).rev + 1 } as InboxSend,
      retry: send,
      reason: 'conflict',
    }),
  },
  {
    name: 'a reply in a thread',
    build: async (h, key) => {
      const t = await throughOf(h)
      return { key, conversationId: t?.conversationId ?? '', through: t?.through ?? 0, text: 'Wednesday it is.' }
    },
    refusal: async (h, send) => {
      await arrive(h)
      const t = await throughOf(h)
      return { first: send, retry: { ...send, through: t?.through ?? 0 } as InboxSend, reason: 'conflict' }
    },
  },
  {
    name: 'a new email',
    build: async (_h, key) => ({
      key,
      address: 'New Person <NEW@Example.net>',
      name: 'New Person',
      subject: 'Hello',
      text: 'Nice to meet you.',
    }),
    refusal: async (_h, send) => ({ first: { ...send, subject: '' } as InboxSend, retry: send, reason: 'bad-request' }),
  },
]

describe.each(variants)('send: $name', (variant) => {
  test('is Tessa pressing Send: the email goes out as him, once, and the answer says where', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(1))
    const reply = await h.space().send(await assertion(), send)
    const sent = unwrap(reply)
    expect(sent.status).toBe('sent')
    expect(sent.messageId).not.toBe('')
    expect(sent.conversationId).not.toBe('')
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(h.google.mailbox.sent[0]?.headers.From).toContain('tessa@northfield.example')
    // Filed as Tessa's: by the owner, with no instruction (an instruction is Claude's), and Claude's switch was never involved.
    const row = h.db
      .query(`SELECT status, sent_by, instruction_text FROM message WHERE id = ?`)
      .get(sent.messageId) as Record<string, unknown>
    expect(row).toEqual({ status: 'sent', sent_by: 'tessa@northfield.example', instruction_text: null })
    expect(h.db.query(`SELECT actor FROM audit WHERE action = 'message.sending'`).all()).toEqual([
      { actor: 'tessa@northfield.example' },
    ])
    expect(pending(h)).toBe(0)
  })

  test('a second use of the key answers Repeated with the first answer, and sends and makes nothing new', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(2))
    const first = unwrap(await h.space().send(await assertion(), send))
    const rows = messages(h)
    for (let n = 0; n < 2; n += 1) {
      const again = await h.space().send(await assertion(), send)
      expect(again).toMatchObject({
        ok: false,
        kind: 'refused',
        reason: 'repeated',
        earlier: { state: 'done', reply: { ok: true, value: first } },
      })
    }
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(messages(h)).toBe(rows)
  })

  test('a refused first use releases the key: the same compose, put right, sends, and no draft is left behind', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(3))
    const { first, retry, reason } = await variant.refusal(h, send)
    const rows = messages(h)
    const refusedAt = await h.space().send(await assertion(), first)
    expect(refusedAt).toMatchObject({ ok: false, kind: 'refused', reason })
    expect(refusedAt).not.toMatchObject({ reason: 'repeated' })
    expect(h.google.mailbox.sent).toHaveLength(0)
    // Nothing the space made is left in Drafts, where it could be sent a second time; a draft the inbox already held stays.
    expect(pending(h)).toBe(variant.name.startsWith('a draft') ? 1 : 0)
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 0 })
    expect(messages(h)).toBe(rows)

    const sent = unwrap(await h.space().send(await assertion(), retry))
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(pending(h)).toBe(0)
  })

  test('a first use that failed with nothing sent releases the key too: the same compose sends', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(4))
    h.google.failNext('send', new GmailError('Gmail is having trouble', 503))
    const broken = await h.space().send(await assertion(), send)
    expect(broken).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(pending(h)).toBe(variant.name.startsWith('a draft') ? 1 : 0)
    const sent = unwrap(await h.space().send(await assertion(), send))
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(pending(h)).toBe(0)
  })

  test('when Gmail never says, the answer is a success with status sending, the key stays held, and nothing is sent again', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(5))
    h.google.loseSendAnswer = true
    const unsure = unwrap(await h.space().send(await assertion(), send))
    expect(unsure.status).toBe('sending')
    expect(unsure.messageId).not.toBe('')
    expect(h.google.mailbox.sent).toHaveLength(1)
    const again = await h.space().send(await assertion(), send)
    expect(again).toMatchObject({ reason: 'repeated', earlier: { state: 'done', reply: { ok: true, value: unsure } } })
    expect(h.google.mailbox.sent).toHaveLength(1)
    // It waits, stuck, for Tessa to say whether it went out; the space lists it so.
    expect(
      unwrap(await h.space().drafts(await assertion()))
        .filter((d) => d.stuck)
        .map((d) => d.id),
    ).toEqual([unsure.messageId])
  })

  test('a repeat that arrives while the first still waits on Gmail is in progress, and sends nothing; the first then completes', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(6))
    let open = () => {}
    h.google.sendGate = new Promise<void>((resolve) => {
      open = resolve
    })
    const first = h.space().send(await assertion(), send)
    while (h.google.count('send') === 0) await Bun.sleep(1)
    const second = await h.space().send(await assertion(), send)
    expect(second).toMatchObject({ ok: false, reason: 'repeated', earlier: { state: 'in-progress' } })
    open()
    expect(unwrap(await first).status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'done' },
    })
  })

  test('a send slower than the space’s read wait still completes and answers; only a record older than the write wait ends as sending', async () => {
    const h = await world()
    const send = await variant.build(h, KEY(7))
    let open = () => {}
    h.google.sendGate = new Promise<void>((resolve) => {
      open = resolve
    })
    const first = h.space().send(await assertion(), send)
    while (h.google.count('send') === 0) await Bun.sleep(1)

    // Past the 4 seconds the space waits for a read: the send is simply still going.
    h.tick(ANSWER_WITHIN_MS + 1000)
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'in-progress' },
    })

    // Past the write wait the first use is taken as lost: done, with the inbox's own "sending", naming the draft it made.
    h.tick(WRITE_WITHIN_MS)
    const ended = await h.space().send(await assertion(), send)
    expect(ended).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'done', reply: { ok: true, value: { status: 'sending' } } },
    })
    expect(h.google.mailbox.sent).toHaveLength(1)

    // And the first, which was not lost, still answers; the key then holds the truth.
    open()
    const sent = unwrap(await first)
    expect(sent.status).toBe('sent')
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'done', reply: { ok: true, value: sent } },
    })
    expect(h.google.mailbox.sent).toHaveLength(1)
  })
})

describe('send: the rest of the rules', () => {
  test('a first use lost before it answered (the Worker died holding the key) ends as sending after the write wait, and sends nothing', async () => {
    const h = await world()
    expect(await h.store.call('claimCompose', KEY(8))).toEqual({ kind: 'claimed' })
    const send = { key: KEY(8), address: 'a@example.net', subject: 'Hi', text: 'Hello' }
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'in-progress' },
    })
    h.tick(WRITE_WITHIN_MS + 1)
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'done', reply: { ok: true, value: { status: 'sending' } } },
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('a key is remembered for at least a day', async () => {
    const h = await world()
    const sent = unwrap(
      await h.space().send(await assertion(), { key: KEY(9), address: 'a@example.net', subject: 'Hi', text: 'Hello' }),
    )
    h.tick(COMPOSE_KEY_KEPT_MS)
    expect(
      await h.space().send(await assertion(), { key: KEY(9), address: 'a@example.net', subject: 'Hi', text: 'Hello' }),
    ).toMatchObject({
      reason: 'repeated',
      earlier: { reply: { value: sent } },
    })
    expect(h.google.mailbox.sent).toHaveLength(1)
  })

  test('three presses together with one key send once: the others are told it is in progress while the first is still with Gmail', async () => {
    const h = await world()
    const send = { key: KEY(10), address: 'a@example.net', subject: 'Hi', text: 'Hello' }
    const a = await assertion()
    let open = () => {}
    h.google.sendGate = new Promise<void>((resolve) => {
      open = resolve
    })
    const all = [h.space().send(a, send), h.space().send(a, send), h.space().send(a, send)]
    // Two of them answer while the third is still waiting on Gmail: they overlapped it, and none made a second send.
    const early = await Promise.race([
      Promise.all(all.map((p) => p.then((r) => r))).then(() => 'all'),
      (async () => {
        while (h.google.count('send') === 0) await Bun.sleep(1)
        await Bun.sleep(50)
        return 'waiting'
      })(),
    ])
    expect(early).toBe('waiting')
    open()
    const replies = await Promise.all(all)
    expect(replies.filter((r) => r.ok)).toHaveLength(1)
    const repeats = replies.filter((r) => !r.ok && r.reason === 'repeated')
    expect(repeats).toHaveLength(2)
    expect(repeats.every((r) => !r.ok && 'earlier' in r && r.earlier.state === 'in-progress')).toBe(true)
    expect(h.google.mailbox.sent).toHaveLength(1)
  })

  test('a first use queued behind a slow send, ended as sending for a repeat, and then refused releases the key: the first use is the authority', async () => {
    const h = await world()
    const a = await assertion()
    let open = () => {}
    h.google.sendGate = new Promise<void>((resolve) => {
      open = resolve
    })
    // Another message is with Gmail, and holds the Mailroom.
    const slow = h.space().send(a, { key: KEY(30), address: 'slow@example.net', subject: 'Slow', text: 'Hello' })
    while (h.google.count('send') === 0) await Bun.sleep(1)

    // The send under test names a stale revision of its draft, so it is refused when the Mailroom gets to it.
    const t = await throughOf(h)
    const made = await ownerDraft(h, {
      conversationId: t?.conversationId,
      body: 'Wednesday it is.',
    })
    const stale = { key: KEY(31), draftId: made.json.id, rev: made.json.rev + 1, through: t?.through ?? 0 }
    const first = h.space().send(a, stale)
    const claimed = () =>
      (h.db.query(`SELECT count(*) AS n FROM setting WHERE key = ?`).get(`compose:${stale.key}`) as { n: number }).n
    while (claimed() === 0) await Bun.sleep(1)

    // It waits past the write wait, and a repeat is told what the record can say: sending, check Gmail Sent.
    h.tick(WRITE_WITHIN_MS + 1000)
    expect(await h.space().send(a, stale)).toMatchObject({
      reason: 'repeated',
      earlier: { state: 'done', reply: { ok: true, value: { status: 'sending' } } },
    })

    // Then the Mailroom reaches it and refuses: nothing went out, so the key is free, whatever the repeat was told.
    open()
    expect(unwrap(await slow).status).toBe('sent')
    expect(await first).toMatchObject({ ok: false, kind: 'refused', reason: 'conflict' })
    expect(claimed()).toBe(0)
    expect(pending(h)).toBe(1) // Tessa's own draft, which the space did not make, is still his

    const sent = unwrap(await h.space().send(a, { ...stale, rev: made.json.rev }))
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(2)
  })

  test('the draft of a send is made and noted on the key in one step: a lost Worker leaves no orphan draft and no key that cannot name its draft', async () => {
    const h = await world()
    const input = { address: 'a@example.net', subject: 'Hi', body: 'Hello' }
    const owner = 'tessa@northfield.example'
    // A key nobody claimed makes no draft.
    expect(await h.store.call('createComposeDraft', KEY(32), input, owner)).toMatchObject({ ok: false, status: 409 })
    expect(pending(h)).toBe(0)
    // A draft the store refuses is made nowhere and noted nowhere.
    await h.store.call('claimCompose', KEY(33))
    expect(await h.store.call('createComposeDraft', KEY(33), { ...input, body: '' }, owner)).toMatchObject({
      ok: false,
    })
    expect(pending(h)).toBe(0)
    // A draft that is made is on the key as it exists: the Worker is lost here, before it sent anything.
    const made = await h.store.call('createComposeDraft', KEY(33), input, owner)
    expect(made.ok).toBe(true)
    expect(pending(h)).toBe(1)
    h.tick(WRITE_WITHIN_MS + 1)
    expect(
      await h
        .space()
        .send(await assertion(), { key: KEY(33), ...{ address: 'a@example.net', subject: 'Hi', text: 'Hello' } }),
    ).toMatchObject({
      reason: 'repeated',
      earlier: {
        state: 'done',
        reply: { ok: true, value: { status: 'sending', messageId: made.ok ? made.value.id : '' } },
      },
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('is refused for a key of the wrong shape or a send that is not one, before anything is taken or made', async () => {
    const h = await world()
    const a = await assertion()
    for (const bad of [
      { key: 'short', address: 'a@example.net', subject: 'Hi', text: 'Hello' },
      { key: 'has spaces in it, so no', address: 'a@example.net', subject: 'Hi', text: 'Hello' },
      { key: KEY(11), address: 'not an address', subject: 'Hi', text: 'Hello' },
      { key: KEY(11), address: 'a@example.net', subject: 'Hi' },
      { key: KEY(11), draftId: 'd', address: 'a@example.net', subject: 'Hi', text: 'x' },
      { key: KEY(11), conversationId: 'c', text: 'no position' },
      { key: KEY(11), draftId: 'd' },
      null,
    ]) {
      expect([bad, await h.space().send(a, bad as never)]).toMatchObject([bad, { ok: false, reason: 'bad-request' }])
    }
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 0 })
    expect(pending(h)).toBe(0)
  })

  test('keeps every refusal the inbox has: an em dash, and mail that arrived while the reply was written', async () => {
    const h = await world()
    const t = await throughOf(h)
    const dash = await h.space().send(await assertion(), {
      key: KEY(12),
      conversationId: t?.conversationId ?? '',
      through: t?.through ?? 0,
      text: 'Wednesday \u2014 it is.',
    })
    expect(dash).toMatchObject({ ok: false, reason: 'bad-request' })
    await arrive(h)
    const stale = await h.space().send(await assertion(), {
      key: KEY(13),
      conversationId: t?.conversationId ?? '',
      through: t?.through ?? 0,
      text: 'Wednesday it is.',
    })
    expect(stale).toMatchObject({
      ok: false,
      reason: 'conflict',
      message: expect.stringContaining('A new message arrived'),
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(pending(h)).toBe(0)
  })

  test('a draft sent twice under two keys is sent once: the inbox’s own claim still stands behind the key', async () => {
    const h = await world()
    const t = await throughOf(h)
    const made = await ownerDraft(h, {
      conversationId: t?.conversationId,
      body: 'Wednesday it is.',
    })
    const base = { draftId: made.json.id, rev: made.json.rev, through: t?.through ?? 0 }
    unwrap(await h.space().send(await assertion(), { key: KEY(14), ...base }))
    const second = await h.space().send(await assertion(), { key: KEY(15), ...base })
    expect(second).toMatchObject({ ok: false, kind: 'refused', reason: 'conflict' })
    expect(h.google.mailbox.sent).toHaveLength(1)
  })

  test('Claude’s own sending is untouched: it stays refused with its switch off, and a space send neither needs the switch nor turns it on', async () => {
    const h = await world()
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Nice to meet you.',
      why: 'He asked.',
    })
    const claude = await h.request(AGENT, 'POST', `/api/drafts/${made.json.id}/send`, {
      rev: 0,
      instruction: { text: 'send it', where: 'a session with Tessa', at: new Date(T0 - 1000).toISOString() },
    })
    expect(claude.status).toBe(403)
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(false)
    // Tessa, in the space, sends the very draft Claude wrote; the switch is Claude's and stays as it was.
    const sent = unwrap(
      await h.space().send(await assertion(), { key: KEY(16), draftId: made.json.id, rev: 0, through: null }),
    )
    expect(sent.status).toBe('sent')
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(false)
    const row = h.db.query(`SELECT sent_by, instruction_text FROM message WHERE id = ?`).get(sent.messageId)
    expect(row).toEqual({ sent_by: 'tessa@northfield.example', instruction_text: null })
  })

  test('a reply on Ridgeway’s conversation goes out from info@ridgewaycycles.example, through Cloudflare, as the page’s does', async () => {
    const h = await world()
    const priya = unwrap(await h.space().messagesWith(await assertion(), { address: 'priya.n@example.org' }))
    const t = priya.threads[0]
    expect(t?.canReply).toBe(true)
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(18),
        conversationId: t?.conversationId ?? '',
        through: t?.through ?? 0,
        text: 'Yes, we are open on Sundays.',
      }),
    )
    expect(sent.status).toBe('sent')
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]).toMatchObject({
      from: expect.stringContaining('info@ridgewaycycles.example'),
      to: 'priya.n@example.org',
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('a compose key does not keep the record forever: old keys are dropped when a new one is taken', async () => {
    const h = await world()
    unwrap(
      await h.space().send(await assertion(), { key: KEY(19), address: 'a@example.net', subject: 'Hi', text: 'Hello' }),
    )
    h.tick(31 * 24 * 60 * 60 * 1000)
    unwrap(
      await h.space().send(await assertion(), { key: KEY(20), address: 'b@example.net', subject: 'Hi', text: 'Hello' }),
    )
    expect(h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get()).toEqual({ n: 1 })
  })
})
