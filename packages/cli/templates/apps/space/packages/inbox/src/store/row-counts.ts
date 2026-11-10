import { isBulk } from '../queue'
import type { QueueFact } from '../types'

/**
 * The menu's counts in the unit the space's lists are drawn in: ROWS, one per person, not conversations. Pure, so a table pins it.
 *
 * ── WHY THE INBOX COUNTS ROWS ────────────────────────────────────────────
 * The queue (`planQueue`) counts conversations, and the space's Inbox list is a row per person (packages/space/src/conversations.ts): a person with three open
 * threads is one row, and a thread several people are on is listed under ONE of them, the one who last wrote on it (`placedUnder`, src/store/placement.ts; it used to be
 * a row under each). A menu that said "Inbox 7" over a list of 4 rows read as a fault. The space's lists are cut at the
 * newest QUEUE_PAGE conversations; a count is not (a menu that stopped at the cap would say less than there is, and not say so), so this counts every conversation
 * in the store, in one pass over the facts the queue already reads and the placement of each conversation (`SpaceStore.placements`: who is on it and the newest message from each
 * of them, grouped by conversation and contact, no message body read).
 *
 * ── THE RULE IS THE LISTS' ───────────────────────────────────────────────
 * Which conversations a view holds is the space's `inView` (conversations.ts), written once more here in terms of a fact (Inbox: open and not Bulk; a mailbox: that
 * and in the mailbox; Bulk: open and Bulk; Closed: not open; Drafts: a draft waiting, whatever state; a Client: open, Bulk included, and a thread placed among that Client's people only). A row is a person: the
 * contacts the conversations are placed under, joined as the space joins them (`mergeConversations`). An address belongs to ONE contact, so two contacts are never joined by
 * a shared address; the only join left in mail is a teammate known by two addresses (the company address and the sign-in address), which the space puts in one
 * row: `team` is those address sets, one per teammate. A contact with an address in a set is that teammate's row. Unread is the rows with anything unread; a
 * Client's rows are the people with a contact linked to it that is its Client's pick on a conversation of the view (the thread is placed among the Client's people only, so a Client
 * never loses a thread one of them is on), and their unread is over every line the Client's list keeps of the whole person. The space's test of the menu against its lists
 * (packages/space/test/nav-counts.test.ts) is what holds the two spellings together.
 */

export interface RowParty {
  conversationId: string
  contactId: string
  clientId: number | null
  /** Every email address of the contact, lowercase. */
  addresses: readonly string[]
  /** Whether the lists put the conversation under this contact (src/store/placement.ts): a conversation is a row of its placed contact ONLY. */
  placed: boolean
  /** Whether it is placed in its Client's list: this contact is the pick among the people linked to its Client on the conversation (a contact with no Client is in no Client's list: never). */
  placedInClient: boolean
}

export interface RowCount {
  count: number
  unread: number
}

export interface RowCounts {
  views: { inbox: RowCount; unread: RowCount; drafts: RowCount; bulk: RowCount; closed: RowCount }
  /** By mailbox id: every mailbox that has a conversation in the Inbox view's sense. A mailbox absent here has 0. */
  mailboxes: Record<string, RowCount>
  /** By Client id: every Client with a contact on an open conversation. A Client absent here has 0. */
  clients: Record<number, RowCount>
}

interface Row {
  unread: boolean
}

export function rowCounts(
  facts: readonly QueueFact[],
  parties: readonly RowParty[],
  team: readonly (readonly string[])[],
): RowCounts {
  const teamOf = new Map<string, number>()
  team.forEach((set, n) => {
    for (const a of set) if (!teamOf.has(a)) teamOf.set(a, n)
  })
  // A person's row: the teammate's when any address is a teammate's (the first address in the order the space reads them, sorted), else the contact.
  const keyOf = (p: RowParty): string => {
    for (const a of [...p.addresses].sort()) {
      const n = teamOf.get(a)
      if (n !== undefined) return `team:${n}`
    }
    return `contact:${p.contactId}`
  }
  const on = new Map<string, { key: string; clientId: number | null; placed: boolean; placedInClient: boolean }[]>()
  for (const p of parties) {
    const held = on.get(p.conversationId) ?? []
    held.push({ key: keyOf(p), clientId: p.clientId, placed: p.placed, placedInClient: p.placedInClient })
    on.set(p.conversationId, held)
  }

  /** The rows of the conversations a view keeps. */
  const rowsOf = (keep: (f: QueueFact) => boolean): Map<string, Row> => {
    const rows = new Map<string, Row>()
    for (const f of facts) {
      if (!keep(f)) continue
      for (const party of on.get(f.id) ?? []) {
        if (!party.placed) continue
        const row = rows.get(party.key) ?? { unread: false }
        if (f.unread) row.unread = true
        rows.set(party.key, row)
      }
    }
    return rows
  }
  const counted = (rows: Iterable<Row>): RowCount => {
    let count = 0
    let unread = 0
    for (const r of rows) {
      count += 1
      if (r.unread) unread += 1
    }
    return { count, unread }
  }

  const inbox = rowsOf((f) => f.open && !isBulk(f))
  const unreadRows = [...inbox.values()].filter((r) => r.unread)
  const mailboxIds = new Set(facts.flatMap((f) => (f.mailbox ? [f.mailbox.id] : [])))
  const mailboxes: Record<string, RowCount> = {}
  for (const id of mailboxIds)
    mailboxes[id] = counted(rowsOf((f) => f.open && !isBulk(f) && f.mailbox?.id === id).values())

  // A Client's list places a thread among that Client's people only: of a contact with a Client it keeps the lines where the contact is its Client's pick (`placedInClient`), and of a
  // contact with none every line (the page then keeps the rows of the Client's people). A row is the whole person, so a teammate's two contacts, one linked to a Client and one not, are
  // ONE row and its unread is over every kept line of both, as the space's merge sums them.
  const clientRows = new Map<string, { unread: boolean; clients: Set<number> }>()
  for (const f of facts) {
    if (!f.open) continue
    for (const party of on.get(f.id) ?? []) {
      if (party.clientId !== null && !party.placedInClient) continue
      const row = clientRows.get(party.key) ?? { unread: false, clients: new Set<number>() }
      if (f.unread) row.unread = true
      if (party.clientId !== null) row.clients.add(party.clientId)
      clientRows.set(party.key, row)
    }
  }
  const perClient = new Map<number, Row[]>()
  for (const row of clientRows.values()) {
    for (const c of row.clients) perClient.set(c, [...(perClient.get(c) ?? []), row])
  }
  const clients: Record<number, RowCount> = {}
  for (const [id, rows] of perClient) clients[id] = counted(rows)

  return {
    views: {
      inbox: counted(inbox.values()),
      // Unread is its own number: every row of it has something unread.
      unread: { count: unreadRows.length, unread: unreadRows.length },
      drafts: counted(rowsOf((f) => f.drafts > 0).values()),
      bulk: counted(rowsOf((f) => f.open && isBulk(f)).values()),
      closed: counted(rowsOf((f) => !f.open).values()),
    },
    mailboxes,
    clients,
  }
}
