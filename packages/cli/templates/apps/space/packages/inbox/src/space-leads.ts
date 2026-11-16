/**
 * The company's leads as the space draws them: the board, one person's leads, a move, and a lead made by hand; and a request a company's site sends (`receiveLeadFromSource`, for the space's leads door).
 * The contract is packages/workspace/src/inbox-for-space.ts (the methods) and inbox-leads.ts (the shapes); the rows and their rules are the store's (src/store/leads.ts).
 *
 * ── WHO ───────────────────────────────────────────────────────────────────
 * Where the `leads` switch is on, the install's leads belong to one mailbox (`Install.leads().mailbox`), and whoever is on it sees and works them, the owner always: the same people who see that
 * mailbox's mail. Anyone else is `not-admitted` here, before the store is asked; the store cuts every read and write by the person's scope again (a lead keeps the mailbox it was made in).
 *
 * ── THE INSTALL'S WORDS ───────────────────────────────────────────────────
 * A stage is one the install declares, and a field a key it declares, with a value of at most `LEAD_FIELD_MAX` characters: checked here, so the store only ever holds what the install said. The store
 * is handed the first stage, the settled ones and the mailbox with each call (`LeadRules`).
 */

import {
  answered,
  type InboxForSpace,
  type InboxLead,
  type InboxLeadMake,
  type InboxLeadMove,
  type InboxLeads,
  type Install,
  LEAD_FIELD_MAX,
  type Leads,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import { type AsPerson, BAD, ID, isCount, isRecord, outcomeOf, type SpaceDeps } from './space-gate'
import type { LeadReceived, LeadRequest, LeadRules } from './store/leads'
import type { Result } from './store/store'

type LeadsPart = Pick<InboxForSpace, 'leads' | 'contactLeads' | 'moveLead' | 'makeLead'>

const NO_LEADS = 'This space has no leads.'
const NOT_ON_LEADS = 'Leads are seen by the people on the mailbox they belong to, and you are not on it.'

/** What the store is handed of the install's leads. */
export const leadRulesOf = (leads: Leads): LeadRules => ({
  mailbox: leads.mailbox,
  firstStage: (leads.stages[0] as Leads['stages'][number]).id,
  settled: leads.stages.filter((s) => s.settled).map((s) => s.id),
})

/** The install's leads, or null where the switch is off. */
const leadsOf = (install: Install): Leads | null => (install.has('leads') ? install.leads() : null)

/** Whether this person (a work address) sees the leads: the owner, or someone on the leads' mailbox. */
const onLeads = (install: Install, leads: Leads, actor: string, owner: boolean): boolean =>
  owner || (install.mailboxPeople(leads.mailbox) ?? []).includes(actor)

/**
 * Fields as the install declares them, each value trimmed, empty ones left out; or the sentence that refuses them (a key not declared, a value that is not text or is too long). Nothing is
 * half kept: one bad field refuses all.
 */
export function checkLeadFields(leads: Leads, raw: unknown): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'The fields are an object of text by the keys this space declares.' }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const field = leads.fields.find((f) => f.key === key)
    if (!field) return { ok: false, message: `${key} is not a field of this space's leads.` }
    if (typeof value !== 'string') return { ok: false, message: `${field.label} is text.` }
    const v = value.trim()
    if (v.length > LEAD_FIELD_MAX) return { ok: false, message: `${field.label} is longer than a field can be (${LEAD_FIELD_MAX} characters).` }
    if (v !== '') out[key] = v
  }
  return { ok: true, value: out }
}

function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : outcomeOf(r)
}

export function createSpaceLeads(deps: SpaceDeps, asPerson: AsPerson): LeadsPart {
  const { store, install } = deps

  /** The gate every lead method goes through after the person's: the switch, then the leads' mailbox. */
  function leadsFor(actor: string, owner: boolean): { ok: true; leads: Leads } | { ok: false; reply: SpaceReply<never> } {
    const leads = leadsOf(install)
    if (leads === null) return { ok: false, reply: refused('not-found', NO_LEADS) }
    if (!onLeads(install, leads, actor, owner)) return { ok: false, reply: refused('not-admitted', NOT_ON_LEADS) }
    return { ok: true, leads }
  }

  const leads = (asker: SignedIn) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLeads>> => {
      const gate = leadsFor(actor, owner)
      if (!gate.ok) return gate.reply
      return answered(await store.call('spaceLeads', scope, leadRulesOf(gate.leads).settled, null))
    })

  const contactLeads = (asker: SignedIn, contactId: string) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLeads>> => {
      const all = leadsOf(install)
      // A person page is drawn for everyone who may see the person; it shows no leads to someone who may not see them, rather than refusing the page.
      if (all === null || !onLeads(install, all, actor, owner)) return answered({ leads: [], more: false })
      if (typeof contactId !== 'string' || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      return answered(await store.call('spaceLeads', scope, leadRulesOf(all).settled, contactId))
    })

  const moveLead = (asker: SignedIn, move: InboxLeadMove) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLead>> => {
      const gate = leadsFor(actor, owner)
      if (!gate.ok) return gate.reply
      if (!isRecord(move)) return BAD('A move names the lead, the revision you were shown and the stage.')
      const { leadId, rev, stage } = move
      if (typeof leadId !== 'string' || !ID.test(leadId)) return refused('not-found', 'There is no such lead.')
      if (!isCount(rev)) return BAD('Say which revision of the lead you were shown (rev).')
      if (typeof stage !== 'string' || !gate.leads.stages.some((s) => s.id === stage)) return BAD('That is not a stage of this space’s leads.')
      return reply(await store.call('moveLead', leadId, rev, stage, actor, scope))
    })

  const makeLead = (asker: SignedIn, make: InboxLeadMake) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLead>> => {
      const gate = leadsFor(actor, owner)
      if (!gate.ok) return gate.reply
      if (!isRecord(make)) return BAD('A new lead names the person and its fields.')
      const { contactId } = make
      if (typeof contactId !== 'string' || !ID.test(contactId)) return refused('not-found', 'There is no such person.')
      const fields = checkLeadFields(gate.leads, make.fields ?? {})
      if (!fields.ok) return BAD(fields.message)
      return reply(await store.call('makeLead', contactId, fields.value, leadRulesOf(gate.leads), actor, scope))
    })

  return { leads, contactLeads, moveLead, makeLead }
}

/**
 * A request the company's site sent through the space's leads door, checked against the install (its fields, and a carried-over lead's stage), then handed to the store. No person asks: the door
 * has checked the site's token. `actor` is the source's (`source:<name>`).
 */
export async function receiveLeadFromSource(
  deps: Pick<SpaceDeps, 'store' | 'install'>,
  request: Omit<LeadRequest, 'fields'> & { fields: unknown },
): Promise<SpaceReply<LeadReceived>> {
  const leads = leadsOf(deps.install)
  if (leads === null) return refused('not-found', NO_LEADS)
  const fields = checkLeadFields(leads, request.fields)
  if (!fields.ok) return BAD(fields.message)
  if (request.stage !== undefined && !leads.stages.some((s) => s.id === request.stage)) return BAD('That is not a stage of this space’s leads.')
  return reply(await deps.store.call('receiveLead', { ...request, fields: fields.value }, leadRulesOf(leads), `source:${request.source}`))
}
