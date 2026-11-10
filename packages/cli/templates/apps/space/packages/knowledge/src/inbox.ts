/**
 * The knowledge app's face for the inbox: what an assistant is given when the owner asks it for a reply, what Claude's script
 * reads, and what Claude proposes. It is called in-process in the space's Worker (packages/space/src/inbox-knowledge.ts), with its store passed in.
 *
 * NO ASSERTION, and that is the design, as the inbox's binding to the site's client directory takes none: this face has no
 * route and no hostname, so only code in the space's Worker reaches it, and the ONLY thing it can write is a proposal,
 * which nothing reads until the owner approves it in the tab. It has no method that edits, removes or approves: those exist on the
 * space's entrypoint alone, behind the owner's sign-in. A proposal names who proposes, and the store refuses any proposer that is not
 * an agent (`agent:` and a token's client id), so the owner's own address cannot be passed off through here either.
 */

import type { Install, KnowledgeBase, KnowledgeEntry, KnowledgeForInbox, KnowledgeProposal, KnowledgeText, SpaceReply } from '@space/workspace'
import { BAD, ENTRY_ID, guarded, isRecord, isText, readBase, reply, textList } from './reply'
import type { StoreApi } from './store'

export interface InboxKnowledgeDeps {
  store: StoreApi
  install: Install
}

/** A proposal, read: what the inbox handed on is checked for its shape, and the store judges the rest. */
function readProposal(raw: unknown): { ok: true; proposal: KnowledgeProposal } | ReturnType<typeof BAD> {
  if (!isRecord(raw)) return BAD('A proposal is an object.')
  const proposal: KnowledgeProposal = {}
  if (raw.title !== undefined) {
    if (!isText(raw.title)) return BAD('The title is text.')
    proposal.title = raw.title
  }
  if (raw.body !== undefined) {
    if (!isText(raw.body)) return BAD('The body is text.')
    proposal.body = raw.body
  }
  if (raw.businesses !== undefined) {
    const list = textList(raw.businesses)
    if (list === null) return BAD('The businesses are a list.')
    proposal.businesses = list
  }
  if (raw.replaces !== undefined && raw.replaces !== null) {
    if (!isText(raw.replaces) || !ENTRY_ID.test(raw.replaces)) return BAD('The entry to change is named by its id.')
    proposal.replaces = raw.replaces
  }
  return { ok: true, proposal }
}

/** The inbox's entrypoint, over a store. */
export function createInboxKnowledge(deps: InboxKnowledgeDeps): KnowledgeForInbox {
  const { store, install } = deps

  return {
    activeFor: (business) =>
      guarded('reading the active entries', async (): Promise<SpaceReply<KnowledgeText[]>> => reply(await store.call('activeFor', business))),

    readBase: (business) =>
      guarded('reading the base', async (): Promise<SpaceReply<KnowledgeBase>> => readBase(store, install, business ?? null)),

    propose: (by, proposal) =>
      guarded('taking a proposal', async (): Promise<SpaceReply<KnowledgeEntry>> => {
        if (!isText(by)) return BAD('Say who proposes.')
        const read = readProposal(proposal)
        if (!read.ok) return read
        return reply(await store.call('propose', read.proposal, by))
      }),
  }
}
