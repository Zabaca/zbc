/**
 * The Clients part's face for the inbox: the list and one Client, which is all the inbox reads of a Client (its menu, its pills, People, Settings' pages, Claude's routes). It is called in-process in the space's
 * Worker (packages/space/src/parts.ts), with its store passed in.
 *
 * NO ASSERTION, and that is the design, as the knowledge app's face for the inbox takes none: this face has no route and no hostname, so only code in the space's Worker reaches it, and it can only READ. It has no
 * method that makes, edits or archives a Client: those exist on the space's face alone, behind the owner's sign-in, and a source's pushes on the Clients door's face alone, behind its service token.
 */

import type { Client, ClientsForInbox, SpaceReply } from '@space/workspace'
import { guarded, reply } from './reply'
import type { StoreApi } from './store'

export interface InboxClientsDeps {
  store: StoreApi
}

/** The inbox's entrypoint, over a store. */
export function createInboxClients(deps: InboxClientsDeps): ClientsForInbox {
  const { store } = deps
  return {
    list: () => guarded('reading the list', async (): Promise<SpaceReply<Client[]>> => reply(await store.call('list'))),
    get: (number) => guarded('reading one Client', async (): Promise<SpaceReply<Client>> => reply(await store.call('get', number))),
  }
}
