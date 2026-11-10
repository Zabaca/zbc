/**
 * Which one person an email thread is listed under in the space's Inbox lists.
 *
 * Pure, so a table pins it; the store gathers the candidates (`SpaceStore.placements`, src/store/space.ts) and both the lists
 * (`InboxThreadLine.listed`) and the menu's counts (`rowCounts`) read the one answer, so the two cannot place a thread differently.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 * A thread is listed once, under the person who last wrote on it: the contact of the newest message that CAME IN. Why: a relay service
 * (Craigslist) puts one listing on two addresses, `<hash>@reply.craigslist.org` with no name and `<hash>@sale.craigslist.org` with the
 * seller's, and listing a thread under each gave the owner two rows for one conversation, one of them titled by a hash. Ties, and threads nobody
 * outside has written on, go to the person with a display name over a bare address (a contact's name IS its address until a name is
 * learnt), then to whoever the newest message of either direction was with, then by contact id so the answer never depends on the order
 * the store read them in. A person's own page still shows every thread they are on: this decides the list's rows only.
 *
 * ── "OUTSIDE" ────────────────────────────────────────────────────────────
 * Only an outside person gets a row for a thread while one is on it. The owner's own addresses (every Gmail account of theirs, and the business mailboxes') and the team's are INSIDE and rank behind
 * every outsider, whoever wrote last: Priya writes to tessa@northfield.example and Tessa answers from another address of hers with the first copied, and that conversation is Priya's row, not a row for "Tessa".
 * A thread with no outsider on it (a note between two of the owner's own addresses, a thread among teammates) falls back to them by the same rule.
 */

export interface PlacementCandidate {
  contactId: string
  /** The contact's name, and every email address it has: a name that is one of its addresses is no name. */
  name: string
  addresses: readonly string[]
  /** One of the owner's own addresses or a teammate's is among `addresses` (`isInside`): ranked behind every outsider. */
  inside: boolean
  /** The time of the newest message that came in FROM this contact on the conversation; null when none did. */
  wroteAt: string | null
  /** The time of the newest message of either direction on this contact's identity on the conversation; null when none. */
  touchedAt: string | null
}

/** Whether any of a contact's addresses is the owner's own or a teammate's (`inside`: lowercase addresses). */
export const isInside = (addresses: readonly string[], inside: ReadonlySet<string>): boolean =>
  addresses.some((a) => inside.has(a.trim().toLowerCase()))

/** Whether the contact has a display name: a name that is only one of its addresses is a bare address. */
export function hasDisplayName(name: string, addresses: readonly string[]): boolean {
  const n = name.trim().toLowerCase()
  return n !== '' && !addresses.some((a) => a.trim().toLowerCase() === n)
}

/** Sorts the later time first, and a missing time last. */
const laterFirst = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1

/** The contact a conversation is listed under, or null when nobody is on it. */
export function placedUnder(candidates: readonly PlacementCandidate[]): string | null {
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(a.inside) - Number(b.inside) ||
      laterFirst(a.wroteAt, b.wroteAt) ||
      Number(hasDisplayName(b.name, b.addresses)) - Number(hasDisplayName(a.name, a.addresses)) ||
      laterFirst(a.touchedAt, b.touchedAt) ||
      a.contactId.localeCompare(b.contactId),
  )
  return ranked[0]?.contactId ?? null
}

/**
 * Where a conversation is listed: in every list but a Client's, under `everyone`'s pick; in a Client's list, under the pick among THAT Client's people only (the contacts linked to
 * it on the conversation), by the same rule. So a thread a Client's person is on is never lost from the Client's list because an outsider wrote last: it is the Client person's row there
 * and the outsider's in the Inbox. A contact with no Client is in no Client's list.
 */
export interface Placed {
  everyone: string | null
  byClient: Map<number, string>
}

export function placeConversation(candidates: readonly (PlacementCandidate & { clientId: number | null })[]): Placed {
  const byClient = new Map<number, string>()
  for (const id of new Set(candidates.flatMap((c) => (c.clientId === null ? [] : [c.clientId])))) {
    const among = placedUnder(candidates.filter((c) => c.clientId === id))
    if (among !== null) byClient.set(id, among)
  }
  return { everyone: placedUnder(candidates), byClient }
}
