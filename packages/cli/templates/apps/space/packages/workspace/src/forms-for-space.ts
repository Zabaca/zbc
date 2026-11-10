// What forms answers the space (its reads): the interface the space calls in-process, method by method.
//
// Called IN-PROCESS by the space's Worker (docs/adr/0003; it was once an RPC
// entrypoint, `SpaceForms`, over a service binding). These are the reads Today and People draw from, and they carry a
// document's title and state, the names of the signers who have not signed, and NOTHING of what it holds: never an answer,
// private or not, never a recipient's address, link or token, never a file's name or key, never the finished document. An envelope with a private question shows exactly what any other
// shows (a document holding a private answer shows only its title and state).
//
// EVERY METHOD takes the person the space's one sign-in check named first (`SignedIn`), then applies forms' own rule:
// the person must be an operator, which is anyone in the install's declaration (`operatorOf` in packages/forms/src/workspace.ts).
// Every method answers a `SpaceReply`. ADDRESSES in a query are `normalizeAddress`'s spelling and matched case-blind; **a test proves
// that a recipient stored as "Ines@X.example.com" is found by "ines@x.example.com"**.
//
// WHICH DOCUMENTS A PERSON IS ON: an envelope lists a person when their address is one of its recipients, a signer or a copy
// recipient. So "per address" and "per person" are one question (a person is the addresses the space joined them on), and
// `documentsOn` takes a list.
//
// DOCUMENTS IN A CONVERSATION. An envelope may carry the conversation it was sent from, a CONVERSATION REF: `{ app, id }`, which app holds the
// conversation and its id there (the inbox's contact id for the mail side of a person, meet's conversation id for a direct message or a
// channel). A person's conversation in the space is a merge, so it has SEVERAL REFS (`documentsIn` takes a list, as `documentsOn` does): a document
// carries one, and is found by any. The summary says which one it carries.
// Additive: a forms without `documentsIn` is read by the space as "documents could not be shown", never an error, and one that ignores a ref it is
// sent is noticed by the space on Send. The deploy order, why each order is safe and what to check are in ONE place: packages/space/README.md, "After
// documents come to a conversation". Nothing here is emailed into a conversation: forms already emails the finished copy to every party.

import type { SignedIn, SpaceReply } from './asking'

/**
 * An envelope's life, forms' own words (`EnvelopeStatus` in packages/forms/src/vocab.ts), unchanged. A COPY, because this
 * package cannot import forms: **a test pins `DOCUMENT_STATES` equal to forms' own `EnvelopeStatus` list** (and its schema's
 * CHECK), so a status added in forms fails there.
 */
export type DocumentState = 'draft' | 'sent' | 'prepared' | 'sealing' | 'completed' | 'declined' | 'cancelled' | 'expired'

export const DOCUMENT_STATES = ['draft', 'sent', 'prepared', 'sealing', 'completed', 'declined', 'cancelled', 'expired'] as const satisfies readonly DocumentState[]

/** Which app holds a conversation. The inbox (a person's mail) and meet (a direct message, a channel). */
export type ConversationApp = 'inbox' | 'meet'

export const CONVERSATION_APPS = ['inbox', 'meet'] as const satisfies readonly ConversationApp[]

/** A conversation as an app names it: `app` holds it and `id` is its id there. At most 200 characters of letters, digits and `_ - . : @ +`. */
export interface ConversationRef {
  app: ConversationApp
  id: string
}

/** The most refs `documentsIn` takes: a person has a handful. */
export const MOST_CONVERSATION_REFS = 20

/** The characters and length a `ConversationRef.id` may have (the same for forms' store and the space's check). */
export const CONVERSATION_ID = /^[A-Za-z0-9_.:@+-]{1,200}$/

/** Whether a value is a conversation ref forms could have stored: one of the apps and an id of that shape. The one check, used by forms, the space and the guard on forms' answers. */
export function isConversationRef(v: unknown): v is ConversationRef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const { app, id } = v as Record<string, unknown>
  return (CONVERSATION_APPS as readonly unknown[]).includes(app) && typeof id === 'string' && CONVERSATION_ID.test(id)
}

/** One envelope: its title and state, when it moved, and who has not signed. Nothing it holds. */
export interface DocumentSummary {
  id: string
  title: string
  state: DocumentState
  /** Milliseconds since the epoch. */
  createdAt: number
  sentAt: number | null
  completedAt: number | null
  /** Recipients who sign, and how many of them have. */
  signers: number
  signed: number
  /**
   * The names of the signers who have not signed, in signing order, for Today's "waiting on others" (who has not signed). A
   * name as the envelope's recipient carries it, nothing else about them: no address, no link or token, never an answer. Empty
   * when everyone has signed, and for a draft with no signers named yet.
   */
  notSigned: string[]
  /**
   * The conversation it was sent from, or null for one sent from Forms. ABSENT from a forms that predates conversations: read that as null.
   */
  conversation?: ConversationRef | null
}

export interface DocumentsQuery {
  /** Only these states. Omitted means all. */
  states?: readonly DocumentState[]
  /** Only envelopes created, sent or completed at or after this time (milliseconds): Today's "completed today" and "drafts". */
  since?: number
  /** At most this many, newest first; forms caps it (the admin list's 500). */
  limit?: number
}

export interface Documents {
  documents: DocumentSummary[]
  more: boolean
}

/** What forms answers the space's Worker, a call and not a binding. Implemented in packages/forms (`createSpaceForms`, src/space-reads.ts). */
export interface FormsForSpace {
  /** The documents any of these addresses is a recipient of (one address, or all of a person's), newest first. */
  documentsOn(asker: SignedIn, addresses: readonly string[], query?: DocumentsQuery): Promise<SpaceReply<Documents>>
  /** Every document, by state and recency, for Today: drafts, out for signature, signed and back. */
  documents(asker: SignedIn, query?: DocumentsQuery): Promise<SpaceReply<Documents>>
  /**
   * The documents sent from any of these conversations (the refs of one conversation in the space), newest first. Only those that carry one of them:
   * a document to the same person that was sent from Forms is on `documentsOn`, not here. Every summary has its `conversation`.
   */
  documentsIn(asker: SignedIn, conversations: readonly ConversationRef[], query?: DocumentsQuery): Promise<SpaceReply<Documents>>
}

/** The method names, so a stub, a test and the binding agree on exactly these and no others. */
export const FORMS_FOR_SPACE_METHODS = ['documentsOn', 'documents', 'documentsIn'] as const satisfies readonly (keyof FormsForSpace)[]

// ── Forms' signing settings, kept for a Client (the space's ADR 0021) ──────────────────────────────────────────────────────────────────

/**
 * A Forms client row that belongs to a Client: that Client's SIGNING SETTINGS. The row keeps its own text id for good (sealed into every signing record, and what every signing email loads the logo by); the Client's number is the
 * column the link adds. `name` and `legalName` are Forms' COPY of the Client's names, kept because signing emails, signers' pages and sealed certificates read them there.
 */
export interface SigningSettings {
  /** Forms' own id for the row. */
  id: string
  /** The Client it belongs to. */
  number: number
  name: string
  legalName: string
  replyTo: string
}

/** The names Forms keeps a copy of. A null legal name leaves Forms' as it is: Forms always has one, and a Client may have none. */
export interface SigningNames {
  name: string
  legalName: string | null
}

/**
 * What the Clients part asks of Forms, in-process in the space's Worker, with no assertion (the space's Settings check has named the person, and the repair has none). THE CLIENTS PART IS THE ONE WRITER OF FORMS' COPY OF A
 * CLIENT'S NAMES: it writes the copy in the same request as an edit, and puts right any copy that differs on the next five-minute tick. Forms' own routes take no name.
 */
export interface FormsClientNames {
  /** Every Forms client row linked to a Client, with Forms' copy of its names. */
  linked(): Promise<SpaceReply<SigningSettings[]>>
  /** Whether Forms can keep these names as the sender of signing mail (it refuses control characters and `< > " \ , ; : @ ( )`): `bad-request` with the sentence when it cannot. Writes nothing. */
  check(names: SigningNames): Promise<SpaceReply<null>>
  /** Write Forms' copy of the names of the row linked to this Client, audited in Forms' own record with `actor`. `not-found` when no row is linked to it; `changed` is false when the copy already agrees. */
  setNames(number: number, names: SigningNames, actor: string): Promise<SpaceReply<{ changed: boolean }>>
}

export const FORMS_CLIENT_NAMES_METHODS = ['linked', 'check', 'setNames'] as const satisfies readonly (keyof FormsClientNames)[]
