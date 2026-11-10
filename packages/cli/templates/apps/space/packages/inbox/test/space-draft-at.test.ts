import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall } from '@space/workspace'
import { AGENT, asHttp, asker, harness, OWNER, STRANGER, T0 } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * Where a draft's link opens (the part's `draftAt`), and the actions a draft on no conversation takes from the space: a first email to a new address, and a first LinkedIn message to a
 * new contact. Driven as the space drives them, through `InboxForSpace` with the Access assertion the space forwards, over the real store and Mailroom.
 *
 * What is proved: who is refused (and that a refused asker changed nothing), that a draft on no conversation is told as one, that the link a draft had keeps working once it is sent or marked
 * sent (the same message, now on a conversation), that a message that is gone or an id that is not one is `not-found`, and that Send, Edit and Mark sent take a draft on no conversation by
 * the same rules as one on a conversation: a compose key held (a second press sends nothing new), a revision named (a stale one changes nothing), and the owner alone.
 */

type H = ReturnType<typeof harness>

const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null

async function world(): Promise<H> {
  const h = harness()
  h.google.mailbox.add({
    id: 'm1',
    threadId: 't1',
    from: 'Dana Smith <dana@acme.example>',
    subject: 'Quote for the shop',
    body: 'Can you quote the shop front?',
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return h
}

/** A first email to an address the inbox has never heard of: a draft on no conversation. */
async function firstEmail(h: H) {
  const made = await h.request(AGENT, 'POST', '/api/drafts', {
    address: 'new.person@fresh.example',
    name: 'New Person',
    subject: 'Hello from Northfield Works',
    body: 'Hi, I would like to introduce what we do.',
    why: 'A first email to a new address.',
  })
  expect(made.status).toBe(201)
  expect(made.json.conversationId).toBeNull()
  return { id: made.json.id as string, rev: made.json.rev as number, contactId: made.json.contactId as string }
}

/** A first LinkedIn message to a new contact: the channel the inbox cannot send on. */
async function firstLinkedIn(h: H) {
  const made = await h.request(AGENT, 'POST', '/api/drafts', {
    address: '@new_person',
    name: 'New Person',
    body: 'Hello, thank you for the introduction.',
    why: 'A first LinkedIn message to a new contact.',
  })
  expect(made.status).toBe(201)
  return { id: made.json.id as string, rev: made.json.rev as number, contactId: made.json.contactId as string }
}

async function reply(h: H) {
  const convo = (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = 't1'`).get() as { id: string }).id
  const made = await h.request(AGENT, 'POST', '/api/drafts', {
    conversationId: convo,
    body: 'Hi Dana, the quote is $900.',
    why: 'She asked.',
  })
  expect(made.status).toBe(201)
  return { id: made.json.id as string, rev: made.json.rev as number, conversationId: convo }
}

describe('who is asking', () => {
  test('a person who is not Tessa (a teammate included) is not-admitted', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    for (const [who, reason] of [
      [STRANGER, 'not-admitted'],
      [{ email: 'eve@northfield.example' }, 'not-admitted'],
    ] as const) {
      expect([JSON.stringify(who), await withTeam.draftAt(asker(who) as never, d.id)]).toMatchObject([
        JSON.stringify(who),
        { ok: false, kind: 'refused', reason },
      ])
    }
  })

  test('the actions on a draft on no conversation refuse the same askers, and the draft stays as it was', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const hand = await firstLinkedIn(h)
    const calls = (a: never) => ({
      send: () => h.space().send(a, { key: KEY('x'), draftId: d.id, rev: d.rev, through: null }),
      editDraft: () => h.space().editDraft(a, { draftId: d.id, rev: d.rev, text: 'Hijacked.' }),
      markDraftSent: () => h.space().markDraftSent(a, hand.id),
    })
    for (const [who, reason] of [[STRANGER, 'not-admitted']] as const) {
      for (const [method, call] of Object.entries(calls(asker(who) as never))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason },
        ])
      }
    }
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(row(h, d.id)).toMatchObject({ status: 'draft', rev: d.rev })
    expect(row(h, hand.id)).toMatchObject({ status: 'draft' })
  })
})

describe('where the link of a draft opens', () => {
  test('a draft on no conversation is told as one, with who it is to and the words', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const at = unwrap(await h.space().draftAt(await assertion(), d.id))
    expect(at.state).toBe('draft')
    if (at.state !== 'draft') throw new Error('unreachable')
    expect(at.draft).toMatchObject({
      id: d.id,
      conversationId: null,
      contactId: d.contactId,
      toName: 'New Person',
      to: 'new.person@fresh.example',
      subject: 'Hello from Northfield Works',
      text: 'Hi, I would like to introduce what we do.',
      rev: d.rev,
      author: 'claude',
      kind: 'email',
      stuck: false,
      cc: [],
    })
    // It is the draft the list holds, field for field.
    expect(unwrap(await h.space().drafts(await assertion())).find((x) => x.id === d.id)).toEqual(at.draft)
  })

  test('a draft on a conversation is told as a draft too, with the conversation it is on', async () => {
    const h = await world()
    const d = await reply(h)
    const at = unwrap(await h.space().draftAt(await assertion(), d.id))
    expect(at).toMatchObject({ state: 'draft', draft: { id: d.id, conversationId: d.conversationId } })
  })

  test('once it is sent, the same link opens the conversation it made, and the words are not in the answer', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const sent = unwrap(
      await h.space().send(await assertion(), { key: KEY(1), draftId: d.id, rev: d.rev, through: null }),
    )
    expect(sent.status).toBe('sent')
    expect(sent.messageId).toBe(d.id)
    const at = unwrap(await h.space().draftAt(await assertion(), d.id))
    expect(at).toEqual({ state: 'filed', contactId: d.contactId, conversationId: sent.conversationId })
    expect(JSON.stringify(at)).not.toContain('introduce what we do')
  })

  test('a text or a LinkedIn message marked sent by hand opens its conversation, and taken back it is a draft again', async () => {
    const h = await world()
    const d = await firstLinkedIn(h)
    const filed = unwrap(await h.space().markDraftSent(await assertion(), d.id))
    expect(filed.conversationId).not.toBeNull()
    expect(unwrap(await h.space().draftAt(await assertion(), d.id))).toEqual({
      state: 'filed',
      contactId: d.contactId,
      conversationId: filed.conversationId as string,
    })
    unwrap(await h.space().unmarkSent(await assertion(), d.id))
    expect(unwrap(await h.space().draftAt(await assertion(), d.id))).toMatchObject({
      state: 'draft',
      draft: { id: d.id, kind: 'manual' },
    })
  })

  test('a draft that was deleted, a message that is not one and an id that is not an id are each not-found', async () => {
    const h = await world()
    const d = await firstEmail(h)
    expect(asHttp(await h.store.call('deleteDraft', d.id, OWNER_EMAIL, d.rev)).status).toBe(200)
    const a = await assertion()
    for (const id of [d.id, 'no-such-message', '../x', '', 'a'.repeat(300)]) {
      expect([id, await h.space().draftAt(a, id)]).toMatchObject([
        id,
        { ok: false, kind: 'refused', reason: 'not-found' },
      ])
    }
    expect(await h.space().draftAt(a, 5 as never)).toMatchObject({ ok: false, reason: 'not-found' })
  })
})

describe('the actions on a draft on no conversation', () => {
  test('Send as it stands: a first email goes to its address once; the same key again sends nothing new', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const first = unwrap(
      await h.space().send(await assertion(), { key: KEY(2), draftId: d.id, rev: d.rev, through: null }),
    )
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(h.google.mailbox.sent[0]?.headers.To).toContain('new.person@fresh.example')
    const again = await h.space().send(await assertion(), { key: KEY(2), draftId: d.id, rev: d.rev, through: null })
    expect(again).toMatchObject({ ok: false, reason: 'repeated' })
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(row(h, first.messageId)).toMatchObject({ status: 'sent' })
  })

  test('Send names the revision shown: a draft edited since is a conflict, nothing is sent, and the new revision goes', async () => {
    const h = await world()
    const d = await firstEmail(h)
    const edited = unwrap(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Hi, a shorter note.' }),
    )
    expect(
      await h.space().send(await assertion(), { key: KEY(3), draftId: d.id, rev: d.rev, through: null }),
    ).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(h.google.mailbox.sent).toHaveLength(0)
    // The refused first use released the key: pressing Send again with it, at the revision now shown, sends.
    unwrap(await h.space().send(await assertion(), { key: KEY(3), draftId: d.id, rev: edited.rev, through: null }))
    expect(h.google.mailbox.sent).toHaveLength(1)
    expect(row(h, d.id)).toMatchObject({ body: 'Hi, a shorter note.' })
  })

  test('Edit: the subject and the words are saved at the revision shown, as Tessa’s edit; a stale revision saves nothing; a draft that is sent is not edited', async () => {
    const h = await world()
    const d = await firstEmail(h)
    h.tick()
    const edited = unwrap(
      await h
        .space()
        .editDraft(await assertion(), { draftId: d.id, rev: d.rev, subject: 'Hello again', text: '  New words.  ' }),
    )
    expect(edited).toMatchObject({
      id: d.id,
      conversationId: null,
      subject: 'Hello again',
      text: 'New words.',
      rev: d.rev + 1,
      author: 'claude',
      editedBy: 'owner',
    })
    expect(rows(h, `SELECT actor FROM audit WHERE action = 'draft.update'`)).toEqual([
      { actor: 'tessa@northfield.example' },
    ])
    expect(await h.space().editDraft(await assertion(), { draftId: d.id, rev: d.rev, text: 'Stale.' })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(row(h, d.id)).toMatchObject({ body: 'New words.', rev: d.rev + 1 })
    unwrap(await h.space().send(await assertion(), { key: KEY(4), draftId: d.id, rev: edited.rev, through: null }))
    expect(
      await h.space().editDraft(await assertion(), { draftId: d.id, rev: edited.rev, text: 'After it went.' }),
    ).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('Mark sent: a LinkedIn message is filed on its contact once, and an email is refused in the inbox’s words', async () => {
    const h = await world()
    const hand = await firstLinkedIn(h)
    const email = await firstEmail(h)
    expect(await h.space().markDraftSent(await assertion(), email.id)).toMatchObject({
      ok: false,
      reason: 'bad-request',
      message: expect.stringContaining('An email is sent with Send'),
    })
    const filed = unwrap(await h.space().markDraftSent(await assertion(), hand.id))
    expect(filed.messageId).toBe(hand.id)
    expect(filed.conversationId).not.toBeNull()
    expect(await h.space().markDraftSent(await assertion(), hand.id)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(rows(h, `SELECT actor FROM audit WHERE action = 'message.mark-sent'`)).toEqual([
      { actor: 'tessa@northfield.example' },
    ])
    expect(row(h, email.id)).toMatchObject({ status: 'draft' })
  })
})

describe('a person is found by their contact id however old their conversations are', () => {
  test('past the newest screenful of conversations the list does not hold them, and asking for the contact does', async () => {
    const h = harness()
    const g = h.google.mailbox
    g.add({
      id: 'old',
      threadId: 'told',
      from: 'Old Friend <old@friend.example>',
      subject: 'A long time ago',
      body: 'Hello from way back.',
      at: T0 - 120 * 3_600_000,
    })
    for (let n = 0; n < 205; n++) {
      g.add({
        id: `n${n}`,
        threadId: `tn${n}`,
        from: `Person ${n} <p${n}@many.example>`,
        subject: `Thread ${n}`,
        body: `Message ${n}.`,
        at: T0 - (n + 1) * 60_000,
      })
    }
    expect((await h.connect()).ok).toBe(true)
    await h.drain(2000)
    const contactId = (
      rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = 'old@friend.example'`)[0] as {
        contact_id: string
      }
    ).contact_id
    const a = await assertion()
    const list = unwrap(await h.space().people(a, { include: ['bulk', 'closed'] }))
    expect(list.people.some((p) => p.contactId === contactId)).toBe(false)
    expect(list.more).toBe(true)
    const found = unwrap(await h.space().people(a, { include: ['bulk', 'closed'], contactIds: [contactId] }))
    expect(found.people.map((p) => p.contactId)).toEqual([contactId])
    expect(found.people[0]?.conversations).toHaveLength(1)
  })

  test('contactIds is a short list of ids: anything else is refused, and an id of the wrong shape names no one', async () => {
    const h = await world()
    const a = await assertion()
    expect(await h.space().people(a, { contactIds: 'c1' as never })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().people(a, { contactIds: Array.from({ length: 101 }, (_, i) => `c${i}`) })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().people(a, { contactIds: ['../x', 7 as never] })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(unwrap(await h.space().people(a, { contactIds: ['../x'] })).people).toEqual([])
    expect(unwrap(await h.space().people(a, { contactIds: [] })).people).toEqual([])
  })

  test('the asker is still the owner alone', async () => {
    const h = await world()
    expect(await h.space().people((await assertion(STRANGER)) as never, { contactIds: ['x'] })).toMatchObject({
      ok: false,
      reason: 'not-admitted',
    })
  })
})
