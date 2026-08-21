/**
 * The filesystem store's compare-and-swap, which the push-path e2e depends on
 * being real: hook processes race through it, and a CAS that merely looked
 * atomic would make every fault-injection result meaningless.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileStore } from './store'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-filestore-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const store = new FileStore(root)
const bytes = (s: string) => new TextEncoder().encode(s)

describe('FileStore', () => {
  test('round-trips a body and its etag through nested keys', async () => {
    const put = await store.put('repos/r/wal/000000000001-A.pack', bytes('PACK'))
    expect(put.ok).toBe(true)
    const got = await store.get('repos/r/wal/000000000001-A.pack')
    expect(new TextDecoder().decode(got!.body)).toBe('PACK')
    expect(got!.etag).toBe(put.ok ? put.etag : '')
  })

  test('if-absent lets exactly one of many concurrent writers create the object', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.put('race/absent', bytes('x'), { ifAbsent: true })),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  test('if-match lets exactly one of many concurrent writers replace it', async () => {
    const seed = await store.put('race/match', bytes('0'))
    const etag = seed.ok ? seed.etag : ''
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.put('race/match', bytes(String(i)), { ifMatch: etag })),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  test('a stale etag is refused rather than throwing', async () => {
    await store.put('stale', bytes('a'))
    expect(await store.put('stale', bytes('b'), { ifMatch: '"nope"' })).toEqual({
      ok: false,
      reason: 'precondition-failed',
    })
  })

  test('list is prefix-scoped, sorted, and hides the etag sidecars', async () => {
    await store.put('listed/b', bytes('b'))
    await store.put('listed/a', bytes('a'))
    expect(await store.list('listed/')).toEqual(['listed/a', 'listed/b'])
  })

  test('not-modified is answered without a body', async () => {
    const put = await store.put('cond', bytes('a'))
    const etag = put.ok ? put.etag : ''
    expect(await store.getIfNoneMatch('cond', etag)).toEqual({ status: 'not-modified' })
    expect((await store.getIfNoneMatch('cond', '"other"')).status).toBe('ok')
  })
})
