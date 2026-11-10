// Channel admin in the space (the retirement of meet's old /start page): New channel, Invite a guest, Archive, and the channel's people, a guest's access, Join, Leave
// and Rename. What the page asks of the Worker, and how meet behind it is asked.
//
// Each is ONE call to meet's entrypoint (`SpaceMeet`, packages/workspace/src/meet-for-space.ts) with the assertion this request arrived with, which meet verifies again
// against the space application's audience and then applies its own rules, in its own words: who may make a channel, who may archive one (its maker, and the owner),
// who may remove a guest (the owner, or the teammate who invited them), what a person outside a channel is told (nothing). The space decides none of that, and draws a
// button only where meet's `may` says the person may. Nothing is stored here.
//
// READS (the channel's people, the open channels to browse) wait `ANSWER_WITHIN_MS`. WRITES wait `WRITE_WITHIN_MS` and are NEVER retried: one the space lost track of is
// `outcome-unknown`, and the page says so. A channel made and a guest invited carry a COMPOSE KEY the page made for that press; meet holds it, so pressing twice is one
// channel and ONE EMAIL. The invitation is the only email this Worker can cause, and it is meet that sends it, from meet@northfield.example, when a teammate presses Invite; it
// links to space.northfield.example/w/, the guest's own door (a path of the space that needs no sign-in, ADR 0018). A guest never reaches the team's side of the space.
//
// The routes are `/api/meet/channel` and `/api/meet/browse` (GET), and `/api/meet/channel-create`, `/api/meet/channel-invite` and `/api/meet/channel-change` (POST, through the
// space's one POST guard in app.ts: this host's Origin and a JSON body).

import {
  ANSWER_WITHIN_MS,
  COMPOSE_KEY,
  MEET_CHANNEL_DOS,
  type MeetBrowsable,
  type MeetChanged,
  type MeetChannelChange,
  type MeetChannelDetail,
  type MeetChannelMake,
  type MeetGuestInvite,
  type MeetInvited,
  type MeetMember,
  normalizeAddress,
} from '@space/workspace'
import { KEY_WORDS, MEET, MEET_PATH, type Parsed, isKey, madeOne, ms, writeMs } from './calls'
import { isBool, isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { isMeetPerson, notConnected, reach, reachWrite } from './reach'
import { type ViewAnswer, answerOf } from './views'

export const CHANNEL_WRITES = ['channel-create', 'channel-invite', 'channel-change'] as const
export type ChannelWrite = (typeof CHANNEL_WRITES)[number]

export const isChannelWrite = (pathname: string): boolean => CHANNEL_WRITES.includes((MEET_PATH.exec(pathname)?.[1] ?? '') as ChannelWrite)

// ── The shapes read from meet's answers ──────────────────────────────────────────────────────────────────────────────────────

const isMay = (v: unknown, keys: readonly string[]): boolean => isRecord(v) && keys.every((k) => isBool(v[k]))

const isMember = (v: unknown): v is MeetMember =>
  isRecord(v) && isMeetPerson(v.person) && isBool(v.invited) && isBool(v.you) && isBool(v.direct) && isMay(v.may, ['takeOut', 'removeFromWorkspace', 'deleteEverything'])

export function isMeetChannelDetail(v: unknown): v is MeetChannelDetail {
  return (
    isRecord(v) &&
    isCount(v.conversationId) &&
    isText(v.name) &&
    (v.privacy === 'open' || v.privacy === 'private') &&
    isBool(v.createdByMe) &&
    isList(v.members) &&
    v.members.every(isMember) &&
    isList(v.addable) &&
    v.addable.every(isMeetPerson) &&
    isMay(v.may, ['rename', 'leave', 'archive', 'add', 'invite'])
  )
}

const isBrowsable = (v: unknown): v is MeetBrowsable => isRecord(v) && isCount(v.conversationId) && isText(v.name) && isCount(v.memberCount)
export const isMeetBrowsables = (v: unknown): v is MeetBrowsable[] => isList(v) && v.every(isBrowsable)
export const isMeetInvited = (v: unknown): v is MeetInvited => isRecord(v) && isCount(v.conversationId) && isMeetPerson(v.person) && isBool(v.mailed)
export const isMeetChanged = (v: unknown): v is MeetChanged => isRecord(v) && isCount(v.conversationId) && (v.channel === null || isMeetChannelDetail(v.channel))

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `?conversation=<n>`: the channel whose people are asked for. */
export function parseChannelQuery(params: URLSearchParams): Parsed<number> {
  const id = params.get('conversation')
  return id !== null && /^\d{1,15}$/.test(id) ? { ok: true, value: Number(id) } : { ok: false, message: 'Ask for one channel by its number.' }
}

export async function channelOf(ask: Asking, conversationId: number): Promise<ViewAnswer<MeetChannelDetail>> {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.channel(ask.signedIn, conversationId), isMeetChannelDetail, ms(ask)) : notConnected(MEET)))
}

export async function browse(ask: Asking): Promise<ViewAnswer<MeetBrowsable[]>> {
  const { meet } = ask.apps
  return answerOf(await (meet ? reach(MEET, () => meet.browseChannels(ask.signedIn), isMeetBrowsables, ms(ask)) : notConnected(MEET)))
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Far past any name or address meet would take; meet cleans and limits them (a name to 40 characters, an address to 254). The space only refuses what is clearly not one. */
const NAME_MAX = 200
const ADDRESS_MAX = 254

export function parseCreate(body: unknown): Parsed<MeetChannelMake> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: KEY_WORDS }
  if (!isText(body.name) || body.name.length > NAME_MAX) return { ok: false, message: 'Give the channel a name.' }
  if (body.privacy !== 'open' && body.privacy !== 'private') return { ok: false, message: 'A channel is open or private.' }
  return { ok: true, value: { key: body.key, name: body.name, privacy: body.privacy } }
}

export function parseInvite(body: unknown): Parsed<MeetGuestInvite> {
  if (!isRecord(body) || !isKey(body.key)) return { ok: false, message: KEY_WORDS }
  if (!isCount(body.conversationId)) return { ok: false, message: 'Invite a guest into one channel.' }
  if (!isText(body.name) || body.name.length > NAME_MAX) return { ok: false, message: 'Give the guest a name.' }
  // The address is spelled as the contract spells one; whether it is a teammate's of this install is meet's to say.
  const address = isText(body.address) && body.address.length <= ADDRESS_MAX ? normalizeAddress(body.address) : null
  if (address === null) return { ok: false, message: 'That does not look like an email address.' }
  return { ok: true, value: { key: body.key, conversationId: body.conversationId, name: body.name, address } }
}

export function parseChange(body: unknown): Parsed<MeetChannelChange> {
  if (!isRecord(body) || !isCount(body.conversationId) || !(MEET_CHANNEL_DOS as readonly unknown[]).includes(body.do)) return { ok: false, message: 'A change names a channel and what to do.' }
  const conversationId = body.conversationId
  switch (body.do) {
    case 'join':
    case 'leave':
    case 'archive':
      return { ok: true, value: { do: body.do, conversationId } }
    case 'rename':
      return isText(body.name) && body.name.length <= NAME_MAX ? { ok: true, value: { do: 'rename', conversationId, name: body.name } } : { ok: false, message: 'Give the channel a name.' }
    default:
      return isText(body.personId) && /^[A-Za-z0-9_-]{1,64}$/.test(body.personId)
        ? { ok: true, value: { do: body.do as 'add' | 'take-out' | 'remove-guest' | 'delete-person', conversationId, personId: body.personId } }
        : { ok: false, message: 'Name the person.' }
  }
}

export async function createChannel(ask: Asking, make: MeetChannelMake): Promise<ViewAnswer<MeetChannelDetail>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return madeOne(await reachWrite(MEET, () => meet.createChannel(ask.signedIn, make), isMeetChannelDetail, writeMs(ask)), isMeetChannelDetail)
}

/** Invite a guest: meet adds them and sends the invitation, once per key. `mailed` says whether the email left. */
export async function inviteGuest(ask: Asking, invite: MeetGuestInvite): Promise<ViewAnswer<MeetInvited>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return madeOne(await reachWrite(MEET, () => meet.inviteGuest(ask.signedIn, invite), isMeetInvited, writeMs(ask)), isMeetInvited)
}

/** A change to a channel, in meet's rules and words. Needs no key: repeating it does the same again or is refused. Never retried. */
export async function changeChannel(ask: Asking, change: MeetChannelChange): Promise<ViewAnswer<MeetChanged>> {
  const { meet } = ask.apps
  if (!meet) return answerOf(notConnected(MEET))
  return answerOf(await reachWrite(MEET, async () => meet.changeChannel(ask.signedIn, change), isMeetChanged, writeMs(ask)))
}
