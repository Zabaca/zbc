import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import { reasonLines } from '../src/cloudflare/spam-check'
import { bulkReason, CLEF_JUNK_THRESHOLD, isBulk, isSpam } from '../src/queue'
import { classifyMail } from '../test-support/content'
import { aiFails, aiHangs, clef, FakeAi, person, spam } from '../test-support/fake-ai'
import { reply } from '../test-support/fake-model'
import {
  AGENT,
  AGENT_AUD,
  AGENT_ID,
  asHttp,
  asker,
  harness,
  mint,
  OWNER,
  ownerDraft,
  RIDGEWAY,
  RIDGEWAY_ASSISTED,
} from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'

/**
 * Ridgeway's Inbox and Bulk follow the same rules as Gmail's, and the one judgment in them is Clef's (ADR-007, decision 22). The highest seam: the Worker's entrance as a function, the real arrival work, the real
 * store over a real SQLite, the real notification delivery to a fake push service, with a fake Workers AI binding that answers,
 * fails or hangs as each test says.
 *
 * What this cannot show is Clef: what it scores real mail, how long it takes, and the shape the real binding returns. That is the
 * live check (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md, "The spam check").
 */

type H = ReturnType<typeof harness>

let seq = 0
/** A message of the test's own: its own Message-ID, subject and sender, so it is its own conversation unless it says it answers one. */
function mail(
  over: {
    from?: string
    name?: string
    subject?: string
    unsubscribe?: boolean
    inReplyTo?: string
    id?: string
    body?: string
  } = {},
) {
  seq += 1
  const from = over.from ?? 'dana@example.net'
  return {
    id: over.id ?? `<m${seq}@example.net>`,
    from,
    raw: `${[
      `From: ${over.name ?? 'Dana Cole'} <${from}>`,
      'To: info@ridgewaycycles.example',
      `Subject: ${over.subject ?? `Topic ${seq}`}`,
      `Message-ID: ${over.id ?? `<m${seq}@example.net>`}`,
      'Date: Tue, 20 Oct 2026 12:00:00 +0000',
      ...(over.inReplyTo ? [`In-Reply-To: ${over.inReplyTo}`, `References: ${over.inReplyTo}`] : []),
      ...(over.unsubscribe ? ['List-Unsubscribe: <https://example.net/u>'] : []),
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      over.body ?? 'Do you do the $40 tune-up walk-in?',
    ].join('\r\n')}\r\n`,
  }
}

const arrive = (h: H, m: ReturnType<typeof mail>) =>
  h.deliver(m.raw, { from: m.from, to: 'info@ridgewaycycles.example' })

const checked = (options: Parameters<typeof harness>[1] = {}) =>
  harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ...options })

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n
const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
const conversationIds = (h: H) => rows<{ id: string }>(h, 'SELECT id FROM conversation ORDER BY rowid').map((r) => r.id)
const facts = (h: H) =>
  rows<{ clef_junk: number | null; clef_category: string | null; clef_model: string | null }>(
    h,
    `SELECT clef_junk, clef_category, clef_model FROM message WHERE direction = 'in' ORDER BY rowid`,
  )
const drafts = (h: H) => rows<Record<string, unknown>>(h, `SELECT * FROM message WHERE status IN ('draft', 'sending')`)
const inbox = async (h: H) => (await queue(h)).rows.map((r: { subject: string }) => r.subject)
const bulk = async (h: H) => (await queue(h, 'bulk')).rows.map((r: { subject: string }) => r.subject)

const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

/**
 * Turn notifications on in a browser, as Settings does after the browser subscribed: the Notifications class's `addDevice` as Tessa, which is what the space's
 * entrypoint calls (the owner has no router).
 */
async function turnOn(h: H): Promise<TestDevice> {
  const device = await newDevice()
  const res = asHttp(
    await h.store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, PIXEL_UA, OWNER_EMAIL),
  )
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return device
}

/** Tessa's spam call: the Assistant's `setSpam` as him, as the space's entrypoint makes it. */
const spamAsTessa = async (h: H, id: string, on: boolean) => asHttp(await h.store.call('setSpam', id, on, OWNER_EMAIL))

/** Tessa's chat turn on a conversation's draft: the Assistant's `chat` as him (its route is gone with the page). */
const chatAsTessa = async (h: H, id: string, instruction: string) =>
  asHttp(
    await h.store.call(
      'chat',
      id,
      { instruction, draftId: null, rev: undefined, body: undefined, subject: undefined },
      OWNER_EMAIL,
    ),
  )

/** What each request to a device said, decrypted with the device's own key. */
const heard = async (h: H, device: TestDevice) =>
  Promise.all(h.pushService.to(device.endpoint).map(async (r) => JSON.parse((await decrypt(device, r.body)).text)))

function script(h: H) {
  const io: CliIo = {
    env: {
      INBOX_URL: 'https://space.northfield.example',
      INBOX_ACCESS_CLIENT_ID: AGENT_ID,
      INBOX_ACCESS_CLIENT_SECRET: 's',
    },
    sopsKey: () => {
      throw new Error('sops must not be called when the env is set')
    },
    readInput: async (spec) => spec,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
      return h.app.request(url, { ...init, headers }, h.env)
    },
  }
  return async (...argv: string[]) => JSON.parse((await runCli(argv, io)).output)
}

/** A contact Tessa has put under a Client, as the Clients tests do. */
async function underClient(h: H, address: string) {
  const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json as { id: string; name: string }[]
  const id = rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0]
    ?.contact_id as string
  expect(contacts.map((c) => c.id)).toContain(id)
  expect((await h.request(AGENT, 'PUT', `/api/contacts/${id}/client`, { clientId: 1 })).status).toBe(200)
}

describe('a person’s message', () => {
  test('is put to Clef once, with what Ridgeway is, and the score is stored on the message; it is in the Inbox, notifies once, and nothing is drafted', async () => {
    const h = checked()
    const device = await turnOn(h)
    const m = mail({ subject: 'Hours question' })

    expect((await arrive(h, m)).entered).toBe('filed')

    expect(h.ai?.calls).toHaveLength(1)
    const call = h.ai?.calls[0]
    expect(call).toMatchObject({
      model: '@cf/cloudflare/clef',
      input: {
        model: 'clef',
        state: {
          from: 'Dana Cole <dana@example.net>',
          to: 'info@ridgewaycycles.example',
          subject: 'Hours question',
          body: expect.stringContaining('$40 tune-up'),
        },
      },
    })
    const questions = JSON.stringify(call?.input.questions)
    expect(questions).toContain('Ridgeway Cycles')
    expect(questions).toContain('scam_phishing')
    expect(facts(h)).toEqual([{ clef_junk: 0.04, clef_category: 'customer', clef_model: '@cf/cloudflare/clef' }])

    expect(await inbox(h)).toEqual(['Hours question'])
    expect(await bulk(h)).toEqual([])
    // No draft: nothing is written until Tessa asks, and the assistant's model was never called.
    expect(drafts(h)).toEqual([])
    expect(h.model?.requests).toHaveLength(0)
    expect(count(h, 'assistant_usage')).toBe(0)
    // One notification: the mailbox, the sender, the subject, and nothing of the mail.
    const seen = await heard(h, device)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'message', title: 'Ridgeway Cycles: Dana Cole', body: 'Hours question' })
    expect(JSON.stringify(seen)).not.toContain('tune-up')
    expect(rows(h, `SELECT notify FROM message WHERE direction = 'in'`)).toEqual([{ notify: 'sent' }])
  })

  test('the conversation says why it is in the Inbox, with the score as Pinecrest’s does, and is not called spam', async () => {
    const h = checked()
    h.ai?.next(clef(0.42, 'vendor_pitch'))
    await arrive(h, mail({ subject: 'Maybe' }))
    const [id] = conversationIds(h) as [string]
    const convo = await detail(h, id)
    expect(convo).toMatchObject({ bulk: false, spam: false, reasons: ['Clef: selling something (0.42).'] })
    expect(convo.sort).toBeUndefined()
    expect(convo.assistantRuns).toBeUndefined()
  })
})

describe('mail the Gmail-shaped rules settle is not put to Clef', () => {
  test('a List-Unsubscribe header is Bulk with no draft and no notification, and nothing judged it', async () => {
    const h = checked()
    const device = await turnOn(h)
    await arrive(h, mail({ subject: 'Weekly offers', unsubscribe: true }))

    expect(h.ai?.calls).toHaveLength(0)
    expect(facts(h)).toEqual([{ clef_junk: null, clef_category: null, clef_model: null }])
    expect(await inbox(h)).toEqual([])
    expect(await bulk(h)).toEqual(['Weekly offers'])
    expect(drafts(h)).toEqual([])
    expect(await heard(h, device)).toHaveLength(0)
    expect(rows(h, `SELECT notify FROM message WHERE direction = 'in'`)).toEqual([{ notify: null }])
    const [id] = conversationIds(h) as [string]
    expect(await detail(h, id)).toMatchObject({
      bulk: true,
      reasons: ['Bulk mail: it carries a List-Unsubscribe header.'],
    })
  })

  test('a no-reply sender is Bulk likewise, and so is a name that is a machine-made address', async () => {
    const h = checked()
    const device = await turnOn(h)
    await arrive(h, mail({ subject: 'Your receipt', from: 'no-reply@shop.example', name: 'Shop' }))
    await arrive(
      h,
      mail({ subject: 'Bounce', from: 'bounce@mail.example', name: 'a1b2c3d4e5f6a7b8c9@bounces.example' }),
    )

    expect(h.ai?.calls).toHaveLength(0)
    expect((await bulk(h)).sort()).toEqual(['Bounce', 'Your receipt'])
    expect(await inbox(h)).toEqual([])
    expect(drafts(h)).toEqual([])
    expect(await heard(h, device)).toHaveLength(0)
  })

  test('a Client’s contact is always Inbox: a bulk-looking message stays there, notifies, and is never put to Clef', async () => {
    const h = checked()
    const device = await turnOn(h)
    await arrive(h, mail({ subject: 'First hello', from: 'priya.n@example.org', name: 'Priya Nair' }))
    await underClient(h, 'priya.n@example.org')
    const before = h.ai?.calls.length

    await arrive(h, mail({ subject: 'Receipt', from: 'priya.n@example.org', name: 'Priya Nair', unsubscribe: true }))
    await arrive(h, mail({ subject: 'Buy now', from: 'priya.n@example.org', name: 'Priya Nair' }))
    h.ai?.next(spam(0.99))

    expect(h.ai?.calls.length).toBe(before)
    expect((await inbox(h)).sort()).toEqual(['Buy now', 'First hello', 'Receipt'])
    expect(await bulk(h)).toEqual([])
    // A person in the Inbox is told once for each message: the first before they were a Client's, the two after.
    expect(await heard(h, device)).toHaveLength(3)
    const receipt = rows<{ id: string }>(h, `SELECT id FROM conversation ORDER BY rowid`)[1]?.id as string
    expect((await detail(h, receipt)).reasons).toEqual([
      'Bulk mail: it carries a List-Unsubscribe header.',
      'Kept in the Inbox: a Client’s contact is on it.',
    ])
    expect(drafts(h)).toEqual([])
  })

  test('mail from the mailbox’s own address or domain is not judged and tells nobody', async () => {
    const h = checked()
    const device = await turnOn(h)
    await arrive(h, mail({ from: 'info@ridgewaycycles.example', name: 'Ridgeway', subject: 'A note to self' }))
    await arrive(h, mail({ from: 'tessa@ridgewaycycles.example', name: 'Tessa', subject: 'From the domain' }))
    expect(h.ai?.calls).toHaveLength(0)
    expect(await heard(h, device)).toHaveLength(0)
  })
})

describe('what Clef says of the rest', () => {
  test('0.80 or more is spam: Bulk, marked Spam, kept, with no draft and no notification, and the score is on its reason line', async () => {
    const h = checked()
    const device = await turnOn(h)
    h.ai?.next(spam(0.95))
    await arrive(h, mail({ subject: 'Get 3x more customers', from: 'growth@reachly.example', name: 'Reachly Growth' }))

    expect(await inbox(h)).toEqual([])
    const [row] = (await queue(h, 'bulk')).rows
    expect(row).toMatchObject({ subject: 'Get 3x more customers', bulk: true, spam: true })
    expect(drafts(h)).toEqual([])
    expect(await heard(h, device)).toHaveLength(0)
    expect(h.model?.requests).toHaveLength(0)
    // Kept: the row, the message and the raw copy are all there, and nothing is closed.
    expect(count(h, 'message')).toBe(1)
    expect(h.bucket.objects.size).toBe(1)
    const convo = await detail(h, row.id)
    expect(convo).toMatchObject({ open: true, bulk: true, spam: true, reasons: ['Clef: selling something (0.95).'] })
    expect(facts(h)).toEqual([{ clef_junk: 0.95, clef_category: 'vendor_pitch', clef_model: '@cf/cloudflare/clef' }])
  })

  test('the threshold is 0.80: 0.79 is a person’s, 0.80 is spam', async () => {
    expect(CLEF_JUNK_THRESHOLD).toBe(0.8)
    const h = checked()
    h.ai?.next(clef(0.79, 'vendor_pitch'), clef(0.8, 'vendor_pitch'))
    await arrive(h, mail({ subject: 'Just under' }))
    await arrive(h, mail({ subject: 'Just over' }))
    expect(await inbox(h)).toEqual(['Just under'])
    expect(await bulk(h)).toEqual(['Just over'])
  })

  test('a scam is told apart from a pitch on the reason line', async () => {
    const h = checked()
    h.ai?.next(clef(0.91, 'scam_phishing'))
    await arrive(h, mail({ subject: 'Your account is locked' }))
    const [id] = conversationIds(h) as [string]
    expect((await detail(h, id)).reasons).toEqual(['Clef: looks like a scam (0.91).'])
  })

  test('the newest message decides: a clean follow-up on a conversation that was spam is in the Inbox and tells Tessa', async () => {
    const h = checked()
    const device = await turnOn(h)
    const first = mail({ subject: 'Offer' })
    h.ai?.next(spam(0.93), person(0.02))
    await arrive(h, first)
    expect(await bulk(h)).toEqual(['Offer'])

    await arrive(h, mail({ subject: 'Re: Offer', inReplyTo: first.id, body: 'Sorry, I do want the tune-up after all.' }))
    expect(conversationIds(h)).toHaveLength(1)
    expect(await inbox(h)).toEqual(['Re: Offer'])
    expect(await bulk(h)).toEqual([])
    expect(await heard(h, device)).toHaveLength(1)
  })

  test('the same bytes delivered twice are judged and notified once', async () => {
    const h = checked()
    const device = await turnOn(h)
    const m = mail({ subject: 'Once' })
    await arrive(h, m)
    expect((await arrive(h, m)).entered).toBe('duplicate')
    expect(h.ai?.calls).toHaveLength(1)
    expect(await heard(h, device)).toHaveLength(1)
  })
})

describe('a judgment that does not come lands in the Inbox and notifies', () => {
  const cases: [string, (h: H) => void][] = [
    ['the call fails', (h) => void h.ai?.next(aiFails())],
    ['the call never answers (the timeout ends it)', (h) => void h.ai?.next(aiHangs)],
    ['the answer is a score outside 0 to 1', (h) => void h.ai?.next(clef(7, 'vendor_pitch'))],
    ['the answer names a kind that is not in the list', (h) => void h.ai?.next(clef(0.99, 'something_else'))],
    ['the answer has no score', (h) => void h.ai?.next({ kind: 'reply', response: { answers: {} } })],
    ['the answer is not an object', (h) => void h.ai?.next({ kind: 'reply', response: 'spam' })],
  ]
  for (const [name, arrange] of cases) {
    test(`${name}: the message is filed, not judged, in the Inbox, and Tessa is told`, async () => {
      const h = checked({ clefTimeoutMs: 25 })
      const device = await turnOn(h)
      arrange(h)
      const { entered, rejected } = await arrive(h, mail({ subject: 'Unjudged' }))
      expect(entered).toBe('filed')
      expect(rejected).toBeNull()
      expect(facts(h)).toEqual([{ clef_junk: null, clef_category: null, clef_model: null }])
      expect(await inbox(h)).toEqual(['Unjudged'])
      expect(await heard(h, device)).toHaveLength(1)
      // Nothing is owed: there is no retry of a judgment.
      expect(count(h, 'arrival_owed')).toBe(0)
      expect(count(h, 'assist_owed')).toBe(0)
      const [id] = conversationIds(h) as [string]
      expect((await detail(h, id)).reasons).toEqual([])
    })
  }

  test('a Worker with no Workers AI binding files mail all the same: in the Inbox, notifying, not judged', async () => {
    const h = checked({ ai: null })
    const device = await turnOn(h)
    expect((await arrive(h, mail({ subject: 'No binding' }))).entered).toBe('filed')
    expect(facts(h)).toEqual([{ clef_junk: null, clef_category: null, clef_model: null }])
    expect(await inbox(h)).toEqual(['No binding'])
    expect(await heard(h, device)).toHaveLength(1)
  })

  test('a store that refuses what Clef said still files the message, and it is in the Inbox', async () => {
    const h = checked()
    h.db.run(`CREATE TRIGGER no_scores BEFORE UPDATE OF clef_junk ON message BEGIN SELECT RAISE(ABORT, 'no'); END`)
    const device = await turnOn(h)
    h.ai?.next(spam(0.99))
    expect((await arrive(h, mail({ subject: 'Refused write' }))).entered).toBe('filed')
    expect(await inbox(h)).toEqual(['Refused write'])
    expect(await heard(h, device)).toHaveLength(1)
  })
})

describe('the switch', () => {
  test('a mailbox declared without the spam check is just received: nothing is asked of Clef, every message is in the Inbox and tells Tessa', async () => {
    const h = harness({}, { mailboxes: [RIDGEWAY] })
    const device = await turnOn(h)
    h.ai?.next(spam(0.99))
    await arrive(h, mail({ subject: 'Would be spam' }))
    expect(h.ai?.calls).toHaveLength(0)
    expect(await inbox(h)).toEqual(['Would be spam'])
    expect(await heard(h, device)).toHaveLength(1)
  })

  test('only Tessa switches it, it is audited, and a redeploy never undoes his switch', async () => {
    const h = harness({}, { mailboxes: [RIDGEWAY] })
    await arrive(h, mail({ subject: 'First' }))
    const mailbox = (await h.request(AGENT, 'GET', '/api/mailboxes')).json.mailboxes[0] as {
      id: string
      assistant: { enabled: boolean; judged: number }
    }
    expect(mailbox.assistant).toMatchObject({ enabled: false, judged: 0 })
    // The switch is Tessa's: Claude's door has no route for it (the page's is gone), and the Assistant refuses the agent as an actor.
    expect((await h.request(AGENT, 'PUT', `/api/mailboxes/${mailbox.id}/assistant`, { enabled: true })).status).toBe(
      404,
    )
    expect(asHttp(await h.store.call('setAssistant', mailbox.id, true, `agent:${AGENT_ID}`)).status).toBe(403)
    const space = h.space()
    // Tessa's switch is the space's entrypoint, which wants a boolean (an empty body can never mean either).
    expect((await space.setSpamCheck(asker(OWNER), mailbox.id, {} as never)).ok).toBe(false)
    expect((await space.setSpamCheck(asker(OWNER), mailbox.id, true)).ok).toBe(true)

    await arrive(h, mail({ subject: 'Second' }))
    expect(h.ai?.calls).toHaveLength(1)
    expect(
      ((await h.request(AGENT, 'GET', '/api/mailboxes')).json.mailboxes[0] as typeof mailbox).assistant,
    ).toMatchObject({ enabled: true, judged: 1 })
    // A redeploy that declares it off does not turn off what Tessa turned on.
    h.inbox.cloudflareMailbox({ address: RIDGEWAY.address, name: RIDGEWAY.name })
    await arrive(h, mail({ subject: 'Third' }))
    expect(h.ai?.calls).toHaveLength(2)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { actor: string; action: string }[]
    expect(audit.filter((a) => a.action === 'mailbox.assistant')).toHaveLength(1)
    expect(audit.filter((a) => a.action === 'message.clef').map((a) => a.actor)).toEqual(['cloudflare', 'cloudflare'])
  })
})

describe('a person’s call on spam', () => {
  test('Tessa moves a conversation back to the Inbox: it stays, Clef is not asked again, and a later message from the same person is not called spam', async () => {
    const h = checked()
    const device = await turnOn(h)
    const first = mail({ subject: 'Pitch that is a customer' })
    h.ai?.next(spam(0.96))
    await arrive(h, first)
    const [id] = conversationIds(h) as [string]
    expect(await bulk(h)).toEqual(['Pitch that is a customer'])

    const moved = await spamAsTessa(h, id, false)
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)
    expect(moved.json).toEqual({ spamCall: { spam: false, by: 'owner' } })
    expect(await inbox(h)).toEqual(['Pitch that is a customer'])
    // Moving it back does not draft anything and does not notify: Tessa is looking.
    expect(drafts(h)).toEqual([])
    expect(await heard(h, device)).toHaveLength(0)
    const convo = await detail(h, id)
    expect(convo).toMatchObject({ bulk: false, spamCall: { spam: false, by: 'owner' } })
    expect(convo.reasons).toEqual(['Tessa moved it back to the Inbox.', 'Clef: selling something (0.96).'])

    // The same person writes again, and would score as spam: not asked, not called spam, in the Inbox, and Tessa is told.
    h.ai?.next(spam(0.99))
    await arrive(h, mail({ subject: 'Re: Pitch that is a customer', inReplyTo: first.id }))
    expect(h.ai?.calls).toHaveLength(1)
    expect(await inbox(h)).toEqual(['Re: Pitch that is a customer'])
    expect(await heard(h, device)).toHaveLength(1)
  })

  test('a call to Bulk, by Tessa or by Claude’s script, sticks: a follow-up stays Bulk, is not judged and tells nobody', async () => {
    const h = checked()
    const device = await turnOn(h)
    const first = mail({ subject: 'Not for the Inbox' })
    await arrive(h, first)
    const [id] = conversationIds(h) as [string]
    expect(await inbox(h)).toEqual(['Not for the Inbox'])
    expect(await heard(h, device)).toHaveLength(1)

    const said = await script(h)('spam', id, 'on')
    expect(said).toEqual({ spamCall: { spam: true, by: 'claude' } })
    expect(await bulk(h)).toEqual(['Not for the Inbox'])
    expect((await queue(h, 'bulk')).rows[0]).toMatchObject({ spam: true, spamCall: { spam: true, by: 'claude' } })

    await arrive(h, mail({ subject: 'Re: Not for the Inbox', inReplyTo: first.id }))
    expect(h.ai?.calls).toHaveLength(1)
    expect(await bulk(h)).toEqual(['Re: Not for the Inbox'])
    expect(await heard(h, device)).toHaveLength(1)

    expect((await script(h)('spam', id, 'off')).spamCall).toEqual({ spam: false, by: 'claude' })
    expect(await inbox(h)).toEqual(['Re: Not for the Inbox'])
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { action: string; actor: string }[]
    expect(audit.filter((a) => a.action === 'conversation.spam')).toHaveLength(2)
  })

  test('a Client’s people are Inbox whatever anyone called it', async () => {
    const h = checked()
    await arrive(h, mail({ subject: 'Hello', from: 'priya.n@example.org', name: 'Priya Nair' }))
    const [id] = conversationIds(h) as [string]
    await spamAsTessa(h, id, true)
    expect(await bulk(h)).toEqual(['Hello'])
    await underClient(h, 'priya.n@example.org')
    expect(await inbox(h)).toEqual(['Hello'])
    expect((await detail(h, id)).reasons).toEqual([
      'Tessa moved it to Bulk.',
      expect.stringMatching(/^Clef: /),
      'Kept in the Inbox: a Client’s contact is on it.',
    ])
  })

  test('it needs a boolean, a conversation in a mailbox and Tessa or Claude', async () => {
    const h = checked()
    await arrive(h, mail({ subject: 'Mine' }))
    const [id] = conversationIds(h) as [string]
    expect((await h.request(AGENT, 'PUT', `/api/conversations/${id}/spam`, {})).status).toBe(422)
    expect((await h.request(AGENT, 'PUT', `/api/conversations/${id}/spam`, { spam: 'yes' })).status).toBe(422)
    expect((await h.request(AGENT, 'PUT', '/api/conversations/nope/spam', { spam: true })).status).toBe(404)
    expect(h.inbox.setSpam(id, true, 'someone@example.com')).toMatchObject({ ok: false, status: 403 })

    h.google.mailbox.add({
      id: 'g1',
      threadId: 'tg',
      labels: ['INBOX', 'UNREAD'],
      from: 'Ann <ann@example.com>',
      subject: 'Gmail one',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const gmail = rows<{ id: string }>(
      h,
      `SELECT c.id FROM conversation c JOIN mailbox m ON m.id = c.mailbox_id WHERE m.kind = 'gmail'`,
    )[0]?.id as string
    // Nobody has called the Gmail conversation, so it carries nothing of the call (the calls on Gmail are test/draft-chat-gmail.test.ts).
    const convo = await detail(h, gmail)
    expect(convo.spam).toBeUndefined()
    expect(convo.spamCall).toBeUndefined()
    // A conversation in no mailbox (a text) has no Inbox or Bulk to move it between.
    const text = await ownerDraft(h, { address: '626-555-0142', name: 'Marcus', body: 'hi' })
    const kept = asHttp(await h.store.call('markSent', text.json.id, undefined, OWNER_EMAIL))
    const refused = await spamAsTessa(h, kept.json.conversationId, true)
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('email conversation')
  })

  test('what the old assistant wrote in the sort columns is no call, and a person’s old word for Bulk still is one', async () => {
    const h = checked()
    await arrive(h, mail({ subject: 'Old assistant sort' }))
    await arrive(h, mail({ subject: 'Old person sort' }))
    await arrive(h, mail({ subject: 'Old person customer' }))
    const [a, b, c] = conversationIds(h) as [string, string, string]
    h.db.run(`UPDATE conversation SET sort = 'newsletter', sort_by = 'assistant' WHERE id = ?`, [a])
    h.db.run(`UPDATE conversation SET sort = 'promotional', sort_by = 'tessa@northfield.example' WHERE id = ?`, [b])
    h.db.run(`UPDATE conversation SET sort = 'customer', sort_by = 'tessa@northfield.example' WHERE id = ?`, [c])
    expect((await inbox(h)).sort()).toEqual(['Old assistant sort', 'Old person customer'])
    expect(await bulk(h)).toEqual(['Old person sort'])
  })
})

describe('nothing is drafted until Tessa asks', () => {
  test('the draft chat writes a reply on a conversation with none, with the spam check switched off and on, and uses the key not the spam check', async () => {
    for (const mailboxes of [[RIDGEWAY], [RIDGEWAY_ASSISTED]]) {
      const h = harness({}, { mailboxes })
      await arrive(h, mail({ subject: 'Hours question' }))
      const [id] = conversationIds(h) as [string]
      expect(drafts(h)).toEqual([])
      h.model?.next(reply('Here is a reply.', 'Hi Dana,\n\nWe are open Saturdays 9 to 1.\n\nTessa\nRidgeway Cycles'))
      const asked = await chatAsTessa(h, id, 'Write a reply')
      expect(asked.status, JSON.stringify(asked.json)).toBe(200)
      expect(asked.json.draft).toMatchObject({ status: 'draft', address: 'dana@example.net', rev: 1 })
      expect(drafts(h)).toHaveLength(1)
      expect(h.model?.requests).toHaveLength(1)
    }
  })

  test('with no key the chat is refused before anything is saved, and arrival is untouched by it', async () => {
    const h = checked({ model: null })
    await arrive(h, mail({ subject: 'Hours question' }))
    const [id] = conversationIds(h) as [string]
    expect(await inbox(h)).toEqual(['Hours question'])
    const asked = await chatAsTessa(h, id, 'Write a reply')
    expect(asked.status).toBe(503)
    expect(drafts(h)).toEqual([])
  })
})

describe('the one rule for Bulk, as a table', () => {
  const gmail = (labels: string[], listUnsubscribe = false) => ({
    newestInbound: { labels, listUnsubscribe },
    clientIds: [] as number[],
  })
  const cloud = (envelope: { listUnsubscribe?: boolean; automated?: boolean; clefJunk?: number | null }) => ({
    newestInbound: { labels: [], listUnsubscribe: false, ...envelope },
    clientIds: [] as number[],
  })

  test('Gmail is as it was: a category tab or a List-Unsubscribe header, from the newest inbound message, and nothing else', () => {
    expect(bulkReason(gmail(['INBOX', 'CATEGORY_PROMOTIONS']))).toBe('category')
    expect(bulkReason(gmail(['INBOX'], true))).toBe('unsubscribe')
    expect(bulkReason(gmail(['INBOX']))).toBeNull()
    expect(bulkReason({ newestInbound: null, clientIds: [] })).toBeNull()
    // A Gmail envelope has no sender judgment and no score, so neither can make it Bulk.
    expect(isBulk({ newestInbound: { labels: ['INBOX'], listUnsubscribe: false }, clientIds: [] })).toBe(false)
  })

  test('a Cloudflare conversation: a header, an automated sender, then Clef at the threshold', () => {
    expect(bulkReason(cloud({ listUnsubscribe: true, automated: true, clefJunk: 0.99 }))).toBe('unsubscribe')
    expect(bulkReason(cloud({ automated: true, clefJunk: 0.99 }))).toBe('automated')
    expect(bulkReason(cloud({ clefJunk: 0.8 }))).toBe('clef')
    expect(bulkReason(cloud({ clefJunk: 0.7999 }))).toBeNull()
    expect(bulkReason(cloud({ clefJunk: null }))).toBeNull()
    expect(isSpam(cloud({ clefJunk: 0.9 }))).toBe(true)
    expect(isSpam(cloud({ listUnsubscribe: true }))).toBe(false)
  })

  test('a Client’s person is never Bulk, and a person’s call decides over the rest', () => {
    const base = { newestInbound: { labels: [], listUnsubscribe: true, automated: true, clefJunk: 0.99 } }
    expect(isBulk({ ...base, clientIds: [3] })).toBe(false)
    expect(isBulk({ ...base, clientIds: [3], spamCall: { spam: true, by: 'owner' } })).toBe(false)
    expect(isBulk({ ...base, clientIds: [], spamCall: { spam: false, by: 'owner' } })).toBe(false)
    expect(isBulk({ newestInbound: null, clientIds: [], spamCall: { spam: true, by: 'claude' } })).toBe(true)
    expect(isSpam({ newestInbound: null, clientIds: [], spamCall: { spam: true, by: 'claude' } })).toBe(true)
  })

  test('the reason lines say each rule that holds, in the order they run, and nothing for a message nothing judged', () => {
    expect(
      reasonLines(
        {
          clientIds: [],
          spamCall: undefined,
          newest: { listUnsubscribe: false, automated: null, clef: null },
        },
        'Tessa',
      ),
    ).toEqual([])
    expect(
      reasonLines(
        {
          clientIds: [],
          spamCall: { spam: true, by: 'owner' },
          newest: {
            listUnsubscribe: true,
            automated: 'Its only address, noreply@x.test, is a no-reply mailbox.',
            clef: { junk: 0.5, category: 'internal_test', model: 'm' },
          },
        },
        'Tessa',
      ),
    ).toEqual([
      'Tessa moved it to Bulk.',
      'Bulk mail: it carries a List-Unsubscribe header.',
      'Automated sender: Its only address, noreply@x.test, is a no-reply mailbox.',
      'Clef: a test message (0.50).',
    ])
  })
})

describe('the Clef call, through its port', () => {
  const INFO = 'info@ridgewaycycles.example'
  const MAIL = {
    from: 'sales@pitch.example',
    to: 'info@ridgewaycycles.example',
    subject: 'Grow your shop',
    body: 'We do SEO for bike shops.',
  }
  const answer = (noul: unknown, choice: unknown = 'vendor_pitch') => ({
    answers: { junk: { noul }, category: { choice } },
  })

  test('what a judged message stores: the probability, the kind and the model that said so', async () => {
    const ai = new FakeAi().next({ kind: 'reply', response: answer(0.93) })
    expect(await classifyMail(ai, MAIL, { mailbox: INFO })).toEqual({
      junk: 0.93,
      category: 'vendor_pitch',
      model: '@cf/cloudflare/clef',
    })
    expect(ai.calls[0]?.input.state).toEqual(MAIL)
  })

  test('a body is cut where it stops being the message, and the message is shown as state to the clef model', async () => {
    const ai = new FakeAi()
    await classifyMail(ai, { ...MAIL, body: 'x'.repeat(20_000) }, { mailbox: INFO })
    expect(ai.calls[0]?.input.state.body).toHaveLength(8000)
    expect(ai.calls[0]?.model).toBe('@cf/cloudflare/clef')
  })

  test('every failure is null and never a rejection', async () => {
    const out = async (step: Parameters<FakeAi['next']>[0], timeoutMs = 20) =>
      classifyMail(new FakeAi().next(step), MAIL, { mailbox: INFO, timeoutMs })
    expect(await out(aiFails())).toBeNull()
    expect(await out(aiHangs)).toBeNull()
    expect(await out({ kind: 'reply', response: null })).toBeNull()
    expect(await out({ kind: 'reply', response: answer('0.9') })).toBeNull()
    expect(await out({ kind: 'reply', response: answer(Number.NaN) })).toBeNull()
    expect(await out({ kind: 'reply', response: answer(-0.1) })).toBeNull()
    expect(await out({ kind: 'reply', response: answer(0.9, 'newsletter') })).toBeNull()
    // A port that throws before it returns a promise.
    expect(
      await classifyMail(
        {
          run: () => {
            throw new Error('no binding')
          },
        },
        MAIL,
        { mailbox: INFO },
      ),
    ).toBeNull()
  })

  test('a score of exactly 0 and exactly 1 are scores', async () => {
    expect((await classifyMail(new FakeAi().next(clef(0, 'customer')), MAIL, { mailbox: INFO }))?.junk).toBe(0)
    expect((await classifyMail(new FakeAi().next(clef(1, 'scam_phishing')), MAIL, { mailbox: INFO }))?.junk).toBe(1)
  })
})
