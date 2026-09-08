import { describe, expect, test } from 'bun:test'
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

describe('ephemeral outputs', () => {
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
})
