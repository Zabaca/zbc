// These assert the token levers, not the SDK. A change that quietly reinstates
// tool schemas or settings loading costs ~20k input tokens per call and nothing
// else in the repo would notice, so the defaults are pinned here deliberately.
import { expect, test } from 'bun:test'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_MODEL, minimalOptions, run } from './index'

test('defaults strip every lever that costs tokens', () => {
  const o = minimalOptions()
  expect(o.tools).toEqual([])
  expect(o.settingSources).toEqual([])
  expect(o.mcpServers).toEqual({})
  expect(o.strictMcpConfig).toBe(true)
  expect(o.thinking).toEqual({ type: 'disabled' })
  expect(o.model).toBe(DEFAULT_MODEL)
})

test('auto-memory is off, and via inline settings rather than a file', () => {
  // `settingSources: []` does not suppress auto-memory, so this is the only
  // thing keeping the operator's memory index out of every request.
  expect(minimalOptions().settings).toMatchObject({ autoMemoryEnabled: false })
  expect(minimalOptions({ autoMemory: true }).settings).toMatchObject({ autoMemoryEnabled: true })
})

test('claude.ai connectors are off — the inverted name is easy to get backwards', () => {
  // The setting is disableClaudeAiConnectors, so the option must be negated.
  expect(minimalOptions().settings).toMatchObject({ disableClaudeAiConnectors: true })
  expect(minimalOptions({ claudeAiConnectors: true }).settings).toMatchObject({
    disableClaudeAiConnectors: false,
  })
})

test('thinking can be restored for agents that reason', () => {
  expect(minimalOptions({ thinking: { type: 'adaptive' } }).thinking).toEqual({ type: 'adaptive' })
})

test('attribution block is off, without clobbering the subprocess environment', () => {
  // `env` replaces rather than merges, so losing PATH here means the
  // subprocess never starts — a failure that would not look like a token bug.
  const env = minimalOptions().env
  expect(env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  expect(env?.PATH).toBe(process.env.PATH)

  const on = minimalOptions({ attribution: true }).env
  expect('CLAUDE_CODE_ATTRIBUTION_HEADER' in (on ?? {})).toBe(false)
  expect(on?.PATH).toBe(process.env.PATH)
})

test('non-essential traffic is off — ten outbound requests become two', () => {
  expect(minimalOptions().env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  const on = minimalOptions({ nonessentialTraffic: true }).env
  expect('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in (on ?? {})).toBe(false)
})

test('no systemPrompt key unless asked for, so the SDK sends its own', () => {
  // Passing `systemPrompt: undefined` explicitly would still create the key and
  // is not the same thing to the SDK as omitting it.
  expect('systemPrompt' in minimalOptions()).toBe(false)
  expect('systemPrompt' in minimalOptions({ systemPrompt: 'You sort tickets.' })).toBe(true)
})

test('tools are opt-in by name', () => {
  expect(minimalOptions({ tools: ['Read', 'Grep'] }).tools).toEqual(['Read', 'Grep'])
})

test('CLAUDE.md can be restored without giving up the other levers', () => {
  const o = minimalOptions({ settingSources: ['project'] })
  expect(o.settingSources).toEqual(['project'])
  expect(o.tools).toEqual([])
  expect(o.strictMcpConfig).toBe(true)
})

test('abortController is absent unless given — the SDK has no signal option', () => {
  expect('abortController' in minimalOptions()).toBe(false)
  const controller = new AbortController()
  expect(minimalOptions({ abortController: controller }).abortController).toBe(controller)
})

// A fake query: the stream shape is all `run` depends on.
function fakeQuery(messages: unknown[]): typeof query {
  return async function* () {
    for (const m of messages) yield m
  } as unknown as typeof query
}

const assistant = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const result = (extra: Record<string, unknown>) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {},
  session_id: 'sess-1',
  ...extra,
})

test('run concatenates the text and returns the result fields', async () => {
  const out = await run('hi', minimalOptions(), {
    query: fakeQuery([assistant('a'), assistant(' b '), result({})]),
  })
  expect(out.text).toBe('a b')
  expect(out.turns).toBe(1)
  expect(out.stopReason).toBe('success')
  expect(out.isError).toBe(false)
  expect(out.errors).toEqual([])
  expect(out.usage?.input_tokens).toBe(10)
  expect(out.totalCostUsd).toBe(0.001)
  expect(out.sessionId).toBe('sess-1')
})

test('an error result is reported, not thrown — the caller classifies it', async () => {
  const out = await run('hi', minimalOptions(), {
    query: fakeQuery([
      result({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }),
    ]),
  })
  expect(out.isError).toBe(true)
  expect(out.stopReason).toBe('error_during_execution')
  expect(out.errors).toEqual(['boom'])
})

test('a stream with no result message is an error with an unknown stop reason', async () => {
  const out = await run('hi', minimalOptions(), { query: fakeQuery([assistant('x')]) })
  expect(out.text).toBe('x')
  expect(out.isError).toBe(true)
  expect(out.stopReason).toBe('unknown')
  expect(out.usage).toBeUndefined()
})

test('onMessage sees every message, including the ones run ignores', async () => {
  const seen: string[] = []
  await run('hi', minimalOptions(), {
    query: fakeQuery([
      { type: 'system' },
      { type: 'rate_limit_event' },
      assistant('x'),
      result({}),
    ]),
    onMessage: (m) => seen.push(m.type),
  })
  expect(seen).toEqual(['system', 'rate_limit_event', 'assistant', 'result'])
})
