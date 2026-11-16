// The company's leads in the store (migration 21; the shapes are the workspace's inbox-leads.ts). A lead is one request on a contact, in one of the install's stages. The store keeps the rows and the
// rules that are about rows (who sees one, a move at a revision, a request matched to a person and folded into their open lead); the install's words (which stages there are, which of them are settled,
// which fields) are handed in by the part (src/space-leads.ts), which checks every stage and field against the install before it calls here. The store has no declaration.
//
// WHO SEES A LEAD: the person whose scope may see the mailbox the lead belongs to (`lead.mailbox`, an address; its id is looked up, and a mailbox not yet made is none, so only the owner sees those
// leads). Every read and write here takes the person's `MailScope` and is cut by it.
//
// A REQUEST FROM A SITE (`receiveLead`) is matched to a person by its email address, else by its number (a blank or a number the inbox cannot read keys on nothing: the guard against folding every
// numberless request onto one person), and the person is made when there is none. A person with an OPEN lead in the same mailbox (its stage not one of the settled ones) has the request folded into it:
// one more request, its newest values over the old ones, its revision up. Otherwise it is a new lead in the first stage. The site's id for the request is kept (`lead_request`), so a send repeated changes
// nothing and answers the lead it went to.

import { type InboxLead, LEADS_READ_MAX } from '@space/workspace'
import { ALL_MAIL, canSee, type MailScope } from '../queue'
import { type Classified, classifyAddress } from './address'
import { scopeWhere } from './scope'
import { SpaceStore } from './space'
import { fail, ok, type Result, text } from './store'

/** What the part hands in of the install's leads with every call that needs them. */
export interface LeadRules {
  /** The address of the mailbox the leads belong to. */
  mailbox: string
  /** The stage a new lead takes. */
  firstStage: string
  /** The settled stages: a lead in one is no longer open. */
  settled: readonly string[]
}

/** A request a company's site sent, after the part checked its fields and stage against the install. */
export interface LeadRequest {
  /** The source's name (the install's leads door) and its own id for this request. */
  source: string
  externalId: string
  name: string
  email: string | null
  phone: string | null
  fields: Record<string, string>
  /** For a lead carried over from the site's own records: its stage and when it came in. Left out for a new request. */
  stage?: string
  at?: string
}

/** What became of a request: the lead, and whether it was new, folded into an open lead, or a repeat of a request already kept. */
export interface LeadReceived {
  lead: InboxLead
  outcome: 'made' | 'folded' | 'repeat'
}

/** The SQL expression for the id of the mailbox a lead belongs to (NULL while that mailbox has no row). `l` is the lead's alias. */
const LEAD_MAILBOX = (l = 'l') =>
  `(SELECT mb.id FROM mailbox mb WHERE mb.address = ${l}.mailbox AND mb.kind IN ('cloudflare', 'jmap') LIMIT 1)`

const LEAD_COLUMNS = `l.id, l.contact_id, l.stage, l.fields, l.source, l.email, l.phone, l.requests, l.created_at, l.created_by, l.last_request_at, l.stage_at, l.stage_by, l.rev, c.name AS contact_name,
  (SELECT i.address FROM identity i WHERE i.contact_id = l.contact_id AND i.kind = 'email' ORDER BY i.rowid LIMIT 1) AS first_email,
  (SELECT i.address FROM identity i WHERE i.contact_id = l.contact_id AND i.kind = 'sms' ORDER BY i.rowid LIMIT 1) AS first_phone`

const parseFields = (raw: unknown): Record<string, string> => {
  try {
    const v = JSON.parse(text(raw)) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
      ),
    )
  } catch {
    return {}
  }
}

const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : text(v))

/** A row of the lead table, read with `LEAD_COLUMNS`, as the space draws it. */
function leadOf(r: Record<string, unknown>): InboxLead {
  return {
    id: text(r.id),
    contactId: text(r.contact_id),
    name: text(r.contact_name),
    email: nullable(r.email) ?? nullable(r.first_email),
    phone: nullable(r.phone) ?? nullable(r.first_phone),
    stage: text(r.stage),
    fields: parseFields(r.fields),
    source: nullable(r.source),
    requests: Number(r.requests),
    createdAt: text(r.created_at),
    lastRequestAt: text(r.last_request_at),
    createdBy: text(r.created_by),
    stageAt: nullable(r.stage_at),
    stageBy: nullable(r.stage_by),
    rev: Number(r.rev),
  }
}

/** Values with empty ones left out, so a field sent blank never writes over one already known. */
const filled = (fields: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fields)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ''),
  )

export class LeadStore extends SpaceStore {
  /** One lead as the person may see it, or null (none, or not theirs to see). */
  private leadFor(id: string, mail: MailScope): InboxLead | null {
    const seen = scopeWhere(mail, LEAD_MAILBOX(), 2)
    const row = this.sql
      .exec(
        `SELECT ${LEAD_COLUMNS} FROM lead l JOIN contact c ON c.id = l.contact_id WHERE l.id = ?1 AND ${seen.sql}`,
        id,
        ...seen.bindings,
      )
      .toArray()[0]
    return row ? leadOf(row) : null
  }

  /**
   * The leads the person may see: the open ones first, then the settled ones, each newest request first, to `LEADS_READ_MAX` in all (`more` when some were left out). `contactId` narrows it to one
   * person's.
   */
  spaceLeads(
    mail: MailScope,
    settled: readonly string[],
    contactId: string | null,
  ): { leads: InboxLead[]; more: boolean } {
    const seen = scopeWhere(mail, LEAD_MAILBOX(), 3)
    const who = contactId === null ? '' : ` AND l.contact_id = ?${3 + seen.bindings.length}`
    const rows = this.sql
      .exec(
        `SELECT ${LEAD_COLUMNS} FROM lead l JOIN contact c ON c.id = l.contact_id
          WHERE ${seen.sql}${who}
          ORDER BY (l.stage IN (SELECT value FROM json_each(?1))), l.last_request_at DESC, l.id
          LIMIT ?2`,
        JSON.stringify(settled),
        LEADS_READ_MAX + 1,
        ...seen.bindings,
        ...(contactId === null ? [] : [contactId]),
      )
      .toArray()
    return { leads: rows.slice(0, LEADS_READ_MAX).map(leadOf), more: rows.length > LEADS_READ_MAX }
  }

  /** Move a lead to a stage (checked against the install by the part), at the revision the person was shown. A move to the stage it is in changes nothing. */
  moveLead(leadId: string, rev: number, stage: string, actor: string, mail: MailScope): Result<InboxLead> {
    return this.ports.transaction(() => {
      const lead = this.leadFor(leadId, mail)
      if (!lead) return fail(404, 'There is no such lead.')
      if (lead.rev !== rev)
        return fail(409, 'This lead changed since you opened it, so it was not moved. It is shown as it is now.')
      if (lead.stage === stage) return ok(lead)
      const at = this.now()
      this.sql.exec(
        `UPDATE lead SET stage = ?2, stage_at = ?3, stage_by = ?4, rev = rev + 1 WHERE id = ?1`,
        leadId,
        stage,
        at,
        actor,
      )
      this.audit(actor, 'lead.move', `lead:${leadId}`, { stage: lead.stage, rev: lead.rev }, { stage })
      return ok(this.leadFor(leadId, mail) as InboxLead)
    })
  }

  /** The id of the mailbox with this address that leads may belong to (a Cloudflare or a hosted one), or null while no mail has made its row. */
  leadsMailboxId(address: string): string | null {
    return nullable(
      this.sql
        .exec(`SELECT id FROM mailbox WHERE address = ?1 AND kind IN ('cloudflare', 'jmap') LIMIT 1`, address)
        .toArray()[0]?.id,
    )
  }

  /** One request a site sent, kept by the site's id for it: what makes a repeat of it change nothing. */
  private keepRequest(source: string, externalId: string, leadId: string, at: string): void {
    this.sql.exec(
      `INSERT INTO lead_request (source, external_id, lead_id, at) VALUES (?1, ?2, ?3, ?4)`,
      source,
      externalId,
      leadId,
      at,
    )
  }

  /** Make a lead by hand for a person the maker may see, in the first stage. `fields` were checked against the install by the part. */
  makeLead(
    contactId: string,
    fields: Record<string, string>,
    rules: LeadRules,
    actor: string,
    mail: MailScope,
  ): Result<InboxLead> {
    return this.ports.transaction(() => {
      const contact = this.sql.exec(`SELECT id FROM contact WHERE id = ?1`, contactId).toArray()[0]
      if (!contact || !(this.visibleContactIds(mail)?.has(contactId) ?? true))
        return fail(404, 'There is no such person.')
      // Checked BEFORE anything is written, over the same row the reads cut by: a lead the maker could not then see is never kept.
      if (!canSee(mail, this.leadsMailboxId(rules.mailbox)))
        return fail(403, 'Leads are seen by the people on the mailbox they belong to, and you are not on it.')
      const id = this.ports.newId()
      const at = this.now()
      const values = filled(fields)
      this.sql.exec(
        `INSERT INTO lead (id, contact_id, mailbox, stage, fields, source, email, phone, requests, created_at, created_by, last_request_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, 1, ?6, ?7, ?6)`,
        id,
        contactId,
        rules.mailbox,
        rules.firstStage,
        JSON.stringify(values),
        at,
        actor,
      )
      this.audit(actor, 'lead.create', `lead:${id}`, null, { contactId, stage: rules.firstStage, fields: values })
      return ok(this.leadFor(id, mail) as InboxLead)
    })
  }

  /**
   * The person a request is from: by its address first, else by its number, made from the address (or the number) when neither is known. The other way to reach them is put on them when nobody
   * has it already. One of the two is given.
   */
  private personForRequest(
    byEmail: Classified | null,
    byPhone: Classified | null,
    name: string,
    actor: string,
  ): string {
    const found = (c: Classified) =>
      nullable(
        this.sql
          .exec(`SELECT contact_id FROM identity WHERE kind = ?1 AND address = ?2`, c.kind, c.address)
          .toArray()[0]?.contact_id,
      )
    const first = (byEmail ?? byPhone) as Classified
    const contactId =
      (byEmail && found(byEmail)) ??
      (byPhone && found(byPhone)) ??
      this.identityFor(first, name.trim() || first.address, actor).contactId
    for (const other of [byEmail, byPhone]) {
      if (other === null || found(other) !== null) continue
      this.sql.exec(
        `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        this.ports.newId(),
        contactId,
        other.kind,
        other.address,
        this.now(),
      )
      this.audit(actor, 'identity.create', `contact:${contactId}`, null, { kind: other.kind, address: other.address })
    }
    return contactId
  }

  /**
   * A request a company's site sent: matched to a person (made when none), folded into their open lead or made a new one, and kept by the site's id so a repeat changes nothing. The store's own work
   * (no person asks), so it reads every lead whatever the scope.
   */
  receiveLead(request: LeadRequest, rules: LeadRules, actor: string): Result<LeadReceived> {
    const all = ALL_MAIL
    return this.ports.transaction(() => {
      const kept = this.sql
        .exec(
          `SELECT lead_id FROM lead_request WHERE source = ?1 AND external_id = ?2`,
          request.source,
          request.externalId,
        )
        .toArray()[0]
      if (kept) {
        const lead = this.leadFor(text(kept.lead_id), all)
        if (lead) return ok({ lead, outcome: 'repeat' as const })
      }
      const email = request.email === null ? null : classifyAddress(request.email)
      const phone = request.phone === null ? null : classifyAddress(request.phone)
      const byEmail = email?.kind === 'email' ? email : null
      const byPhone = phone?.kind === 'sms' ? phone : null
      if (!byEmail && !byPhone) return fail(422, 'A lead needs an email address or a phone number the space can read.')
      const contactId = this.personForRequest(byEmail, byPhone, request.name, actor)
      const at = request.at ?? this.now()
      const values = filled(request.fields)
      const open = this.sql
        .exec(
          `SELECT id, fields, rev FROM lead WHERE contact_id = ?1 AND mailbox = ?2 AND stage NOT IN (SELECT value FROM json_each(?3)) ORDER BY last_request_at DESC LIMIT 1`,
          contactId,
          rules.mailbox,
          JSON.stringify(rules.settled),
        )
        .toArray()[0]
      // A carried-over lead keeps its own stage, so it is never folded into another: the site's records are already one per person.
      if (open && request.stage === undefined) {
        const leadId = text(open.id)
        const before = parseFields(open.fields)
        const merged = { ...before, ...values }
        this.sql.exec(
          `UPDATE lead SET fields = ?2, requests = requests + 1, last_request_at = max(last_request_at, ?3), rev = rev + 1,
                  email = coalesce(email, ?4), phone = coalesce(phone, ?5) WHERE id = ?1`,
          leadId,
          JSON.stringify(merged),
          at,
          byEmail?.address ?? null,
          byPhone?.address ?? null,
        )
        this.keepRequest(request.source, request.externalId, leadId, at)
        this.audit(
          actor,
          'lead.fold',
          `lead:${leadId}`,
          { fields: before, rev: Number(open.rev) },
          { fields: merged, request: request.externalId },
        )
        return ok({ lead: this.leadFor(leadId, all) as InboxLead, outcome: 'folded' as const })
      }
      const id = this.ports.newId()
      const stage = request.stage ?? rules.firstStage
      this.sql.exec(
        `INSERT INTO lead (id, contact_id, mailbox, stage, fields, source, email, phone, requests, created_at, created_by, last_request_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?9)`,
        id,
        contactId,
        rules.mailbox,
        stage,
        JSON.stringify(values),
        request.source,
        byEmail?.address ?? null,
        byPhone?.address ?? null,
        at,
        actor,
      )
      this.keepRequest(request.source, request.externalId, id, at)
      this.audit(actor, 'lead.create', `lead:${id}`, null, {
        contactId,
        stage,
        fields: values,
        request: request.externalId,
      })
      return ok({ lead: this.leadFor(id, all) as InboxLead, outcome: 'made' as const })
    })
  }

  /** How many open leads the person may see: the menu's count. */
  openLeadCount(mail: MailScope, settled: readonly string[]): number {
    const seen = scopeWhere(mail, LEAD_MAILBOX(), 2)
    const row = this.sql
      .exec(
        `SELECT count(*) AS n FROM lead l WHERE l.stage NOT IN (SELECT value FROM json_each(?1)) AND ${seen.sql}`,
        JSON.stringify(settled),
        ...seen.bindings,
      )
      .toArray()[0]
    return Number(row?.n ?? 0)
  }
}
