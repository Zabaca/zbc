import { describe, expect, test } from 'bun:test'
import {
  buildContainerEnv,
  containerExec,
  dispatchMaterialize,
  type Env,
  type MaterializeExecResult,
} from './materialize-dispatch'

function fakeEnv(): Env {
  return { WAREHOUSE_CONTAINER: {} as Env['WAREHOUSE_CONTAINER'] }
}

describe('dispatchMaterialize', () => {
  test('returns 200 { materialized: true } when exec succeeds', async () => {
    const result: MaterializeExecResult = {
      success: true,
      stdout: 'dbt run: 2 models OK',
      stderr: '',
    }
    const res = await dispatchMaterialize(fakeEnv(), { exec: async () => result })

    // 200 rather than 202: exec is awaited to completion, so the run really is done.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ materialized: true })
  })

  test('returns an opaque 502 when exec fails — container stderr must not reach the caller', async () => {
    const result: MaterializeExecResult = {
      success: false,
      stdout: '',
      stderr: 'dbt run failed: BearerTokenAuth(token=ghp_SECRET) in connectors/github.py',
    }
    const res = await dispatchMaterialize(fakeEnv(), { exec: async () => result })
    const body = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(body)).toEqual({ error: 'materialize failed' })
    // The container holds the connector secrets, and tracebacks echo client config — so the
    // response body must carry none of it, however useful it would be for debugging.
    expect(body).not.toContain('ghp_SECRET')
    expect(body).not.toContain('BearerTokenAuth')
  })

  test('passes env through to the injected exec fn', async () => {
    const env = fakeEnv()
    let received: Env | undefined

    await dispatchMaterialize(env, {
      exec: async (e) => {
        received = e
        return { success: true, stdout: '', stderr: '' }
      },
    })

    expect(received).toBe(env)
  })
})

describe('buildContainerEnv — what crosses into the container', () => {
  test('forwards R2 credentials and connector config, but never the edge API token', () => {
    const env = {
      WAREHOUSE_CONTAINER: {} as Env['WAREHOUSE_CONTAINER'],
      WAREHOUSE_BUCKET: {} as unknown,
      WAREHOUSE_TOKEN: 'edge-api-token',
      WAREHOUSE_BUCKET_NAME: 'proj-warehouse',
      WAREHOUSE_R2_ACCESS_KEY_ID: 'akid',
      WAREHOUSE_R2_SECRET_ACCESS_KEY: 'secret',
      WAREHOUSE_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      GITHUB_OWNER: 'Zabaca',
      GITHUB_REPO: 'zbc',
      GITHUB_TOKEN: 'ghp_x',
    } as unknown as Env

    const out = buildContainerEnv(env)

    // The container writes marts over the S3 API, so it needs all four of these.
    expect(out.WAREHOUSE_BUCKET_NAME).toBe('proj-warehouse')
    expect(out.WAREHOUSE_R2_ACCESS_KEY_ID).toBe('akid')
    expect(out.WAREHOUSE_R2_SECRET_ACCESS_KEY).toBe('secret')
    expect(out.WAREHOUSE_R2_ENDPOINT).toBe('https://acct.r2.cloudflarestorage.com')

    // Connector config rides through by convention — no per-connector allowlist to update.
    expect(out.GITHUB_OWNER).toBe('Zabaca')
    expect(out.GITHUB_TOKEN).toBe('ghp_x')

    // WAREHOUSE_TOKEN gates the edge API; the container has no use for it, so it must not
    // be in a process whose stderr and filesystem a connector script can reach.
    expect(out.WAREHOUSE_TOKEN).toBeUndefined()
    // Bindings are objects, not strings — they can't cross a process boundary anyway.
    expect(out.WAREHOUSE_CONTAINER).toBeUndefined()
    expect(out.WAREHOUSE_BUCKET).toBeUndefined()
  })
})

describe('containerExec', () => {
  // containerExec wakes a real @cloudflare/sandbox container — an integration seam, not
  // unit-tested here (same call cedarpad made for warehouseExec). What IS worth pinning is
  // the property the rest of this suite depends on: importing this module must not eagerly
  // load '@cloudflare/sandbox', because that import crashes the Bun process outright (a Bus
  // error, not a catchable exception) outside workerd, taking the whole `bun test` run with
  // it. `expect(typeof containerExec).toBe('function')` cannot fail and so guarded nothing;
  // asserting the module was never loaded is the actual invariant.
  test('importing this module does not eagerly load @cloudflare/sandbox', () => {
    expect(typeof containerExec).toBe('function')
    const loaded = Object.keys(require.cache ?? {}).some((p) => p.includes('@cloudflare/sandbox'))
    expect(loaded).toBe(false)
  })
})
