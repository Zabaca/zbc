import { describe, expect, test } from 'bun:test'
import { draftEditedBy } from '../src/types'

/**
 * The one rule of the old conversation tests that is the inbox's and not a screen's (the rest tested the inbox's page, which is gone):
 * who changed a draft's words when that is not who wrote it. The space shows it as "Claude's draft, edited by you".
 */
describe('who edited a draft', () => {
  test('a draft reads as edited only when its revision moved and somebody other than its author last updated it', () => {
    expect(draftEditedBy('agent:abc', 'agent:abc', 0)).toBeNull()
    expect(draftEditedBy('agent:abc', 'tessa@northfield.example', 0)).toBeNull()
    expect(draftEditedBy('agent:abc', 'tessa@northfield.example', 1)).toBe('owner')
    expect(draftEditedBy('agent:abc', 'agent:abc', 3)).toBeNull()
    expect(draftEditedBy('tessa@northfield.example', 'agent:abc', 2)).toBe('claude')
    expect(draftEditedBy('outbox', 'tessa@northfield.example', 1)).toBe('owner')
  })
})
