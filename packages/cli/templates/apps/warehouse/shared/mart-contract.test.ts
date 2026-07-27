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

  test('keeps a column literally named __proto__ instead of silently dropping it', () => {
    // On a `{}` literal this assignment hits the inherited __proto__ setter, which ignores
    // primitives — the column disappears with no error. Asserted via the serialized form
    // because that is how the row actually reaches a consumer.
    const row = coerceMartRow({ __proto__: 'x', ok: 1 })
    expect(JSON.parse(JSON.stringify(row))).toEqual({ __proto__: 'x', ok: 1 })
  })

  test('maps a non-finite DOUBLE (NaN/Infinity) to null rather than letting JSON decide', () => {
    expect(coerceMartRow({ ratio: Number.NaN, growth: Number.POSITIVE_INFINITY })).toEqual({
      ratio: null,
      growth: null,
    })
  })

  test('throws on undefined — an absent value is not the same as a NULL column', () => {
    expect(() => coerceMartRow({ missing: undefined })).toThrow(/unsupported value type/)
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

  // The case above passes on key-ABSENCE alone, so on its own it does not actually
  // constrain the "every column is described" rule — an empty string is the shape a real
  // schema.yml produces (`description: ""` or a key with nothing after it), and it used to
  // validate cleanly. These pin the rule itself.
  test('rejects an EMPTY-STRING column description, not just an absent key', () => {
    const sidecar = {
      ...validSidecar(),
      columns: [{ name: 'session_id', type: 'VARCHAR', description: '' }],
    }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })

  test('rejects an empty-string mart description', () => {
    expect(MartSidecarSchema.safeParse({ ...validSidecar(), description: '' }).success).toBe(false)
  })

  test('rejects an empty-string column name', () => {
    const sidecar = {
      ...validSidecar(),
      columns: [{ name: '', type: 'VARCHAR', description: 'The session id.' }],
    }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })

  test('rejects duplicate column names — the declared contract would be ambiguous', () => {
    const sidecar = {
      ...validSidecar(),
      columns: [
        { name: 'session_id', type: 'VARCHAR', description: 'The session id.' },
        { name: 'session_id', type: 'BIGINT', description: 'Also the session id?' },
      ],
    }
    expect(MartSidecarSchema.safeParse(sidecar).success).toBe(false)
  })

  test('rejects unknown keys so a typo fails loudly instead of being dropped', () => {
    const sidecar = { ...validSidecar(), rowCounts: 10 }
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
