import { describe, expect, test } from 'bun:test'
import { QUEUE_PAGE } from '../src/types'
import { AGENT, asker, harness, OWNER, STRANGER } from '../test-support/harness'

/**
 * Search through the inbox's Worker as a function, with a Gmail that really ingests: what it finds (a person's name or
 * address, a subject, a message's text; open and closed; every word, in any order), what it leaves out, how it is
 * cut to a screen, and that it changes nothing: no read stamp, no row written, no call to Gmail.
 */

type H = ReturnType<typeof harness>

async function live(h: H, setup: () => void) {
  setup()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

const search = (h: H, q: string, who: Record<string, unknown> | null = AGENT) =>
  h.request(who, 'GET', `/api/search?q=${encodeURIComponent(q)}`)

const subjectsOf = async (h: H, q: string): Promise<string[]> =>
  ((await search(h, q)).json.rows as { subject: string }[]).map((r) => r.subject)

/** Every row of every table, so "it changed nothing" is a comparison of the whole store. */
function dump(h: H): string {
  const tables = h.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
    name: string
  }[]
  return JSON.stringify(tables.map((t) => [t.name, h.db.query(`SELECT * FROM "${t.name}"`).all()]))
}

const T = Date.parse('2026-10-20T12:00:00.000Z')

/** Five conversations: a quote, an invoice from a bank, a newsletter (Bulk), a long thread and one to close. */
const mailbox = (h: H) => () => {
  h.google.mailbox.add({
    id: 'q1',
    threadId: 'tq',
    at: T - 5 * 3_600_000,
    from: 'Dominique Laurent <dominique@brasserie.example>',
    subject: 'Quote for the new menu pages',
    body: 'Hello, could you send a quote for the menu pages before Friday?',
  })
  h.google.mailbox.add({
    id: 'i1',
    threadId: 'ti',
    at: T - 4 * 3_600_000,
    from: 'Billing <billing@bank.example>',
    subject: 'Your invoice is ready',
    body: 'Invoice 4411 is attached. Total due: 100% of the balance.',
  })
  h.google.mailbox.add({
    id: 'n1',
    threadId: 'tn',
    at: T - 3 * 3_600_000,
    from: 'The Weekly <news@weekly.example>',
    subject: 'Ten tips for faster sites',
    body: 'This week: images, fonts and a quote from a designer.',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    headers: { 'List-Unsubscribe': '<mailto:unsub@weekly.example>' },
  })
  h.google.mailbox.add({
    id: 'l1',
    threadId: 'tl',
    at: T - 2 * 3_600_000,
    from: 'Dana Reyes <dana@acme.example>',
    subject: 'Logo files',
    body: 'Attached are the logo files.',
  })
  h.google.mailbox.add({
    id: 'l2',
    threadId: 'tl',
    at: T - 1 * 3_600_000,
    labels: ['INBOX'],
    from: 'Dana Reyes <dana@acme.example>',
    subject: 'Re: Logo files',
    body: 'One more thing: the favicon is in the zip too.',
  })
  h.google.mailbox.add({
    id: 'c1',
    threadId: 'tc',
    at: T - 6 * 3_600_000,
    from: 'Teo Ortiz <teo@sora.example>',
    subject: 'Brand guideline',
    body: 'The new guideline is attached.',
  })
}

const convoId = (h: H, thread: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(thread) as { id: string }).id

/** Close the Brand guideline conversation, as Tessa would, so it is closed. */
async function closeBrand(h: H) {
  const id = convoId(h, 'tc')
  const through = (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json.through
  expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/close`, { through })).status).toBe(200)
}

describe('what search finds', () => {
  test('a person by name, by address and by part of either, however it is cased', async () => {
    const h = harness()
    await live(h, mailbox(h))
    for (const q of [
      'dominique',
      'DOMINIQUE',
      'Laurent',
      'brasserie.example',
      'dominique@brasserie.example',
      'domin',
    ]) {
      expect(await subjectsOf(h, q), q).toEqual(['Quote for the new menu pages'])
    }
  })

  test('a subject, and the text of a message', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect(await subjectsOf(h, 'invoice')).toEqual(['Your invoice is ready'])
    expect(await subjectsOf(h, 'favicon')).toEqual(['Re: Logo files'])
    // The word is only in an older message of the thread.
    expect(await subjectsOf(h, 'attached logo')).toEqual(['Re: Logo files'])
  })

  test('every word must be on the conversation, in any order and in different messages', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect(await subjectsOf(h, 'logo favicon')).toEqual(['Re: Logo files'])
    expect(await subjectsOf(h, 'favicon logo')).toEqual(['Re: Logo files'])
    expect(await subjectsOf(h, 'dana favicon')).toEqual(['Re: Logo files'])
    expect(await subjectsOf(h, 'favicon invoice')).toEqual([])
  })

  test('open, closed and Bulk conversations all count, newest first', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await closeBrand(h)
    // "quote": the quote request, and the newsletter (Bulk) that mentions one.
    expect(await subjectsOf(h, 'quote')).toEqual(['Ten tips for faster sites', 'Quote for the new menu pages'])
    const brand = (await search(h, 'guideline')).json.rows
    expect(brand).toHaveLength(1)
    expect(brand[0]).toMatchObject({ subject: 'Brand guideline', open: false })
    expect(await subjectsOf(h, 'attached')).toEqual(['Re: Logo files', 'Your invoice is ready', 'Brand guideline'])
  })

  test('a row is the queue row, and says which message matched', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const found = (await search(h, 'favicon')).json
    expect(found).toMatchObject({ query: 'favicon', terms: ['favicon'], more: false, directory: { available: true } })
    expect(found.rows[0]).toMatchObject({
      title: 'Dana Reyes',
      subject: 'Re: Logo files',
      open: true,
      unread: expect.any(Boolean),
      bulk: false,
      match: 'One more thing: the favicon is in the zip too.',
    })
    // Found by name only: the text has nothing to show.
    expect((await search(h, 'dominique')).json.rows[0].match).toBeNull()
  })

  test('the text of a draft waiting on a conversation is searched too', async () => {
    const h = harness()
    await live(h, mailbox(h))
    await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: convoId(h, 'tq'),
      body: 'Yes, a proposal by Thursday, with the zebra option.',
      why: 'He asked.',
    })
    expect(await subjectsOf(h, 'zebra')).toEqual(['Quote for the new menu pages'])
  })

  test('a % or _ typed is itself, never a wildcard', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect(await subjectsOf(h, '100%')).toEqual(['Your invoice is ready'])
    expect(await subjectsOf(h, '%')).toEqual(['Your invoice is ready'])
    expect(await subjectsOf(h, '_')).toEqual([])
    expect(await subjectsOf(h, 'qu_te')).toEqual([])
    expect(await subjectsOf(h, "'; DROP TABLE message; --")).toEqual([])
    expect((h.db.query(`SELECT count(*) AS n FROM message`).get() as { n: number }).n).toBeGreaterThan(0)
  })

  test('no words, or only spaces, is an empty answer and not an error', async () => {
    const h = harness()
    await live(h, mailbox(h))
    for (const q of ['', '   ']) {
      const res = await search(h, q)
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ rows: [], terms: [], more: false })
    }
    expect((await h.request(AGENT, 'GET', '/api/search')).json.rows).toEqual([])
  })

  test('our own address is on no conversation as a person, so Tessa’s own address finds nothing by itself', async () => {
    const h = harness()
    await live(h, mailbox(h))
    expect((await search(h, 'tessa@northfield.example')).json.rows).toEqual([])
  })
})

describe('a screen of results', () => {
  test('the newest QUEUE_PAGE are shown, and more says there were others', async () => {
    const h = harness()
    await live(h, () => {
      for (let n = 0; n < QUEUE_PAGE + 3; n++) {
        h.google.mailbox.add({
          id: `m${n}`,
          threadId: `t${n}`,
          at: T + n * 1000,
          from: `Person ${n} <p${n}@many.example>`,
          subject: `Hello number ${n}`,
          body: 'common words',
        })
      }
    })
    const found = (await search(h, 'common')).json
    expect(found.rows).toHaveLength(QUEUE_PAGE)
    expect(found.more).toBe(true)
    expect(found.rows[0].subject).toBe(`Hello number ${QUEUE_PAGE + 2}`)
    // A narrower search is under a screen and says nothing more.
    const narrow = (await search(h, 'number 7')).json
    expect(narrow.more).toBe(false)
    expect(narrow.rows.length).toBeGreaterThan(0)
  })
})

describe('search writes nothing', () => {
  test('as Tessa or as Claude, no row changes, nothing is marked read and Gmail is not called', async () => {
    const h = harness()
    await live(h, mailbox(h))
    const before = dump(h)
    const calls = h.google.calls.length
    // As Claude, through the door; as Tessa, through the space's entrypoint (his only way in).
    const asTessa = h.space()
    const a = asker(OWNER)
    for (const q of ['quote', 'dominique', 'attached', 'nothing matches this', 'a b c']) {
      expect((await search(h, q, AGENT)).status).toBe(200)
      expect((await asTessa.search(a, q)).ok, q).toBe(true)
    }
    expect(dump(h)).toBe(before)
    expect(h.google.calls).toHaveLength(calls)
    // Everything that was unread still is.
    const unread = (await h.request(AGENT, 'GET', '/api/queue')).json.rows.filter((r: { unread: boolean }) => r.unread)
    expect(unread.length).toBeGreaterThan(0)
  })

  test('there is no way to write through it: the route answers GET only', async () => {
    const h = harness()
    await live(h, mailbox(h))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await h.request(AGENT, method, '/api/search?q=quote', {})
      expect(res.status, method).not.toBe(200)
    }
  })
})

describe('who may search', () => {
  test('Tessa and Claude may; someone Access let in that the inbox does not know, and no one, may not', async () => {
    const h = harness()
    await live(h, mailbox(h))
    // Tessa searches through the space (the owner has no router), Claude through its door.
    expect((await h.space().search(asker(OWNER), 'quote')).ok).toBe(true)
    expect((await search(h, 'quote', AGENT)).status).toBe(200)
    // The door refuses a person: Tessa's own assertion is no key to Claude's door.
    expect((await search(h, 'quote', OWNER)).status).toBe(403)
    expect((await search(h, 'quote', STRANGER)).status).toBe(403)
    expect((await search(h, 'quote', null)).status).toBe(401)
  })
})
