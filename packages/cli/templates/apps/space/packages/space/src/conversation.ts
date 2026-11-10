// A person's conversation: what the Worker answers the page when a row is opened, what it asks the inbox and meet to make that answer,
// and the three things a person does in it: reply by email, reply by direct message, and read it (which marks it read in both apps).
//
// Nothing is stored. The history is the inbox's emails and meet's direct messages merged by time (history.ts); the person's reply goes
// by the app that sends it, with every rule that app has (workspace ADR 0001: the assertion is passed along and each app verifies it
// again). Reads wait `ANSWER_WITHIN_MS` and a part that does not answer is said, not hidden. WRITES wait `WRITE_WITHIN_MS` and are
// NEVER retried: a write the space loses track of is `outcome-unknown`, and the page offers no second try (packages/workspace/src/asking.ts).

import {
  ANSWER_WITHIN_MS,
  CALENDAR_BY_UID_MOST,
  COMPOSE_KEY,
  type ConversationRef,
  INBOX_MOST_MARKS,
  type InboxAddress,
  type InboxCloseMark,
  type InboxDraft,
  type InboxMessage,
  type InboxParty,
  type InboxPeople,
  type InboxReadMark,
  type InboxSend,
  type MailKind,
  type MeetCall,
  type MeetMessage,
  type MeetOverview,
  type PartStatus,
  type Reached,
  type ReachedWrite,
  type RefusalReason,
  type Repeated,
  WRITE_WITHIN_MS,
  isConversationRef,
  NEW_EMAIL_CAPABILITY,
  normalizeAddress,
  readInboxFrom,
} from '@space/workspace'
import { type ListedConversation, type Scope, isConversationRow, teamPersonFor, mergeConversations } from './conversations'
import { DOCUMENTS_SHOWN, type DocumentsPart, documentsPartOf } from './documents'
import { isCount, isRecord } from './guards'
import { isCalendarEventsOrNull } from './calendar'
import { type ChatMessage, type HistorySource, type MailCalendar, type MailMessage, mergeHistory } from './history'
import { type Asking, statusOf } from './list'
import { draftViewOf } from './drafts'
import { inboxCan } from './views'
import {
  isInboxCloseResult,
  isInboxDrafts,
  isInboxHistory,
  isInboxPeople,
  isInboxReadResult,
  isDocuments,
  isInboxReopenResult,
  isInboxSent,
  isMeetCalls,
  isMeetHistory,
  isMeetOverview,
  isMeetPosted,
  isMeetRead,
  notConnected,
  reach,
  reachWrite,
} from './reach'

// ── What the page is given ────────────────────────────────────────────────────────────────────────────────────────────────

/** One email conversation of the person, for the reply's thread choice and the labels over the emails. */
export interface ThreadView {
  conversationId: string
  subject: string
  kind: MailKind
  /** The inbox's position in the thread as of this answer: sent back with a reply and with a read mark, so nothing is answered or read unseen. */
  through: number
  unread: boolean
  open: boolean
  bulk: boolean
  /** The business mailbox it is in (one of the install's shared mailboxes), or null for the owner's own Gmail. */
  mailbox: string | null
  /** Whether a reply can be sent in it (false for a text or a note). */
  canReply: boolean
  /** Whether a reply in it may carry files: true only in a business mailbox's thread (the owner's Gmail sends none). False from an inbox that predates it. */
  canAttach?: boolean
  /** Whether a reply in it takes ONE picture (a Telegram chat with a person or a group that has a reply box; sent as a Telegram photo, the words as its caption). Absent from an inbox that predates it: no picture control. */
  canPicture?: boolean
  /** Whether the inbox's own page would draw the spam button over it (the inbox decides; absent from an inbox that predates it, so none). */
  canMarkSpam: boolean
  /** A Telegram group (each message names who wrote it) or channel (no reply box). Absent for everything else, a one-to-one Telegram chat included. */
  telegramChat?: 'group' | 'channel'
  /** The time of its newest message in this answer's history, or null when none of its messages is in the newest page (it is older than all of them). */
  at: number | null
  /** The other people on it, so a thread shared with others says "with ..." and a reply goes to all. */
  alsoOn: { name: string; address: string | null }[]
}

export type DraftAuthor = InboxDraft['author']

/** A draft waiting on this person's conversations, as the inbox holds it. */
export interface DraftView {
  id: string
  conversationId: string | null
  subject: string
  text: string
  /** The revision a send must name; the inbox refuses a send of an older one. */
  rev: number
  author: DraftAuthor
  /** A send Gmail never confirmed: it waits for a person to check Sent, and is sent again by nobody. */
  stuck: boolean
  at: number
  /** Why it was drafted, as the inbox's card shows it; '' from an inbox that does not say. */
  why: string
  /** Who changed its words when that is not its author, or null (and from an inbox that does not say). */
  editedBy: DraftAuthor | null
  /** Whether it can copy everyone on the message it answers: an email draft on a conversation. False from an inbox that does not say. */
  canCopyEveryone: boolean
  /** How it goes: `email`, or `sms` or `manual` (a text, a LinkedIn or other direct message, which the inbox cannot send: the page offers Mark sent). Null from an inbox that does not say: nothing new is offered. */
  kind: InboxDraft['kind'] | null
  /** The business mailbox a stuck send went out of, or null (the owner's Gmail, and an inbox that does not say). */
  sentFrom: string | null
  /** The account it goes out from (a reply's conversation's, a new email's recorded one, else the default Gmail), so the card says "from sales" before Send; null from an inbox that does not say. */
  sendsFrom: { name: string; address: string } | null
  to: string
  toName: string
  /**
   * Everyone it is copied to besides `to`, or null when the inbox's answer did not say (an inbox that predates the field). The card shows `to` and every
   * entry, because the held-draft send goes to all of them; a draft whose Cc is not known is not sendable from the space (`sendable`).
   */
  cc: InboxAddress[] | null
  /** The thread's position for a send (`ThreadView.through`); null for a draft on no thread. */
  through: number | null
  /** On a Telegram draft that went back to being a draft because Telegram would not take it: why, in words. Null otherwise and from an inbox that does not say. */
  refusal: string | null
  /** The picture a Telegram draft carries (type and length); ABSENT for a draft with none: the card shows it (the owner reads its bytes through the attachment route for this draft's id) and can put another on or take it out. Absent from an inbox that does not say. */
  picture?: { type: string; size: number } | null
  /** A Telegram send still going out: the card says so and offers nothing (not `stuck`, not sendable). False otherwise and from an inbox that does not say. */
  sending: boolean
  /** False when the send cannot be made from here: stuck, on a thread this answer does not hold, or with a Cc the inbox did not name. The page then points at the inbox. */
  sendable: boolean
}

/** The profile beside the conversation. The People fields (business, role, notes) are People's: the page reads them by the row's key (`/api/person`, people.ts) and edits them there. */
export type Profile =
  | { kind: 'outside'; name: string; client: { id: number; name: string; listed: boolean } | null; addresses: string[]; chat: boolean; telegramChat?: 'group' | 'channel' }
  | { kind: 'team'; name: string; address: string | null; signIn: string | null; role: 'owner' | 'member' | null; chat: boolean }
  | { kind: 'channel'; name: string; privacy: 'open' | 'private'; memberCount: number }

/** What marking this conversation read in both apps names: each unread email thread at the position read to, and the chat up to its newest message. */
export interface ReadMarks {
  mail: InboxReadMark[]
  chat: { conversationId: number; upTo: number } | null
}

/**
 * What Close and Reopen name, from what is on screen. CLOSE takes the person's open email threads whose messages are drawn (a thread behind "Earlier
 * messages", or one the newest page does not reach, has not been seen and is left open; `notShown` counts them, so the page can say so), each at the
 * `through` of this answer, which the inbox checks as its own Close does. REOPEN takes the closed ones that are drawn. A row that is only chat names none.
 */
export interface ChangeMarks {
  close: InboxCloseMark[]
  notShown: number
  reopen: string[]
}

export interface ConversationAnswer {
  /** The row's key, as the address of the page names it. */
  key: string
  /** The row as the list has it: its name, side, business and what is unread. */
  row: ListedConversation
  /** How the two sources fared; a part that did not answer is said while the other's history shows. */
  parts: PartStatus[]
  sources: HistorySource[]
  threads: ThreadView[]
  drafts: DraftView[]
  profile: Profile
  read: ReadMarks
  change: ChangeMarks
  /**
   * The calls that belong to this conversation, for the cards drawn in it: the huddles started in its direct message or channel, and the call links and
   * meetings made from it (by its row's key or any of its addresses), each with its link and who is in it now. Newest first. Read again by the page while a call is on.
   */
  calls: MeetCall[]
  /** Someone meet knows who has no message with the person asking yet and so no history to draw: the way to start a direct message with them (`post` by `personId`). Null when the row has a direct message or meet knows no such person. */
  chatPerson: { personId: string; name: string } | null
  /**
   * Where "New" begins in the chat: the id of the first message from someone else that was unread when this answer was made, or null when none was. The page keeps the FIRST answer's
   * value for as long as the conversation stays open, since opening it marks it read and the next answer says nothing is unread; a message that arrives while it is open is not "new" to
   * the person reading. Absent from nothing but a test's literal; the Worker always sets it.
   */
  newFrom?: number | null
  /**
   * The documents sent from this conversation, as forms lists them: title, state, counts. A part of its own, so forms not answering leaves the history
   * as it is and says so. Absent from nothing but a test's literal; the Worker always sets it.
   */
  documents: DocumentsPart
}

export type Opened = { ok: true; value: ConversationAnswer } | { ok: false; status: 400 | 404 | 503; message: string }

// ── Which conversation ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest key taken: an address, or one of the list's synthetic keys, is far shorter. */
export const KEY_MAX = 320

/** What a row's key names (rows.ts, `PersonRow.key`): an address, or `mail:<contactId>` (a contact with no address), `chat:<personId>`, `chat:channel:<n>`. */
export type KeyKind = { kind: 'address'; address: string } | { kind: 'contact'; contactId: string } | { kind: 'person'; personId: string } | { kind: 'channel'; conversationId: number }

export function parseKey(key: string): KeyKind | null {
  if (key === '' || key.length > KEY_MAX) return null
  // Two rows that took one key are told apart by a suffix after "|" (conversations.ts): the part before it names where to look.
  const base = key.split('|')[0] as string
  const channel = /^chat:channel:(\d{1,15})$/.exec(base)
  if (channel) return { kind: 'channel', conversationId: Number(channel[1]) }
  if (base.startsWith('mail:')) return base.length > 5 ? { kind: 'contact', contactId: base.slice(5) } : null
  if (base.startsWith('chat:')) return base.length > 5 ? { kind: 'person', personId: base.slice(5) } : null
  const address = normalizeAddress(base)
  return address === null ? null : { kind: 'address', address }
}

// ── Opening it ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const mailMessage = (m: InboxMessage): MailMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  subject: m.subject,
  direction: m.direction,
  at: m.at,
  from: m.from,
  text: m.text,
  textCut: m.textCut,
  ...(m.read !== undefined && { read: { visible: m.read.visible, quoted: m.read.quoted } }),
  ...(m.to !== undefined && { to: m.to }),
  ...(m.attachments !== undefined && m.attachments.length > 0 && { attachments: m.attachments }),
  ...(m.calendar !== undefined && { calendar: m.calendar }),
  ...(m.delivery !== undefined && m.delivery.length > 0 && { delivery: m.delivery }),
  ...(m.sentByHand === true && { sentByHand: true }),
  ...(m.edited === true && { edited: true }),
  ...(m.deleted === true && { deleted: true }),
})

/**
 * Join the cards of a page of mail to the owner's Calendar tab: for each message that carries a calendar summary, the calendar's copy of the event it names (`eventsByUid`, one read for the page, a read of the calendar's own
 * store that asks Google nothing). A found event gives the card its address ("Open in Calendar") and lends a title or a time the part itself left out, which is all a bare "accepted" carries. ONLY FOR THE OWNER and only where the
 * install has the Calendar tab (its Gmail switch): a teammate's answer never asks the calendar, so nothing of the owner's calendar reaches them, and the calendar would refuse them anyway. The calendar not answering, or being
 * slow, leaves every card as the inbox gave it: the join never holds a conversation up past `ANSWER_WITHIN_MS` and never fails it.
 */
export async function joinCalendar(ask: Asking, messages: readonly MailMessage[]): Promise<MailMessage[]> {
  const { calendar } = ask.apps
  const wanting = messages.filter((m) => m.calendar !== undefined && m.calendar.uid !== '')
  if (!calendar || wanting.length === 0 || !ask.install.has('gmail') || !ask.install.isOwner(ask.signedIn.person)) return [...messages]
  const asked = wanting.slice(-CALENDAR_BY_UID_MOST)
  const answer = await reach('Calendar', () => calendar.eventsByUid(ask.signedIn, asked.map((m) => ({ uid: (m.calendar as MailCalendar).uid, occurrence: (m.calendar as MailCalendar).occurrence }))), isCalendarEventsOrNull, ask.answerWithinMs ?? ANSWER_WITHIN_MS)
  if (!answer.ok || answer.value.length !== asked.length) return [...messages]
  const found = new Map(asked.map((m, i) => [m.id, answer.value[i] ?? null]))
  return messages.map((m) => {
    const event = found.get(m.id)
    if (m.calendar === undefined || !event) return m
    const lent = m.calendar.title === '' ? { title: event.title } : {}
    const timeless = m.calendar.start === null && m.calendar.startDate === null && m.calendar.written === null
    const time = timeless
      ? { allDay: event.allDay, start: event.allDay ? null : event.start, end: event.allDay ? null : event.end, startDate: event.startDate, endDate: event.endDate, written: null }
      : {}
    return { ...m, calendar: { ...m.calendar, ...lent, ...time, eventId: event.id } }
  })
}
const chatMessage = (m: MeetMessage): ChatMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  authorName: m.authorName,
  mine: m.mine,
  at: m.at,
  text: m.text,
  edited: m.editedAt !== null,
  ...(m.huddle === undefined ? {} : { huddle: m.huddle }),
  ...(m.may === undefined ? {} : { may: m.may }),
})

/**
 * Where the "New" line goes: the first of the person's unread messages. Meet counts a conversation's unread as the messages from others after the read position, so the first of them is the
 * `unread`-th from the end among the others' messages. A page that holds fewer than that (the unread run is longer than the newest page) starts at the oldest of them. Null when nothing is unread.
 * The counted messages include a huddle's announcement, which is drawn as a card: the line then falls on the next message drawn after it.
 */
export function newFromOf(messages: readonly { id: number; mine: boolean }[], unread: number): number | null {
  if (!(unread > 0)) return null
  const theirs = messages.filter((m) => !m.mine)
  return theirs[Math.max(0, theirs.length - unread)]?.id ?? null
}

/** The most homes a person's cards are asked for: their row's key and its addresses. */
const HOMES_MOST = 20

/**
 * The parties on a thread other than the person asking and the row itself. The list never names a person's own address as "also on" their
 * threads, and a row that joins two of the inbox's contacts (a teammate known by two addresses) must not name one of them as also on the
 * other's thread: that would read "Reply all to Priya and Priya" and copy her to herself.
 */
function others(parties: readonly InboxParty[], self: readonly string[], own: readonly string[]): ThreadView['alsoOn'] {
  return parties
    .filter((p) => !own.includes(p.contactId) && !(p.address !== null && self.includes(normalizeAddress(p.address) ?? '')))
    .map((p) => ({ name: p.name, address: p.address }))
}

const firstFailure = (...answers: (Reached<unknown> | null)[]): Reached<unknown> => answers.find((a): a is Reached<unknown> => a !== null && !a.ok) ?? { ok: true, value: null }

type Located =
  | { ok: false; status: 400 | 404 | 503; message: string }
  | { ok: true; row: ListedConversation; parts: PartStatus[]; mail: Reached<InboxPeople> | null; chat: Reached<MeetOverview> | null }

/**
 * Find the row a key names: the inbox's contacts (scoped to the address when the key is one) and meet's overview, merged exactly as the list merges them, over every
 * conversation (open, closed or Bulk). What opening a conversation and Send for signature both begin with.
 */
async function locate(ask: Asking, key: string, scope?: Scope): Promise<Located> {
  const named = parseKey(key)
  if (!named) return { ok: false, status: 400, message: 'That is not a conversation the space knows how to open.' }
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, meet } = ask.apps
  const wantsMail = (named.kind === 'address' || named.kind === 'contact') && scope !== 'chat'
  // Without a scope every key reads meet too, a contact's included: a person reached by their contact id may also have a direct message there (joined by address), and opens with
  // both. The Inbox (`mail`) asks the inbox alone and Meet (`chat`) meet alone, so a conversation opened in one is that tab's and nothing of the other's.
  const wantsChat = scope !== 'mail'
  // A person the team knows by two addresses (their work address and the one their sign-in goes to) may be two contacts in the inbox.
  const addresses = named.kind === 'address' ? [named.address, ...(teamAddresses(ask, named.address))] : []
  // A contact's key asks for that contact by id, which narrows before the inbox cuts its newest screenful: a person older than that is still found.
  const contactIds = named.kind === 'contact' ? [named.contactId] : []

  const [mail, chat] = await Promise.all([
    wantsMail ? (inbox ? reach('Email', () => inbox.people(ask.signedIn, { include: ['bulk', 'closed'], ...(addresses.length > 0 && { addresses }), ...(contactIds.length > 0 && { contactIds }) }), isInboxPeople, ms) : notConnected('Email')) : null,
    wantsChat ? (meet ? reach('Chat', () => meet.conversations(ask.signedIn), isMeetOverview, ms) : notConnected('Chat')) : null,
  ])
  const merged = mergeConversations({ install: ask.install, self: ask.self, view: { kind: 'everything' }, inbox: mail?.ok ? mail.value : null, meet: chat?.ok ? chat.value : null })
  // A row is found by its key, or, for a link that names one of a person's addresses (a notification's tap names the sender's), by any address the row holds:
  // a person known by two addresses is one row, keyed by the first, and the sender may have written from the other.
  const conversations = merged.rows.filter(isConversationRow)
  // A key that names a contact (`mail:<contact id>`, which a draft's link and Today's rows use) finds the row that holds that contact, whatever its own key is: a person with an address is keyed by it.
  const row =
    conversations.find((r) => r.key === key) ??
    (named.kind === 'address' ? conversations.find((r) => r.type === 'person' && r.addresses.includes(named.address)) : undefined) ??
    (named.kind === 'contact' ? conversations.find((r) => r.type === 'person' && r.mail.some((m) => m.contactId === named.contactId)) : undefined)
  const parts: PartStatus[] = []
  if (mail) parts.push(statusOf('mail', mail))
  if (chat) parts.push(statusOf('chat', chat))
  if (!row) {
    const down = parts.find((p) => p.state !== 'ok')
    if (down) return { ok: false, status: 503, message: `${down.part === 'mail' ? 'Email' : 'Chat'} could not be reached just now, so this conversation could not be opened. It will be tried again.` }
    return { ok: false, status: 404, message: 'There is no such conversation. It may have been closed or moved.' }
  }
  return { ok: true, row, parts, mail, chat }
}

/**
 * The refs a conversation has in the apps: the inbox's contact for each of the person's mail sides, meet's conversation for a direct message or a
 * channel. Forms keeps the one a document was sent from and finds it by any of them (`FormsForSpace.documentsIn`), so a document sent from the mail side
 * shows when a direct message has since started. An id forms could not store is left out. The first is the one a new document carries.
 */
export function refsOf(row: ListedConversation): ConversationRef[] {
  const refs: ConversationRef[] =
    row.type === 'channel'
      ? [{ app: 'meet', id: String(row.conversationId) }]
      : [...row.mail.map((m): ConversationRef => ({ app: 'inbox', id: m.contactId })), ...(row.chat ? [{ app: 'meet', id: String(row.chat.conversationId) } satisfies ConversationRef] : [])]
  return refs.filter(isConversationRef)
}

/**
 * Open the conversation a row key names: find the row and its profile (`locate`), then read the history: each of the row's inbox contacts' messages, meet's history
 * of its direct message or channel, the drafts, and the documents sent from it (`documentsIn`, a part of its own that fails alone). A `scope` keeps it to one tab's side:
 * `mail` has the emails and no direct message, `chat` the direct message or channel and no email.
 */
export async function openConversation(ask: Asking, key: string, scope?: Scope): Promise<Opened> {
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, meet, forms } = ask.apps
  const found = await locate(ask, key, scope)
  if (!found.ok) return found
  const { row, parts, mail, chat } = found

  const contactIds = row.type === 'person' ? row.mail.map((m) => m.contactId) : []
  const chatId = row.type === 'channel' ? row.conversationId : (row.chat?.conversationId ?? null)
  // A person's calls are asked of meet by their row's key and every address it holds; a channel's or a direct message's by its conversation.
  const homes = row.type === 'person' ? [...new Set([row.key, ...row.addresses])].slice(0, HOMES_MOST) : []
  const refs = refsOf(row)
  const [histories, history, drafts, cardsRead, documents] = await Promise.all([
    Promise.all(contactIds.map((contactId) => (inbox ? reach('Email', () => inbox.messagesWith(ask.signedIn, { contactId }, { include: ['bulk', 'closed'] }), isInboxHistory, ms) : notConnected('Email')))),
    chatId !== null ? (meet ? reach('Chat', () => meet.history(ask.signedIn, chatId), isMeetHistory, ms) : notConnected('Chat')) : null,
    contactIds.length > 0 && inbox ? reach('Email', () => inbox.drafts(ask.signedIn), isInboxDrafts, ms) : null,
    (chatId !== null || homes.length > 0) && meet ? reach('Chat', () => meet.cards(ask.signedIn, { conversationIds: chatId !== null ? [chatId] : [], homes }), isMeetCalls, ms) : null,
    // Forms may not have the read yet (an older forms is called and throws, which is "could not be reached"): the history is not held back by it.
    refs.length === 0 ? null : forms ? reach('Forms', () => forms.documentsIn(ask.signedIn, refs, { limit: DOCUMENTS_SHOWN }), isDocuments, ms) : notConnected('Forms'),
  ])

  // The mail part is as well as its worst read, so a thread that could not be read is said and not left out in silence.
  const mailWorst = firstFailure(mail, ...histories, drafts)
  const statuses: PartStatus[] = []
  if (contactIds.length > 0 || mail) statuses.push(statusOf('mail', mailWorst))
  if (chat || history) statuses.push(statusOf('chat', firstFailure(chat, history, cardsRead)))

  const sources: HistorySource[] = []
  const threads = new Map<string, ThreadView>()
  // The cards of calendar mail are joined to the owner's Calendar tab (joinCalendar): one read of the calendar's store for each page of mail, never holding the conversation up.
  const withCards = await Promise.all(histories.map((h) => (h.ok ? joinCalendar(ask, h.value.messages.map(mailMessage)) : Promise.resolve(null))))
  histories.forEach((h, i) => {
    if (!h.ok) return
    sources.push({ kind: 'mail', contactId: contactIds[i] as string, messages: withCards[i] ?? h.value.messages.map(mailMessage), more: h.value.more })
    for (const t of h.value.threads) {
      const held = threads.get(t.conversationId)
      const alsoOn = others(t.alsoOn, ask.self, contactIds)
      if (held) {
        // The same thread read under another of the person's contacts: one thread, with everyone who is on it from either read.
        for (const o of alsoOn) if (!held.alsoOn.some((x) => x.name === o.name && x.address === o.address)) held.alsoOn.push(o)
        continue
      }
      threads.set(t.conversationId, { conversationId: t.conversationId, subject: t.subject, kind: t.kind, through: t.through, unread: t.unread, open: t.open, bulk: t.bulk, mailbox: t.mailbox?.name ?? null, canReply: t.canReply, canAttach: t.canAttach === true, ...(t.canPicture === true && { canPicture: true }), canMarkSpam: t.canMarkSpam === true, ...(t.telegramChat !== undefined && { telegramChat: t.telegramChat }), at: null, alsoOn })
    }
  })
  if (history?.ok && chatId !== null) sources.push({ kind: 'chat', conversationId: chatId, messages: history.value.messages.map(chatMessage), more: history.value.more })

  // When each thread's newest message in the history is, so the reply opens in the newest thread (a thread with none in the page is older than all of them).
  const newestIn = new Map<string, number>()
  for (const src of sources) {
    if (src.kind !== 'mail') continue
    for (const m of src.messages) newestIn.set(m.conversationId, Math.max(newestIn.get(m.conversationId) ?? 0, m.at))
  }
  const threadList = [...threads.values()].map((t) => ({ ...t, at: newestIn.get(t.conversationId) ?? null }))
  const heldThreads = new Map(threadList.map((t) => [t.conversationId, t]))
  const draftViews: DraftView[] = drafts?.ok
    ? drafts.value
        .filter((d) => contactIds.includes(d.contactId) || (d.conversationId !== null && heldThreads.has(d.conversationId)))
        .map((d): DraftView => draftViewOf(d, d.conversationId === null ? null : (heldThreads.get(d.conversationId) ?? null)))
        .sort((a, b) => a.at - b.at)
    : []

  // OPENING IT MARKS READ WHAT IS ON SCREEN AND NOTHING ELSE. `messagesWith` answers every thread the person has at its current position, but the
  // history shows only the newest page and only as far back as every source with more has been read (history.ts); a thread whose newest message is not
  // drawn (an unread email behind "Earlier messages", thirty Bulk threads older than the page) has not been seen and is not marked.
  const drawn = mergeHistory(sources).entries
  const mailDrawn = new Set(drawn.flatMap((e) => (e.kind === 'email' ? [e.message.conversationId] : [])))
  const chatDrawn = drawn.flatMap((e) => (e.kind === 'chat' ? [e.message.id] : []))
  const newestChat = chatDrawn.length > 0 ? Math.max(...chatDrawn) : 0
  const chatUnread = row.type === 'channel' ? row.unread : (row.chat?.unread ?? 0)
  const read: ReadMarks = {
    mail: threadList.filter((t) => t.unread && mailDrawn.has(t.conversationId)).map((t) => ({ conversationId: t.conversationId, through: t.through })),
    chat: chatId !== null && chatUnread > 0 && newestChat > 0 ? { conversationId: chatId, upTo: newestChat } : null,
  }

  const change: ChangeMarks = {
    close: threadList.filter((t) => t.open && mailDrawn.has(t.conversationId)).map((t) => ({ conversationId: t.conversationId, through: t.through })),
    notShown: threadList.filter((t) => t.open && !mailDrawn.has(t.conversationId)).length,
    reopen: threadList.filter((t) => !t.open && mailDrawn.has(t.conversationId)).map((t) => t.conversationId),
  }

  return { ok: true, value: { key: row.key, row, parts: statuses.length > 0 ? statuses : parts, sources, threads: threadList, drafts: draftViews, profile: profileOf(ask, row), read, change, calls: cardsRead?.ok ? cardsRead.value : [], chatPerson: chatPersonFor(row, chat), newFrom: history?.ok ? newFromOf(history.value.messages, chatUnread) : null, documents: documents ? documentsPartOf(documents, 'the documents sent from here are not shown.') : { state: 'ok', documents: [], more: false } } }
}

// ── Sending a document from it ──────────────────────────────────────────────────────────────────────────────────────

/** Who a document sent from a conversation is for, and the conversation it carries. */
export interface SigningFrom {
  /** The row's key, as the address of the page names it. */
  key: string
  /** Their name for a person, `# name` for a channel. */
  name: string
  channel: boolean
  /** The conversation ref a new document carries: the conversation's first ref, or null when it has none forms could store. */
  conversation: ConversationRef | null
  /** Who to put down as signers: the person, with every email address the space knows for them (the first is the one to use). A channel names no one: meet does not say who is in it. */
  people: { name: string; addresses: string[] }[]
}

export type Signing = { ok: true; value: SigningFrom } | { ok: false; status: 400 | 404 | 503; message: string }

/** What the Send screen fills in when it is opened from a conversation. Reads only, the same two reads that find the row. */
export async function signingFrom(ask: Asking, key: string): Promise<Signing> {
  const found = await locate(ask, key)
  if (!found.ok) return found
  const { row } = found
  // Only a person with more than one address needs the newest mail read to say which they use now.
  let newest: Parameters<typeof addressesInUse>[1] = null
  const { inbox } = ask.apps
  if (row.type === 'person' && row.addresses.length > 1 && inbox) {
    const side = [...row.mail].sort((a, b) => b.newest.at - a.newest.at)[0]
    const got = side ? await reach('Email', () => inbox.messagesWith(ask.signedIn, { contactId: side.contactId }, { include: ['bulk', 'closed'] }), isInboxHistory, ask.answerWithinMs ?? ANSWER_WITHIN_MS) : null
    const last = got?.ok ? [...got.value.messages].sort((a, b) => b.at - a.at)[0] : undefined
    if (last) newest = { direction: last.direction, from: last.from, ...(last.to !== undefined && { to: last.to }) }
  }
  return {
    ok: true,
    value: {
      key: row.key,
      name: row.type === 'channel' ? `# ${row.name}` : row.name,
      channel: row.type === 'channel',
      conversation: refsOf(row)[0] ?? null,
      people: row.type === 'channel' ? [] : [{ name: row.name, addresses: addressesInUse(row, newest) }],
    },
  }
}

/**
 * A person's addresses, the one they write from now first. The row holds them sorted, so its first is only the alphabetically first, and a person who has moved from
 * an old address to a new one would be sent a document at the old. The address in use is the one on the row's newest mail: who wrote it, or, for a message we sent, who
 * it went to. With no mail, or a newest message that names none of the row's addresses, it is just sorted.
 */
export function addressesInUse(row: Extract<ListedConversation, { type: 'person' }>, newest: { direction: 'in' | 'out'; from: string; to?: string } | null): string[] {
  const sorted = [...row.addresses].sort()
  const used = newest === null ? null : normalizeAddress(newest.direction === 'in' ? newest.from : (newest.to ?? '').split(',')[0] ?? '')
  return used !== null && sorted.includes(used) ? [used, ...sorted.filter((a) => a !== used)] : sorted
}

/**
 * Someone meet lists a direct message with, that has nothing in it yet, for a row that has no direct message to draw: a teammate or a channel guest
 * the person can write to though neither has written. The row's addresses name them (meet knows a teammate by the sign-in address, and the row holds both).
 */
function chatPersonFor(row: ListedConversation, chat: Reached<MeetOverview> | null): ConversationAnswer['chatPerson'] {
  if (row.type !== 'person' || row.chat !== null || !chat?.ok) return null
  // Meet's address is compared as the row's are (`normalizeAddress`), since the row holds the normalised ones and meet may hold one in the case it was typed.
  const found = chat.value.direct.find((d) => {
    const address = normalizeAddress(d.person.address)
    return d.newest === null && address !== null && row.addresses.includes(address)
  })
  return found ? { personId: found.person.id, name: found.person.name } : null
}

/** The addresses a team person is known by, when the address names one: both, as the list joins a teammate on both. */
function teamAddresses(ask: Asking, address: string): string[] {
  const person = teamPersonFor(ask.install, address)
  return person ? [person.address, person.signIn] : []
}

function profileOf(ask: Asking, row: ListedConversation): Profile {
  if (row.type === 'channel') return { kind: 'channel', name: row.name, privacy: row.privacy, memberCount: row.memberCount }
  if (row.side === 'team') {
    const person = row.addresses.map((a) => teamPersonFor(ask.install, a)).find((p) => p !== null) ?? null
    return { kind: 'team', name: row.name, address: person?.address ?? row.addresses[0] ?? null, signIn: person?.signIn ?? null, role: person?.role ?? null, chat: row.chat !== null }
  }
  return { kind: 'outside', name: row.name, client: row.client, addresses: row.addresses, chat: row.chat !== null, ...(row.telegramChat !== null && { telegramChat: row.telegramChat }) }
}

// ── Older messages ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EarlierQuery = { mail: { contactId: string; before: string } } | { chat: { conversationId: number; before: number } }

export type Earlier = { ok: true; messages: MailMessage[] | ChatMessage[]; more: boolean } | { ok: false; status: 400 | 502 | 503; message: string }

const ID = /^[A-Za-z0-9_.:@+-]{1,200}$/

/** Parse `?mail=<contactId>&before=<id>` or `?chat=<n>&before=<n>`. */
export function parseEarlier(q: { mail?: string; chat?: string; before?: string }): EarlierQuery | null {
  if (q.before === undefined) return null
  if (q.mail !== undefined && q.chat === undefined) return ID.test(q.mail) && ID.test(q.before) ? { mail: { contactId: q.mail, before: q.before } } : null
  if (q.chat !== undefined && q.mail === undefined) return /^\d{1,15}$/.test(q.chat) && /^\d{1,15}$/.test(q.before) ? { chat: { conversationId: Number(q.chat), before: Number(q.before) } } : null
  return null
}

/** A page of older messages from one source: the app's own page, the one before the oldest message the page holds. */
export async function earlier(ask: Asking, q: EarlierQuery): Promise<Earlier> {
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const { inbox, meet } = ask.apps
  if ('mail' in q) {
    const { contactId, before } = q.mail
    const got = inbox ? await reach('Email', () => inbox.messagesWith(ask.signedIn, { contactId }, { include: ['bulk', 'closed'], before }), isInboxHistory, ms) : notConnected('Email')
    if (!got.ok) return { ok: false, status: got.kind === 'refused' ? 400 : 503, message: got.message }
    return { ok: true, messages: await joinCalendar(ask, got.value.messages.map(mailMessage)), more: got.value.more }
  }
  const { conversationId, before } = q.chat
  const got = meet ? await reach('Chat', () => meet.history(ask.signedIn, conversationId, before), isMeetHistory, ms) : notConnected('Chat')
  if (!got.ok) return { ok: false, status: got.kind === 'refused' ? 400 : 503, message: got.message }
  return { ok: true, messages: got.value.messages.map(chatMessage), more: got.value.more }
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How a write ended, in the words the page needs. One of these always comes back for a write the Worker accepted:
 *
 * - `done`: it went out (`sent`), or the inbox could not tell whether Gmail took it (`sending`: check Sent; the key is held, so a repeat sends nothing).
 * - `repeated`: the key was already used, nothing new was sent, and `earlier` says how the first went.
 * - `refused`: the app said no and sent nothing, in its own words; the key is released, so pressing Send again with it sends.
 * - `failed`: the app knows nothing went out (`broken`); the key is released, as for a refusal.
 * - `outcome-unknown`: the space lost track of it. It may have gone out. The page says to check and offers NO second try.
 */
export type WriteOutcome =
  | { result: 'done'; status: 'sent' | 'sending' }
  | { result: 'repeated'; earlier: 'in-progress' | 'sent' | 'sending' }
  | { result: 'refused'; reason: RefusalReason; message: string }
  | { result: 'failed'; message: string }
  | { result: 'outcome-unknown'; message: string }

function writeOutcome<T>(answer: ReachedWrite<T>, statusFor: (value: T) => 'sent' | 'sending', who: string): WriteOutcome {
  if (answer.ok) return { result: 'done', status: statusFor(answer.value) }
  if (answer.kind === 'failed') {
    return answer.reason === 'broken' ? { result: 'failed', message: answer.message } : { result: 'outcome-unknown', message: answer.message }
  }
  if (answer.reason === 'repeated') {
    const earlier = (answer as Repeated<T>).earlier
    if (earlier.state === 'in-progress') return { result: 'repeated', earlier: 'in-progress' }
    return earlier.reply.ok ? { result: 'repeated', earlier: statusFor(earlier.reply.value) } : { result: 'outcome-unknown', message: `${who} said this was already sent, but not how it went.` }
  }
  // The space has just signed this person in, so a part that says it is not signed in is misconfigured.
  if (answer.reason === 'not-signed-in') {
    console.error(`space: ${who} refused a person the space had signed in; a part in this Worker should never say so`)
    return { result: 'refused', reason: answer.reason, message: `${who} could not check your sign-in.` }
  }
  return { result: 'refused', reason: answer.reason, message: answer.message }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const isKey = (v: unknown): v is string => typeof v === 'string' && COMPOSE_KEY.test(v)
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
/** The longest message taken: far past what anyone writes, short of a document. The apps apply their own, shorter limits. */
export const TEXT_MAX = 100_000
/** Words to send: something said, within the cap (not the guards' `isText`, which is only "a string"). */
const isWords = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= TEXT_MAX

/** The body of an email send: a held draft as it stands, or a reply in the thread the person chose. */
export function parseEmail(
  body: unknown,
  /** The form that carries a file (`/api/email/files`) may have no words in a reply: a picture can speak for itself, and the inbox refuses an empty reply where a picture cannot go. */
  options: { wordsMayBeEmpty?: boolean } = {},
): Parsed<Extract<InboxSend, { key: string }>> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: 'A send names a compose key of 16 to 128 letters, digits, "_" and "-".' }
  if (isId(body.draftId)) {
    if (!isCount(body.rev)) return { ok: false, message: 'Sending a draft names its revision.' }
    if (body.through !== null && !isCount(body.through)) return { ok: false, message: 'through is how far into the conversation was read, or null.' }
    return { ok: true, value: { key: body.key, draftId: body.draftId, rev: body.rev, through: body.through } }
  }
  if (body.conversationId === undefined && body.address !== undefined) return parseNewEmail(body, body.key)
  if (!isId(body.conversationId) || !isCount(body.through)) return { ok: false, message: 'A reply names its conversation and how far into it was read.' }
  const empty = options.wordsMayBeEmpty === true && typeof body.text === 'string' && body.text.trim() === ''
  if (!empty && !isWords(body.text)) return { ok: false, message: 'A reply needs something to say.' }
  if (typeof body.text !== 'string') return { ok: false, message: 'A reply needs something to say.' }
  if (body.copyEveryone !== undefined && typeof body.copyEveryone !== 'boolean') return { ok: false, message: 'copyEveryone is yes or no.' }
  return { ok: true, value: { key: body.key, conversationId: body.conversationId, through: body.through, text: body.text, ...(body.copyEveryone === true && { copyEveryone: true }) } }
}

/** The longest subject and name taken with a new email: the inbox applies its own (a subject is cut at 300) and refuses past it. */
const HEAD_MAX = 1000

/** A new email to an address: who, what it is about, the words, and which mailbox it goes out from. The inbox makes the person a contact if they are new. */
function parseNewEmail(body: Record<string, unknown>, key: string): Parsed<Extract<InboxSend, { key: string }>> {
  const address = typeof body.address === 'string' ? normalizeAddress(body.address) : null
  if (address === null) return { ok: false, message: 'That is not an email address.' }
  if (typeof body.subject !== 'string' || body.subject.length > HEAD_MAX) return { ok: false, message: 'A new email needs a subject.' }
  if (!isWords(body.text)) return { ok: false, message: 'A new email needs something to say.' }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > HEAD_MAX)) return { ok: false, message: 'The name is text.' }
  const from = readInboxFrom(body.from)
  if (!from.ok) return from
  return {
    ok: true,
    value: { key, address, subject: body.subject, text: body.text, ...(typeof body.name === 'string' && body.name.trim() !== '' && { name: body.name }), ...(from.from !== undefined && { from: from.from }) },
  }
}

export async function sendEmail(ask: Asking, send: InboxSend): Promise<WriteOutcome> {
  const { inbox } = ask.apps
  if (!inbox) return { result: 'failed', message: 'Email is not connected to the space. Nothing was sent.' }
  // A new email that picks a mailbox or carries files is sent only to an inbox that says it honours both: an older one ignores them without a word.
  if ('address' in send && (send.from !== undefined || (send.attachments?.length ?? 0) > 0)) {
    const can = await inboxCan(ask, NEW_EMAIL_CAPABILITY)
    if (!can.can) return { result: 'failed', message: `${can.message} Nothing was sent.` }
  }
  const answer = await reachWrite('Email', () => inbox.send(ask.signedIn, send), isInboxSent, ask.writeWithinMs ?? WRITE_WITHIN_MS)
  return writeOutcome(answer, (sent) => sent.status, 'Email')
}

export type ChatBody = { key: string; text: string; conversationId: number } | { key: string; text: string; personId: string }

/** The body of a direct message or channel post. */
export function parseChat(body: unknown): Parsed<ChatBody> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: 'A post names a compose key of 16 to 128 letters, digits, "_" and "-".' }
  if (!isWords(body.text)) return { ok: false, message: 'A message needs something to say.' }
  if (isCount(body.conversationId) && body.personId === undefined) return { ok: true, value: { key: body.key, text: body.text, conversationId: body.conversationId } }
  if (isId(body.personId) && body.conversationId === undefined) return { ok: true, value: { key: body.key, text: body.text, personId: body.personId } }
  return { ok: false, message: 'A post names a conversation, or a person.' }
}

export async function postChat(ask: Asking, post: ChatBody): Promise<WriteOutcome> {
  const { meet } = ask.apps
  if (!meet) return { result: 'failed', message: 'Chat is not connected to the space. Nothing was sent.' }
  const target = 'conversationId' in post ? { conversationId: post.conversationId } : { personId: post.personId }
  const answer = await reachWrite('Chat', () => meet.post(ask.signedIn, { key: post.key, target, text: post.text }), isMeetPosted, ask.writeWithinMs ?? WRITE_WITHIN_MS)
  return writeOutcome(answer, () => 'sent', 'Chat')
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What marking read did, per app. Best effort: a thread that was not marked, and why, never stops the other from being. */
export interface ReadOutcome {
  mail: { state: 'skipped' } | { state: 'ok'; read: string[]; notRead: { conversationId: string; reason: string; message: string }[] } | { state: 'unanswered'; message: string }
  chat: { state: 'skipped' } | { state: 'ok' } | { state: 'refused'; message: string } | { state: 'unanswered'; message: string }
}

export function parseRead(body: unknown): Parsed<ReadMarks> {
  if (!isRecord(body) || !Array.isArray(body.mail) || body.mail.length > 200) return { ok: false, message: 'Marking read names the email conversations and the chat.' }
  const mail: InboxReadMark[] = []
  for (const m of body.mail) {
    if (!isRecord(m) || !isId(m.conversationId) || !isCount(m.through)) return { ok: false, message: 'Each email conversation names how far into it was read.' }
    mail.push({ conversationId: m.conversationId, through: m.through })
  }
  const c = body.chat
  if (c === null || c === undefined) return { ok: true, value: { mail, chat: null } }
  if (!isRecord(c) || !isCount(c.conversationId) || !isCount(c.upTo)) return { ok: false, message: 'The chat names its conversation and the message read up to.' }
  return { ok: true, value: { mail, chat: { conversationId: c.conversationId, upTo: c.upTo } } }
}

/** Mark the conversation read in both apps (which marks read in Gmail, as the inbox does today). Idempotent: marking twice is marking once. */
export async function markRead(ask: Asking, marks: ReadMarks): Promise<ReadOutcome> {
  const ms = ask.writeWithinMs ?? WRITE_WITHIN_MS
  const { inbox, meet } = ask.apps
  const chatMark = marks.chat
  const [mail, chat] = await Promise.all([
    marks.mail.length > 0 ? (inbox ? reach('Email', () => inbox.markRead(ask.signedIn, marks.mail), isInboxReadResult, ms) : notConnected('Email')) : null,
    chatMark ? (meet ? reach('Chat', () => meet.markRead(ask.signedIn, chatMark.conversationId, chatMark.upTo), isMeetRead, ms) : notConnected('Chat')) : null,
  ])
  return {
    mail: mail === null ? { state: 'skipped' } : mail.ok ? { state: 'ok', read: mail.value.read, notRead: mail.value.notRead.map((n) => ({ conversationId: n.conversationId, reason: n.outcome.reason, message: n.outcome.message })) } : { state: 'unanswered', message: mail.message },
    chat: chat === null ? { state: 'skipped' } : chat.ok ? { state: 'ok' } : chat.kind === 'refused' ? { state: 'refused', message: chat.message } : { state: 'unanswered', message: chat.message },
  }
}

// ── Closing and reopening ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A conversation the inbox did not close or reopen, and why, in its own words (a refusal's reason, such as `conflict`, or `broken`). */
export interface NotChanged {
  conversationId: string
  reason: string
  message: string
}

/**
 * What closing or reopening did, per conversation, in the contract's own names (`closed`/`notClosed`, `reopened`/`notReopened`). Chat has no close
 * in meet, so only the inbox is asked. Both are idempotent and re-guarded (workspace ADR 0001, "Writes go out at most once", the exception), so a lost
 * answer is not an unknown outcome to guard against: the page reads the conversation again and shows how it stands, and may press again.
 */
export type CloseOutcome = { state: 'ok'; closed: string[]; notClosed: NotChanged[] } | { state: 'unanswered'; message: string }
export type ReopenOutcome = { state: 'ok'; reopened: string[]; notReopened: NotChanged[] } | { state: 'unanswered'; message: string }

/** At most this many conversations in one close or reopen: the inbox's own limit, the contract's `INBOX_MOST_MARKS`, so the space refuses what the inbox would. */
const tooMany = (list: unknown[]): boolean => list.length < 1 || list.length > INBOX_MOST_MARKS

export function parseClose(body: unknown): Parsed<InboxCloseMark[]> {
  if (!isRecord(body) || !Array.isArray(body.mail) || tooMany(body.mail)) return { ok: false, message: 'Closing names the email conversations and how far into each was read.' }
  const mail: InboxCloseMark[] = []
  for (const m of body.mail) {
    if (!isRecord(m) || !isId(m.conversationId) || !isCount(m.through)) return { ok: false, message: 'Each email conversation names how far into it was read.' }
    mail.push({ conversationId: m.conversationId, through: m.through })
  }
  return { ok: true, value: mail }
}

export function parseReopen(body: unknown): Parsed<string[]> {
  if (!isRecord(body) || !Array.isArray(body.mail) || tooMany(body.mail) || !body.mail.every(isId)) return { ok: false, message: 'Reopening names the email conversations.' }
  return { ok: true, value: body.mail as string[] }
}

const notChanged = (list: { conversationId: string; outcome: { reason: string; message: string } }[]): NotChanged[] =>
  list.map((n) => ({ conversationId: n.conversationId, reason: n.outcome.reason, message: n.outcome.message }))

/** Close the email conversations named, each at the position read to. The inbox refuses a conversation with newer mail (`conflict`) and changes nothing of it. */
export async function closeConversations(ask: Asking, marks: readonly InboxCloseMark[]): Promise<CloseOutcome> {
  const { inbox } = ask.apps
  if (!inbox) return { state: 'unanswered', message: 'Email is not connected to the space. Nothing was closed.' }
  const got = await reach('Email', () => inbox.closeConversations(ask.signedIn, marks), isInboxCloseResult, ask.writeWithinMs ?? WRITE_WITHIN_MS)
  if (!got.ok) return { state: 'unanswered', message: got.message }
  return { state: 'ok', closed: got.value.closed, notClosed: notChanged(got.value.notClosed) }
}

/** Reopen the email conversations named. */
export async function reopenConversations(ask: Asking, conversationIds: readonly string[]): Promise<ReopenOutcome> {
  const { inbox } = ask.apps
  if (!inbox) return { state: 'unanswered', message: 'Email is not connected to the space. Nothing was reopened.' }
  const got = await reach('Email', () => inbox.reopenConversations(ask.signedIn, conversationIds), isInboxReopenResult, ask.writeWithinMs ?? WRITE_WITHIN_MS)
  if (!got.ok) return { state: 'unanswered', message: got.message }
  return { state: 'ok', reopened: got.value.reopened, notReopened: notChanged(got.value.notReopened) }
}
