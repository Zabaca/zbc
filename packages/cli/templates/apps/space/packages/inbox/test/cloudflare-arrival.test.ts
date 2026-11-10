import { describe, expect, spyOn, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import { MAX_ARRIVAL_ATTEMPTS } from '../src/store/arrival'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, firstGmail, harness, mint, RIDGEWAY } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { rawMail } from '../test-support/raw-mail'

/**
 * Mail Cloudflare hands the Worker is stored once, with its raw
 * copy kept, threaded, readable through Claude's script, and Tessa's Gmail mail is untouched. The highest seam: the Worker's
 * entrance as a function (src/cloudflare/entrance.ts) over a bucket that can fail, the real arrival work and store over a
 * real SQLite with the real migrations, and the real router for everything read back.
 *
 * What this cannot show is Cloudflare: that it calls the handler with these arguments, what it does with a handler that
 * throws, what R2 does with `head` and `put`. Those are the hand test (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md).
 */

type H = ReturnType<typeof harness>

const FIRST_ID = '<CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com>'

const queue = async (h: H, filter = 'inbox') => (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json
const detail = async (h: H, id: string, who = AGENT) => (await h.request(who, 'GET', `/api/conversations/${id}`)).json
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n
/**
 * Read, close or reopen as Tessa: the Mailroom's `changeConversation` with him as the actor, which is what the space's entrypoint calls after it has admitted him (the owner has
 * no router). `through` is how far into the conversation he was shown, or absent.
 */
const asTessa = async (h: H, id: string, change: 'read' | 'close' | 'reopen', through?: number) =>
  asHttp(
    await h.store.call(
      'changeConversation',
      id,
      change,
      OWNER_EMAIL,
      Number.isInteger(through) ? (through as number) : null,
    ),
  )
const conversationIds = (h: H) => rows<{ id: string }>(h, 'SELECT id FROM conversation ORDER BY rowid').map((r) => r.id)

/** Claude's script, signing in as the service token, through the real app. */
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

describe('a message Tessa sends to the test address', () => {
  test('is stored once, with the raw copy kept exactly as it came, written before the store heard of it', async () => {
    const h = harness()
    const raw = rawMail('first')
    const { entered, rejected } = await h.deliver(raw)
    expect(entered).toBe('filed')
    expect(rejected).toBeNull()

    // The bucket holds the message byte for byte, under the hash of its bytes, with the envelope on it.
    expect(h.bucket.objects.size).toBe(1)
    const [key] = [...h.bucket.objects.keys()] as [string]
    expect(key).toMatch(/^in\/[0-9a-f]{64}$/)
    expect(h.bucket.text(key)).toBe(raw)
    expect(h.bucket.objects.get(key)?.metadata).toMatchObject({
      from: 'tessa@northfield.example',
      to: 'test@ridgewaycycles.example',
    })
    // Written first: the put is the first thing the bucket saw, and the store was asked only after it (the message
    // row names the key, and the bucket was read back from for the filing).
    expect(h.bucket.calls[0]).toBe(`head:${key}`)
    expect(h.bucket.calls[1]).toBe(`put:${key}`)
    expect(h.bucket.calls.indexOf(`get:${key}`)).toBeGreaterThan(1)

    const stored = rows<Record<string, unknown>>(h, 'SELECT * FROM message')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      direction: 'in',
      status: 'sent',
      subject: 'Hours question',
      rfc_message_id: FIRST_ID,
      arrival_key: FIRST_ID,
      raw_key: key,
      gmail_id: null,
      from_header: 'Tessa Marlow <tessa@northfield.example>',
      sent_at: '2026-10-20T12:00:00.000Z',
      sender_date: '2026-10-26T18:02:05.000Z',
      read_at: null,
      closed_at: null,
    })
    expect(String(stored[0]?.body)).toContain('Do you do the $40 tune-up walk-in?')
  })

  test('arrives unread and open in the Inbox, marked with its mailbox, under its sender', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const q = await queue(h)
    expect(q.rows).toHaveLength(1)
    expect(q.rows[0]).toMatchObject({
      title: 'Tessa Marlow',
      subject: 'Hours question',
      unread: true,
      open: true,
      mailbox: { name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' },
    })
    expect(q.rows[0].snippet).toContain('what are your hours on Saturdays')
    expect(q.filters[0]).toMatchObject({ id: 'inbox', count: 1, unread: 1 })
    // The mailbox row was made by the first mail, as a Cloudflare one, with no token.
    expect(rows(h, 'SELECT kind, address, display_name, refresh_token FROM mailbox')).toEqual([
      {
        kind: 'cloudflare',
        address: 'info@ridgewaycycles.example',
        display_name: 'Ridgeway Cycles',
        refresh_token: null,
      },
    ])
  })

  test('a second one from him, answering the first, threads onto it, and both are readable through the script with their raw copies', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    h.tick()
    expect((await h.deliver(rawMail('reply'))).entered).toBe('filed')

    expect(count(h, 'conversation')).toBe(1)
    expect(count(h, 'message')).toBe(2)
    expect(h.bucket.objects.size).toBe(2)

    const claude = script(h)
    const queueOut = await claude('queue')
    expect(queueOut.rows).toHaveLength(1)
    const convo = await claude('conversation', queueOut.rows[0].id)
    expect(convo.messages.map((m: { subject: string }) => m.subject)).toEqual(['Hours question', 'Re: Hours question'])
    expect(convo.mailbox).toMatchObject({ name: 'Ridgeway Cycles' })
    for (const m of convo.messages) {
      expect(m.rawKey).toMatch(/^in\/[0-9a-f]{64}$/)
      expect(h.bucket.objects.has(m.rawKey)).toBe(true)
    }
    expect(convo.messages[0].rawKey).not.toBe(convo.messages[1].rawKey)
    expect(convo.messages[1].body).toContain('is parking free?')
    // The script says which mailbox it is, and how the mailbox is doing.
    const boxes = await claude('mailboxes')
    expect(boxes.mailboxes).toHaveLength(1)
    expect(boxes.mailboxes[0]).toMatchObject({
      kind: 'cloudflare',
      address: 'info@ridgewaycycles.example',
      name: 'Ridgeway Cycles',
      messages: 2,
      conversations: 1,
      open: 1,
      unreadOpen: 1,
      owed: 0,
      lastFilingError: null,
      health: { amber: false },
    })
    expect(boxes.mailboxes[0].lastArrivalAt).toBe('2026-10-20T12:01:00.000Z')
  })

  test('a redelivery adds nothing: not a message, not a conversation, not a contact, not an object in the bucket', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const before = { m: count(h, 'message'), c: count(h, 'conversation'), p: count(h, 'contact'), a: count(h, 'audit') }
    const objects = [...h.bucket.objects.entries()]
    h.tick()
    expect((await h.deliver(rawMail('first'))).entered).toBe('duplicate')
    expect({
      m: count(h, 'message'),
      c: count(h, 'conversation'),
      p: count(h, 'contact'),
      a: count(h, 'audit'),
    }).toEqual(before)
    expect([...h.bucket.objects.entries()]).toEqual(objects)
    expect(h.bucket.calls.filter((c) => c.startsWith('put:'))).toHaveLength(1)
  })

  test('the same message with a different envelope (a second address on the domain) is still the same message', async () => {
    const h = harness()
    await h.deliver(rawMail('first'), { to: 'test@ridgewaycycles.example' })
    expect((await h.deliver(rawMail('first'), { to: 'info@ridgewaycycles.example' })).entered).toBe('duplicate')
    expect(count(h, 'message')).toBe(1)
  })

  test('a message with no Message-ID is told from another by its bytes, and a redelivery of it stores one', async () => {
    const h = harness()
    await h.deliver(rawMail('no-message-id'), { from: 'noreply@example.net', to: 'info@ridgewaycycles.example' })
    expect((await h.deliver(rawMail('no-message-id'), { to: 'info@ridgewaycycles.example' })).entered).toBe('duplicate')
    expect(count(h, 'message')).toBe(1)
    expect(
      String(
        (rows<{ arrival_key: string }>(h, 'SELECT arrival_key FROM message')[0] as { arrival_key: string }).arrival_key,
      ),
    ).toMatch(/^hash:[0-9a-f]{64}$/)
    // A different message with none either is a different message.
    await h.deliver('From: x@example.org\nTo: info@ridgewaycycles.example\nSubject: Hello\n\nA different one.\n')
    expect(count(h, 'message')).toBe(2)
  })

  test('mail to any address on the domain lands in the mailbox, and the sender is a contact', async () => {
    const h = harness()
    await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'billing@ridgewaycycles.example',
    })
    const q = await queue(h)
    expect(q.rows[0]).toMatchObject({ title: 'Priya Nair', mailbox: { address: 'info@ridgewaycycles.example' } })
    const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      name: 'Priya Nair',
      identities: [{ kind: 'email', address: 'priya.n@example.org' }],
    })
    // Our own addresses are on no conversation as people.
    const people = rows<{ address: string }>(
      h,
      'SELECT i.address FROM participant p JOIN identity i ON i.id = p.identity_id',
    )
    expect(people.map((p) => p.address)).toEqual(['priya.n@example.org'])
  })
})

describe('threading', () => {
  test('a reply that names a message the inbox never held starts a conversation of its own, unless the subject and a person match', async () => {
    const h = harness()
    await h.deliver(rawMail('reply'))
    expect(count(h, 'conversation')).toBe(1)
    expect(rows<{ in_reply_to: string }>(h, 'SELECT in_reply_to FROM message')[0]?.in_reply_to).toBe(FIRST_ID)
    // Somebody else answering the same unknown message, under the same subject, shares no outside person with it.
    const other = rawMail('reply')
      .replace('Tessa Marlow <tessa@northfield.example>', 'Priya Nair <priya.n@example.org>')
      .replace('CAF3b9xTt7yq0d1Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wh', 'PN-reply-1')
    await h.deliver(other, { from: 'priya.n@example.org' })
    expect(count(h, 'conversation')).toBe(2)
  })

  test('the same subject, from the same outside person, with no In-Reply-To, joins by subject', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    await h.deliver(rawMail('second-subject-only'))
    expect(count(h, 'conversation')).toBe(1)
    expect(count(h, 'message')).toBe(2)
  })

  test('two strangers who both wrote "Hours question" are two conversations', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    })
    expect(count(h, 'conversation')).toBe(2)
  })

  test('a message is never moved once filed, even when later mail would have placed it differently', async () => {
    const h = harness()
    await h.deliver(rawMail('second-subject-only'))
    await h.deliver(rawMail('first'))
    const before = rows<{ id: string; conversation_id: string }>(
      h,
      'SELECT id, conversation_id FROM message ORDER BY rowid',
    )
    await h.deliver(rawMail('reply'))
    const after = rows<{ id: string; conversation_id: string }>(
      h,
      'SELECT id, conversation_id FROM message ORDER BY rowid',
    )
    expect(after.slice(0, 2)).toEqual(before)
  })

  test('a reply to something the inbox sent is found too (a held message of ours counts)', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const convo = conversationIds(h)[0] as string
    // A message of ours, filed on the conversation with a Message-ID of its own, as a later step's send will.
    h.db.run(
      `INSERT INTO message (id, conversation_id, identity_id, direction, status, body, created_at, created_by, updated_at, updated_by,
                            mailbox_id, rfc_message_id)
       SELECT 'ours', ?1, identity_id, 'out', 'sent', 'Our reply', 't', 'x', 't', 'x', mailbox_id, '<ours-1@ridgewaycycles.example>'
         FROM message LIMIT 1`,
      [convo],
    )
    const answer = [
      'From: Priya Nair <priya.n@example.org>',
      'To: info@ridgewaycycles.example',
      'Subject: Totally different words',
      'Message-ID: <priya-2@example.org>',
      'In-Reply-To: <ours-1@ridgewaycycles.example>',
      '',
      'Thanks!',
    ].join('\n')
    await h.deliver(answer, { from: 'priya.n@example.org', to: 'info@ridgewaycycles.example' })
    expect(count(h, 'conversation')).toBe(1)
  })
})

describe('what is refused, and what is never lost', () => {
  test('mail for an address on no declared domain is refused outright: nothing kept, nothing filed', async () => {
    const h = harness()
    const { entered, rejected } = await h.deliver(rawMail('first'), { to: 'info@northfield.example' })
    expect(entered).toBe('refused')
    expect(rejected).toBeTruthy()
    expect(h.bucket.calls).toEqual([])
    expect(count(h, 'message')).toBe(0)
    expect(count(h, 'mailbox')).toBe(0)
    // A subdomain is not the domain.
    expect((await h.deliver(rawMail('first'), { to: 'info@mail.ridgewaycycles.example' })).entered).toBe('refused')
  })

  test('with no mailbox declared, or a declaration that is not valid, every arrival is refused', async () => {
    for (const mailboxes of [[], [{ address: 'info@ridgewaycycles.example' } as never]]) {
      const h = harness({}, { mailboxes })
      expect((await h.deliver(rawMail('first'))).entered).toBe('refused')
      expect(h.bucket.objects.size).toBe(0)
    }
  })

  test('a message that cannot be kept fails the entrance, and nothing is filed', async () => {
    const h = harness()
    h.bucket.failPut = true
    await expect(h.deliver(rawMail('first'))).rejects.toThrow('R2 would not write that')
    expect(count(h, 'message')).toBe(0)
    expect(count(h, 'mailbox')).toBe(0)
  })

  test('a message too large to read is refused, not read into memory', async () => {
    const h = harness()
    const { MAX_RAW_BYTES, receiveEmail } = await import('../src/cloudflare/entrance')
    let rejected = ''
    const entered = await receiveEmail(
      {
        from: 'a@example.com',
        to: 'info@ridgewaycycles.example',
        raw: new Response('x').body as ReadableStream<Uint8Array>,
        rawSize: MAX_RAW_BYTES + 1,
        setReject: (r) => {
          rejected = r
        },
      },
      {
        mailboxes: [{ ...RIDGEWAY, domain: 'ridgewaycycles.example' }],
        bucket: h.bucket,
        file: async () => ({ ok: true, value: { outcome: 'filed' } }),
        now: () => new Date(),
      },
    )
    expect(entered).toBe('refused')
    expect(rejected).toContain('larger')
    expect(h.bucket.calls).toEqual([])
  })

  test('when filing fails the raw copy is kept, the entrance does not fail, the debt is recorded, and the alarm files it later under the time it arrived', async () => {
    const h = harness()
    h.bucket.failGet = true
    const { entered } = await h.deliver(rawMail('first'))
    expect(entered).toBe('owed')
    expect(h.bucket.objects.size).toBe(1)
    expect(count(h, 'message')).toBe(0)

    const owed = rows<Record<string, unknown>>(h, 'SELECT * FROM arrival_owed')
    expect(owed).toHaveLength(1)
    expect(owed[0]).toMatchObject({
      envelope_from: 'tessa@northfield.example',
      envelope_to: 'test@ridgewaycycles.example',
      received_at: '2026-10-20T12:00:00.000Z',
      attempts: 1,
    })
    // The mailbox says so, so a quiet mailbox that is broken is not mistaken for a quiet one.
    const claude = script(h)
    const status = (await claude('mailboxes')).mailboxes[0]
    expect(status).toMatchObject({ owed: 1, lastFilingError: 'R2 would not read that', health: { amber: true } })
    expect(status.health.reasons[0]).toContain('kept safe but not filed')
    expect(h.alarms.at(-1)?.getTime()).toBe(Date.parse('2026-10-20T12:00:30.000Z'))

    // Not yet due: the alarm at once does nothing and asks for the same time again.
    await h.arrivals.runOwed()
    expect(count(h, 'message')).toBe(0)

    // The bucket recovers; the alarm comes due, a long while later, and the message is filed as received then.
    h.bucket.failGet = false
    h.tick(20 * 60_000)
    await h.drain()
    expect(count(h, 'message')).toBe(1)
    expect(count(h, 'arrival_owed')).toBe(0)
    expect(rows<{ sent_at: string }>(h, 'SELECT sent_at FROM message')[0]?.sent_at).toBe('2026-10-20T12:00:00.000Z')
    // The failure is over, so the mailbox no longer reports it.
    expect((await claude('mailboxes')).mailboxes[0]).toMatchObject({
      owed: 0,
      gaveUp: 0,
      lastFilingError: null,
      lastFilingErrorAt: null,
      health: { amber: false },
      messages: 1,
    })
  })

  test('a retry that fails again backs off and counts the attempt', async () => {
    const h = harness()
    h.bucket.failGet = true
    await h.deliver(rawMail('first'))
    h.tick(31_000)
    await h.arrivals.runOwed()
    h.tick(61_000)
    await h.arrivals.runOwed()
    const owed = rows<{ attempts: number; next_try_at: string }>(h, 'SELECT attempts, next_try_at FROM arrival_owed')
    expect(owed[0]?.attempts).toBe(3)
    // 30s, then 1m, then 2m after the third failure.
    expect(Date.parse((owed[0] as { next_try_at: string }).next_try_at) - h.now()).toBe(120_000)
    expect(count(h, 'message')).toBe(0)
  })

  test('a message that can never be filed is given up on after a bounded number of tries: kept, counted as unfiled, no longer retried', async () => {
    const h = harness()
    const poison = 'Subject: nobody\n\nNo From and no To, and no address anywhere.\n'
    expect((await h.deliver(poison)).entered).toBe('owed')
    for (let attempt = 2; attempt <= MAX_ARRIVAL_ATTEMPTS; attempt += 1) {
      h.tick(2 * 60 * 60_000)
      await h.arrivals.runOwed()
    }
    const row = rows<{ attempts: number; gave_up_at: string | null }>(
      h,
      'SELECT attempts, gave_up_at FROM arrival_owed',
    )[0]
    expect(row?.attempts).toBe(MAX_ARRIVAL_ATTEMPTS)
    expect(row?.gave_up_at).not.toBeNull()

    // Nothing retries it, nothing is scheduled for it, and the raw copy is still there.
    expect(h.inbox.owedArrivals(new Date(h.now() + 365 * 86_400_000).toISOString())).toEqual([])
    expect(h.inbox.nextOwedAt()).toBeNull()
    const alarmsBefore = h.alarms.length
    h.tick(3 * 60 * 60_000)
    await h.arrivals.runOwed()
    expect(h.alarms.length).toBe(alarmsBefore)
    expect(rows<{ attempts: number }>(h, 'SELECT attempts FROM arrival_owed')[0]?.attempts).toBe(MAX_ARRIVAL_ATTEMPTS)
    expect(h.bucket.objects.size).toBe(1)

    // The mailbox keeps saying so: unfiled, not retrying, amber, with the error.
    const status = (await script(h)('mailboxes')).mailboxes[0]
    expect(status).toMatchObject({ owed: 0, gaveUp: 1, health: { amber: true } })
    expect(status.health.reasons[0]).toContain(`could not be filed after ${MAX_ARRIVAL_ATTEMPTS} tries`)
    expect(status.lastFilingError).toContain('names no email address')
  })

  test('the last filing error stays while anything is still owed, and goes when the last one is filed', async () => {
    const h = harness()
    h.bucket.failGet = true
    await h.deliver(rawMail('first'))
    await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    })
    expect(count(h, 'arrival_owed')).toBe(2)
    h.bucket.failGet = false
    // One is filed by its own delivery arriving again; the other is still owed.
    h.tick(20 * 60_000)
    expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
    const claude = script(h)
    expect((await claude('mailboxes')).mailboxes[0]).toMatchObject({
      owed: 1,
      lastFilingError: 'R2 would not read that',
    })
    await h.drain()
    expect((await claude('mailboxes')).mailboxes[0]).toMatchObject({ owed: 0, lastFilingError: null })
    expect(count(h, 'message')).toBe(2)
  })

  test('a message that cannot be parsed into anyone is owed, and the raw copy is all there is to look at', async () => {
    const h = harness()
    const { entered } = await h.deliver('Subject: nobody\n\nNo From and no To, and no address anywhere.\n')
    expect(entered).toBe('owed')
    expect(count(h, 'message')).toBe(0)
    expect(count(h, 'conversation')).toBe(0)
    expect(count(h, 'arrival_owed')).toBe(1)
  })

  test('when the store itself is unreachable, the raw copy is kept and the entrance fails (nothing could even record the debt)', async () => {
    const h = harness()
    h.inbox.cloudflareMailbox = () => {
      throw new Error('the Durable Object is not reachable')
    }
    const logged: string[] = []
    const spy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => void logged.push(args.map(String).join(' ')),
    )
    try {
      await expect(h.deliver(rawMail('first'))).rejects.toThrow('not reachable')
    } finally {
      spy.mockRestore()
    }
    expect(h.bucket.objects.size).toBe(1)
    // The tail names the kept copy, so a sitting that counts these can find the one nothing filed.
    const key = [...h.bucket.objects.keys()][0]
    expect(logged.some((l) => l.includes(`email: kept ${key} but the inbox could not be asked to file it`))).toBe(true)
  })

  test('filing is one transaction: a failure part way leaves no conversation, no contact and no message behind', async () => {
    const h = harness()
    // The identity step succeeds and the message insert is refused: the unique index on arrival keys.
    await h.deliver(rawMail('first'))
    h.db.run('DROP INDEX message_arrival_idx')
    h.db.run(`CREATE TRIGGER refuse BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    const before = { c: count(h, 'conversation'), p: count(h, 'contact'), pa: count(h, 'participant') }
    const { entered } = await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    })
    expect(entered).toBe('owed')
    expect({ c: count(h, 'conversation'), p: count(h, 'contact'), pa: count(h, 'participant') }).toEqual(before)
  })
})

describe('read and closed are the inbox’s own stamps', () => {
  const shown = async (h: H, id: string) => ((await detail(h, id)) as { through: number }).through

  test('opening marks it read, as Tessa; Close closes it; a new message reopens it, unread', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const id = conversationIds(h)[0] as string
    h.tick()
    const read = await asTessa(h, id, 'read', await shown(h, id))
    expect(read.status).toBe(200)
    expect(read.json).toMatchObject({ unread: false, open: true, readBy: 'tessa@northfield.example' })
    h.tick()
    const closed = await asTessa(h, id, 'close', await shown(h, id))
    expect(closed.json).toMatchObject({ open: false, closedBy: 'tessa@northfield.example' })
    expect((await queue(h)).rows).toHaveLength(0)
    expect((await queue(h, 'closed')).rows).toHaveLength(1)

    h.tick()
    await h.deliver(rawMail('reply'))
    const after = await detail(h, id)
    expect(after).toMatchObject({ unread: true, open: true, readBy: null, closedBy: null })
    expect((await queue(h)).rows).toHaveLength(1)
  })

  test('Claude reading marks nothing, and has no way to mark read at all (the route is gone); closing and reopening are open to it', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const id = conversationIds(h)[0] as string
    const before = JSON.stringify(rows(h, 'SELECT read_at, read_by, closed_at, closed_by FROM message'))
    await detail(h, id, AGENT as never)
    await script(h)('queue')
    expect(JSON.stringify(rows(h, 'SELECT read_at, read_by, closed_at, closed_by FROM message'))).toBe(before)
    expect(
      (await h.request(AGENT, 'POST', `/api/conversations/${id}/read`, { through: await shown(h, id) })).status,
    ).toBe(404)
    expect(JSON.stringify(rows(h, 'SELECT read_at, read_by, closed_at, closed_by FROM message'))).toBe(before)
    const closed = await h.request(AGENT, 'POST', `/api/conversations/${id}/close`, { through: await shown(h, id) })
    expect(closed.status).toBe(200)
    expect(closed.json).toMatchObject({ open: false, closedBy: `agent:${AGENT_ID}` })
    expect((await h.request(AGENT, 'POST', `/api/conversations/${id}/reopen`, {})).json).toMatchObject({ open: true })
  })

  test('a read or close from a page that was not shown the newest message is refused, and changes nothing', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const id = conversationIds(h)[0] as string
    const stale = await shown(h, id)
    h.tick()
    await h.deliver(rawMail('reply'))
    for (const what of ['read', 'close'] as const) {
      const res = await asTessa(h, id, what, stale)
      expect(res.status, what).toBe(409)
    }
    expect(await detail(h, id)).toMatchObject({ unread: true, open: true })
    // Without a `through` it is refused too, so no caller can leave the check out; further than the conversation goes is refused.
    expect((await asTessa(h, id, 'close')).status).toBe(422)
    expect((await asTessa(h, id, 'close', 9999)).status).toBe(422)
  })

  test('a change that is already so costs nothing and writes no audit entry', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    const id = conversationIds(h)[0] as string
    await asTessa(h, id, 'read', await shown(h, id))
    const audits = count(h, 'audit')
    expect((await asTessa(h, id, 'read', await shown(h, id))).status).toBe(200)
    expect(count(h, 'audit')).toBe(audits)
  })
})

/** The no-message-id fixture from a person's address and with no unsubscribe header: the same message, minus what makes it Bulk. */
const plainMail = (from: string) =>
  rawMail('no-message-id')
    .replace(/^List-Unsubscribe:.*\r\n/m, '')
    .replace(/noreply@example\.net/g, from)

describe('the views', () => {
  const arrive = async (h: H) => {
    await h.deliver(rawMail('first'))
    await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    })
    await h.deliver(plainMail('dana@example.net'), { from: 'dana@example.net', to: 'info@ridgewaycycles.example' })
  }
  /** What Clef said of a conversation's messages, written as the entrance writes it (the spam check's own tests drive the real call). */
  const judged = (h: H, conversationId: string, junk: number) =>
    h.db.run(
      `UPDATE message SET clef_junk = ?, clef_category = 'vendor_pitch', clef_model = '@cf/cloudflare/clef' WHERE conversation_id = ?`,
      [junk, conversationId],
    )
  const mailboxView = (q: { filters: { id: string; label: string }[] }) =>
    q.filters.find((f) => f.id.startsWith('mailbox:')) as { id: string; label: string; count: number; unread: number }

  test('a Ridgeway view lists that mailbox’s open conversations that are not Bulk, with counts from the same facts', async () => {
    const h = harness()
    await arrive(h)
    const q = await queue(h)
    expect(q.filters.map((f: { id: string }) => f.id)).toEqual([
      'inbox',
      'unread',
      'drafts',
      'bulk',
      'closed',
      expect.stringMatching(/^mailbox:/),
    ])
    expect(mailboxView(q)).toMatchObject({ label: 'Ridgeway Cycles', count: 3, unread: 3 })
    const view = await queue(h, mailboxView(q).id)
    expect(view.filter).toBe(mailboxView(q).id)
    expect(view.rows).toHaveLength(3)
    expect(view.rows.length).toBe(mailboxView(q).count)
  })

  test('Bulk for a Cloudflare mailbox is the queue’s one rule: Clef at 0.80 or more, or a person’s call, is spam; below it, or not judged, is not', async () => {
    const h = harness()
    await arrive(h)
    const [a, b, c] = conversationIds(h) as [string, string, string]
    judged(h, a, 0.8)
    judged(h, c, 0.79)
    expect((await h.store.call('setSpam', b, true, OWNER_EMAIL).then(asHttp)).status).toBe(200)
    let q = await queue(h)
    expect(q.rows.map((r: { id: string }) => r.id)).toEqual([c])
    const bulk = await queue(h, 'bulk')
    expect(bulk.rows.map((r: { id: string }) => r.id).sort()).toEqual([a, b].sort())
    expect(bulk.rows.every((r: { bulk: boolean; spam: boolean }) => r.bulk && r.spam)).toBe(true)
    expect(q.filters.find((f: { id: string }) => f.id === 'bulk')).toMatchObject({ count: 2 })
    // The Ridgeway view leaves Bulk out as the Inbox does, and the row says it is spam.
    expect((await queue(h, mailboxView(q).id)).rows).toHaveLength(1)
    expect((await queue(h)).rows[0].spam).toBeUndefined()
    judged(h, c, 0.97)
    q = await queue(h)
    expect(q.rows).toHaveLength(0)
    expect((await detail(h, c)) as { spam: boolean; bulk: boolean }).toMatchObject({ spam: true, bulk: true })
  })

  test('the mailbox’s status counts as its view does, Bulk left out, so Settings and the menu agree', async () => {
    const h = harness()
    await arrive(h)
    const [a] = conversationIds(h) as [string]
    judged(h, a, 0.9)
    const view = mailboxView(await queue(h))
    expect(view).toMatchObject({ count: 2, unread: 2 })
    const status = (await h.request(AGENT, 'GET', '/api/mailboxes')).json.mailboxes[0]
    // Three conversations are held, two are in the view: the third is Bulk.
    expect(status).toMatchObject({ conversations: 3, open: view.count, unreadOpen: view.unread })
    expect(status.assistant).toMatchObject({ enabled: false, judged: 1 })
  })

  test('each contact says which Cloudflare mailboxes it is in, none for a contact only Gmail knows (Contacts’ filter by mailbox)', async () => {
    const h = harness()
    await arrive(h)
    const id = mailboxView(await queue(h)).id.slice('mailbox:'.length)
    const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json as { name: string; mailboxIds: string[] }[]
    expect(contacts.length).toBeGreaterThan(0)
    for (const c of contacts) expect(c.mailboxIds, c.name).toEqual([id])
    h.google.mailbox.add({
      id: 'g1',
      threadId: 'tg',
      labels: ['INBOX', 'UNREAD'],
      from: 'Ann <ann@example.com>',
      subject: 'Gmail one',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const after = (await h.request(AGENT, 'GET', '/api/contacts')).json as { name: string; mailboxIds: string[] }[]
    expect(after.find((c) => c.name === 'Ann')?.mailboxIds).toEqual([])
    expect(after.filter((c) => c.mailboxIds.length > 0)).toHaveLength(contacts.length)
  })

  test('a List-Unsubscribe header, or an automated sender, is Bulk with no model involved, and a message nothing judged is not Bulk', async () => {
    const h = harness()
    await h.deliver(rawMail('no-message-id'), { from: 'noreply@example.net', to: 'info@ridgewaycycles.example' })
    await h.deliver(plainMail('noreply@example.net').replace('Subject: Your digest', 'Subject: Another'), {
      from: 'noreply@example.net',
      to: 'info@ridgewaycycles.example',
    })
    await h.deliver(plainMail('dana@example.net').replace('Subject: Your digest', 'Subject: Hello'), {
      from: 'dana@example.net',
      to: 'info@ridgewaycycles.example',
    })
    const bulk = (await queue(h, 'bulk')).rows
    expect(bulk).toHaveLength(2)
    for (const r of bulk) {
      expect(r.bulk).toBe(true)
      // Bulk by a rule is not called spam: the tag says spam only when Clef or a person said so.
      expect(r.spam).toBeUndefined()
    }
    const reasons = await Promise.all(bulk.map(async (r: { id: string }) => (await detail(h, r.id)).reasons))
    expect(reasons).toContainEqual([
      'Bulk mail: it carries a List-Unsubscribe header.',
      expect.stringMatching(/^Automated sender: /),
    ])
    expect(reasons).toContainEqual([expect.stringMatching(/^Automated sender: /)])
    const inbox = (await queue(h)).rows
    expect(inbox).toHaveLength(1)
    expect(inbox[0].bulk).toBe(false)
  })

  test('a Client’s person is exempt from Bulk, as everywhere', async () => {
    const h = harness()
    await h.deliver(rawMail('stranger-same-subject'), {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    })
    const id = conversationIds(h)[0] as string
    judged(h, id, 0.99)
    expect((await queue(h)).rows).toHaveLength(0)
    const contact = (await h.request(AGENT, 'GET', '/api/contacts')).json[0].id
    expect((await h.request(AGENT, 'PUT', `/api/contacts/${contact}/client`, { clientId: 1 })).status).toBe(200)
    expect((await queue(h)).rows).toHaveLength(1)
    expect((await detail(h, id)).reasons).toEqual([
      'Clef: selling something (0.99).',
      'Kept in the Inbox: a Client’s contact is on it.',
    ])
  })

  test('Closed, Unread and the counts cover both mailboxes: one list however many feed it', async () => {
    const h = harness()
    await arrive(h)
    const ids = conversationIds(h)
    h.tick()
    const through = ((await detail(h, ids[0] as string)) as { through: number }).through
    await h.request(AGENT, 'POST', `/api/conversations/${ids[0]}/close`, { through })
    const q = await queue(h)
    expect(q.filters.find((f: { id: string }) => f.id === 'inbox')).toMatchObject({ count: 2 })
    expect(q.filters.find((f: { id: string }) => f.id === 'closed')).toMatchObject({ count: 1 })
    expect(mailboxView(q)).toMatchObject({ count: 2 })
  })

  test('with no Cloudflare mailbox there is no Ridgeway view and a mailbox view id is any unknown filter', async () => {
    const h = harness()
    const q = await queue(h, 'mailbox:nope')
    expect(q.filter).toBe('inbox')
    expect(q.filters.map((f: { id: string }) => f.id)).toEqual(['inbox', 'unread', 'drafts', 'bulk', 'closed'])
  })
})

describe('Tessa’s Gmail mailbox is untouched', () => {
  const connectGmail = async (h: H) => {
    h.google.mailbox.add({
      id: 'g1',
      threadId: 'tg',
      labels: ['INBOX', 'UNREAD'],
      from: 'Ann <ann@example.com>',
      subject: 'Gmail one',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
  }

  test('with Ridgeway’s mailbox row first in the table, "the mailbox" is still Tessa’s Gmail one, and /api/mailbox says so', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    expect(rows<{ kind: string }>(h, 'SELECT kind FROM mailbox ORDER BY rowid')[0]?.kind).toBe('cloudflare')
    await connectGmail(h)
    expect(rows<{ kind: string }>(h, 'SELECT kind FROM mailbox ORDER BY rowid').map((r) => r.kind)).toEqual([
      'cloudflare',
      'gmail',
    ])

    const status = (await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0]
    expect(status).toMatchObject({
      kind: 'gmail',
      address: 'tessa@northfield.example',
      connected: true,
      state: 'live',
      messages: 1,
      conversations: 1,
    })
    expect(firstGmail(h.inbox)?.kind).toBe('gmail')
    // Ridgeway's counts are its own.
    expect((await script(h)('mailboxes')).mailboxes[0]).toMatchObject({
      kind: 'cloudflare',
      messages: 1,
      conversations: 1,
    })
  })

  test('both kinds are in one Inbox, each row carries the mailbox it came through, and Gmail’s conversation still takes its state from Gmail', async () => {
    const h = harness()
    await h.deliver(rawMail('first'))
    await connectGmail(h)
    const q = await queue(h)
    expect(q.rows).toHaveLength(2)
    const gmailRow = q.rows.find((r: { subject: string }) => r.subject === 'Gmail one')
    const ridgewayRow = q.rows.find((r: { subject: string }) => r.subject === 'Hours question')
    expect(gmailRow.mailbox).toMatchObject({ name: 'northfield', address: 'tessa@northfield.example' })
    expect('spam' in gmailRow).toBe(false)
    expect(ridgewayRow.mailbox.name).toBe('Ridgeway Cycles')
    // Reading Gmail's goes to Gmail first, as it always did; reading Ridgeway's never asks Google anything.
    const calls = h.google.calls.length
    const through = (await detail(h, ridgewayRow.id)).through
    expect((await asTessa(h, ridgewayRow.id, 'read', through)).status).toBe(200)
    expect(h.google.calls.length).toBe(calls)
    const gThrough = (await detail(h, gmailRow.id)).through
    expect((await asTessa(h, gmailRow.id, 'read', gThrough)).status).toBe(200)
    expect(h.google.calls.some((c) => c.startsWith('thread-read'))).toBe(true)
  })

  test('connecting Gmail, a push and the Gmail sync never touch a Cloudflare mailbox, and a store with only Gmail has no Cloudflare field anywhere', async () => {
    const h = harness()
    await connectGmail(h)
    const q = await queue(h)
    expect(JSON.stringify(q)).not.toMatch(/mailbox:|"spam"|"rawKey"/)
    expect((await h.request(AGENT, 'GET', '/api/mailboxes')).json).toEqual({ mailboxes: [] })
    expect((await h.push()).status).toBe(204)
  })
})

describe('the entrance is no route', () => {
  test('nothing in the API files a message: it is Cloudflare’s call to the Worker and nothing else', async () => {
    const h = harness()
    for (const path of ['/api/arrivals', '/api/arrivals/file', '/api/mailbox/arrive', '/api/email']) {
      expect((await h.request(AGENT, 'POST', path, { rawKey: 'in/x' })).status).toBe(404)
    }
    expect(count(h, 'message')).toBe(0)
  })
})
