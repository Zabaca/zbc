// Every HTTP route meet answers. Each call is its own Durable Object, reached
// through a RoomClient (room.ts); the rules about a call live there. This file
// owns what only the Worker can do: verify Access, validate input, call
// Cloudflare's SFU and TURN APIs (realtime.ts), and tell the Room what
// succeeded. If the Room has moved on in between (the person left, or rejoined
// under a new generation), the tracks the SFU just made are closed again.
//
// Externals arrive as Deps (the DO clients, the Realtime client, the Access
// settings, the clock, the randomness), built from the real bindings in
// index.ts and from fakes in the tests, so `bun test` drives real requests
// through this router with no network and no Workers runtime.
//
// One door for outsiders, /r/api/* (anyone with a call's name): docs/adr/0001, section 3. The workspace's guests' routes are workspace-routes.ts (docs/adr/0003). Both are mounted by the space's
// Worker at its open paths (space-guests.ts, the space's ADR 0018); meet has no Worker of its own, so the one place a route
// is mounted is space-guests.ts, and a local run of the guests' side is dev/worker.ts. The company's people do what they do with calls in the space's part (space-meet.ts).

import { type Context, Hono } from 'hono'
import { hex, isLocal, sha256Hex } from './door'
import type { Install } from '@space/workspace'
import { CALL_API, CHAT_MAX, GUEST_API, displayName, isKind, normalizeRoomName, utcMonth } from './model'
import { makeCall, meterOf } from './calls'
import { meetUrl } from './mail'
import type { Kind } from './model'
import { RealtimeError, type IceServer, type Realtime, type TrackItem } from './realtime'
import { type Orphan, type Publication, type Pulled, RoomError, type RoomClient } from './room'
import type { Mailer, Outgoing } from './mail'
import type { WorkspaceClient } from './workspace'
import type { PhoneClient } from './phone'
import { type PhoneRuntime, mountPhonePublic } from './phone-routes'
import { mountWorkspace } from './workspace-routes'

export interface Deps {
  room(name: string): RoomClient
  /** The service-wide usage ledger (room.ts, LEDGER_NAME). */
  ledger(): RoomClient
  realtime: Realtime
  /** The company this Worker serves: its people, who owns it, and the Access team (packages/workspace). */
  install: Install
  /** The one Workspace instance (workspace.ts): channels, direct messages and who may see them. */
  workspace(): WorkspaceClient
  /** The phone's rules, in the same object (phone.ts). */
  phoneCore(): PhoneClient
  /** Telnyx and its settings, or null when the phone is not all set up: then no one has a dial pad (docs/adr/0004, section 6). */
  phone: PhoneRuntime | null
  /** Sends the kinds of email (mail.ts). */
  mailer: Mailer
  /** https://space.northfield.example, for links in an email: a cron has no request to take it from. */
  appOrigin: string
  /** The address the development bypass signs in as, on a localhost host only. */
  devTeammate: string
  /** Local runs only: the emails "sent", for the live check to read a code from. null in production. */
  devMail: Outgoing[] | null
  /** The per-IP limit on the guests' sign-in (wrangler.jsonc `ratelimits`): true when the request may go on. */
  authLimit(key: string): Promise<boolean>
  /** Hand a redeemed ticket's person to the Workspace object as a socket (the upgrade response). */
  openSocket(who: { person: string; session: string | null; endsAt: number }): Promise<Response>
  /** True only when the dev flag is set; it is honoured on a localhost host alone. */
  devBypass: boolean
  now(): number
  randomBytes(n: number): Uint8Array
}

/**
 * What the part of meet that runs in the space's Worker needs (src/space-part.ts): the phone's rules and the five-minute sweep, which send the email and call Telnyx, and the live
 * socket's route. Not the call API's SFU client or the guests' sign-in limit: those belong to the guest door (space-guests.ts), whose dependencies are the larger `Deps`.
 */
export type MeetPartDeps = Pick<Deps, 'workspace' | 'phoneCore' | 'phone' | 'mailer' | 'appOrigin' | 'install' | 'openSocket' | 'devBypass' | 'now' | 'randomBytes'>

/** How long relay credentials last. A call longer than this loses the relay (out of scope: refreshing them). */
export const RELAY_TTL_SECONDS = 8 * 60 * 60
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/
const TOKEN_HEADER = 'x-member-token'

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json()
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : Number.NaN)
const sdp = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200_000 ? v : null)

/** A track the SFU reports as failed carries an errorCode; the others succeeded. */
const failed = (t: TrackItem) => Boolean(t.errorCode)

/** What the browser is told when the SFU refused a track. The SFU's own words are logged, never sent on. */
const NOT_ACCEPTED = 'not accepted'
function refusal(what: string, t: TrackItem | undefined): string {
  console.warn(`sfu refused ${what}: ${t ? `${t.errorCode ?? 'no code'} ${t.errorDescription ?? ''}` : 'not in the response'}`)
  return NOT_ACCEPTED
}

/**
 * Whether a close took, from the SFU's per-track answer: no error, or the SFU says the track does not exist or
 * is already closed (`close_track_error`). Checked live: a request that mixes a closed mid with an open one is
 * accepted and answers per track; an unknown session is a 500 for the whole request.
 */
const closedAtSfu = (t: TrackItem | undefined): boolean => !t?.errorCode || t.errorCode === 'close_track_error'

/** Group closes by session: one request each. */
function bySession(items: Orphan[]): Map<string, Orphan[]> {
  const groups = new Map<string, Orphan[]>()
  for (const o of items) groups.set(o.session, [...(groups.get(o.session) ?? []), o])
  return groups
}

/** What a thrown error becomes: a rule's refusal in its own words, the SFU's trouble as a 502, anything else a plain 500 (the cause is logged, never sent). */
export function answerError(err: Error, c: Context): Response {
  if (err instanceof RoomError) return c.json({ error: err.message }, err.status)
  if (err instanceof RealtimeError) {
    console.error('realtime', err.message)
    return c.json({ error: 'The call service did not answer. Try again.' }, 502)
  }
  console.error(err)
  return c.json({ error: 'internal error' }, 500)
}

/** Where the usage meter stands: the month's estimate and, once it has tripped, the day calls resume. */
const meter = (d: Deps) => meterOf(d.ledger(), d.now())

/**
 * Close, at the SFU, the tracks of people the Room has dropped (docs/adr/0001,
 * section 2). Never throws. The Room keeps each row until told the SFU took the
 * close, so a refusal, a busy SFU or a request that dies here all come round
 * again; what counts as taken is `closedAtSfu`.
 */
async function closeOrphans(d: Deps, room: RoomClient, items: Orphan[]): Promise<void> {
  if (items.length === 0) return
  try {
    const groups = [...bySession(items)]
    const results = await Promise.allSettled(
      groups.map(([session, list]) =>
        d.realtime.closeTracks(
          session,
          list.map((o) => o.mid),
          { force: true },
        ),
      ),
    )
    const done: Orphan[] = []
    groups.forEach(([, list], i) => {
      const r = results[i]
      if (r?.status !== 'fulfilled') return
      for (const o of list) if (closedAtSfu(r.value.tracks?.find((x) => x.mid === o.mid))) done.push(o)
    })
    if (done.length > 0) await room.closedOrphans(done)
  } catch (err) {
    console.warn('closing tracks failed', err instanceof Error ? err.message : err)
  }
}

/** Take what is due from a Room and close it (for the routes whose Room reply does not carry it). */
async function drain(d: Deps, room: RoomClient): Promise<void> {
  try {
    await closeOrphans(d, room, await room.takeOrphans(d.now()))
  } catch (err) {
    console.warn('draining closed tracks failed', err instanceof Error ? err.message : err)
  }
}

/**
 * Close tracks the SFU made for a person who has moved on while it worked. Any the SFU will not close (the
 * request fails, or it answers an error for that track) are handed to the Room as orphans, to be retried.
 */
async function closeOrKeep(d: Deps, room: RoomClient, session: string, mids: string[]): Promise<void> {
  let keep = mids
  try {
    const res = await d.realtime.closeTracks(session, mids, { force: true })
    keep = mids.filter((mid) => !closedAtSfu(res.tracks?.find((t) => t.mid === mid)))
  } catch {
    // The whole request failed: keep them all.
  }
  if (keep.length === 0) return
  await room
    .addOrphans(
      keep.map((mid) => ({ session, mid })),
      d.now(),
    )
    .catch(() => null)
}

/** Give the ledger what a Room offered, then tell the Room it was written. A failed write is offered again once its lease runs out. */
async function settle(d: Deps, room: RoomClient, usage: number): Promise<void> {
  if (usage <= 0) return
  try {
    await d.ledger().addUsage(utcMonth(d.now()), usage)
    await room.ackUsage(usage)
  } catch (err) {
    console.warn('usage write failed', err instanceof Error ? err.message : err)
  }
}


/**
 * The call page's API, mounted under `base` (`CALL_API`, `/r/api`, where the space's guest door answers it). One door for outsiders, anyone with a call's name: docs/adr/0001, section 3.
 */
export function mountCalls(app: Hono, deps: (c: Context) => Deps, base: string): void {
  app.use(`${base}/*`, async (c, next) => {
    await next()
    c.header('cache-control', 'no-store')
  })

  // Per-call routes: normalize the name, then read the token.

  type Who = { name: string; room: RoomClient; hash: string }
  const whoOf = async (c: Context): Promise<Who> => {
    const name = normalizeRoomName(c.req.param('name') ?? '')
    if (!name) throw new RoomError(404, 'This is not a call.')
    const token = c.req.header(TOKEN_HEADER) ?? ''
    if (!TOKEN.test(token)) throw new RoomError(401, 'You are not in this call.')
    return { name, room: deps(c).room(name), hash: await sha256Hex(token) }
  }

  // The lobby's first look: is this a call, and how many are in it.
  app.get(`${base}/rooms/:name`, async (c) => {
    const name = normalizeRoomName(c.req.param('name') ?? '')
    if (!name) return c.json({ error: 'This is not a call.' }, 404)
    const d = deps(c)
    const room = d.room(name)
    if (!(await room.exists())) return c.json({ error: 'This is not a call.' }, 404)
    const m = await meter(d)
    const info = await room.info(d.now())
    await drain(d, room)
    return c.json({ ...info, paused: m.paused, pausedUntil: m.pausedUntil })
  })

  // Take a seat (or the same seat again), make the two SFU sessions, and get relay credentials. A rejoin
  // closes the old connection's tracks and reuses the credentials the person still holds.
  app.post(`${base}/rooms/:name/join`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const m = await meter(d)
    const joined = await room.join(hash, hex(d.randomBytes(8)), typeof b.name === 'string' ? b.name : '', d.now(), m.pausedUntil)
    await drain(d, room)
    try {
      const [sendSession, recvSession, minted] = await Promise.all([
        d.realtime.newSession(),
        d.realtime.newSession(),
        joined.ice ? Promise.resolve(null) : d.realtime.iceServers(RELAY_TTL_SECONDS),
      ])
      const fresh = minted ? { servers: minted, expiresAt: d.now() + RELAY_TTL_SECONDS * 1000 } : null
      if (!(await room.setSessions(hash, joined.generation, sendSession, recvSession, fresh, d.now()))) {
        return c.json({ error: 'This connection was replaced.' }, 409)
      }
      return c.json({
        memberId: joined.memberId,
        generation: joined.generation,
        snapshot: joined.snapshot,
        // The newest message when this person arrived: the history they did not miss, which is never "unread".
        chatLast: joined.chatLast,
        iceServers: (joined.ice ?? minted ?? []) satisfies IceServer[],
      })
    } catch (err) {
      // Do not leave a seat that never connected.
      const gone = await room.leave(hash, joined.generation, d.now()).catch(() => null)
      if (gone) await settle(d, room, gone.usage)
      throw err
    }
  })

  // The heartbeat: every 2 seconds. Returns the call as it stands.
  app.post(`${base}/rooms/:name/checkin`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const { snapshot, usage, orphans, chat } = await room.checkIn(
      hash,
      int(b.generation),
      { muted: b.muted === true, cameraOff: b.cameraOff === true },
      d.now(),
      // No `since` (a tab still running code from before chat) gets no messages, not 200 every check-in.
      Number.isInteger(b.since) && (b.since as number) >= 0 ? (b.since as number) : null,
    )
    await settle(d, room, usage)
    await closeOrphans(d, room, orphans)
    return c.json({ snapshot, chat })
  })

  // Chat: send a message. Reading is the check-in's job. Members of this call only; the Room refuses everyone else.
  app.post(`${base}/rooms/:name/chat`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    // The Room checks the length after cleaning; this only stops a body far past any message from being worked on.
    if (typeof b.text === 'string' && b.text.length > CHAT_MAX * 5) throw new RoomError(400, 'A message is too long.')
    const message = await room.chat(hash, int(b.generation), b.text, d.now())
    return c.json({ message }, 201)
  })

  // Publish: the browser's whole sending offer, and which of its transceivers carry which kind.
  app.post(`${base}/rooms/:name/publish`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const generation = int(b.generation)
    const offer = sdp(b.offer)
    const asked = Array.isArray(b.tracks) ? (b.tracks as Array<{ kind?: unknown; mid?: unknown }>) : []
    if (!offer || asked.length === 0 || !asked.every((t) => isKind(t.kind) && typeof t.mid === 'string' && t.mid !== '')) {
      throw new RoomError(400, 'bad request')
    }
    const midOf = new Map(asked.map((t) => [t.kind as Kind, t.mid as string]))
    const plan = await room.planPublish(
      hash,
      generation,
      asked.map((t) => t.kind),
      d.now(),
    )
    const res = await d.realtime.addLocalTracks(
      plan.sendSession,
      offer,
      plan.tracks.map((t) => ({ trackName: t.trackName, mid: midOf.get(t.kind) as string })),
    )
    const results = new Map((res.tracks ?? []).map((t) => [t.trackName, t]))
    const ok: Publication[] = []
    const bad: Array<{ kind: Kind; error: string }> = []
    for (const t of plan.tracks) {
      const r = results.get(t.trackName)
      if (!r || failed(r)) bad.push({ kind: t.kind, error: refusal(`publish ${t.kind}`, r) })
      else ok.push({ ...t, mid: midOf.get(t.kind) as string })
    }
    if (ok.length > 0 && !(await room.recordPublished(hash, generation, ok, d.now()))) {
      // The member left or rejoined while the SFU was working: close what it just made.
      await closeOrKeep(
        d,
        room,
        plan.sendSession,
        ok.map((t) => t.mid),
      )
      return c.json({ error: 'This connection was replaced.' }, 409)
    }
    return c.json({ answer: res.sessionDescription?.sdp ?? null, published: ok.map((t) => t.kind), failed: bad })
  })

  app.post(`${base}/rooms/:name/unpublish`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const generation = int(b.generation)
    const kinds = Array.isArray(b.kinds) ? b.kinds : []
    const offer = sdp(b.offer)
    const plan = await room.planUnpublish(hash, generation, kinds, d.now())
    if (plan.items.length === 0 || !plan.sendSession) return c.json({ answer: null })
    const res = await d.realtime.closeTracks(
      plan.sendSession,
      plan.items.map((i) => i.mid),
      offer ? { offerSdp: offer } : { force: true },
    )
    await room.recordUnpublished(
      hash,
      generation,
      plan.items.map((i) => i.kind),
      d.now(),
    )
    return c.json({ answer: res.sessionDescription?.sdp ?? null })
  })

  // Subscribe: ask by member and kind, never by session. The reply may carry an
  // offer the browser must answer through /renegotiate before it asks again.
  app.post(`${base}/rooms/:name/subscribe`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const generation = int(b.generation)
    const plan = await room.resolveSubscribe(hash, generation, b.wants, d.now())
    if (plan.items.length === 0) return c.json({ offer: null, requiresImmediateRenegotiation: false, tracks: [], failed: [] })
    const res = await d.realtime.addRemoteTracks(
      plan.recvSession,
      plan.items.map((i) => ({ sessionId: i.sessionId, trackName: i.trackName })),
    )
    const results = new Map((res.tracks ?? []).map((t) => [`${t.sessionId ?? ''}/${t.trackName}`, t]))
    const ok: Pulled[] = []
    const bad: Array<{ memberId: string; kind: Kind; error: string }> = []
    for (const i of plan.items) {
      const r = results.get(`${i.sessionId}/${i.trackName}`)
      if (!r || failed(r) || !r.mid) bad.push({ memberId: i.memberId, kind: i.kind, error: refusal(`subscribe ${i.kind}`, r) })
      else ok.push({ memberId: i.memberId, kind: i.kind, v: i.v, trackName: i.trackName, mid: r.mid })
    }
    if (ok.length > 0 && !(await room.recordSubscribed(hash, generation, ok, d.now()))) {
      await closeOrKeep(
        d,
        room,
        plan.recvSession,
        ok.map((t) => t.mid),
      )
      return c.json({ error: 'This connection was replaced.' }, 409)
    }
    return c.json({
      offer: res.sessionDescription?.type === 'offer' ? res.sessionDescription.sdp : null,
      requiresImmediateRenegotiation: res.requiresImmediateRenegotiation === true,
      tracks: ok.map((t) => ({ memberId: t.memberId, kind: t.kind, v: t.v, mid: t.mid })),
      failed: bad,
    })
  })

  // The browser's answer to the SFU's offer from /subscribe.
  app.post(`${base}/rooms/:name/renegotiate`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const answer = sdp(b.answer)
    if (!answer) throw new RoomError(400, 'bad request')
    const { recvSession } = await room.sessions(hash, int(b.generation), d.now())
    if (!recvSession) throw new RoomError(409, 'not connected yet')
    await d.realtime.renegotiate(recvSession, answer)
    return c.json({ ok: true })
  })

  app.post(`${base}/rooms/:name/unsubscribe`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const generation = int(b.generation)
    const offer = sdp(b.offer)
    const plan = await room.planUnsubscribe(hash, generation, b.wants, d.now())
    if (plan.items.length === 0 || !plan.recvSession) return c.json({ answer: null })
    const res = await d.realtime.closeTracks(
      plan.recvSession,
      plan.items.map((i) => i.mid),
      offer ? { offerSdp: offer } : { force: true },
    )
    await room.recordUnsubscribed(hash, generation, plan.items, d.now())
    return c.json({ answer: res.sessionDescription?.sdp ?? null })
  })

  // Leave on purpose: drop the member from the call; their tracks are closed at the SFU by the drain.
  app.post(`${base}/rooms/:name/leave`, async (c) => {
    const d = deps(c)
    const { room, hash } = await whoOf(c)
    const b = await body(c)
    const gone = await room.leave(hash, int(b.generation), d.now())
    if (gone) await settle(d, room, gone.usage)
    await drain(d, room)
    return c.json({ ok: true })
  })

}
