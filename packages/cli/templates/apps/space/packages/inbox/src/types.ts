import type { InboxFrom } from '@space/workspace'

/**
 * The shapes that cross the wire between the store, the API, the browser and
 * Claude's script. Plain data only (no classes, no functions), because they pass
 * through Durable Object RPC and JSON, and importable from both sides because
 * they hold no code. The few constants below are the only values, and they are here
 * because the browser needs them as much as the store does.
 */

/**
 * What the refusals of Claude's send say is owner-words.ts (the owner is the install's, owner.ts); each is one rule, stated where it bites, and each is checked in the store
 * (planSend, and again in claimSend), which every route to a send passes through.
 */
/** A send names a stored draft. It never carries the text, so the exact message is on record before it leaves. */
export const SEND_NAMES_NO_TEXT =
  'A send names a stored draft and carries no text of its own: put the words in a draft, so they are on record, and send that.'

/**
 * The only fields a send carries, for the server and for Claude's script alike, so the two
 * cannot disagree about what is accepted. Anything else is refused (SEND_NAMES_NO_TEXT), which
 * is how no text, recipient or Bcc can ride along with the press.
 */
export const SEND_FIELDS = ['rev', 'through', 'instruction', 'picture'] as const

/** An instruction is Claude's record of what the owner told it, so it can ride only on Claude's send. */
export const ONLY_CLAUDE_CARRIES_INSTRUCTION = 'Only Claude’s send carries an instruction.'

/**
 * The actor on everything Gmail itself did: a message arriving, a label changing in
 * Gmail's own app. A stamp or an audit entry with this actor means the inbox did not
 * make the change; it was told.
 */
export const GMAIL_ACTOR = 'gmail'
/** Who a stamp or an audit entry names when the mail server (a JMAP mailbox) told the inbox of a change, as GMAIL_ACTOR does for Gmail's. */
export const JMAP_ACTOR = 'jmap'

/**
 * The actor on a close the inbox made because a newer update of the same calendar event arrived (src/calendar-event.ts, `MailStore.supersededEvents`):
 * a conversation closed by it shows `closedBy: 'calendar'`, and the audit trail has a `conversation.replaced` entry naming the conversation that replaced it.
 */
export const CALENDAR_ACTOR = 'calendar'

/** How many rows the queue shows: a screen of the filter asked for, not the mailbox. Counts cover the mailbox. */
export const QUEUE_PAGE = 200

/** How many days back the first fill reads. A constant, as the option says; the header quotes it. */
export const FILL_DAYS = 30

/** What an agent's actor label is prefixed with; the same convention as the site's admin. */
export const AGENT_PREFIX = 'agent:'

/** Whether a value is a whole number: a revision, a `through`. The one test the routes and the script share. */
export const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Whether an actor is Claude (the agent): the one test the Worker, the store and the screens all use. Null is nobody. */
export const isAgent = (actor: string | null): boolean => actor?.startsWith(AGENT_PREFIX) === true

/**
 * What a Client id is, everywhere one is read: a whole number from 1, the Clients part's
 * own number. ONE definition, so the part's answer, a body, a path, a filter and the
 * store cannot each accept a slightly different thing.
 */
export const isClientId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** A Client id out of text (a path segment, the end of a filter), or null: digits only, no sign, no leading zero. */
export const clientIdFromText = (text: string): number | null => {
  const id = /^[1-9]\d*$/.test(text) ? Number(text) : null
  return isClientId(id) ? id : null
}

/**
 * Who a carried draft was written by, as far as the inbox knows: the Outbox does
 * not record it. The run's actor (whoever pressed go) is in the audit, not here,
 * so a draft Claude wrote in the Outbox is not shown as the carrier's.
 */
export const CARRIED_BY = 'outbox'

/**
 * The actor on everything the assistant did: a draft, a
 * revision of its own draft. Not an `agent:` actor, which is Claude in a session, so its work is told from Claude's and
 * from the owner's everywhere an actor is read.
 */
export const ASSISTANT_ACTOR = 'assistant'

/** Who wrote a draft, as a list row and a draft card say it: the owner, Claude, the assistant, or the Outbox that carried it in. */
export type DraftAuthor = 'owner' | 'claude' | 'outbox' | 'assistant'

export const draftAuthor = (createdBy: string): DraftAuthor =>
  isAgent(createdBy)
    ? 'claude'
    : createdBy === CARRIED_BY
      ? 'outbox'
      : createdBy === ASSISTANT_ACTOR
        ? 'assistant'
        : 'owner'

/**
 * Who changed a draft's words after it was written, when that is not who wrote it: "Claude's draft, edited by you".
 * Null for a draft nobody else has touched. A draft is edited when its `rev` has moved, and the editor is who
 * last updated it. For a draft only a change of its words sets that (creating it and editing it): claiming it for a
 * send, putting it back after a refused send, marking a text sent and un-marking it leave `updated_by` and
 * `updated_at` alone, so an attempt to send never reads as an edit; and neither does a send that goes out.
 */
export const draftEditedBy = (createdBy: string, updatedBy: string, rev: number): DraftAuthor | null => {
  if (rev === 0) return null
  const editor = draftAuthor(updatedBy)
  return editor === draftAuthor(createdBy) ? null : editor
}

/**
 * The channels the inbox knows. An identity's kind is the only place a manual
 * channel is named; Gmail's channel is the mailbox's kind (`gmail`, below).
 *
 * `email`: an address. `sms`: a phone number, the text-message channel. `manual`:
 * anything else (a DM handle, a name), which the inbox cannot send on and never
 * will without an adapter. `telegram`: a Telegram user id (a person or a bot; the id is
 * stable for life, a username is not), made only by the bridge's door (src/telegram/). The
 * set is open on purpose: Slack adds a kind here and a column value, not a column.
 */
export type IdentityKind = 'email' | 'sms' | 'manual' | 'telegram'

/**
 * Every status a message can reach. A message that ARRIVED
 * from Gmail (direction `in`) is `sent`, and so is one found in Gmail's Sent
 * folder: SQLite cannot alter the CHECK on this column, so the received ones take
 * the one terminal status that fits, and `direction` is what tells them apart.
 * Anything that asks "did we send this" must look at direction as well.
 *
 * `sending` is a draft the inbox has claimed to send, and it is held for the whole
 * of the call to Gmail: a second press finds it and is refused. It normally lasts
 * a second. One that stays means Gmail never said whether it sent the message (or
 * the Worker died); it is shown with the Drafts as "check Gmail Sent", and only
 * the owner can say which way it went (Mailroom.resolveSend). It never goes back to
 * `draft` by itself once the outcome is unknown.
 */
export type MessageStatus = 'draft' | 'sending' | 'sent' | 'manual-sent' | 'failed'

/**
 * The statuses of a message still waiting on the owner: a draft, and one claimed for sending
 * whose outcome is not yet known. Both are "drafts" to every list and count (a send in
 * doubt must stay in front of them, not vanish), and neither is a sent message that the
 * conversation's history or its `through` position counts. The store's SQL list of them
 * is made from this one.
 */
export const PENDING_STATUSES = ['draft', 'sending'] as const satisfies readonly MessageStatus[]

export const isPending = (status: MessageStatus): boolean => (PENDING_STATUSES as readonly string[]).includes(status)

export interface IdentityRow {
  id: string
  kind: IdentityKind
  /** Normalized: the bare lowercase address, E.164 digits, a lowercase handle, or a Telegram user id. */
  address: string
  /** True only for a Telegram bot (migration 16): an automated sender by the rule in src/automated.ts. Absent for everything else, so no existing answer changes shape. */
  bot?: true
  /** True only for the identity that stands for a Telegram group or channel (migration 17): the contact its conversation is filed under. Absent for everything else. */
  chat?: 'group' | 'channel'
}

/**
 * A contact's Client as the store holds it: the id the Clients part vouched for when it
 * was assigned, who assigned it and when. All three are null together. The NAME is not
 * here: the store keeps no list of Clients, and the Worker puts the Client's name beside
 * the id on the way out (`ClientLabel`).
 */
export interface ContactClient {
  clientId: number | null
  clientSetBy: string | null
  clientSetAt: string | null
}

export interface ContactRow extends ContactClient {
  id: string
  name: string
  identities: IdentityRow[]
}

/**
 * A Client as a row or a card shows it: its id and its name from the Clients part, or
 * "Client 7" with `listed: false` when the part could not be reached (or does not hold
 * it). Added by the Worker; the store only has the id.
 */
export interface ClientLabel {
  id: number
  name: string
  listed: boolean
}

/** An account mail goes out from: the name it is shown by (its pill: "northfield", "Northfield Works") and its address. */
export interface SendsFrom {
  name: string
  address: string
}

export interface MessageRow {
  id: string
  conversationId: string | null
  contactId: string
  contactName: string
  kind: IdentityKind
  /** The address this message is to. */
  address: string
  direction: 'in' | 'out'
  status: MessageStatus
  /**
   * Counts every edit of a draft. A send names the revision its author was shown and is
   * refused (409) when the draft has changed since, so a message never leaves with words
   * its sender did not read. 0 for anything that was never a draft.
   */
  rev: number
  subject: string
  body: string
  /** One line of framing for the owner, on a draft. */
  why: string
  createdAt: string
  createdBy: string
  /** Who last updated it: who edited a draft, and (with `rev`) whether somebody other than its author did. */
  updatedBy: string
  sentAt: string | null
  sentBy: string | null
  /** Where it came from when it was carried in (`outbox:<id>`), else null. */
  sourceRef: string | null
  /**
   * The owner's instruction, on a message Claude is sending or sent (and null on every other).
   * It is Claude's own account of what they said, never a verified fact; see SendInstruction.
   */
  instruction: SendInstruction | null
  /**
   * The Gmail side of a message that came from (or is in) Gmail. All empty for a
   * draft and for anything marked sent by hand. `from`, `to` and `cc` are the
   * headers as the sender wrote them, with encoded words decoded; `body` is plain
   * text, cut at the store's cap when `bodyTruncated`, and the link on the
   * conversation reaches the rest.
   */
  gmailId: string | null
  /** The mail server's id of a message that is in a JMAP mailbox (the fourth kind); absent otherwise. Gmail's id stays `gmailId`. */
  jmapId?: string
  from: string
  to: string
  cc: string
  snippet: string
  bodyTruncated: boolean
  attachments: AttachmentInfo[]
  /** On a Telegram message its sender edited: when (the text above is the new one). Absent otherwise. */
  editedAt?: string
  /** On a Telegram message its sender deleted for everyone: when. The text is gone and the row stays, so the history shows that one was deleted. Absent otherwise. */
  deletedAt?: string
  /** On a Telegram draft that went back to being a draft because Telegram would not take it, or the bridge was not running: what happened, as a sentence for the person. Cleared when it is claimed again. Absent otherwise. */
  refusal?: string
  /** On a Telegram send that is still going out (claimed, and the bridge may yet send it: `SEND_IN_FLIGHT_MS`): true. Absent otherwise, and on one whose outcome is unknown. Set by `TelegramStore.listDrafts` and `messageById`, never stored. */
  sendingOnTelegram?: true
  /**
   * What Cloudflare reported of this message's recipients, when it is a message the inbox sent as a Cloudflare mailbox and a report has come in (src/delivery.ts).
   * Absent otherwise, and on every read that does not ask the store for it.
   */
  delivery?: DeliveryNote[]
  /** Gmail's labels on it now, including the category tab (CATEGORY_PROMOTIONS and so on). */
  labels: string[]
  /**
   * The exact copy of a message that went through Cloudflare, as the key of the object in the raw-mail bucket; absent on
   * everything else. For one that arrived (`in/<hash>`) the object is the message as it came; for one the inbox sent
   * (`out/<id>`) it is the request handed to Cloudflare and what Cloudflare answered, kept when Cloudflare accepted it.
   * The text above is the inbox's reading.
   */
  rawKey?: string
  /**
   * On a Telegram message the inbox sends (a draft, a send going out, the sent message) that carries a picture: its type, its length and its fingerprint (the SHA-256 of its bytes). What Claude's script
   * prints and names back when it sends the draft. NEVER the bytes: Claude is never handed a file. Absent on everything else.
   */
  picture?: { type: string; size: number; fingerprint: string }
  /**
   * The address of the Cloudflare mailbox an outbound message will go out from (on a draft: recorded when the draft is made, so
   * the send does not decide it later), is stuck sending from, or was sent from. The owner's own mail has none.
   */
  sentFrom?: string
  /**
   * On a draft (or a send that is going out), the account it goes out from, of either kind: a reply's is the one its conversation is in, a new email's the one recorded when it was made.
   * Absent on a sent message, a text and a direct message, and while no Gmail account is connected (a draft that records no account goes from the default one, as the send does). Unlike `sentFrom`, which is a Cloudflare mailbox's
   * address and means "no Sent folder to look in", this says nothing about how a stuck send is settled.
   */
  sendsFrom?: SendsFrom
  /**
   * The draft chat kept beside a draft: the owner's turns with the
   * assistant about this draft and the notes it left itself, oldest first. Present only on a draft that has had one, of any email
   * conversation (ADR 0001 decision 23), and only in a conversation's own answer.
   */
  chat?: ChatTurn[]
}

/**
 * One turn of a draft's chat: what the owner asked, what the assistant answered, whether it changed the draft and from which
 * revision to which. `instruction` is null on a note the assistant left by itself (a follow-up came in over a draft that was
 * not its to change). A turn that did not change the draft (a question, or a draft that moved on while the assistant was
 * working) has no `revAfter`.
 */
export interface ChatTurn {
  seq: number
  at: string
  instruction: string | null
  note: string
  revised: boolean
  /** The revision of the draft the owner saw when they asked, after any edits they had not saved were saved as their own. */
  revBefore: number
  /** The revision the draft was left at, when the turn revised it. */
  revAfter: number | null
}

/**
 * The longest subject a draft keeps. A subject is one line in a header; more than this is a mistake, and Gmail's own
 * limit is not the inbox's to find out by failing a send.
 */
export const MAX_SUBJECT = 300

/**
 * The owner's instruction to send a stored draft, as Claude recorded it: their words as Claude
 * received them, where they said them (a session with Claude) and when. THE INBOX CANNOT
 * SEE A CHAT, so this is Claude's account of what they said and not proof that they said it;
 * everything that shows it says so. It is what makes a surprising send traceable to the
 * session to look in.
 */
export interface SendInstruction {
  /** The owner's words, as Claude received them. */
  text: string
  /** Where they said them: which session. Never "the inbox" (see INSTRUCTION_ONLY_FROM_OWNER_IN_SESSION). */
  where: string
  /** When they said them, ISO, as Claude states it. The send's own time is the message's `sentAt`. */
  at: string
}

/** The longest instruction text and place the inbox records: the owner's words, not a transcript. */
export const MAX_INSTRUCTION_TEXT = 2000
export const MAX_INSTRUCTION_WHERE = 200

/**
 * An attachment's name and size, so a reader knows it exists, and the type its sender's client declared (a hint, and
 * absent on a message stored before it was kept: nothing trusts it). Its bytes are never stored. An image of the four
 * kinds in image.ts is fetched from Gmail when someone asks to see it; nothing else is served at all.
 */
export interface AttachmentInfo {
  name: string
  size: number
  mimeType?: string
  /** On the file of a Telegram message and nowhere else: what it is and whether its bytes were copied. See `TelegramFile`. */
  tg?: TelegramFile
}

/**
 * What the inbox keeps of the file a Telegram message carries, inside the message's `attachments` (no column of its own, so no migration). `copy` is `kept` when the bytes are in the raw-mail bucket (the
 * message's `raw_key` names them), `owed` while the bridge has been asked for them and has not answered, `left` when they stay in Telegram for the reason `why` says. Nothing here is a name from Telegram.
 */
export interface TelegramFile {
  kind: 'photo' | 'voice' | 'audio' | 'video' | 'gif' | 'sticker' | 'file' | 'image'
  seconds?: number
  copy: 'kept' | 'owed' | 'left'
  /**
   * Only on a picture the inbox SENDS: the SHA-256 of its bytes, lowercase hex. It is the picture's fingerprint: `drafts` prints it for Claude, Claude's send names it, and the send is refused when it is not
   * the draft's picture. Never on a file that arrived from Telegram.
   */
  sha256?: string
  /** Only on `left`: `too-large` (over the limit, from its declared size or once downloaded), `kind` (only photos, voice notes, pictures sent as files and videos are copied), `channel` (a channel's media is named only), `bot` (so is a bot's chat: both are Bulk), `gone` (Telegram no longer has it), `failed` (the bridge could not get it). */
  why?: 'too-large' | 'kind' | 'channel' | 'bot' | 'gone' | 'failed'
}

/** The six kinds of report Cloudflare's Email Sending publishes (src/delivery.ts); the contract's `DeliveryState` is the same list. */
export type DeliveryState = 'delivered' | 'deferred' | 'bounced' | 'failed' | 'rejected' | 'complained'

/** How one recipient's copy of a message the inbox sent as a Cloudflare mailbox went, as the newest report that settles it says. `at` is ISO text. */
export interface DeliveryNote {
  recipient: string
  state: DeliveryState
  reason: string
  at: string
}

/**
 * Whether a conversation is read and whether it is open, and who made it so. For
 * an email conversation both follow Gmail's labels (UNREAD, INBOX) and the stamps
 * say who made the change; for a manual one the stamps are the whole truth. A
 * conversation is unread while ANY message in it is, and open while ANY message
 * is. `readBy` and `closedBy` are an address, `agent:` and a token's client id, or
 * `gmail` for a change made in Gmail itself; each is null while the state it
 * describes does not hold (unread, open).
 */
export interface ConversationState {
  unread: boolean
  open: boolean
  readBy: string | null
  readAt: string | null
  closedBy: string | null
  closedAt: string | null
}

/** What a person (or Claude) can do to a conversation's state from the inbox. Mark unread is not one: it is Gmail's. */
export type ConversationChange = 'read' | 'close' | 'reopen'

/** What each change is called in the sentence that says Gmail would not do it. One source for the Gmail module and the Mailroom. */
export const CHANGE_VERBS: Record<ConversationChange, string> = {
  read: 'mark it read',
  close: 'archive it',
  reopen: 'move it back to the Inbox',
}

/**
 * The facts of a conversation's newest inbound message that the queue decides Bulk from (src/queue.ts). Null when nothing
 * has come in on it. `labels` and `listUnsubscribe` are the envelope (a Cloudflare message has no labels), and both kinds add whether
 * the sender is an automated one by the contact rules that need no history (`automated`, ADR 0001 decision 23). A Cloudflare message also
 * has what the spam classifier said of it (`clefJunk`: a probability, or null when nothing judged it, which is not a low one).
 */
export interface Envelope {
  labels: string[]
  listUnsubscribe: boolean
  automated?: boolean
  clefJunk?: number | null
}

/**
 * What the queue needs to know of a conversation to count and filter it: the
 * state, whether it has drafts and the envelope Bulk is judged from. Cheap to
 * read for EVERY conversation, which is what lets the counts cover the whole
 * mailbox while the rows shown are only the latest screen of them.
 */
export interface QueueFact extends ConversationState {
  id: string
  lastActivityAt: string
  /** Drafts waiting on this conversation. */
  drafts: number
  newestInbound: Envelope | null
  /**
   * The Clients of the contacts on this conversation, each once, in ascending order: what
   * the Client filters count and what exempts the conversation from Bulk (src/queue.ts).
   * Ids only, as the store holds them; empty for a conversation none of whose people is
   * assigned to a Client.
   */
  clientIds: number[]
  /**
   * The mailbox the conversation is in: a Cloudflare (business) mailbox or one of the owner's Gmail accounts (`mailboxKind` says which). Absent for a manual conversation.
   */
  mailbox?: MailboxMark
  /** Which kind of mailbox `mailbox` is: files go only from a Cloudflare one, and only its conversations carry the spam check's lines. Present exactly when `mailbox` is. */
  mailboxKind?: 'gmail' | 'cloudflare' | 'telegram' | 'jmap'
  /** A Telegram conversation with many people in it: a `group` (filed under the group's contact, each message under its sender) or a `channel` (Bulk). Absent for every other conversation, a one-to-one Telegram chat included. */
  telegramChat?: 'group' | 'channel'
  /**
   * A person's call on a Cloudflare conversation: the owner or Claude moved it to Bulk (`spam: true`) or back to the Inbox
   * (`spam: false`). It decides over every rule but a Client's people, and it stays when the same person writes again.
   * Absent when nobody has called it, and for a conversation that is not in a Cloudflare mailbox.
   */
  spamCall?: SpamCall
}

/** A person's call on whether a Cloudflare conversation is spam, and who made it. */
export interface SpamCall {
  spam: boolean
  by: 'owner' | 'claude'
}

/** The newest draft waiting on a conversation, as a list row shows it: who wrote it and how it starts. */
export interface DraftGlance {
  author: DraftAuthor
  /** Somebody other than the author changed its words ("Claude draft, edited"), or null. See `draftEditedBy`. */
  editedBy: DraftAuthor | null
  /** The start of its text on one line, as the row's snippet is cut. */
  excerpt: string
  /** It is a send Gmail never confirmed (`sending`), not a draft: it waits for the owner to say whether it went out. */
  stuck: boolean
}

export interface ConversationSummary extends QueueFact {
  /** The contacts on the conversation, by name; one for every manual conversation. */
  contactIds: string[]
  contactNames: string[]
  /** Each of those contacts' Client id, in the same order, null for a contact with none. */
  contactClientIds: (number | null)[]
  kind: IdentityKind
  subject: string
  snippet: string
  /**
   * Whether the newest message that is not a draft was sent by Claude (on the owner's
   * instruction): the small mark on a list row. A draft waiting is not a message sent.
   */
  newestFromClaude: boolean
  /** The newest draft waiting on it, or null. */
  draft: DraftGlance | null
}

export interface ConversationDetail extends ConversationState {
  id: string
  /**
   * How far into the conversation this answer reaches: sent back with Close and
   * with read, so the inbox can refuse when something inbound arrived after it
   * was shown (see Inbox.newestPosition).
   */
  through: number
  kind: IdentityKind
  contacts: { id: string; name: string; clientId: number | null }[]
  addresses: IdentityRow[]
  /** Sent and received messages, oldest first. */
  messages: MessageRow[]
  /** Drafts waiting on this conversation, newest first. */
  drafts: MessageRow[]
  /** The mailbox it is in (a business mailbox or a Gmail account); absent for a manual conversation. */
  mailbox?: MailboxMark
  spamCall?: SpamCall
  /**
   * On a conversation in a Cloudflare mailbox, why it is in the Inbox or in Bulk, as the lines the screen shows: each rule that
   * applies, in the order the rules run, and, in a Cloudflare mailbox, what the spam classifier said with its score when it judged the newest
   * message. The owner's own Gmail has the lines that apply to it (a header, a category tab, a Client's contact), and none for a manual conversation.
   */
  reasons?: string[]
  /** Whether the conversation is Bulk because the spam classifier or a person called it spam (not because of a header, a category tab or an automated sender). */
  spam?: boolean
  /** The thread in Gmail's own app, or null for a conversation with no mailbox. */
  gmailUrl: string | null
  /**
   * What a reply here would be, so the composer can say it before anything is saved: who it goes to (the newest
   * message that came in: its Reply-To, else its From, never us), the subject it takes, and everyone "copy everyone on
   * the message it answers" works from. Null for a conversation with no mailbox (a text, a DM), which has no reply.
   * Only a default: a draft names its recipients in full once it exists.
   */
  reply: ConversationReply | null
  /**
   * Whether the queue files it under Bulk (src/queue.ts `isBulk`, the one rule), so a conversation
   * opened by a link, with no row beside it, can say "no reply expected" as its row's view does.
   */
  bulk: boolean
}

export interface ConversationReply {
  to: string | null
  subject: string
  /** Everyone on the message being answered, less us, the default recipient first: what "copy everyone" works from, less whoever the draft goes to. */
  everyone: string[]
  /**
   * The address the reply goes out from, only on a conversation in a Cloudflare mailbox (a business address such as info@northfield.example): the owner's own mail
   * always goes from their Gmail address and has no field, so the box names a sender only where it is not the usual one.
   */
  from?: string
}

/**
 * Whether a contact is a person or an automated sender, with the rule's reason as a sentence
 * (src/automated.ts). Computed when the contact is read and never stored.
 */
export interface SenderJudgment {
  automated: boolean
  /** Which rule decided, so the screen can say what may be done about it (`senderHint`). */
  rule: 'client' | 'name' | 'no-reply' | 'bot' | 'channel' | 'bulk' | 'none'
  reason: string
}

export interface ContactCard extends ContactClient {
  id: string
  name: string
  sender: SenderJudgment
  identities: IdentityRow[]
  /** Newest activity first. */
  conversations: ConversationSummary[]
  /** Every draft addressed to one of this contact's identities. */
  drafts: MessageRow[]
  /**
   * Where a new email to this contact goes out from when the person chooses none: the mailbox the contact last wrote to while it can send (a customer hears from the business mailbox, a client
   * from the Gmail account they wrote to), else the default Gmail account. Absent only when no Gmail account is connected.
   */
  sendsFrom?: SendsFrom
}

export interface ContactListItem extends ContactClient {
  id: string
  name: string
  sender: SenderJudgment
  identities: IdentityRow[]
  conversations: number
  drafts: number
  /** The Cloudflare (business) mailboxes this contact has a conversation in, for Contacts' filter by mailbox; empty for a contact only the owner's own mail knows. */
  mailboxIds: string[]
}

export interface AuditRow {
  id: number
  at: string
  actor: string
  action: string
  subject: string
  before: unknown
  after: unknown
}

/**
 * The views of the queue. `inbox` is the open conversations that are not Bulk, `unread` the
 * unread ones of those, `drafts` every conversation with a draft waiting, `bulk` the open Bulk
 * and `closed` every closed one. `client:<id>` is one Client's open conversations, one filter
 * for each Client that has any (src/queue.ts). The id is the Client's number in the Clients part, as the contact holds it.
 * `mailbox:<id>` is the open conversations that are not Bulk of one Cloudflare (business) mailbox, one filter
 * for each such mailbox the store holds; the owner's own Gmail mail has none.
 */
export type QueueFilterId = 'inbox' | 'unread' | 'drafts' | 'bulk' | 'closed' | `client:${number}` | `mailbox:${string}`

/** The one place a Client's view id is made and taken apart (the queue, the menu and the router all use it). */
export const CLIENT_PREFIX = 'client:'

/** The filter id of one Client's open conversations. */
export const clientFilterId = (clientId: number): QueueFilterId => `${CLIENT_PREFIX}${clientId}`

/** Whether a view id is one Client's. */
export const isClientView = (view: string): view is `client:${number}` => view.startsWith(CLIENT_PREFIX)

/** The Client a `client:<id>` filter is for, or null for anything else (or a malformed id). */
export const clientIdOfFilter = (filter: string): number | null =>
  isClientView(filter) ? clientIdFromText(filter.slice(CLIENT_PREFIX.length)) : null

/** The filter id of one Cloudflare mailbox's view, and the mailbox a view id names (null for any other id). */
export const MAILBOX_PREFIX = 'mailbox:'
export const mailboxFilterId = (mailboxId: string): QueueFilterId => `${MAILBOX_PREFIX}${mailboxId}`
export const mailboxIdOfFilter = (filter: string): string | null =>
  filter.startsWith(MAILBOX_PREFIX) && filter.length > MAILBOX_PREFIX.length
    ? filter.slice(MAILBOX_PREFIX.length)
    : null
export const isMailboxView = (view: string): view is `mailbox:${string}` => mailboxIdOfFilter(view) !== null

export interface QueueFilter {
  id: QueueFilterId
  label: string
  count: number
  /** How many of those `count` conversations are unread. */
  unread: number
}

export interface QueueRow extends ConversationSummary {
  /** The name to show: the contact's, or the first of several. */
  title: string
  /** Newsletters, receipts and notifications: shown under Bulk and not under the Inbox. */
  bulk: boolean
  /** Bulk because the spam classifier or a person called it spam, which a row in a Cloudflare mailbox says on its tag. Absent otherwise, so the owner's own mail's rows are what they were. */
  spam?: boolean
  /** The Clients of the contacts on it, by name, in the order of `clientIds`. */
  clients: ClientLabel[]
}

export interface Queue {
  filter: QueueFilterId
  filters: QueueFilter[]
  rows: QueueRow[]
  /**
   * The drafts that sit on no conversation (a new email to a contact, a text, a DM, or a send
   * that never finished and sat on none), newest first. The Drafts view lists them above its
   * rows and its count includes them.
   */
  looseDrafts: MessageRow[]
  /** Whether the Client list answered; when it did not, the Clients above are shown by number. */
  directory: DirectoryStatus
}

/** A conversation that matched a search, with a line of the newest message whose text has one of the words. */
export interface SearchHit extends QueueRow {
  /** Null when the words were only in names, addresses or subjects, and the row's own snippet is what to show. */
  match: string | null
}

/**
 * The answer to a search (`GET /api/search?q=`): the conversations, open or closed, that have every word of the
 * query somewhere on them, newest first. `terms` are the words as the Worker read them (what the screen marks);
 * `more` says there were others beyond this screen of rows. Empty rows for a query with no words.
 */
export interface SearchResult {
  query: string
  terms: string[]
  rows: SearchHit[]
  more: boolean
  directory: DirectoryStatus
}

/**
 * What a press of Send names of what its author was shown: the draft's revision, and, for a
 * reply, how far into the conversation the page reached. Either is null when the caller left
 * it out, which the store refuses wherever it applies.
 */
export interface SendRequest {
  rev: number | null
  through: number | null
  /**
   * Claude's send only: the owner's instruction, as it arrived from outside, so nothing about
   * its shape is assumed (the store checks it; see MailStore.checkInstruction). Left out
   * means none, which the store refuses for Claude. A send by the owner needs none, and one
   * given with it is ignored and never recorded, because a record of an instruction they did
   * not give Claude would be a false one.
   */
  instruction?: unknown
  /**
   * Claude's send of a Telegram draft that carries a picture only: the picture's fingerprint (its SHA-256 as `drafts` printed it), so the owner's word covers the picture they approved and no other. It is a check and
   * not content: none named for a draft with a picture is a 422, another one a 409, one named for a draft with none a 409. A send by the owner ignores it (they see the picture themselves).
   */
  picture?: unknown
}

/** Whether Claude may send on the owner's instruction, and who last changed it and when. Off until the owner turns it on. */
export interface ClaudeSending {
  enabled: boolean
  changedAt: string | null
  changedBy: string | null
}

/**
 * One of Claude's sends, as the list behind Claude's script gives it (there is no page of them: each is
 * marked in its own conversation): a message Claude sent on an instruction, with that instruction.
 * `proof` says how the inbox knows it went out:
 *   `filed`: Gmail accepted it and the inbox filed it; `at` is when it was sent.
 *   `gmail`: Gmail never answered and the stuck row has not been resolved, but Gmail's own copy
 *     has arrived (the same Message-ID); `at` is when that copy was sent.
 *   `owner`: Gmail never answered and the owner looked in Gmail Sent and said it went out; the
 *     message is as it stood when it was claimed, and `at` is when they said so.
 */
export interface ClaudeSend {
  message: MessageRow
  proof: 'filed' | 'gmail' | 'owner'
  at: string
}

export interface DraftInput {
  /**
   * On a draft in an email conversation: also address it to everyone else on the message
   * it answers (its From, To and Cc, less our own address and the recipient), written
   * into the draft's Cc when it is made so it can be read before it is sent. Off by
   * default, because copying too few people is the safer mistake.
   */
  copyEveryone?: boolean
  /** File the draft under an existing conversation. */
  conversationId?: string
  /** Or address it to an existing contact. */
  contactId?: string
  /** Or to an address, which becomes a contact if it is new. */
  address?: string
  /** The name for a contact this draft creates. Ignored for a known address. */
  name?: string
  /**
   * Which mailbox a NEW email (no conversation) goes out from, chosen by the person at the space's compose box: the owner's Gmail, or a business mailbox by its id. Absent is the
   * inbox's own rule, the mailbox the contact last wrote to. Ignored on a reply, which goes from the mailbox its conversation is in. Never read from a request body: only the space's
   * entrypoint sets it (src/space.ts), after it has verified the owner; the routes build their input field by field and do not carry it. Claude's choice is `chooseFrom` below, which the
   * store resolves into this.
   */
  sendFrom?: InboxFrom
  /**
   * Claude's choice of the mailbox a NEW email goes out from (ADR 0001 decision 26): a mailbox's address or its name as `mailbox` and `mailboxes` list
   * them, said as text and read from the request body by the agent route. The store resolves it (`MailStore.resolveChosenFrom`) into the same choice the compose box makes and
   * refuses, with nothing drafted, a mailbox it does not know, a Gmail account that is disconnected or lapsed, and any use on a reply (a reply goes from its conversation's mailbox).
   * Still only a draft: sending is untouched. Not read together with `sendFrom` (a caller that sets one does not set the other).
   */
  chooseFrom?: string
  subject?: string
  body: string
  why?: string
}

export interface DraftPatch {
  /**
   * The revision its author was shown, REQUIRED from everyone (the route refuses an edit without one, 422, as it does a
   * send): a draft edited since is refused (409), so words saved over a draft somebody changed meanwhile are never
   * applied unseen, whoever saves them.
   */
  rev: number
  /** Recompute (true) or clear (false) the draft's Cc, as in DraftInput. */
  copyEveryone?: boolean
  subject?: string
  body?: string
  why?: string
  /**
   * Take the draft's picture out: its entry and key leave the row and the object is deleted by the sweep, in the same change as the rest of the edit, which raises the
   * revision like any edit. Only `true` means it; a draft with no picture is changed by nothing, and words may then not be blank (a picture is what let them be).
   */
  takeOutPicture?: boolean
}

/** One entry of the Outbox's list, as `outbox.ts list` prints it. */
export interface OutboxEntry {
  id: string
  to: string
  channel?: string
  address?: string
  subject?: string
  why?: string
  body: string
  created?: string
  sentAt?: string | null
}

export interface CarryReport {
  received: { total: number; unsent: number; sent: number }
  /** Drafts and manual-sent messages that now exist because of this run. */
  created: { drafts: number; manualSent: number }
  /** Already carried on an earlier run and unchanged. */
  skipped: number
  /** Carried as a draft earlier and marked sent in the Outbox since. */
  markedSent: number
  contactsCreated: number
  /** Entries that could not be carried, with the reason. Never silent. */
  problems: { id: string; reason: string }[]
}

/**
 * The actor on everything Cloudflare's mail entrance did: a message arriving, a contact made for its sender. Like
 * GMAIL_ACTOR, an audit entry or stamp with this actor means the inbox was told, not asked.
 */
export const CLOUDFLARE_ACTOR = 'cloudflare'

/**
 * The actor on everything the Telegram bridge did: a message arriving, a contact made for its sender, an edit or a deletion. Like
 * CLOUDFLARE_ACTOR, an audit entry or stamp with this actor means the inbox was told, not asked.
 */
export const TELEGRAM_ACTOR = 'telegram'

/**
 * The Telegram mailbox as the script shows it: whether the Telegram bridge is talking, what it last said of itself, and the
 * counts. One row for the owner's one account; never carries anything secret (the login lives in the bridge, not here).
 */
export interface TelegramMailboxStatus {
  id: string
  kind: 'telegram'
  /** The Telegram user id of the account the bridge is signed in as. */
  address: string
  name: string
  createdAt: string
  /**
   * `live`: the bridge checked in lately and reports it is caught up. `catching-up`: it is reading a gap or the first fill in. `signed-out`: Telegram ended the saved login; only the owner can
   * sign in again. `not-checked-in`: the bridge has not asked for work for five minutes (or never has), whatever it last said.
   */
  state: 'live' | 'catching-up' | 'signed-out' | 'not-checked-in'
  /** What the bridge last said of itself, and when; null before it has said anything. */
  reported: { state: 'live' | 'catching-up' | 'signed-out'; at: string } | null
  checkedInAt: string | null
  lastPushAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  /** Whether Telegram's position is stored, which is what a reconnect catches up from; false until the first fill has been stored. */
  hasPosition: boolean
  /**
   * The read marks the space owes Telegram: chats the owner opened in the space whose mark the bridge has not yet made and reported. Normally 0, for a few seconds after they open a
   * conversation. A count that stays up, or an `oldestReadMarkOwed` that is minutes old, means the bridge is not doing them (it is down, or Telegram keeps refusing).
   */
  readMarksOwed: number
  /** When the oldest of those was last set (ISO; opening the same chat again raises it and moves this), or null when none is owed. */
  oldestReadMarkOwed: string | null
  /**
   * The sends waiting on the bridge: messages the owner (or Claude, on their instruction) sent from the space that Telegram has not yet taken. Normally 0, for a few seconds after a press. A count
   * that stays up means the bridge is not sending (down, or Telegram keeps refusing); `unknownSends` is how many of those the bridge was offered more than five minutes ago and never answered: no longer
   * offered, shown as "check Telegram", and settled only by the owner.
   */
  sendsOwed: number
  unknownSends: number
  messages: number
  conversations: number
  /** The open conversations that are not Bulk, and the unread ones of those. */
  open: number
  unreadOpen: number
  /** Amber when `reasons` is not empty; each is a sentence for the owner. */
  health: { amber: boolean; reasons: string[] }
}

/**
 * What the spam classifier said of one message (packages/inbox/docs/adr/0001, decision 22): the probability that it is unsolicited
 * (`junk`), the kind it chose from a closed list, and the model that said so. The score is a stored fact; what it means (Bulk
 * at or over CLEF_JUNK_THRESHOLD) is the queue's rule in src/queue.ts.
 */
export interface ClefFacts {
  junk: number
  category: string
  model: string
}

/** A mailbox as a conversation carries it: the mark on its row (the pill). A business mailbox's name is its display name; a Gmail account's is its short label (src/gmail/account.ts). */
export interface MailboxMark {
  id: string
  name: string
  address: string
}

/** What the header shows about the connection. Never carries the refresh token. */
export interface MailboxStatus {
  /** The mailbox's id: what a reconnect, a disconnect and a "From" name. */
  id: string
  kind: 'gmail'
  address: string
  /** The short label its conversations carry as a pill (the address when none was given). */
  name: string
  /** Whether a token is held. False after a disconnect, until Gmail is connected again. A lapsed grant is still "connected": the token is held, and Google no longer accepts it. */
  connected: boolean
  /**
   * `lapsed`: Google no longer accepts the saved grant (a Google app in testing mode loses every grant after 7 days, and a revoke does the same); nothing syncs or sends for the
   * account until it is connected again. `filling`: the first fill (FILL_DAYS of mail) is still being read in. `resyncing`: the
   * cursor went stale and the inbox is reading a window again. `live`: pushes and
   * the daily pass keep it current.
   */
  state: 'disconnected' | 'lapsed' | 'filling' | 'resyncing' | 'live'
  /** When the grant was found gone; null while it works. */
  lapsedAt: string | null
  /** Whether this is the account a new email goes out from when nothing else decides it (`MailStore.defaultGmail`): at most one account is. */
  sendsByDefault: boolean
  connectedAt: string | null
  watchExpiry: string | null
  lastPushAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastResyncAt: string | null
  /** Messages and conversations stored for this mailbox, for comparing with Gmail's own counts. */
  messages: number
  conversations: number
  /**
   * Conversations in Gmail's Inbox (any message carries INBOX), and the ones of those
   * with an unread message. Bulk is counted, as Gmail's Inbox counts it. These are the numbers to
   * compare with Gmail's own unread count (the runbook says how).
   */
  open: number
  unreadOpen: number
  /** Amber when `reasons` is not empty; each is a sentence for the owner. */
  health: { amber: boolean; reasons: string[] }
}

/**
 * A mailbox on the company's own mail server, read and written over JMAP, as Settings and the script show it. Declared in the deploy config (`INBOX_JMAP_MAILBOXES`),
 * its row made by the first alarm after a deploy. Never carries a key: the key is a secret of the Worker.
 *
 * `state`: `live` (pushes and the daily pass keep it current), `filling` (the first fill of FILL_DAYS of mail is being read in), `resyncing` (the cursor went stale and a window is being read again), `refused` (the server
 * refused the space's key: nothing syncs or sends for it until a deploy changes the key), `unreachable` (the last attempt failed: the server is down, or answered an error; `lastErrorAt` says since when), `undeclared`
 * (taken out of the declaration: kept, not synced), `no-credential` (declared, but the Worker holds no key by the name the declaration gives).
 */
export interface JmapMailboxStatus {
  id: string
  kind: 'jmap'
  address: string
  /** The pill its conversations carry. */
  name: string
  declared: boolean
  state: 'live' | 'filling' | 'resyncing' | 'refused' | 'unreachable' | 'undeclared' | 'no-credential'
  refusedAt: string | null
  connectedAt: string
  lastPushAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastResyncAt: string | null
  /** Whether the server has been given the inbox's push address and has verified it: `live` (it calls on every change), `waiting` (made, not yet verified), `off` (none: mail arrives by the daily pass alone). */
  push: 'live' | 'waiting' | 'off'
  messages: number
  conversations: number
  open: number
  unreadOpen: number
  /** Amber when `reasons` is not empty; each is a sentence for the owner. */
  health: { amber: boolean; reasons: string[] }
}

/**
 * A Cloudflare mailbox as the script and (later) Settings show it: when mail last arrived, whether filing a message has
 * failed, and how many kept messages are still owed a filing. Declared in the deploy config and recorded the first time
 * mail arrives for it; never carries anything secret.
 */
export interface CloudflareMailboxStatus {
  id: string
  kind: 'cloudflare'
  address: string
  name: string
  createdAt: string
  lastArrivalAt: string | null
  lastFilingError: string | null
  lastFilingErrorAt: string | null
  /** Raw copies kept in the bucket that the inbox has not filed yet; the alarm retries them. */
  owed: number
  /** Raw copies kept in the bucket that could not be filed after the bounded number of tries: still kept, no longer retried. */
  gaveUp: number
  /** The spam check on this mailbox (under the switch's first name): whether it runs, who last switched it and when, and how many messages the spam classifier has judged. */
  assistant: AssistantSwitch
  messages: number
  conversations: number
  /** The open conversations that are not Bulk, and the unread ones of those: the mailbox's own view and its menu counts. */
  open: number
  unreadOpen: number
  /** Amber when `reasons` is not empty; each is a sentence for the owner. */
  health: { amber: boolean; reasons: string[] }
}

/**
 * Whether the spam check runs on a Cloudflare mailbox. The deploy config declares the starting value; the first time
 * the owner switches it that is overridden, audited, and the declaration no longer decides. `changedBy` is null while the
 * declaration still does. `judged` is how many messages the spam classifier has judged. (Named `assistant` since the switch began as the
 * assistant's: the mailbox column, the declaration key, the route and the audit history carry the name, and renaming them is a
 * migration of its own. The assistant now only drafts when asked, and has no switch.)
 */
export interface AssistantSwitch {
  enabled: boolean
  changedAt: string | null
  changedBy: string | null
  judged: number
}

/** What a spam call is refused with on a conversation that is in no mailbox (a text, a DM): there is no Inbox or Bulk to move it between. */
export const SPAM_NEEDS_MAILBOX =
  'Only an email conversation (Gmail’s or a business mailbox’s) can be moved to Bulk or back by hand.'

/** The open conversations of one kind of mailbox, by where the queue puts them and, for Bulk, by the rule that did it. */
export interface BulkCounts {
  open: number
  inbox: number
  bulk: number
  byReason: { unsubscribe: number; category: number; automated: number; clef: number; moved: number }
}

/**
 * What the queue's one Bulk rule does to the open conversations now, per kind of mailbox, and how many open Gmail conversations
 * are Bulk ONLY because their sender is automated (a no-reply address or a machine-made name): those are the ones ADR 0001 decision 23
 * moved out of the Gmail Inbox when the rule came to Gmail. It is a view, never a change: Gmail's labels are untouched, nothing
 * is deleted, and nobody is notified for it. `senders` names who they are, most conversations first.
 */
export interface BulkReport {
  gmail: BulkCounts
  cloudflare: BulkCounts
  gmailMovedByAutomatedRule: number
  senders: { name: string; address: string; conversations: number }[]
}

/**
 * The assistant's calls to the model and what they cost in tokens, over a period, for the first week's report to the owner.
 * `estimatedCostUsd` is the tokens priced at the model's list rates (src/assistant/pricing.ts), an ESTIMATE to be checked
 * against the key's own usage in Anthropic's console; null while any call was made on a model with no price here.
 */
export interface AssistantUsage {
  since: string
  until: string
  /** Whether the Worker has a key to call the model with at all. */
  keyConfigured: boolean
  calls: number
  succeeded: number
  failed: number
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number | null
  byModel: { model: string; calls: number; inputTokens: number; outputTokens: number; priced: boolean }[]
}

/** The longest instruction a chat turn takes: a sentence or two, not a document to paste. */
export const MAX_CHAT_INSTRUCTION = 2000

/** What one chat turn answers: the draft as it stands now (revised or not), and the turn that was kept. */
export interface ChatAnswer {
  draft: MessageRow
  turn: ChatTurn
}

// ─── Clients ───────────────────────────────────────────────────────────

/**
 * A Client as the inbox uses it: what the Clients part (packages/clients) holds of one, cut to what the inbox's screens and rules read. The inbox keeps none of it: the part is asked
 * whenever a request needs it and nothing is cached. What a Client's source says of it is the part's generic `source` fields (`url`, `extra`); the inbox reads ONE key of `extra`, the one the
 * company declaration names as holding an address to suggest by (`clientsDoor.suggestByAddressKey`), and hands the rest on as text it does not understand.
 */
export interface ListedClient {
  id: number
  name: string
  legalEntity: string | null
  /** The address the source's declared key holds, normalised; null where the install declares no such key, the source said none, or the Client was made in the space. */
  matchAddress: string | null
  /** Whatever else the source last said, as its sender named it (text under plain keys). Empty for a Client made in the space. */
  extra: Record<string, string>
  /** The Client in its source's admin (the source's address of it), or null. */
  adminUrl: string | null
  /** Archived Clients are left out of the menu and the pickers; their people stay linked. */
  archived: boolean
}

/** Whether the Clients part answered, and if not, why, in a sentence for the owner. */
export interface DirectoryStatus {
  available: boolean
  error: string | null
}

/** A Client on its own page and in the Clients list: the part's answer, or the id alone when it has none. */
export interface ClientView extends ClientLabel {
  legalEntity: string | null
  extra: ListedClient['extra']
  /** The Client in its source's admin, or null (made in the space, or the source gave no address). */
  adminUrl: string | null
  archived: boolean
}

export interface ClientListEntry extends ClientView {
  /** Contacts assigned to this Client. */
  contacts: number
  /** Conversations with any of them, open or not. */
  conversations: number
  /** Of those, the open ones. */
  open: number
}

export interface ClientList {
  directory: DirectoryStatus
  clients: ClientListEntry[]
}

/** A Client's page: who they are, their contacts and every conversation with any of them. */
export interface ClientPage {
  directory: DirectoryStatus
  client: ClientView
  contacts: (ContactListItem & { client: ClientLabel | null })[]
  /** The latest screen of the conversations with any of them (QUEUE_PAGE at most). */
  conversations: QueueRow[]
  /** How many there are in all, so a page that shows fewer says so. */
  conversationsTotal: number
}

/**
 * A Client the inbox suggests for a contact, and why. Computed, never stored: it takes
 * effect only when somebody accepts it, which is an assignment like any other.
 *   `address`: one of the contact's addresses IS the address the Client's source gave (the declared `suggestByAddressKey`).
 *   `domain`: one of the contact's addresses is on a domain that people already assigned to
 *   this Client (and to no other) write from.
 * `via` is the address or the domain that matched, so the reason can be read.
 */
export interface ClientSuggestion {
  contactId: string
  contactName: string
  clientId: number
  clientName: string
  reason: 'address' | 'domain'
  via: string
}

/** The contact's own card as the Worker answers it: the store's card, the Client named, and what is suggested. */
export interface ContactPage extends ContactCard {
  client: ClientLabel | null
  directory: DirectoryStatus
  suggestions: ClientSuggestion[]
}

/** A conversation as the Worker answers it: the store's detail, and the Clients of its contacts by name. */
export interface ConversationPage extends ConversationDetail {
  clients: ClientLabel[]
}

// ─── notifications ───────────────────────────────────────────────────────────────

/**
 * What one notification carries to a device, encrypted to it (src/notify/rule.ts builds it, the service worker reads
 * it): the sender over the subject, and the ids a tap needs. Nothing of the message's text, its addresses (a space device's carries the
 * sender's, for its tap: `person`), a Client or anything Claude wrote. `conversationId` is null for a summary and for the test notification, whose tap opens the Inbox.
 */
export interface NotificationPayload {
  v: 1
  /** One message; several collapsed into one (src/notify/rule.ts, COLLAPSE_AFTER), whose tap opens the Inbox; or the test. */
  kind: 'message' | 'summary' | 'test'
  conversationId: string | null
  /**
   * For a SPACE device only (never on the payload an inbox device is sent): the sender's email address, normalised, which the space's service
   * worker opens as `/inbox/<address>`. The space's conversations are one per person, not per email thread, so the inbox's
   * conversation id means nothing there. Absent on a summary and on the test, whose tap opens the Conversations list.
   */
  person?: string
  /** The message's id: the notification's tag, so a repeat replaces it silently. */
  messageId: string
  title: string
  body: string
  /** Gmail's received time (ISO), or when the test was sent. */
  at: string
}

/**
 * One browser or installed app, on one phone or computer, where the owner turned notifications on. Never its keys. The
 * push service address is here so the page can tell which device is the browser it is running in.
 */
export interface Device {
  id: string
  /** Read from the browser that turned it on: "Chrome on Android", "Chrome on macOS". */
  label: string
  endpoint: string
  addedAt: string
  lastDeliveredAt: string | null
  lastFailedAt: string | null
  lastFailure: string | null
  /** How the last failure was read; "turn notifications on again" is offered only for `refused`. */
  lastOutcome: DeliveryOutcome | null
  /** Every notification the push service took for it, and every one it did not. */
  delivered: number
  failed: number
}

/**
 * Settings' Notifications section: the public key a browser turns notifications on with, every device, and the last
 * seven days' notifications sent and dropped (the first week's numbers to compare).
 */
export interface NotificationSettings {
  publicKey: string
  devices: Device[]
  week: { sent: number; dropped: number }
}

/** What the push service said to one request, as the inbox reads it (src/notify/deliver.ts `outcomeOf`). */
export type DeliveryOutcome = 'delivered' | 'gone' | 'refused' | 'too-large' | 'failed'

/** The answer of every notification route while the Worker has no key. */
export const NOTIFICATIONS_NOT_SET_UP = 'Notifications are not set up on the inbox: the Worker has no key to send with.'
