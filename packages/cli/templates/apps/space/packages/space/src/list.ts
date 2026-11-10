// What the Inbox's and Meet's screens ask of the Worker, and how the two apps behind it are asked.
//
// The list is two READS in parallel, each given `ANSWER_WITHIN_MS` and each allowed to fail on its own: the inbox's `people` and
// meet's `conversations`, merged by conversations.ts. Both are parts that run in this Worker, handed the person the one sign-in check named
// (packages/workspace/docs/adr/0003). Nothing is stored here.

import {
  ANSWER_WITHIN_MS,
  type FailureReason,
  type CalendarForSpace,
  type ClientsForSpace,
  type FormsClientNames,
  type FormsForSpace,
  type InboxForSpace,
  type InboxHit,
  type InboxParty,
  type KnowledgeForSpace,
  type MeetForSpace,
  type PartStatus,
  type SignedIn,
  type Reached,
  type Install,
  type Refused,
  type SpacePart,
} from '@space/workspace'
import { type ConversationsAnswer, type Scope, type View, inboxScopeFor, mergeConversations } from './conversations'
import { looseDraftsOf } from './drafts'
import { isInboxDrafts, isInboxPeople, isInboxSearch, isMeetOverview, notConnected, reach } from './reach'

/**
 * The apps as the space holds them: the inbox's part, meet's part, forms' reads (Today's) and the knowledge app's, all of which run in this Worker
 * and take the person the one sign-in check named (meet's also takes the socket's upgrade request and the dial pad's, for that person).
 */
export interface Apps {
  inbox: InboxForSpace | undefined
  meet: (MeetForSpace & { fetch(request: Request, who: SignedIn): Promise<Response> }) | undefined
  /** Forms' reads, for Today, People and a conversation, called in-process (parts.ts). Absent in a test that draws no documents. */
  forms?: FormsForSpace | undefined
  /** What the Clients part asks of Forms (parts.ts): which Clients have signing settings, and the one writing of Forms' copy of a Client's names. Absent where Forms' database is not bound. */
  formsNames?: FormsClientNames | undefined
  /** The knowledge app, called in-process (parts.ts): the base the Knowledge tab is drawn from and changes. Absent where the store is not bound (a local run with no fixtures): the tab then says it is not connected. */
  knowledge?: KnowledgeForSpace | undefined
  /** The calendar app, called in-process (parts.ts): Google's calendars as it keeps them, for the Calendar tab, Today's events and Settings, Calendars. Absent where its store is not bound: the tab then says it is not connected. */
  calendar?: CalendarForSpace | undefined
  /** The Clients part, called in-process (parts.ts): the one list of Clients. Read by nothing yet but the operator's three (clients.ts). Absent where its store is not bound. */
  clients?: ClientsForSpace | undefined
}

export interface Asking {
  apps: Apps
  install: Install
  /** The person the one sign-in check named, for the parts that run in this Worker (the inbox, forms, knowledge, meet). */
  signedIn: SignedIn
  /** The addresses of the person asking. */
  self: readonly string[]
  answerWithinMs?: number
  /** How long a write is awaited (`WRITE_WITHIN_MS`); a test shortens it. */
  writeWithinMs?: number
  /** The clock, in milliseconds, for what depends on the day (Today). Omitted: the real one. */
  now?: () => number
}

/** How one read fared, whichever app it was asked of: it answered, said no (a decision), or could not be reached (it did not answer). */
export type Outcome = { state: 'ok' } | { state: 'not-open-to-you'; refusal: Refused } | { state: 'could-not-be-reached'; reason: FailureReason }

const APP_OF: Record<SpacePart, string> = { mail: 'the inbox', chat: 'meet', documents: 'forms' }

export function outcomeOf(part: SpacePart, answer: Reached<unknown>): Outcome {
  if (answer.ok) return { state: 'ok' }
  if (answer.kind === 'refused') {
    // The space has just verified this very assertion and named the person, so a part that says it is not signed in is misconfigured,
    // not the person's sign-in: it is logged here, and the page gives no advice to sign in again, which would never help.
    if (answer.reason === 'not-signed-in') console.error(`space: ${APP_OF[part]} refused a person the space had signed in; a part in this Worker should never say so`)
    return { state: 'not-open-to-you', refusal: answer }
  }
  return { state: 'could-not-be-reached', reason: answer.reason }
}

/** How one source fared in the Inbox's or Meet's list, or in a search: `mail` is the inbox, `chat` is meet. */
export const statusOf = (part: 'mail' | 'chat', answer: Reached<unknown>): PartStatus => ({ part, ...outcomeOf(part, answer) })

/**
 * The list of a tab. `scope` `mail` is the Inbox: the inbox alone is asked, so there is not a chat row in it and not a word about chat. `chat` is Meet: meet alone is asked (the
 * main view only), so there is not an email row in it. Absent is both merged, as before the split.
 */
export async function conversations(ask: Asking, view: View, scope?: Scope): Promise<ConversationsAnswer> {
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, meet } = ask.apps
  const wantsMail = scope !== 'chat'
  const wantsChat = view.kind === 'main' && scope !== 'mail'
  // In parallel: the slowest part is the wait, not the sum.
  const [people, chat, drafts] = await Promise.all([
    wantsMail ? (inbox ? reach('Email', () => inbox.people(ask.signedIn, inboxScopeFor(view)), isInboxPeople, ms) : notConnected('Email')) : null,
    wantsChat ? (meet ? reach('Chat', () => meet.conversations(ask.signedIn), isMeetOverview, ms) : notConnected('Chat')) : null,
    // Drafts on no conversation are in no row; the Drafts view lists them above the rows.
    view.kind === 'drafts' ? (inbox ? reach('Email', () => inbox.drafts(ask.signedIn), isInboxDrafts, ms) : notConnected('Email')) : null,
  ])
  // The mail part is as well as its worst read: a list of drafts that could not be read is said, not left out in silence.
  const mail = people !== null && people.ok && drafts !== null && !drafts.ok ? drafts : people
  const parts: PartStatus[] = []
  if (mail) parts.push(statusOf('mail', mail))
  if (chat) parts.push(statusOf('chat', chat))
  const merged = mergeConversations({
    install: ask.install,
    self: ask.self,
    view,
    inbox: people?.ok ? people.value : null,
    meet: chat?.ok ? chat.value : null,
  })
  return { view, parts, ...merged, looseDrafts: drafts?.ok ? looseDraftsOf(drafts.value) : [] }
}

// ── Search ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest search the box takes: a sentence, not a document. */
export const SEARCH_MAX = 200

export interface ListedHit {
  conversationId: string
  subject: string
  snippet: string
  /** The line that has the words, or null when they were only in names or the subject. */
  match: string | null
  at: number
  unread: boolean
  open: boolean
  bulk: boolean
  /** The business mailbox it is in, or null for the owner's own Gmail. */
  mailbox: string | null
  people: string[]
  /**
   * Where the hit opens: the key of the first other person on it (their first address, or `mail:<contact id>` for one with none), the key the Inbox opens a person by. Null when no one is on
   * it to open (the page then draws the result without a link). It opens that person's conversation, which holds every thread with them, closed and Bulk ones too.
   */
  key: string | null
}

/** Results by source, in one box. Chat has none until meet has a search. */
export interface SearchAnswer {
  query: string
  mail: { status: PartStatus; terms: string[]; hits: ListedHit[]; more: boolean }
  /** Meet has no search yet; the page says so beside the results, rather than implying chat has none. */
  chat: { searchable: false }
}

/** The key a hit opens by: the first person on it who is not the one asking, or null when no one but them is on it (there is then no one's conversation to open). */
export function hitKey(people: readonly InboxParty[], self: readonly string[]): string | null {
  const mine = new Set(self.map((a) => a.toLowerCase()))
  const first = people.find((p) => p.address === null || !mine.has(p.address.toLowerCase()))
  return first === undefined ? null : (first.address ?? `mail:${first.contactId}`)
}

const listedHit = (h: InboxHit, self: readonly string[]): ListedHit => ({
  conversationId: h.conversationId,
  subject: h.subject,
  snippet: h.snippet,
  match: h.match,
  at: h.at,
  unread: h.unread,
  open: h.open,
  bulk: h.bulk,
  mailbox: h.mailbox?.name ?? null,
  people: h.people.map((p) => p.name),
  key: hitKey(h.people, self),
})

export async function search(ask: Asking, query: string): Promise<SearchAnswer> {
  const { inbox } = ask.apps
  const answer = inbox ? await reach('Email', () => inbox.search(ask.signedIn, query), isInboxSearch, ask.answerWithinMs ?? ANSWER_WITHIN_MS) : notConnected('Email')
  return {
    query,
    mail: { status: statusOf('mail', answer), terms: answer.ok ? answer.value.terms : [], hits: answer.ok ? answer.value.hits.map((h) => listedHit(h, ask.self)) : [], more: answer.ok ? answer.value.more : false },
    chat: { searchable: false },
  }
}
