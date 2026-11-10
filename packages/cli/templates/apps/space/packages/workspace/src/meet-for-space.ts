// What meet answers the space: the interface of its part in the space's Worker, method by method.
//
// Meet's chat and calls run INSIDE the space's Worker (the space's ADR 0016): this is a
// function over the Workspace and call objects the Worker holds, called in-process, not a service binding. Meet's direct messages, channels,
// messages and unread stay meet's (its Workspace Durable Object, `WorkspaceCore`); this is the part of them the space may ask for,
// in shapes taken from meet's own (packages/meet/src/workspace-model.ts) and cut down to what the space draws. A field meet
// cannot fill is not here.
//
// EVERY METHOD takes the person the space's ONE sign-in check named first (`SignedIn`, ADR 0003 of the company layer), then applies meet's own rule:
// the person must be on the Teammate list (the declaration), and the call is made as `{ via: 'access', email }`, the same actor
// meet's teammates' door builds. Nothing verifies an assertion here and none is handed in. A channel guest never reaches the team's side of the space (they sign in at
// space.northfield.example/w/, a path of its own), so every method here is a teammate's. Every method answers a `SpaceReply`.
//
// TIMES are milliseconds since the epoch, as meet keeps them. ADDRESSES are `normalizeAddress`'s spelling. IDS are meet's: a
// conversation's is a number, a person's is text.
//
// THERE IS NO TEAM SOCKET HERE (the space's ADR 0019). A teammate's page learns that chat moved from the space's one live object (live.ts), which meet's Workspace object tells after it has stored a change; meet's own socket and its one-time ticket are the channel guests' alone, at /w/api/socket. Only the phone's prefix is served as a request (MEET_FOR_SPACE_FETCH_PREFIXES).
//
// CALLS. A call is meet's own Room (a Durable Object per call) and its link is space.northfield.example/r/<name>, which needs no sign-in:
// a guest, a teammate and the person who made it all join there, on a path of the space that is open to anyone (the space's ADR 0018). EVERY ANSWER THAT NAMES A CALL
// CARRIES ITS LINK, made by meet from the space's address (`MeetCall.link`, the install's space host), so the page builds no link
// and a link copied inside the space opens on /r/. Four kinds of call (`CALL_KINDS`):
//   huddle   started in a direct message or a channel by anyone in it (a teammate here: a channel guest never reaches the space), under
//            the meter. It posts one message in the conversation (`MeetMessage.huddle` names the call), so the conversation's newest,
//            its unread and the live feed work as for any message.
//   link     made from an email conversation ("Add call link"): the link goes into the email being written, which a person sends.
//   new      made with no conversation (New call): a row of its own in Conversations.
//   meeting  booked with a time, from a conversation: its name is made ahead so the link works from then on.
// WHO MAKES ONE: a huddle, anyone in the conversation; the others, any teammate. WHO SEES ONE: the person who made it; for a huddle everyone
// in its conversation; for a meeting the people invited (a teammate, by address). A call nobody may see is `not-found`, as a conversation
// the person is not in is. The meter refuses new calls (`limit`) from 800 GB of the account's free 1,000 GB, as it refuses new joins.
// NOTHING IS EVER SENT BY MEET HERE. An invitation to a meeting is text the space puts in the email being written; a person presses send.
//
// CHANNEL ADMIN (the retirement of meet's old /start page). New channel, Invite a guest, Archive and what goes with them (the channel's people, a guest's access,
// Rename, Leave, Browse and Join) are asked here, and meet's rules stay meet's: the same Workspace object answers as it does at /start, as the teammate who is asking,
// so the person who may archive a channel is the one who made it, or the owner. `MeetChannelDetail.may` says what THIS person may do, so the space draws no rule of
// its own. Only `createChannel` and `inviteGuest` carry a compose key (the first makes something that a second press must not make again; the second SENDS AN EMAIL,
// the invitation, from meet@northfield.example, and sends it once per key and only when the person presses Invite). The invitation links to space.northfield.example/w/, the guest's own
// door, a path of the space that needs no sign-in. Nothing about a channel the person is not in is answered: the people, the guests and the addresses of a private channel are
// `not-found` to everyone outside it, and an open channel the person has not joined is only a name and a count (`browseChannels`).
//
// NOT HERE: open channels the person is not in (reading one means joining it); a guest the person shares no channel with.

import type { ComposeKey, SignedIn, SpaceReply, WriteReply } from './asking'

/** A person of meet's workspace, as the signed-in teammate is shown them. */
export interface MeetPerson {
  id: string
  name: string
  kind: 'teammate' | 'guest'
  /** Their address, normalised. A teammate is shown every address; null only if meet stored none it can show. */
  address: string | null
}

/** The newest message in a conversation. `text` is on one line, at most SNIPPET_CHARS. */
export interface MeetNewest {
  messageId: number
  at: number
  text: string
  authorId: string
  authorName: string
  /** Whether the person asking wrote it. */
  mine: boolean
}

/** The direct message with one person. */
export interface MeetDirect {
  conversationId: number
  person: MeetPerson
  /** Null for a direct message nobody has written in yet; the space draws no row for it. */
  newest: MeetNewest | null
  /** Messages from others after the person's read position (meet's `unread`). */
  unread: number
}

/** A channel the person is in. Archived channels are not listed. */
export interface MeetChannel {
  conversationId: number
  name: string
  privacy: 'open' | 'private'
  memberCount: number
  /**
   * When the channel was made, so a channel nobody has written in yet has a place in the list (and a new one shows at once). Absent from a meet that predates the
   * channel admin, which the space then lists only once it has a message. Made required (and the space's fallback deleted) by the commit that follows the channel-admin deploy checks.
   */
  createdAt?: number
  newest: MeetNewest | null
  unread: number
}

/** Every direct message and channel the person is in, with their own record so a caller knows which messages are theirs. */
export interface MeetOverview {
  me: MeetPerson
  direct: MeetDirect[]
  channels: MeetChannel[]
  /**
   * The Phone conversation, when the person is on it and it holds something; absent from a meet that predates calls in the space. Never listed among
   * `direct` or `channels`, and it has no messages to post.
   */
  phone?: MeetPhoneSummary | null
  /** The newest calls with no conversation (`new`) the person made, so each has a row of its own; absent from a meet that predates calls in the space. */
  calls?: MeetCallRef[]
}

/** One message of a direct message or a channel. */
export interface MeetMessage {
  id: number
  conversationId: number
  authorId: string
  authorName: string
  text: string
  at: number
  editedAt: number | null
  mine: boolean
  /** The call this message announces (a huddle started here), or absent. The text is meet's words for it; the space draws a card. */
  huddle?: string
  /**
   * What the person asking may do with this message, by meet's rules (your own is edited and deleted; the owner deletes another's; a huddle's announcement is a message like any
   * other, as at /start). The page draws Edit and Delete only where this says so. Absent from a meet that predates it, which the space then draws without buttons.
   */
  may?: MeetMessageMay
}

/** What the person asking may do with one message. */
export interface MeetMessageMay {
  edit: boolean
  delete: boolean
}

/** A page of history, oldest first: the newest HISTORY_PAGE (50), or the page before `before`. */
export interface MeetHistory {
  messages: MeetMessage[]
  more: boolean
}

/**
 * A call with someone in it right now. The link to join is made from `name` on the space's address (space.northfield.example/r/<name>), a
 * call link that needs no sign-in, so a call opens where a guest's does.
 */
export interface MeetLiveCall {
  /** The call's name, 20 characters of meet's alphabet: what its link is made from. */
  name: string
  /** When the call was made (the call, not the people in it: a call can be rejoined). */
  startedAt: number
  /** How many are in it now: at least one, since a call nobody is in is not listed. */
  present: number
  /** Why this person is shown it: they made it, they are invited to its meeting, or it is a huddle in a conversation they are in. */
  why: 'started' | 'invited' | 'conversation'
}

/**
 * Where a post goes: a conversation the person is in, or a person, whose direct message meet opens first if there is none (a
 * teammate may open one with any teammate, or a guest they share a channel with; anything else is `not-found`).
 */
export type MeetPostTarget = { conversationId: number } | { personId: string }

/**
 * One post: the target, the text and a `key` the space chose once for this compose (`ComposeKey`). Meet HOLDS the key (at least
 * `COMPOSE_KEY_KEPT_MS`) once its first use posted; a second use answers `Repeated` and nothing new is posted. A first use that was
 * REFUSED (`limit`, six in ten seconds; `bad-request`; `not-found`) or FAILED (`broken`) RELEASES the key, so pressing Send
 * again with it posts. Meet's post is one step in one object, so it has no uncertain or in-progress state: it either posted or
 * it did not. **A TEST MUST PROVE BOTH CASES**: a refused first use followed by the same key posts; a posted first use
 * followed by the same key answers `Repeated` and posts nothing new, including a repeat to a `personId` target (it must not open
 * a second direct message or post twice).
 */
export interface MeetPost {
  key: ComposeKey
  target: MeetPostTarget
  text: string
}

export interface MeetPosted {
  conversationId: number
  message: MeetMessage
}

export interface MeetRead {
  conversationId: number
  upTo: number
}

// ── Calls, meetings and the phone ───────────────────────────────────────────────────────────────────────────────────

/** The four kinds of call, above. */
export const CALL_KINDS = ['huddle', 'link', 'new', 'meeting'] as const
export type CallKind = (typeof CALL_KINDS)[number]

/** Someone invited to a meeting: a name, and an address when the conversation knows one. */
export interface MeetInvitee {
  name: string
  address: string | null
}

/**
 * A call as a card or a row draws it. `link` is meet's public address and the call's name, made by meet: the space copies and opens
 * it as it is. `present` is how many are in it now; `endedAt` is when the last person left (null while someone is in it, for a call
 * nobody has joined, and for a call that ended before meet kept the time).
 */
export interface MeetCall {
  name: string
  link: string
  kind: CallKind
  /** A meeting's title, or a new call's label; null for a huddle or a link. */
  title: string | null
  madeBy: { name: string; mine: boolean }
  madeAt: number
  /** The direct message or channel a huddle was started in; null for the others. */
  conversationId: number | null
  /** The space's conversation key a link or a meeting was made from (an email conversation); null for the others. */
  home: string | null
  /** A meeting's time, milliseconds; null for the others. */
  startsAt: number | null
  invitees: MeetInvitee[]
  present: number
  /** Seats taken over the life of the call. */
  people: number
  /** Messages in the call's own chat, saved after the call. */
  messages: number
  endedAt: number | null
  /** When the first person took a seat; with `endedAt`, how long the call ran. Null for a call nobody has joined, and for one that began before meet kept the time. */
  openedAt: number | null
}

/** A call with no conversation, as the list needs it: no state, so listing needs no question to each call. */
export interface MeetCallRef {
  name: string
  link: string
  title: string | null
  madeAt: number
}

/** Start a huddle in a direct message or a channel the person is in. Once per `key`. */
export interface MeetHuddleStart {
  key: ComposeKey
  conversationId: number
}

/** Make a call: with `home` (an email conversation's key) it is a call link for that conversation, without it a New call. Once per `key`. */
export interface MeetCallStart {
  key: ComposeKey
  title?: string | null
  home?: string | null
}

/**
 * Book a meeting from a conversation: `conversationId` (a direct message or channel the person is in, whose people are invited) or
 * `home` (an email conversation's key, with the `invitees` the space names), one of the two. `startsAt` is a moment between a few
 * minutes ago and a year ahead; the call's name is made now. Once per `key`.
 */
export interface MeetBooking {
  key: ComposeKey
  title: string
  startsAt: number
  conversationId?: number | null
  home?: string | null
  invitees?: MeetInvitee[]
}

/** Which calls to look up cards for: the huddles of these conversations and the link and meeting calls of these homes. */
export interface MeetCardsWant {
  conversationIds: number[]
  homes: string[]
}

/** A page of past calls, newest first. `next` is the cursor for the page after, or null at the end. */
export interface MeetCallPage {
  calls: MeetCall[]
  next: string | null
}

/** One message of a call's own chat, as the call kept it. */
export interface MeetCallMessage {
  id: number
  name: string
  text: string
  at: number
}

export interface MeetCallChat {
  call: MeetCall
  messages: MeetCallMessage[]
}

/** The month's estimate against the free allowance (decimal GB), and where new calls stop. */
export interface MeetUsage {
  usedGb: number
  freeGb: number
  tripGb: number
  paused: boolean
  /** The day calls resume (an ISO date), while paused. */
  pausedUntil: string | null
}

/** What the Phone conversation holds, newest last. */
export interface MeetPhoneItem {
  id: number
  at: number
  kind: 'voicemail' | 'missed' | 'emergency'
  /** meet's words for it. */
  text: string
  /** The caller's number (E.164) and how it is shown; null for a notice of 911. */
  number: string | null
  display: string | null
  /** A voicemail's length. */
  seconds: number | null
}

export interface MeetPhoneSummary {
  conversationId: number
  newest: { at: number; text: string } | null
  unread: number
}

export interface MeetPhone {
  conversationId: number
  unread: number
  items: MeetPhoneItem[]
  more: boolean
}

/** meet's phone paths, served to the space by `serveForSpace` (below) and nowhere else: the dial pad's own requests. */
export const MEET_PHONE_PATH = '/space/phone'

// ── Channel admin ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the person asking may do with one person in a channel, by meet's rules (the same buttons /start drew). */
export interface MeetMemberMay {
  /** Take a channel guest out of this channel: any teammate in it; a guest left in no channel is removed from the workspace. */
  takeOut: boolean
  /** Remove a guest from the workspace: the owner any guest, a teammate a guest they invited. */
  removeFromWorkspace: boolean
  /** Delete a person and everything they wrote, on request: the owner only. */
  deleteEverything: boolean
}

/** One person in a channel, as a teammate in it is shown them. */
export interface MeetMember {
  person: MeetPerson
  /** A guest who has been invited and has not signed in yet. */
  invited: boolean
  /** The person asking. */
  you: boolean
  /** The asker has a direct message with them that has something in it, so the space can open it (a first message is not made here). */
  direct: boolean
  may: MeetMemberMay
}

/** What the person asking may do with the channel itself. Rename, leave, add and invite are every teammate's in it; archive is its maker's, and the owner's. */
export interface MeetChannelMay {
  rename: boolean
  leave: boolean
  archive: boolean
  add: boolean
  invite: boolean
}

/** A channel the person is in, with its people. Answered for a channel the person is in, `not-found` for any other (open or private). */
export interface MeetChannelDetail {
  conversationId: number
  name: string
  privacy: 'open' | 'private'
  /** The asker made it. */
  createdByMe: boolean
  members: MeetMember[]
  /** Active people the asker can see who are not in the channel: every teammate, and the guests who share a channel or a direct message with the asker. */
  addable: MeetPerson[]
  may: MeetChannelMay
}

/** An open channel the person has not joined: its name and how many are in it, and nothing else. */
export interface MeetBrowsable {
  conversationId: number
  name: string
  memberCount: number
}

/** Make a channel: open (every teammate sees it and can join) or private (only the people added). Once per `key`. */
export interface MeetChannelMake {
  key: ComposeKey
  name: string
  privacy: 'open' | 'private'
}

/**
 * Invite a guest into a channel the person is in, by name and address. Once per `key`. Meet adds the guest and SENDS THE ONE EMAIL (the invitation, from
 * meet@northfield.example, linking to space.northfield.example/w/); a repeat of the key sends nothing. The address of a teammate is refused (`conflict`: add them instead).
 */
export interface MeetGuestInvite {
  key: ComposeKey
  conversationId: number
  name: string
  address: string
}

/** The guest is in the channel either way; `mailed` is whether the invitation email left. When it did not, inviting again (a new key) sends it again. */
export interface MeetInvited {
  conversationId: number
  person: MeetPerson
  mailed: boolean
}

/** Every change to a channel that needs no key (repeating it does the same again, or is refused), and what each takes. */
export const MEET_CHANNEL_DOS = ['join', 'leave', 'rename', 'archive', 'add', 'take-out', 'remove-guest', 'delete-person'] as const
export type MeetChannelDo = (typeof MEET_CHANNEL_DOS)[number]

/**
 * One change to a channel. `conversationId` is the channel it is made in; `personId` the person it is about (`add`, `take-out`, `remove-guest`, `delete-person`);
 * `name` the new name (`rename`). `remove-guest` and `delete-person` are asked in the channel the person is in with the guest, so a person the asker cannot see is `not-found`.
 */
export type MeetChannelChange =
  | { do: 'join' | 'leave' | 'archive'; conversationId: number }
  | { do: 'rename'; conversationId: number; name: string }
  | { do: 'add' | 'take-out' | 'remove-guest' | 'delete-person'; conversationId: number; personId: string }

/** `channel` is the channel as it stands now, or null where the person is no longer in it (they left, or it was archived). */
export interface MeetChanged {
  conversationId: number
  channel: MeetChannelDetail | null
}

// ── Messages and a person's own settings (the retirement of /start) ──────────────────────────────────────────────────────────────
// The rest of what only meet's old /start page did in chat: start a first direct message (the people the asker may open one with; the message itself is `post` by `personId`,
// which opens the direct message as it posts, once per compose key), edit and delete a message, and a person's own settings (their name in chat, the email that says a
// direct message has waited 15 minutes, the privacy note). Meet's rules are the Workspace object's own, asked as the same teammate, and a refusal is meet's, in its words.
// None of these writes carries a key: editing to the same words, setting a setting and acknowledging a note are the same once as twice, and deleting twice is a refusal the
// second time (`not-found`). Nothing here sends an email: the 15-minute nudge is meet's own, on its own timer, and `updateMe` only says whether it is wanted.

/** Someone the person asking may start a direct message with (or already has one with), and whether that direct message has something in it to open. */
export interface MeetReachable {
  person: MeetPerson
  /** A direct message with something in it exists: the space opens it. Without one, the first message is `post` by `personId`. */
  direct: boolean
}

/** Change the words of one of your own messages. The text is cleaned and limited as a post is (2,000 characters), and cannot be emptied (delete it instead). */
export interface MeetEdit {
  messageId: number
  text: string
}

/** A message that is gone: the conversation it was in and its number. */
export interface MeetDeleted {
  conversationId: number
  messageId: number
}

/** The person asking, as meet keeps them for their own settings. */
export interface MeetMe {
  person: MeetPerson
  /** The owner: deletes another person's message. */
  owner: boolean
  /** The person does not want the email that says a direct message has waited 15 minutes. */
  nudgesOff: boolean
  /** The person has acknowledged the privacy note. */
  privacyAcked: boolean
}

/** What a person changes about themself: either or both. A name is one line of at most 40 characters and cannot be empty; `nudgesOff` is a boolean and nothing else. */
export interface MeetMePatch {
  name?: string
  nudgesOff?: boolean
}

/**
 * meet's part of the space, called in-process (the space's ADR 0016): `spaceMeet` in packages/meet/src/space-meet.ts.
 * (The meet Worker once also exported `SpaceMeet`, the old entrypoint a separately deployed space bound, with the same method names taking the Access assertion first; it is deleted.)
 */
export interface MeetForSpace {
  /** Per person, the direct message with them; each channel the person is in; each with its newest message and unread. */
  conversations(asker: SignedIn): Promise<SpaceReply<MeetOverview>>
  /** A direct message's or channel's history. `not-found` for one the person is not in. */
  history(asker: SignedIn, conversationId: number, before?: number): Promise<SpaceReply<MeetHistory>>
  /**
   * Post a message, with meet's rules: 2,000 characters, six in ten seconds (`limit`), nothing in the Phone conversation. A WRITE:
   * the space awaits it up to `WRITE_WITHIN_MS`, shows "outcome unknown" if it loses track and never retries. `Repeated` when
   * `post.key` was already used.
   */
  post(asker: SignedIn, post: MeetPost): Promise<WriteReply<MeetPosted>>
  /** Mark a conversation read up to a message id, which moves the person's read position on every device. Idempotent, so no key. */
  markRead(asker: SignedIn, conversationId: number, upTo: number): Promise<SpaceReply<MeetRead>>
  /**
   * The calls with someone in them right now that are this person's (`MeetLiveCall.why`), newest first. A read. Meet looks at its
   * newest calls only (`LIVE_CALLS_SCANNED` in packages/meet/src/space-meet.ts), so a call left running behind that many newer ones is not listed.
   */
  liveCalls(asker: SignedIn): Promise<SpaceReply<MeetLiveCall[]>>

  // ── Calls in the space ──
  /**
   * Start a huddle: anyone in the conversation, under the meter. Makes the call, indexes it, and posts one message in the conversation
   * that names it. A WRITE, once per `key` (`Repeated` answers the first call). Refusals: `not-found` (not in the conversation, or it is
   * the Phone one), `limit` (the meter has tripped, or messages are being sent too fast).
   */
  startHuddle(asker: SignedIn, start: MeetHuddleStart): Promise<WriteReply<MeetCall>>
  /** Make a call with no huddle: a call link for an email conversation (`home`) or a New call. A WRITE, once per `key`; `limit` while the meter has tripped. */
  startCall(asker: SignedIn, start: MeetCallStart): Promise<WriteReply<MeetCall>>
  /** Book a meeting with a time. A WRITE, once per `key`; meet sends no email (the space puts the invitation in the email being written). */
  bookMeeting(asker: SignedIn, booking: MeetBooking): Promise<WriteReply<MeetCall>>
  /** The cards for these conversations and homes (at most 20 of each), newest first, each with its call's state. A read. */
  cards(asker: SignedIn, want: MeetCardsWant): Promise<SpaceReply<MeetCall[]>>
  /** Past calls the person may see, newest first, `limit` (1 to 50) at a time. A read. */
  calls(asker: SignedIn, after?: string, limit?: number): Promise<SpaceReply<MeetCallPage>>
  /** One call and its saved chat, to read. `not-found` for a call the person may not see. */
  callChat(asker: SignedIn, name: string): Promise<SpaceReply<MeetCallChat>>
  /** Delete a call's saved chat for good: the owner's, and refused (`conflict`) while anyone is in the call. Idempotent, so no key. */
  deleteCallChat(asker: SignedIn, name: string): Promise<SpaceReply<{ deleted: number }>>
  /** Meetings the person made or is invited to that start in [from, until), soonest first. A read. */
  meetings(asker: SignedIn, from: number, until: number): Promise<SpaceReply<MeetCall[]>>
  /** The month's usage and whether the meter has tripped: the owner's (`not-admitted` for anyone else). A read. */
  usage(asker: SignedIn): Promise<SpaceReply<MeetUsage>>
  /** The Phone conversation: voicemails, missed calls and 911 notices, newest page last. `not-found` where the person has none. A read. */
  phoneConversation(asker: SignedIn, before?: number): Promise<SpaceReply<MeetPhone>>
  /** Mark the Phone conversation read up to an item. Idempotent, so no key. */
  phoneRead(asker: SignedIn, upTo: number): Promise<SpaceReply<MeetRead>>

  // ── Channel admin ──
  /** A channel the person is in, with its people and what they may do. A read. `not-found` for a channel they are not in, or any conversation that is not a channel. */
  channel(asker: SignedIn, conversationId: number): Promise<SpaceReply<MeetChannelDetail>>
  /** The open channels the person has not joined. A read. */
  browseChannels(asker: SignedIn): Promise<SpaceReply<MeetBrowsable[]>>
  /** Make a channel, with the person in it. A WRITE, once per `key`. Refusals are meet's own: a name is needed, it is open or private, the name is taken (`conflict`), too many channels (`conflict`). */
  createChannel(asker: SignedIn, make: MeetChannelMake): Promise<WriteReply<MeetChannelDetail>>
  /** Invite a guest into a channel, and email the invitation. A WRITE, once per `key`; the email goes out once, and only for this call. */
  inviteGuest(asker: SignedIn, invite: MeetGuestInvite): Promise<WriteReply<MeetInvited>>
  /** Join, leave, rename or archive a channel, add someone, take a guest out, remove a guest from the workspace, delete a person. Meet's rules, in its words. Needs no key. */
  changeChannel(asker: SignedIn, change: MeetChannelChange): Promise<SpaceReply<MeetChanged>>

  // ── Messages and a person's own settings ──
  /** The people the asker may start a direct message with, or already has one with: every teammate, a guest who shares a channel with the asker, and anyone they already have a direct message with. Not the asker. A read. */
  peopleToMessage(asker: SignedIn): Promise<SpaceReply<MeetReachable[]>>
  /** Edit one of the asker's own messages. `not-found` for a message in a conversation the asker is not in (and for a message that is not there: the words are the same), `not-admitted` for another's, `bad-request` for an empty or over-long text. A WRITE with no key: the same words twice are the same message. */
  editMessage(asker: SignedIn, edit: MeetEdit): Promise<SpaceReply<MeetMessage>>
  /** Delete a message for everyone: the author's own, or any in a conversation the owner is in. `not-found` as for an edit. A WRITE with no key: a second press is `not-found`. */
  deleteMessage(asker: SignedIn, messageId: number): Promise<SpaceReply<MeetDeleted>>
  /** The asker's own settings. A read. */
  me(asker: SignedIn): Promise<SpaceReply<MeetMe>>
  /** Change the asker's name in chat, or whether they are emailed when a direct message has waited. A WRITE with no key: setting a setting twice is setting it once. */
  updateMe(asker: SignedIn, patch: MeetMePatch): Promise<SpaceReply<MeetMe>>
  /** The asker acknowledges the privacy note. A WRITE with no key: idempotent. */
  acknowledgePrivacy(asker: SignedIn): Promise<SpaceReply<MeetMe>>
  /**
   * The operator's four, for a move of meet's stores between Workers (the space's ADR 0016 describes the move). Each is the install's OWNER's and none touches a message, a call or a person. They name one of the two long-lived objects
   * (`MEET_OBJECTS`): the Workspace object, which holds every channel and chat, and the usage ledger, the Room object that indexes the calls. A call's own Room is not named: there
   * is one per call, they are made and idle in a day, and the move is made with no call in progress.
   * A bookmark is Cloudflare's marker of the object's history now (30 days; a bookmark taken before a transfer has been shown to restore after it).
   */
  storeBookmark(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetBookmark>>
  /**
   * Restart an object: its in-memory state is dropped and its next call starts it afresh, under the code of the Worker that owns its class. A MOVED object keeps running the giving Worker's code
   * until it restarts, so the move ends with this. A Workspace object's open sockets close and their pages reconnect.
   */
  restartStore(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetRestarted>>
  /** Put an object back to a bookmark, dropping everything written since (the last resort; a transfer back is the other tool). Arms the restore for the next start and restarts it. */
  restoreStore(asker: SignedIn, object: MeetObject, bookmark: string): Promise<SpaceReply<MeetRestoring>>
  /**
   * How many rows the object's tables hold, and how many people and conversations of each kind (numbers under names, never a message, a call or a person): read before and after a move, and equal
   * after it. The only way to read the stores' sizes from outside, since the objects have no other door.
   */
  storeCounts(asker: SignedIn, object: MeetObject): Promise<SpaceReply<MeetCounts>>
}

/** The two long-lived objects of meet's stores that the operator can bookmark, restart and restore. */
export const MEET_OBJECTS = ['workspace', 'ledger'] as const
export type MeetObject = (typeof MEET_OBJECTS)[number]

/** A bookmark of an object's history, as Cloudflare names it (the same shape as the knowledge store's). */
export const MEET_BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/
export interface MeetBookmark {
  object: MeetObject
  bookmark: string
}
export interface MeetRestarted {
  object: MeetObject
  restarted: true
}
export interface MeetRestoring {
  object: MeetObject
  restoring: true
}
export interface MeetCounts {
  object: MeetObject
  counts: Record<string, number>
}

/** The operator's four: methods of the part, not of the old `SpaceMeet` entrypoint (the live space never called them). */
export const MEET_OPERATOR_METHODS = ['storeBookmark', 'restartStore', 'restoreStore', 'storeCounts'] as const

/**
 * The phone's requests also come through `serveForSpace`, at this path and under it alone (the dial pad's own calls: its status, the 911 address, the login for
 * the browser phone, the approval for a call, the log, the line's settings, a voicemail's sound). Each is made for the person the space's check named, as a method
 * is, and meet's own phone rules decide what they may do. Nothing else of meet's is reachable this way.
 */
export const MEET_FOR_SPACE_FETCH_PREFIXES = [MEET_PHONE_PATH] as const

/** The method names, so a stub, a test and the part agree on exactly these and no others. */
export const MEET_FOR_SPACE_METHODS = [
  'conversations',
  'history',
  'post',
  'markRead',
  'liveCalls',
  'startHuddle',
  'startCall',
  'bookMeeting',
  'cards',
  'calls',
  'callChat',
  'deleteCallChat',
  'meetings',
  'usage',
  'phoneConversation',
  'phoneRead',
  'channel',
  'browseChannels',
  'createChannel',
  'inviteGuest',
  'changeChannel',
  'peopleToMessage',
  'editMessage',
  'deleteMessage',
  'me',
  'updateMe',
  'acknowledgePrivacy',
  ...MEET_OPERATOR_METHODS,
] as const satisfies readonly (keyof MeetForSpace)[]
