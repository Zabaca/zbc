// The inbox's contacts as the space's People tab draws them (the space's ADR 0009 on People): who a
// person is, beyond what they said. The shapes only; the methods are on `InboxForSpace` (inbox-for-space.ts) and the rules every one follows are that
// file's header and asking.ts: the person the space's check named first, the inbox's owner rule, a `SpaceReply` back, one spelling for an address.
//
// WHAT A CONTACT CARRIES HERE, AND WHAT NEVER: the name, the addresses and numbers it is reached on, its Client, and the three fields People adds (the
// business, the role and a note). No message, subject, snippet or draft: those are the conversation's (`messagesWith`), and the directory is not a
// second way to read mail. An AUTOMATED SENDER (a newsletter, a receipt, a no-reply address: the inbox's own judgment, `judgeSender`) is not a
// person and is not listed unless asked for (`InboxContactsScope.automated`); the answer counts how many there are so the page can say so, and a
// contact judged one by mistake (a real person) is still read by its id and still has its business, role and note.
//
// THE REVISION. Every contact has `rev`, a number that goes up when its three fields change, a merge changes it, it is renamed or an address is split off it, and never down (an undone
// merge goes up too). A write names the revision it was shown and is refused (`conflict`, nothing changed) when the contact has moved on, so a screen read
// before someone else's edit cannot write over it. Linking a Client is not guarded: it sets a value, so twice is once (inbox-views.ts).

import type { ClientRef, MailKind } from './rows'

/** The longest each of the three fields may be, in characters, after trimming. The inbox refuses more (`bad-request`); the space refuses it first. */
export const PROFILE_MAX = { business: 200, role: 200, notes: 10_000 } as const

/** One way to reach a contact: an address, a number or a handle, in the spelling the inbox keeps (a lowercase address, E.164 digits). */
export interface InboxIdentity {
  id: string
  kind: MailKind
  address: string
}

/** A Telegram group a person writes in: the contact that stands for the group (what opens its row), its name, and when the person last wrote there. */
export interface InboxGroupRef {
  contactId: string
  name: string
  lastWroteAt: number
}

/** A contact as the directory lists it. */
export interface InboxContact {
  contactId: string
  name: string
  identities: InboxIdentity[]
  /** The email addresses among the identities, normalised, sorted. Empty for a contact reached only by a number or a handle. */
  addresses: string[]
  client: ClientRef | null
  /** The Client the inbox only suggests (see `InboxPerson.suggestedClient`): display only, null when there is none or the Client list did not answer. */
  suggestedClient: ClientRef | null
  business: string
  role: string
  /** How many conversations the contact is on, in any state: 0 means nothing has been said and there is no conversation to open. */
  conversations: number
  rev: number
  /**
   * Where a new email to this contact goes out from when the person chooses nothing in From: the mailbox they last wrote to while it can send (a Brightwater customer hears from Brightwater),
   * else the default Gmail account. `name` is the account's pill ("northfield", "Brightwater Builders"). Null for a contact with no email address, or while no Gmail account is connected;
   * ABSENT from an inbox that predates it, read as null.
   */
  sendsFrom?: { name: string; address: string } | null
  /** The inbox judges this contact an automated sender (`judgeSender`). Only in an answer that asked for them. */
  automated: boolean
  /**
   * The Telegram groups the person writes in (Telegram chats of the group kind), newest first, each opening the group's row. Left out when there are none, and ABSENT from an inbox that
   * predates it. A group's messages are never in the person's own history.
   */
  groups?: InboxGroupRef[]
}

/** What `contacts` is asked for. By default the automated senders are counted and left out. */
export interface InboxContactsScope {
  /** Include the automated senders too, each marked `automated`. */
  automated?: boolean
}

export interface InboxContacts {
  contacts: InboxContact[]
  /** How many contacts the inbox judges automated senders, listed or not. */
  automated: number
}

/**
 * The limit on the three fields, once, with the words that say it: `null` when they fit (after trimming, as the inbox stores them), else the sentence to show. The space
 * refuses a body past it before asking, the inbox refuses it again, and the stand-in uses it, so there is one rule and one set of words.
 */
export function profileLimitMessage(fields: { business: string; role: string; notes: string }): string | null {
  if (fields.business.trim().length > PROFILE_MAX.business) return `A business is at most ${PROFILE_MAX.business} characters.`
  if (fields.role.trim().length > PROFILE_MAX.role) return `A role is at most ${PROFILE_MAX.role} characters.`
  if (fields.notes.trim().length > PROFILE_MAX.notes) return `A note is at most ${PROFILE_MAX.notes} characters.`
  return null
}

/** One contact with its note, the whole of what is known of them. */
export interface InboxContactProfile extends InboxContact {
  notes: string
}

/** The three fields, all at once, as the person saw them and changed them: a field left as it was is sent as it was. */
export interface InboxProfileEdit {
  contactId: string
  /** The revision the contact had when it was shown. */
  rev: number
  business: string
  role: string
  notes: string
}

/** Merge `absorbedId` into `survivorId`: the survivor keeps its name and Client and takes the other's addresses, and a field it leaves blank. Each revision as it was shown. */
export interface InboxMerge {
  survivorId: string
  survivorRev: number
  absorbedId: string
  absorbedRev: number
}

/** Rename `contactId` to `name`, at the revision it was shown. The inbox trims the name and refuses an empty one. */
export interface InboxRename {
  contactId: string
  rev: number
  name: string
}

/** Split `identityId` off `contactId` (the address must be one of that contact's), at the revision of `contactId` as shown. */
export interface InboxSplit {
  contactId: string
  rev: number
  identityId: string
}

export interface InboxSplitDone {
  /** The contact the address came off, as it now stands (its revision has gone up). */
  from: InboxContactProfile
  /** The new contact the address is on now, named by the address (rename it from there). */
  contact: InboxContactProfile
}

export interface InboxMerged {
  /** The inbox's record of this merge: what `undoContactMerge` takes. */
  mergeId: number
  survivor: InboxContactProfile
  /** The name the absorbed contact had, for the sentence that says what was merged. */
  absorbedName: string
  /** The addresses that moved to the survivor. */
  moved: string[]
}

export interface InboxUnmerged {
  /** The contact it was merged into, as it is now. */
  survivor: InboxContactProfile
  /** The contact that was absorbed, back with its name, Client, fields and the addresses that are still on the survivor. */
  restored: InboxContactProfile
}
