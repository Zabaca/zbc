import { describe, expect, test } from 'bun:test'
import { GmailError } from '../src/gmail/google'
import { backoffMs } from '../src/gmail/mailroom'
import { AGENT, asker, harness, OWNER, ownerDraft, pushBody, T0 } from '../test-support/harness'

/**
 * Several Gmail accounts: the Mailroom, the store and the space's part driven with three accounts at once, each with its own grant, cursor, watch and mail,
 * over a Google that can fail (test-support/fake-google.ts: a token reaches its own mailbox and no other). What is proved: each account is connected on its own, a push reaches only the
 * account it names, one account's lapse or failure never stops the others, a reply goes out from the account its conversation came through, a new email from the one chosen, and the
 * owner alone connects. What this cannot show is Google itself (a testing app's seven days, `invalid_grant`): the hand test, docs/runbooks/inbox-gmail-accounts.md.
 */

type H = ReturnType<typeof harness>

const ASHGROVE = { address: 'tessa@ashgrove.example', token: 'refresh-ashgrove', code: 'code-ashgrove' }
const HOMEMAIL = { address: 'tessa_marlow@gmail.com', token: 'refresh-homemail', code: 'code-homemail' }
const NORTHFIELD = 'refresh-token-1'
const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}

/** Tessa's northfield account (the harness's own), plus ashgrove and the gmail.com one, all connected; each holds one message from a different person. */
async function world() {
  const h = harness()
  h.google.mailbox.add({ id: 'z1', threadId: 'tz1', from: 'Dana Smith <dana@example.com>', subject: 'Quote', at: T0 })
  const ashgrove = h.google.addAccount(ASHGROVE.address, ASHGROVE.token, ASHGROVE.code)
  ashgrove.add({ id: 'f1', threadId: 'tf1', from: 'Arun Mehta <arun@example.org>', subject: 'Seed round', at: T0 })
  const homemail = h.google.addAccount(HOMEMAIL.address, HOMEMAIL.token, HOMEMAIL.code)
  homemail.add({ id: 'u1', threadId: 'tu1', from: 'Shop <orders@shop.example>', subject: 'Receipt', at: T0 })
  expect((await h.connect()).ok).toBe(true)
  expect((await h.connect(ASHGROVE.code)).ok).toBe(true)
  expect((await h.connect(HOMEMAIL.code)).ok).toBe(true)
  await h.drain()
  return { h, ashgrove, homemail }
}

const accounts = (h: H) => h.inbox.mailboxStatuses()
const idOf = (h: H, address: string) => (h.inbox.mailboxRowAt(address) as { id: string }).id
const mailboxOfThread = (h: H, thread: string) =>
  (
    h.db
      .query(
        `SELECT mb.address FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.gmail_thread_id = ?`,
      )
      .get(thread) as { address: string } | null
  )?.address
const conversationOf = (h: H, thread: string) =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(thread) as { id: string }).id
const throughOf = (h: H, conversationId: string) =>
  (
    h.db
      .query(`SELECT max(rowid) AS n FROM message WHERE conversation_id = ? AND status NOT IN ('draft', 'sending')`)
      .get(conversationId) as { n: number }
  ).n
/** Calls the fake saw for one account's token, by name. */
const callsFor = (h: H, token: string): string[] => h.google.calls.filter((_, i) => h.google.calledWith[i] === token)

describe('connecting several accounts', () => {
  test('each account is its own mailbox with its own grant, cursor, watch and label, and a second sign-in does not disturb the first', async () => {
    const { h } = await world()
    const all = accounts(h)
    expect(all.map((a) => [a.address, a.name, a.state, a.connected])).toEqual([
      ['tessa@northfield.example', 'northfield', 'live', true],
      ['tessa@ashgrove.example', 'ashgrove', 'live', true],
      ['tessa_marlow@gmail.com', 'tessa_marlow', 'live', true],
    ])
    expect(new Set(h.inbox.gmailMailboxes().map((r) => r.refreshToken)).size).toBe(3)
    expect(h.inbox.gmailMailboxes().every((r) => r.historyId !== null && r.watchExpiry !== null)).toBe(true)
    // Every account's mail is in the one store, each on a conversation of its own account.
    expect(mailboxOfThread(h, 'tz1')).toBe('tessa@northfield.example')
    expect(mailboxOfThread(h, 'tf1')).toBe('tessa@ashgrove.example')
    expect(mailboxOfThread(h, 'tu1')).toBe('tessa_marlow@gmail.com')
  })

  test('any address may be connected, and only the owner connects or disconnects', async () => {
    const h = harness()
    h.google.addAccount('someone@fernway.example', 'refresh-h', 'code-h')
    const refused = await h.mailroom.connectMailbox(
      'code-h',
      AGENT.common_name,
      'https://space.northfield.example/api/inbox/gmail/callback',
    )
    expect(refused).toMatchObject({ ok: false, status: 403 })
    expect(h.google.exchanged).toEqual([])
    expect((await h.connect('code-h')).ok).toBe(true)
    const id = idOf(h, 'someone@fernway.example')
    expect(await h.mailroom.disconnectMailbox(id, AGENT.common_name)).toMatchObject({ ok: false, status: 403 })
    expect(h.inbox.mailboxRow(id)?.refreshToken).toBe('refresh-h')
  })

  test('two accounts on one domain are told apart: the second wears its address', async () => {
    const h = harness()
    h.google.addAccount('ann@northfield.example', 'refresh-ann', 'code-ann')
    expect((await h.connect()).ok).toBe(true)
    expect((await h.connect('code-ann')).ok).toBe(true)
    expect(accounts(h).map((a) => a.name)).toEqual(['northfield', 'ann@northfield.example'])
  })

  test('disconnecting one leaves the others connected and syncing; it can be connected again with its cursor', async () => {
    const { h, ashgrove } = await world()
    const id = idOf(h, ASHGROVE.address)
    expect(unwrap(await h.mailroom.disconnectMailbox(id, 'tessa@northfield.example'))).toEqual({ revoked: true })
    expect(h.google.revoked).toEqual([ASHGROVE.token])
    expect(accounts(h).map((a) => [a.address, a.connected])).toEqual([
      ['tessa@northfield.example', true],
      ['tessa@ashgrove.example', false],
      ['tessa_marlow@gmail.com', true],
    ])
    ashgrove.add({ id: 'f2', threadId: 'tf2', subject: 'While away' })
    h.google.mailbox.add({ id: 'z2', threadId: 'tz2', subject: 'Still here' })
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.drain()
    expect(mailboxOfThread(h, 'tz2')).toBe('tessa@northfield.example')
    expect(mailboxOfThread(h, 'tf2')).toBeUndefined()
    // Connecting it again catches up from the cursor it kept: nothing is filled twice, and the mail it missed arrives.
    const before = h.inbox.mailboxRow(id)?.historyId
    expect((await h.connect(ASHGROVE.code)).ok).toBe(true)
    await h.drain()
    expect(h.inbox.gmailMailboxes()).toHaveLength(3)
    expect(h.inbox.mailboxRow(id)?.historyId).not.toBe(before)
    expect(mailboxOfThread(h, 'tf2')).toBe('tessa@ashgrove.example')
  })
})

describe('a push reaches only the account it names', () => {
  test('mail arriving in one account is read by asking that account and no other', async () => {
    const { h, ashgrove } = await world()
    ashgrove.add({ id: 'f2', threadId: 'tf2', from: 'Lane <lane@example.org>', subject: 'Term sheet' })
    h.google.calls.length = 0
    h.google.calledWith.length = 0
    expect((await h.push({ body: pushBody('tessa@ashgrove.example') })).status).toBe(204)
    await h.drain()
    expect(mailboxOfThread(h, 'tf2')).toBe('tessa@ashgrove.example')
    expect(callsFor(h, ASHGROVE.token).some((c) => c.startsWith('listHistory'))).toBe(true)
    expect(callsFor(h, NORTHFIELD)).toEqual([])
    expect(callsFor(h, HOMEMAIL.token)).toEqual([])
    const row = h.inbox.mailboxRowAt('tessa@ashgrove.example')
    expect(row?.lastPushAt).not.toBeNull()
    expect(h.inbox.mailboxRowAt('tessa@northfield.example')?.pushSeq).toBe(
      h.inbox.mailboxRowAt('tessa@northfield.example')?.syncedSeq,
    )
  })

  test('a push for an address the inbox does not hold, or whose account is disconnected, is acknowledged and changes nothing', async () => {
    const { h } = await world()
    await h.mailroom.disconnectMailbox(idOf(h, HOMEMAIL.address), 'tessa@northfield.example')
    h.google.calls.length = 0
    for (const address of ['nobody@example.com', HOMEMAIL.address]) {
      expect((await h.push({ body: pushBody(address) })).status).toBe(204)
    }
    await h.drain()
    expect(h.google.calls).toEqual([])
  })
})

describe('a grant Google no longer accepts', () => {
  test('the account is marked lapsed by name, nothing is retried for it, the others carry on, and the amber line says what to do', async () => {
    const { h, ashgrove } = await world()
    h.google.lapsed.add(ASHGROVE.token)
    ashgrove.add({ id: 'f2', threadId: 'tf2', subject: 'Missed' })
    h.google.mailbox.add({ id: 'z2', threadId: 'tz2', subject: 'Arrives' })
    expect((await h.push({ body: pushBody('tessa@ashgrove.example') })).status).toBe(204)
    expect((await h.push({ body: pushBody('tessa@northfield.example') })).status).toBe(204)
    await h.drain()

    const lapsed = accounts(h).find((a) => a.address === 'tessa@ashgrove.example')
    expect(lapsed).toMatchObject({ state: 'lapsed', connected: true })
    expect(lapsed?.lapsedAt).not.toBeNull()
    expect(lapsed?.health.amber).toBe(true)
    expect(lapsed?.health.reasons).toHaveLength(1)
    expect(lapsed?.health.reasons[0]).toContain('tessa@ashgrove.example')
    expect(lapsed?.health.reasons[0]).toContain('Connect it again')
    // The others are untouched, and the northfield mail arrived.
    expect(
      accounts(h)
        .filter((a) => a.state === 'live')
        .map((a) => a.address),
    ).toEqual(['tessa@northfield.example', 'tessa_marlow@gmail.com'])
    expect(mailboxOfThread(h, 'tz2')).toBe('tessa@northfield.example')
    // Nothing is asked of Google for it again: no push, no sync, no daily pass.
    const asked = callsFor(h, ASHGROVE.token).length
    await h.push({ body: pushBody('tessa@ashgrove.example') })
    await h.mailroom.runDaily()
    await h.drain()
    expect(callsFor(h, ASHGROVE.token)).toHaveLength(asked)
    expect(h.inbox.listAudit(50).some((e) => e.action === 'mailbox.lapse')).toBe(true)
  })

  test('connecting it again ends the lapse on the same row, keeps its cursor, and the mail it missed arrives', async () => {
    const { h, ashgrove } = await world()
    const id = idOf(h, ASHGROVE.address)
    h.google.lapsed.add(ASHGROVE.token)
    ashgrove.add({ id: 'f2', threadId: 'tf2', subject: 'Missed' })
    await h.push({ body: pushBody('tessa@ashgrove.example') })
    await h.drain()
    expect(h.inbox.mailboxStatus(id)?.state).toBe('lapsed')

    // A new grant: the account signs in at Google again and gets another refresh token.
    h.google.reissue(ASHGROVE.token, 'refresh-ashgrove-2', 'code-ashgrove-2')
    const back = unwrap(await h.connect('code-ashgrove-2'))
    expect(back).toMatchObject({ id, lapsedAt: null })
    expect(h.inbox.gmailMailboxes()).toHaveLength(3)
    expect(h.inbox.mailboxRow(id)).toMatchObject({ refreshToken: 'refresh-ashgrove-2', lapsedAt: null })
    // It is owed a catch-up from the cursor it kept (no second fill), and the message it missed arrives.
    h.google.lapsed.delete(ASHGROVE.token)
    await h.drain()
    expect(h.inbox.mailboxStatus(id)?.state).toBe('live')
    expect(mailboxOfThread(h, 'tf2')).toBe('tessa@ashgrove.example')
    expect(h.google.calls.filter((c) => c.startsWith('listMessageIds'))).toHaveLength(3)
  })

  test('a send from a lapsed account is refused in words before anything is claimed; a sync of it is refused; the other accounts send', async () => {
    const { h } = await world()
    h.google.lapsed.add(ASHGROVE.token)
    h.inbox.markGrantLapsed(idOf(h, ASHGROVE.address))
    const reply = await h.space().send(await assertion(), {
      key: KEY(1),
      conversationId: conversationOf(h, 'tf1'),
      through: throughOf(h, conversationOf(h, 'tf1')),
      text: 'Thanks, Arun.',
    })
    expect(reply).toMatchObject({ ok: false })
    expect(JSON.stringify(reply)).toContain('Connect it again')
    expect(h.google.mailbox.sent).toHaveLength(0)
    expect(
      (h.db.query(`SELECT count(*) AS n FROM message WHERE status IN ('draft', 'sending')`).get() as { n: number }).n,
    ).toBe(0)
    expect(await h.mailroom.requestSync(idOf(h, ASHGROVE.address))).toMatchObject({ ok: false, status: 409 })
    expect((await h.mailroom.requestSync()).ok).toBe(true)
  })

  test('the first call that finds the grant gone marks it: a read of a picture, a Close, a send', async () => {
    const { h } = await world()
    h.google.lapsed.add(HOMEMAIL.token)
    const conversationId = conversationOf(h, 'tu1')
    const closed = await h.mailroom.changeConversation(
      conversationId,
      'close',
      'tessa@northfield.example',
      throughOf(h, conversationId),
    )
    expect(closed).toMatchObject({ ok: false, status: 502 })
    expect(h.inbox.mailboxStatus(idOf(h, HOMEMAIL.address))?.state).toBe('lapsed')
    expect(h.inbox.mailboxStatus(idOf(h, 'tessa@northfield.example'))?.state).toBe('live')
  })
})

describe('one account failing does not stop the others', () => {
  test('a Gmail error for one account backs off for that account while another syncs', async () => {
    const { h, ashgrove } = await world()
    ashgrove.add({ id: 'f2', threadId: 'tf2', subject: 'Will fail' })
    h.google.mailbox.add({ id: 'z2', threadId: 'tz2', subject: 'Arrives' })
    h.google.failNext('listHistory', new GmailError('Backend Error', 500), 1)
    // The first account worked is northfield's, so the failure lands on it; either way exactly one account fails and the other stores.
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.push({ body: pushBody('tessa@ashgrove.example') })
    await h.drain()
    const stored = [mailboxOfThread(h, 'tz2'), mailboxOfThread(h, 'tf2')].filter((m) => m !== undefined)
    expect(stored).toHaveLength(1)
    const failed = accounts(h).filter((a) => a.lastError !== null)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.lastError).toContain('Backend Error')
    expect(failed[0]?.state).toBe('live')
    // The retry is asked for after the backoff, and then the failed account catches up.
    h.tick(backoffMs(1) + 1000)
    await h.drain()
    expect(mailboxOfThread(h, 'tz2')).toBe('tessa@northfield.example')
    expect(mailboxOfThread(h, 'tf2')).toBe('tessa@ashgrove.example')
    expect(accounts(h).every((a) => a.lastError === null)).toBe(true)
  })

  test('an account inside its backoff is left alone while another has work, until a push, a sync now or the time', async () => {
    const { h, ashgrove } = await world()
    const touched = () => callsFor(h, ASHGROVE.token).length
    // Ashgrove fails once and backs off.
    ashgrove.add({ id: 'f2', threadId: 'tf2', subject: 'Late' })
    h.google.failNext('listHistory', new GmailError('Backend Error', 500), 1)
    await h.push({ body: pushBody('tessa@ashgrove.example') })
    await h.drain()
    expect(mailboxOfThread(h, 'tf2')).toBeUndefined()
    expect(h.inbox.mailboxRowAt(ASHGROVE.address)?.retryCount).toBe(1)

    // Northfield Works gets mail; the alarm that serves it does not call ashgrove again before its time.
    h.google.mailbox.add({ id: 'z2', threadId: 'tz2', subject: 'Arrives' })
    const before = touched()
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.drain()
    expect(mailboxOfThread(h, 'tz2')).toBe('tessa@northfield.example')
    expect(touched()).toBe(before)
    expect(mailboxOfThread(h, 'tf2')).toBeUndefined()
    // Its own retry is still asked for, at the backoff.
    expect(h.alarms.at(-1)?.getTime()).toBe(h.now() + backoffMs(1))

    // "Sync now" on it is a person's word: it is worked at once, even while northfield has work too.
    h.google.mailbox.add({ id: 'z3', threadId: 'tz3', subject: 'More' })
    await h.push({ body: pushBody('tessa@northfield.example') })
    expect((await h.mailroom.requestSync(idOf(h, ASHGROVE.address))).ok).toBe(true)
    await h.drain()
    expect(mailboxOfThread(h, 'tf2')).toBe('tessa@ashgrove.example')
    expect(mailboxOfThread(h, 'tz3')).toBe('tessa@northfield.example')
  })

  test('the daily pass renews every account’s watch and syncs it; one account’s renewal failing is that account’s alone', async () => {
    const { h } = await world()
    h.google.calls.length = 0
    h.google.calledWith.length = 0
    await h.mailroom.runDaily()
    for (const token of [NORTHFIELD, ASHGROVE.token, HOMEMAIL.token]) {
      expect(callsFor(h, token).filter((c) => c.startsWith('watch'))).toHaveLength(1)
    }
    h.google.lapsed.add(HOMEMAIL.token)
    await h.mailroom.runDaily()
    expect(h.inbox.mailboxStatus(idOf(h, HOMEMAIL.address))?.state).toBe('lapsed')
    expect(accounts(h).filter((a) => a.state === 'live')).toHaveLength(2)
  })
})

describe('which account a new email or a draft goes from is said before Send', () => {
  const contactIdOf = (h: H, address: string) =>
    (h.db.query(`SELECT contact_id AS id FROM identity WHERE address = ?`).get(address) as { id: string }).id
  const draftsOf = async (h: H) => unwrap(await h.space().drafts(await assertion()))
  const ASHGROVE_FROM = { name: 'ashgrove', address: 'tessa@ashgrove.example' }
  const NORTHFIELD_FROM = { name: 'northfield', address: 'tessa@northfield.example' }

  test('a draft names its account: a reply the conversation’s, a new email the one the person last wrote to, else the default', async () => {
    const { h } = await world()
    // Arun wrote to ashgrove, Dana to northfield, a stranger to none (the default account, the owner's own).
    const toArun = (
      await ownerDraft(h, { contactId: contactIdOf(h, 'arun@example.org'), subject: 'Deck', body: 'Did it help?' })
    ).json
    const toStranger = (await ownerDraft(h, { address: 'fresh@example.net', subject: 'Hello', body: 'A first note.' }))
      .json
    const reply = (await ownerDraft(h, { conversationId: conversationOf(h, 'tf1'), body: 'Thanks, Arun.' })).json
    const drafts = await draftsOf(h)
    const from = (id: string) => drafts.find((d) => d.id === id)?.sendsFrom
    expect(from(toArun.id)).toEqual(ASHGROVE_FROM)
    expect(from(toStranger.id)).toEqual(NORTHFIELD_FROM)
    expect(from(reply.id)).toEqual(ASHGROVE_FROM)
    // It says nothing about how a stuck send is settled: that stays a business mailbox's `sentFrom`.
    expect(drafts.every((d) => d.sentFrom === undefined)).toBe(true)
  })

  test('a contact’s card names the account a new email goes from: the one they last wrote to, else the default', async () => {
    const { h } = await world()
    const contacts = unwrap(await h.space().contacts(await assertion(), { automated: true })).contacts
    const from = (address: string) => contacts.find((c) => c.addresses.includes(address))?.sendsFrom
    expect(from('arun@example.org')).toEqual(ASHGROVE_FROM)
    expect(from('dana@example.com')).toEqual(NORTHFIELD_FROM)
    // A contact made by a draft to a stranger has written to no mailbox: the default account.
    await ownerDraft(h, { address: 'fresh@example.net', subject: 'Hello', body: 'A first note.' })
    const after = unwrap(await h.space().contacts(await assertion())).contacts
    expect(after.find((c) => c.addresses.includes('fresh@example.net'))?.sendsFrom).toEqual(NORTHFIELD_FROM)
    expect(h.inbox.mailboxStatuses().map((a) => [a.address, a.sendsByDefault])).toEqual([
      ['tessa@northfield.example', true],
      ['tessa@ashgrove.example', false],
      ['tessa_marlow@gmail.com', false],
    ])
  })

  test('an account whose grant is gone is not chosen for a new email: the default sends it, and the card and the draft say so', async () => {
    const { h } = await world()
    const arun = contactIdOf(h, 'arun@example.org')
    h.google.lapsed.add(ASHGROVE.token)
    h.inbox.markGrantLapsed(idOf(h, ASHGROVE.address))
    const made = (await ownerDraft(h, { contactId: arun, subject: 'Deck', body: 'Did it help?' })).json
    expect(h.db.query(`SELECT mailbox_id FROM message WHERE id = ?`).get(made.id)).toEqual({ mailbox_id: null })
    expect((await draftsOf(h)).find((d) => d.id === made.id)?.sendsFrom).toEqual(NORTHFIELD_FROM)
    const card = unwrap(await h.space().contacts(await assertion())).contacts.find((c) => c.contactId === arun)
    expect(card?.sendsFrom).toEqual(NORTHFIELD_FROM)
    // The send goes, from the account the card named; it does not fail with a 503 for the lapsed one.
    const sent = unwrap(
      await h
        .space()
        .send(await assertion(), { key: KEY(20), address: 'arun@example.org', subject: 'Deck', text: 'Did it help?' }),
    )
    expect(sent.status).toBe('sent')
    expect(h.google.mailbox.sent).toHaveLength(1)

    // Disconnected is the same: the contact's last mailbox that can send is used, else the default.
    expect((await h.mailroom.disconnectMailbox(idOf(h, HOMEMAIL.address), 'tessa@northfield.example')).ok).toBe(true)
    const wrote = h.db.query(`SELECT id FROM contact WHERE name = 'Shop'`).get() as { id: string }
    const shop = unwrap(await h.space().contacts(await assertion(), { automated: true })).contacts.find(
      (c) => c.contactId === wrote.id,
    )
    expect(shop?.sendsFrom).toEqual(NORTHFIELD_FROM)
  })
})

describe('sending from the account that fits', () => {
  test('a reply goes out from the account its conversation came through, in that account’s Gmail thread', async () => {
    const { h, ashgrove } = await world()
    const conversationId = conversationOf(h, 'tf1')
    const sent = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(2),
        conversationId,
        through: throughOf(h, conversationId),
        text: 'Thanks, Arun. Looking at it now.',
      }),
    )
    expect(sent.status).toBe('sent')
    expect(ashgrove.sent).toHaveLength(1)
    expect(ashgrove.sent[0]?.headers.From).toContain('tessa@ashgrove.example')
    expect(ashgrove.sent[0]?.threadId).toBe('tf1')
    expect(h.google.mailbox.sent).toHaveLength(0)
    // The sent copy is filed on the same conversation, in the same account.
    expect(mailboxOfThread(h, ashgrove.sent[0]?.threadId as string)).toBe('tessa@ashgrove.example')
  })

  test('a new email goes from the account chosen; none chosen is the account the person last wrote to, else the owner’s own', async () => {
    const { h, ashgrove, homemail } = await world()
    const chosen = unwrap(
      await h.space().send(await assertion(), {
        key: KEY(3),
        address: 'fresh@example.net',
        subject: 'Hello',
        text: 'A first note.',
        from: { kind: 'gmail', mailboxId: idOf(h, HOMEMAIL.address) },
      }),
    )
    expect(chosen.status).toBe('sent')
    expect(homemail.sent).toHaveLength(1)
    expect(homemail.sent[0]?.headers.From).toContain('tessa_marlow@gmail.com')

    // Arun last wrote to ashgrove: with no choice it goes from there.
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(4),
        address: 'arun@example.org',
        subject: 'Following up',
        text: 'Did the deck help?',
      }),
    )
    expect(ashgrove.sent).toHaveLength(1)
    expect(ashgrove.sent[0]?.headers.From).toContain('tessa@ashgrove.example')

    // A stranger, no choice: the owner's own account, and `{ kind: 'gmail' }` with no id says the same.
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(5),
        address: 'stranger@example.net',
        subject: 'Hi',
        text: 'Nice to meet you.',
      }),
    )
    unwrap(
      await h.space().send(await assertion(), {
        key: KEY(6),
        address: 'other@example.net',
        subject: 'Hi again',
        text: 'And you.',
        from: { kind: 'gmail' },
      }),
    )
    expect(h.google.mailbox.sent.map((s) => s.headers.From)).toEqual([
      expect.stringContaining('tessa@northfield.example'),
      expect.stringContaining('tessa@northfield.example'),
    ])
  })

  test('an account that is none of the inbox’s is refused before anything is made; so is a business mailbox’s id given as a Gmail one', async () => {
    const { h } = await world()
    const contacts = () => (h.db.query(`SELECT count(*) AS n FROM contact`).get() as { n: number }).n
    const people = contacts()
    for (const mailboxId of ['no-such-account', 'x'.repeat(20)]) {
      const reply = await h.space().send(await assertion(), {
        key: KEY(`bad-${mailboxId.length}`),
        address: 'new@example.net',
        subject: 'Hi',
        text: 'Hello.',
        from: { kind: 'gmail', mailboxId },
      })
      expect(reply).toMatchObject({ ok: false })
    }
    expect(contacts()).toBe(people)
    expect(h.google.calls.filter((c) => c.startsWith('send'))).toEqual([])
  })

  test('Claude’s sending rule is the same on every account: off by default, and a send still needs his instruction', async () => {
    const { h } = await world()
    const created = await h.request(AGENT, 'POST', '/api/drafts', {
      conversationId: conversationOf(h, 'tf1'),
      body: 'Thanks.',
      why: 'Arun asked.',
    })
    expect(created.status).toBe(201)
    const sent = await h.request(AGENT, 'POST', `/api/drafts/${created.json.id}/send`, {
      rev: created.json.rev,
      through: throughOf(h, conversationOf(h, 'tf1')),
    })
    expect(sent.status).toBe(403)
  })
})

describe('what the space is told', () => {
  test('Settings lists every account with its id, label and state; the menu foot has one line each, the lapsed one saying why', async () => {
    const { h } = await world()
    h.google.lapsed.add(ASHGROVE.token)
    h.inbox.markGrantLapsed(idOf(h, ASHGROVE.address))
    const listed = unwrap(await h.space().mailboxes(await assertion()))
    expect(listed.gmailAccounts.map((a) => [a.name, a.state])).toEqual([
      ['northfield', 'live'],
      ['ashgrove', 'lapsed'],
      ['tessa_marlow', 'live'],
    ])
    expect(listed.gmailAccounts[1]?.lapsedAt).not.toBeNull()
    expect(listed.gmailAccounts[1]?.reasons[0]).toContain('Connect it again')
    expect(JSON.stringify(listed)).not.toMatch(/refresh|token|secret/i)

    const nav = unwrap(await h.space().navigation(await assertion()))
    expect(nav.gmailAccounts.map((a) => [a.name, a.state, a.reason === null])).toEqual([
      ['northfield', 'live', true],
      ['ashgrove', 'lapsed', false],
      ['tessa_marlow', 'live', true],
    ])
  })

  test('connecting an account again hints Google with that account’s address; a new account hints nothing; an unknown id is not-found', async () => {
    const { h } = await world()
    const state = 'ab12'.repeat(12)
    const hinted = unwrap(await h.space().gmailSignIn(await assertion(), state, idOf(h, ASHGROVE.address)))
    expect(new URL(hinted.url).searchParams.get('login_hint')).toBe('tessa@ashgrove.example')
    const fresh = unwrap(await h.space().gmailSignIn(await assertion(), state))
    expect(new URL(fresh.url).searchParams.get('login_hint')).toBeNull()
    expect(await h.space().gmailSignIn(await assertion(), state, 'no-such-account')).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
  })

  test('conversations carry the pill of the account they came through, and only a business mailbox’s allow files', async () => {
    const { h } = await world()
    const { people } = unwrap(await h.space().people(await assertion()))
    const pills = Object.fromEntries(people.map((p) => [p.name, p.conversations[0]?.mailbox?.name]))
    expect(pills).toMatchObject({ 'Dana Smith': 'northfield', 'Arun Mehta': 'ashgrove', Shop: 'tessa_marlow' })
    const arun = people.find((p) => p.name === 'Arun Mehta')
    const thread = unwrap(await h.space().messagesWith(await assertion(), { contactId: arun?.contactId as string }))
    expect(thread.threads[0]).toMatchObject({ mailbox: { name: 'ashgrove' }, canReply: true, canAttach: false })
  })
})

describe('Tessa’s own addresses never own a thread’s row while an outsider is on it', () => {
  test('Arun writes to the ashgrove account and Tessa answers from the northfield address with ashgrove copied: the conversation is Arun’s row, and the menu counts it once', async () => {
    const { h, ashgrove } = await world()
    // The answer arrives in ashgrove's mailbox as a copy, from Tessa's OTHER address, which is a participant there (it is not that mailbox's own address).
    ashgrove.add({
      id: 'f2',
      threadId: 'tf1',
      from: 'Tessa <tessa@northfield.example>',
      to: 'Arun Mehta <arun@example.org>',
      cc: 'tessa@ashgrove.example',
      subject: 'Re: Seed round',
      at: T0 + 60_000,
    })
    expect((await h.push({ body: pushBody('tessa@ashgrove.example') })).status).toBe(204)
    await h.drain()
    const a = await assertion()
    const { people } = unwrap(await h.space().people(a))
    const line = (who: string) =>
      people.find((p) => p.name === who)?.conversations.find((c) => c.subject.includes('Seed round'))
    expect(line('Arun Mehta')).toMatchObject({ listed: true })
    expect(line('Tessa Marlow')).toMatchObject({ listed: false })
    // A search hit leads with the person the lists put the thread under.
    const found = unwrap(await h.space().search(a, 'seed round'))
    expect(found.hits[0]?.people.map((p) => p.name)).toEqual(['Arun Mehta', 'Tessa Marlow'])
    // The menu counts the rows the list holds: Dana, Arun, the shop; none for "Tessa Marlow".
    const nav = unwrap(await h.space().navigation(a))
    expect(nav.views.inbox.count).toBe(
      people.filter((p) => p.conversations.some((c) => c.listed && c.open && !c.bulk)).length,
    )
  })
})
