import { describe, expect, test } from 'bun:test'
import { createInstall, type InboxLead, type InboxLeads, type SpaceReply } from '@space/workspace'
import { receiveLeadFromSource } from '../src/space-leads'
import { asker, count, harness, T0, TEAM } from '../test-support/harness'

/**
 * The company's leads (src/store/leads.ts, src/space-leads.ts), on an invented company whose leads belong to its shared Desk mailbox: Alex owns the install, Bea is on the Desk, Cal is a member who is
 * not. A request from the company's site makes or finds the person and makes or folds a lead; the board is for the Desk's people; a move names the revision it was shown.
 */

const ALEX = 'alex@marlowkitchens.example'
const BEA = 'bea@marlowkitchens.example'
const CAL = 'cal@marlowkitchens.example'
const DESK = 'desk@marlowkitchens.example'
const BOOKS = 'books@marlowbooks.example'
const SOURCE = 'marlowkitchens.example'

const declaration = (leads: boolean) => ({
  company: { id: 'marlow', name: 'Marlow Kitchens', domain: 'marlowkitchens.example', timeZone: 'America/Los_Angeles' },
  access: { teamDomain: TEAM },
  formsService: { contact: 'help@marlowkitchens.example' },
  space: { host: 'space.marlowkitchens.example', sessionDuration: '730h' },
  people: [
    { address: ALEX, name: 'Alex', mailName: 'Alex Rowe', role: 'owner' },
    { address: BEA, name: 'Bea', role: 'member' },
    { address: CAL, name: 'Cal', role: 'member' },
  ],
  businesses: [
    { id: 'marlow', name: 'Marlow Kitchens', mailboxes: [DESK] },
    { id: 'books', name: 'Marlow Books', mailboxes: [BOOKS] },
  ],
  cloudflareMailboxes: [
    { address: DESK, name: 'Desk', people: [ALEX, BEA] },
    { address: BOOKS, name: 'Books', people: [ALEX, CAL] },
  ],
  switches: { leads },
  ...(leads && {
    leads: {
      mailbox: DESK,
      stages: [
        { id: 'new', label: 'New' },
        { id: 'called', label: 'Called' },
        { id: 'won', label: 'Won', settled: true },
        { id: 'lost', label: 'Lost', settled: true },
      ],
      fields: { project: { label: 'Project', board: true }, budget: { label: 'Budget' }, notes: { label: 'Notes' } },
    },
  }),
})

const MARLOW = createInstall(declaration(true))

const value = <T>(r: SpaceReply<T>): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { ok: true; value: T }).value
}
const reason = (r: SpaceReply<unknown>): string => {
  expect(r.ok, JSON.stringify(r)).toBe(false)
  return (r as { reason: string }).reason
}

async function world(install = MARLOW, deskHasMail = true) {
  const h = harness(
    {},
    {
      install,
      mailboxes: [
        { address: DESK, name: 'Desk' },
        { address: BOOKS, name: 'Books' },
      ],
    },
  )
  // One email to each mailbox, so each is made and its people seated, as the first mail does on a live install.
  const raw = (to: string, id: string, from: string) =>
    [
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Hello',
      `Message-ID: <${id}@mail.example>`,
      'Date: Mon, 20 Oct 2026 12:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Hi there',
      '',
    ].join('\r\n')
  if (deskHasMail)
    expect((await h.deliver(raw(DESK, 'd1', 'Cora Lund <cora@dock.example>'), { to: DESK })).entered).toBe('filed')
  expect((await h.deliver(raw(BOOKS, 'b1', 'Vic Tran <vic@vendor.example>'), { to: BOOKS })).entered).toBe('filed')
  const space = h.space({ install })
  const send = (
    externalId: string,
    o: {
      name?: string
      email?: string | null
      phone?: string | null
      fields?: Record<string, unknown>
      stage?: string
      at?: string
    },
  ) =>
    receiveLeadFromSource(
      { store: h.store, install },
      {
        source: SOURCE,
        externalId,
        name: o.name ?? 'Jo Park',
        email: o.email === undefined ? 'jo@home.example' : o.email,
        phone: o.phone ?? null,
        fields: o.fields ?? {},
        ...(o.stage && { stage: o.stage }),
        ...(o.at && { at: o.at }),
      },
    )
  return { h, space, send, as: (who: string) => asker({ email: who }, install) }
}

describe('a request from the company’s site', () => {
  test('makes the person and a lead in the first stage; the same request again changes nothing', async () => {
    const { h, send, space, as } = await world()
    const first = value(await send('q1', { phone: '(626) 555-0101', fields: { project: 'Kitchen', budget: '50k' } }))
    expect(first.outcome).toBe('made')
    expect(first.lead).toMatchObject({
      name: 'Jo Park',
      email: 'jo@home.example',
      phone: '+16265550101',
      stage: 'new',
      fields: { project: 'Kitchen', budget: '50k' },
      source: SOURCE,
      requests: 1,
      rev: 0,
    })
    const identities = h.db
      .query(`SELECT kind, address FROM identity WHERE contact_id = ? ORDER BY kind`)
      .all(first.lead.contactId)
    expect(identities).toEqual([
      { kind: 'email', address: 'jo@home.example' },
      { kind: 'sms', address: '+16265550101' },
    ])
    const again = value(await send('q1', { fields: { project: 'Bathroom' } }))
    expect(again.outcome).toBe('repeat')
    expect(again.lead).toEqual(first.lead)
    expect(count(h, 'lead')).toBe(1)
    expect(value(await space.leads(as(ALEX))).leads.map((l) => l.id)).toEqual([first.lead.id])
  })

  test('the same person asking again while the lead is open is folded into it, by the address or by the number; a blank never writes over a value', async () => {
    const { h, send } = await world()
    const first = value(await send('q1', { phone: '626-555-0101', fields: { project: 'Kitchen', budget: '50k' } }))
    const byAddress = value(await send('q2', { fields: { project: 'Kitchen and bath', budget: '  ' } }))
    expect(byAddress.outcome).toBe('folded')
    expect(byAddress.lead).toMatchObject({
      id: first.lead.id,
      requests: 2,
      rev: 1,
      fields: { project: 'Kitchen and bath', budget: '50k' },
    })
    // From another address, the same number written another way: still Jo.
    const byNumber = value(
      await send('q3', {
        email: 'jo.work@office.example',
        phone: '+1 626 555 0101',
        fields: { notes: 'Call after 5' },
      }),
    )
    expect(byNumber.outcome).toBe('folded')
    expect(byNumber.lead).toMatchObject({
      id: first.lead.id,
      requests: 3,
      fields: { project: 'Kitchen and bath', budget: '50k', notes: 'Call after 5' },
    })
    expect(count(h, 'lead')).toBe(1)
    expect(count(h, 'lead_request')).toBe(3)
  })

  test('after the lead is settled, the next request is a new lead', async () => {
    const { send, space, as } = await world()
    const first = value(await send('q1', {}))
    value(await space.moveLead(as(ALEX), { leadId: first.lead.id, rev: 0, stage: 'won' }))
    const next = value(await send('q2', {}))
    expect(next.outcome).toBe('made')
    expect(next.lead.id).not.toBe(first.lead.id)
    expect(next.lead.contactId).toBe(first.lead.contactId)
    // The open one first, then the settled one.
    expect(value(await space.contactLeads(as(ALEX), first.lead.contactId)).leads.map((l) => l.stage)).toEqual([
      'new',
      'won',
    ])
  })

  test('a blank address and a number the space cannot read key on nothing: such a request is refused, and never folded onto anyone', async () => {
    const { h, send } = await world()
    value(await send('q1', { email: null, phone: '626 555 0101' }))
    expect(reason(await send('q2', { email: '', phone: 'call me' }))).toBe('bad-request')
    expect(reason(await send('q3', { email: null, phone: null }))).toBe('bad-request')
    expect(count(h, 'lead')).toBe(1)
  })

  test('a field the install does not declare, or a stage it does not, is refused with nothing kept', async () => {
    const { h, send } = await world()
    expect(reason(await send('q1', { fields: { colour: 'blue' } }))).toBe('bad-request')
    expect(reason(await send('q2', { fields: { project: 7 } }))).toBe('bad-request')
    expect(reason(await send('q3', { stage: 'maybe' }))).toBe('bad-request')
    expect(count(h, 'lead')).toBe(0)
    expect(count(h, 'contact')).toBe(2)
  })

  test('a lead carried over from the site keeps its stage and its date, and is never folded', async () => {
    const { send } = await world()
    const old = value(await send('old-1', { stage: 'called', at: '2026-09-01T10:00:00.000Z' }))
    expect(old.lead).toMatchObject({
      stage: 'called',
      createdAt: '2026-09-01T10:00:00.000Z',
      lastRequestAt: '2026-09-01T10:00:00.000Z',
    })
    const older = value(await send('old-2', { stage: 'new', at: '2026-08-01T10:00:00.000Z' }))
    expect(older.outcome).toBe('made')
  })
})

describe('who sees the leads', () => {
  test('the owner and the Desk’s people see the board; a member who is not on the Desk is refused, and sees no leads on a person’s page', async () => {
    const { send, space, as } = await world()
    const made = value(await send('q1', {}))
    expect(value(await space.leads(as(ALEX))).leads).toHaveLength(1)
    expect(value(await space.leads(as(BEA))).leads).toHaveLength(1)
    expect(reason(await space.leads(as(CAL)))).toBe('not-admitted')
    expect(reason(await space.contactLeads(as(CAL), made.lead.contactId))).toBe('not-admitted')
    expect(reason(await space.moveLead(as(CAL), { leadId: made.lead.id, rev: 0, stage: 'called' }))).toBe(
      'not-admitted',
    )
  })

  test('where the switch is off there are no leads', async () => {
    const off = createInstall(declaration(false))
    const { space, as } = await world(off)
    expect(reason(await space.leads(as(ALEX)))).toBe('not-found')
    expect(reason(await space.contactLeads(as(ALEX), 'any-contact'))).toBe('not-found')
  })
})

describe('moving a lead', () => {
  test('a move names the revision it was shown: a stale one is a conflict with nothing moved; a stage the install does not have is refused', async () => {
    const { h, send, space, as } = await world()
    const { lead } = value(await send('q1', {}))
    const moved = value(await space.moveLead(as(BEA), { leadId: lead.id, rev: 0, stage: 'called' }))
    expect(moved).toMatchObject({ stage: 'called', rev: 1, stageBy: BEA })
    expect(reason(await space.moveLead(as(ALEX), { leadId: lead.id, rev: 0, stage: 'lost' }))).toBe('conflict')
    expect(reason(await space.moveLead(as(ALEX), { leadId: lead.id, rev: 1, stage: 'maybe' }))).toBe('bad-request')
    expect(reason(await space.moveLead(as(ALEX), { leadId: 'no-such-lead', rev: 1, stage: 'won' }))).toBe('not-found')
    // To the stage it is in: no change, no revision.
    expect(value(await space.moveLead(as(ALEX), { leadId: lead.id, rev: 1, stage: 'called' }))).toEqual(moved)
    expect(h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'lead.move'`).get()).toEqual({ n: 1 })
  })
})

describe('a lead made by hand', () => {
  test('is made for a person in the first stage, with only the install’s fields', async () => {
    const { h, space, as } = await world()
    const cora = (
      h.db.query(`SELECT contact_id FROM identity WHERE address = 'cora@dock.example'`).get() as { contact_id: string }
    ).contact_id
    expect(reason(await space.makeLead(as(BEA), { contactId: cora, fields: { colour: 'blue' } }))).toBe('bad-request')
    const made: InboxLead = value(
      await space.makeLead(as(BEA), { contactId: cora, fields: { project: 'Deck', budget: '' } }),
    )
    expect(made).toMatchObject({
      contactId: cora,
      name: 'Cora Lund',
      email: 'cora@dock.example',
      stage: 'new',
      fields: { project: 'Deck' },
      source: null,
      createdBy: BEA,
    })
    expect(reason(await space.makeLead(as(BEA), { contactId: 'no-such-person', fields: {} }))).toBe('not-found')
  })
})

describe('a merge', () => {
  test('carries the absorbed person’s leads to the survivor, and its undo carries them back', async () => {
    const { h, send, space, as } = await world()
    const jo = value(await send('q1', {}))
    const other = value(await send('q2', { name: 'Jo P', email: 'jp@else.example' }))
    expect(other.lead.contactId).not.toBe(jo.lead.contactId)
    const rev = (id: string) =>
      (h.db.query(`SELECT profile_rev AS r FROM contact WHERE id = ?`).get(id) as { r: number }).r
    const merged = await space.mergeContacts(as(ALEX), {
      survivorId: jo.lead.contactId,
      survivorRev: rev(jo.lead.contactId),
      absorbedId: other.lead.contactId,
      absorbedRev: rev(other.lead.contactId),
    })
    const mergeId = (value(merged) as { mergeId: number }).mergeId
    const after: InboxLeads = value(await space.contactLeads(as(ALEX), jo.lead.contactId))
    expect(after.leads.map((l) => l.id).sort()).toEqual([jo.lead.id, other.lead.id].sort())
    value(await space.undoContactMerge(as(ALEX), mergeId))
    expect(value(await space.contactLeads(as(ALEX), jo.lead.contactId)).leads.map((l) => l.id)).toEqual([jo.lead.id])
    expect(value(await space.contactLeads(as(ALEX), other.lead.contactId)).leads.map((l) => l.id)).toEqual([
      other.lead.id,
    ])
    void T0
  })
})

describe('the leads’ mailbox, a request’s id and moment, a split, and the menu', () => {
  test('until mail has made the leads’ mailbox, its leads are the owner’s alone: the Desk’s other people are refused before anything is written', async () => {
    const { h, space, send, as } = await world(MARLOW, false)
    const vic = (
      h.db.query(`SELECT contact_id FROM identity WHERE address = 'vic@vendor.example'`).get() as { contact_id: string }
    ).contact_id
    expect(reason(await space.makeLead(as(BEA), { contactId: vic, fields: {} }))).toBe('not-admitted')
    expect(reason(await space.leads(as(BEA)))).toBe('not-admitted')
    expect(count(h, 'lead')).toBe(0)
    const made = value(await send('q1', {}))
    expect(value(await space.leads(as(ALEX))).leads.map((l) => l.id)).toEqual([made.lead.id])
    expect(value(await space.makeLead(as(ALEX), { contactId: vic, fields: {} })).stage).toBe('new')
  })

  test('a request with no id of its own, or a moment that is not one, is refused with nothing kept', async () => {
    const { h, send } = await world()
    expect(reason(await send('', {}))).toBe('bad-request')
    expect(reason(await send('q1', { at: 'not a date' }))).toBe('bad-request')
    expect(value(await send('q2', { at: '2026-09-01T10:00:00Z', stage: 'called' })).lead.createdAt).toBe(
      '2026-09-01T10:00:00.000Z',
    )
    expect(count(h, 'lead')).toBe(1)
  })

  test('an address split off a person takes the lead that came in on it', async () => {
    const { h, send, space, as } = await world()
    const home = value(await send('q1', { phone: '626 555 0101' }))
    value(await space.moveLead(as(ALEX), { leadId: home.lead.id, rev: 0, stage: 'won' }))
    // From another address with the same number: the same person, given that address too, and a new lead (the first is settled).
    const work = value(await send('q2', { email: 'jo.work@office.example', phone: '626 555 0101' }))
    expect([work.outcome, work.lead.contactId]).toEqual(['made', home.lead.contactId])
    const identity = h.db.query(`SELECT id FROM identity WHERE address = 'jo.work@office.example'`).get() as {
      id: string
    }
    const rev = (
      h.db.query(`SELECT profile_rev AS r FROM contact WHERE id = ?`).get(home.lead.contactId) as { r: number }
    ).r
    const split = value(
      await space.splitAddress(as(ALEX), { contactId: home.lead.contactId, rev, identityId: identity.id }),
    ) as { contact: { contactId: string } }
    expect(value(await space.contactLeads(as(ALEX), split.contact.contactId)).leads.map((l) => l.id)).toEqual([
      work.lead.id,
    ])
    expect(value(await space.contactLeads(as(ALEX), home.lead.contactId)).leads.map((l) => l.id)).toEqual([
      home.lead.id,
    ])
  })

  test('the menu counts the open leads for the people who may see them, and says nothing to anyone else', async () => {
    const { send, space, as } = await world()
    const first = value(await send('q1', {}))
    value(await send('q2', { email: 'sam@else.example', name: 'Sam' }))
    value(await space.moveLead(as(ALEX), { leadId: first.lead.id, rev: 0, stage: 'won' }))
    expect((value(await space.navigation(as(ALEX))) as { openLeads?: number }).openLeads).toBe(1)
    expect((value(await space.navigation(as(BEA))) as { openLeads?: number }).openLeads).toBe(1)
    expect(value(await space.navigation(as(CAL)))).not.toHaveProperty('openLeads')
  })
})
