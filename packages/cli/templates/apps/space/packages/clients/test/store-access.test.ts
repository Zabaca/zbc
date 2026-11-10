// The Clients store's typed face and the operator's three get a fresh stub for every call: the inbox's object will hold this face for as long as it lives (once it reads Clients here), and a stub whose target was
// aborted by the owner's restart route is broken for good.
import { describe, expect, test } from 'bun:test'
import { objectFor, storeFor } from '../src/store-access'

/** A namespace whose stubs die when the object is restarted: a stub made before the restart fails every call after it. */
function namespace() {
  let generation = 0
  let gets = 0
  const ns = {
    idFromName: (name: string) => name,
    get: () => {
      gets += 1
      const made = generation
      const alive = () => {
        if (made !== generation) throw new Error("restarted on the owner's word")
      }
      return {
        call: async (method: string, args: unknown[]) => (alive(), { method, args }),
        bookmark: async () => (alive(), 'BM'),
        counts: async () => (alive(), { clients: 0 }),
        restart: async () => {
          alive()
          generation += 1
          throw new Error('reset under the call')
        },
      }
    },
  }
  return { ns, restart: () => (generation += 1), gets: () => gets }
}

describe('storeFor and objectFor', () => {
  test('a call after the Clients store was restarted works, because each call gets its own stub', async () => {
    const { ns, restart, gets } = namespace()
    const store = storeFor({ CLIENTS_STORE: ns as never }) as unknown as { call(method: string, ...args: unknown[]): Promise<unknown> }
    await store.call('list')
    restart()
    expect(await store.call('get', 7)).toEqual({ method: 'get', args: [7] })
    expect(gets()).toBe(2)
  })

  test('the operator’s three do too: a bookmark and the counts after a restart, and a restart after a restart', async () => {
    const { ns, restart } = namespace()
    const object = objectFor({ CLIENTS_STORE: ns as never })
    expect(await object.bookmark()).toBe('BM')
    restart()
    expect(await object.bookmark()).toBe('BM')
    restart()
    expect(await object.counts()).toEqual({ clients: 0 } as never)
    restart()
    await expect(object.restart()).rejects.toThrow('reset under the call')
  })
})
