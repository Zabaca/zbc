/**
 * What the Telegram bridge and the inbox say to each other: the one contract, owned by the inbox and imported by the bridge as types
 * (the Telegram bridge reaches it by a relative path, so its bundle holds no inbox code, only these shapes). Zero
 * dependencies and no I/O, so a Worker bundles it and the bridge's tests drive it.
 *
 * ── THE SEVEN CALLS ──────────────────────────────────────────────────────
 * The bridge's door serves seven calls and nothing else (src/telegram/app.ts). Five are a POST of one JSON object; the sixth (`media`) is a POST of one file's bytes, and the seventh (`picture`)
 * is a POST whose ANSWER is one file's bytes, the picture of a send the bridge is being offered:
 *
 *   push      messages Telegram told the bridge of, or the bridge read out of a chat, with the chats they are in and Telegram's position after them
 *   events    edits, deletions for everyone and read marks (the owner read a chat on another device), with the position after them
 *   work      what the bridge is owed (Telegram's stored position; the newest stored message of each chat on request; the read marks and the sends the space owes Telegram). It is
 *             also the heartbeat: the space stamps "checked in" from it at most once a minute
 *   outcomes  what became of the work it was owed (a read mark done, or one Telegram refused for good; a send Telegram took, with its message id, or refused for
 *             good), so the space stops offering it
 *   status    what the bridge says of itself: live, catching up, or signed out
 *   media     one photo or voice note the space asked for (an `owed` item of kind `media`), as the file's bytes, at most `telegramFileMax(kind)` (the body must carry a Content-Length); the query names the account, the chat and the message
 *   picture   the picture of a send the bridge is being offered (an `owed` item of kind `send` that names a `picture`), as the answer's bytes; the query names the account, the send's id and the random id it was offered under.
 *             Answered only while that very send is owed, has a picture, has been offered and may still be offered (`SEND_RETRY_FOR_MS` from its first offer, plus the fetch's own limit)
 *
 * ── A MESSAGE IS UNTRUSTED INPUT ─────────────────────────────────────────
 * Every string here is something a stranger wrote or a Telegram profile says. The parser bounds every size, checks every shape and keeps only the fields below;
 * nothing is interpreted. A message from Telegram's own service chat (where login codes arrive) and the owner's Saved Messages are refused here too, though the bridge
 * drops both before anything leaves it: a login code that reached the inbox could be read by anyone who can read it, Claude's script included.
 */

/** Telegram's own service chat: the account login codes and new-login notices come from. Never carried, anywhere. */
export const TELEGRAM_SERVICE_CHAT = '777000'

/** Telegram's position for the account (`updates.getState`): the cursor a catch-up starts from. */
export interface TelegramPosition {
  pts: number
  qts: number
  date: number
  seq: number
}

/** A person (or bot) on the other side of a one-to-one chat. `id` is Telegram's user id, stable for life; a username changes and is only a name. */
export interface TelegramPerson {
  id: string
  /** As the owner's Telegram shows them: the name they saved the contact under first, else their own. May be empty (the inbox then falls back to the username, then the id). */
  name: string
  username?: string
  /** Digits only, as Telegram gives it, present only for a person in the owner's contacts who allows it. Used for the phone-number join and nothing else. */
  phone?: string
  bot: boolean
}

/**
 * What the bridge knows of a chat a message is in: a person or a bot (one-to-one), a group, or a channel the owner follows.
 *
 * A chat's id is one spelling across the three sequences Telegram keeps: a person's is their user id (digits), a basic group's is `-` and its id, and a supergroup's or a channel's
 * is `-100` and its id (the Bot API's "marked" ids), so a group can never be taken for a person with the same number.
 */
/**
 * Who wrote a message in a group. As a person, except that the bridge may know only the id (the update named a user it did not describe): `bot` is then absent, and the inbox leaves what it
 * already holds of that person (bot or not, username) exactly as it is, so a message with no description can never turn a bot into a person or back.
 */
export type TelegramSender = Omit<TelegramPerson, 'bot'> & { bot?: boolean }

export interface TelegramChat {
  /** A person's user id, or a group's or channel's marked id (a `-` first). */
  id: string
  kind: 'user' | 'bot' | 'group' | 'channel'
  /** For a one-to-one chat (`user`, `bot`), the other person. Absent for a group and a channel. */
  person?: TelegramPerson
  /** For a group and a channel, its title. */
  title?: string
  /** Whether the owner muted the chat in Telegram. Read once per message at its arrival by the notification rule (a muted chat never rings) and stored nowhere: the next message carries Telegram's answer again. */
  muted: boolean
  /** The chat is in Telegram's archive folder. Read only in a `mirror`, and only for a conversation the push makes: an archived chat comes in closed. */
  archived?: boolean
  /** The newest message of the other person that the owner has read in Telegram. Read only in a `mirror`: a message at or below it is filed read. */
  readInboxMaxId?: number
}

/**
 * The most a photo, a voice note or a picture sent as a file the inbox copies may weigh: 10 MB. The bridge never uploads more, the door refuses more, and the inbox names
 * a larger one only. (A photo Telegram sends is a few hundred KB; a voice note of a few minutes is under a megabyte; ten is a bound and not a target.) A video has its own, larger limit.
 */
export const TELEGRAM_SMALL_FILE_MAX_BYTES = 10 * 1024 * 1024

/**
 * The most a video the inbox copies may weigh: 50 MB (a larger limit than the other kinds). Kept apart from the limit above on purpose: a larger limit for every kind would let a 50 MB picture or voice note through,
 * and a picture is read whole for its thumbnail. A video is held in memory once on the bridge (the memory limits of wherever the bridge runs bound it) and is never held
 * whole in the space: it goes to the bucket as a stream and comes back in parts (`INBOX_FILE_PART_BYTES`, @space/workspace).
 *
 * A bridge says it takes videos this large by sending this number as `videoMax` on its work request (`TelegramWorkRequest`); a video over `TELEGRAM_SMALL_FILE_MAX_BYTES` is offered to no other bridge.
 */
export const TELEGRAM_VIDEO_MAX_BYTES = 50 * 1024 * 1024

/** The most a file of this kind of media may weigh to be copied. The one place the two limits are told apart: the plan, the bridge's download, the door and the keeper all ask it. */
export const telegramFileMax = (kind: TelegramCopiedKind): number =>
  kind === 'video' ? TELEGRAM_VIDEO_MAX_BYTES : TELEGRAM_SMALL_FILE_MAX_BYTES

/**
 * The most a picture the owner sends may weigh: 10 MB, Telegram's limit for a photo. A constant of its own beside the copy limit above, and the same number today on purpose:
 * a change to what is copied IN (videos went to 50 MB) must never change what may be sent OUT.
 */
export const TELEGRAM_PICTURE_MAX_BYTES = 10 * 1024 * 1024

/** The most words Telegram takes under a picture (its caption limit without Premium; whether the owner has Premium is not known and the lower limit is safe for both). Words alone stay at `TELEGRAM_TEXT_MAX`. */
export const TELEGRAM_CAPTION_MAX = 1024

/** The pictures the inbox sends, as Telegram photos: a desktop screenshot is a PNG, a phone photo a JPEG. Decided by the first bytes (`sniffPicture`), never by a name or a type anyone gave. */
export const TELEGRAM_PICTURE_TYPES = ['image/png', 'image/jpeg'] as const
export type TelegramPictureType = (typeof TELEGRAM_PICTURE_TYPES)[number]

/**
 * A PNG or a JPEG by its first bytes: PNG's eight-byte signature, or JPEG's start-of-image marker followed by another marker. THE ONE PLACE the two are told from anything else: the inbox's send and its previews
 * (`sniffImage`, src/image.ts, which adds GIF and WebP), the bridge before it uploads, and the page before Send (src/client/compose.ts) all call it. It has no dependencies, which is why it lives in this file.
 */
export function sniffPicture(bytes: Uint8Array): TelegramPictureType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

/** What a send's picture is, as the work offer names it: its type and its length. The bytes are fetched on the door's seventh call. */
export interface TelegramPictureFacts {
  type: TelegramPictureType
  size: number
}

/**
 * What a message carries besides words. A `photo`, a `voice` note, an `image` (a picture sent as a file: png, jpeg, webp or heic, never a gif) and a `video` are copied when they are within the limit; the others are named with their size and left in Telegram.
 */
export const TELEGRAM_MEDIA_KINDS = ['photo', 'voice', 'audio', 'video', 'gif', 'sticker', 'file', 'image'] as const
export type TelegramMediaKind = (typeof TELEGRAM_MEDIA_KINDS)[number]

/** The kinds of file the inbox copies, and so the kinds the bridge is ever asked for. */
export const TELEGRAM_COPIED_KINDS = ['photo', 'voice', 'image', 'video'] as const
export type TelegramCopiedKind = (typeof TELEGRAM_COPIED_KINDS)[number]
export const isCopiedKind = (kind: string): kind is TelegramCopiedKind =>
  (TELEGRAM_COPIED_KINDS as readonly string[]).includes(kind)

/**
 * What the bridge knows of a message's file from the message alone, before any download: its kind, its size when Telegram gives one (a photo's is the size of its largest version) and its type and
 * length as the sender's app declared them (hints; the inbox trusts neither: the bytes decide what a file is). Never a file name: a name is a stranger's text.
 */
export interface TelegramMedia {
  kind: TelegramMediaKind
  size?: number
  mime?: string
  /** A voice note's, audio's or video's length in seconds. */
  seconds?: number
}

export interface TelegramMessage {
  chatId: string
  /** Telegram's message id. For a chat with a person, one sequence across the whole account. */
  id: number
  /** When the message was sent (ISO). */
  at: string
  /** The owner's own message (sent from their phone or another device). */
  out: boolean
  /** The text, or a short bracketed label for a message that has none ("[Photo]"). Plain text, as Telegram has it. */
  text: string
  /** When it was last edited (ISO), when the message arrives already edited. */
  editedAt?: string
  /**
   * In a group: who wrote it, when it is somebody else (the owner's own message names nobody). Each sender who writes becomes a person (ADR 0001 decision 29), so a message in a group is filed under its
   * sender. Absent in a channel (a post has no sender but the channel) and on a message whose sender Telegram did not name (it is then filed under the group).
   */
  sender?: TelegramSender
  /** In a group: Telegram marks the message as mentioning the owner (the badge their phone shows). The inbox also checks `replyTo` against their own messages. */
  mentionsMe?: boolean
  /** In a group: the id of the message this one answers, in the same chat. A reply to one of the owner's own messages is addressed to them (ADR 0001 decision 29). */
  replyTo?: number
  /** The file the message carries, when it carries one. The space decides from this whether the bridge is asked for the bytes (`TelegramOwed` of kind `media`). */
  media?: TelegramMedia
}

export interface TelegramPush {
  account: { id: string }
  /**
   * The messages were READ from the chats as Telegram has them (the first fill, or a read-through after a gap that was too long to ask for): each new message is filed
   * with Telegram's read state, and a conversation this push makes comes in closed if the chat is archived. Absent or false, the messages are live ones: a message from the
   * other person arrives unread, and a closed conversation is reopened by it.
   */
  mirror?: boolean
  /**
   * These are LIVE updates: Telegram told the bridge of them as they happened (the bridge's live drain), as against a first fill, a read-through or a catch-up after a gap. Only a live message
   * can ring the owner's devices (the mail rule's other checks still apply); a fill or a catch-up never rings, whatever the age of what it brings. Absent or false, nothing rings.
   */
  live?: boolean
  chats: TelegramChat[]
  messages: TelegramMessage[]
  /** Telegram's position once these are stored; stored in the same write. */
  position?: TelegramPosition
  /** The position of each supergroup and channel in this push (its own pts, which the account's position does not cover), once these are stored; stored in the same write, per chat. */
  chatPositions?: Record<string, number>
  /**
   * Basic groups whose last 30 days the bridge has now read back (the account's position covers a basic group from then on, but a store that already held the position before groups were
   * carried never had their earlier messages). Stored in the same write as the messages, as a marker per chat, and answered by `work` with `newest`, so a group is read back once and not again.
   */
  backRead?: string[]
  /**
   * Chats whose last 30 days the bridge has now read again for their FILES: a message the inbox stored before it knew the message had a file (an earlier bridge sent none)
   * is given its file when a push repeats it, and the file is then owed as any other. Stored in the same write as the messages, as a marker per chat (`telegram-media-read:<chat>`, no migration), and
   * answered by `work` as `mediaRead`, so a chat is read for its files once and not again.
   */
  mediaRead?: string[]
}

export interface TelegramEdit {
  chatId: string
  id: number
  text: string
  /** When it was edited (ISO). */
  at: string
}

export interface TelegramDeletion {
  /** Absent for a deletion in a chat with a person (Telegram names the ids and no chat there; the ids are one sequence for the account). */
  chatId?: string
  ids: number[]
  /** When the bridge heard of it (ISO). */
  at: string
}

/**
 * The owner read a chat on another device: every message of the other side at or below `upTo` is read (Telegram's `readInboxMaxId` moving up). The space marks the messages it holds up to there
 * read, as Telegram; it is never sent back to Telegram (that would be an echo), and it never marks anything unread.
 */
export interface TelegramRead {
  chatId: string
  /** The newest message id the owner has read in the chat. */
  upTo: number
  /** When the bridge heard of it (ISO). */
  at: string
}

export interface TelegramEvents {
  account: { id: string }
  edits: TelegramEdit[]
  deletions: TelegramDeletion[]
  /** Read marks from Telegram. Absent from a bridge that does not carry them. */
  reads?: TelegramRead[]
  position?: TelegramPosition
  /** As in a push: the own position of each supergroup and channel, once these are stored. */
  chatPositions?: Record<string, number>
}

export interface TelegramWorkRequest {
  account: { id: string }
  /** Also answer the newest stored message id of every chat: what a read-through starts from. */
  newest?: boolean
  /**
   * This bridge takes files: only then are `media` items offered in `owed`. A bridge from before files treats every item that is not a send as a read mark, so it must never be offered one; it does not
   * send the flag, which also makes a downgrade of the bridge safe while files are owed (the rows wait for a bridge that asks).
   */
  media?: boolean
  /**
   * The largest video, in bytes, this bridge downloads (`TELEGRAM_VIDEO_MAX_BYTES`). A bridge from before large videos sends none and downloads at most `TELEGRAM_SMALL_FILE_MAX_BYTES` of anything, so it is
   * never offered a video over that, and its work request never starts the pass that owes the videos once left as too large (it would answer "too large" for each, for good). Only a bridge that sends this
   * at or above the video limit is offered such a video; the order of the two deploys then does not matter.
   */
  videoMax?: number
  /**
   * This bridge sends pictures: only then is a send that carries one offered. An older bridge would send the caption alone, so it must never be offered such a send; it does not send the flag. The
   * send waits (its five minutes run from its claim) and goes back to being a draft with its picture if no bridge that sends pictures asks.
   */
  pictures?: boolean
}

/**
 * The longest text Telegram takes in one message (4,096 characters), which the telegram skill's script already enforces. The inbox refuses a longer send before it is claimed, so a send the
 * bridge is offered is always one Telegram can take.
 */
export const TELEGRAM_TEXT_MAX = 4096

/**
 * HOW LONG A SEND MAY STILL BE GOING OUT, in one place (the bridge and the inbox both read it). A send is offered to the bridge for `SEND_RETRY_FOR_MS` from its first offer. The last offer may start a
 * request Telegram does not answer: the bridge gives it `SEND_TIMEOUT_MS` and then ENDS ITS PROCESS (so GramJS, which sends again a request it holds pending after a reconnect, is dropped with it) and the
 * supervisor starts it again; a bridge that hears nothing from Telegram restarts itself after `BRIDGE_SILENCE_DEFAULT_MS` anyway. So a send may land until `SEND_IN_FLIGHT_MS` after its first offer, and the
 * inbox lets the owner answer for it only after that: a "did not go out" answered earlier could be followed by the send, and a new send of the same words would then be a second one.
 */
export const SEND_RETRY_FOR_MS = 5 * 60_000
export const SEND_TIMEOUT_MS = 30_000
export const BRIDGE_SILENCE_DEFAULT_MS = 300_000
export const SEND_MARGIN_MS = 60_000
/** A send that carries a picture first fetches it from the door and uploads it to Telegram, each bounded (a minute each); the time a send may still land grows by both, for every send (one rule, not two). */
export const SEND_FETCH_TIMEOUT_MS = 60_000
export const SEND_UPLOAD_TIMEOUT_MS = 60_000
export const SEND_IN_FLIGHT_MS =
  SEND_RETRY_FOR_MS +
  SEND_TIMEOUT_MS +
  SEND_FETCH_TIMEOUT_MS +
  SEND_UPLOAD_TIMEOUT_MS +
  BRIDGE_SILENCE_DEFAULT_MS +
  SEND_MARGIN_MS

/**
 * One thing the space owes Telegram.
 *
 * A read mark: the owner opened this chat in the space and saw everything up to message `upTo`, so Telegram is told to mark the chat read up to exactly there, as their phone does. Never
 * the newest message the chat has: only what they were shown.
 *
 * A copy: a photo or a voice note the space stored the words of and wants the bytes of. The bridge downloads exactly that message's file, if it is within `telegramFileMax(kind)`, and uploads it on
 * the `media` call; a file it cannot get is reported as a `media` outcome so the space stops offering it. Nothing is ever sent TO Telegram for it: a download is a read.
 *
 * A send: the owner pressed Send in the space (or Claude sent a stored draft on their recorded instruction, under their switch), the inbox claimed the draft, and this is the message to put into
 * the chat. `randomId` is Telegram's own repeat key, made once when the draft was claimed and stored with it (a decimal string for a 64-bit number): Telegram stores a message sent twice
 * with one key once, so the bridge may send the same offer again after it lost track of the first without ever doubling it. The text is the draft's, byte for byte; plain text only.
 * A send is offered for `SEND_RETRY_FOR_MS` (five minutes) from its first offer and then no more: past that the outcome is unknown, shown as such, and never retried. `leftMs` is how much of that is left when the
 * space answers: the bridge starts no send once that long has passed since it ASKED, because the sends of one pass run one after another and a slow picture ahead of a send must not carry it past a window
 * that `SEND_IN_FLIGHT_MS` counts on. Absent from an older space: no such bound.
 */
export type TelegramOwed =
  | { kind: 'read'; chatId: string; upTo: number }
  | {
      kind: 'send'
      messageId: string
      chatId: string
      text: string
      randomId: string
      picture?: TelegramPictureFacts
      leftMs?: number
    }
  | { kind: 'media'; chatId: string; id: number; mediaKind: TelegramCopiedKind }

/** What the space owes the bridge. */
export interface TelegramWork {
  /** Telegram's stored position for the account, or null when none is stored (then the bridge fills). */
  position: TelegramPosition | null
  /** The stored position of each supergroup and channel that has one, by chat id: what each one's catch-up starts from. */
  chatPositions: Record<string, number>
  /** The newest stored Telegram message id per chat id, only when asked for. */
  newest?: Record<string, number>
  /** The basic groups already read back (see `TelegramPush.backRead`), only when asked for. */
  backRead?: string[]
  /**
   * The chats the bridge is asked to read again for their files, because the space holds messages of theirs it has never had the files of (`TelegramPush.mediaRead`): at most `LIMITS.mediaReadPerWork`, only when the
   * request says `media: true`, and never a chat that already has its marker. The bridge pushes the messages of those chats that carry a file (the space adopts the file of one it already holds) with `mediaRead` naming the chat.
   */
  mediaRead?: string[]
  /** What the space owes Telegram (sends first, then read marks), oldest first, at most `LIMITS.owedPerWork` at once. Offered again until an outcome settles it (a send, for `SEND_RETRY_FOR_MS` only). */
  owed: TelegramOwed[]
}

/**
 * What became of one thing the bridge was owed. A mark or a send that failed for good carries the short answer Telegram gave (a code, never a message's text). A send that Telegram took
 * carries the message id it made and when (ISO), which is how the inbox files the draft as the sent message and recognises the copy that later arrives in the bridge's own stream.
 * A send whose outcome the bridge does not know (no answer in time) is NOT reported: the bridge ends its process, and the send is offered again, with the same `randomId`, until the space stops offering it.
 * An outcome names the `randomId` the send was offered under, and the inbox settles only the claim that holds that very key: a late answer for a send the owner has since taken back and sent again settles nothing.
 */
export type TelegramOutcome =
  | { kind: 'read'; chatId: string; upTo: number; ok: true }
  | { kind: 'read'; chatId: string; upTo: number; ok: false; reason: string }
  | { kind: 'send'; messageId: string; randomId: string; ok: true; telegramId: number; at: string }
  | { kind: 'send'; messageId: string; randomId: string; ok: false; reason: string }
  | { kind: 'media'; chatId: string; id: number; ok: false; reason: TelegramMediaRefusal }

/**
 * Why a file the space asked for will never be copied: it was bigger than the limit once downloaded (`too-large`), Telegram no longer has the message or its file (`gone`), or the bridge tried a few
 * times and could not (`failed`). A file that was copied is not an outcome: its upload on the `media` call settles it.
 */
export const TELEGRAM_MEDIA_REFUSALS = ['too-large', 'gone', 'failed'] as const
export type TelegramMediaRefusal = (typeof TELEGRAM_MEDIA_REFUSALS)[number]

/** What the `media` call answers: the file is kept, at this many bytes. */
export interface MediaResult {
  kept: true
  size: number
}

/** What the `media` call names, in its query: the account, the chat and the message whose file the body is. */
export interface TelegramMediaQuery {
  account: string
  chatId: string
  id: number
}

export interface TelegramOutcomes {
  account: { id: string }
  outcomes: TelegramOutcome[]
}

export interface OutcomesResult {
  /** Outcomes that settled something owed. */
  settled: number
  /** Outcomes that named nothing owed (already settled, or a newer mark replaced it). */
  unknown: number
}

export type TelegramState = 'live' | 'catching-up' | 'signed-out'

export interface TelegramStatusReport {
  account: { id: string }
  state: TelegramState
  /** For a signed-out report, the answer Telegram gave (a code such as AUTH_KEY_UNREGISTERED). Never a message's text. */
  reason?: string
}

export interface PushResult {
  /** Messages stored by this push. */
  stored: number
  /** Messages the inbox already held (a push repeated after a timeout). */
  repeated: number
  /** Messages and chats refused: the service chat and Saved Messages. */
  skipped: number
}

export interface EventsResult {
  edited: number
  deleted: number
  /** Messages stamped read by this call's read marks. */
  read: number
  /** Edits, deletions and read marks that named a message or chat the inbox does not hold (it is older than the first fill, or was never carried). */
  unknown: number
}

// ─── the parser ────────────────────────────────────────────────────────

/** Bounds on a call, so one request can never be the whole store. A fill is sent in batches under these. */
export const LIMITS = {
  messagesPerPush: 500,
  chatsPerPush: 200,
  text: 20_000,
  name: 200,
  eventsPerCall: 500,
  owedPerWork: 50,
  outcomesPerCall: 100,
  idsPerDeletion: 100,
  /** At most this many photos and voice notes are asked for in one work request, newest first. */
  mediaPerWork: 10,
  /** At most this many chats are asked to be read again for their files in one work request. */
  mediaReadPerWork: 5,
  body: 2_000_000,
} as const

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = <T>(error: string): Parsed<T> => ({ ok: false, error })

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const isPosInt = (v: unknown): v is number => isInt(v) && v > 0
/** A Telegram user id: digits, no sign, at most 19 of them (a 64-bit number). */
const isTelegramId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v)
/** A chat's id as the wire spells it: a user id, or a group's or channel's marked id (`-` first). */
const isChatId = (v: unknown): v is string => typeof v === 'string' && /^-?[1-9][0-9]{0,19}$/.test(v)
/**
 * THE ONE PLACE a chat id's spelling is written (the bridge, the store and its SQL all read it from here). A person's chat is their user id; a basic group's is `-` and its id; a supergroup's or a
 * channel's is `-100` and its id, and only these two have a position of their own (the account's does not cover them).
 */
export const CHANNEL_ID_PREFIX = '-100'
/** Whether a chat id is a group's or a channel's. */
export const isChatGroupId = (id: string): boolean => id.startsWith('-')
/** Whether a chat id is a supergroup's or a channel's, which has a position of its own. */
export const hasOwnPosition = (id: string): boolean => id.startsWith(CHANNEL_ID_PREFIX)
/** The wire's id of a basic group, from the library's own. */
export const groupChatId = (rawId: string): string => `-${rawId}`
/** The wire's id of a supergroup or a channel, from the library's own. */
export const channelChatId = (rawId: string): string => `${CHANNEL_ID_PREFIX}${rawId}`
/** The library's own id of a group or channel, from the wire's: `-100123` is channel 123, `-123` is basic group 123. */
export const rawChatId = (chatId: string): string =>
  hasOwnPosition(chatId) ? chatId.slice(CHANNEL_ID_PREFIX.length) : chatId.replace(/^-/, '')
const isIso = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v) &&
  !Number.isNaN(Date.parse(v))

/** An ISO time as the one spelling the store compares (UTC, milliseconds). */
export const iso = (v: string): string => new Date(v).toISOString()

function position(v: unknown, where: string): Parsed<TelegramPosition> {
  if (!isObj(v)) return bad(`${where}: an object with pts, qts, date and seq`)
  const { pts, qts, date, seq } = v
  if (!isInt(pts) || !isInt(qts) || !isInt(date) || !isInt(seq) || pts < 0 || qts < 0 || date < 0 || seq < 0) {
    return bad(`${where}: pts, qts, date and seq are whole numbers, zero or more`)
  }
  return { ok: true, value: { pts, qts, date, seq } }
}

function chatPositions(v: unknown, where: string): Parsed<Record<string, number>> {
  if (!isObj(v)) return bad(`${where}: an object of chat id to position`)
  const entries = Object.entries(v)
  if (entries.length > LIMITS.chatsPerPush) return bad(`${where}: at most ${LIMITS.chatsPerPush} chats`)
  const out: Record<string, number> = {}
  for (const [id, pts] of entries) {
    if (!isChatId(id) || !hasOwnPosition(id)) return bad(`${where}: "${id}" is not a supergroup's or a channel's id`)
    if (!isInt(pts) || pts < 0) return bad(`${where}.${id}: a whole number, zero or more`)
    out[id] = pts
  }
  return { ok: true, value: out }
}

/** The basic groups a push says were read back: chat ids of a group that is not a supergroup or a channel. */
function backRead(v: unknown): Parsed<string[]> {
  if (
    !Array.isArray(v) ||
    v.length > LIMITS.chatsPerPush ||
    !v.every((id) => isChatId(id) && isChatGroupId(id) && !hasOwnPosition(id))
  ) {
    return bad(`backRead: a list of at most ${LIMITS.chatsPerPush} basic groups' chat ids`)
  }
  return { ok: true, value: v as string[] }
}

/** The chats a push says were read again for their files: chat ids of any kind. */
function mediaRead(v: unknown): Parsed<string[]> {
  if (!Array.isArray(v) || v.length > LIMITS.chatsPerPush || !v.every((id) => isChatId(id))) {
    return bad(`mediaRead: a list of at most ${LIMITS.chatsPerPush} chat ids`)
  }
  return { ok: true, value: v as string[] }
}

function account(v: unknown): Parsed<{ id: string }> {
  if (!isObj(v) || !isTelegramId(v.id)) return bad('account.id: the Telegram user id the bridge is signed in as')
  return { ok: true, value: { id: v.id } }
}

function person(v: unknown, where: string): Parsed<TelegramPerson>
function person(v: unknown, where: string, botMayBeUnknown: true): Parsed<TelegramSender>
function person(v: unknown, where: string, botMayBeUnknown = false): Parsed<TelegramSender> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (!isTelegramId(v.id)) return bad(`${where}.id: a Telegram user id`)
  if (typeof v.name !== 'string' || v.name.length > LIMITS.name)
    return bad(`${where}.name: text, at most ${LIMITS.name} characters`)
  if (!(v.bot === undefined && botMayBeUnknown) && typeof v.bot !== 'boolean') return bad(`${where}.bot: true or false`)
  if (v.username !== undefined && (typeof v.username !== 'string' || v.username.length > LIMITS.name))
    return bad(`${where}.username: text`)
  if (v.phone !== undefined && (typeof v.phone !== 'string' || !/^[0-9]{5,15}$/.test(v.phone)))
    return bad(`${where}.phone: digits only`)
  return {
    ok: true,
    value: {
      id: v.id,
      name: v.name,
      ...(typeof v.bot === 'boolean' && { bot: v.bot }),
      ...(typeof v.username === 'string' && v.username !== '' && { username: v.username }),
      ...(typeof v.phone === 'string' && { phone: v.phone }),
    },
  }
}

function chat(v: unknown, where: string): Parsed<TelegramChat> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (!isChatId(v.id)) return bad(`${where}.id: a Telegram chat id`)
  if (v.kind !== 'user' && v.kind !== 'bot' && v.kind !== 'group' && v.kind !== 'channel')
    return bad(`${where}.kind: "user", "bot", "group" or "channel"`)
  if (typeof v.muted !== 'boolean') return bad(`${where}.muted: true or false`)
  if (v.archived !== undefined && typeof v.archived !== 'boolean') return bad(`${where}.archived: true or false`)
  if (v.readInboxMaxId !== undefined && !(isInt(v.readInboxMaxId) && v.readInboxMaxId >= 0))
    return bad(`${where}.readInboxMaxId: a message id`)
  const common = {
    muted: v.muted,
    ...(v.archived !== undefined && { archived: v.archived }),
    ...(v.readInboxMaxId !== undefined && { readInboxMaxId: v.readInboxMaxId }),
  }
  if (v.kind === 'group' || v.kind === 'channel') {
    if (!isChatGroupId(v.id)) return bad(`${where}.id: a group's or a channel's id starts with "-"`)
    if (v.kind === 'channel' && !hasOwnPosition(v.id)) return bad(`${where}.id: a channel's id starts with "-100"`)
    if (typeof v.title !== 'string' || v.title.length > LIMITS.name)
      return bad(`${where}.title: text, at most ${LIMITS.name} characters`)
    if (v.person !== undefined) return bad(`${where}.person: a group or a channel has no person`)
    return { ok: true, value: { id: v.id, kind: v.kind, title: v.title, ...common } }
  }
  if (isChatGroupId(v.id)) return bad(`${where}.id: a chat with a person is that person's id`)
  const who = person(v.person, `${where}.person`)
  if (!who.ok) return who
  if (who.value.id !== v.id) return bad(`${where}: a chat with a person is that person's id`)
  if (who.value.bot !== (v.kind === 'bot')) return bad(`${where}.kind: does not agree with person.bot`)
  if (v.title !== undefined) return bad(`${where}.title: only a group or a channel has a title`)
  return { ok: true, value: { id: v.id, kind: v.kind, person: who.value, ...common } }
}

function message(v: unknown, where: string): Parsed<TelegramMessage> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (!isChatId(v.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
  if (!isPosInt(v.id)) return bad(`${where}.id: a message id`)
  if (!isIso(v.at)) return bad(`${where}.at: an ISO time`)
  if (typeof v.out !== 'boolean') return bad(`${where}.out: true or false`)
  if (typeof v.text !== 'string' || v.text.length > LIMITS.text)
    return bad(`${where}.text: text, at most ${LIMITS.text} characters`)
  if (v.editedAt !== undefined && !isIso(v.editedAt)) return bad(`${where}.editedAt: an ISO time`)
  let sender: TelegramSender | undefined
  if (v.sender !== undefined) {
    if (!isChatGroupId(v.chatId)) return bad(`${where}.sender: only a message in a group has a sender`)
    const parsed = person(v.sender, `${where}.sender`, true)
    if (!parsed.ok) return parsed
    sender = parsed.value
  }
  if (v.mentionsMe !== undefined && typeof v.mentionsMe !== 'boolean') return bad(`${where}.mentionsMe: true or false`)
  if (v.replyTo !== undefined && !isPosInt(v.replyTo)) return bad(`${where}.replyTo: a message id`)
  let media: TelegramMedia | undefined
  if (v.media !== undefined) {
    const parsed = mediaOf(v.media, `${where}.media`)
    if (!parsed.ok) return parsed
    media = parsed.value
  }
  return {
    ok: true,
    value: {
      chatId: v.chatId,
      id: v.id,
      at: iso(v.at),
      out: v.out,
      text: v.text,
      ...(v.editedAt !== undefined && { editedAt: iso(v.editedAt) }),
      ...(sender && { sender }),
      ...(v.mentionsMe === true && { mentionsMe: true }),
      ...(v.replyTo !== undefined && { replyTo: v.replyTo }),
      ...(media && { media }),
    },
  }
}

/** A file's size as a declared number: a whole number of bytes, at most a terabyte (a 64-bit length is not needed to say "far too large"). */
const MEDIA_SIZE_MAX = 2 ** 40

function mediaOf(v: unknown, where: string): Parsed<TelegramMedia> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (typeof v.kind !== 'string' || !(TELEGRAM_MEDIA_KINDS as readonly string[]).includes(v.kind))
    return bad(`${where}.kind: ${TELEGRAM_MEDIA_KINDS.map((k) => `"${k}"`).join(', ')}`)
  if (v.size !== undefined && !(isInt(v.size) && v.size >= 0 && v.size <= MEDIA_SIZE_MAX))
    return bad(`${where}.size: a whole number of bytes`)
  if (
    v.mime !== undefined &&
    (typeof v.mime !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,80}$/.test(v.mime))
  )
    return bad(`${where}.mime: a media type`)
  if (v.seconds !== undefined && !(isInt(v.seconds) && v.seconds >= 0 && v.seconds <= 86_400 * 7))
    return bad(`${where}.seconds: a whole number of seconds`)
  return {
    ok: true,
    value: {
      kind: v.kind as TelegramMediaKind,
      ...(v.size !== undefined && { size: v.size as number }),
      ...(v.mime !== undefined && { mime: (v.mime as string).toLowerCase() }),
      ...(v.seconds !== undefined && { seconds: v.seconds as number }),
    },
  }
}

/** The `media` call's query: `?account=<id>&chat=<chat id>&id=<message id>`, each checked as the shape it is. */
export function parseMediaQuery(q: {
  account?: string | undefined
  chat?: string | undefined
  id?: string | undefined
}): Parsed<TelegramMediaQuery> {
  if (!isTelegramId(q.account)) return bad('account: the Telegram user id the bridge is signed in as')
  if (!isChatId(q.chat)) return bad('chat: a Telegram chat id')
  if (typeof q.id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(q.id)) return bad('id: a message id')
  return { ok: true, value: { account: q.account, chatId: q.chat, id: Number(q.id) } }
}

/** What the `picture` call names, in its query: the account, the send (the `messageId` the work offer gave) and the random id it was offered under. */
export interface TelegramPictureQuery {
  account: string
  messageId: string
  randomId: string
}

/** The `picture` call's query: `?account=<id>&message=<the offered messageId>&random=<the offered randomId>`, each checked as the shape it is. */
export function parsePictureQuery(q: {
  account?: string | undefined
  message?: string | undefined
  random?: string | undefined
}): Parsed<TelegramPictureQuery> {
  if (!isTelegramId(q.account)) return bad('account: the Telegram user id the bridge is signed in as')
  if (!isMessageId(q.message)) return bad('message: the id of the send the space offered')
  if (typeof q.random !== 'string' || !/^[1-9][0-9]{0,18}$/.test(q.random))
    return bad('random: the random id the send was offered under')
  return { ok: true, value: { account: q.account, messageId: q.message, randomId: q.random } }
}

export function parsePush(raw: unknown): Parsed<TelegramPush> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (raw.mirror !== undefined && typeof raw.mirror !== 'boolean') return bad('mirror: true or false')
  if (raw.live !== undefined && typeof raw.live !== 'boolean') return bad('live: true or false')
  if (!Array.isArray(raw.chats) || raw.chats.length > LIMITS.chatsPerPush)
    return bad(`chats: a list of at most ${LIMITS.chatsPerPush}`)
  if (!Array.isArray(raw.messages) || raw.messages.length > LIMITS.messagesPerPush)
    return bad(`messages: a list of at most ${LIMITS.messagesPerPush}`)
  const chats: TelegramChat[] = []
  for (const [i, c] of raw.chats.entries()) {
    const parsed = chat(c, `chats[${i}]`)
    if (!parsed.ok) return parsed
    chats.push(parsed.value)
  }
  const messages: TelegramMessage[] = []
  for (const [i, m] of raw.messages.entries()) {
    const parsed = message(m, `messages[${i}]`)
    if (!parsed.ok) return parsed
    messages.push(parsed.value)
  }
  let pos: TelegramPosition | undefined
  if (raw.position !== undefined) {
    const parsed = position(raw.position, 'position')
    if (!parsed.ok) return parsed
    pos = parsed.value
  }
  let positions: Record<string, number> | undefined
  if (raw.chatPositions !== undefined) {
    const parsed = chatPositions(raw.chatPositions, 'chatPositions')
    if (!parsed.ok) return parsed
    positions = parsed.value
  }
  const marks = readMarkers(raw)
  if (!marks.ok) return marks
  return {
    ok: true,
    value: {
      account: acct.value,
      ...(raw.mirror === true && { mirror: true }),
      ...(raw.live === true && raw.mirror !== true && { live: true }),
      chats,
      messages,
      ...(pos && { position: pos }),
      ...(positions && { chatPositions: positions }),
      ...marks.value,
    },
  }
}

/** The two lists of chats a push says it has read again (back to 30 days, and for their files), each only when present. */
function readMarkers(raw: Obj): Parsed<Pick<TelegramPush, 'backRead' | 'mediaRead'>> {
  const back = raw.backRead === undefined ? undefined : backRead(raw.backRead)
  if (back && !back.ok) return back
  const files = raw.mediaRead === undefined ? undefined : mediaRead(raw.mediaRead)
  if (files && !files.ok) return files
  return { ok: true, value: { ...(back && { backRead: back.value }), ...(files && { mediaRead: files.value }) } }
}

function edit(e: unknown, where: string): Parsed<TelegramEdit> {
  if (!isObj(e)) return bad(`${where}: an object`)
  if (!isChatId(e.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
  if (!isPosInt(e.id)) return bad(`${where}.id: a message id`)
  if (typeof e.text !== 'string' || e.text.length > LIMITS.text)
    return bad(`${where}.text: text, at most ${LIMITS.text} characters`)
  if (!isIso(e.at)) return bad(`${where}.at: an ISO time`)
  return { ok: true, value: { chatId: e.chatId, id: e.id, text: e.text, at: iso(e.at) } }
}

function deletion(d: unknown, where: string): Parsed<TelegramDeletion> {
  if (!isObj(d)) return bad(`${where}: an object`)
  if (d.chatId !== undefined && !isChatId(d.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
  if (!Array.isArray(d.ids) || d.ids.length === 0 || d.ids.length > LIMITS.idsPerDeletion || !d.ids.every(isPosInt)) {
    return bad(`${where}.ids: a list of 1 to ${LIMITS.idsPerDeletion} message ids`)
  }
  if (!isIso(d.at)) return bad(`${where}.at: an ISO time`)
  return {
    ok: true,
    value: { ...(d.chatId !== undefined && { chatId: d.chatId }), ids: d.ids as number[], at: iso(d.at) },
  }
}

/** Every item of a list through one parser, or the first problem. */
function each<T>(list: unknown[], name: string, parse: (item: unknown, where: string) => Parsed<T>): Parsed<T[]> {
  const out: T[] = []
  for (const [i, item] of list.entries()) {
    const parsed = parse(item, `${name}[${i}]`)
    if (!parsed.ok) return parsed
    out.push(parsed.value)
  }
  return { ok: true, value: out }
}

function readMark(r: unknown, where: string): Parsed<TelegramRead> {
  if (!isObj(r)) return bad(`${where}: an object`)
  if (!isChatId(r.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
  if (!isPosInt(r.upTo)) return bad(`${where}.upTo: a message id`)
  if (!isIso(r.at)) return bad(`${where}.at: an ISO time`)
  return { ok: true, value: { chatId: r.chatId, upTo: r.upTo, at: iso(r.at) } }
}

export function parseEvents(raw: unknown): Parsed<TelegramEvents> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (!Array.isArray(raw.edits) || raw.edits.length > LIMITS.eventsPerCall)
    return bad(`edits: a list of at most ${LIMITS.eventsPerCall}`)
  if (!Array.isArray(raw.deletions) || raw.deletions.length > LIMITS.eventsPerCall)
    return bad(`deletions: a list of at most ${LIMITS.eventsPerCall}`)
  const edits = each(raw.edits, 'edits', edit)
  if (!edits.ok) return edits
  const deletions = each(raw.deletions, 'deletions', deletion)
  if (!deletions.ok) return deletions
  if (raw.reads !== undefined && (!Array.isArray(raw.reads) || raw.reads.length > LIMITS.eventsPerCall))
    return bad(`reads: a list of at most ${LIMITS.eventsPerCall}`)
  const reads = raw.reads === undefined ? undefined : each(raw.reads as unknown[], 'reads', readMark)
  if (reads && !reads.ok) return reads
  let pos: TelegramPosition | undefined
  if (raw.position !== undefined) {
    const parsed = position(raw.position, 'position')
    if (!parsed.ok) return parsed
    pos = parsed.value
  }
  let positions: Record<string, number> | undefined
  if (raw.chatPositions !== undefined) {
    const parsed = chatPositions(raw.chatPositions, 'chatPositions')
    if (!parsed.ok) return parsed
    positions = parsed.value
  }
  return {
    ok: true,
    value: {
      account: acct.value,
      edits: edits.value,
      deletions: deletions.value,
      ...(reads && reads.value.length > 0 && { reads: reads.value }),
      ...(pos && { position: pos }),
      ...(positions && { chatPositions: positions }),
    },
  }
}

export function parseWorkRequest(raw: unknown): Parsed<TelegramWorkRequest> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (raw.newest !== undefined && typeof raw.newest !== 'boolean') return bad('newest: true or false')
  if (raw.media !== undefined && typeof raw.media !== 'boolean') return bad('media: true or false')
  if (raw.videoMax !== undefined && !isPosInt(raw.videoMax))
    return bad('videoMax: the most bytes of a video the bridge takes')
  if (raw.pictures !== undefined && typeof raw.pictures !== 'boolean') return bad('pictures: true or false')
  return {
    ok: true,
    value: {
      account: acct.value,
      ...(raw.newest === true && { newest: true }),
      ...(raw.media === true && { media: true }),
      ...(raw.media === true && typeof raw.videoMax === 'number' && { videoMax: raw.videoMax }),
      ...(raw.pictures === true && { pictures: true }),
    },
  }
}

const REASON = /^[A-Za-z0-9_ ().:-]{1,120}$/
/** An id the inbox made for a message: letters, digits and dashes, as every id of its own. */
const isMessageId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v)

function sendOutcome(o: Obj, where: string): Parsed<TelegramOutcome> {
  if (!isMessageId(o.messageId)) return bad(`${where}.messageId: the id of the message the space offered`)
  if (typeof o.randomId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(o.randomId))
    return bad(`${where}.randomId: the random id the send was offered under`)
  if (o.ok === true) {
    if (!isPosInt(o.telegramId)) return bad(`${where}.telegramId: the id of the message Telegram made`)
    if (!isIso(o.at)) return bad(`${where}.at: when Telegram took it (ISO)`)
    return {
      ok: true,
      value: {
        kind: 'send',
        messageId: o.messageId,
        randomId: o.randomId,
        ok: true,
        telegramId: o.telegramId,
        at: iso(o.at),
      },
    }
  }
  if (o.ok !== false) return bad(`${where}.ok: true or false`)
  if (typeof o.reason !== 'string' || !REASON.test(o.reason))
    return bad(`${where}.reason: the short answer Telegram gave, at most 120 plain characters`)
  return {
    ok: true,
    value: { kind: 'send', messageId: o.messageId, randomId: o.randomId, ok: false, reason: o.reason },
  }
}

function outcome(o: unknown, where: string): Parsed<TelegramOutcome> {
  if (!isObj(o)) return bad(`${where}: an object`)
  if (o.kind === 'send') return sendOutcome(o, where)
  if (o.kind === 'media') {
    if (!isChatId(o.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
    if (!isPosInt(o.id)) return bad(`${where}.id: a message id`)
    // A copy that worked is the upload's own answer; only a refusal is an outcome.
    if (o.ok !== false) return bad(`${where}.ok: false (a file that was copied is settled by its upload)`)
    if (typeof o.reason !== 'string' || !(TELEGRAM_MEDIA_REFUSALS as readonly string[]).includes(o.reason))
      return bad(`${where}.reason: "too-large", "gone" or "failed"`)
    return {
      ok: true,
      value: { kind: 'media', chatId: o.chatId, id: o.id, ok: false, reason: o.reason as TelegramMediaRefusal },
    }
  }
  if (o.kind !== 'read') return bad(`${where}.kind: "read", "send" or "media"`)
  if (!isChatId(o.chatId)) return bad(`${where}.chatId: a Telegram chat id`)
  if (!isPosInt(o.upTo)) return bad(`${where}.upTo: a message id`)
  if (o.ok === true) return { ok: true, value: { kind: 'read', chatId: o.chatId, upTo: o.upTo, ok: true } }
  if (o.ok !== false) return bad(`${where}.ok: true or false`)
  if (typeof o.reason !== 'string' || !REASON.test(o.reason))
    return bad(`${where}.reason: the short answer Telegram gave, at most 120 plain characters`)
  return { ok: true, value: { kind: 'read', chatId: o.chatId, upTo: o.upTo, ok: false, reason: o.reason } }
}

export function parseOutcomes(raw: unknown): Parsed<TelegramOutcomes> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length > LIMITS.outcomesPerCall)
    return bad(`outcomes: a list of at most ${LIMITS.outcomesPerCall}`)
  const outcomes = each(raw.outcomes, 'outcomes', outcome)
  if (!outcomes.ok) return outcomes
  return { ok: true, value: { account: acct.value, outcomes: outcomes.value } }
}

const STATES: readonly TelegramState[] = ['live', 'catching-up', 'signed-out']

export function parseStatus(raw: unknown): Parsed<TelegramStatusReport> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (typeof raw.state !== 'string' || !STATES.includes(raw.state as TelegramState))
    return bad('state: "live", "catching-up" or "signed-out"')
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !/^[A-Za-z0-9_ ().:-]{1,120}$/.test(raw.reason))) {
    return bad('reason: the short answer Telegram gave, at most 120 plain characters')
  }
  return {
    ok: true,
    value: {
      account: acct.value,
      state: raw.state as TelegramState,
      ...(typeof raw.reason === 'string' && { reason: raw.reason }),
    },
  }
}
