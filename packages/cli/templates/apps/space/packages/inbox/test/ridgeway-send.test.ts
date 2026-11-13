import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import type { ClaudeSend, ContactCard, MessageRow } from '../src/types'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, harness, mint, OWNER, ownerDraft } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'
import { rawMail } from '../test-support/raw-mail'

/**
 * Tessa replies to a Ridgeway conversation and the reply goes out
 * from info@ridgewaycycles.example, threaded on the customer's side, recorded as sent only once Cloudflare accepts it, and
 * Claude's draft and recorded-instruction send work as they do for Gmail. The highest seam: the Worker's router and Mailroom as
 * a function over the real store and the real `bindingSender`, with a `send_email` binding that can accept, refuse or leave
 * the outcome unknown (test-support/fake-email.ts) and a bucket that can fail.
 *
 * What this cannot show is Cloudflare: that the real binding takes this message from this Worker as info@ (and to an address
 * that is not a verified destination), what `messageId` it reports and whether it is the header it writes, whether a customer's
 * reply names it, and which codes it throws. Those are the hand test (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md, "Sending as
 * info@"). The em dash is written as an escape because this repo has none.
 */

type H = ReturnType<typeof harness>

const FIRST_ID = '<CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com>'
const INFO = 'info@ridgewaycycles.example'
const FROM = `Ridgeway Cycles <${INFO}>`
const DASH = '\u2014'
const WORDS = 'Yes, we are open on Saturdays from nine to one.'
/** What Claude records: Tessa's words, where, and when (four minutes in, after every message the tests store). */
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }
/** The same, as the store keeps and shows it (the time normalized to ISO milliseconds). */
const SAID_STORED = { ...SAID, at: '2026-10-20T12:04:00.000Z' }

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const audits = async (h: H) => (await h.request(AGENT, 'GET', '/api/audit')).json as { action: string; actor: string }[]
const conversationIds = (h: H) => rows<{ id: string }>(h, 'SELECT id FROM conversation ORDER BY rowid').map((r) => r.id)
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
const drafts = async (h: H) => (await h.request(AGENT, 'GET', '/api/drafts')).json as MessageRow[]

/** The one Ridgeway conversation Tessa's test mail starts, and its id. */
async function ridgeway(h: H): Promise<string> {
  expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
  return (
    h.db
      .query(`SELECT c.id FROM conversation c JOIN mailbox m ON m.id = c.mailbox_id WHERE m.kind = 'cloudflare'`)
      .get() as { id: string }
  ).id
}

/** A reply draft on a conversation, made as `who`. */
async function reply(
  h: H,
  conversationId: string,
  extra: Record<string, unknown> = {},
  who: Record<string, unknown> = OWNER,
): Promise<MessageRow> {
  const input = {
    conversationId,
    body: WORDS,
    ...(who === AGENT ? { why: 'He asked for the hours.' } : {}),
    ...extra,
  }
  const res = who === AGENT ? await h.request(who, 'POST', '/api/drafts', input) : await ownerDraft(h, input)
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json
}

/** Press Send as the page does: the revision it drew the draft from and how far into the conversation it reached. */
async function press(
  h: H,
  draft: MessageRow,
  over: Record<string, unknown> = {},
  who: Record<string, unknown> = OWNER,
  through?: number | null,
) {
  const reached =
    through !== undefined
      ? through
      : draft.conversationId === null
        ? null
        : (await detail(h, draft.conversationId)).through
  const body = { rev: draft.rev, ...(reached === null ? {} : { through: reached }), ...over }
  // Tessa presses Send through the space, which ends in the Mailroom's `sendDraft` as him (the owner has no router).
  if (who === OWNER) {
    const whole = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
    return asHttp(
      await h.store.call(
        'sendDraft',
        draft.id,
        {
          rev: whole(body.rev),
          through: whole((body as { through?: unknown }).through),
          instruction: (body as { instruction?: unknown }).instruction,
        },
        OWNER_EMAIL,
      ),
    )
  }
  return h.request(who, 'POST', `/api/drafts/${draft.id}/send`, body)
}

/** Everything a failed send must leave alone, as one string to compare. */
const snapshot = (h: H) =>
  JSON.stringify([
    h.db.query(`SELECT * FROM message ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM conversation ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM participant ORDER BY rowid`).all(),
  ])

/** A Gmail account with one conversation, and the mailbox connected: Tessa's own mail beside Ridgeway's. */
async function withGmail(h: H) {
  h.google.mailbox.add({ id: 'g1', threadId: 'tg', subject: 'Quote for the shop' })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = 'tg'`).get() as { id: string }).id
}

const sendingCalls = (h: H) => h.google.calls.filter((c) => c.startsWith('send:'))

describe('a reply on a Ridgeway conversation', () => {
  test('goes out from info@, to the customer, with In-Reply-To and References, and no Message-ID or Date of the inbox’s own', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    // The draft names its recipient and subject on its face: Tessa's own address is the customer here, and a person.
    expect(draft).toMatchObject({ address: 'tessa@northfield.example', subject: 'Re: Hours question', cc: '', rev: 0 })
    expect((await detail(h, id)).reply).toMatchObject({ to: 'tessa@northfield.example', from: INFO })

    const res = await press(h, draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)

    expect(h.email.handed).toHaveLength(1)
    const out = h.email.handed[0]
    expect(out).toMatchObject({
      from: FROM,
      to: 'tessa@northfield.example',
      subject: 'Re: Hours question',
      text: WORDS,
      headers: { 'In-Reply-To': FIRST_ID, References: FIRST_ID },
    })
    // Cloudflare refuses a request that names either, so the inbox never does.
    expect(Object.keys(out?.headers ?? {}).map((k) => k.toLowerCase())).toEqual(['in-reply-to', 'references'])
    expect(out).not.toHaveProperty('cc')
    // Nothing went through Gmail, which was not even connected.
    expect(sendingCalls(h)).toEqual([])
  })

  test('an explicit Cc is handed to Cloudflare as the draft names it, less the mailbox’s own address and its whole domain’s, which are dropped from the draft when it is made', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id, {
      cc: ['Ann@Example.org', INFO, 'sales@ridgewaycycles.example', 'cy@example.net', 'ann@example.org'],
    })
    expect(draft.cc).toBe('ann@example.org, cy@example.net')
    // An edit goes by the same rule: the mailbox's domain is dropped, and the draft's own recipient (here Tessa's Gmail address, the customer of this test conversation) is not copied on top of the To.
    const edited = (await h.store.call(
      'updateDraft',
      draft.id,
      {
        rev: draft.rev,
        cc: ['cy@example.net', 'ops@ridgewaycycles.example', 'tessa@northfield.example', 'dee@example.net'],
      },
      OWNER_EMAIL,
    )) as {
      ok: true
      value: MessageRow
    }
    expect(edited.value.cc).toBe('cy@example.net, dee@example.net')
    const res = await press(h, edited.value)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(h.email.handed[0]).toMatchObject({
      to: 'tessa@northfield.example',
      cc: ['cy@example.net', 'dee@example.net'],
    })
  })

  test('is filed as sent by Tessa once Cloudflare accepts it, on the conversation it answered, which stays open, with its copy kept', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.tick()
    const res = await press(h, draft)

    expect(res.json).toMatchObject({
      status: 'sent',
      direction: 'out',
      conversationId: id,
      sentBy: 'tessa@northfield.example',
      address: 'tessa@northfield.example',
      subject: 'Re: Hours question',
      body: WORDS,
      from: FROM,
      to: 'tessa@northfield.example',
      sentAt: '2026-10-20T12:01:00.000Z',
      sentFrom: INFO,
    })
    const stored = row(h, draft.id)
    expect(stored).toMatchObject({
      status: 'sent',
      mailbox_id: rows<{ id: string }>(h, 'SELECT id FROM mailbox')[0]?.id,
      // The Message-ID is the one Cloudflare reported, in angle brackets.
      rfc_message_id: '<cf-1@ridgewaycycles.example>',
      in_reply_to: FIRST_ID,
      raw_key: `out/${draft.id}`,
      gmail_id: null,
      read_by: 'tessa@northfield.example',
      closed_by: 'tessa@northfield.example',
    })

    // The exact copy: what was handed to Cloudflare and what it answered, beside the received mail.
    const kept = JSON.parse(h.bucket.text(`out/${draft.id}`))
    expect(kept).toMatchObject({
      kind: 'sent-through-cloudflare',
      reportedMessageId: 'cf-1@ridgewaycycles.example',
      sentBy: 'tessa@northfield.example',
      request: h.email.handed[0],
    })
    expect(h.bucket.objects.get(`out/${draft.id}`)?.metadata).toMatchObject({
      from: INFO,
      to: 'tessa@northfield.example',
    })
    expect([...h.bucket.objects.keys()].filter((k) => k.startsWith('in/'))).toHaveLength(1)

    // Replying does not close the conversation, and the sent message is on it, with its copy's key.
    const after = await detail(h, id)
    expect(after.open).toBe(true)
    expect(after.messages.map((m: MessageRow) => m.direction)).toEqual(['in', 'out'])
    expect(after.messages[1]).toMatchObject({ rawKey: `out/${draft.id}`, sentFrom: INFO })
    expect(after.drafts).toEqual([])
    const actions = (await audits(h)).map((a) => a.action)
    expect(actions).toContain('message.sending')
    expect(actions).toContain('message.send')
  })

  test('Send and close, as the page does it: the send, then Close at the position the question was asked at, and a customer’s next message reopens it', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    const asked = (await detail(h, id)).through
    expect((await press(h, draft, {}, OWNER, asked)).status).toBe(200)
    const closed = asHttp(await h.store.call('changeConversation', id, 'close', OWNER_EMAIL, asked))
    expect(closed.status, JSON.stringify(closed.json)).toBe(200)
    expect(closed.json).toMatchObject({ open: false, closedBy: 'tessa@northfield.example' })
    expect(h.email.handed).toHaveLength(1)

    h.tick()
    await h.deliver(rawMail('reply').replaceAll(FIRST_ID, '<cf-1@ridgewaycycles.example>'))
    expect(await detail(h, id)).toMatchObject({ open: true, unread: true })
  })

  test('a customer’s reply to it joins the conversation: by In-Reply-To when it names the Message-ID Cloudflare reported, by subject when it names another', async () => {
    const h = harness()
    const id = await ridgeway(h)
    await press(h, await reply(h, id))
    h.tick()
    const named = rawMail('reply').replaceAll(FIRST_ID, '<cf-1@ridgewaycycles.example>')
    expect((await h.deliver(named)).entered).toBe('filed')
    expect(conversationIds(h)).toEqual([id])

    // A mail client that rewrote the id still threads by the subject and the customer.
    h.tick()
    const rewritten = rawMail('reply')
      .replaceAll(FIRST_ID, '<someone-elses-id@mail.example>')
      .replace(
        'Message-ID: <CAF3b9xTt7yq0d1Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wh@mail.gmail.com>',
        'Message-ID: <other@mail.gmail.com>',
      )
    expect((await h.deliver(rewritten)).entered).toBe('filed')
    expect(conversationIds(h)).toEqual([id])
    expect(rows(h, 'SELECT id FROM message')).toHaveLength(4)
  })

  test('a draft with an address on the mailbox’s own domain is refused, and Tessa’s own Gmail address is not', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const toUs = await reply(h, id, { address: 'tessa@northfield.example', copyEveryone: false })
    const cc = h.db.query(`UPDATE message SET cc_header = 'inbox-test@ridgewaycycles.example' WHERE id = ?`)
    cc.run(toUs.id)
    const fresh = (await drafts(h)).find((d) => d.id === toUs.id) as MessageRow
    const res = await press(h, fresh)
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('is your own address')
    expect(h.email.handed).toHaveLength(0)
  })

  test('is refused with an em dash, and with a stale revision or a message that arrived since, and nothing is handed over or claimed', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const dash = await reply(h, id, { body: `Open Saturdays ${DASH} nine to one.` })
    const clean = await reply(h, id, { body: WORDS })
    const stale = (await detail(h, id)).through
    const before = snapshot(h)
    expect((await press(h, dash)).status).toBe(422)
    expect((await press(h, { ...dash, rev: 7 })).status).toBe(409)
    expect(snapshot(h)).toBe(before)

    // Something arrived after the page was drawn: a reply over it is refused (409), as on a Gmail thread.
    h.tick()
    await h.deliver(rawMail('reply'))
    const refused = await press(h, clean, {}, OWNER, stale)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('A new message arrived')
    expect(h.email.handed).toHaveLength(0)
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM message WHERE status = 'sending'`)[0]?.n).toBe(0)
    expect(rows<{ status: string }>(h, `SELECT status FROM message WHERE direction = 'out'`)).toEqual([
      { status: 'draft' },
      { status: 'draft' },
    ])
  })

  test('a Worker with no sending binding refuses 503 before anything is claimed', async () => {
    const h = harness({}, { emailConfigured: false })
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    const before = snapshot(h)
    const res = await press(h, draft)
    expect(res.status).toBe(503)
    expect(res.json.error).toContain(`cannot send as ${INFO}`)
    expect(snapshot(h)).toBe(before)
  })
})

describe('a failed send never shows as sent', () => {
  test.each([
    ['E_RECIPIENT_NOT_ALLOWED', 422],
    ['E_VALIDATION_ERROR', 422],
    ['E_SENDER_NOT_VERIFIED', 502],
    ['E_RATE_LIMIT_EXCEEDED', 502],
    ['E_DAILY_LIMIT_EXCEEDED', 502],
    ['E_HEADER_NOT_ALLOWED', 502],
  ])(
    'a refusal with %s (%d) puts the draft back exactly as it was, and the next press can send it',
    async (code, status) => {
      const h = harness()
      const id = await ridgeway(h)
      const draft = await reply(h, id)
      const before = snapshot(h)
      h.email.always({ kind: 'throw', code, message: 'Not today.' })

      const res = await press(h, draft)
      expect(res.status).toBe(status)
      expect(res.json.error).toContain('Nothing was sent, and the draft is still a draft.')
      expect(res.json.error).toContain(code)
      // The store is byte for byte what it was: no sent message, no claim left behind, no copy in the bucket.
      expect(snapshot(h)).toBe(before)
      expect([...h.bucket.objects.keys()].filter((k) => k.startsWith('out/'))).toEqual([])
      expect((await drafts(h)).map((d) => [d.id, d.status])).toEqual([[draft.id, 'draft']])
      expect((await detail(h, id)).messages.map((m: MessageRow) => m.direction)).toEqual(['in'])
      expect((await audits(h)).filter((a) => a.action === 'message.send-refused')).toHaveLength(1)
      expect((await audits(h)).some((a) => a.action === 'message.send')).toBe(false)

      // Accepted later, it goes out once.
      h.email.always({ kind: 'accept' })
      expect((await press(h, draft)).status).toBe(200)
      expect(h.email.handed).toHaveLength(2)
      expect(rows<{ status: string }>(h, `SELECT status FROM message WHERE direction = 'out'`)).toEqual([
        { status: 'sent' },
      ])
    },
  )

  test.each([
    ['E_DELIVERY_FAILED', { kind: 'throw', code: 'E_DELIVERY_FAILED' }],
    ['E_INTERNAL_SERVER_ERROR', { kind: 'throw', code: 'E_INTERNAL_SERVER_ERROR' }],
    ['a code nobody documented', { kind: 'throw', code: 'E_SOMETHING_NEW' }],
    ['an error with no code', { kind: 'throw' }],
    ['something that is not an error', { kind: 'throw-plain' }],
  ] as const)(
    '%s leaves the outcome unknown: held as sending, never sent again, never shown as sent',
    async (_name, behavior) => {
      const h = harness()
      const id = await ridgeway(h)
      const draft = await reply(h, id)
      h.email.always(behavior)

      const res = await press(h, draft)
      expect(res.status).toBe(502)
      expect(res.json.error).toContain('It is not known whether the message went out')
      expect(res.json.error).toContain(`There is no Sent folder for ${INFO}`)
      expect(row(h, draft.id)).toMatchObject({ status: 'sending', gmail_id: null, raw_key: null })
      // On the Drafts, stuck, with the mailbox it was being sent from; not on the conversation as a message.
      const stuck = (await drafts(h)).find((d) => d.id === draft.id)
      expect(stuck).toMatchObject({ status: 'sending', sentFrom: INFO })
      expect((await detail(h, id)).messages.map((m: MessageRow) => m.direction)).toEqual(['in'])
      expect([...h.bucket.objects.keys()].filter((k) => k.startsWith('out/'))).toEqual([])

      // A second press is refused and nothing goes out again, however the binding would answer now.
      h.email.always({ kind: 'accept' })
      const again = await press(h, draft)
      expect(again.status).toBe(409)
      expect(again.json.error).toContain('already being sent')
      expect(h.email.handed).toHaveLength(1)
    },
  )

  test('Tessa says it went out: the stuck message is KEPT, filed as sent on his word (nothing will arrive by itself)', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.email.always({ kind: 'throw', code: 'E_DELIVERY_FAILED' })
    await press(h, draft)

    h.tick()
    const resolved = asHttp(await h.store.call('resolveSend', draft.id, true, OWNER_EMAIL))
    expect(resolved.status, JSON.stringify(resolved.json)).toBe(200)
    expect(resolved.json).toEqual({ id: draft.id, status: 'sent' })
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      sent_by: 'tessa@northfield.example',
      mailbox_id: expect.any(String),
    })
    expect((await detail(h, id)).messages.map((m: MessageRow) => m.direction)).toEqual(['in', 'out'])
    expect((await drafts(h)).map((d) => d.id)).not.toContain(draft.id)
    const resolutions = (await audits(h)).filter((a) => a.action === 'message.send-resolved')
    expect(resolutions).toHaveLength(1)
    // And it is sent: it cannot be pressed again.
    expect((await press(h, draft)).status).toBe(409)
    expect(h.email.handed).toHaveLength(1)
  })

  test('Tessa says it did not go out: a draft again, with no claim left on it, and the next press sends it', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    const before = snapshot(h)
    h.email.always({ kind: 'throw-plain' })
    await press(h, draft)

    const resolved = asHttp(await h.store.call('resolveSend', draft.id, false, OWNER_EMAIL))
    expect(resolved.json).toEqual({ id: draft.id, status: 'draft' })
    expect(snapshot(h)).toBe(before)
    h.email.always({ kind: 'accept' })
    expect((await press(h, draft)).status).toBe(200)
    expect(h.email.handed).toHaveLength(2)
  })

  test('only Tessa can resolve it: Claude cannot', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.email.always({ kind: 'throw-plain' })
    await press(h, draft)
    for (const sent of [true, false]) {
      // The page's route is gone (Claude's door has none), and the Mailroom itself refuses the agent as an actor.
      expect((await h.request(AGENT, 'POST', `/api/messages/${draft.id}/resolve-send`, { sent })).status).toBe(404)
      expect(asHttp(await h.store.call('resolveSend', draft.id, sent, `agent:${AGENT_ID}`)).status).toBe(403)
    }
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
  })

  test('Cloudflare accepted but the inbox could not file it: said so, held as sending, and Tessa’s word keeps it', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.inbox.fileCloudflareSent = () => {
      throw new Error('the store is unreachable')
    }
    const res = await press(h, draft)
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('Cloudflare accepted the message, but the inbox could not record it')
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
    expect(h.email.handed).toHaveLength(1)
    expect((await press(h, draft)).status).toBe(409)
    expect(h.email.handed).toHaveLength(1)
    const resolved = asHttp(await h.store.call('resolveSend', draft.id, true, OWNER_EMAIL))
    expect(resolved.json).toMatchObject({ status: 'sent' })
  })

  test('a second press at the same moment finds the draft taken: one message goes out', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    const through = (await detail(h, id)).through
    const results = await Promise.all([press(h, draft, {}, OWNER, through), press(h, draft, {}, OWNER, through)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(h.email.handed).toHaveLength(1)
    expect(rows(h, `SELECT id FROM message WHERE direction = 'out' AND status = 'sent'`)).toHaveLength(1)
  })

  test('a copy that cannot be kept does not undo a send that went out: it is filed without the key, and the audit says so', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.bucket.failPut = true
    const res = await press(h, draft)
    expect(res.status).toBe(200)
    expect(res.json.status).toBe('sent')
    expect(res.json.rawKey).toBeUndefined()
    expect(row(h, draft.id)).toMatchObject({ status: 'sent', raw_key: null })
    expect((await audits(h)).map((a) => a.action)).toContain('message.copy-failed')
  })
})

describe('the two mailboxes never cross', () => {
  test('a Ridgeway reply never touches Gmail, and Tessa’s own reply never touches the sending binding', async () => {
    const h = harness()
    const gmailConversation = await withGmail(h)
    const id = await ridgeway(h)

    const mine = await reply(h, gmailConversation, { body: 'Tuesday works.' })
    expect((await press(h, mine)).status).toBe(200)
    expect(sendingCalls(h)).toHaveLength(1)
    expect(h.email.handed).toHaveLength(0)

    const theirs = await reply(h, id)
    expect((await press(h, theirs)).status).toBe(200)
    expect(sendingCalls(h)).toHaveLength(1)
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]?.from).toBe(FROM)
    expect(h.google.mailbox.sent[0]?.headers.From).toBe('Tessa Marlow <tessa@northfield.example>')
    // And each ended up on its own mailbox.
    const mailboxes = rows<{ kind: string; n: number }>(
      h,
      `SELECT mb.kind, count(*) AS n FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
        WHERE m.direction = 'out' GROUP BY mb.kind ORDER BY mb.kind`,
    )
    expect(mailboxes).toEqual([
      { kind: 'cloudflare', n: 1 },
      { kind: 'gmail', n: 1 },
    ])
  })

  test('Gmail failing never touches a Ridgeway draft, and Cloudflare refusing never touches a Gmail one', async () => {
    const h = harness()
    const gmailConversation = await withGmail(h)
    const id = await ridgeway(h)
    h.email.always({ kind: 'throw', code: 'E_SENDER_NOT_VERIFIED' })
    const mine = await reply(h, gmailConversation, { body: 'Tuesday works.' })
    expect((await press(h, mine)).status).toBe(200)
    const theirs = await reply(h, id)
    expect((await press(h, theirs)).status).toBe(502)
    expect(row(h, mine.id)).toMatchObject({ status: 'sent' })
    expect(row(h, theirs.id)).toMatchObject({ status: 'draft' })
  })
})

describe('a new email from a contact’s card', () => {
  test('goes from the mailbox the contact last wrote to, which the card and the composer say, and its reply joins it', async () => {
    const h = harness()
    await ridgeway(h)
    const contactId = (
      rows<{ contact_id: string }>(
        h,
        `SELECT contact_id FROM identity WHERE address = 'tessa@northfield.example'`,
      )[0] as {
        contact_id: string
      }
    ).contact_id
    const card = (await h.request(AGENT, 'GET', `/api/contacts/${contactId}`)).json as ContactCard
    expect(card.sendsFrom).toEqual({ name: 'Ridgeway Cycles', address: INFO })

    const created = await ownerDraft(h, {
      contactId,
      subject: 'Your bike',
      body: 'Your bike is ready.',
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const draft = created.json as MessageRow
    expect(draft.conversationId).toBeNull()
    h.tick()
    const res = await press(h, draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(h.email.handed[0]).toMatchObject({
      from: FROM,
      to: 'tessa@northfield.example',
      subject: 'Your bike',
      text: 'Your bike is ready.',
    })
    expect(h.email.handed[0]?.headers).toBeUndefined()

    // A conversation of its own, in the Ridgeway mailbox and marked with it.
    const made = rows<{ id: string; mailbox_id: string }>(h, `SELECT id, mailbox_id FROM conversation ORDER BY rowid`)
    expect(made).toHaveLength(2)
    expect((await detail(h, made[1]?.id as string)).mailbox).toEqual({
      id: made[1]?.mailbox_id,
      name: 'Ridgeway Cycles',
      address: INFO,
    })
    expect((await detail(h, made[1]?.id as string)).open).toBe(false)

    // The customer answers it.
    h.tick()
    const answer = rawMail('reply')
      .replaceAll(FIRST_ID, '<cf-1@ridgewaycycles.example>')
      .replace('Subject: Re: Hours question', 'Subject: Re: Your bike')
    await h.deliver(answer)
    expect(rows(h, 'SELECT id FROM conversation')).toHaveLength(2)
    expect(
      rows<{ n: number }>(h, `SELECT count(*) AS n FROM message WHERE conversation_id = '${made[1]?.id}'`)[0]?.n,
    ).toBe(2)
  })

  test('to someone who never wrote to Ridgeway goes through Gmail, and their card names that account and no Ridgeway address', async () => {
    const h = harness()
    await withGmail(h)
    await ridgeway(h)
    const dana = rows<{ contact_id: string }>(
      h,
      `SELECT contact_id FROM identity WHERE address = 'dana@example.com'`,
    )[0]
    expect(dana).toBeDefined()
    const card = (await h.request(AGENT, 'GET', `/api/contacts/${dana?.contact_id}`)).json as ContactCard
    expect(card.sendsFrom).toEqual({ name: 'northfield', address: 'tessa@northfield.example' })
    const draft = (
      await ownerDraft(h, {
        contactId: dana?.contact_id,
        subject: 'Hello',
        body: 'Hello Dana.',
      })
    ).json as MessageRow
    expect((await press(h, draft)).status).toBe(200)
    expect(sendingCalls(h)).toHaveLength(1)
    expect(h.email.handed).toHaveLength(0)
  })
})

describe('a draft says which mailbox it goes out from when it is made, and the send keeps to that', () => {
  /** A Ridgeway message from `address`, made from the stranger fixture with its own Message-ID. */
  const fromAddress = (address: string, name: string, id: string): string =>
    rawMail('stranger-same-subject')
      .replace(/^From: .*$/m, `From: ${name} <${address}>`)
      .replace('Message-ID: <PN-20261026-1@example.org>', `Message-ID: <${id}@example.org>`)
  const contactOf = (h: H, address: string): string =>
    (
      rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0] as {
        contact_id: string
      }
    ).contact_id
  const newEmail = async (h: H, contactId: string, subject = 'Your bike') =>
    (await ownerDraft(h, { contactId, subject, body: 'Your bike is ready.' })).json as MessageRow

  test('a reply and a new email to a Ridgeway customer both record info@ at creation, and the Drafts and the script say so', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const replyDraft = await reply(h, id)
    expect(replyDraft.sentFrom).toBe(INFO)
    const created = await newEmail(h, contactOf(h, 'tessa@northfield.example'))
    expect(created).toMatchObject({ conversationId: null, sentFrom: INFO })
    expect((await drafts(h)).map((d) => d.sentFrom)).toEqual([INFO, INFO])

    // Claude's script prints it.
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
    const printed = JSON.parse((await runCli(['drafts'], io)).output) as MessageRow[]
    expect(printed.map((d) => d.sentFrom)).toEqual([INFO, INFO])
  })

  test('a draft made for someone who wrote to Ridgeway still goes from info@ after they write to Gmail, and the reverse', async () => {
    const h = harness()
    await h.deliver(fromAddress('priya.n@example.org', 'Priya Nair', 'PN-1'), { from: 'priya.n@example.org', to: INFO })
    const priya = contactOf(h, 'priya.n@example.org')
    const toPriya = await newEmail(h, priya, 'Your bike')
    expect(toPriya.sentFrom).toBe(INFO)

    // Dana is a Gmail contact: her draft is Tessa's own, whatever she does next.
    h.google.mailbox.add({ id: 'g1', threadId: 'tg', subject: 'Quote for the shop' })
    h.google.mailbox.add({
      id: 'g2',
      threadId: 'tp',
      from: 'Priya Nair <priya.n@example.org>',
      subject: 'Also by email',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const toDana = await newEmail(h, contactOf(h, 'dana@example.com'), 'Hello')
    expect(toDana.sentFrom).toBeUndefined()
    // Now Priya's newest message is in Gmail, and Dana's is in Ridgeway's.
    h.tick()
    await h.deliver(fromAddress('dana@example.com', 'Dana Smith', 'DS-1'), { from: 'dana@example.com', to: INFO })

    expect((await press(h, toPriya)).status).toBe(200)
    expect(h.email.handed.map((m) => m.to)).toEqual(['priya.n@example.org'])
    expect(sendingCalls(h)).toEqual([])
    expect((await press(h, toDana)).status).toBe(200)
    expect(sendingCalls(h)).toHaveLength(1)
    expect(h.email.handed).toHaveLength(1)
    // A refused send keeps the recorded mailbox: the draft is still from info@, and still says so.
    const h2 = harness()
    await ridgeway(h2)
    const again = await newEmail(h2, contactOf(h2, 'tessa@northfield.example'))
    h2.email.always({ kind: 'throw', code: 'E_SENDER_NOT_VERIFIED' })
    expect((await press(h2, again)).status).toBe(502)
    expect((await drafts(h2)).find((d) => d.id === again.id)?.sentFrom).toBe(INFO)
    h2.email.always({ kind: 'accept' })
    expect((await press(h2, again)).status).toBe(200)
    expect(h2.email.handed.at(-1)?.from).toBe(FROM)
  })
})

describe('Tessa says a stuck Ridgeway send went out: it is filed with what it was sent with', () => {
  test('with the In-Reply-To it went out under, not the conversation as it is now, and no copy or id when none was kept', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.email.always({ kind: 'throw-plain' })
    await press(h, draft)
    // A newer message arrives while it is stuck: the filed message still names the one it answered.
    h.tick()
    await h.deliver(rawMail('reply'))
    asHttp(await h.store.call('resolveSend', draft.id, true, OWNER_EMAIL))
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      in_reply_to: FIRST_ID,
      rfc_message_id: null,
      raw_key: null,
    })
  })

  test('with the id Cloudflare reported and the copy’s key, when Cloudflare accepted it and only the filing failed', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id)
    h.inbox.fileCloudflareSent = () => {
      throw new Error('the store is unreachable')
    }
    expect((await press(h, draft)).status).toBe(502)
    asHttp(await h.store.call('resolveSend', draft.id, true, OWNER_EMAIL))
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      in_reply_to: FIRST_ID,
      rfc_message_id: '<cf-1@ridgewaycycles.example>',
      raw_key: `out/${draft.id}`,
    })
  })
})

describe('Claude’s draft and send on a Ridgeway conversation, under the same switch and with the instruction recorded', () => {
  const claudeSends = async (h: H, draft: MessageRow, over: Record<string, unknown> = {}) =>
    h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
      rev: draft.rev,
      through: (await detail(h, draft.conversationId as string)).through,
      instruction: SAID,
      ...over,
    })
  const allow = async (h: H, enabled = true) =>
    expect(asHttp(await h.store.call('setClaudeSending', enabled, OWNER_EMAIL)).status).toBe(200)

  test('is refused while the switch is off and without an instruction, and nothing is handed over or changed', async () => {
    const h = harness()
    const id = await ridgeway(h)
    const draft = await reply(h, id, {}, AGENT)
    expect(draft).toMatchObject({ createdBy: `agent:${AGENT_ID}`, address: 'tessa@northfield.example' })
    const before = snapshot(h)
    const off = await claudeSends(h, draft)
    expect(off.status).toBe(403)
    expect(off.json.error).toContain('switched off')
    await allow(h)
    const bare = await claudeSends(h, draft, { instruction: undefined })
    expect(bare.status).toBe(403)
    expect(h.email.handed).toHaveLength(0)
    expect(snapshot(h)).toBe(before)
  })

  test('goes out from info@ on Tessa’s recorded instruction, filed as sent by Claude, with the instruction on it and in the list of Claude’s sends', async () => {
    const h = harness()
    const id = await ridgeway(h)
    await allow(h)
    const draft = await reply(h, id, {}, AGENT)
    h.tick(5 * 60_000)
    const res = await claudeSends(h, draft)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({
      status: 'sent',
      sentBy: `agent:${AGENT_ID}`,
      instruction: SAID_STORED,
      sentFrom: INFO,
    })
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]).toMatchObject({ from: FROM, to: 'tessa@northfield.example' })
    const sends = (await h.request(AGENT, 'GET', '/api/claude-sends')).json as ClaudeSend[]
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ proof: 'filed', message: { id: draft.id, instruction: SAID_STORED } })
  })

  test('is refused when Tessa edited the draft after he spoke, or a customer wrote after he spoke, and nothing goes out', async () => {
    const h = harness()
    const id = await ridgeway(h)
    await allow(h)
    const edited = await reply(h, id, {}, AGENT)
    h.tick(5 * 60_000)
    const patched = asHttp(
      await h.store.call('updateDraft', edited.id, { rev: edited.rev, body: 'Open nine to one.' }, OWNER_EMAIL),
    )
    expect(patched.status).toBe(200)
    const refused = await claudeSends(h, patched.json)
    expect(refused.status).toBe(409)

    // A message arrived after the instruction (a fresh read of the conversation does not make it covered).
    const h2 = harness()
    const id2 = await ridgeway(h2)
    await allow(h2)
    const draft = await reply(h2, id2, {}, AGENT)
    h2.tick(5 * 60_000)
    await h2.deliver(rawMail('reply'))
    const late = await claudeSends(h2, draft)
    expect(late.status).toBe(409)
    expect(late.json.error).toContain('instruction')
    expect(h.email.handed).toHaveLength(0)
    expect(h2.email.handed).toHaveLength(0)
  })

  test('is refused when the instruction says the inbox gave it, and Claude cannot resolve a stuck one', async () => {
    const h = harness()
    const id = await ridgeway(h)
    await allow(h)
    const draft = await reply(h, id, {}, AGENT)
    const refused = await claudeSends(h, draft, { instruction: { ...SAID, where: 'the inbox' } })
    expect(refused.status).toBe(403)
    expect(h.email.handed).toHaveLength(0)

    h.email.always({ kind: 'throw-plain' })
    expect((await claudeSends(h, draft)).status).toBe(502)
    expect(asHttp(await h.store.call('resolveSend', draft.id, true, `agent:${AGENT_ID}`)).status).toBe(403)
  })

  test('a Claude send whose outcome Tessa then confirms stays in the list, and is not listed twice', async () => {
    const h = harness()
    const id = await ridgeway(h)
    await allow(h)
    const draft = await reply(h, id, {}, AGENT)
    h.email.always({ kind: 'throw', code: 'E_DELIVERY_FAILED' })
    h.tick(5 * 60_000)
    expect((await claudeSends(h, draft)).status).toBe(502)
    expect((await h.request(AGENT, 'GET', '/api/claude-sends')).json).toEqual([])
    asHttp(await h.store.call('resolveSend', draft.id, true, OWNER_EMAIL))
    const sends = (await h.request(AGENT, 'GET', '/api/claude-sends')).json as ClaudeSend[]
    expect(sends).toHaveLength(1)
    expect(sends[0]?.message).toMatchObject({ id: draft.id, sentBy: `agent:${AGENT_ID}`, instruction: SAID_STORED })
  })
})

describe('a notification when a Ridgeway message arrives', () => {
  async function turnOn(h: H, device: TestDevice) {
    // Settings' Notifications section: the Notifications class's `addDevice` as Tessa, as the space's entrypoint calls it.
    const res = asHttp(
      await h.store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, null, OWNER_EMAIL),
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
  }
  const read = async (h: H, device: TestDevice) =>
    Promise.all(h.pushService.to(device.endpoint).map(async (r) => JSON.parse((await decrypt(device, r.body)).text)))

  test('Tessa’s device is told once, with the mailbox’s name, the sender and the subject, and nothing of the text', async () => {
    const h = harness()
    const device = await newDevice()
    await turnOn(h, device)
    expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
    const told = await read(h, device)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ kind: 'message', title: 'Ridgeway Cycles: Tessa Marlow', body: 'Hours question' })
    expect(JSON.stringify(told)).not.toContain('Saturdays')
    expect(rows<{ notify: string }>(h, 'SELECT notify FROM message')[0]?.notify).toBe('sent')

    // A redelivery stores nothing and tells nobody again.
    await h.deliver(rawMail('first'))
    expect(h.pushService.to(device.endpoint)).toHaveLength(1)
  })

  test('two messages arriving together are each told once', async () => {
    const h = harness()
    const device = await newDevice()
    await turnOn(h, device)
    await Promise.all([
      h.deliver(rawMail('first')),
      h.deliver(rawMail('stranger-same-subject'), { from: 'priya.n@example.org', to: INFO }),
    ])
    const told = await read(h, device)
    expect(told).toHaveLength(2)
    expect(new Set(told.map((t) => t.messageId)).size).toBe(2)
  })

  test('mail filed late, from the kept copy after an outage, is past the hour and tells nobody', async () => {
    const h = harness()
    const device = await newDevice()
    await turnOn(h, device)
    h.bucket.failGet = true
    expect((await h.deliver(rawMail('first'))).entered).toBe('owed')
    h.bucket.failGet = false
    h.tick(2 * 60 * 60_000)
    await h.drain()
    expect(rows(h, 'SELECT id FROM message')).toHaveLength(1)
    expect(h.pushService.to(device.endpoint)).toHaveLength(0)
  })

  test('filing a message hands on no notification inside the entrance: the Worker asks for it after the handler has answered', async () => {
    const h = harness()
    const device = await newDevice()
    await turnOn(h, device)
    const raw = new TextEncoder().encode(rawMail('first'))
    await h.bucket.put('in/kept', raw.buffer as ArrayBuffer)
    const filed = await h.arrivals.fileArrival({
      rawKey: 'in/kept',
      envelopeFrom: 'tessa@northfield.example',
      envelopeTo: INFO,
      receivedAt: new Date(h.now()).toISOString(),
    })
    expect(filed).toMatchObject({ ok: true, value: { outcome: 'filed' } })
    expect(h.pushService.to(device.endpoint)).toHaveLength(0)
    expect(rows<{ notify: string }>(h, 'SELECT notify FROM message')[0]?.notify).toBe('owed')
    await h.arrivals.deliverNotifications()
    expect(h.pushService.to(device.endpoint)).toHaveLength(1)
    expect(rows<{ notify: string }>(h, 'SELECT notify FROM message')[0]?.notify).toBe('sent')
  })

  test('with no device turned on the message still arrives, and the notification is dropped, never held', async () => {
    const h = harness()
    expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
    expect(rows<{ notify: string }>(h, 'SELECT notify FROM message')[0]?.notify).toBe('dropped')
  })

  test('a push service that fails never costs the mail', async () => {
    const h = harness()
    const device = await newDevice()
    await turnOn(h, device)
    h.pushService.answer(device.endpoint, null)
    expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
    expect(rows(h, 'SELECT id FROM message')).toHaveLength(1)
  })
})
