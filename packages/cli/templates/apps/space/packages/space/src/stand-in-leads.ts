// The stand-in inbox's leads (stand-ins.ts): two invented requests and the four lead methods over them, kept for as long as the dev server runs, so the Leads tab and a person's leads can be seen
// and moved with no inbox. The stages and fields are whatever the dev install declares; with none, the stand-in has no leads, as an install with the switch off has none.

import { answered, type InboxForSpace, type InboxLead, type Install, refused } from '@space/workspace'

type LeadMethods = Pick<InboxForSpace, 'leads' | 'contactLeads' | 'moveLead' | 'makeLead'>

export function standInLeads(install: Install, contacts: readonly { id: string; name: string; addresses: string[] }[], now: () => number): LeadMethods {
  const words = install.has('leads') ? install.leads() : null
  const first = words?.stages[0]?.id ?? 'new'
  const at = (minutesAgo: number) => new Date(now() - minutesAgo * 60_000).toISOString()
  const leads: InboxLead[] = contacts.slice(0, 2).map((c, i) => ({
    id: `lead-${i + 1}`,
    contactId: c.id,
    name: c.name,
    email: c.addresses[0] ?? null,
    phone: null,
    stage: i === 0 ? first : (words?.stages[1]?.id ?? first),
    fields: Object.fromEntries((words?.fields ?? []).slice(0, 3).map((f, n) => [f.key, ['Kitchen remodel', 'About 40,000', 'Next month'][n] as string])),
    source: i === 0 ? 'website' : null,
    requests: i === 0 ? 2 : 1,
    createdAt: at(90 + i * 600),
    lastRequestAt: at(30 + i * 600),
    createdBy: 'source:website',
    stageAt: null,
    stageBy: null,
    rev: 0,
  }))
  const none = () => refused('not-found', 'This space has no leads.')
  return {
    leads: async () => (words === null ? none() : answered({ leads: [...leads], more: false })),
    contactLeads: async (_a, contactId) =>
      answered({
        leads: words === null ? [] : leads.filter((l) => l.contactId === contactId),
        more: false,
      }),
    moveLead: async (a, move) => {
      if (words === null) return none()
      const lead = leads.find((l) => l.id === move.leadId)
      if (!lead) return refused('not-found', 'There is no such lead.')
      if (lead.rev !== move.rev) return refused('conflict', 'This lead changed since you opened it, so it was not moved.')
      if (!words.stages.some((s) => s.id === move.stage)) return refused('bad-request', 'That is not a stage of this space’s leads.')
      if (lead.stage !== move.stage)
        Object.assign(lead, {
          stage: move.stage,
          rev: lead.rev + 1,
          stageAt: new Date(now()).toISOString(),
          stageBy: a.person.address,
        })
      return answered({ ...lead })
    },
    makeLead: async (a, make) => {
      if (words === null) return none()
      const contact = contacts.find((c) => c.id === make.contactId)
      if (!contact) return refused('not-found', 'There is no such person.')
      const lead: InboxLead = {
        id: `lead-${leads.length + 1}`,
        contactId: contact.id,
        name: contact.name,
        email: contact.addresses[0] ?? null,
        phone: null,
        stage: first,
        fields: Object.fromEntries(Object.entries(make.fields).filter(([, v]) => v.trim() !== '')),
        source: null,
        requests: 1,
        createdAt: new Date(now()).toISOString(),
        lastRequestAt: new Date(now()).toISOString(),
        createdBy: a.person.address,
        stageAt: null,
        stageBy: null,
        rev: 0,
      }
      leads.unshift(lead)
      return answered({ ...lead })
    },
  }
}
