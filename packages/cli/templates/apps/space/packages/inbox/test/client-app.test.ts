import { describe, expect, test } from 'bun:test'
import { ACME } from '../test-support/clients-part'
import { AGENT, AGENT_ID, asker, harness, OWNER, ownerDraft, STRANGER } from '../test-support/harness'

/**
 * Step 5 through the inbox's Worker as a function: the Client directory (in memory,
 * and able to fail), assignment, suggestions, the Client filters, Bulk's exemption,
 * the Clients' pages, merge and split. The seam is the highest one, with a
 * Gmail that really ingests (so contacts and conversations are made the way mail makes
 * them) and a directory standing in for the site's service binding.
 *
 * What this cannot show is the binding itself, or the site's entrypoint behind it:
 * those are the hand test after the site is deployed.
 */

type H = ReturnType<typeof harness>

async function live(h: H, setup: () => void) {
  setup()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

/** A person writes to Tessa. */
function from(h: H, address: string, name: string, over: Record<string, unknown> = {}) {
  return h.google.mailbox.add({
    from: `${name} <${address}>`,
    subject: `Hello from ${name}`,
    threadId: `t-${address}`,
    ...over,
  })
}

const contactIdOf = (h: H, address: string): string =>
  (h.db.query(`SELECT contact_id AS id FROM identity WHERE address = ?`).get(address) as { id: string }).id

const getCard = async (h: H, address: string, who = AGENT) =>
  (await h.request(who, 'GET', `/api/contacts/${contactIdOf(h, address)}`)).json

const assign = (h: H, address: string, body: unknown, who: Record<string, unknown> | null = AGENT) =>
  h.request(who, 'PUT', `/api/contacts/${contactIdOf(h, address)}/client`, body)

const audited = (h: H, action: string) => h.inbox.listAudit().filter((a) => a.action === action)

describe('assigning a contact to a Client', () => {
  test('the owner assigns a listed Client (through the space, his only way in): the contact shows it by name, stamped with who set it', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))

    const linked = await h.space().linkClient(asker(OWNER), contactIdOf(h, 'dana@acme.example'), 1)
    expect(linked.ok, JSON.stringify(linked)).toBe(true)

    const card = await getCard(h, 'dana@acme.example')
    expect(card).toMatchObject({ clientId: 1, client: { name: 'Acme Legal' }, directory: { available: true } })
    expect(audited(h, 'contact.assign-client')[0]).toMatchObject({
      actor: 'tessa@northfield.example',
      after: { clientId: 1 },
    })

    expect(card.clientSetBy).toBe('tessa@northfield.example')
    const list = (await h.request(AGENT, 'GET', '/api/contacts')).json as {
      name: string
      client: { name: string } | null
    }[]
    expect(list.find((c) => c.name === 'Dana')?.client?.name).toBe('Acme Legal')
  })

  test('Claude assigns too, and the audit says it was Claude', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    expect((await assign(h, 'dana@acme.example', { clientId: 2 }, AGENT)).status).toBe(200)
    expect(audited(h, 'contact.assign-client')[0]?.actor).toBe(`agent:${AGENT_ID}`)
  })

  test('a Client the site does not list is 422, nothing is written and nothing is audited', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    const res = await assign(h, 'dana@acme.example', { clientId: 99 })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('no Client 99')
    expect((await getCard(h, 'dana@acme.example')).clientId).toBeNull()
    expect(audited(h, 'contact.assign-client')).toHaveLength(0)
  })

  test('a body that does not name a Client by its number is 422: a string, zero, a fraction, nothing at all', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    for (const body of [
      { clientId: '1' },
      { clientId: 0 },
      { clientId: 1.5 },
      { clientId: -2 },
      {},
      { client: 1 },
      { clientId: [1] },
    ]) {
      expect((await assign(h, 'dana@acme.example', body)).status, JSON.stringify(body)).toBe(422)
    }
    expect((await assign(h, 'dana@acme.example', 'one')).status).toBe(400)
    expect((await getCard(h, 'dana@acme.example')).clientId).toBeNull()
  })

  test('with the Clients part not answering, assignment is refused (503) and says why, while mail, the queue and contacts carry on', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    h.directory.failure = new Error('service unavailable')

    const res = await assign(h, 'dana@acme.example', { clientId: 1 })
    expect(res.status).toBe(503)
    expect(res.json.error).toContain('Nothing was assigned')
    expect((await getCard(h, 'dana@acme.example')).clientId).toBeNull()

    expect((await h.request(AGENT, 'GET', '/api/queue')).status).toBe(200)
    expect((await h.request(AGENT, 'GET', '/api/contacts')).status).toBe(200)
    const draft = await ownerDraft(h, {
      address: 'dana@acme.example',
      body: 'Hi',
      subject: 's',
    })
    expect(draft.status).toBe(201)
    // New mail still arrives while the Clients part is down.
    h.google.mailbox.add({ from: 'Pat <pat@elsewhere.example>', threadId: 't-new' })
    await h.mailroom.requestSync()
    await h.drain()
    expect((await h.request(AGENT, 'GET', '/api/queue')).json.rows).toHaveLength(2)
  })

  test('with no Clients part at all (a Worker whose store is not bound) it is the same outage', async () => {
    const h = harness({ clients: () => undefined })
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    expect((await assign(h, 'dana@acme.example', { clientId: 1 })).status).toBe(503)
    expect((await h.request(AGENT, 'GET', '/api/queue')).json.directory.available).toBe(false)
  })

  test('taking a contact out of a Client needs no answer from the part', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    await assign(h, 'dana@acme.example', { clientId: 1 })
    h.directory.failure = new Error('down')
    const res = await assign(h, 'dana@acme.example', { clientId: null })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ clientId: null, client: null })
    expect(audited(h, 'contact.clear-client')).toHaveLength(1)
  })

  test('an unknown contact is 404; a stranger is 403; a write from another site is refused', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    expect((await h.request(AGENT, 'PUT', '/api/contacts/nobody/client', { clientId: 1 })).status).toBe(404)
    expect((await assign(h, 'dana@acme.example', { clientId: 1 }, STRANGER)).status).toBe(403)
    expect((await assign(h, 'dana@acme.example', { clientId: 1 }, null)).status).toBe(401)
    const cross = await h.request(
      AGENT,
      'PUT',
      `/api/contacts/${contactIdOf(h, 'dana@acme.example')}/client`,
      { clientId: 1 },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(cross.status).toBe(403)
    expect((await getCard(h, 'dana@acme.example')).clientId).toBeNull()
  })

  test('the part is asked afresh each time: a Client made in Settings can be assigned at once', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    expect((await assign(h, 'dana@acme.example', { clientId: 1001 })).status).toBe(422)
    expect(h.directory.make('Cobalt Co')).toBe(1001)
    const before = h.directory.asked
    expect((await assign(h, 'dana@acme.example', { clientId: 1001 })).json.client.name).toBe('Cobalt Co')
    expect(h.directory.asked).toBe(before + 1)
  })

  test('linking never waits on a Client\x27s source: one the source no longer lists is still linkable, and an archived one is refused with a sentence', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    h.directory.send([ACME])
    expect((await assign(h, 'dana@acme.example', { clientId: 2 })).status).toBe(200)
    h.directory.archive(1)
    const refused = await assign(h, 'dana@acme.example', { clientId: 1 })
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('archived')
    expect((await getCard(h, 'dana@acme.example')).clientId).toBe(2)
  })
})

describe('suggestions are shown, and take effect only when accepted', () => {
  test('a sign-in address match is suggested on the card and in the list, and nothing is assigned by showing it', async () => {
    const h = harness()
    await live(h, () => from(h, 'owner@acme.example', 'Olive Owner'))

    const card = await getCard(h, 'owner@acme.example')
    expect(card.suggestions).toEqual([
      expect.objectContaining({
        clientId: 1,
        clientName: 'Acme Legal',
        reason: 'address',
        via: 'owner@acme.example',
      }),
    ])
    const all = (await h.request(AGENT, 'GET', '/api/suggestions')).json
    expect(all.suggestions).toHaveLength(1)
    expect(all.directory.available).toBe(true)
    const one = (await h.request(AGENT, 'GET', `/api/suggestions?contact=${contactIdOf(h, 'owner@acme.example')}`)).json
    expect(one.suggestions).toHaveLength(1)
    expect((await h.request(AGENT, 'GET', '/api/suggestions?contact=nobody')).json.suggestions).toEqual([])

    // Having read the card, the queue, the list and the suggestions, the contact is still nobody's.
    await h.request(AGENT, 'GET', '/api/queue')
    await h.request(AGENT, 'GET', '/api/clients/1')
    expect((await getCard(h, 'owner@acme.example')).clientId).toBeNull()
    expect(audited(h, 'contact.assign-client')).toHaveLength(0)
    expect(h.db.query(`SELECT count(*) AS n FROM contact WHERE client_id IS NOT NULL`).get()).toEqual({ n: 0 })
  })

  test('accepting is an assignment like any other: audited with its actor, and the suggestion is gone', async () => {
    const h = harness()
    await live(h, () => from(h, 'owner@acme.example', 'Olive Owner'))
    const suggested = (await getCard(h, 'owner@acme.example')).suggestions[0]
    const done = await assign(h, 'owner@acme.example', { clientId: suggested.clientId }, AGENT)
    expect(done.status).toBe(200)
    expect(audited(h, 'contact.assign-client')[0]).toMatchObject({ actor: `agent:${AGENT_ID}`, after: { clientId: 1 } })
    expect((await getCard(h, 'owner@acme.example')).suggestions).toEqual([])
  })

  test("a domain the Client's assigned contacts already write from is suggested for a newcomer on it", async () => {
    const h = harness()
    await live(h, () => {
      from(h, 'dana@acme-legal.example', 'Dana')
      from(h, 'pat@acme-legal.example', 'Pat')
    })
    expect((await getCard(h, 'pat@acme-legal.example')).suggestions).toEqual([])
    await assign(h, 'dana@acme-legal.example', { clientId: 1 })
    expect((await getCard(h, 'pat@acme-legal.example')).suggestions).toEqual([
      expect.objectContaining({ clientId: 1, reason: 'domain', via: 'acme-legal.example' }),
    ])
  })

  test('with the directory down there are no suggestions, and the card says the list is unavailable', async () => {
    const h = harness()
    await live(h, () => from(h, 'owner@acme.example', 'Olive Owner'))
    h.directory.failure = new Error('down')
    const card = await getCard(h, 'owner@acme.example')
    expect(card.suggestions).toEqual([])
    expect(card.directory.available).toBe(false)
    expect(card.directory.error).toContain('did not answer')
  })
})

describe("the queue by Client, and Bulk's exemption", () => {
  test("a Client's newsletter-looking mail is under Bulk until its sender is assigned, then it is in the Inbox and under the Client", async () => {
    const h = harness()
    await live(h, () => {
      from(h, 'billing@acme.example', 'Acme Billing', {
        subject: 'Your invoice',
        headers: { 'List-Unsubscribe': '<mailto:unsub@acme.example>' },
      })
      from(h, 'deals@shop.example', 'Shop', {
        subject: 'Big sale',
        headers: { 'List-Unsubscribe': '<mailto:unsub@shop.example>' },
      })
      from(h, 'dana@elsewhere.example', 'Dana', { subject: 'A person' })
    })
    const queue = async (filter?: string) =>
      (await h.request(AGENT, 'GET', `/api/queue${filter ? `?filter=${filter}` : ''}`)).json
    const subjects = (q: { rows: { subject: string }[] }) => q.rows.map((r) => r.subject).sort()

    expect(subjects(await queue('inbox'))).toEqual(['A person'])
    expect(subjects(await queue('bulk'))).toEqual(['Big sale', 'Your invoice'])
    expect((await queue()).filters.map((f: { id: string }) => f.id)).toEqual([
      'inbox',
      'unread',
      'drafts',
      'bulk',
      'closed',
    ])

    await assign(h, 'billing@acme.example', { clientId: 1 })

    expect(subjects(await queue('inbox'))).toEqual(['A person', 'Your invoice'])
    expect(subjects(await queue('bulk'))).toEqual(['Big sale'])
    const filtered = await queue('client:1')
    expect(subjects(filtered)).toEqual(['Your invoice'])
    expect(filtered.rows[0]).toMatchObject({ bulk: false, clients: [{ id: 1, name: 'Acme Legal', listed: true }] })
    expect(filtered.filters.find((f: { id: string }) => f.id === 'client:1')).toMatchObject({
      label: 'Acme Legal',
      count: 1,
      unread: 1,
    })
    expect(filtered.filters.find((f: { id: string }) => f.id === 'bulk')).toMatchObject({ count: 1 })
    expect(filtered.directory).toEqual({ available: true, error: null })

    // Taking the contact out of the Client puts the mail back under Bulk.
    await assign(h, 'billing@acme.example', { clientId: null })
    expect(subjects(await queue('bulk'))).toEqual(['Big sale', 'Your invoice'])
  })

  test('the conversation answer says whether it is Bulk, by the queue’s rule, and follows an assignment', async () => {
    const h = harness()
    await live(h, () => {
      from(h, 'billing@acme.example', 'Acme Billing', {
        subject: 'Your invoice',
        headers: { 'List-Unsubscribe': '<mailto:unsub@acme.example>' },
      })
      from(h, 'dana@elsewhere.example', 'Dana', { subject: 'A person' })
    })
    const conversation = async (address: string) => {
      const id = (
        h.db
          .query(
            `SELECT participant.conversation_id AS id FROM participant JOIN identity ON identity.id = participant.identity_id WHERE identity.address = ?`,
          )
          .get(address) as { id: string }
      ).id
      return (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
    }
    const bulkRows = (await h.request(AGENT, 'GET', '/api/queue?filter=bulk')).json.rows
    expect(bulkRows.map((r: { subject: string }) => r.subject)).toEqual(['Your invoice'])

    expect((await conversation('billing@acme.example')).bulk).toBe(true)
    expect((await conversation('dana@elsewhere.example')).bulk).toBe(false)

    // A Client's people are never Bulk, and the answer agrees with the queue the moment they are assigned.
    await assign(h, 'billing@acme.example', { clientId: 1 })
    expect((await conversation('billing@acme.example')).bulk).toBe(false)
    await assign(h, 'billing@acme.example', { clientId: null })
    expect((await conversation('billing@acme.example')).bulk).toBe(true)
  })

  test('the exemption and the Client filter do not depend on the directory answering: Clients show by number', async () => {
    const h = harness()
    await live(h, () =>
      from(h, 'billing@acme.example', 'Acme Billing', {
        subject: 'Your invoice',
        headers: { 'List-Unsubscribe': '<mailto:unsub@acme.example>' },
      }),
    )
    await assign(h, 'billing@acme.example', { clientId: 1 })
    h.directory.failure = new Error('down')
    const q = (await h.request(AGENT, 'GET', '/api/queue?filter=client:1')).json
    expect(q.directory.available).toBe(false)
    expect(q.rows.map((r: { subject: string }) => r.subject)).toEqual(['Your invoice'])
    expect(q.rows[0].clients).toEqual([{ id: 1, name: 'Client 1', listed: false }])
    expect(q.filters.find((f: { id: string }) => f.id === 'client:1').label).toBe('Client 1')
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=inbox')).json.rows).toHaveLength(1)
  })

  test('a Client with nothing open has no filter, and asking for its filter shows it empty', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    expect((await h.request(AGENT, 'GET', '/api/queue')).json.filters.map((f: { id: string }) => f.id)).not.toContain(
      'client:2',
    )
    const asked = (await h.request(AGENT, 'GET', '/api/queue?filter=client:2')).json
    expect(asked.filter).toBe('client:2')
    expect(asked.rows).toEqual([])
    expect((await h.request(AGENT, 'GET', '/api/queue?filter=client:abc')).json.filter).toBe('inbox')
  })

  test('a conversation names the Clients of its contacts', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    await assign(h, 'dana@acme.example', { clientId: 1 })
    const id = (await h.request(AGENT, 'GET', '/api/queue')).json.rows[0].id
    const detail = (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
    expect(detail.contacts).toEqual([expect.objectContaining({ name: 'Dana', clientId: 1 })])
    expect(detail.clients).toEqual([{ id: 1, name: 'Acme Legal', listed: true }])
  })

  test('a conversation of strangers does not ask the directory at all', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    const id = (await h.request(AGENT, 'GET', '/api/queue')).json.rows[0].id
    const before = h.directory.asked
    expect((await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json.clients).toEqual([])
    expect(h.directory.asked).toBe(before)
  })
})

describe("the Clients' pages", () => {
  test("the list is the site's Clients with their contacts and conversations counted, an unassigned Client included", async () => {
    const h = harness()
    await live(h, () => {
      from(h, 'dana@acme.example', 'Dana')
      from(h, 'pat@elsewhere.example', 'Pat')
    })
    await assign(h, 'dana@acme.example', { clientId: 1 })
    const list = (await h.request(AGENT, 'GET', '/api/clients')).json
    expect(list.directory).toEqual({ available: true, error: null })
    expect(list.clients).toEqual([
      expect.objectContaining({
        id: 1,
        name: 'Acme Legal',
        contacts: 1,
        conversations: 1,
        open: 1,
        adminUrl: 'https://www.northfield.example/admin#client-1',
      }),
      expect.objectContaining({ id: 2, name: 'Bolt Machines', contacts: 0, conversations: 0, open: 0 }),
    ])
  })

  test('with the directory down the list still shows the Clients contacts are under, by number', async () => {
    const h = harness()
    await live(h, () => from(h, 'dana@acme.example', 'Dana'))
    await assign(h, 'dana@acme.example', { clientId: 1 })
    h.directory.failure = new Error('down')
    const list = (await h.request(AGENT, 'GET', '/api/clients')).json
    expect(list.directory.available).toBe(false)
    expect(list.clients).toEqual([expect.objectContaining({ id: 1, name: 'Client 1', listed: false, contacts: 1 })])
  })

  test("a Client's page: its contacts, every conversation with any of them (closed too), what Stripe last said, a link to the admin", async () => {
    const h = harness()
    await live(h, () => {
      from(h, 'dana@acme.example', 'Dana', { subject: 'Open one' })
      from(h, 'dana@acme.example', 'Dana', { subject: 'Archived one', threadId: 't-old', labels: ['SENT'] })
      from(h, 'pat@elsewhere.example', 'Pat', { subject: 'Not theirs' })
    })
    await assign(h, 'dana@acme.example', { clientId: 1 })
    const page = (await h.request(AGENT, 'GET', '/api/clients/1')).json
    expect(page.client).toMatchObject({
      id: 1,
      name: 'Acme Legal',
      legalEntity: 'Acme Legal LLP',
      extra: {
        signInAddress: 'owner@acme.example',
        subscriptionStatus: 'active',
        subscriptionAt: '2026-10-01T00:00:00.000Z',
      },
      adminUrl: 'https://www.northfield.example/admin#client-1',
    })
    expect(page.contacts.map((p: { name: string }) => p.name)).toEqual(['Dana'])
    expect(page.conversations.map((c: { subject: string }) => c.subject).sort()).toEqual(['Archived one', 'Open one'])
    expect(page.conversations.find((c: { subject: string }) => c.subject === 'Archived one').open).toBe(false)
  })

  test('a Client the site does not list and nobody is under is 404; so is an id that is not a number', async () => {
    const h = harness()
    expect((await h.request(AGENT, 'GET', '/api/clients/99')).status).toBe(404)
    expect((await h.request(AGENT, 'GET', '/api/clients/abc')).status).toBe(404)
    expect((await h.request(AGENT, 'GET', '/api/clients/0')).status).toBe(404)
    expect((await h.request(AGENT, 'GET', '/api/clients/2')).status).toBe(200)
  })

  test('reading Clients writes nothing and offers no write: there is no route to create or change a Client', async () => {
    const h = harness()
    for (const [method, path] of [
      ['POST', '/api/clients'],
      ['PUT', '/api/clients/1'],
      ['PATCH', '/api/clients/1'],
      ['DELETE', '/api/clients/1'],
      ['POST', '/api/clients/1'],
    ] as const) {
      expect((await h.request(AGENT, method, path, {})).status, `${method} ${path}`).toBe(404)
    }
    expect(h.inbox.listAudit()).toEqual([])
  })
})

describe('merge and split through the Worker', () => {
  async function twoAddressesOfDana() {
    const h = harness()
    await live(h, () => {
      from(h, 'dana@example.com', 'Dana Smith')
      from(h, 'dana@work.example', 'D. Smith')
    })
    return { h, a: contactIdOf(h, 'dana@example.com'), b: contactIdOf(h, 'dana@work.example') }
  }

  test('the agent merges two contacts and the audit says so; the survivor has both addresses', async () => {
    const { h, a, b } = await twoAddressesOfDana()
    const res = await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: b })
    expect(res.status).toBe(200)
    expect(res.json.identities.map((i: { address: string }) => i.address).sort()).toEqual([
      'dana@example.com',
      'dana@work.example',
    ])
    expect(audited(h, 'contact.merge')[0]?.actor).toBe(`agent:${AGENT_ID}`)
    expect((await h.request(AGENT, 'GET', `/api/contacts/${b}`)).status).toBe(404)
  })

  test('a merge needs two different contacts that exist, named in the body', async () => {
    const { h, a } = await twoAddressesOfDana()
    expect((await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: a })).status).toBe(422)
    expect((await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: 'nobody' })).status).toBe(404)
    expect((await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, {})).status).toBe(422)
    expect((await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: 7 })).status).toBe(422)
    expect((await h.request(AGENT, 'POST', '/api/contacts/nobody/merge', { absorb: a })).status).toBe(404)
  })

  test('split moves one address back out to a new contact, and refuses the last one', async () => {
    const { h, a, b } = await twoAddressesOfDana()
    await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: b })
    const identity = (h.db.query(`SELECT id FROM identity WHERE address = 'dana@work.example'`).get() as { id: string })
      .id
    const split = await h.request(AGENT, 'POST', `/api/identities/${identity}/split`, {})
    expect(split.status).toBe(200)
    expect(split.json.contact.identities.map((i: { address: string }) => i.address)).toEqual(['dana@work.example'])
    expect(split.json.from.identities.map((i: { address: string }) => i.address)).toEqual(['dana@example.com'])
    expect((await h.request(AGENT, 'POST', `/api/identities/${identity}/split`, {})).status).toBe(422)
    expect((await h.request(AGENT, 'POST', '/api/identities/nothing/split', {})).status).toBe(404)
  })

  test('a stranger can do neither, and a write from another site is refused', async () => {
    const { h, a, b } = await twoAddressesOfDana()
    expect((await h.request(STRANGER, 'POST', `/api/contacts/${a}/merge`, { absorb: b })).status).toBe(403)
    expect(
      (await h.request(AGENT, 'POST', `/api/contacts/${a}/merge`, { absorb: b }, { 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(403)
    expect((await h.request(AGENT, 'GET', `/api/contacts/${b}`)).status).toBe(200)
  })
})

describe('person or automated sender, on the contacts answers', () => {
  const UNSUB = 'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io'
  const BULK = { 'List-Unsubscribe': '<mailto:unsub@x.example>' }

  async function mailbox() {
    const h = harness()
    await live(h, () => {
      from(h, 'dana@acme.example', 'Dana Reyes', { subject: 'A person' })
      // Pinecrest's leads@ address: a mailbox people answer from, so not automated on its own.
      from(h, 'leads@pinecrest.example', 'leads@pinecrest.example', { subject: 'New website lead' })
      from(h, 'notifications@github.example', 'GitHub', { subject: 'A new app' })
      from(h, UNSUB, UNSUB, { subject: 'Your weekly digest', headers: BULK })
      // hello@ is no reason by itself: it is automated here only because everything it sent is Bulk.
      from(h, 'hello@orbit.example', 'Orbit Team', { subject: 'Product news', headers: BULK })
      from(h, 'hello@orbit.example', 'Orbit Team', { subject: 'More news', threadId: 't-orbit-2', headers: BULK })
      // Mixed: one Bulk conversation and one plain one is a person.
      from(h, 'sam@shop.example', 'Sam', { subject: 'Big sale', headers: BULK })
      from(h, 'sam@shop.example', 'Sam', { subject: 'Question for you', threadId: 't-sam-2' })
    })
    const list = async () =>
      (await h.request(AGENT, 'GET', '/api/contacts')).json as {
        name: string
        sender: { automated: boolean; rule: string; reason: string }
      }[]
    const kind = async (name: string) => (await list()).find((c) => c.name === name)?.sender
    return { h, list, kind }
  }

  test('each contact is judged with its reason: people, no-reply mailboxes, unsubscribe names, all-Bulk senders', async () => {
    const { kind } = await mailbox()
    expect(await kind('Dana Reyes')).toMatchObject({ automated: false })
    expect(await kind('leads@pinecrest.example')).toMatchObject({ automated: false })
    expect(await kind('Sam')).toMatchObject({ automated: false })
    expect(await kind('GitHub')).toMatchObject({
      automated: true,
      reason: 'Its only address, notifications@github.example, is a no-reply mailbox.',
    })
    expect(await kind(UNSUB)).toEqual({
      automated: true,
      rule: 'name',
      reason: 'Named by a machine-made address, such as an unsubscribe address.',
    })
    expect(await kind('Orbit Team')).toEqual({
      automated: true,
      rule: 'bulk',
      reason: 'All 2 of its conversations are Bulk (newsletters, receipts, notifications).',
    })
  })

  test('the contact card says the same as the list, so the details column and Contacts agree', async () => {
    const { h, list } = await mailbox()
    for (const c of await list()) {
      const id = (h.db.query(`SELECT id FROM contact WHERE name = ?`).get(c.name) as { id: string }).id
      expect((await h.request(AGENT, 'GET', `/api/contacts/${id}`)).json.sender, c.name).toEqual(c.sender)
    }
  })

  test('a contact linked to a Client is never automated, whatever its mail looks like, and unlinking puts the rule back', async () => {
    const { h, kind } = await mailbox()
    expect((await kind('Orbit Team'))?.automated).toBe(true)

    await assign(h, 'hello@orbit.example', { clientId: 1 })
    expect(await kind('Orbit Team')).toEqual({
      automated: false,
      rule: 'client',
      reason: 'Under a Client, so always a person.',
    })
    // A no-reply mailbox and an unsubscribe name too.
    await assign(h, 'notifications@github.example', { clientId: 2 })
    await assign(h, UNSUB, { clientId: 2 })
    expect((await kind('GitHub'))?.automated).toBe(false)
    expect((await kind(UNSUB))?.automated).toBe(false)

    // A Client's page lists its people with the same answer.
    const page = (await h.request(AGENT, 'GET', '/api/clients/2')).json
    expect(page.contacts.map((p: { sender: { automated: boolean } }) => p.sender.automated)).toEqual([false, false])

    await assign(h, 'hello@orbit.example', { clientId: null })
    expect((await kind('Orbit Team'))?.automated).toBe(true)
  })

  test('nothing is stored: reading writes no audit, and renaming a contact named by an unsubscribe address changes which rule speaks', async () => {
    const { h, kind } = await mailbox()
    const id = (h.db.query(`SELECT id FROM contact WHERE name = ?`).get(UNSUB) as { id: string }).id
    const before = h.inbox.listAudit().length
    await kind(UNSUB)
    expect(h.inbox.listAudit().length).toBe(before)
    expect((await h.request(AGENT, 'PATCH', `/api/contacts/${id}`, { name: 'Customer.io newsletter' })).status).toBe(
      200,
    )
    // Still all of its mail is Bulk, so the third rule now says why.
    expect(await kind('Customer.io newsletter')).toMatchObject({
      automated: true,
      reason: 'Its only conversation is Bulk (a newsletter, receipt or notification).',
    })
  })

  test('a contact with a phone number and no conversations at all is a person', async () => {
    const h = harness()
    await live(h, () => {})
    const draft = await ownerDraft(h, { address: '626-555-0142', name: 'Marcus', body: 'Hi' })
    expect(draft.status).toBe(201)
    const list = (await h.request(AGENT, 'GET', '/api/contacts')).json
    expect(list.find((c: { name: string }) => c.name === 'Marcus').sender.automated).toBe(false)
  })
})
