/**
 * The Clients part's face for a SOURCE: what an outside system that keeps Clients of its own may do to the space's list, and nothing else. It is the other end of the Clients door (packages/space/src/clients-door.ts),
 * which verified the service token and then calls this, so it takes no assertion; it is made for ONE source, the one the company declaration names (`clientsDoor.source`), and stamps every change `source:<name>`.
 * The store refuses a push in any other name, so a face made for one source cannot be pointed at another's Clients.
 *
 * It depends on no source: the space never asks one. A sender pushes, and this face is all it can reach. The rules are the store's: the source's name wins until a name is edited in the space; a Client the
 * source says is gone is marked and kept, never archived or deleted; a Client keeps the number the source asks for when it is free. Nothing about any particular source is written here.
 */

import {
  type ClientGone,
  type ClientListing,
  type ClientsForSource,
  type ClientsSynced,
  type ClientUpserted,
  type SpaceReply,
  sourceActor,
} from '@space/workspace'
import { guarded, reply } from './reply'
import type { StoreApi } from './store'

export interface SourceClientsDeps {
  store: StoreApi
  /** The declared source's name: the declaration's `clientsDoor.source`. */
  source: string
}

/** The source's entrypoint, over a store. */
export function createSourceClients(deps: SourceClientsDeps): ClientsForSource {
  const { store, source } = deps
  const actor = sourceActor(source)
  return {
    list: () => guarded('listing the source’s Clients', async (): Promise<SpaceReply<ClientListing[]>> => reply(await store.call('listing', source, actor))),
    upsert: (id, fields) => guarded('taking a Client', async (): Promise<SpaceReply<ClientUpserted>> => reply(await store.call('upsertExternal', source, id, fields, actor))),
    gone: (id) => guarded('marking a Client gone', async (): Promise<SpaceReply<ClientGone>> => reply(await store.call('markGone', source, id, actor))),
    sync: (clients) => guarded('taking the full set', async (): Promise<SpaceReply<ClientsSynced>> => reply(await store.call('syncExternal', source, clients, actor))),
  }
}
