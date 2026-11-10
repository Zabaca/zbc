import { describe, expect, test } from 'bun:test'
import { API_VERSION, MESSAGES_URL, ModelError, modelOverFetch } from '../src/assistant/model'
import { costUsd } from '../src/assistant/pricing'
import { buildChatRequest } from '../src/assistant/prompt'
import { parseDeclared } from '../src/cloudflare/declared'
import { personaFor } from '../test-support/content'
import { harness, RIDGEWAY, RIDGEWAY_ASSISTED } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * The network call to the model, over a fake `fetch`: what is sent (the key where only the API reads it, the forced tool, nothing
 * of the key anywhere else), how a reply is read (its usage, its tool call), and what each way a call can go wrong says. NOT
 * evidence about Anthropic: that the real API accepts this request, and what it answers, is the live check.
 */

const KEY = 'sk-ant-test-key-do-not-leak'
const request = buildChatRequest({
  mailboxAddress: 'info@ridgewaycycles.example',
  persona: personaFor('info@ridgewaycycles.example') as NonNullable<ReturnType<typeof personaFor>>,
  subject: 'Hours',
  participant: { address: 'a@x.test', name: 'A' },
  thread: [{ direction: 'in', from: 'a@x.test', at: 't', body: 'When are you open?' }],
  ownerName: 'Tessa',
  knowledge: [],
  draft: '',
  history: [],
  instruction: 'Write a reply',
})

function fetching(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    send: async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return respond(url, init)
    },
  }
}

describe('the model over fetch', () => {
  test('one POST to the messages endpoint with the key as x-api-key, the version, and the request as JSON', async () => {
    const fake = fetching(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'ignored' },
              { type: 'tool_use', name: 'respond', input: { note: 'x' } },
            ],
            usage: { input_tokens: 812, output_tokens: 95, cache_read_input_tokens: 0 },
          }),
          { status: 200 },
        ),
    )
    const reply = await modelOverFetch(fake.send, KEY).complete(request)
    expect(reply).toEqual({ toolInput: { note: 'x' }, usage: { inputTokens: 812, outputTokens: 95 } })
    expect(fake.calls).toHaveLength(1)
    const [call] = fake.calls
    expect(call?.url).toBe(MESSAGES_URL)
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call?.init.method).toBe('POST')
    expect(call?.init.headers).toEqual({
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
      'x-api-key': KEY,
    })
    // The body is the request, and it carries no credential and no Claude Code identity block.
    expect(JSON.parse(call?.init.body as string)).toEqual(JSON.parse(JSON.stringify(request)))
    expect(call?.init.body as string).not.toContain(KEY)
    expect(call?.init.body as string).not.toContain('Claude Code')
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('a reply with no tool call, no usage or an odd one is read as what it is, never as a throw of its own', async () => {
    const none = fetching(
      () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 }),
    )
    expect(await modelOverFetch(none.send, KEY).complete(request)).toEqual({
      toolInput: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const odd = fetching(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'tool_use', input: {} }],
            usage: { input_tokens: -5, output_tokens: 'many' },
          }),
          {
            status: 200,
          },
        ),
    )
    expect((await modelOverFetch(odd.send, KEY).complete(request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  test('an HTTP error carries its status and a short line, and never the key', async () => {
    const fake = fetching(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
          status: 529,
        }),
    )
    const error = await modelOverFetch(fake.send, KEY)
      .complete(request)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).status).toBe(529)
    expect((error as ModelError).message).toContain('529')
    expect((error as ModelError).message).toContain('Overloaded')
    expect((error as ModelError).message).not.toContain(KEY)

    const refused = fetching(() => new Response(`bad key ${'x'.repeat(2000)}`, { status: 401 }))
    const long = (await modelOverFetch(refused.send, KEY)
      .complete(request)
      .catch((e: unknown) => e)) as ModelError
    expect(long.status).toBe(401)
    expect(long.message.length).toBeLessThan(400)
  })

  test('no answer at all (a dropped connection, a timeout) is a failure with no status, and a body that is not JSON is one too', async () => {
    const dropped = fetching(() => Promise.reject(new Error('connection reset')))
    const a = (await modelOverFetch(dropped.send, KEY)
      .complete(request)
      .catch((e: unknown) => e)) as ModelError
    expect(a).toBeInstanceOf(ModelError)
    expect(a.status).toBeNull()
    expect(a.message).toContain('connection reset')
    expect(a.message).not.toContain(KEY)

    const html = fetching(() => new Response('<html>gateway</html>', { status: 200 }))
    const b = (await modelOverFetch(html.send, KEY)
      .complete(request)
      .catch((e: unknown) => e)) as ModelError
    expect(b).toBeInstanceOf(ModelError)
    expect(b.message).toContain('not JSON')
  })
})

describe('the estimate of what tokens cost', () => {
  test('is the list rate for the model, and unknown for a model with no rate here', () => {
    expect(costUsd('claude-sonnet-5', 1_000_000, 1_000_000)).toBe(12)
    expect(costUsd('claude-sonnet-5', 1200, 180)).toBeCloseTo(0.0042, 10)
    expect(costUsd('some-other-model', 1, 1)).toBeNull()
  })
})

describe('the declaration says whether the spam check runs, until Tessa decides', () => {
  const entry = { address: 'info@ridgewaycycles.example', name: 'Ridgeway Cycles' }

  test('absent is off, true is on, and anything else is refused, so a typo is a refusal and not a guess', () => {
    expect(parseDeclared([entry], OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [{ ...entry, domain: 'ridgewaycycles.example' }],
    })
    expect(parseDeclared([{ ...entry, assistant: false }], OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [{ ...entry, domain: 'ridgewaycycles.example' }],
    })
    expect(parseDeclared([{ ...entry, assistant: true }], OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [{ ...entry, domain: 'ridgewaycycles.example', assistant: true }],
    })
    for (const bad of ['yes', 1, null, 'true']) {
      const declared = parseDeclared([{ ...entry, assistant: bad }], OWNER_EMAIL)
      expect(declared.ok).toBe(false)
    }
  })

  test('a mailbox row follows the declaration until a person switches it, then never again, and the audit says each', () => {
    const h = harness({}, { mailboxes: [RIDGEWAY] })
    const row = h.inbox.cloudflareMailbox(RIDGEWAY)
    expect(row).toMatchObject({ assistant: false, assistantSetBy: null })
    // A redeploy that turns it on is followed, because nobody has decided otherwise.
    expect(h.inbox.cloudflareMailbox(RIDGEWAY_ASSISTED)).toMatchObject({ assistant: true, assistantSetBy: null })
    // Then Tessa switches it off: his word stands against the declaration.
    expect(h.inbox.setAssistant(row.id, false, 'tessa@northfield.example')).toMatchObject({ ok: true })
    expect(h.inbox.cloudflareMailbox(RIDGEWAY_ASSISTED)).toMatchObject({
      assistant: false,
      assistantSetBy: 'tessa@northfield.example',
    })
    const audit = h.inbox.listAudit(50).map((a) => a.action)
    expect(audit).toContain('mailbox.assistant-declared')
    expect(audit).toContain('mailbox.assistant')
    // Claude cannot, and Gmail's row has none to switch.
    expect(h.inbox.setAssistant(row.id, true, 'agent:abc')).toMatchObject({ ok: false, status: 403 })
    expect(h.inbox.setAssistant('nope', true, 'tessa@northfield.example')).toMatchObject({ ok: false, status: 404 })
  })
})
