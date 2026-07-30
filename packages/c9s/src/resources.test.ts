import { expect, test } from 'bun:test'
import { suggest } from './resources'

// A stand-in for the project list the app has already loaded, in no useful order.
const PROJECTS = ['zbc-inbox', 'tour-guide', 'warehouse', 'zbc-nats', 'agent-canvas']

test('suggests a project name for the argument of :proj', () => {
  // `tour-guide` is the only project starting with `tour`, so the ghost text is
  // exactly the rest of it.
  expect(suggest('proj tour', PROJECTS)).toEqual({
    completion: '-guide',
    candidates: ['tour-guide'],
  })
})

test('offers no suggestion for text matching no project', () => {
  expect(suggest('proj nope', PROJECTS)).toEqual({ completion: '', candidates: [] })
})

test('offers `all` after :proj, since it is what clears the scope', () => {
  // Bare `:proj ` lists everything it could be; `all` is an accepted value of the
  // input, so it belongs in the list even though it is not a project.
  expect(suggest('proj a', PROJECTS).candidates).toEqual(['agent-canvas', 'all'])
})

test('caps the candidate line so it cannot wrap the fixed-height prompt', () => {
  const many = Array.from({ length: 12 }, (_, i) => `p${i}-svc`)
  const { candidates } = suggest('proj p', many)
  // Eight names plus one overflow marker accounting for the remaining four.
  expect(candidates).toEqual([...many.slice(0, 8), '+4 more'])
})
