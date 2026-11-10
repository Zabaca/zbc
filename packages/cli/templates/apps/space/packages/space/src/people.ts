// People: the directory of the people the space knows, and one person's page. The tab's list is a merge of three reads, as
// the Inbox's and Meet's lists are of two: the inbox's contacts, meet's people and the company layer's team, one entry per person joined by lowercase email address (the same
// rule, ADR 0003), and one person's page adds their profile (the inbox's contact, with its note) and the documents they are on (forms).
//
// Nothing is stored here. Reads wait `ANSWER_WITHIN_MS` and each part may fail alone: with the inbox down the team and meet's guests still list, with a line saying
// mail could not be reached; with forms down a profile still opens and its documents say they could not be reached. Writes (the three fields, a merge, its undo,
// linking a Client) are `/api/inbox/<name>` (views.ts), because each is one call to the inbox.
//
// WHAT NEVER APPEARS HERE: a message, a subject or a draft (the profile is who someone is, not what was said); an automated sender in the main lists (the inbox
// counts them and the directory lists them only when asked, under "Automated", so a real person it misjudged is still found; a person's page finds them either way); on a document, anything but its title, state and the counts of signers (never the names of those who have not signed, an address, a link or an
// answer: the page is given a shape with no field for them); and a note belongs to its person alone.

import {
  ANSWER_WITHIN_MS,
  type ClientRef,
  type InboxContact,
  type InboxContactProfile,
  type MeetDirect,
  type PartStatus,
  type Person,
  type Reached,
  normalizeAddress,
} from '@space/workspace'
import { teamPersonFor } from './conversations'
import { DOCUMENTS_SHOWN, type DocumentsPart, documentsPartOf } from './documents'
import { type Asking, statusOf } from './list'
import { isDocuments, isInboxContactProfile, isInboxContacts, isMeetOverview, notConnected, reach } from './reach'

// ── What the page is given ────────────────────────────────────────────────────────────────────────────────────────────────

/** The directory's three groups, in the order they are drawn: a Client's people, other outside people (a channel guest too), and the team. */
export type PeopleSide = 'client' | 'outside' | 'team'

/** The company layer's person, for a teammate: the sign-in address is where Access sends their code. `role` is null for a teammate only meet knows. */
export interface TeamFacts {
  address: string
  signIn: string
  role: 'owner' | 'member' | null
  /** The shared addresses (the company's mailboxes) the person works. */
  sharedAddresses: string[]
}

export interface PeopleEntry {
  /** What names the person in the page's address (`/people/<key>`): the first of their addresses, else `mail:<contactId>`, else `chat:<personId>`; a clash is told apart by a suffix after "|". */
  key: string
  /** The key of their conversation (conversations.ts, `ListedPerson.key`), or null while nothing has been said with them: there is then none to open. The Inbox and Meet each open it by this key. */
  conversationKey: string | null
  /** Where something has been said with them: an email conversation (opened in the Inbox), a direct message (opened in Meet), or both. Both false exactly when `conversationKey` is null. */
  said: { mail: boolean; chat: boolean }
  name: string
  side: PeopleSide
  /** A channel guest of meet's: reached by direct message, and grouped under Outside. */
  guest: boolean
  /** The inbox judges every contact of this entry an automated sender (a newsletter, a receipt, a no-reply address). Listed only when asked for, under Automated. */
  automated: boolean
  /** Every email address the entry joined on, normalised, sorted. For a teammate, both their address and their sign-in. */
  addresses: string[]
  /** The inbox contacts that are this person. One for anyone but a teammate known under two addresses; none for a teammate or guest the inbox has never heard from. */
  contactIds: string[]
  /** The contact whose business, role and note are edited here, and the revision it was shown at: null for a teammate (the company layer's person) and for someone with no contact. */
  contact: { id: string; rev: number } | null
  business: string
  role: string
  /** Where a new email to them goes out from when none is chosen (the inbox's contact `sendsFrom`); null for a teammate, a guest with no email and an inbox that does not say. */
  sendsFrom: { name: string; address: string } | null
  client: ClientRef | null
  suggestedClient: ClientRef | null
  team: TeamFacts | null
}

export interface PeopleAnswer {
  entries: PeopleEntry[]
  /** How the inbox and meet fared; a part that did not answer is said, and the other's people are listed. */
  parts: PartStatus[]
  /** Automated senders the inbox left out (newsletters, receipts, no-reply addresses). */
  automated: number
}

export interface PersonAnswer {
  entry: PeopleEntry
  /** The inbox's contact with its note, when the entry has one to edit; null otherwise (and `profileState` says why when it should have). */
  profile: InboxContactProfile | null
  profileState: 'ok' | 'none' | 'not-open-to-you' | 'could-not-be-reached'
  parts: PartStatus[]
  documents: DocumentsPart
}

export type Found<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 503; message: string }

// ── The merge ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Group {
  team: Person | null
  addresses: Set<string>
  direct: MeetDirect | null
  contacts: InboxContact[]
}

const newGroup = (team: Person | null): Group => ({ team, addresses: new Set(), direct: null, contacts: [] })

/** Whether the person has said anything: the inbox has a conversation with one of their contacts, or meet a direct message with something in it. */
const hasMail = (g: Group): boolean => g.contacts.some((c) => c.conversations > 0)
const hasChat = (g: Group): boolean => g.direct?.newest != null
const hasConversation = (g: Group): boolean => hasMail(g) || hasChat(g)

export function mergePeople(input: { install: Asking['install']; inbox: readonly InboxContact[]; meet: readonly MeetDirect[] }): PeopleEntry[] {
  const { install } = input
  const groups: Group[] = []
  const byAddress = new Map<string, Group>()
  const byTeam = new Map<string, Group>()
  const join = (group: Group, addresses: Iterable<string>) => {
    for (const a of addresses) {
      group.addresses.add(a)
      // An address already held by another group stays with it: two people sharing one are not merged.
      if (!byAddress.has(a)) byAddress.set(a, group)
    }
  }
  const teamGroup = (person: Person): Group => {
    const held = byTeam.get(person.address)
    if (held) return held
    const group = newGroup(person)
    groups.push(group)
    byTeam.set(person.address, group)
    join(group, [person.address, person.signIn])
    return group
  }

  // The team first: every person of the install is listed, whether or not anyone has said anything.
  for (const person of install.people) teamGroup(person)

  // Meet's people next: a teammate (known by the sign-in address) joins the team person, a guest is an entry of their own.
  for (const direct of input.meet) {
    const address = normalizeAddress(direct.person.address)
    const team = address === null ? null : teamPersonFor(install, address)
    const group = team ? teamGroup(team) : (groups[groups.push(newGroup(null)) - 1] as Group)
    group.direct = direct
    if (address !== null) join(group, [address])
  }

  // The inbox's contacts, in the order of their names so the outcome does not depend on the order the inbox listed them in.
  const ordered = [...input.inbox].sort((a, b) => a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId))
  for (const contact of ordered) {
    const addresses = contact.addresses.flatMap((a) => normalizeAddress(a) ?? [])
    let group = addresses.map((a) => byAddress.get(a)).find((g) => g !== undefined)
    if (!group) {
      const team = addresses.map((a) => teamPersonFor(install, a)).find((p) => p !== null) ?? null
      group = team ? teamGroup(team) : (groups[groups.push(newGroup(null)) - 1] as Group)
    }
    group.contacts.push(contact)
    join(group, addresses)
  }

  const used = new Set<string>()
  return groups.flatMap((g) => {
    const entry = entryOf(g, used)
    return entry ? [entry] : []
  })
}

function entryOf(g: Group, used: Set<string>): PeopleEntry | null {
  const first = g.contacts[0]
  const addresses = [...g.addresses].sort()
  const idKey = first ? `mail:${first.contactId}` : g.direct ? `chat:${g.direct.person.id}` : null
  const base = addresses[0] ?? idKey
  // A group with no team person, no contact and no meet person cannot happen; there would be no one to name.
  if (base === null) return null
  const key = used.has(base) ? `${base}|${idKey ?? addresses.length}` : base
  used.add(key)

  // The key of their conversation is the one the Inbox's and Meet's lists give the row (conversations.ts `personRow`): the first of the addresses of what has something in it, a
  // teammate's both addresses always, else the contact's `mail:` key, else meet's `chat:` key. Null while nothing has been said.
  let conversationKey: string | null = null
  if (hasConversation(g)) {
    const spoken = new Set<string>(g.team ? [g.team.address, g.team.signIn] : [])
    for (const c of g.contacts) if (c.conversations > 0) for (const a of c.addresses) spoken.add(normalizeAddress(a) ?? a)
    const direct = g.direct?.newest != null ? normalizeAddress(g.direct.person.address) : null
    if (direct !== null) spoken.add(direct)
    const speaker = g.contacts.find((c) => c.conversations > 0)
    conversationKey = [...spoken].sort()[0] ?? (speaker ? `mail:${speaker.contactId}` : g.direct ? `chat:${g.direct.person.id}` : null)
  }

  const isTeam = g.team !== null || g.direct?.person.kind === 'teammate'
  const linked = g.contacts.find((c) => c.client !== null)
  const editable = isTeam ? undefined : first
  return {
    key,
    conversationKey,
    said: { mail: hasMail(g), chat: hasChat(g) },
    name: g.team?.name ?? first?.name ?? g.direct?.person.name ?? key,
    side: isTeam ? 'team' : linked ? 'client' : 'outside',
    guest: !isTeam && g.direct?.person.kind === 'guest',
    automated: !isTeam && g.contacts.length > 0 && g.contacts.every((c) => c.automated),
    addresses,
    contactIds: g.contacts.map((c) => c.contactId),
    contact: editable ? { id: editable.contactId, rev: editable.rev } : null,
    business: isTeam ? '' : (editable?.business ?? ''),
    role: isTeam ? '' : (editable?.role ?? ''),
    sendsFrom: isTeam ? null : (editable?.sendsFrom ?? null),
    client: linked?.client ?? null,
    suggestedClient: linked ? null : (g.contacts.find((c) => c.suggestedClient !== null)?.suggestedClient ?? null),
    team: g.team ? { address: g.team.address, signIn: g.team.signIn, role: g.team.role, sharedAddresses: [...g.team.sharedAddresses] } : null,
  }
}

/** The order the page draws a group in: by name, then by key so equal names do not swap places between two reads. */
export const byName = (a: PeopleEntry, b: PeopleEntry): number => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)

// ── The directory ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function read(ask: Asking, automated: boolean) {
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, meet } = ask.apps
  // In parallel: the slowest part is the wait, not the sum.
  const [mail, chat] = await Promise.all([
    inbox ? reach('Email', () => inbox.contacts(ask.signedIn, automated ? { automated: true } : undefined), isInboxContacts, ms) : notConnected('Email'),
    meet ? reach('Chat', () => meet.conversations(ask.signedIn), isMeetOverview, ms) : notConnected('Chat'),
  ])
  const entries = mergePeople({ install: ask.install, inbox: mail.ok ? mail.value.contacts : [], meet: chat.ok ? chat.value.direct : [] }).sort(byName)
  const parts: PartStatus[] = [statusOf('mail', mail), statusOf('chat', chat)]
  return { entries, parts, automated: mail.ok ? mail.value.automated : 0 }
}

/** The directory. The automated senders are counted and not listed unless `automated` is asked for, when they are listed under their own heading. */
export async function people(ask: Asking, options: { automated?: boolean } = {}): Promise<PeopleAnswer> {
  return read(ask, options.automated === true)
}

// ── One person ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How long a key may be: an address, or one of the synthetic keys, is far shorter. */
export const PERSON_KEY_MAX = 320

/** The entry a key names: its own key, its conversation's key (the key beside a conversation), or any address it holds or contact it is. */
export function findEntry(entries: readonly PeopleEntry[], key: string): PeopleEntry | undefined {
  const exact = entries.find((e) => e.key === key || e.conversationKey === key)
  if (exact) return exact
  const base = key.split('|')[0] as string
  if (base.startsWith('mail:')) return entries.find((e) => e.contactIds.includes(base.slice(5)))
  if (base.startsWith('chat:')) return undefined
  const address = normalizeAddress(base)
  return address === null ? undefined : entries.find((e) => e.addresses.includes(address))
}

export async function person(ask: Asking, key: string): Promise<Found<PersonAnswer>> {
  if (key === '' || key.length > PERSON_KEY_MAX) return { ok: false, status: 400, message: 'That is not a person the space knows how to open.' }
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, forms } = ask.apps
  // A person's page finds anyone the inbox has a contact for, an automated sender too: a real person the inbox misjudged keeps their fields and their page.
  const found = await read(ask, true)
  const entry = findEntry(found.entries, key)
  if (!entry) {
    const down = found.parts.find((p) => p.state === 'could-not-be-reached')
    if (down) return { ok: false, status: 503, message: `${down.part === 'mail' ? 'Email' : 'Chat'} could not be reached just now, so this person could not be opened. It will be tried again.` }
    return { ok: false, status: 404, message: 'There is no such person.' }
  }

  const contactId = entry.contact?.id
  const [profile, documents] = await Promise.all([
    contactId === undefined ? null : inbox ? reach('Email', () => inbox.contact(ask.signedIn, contactId), isInboxContactProfile, ms) : notConnected('Email'),
    entry.addresses.length === 0 ? null : forms ? reach('Forms', () => forms.documentsOn(ask.signedIn, entry.addresses, { limit: DOCUMENTS_SHOWN }), isDocuments, ms) : notConnected('Forms'),
  ])

  const documentsPart: DocumentsPart = documents ? documentsPartOf(documents, 'their documents are not listed.') : { state: 'ok', documents: [], more: false }

  return {
    ok: true,
    value: {
      entry,
      profile: profile?.ok ? profile.value : null,
      profileState: profile === null ? 'none' : profile.ok ? 'ok' : profile.kind === 'refused' ? 'not-open-to-you' : 'could-not-be-reached',
      parts: found.parts,
      documents: documentsPart,
    },
  }
}
