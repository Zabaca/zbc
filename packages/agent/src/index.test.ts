// These assert the token levers, not the SDK. A change that quietly reinstates
// tool schemas or settings loading costs ~20k input tokens per call and nothing
// else in the repo would notice, so the defaults are pinned here deliberately.
import { expect, test } from 'bun:test'
import { DEFAULT_MODEL, minimalOptions } from './index'

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
  expect(minimalOptions().settings).toEqual({ autoMemoryEnabled: false })
  expect(minimalOptions({ autoMemory: true }).settings).toEqual({ autoMemoryEnabled: true })
})

test('thinking can be restored for agents that reason', () => {
  expect(minimalOptions({ thinking: { type: 'adaptive' } }).thinking).toEqual({ type: 'adaptive' })
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
