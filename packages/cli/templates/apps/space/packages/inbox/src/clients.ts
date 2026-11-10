import type { Client, ClientsForInbox } from '@space/workspace'
import type { ClientLabel, ClientSuggestion, ClientView, DirectoryStatus, ListedClient } from './types'
import type { Install } from './workspace'

/**
 * The Clients, as the inbox uses them: the seam to the Clients part and the rules that
 * need only its list.
 *
 * ── THE SPACE OWNS CLIENTS, THE INBOX ONLY ASKS ──────────────────────────
 * A Client is a business the company serves. The one list of them is the Clients part's
 * (packages/clients, the space's ADR 0021), which the space's Worker runs beside this
 * package; the inbox keeps no list of businesses of its own. So this module holds nothing.
 * `readClients` asks the part whenever a request needs Clients (a handful of rows) and
 * nothing is cached, so a Client made or renamed in Settings shows on the next page load.
 * (The inbox does not read the list from an outside site through a service binding, and has
 * no dependency on one.)
 *
 * ── THE PORT IS THE SEAM ─────────────────────────────────────────────────
 * `ClientsForInbox` is two reads, the list and one Client, called in-process in the space's
 * Worker. It can read and do nothing else. In tests the real part runs over a real SQLite
 * (test-support/clients-part.ts).
 *
 * ── WHEN IT DOES NOT ANSWER ──────────────────────────────────────────────
 * The part is in the same Worker, so this is rare, but it is a value and not an exception:
 * mail, conversations and contacts go on working. Clients show as "Client 7" (the id the
 * contact holds), suggestions are not offered (nothing can vouch for a Client), and an
 * ASSIGNMENT is refused until it answers: a contact must never point at a Client the part
 * has not confirmed. What a source says of a Client, and whether the source is up, is
 * nothing to the inbox: a Client its source stopped listing is still in the part, and
 * linking a person never waits on the source.
 */

/** What a request that needs Clients gets: whether the part answered, and the Clients if so (archived ones included, marked). */
export interface ClientsRead extends DirectoryStatus {
  clients: ListedClient[]
}

export const CLIENTS_NOT_CONNECTED = 'The Clients are not connected to this Worker, so Clients show by number.'
export const CLIENTS_DID_NOT_ANSWER = 'The Client list did not answer, so Clients show by number.'

const down = (error: string): ClientsRead => ({ available: false, error, clients: [] })

const normalised = (raw: string | undefined): string | null =>
  raw === undefined ? null : raw.trim().toLowerCase() || null

/**
 * A Client of the part as the inbox reads it. The admin address is the source's own `url`, and `extra` is whatever the source said, handed on untouched. The inbox understands ONE key of it:
 * `suggestByAddressKey`, the key the company declaration names as holding an address to suggest by (`clientsDoor.suggestByAddressKey`; null where the install declares none). A Client made in the
 * space has no source, so no extra and no address.
 */
export function listedClient(c: Client, suggestByAddressKey: string | null): ListedClient {
  const extra = c.source?.extra ?? {}
  return {
    id: c.number,
    name: c.name,
    legalEntity: c.legalName,
    matchAddress: suggestByAddressKey === null ? null : normalised(extra[suggestByAddressKey]),
    extra,
    adminUrl: c.source?.url ?? null,
    archived: c.archivedAt !== null,
  }
}

/** Ask the part. Never throws: an outage is a value, so everything that is not Clients carries on. `install` is the company's declaration, which names the one key of a source's extra fields to suggest by. */
export async function readClients(part: ClientsForInbox | null | undefined, install: Install): Promise<ClientsRead> {
  if (!part) return down(CLIENTS_NOT_CONNECTED)
  const suggestKey = install.clientsDoor()?.suggestByAddressKey ?? null
  try {
    const got = await part.list()
    if (!got.ok) {
      console.warn('the Clients part did not give the list', got)
      return down(CLIENTS_DID_NOT_ANSWER)
    }
    return { available: true, error: null, clients: got.value.map((c) => listedClient(c, suggestKey)) }
  } catch (error) {
    console.warn('the Clients part did not answer', error)
    return down(CLIENTS_DID_NOT_ANSWER)
  }
}

export const clientsById = (clients: ListedClient[]): Map<number, ListedClient> =>
  new Map(clients.map((c) => [c.id, c]))

/** "Client 7": what a Client the part did not name is called. */
export const placeholderName = (id: number): string => `Client ${id}`

export function clientLabel(id: number, byId: Map<number, ListedClient>): ClientLabel {
  const known = byId.get(id)
  return known ? { id, name: known.name, listed: true } : { id, name: placeholderName(id), listed: false }
}

export function clientView(id: number, byId: Map<number, ListedClient>): ClientView {
  const known = byId.get(id)
  return {
    ...clientLabel(id, byId),
    legalEntity: known?.legalEntity ?? null,
    extra: known?.extra ?? {},
    adminUrl: known?.adminUrl ?? null,
    archived: known?.archived ?? false,
  }
}

/** Whether a contact may be put under a Client now: the part must answer, hold the Client, and not have it archived. Taking a contact out needs no answer and does not come here. */
export type LinkCheck = { ok: true } | { ok: false; why: 'down' | 'unknown' | 'archived'; error: string }

export function checkLink(read: ClientsRead, id: number): LinkCheck {
  if (!read.available)
    return {
      ok: false,
      why: 'down',
      error: `${read.error} Nothing was assigned: try again once the Client list answers.`,
    }
  const known = read.clients.find((c) => c.id === id)
  if (!known) return { ok: false, why: 'unknown', error: `There is no Client ${id}, so nothing was assigned.` }
  if (known.archived)
    return {
      ok: false,
      why: 'archived',
      error: `${known.name} is archived, so nothing was assigned. Put it back in Settings first.`,
    }
  return { ok: true }
}

// ─── suggestions ───────────────────────────────────────────────────────

/**
 * Domains that say nothing about who works where: anybody at all writes from them. Fixed
 * in code, as the option says (a list somebody edits is a list nobody remembers to). A
 * domain here is never evidence that two people are at the same business.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]

/** What the rule needs of a contact: who they are, their Client if any, and their email addresses, normalized. */
export interface SuggestionContact {
  id: string
  name: string
  clientId: number | null
  emails: string[]
}

/** The domain of an address, lower case; empty when there is no @. The one place it is cut, for suggestions and for the automated-sender rule. */
export const domainOf = (address: string): string => {
  const at = address.lastIndexOf('@')
  return at === -1
    ? ''
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase()
}

/**
 * The Clients to suggest for contacts that have none, and why. PURE: the contacts and the
 * Clients in, suggestions out, so the rule is a table test.
 *
 * Two rules, and nothing else:
 *   1. one of the contact's addresses equals the address a Client's source gave under the declared
 *      key (`matchAddress`, so a Client made in the space, or an install with no such key, never
 *      suggests by this rule); or
 *   2. one of its addresses is on a domain that is not free-mail and not ours, and is a
 *      domain that contacts assigned to EXACTLY ONE Client write from. A domain shared by
 *      people of two Clients says nothing, so it suggests nothing.
 * A contact that already has a Client is never suggested another: an assignment somebody
 * made is not argued with. A Client the part does not hold is never suggested, so with the
 * part not answering there are none, and neither is an archived one (a link to it is refused).
 *
 * ⚠️ A SUGGESTION IS ONLY A SUGGESTION. Nothing here writes, and nothing that calls it may
 * assign on its result: this repo attaches nothing to a Client by matching on an address,
 * and a suggestion takes effect only when the owner or the agent accepts it, which is an
 * ordinary assignment, audited with its actor. Our own domain is excluded from rule 2 for
 * the same reason it is not evidence: it is the one domain every contact's mail passes
 * through (our address is on every conversation), so one mistaken assignment of our own
 * contact would otherwise suggest that Client for everybody at the install's own domain.
 */
export function suggestClients(
  contacts: SuggestionContact[],
  clients: ListedClient[],
  ownDomain: string,
): ClientSuggestion[] {
  const open = clients.filter((c) => !c.archived)
  const listed = clientsById(open)
  const byAddress = new Map<string, ListedClient>()
  for (const c of open) if (c.matchAddress) byAddress.set(c.matchAddress, c)

  const domainClients = new Map<string, Set<number>>()
  for (const contact of contacts) {
    if (contact.clientId === null) continue
    for (const address of contact.emails) {
      const domain = domainOf(address)
      if (FREE_MAIL_DOMAINS.includes(domain) || domain === ownDomain) continue
      const set = domainClients.get(domain) ?? new Set<number>()
      set.add(contact.clientId)
      domainClients.set(domain, set)
    }
  }

  const out: ClientSuggestion[] = []
  for (const contact of contacts) {
    if (contact.clientId !== null) continue
    const suggested = new Set<number>()
    const suggest = (client: ListedClient, reason: ClientSuggestion['reason'], via: string) => {
      if (suggested.has(client.id)) return
      suggested.add(client.id)
      out.push({
        contactId: contact.id,
        contactName: contact.name,
        clientId: client.id,
        clientName: client.name,
        reason,
        via,
      })
    }
    for (const address of contact.emails) {
      const client = byAddress.get(address)
      if (client) suggest(client, 'address', address)
    }
    for (const address of contact.emails) {
      const domain = domainOf(address)
      const only = [...(domainClients.get(domain) ?? [])]
      if (only.length !== 1) continue
      const client = listed.get(only[0] as number)
      if (client) suggest(client, 'domain', domain)
    }
  }
  return out
}
