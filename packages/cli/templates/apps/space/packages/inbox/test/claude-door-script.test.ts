import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { type CliIo, DEFAULT_URL, runCli } from '../scripts/cli'
import type { OutboxEntry } from '../src/types'
import { bundledInstall } from '../src/workspace'
import { AGENT_ID, harness } from '../test-support/harness'
import { CLIENT_ID, CLIENT_SECRET, throughSpace } from '../test-support/space-door'
import fixture from './fixtures/outbox.json'

/**
 * Claude's script, through the space's agent path (the only address the inbox has for it: there is no inbox host of its own). Everything outside is a stand-in (Access on the path, the space's hand-over: test-support/space-door.ts); the script is the real one and the
 * inbox is the real router over a real SQLite. The point is that every command works on this path, at the paths it always asked.
 */

const parse = (r: { output: string }) => JSON.parse(r.output)

/** The space's agent path, from the declaration: where the script goes by default. */
const DOOR_URL = bundledInstall.agentDoor()?.url ?? 'no door'

/** The script pointed at the door on the space, as it runs by default. */
function script(h: ReturnType<typeof harness>, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const door = throughSpace(h)
  const requests: { method: string; url: string }[] = []
  const io: CliIo = {
    env: { INBOX_URL: DOOR_URL, INBOX_ACCESS_CLIENT_ID: CLIENT_ID, INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET, ...env },
    sopsKey: () => {
      throw new Error('sops must not be called when the env is set')
    },
    readInput: async (spec) => (spec.startsWith('@') ? (files[spec.slice(1)] ?? '') : spec),
    fetch: (url, init) => {
      requests.push({ method: init.method ?? 'GET', url })
      return door.fetch(url, init)
    },
  }
  return { run: (...argv: string[]) => runCli(argv, io), requests, door, io }
}

async function connectedWithMail(h: ReturnType<typeof harness>) {
  h.google.mailbox.add({
    id: 'x1',
    threadId: 'tx',
    from: 'Ann <ann@example.com>',
    subject: 'Hello',
    body: 'Pay by Friday',
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

describe('where the script goes', () => {
  test('the door is the space’s agent path, the declaration’s', () => {
    expect(DOOR_URL).toBe('https://space.northfield.example/agent/inbox')
  })

  // The switch (packages/inbox/docs/runbooks/inbox-claude-door.md, step 4): the door is the default, and the inbox has no other address for the token.
  test('the default is the door, and the script names no other address of the inbox', () => {
    expect(DEFAULT_URL).toBe(DOOR_URL)
    const source = readFileSync(new URL('../scripts/cli.ts', import.meta.url), 'utf8')
    // The only address written in the script is this machine's, for a local run: an inbox host of its own, of any company, would be a second address for the token.
    expect([...source.matchAll(/https?:\/\/[^\s'"`,;)]+/g)].map((m) => m[0])).toEqual(['http://localhost:4660'])
  })

  test('every command asks the path under it, with no other change: the paths are the ones it always used', async () => {
    const h = harness()
    const { run, requests } = script(h)
    await run('queue')
    await run('drafts')
    await run('search', 'hello')
    await run('contacts')
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://space.northfield.example/agent/inbox/api/queue',
      'GET https://space.northfield.example/agent/inbox/api/drafts',
      'GET https://space.northfield.example/agent/inbox/api/search?q=hello',
      'GET https://space.northfield.example/agent/inbox/api/contacts',
    ])
  })

  test('INBOX_URL still overrides the address, for a local run: the script then sends no token', async () => {
    const requests: { url: string; headers: Headers }[] = []
    const res = await runCli(['drafts'], {
      env: { INBOX_URL: 'http://localhost:4660/' },
      sopsKey: () => {
        throw new Error('a local run needs no token')
      },
      readInput: async () => '',
      fetch: async (url, init) => {
        requests.push({ url, headers: new Headers(init.headers) })
        return Response.json([])
      },
    })
    expect(res.exitCode).toBe(0)
    expect(requests.map((r) => r.url)).toEqual(['http://localhost:4660/api/drafts'])
    expect(requests[0]?.headers.get('CF-Access-Client-Id')).toBeNull()
  })

  test('the token comes from sops by the same two names as before', async () => {
    const asked: string[] = []
    const h = harness()
    const door = throughSpace(h)
    await runCli(['drafts'], {
      env: { INBOX_URL: DOOR_URL },
      sopsKey: (name) => {
        asked.push(name)
        return name === 'INBOX_ACCESS_CLIENT_ID' ? CLIENT_ID : CLIENT_SECRET
      },
      readInput: async () => '',
      fetch: door.fetch,
    })
    expect(asked).toEqual(['INBOX_ACCESS_CLIENT_ID', 'INBOX_ACCESS_CLIENT_SECRET'])
  })
})

describe('only the token gets in', () => {
  test('a wrong secret, or no token, is turned away at the path and nothing reaches the inbox', async () => {
    const h = harness()
    const wrong = script(h, {}, { INBOX_ACCESS_CLIENT_SECRET: 'wrong' })
    const res = await wrong.run('queue')
    expect(res.exitCode).toBe(1)
    expect(res.output).toContain('403')
    expect(wrong.door.received).toEqual([])
  })

  test('a path that is not the inbox’s API under the door is a 404 and reaches nothing', async () => {
    const h = harness()
    const { door } = script(h)
    const res = await door.fetch('https://space.northfield.example/agent/inbox/index.html', {
      headers: { 'CF-Access-Client-Id': CLIENT_ID, 'CF-Access-Client-Secret': CLIENT_SECRET },
    })
    expect(res.status).toBe(404)
    expect(door.received).toEqual([])
  })

  test('the cookie and the token’s own two headers do not reach the inbox', async () => {
    const h = harness()
    const { door } = script(h)
    const res = await door.fetch('https://space.northfield.example/agent/inbox/api/mailbox', {
      headers: {
        'CF-Access-Client-Id': CLIENT_ID,
        'CF-Access-Client-Secret': CLIENT_SECRET,
        cookie: 'CF_Authorization=abc',
      },
    })
    expect(res.status).toBe(200)
    expect(door.received).toEqual([
      { method: 'GET', path: '/api/mailbox', headers: { cookie: null, clientSecret: null } },
    ])
  })
})

describe('everything the script does at the address, it does on the path', () => {
  test('draft, drafts, edit, conversation, mark-sent, the queue, contacts, rename, delete and audit, end to end', async () => {
    const h = harness()
    const { run } = script(h, {
      'd.json': JSON.stringify({
        address: '626-555-0101',
        name: 'Dana',
        subject: 'Hello',
        body: 'Hi Dana',
        why: 'She asked.',
      }),
    })
    const draft = parse(await run('draft', '@d.json'))
    expect(draft).toMatchObject({ status: 'draft', createdBy: `agent:${AGENT_ID}` })
    expect(parse(await run('drafts'))).toHaveLength(1)
    expect(
      parse(await run('edit', draft.id, JSON.stringify({ rev: draft.rev, body: 'Hi Dana, one more thing' }))).body,
    ).toBe('Hi Dana, one more thing')
    const marked = parse(await run('mark-sent', draft.id, '2026-10-20T10:00:00Z'))
    expect(marked.sentAt).toBe('2026-10-20T10:00:00.000Z')
    expect(parse(await run('conversation', marked.conversationId)).messages).toHaveLength(1)
    expect(parse(await run('queue', 'closed')).rows).toHaveLength(1)
    expect(parse(await run('unmark-sent', draft.id)).status).toBe('draft')
    expect(parse(await run('contacts'))[0]).toMatchObject({ name: 'Dana', drafts: 1 })
    expect(parse(await run('contact', draft.contactId)).name).toBe('Dana')
    expect(parse(await run('rename', draft.contactId, 'Dana', 'Reyes')).name).toBe('Dana Reyes')
    expect(parse(await run('delete-draft', draft.id, '1')).id).toBe(draft.id)
    expect(parse(await run('audit')).length).toBeGreaterThan(5)
  })

  test('a refusal from the inbox comes back as a failing exit with its reason', async () => {
    const h = harness()
    const { run } = script(h)
    const refused = await run(
      'draft',
      JSON.stringify({ address: 'a@example.com', body: 'Hi', why: 'x', subject: 'a \u2014 b' }),
    )
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain('422')
    expect(refused.output).toContain('em dash')
  })

  test('cc: a draft takes a list of addresses, edit replaces it, and a malformed address or a Cc on a text comes back refused with nothing drafted', async () => {
    const h = harness()
    const { run } = script(h)
    const made = parse(
      await run(
        'draft',
        JSON.stringify({
          address: 'dana@example.com',
          subject: 'Hello',
          body: 'Hi Dana',
          why: 'She asked.',
          cc: ['Ann@Example.org', 'dana@example.com'],
        }),
      ),
    )
    expect(made).toMatchObject({ status: 'draft', cc: 'ann@example.org', rev: 0 })
    const edited = parse(
      await run('edit', made.id, JSON.stringify({ rev: made.rev, cc: ['bob@example.net', 'ann@example.org'] })),
    )
    expect(edited).toMatchObject({ cc: 'bob@example.net, ann@example.org', rev: 1 })
    expect(parse(await run('drafts'))[0]).toMatchObject({ cc: 'bob@example.net, ann@example.org' })

    const malformed = await run('edit', made.id, JSON.stringify({ rev: edited.rev, cc: ['not an address'] }))
    expect(malformed.exitCode).toBe(1)
    expect(malformed.output).toContain('422')
    const text = await run(
      'draft',
      JSON.stringify({ address: '626-555-0101', body: 'Hi', why: 'x', cc: ['ann@example.org'] }),
    )
    expect(text.exitCode).toBe(1)
    expect(text.output).toContain('Only an email draft can have a Cc')
    expect(parse(await run('drafts'))).toHaveLength(1)
    // A draft to a bare address, new or already a contact, with an entry that is no address: refused both times, nothing drafted (the probe that was accepted live while the store still ran the old code).
    const probe = JSON.stringify({
      address: 'cc-probe@example.com',
      subject: 'probe',
      why: 'probe',
      body: 'probe',
      cc: ['not an address'],
    })
    for (const attempt of [1, 2]) {
      if (attempt === 2)
        parse(
          await run(
            'draft',
            JSON.stringify({ address: 'cc-probe@example.com', subject: 'real', why: 'x', body: 'real' }),
          ),
        )
      const refusedProbe = await run('draft', probe)
      expect(refusedProbe.exitCode, `attempt ${attempt}`).toBe(1)
      expect(refusedProbe.output).toContain('422')
      expect(refusedProbe.output).toContain('not an address')
    }
    expect(parse(await run('drafts'))).toHaveLength(2)
    // The help names the field where the draft fields are listed.
    expect((await run()).output).toContain('"cc": ["a@example.com"]')
  })

  test('the conversation commands: queue, search, conversation, close and reopen, and reading marks nothing', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run } = script(h)
    const calls = h.google.calls.length
    const queue = parse(await run('queue'))
    expect(queue.rows[0]).toMatchObject({ unread: true, open: true })
    const id = queue.rows[0].id
    expect(parse(await run('search', 'friday')).rows).toHaveLength(1)
    const read = parse(await run('conversation', id))
    parse(await run('queue', 'bulk'))
    expect(h.google.calls).toHaveLength(calls)
    expect(parse(await run('close', id, String(read.through)))).toMatchObject({
      open: false,
      closedBy: `agent:${AGENT_ID}`,
    })
    expect(h.google.calls).toContain('thread-close:tx')
    expect(parse(await run('reopen', id))).toMatchObject({ open: true })
    // Marking read is refused to the agent on the path as at the address.
    const raw = await run('conversation', id)
    expect(parse(raw).unread).toBe(true)
  })

  test('mailbox, mailboxes, sync, bookmark, sending, sent-by-claude, bulk-report, assistant-usage, clients and knowledge answer', async () => {
    const h = harness()
    await connectedWithMail(h)
    const { run } = script(h)
    expect(parse(await run('mailbox')).accounts[0]).toMatchObject({ connected: true })
    expect(parse(await run('sync'))).toEqual({ queued: true })
    for (const argv of [
      ['mailboxes'],
      ['sending'],
      ['sent-by-claude'],
      ['bulk-report'],
      ['assistant-usage'],
      ['clients'],
      ['client', '1'],
      ['bookmark'],
      ['knowledge'],
    ]) {
      const res = await run(...argv)
      expect(res.exitCode, `${argv.join(' ')}: ${res.output}`).toBe(0)
    }
  })

  test('assign-client, suggestions, merge, split, spam and propose-knowledge reach the inbox’s routes', async () => {
    const h = harness()
    const { run } = script(h, {
      'a.json': JSON.stringify({ address: 'a@example.com', name: 'A', subject: 's', body: 'b', why: 'w' }),
      'b.json': JSON.stringify({ address: 'b@example.com', name: 'B', subject: 's', body: 'b', why: 'w' }),
    })
    const a = parse(await run('draft', '@a.json'))
    const b = parse(await run('draft', '@b.json'))
    expect(parse(await run('assign-client', a.contactId, '1')).clientId).toBe(1)
    expect((await run('suggestions', a.contactId)).exitCode).toBe(0)
    const merged = parse(await run('merge', a.contactId, b.contactId))
    expect(merged.id).toBe(a.contactId)
    const identity = merged.identities?.[1]?.id ?? merged.identities?.[0]?.id
    expect(identity).toBeDefined()
    expect((await run('split', identity)).exitCode).toBe(0)
    // spam and propose-knowledge are answered by the inbox's own rules (a refusal is an answer, a 404 would be a missing route).
    expect((await run('spam', 'nope', 'on')).output).toMatch(/404|403|422/)
    expect((await run('propose-knowledge', JSON.stringify({}))).output).toMatch(/\b(400|403|422|503)\b/)
  })

  test('send is refused without Tessa’s instruction before it asks, and by the inbox while the switch is off', async () => {
    const h = harness()
    const { run, requests } = script(h)
    const none = await run('send', 'x', JSON.stringify({ rev: 1 }))
    expect(none.exitCode).toBe(1)
    expect(requests).toEqual([])
    const draft = parse(
      await run('draft', JSON.stringify({ address: 'a@example.com', subject: 's', body: 'b', why: 'w' })),
    )
    const sent = await run(
      'send',
      draft.id,
      JSON.stringify({
        rev: draft.rev,
        instruction: { text: 'send it', where: 'a session', at: '2026-10-21T18:02:30Z' },
      }),
    )
    expect(sent.exitCode).toBe(1)
    expect(sent.output).toMatch(/403|409/)
    expect(h.google.count('send')).toBe(0)
  })

  test('the Outbox carry balances', async () => {
    const h = harness()
    const { run } = script(h, { 'outbox.json': JSON.stringify(fixture as OutboxEntry[]) })
    const res = await run('import-outbox', '@outbox.json')
    expect(res.exitCode).toBe(0)
    expect(parse(res)).toMatchObject({ received: { total: 6 }, balanced: true })
  })
})
