// Routing + auth seams for the warehouse Worker (ADR-0004). Covers what worker/index.ts
// delegates to worker/router.ts — see router.ts's header comment for why index.ts itself
// (which must statically import '@cloudflare/sandbox' for `class Warehouse extends
// BaseSandbox`) can never be imported from a bun:test file without crashing the whole
// `bun test worker` run. A fake WAREHOUSE_BUCKET / fake exec stand in for real R2 and a
// real container — mart-api.test.ts and materialize-dispatch.test.ts already cover the
// parquet-reading and container-exec integration seams behind those two calls.

// Imported for its side effect, not preloaded: `bunfig.toml`'s `[test].preload` is
// resolved from the directory `bun test` was invoked in, so it applies when this package
// is tested on its own and NOT when the repo-wide `cd packages/cli && bun test` sweeps
// this file up — under which `authorized()` died on `crypto.subtle.timingSafeEqual is not
// a function`. The shim guards against re-defining, so both routes loading it is fine.
import './test-setup'
import { describe, expect, test } from 'bun:test'
import type { MaterializeExecResult } from './materialize-dispatch'
import { authorized, handleFetch, handleScheduled, route, type Env } from './router'

const TOKEN = 'sekrit-token-123'

function fakeBucket(
  get: (key: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>,
): Env['WAREHOUSE_BUCKET'] {
  return { get } as unknown as Env['WAREHOUSE_BUCKET']
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WAREHOUSE_CONTAINER: {} as Env['WAREHOUSE_CONTAINER'],
    WAREHOUSE_BUCKET: fakeBucket(async () => null),
    WAREHOUSE_TOKEN: TOKEN,
    ...overrides,
  }
}

function req(path: string, init: RequestInit = {}, bearer?: string): Request {
  const headers = new Headers(init.headers)
  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`)
  return new Request(`https://warehouse.example.com${path}`, { ...init, headers })
}

const okExec = async (): Promise<MaterializeExecResult> => ({
  success: true,
  stdout: '',
  stderr: '',
})

describe('authorized', () => {
  test('true when the bearer token matches WAREHOUSE_TOKEN', async () => {
    expect(await authorized(req('/marts/foo', {}, TOKEN), fakeEnv())).toBe(true)
  })

  test('false when the bearer token is wrong', async () => {
    expect(await authorized(req('/marts/foo', {}, 'wrong-token'), fakeEnv())).toBe(false)
  })

  test('false when there is no authorization header at all', async () => {
    expect(await authorized(req('/marts/foo'), fakeEnv())).toBe(false)
  })

  test('false when WAREHOUSE_TOKEN is unset, even with a bearer presented', async () => {
    expect(
      await authorized(req('/marts/foo', {}, TOKEN), fakeEnv({ WAREHOUSE_TOKEN: undefined })),
    ).toBe(false)
  })
})

describe('handleFetch — auth gate', () => {
  test('401s before any route handler runs on a missing bearer', async () => {
    let bucketCalled = false
    const env = fakeEnv({
      WAREHOUSE_BUCKET: fakeBucket(async () => {
        bucketCalled = true
        return null
      }),
    })
    const res = await handleFetch(req('/marts/mart_test'), env, { exec: okExec })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(bucketCalled).toBe(false)
  })

  test('401s before any route handler runs on a wrong bearer', async () => {
    let execCalled = false
    const res = await handleFetch(req('/materialize', { method: 'POST' }, 'wrong'), fakeEnv(), {
      exec: async () => {
        execCalled = true
        return okExec()
      },
    })
    expect(res.status).toBe(401)
    expect(execCalled).toBe(false)
  })

  test('a correct bearer passes through to routing', async () => {
    const res = await handleFetch(req('/nope', {}, TOKEN), fakeEnv(), { exec: okExec })
    expect(res.status).toBe(404)
  })
})

describe('route — GET /marts/:name', () => {
  test("dispatches to mart-api's handleMartRead (missing mart -> 404, bucket was consulted)", async () => {
    let bucketCalled = false
    const env = fakeEnv({
      WAREHOUSE_BUCKET: fakeBucket(async () => {
        bucketCalled = true
        return null
      }),
    })
    const res = await route(req('/marts/mart_test'), env, { exec: okExec })
    expect(res.status).toBe(404)
    expect(bucketCalled).toBe(true)
  })

  test('wrong method on /marts/:name (POST) does not match the mart route', async () => {
    let bucketCalled = false
    const env = fakeEnv({
      WAREHOUSE_BUCKET: fakeBucket(async () => {
        bucketCalled = true
        return null
      }),
    })
    const res = await route(req('/marts/mart_test', { method: 'POST' }), env, { exec: okExec })
    expect(res.status).toBe(404)
    expect(bucketCalled).toBe(false)
  })
})

describe('route — POST /materialize', () => {
  test("dispatches to materialize-dispatch's dispatchMaterialize (success -> 200)", async () => {
    let received: Env | undefined
    const res = await route(req('/materialize', { method: 'POST' }), fakeEnv(), {
      exec: async (env) => {
        received = env as Env
        return { success: true, stdout: 'ok', stderr: '' }
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ materialized: true })
    expect(received).toBeDefined()
  })

  test('exec failure surfaces as an opaque 502 (stderr stays in the log)', async () => {
    const res = await route(req('/materialize', { method: 'POST' }), fakeEnv(), {
      exec: async () => ({ success: false, stdout: '', stderr: 'dbt run failed' }),
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'materialize failed' })
  })

  test('wrong method on /materialize (GET) does not match the materialize route', async () => {
    const res = await route(req('/materialize'), fakeEnv(), { exec: okExec })
    expect(res.status).toBe(404)
  })
})

describe('route — unknown paths', () => {
  test('404s for a path that matches nothing', async () => {
    const res = await route(req('/nope'), fakeEnv(), { exec: okExec })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})

// The cron path is ADR-0004's PRIMARY trigger and previously had zero coverage — which is
// how it shipped discarding every failure (dispatchMaterialize reports failure by returning
// a 502 Response, not by rejecting, so `.then(() => undefined)` silently swallowed it).
describe('handleScheduled — the Cron Trigger path', () => {
  test('resolves when the run succeeds', async () => {
    await expect(handleScheduled(fakeEnv(), { exec: okExec })).resolves.toBeUndefined()
  })

  test('REJECTS when the run fails, so the invocation is recorded as failed', async () => {
    await expect(
      handleScheduled(fakeEnv(), {
        exec: async () => ({ success: false, stdout: '', stderr: 'dbt run failed' }),
      }),
    ).rejects.toThrow(/scheduled materialize failed/)
  })

  test('requires no bearer token — a cron invocation carries no request headers', async () => {
    // fakeEnv() has a WAREHOUSE_TOKEN, but handleScheduled never sees a Request at all;
    // this pins that the cron path is not accidentally gated on one.
    const envWithoutToken = { ...fakeEnv(), WAREHOUSE_TOKEN: undefined }
    await expect(handleScheduled(envWithoutToken, { exec: okExec })).resolves.toBeUndefined()
  })
})
