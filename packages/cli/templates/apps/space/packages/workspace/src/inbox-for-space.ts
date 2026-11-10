// What the inbox answers the space: the interface of the inbox's part of the space, method by method.
//
// This was once an RPC WorkerEntrypoint over a service binding (`SpaceInbox`), and every
// method took the Access assertion and verified it. Now the inbox's part runs IN THE SPACE'S WORKER (packages/inbox/src/space-part.ts; the space's ADR 0017), called in-process, and every method
// takes the person the space's ONE sign-in check named (`SignedIn`, ADR 0003 of this package), as meet's and forms' do. The inbox's mail, drafts, sending and read marks stay the
// inbox's; this is the part of them the space may ask for, in shapes taken from the inbox's store (packages/inbox/src/types.ts) and cut down to what the space draws. A field the
// store cannot fill is not here.
//
// EVERY METHOD takes the `SignedIn` first, then applies the inbox's own rule (packages/inbox/src/space-gate.ts). The methods that read or work the mail admit the install's owner and any other person of the install who is on at
// least one mailbox, and show them only the mail of the mailboxes they are on (packages/inbox/docs/adr/0004): every list, count, search, draft, file and notification
// is cut to them, and a conversation, message, contact or device they may not see answers `not-found` exactly as one that does not exist. The methods that change the install's setup (Claude's switch, the spam check's switch, the Gmail
// connection, restore, linking a Client, the contacts' writes, the operator's three) are the install's owner's alone, as `roleFor` in packages/inbox/src/workspace.ts has always had it; anyone else is `not-admitted`, and so is a
// person who is on no mailbox. Where a method below says "the owner's alone", read it as that. Every method answers a `SpaceReply`.
//
// TIMES are milliseconds since the epoch (the store keeps ISO text). ADDRESSES are `normalizeAddress`'s spelling, on the way
// out and on the way in. IDS are the inbox's own text ids.
//
// "PER ADDRESS": the space asks the inbox "per address". The store keys people by CONTACT, who has any number of
// identities, and the space joins on any of a contact's addresses; so `people` answers one entry per contact with all of that
// contact's email addresses, and a caller that has one address asks with `scope.addresses`.

import type { ComposeKey, Failed, Refused, SignedIn, SpaceReply, WriteReply } from './asking'
import type {
  InboxChat,
  InboxChatAnswer,
  InboxChatTurn,
  InboxClaudeSending,
  InboxClientPage,
  InboxClients,
  InboxDevice,
  InboxDeviceInput,
  InboxGmail,
  InboxGmailChange,
  InboxGmailChanged,
  InboxGmailSignIn,
  InboxMailboxes,
  InboxNav,
  InboxNotifications,
  InboxRestoreChoice,
  InboxRestoreDone,
  InboxRestorePlan,
  InboxRestoreReport,
  InboxSpamCheck,
  InboxTestSent,
  GmailPurpose,
} from './inbox-views'
import type { InboxContactProfile, InboxContacts, InboxContactsScope, InboxMerge, InboxMerged, InboxProfileEdit, InboxRename, InboxSplit, InboxSplitDone, InboxUnmerged } from './inbox-people'
import type { FileRange } from './files'
import { MAILBOX_ID } from './inbox-views'
import type { ClientRef, MailKind } from './rows'

/** A mailbox as a conversation carries it (the inbox's `MailboxMark`): one of the owner's Gmail accounts (named by its short label) or a business mailbox (a business's own address). It is the pill. */
export interface InboxMailbox {
  id: string
  name: string
  address: string
}

/** Someone else on a conversation: a contact. `address` is their email address, or null for a contact known only by a number or a handle. */
export interface InboxParty {
  contactId: string
  name: string
  address: string | null
}

/**
 * What to include besides the main list. The main list is open conversations that are not Bulk, of every mailbox (the inbox's
 * `inbox` view); Bulk and Closed are behind filters, so they come only when asked.
 */
export interface InboxScope {
  include?: readonly ('bulk' | 'closed')[]
  /**
   * The Sent view: ONLY the conversations the owner sent a message in, open or closed, Bulk or not (`include` is then ignored), newest send first. Each line is the conversation as of the
   * newest sent message: its `at` is when the owner sent it, its `snippet` is its words, its `direction` is `out`. Cut at the same screen as the other lists. ABSENT from an inbox that predates it.
   */
  sent?: boolean
  /**
   * The Drafts view: ONLY the conversations that hold a draft waiting, whatever state they are in (open, closed or Bulk; `include` is then ignored), which are the conversations the menu's Drafts
   * counts. Cut at the same screen as the other lists, so `more` is true only when there are more such conversations than a screen. ABSENT from an inbox that predates it, which answers its
   * main list and so may leave a conversation with a draft out.
   */
  drafts?: boolean
  /** Only the contacts that have one of these addresses. Normalised by the inbox again; an entry that is no email address is ignored. */
  addresses?: readonly string[]
  /**
   * Only these contacts, by the inbox's own ids (`InboxPerson.contactId`, which a link to a person with no address names as `mail:<contact id>`). With `addresses` it is both: a contact that
   * has one of the addresses or is named here. Like `addresses` it narrows BEFORE the screen of newest conversations is cut, so a person whose conversations are all older than the newest
   * screenful is still found. An entry that is no id of the inbox's shape is ignored; at most 100.
   */
  contactIds?: readonly string[]
}

/** One conversation as a person's entry lists it. */
export interface InboxThreadLine {
  conversationId: string
  /** The newest message's subject; "" for a text or a manual note. */
  subject: string
  kind: MailKind
  /** The newest message's time, a draft not counted. */
  at: number
  /** The newest message's text on one line, at most SNIPPET_CHARS. */
  snippet: string
  /** Whether the newest message came in (`in`) or went out (`out`): "waiting on you" is an `in` that is unread or open. */
  direction: 'in' | 'out'
  unread: boolean
  open: boolean
  bulk: boolean
  /** Drafts waiting on it. */
  drafts: number
  mailbox: InboxMailbox | null
  /** The other people on it, so a thread shared with others reads "with ..." under the person it is listed under. */
  alsoOn: InboxParty[]
  /**
   * Whether the lists put this conversation under THIS person : a thread with several people on it is listed once, under the one who last
   * wrote on it, an outsider before the owner's own addresses and the team, a person with a name before a bare address when they tie (`placedUnder`). False means it is listed under someone in
   * `alsoOn` and a list leaves this line out; the person's own page still shows it.
   */
  listed: boolean
  /**
   * Whether a CLIENT's list puts this conversation under this person: in a Client's list the thread is placed among that Client's people only (the contacts linked to the Client on it), by the
   * same rule, so a thread a Client's person is on is never lost from the Client's list because an outsider wrote last. True for a person with no Client linked (a Client's list keeps only its own people, so there is nothing to place).
   */
  listedInClient: boolean
  /**
   * What kind of Telegram chat this is when it is one with many people in it: `group` (one row under the group's name, each message showing who wrote
   * it) or `channel` (a broadcast the owner follows; Bulk, and no reply box). ABSENT for everything else, a one-to-one Telegram chat included, and from an inbox that predates it.
   */
  telegramChat?: 'group' | 'channel'
  /**
   * For a `group` only: whether it is waiting on the owner, which is that a message addressed to them (a mention of them, or a reply to one of their messages) came in after their last message there.
   * Where present it replaces what `direction` says for Needs reply; ABSENT everywhere else, where the newest message's direction says it.
   */
  needsReply?: boolean
}

/** The newest item of a person's entry: always the first of `conversations`, stated so a caller need not look. */
export interface InboxNewest {
  conversationId: string
  at: number
  kind: MailKind
  direction: 'in' | 'out'
  subject: string
  snippet: string
}

/** A contact with at least one conversation in scope, with what the space's row needs of them. */
export interface InboxPerson {
  contactId: string
  name: string
  /** Every email address the contact has, normalised, sorted. Empty for a contact with only a number or a handle. */
  addresses: string[]
  client: ClientRef | null
  /**
   * The Client the inbox only SUGGESTS for this contact (its own suggestion: their address is the Client's sign-in address, or people at their domain are already linked to
   * that Client), when they have none linked. Display only: a suggestion counts for nothing until somebody confirms it, which is the inbox's Link. Null when there is none, the Clients part did not answer, or the contact has a Client; ABSENT from an inbox that predates it, read as null.
   */
  suggestedClient?: ClientRef | null
  newest: InboxNewest
  /** How many of `conversations` are unread. The inbox keeps no count of messages. */
  unread: number
  /** The conversations in scope that the contact is on, newest first. */
  conversations: InboxThreadLine[]
}

export interface InboxPeople {
  people: InboxPerson[]
  /** There were more conversations than one screen of them (the store's QUEUE_PAGE), so the list is the newest. */
  more: boolean
}

/** Who to open: a contact the space already holds the id of, or an address (any of the contact's). */
export type InboxWho = { contactId: string } | { address: string }

/**
 * One conversation in a person's history, with the position `markRead` and a reply name: the inbox refuses both when mail
 * arrived after it (`conflict`), so nothing is read or answered unseen.
 */
export interface InboxThread {
  conversationId: string
  subject: string
  kind: MailKind
  /** The store's `through`: how far into the conversation this answer reaches. Sent back, not interpreted. */
  through: number
  unread: boolean
  open: boolean
  bulk: boolean
  mailbox: InboxMailbox | null
  alsoOn: InboxParty[]
  /** Whether a reply can be sent: false for a conversation with no mailbox (a text, a manual note), which the inbox cannot send on. */
  canReply: boolean
  /** As on `InboxThreadLine`: a Telegram group or channel. A channel has no reply box; ABSENT for everything else. */
  telegramChat?: 'group' | 'channel'
  /**
   * Whether a reply on it may carry files: true only for a conversation in a business mailbox, which sends through
   * Cloudflare. The owner's own Gmail sends without files from here (sending files from the Gmail mailbox is not supported). ABSENT from
   * an inbox that predates it: read as false, so the composer offers no Attach.
   */
  canAttach?: boolean
  /**
   * Whether a reply on it takes ONE picture: true for a Telegram chat with a person or a group that has a reply box, sent as a Telegram photo. The picture goes the same
   * way a business mailbox's files do (`InboxSend.attachments`, one file of at most `INBOX_PICTURE_MAX_BYTES`, a PNG or a JPEG, with the words as its caption of at most `INBOX_CAPTION_MAX`). `canAttach` stays the business
   * mailboxes' (several files, any type). ABSENT for everything else and from an inbox that predates it: read as false, so the composer offers no picture.
   */
  canPicture?: boolean
  /**
   * Whether the inbox's own page would draw "Mark as spam" (or "Move to the Inbox" for one in Bulk) over this conversation, so the space draws exactly that: it is in a mailbox, and it is in Bulk or has no
   * contact linked to a Client (a Client's people are never Bulk, so a call on one would move nothing). ABSENT from an inbox that predates it: read as false, so no button is drawn.
   */
  canMarkSpam?: boolean
}

/** A message's text as the inbox's page reads it: what the sender wrote now, and the earlier email quoted under it that the page folds behind "...". */
export interface InboxRead {
  /** What the sender wrote, as shown. The whole message when `quoted` is ''. */
  visible: string
  /** The quoted email as shown, or '' when nothing is folded. */
  quoted: string
}

/**
 * A file on a message, by its place in the message's list (`attachment`'s `index`). Names and sizes only: the bytes come from `attachment`, which checks who
 * is asking. `type` is the type the sender's client declared, a hint and nothing more. `picture` is the inbox's own guess that it is worth asking for as a picture
 * (PNG, JPEG, GIF or WebP, by the declared type or the name, and small enough), so the space applies none of those rules itself; the bytes still decide.
 */
export interface InboxAttachment {
  name: string
  size: number
  type: string
  picture: boolean
  /**
   * Whether `attachment` will give ANY file of this message to save (`how: 'download'`): true for mail that came through a business mailbox, whose kept copy holds the
   * bytes; false for the owner's Gmail, where Gmail holds the only copy and its other files open in Gmail. A caller offers a download only when it is true, and shows the
   * file by name alone otherwise.
   */
  download: boolean
  /**
   * True when the message came through a business mailbox but is too large for the inbox to open a file from (over 10 MB in all; the whole message is kept in the
   * raw-mail bucket): `picture` and `download` are then false and the file is named only, with a word that it is too large and not one that it opens in Gmail.
   * ABSENT otherwise, and from an inbox that predates it.
   */
  tooLarge?: boolean
  /**
   * A voice note from Telegram the inbox has copied: worth a player, asked for with `how: 'view'` like a picture and served as audio. ABSENT on everything else and from an
   * inbox that predates it. `seconds` is its length, for the label.
   */
  play?: boolean
  /**
   * A video from Telegram the inbox has copied: worth an inline player, asked for with `how: 'view'` and served as video (MP4, QuickTime or WebM, by its first bytes) in ranges. ABSENT on everything else
   * and from an inbox that predates it. `seconds` is its length, for the label.
   */
  video?: boolean
  seconds?: number
  /**
   * The one plain line the inbox says under a file it is not showing, in words ("Too large to copy. Open it in Telegram."). ABSENT on a file that is shown and on every Gmail or Cloudflare file, which the page
   * words itself from `tooLarge` and `download`.
   */
  note?: string
}

/** What Cloudflare reported of one recipient of a message the inbox sent as a business mailbox: the event names its Email Sending queue publishes, less the prefix. */
export const DELIVERY_STATES = ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** What each report says, before the address: the one wording of it, used by the inbox's own page and by the space. */
export const DELIVERY_WORDS: Record<DeliveryState, string> = {
  delivered: 'Delivered to',
  deferred: 'Delayed, still trying',
  bounced: 'Bounced: it did not reach',
  failed: 'Failed: it did not reach',
  rejected: 'Refused before it was sent to',
  complained: 'Marked as spam by',
}

/** One line for one recipient's report: the words, who, and (unless it was delivered) the reason Cloudflare gave. Text, never markup. */
export const deliveryLine = (n: { recipient: string; state: DeliveryState; reason: string }): string =>
  `${DELIVERY_WORDS[n.state]} ${n.recipient}${n.reason !== '' && n.state !== 'delivered' ? ` (${n.reason})` : ''}`

/** The states that mean the person did not get it, or did not want it: shown on the message as a problem. `deferred` is not one: it is a retry in progress. */
export const DELIVERY_PROBLEMS: readonly DeliveryState[] = ['bounced', 'failed', 'rejected', 'complained']

/** How one recipient's copy of a message went, as the newest report the inbox holds for them says. */
export interface InboxDeliveryNote {
  /** The address it went to (or was to go to). */
  recipient: string
  state: DeliveryState
  /** Cloudflare's reason in its own words (a receiving server's answer, "suppressed"), or ''. Text, never markup. */
  reason: string
  /** When Cloudflare reported it. */
  at: number
}

/** One message sent or received. A draft is not a message here; it is in `drafts`. */
export interface InboxMessage {
  id: string
  conversationId: string
  subject: string
  direction: 'in' | 'out'
  /** When it was sent or received. */
  at: number
  /** The sender as the message wrote it ("Ines <i@x.example.com>"), or the contact's name for a note. */
  from: string
  /** Plain text, cut at the store's cap. */
  text: string
  textCut: boolean
  /**
   * How the inbox's own page reads this message, made by the same code (`readText`, which folds a quote the way the page does
   * and puts a mail client's hard line wraps back): what the sender wrote now, and the earlier email quoted under it, which the
   * page folds behind "..." (`quoted` is '' when nothing is folded and `visible` is then the whole message). The quote is
   * proved against the earlier messages of the same conversation, all of them and not only this page, so it folds the same
   * whatever page the caller holds. ABSENT from an inbox that predates it: a caller draws `text` whole then.
   */
  read?: InboxRead
  /** Who an outgoing message went to, as its header wrote it ("Name <a@x.example.com>"). Absent on a message received, a note, and an inbox that predates it. */
  to?: string
  /**
   * The files on it. ABSENT from an inbox that predates it, and left out when there are none: a caller then draws no files. For a message that came
   * through a business mailbox the bytes are the message's own kept copy; for one in the owner's Gmail they are fetched from Gmail, and only pictures.
   */
  attachments?: InboxAttachment[]
  /**
   * How a message this inbox SENT AS A BUSINESS MAILBOX went, one note per recipient Cloudflare has reported on. ABSENT when nothing was reported
   * (the owner's Gmail raises no such reports, a message received has none, and an inbox that predates it never sent it): a caller then says nothing.
   */
  delivery?: InboxDeliveryNote[]
  /**
   * True on a text or a direct message (never an email, even one the Outbox carried in as sent by hand) the owner marked sent by hand (`markDraftSent`): the inbox's page offers "Not sent after all" on it, and the space does (`unmarkSent`). ABSENT
   * from an inbox that predates it, and left out when false: a caller then offers no way back.
   */
  sentByHand?: boolean
  /** True on a Telegram message its sender edited (the text above is the new one). ABSENT otherwise, and from an inbox that predates it. */
  edited?: boolean
  /** True on a Telegram message its sender deleted for everyone: the words are gone and the row stays, so the history shows that one was deleted. ABSENT otherwise. */
  deleted?: boolean
  alsoOn: InboxParty[]
}

/**
 * The most conversations one `markRead`, `closeConversations` or `reopenConversations` names: a screen, not a script. The inbox refuses a longer
 * list, and the space refuses it first, from this one number.
 */
export const INBOX_MOST_MARKS = 100

/** A page of messages is this many at most, as meet's history is (`HISTORY_PAGE`). */
export const INBOX_HISTORY_PAGE = 50

export interface InboxHistoryQuery extends Pick<InboxScope, 'include'> {
  /**
   * The id of the OLDEST message the caller holds: the page returned is the newest `INBOX_HISTORY_PAGE` messages before it, in
   * the store's order (time, then id). Omitted means the newest page. Meet's history pages the same way, by message id.
   */
  before?: string
}

export interface InboxHistory {
  /**
   * The person's conversations in scope, newest first, whatever page: each `through` is the position as of this answer. Pages
   * go back in time and the first holds the newest messages, so the `through` of an answer that included the newest page is
   * what `markRead` and a reply name.
   */
  threads: InboxThread[]
  /** Their messages across those threads on this page, oldest first. */
  messages: InboxMessage[]
  /** There are older messages than the first of these; ask again with `before` set to its id. */
  more: boolean
}

/** Someone a message goes to, as the draft names them: the name the inbox knows them by (the address when it knows none), and the address. */
export interface InboxAddress {
  name: string
  address: string
}

/** Who wrote a draft: the owner (the first of `DRAFT_AUTHORS`), Claude, the assistant in the inbox's draft chat, or the outbox (a send Gmail never confirmed). */
export const DRAFT_AUTHORS = ['owner', 'claude', 'outbox', 'assistant'] as const
export type DraftAuthor = (typeof DRAFT_AUTHORS)[number]

/**
 * A draft waiting on the owner (Claude's, the assistant's, their own) or a send Gmail never confirmed. It carries NO `through`: a draft
 * would otherwise let a send name how far someone read a thread nobody opened, which gets past the inbox's rule that nothing is
 * answered unseen. To send a draft on a conversation the space opens the thread first (`messagesWith`, asking with `include`
 * `'closed'` or `'bulk'` for a closed or Bulk one) and takes `InboxThread.through` from the answer.
 */
export interface InboxDraft {
  id: string
  /** The conversation it sits on, or null for a new email to a contact (and a text or a DM). */
  conversationId: string | null
  contactId: string
  toName: string
  /** Where it goes: the email address, or a number or handle. */
  to: string
  /**
   * Everyone else it is copied to (a draft made with `copyEveryone` carries a Cc). **A draft that goes to people the person asking has not been
   * shown must not be sent from the space as it stands**, so a caller that offers the held-draft send shows `to` and every entry here first.
   * Empty when it copies no one. A caller that finds it ABSENT (an inbox that predates it) must treat the draft as not sendable from here.
   */
  cc: InboxAddress[]
  subject: string
  text: string
  /** The revision a send must name, or the inbox refuses (`conflict`). */
  rev: number
  author: DraftAuthor
  /**
   * A send whose outcome was never confirmed (`sending`): it waits for the owner to say whether it went out, and is sent again by nobody. A Telegram send that is still going out is NOT stuck: it is `sending: true`
   * below, and only once it can no longer land (the bridge's offers, its timeout and its restart have all passed) does it become stuck, shown as "check Telegram".
   */
  stuck: boolean
  /**
   * A Telegram send that is claimed and still going out (the bridge may yet send it): the card says "Sending on Telegram" and offers nothing, and the owner cannot answer for it. `stuck` is false then. ABSENT
   * otherwise, and from an inbox that predates it.
   */
  sending?: boolean
  at: number
  /** Why it was drafted, as the inbox's own card shows it (Claude's reason). ABSENT from an inbox that predates it. */
  why?: string
  /** Somebody other than its author changed its words (`'claude'` edited the owner's, the owner edited Claude's), or null. ABSENT from an inbox that predates it: read as null. */
  editedBy?: DraftAuthor | null
  /** Whether it can copy everyone on the message it answers: an email draft on a conversation. Whether it does is `cc`. ABSENT from an inbox that predates it: read as false. */
  canCopyEveryone?: boolean
  /**
   * How it goes: `email` (the inbox sends it), or `sms` or `manual` (a text, a LinkedIn or other direct message, which the inbox CANNOT send: the owner sends it themselves and marks it sent,
   * `markDraftSent`). ABSENT from an inbox that predates it: a caller then offers no Mark sent and treats the draft as it did before.
   */
  kind?: MailKind
  /**
   * The business mailbox's address a stuck send went out of (Cloudflare did not say whether it went), as the inbox's own card names it: there is no Sent folder for those, so the words say to ask the recipient.
   * ABSENT for a send through the owner's Gmail, and from an inbox that predates it: the card then speaks of Gmail Sent.
   */
  sentFrom?: string
  /**
   * The account the draft goes out from, of either kind, so the card can say "from northfield" before Send is pressed: a reply's is the one its conversation is in, a new email's the one
   * recorded when it was made. Unlike `sentFrom` it says nothing about how a stuck send is settled. ABSENT from an inbox that predates it, and for a draft that records none and sits
   * on no conversation (made before there were several Gmail accounts).
   */
  sendsFrom?: { name: string; address: string }
  /**
   * The picture a Telegram draft carries: its type and length, so the card can show it (the bytes come from `attachment` for this draft's id, index 0, for the owner alone)
   * and say that it is there. Claude can put one on a draft, and the card then says whose draft it is as it says for the words. ABSENT for a draft with none, and from an inbox that predates it.
   */
  picture?: { type: string; size: number }
  /**
   * On a Telegram draft that went back to being a draft because Telegram would not take it (the bridge reported a refusal after the press had been answered `sending`): why, in words for the person, shown
   * on the card. ABSENT otherwise, and from an inbox that predates it.
   */
  refusal?: string
}

/**
 * How a send Gmail never confirmed went, said by the one person who looked in Gmail Sent (the inbox's own `resolve-send`): `sent: true` removes the stuck draft (Gmail's copy is the record; a
 * Cloudflare send is filed as sent on the owner's word), `sent: false` makes it a draft again. A boolean is required, so an empty request can never mean either. `conflict` for a message that is not waiting
 * on a send (resolved already, or never stuck) and, for `sent: false`, when Gmail already holds a copy of it (it did go out); `not-found` for no such message. Nothing is sent. Audited as the owner's.
 */
export interface InboxSendResolution {
  draftId: string
  sent: boolean
}

/** Where a stuck send stands after it was resolved: `removed` (it went out; Gmail's copy is the record), `draft` (it did not; it is a draft again), `sent` (a business mailbox's, filed as sent). */
export interface InboxSendResolved {
  id: string
  status: 'removed' | 'draft' | 'sent'
}

/**
 * Where a draft's link opens (`draftAt`). `draft`: it is still waiting, on a conversation or on none, and this is the draft as it now stands. `filed`: the message is no
 * longer a draft but sits on a conversation (it was sent, or marked sent by hand), so a link made while it was a draft opens that conversation instead. A message that
 * is gone is `not-found`: deleted, or a send Gmail never confirmed that the owner then said went out (the inbox removes that draft, and Gmail's own copy, which arrives by sync, is the record). Carries no `through`, as `InboxDraft` does not.
 */
export type InboxDraftAt = { state: 'draft'; draft: InboxDraft } | { state: 'filed'; contactId: string; conversationId: string }

/** What a hand-sent mark or its undo changed: the message, and the conversation it sits on (null for a draft on none). */
export interface InboxHandSent {
  messageId: string
  conversationId: string | null
}

/**
 * A change to the words of a draft: its subject, its body, or both, at the revision the person was shown. The same edit the inbox's own draft card makes
 * (`PATCH /api/drafts/:id`): `conflict` (nothing changed) when the draft has moved on since (Claude or the assistant edited it, or another tab), so words are never saved over
 * a change the person has not seen; `bad-request` for no change at all, a body left empty (a draft needs a body), a subject past the inbox's limit, or an id that is no draft;
 * `conflict` also for a draft that is no longer one (sent, or `sending`: "Only a draft can be edited"); an id that names no draft is `not-found`. The answer is the draft as it stands, with its new revision, which the
 * next send names. A write, but it sets values and names a revision, so twice is a `conflict` and never twice applied: it carries no compose key. It sends nothing. An em dash
 * is not refused here (the inbox's own card saves it too); the SEND refuses it, in the inbox's words.
 */
export interface InboxDraftEdit {
  draftId: string
  rev: number
  subject?: string
  text?: string
  /** Copy everyone on the message it answers (true: the inbox recomputes the Cc) or no one (false: cleared), as the inbox's card has it. Only on an email draft on a conversation. Left out: the Cc stays as it is. */
  copyEveryone?: boolean
  /** Take the draft's picture out (a Telegram draft that carries one), in the same change as the rest of the edit; `true` only. The edit may then change nothing else (the picture is what it changes). */
  takeOutPicture?: boolean
}

/**
 * Put ONE picture on a Telegram draft, or replace the one it has, at the revision the card shows: a PNG or a JPEG by its first bytes, at most `INBOX_PICTURE_MAX_BYTES`. An edit of the draft like
 * an edit of its words: the revision rises, `conflict` when the draft has moved on, `bad-request` for a file that is not a picture or is too large and for a draft that is not on a Telegram chat that takes one. The
 * answer is the draft as it stands. Taking the picture out is `InboxDraftEdit.takeOutPicture`.
 */
export interface InboxDraftPicture {
  draftId: string
  rev: number
  picture: InboxFile
}

/** What `setSpam` is asked: a conversation, and whether it is spam. A boolean is required, so an empty request can never mean either. */
export interface InboxSpamMark {
  conversationId: string
  spam: boolean
}

/**
 * What a spam call moved. `spam` is the call that was made. `bulk` is where the conversation stands AFTER it (the inbox's own rules decide: a Client's people are never Bulk, so a
 * spam call on one leaves it in the Inbox, and a not-spam call on a newsletter leaves it in Bulk because of its header). `reasons` are the lines the inbox's page shows over the
 * conversation, why it is where it is. Nothing is deleted either way, and for Gmail nothing is changed in Gmail: it is the inbox's own view.
 */
export interface InboxSpamResult {
  conversationId: string
  spam: boolean
  bulk: boolean
  reasons: string[]
}

/**
 * One send, in the three shapes the inbox's own Send has. Each is the owner pressing Send: the inbox makes the draft first, as it
 * does for a reply typed in its own page, and sends it by the transport of the mailbox it is from. The rules are the inbox's:
 * a reply goes from the mailbox its conversation is in, a new email from the mailbox the contact last wrote to.
 *
 * EVERY VARIANT CARRIES `key`, a `ComposeKey` the space chose once for this compose. The inbox HOLDS the key (at least
 * `COMPOSE_KEY_KEPT_MS`) only while its first use may have sent something: in progress, sent, or the inbox's own `sending`. A
 * second use of a held key answers `Repeated` and nothing new is drafted or sent. A first use that was REFUSED (`conflict`,
 * "a new message arrived, read it and press Send again", or any other refusal) or FAILED (`broken`, nothing went out) RELEASES
 * the key, and pressing Send again with it sends. When the inbox cannot tell (Gmail timed out mid-send) it answers success with
 * status `sending` and holds the key. The inbox's own safety checks do not stop a repeat: they look only at inbound mail after
 * `through`, so the same `through` twice would make a second draft and send a second email.
 * **A TEST MUST PROVE BOTH CASES**, for each variant: a refused first use followed by the same key sends; a sent,
 * in-progress or `sending` first use followed by the same key answers `Repeated` and sends nothing new (including a repeat that
 * arrives while the first still waits on Gmail). An in-progress record older than `WRITE_WITHIN_MS` answers as done with
 * status `sending`.
 */
export type InboxSend =
  /** A draft the inbox already holds (Drafts, Today). `through` is the thread's own, `InboxThread.through`; null for a draft on no conversation. */
  | { key: ComposeKey; draftId: string; rev: number; through: number | null }
  /**
   * A reply in a thread the person chose (choosing the thread when there are several). `copyEveryone` as the composer has it.
   * `attachments` are the files that go with it: ONLY on a thread whose `InboxThread.canAttach` is true. On any other the inbox refuses (`bad-request`) and sends nothing, so
   * files are never dropped quietly from a send that goes out without them. At most `INBOX_MOST_FILES` files, `INBOX_MOST_FILE_BYTES` together. On a thread whose `canPicture` is true (a Telegram chat), `attachments` is ONE
   * picture instead (`INBOX_PICTURE_MAX_BYTES`, a PNG or a JPEG) and `text` is its caption (`INBOX_CAPTION_MAX`), which may be empty when a picture is there.
   */
  | { key: ComposeKey; conversationId: string; through: number; subject?: string; text: string; copyEveryone?: boolean; attachments?: readonly InboxFile[] }
  /**
   * A new email to an address, which becomes a contact if it is new. `from` is the mailbox it goes out from, chosen by the person: one of the owner's Gmail accounts (by its id, `InboxGmail.id`; none names the default account) or a business mailbox by its
   * id (`InboxMailbox.id`, from `mailboxes`). The sender is always the mailbox's own address, never anything typed. ABSENT is the inbox's own rule: the mailbox the contact last
   * wrote to (a customer hears from the business's address, a client from the owner), Gmail when none. `attachments` are the files that go with it: ONLY from a business mailbox (explicitly chosen by
   * `from`, or the one the rule picks), which sends through Cloudflare; from Gmail the inbox refuses (`bad-request`) and sends nothing, as for a reply. Same limits as a reply's
   * (`INBOX_MOST_FILES`, `INBOX_MOST_FILE_BYTES`). A `from` that names no business mailbox is `bad-request`.
   */
  | { key: ComposeKey; address: string; name?: string; subject: string; text: string; from?: InboxFrom; attachments?: readonly InboxFile[] }

/** Which mailbox a new email goes out from, as the person chose it. */
export type InboxFrom = { kind: 'gmail'; mailboxId?: string } | { kind: 'business'; mailboxId: string }

export const NOT_A_FROM = 'A new email goes from one of the Gmail accounts or from one of the business mailboxes (from).'

/**
 * The one reading of a `from`, for the space and the inbox: absent is the inbox's own rule (`from` undefined), Gmail, or a business mailbox by an id of the shape ids have
 * (`MAILBOX_ID`); anything else, an address typed included, is not one.
 */
export function readInboxFrom(raw: unknown): { ok: true; from: InboxFrom | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, from: undefined }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    if (r.kind === 'gmail') {
      // A Gmail account by its id; without one, the inbox's default account (the owner's own address while it is connected).
      if (r.mailboxId === undefined) return { ok: true, from: { kind: 'gmail' } }
      if (typeof r.mailboxId === 'string' && MAILBOX_ID.test(r.mailboxId)) return { ok: true, from: { kind: 'gmail', mailboxId: r.mailboxId } }
      return { ok: false, message: NOT_A_FROM }
    }
    if (r.kind === 'business' && typeof r.mailboxId === 'string' && MAILBOX_ID.test(r.mailboxId)) return { ok: true, from: { kind: 'business', mailboxId: r.mailboxId } }
  }
  return { ok: false, message: NOT_A_FROM }
}

/** A file to send with a reply or a new email: its name, the type the person's browser gave it, and its bytes. The inbox cleans the name and the type again before they go anywhere. */
export interface InboxFile {
  name: string
  type: string
  bytes: Uint8Array
}

/**
 * The most files one send carries, and the most bytes they may come to together. Cloudflare takes 32 attachments and 25 MiB for the whole message, base64 and
 * headers included, which is a third more than the files themselves; 15 MiB of files stays inside it with room for the words. Written once: the inbox
 * refuses past it, and the space refuses first.
 */
export const INBOX_MOST_FILES = 10
export const INBOX_MOST_FILE_BYTES = 15 * 1024 * 1024

/**
 * What a Telegram reply may carry, said by the page before Send and refused by the inbox again, each by the bytes where it holds them: ONE picture, a PNG or a JPEG, at most
 * `INBOX_PICTURE_MAX_BYTES` (Telegram's limit for a photo), with the words typed under it as its caption, at most `INBOX_CAPTION_MAX` characters (words alone stay at Telegram's 4,096). A send is never split in two.
 * The inbox's own numbers are `TELEGRAM_PICTURE_MAX_BYTES` and `TELEGRAM_CAPTION_MAX` (packages/inbox/src/telegram/wire.ts); `packages/inbox/test/telegram-pictures.test.ts` holds the two spellings equal.
 */
export const INBOX_PICTURE_MAX_BYTES = 10 * 1024 * 1024
export const INBOX_CAPTION_MAX = 1024
/** The types the page offers for a picture: what a Mac screenshot (PNG) and a phone photo (JPEG) are. The inbox decides by the first bytes. */
export const INBOX_PICTURE_TYPES = ['image/png', 'image/jpeg'] as const

/**
 * How `attachment` hands a file back. `inline` is true only for a picture the inbox has checked by its first bytes and named by the type THEY say (never the
 * sender's word); anything else is a download (`inline` false, `type` always `application/octet-stream`), so what a stranger attached can run nothing in the
 * space's own page.
 */
export interface InboxFileOut {
  name: string
  type: string
  inline: boolean
  /** The file, or only the part of it named by `part` (a Telegram video is read in parts: see `INBOX_FILE_PART_BYTES`). */
  bytes: Uint8Array
  /** The length of the whole file. Set when `part` or `unsatisfiable` is. */
  total?: number
  /** `bytes` is the part [first, last] (inclusive) of the file, not all of it. Answered when a range was asked for, and also (for a file over `INBOX_FILE_WHOLE_BYTES`) when none was: the caller then asks for the rest, part by part. */
  part?: { first: number; last: number }
  /** The range asked for is not inside the file: `bytes` is empty. */
  unsatisfiable?: true
}

/**
 * How a file is handed from the inbox to the space: whole when it is at most `INBOX_FILE_WHOLE_BYTES`, else in parts of at most `INBOX_FILE_PART_BYTES`. A Durable Object's RPC carries 32 MiB at most (Cloudflare's
 * limit), the Worker is 128 MB with everything else in it, and a range such as `bytes=0-` asks for all of a file, so no answer is more than a part: a browser that wants the rest asks again, and a whole download
 * is read part by part. Written once: the inbox cuts at these, the space follows them.
 */
export const INBOX_FILE_WHOLE_BYTES = 10 * 1024 * 1024
export const INBOX_FILE_PART_BYTES = 8 * 1024 * 1024

export interface InboxSent {
  messageId: string
  conversationId: string
  /**
   * `sending`: the inbox could not tell whether it went. For Gmail, Gmail never said, shown as "check Gmail Sent" and settled by the owner, never retried. For a Telegram conversation it is the ordinary
   * answer: the draft is claimed and owed to the Telegram bridge, which sends it within seconds (the conversation then shows it, by the live page); if the bridge never reports, it is shown as "check
   * Telegram" after five minutes and settled by the owner, never retried by anything.
   */
  status: 'sent' | 'sending'
}

/** One conversation to mark read, at the position the caller read to (`InboxThread.through`). */
export interface InboxReadMark {
  conversationId: string
  through: number
}

export interface InboxReadResult {
  read: string[]
  /**
   * Each one not marked, and why, as the same shapes every answer has: a `Refused` (`conflict` when mail arrived after `through`;
   * `bad-request` when `through` is past the end of the conversation, the store's 422; `not-found`; `not-admitted`) or a
   * `Failed` (`broken`, when Gmail would not take the change for that one conversation). One item's trouble never fails the rest.
   */
  notRead: { conversationId: string; outcome: Refused | Failed }[]
}

/** One conversation to close, at the position the caller read to (`InboxThread.through`), as the inbox's own Close names it. */
export interface InboxCloseMark {
  conversationId: string
  through: number
}

export interface InboxCloseResult {
  closed: string[]
  /**
   * Each one not closed, and why, as the same shapes every answer has: a `Refused` (`conflict` when mail arrived after `through`, which is
   * the inbox's "a new message arrived on this conversation, so nothing was changed"; `bad-request` when `through` is past the end of the
   * conversation; `not-found`; `not-admitted`) or a `Failed` (`broken`, when Gmail would not take the change for that one conversation).
   * One item's trouble never fails the rest.
   */
  notClosed: { conversationId: string; outcome: Refused | Failed }[]
}

export interface InboxReopenResult {
  reopened: string[]
  /** Each one not reopened, and why: `not-found`, `conflict` (everything in it is in the trash or spam), or `broken` (Gmail would not take it). */
  notReopened: { conversationId: string; outcome: Refused | Failed }[]
}

/** One conversation that matched a search, with the line of the newest message that has one of the words. */
export interface InboxHit {
  conversationId: string
  subject: string
  kind: MailKind
  at: number
  snippet: string
  /** Null when the words were only in names, addresses or subjects: `snippet` is the line to show. */
  match: string | null
  unread: boolean
  open: boolean
  bulk: boolean
  mailbox: InboxMailbox | null
  /** The people on it, each once, the one the lists put it under first: a hit leads with and opens that person, as the list's row does. */
  people: InboxParty[]
}

export interface InboxSearch {
  /** The words the inbox read out of the query. */
  terms: string[]
  hits: InboxHit[]
  /** There were others past this screen. */
  more: boolean
}

/**
 * The inbox's part of the space. Implemented in packages/inbox (`createSpaceInbox`, src/space.ts), made for
 * the space's Worker by `createInboxPartFactory` (src/space-part.ts) and called in-process (space ADR 0017).
 * The old way in, `SpaceInbox extends WorkerEntrypoint` over a service binding, took an assertion and verified it before calling the same methods; it is deleted (space ADR 0017).
 */
export interface InboxForSpace {
  /** Per contact, its conversations in scope with the newest message, its kind and unread. */
  people(asker: SignedIn, scope?: InboxScope): Promise<SpaceReply<InboxPeople>>
  /** A person's messages across their conversations in scope, each with its subject and who else is on it, a page at a time. */
  messagesWith(asker: SignedIn, who: InboxWho, query?: InboxHistoryQuery): Promise<SpaceReply<InboxHistory>>
  /** The drafts waiting, and sends Gmail never confirmed, newest first: those on conversations and those on none. */
  drafts(asker: SignedIn): Promise<SpaceReply<InboxDraft[]>>
  /**
   * Where one draft's link opens: the draft as it stands, or (once it is no longer a draft) the person's conversation it was filed on. A read of one message by id, for the owner
   * alone like the rest; `not-found` for a message that is gone or was never one. See `InboxDraftAt`.
   */
  draftAt(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxDraftAt>>
  /**
   * Send an email, in a thread or a new one. A WRITE: the space awaits it up to `WRITE_WITHIN_MS` (the inbox itself waits up to
   * 25 seconds for Gmail) and, if it loses track, shows "outcome unknown" and never retries. `conflict` when the draft or the
   * thread moved; `Repeated` when `key` was already used; `broken` only when the inbox knows nothing went out, and
   * `InboxSent.status: 'sending'` (a success) when Gmail never said.
   */
  send(asker: SignedIn, send: InboxSend): Promise<WriteReply<InboxSent>>
  /** Edit a draft's subject and body at the revision shown (the inbox's own draft edit). See `InboxDraftEdit`. */
  editDraft(asker: SignedIn, edit: InboxDraftEdit): Promise<SpaceReply<InboxDraft>>
  /** Put one picture on a Telegram draft, or replace the one it has, at the revision shown. See `InboxDraftPicture`. A write that names a revision: a repeat is `conflict`, so it carries no compose key. */
  putDraftPicture(asker: SignedIn, put: InboxDraftPicture): Promise<SpaceReply<InboxDraft>>
  /**
   * Say how a send Gmail never confirmed went (the inbox's own `resolve-send`): see `InboxSendResolution`. A write that sets an outcome once: a repeat is `conflict` ("That message is not waiting on a send"), never
   * a second application, so it carries no compose key. The space awaits it up to `WRITE_WITHIN_MS`, since a business mailbox's reads its kept copy.
   */
  resolveSend(asker: SignedIn, resolution: InboxSendResolution): Promise<SpaceReply<InboxSendResolved>>
  /**
   * Record that a text or a direct message draft was sent by hand, and file it read and closed on the person's conversation for its channel (the inbox's own `mark-sent`). `conflict` for a message that is not a draft;
   * `bad-request` for an EMAIL ("An email is sent with Send"), which the inbox sends itself; `not-found` for no such message. Not idempotent (the second press finds a sent message), so a repeat is `conflict`: no key.
   * Audited as the owner's. Sends nothing.
   */
  markDraftSent(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxHandSent>>
  /** Take a hand-sent mark back ("Not sent after all"): the message is a draft again. `conflict` for a message not marked sent by hand, `not-found` for none. Audited as the owner's. */
  unmarkSent(asker: SignedIn, messageId: string): Promise<SpaceReply<InboxHandSent>>
  /**
   * Call a conversation spam (it moves to Bulk and sticks: nothing is asked of the spam classifier again, a later message does not undo it) or not spam (back to the Inbox), as the inbox's own
   * "Mark as spam" and "Move to the Inbox" do. A conversation in no mailbox (a text, a manual note) is `bad-request`; one that does not exist `not-found`. Idempotent, so it carries no key.
   * Audited as the owner's. See `InboxSpamResult`.
   */
  setSpam(asker: SignedIn, mark: InboxSpamMark): Promise<SpaceReply<InboxSpamResult>>
  /**
   * Mark conversations read (which marks read in Gmail, as today), each at the position the caller read to. A write, but
   * idempotent: marking read twice is marking it once, so it carries no key.
   */
  markRead(asker: SignedIn, marks: readonly InboxReadMark[]): Promise<SpaceReply<InboxReadResult>>
  /** The inbox's search: open or closed, the last 30 days of mail and everything since, never Gmail. A read. */
  search(asker: SignedIn, query: string): Promise<SpaceReply<InboxSearch>>
  /**
   * One file of one message, by the message and the file's place in its list (`InboxMessage.attachments`), for the owner only, like every method here. A read that
   * changes nothing and marks nothing read. How it is handed back is `InboxFileOut`'s. `not-found` for a message or a place that is not there (a message the person
   * cannot see is not told apart from one that does not exist) and for a copy the inbox no longer holds; `bad-request` for a file it will not give that way: one too
   * large to open here, any file that is not a picture when `how` is `view`, or any file but a picture of the owner's Gmail (Gmail's other files open in Gmail).
   *
   * `range` is a request's byte range, honoured only for a Telegram voice note or video that is being viewed (the answer then carries `part` and `total`, or `unsatisfiable`); for any other file it is ignored and the
   * file comes whole. A Telegram file over `INBOX_FILE_WHOLE_BYTES` comes in a part of at most `INBOX_FILE_PART_BYTES` even when no range is asked, with `part` and `total`, and the caller reads on from `part.last + 1`.
   */
  attachment(asker: SignedIn, messageId: string, index: number, how: 'view' | 'download', range?: FileRange): Promise<SpaceReply<InboxFileOut>>

  // ── The inbox's other views. Shapes: inbox-views.ts. Every one is the owner's alone, as the rest are. ─────────────

  /** The inbox's own left menu in one read: the views' counts, each business mailbox, each Client with its open count, the contacts, Gmail's line. */
  navigation(asker: SignedIn): Promise<SpaceReply<InboxNav>>

  /** Whether Claude may send on the owner's instruction. A read; the switch itself is the owner's to flip below and never Claude's. */
  claudeSending(asker: SignedIn): Promise<SpaceReply<InboxClaudeSending>>
  setClaudeSending(asker: SignedIn, enabled: boolean): Promise<SpaceReply<InboxClaudeSending>>
  /** Each Gmail account (the owner's several) and each business mailbox with its spam check. */
  mailboxes(asker: SignedIn): Promise<SpaceReply<InboxMailboxes>>
  setSpamCheck(asker: SignedIn, mailboxId: string, enabled: boolean): Promise<SpaceReply<InboxSpamCheck>>
  /**
   * Ask Gmail what changed, or disconnect an account. `mailboxId` is the account (`InboxGmail.id`): required to disconnect; for a sync, absent means every account with a working grant. `not-found` for an id that
   * is none; `conflict` for an account that is not connected (or, for a sync, whose grant has lapsed: connect it again). Connecting is the two methods below, on the space's own path.
   */
  changeGmail(asker: SignedIn, change: InboxGmailChange, mailboxId?: string): Promise<SpaceReply<InboxGmailChanged>>
  /**
   * Connect Gmail, step one: Google's sign-in address for an attempt whose check (`state`: lowercase hex, `GMAIL_STATE`) the space made and keeps in a cookie. The
   * return address on it is the space's (`gmailReturnUrl`), derived from the declaration. The owner only: the space sets no cookie and sends no browser anywhere for a refused asker. `bad-request` for a
   * check of another shape; `failed` when this Worker has no Google client id. Nothing is stored, and the client secret never leaves the inbox. `mailboxId` is the account being connected again: its address
   * becomes Google's sign-in hint, so the right account is offered first (it decides nothing: whichever account is signed in is the one connected). `not-found` for an id that is none.
   * `purpose` is `calendar` for Settings, Calendars' own button: the request then asks for the calendar permission ALONE and keeps what the account already granted,
   * and the mailboxes' own Connect (no purpose, or `mail`) never names a calendar scope, so a calendar consent a Workspace admin restricts can never stand between an account and its mail. `bad-request` for any other value.
   */
  gmailSignIn(asker: SignedIn, state: string, mailboxId?: string, purpose?: GmailPurpose): Promise<SpaceReply<InboxGmailSignIn>>
  /**
   * Connect Gmail, step two: exchange the code Google returned (with the space's return address, the one the attempt started with), check what was granted and WHO granted it, and keep the grant: the
   * inbox's own connection, with every refusal it has (not gmail.modify, no lasting access, Google refusing the code), each said in its words and each leaving nothing kept. ANY address is connected (the owner's
   * several accounts); an address already held has its grant replaced and its lapse ended. The owner only. With `purpose` `calendar` (the answer to a calendar sign-in) the new grant must carry BOTH permissions (Google adds
   * what the account already granted), and when it does not nothing is kept and nothing is revoked at Google (revoking the new token would end the account's mail grant with it). Not idempotent (Google accepts a code once), so a repeat is the inbox's `failed` with Google's reason, never a second connection. The answer is the connection as it now stands.
   */
  gmailConnect(asker: SignedIn, code: string, purpose?: GmailPurpose): Promise<SpaceReply<InboxGmail>>
  /** The key a browser turns notifications on with, every device (the inbox's installed app and the space's), and the week's numbers. */
  notifications(asker: SignedIn): Promise<SpaceReply<InboxNotifications>>
  /** The device of the page that asks: marked as the space's, so a notification to it opens the conversation in the space. `userAgent` names it ("Chrome on Android"). */
  addDevice(asker: SignedIn, device: InboxDeviceInput, userAgent: string | null): Promise<SpaceReply<InboxDevice>>
  /** Any device, from any device (a lost phone; the inbox's old app once the space is added). */
  removeDevice(asker: SignedIn, id: string): Promise<SpaceReply<{ id: string }>>
  testDevice(asker: SignedIn, id: string): Promise<SpaceReply<InboxTestSent>>
  /** Restore, in the inbox's own two steps. A read; then `prepareRestore` changes nothing and answers a token; then `confirmRestore` makes the restore. */
  restoreReport(asker: SignedIn): Promise<SpaceReply<InboxRestoreReport>>
  prepareRestore(asker: SignedIn, choice: InboxRestoreChoice): Promise<SpaceReply<InboxRestorePlan>>
  confirmRestore(asker: SignedIn, confirm: { token: string; bookmark: string }): Promise<SpaceReply<InboxRestoreDone>>
  /** The Clients the Clients part holds with how many of their people and conversations the inbox holds; one Client's page; linking a person to a Client (or taking them out with null). A link is checked against the part, and an archived or unknown Client is refused. */
  clients(asker: SignedIn): Promise<SpaceReply<InboxClients>>
  client(asker: SignedIn, id: number): Promise<SpaceReply<InboxClientPage>>
  linkClient(asker: SignedIn, contactId: string, clientId: number | null): Promise<SpaceReply<{ contactId: string; clientId: number | null }>>
  /** The turns of one draft's chat with the assistant, oldest first. */
  draftChat(asker: SignedIn, conversationId: string, draftId: string): Promise<SpaceReply<InboxChatTurn[]>>
  /** One chat turn about a draft. The assistant may revise the draft; nothing it does sends, and the draft goes out only by `send`. */
  chat(asker: SignedIn, chat: InboxChat): Promise<SpaceReply<InboxChatAnswer>>

  // ── People. Shapes: inbox-people.ts. The owner's alone, as the rest are. ─────────────────────────────────────────────

  /**
   * Every contact that is a person, with its Client, its business and role and its revision: People's list. The automated senders are counted and left out unless
   * `scope.automated` asks for them (each then marked). A read.
   */
  contacts(asker: SignedIn, scope?: InboxContactsScope): Promise<SpaceReply<InboxContacts>>
  /** One contact with its note. `not-found` for none. A read. */
  contact(asker: SignedIn, contactId: string): Promise<SpaceReply<InboxContactProfile>>
  /**
   * Save the business, the role and the note of a contact, at the revision the caller was shown. `conflict` (nothing changed) when the contact has moved on since;
   * `bad-request` for a field past `PROFILE_MAX`. A write, but it sets values, so twice is once and it carries no compose key.
   */
  saveContactProfile(asker: SignedIn, edit: InboxProfileEdit): Promise<SpaceReply<InboxContactProfile>>
  /**
   * Merge two contacts who are the same person, each at the revision it was shown (`conflict` when either moved on, nothing changed). The answer names the merge, which
   * `undoContactMerge` takes. Not idempotent (the second contact is gone after the first), so a repeat is `not-found`, never a second merge.
   */
  mergeContacts(asker: SignedIn, merge: InboxMerge): Promise<SpaceReply<InboxMerged>>
  /**
   * Rename a contact (the inbox's own Rename), at the revision the caller was shown: `conflict` (nothing changed) when the contact has moved on since; `bad-request` for an empty name
   * ("A contact needs a name."); `not-found` for none. The rename raises the revision. A write that sets a value and names a revision, so twice is a `conflict` and never twice applied: no key.
   * Audited as the owner's. The answer is the contact as it now stands.
   */
  renameContact(asker: SignedIn, rename: InboxRename): Promise<SpaceReply<InboxContactProfile>>
  /**
   * Split one address off a contact onto a new contact of its own (the inbox's own Split off; the way back from a wrong merge), at the revision of the contact it comes off: `conflict` (nothing changed)
   * when that contact has moved on; `bad-request` for its only address ("there is nothing to split off"); `not-found` for an address that is not one of that contact's. Its conversations and messages go
   * with the address. Raises the revision of the contact it came off. The second press names an address no longer on it, so a repeat is `not-found`: no key. Audited as the owner's.
   */
  splitAddress(asker: SignedIn, split: InboxSplit): Promise<SpaceReply<InboxSplitDone>>
  /**
   * Put a merge back: the absorbed contact returns with its name, its Client and its fields, and the addresses that are still on the survivor move back to it. The survivor's
   * Client and fields return to what they were only if nobody changed them since. `conflict` when it was undone already or none of the addresses is on the survivor any more.
   */
  undoContactMerge(asker: SignedIn, mergeId: number): Promise<SpaceReply<InboxUnmerged>>

  // ── Close and Reopen (the space's Close button). The owner's alone, as the rest are. ───────────────────────────────────────────────

  /**
   * Close conversations, which archives them in Gmail, as the inbox's own Close does: each at the position the caller read to, and refused
   * (`conflict`, nothing changed anywhere) when mail the close would affect arrived after it, so nothing is closed unseen. A write, but
   * idempotent: closing a closed conversation is closing it once, so it carries no key. The space awaits it up to `WRITE_WITHIN_MS`.
   */
  closeConversations(asker: SignedIn, marks: readonly InboxCloseMark[]): Promise<SpaceReply<InboxCloseResult>>
  /** Reopen conversations (back to Gmail's Inbox), as the inbox's own Reopen does. Needs no position: a reopen shows nothing new to anyone. Idempotent. */
  reopenConversations(asker: SignedIn, conversationIds: readonly string[]): Promise<SpaceReply<InboxReopenResult>>

  // ── The operator's three, for a move of the inbox's store between Workers (the space's ADR 0017 describes the move). Each is the OWNER's and none touches a message, a draft or a contact: the answers are a marker, a flag and numbers under names. ──────────

  /** Cloudflare's marker of the store's history now (30 days; a bookmark taken before a transfer has been shown to restore after it). The inbox's own restore (`prepareRestore`, `confirmRestore`) goes back to one. */
  storeBookmark(asker: SignedIn): Promise<SpaceReply<InboxStoreBookmark>>
  /**
   * Restart the store's object: its in-memory state is dropped and its next call starts it afresh, under the code of the Worker that owns its class. A MOVED object keeps running the giving
   * Worker's code until it restarts when it was awake through the hand-over, so the move ends with this. A Gmail send or sync under way is cut off (the inbox's owed-work rows and its
   * daily pass pick up what was owed), so the sitting is held with nothing being sent.
   */
  restartStore(asker: SignedIn): Promise<SpaceReply<InboxStoreRestarted>>
  /** How many rows each table holds, and how many messages of each direction (numbers under names, never a message or a person): read before and after a move. The only way to read the store's size from outside. */
  storeCounts(asker: SignedIn): Promise<SpaceReply<InboxStoreCounts>>
}

/** A bookmark of the store's history, as Cloudflare names it (the same shape as the knowledge store's and meet's). */
export const INBOX_BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/
export interface InboxStoreBookmark {
  bookmark: string
}
export interface InboxStoreRestarted {
  restarted: true
}
export interface InboxStoreCounts {
  counts: Record<string, number>
}

/** The operator's three: methods of the part, which the old `SpaceInbox` entrypoint never had. */
export const INBOX_OPERATOR_METHODS = ['storeBookmark', 'restartStore', 'storeCounts'] as const

/** The method names, so a stub, a test and the binding agree on exactly these and no others. */
export const INBOX_FOR_SPACE_METHODS = [
  'people',
  'messagesWith',
  'drafts',
  'draftAt',
  'send',
  'editDraft',
  'putDraftPicture',
  'resolveSend',
  'markDraftSent',
  'unmarkSent',
  'setSpam',
  'markRead',
  'search',
  'attachment',
  'navigation',
  'claudeSending',
  'setClaudeSending',
  'mailboxes',
  'setSpamCheck',
  'changeGmail',
  'gmailSignIn',
  'gmailConnect',
  'notifications',
  'addDevice',
  'removeDevice',
  'testDevice',
  'restoreReport',
  'prepareRestore',
  'confirmRestore',
  'clients',
  'client',
  'linkClient',
  'draftChat',
  'chat',
  'closeConversations',
  'reopenConversations',
  'contacts',
  'contact',
  'saveContactProfile',
  'mergeContacts',
  'undoContactMerge',
  'renameContact',
  'splitAddress',
  ...INBOX_OPERATOR_METHODS,
] as const satisfies readonly (keyof InboxForSpace)[]
