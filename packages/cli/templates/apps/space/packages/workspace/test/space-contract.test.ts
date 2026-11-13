// The contract the parts share with the space, checked at the type level (`bun run typecheck` fails when it drifts) and by name here.
//
// What each interface must offer ("The inbox and meet answer through named
// in-account entrypoints", and the slice table); it is written out below as plain lists so a method added or dropped without
// the option changing fails here, in both directions.

import { describe, expect, test } from 'bun:test'
import { lane, northfield } from './helpers'
import {
  CALENDAR_ACCESS_REFUSALS,
  CALENDAR_FOR_SPACE_METHODS,
  CALENDAR_PUSH_PATH,
  CLIENTS_FOR_INBOX_METHODS,
  CLIENTS_FOR_SOURCE_METHODS,
  CLIENTS_FOR_SPACE_METHODS,
  type ClientsForInbox,
  type ClientsForSource,
  type ClientsForSpace,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  type CalendarForSpace,
  INBOX_OPERATOR_METHODS,
  type SignedIn,
  type ChannelRow,
  type ConversationList,
  CONVERSATION_APPS,
  CONVERSATION_ID,
  DOCUMENT_STATES,
  MOST_CONVERSATION_REFS,
  DRAFT_AUTHORS,
  type DocumentState,
  type DocumentSummary,
  FORMS_CLIENT_NAMES_METHODS,
  FORMS_FOR_SPACE_METHODS,
  type FormsClientNames,
  type FormsForSpace,
  DELIVERY_PROBLEMS,
  DELIVERY_STATES,
  GMAIL_RETURN_PATH,
  GMAIL_START_PATH,
  GMAIL_STATE,
  gmailReturnUrl,
  INBOX_FOR_SPACE_METHODS,
  INBOX_CAPTION_MAX,
  INBOX_MOST_FILE_BYTES,
  INBOX_MOST_FILES,
  INBOX_PICTURE_MAX_BYTES,
  INBOX_PICTURE_TYPES,
  type DraftAuthor,
  type InboxChat,
  type InboxContact,
  type InboxContactProfile,
  type InboxMerge,
  type InboxProfileEdit,
  type InboxRename,
  type InboxDraftAt,
  type InboxSendResolution,
  type InboxSplit,
  type InboxCloseMark,
  type InboxDraftEdit,
  type InboxDraftPicture,
  type InboxFrom,
  type InboxMailboxes,
  INBOX_CAPABILITIES,
  readInboxFrom,
  type InboxSpamMark,
  type InboxSpamResult,
  type InboxCloseResult,
  type InboxAttachment,
  type InboxDeliveryNote,
  type InboxDraft,
  type InboxFile,
  type InboxFileOut,
  type InboxForSpace,
  type InboxMessage,
  type InboxThread,
  type InboxHistory,
  type InboxReadResult,
  type InboxSend,
  KNOWLEDGE_FOR_INBOX_METHODS,
  KNOWLEDGE_FOR_SPACE_METHODS,
  type KnowledgeForInbox,
  type KnowledgeForSpace,
  CALL_KINDS,
  COMPOSE_KEY,
  MEET_FOR_SPACE_FETCH_PREFIXES,
  MEET_CHANNEL_DOS,
  MEET_FOR_SPACE_METHODS,
  MEET_OPERATOR_METHODS,
  type MeetChannelChange,
  type MeetChannelMake,
  type MeetGuestInvite,
  type MeetEdit,
  type MeetMe,
  type MeetMePatch,
  type MeetMessage,
  type MeetMessageMay,
  type MeetPostTarget,
  type MailKind,
  type MeetBooking,
  type MeetCall,
  type MeetCallRef,
  type MeetCallStart,
  type MeetForSpace,
  type MeetHuddleStart,
  type MeetPost,
  type PersonRow,
  REFUSAL_REASONS,
  type RefusalReason,
  type Refused,
  type Failed,
} from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const holds = <_T extends true>(): void => {}

// Each list holds exactly the interface's methods, no more and no fewer.
holds<Equal<keyof InboxForSpace, (typeof INBOX_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof MeetForSpace, (typeof MEET_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof FormsForSpace, (typeof FORMS_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof FormsClientNames, (typeof FORMS_CLIENT_NAMES_METHODS)[number]>>()
holds<Equal<keyof KnowledgeForSpace, (typeof KNOWLEDGE_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof KnowledgeForInbox, (typeof KNOWLEDGE_FOR_INBOX_METHODS)[number]>>()
holds<Equal<keyof CalendarForSpace, (typeof CALENDAR_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof ClientsForSpace, (typeof CLIENTS_FOR_SPACE_METHODS)[number]>>()
holds<Equal<keyof ClientsForInbox, (typeof CLIENTS_FOR_INBOX_METHODS)[number]>>()
holds<Equal<keyof ClientsForSource, (typeof CLIENTS_FOR_SOURCE_METHODS)[number]>>()

type FirstArg<I> = { [K in keyof I]: I[K] extends (first: infer A, ...rest: never[]) => unknown ? A : never }[keyof I]
// The parts that run inside the space's Worker (forms, the knowledge app, meet and the inbox) take the person its one sign-in check named, never an assertion and never a bare person.
holds<Equal<FirstArg<InboxForSpace>, SignedIn>>()
holds<Equal<FirstArg<MeetForSpace>, SignedIn>>()
holds<Equal<FirstArg<FormsForSpace>, SignedIn>>()
holds<Equal<FirstArg<KnowledgeForSpace>, SignedIn>>()
holds<Equal<FirstArg<CalendarForSpace>, SignedIn>>()
holds<Equal<FirstArg<ClientsForSpace>, SignedIn>>()
// The Clients part's face for the inbox takes no person first: it only reads, by a number or by nothing.
holds<Equal<FirstArg<ClientsForInbox> extends SignedIn ? true : false, false>>()
// The source's face takes no person and no source: the door verified a token, and the face is made for the one source the declaration names.
holds<Equal<FirstArg<ClientsForSource> extends SignedIn ? true : false, false>>()
// The knowledge app's face for the inbox takes no person first: its first argument is a business or a proposer.
holds<Equal<FirstArg<KnowledgeForInbox> extends SignedIn ? true : false, false>>()

// What a document carries: its title and state and when it moved, and counts. No answer, no recipient, no link, no file.
// Today's "who has not signed" is the signers' names, so they are here; no address, token, link or answer is.
holds<Equal<keyof DocumentSummary, 'id' | 'title' | 'state' | 'createdAt' | 'sentAt' | 'completedAt' | 'signers' | 'signed' | 'notSigned' | 'conversation'>>()

// Every way something goes out carries the key the space chose once per compose, so a repeat sends nothing new.
holds<Equal<InboxSend['key'], string>>()
holds<Equal<MeetPost['key'], string>>()
// A draft carries NO position: a send of one takes the thread's own `through`, from a thread the space opened.
holds<Equal<'through' extends keyof InboxDraft ? true : false, false>>()
// mark read answers each item that was not read as a refusal or a failure, in the shapes every answer has.
holds<Equal<InboxReadResult['notRead'][number]['outcome'], Refused | Failed>>()
// Close answers each conversation it did not close as a refusal or a failure, and carries a position per conversation; Reopen needs none.
holds<Equal<InboxCloseResult['notClosed'][number]['outcome'], Refused | Failed>>()
holds<Equal<keyof InboxCloseMark, 'conversationId' | 'through'>>()
holds<Equal<Parameters<InboxForSpace['reopenConversations']>[1], readonly string[]>>()
// A page of history says whether there is more, and takes where it left off.
holds<Equal<InboxHistory['more'], boolean>>()
// The copies: this package cannot import the apps, so each app's test pins its own value equal to these.
holds<Equal<MailKind, 'email' | 'sms' | 'manual' | 'telegram'>>()
holds<Equal<DocumentState, (typeof DOCUMENT_STATES)[number]>>()
// The lists a reader of an answer checks against are the types' own, so a value added to one is read, not refused as not understood.
holds<Equal<DraftAuthor, (typeof DRAFT_AUTHORS)[number]>>()
holds<Equal<InboxDraft['author'], DraftAuthor>>()
holds<Equal<RefusalReason, (typeof REFUSAL_REASONS)[number]>>()
// Restore is two calls: the second must send back the token the first answered and the bookmark it named, so it cannot be made blind.
holds<Equal<Parameters<InboxForSpace['confirmRestore']>[1], { token: string; bookmark: string }>>()
// The draft chat names a draft and the revision Tessa was shown, always: a conversation with no draft is not chatted about from the space.
// A write to a person's profile names the revision it was shown, and so does a merge of two: a screen read before someone else's change cannot write over it.
holds<Equal<keyof InboxProfileEdit, 'contactId' | 'rev' | 'business' | 'role' | 'notes'>>()
holds<Equal<keyof InboxMerge, 'survivorId' | 'survivorRev' | 'absorbedId' | 'absorbedRev'>>()
// A contact in the directory carries no message, subject, snippet or draft, and no note (that is the profile's): People is not a second way to read mail. The Telegram groups a person writes in are names and times, never words.
holds<Equal<keyof InboxContact, 'contactId' | 'name' | 'identities' | 'addresses' | 'client' | 'suggestedClient' | 'business' | 'role' | 'conversations' | 'rev' | 'sendsFrom' | 'automated' | 'groups'>>()
holds<Equal<keyof InboxContactProfile, keyof InboxContact | 'notes'>>()
// The undo of a merge is named by the merge the inbox answered.
holds<Equal<Parameters<InboxForSpace['undoContactMerge']>[1], number>>()
holds<Equal<keyof InboxChat, 'conversationId' | 'draftId' | 'rev' | 'instruction'>>()
// A draft edit names the draft and the revision shown, always, and changes the words only; a spam call is a conversation and a boolean, never an empty request.
holds<Equal<keyof InboxDraftEdit, 'draftId' | 'rev' | 'subject' | 'text' | 'copyEveryone' | 'cc' | 'takeOutPicture'>>()
holds<Equal<keyof InboxSpamMark, 'conversationId' | 'spam'>>()
holds<Equal<keyof InboxSpamResult, 'conversationId' | 'spam' | 'bulk' | 'reasons'>>()
// A new email says which mailbox it goes out from by Gmail or by a business mailbox's id, never by an address typed.
holds<Equal<InboxFrom, { kind: 'gmail'; mailboxId?: string } | { kind: 'business'; mailboxId: string }>>()
// A draft names everyone it goes to besides its contact, so the space can show them before it sends the draft as it stands.
holds<Equal<InboxDraft['cc'][number], { name: string; address: string }>>()

// What an older inbox cannot say is optional, so an answer without it still reads: the space then sends nothing that depends on it.
holds<Equal<undefined extends InboxMailboxes['capabilities'] ? true : false, true>>()
holds<Equal<undefined extends InboxThread['canMarkSpam'] ? true : false, true>>()
holds<Equal<undefined extends InboxDraft['why'] ? true : false, true>>()

const sorted = (xs: readonly string[]) => [...xs].sort()

/** The inbox's methods in the three groups they came in: mail, the other views, and Close and Reopen. Checked by name, not by where they sit in the list. */
const INBOX_MAIL = ['people', 'messagesWith', 'drafts', 'send', 'markRead', 'search']
const INBOX_VIEWS = [
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
]
const INBOX_CLOSE = ['closeConversations', 'reopenConversations']
/** Writing without a reply: a draft's words at a revision, and a spam call on a conversation. The new email is `send`'s third shape. */
const INBOX_COMPOSE = ['editDraft', 'putDraftPicture', 'setSpam']
/** Where a draft's link opens (drafts on no conversation): the draft as it stands, or the conversation it was filed on once sent. A read, for the owner alone. */
const INBOX_DRAFT_AT = ['draftAt']
/** What only the inbox's own page still did: settle a send Gmail never confirmed, mark a text or a direct message sent by hand and take it back, rename a contact, split an address off one. */
const INBOX_LAST_FIVE = ['resolveSend', 'markDraftSent', 'unmarkSent', 'renameContact', 'splitAddress']
/** A message's file: one method, for the owner alone. */
const INBOX_FILES = ['attachment']
const INBOX_PEOPLE = ['contacts', 'contact', 'saveContactProfile', 'mergeContacts', 'undoContactMerge']
const has = (names: readonly string[]) => expect(INBOX_FOR_SPACE_METHODS as readonly string[]).toEqual(expect.arrayContaining([...names]))

describe('what each app answers the space', () => {
  test('the inbox: open conversations per contact, a person\'s messages, drafts, send, mark read, search', () => {
    has(INBOX_MAIL)
  })

  test('the inbox’s other views: the switches, mailboxes, notifications, restore, Clients and the draft chat', () => {
    has(INBOX_VIEWS)
  })

  test('the inbox’s Close and Reopen: conversations at a position, and by id', () => {
    has(INBOX_CLOSE)
  })

  test('the inbox’s draft edit and spam call: a draft at the revision shown, a conversation called spam or not', () => {
    has(INBOX_COMPOSE)
  })

  test('where a draft’s link opens: the draft as it stands, or the person and conversation it was filed on; a read, no key', () => {
    has(INBOX_DRAFT_AT)
    const draft: InboxDraftAt = { state: 'filed', contactId: 'c1', conversationId: 't1' }
    expect(draft.state).toBe('filed')
  })

  test('the inbox’s last five things: a stuck send settled, a text marked sent by hand and taken back, a contact renamed and an address split off, none of them sending mail', () => {
    has(INBOX_LAST_FIVE)
    // No compose key anywhere in them: each sets a value or names a state, so a repeat is refused and never applied twice, and none sends.
    const resolution: InboxSendResolution = { draftId: 'd1', sent: true }
    const rename: InboxRename = { contactId: 'c1', rev: 0, name: 'Dana' }
    const split: InboxSplit = { contactId: 'c1', rev: 0, identityId: 'i1' }
    holds<Equal<keyof InboxSendResolution, 'draftId' | 'sent'>>()
    holds<Equal<keyof InboxRename, 'contactId' | 'rev' | 'name'>>()
    holds<Equal<keyof InboxSplit, 'contactId' | 'rev' | 'identityId'>>()
    expect([resolution, rename, split].every((x) => !('key' in x))).toBe(true)
  })

  test('the inbox’s files: a message’s file, by its place, to be viewed or saved', () => {
    has(INBOX_FILES)
  })

  test('the inbox’s contacts for People: the list, one with its note, the three fields at a revision, a merge at two revisions, and its undo', () => {
    has(INBOX_PEOPLE)
  })

  test('and the inbox answers no method outside those nine groups, nor lists one twice', () => {
    expect(sorted(INBOX_FOR_SPACE_METHODS)).toEqual(sorted([...INBOX_MAIL, ...INBOX_VIEWS, ...INBOX_CLOSE, ...INBOX_PEOPLE, ...INBOX_FILES, ...INBOX_COMPOSE, ...INBOX_DRAFT_AT, ...INBOX_LAST_FIVE, ...INBOX_OPERATOR_METHODS]))
  })

  test('the inbox’s operator, for a move of its store: a bookmark, a restart and the counts, the owner’s, touching no message, draft or contact', () => {
    expect([...INBOX_OPERATOR_METHODS] as string[]).toEqual(['storeBookmark', 'restartStore', 'storeCounts'])
    has(INBOX_OPERATOR_METHODS)
  })

  test('meet: direct messages and channels, history, post, mark read, the live connection\'s ticket, the calls in progress', () => {
    const chat = ['conversations', 'history', 'post', 'markRead', 'liveCalls']
    expect(MEET_FOR_SPACE_METHODS as readonly string[]).toEqual(expect.arrayContaining(chat))
  })

  test('meet’s calls: huddles, call links and New calls, meetings with a time, cards, past calls with their chat, the month’s usage, and the Phone conversation; no email is sent by any of them', () => {
    const chat = ['conversations', 'history', 'post', 'markRead', 'liveCalls']
    const calls = ['startHuddle', 'startCall', 'bookMeeting', 'cards', 'calls', 'callChat', 'deleteCallChat', 'meetings', 'usage', 'phoneConversation', 'phoneRead']
    const admin = ['channel', 'browseChannels', 'createChannel', 'inviteGuest', 'changeChannel']
    const messages = ['peopleToMessage', 'editMessage', 'deleteMessage', 'me', 'updateMe', 'acknowledgePrivacy']
    // And the operator's four, for a move of meet's stores: the owner's, on the two long-lived objects, touching no message, call or person.
    const operator = ['storeBookmark', 'restartStore', 'restoreStore', 'storeCounts']
    expect([...MEET_OPERATOR_METHODS] as string[]).toEqual(operator)
    expect(sorted(MEET_FOR_SPACE_METHODS)).toEqual(sorted([...chat, ...calls, ...admin, ...messages, ...operator]))
    // Nothing is sent to anyone by meet but one thing: no method of the calls, the chat or a person's own settings is named for an email going out.
    for (const m of [...chat, ...calls, ...messages]) expect(m).not.toMatch(/send|invite|email|mail/i)
  })

  test('meet’s messages and a person’s own settings: the writes carry no key, because repeating them is the same thing or a refusal; a first message to someone is `post` by `personId`, which does', () => {
    holds<Equal<'key' extends keyof MeetEdit ? true : false, false>>()
    holds<Equal<'key' extends keyof MeetMePatch ? true : false, false>>()
    // The first message to someone you have never written to: a post to a person, with the compose key, as before (no new write for it).
    holds<Equal<MeetPost['key'], string>>()
    holds<Equal<Extract<MeetPostTarget, { personId: string }>['personId'], string>>()
    // What the page is told it may do with a message is meet's word, and optional so an older meet is drawn without buttons.
    holds<Equal<MeetMessage['may'], MeetMessageMay | undefined>>()
    holds<Equal<keyof MeetMessageMay, 'edit' | 'delete'>>()
    // A patch of a person's settings names a name, whether the nudge is wanted, or both.
    holds<Equal<keyof MeetMePatch, 'name' | 'nudgesOff'>>()
    holds<Equal<keyof MeetMe, 'person' | 'owner' | 'nudgesOff' | 'privacyAcked'>>()
  })

  test('meet’s channel admin: the invitation to a guest is the only email any method sends, and it is the only method named for one', () => {
    const named = [...MEET_FOR_SPACE_METHODS].filter((m) => /send|invite|email|mail/i.test(m))
    expect(named).toEqual(['inviteGuest'])
  })

  test('the writes of the channel admin that make something carry the compose key; a change names its channel and what it does', () => {
    const make: MeetChannelMake = { key: 'k'.repeat(16), name: 'ops', privacy: 'private' }
    const invite: MeetGuestInvite = { key: 'k'.repeat(16), conversationId: 1, name: 'Dana', address: 'dana@example.test' }
    holds<Equal<MeetChannelMake['key'], string>>()
    holds<Equal<MeetGuestInvite['key'], string>>()
    expect([make.key, invite.key].every((k) => COMPOSE_KEY.test(k))).toBe(true)
    // A change is the one write with no key: every part of it is idempotent or refused when repeated.
    holds<Equal<'key' extends keyof MeetChannelChange ? true : false, false>>()
    expect([...MEET_CHANNEL_DOS]).toEqual(['join', 'leave', 'rename', 'archive', 'add', 'take-out', 'remove-guest', 'delete-person'])
  })

  test('every write of the calls carries the compose key, and every call answered carries its link', () => {
    const huddle: MeetHuddleStart = { key: 'k'.repeat(16), conversationId: 1 }
    const call: MeetCallStart = { key: 'k'.repeat(16) }
    const booking: MeetBooking = { key: 'k'.repeat(16), title: 'x', startsAt: 1 }
    holds<Equal<MeetHuddleStart['key'], string>>()
    holds<Equal<MeetCallStart['key'], string>>()
    holds<Equal<MeetBooking['key'], string>>()
    holds<Equal<'link' extends keyof MeetCall ? true : false, true>>()
    holds<Equal<'link' extends keyof MeetCallRef ? true : false, true>>()
    expect([huddle.key, call.key, booking.key].every((k) => COMPOSE_KEY.test(k))).toBe(true)
    expect([...CALL_KINDS]).toEqual(['huddle', 'link', 'new', 'meeting'])
  })

  test('meet serves the phone under one prefix and no socket: a teammate’s page hears that chat moved from the space’s live object', () => {
    expect(MEET_FOR_SPACE_FETCH_PREFIXES).toEqual(['/space/phone'])
    expect([...MEET_FOR_SPACE_METHODS]).not.toContain('ticket')
  })

  test('forms: documents per address or person, by state for Today, and per conversation, named by every handle the conversation has', () => {
    expect(sorted(FORMS_FOR_SPACE_METHODS)).toEqual(sorted(['documentsOn', 'documents', 'documentsIn']))
    expect([...CONVERSATION_APPS]).toEqual(['inbox', 'meet'])
    expect(MOST_CONVERSATION_REFS).toBe(20)
    expect(['c-dana', '12', 'a@b.example', 'x:y+z'].every((id) => CONVERSATION_ID.test(id))).toBe(true)
    expect(['', ' ', 'a b', 'a/b', 'x'.repeat(201)].some((id) => CONVERSATION_ID.test(id))).toBe(false)
  })

  test('forms keeps a copy of a linked Client’s names for the Clients part to write: list the linked rows, check a name, set it, and nothing else', () => {
    expect(sorted(FORMS_CLIENT_NAMES_METHODS)).toEqual(sorted(['linked', 'check', 'setNames']))
  })

  test('the knowledge app: the base and its changes for the space; the active entries, the base and a proposal for the inbox, nothing that edits', () => {
    expect(sorted(KNOWLEDGE_FOR_SPACE_METHODS)).toEqual(sorted(['knowledge', 'changeKnowledge', 'storeBookmark', 'restartStore', 'restoreStore']))
    expect(sorted(KNOWLEDGE_FOR_INBOX_METHODS)).toEqual(sorted(['activeFor', 'readBase', 'propose']))
    // The inbox's way in cannot change anything an assistant says: no edit, no removal, no approval, and no assertion to be admitted by.
    for (const m of ['changeKnowledge', 'edit', 'remove', 'approve', 'reject', 'add', 'restore']) {
      expect(KNOWLEDGE_FOR_INBOX_METHODS as readonly string[]).not.toContain(m)
    }
  })
})

describe('the calendar', () => {
  test('one face for the space, owner only, reading the calendar’s own store; nothing that writes to Google', () => {
    expect(sorted(CALENDAR_FOR_SPACE_METHODS)).toEqual(sorted(['calendars', 'agenda', 'event', 'eventsByUid', 'setShown', 'syncNow']))
    // The calendar reads Google and never writes to it: no method creates, moves, answers or deletes an event.
    for (const m of ['createEvent', 'moveEvent', 'respond', 'deleteEvent', 'book']) expect(CALENDAR_FOR_SPACE_METHODS as readonly string[]).not.toContain(m)
  })

  test('the permissions asked for are reading and changing events (never the full calendar scope), Google’s push comes in on a path of its own, and an access token can be refused five ways', () => {
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly')
    expect(CALENDAR_EVENTS_SCOPE).toBe('https://www.googleapis.com/auth/calendar.events')
    expect(CALENDAR_PUSH_PATH).toBe('/calendar/push')
    expect([...CALENDAR_ACCESS_REFUSALS]).toEqual(['disconnected', 'lapsed', 'no-calendar', 'no-events', 'failed'])
  })
})

describe('the rows the Conversations list is made of', () => {
  // The merge rule, shown on literals: a person with two threads and a direct message is one row, at the time of the newest
  // item, with the sum of the unread and the newest item's kind. The list builds this; the shape is what is pinned.
  const person: PersonRow = {
    type: 'person',
    key: 'corin@x.example.com',
    name: 'Corin Pike',
    addresses: ['corin@x.example.com'],
    side: 'outside',
    client: null,
    at: 2000,
    came: 'chat',
    text: 'On my way',
    unread: 3,
    mail: [
      { contactId: 'c1', unread: 1, newest: { at: 1500, kind: 'email', text: 'Thursday works', subject: 'Re: Thursday' } },
      // the same person under their other address (a teammate's sign-in differs from their work address)
      { contactId: 'c2', unread: 1, newest: { at: 900, kind: 'email', text: 'Earlier', subject: 'Earlier' } },
    ],
    chat: { personId: 'p1', conversationId: 7, unread: 1, newest: { at: 2000, kind: 'chat', text: 'On my way' } },
  }
  const channel: ChannelRow = {
    type: 'channel',
    key: 'chat:channel:9',
    conversationId: 9,
    name: 'general',
    privacy: 'open',
    memberCount: 4,
    at: 1000,
    came: 'chat',
    text: 'Lunch?',
    unread: 0,
  }

  test('a row carries the newest item\'s time, text and kind, and the sum of both sides\' unread', () => {
    const sides = [...person.mail.map((m) => m.newest), person.chat?.newest].filter((n) => n !== undefined)
    const newest = sides.reduce((a, b) => (b.at > a.at ? b : a))
    expect({ at: person.at, came: person.came, text: person.text }).toEqual({ at: newest.at, came: newest.kind, text: newest.text })
    expect(person.unread).toBe(person.mail.reduce((n, m) => n + m.unread, 0) + (person.chat?.unread ?? 0))
  })

  test('a list says which source could not be reached, apart from which said no', () => {
    const list: ConversationList = {
      rows: [person, channel],
      parts: [
        { part: 'mail', state: 'could-not-be-reached', reason: 'timed-out' },
        { part: 'chat', state: 'ok' },
      ],
    }
    expect(list.rows.map((r) => r.at)).toEqual([2000, 1000])
    expect(list.parts[0]).toMatchObject({ part: 'mail', state: 'could-not-be-reached' })
  })
})

describe('the lists a reader checks against', () => {
  test('draft authors and refusal reasons are the contract’s, in full', () => {
    expect(sorted(DRAFT_AUTHORS)).toEqual(['assistant', 'claude', 'outbox', 'owner'])
    expect(sorted(REFUSAL_REASONS)).toEqual(['bad-request', 'conflict', 'limit', 'not-admitted', 'not-found', 'not-signed-in'])
  })
})

// Files and delivery reports are ADDITIVE: an inbox that predates them leaves each field out and the space draws as before, so none is required.
// A required field here would make the space refuse every answer of an inbox deployed before the space (the inbox is deployed first, but a rollback is the other order).
holds<Equal<undefined extends InboxMessage['attachments'] ? true : false, true>>()
holds<Equal<undefined extends InboxMessage['delivery'] ? true : false, true>>()
holds<Equal<undefined extends InboxThread['canAttach'] ? true : false, true>>()
// So is the thread's "takes one picture": an inbox that predates it leaves it out and the composer offers no picture.
holds<Equal<undefined extends InboxThread['canPicture'] ? true : false, true>>()
// And the picture on a draft: an inbox that predates it leaves it out, and the card shows none and offers no Attach. A draft's edit names its revision and a put names a revision and a file.
holds<Equal<undefined extends InboxDraft['picture'] ? true : false, true>>()
holds<Equal<undefined extends InboxDraftEdit['takeOutPicture'] ? true : false, true>>()
holds<Equal<keyof InboxDraftPicture, 'draftId' | 'rev' | 'picture'>>()
// A file is listed by name and size and what to do with it, never by its bytes: those come only from `attachment`, which checks who is asking.
holds<Equal<keyof InboxAttachment, 'name' | 'size' | 'type' | 'picture' | 'download' | 'tooLarge' | 'play' | 'video' | 'seconds' | 'note'>>()
holds<Equal<undefined extends InboxAttachment['tooLarge'] ? true : false, true>>()
// A voice note's player and the line under a file left in Telegram are additive too: an inbox that predates them leaves them out.
holds<Equal<undefined extends InboxAttachment['play'] ? true : false, true>>()
// So is a video's player.
holds<Equal<undefined extends InboxAttachment['video'] ? true : false, true>>()
holds<Equal<undefined extends InboxAttachment['seconds'] ? true : false, true>>()
holds<Equal<undefined extends InboxAttachment['note'] ? true : false, true>>()
holds<Equal<keyof InboxDeliveryNote, 'recipient' | 'state' | 'reason' | 'at'>>()
holds<Equal<keyof InboxFile, 'name' | 'type' | 'bytes'>>()
holds<Equal<keyof InboxFileOut, 'name' | 'type' | 'inline' | 'bytes' | 'total' | 'part' | 'unsatisfiable'>>()
// A file is handed over whole or in parts (a Telegram video is up to 50 MB; a Durable Object's RPC carries 32 MiB at most): the part fields are additive, and an answer that names none is the whole file.
holds<Equal<undefined extends InboxFileOut['total'] ? true : false, true>>()
holds<Equal<undefined extends InboxFileOut['part'] ? true : false, true>>()
holds<Equal<undefined extends InboxFileOut['unsatisfiable'] ? true : false, true>>()
// `attachment` is a read with a way, and its first argument is the assertion like every other method's (FirstArg above).
holds<Equal<Parameters<InboxForSpace['attachment']>[3], 'view' | 'download'>>()
holds<Equal<undefined extends Parameters<InboxForSpace['attachment']>[4] ? true : false, true>>()
// Only a reply in a thread and a new email carry files: a draft already made does not.
holds<Equal<'attachments' extends keyof Extract<InboxSend, { draftId: string }> ? true : false, false>>()
holds<Equal<'attachments' extends keyof Extract<InboxSend, { conversationId: string }> ? true : false, true>>()
holds<Equal<'attachments' extends keyof Extract<InboxSend, { address: string }> ? true : false, true>>()
holds<Equal<'from' extends keyof Extract<InboxSend, { address: string }> ? true : false, true>>()
// A reply goes from the mailbox its conversation is in: it names none.
holds<Equal<'from' extends keyof Extract<InboxSend, { conversationId: string }> ? true : false, false>>()

describe('what a new email may name, and what an inbox says it can do', () => {
  test('a mailbox is Gmail or a business mailbox by an id of the shape ids have, or nothing; an address typed, or anything else, is not one', () => {
    expect(readInboxFrom(undefined)).toEqual({ ok: true, from: undefined })
    expect(readInboxFrom({ kind: 'gmail' })).toEqual({ ok: true, from: { kind: 'gmail' } })
    expect(readInboxFrom({ kind: 'gmail', mailboxId: 'ashgrove' })).toEqual({ ok: true, from: { kind: 'gmail', mailboxId: 'ashgrove' } })
    expect(readInboxFrom({ kind: 'business', mailboxId: 'ridgeway' })).toEqual({ ok: true, from: { kind: 'business', mailboxId: 'ridgeway' } })
    for (const bad of [null, 'info@ridgewaycycles.example', 5, [], {}, { kind: 'business' }, { kind: 'business', mailboxId: 'a/b' }, { kind: 'business', mailboxId: 7 }, { kind: 'gmail', mailboxId: 'a/b' }, { kind: 'gmail', mailboxId: 7 }, { kind: 'address', address: 'a@b.example' }]) {
      expect([bad, readInboxFrom(bad)]).toMatchObject([bad, { ok: false, message: expect.stringContaining('one of the Gmail accounts or from one of the business mailboxes') }])
    }
  })

  test('the one capability so far is the one an older inbox would ignore without a word: a new email that picks a mailbox or carries files', () => {
    expect([...INBOX_CAPABILITIES]).toEqual(['new-email-from-and-files'])
  })
})

describe('files and delivery reports', () => {
  test('the six reports Cloudflare publishes are the contract’s states, and four of them are problems', () => {
    expect(sorted(DELIVERY_STATES)).toEqual(['bounced', 'complained', 'deferred', 'delivered', 'failed', 'rejected'])
    expect(sorted(DELIVERY_PROBLEMS)).toEqual(['bounced', 'complained', 'failed', 'rejected'])
    // A delay is a retry in progress and a delivery is the good news: neither is a problem.
    expect(DELIVERY_PROBLEMS).not.toContain('deferred')
    expect(DELIVERY_PROBLEMS).not.toContain('delivered')
  })

  test('the limits on a send are written once, inside what Cloudflare takes (32 files, 25 MiB for the message with its encoding)', () => {
    expect(INBOX_MOST_FILES).toBe(10)
    expect(INBOX_MOST_FILE_BYTES).toBe(15 * 1024 * 1024)
    // Base64 makes the files a third larger again, and the message needs room for its words and headers.
    expect(Math.ceil((INBOX_MOST_FILE_BYTES * 4) / 3)).toBeLessThan(25 * 1024 * 1024)
  })

  test('the limits on a Telegram picture are written once: one picture, a PNG or a JPEG, 10 MB, 1,024 characters of words under it', () => {
    expect(INBOX_PICTURE_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(INBOX_CAPTION_MAX).toBe(1024)
    expect([...INBOX_PICTURE_TYPES]).toEqual(['image/png', 'image/jpeg'])
    // A picture is a file of a send, so it is also inside the files' own limit.
    expect(INBOX_PICTURE_MAX_BYTES).toBeLessThanOrEqual(INBOX_MOST_FILE_BYTES)
  })
})

describe('Connect Gmail in the space', () => {
  test('the return address Google is told is the literal registered by hand on the OAuth client: the space’s host and the callback path, from the declaration', () => {
    expect(gmailReturnUrl(northfield())).toBe('https://space.northfield.example/api/inbox/gmail/callback')
    expect(GMAIL_RETURN_PATH).toBe('/api/inbox/gmail/callback')
    expect(GMAIL_START_PATH).toBe('/api/inbox/gmail/start')
    // Another install's is its own host's: the address follows the declaration, never a literal in the code.
    expect(gmailReturnUrl(lane())).toBe(`${lane().url().replace(/\/+$/, '')}/api/inbox/gmail/callback`)
    expect(gmailReturnUrl(lane())).not.toContain('space.northfield.example')
  })

  test('the two methods are the contract’s, and the check is hexadecimal of a bounded length', () => {
    has(['gmailSignIn', 'gmailConnect'])
    expect(GMAIL_STATE.test('ab12'.repeat(12))).toBe(true)
    for (const bad of ['', 'zz'.repeat(24), 'AB12'.repeat(12), 'a'.repeat(31), 'a'.repeat(129), 'ab12&x=1'.repeat(6)]) expect(GMAIL_STATE.test(bad)).toBe(false)
  })
})
