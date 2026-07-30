import { expect, test } from 'bun:test'
import { parseInstances } from './wrangler'

// wrangler prints progress and banner lines around its JSON, and those lines can
// themselves contain brackets. Anything that fails to parse must be visibly a
// failure, never an empty list, because "none running" is a lie a reader believes.

const PAYLOAD = `[
  {"id":"18200440edded555","name":"warehouse","state":"running","location":"sjc01","created_at":"2026-07-29T09:11:08Z"}
]`

test('parses a clean JSON payload', () => {
  const out = parseInstances(PAYLOAD)
  expect(out).toEqual([
    {
      id: '18200440edded555',
      name: 'warehouse',
      state: 'running',
      location: 'sjc01',
      created: '2026-07-29T09:11:08Z',
    },
  ])
})

test('parses through leading and trailing wrangler chatter', () => {
  const noisy = ` ⛅️ wrangler 4.42.0\n-------------------\n${PAYLOAD}\nDone.\n`
  expect(parseInstances(noisy).map((i) => i.name)).toEqual(['warehouse'])
})

test('survives a bracket in the chatter before the payload', () => {
  // A spinner or a bracketed timestamp ahead of the JSON moves the first `[`.
  const noisy = `[2026-07-29 09:11:08] fetching instances\n${PAYLOAD}\n`
  expect(parseInstances(noisy).map((i) => i.name)).toEqual(['warehouse'])
})

test('tolerates the alternative field names wrangler has used', () => {
  const alt = `[{"instance_id":"abc","name":"x","status":"stopped","created":"2026-07-01"}]`
  expect(parseInstances(alt)).toEqual([
    { id: 'abc', name: 'x', state: 'stopped', location: '-', created: '2026-07-01' },
  ])
})

test('a genuinely empty list is empty', () => {
  expect(parseInstances('[]')).toEqual([])
  expect(parseInstances('no instances found\n[]\n')).toEqual([])
})

test('unparseable output throws rather than reporting "none running"', () => {
  // No brackets at all, and a bracket with no closer: nothing to even attempt.
  expect(() => parseInstances('Error: application not found')).toThrow(/no JSON/)
  expect(() => parseInstances('[unterminated')).toThrow(/no JSON/)
  // A bracketed span that is not JSON: attempted, and reported as unparseable.
  expect(() => parseInstances('[not json at all]')).toThrow(/could not parse/)
  // Valid JSON, wrong shape.
  expect(() => parseInstances('{"instances": "x"}')).toThrow(/no JSON/)
})
