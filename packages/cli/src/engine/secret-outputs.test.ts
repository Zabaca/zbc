import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { applyInstances } from './apply'
import { destroyInstances } from './destroy'
import { fakeInstance } from './fixtures'
import { createSecretOutputRegistry } from './secret-outputs'

const opts = { secrets: {} as Record<string, string>, projectRoot: '/project' }

/** The error a run threw — and a failure, not `undefined`, when it threw none. */
async function asError(run: Promise<unknown>): Promise<Error> {
  try {
    await run
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the apply to throw, and it did not')
}

describe('secret outputs', () => {
  test('a declared secret output still reaches an importer verbatim', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenId: 'abc', tokenValue: 'v1.0-supersecret' }),
    })
    let seen: string | undefined
    const web = fakeInstance('web', {
      imports: [minter],
      apply: async (_config, ctx) => {
        seen = ctx.output({ from: 'token', output: 'tokenValue' }, 'workerSecrets entry "CF"')
        return {}
      },
    })

    await applyInstances([web, minter], opts)

    expect(seen).toBe('v1.0-supersecret')
  })

  test('a secret output value is redacted out of an error the apply throws', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenValue: 'v1.0-supersecret' }),
    })
    const web = fakeInstance('web', {
      imports: [minter],
      apply: async (_config, ctx) => {
        throw new Error(
          `Bearer ${ctx.output({ from: 'token', output: 'tokenValue' }, 'x')} was refused`,
        )
      },
    })

    const err = await asError(applyInstances([web, minter], opts))

    expect(err.message).toBe('Bearer [redacted: token.tokenValue] was refused')
  })

  test('a probe failure that echoes the credential is redacted before it is reported', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenValue: 'v1.0-supersecret' }),
      ready: {
        proves: 'the minted token can read',
        timeoutMs: 20,
        intervalMs: 5,
        probe: async (outputs) => {
          throw new Error(`HTTP 403 for Authorization: Bearer ${outputs.tokenValue}`)
        },
      },
    })
    const web = fakeInstance('web', { imports: [minter], apply: async () => ({}) })

    const err = await asError(applyInstances([web, minter], opts))

    expect(err.message).toContain('Bearer [redacted: token.tokenValue]')
    expect(err.message).not.toContain('v1.0-supersecret')
  })

  test('the document zbc apply --json writes carries [redacted] in place of the credential', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenId: 'abc12345', tokenValue: 'v1.0-supersecret' }),
    })
    const secretOutputs = createSecretOutputRegistry()

    const outputs = await applyInstances([minter], { ...opts, secretOutputs })

    expect(secretOutputs.redactOutputs(minter, outputs.get('token'))).toEqual({
      tokenId: 'abc12345',
      tokenValue: '[redacted]',
    })
    expect(outputs.get('token')).toEqual({ tokenId: 'abc12345', tokenValue: 'v1.0-supersecret' })
  })

  test("an ephemeral instance of a module whose credential rotates 'never' is refused", async () => {
    let applied = false
    const held = fakeInstance('service-token', {
      ephemeral: true,
      withDestroy: true,
      secretOutputs: { clientSecret: { rotates: 'never' } },
      apply: async () => {
        applied = true
        return {}
      },
    })

    const err = await asError(applyInstances([held], opts))

    expect(applied).toBe(false)
    expect(err.message).toContain('"service-token" is ephemeral')
    expect(err.message).toContain('"clientSecret"')
  })

  test('a credential minted by an on-demand apply is redacted out of a destroy failure', async () => {
    const minter = fakeInstance('token', {
      withDestroy: true,
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenValue: 'v1.0-supersecret' }),
    })
    const web = fakeInstance('web', {
      imports: [minter],
      destroy: async (_config, ctx) => {
        throw new Error(
          `deleting the worker failed: Bearer ${ctx.output({ from: 'token', output: 'tokenValue' }, 'x')}`,
        )
      },
    })

    const err = await asError(destroyInstances([minter, web], opts))

    expect(err.message).toBe('deleting the worker failed: Bearer [redacted: token.tokenValue]')
  })

  test('a credential that is not a string is redacted from printed text too', async () => {
    const minter = fakeInstance('sa', {
      outputs: z.record(z.unknown()),
      secretOutputs: { key: { rotates: 'each-apply' } },
      apply: async () => ({ key: { private_key: '-----BEGIN PRIVATE KEY-----abc' } }),
    })
    const web = fakeInstance('web', {
      imports: [minter],
      apply: async (_config, ctx) => {
        throw new Error(`google refused ${JSON.stringify(ctx.imports.sa)}`)
      },
    })

    const err = await asError(applyInstances([web, minter], opts))

    expect(err.message).not.toContain('BEGIN PRIVATE KEY')
    expect(err.message).toContain('[redacted: sa.key]')
  })

  test('an error carrying the credential in a field, not its message, is reduced to a plain Error', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenValue: 'v1.0-supersecret' }),
    })
    const web = fakeInstance('web', {
      imports: [minter],
      apply: async (_config, ctx) => {
        const err = new Error('HTTP 403') as Error & { request?: unknown }
        err.request = {
          headers: {
            authorization: `Bearer ${ctx.output({ from: 'token', output: 'tokenValue' }, 'x')}`,
          },
        }
        throw err
      },
    })

    const err = await asError(applyInstances([web, minter], opts))

    expect(err.message).toBe('HTTP 403')
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('v1.0-supersecret')
  })

  test('an importer that re-emits a credential as its own output still writes [redacted]', async () => {
    const minter = fakeInstance('token', {
      secretOutputs: { tokenValue: { rotates: 'each-apply' } },
      apply: async () => ({ tokenValue: 'v1.0-supersecret' }),
    })
    const web = fakeInstance('web', {
      imports: [minter],
      apply: async (_config, ctx) => ({
        deployUrl: 'https://web.example.com',
        // Undeclared, and a credential all the same.
        usedToken: ctx.output({ from: 'token', output: 'tokenValue' }, 'x'),
      }),
    })
    const secretOutputs = createSecretOutputRegistry()

    const outputs = await applyInstances([web, minter], { ...opts, secretOutputs })

    expect(secretOutputs.redactOutputs(web, outputs.get('web'))).toEqual({
      deployUrl: 'https://web.example.com',
      usedToken: '[redacted: token.tokenValue]',
    })
  })

  test("destroy refuses to apply a rotates: 'never' instance on demand", async () => {
    let applied = false
    const held = fakeInstance('service-token', {
      withDestroy: true,
      secretOutputs: { clientSecret: { rotates: 'never' } },
      apply: async () => {
        applied = true
        return { clientSecret: 'held-by-an-agent' }
      },
    })
    const web = fakeInstance('web', {
      imports: [held],
      destroy: async (_config, ctx) => {
        ctx.output({ from: 'service-token', output: 'clientSecret' }, 'x')
      },
    })

    const err = await asError(destroyInstances([held, web], opts))

    expect(applied).toBe(false)
    expect(err.message).toContain('"clientSecret"')
    expect(err.message).toContain("rotates: 'never'")
  })
})
