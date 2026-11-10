// What the knowledge app answers: the interfaces of its two named entrypoints, method by method (knowledge is kept per
// business; the package is packages/knowledge).
//
// ONE KNOWLEDGE BASE FOR THE INSTALL. Every entry is marked with the businesses it is for (the declaration's `businesses`, ids as
// `Business.id`), and a business's assistant reads only the ACTIVE entries marked for it. "Every business" is a control in the tab
// that ticks the declared businesses; what is stored is that list, so a business added later starts with none.
//
// TWO FACES, because they are asked by two different kinds of caller:
//
// - `KnowledgeForSpace`: the Knowledge tab. It runs INSIDE the space's Worker (docs/adr/0003), as the knowledge store's Durable Object
//   does since the store was handed over to the space, so it is a call and not a binding. EVERY METHOD takes the person the space's one
//   sign-in check named (`SignedIn`), then admits the install's owner and no one else. A service token is never a person, so none comes
//   through. The reads show every status; the changes are the owner's alone.
// - `KnowledgeForInbox` (called in-process in the space's Worker, as the inbox runs there): the inbox's assistants and Claude's script, which reaches the inbox on the
//   inbox's own address with its own token and has the inbox hand its reads and proposals on. It takes NO assertion, as the site's
//   client directory takes none from the inbox: it has no route, so only a Worker with the binding can call it, and the only thing it
//   can write is a PROPOSAL, which nothing reads until the owner approves it. It cannot edit, remove or approve anything. A proposal
//   names who proposes (`by`), and only an agent (`agent:` and a token's client id) may.
//
// Every method answers a `SpaceReply`, as data and never an exception. TIMES are milliseconds since the epoch.

import type { SignedIn, SpaceReply } from './asking'

/** The longest title and body an entry keeps. The active ones are all in every prompt, so a long one is a cost on every email. */
export const KNOWLEDGE_MAX_TITLE = 200
export const KNOWLEDGE_MAX_BODY = 10_000

/** The most proposals waiting at once across the whole base: a flood of them is not a way to bury what the owner is shown. */
export const KNOWLEDGE_MOST_PROPOSALS = 50

/** How an agent's actor begins (the inbox stamps `agent:` and Claude's token id): the only actors that may propose. */
export const KNOWLEDGE_AGENT_PREFIX = 'agent:'

export const KNOWLEDGE_ENTRY_STATUSES = ['active', 'proposed', 'removed'] as const
export type KnowledgeEntryStatus = (typeof KNOWLEDGE_ENTRY_STATUSES)[number]

/** One version of an entry: who wrote it and when, and the entry as it was then. Never edited or deleted. */
export interface KnowledgeVersion {
  seq: number
  by: string
  at: number
  title: string
  body: string
  /** The businesses it was for at this version (`Business.id`s, in the declaration's order). A change of these alone is a version. */
  businesses: string[]
}

export interface KnowledgeEntry {
  id: string
  title: string
  body: string
  /** The businesses whose assistants read it once it is active (`Business.id`s, in the declaration's order). At least one. */
  businesses: string[]
  /** `active` is what the assistants read and quote to customers; `proposed` waits for the owner; `removed` is read by nobody and its history is kept. */
  status: KnowledgeEntryStatus
  /** Who proposed it, when it is or was a proposal. */
  proposedBy: string | null
  /** For a proposed change: the entry it would change. */
  replaces: string | null
  /** For a proposed change: the version of that entry it was written against. Approving it is refused as `conflict` once the entry has moved past it. */
  replacesVersion: number | null
  createdAt: number
  createdBy: string
  updatedAt: number
  updatedBy: string
  /** How many versions it has: what every change names, so one made over a screen that is out of date is `conflict`. */
  version: number
  /** Every version, oldest first. */
  versions: KnowledgeVersion[]
}

/** A business as the tab and the script name it. */
export interface KnowledgeBusiness {
  id: string
  name: string
}

/**
 * The knowledge base: the install's businesses (for the row of choices) and the entries, every status, each with its history, in the
 * order the tab shows them: active, proposed, removed, each oldest first. With a business named, only the entries marked for it, which
 * is exactly what its assistant reads once the active ones are taken.
 */
export interface KnowledgeBase {
  businesses: KnowledgeBusiness[]
  /** The business asked for, or null for all. */
  business: string | null
  entries: KnowledgeEntry[]
}

/**
 * A change made in the tab. `add` makes an entry active at once, so it is refused as `conflict` when an active entry already has the
 * same title and body, whatever its businesses (add the business to that entry instead). Every other change names the `version` the
 * person was shown. An `edit` may change the words, the businesses or both; a change of businesses is a new version. Every list of
 * businesses has at least one, each declared.
 */
export type KnowledgeChange =
  | { do: 'add'; title: string; body: string; businesses: string[] }
  | { do: 'edit'; id: string; version: number; title?: string; body?: string; businesses?: string[] }
  | { do: 'remove' | 'restore' | 'approve' | 'reject'; id: string; version: number }

/**
 * What Claude proposes. A NEW entry needs a title, a body and businesses. A CHANGE (`replaces`: the entry's id) may change the words,
 * the businesses or both, and what it leaves out is the entry's; at least one must be given. Approving a change applies it as the
 * owner's edit, and is refused as `conflict` if the entry has been changed since the proposal (`KnowledgeEntry.replacesVersion`).
 * Only an active entry can be changed by a proposal.
 */
export interface KnowledgeProposal {
  title?: string
  body?: string
  businesses?: string[]
  replaces?: string | null
}

/** What an assistant is given: an active entry's words and nothing else. */
export interface KnowledgeText {
  title: string
  body: string
}

/** What the space calls in-process for the Knowledge tab. The tab is drawn from, and changes, these. */
export interface KnowledgeForSpace {
  /** The whole base, or one business's entries. Owner only. */
  knowledge(asker: SignedIn, business?: string): Promise<SpaceReply<KnowledgeBase>>
  /** Add, edit, remove, put back, approve or reject. Owner only. Answers the entry as it now stands (for an approved change, the entry it changed). */
  changeKnowledge(asker: SignedIn, change: KnowledgeChange): Promise<SpaceReply<KnowledgeEntry>>
  /**
   * The store's restore point: Cloudflare's bookmark of the knowledge object's history as it stands now (the object keeps 30 days; a bookmark taken before a transfer has been shown to restore after it).
   * Owner only. For the operator of a move, not a screen of the Knowledge tab: the space answers it on a POST of its own.
   */
  storeBookmark(asker: SignedIn): Promise<SpaceReply<KnowledgeBookmark>>
  /**
   * Restart the knowledge object: its in-memory state is dropped and its next call starts it afresh, under the code of the Worker that owns its class. A MOVED object keeps running the giving Worker's
   * code until it restarts, so the move ends with this. Owner only.
   */
  restartStore(asker: SignedIn): Promise<SpaceReply<{ restarted: true }>>
  /**
   * Put the store back to a bookmark, dropping everything written since (the last resort; a transfer back is the other tool). Arms the restore for the object's next start and restarts it. Owner only.
   */
  restoreStore(asker: SignedIn, bookmark: string): Promise<SpaceReply<{ restoring: true }>>
}

/** A bookmark of the knowledge object's history, as Cloudflare names it. */
export interface KnowledgeBookmark {
  bookmark: string
}

/** What a bookmark looks like (`00000000-00000006-00005118-0123456789abcdef0123456789abcdef`): checked before one is handed to the object. */
export const KNOWLEDGE_BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/

/** The knowledge app's face for the inbox, called in-process in the space's Worker. No assertion; it can read and propose and do nothing else. */
export interface KnowledgeForInbox {
  /** A business's ACTIVE entries, oldest first, when the owner asks an assistant for a reply. Empty is a state, not an error. `not-found` for a business the declaration does not list. */
  activeFor(business: string): Promise<SpaceReply<KnowledgeText[]>>
  /** The base for Claude's script: all of it, or one business's entries, every status. */
  readBase(business?: string): Promise<SpaceReply<KnowledgeBase>>
  /** Claude proposes an entry, or a change to one. `by` is the proposer's actor and must be an agent's. Nothing reads a proposal until the owner approves it. */
  propose(by: string, proposal: KnowledgeProposal): Promise<SpaceReply<KnowledgeEntry>>
}

/** The method names, so a stub, a test and the binding agree on exactly these and no others. */
export const KNOWLEDGE_FOR_SPACE_METHODS = ['knowledge', 'changeKnowledge', 'storeBookmark', 'restartStore', 'restoreStore'] as const satisfies readonly (keyof KnowledgeForSpace)[]
export const KNOWLEDGE_FOR_INBOX_METHODS = ['activeFor', 'readBase', 'propose'] as const satisfies readonly (keyof KnowledgeForInbox)[]
