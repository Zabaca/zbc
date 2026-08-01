// A profile must not be able to quietly undo the base module's levers — that is
// the whole reason profiles compose through minimalOptions() instead of
// building an Options object of their own.
import { expect, test } from 'bun:test'
import { profileOptions, profiles } from './profiles'

test('a profile keeps every base lever', () => {
  const o = profileOptions('caveman')
  expect(o.tools).toEqual([])
  expect(o.settingSources).toEqual([])
  expect(o.thinking).toEqual({ type: 'disabled' })
  expect(o.strictMcpConfig).toBe(true)
  expect(o.settings).toMatchObject({ autoMemoryEnabled: false, disableClaudeAiConnectors: true })
  expect(o.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
})

test('overrides beat the profile', () => {
  const o = profileOptions('caveman', { tools: ['Read'], model: 'claude-sonnet-5' })
  expect(o.tools).toEqual(['Read'])
  expect(o.model).toBe('claude-sonnet-5')
  expect(o.systemPrompt).toBe(profiles.caveman.systemPrompt) // profile survives
})

test('description is metadata, never sent', () => {
  // It exists to help a human pick a profile; shipping it would be dead tokens.
  const o = profileOptions('caveman')
  expect(JSON.stringify(o)).not.toContain(profiles.caveman.description)
})

test('the prompt stays short enough to pay for itself', () => {
  // Paid on every request. Measured: +80 input tokens buys -229 output.
  // If this grows past ~600 chars, re-measure before shipping it.
  const p = profiles.caveman.systemPrompt
  expect(typeof p).toBe('string')
  expect((p as string).length).toBeLessThan(600)
})
