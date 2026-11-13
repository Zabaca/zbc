import { describe, expect, test } from 'bun:test'
import { refusedReason } from '../src/jmap/room'
import type { MessageRow } from '../src/types'
import { present } from '../test-support/fake-jmap'
import { AGENT, AGENT_ID, harness, ownerDraft, T0 } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { ownerRequest } from '../test-support/owner-requests'

/**
 * Sending through the mail server, the third transport (decisions 13 and 18): the same plan, claim, single attempt and filing as Gmail's and Cloudflare's, through the server's submission, filed in its Sent. What is proved:
 * a reply goes out from the mailbox's own address and name with the headers a reply needs and lands in the mailbox's Sent, held once; a refusal puts the draft back and removes the unsent copy; an answer that never came
 * leaves it `sending` for Tessa to say, and is settled by the server's own copy; Tessa's instruction rule is exactly the store's (the switch, the recorded instruction, the draft as it stood); the transports never cross; and
 * a mailbox the server refused sends nothing. What this cannot show is Stalwart and Cloudflare (the live check: one real Send from the space to Tessa's Gmail, packages/inbox/docs/runbooks/inbox-jmap-mailbox.md).
 */

type H = ReturnType<typeof harness>

const jh = (options: Parameters<typeof harness>[1] = {}) => harness({}, { jmap: true, ...options })
const ADDRESS = 'test@harborline.example'
const AGENT_ACTOR = `agent:${AGENT_ID}`
const WORDS = 'Thanks Dana. Tuesday works for me.'
const DASH = '\u2014'
/** What Claude records: Tessa's words, where, and when (after every message the tests store, inside the five minutes of skew). */
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string): number =>
  (h.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
const conversationOf = (h: H, jmapId: string): string =>
  (h.db.query(`SELECT conversation_id AS id FROM message WHERE jmap_id = ?`).get(jmapId) as { id: string }).id
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const through = (h: H, id: string): number => {
  const detail = h.inbox.getConversation(id)
  if (!detail.ok) throw new Error(detail.error)
  return detail.value.through
}
/** Everything a refused send must leave alone, as one string to compare. */
const snapshot = (h: H) =>
  JSON.stringify([
    h.db.query('SELECT * FROM message ORDER BY rowid').all(),
    h.db.query('SELECT * FROM conversation ORDER BY rowid').all(),
    h.db.query('SELECT * FROM participant ORDER BY rowid').all(),
  ])

async function live(h: H) {
  await h.jmapRoom.requestJmapSync()
  await h.drain()
  expect(h.jmapRoom.jmapMailboxes()[0]?.state).toBe('live')
}

/** Dana wrote to the mailbox; her conversation, and the mailbox's id. */
async function world(options: Parameters<typeof harness>[1] = {}) {
  const h = jh(options)
  const dana = h.jmapServer.deliver({
    subject: 'Quote for the shop',
    from: 'Dana Smith <dana@example.com>',
    to: `Test <${ADDRESS}>`,
    messageId: '<q1@example.com>',
    at: T0 - 2000,
  })
  await live(h)
  return { h, dana, conversation: conversationOf(h, dana), mailboxId: h.inbox.jmapRows()[0]?.id }
}

async function reply(h: H, conversationId: string, extra: Record<string, unknown> = {}): Promise<MessageRow> {
  const res = await ownerDraft(h, { conversationId, body: WORDS, ...extra })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json
}

/** Press Send as the page does: the revision it drew the draft from, and how far into the conversation it reached. */
const press = (
  h: H,
  draft: MessageRow,
  over: Record<string, unknown> = {},
  who: string = OWNER_EMAIL,
  reached?: number | null,
) =>
  h.mailroom.sendDraft(
    draft.id,
    {
      rev: draft.rev,
      through:
        reached === undefined ? (draft.conversationId === null ? null : through(h, draft.conversationId)) : reached,
      ...(who === AGENT_ACTOR && { instruction: SAID }),
      ...over,
    } as never,
    who,
  )

describe('a reply from the mailbox', () => {
  test('goes out from its own address and its declared name, with the reply headers, and is in the mailbox’s Sent, filed once as sent, read and closed by Tessa', async () => {
    const { h, dana, conversation, mailboxId } = await world()
    const draft = await reply(h, conversation)
    // the draft says what it will do, on its face
    expect(draft).toMatchObject({
      address: 'dana@example.com',
      subject: 'Re: Quote for the shop',
      sendsFrom: { name: 'harborline', address: ADDRESS },
    })
    expect(h.inbox.sendTransportOf(draft.id)).toBe('jmap')

    const res = await press(h, draft)
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true })

    // one submission, from the mailbox, to Dana, with the headers a reply carries; the Message-ID is the inbox's own
    expect(h.jmapServer.submitted).toHaveLength(1)
    const out = present(h.jmapServer.submitted[0])
    expect(out).toMatchObject({ from: ADDRESS, to: ['dana@example.com'], cc: [] })
    expect(out.raw).toContain('From: harborline <test@harborline.example>')
    expect(out.raw).toContain('Subject: Re: Quote for the shop')
    expect(out.raw).toContain('In-Reply-To: <q1@example.com>')
    expect(out.raw).toContain('References: <q1@example.com>')
    expect(out.raw).toMatch(/Message-ID: <id-\d+@harborline\.example>/)
    expect(out.raw).toContain(WORDS)
    // the server filed it in the mailbox's Sent, not in Drafts, and not twice
    const made = present(h.jmapServer.emails.get(out.emailId))
    expect(Object.keys(made.mailboxIds)).toEqual([h.jmapServer.folder('sent')])
    expect(made.keywords).toEqual({ $seen: true })
    expect(h.jmapServer.inFolder('drafts')).toEqual([])
    expect(h.jmapServer.inFolder('sent')).toEqual([out.emailId])

    // filed under the server's id, in Dana's conversation, as the mailbox's own
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      jmap_id: out.emailId,
      gmail_id: null,
      mailbox_id: mailboxId,
      conversation_id: conversation,
      sent_by: OWNER_EMAIL,
      direction: 'out',
    })
    expect(JSON.parse(String(row(h, draft.id)?.labels))).toEqual(['SENT'])
    expect(row(h, draft.id)?.rfc_message_id).toBe(made.messageId)
    expect(h.inbox.listConversations([conversation])[0]).toMatchObject({ unread: true })

    // the sync that finds the server's copy changes nothing, and the push for it neither
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    expect(count(h, 'message')).toBe(2)
    expect(rows(h, `SELECT count(*) AS n FROM message WHERE jmap_id = '${out.emailId}'`)).toEqual([{ n: 1 }])
    // nothing went through the other two transports
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(h.email.handed).toHaveLength(0)
    expect(dana).toBeDefined()
  })

  test('a reply to everyone copies the people on the message but never the mailbox, its aliases or its domain', async () => {
    const h = jh()
    const m = h.jmapServer.deliver({
      subject: 'Group',
      from: 'Dana <dana@example.com>',
      to: `Test <${ADDRESS}>, Info <info@harborline.example>`,
      cc: 'Ann <ann@example.org>, postmaster@harborline.example',
      messageId: '<g1@example.com>',
      at: T0 - 2000,
    })
    await live(h)
    const draft = await reply(h, conversationOf(h, m), { copyEveryone: true })
    expect(draft.cc).toBe('ann@example.org')
    expect(await press(h, draft)).toMatchObject({ ok: true })
    expect(h.jmapServer.submitted[0]).toMatchObject({ to: ['dana@example.com'], cc: ['ann@example.org'] })
  })

  test('an explicit Cc is delivered by the server’s submission, less the mailbox’s own address and its whole domain’s, which are dropped from the draft when it is made', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation, {
      cc: ['Ann@Example.org', ADDRESS, 'anyone@harborline.example', 'dana@example.com', 'cy@example.net'],
    })
    expect(draft.cc).toBe('ann@example.org, cy@example.net')
    expect(await press(h, draft)).toMatchObject({ ok: true })
    expect(h.jmapServer.submitted[0]).toMatchObject({
      to: ['dana@example.com'],
      cc: ['ann@example.org', 'cy@example.net'],
    })
  })

  test('an address of the mailbox, or on its domain, cannot be drafted to on its conversation, and if one is on a draft anyway the send is refused before anything is claimed', async () => {
    const { h, conversation } = await world()
    for (const own of ['info@harborline.example', 'anyone@harborline.example', ADDRESS]) {
      const res = await ownerDraft(h, { conversationId: conversation, body: WORDS, address: own })
      expect(res.status).toBe(422)
    }
    for (const own of ['info@harborline.example', 'anyone@harborline.example']) {
      const draft = await reply(h, conversation)
      h.db.run('UPDATE message SET cc_header = ? WHERE id = ?', [own, draft.id])
      const before = snapshot(h)
      const res = await press(h, draft)
      expect(res).toMatchObject({ ok: false, status: 422 })
      expect(snapshot(h)).toBe(before)
    }
    expect(h.jmapServer.submitted).toHaveLength(0)
  })

  test('a new email goes out from the mailbox the person chose, to a new conversation under the server’s thread', async () => {
    const { h, mailboxId } = await world()
    const made = await ownerDraft(h, { address: 'lane@example.net', subject: 'Hello Lane', body: 'A note.', name: 'Lane' })
    expect(made.status).toBe(201)
    // composed with the mailbox chosen, as the space's compose box does
    const chosen = await h.store.call(
      'createDraft',
      {
        address: 'lane@example.net',
        subject: 'Hello Lane',
        body: 'A note.',
        sendFrom: { kind: 'business', mailboxId },
      } as never,
      OWNER_EMAIL,
    )
    expect(chosen).toMatchObject({ ok: true })
    const draft = (chosen as { value: MessageRow }).value
    expect(h.inbox.sendTransportOf(draft.id)).toBe('jmap')
    expect(await press(h, draft, {}, OWNER_EMAIL, null)).toMatchObject({ ok: true })
    expect(h.jmapServer.submitted).toHaveLength(1)
    expect(h.jmapServer.submitted[0]).toMatchObject({ from: ADDRESS, to: ['lane@example.net'] })
    const conversation = row(h, draft.id)?.conversation_id as string
    expect(h.db.query(`SELECT jmap_thread_id AS t FROM conversation WHERE id = ?`).get(conversation)).toEqual({
      t: h.jmapServer.emails.get(present(h.jmapServer.submitted[0]).emailId)?.threadId,
    })
    expect(h.inbox.listConversations([conversation])[0]).toMatchObject({
      open: false,
      unread: false,
      mailboxKind: 'jmap',
    })
  })
})

describe('what can go wrong', () => {
  test('the server refuses the submission: the draft is a draft again, the unsent copy is removed from the server, nothing is in Sent, and the words say so', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.refuseSubmission = 'forbiddenFrom'
    const before = JSON.stringify(
      h.db.query('SELECT conversation_id, jmap_id, mailbox_id FROM message ORDER BY rowid').all(),
    )
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toContain('Nothing was sent, and the draft is still a draft')
    expect(row(h, draft.id)).toMatchObject({ status: 'draft', jmap_id: null, instruction_text: null })
    expect(h.jmapServer.submitted).toHaveLength(0)
    expect(h.jmapServer.inFolder('drafts')).toEqual([])
    expect(h.jmapServer.inFolder('sent')).toEqual([])
    expect(
      JSON.stringify(h.db.query('SELECT conversation_id, jmap_id, mailbox_id FROM message ORDER BY rowid').all()),
    ).toBe(before)
    expect(rows(h, "SELECT action FROM audit WHERE action = 'message.send-refused'")).toHaveLength(1)
    // and the next press can go out
    h.jmapServer.refuseSubmission = null
    expect(await press(h, draft)).toMatchObject({ ok: true })
    expect(h.jmapServer.submitted).toHaveLength(1)
  })

  test('the server has no identity for the address: refused before the draft is claimed', async () => {
    const { h, conversation } = await world()
    h.jmapServer.aliases = []
    h.jmapServer.address = 'someone-else@harborline.example'
    const draft = await reply(h, conversation)
    const before = snapshot(h)
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 422 })
    expect((res as { error: string }).error).toContain('no sending identity')
    expect(snapshot(h)).toBe(before)
  })

  test('the key is refused: nothing is claimed, the mailbox is refused, and a later press says so without asking the server', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.refuseKey = true
    const before = snapshot(h)
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 503 })
    expect((res as { error: string }).error).toContain(refusedReason(ADDRESS))
    expect(snapshot(h)).toBe(before)
    const asked = h.jmapServer.requests.length
    expect(await press(h, draft)).toMatchObject({ ok: false, status: 503 })
    expect(h.jmapServer.requests.length).toBe(asked)
    expect(h.jmapRoom.jmapMailboxes()[0]?.state).toBe('refused')
  })

  test('a connection that drops after the request left leaves the draft sending, says it is not known, and never sends again; the server’s own copy settles it', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.loseNextAnswer((methods) => methods.includes('EmailSubmission/set'))
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect((res as { error: string }).error).toContain('NOT sent again')
    expect((res as { error: string }).error).toContain(`check ${ADDRESS}’s Sent`)
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
    expect(h.jmapServer.submitted).toHaveLength(1) // it did go out
    // a second press is refused: nothing goes twice
    expect(await press(h, draft)).toMatchObject({ ok: false, status: 409 })
    expect(h.jmapServer.submitted).toHaveLength(1)

    // the sync stores the server's copy (the same Message-ID); saying "it did not go out" is then refused in words
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const held = rows<{ id: string }>(h, `SELECT id FROM message WHERE jmap_id IS NOT NULL AND direction = 'out'`)
    expect(held).toHaveLength(1)
    const notOut = await h.mailroom.resolveSend(draft.id, false, OWNER_EMAIL)
    expect(notOut).toMatchObject({ ok: false, status: 409 })
    expect((notOut as { error: string }).error).toContain('mail server’s own copy')
    // "it went out" removes the stuck draft and the server's copy is the record, once
    expect(await h.mailroom.resolveSend(draft.id, true, OWNER_EMAIL)).toMatchObject({
      ok: true,
      value: { status: 'removed' },
    })
    expect(row(h, draft.id)).toBeNull()
    expect(rows(h, "SELECT count(*) AS n FROM message WHERE direction = 'out'")).toEqual([{ n: 1 }])
  })

  test('a server error is not known to be a refusal either, and Tessa can say it did not go out when the server holds no copy', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.failNext(500, (_p, methods) => methods.includes('EmailSubmission/set'))
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
    expect(h.jmapServer.submitted).toHaveLength(0)
    expect(await h.mailroom.resolveSend(draft.id, false, OWNER_EMAIL)).toMatchObject({
      ok: true,
      value: { status: 'draft' },
    })
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
    expect(await press(h, draft)).toMatchObject({ ok: true })
  })

  // What the server's answer looks like when it is not an explicit yes or an explicit refusal. The server DID make and submit the message in each (the answer is what is wrong), so it is in Sent, and the inbox
  // must neither remove it nor put the draft back: it stays `sending`, says it is not known, and cannot be sent twice.
  type Answer = [string, Record<string, unknown>, string][]
  const UNCLEAR: [string, (out: Answer) => Answer][] = [
    [
      'Email/set names neither created nor notCreated for the message',
      (out) => out.map((r) => (r[2] === 'c0' ? ['Email/set', { accountId: 'c' }, 'c0'] : r)),
    ],
    ['the submission is missing from the answer', (out) => out.filter((r) => r[2] !== 'c1')],
    ['the message’s answer is missing', (out) => out.filter((r) => r[2] !== 'c0')],
    [
      'EmailSubmission/set names neither created nor notCreated',
      (out) => out.map((r) => (r[2] === 'c1' ? ['EmailSubmission/set', { accountId: 'c' }, 'c1'] : r)),
    ],
    [
      'the submission’s answer is another method',
      (out) => out.map((r) => (r[2] === 'c1' ? ['Email/get', { list: [] }, 'c1'] : r)),
    ],
    [
      'the submission fails with serverFail',
      (out) => out.map((r) => (r[2] === 'c1' ? ['error', { type: 'serverFail' }, 'c1'] : r)),
    ],
    [
      'the message’s method fails with serverFail',
      (out) => out.map((r) => (r[2] === 'c0' ? ['error', { type: 'serverFail' }, 'c0'] : r)),
    ],
    [
      'an error of a type nobody listed',
      (out) => out.map((r) => (r[2] === 'c1' ? ['error', { type: 'somethingNew' }, 'c1'] : r)),
    ],
  ]
  for (const [shape, mangle] of UNCLEAR) {
    test(`an answer that is not a clear yes or no is not a refusal (${shape}): the draft stays sending, nothing is removed from the server, and it cannot go twice`, async () => {
      const { h, conversation } = await world()
      const draft = await reply(h, conversation)
      h.jmapServer.mangleNextAnswer(mangle)
      const res = await press(h, draft)
      expect(res).toMatchObject({ ok: false, status: 502 })
      expect((res as { error: string }).error).toContain('NOT sent again')
      expect((res as { error: string }).error).not.toContain('Nothing was sent')
      expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
      // it went out, and what the server holds is untouched: the one copy is in Sent and was not destroyed
      expect(h.jmapServer.submitted).toHaveLength(1)
      expect(h.jmapServer.inFolder('sent')).toHaveLength(1)
      expect(h.jmapServer.requests.flatMap((r) => r.calls).filter((c) => c.args.destroy !== undefined)).toEqual([])
      // a second press goes nowhere
      expect(await press(h, draft)).toMatchObject({ ok: false, status: 409 })
      expect(h.jmapServer.submitted).toHaveLength(1)
    })
  }

  test('an answer that is not a list of methods is not a refusal either', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.mangleNextAnswer(() => 'nonsense' as never)
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect((res as { error: string }).error).toContain('NOT sent again')
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
    expect(h.jmapServer.inFolder('sent')).toHaveLength(1)
  })

  test('an explicit refusal in the answer IS a refusal: a submission method that did not run puts the draft back, removes the copy and does NOT mark the mailbox refused; notCreated for the message leaves nothing to remove', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.refuseSubmission = 'forbiddenFrom'
    // the server refused the submission as a whole method that did not run (forbidden), not as a notCreated entry
    h.jmapServer.mangleNextAnswer((out) =>
      out.map((r) => (r[2] === 'c1' ? ['error', { type: 'forbidden', description: 'no' }, 'c1'] : r)),
    )
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toContain('Nothing was sent, and the draft is still a draft')
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
    expect(h.jmapServer.inFolder('drafts')).toEqual([])
    expect(h.jmapServer.inFolder('sent')).toEqual([])
    expect(h.jmapServer.submitted).toHaveLength(0)
    expect(rows(h, "SELECT 1 FROM mailbox WHERE kind = 'jmap' AND grant_lapsed_at IS NOT NULL")).toEqual([])

    // notCreated for the message itself: nothing was made, so nothing is removed
    h.jmapServer.refuseSubmission = null
    h.jmapServer.mangleNextAnswer((out) =>
      out.map((r) =>
        r[2] === 'c0' ? ['Email/set', { accountId: 'c', notCreated: { out: { type: 'overQuota' } } }, 'c0'] : r,
      ),
    )
    const again = await press(h, draft)
    expect(again).toMatchObject({ ok: false })
    expect((again as { error: string }).error).toContain('overQuota')
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
  })

  test('a 4xx is a refusal: the draft is put back', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    h.jmapServer.failNext(400, (_p, methods) => methods.includes('EmailSubmission/set'))
    const res = await press(h, draft)
    expect(res).toMatchObject({ ok: false, status: 422 })
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
  })

  test('the server accepted it but the inbox could not file it: it stays sending, with the words that say the server’s copy will arrive by itself', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    // a unique clash is the only way filing fails; make the server's id one the inbox already holds
    const original = h.inbox.fileJmapSent.bind(h.inbox)
    h.inbox.fileJmapSent = () => {
      throw new Error('disk full')
    }
    const res = await press(h, draft)
    h.inbox.fileJmapSent = original
    expect(res).toMatchObject({ ok: false, status: 502 })
    expect((res as { error: string }).error).toContain('could not record it')
    expect(row(h, draft.id)).toMatchObject({ status: 'sending' })
    expect(h.jmapServer.submitted).toHaveLength(1)
  })

  test('a reply is refused when something arrived on the server since the page was shown: it is stored on the spot, and nothing is sent', async () => {
    const { h, dana, conversation } = await world()
    const draft = await reply(h, conversation)
    const shown = through(h, conversation)
    h.jmapServer.deliver({
      subject: 'Re: Quote for the shop',
      from: 'Dana Smith <dana@example.com>',
      inReplyTo: '<q1@example.com>',
      threadId: h.jmapServer.emails.get(dana)?.threadId,
      at: T0 - 100,
    })
    const res = await press(h, draft, {}, OWNER_EMAIL, shown)
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(h.jmapServer.submitted).toHaveLength(0)
    expect(row(h, draft.id)).toMatchObject({ status: 'draft' })
    expect(count(h, 'message')).toBe(3)
    // shown it, he can send
    expect(await press(h, draft)).toMatchObject({ ok: true })
  })

  test('files are refused in words, before anything is claimed', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    const before = snapshot(h)
    const res = await h.mailroom.sendDraft(
      draft.id,
      { rev: draft.rev, through: through(h, conversation) } as never,
      OWNER_EMAIL,
      [{ name: 'a.txt', type: 'text/plain', content: new Uint8Array([1]) }] as never,
    )
    expect(res).toMatchObject({ ok: false, status: 422 })
    expect((res as { error: string }).error).toContain('Files cannot be sent')
    expect(snapshot(h)).toBe(before)
  })

  test('the store’s other checks still hold: an em dash, no subject, a subject on two lines', async () => {
    const { h, conversation } = await world()
    const dashed = await reply(h, conversation, { body: `Yes ${DASH} of course` })
    expect(await press(h, dashed)).toMatchObject({ ok: false, status: 422 })
    const split = await reply(h, conversation, { subject: 'one\ntwo' })
    expect(await press(h, split)).toMatchObject({ ok: false, status: 422 })
    expect(h.jmapServer.submitted).toHaveLength(0)
  })

  test('two presses at once send once', async () => {
    const { h, conversation } = await world()
    const draft = await reply(h, conversation)
    const [a, b] = await Promise.all([press(h, draft), press(h, draft)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(h.jmapServer.submitted).toHaveLength(1)
  })
})

describe('the send rule is the store’s, whichever transport', () => {
  async function claudeDraft(h: H, conversationId: string, extra: Record<string, unknown> = {}): Promise<MessageRow> {
    const res = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId,
      body: WORDS,
      why: 'She asked for a time.',
      ...extra,
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json
  }

  test('Claude’s send is refused while the switch is off, then without Tessa’s instruction, and goes with both, recording the instruction; nothing in the JMAP room knows who sends', async () => {
    const { h, conversation } = await world()
    const draft = await claudeDraft(h, conversation)
    const before = snapshot(h)
    // switch off: the store refuses before anything is read or claimed
    const off = await press(h, draft, {}, AGENT_ACTOR)
    expect(off).toMatchObject({ ok: false, status: 403 })
    expect(snapshot(h)).toBe(before)
    expect(h.jmapServer.submitted).toHaveLength(0)
    // the switch on, no instruction
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200)
    h.tick(1000)
    const none = await h.mailroom.sendDraft(
      draft.id,
      { rev: draft.rev, through: through(h, conversation) } as never,
      AGENT_ACTOR,
    )
    expect(none).toMatchObject({ ok: false, status: 403 })
    expect(h.jmapServer.submitted).toHaveLength(0)
    // with both
    h.tick(240_000)
    const sent = await press(h, draft, {}, AGENT_ACTOR)
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
    expect(h.jmapServer.submitted).toHaveLength(1)
    expect(row(h, draft.id)).toMatchObject({
      status: 'sent',
      sent_by: AGENT_ACTOR,
      instruction_text: 'send it',
      instruction_where: 'session main',
    })
    const claude = (await h.request(AGENT, 'GET', '/api/claude-sends')).json as { message: { id: string } }[]
    expect(claude.map((c) => c.message.id)).toEqual([draft.id])
  })

  test('a draft anybody but Claude changed after Tessa spoke is refused to Claude, as for every transport', async () => {
    const { h, conversation } = await world()
    await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })
    const draft = await claudeDraft(h, conversation)
    h.tick(300_000)
    const edited = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, {
      rev: draft.rev,
      body: `${WORDS} Bring the quote.`,
    })
    expect(edited.status).toBe(200)
    const res = await h.mailroom.sendDraft(
      draft.id,
      {
        rev: edited.json.rev,
        through: through(h, conversation),
        instruction: { ...SAID, at: '2026-10-20T12:03:00Z' },
      } as never,
      AGENT_ACTOR,
    )
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(h.jmapServer.submitted).toHaveLength(0)
  })

  test('Claude chooses the mailbox by address or by name for a new email, and a refused mailbox is not chosen', async () => {
    const { h, mailboxId } = await world()
    const byAddress = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'lane@example.net',
      subject: 'Hi',
      body: 'A note.',
      why: 'Tessa asked.',
      from: ADDRESS,
    })
    const byName = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'lane2@example.net',
      subject: 'Hi',
      body: 'A note.',
      why: 'Tessa asked.',
      from: 'Harborline',
    })
    expect(byAddress.status, JSON.stringify(byAddress.json)).toBe(201)
    expect(byName.status).toBe(201)
    for (const d of [byAddress.json, byName.json]) {
      expect(h.inbox.sendTransportOf(d.id)).toBe('jmap')
      expect(row(h, d.id)).toMatchObject({ mailbox_id: mailboxId })
    }
    const listed = (await h.request(AGENT, 'GET', '/api/drafts')).json as {
      id: string
      sendsFrom?: { name: string; address: string }
    }[]
    expect(listed.find((d) => d.id === byAddress.json.id)?.sendsFrom).toEqual({ name: 'harborline', address: ADDRESS })
    // nothing was sent by drafting
    expect(h.jmapServer.submitted).toHaveLength(0)
    // refused, in words, once the server has refused the key
    h.jmapServer.refuseKey = true
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const refused = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'lane3@example.net',
      subject: 'Hi',
      body: 'A note.',
      why: 'Tessa asked.',
      from: ADDRESS,
    })
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('refused')
  })

  test('the transports never cross: a Gmail draft is not sent through the mail server and a mail server draft is not sent through Gmail', async () => {
    const h = jh()
    h.google.mailbox.add({ id: 'g1', threadId: 'tg1', subject: 'Gmail mail', from: 'Gus <gus@example.com>' })
    const m = h.jmapServer.deliver({ subject: 'Server mail', from: 'Dana <dana@example.com>', at: T0 - 1000 })
    expect((await h.connect()).ok).toBe(true)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const gmailConversation = (
      h.db.query("SELECT id FROM conversation WHERE gmail_thread_id = 'tg1'").get() as { id: string }
    ).id
    const gmailDraft = await reply(h, gmailConversation)
    const serverDraft = await reply(h, conversationOf(h, m))
    expect(h.inbox.sendTransportOf(gmailDraft.id)).toBe('gmail')
    expect(h.inbox.sendTransportOf(serverDraft.id)).toBe('jmap')
    expect(await press(h, gmailDraft)).toMatchObject({ ok: true })
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(h.jmapServer.submitted).toHaveLength(0)
    expect(await press(h, serverDraft)).toMatchObject({ ok: true })
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(h.jmapServer.submitted).toHaveLength(1)
    expect(h.email.handed).toHaveLength(0)
  })
})
