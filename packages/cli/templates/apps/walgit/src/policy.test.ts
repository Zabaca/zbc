/**
 * How a limit is read, and how it is said.
 *
 * Both functions are in `shared/` because the half that enforces a cap and the
 * half that advertises it are different processes, and this is the pair that
 * makes them agree. So the tests are written against the two ways they used to
 * disagree: three copies of `positiveNumber` with two different return types,
 * and two copies of `describeBytes` kept identical by hand.
 */
import { describe, expect, test } from 'bun:test'

import { describeBytes, positiveNumber } from '../shared/policy'

describe('positiveNumber', () => {
  test('reads a configured limit', () => {
    expect(positiveNumber('100')).toBe(100)
    expect(positiveNumber(' 24 ')).toBe(24)
    expect(positiveNumber('0.5')).toBe(0.5)
  })

  // Every one of these used to be spelled two ways, and a page that printed
  // `NaN MiB` for a typo'd variable is worse than one that claims nothing.
  test('anything that is not a positive number is unset, never zero', () => {
    expect(positiveNumber(undefined)).toBeNull()
    expect(positiveNumber('')).toBeNull()
    expect(positiveNumber('   ')).toBeNull()
    expect(positiveNumber('banana')).toBeNull()
    expect(positiveNumber('0')).toBeNull()
    expect(positiveNumber('-5')).toBeNull()
    expect(positiveNumber('Infinity')).toBeNull()
  })
})

describe('describeBytes', () => {
  test('gives both a unit and the raw count', () => {
    expect(describeBytes(512)).toBe('512 bytes')
    expect(describeBytes(103809024)).toBe('99 MiB (103809024 bytes)')
    expect(describeBytes(2 * 1024 ** 3)).toBe('2 GiB (2147483648 bytes)')
  })
})
