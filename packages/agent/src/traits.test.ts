// The invariant worth testing is the type's promise: a trait adds instructions
// and can never add capability. Everything else here is composition mechanics.
import { expect, test } from 'bun:test'
import { coding } from './coding'
import { reviewer } from './review'
import { type Trait, caveman, committing, evidence, focused, traits, withTraits } from './traits'

const ALL = Object.values(traits)

test('a trait carries instructions and nothing else', () => {
  // The load-bearing test. If a trait could name tools, a model or a sandbox
  // setting, then stacking traits could widen an agent — and the containment
  // tests would have to be re-run per combination instead of per profile.
  for (const trait of ALL) {
    expect(Object.keys(trait).toSorted()).toEqual(['description', 'systemPrompt'])
  }
})

test('no trait is empty, and none is long enough to pay for itself by accident', () => {
  // A trait is charged on every request. It earns its place only if the
  // instruction is cheaper than the behaviour it removes; past this length that
  // stops being obvious and wants measuring.
  for (const trait of ALL) {
    expect(trait.systemPrompt.length).toBeGreaterThan(40)
    expect(trait.systemPrompt.length).toBeLessThan(700)
  }
})

test('applying none returns the profile untouched', () => {
  expect(withTraits(reviewer)).toBe(reviewer)
})

test('a string prompt becomes an array, base first', () => {
  const layered = withTraits(reviewer, caveman)
  expect(layered.systemPrompt).toEqual([reviewer.systemPrompt, caveman.systemPrompt])
})

test('a preset is appended to, never replaced', () => {
  // The preset carries its own text and cannot be concatenated with — the SDK's
  // `append` is the only correct seam, and overwriting systemPrompt here would
  // silently drop ~3,100 tokens of tested coding behaviour.
  const layered = withTraits(coding, evidence)
  expect(layered.systemPrompt).toEqual({
    type: 'preset',
    preset: 'claude_code',
    excludeDynamicSections: true,
    append: evidence.systemPrompt,
  })
})

test('traits stack in order, so a later one can override an earlier one', () => {
  const layered = withTraits(coding, evidence, focused)
  const prompt = layered.systemPrompt as { append?: string }
  expect(prompt.append).toBe(`${evidence.systemPrompt}\n\n${focused.systemPrompt}`)
})

test('layering never mutates the profile it is given', () => {
  const before = JSON.stringify(coding)
  withTraits(coding, caveman, evidence, focused, committing)
  expect(JSON.stringify(coding)).toBe(before)
})

test('an ad-hoc trait composes like a named one', () => {
  const house: Trait = { description: 'test', systemPrompt: 'Use bun, never npm.' }
  const prompt = (withTraits(coding, house).systemPrompt as { append?: string }).append
  expect(prompt).toBe(house.systemPrompt)
})

test('committing tells the agent to commit, since collect() fetches nothing otherwise', () => {
  expect(committing.systemPrompt).toContain('git add -A')
  expect(committing.systemPrompt).toContain('git commit')
  // Rewriting history or pushing would cross the boundary collect() exists to
  // keep host-side.
  expect(committing.systemPrompt).toMatch(/never push/i)
  expect(committing.systemPrompt).toMatch(/amend|force-push/i)
})

test('evidence asks for the word, not a hedge', () => {
  expect(evidence.systemPrompt).toContain('unverified')
})
