// Messages and a person's own settings in the space (they replace meet's old /start page): the people a first direct message can go to,
// editing and deleting a message, the unread count the tab's title shows, and a person's own name, nudge and privacy note. What the page asks of the Worker, and how meet behind
// it is asked.
//
// Each is ONE call to meet's entrypoint (`SpaceMeet`, packages/workspace/src/meet-for-space.ts) with the assertion this request arrived with, which meet verifies again against the
// space application's audience and then applies /start's own rules, in its own words: you edit only your own message, the owner deletes another's, a message in a conversation
// you are not in is "no such message", a name is not empty, the nudge is a boolean. The space decides none of that, and draws Edit and Delete only where meet's `may` on the message
// says so. Nothing is stored here.
//
// THE FIRST MESSAGE TO SOMEONE is not a write of its own: it is `/api/chat` with `personId` (conversation.ts), which meet opens the direct message for as it posts, once per compose key.
// This file only says who the person may write to (`people`).
//
// READS wait `ANSWER_WITHIN_MS`. WRITES wait `WRITE_WITHIN_MS` and are NEVER retried: one the space lost track of is `outcome-unknown`, and the page says so. None carries a compose
// key: editing to the same words, setting a setting and acknowledging a note are the same once as twice, and deleting twice is a refusal the second time.
//
// The routes are `/api/meet/people`, `/api/meet/me` and `/api/meet/unread` (GET), and `/api/meet/message-edit`, `/message-delete`, `/me-update` and `/privacy-ack` (POST, through the
// space's one POST guard in app.ts: this host's Origin and a JSON body).

import type { MeetDeleted, MeetEdit, MeetMe, MeetMePatch, MeetMessage, MeetOverview, MeetReachable } from '@space/workspace'
import { MEET, MEET_PATH, type Parsed, ms, writeMs } from './calls'
import { isBool, isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { isMeetMessage, isMeetOverview, isMeetPerson, notConnected, reach, reachWrite } from './reach'
import { type ViewAnswer, answerOf } from './views'

export const CHAT_WRITES = ['message-edit', 'message-delete', 'me-update', 'privacy-ack'] as const
export type ChatWrite = (typeof CHAT_WRITES)[number]

export const isChatWrite = (pathname: string): boolean => CHAT_WRITES.includes((MEET_PATH.exec(pathname)?.[1] ?? '') as ChatWrite)

// ── The shapes read from meet's answers ──────────────────────────────────────────────────────────────────────────────────────

export const isMeetReachables = (v: unknown): v is MeetReachable[] => isList(v) && v.every((r) => isRecord(r) && isMeetPerson(r.person) && isBool(r.direct))
export const isMeetDeleted = (v: unknown): v is MeetDeleted => isRecord(v) && isCount(v.conversationId) && isCount(v.messageId)
export const isMeetMe = (v: unknown): v is MeetMe => isRecord(v) && isMeetPerson(v.person) && isBool(v.owner) && isBool(v.nudgesOff) && isBool(v.privacyAcked)

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The people the person may start a direct message with, or already has one with: meet's list, as it is. */
export async function people(ask: Asking): Promise<ViewAnswer<MeetReachable[]>> {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.peopleToMessage(ask.signedIn), isMeetReachables, ms(ask)) : notConnected(MEET)))
}

/** The person's own settings. */
export async function me(ask: Asking): Promise<ViewAnswer<MeetMe>> {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.me(ask.signedIn), isMeetMe, ms(ask)) : notConnected(MEET)))
}

/** What the browser tab's title counts: every message from someone else the person has not read, in direct messages, channels and the Phone conversation (as /start's title did). */
export interface ChatUnread {
  unread: number
}

export const unreadIn = (o: Pick<MeetOverview, 'direct' | 'channels' | 'phone'>): number =>
  o.direct.reduce((n, d) => n + d.unread, 0) + o.channels.reduce((n, c) => n + c.unread, 0) + (o.phone?.unread ?? 0)

/** The count over meet's overview: one read, and the sum is made here so the page asks for a number and not for everyone's conversations. */
export async function unread(ask: Asking): Promise<ViewAnswer<ChatUnread>> {
  const { meet } = ask.apps
  const got = await (meet ? reach(MEET, () => meet.conversations(ask.signedIn), isMeetOverview, ms(ask)) : notConnected(MEET))
  return answerOf(got.ok ? { ok: true as const, value: { unread: unreadIn(got.value) } } : got)
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Far past any message or name meet would take; meet cleans and limits them (a message to 2,000 characters, a name to 40). The space only refuses what is clearly not one. */
const TEXT_MAX = 10_000
const NAME_MAX = 200

export function parseEdit(body: unknown): Parsed<MeetEdit> {
  if (!isRecord(body) || !isCount(body.messageId)) return { ok: false, message: 'Name the message to edit.' }
  if (!isText(body.text)) return { ok: false, message: 'A message needs words.' }
  if (body.text.length > TEXT_MAX) return { ok: false, message: 'A message is at most 2,000 characters.' }
  return { ok: true, value: { messageId: body.messageId, text: body.text } }
}

export function parseDelete(body: unknown): Parsed<number> {
  return isRecord(body) && isCount(body.messageId) ? { ok: true, value: body.messageId } : { ok: false, message: 'Name the message to delete.' }
}

/** A name, a boolean, or both. A nudge that is not a boolean is refused here as it is at meet: it must never be read as "on". */
export function parseMeUpdate(body: unknown): Parsed<MeetMePatch> {
  if (!isRecord(body)) return { ok: false, message: 'Say what to change.' }
  const patch: MeetMePatch = {}
  if (body.name !== undefined) {
    if (!isText(body.name)) return { ok: false, message: 'Your name cannot be empty.' }
    if (body.name.length > NAME_MAX) return { ok: false, message: 'A name is one line of at most 40 characters.' }
    patch.name = body.name
  }
  if (body.nudgesOff !== undefined) {
    if (!isBool(body.nudgesOff)) return { ok: false, message: 'The email is on or off.' }
    patch.nudgesOff = body.nudgesOff
  }
  return patch.name === undefined && patch.nudgesOff === undefined ? { ok: false, message: 'Say what to change.' } : { ok: true, value: patch }
}

export async function editMessage(ask: Asking, edit: MeetEdit): Promise<ViewAnswer<MeetMessage>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return answerOf(await reachWrite(MEET, async () => meet.editMessage(ask.signedIn, edit), isMeetMessage, writeMs(ask)))
}

export async function deleteMessage(ask: Asking, messageId: number): Promise<ViewAnswer<MeetDeleted>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return answerOf(await reachWrite(MEET, async () => meet.deleteMessage(ask.signedIn, messageId), isMeetDeleted, writeMs(ask)))
}

export async function updateMe(ask: Asking, patch: MeetMePatch): Promise<ViewAnswer<MeetMe>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return answerOf(await reachWrite(MEET, async () => meet.updateMe(ask.signedIn, patch), isMeetMe, writeMs(ask)))
}

export async function acknowledgePrivacy(ask: Asking): Promise<ViewAnswer<MeetMe>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return answerOf(await reachWrite(MEET, async () => meet.acknowledgePrivacy(ask.signedIn), isMeetMe, writeMs(ask)))
}
