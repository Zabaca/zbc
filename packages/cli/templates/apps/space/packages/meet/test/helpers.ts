// Test harness: the real router and the real RoomCore over bun:sqlite, with a
// fake for everything external.
//
// Each call name gets its own in-memory database, the way production gives each
// name its own Durable Object, and the RoomClient crosses the same `invokeCore`
// boundary the DO does. The clock is a variable the test moves. The Realtime
// client records every call it receives and answers like Cloudflare does, so
// nothing here reaches the network. Access is a stand-in: our own RSA key, our
// own JWKS served through the injected fetch, our own signed assertions.

import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { type AccessDeps, type Install, type SignedIn, createInstall, identify, resetJwksCache, signedIn } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { type Deps, answerError } from '../src/app'
import { createGuestApp } from '../src/space-guests'
import { createSpaceApp } from '../src/space-app'
import { makeCall } from '../src/calls'
import { isLocal } from '../src/door'
import { PhoneCore, invokePhone, phoneClient } from '../src/phone'
import { type PhoneRuntime, mountPhoneTeammates } from '../src/phone-routes'
import type { E911Address } from '../src/phone-model'
import type { Telnyx } from '../src/telnyx'
import { type IceServer, type Realtime, RealtimeError, type TrackItem, type TracksResponse } from '../src/realtime'
import type { Mailer, Outgoing } from '../src/mail'
import { LEDGER_NAME, RoomCore, type Sql, invokeCore, roomClient } from '../src/room'
import { TelnyxError } from '../src/telnyx'
import { type Effect, WorkspaceCore, invokeWorkspace, workspaceClient } from '../src/workspace'
import { type Change, DAY, nameFromEmail } from '../src/workspace-model'
import { type Door, workspaceHandlers } from '../src/workspace-routes'

/**
 * The person the space's one sign-in check would name, as a part of the space is handed them (`SignedIn`). An address that is not one of the install's people is a person of no install,
 * which the check never names for a request; the tests make one to show what meet keeps out for itself.
 */
export function signedAs(install: Install, email: string, exp: number): SignedIn {
  const person = install.personBySignIn(email) ?? { address: email, name: email, signIn: email, role: 'member' as const, sharedAddresses: [] }
  return signedIn(person, exp)
}

export function memSql(onRun?: () => void): Sql {
  const db = new Database(':memory:')
  return {
    all: <T>(q: string, ...params: unknown[]) => db.query(q).all(...(params as never[])) as T[],
    run: (q: string, ...params: unknown[]) => {
      onRun?.()
      db.query(q).run(...(params as never[]))
    },
  }
}

export const failingSfu = () => new RealtimeError(502, 'Cloudflare answered 502: down')

export const T0 = Date.UTC(2026, 9, 31, 12, 0, 0)
export const TEAM = 'northfield.cloudflareaccess.com'
export const AUD = 'a'.repeat(64)
/** Where the test-only teammates' door sits (Harness.teammateApp). Never /start/api/w: that path answers nothing now. */
export const TEAMMATE_DOOR = '/tm/w'
export const OWNER = 'tessa@northfield.example'
/** Teammates the workspace tests use besides Tessa: on the list in `harness()` unless it is told otherwise. */
export const ANA = 'ana@northfield.example'
export const BEN = 'ben@northfield.example'

const installs = new Map<string, Install>()
/**
 * Northfield's install with these people: Tessa the owner, the rest members. The tests change who is a teammate by changing the
 * list, so this is asked afresh at every use (and remembered per list). When Tessa is not in the list the first person is made
 * the owner, because an install must have one.
 */
export function installFor(emails: readonly string[]): Install {
  const key = emails.join(',')
  let held = installs.get(key)
  if (!held) {
    const hasOwner = emails.includes(OWNER)
    const people = emails.map((address, i) => ({ address, name: nameFromEmail(address), role: address === OWNER || (!hasOwner && i === 0) ? 'owner' : 'member' }))
    held = createInstall({
      ...declaration,
      people,
      // The declaration's phone list names Tessa; with another list of people it names the owner instead (the phone core is given its own list in most tests).
      phone: { people: { [people.find((p) => p.role === 'owner')?.address as string]: { emergencyNumber: 'line' } } },
    })
    installs.set(key, held)
  }
  return held
}

/** A fake SFU. `fail` names tracks (by track name) it should refuse, as Cloudflare can within one response. */
export class FakeRealtime implements Realtime {
  calls: Array<{ op: string; [k: string]: unknown }> = []
  fail = new Set<string>()
  private sessions = 0
  private mids = 0

  async newSession() {
    const id = `sess-${++this.sessions}`
    this.calls.push({ op: 'newSession', id })
    return id
  }
  async addLocalTracks(sessionId: string, offerSdp: string, tracks: Array<{ trackName: string; mid: string }>): Promise<TracksResponse> {
    this.calls.push({ op: 'addLocalTracks', sessionId, offerSdp, tracks })
    return {
      sessionDescription: { type: 'answer', sdp: 'answer-sdp' },
      tracks: tracks.map((t): TrackItem =>
        this.fail.has(t.trackName)
          ? { trackName: t.trackName, mid: t.mid, errorCode: 'failed', errorDescription: 'nope' }
          : { trackName: t.trackName, mid: t.mid },
      ),
    }
  }
  async addRemoteTracks(sessionId: string, tracks: Array<{ sessionId: string; trackName: string }>): Promise<TracksResponse> {
    this.calls.push({ op: 'addRemoteTracks', sessionId, tracks })
    return {
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: 'offer', sdp: 'offer-sdp' },
      tracks: tracks.map((t): TrackItem => ({ sessionId: t.sessionId, trackName: t.trackName, mid: String(++this.mids) })),
    }
  }
  async renegotiate(sessionId: string, answerSdp: string) {
    this.calls.push({ op: 'renegotiate', sessionId, answerSdp })
  }
  async closeTracks(sessionId: string, mids: string[], opts: { offerSdp?: string; force?: boolean } = {}): Promise<TracksResponse> {
    this.calls.push({ op: 'closeTracks', sessionId, mids, ...opts })
    return opts.offerSdp ? { sessionDescription: { type: 'answer', sdp: 'close-answer' } } : {}
  }
  async iceServers(): Promise<IceServer[]> {
    this.calls.push({ op: 'iceServers' })
    // What Cloudflare returns after the port 53 entries are removed by the real client; the fake
    // keeps one on purpose so a test can see the router never adds it back.
    return [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]
  }
  of(op: string) {
    return this.calls.filter((c) => c.op === op)
  }
}

/** A fake Telnyx: records what it was asked, answers like Telnyx does, and can be told to refuse. */
export class FakeTelnyx implements Telnyx {
  /** Whatever each call was given. */
  calls: Array<{ op: string; [k: string]: any }> = []
  failDial = false
  duringDial: (() => Promise<void>) | null = null
  failRegister: 'no' | 'invalid' | 'down' = 'no'
  failBalance = false
  balanceUsd = 20
  private n = 0
  private legs = 0
  async createCredential(name: string) {
    this.calls.push({ op: 'createCredential', name })
    return { id: `cred-${++this.n}`, sipUsername: `gencred${this.n}` }
  }
  async loginToken(credentialId: string) {
    this.calls.push({ op: 'loginToken', credentialId })
    return `login-token-${++this.n}`
  }
  async dial(a: { to: string; from: string; fromName: string; linkTo: string; clientState: string; timeLimitSecs: number }) {
    // A test can do something while the dial request is out (the browser hangs up, an event for the new leg arrives early).
    await this.duringDial?.()
    if (this.failDial) {
      this.calls.push({ op: 'dial', ...a })
      throw new Error('Telnyx refused the dial')
    }
    const leg = `leg-${++this.legs}`
    this.calls.push({ op: 'dial', ...a, leg })
    return { leg }
  }
  failRing: 'no' | 'caller-number' | 'always' = 'no'
  /** A test can do something while a ring request is out (the caller hangs up, an event for the new leg arrives early). */
  duringRing: ((a: any) => Promise<void>) | null = null
  async ring(a: { to: string; from: string; fromName: string; linkTo: string; clientState: string; timeoutSecs: number; timeLimitSecs: number }) {
    await this.duringRing?.(a)
    if (this.failRing === 'always' || (this.failRing === 'caller-number' && a.from !== LINE_NUMBER)) {
      this.calls.push({ op: 'ring', ...a })
      throw new TelnyxError(422, 'invalid from')
    }
    const leg = `leg-${++this.legs}`
    this.calls.push({ op: 'ring', ...a, leg })
    return { leg }
  }
  async answer(leg: string, clientState: string) {
    this.calls.push({ op: 'answer', leg, clientState })
  }
  async bridge(leg: string, withLeg: string, clientState: string) {
    this.calls.push({ op: 'bridge', leg, withLeg, clientState })
  }
  async screen(leg: string, text: string, clientState: string) {
    this.calls.push({ op: 'screen', leg, text, clientState })
  }
  async speak(leg: string, text: string, clientState: string) {
    this.calls.push({ op: 'speak', leg, text, clientState })
  }
  async record(leg: string, maxSecs: number, clientState: string) {
    this.calls.push({ op: 'record', leg, maxSecs, clientState })
  }
  /** What a recording's sound is at Telnyx: a test sets `sound[id]`; one missing is a 404. */
  sound: Record<string, string> = {}
  failAudio = false
  failDeleteRecording = false
  async recordingAudio(recordingId: string, range: string | null) {
    this.calls.push({ op: 'recordingAudio', recordingId, range })
    if (this.failAudio) throw new TelnyxError(0, 'down')
    const body = this.sound[recordingId]
    if (body === undefined) return new Response('gone', { status: 404 })
    if (range) return new Response(body.slice(0, 4), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-3/${body.length}`, 'content-length': '4', 'accept-ranges': 'bytes' } })
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length), 'accept-ranges': 'bytes' } })
  }
  async deleteRecording(recordingId: string) {
    this.calls.push({ op: 'deleteRecording', recordingId })
    if (this.failDeleteRecording) throw new TelnyxError(500, 'Telnyx would not delete')
    delete this.sound[recordingId]
  }
  failHangup = false
  async hangup(leg: string) {
    this.calls.push({ op: 'hangup', leg })
    if (this.failHangup) throw new Error('Telnyx did not take the hang-up')
  }
  async registerEmergencyAddress(number: string, address: E911Address, name: { first: string; last: string; business: string }) {
    this.calls.push({ op: 'registerEmergencyAddress', number, address, name })
    if (this.failRegister === 'invalid') throw new TelnyxError(422, 'invalid address')
    if (this.failRegister === 'down') throw new TelnyxError(0, 'down')
    return { addressId: `addr-${++this.n}` }
  }
  async balance() {
    this.calls.push({ op: 'balance' })
    if (this.failBalance) throw new Error('down')
    return { availableUsd: this.balanceUsd }
  }
  of(op: string) {
    return this.calls.filter((c) => c.op === op)
  }
}

export const LINE_NUMBER = '+16265550100'

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64')

/** Telnyx's signing, played by a key of our own: `<timestamp>|<body>` signed with Ed25519. */
async function webhookSigner() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKey,
    async sign(body: string, ts: number, key: CryptoKey = pair.privateKey) {
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`${ts}|${body}`))
      return { 'telnyx-signature-ed25519': b64(sig), 'telnyx-timestamp': String(ts), 'content-type': 'application/json' }
    },
  }
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export async function accessStandIn(team: string = TEAM) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const fetchKeys: AccessDeps['fetch'] = async (url) => {
    if (url !== `https://${team}/cdn-cgi/access/certs`) return new Response('no', { status: 404 })
    return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] })
  }
  async function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; kid?: string; exp?: number } = {}) {
    const h = enc({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })
    const p = enc({ iss: `https://${team}`, aud: [AUD], exp: opts.exp ?? Math.floor(T0 / 1000) + 600, ...claims })
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
    return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
  }
  return { fetchKeys, sign }
}

export interface Harness {
  app: ReturnType<typeof createGuestApp>
  /** What the router runs with, for a test that calls the cron directly. */
  deps: Deps
  cores: Map<string, RoomCore>
  /** Statements that wrote to each call's storage. A name nobody started must stay at none. */
  writes: Map<string, number>
  clock: { now: number }
  rt: FakeRealtime
  /** The workspace's core, to look at its storage directly. */
  workspaceCore: WorkspaceCore
  /** The storage under it, to arrange a stored value no door would write (an address in an odd spelling). */
  workspaceSql: Sql
  /** The phone's core over the same storage, and who has the dial pad (change the record to add a person). */
  phoneCore: PhoneCore
  /** Make every post the phone core makes to the Phone conversation throw. */
  deskFails: { post: boolean }
  phonePeople: Record<string, { emergencyNumber: 'line' | string }>
  /** The phone's Telnyx: a fake, the number, and a signer for webhooks as Telnyx would sign them. */
  phone: { telnyx: FakeTelnyx; number: string; publicKey: string; sign: (body: string, ts?: number, key?: CryptoKey) => Promise<Record<string, string>> }
  /** Make the phone unconfigured (the Worker has no Telnyx secrets): `deps.phone` is null from then on. */
  phoneOff: { on: boolean }
  /** The people of the default install (Northfield's) that the Worker and the cores both read: push or splice to change who is Northfield Works. Ignored when the harness was given an install of its own. */
  teammates: string[]
  /** Every email the fake mailer was asked to send, in order. */
  mail: Outgoing[]
  /** Make the fake mailer refuse, as Cloudflare can. */
  mailFails: { on: boolean }
  /** What the workspace decided to tell whom, as the object's adapter would have received it. */
  delivered: Array<{ people: string[]; change: Change }>
  /** Sockets the workspace was told to close. */
  closed: Array<Extract<Effect, { t: 'close' }>>
  /** Sockets the router opened, in order. */
  sockets: Array<{ person: string; session: string | null; endsAt: number }>
  /** Who has the page open, for the nudge check (the object knows this in production). */
  online: Set<string>
  /** The per-IP limit on the guests' sign-in: how many tries a caller may make (default no limit), and the keys it saw. */
  authLimit: { max: number; keys: string[] }
  /** How many times the router asked the Workspace object for anything: a refusal before it must leave this alone. */
  workspaceCalls: { n: number }
  /** Add to the usage ledger directly, to arrange a month that is nearly spent. */
  spend(bytes: number): void
  call(
    method: string,
    path: string,
    body?: unknown,
    opts?: { token?: string; headers?: Record<string, string>; origin?: string },
  ): Promise<{ status: number; json: any; headers: Headers }>
  /**
   * TEST ONLY: a Northfield Works person's door onto the same handlers the guests' door runs, behind a signed Access assertion (or, on a localhost host with the
   * development bypass, none), under `TEAMMATE_DOOR`. Production has no such door (it was /start/api/w); the Workspace's rules are still
   * checked as a teammate through it, because a teammate is the actor most of them are about. `app` (above) is the real router and answers nothing there.
   */
  teammateApp: { request(url: string, init: RequestInit): Response | Promise<Response> }
  callTeammate(
    method: string,
    path: string,
    body?: unknown,
    opts?: { token?: string; headers?: Record<string, string>; origin?: string },
  ): Promise<{ status: number; json: any; headers: Headers }>
  /** A call made the way the space makes one, for the tests that need a call to exist: its name. (The /start route that did this is gone.) */
  startCall(by?: string): Promise<string>
  /** The same, to the routes the space's Worker mounts for the team (the socket and the phone: src/space-app.ts), for the person the space's check named (null: nobody). */
  callPart(
    as: string | null,
    method: string,
    path: string,
    body?: unknown,
    opts?: { token?: string; headers?: Record<string, string>; origin?: string },
  ): Promise<{ status: number; json: any; headers: Headers }>
}

async function ask(
  app: { request(url: string, init: RequestInit): Response | Promise<Response> },
  method: string,
  path: string,
  body: unknown,
  o: { token?: string; headers?: Record<string, string>; origin?: string },
) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (o.token) headers['x-member-token'] = o.token
  if (o.origin) headers.origin = o.origin
  const url = path.startsWith('http') ? path : `http://localhost${path}`
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

export async function harness(
  opts: { devBypass?: boolean; aud?: string; teammates?: string[]; install?: Install; phonePeople?: Record<string, { emergencyNumber: 'line' | string }>; phoneCap?: number } = {},
): Promise<Harness & { access: Awaited<ReturnType<typeof accessStandIn>> }> {
  const cores = new Map<string, RoomCore>()
  const writes = new Map<string, number>()
  const clock = { now: T0 }
  const rt = new FakeRealtime()
  resetJwksCache() // the verifier caches keys per team; every harness has a new key
  const access = await accessStandIn(opts.install?.teamDomain ?? TEAM)
  let seed = 1
  const core = (name: string) => {
    let c = cores.get(name)
    if (!c) {
      c = new RoomCore(memSql(() => writes.set(name, (writes.get(name) ?? 0) + 1)))
      cores.set(name, c)
    }
    return c
  }
  const client = (name: string) => roomClient((method, args) => invokeCore(core(name), method, structuredClone(args)))
  // The workspace: the real core over bun:sqlite, with what the object's adapter does (drain the outbox) recorded.
  const teammates = opts.teammates ?? (opts.install ? opts.install.people.map((p) => p.address) : [OWNER, ANA, BEN])
  const install = () => opts.install ?? installFor(teammates)
  const wsSql = memSql()
  const workspaceCore = new WorkspaceCore(wsSql, install)
  const phonePeople = opts.phonePeople ?? { [OWNER]: { emergencyNumber: 'line' } }
  // The desk the phone core posts through; a test can make its posts fail (a workspace that throws must never stop a 911 dial).
  const desk = workspaceCore.phoneDesk()
  const deskFails = { post: false }
  const phoneCore = new PhoneCore(
    wsSql,
    install,
    () => phonePeople,
    opts.phoneCap,
    {
      ...desk,
      post: (text, phone, now) => {
        if (deskFails.post) throw new Error('the workspace could not post')
        return desk.post(text, phone, now)
      },
    },
  )
  const telnyx = new FakeTelnyx()
  const signer = await webhookSigner()
  const phoneOff = { on: false }
  const mail: Outgoing[] = []
  const mailFails = { on: false }
  const mailer: Mailer = {
    async send(message) {
      if (mailFails.on) throw new Error('Cloudflare refused the send')
      mail.push(message)
      return { messageId: `m${mail.length}` }
    },
  }
  const delivered: Harness['delivered'] = []
  const closed: Harness['closed'] = []
  const sockets: Harness['sockets'] = []
  const online = new Set<string>()
  const authLimit: Harness['authLimit'] = { max: Number.POSITIVE_INFINITY, keys: [] }
  const workspaceCalls = { n: 0 }
  const workspace = () =>
    workspaceClient((method, args) => {
      workspaceCalls.n += 1
      try {
        return invokeWorkspace(workspaceCore, method, method === 'dueNudges' || method === 'sweep' ? [args[0], [...online]] : structuredClone(args))
      } finally {
        for (const e of workspaceCore.takeOutbox()) {
          if (e.t === 'deliver') delivered.push({ people: e.people, change: e.change })
          else closed.push(e)
        }
      }
    })
  const phoneRt: PhoneRuntime = { telnyx, publicKey: signer.publicKey, number: LINE_NUMBER, connectionId: 'conn-1', sdk: 'telnyx', dev: false }
  const deps: Deps = {
    phoneCore: () =>
      phoneClient((method, args) => {
        try {
          return invokePhone(phoneCore, method, structuredClone(args))
        } finally {
          // As the object's adapter does: what the phone posted to the Phone conversation is delivered.
          for (const e of workspaceCore.takeOutbox()) {
            if (e.t === 'deliver') delivered.push({ people: e.people, change: e.change })
            else closed.push(e)
          }
        }
      }),
    get phone() {
      return phoneOff.on ? null : phoneRt
    },
    room: client,
    ledger: () => client(LEDGER_NAME),
    workspace,
    mailer,
    get install() {
      return install()
    },
    appOrigin: 'https://space.northfield.example',
    authLimit: async (key) => {
      authLimit.keys.push(key)
      return authLimit.keys.filter((k) => k === key).length <= authLimit.max
    },
    get devTeammate() {
      return install().owner().signIn
    },
    devMail: null,
    openSocket: async (who) => {
      sockets.push(who)
      return new Response('socket', { status: 200 })
    },
    realtime: rt,
    devBypass: opts.devBypass ?? true,
    now: () => clock.now,
    // Deterministic but never repeating, so two calls never share a name.
    randomBytes: (n) => Uint8Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff),
  }
  const app = createGuestApp(() => deps)
  const partNames = new WeakMap<Request, string>()
  const partApp = createSpaceApp(() => deps, (req) => partNames.get(req) ?? null)
  // The test-only teammates' door (see Harness.teammateApp): who Access says is asking, as it was checked at /start/api/w, then the shared handlers and the phone's.
  const doors = new WeakMap<Request, Door>()
  const door = (c: { req: { raw: Request } }): Door => doors.get(c.req.raw) as Door
  const tmDoor = new Hono()
  tmDoor.use('*', async (c, next) => {
    const outcome = await identify(deps.install, c.req.raw.headers, { fetch: access.fetchKeys, aud: opts.aud ?? AUD, now: clock.now })
    let person: { address: string } | null = null
    let exp: number | null = null
    if (outcome.ok) {
      if (outcome.identity.kind !== 'person') return c.json({ error: 'Forbidden' }, 403)
      person = outcome.identity.person
      exp = outcome.identity.exp
    } else if (outcome.refusal === 'no-assertion') {
      if (!(deps.devBypass && isLocal(c))) return c.json({ error: 'Unauthorized' }, 401)
      const dev = deps.install.personBySignIn(deps.devTeammate)
      if (!dev) return c.json({ error: 'Forbidden' }, 403)
      person = dev
    } else return c.json({ error: outcome.refusal === 'invalid' ? 'Unauthorized' : 'Forbidden' }, outcome.refusal === 'invalid' ? 401 : 403)
    doors.set(c.req.raw, { actor: { via: 'access', email: person.address }, endsAt: exp === null ? clock.now + DAY : exp * 1000 })
    return next()
  })
  tmDoor.route('/', workspaceHandlers(() => deps, door))
  mountPhoneTeammates(tmDoor, () => deps, (c) => {
    const actor = door(c).actor
    return actor.via === 'access' ? actor.email : ''
  })
  const teammateApp = new Hono()
  teammateApp.onError(answerError)
  teammateApp.route(TEAMMATE_DOOR, tmDoor)
  return {
    app,
    teammateApp,
    callTeammate: (method, path, body, o = {}) => ask(teammateApp, method, path, body, o),
    startCall: (by = install().owner().address) => makeCall(deps, by),
    deps,
    cores,
    writes,
    clock,
    rt,
    workspaceCore,
    workspaceSql: wsSql,
    phoneCore,
    deskFails,
    phonePeople,
    phone: { telnyx, number: LINE_NUMBER, publicKey: signer.publicKey, sign: (body, ts = Math.floor(clock.now / 1000), key) => signer.sign(body, ts, key) },
    phoneOff,
    teammates,
    mail,
    mailFails,
    delivered,
    closed,
    sockets,
    online,
    authLimit,
    workspaceCalls,
    access,
    spend: (bytes) => core(LEDGER_NAME).addUsage('2026-10', bytes),
    call: (method, path, body, o = {}) => ask(app, method, path, body, o),
    callPart: (as, method, path, body, o = {}) =>
      ask(
        {
          request: (url, init) => {
            const req = new Request(url, init)
            if (as) partNames.set(req, as)
            return partApp.fetch(req)
          },
        },
        method,
        path,
        body,
        o,
      ),
  }
}

/** A member token: 22 or more URL-safe characters, as the browser makes them. */
export const token = (who: string) => `${who}-token-`.padEnd(24, 'x')
