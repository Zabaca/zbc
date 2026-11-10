// Which calls into the inbox's store change what its screens show, for the live object to be told (the space's ADR 0019).
//
// After a change has been STORED the store tells the company's live object that mail moved (packages/workspace/src/live.ts), and the open pages read the mail screens again. The message names no conversation: a
// person's conversation is joined across their addresses, which the store's calls do not all carry, so the page reads the open conversation again (a message that names none re-reads it).
//
// The Durable Object's `call` runs only the names on the lists in app.ts, so the lists here are the same names split in two: the calls that CHANGE something a screen draws, and the rest. A call that only
// reads, and the few that write what no live screen follows (a device, a sending switch, the spam check's switch, a compose key's bookkeeping), are in `UNFOLLOWED`. test/live.test.ts holds the two lists to every
// name `call` accepts, so a method added later is put in one on purpose, and a write that is forgotten shows up as a test failure, not as a page that never updates.
//
// Kept apart from durable.ts, which touches the Workers runtime, so `bun test` loads it.

import type { Install } from '@space/workspace'

/** The calls after which mail (a conversation, a message, a draft, a contact, a mailbox, a queue count) is different. */
export const CHANGING_CALLS = [
  // the store: contacts, drafts and the outbox
  'renameContact',
  'assignClient',
  'mergeContacts',
  'splitIdentity',
  'updateDraft',
  'deleteDraft',
  'markSent',
  'unmarkSent',
  'importOutbox',
  // the Mailroom: close, reopen and read marks, mailboxes, drafts, sending
  'changeConversation',
  'connectMailbox',
  'createDraft',
  'disconnectMailbox',
  'receivePush',
  'requestSync',
  'resolveSend',
  'runDaily',
  'sendDraft',
  // a picture put on a Telegram draft (the card shows it)
  'putDraftPicture',
  // the JMAP room (mailboxes on the mail server): the server told the inbox of a change, a sync asked for, the daily pass
  'receiveJmapPush',
  'requestJmapSync',
  'runJmapDaily',
  // the Telegram bridge: messages, edits and deletions it pushed, and what it says of itself (Settings' card and the menu's line)
  'pushTelegram',
  'telegramEvents',
  'telegramStatus',
  // a photo or a voice note the bridge brought (a thumbnail or a player appears), and what became of one it could not get (the line under the message), or of a send
  'keepTelegramMedia',
  'telegramOutcomes',
  // Cloudflare's mail and its delivery reports (a bounce)
  'fileArrival',
  'keepDeliveryEvents',
  // the assistant: Bulk and back, and a draft written in the draft chat
  'setSpam',
  'chat',
  // a restore (armed here; it takes effect at the object's next start, where the object tells again)
  'confirmRestore',
  // the space's part: a send, a draft made from a new email, a draft thrown away, a contact's profile, an undone merge
  'createComposeDraft',
  'finishCompose',
  'discardComposed',
  'saveContactProfile',
  'undoMerge',
] as const

/** Every other name `call` accepts: reads, and writes that no live screen follows. */
export const UNFOLLOWED_CALLS = [
  'listContacts',
  'getContact',
  'suggestionContacts',
  'clientCard',
  'clientUsage',
  'listConversations',
  'listQueueFacts',
  'bulkReport',
  'searchConversations',
  'getConversation',
  'listDrafts',
  'messageById',
  'listAudit',
  'mailboxStatus',
  'mailboxStatuses',
  'cloudflareMailboxes',
  'cloudflareMailboxMarks',
  // the bridge's work request is its heartbeat, asked every few seconds: it writes one stamp a minute, which no live screen follows (the amber line reads the time on its next read)
  'telegramWork',
  'telegramMailboxes',
  // the picture of a send the bridge is being offered: a read, nothing a screen follows
  'readTelegramPicture',
  'jmapMailboxes',
  // the calendar's door: who is connected, and a calendar-only access token. Nothing a mail screen draws.
  'calendarAccess',
  'calendarGrants',
  'claudeSending',
  'setClaudeSending',
  'listClaudeSends',
  'prepareReply',
  'readAttachment',
  'addDevice',
  'notificationSettings',
  'removeDevice',
  'sendTestNotification',
  'deliverNotifications',
  'setAssistant',
  'assistantUsage',
  'restoreBookmarks',
  'prepareRestore',
  'restartForRestore',
  'claimCompose',
  'noteCompose',
  'releaseCompose',
  'composeOutcome',
  'spaceContact',
  'spaceContactsWith',
  'spaceConversations',
  'spaceSearch',
  'spaceMessages',
  'spaceContacts',
  'spaceContactProfile',
  'spaceRowCounts',
  // who may see which mail: what a person is on, and the mailbox of one conversation or message (src/queue.ts `canSee`)
  'mailScope',
  'mailboxPeopleList',
  'contactIdOfIdentity',
  'mailboxOfConversation',
  'mailboxOfMessage',
] as const

const CHANGING = new Set<string>(CHANGING_CALLS)

/** Whether a call into the store changes what the screens draw. */
export const changesMail = (method: string): boolean => CHANGING.has(method)

/**
 * The people the inbox's mail may be for: everyone of the install, the owner first. Which mail each may see is the inbox's own rule (src/queue.ts `canSee`), applied to every read their page makes in answer; the message
 * names no conversation and nothing of what changed, so telling a person who is on no mailbox only costs their page a read it is refused.
 */
export const inboxPeople = (install: Install): string[] => [
  install.owner().address,
  ...install.people.map((p) => p.address).filter((a) => a !== install.owner().address),
]
