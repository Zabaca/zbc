// Stand-ins for the inbox and meet behind their bindings: what `bun test` asks instead of the real apps, and what a
// local page shows with fixture data (`SPACE_FIXTURES`, src/app.ts) so the Inbox's and Meet's lists can be seen and photographed without either app.
//
// They keep the shape of the real answers (packages/workspace/src/inbox-for-space.ts and meet-for-space.ts) and the one rule of
// the real inbox the list leans on: a conversation comes back under EVERY contact on it, with a line saying whether the lists put it under that
// contact (`listed`, and `listedInClient` for a Client's list; one contact per thread). They check nothing about who is asking; the real apps do, and the space's own tests
// prove it passes the asker along.

import { canSee, type MailScope, scopeOf } from '@space/inbox/src/queue'
import { sniffPicture } from '@space/inbox/src/telegram/wire'
import {
  type SignedIn,
  type CalendarSummary,
  type ConversationApp,
  type ConversationRef,
  type Documents,
  type DocumentsQuery,
  type DocumentSummary,
  type FormsForSpace,
  INBOX_HISTORY_PAGE,
  type InboxAddress,
  type InboxChatTurn,
  type InboxDraft,
  type InboxDraftAt,
  type InboxDraftEdit,
  type InboxDraftPicture,
  type InboxForSpace,
  type InboxDeliveryNote,
  type FileRange,
  INBOX_FILE_PART_BYTES,
  INBOX_FILE_WHOLE_BYTES,
  type InboxFileOut,
  type InboxHandSent,
  type InboxHistory,
  type InboxHistoryQuery,
  type InboxRead,
  type InboxMailbox,
  type InboxParty,
  type InboxPeople,
  type InboxPerson,
  type InboxAttachment,
  type InboxCloseMark,
  type InboxCloseResult,
  type InboxReadMark,
  type InboxReadResult,
  type InboxReopenResult,
  type InboxScope,
  type InboxSearch,
  type InboxSend,
  type InboxSendResolution,
  type InboxSendResolved,
  type InboxSent,
  type InboxSpamMark,
  type InboxSpamResult,
  type InboxThreadLine,
  type InboxWho,
  type MailKind,
  type MeetBooking,
  type MeetCall,
  type MeetCallChat,
  type MeetCallMessage,
  type MeetCallPage,
  type MeetCallRef,
  type MeetCallStart,
  type MeetCardsWant,
  type MeetChannel,
  type MeetDirect,
  type MeetEdit,
  type MeetMe,
  type MeetMePatch,
  type MeetReachable,
  type MeetForSpace,
  type MeetHistory,
  type MeetHuddleStart,
  type MeetLiveCall,
  type MeetMessage,
  type MeetOverview,
  type MeetPerson,
  type MeetPhone,
  type MeetPhoneItem,
  type MeetPhoneSummary,
  type MeetBookmark,
  type MeetCounts,
  type MeetObject,
  type MeetPost,
  type MeetRestarted,
  type MeetRestoring,
  type MeetPosted,
  type MeetRead,
  type MeetUsage,
  type SpaceReply,
  summaryLine,
  type WriteReply,
  answered,
  failed,
  refused,
  repeated,
  resolveByteRange,
} from '@space/workspace'
import { type StandInChannelOptions, type StandInChannels, standInChannels } from './stand-in-channels'

/** meet's page of history, as its entrypoint pages (`MeetHistory`: the newest 50). */
const HISTORY_PAGE = 50

// ── The inbox ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StandInContact {
  id: string
  name: string
  addresses: string[]
  client?: { id: number; name: string }
  /** The Client the inbox only suggests for this contact (they have none linked): the dashed pill. */
  suggested?: { id: number; name: string }
  /** People's three fields (the inbox's migration 12), empty until set, and the revision a write must name. */
  business?: string
  role?: string
  notes?: string
  rev?: number
  /** The inbox judges this contact an automated sender (a newsletter): People leaves it out. */
  automated?: boolean
  /** The contact stands for a Telegram group or channel (the conversation's one participant, named by its title): People leaves it out, as the inbox does. */
  chat?: 'group' | 'channel'
}

/** A message in a thread. A thread given none has one, made from its snippet. */
export interface StandInMessage {
  id: string
  at: number
  direction: 'in' | 'out'
  from: string
  text: string
  /**
   * The fold the inbox's page makes of a text that has a quote in it (the real inbox decides; a stand-in is told, and test/stand-in-reads.test.ts checks every
   * fixture's against the inbox's own function). A message without one is read whole.
   */
  read?: InboxRead
  /** Files on it, with their bytes. The inbox lists them (`attachments`) and gives them back (`attachment`) as it does for mail in a business mailbox. */
  files?: StandInFile[]
  /** What Cloudflare reported of the recipients of a message sent as a business mailbox. */
  delivery?: InboxDeliveryNote[]
  /** Who a message of ours went to, when it is not the person's first address (a reply to an old address). */
  to?: string
  /** The message is too large for the inbox to open a file from: its files are named only and say so (the inbox's `tooLarge`). */
  tooLarge?: boolean
  /** A text or a direct message Tessa marked sent by hand: the history says so, and "Not sent after all" is offered on it. */
  sentByHand?: boolean
  /** A Telegram message its sender edited, or deleted for everyone (the words are then gone): the history says so. */
  edited?: boolean
  deleted?: boolean
  /** What the email's calendar part says, as the inbox read it when the mail arrived: the page draws a card from it. A message with no words and one of these is listed under the line it makes (`summaryLine`). */
  calendar?: CalendarSummary
}

/** A file on a message, as the stand-in keeps it. */
export interface StandInFile {
  name: string
  type: string
  bytes: Uint8Array
  /** A voice note from Telegram the inbox has copied: the page draws a player over it. */
  play?: boolean
  /** A video from Telegram the inbox has copied: the page draws an inline player over it. */
  video?: boolean
  seconds?: number
  /** The size to name when the bytes are not held (a file left in Telegram). */
  size?: number
  /** A file left in Telegram (too large, not a photo or voice note, a channel's): named, with the inbox's own line, and no bytes to give. */
  note?: string
}

export interface StandInThread {
  id: string
  subject: string
  kind?: MailKind
  at: number
  snippet: string
  direction?: 'in' | 'out'
  unread?: boolean
  open?: boolean
  bulk?: boolean
  mailbox?: InboxMailbox | null
  /** The contacts on it. It is listed under ONE of them (`listedUnder`), and every one's own page holds it. */
  on: string[]
  /** The contact it is listed under. Left out: the contact whose name wrote the newest message that came in, else the first of `on` (the inbox's rule, as far as a stand-in has the facts). */
  listedUnder?: string
  /** A Telegram group (its messages are named by who wrote them; its `on` is the group's own contact) or channel. */
  telegramChat?: 'group' | 'channel'
  /** For a group: a message to Tessa (a mention of him, or a reply to one of his) is waiting for his answer. */
  needsReply?: boolean
  messages?: StandInMessage[]
}

export interface StandInDraft {
  id: string
  conversationId: string | null
  contactId: string
  subject: string
  text: string
  rev?: number
  author?: InboxDraft['author']
  stuck?: boolean
  at: number
  /** Why it was drafted, and who changed it when that is not its author. */
  why?: string
  editedBy?: InboxDraft['author'] | null
  /** Who it copies besides its contact (a draft made to reply to all). Omitted: copies no one. `null`: the answer has no `cc` at all, as an inbox that predates it. */
  cc?: InboxAddress[] | null
  /** How it goes: omitted is an inbox that does not say (the page offers nothing new on it). A `sms` or `manual` draft is one the inbox cannot send: Mark sent. */
  kind?: MailKind
  /** The business mailbox a stuck send went out of (no Sent folder to check): omitted is Tessa's Gmail. */
  sentFrom?: string
  sendsFrom?: { name: string; address: string }
  /** Where it goes when that is not the contact's first address (a number, a handle). */
  to?: string
  /** On a Telegram draft Telegram would not take: why, in words. */
  refusal?: string
  /** The picture a Telegram draft carries: the inbox lists its type and length (`picture`) and gives its bytes back through `attachment` for this draft's id, index 0. */
  picture?: { name: string; type: string; bytes: Uint8Array }
}

/**
 * What the next `send` does instead of the normal thing, one entry per call, in order. `conflict`: refused, as the inbox refuses a reply
 * when mail arrived after what was read (the key is released). `broken`: failed, nothing went out (released). `sending`: Gmail never said;
 * a success the key is held for. `throw`: the binding fails, nothing sent. `hang`: never answers. `slow`: answers after a moment, the key
 * in progress meanwhile.
 */
export type SendStep = 'conflict' | 'broken' | 'sending' | 'throw' | 'hang' | 'slow'

export interface StandInInbox extends InboxForSpace {
  /** What the space asked, so a test can see it. */
  asked: { scopes: (InboxScope | undefined)[]; searches: string[]; askers: string[]; histories: { who: InboxWho; query: InboxHistoryQuery | undefined }[]; reads: InboxReadMark[][]; sends: InboxSend[]; closes: InboxCloseMark[][]; reopens: string[][]; edits: InboxDraftEdit[]; spam: InboxSpamMark[]; settled: InboxSendResolution[]; marked: string[]; unmarked: string[]; opened: string[] }
  /** The files the space asked for, in order (`attachment`): what was asked and how, so a test can see that nothing else was. */
  fileReads: { messageId: string; index: number; how: string; range?: FileRange }[]
  /** The pictures the space put on drafts, in order (`putDraftPicture`): the draft, the revision named, the file's name and its length. */
  pictureWrites: { draftId: string; rev: number; name: string; size: number }[]
  /** The sends that actually went out, in order: a refused one, a failed one and a repeated one are not here. */
  sent: InboxSend[]
  /** Who each held draft that went out reached: its contact's address and everyone its Cc names. What a person was shown must be this. */
  reached: { draftId: string; to: string; cc: string[] }[]
  script: { send: SendStep[] }
  /** Mail arrives in a thread after the person last read it: its position moves on, so a reply that names the old one is refused. */
  arrive(threadId: string, message: StandInMessage): void
  /** The threads as the inbox holds them now (their unread, their messages), so a test can see what was and was not read. */
  threads(): StandInThread[]
  /** The inbox's other views: their state, what was asked of them, and what the next call does instead (`script`). */
  views: StandInViews
}

import { dayAround } from './today'
import { fixtureKnowledge } from './fixture-knowledge'
import { CLIP_WEBM, DROP_OFF_FORM_PDF, SHEET_PHOTO_PNG, RECEIPT_PDF, VOICE_NOTE_OGG } from './fixture-files'
import { fixtureViews } from './fixture-views'
import { standInPeople } from './stand-in-people'
import { standInCalendar } from './stand-in-calendar'
import { calendarMailFixtures } from './fixture-calendar-mail'
import { standInKnowledge } from './stand-in-knowledge'
import { type StandInViewState, type StandInViews, mailboxMark, standInViews } from './stand-in-views'
import { type StandInClients, fixtureClients, standInClients } from './stand-in-clients'
import { standInFormsNames } from './stand-in-forms-names'

/** The kinds the inbox shows as pictures (its own list is image.ts, PREVIEW_TYPES). */
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const notHere = <T>(): SpaceReply<T> => failed('The stand-in does not do that.')

/** The inbox's refusal of an edit (or a send) over a draft that changed after it was shown, in its words. */
export const CHANGED_WORDS = 'This draft was changed after it was shown, so nothing was changed. It is shown as it is now.'

/** Addresses that are ours: a new email to one of them is refused. */
const OWN_ADDRESSES = ['tessa@northfield.example', 'info@ridgewaycycles.example', 'hello@shiftlantern.example']

/** The inbox's conflict, in its words. */
export const CONFLICT_WORDS = 'A new message arrived in this conversation. Read it, then press Send again.'

type Kept = StandInThread & { messages: StandInMessage[] }

export function standInInbox(
  contactsIn: StandInContact[],
  threadsIn: StandInThread[],
  options: { delayMs?: number; page?: number; seeing?: (address: string) => MailScope | null; drafts?: StandInDraft[]; slowMs?: number; now?: () => number; withReading?: boolean; withFiles?: boolean; views?: Partial<StandInViewState>; clients?: StandInClients; zone?: string } = {},
): StandInInbox {
  const asked: StandInInbox['asked'] = { scopes: [], searches: [], askers: [], histories: [], reads: [], sends: [], closes: [], reopens: [], edits: [], spam: [], settled: [], marked: [], unmarked: [], opened: [] }
  const fileReads: StandInInbox['fileReads'] = []
  const pictureWrites: StandInInbox['pictureWrites'] = []
  const sent: InboxSend[] = []
  const reached: StandInInbox['reached'] = []
  const script: StandInInbox['script'] = { send: [] }
  const now = options.now ?? Date.now
  // The contacts are kept as the inbox keeps them: a merge moves addresses between them and deletes one, so they are this stand-in's own copies.
  const contacts: StandInContact[] = contactsIn.map((c) => ({ ...c, addresses: [...c.addresses] }))
  const byId = new Map(contacts.map((c) => [c.id, c]))
  /** A Client's name as the Clients show it now (renamed in Settings, it is renamed in a pill), else the name the contact was given. */
  const nameOfClient = (c: { id: number; name: string }): string => options.clients?.state.clients.find((k) => k.number === c.id)?.name ?? c.name
  const refreshContacts = () => {
    byId.clear()
    for (const c of contacts) byId.set(c.id, c)
  }
  // The threads are kept as the inbox keeps them: each with its messages, and a position (how many there are) that a reply and a read name.
  const threads: Kept[] = threadsIn.map((t) => ({
    ...t,
    on: [...t.on],
    messages: t.messages ?? [{ id: `${t.id}-m1`, at: t.at, direction: t.direction ?? 'in', from: t.direction === 'out' ? 'Tessa' : (byId.get(t.on[0] as string)?.name ?? 'Someone'), text: t.snippet }],
  }))
  const drafts = (options.drafts ?? []).map((d) => ({ ...d }))
  const keys = new Map<string, { state: 'done'; sent: InboxSent } | { state: 'in-progress' }>()
  const views = standInViews(options.views, {
    now,
    ...(options.clients && {
      clients: {
        list: () => options.clients?.state.clients ?? [],
        person: (id: string) => (byId.get(id) ? { name: (byId.get(id) as StandInContact).name, addresses: [...(byId.get(id) as StandInContact).addresses] } : undefined),
      },
    }),
  })
  const turns = new Map<string, InboxChatTurn[]>()
  /** The drafts that were marked sent by hand, so that "Not sent after all" can put the draft back as it was. */
  const handSent = new Map<string, StandInDraft>()
  /** The drafts that are no longer drafts (sent, or marked sent) and the person and conversation each now sits on: where a link made while it was a draft opens. */
  const filed = new Map<string, { contactId: string; conversationId: string }>()
  const { merges: _merges, ...contactMethods } = standInPeople(contacts, threads, views, refreshContacts)

  const party = (id: string): InboxParty => ({ contactId: id, name: byId.get(id)?.name ?? id, address: byId.get(id)?.addresses[0] ?? null })
  const newest = (t: Kept) => t.messages.reduce((a, b) => (b.at >= a.at ? b : a))
  const through = (t: Kept) => t.messages.length
  /**
   * What the inbox adds to a message about how its page reads it: `read` (the message's own fold, else the whole text) and, on one Tessa sent, `to` (the
   * person whose history it is on). Only with `withReading`: left off, the stand-in is an inbox that predates both fields.
   */
  const readOf = (m: StandInMessage, person: StandInContact): { read?: InboxRead; to?: string } =>
    options.withReading
      ? { read: m.read ?? { visible: m.text, quoted: '' }, ...(m.direction === 'out' && (m.to ?? person.addresses[0]) !== undefined && { to: m.to ?? person.addresses[0] }) }
      : {}
  /**
   * What the inbox adds about a message's files and how it was delivered. Only with `withFiles`: left off, the stand-in is an inbox that predates both, and a
   * thread's `canAttach` is left out too. A message in a business mailbox's thread can be saved from; one in Tessa's Gmail only shows its pictures.
   */
  const filesOf = (m: StandInMessage, t: Kept): { attachments?: InboxAttachment[]; delivery?: InboxDeliveryNote[] } => {
    if (!options.withFiles) return {}
    const download = t.mailbox != null
    return {
      ...(m.files !== undefined &&
        m.files.length > 0 && {
          attachments: m.files.map((f) =>
            f.note !== undefined
              ? { name: f.name, size: f.size ?? f.bytes.length, type: f.type, picture: false, download: false, note: f.note }
              : {
                  name: f.name,
                  size: f.bytes.length,
                  type: f.type,
                  picture: PICTURE_TYPES.includes(f.type) && !m.tooLarge,
                  download: download && !m.tooLarge,
                  ...(m.tooLarge && { tooLarge: true }),
                  ...(f.play === true && { play: true }),
                  ...(f.video === true && { video: true }),
                  ...(f.seconds !== undefined && { seconds: f.seconds }),
                },
          ),
        }),
      ...(m.delivery !== undefined && m.delivery.length > 0 && { delivery: m.delivery }),
    }
  }
  /** The contact a list puts the thread under among `among` (the contacts on it, or one Client's): the stand-in's `listedUnder` if it is among them, else the one whose name wrote the newest message that came in, else the first. */
  const listedAmong = (t: Kept, among: string[]): string | undefined => {
    if (t.listedUnder !== undefined && among.includes(t.listedUnder)) return t.listedUnder
    const lastIn = [...t.messages].filter((m) => m.direction === 'in').sort((a, b) => b.at - a.at)[0]
    return among.find((id) => byId.get(id)?.name === lastIn?.from) ?? among[0]
  }
  const listedInClient = (t: Kept, contactId: string): boolean => {
    const client = byId.get(contactId)?.client?.id
    return client === undefined || listedAmong(t, t.on.filter((id) => byId.get(id)?.client?.id === client)) === contactId
  }
  /** Tessa's newest sent message on a thread: what the Sent view shows a thread as of; undefined when he sent none. */
  const newestSent = (t: Kept) => t.messages.filter((m) => m.direction === 'out').reduce<StandInMessage | undefined>((a, b) => (a === undefined || b.at >= a.at ? b : a), undefined)
  const line = (t: Kept, contactId: string, sentView = false): InboxThreadLine => {
    const last = (sentView ? newestSent(t) : undefined) ?? newest(t)
    return {
      conversationId: t.id,
      subject: t.subject,
      kind: t.kind ?? 'email',
      at: last.at,
      // A group's row says who wrote the newest message before its words, as the inbox's store does (`groupSnippet`).
      snippet: t.telegramChat === 'group' && last.direction === 'in' && last.from.trim() !== '' && last.text !== '' ? `${last.from.trim().split(/\s+/)[0]}: ${last.text}` : last.text === '' && last.calendar !== undefined ? summaryLine(last.calendar, options.zone ?? 'America/Los_Angeles') : last.text,
      direction: last.direction,
      unread: t.unread ?? false,
      open: t.open ?? true,
      bulk: t.bulk ?? false,
      drafts: drafts.filter((d) => d.conversationId === t.id).length,
      mailbox: t.mailbox ?? null,
      alsoOn: t.on.filter((o) => o !== contactId).map(party),
      listed: listedAmong(t, t.on) === contactId,
      listedInClient: listedInClient(t, contactId),
      ...(t.telegramChat !== undefined && { telegramChat: t.telegramChat }),
      ...(t.telegramChat === 'group' && { needsReply: t.needsReply ?? false }),
    }
  }
  /** What the person asking may see (`options.seeing`, the real rule `canSee` over each thread's mailbox): everything where the stand-in has none; null is a person on no mailbox, who is refused. */
  const seen = (asker: SignedIn): MailScope | null => (options.seeing ? options.seeing(asker.person.address) : { mailboxIds: null, unfiled: true })
  const visibleTo = (mail: MailScope) => (t: Kept) => canSee(mail, t.mailbox?.id ?? null)
  const inScopeFor = (scope?: Pick<InboxScope, 'include' | 'sent' | 'drafts'>) => {
    // The Sent view: every thread Tessa sent in, whatever state it is in.
    if (scope?.sent === true) return threads.filter((t) => newestSent(t) !== undefined)
    // The Drafts view: every thread with a draft waiting on it, whatever state it is in.
    if (scope?.drafts === true) return threads.filter((t) => drafts.some((d) => d.conversationId === t.id))
    const include = new Set(scope?.include ?? [])
    // The inbox's own main list: open and not Bulk, of every mailbox; Bulk and Closed come only when asked.
    return threads.filter((t) => ((t.open ?? true) ? !(t.bulk ?? false) || include.has('bulk') : include.has('closed')))
  }
  const wait = () => (options.delayMs ? new Promise((r) => setTimeout(r, options.delayMs)) : undefined)

  /**
   * A new email, as the inbox files one: the inbox's own refusals first (no subject, no words, an em dash, an address of ours, files from Gmail), then the mailbox it goes
   * out from (the one chosen; with none chosen the one the person last wrote to, else Gmail), a contact if the address is new, and a conversation of its own that the sender
   * has already closed, which is why it is in the person's history and not in the main list.
   */
  const newEmail = (send: Extract<InboxSend, { address: string }>): { id: string } | { refusal: SpaceReply<never> } => {
    const subject = send.subject.trim()
    const words = send.text.trim()
    if (subject === '') return { refusal: refused('bad-request', 'Add a subject before sending.') }
    if (words === '') return { refusal: refused('bad-request', 'There is nothing in the body to send.') }
    if ((subject + words).includes('\u2014')) return { refusal: refused('bad-request', 'Remove the em dash from the subject and body before sending: it reads as machine-written.') }
    if (OWN_ADDRESSES.includes(send.address)) return { refusal: refused('bad-request', `${send.address} is your own address, so it would arrive in your own mailbox. Take it off the draft.`) }
    let contact = contacts.find((c) => c.addresses.includes(send.address))
    // A mailbox on the mail server is a business mailbox to a person: chosen the same way, while the server takes the space's key; it takes no files.
    const onServer = (id: string) => views.state.jmap?.find((m) => m.id === id && m.declared && m.state !== 'refused')
    const ours = (id: string): InboxMailbox | undefined => views.state.mailboxes.find((m) => m.id === id) ?? onServer(id)
    let mailbox: InboxMailbox | null
    if (send.from?.kind === 'business') {
      const chosen = ours(send.from.mailboxId)
      if (!chosen) return { refusal: refused('bad-request', 'That is not one of the business mailboxes this inbox sends from. Nothing was drafted.') }
      mailbox = mailboxMark(chosen)
    } else if (send.from?.kind === 'gmail') {
      if (send.from.mailboxId !== undefined && !views.state.gmailAccounts.some((g) => g.id === (send.from as { mailboxId?: string }).mailboxId)) {
        return { refusal: refused('bad-request', 'That is not one of the Gmail accounts connected to this inbox. Nothing was drafted.') }
      }
      mailbox = null
    } else {
      const wrote = threads.filter((t) => contact !== undefined && t.on.includes(contact.id)).flatMap((t) => t.messages.filter((m) => m.direction === 'in').map((m) => ({ at: m.at, mailbox: t.mailbox ?? null })))
      mailbox = wrote.sort((a, b) => b.at - a.at)[0]?.mailbox ?? null
    }
    const files = (send.attachments ?? []).map((f) => ({ name: f.name, type: f.type, bytes: f.bytes }))
    if (files.length > 0 && mailbox !== null && onServer(mailbox.id)) return { refusal: refused('bad-request', 'Files cannot be sent from a mailbox on the mail server yet. Nothing was sent.') }
    if (files.length > 0 && mailbox === null) return { refusal: refused('bad-request', 'Files can be sent from a business mailbox only (Ridgeway’s, ShiftLantern’s or quill.example’s), not from Tessa’s Gmail. Nothing was sent.') }
    if (!contact) {
      contact = { id: `c-new-${contacts.length + 1}`, name: send.name?.trim() || send.address, addresses: [send.address] }
      contacts.push(contact)
      refreshContacts()
    }
    const id = `new-${sent.length + 1}`
    const at = now()
    threads.push({ id, subject, kind: 'email', at, snippet: words, direction: 'out', unread: false, open: false, bulk: false, mailbox, on: [contact.id], messages: [{ id: `${id}-s1`, at, direction: 'out', from: 'Tessa', text: words, to: send.address, ...(files.length > 0 && { files }) }] })
    return { id }
  }
  const order = (a: { id: string; at: number }, b: { id: string; at: number }) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const draftView = (d: StandInDraft): InboxDraft => {
    const c = byId.get(d.contactId)
    const listed = { id: d.id, conversationId: d.conversationId, contactId: d.contactId, toName: c?.name ?? d.contactId, to: d.to ?? c?.addresses[0] ?? '', subject: d.subject, text: d.text, rev: d.rev ?? 1, author: d.author ?? 'claude', stuck: d.stuck ?? false, at: d.at, why: d.why ?? '', editedBy: d.editedBy ?? null, canCopyEveryone: d.conversationId !== null && (d.kind ?? 'email') === 'email', ...(d.kind !== undefined && { kind: d.kind }), ...(d.sentFrom !== undefined && { sentFrom: d.sentFrom }), ...(d.sendsFrom !== undefined && { sendsFrom: d.sendsFrom }), ...(d.refusal !== undefined && { refusal: d.refusal }), ...(d.picture !== undefined && { picture: { type: d.picture.type, size: d.picture.bytes.length } }) }
    // A draft with `cc: null` is answered as an inbox that predates the field would: without it.
    return d.cc === null ? (listed as InboxDraft) : { ...listed, cc: d.cc ?? [] }
  }

  return {
    ...views.methods,
    ...contactMethods,
    views,
    asked,
    fileReads,
    pictureWrites,
    sent,
    reached,
    script,
    threads: () => threads,
    // The operator's three, for the move of the inbox's store: nothing is stored, so the stand-in answers in the shapes the real ones do.
    async storeBookmark(asker: SignedIn) {
      asked.askers.push(asker.person.address)
      return answered({ bookmark: '00000001-00000002-00000003-' + 'a'.repeat(32) })
    },
    async restartStore(asker: SignedIn) {
      asked.askers.push(asker.person.address)
      return answered({ restarted: true as const })
    },
    async storeCounts(asker: SignedIn) {
      asked.askers.push(asker.person.address)
      return answered({ counts: { message: 0, contact: 0 } })
    },
    async navigation(asker: SignedIn) {
      asked.askers.push(asker.person.address)
      views.calls.push({ method: 'navigation', args: [], asker })
      await wait()
      const step = views.script.shift()
      if (step === 'throw') throw new Error('stand-in inbox lost the connection')
      if (step === 'hang') return new Promise(() => undefined)
      if (step === 'broken') return failed('The inbox could not answer that. Nothing was changed.')
      // The menu is counted from the threads this stand-in holds, as the real inbox counts its own: rows, one per person on them, not conversations.
      const open = threads.filter((t) => t.open ?? true)
      const plain = open.filter((t) => !(t.bulk ?? false))
      const people = (list: Kept[]) => new Set(list.flatMap((t) => t.on))
      const count = (list: Kept[]) => ({ count: people(list).size, unread: people(list.filter((t) => t.unread)).size })
      const clientIdsOf = (t: Kept) => t.on.flatMap((id) => (byId.get(id)?.client ? [byId.get(id)?.client?.id as number] : []))
      // The menu leaves out an archived Client, as the real inbox does; a Client only a contact holds is named by its number's name there.
      const known = new Map(views.clientList().filter((c) => !c.summary.archived).map((c) => [c.summary.id, { id: c.summary.id, name: c.summary.name, listed: c.summary.listed }]))
      const archivedIds = new Set(views.clientList().filter((c) => c.summary.archived).map((c) => c.summary.id))
      for (const c of contacts) if (c.client && !known.has(c.client.id) && !archivedIds.has(c.client.id)) known.set(c.client.id, { id: c.client.id, name: c.client.name, listed: true })
      const gmailAccounts = views.state.gmailAccounts
      return answered({
        views: { inbox: count(plain), unread: { count: count(plain.filter((t) => t.unread)).count, unread: 0 }, drafts: { count: new Set(drafts.map((d) => d.contactId)).size, unread: 0 }, bulk: count(open.filter((t) => t.bulk ?? false)), closed: count(threads.filter((t) => !(t.open ?? true))) },
        mailboxes: views.state.mailboxes.map((m) => ({ id: m.id, name: m.name, address: m.address, ...count(plain.filter((t) => t.mailbox?.id === m.id)), lastArrivalAt: m.lastArrivalAt, reason: m.reasons[0] ?? null })),
        clients: [...known.values()].map((c) => ({ ...c, ...count(plain.filter((t) => clientIdsOf(t).includes(c.id))) })).sort((a, b) => Number(b.listed) - Number(a.listed) || a.name.localeCompare(b.name)),
        contacts: contacts.length,
        gmailAccounts: gmailAccounts.map((g) => ({ id: g.id, name: g.name, address: g.address, connected: g.connected, state: g.state, lastPushAt: g.lastPushAt, reason: g.reasons[0] ?? null })),
        // The Telegram mailbox, counted from its threads as a business mailbox's are; null while the stand-in holds none.
        ...(views.state.jmap !== undefined && { jmap: views.state.jmap.map((m) => ({ id: m.id, name: m.name, address: m.address, ...count(plain.filter((t) => t.mailbox?.id === m.id)), state: m.state, lastSyncAt: m.lastSyncAt, reason: m.reasons[0] ?? null })) }),
        ...(views.state.telegram !== undefined && { telegram: views.state.telegram === null ? null : { id: views.state.telegram.id, name: views.state.telegram.name, address: views.state.telegram.address, ...count(plain.filter((t) => t.mailbox?.id === views.state.telegram?.id)), state: views.state.telegram.state, checkedInAt: views.state.telegram.checkedInAt, lastPushAt: views.state.telegram.lastPushAt } }),
      })
    },
    async draftChat(asker: SignedIn, conversationId: string, draftId: string) {
      asked.askers.push(asker.person.address)
      views.calls.push({ method: 'draftChat', args: [conversationId, draftId], asker })
      return drafts.some((d) => d.id === draftId && d.conversationId === conversationId) ? answered(turns.get(draftId) ?? []) : refused('not-found', 'No such draft.')
    },
    async chat(asker: SignedIn, chat) {
      asked.askers.push(asker.person.address)
      views.calls.push({ method: 'chat', args: [chat], asker })
      await wait()
      const step = views.script.shift()
      if (step === 'throw') throw new Error('stand-in inbox lost the connection')
      if (step === 'hang') return new Promise(() => undefined)
      if (step === 'broken') return failed('The assistant has no key to call the model with, so it cannot chat.')
      const draft = drafts.find((d) => d.id === chat.draftId && d.conversationId === chat.conversationId)
      if (!draft) return refused('not-found', 'No such draft.')
      if ((draft.rev ?? 1) !== chat.rev) return refused('conflict', 'This draft was changed since you saw it.')
      // The stand-in's "assistant": it shortens a draft when asked to, and otherwise only answers.
      const shorter = /short/i.test(chat.instruction)
      const kept = turns.get(draft.id) ?? []
      const revised = shorter && draft.text.includes('\n\n')
      const turn: InboxChatTurn = {
        seq: kept.length + 1,
        at: now(),
        instruction: chat.instruction,
        note: revised ? 'Cut it to the first paragraph.' : shorter ? 'It is one paragraph already, so I left it as it is.' : 'The draft already says that. I left it as it is.',
        revised,
      }
      if (turn.revised) {
        draft.text = draft.text.split('\n\n')[0] as string
        draft.rev = (draft.rev ?? 1) + 1
        draft.author = 'assistant'
      }
      turns.set(draft.id, [...kept, turn])
      return answered({ draftId: draft.id, rev: draft.rev ?? 1, text: draft.text, subject: draft.subject, turn })
    },
    arrive(threadId, message) {
      const t = threads.find((x) => x.id === threadId)
      if (!t) throw new Error(`no thread ${threadId}`)
      t.messages.push(message)
      t.unread = true
    },
    async people(asker: SignedIn, scope?: InboxScope): Promise<SpaceReply<InboxPeople>> {
      asked.scopes.push(scope)
      asked.askers.push(asker.person.address)
      await wait()
      const mail = seen(asker)
      if (mail === null) return refused('not-admitted', 'The Inbox is not open to you.')
      const all = inScopeFor(scope).filter(visibleTo(mail))
      // `options.page` is the screen the real inbox cuts a list at (QUEUE_PAGE): the newest threads in scope, with `more` when there were others. Left out: no cut.
      const page = options.page
      const cut = page !== undefined && all.length > page
      const inScope = page === undefined ? all : [...all].sort((a, b) => newest(b).at - newest(a).at).slice(0, page)
      const only = scope?.addresses ? new Set(scope.addresses) : null
      const ids = scope?.contactIds ? new Set(scope.contactIds) : null
      const people: InboxPerson[] = []
      for (const c of contacts) {
        if ((only || ids) && !(only && c.addresses.some((a) => only.has(a))) && !(ids && ids.has(c.id))) continue
        const lines = inScope
          .filter((t) => t.on.includes(c.id))
          .map((t) => line(t, c.id, scope?.sent === true))
          .sort((a, b) => b.at - a.at)
        const first = lines[0]
        if (!first) continue
        people.push({
          contactId: c.id,
          name: c.name,
          addresses: [...c.addresses].sort(),
          client: c.client ? { ...c.client, name: nameOfClient(c.client), listed: true } : null,
          ...(c.suggested && !c.client && { suggestedClient: { ...c.suggested, name: nameOfClient(c.suggested), listed: true } }),
          newest: { conversationId: first.conversationId, at: first.at, kind: first.kind, direction: first.direction, subject: first.subject, snippet: first.snippet },
          unread: lines.filter((l) => l.unread).length,
          conversations: lines,
        })
      }
      people.sort((a, b) => b.newest.at - a.newest.at)
      return answered({ people, more: cut })
    },
    async search(asker: SignedIn, query: string): Promise<SpaceReply<InboxSearch>> {
      asked.searches.push(query)
      asked.askers.push(asker.person.address)
      await wait()
      const mail = seen(asker)
      if (mail === null) return refused('not-admitted', 'The Inbox is not open to you.')
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = threads
        .filter(visibleTo(mail))
        .filter((t) => terms.every((w) => `${t.subject} ${newest(t).text}`.toLowerCase().includes(w)))
        .sort((a, b) => newest(b).at - newest(a).at)
        .map((t) => ({
          conversationId: t.id,
          subject: t.subject,
          kind: t.kind ?? 'email',
          at: newest(t).at,
          snippet: newest(t).text,
          match: newest(t).text,
          unread: t.unread ?? false,
          open: t.open ?? true,
          bulk: t.bulk ?? false,
          mailbox: t.mailbox ?? null,
          // The person the lists put it under leads, as the inbox's search does.
          people: [...t.on].sort((a, b) => Number(b === listedAmong(t, t.on)) - Number(a === listedAmong(t, t.on))).map(party),
        }))
      return answered({ terms, hits, more: false })
    },

    async attachment(asker: SignedIn, messageId: string, index: number, how: 'view' | 'download', range?: FileRange): Promise<SpaceReply<InboxFileOut>> {
      asked.askers.push(asker.person.address)
      fileReads.push({ messageId, index, how, ...(range && { range }) })
      await wait()
      // The picture a Telegram draft carries is the owner's to see on its card: read as a file of the draft's own id.
      const carried = drafts.find((d) => d.id === messageId)?.picture
      if (carried !== undefined) {
        return index === 0 && how === 'view' ? answered({ name: carried.name, type: carried.type, inline: true, bytes: carried.bytes }) : refused('not-found', 'No such attachment.')
      }
      const thread = threads.find((t) => t.messages.some((m) => m.id === messageId))
      const file = thread?.messages.find((m) => m.id === messageId)?.files?.[index]
      if (!thread || !file) return refused('not-found', 'No such attachment.')
      const picture = PICTURE_TYPES.includes(file.type)
      if (file.note !== undefined) return refused('not-found', 'That file stays in Telegram.')
      // A voice note or a video is read in parts, as the inbox reads one: the part asked for, cut to a part's size, or the whole file when it is small and no range was asked.
      const parted = (type: string, inline = true): InboxFileOut => {
        const total = file.bytes.length
        const want = range ? resolveByteRange(range, total) : total > INBOX_FILE_WHOLE_BYTES ? { first: 0, last: total - 1 } : null
        if (want === null) return { name: file.name, type, inline, bytes: file.bytes }
        if (want === 'unsatisfiable') return { name: file.name, type, inline, bytes: new Uint8Array(0), total, unsatisfiable: true }
        const last = Math.min(want.last, want.first + INBOX_FILE_PART_BYTES - 1)
        return { name: file.name, type, inline, bytes: file.bytes.slice(want.first, last + 1), total, part: { first: want.first, last } }
      }
      if (how === 'view' && file.play === true) return answered(parted('audio/ogg'))
      if (how === 'view' && file.video === true) return answered(parted(file.type))
      if (how === 'view') {
        return picture ? answered({ name: file.name, type: file.type, inline: true, bytes: file.bytes }) : refused('bad-request', 'This attachment is not a PNG, JPEG, GIF or WebP picture, so the inbox does not show it.')
      }
      if (thread.mailbox == null) return refused('bad-request', 'This attachment opens in Gmail.')
      return answered(file.play === true || file.video === true ? parted('application/octet-stream', false) : { name: file.name, type: 'application/octet-stream', inline: false, bytes: file.bytes })
    },

    async messagesWith(asker: SignedIn, who: InboxWho, query?: InboxHistoryQuery): Promise<SpaceReply<InboxHistory>> {
      asked.askers.push(asker.person.address)
      asked.histories.push({ who, query })
      await wait()
      const contact = 'contactId' in who ? byId.get(who.contactId) : contacts.find((c) => c.addresses.includes(who.address))
      if (!contact) return refused('not-found', 'No such person.')
      const mine = inScopeFor({ include: query?.include }).filter((t) => t.on.includes(contact.id))
      const all = mine.flatMap((t) => t.messages.map((m) => ({ ...m, conversationId: t.id, subject: t.subject, on: t.on }))).sort(order)
      let end = all.length
      if (query?.before !== undefined) {
        end = all.findIndex((m) => m.id === query.before)
        if (end < 0) return refused('bad-request', 'That message is not on this person’s conversations.')
      }
      const start = Math.max(0, end - INBOX_HISTORY_PAGE)
      return answered({
        threads: mine
          .map((t) => ({ t, last: newest(t).at }))
          .sort((a, b) => b.last - a.last)
          .map(({ t }) => ({
            conversationId: t.id,
            subject: t.subject,
            kind: t.kind ?? 'email',
            through: through(t),
            unread: t.unread ?? false,
            open: t.open ?? true,
            bulk: t.bulk ?? false,
            mailbox: t.mailbox ?? null,
            alsoOn: t.on.filter((o) => o !== contact.id).map(party),
            // A Telegram chat is answered through the bridge, a channel never.
            canReply: (t.kind ?? 'email') === 'email' || (t.kind === 'telegram' && t.telegramChat !== 'channel'),
            // The inbox's own rule for the spam button: in a mailbox, and in Bulk or with nobody on it linked to a Client.
            canMarkSpam: (t.kind ?? 'email') === 'email' && ((t.bulk ?? false) || !t.on.some((id) => byId.get(id)?.client)),
            ...(t.telegramChat !== undefined && { telegramChat: t.telegramChat }),
            ...(options.withFiles && { canAttach: (t.kind ?? 'email') === 'email' && t.mailbox != null }),
            // A Telegram chat with a person or a group that has a reply box takes one picture.
            ...(options.withFiles && t.kind === 'telegram' && t.telegramChat !== 'channel' && { canPicture: true }),
          })),
        messages: all.slice(start, end).map((m) => ({ id: m.id, conversationId: m.conversationId, subject: m.subject, direction: m.direction, at: m.at, from: m.from, text: m.text, textCut: false, ...readOf(m, contact), ...filesOf(m, threads.find((t) => t.id === m.conversationId) as Kept), ...(m.calendar !== undefined && { calendar: { ...m.calendar, fromYou: m.calendar.organizer?.address === 'tessa@northfield.example' } }), ...(m.sentByHand === true && { sentByHand: true }), ...(m.edited === true && { edited: true }), ...(m.deleted === true && { deleted: true }), alsoOn: m.on.filter((o) => o !== contact.id).map(party) })),
        more: start > 0,
      })
    },

    async drafts(asker: SignedIn): Promise<SpaceReply<InboxDraft[]>> {
      asked.askers.push(asker.person.address)
      await wait()
      const mail = seen(asker)
      if (mail === null) return refused('not-admitted', 'The Inbox is not open to you.')
      return answered(drafts.filter((d) => d.conversationId === null || (threads.find((t) => t.id === d.conversationId) ?? null) === null || visibleTo(mail)(threads.find((t) => t.id === d.conversationId) as Kept)).map(draftView))
    },

    // Where one draft's link opens: the draft as it stands, or the conversation it was filed on once sent or marked sent. A draft that is gone is not found.
    async draftAt(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxDraftAt>> {
      asked.askers.push(asker.person.address)
      asked.opened.push(draftId)
      await wait()
      const draft = drafts.find((d) => d.id === draftId)
      if (draft) return answered({ state: 'draft', draft: draftView(draft) })
      const home = filed.get(draftId)
      return home ? answered({ state: 'filed', ...home }) : refused('not-found', 'No such message.')
    },

    // The inbox's own draft edit: the revision shown is required, a draft changed since is refused with nothing saved, a body cannot be blanked, and a message that is not a draft is not edited.
    async editDraft(asker: SignedIn, edit: InboxDraftEdit): Promise<SpaceReply<InboxDraft>> {
      asked.askers.push(asker.person.address)
      asked.edits.push(edit)
      await wait()
      const draft = drafts.find((d) => d.id === edit.draftId)
      if (!draft) return refused('not-found', 'No such message.')
      if (draft.stuck) return refused('conflict', 'Only a draft can be edited.')
      if ((draft.rev ?? 1) !== edit.rev) return refused('conflict', CHANGED_WORDS)
      const text = edit.text === undefined ? draft.text : edit.text.trim()
      // A picture on the draft is what lets its words be none; taken out in this very edit it is no longer there to speak for itself.
      if (text === '' && (draft.picture === undefined || edit.takeOutPicture === true)) return refused('bad-request', 'A draft needs a body.')
      if (edit.takeOutPicture === true) delete draft.picture
      if (edit.copyEveryone !== undefined && draft.conversationId === null) return refused('bad-request', 'This draft is not on an email conversation, so there is nobody to copy.')
      if (edit.subject !== undefined) draft.subject = edit.subject.trim()
      if (edit.copyEveryone !== undefined) {
        const on = threads.find((t) => t.id === draft.conversationId)?.on ?? []
        draft.cc = edit.copyEveryone ? on.filter((id) => id !== draft.contactId).map((id) => ({ name: byId.get(id)?.name ?? id, address: byId.get(id)?.addresses[0] ?? '' })) : []
      }
      draft.editedBy = (draft.author ?? 'claude') === 'owner' ? null : 'owner'
      draft.text = text
      draft.rev = (draft.rev ?? 1) + 1
      return answered(draftView(draft))
    },

    // Put ONE picture on a Telegram draft, or replace the one it has, at the revision shown: a PNG or a JPEG by its first bytes, an edit of the draft (the revision rises).
    async putDraftPicture(asker: SignedIn, put: InboxDraftPicture): Promise<SpaceReply<InboxDraft>> {
      asked.askers.push(asker.person.address)
      pictureWrites.push({ draftId: put.draftId, rev: put.rev, name: put.picture.name, size: put.picture.bytes.length })
      await wait()
      const draft = drafts.find((d) => d.id === put.draftId)
      if (!draft) return refused('not-found', 'No such message.')
      if (draft.kind !== 'telegram' || draft.stuck) return refused('bad-request', 'A picture goes on a draft in a Telegram chat only.')
      if ((draft.rev ?? 1) !== put.rev) return refused('conflict', CHANGED_WORDS)
      const type = sniffPicture(put.picture.bytes)
      if (type === null) return refused('bad-request', 'A picture goes on Telegram as a PNG or a JPEG. This is neither. Nothing was changed.')
      draft.picture = { name: put.picture.name, type, bytes: put.picture.bytes }
      draft.editedBy = (draft.author ?? 'claude') === 'owner' ? null : 'owner'
      draft.rev = (draft.rev ?? 1) + 1
      return answered(draftView(draft))
    },

    // The inbox's own `resolve-send`: only a send Gmail never confirmed can be settled; "went out" removes it, "did not" makes it a draft again.
    async resolveSend(asker: SignedIn, resolution: InboxSendResolution): Promise<SpaceReply<InboxSendResolved>> {
      asked.askers.push(asker.person.address)
      asked.settled.push(resolution)
      await wait()
      const draft = drafts.find((d) => d.id === resolution.draftId)
      if (!draft) return refused('not-found', 'No such message.')
      if (!draft.stuck) return refused('conflict', 'That message is not waiting on a send.')
      if (resolution.sent) drafts.splice(drafts.indexOf(draft), 1)
      else draft.stuck = false
      return answered({ id: draft.id, status: resolution.sent ? 'removed' : 'draft' })
    },

    // The inbox's own `mark-sent`: a text or a direct message draft is filed, sent by hand, on a conversation of the person's for its channel. An email is sent with Send.
    async markDraftSent(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxHandSent>> {
      asked.askers.push(asker.person.address)
      asked.marked.push(draftId)
      await wait()
      const draft = drafts.find((d) => d.id === draftId)
      if (!draft) return refused('not-found', 'No such message.')
      if (draft.stuck) return refused('conflict', 'Only a draft can be marked sent.')
      if ((draft.kind ?? 'email') === 'email') return refused('bad-request', 'An email is sent with Send. If you sent this one yourself in Gmail, it will arrive here by itself: delete this draft.')
      const kind = draft.kind as MailKind
      const home = threads.find((t) => t.on.includes(draft.contactId) && (t.kind ?? 'email') === kind) ?? (threads[threads.push({ id: `${draft.contactId}-${kind}`, subject: '', kind, at: now(), snippet: '', open: false, on: [draft.contactId], messages: [] }) - 1] as Kept)
      home.messages.push({ id: draft.id, at: now(), direction: 'out', from: 'Tessa', text: draft.text, sentByHand: true })
      home.unread = false
      home.open = false
      drafts.splice(drafts.indexOf(draft), 1)
      handSent.set(draft.id, draft)
      filed.set(draft.id, { contactId: draft.contactId, conversationId: home.id })
      return answered({ messageId: draft.id, conversationId: home.id })
    },

    // The inbox's own `unmark-sent`: "Not sent after all". Only a message marked sent by hand goes back to being a draft.
    async unmarkSent(asker: SignedIn, messageId: string): Promise<SpaceReply<InboxHandSent>> {
      asked.askers.push(asker.person.address)
      asked.unmarked.push(messageId)
      await wait()
      const home = threads.find((t) => t.messages.some((m) => m.id === messageId))
      const message = home?.messages.find((m) => m.id === messageId)
      if (!home || !message) return refused('not-found', 'No such message.')
      if (message.sentByHand !== true) return refused('conflict', 'Only a message marked sent by hand can be unmarked.')
      // A message filed before this run (a fixture) has no draft kept: it becomes one of the same words, to the same person, on the same channel.
      const draft: StandInDraft = handSent.get(messageId) ?? { id: message.id, conversationId: home.id, contactId: home.on[0] as string, subject: '', text: message.text, author: 'owner', kind: home.kind ?? 'manual', at: message.at }
      home.messages.splice(home.messages.indexOf(message), 1)
      handSent.delete(messageId)
      filed.delete(messageId)
      drafts.push(draft)
      return answered({ messageId, conversationId: home.id })
    },

    // The inbox's own Mark as spam and Move to the Inbox: a conversation in a mailbox moves to Bulk and back; a text or a note has no mailbox to call it in. A Client's people are never Bulk.
    async setSpam(asker: SignedIn, mark: InboxSpamMark): Promise<SpaceReply<InboxSpamResult>> {
      asked.askers.push(asker.person.address)
      asked.spam.push(mark)
      await wait()
      const t = threads.find((x) => x.id === mark.conversationId)
      if (!t) return refused('not-found', 'No such conversation.')
      if ((t.kind ?? 'email') !== 'email') return refused('bad-request', 'Only a conversation in a mailbox can be moved to Bulk or back.')
      const client = t.on.some((id) => byId.get(id)?.client)
      t.bulk = mark.spam && !client
      const reasons = [mark.spam ? 'Tessa moved it to Bulk.' : 'Tessa moved it back to the Inbox.', ...(mark.spam && client ? ['Kept in the Inbox: a Client’s contact is on it.'] : [])]
      return answered({ conversationId: t.id, spam: mark.spam, bulk: t.bulk, reasons })
    },

    async send(asker: SignedIn, send: InboxSend): Promise<WriteReply<InboxSent>> {
      asked.askers.push(asker.person.address)
      asked.sends.push(send)
      const held = keys.get(send.key)
      if (held) return repeated<InboxSent>(held.state === 'done' ? { state: 'done', reply: answered(held.sent) } : { state: 'in-progress' })
      const step = script.send.shift()
      if (step === 'conflict') return refused('conflict', CONFLICT_WORDS)
      if (step === 'broken') return failed('Gmail would not take the message. Nothing was sent.')
      if (step === 'throw') throw new Error('stand-in inbox lost the connection')
      if (step === 'hang') return new Promise(() => undefined)

      keys.set(send.key, { state: 'in-progress' })
      const release = () => void keys.delete(send.key)
      if (step === 'slow') await new Promise((r) => setTimeout(r, options.slowMs ?? 30))

      let conversationId: string
      let telegramSend = false
      if ('draftId' in send) {
        const draft = drafts.find((d) => d.id === send.draftId)
        if (!draft) {
          release()
          return refused('not-found', 'No such message.')
        }
        if ((draft.rev ?? 1) !== send.rev) {
          release()
          return refused('conflict', 'This draft was changed since you saw it.')
        }
        const thread = draft.conversationId === null ? undefined : threads.find((t) => t.id === draft.conversationId)
        if (thread && send.through !== through(thread)) {
          release()
          return refused('conflict', CONFLICT_WORDS)
        }
        // A first email to someone with no conversation makes one, filed read and closed as the inbox files a new email Tessa sends.
        const target =
          thread ??
          threads.find((t) => t.on.includes(draft.contactId)) ??
          (threads[threads.push({ id: `${draft.contactId}-first`, subject: draft.subject, at: now(), snippet: draft.text, open: false, on: [draft.contactId], messages: [] }) - 1] as Kept)
        conversationId = target.id
        telegramSend = target.kind === 'telegram'
        // A draft that carries a picture goes out with it, as the inbox sends it: the picture is the sent message's file (its words are the caption, or the words Telegram gives a picture alone).
        const carried = draft.picture
        target.messages.push({ id: `${target.id}-s${target.messages.length + 1}`, at: now(), direction: 'out', from: 'Tessa', text: carried && draft.text.trim() === '' ? '[Photo]' : draft.text, ...(carried && { files: [{ name: carried.name, type: carried.type, bytes: carried.bytes }] }) })
        filed.set(draft.id, { contactId: draft.contactId, conversationId })
        reached.push({ draftId: draft.id, to: byId.get(draft.contactId)?.addresses[0] ?? '', cc: (draft.cc ?? []).map((c) => c.address) })
        drafts.splice(drafts.indexOf(draft), 1)
      } else if ('conversationId' in send) {
        const thread = threads.find((t) => t.id === send.conversationId)
        if (!thread) {
          release()
          return refused('not-found', 'No such conversation.')
        }
        if (send.through !== through(thread)) {
          release()
          return refused('conflict', CONFLICT_WORDS)
        }
        // The inbox sends files from a business mailbox only, and says so rather than dropping them (its own refusal, in its words).
        // A Telegram chat that has a reply box takes ONE picture (a PNG or a JPEG, by its bytes), as the real inbox does; the stand-in checks the bytes' first marks the same way.
        const picture = thread.kind === 'telegram' && thread.telegramChat !== 'channel' && send.attachments?.length === 1
        if (picture && sniffPicture(send.attachments?.[0]?.bytes ?? new Uint8Array(0)) === null) {
          release()
          return refused('bad-request', 'A picture goes on Telegram as a PNG or a JPEG. This is neither, so nothing was sent.')
        }
        // Words are needed everywhere but under a picture, which can speak for itself (the real inbox refuses an empty body at the send; the page lets a file-carrying form through with none).
        if (send.text.trim() === '' && !picture) {
          release()
          return refused('bad-request', 'There is nothing in the body to send.')
        }
        if ((send.attachments?.length ?? 0) > 0 && thread.mailbox == null && !picture) {
          release()
          return refused('bad-request', 'Files can be sent from a business mailbox only (Ridgeway’s, ShiftLantern’s or quill.example’s), not from Tessa’s Gmail. Nothing was sent.')
        }
        conversationId = thread.id
        const files = (send.attachments ?? []).map((f) => ({ name: f.name, type: f.type, bytes: f.bytes }))
        thread.messages.push({ id: `${thread.id}-s${thread.messages.length + 1}`, at: now(), direction: 'out', from: 'Tessa', text: picture && send.text.trim() === '' ? '[Photo]' : send.text, ...(files.length > 0 && { files }) })
        thread.unread = false
        // The real inbox answers a Telegram send `sending` (the bridge sends it within seconds); the stand-in has the message in the history at once.
        telegramSend = thread.kind === 'telegram'
      } else {
        const made = newEmail(send)
        if ('refusal' in made) {
          release()
          return made.refusal
        }
        conversationId = made.id
      }
      sent.push(send)
      const done: InboxSent = { messageId: `sent-${sent.length}`, conversationId, status: step === 'sending' || telegramSend ? 'sending' : 'sent' }
      keys.set(send.key, { state: 'done', sent: done })
      return answered(done)
    },

    async markRead(asker: SignedIn, marks: readonly InboxReadMark[]): Promise<SpaceReply<InboxReadResult>> {
      asked.askers.push(asker.person.address)
      asked.reads.push([...marks])
      await wait()
      const read: string[] = []
      const notRead: InboxReadResult['notRead'] = []
      for (const m of marks) {
        const t = threads.find((x) => x.id === m.conversationId)
        if (!t) notRead.push({ conversationId: m.conversationId, outcome: refused('not-found', 'No such conversation.') })
        else if (m.through > through(t)) notRead.push({ conversationId: m.conversationId, outcome: refused('bad-request', 'That is past the end of the conversation.') })
        else if (m.through < through(t)) notRead.push({ conversationId: m.conversationId, outcome: refused('conflict', CONFLICT_WORDS) })
        else {
          t.unread = false
          read.push(t.id)
        }
      }
      return answered({ read, notRead })
    },

    // Close, as the inbox's own: refused (`conflict`) when mail came IN beyond the position read to (a reply of ours moves the position but is no reason to refuse), changed nowhere then.
    async closeConversations(asker: SignedIn, marks: readonly InboxCloseMark[]): Promise<SpaceReply<InboxCloseResult>> {
      asked.askers.push(asker.person.address)
      asked.closes.push([...marks])
      await wait()
      const closed: string[] = []
      const notClosed: InboxCloseResult['notClosed'] = []
      for (const m of marks) {
        const t = threads.find((x) => x.id === m.conversationId)
        if (!t) notClosed.push({ conversationId: m.conversationId, outcome: refused('not-found', 'No such conversation.') })
        else if (m.through > through(t)) notClosed.push({ conversationId: m.conversationId, outcome: refused('bad-request', 'That is past the end of the conversation.') })
        else if (t.messages.slice(m.through).some((x) => x.direction === 'in')) notClosed.push({ conversationId: m.conversationId, outcome: refused('conflict', 'A new message arrived on this conversation, so nothing was changed. It is shown now.') })
        else {
          t.open = false
          closed.push(t.id)
        }
      }
      return answered({ closed, notClosed })
    },

    async reopenConversations(asker: SignedIn, conversationIds: readonly string[]): Promise<SpaceReply<InboxReopenResult>> {
      asked.askers.push(asker.person.address)
      asked.reopens.push([...conversationIds])
      await wait()
      const reopened: string[] = []
      const notReopened: InboxReopenResult['notReopened'] = []
      for (const id of conversationIds) {
        const t = threads.find((x) => x.id === id)
        if (!t) notReopened.push({ conversationId: id, outcome: refused('not-found', 'No such conversation.') })
        else {
          t.open = true
          reopened.push(id)
        }
      }
      return answered({ reopened, notReopened })
    },
  }
}

// ── Meet ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A message in a direct message or channel; meet numbers its messages across the workspace, ascending. */
export interface StandInChatMessage {
  id: number
  at: number
  authorId: string
  authorName: string
  text: string
  mine?: boolean
  /** The call this message announces (a huddle started here). */
  huddle?: string
  /** When it was last edited, once it has been. */
  editedAt?: number
}

/** What the next `post` does instead of the normal thing: refused for rate (`limit`), failed (`broken`), the binding failing (`throw`), or never answering (`hang`). */
export type PostStep = 'limit' | 'throw' | 'hang' | 'broken'

export interface StandInMeet extends MeetForSpace {
  /** What the Worker's part answers (packages/meet/src/space-part.ts): the upgrade request or the dial pad's, for the person the space's check named. */
  fetch(request: Request | string | URL, who?: SignedIn): Promise<Response>
  /** Every request the space forwarded to meet's socket, as it arrived: the stand-in for the upgrade, which no test runtime can complete. */
  forwarded: Request[]
  /** For each of them, the address of the person the space's check named (what the part is handed with the request). */
  forwardedFor: (string | null)[]
  /** The operator's four, as the stand-in answered them: which object, and which of the four. */
  operated: { object: string; op: 'bookmark' | 'restart' | 'restore' | 'counts'; bookmark?: string }[]
  asked: { askers: string[]; histories: { conversationId: number; before: number | undefined }[]; reads: { conversationId: number; upTo: number }[]; posts: MeetPost[] }
  /** What `liveCalls` answers, which a test may change between two asks. */
  live: MeetLiveCall[]
  /** The posts that went out, in order. */
  posted: MeetPost[]
  script: { post: PostStep[]; /** What the next edit, delete, setting or acknowledgement does instead (the same steps as a post's). */ write: PostStep[] }
  /** What the space asked meet to change in a message or a person's own settings, in order. */
  changes: { edits: MeetEdit[]; deletes: number[]; updates: MeetMePatch[]; acknowledged: number; peopleReads: number; meReads: number }
  /** The asker's own settings, which a press changes. */
  settings: MeetMe
  /** Every call the stand-in knows (cards, past calls, meetings): the huddles, call links, New calls and meetings it was given and the ones the space made. Newest made first when read. */
  callsHeld: MeetCall[]
  /** Each call's saved chat, by the call's name. */
  chats: Record<string, MeetCallMessage[]>
  /** The Phone conversation's items (a voicemail, a missed call), oldest first; null where the person has no phone conversation. */
  phoneItems: MeetPhoneItem[] | null
  phoneUnread: number
  meter: MeetUsage
  /** What the space asked meet to make, in order, and what it asked the cards and the meetings for. */
  made: { huddles: MeetHuddleStart[]; calls: MeetCallStart[]; bookings: MeetBooking[]; cards: MeetCardsWant[]; meetings: Array<[number, number]>; deletedChats: string[] }
  /** What the next write of calls does instead: refused for the meter (`limit`), failed (`broken`), the binding failing (`throw`) or never answering (`hang`). */
  steps: { call: PostStep[] }
  /** The channel admin (stand-in-channels.ts): what the space asked of it, who it "emailed", and the people and channels it holds. */
  admin: StandInChannels
}

export function standInMeet(
  overview: { me?: MeetPerson; direct: MeetDirect[]; channels: MeetChannel[]; phone?: MeetPhoneSummary | null; calls?: MeetCallRef[] },
  options: {
    delayMs?: number
    history?: Record<number, StandInChatMessage[]>
    now?: () => number
    /** What `liveCalls` answers. */
    calls?: MeetLiveCall[]
    callsHeld?: MeetCall[]
    chats?: Record<string, MeetCallMessage[]>
    phoneItems?: MeetPhoneItem[] | null
    meter?: MeetUsage
    /** Calls (of `callsHeld`) made at /start before the space: meet's workspace has no record of them, so they have no row, and are only in the Calls list. */
    legacy?: string[]
    /** What meet's phone answers a person who has it: the status of the dial pad. Absent: the phone is not set up. */
    phoneStatus?: Record<string, unknown>
    /** The people and channels behind the channel admin: who is in each channel of the overview, who else the person can see, the open channels to join, and whether they are the owner (default). */
    channels?: Omit<StandInChannelOptions, 'me' | 'now'>
  } = {},
): StandInMeet {
  const forwarded: Request[] = []
  const forwardedFor: (string | null)[] = []
  const operated: StandInMeet['operated'] = []
  const asked: StandInMeet['asked'] = { askers: [], histories: [], reads: [], posts: [] }
  const posted: MeetPost[] = []
  const script: StandInMeet['script'] = { post: [], write: [] }
  const changes: StandInMeet['changes'] = { edits: [], deletes: [], updates: [], acknowledged: 0, peopleReads: 0, meReads: 0 }
  const now = options.now ?? Date.now
  const me: MeetPerson = overview.me ?? { id: 'p-tessa', name: 'Tessa', kind: 'teammate', address: 'tessa@northfield.example' }
  const owner = options.channels?.owner ?? true
  const settings: MeetMe = { person: me, owner, nudgesOff: false, privacyAcked: false }
  const direct = overview.direct.map((d) => ({ ...d }))
  const channels = overview.channels.map((c) => ({ ...c }))
  const history = new Map<number, StandInChatMessage[]>(Object.entries(options.history ?? {}).map(([k, v]) => [Number(k), [...v]]))
  const keys = new Map<string, MeetPosted>()
  let nextId = 100_000
  let nextConversation = 600
  const known = (conversationId: number) => direct.some((d) => d.conversationId === conversationId) || channels.some((c) => c.conversationId === conversationId)
  const asMessage = (conversationId: number, m: StandInChatMessage): MeetMessage => ({
    id: m.id,
    conversationId,
    authorId: m.authorId,
    authorName: m.authorName,
    text: m.text,
    at: m.at,
    editedAt: m.editedAt ?? null,
    mine: m.mine ?? m.authorId === me.id,
    ...(m.huddle === undefined ? {} : { huddle: m.huddle }),
    // What meet's rules let the person do with it: your own is edited and deleted, the owner deletes another's, a huddle's announcement included, as at /start.
    may: { edit: m.mine ?? m.authorId === me.id, delete: (m.mine ?? m.authorId === me.id) || owner },
  })

  const live: MeetLiveCall[] = [...(options.calls ?? [])]
  const callsHeld: MeetCall[] = (options.callsHeld ?? []).map((c) => ({ ...c, invitees: [...c.invitees] }))
  const chats: Record<string, MeetCallMessage[]> = { ...(options.chats ?? {}) }
  const made: StandInMeet['made'] = { huddles: [], calls: [], bookings: [], cards: [], meetings: [], deletedChats: [] }
  const steps: StandInMeet['steps'] = { call: [] }
  let phoneItems: MeetPhoneItem[] | null = options.phoneItems === undefined ? null : options.phoneItems
  let phoneUnread = 0
  const meter: MeetUsage = options.meter ?? { usedGb: 0, freeGb: 1000, tripGb: 800, paused: false, pausedUntil: null }
  const callKeys = new Map<string, MeetCall>()
  let nextCall = 1
  const newName = () => String(nextCall++).padStart(20, '0')
  const linkOf = (name: string) => `https://space.northfield.example/r/${name}`
  const base = (name: string, kind: MeetCall['kind']): MeetCall => ({
    name,
    link: linkOf(name),
    kind,
    title: null,
    madeBy: { name: me.name, mine: true },
    madeAt: now(),
    conversationId: null,
    home: null,
    startsAt: null,
    invitees: [],
    present: 0,
    people: 0,
    messages: 0,
    endedAt: null,
    openedAt: null,
  })
  /** The step a scripted write takes, or null to do it. The meter's refusal is the words meet gives. */
  const stepped = async (): Promise<WriteReply<MeetCall> | null> => {
    const step = steps.call.shift()
    if (step === 'limit') return refused('limit', 'Calls are paused until 2026-12-01.')
    if (step === 'broken') return failed('Chat could not make the call.')
    if (step === 'throw') throw new Error('stand-in meet lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    return null
  }
  const keyed = async (key: string, make: () => MeetCall): Promise<WriteReply<MeetCall>> => {
    const held = callKeys.get(key)
    if (held) return repeated<MeetCall>({ state: 'done', reply: answered(held) })
    const scripted = await stepped()
    if (scripted) return scripted
    const call = make()
    callKeys.set(key, call)
    callsHeld.push(call)
    return answered(call)
  }
  const admin = standInChannels(channels, asked.askers, { ...(options.channels ?? {}), me, now })
  /** Whom meet lets the person open a direct message with: any teammate, and a guest who shares a channel with them. */
  const reachable = (who: MeetPerson): boolean => who.kind === 'teammate' || [...admin.rooms.values()].some((r) => r.members.includes(who.id))
  /** The step a scripted write of messages or settings takes, or null to do it. */
  const stepWrite = async (): Promise<SpaceReply<never> | null> => {
    const step = script.write.shift()
    if (step === 'limit') return refused('limit', 'You are sending messages too fast. Wait a moment.')
    if (step === 'broken') return failed('Chat could not do that.')
    if (step === 'throw') throw new Error('stand-in meet lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    return null
  }
  /** After an edit or a delete: the conversation's newest message, as the list shows it. */
  const refreshNewest = (conversationId: number) => {
    const all = [...(history.get(conversationId) ?? [])].sort((a, b) => a.id - b.id)
    const last = all.at(-1)
    const newest = last ? { messageId: last.id, at: last.at, text: last.huddle === undefined ? last.text : 'Started a huddle', authorId: last.authorId, authorName: last.authorName, mine: last.mine ?? last.authorId === me.id } : null
    const d = direct.find((x) => x.conversationId === conversationId)
    if (d) d.newest = newest
    const c = channels.find((x) => x.conversationId === conversationId)
    if (c) c.newest = newest
  }
  const holder = (id: number): { conversationId: number; message: StandInChatMessage } | null => {
    for (const [conversationId, list] of history) {
      const message = list.find((m) => m.id === id)
      if (message && known(conversationId)) return { conversationId, message }
    }
    return null
  }
  return {
    admin,
    changes,
    settings,
    async peopleToMessage(asker) {
      asked.askers.push(asker.person.address)
      changes.peopleReads += 1
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const seen = new Map<string, MeetReachable>()
      for (const d of direct) seen.set(d.person.id, { person: { ...d.person }, direct: d.newest !== null })
      for (const p of admin.people) if (!seen.has(p.id) && reachable(p)) seen.set(p.id, { person: { id: p.id, name: p.name, kind: p.kind, address: p.address }, direct: false })
      return answered([...seen.values()].sort((a, b) => a.person.name.localeCompare(b.person.name)))
    },
    async editMessage(asker, edit) {
      asked.askers.push(asker.person.address)
      changes.edits.push(edit)
      const scripted = await stepWrite()
      if (scripted) return scripted
      const found = holder(edit.messageId)
      if (!found) return refused('not-found', 'There is no such message.')
      if (!(found.message.mine ?? found.message.authorId === me.id)) return refused('not-admitted', 'You can edit only your own messages.')
      const text = edit.text.replace(/\s+$/g, '').trim()
      if (text === '') return refused('bad-request', 'A message cannot be empty. Delete it instead.')
      if (text.length > 2000) return refused('bad-request', 'A message is at most 2,000 characters.')
      found.message.text = text
      found.message.editedAt = now()
      refreshNewest(found.conversationId)
      return answered(asMessage(found.conversationId, found.message))
    },
    async deleteMessage(asker, messageId) {
      asked.askers.push(asker.person.address)
      changes.deletes.push(messageId)
      const scripted = await stepWrite()
      if (scripted) return scripted
      const found = holder(messageId)
      if (!found) return refused('not-found', 'There is no such message.')
      if (!(found.message.mine ?? found.message.authorId === me.id) && !owner) return refused('not-admitted', 'You can delete only your own messages.')
      history.set(found.conversationId, (history.get(found.conversationId) ?? []).filter((m) => m.id !== messageId))
      refreshNewest(found.conversationId)
      return answered({ conversationId: found.conversationId, messageId })
    },
    async me(asker) {
      asked.askers.push(asker.person.address)
      changes.meReads += 1
      return answered({ ...settings })
    },
    async updateMe(asker, patch) {
      asked.askers.push(asker.person.address)
      changes.updates.push(patch)
      const scripted = await stepWrite()
      if (scripted) return scripted
      if (patch.name !== undefined) {
        const name = patch.name.replace(/\s+/g, ' ').trim().slice(0, 40)
        if (name === '') return refused('bad-request', 'Your name cannot be empty.')
        settings.person = { ...settings.person, name }
      }
      if (patch.nudgesOff !== undefined) settings.nudgesOff = patch.nudgesOff
      return answered({ ...settings })
    },
    async acknowledgePrivacy(asker) {
      asked.askers.push(asker.person.address)
      changes.acknowledged += 1
      const scripted = await stepWrite()
      if (scripted) return scripted
      settings.privacyAcked = true
      return answered({ ...settings })
    },
    channel: (asker, conversationId) => admin.channel(asker, conversationId),
    browseChannels: (asker) => admin.browseChannels(asker),
    createChannel: (asker, make) => admin.createChannel(asker, make),
    inviteGuest: (asker, invite) => admin.inviteGuest(asker, invite),
    changeChannel: (asker, change) => admin.changeChannel(asker, change),
    forwarded,
    forwardedFor,
    operated,
    asked,
    live,
    posted,
    script,
    callsHeld,
    chats,
    made,
    steps,
    get phoneItems() {
      return phoneItems
    },
    set phoneItems(v) {
      phoneItems = v
    },
    get phoneUnread() {
      return phoneUnread
    },
    set phoneUnread(v) {
      phoneUnread = v
    },
    meter,
    async liveCalls(asker: SignedIn): Promise<SpaceReply<MeetLiveCall[]>> {
      asked.askers.push(asker.person.address)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      return answered(live.map((c) => ({ ...c })))
    },
    async conversations(asker: SignedIn): Promise<SpaceReply<MeetOverview>> {
      asked.askers.push(asker.person.address)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      // A call with no conversation and the Phone conversation are in the overview when the stand-in was given them; the New calls the space made are added.
      const newCalls: MeetCallRef[] = [
        ...(overview.calls ?? []),
        ...callsHeld.filter((c) => c.kind === 'new' && !(options.legacy ?? []).includes(c.name) && !(overview.calls ?? []).some((r) => r.name === c.name)).map((c) => ({ name: c.name, link: c.link, title: c.title, madeAt: c.madeAt })),
      ].sort((a, b) => b.madeAt - a.madeAt)
      return answered({ me, direct, channels, phone: overview.phone ?? null, calls: newCalls })
    },
    async history(asker: SignedIn, conversationId: number, before?: number): Promise<SpaceReply<MeetHistory>> {
      asked.askers.push(asker.person.address)
      asked.histories.push({ conversationId, before })
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      if (!known(conversationId)) return refused('not-found', 'No such conversation.')
      const all = [...(history.get(conversationId) ?? [])].sort((a, b) => a.id - b.id)
      const upto = before === undefined ? all : all.filter((m) => m.id < before)
      const page = upto.slice(-HISTORY_PAGE)
      return answered({ messages: page.map((m) => asMessage(conversationId, m)), more: upto.length > page.length })
    },
    async post(asker: SignedIn, post: MeetPost): Promise<WriteReply<MeetPosted>> {
      asked.askers.push(asker.person.address)
      asked.posts.push(post)
      const held = keys.get(post.key)
      if (held) return repeated<MeetPosted>({ state: 'done', reply: answered(held) })
      const step = script.post.shift()
      if (step === 'limit') return refused('limit', 'You are sending messages too fast. Wait a moment.')
      if (step === 'broken') return failed('Chat could not take the message.')
      if (step === 'throw') throw new Error('stand-in meet lost the connection')
      if (step === 'hang') return new Promise(() => undefined)
      let conversationId: number
      if ('conversationId' in post.target) {
        conversationId = post.target.conversationId
        if (!known(conversationId)) return refused('not-found', 'No such conversation.')
      } else {
        const personId = post.target.personId
        let found = direct.find((d) => d.person.id === personId)
        if (!found) {
          // Meet opens the direct message as it posts, for a teammate or a guest the person shares a channel with.
          const who = admin.people.find((p) => p.id === personId)
          if (!who || !reachable(who)) return refused('not-found', 'There is no such person.')
          found = { conversationId: nextConversation++, person: { id: who.id, name: who.name, kind: who.kind, address: who.address }, newest: null, unread: 0 }
          direct.push(found)
        }
        conversationId = found.conversationId
      }
      const message: StandInChatMessage = { id: nextId++, at: now(), authorId: me.id, authorName: me.name, text: post.text, mine: true }
      history.set(conversationId, [...(history.get(conversationId) ?? []), message])
      const newest = { messageId: message.id, at: message.at, text: message.text, authorId: me.id, authorName: me.name, mine: true }
      const d = direct.find((x) => x.conversationId === conversationId)
      if (d) d.newest = newest
      const c = channels.find((x) => x.conversationId === conversationId)
      if (c) c.newest = newest
      const done: MeetPosted = { conversationId, message: asMessage(conversationId, message) }
      keys.set(post.key, done)
      posted.push(post)
      return answered(done)
    },
    async markRead(asker: SignedIn, conversationId: number, upTo: number): Promise<SpaceReply<MeetRead>> {
      asked.askers.push(asker.person.address)
      asked.reads.push({ conversationId, upTo })
      if (!known(conversationId)) return refused('not-found', 'No such conversation.')
      const d = direct.find((x) => x.conversationId === conversationId)
      if (d) d.unread = 0
      const c = channels.find((x) => x.conversationId === conversationId)
      if (c) c.unread = 0
      return answered({ conversationId, upTo })
    },
    async startHuddle(asker: SignedIn, start: MeetHuddleStart): Promise<WriteReply<MeetCall>> {
      asked.askers.push(asker.person.address)
      made.huddles.push(start)
      if (!known(start.conversationId)) return refused('not-found', 'No such conversation.')
      return keyed(start.key, () => {
        const call = { ...base(newName(), 'huddle'), conversationId: start.conversationId }
        const message: StandInChatMessage = { id: nextId++, at: now(), authorId: me.id, authorName: me.name, text: `Started a huddle: ${call.link}`, mine: true, huddle: call.name }
        history.set(start.conversationId, [...(history.get(start.conversationId) ?? []), message])
        const newest = { messageId: message.id, at: message.at, text: 'Started a huddle', authorId: me.id, authorName: me.name, mine: true }
        const d = direct.find((x) => x.conversationId === start.conversationId)
        if (d) d.newest = newest
        const c = channels.find((x) => x.conversationId === start.conversationId)
        if (c) c.newest = newest
        return call
      })
    },
    async startCall(asker: SignedIn, start: MeetCallStart): Promise<WriteReply<MeetCall>> {
      asked.askers.push(asker.person.address)
      made.calls.push(start)
      return keyed(start.key, () => ({ ...base(newName(), start.home ? 'link' : 'new'), home: start.home ?? null, title: start.title?.trim() || null }))
    },
    async bookMeeting(asker: SignedIn, booking: MeetBooking): Promise<WriteReply<MeetCall>> {
      asked.askers.push(asker.person.address)
      made.bookings.push(booking)
      if (booking.title.trim() === '') return refused('bad-request', 'A meeting needs a title.')
      return keyed(booking.key, () => ({
        ...base(newName(), 'meeting'),
        title: booking.title.trim(),
        startsAt: booking.startsAt,
        home: booking.home ?? null,
        conversationId: booking.conversationId ?? null,
        invitees: [...(booking.invitees ?? [])],
      }))
    },
    async cards(asker: SignedIn, want: MeetCardsWant): Promise<SpaceReply<MeetCall[]>> {
      asked.askers.push(asker.person.address)
      made.cards.push(want)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const rows = callsHeld.filter(
        (c) =>
          ((c.kind === 'huddle' || c.kind === 'meeting') && c.conversationId !== null && want.conversationIds.includes(c.conversationId)) ||
          ((c.kind === 'link' || c.kind === 'meeting') && c.home !== null && want.homes.includes(c.home)),
      )
      return answered(rows.sort((a, b) => b.madeAt - a.madeAt).map((c) => ({ ...c, invitees: [...c.invitees] })))
    },
    async calls(asker: SignedIn, after?: string, limit?: number): Promise<SpaceReply<MeetCallPage>> {
      asked.askers.push(asker.person.address)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const sorted = [...callsHeld].sort((a, b) => b.madeAt - a.madeAt || a.name.localeCompare(b.name))
      const start = after ? sorted.findIndex((c) => `${c.madeAt}:${c.name}` === after) + 1 : 0
      const size = limit ?? 20
      const page = sorted.slice(start, start + size)
      const last = page.at(-1)
      return answered({ calls: page.map((c) => ({ ...c })), next: last && start + size < sorted.length ? `${last.madeAt}:${last.name}` : null })
    },
    async callChat(asker: SignedIn, name: string): Promise<SpaceReply<MeetCallChat>> {
      asked.askers.push(asker.person.address)
      const call = callsHeld.find((c) => c.name === name)
      if (!call) return refused('not-found', 'This is not a call.')
      return answered({ call: { ...call }, messages: [...(chats[name] ?? [])] })
    },
    async deleteCallChat(asker: SignedIn, name: string): Promise<SpaceReply<{ deleted: number }>> {
      asked.askers.push(asker.person.address)
      made.deletedChats.push(name)
      const call = callsHeld.find((c) => c.name === name)
      if (!call) return refused('not-found', 'This is not a call.')
      if (call.present > 0) return refused('conflict', 'Someone is in this call right now. Delete its messages once everyone has left.')
      const deleted = (chats[name] ?? []).length
      chats[name] = []
      call.messages = 0
      return answered({ deleted })
    },
    async meetings(asker: SignedIn, from: number, until: number): Promise<SpaceReply<MeetCall[]>> {
      asked.askers.push(asker.person.address)
      made.meetings.push([from, until])
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      return answered(callsHeld.filter((c) => c.kind === 'meeting' && c.startsAt !== null && c.startsAt >= from && c.startsAt < until).sort((a, b) => (a.startsAt as number) - (b.startsAt as number)).map((c) => ({ ...c })))
    },
    async usage(asker: SignedIn): Promise<SpaceReply<MeetUsage>> {
      asked.askers.push(asker.person.address)
      return answered({ ...meter })
    },
    async phoneConversation(asker: SignedIn): Promise<SpaceReply<MeetPhone>> {
      asked.askers.push(asker.person.address)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      if (phoneItems === null) return refused('not-found', 'There is no such conversation.')
      return answered({ conversationId: overview.phone?.conversationId ?? 90, unread: phoneUnread, items: phoneItems.map((i) => ({ ...i })), more: false })
    },
    async phoneRead(asker: SignedIn, upTo: number): Promise<SpaceReply<MeetRead>> {
      asked.askers.push(asker.person.address)
      phoneUnread = 0
      return answered({ conversationId: overview.phone?.conversationId ?? 90, upTo })
    },
    // The operator's four (a move of meet's stores): the stand-in answers them as the owner's and keeps what was asked. The real part checks the owner, the object's name and the bookmark's shape (packages/meet/src/space-meet.ts).
    async storeBookmark(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetBookmark>> {
      asked.askers.push(asker.person.address)
      operated.push({ object, op: 'bookmark' })
      return answered({ object, bookmark: '00000000-00000006-00005118-0123456789abcdef0123456789abcdef' })
    },
    async storeCounts(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetCounts>> {
      asked.askers.push(asker.person.address)
      operated.push({ object, op: 'counts' })
      return answered({ object, counts: { people: 3, conversations: 4, messages: 25 } })
    },
    async restartStore(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetRestarted>> {
      asked.askers.push(asker.person.address)
      operated.push({ object, op: 'restart' })
      return answered({ object, restarted: true as const })
    },
    async restoreStore(asker: SignedIn, object: MeetObject, bookmark: string): Promise<SpaceReply<MeetRestoring>> {
      asked.askers.push(asker.person.address)
      operated.push({ object, op: 'restore', bookmark })
      return answered({ object, restoring: true as const })
    },
    // The upgrade request meet would get, kept as it arrived; a plain answer stands in for the 101 a runtime would make. The phone's paths are answered as meet's phone does when
    // it is not set up (`{ available: false }`), or, given a status, as it does for a person who has the phone (the dial pad, over meet's own stand-in browser phone).
    async fetch(request: Request | string | URL, who?: SignedIn): Promise<Response> {
      const req = request instanceof Request ? request : new Request(request)
      forwarded.push(req)
      forwardedFor.push(who?.person.address ?? null)
      const { pathname } = new URL(req.url)
      if (pathname === '/space/phone' || pathname.startsWith('/space/phone/')) {
        const rest = pathname.slice('/space/phone'.length)
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
        if (!options.phoneStatus) return rest === '' ? json({ available: false }) : json({ ok: true })
        if (rest === '' && req.method === 'GET') return json(options.phoneStatus)
        if (rest === '/calls' || rest === '/dev/telnyx') return json({ calls: [] })
        if (rest === '/token') return json({ token: 'stand-in', sdk: 'fake', who: 'stand-in-who' })
        return json(options.phoneStatus)
      }
      return new Response('stand-in socket', { status: 200, headers: { 'x-stand-in': 'meet-socket' } })
    },
  }
}

// ── Forms ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StandInForms extends FormsForSpace {
  /** What the space asked, so a test can see it: every query `documents`, `documentsOn` and `documentsIn` were given, the addresses `documentsOn` was asked about and the conversations `documentsIn` was. */
  asked: { askers: string[]; queries: (DocumentsQuery | undefined)[]; on: string[][]; in: ConversationRef[][] }
  /** The documents it holds, which a test may change between two asks. */
  held: DocumentSummary[]
}

/**
 * Forms' reads over documents given as literals. `documents` does what forms does with a query: only the states asked for, only those made, sent or
 * finished since `since`, newest made first, at most `limit` and `more` when there were others. Forms' tests prove that against its store; this keeps the
 * space's tests honest about what it can ask for.
 */
export function standInForms(documents: DocumentSummary[], options: { delayMs?: number; recipients?: Record<string, string[]> } = {}): StandInForms {
  const asked: StandInForms['asked'] = { askers: [], queries: [], on: [], in: [] }
  const held = documents.map((d) => ({ ...d, notSigned: [...d.notSigned] }))
  return {
    asked,
    held,
    async documents(asker: SignedIn, query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
      asked.askers.push(asker.person.address)
      asked.queries.push(query)
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const since = query?.since
      const all = held
        .filter((d) => (query?.states ? query.states.includes(d.state) : true))
        .filter((d) => (since === undefined ? true : d.createdAt >= since || (d.sentAt ?? -1) >= since || (d.completedAt ?? -1) >= since))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const limit = query?.limit ?? 100
      return answered({ documents: all.slice(0, limit).map((d) => ({ ...d, notSigned: [...d.notSigned] })), more: all.length > limit })
    },
    // What forms does for a person's page: the documents any of these addresses is a recipient of, matched case-blind (forms' tests prove that against its store).
    async documentsOn(asker: SignedIn, addresses: readonly string[], query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
      asked.askers.push(asker.person.address)
      asked.queries.push(query)
      asked.on.push([...addresses])
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()))
      const all = held
        .filter((d) => (options.recipients?.[d.id] ?? []).some((r) => wanted.has(r.trim().toLowerCase())))
        .filter((d) => (query?.states ? query.states.includes(d.state) : true))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const limit = query?.limit ?? 100
      return answered({ documents: all.slice(0, limit).map((d) => ({ ...d, notSigned: [...d.notSigned] })), more: all.length > limit })
    },
    // What forms does for a conversation: the documents that carry one of its refs, and only those (forms' tests prove that against its store).
    async documentsIn(asker: SignedIn, conversations: readonly ConversationRef[], query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
      asked.askers.push(asker.person.address)
      asked.queries.push(query)
      asked.in.push(conversations.map((c) => ({ ...c })))
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
      const all = held
        .filter((d) => d.conversation != null && conversations.some((c) => c.app === d.conversation?.app && c.id === d.conversation.id))
        .filter((d) => (query?.states ? query.states.includes(d.state) : true))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const limit = query?.limit ?? 100
      return answered({ documents: all.slice(0, limit).map((d) => ({ ...d, notSigned: [...d.notSigned] })), more: all.length > limit })
    },
  }
}

/**
 * LOCAL ONLY (the dev switches in app.ts): `documentsIn` answered from a REAL forms running beside this preview, so a browser test sends a document from a
 * conversation through forms' own Send and sees the card its real store gives back. A local forms lets anyone call its operator API (`ALLOW_UNAUTHENTICATED`),
 * which lists the envelopes with the link they carry; this reads that list and cuts it down to the contract's summary. Everything else stays the stand-in's.
 * It is not how the deployed space reads forms (that is forms' own reads, called in the Worker, whose queries forms' own tests prove against its store).
 */
export function withFormsAt(forms: StandInForms, base: string): StandInForms {
  return {
    ...forms,
    async documentsIn(asker: SignedIn, conversations: readonly ConversationRef[], query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
      forms.asked.askers.push(asker.person.address)
      forms.asked.in.push(conversations.map((c) => ({ ...c })))
      const res = await fetch(`${base}/admin/api/envelopes`, { headers: { accept: 'application/json' } })
      if (!res.ok) return failed('The local forms did not answer.')
      const rows = (await res.json()) as {
        id: string
        title: string
        status: DocumentSummary['state']
        created_at: string
        sent_at: string | null
        completed_at: string | null
        signers: number
        signed: number
        conversation_app?: ConversationApp | null
        conversation_id?: string | null
      }[]
      const ms = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso))
      const all = rows
        .filter((r) => r.conversation_app != null && r.conversation_id != null && conversations.some((c) => c.app === r.conversation_app && c.id === r.conversation_id))
        .filter((r) => (query?.states ? query.states.includes(r.status) : true))
        .map((r): DocumentSummary => ({
          id: r.id,
          title: r.title,
          state: r.status,
          createdAt: ms(r.created_at) ?? 0,
          sentAt: ms(r.sent_at),
          completedAt: ms(r.completed_at),
          signers: r.signers,
          signed: r.signed,
          notSigned: [],
          conversation: { app: r.conversation_app as ConversationApp, id: r.conversation_id as string },
        }))
      const limit = query?.limit ?? 100
      return answered({ documents: all.slice(0, limit), more: all.length > limit })
    },
  }
}

// ── The fixtures a local page is photographed with ────────────────────────────────────────────────────────────────────────

const MIN = 60_000

// A thread shaped like one that read badly in the space: a customer on Yahoo Mail answers from her phone, and each reply quotes the thread under it with ">"
// lines, after Yahoo's tracking link. The people and the words are invented. A message that quotes carries the fold the inbox's own page makes of it (it is
// told to the stand-in, and test/stand-in-reads.test.ts checks every one against the inbox's `readText`, so it cannot drift); the rest are read whole.
const YAHOO_LINK =
  'https://links.example.net/app?from=signature&client=ios&campaign=mail-app&variant=static&next=https%3A%2F%2Fstore.example.net%2Fapps%2Fdetails%3Fid%3Dmail%26listing%3Dsignature'
const ROSA = 'Rosa Whitfield <rosa_whitfield@yahoo.example>'
const TESSA = 'Tessa Marlow <tessa@northfield.example>'
const SENT_FROM_YAHOO = `Sent from Yahoo Mail for iPhone\n<${YAHOO_LINK}>`
/** An attribution and the lines it quotes, ">" in front of each (a blank one is a bare ">"). */
const quoted = (attribution: string, ...lines: string[]): string => [attribution, '', ...lines.flatMap((l) => (l === '' ? ['>'] : l.split('\n').map((x) => `> ${x}`)))].join('\n')
/** A message with new words and the quote under them: the text as it arrived, and the fold the inbox makes of it (everything above the attribution is shown). */
const withQuote = (visible: string, fold: string): Pick<StandInMessage, 'text' | 'read'> => ({ text: `${visible}\n\n${fold}`, read: { visible, quoted: fold } })
const RIDGEWAY: InboxMailbox = { id: 'ridgeway', name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' }
/** Tessa's Telegram, the mailbox its chats are in: the pill, and the menu's Telegram entry. */
const TELEGRAM: InboxMailbox = { id: 'telegram', name: 'Telegram', address: '7000000001' }
/** Northfield's test mailbox on its own mail server (test@harborline.example), read and written over JMAP: the pill, and the menu's entry. */
const HARBORLINE: InboxMailbox = { id: 'harborline', name: 'harborline', address: 'test@harborline.example' }

/** The inbox and meet as a local page shows them with `SPACE_FIXTURES=1` (or a mode that breaks one part): invented people, times counted back from `now`. */
export type FixtureMode = '1' | 'mail-down' | 'chat-refused' | 'forms-down' | 'knowledge-down' | 'phone-on' | 'telegram-late' | 'telegram-signed-out' | 'jmap-refused' | 'jmap-down' | 'calendar-lapsed' | 'calendar-down' | 'calendar-empty' | 'telegram-pictures' | 'two-people' | 'calendar-mail'

export function fixtureApps(now: number, mode: FixtureMode = '1', options: { formsAt?: string; zone?: string } = {}) {
  const ago = (minutes: number) => now - minutes * MIN
  const contacts: StandInContact[] = [
    { id: 'c-dana', name: 'Dana Reyes', addresses: ['dana@harbordental.example'], client: { id: 7, name: 'Harbor Dental' }, business: 'Harbor Dental', role: 'Office manager', notes: 'Prefers a call before ten. Dr. Chen signs anything over $500.' },
    { id: 'c-marcus', name: 'Marcus Chen', addresses: ['marcus@harbordental.example'], client: { id: 7, name: 'Harbor Dental' }, business: 'Harbor Dental', role: 'Dentist and owner' },
    { id: 'c-lena', name: 'Lena Fischer', addresses: ['lena@fischerbakery.example'], suggested: { id: 3, name: 'Tamarack Print Supply' }, business: 'Fischer Bakery', role: 'Owner', notes: 'Sends screenshots from her phone.' },
    { id: 'c-text', name: '(626) 555-0142', addresses: [] },
    { id: 'c-lead', name: 'Tomas Alvarez', addresses: ['tomas.alvarez@mail.example', 'tomas.alvarez@oldmail.example'] },
    { id: 'c-news', name: 'Local Business Weekly', addresses: ['news@lbw.example'], automated: true },
    // Someone Claude has drafted a first email to and nothing has been said with: no conversation, so the draft is the only place she is.
    { id: 'c-new', name: 'Nadia Hussain', addresses: ['nadia@hussaincatering.example'] },
    { id: 'c-old', name: 'Grace Okafor', addresses: ['grace@okaforlaw.example'], business: 'Okafor Law', role: 'Attorney' },
    { id: 'c-priya', name: 'Priya Natarajan', addresses: ['priya@northfield.example'] },
    { id: 'c-rosa', name: 'Rosa Whitfield', addresses: ['rosa_whitfield@yahoo.example'], client: { id: 9, name: 'Lakeside Print Supply' }, business: 'Lakeside Print Supply', role: 'Owner' },
    // The same Dana under her other address, with nothing said yet: the duplicate a merge is for.
    { id: 'c-dana2', name: 'Dana R.', addresses: ['dreyes.dental@mail.example'] },
    // People who write on Telegram. Maria has no email at all (she is opened by `mail:c-tg-maria`); Dana above writes by both; a bot's chat is Bulk; a chat Tessa archived in Telegram came in closed.
    { id: 'c-tg-maria', name: 'Maria Lopez', addresses: [], business: 'Lopez Tile', role: 'Owner' },
    { id: 'c-tg-bot', name: 'Build Bot', addresses: [], automated: true },
    { id: 'c-tg-sam', name: 'Sam Ortega', addresses: [] },
    // Groups and channels on Telegram. A group is one contact that stands for it (named by its title; People leaves it out) and every member who writes in it is a person: Maria (above) writes in the
    // merchants' group as well as to Tessa, Tomas and Priti only ever write in groups.
    { id: 'c-tg-merchants', name: 'Main Street Merchants', addresses: [], chat: 'group' },
    { id: 'c-tg-garden', name: 'Garden Club', addresses: [], chat: 'group' },
    { id: 'c-tg-status', name: 'Cloudflare Status', addresses: [], chat: 'channel' },
    { id: 'c-tg-tomas', name: 'Tomas Vega', addresses: [], business: 'Vega Signs', role: 'Owner' },
    { id: 'c-tg-priti', name: 'Priti Shah', addresses: [] },
    // People who write to the test mailbox on the mail server: one asks a question (unread), one's receipt was archived in a mail app (it came in Closed).
    { id: 'c-kim', name: 'Kim Alder', addresses: ['kim@alder.example'] },
    { id: 'c-jo', name: 'Jo Marsh', addresses: ['jo@marsh.example'] },
  ]
  const asks = 'Sorry Rosa, something came up today. Could the walkthrough wait a day? Any time before noon suits me.'
  const thursday = 'Thursday afternoon is open for me too.'
  const friday = 'Failing that, Friday morning is fine.\n\nTell me which of these suits the shop.'
  const firstAsk = 'Hello Tessa,\nIs the walkthrough still happening this week? I have not heard.'
  const tomorrowNo = 'Hi Tessa, a day later is no good, we are shut for stocktaking. The sign maker is waiting on us, so the sooner the better. What else do you have this week? Thanks.'
  const checking = 'Following up on the proofs. If the shop is open this afternoon I can bring them over, and if not, Tuesday morning suits me too.'
  const asksQuote = quoted('On Tuesday, March 10, 2026, 9:05 AM, Tessa Marlow <tessa@northfield.example> wrote:', asks)
  const tomorrowNoQuote = quoted('On Tuesday, March 10, 2026, 9:40 AM Rosa Whitfield <rosa_whitfield@yahoo.example> wrote:', tomorrowNo, '', SENT_FROM_YAHOO)
  const thursdayQuote = quoted('On Tue, Mar 10, 2026, 9:48 AM Tessa Marlow <tessa@northfield.example> wrote:', thursday, '', tomorrowNoQuote)
  const rosaMessages: StandInMessage[] = [
    { id: 'm-ro-1', at: ago(60 * 24 * 7), direction: 'in', from: ROSA, text: firstAsk },
    { id: 'm-ro-2', at: ago(60 * 24 * 6), direction: 'out', from: TESSA, text: asks },
    { id: 'm-ro-3', at: ago(60 * 24 * 6 - 20), direction: 'in', from: ROSA, ...withQuote(`${tomorrowNo}\n\n${SENT_FROM_YAHOO}`, asksQuote) },
    { id: 'm-ro-4', at: ago(60 * 24 * 6 - 25), direction: 'out', from: TESSA, text: thursday },
    { id: 'm-ro-5', at: ago(60 * 24 * 6 - 30), direction: 'out', from: TESSA, text: friday },
    { id: 'm-ro-6', at: ago(60 * 24 * 5), direction: 'in', from: ROSA, ...withQuote(`${tomorrowNo}\n\n${SENT_FROM_YAHOO}`, quoted('On Tuesday, March 10, 2026, 9:52 AM, Tessa Marlow <tessa@northfield.example> wrote:', friday, '', thursdayQuote)) },
    { id: 'm-ro-7', at: ago(60 * 24 * 3), direction: 'out', from: TESSA, text: checking },
  ]
  const threads: StandInThread[] = [
    // Telegram: one conversation per chat, in the Telegram mailbox. Maria's holds an edited message, one she deleted for everyone and one Tessa sent from his phone.
    {
      id: 't-tg-maria',
      subject: '',
      kind: 'telegram',
      at: ago(7),
      snippet: 'Can you come by Friday instead? The tile guy moved his day.',
      unread: true,
      mailbox: TELEGRAM,
      on: ['c-tg-maria'],
      messages: [
        { id: 'm-tg-m1', at: ago(60 * 26), direction: 'in', from: 'Maria Lopez', text: 'Hi Tessa, are you free to look at the website on Thursday?' },
        { id: 'm-tg-m2', at: ago(60 * 25), direction: 'out', from: 'Tessa', text: 'Yes, Thursday at ten works. I will bring the new menu page.' },
        { id: 'm-tg-m3', at: ago(60 * 3), direction: 'in', from: 'Maria Lopez', text: 'Great. Also the phone number on the contact page is wrong, it should end in 0187.', edited: true },
        { id: 'm-tg-m4', at: ago(60 * 2), direction: 'in', from: 'Maria Lopez', text: '', deleted: true },
        // A video Tessa sent that the inbox holds no file entry for (the words only, as every message from before files were copied): the bubble is as narrow as its own words and the stamp over it.
        { id: 'm-tg-m4b', at: ago(9), direction: 'out', from: 'Tessa', text: '[Video]' },
        { id: 'm-tg-m5', at: ago(7), direction: 'in', from: 'Maria Lopez', text: 'Can you come by Friday instead? The tile guy moved his day.' },
      ],
    },
    // The same Dana as her email, on Telegram too: one person, one history.
    {
      id: 't-tg-dana',
      subject: '',
      kind: 'telegram',
      at: ago(60 * 5),
      snippet: 'Sending the photos from the front desk now.',
      unread: false,
      mailbox: TELEGRAM,
      on: ['c-dana'],
      messages: [
        { id: 'm-tg-d1', at: ago(60 * 6), direction: 'in', from: 'Dana Reyes', text: 'The new sign is up! Do you want a photo for the site?' },
        { id: 'm-tg-d2', at: ago(60 * 5), direction: 'out', from: 'Tessa', text: 'Yes please, the front desk one too.' },
        { id: 'm-tg-d3', at: ago(60 * 5 - 1), direction: 'in', from: 'Dana Reyes', text: 'Sending the photos from the front desk now.' },
      ],
    },
    { id: 't-tg-bot', subject: '', kind: 'telegram', at: ago(60 * 9), snippet: 'Deploy of northfield-web finished.', bulk: true, mailbox: TELEGRAM, on: ['c-tg-bot'], messages: [{ id: 'm-tg-b1', at: ago(60 * 9), direction: 'in', from: 'Build Bot', text: 'Deploy of northfield-web finished.' }] },
    // A group: one row under its own name, each message naming who wrote it. This one has a message that mentions Tessa, so it needs a reply and rang.
    {
      id: 't-tg-merchants',
      subject: '',
      kind: 'telegram',
      telegramChat: 'group',
      needsReply: true,
      at: ago(11),
      snippet: '@tessa could you look at our site this week? It is slow on phones.',
      unread: true,
      mailbox: TELEGRAM,
      on: ['c-tg-merchants'],
      messages: [
        { id: 'm-tg-g1', at: ago(60 * 5), direction: 'in', from: 'Tomas Vega', text: 'Anyone know a good sign painter for the corner shop?' },
        { id: 'm-tg-g2', at: ago(60 * 5 - 4), direction: 'in', from: 'Priti Shah', text: 'Try the shop on 4th, they did ours.' },
        { id: 'm-tg-g3', at: ago(60 * 4), direction: 'in', from: 'Maria Lopez', text: 'Lopez Tile used them too. Very fast.' },
        { id: 'm-tg-g4', at: ago(60 * 3), direction: 'out', from: 'Tessa', text: 'Thanks all, noted.' },
        { id: 'm-tg-g5', at: ago(11), direction: 'in', from: 'Tomas Vega', text: '@tessa could you look at our site this week? It is slow on phones.' },
      ],
    },
    // A group that is only chatter: an open row with its unread count, no ring and no Needs reply.
    {
      id: 't-tg-garden',
      subject: '',
      kind: 'telegram',
      telegramChat: 'group',
      needsReply: false,
      at: ago(60 * 2),
      snippet: 'Seed swap is moved to the 14th.',
      unread: true,
      mailbox: TELEGRAM,
      on: ['c-tg-garden'],
      messages: [
        { id: 'm-tg-ga1', at: ago(60 * 3), direction: 'in', from: 'Priti Shah', text: 'Who is bringing tomatoes?' },
        { id: 'm-tg-ga2', at: ago(60 * 2), direction: 'in', from: 'Tomas Vega', text: 'Seed swap is moved to the 14th.' },
      ],
    },
    // A channel Tessa follows: Bulk, never in the Inbox, and no reply box.
    { id: 't-tg-status', subject: '', kind: 'telegram', telegramChat: 'channel', at: ago(60 * 7), snippet: 'Resolved: elevated errors on Workers Analytics.', bulk: true, mailbox: TELEGRAM, on: ['c-tg-status'], messages: [{ id: 'm-tg-st1', at: ago(60 * 7), direction: 'in', from: 'Cloudflare Status', text: 'Resolved: elevated errors on Workers Analytics.' }] },
    // A chat Tessa archived in Telegram: it came in Closed.
    // Photos and voice notes, in the archived chat so nothing else's counts move: a captionless photo and a voice note (the placeholder words are not drawn over them), a photo with a caption, a
    // photo over the limit, a video and a document (named, left in Telegram), and a photo still being copied.
    {
      id: 't-tg-sam',
      subject: '',
      kind: 'telegram',
      at: ago(60 * 24 * 12),
      snippet: 'Thanks, all sorted.',
      unread: false,
      open: false,
      mailbox: TELEGRAM,
      on: ['c-tg-sam'],
      messages: [
        { id: 'm-tg-s0a', at: ago(60 * 24 * 12 + 50), direction: 'in', from: 'Sam Ortega', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/png', bytes: SHEET_PHOTO_PNG }] },
        { id: 'm-tg-s0b', at: ago(60 * 24 * 12 + 45), direction: 'in', from: 'Sam Ortega', text: '[Voice note]', files: [{ name: 'Voice note.ogg', type: 'audio/ogg', bytes: VOICE_NOTE_OGG, play: true, seconds: 3 }] },
        { id: 'm-tg-s0c', at: ago(60 * 24 * 12 + 40), direction: 'in', from: 'Sam Ortega', text: 'This is the corner I meant.', files: [{ name: 'Photo.jpg', type: 'image/png', bytes: SHEET_PHOTO_PNG }] },
        { id: 'm-tg-s0d', at: ago(60 * 24 * 12 + 35), direction: 'in', from: 'Sam Ortega', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(0), size: 11 * 1024 * 1024, note: 'Too large to copy. Open it in Telegram.' }] },
        { id: 'm-tg-s0e', at: ago(60 * 24 * 12 + 30), direction: 'in', from: 'Sam Ortega', text: '[Video]', files: [{ name: 'Video', type: '', bytes: new Uint8Array(0), size: 18 * 1024 * 1024, note: 'Not copied here. Open it in Telegram.' }] },
        { id: 'm-tg-s0f', at: ago(60 * 24 * 12 + 25), direction: 'in', from: 'Sam Ortega', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(0), note: 'Copying from Telegram.' }] },
        // Pictures sent as files and videos: a screenshot sent as a file is a thumbnail; a heic one is saved, not drawn; a video within the limit is a player, in a message of Tessa's own too (his bubble
        // was narrow enough to break the word "[Video]" in two); a video over the limit says so, in his own message as well.
        { id: 'm-tg-s0g', at: ago(60 * 24 * 12 + 20), direction: 'in', from: 'Sam Ortega', text: '[Image]', files: [{ name: 'Image.png', type: 'image/png', bytes: SHEET_PHOTO_PNG }] },
        { id: 'm-tg-s0h', at: ago(60 * 24 * 12 + 15), direction: 'in', from: 'Sam Ortega', text: '[Image]', files: [{ name: 'Image.heic', type: 'image/heic', bytes: new Uint8Array(1200) }] },
        { id: 'm-tg-s0i', at: ago(60 * 24 * 12 + 10), direction: 'out', from: 'Tessa', text: '[Video]', files: [{ name: 'Video.webm', type: 'video/webm', bytes: CLIP_WEBM, video: true, seconds: 1 }] },
        { id: 'm-tg-s0j', at: ago(60 * 24 * 12 + 8), direction: 'out', from: 'Tessa', text: '[Video]', files: [{ name: 'Video.mp4', type: 'video/mp4', bytes: new Uint8Array(0), size: 48 * 1024 * 1024, note: 'Too large to copy. Open it in Telegram.' }] },
        { id: 'm-tg-s0k', at: ago(60 * 24 * 12 + 6), direction: 'out', from: 'Tessa', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/png', bytes: SHEET_PHOTO_PNG }] },
        { id: 'm-tg-s1', at: ago(60 * 24 * 12), direction: 'in', from: 'Sam Ortega', text: 'Thanks, all sorted.' },
      ],
    },
    {
      id: 't-dana-1',
      subject: 'Re: Homepage copy for the spring promotion',
      at: ago(14),
      snippet: 'Looks right to me. Can the hours line say we are open Saturdays until two?',
      unread: true,
      on: ['c-dana', 'c-marcus'],
      messages: [
        { id: 'm-d1-1', at: ago(60 * 52), direction: 'out', from: 'Tessa', text: 'Hi Dana and Marcus, here is the homepage copy for the spring promotion. The offer sits above the fold, with the booking button under it.\n\nTell me what you would change.' },
        {
          id: 'm-d1-2',
          at: ago(60 * 30),
          direction: 'in',
          from: 'Marcus Chen <marcus@harbordental.example>',
          // A reply that quotes what it answers, as Gmail writes it: the inbox's page folds it, and the answer carries the fold.
          text: 'The headline is good. Could the offer say "free whitening with a cleaning" instead of "complimentary"?\n\nOn Sat, Oct 24, 2026 at 9:12 AM Tessa <tessa@northfield.example> wrote:\n\n> Hi Dana and Marcus, here is the homepage copy for the spring promotion. The offer sits above the fold, with the booking button under it.\n>\n> Tell me what you would change.',
          read: {
            visible: 'The headline is good. Could the offer say "free whitening with a cleaning" instead of "complimentary"?',
            quoted: 'On Sat, Oct 24, 2026 at 9:12 AM Tessa <tessa@northfield.example> wrote:\n\n> Hi Dana and Marcus, here is the homepage copy for the spring promotion. The offer sits above the fold, with the booking button under it.\n>\n> Tell me what you would change.',
          },
        },
        { id: 'm-d1-3', at: ago(14), direction: 'in', from: 'Dana Reyes <dana@harbordental.example>', text: 'Looks right to me. Can the hours line say we are open Saturdays until two?' },
      ],
    },
    {
      id: 't-dana-2',
      subject: 'Invoice 1042',
      at: ago(60 * 26),
      snippet: 'Paid by card this morning, thank you.',
      direction: 'out',
      on: ['c-dana'],
      messages: [
        { id: 'm-d2-1', at: ago(60 * 24 * 3), direction: 'out', from: 'Tessa', text: 'Invoice 1042 for October is attached. It is due on the 15th.' },
        { id: 'm-d2-2', at: ago(60 * 26), direction: 'out', from: 'Tessa', text: 'Paid by card this morning, thank you.' },
      ],
    },
    { id: 't-rosa-1', subject: 'Re: Sign proofs for the shop', at: ago(60 * 24 * 3), snippet: checking, direction: 'out', on: ['c-rosa'], messages: rosaMessages },
    { id: 't-marcus-1', subject: 'Parking sign photos', at: ago(60 * 5), snippet: 'Attached are the three angles you asked for.', on: ['c-marcus'] },
    { id: 't-lena-1', subject: 'Can you look at the menu page on a phone?', at: ago(95), snippet: 'It cuts off the prices on my phone. I sent a screenshot.', unread: true, on: ['c-lena'] },
    {
      id: 't-text-1',
      subject: '',
      kind: 'sms',
      at: ago(60 * 52),
      snippet: 'Running ten minutes late, see you at the shop.',
      on: ['c-text'],
      // A text Tessa sent from his phone and filed here by hand ("Not sent after all" takes it back), then theirs.
      messages: [
        { id: 'm-text-1', at: ago(60 * 53), direction: 'out', from: 'Tessa', text: 'Confirming Thursday at ten. See you at the shop.', sentByHand: true },
        { id: 'm-text-2', at: ago(60 * 52), direction: 'in', from: '(626) 555-0142', text: 'Running ten minutes late, see you at the shop.' },
      ],
    },
    {
      id: 't-lead-1',
      subject: 'Question about the winter service',
      at: ago(40),
      snippet: 'Should I take the lights off before I bring it in?',
      unread: true,
      mailbox: RIDGEWAY,
      on: ['c-lead'],
      // A Ridgeway customer's mail with a photo and a document attached, our reply from info@ with the drop-off form (delivered), and then a question.
      messages: [
        {
          id: 'm-ld-1',
          at: ago(60 * 26),
          direction: 'in',
          from: 'Tomas Alvarez <tomas.alvarez@mail.example>',
          text: 'Hello, I would like to book the winter service. Here is the receipt from the last shop that worked on it, and a photo of the sheet they gave me.',
          files: [
            { name: 'service-sheet-page-1.png', type: 'image/png', bytes: SHEET_PHOTO_PNG },
            { name: 'receipt-october.pdf', type: 'application/pdf', bytes: RECEIPT_PDF },
          ],
        },
        {
          id: 'm-ld-2',
          at: ago(60 * 25),
          direction: 'out',
          from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
          text: 'Thank you, Tomas. We have both. The drop-off form is attached; please fill it in before you come.',
          files: [{ name: 'ridgeway-drop-off-form.pdf', type: 'application/pdf', bytes: DROP_OFF_FORM_PDF }],
          delivery: [{ recipient: 'tomas.alvarez@mail.example', state: 'delivered', reason: '', at: ago(60 * 25 - 1) }],
        },
        { id: 'm-ld-3', at: ago(40), direction: 'in', from: 'Tomas Alvarez <tomas.alvarez@mail.example>', text: 'Should I take the lights off before I bring it in?' },
      ],
    },
    {
      id: 't-lead-2',
      subject: 'Drop-off form for Thursday',
      at: ago(60 * 2),
      snippet: 'Thank you, Tomas. The drop-off form is attached.',
      direction: 'out',
      mailbox: RIDGEWAY,
      on: ['c-lead'],
      // He wrote from an old address that no longer exists: our reply from info@ bounced, Cloudflare says the address does not exist, and the message says so.
      messages: [
        { id: 'm-nb-1', at: ago(60 * 3), direction: 'in', from: 'Tomas Alvarez <tomas.alvarez@oldmail.example>', text: 'Could you send me the drop-off form before Thursday? I am writing from my old address.' },
        {
          id: 'm-nb-2',
          at: ago(60 * 2),
          direction: 'out',
          from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
          to: 'tomas.alvarez@oldmail.example',
          text: 'Thank you, Tomas. The drop-off form is attached.',
          files: [{ name: 'ridgeway-drop-off-form.pdf', type: 'application/pdf', bytes: DROP_OFF_FORM_PDF }],
          delivery: [{ recipient: 'tomas.alvarez@oldmail.example', state: 'bounced', reason: '550 5.1.1 The email account that you tried to reach does not exist', at: ago(60 * 2 - 1) }],
        },
      ],
    },
    // The test mailbox on the mail server: a customer's question waiting, and a conversation archived in a mail app (so it is Closed here), with our reply in the mailbox's Sent.
    {
      id: 't-jmap-1',
      subject: 'Do you take walk-ins on Saturdays?',
      at: ago(25),
      snippet: 'Hello, can I drop my bike off on Saturday morning with no booking?',
      unread: true,
      mailbox: HARBORLINE,
      on: ['c-kim'],
      messages: [{ id: 'm-jm-1', at: ago(25), direction: 'in', from: 'Kim Alder <kim@alder.example>', text: 'Hello, can I drop my bike off on Saturday morning with no booking?' }],
    },
    {
      id: 't-jmap-2',
      subject: 'Receipt for the domain',
      at: ago(60 * 20),
      snippet: 'Thank you, that is filed.',
      open: false,
      direction: 'out',
      mailbox: HARBORLINE,
      on: ['c-jo'],
      messages: [
        { id: 'm-jm-2', at: ago(60 * 22), direction: 'in', from: 'Jo Marsh <jo@marsh.example>', text: 'Here is the receipt for harborline.example, for your records.' },
        { id: 'm-jm-3', at: ago(60 * 20), direction: 'out', from: 'harborline <test@harborline.example>', to: 'jo@marsh.example', text: 'Thank you, that is filed.' },
      ],
    },
    { id: 't-news-1', subject: 'This week in local marketing', at: ago(120), snippet: 'Five things small businesses got wrong about reviews.', bulk: true, unread: true, on: ['c-news'] },
    { id: 't-old-1', subject: 'Trademark question', at: ago(60 * 24 * 12), snippet: 'Thank you, that settles it for us.', open: false, on: ['c-old'] },
  ]
  // Claude's suggested reply to Lena, waiting for Tessa: it shows in her conversation and he can send it as it stands.
  const drafts: StandInDraft[] = [
    {
      id: 'd-lena-1',
      conversationId: 't-lena-1',
      contactId: 'c-lena',
      subject: 'Re: Can you look at the menu page on a phone?',
      text: 'Hi Lena, thank you for the screenshot. I can see the prices running off the edge.\n\nI will fix it today and send you a link to check on your phone.',
      author: 'claude',
      kind: 'email',
      at: ago(80),
    },
    // A reply whose send Gmail never confirmed: nothing sends it again, and only Tessa can say how it went.
    { id: 'd-marcus-stuck', conversationId: 't-marcus-1', contactId: 'c-marcus', subject: 'Re: Parking sign photos', text: 'Thanks Marcus, these are what I needed. I will send the proof on Monday.', author: 'outbox', stuck: true, kind: 'email', at: ago(35) },
    // The same from a business mailbox: Cloudflare gave no answer, and there is no Sent folder to look in.
    { id: 'd-lead-stuck', conversationId: 't-lead-1', contactId: 'c-lead', subject: 'Re: Question about the winter service', text: 'No need to take them off. Please bring the charger if it has one.', author: 'outbox', stuck: true, kind: 'email', sentFrom: 'info@ridgewaycycles.example', to: 'tomas.alvarez@mail.example', at: ago(20) },
    // A Telegram reply Claude wrote: sent through the bridge when Tessa presses Send.
    // A Telegram reply of Claude's that carries a picture: its card shows it, Tessa can send it, take it out or put another on. Only in the mode that photographs it (the drafts above are counted elsewhere).
    ...(mode === 'telegram-pictures' ? [{ id: 'd-tg-pic', conversationId: 't-tg-sam', contactId: 'c-tg-sam', subject: '', text: 'Here is the receipt you asked for.', author: 'claude' as const, kind: 'telegram' as const, to: '5001', why: 'He asked for the receipt.', at: ago(3), picture: { name: 'Photo.png', type: 'image/png', bytes: SHEET_PHOTO_PNG } }] : []),
    { id: 'd-tg-1', conversationId: 't-tg-maria', contactId: 'c-tg-maria', subject: '', text: 'Friday works. I will be there at ten and bring the new menu page.', author: 'claude', kind: 'telegram', to: '4001', why: 'She asked to move Thursday to Friday.', at: ago(5) },
    // A Telegram reply Telegram would not take (she blocked him): back to being a draft, with the reason in words.
    { id: 'd-tg-refused', conversationId: 't-tg-dana', contactId: 'c-dana', subject: '', text: 'Great, send them over when you can.', author: 'owner', kind: 'telegram', to: '2001', refusal: 'Telegram would not take this, so nothing was sent. You cannot write in this chat.', at: ago(30) },
    // A Telegram send the bridge never reported: shown as "check Telegram", never retried.
    { id: 'd-tg-stuck', conversationId: 't-tg-garden', contactId: 'c-tg-garden', subject: '', text: 'I can bring tomatoes on the 14th.', author: 'owner', kind: 'telegram', stuck: true, to: '-4455', at: ago(25) },
    // A text and a LinkedIn message: channels the inbox cannot send on. Tessa sends them himself and marks them sent.
    { id: 'd-text-1', conversationId: 't-text-1', contactId: 'c-text', subject: '', text: 'No problem. The door is open, come straight in.', author: 'claude', kind: 'sms', to: '+16265550142', why: 'They said they would be late.', at: ago(60) },
    // A first email to a new address: no conversation yet. It is the Drafts view's "Not on a conversation yet", and is sent, edited or deleted from its own page.
    { id: 'd-first-email', conversationId: null, contactId: 'c-new', subject: 'Websites for caterers', text: 'Hello Nadia,\n\nI build simple websites for local caterers: a menu, a booking form and a map that works on a phone.\n\nWould a short call this week suit you?', author: 'claude', kind: 'email', why: 'She was listed in the caterers directory and has no site of her own.', at: ago(45) },
    { id: 'd-linkedin-1', conversationId: null, contactId: 'c-old', subject: '', text: 'Hello Grace, thank you for the introduction to the printer. I will write to him this week.', author: 'claude', kind: 'manual', to: '@graceokafor', why: 'She made an introduction in her last note.', at: ago(90) },
  ]
  const person = (id: string, name: string, kind: MeetPerson['kind'], address: string | null): MeetPerson => ({ id, name, kind, address })
  const direct: MeetDirect[] = [
    {
      conversationId: 11,
      person: person('p-dana', 'Dana Reyes', 'guest', 'dana@harbordental.example'),
      newest: { messageId: 310, at: ago(3), text: 'Also, can you move Thursday to the afternoon?', authorId: 'p-dana', authorName: 'Dana', mine: false },
      unread: 2,
    },
    {
      conversationId: 12,
      person: person('p-priya', 'Priya Natarajan', 'teammate', 'priya@northfield.example'),
      newest: { messageId: 302, at: ago(18), text: 'Started a huddle', authorId: 'p-tessa', authorName: 'Tessa', mine: true },
      unread: 0,
    },
    { conversationId: 13, person: person('p-quiet', 'Sam Ortiz', 'teammate', 'sam@northfield.example'), newest: null, unread: 0 },
  ]
  const channels: MeetChannel[] = [
    {
      conversationId: 21,
      name: 'launch',
      privacy: 'open',
      memberCount: 6,
      newest: { messageId: 330, at: ago(22), text: 'Staging is up, please click through the booking form.', authorId: 'p-priya', authorName: 'Priya', mine: false },
      unread: 3,
    },
    {
      conversationId: 22,
      name: 'ops',
      privacy: 'private',
      memberCount: 3,
      newest: { messageId: 318, at: ago(60 * 30), text: 'Renewal reminders are scheduled.', authorId: 'p-tessa', authorName: 'Tessa', mine: true },
      unread: 0,
    },
  ]
  const chat = (id: number, at: number, who: 'dana' | 'priya' | 'tessa', text: string): StandInChatMessage => ({
    id,
    at,
    authorId: `p-${who}`,
    authorName: who === 'tessa' ? 'Tessa' : who === 'dana' ? 'Dana' : 'Priya',
    text,
    mine: who === 'tessa',
  })
  const history: Record<number, StandInChatMessage[]> = {
    11: [
      chat(300, ago(60 * 20), 'dana', 'Hi Tessa, are you free for a quick call about the promotion sometime this week?'),
      chat(305, ago(60 * 19), 'tessa', 'Yes. Thursday morning works for me.'),
      chat(309, ago(4), 'dana', 'Thursday is great.'),
      chat(310, ago(3), 'dana', 'Also, can you move Thursday to the afternoon?'),
    ],
    12: [
      chat(299, ago(60 * 5), 'priya', 'Did you see the new booking form?'),
      chat(301, ago(60 * 3), 'tessa', 'I left the checklist on the board.'),
      { ...chat(302, ago(18), 'tessa', 'Started a huddle: https://space.northfield.example/r/k7m2qx9frtn4w6hbc8jd'), huddle: 'k7m2qx9frtn4w6hbc8jd' },
    ],
    21: [
      chat(325, ago(60 * 2), 'tessa', 'Staging link is in the channel topic.'),
      chat(326, ago(55), 'priya', 'Call for the walkthrough, whenever you are ready: https://space.northfield.example/r/jh4n8qw2xkzr7tbp5mcd'),
      chat(327, ago(50), 'tessa', 'The checklist is at https://docs.northfield.example/launch-checklist (the last line is the one that matters).'),
      chat(328, ago(40), 'priya', 'Booking form submits, but the confirmation email is blank.'),
      chat(329, ago(30), 'priya', 'Never mind, it was my spam folder.'),
      chat(330, ago(22), 'priya', 'Staging is up, please click through the booking form.'),
    ],
    22: [chat(318, ago(60 * 30), 'tessa', 'Renewal reminders are scheduled.')],
  }
  // The Clients part (stand-in-clients.ts), which the inbox stand-in reads its Clients from, so a Client made, renamed or archived in Settings is the same one in the menu and in People.
  const clientsPart = standInClients(fixtureClients(now), { now: () => now })
  // `two-people`: the same fixtures, shown to two people of a made-up team by who the request says it is (`x-dev-person`, src/app.ts): Alex is on every mailbox, Bea on Ridgeway's alone, anyone else on none.
  const seeing = mode === 'two-people' ? (address: string): MailScope | null => (address === 'alex@dev' ? { mailboxIds: null, unfiled: true } : address === 'bea@dev' ? scopeOf(['ridgeway'], false) : address === 'local@dev' ? { mailboxIds: null, unfiled: true } : null) : undefined
  // `calendar-mail`: the same fixtures and one person more, whose conversation holds an email with a calendar part of every kind the page draws as a card (fixture-calendar-mail.ts).
  if (mode === 'calendar-mail') {
    const calendarMail = calendarMailFixtures(now, options.zone ?? 'America/Los_Angeles')
    contacts.push(...calendarMail.contacts)
    threads.push(...calendarMail.threads)
  }
  const inbox = standInInbox(contacts, threads, { ...(seeing && { seeing }), drafts, withReading: true, withFiles: true, clients: clientsPart, ...(options.zone !== undefined && { zone: options.zone }), views: fixtureViews(now, mode === 'telegram-late' ? 'late' : mode === 'telegram-signed-out' ? 'signed-out' : 'live', mode === 'jmap-refused' ? 'refused' : mode === 'jmap-down' ? 'down' : 'live') })
  // Calls, invented: a huddle Tessa started in his direct message with Priya with two people in it (and in Today's "Happening now"), one that ended in #launch, a call link and a meeting in
  // Lena's email conversation, a meeting later today and one tomorrow, a New call with a row of its own, calls from before the space with their chat, and the month's usage. A link is on meet's
  // address and goes nowhere in a local run.
  const live = 'k7m2qx9frtn4w6hbc8jd'
  const callName = (n: number) => String(n).padStart(20, '0')
  const link = (name: string) => `https://space.northfield.example/r/${name}`
  const made = (name: string, kind: MeetCall['kind'], over: Partial<MeetCall>): MeetCall => ({
    name,
    link: link(name),
    kind,
    title: null,
    madeBy: { name: 'Tessa', mine: true },
    madeAt: ago(60),
    conversationId: null,
    home: null,
    startsAt: null,
    invitees: [],
    present: 0,
    people: 0,
    messages: 0,
    endedAt: null,
    openedAt: null,
    ...over,
  })
  const day = dayAround(now, 'America/Los_Angeles')
  // Later today is two hours on, or the last minute of the company's day; tomorrow is nine in the morning there.
  const laterToday = Math.min(now + 120 * MIN, day.next - MIN)
  const tomorrowNine = day.next + 9 * 60 * MIN
  const callsHeld: MeetCall[] = [
    made(live, 'huddle', { conversationId: 12, madeAt: ago(18), present: 2, people: 2, openedAt: ago(17) }),
    made(callName(2), 'huddle', { madeBy: { name: 'Priya', mine: false }, conversationId: 21, madeAt: ago(60 * 5), people: 3, messages: 4, openedAt: ago(60 * 5 - 1), endedAt: ago(60 * 5 - 13) }),
    made(callName(3), 'link', { home: 'lena@fischerbakery.example', madeAt: ago(25) }),
    made(callName(4), 'meeting', { title: 'Menu page review', home: 'lena@fischerbakery.example', madeAt: ago(24), startsAt: tomorrowNine, invitees: [{ name: 'Lena Fischer', address: 'lena@fischerbakery.example' }] }),
    made(callName(5), 'meeting', { title: 'Promotion walkthrough', conversationId: 11, madeAt: ago(60 * 20), startsAt: laterToday, invitees: [{ name: 'Dana Reyes', address: 'dana@harbordental.example' }] }),
    made(callName(6), 'meeting', { title: 'Hosting review', home: 'dana@harbordental.example', madeAt: ago(60 * 30), startsAt: tomorrowNine + 5 * 60 * MIN, invitees: [{ name: 'Dana Reyes', address: 'dana@harbordental.example' }, { name: 'Marcus Chen', address: 'marcus@harbordental.example' }] }),
    made(callName(7), 'new', { title: 'Weekly standup', madeAt: ago(15) }),
    // Made at /start before the space: no conversation, a title of none, and the chat it kept.
    made(callName(8), 'new', { madeAt: ago(60 * 24 * 3), people: 3, messages: 3, openedAt: ago(60 * 24 * 3 - 1), endedAt: ago(60 * 24 * 3 - 31) }),
    made(callName(9), 'new', { madeAt: ago(60 * 24 * 9), people: 2, messages: 0, openedAt: ago(60 * 24 * 9 - 2), endedAt: ago(60 * 24 * 9 - 22) }),
  ]
  const chats: Record<string, MeetCallMessage[]> = {
    [callName(2)]: [
      { id: 1, name: 'Priya', text: 'Can everyone see the booking form on staging?', at: ago(60 * 5 - 3) },
      { id: 2, name: 'Dana', text: 'Yes, and the confirmation email arrives now.', at: ago(60 * 5 - 5) },
    ],
    [callName(8)]: [
      { id: 1, name: 'Marcus', text: 'Sharing the parking sign photos in a minute.', at: ago(60 * 24 * 3 - 5) },
      { id: 2, name: 'Tessa', text: 'Got them. The third angle is the one for the homepage.', at: ago(60 * 24 * 3 - 12) },
      { id: 3, name: 'Marcus', text: 'Great, I will send the corrected hours after lunch.', at: ago(60 * 24 * 3 - 25) },
    ],
  }
  // The Phone: not set up (the Telnyx account is not opened), so it has nothing; `phone-on` shows what it holds once it is, with the dial pad over meet's stand-in browser phone.
  const phoneItems: MeetPhoneItem[] =
    mode === 'phone-on'
      ? [
          { id: 91, at: ago(50), kind: 'voicemail', text: 'Voicemail from (626) 555-0100, 0:42', number: '+16265550100', display: '(626) 555-0100', seconds: 42 },
          { id: 92, at: ago(35), kind: 'missed', text: 'Missed call from (626) 555-0142', number: '+16265550142', display: '(626) 555-0142', seconds: null },
        ]
      : []
  const phone: MeetPhoneSummary = { conversationId: 90, newest: phoneItems.length > 0 ? { at: ago(35), text: 'Missed call from (626) 555-0142' } : null, unread: phoneItems.length }
  const phoneStatus =
    mode === 'phone-on'
      ? {
          available: true,
          sdk: 'fake',
          line: '+16265550199',
          lineDisplay: '(626) 555-0199',
          callerName: 'Northfield Work',
          who: 'stand-in-who',
          acked: true,
          address: { street: '10 Main St', extended: '', city: 'Springfield', state: 'CA', zip: '91101' },
          registered: true,
          addressCheck: false,
          ready: true,
          minutes: { used: 38, cap: 1000 },
          notice: 'Calling 911 from meet may not work as a cell phone does. Use your cell phone for an emergency.',
          settings: { cell: null, cellDisplay: null, ringSeconds: 20 },
          canEditLine: true,
        }
      : undefined
  const meet = standInMeet(
    { direct, channels, phone, calls: [{ name: callName(7), link: link(callName(7)), title: 'Weekly standup', madeAt: ago(15) }] },
    {
      history,
      calls: [{ name: live, startedAt: ago(18), present: 2, why: 'started' }],
      callsHeld,
      legacy: [callName(8), callName(9)],
      chats,
      phoneItems,
      meter: { usedGb: 312.4, freeGb: 1000, tripGb: 800, paused: false, pausedUntil: null },
      ...(phoneStatus && { phoneStatus }),
      // Channel admin, invented: Tessa is the owner. #launch (Priya made it) has two teammates and three guests, one of them invited and not yet signed in; #ops is his own, private, with
      // two teammates; two open channels wait to be joined; Ben Walker is a teammate in neither.
      channels: {
        owner: true,
        people: [
          { id: 'p-priya', name: 'Priya Natarajan', kind: 'teammate', address: 'priya@northfield.example', direct: true },
          { id: 'p-quiet', name: 'Sam Ortiz', kind: 'teammate', address: 'sam@northfield.example' },
          { id: 'p-ben', name: 'Ben Walker', kind: 'teammate', address: 'ben@northfield.example' },
          { id: 'p-dana', name: 'Dana Reyes', kind: 'guest', address: 'dana@harbordental.example', invitedByMe: true, direct: true },
          { id: 'p-marcus', name: 'Marcus Chen', kind: 'guest', address: 'marcus@harbordental.example', invitedByMe: true, invited: true },
          { id: 'p-rosa', name: 'Rosa Whitfield', kind: 'guest', address: 'rosa_whitfield@yahoo.example' },
        ],
        rooms: {
          21: { createdByMe: false, members: ['p-priya', 'p-quiet', 'p-dana', 'p-marcus', 'p-rosa'] },
          22: { createdByMe: true, members: ['p-priya', 'p-quiet'] },
        },
        open: [
          { conversationId: 31, name: 'design', memberCount: 3 },
          { conversationId: 32, name: 'random', memberCount: 5 },
        ],
      },
    },
  )
  const doc = (id: string, title: string, state: DocumentSummary['state'], made: number, extra: Partial<DocumentSummary> = {}): DocumentSummary => ({
    id,
    title,
    state,
    createdAt: made,
    sentAt: state === 'draft' ? null : made + 5 * MIN,
    completedAt: null,
    signers: 1,
    signed: 0,
    notSigned: [],
    ...extra,
  })
  const forms = standInForms(
    [
    doc('e-draft', 'Website agreement, Lakeside Print Supply', 'draft', ago(60 * 3), { notSigned: ['Rosa Whitfield'], conversation: { app: 'inbox', id: 'c-rosa' } }),
    // Sent from Dana's conversation, so it is a card there; one out for signature, one signed and back. Hosting renewal was sent from Forms: Dana's page lists it, her conversation does not.
    doc('e-photo', 'Photo release, Harbor Dental', 'sent', ago(60 * 5), { signers: 2, notSigned: ['Dana Reyes', 'Marcus Chen'], conversation: { app: 'inbox', id: 'c-dana' } }),
    doc('e-hosting', 'Hosting renewal, Harbor Dental', 'sent', ago(60 * 24 * 2), { signers: 2, signed: 1, notSigned: ['Dana Reyes'] }),
    doc('e-agreement', 'Website agreement, Harbor Dental', 'completed', ago(60 * 24 * 4), { signers: 2, signed: 2, completedAt: ago(70), conversation: { app: 'inbox', id: 'c-dana' } }),
    doc('e-old', 'Terms of service update', 'completed', ago(60 * 24 * 9), { signers: 1, signed: 1, completedAt: ago(60 * 24 * 8) }),
    ],
    {
      recipients: {
        'e-draft': ['rosa_whitfield@yahoo.example'],
        'e-photo': ['dana@harbordental.example', 'marcus@harbordental.example'],
        'e-hosting': ['dana@harbordental.example', 'marcus@harbordental.example'],
        'e-agreement': ['dana@harbordental.example', 'marcus@harbordental.example'],
      },
    },
  )
  // To photograph the two notices: email that does not answer, and chat that answers no.
  if (mode === 'mail-down') {
    inbox.people = async () => {
      throw new Error('stand-in inbox is down')
    }
    inbox.contacts = async () => {
      throw new Error('stand-in inbox is down')
    }
  }
  if (mode === 'chat-refused') {
    meet.conversations = async () => refused('not-admitted', 'This is not open to you.')
    meet.liveCalls = async () => refused('not-admitted', 'This is not open to you.')
  }
  if (mode === 'forms-down') {
    forms.documents = async () => {
      throw new Error('stand-in forms is down')
    }
    forms.documentsIn = async () => {
      throw new Error('stand-in forms is down')
    }
  }
  // The knowledge app, for the Knowledge tab; `knowledge-down` is the notice for a part that does not answer.
  const knowledge = standInKnowledge(fixtureKnowledge(now), { now: () => now })
  if (mode === 'knowledge-down') {
    knowledge.methods.knowledge = async () => {
      throw new Error('stand-in knowledge app is down')
    }
  }
  // The calendar app, for the Calendar tab, Today's events and Settings, Calendars (stand-in-calendar.ts): four invented Google accounts and a week of events; `calendar-lapsed` has one account's sign-in ended, `calendar-down` is the notice
  // for a part that does not answer, and `calendar-empty` is four connected accounts with nothing on them.
  const calendar = standInCalendar(now, options.zone ?? 'America/Los_Angeles', mode === 'calendar-lapsed' ? 'lapsed' : mode === 'calendar-down' ? 'down' : mode === 'calendar-empty' ? 'empty' : '1')
  // What the Clients part asks of Forms (stand-in-forms-names.ts): Harbor Dental (7) is the one Client Forms signs for; with a real forms beside the preview its own rows are read instead.
  const formsNames = standInFormsNames([{ id: '77777777-7777-4777-8777-777777777777', number: 7, name: 'Harbor Dental', legalName: 'Harbor Dental Group, Inc.', replyTo: 'office@harbordental.example' }], options.formsAt ? { formsAt: options.formsAt } : {})
  return { inbox, meet, forms: options.formsAt ? withFormsAt(forms, options.formsAt) : forms, formsNames: formsNames.methods, formsNamesStandIn: formsNames, knowledge: knowledge.methods, calendar: calendar.methods, clients: clientsPart.methods, clientsStandIn: clientsPart }
}
