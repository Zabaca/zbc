// The words and numbers the workspace's two sides share: limits, the shapes that cross the wire, and the few pure
// helpers (an address, a code, a channel name). Imported by the Worker, the Durable Object core and the browser.
// CONTEXT.md has the vocabulary; docs/adr/0003 the reasons.

import type { CallKind } from '@space/workspace'
import type { PhoneMessage } from './phone-model'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Messages: the in-call chat's size and rate (model.ts CHAT_MAX, CHAT_RATE), reused by import where they are used. */
export const HISTORY_PAGE = 50
export const CHANNEL_NAME_MAX = 40
export const CHANNELS_MAX = 200

/** The change feed: a browser further behind than this many changes, or this long, is told to reload. */
export const CHANGES_MAX = 1000
export const CHANGES_KEEP_MS = 30 * DAY

/** Guest sign-in. */
export const CODE_TTL_MS = 10 * MINUTE
export const CODE_TRIES = 5
export const CODES_PER_ADDRESS_PER_HOUR = 5
/** Emails to one address a day: a stranger cannot use the sign-in to fill someone's inbox. */
export const CODES_PER_ADDRESS_PER_DAY = 10
/** Wrong codes against one address in an hour, across codes, after which it is shut for the rest of the hour. */
export const WRONG_CODES_LOCK = 10
/** Codes and invitations meet sends in an hour, in all: a backstop for the email allowance. */
export const SENDS_PER_HOUR = 50
export const GUEST_SESSION_MS = 30 * DAY
/** A guest session's expiry is pushed out at most this often, so a request is not a write. */
export const SESSION_RENEW_AFTER_MS = HOUR

/** A socket ticket: made by either door, spent on first use. */
export const TICKET_TTL_MS = 60 * 1000

/** Nudges: an email for a direct message unread this long, to a person not on the page, at most this often. */
export const NUDGE_AFTER_MS = 15 * MINUTE
export const NUDGE_EVERY_MS = HOUR
/** Places in each hour's emails kept back for sign-in codes and invitations: nudges stop short of the allowance by this many. */
export const NUDGE_RESERVE = 10

/** Close codes a socket ends with. The page reads them to decide whether to reconnect, reload or show the sign-in. */
export const CLOSE_SIGNED_OUT = 4401
export const CLOSE_REMOVED = 4403

export type PersonKind = 'teammate' | 'guest'
export type PersonStatus = 'active' | 'removed' | 'former'
export type Privacy = 'open' | 'private'

export interface PersonView {
  id: string
  name: string
  kind: PersonKind
  status: PersonStatus
  /** Only teammates are shown anyone's address, and who invited a guest (so the inviter can remove them). */
  email?: string
  invitedBy?: string | null
  /** A guest who has not signed in yet. */
  invited: boolean
}

export interface MeView {
  id: string
  name: string
  email: string
  kind: PersonKind
  owner: boolean
  nudgesOff: boolean
  /** Whether this person has seen the privacy note. */
  privacyAcked: boolean
}

/**
 * The sender of the Phone conversation's messages: not a Person, no row in `people`. Only the phone core writes as it (workspace.ts
 * `phoneDesk`); every route that takes a person's words refuses the Phone conversation.
 */
export const PHONE_SENDER = 'phone'
export const PHONE_NAME = 'Phone'

export interface ConversationView {
  id: number
  /** `phone` is the Phone conversation: every person of the company is in it, no guest ever is, and only the phone posts to it (docs/adr/0005). */
  kind: 'channel' | 'dm' | 'phone'
  /** A channel's name, or "Phone"; null for a direct message, which is named for the other person. */
  name: string | null
  privacy: Privacy | null
  createdBy: string | null
  members: string[]
  /** Messages from others after this person's read position. */
  unread: number
  lastRead: number
  /** The newest message in it, for the sidebar's order. */
  last: { id: number; at: number } | null
}

/** An open channel this teammate is not in. They can see that it exists; reading means joining. */
export interface BrowseChannel {
  id: number
  name: string
  memberCount: number
}

export interface WMessage {
  id: number
  conv: number
  person: string
  name: string
  text: string
  at: number
  editedAt: number | null
  /** Only in the Phone conversation: what the message is beside its words (a voicemail to play, a missed call to return). */
  phone?: PhoneMessage
  /** Only on the message that announces a huddle: the call's name. The words carry its link, so a page that draws no card still shows "Join call". */
  huddle?: string
}

/** Whose workspace this is, for the words the page says: the company's name and the install's owner, whom a person is told to ask. Only a signed-in person is told the owner's address. */
export interface SiteView {
  company: string
  owner: { name: string; address: string }
}

/** What a page that nobody is signed in to may say: the company's name and who owns the install, by name. Answered by `GET <GUEST_API>/site`. */
export interface PublicSite {
  company: string
  owner: { name: string }
}

export interface Bootstrap {
  me: MeView
  people: PersonView[]
  conversations: ConversationView[]
  browse: BrowseChannel[]
  /** The newest change this answer reflects: the socket's `since`. */
  seq: number
  site: SiteView
}

/** What a structure change was, so the page knows to ask again. */
export type StructureWhy = 'created' | 'renamed' | 'archived' | 'added' | 'removed' | 'purged' | 'joined' | 'left' | 'person'

export type Change =
  | { seq: number; at: number; kind: 'message'; data: { conv: number; message: WMessage } }
  | { seq: number; at: number; kind: 'edit'; data: { conv: number; id: number; text: string; editedAt: number } }
  | { seq: number; at: number; kind: 'delete'; data: { conv: number; id: number; author: string } }
  | { seq: number; at: number; kind: 'read'; data: { conv: number; upTo: number; unread: number } }
  | { seq: number; at: number; kind: 'structure'; data: { conv: number | null; why: StructureWhy; person?: string } }

export type ChangeKind = Change['kind']

/** What a socket's first reply to `hello` carries. */
export type CatchUp = { reload: true } | { reload: false; changes: Change[]; seq: number }

// --- What the space asks (docs: packages/workspace/src/meet-for-space.ts) ------------------------------------------------
// The core's own raw answers to the space's questions. `space-meet.ts` turns them into the contract's shapes (it
// normalises the addresses and cuts the snippets), so the core says what is true and the entrypoint says how it is told.

/** A person as a teammate is shown them, with the address meet stored (not yet in the space's spelling). */
export interface SpacePerson {
  id: string
  name: string
  kind: PersonKind
  email: string
}

export interface SpaceDirectRaw {
  conv: number
  other: SpacePerson
  newest: WMessage | null
  unread: number
}

export interface SpaceChannelRaw {
  conv: number
  name: string
  privacy: Privacy
  members: number
  /** When the channel was made, so one nobody has written in yet still has a row. */
  createdAt: number
  newest: WMessage | null
  unread: number
}

export interface SpaceOverviewRaw {
  me: SpacePerson
  direct: SpaceDirectRaw[]
  channels: SpaceChannelRaw[]
  /** The Phone conversation the person is in, or null before there is one. */
  phone: { conv: number; newest: WMessage | null; unread: number } | null
  /** The newest calls with no conversation the person made (New call). */
  calls: SpaceCallRaw[]
}

/** A call the workspace knows a conversation, a home or a meeting for (the table `space_calls`), with who made it. */
export interface SpaceCallRaw {
  name: string
  kind: CallKind
  /** The person who made it, and their name now. */
  by: string
  byName: string
  at: number
  conv: number | null
  home: string | null
  title: string | null
  startsAt: number | null
  invitees: Array<{ name: string; address: string | null }>
  /** Whether the asker made it. */
  mine: boolean
}

/** Why a call is the asker's: they made it, they are invited to its meeting, or it is a huddle in a conversation they are in. */
export type SpaceCallWhy = 'started' | 'invited' | 'conversation'

/** A keyed write's first step: the call this key already made (a repeat), or null. */
export interface CallBeginRaw {
  held: SpaceCallRaw | null
}

/** A call recorded, and for a huddle the message that announces it. `repeated`: the key had made it already and nothing was done. */
export interface CallRecordRaw {
  repeated: boolean
  call: SpaceCallRaw
  message: WMessage | null
}

export interface SpacePhoneRaw {
  conv: number
  unread: number
  messages: WMessage[]
  more: boolean
}

/** What the asker may do with one person in a channel, by the Workspace's rules (the buttons /start drew). */
export interface SpaceMemberRaw {
  person: SpacePerson
  /** A guest who has not signed in yet. */
  invited: boolean
  you: boolean
  /** The asker has a direct message with them that has a message in it. */
  direct: boolean
  may: { takeOut: boolean; removeFromWorkspace: boolean; deleteEverything: boolean }
}

/** A channel the asker is in, with its people, who can be added and what the asker may do. */
export interface SpaceChannelDetailRaw {
  conv: number
  name: string
  privacy: Privacy
  createdByMe: boolean
  members: SpaceMemberRaw[]
  addable: SpacePerson[]
  may: { rename: boolean; leave: boolean; archive: boolean; add: boolean; invite: boolean }
}

/** An open channel the asker has not joined. */
export interface SpaceBrowsableRaw {
  conv: number
  name: string
  members: number
}

/** A keyed channel made: the channel, and whether the key had made it already. */
export interface SpaceMadeRaw {
  repeated: boolean
  channel: SpaceChannelDetailRaw
}

/** A keyed invitation: the email to send (null for a repeat, which sends nothing), the guest, and whether the first one's email is known to have left. */
export interface SpaceInvitedRaw {
  repeated: boolean
  conv: number
  person: SpacePerson
  mail: { to: string; inviter: string; channel: string } | null
  mailed: boolean
}

/** One change to a channel, as the Workspace takes it (the contract's `MeetChannelChange`). */
export type SpaceChangeRaw =
  | { do: 'join' | 'leave' | 'archive' }
  | { do: 'rename'; name: unknown }
  | { do: 'add' | 'take-out' | 'remove-guest' | 'delete-person'; personId: unknown }

/** Someone the asker may start a direct message with (or has one with), and whether that direct message has something in it. */
export interface SpaceReachableRaw {
  person: SpacePerson
  direct: boolean
}

/** A message edited for the space: the message as it now stands, and the asker's id and whether they own the workspace, so the caller can say what they may do with it. */
export interface SpaceEditedRaw {
  me: string
  owner: boolean
  message: WMessage
}

/** The asker's own settings, as the space shows them. */
export interface SpaceMeRaw {
  me: SpacePerson
  owner: boolean
  nudgesOff: boolean
  privacyAcked: boolean
}

export interface SpaceHistoryRaw {
  /** Whether the asker owns the workspace (an owner): they delete another person's message, which the page draws a button for. */
  owner: boolean
  /** The asker's person id, so the caller can tell which messages are theirs. */
  me: string
  messages: WMessage[]
  more: boolean
}

/** What a keyed post answers: the post that went out (this time or the first), and whether this was a repeat of a key already used. */
export interface SpacePostRaw {
  repeated: boolean
  conv: number
  message: WMessage
  me: string
  /** Whether the asker owns the workspace, so the caller can say what they may do with the message. */
  owner: boolean
}

/** What the browser sends over the socket. */
export type ClientFrame = { t: 'hello'; since: number } | { t: 'read'; conv: number; upTo: number } | { t: 'ping' }
/** What the socket sends the browser. */
export type ServerFrame =
  | { t: 'catchup'; changes: Change[]; seq: number }
  | { t: 'reload' }
  | { t: 'change'; change: Change }
  | { t: 'error'; message: string }

/** A lowercase address, or null when it does not look like one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  return s.length <= 254 && /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/.test(s) ? s : null
}

/** A channel's name: one line, no leading #, at most CHANNEL_NAME_MAX characters. Empty is refused by the caller. */
export function cleanChannelName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    // the control characters themselves are what is being removed
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, CHANNEL_NAME_MAX)
    .trim()
}

/** One line of text a person typed (a meeting's title, an invited person's name): control characters and the direction overrides that make text read backwards removed, spaces collapsed, cut to `max`. Empty stays empty. */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return (
    raw
      // the control characters themselves are what is being removed
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .trim()
  )
}

/** "jane.smith@northfield.example" becomes "Jane Smith": a teammate's name until they set one. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  const words = local.split(/[._+-]+/).filter(Boolean)
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return name || 'Teammate'
}

/** Six digits from random bytes, every code equally likely: three bytes make a number below 2^24, and the top 777,216 values are not used. */
export function newCode(random: (n: number) => Uint8Array): string {
  for (;;) {
    const b = random(3)
    const n = ((b[0] as number) << 16) | ((b[1] as number) << 8) | (b[2] as number)
    if (n < 16_000_000) return String(n % 1_000_000).padStart(6, '0')
  }
}

/** A typed code as it is checked: digits only (a pasted "123 456" works), exactly six. */
export function readCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(s) ? s : null
}
