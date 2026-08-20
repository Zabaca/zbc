import { expect, test } from 'bun:test'
// Deliberate failure, pushed to a throwaway branch to prove core-tests can go
// red. Deleted immediately after — see the run it produced.
test('the core-tests workflow can fail', () => {
  expect('red').toBe('green')
})
