// What the Clients part answers: the shape of a Client and the interfaces of its three faces, method by method (the package is packages/clients; the space's ADR 0021).
//
// THE SPACE OWNS ITS CLIENTS. A Client is a business the company serves and groups people, mail and documents under. The Clients part holds the one list of them in a store of its own, made and edited in the
// space and, where the install has an outside system that keeps Clients of its own, PUSHED in by that system. The space never asks it: it depends on no source, calls none and binds none: the space never
// depends on a source being there. The core Client carries no field of any source: where one came from, its id there, its address there and whatever else the source says of it (text fields its sender names, shown with the labels the
// declaration gives them) are generic `source` fields the part keeps and shows and never reads. An install with no source makes its Clients in its own space and needs nothing more.
//
// A SOURCE IS A SENDER, not an adapter in the space. It reaches the part through the Clients door (a path of the space behind an Access application of its own, admitting one service token and no person; the
// company layer's `clientsDoor`), which hands `ClientsForSource` below to the part: upsert one Client by the source's id, mark one gone, or send the full set so that what is missing is marked. The sender is a
// separate change in the sender's own repo.
//
// THREE FACES, because they are asked by three different kinds of caller:
//
// - `ClientsForSpace`: Settings. It runs INSIDE the space's Worker (the company layer's ADR 0003), over a store the Worker owns, so it is a call and not a binding. EVERY METHOD takes the person the space's one
//   sign-in check named (`SignedIn`), then admits the install's owner and no one else. A service token is never a person, so none comes through.
// - `ClientsForInbox`: the inbox (and through it Claude's script), in-process. It takes NO assertion and can only READ: the list and one Client. It has no method that makes, edits or archives.
// - `ClientsForSource`: the Clients door. It takes NO assertion either: the door verified the service token, and the face is made for the one source the declaration names, so it can only write that source's Clients.
//
// Every method answers a `SpaceReply`, as data and never an exception. TIMES are milliseconds since the epoch.

import type { SignedIn, SpaceReply } from './asking'

/** The longest name and legal name a Client keeps: Forms' own limits, so a Client always fits Forms. */
export const CLIENT_NAME_MAX = 80
export const CLIENT_LEGAL_NAME_MAX = 120

/** Where a Client made in the space is numbered from while the install has a source (a source's own numbers stay free); from 1 where it has none. */
export const CLIENT_LOCAL_NUMBER_FROM = 1001

/** The most Clients one full send holds, and the longest a source's id for a Client, an address of one and a value of its extra fields; the most extra fields one Client has. */
export const CLIENT_SYNC_MAX = 2000
export const CLIENT_EXTERNAL_ID_MAX = 100
export const CLIENT_URL_MAX = 500
export const CLIENT_EXTRA_MOST = 20
export const CLIENT_EXTRA_VALUE_MAX = 500
/** The longest name or legal name a source may say. The Client's own are cut to `CLIENT_NAME_MAX` and `CLIENT_LEGAL_NAME_MAX`; what the source said is kept whole up to this. */
export const CLIENT_SAID_MAX = 500

// ── A source and what it says ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a source says of one Client, without its id. `preferredNumber` is the number the source asks the Client to keep in the space, when it has a meaningful one (a source with numbered Clients of its own keeps them so
 * every link already made stays), and null when it has none: honoured when the number is free, and otherwise the Client takes the next free one. `extra` is whatever else the source says that the space shows
 * and never reads: its keys are the sender's (a short lowercase word), its values text.
 */
export interface ExternalFields {
  preferredNumber: number | null
  name: string
  legalName: string | null
  /** The Client in the source's own admin: an https address, or null. */
  url: string | null
  extra: Record<string, string>
}

/** One Client as a source sends it in a full set: its id there (text, the source's own business) and what it says. */
export interface ExternalClient extends ExternalFields {
  id: string
}

/** What the part keeps of a Client's source: the source's own part of a Client, shown and never edited in the space. */
export interface ClientSourcePart {
  /** The source's name (the declaration's `clientsDoor.source`). */
  source: string
  /** The source's id for the Client. */
  externalId: string
  /** The Client in the source's own admin. */
  url: string | null
  /** What the source last said of the name and legal name. A name here that differs from the Client's is the source's, and the Client's own stands (it was edited in the space). The name is whole: the Client's is cut to `CLIENT_NAME_MAX`. */
  said: { name: string; legalName: string | null }
  /** Whatever else the source last said, as the sender named it. */
  extra: Record<string, string>
  /** Since when the source says the Client is gone, or null. The Client is kept as it is, never archived or deleted by the source; sending it again clears this. */
  goneSince: number | null
}

/** When the source was last heard from, for the line under the Clients' heading. */
export interface ClientSourceStatus {
  /** The source's name. */
  name: string
  /** When anything the space accepted last arrived from it (a push, a mark of a Client the space holds, or a full send), even one that changed nothing; a refused call does not count. Null before the first. */
  lastPushAt: number | null
  /** When it last sent the full set; null before the first. */
  lastSyncAt: number | null
  /** How many Clients that full set held. */
  syncedCount: number | null
}

// ── A Client ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Client {
  /** The Client's number in the space: a whole number from 1, what every link and address names. Never reused, never changed. */
  number: number
  name: string
  /** The legal name, or null. Up to `CLIENT_LEGAL_NAME_MAX`. */
  legalName: string | null
  createdAt: number
  /** Who made it: a person's address, or `source:<name>` for a Client a source brought in. */
  createdBy: string
  updatedAt: number
  updatedBy: string
  /** When it was archived, or null. An archived Client is left out of the lists and pickers; its people stay linked. */
  archivedAt: number | null
  archivedBy: string | null
  /** How many times its own fields have changed: what an edit names, so one made over a screen that is out of date is `conflict`. */
  revision: number
  /** The source's part, for a Client a source brought in; null for one made in the space. */
  source: ClientSourcePart | null
}

/** The list the Settings screen is drawn from: every Client, active and archived apart, and when the source was last heard from. */
export interface ClientList {
  active: Client[]
  archived: Client[]
  /** The source's status; null where the install has no source. */
  source: ClientSourceStatus | null
}

/** A new Client needs a name; the legal name may wait. */
export interface ClientMake {
  name: string
  legalName?: string | null
}

/** A change to a Client's own fields. A field left out is kept; a legal name given as an empty string or null is cleared. */
export interface ClientEdit {
  name?: string
  legalName?: string | null
}

/** The counts of the store, for the operator's comparison with the source's own list. */
export interface ClientsCounts {
  clients: number
  active: number
  archived: number
  /** Clients a source brought in (gone or not). */
  fromSource: number
  /** Clients made in the space. */
  madeHere: number
  /** Clients the source has marked gone. */
  gone: number
  /** The highest Client number held. */
  highest: number
  source: ClientSourceStatus | null
  /** The schema version of the store. */
  schema: number
}

/** A bookmark of the Clients object's history, as Cloudflare names it. */
export interface ClientsBookmark {
  bookmark: string
}

// ── What a source is answered ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What one Client of the source's is in the space: enough for a sender to reconcile its own list against the space's. */
export interface ClientListing {
  externalId: string
  number: number
  name: string
  legalName: string | null
  archived: boolean
  goneSince: number | null
}

/** What an upsert did: the Client's number in the space, whether it was new, and whether anything about it changed. */
export interface ClientUpserted {
  number: number
  created: boolean
  /** Whether anything changed: the name or legal name followed the source, or the source's part was replaced, or a gone mark was cleared. */
  changed: boolean
}

/** What marking one gone did. */
export interface ClientGone {
  number: number
  /** False when it was already marked gone. */
  changed: boolean
}

/** What a full send did, with the counts a comparison with the sender's own list is made from. */
export interface ClientsSynced {
  /** How many Clients the send held. */
  sent: number
  added: number
  /** Clients whose name or legal name followed the source's, or whose source part changed. */
  updated: number
  /** Clients the source did not send and that are now marked gone. */
  markedGone: number
  /** Clients that were gone and are sent again. */
  returned: number
  /** Whether anything in the store changed. */
  changed: boolean
  /** After the send was applied: whether the space holds exactly what was sent. True when every Client sent is stored and not gone, every other of this source's is marked gone, and each name that should follow the source does. */
  matches: boolean
}

// ── The faces ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the space calls in-process for Settings. */
export interface ClientsForSpace {
  /** Every Client, active and archived apart, and when the source was last heard from. Owner only. */
  clients(asker: SignedIn): Promise<SpaceReply<ClientList>>
  /** One Client by its number. Owner only. `not-found` for a number the store does not hold. */
  client(asker: SignedIn, number: number): Promise<SpaceReply<Client>>
  /** Make a Client. Owner only. It takes the next free number (from `CLIENT_LOCAL_NUMBER_FROM` while the install has a source, from 1 with none). */
  makeClient(asker: SignedIn, make: ClientMake): Promise<SpaceReply<Client>>
  /** Change a Client's name or legal name, naming the `revision` the person was shown: `conflict` when it has moved. Owner only. */
  editClient(asker: SignedIn, number: number, revision: number, edit: ClientEdit): Promise<SpaceReply<Client>>
  /** Take a Client out of the lists and pickers; its people stay linked. Owner only. Nothing deletes a Client. */
  archiveClient(asker: SignedIn, number: number): Promise<SpaceReply<Client>>
  /** Put an archived Client back. Owner only. */
  putBackClient(asker: SignedIn, number: number): Promise<SpaceReply<Client>>
  /** The operator's three, for the sitting of an apply and the comparison with the source: Cloudflare's bookmark of the store's history, a restart of the object, and the counts. Owner only. */
  storeBookmark(asker: SignedIn): Promise<SpaceReply<ClientsBookmark>>
  restartStore(asker: SignedIn): Promise<SpaceReply<{ restarted: true }>>
  storeCounts(asker: SignedIn): Promise<SpaceReply<ClientsCounts>>
}

/** The Clients part's face for the inbox, called in-process in the space's Worker. No assertion; it can read and do nothing else. */
export interface ClientsForInbox {
  /** Every Client, archived ones included (the inbox leaves them out of its pickers itself), lowest number first. */
  list(): Promise<SpaceReply<Client[]>>
  /** One Client by its number. `not-found` for a number the store does not hold. */
  get(number: number): Promise<SpaceReply<Client>>
}

/**
 * The Clients door's face: what the one source the declaration names may do. No assertion (the door verified the service token) and no choice of source (the face is made for one). Its rules, all the store's:
 * the source's name wins until a name is edited in the space; a Client the source says is gone is marked and kept, never archived or deleted; a Client keeps the number the source asks for when it is free.
 */
export interface ClientsForSource {
  /** Every Client of this source in the space, by the source's id, so the sender can reconcile. */
  list(): Promise<SpaceReply<ClientListing[]>>
  /** Make or bring up to date the Client the source knows as `id`. Idempotent: the same push twice changes nothing the second time. */
  upsert(id: string, fields: ExternalFields): Promise<SpaceReply<ClientUpserted>>
  /** The source says the Client is gone. It is marked, with the time, and kept. `not-found` for an id the space does not hold for this source. */
  gone(id: string): Promise<SpaceReply<ClientGone>>
  /** The source's full set: each Client is made or brought up to date, and every Client of this source that is not in it is marked gone. All or nothing: a send with a fault in it changes nothing. */
  sync(clients: ExternalClient[]): Promise<SpaceReply<ClientsSynced>>
}

/** The method names, so a stub, a test and the object agree on exactly these and no others. */
export const CLIENTS_FOR_SPACE_METHODS = [
  'clients',
  'client',
  'makeClient',
  'editClient',
  'archiveClient',
  'putBackClient',
  'storeBookmark',
  'restartStore',
  'storeCounts',
] as const satisfies readonly (keyof ClientsForSpace)[]
export const CLIENTS_FOR_INBOX_METHODS = ['list', 'get'] as const satisfies readonly (keyof ClientsForInbox)[]
export const CLIENTS_FOR_SOURCE_METHODS = ['list', 'upsert', 'gone', 'sync'] as const satisfies readonly (keyof ClientsForSource)[]

/** What a bookmark looks like (`00000000-00000006-00005118-0123456789abcdef0123456789abcdef`). */
export const CLIENTS_BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/

/** What a source's id for a Client, and the key of an extra field, look like: a short run of plain characters, so neither is a path or a query. */
export const CLIENT_EXTERNAL_ID = /^[A-Za-z0-9_.:-]{1,100}$/
export const CLIENT_EXTRA_KEY = /^[a-z][a-zA-Z0-9]{0,39}$/

/** The actor a source's changes are stamped with: `source:crm.example`. */
export const SOURCE_ACTOR_PREFIX = 'source:'
export const sourceActor = (name: string): string => `${SOURCE_ACTOR_PREFIX}${name}`
