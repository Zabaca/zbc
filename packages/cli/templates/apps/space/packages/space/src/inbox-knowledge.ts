// The knowledge app as the inbox's assistants and Claude's `knowledge` routes are given it, asked IN-PROCESS.
//
// The inbox is not a Worker of its own with a service binding to a knowledge Worker's `InboxKnowledgeAccess`, which would read the store through a binding to this Worker's class. In this Worker the
// store is bound directly (`KNOWLEDGE`, the knowledge store's own Durable Object class), so the very same face (`createInboxKnowledge`: the active entries, the base and a proposal, and nothing that
// edits, removes or approves) is made over it here. Two places use it: the inbox's part (Claude's door, src/parts.ts) and the inbox's Durable Object (src/inbox-do.ts), which runs with THIS Worker's
// environment once the transfer has handed it over.

import { createInboxKnowledge } from '@space/knowledge/src/inbox'
import { storeFor } from '@space/knowledge/src/store-access'
import type { Install, KnowledgeForInbox } from '@space/workspace'

export function knowledgeForInbox(knowledge: DurableObjectNamespace | undefined, install: Install): KnowledgeForInbox | undefined {
  return knowledge ? createInboxKnowledge({ store: storeFor({ KNOWLEDGE: knowledge as never }), install }) : undefined
}
