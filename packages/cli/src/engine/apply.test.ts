import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ApplyContext } from '../../templates/infra/src/types'
import { applyInstances } from './apply'
import { fakeInstance } from './fixtures'

const opts = { secrets: {} as Record<string, string>, projectRoot: '/project' }

/** Run `apply` for a single instance whose body is `body`, and return what it threw. */
async function applyBody(
  body: (ctx: ApplyContext) => void,
  secrets: Record<string, string> = {},
  imports: Record<string, string> = {},
): Promise<Error | undefined> {
  const dep = fakeInstance('dep', { apply: async () => imports })
  const one = fakeInstance('one', {
    imports: [dep],
    apply: async (_config, ctx) => {
      body(ctx)
      return {}
    },
  })
  try {
    await applyInstances([dep, one], { ...opts, secrets })
    return undefined
  } catch (err) {
    return err as Error
  }
}

describe('applyInstances', () => {
  test('an imported instance runs first and its outputs reach the importer', async () => {
    const db = fakeInstance('main-db', {
      apply: async () => ({ databaseUrl: 'libsql://x', authToken: 'tok' }),
    })
    let seen: string | undefined
    const web = fakeInstance('web', {
      imports: [db],
      apply: async (_config, ctx) => {
        seen = ctx.output({ from: 'main-db', output: 'databaseUrl' }, 'workerVars entry "DB_URL"')
        return {}
      },
    })

    const outputs = await applyInstances([web, db], opts)

    expect(seen).toBe('libsql://x')
    expect(outputs.get('main-db')).toEqual({ databaseUrl: 'libsql://x', authToken: 'tok' })
  })

  test('the config a module receives is its schema output, not the raw literal', async () => {
    let seen: unknown
    const inst = fakeModuleWithDefault((config) => {
      seen = config
    })
    await applyInstances([inst], opts)
    expect(seen).toEqual({ group: 'default' })
  })

  test('an apply whose result violates its outputs schema throws', async () => {
    const bad = fakeInstance('bad', {
      outputs: z.object({ bucketName: z.string() }),
      apply: async () => ({}) as Record<string, unknown>,
    })
    await expect(applyInstances([bad], opts)).rejects.toThrow()
  })

  test('a module failure propagates — nothing swallows it', async () => {
    const boom = fakeInstance('boom', {
      apply: async () => {
        throw new Error('wrangler exploded')
      },
    })
    await expect(applyInstances([boom], opts)).rejects.toThrow('wrangler exploded')
  })
})

describe('ephemeral', () => {
  /** An instance with a `destroy`, whose two hooks append to `ran` so order is observable. */
  function tracked(
    ran: string[],
    name: string,
    how: { ephemeral?: boolean; config?: Record<string, unknown> } = {},
  ) {
    return fakeInstance(name, {
      ...how,
      apply: async () => {
        ran.push(`apply:${name}`)
        return {}
      },
      destroy: async () => {
        ran.push(`destroy:${name}`)
      },
    })
  }

  test('an ephemeral instance is destroyed then applied, each once', async () => {
    const ran: string[] = []
    const inst = tracked(ran, 'preview-db', { ephemeral: true })
    await applyInstances([inst], opts)
    expect(ran).toEqual(['destroy:preview-db', 'apply:preview-db'])
  })

  test('a non-ephemeral instance is only applied, even though its module has a destroy', async () => {
    const ran: string[] = []
    const inst = tracked(ran, 'main-db')
    await applyInstances([inst], opts)
    expect(ran).toEqual(['apply:main-db'])
  })

  test('ephemeral on a module with no destroy throws before anything is applied', async () => {
    const ran: string[] = []
    const first = tracked(ran, 'first')
    const bad = fakeInstance('cache', { imports: [first], ephemeral: true })

    await expect(applyInstances([first, bad], opts)).rejects.toThrow(
      'Instance "cache" is ephemeral but module "mod-cache" has no destroy',
    )
    expect(ran).toEqual([])
  })

  test('the old config.ephemeral spelling still works, with a deprecation line', async () => {
    const ran: string[] = []
    const inst = tracked(ran, 'preview-db', { config: { ephemeral: true } })

    const lines = await captureLog(() => applyInstances([inst], opts))
    expect(ran).toEqual(['destroy:preview-db', 'apply:preview-db'])
    expect(lines).toContain(
      '  ⚠ preview-db: config.ephemeral is deprecated — set ephemeral: true on the instance',
    )
  })

  test('a failing destroy fails the apply — nothing is swallowed', async () => {
    const inst = fakeInstance('preview-db', {
      ephemeral: true,
      apply: async () => ({}),
      destroy: async () => {
        throw new Error('bucket not empty')
      },
    })
    await expect(applyInstances([inst], opts)).rejects.toThrow('bucket not empty')
  })
})

describe('the context the engine hands a module', () => {
  test('projectRoot and the raw fields are still there', async () => {
    let seen: ApplyContext | undefined
    const inst = fakeInstance('one', {
      apply: async (_config, ctx) => {
        seen = ctx
        return {}
      },
    })
    await applyInstances([inst], { ...opts, secrets: { A: '1' } })
    expect(seen?.projectRoot).toBe('/project')
    expect(seen?.secrets).toEqual({ A: '1' })
    expect(seen?.imports).toEqual({})
  })

  test('ctx.secret names the key and the field that wanted it', async () => {
    const err = await applyBody((ctx) => ctx.secret('NOPE', { field: 'workerSecrets' }))
    expect(err?.message).toBe(
      'workerSecrets needs secret "NOPE", which is missing from this environment\'s secrets.yaml',
    )
  })

  test('a blank secret is missing by default and present with allowBlank', async () => {
    const blank = { BLANK: '' }
    expect((await applyBody((ctx) => ctx.secret('BLANK'), blank))?.message).toMatch(/is empty/)
    expect(
      await applyBody((ctx) => ctx.secret('BLANK', { allowBlank: true }), blank),
    ).toBeUndefined()
  })

  test('ctx.output tells the three failures apart', async () => {
    expect((await applyBody((ctx) => ctx.output({ from: 'dep' }, 'apiToken')))?.message).toBe(
      'apiToken must name both an instance (`from`) and an output (`output`)',
    )
    expect(
      (await applyBody((ctx) => ctx.output({ from: 'ghost', output: 'v' }, 'apiToken')))?.message,
    ).toBe('apiToken references instance "ghost", which is not in this instance\'s imports')
    expect(
      (await applyBody((ctx) => ctx.output({ from: 'dep', output: 'nope' }, 'apiToken')))?.message,
    ).toBe('apiToken references output "nope" on instance "dep", which doesn\'t emit it')
  })

  test('an instance sees only what it imported', async () => {
    const a = fakeInstance('a', { apply: async () => ({ v: 'from-a' }) })
    const b = fakeInstance('b', { apply: async () => ({ v: 'from-b' }) })
    let err: Error | undefined
    const c = fakeInstance('c', {
      imports: [b],
      apply: async (_config, ctx) => {
        expect(ctx.output({ from: 'b', output: 'v' }, 'f')).toBe('from-b')
        try {
          ctx.output({ from: 'a', output: 'v' }, 'f')
        } catch (e) {
          err = e as Error
        }
        return {}
      },
    })
    await applyInstances([a, b, c], opts)
    expect(err?.message).toMatch(/instance "a", which is not in this instance's imports/)
  })

  test('a targeted apply runs the closure and nothing else', async () => {
    const ran: string[] = []
    const track = (name: string) => async () => {
      ran.push(name)
      return {}
    }
    const a = fakeInstance('a', { apply: track('a') })
    const b = fakeInstance('b', { imports: [a], apply: track('b') })
    const other = fakeInstance('other', { apply: track('other') })

    await applyInstances([a, b, other], { ...opts, target: 'b' })
    expect(ran).toEqual(['a', 'b'])
  })
})

/** Collect what `run` logs, restoring `console.log` whether it resolves or throws. */
async function captureLog(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await run()
  } finally {
    console.log = original
  }
  return lines
}

/** An instance whose schema fills in a default, to prove the module sees the parsed config. */
function fakeModuleWithDefault(spy: (config: unknown) => void) {
  const inst = fakeInstance('one', {
    apply: async (config) => {
      spy(config)
      return {}
    },
  })
  inst._definition.configSchema = z.object({ group: z.string().default('default') })
  return inst
}
