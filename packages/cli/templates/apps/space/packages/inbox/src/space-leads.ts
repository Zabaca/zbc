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
import { canSee, type MailScope } from './queue'
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

/** A stage of the install's, or the sentence that refuses it. */
const notAStage = (leads: Leads, stage: unknown): string | null =>
  typeof stage === 'string' && leads.stages.some((s) => s.id === stage)
    ? null
    : 'That is not a stage of this space’s leads.'

/** The site's id for a request: what makes a repeat of it change nothing, so never blank. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/

/**
 * Fields as the install declares them, each value trimmed, empty ones left out; or the sentence that refuses them (a key not declared, a value that is not text or is too long). Nothing is
 * half kept: one bad field refuses all.
 */
export function checkLeadFields(
  leads: Leads,
  raw: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'The fields are an object of text by the keys this space declares.' }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const field = leads.fields.find((f) => f.key === key)
    if (!field) return { ok: false, message: `${key} is not a field of this space's leads.` }
    if (typeof value !== 'string') return { ok: false, message: `${field.label} is text.` }
    const v = value.trim()
    if (v.length > LEAD_FIELD_MAX)
      return { ok: false, message: `${field.label} is longer than a field can be (${LEAD_FIELD_MAX} characters).` }
    if (v !== '') out[key] = v
  }
  return { ok: true, value: out }
}

function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : outcomeOf(r)
}

/**
 * How many open leads the person may see, for the menu beside the Leads tab; undefined where the install has no leads or the person may not see them (the menu then shows no number). The same gate
 * as every lead method: the store's own row of the leads' mailbox.
 */
export async function openLeadsFor(
  deps: Pick<SpaceDeps, 'store' | 'install'>,
  scope: MailScope,
  owner: boolean,
): Promise<number | undefined> {
  const leads = leadsOf(deps.install)
  if (leads === null) return undefined
  if (!owner && !canSee(scope, await deps.store.call('leadsMailboxId', leads.mailbox))) return undefined
  return deps.store.call('openLeadCount', scope, leadRulesOf(leads).settled)
}

export function createSpaceLeads(deps: SpaceDeps, asPerson: AsPerson): LeadsPart {
  const { store, install } = deps

  /**
   * The gate every lead method goes through after the person's: the switch, then the leads' mailbox. Asked of the store's own row of that mailbox, the one every read and write of a lead is cut by
   * (src/store/leads.ts), so the gate and the store cannot disagree: until mail has made the row, the leads are the owner's alone.
   */
  async function leadsFor(
    scope: MailScope,
    owner: boolean,
  ): Promise<{ ok: true; leads: Leads } | { ok: false; reply: SpaceReply<never> }> {
    const leads = leadsOf(install)
    if (leads === null) return { ok: false, reply: refused('not-found', NO_LEADS) }
    if (!owner && !canSee(scope, await store.call('leadsMailboxId', leads.mailbox)))
      return { ok: false, reply: refused('not-admitted', NOT_ON_LEADS) }
    return { ok: true, leads }
  }

  const leads = (asker: SignedIn) =>
    asPerson(asker, async ({ scope, owner }): Promise<SpaceReply<InboxLeads>> => {
      const gate = await leadsFor(scope, owner)
      if (!gate.ok) return gate.reply
      return answered(await store.call('spaceLeads', scope, leadRulesOf(gate.leads).settled, null))
    })

  const contactLeads = (asker: SignedIn, contactId: string) =>
    asPerson(asker, async ({ scope, owner }): Promise<SpaceReply<InboxLeads>> => {
      // Refused, as the board is, for someone who may not see the leads: the answer does not depend on the person asked about, so it tells nothing, and the page then draws no Leads section.
      const gate = await leadsFor(scope, owner)
      if (!gate.ok) return gate.reply
      if (typeof contactId !== 'string' || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      return answered(await store.call('spaceLeads', scope, leadRulesOf(gate.leads).settled, contactId))
    })

  const moveLead = (asker: SignedIn, move: InboxLeadMove) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLead>> => {
      const gate = await leadsFor(scope, owner)
      if (!gate.ok) return gate.reply
      if (!isRecord(move)) return BAD('A move names the lead, the revision you were shown and the stage.')
      const { leadId, rev, stage } = move
      if (typeof leadId !== 'string' || !ID.test(leadId)) return refused('not-found', 'There is no such lead.')
      if (!isCount(rev)) return BAD('Say which revision of the lead you were shown (rev).')
      const wrong = notAStage(gate.leads, stage)
      if (wrong !== null) return BAD(wrong)
      return reply(await store.call('moveLead', leadId, rev, stage as string, actor, scope))
    })

  const makeLead = (asker: SignedIn, make: InboxLeadMake) =>
    asPerson(asker, async ({ actor, scope, owner }): Promise<SpaceReply<InboxLead>> => {
      const gate = await leadsFor(scope, owner)
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
  // What the store keys a request on and dates it by is checked here, with the fields and the stage, whatever door it came through.
  if (typeof request.externalId !== 'string' || !REQUEST_ID.test(request.externalId))
    return BAD('Name the request by your own id for it (letters, digits and . _ : - only).')
  if (typeof request.source !== 'string' || request.source.trim() === '')
    return BAD('Name where the request came from.')
  if (typeof request.name !== 'string' || request.name.length > 200)
    return BAD('The name is text of at most 200 characters.')
  if (request.at !== undefined && (typeof request.at !== 'string' || Number.isNaN(Date.parse(request.at))))
    return BAD('When it came in (at) is a moment such as 2026-01-31T09:30:00Z.')
  const fields = checkLeadFields(leads, request.fields)
  if (!fields.ok) return BAD(fields.message)
  const wrong = request.stage === undefined ? null : notAStage(leads, request.stage)
  if (wrong !== null) return BAD(wrong)
  return reply(
    await deps.store.call(
      'receiveLead',
      { ...request, fields: fields.value, ...(request.at !== undefined && { at: new Date(request.at).toISOString() }) },
      leadRulesOf(leads),
      `source:${request.source}`,
    ),
  )
}
