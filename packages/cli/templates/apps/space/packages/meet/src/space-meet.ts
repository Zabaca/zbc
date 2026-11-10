// What meet answers the space: `SpaceMeet`'s methods, over the Workspace object, to the interface the company layer fixed
// (packages/workspace/src/meet-for-space.ts, and docs/adr/0001 beside it). The class that binds them to a service binding is
// `SpaceMeet` in index.ts; this file is everything it does, with the externals passed in, so `bun test` drives it with the real
// core and no Workers runtime.
//
// THIS RUNS INSIDE THE SPACE'S WORKER (the company layer's ADR 0003). Every method is handed the
// person the space's ONE sign-in check named (`SignedIn`); nothing here verifies an assertion, holds an audience or fetches Access's keys, and a method cannot be called without a
// person that check made.
//
// EVERY METHOD does one thing. Ask the
// Workspace object as `{ via: 'access', email }`, the teammate actor the core's rules are written for, so meet's own rules decide what
// that person sees: the direct messages they are in and the channels they belong to, nothing else (workspace.ts, "What the space
// asks"). The answer is data, a `SpaceReply`: meet's refusals (`RoomError`) become the contract's reasons, anything else becomes
// `broken`, and nothing is thrown across the binding.
//
// ADDRESSES in an answer all went through `normalizeAddress`, and a message's snippet is cut to the contract's `SNIPPET_CHARS`.
//
// CALLS: a call's Room, the ledger's index and the workspace's record of what it is for are three places (calls.ts makes one across
// them); this file turns them into the contract's `MeetCall`. EVERY LINK is made from `appOrigin` (meet's public address), never from anything the
// request carried, so a link copied in the space opens on the space's /r/ path. meet SENDS NO EMAIL FOR A CALL: a meeting's invitation is text the space puts
// in the email being written.
//
// MESSAGES AND A PERSON'S OWN SETTINGS: the people a first direct message can go to, editing and deleting a message, and the person's name, nudge and privacy note.
// The Workspace core's own methods, asked as the same teammate. A message is edited or deleted only in a conversation the person is in, and any other is "no such message", word for word.
//
// CHANNEL ADMIN (meet has no start page for people any more): the channel's people, New channel, Invite a guest, Join, Leave, Rename, Archive and a guest's access. Meet's rules are the
// Workspace's own, called as the teammate who is asking. The ONE EMAIL meet sends for the space is `inviteGuest`'s invitation to a guest, from meet@northfield.example, which
// links to space.northfield.example/w/ (the guest's own door, a path of the space that needs no sign-in); it goes out when a teammate presses Invite, once per compose key.

import {
  type Install,
  type Person,
  MEET_BOOKMARK,
  MEET_FOR_SPACE_FETCH_PREFIXES,
  MEET_OBJECTS,
  type MeetBookmark,
  type MeetCounts,
  type MeetObject,
  type MeetRestarted,
  type MeetRestoring,
  type MeetCall,
  type MeetCallChat,
  type MeetCallPage,
  type MeetCallRef,
  type MeetCallStart,
  type MeetCardsWant,
  type MeetBooking,
  type MeetBrowsable,
  type MeetChanged,
  type MeetChannel,
  type MeetChannelChange,
  type MeetChannelDetail,
  type MeetChannelMake,
  type MeetGuestInvite,
  type MeetInvited,
  type MeetMember,
  type MeetDirect,
  type MeetEdit,
  type MeetHuddleStart,
  type MeetPhone,
  type MeetPhoneItem,
  type MeetRead as MeetReadT,
  type MeetUsage,
  type MeetForSpace,
  type MeetHistory,
  type MeetLiveCall,
  type MeetMessage,
  type MeetMessageMay,
  type MeetDeleted,
  type MeetMe,
  type MeetReachable,
  type MeetNewest,
  type MeetOverview,
  type MeetPerson,
  type MeetPosted,
  type MeetPost,
  type MeetRead,
  NOT_ADMITTED,
  NOT_SIGNED_IN,
  type Refused,
  type RefusalReason,
  SNIPPET_CHARS,
  type SignedIn,
  type SpaceReply,
  type WriteReply,
  answered,
  failed,
  normalizeAddress,
  refused,
  repeated,
} from '@space/workspace'
import { type CallSpec, callLink, makeKeyedCall, meterOf } from './calls'
import { type Mailer, inviteEmail } from './mail'
import { displayName, normalizeRoomName } from './model'
import { RoomError, type RoomClient } from './room'
import type { Actor, WorkspaceClient } from './workspace'
import {
  type CallRecordRaw,
  type SpaceCallRaw,
  type SpaceCallWhy,
  type SpaceChangeRaw,
  type SpaceMeRaw,
  type SpaceChannelDetailRaw,
  type SpaceMemberRaw,
  type SpacePerson,
  type WMessage,
} from './workspace-model'

/** What a call, the phone or the Phone conversation says where the install's switch for it is off. */
export const CALLS_OFF = 'Calls are not turned on in this space.'
export const PHONE_OFF = 'The phone is not turned on in this space.'

/** An object's three operator methods (src/do.ts, src/workspace-do.ts), as a stub answers them. */
export interface StoreObject {
  bookmark(): Promise<string>
  restoreTo(bookmark: string): Promise<string>
  /** Always ends with the object reset under the caller: an error is the expected answer. */
  restart(): Promise<void>
  counts(): Promise<Record<string, number>>
}

/** What `spaceMeet` needs from the Worker: the people and the audience to check against, the Workspace object, the clock and randomness. */
export interface SpaceMeetDeps {
  /** The company this Worker serves (packages/workspace): who the people are. */
  install: Install
  workspace(): WorkspaceClient
  /** A call's own Room, and the ledger instance that indexes the calls (`liveCalls`). */
  room(name: string): RoomClient
  ledger(): RoomClient
  /** One of the two long-lived objects, for the operator's bookmark, restart and restore. Absent: they answer `broken`. */
  object?(which: MeetObject): StoreObject
  /** The space's address, the install's space host (`appOriginOf`, wiring.ts): the only address a call link or the guest's door in an invitation is made from. */
  appOrigin: string
  /**
   * What sends the one email the space can cause: a guest's invitation (`inviteGuest`), from meet@northfield.example. Nothing else here sends mail, and this is called
   * only inside that method, once per compose key.
   */
  mailer: Mailer
  now(): number
  randomBytes(n: number): Uint8Array
}

// ── Reading a core's answer ───────────────────────────────────────────────────────────────────────────────────────────────

const REASONS: Record<number, RefusalReason | 'broken'> = {
  400: 'bad-request',
  401: 'not-signed-in',
  403: 'not-admitted',
  404: 'not-found',
  409: 'conflict',
  429: 'limit',
  502: 'broken',
}

/** meet's own refusal, as the contract's: the words are meet's (they are written for the person), the reason is the status's. */
function fromRoomError(err: RoomError): Refused | ReturnType<typeof failed> {
  const reason = REASONS[err.status] ?? 'broken'
  if (reason === 'broken') return failed(err.message)
  return refused(reason, reason === 'not-signed-in' ? NOT_SIGNED_IN : err.message)
}

/**
 * Run `ask` as the person the space's check named. A refusal of meet's is a refusal and any other fault is `broken`, so a
 * read never throws.
 *
 * A WRITE passes `unknownIsThrown`: `broken` promises that nothing went out, and a fault on the hop to the Workspace object
 * (the object resetting during a deploy, a transport error) can arrive AFTER the write committed. So for a write only, a fault
 * from `ask` that is not meet's own refusal is thrown, and the space, which loses track of a write that threw, reads it
 * as `outcome-unknown` and never offers a retry.
 */
async function asAsker<T>(
  d: SpaceMeetDeps,
  asker: SignedIn,
  ask: (actor: Actor, endsAt: number, person: Person) => Promise<T>,
  opts: { unknownIsThrown?: boolean } = {},
): Promise<SpaceReply<T>> {
  // The one rule meet keeps for itself about who is asking, after the space's check: the person is a teammate, one of this install's people. The check always names one, so a request
  // never reaches this; it keeps a channel guest or a stranger out whatever called, in the words the space has always shown.
  if (d.install.personBySignIn(asker.person.signIn) === null) return refused('not-admitted', NOT_ADMITTED)
  try {
    // The address that names the person here: the teammate actor's email, as the core's rules read it.
    return answered(await ask({ via: 'access', email: asker.person.address }, asker.exp * 1000, asker.person))
  } catch (err) {
    if (err instanceof RoomError) return fromRoomError(err)
    console.error('space ask failed', err instanceof Error ? err.message : String(err))
    if (opts.unknownIsThrown) throw err
    return failed('Chat could not answer.')
  }
}

/**
 * A WRITE that carries a compose key: `ask` answers the value and whether the key had been used already. A repeat is `Repeated` with the first answer (nothing was
 * done again); everything else is `asAsker`'s, with `unknownIsThrown` (a fault after the Workspace may have committed is thrown, never answered `broken`).
 */
async function keyedWrite<T>(
  d: SpaceMeetDeps,
  asker: SignedIn,
  ask: (actor: Actor, endsAt: number, person: Person) => Promise<{ repeated: boolean; value: T }>,
): Promise<WriteReply<T>> {
  // The raw answer is read inside, so a repeat can be told from a first use before it is wrapped.
  let repeat = false as boolean
  const first = await asAsker(
    d,
    asker,
    async (actor, endsAt, person): Promise<T> => {
      const got = await ask(actor, endsAt, person)
      repeat = got.repeated
      return got.value
    },
    { unknownIsThrown: true },
  )
  return repeat && first.ok ? repeated({ state: 'done', reply: first }) : first
}

/**
 * The operator's four: the install's owner's, on one of the two long-lived objects. Nothing it throws leaves as an exception: a fault is `broken`, which for a restart and a restore is
 * not "nothing happened" (the object may have been reset under the call), so the sitting reads the Worker's log and the counts, not this answer, for what was done.
 */
async function asOwnerOn<T>(
  d: SpaceMeetDeps,
  asker: SignedIn,
  object: unknown,
  run: (o: StoreObject, which: MeetObject) => Promise<T>,
): Promise<SpaceReply<T>> {
  if (!d.install.isOwner(asker.person)) return refused('not-admitted', NOT_ADMITTED)
  const which = (MEET_OBJECTS as readonly unknown[]).includes(object) ? (object as MeetObject) : null
  if (!which) return refused('bad-request', 'Name the object: workspace or ledger.')
  const o = d.object?.(which)
  if (!o) return failed('Chat’s store could not be reached to do that.')
  try {
    return answered(await run(o, which))
  } catch (err) {
    if (err instanceof RoomError) return fromRoomError(err)
    console.error('space operator failed', err instanceof Error ? err.message : String(err))
    return failed('Chat’s store could not do that.')
  }
}

// ── The shapes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line of at most SNIPPET_CHARS: whitespace collapsed, and an ellipsis (counted in the length) where it was cut. */
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_CHARS) return flat
  let cut = flat.slice(0, SNIPPET_CHARS - 1)
  // Never end on half of a character that takes two code units.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

const toPerson = (p: SpacePerson): MeetPerson => ({ id: p.id, name: p.name, kind: p.kind, address: normalizeAddress(p.email) })

const toMe = (r: SpaceMeRaw): MeetMe => ({ person: toPerson(r.me), owner: r.owner, nudgesOff: r.nudgesOff, privacyAcked: r.privacyAcked })

const toMember = (m: SpaceMemberRaw): MeetMember => ({ person: toPerson(m.person), invited: m.invited, you: m.you, direct: m.direct, may: m.may })

const toDetail = (c: SpaceChannelDetailRaw): MeetChannelDetail => ({
  conversationId: c.conv,
  name: c.name,
  privacy: c.privacy,
  createdByMe: c.createdByMe,
  members: c.members.map(toMember),
  addable: c.addable.map(toPerson),
  may: c.may,
})

/** A huddle's message says "Started a huddle" in a row, not its link: the card is the link. */
const newestWords = (m: WMessage): string => (m.huddle === undefined ? snippet(m.text) : 'Started a huddle')

const toNewest = (m: WMessage | null, me: string): MeetNewest | null =>
  m ? { messageId: m.id, at: m.at, text: newestWords(m), authorId: m.person, authorName: m.name, mine: m.person === me } : null

/**
 * What the person may do with a message, by the rules `edit` and `deleteMessage` apply: your own is edited and deleted, the owner deletes another's. A huddle's announcement is a message like
 * any other here, as it was at /start (ConversationPane.tsx offered Edit and Delete on it): once /start is gone nothing else could delete one. The core refuses a press the page should not
 * have offered, in its own words; this is only what the page is told to draw.
 */
const mayOf = (m: WMessage, me: string, owner: boolean): MeetMessageMay => {
  const mine = m.person === me
  return { edit: mine, delete: mine || owner }
}

const toMessage = (m: WMessage, me: string, owner: boolean): MeetMessage => ({
  id: m.id,
  conversationId: m.conv,
  authorId: m.person,
  authorName: m.name,
  text: m.text,
  at: m.at,
  editedAt: m.editedAt,
  mine: m.person === me,
  ...(m.huddle === undefined ? {} : { huddle: m.huddle }),
  may: mayOf(m, me, owner),
})

/** Newest first; a conversation nobody has written in goes last, and ties keep meet's own order (the id). */
const byNewest = (a: { newest: { at: number } | null; conversationId: number }, b: { newest: { at: number } | null; conversationId: number }) =>
  (b.newest?.at ?? -1) - (a.newest?.at ?? -1) || a.conversationId - b.conversationId

/**
 * How many of the newest calls `liveCalls` looks inside. A call is in the ledger's index from the moment it is made and stays, and
 * only a Room knows who is in it now, so each call looked at is one question to its object: the newest few is what a call in
 * progress can be among (the start page's own list asks for fifty).
 */
export const LIVE_CALLS_SCANNED = 30

/** The longest page of past calls one question returns, and how many pages of the ledger it looks through to fill it (calls other people made are skipped). */
const CALLS_PAGE_MAX = 50
const CALLS_PAGES_SCANNED = 4
const CALL_CURSOR = /^(\d{1,16}):([0-9a-z]{20})$/

/** A call's state from its Room: how many are in it, its numbers, when it ended. A call whose Room cannot be read is a call with nothing in it. */
interface RoomState {
  present: number
  people: number
  messages: number
  endedAt: number | null
  openedAt: number | null
}
const NO_STATE: RoomState = { present: 0, people: 0, messages: 0, endedAt: null, openedAt: null }

async function stateOf(d: SpaceMeetDeps, name: string): Promise<RoomState> {
  try {
    const s = await d.room(name).summary(d.now())
    return { present: s.present, people: s.people, messages: s.messages, endedAt: s.endedAt, openedAt: s.openedAt }
  } catch {
    return NO_STATE
  }
}

/** The contract's call, from the workspace's record (or, for a call that has none, from the ledger's) and the Room's state. */
function toCall(d: SpaceMeetDeps, raw: SpaceCallRaw, state: RoomState): MeetCall {
  return {
    name: raw.name,
    link: callLink(d.appOrigin, raw.name),
    kind: raw.kind,
    title: raw.title,
    madeBy: { name: raw.byName, mine: raw.mine },
    madeAt: raw.at,
    conversationId: raw.conv,
    home: raw.home,
    startsAt: raw.startsAt,
    invitees: raw.invitees.map((i) => ({ name: i.name, address: i.address === null ? null : normalizeAddress(i.address) })),
    ...state,
  }
}

/** A call made at meet's old start page, or before the workspace kept a record of what a call is for: the ledger knows it and the workspace does not. It is the asker's, or it would not be shown. */
function legacyCall(person: Person, found: { name: string; startedAt: number }): SpaceCallRaw {
  return { name: found.name, kind: 'new', by: '', byName: person.name, at: found.startedAt, conv: null, home: null, title: null, startsAt: null, invitees: [], mine: true }
}

const cursorOf = (c: { startedAt: number; name: string }): string => `${c.startedAt}:${c.name}`

export function spaceMeet(d: SpaceMeetDeps): MeetForSpace {
  const calls = (): CallDepsOf => ({ room: d.room, ledger: d.ledger, workspace: d.workspace, appOrigin: d.appOrigin, now: d.now, randomBytes: d.randomBytes })

  /**
   * A keyed write that makes a call. The raw answer is read inside, so a repeat can be told from a first use; a fault after the workspace may have
   * committed is thrown, not answered (see `asAsker`), and the space then says "outcome unknown" and offers no retry.
   */
  const makeOne = (asker: SignedIn, key: unknown, spec: CallSpec): Promise<WriteReply<MeetCall>> =>
    keyedWrite(d, asker, async (actor, _endsAt, person) => {
      // Calls are a switch: an install without it makes no call, whatever asks (a huddle, a call link, a meeting).
      if (!d.install.has('calls')) throw new RoomError(404, CALLS_OFF)
      if (typeof key !== 'string') throw new RoomError(400, 'bad request')
      const made: CallRecordRaw = await makeKeyedCall(calls(), actor, person.address, key, spec)
      return { repeated: made.repeated, value: toCall(d, made.call, made.repeated ? await stateOf(d, made.call.name) : NO_STATE) }
    })

  /** The calls with someone in them that are this person's, and why; the ledger's newest few, each asked of its own Room. */
  const liveOf = async (actor: Actor): Promise<MeetLiveCall[]> => {
    const { calls: indexed } = await d.ledger().listCalls(LIVE_CALLS_SCANNED, null)
    const related = await d.workspace().spaceRelate(actor, indexed.map((c) => ({ name: c.name, startedBy: c.startedBy })), d.now())
    const whyOf = new Map(related.map((r) => [r.name, r.why] as const))
    const looked = await Promise.all(
      indexed.map(async (c): Promise<MeetLiveCall | null> => {
        const why: SpaceCallWhy | null = whyOf.get(c.name) ?? null
        if (why === null) return null
        try {
          const summary = await d.room(c.name).summary(d.now())
          return summary.present > 0 ? { name: c.name, startedAt: summary.startedAt, present: summary.present, why } : null
        } catch {
          // A call that cannot be read is left out rather than failing the rest, as the start page's list does.
          return null
        }
      }),
    )
    return looked.filter((c): c is MeetLiveCall => c !== null).sort((a, b) => b.startedAt - a.startedAt || a.name.localeCompare(b.name))
  }

  return {
    conversations: (asker) =>
      asAsker(d, asker, async (actor): Promise<MeetOverview> => {
        const raw = await d.workspace().spaceOverview(actor, d.now())
        const me = raw.me.id
        const direct: MeetDirect[] = raw.direct
          .map((r) => ({ conversationId: r.conv, person: toPerson(r.other), newest: toNewest(r.newest, me), unread: r.unread }))
          .sort(byNewest)
        const channels: MeetChannel[] = raw.channels
          .map((r) => ({ conversationId: r.conv, name: r.name, privacy: r.privacy, memberCount: r.members, createdAt: r.createdAt, newest: toNewest(r.newest, me), unread: r.unread }))
          .sort(byNewest)
        // The Phone conversation is the phone's: an install without the switch shows none, whatever the store holds.
        const phone = raw.phone && d.install.has('phone') ? { conversationId: raw.phone.conv, newest: raw.phone.newest ? { at: raw.phone.newest.at, text: snippet(raw.phone.newest.text) } : null, unread: raw.phone.unread } : null
        const refs: MeetCallRef[] = raw.calls.map((c) => ({ name: c.name, link: callLink(d.appOrigin, c.name), title: c.title, madeAt: c.at }))
        return { me: toPerson(raw.me), direct, channels, phone, calls: refs }
      }),

    history: (asker, conversationId, before) =>
      asAsker(d, asker, async (actor): Promise<MeetHistory> => {
        const raw = await d.workspace().spaceHistory(actor, conversationId, before ?? null, d.now())
        return { messages: raw.messages.map((m) => toMessage(m, raw.me, raw.owner)), more: raw.more }
      }),

    post: (asker, post) =>
      keyedWrite(d, asker, async (actor) => {
        const asked = (post ?? {}) as Partial<MeetPost>
        const raw = await d.workspace().spacePost(actor, asked.key, asked.target, asked.text, d.now())
        return { repeated: raw.repeated, value: { conversationId: raw.conv, message: toMessage(raw.message, raw.me, raw.owner) } satisfies MeetPosted }
      }),

    markRead: (asker, conversationId, upTo) =>
      asAsker(d, asker, async (actor): Promise<MeetRead> => {
        const raw = await d.workspace().spaceMarkRead(actor, conversationId, upTo, d.now())
        return { conversationId: raw.conv, upTo: raw.upTo }
      }),

    liveCalls: (asker) => asAsker(d, asker, async (actor): Promise<MeetLiveCall[]> => liveOf(actor)),

    // ── Calls ──

    startHuddle: (asker, start) => {
      const asked = (start ?? {}) as Partial<MeetHuddleStart>
      return makeOne(asker, asked.key, { kind: 'huddle', convId: asked.conversationId as number })
    },

    startCall: (asker, start) => {
      const asked = (start ?? {}) as Partial<MeetCallStart>
      const home = typeof asked.home === 'string' && asked.home.trim() !== '' ? asked.home : null
      return makeOne(asker, asked.key, { kind: home === null ? 'new' : 'link', home, title: typeof asked.title === 'string' ? asked.title : null })
    },

    bookMeeting: (asker, booking) => {
      const asked = (booking ?? {}) as Partial<MeetBooking>
      return makeOne(asker, asked.key, {
        kind: 'meeting',
        title: typeof asked.title === 'string' ? asked.title : null,
        startsAt: asked.startsAt as number,
        convId: typeof asked.conversationId === 'number' ? asked.conversationId : null,
        home: typeof asked.home === 'string' ? asked.home : null,
        invitees: asked.invitees as CallSpec['invitees'],
      })
    },

    cards: (asker, want) =>
      asAsker(d, asker, async (actor): Promise<MeetCall[]> => {
        const asked = (want ?? {}) as Partial<MeetCardsWant>
        const raw = await d.workspace().spaceCards(actor, { conversationIds: asked.conversationIds ?? [], homes: asked.homes ?? [] }, d.now())
        return Promise.all(raw.map(async (r) => toCall(d, r, await stateOf(d, r.name))))
      }),

    calls: (asker, after, limit) =>
      asAsker(d, asker, async (actor, _endsAt, person): Promise<MeetCallPage> => {
        const want = Math.min(CALLS_PAGE_MAX, Math.max(1, Number.isInteger(limit) ? (limit as number) : 20))
        const start = typeof after === 'string' ? CALL_CURSOR.exec(after) : null
        if (after !== undefined && after !== null && !start) throw new RoomError(400, 'bad request')
        let cursor: { startedAt: number; name: string } | null = start ? { startedAt: Number(start[1]), name: start[2] as string } : null
        const out: MeetCall[] = []
        let next: { startedAt: number; name: string } | null = null
        for (let page = 0; page < CALLS_PAGES_SCANNED && out.length < want; page++) {
          const got = await d.ledger().listCalls(CALLS_PAGE_MAX, cursor)
          const related = await d.workspace().spaceRelate(actor, got.calls.map((c) => ({ name: c.name, startedBy: c.startedBy })), d.now())
          const mine: Array<{ call: (typeof got.calls)[number]; raw: SpaceCallRaw }> = []
          for (const [i, c] of got.calls.entries()) {
            const r = related[i]
            if (r && r.why !== null) mine.push({ call: c, raw: r.row ?? legacyCall(person, c) })
          }
          const room = want - out.length
          const taken = mine.slice(0, room)
          out.push(...(await Promise.all(taken.map(async (t) => toCall(d, t.raw, await stateOf(d, t.raw.name))))))
          const last = taken.at(-1)
          if (mine.length > room && last) {
            // The page had more of the asker's than were wanted: the next page starts just past the last one taken.
            next = { startedAt: last.call.startedAt, name: last.call.name }
            break
          }
          cursor = got.next
          next = got.next
          if (!got.next) break
        }
        return { calls: out, next: next ? cursorOf(next) : null }
      }),

    callChat: (asker, name) =>
      asAsker(d, asker, async (actor, _endsAt, person): Promise<MeetCallChat> => {
        const room = typeof name === 'string' ? normalizeRoomName(name) : null
        if (!room) throw new RoomError(404, 'This is not a call.')
        const found = await d.ledger().indexed(room)
        if (!found) throw new RoomError(404, 'This is not a call.')
        const [related] = await d.workspace().spaceRelate(actor, [{ name: room, startedBy: found.startedBy }], d.now())
        if (!related || related.why === null) throw new RoomError(404, 'This is not a call.')
        const raw = related.row ?? legacyCall(person, found)
        return { call: toCall(d, raw, await stateOf(d, room)), messages: (await d.room(room).history()).map((m) => ({ id: m.id, name: m.name, text: m.text, at: m.at })) }
      }),

    deleteCallChat: (asker, name) =>
      asAsker(d, asker, async (actor, _endsAt, person): Promise<{ deleted: number }> => {
        // The owner's, as the old start page's delete was: a call's saved chat is deleted by the owner alone.
        if (!d.install.isOwner(person)) throw new RoomError(403, 'Only the owner deletes a call’s chat.')
        const room = typeof name === 'string' ? normalizeRoomName(name) : null
        const found = room ? await d.ledger().indexed(room) : null
        if (!room || !found) throw new RoomError(404, 'This is not a call.')
        const [related] = await d.workspace().spaceRelate(actor, [{ name: room, startedBy: found.startedBy }], d.now())
        if (!related || related.why === null) throw new RoomError(404, 'This is not a call.')
        return { deleted: await d.room(room).deleteMessages(d.now()) }
      }),

    meetings: (asker, from, until) =>
      asAsker(d, asker, async (actor): Promise<MeetCall[]> => {
        const raw = await d.workspace().spaceMeetings(actor, from, until, d.now())
        return Promise.all(raw.map(async (r) => toCall(d, r, await stateOf(d, r.name))))
      }),

    usage: (asker) =>
      asAsker(d, asker, async (_actor, _endsAt, person): Promise<MeetUsage> => {
        if (!d.install.isOwner(person)) throw new RoomError(403, 'This is not open to you.')
        return meterOf(d.ledger(), d.now())
      }),

    phoneConversation: (asker, before) =>
      asAsker(d, asker, async (actor): Promise<MeetPhone> => {
        if (!d.install.has('phone')) throw new RoomError(404, PHONE_OFF)
        const raw = await d.workspace().spacePhone(actor, before ?? null, d.now())
        const items = raw.messages.flatMap((m): MeetPhoneItem[] => {
          const p = m.phone
          if (!p) return []
          const text = snippet(m.text)
          if (p.kind === 'voicemail') return [{ id: m.id, at: m.at, kind: 'voicemail', text, number: p.number, display: p.display, seconds: p.seconds }]
          if (p.kind === 'missed') return [{ id: m.id, at: m.at, kind: 'missed', text, number: p.number, display: p.display, seconds: null }]
          return [{ id: m.id, at: m.at, kind: 'emergency', text, number: null, display: null, seconds: null }]
        })
        return { conversationId: raw.conv, unread: raw.unread, items, more: raw.more }
      }),

    phoneRead: (asker, upTo) =>
      asAsker(d, asker, async (actor): Promise<MeetReadT> => {
        if (!d.install.has('phone')) throw new RoomError(404, PHONE_OFF)
        const raw = await d.workspace().spacePhoneRead(actor, upTo, d.now())
        return { conversationId: raw.conv, upTo: raw.upTo }
      }),

    // ── Messages and a person's own settings ──

    peopleToMessage: (asker) =>
      asAsker(d, asker, async (actor): Promise<MeetReachable[]> =>
        (await d.workspace().spaceMessageable(actor, d.now())).map((r) => ({ person: toPerson(r.person), direct: r.direct })),
      ),

    // Writes with no key: the core's own methods, so a fault after it committed is thrown (the space says "outcome unknown"), never answered `broken`.
    editMessage: (asker, edit) =>
      asAsker(
        d,
        asker,
        async (actor): Promise<MeetMessage> => {
          const asked = (edit ?? {}) as Partial<MeetEdit>
          const raw = await d.workspace().spaceEdit(actor, asked.messageId, asked.text, d.now())
          return toMessage(raw.message, raw.me, raw.owner)
        },
        { unknownIsThrown: true },
      ),

    deleteMessage: (asker, messageId) =>
      asAsker(
        d,
        asker,
        async (actor): Promise<MeetDeleted> => {
          const raw = await d.workspace().spaceDelete(actor, messageId, d.now())
          return { conversationId: raw.conv, messageId: raw.id }
        },
        { unknownIsThrown: true },
      ),

    me: (asker) => asAsker(d, asker, async (actor): Promise<MeetMe> => toMe(await d.workspace().spaceMe(actor, d.now()))),

    updateMe: (asker, patch) =>
      asAsker(d, asker, async (actor): Promise<MeetMe> => toMe(await d.workspace().spaceUpdateMe(actor, patch, d.now())), { unknownIsThrown: true }),

    acknowledgePrivacy: (asker) =>
      asAsker(d, asker, async (actor): Promise<MeetMe> => toMe(await d.workspace().spaceAckPrivacy(actor, d.now())), { unknownIsThrown: true }),

    // ── The operator's four (a move of meet's stores: the space's ADR 0016). The owner's; none touches a message, a call or a person. ──
    storeCounts: (asker, object) => asOwnerOn(d, asker, object, async (o, which): Promise<MeetCounts> => ({ object: which, counts: await o.counts() })),

    storeBookmark: (asker, object) =>
      asOwnerOn(d, asker, object, async (o, which): Promise<MeetBookmark> => ({ object: which, bookmark: await o.bookmark() })),

    restartStore: (asker, object) =>
      asOwnerOn(d, asker, object, async (o, which): Promise<MeetRestarted> => {
        try {
          await o.restart()
        } catch {
          // The object was reset under the call, which is what was asked. Whether it restarted under the new code is read in the Worker's log, not here.
        }
        return { object: which, restarted: true }
      }),

    restoreStore: (asker, object, bookmark) =>
      asOwnerOn(d, asker, object, async (o, which): Promise<MeetRestoring> => {
        if (typeof bookmark !== 'string' || !MEET_BOOKMARK.test(bookmark)) throw new RoomError(400, 'That is not a bookmark.')
        await o.restoreTo(bookmark)
        try {
          await o.restart()
        } catch {
          // As above: the restore happens when the object starts again.
        }
        return { object: which, restoring: true }
      }),

    // ── Channel admin ──

    channel: (asker, conversationId) =>
      asAsker(d, asker, async (actor): Promise<MeetChannelDetail> => toDetail(await d.workspace().spaceChannel(actor, conversationId, d.now()))),

    browseChannels: (asker) =>
      asAsker(d, asker, async (actor): Promise<MeetBrowsable[]> =>
        (await d.workspace().spaceBrowse(actor, d.now())).map((r) => ({ conversationId: r.conv, name: r.name, memberCount: r.members })),
      ),

    createChannel: (asker, make) =>
      keyedWrite(d, asker, async (actor) => {
        const asked = (make ?? {}) as Partial<MeetChannelMake>
        const raw = await d.workspace().spaceCreateChannel(actor, asked.key, asked.name, asked.privacy, d.now())
        return { repeated: raw.repeated, value: toDetail(raw.channel) }
      }),

    inviteGuest: (asker, invite) =>
      keyedWrite(d, asker, async (actor) => {
        const asked = (invite ?? {}) as Partial<MeetGuestInvite>
        const raw = await d.workspace().spaceInvite(actor, asked.key, asked.conversationId, asked.address, asked.name, d.now())
        let mailed = raw.mailed
        // The one email meet sends for the space, and only for a first use of the key: a repeat sends nothing. The guest is in the channel either way, as at /start;
        // a mail that could not be sent is told (`mailed: false`), and inviting again with a new key sends it again.
        if (raw.mail !== null) {
          try {
            await d.mailer.send(inviteEmail(raw.mail.to, raw.mail.inviter, raw.mail.channel, d.appOrigin, d.install))
            mailed = true
          } catch (err) {
            mailed = false
            console.error('invitation email failed', err instanceof Error ? err.message : String(err))
          }
          await d.workspace().spaceInviteSent(actor, asked.key, mailed, d.now()).catch(() => undefined)
        }
        return { repeated: raw.repeated, value: { conversationId: raw.conv, person: toPerson(raw.person), mailed } satisfies MeetInvited }
      }),

    // Not keyed (repeating a change does the same again or is refused), but still a WRITE: a fault after the Workspace committed (a guest deleted, a channel archived) is thrown, not
    // answered `broken`, so the space says "outcome unknown" and never reports a committed change as not done.
    changeChannel: (asker, change) =>
      asAsker(
        d,
        asker,
        async (actor): Promise<MeetChanged> => {
          const asked = (change ?? {}) as Partial<MeetChannelChange> & { name?: unknown; personId?: unknown }
          const raw = await d.workspace().spaceChange(actor, asked.conversationId, asked as SpaceChangeRaw, d.now())
          return { conversationId: raw.conv, channel: raw.channel ? toDetail(raw.channel) : null }
        },
        { unknownIsThrown: true },
      ),
  }
}

type CallDepsOf = Parameters<typeof makeKeyedCall>[0]

// ── The phone's requests ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the space hands on to meet's routes: the phone's requests, at `/space/phone` and under it (the dial pad's own calls). The request goes on UNCHANGED to meet's own router (`route`), for the person the
 * space's one check named (space-app.ts), then meet's own phone rules. 404 for every other path, so this reaches none of meet's other routes (the call API, the guests' door, the teammates' API). There is no team socket
 * here: a teammate's page hears that chat moved from the space's live object (packages/workspace/src/live.ts), which this package's Workspace object tells.
 */
export async function serveForSpace(request: Request, route: (request: Request) => Response | Promise<Response>): Promise<Response> {
  const { pathname } = new URL(request.url)
  const phone = (MEET_FOR_SPACE_FETCH_PREFIXES as readonly string[]).some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) && !pathname.includes('..') && !/%2e|%2f|%5c/i.test(pathname)
  if (!phone) return new Response('Not found', { status: 404 })
  return route(request)
}

