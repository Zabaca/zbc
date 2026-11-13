import { describe, expect, test } from 'bun:test'
import type { MessageRow } from '../src/types'
import { AGENT, AGENT_ID, count, harness, OWNER } from '../test-support/harness'
import { as, ownerRequest } from '../test-support/owner-requests'

/**
 * An explicit Cc on a draft (ADR 0001 decision 35): set when a draft is made and replaced by an edit, by the owner or by Claude's script; cleaned the way a send would
 * need it; refused whole when it is malformed or on a draft that is not an email; kept when "copy everyone" is recomputed; an edit of the draft like any other (it raises
 * the revision and so voids an instruction given before it); and delivered by the send. Gmail is the transport here; the business mailbox's and the mail server's are in
 * ridgeway-send.test.ts and jmap-send.test.ts, which read the same draft.
 */

type H = ReturnType<typeof harness>

const TESSA = 'tessa@northfield.example'
const WORDS = 'Thanks Dana. Tuesday works for me.'
/** What Claude records: Tessa's words, where, and when (after every message these tests store, inside the skew allowed). */
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }

async function live(h: H, setup?: () => void) {
  setup?.()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

/** Dana writes to Tessa and Mary Jo and copies Bob: so "copy everyone" on a reply to Dana is Mary Jo and Bob. */
const group = (h: H) => () => {
  h.google.mailbox.add({
    id: 'm1',
    threadId: 't1',
    subject: 'Quote for the shop',
    to: `Tessa Marlow <${TESSA}>, Mary Jo <maryjo@example.com>`,
    cc: 'Bob <bob@example.com>',
  })
}

const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

const detail = async (h: H, threadId: string) =>
  (await ownerRequest(h, 'GET', `/api/conversations/${convoId(h, threadId)}`)).json

const row = (h: H, id: string) =>
  h.db.query(`SELECT * FROM message WHERE id = ?`).get(id) as Record<string, unknown> | null
const sent = (h: H) => h.google.mailbox.sent

/** A reply draft on thread t1 as `who`; Claude says why. */
async function reply(h: H, extra: Record<string, unknown> = {}, who: Record<string, unknown> = OWNER) {
  const res = await as(h, who, 'POST', '/api/drafts', {
    conversationId: convoId(h, 't1'),
    body: WORDS,
    ...(who === AGENT ? { why: 'She asked for a time.' } : {}),
    ...extra,
  })
  return res
}

const edit = (h: H, draft: { id: string }, body: Record<string, unknown>, who: Record<string, unknown> = OWNER) =>
  as(h, who, 'PATCH', `/api/drafts/${draft.id}`, body)

/** What a refused draft or edit must leave alone. */
const snapshot = (h: H) =>
  JSON.stringify([
    h.db.query(`SELECT * FROM message ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM contact ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM identity ORDER BY rowid`).all(),
    h.db.query(`SELECT * FROM conversation ORDER BY rowid`).all(),
  ])

describe('an explicit Cc when a draft is made', () => {
  test('is written into the draft, cleaned: lower case, each address once, never the recipient or Tessa; names around an address are dropped', async () => {
    const h = harness()
    await live(h, group(h))
    const asked = [
      'Ann@Example.org',
      'ann@example.org',
      'dana@example.com',
      TESSA.toUpperCase(),
      'Bob Jones <bob@example.net>',
    ]
    const owner = await reply(h, { cc: asked })
    expect(owner.status, JSON.stringify(owner.json)).toBe(201)
    expect(owner.json).toMatchObject({ cc: 'ann@example.org, bob@example.net', address: 'dana@example.com' })
    // Claude's script may do the same: the same field of the same route.
    const claude = await reply(h, { cc: asked }, AGENT)
    expect(claude.status, JSON.stringify(claude.json)).toBe(201)
    expect(claude.json).toMatchObject({ cc: 'ann@example.org, bob@example.net', createdBy: `agent:${AGENT_ID}` })
    expect(row(h, claude.json.id)).toMatchObject({ cc_header: 'ann@example.org, bob@example.net' })
  })

  test('is allowed on a new email to an address, which has no thread to copy from', async () => {
    const h = harness()
    await live(h, group(h))
    const made = await ownerRequest(h, 'POST', '/api/drafts', {
      address: 'lane@example.net',
      subject: 'Hello',
      body: 'A note.',
      cc: ['ann@example.org'],
    })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    expect(made.json.cc).toBe('ann@example.org')
  })

  test('is refused whole, with nothing drafted and no contact made for the address, when one entry is not an email address', async () => {
    const h = harness()
    await live(h, group(h))
    const before = snapshot(h)
    for (const cc of [
      ['ann@example.org', 'nobody'],
      ['a@b'],
      ['a b@example.org'],
      ['Zoë@example.org'],
      [5],
      'ann@example.org',
      { 0: 'a@example.org' },
    ]) {
      const onThread = await reply(h, { cc })
      expect(onThread.status, JSON.stringify(cc)).toBe(422)
      const byAddress = await ownerRequest(h, 'POST', '/api/drafts', {
        address: 'new.person@example.org',
        body: 'Hi',
        cc,
      })
      expect(byAddress.status, JSON.stringify(cc)).toBe(422)
      expect((await reply(h, { cc }, AGENT)).status, JSON.stringify(cc)).toBe(422)
    }
    expect(snapshot(h)).toBe(before)
  })

  test('is refused on a draft that is not an email (a text), with nothing drafted and no contact made', async () => {
    const h = harness()
    await live(h, group(h))
    const before = snapshot(h)
    const contacts = count(h, 'contact')
    const text = await ownerRequest(h, 'POST', '/api/drafts', {
      address: '+14155550123',
      body: 'Hi',
      cc: ['ann@example.org'],
    })
    expect(text.status).toBe(422)
    expect(text.json.error).toContain('Only an email draft can have a Cc')
    expect(count(h, 'contact')).toBe(contacts)
    expect(snapshot(h)).toBe(before)
    // Without a Cc, or with none in it, the same text is an ordinary draft.
    expect((await ownerRequest(h, 'POST', '/api/drafts', { address: '+14155550123', body: 'Hi', cc: [] })).status).toBe(
      201,
    )
  })
})

describe('an explicit Cc and "copy everyone"', () => {
  test('the typed addresses come first and the people copied after them, each once', async () => {
    const h = harness()
    await live(h, group(h))
    const made = await reply(h, { cc: ['ann@example.org', 'bob@example.com'], copyEveryone: true })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    expect(made.json.cc).toBe('ann@example.org, bob@example.com, maryjo@example.com')
  })

  test('unticking removes only the people it adds, ticking again adds them back after what was typed, and a typed address survives both', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { cc: ['ann@example.org'], copyEveryone: true })).json
    expect(made.cc).toBe('ann@example.org, maryjo@example.com, bob@example.com')

    const off = (await edit(h, made, { rev: made.rev, copyEveryone: false })).json
    expect(off).toMatchObject({ cc: 'ann@example.org', rev: made.rev + 1 })
    const on = (await edit(h, off, { rev: off.rev, copyEveryone: true })).json
    expect(on.cc).toBe('ann@example.org, maryjo@example.com, bob@example.com')
    // A Cc typed later, beside the people: still there once they are taken off.
    const more = (await edit(h, on, { rev: on.rev, cc: [...on.cc.split(', '), 'cy@example.org'] })).json
    expect(more.cc).toBe('ann@example.org, maryjo@example.com, bob@example.com, cy@example.org')
    expect((await edit(h, more, { rev: more.rev, copyEveryone: false })).json.cc).toBe(
      'ann@example.org, cy@example.org',
    )
  })

  test('an address the same edit names stays when it unticks, even one of the people; an edit that names a list and nothing else replaces the whole of it', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { copyEveryone: true })).json
    expect(made.cc).toBe('maryjo@example.com, bob@example.com')
    const kept = (
      await edit(h, made, { rev: made.rev, cc: ['bob@example.com', 'ann@example.org'], copyEveryone: false })
    ).json
    expect(kept.cc).toBe('bob@example.com, ann@example.org')
    const replaced = (await edit(h, kept, { rev: kept.rev, cc: ['zed@example.org'] })).json
    expect(replaced.cc).toBe('zed@example.org')
    // Ticking adds the people to what is there; it does not bring back what the replacement took off.
    expect((await edit(h, replaced, { rev: replaced.rev, copyEveryone: true })).json.cc).toBe(
      'zed@example.org, maryjo@example.com, bob@example.com',
    )
  })

  test('a draft with a Cc and no copy-everyone edit is left as it is when only its words change', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { cc: ['ann@example.org'] })).json
    const words = (await edit(h, made, { rev: made.rev, body: 'Other words.' })).json
    expect(words).toMatchObject({ cc: 'ann@example.org', body: 'Other words.' })
  })
})

describe('changing the Cc is an edit of the draft', () => {
  test('replaces the list, [] takes every address off, and each change raises the revision', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h)).json
    expect(made).toMatchObject({ cc: '', rev: 0 })
    const one = (
      await edit(h, made, { rev: made.rev, cc: ['Ann@example.org', 'ann@example.org', 'dana@example.com', TESSA] })
    ).json
    expect(one).toMatchObject({ cc: 'ann@example.org', rev: 1 })
    const two = (await edit(h, one, { rev: one.rev, cc: ['bob@example.net', 'ann@example.org'] })).json
    expect(two).toMatchObject({ cc: 'bob@example.net, ann@example.org', rev: 2 })
    expect((await edit(h, two, { rev: two.rev, cc: [] })).json).toMatchObject({ cc: '', rev: 3 })
  })

  test('is refused for an edit made over an older revision, and for a malformed address or a Cc on a text, each leaving the draft as it was', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h)).json
    const one = (await edit(h, made, { rev: made.rev, cc: ['ann@example.org'] })).json
    const before = snapshot(h)
    expect((await edit(h, made, { rev: made.rev, cc: ['bob@example.net'] })).status).toBe(409)
    for (const cc of [['nobody'], ['ann@example.org', 'a@b'], 'ann@example.org', [7]]) {
      expect((await edit(h, one, { rev: one.rev, cc: cc as never })).status, JSON.stringify(cc)).toBe(422)
    }
    expect(snapshot(h)).toBe(before)

    const text = (await ownerRequest(h, 'POST', '/api/drafts', { address: '+14155550123', body: 'Hi' })).json
    const refused = await edit(h, text, { rev: text.rev, cc: ['ann@example.org'] })
    expect(refused.status).toBe(422)
    expect(refused.json.error).toContain('Only an email draft can have a Cc')
    expect(row(h, text.id)).toMatchObject({ cc_header: '', rev: text.rev })
  })

  test('is audited as the edit it is, by whoever made it', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, {}, AGENT)).json
    const changed = (await edit(h, made, { rev: made.rev, cc: ['ann@example.org'] })).json
    expect(changed.updatedBy).toBe(OWNER.email)
    const audit = (
      (await ownerRequest(h, 'GET', '/api/audit')).json as {
        action: string
        actor: string
        after: { cc: string } | null
      }[]
    ).filter((a) => a.action === 'draft.update')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: OWNER.email, after: { cc: 'ann@example.org' } })
  })

  test('voids Tessa’s "send it" given before it: Claude’s send is refused at the old revision and, at the new one, until he says it again', async () => {
    const h = harness()
    await live(h, group(h))
    expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200)
    const made = (await reply(h, {}, AGENT)).json
    h.tick()
    const said = { ...SAID, at: new Date(h.now()).toISOString() }
    h.tick()
    // Tessa adds someone to the Cc after he said it.
    const changed = (await edit(h, made, { rev: made.rev, cc: ['ann@example.org'] })).json
    const through = (await detail(h, 't1')).through
    const stale = await h.request(AGENT, 'POST', `/api/drafts/${made.id}/send`, {
      rev: made.rev,
      through,
      instruction: said,
    })
    expect(stale.status).toBe(409)
    const before = snapshot(h)
    const refused = await h.request(AGENT, 'POST', `/api/drafts/${made.id}/send`, {
      rev: changed.rev,
      through,
      instruction: said,
    })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('after Tessa gave the instruction')
    expect(sent(h)).toHaveLength(0)
    expect(snapshot(h)).toBe(before)

    // Shown the draft with the new Cc, he says it again, and it goes to everyone on it.
    h.tick()
    const anew = { ...SAID, at: new Date(h.now()).toISOString() }
    const ok = await h.request(AGENT, 'POST', `/api/drafts/${made.id}/send`, {
      rev: changed.rev,
      through,
      instruction: anew,
    })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(sent(h)).toHaveLength(1)
  })
})

describe('a send delivers the Cc', () => {
  test('through Gmail, to the addresses on the draft and nobody else, and the Cc is kept on the sent message', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { cc: ['ann@example.org', 'Cy <cy@example.net>'] })).json
    const res = await as(h, OWNER, 'POST', `/api/drafts/${made.id}/send`, {
      rev: made.rev,
      through: (await detail(h, 't1')).through,
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(sent(h)).toHaveLength(1)
    const out = sent(h)[0]
    expect(out?.headers.To).toBe('dana@example.com')
    expect(
      (out?.headers.Cc ?? '')
        .split(',')
        .map((a) => a.trim())
        .sort(),
    ).toEqual(['ann@example.org', 'cy@example.net'])
    expect(row(h, made.id)).toMatchObject({ status: 'sent', cc_header: 'ann@example.org, cy@example.net' })
  })

  test('a draft whose Cc names the sending address is not sent by a stored row either: the send refuses it, as before', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { cc: ['ann@example.org'] })).json
    h.db.query(`UPDATE message SET cc_header = ? WHERE id = ?`).run(TESSA, made.id)
    const res = await as(h, OWNER, 'POST', `/api/drafts/${made.id}/send`, {
      rev: made.rev,
      through: (await detail(h, 't1')).through,
    })
    expect(res.status).toBe(422)
    expect(res.json.error).toContain('is your own address')
    expect(sent(h)).toHaveLength(0)
  })
})

describe('what a draft shows of its Cc', () => {
  test('a draft as Claude lists it carries the Cc as a string, so Claude sees what it set', async () => {
    const h = harness()
    await live(h, group(h))
    const made = (await reply(h, { cc: ['ann@example.org'] }, AGENT)).json as MessageRow
    const listed = (await h.request(AGENT, 'GET', '/api/drafts')).json as MessageRow[]
    expect(listed.find((d) => d.id === made.id)).toMatchObject({ cc: 'ann@example.org' })
  })
})
