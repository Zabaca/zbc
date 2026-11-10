// The rows the space's Conversations list is made of: what the space merges the inbox's and meet's answers into.
//
// Types only. The merge itself is the front door's; what is fixed here is its output, so the space's list, its filters
// and the person's conversation opened from a row all read one shape (the space's ADR 0003).
//
// The rule, in full, because it is the contract:
//   - One row per PERSON, joined by lowercase email address (`normalizeAddress`) across the inbox's contacts, the team (the
//     declaration's people) and meet's people. A contact with several addresses is joined on any of them; a contact goes to the row
//     that holds its address, so two contacts sharing an address would be one row (the inbox's identities are unique per
//     address, so it never answers that; packages/space/docs/adr/0003).
//   - THE TEAM JOINS ON TWO ADDRESSES. A declared Person has an `address` (their work address, which names them) and a `signIn`
//     (where Access sends their code, the same unless declared otherwise: a Gmail user is a person that way). Meet knows a
//     teammate by the sign-in address; the inbox may know the same person by either. So a team person's row is joined on BOTH,
//     and `addresses` holds both. That is how one person can reach TWO inbox contacts, one under each address, and why `mail`
//     below is a list and not a single side.
//   - One row per CHANNEL, from meet.
//   - A row's `at` is its newest item from ANY source. `text` and `came` are that same item's: what was last said, and how it
//     came. `unread` is the number of DISTINCT unread email conversations over every mail side (a conversation that two of one
//     person's contacts are both on counts once, though each `MailSide.unread` counts it for its own contact) plus the chat
//     side's unread messages. The two units differ and the sum mixes them; the space says so where the badge is drawn.
//   - A row exists only if it has an item. A person with an address and nothing said is not in the list (they are in People).
//   - Bulk and closed mail never makes a person row unless asked for (the list's filters); see `InboxScope`.

import type { FailureReason, Refused, SpacePart } from './asking'

/**
 * How an item came. `MailKind` is a COPY of the inbox's `IdentityKind` (packages/inbox/src/types.ts), because this package cannot
 * import the inbox: **a test pins `MailKind` equal to `IdentityKind`**, so a kind added there fails in the inbox.  The inbox's own kinds, as it stores them (`IdentityKind`: an email, a text message, a manual note or DM it
 * logged, a Telegram chat the bridge files), and meet's chat. A document joins this list when something can fill it; a call never does: a huddle is a chat message that names a call, so it comes as `chat`, and a call with
 * no conversation and the Phone conversation are rows of their own (`CallRow` and `PhoneRow`, whose `came` is `call`).
 *
 * `MAIL_KINDS` is the one list of them, and `MailKind` is derived from it, so the space reads an answer against the same list the type is
 * made of (a kind added here is read, not refused as "not understood"); the pin above still ties it to the inbox's `IdentityKind`.
 */
export const MAIL_KINDS = ['email', 'sms', 'manual', 'telegram'] as const
export type MailKind = (typeof MAIL_KINDS)[number]
export type ItemKind = MailKind | 'chat'

/**
 * The longest line of text a row or a summary carries: the last thing said, cut on one line. A COPY of the inbox's
 * `EXCERPT_CHARS` (packages/inbox/src/search.ts): **a test pins them equal, and another proves meet cuts a message to
 * this length**, so the three cannot drift.
 */
export const SNIPPET_CHARS = 160

/**
 * A business as the inbox shows it: the Client the contact is under (the inbox's word, `ClientLabel`). The id is the site's; the
 * name is the Client directory's, or "Client 7" with `listed: false` when the directory did not answer.
 */
export interface ClientRef {
  id: number
  name: string
  listed: boolean
}

/** The newest thing one source has with a person or in a channel. `at` is milliseconds since the epoch. */
export interface Newest {
  at: number
  kind: ItemKind
  /** What was said, on one line, at most SNIPPET_CHARS. */
  text: string
}

/** What the inbox has with one of the person's contacts: the handle to open it and the facts the row takes. */
export interface MailSide {
  contactId: string
  /** The inbox's unread, in CONVERSATIONS: it keeps no count of messages. Meet's is in messages; the row's sum mixes the two. */
  unread: number
  newest: Newest & { subject: string }
}

/** What meet has with the person: their direct message. */
export interface ChatSide {
  personId: string
  conversationId: number
  /** Meet's unread, in MESSAGES from others after the person's read position. */
  unread: number
  newest: Newest
}

export interface PersonRow {
  type: 'person'
  /**
   * What names the row in the page's address and in a React key: the first of the row's `addresses` (alphabetically), else
   * `mail:<contactId>` for a contact that has no email address (a text, a manual note), else `chat:<personId>`. It can change
   * when a person gains an address; it is not stored anywhere.
   */
  key: string
  /** The team's name for a teammate (the declaration), else the inbox contact's, else meet's. */
  name: string
  /**
   * Every address the sides joined on, normalised, sorted. For a teammate that is both their `address` and their `signIn`.
   * Empty only for a contact with no email address.
   */
  addresses: string[]
  /** Team: a person of the install, or a meet teammate. Outside: everyone else, a channel guest included. */
  side: 'team' | 'outside'
  /** The business the inbox has the contact under, or null. The name is the Client directory's; `listed: false` when it did not answer. */
  client: ClientRef | null
  at: number
  came: ItemKind
  text: string
  unread: number
  /** The person's inbox contacts that have something in scope, usually one; two when the inbox knows them under two addresses. Empty when none. */
  mail: MailSide[]
  chat: ChatSide | null
}

export interface ChannelRow {
  type: 'channel'
  /** `chat:channel:<conversationId>`. */
  key: string
  conversationId: number
  name: string
  privacy: 'open' | 'private'
  memberCount: number
  at: number
  came: 'chat'
  text: string
  unread: number
}

/**
 * A call with no conversation (New call): a row of its own, so every call has a home. `key` is `call:<name>` and the row opens that call's
 * card, its link and its saved chat. It has no unread and no side.
 */
export interface CallRow {
  type: 'call'
  key: string
  /** The call's name, what its link is made from. */
  call: string
  /** The call's link on meet's public address, made by meet. */
  link: string
  /** The call's title, or "Call". */
  name: string
  at: number
  came: 'call'
  text: string
  unread: number
}

/**
 * The Phone conversation: voicemails and missed calls, with Call back, in one row for everyone on the line. `key` is `phone`. Only
 * a person meet has on the phone list has it.
 */
export interface PhoneRow {
  type: 'phone'
  key: 'phone'
  conversationId: number
  name: 'Phone'
  at: number
  came: 'call'
  text: string
  unread: number
}

export type ConversationRow = PersonRow | ChannelRow | CallRow | PhoneRow

/** How one source fared in this list: it answered, said no (it does not admit this person), or could not be reached. */
export type PartStatus =
  | { part: Extract<SpacePart, 'mail' | 'chat'>; state: 'ok' }
  | { part: Extract<SpacePart, 'mail' | 'chat'>; state: 'not-open-to-you'; refusal: Refused }
  | { part: Extract<SpacePart, 'mail' | 'chat'>; state: 'could-not-be-reached'; reason: FailureReason }

/** The Conversations list as the front door answers its page: rows newest first, and how each source fared. */
export interface ConversationList {
  rows: ConversationRow[]
  parts: PartStatus[]
}
