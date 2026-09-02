import { describe, expect, test } from 'bun:test'
import { destroyInstances } from './destroy'
import { fakeInstance } from './fixtures'

const opts = { secrets: {} as Record<string, string>, projectRoot: '/project' }

describe('destroyInstances', () => {
  test('tears down in reverse dependency order', async () => {
    const torn: string[] = []
    const track = (name: string) => async () => {
      torn.push(name)
    }
    const db = fakeInstance('main-db', { destroy: track('main-db') })
    const web = fakeInstance('web', { imports: [db], destroy: track('web') })

    await destroyInstances([db, web], opts)
    expect(torn).toEqual(['web', 'main-db'])
  })

  test('an instance with no destroy is skipped, not an error', async () => {
    const torn: string[] = []
    const a = fakeInstance('a')
    const b = fakeInstance('b', {
      destroy: async () => {
        torn.push('b')
      },
    })
    await destroyInstances([a, b], opts)
    expect(torn).toEqual(['b'])
  })

  test('a target tears down ONLY that instance — a dependency is shared infra', async () => {
    const torn: string[] = []
    const track = (name: string) => async () => {
      torn.push(name)
    }
    const db = fakeInstance('main-db', { destroy: track('main-db') })
    const web = fakeInstance('web', { imports: [db], destroy: track('web') })

    await destroyInstances([db, web], { ...opts, target: 'web' })
    expect(torn).toEqual(['web'])
  })

  test('an unknown target names what was available', async () => {
    await expect(
      destroyInstances([fakeInstance('a', { withDestroy: true })], { ...opts, target: 'ghost' }),
    ).rejects.toThrow(/Instance "ghost" not found\. Available: a/)
  })
})

describe('a destroy that reads an import', () => {
  test('the engine applies that instance on demand, once', async () => {
    // The case this replaced: `cloudflare`'s destroy needs the API token minted
    // by an imported `cloudflare-token`, the engine passed `imports: {}`, and
    // the module carried a swallowed catch plus a secrets.yaml fallback.
    let applies = 0
    const token = fakeInstance('deploy-token', {
      apply: async () => {
        applies += 1
        return { tokenValue: 'minted' }
      },
      withDestroy: true,
    })
    const seen: string[] = []
    const web = fakeInstance('web', {
      imports: [token],
      destroy: async (_config, ctx) => {
        seen.push(ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken'))
        seen.push(ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken'))
      },
    })

    await destroyInstances([token, web], opts)

    expect(seen).toEqual(['minted', 'minted'])
    expect(applies).toBe(1)
  })

  test('the on-demand apply is shared across the run', async () => {
    let applies = 0
    const token = fakeInstance('deploy-token', {
      apply: async () => {
        applies += 1
        return { tokenValue: 'minted' }
      },
    })
    const read = (name: string) =>
      fakeInstance(name, {
        imports: [token],
        destroy: async (_config, ctx) => {
          ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken')
        },
      })

    await destroyInstances([token, read('web'), read('api')], opts)
    expect(applies).toBe(1)
  })

  test("the import's own imports are applied first", async () => {
    const order: string[] = []
    const zone = fakeInstance('zone', {
      apply: async () => {
        order.push('zone')
        return { zoneId: 'z1' }
      },
    })
    const token = fakeInstance('deploy-token', {
      imports: [zone],
      apply: async (_config, ctx) => {
        order.push('deploy-token')
        return { tokenValue: `minted-${ctx.output({ from: 'zone', output: 'zoneId' }, 'zone')}` }
      },
    })
    let seen: string | undefined
    const web = fakeInstance('web', {
      imports: [token],
      destroy: async (_config, ctx) => {
        seen = ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken')
      },
    })

    await destroyInstances([zone, token, web], opts)

    expect(order).toEqual(['zone', 'deploy-token'])
    expect(seen).toBe('minted-z1')
  })

  test('the destroy body re-runs after an import is applied — so resolve before you delete', async () => {
    // How a synchronous `ctx.output` can trigger an asynchronous apply: the
    // context signals, the engine applies, the destroy runs again from the top.
    // Every core destroy reads its credential on its first line, which is what
    // makes this safe — a destroy that deleted something and THEN asked for an
    // import would delete it twice. Two imports, two signals, three passes.
    let passes = 0
    const a = fakeInstance('a', { apply: async () => ({ v: 'a' }) })
    const b = fakeInstance('b', { apply: async () => ({ v: 'b' }) })
    const web = fakeInstance('web', {
      imports: [a, b],
      destroy: async (_config, ctx) => {
        passes += 1
        ctx.output({ from: 'a', output: 'v' }, 'first')
        ctx.output({ from: 'b', output: 'v' }, 'second')
      },
    })

    await destroyInstances([a, b, web], opts)
    expect(passes).toBe(3)
  })

  test('a destroy that never asks applies nothing — opt-by-use', async () => {
    let applied = false
    const token = fakeInstance('deploy-token', {
      apply: async () => {
        applied = true
        return { tokenValue: 'minted' }
      },
      withDestroy: true,
    })
    const web = fakeInstance('web', { imports: [token], withDestroy: true })

    await destroyInstances([token, web], opts)
    expect(applied).toBe(false)
  })

  test('a TARGETED destroy refuses to apply the import, and says what to run instead', async () => {
    // The target filter exists because "a thing's dependencies are usually
    // shared infra you don't want destroyed alongside it". Applying that same
    // shared infra — minting a credential, rolling a token — and then walking
    // away is the same mistake with the sign flipped, and nothing in a targeted
    // run would ever tear down what it created.
    let applied = false
    const token = fakeInstance('deploy-token', {
      apply: async () => {
        applied = true
        return { tokenValue: 'minted' }
      },
      withDestroy: true,
    })
    const web = fakeInstance('web', {
      imports: [token],
      destroy: async (_config, ctx) => {
        ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken')
      },
    })

    await expect(destroyInstances([token, web], { ...opts, target: 'web' })).rejects.toThrow(
      /targeted destroy will not create/,
    )
    expect(applied).toBe(false)
  })

  test('a half-written ref is reported as the typo it is, before anything is applied', async () => {
    let applied = false
    const token = fakeInstance('deploy-token', {
      apply: async () => {
        applied = true
        return { tokenValue: 'minted' }
      },
    })
    const web = fakeInstance('web', {
      imports: [token],
      // `output` missing — a typo in the instance file. Provisioning a token
      // and THEN reporting the typo is the wrong order to fail in.
      destroy: async (_config, ctx) => {
        ctx.output({ from: 'deploy-token' }, 'apiToken')
      },
    })

    await expect(destroyInstances([token, web], opts)).rejects.toThrow(
      /apiToken must name both an instance/,
    )
    expect(applied).toBe(false)
  })

  test("a destroy that swallows the engine's signal is called out, not left silent", async () => {
    // Exactly the shape the old `cloudflare` destroy had — try the reference,
    // catch, fall back — so it is the shape a consumer's fork is carrying.
    // Nothing survives a bare catch, so the engine notices afterwards.
    const lines: string[] = []
    const log = console.log
    console.log = (...args: unknown[]) => void lines.push(args.join(' '))
    try {
      const token = fakeInstance('deploy-token', { apply: async () => ({ tokenValue: 'minted' }) })
      let used = ''
      const web = fakeInstance('web', {
        imports: [token],
        destroy: async (_config, ctx) => {
          try {
            used = ctx.output({ from: 'deploy-token', output: 'tokenValue' }, 'apiToken')
          } catch {
            used = 'fallback'
          }
        },
      })
      await destroyInstances([token, web], opts)
      expect(used).toBe('fallback')
      expect(lines.join('\n')).toMatch(/swallowed the error/)
    } finally {
      console.log = log
    }
  })

  test('a reference to an instance that is not imported still fails by name', async () => {
    const web = fakeInstance('web', {
      destroy: async (_config, ctx) => {
        ctx.output({ from: 'ghost', output: 'v' }, 'apiToken')
      },
    })
    await expect(destroyInstances([web], opts)).rejects.toThrow(
      /apiToken references instance "ghost", which is not in this instance's imports/,
    )
  })

  test('an output the applied instance does not emit fails by name, without looping', async () => {
    const token = fakeInstance('deploy-token', { apply: async () => ({ tokenValue: 'minted' }) })
    const web = fakeInstance('web', {
      imports: [token],
      destroy: async (_config, ctx) => {
        ctx.output({ from: 'deploy-token', output: 'nope' }, 'apiToken')
      },
    })
    await expect(destroyInstances([token, web], opts)).rejects.toThrow(
      /references output "nope" on instance "deploy-token", which doesn't emit it/,
    )
  })

  test('ctx.secret works in a destroy exactly as it does in an apply', async () => {
    let seen: string | undefined
    const inst = fakeInstance('one', {
      destroy: async (_config, ctx) => {
        seen = ctx.secret('FLY_API_TOKEN')
      },
    })
    await destroyInstances([inst], { ...opts, secrets: { FLY_API_TOKEN: 'tok' } })
    expect(seen).toBe('tok')
  })
})
