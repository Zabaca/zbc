// The inbox's Durable Object class, as this Worker defines it (the space's ADR 0017).
//
// The class is packages/inbox/src/durable.ts, the very file the inbox's own Worker builds it from, with ONE difference that is this Worker's environment and not behaviour: the knowledge app the
// assistant asks before it drafts. In the inbox's Worker `KNOWLEDGE` is a service binding to the knowledge Worker; in this one `KNOWLEDGE` is the knowledge store's own class, so the object
// asks it in-process (src/inbox-knowledge.ts). The subclass overrides that one method and nothing else, under the same exported name (the class's identity is its name).

import { InboxDO as InboxStoreDO } from '@space/inbox/src/durable'
import { bundledInstall } from '@space/knowledge/src/workspace'
import { knowledgeForInbox } from './inbox-knowledge'

export class InboxDO extends InboxStoreDO {
  protected override knowledgePort(env: ConstructorParameters<typeof InboxStoreDO>[1]) {
    return knowledgeForInbox((env as unknown as { KNOWLEDGE?: DurableObjectNamespace }).KNOWLEDGE, bundledInstall) as never
  }
}
