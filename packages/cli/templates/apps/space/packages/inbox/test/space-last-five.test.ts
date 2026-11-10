import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall, type InboxForSpace } from '@space/workspace'
import { AGENT, asHttp, asker, harness, OWNER, ownerDraft, STRANGER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * The five things only the inbox's own page still did, now asked of the inbox by the space: settle a send Gmail
 * never confirmed, mark a text or a direct message sent by hand and take it back, rename a contact, split an address off one. Driven as the space drives them,
 * through `InboxForSpace` with the Access assertion the space forwards, over the real store and the real Mailroom (src/space.ts, src/space-people.ts).
 *
 * What is proved: who is refused (and that a refused asker changed nothing), every refusal of each write and that it leaves the store as it was, what each answer
 * carries and what never appears in one, and that the audit says the owner did it. What these cannot show is the runtime (the binding, the cloned answers) and
 * Gmail's own handling of a send that was lost; those are the runbook's checks after the deploy.
 */

type H = ReturnType<typeof harness>

const TESSA = 'tessa@northfield.example'
const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const audits = (h: H, action: string) =>
  rows<{ actor: string; action: string }>(h, `SELECT actor, action FROM audit WHERE action = '${action}'`)

const SECRET = 'The secret figure is 4,100.'

/** Dana under two addresses, and Eli: three conversations, read in from Gmail. */
async function world(): Promise<H> {
  const h = harness()
  const g = h.google.mailbox
  g.add({
    id: 'm1',
    threadId: 't1',
    from: 'Dana Smith <dana@acme.example>',
    subject: 'Quote for the shop',
    body: `Can you quote the shop front? ${SECRET}`,
  })
  g.add({
    id: 'm2',
    threadId: 't2',
    from: 'D. Smith <dana@home.example>',
    subject: 'From home',
    body: 'Writing from the other address.',
  })
  g.add({
    id: 'm3',
    threadId: 't3',
    from: 'Eli Park <eli@example.com>',
    subject: 'Shared plan',
    body: 'Here is the plan.',
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return h
}

const idOf = (h: H, address: string): string =>
  (
    rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0] as {
      contact_id: string
    }
  ).contact_id
const identityOf = (h: H, address: string): string =>
  (rows<{ id: string }>(h, `SELECT id FROM identity WHERE address = '${address}'`)[0] as { id: string }).id
const columns = (h: H, id: string) =>
  h.db.query(`SELECT name, business, role, notes, profile_rev FROM contact WHERE id = ?`).get(id)
const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

/** A reply to Dana whose send Gmail never answered: held as `sending`, the state only Tessa can settle. */
async function stuck(h: H): Promise<string> {
  const draft = await ownerDraft(h, {
    conversationId: convoId(h, 't1'),
    body: 'Thanks Dana. Tuesday works for me.',
  })
  expect(draft.status).toBe(201)
  h.google.loseSendAnswer = true
  const through = (await h.request(AGENT, 'GET', `/api/conversations/${convoId(h, 't1')}`)).json.through
  const sent = asHttp(
    await h.store.call(
      'sendDraft',
      draft.json.id,
      { rev: draft.json.rev, through, instruction: undefined },
      OWNER_EMAIL,
    ),
  )
  expect(sent.status).toBe(502)
  expect(row(h, draft.json.id)?.status).toBe('sending')
  return draft.json.id
}

/** A text and a LinkedIn message drafted to Dana's phone and handle: the channels the inbox cannot send on. */
async function handDrafts(h: H): Promise<{ text: string; linkedin: string }> {
  const text = await ownerDraft(h, {
    address: '626-555-0101',
    name: 'Dana',
    body: 'Hi Dana, running ten minutes late.',
  })
  const linkedin = await ownerDraft(h, {
    address: '@dana_r',
    name: 'Dana R',
    body: 'Thanks for the intro.',
  })
  expect([text.status, linkedin.status]).toEqual([201, 201])
  return { text: text.json.id, linkedin: linkedin.json.id }
}

const calls = (
  s: InboxForSpace,
  a: never,
  ids: { draft: string; message: string; contact: string; identity: string },
) => ({
  resolveSend: () => s.resolveSend(a, { draftId: ids.draft, sent: true }),
  markDraftSent: () => s.markDraftSent(a, ids.draft),
  unmarkSent: () => s.unmarkSent(a, ids.message),
  renameContact: () => s.renameContact(a, { contactId: ids.contact, rev: 0, name: 'Hijack' }),
  splitAddress: () => s.splitAddress(a, { contactId: ids.contact, rev: 0, identityId: ids.identity }),
})
const NAMES = ['markDraftSent', 'renameContact', 'resolveSend', 'splitAddress', 'unmarkSent']
const ids = (h: H, draft: string) => ({
  draft,
  message: draft,
  contact: idOf(h, 'dana@acme.example'),
  identity: identityOf(h, 'dana@acme.example'),
})

describe('who is asking, for each of the five', () => {
  test('there is a call here for each of the contract’s five new methods', () => {
    expect(
      Object.keys(calls(harness().space(), '' as never, { draft: '', message: '', contact: '', identity: '' })).sort(),
    ).toEqual(NAMES)
  })

  test('a person who is not Tessa (a teammate included) is not-admitted; neither changes anything', async () => {
    const h = await world()
    const draft = await stuck(h)
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    const before = {
      contacts: rows(h, `SELECT * FROM contact ORDER BY id`),
      messages: rows(h, `SELECT id, status FROM message ORDER BY id`),
      audit: rows(h, `SELECT * FROM audit`).length,
    }
    for (const [who, reason] of [
      [STRANGER, 'not-admitted'],
      [{ email: 'eve@northfield.example' }, 'not-admitted'],
    ] as const) {
      for (const [method, call] of Object.entries(calls(withTeam, asker(who) as never, ids(h, draft)))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason },
        ])
      }
    }
    expect({
      contacts: rows(h, `SELECT * FROM contact ORDER BY id`),
      messages: rows(h, `SELECT id, status FROM message ORDER BY id`),
      audit: rows(h, `SELECT * FROM audit`).length,
    }).toEqual(before)
  })
})

describe('settling a send Gmail never confirmed', () => {
  test('it went out: the stuck draft is removed, Gmail’s own copy is the record, and the audit says the owner said so; the answer is the id and the status and nothing of the words', async () => {
    const h = await world()
    const draft = await stuck(h)
    const listed = unwrap(await h.space().drafts(await assertion()))
    expect(listed.find((d) => d.id === draft)).toMatchObject({ stuck: true, kind: 'email' })
    const done = unwrap(await h.space().resolveSend(await assertion(), { draftId: draft, sent: true }))
    expect(done).toEqual({ id: draft, status: 'removed' })
    expect(row(h, draft)).toBeNull()
    expect(unwrap(await h.space().drafts(await assertion()))).toEqual([])
    expect(audits(h, 'message.send-resolved')).toEqual([{ actor: TESSA, action: 'message.send-resolved' }])
    expect(JSON.stringify(done)).not.toContain('Tuesday')
  })

  test('it did not: the draft is a draft again, and sending it then is his decision', async () => {
    const h = await world()
    const draft = await stuck(h)
    expect(unwrap(await h.space().resolveSend(await assertion(), { draftId: draft, sent: false }))).toEqual({
      id: draft,
      status: 'draft',
    })
    expect(row(h, draft)?.status).toBe('draft')
    expect(unwrap(await h.space().drafts(await assertion())).find((d) => d.id === draft)).toMatchObject({
      stuck: false,
    })
  })

  test('a yes or a no is required: an empty request, a word or a number means neither, and the message stays stuck', async () => {
    const h = await world()
    const draft = await stuck(h)
    const a = await assertion()
    for (const bad of [
      { draftId: draft },
      { draftId: draft, sent: 'yes' },
      { draftId: draft, sent: 1 },
      { draftId: draft, sent: null },
    ] as never[]) {
      expect(await h.space().resolveSend(a, bad)).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(await h.space().resolveSend(a, null as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(row(h, draft)?.status).toBe('sending')
    expect(audits(h, 'message.send-resolved')).toEqual([])
  })

  test('a message that is not waiting on a send is refused as conflict, one that is not there as not-found, and a path-shaped id never reaches the store', async () => {
    const h = await world()
    const plain = await ownerDraft(h, {
      conversationId: convoId(h, 't1'),
      body: 'A plain draft.',
    })
    const a = await assertion()
    expect(await h.space().resolveSend(a, { draftId: plain.json.id, sent: true })).toMatchObject({
      ok: false,
      reason: 'conflict',
      message: 'That message is not waiting on a send.',
    })
    expect(row(h, plain.json.id)?.status).toBe('draft')
    expect(await h.space().resolveSend(a, { draftId: 'no-such-message', sent: true })).toMatchObject({
      ok: false,
      reason: 'not-found',
      message: 'No such message.',
    })
    expect(await h.space().resolveSend(a, { draftId: '../../etc', sent: true })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().resolveSend(a, { draftId: 7 as never, sent: true })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
  })

  test('saying it twice is refused the second time: the first answer stands and nothing is applied twice', async () => {
    const h = await world()
    const draft = await stuck(h)
    const a = await assertion()
    unwrap(await h.space().resolveSend(a, { draftId: draft, sent: false }))
    expect(await h.space().resolveSend(a, { draftId: draft, sent: false })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(audits(h, 'message.send-resolved')).toHaveLength(1)
  })

  test('"it did not go out" is refused when Gmail’s own copy is already held, as the inbox’s page refuses it', async () => {
    const h = await world()
    const draft = await stuck(h)
    expect((await h.push()).status).toBe(204)
    h.tick()
    await h.drain()
    const refused = await h.space().resolveSend(await assertion(), { draftId: draft, sent: false })
    expect(refused).toMatchObject({ ok: false, reason: 'conflict' })
    expect(row(h, draft)?.status).toBe('sending')
    expect(unwrap(await h.space().resolveSend(await assertion(), { draftId: draft, sent: true })).status).toBe(
      'removed',
    )
  })
})

describe('marking a text or a direct message sent by hand, and taking it back', () => {
  test('a draft carries the channel it goes by, and an email draft says email, so the space offers Mark sent on the first two only', async () => {
    const h = await world()
    const { text, linkedin } = await handDrafts(h)
    const mail = await ownerDraft(h, {
      conversationId: convoId(h, 't1'),
      body: 'An email draft.',
    })
    const listed = unwrap(await h.space().drafts(await assertion()))
    expect(Object.fromEntries(listed.map((d) => [d.id, d.kind]))).toEqual({
      [text]: 'sms',
      [linkedin]: 'manual',
      [mail.json.id]: 'email',
    })
  })

  test('marking sent files the message read and closed on the person’s conversation for its channel, as the owner, and the history says it was sent by hand', async () => {
    const h = await world()
    const { text } = await handDrafts(h)
    h.tick()
    const done = unwrap(await h.space().markDraftSent(await assertion(), text))
    expect(done.messageId).toBe(text)
    expect(done.conversationId).not.toBeNull()
    expect(row(h, text)).toMatchObject({ status: 'manual-sent', sent_by: TESSA })
    expect(audits(h, 'message.mark-sent')).toEqual([{ actor: TESSA, action: 'message.mark-sent' }])
    const dana = idOf(h, '+16265550101')
    const history = unwrap(
      await h.space().messagesWith(await assertion(), { contactId: dana }, { include: ['closed'] }),
    )
    expect(history.messages.find((m) => m.id === text)).toMatchObject({
      direction: 'out',
      sentByHand: true,
      text: 'Hi Dana, running ten minutes late.',
    })
    // The answer is two ids: no words.
    expect(JSON.stringify(done)).not.toContain('running ten minutes')
  })

  test('"Not sent after all" makes it a draft again, and the history no longer has it', async () => {
    const h = await world()
    const { linkedin } = await handDrafts(h)
    const a = await assertion()
    unwrap(await h.space().markDraftSent(a, linkedin))
    const undone = unwrap(await h.space().unmarkSent(a, linkedin))
    expect(undone.messageId).toBe(linkedin)
    expect(row(h, linkedin)).toMatchObject({ status: 'draft', sent_at: null })
    expect(audits(h, 'message.unmark-sent')).toEqual([{ actor: TESSA, action: 'message.unmark-sent' }])
    expect(unwrap(await h.space().drafts(a)).map((d) => d.id)).toContain(linkedin)
  })

  test('an email is refused (it is sent with Send), a message that is not a draft is a conflict, one that is not there is not-found; each leaves the store as it was', async () => {
    const h = await world()
    const { text } = await handDrafts(h)
    const mail = await ownerDraft(h, {
      conversationId: convoId(h, 't1'),
      body: 'An email draft.',
    })
    const a = await assertion()
    const before = rows(h, `SELECT id, status FROM message ORDER BY id`)
    expect(await h.space().markDraftSent(a, mail.json.id)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().markDraftSent(a, 'm1')).toMatchObject({ ok: false })
    expect(await h.space().markDraftSent(a, 'no-such-message')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().markDraftSent(a, '../x')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(rows(h, `SELECT id, status FROM message ORDER BY id`)).toEqual(before)
    unwrap(await h.space().markDraftSent(a, text))
    // The second press finds a message that is no longer a draft: refused, not filed twice.
    expect(await h.space().markDraftSent(a, text)).toMatchObject({
      ok: false,
      reason: 'conflict',
      message: 'Only a draft can be marked sent.',
    })
    expect(rows(h, `SELECT * FROM message WHERE status = 'manual-sent'`)).toHaveLength(1)
    expect(audits(h, 'message.mark-sent')).toHaveLength(1)
  })

  test('only a message marked sent by hand can be unmarked: a draft, a received email and a message that is not there are refused', async () => {
    const h = await world()
    const { text } = await handDrafts(h)
    const a = await assertion()
    expect(await h.space().unmarkSent(a, text)).toMatchObject({
      ok: false,
      reason: 'conflict',
      message: 'Only a message marked sent by hand can be unmarked.',
    })
    const received = (
      rows<{ id: string }>(h, `SELECT id FROM message WHERE direction = 'in' LIMIT 1`)[0] as { id: string }
    ).id
    expect(await h.space().unmarkSent(a, received)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await h.space().unmarkSent(a, 'no-such-message')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().unmarkSent(a, '../x')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(row(h, received)?.status).not.toBe('draft')
    expect(audits(h, 'message.unmark-sent')).toEqual([])
  })

  test('an email the Outbox carried in as sent has the same status but never says `sentByHand`, so no way to send it again is offered', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    h.db.query(`UPDATE message SET status = 'manual-sent' WHERE conversation_id = ?`).run(convoId(h, 't1'))
    const history = unwrap(await h.space().messagesWith(await assertion(), { contactId: id }))
    expect(rows(h, `SELECT id FROM message WHERE status = 'manual-sent'`).length).toBeGreaterThan(0)
    expect(history.messages.length).toBeGreaterThan(0)
    expect(history.messages.every((m) => !('sentByHand' in m))).toBe(true)
  })

  test('a message that is not marked sent by hand carries no `sentByHand`', async () => {
    const h = await world()
    const history = unwrap(await h.space().messagesWith(await assertion(), { contactId: idOf(h, 'dana@acme.example') }))
    expect(history.messages.length).toBeGreaterThan(0)
    expect(history.messages.every((m) => !('sentByHand' in m))).toBe(true)
  })
})

describe('renaming a contact, at the revision shown', () => {
  test('the name is trimmed, the revision goes up, the owner is in the audit with the old name, and the answer is the contact as it now stands', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const done = unwrap(
      await h.space().renameContact(await assertion(), { contactId: id, rev: 0, name: '  Dana Smith-Lane ' }),
    )
    expect(done).toMatchObject({ contactId: id, name: 'Dana Smith-Lane', rev: 1, addresses: ['dana@acme.example'] })
    expect(columns(h, id)).toMatchObject({ name: 'Dana Smith-Lane', profile_rev: 1 })
    expect(
      rows<{ actor: string; before: string; after: string }>(
        h,
        `SELECT actor, before, after FROM audit WHERE action = 'contact.rename'`,
      ),
    ).toEqual([
      {
        actor: TESSA,
        before: JSON.stringify({ name: 'Dana Smith' }),
        after: JSON.stringify({ name: 'Dana Smith-Lane' }),
      },
    ])
  })

  test('a rename from a screen read before another change is refused and keeps the name; read again, it goes through', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    unwrap(await h.space().saveContactProfile(a, { contactId: id, rev: 0, business: 'Acme', role: '', notes: '' }))
    const stale = await h.space().renameContact(a, { contactId: id, rev: 0, name: 'Someone Else' })
    expect(stale).toMatchObject({ ok: false, kind: 'refused', reason: 'conflict' })
    expect(columns(h, id)).toMatchObject({ name: 'Dana Smith', profile_rev: 1 })
    expect(audits(h, 'contact.rename')).toEqual([])
    const fresh = unwrap(await h.space().contact(a, id))
    expect(unwrap(await h.space().renameContact(a, { contactId: id, rev: fresh.rev, name: 'Someone Else' })).rev).toBe(
      2,
    )
    // And a second rename from the first screen is stale too.
    expect(await h.space().renameContact(a, { contactId: id, rev: fresh.rev, name: 'Third' })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(columns(h, id)).toMatchObject({ name: 'Someone Else' })
  })

  test('an empty name, a name that is not text, a missing revision and a contact that is not there are refused with the inbox’s words, and change nothing', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    expect(await h.space().renameContact(a, { contactId: id, rev: 0, name: '   ' })).toMatchObject({
      ok: false,
      reason: 'bad-request',
      message: 'A contact needs a name.',
    })
    expect(await h.space().renameContact(a, { contactId: id, rev: 0, name: 7 as never })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().renameContact(a, { contactId: id, rev: -1, name: 'X' })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().renameContact(a, { contactId: id, rev: 'x' as never, name: 'X' })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().renameContact(a, null as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().renameContact(a, { contactId: 'no-such-contact', rev: 0, name: 'X' })).toMatchObject({
      ok: false,
      reason: 'not-found',
      message: 'No such contact.',
    })
    expect(await h.space().renameContact(a, { contactId: '../x', rev: 0, name: 'X' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(columns(h, id)).toMatchObject({ name: 'Dana Smith', profile_rev: 0 })
    expect(audits(h, 'contact.rename')).toEqual([])
  })

  test('the answer is the contact: no message, subject or draft of theirs appears in it', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const done = unwrap(await h.space().renameContact(await assertion(), { contactId: id, rev: 0, name: 'Dana S.' }))
    const json = JSON.stringify(done)
    for (const never of [SECRET, 'Quote for the shop', 'shop front']) expect(json).not.toContain(never)
  })

  test('the store’s own rename (no revision, as Claude’s script makes it) still works, and its rename raises the revision too, so a screen of the space opened before it is refused', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    expect(asHttp(await h.store.call('renameContact', id, 'Renamed Here', OWNER_EMAIL)).status).toBe(200)
    expect(await h.space().renameContact(await assertion(), { contactId: id, rev: 0, name: 'Stale' })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(columns(h, id)).toMatchObject({ name: 'Renamed Here', profile_rev: 1 })
  })

  test('undoing a merge still puts the survivor’s fields back after a rename, which raises the revision without touching them', async () => {
    const h = await world()
    const survivor = idOf(h, 'dana@acme.example')
    const absorbed = idOf(h, 'dana@home.example')
    const a = await assertion()
    unwrap(
      await h.space().saveContactProfile(a, { contactId: absorbed, rev: 0, business: 'Home Co', role: '', notes: '' }),
    )
    const done = unwrap(
      await h.space().mergeContacts(a, { survivorId: survivor, survivorRev: 0, absorbedId: absorbed, absorbedRev: 1 }),
    )
    expect(columns(h, survivor)).toMatchObject({ business: 'Home Co' })
    unwrap(await h.space().renameContact(a, { contactId: survivor, rev: done.survivor.rev, name: 'Dana S.' }))
    unwrap(await h.space().undoContactMerge(a, done.mergeId))
    expect(columns(h, survivor)).toMatchObject({ name: 'Dana S.', business: '' })
  })
})

describe('splitting an address off a contact, at the revision shown', () => {
  async function merged() {
    const h = await world()
    const a = await assertion()
    const survivor = idOf(h, 'dana@acme.example')
    const absorbed = idOf(h, 'dana@home.example')
    const done = unwrap(
      await h.space().mergeContacts(a, { survivorId: survivor, survivorRev: 0, absorbedId: absorbed, absorbedRev: 0 }),
    )
    return {
      h,
      a,
      survivor,
      rev: done.survivor.rev,
      home: identityOf(h, 'dana@home.example'),
      acme: identityOf(h, 'dana@acme.example'),
    }
  }

  test('the address goes to a new contact named by it, with its conversations; the contact it came off keeps the rest and its revision goes up; the audit names the owner', async () => {
    const { h, a, survivor, rev, home } = await merged()
    const done = unwrap(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: home }))
    expect(done.from).toMatchObject({
      contactId: survivor,
      name: 'Dana Smith',
      addresses: ['dana@acme.example'],
      rev: rev + 1,
      conversations: 1,
    })
    expect(done.contact).toMatchObject({
      name: 'dana@home.example',
      addresses: ['dana@home.example'],
      client: null,
      rev: 0,
      conversations: 1,
    })
    expect(done.contact.contactId).not.toBe(survivor)
    expect(columns(h, survivor)).toMatchObject({ profile_rev: rev + 1 })
    expect(audits(h, 'contact.split')).toEqual([{ actor: TESSA, action: 'contact.split' }])
  })

  test('a split from a screen read before another change is refused and splits nothing', async () => {
    const { h, a, survivor, rev, home } = await merged()
    unwrap(await h.space().renameContact(a, { contactId: survivor, rev, name: 'Dana S.' }))
    expect(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: home })).toMatchObject({
      ok: false,
      kind: 'refused',
      reason: 'conflict',
    })
    expect(rows(h, `SELECT * FROM identity WHERE contact_id = '${survivor}'`)).toHaveLength(2)
    expect(audits(h, 'contact.split')).toEqual([])
  })

  test('an address that is not that contact’s is "No such address", whoever else holds it, and nothing moves', async () => {
    const { h, a, survivor, rev } = await merged()
    const eli = identityOf(h, 'eli@example.com')
    expect(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: eli })).toMatchObject({
      ok: false,
      reason: 'not-found',
      message: 'No such address.',
    })
    expect(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: 'no-such-address' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: '../x' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().splitAddress(a, { contactId: 'no-such-contact', rev, identityId: eli })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(rows(h, `SELECT * FROM identity WHERE contact_id = '${idOf(h, 'eli@example.com')}'`)).toHaveLength(1)
    expect(audits(h, 'contact.split')).toEqual([])
  })

  test('a contact’s only address cannot be split off, and a missing revision is refused', async () => {
    const h = await world()
    const a = await assertion()
    const eli = idOf(h, 'eli@example.com')
    expect(
      await h.space().splitAddress(a, { contactId: eli, rev: 0, identityId: identityOf(h, 'eli@example.com') }),
    ).toMatchObject({
      ok: false,
      reason: 'bad-request',
      message: 'That is this contact’s only address, so there is nothing to split off.',
    })
    expect(
      await h
        .space()
        .splitAddress(a, { contactId: eli, rev: undefined as never, identityId: identityOf(h, 'eli@example.com') }),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().splitAddress(a, null as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(columns(h, eli)).toMatchObject({ profile_rev: 0 })
    expect(audits(h, 'contact.split')).toEqual([])
  })

  test('splitting the same address twice: the second names an address no longer on that contact, and is refused', async () => {
    const { h, a, survivor, rev, home } = await merged()
    unwrap(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: home }))
    expect(await h.space().splitAddress(a, { contactId: survivor, rev: rev + 1, identityId: home })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(audits(h, 'contact.split')).toHaveLength(1)
  })

  test('the answers carry the two contacts and no message, subject or draft', async () => {
    const { h, a, survivor, rev, home } = await merged()
    const json = JSON.stringify(unwrap(await h.space().splitAddress(a, { contactId: survivor, rev, identityId: home })))
    for (const never of [SECRET, 'Quote for the shop', 'From home', 'Writing from the other address'])
      expect(json).not.toContain(never)
  })

  test('the store’s own split (no revision, as Claude’s script makes it) still works, and what it splits raises the revision of the contact it came off', async () => {
    const { h, survivor, rev, home } = await merged()
    expect(asHttp(await h.store.call('splitIdentity', home, OWNER_EMAIL)).status).toBe(200)
    expect(columns(h, survivor)).toMatchObject({ profile_rev: rev + 1 })
  })
})
