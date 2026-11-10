// How the calendar reaches the other objects (src/store-access.ts): a fresh stub for every call. A stub whose target was reset or aborted is broken for good (Cloudflare's documentation), and once the
// inbox's owner-route restart (`ctx.abort`) left the calendar object failing every ask of the inbox until the calendar itself restarted, because it had made its stub once, in its constructor.
import { describe, expect, test } from 'bun:test'
import { engineFor, inboxFor } from '../src/store-access'

/** A namespace whose stubs break for good once the object behind them is aborted; a stub got after the abort works. */
function namespace() {
  let generation = 0
  const gets: string[] = []
  return {
    abort: () => {
      generation += 1
    },
    gets,
    ns: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        gets.push(name)
        const made = generation
        return {
          call: async (method: string, args: unknown[]) => {
            if (made !== generation) throw new Error("The Durable Object was restarted on the owner's word")
            return { method, args }
          },
        }
      },
    },
  }
}

describe('a restarted object is asked again at once', () => {
  test('the inbox: grants and access work after an abort, each ask on a stub of its own', async () => {
    const world = namespace()
    const inbox = inboxFor({ INBOX: world.ns as never })
    expect(await inbox.grants()).toEqual({ method: 'calendarGrants', args: [] } as never)
    world.abort()
    expect(await inbox.grants()).toEqual({ method: 'calendarGrants', args: [] } as never)
    expect(await inbox.access('tessa@northfield.example', true)).toEqual({ method: 'calendarAccess', args: ['tessa@northfield.example', true] } as never)
    expect(world.gets).toEqual(['inbox', 'inbox', 'inbox'])
  })

  test('the calendar, as the space asks it', async () => {
    const world = namespace()
    const engine = engineFor({ CALENDAR: world.ns as never })
    await engine.call('syncNow')
    world.abort()
    expect(await engine.call('syncNow')).toEqual({ method: 'syncNow', args: [] } as never)
  })
})
