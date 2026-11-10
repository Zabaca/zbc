import { describe, expect, test } from 'bun:test'
import type { InboxFile, InboxForSpace, InboxSend } from '@space/workspace'
import { GmailError } from '../src/gmail/google'
import { AGENT, asker, harness, OWNER, ownerDraft, RIDGEWAY, SHIFTLANTERN, STRANGER, T0 } from '../test-support/harness'

/**
 * Writing from the space: what the space can do that only the inbox's own page could: write a NEW email from a mailbox it chooses (with files where the mailbox allows
 * them), edit a draft's words at a revision, and call a conversation spam or not. Driven as the space drives it, through `InboxForSpace`
 * (src/space.ts) with the Access assertion the space forwards, over the real store and Mailroom with a Google that can fail and a Cloudflare
 * sender that can refuse. What these cannot show is the runtime and the real services: the hand test (docs/runbooks/inbox-space.md, "Writing from the space").
 *
 * The em dash is written as an escape because this repo has none.
 */

type H = ReturnType<typeof harness>

const DASH = '\u2014'
const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const hours = (n: number) => n * 3_600_000
const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}
const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])
const file = (name = 'quote.pdf'): InboxFile => ({ name, type: 'application/pdf', bytes: PDF })

const ridgewayMail = (id: string, name: string, from: string, subject: string, body: string) =>
  `Return-Path: <${from}>\nMIME-Version: 1.0\nFrom: ${name} <${from}>\nDate: Mon, 26 Oct 2026 13:00:00 -0700\nMessage-ID: <${id}@example.org>\nSubject: ${subject}\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\n${body}\n`

async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
}

/** Gmail holds Dana's quote and a newsletter; Ridgeway and ShiftLantern are declared; Priya has written to Ridgeway. */
async function world() {
  const h = harness({}, { ai: null, mailboxes: [RIDGEWAY, SHIFTLANTERN] })
  const g = h.google.mailbox
  g.add({
    id: 'm1',
    threadId: 't1',
    from: 'Dana Smith <dana@example.com>',
    subject: 'Quote for the shop',
    body: 'Can you quote the shop front?',
    at: T0 - hours(5),
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
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  await hear(h)
  const arrived = await h.deliver(
    ridgewayMail('p1', 'Priya Nair', 'priya.n@example.org', 'Hours question', 'Are you open on Sundays?'),
    {
      from: 'priya.n@example.org',
      to: 'info@ridgewaycycles.example',
    },
  )
  expect(arrived.entered).toBe('filed')
  // ShiftLantern's mailbox exists in the store once something has come to it; its first mail is what makes it one the inbox can send from.
  const worker = await h.deliver(
    `Return-Path: <w@example.org>\nMIME-Version: 1.0\nFrom: Worker <w@example.org>\nDate: Mon, 26 Oct 2026 14:00:00 -0700\nMessage-ID: <w1@example.org>\nSubject: A question\nTo: hello@shiftlantern.example\nContent-Type: text/plain; charset="UTF-8"\n\nWhen is my final paycheck due?\n`,
    { from: 'w@example.org', to: 'hello@shiftlantern.example' },
  )
  expect(worker.entered).toBe('filed')
  return h
}

const pending = (h: H) =>
  (h.db.query(`SELECT count(*) AS n FROM message WHERE status IN ('draft', 'sending')`).get() as { n: number }).n
const contacts = (h: H) => (h.db.query(`SELECT count(*) AS n FROM contact`).get() as { n: number }).n
const composeRows = (h: H) =>
  (h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'compose:%'`).get() as { n: number }).n

/** The id the inbox gives a business mailbox, as `mailboxes` lists it: what the space's From box names. */
async function mailboxId(h: H, address: string): Promise<string> {
  const listed = unwrap(await h.space().mailboxes(await assertion()))
  const found = listed.mailboxes.find((m) => m.address === address)
  expect(found, `no mailbox ${address}`).toBeDefined()
  return found?.id as string
}

describe('a new email: from the mailbox the person chose', () => {
  test('from Ridgeway goes out as info@ridgewaycycles.example through Cloudflare, to an address the inbox has never heard of, and never through Gmail', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const people = contacts(h)
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(1),
        address: 'New Person <NEW@Example.net>',
        name: 'New Person',
        subject: 'Your visit',
        text: 'We are glad you are coming in.',
        from: { kind: 'business', mailboxId: id },
      }),
    )
    expect(sent.status).toBe('sent')
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]).toMatchObject({
      from: expect.stringContaining('info@ridgewaycycles.example'),
      to: 'new@example.net',
      subject: 'Your visit',
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(contacts(h)).toBe(people + 1)
    // Filed as Tessa's own send, on a conversation of Ridgeway's mailbox, with no instruction (an instruction is Claude's).
    expect(
      h.db.query(`SELECT status, sent_by, instruction_text FROM message WHERE id = ?`).get(sent.messageId),
    ).toEqual({ status: 'sent', sent_by: 'tessa@northfield.example', instruction_text: null })
    expect(pending(h)).toBe(0)
  })

  test('from ShiftLantern goes out as hello@shiftlantern.example', async () => {
    const h = await world()
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(2),
        address: 'worker@example.net',
        subject: 'Your guide',
        text: 'Here is the guide you asked for.',
        from: { kind: 'business', mailboxId: await mailboxId(h, SHIFTLANTERN.address) },
      }),
    )
    expect(sent.status).toBe('sent')
    expect(h.email.handed[0]).toMatchObject({ from: expect.stringContaining('hello@shiftlantern.example') })
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('from Gmail goes out as tessa@northfield.example through Gmail, even to a person who last wrote to Ridgeway, which is the one thing the inbox’s own rule would have decided', async () => {
    const h = await world()
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(3),
        address: 'priya.n@example.org',
        subject: 'Personally',
        text: 'A note from me, not from the shop.',
        from: { kind: 'gmail' },
      }),
    )
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(h.google.mailbox.sent[0]?.headers.From).toContain('tessa@northfield.example')
    expect(h.email.handed).toHaveLength(0)
  })

  test('with no choice it is still the inbox’s own rule: the mailbox the person last wrote to (Ridgeway for Priya, Gmail for a stranger)', async () => {
    const h = await world()
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(4),
        address: 'priya.n@example.org',
        subject: 'Following up',
        text: 'Did that help?',
      }),
    )
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]).toMatchObject({ from: expect.stringContaining('info@ridgewaycycles.example') })
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(5),
        address: 'stranger@example.net',
        subject: 'Hello',
        text: 'Nice to meet you.',
      }),
    )
    expect(h.google.mailbox.sent).toHaveLength(1)
  })

  test('a mailbox that is none of the inbox’s is refused before anything is made: no draft, no contact, no key held, nothing sent', async () => {
    const h = await world()
    const people = contacts(h)
    for (const from of [
      { kind: 'business', mailboxId: 'not-a-mailbox' },
      // Gmail's own mailbox row is not a business mailbox, whatever its id.
      {
        kind: 'business',
        mailboxId: (h.db.query(`SELECT id FROM mailbox WHERE kind = 'gmail'`).get() as { id: string }).id,
      },
    ]) {
      const reply = await h.space().send(await assertion(), {
        key: KEY(6),
        address: 'x@example.net',
        subject: 'Hi',
        text: 'Hello',
        from,
      } as InboxSend)
      expect(reply).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
      expect(reply).not.toMatchObject({ reason: 'repeated' })
    }
    expect(contacts(h)).toBe(people)
    expect(pending(h)).toBe(0)
    expect(composeRows(h)).toBe(0)
    expect(h.email.handed).toHaveLength(0)
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('a mailbox named in a shape that is not one is bad-request before the key is taken, an address typed in place of a mailbox included', async () => {
    const h = await world()
    for (const from of [
      { kind: 'business' },
      { kind: 'business', mailboxId: 'a/b' },
      { kind: 'business', mailboxId: 5 },
      { kind: 'other' },
      'info@ridgewaycycles.example',
      5,
      null,
      { address: 'boss@example.net' },
    ]) {
      const reply = await h
        .space()
        .send(await assertion(), { key: KEY(7), address: 'x@example.net', subject: 'Hi', text: 'Hello', from } as never)
      expect([from, reply]).toMatchObject([from, { ok: false, reason: 'bad-request' }])
    }
    expect(composeRows(h)).toBe(0)
    expect(pending(h)).toBe(0)
  })

  test('the inbox’s own refusals stay: an em dash in the subject or the words, an address of ours, a missing subject, a body that is empty', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const base = {
      address: 'new@example.net',
      subject: 'Hello',
      text: 'Nice to meet you.',
      from: { kind: 'business' as const, mailboxId: id },
    }
    const cases: [string, Partial<typeof base>][] = [
      ['an em dash in the words', { text: `Nice ${DASH} to meet you.` }],
      ['an em dash in the subject', { subject: `Hello ${DASH} there` }],
      ['no subject', { subject: '' }],
      ['no words', { text: '   ' }],
      ['Ridgeway’s own address', { address: 'info@ridgewaycycles.example' }],
      ['an address on Ridgeway’s domain', { address: 'anyone@ridgewaycycles.example' }],
    ]
    for (const [why, over] of cases) {
      const reply = await h.space().send(await assertion(), { key: KEY(8), ...base, ...over } as InboxSend)
      expect([why, reply]).toMatchObject([why, { ok: false, kind: 'refused', reason: 'bad-request' }])
      // A refusal releases the key and leaves no draft where it could be sent a second time.
      expect(composeRows(h)).toBe(0)
      expect(pending(h)).toBe(0)
    }
    expect(h.email.handed).toHaveLength(0)
    // ...and the same compose, put right, sends with the same key.
    const sent = unwrap(await h.space().send(await assertion(), { key: KEY(8), ...base }))
    expect(sent.status).toBe('sent')
    expect(h.email.handed).toHaveLength(1)
  })

  test('to Tessa’s own Gmail address from Gmail is refused too: it would arrive in his own mailbox', async () => {
    const h = await world()
    const reply = await h.space().send(await assertion(), {
      key: KEY(9),
      address: 'tessa@northfield.example',
      subject: 'Note',
      text: 'To myself.',
      from: { kind: 'gmail' },
    })
    expect(reply).toMatchObject({
      ok: false,
      reason: 'bad-request',
      message: expect.stringContaining('your own address'),
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(pending(h)).toBe(0)
  })

  test('the compose key: a second press answers Repeated with the first answer and sends nothing, while a first press Cloudflare refused releases the key and the same key sends', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const send: InboxSend = {
      key: KEY(10),
      address: 'new@example.net',
      subject: 'Hello',
      text: 'Nice to meet you.',
      from: { kind: 'business', mailboxId: id },
    }
    h.email.always({ kind: 'throw', code: 'E_RECIPIENT_NOT_ALLOWED', message: 'Recipient not allowed' })
    const refusedAt = await h.space().send(await assertion(), send)
    expect(refusedAt).toMatchObject({ ok: false, kind: 'refused' })
    expect(refusedAt).not.toMatchObject({ reason: 'repeated' })
    expect(pending(h)).toBe(0)
    expect(composeRows(h)).toBe(0)

    h.email.always({ kind: 'accept' })
    const first = unwrap(await h.space().send(await assertion(), send))
    expect(first.status).toBe('sent')
    for (let n = 0; n < 2; n += 1) {
      expect(await h.space().send(await assertion(), send)).toMatchObject({
        ok: false,
        kind: 'refused',
        reason: 'repeated',
        earlier: { state: 'done', reply: { ok: true, value: first } },
      })
    }
    // One refused try and one that went: the binding was handed the message twice, and the second press and its repeats were never handed anything.
    expect(h.email.handed).toHaveLength(2)
  })

  test('when Cloudflare never says, the answer is a success with status sending, the key stays held, and nothing is sent again', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const send: InboxSend = {
      key: KEY(11),
      address: 'new@example.net',
      subject: 'Hello',
      text: 'Nice to meet you.',
      from: { kind: 'business', mailboxId: id },
    }
    h.email.always({ kind: 'throw-plain' })
    const unsure = unwrap(await h.space().send(await assertion(), send))
    expect(unsure.status).toBe('sending')
    h.email.always({ kind: 'accept' })
    expect(await h.space().send(await assertion(), send)).toMatchObject({
      ok: false,
      reason: 'repeated',
      earlier: { state: 'done', reply: { ok: true, value: { status: 'sending' } } },
    })
    expect(h.email.handed).toHaveLength(1)
  })

  test('Claude’s sending is untouched: its switch stays off, and a space send neither needs it nor turns it on', async () => {
    const h = await world()
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(false)
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(12),
        address: 'new@example.net',
        subject: 'Hello',
        text: 'Hi.',
        from: { kind: 'gmail' },
      }),
    )
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(false)
    // Claude's own drafting path takes no `sendFrom`: the field is not in the route (Claude's choice is `from`, test/claude-picks-from.test.ts), so a body that names one is a draft like any other.
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Nice to meet you.',
      why: 'He asked.',
      sendFrom: { kind: 'business', mailboxId: 'x' },
    })
    expect(made.status).toBe(201)
    expect(h.db.query(`SELECT mailbox_id FROM message WHERE id = ?`).get(made.json.id)).toEqual({ mailbox_id: null })
  })

  test('Claude’s token and anyone but the owner cannot send through the space, from any mailbox', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    for (const who of [AGENT, STRANGER]) {
      const reply = await h.space().send(await assertion(who), {
        key: KEY(13),
        address: 'x@example.net',
        subject: 'Hi',
        text: 'Hello',
        from: { kind: 'business', mailboxId: id },
      })
      expect(reply).toMatchObject({ ok: false })
    }
    expect(h.email.handed).toHaveLength(0)
    expect(h.google.mailbox.sent).toHaveLength(0)
  })
})

describe('a new email with files', () => {
  test('from a business mailbox goes with them, and the sent message lists them and gives them back', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(20),
        address: 'new@example.net',
        subject: 'Your quote',
        text: 'The quote is attached.',
        from: { kind: 'business', mailboxId: id },
        attachments: [file('quote (final).pdf')],
      }),
    )
    expect(sent.status).toBe('sent')
    expect(h.email.handed).toHaveLength(1)
    expect(h.email.handed[0]?.attachments).toHaveLength(1)
    expect(h.email.handed[0]?.attachments?.[0]).toMatchObject({
      filename: 'quote (final).pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    })
    // A message Tessa sends is read and closed by its sender, as the inbox files it, so it is in the person's history and not in the main list.
    const history = unwrap(
      await h.space().messagesWith(await assertion(), { address: 'new@example.net' }, { include: ['closed'] }),
    )
    const message = history.messages.find((m) => m.id === sent.messageId)
    expect(message?.attachments).toEqual([
      expect.objectContaining({ name: 'quote (final).pdf', size: PDF.length, download: true }),
    ])
    const back = unwrap(await h.space().attachment(await assertion(), sent.messageId, 0, 'download'))
    expect(Array.from(back.bytes)).toEqual(Array.from(PDF))
  })

  test('from Gmail they are refused before anything is made, and never dropped from a send that would have gone without them', async () => {
    const h = await world()
    const reply = await h.space().send(await assertion(), {
      key: KEY(21),
      address: 'new@example.net',
      subject: 'Your quote',
      text: 'The quote is attached.',
      from: { kind: 'gmail' },
      attachments: [file()],
    })
    expect(reply).toMatchObject({ ok: false, reason: 'bad-request', message: expect.stringContaining('Ridgeway') })
    expect(composeRows(h)).toBe(0)
    expect(pending(h)).toBe(0)
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('with no mailbox chosen the rule decides, and a Gmail one still refuses them: nothing sent, no draft left, the key free', async () => {
    const h = await world()
    const send: InboxSend = {
      key: KEY(22),
      address: 'stranger@example.net',
      subject: 'Hello',
      text: 'Attached.',
      attachments: [file()],
    }
    const reply = await h.space().send(await assertion(), send)
    expect(reply).toMatchObject({ ok: false, reason: 'bad-request', message: expect.stringContaining('Ridgeway') })
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(pending(h)).toBe(0)
    expect(composeRows(h)).toBe(0)
    // Without the files, the same key sends.
    const { attachments: _, ...plain } = send as Extract<InboxSend, { address: string }>
    expect(unwrap(await h.space().send(await assertion(), plain)).status).toBe('sent')
  })

  test('the limits are the contract’s: more than ten files, an empty file or a file that is not one is bad-request before the key is taken', async () => {
    const h = await world()
    const id = await mailboxId(h, RIDGEWAY.address)
    const base = {
      address: 'new@example.net',
      subject: 'Hello',
      text: 'Attached.',
      from: { kind: 'business' as const, mailboxId: id },
    }
    for (const attachments of [
      Array.from({ length: 11 }, (_, n) => file(`f${n}.pdf`)),
      [{ name: 'empty.pdf', type: 'application/pdf', bytes: new Uint8Array() }],
      [{ name: 'x', type: 'text/plain', bytes: 'not bytes' }],
      'a file',
    ]) {
      const reply = await h.space().send(await assertion(), { key: KEY(23), ...base, attachments } as never)
      expect(reply).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(composeRows(h)).toBe(0)
    expect(pending(h)).toBe(0)
    expect(h.email.handed).toHaveLength(0)
  })
})

describe('editDraft: a draft’s words at the revision shown', () => {
  /** A draft Claude wrote for Dana's quote thread. */
  async function claudeDraft(h: H) {
    const history = unwrap(await h.space().messagesWith(await assertion(), { address: 'dana@example.com' }))
    const thread = history.threads[0]
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: thread?.conversationId,
      subject: 'Re: Quote for the shop',
      body: 'Hi Dana, the quote is $900.',
      why: 'She asked.',
    })
    expect(made.status).toBe(201)
    return { id: made.json.id as string, rev: made.json.rev as number, through: thread?.through ?? 0 }
  }

  test('saves the subject and the words as Tessa’s edit, bumps the revision, and the answer is the draft as it stands', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    h.tick()
    const edited = unwrap(
      await h.space().editDraft(await assertion(), {
        draftId: d.id,
        rev: d.rev,
        subject: 'Re: Quote for the shop front',
        text: 'Hi Dana, the quote is $950.',
      }),
    )
    expect(edited).toMatchObject({
      id: d.id,
      subject: 'Re: Quote for the shop front',
      text: 'Hi Dana, the quote is $950.',
      rev: d.rev + 1,
      author: 'claude',
      stuck: false,
    })
    expect(edited.to).toBe('dana@example.com')
    // The audit says who: Tessa, in the space; the draft is still Claude's (who made it) and its last edit is his.
    expect(h.db.query(`SELECT actor FROM audit WHERE action = 'draft.update'`).all()).toEqual([
      { actor: 'tessa@northfield.example' },
    ])
    expect(h.db.query(`SELECT updated_by, created_by FROM message WHERE id = ?`).get(d.id)).toMatchObject({
      updated_by: 'tessa@northfield.example',
    })
    // The list of drafts shows the same.
    expect(unwrap(await h.space().drafts(await assertion())).find((x) => x.id === d.id)).toEqual(edited)
    expect(pending(h)).toBe(1)
  })

  test('either field alone leaves the other as it was, and the words are trimmed as the inbox’s page trims them', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    const a = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: '  Hi Dana, $1000.  \n' }),
    )
    expect(a).toMatchObject({ subject: 'Re: Quote for the shop', text: 'Hi Dana, $1000.' })
    const b = unwrap(await h.space().editDraft(await assertion(), { draftId: d.id, rev: a.rev, subject: 'Quote' }))
    expect(b).toMatchObject({ subject: 'Quote', text: 'Hi Dana, $1000.', rev: a.rev + 1 })
  })

  test('a draft changed since it was shown is a conflict and nothing is saved: Claude’s edit stays, and Tessa’s words were not applied over it', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    const theirs = await h.request(AGENT, 'PATCH', `/api/drafts/${d.id}`, {
      rev: d.rev,
      body: 'Hi Dana, the quote is $800 after all.',
    })
    expect(theirs.status).toBe(200)
    const stale = await h
      .space()
      .editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'My words, written over the old draft.' })
    expect(stale).toMatchObject({
      ok: false,
      kind: 'refused',
      reason: 'conflict',
      message: expect.stringContaining('changed after it was shown'),
    })
    const now = unwrap(await h.space().drafts(await assertion())).find((x) => x.id === d.id)
    expect(now?.text).toBe('Hi Dana, the quote is $800 after all.')
    expect(now?.rev).toBe(d.rev + 1)
    // The same edit at the revision now shown goes through.
    expect(
      unwrap(await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev + 1, text: 'My words.' })).text,
    ).toBe('My words.')
  })

  test('a repeat of the same edit is a conflict, never applied twice', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    unwrap(await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Once.' }))
    expect(await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Once.' })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'draft.update'`).get()).toEqual({ n: 1 })
  })

  test('is bad-request for no change, a body left empty, a revision that is none, and words that are not text; not-found for a message that is not there', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    const a = await assertion()
    for (const edit of [
      { draftId: d.id, rev: d.rev },
      { draftId: d.id, rev: d.rev, text: '   ' },
      { draftId: d.id, text: 'x' },
      { draftId: d.id, rev: -1, text: 'x' },
      { draftId: d.id, rev: d.rev, text: 5 },
      { draftId: d.id, rev: d.rev, subject: 5 },
      null,
    ]) {
      expect([edit, await h.space().editDraft(a, edit as never)]).toMatchObject([
        edit,
        { ok: false, reason: 'bad-request' },
      ])
    }
    expect(await h.space().editDraft(a, { draftId: 'no-such-draft', rev: 0, text: 'x' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().editDraft(a, { draftId: '../x', rev: 0, text: 'x' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    // Nothing was changed by any of it.
    expect(unwrap(await h.space().drafts(a)).find((x) => x.id === d.id)).toMatchObject({
      rev: d.rev,
      text: 'Hi Dana, the quote is $900.',
    })
  })

  test('a message that is no longer a draft cannot be edited: a conflict, and a sent message is never changed', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    unwrap(await h.space().send(await assertion(), { key: KEY(30), draftId: d.id, rev: d.rev, through: d.through }))
    const reply = await h
      .space()
      .editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Changed after it went.' })
    expect(reply).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.db.query(`SELECT body FROM message WHERE id = ?`).get(d.id)).toEqual({
      body: 'Hi Dana, the quote is $900.',
    })
  })

  test('an edited draft is sent at the new revision and not the old: the old one is a conflict, the new one goes with Tessa’s words', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    const edited = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Hi Dana, $950 it is.' }),
    )
    expect(
      await h.space().send(await assertion(), { key: KEY(31), draftId: d.id, rev: d.rev, through: d.through }),
    ).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.google.mailbox.sent).toHaveLength(0)
    const sent = unwrap(
      await h.space().send(await assertion(), { key: KEY(32), draftId: d.id, rev: edited.rev, through: d.through }),
    )
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent[0]?.headers.From).toContain('tessa@northfield.example')
    expect(h.db.query(`SELECT body FROM message WHERE id = ?`).get(sent.messageId)).toEqual({
      body: 'Hi Dana, $950 it is.',
    })
  })

  test('an em dash is saved, as the inbox’s own card saves it, and the SEND refuses it in the inbox’s words so the fix is to edit again', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    const edited = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: `Hi Dana ${DASH} $950.` }),
    )
    const refusal = await h
      .space()
      .send(await assertion(), { key: KEY(33), draftId: d.id, rev: edited.rev, through: d.through })
    expect(refusal).toMatchObject({ ok: false, reason: 'bad-request', message: expect.stringContaining('em dash') })
    expect(h.google.mailbox.sent).toHaveLength(0)
    const fixed = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: edited.rev, text: 'Hi Dana, $950.' }),
    )
    expect(
      unwrap(
        await h.space().send(await assertion(), { key: KEY(33), draftId: d.id, rev: fixed.rev, through: d.through }),
      ).status,
    ).toBe('sent')
  })

  test('a draft whose send Gmail never confirmed is not editable, and Tessa’s own draft on no conversation is', async () => {
    const h = await world()
    const mine = await ownerDraft(h, {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Nice to meet you.',
    })
    const edited = unwrap(
      await h
        .space()
        .editDraft(await assertion(), { draftId: mine.json.id, rev: mine.json.rev, text: 'Lovely to meet you.' }),
    )
    expect(edited).toMatchObject({ conversationId: null, text: 'Lovely to meet you.', author: 'owner' })
    h.google.loseSendAnswer = true
    const unsure = unwrap(
      await h.space().send(await assertion(), { key: KEY(34), draftId: mine.json.id, rev: edited.rev, through: null }),
    )
    expect(unsure.status).toBe('sending')
    const stuck = await h
      .space()
      .editDraft(await assertion(), { draftId: mine.json.id, rev: edited.rev, text: 'Changed while stuck.' })
    expect(stuck).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('only the owner edits: a stranger is not admitted, and the draft is as it was', async () => {
    const h = await world()
    const d = await claudeDraft(h)
    expect(await h.space().editDraft(asker(STRANGER), { draftId: d.id, rev: d.rev, text: 'x' })).toMatchObject({
      ok: false,
      reason: 'not-admitted',
    })
    expect(unwrap(await h.space().drafts(await assertion())).find((x) => x.id === d.id)?.text).toBe(
      'Hi Dana, the quote is $900.',
    )
  })
})

describe('setSpam: a conversation called spam, or not', () => {
  const bulkIds = async (h: H) =>
    unwrap(await h.space().people(await assertion(), { include: ['bulk'] })).people.flatMap((p) =>
      p.conversations.filter((c) => c.bulk).map((c) => c.conversationId),
    )
  const threadOf = async (h: H, address: string) =>
    unwrap(await h.space().messagesWith(await assertion(), { address }, { include: ['bulk', 'closed'] })).threads[0]

  test('Gmail’s conversation moves to Bulk and back, sticks, is audited as Tessa’s, and changes nothing in Gmail', async () => {
    const h = await world()
    const t = await threadOf(h, 'dana@example.com')
    const before = h.google.calls.length
    const spam = unwrap(
      await h.space().setSpam(await assertion(), { conversationId: t?.conversationId ?? '', spam: true }),
    )
    expect(spam).toMatchObject({ conversationId: t?.conversationId, spam: true, bulk: true })
    expect(spam.reasons.length).toBeGreaterThan(0)
    expect(await bulkIds(h)).toContain(t?.conversationId ?? '')
    // Gone from the main list, found under Bulk.
    const main = unwrap(await h.space().people(await assertion()))
    expect(main.people.flatMap((p) => p.conversations.map((c) => c.conversationId))).not.toContain(
      t?.conversationId ?? '',
    )
    expect(h.db.query(`SELECT actor FROM audit WHERE action = 'conversation.spam'`).all()).toEqual([
      { actor: 'tessa@northfield.example' },
    ])
    expect(h.google.calls).toHaveLength(before)

    // A later message in the thread does not undo it.
    h.google.mailbox.add({
      id: 'm1b',
      threadId: 't1',
      from: 'Dana Smith <dana@example.com>',
      subject: 'Re: Quote for the shop',
      body: 'Hello again.',
      at: T0 - hours(1),
    })
    await hear(h)
    expect(await bulkIds(h)).toContain(t?.conversationId ?? '')
    const afterSync = h.google.calls.length
    expect(afterSync).toBeGreaterThan(before)

    const back = unwrap(
      await h.space().setSpam(await assertion(), { conversationId: t?.conversationId ?? '', spam: false }),
    )
    expect(back).toMatchObject({ spam: false, bulk: false })
    expect(await bulkIds(h)).not.toContain(t?.conversationId ?? '')
    // Calling it spam and calling it not spam changed nothing in Gmail.
    expect(h.google.calls).toHaveLength(afterSync)
  })

  test('Ridgeway’s conversation does the same, and is called spam by Tessa, not by Clef', async () => {
    const h = await world()
    const t = await threadOf(h, 'priya.n@example.org')
    const spam = unwrap(
      await h.space().setSpam(await assertion(), { conversationId: t?.conversationId ?? '', spam: true }),
    )
    expect(spam).toMatchObject({ spam: true, bulk: true })
    expect(spam.reasons.join(' ')).toMatch(/Tessa|you|called/i)
    expect((await threadOf(h, 'priya.n@example.org'))?.bulk).toBe(true)
    expect(
      unwrap(await h.space().setSpam(await assertion(), { conversationId: t?.conversationId ?? '', spam: false })).bulk,
    ).toBe(false)
  })

  test('a newsletter marked not spam stays in Bulk when its own header says so, and the answer says why instead of pretending', async () => {
    const h = await world()
    const t = await threadOf(h, 'news@brand.example.com')
    expect(t?.bulk).toBe(true)
    const reply = unwrap(
      await h.space().setSpam(await assertion(), { conversationId: t?.conversationId ?? '', spam: false }),
    )
    expect(reply.spam).toBe(false)
    // A person's call decides over a header, as the inbox's page has it: it is back in the Inbox.
    expect(reply.bulk).toBe(false)
  })

  test('is repeatable: calling it twice is calling it once', async () => {
    const h = await world()
    const t = await threadOf(h, 'dana@example.com')
    const id = t?.conversationId ?? ''
    unwrap(await h.space().setSpam(await assertion(), { conversationId: id, spam: true }))
    expect(unwrap(await h.space().setSpam(await assertion(), { conversationId: id, spam: true }))).toMatchObject({
      spam: true,
      bulk: true,
    })
    expect((await threadOf(h, 'dana@example.com'))?.bulk).toBe(true)
  })

  test('is refused for what is not a call or not a conversation: no boolean, an id that is none, one that is not there', async () => {
    const h = await world()
    const t = await threadOf(h, 'dana@example.com')
    const a = await assertion()
    for (const mark of [
      { conversationId: t?.conversationId, spam: 'yes' },
      { conversationId: t?.conversationId },
      { conversationId: t?.conversationId, spam: 1 },
    ]) {
      expect([mark, await h.space().setSpam(a, mark as never)]).toMatchObject([
        mark,
        { ok: false, reason: 'bad-request' },
      ])
    }
    expect(await h.space().setSpam(a, { conversationId: 'no-such-one', spam: true })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().setSpam(a, { conversationId: '../x', spam: true })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().setSpam(a, null as never)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'conversation.spam'`).get()).toEqual({ n: 0 })
  })

  test('only the owner calls it: a stranger is not admitted; and Claude’s own route to it is untouched', async () => {
    const h = await world()
    const t = await threadOf(h, 'dana@example.com')
    expect(
      await h.space().setSpam(asker(STRANGER), { conversationId: t?.conversationId ?? '', spam: true }),
    ).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect((await threadOf(h, 'dana@example.com'))?.bulk).toBe(false)
    // The inbox's own route, as Claude uses it, still works and is audited as Claude's.
    const claude = await h.request(AGENT, 'PUT', `/api/conversations/${t?.conversationId}/spam`, { spam: true })
    expect(claude.status).toBe(200)
  })
})

describe('what is not changed', () => {
  test('a GmailError in a send from a business mailbox choice is not in play: Gmail is never asked when the mailbox is Ridgeway’s', async () => {
    const h = await world()
    h.google.failNext('send', new GmailError('Gmail is having trouble', 503))
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(40),
        address: 'new@example.net',
        subject: 'Hello',
        text: 'Hi.',
        from: { kind: 'business', mailboxId: await mailboxId(h, RIDGEWAY.address) },
      }),
    )
    expect(sent.status).toBe('sent')
  })

  test('the contract’s method list is the harness’s, the new two included', async () => {
    const h = harness()
    const space: InboxForSpace = h.space()
    expect(typeof space.editDraft).toBe('function')
    expect(typeof space.setSpam).toBe('function')
  })
})
