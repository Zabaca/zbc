// A stand-in for the Clients part, for forms' LOCAL Worker (dev/worker.ts) and its tests, and for nothing else.
//
// In the space's Worker forms is handed the Clients part's inbox face (`Env.CLIENTS_READ`: the list and one Client, read only), and the names of a Client come from there when signing is set up for it or a row is linked to it
// (src/client-names.ts). Forms' own local Worker has no Clients part, so this keeps the Clients in memory and answers the same face. The end-to-end suites and `bun run dev` make a Client here (`add`, or the dev route in dev/worker.ts) and
// then set up signing for its number, which is what the space's screens do against the real part.
import { answered, type Client, type ClientsForInbox, refused } from '@space/workspace'

export interface DevClientInput {
  name: string
  legalName?: string | null
  archived?: boolean
  /** A number to take; otherwise the next one from 1001 (where the space numbers the Clients made in it). */
  number?: number
}

export interface DevClients {
  /** The face forms is handed. */
  face: ClientsForInbox
  all(): Client[]
  add(input: DevClientInput): Client
  /** Change a Client's names or archive it, as Settings would. */
  change(number: number, patch: { name?: string; legalName?: string | null; archived?: boolean }): Client | null
  /** Make the next calls fail, as an unreachable Clients part would. */
  down: boolean
}

const NOW = Date.parse('2026-11-08T12:00:00Z')

export function devClients(seed: DevClientInput[] = []): DevClients {
  const held = new Map<number, Client>()
  let next = 1001
  const state: DevClients = {
    down: false,
    all: () => [...held.values()].sort((a, b) => a.number - b.number),
    add(input) {
      const number = input.number ?? next
      next = Math.max(next, number + 1)
      const client: Client = {
        number,
        name: input.name,
        legalName: input.legalName ?? null,
        createdAt: NOW,
        createdBy: 'dev',
        updatedAt: NOW,
        updatedBy: 'dev',
        archivedAt: input.archived ? NOW : null,
        archivedBy: input.archived ? 'dev' : null,
        revision: 1,
        source: null,
      }
      held.set(number, client)
      return client
    },
    change(number, patch) {
      const was = held.get(number)
      if (!was) return null
      const client: Client = {
        ...was,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.legalName !== undefined && { legalName: patch.legalName }),
        ...(patch.archived !== undefined && { archivedAt: patch.archived ? NOW : null, archivedBy: patch.archived ? 'dev' : null }),
        revision: was.revision + 1,
      }
      held.set(number, client)
      return client
    },
    face: {
      async list() {
        if (state.down) throw new Error('the Clients part is down')
        return answered(state.all())
      },
      async get(number) {
        if (state.down) throw new Error('the Clients part is down')
        const client = held.get(number)
        return client ? answered(client) : refused('not-found', 'No such Client.')
      },
    },
  }
  for (const s of seed) state.add(s)
  return state
}

/**
 * The Clients part as the SPACE'S LOCAL PREVIEW holds them, read over HTTP: for the end-to-end suites of the Forms tab, where forms' Worker and the space's preview run side by side and must agree on which Clients exist (the space's fixtures,
 * and the ones made in Settings while the suite runs). It asks the preview's own `/api/clients/list` (the dev bypass makes the caller the owner, on localhost) and reads the Clients' numbers, names and whether each is archived out of it.
 */
export function clientsFromSpace(base: string): ClientsForInbox {
  interface Row {
    number: number
    name: string
    legalName: string | null
    archivedAt: number | null
  }
  const read = async (): Promise<Client[]> => {
    const res = await fetch(`${base}/api/clients/list`, { headers: { accept: 'application/json' } })
    const body = (await res.json()) as { result: string; value?: { active: Row[]; archived: Row[] } }
    if (!res.ok || body.result !== 'ok' || !body.value) throw new Error(`the space did not list its Clients (${res.status})`)
    return [...body.value.active, ...body.value.archived]
      .map((r): Client => ({ number: r.number, name: r.name, legalName: r.legalName, createdAt: NOW, createdBy: 'space', updatedAt: NOW, updatedBy: 'space', archivedAt: r.archivedAt, archivedBy: r.archivedAt === null ? null : 'space', revision: 1, source: null }))
      .sort((a, b) => a.number - b.number)
  }
  return {
    async list() {
      return answered(await read())
    },
    async get(number) {
      const found = (await read()).find((c) => c.number === number)
      return found ? answered(found) : refused('not-found', 'No such Client.')
    },
  }
}
