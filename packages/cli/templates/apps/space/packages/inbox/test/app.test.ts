import { describe, expect, test } from 'bun:test'
import { AGENT, AGENT_ID, asHttp, count, harness, ownerDraft, STRANGER, T0 } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * The inbox's Worker driven as a function: the real router and verifier, the real
 * store over a real SQLite. The highest seam these tests have;
 * the store, queue and address rules below it have their own tables.
 */

type H = ReturnType<typeof harness>

/**
 * Tessa's side of these rules. The owner no longer has a router (they work through the space, which calls the inbox's methods), so the
 * rules that differ by who acts are driven as the owner on the store directly, with what each route used to pass, and answered `{ status, json }` as the route did.
 */
const ownerPatch = async (h: H, id: string, body: Record<string, any>) => {
  if (!Number.isInteger(body.rev) || body.rev < 0)
    return { status: 422, json: { error: 'Say which version of the draft you were shown.' } }
  const patch: Record<string, unknown> = { rev: body.rev }
  for (const key of ['subject', 'body', 'why'])
    if (key in body) patch[key] = typeof body[key] === 'string' ? body[key] : ''
  if (typeof body.copyEveryone === 'boolean') patch.copyEveryone = body.copyEveryone
  if (body.cc !== undefined) patch.cc = body.cc
  return asHttp(await h.store.call('updateDraft', id, patch as never, OWNER_EMAIL))
}
const ownerDelete = async (h: H, id: string, rev: number) =>
  asHttp(await h.store.call('deleteDraft', id, OWNER_EMAIL, rev))
const ownerMarkSent = async (h: H, id: string, body: { sentAt?: string } = {}) =>
  asHttp(
    await h.store.call(
      'markSent',
      id,
      typeof body.sentAt === 'string' && body.sentAt !== '' ? body.sentAt : undefined,
      OWNER_EMAIL,
    ),
  )
const ownerUnmarkSent = async (h: H, id: string) => asHttp(await h.store.call('unmarkSent', id, OWNER_EMAIL))
const ownerRename = async (h: H, id: string, body: { name?: string }) =>
  asHttp(await h.store.call('renameContact', id, typeof body.name === 'string' ? body.name : '', OWNER_EMAIL))

describe('who gets in', () => {
  // The gate itself (the assertion, the audience, the cookie, who the identity becomes) is test/access.test.ts and test/claude-door.test.ts. What is here is what the
  // router adds around it.
  test('a write from a page on another site is refused, a same-site one is not', async () => {
    const h = harness()
    const body = { address: 'dana@example.com', body: 'Hi', subject: 's', why: 'x' }
    const cross = await h.request(AGENT, 'POST', '/api/drafts', body, { 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    const foreign = await h.request(AGENT, 'POST', '/api/drafts', body, { origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    const same = await h.request(AGENT, 'POST', '/api/drafts', body, { origin: 'https://space.northfield.example' })
    expect(same.status).toBe(201)
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toHaveLength(1)
  })

  test('the dev identity exists only when built for dev, only on localhost, and never beside an assertion', async () => {
    const dev = harness({ devActor: 'agent:dev@localhost' })
    const local = await dev.app.request('http://localhost:4660/api/mailbox', {}, dev.env)
    expect(local.status).toBe(200)
    // It is the agent, so a local run of the script behaves as the real door does (sending is switched off and needs Tessa's instruction).
    const draft = await dev.app.request(
      'http://localhost:4660/api/drafts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'a@example.com', body: 'Hi', why: 'x' }),
      },
      dev.env,
    )
    expect(((await draft.json()) as { createdBy: string }).createdBy).toBe('agent:dev@localhost')
    const remote = await dev.app.request('https://space.northfield.example/api/mailbox', {}, dev.env)
    expect(remote.status).toBe(401)
    const withBadAssertion = await dev.app.request(
      'http://localhost:4660/api/mailbox',
      { headers: { 'cf-access-jwt-assertion': 'junk' } },
      dev.env,
    )
    expect(withBadAssertion.status).toBe(401)

    const prod = harness()
    expect((await prod.app.request('http://localhost:4660/api/mailbox', {}, prod.env)).status).toBe(401)
  })

  test('the dev identity is held to the cross-site write check like everyone else', async () => {
    const dev = harness({ devActor: 'agent:dev@localhost' })
    const post = (headers: Record<string, string>) =>
      dev.app.request(
        'http://localhost:4660/api/drafts',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ address: 'a@example.com', body: 'Hi', why: 'x' }),
        },
        dev.env,
      )
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ origin: 'http://localhost:4660' })).status).toBe(201)
    expect(await dev.inbox.listDrafts()).toHaveLength(1)
  })

  test('nothing of ours can be framed: every response says so, refusals included', async () => {
    const h = harness()
    const responses = [
      await h.request(AGENT, 'GET', '/api/queue'),
      await h.request(null, 'GET', '/api/queue'),
      await h.request(STRANGER, 'GET', '/api/queue'),
      await h.request(AGENT, 'GET', '/api/nothing'),
      await h.request(AGENT, 'GET', '/'),
      await h.request(null, 'GET', '/'),
    ]
    expect(responses.map((r) => r.status)).toEqual([200, 401, 403, 404, 404, 401])
    for (const res of responses) {
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })

  test('no answer may be kept by the browser or anything on the way: every one says no-store, refusals included, an encoded spelling of a path too', async () => {
    const h = harness()
    const api = [
      await h.request(AGENT, 'GET', '/api/queue'),
      await h.request(null, 'GET', '/api/queue'),
      await h.request(STRANGER, 'GET', '/api/queue'),
      await h.request(AGENT, 'GET', '/api/nothing'),
      await h.request(AGENT, 'POST', '/api/drafts', { address: 'a@example.com', body: 'Hi', why: 'x' }),
      // The router decodes `%61` to `a`, so this would be the queue; the door serves only a raw path that starts with /api/, so it is a 404.
      await h.request(AGENT, 'GET', '/%61pi/queue'),
      await h.request(null, 'GET', '/'),
      await h.push({ method: 'GET', path: '/' }),
    ]
    expect(api.map((r) => r.status)).toEqual([200, 401, 403, 404, 201, 404, 401, 404])
    for (const res of api) expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('drafting', () => {
  test('Claude drafts to an address, and the address becomes a contact', async () => {
    const h = harness()
    const res = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'Dana@Example.com',
      name: 'Dana Reyes',
      subject: 'Your card',
      body: 'Hi Dana,\n\nCould you update your card?',
      why: 'Her payment failed.',
    })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({
      status: 'draft',
      address: 'dana@example.com',
      kind: 'email',
      contactName: 'Dana Reyes',
      why: 'Her payment failed.',
      createdBy: `agent:${AGENT_ID}`,
      conversationId: null,
    })

    const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ name: 'Dana Reyes', drafts: 1, conversations: 0 })
  })

  test('a second draft to the same address, spelled differently, is the same contact', async () => {
    const h = harness()
    await ownerDraft(h, { address: 'dana@example.com', name: 'Dana', body: 'one' })
    await ownerDraft(h, { address: ' DANA@example.com ', name: 'Someone Else', body: 'two' })
    const contacts = (await h.request(AGENT, 'GET', '/api/contacts')).json
    expect(contacts).toHaveLength(1)
    expect(contacts[0].name).toBe('Dana')
    expect(contacts[0].drafts).toBe(2)
  })

  test('a draft from Claude needs a why and may not contain an em dash; Tessa’s own may', async () => {
    const h = harness()
    const noWhy = await h.request(AGENT, 'POST', '/api/drafts', { address: 'a@example.com', body: 'Hi' })
    expect(noWhy.status).toBe(422)
    expect(noWhy.json.error).toContain('why')

    const dash = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'a@example.com',
      body: 'Hi \u2014 there',
      why: 'x',
    })
    expect(dash.status).toBe(422)
    expect(dash.json.error).toContain('em dash')
    const dashInSubject = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'a@example.com',
      subject: 'Re \u2014 you',
      body: 'Hi',
      why: 'x',
    })
    expect(dashInSubject.status).toBe(422)

    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toEqual([])
    const own = await ownerDraft(h, { address: 'a@example.com', body: 'Hi \u2014 there' })
    expect(own.status).toBe(201)
  })

  test('an empty body, no recipient, or an unreadable body is refused with the right status', async () => {
    const h = harness()
    expect((await ownerDraft(h, { address: 'a@example.com', body: '  ' })).status).toBe(422)
    expect((await ownerDraft(h, { body: 'Hi' })).status).toBe(422)
    expect((await h.request(AGENT, 'POST', '/api/drafts', ['nope'])).status).toBe(400)
    expect((await ownerDraft(h, { address: '   ', body: 'Hi' })).status).toBe(422)
  })

  test('a draft to a contact goes to their address, and an address that is not theirs is refused', async () => {
    const h = harness()
    const first = (await ownerDraft(h, { address: 'dana@example.com', name: 'Dana', body: 'one' })).json
    const byContact = await ownerDraft(h, { contactId: first.contactId, body: 'two' })
    expect(byContact.status).toBe(201)
    expect(byContact.json.address).toBe('dana@example.com')

    const wrong = await ownerDraft(h, {
      contactId: first.contactId,
      address: 'not-hers@example.com',
      body: 'three',
    })
    expect(wrong.status).toBe(422)
    expect((await ownerDraft(h, { contactId: 'missing', body: 'x' })).status).toBe(404)
    expect((await ownerDraft(h, { conversationId: 'missing', body: 'x' })).status).toBe(404)
  })

  test('editing a draft keeps its history, and an agent’s edit is held to the same rules', async () => {
    const h = harness()
    const draft = (
      await h.request(AGENT, 'POST', '/api/drafts', { address: 'a@example.com', body: 'First', why: 'why' })
    ).json
    h.tick()
    const edited = await ownerPatch(h, draft.id, {
      rev: draft.rev,
      body: 'Second',
      subject: 'Hello',
    })
    expect(edited.status).toBe(200)
    expect(edited.json).toMatchObject({ body: 'Second', subject: 'Hello', why: 'why', createdBy: `agent:${AGENT_ID}` })

    const now = edited.json.rev
    const dash = await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: now, body: 'a \u2014 b' })
    expect(dash.status).toBe(422)
    expect((await ownerPatch(h, draft.id, { rev: now, body: ' ' })).status).toBe(422)
    // Nor may Claude blank the why that tells Tessa what the draft is for; Tessa may.
    const blanked = await h.request(AGENT, 'PATCH', `/api/drafts/${draft.id}`, { rev: now, why: '  ' })
    expect(blanked.status).toBe(422)
    expect(blanked.json.error).toContain('why')
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json[0].why).toBe('why')
    expect((await ownerPatch(h, draft.id, { rev: now, why: '' })).status).toBe(200)
    expect((await ownerPatch(h, 'nope', { rev: 0, body: 'x' })).status).toBe(404)

    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { action: string; actor: string }[]
    expect(audit.map((a) => [a.action, a.actor])).toEqual([
      ['draft.update', 'tessa@northfield.example'],
      ['draft.update', 'tessa@northfield.example'],
      ['draft.create', `agent:${AGENT_ID}`],
      ['contact.create', `agent:${AGENT_ID}`],
    ])
  })

  test('a draft can be deleted, and only a draft', async () => {
    const h = harness()
    const draft = (await ownerDraft(h, { address: 'a@example.com', body: 'Hi' })).json
    expect((await ownerDelete(h, draft.id, draft.rev)).status).toBe(200)
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toEqual([])
    expect((await ownerDelete(h, draft.id, draft.rev)).status).toBe(404)

    const sent = (await ownerDraft(h, { address: '626-555-0100', body: 'Hi' })).json
    await ownerMarkSent(h, sent.id)
    expect((await ownerDelete(h, sent.id, sent.rev)).status).toBe(409)
  })
})

describe('marking sent, and the queue', () => {
  test('marking a draft sent files it on the contact’s conversation, which the queue then shows', async () => {
    const h = harness()
    const draft = (
      await ownerDraft(h, {
        address: '626-555-0101',
        name: 'Dana',
        subject: 'Hello',
        body: 'Hi Dana',
      })
    ).json

    const before = (await h.request(AGENT, 'GET', '/api/queue')).json
    expect(before.rows).toEqual([])
    expect(before.filters).toEqual([
      { id: 'inbox', label: 'Inbox', count: 0, unread: 0 },
      { id: 'unread', label: 'Unread', count: 0, unread: 0 },
      // The draft on no conversation yet is waiting for Tessa, so Drafts counts it.
      { id: 'drafts', label: 'Drafts', count: 1, unread: 0 },
      { id: 'bulk', label: 'Bulk', count: 0, unread: 0 },
      { id: 'closed', label: 'Closed', count: 0, unread: 0 },
    ])
    expect(before.looseDrafts.map((d: { id: string }) => d.id)).toEqual([draft.id])

    h.tick()
    const marked = await ownerMarkSent(h, draft.id, {
      sentAt: '2026-10-20T11:00:00Z',
    })
    expect(marked.status).toBe(200)
    expect(marked.json).toMatchObject({
      status: 'manual-sent',
      sentAt: '2026-10-20T11:00:00.000Z',
      sentBy: 'tessa@northfield.example',
    })
    expect(marked.json.conversationId).not.toBeNull()

    // Something Tessa sent by hand has nothing owed on it, so it is filed closed
    // (and read): it shows under Closed, not in the Inbox.
    expect((await h.request(AGENT, 'GET', '/api/queue')).json.rows).toEqual([])
    const queue = (await h.request(AGENT, 'GET', '/api/queue?filter=closed')).json
    expect(queue.rows).toHaveLength(1)
    expect(queue.rows[0]).toMatchObject({
      title: 'Dana',
      kind: 'sms',
      subject: 'Hello',
      snippet: 'Hi Dana',
      lastActivityAt: '2026-10-20T11:00:00.000Z',
      drafts: 0,
      unread: false,
      open: false,
      readBy: 'tessa@northfield.example',
      closedBy: 'tessa@northfield.example',
    })

    const convo = (await h.request(AGENT, 'GET', `/api/conversations/${marked.json.conversationId}`)).json
    expect(convo.messages).toHaveLength(1)
    expect(convo.addresses).toEqual([expect.objectContaining({ kind: 'sms', address: '+16265550101' })])
  })

  test('a second message to the same contact on the same channel joins the same conversation', async () => {
    const h = harness()
    const a = (await ownerDraft(h, { address: '626-555-0101', name: 'Dana', body: 'one' })).json
    const b = (await ownerDraft(h, { address: '626-555-0101', body: 'two' })).json
    const first = (await ownerMarkSent(h, a.id)).json
    h.tick()
    const second = (await ownerMarkSent(h, b.id)).json
    expect(second.conversationId).toBe(first.conversationId)
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=closed')).json.rows).toHaveLength(1)
  })

  test('a text and a direct message to different people are two conversations of different kinds', async () => {
    const h = harness()
    const dm = (await ownerDraft(h, { address: '@dana_r', name: 'Dana', body: 'one' })).json
    await ownerMarkSent(h, dm.id)
    h.tick()
    const text = (await ownerDraft(h, { address: '626-555-0142', name: 'Marcus', body: 'hi' })).json
    expect(text.kind).toBe('sms')
    expect(text.address).toBe('+16265550142')
    await ownerMarkSent(h, text.id)
    const queue = (await h.request(AGENT, 'GET', '/api/queue?filter=closed')).json
    expect(queue.rows.map((r: { title: string; kind: string }) => [r.title, r.kind])).toEqual([
      ['Marcus', 'sms'],
      ['Dana', 'manual'],
    ])
  })

  test('a draft waiting on a conversation shows in the Drafts view, and one on no conversation is listed above it and counted', async () => {
    const h = harness()
    const a = (await ownerDraft(h, { address: '626-555-0101', name: 'Dana', body: 'one' })).json
    const sent = (await ownerMarkSent(h, a.id)).json
    await ownerDraft(h, { address: 'marcus@example.com', name: 'Marcus', body: 'one' })
    const m = (await h.request(AGENT, 'GET', '/api/contacts')).json.find((c: { name: string }) => c.name === 'Marcus')
    h.tick()
    const onConvo = await ownerDraft(h, {
      conversationId: sent.conversationId,
      body: 'follow up',
    })
    expect(onConvo.status).toBe(201)
    expect(onConvo.json.conversationId).toBe(sent.conversationId)

    const all = (await h.request(AGENT, 'GET', '/api/queue')).json
    // Dana's conversation holds one draft, and Marcus's email draft sits on no conversation: two waiting.
    expect(all.filters).toEqual([
      { id: 'inbox', label: 'Inbox', count: 0, unread: 0 },
      { id: 'unread', label: 'Unread', count: 0, unread: 0 },
      { id: 'drafts', label: 'Drafts', count: 2, unread: 0 },
      { id: 'bulk', label: 'Bulk', count: 0, unread: 0 },
      { id: 'closed', label: 'Closed', count: 1, unread: 0 },
    ])
    const drafts = (await h.request(AGENT, 'GET', '/api/queue?filter=drafts')).json
    expect(drafts.filter).toBe('drafts')
    expect(drafts.rows.map((r: { title: string; drafts: number }) => [r.title, r.drafts])).toEqual([['Dana', 1]])
    expect(drafts.looseDrafts.map((d: { contactName: string }) => d.contactName)).toEqual(['Marcus'])
    expect(drafts.filters.find((f: { id: string }) => f.id === 'drafts').count).toBe(
      drafts.rows.length + drafts.looseDrafts.length,
    )
    // The draft on Dana's conversation is a row fact, with who wrote it and how it starts.
    expect(drafts.rows[0].draft).toEqual({ author: 'owner', editedBy: null, excerpt: 'follow up', stuck: false })
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=bogus')).json.filter).toBe('inbox')
    // The Inbox's old id is not an alias for it.
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=all')).json.filter).toBe('inbox')
    expect(m.drafts).toBe(1)
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toHaveLength(2)
  })

  test('marking sent twice is refused, and unmarking puts the draft back', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: '626-555-0101', body: 'one' })).json
    expect((await ownerMarkSent(h, d.id)).status).toBe(200)
    expect((await ownerMarkSent(h, d.id)).status).toBe(409)

    const back = await ownerUnmarkSent(h, d.id)
    expect(back.status).toBe(200)
    expect(back.json).toMatchObject({ status: 'draft', sentAt: null, sentBy: null })
    expect((await ownerUnmarkSent(h, d.id)).status).toBe(409)
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toHaveLength(1)
  })

  test('a sentAt that is not a full ISO timestamp is 422 and changes nothing', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: '626-555-0101', body: 'one' })).json
    for (const sentAt of ['tomorrow-ish', '1', '2026-10-20', '2026-10-20T11:00:00']) {
      expect((await ownerMarkSent(h, d.id, { sentAt })).status, sentAt).toBe(422)
    }
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toHaveLength(1)
  })

  test('Claude may mark a draft sent, and the message says it was Claude', async () => {
    const h = harness()
    const d = (await h.request(AGENT, 'POST', '/api/drafts', { address: '626-555-0101', body: 'one', why: 'w' })).json
    const marked = await h.request(AGENT, 'POST', `/api/messages/${d.id}/mark-sent`)
    expect(marked.json.sentBy).toBe(`agent:${AGENT_ID}`)
  })
})

describe('contacts', () => {
  test('the card shows addresses, conversations newest first and drafts', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: '626-555-0101', name: 'Dana', body: 'one' })).json
    await ownerMarkSent(h, d.id)
    h.tick()
    await ownerDraft(h, { contactId: d.contactId, body: 'two' })

    const card = (await h.request(AGENT, 'GET', `/api/contacts/${d.contactId}`)).json
    expect(card.name).toBe('Dana')
    expect(card.identities).toEqual([expect.objectContaining({ kind: 'sms', address: '+16265550101' })])
    expect(card.conversations).toHaveLength(1)
    expect(card.drafts).toHaveLength(1)
    expect((await h.request(AGENT, 'GET', '/api/contacts/missing')).status).toBe(404)
  })

  test('a contact can be renamed, by Tessa or Claude, and the audit says who', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: 'dana@example.com', body: 'one' })).json
    const renamed = await h.request(AGENT, 'PATCH', `/api/contacts/${d.contactId}`, { name: '  Dana Reyes ' })
    expect(renamed.json.name).toBe('Dana Reyes')
    expect((await ownerRename(h, d.contactId, { name: ' ' })).status).toBe(422)
    expect((await ownerRename(h, 'missing', { name: 'x' })).status).toBe(404)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as {
      action: string
      actor: string
      before: unknown
      after: unknown
    }[]
    expect(audit[0]).toMatchObject({
      action: 'contact.rename',
      actor: `agent:${AGENT_ID}`,
      before: { name: 'dana@example.com' },
      after: { name: 'Dana Reyes' },
    })
  })
})

describe('reading never writes', () => {
  // Claude's reads through the script never mark anything read. Step 1
  // has no read state at all; this pins the property it will be built on, that no
  // GET changes the store, by the engine's own count of changed rows.
  test('every read the agent can make leaves the store exactly as it was', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: '626-555-0101', name: 'Dana', body: 'one' })).json
    const sent = (await ownerMarkSent(h, d.id)).json
    await ownerDraft(h, { conversationId: sent.conversationId, body: 'two' })

    const changes = () => (h.db.query('SELECT total_changes() AS n').get() as { n: number }).n
    const before = changes()
    for (const path of [
      '/api/queue',
      '/api/queue?filter=drafts',
      `/api/conversations/${sent.conversationId}`,
      '/api/contacts',
      `/api/contacts/${d.contactId}`,
      '/api/drafts',
      '/api/audit',
    ]) {
      expect((await h.request(AGENT, 'GET', path)).status, path).toBe(200)
    }
    expect(changes()).toBe(before)
  })
})

describe('the Outbox carry through the API', () => {
  test('a posted list is carried and reported', async () => {
    const h = harness()
    const entries = [
      {
        id: 'a-1',
        to: 'Dana',
        address: 'dana@example.com',
        body: 'one',
        created: '2026-10-19T10:00:00Z',
        sentAt: null,
      },
      {
        id: 'a-2',
        to: 'Dana',
        address: 'dana@example.com',
        body: 'two',
        created: '2026-10-18T10:00:00Z',
        sentAt: '2026-10-18T11:00:00Z',
      },
    ]
    const res = await h.request(AGENT, 'POST', '/api/import/outbox', { entries })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      received: { total: 2, unsent: 1, sent: 1 },
      created: { drafts: 1, manualSent: 1 },
      problems: [],
    })
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=closed')).json.rows).toHaveLength(1)
    expect((await h.request(AGENT, 'POST', '/api/import/outbox', { entries: 'nope' })).status).toBe(422)
  })

  test('entries that are not objects are reported, not a 500', async () => {
    const h = harness()
    const res = await h.request(AGENT, 'POST', '/api/import/outbox', {
      entries: [null, 'x', { id: 'a-1', to: 'Dana', address: 'dana@example.com', body: 'one' }],
    })
    expect(res.status).toBe(200)
    expect(res.json.created.drafts).toBe(1)
    expect(res.json.problems.map((p: { id: string }) => p.id)).toEqual(['(entry 0)', '(entry 1)'])
  })

  test('a deleted carried draft is not brought back by a second post of the list', async () => {
    const h = harness()
    const entries = [{ id: 'a-1', to: 'Dana', address: 'dana@example.com', body: 'one' }]
    await h.request(AGENT, 'POST', '/api/import/outbox', { entries })
    const [draft] = (await h.request(AGENT, 'GET', '/api/drafts')).json
    expect((await ownerDelete(h, draft.id, draft.rev)).status).toBe(200)
    const again = await h.request(AGENT, 'POST', '/api/import/outbox', { entries })
    expect(again.json).toMatchObject({ created: { drafts: 0 }, skipped: 1 })
    expect((await h.request(AGENT, 'GET', '/api/drafts')).json).toEqual([])
  })

  test('a refused request writes nothing', async () => {
    const h = harness()
    await h.request(STRANGER, 'POST', '/api/import/outbox', {
      entries: [{ id: 'x', to: 'a', address: 'a@b.test', body: 'x' }],
    })
    await h.request(null, 'POST', '/api/drafts', { address: 'a@b.test', body: 'x' })
    expect(count(h, 'message')).toBe(0)
    expect(count(h, 'contact')).toBe(0)
    expect(h.inbox.listAudit()).toEqual([])
  })
})

describe('the clock is the store’s, not the request’s', () => {
  test('timestamps come from the injected clock', async () => {
    const h = harness()
    const d = (await ownerDraft(h, { address: 'dana@example.com', body: 'one' })).json
    expect(Date.parse(d.createdAt)).toBe(T0)
  })
})
