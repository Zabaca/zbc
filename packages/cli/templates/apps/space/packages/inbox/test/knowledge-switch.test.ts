import { describe, expect, test } from 'bun:test'
import { answered } from '@space/workspace'
import { type CliIo, runCli } from '../scripts/cli'
import { KNOWLEDGE_UNREAD } from '../src/assistant/assistant'
import { bundledInstall } from '../src/workspace'
import { says } from '../test-support/fake-model'
import { AGENT, AGENT_AUD, AGENT_ID, asHttp, harness, mint, OWNER, RIDGEWAY_ASSISTED } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { rawMail } from '../test-support/raw-mail'

/**
 * The switch: the knowledge base is the knowledge app's, and the inbox's part is
 * to ask it, for the conversation's business, before the assistant drafts; to refuse the turn with a sentence when it cannot be read;
 * and to hand Claude's reads and proposals on. The Worker driven as a function over a fake of the knowledge app (test-support/
 * fake-knowledge.ts). What it cannot show is the real binding, which is the live check in the runbook.
 */

type H = ReturnType<typeof harness>

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n

const withRidgeway = (options: Parameters<typeof harness>[1] = {}) =>
  harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ...options })

async function withDraft(h: H) {
  await h.deliver(rawMail('first'))
  const id = (rows<{ id: string }>(h, 'SELECT id FROM conversation')[0] as { id: string }).id
  const made = h.inbox.createDraft(
    {
      conversationId: id,
      address: 'tessa@northfield.example',
      name: 'Tessa Marlow',
      subject: 'Re: Hours question',
      body: 'Hi Tessa,\n\nWe are open Saturdays 9 to 1.\n\nTessa\nRidgeway Cycles',
      why: 'Answered the hours question.',
    },
    'assistant',
  )
  expect(made.ok).toBe(true)
  const page = (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
  return { id, draft: page.drafts[0] as { id: string; rev: number; body: string; subject: string } }
}

/** Tessa's chat turn, as the space makes it: the assistant's `chat` with the owner as the actor (what the inbox's own chat route passed it). */
const chat = async (h: H, id: string, b: Record<string, unknown>) =>
  asHttp(
    await h.store.call(
      'chat',
      id,
      {
        instruction: typeof b.instruction === 'string' ? b.instruction : '',
        draftId: typeof b.draftId === 'string' ? b.draftId : null,
        rev: b.rev,
        body: b.body,
        subject: b.subject,
      } as never,
      OWNER_EMAIL,
    ),
  )

describe('the four-second rule: when the knowledge app does not answer, the turn is refused and nothing is saved', () => {
  /** What a refused turn must leave: no model call, no cost, no change to the draft, and nothing of Tessa's typing kept. */
  async function expectNothingSaved(h: H, id: string, draft: { id: string; rev: number; body: string }) {
    expect(h.model?.requests ?? []).toHaveLength(0)
    expect(count(h, 'assistant_usage')).toBe(0)
    expect(count(h, 'draft_chat')).toBe(0)
    const after = (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json.drafts[0]
    expect(after.rev).toBe(draft.rev)
    expect(after.body).toBe(draft.body)
  }

  const asked = (draft: { id: string; rev: number }) => ({
    instruction: 'shorter',
    draftId: draft.id,
    rev: draft.rev,
    // Tessa had typed over the draft and not saved: a refused turn must not save that as his edit either.
    body: 'Hi Tessa,\n\nSaturdays 9 to 1 only, typed just now.\n\nTessa\nRidgeway Cycles',
  })

  test('a binding that throws', async () => {
    const h = withRidgeway()
    const { id, draft } = await withDraft(h)
    h.knowledge.failure = new Error('Worker not found')
    const res = await chat(h, id, asked(draft))
    expect(res.status).toBe(503)
    expect(res.json.error).toBe(KNOWLEDGE_UNREAD)
    expect(res.json.error).toBe('The knowledge base could not be read, so nothing was drafted. Ask again in a moment.')
    await expectNothingSaved(h, id, draft)
  })

  test('an app that does not answer within the wait', async () => {
    const h = withRidgeway({ knowledgeWithinMs: 20 })
    const { id, draft } = await withDraft(h)
    h.knowledge.delayMs = 300
    const res = await chat(h, id, asked(draft))
    expect(res.status).toBe(503)
    expect(res.json.error).toBe(KNOWLEDGE_UNREAD)
    await expectNothingSaved(h, id, draft)
  })

  test('an answer that is not a reply, a refusal, and a fault the app itself reports', async () => {
    for (const answer of [
      'nonsense',
      { ok: false, kind: 'refused', reason: 'not-found', message: 'No such business.' },
      { ok: false, kind: 'failed', reason: 'broken', message: 'The knowledge base could not answer that.' },
    ]) {
      const h = withRidgeway()
      const { id, draft } = await withDraft(h)
      h.knowledge.answer = answer
      const res = await chat(h, id, asked(draft))
      expect([JSON.stringify(answer), res.status, res.json.error]).toEqual([
        JSON.stringify(answer),
        503,
        KNOWLEDGE_UNREAD,
      ])
      await expectNothingSaved(h, id, draft)
    }
  })

  test('a Worker deployed without the binding', async () => {
    const h = withRidgeway({ knowledgeBound: false })
    const { id, draft } = await withDraft(h)
    const res = await chat(h, id, asked(draft))
    expect(res.status).toBe(503)
    expect(res.json.error).toBe(KNOWLEDGE_UNREAD)
    await expectNothingSaved(h, id, draft)
  })

  test('is audited as a failed call is, and asking again when the app answers works and is not remembered as empty', async () => {
    const h = withRidgeway()
    const { id, draft } = await withDraft(h)
    h.knowledge.failure = new Error('down')
    await chat(h, id, asked(draft))
    expect(rows(h, `SELECT action FROM audit WHERE action = 'assistant.chat-failed'`)).toHaveLength(1)

    h.knowledge.failure = null
    h.knowledge.seed({ title: 'Hours', body: 'Open Saturdays 9 to 1 ACTIVE-ONE.', businesses: ['ridgeway-cycles'] })
    ;(h.model as NonNullable<typeof h.model>).next(says({ note: 'Fine as it is.' }))
    const res = await chat(h, id, { instruction: 'why this wording?', draftId: draft.id, rev: draft.rev })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect((h.model as NonNullable<typeof h.model>).requests.at(-1)?.system).toContain('ACTIVE-ONE')
  })

  test('the knowledge app is asked for the conversation’s business before anything of Tessa’s is saved, and only once a turn', async () => {
    const h = withRidgeway()
    const { id, draft } = await withDraft(h)
    ;(h.model as NonNullable<typeof h.model>).next(says({ note: 'Done.' }))
    await chat(h, id, { instruction: 'why?', draftId: draft.id, rev: draft.rev })
    expect(h.knowledge.calls).toEqual([{ method: 'activeFor', args: ['ridgeway-cycles'] }])
  })
})

describe('a mailbox in no business', () => {
  test('the knowledge app is never asked about it (the prompt then says there is no knowledge base, in its existing words)', async () => {
    const h = harness({}, { mailboxes: [{ address: 'hello@northfield.example', name: 'Hello', assistant: false }] })
    // hello@northfield.example is declared as a mailbox but is in no business of the declaration.
    expect(bundledInstall.businessOf('hello@northfield.example')).toBeNull()
    await h.deliver(rawMail('first'), { to: 'hello@northfield.example' })
    const id = (rows<{ id: string }>(h, 'SELECT id FROM conversation')[0] as { id: string }).id
    const res = await chat(h, id, { instruction: 'write a reply' })
    // No persona is written for it, so the turn is refused for that; what matters here is that the knowledge app was never asked.
    expect(res.status).toBe(422)
    expect(h.knowledge.calls).toEqual([])
  })
})

describe('Claude’s commands go through the inbox to the knowledge app', () => {
  function script(h: H, bodies: string[] = []) {
    const io: CliIo = {
      env: {
        INBOX_URL: 'https://space.northfield.example',
        INBOX_ACCESS_CLIENT_ID: AGENT_ID,
        INBOX_ACCESS_CLIENT_SECRET: 's',
      },
      sopsKey: () => '',
      readInput: async (spec) => spec,
      fetch: async (url, init) => {
        if (typeof init.body === 'string') bodies.push(init.body)
        const headers = new Headers(init.headers)
        headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
        return h.app.request(url, { ...init, headers }, h.env)
      },
    }
    return async (...argv: string[]) => {
      const done = await runCli(argv, io)
      return {
        ...done,
        json: done.output.startsWith('{') || done.output.startsWith('[') ? JSON.parse(done.output) : null,
      }
    }
  }

  test('`knowledge` reads all of the base, or one business’s entries, and says the businesses', async () => {
    const h = withRidgeway()
    h.knowledge.seed({ title: 'Pricing', body: 'A tune-up is $40.', businesses: ['ridgeway-cycles'] })
    h.knowledge.seed({ title: 'Plans', body: 'A site starts at $2,400.', businesses: ['northfield'] })
    const run = script(h)

    const all = await run('knowledge')
    expect(all.exitCode, all.output).toBe(0)
    expect(all.json.business).toBeNull()
    expect(all.json.businesses.map((b: { id: string }) => b.id)).toEqual(['northfield', 'ridgeway-cycles', 'shiftlantern'])
    expect(all.json.entries.map((e: { title: string }) => e.title)).toEqual(['Pricing', 'Plans'])

    const one = await run('knowledge', 'northfield')
    expect(one.json.business).toBe('northfield')
    expect(one.json.entries.map((e: { title: string }) => e.title)).toEqual(['Plans'])
    expect(h.knowledge.calls.at(-1)).toEqual({ method: 'readBase', args: ['northfield'] })

    const unknown = await run('knowledge', 'nobody')
    expect(unknown.exitCode).toBe(1)
    expect(unknown.output).toContain('404')
  })

  test('`propose-knowledge` arrives with Claude as the proposer and the businesses it names', async () => {
    const h = withRidgeway()
    const bodies: string[] = []
    const run = script(h, bodies)
    const done = await run(
      'propose-knowledge',
      JSON.stringify({ title: 'Parking', body: 'Free parking.', businesses: ['ridgeway-cycles', 'shiftlantern'] }),
    )
    expect(done.exitCode, done.output).toBe(0)
    expect(done.json).toMatchObject({
      status: 'proposed',
      proposedBy: `agent:${AGENT_ID}`,
      businesses: ['ridgeway-cycles', 'shiftlantern'],
    })
    expect(h.knowledge.calls.at(-1)).toEqual({
      method: 'propose',
      args: [
        `agent:${AGENT_ID}`,
        { title: 'Parking', body: 'Free parking.', businesses: ['ridgeway-cycles', 'shiftlantern'] },
      ],
    })
    // Nothing reads it yet: the assistants' view of the base is still empty.
    expect((await h.knowledge.activeFor('ridgeway-cycles')).ok).toBe(true)
    expect(await h.knowledge.activeFor('ridgeway-cycles')).toEqual(answered([]))
  })

  test('a refusal of the knowledge app comes back in its words and its status', async () => {
    const h = withRidgeway()
    const run = script(h)
    const done = await run('propose-knowledge', JSON.stringify({ title: 'Nothing', body: 'No business.' }))
    expect(done.exitCode).toBe(1)
    expect(done.output).toContain('422')
    expect(done.output).toContain('A new entry needs a title, a body and a business.')
  })

  test('with the app down it says so and nothing was changed (a 502, not a hang)', async () => {
    const h = withRidgeway({ knowledgeWithinMs: 20 })
    h.knowledge.failure = new Error('down')
    const done = await script(h)('knowledge')
    expect(done.exitCode).toBe(1)
    expect(done.output).toContain('502')
    expect(done.output).toContain('The knowledge app could not be reached. Nothing was changed.')
    const unbound = withRidgeway({ knowledgeBound: false })
    expect((await script(unbound)('knowledge')).output).toContain('502')
  })

  test('only Claude proposes here: a person is refused at the door, and the inbox has no route that changes an entry any more', async () => {
    const h = withRidgeway()
    const body = { title: 'Parking', body: 'Free parking.', businesses: ['ridgeway-cycles'] }
    expect((await h.request(OWNER, 'POST', '/api/knowledge/propose', body)).status).toBe(403)
    expect(h.knowledge.calls).toEqual([])
    // None of these exist: Tessa changes entries in the space's Knowledge tab.
    for (const [method, path] of [
      ['POST', '/api/knowledge'],
      ['PATCH', '/api/knowledge/kb-1'],
      ['DELETE', '/api/knowledge/kb-1?version=1'],
      ['POST', '/api/knowledge/kb-1/approve'],
      ['POST', '/api/knowledge/kb-1/restore'],
      ['POST', '/api/knowledge/kb-1/reject'],
      ['POST', '/api/import/knowledge'],
    ] as const) {
      const res = await h.request(
        AGENT,
        method,
        path,
        method === 'POST' || method === 'PATCH' ? { version: 1 } : undefined,
      )
      expect([method, path, res.status === 200 || res.status === 201]).toEqual([method, path, false])
    }
    expect(h.knowledge.calls).toEqual([])
  })

  test('the script has no import-knowledge command, and its help names the Knowledge tab and the businesses', async () => {
    const h = withRidgeway()
    const help = await script(h)()
    expect(help.output).not.toContain('import-knowledge')
    expect(help.output).toContain('Knowledge tab of the space')
    expect(help.output).toContain('knowledge [business-id]')
    const carried = await script(h)('import-knowledge', '{}')
    expect(carried.exitCode).toBe(1)
  })
})

describe('the inbox’s old knowledge tables', () => {
  test('the inbox’s store keeps its old per-mailbox knowledge tables as they were, read by nothing', () => {
    const h = harness()
    expect(count(h, 'knowledge_entry')).toBe(0)
    expect(count(h, 'knowledge_version')).toBe(0)
  })
})
