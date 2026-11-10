import { describe, expect, test } from 'bun:test'
import { classifyAddress } from '../src/store/address'

/**
 * One spelling per address. Two spellings of the same address are two contacts
 * who are one person, so every row here is a way the Outbox's address field, or a
 * session drafting, has spelled or could spell something.
 */

const table: [string, ReturnType<typeof classifyAddress>][] = [
  ['dana@example.com', { kind: 'email', address: 'dana@example.com' }],
  ['  Dana@Example.COM ', { kind: 'email', address: 'dana@example.com' }],
  ['Dana Reyes <Dana@Example.com>', { kind: 'email', address: 'dana@example.com' }],
  ['<dana@example.com>', { kind: 'email', address: 'dana@example.com' }],
  ['dana+menu@shop.example.org', { kind: 'email', address: 'dana+menu@shop.example.org' }],
  ['(626) 555-0142', { kind: 'sms', address: '+16265550142' }],
  ['626-555-0142', { kind: 'sms', address: '+16265550142' }],
  ['626.555.0142', { kind: 'sms', address: '+16265550142' }],
  ['+1 626 555 0142', { kind: 'sms', address: '+16265550142' }],
  ['1-626-555-0142', { kind: 'sms', address: '+16265550142' }],
  ['+44 20 7946 0958', { kind: 'sms', address: '+442079460958' }],
  ['@priya_n', { kind: 'manual', address: '@priya_n' }],
  ['  @Priya_N ', { kind: 'manual', address: '@priya_n' }],
  ['Abel   at the   print shop', { kind: 'manual', address: 'abel at the print shop' }],
  // Too short or too long to be a number, and no @: a handle or a name.
  ['12345', { kind: 'manual', address: '12345' }],
  ['1234567890123456', { kind: 'manual', address: '1234567890123456' }],
  // An @ with nothing usable around it is not an address.
  ['dana@', { kind: 'manual', address: 'dana@' }],
  ['dana@example', { kind: 'manual', address: 'dana@example' }],
  ['', null],
  ['   ', null],
]

describe('classifyAddress', () => {
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)}`, () => {
      expect(classifyAddress(input)).toEqual(expected)
    })
  }
})
