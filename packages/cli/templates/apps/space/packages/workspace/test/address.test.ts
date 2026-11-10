import { describe, expect, test } from 'bun:test'
import { ADDRESS_MAX, normalizeAddress } from '../src'

describe('the one spelling of an address', () => {
  test('lowercases and trims', () => {
    expect(normalizeAddress('Corin@Example.COM')).toBe('corin@example.com')
    expect(normalizeAddress('  c@x.example.com \n')).toBe('c@x.example.com')
  })

  test('takes the address out of a display name, as the inbox does', () => {
    expect(normalizeAddress('Corin Pike <Corin@X.example.com>')).toBe('corin@x.example.com')
    expect(normalizeAddress('"Lane, Corin" <c@x.example.com>')).toBe('c@x.example.com')
    expect(normalizeAddress('<c@x.example.com>')).toBe('c@x.example.com')
  })

  test('folds nothing but case: dots and plus tags are different addresses', () => {
    expect(normalizeAddress('a.b@gmail.com')).not.toBe(normalizeAddress('ab@gmail.com'))
    expect(normalizeAddress('a+x@gmail.com')).toBe('a+x@gmail.com')
  })

  test('the three stores agree on the same person written three ways', () => {
    const inbox = 'Tessa Marlow <Tessa@Northfield.example>'
    const meet = 'tessa@northfield.example'
    const declaration = ' TESSA@northfield.example'
    expect(new Set([inbox, meet, declaration].map(normalizeAddress)).size).toBe(1)
  })

  test('is null for anything that is not an email address, and never throws', () => {
    for (const raw of ['', '   ', '+16265550100', '@handle', 'no at sign', 'a@b', 'a b@c.example.com', 'two@@x.example.com', null, undefined, 7, {}]) {
      expect([raw, normalizeAddress(raw)]).toEqual([raw, null])
    }
  })

  test('refuses an address longer than the limit', () => {
    const local = 'a'.repeat(ADDRESS_MAX - '@x.example.com'.length)
    expect(normalizeAddress(`${local}@x.example.com`)).toBe(`${local}@x.example.com`)
    expect(normalizeAddress(`${local}a@x.example.com`)).toBeNull()
  })

  test('is its own fixed point', () => {
    const once = normalizeAddress('Corin <C@X.example.com>')
    expect(normalizeAddress(once)).toBe(once)
  })
})
