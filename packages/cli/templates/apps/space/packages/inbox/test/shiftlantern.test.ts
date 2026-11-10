import { describe, expect, test } from 'bun:test'
import { hasSpamQuestions, personaFor } from '../test-support/content'
import { type FakeModel, says } from '../test-support/fake-model'
import { harness, RIDGEWAY_ASSISTED, SHIFTLANTERN as RIGHTS } from '../test-support/harness'
import { ownerRequest } from '../test-support/owner-requests'
import { rawMail } from '../test-support/raw-mail'

/**
 * ShiftLantern's mailbox (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md): a second Cloudflare mailbox, on shiftlantern.example,
 * beside Ridgeway's. The highest seam, as test/draft-chat.test.ts and test/ridgeway-send.test.ts have it: the Worker's entrance
 * and routes as functions, the real store over a real SQLite, the real assistant over a fake model, the real sender over a fake
 * `send_email` binding. What it cannot show is Cloudflare (that mail for the zone reaches the Worker, that the binding sends as
 * hello@, what SPF, DKIM and DMARC say) or the real model, which are the runbook's hand test.
 */

type H = ReturnType<typeof harness>

const HELLO = RIGHTS.address
const INFO = 'info@ridgewaycycles.example'

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const model = (h: H) => h.model as FakeModel
const detail = async (h: H, id: string) => (await ownerRequest(h, 'GET', `/api/conversations/${id}`)).json

/** Both mailboxes declared as wrangler.jsonc declares them: Ridgeway's with its spam check, ShiftLantern's without. */
const both = (options: Parameters<typeof harness>[1] = {}) =>
  harness({}, { mailboxes: [RIDGEWAY_ASSISTED, RIGHTS], ...options })

let seq = 0
/** A worker writes to the site. Its own Message-ID and subject, so each is a conversation of its own. */
function worker(to = HELLO, subject = 'Final paycheck question') {
  seq += 1
  const from = 'maria@example.net'
  return {
    from,
    to,
    raw: `${[
      `From: Maria Lopez <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: <rc${seq}@example.net>`,
      'Date: Tue, 20 Oct 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'I was let go on Friday. When does my last paycheck have to be paid?',
    ].join('\r\n')}\r\n`,
  }
}

const arrive = (h: H, m: ReturnType<typeof worker>) => h.deliver(m.raw, { from: m.from, to: m.to })
/** Tessa's test mail to Ridgeway, as the other suites send it. */
const ridgewayMail = (h: H) => h.deliver(rawMail('first'), { to: INFO })

const mailboxId = (h: H, address: string): string =>
  (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(address) as { id: string }).id

const conversationFor = (h: H, address: string): string =>
  (
    h.db
      .query(`SELECT c.id FROM conversation c JOIN mailbox m ON m.id = c.mailbox_id WHERE m.address = ?`)
      .get(address) as { id: string }
  ).id

describe('mail for shiftlantern.example', () => {
  test('any address on the domain is filed under ShiftLantern, unread and open, and Ridgeway’s mail stays Ridgeway’s', async () => {
    const h = both()
    expect((await arrive(h, worker('hello@shiftlantern.example'))).entered).toBe('filed')
    expect((await arrive(h, worker('anything@shiftlantern.example', 'A second one'))).entered).toBe('filed')
    expect((await ridgewayMail(h)).entered).toBe('filed')

    expect(
      rows<{ address: string; name: string; n: number }>(
        h,
        `SELECT m.address, m.display_name AS name, count(c.id) AS n
           FROM mailbox m JOIN conversation c ON c.mailbox_id = m.id WHERE m.kind = 'cloudflare' GROUP BY m.id ORDER BY m.address`,
      ),
    ).toEqual([
      { address: HELLO, name: 'ShiftLantern', n: 2 },
      { address: INFO, name: 'Ridgeway Cycles', n: 1 },
    ])
    const queue = (await ownerRequest(h, 'GET', '/api/queue?filter=inbox')).json
    expect(queue.rows.map((r: { subject: string }) => r.subject).sort()).toEqual(
      ['A second one', 'Final paycheck question', 'Hours question'].sort(),
    )
  })

  test('a domain nobody declared is still refused', async () => {
    const h = both()
    const refused = await arrive(h, worker('hello@shiftlantern.example.net'))
    expect(refused.rejected).not.toBeNull()
    expect(rows(h, 'SELECT id FROM message')).toEqual([])
  })
})

describe('a reply on a ShiftLantern conversation', () => {
  test('goes out from hello@shiftlantern.example, named ShiftLantern, to the worker, and never through Gmail', async () => {
    const h = both()
    await arrive(h, worker())
    const id = conversationFor(h, HELLO)
    expect((await detail(h, id)).reply).toMatchObject({ to: 'maria@example.net', from: HELLO })

    const made = await ownerRequest(h, 'POST', '/api/drafts', {
      conversationId: id,
      body: 'Thanks for writing. Our guide on final pay explains the timing.',
    })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const through = (await detail(h, id)).through
    const sent = await ownerRequest(h, 'POST', `/api/drafts/${made.json.id}/send`, { rev: made.json.rev, through })
    expect(sent.status, JSON.stringify(sent.json)).toBe(200)

    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]).toMatchObject({
      from: `ShiftLantern <${HELLO}>`,
      to: 'maria@example.net',
      subject: 'Re: Final paycheck question',
    })
    expect(h.google.calls.filter((c) => c.startsWith('send:'))).toEqual([])
  })
})

describe('the assistant on ShiftLantern’s mail', () => {
  test('is the site’s voice with the no-legal-advice rule, signs as ShiftLantern, and has a knowledge base that starts empty', async () => {
    const persona = personaFor(HELLO)
    expect(persona?.signature).toBe('ShiftLantern')
    expect(personaFor('Hello@ShiftLantern.example')).toBe(persona)

    const h = both()
    await arrive(h, worker())
    const id = conversationFor(h, HELLO)
    model(h).next(says({ draft: 'Thanks for writing.\n\nShiftLantern', note: 'Short, and no advice.' }))

    const res = await ownerRequest(h, 'POST', `/api/conversations/${id}/chat`, { instruction: 'write a reply' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const request = model(h).requests.at(-1)
    expect(request?.system).toContain('You are the reply assistant for ShiftLantern')
    expect(request?.system).toContain(`sent from ${HELLO}, signed "ShiftLantern"`)
    expect(request?.system).toContain('does not give legal advice')
    expect(request?.system).toContain('Mention a guide by name or address only when the knowledge base lists it')
    expect(request?.system).toContain('with nothing listed, give shiftlantern.example and stop there')
    expect(request?.system).toContain('The knowledge base is empty.')

    // Nothing of Northfield's or Ridgeway's is in what it was told or shown.
    expect(request?.system).not.toContain('Ridgeway')
    expect(request?.system).not.toContain('Northfield Works')
    expect(request?.system).not.toContain('Alder Bend')
    expect(model(h).userText(-1)).not.toContain('Ridgeway')
  })

  test('never reads Ridgeway’s knowledge base, and Ridgeway’s own prompt carries none of ShiftLantern’s rules', async () => {
    const h = both()
    await arrive(h, worker())
    await ridgewayMail(h)
    const rights = conversationFor(h, HELLO)
    const ridgeway = conversationFor(h, INFO)
    h.knowledge.seed({
      title: 'Pricing',
      body: 'A tune-up is $40 RIDGEWAY-ONLY.',
      businesses: ['ridgeway-cycles'],
    })
    // An entry marked for both is read by both assistants; ShiftLantern's rules stay ShiftLantern's.
    h.knowledge.seed({
      title: 'Booking',
      body: 'Book on the website BOTH-OF-THEM.',
      businesses: ['ridgeway-cycles', 'shiftlantern'],
    })

    await ownerRequest(h, 'POST', `/api/conversations/${rights}/chat`, { instruction: 'write a reply' })
    const theirs = model(h).requests.at(-1)
    expect(theirs?.system).not.toContain('RIDGEWAY-ONLY')
    expect(theirs?.system).not.toContain('$40')
    expect(theirs?.system).toContain('BOTH-OF-THEM')
    expect(theirs?.system).toContain('does not give legal advice')

    await ownerRequest(h, 'POST', `/api/conversations/${ridgeway}/chat`, { instruction: 'write a reply' })
    const ours = model(h).requests.at(-1)
    expect(ours?.system).toContain('RIDGEWAY-ONLY')
    expect(ours?.system).toContain('BOTH-OF-THEM')
    expect(ours?.system).toContain('customer-service agent for Ridgeway Cycles')
    expect(ours?.system).not.toContain('does not give legal advice')
  })
})

describe('the spam check on ShiftLantern’s mail', () => {
  /** A third mailbox that has no questions written for it, to show the guard is still there. */
  const OTHER = { address: 'hello@example.org', name: 'Other' }
  const otherMail = (h: H) => h.deliver(rawMail('first'), { from: 'someone@example.net', to: OTHER.address })

  test('questions are written for Ridgeway’s and ShiftLantern’s mailboxes and for no other', () => {
    expect(hasSpamQuestions(INFO)).toBe(true)
    expect(hasSpamQuestions('INFO@ridgewaycycles.example')).toBe(true)
    expect(hasSpamQuestions(HELLO)).toBe(true)
    expect(hasSpamQuestions(' Hello@ShiftLantern.example ')).toBe(true)
    expect(hasSpamQuestions(OTHER.address)).toBe(false)
    expect(hasSpamQuestions('info@northfield.example')).toBe(false)
    expect(hasSpamQuestions('')).toBe(false)
  })

  test('the switch turns on for ShiftLantern and off again, and refuses a mailbox with no questions', async () => {
    const h = both({ mailboxes: [RIDGEWAY_ASSISTED, RIGHTS, OTHER] })
    await arrive(h, worker())
    await ridgewayMail(h)
    await otherMail(h)

    const hello = `/api/mailboxes/${mailboxId(h, HELLO)}/assistant`
    const assistant = (address: string) =>
      (h.db.query(`SELECT assistant FROM mailbox WHERE address = ?`).get(address) as { assistant: number }).assistant
    expect(assistant(HELLO)).toBe(0)
    const on = await ownerRequest(h, 'PUT', hello, { enabled: true })
    expect(on.status, JSON.stringify(on.json)).toBe(200)
    expect(assistant(HELLO)).toBe(1)
    expect((await ownerRequest(h, 'PUT', hello, { enabled: false })).status).toBe(200)
    expect(assistant(HELLO)).toBe(0)

    const refused = await ownerRequest(h, 'PUT', `/api/mailboxes/${mailboxId(h, OTHER.address)}/assistant`, {
      enabled: true,
    })
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('No spam questions are written for hello@example.org')
    expect(assistant(OTHER.address)).toBe(0)

    const ridgeway = `/api/mailboxes/${mailboxId(h, INFO)}/assistant`
    expect((await ownerRequest(h, 'PUT', ridgeway, { enabled: false })).status).toBe(200)
    expect((await ownerRequest(h, 'PUT', ridgeway, { enabled: true })).status).toBe(200)
  })

  test('declared without the check, ShiftLantern’s mail is not asked about until Tessa turns it on, then it is', async () => {
    const h = both()
    expect((await arrive(h, worker())).entered).toBe('filed')
    expect(h.ai?.calls).toHaveLength(0)
    expect(rows(h, `SELECT clef_junk FROM message WHERE direction = 'in'`)).toEqual([{ clef_junk: null }])

    expect(
      (await ownerRequest(h, 'PUT', `/api/mailboxes/${mailboxId(h, HELLO)}/assistant`, { enabled: true })).status,
    ).toBe(200)
    await arrive(h, worker(HELLO, 'A second one'))
    expect(h.ai?.calls).toHaveLength(1)
  })

  test('a mailbox with no questions is never asked about, even when the deploy config declares the check on, and its mail is in the Inbox', async () => {
    const h = harness({}, { mailboxes: [RIDGEWAY_ASSISTED, { ...OTHER, assistant: true }] })
    expect((await otherMail(h)).entered).toBe('filed')
    expect(h.ai?.calls).toHaveLength(0)
    expect(rows(h, `SELECT clef_junk FROM message WHERE direction = 'in'`)).toEqual([{ clef_junk: null }])
    const queue = (await ownerRequest(h, 'GET', '/api/queue?filter=inbox')).json
    expect(queue.rows).toHaveLength(1)

    // Ridgeway's, beside it, is still judged.
    await ridgewayMail(h)
    expect(h.ai?.calls).toHaveLength(1)
  })
})
