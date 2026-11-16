// The inbox's Durable Object class, as this Worker defines it (the space's ADR 0017).
//
// The class is packages/inbox/src/durable.ts, the very file the inbox's own Worker builds it from, with TWO differences that are this Worker's environment and not behaviour: the knowledge app the
// assistant asks before it drafts, and the Clients part's inbox face for the reads the object runs whole. In the inbox's Worker `KNOWLEDGE` is a service binding to the knowledge Worker; in this one `KNOWLEDGE` is the knowledge store's own class, so the object
// asks it in-process (src/inbox-knowledge.ts); and the Clients face is made over the Clients store (src/inbox-clients.ts). The subclass overrides those two methods and nothing else, under the same exported name (the class's identity is its name).

import { InboxDO as InboxStoreDO } from '@space/inbox/src/durable'
import { bundledInstall } from '@space/knowledge/src/workspace'
import { clientsForInbox } from './inbox-clients'
import { knowledgeForInbox } from './inbox-knowledge'

export class InboxDO extends InboxStoreDO {
  protected override knowledgePort(env: ConstructorParameters<typeof InboxStoreDO>[1]) {
    return knowledgeForInbox((env as unknown as { KNOWLEDGE?: DurableObjectNamespace }).KNOWLEDGE, bundledInstall) as never
  }

  /** The Clients part's inbox face for the space's reads the object runs whole (packages/inbox/src/space-reads.ts): made over the Clients store, as src/parts.ts makes it for the Worker's part. */
  protected override clientsPort(env: ConstructorParameters<typeof InboxStoreDO>[1]) {
    return clientsForInbox((env as unknown as { CLIENTS_STORE?: DurableObjectNamespace }).CLIENTS_STORE) as never
  }
}
