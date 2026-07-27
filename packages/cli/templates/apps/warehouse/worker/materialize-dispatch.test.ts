import { describe, expect, test } from 'bun:test'
import {
  containerExec,
  dispatchMaterialize,
  type Env,
  type MaterializeExecResult,
} from './materialize-dispatch'

function fakeEnv(): Env {
  return { WAREHOUSE_CONTAINER: {} as Env['WAREHOUSE_CONTAINER'] }
}

describe('dispatchMaterialize', () => {
  test('returns 202 { materializing: true } when exec succeeds', async () => {
    const result: MaterializeExecResult = {
      success: true,
      stdout: 'dbt run: 2 models OK',
      stderr: '',
    }
    const res = await dispatchMaterialize(fakeEnv(), { exec: async () => result })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ materializing: true })
  })

  test('returns 502 { error, stderr } when exec fails', async () => {
    const result: MaterializeExecResult = {
      success: false,
      stdout: '',
      stderr: 'dbt run failed: model mart_github_issues',
    }
    const res = await dispatchMaterialize(fakeEnv(), { exec: async () => result })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'materialize failed',
      stderr: 'dbt run failed: model mart_github_issues',
    })
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

describe('containerExec', () => {
  // containerExec wakes a real @cloudflare/sandbox container — an integration seam,
  // not unit-tested here (same call cedarpad made for warehouseExec). This test only
  // guards the property the rest of this suite depends on: importing this module must
  // not eagerly load '@cloudflare/sandbox' (that import crashes outside workerd — see
  // the module's top comment), so merely importing containerExec must be side-effect-free.
  test('is exported as a function without being invoked', () => {
    expect(typeof containerExec).toBe('function')
  })
})
