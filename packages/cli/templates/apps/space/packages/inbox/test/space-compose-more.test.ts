import { describe, expect, test } from 'bun:test'
import { INBOX_CAPABILITIES } from '@space/workspace'
import { AGENT, asker, harness, OWNER, ownerDraft, RIDGEWAY, T0 } from '../test-support/harness'

/**
 * Writing from the space, on the inbox's side: what the inbox says it can do (so the space never sends a new email that picks a mailbox or carries
 * files to an inbox that would ignore both), a refused new email leaving no contact behind, the spam button's rule written once on the thread, and what a
 * draft's card needs to edit who is copied and to show who changed it. The big file is `space-compose.test.ts`.
 */

type H = ReturnType<typeof harness>

const KEY = (n: number | string) => `more-${n}`.padEnd(24, '0')
const hours = (n: number) => n * 3_600_000
const assertion = () => asker(OWNER)
const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}

async function world() {
  const h = harness({}, { ai: null, mailboxes: [RIDGEWAY] })
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
    id: 'm2',
    threadId: 't2',
    from: 'Eli Park <eli@example.com>',
    cc: 'Dana Smith <dana@example.com>',
    subject: 'Shared plan',
    body: 'Here is the plan, Dana is copied.',
    at: T0 - hours(3),
  })
  g.add({
    id: 'm3',
    threadId: 't3',
    from: 'Brand News <news@brand.example.com>',
    subject: 'Weekly deals',
    body: 'Ten percent off.',
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@brand.example.com>' },
    at: T0 - hours(2),
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
  const arrived = await h.deliver(
    `Return-Path: <priya.n@example.org>\nMIME-Version: 1.0\nFrom: Priya Nair <priya.n@example.org>\nDate: Mon, 26 Oct 2026 13:00:00 -0700\nMessage-ID: <p1@example.org>\nSubject: Hours question\nTo: info@ridgewaycycles.example\nContent-Type: text/plain; charset="UTF-8"\n\nAre you open on Sundays?\n`,
    { from: 'priya.n@example.org', to: 'info@ridgewaycycles.example' },
  )
  expect(arrived.entered).toBe('filed')
  return h
}

const contacts = (h: H) => (h.db.query(`SELECT count(*) AS n FROM contact`).get() as { n: number }).n
const identities = (h: H) => (h.db.query(`SELECT count(*) AS n FROM identity`).get() as { n: number }).n
const threadOf = async (h: H, address: string, subject?: string) => {
  const t = unwrap(
    await h.space().messagesWith(await assertion(), { address }, { include: ['bulk', 'closed'] }),
  ).threads
  return subject === undefined ? t[0] : t.find((x) => x.subject.includes(subject))
}

describe('what the inbox says it can do', () => {
  test('mailboxes lists the capabilities, so the space can tell an inbox that honours a new email’s mailbox and files from one that would ignore them', async () => {
    const h = await world()
    const listed = unwrap(await h.space().mailboxes(await assertion()))
    expect(listed.capabilities).toEqual([...INBOX_CAPABILITIES])
    expect(listed.capabilities).toContain('new-email-from-and-files')
  })
})

describe('a new email that is refused leaves nothing behind', () => {
  const send = async (h: H, over: Record<string, unknown>) =>
    h.space().send(await assertion(), {
      key: KEY(1),
      address: 'stranger@example.net',
      subject: 'Hello',
      text: 'Nice to meet you.',
      from: { kind: 'gmail' },
      ...over,
    } as never)

  test('no contact for the stranger after an em dash, an own address after it was made, or a Cloudflare refusal; the same key then sends and the contact is made once', async () => {
    const h = await world()
    const people = contacts(h)
    const ids = identities(h)
    expect(await send(h, { text: 'Nice \u2014 to meet you.' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await send(h, { subject: '' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(contacts(h)).toBe(people)
    expect(identities(h)).toBe(ids)
    expect(h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'contact.remove-unused'`).get()).toEqual({ n: 2 })
    // A refusal from Cloudflare itself, after the draft was made and the claim taken.
    h.email.always({ kind: 'throw', code: 'E_RECIPIENT_NOT_ALLOWED', message: 'Recipient not allowed' })
    const mailbox = unwrap(await h.space().mailboxes(await assertion())).mailboxes[0]?.id as string
    expect(await send(h, { from: { kind: 'business', mailboxId: mailbox } })).toMatchObject({
      ok: false,
      kind: 'refused',
    })
    expect(contacts(h)).toBe(people)
    h.email.always({ kind: 'accept' })
    expect(unwrap(await send(h, {})).status).toBe('sent')
    expect(contacts(h)).toBe(people + 1)
  })

  test('a contact the inbox already had is never taken away, whatever happens to the send', async () => {
    const h = await world()
    const people = contacts(h)
    expect(await send(h, { address: 'dana@example.com', text: 'Dash \u2014 here.' })).toMatchObject({ ok: false })
    expect(contacts(h)).toBe(people)
    expect(h.db.query(`SELECT count(*) AS n FROM identity WHERE address = 'dana@example.com'`).get()).toEqual({ n: 1 })
  })

  test('a contact somebody described, or whom mail came from, in the meantime is kept', async () => {
    const h = await world()
    const people = contacts(h)
    // The refused send happens with the contact made; before the discard a hand notes the contact (as People would). Modelled by making the contact first through a draft the same address.
    const made = await ownerDraft(h, {
      address: 'keeper@example.net',
      subject: 'Intro',
      body: 'Hello.',
    })
    expect(made.status).toBe(201)
    expect(contacts(h)).toBe(people + 1)
    expect(await send(h, { address: 'keeper@example.net', text: 'Dash \u2014 here.' })).toMatchObject({ ok: false })
    expect(contacts(h)).toBe(people + 1)
  })
})

describe('the spam button’s rule, once, on the thread', () => {
  test('a thread in a mailbox with nobody linked to a Client can be called spam; a Client’s person’s Inbox thread cannot, and one in Bulk can whoever is on it', async () => {
    const h = await world()
    const dana = await threadOf(h, 'dana@example.com', 'Quote')
    expect(dana?.canMarkSpam).toBe(true)
    expect((await threadOf(h, 'priya.n@example.org'))?.canMarkSpam).toBe(true)
    h.db
      .query(
        `UPDATE contact SET client_id = 7 WHERE id = (SELECT contact_id FROM identity WHERE address = 'dana@example.com')`,
      )
      .run()
    expect((await threadOf(h, 'dana@example.com', 'Quote'))?.canMarkSpam).toBe(false)
    // A thread shared with a Client's person counts for everyone on it, as the page's own rule reads every contact on the conversation.
    expect((await threadOf(h, 'eli@example.com', 'Shared plan'))?.canMarkSpam).toBe(false)
    // In Bulk, it can always be moved back.
    unwrap(
      await h.space().setSpam(await assertion(), {
        conversationId: (await threadOf(h, 'news@brand.example.com'))?.conversationId ?? '',
        spam: true,
      }),
    )
    expect((await threadOf(h, 'news@brand.example.com'))?.canMarkSpam).toBe(true)
  })
})

describe('what a draft’s card needs to edit it as the inbox’s card does', () => {
  async function claudeDraft(h: H, address: string, subject: string) {
    const thread = await threadOf(h, address, subject)
    const made = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: thread?.conversationId,
      body: 'Thanks, all.',
      why: 'They asked.',
    })
    expect(made.status).toBe(201)
    return { id: made.json.id as string, rev: made.json.rev as number }
  }

  test('a draft says why it was drafted, who changed it when that is not its author, and whether it can copy everyone', async () => {
    const h = await world()
    const d = await claudeDraft(h, 'dana@example.com', 'Quote')
    const first = unwrap(await h.space().drafts(await assertion())).find((x) => x.id === d.id)
    expect(first).toMatchObject({ why: 'They asked.', editedBy: null, canCopyEveryone: true })
    const edited = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'My words.' }),
    )
    expect(edited).toMatchObject({ why: 'They asked.', editedBy: 'owner', author: 'claude' })
    const mine = await ownerDraft(h, {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Hello.',
    })
    expect(unwrap(await h.space().drafts(await assertion())).find((x) => x.id === mine.json.id)).toMatchObject({
      canCopyEveryone: false,
      editedBy: null,
    })
  })

  test('copyEveryone on an edit copies everyone on the message it answers, and false clears it, as the inbox’s card does; left out the Cc stays', async () => {
    const h = await world()
    const d = await claudeDraft(h, 'eli@example.com', 'Shared plan')
    const on = unwrap(await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, copyEveryone: true }))
    expect(on.cc.map((c) => c.address)).toEqual(['dana@example.com'])
    expect(on.rev).toBe(d.rev + 1)
    const same = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: on.rev, text: 'Other words.' }),
    )
    expect(same.cc.map((c) => c.address)).toEqual(['dana@example.com'])
    const off = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: same.rev, copyEveryone: false }),
    )
    expect(off.cc).toEqual([])
  })

  test('cc on an edit is the owner adding and removing Cc addresses: it replaces the list, raises the revision, and shows as the draft’s cc with the names the inbox knows', async () => {
    const h = await world()
    const d = await claudeDraft(h, 'dana@example.com', 'Quote')
    const a = await assertion()
    const added = unwrap(
      await h
        .space()
        .editDraft(a, { draftId: d.id, rev: d.rev, cc: ['Ann@Example.org', 'ann@example.org', 'eli@example.com'] }),
    )
    expect(added.cc.map((c) => c.address)).toEqual(['ann@example.org', 'eli@example.com'])
    expect(added).toMatchObject({ rev: d.rev + 1, editedBy: 'owner' })
    // Taking one off is the same edit with the list as it should be; [] takes them all off.
    const less = unwrap(await h.space().editDraft(a, { draftId: d.id, rev: added.rev, cc: ['eli@example.com'] }))
    expect(less.cc.map((c) => c.address)).toEqual(['eli@example.com'])
    expect(unwrap(await h.space().editDraft(a, { draftId: d.id, rev: less.rev, cc: [] })).cc).toEqual([])
  })

  test('cc is refused, with nothing changed, when it is not a list of addresses, holds one that is not an address, or is on a draft that is not an email', async () => {
    const h = await world()
    const d = await claudeDraft(h, 'dana@example.com', 'Quote')
    const a = await assertion()
    for (const cc of ['ann@example.org', [5], ['nobody'], ['ann@example.org', 'a@b']]) {
      expect(
        await h.space().editDraft(a, { draftId: d.id, rev: d.rev, cc: cc as never }),
        JSON.stringify(cc),
      ).toMatchObject({
        ok: false,
        reason: 'bad-request',
      })
    }
    const text = await ownerDraft(h, { address: '+14155550123', body: 'Hi' })
    expect(
      await h.space().editDraft(a, { draftId: text.json.id, rev: text.json.rev, cc: ['ann@example.org'] }),
    ).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    const drafts = unwrap(await h.space().drafts(a))
    expect(drafts.find((x) => x.id === d.id)).toMatchObject({ rev: d.rev, cc: [] })
    expect(drafts.find((x) => x.id === text.json.id)?.rev).toBe(text.json.rev)
  })

  test('copyEveryone is refused where there is nobody to copy or it is not yes or no, and an edit with nothing in it is bad-request', async () => {
    const h = await world()
    const mine = await ownerDraft(h, {
      address: 'gus@example.net',
      subject: 'Intro',
      body: 'Hello.',
    })
    const a = await assertion()
    expect(
      await h.space().editDraft(a, { draftId: mine.json.id, rev: mine.json.rev, copyEveryone: true }),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(
      await h.space().editDraft(a, { draftId: mine.json.id, rev: mine.json.rev, copyEveryone: 'yes' as never }),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().editDraft(a, { draftId: mine.json.id, rev: mine.json.rev })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(unwrap(await h.space().drafts(a)).find((x) => x.id === mine.json.id)?.rev).toBe(mine.json.rev)
  })
})
