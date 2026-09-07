import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ApplyContext } from '../../templates/infra/src/types'
import { applyInstances } from './apply'
import { fakeInstance, fakeModule } from './fixtures'

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
    const inst = legacyInstance(ran, 'turso', { ephemeral: true })

    const lines = await captureLog(() => applyInstances([inst], opts))
    expect(ran).toEqual(['destroy:preview-db', 'apply:preview-db'])
    expect(lines).toContain(
      '  ⚠ preview-db: config.ephemeral is deprecated — set ephemeral: true on the instance',
    )
  })

  test('config.ephemeral on a module that never declared it stays inert', async () => {
    // Every module but the four bought the key silently — `z.object` strips it.
    // Honouring it everywhere would give a stray copy-paste teeth: a `wrangler
    // delete --force` against a live Worker before the next production deploy.
    const ran: string[] = []
    const inst = legacyInstance(ran, 'cloudflare', { ephemeral: true })
    await applyInstances([inst], opts)
    expect(ran).toEqual(['apply:preview-db'])
  })

  test('an instance from a define-module older than the engine still goes ephemeral', async () => {
    // A subtree consumer whose `vendor/zbc` lags the CLI: `instance()` never set
    // `ephemeral`, so the property is absent rather than false.
    const ran: string[] = []
    const inst = legacyInstance(ran, 'turso', { ephemeral: true })
    delete (inst as { ephemeral?: boolean }).ephemeral

    await applyInstances([inst], opts)
    expect(ran).toEqual(['destroy:preview-db', 'apply:preview-db'])
  })

  test('ephemeral on a legacy module with no destroy throws, whichever spelling', async () => {
    const noDestroy = fakeModule('turso', { apply: async () => ({}) }).instance({
      name: 'preview-db',
      config: { ephemeral: true },
    })
    await expect(applyInstances([noDestroy], opts)).rejects.toThrow(
      'Instance "preview-db" is ephemeral but module "turso" has no destroy',
    )
  })

  /** An instance of a real module NAME, carrying the pre-0.14 `config.ephemeral`. */
  function legacyInstance(ran: string[], moduleName: string, config: Record<string, unknown>) {
    return fakeModule(moduleName, {
      apply: async () => {
        ran.push('apply:preview-db')
        return {}
      },
      destroy: async () => {
        ran.push('destroy:preview-db')
      },
    }).instance({ name: 'preview-db', config })
  }

  test('a failing destroy fails the apply — the engine adds no catch of its own', async () => {
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

// ── readiness ───────────────────────────────────────────────────────────────
//
// Every provider in the consumer survey returns success from a create call
// before the created thing works, and four consumers hand-rolled a retry loop
// because there was nowhere to put the fix. The gate is the place: a module
// declares what proves its resource usable, and the engine holds the output at
// the imports edge until that proof succeeds.

describe('the readiness gate', () => {
  test("an importer sees a dependency's output only after its probe has passed", async () => {
    const ran: string[] = []
    let attempts = 0
    const token = fakeInstance('token', {
      apply: async () => {
        ran.push('apply:token')
        return { tokenValue: 'v' }
      },
      ready: {
        proves: 'the minted token can act',
        intervalMs: 1,
        timeoutMs: 1_000,
        probe: async () => {
          attempts += 1
          ran.push(`probe:${attempts}`)
          if (attempts < 3) throw new Error('10000: Authentication error')
        },
      },
    })
    const web = fakeInstance('web', {
      imports: [token],
      apply: async (_config, ctx) => {
        ran.push(`read:${ctx.output({ from: 'token', output: 'tokenValue' }, 'apiToken')}`)
        return {}
      },
    })

    await applyInstances([token, web], opts)

    expect(ran).toEqual(['apply:token', 'probe:1', 'probe:2', 'probe:3', 'read:v'])
  })

  test('a probe that never clears fails the apply, naming what it could not prove', async () => {
    const token = probing('token', { proves: 'the minted token can act' }, async () => {
      throw new Error('10000: Authentication error')
    })
    const web = fakeInstance('web', {
      imports: [token],
      apply: async (_config, ctx) => {
        ctx.output({ from: 'token', output: 'tokenValue' }, 'apiToken')
        return {}
      },
    })

    const err = await failure(() => applyInstances([token, web], opts))

    // Four facts, because each one is a different next move for the operator:
    // which instance, which module, what was being proven, and what the
    // provider actually said while refusing.
    expect(err?.message).toContain('Instance "token" (module "mod-token")')
    expect(err?.message).toContain('is not usable yet: the minted token can act')
    expect(err?.message).toContain('Last failure: 10000: Authentication error')
    expect(err?.message).toMatch(/\d+ attempts/)
  })

  test('the importer never runs when the probe never clears', async () => {
    const ran: string[] = []
    const token = probing('token', { proves: 'p' }, async () => {
      throw new Error('nope')
    })
    const web = fakeInstance('web', {
      imports: [token],
      apply: async () => {
        ran.push('apply:web')
        return {}
      },
    })

    await failure(() => applyInstances([token, web], opts))
    expect(ran).toEqual([])
  })

  test('a dependency two instances import is probed once', async () => {
    let probes = 0
    const token = probing('token', { proves: 'p' }, async () => {
      probes += 1
    })
    const reader = (name: string) =>
      fakeInstance(name, {
        imports: [token],
        apply: async (_config, ctx) => {
          ctx.output({ from: 'token', output: 'tokenValue' }, 'apiToken')
          return {}
        },
      })

    await applyInstances([token, reader('web'), reader('api')], opts)
    expect(probes).toBe(1)
  })

  test('an instance nothing imports is never probed — the gate is on the edge', async () => {
    let probes = 0
    const lonely = probing('lonely', { proves: 'p' }, async () => {
      probes += 1
    })
    await applyInstances([lonely], opts)
    expect(probes).toBe(0)
  })

  test('a false verdict is a refusal, and any other return value is not', async () => {
    const verdicts: Array<boolean | undefined> = [false, false, true]
    let attempts = 0
    const device = probing('device', { proves: 'the device reports online' }, async () => {
      return verdicts[attempts++]
    })
    const job = fakeInstance('job', {
      imports: [device],
      apply: async (_config, ctx) => {
        ctx.output({ from: 'device', output: 'tokenValue' }, 'ref')
        return {}
      },
    })

    await applyInstances([device, job], opts)
    expect(attempts).toBe(3)
  })

  test('the probe reads the same secrets and imports its apply did', async () => {
    const root = fakeInstance('root', { apply: async () => ({ tokenValue: 'root-v' }) })
    let seen: string | undefined
    const minted = fakeInstance('minted', {
      imports: [root],
      apply: async () => ({ tokenValue: 'minted-v' }),
      ready: {
        proves: 'p',
        probe: async (outputs, _config, ctx) => {
          seen = [
            ctx.secret('ROOT'),
            ctx.output({ from: 'root', output: 'tokenValue' }, 'ref'),
            (outputs as { tokenValue: string }).tokenValue,
          ].join('|')
        },
      },
    })
    const web = fakeInstance('web', {
      imports: [minted],
      apply: async (_config, ctx) => {
        ctx.output({ from: 'minted', output: 'tokenValue' }, 'apiToken')
        return {}
      },
    })

    await applyInstances([root, minted, web], { ...opts, secrets: { ROOT: 'r' } })
    expect(seen).toBe('r|root-v|minted-v')
  })

  /** An instance whose module declares `ready`, on a budget no test waits out. */
  function probing(
    name: string,
    ready: { proves: string },
    probe: (
      outputs: Record<string, unknown>,
      config: Record<string, unknown>,
      ctx: ApplyContext,
    ) => Promise<boolean | void>,
  ) {
    return fakeInstance(name, {
      apply: async () => ({ tokenValue: 'v' }),
      ready: { proves: ready.proves, intervalMs: 1, timeoutMs: 20, probe },
    })
  }
})

/** What `run` threw, or undefined. */
async function failure(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run()
    return undefined
  } catch (err) {
    return err as Error
  }
}
