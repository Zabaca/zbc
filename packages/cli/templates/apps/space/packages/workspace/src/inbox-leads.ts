// The company's leads as the space draws them: a lead is one request on a contact (a person who asked for something), moving through the company's own stages. The shapes only; the methods are on
// `InboxForSpace` (inbox-for-space.ts) and follow that file's rules: the person the space's check named first, a `SpaceReply` back.
//
// WHO SEES A LEAD: whoever is on the mailbox the install's leads belong to (`Install.leads().mailbox`), the owner always; the same rule the mailbox's mail follows. A lead carries the person's name and the
// address and number it came with, so a person who sees the lead sees who it is from even where the contact is in no conversation they can open.
//
// THE REVISION. Every lead has `rev`, which goes up when its stage or its fields change and never down. A move names the revision it was shown and is refused (`conflict`, nothing changed) when the lead has
// moved on, so a board read before someone else's move cannot undo it.
//
// THE STAGES AND THE FIELDS ARE THE INSTALL'S (`Install.leads()`): the inbox stores a stage's id and a field's key, and refuses one the install does not declare. A stage or a field taken out of the
// declaration later leaves the leads that hold it as they are; the space shows such a stage under its id, at the end.

/** The longest a field's value may be, in characters, after trimming. The inbox refuses more (`bad-request`). */
export const LEAD_FIELD_MAX = 4_000

/** The most leads one read answers: the open ones first, then the settled ones, each newest first. */
export const LEADS_READ_MAX = 500

/** One lead. */
export interface InboxLead {
  id: string
  /** The person it is from: what opens their page and their conversation. */
  contactId: string
  /** The person's name, as the inbox has it now. */
  name: string
  /** The email address and the number the lead came with (a number in E.164), else the person's first of each kind; null where they have none. */
  email: string | null
  phone: string | null
  /** A stage id of the install's (`Install.leads().stages`). */
  stage: string
  /** The values by the install's field keys; a key with no value is left out. */
  fields: Record<string, string>
  /** Where it came from: the source's name for one a company's site sent, null for one made by hand in the space. */
  source: string | null
  /** How many requests it holds: one, and one more each time the same person asked again while it was open. */
  requests: number
  /** ISO moments. `lastRequestAt` is the newest request's. */
  createdAt: string
  lastRequestAt: string
  /** Who made it: a person's work address, or the source's actor. */
  createdBy: string
  /** When its stage last changed and who changed it; null while it has never moved. */
  stageAt: string | null
  stageBy: string | null
  rev: number
}

/** A read of leads: the open ones first, then the settled ones, each newest request first. `more` is true when there were more than `LEADS_READ_MAX`. */
export interface InboxLeads {
  leads: InboxLead[]
  more: boolean
}

/** A lead moved to another stage, at the revision the person was shown. */
export interface InboxLeadMove {
  leadId: string
  rev: number
  stage: string
}

/** A lead made by hand from a person's page or their conversation. `fields` by the install's keys; none is required. */
export interface InboxLeadMake {
  contactId: string
  fields: Record<string, string>
}
