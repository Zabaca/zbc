import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli, USAGE } from '../scripts/cli'
import { type OutboxEntry, SEND_FIELDS } from '../src/types'
import { AGENT, AGENT_AUD, AGENT_ID, harness, mint } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import fixture from './fixtures/outbox.json'

/**
 * Claude's script, driven through the real app. The only stand-in is Cloudflare
 * Access itself: a request carrying the service token's two headers is given the
 * assertion Access would mint for it, and one without is turned away.
 */

const CLIENT_ID = AGENT_ID
const CLIENT_SECRET = 'not-a-real-secret'

function cli(h: ReturnType<typeof harness>, files: Record<string, string> = {}) {
  const requests: { method: string; path: string }[] = []
  const io: CliIo = {
    env: {
      INBOX_ACCESS_CLIENT_ID: CLIENT_ID,
      INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
    },
    sopsKey: () => {
      throw new Error('sops must not be called when the env is set')
    },
    readInput: async (spec) => (spec.startsWith('@') ? (files[spec.slice(1)] ?? '') : spec),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const u = new URL(url)
      requests.push({ method: init.method ?? 'GET', path: u.pathname.replace('/agent/inbox', '') + u.search })
      if (
        headers.get('CF-Access-Client-Id') !== CLIENT_ID ||
        headers.get('CF-Access-Client-Secret') !== CLIENT_SECRET
      ) {
        return new Response('Forbidden', { status: 403 })
      }
      headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
      // The space strips its agent path and hands the inbox's own /api/ path on (packages/workspace/src/agent.ts).
      return h.app.request(url.replace('/agent/inbox', ''), { ...init, headers }, h.env)
    },
  }
  return { run: (...argv: string[]) => runCli(argv, io), requests, io }
}

const parse = (r: { output: string }) => JSON.parse(r.output)

describe('drafting from a session', () => {
  test('draft, drafts, edit, conversation, mark-sent and the queue, end to end', async () => {
    const h = harness()
    const { run } = cli(h, {
      'd.json': JSON.stringify({
        address: '626-555-0101',
        name: 'Dana',
        subject: 'Hello',
        body: 'Hi Dana',
        why: 'She asked.',
      }),
    })

    const drafted = await run('draft', '@d.json')
    expect(drafted.exitCode).toBe(0)
    const draft = parse(drafted)
    expect(draft).toMatchObject({ status: 'draft', createdBy: `agent:${AGENT_ID}` })

    expect(parse(await run('drafts'))).toHaveLength(1)
    expect(
      parse(await run('edit', draft.id, JSON.stringify({ rev: draft.rev, body: 'Hi Dana, one more thing' }))).body,
    ).toBe('Hi Dana, one more thing')

    const marked = parse(await run('mark-sent', draft.id, '2026-10-20T10:00:00Z'))
    expect(marked.sentAt).toBe('2026-10-20T10:00:00.000Z')
    expect(parse(await run('conversation', marked.conversationId)).messages).toHaveLength(1)
    expect(parse(await run('queue')).rows).toHaveLength(0)
    expect(parse(await run('queue', 'closed')).rows).toHaveLength(1)
    expect(parse(await run('queue', 'drafts')).rows).toHaveLength(0)

    expect(parse(await run('unmark-sent', draft.id)).status).toBe('draft')
    expect(parse(await run('contacts'))[0]).toMatchObject({ name: 'Dana', drafts: 1 })
    expect(parse(await run('contact', draft.contactId)).name).toBe('Dana')
    expect(parse(await run('rename', draft.contactId, 'Dana', 'Reyes')).name).toBe('Dana Reyes')
    expect(parse(await run('delete-draft', draft.id, '1')).id).toBe(draft.id)
    expect(parse(await run('audit')).length).toBeGreaterThan(5)
  })

  test('a refusal comes back as a failing exit with the server’s reason', async () => {
    const h = harness()
    const { run } = cli(h)
    const refused = await run(
      'draft',
      JSON.stringify({ address: 'a@example.com', body: 'Hi', why: 'x', subject: 'a \u2014 b' }),
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain('422')
    expect(refused.output).toContain('em dash')
  })

  test('a token Access does not recognise is a failing exit, not a crash', async () => {
    const h = harness()
    const c = cli(h)
    c.io.env.INBOX_ACCESS_CLIENT_SECRET = 'wrong'
    const res = await c.run('queue')
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain('403')
  })
})

describe('the Gmail connection from a session', () => {
  test('mailbox reads the connection and sync asks for a catch-up, and neither marks anything read', async () => {
    const h = harness()
    const { run } = cli(h)
    expect(parse(await run('mailbox'))).toEqual({ accounts: [] })
    expect((await run('sync')).exitCode).toBe(1)

    h.google.mailbox.add({ id: 'x' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    h.google.mailbox.add({ id: 'y' })
    const calls = h.google.calls.length
    expect(parse(await run('mailbox')).accounts[0]).toMatchObject({ connected: true, state: 'live', messages: 1 })
    expect(parse(await run('sync'))).toEqual({ queued: true })
    expect(h.google.calls).toHaveLength(calls)
    await h.drain()
    expect(parse(await run('mailbox')).accounts[0]).toMatchObject({ messages: 2 })
  })

  test('the script has no command that flips the switch or says whether a send went out: those are Tessa’s', async () => {
    const h = harness()
    const { run, requests } = cli(h)
    for (const command of ['send-draft', 'resolve-send', 'enable-sending', 'disable-sending', 'switch'])
      expect((await run(command, 'x')).exitCode).toBe(1)
    expect(requests).toEqual([])
  })

  test('a reply draft from the script needs no address and no subject: the inbox addresses it and says to whom', async () => {
    const h = harness()
    h.google.mailbox.add({
      id: 'm1',
      threadId: 't1',
      from: 'Forms <forms@example.com>',
      subject: 'New quote request',
      headers: { 'Reply-To': 'Pat <pat@example.org>' },
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const conversationId = (h.db.query(`SELECT id FROM conversation`).get() as { id: string }).id
    const { run } = cli(h, { 'd.json': JSON.stringify({ conversationId, body: 'Hi Pat', why: 'She asked.' }) })
    const drafted = parse(await run('draft', '@d.json'))
    expect(drafted).toMatchObject({ address: 'pat@example.org', subject: 'Re: New quote request', status: 'draft' })
    expect(h.google.count('send')).toBe(0)
  })

  test('the script has no command that connects or disconnects Gmail', async () => {
    const h = harness()
    const { run, requests } = cli(h)
    for (const command of ['connect', 'disconnect']) expect((await run(command)).exitCode).toBe(1)
    expect(requests).toEqual([])
  })
})

describe('read and closed from a session', () => {
  async function connectedWithMail(h: ReturnType<typeof harness>) {
    h.google.mailbox.add({ id: 'x1', threadId: 'tx', from: 'Ann <ann@example.com>', subject: 'Hello' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
  }

  test('queue and conversation show what is unread and open, and reading them marks nothing', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run } = cli(h)
    const calls = h.google.calls.length

    const queue = parse(await run('queue'))
    expect(queue.filters[0]).toMatchObject({ id: 'inbox', label: 'Inbox', count: 1, unread: 1 })
    expect(queue.rows[0]).toMatchObject({ unread: true, open: true, bulk: false })
    const one = parse(await run('conversation', queue.rows[0].id))
    expect(one).toMatchObject({ unread: true, open: true })
    parse(await run('queue', 'bulk'))
    parse(await run('queue', 'closed'))

    expect(h.google.calls).toHaveLength(calls)
    expect(parse(await run('queue')).rows[0]).toMatchObject({ unread: true })
  })

  test('search prints the conversations that have every word, open or closed, and reads nothing but the inbox', async () => {
    const h = harness()
    await connectedWithMail(h)
    h.google.mailbox.add({
      id: 'x2',
      threadId: 'ty',
      from: 'Bob <bob@example.com>',
      subject: 'Invoice',
      body: 'Pay by Friday',
    })
    await h.push()
    h.tick()
    await h.drain()
    const { run, requests } = cli(h)
    const calls = h.google.calls.length

    const found = parse(await run('search', 'friday', 'BOB'))
    expect(found.terms).toEqual(['friday', 'bob'])
    expect(found.rows.map((r: { subject: string }) => r.subject)).toEqual(['Invoice'])
    expect(found.rows[0].match).toBe('Pay by Friday')
    expect(requests.at(-1)).toEqual({ method: 'GET', path: '/api/search?q=friday%20BOB' })
    expect(parse(await run('search', 'nothing', 'like', 'this')).rows).toEqual([])

    // The words may also be passed as one quoted argument.
    expect(parse(await run('search', 'bob friday')).rows).toHaveLength(1)
    // Nothing was marked read, and Gmail was not asked anything.
    expect(h.google.calls).toHaveLength(calls)
    expect(parse(await run('queue')).filters[0]).toMatchObject({ id: 'inbox', unread: 2 })
  })

  test('search with no words makes no request and prints the commands', async () => {
    const h = harness()
    const { run, requests } = cli(h)
    for (const argv of [['search'], ['search', '  ']]) {
      const res = await run(...argv)
      expect(res.exitCode).toBe(1)
      expect(res.output).toContain('usage: inbox.ts')
    }
    expect(requests).toEqual([])
  })

  test('close and reopen archive and unarchive in Gmail, as the agent', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run, requests } = cli(h)
    const id = parse(await run('queue')).rows[0].id

    // `conversation` prints how far into it has been read, and `close` is given that number.
    const read = parse(await run('conversation', id))
    expect(read.through).toBeGreaterThan(0)
    requests.length = 0
    const closed = parse(await run('close', id, String(read.through)))
    // It makes the one request it is asked to make, and does not look the number up itself.
    expect(requests).toEqual([{ method: 'POST', path: `/api/conversations/${id}/close` }])
    expect(closed).toMatchObject({ open: false, unread: true, closedBy: `agent:${AGENT_ID}` })
    expect(h.google.calls).toContain('thread-close:tx')
    expect(parse(await run('queue')).rows).toHaveLength(0)
    expect(parse(await run('queue', 'closed')).rows).toHaveLength(1)

    expect(parse(await run('reopen', id))).toMatchObject({ open: true, closedBy: null })
    expect(h.google.calls).toContain('thread-reopen:tx')
    expect(parse(await run('queue')).rows).toHaveLength(1)
  })

  test('close needs the through that conversation printed: without it, or with a number that is not one, nothing is asked', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run, requests } = cli(h)
    const id = parse(await run('queue')).rows[0].id
    requests.length = 0
    for (const argv of [
      ['close', id],
      ['close', id, ''],
      ['close', id, 'soon'],
      ['close', id, '1.5'],
    ]) {
      const res = await run(...argv)
      expect(res.exitCode, argv.join(' ')).toBe(1)
      expect(res.output).toContain('through')
    }
    expect(requests).toEqual([])
    expect(parse(await run('conversation', id)).open).toBe(true)
  })

  test('a reply that arrives after Claude read the conversation is never archived unread: close is refused and conversation shows it', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run } = cli(h)
    const id = parse(await run('queue')).rows[0].id
    const read = parse(await run('conversation', id))

    h.tick()
    h.google.mailbox.add({ id: 'x2', threadId: 'tx', from: 'Ann <ann@example.com>', subject: 'Re: Hello' })
    expect((await h.push()).status).toBe(204)
    h.tick()
    await h.drain()

    const refused = await run('close', id, String(read.through))
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain('409')
    expect(h.google.calls.some((c) => c.startsWith('thread-close'))).toBe(false)
    expect(h.google.mailbox.messages.get('x2')?.labelIds).toContain('INBOX')

    const again = parse(await run('conversation', id))
    expect(again.messages).toHaveLength(2)
    expect(again.through).toBeGreaterThan(read.through)
    expect(parse(await run('close', id, String(again.through)))).toMatchObject({ open: false })
  })

  test("there is no command that marks a conversation read, and no endpoint for it: reading is a person's, in the space", async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run, io } = cli(h)
    const id = parse(await run('queue')).rows[0].id
    const calls = h.google.calls.length

    for (const command of ['read', 'mark-read', 'open']) expect((await run(command, id)).exitCode).toBe(1)
    const raw = await io.fetch(`https://space.northfield.example/agent/inbox/api/conversations/${id}/read`, {
      method: 'POST',
      headers: {
        'CF-Access-Client-Id': CLIENT_ID,
        'CF-Access-Client-Secret': CLIENT_SECRET,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(raw.status).toBe(404)
    expect(h.google.calls).toHaveLength(calls)
    expect(parse(await run('conversation', id)).unread).toBe(true)
  })

  test('a refusal from Gmail comes back as a failing exit with the reason, and the conversation is unchanged', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run } = cli(h)
    const id = parse(await run('queue')).rows[0].id
    h.google.failNext('thread-close', new Error('Backend Error'))
    const res = await run('close', id, String(parse(await run('conversation', id)).through))
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain('502')
    expect(res.output).toContain('Nothing was changed here')
    expect(parse(await run('conversation', id)).open).toBe(true)
  })
})

describe('usage', () => {
  test('no command, an unknown one, or a missing argument prints the commands and fails', async () => {
    const h = harness()
    const { run, requests } = cli(h)
    for (const argv of [[], ['frobnicate'], ['conversation'], ['draft'], ['draft', 'not json']]) {
      const res = await run(...argv)
      expect(res.exitCode, argv.join(' ')).toBe(1)
      expect(res.output).toContain('usage: inbox.ts')
    }
    expect(requests).toEqual([])
  })

  test('against localhost it sends no token and asks sops for nothing', async () => {
    const calls: Record<string, string>[] = []
    const res = await runCli(['drafts'], {
      env: { INBOX_URL: 'http://localhost:4660/' },
      sopsKey: () => {
        throw new Error('no')
      },
      readInput: async () => '',
      fetch: async (url, init) => {
        calls.push({ url, ...(init.headers as Record<string, string>) })
        return Response.json([])
      },
    })
    expect(res.exitCode).toBe(0)
    expect(calls).toEqual([{ url: 'http://localhost:4660/api/drafts', 'content-type': 'application/json' }])
  })

  test('without the env, the keys come from sops by name', async () => {
    const asked: string[] = []
    await runCli(['drafts'], {
      env: {},
      sopsKey: (name) => {
        asked.push(name)
        return 'x'
      },
      readInput: async () => '',
      fetch: async () => Response.json([]),
    })
    expect(asked).toEqual(['INBOX_ACCESS_CLIENT_ID', 'INBOX_ACCESS_CLIENT_SECRET'])
  })
})

describe('the Outbox carry from the script', () => {
  const list = JSON.stringify(fixture as OutboxEntry[])

  test('prints the comparison, and exits 0 when every entry is accounted for', async () => {
    const h = harness()
    const { run } = cli(h, { 'outbox.json': list })
    const res = await run('import-outbox', '@outbox.json')
    expect(res.exitCode).toBe(0)
    expect(parse(res)).toMatchObject({
      received: { total: 6, unsent: 3, sent: 3 },
      created: { drafts: 3, manualSent: 3 },
      skipped: 0,
      balanced: true,
    })
    const again = parse(await run('import-outbox', '@outbox.json'))
    expect(again).toMatchObject({ created: { drafts: 0, manualSent: 0 }, skipped: 6, balanced: true })
    expect(parse(await run('drafts'))).toHaveLength(3)
  })

  test('exits 1 when an entry could not be carried, and still prints the report', async () => {
    const h = harness()
    const { run } = cli(h, {
      'outbox.json': JSON.stringify([{ id: 'x', to: 'Dana', address: 'dana@example.com', body: '' }]),
    })
    const res = await run('import-outbox', '@outbox.json')
    expect(res.exitCode).toBe(1)
    expect(parse(res).problems).toEqual([{ id: 'x', reason: 'The entry has no body.' }])
  })

  test('refuses anything that is not the list', async () => {
    const h = harness()
    const { run } = cli(h, { 'obj.json': '{"entries":[]}' })
    const res = await run('import-outbox', '@obj.json')
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain('JSON array')
  })
})

describe('Clients from a session', () => {
  async function arranged() {
    const h = harness()
    h.google.mailbox.add({ id: 'o1', threadId: 'to', from: 'Olive Owner <owner@acme.example>', subject: 'Hello' })
    h.google.mailbox.add({ id: 'p1', threadId: 'tp', from: 'Pat <pat@elsewhere.example>', subject: 'Hi' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const { run, requests } = cli(h)
    const contacts = parse(await run('contacts')) as { id: string; name: string; identities: { id: string }[] }[]
    const id = (name: string) => (contacts.find((c) => c.name === name) as { id: string }).id
    return { h, run, requests, id, contacts }
  }

  test("clients, client and the queue filter read the site's Clients through the inbox", async () => {
    const { run, id } = await arranged()
    expect(parse(await run('assign-client', id('Olive Owner'), '1'))).toMatchObject({
      clientId: 1,
      client: { name: 'Acme Legal' },
    })
    const list = parse(await run('clients'))
    expect(list.clients.map((c: { name: string; contacts: number }) => [c.name, c.contacts])).toEqual([
      ['Acme Legal', 1],
      ['Bolt Machines', 0],
    ])
    expect(parse(await run('client', '1')).client).toMatchObject({
      extra: { subscriptionStatus: 'active' },
      adminUrl: expect.stringContaining('#client-1'),
    })
    const queue = parse(await run('queue', 'client:1'))
    expect(queue.rows.map((r: { subject: string }) => r.subject)).toEqual(['Hello'])
    expect((await run('client', '99')).exitCode).toBe(1)
  })

  test('suggestions only shows; assign-client with its id is what accepts it, audited as Claude', async () => {
    const { h, run, id } = await arranged()
    const shown = parse(await run('suggestions'))
    expect(shown.suggestions).toEqual([
      expect.objectContaining({ contactName: 'Olive Owner', clientId: 1, reason: 'address' }),
    ])
    expect(parse(await run('suggestions', id('Pat'))).suggestions).toEqual([])
    expect(h.db.query(`SELECT count(*) AS n FROM contact WHERE client_id IS NOT NULL`).get()).toEqual({ n: 0 })

    await run('assign-client', id('Olive Owner'), String(shown.suggestions[0].clientId))
    expect(parse(await run('suggestions')).suggestions).toEqual([])
    const entry = h.inbox.listAudit().find((a) => a.action === 'contact.assign-client')
    expect(entry?.actor).toBe(`agent:${AGENT_ID}`)
  })

  test('assign-client refuses an unlisted Client (422) and takes a contact out with none', async () => {
    const { run, id } = await arranged()
    const refused = await run('assign-client', id('Pat'), '99')
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain('422')
    await run('assign-client', id('Pat'), '2')
    expect(parse(await run('assign-client', id('Pat'), 'none'))).toMatchObject({ clientId: null, client: null })
    for (const argv of [['assign-client'], ['assign-client', id('Pat')], ['assign-client', id('Pat'), 'two']]) {
      const res = await run(...argv)
      expect(res.exitCode, argv.join(' ')).toBe(1)
      expect(res.output).toContain('usage: inbox.ts')
    }
  })

  test('merge and split tidy contacts, and a merge is undone by a split', async () => {
    const { h, run, id } = await arranged()
    const olive = id('Olive Owner')
    const merged = parse(await run('merge', olive, id('Pat')))
    expect(merged.identities).toHaveLength(2)
    const pat = merged.identities.find((i: { address: string }) => i.address === 'pat@elsewhere.example')
    const split = parse(await run('split', pat.id))
    expect(split.contact.identities.map((i: { address: string }) => i.address)).toEqual(['pat@elsewhere.example'])
    expect(split.from.id).toBe(olive)
    expect(h.inbox.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(['contact.merge', 'contact.split']))
    expect((await run('merge', olive)).exitCode).toBe(1)
    expect((await run('merge', olive, olive)).output).toContain('422')
  })
})

describe('sending from a session', () => {
  const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }

  async function withDraft() {
    const h = harness()
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote for the shop' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const c = cli(h)
    const conversationId = parse(await c.run('queue')).rows[0].id
    const draft = parse(
      await c.run('draft', JSON.stringify({ conversationId, body: 'Tuesday works.', why: 'She asked for a time.' })),
    )
    return { h, ...c, conversationId, draft }
  }

  test('sending starts off, and send is refused until Tessa turns it on and then goes with what Claude read', async () => {
    const { h, run, requests, conversationId, draft } = await withDraft()
    expect(parse(await run('sending'))).toEqual({ enabled: false, changedAt: null, changedBy: null })
    // The numbers come from `drafts` and `conversation`, as printed, and are passed back as given.
    const listed = parse(await run('drafts'))[0]
    const read = parse(await run('conversation', conversationId))
    const body = JSON.stringify({ rev: listed.rev, through: read.through, instruction: SAID })

    const off = await run('send', draft.id, body)
    expect(off.exitCode).toBe(1)
    expect(off.output).toContain('403')
    expect(off.output).toContain('switched off')
    expect(h.google.count('send')).toBe(0)

    await h.store.call('setClaudeSending', true, OWNER_EMAIL)
    requests.length = 0
    const sent = await run('send', draft.id, body)
    expect(sent.exitCode, sent.output).toBe(0)
    // One request, and no lookup of its own.
    expect(requests).toEqual([{ method: 'POST', path: `/api/drafts/${draft.id}/send` }])
    expect(parse(sent)).toMatchObject({ status: 'sent', sentBy: `agent:${AGENT_ID}`, instruction: { text: 'send it' } })
    expect(h.google.count('send')).toBe(1)

    const list = parse(await run('sent-by-claude'))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ proof: 'filed', message: { id: draft.id, instruction: { text: 'send it' } } })
  })

  test('a send that cannot succeed asks nothing: no instruction, a part missing, a rev that is not one, or text of its own', async () => {
    const { run, requests, draft } = await withDraft()
    requests.length = 0
    const cases: [string, unknown][] = [
      ['no instruction', { rev: 0 }],
      ['no rev', { instruction: SAID }],
      ['rev as text', { rev: 'latest', instruction: SAID }],
      ['through as text', { rev: 0, through: 'soon', instruction: SAID }],
      ['no words', { rev: 0, instruction: { ...SAID, text: '' } }],
      ['no place', { rev: 0, instruction: { text: 'send it', at: SAID.at } }],
      ['no time', { rev: 0, instruction: { text: 'send it', where: 'x' } }],
      ['text of its own', { rev: 0, instruction: SAID, body: 'Something else.' }],
      ['recipients of its own', { rev: 0, instruction: SAID, to: 'evil@example.com' }],
    ]
    for (const [name, body] of cases) {
      const res = await run('send', draft.id, JSON.stringify(body))
      expect(res.exitCode, name).toBe(1)
      expect(res.output, name).toContain('usage: inbox.ts')
    }
    expect((await run('send', draft.id, 'not json')).exitCode).toBe(1)
    expect((await run('send')).exitCode).toBe(1)
    expect(requests).toEqual([])
  })

  test('the help says an instruction is only ever Tessa’s, in a session, and what to do when a reply came after it', async () => {
    const { run } = await withDraft()
    const help = (await run()).output
    expect(help).toContain('COMES ONLY FROM THE OWNER, IN A SESSION')
    expect(help).toContain('even one from the owner\'s own address')
    expect(help).toContain('"the inbox" is refused')
    expect(help).toContain('do not retry')
    expect(help).toContain('go back to the owner')
    expect(help).not.toContain('or the inbox')
  })

  test('edit and delete-draft need the rev drafts printed, as send does, and ask nothing of the inbox without it', async () => {
    const { run, requests, draft } = await withDraft()
    requests.length = 0
    for (const args of [
      ['edit', draft.id, '{"body":"x"}'],
      ['edit', draft.id, '{"body":"x","rev":"0"}'],
      ['edit', draft.id, '{"body":"x","rev":1.5}'],
      ['delete-draft', draft.id],
      ['delete-draft', draft.id, 'abc'],
      ['delete-draft', draft.id, '1.5'],
    ] as const) {
      const res = await run(...args)
      expect(res.exitCode, args.join(' ')).toBe(1)
      expect(res.output).toContain('rev')
    }
    expect(requests).toEqual([])
    // With it, the request carries it.
    expect((await run('edit', draft.id, JSON.stringify({ rev: draft.rev, body: 'x' }))).exitCode).toBe(0)
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH' })
  })

  test('the script accepts exactly the fields the server does', async () => {
    const { run, requests, draft } = await withDraft()
    requests.length = 0
    const res = await run('send', draft.id, JSON.stringify({ rev: 0, instruction: SAID, bcc: 'x@example.com' }))
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain(SEND_FIELDS.join(', '))
    expect(requests).toEqual([])
  })

  test('the server’s refusal of a stale draft comes back as a failing exit, with nothing sent', async () => {
    const { h, run, conversationId, draft } = await withDraft()
    await h.store.call('setClaudeSending', true, OWNER_EMAIL)
    const read = parse(await run('conversation', conversationId))
    await run('edit', draft.id, JSON.stringify({ rev: draft.rev, body: 'Tuesday at ten works.' }))
    const stale = await run(
      'send',
      draft.id,
      JSON.stringify({ rev: draft.rev, through: read.through, instruction: SAID }),
    )
    expect(stale.exitCode).toBe(1)
    expect(stale.output).toContain('409')
    expect(h.google.count('send')).toBe(0)
  })
})

describe('the words of the script, the same as the screen’s', () => {
  test('its help says close and Inbox, names every view, and has no Done or All open', () => {
    expect(USAGE).toContain('queue [inbox|unread|drafts|bulk|closed|client:<id>]')
    expect(USAGE).toContain('close <conversation-id> <through>    close it')
    expect(USAGE).toContain('search <words...>')
    expect(USAGE).not.toMatch(/\bdone\b/i)
    expect(USAGE).not.toContain('All open')
    expect(USAGE).not.toContain('all|drafts')
    // The script keeps listing what Claude sent, though the app has no page of it.
    expect(USAGE).toContain('sent-by-claude')
  })

  test('the views are the app’s: Unread and Drafts answer, and the old name of the Inbox is just the Inbox', async () => {
    const h = harness()
    h.google.mailbox.add({ id: 'x1', threadId: 'tx', from: 'Ann <ann@example.com>', subject: 'Hello' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const { run } = cli(h)
    expect(parse(await run('queue', 'unread')).rows).toHaveLength(1)
    expect(parse(await run('queue', 'unread')).filter).toBe('unread')
    expect(parse(await run('queue', 'all')).filter).toBe('inbox')
    const drafts = parse(await run('queue', 'drafts'))
    expect(drafts.filter).toBe('drafts')
    expect(drafts.looseDrafts).toEqual([])
  })
})
