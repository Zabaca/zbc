// The Clients part as the inbox is given it, asked IN-PROCESS (the space's ADR 0021).
//
// The inbox does not read an outside Client directory over a service binding (`CLIENTS`): that binding, the parser of its answer and the dev stand-in are gone, and the inbox is handed the Clients part's
// inbox face (`createInboxClients`: the list and one Client, and nothing that writes) over the Clients store this Worker owns, the way it is handed the knowledge app (src/inbox-knowledge.ts). It is
// made over `storeFor`, which gets a FRESH stub for every call: the inbox's part holds this face for as long as the Worker's isolate lives, and a stub kept across a restart of the Clients store
// (the owner's restart route resets the object) would fail every call after it.

import { createInboxClients } from '@space/clients/src/inbox'
import { storeFor } from '@space/clients/src/store-access'
import type { ClientsForInbox } from '@space/workspace'

export function clientsForInbox(clients: DurableObjectNamespace | undefined): ClientsForInbox | undefined {
  return clients ? createInboxClients({ store: storeFor({ CLIENTS_STORE: clients as never }) }) : undefined
}
