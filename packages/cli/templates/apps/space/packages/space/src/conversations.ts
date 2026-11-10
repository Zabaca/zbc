// The Conversations list: the front door's merge of what the inbox and meet each answer, into one row per person and one per
// channel (the merge rule is the space's ADR 0003 and the contract's header in
// packages/workspace/src/rows.ts). Pure: no I/O, no clock, so `bun test` drives it with literal answers.
//
// What this file adds to the contract's rows, and only this: the PersonRow and ChannelRow the contract fixes are kept whole, and each
// is listed with three more facts the page needs and the contract has no field for (who wrote last, who else is on the
// person's threads, and the business mailbox a person's newest mail came to). They are the space's own, never sent to an app.

import {
  type CallRow,
  type ChannelRow,
  type ClientRef,
  type ChatSide,
  type InboxMailbox,
  type InboxPeople,
  type InboxScope,
  type InboxPerson,
  type InboxThreadLine,
  MAILBOX_ID,
  type Install,
  type MailSide,
  type MeetCallRef,
  type MeetChannel,
  type MeetDirect,
  type MeetOverview,
  type MeetPhoneSummary,
  type PartStatus,
  type Person,
  type PersonRow,
  type PhoneRow,
  normalizeAddress,
} from '@space/workspace'
import type { LooseDraft } from './drafts'
import { isCount } from './guards'

// ── The views ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which list is asked for. The main list is every open mail that is not Bulk, of every mailbox (a business mailbox's
 * customers sit beside everyone else, as in the inbox's own Inbox view), with direct messages and channels. Bulk and Closed are
 * lists of their own, and a business mailbox is a filter that narrows the list to it. Chat is in the main list only.
 *
 * `everything` is not a list a page can ask for (`parseView` never makes it): it is how a person's conversation is found, the main list's merge
 * over every conversation the inbox has with them, open, closed or Bulk, and meet's too, so a row opened from any list is there.
 */
export type View = { kind: 'main' } | { kind: 'bulk' } | { kind: 'closed' } | { kind: 'mailbox'; id: string } | { kind: 'drafts' } | { kind: 'sent' } | { kind: 'client' } | { kind: 'everything' }

export const MAIN: View = { kind: 'main' }

/**
 * Which of the space's two tabs a list or a conversation is for (Conversations is split into Inbox and Meet): `mail` is the Inbox, which asks the
 * inbox alone and so holds email conversations only; `chat` is Meet, which asks meet alone and holds channels, direct messages, calls and the Phone. Absent is the old
 * merge of both, which no tab of the page asks for (Today and People do their own merging); it stays for the reads that need a person's every side.
 */
export type Scope = 'mail' | 'chat'

/** The scope a request names (`?scope=`): `undefined` when it names none, null when it names something that is not one. */
export function parseScope(scope: string | undefined): Scope | undefined | null {
  if (scope === undefined) return undefined
  return scope === 'mail' || scope === 'chat' ? scope : null
}

/** The view a request names (`?view=` and `?mailbox=`), or null when it is none of them. Omitted is the main list. */
export function parseView(view: string | undefined, mailbox: string | undefined): View | null {
  if (view === undefined || view === 'main') return mailbox === undefined ? MAIN : null
  if (view === 'bulk' || view === 'closed') return mailbox === undefined ? { kind: view } : null
  if (view === 'drafts' || view === 'sent' || view === 'client') return mailbox === undefined ? { kind: view } : null
  if (view === 'mailbox') return mailbox !== undefined && MAILBOX_ID.test(mailbox) ? { kind: 'mailbox', id: mailbox } : null
  return null
}

/** What to ask the inbox for a view: Bulk and Closed come only when asked (the contract's `InboxScope`), Sent has a scope of its own (the conversations the owner sent in, any state) and so has Drafts (the conversations that hold a draft, any state, so one on an old thread is not cut with the older conversations), everything else is its main list. */
export const inboxScopeFor = (view: View): InboxScope | undefined =>
  view.kind === 'sent'
    ? { sent: true }
    : view.kind === 'bulk'
    ? { include: ['bulk'] }
    : view.kind === 'closed'
      ? { include: ['closed'] }
      : view.kind === 'client'
        ? { include: ['bulk'] }
        : view.kind === 'drafts'
          ? { drafts: true }
          : view.kind === 'everything'
            ? { include: ['bulk', 'closed'] }
            : undefined

/** Whether a conversation belongs in a view. The inbox's answer holds more than one view's (Bulk comes with the open ones), so the space keeps only its own. */
export function inView(view: View, line: Pick<InboxThreadLine, 'open' | 'bulk' | 'mailbox' | 'drafts'>): boolean {
  switch (view.kind) {
    case 'main':
      return line.open && !line.bulk
    case 'mailbox':
      return line.open && !line.bulk && line.mailbox?.id === view.id
    case 'bulk':
      return line.open && line.bulk
    case 'closed':
      return !line.open
    // The menu's Drafts counts a conversation with a draft whatever state it is in, and a Client's count is its OPEN conversations Bulk included (the inbox's own views): these two
    // lists hold what their counts count, and the page narrows the second to the Client's people.
    case 'drafts':
      return line.drafts > 0
    case 'client':
      return line.open
    // Sent holds what the inbox answered for it: every conversation the owner sent in, whatever state (the inbox's `sent` scope), so every line is in it.
    case 'sent':
    case 'everything':
      return true
  }
}

// ── What the page is given ────────────────────────────────────────────────────────────────────────────────────────────────

/** Who wrote the newest item: the signed-in person, someone else, or (in a channel) a named person; `nobody` for a channel nothing has been said in yet (it has no newest item). */
export type LastBy = 'you' | 'them' | 'nobody' | { name: string }

/** A person's row as the page draws it: the contract's row, and the four facts it has no field for. */
export interface ListedPerson extends PersonRow {
  lastBy: LastBy
  /** The other people on the email threads listed under this person, by name; empty when none is shared. */
  sharedWith: string[]
  /** The business mailbox the newest item came to (one of the install's shared mailboxes), or null for the owner's own mail or a chat. */
  mailbox: string | null
  /**
   * EVERY Client the person's contacts are linked to, in the order the contacts come (a person known by two addresses may belong to two Clients): a pill each. `client`, the contract's, is the first.
   */
  clients: ClientRef[]
  /** The Client the inbox only suggests, for a person with none linked: the dashed pill. Display only; confirming it is the inbox's Link. */
  suggestedClient: ClientRef | null
  /** How many drafts wait on this person's conversations in this view (Claude's, the assistant's, the owner's own): what the Drafts view of the menu keeps a row for. */
  drafts: number
  /** The row is a Telegram group (one row under its own name; the words are the newest message, named by who wrote it) or a channel, null for everyone else. */
  telegramChat: 'group' | 'channel' | null
}

export interface ListedChannel extends ChannelRow {
  lastBy: LastBy
}

/** A call with no conversation (a New call), as a row of its own: `CallRow` and who made it (always the person asking). */
export interface ListedCall extends CallRow {
  lastBy: LastBy
}

/** The Phone conversation, as a row: `PhoneRow` and who last said something (the phone, so "them"). */
export interface ListedPhone extends PhoneRow {
  lastBy: LastBy
}

/** The rows that open a conversation of the inbox's and meet's: a person's or a channel's. A call or the Phone opens its own screen (client/CallPane.tsx, client/PhonePane.tsx). */
export type ListedConversation = ListedPerson | ListedChannel

export type ListedRow = ListedConversation | ListedCall | ListedPhone

export const isConversationRow = (r: ListedRow): r is ListedConversation => r.type === 'person' || r.type === 'channel'

/** A business mailbox as a filter: the inbox's own name for it and how many of its conversations are unread. */
export interface MailboxFilter extends InboxMailbox {
  unread: number
}

/** The Conversations list as the front door answers its page: the contract's `ConversationList`, with the rows listed and the filters. */
export interface ConversationsAnswer {
  view: View
  rows: ListedRow[]
  parts: PartStatus[]
  /** The business mailboxes seen, for the filters that are one each. Empty when the inbox did not answer. */
  mailboxes: MailboxFilter[]
  /** The inbox had more conversations than one screen of them, so its part of the list is the newest (the inbox's `more`). */
  more: boolean
  /**
   * In the Drafts view, the drafts that sit on no conversation (a first email to a new address, a first LinkedIn message to a new contact), newest first: they are in no row, because a row is
   * a person with something said. Empty in every other view. Each opens at `/inbox/draft/<id>`.
   */
  looseDrafts: LooseDraft[]
}

// ── The merge ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the merge is given. Either part may be absent: it did not answer, and its rows are not in the list. */
export interface MergeInput {
  install: Install
  /** The addresses of the person asking (their work address and sign-in), so they are not named as "also on" their own threads. */
  self: readonly string[]
  view: View
  inbox: InboxPeople | null
  meet: MeetOverview | null
}

interface Kept {
  person: InboxPerson
  lines: InboxThreadLine[]
}

/** One row in the making: everything that joined on an address, before it is a row. */
interface Group {
  team: Person | null
  addresses: Set<string>
  /** Meet's person and direct message, when meet has a direct message with them that has something in it. */
  direct: MeetDirect | null
  contacts: Kept[]
}

/** A row in the making with nothing joined to it yet. */
const newGroup = (team: Person | null): Group => ({ team, addresses: new Set(), direct: null, contacts: [] })

/** The most names a row lists as also on its threads: a row says who else is on them, it is not a roster. */
export const SHARED_WITH_MAX = 6

/** The Clients a person's contacts are linked to, each once, in order. */
const clientsOf = (linked: readonly (ClientRef | null)[]): ClientRef[] => linked.flatMap((c, i) => (c !== null && linked.findIndex((o) => o?.id === c.id) === i ? [c] : []))

const newestOf = <T extends { at: number }>(items: readonly T[]): T | undefined => items.reduce<T | undefined>((a, b) => (a === undefined || b.at > a.at ? b : a), undefined)

/** The team person an address names, as their work address or as the address their sign-in code goes to. */
export const teamPersonFor = (install: Install, address: string): Person | null => install.person(address) ?? install.personBySignIn(address)

/**
 * Whether the inbox says a line is listed under its person in this view: the whole inbox places a thread under the one outsider who last wrote on it,
 * and a Client's list places it among that Client's people only, so it never loses a thread one of them is on. A person's own page (`everything`) holds every thread.
 */
const isListed = (view: View, line: Pick<InboxThreadLine, 'listed' | 'listedInClient'>): boolean =>
  view.kind === 'everything' ? true : view.kind === 'client' ? line.listedInClient : line.listed

export function mergeConversations(input: MergeInput): Omit<ConversationsAnswer, 'parts' | 'view' | 'looseDrafts'> {
  const { install, view } = input
  const groups: Group[] = []
  const byAddress = new Map<string, Group>()
  const byTeam = new Map<string, Group>()

  const join = (group: Group, addresses: Iterable<string>) => {
    for (const a of addresses) {
      group.addresses.add(a)
      // An address already held by another group stays with it: two people sharing one are not merged here.
      if (!byAddress.has(a)) byAddress.set(a, group)
    }
  }
  const teamGroup = (person: Person): Group => {
    const held = byTeam.get(person.address)
    if (held) return held
    const group = newGroup(person)
    groups.push(group)
    byTeam.set(person.address, group)
    // BOTH of a teammate's addresses: meet knows them by the sign-in address and the inbox may know them by either.
    join(group, [person.address, person.signIn])
    return group
  }

  // Meet first: a teammate or a guest with a direct message that has something in it is an anchor the inbox's contacts join to.
  const wantsChat = view.kind === 'main' || view.kind === 'everything'
  if (wantsChat && input.meet) {
    for (const direct of input.meet.direct) {
      if (direct.newest === null) continue
      const address = normalizeAddress(direct.person.address)
      const team = address === null ? null : teamPersonFor(install, address)
      const group: Group = team ? teamGroup(team) : newGroup(null)
      if (!team) groups.push(group)
      group.direct = direct
      if (address !== null) join(group, [address])
    }
  }

  // The inbox's contacts, newest first so the outcome does not depend on the order the inbox listed them in.
  const kept: Kept[] = []
  for (const person of input.inbox?.people ?? []) {
    // A thread with several people on it is listed once: the inbox says on each line which person it is under (`isListed`).
    const lines = person.conversations.filter((l) => inView(view, l) && isListed(view, l))
    if (lines.length > 0) kept.push({ person, lines })
  }
  kept.sort((a, b) => (newestOf(b.lines)?.at ?? 0) - (newestOf(a.lines)?.at ?? 0) || a.person.contactId.localeCompare(b.person.contactId))
  for (const contact of kept) {
    const addresses = contact.person.addresses.flatMap((a) => normalizeAddress(a) ?? [])
    // Joined on ANY of its addresses; two anchors reached by different addresses are not merged, the contact goes to the first.
    let group = addresses.map((a) => byAddress.get(a)).find((g) => g !== undefined)
    if (!group) {
      const team = addresses.map((a) => teamPersonFor(install, a)).find((p) => p !== null) ?? null
      group = team ? teamGroup(team) : (groups[groups.push(newGroup(null)) - 1] as Group)
    }
    group.contacts.push(contact)
    join(group, addresses)
  }

  const used = new Set<string>()
  const rows: ListedRow[] = groups.flatMap((g) => {
    const row = personRow(g, input.self, used)
    return row ? [row] : []
  })

  if (wantsChat && input.meet) {
    for (const channel of input.meet.channels) {
      const row = channelRow(channel)
      if (row) rows.push(row)
    }
    // A New call has a row of its own, so every call has a home; the Phone conversation is one row for everyone on the line.
    for (const call of input.meet.calls ?? []) rows.push(callRow(call))
    if (input.meet.phone) rows.push(phoneRow(input.meet.phone))
  }

  rows.sort((a, b) => b.at - a.at || a.type.localeCompare(b.type) || rowName(a).localeCompare(rowName(b)) || a.key.localeCompare(b.key))
  return { rows, mailboxes: mailboxesOf(input.inbox), more: input.inbox?.more ?? false }
}

const rowName = (r: ListedRow) => r.name

function personRow(g: Group, self: readonly string[], used: Set<string>): ListedPerson | null {
  const mail: MailSide[] = []
  const candidates: { at: number; kind: PersonRow['came']; text: string; lastBy: LastBy; mailbox: string | null; telegramChat: 'group' | 'channel' | null }[] = []
  const unreadConversations = new Set<string>()
  const sharedWith = new Map<string, string>()
  const own = new Set(g.contacts.map((c) => c.person.contactId))

  for (const { person, lines } of g.contacts) {
    const newest = newestOf(lines) as InboxThreadLine
    mail.push({
      contactId: person.contactId,
      unread: lines.filter((l) => l.unread).length,
      newest: { at: newest.at, kind: newest.kind, text: newest.snippet, subject: newest.subject },
    })
    candidates.push({ at: newest.at, kind: newest.kind, text: newest.snippet, lastBy: newest.direction === 'out' ? 'you' : 'them', mailbox: newest.mailbox?.name ?? null, telegramChat: newest.telegramChat ?? null })
    for (const l of lines) {
      if (l.unread) unreadConversations.add(l.conversationId)
      // A thread several people are on is listed under one of them; its row says who else is on it.
      for (const other of l.alsoOn) {
        const address = normalizeAddress(other.address)
        if (own.has(other.contactId) || (address !== null && (self.includes(address) || g.addresses.has(address)))) continue
        sharedWith.set(other.contactId, other.name)
      }
    }
  }

  let chat: ChatSide | null = null
  if (g.direct?.newest) {
    const { newest } = g.direct
    chat = { personId: g.direct.person.id, conversationId: g.direct.conversationId, unread: g.direct.unread, newest: { at: newest.at, kind: 'chat', text: newest.text } }
    candidates.push({ at: newest.at, kind: 'chat', text: newest.text, lastBy: newest.mine ? 'you' : 'them', mailbox: null, telegramChat: null })
  }

  // A row exists only if it has an item (the contract): a person with an address and nothing said is in People, not here.
  const latest = newestOf(candidates)
  if (!latest) return null

  const addresses = [...g.addresses].sort()
  const bestContact = g.contacts[0]?.person
  const clientSide = g.contacts.map((c) => c.person).find((p) => p.client !== null)
  const base = addresses[0] ?? (bestContact ? `mail:${bestContact.contactId}` : `chat:${g.direct?.person.id}`)
  // The contract names the key by the first address. Two contacts that share one are not merged, so the second is told apart.
  const key = used.has(base) ? `${base}|${bestContact ? `mail:${bestContact.contactId}` : `chat:${g.direct?.person.id}`}` : base
  used.add(key)

  return {
    type: 'person',
    key,
    name: g.team?.name ?? bestContact?.name ?? g.direct?.person.name ?? key,
    addresses,
    side: g.team || g.direct?.person.kind === 'teammate' ? 'team' : 'outside',
    client: clientSide?.client ?? null,
    clients: clientsOf(g.contacts.map((c) => c.person.client)),
    suggestedClient: clientSide ? null : (g.contacts.map((c) => c.person.suggestedClient ?? null).find((c) => c !== null) ?? null),
    at: latest.at,
    came: latest.kind,
    text: latest.text,
    // The sum of the conversations that are unread (each counted once, even where one person's two contacts are both on it) and the
    // messages meet has not shown. The units are mixed and the page says so where the badge is drawn.
    unread: unreadConversations.size + (chat?.unread ?? 0),
    mail,
    chat,
    lastBy: latest.lastBy,
    sharedWith: [...sharedWith.values()].sort((a, b) => a.localeCompare(b)).slice(0, SHARED_WITH_MAX),
    mailbox: latest.mailbox,
    drafts: g.contacts.reduce((n, c) => n + c.lines.reduce((m, l) => m + l.drafts, 0), 0),
    telegramChat: latest.telegramChat,
  }
}

function callRow(call: MeetCallRef): ListedCall {
  return { type: 'call', key: `call:${call.name}`, call: call.name, link: call.link, name: call.title ?? 'New call', at: call.madeAt, came: 'call', text: 'A call you made. Open it for its link.', unread: 0, lastBy: 'you' }
}

function phoneRow(phone: MeetPhoneSummary): ListedPhone {
  return {
    type: 'phone',
    key: 'phone',
    conversationId: phone.conversationId,
    name: 'Phone',
    at: phone.newest?.at ?? 0,
    came: 'call',
    text: phone.newest?.text ?? 'Voicemails and missed calls',
    unread: phone.unread,
    lastBy: 'them',
  }
}

function channelRow(channel: MeetChannel): ListedChannel | null {
  const { newest } = channel
  // A channel nobody has written in has a row from the moment it is made, at the time it was made, so a channel made here is there to be opened and written in.
  // (A meet that predates the channel admin says no time and so has none until it has a message, as before. The fallback is for the gap between deploying the space and meet, and
  // is removed by the commit that follows the channel-admin deploy checks (packages/meet/README.md): it makes `MeetChannel.createdAt` required in the contract and deletes the `isCount` test here.)
  if (newest === null && !isCount(channel.createdAt)) return null
  return {
    type: 'channel',
    key: `chat:channel:${channel.conversationId}`,
    conversationId: channel.conversationId,
    name: channel.name,
    privacy: channel.privacy,
    memberCount: channel.memberCount,
    at: newest ? newest.at : (channel.createdAt as number),
    came: 'chat',
    text: newest ? newest.text : 'No messages yet.',
    unread: channel.unread,
    lastBy: newest ? (newest.mine ? 'you' : { name: newest.authorName }) : 'nobody',
  }
}

/** The business mailboxes the inbox's answer showed, from every open conversation in them whichever view was asked for. */
function mailboxesOf(inbox: InboxPeople | null): MailboxFilter[] {
  const seen = new Map<string, MailboxFilter>()
  const counted = new Set<string>()
  for (const person of inbox?.people ?? []) {
    for (const l of person.conversations) {
      if (l.mailbox === null || !l.open || l.bulk) continue
      const held = seen.get(l.mailbox.id) ?? { ...l.mailbox, unread: 0 }
      // A conversation is on every contact that is in it: count it once.
      if (l.unread && !counted.has(l.conversationId)) {
        counted.add(l.conversationId)
        held.unread += 1
      }
      seen.set(l.mailbox.id, held)
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
