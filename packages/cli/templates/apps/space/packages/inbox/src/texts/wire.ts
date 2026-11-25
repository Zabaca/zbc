/**
 * What the texts bridge and the inbox say to each other: the one contract, owned by the inbox. The bridge (a program of the install's own, on a machine of its own, paired with the
 * owner's phone) restates it in its own language and a test of the install's holds the two to one parser. Zero dependencies and no I/O, so a Worker bundles it and the bridge's tests drive it.
 * The prose version, with an example of every call, is `docs/texts-bridge-wire.md`.
 *
 * ── THE FIVE CALLS ────────────────────────────────────────────────────────
 * The bridge's door serves five calls and nothing else (src/texts/app.ts), each a POST of one JSON object to `/api/<name>` under the door's path:
 *
 *   push      messages the phone told the bridge of (live) or the bridge read out of the phone's history (a first fill, a catch-up, a Bring back), with the chats they are in
 *   events    edits, deletions (counted, never applied) and read marks the phone told the bridge of
 *   work      what the bridge is owed: the chats left out, the newest message held per chat on request, and the reads the space asks for. It is also the heartbeat: the space stamps
 *             "checked in" from it at most once a minute
 *   outcomes  what became of the work it was owed (the read of a chat brought back), so the space stops offering it
 *   status    what the bridge says of itself: live, catching up, the phone not answering since a time, signed out, or another browser took the session
 *
 * A later version adds sends, read marks to the phone and files as new kinds of work and new calls; a bridge asks for them with a capability flag on its work request
 * (`sends`, `media`, `pictures`), and a flag this space does not know is ignored, so a newer bridge on an older space (or the reverse) is harmless. Items of a kind a bridge does
 * not know it ignores and never reports.
 *
 * ── A MESSAGE IS UNTRUSTED INPUT ──────────────────────────────────────────
 * Every string here is something a stranger wrote or a phone's contact list says. The parser bounds every size, checks every shape and keeps only the fields below (a field it does not
 * know is dropped, not refused, so a bridge may send more than the space reads yet). Nothing is interpreted. NOTHING IS KEPT OUT FOR ITS KIND: a business sender's text and a sign-in
 * code are carried like any other (the owner chose it), and a chat the owner left out is refused by the store, not here.
 */

/** How long a stranger's chat is read back when it is brought back to the space, and for the first fill: thirty days. */
export const TEXTS_FILL_DAYS = 30

/**
 * What kind of chat this is, as the bridge tells it from what the phone gives. `person` is a chat with one number (E.164); `short-code` a shortcode (3 to 8 digits); `named-sender` a sender that
 * has a name instead of a number (an alphanumeric sender id); `business` a business chat (an RCS business's verified sender); `group` a chat with several people. Every kind but `person` and
 * `group` is an automated sender: the inbox files it under Bulk. A business that texts from an ordinary phone number cannot be told from a person and is a `person`.
 */
export const TEXTS_CHAT_KINDS = ['person', 'short-code', 'named-sender', 'business', 'group'] as const
export type TextsChatKind = (typeof TEXTS_CHAT_KINDS)[number]

/** The kinds of chat that are an automated sender (filed under Bulk, never joined to a person). */
export const isAutomatedKind = (kind: TextsChatKind): boolean =>
  kind === 'short-code' || kind === 'named-sender' || kind === 'business'

/** Someone who wrote in a group, or the other side of a chat as a message names them. `address` is an E.164 number when the phone knows one; `name` is as the phone names them (may be empty). */
export interface TextsSender {
  address?: string
  name: string
}

/**
 * What the bridge knows of a chat a message is in.
 *
 * `id` is the bridge's own chat id, stable for the chat's life (the phone's conversation id), and the key the inbox finds the conversation by. `name` is the name the phone gives the chat
 * (a contact's name, else the number as the phone shows it, else the sender's name); it may be empty. `address` is the other side's identity, by kind: a `person`'s E.164 number
 * (`+` and 7 to 15 digits, the first not 0), a `short-code`'s digits, a `named-sender`'s name as the phone has it, a `business` chat's id; absent for a `group`. The inbox never joins a person by name:
 * the number is the join.
 */
export interface TextsChat {
  id: string
  kind: TextsChatKind
  name: string
  address?: string
  /** A group's members other than the owner, when the phone lists them (at most `LIMITS.members`). A later version reads them; today a group is refused whole and counted (`PushResult.groups`). */
  members?: TextsSender[]
}

export interface TextsMessage {
  chatId: string
  /** The phone's own id for the message, stable and unique in its chat. With the chat's id it is the message's key: a push repeated after a timeout stores one message. */
  id: string
  /** When the message was sent or received (ISO). */
  at: string
  /** The owner's own text (sent from their phone or from another of their devices). */
  out: boolean
  /** The text, or a short bracketed label for a message that has none or carries only a file (`[Photo]`, `[Voice note]`, `[Video]`, `[File]`, `[Contact]`, `[Location]`). Plain text. */
  text: string
  /** Whether the owner has read it on the phone. An `out` message is read. Used as the state the message is filed in (a fill carries the phone's state, a live text is normally unread). */
  read: boolean
  /** Who wrote it, when it is somebody else. Required for a message in a group; in a chat with one other side the inbox takes the sender from the chat and ignores this. */
  sender?: TextsSender
}

export interface TextsPush {
  account: { id: string }
  /**
   * `mirror` means HISTORY ONLY: the messages were read from the phone's history for the first fill or for a Bring back. Each is filed with the read state it carries and is filed closed on a conversation the
   * owner closed, so it never reopens one. Anything that may be news is pushed WITHOUT `mirror`, a catch-up of a gap in the live stream included: those texts are filed as they arrive (unread, open) and a text from
   * the other side reopens a closed conversation.
   */
  mirror?: boolean
  chats: TextsChat[]
  messages: TextsMessage[]
}

export interface TextsEdit {
  chatId: string
  id: string
  text: string
  /** When it was edited (ISO). */
  at: string
}

export interface TextsDeletion {
  chatId: string
  ids: string[]
  /** When the bridge heard of it (ISO). */
  at: string
}

/** The owner read a chat on the phone: every incoming message of the chat sent at or before `upTo` is read. It is never sent back to the phone and never marks anything unread. */
export interface TextsRead {
  chatId: string
  upTo: string
  /** When the bridge heard of it (ISO). */
  at: string
}

export interface TextsEvents {
  account: { id: string }
  edits: TextsEdit[]
  deletions: TextsDeletion[]
  reads?: TextsRead[]
}

export interface TextsWorkRequest {
  account: { id: string }
  /** Also answer the newest message held in every chat (what a reconnect's catch-up starts from). */
  newest?: boolean
  /** The bridge sends texts (a later version). Without it no send is ever offered. */
  sends?: boolean
  /** The bridge takes files (a later version). */
  media?: boolean
  /** The bridge sends pictures (a later version). */
  pictures?: boolean
}

/**
 * One thing the space owes the bridge. A `fill` is the Bring back of a chat that was left out: the bridge reads that chat's last `days` days from the phone and pushes them as a `mirror` (history only), then
 * reports the outcome. It is offered by every work request until an outcome (or a push that read it) settles it.
 */
export type TextsOwed = { kind: 'fill'; chatId: string; days: number }

/** The newest message the inbox holds of a chat: its id and its time, which is what the catch-up compares the phone's own listing against (ids are not ordered). */
export interface TextsNewest {
  id: string
  at: string
}

export interface TextsWork {
  /** The chats the owner left out, by the bridge's chat id: nothing of these is pushed, on any path (the fill, the catch-up, the live stream). Every work request answers the whole list. */
  leftOut: string[]
  /** The newest message held per chat id, only when asked for. */
  newest?: Record<string, TextsNewest>
  /** What the space owes the bridge, oldest first, at most `LIMITS.owedPerWork` at once. */
  owed: TextsOwed[]
}

/**
 * What became of one thing the bridge was owed. A fill that was read and pushed is `ok: true`; one the phone would not give carries the short answer (a code, never a message's text). Only the fill
 * of a chat that is owed settles; any other outcome is counted as unknown and changes nothing. A refusal is not the end of it: the space keeps the fill and offers it again after a pause.
 */
export type TextsOutcome =
  | { kind: 'fill'; chatId: string; ok: true }
  | { kind: 'fill'; chatId: string; ok: false; reason: string }

export interface TextsOutcomes {
  account: { id: string }
  outcomes: TextsOutcome[]
}

export interface OutcomesResult {
  /** Outcomes that settled something owed. */
  settled: number
  /** Outcomes that named nothing owed (already settled, or never owed). */
  unknown: number
}

/**
 * What the bridge says of itself. `live`: connected, nothing missing. `catching-up`: connected, reading what it missed. `phone-not-answering`: the library's own phone status says the phone is off or not
 * reachable (`since` says when, ISO). `signed-out`: Google ended the bridge's sign-in; only the owner can sign in again (`reason` is the short answer). `session-taken`: another browser took the
 * Messages for web session and the bridge is waiting to take it back.
 */
export const TEXTS_STATES = ['live', 'catching-up', 'phone-not-answering', 'signed-out', 'session-taken'] as const
export type TextsState = (typeof TEXTS_STATES)[number]

export interface TextsStatusReport {
  account: { id: string }
  state: TextsState
  /** For `phone-not-answering`, when the phone stopped answering (ISO); required there. */
  since?: string
  /** For `signed-out`, a short code for why. Never a message's text. */
  reason?: string
}

export interface PushResult {
  /** Messages stored by this push. */
  stored: number
  /** Messages the inbox already held (a push repeated after a timeout). */
  repeated: number
  /** Messages of chats the owner left out: not stored. */
  leftOut: number
  /** Messages of a group chat: not stored until groups are carried (a later version), and counted so the bridge can say so. */
  groups: number
  /** Messages that named a chat the push did not describe: not stored. */
  skipped: number
  /** The chat ids this push named that are left out, so a bridge that missed the list learns it from the answer. */
  leftOutChats: string[]
}

export interface EventsResult {
  edited: number
  /** Deletions heard and ignored: deleting a text on the phone changes nothing in the inbox, which keeps its own copy. */
  ignored: number
  /** Messages stamped read by this call's read marks. */
  read: number
  /** Edits and read marks that named a message or chat the inbox does not hold (older than the first fill, never carried, or left out). */
  unknown: number
}

// ─── the parser ────────────────────────────────────────────────────────

/** Bounds on a call, so one request can never be the whole store. A fill is sent in batches under these. */
export const LIMITS = {
  messagesPerPush: 500,
  chatsPerPush: 200,
  text: 20_000,
  name: 200,
  members: 256,
  eventsPerCall: 500,
  idsPerDeletion: 100,
  owedPerWork: 50,
  outcomesPerCall: 100,
  /** The most chats that may be left out at once: what the work request answers in full every time. */
  leftOut: 1_000,
  body: 2_000_000,
} as const

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = <T>(error: string): Parsed<T> => ({ ok: false, error })

const isIso = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v) &&
  !Number.isNaN(Date.parse(v))

/** An ISO time as the one spelling the store compares (UTC, milliseconds). */
export const iso = (v: string): string => new Date(v).toISOString()

/** An id of the bridge's own (the account, a chat, a message): letters, digits and `. _ = ~ -`, never a colon, so `<chat id>:<message id>` is one unambiguous key. */
export const TEXTS_ID = /^[A-Za-z0-9._=~-]{1,100}$/
const isId = (v: unknown): v is string => typeof v === 'string' && TEXTS_ID.test(v)
/** A number in E.164: a plus, then 7 to 15 digits, the first not zero. THE ONE PLACE its spelling is written. */
export const E164 = /^\+[1-9][0-9]{6,14}$/
/** A short code: 3 to 8 digits, no plus. */
export const SHORT_CODE = /^[0-9]{3,8}$/
/** Text with no control character (a name or an address a stranger or a phone made). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check that refuses them.
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the mending of them.
const CONTROL_RUN = /[\u0000-\u001f\u007f]+/g

function account(v: unknown): Parsed<{ id: string }> {
  if (!isObj(v) || !isId(v.id))
    return bad('account.id: the bridge’s own id for the paired phone (letters, digits and . _ = ~ -)')
  return { ok: true, value: { id: v.id } }
}

/**
 * A name as the phone gives it (a chat's or a sender's). A name is a label and never an identity, so a bad one is mended and not refused: a refused push would hold the whole batch up behind it. Control characters
 * become spaces, the white space is collapsed and the name is cut at `LIMITS.name` characters. Only something that is not text at all is refused.
 */
function nameOf(v: unknown, where: string): Parsed<string> {
  if (typeof v !== 'string') return bad(`${where}: text`)
  return { ok: true, value: v.replace(CONTROL_RUN, ' ').replace(/ {2,}/g, ' ').trim().slice(0, LIMITS.name) }
}

function sender(v: unknown, where: string): Parsed<TextsSender> {
  if (!isObj(v)) return bad(`${where}: an object`)
  const name = nameOf(v.name ?? '', `${where}.name`)
  if (!name.ok) return name
  if (v.address !== undefined && !(typeof v.address === 'string' && E164.test(v.address)))
    return bad(`${where}.address: an E.164 number such as +15555550123`)
  return { ok: true, value: { ...(v.address !== undefined && { address: v.address as string }), name: name.value } }
}

/** The address of a chat that is not a group, by its kind. */
function addressOf(kind: TextsChatKind, v: unknown, where: string): Parsed<string> {
  if (typeof v !== 'string') return bad(`${where}.address: the other side's identity, as text`)
  if (kind === 'person')
    return E164.test(v) ? { ok: true, value: v } : bad(`${where}.address: an E.164 number such as +15555550123`)
  if (kind === 'short-code')
    return SHORT_CODE.test(v) ? { ok: true, value: v } : bad(`${where}.address: a short code of 3 to 8 digits`)
  if (v.length < 1 || v.length > 100 || !NO_CONTROL.test(v))
    return bad(`${where}.address: the sender's name or the business chat's id, 1 to 100 characters`)
  return { ok: true, value: v }
}

function chat(v: unknown, where: string): Parsed<TextsChat> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (!isId(v.id)) return bad(`${where}.id: the bridge’s chat id`)
  if (typeof v.kind !== 'string' || !(TEXTS_CHAT_KINDS as readonly string[]).includes(v.kind))
    return bad(`${where}.kind: ${TEXTS_CHAT_KINDS.map((k) => `"${k}"`).join(', ')}`)
  const kind = v.kind as TextsChatKind
  const name = nameOf(v.name ?? '', `${where}.name`)
  if (!name.ok) return name
  if (kind === 'group') {
    if (v.address !== undefined) return bad(`${where}.address: a group has no address`)
    let members: TextsSender[] | undefined
    if (v.members !== undefined) {
      if (!Array.isArray(v.members) || v.members.length > LIMITS.members)
        return bad(`${where}.members: a list of at most ${LIMITS.members}`)
      members = []
      for (const [i, m] of v.members.entries()) {
        const parsed = sender(m, `${where}.members[${i}]`)
        if (!parsed.ok) return parsed
        members.push(parsed.value)
      }
    }
    return { ok: true, value: { id: v.id, kind, name: name.value, ...(members && { members }) } }
  }
  if (v.members !== undefined) return bad(`${where}.members: only a group has members`)
  const address = addressOf(kind, v.address, where)
  if (!address.ok) return address
  return { ok: true, value: { id: v.id, kind, name: name.value, address: address.value } }
}

function message(v: unknown, where: string): Parsed<TextsMessage> {
  if (!isObj(v)) return bad(`${where}: an object`)
  if (!isId(v.chatId)) return bad(`${where}.chatId: the bridge’s chat id`)
  if (!isId(v.id)) return bad(`${where}.id: the phone's own message id (letters, digits and . _ = ~ -)`)
  if (!isIso(v.at)) return bad(`${where}.at: an ISO time`)
  if (typeof v.out !== 'boolean') return bad(`${where}.out: true or false`)
  if (typeof v.text !== 'string' || v.text.length > LIMITS.text)
    return bad(`${where}.text: text, at most ${LIMITS.text} characters`)
  if (typeof v.read !== 'boolean') return bad(`${where}.read: true or false`)
  let who: TextsSender | undefined
  if (v.sender !== undefined) {
    const parsed = sender(v.sender, `${where}.sender`)
    if (!parsed.ok) return parsed
    who = parsed.value
  }
  return {
    ok: true,
    value: {
      chatId: v.chatId,
      id: v.id,
      at: iso(v.at),
      out: v.out,
      text: v.text,
      read: v.out || v.read,
      ...(who && !v.out && { sender: who }),
    },
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

export function parsePush(raw: unknown): Parsed<TextsPush> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (raw.mirror !== undefined && typeof raw.mirror !== 'boolean') return bad('mirror: true or false')
  if (!Array.isArray(raw.chats) || raw.chats.length > LIMITS.chatsPerPush)
    return bad(`chats: a list of at most ${LIMITS.chatsPerPush}`)
  if (!Array.isArray(raw.messages) || raw.messages.length > LIMITS.messagesPerPush)
    return bad(`messages: a list of at most ${LIMITS.messagesPerPush}`)
  const chats = each(raw.chats, 'chats', chat)
  if (!chats.ok) return chats
  const messages = each(raw.messages, 'messages', message)
  if (!messages.ok) return messages
  return {
    ok: true,
    value: {
      account: acct.value,
      ...(raw.mirror === true && { mirror: true }),
      chats: chats.value,
      messages: messages.value,
    },
  }
}

function edit(e: unknown, where: string): Parsed<TextsEdit> {
  if (!isObj(e)) return bad(`${where}: an object`)
  if (!isId(e.chatId)) return bad(`${where}.chatId: the bridge’s chat id`)
  if (!isId(e.id)) return bad(`${where}.id: the phone's own message id`)
  if (typeof e.text !== 'string' || e.text.length > LIMITS.text)
    return bad(`${where}.text: text, at most ${LIMITS.text} characters`)
  if (!isIso(e.at)) return bad(`${where}.at: an ISO time`)
  return { ok: true, value: { chatId: e.chatId, id: e.id, text: e.text, at: iso(e.at) } }
}

function deletion(d: unknown, where: string): Parsed<TextsDeletion> {
  if (!isObj(d)) return bad(`${where}: an object`)
  if (!isId(d.chatId)) return bad(`${where}.chatId: the bridge’s chat id`)
  if (!Array.isArray(d.ids) || d.ids.length === 0 || d.ids.length > LIMITS.idsPerDeletion || !d.ids.every(isId)) {
    return bad(`${where}.ids: a list of 1 to ${LIMITS.idsPerDeletion} message ids`)
  }
  if (!isIso(d.at)) return bad(`${where}.at: an ISO time`)
  return { ok: true, value: { chatId: d.chatId, ids: d.ids as string[], at: iso(d.at) } }
}

function readMark(r: unknown, where: string): Parsed<TextsRead> {
  if (!isObj(r)) return bad(`${where}: an object`)
  if (!isId(r.chatId)) return bad(`${where}.chatId: the bridge’s chat id`)
  if (!isIso(r.upTo)) return bad(`${where}.upTo: an ISO time`)
  if (!isIso(r.at)) return bad(`${where}.at: an ISO time`)
  return { ok: true, value: { chatId: r.chatId, upTo: iso(r.upTo), at: iso(r.at) } }
}

export function parseEvents(raw: unknown): Parsed<TextsEvents> {
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
  return {
    ok: true,
    value: {
      account: acct.value,
      edits: edits.value,
      deletions: deletions.value,
      ...(reads && reads.value.length > 0 && { reads: reads.value }),
    },
  }
}

export function parseWorkRequest(raw: unknown): Parsed<TextsWorkRequest> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  for (const flag of ['newest', 'sends', 'media', 'pictures'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') return bad(`${flag}: true or false`)
  }
  return {
    ok: true,
    value: {
      account: acct.value,
      ...(raw.newest === true && { newest: true }),
      ...(raw.sends === true && { sends: true }),
      ...(raw.media === true && { media: true }),
      ...(raw.pictures === true && { pictures: true }),
    },
  }
}

/** The short answer a phone or the library gave: plain characters, never a message's text. */
const REASON = /^[A-Za-z0-9_ ().:-]{1,120}$/

function outcome(o: unknown, where: string): Parsed<TextsOutcome> {
  if (!isObj(o)) return bad(`${where}: an object`)
  if (o.kind !== 'fill') return bad(`${where}.kind: "fill"`)
  if (!isId(o.chatId)) return bad(`${where}.chatId: the bridge’s chat id`)
  if (o.ok === true) return { ok: true, value: { kind: 'fill', chatId: o.chatId, ok: true } }
  if (o.ok !== false) return bad(`${where}.ok: true or false`)
  if (typeof o.reason !== 'string' || !REASON.test(o.reason))
    return bad(`${where}.reason: the short answer, at most 120 plain characters`)
  return { ok: true, value: { kind: 'fill', chatId: o.chatId, ok: false, reason: o.reason } }
}

export function parseOutcomes(raw: unknown): Parsed<TextsOutcomes> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length > LIMITS.outcomesPerCall)
    return bad(`outcomes: a list of at most ${LIMITS.outcomesPerCall}`)
  const outcomes = each(raw.outcomes, 'outcomes', outcome)
  if (!outcomes.ok) return outcomes
  return { ok: true, value: { account: acct.value, outcomes: outcomes.value } }
}

export function parseStatus(raw: unknown): Parsed<TextsStatusReport> {
  if (!isObj(raw)) return bad('Expected a JSON object body.')
  const acct = account(raw.account)
  if (!acct.ok) return acct
  if (typeof raw.state !== 'string' || !(TEXTS_STATES as readonly string[]).includes(raw.state))
    return bad(`state: ${TEXTS_STATES.map((s) => `"${s}"`).join(', ')}`)
  const state = raw.state as TextsState
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !REASON.test(raw.reason)))
    return bad('reason: a short answer, at most 120 plain characters')
  if (raw.since !== undefined && !isIso(raw.since)) return bad('since: an ISO time')
  if (state === 'phone-not-answering' && raw.since === undefined)
    return bad('since: required when the phone is not answering (an ISO time)')
  return {
    ok: true,
    value: {
      account: acct.value,
      state,
      ...(state === 'phone-not-answering' && typeof raw.since === 'string' && { since: iso(raw.since) }),
      ...(typeof raw.reason === 'string' && { reason: raw.reason }),
    },
  }
}
