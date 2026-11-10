// The knowledge store's typed face gets a fresh stub for every call: the inbox's object holds this face for as long as it lives (packages/space/src/inbox-knowledge.ts), and a stub whose target was aborted by the
// owner's restart route is broken for good.
import { describe, expect, test } from 'bun:test'
import { storeFor } from '../src/store-access'

describe('storeFor', () => {
  test('a call after the knowledge store was restarted works', async () => {
    let generation = 0
    const ns = {
      idFromName: (name: string) => name,
      get: () => {
        const made = generation
        return {
          call: async (method: string, args: unknown[]) => {
            if (made !== generation) throw new Error("restarted on the owner's word")
            return { method, args }
          },
        }
      },
    }
    const store = storeFor({ KNOWLEDGE: ns as never }) as unknown as { call(method: string, ...args: unknown[]): Promise<unknown> }
    await store.call('activeFor', 'x')
    generation += 1
    expect(await store.call('activeFor', 'x')).toEqual({ method: 'activeFor', args: ['x'] })
  })
})
