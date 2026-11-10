// The words and numbers both sides share: what a Kind is, the call's size and
// timing, the send caps the usage meter is built from, and how a Room name is
// made, written and read back. Pure; imported by the Worker, the Durable Object
// core and the browser.

/** What one person can publish. `screenAudio` is the sound that comes with a share. */
export const KINDS = ['mic', 'camera', 'screen', 'screenAudio'] as const
export type Kind = (typeof KINDS)[number]
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v)

/** People in one call. One constant; the limit is what each browser must decode, not the SFU. */
export const ROOM_CAP = 8
/** Up to this many people each camera goes up at full quality; past it, at the low step. */
export const FULL_QUALITY_UP_TO = 4
/** A person not heard from for this long drops off everyone's list. */
export const MEMBER_TIMEOUT_MS = 30_000
/** How often a browser checks in (which is also its heartbeat). */
export const CHECKIN_MS = 2_000
export const NAME_MAX = 40

/** Chat: a message is text, at most this many characters. */
export const CHAT_MAX = 2000
/** A member may send CHAT_RATE.max messages in each CHAT_RATE.windowMs; past that they wait for the next window. */
export const CHAT_RATE = { max: 6, windowMs: 10_000 } as const
/** A call keeps at most this many messages. A backstop for a leaked link: past it, sends are refused. */
export const CHAT_ROOM_CAP = 2000
/** One check-in carries at most this many messages, so a late joiner catches up over a few of them. */
export const CHAT_PAGE = 200
/** What a call that has chat saves, and tells the guests. */
export const CHAT_SAVED_NOTICE = 'Messages in this chat are saved.'

export type Quality = 'full' | 'low'
export const qualityFor = (count: number): Quality => (count <= FULL_QUALITY_UP_TO ? 'full' : 'low')

/** What a camera is sent at, by quality step. The browser applies these to its sender. */
export const CAMERA_CAPS = {
  full: { width: 1280, height: 720, bitrate: 1_000_000, fps: 30 },
  low: { width: 640, height: 360, bitrate: 400_000, fps: 24 },
} as const
export const SCREEN_CAP = { bitrate: 1_500_000, fps: 15 } as const

/** Bits per second a published track is capped at, which is what the meter charges per receiver. */
export function rateBps(kind: Kind, quality: Quality): number {
  switch (kind) {
    case 'camera':
      return CAMERA_CAPS[quality].bitrate
    case 'screen':
      return SCREEN_CAP.bitrate
    case 'mic':
      return 40_000
    case 'screenAudio':
      return 64_000
  }
}

/** The free allowance and where new calls stop. Decimal GB, as Cloudflare bills. */
export const FREE_GB = 1000
export const TRIP_GB = 800
export const GB = 1_000_000_000

/** "2026-10" for a timestamp, in UTC, the ledger's key. */
export const utcMonth = (now: number): string => new Date(now).toISOString().slice(0, 7)

/** The first day of the next UTC month, as an ISO date. */
export function nextMonthStart(now: number): string {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

// 32 characters (Crockford's base32: no i, l, o or u), so a random byte maps on with `& 31` and every
// character is equally likely. 20 of them are 100 bits.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const ROOM_NAME_LENGTH = 20

/** A fresh name from random bytes. */
export function newRoomName(random: (n: number) => Uint8Array): string {
  let out = ''
  for (const b of random(ROOM_NAME_LENGTH)) out += ALPHABET[b & 31]
  return out
}

/** The name as people see it: groups of five. */
export const displayName = (name: string): string => name.match(/.{1,5}/g)?.join('-') ?? name

/**
 * Where the page calls the Worker, both under a prefix of the space's open paths (the space's ADR 0018): a call's API at `/r/api`,
 * the channel guests' at `/w/api`. The space's guest door answers each (src/space-guests.ts). One place, so the page and the Worker cannot disagree.
 */
export const CALL_API = '/r/api'
export const GUEST_API = '/w/api'

/** Read a name back from a link or a typed value: groups, dashes and case do not matter. */
export function normalizeRoomName(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[-\s]/g, '')
  return s.length === ROOM_NAME_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null
}

export interface SnapshotMember {
  id: string
  name: string
  muted: boolean
  cameraOff: boolean
  /** What this person is publishing now. `v` changes each time the same kind is published again. */
  publishing: Array<{ kind: Kind; v: number }>
}

/** What a check-in returns. It never carries a session id, a track name, a token or a credential. */
export interface Snapshot {
  revision: number
  count: number
  cap: number
  quality: Quality
  members: SnapshotMember[]
}

export interface RoomInfo {
  count: number
  cap: number
  full: boolean
}

/** One chat message as everyone in the call, and the owner's page, sees it. `memberId` is the sender's Member id (it is in the Snapshot too). */
export interface ChatMessage {
  id: number
  memberId: string
  name: string
  text: string
  /** Milliseconds since 1970, the server's clock. */
  at: number
}

/** What a check-in carries about chat: the messages after the one asked for, and the newest id in the call. */
export interface ChatDelta {
  messages: ChatMessage[]
  last: number
}

/** One row of the list of calls: what the start page shows and the Room reports about itself. */
export interface CallSummary {
  name: string
  display: string
  startedAt: number
  /** Seats taken over the life of the call (a refresh in a new tab counts again). */
  people: number
  messages: number
  /** In the call right now. */
  present: number
  /** When the last person left; null while someone is in it, and for a call that ended before meet kept the time. */
  endedAt: number | null
  /** When the first person took a seat; null for a call nobody has joined and for one that began before meet kept the time. */
  openedAt: number | null
}
