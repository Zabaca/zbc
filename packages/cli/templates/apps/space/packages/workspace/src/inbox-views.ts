// The inbox's other views, as the inbox answers the space: Claude's sending switch, the mailboxes and the
// spam check, notifications, restore, Clients, and the draft chat. The shapes only; the methods that return them are on
// `InboxForSpace` (inbox-for-space.ts), and the rules every one of them follows are that file's header and asking.ts: the person the space's check named
// first (`SignedIn`), the inbox's own owner rule, a `SpaceReply` back, times in milliseconds, one spelling for an address.
//
// Cut down to what the space draws from the inbox's own page (packages/inbox/src/types.ts): a field the page does not draw is not here. The one
// exception to milliseconds is RESTORE, which keeps the inbox's ISO text because a person picks a time in their own zone and the store's
// bookmarks are asked for by that text.
//
// EVERY WRITE HERE IS THE OWNER ACTING THROUGH THE SPACE'S SIGN-IN CHECK. The inbox admits its owner and nobody else (a teammate is `not-admitted`),
// and Claude's sending switch, the spam check and restore are the owner's alone in the store as well. Claude has no way in: the
// layer's check refuses a service token, and the inbox's own page of Settings is what the space replaces.
//
// NO COMPOSE KEY on these writes, because none of them makes anything go out. Each is made safe to repeat another way: the two switches and
// "link to a Client" set a value (twice is once), adding a device is by its push address, a restore names a one-time token, and a chat turn names the draft's revision
// (a repeat after a revision is `conflict`). The knowledge base is the knowledge app's (knowledge.ts).

import type { InboxMailbox } from './inbox-for-space'
import type { Install } from './install'
import type { ClientRef } from './rows'

/** What a business mailbox's id looks like (the inbox's own: an address or a slug). The one pattern, for the inbox and the space: a path-shaped or enormous string never reaches a query. */
export const MAILBOX_ID = /^[A-Za-z0-9@._+-]{1,120}$/

// ── The menu: what the inbox's own left nav counts ───────────────────────────────────────────────────────────────────────────

/** One entry of the menu: how many rows of its list (a person each; over every conversation, not a screen of them) and how many of those rows have something unread. */
export interface InboxNavCount {
  count: number
  unread: number
}

/** A business mailbox as the menu has it: its open conversations that are not Bulk, and the line the foot of the menu says of it (`reason` is why it needs a look, or null). */
export interface InboxNavMailbox extends InboxMailbox {
  count: number
  unread: number
  lastArrivalAt: number | null
  reason: string | null
}

/**
 * Where the Telegram bridge stands, in the four words the menu's foot and Settings tell it by : `live`; `catching-up` (a gap or the first fill is being read in);
 * `signed-out` (Telegram ended the saved login: only the owner can sign in again); `not-checked-in` (the bridge has asked for nothing for five minutes, whatever it last said of itself).
 */
export const TELEGRAM_STATES = ['live', 'catching-up', 'signed-out', 'not-checked-in'] as const
export type InboxTelegramState = (typeof TELEGRAM_STATES)[number]

/**
 * The Telegram mailbox in the menu: a place in the Mailboxes tree like a business mailbox (its open conversations that are not Bulk) and the line at the foot. The words are the page's
 * (packages/space/src/client/telegram.ts), from the state and the times, so the foot and Settings say the same sentence and the time is the person's own zone. Names and numbers only.
 */
export interface InboxNavTelegram extends InboxMailbox {
  count: number
  unread: number
  state: InboxTelegramState
  /** When the bridge last asked the space for work (its heartbeat); null if it never has. */
  checkedInAt: number | null
  /** When the bridge last pushed a message; null if it never has. */
  lastPushAt: number | null
}

/** A Client the space holds (or one the inbox holds people under, shown by number), with its open conversations. */
export interface InboxNavClient {
  id: number
  name: string
  listed: boolean
  count: number
  unread: number
}

/**
 * What the inbox's own left menu reads, in one answer: the views' counts, each business mailbox, each Client with its open count, how many contacts there are, and
 * Gmail's line. Every count is the inbox's own, from the same plan its own Inbox, Unread, Drafts, Bulk and Closed use (`planQueue`), so a badge in the space agrees with the
 * inbox's. They are counts of ROWS, the unit of the space's Conversations list (a person each, so a person with two open threads is one row and a thread two people are on is a row under
 * each), over every conversation and not cut to the newest screen the lists are (packages/inbox/src/store/row-counts.ts; packages/space/test/nav-counts.test.ts holds them to the
 * lists). The inbox's own queue routes (Claude's script) still count conversations.
 * Names only, no message text, address of a person, or token.
 */
export interface InboxNav {
  views: { inbox: InboxNavCount; unread: InboxNavCount; drafts: InboxNavCount; bulk: InboxNavCount; closed: InboxNavCount }
  mailboxes: InboxNavMailbox[]
  clients: InboxNavClient[]
  contacts: number
  /** Each Gmail account's line at the foot of the menu, oldest first; empty until one was connected. `reason` is why it needs a look (a lapsed grant says so), or null. */
  gmailAccounts: InboxNavGmail[]
  /** The Telegram mailbox, once the bridge has said anything; null before, and ABSENT from an inbox that predates it: the menu then has no Telegram line. */
  telegram?: InboxNavTelegram | null
  /** The mailboxes on the install's own mail server (JMAP), each a place in the Mailboxes tree like a business mailbox and a line at the foot; ABSENT from an inbox that predates them. */
  jmap?: InboxNavJmap[]
}

/**
 * Where a mailbox on the mail server stands, in the words Settings and the menu's foot tell it by: `live`; `filling` (the first 30 days are being read in);
 * `resyncing` (the inbox lost its place and is reading a window again); `refused` (the server refused the space's key: nothing arrives or goes out until a deploy changes it); `unreachable` (the last try
 * failed: the server is down or answered an error; `lastErrorAt` says since when); `undeclared` (taken out of the deploy's declaration: kept, not synced); `no-credential` (declared, but the Worker holds no key for it).
 */
export const JMAP_STATES = ['live', 'filling', 'resyncing', 'refused', 'unreachable', 'undeclared', 'no-credential'] as const
export type InboxJmapState = (typeof JMAP_STATES)[number]

/** Whether the server has been given the inbox's push address and has confirmed it (`live`: it calls the inbox when mail arrives), has not yet (`waiting`), or has none (`off`: mail arrives by the daily pass). */
export const JMAP_PUSH_STATES = ['live', 'waiting', 'off'] as const
export type InboxJmapPush = (typeof JMAP_PUSH_STATES)[number]

/** A mailbox on the mail server in the menu: a place in the Mailboxes tree (its open conversations that are not Bulk) and the line at the foot. `reason` is why it needs a look (a refused key says so), or null. */
export interface InboxNavJmap extends InboxMailbox {
  count: number
  unread: number
  state: InboxJmapState
  /** When it last finished a sync; null if it never has. */
  lastSyncAt: number | null
  reason: string | null
}

/** One Gmail account in the menu's foot: its id and pill name, and the line that says whether it is well. */
export interface InboxNavGmail {
  id: string
  name: string
  address: string
  connected: boolean
  state: (typeof GMAIL_STATES)[number]
  lastPushAt: number | null
  reason: string | null
}

// ── Claude's sending ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether Claude may send on the owner's instruction, and when it was last changed. OFF until the owner turns it on; a switch Claude can read and never flip. */
export interface InboxClaudeSending {
  enabled: boolean
  changedAt: number | null
}

// ── Mailboxes, the spam check and the Gmail connection ───────────────────────────────────────────────────────────────────

/** The spam check on a business mailbox: whether it runs, who last switched it (null while the deploy's declaration still decides), and how many messages the spam classifier has judged. */
export interface InboxSpamCheck {
  enabled: boolean
  changedAt: number | null
  changedBy: string | null
  judged: number
}

/** A business mailbox (a business's own address, such as Brightwater's) as Settings shows it. `reasons` are the sentences that make it need a look; none means it is fine. */
export interface InboxBusinessMailbox extends InboxMailbox {
  lastArrivalAt: number | null
  lastFilingError: string | null
  messages: number
  conversations: number
  open: number
  unreadOpen: number
  spamCheck: InboxSpamCheck
  reasons: string[]
}

/**
 * The Telegram mailbox as Settings shows it (one for the owner's one account). `checkedInAt` is the bridge's heartbeat and `reportedAt` when it last said its state; the page words them. Never
 * anything secret: the login lives in the bridge's guest, not here. `filled` is whether Telegram's position is stored, which is what a reconnect catches up from (false until the first fill is stored).
 */
export interface InboxTelegram extends InboxMailbox {
  state: InboxTelegramState
  reportedAt: number | null
  checkedInAt: number | null
  lastPushAt: number | null
  filled: boolean
  messages: number
  conversations: number
  open: number
  unreadOpen: number
}

/**
 * A mailbox on the install's own mail server as Settings shows it: read and written over JMAP, declared in the deploy, its key a secret of the Worker. Never the key.
 * `reasons` as above: none means it is fine. `refusedAt` is when the server refused the space's key (null while it works) and `reasons[0]` says it in words. Sync now is `changeGmail('sync', id)`, which takes this
 * mailbox's id as it takes a Gmail account's.
 */
export interface InboxJmap extends InboxMailbox {
  /** Whether the deploy still declares it. A mailbox taken out is kept with its mail and not synced. */
  declared: boolean
  state: InboxJmapState
  refusedAt: number | null
  push: InboxJmapPush
  lastPushAt: number | null
  lastSyncAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  messages: number
  conversations: number
  open: number
  unreadOpen: number
  reasons: string[]
}

export const GMAIL_STATES = ['disconnected', 'lapsed', 'filling', 'resyncing', 'live'] as const

/**
 * One of the owner's Gmail accounts. Never the token. `reasons` as above. `lapsed` is the state Settings must say clearly: Google no longer accepts the saved grant (a Google app in testing mode loses
 * every grant after 7 days), so nothing arrives or goes out until the account is connected again; `lapsedAt` is when that was found and `reasons[0]` says it in words.
 */
export interface InboxGmail {
  /** The mailbox's id: what Connect again, Disconnect, Sync and a new email's From name. */
  id: string
  address: string
  /** The short label its conversations carry as a pill. */
  name: string
  connected: boolean
  state: (typeof GMAIL_STATES)[number]
  lapsedAt: number | null
  /** Whether a new email left on Automatic goes from this account when the person has not written to them before (the inbox's default Gmail). ABSENT from an inbox that predates it: read as false. */
  sendsByDefault?: boolean
  lastPushAt: number | null
  lastSyncAt: number | null
  watchExpiry: number | null
  messages: number
  conversations: number
  open: number
  unreadOpen: number
  reasons: string[]
}

/**
 * What this inbox can do that an older inbox could not, as it says so in an answer the space already reads (`mailboxes`). A field an older inbox does not know is IGNORED by it, not refused, so
 * the space cannot learn from a refusal that it was not understood: it asks, and sends nothing that depends on a capability the answer does not list.
 *
 * - `new-email-from-and-files`: a new email through `send` honours `from` (the mailbox the person chose) and `attachments`. An inbox without it would send the email from the mailbox the contact last wrote to
 *   and drop the files without a word, so the space refuses, in words, to send a new email that picks a mailbox or carries files unless this is listed.
 */
export const INBOX_CAPABILITIES = ['new-email-from-and-files'] as const
export type InboxCapability = (typeof INBOX_CAPABILITIES)[number]

/** The capability a new email that picks a mailbox or carries files depends on. */
export const NEW_EMAIL_CAPABILITY: InboxCapability = 'new-email-from-and-files'

export interface InboxMailboxes {
  /** The owner's Gmail accounts, oldest first; empty until one was connected. A disconnected one stays listed, so it can be connected again. */
  gmailAccounts: InboxGmail[]
  mailboxes: InboxBusinessMailbox[]
  /** The Telegram mailbox, once the bridge has said anything; null before, and ABSENT from an inbox that predates it: Settings then has no Telegram card. */
  telegram?: InboxTelegram | null
  /** The mailboxes on the mail server, declared in the deploy (an empty list when none is); ABSENT from an inbox that predates them: Settings then has no such card. They are business mailboxes to a person: they are offered in From. */
  jmap?: InboxJmap[]
  /** Whether the inbox has the assistant's key, which the draft chat needs and the spam check does not. */
  assistantKey: boolean
  /** What this inbox can do (`INBOX_CAPABILITIES`). ABSENT from an inbox that predates capabilities: read as none. */
  capabilities?: string[]
}

/**
 * What can be done to a Gmail account from here: ask Gmail what changed, or disconnect it (which withdraws the permission at Google). Connecting is two steps on the space's own path (below), not one call.
 * `sync` also takes the id of a mailbox on the mail server (`InboxJmap.id`), which asks the server what changed; such a mailbox is not connected or disconnected from here, it is declared in the deploy.
 */
export type InboxGmailChange = 'sync' | 'disconnect'
/**
 * Connecting Gmail, in the space. Two navigations of the browser, both on the space's host, and the inbox's two methods behind them:
 * `/api/inbox/gmail/start` asks the inbox for Google's sign-in address (`gmailSignIn`) and sends the browser there, and Google sends it back to `/api/inbox/gmail/callback`, which hands the
 * code to the inbox (`gmailConnect`) and goes on to Settings. `start` takes the account to connect again as `?account=<mailbox id>` (`GMAIL_ACCOUNT_PARAM`), which only becomes Google's sign-in hint: the account that
 * signs in is the one the person picks at Google, and any address may be connected. The return address is registered by hand on the Google client, so it is written once and pinned by a test: the space's host
 * from the declaration, and this path.
 */
export const GMAIL_START_PATH = '/api/inbox/gmail/start'
export const GMAIL_RETURN_PATH = '/api/inbox/gmail/callback'
export const GMAIL_ACCOUNT_PARAM = 'account'

/**
 * What a Connect is for. The mailboxes' Connect is `mail`: mail's permissions alone. Settings, Calendars has a button of its own, `calendar` (`start?for=calendar`), which asks for the calendar permission alone, incrementally.
 * They are two requests so that mail is never held behind a calendar consent: a Workspace admin who restricts the calendar scope breaks the calendar button and nothing else.
 */
export const GMAIL_PURPOSES = ['mail', 'calendar'] as const
export type GmailPurpose = (typeof GMAIL_PURPOSES)[number]
export const GMAIL_FOR_PARAM = 'for'

/** The address Google sends the browser back to for an install: "https://space.northfield.example/api/inbox/gmail/callback" for Northfield Works. The inbox derives it, and the space only serves the path. */
export const gmailReturnUrl = (install: Pick<Install, 'url'>): string => `${install.url().replace(/\/+$/, '')}${GMAIL_RETURN_PATH}`

/** What the check the space makes (a random hex string it keeps in a cookie and Google carries back untouched) looks like; the inbox refuses anything else before it builds an address with it. */
export const GMAIL_STATE = /^[0-9a-f]{32,128}$/

/** The most a code from Google is taken as: they are short, and the inbox does not pass on anything longer. */
export const GMAIL_CODE_MAX = 2048

/** Google's sign-in address for one attempt: the browser is sent to it. Carries the check the space gave and the return address of the space. */
export interface InboxGmailSignIn {
  url: string
}

export interface InboxGmailChanged {
  change: InboxGmailChange
  /** On a disconnect: whether Google confirmed the permission was withdrawn. */
  revoked: boolean | null
}

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DEVICE_ORIGINS = ['inbox', 'space'] as const
/** Which page turned a device on: the inbox's installed app, or the space's. The sender serves both until the inbox's is removed. */
export type InboxDeviceOrigin = (typeof DEVICE_ORIGINS)[number]

/** One browser or installed app where notifications were turned on. Never its keys. `endpoint` lets a page tell which device is the browser it runs in. */
export interface InboxDevice {
  id: string
  label: string
  origin: InboxDeviceOrigin
  endpoint: string
  addedAt: number
  lastDeliveredAt: number | null
  lastFailedAt: number | null
  lastFailure: string | null
  /** The push service refused the last notification (a key it no longer matches): turning notifications on again here fixes it. */
  refused: boolean
  delivered: number
  failed: number
}

export interface InboxNotifications {
  /** The key a browser turns notifications on with; null while the inbox has none, and then nothing can be turned on or sent. */
  publicKey: string | null
  devices: InboxDevice[]
  /** The last seven days' notifications sent and dropped. */
  week: { sent: number; dropped: number }
}

/** A device as the browser hands it over (`PushSubscription.toJSON()`). The inbox checks it again: its push service, its keys. */
export interface InboxDeviceInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * What one notification carries to a SPACE device, encrypted to it: the inbox's payload (packages/inbox/src/notify/rule.ts; an INBOX device is sent the same
 * without `person`) and the sender's address in the one spelling the space opens a conversation by. The space's service worker opens
 * `/inbox/<person>` on a tap; a summary and the test have none and open the Inbox list. The inbox pins that its payload is assignable here.
 */
export interface SpacePushPayload {
  v: 1
  kind: 'message' | 'summary' | 'test'
  conversationId: string | null
  person?: string
  messageId: string
  title: string
  body: string
  at: string
}

export interface InboxTestSent {
  outcome: 'delivered' | 'gone' | 'refused' | 'too-large' | 'failed'
  status: number | null
}

// ── Restore ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A preparation or a restore, as kept in the bucket. Times are the inbox's ISO text. */
export interface InboxRestoreRecord {
  kind: 'prepared' | 'restored'
  id: string
  at: string
  actor: string
  target: string
  targetTime: string | null
  undoBookmark: string | null
}

/** The store's bookmark now and the latest records. A read. */
export interface InboxRestoreReport {
  current: string
  restores: InboxRestoreRecord[]
  /** Why the records could not be read, when they could not (the bookmark is still right). */
  restoresError: string | null
}

/** Step one: what would be restored to, and the one-time token that step two must send back. Changes nothing. */
export interface InboxRestorePlan {
  target: string
  targetTime: string | null
  token: string
  expiresAt: string
}

/** Step two: the restore is armed and the store restarts. `undoBookmark` puts back everything it replaced. */
export interface InboxRestoreDone {
  restoredTo: string
  targetTime: string | null
  undoBookmark: string
}

/** Say a moment (an ISO time with its zone) or a bookmark Claude wrote down. */
export type InboxRestoreChoice = { time: string } | { bookmark: string }

// ── Clients ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the Clients part answered the list, and if not, a sentence for the owner. (Named for the screens' field `directory`; the list is the space's own Clients part, no outside site's.) */
export interface InboxDirectory {
  available: boolean
  error: string | null
}

export interface InboxClientSummary extends ClientRef {
  legalEntity: string | null
  /** Contacts linked to them, conversations with any of them, and the open ones. */
  contacts: number
  conversations: number
  open: number
  /** The Client in its source's admin (the Client's source address), or null for a Client made in the space or one the source gave no address. */
  adminUrl: string | null
  /** Whether the Client is archived: out of the lists and pickers, its people still linked. */
  archived: boolean
}

export interface InboxClients {
  directory: InboxDirectory
  clients: InboxClientSummary[]
}

/** A person linked to the Client, or one the inbox suggests (and has not linked: a suggestion counts for nothing until it is accepted). */
export interface InboxClientContact {
  contactId: string
  name: string
  /** Every email address they have, normalised, sorted; empty for a contact known only by a number. */
  addresses: string[]
}

export interface InboxClientSuggestion extends InboxClientContact {
  reason: 'address' | 'domain'
  /** The address or the domain that matched. */
  via: string
}

export interface InboxClientPage {
  directory: InboxDirectory
  client: InboxClientSummary
  contacts: InboxClientContact[]
  suggestions: InboxClientSuggestion[]
}

// ── The draft chat ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One turn: what the owner asked (null on a note the assistant left by itself), what it answered, and whether the draft changed. */
export interface InboxChatTurn {
  seq: number
  at: number
  instruction: string | null
  note: string
  revised: boolean
}

/** What a chat turn asks: the draft it is about, at the revision the owner was shown, and their words. Names a draft always; a conversation with none is not chatted about from the space. */
export interface InboxChat {
  conversationId: string
  draftId: string
  rev: number
  instruction: string
}

/** The draft as it stands now (revised or not; send it with the new `rev`) and the turn kept beside it. Nothing here sends. */
export interface InboxChatAnswer {
  draftId: string
  rev: number
  text: string
  subject: string
  turn: InboxChatTurn
}
