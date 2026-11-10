import { describe, expect, mock, test } from 'bun:test'
import { INBOX_NAME, storeFor } from '../src/store-access'

/**
 * A DEPLOY HEALS ITSELF. After `zbc apply production space` the inbox's Durable Object kept running the previous
 * code for minutes while the new Worker called a store method it did not have (`mailScope`): every inbox call answered 500 "No such method: mailScope" until the operator restarted the object by hand. The Worker now answers
 * that one error by asking the object to restart, once, and calling again on a fresh stub (a stub whose target was aborted is broken for good, as packages/calendar/src/store-access.ts notes).
 *
 * The fake below is an object as the outage had it: a generation that lacks the new method, which `restart()` replaces with the new code the way `ctx.abort` does, failing the call that made it and every call on the stub after it.
 */

type Generation = 'old' | 'new'

function fakeNamespace(opts: { staysOld?: boolean } = {}) {
  let generation: Generation = 'old'
  const seen: string[] = []
  const stubs: object[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      expect(id).toBe(INBOX_NAME)
      const born = generation
      let broken = false
      const stub = {
        call: async (method: string, args: unknown[]) => {
          seen.push(`${born}:${method}`)
          if (broken) throw new Error('restarted on the owner’s word')
          if (born === 'old' && method === 'mailScope') throw new Error(`No such method: ${method}`)
          if (method === 'boom') throw new Error('The store says no')
          return { method, args, by: born }
        },
        restart: async () => {
          seen.push(`${born}:restart`)
          broken = true
          if (!opts.staysOld) generation = 'new'
          throw new Error('restarted on the owner’s word')
        },
      }
      stubs.push(stub)
      return stub
    },
  }
  return { namespace, seen, stubs }
}

const storeOf = (ns: unknown) =>
  storeFor({ INBOX: ns as never }) as unknown as { call(method: string, ...args: unknown[]): Promise<unknown> }

describe('a store object still on the previous code', () => {
  test('is asked to restart once and the call is made again on a fresh stub, so the caller gets its answer', async () => {
    const { namespace, seen, stubs } = fakeNamespace()
    const warn = mock(() => {})
    const was = console.warn
    console.warn = warn as never
    try {
      expect(await storeOf(namespace).call('mailScope', 'tessa@northfield.example')).toEqual({
        method: 'mailScope',
        args: ['tessa@northfield.example'],
        by: 'new',
      })
    } finally {
      console.warn = was
    }
    expect(seen).toEqual(['old:mailScope', 'old:mailScope', 'old:restart', 'new:mailScope'])
    expect(stubs).toHaveLength(4)
    // The line a person reads in the Worker's tail to know the deploy healed itself.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String((warn.mock.calls as unknown as string[][])[0]?.[0])).toContain('No such method: mailScope')
  })

  test('is restarted only once: an object that is still without the method after its restart fails the call with the same error', async () => {
    const { namespace, seen } = fakeNamespace({ staysOld: true })
    const was = console.warn
    console.warn = (() => {}) as never
    try {
      await expect(storeOf(namespace).call('mailScope')).rejects.toThrow('No such method: mailScope')
    } finally {
      console.warn = was
    }
    expect(seen).toEqual(['old:mailScope', 'old:mailScope', 'old:restart', 'old:mailScope'])
  })

  test('two callers that fail together restart the object at most once, and both get their answer', async () => {
    const { namespace, seen } = fakeNamespace()
    const was = console.warn
    console.warn = (() => {}) as never
    try {
      const store = storeOf(namespace)
      const [a, b] = await Promise.all([store.call('mailScope', 'a'), store.call('mailScope', 'b')])
      expect(a).toMatchObject({ method: 'mailScope', by: 'new' })
      expect(b).toMatchObject({ method: 'mailScope', by: 'new' })
    } finally {
      console.warn = was
    }
    expect(seen.filter((s) => s.endsWith(':restart'))).toHaveLength(1)
  })

  test('is not restarted when another caller already did: the second call, on a fresh stub, finds the new code', async () => {
    let calls = 0
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        call: async (method: string) => {
          calls += 1
          if (calls === 1) throw new Error(`No such method: ${method}`)
          return { method, by: 'new' }
        },
        restart: async () => {
          throw new Error('nobody should restart')
        },
      }),
    }
    expect(await storeOf(namespace).call('mailScope')).toEqual({ method: 'mailScope', by: 'new' })
    expect(calls).toBe(2)
  })

  test('a restart that fails for a reason other than the abort is logged, and the retry still decides the call', async () => {
    const errors = mock(() => {})
    const was = { warn: console.warn, error: console.error }
    console.warn = (() => {}) as never
    console.error = errors as never
    let generation = 'old'
    const namespace = {
      idFromName: (name: string) => name,
      get: () => {
        const born = generation
        return {
          call: async (method: string) => {
            if (born === 'old') throw new Error(`No such method: ${method}`)
            return { method, by: born }
          },
          restart: async () => {
            generation = 'new'
            throw new Error('the network dropped')
          },
        }
      },
    }
    try {
      expect(await storeOf(namespace).call('mailScope')).toEqual({ method: 'mailScope', by: 'new' })
    } finally {
      console.warn = was.warn
      console.error = was.error
    }
    expect(errors).toHaveBeenCalledTimes(1)
  })

  test('is not restarted for any other error, or for a method it has', async () => {
    const { namespace, seen } = fakeNamespace()
    await expect(storeOf(namespace).call('boom')).rejects.toThrow('The store says no')
    expect(await storeOf(namespace).call('queue')).toEqual({ method: 'queue', args: [], by: 'old' })
    expect(seen).toEqual(['old:boom', 'old:queue'])
  })

  test('a refusal of some other method, named inside another error, is not taken for the one asked', async () => {
    const restarts: string[] = []
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        call: async () => {
          throw new Error('mailScope failed: No such method: somethingElse')
        },
        restart: async () => {
          restarts.push('restart')
        },
      }),
    }
    await expect(storeOf(namespace).call('queue')).rejects.toThrow('No such method: somethingElse')
    expect(restarts).toEqual([])
  })
})
