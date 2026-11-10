import { describe, expect, test } from 'bun:test'
import { isFileRange, parseByteRange, resolveByteRange } from '../src/files'

describe('a byte range, as a request names it and as a file of a length answers it', () => {
  test('bytes=a-b, bytes=a- and bytes=-n are ranges, and nothing else is', () => {
    expect(parseByteRange('bytes=2-5')).toEqual({ first: 2, last: 5 })
    expect(parseByteRange('bytes=2-')).toEqual({ first: 2 })
    expect(parseByteRange('bytes=-3')).toEqual({ suffix: 3 })
    expect(parseByteRange('  bytes=0-0 ')).toEqual({ first: 0, last: 0 })
    for (const odd of ['', 'bytes=', 'bytes=-', 'items=1-2', 'bytes=1-2,4-5', 'bytes=a-b', 'bytes=99999999999999999999-']) {
      expect(parseByteRange(odd), odd).toBeNull()
    }
    expect(parseByteRange(null)).toBeNull()
    expect(parseByteRange(undefined)).toBeNull()
  })

  test('a range is cut to the file: a-b, a- and -n are in it, one past the end or empty is not', () => {
    expect(resolveByteRange({ first: 2, last: 5 }, 10)).toEqual({ first: 2, last: 5 })
    expect(resolveByteRange({ first: 2 }, 10)).toEqual({ first: 2, last: 9 })
    expect(resolveByteRange({ suffix: 3 }, 10)).toEqual({ first: 7, last: 9 })
    expect(resolveByteRange({ suffix: 99 }, 10)).toEqual({ first: 0, last: 9 })
    expect(resolveByteRange({ first: 0, last: 999 }, 10)).toEqual({ first: 0, last: 9 })
    expect(resolveByteRange({ first: 10 }, 10)).toBe('unsatisfiable')
    expect(resolveByteRange({ first: 5, last: 2 }, 10)).toBe('unsatisfiable')
    expect(resolveByteRange({ suffix: 0 }, 10)).toBe('unsatisfiable')
    expect(resolveByteRange({ suffix: 3 }, 0)).toBe('unsatisfiable')
  })

  test('what the inbox accepts as a range is exactly what the parse makes', () => {
    for (const header of ['bytes=2-5', 'bytes=2-', 'bytes=-3']) expect(isFileRange(parseByteRange(header))).toBe(true)
    for (const odd of [null, undefined, 5, 'bytes=1-2', {}, { first: -1 }, { first: 1.5 }, { first: 1, last: 'x' }, { suffix: 1, first: 1 }, { first: 1, extra: 1 }]) {
      expect(isFileRange(odd), JSON.stringify(odd)).toBe(false)
    }
  })
})
