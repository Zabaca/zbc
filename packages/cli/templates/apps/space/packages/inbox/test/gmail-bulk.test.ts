import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, harness, mint, STRANGER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * ADR-007 decision 23, the parity Tessa asked for: Gmail's Bulk is Ridgeway's rule. A person's call ("Mark as
 * spam", "Move to the Inbox") works on a Gmail conversation and sticks for it, and a no-reply address or a machine-made name is
 * Bulk on Gmail too, with a Client's contact still in the Inbox. The second reclassifies live conversations, so what these hold
 * is that it is a view: Gmail is asked for nothing and told nothing, nothing is written by it or notified, and `bulk-report` says how
 * many open Gmail conversations it moved. The highest seam: the Worker as a function over a real SQLite and a fake Google.
 */

type H = ReturnType<typeof harness>

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id
const detail = async (h: H, threadId: string) =>
  (await h.request(AGENT, 'GET', `/api/conversations/${convoId(h, threadId)}`)).json
const filter = async (h: H, id: string) =>
  (((await h.request(AGENT, 'GET', `/api/queue?filter=${id}`)).json.rows as { id: string }[]) ?? []).map((r) => r.id)
/** Tessa's call (the owner has no router: the Assistant's `setSpam` as him, which is what the space's entrypoint calls), or Claude's or a stranger's through the door. */
const spam = async (h: H, threadId: string, on: boolean, who?: Record<string, unknown>) =>
  who === undefined
    ? asHttp(await h.store.call('setSpam', convoId(h, threadId), on, OWNER_EMAIL))
    : h.request(who, 'PUT', `/api/conversations/${convoId(h, threadId)}/spam`, { spam: on })
const notifyOf = (h: H, gmailId: string) =>
  (h.db.query(`SELECT notify FROM message WHERE gmail_id = ?`).get(gmailId) as { notify: string | null }).notify

async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  h.tick()
  await h.drain()
}

const ANN = 'Ann Reyes <ann@person.test>'
const NOREPLY = 'Bank Alerts <noreply@bank.test>'
const MACHINE = 'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io'

/** A person, two automated senders, a promotion, and a no-reply address that belongs to a Client. */
async function mailbox(h: H) {
  const add = (id: string, thread: string, from: string, subject: string, over: Record<string, unknown> = {}) =>
    h.google.mailbox.add({ id, threadId: thread, from, subject, body: `Body of ${id}`, ...over })
  add('g-person', 't-person', ANN, 'Quote for the shop site')
  add('g-noreply', 't-noreply', NOREPLY, 'Your statement is ready')
  add('g-machine', 't-machine', `${MACHINE} <${MACHINE}>`, 'Your weekly digest')
  add('g-promo', 't-promo', 'Shop <news@shop.test>', 'Fall sale', {
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
  })
  add('g-client', 't-client', 'Acme Billing <noreply@acme.example>', 'Invoice 114')
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  const contact = (
    h.db.query(`SELECT contact_id AS id FROM identity WHERE address = ?`).get('noreply@acme.example') as {
      id: string
    }
  ).id
  expect((await h.request(AGENT, 'PUT', `/api/contacts/${contact}/client`, { clientId: 1 })).status).toBe(200)
}

const gmailOnly = () => harness({}, { mailboxes: [] })

describe('an automated sender is Bulk on Gmail, as on Ridgeway', () => {
  test('a no-reply address and a machine-made name leave the Inbox; a person and a Client’s contact stay', async () => {
    const h = gmailOnly()
    await mailbox(h)
    const inbox = await filter(h, 'inbox')
    expect(inbox.sort()).toEqual([convoId(h, 't-person'), convoId(h, 't-client')].sort())
    const bulk = await filter(h, 'bulk')
    expect(bulk.sort()).toEqual([convoId(h, 't-noreply'), convoId(h, 't-machine'), convoId(h, 't-promo')].sort())
    // The conversation says why, in the same words as Ridgeway's, and names the Gmail account it is in.
    const page = await detail(h, 't-noreply')
    expect(page.bulk).toBe(true)
    expect(page.mailbox).toMatchObject({ name: 'northfield' })
    expect(page.reasons).toEqual([expect.stringMatching(/^Automated sender: /)])
    // A Client's contact is a person whatever the address looks like, and the page says that rule held.
    expect((await detail(h, 't-client')).bulk).toBe(false)
    expect((await detail(h, 't-client')).reasons).toEqual([
      expect.stringMatching(/^Automated sender: /),
      'Kept in the Inbox: a Client’s contact is on it.',
    ])
  })

  test('it is a view: reading the queue, a conversation and the report changes nothing and asks Gmail for nothing', async () => {
    const h = gmailOnly()
    await mailbox(h)
    const dump = () => ({
      messages: rows(h, 'SELECT id, labels, notify, notified_at FROM message ORDER BY id'),
      conversations: rows(h, 'SELECT id, sort, sort_by FROM conversation ORDER BY id'),
      audit: rows(h, 'SELECT count(*) AS n FROM audit'),
      google: [...h.google.calls],
    })
    const before = dump()
    await filter(h, 'bulk')
    await filter(h, 'inbox')
    await detail(h, 't-noreply')
    expect((await h.request(AGENT, 'GET', '/api/bulk-report')).status).toBe(200)
    expect(dump()).toEqual(before)
    // Nothing was ever moved or relabelled in Gmail: no label of any message in the fake has changed.
    for (const id of ['g-person', 'g-noreply', 'g-machine', 'g-promo', 'g-client']) {
      expect(h.google.mailbox.messages.get(id)?.labelIds).toContain('INBOX')
    }
  })

  test('arriving in Bulk notifies nobody, and a person’s mail still does', async () => {
    const h = gmailOnly()
    await mailbox(h)
    h.google.mailbox.add({
      id: 'g-noreply-2',
      threadId: 't-noreply',
      from: NOREPLY,
      subject: 'Re: statement',
      body: 'x',
    })
    h.google.mailbox.add({ id: 'g-person-2', threadId: 't-person', from: ANN, subject: 'Re: quote', body: 'x' })
    await hear(h)
    expect(notifyOf(h, 'g-noreply-2')).toBeNull()
    expect(['owed', 'sent', 'dropped']).toContain(notifyOf(h, 'g-person-2') as string)
  })
})

describe('a person’s call on a Gmail conversation', () => {
  test('moves it to Bulk and back, audited, sticks when the same person writes again, and changes nothing in Gmail', async () => {
    const h = gmailOnly()
    await mailbox(h)
    const calls = [...h.google.calls]
    const labels = rows(h, 'SELECT id, labels FROM message ORDER BY id')

    const moved = await spam(h, 't-person', true)
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)
    expect(moved.json).toEqual({ spamCall: { spam: true, by: 'owner' } })
    expect(await filter(h, 'bulk')).toContain(convoId(h, 't-person'))
    expect(await filter(h, 'inbox')).not.toContain(convoId(h, 't-person'))
    const page = await detail(h, 't-person')
    expect(page).toMatchObject({ bulk: true, spam: true, spamCall: { spam: true, by: 'owner' } })
    expect(page.reasons).toEqual(['Tessa moved it to Bulk.'])
    // The inbox's view, not Gmail's: no call to Gmail, no label of any message changed.
    expect(h.google.calls).toEqual(calls)
    expect(rows(h, 'SELECT id, labels FROM message ORDER BY id')).toEqual(labels)
    expect(h.inbox.listAudit().some((a) => a.action === 'conversation.spam')).toBe(true)

    // The same person writes again in that conversation: still Bulk, and it notifies nobody.
    h.google.mailbox.add({ id: 'g-person-2', threadId: 't-person', from: ANN, subject: 'Re: quote', body: 'Any news?' })
    await hear(h)
    expect((await detail(h, 't-person')).bulk).toBe(true)
    expect(notifyOf(h, 'g-person-2')).toBeNull()

    // And back to the Inbox: it decides over every rule but a Client's people, and sticks.
    expect((await spam(h, 't-person', false)).status).toBe(200)
    expect(await filter(h, 'inbox')).toContain(convoId(h, 't-person'))
    expect((await detail(h, 't-person')).spam).toBeUndefined()
  })

  test('Move to the Inbox rescues an automated sender, sticks, and its later mail notifies', async () => {
    const h = gmailOnly()
    await mailbox(h)
    expect(await filter(h, 'bulk')).toContain(convoId(h, 't-noreply'))
    expect((await spam(h, 't-noreply', false)).status).toBe(200)
    expect(await filter(h, 'inbox')).toContain(convoId(h, 't-noreply'))
    expect((await detail(h, 't-noreply')).reasons).toEqual([
      'Tessa moved it back to the Inbox.',
      expect.stringMatching(/^Automated sender/),
    ])
    h.google.mailbox.add({
      id: 'g-noreply-2',
      threadId: 't-noreply',
      from: NOREPLY,
      subject: 'Re: statement',
      body: 'x',
    })
    await hear(h)
    expect((await detail(h, 't-noreply')).bulk).toBe(false)
    expect(['owed', 'sent', 'dropped']).toContain(notifyOf(h, 'g-noreply-2') as string)
  })

  test('a Client’s people are never Bulk, called or not; Claude may call it, and nobody else', async () => {
    const h = gmailOnly()
    await mailbox(h)
    expect((await spam(h, 't-client', true)).status).toBe(200)
    expect((await detail(h, 't-client')).bulk).toBe(false)
    expect(await filter(h, 'inbox')).toContain(convoId(h, 't-client'))

    const byClaude = await spam(h, 't-promo', false, AGENT)
    expect(byClaude.json).toEqual({ spamCall: { spam: false, by: 'claude' } })
    expect(await filter(h, 'inbox')).toContain(convoId(h, 't-promo'))
    expect((await spam(h, 't-person', true, STRANGER)).status).toBe(403)
    expect((await detail(h, 't-person')).spamCall).toBeUndefined()
  })
})

describe('bulk-report: how many open Gmail conversations the automated-sender rule moved', () => {
  test('counts each kind of mailbox by place and reason, and names the senders', async () => {
    const h = gmailOnly()
    await mailbox(h)
    const report = (await h.request(AGENT, 'GET', '/api/bulk-report')).json
    expect(report.gmail).toEqual({
      open: 5,
      inbox: 2,
      bulk: 3,
      byReason: { unsubscribe: 0, category: 1, automated: 2, clef: 0, moved: 0 },
    })
    expect(report.cloudflare.open).toBe(0)
    expect(report.gmailMovedByAutomatedRule).toBe(2)
    expect(report.senders).toEqual([
      { name: 'Bank Alerts', address: 'noreply@bank.test', conversations: 1 },
      { name: MACHINE, address: MACHINE, conversations: 1 },
    ])

    // A call moves one out of the automated count.
    expect((await spam(h, 't-noreply', false)).status).toBe(200)
    const after = (await h.request(AGENT, 'GET', '/api/bulk-report')).json
    expect(after.gmailMovedByAutomatedRule).toBe(1)
    expect(after.gmail.byReason.automated).toBe(1)
  })

  test('is a read for Claude and the script prints it', async () => {
    const h = gmailOnly()
    await mailbox(h)
    expect((await h.request(AGENT, 'GET', '/api/bulk-report')).status).toBe(200)
    const io: CliIo = {
      env: {
        INBOX_URL: 'https://space.northfield.example',
        INBOX_ACCESS_CLIENT_ID: AGENT_ID,
        INBOX_ACCESS_CLIENT_SECRET: 's',
      },
      sopsKey: () => '',
      readInput: async (spec) => spec,
      fetch: async (url, init) => {
        const headers = new Headers(init.headers)
        headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
        return h.app.request(url, { ...init, headers }, h.env)
      },
    }
    const said = await runCli(['bulk-report'], io)
    expect(said.exitCode).toBe(0)
    expect(JSON.parse(said.output).gmailMovedByAutomatedRule).toBe(2)
  })
})
