// Calls in the space: what the page asks of the Worker about calls, and how meet behind it is asked.
//
// Each is ONE call to meet's entrypoint (`SpaceMeet`, packages/workspace/src/meet-for-space.ts) with the assertion this request arrived with, which meet
// verifies again against the space application's audience and then applies its own rules: who may start a huddle (anyone in the conversation), who sees
// a call (its maker, the people in its conversation, the people invited to a meeting), and the meter, which refuses new calls from 800 GB of the free
// 1,000 GB. The space decides nothing of that. Nothing is stored here, and NO LINK IS MADE HERE: every call arrives with its link, made by meet from its
// public address, and the page copies and opens it as it is, so a link copied in the space opens on the space's own /r/ path.
//
// READS wait `ANSWER_WITHIN_MS` and are `unreachable` when meet does not answer. WRITES (a huddle, a call link, a New call, a meeting) carry a compose key
// the page made once, wait `WRITE_WITHIN_MS` and are NEVER retried: one the space lost track of is `outcome-unknown`, and the page says so and offers no
// second try (a second try with the same key is harmless, since meet holds the key, but the page cannot know the key was used). A key meet already used
// answers the call the first use made, as `ok`: pressing twice is one call.
//
// MEET SENDS NO EMAIL FOR A MEETING. The invitation is text the page puts in the email being written (client/invite.ts); a person presses send in the
// inbox's send, with every rule it has.

import {
  ANSWER_WITHIN_MS,
  COMPOSE_KEY,
  type MeetBooking,
  type MeetCall,
  type MeetCallStart,
  type MeetHuddleStart,
  type MeetInvitee,
  type Reached,
  type ReachedWrite,
  type Repeated,
  WRITE_WITHIN_MS,
  normalizeAddress,
} from '@space/workspace'
import { isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { isMeetCall, isMeetCallChat, isMeetCallPage, isMeetCalls, isMeetPhone, isMeetRead, isMeetUsage, notConnected, reach, reachWrite } from './reach'
import { type ViewAnswer, answerOf } from './views'

export const MEET = 'Chat'

/** The names a read or a write of calls goes by, at `/api/meet/<name>`. */
export const MEET_READS = ['cards', 'calls', 'call', 'usage', 'phone'] as const
export const MEET_WRITES = ['huddle', 'call', 'meeting', 'delete-chat', 'phone-read'] as const
export type MeetRead = (typeof MEET_READS)[number]
export type MeetWrite = (typeof MEET_WRITES)[number]

export const MEET_PATH = /^\/api\/meet\/([a-z-]+)$/
export const meetName = (pathname: string): string | null => MEET_PATH.exec(pathname)?.[1] ?? null
export const isMeetWrite = (pathname: string): boolean => MEET_WRITES.includes(meetName(pathname) as MeetWrite)

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** A keyed write that made something (a call, a channel, an invitation): `ok` with it, whether this press made it or an earlier one with the same key did. Channel admin (channels.ts) uses it too. */
export function madeOne<T>(reached: ReachedWrite<T>, valid: (v: unknown) => v is T): ViewAnswer<T> {
  if (!reached.ok && reached.kind === 'refused' && reached.reason === 'repeated') {
    const earlier = (reached as Repeated<T>).earlier
    return earlier.state === 'done' && earlier.reply.ok && valid(earlier.reply.value)
      ? { result: 'ok', value: earlier.reply.value }
      : { result: 'outcome-unknown', message: 'Chat said this was already made, but not how it went.' }
  }
  return answerOf(reached)
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ms = (ask: Asking) => ask.answerWithinMs ?? ANSWER_WITHIN_MS

/** The most conversations and homes a card read names (meet's own bound). */
const CARDS_MOST = 20
const HOME_MAX = 320

export interface CardsWant {
  conversationIds: number[]
  homes: string[]
}

/** `?conversation=<n>&home=<key>&home=<key>`: the huddles of one chat conversation and the call links and meetings of the homes named. */
export function parseCards(params: URLSearchParams): Parsed<CardsWant> {
  const conversation = params.get('conversation')
  const conversationIds = conversation === null ? [] : /^\d{1,15}$/.test(conversation) ? [Number(conversation)] : null
  const homes = params.getAll('home')
  if (conversationIds === null || homes.length > CARDS_MOST || homes.some((h) => h === '' || h.length > HOME_MAX)) return { ok: false, message: 'Cards are asked for one conversation and up to twenty homes.' }
  return { ok: true, value: { conversationIds, homes: [...new Set(homes)] } }
}

export async function cards(ask: Asking, want: CardsWant): Promise<ViewAnswer<MeetCall[]>> {
  const { meet } = ask.apps
  if (want.conversationIds.length === 0 && want.homes.length === 0) return { result: 'ok', value: [] }
  return answerOf(await (meet ? reach(MEET, () => meet.cards(ask.signedIn, want), isMeetCalls, ms(ask)) : notConnected(MEET)))
}

/** `?after=<cursor>`: meet's own cursor, which the page hands back as it came. */
export function parseAfter(params: URLSearchParams): Parsed<string | undefined> {
  const after = params.get('after')
  if (after === null) return { ok: true, value: undefined }
  return /^\d{1,16}:[0-9a-z]{20}$/.test(after) ? { ok: true, value: after } : { ok: false, message: 'That is not a place in the list of calls.' }
}

export async function pastCalls(ask: Asking, after: string | undefined) {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.calls(ask.signedIn, after, 20), isMeetCallPage, ms(ask)) : notConnected(MEET)))
}

/** `?name=<call>`: a call's name is 20 letters and digits (meet's alphabet, with or without its dashes). */
export function parseName(params: URLSearchParams): Parsed<string> {
  const name = (params.get('name') ?? '').toLowerCase().replace(/-/g, '')
  return /^[0-9a-z]{20}$/.test(name) ? { ok: true, value: name } : { ok: false, message: 'That is not the name of a call.' }
}

export async function callChat(ask: Asking, name: string) {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.callChat(ask.signedIn, name), isMeetCallChat, ms(ask)) : notConnected(MEET)))
}

export async function usage(ask: Asking) {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.usage(ask.signedIn), isMeetUsage, ms(ask)) : notConnected(MEET)))
}

export async function phone(ask: Asking) {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.phoneConversation(ask.signedIn), isMeetPhone, ms(ask)) : notConnected(MEET)))
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const isKey = (v: unknown): v is string => typeof v === 'string' && COMPOSE_KEY.test(v)
export const KEY_WORDS = 'A write names a compose key of 16 to 128 letters, digits, "_" and "-".'
const TITLE_MAX = 80

export function parseHuddle(body: unknown): Parsed<MeetHuddleStart> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: KEY_WORDS }
  if (!isCount(body.conversationId)) return { ok: false, message: 'A huddle names the direct message or channel it is started in.' }
  return { ok: true, value: { key: body.key, conversationId: body.conversationId } }
}

export function parseCall(body: unknown): Parsed<MeetCallStart> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: KEY_WORDS }
  const home = body.home === undefined || body.home === null ? null : body.home
  if (home !== null && (!isText(home) || home === '' || home.length > HOME_MAX)) return { ok: false, message: 'A call link names the conversation it is for.' }
  if (body.title !== undefined && body.title !== null && (!isText(body.title) || body.title.length > TITLE_MAX)) return { ok: false, message: `A call's name is at most ${TITLE_MAX} characters.` }
  return { ok: true, value: { key: body.key, ...(home !== null && { home }), ...(isText(body.title) && body.title.trim() !== '' && { title: body.title }) } }
}

/** The people a meeting invites, as the page names them: a name, and an address when it has one. The address is spelled as the contract spells one. */
function parseInvitees(raw: unknown): Parsed<MeetInvitee[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!isList(raw) || raw.length > 20) return { ok: false, message: 'A meeting invites at most twenty people.' }
  const out: MeetInvitee[] = []
  for (const i of raw) {
    if (!isRecord(i) || !isText(i.name) || i.name.length > TITLE_MAX) return { ok: false, message: 'Each person invited has a name.' }
    const address = i.address === null || i.address === undefined ? null : isText(i.address) ? normalizeAddress(i.address) : undefined
    if (address === undefined || (i.address !== null && i.address !== undefined && address === null)) return { ok: false, message: 'An address invited is not an email address.' }
    out.push({ name: i.name, address })
  }
  return { ok: true, value: out }
}

export function parseMeeting(body: unknown): Parsed<MeetBooking> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: KEY_WORDS }
  if (!isText(body.title) || body.title.trim() === '' || body.title.length > TITLE_MAX) return { ok: false, message: 'A meeting needs a title of up to 80 characters.' }
  if (!isCount(body.startsAt)) return { ok: false, message: 'A meeting needs a time.' }
  const conversationId = body.conversationId === undefined || body.conversationId === null ? null : body.conversationId
  const home = body.home === undefined || body.home === null ? null : body.home
  if ((conversationId === null) === (home === null)) return { ok: false, message: 'A meeting is made in one conversation.' }
  if (conversationId !== null && !isCount(conversationId)) return { ok: false, message: 'A meeting names the direct message or channel it is made in.' }
  if (home !== null && (!isText(home) || home === '' || home.length > HOME_MAX)) return { ok: false, message: 'A meeting names the conversation it is made in.' }
  const invitees = parseInvitees(body.invitees)
  if (!invitees.ok) return invitees
  return {
    ok: true,
    value: { key: body.key, title: body.title, startsAt: body.startsAt, ...(conversationId !== null && { conversationId }), ...(home !== null && { home }), invitees: invitees.value },
  }
}

export const writeMs = (ask: Asking) => ask.writeWithinMs ?? WRITE_WITHIN_MS

export async function startHuddle(ask: Asking, start: MeetHuddleStart) {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return madeOne(await reachWrite(MEET, () => meet.startHuddle(ask.signedIn, start), isMeetCall, writeMs(ask)), isMeetCall)
}

export async function startCall(ask: Asking, start: MeetCallStart) {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return madeOne(await reachWrite(MEET, () => meet.startCall(ask.signedIn, start), isMeetCall, writeMs(ask)), isMeetCall)
}

export async function bookMeeting(ask: Asking, booking: MeetBooking) {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return madeOne(await reachWrite(MEET, () => meet.bookMeeting(ask.signedIn, booking), isMeetCall, writeMs(ask)), isMeetCall)
}

/** A call's saved chat is deleted by the owner alone, and not while anyone is in the call (meet decides). Idempotent: no key. */
export async function deleteChat(ask: Asking, name: string): Promise<ViewAnswer<{ deleted: number }>> {
  const { meet } = ask.apps
  const got: Reached<{ deleted: number }> = meet ? await reach(MEET, () => meet.deleteCallChat(ask.signedIn, name), (v): v is { deleted: number } => isRecord(v) && isCount(v.deleted), writeMs(ask)) : notConnected(MEET)
  return answerOf(got)
}

/** The Phone conversation read up to an item. Idempotent: no key. */
export async function phoneRead(ask: Asking, upTo: number): Promise<ViewAnswer<{ upTo: number }>> {
  const { meet } = ask.apps
  const got = meet ? await reach(MEET, () => meet.phoneRead(ask.signedIn, upTo), isMeetRead, writeMs(ask)) : notConnected(MEET)
  return got.ok ? { result: 'ok', value: { upTo: got.value.upTo } } : answerOf(got)
}
