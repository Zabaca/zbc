import { describe, expect, test } from 'bun:test'
import { coerceMartRow, MartName, MartSidecarSchema } from './mart-contract'

describe('coerceMartRow', () => {
  test('coerces a bigint within MAX_SAFE_INTEGER to a number', () => {
    expect(coerceMartRow({ count: 42n })).toEqual({ count: 42 })
  })

  test('coerces a bigint beyond MAX_SAFE_INTEGER to its decimal string', () => {
    const huge = 9_223_372_036_854_775_807n // int64 max, well past MAX_SAFE_INTEGER
    expect(coerceMartRow({ count: huge })).toEqual({ count: '9223372036854775807' })
  })

  test('coerces a Date to its ISO string', () => {
    const at = new Date('2026-07-24T12:00:00.000Z')
    expect(coerceMartRow({ createdAt: at })).toEqual({ createdAt: '2026-07-24T12:00:00.000Z' })
  })

  test('passes string, number, boolean, and null through unchanged', () => {
    expect(coerceMartRow({ name: 'ada', score: 1.5, active: true, note: null })).toEqual({
      name: 'ada',
      score: 1.5,
      active: true,
      note: null,
    })
  })

  test('throws on an unsupported value type', () => {
    expect(() => coerceMartRow({ payload: { nested: true } })).toThrow(
      'coerceMartRow: unsupported value type for column "payload": object',
    )
  })
})

function validSidecar() {
  return {
    name: 'session_events',
    description: 'One row per session event.',
    columns: [{ name: 'session_id', type: 'VARCHAR', description: 'The session id.' }],
    generatedAt: '2026-07-24T12:00:00.000Z',
    rowCount: 10,
  }
}

describe('MartSidecarSchema', () => {
  test('accepts a well-formed sidecar', () => {
    expect(MartSidecarSchema.safeParse(validSidecar()).success).toBe(true)
  })

  test('rejects a mart with zero columns', () => {
    const sidecar = { ...validSidecar(), columns: [] }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })

  test('rejects a column missing its description', () => {
    const sidecar = {
      ...validSidecar(),
      columns: [{ name: 'session_id', type: 'VARCHAR' }],
    }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })

  test('rejects a malformed mart name', () => {
    const sidecar = { ...validSidecar(), name: '1-bad-name!' }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })
})

describe('MartName', () => {
  test('accepts a lowercase name starting with a letter', () => {
    expect(MartName.safeParse('session_events').success).toBe(true)
  })

  test('rejects a name starting with a digit', () => {
    expect(MartName.safeParse('1_session_events').success).toBe(false)
  })

  test('rejects a name with a path separator', () => {
    expect(MartName.safeParse('../secrets').success).toBe(false)
  })
})
