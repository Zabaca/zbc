// Edge mart-read route (ADR-0004, CONTEXT.md "Data Warehouse"): reads a mart's parquet IN
// THE WORKER via hyparquet — no container wake for reads. This app has no guest/canvas
// concept (unlike cedarpad's ADR-0017 predecessor this pattern is ported from) — every
// caller past the bearer-token gate (checked one layer up, in worker/index.ts) may read any
// mart. The property that DOES carry over: a malformed name and a well-formed-but-absent
// mart must 404 with the exact same body — neither shape is an oracle for "does this mart
// exist".

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleMartRead, readMart, type MartBucket } from './mart-api'
import { martKey, martSidecarKey } from './r2-keys'

const MART_NAME = 'mart_test'

/** Build a real DuckDB-written parquet + sidecar, wired into an in-memory MartBucket at the
 * real `marts/<name>.parquet` / `marts/<name>.schema.json` keys (r2-keys.ts) — exercising
 * the whole path hyparquet parses in the Worker, not a hand-rolled stub. */
function withMartBucket<T>(fn: (bucket: MartBucket) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'warehouse-mart-api-test-'))
  const parquetPath = join(dir, 'mart.parquet')
  return (async () => {
    try {
      const proc = Bun.spawn(
        [
          'duckdb',
          ':memory:',
          '-c',
          `COPY (SELECT 'sess-a' AS session_id, now()::TIMESTAMP AS ts, 42::BIGINT AS input_tokens) TO '${parquetPath}' (FORMAT PARQUET);`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`duckdb fixture write failed: ${stderr}`)
      const parquetBytes = await Bun.file(parquetPath).bytes()

      const objects = new Map<string, Uint8Array>()
      objects.set(martKey(MART_NAME), parquetBytes)
      objects.set(
        martSidecarKey(MART_NAME),
        new TextEncoder().encode(
          JSON.stringify({
            name: MART_NAME,
            description: 'test mart',
            columns: [
              { name: 'session_id', type: 'VARCHAR', description: 'id' },
              { name: 'ts', type: 'TIMESTAMP', description: 'ts' },
              { name: 'input_tokens', type: 'BIGINT', description: 'tokens' },
            ],
            generatedAt: new Date().toISOString(),
            rowCount: 1,
          }),
        ),
      )
      const bucket: MartBucket = {
        get: async (key) => {
          const bytes = objects.get(key)
          return bytes === undefined
            ? null
            : {
                arrayBuffer: async (): Promise<ArrayBuffer> =>
                  bytes.buffer.slice(
                    bytes.byteOffset,
                    bytes.byteOffset + bytes.byteLength,
                  ) as ArrayBuffer,
              }
        },
      }
      return await fn(bucket)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
}

const duckdbAvailable = Bun.which('duckdb') !== null
if (!duckdbAvailable) {
  console.warn(
    'DuckDB CLI not found — mart-api.test.ts parquet-fixture tests SKIPPED; install duckdb to run them.',
  )
}
const maybeDescribe = duckdbAvailable ? describe : describe.skip

describe('readMart — absent mart', () => {
  test('returns null when both parquet and sidecar are missing', async () => {
    const bucket: MartBucket = { get: async () => null }
    expect(await readMart(bucket, 'mart_does_not_exist')).toBeNull()
  })
})

maybeDescribe('readMart — parquet in the Worker, coerced JSON-safe', () => {
  test('reads rows + sidecar, and every row survives JSON.stringify (BigInt/Date coercion applied)', async () => {
    await withMartBucket(async (bucket) => {
      const mart = await readMart(bucket, MART_NAME)
      expect(mart).not.toBeNull()
      expect(mart?.sidecar.name).toBe(MART_NAME)
      expect(mart?.rows).toHaveLength(1)
      const row = mart?.rows[0] as Record<string, unknown>
      expect(typeof row.input_tokens).toBe('number')
      expect(typeof row.ts).toBe('string')
      expect(() => JSON.stringify(mart)).not.toThrow()
    })
  })

  test('an unknown mart name resolves to null (no parquet, no sidecar)', async () => {
    await withMartBucket(async (bucket) => {
      expect(await readMart(bucket, 'mart_does_not_exist')).toBeNull()
    })
  })
})

describe('handleMartRead', () => {
  test('a malformed name 404s BEFORE ever building a storage key', async () => {
    let getCalled = false
    const bucket: MartBucket = {
      get: async () => {
        getCalled = true
        return null
      },
    }
    const res = await handleMartRead(bucket, '../etc/passwd')
    expect(res.status).toBe(404)
    expect(getCalled).toBe(false)
  })

  test('a well-formed but absent mart 404s with the SAME body as a malformed name — no enumeration oracle', async () => {
    const bucket: MartBucket = { get: async () => null }
    const malformed = await handleMartRead(bucket, '../etc/passwd')
    const absent = await handleMartRead(bucket, 'mart_does_not_exist')
    expect(malformed.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(await malformed.json()).toEqual(await absent.json())
  })

  maybeDescribe('present mart', () => {
    test('returns 200 with { sidecar, rows } where rows went through coerceMartRow', async () => {
      await withMartBucket(async (bucket) => {
        const res = await handleMartRead(bucket, MART_NAME)
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          sidecar: { name: string }
          rows: Array<Record<string, unknown>>
        }
        expect(body.sidecar.name).toBe(MART_NAME)
        expect(body.rows).toHaveLength(1)
        expect(typeof body.rows[0]?.input_tokens).toBe('number')
        expect(typeof body.rows[0]?.ts).toBe('string')
      })
    })
  })
})
