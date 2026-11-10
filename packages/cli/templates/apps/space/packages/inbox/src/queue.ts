import { clientLabel } from './clients'
import { BULK_CATEGORY_LABELS } from './gmail/types'
import {
  type ConversationSummary,
  clientFilterId,
  clientIdOfFilter,
  type ListedClient,
  type MailboxMark,
  mailboxFilterId,
  QUEUE_PAGE,
  type QueueFact,
  type QueueFilter,
  type QueueFilterId,
  type QueueRow,
} from './types'

/**
 * The queue: the rows on screen, the filters down the left and their counts, all
 * from ONE list.
 *
 * Counts that come from a separate query drift from the rows they are the counts
 * of: a badge that says 3 above a list of 2 is worse than no badge. So the
 * store hands over a small FACT for every conversation (state, drafts, envelope),
 * and every count here is a count of that one list and the rows are its first
 * screen: the filter is applied BEFORE the cut to a screen (cutting first
 * would count only that page, so a mailbox with a screenful of
 * closed mail would hide the open ones and a count would disagree with the
 * Gmail page's). The counts cover the whole mailbox; the rows are the latest
 * QUEUE_PAGE of the filter asked for.
 *
 * Pure: it takes data and returns data, so the rules are table tests with no
 * store at all.
 *
 * ── THE FILTERS, AND WHERE A CONVERSATION SHOWS ──────────────────────────
 * Inbox: open, and not Bulk. (The word is the app's main view, not Gmail's Inbox,
 * which holds Bulk too.) Unread: the Inbox's unread ones, as a view of their own.
 * Bulk: open, and Bulk. Closed: not open, Bulk or not. So a newsletter is under
 * Bulk while it is in Gmail's Inbox, under Closed once it is archived, and NEVER
 * under Inbox: that is what "Bulk alone" means. Drafts is
 * every conversation with a draft waiting, open or not, because a draft is owed
 * whatever state its conversation is in, and its count also includes the drafts
 * that sit on no conversation (a new email, a text, a DM), which the route lists
 * above the rows: nothing waiting for the owner is out of sight.
 *
 * One filter per Client (`client:<id>`), after those: the Client's OPEN conversations,
 * for each Client that has any. It is the work to be done for that Client, so it is the
 * open ones, as the Inbox is, and a Client's closed mail is in the Client's view (whose rows are the Client's page answer). The
 * filters are the Clients of the people on the conversations (their contacts' assigned
 * Client), counted from the same facts as every other count; they are labelled with the
 * directory's names, and "Client 7" for one the directory did not name (it is down, or no
 * longer lists the id), so the queue keeps working with the directory down.
 *
 * One filter per Cloudflare mailbox (`mailbox:<id>`, a business mailbox), after the built-ins: that mailbox's open conversations that
 * are not Bulk, as the Inbox is, counted from the same facts as every other count. The owner's own Gmail mail is in no such
 * view, and a store with no Cloudflare mailbox has none of these filters. The
 * Inbox, Unread, Drafts, Bulk and Closed cover both kinds of mailbox: one list, however many mailboxes feed it.
 *
 * Not built, each to sit beside these once claiming and assigning exist: Nobody has
 * picked up, Mine and Claude's. Sent by Claude is not a
 * filter of this queue: the messages Claude sent are marked where they happened, because
 * the queue is conversations with something to do and those are sent.
 *
 * The old id `all` (and any id not named here) is not recognized: it shows the Inbox, as
 * any unknown filter does, with no alias for the name it had.
 */

// ── WHO MAY SEE WHICH MAIL ───────────────────────────────────────────────
// (The inbox's ADR 0004.)
//
// A mailbox has people: one (a Gmail account they connected) or several (a shared mailbox). A person sees the mail of the mailboxes they are on and nothing else, so everything the inbox
// answers a person (lists, counts, search, a conversation by its id, drafts, files, notifications, Today, People) is first cut down by `canSee`, and by this function alone: the store reads
// the same rule as SQL (`scopeWhere`, src/store/scope.ts, held equal to it by test/mail-scope.test.ts) and the part of the space asks it before it answers by id. Mail that belongs to NO mailbox
// (a text or a note, a draft not yet made from a mailbox, a person with no mail at all) is the install's owner's: `unfiled`.
//
// Pure: a scope is data (the ids of the mailboxes a person is on), so every rule here is a table test.

/**
 * What a person may see of the store's mail: the mailboxes they are on, by id, and whether what belongs to no mailbox is theirs too (the install's owner's). `mailboxIds: null` is every mailbox: the
 * store's own jobs (the alarm, a sync, an arrival) and nothing that answers a person.
 */
export interface MailScope {
  readonly mailboxIds: readonly string[] | null
  readonly unfiled: boolean
}

/** Everything, for the store's own work. A reader that answers a person is handed that person's scope, never this one: `test/mail-scope.test.ts` holds the part of the space to it. */
export const ALL_MAIL: MailScope = { mailboxIds: null, unfiled: true }

/** A person's scope: the mailboxes they are on, and what belongs to none only if they are the install's owner. */
export const scopeOf = (mailboxIds: readonly string[], isOwner: boolean): MailScope => ({
  mailboxIds: [...new Set(mailboxIds)].sort(),
  unfiled: isOwner,
})

/** Whether a conversation or a message in the mailbox with this id (null: in none) is the person's to see. */
export const canSee = (scope: MailScope, mailboxId: string | null | undefined): boolean =>
  mailboxId === null || mailboxId === undefined
    ? scope.unfiled
    : scope.mailboxIds === null || scope.mailboxIds.includes(mailboxId)

/** Whether a person is let into the Inbox at all: the owner always (who connects the first Gmail account before any mailbox exists), anyone else once they are on at least one mailbox. */
export const mayEnter = (scope: MailScope, isOwner: boolean): boolean =>
  isOwner || scope.mailboxIds === null || scope.mailboxIds.length > 0

/**
 * Whether a contact is the person's to see: they are on a conversation (or hold a draft) in a mailbox the person is on. `inMailboxes` is the mailbox of each such conversation and draft (null for one in no mailbox); a contact on
 * none at all (made by hand, linked to a Client, never written to) belongs to no mailbox and is the owner's.
 */
export const contactSeen = (scope: MailScope, inMailboxes: readonly (string | null)[]): boolean =>
  inMailboxes.length === 0 ? scope.unfiled : inMailboxes.some((m) => canSee(scope, m))

/**
 * Whose a device is, by who added it: the person, or the owner for a device whose adder is no person of the install (devices made before they had people were the owner's). The store keeps the adder
 * as the address it was signed in with.
 */
export const deviceOwnerOf = (addedBy: string, team: readonly string[], owner: string): string => {
  const who = addedBy.trim().toLowerCase()
  return team.includes(who) ? who : owner
}

export const DEFAULT_FILTER: QueueFilterId = 'inbox'

/**
 * The probability at which the spam classifier's "should this be kept out of the main inbox" answer counts as spam (a number
 * measured on one business's own mail, not on every mailbox's: the inbox's ADR 0001). It is
 * here and not in a column so that moving it is a deploy and not a migration.
 */
export const CLEF_JUNK_THRESHOLD = 0.8

/** Why a conversation is Bulk. */
export type BulkReason = 'unsubscribe' | 'category' | 'automated' | 'clef' | 'moved'

/** The facts Bulk is judged from: a conversation summary's, or what the notification rule reads. */
type BulkFacts = Pick<ConversationSummary, 'newestInbound' | 'clientIds'> &
  Partial<Pick<ConversationSummary, 'spamCall'>>

/**
 * Why a conversation is Bulk, or null when it is not: the ONE rule for both kinds of mailbox, in the order it runs (the person's call
 * and the automated sender are common to both; the category label is Gmail's alone and the classifier's score a Cloudflare mailbox's).
 *
 * THE EXEMPTION comes first: a conversation with a contact assigned to a Client on it is never Bulk, whoever sent the newest
 * message and however automated it looks, so that a Client's message still reaches the Inbox. It is the people ON the
 * conversation, not the sender: the rule is "one of the participants" (the same exemption a lead gets in a junk filter), and a Client's staff cc'd on a vendor's receipt is a Client's conversation. It is decided from the ids the store holds,
 * never from the directory, so the queue does not rearrange itself when the directory goes down.
 *
 * Then a person's call (`spamCall`: the owner or Claude moved the conversation) decides, and sticks.
 *
 * Then the newest inbound message, and only that one: an old newsletter in a thread a person has since written on is not bulk.
 * A conversation nothing has come in on (a sent-only thread, a text the owner marked sent) is not. Gmail's envelope facts are
 * Promotions, Social, Updates or Forums (category labels) and a List-Unsubscribe header, then, as for a Cloudflare mailbox, an automated sender
 * (the contact rules that need no history: a machine-made name, or only no-reply mailboxes). A Cloudflare message has no labels, so
 * it is the List-Unsubscribe header, an automated sender, and last the classifier's probability, at or over CLEF_JUNK_THRESHOLD. The classifier is the one judgment, and it is asked
 * only of mail no rule above has already settled (src/cloudflare/arrivals.ts), so a conversation can carry a score and be Bulk
 * for a header too: the header is named first.
 */
export function bulkReason(c: BulkFacts): BulkReason | null {
  if (c.clientIds.length > 0) return null
  if (c.spamCall !== undefined) return c.spamCall.spam ? 'moved' : null
  const envelope = c.newestInbound
  if (!envelope) return null
  if (envelope.listUnsubscribe) return 'unsubscribe'
  if (envelope.labels.some((l) => BULK_CATEGORY_LABELS.includes(l))) return 'category'
  if (envelope.automated === true) return 'automated'
  if (typeof envelope.clefJunk === 'number' && envelope.clefJunk >= CLEF_JUNK_THRESHOLD) return 'clef'
  return null
}

/** Whether a conversation is Bulk (see `bulkReason`). */
export const isBulk = (c: BulkFacts): boolean => bulkReason(c) !== null

/** Whether it is Bulk because the classifier or a person called it spam: what a row in a Cloudflare mailbox tags "Spam". */
export function isSpam(c: BulkFacts): boolean {
  const reason = bulkReason(c)
  return reason === 'clef' || reason === 'moved'
}

const FILTERS: Filter[] = [
  { id: 'inbox', label: 'Inbox', keep: (c) => c.open && !isBulk(c) },
  { id: 'unread', label: 'Unread', keep: (c) => c.open && !isBulk(c) && c.unread },
  { id: 'drafts', label: 'Drafts', keep: (c) => c.drafts > 0 },
  { id: 'bulk', label: 'Bulk', keep: (c) => c.open && isBulk(c) },
  { id: 'closed', label: 'Closed', keep: (c) => !c.open },
]

/** An unrecognized filter shows the default rather than an empty queue. A well-formed Client filter is recognized whether or not that Client has anything open. */
export function parseFilter(value: string | null | undefined, mailboxes: readonly MailboxMark[] = []): QueueFilterId {
  const known = FILTERS.find((f) => f.id === value)?.id
  if (known) return known
  // A mailbox's view is recognized only while the store holds that mailbox: with none, the id is any unknown filter.
  const mailbox = mailboxes.find((m) => mailboxFilterId(m.id) === value)
  if (mailbox) return mailboxFilterId(mailbox.id)
  const client = value ? clientIdOfFilter(value) : null
  return client === null ? DEFAULT_FILTER : clientFilterId(client)
}

type Filter = { id: QueueFilterId; label: string; keep: (c: QueueFact) => boolean }

/** The view of one Cloudflare mailbox: its open conversations that are not Bulk. */
const mailboxFilter = (mailbox: MailboxMark): Filter => ({
  id: mailboxFilterId(mailbox.id),
  label: mailbox.name,
  keep: (c) => c.open && !isBulk(c) && c.mailbox?.id === mailbox.id,
})

/** The filter of one Client's open conversations. */
const clientFilter = (clientId: number, label: string): Filter => ({
  id: clientFilterId(clientId),
  label,
  keep: (c) => c.open && c.clientIds.includes(clientId),
})

/**
 * What the queue says before any row is fetched: the filters with their counts over
 * EVERY conversation, and the ids of the first screen of the filter asked for, in
 * the order given (newest activity first). The store then hands over those rows
 * (`listConversations(ids)`). `looseDrafts` is how many drafts sit on no conversation:
 * they are not in `facts`, and Drafts counts them (the route lists them). `mailboxes` are the Cloudflare mailboxes the store
 * holds, one view each, in the order given.
 */
export function planQueue(
  facts: QueueFact[],
  requested: string | null | undefined,
  directory: Map<number, ListedClient> = new Map(),
  looseDrafts = 0,
  mailboxes: readonly MailboxMark[] = [],
): { filter: QueueFilterId; filters: QueueFilter[]; ids: string[] } {
  const filter = parseFilter(requested, mailboxes)
  // One filter per Client with an open conversation, and the one asked for even when it has none (a
  // link to a Client's view must not land on the Inbox), in name order.
  const wanted = clientIdOfFilter(filter)
  const clientIds = new Set(facts.filter((f) => f.open).flatMap((f) => f.clientIds))
  if (wanted !== null) clientIds.add(wanted)
  const clientFilters = [...clientIds]
    .map((id) => clientFilter(id, clientLabel(id, directory).name))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  const all: Filter[] = [...FILTERS, ...mailboxes.map(mailboxFilter), ...clientFilters]
  const active = all.find((f) => f.id === filter) ?? (FILTERS[0] as Filter)
  const filters: QueueFilter[] = all.map((f) => {
    const kept = facts.filter(f.keep)
    return {
      id: f.id,
      label: f.label,
      count: kept.length + (f.id === 'drafts' ? looseDrafts : 0),
      unread: kept.filter((c) => c.unread).length,
    }
  })
  return {
    filter,
    filters,
    ids: facts
      .filter(active.keep)
      .slice(0, QUEUE_PAGE)
      .map((c) => c.id),
  }
}

/** The rows for the ids a plan named, each with the name to show, whether it is Bulk and its Clients by name. */
export function queueRows(
  conversations: ConversationSummary[],
  directory: Map<number, ListedClient> = new Map(),
): QueueRow[] {
  return conversations.map((c) => ({
    ...c,
    title: titleFor(c),
    bulk: isBulk(c),
    ...(isSpam(c) && { spam: true }),
    clients: c.clientIds.map((id) => clientLabel(id, directory)),
  }))
}

/** The contact's name, or the first of several with a count of the rest. */
function titleFor(c: ConversationSummary): string {
  const [first, ...rest] = c.contactNames
  if (!first) return '(nobody)'
  return rest.length === 0 ? first : `${first} and ${rest.length} more`
}
