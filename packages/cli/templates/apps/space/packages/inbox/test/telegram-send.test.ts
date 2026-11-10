import { describe, expect, test } from 'bun:test'
import { SEND_IN_FLIGHT_MS } from '../src/telegram/wire'
import { AGENT, AGENT_ID, asker, BRIDGE, harness, OWNER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { as, ownerRequest } from '../test-support/owner-requests'
import { account, channel, chat, group, groupMessage, member, message, push } from '../test-support/telegram'

/**
 * SENDING. Tessa pressing Send in the space sends on Telegram as him, in a one-to-one chat or a group; a channel has no reply box; Claude's
 * send goes through the one existing path (a stored draft, Tessa's recorded instruction, his switch) and nothing else can make the bridge send.
 *
 * The seam is the same as the other Telegram suites': the bridge's door as a function over the real store on a real SQLite (`h.bridge`), the space's own send for what Tessa presses, and Claude's real router for what
 * it can and cannot do. What this cannot show is Telegram: that `messages.sendMessage` with the stored random id goes out once, that a repeat is stored once (a probe saw it), that the bridge
 * does what it is offered. Those are the hand test (docs/runbooks/inbox-telegram-bridge.md).
 *
 * The em dash is written as an escape because this repo has none.
 */

type H = ReturnType<typeof harness>

const DASH = '\u2014'
const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const G = '-1001234567'
const WORDS = 'Friday works for me.'
/** Tessa's words as Claude records them; four minutes after the harness clock starts, before the clock's skew allowance. */
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }
/** A message that came in before Tessa spoke (the harness clock starts at 2026-10-20T12:00Z). */
const EARLY = '2026-10-20T11:00:00Z'
const MIN = 60_000

const post = async (h: H, path: string, body: unknown) => (await h.bridge(BRIDGE, path, body)).json
const feed = (h: H, body: unknown) => post(h, '/api/push', body)
const work = (h: H) => post(h, '/api/work', { account })
/** The random id the send was offered under, as the bridge would send it back; '1' for a message nothing is owed for. */
const randomIdOf = (h: H, messageId: string): string => {
  const r = rows<{ value: string }>(h, `SELECT value FROM setting WHERE key = 'telegram-send:${messageId}'`)[0]
  return r ? (JSON.parse(r.value) as { randomId: string }).randomId : '1'
}
/** Outcomes as the bridge reports them: each names the random id it was offered under (the test names it only where it means another). */
const outcomes = (h: H, list: Record<string, unknown>[]) =>
  post(h, '/api/outcomes', {
    account,
    outcomes: list.map((o) =>
      o.kind === 'send' && o.randomId === undefined ? { ...o, randomId: randomIdOf(h, String(o.messageId)) } : o,
    ),
  })
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const conversationOf = (h: H, chatId: string): string =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id
const detail = async (h: H, conversationId: string) =>
  (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const messages = (h: H, chatId: string) =>
  rows<{
    id: string
    status: string
    direction: string
    body: string
    telegram_msg_id: number | null
    arrival_key: string | null
    sent_by: string | null
    read_at: string | null
    closed_at: string | null
    instruction_text: string | null
  }>(
    h,
    `SELECT m.id, m.status, m.direction, m.body, m.telegram_msg_id, m.arrival_key, m.sent_by, m.read_at, m.closed_at, m.instruction_text
       FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE c.telegram_chat_id = '${chatId}' ORDER BY m.rowid`,
  )
const owedSends = (owed: { kind: string }[]) =>
  owed.filter((o) => o.kind === 'send') as {
    kind: 'send'
    messageId: string
    chatId: string
    text: string
    randomId: string
  }[]

/** Tessa presses Send on a reply in the chat, as the space does for a reply box. */
async function press(h: H, chatId: string, text = WORDS, key = KEY(1), through?: number) {
  const id = conversationOf(h, chatId)
  return h.space().send(await asker(OWNER), {
    key,
    conversationId: id,
    through: through ?? (await detail(h, id)).through,
    text,
  })
}

/** A chat with one message from the other side, the way the bridge's fill leaves it. */
async function oneToOne(h: H, over: { at?: string } = {}) {
  await feed(h, push([chat()], [message({ id: 1, text: 'Can we move it?', ...(over.at && { at: over.at }) })]))
}

describe('Tessa presses Send', () => {
  test('a reply in a one-to-one chat is claimed for the bridge and nothing leaves until the bridge takes it: the answer is "sending", the bridge is offered the exact words, and the message is filed when Telegram says it took it', async () => {
    const h = harness()
    await oneToOne(h)
    expect(owedSends((await work(h)).owed)).toEqual([])

    const answer = unwrap(await press(h, '2001'))
    expect(answer).toMatchObject({ status: 'sending' })
    const waiting = messages(h, '2001')
    expect(waiting.map((m) => m.status)).toEqual(['sent', 'sending'])
    // It is not yet a message of the conversation: it waits, as a stuck send does.
    expect(waiting[1]).toMatchObject({ direction: 'out', body: WORDS, telegram_msg_id: null, sent_by: null })

    const offered = owedSends((await work(h)).owed)
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      kind: 'send',
      chatId: '2001',
      text: WORDS,
      messageId: (waiting[1] as { id: string }).id,
    })
    expect(offered[0]?.randomId).toMatch(/^[1-9][0-9]{0,18}$/)

    h.tick(2000)
    const done = await outcomes(h, [
      { kind: 'send', messageId: offered[0]?.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
    ])
    expect(done).toEqual({ settled: 1, unknown: 0 })
    expect(owedSends((await work(h)).owed)).toEqual([])
    const filed = messages(h, '2001')
    expect(filed).toHaveLength(2)
    expect(filed[1]).toMatchObject({
      status: 'sent',
      direction: 'out',
      body: WORDS,
      telegram_msg_id: 77,
      arrival_key: '2001:77',
      sent_by: OWNER_EMAIL,
    })
    // As every message he sends from anywhere: read and closed by him.
    expect(filed[1]?.read_at).not.toBeNull()
    expect(filed[1]?.closed_at).not.toBeNull()
  })

  test('the random id is made once and stored with the send: every offer of it carries the same one, and a second send of other words has another', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const first = owedSends((await work(h)).owed)[0] as { randomId: string; messageId: string }
    h.tick(30_000)
    const again = owedSends((await work(h)).owed)[0] as { randomId: string }
    expect(again.randomId).toBe(first.randomId)
    await outcomes(h, [
      { kind: 'send', messageId: first.messageId, ok: true, telegramId: 70, at: '2026-10-20T12:00:40Z' },
    ])

    unwrap(await press(h, '2001', 'And Saturday too.', KEY(2)))
    const second = owedSends((await work(h)).owed)[0] as { randomId: string }
    expect(second.randomId).not.toBe(first.randomId)
  })

  test('the bridge hears its own message as an update: the copy that arrives AFTER the outcome is the same message, stored once', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const offered = owedSends((await work(h)).owed)[0] as { messageId: string }
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
    ])

    const echo = await feed(
      h,
      push([chat()], [message({ id: 77, out: true, text: WORDS, at: '2026-10-20T12:00:02Z' })]),
    )
    expect(echo).toEqual({ stored: 0, repeated: 1, skipped: 0 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('and the copy that arrives BEFORE the outcome settles the send by itself: it takes the sender, the draft goes and nothing is owed, so the conversation never shows it twice and the outcome, when it comes, finds nothing waiting', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const offered = owedSends((await work(h)).owed)[0] as { messageId: string; randomId: string }

    // The stream got there first: Tessa's own message, as from his phone.
    const echo = await feed(
      h,
      push([chat()], [message({ id: 77, out: true, text: WORDS, at: '2026-10-20T12:00:02Z' })]),
    )
    expect(echo).toEqual({ stored: 1, repeated: 0, skipped: 0 })
    const filed = messages(h, '2001')
    expect(filed.map((m) => m.status)).toEqual(['sent', 'sent'])
    expect(filed[1]).toMatchObject({ arrival_key: '2001:77', sent_by: OWNER_EMAIL, body: WORDS })
    expect(owedSends((await work(h)).owed)).toEqual([])

    expect(
      await outcomes(h, [
        {
          kind: 'send',
          messageId: offered.messageId,
          randomId: offered.randomId,
          ok: true,
          telegramId: 77,
          at: '2026-10-20T12:00:02Z',
        },
      ]),
    ).toEqual({ settled: 0, unknown: 1 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('a group is sent to by its own chat id, and the message is filed under the group, not under a member', async () => {
    const h = harness()
    await feed(h, push([group()], [groupMessage({ id: 5, text: 'Lunch?', sender: member('3001', 'Ana Ruiz') })]))
    unwrap(await press(h, G, 'Noon works.'))
    const offered = owedSends((await work(h)).owed)
    expect(offered).toEqual([expect.objectContaining({ chatId: G, text: 'Noon works.' })])
    await outcomes(h, [
      { kind: 'send', messageId: offered[0]?.messageId, ok: true, telegramId: 9, at: '2026-10-20T12:00:02Z' },
    ])
    const filed = messages(h, G)
    expect(filed[1]).toMatchObject({ status: 'sent', direction: 'out', arrival_key: `${G}:9`, body: 'Noon works.' })
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM conversation WHERE telegram_chat_id = '${G}'`)[0]?.n).toBe(
      1,
    )
  })

  test('a channel has no reply box: the space says it cannot reply, a send into it is refused with the words, and nothing is claimed or offered', async () => {
    const h = harness()
    await feed(h, push([channel()], [message({ chatId: '-1009876543', id: 3, text: 'Status: all green' })]))
    const id = conversationOf(h, '-1009876543')
    const history = unwrap(
      await h
        .space()
        .messagesWith(
          await asker(OWNER),
          { contactId: rows<{ id: string }>(h, 'SELECT id FROM contact')[0]?.id as string },
          { include: ['bulk', 'closed'] },
        ),
    )
    expect(history.threads[0]).toMatchObject({ telegramChat: 'channel', canReply: false })

    // Even a draft on it, and a press on that draft, are refused.
    const draft = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: id,
      body: 'Thanks!',
      why: 'Because.',
    })
    expect(draft.status).toBe(201)
    const sent = asHttpish(
      await h.store.call(
        'sendDraft',
        draft.json.id,
        { rev: draft.json.rev, through: (await detail(h, id)).through },
        OWNER_EMAIL,
      ),
    )
    expect(sent.status).toBe(422)
    expect(sent.error).toContain('channel')
    expect(messages(h, '-1009876543').map((m) => m.status)).toEqual(['sent', 'draft'])
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('a one-to-one chat and a group can be answered, a bot’s chat too: canReply is true for all and false only for a channel', async () => {
    const h = harness()
    await feed(
      h,
      push(
        [chat(), group(), channel(), chat({ id: '2002', name: 'Helper', bot: true })],
        [
          message({ id: 1 }),
          groupMessage({ id: 2, sender: member('3001', 'Ana') }),
          message({ chatId: '-1009876543', id: 3 }),
          message({ chatId: '2002', id: 4 }),
        ],
      ),
    )
    const mailbox = rows<{ id: string }>(h, 'SELECT id FROM mailbox')[0]?.id
    expect(mailbox).toBeDefined()
    const summaries = (await h.request(AGENT, 'GET', '/api/queue?filter=all')).json.rows ?? []
    expect(summaries.length).toBeGreaterThan(0)
    const a = await asker(OWNER)
    const canReply: Record<string, boolean> = {}
    for (const contact of rows<{ id: string; name: string }>(h, 'SELECT id, name FROM contact')) {
      const history = unwrap(
        await h.space().messagesWith(a, { contactId: contact.id }, { include: ['bulk', 'closed'] }),
      )
      for (const t of history.threads) canReply[contact.name] = t.canReply
    }
    expect(canReply).toMatchObject({ 'Dana Reyes': true, Helper: true, 'Cloudflare Status': false })
  })
})

const asHttpish = (r: unknown): { status: number; error: string } => {
  const x = r as { ok: boolean; status?: number; error?: string }
  return x.ok ? { status: 200, error: '' } : { status: x.status ?? 0, error: x.error ?? '' }
}

describe('every safeguard of the email send holds for Telegram', () => {
  test('a second press, a double click and a repeat of the same key claim once and offer once', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    // The same key again: the space answers it from the first.
    const repeat = await press(h, '2001')
    expect(repeat).toMatchObject({ ok: false, kind: 'refused', reason: 'repeated' })
    // A new key over the same words, while the first is still waiting: a second message is possible only as a second draft, never as a second send of the first.
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
    const id = (messages(h, '2001')[1] as { id: string }).id
    const again = asHttpish(
      await h.store.call(
        'sendDraft',
        id,
        { rev: 0, through: (await detail(h, conversationOf(h, '2001'))).through },
        OWNER_EMAIL,
      ),
    )
    expect(again.status).toBe(409)
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
  })

  test('a message that arrived after the page was drawn refuses the send and claims nothing, and then goes once the page has read it', async () => {
    const h = harness()
    await oneToOne(h)
    const stale = (await detail(h, conversationOf(h, '2001'))).through
    await feed(h, push([chat()], [message({ id: 2, at: '2026-10-20T11:30:00Z', text: 'Actually, Thursday?' })]))

    const refused = await press(h, '2001', WORDS, KEY(1), stale)
    expect(refused).toMatchObject({ ok: false, kind: 'refused', reason: 'conflict' })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
    expect(owedSends((await work(h)).owed)).toEqual([])

    expect(unwrap(await press(h, '2001'))).toMatchObject({ status: 'sending' })
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
  })

  test('an em dash, no words, words past what Telegram takes, and a stale revision are refused with nothing claimed', async () => {
    const h = harness()
    await oneToOne(h)
    const id = conversationOf(h, '2001')
    const draft = unwrap(
      (await h.store.call('createDraft', { conversationId: id, body: `Friday ${DASH} works.` }, OWNER_EMAIL)) as never,
    ) as { id: string; rev: number }
    const through = (await detail(h, id)).through
    const dash = asHttpish(await h.store.call('sendDraft', draft.id, { rev: draft.rev, through }, OWNER_EMAIL))
    expect(dash).toMatchObject({ status: 422 })
    expect(dash.error).toContain('em dash')
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])

    // Past Telegram's limit.
    const long = unwrap(
      (await h.store.call('createDraft', { conversationId: id, body: 'x'.repeat(4097) }, OWNER_EMAIL)) as never,
    ) as { id: string; rev: number }
    const tooLong = asHttpish(await h.store.call('sendDraft', long.id, { rev: long.rev, through }, OWNER_EMAIL))
    expect(tooLong).toMatchObject({ status: 422 })
    expect(tooLong.error).toContain('4096')
    const fits = unwrap(
      (await h.store.call('createDraft', { conversationId: id, body: 'y'.repeat(4096) }, OWNER_EMAIL)) as never,
    ) as { id: string; rev: number }
    expect(
      asHttpish(await h.store.call('sendDraft', fits.id, { rev: fits.rev + 1, through }, OWNER_EMAIL)).status,
    ).toBe(409)
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('a draft on no conversation has no chat to go to: it stays a hand draft and is refused with the words', async () => {
    const h = harness()
    await oneToOne(h)
    const contact = rows<{ id: string }>(h, 'SELECT id FROM contact')[0]?.id as string
    const draft = unwrap(
      (await h.store.call('createDraft', { contactId: contact, body: 'Hi' }, OWNER_EMAIL)) as never,
    ) as { id: string; rev: number; kind: string; conversationId: string | null }
    expect(draft).toMatchObject({ kind: 'telegram', conversationId: null })
    const sent = asHttpish(await h.store.call('sendDraft', draft.id, { rev: draft.rev, through: null }, OWNER_EMAIL))
    expect(sent).toMatchObject({ status: 422 })
    expect(sent.error).toContain('Mark sent')
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('Telegram’s service chat and Saved Messages are never written to, even from a conversation filed under them by hand', async () => {
    const h = harness()
    await oneToOne(h)
    const id = conversationOf(h, '2001')
    const draft = unwrap(
      (await h.store.call('createDraft', { conversationId: id, body: 'hello' }, OWNER_EMAIL)) as never,
    ) as { id: string; rev: number }
    const through = (await detail(h, id)).through
    for (const forbidden of ['777000', account.id]) {
      h.db.run(`UPDATE conversation SET telegram_chat_id = '${forbidden}' WHERE id = '${id}'`)
      const sent = asHttpish(await h.store.call('sendDraft', draft.id, { rev: draft.rev, through }, OWNER_EMAIL))
      expect(sent, forbidden).toMatchObject({ status: 422 })
      expect(sent.error).toContain('service chat')
      expect(rows<{ status: string }>(h, `SELECT status FROM message WHERE id = '${draft.id}'`)[0]?.status).toBe(
        'draft',
      )
    }
    expect(owedSends((await work(h)).owed)).toEqual([])
  })
})

describe('when Telegram will not take it', () => {
  test('a refusal puts the draft back with no instruction and the reason in words on it, nothing is owed, and it can be sent again with a new random id', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const offered = owedSends((await work(h)).owed)[0] as { messageId: string; randomId: string }

    expect(
      await outcomes(h, [{ kind: 'send', messageId: offered.messageId, ok: false, reason: 'USER_IS_BLOCKED' }]),
    ).toEqual({
      settled: 1,
      unknown: 0,
    })
    expect(owedSends((await work(h)).owed)).toEqual([])
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
    const drafts = (await h.request(AGENT, 'GET', '/api/drafts')).json as {
      id: string
      refusal?: string
      rev: number
    }[]
    expect(drafts).toEqual([
      expect.objectContaining({
        id: offered.messageId,
        refusal: 'Telegram would not take this, so nothing was sent. They have blocked you.',
      }),
    ])
    const audit = (await ownerRequest(h, 'GET', '/api/audit')).json as { action: string; after: { reason?: string } }[]
    expect(audit.find((a) => a.action === 'message.send-refused')?.after).toEqual({
      reason: 'Telegram: USER_IS_BLOCKED',
    })

    // Sent again (Tessa's decision, on the draft as it stands): a new claim, a new key, and the note is gone.
    const id = conversationOf(h, '2001')
    const draft = drafts[0] as { id: string; rev: number }
    unwrap(
      await h.space().send(await asker(OWNER), {
        key: KEY(2),
        draftId: draft.id,
        rev: draft.rev,
        through: (await detail(h, id)).through,
      }),
    )
    const next = owedSends((await work(h)).owed)[0] as { randomId: string }
    expect(next.randomId).not.toBe(offered.randomId)
    expect(((await h.request(AGENT, 'GET', '/api/drafts')).json as { refusal?: string }[])[0]?.refusal).toBeUndefined()
  })

  test('a code the inbox has no words for is said as the code, and nothing of a message is kept with it', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const offered = owedSends((await work(h)).owed)[0] as { messageId: string }
    await outcomes(h, [{ kind: 'send', messageId: offered.messageId, ok: false, reason: 'SOMETHING_NEW' }])
    const drafts = (await h.request(AGENT, 'GET', '/api/drafts')).json as { refusal?: string }[]
    expect(drafts[0]?.refusal).toBe('Telegram would not take this, so nothing was sent. Telegram said SOMETHING_NEW.')
  })
})

describe('a send the bridge never reported', () => {
  test('is offered again with the same random id for five minutes from its first offer and then never: its outcome is unknown, shown so, and only Tessa settles it', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    // The bridge is down for a while (but under five minutes): nothing was offered, so the clock of the offers has not started.
    h.tick(4 * MIN)
    const first = owedSends((await work(h)).owed)[0] as { randomId: string; messageId: string }
    expect(first).toBeDefined()
    h.tick(2 * MIN)
    expect(owedSends((await work(h)).owed)[0]?.randomId).toBe(first.randomId)
    h.tick(2 * MIN)
    expect(owedSends((await work(h)).owed)[0]?.randomId).toBe(first.randomId)
    h.tick(2 * MIN)
    // Six minutes after the first offer: no longer offered, however often the bridge asks.
    expect(owedSends((await work(h)).owed)).toEqual([])
    h.tick(60 * MIN)
    expect(owedSends((await work(h)).owed)).toEqual([])

    const status = (await h.request(AGENT, 'GET', '/api/telegram')).json.mailboxes[0]
    expect(status).toMatchObject({ sendsOwed: 0, unknownSends: 1 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending'])

    // A late outcome (the bridge did send it after all) still files it: it names a send that is waiting.
    expect(
      await outcomes(h, [
        { kind: 'send', messageId: first.messageId, ok: true, telegramId: 88, at: '2026-10-20T13:00:00Z' },
      ]),
    ).toEqual({
      settled: 1,
      unknown: 0,
    })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('Tessa says it did not go out: it is a draft again and nothing is offered; he says it did: the stuck draft is removed and Telegram’s own copy is the record; both only once the send can no longer land', async () => {
    for (const wentOut of [false, true]) {
      const h = harness()
      await oneToOne(h)
      unwrap(await press(h, '2001'))
      const first = owedSends((await work(h)).owed)[0] as { messageId: string }
      h.tick(SEND_IN_FLIGHT_MS + 1000)

      const answered = asHttpish(await h.store.call('resolveSend', first.messageId, wentOut, OWNER_EMAIL))
      expect(answered.status).toBe(200)
      expect(owedSends((await work(h)).owed)).toEqual([])
      expect(messages(h, '2001').map((m) => m.status)).toEqual(wentOut ? ['sent'] : ['sent', 'draft'])
      if (!wentOut) expect(messages(h, '2001')[1]?.instruction_text).toBeNull()
    }
  })

  test('while the send may still land, neither answer is Tessa’s to give: not while it is offered, and not through its timeout, the bridge’s restart and the margin after the last offer', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const first = owedSends((await work(h)).owed)[0] as { messageId: string }
    // Offered at once, the last offer five minutes on; the request it starts may be pending for the send timeout and the bridge may not restart for its silence limit.
    for (const minutes of [1, 6, 10]) {
      h.tick(minutes === 1 ? MIN : (minutes === 6 ? 5 : 4) * MIN)
      for (const wentOut of [false, true]) {
        const refused = asHttpish(await h.store.call('resolveSend', first.messageId, wentOut, OWNER_EMAIL))
        expect(refused.status, `${minutes} min, ${wentOut}`).toBe(409)
        expect(refused.error).toContain('may still be sending')
      }
    }
    h.tick(SEND_IN_FLIGHT_MS - 10 * MIN - 1000 * 5)
    expect(asHttpish(await h.store.call('resolveSend', first.messageId, false, OWNER_EMAIL)).status).toBe(409)
    h.tick(10_000)
    expect(asHttpish(await h.store.call('resolveSend', first.messageId, false, OWNER_EMAIL)).status).toBe(200)
  })

  test('before the bridge has been offered it at all (it is down), nothing can have gone out, so Tessa may take it back at once', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const id = (messages(h, '2001')[1] as { id: string }).id
    expect(asHttpish(await h.store.call('resolveSend', id, false, OWNER_EMAIL)).status).toBe(200)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('his own message with these words arriving after the offers stopped but while the send may still land (the bridge restarted and caught up) settles the send as sent, by itself', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const first = owedSends((await work(h)).owed)[0] as { messageId: string }
    h.tick(8 * MIN)
    expect(owedSends((await work(h)).owed)).toEqual([])
    await feed(h, push([chat()], [message({ id: 91, out: true, text: WORDS, at: '2026-10-20T12:01:00Z' })]))
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
    expect(messages(h, '2001')[1]).toMatchObject({ arrival_key: '2001:91', sent_by: OWNER_EMAIL })
    expect(asHttpish(await h.store.call('resolveSend', first.messageId, false, OWNER_EMAIL)).status).toBe(404)
  })

  test('but not past the bound: the copy is for Tessa to see, the send stays unknown, "it did not go out" is refused while the copy is held and "it went out" removes the stuck draft', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const first = owedSends((await work(h)).owed)[0] as { messageId: string }
    h.tick(SEND_IN_FLIGHT_MS + 5 * MIN)
    await feed(h, push([chat()], [message({ id: 91, out: true, text: WORDS, at: '2026-10-20T12:01:00Z' })]))
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending', 'sent'])
    const refused = asHttpish(await h.store.call('resolveSend', first.messageId, false, OWNER_EMAIL))
    expect(refused.status).toBe(409)
    expect(refused.error).toContain('did go out')
    expect(asHttpish(await h.store.call('resolveSend', first.messageId, true, OWNER_EMAIL)).status).toBe(200)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('Claude cannot say whether it went out', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const id = (messages(h, '2001')[1] as { id: string }).id
    h.tick(SEND_IN_FLIGHT_MS + MIN)
    expect(asHttpish(await h.store.call('resolveSend', id, true, `agent:${AGENT_ID}`)).status).toBe(403)
  })
})

describe('a late answer settles only the claim it was offered under', () => {
  test('Tessa took the send back and sent it again with a new random id: a late ok or refusal naming the old key settles nothing, and the new claim stays waiting for its own', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const old = owedSends((await work(h)).owed)[0] as { messageId: string; randomId: string }
    h.tick(SEND_IN_FLIGHT_MS + 1000)
    expect(asHttpish(await h.store.call('resolveSend', old.messageId, false, OWNER_EMAIL)).status).toBe(200)
    const id = conversationOf(h, '2001')
    unwrap(
      await h.space().send(await asker(OWNER), {
        key: KEY(2),
        draftId: old.messageId,
        rev: 0,
        through: (await detail(h, id)).through,
      }),
    )
    const again = owedSends((await work(h)).owed)[0] as { messageId: string; randomId: string }
    expect(again.messageId).toBe(old.messageId)
    expect(again.randomId).not.toBe(old.randomId)

    // The first send lands late and its answer arrives: it is not the new claim's.
    const late = { kind: 'send', messageId: old.messageId, randomId: old.randomId }
    expect(await outcomes(h, [{ ...late, ok: true, telegramId: 70, at: '2026-10-20T12:00:02Z' }])).toEqual({
      settled: 0,
      unknown: 1,
    })
    expect(await outcomes(h, [{ ...late, ok: false, reason: 'USER_IS_BLOCKED' }])).toEqual({ settled: 0, unknown: 1 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending'])
    expect(owedSends((await work(h)).owed)).toHaveLength(1)

    // The new claim's own answer settles it.
    expect(
      await outcomes(h, [
        {
          kind: 'send',
          messageId: again.messageId,
          randomId: again.randomId,
          ok: true,
          telegramId: 71,
          at: '2026-10-20T12:30:00Z',
        },
      ]),
    ).toEqual({ settled: 1, unknown: 0 })
    expect(messages(h, '2001')[1]).toMatchObject({ status: 'sent', arrival_key: '2001:71' })
  })
})

describe('what the person is shown while a send is going out', () => {
  const drafts = async (h: H) => unwrap(await h.space().drafts(await asker(OWNER)))

  test('"Sending on Telegram" while it may still land, and the "check Telegram" card only once it cannot: stuck is false and sending is true until then', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    expect((await drafts(h))[0]).toMatchObject({ kind: 'telegram', stuck: false, sending: true })
    await work(h)
    for (const minutes of [1, 5, 5]) {
      h.tick(minutes * MIN)
      expect((await drafts(h))[0], `${minutes}`).toMatchObject({ stuck: false, sending: true })
    }
    h.tick(SEND_IN_FLIGHT_MS)
    const after = (await drafts(h))[0]
    expect(after).toMatchObject({ stuck: true })
    expect(after).not.toHaveProperty('sending')
  })

  test('a send the bridge was never offered shows as sending for five minutes and then is a draft again with a plain note: nothing can have gone out, so nothing is asked', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    h.tick(4 * MIN)
    expect((await drafts(h))[0]).toMatchObject({ stuck: false, sending: true })
    h.tick(2 * MIN)
    const back = (await drafts(h))[0] as unknown as Record<string, unknown>
    expect(back).toMatchObject({
      stuck: false,
      refusal: 'Not sent: the Telegram bridge was not running. Press Send again.',
    })
    expect(back).not.toHaveProperty('sending')
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
    expect(messages(h, '2001')[1]?.instruction_text).toBeNull()
  })

  test('and it never goes out when the bridge comes back an hour later: the bridge is offered nothing, and the draft is a draft again however the first thing to notice is asked', async () => {
    for (const first of ['work', 'status'] as const) {
      const h = harness()
      await oneToOne(h)
      unwrap(await press(h, '2001'))
      h.tick(60 * MIN)
      if (first === 'work') expect(owedSends((await work(h)).owed)).toEqual([])
      else
        expect((await h.request(AGENT, 'GET', '/api/telegram')).json.mailboxes[0]).toMatchObject({
          sendsOwed: 0,
          unknownSends: 0,
        })
      expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
      expect(owedSends((await work(h)).owed)).toEqual([])
      const id = (messages(h, '2001')[1] as { id: string }).id
      expect(asHttpish(await h.store.call('resolveSend', id, false, OWNER_EMAIL)).status).toBe(409)
      expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM setting WHERE key LIKE 'telegram-send:%'`)[0]?.n).toBe(0)
      const audit = (await ownerRequest(h, 'GET', '/api/audit')).json as {
        action: string
        after: { reason?: string }
      }[]
      expect(audit.find((a) => a.action === 'message.send-refused')?.after).toEqual({
        reason: 'the bridge was not running',
      })
    }
  })

  test('a send offered inside its five minutes is not expired, however long the offers go on', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    h.tick(4 * MIN + 59_000)
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
    h.tick(3 * MIN)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending'])
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
  })
})

describe('his own message in the chat settles the send waiting on it', () => {
  test('but only a send the bridge was offered: a phone message with the same words does not settle a send nothing has tried to send, which expires by itself', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    await feed(h, push([chat()], [message({ id: 60, out: true, text: WORDS, at: '2026-10-20T12:00:30Z' })]))
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending', 'sent'])
    h.tick(6 * MIN)
    expect(owedSends((await work(h)).owed)).toEqual([])
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft', 'sent'])
  })

  test('only exactly these words, in this chat, and not stamped before the claim by more than a clock’s skew', async () => {
    const h = harness()
    await feed(
      h,
      push(
        [chat(), chat({ id: '2002', name: 'Eli' })],
        [message({ id: 1, text: 'hi' }), message({ chatId: '2002', id: 2, text: 'hi' })],
      ),
    )
    unwrap(await press(h, '2001'))
    await work(h)
    // Other words; the same words in another chat; the same words ten minutes before the claim.
    await feed(
      h,
      push([chat()], [message({ id: 61, out: true, text: 'Friday works for me', at: '2026-10-20T12:00:30Z' })]),
    )
    await feed(
      h,
      push(
        [chat({ id: '2002', name: 'Eli' })],
        [message({ chatId: '2002', id: 62, out: true, text: WORDS, at: '2026-10-20T12:00:30Z' })],
      ),
    )
    await feed(h, push([chat()], [message({ id: 63, out: true, text: WORDS, at: '2026-10-20T11:50:00Z' })]))
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending', 'sent', 'sent'])
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
    // A minute before the claim is a clock's skew, not another message.
    await feed(h, push([chat()], [message({ id: 64, out: true, text: WORDS, at: '2026-10-20T11:59:00Z' })]))
    expect(messages(h, '2001').map((m) => m.status)).not.toContain('sending')
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('a send by Claude keeps its sender and its instruction when his own message in the chat is what settles it', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200)
    const draft = (
      await h.request(AGENT, 'POST', '/api/drafts', {
        conversationId: conversationOf(h, '2001'),
        body: WORDS,
        why: 'Because.',
      })
    ).json as { id: string; rev: number }
    const sent = await h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
      rev: draft.rev,
      through: (await detail(h, conversationOf(h, '2001'))).through,
      instruction: SAID,
    })
    expect(sent.status).toBe(200)
    await work(h)
    await feed(h, push([chat()], [message({ id: 80, out: true, text: WORDS, at: '2026-10-20T12:00:30Z' })]))
    expect(messages(h, '2001')[1]).toMatchObject({
      status: 'sent',
      sent_by: `agent:${AGENT_ID}`,
      instruction_text: SAID.text,
    })
  })
})

describe('what the bridge’s door will and will not do', () => {
  test('a draft is never offered: only a send Tessa pressed (or Claude on his word) is owed, and an outcome naming a draft changes nothing', async () => {
    const h = harness()
    await oneToOne(h)
    const id = conversationOf(h, '2001')
    const draft = await h.request(AGENT, 'POST', '/api/drafts', { conversationId: id, body: WORDS, why: 'She asked.' })
    expect(draft.status).toBe(201)
    expect(owedSends((await work(h)).owed)).toEqual([])
    expect(
      await outcomes(h, [
        { kind: 'send', messageId: draft.json.id, ok: true, telegramId: 5, at: '2026-10-20T12:00:02Z' },
      ]),
    ).toEqual({
      settled: 0,
      unknown: 1,
    })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
  })

  test('an outcome names a message the bridge was offered: it cannot make a draft sent, invent one, or settle a send twice', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const offered = owedSends((await work(h)).owed)[0] as { messageId: string }
    const ok = { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' }
    expect(await outcomes(h, [{ ...ok, messageId: 'no-such-message' }])).toEqual({ settled: 0, unknown: 1 })
    expect(await outcomes(h, [ok])).toEqual({ settled: 1, unknown: 0 })
    expect(await outcomes(h, [ok])).toEqual({ settled: 0, unknown: 1 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('the contract is bounded: a send outcome needs an id, Telegram’s message id and a time, or a short reason', async () => {
    const h = harness()
    const bad = async (o: unknown) => (await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: [o] })).status
    expect(await bad({ kind: 'send', ok: true, telegramId: 1, at: '2026-10-20T12:00:00Z' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', ok: true, telegramId: 0, at: '2026-10-20T12:00:00Z' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', ok: true, telegramId: 1, at: 'yesterday' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', ok: false })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', ok: false, reason: 'a message text with <markup> in it' })).toBe(
      422,
    )
    // The random id it was offered under is part of every send outcome.
    expect(await bad({ kind: 'send', messageId: 'a', ok: false, reason: 'USER_IS_BLOCKED' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', randomId: '0', ok: false, reason: 'USER_IS_BLOCKED' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', randomId: 'abc', ok: false, reason: 'USER_IS_BLOCKED' })).toBe(422)
    expect(await bad({ kind: 'send', messageId: 'a', randomId: '5', ok: false, reason: 'USER_IS_BLOCKED' })).toBe(200)
  })

  test('Claude’s token is refused on the bridge’s door and the bridge’s on Claude’s: neither machine can do the other’s work, sends included', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const id = (messages(h, '2001')[1] as { id: string }).id
    expect(
      (
        await h.bridge(AGENT, '/api/outcomes', {
          account,
          outcomes: [{ kind: 'send', messageId: id, ok: true, telegramId: 1, at: '2026-10-20T12:00:00Z' }],
        })
      ).status,
    ).toBe(403)
    expect((await h.bridge(AGENT, '/api/work', { account })).status).toBe(403)
    // The bridge's token cannot press Send on Claude's door either.
    expect((await h.request(BRIDGE, 'POST', `/api/drafts/${id}/send`, { rev: 0, through: 1 })).status).toBe(403)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sending'])
  })
})

describe('Claude’s send of a Telegram draft is the existing instructed send, and nothing more', () => {
  async function draftOf(h: H, chatId = '2001') {
    const res = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: conversationOf(h, chatId),
      body: WORDS,
      why: 'She asked to move it.',
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json as { id: string; rev: number }
  }
  const claudeSends = async (
    h: H,
    draft: { id: string; rev: number },
    over: Record<string, unknown> = {},
    chatId = '2001',
  ) =>
    h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
      rev: draft.rev,
      through: (await detail(h, conversationOf(h, chatId))).through,
      instruction: SAID,
      ...over,
    })
  const allow = async (h: H) =>
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200)

  test('with his switch off (how it ships) Claude’s send is refused, claims nothing, and the bridge is offered nothing', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    const draft = await draftOf(h)
    const sent = await claudeSends(h, draft)
    expect(sent.status).toBe(403)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('with the switch on but no instruction, or one that says nothing, it is refused the same way', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const draft = await draftOf(h)
    for (const instruction of [
      undefined,
      null,
      {},
      { text: '', where: 'x', at: SAID.at },
      { ...SAID, where: 'the inbox' },
    ]) {
      const sent = await claudeSends(h, draft, instruction === undefined ? { instruction: undefined } : { instruction })
      expect([403, 422]).toContain(sent.status)
    }
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft'])
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('with the switch on and his instruction recorded it is claimed with the instruction, offered to the bridge, and filed as sent by Claude on his word', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const draft = await draftOf(h)
    const sent = await claudeSends(h, draft)
    expect(sent.status, JSON.stringify(sent.json)).toBe(200)
    expect(sent.json).toMatchObject({ status: 'sending', instruction: { text: SAID.text, where: SAID.where } })

    const offered = owedSends((await work(h)).owed)
    expect(offered).toEqual([expect.objectContaining({ messageId: draft.id, text: WORDS, chatId: '2001' })])
    h.tick(1000)
    await outcomes(h, [{ kind: 'send', messageId: draft.id, ok: true, telegramId: 41, at: '2026-10-20T12:00:03Z' }])

    const filed = messages(h, '2001')[1]
    expect(filed).toMatchObject({
      status: 'sent',
      sent_by: `agent:${AGENT_ID}`,
      instruction_text: SAID.text,
      arrival_key: '2001:41',
    })
    const claudeSendsList = (await as(h, OWNER, 'GET', '/api/claude-sends')).json as {
      message: { id: string }
      proof: string
    }[]
    expect(claudeSendsList).toEqual([
      expect.objectContaining({ proof: 'filed', message: expect.objectContaining({ id: draft.id }) }),
    ])
    // The record before the outcome: the instruction is on the claim and audited.
    const audit = (await ownerRequest(h, 'GET', '/api/audit')).json as {
      action: string
      actor: string
      after: { instruction?: unknown }
    }[]
    expect(audit.find((a) => a.action === 'message.sending')).toMatchObject({
      actor: `agent:${AGENT_ID}`,
      after: { chat: '2001', instruction: { text: SAID.text, where: SAID.where } },
    })
  })

  test('switched off between the plan and the claim, or off after the claim: what was claimed stays claimed, but nothing new is', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const draft = await draftOf(h)
    expect((await claudeSends(h, draft)).status).toBe(200)
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: false })).status).toBe(200)
    // With the switch off the gate is the first thing asked, so a second press of the same draft and another draft are both refused by it.
    expect((await claudeSends(h, draft)).status).toBe(403)
    const other = await draftOf(h)
    expect((await claudeSends(h, other)).status).toBe(403)
    expect(owedSends((await work(h)).owed)).toHaveLength(1)
  })

  test('over a message that came in after Tessa spoke it is refused: go back to him', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const draft = await draftOf(h)
    // She writes again, after his instruction (12:04) and before Claude acts.
    h.tick(10 * MIN)
    await feed(h, push([chat()], [message({ id: 2, at: '2026-10-20T12:07:00Z', text: 'Wait, never mind.' })]))
    const sent = await claudeSends(h, draft)
    expect(sent.status).toBe(409)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'draft', 'sent'])
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('a draft anyone but Claude changed after the instruction is refused; Claude’s send names a stored draft and carries no text of its own', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const draft = await draftOf(h)
    const withText = await claudeSends(h, draft, { text: 'something else' })
    expect(withText.status).toBe(422)
    h.tick(6 * MIN)
    const edited = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, {
      rev: draft.rev,
      body: 'Tessa changed the words.',
    })
    expect(edited.status, JSON.stringify(edited.json)).toBe(200)
    const refused = await claudeSends(h, { id: draft.id, rev: edited.json.rev })
    expect(refused.status).toBe(409)
    expect(owedSends((await work(h)).owed)).toEqual([])
  })

  test('a channel and the service chat are refused to Claude too, and a group is sent to like a chat', async () => {
    const h = harness()
    await feed(
      h,
      push(
        [group(), channel()],
        [
          groupMessage({ id: 1, at: EARLY, sender: member('3001', 'Ana') }),
          message({ chatId: '-1009876543', id: 2, at: EARLY }),
        ],
      ),
    )
    await allow(h)
    const toChannel = await draftOf(h, '-1009876543')
    expect((await claudeSends(h, toChannel, {}, '-1009876543')).status).toBe(422)
    const toGroup = await draftOf(h, G)
    expect((await claudeSends(h, toGroup, {}, G)).status).toBe(200)
    expect(owedSends((await work(h)).owed)).toEqual([expect.objectContaining({ chatId: G, messageId: toGroup.id })])
  })

  test('Claude’s door has no route that reaches the bridge’s work: reading Telegram sends nothing and marks nothing', async () => {
    const h = harness()
    await oneToOne(h, { at: EARLY })
    await allow(h)
    const id = conversationOf(h, '2001')
    // Everything Claude can read about Telegram, read.
    for (const path of [
      `/api/conversations/${id}`,
      '/api/telegram',
      '/api/queue',
      '/api/drafts',
      '/api/claude-sends',
      '/api/search?q=move',
    ]) {
      expect((await h.request(AGENT, 'GET', path)).status, path).toBe(200)
    }
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent'])
    expect(owedSends((await work(h)).owed)).toEqual([])
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM setting WHERE key LIKE 'telegram-send:%'`)[0]?.n).toBe(0)
  })
})
