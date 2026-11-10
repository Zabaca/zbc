// The phone's rules: who may call, which number, whether, and what a call adds to the month. PhoneCore runs INSIDE the
// Workspace Durable Object, over the same synchronous SQLite as WorkspaceCore, and never calls the network, exactly as
// the Room and the Workspace do (docs/adr/0001, section 2; docs/adr/0004). Nothing here awaits. The router does
// everything external (Telnyx, the email) and is handed what to do as data: a list of PhoneActions.
//
// Who is asking arrives as an address the router has verified at the space's door (the space's Access assertion, then the teammate
// list); this core checks it again against the list and against the declaration's `phone.people`, so a route added later and forgotten still
// cannot hand the phone to a guest. Hashes (a ticket's) are made by the router, because WebCrypto's digest is
// asynchronous and this core is not.
//
// How a call is held (docs/adr/0004, section 2): the Telnyx connection parks every browser call and asks the webhook. The
// page first asks `issueTicket` for the number it wants, which runs every rule and answers with a single-use ticket tied to
// that number; the parked call must present it, and `webhook` runs the rules again. So a page that was tampered with, or a
// stolen login token, places nothing: the only call that needs no ticket is 911.

import { LINE, lineWords } from './phone-line'
import {
  type CallLogRow,
  type CallOutcome,
  type Destination,
  type E911Address,
  MESSAGES,
  MINUTE,
  NOTICE_911,
  type LineSettings,
  type PhoneMessage,
  type PhoneStatus,
  type Reason,
  addressLine,
  cleanAddress,
  displayNumber,
  isEmergency,
  parseDestination,
} from './phone-model'
import { RoomError, type Sql } from './room'
import type { PhoneEvent } from './telnyx'
import type { Install } from '@space/workspace'
import { nameFromEmail } from './workspace-model'

/** The phone's tables, made by PhoneCore on every boot. Never edit one that has been deployed: add a column to PHONE_ADDITIONS. */
export const PHONE_TABLES = [
  // One row per person of the company who has opened the phone. `who` is the opaque id the page puts on a call.
  `CREATE TABLE IF NOT EXISTS phone_profiles (
    email TEXT PRIMARY KEY,
    who TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    street TEXT, extended TEXT, city TEXT, state TEXT, zip TEXT,
    address_at INTEGER,
    registered_at INTEGER,
    checked_region TEXT,
    credential_id TEXT,
    sip_username TEXT
  )`,
  // An approval to call one number: kept hashed, spent once, 60 seconds.
  `CREATE TABLE IF NOT EXISTS phone_tickets (
    hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    e164 TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // The call log. A browser leg and the leg meet dialed are one row; `counted` makes the minutes land once.
  `CREATE TABLE IF NOT EXISTS phone_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    email TEXT,
    to_number TEXT NOT NULL,
    browser_leg TEXT UNIQUE,
    dial_leg TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    emergency INTEGER NOT NULL DEFAULT 0,
    address TEXT,
    answered_at INTEGER,
    ended_at INTEGER,
    minutes INTEGER NOT NULL DEFAULT 0,
    counted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS phone_calls_email ON phone_calls (email, id)`,
  `CREATE TABLE IF NOT EXISTS phone_minutes (month TEXT PRIMARY KEY, minutes INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS phone_alerts (month TEXT NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (month, level))`,
  // Events Telnyx has told us of, so one delivered twice is acted on once.
  `CREATE TABLE IF NOT EXISTS phone_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // 911 notices sent, so the page's report and Telnyx's webhook for one call are one email.
  `CREATE TABLE IF NOT EXISTS phone_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT)`,
  `CREATE TABLE IF NOT EXISTS phone_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  // Legs of calls the browser abandoned that meet still has to hang up (the first try may not have been taken).
  `CREATE TABLE IF NOT EXISTS phone_hangups (leg TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // Calls in (docs/adr/0005). The line's settings a person of the company edits: the cell and how long meet rings first.
  `CREATE TABLE IF NOT EXISTS phone_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Every leg of a call in: the caller's (role caller), each person's phone that rings (ring) and the cell (cell). A
  // row exists before Telnyx's id for the leg does, so an event that beats the dial request's answer still finds it.
  `CREATE TABLE IF NOT EXISTS phone_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    email TEXT,
    leg TEXT,
    state TEXT,
    answered_at INTEGER,
    ended_at INTEGER,
    counted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS phone_legs_leg ON phone_legs (leg)`,
  `CREATE INDEX IF NOT EXISTS phone_legs_call ON phone_legs (call_id)`,
  // A voicemail: the recording stays at Telnyx and is named here by its id; the message in the Phone conversation points at this row.
  `CREATE TABLE IF NOT EXISTS phone_voicemails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL UNIQUE,
    message_id INTEGER,
    recording_id TEXT NOT NULL,
    from_number TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
]

/** Columns added to PHONE_TABLES' tables after they were deployed. Append only; added by `ALTER TABLE` on the next boot that lacks them. */
export const PHONE_ADDITIONS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  // The random half of the client state on the leg meet dials: an event is trusted as that leg's only with its leg id or this.
  { table: 'phone_calls', column: 'nonce', definition: 'TEXT' },
  // A call in: its direction ('in'; null is a call out), who called, where it is (meet, cell, voicemail, taken), who took
  // it, the leg to bridge to the caller once the caller is answered, and whether it has been wound up (the missed line posted).
  { table: 'phone_calls', column: 'direction', definition: 'TEXT' },
  { table: 'phone_calls', column: 'from_number', definition: 'TEXT' },
  { table: 'phone_calls', column: 'stage', definition: 'TEXT' },
  { table: 'phone_calls', column: 'answered_by', definition: 'TEXT' },
  { table: 'phone_calls', column: 'bridge_to', definition: 'INTEGER' },
  { table: 'phone_calls', column: 'closed', definition: 'INTEGER NOT NULL DEFAULT 0' },
]

/** A call's approval (not the workspace's socket ticket) lasts this long and is spent by one call. */
export const CALL_APPROVAL_TTL_MS = 60_000
/** A dial whose leg meet has not stored yet is "in flight" this long. */
export const IN_FLIGHT_MS = 20_000
const HOUR_MS = 60 * MINUTE
/** One 911 notice per person in this window: the page's report and Telnyx's webhook of the same call are one. */
export const NOTICE_WINDOW_MS = 2 * MINUTE
/** Events and ended calls' tickets are kept this long, for the duplicates a retry can bring. */
const KEEP_MS = 7 * 24 * 60 * MINUTE
/** A call in still being worked after this long has lost an event: the cron winds it up. */
export const STALE_CALL_MS = 10 * MINUTE
/** A caller still on the line this long after being answered for the voicemail (a greeting, up to 3 minutes, and a margin) is hung up. */
export const VOICEMAIL_DEADLINE_MS = (LINE.inbound.voicemailSeconds + 90) * 1000
/** The meter's alerts, as a share of the cap. */
export const ALERT_LEVELS = [80, 100] as const

interface ProfileRow {
  email: string
  who: string
  created_at: number
  acked_at: number | null
  street: string | null
  extended: string | null
  city: string | null
  state: string | null
  zip: string | null
  address_at: number | null
  registered_at: number | null
  checked_region: string | null
  credential_id: string | null
  sip_username: string | null
}

interface CallRow {
  id: number
  at: number
  email: string | null
  to_number: string
  browser_leg: string | null
  dial_leg: string | null
  outcome: CallOutcome
  reason: string | null
  emergency: number
  address: string | null
  answered_at: number | null
  ended_at: number | null
  minutes: number
  counted: number
  nonce: string | null
  direction: 'in' | null
  from_number: string | null
  stage: 'meet' | 'cell' | 'voicemail' | 'taken' | null
  answered_by: string | null
  bridge_to: number | null
  closed: number
}

interface LegRow {
  id: number
  call_id: number
  role: 'caller' | 'ring' | 'cell'
  email: string | null
  leg: string | null
  state: string | null
  answered_at: number | null
  ended_at: number | null
  counted: number
}

/**
 * What the phone core may do in the workspace, handed to it by whoever builds both (workspace.ts `phoneDesk`): post as "Phone" in
 * the Phone conversation, remove what it posted, and say which of the company's people are owed an email (and count those against the hour's
 * allowance). Nothing else of the workspace is reachable from here.
 */
export interface PhoneDesk {
  post(text: string, phone: PhoneMessage, now: number): number
  remove(messageId: number, now: number): void
  /** What the phone posted as this message (the kind and what it carries), or null when it is not one of the phone's. */
  phoneMessage(messageId: number): PhoneMessage | null
  audience(now: number): string[]
}

/** What the router must do after a decision. The core only says; it never does. */
export type PhoneAction =
  | { do: 'dial'; callId: number; nonce: string; browserLeg: string; to: string; from: 'line' | string }
  | { do: 'hangup'; leg: string }
  // Calls in. `leg` is the leg row's id in phone_legs; the router makes the client state from `callId`, `nonce` and it.
  | { do: 'ring'; callId: number; nonce: string; leg: number; role: 'ring' | 'cell'; to: string; from: string; fromName: string; link: string; timeoutSecs: number }
  | ({ do: 'answer' } & LegCommand)
  | ({ do: 'bridge'; with: string } & LegCommand)
  | ({ do: 'screen'; text: string } & LegCommand)
  | ({ do: 'speak'; text: string } & LegCommand)
  | ({ do: 'record'; maxSecs: number } & LegCommand)
  | { do: 'voicemail-mail'; to: string; number: string; seconds: number }
  | ({ do: 'notify911' } & Notice911)
  | { do: 'alert'; level: number; used: number; cap: number }

/** A command on a leg of a call in: Telnyx's id for it, and what its client state is made from. */
export interface LegCommand {
  callId: number
  nonce: string
  legRow: number
  leg: string
}

export interface Notice911 {
  /** The person, or null when the call could not be matched to anyone. */
  email: string | null
  name: string
  address: string | null
  /** The number dialed: 911, or 933 for the test line (which sends no notice). */
  to: string
  at: number
}

/** A Telnyx event as the core takes it: the approval is already hashed (the router's digest is asynchronous). */
export type CoreEvent = Omit<PhoneEvent, 'ticket'> & { ticketHash: string | null }

export type Authorized = { ok: true; dest: Destination } | { ok: false; reason: Reason; message: string }

export class PhoneCore {
  constructor(
    private readonly sql: Sql,
    /** The company's install (packages/workspace): who is a teammate and who owns the line. Read at every use so a test can change it. */
    private readonly install: () => Install,
    /** Who has the dial pad and which number their 911 calls leave from: the install's declaration (`phone.people`), asked afresh at every use. A test gives its own list. */
    private readonly people: () => Readonly<Record<string, { emergencyNumber: 'line' | string }>> = () => install().phonePeople(),
    private readonly cap: number = LINE.monthlyMinutes,
    /** The Phone conversation, for what a call in leaves there (voicemail, a missed call). Null where there is no workspace to post in. */
    private readonly desk: PhoneDesk | null = null,
  ) {
    // This core owns the phone's tables: they are made here, on every boot, and nowhere else (docs/adr/0004, section 3).
    for (const stmt of PHONE_TABLES) this.sql.run(stmt)
    for (const { table, column, definition } of PHONE_ADDITIONS) {
      const have = new Set(this.sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
      if (!have.has(column)) this.sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  // --- Who ----------------------------------------------------------------------

  /** A person with the dial pad: the install's phone switch is on AND they are on the teammate list AND named in the declaration's `phone.people`. Anyone else is no phone person. */
  eligible(email: string): boolean {
    return this.install().has('phone') && this.install().person(email) !== null && Object.hasOwn(this.people(), email)
  }

  /** Whether this address is an owner of the company, who alone sets where the line's calls go. */
  private isLineOwner(email: string): boolean {
    const install = this.install()
    const person = install.person(email)
    return person !== null && install.isOwner(person)
  }

  /** The number this person's 911 calls leave from: 'line' for the line's number, or a number of their own. */
  emergencyNumber(email: string): 'line' | string | null {
    return this.eligible(email) ? (this.people()[email]?.emergencyNumber ?? null) : null
  }

  private require(email: string): ProfileRow {
    if (!this.eligible(email)) throw new RoomError(403, MESSAGES['not-allowed'])
    return this.profile(email)
  }

  private profile(email: string): ProfileRow {
    const held = this.sql.all<ProfileRow>('SELECT * FROM phone_profiles WHERE email = ?', email)[0]
    if (held) return held
    const who = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
    this.sql.run('INSERT INTO phone_profiles (email, who, created_at) VALUES (?, ?, ?)', email, who, Date.now())
    return this.sql.all<ProfileRow>('SELECT * FROM phone_profiles WHERE email = ?', email)[0] as ProfileRow
  }

  private addressOf(p: ProfileRow): E911Address | null {
    return p.street && p.city && p.state && p.zip ? { street: p.street, extended: p.extended ?? '', city: p.city, state: p.state, zip: p.zip } : null
  }

  private isReady(p: ProfileRow): boolean {
    return p.acked_at !== null && this.addressOf(p) !== null && p.registered_at !== null
  }

  // --- The month's minutes ----------------------------------------------------------

  private month = (now: number): string => new Date(now).toISOString().slice(0, 7)

  minutesUsed(now: number): number {
    return this.sql.all<{ minutes: number }>('SELECT minutes FROM phone_minutes WHERE month = ?', this.month(now))[0]?.minutes ?? 0
  }

  // --- What the page shows ----------------------------------------------------------

  /** The phone as this person sees it. `line` and `sdk` are the router's to fill in (they come from its settings). */
  status(email: string, now: number, region: string | null): Omit<PhoneStatus, 'available' | 'sdk' | 'line' | 'lineDisplay' | 'callerName'> & { eligible: boolean } {
    if (!this.eligible(email)) {
      return { eligible: false, who: '', acked: false, address: null, registered: false, addressCheck: false, ready: false, minutes: { used: 0, cap: this.cap }, notice: NOTICE_911, settings: { cell: null, cellDisplay: null, ringSeconds: LINE.inbound.ringSeconds }, canEditLine: false }
    }
    const p = this.profile(email)
    const address = this.addressOf(p)
    return {
      eligible: true,
      who: p.who,
      acked: p.acked_at !== null,
      address,
      registered: p.registered_at !== null,
      // Asked only when Cloudflare knows the region, it is not the address's state, and the person has not already said it is right.
      addressCheck: Boolean(address && region && region !== address.state && region !== p.checked_region),
      ready: this.isReady(p),
      minutes: { used: this.minutesUsed(now), cap: this.cap },
      notice: NOTICE_911,
      settings: this.settings(),
      canEditLine: this.isLineOwner(email),
    }
  }

  ack(email: string, now: number): void {
    this.require(email)
    this.sql.run('UPDATE phone_profiles SET acked_at = COALESCE(acked_at, ?) WHERE email = ?', now, email)
  }

  /**
   * Keep the address the person gave. Telnyx must hold it before a call out is allowed, so it is "not registered" until
   * the router has put it there and says so with `addressRegistered`.
   */
  saveAddress(email: string, raw: unknown, now: number): { address: E911Address; at: number; name: { first: string; last: string; business: string }; number: 'line' | string } {
    this.require(email)
    const cleaned = cleanAddress(raw)
    if (!cleaned.ok) throw new RoomError(400, cleaned.message)
    const a = cleaned.address
    this.sql.run(
      'UPDATE phone_profiles SET street = ?, extended = ?, city = ?, state = ?, zip = ?, address_at = ?, registered_at = NULL, checked_region = NULL WHERE email = ?',
      a.street,
      a.extended,
      a.city,
      a.state,
      a.zip,
      now,
      email,
    )
    const words = nameFromEmail(email).split(' ')
    const company = this.install().company.name
    return { address: a, at: now, name: { first: words[0] ?? company, last: words.slice(1).join(' ') || company, business: company }, number: this.emergencyNumber(email) as 'line' | string }
  }

  /** The router put the address `at` on the number. A newer address has moved on since if `at` no longer matches. */
  addressRegistered(email: string, at: number, now: number): boolean {
    this.require(email)
    const done = this.sql.all<{ email: string }>('UPDATE phone_profiles SET registered_at = ? WHERE email = ? AND address_at = ? RETURNING email', now, email, at)
    return done.length > 0
  }

  /** "Yes, my address is right" in the region the page reported: not asked again for it. */
  confirmAddress(email: string, region: string | null): void {
    this.require(email)
    if (region) this.sql.run('UPDATE phone_profiles SET checked_region = ? WHERE email = ?', region, email)
  }

  // --- A phone's login ---------------------------------------------------------------

  credentialOf(email: string): { id: string; sipUsername: string } | null {
    const p = this.require(email)
    return p.credential_id && p.sip_username ? { id: p.credential_id, sipUsername: p.sip_username } : null
  }

  saveCredential(email: string, id: string, sipUsername: string): void {
    this.require(email)
    this.sql.run('UPDATE phone_profiles SET credential_id = ?, sip_username = ? WHERE email = ?', id, sipUsername, email)
  }

  // --- Deciding a call --------------------------------------------------------------

  /** Every rule for a call out, in one place: the page's approval and the webhook's recheck both run it. */
  authorize(email: string, rawTo: unknown, now: number): Authorized {
    if (!this.eligible(email)) return { ok: false, reason: 'not-allowed', message: MESSAGES['not-allowed'] }
    const parsed = parseDestination(rawTo)
    if (!parsed.ok) return parsed
    // 911 and 933 pass every rule below: no setup, no cap.
    if (isEmergency(parsed.dest)) return parsed
    if (!this.isReady(this.profile(email))) return { ok: false, reason: 'setup', message: MESSAGES.setup }
    if (this.minutesUsed(now) >= this.cap) return { ok: false, reason: 'cap', message: MESSAGES.cap }
    return parsed
  }

  /**
   * The page's first step for a call: run the rules and, for a call that is allowed and is not 911, keep a single-use
   * approval for exactly that number. 911 needs none (nothing may delay it). A refusal is data, with its reason.
   */
  issueTicket(email: string, rawTo: unknown, ticketHash: string, now: number): Authorized & { ticket?: boolean } {
    const a = this.authorize(email, rawTo, now)
    if (!a.ok || isEmergency(a.dest)) return a
    this.sql.run('DELETE FROM phone_tickets WHERE expires_at <= ?', now)
    this.sql.run('INSERT INTO phone_tickets (hash, email, e164, expires_at) VALUES (?, ?, ?, ?)', ticketHash, email, a.dest.e164, now + CALL_APPROVAL_TTL_MS)
    return { ...a, ticket: true }
  }

  private claimNotice(email: string | null, now: number): boolean {
    const recent = this.sql.all('SELECT 1 FROM phone_notices WHERE at > ? AND email IS ?', now - NOTICE_WINDOW_MS, email)
    if (recent.length > 0) return false
    this.sql.run('INSERT INTO phone_notices (at, email) VALUES (?, ?)', now, email)
    return true
  }

  /**
   * 911 was dialed. The details to tell the owner, or null when this person's notice has already gone in the last two minutes
   * (the page reports it and Telnyx's webhook sees it: one email). Never refuses: whoever is on this list and is asked,
   * and an address that is not one of ours is still told as "unidentified".
   */
  notify911(email: string | null, to: string, now: number): Notice911 | null {
    const known = email !== null && this.eligible(email) ? email : null
    if (!this.claimNotice(known, now)) return null
    const p = known ? this.profile(known) : null
    const address = p ? this.addressOf(p) : null
    const notice = { email: known, name: known ? nameFromEmail(known) : 'Someone', address: address ? addressLine(address) : null, to, at: now }
    // Every person of the company sees it in the Phone conversation (the email goes to the owner alone). Posted once per notice, like the email.
    // Nothing may stand between a person and 911, and this runs in the same step that decides the dial: whatever the post does,
    // it never reaches the caller of this method, so the dial and the email go on.
    try {
      this.desk?.post(`911 was dialed from meet by ${notice.name}.${notice.address ? ` The address given to the emergency service: ${notice.address}.` : ' meet holds no address for them.'}`, { kind: 'emergency' }, now)
    } catch (err) {
      console.error('the 911 notice could not be posted in the Phone conversation', err instanceof Error ? err.message : err)
    }
    return notice
  }

  private personByWho(who: string | null): string | null {
    if (!who) return null
    const row = this.sql.all<{ email: string }>('SELECT email FROM phone_profiles WHERE who = ?', who)[0]
    return row && this.eligible(row.email) ? row.email : null
  }

  private callRow(id: number): CallRow | null {
    return this.sql.all<CallRow>('SELECT * FROM phone_calls WHERE id = ?', id)[0] ?? null
  }

  private newCall(a: { now: number; email: string | null; to: string; browserLeg: string; outcome: CallOutcome; reason: string | null; emergency: boolean; address: string | null }): { id: number; nonce: string } {
    // The nonce rides in the client state of the leg meet dials: 64 random bits, so an id a thief could count to is not enough.
    const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const [row] = this.sql.all<{ id: number }>(
      'INSERT INTO phone_calls (at, email, to_number, browser_leg, outcome, reason, emergency, address, nonce) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      a.now,
      a.email,
      a.to,
      a.browserLeg,
      a.outcome,
      a.reason,
      a.emergency ? 1 : 0,
      a.address,
      nonce,
    )
    return { id: (row as { id: number }).id, nonce }
  }

  /** Telnyx's event is new: it is recorded, and false means it has been seen before. */
  private firstSight(id: string, now: number): boolean {
    return this.sql.all('INSERT INTO phone_events (id, at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id', id, now).length > 0
  }

  /**
   * One Telnyx event, from the webhook the router has verified. The events that matter:
   * - `call.initiated` for a call the browser placed (parked at Telnyx): this decides whether it goes out. NOT one meet
   *   dialed itself: those are told apart by the leg id meet stored, by the client state meet made (carrying a random nonce a
   *   browser cannot guess), and, in the moment before the leg id is stored, by a dial to that very number in flight;
   * - `call.answered` and `call.hangup` on the leg meet dialed: the minutes;
   * - `call.hangup` on the browser's leg: meet's dialed leg goes down with it.
   * - a call to the line's number (or to a person's own 911 number), and the legs meet makes for it: see "Calls in" below. `line`
   *   is the line's number, which the router knows and the core does not.
   * Everything else is ignored.
   */
  webhook(ev: CoreEvent, now: number, line: string = ''): PhoneAction[] {
    if (!this.firstSight(ev.id, now)) return []
    // A call in, and every leg meet made for one, is its own flow (below). It is decided BEFORE the rules for a browser's call, so
    // nothing written for a call out (the in-flight dial, meet's own leg) can swallow or mistake it, and a call out is never read as one.
    const inbound = this.inboundLeg(ev)
    if (inbound) return this.inboundEvent(inbound, ev, now)
    if (ev.type === 'call.initiated' && this.isInbound(ev, line)) return this.startInbound(ev, now)
    const own = this.dialedRow(ev)
    if (ev.type === 'call.initiated') {
      // meet's own leg: never handled as a browser's.
      if (own) return []
      // So is an event with no browser client state (the page always sends who and an approval; meet's own leg never does) for a
      // number meet is dialing this moment, before its leg id is stored. A browser's call, with its own state, is never swallowed.
      if (ev.who === null && ev.ticketHash === null && this.dialInFlight(ev, now)) return []
      return this.isBrowserCall(ev) ? this.parked(ev, now) : []
    }
    if (ev.type === 'call.answered') return own ? this.answered(own, ev) : []
    if (ev.type === 'call.hangup') return own ? this.dialedEnded(own, ev) : this.browserEnded(ev, now)
    return []
  }

  /**
   * A call the browser placed and Telnyx is holding: outgoing, or in Telnyx's `parked` state. An incoming call is never one,
   * whatever its state (a call to the line's number, a 911 dispatcher's callback): inbound is handled under "Calls in" below, and meet leaves it
   * alone rather than hang it up. (The router has already dropped events on another connection than meet's own.)
   */
  private isBrowserCall(ev: CoreEvent): boolean {
    if (ev.direction === 'incoming' || ev.direction === 'inbound') return false
    return ev.state === 'parked' || ev.direction === 'outgoing'
  }

  /**
   * The call this event is about, when it is on the leg meet dialed: the leg is the one stored for that call, or (before
   * the router has stored it) the event carries that call's id AND its random nonce. Client state alone never decides: a
   * browser sets its own call's client state, and an id a thief could count to must not reach another call's log or meter.
   * A leg that claims a call whose stored leg is a different one is not that call's.
   */
  private dialedRow(ev: CoreEvent): CallRow | null {
    const byLeg = this.sql.all<CallRow>('SELECT * FROM phone_calls WHERE dial_leg = ? AND direction IS NULL', ev.leg)[0]
    if (byLeg) return byLeg
    if (!ev.ours) return null
    // A call in has legs of its own (phone_legs): this is the dialed leg of a call out, found by the id and nonce meet put on it.
    const row = this.sql.all<CallRow>(`SELECT * FROM phone_calls WHERE id = ? AND nonce = ? AND direction IS NULL`, ev.ours.id, ev.ours.nonce)[0]
    if (!row || row.dial_leg !== null) return null
    // The router has not stored the leg yet: this is it. Remember, so the rest of its events match by leg.
    this.sql.run('UPDATE phone_calls SET dial_leg = ? WHERE id = ? AND dial_leg IS NULL', ev.leg, row.id)
    return { ...row, dial_leg: ev.leg }
  }

  /** A dial to this number was started a moment ago and its leg is not stored: an event for the same number is that leg's. */
  private dialInFlight(ev: CoreEvent, now: number): boolean {
    const dest = parseDestination(ev.to)
    if (!dest.ok) return false
    return (
      this.sql.all(`SELECT 1 FROM phone_calls WHERE outcome = 'dialing' AND dial_leg IS NULL AND to_number = ? AND at > ? AND browser_leg != ?`, dest.dest.e164, now - IN_FLIGHT_MS, ev.leg).length > 0
    )
  }

  private parked(ev: CoreEvent, now: number): PhoneAction[] {
    if (this.sql.all('SELECT 1 FROM phone_calls WHERE browser_leg = ?', ev.leg).length > 0) return []
    const dest = parseDestination(ev.to)
    const refuse = (email: string | null, reason: string): PhoneAction[] => {
      this.newCall({ now, email, to: dest.ok ? dest.dest.e164 : ev.to.slice(0, 40), browserLeg: ev.leg, outcome: 'refused', reason, emergency: false, address: null })
      return [{ do: 'hangup', leg: ev.leg }]
    }
    if (!dest.ok) return refuse(null, dest.reason)

    if (isEmergency(dest.dest)) {
      // Nothing is checked: not the person, not their setup, not the cap. The person only picks the number it leaves from.
      const email = this.personByWho(ev.who)
      const number = email ? this.emergencyNumber(email) : null
      const profile = email ? this.profile(email) : null
      const address = profile ? this.addressOf(profile) : null
      const real = dest.dest.kind === 'emergency'
      const call = this.newCall({
        now,
        email,
        to: dest.dest.e164,
        browserLeg: ev.leg,
        outcome: 'dialing',
        reason: null,
        emergency: real,
        address: address ? addressLine(address) : null,
      })
      const actions: PhoneAction[] = [{ do: 'dial', callId: call.id, nonce: call.nonce, browserLeg: ev.leg, to: dest.dest.e164, from: number ?? 'line' }]
      if (real) {
        const notice = this.notify911(email, dest.dest.e164, now)
        if (notice) actions.push({ do: 'notify911', ...notice })
      }
      return actions
    }

    // Every other number needs the page's approval for exactly this number, spent once.
    if (!ev.ticketHash) return refuse(null, 'no-ticket')
    const spent = this.sql.all<{ email: string; e164: string; expires_at: number }>('DELETE FROM phone_tickets WHERE hash = ? RETURNING email, e164, expires_at', ev.ticketHash)[0]
    if (!spent || spent.expires_at <= now || spent.e164 !== dest.dest.e164) return refuse(spent?.email ?? null, 'ticket')
    // Asked again: the month may have run out, or the person left the list, since the page asked.
    const again = this.authorize(spent.email, dest.dest.e164, now)
    if (!again.ok) return refuse(spent.email, again.reason)
    const call = this.newCall({ now, email: spent.email, to: dest.dest.e164, browserLeg: ev.leg, outcome: 'dialing', reason: null, emergency: false, address: null })
    return [{ do: 'dial', callId: call.id, nonce: call.nonce, browserLeg: ev.leg, to: dest.dest.e164, from: 'line' }]
  }

  /**
   * The router dialed: remember the leg it made. `abandoned` is true when the browser hung up while the dial request was
   * still out: the router must hang the new leg up at once, and the call never counts minutes.
   */
  dialStarted(callId: number, leg: string, now: number = Date.now()): { abandoned: boolean } {
    this.sql.run('UPDATE phone_calls SET dial_leg = ? WHERE id = ?', leg, callId)
    const abandoned = this.callRow(callId)?.outcome === 'abandoned'
    // Kept until Telnyx has taken the hang-up: the cron asks again for any that did not (`pendingHangups`).
    if (abandoned) this.sql.run('INSERT INTO phone_hangups (leg, at) VALUES (?, ?) ON CONFLICT (leg) DO NOTHING', leg, now)
    return { abandoned }
  }

  /** Legs meet owes a hang-up and has not yet been told were hung up: the cron's retry list, for the last hour. */
  pendingHangups(now: number): string[] {
    return this.sql.all<{ leg: string }>('SELECT leg FROM phone_hangups WHERE at > ?', now - HOUR_MS).map((r) => r.leg)
  }

  /** Telnyx took the hang-up. */
  hangupDone(leg: string): void {
    this.sql.run('DELETE FROM phone_hangups WHERE leg = ?', leg)
  }

  /** The router could not dial: the call is over before it began. */
  dialFailed(callId: number, now: number): void {
    this.sql.run(`UPDATE phone_calls SET outcome = 'failed', reason = 'dial', ended_at = ? WHERE id = ? AND counted = 0`, now, callId)
  }

  private answered(row: CallRow, ev: Omit<PhoneEvent, 'ticket'>): PhoneAction[] {
    if (row.answered_at !== null) return []
    this.sql.run('UPDATE phone_calls SET answered_at = ? WHERE id = ?', ev.at, row.id)
    // A hang-up that beat its answer here: the minutes can be settled now.
    return this.settle(row.id)
  }

  private dialedEnded(row: CallRow, ev: Omit<PhoneEvent, 'ticket'>): PhoneAction[] {
    if (row.ended_at !== null) return []
    this.sql.run('UPDATE phone_calls SET ended_at = ? WHERE id = ?', ev.end ?? ev.at, row.id)
    return this.settle(row.id)
  }

  /** Once a call has ended, and its answer is known, its minutes are counted: rounded up, once, in the month it ended. */
  private settle(id: number): PhoneAction[] {
    const row = this.callRow(id)
    if (!row || row.ended_at === null || row.counted === 1) return []
    // A call the browser gave up on before the dial came back, which nobody answered, counts nothing. One that was answered is
    // counted like any other: Telnyx bills it.
    if (row.outcome === 'abandoned' && row.answered_at === null) {
      this.sql.run('UPDATE phone_calls SET counted = 1 WHERE id = ?', id)
      return []
    }
    if (row.answered_at === null) {
      // Never answered, as far as we have heard. The answer event may still arrive; then this runs again and counts.
      this.sql.run(`UPDATE phone_calls SET outcome = 'not-answered' WHERE id = ? AND outcome = 'dialing'`, id)
      return []
    }
    const minutes = Math.max(1, Math.ceil((row.ended_at - row.answered_at) / MINUTE))
    this.sql.run(`UPDATE phone_calls SET minutes = ?, counted = 1, outcome = 'completed' WHERE id = ?`, minutes, id)
    // An emergency call is shown in the log but never counted against the month (nothing may be refused for it).
    if (row.emergency === 1 || row.to_number === '933') return []
    return this.addToMonth(row.ended_at, minutes)
  }

  /** Add minutes to the month `endedAt` falls in, and say which of the cap's alerts (80%, 100%) that crossed, once each. */
  private addToMonth(endedAt: number, minutes: number): PhoneAction[] {
    const month = this.month(endedAt)
    const before = this.minutesUsed(endedAt)
    this.sql.run('INSERT INTO phone_minutes (month, minutes) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET minutes = minutes + excluded.minutes', month, minutes)
    const after = before + minutes
    const actions: PhoneAction[] = []
    for (const level of ALERT_LEVELS) {
      if (after * 100 >= this.cap * level && before * 100 < this.cap * level) {
        const fresh = this.sql.all('INSERT INTO phone_alerts (month, level) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING level', month, level)
        if (fresh.length > 0) actions.push({ do: 'alert', level, used: after, cap: this.cap })
      }
    }
    return actions
  }

  private browserEnded(ev: Omit<PhoneEvent, 'ticket'>, now: number): PhoneAction[] {
    const row = this.sql.all<CallRow>('SELECT * FROM phone_calls WHERE browser_leg = ?', ev.leg)[0]
    if (!row) return []
    if (row.dial_leg && row.ended_at === null) return [{ do: 'hangup', leg: row.dial_leg }]
    // Abandoned: the browser left before meet's dial came back. Left open (no end), so the leg that comes up is counted from its own answer to its own end.
    if (!row.dial_leg && row.outcome === 'dialing') this.sql.run(`UPDATE phone_calls SET outcome = 'abandoned' WHERE id = ?`, row.id)
    return []
  }

  // --- Calls in (docs/adr/0005) ---------------------------------------------------------
  //
  // A call to the line's number arrives at meet's webhook parked at Telnyx (`call.initiated`, incoming). It is worked in stages,
  // each started by an event and each described to the router as actions, never done here:
  //
  //   meet      every person of the company with a phone registered rings at once, for the line's ring seconds (20). The first to answer
  //             takes it: the others are hung up, the caller's leg is answered and the two are bridged.
  //   cell      if a cell is set and the month's minutes are not used up, the cell rings for 15 seconds, showing the caller's own
  //             number, and its owner must press 1 (so a cell's own voicemail cannot swallow the call). Past the cap the cell is
  //             skipped; nothing else is ever refused or capped for a call in: it always rings meet and always takes a message.
  //   voicemail the caller's leg is answered, a greeting is spoken, and a message of at most 3 minutes is recorded. The only thing
  //             meet ever records, and only on a call nobody took. It lands as a message from "Phone" in the Phone conversation.
  //
  // The caller's leg stays parked (unanswered, so the caller hears ringing) until someone takes the call or the voicemail starts.
  // Every leg meet makes has a row in phone_legs before Telnyx names it; an event is matched by Telnyx's leg id, or, until that is
  // stored, by the client state meet put on the leg (the call's id, its random nonce and the leg's row), never by client state alone.

  /** The number a caller is told as, from whatever Telnyx puts in `from`: +E.164, or '' when it was withheld or is not a number. */
  private callerOf(raw: string): string {
    const user = raw.replace(/^(?:sips?|tel):/i, '').replace(/[@;>].*$/, '')
    const plus = user.trim().startsWith('+')
    const digits = user.replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) return ''
    if (plus) return `+${digits}`
    if (digits.length === 10) return `+1${digits}`
    return digits.length === 11 && digits.startsWith('1') ? `+${digits}` : ''
  }

  /** The numbers a call can be dialed to and reach meet: the line, and the number each person's 911 calls leave from. */
  private ownNumbers(line: string): string[] {
    const own = new Set<string>(line ? [line] : [])
    for (const person of Object.values(this.people())) if (person.emergencyNumber !== 'line') own.add(person.emergencyNumber)
    return [...own]
  }

  /**
   * A call to one of meet's numbers. Incoming whatever its state (a 911 dispatcher's callback arrives as exactly this, and rings
   * like any other call). Nothing about who called, a ticket or a client state decides it.
   */
  private isInbound(ev: CoreEvent, line: string): boolean {
    if (ev.direction !== 'incoming' && ev.direction !== 'inbound') return false
    const to = parseDestination(ev.to)
    const dialed = to.ok ? to.dest.e164 : ev.to.trim()
    return this.ownNumbers(line).includes(dialed)
  }

  private legRow(id: number | null): LegRow | null {
    return id === null ? null : (this.sql.all<LegRow>('SELECT * FROM phone_legs WHERE id = ?', id)[0] ?? null)
  }

  private legsOf(callId: number, role?: LegRow['role']): LegRow[] {
    return role
      ? this.sql.all<LegRow>('SELECT * FROM phone_legs WHERE call_id = ? AND role = ? ORDER BY id', callId, role)
      : this.sql.all<LegRow>('SELECT * FROM phone_legs WHERE call_id = ? ORDER BY id', callId)
  }

  private newLeg(callId: number, role: LegRow['role'], email: string | null, leg: string | null = null): LegRow {
    const [row] = this.sql.all<LegRow>('INSERT INTO phone_legs (call_id, role, email, leg) VALUES (?, ?, ?, ?) RETURNING *', callId, role, email, leg)
    return row as LegRow
  }

  /** The leg of a call in this event is about: by Telnyx's id, or, before it is stored, by the client state meet put on it (with its nonce). */
  private inboundLeg(ev: CoreEvent): { leg: LegRow; call: CallRow } | null {
    let leg = this.sql.all<LegRow>('SELECT * FROM phone_legs WHERE leg = ?', ev.leg)[0]
    if (!leg) {
      if (!ev.ours || ev.ours.leg === null) return null
      leg = this.sql.all<LegRow>(
        `SELECT l.* FROM phone_legs l JOIN phone_calls c ON c.id = l.call_id
         WHERE l.id = ? AND c.id = ? AND c.nonce = ? AND c.direction = 'in' AND l.leg IS NULL`,
        ev.ours.leg,
        ev.ours.id,
        ev.ours.nonce,
      )[0]
      if (!leg) return null
      this.sql.run('UPDATE phone_legs SET leg = ? WHERE id = ? AND leg IS NULL', ev.leg, leg.id)
      leg = { ...leg, leg: ev.leg }
    }
    const call = this.callRow(leg.call_id)
    return call ? { leg, call } : null
  }

  private startInbound(ev: CoreEvent, now: number): PhoneAction[] {
    const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const to = parseDestination(ev.to)
    const [row] = this.sql.all<{ id: number }>(
      `INSERT INTO phone_calls (at, email, to_number, browser_leg, outcome, emergency, nonce, direction, from_number, stage)
       VALUES (?, NULL, ?, ?, 'ringing', 0, ?, 'in', ?, 'meet') RETURNING id`,
      now,
      to.ok ? to.dest.e164 : ev.to.slice(0, 40),
      ev.leg,
      nonce,
      this.callerOf(ev.from),
    )
    this.newLeg((row as { id: number }).id, 'caller', null, ev.leg)
    return this.meetStage(this.callRow((row as { id: number }).id) as CallRow, now)
  }

  private callerLeg(callId: number): LegRow {
    return this.legsOf(callId, 'caller')[0] as LegRow
  }

  private command(c: CallRow, l: LegRow): LegCommand {
    return { callId: c.id, nonce: c.nonce ?? '', legRow: l.id, leg: l.leg as string }
  }

  /** The caller's number as a person reads it, or words for one that was withheld. */
  private callerText(c: CallRow): string {
    return c.from_number ? displayNumber(c.from_number) : 'an unknown number'
  }

  private setting(key: string): string | null {
    return this.sql.all<{ value: string }>('SELECT value FROM phone_settings WHERE key = ?', key)[0]?.value ?? null
  }

  /** What the line does with a call nobody picks up at once. */
  settings(): LineSettings {
    const cell = this.setting('cell')
    const ring = Number(this.setting('ring_seconds'))
    const ringSeconds = Number.isInteger(ring) && ring >= LINE.inbound.ringSecondsMin && ring <= LINE.inbound.ringSecondsMax ? ring : LINE.inbound.ringSeconds
    return { cell: cell || null, cellDisplay: cell ? displayNumber(cell) : null, ringSeconds }
  }

  /**
   * Set the cell unanswered calls go to and how long meet rings first, as the line's owner. The cell must be a
   * number meet could call out to (US, not premium) and never one of meet's own numbers (a call would ring itself). `line` is the
   * line's number, which the router knows. A cell of null or '' clears it: an unanswered call then goes straight to voicemail.
   */
  saveSettings(email: string, raw: unknown, line: string): LineSettings {
    this.require(email)
    // The line's settings are the owner's alone (cell, ring time, greeting, cap, pause), whoever else has the dial pad.
    if (!this.isLineOwner(email)) throw new RoomError(403, MESSAGES.owner)
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    let cell: string | null | undefined
    if (r.cell !== undefined) {
      if (r.cell === null || (typeof r.cell === 'string' && r.cell.trim() === '')) cell = null
      else {
        const p = parseDestination(r.cell)
        if (!p.ok) throw new RoomError(400, p.message)
        if (p.dest.kind !== 'us' || this.ownNumbers(line).includes(p.dest.e164)) throw new RoomError(400, MESSAGES.cell)
        cell = p.dest.e164
      }
    }
    let ring: number | undefined
    if (r.ringSeconds !== undefined) {
      if (typeof r.ringSeconds !== 'number' || !Number.isInteger(r.ringSeconds) || r.ringSeconds < LINE.inbound.ringSecondsMin || r.ringSeconds > LINE.inbound.ringSecondsMax) {
        throw new RoomError(400, MESSAGES.ring)
      }
      ring = r.ringSeconds
    }
    const put = (key: string, value: string) => this.sql.run('INSERT INTO phone_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
    if (cell !== undefined) put('cell', cell ?? '')
    if (ring !== undefined) put('ring_seconds', String(ring))
    return this.settings()
  }

  /** Stage one: ring every person of the company with a phone registered at once. With none, straight on to the cell. */
  private meetStage(c: CallRow, now: number): PhoneAction[] {
    const people = this.sql
      .all<{ email: string; sip_username: string }>('SELECT email, sip_username FROM phone_profiles WHERE credential_id IS NOT NULL AND sip_username IS NOT NULL ORDER BY email')
      .filter((p) => this.eligible(p.email))
    const actions: PhoneAction[] = []
    const secs = this.settings().ringSeconds
    for (const p of people) actions.push(this.ringAction(c, 'ring', p.email, `sip:${p.sip_username}@${LINE.inbound.sipDomain}`, secs))
    return actions.length > 0 ? actions : this.cellStage(c, now)
  }

  /** A call that can still be worked: not wound up, and its caller still on the line. Nothing is rung, said or recorded for one that is not. */
  private live(callId: number): boolean {
    const c = this.callRow(callId)
    return c !== null && c.closed === 0 && this.callerLeg(callId).ended_at === null
  }

  /** One leg for a call in, and the action that rings it: a person's phone, or the cell. */
  private ringAction(c: CallRow, role: 'ring' | 'cell', email: string | null, to: string, timeoutSecs: number): PhoneAction {
    const leg = this.newLeg(c.id, role, email)
    return {
      do: 'ring',
      callId: c.id,
      nonce: c.nonce ?? '',
      leg: leg.id,
      role,
      to,
      from: c.from_number || c.to_number,
      fromName: this.callerText(c),
      link: this.callerLeg(c.id).leg as string,
      timeoutSecs,
    }
  }

  /** Stage two: the cell, if one is set and the month's minutes allow it. Otherwise the voicemail. */
  private cellStage(c: CallRow, now: number): PhoneAction[] {
    if (!this.live(c.id)) return []
    const cell = this.settings().cell
    const p = cell ? parseDestination(cell) : null
    if (!cell || !p?.ok || p.dest.kind !== 'us' || this.minutesUsed(now) >= this.cap) return this.voicemailStage(c)
    this.sql.run(`UPDATE phone_calls SET stage = 'cell' WHERE id = ?`, c.id)
    return [this.ringAction(c, 'cell', null, p.dest.e164, LINE.inbound.cellRingSeconds)]
  }

  /** Stage three: answer the caller and take a message. If the caller's leg is already answered, the greeting is spoken at once. */
  private voicemailStage(c: CallRow, answerSent = false): PhoneAction[] {
    // A caller who has gone is not answered, greeted or recorded.
    if (!this.live(c.id)) return []
    this.sql.run(`UPDATE phone_calls SET stage = 'voicemail', bridge_to = NULL WHERE id = ?`, c.id)
    const a = this.callerLeg(c.id)
    // `answerSent`: the caller was already told to answer (a person took the call, then left); their answer starts the greeting.
    if (a.answered_at === null) return answerSent ? [] : [{ do: 'answer', ...this.command(c, a) }]
    this.sql.run(`UPDATE phone_legs SET state = 'greeting' WHERE id = ?`, a.id)
    return [{ do: 'speak', text: lineWords(this.install().company.name).greeting, ...this.command(c, a) }]
  }

  /** Someone took the call: the caller's leg is answered now, and bridged to `leg` when Telnyx says it is. */
  private take(c: CallRow, leg: LegRow, outcome: 'answered' | 'forwarded', by: string | null): PhoneAction[] {
    this.sql.run(`UPDATE phone_calls SET stage = 'taken', outcome = ?, answered_by = ?, bridge_to = ? WHERE id = ?`, outcome, by, leg.id, c.id)
    const a = this.callerLeg(c.id)
    if (a.answered_at !== null && leg.leg) return [{ do: 'bridge', with: leg.leg, ...this.command(c, a) }]
    return [{ do: 'answer', ...this.command(c, a) }]
  }

  private hangUpOpen(callId: number, except?: number): PhoneAction[] {
    return this.legsOf(callId)
      .filter((l) => l.role !== 'caller' && l.leg !== null && l.ended_at === null && l.id !== except)
      .map((l) => ({ do: 'hangup', leg: l.leg as string }))
  }

  private inboundEvent(found: { leg: LegRow; call: CallRow }, ev: CoreEvent, now: number): PhoneAction[] {
    const { leg, call } = found
    switch (ev.type) {
      case 'call.answered':
        return leg.role === 'caller' ? this.callerAnswered(call, leg, ev) : leg.role === 'ring' ? this.ringAnswered(call, leg, ev) : this.cellAnswered(call, leg, ev)
      case 'call.hangup':
        return this.legEnded(call, leg, ev, now)
      case 'call.gather.ended':
        return leg.role === 'cell' ? this.screened(call, leg, ev, now) : []
      case 'call.speak.ended':
        return leg.role === 'caller' ? this.greeted(call, leg) : []
      case 'call.recording.saved':
        return leg.role === 'caller' ? this.recorded(call, ev, now) : []
      default:
        return []
    }
  }

  private ringAnswered(c: CallRow, l: LegRow, ev: CoreEvent): PhoneAction[] {
    if (l.answered_at !== null) return []
    this.sql.run('UPDATE phone_legs SET answered_at = ? WHERE id = ?', ev.at, l.id)
    // Its hang-up came first (Telnyx's events can arrive out of order): the leg is over, so nothing is sent to it.
    if (l.ended_at !== null) return this.settleLegs(c.id)
    // Someone else took it first, or it has moved on to the cell or the voicemail, or the caller has gone: this person's phone is let go.
    if (c.stage !== 'meet' || !this.live(c.id)) return [{ do: 'hangup', leg: l.leg as string }]
    return [...this.hangUpOpen(c.id, l.id), ...this.take(this.callRow(c.id) as CallRow, l, 'answered', l.email)]
  }

  private cellAnswered(c: CallRow, l: LegRow, ev: CoreEvent): PhoneAction[] {
    if (l.answered_at !== null) return []
    this.sql.run('UPDATE phone_legs SET answered_at = ? WHERE id = ?', ev.at, l.id)
    if (l.ended_at !== null) return this.settleLegs(c.id)
    if (c.stage !== 'cell' || !this.live(c.id)) return [{ do: 'hangup', leg: l.leg as string }]
    this.sql.run(`UPDATE phone_legs SET state = 'screening' WHERE id = ?`, l.id)
    return [{ do: 'screen', text: lineWords(this.install().company.name).screening, ...this.command(c, l) }]
  }

  /** The cell's owner pressed 1 and takes the call, or did not, and the call goes on to the voicemail. */
  private screened(c: CallRow, l: LegRow, ev: CoreEvent, now: number): PhoneAction[] {
    if (c.stage !== 'cell' || l.state !== 'screening') return []
    if (!this.live(c.id)) return l.ended_at === null && l.leg ? [{ do: 'hangup', leg: l.leg }] : []
    if (ev.digits === '1') {
      this.sql.run(`UPDATE phone_legs SET state = 'taken' WHERE id = ?`, l.id)
      return this.take(c, l, 'forwarded', null)
    }
    this.sql.run(`UPDATE phone_legs SET state = 'rejected' WHERE id = ?`, l.id)
    return [{ do: 'hangup', leg: l.leg as string }, ...this.voicemailStage(c)]
  }

  private callerAnswered(c: CallRow, l: LegRow, ev: CoreEvent): PhoneAction[] {
    if (l.answered_at !== null) return []
    this.sql.run('UPDATE phone_legs SET answered_at = ? WHERE id = ?', ev.at, l.id)
    // The caller's hang-up came first: the minutes are theirs to count, and there is nobody to bridge, greet or record.
    if (l.ended_at !== null) return this.settleLegs(c.id)
    const target = this.legRow(c.bridge_to)
    if (c.stage === 'taken' && target) {
      if (target.leg && target.ended_at === null) return [{ do: 'bridge', with: target.leg, ...this.command(c, { ...l, leg: ev.leg }) }]
      // The person hung up between taking the call and the caller being answered: the caller leaves a message instead.
      return this.backToVoicemail(c)
    }
    if (c.stage === 'voicemail') {
      this.sql.run(`UPDATE phone_legs SET state = 'greeting' WHERE id = ?`, l.id)
      return [{ do: 'speak', text: lineWords(this.install().company.name).greeting, ...this.command(c, { ...l, leg: ev.leg }) }]
    }
    return []
  }

  /** The person (or the cell) that took the call left before the caller could be joined to them: the caller leaves a message instead. */
  private backToVoicemail(c: CallRow, answerSent = false): PhoneAction[] {
    this.sql.run(`UPDATE phone_calls SET outcome = 'ringing', answered_by = NULL WHERE id = ?`, c.id)
    return this.voicemailStage(this.callRow(c.id) as CallRow, answerSent)
  }

  /** The greeting is over: the message is recorded, with a beep first, for at most three minutes. */
  private greeted(c: CallRow, l: LegRow): PhoneAction[] {
    if (c.stage !== 'voicemail' || l.state !== 'greeting' || l.ended_at !== null) return []
    this.sql.run(`UPDATE phone_legs SET state = 'recording' WHERE id = ?`, l.id)
    return [{ do: 'record', maxSecs: LINE.inbound.voicemailSeconds, ...this.command(c, l) }]
  }

  /** The recording is saved: it is a voicemail. The message goes in the Phone conversation and each person of the company is emailed. */
  private recorded(c: CallRow, ev: CoreEvent, now: number): PhoneAction[] {
    if (!ev.recordingId || c.stage !== 'voicemail') return []
    if (this.sql.all('SELECT 1 FROM phone_voicemails WHERE call_id = ?', c.id).length > 0) return []
    const seconds = ev.recordingStart !== null && ev.recordingEnd !== null ? Math.max(0, Math.round((ev.recordingEnd - ev.recordingStart) / 1000)) : 0
    const number = c.from_number ?? ''
    const display = this.callerText(c)
    const [vm] = this.sql.all<{ id: number }>(
      'INSERT INTO phone_voicemails (call_id, recording_id, from_number, seconds, at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      c.id,
      ev.recordingId,
      number,
      seconds,
      now,
    )
    const id = (vm as { id: number }).id
    const text = `Voicemail from ${display}, ${seconds >= 60 ? `${Math.floor(seconds / 60)} min ` : ''}${seconds % 60} sec`
    const messageId = this.desk?.post(text, { kind: 'voicemail', id, number, display, seconds }, now) ?? null
    this.sql.run('UPDATE phone_voicemails SET message_id = ? WHERE id = ?', messageId, id)
    this.sql.run(`UPDATE phone_calls SET outcome = 'voicemail', closed = 1 WHERE id = ?`, c.id)
    const mails = (this.desk?.audience(now) ?? []).map((to): PhoneAction => ({ do: 'voicemail-mail', to, number: display, seconds }))
    // The message is taken: nothing more is wanted of the caller's leg, which would otherwise stay up (a silent caller, a robocall)
    // and be counted against the month. A caller who has already gone needs nothing.
    const a = this.callerLeg(c.id)
    return a.leg && a.ended_at === null ? [{ do: 'hangup', leg: a.leg }, ...mails] : mails
  }

  /** A leg of a call in ended: the caller's (the call is over), or a ring or cell leg (the next stage, or the end of a call that was taken). */
  private legEnded(c: CallRow, l: LegRow, ev: CoreEvent, now: number): PhoneAction[] {
    if (l.ended_at !== null) return []
    this.sql.run('UPDATE phone_legs SET ended_at = ? WHERE id = ?', ev.end ?? ev.at, l.id)
    let actions: PhoneAction[] = []
    if (l.role === 'caller') actions = this.callOver(c, now)
    else if (c.stage === 'taken' && c.bridge_to === l.id) {
      // The person (or the cell) that took the call hung up. A caller who was joined to them goes too; one who was not yet answered
      // (their answer is on its way) leaves a message instead.
      const a = this.callerLeg(c.id)
      if (a.ended_at === null && a.answered_at === null) actions = this.backToVoicemail(c, true)
      else if (a.leg && a.ended_at === null) actions = [{ do: 'hangup', leg: a.leg }]
    } else actions = this.letGo(c, l, now)
    return [...actions, ...this.settleLegs(c.id)]
  }

  /** A ring or cell leg could not be made at all (Telnyx refused the request): the same as if it had rung and been let go. */
  legFailed(legRow: number, now: number): PhoneAction[] {
    const l = this.legRow(legRow)
    const c = l ? this.callRow(l.call_id) : null
    if (!l || !c || l.ended_at !== null) return []
    this.sql.run('UPDATE phone_legs SET ended_at = ? WHERE id = ?', now, l.id)
    return this.letGo(c, l, now)
  }

  /**
   * A ring or cell leg is over without having taken the call: when no ring leg is left the call goes on to the cell, and a cell that is
   * over sends it to the voicemail. Nothing goes on for a call that is wound up or whose caller has gone.
   */
  private letGo(c: CallRow, l: LegRow, now: number): PhoneAction[] {
    if (!this.live(c.id)) return []
    if (l.role === 'ring' && c.stage === 'meet') return this.legsOf(c.id, 'ring').every((r) => r.ended_at !== null) ? this.cellStage(c, now) : []
    if (l.role === 'cell' && c.stage === 'cell') return this.voicemailStage(c)
    return []
  }

  /**
   * The router made the leg for a ring or cell action. `abandoned` is true when the call has moved on or ended while the request
   * was out (the caller hung up, someone else took it): the router hangs the leg up at once, and the cron tries again if Telnyx
   * does not take it.
   */
  legStarted(legRow: number, leg: string, now: number = Date.now()): { abandoned: boolean } {
    const l = this.legRow(legRow)
    if (!l) return { abandoned: false }
    this.sql.run('UPDATE phone_legs SET leg = COALESCE(leg, ?) WHERE id = ?', leg, l.id)
    const c = this.callRow(l.call_id)
    const callerGone = this.callerLeg(l.call_id).ended_at !== null
    const moved = c ? (l.role === 'ring' ? c.stage !== 'meet' : c.stage !== 'cell') : true
    // The leg that took the call (its answer can beat the reply to the request that made it) is the one leg that must stay.
    const abandoned = c?.bridge_to !== l.id && (callerGone || moved || c?.closed === 1)
    if (abandoned) this.sql.run('INSERT INTO phone_hangups (leg, at) VALUES (?, ?) ON CONFLICT (leg) DO NOTHING', leg, now)
    return { abandoned }
  }

  /** The caller's leg ended (or the cron gave up on a call): every other leg goes down, and a call that came to nothing is a missed call. */
  private callOver(c: CallRow, now: number): PhoneAction[] {
    const actions = this.hangUpOpen(c.id)
    const fresh = this.callRow(c.id) as CallRow
    this.sql.run('UPDATE phone_calls SET ended_at = COALESCE(ended_at, ?) WHERE id = ?', now, c.id)
    if (fresh.closed === 1) return actions
    if (fresh.outcome === 'ringing') {
      // A message being recorded when the caller hung up is saved a moment later: the missed call is settled by the cron if it never is.
      if (this.callerLeg(c.id).state !== 'recording') this.markMissed(fresh, now)
    } else this.sql.run('UPDATE phone_calls SET closed = 1 WHERE id = ?', c.id)
    return actions
  }

  private markMissed(c: CallRow, now: number): void {
    this.sql.run(`UPDATE phone_calls SET outcome = 'missed', closed = 1 WHERE id = ?`, c.id)
    const display = this.callerText(c)
    this.desk?.post(`Missed call from ${display}`, { kind: 'missed', number: c.from_number ?? '', display }, now)
  }

  /**
   * Count the minutes of the legs that have ended and were answered: the caller's leg, and the cell's if it was answered, each
   * rounded up to the minute and counted once. A person's browser leg is not counted (the call out does not count its browser leg
   * either); the cap is sized for the per-call rate. Never refuses anything: the meter only adds.
   */
  private settleLegs(callId: number): PhoneAction[] {
    const actions: PhoneAction[] = []
    for (const l of this.legsOf(callId)) {
      if (l.role === 'ring' || l.counted === 1 || l.answered_at === null || l.ended_at === null) continue
      const minutes = Math.max(1, Math.ceil((l.ended_at - l.answered_at) / MINUTE))
      this.sql.run('UPDATE phone_legs SET counted = 1 WHERE id = ?', l.id)
      this.sql.run('UPDATE phone_calls SET minutes = minutes + ? WHERE id = ?', minutes, callId)
      actions.push(...this.addToMonth(l.ended_at, minutes))
    }
    return actions
  }

  // --- Voicemail: playing and deleting -----------------------------------------------

  /** A person of the company may reach a voicemail: on the teammate list, whatever the phone list says (every one of them is in the Phone conversation). */
  private teammate(email: string): void {
    if (this.install().person(email) === null) throw new RoomError(403, MESSAGES['not-allowed'])
  }

  private voicemailOf(messageId: number): { id: number; recording_id: string } | null {
    return this.sql.all<{ id: number; recording_id: string }>('SELECT id, recording_id FROM phone_voicemails WHERE message_id = ? AND deleted_at IS NULL', messageId)[0] ?? null
  }

  /** The recording to play for the voicemail posted as this message: its id at Telnyx, for the router to fetch. 404 for anything else. */
  voicemailToPlay(email: string, messageId: number): { recordingId: string } {
    this.teammate(email)
    const vm = Number.isInteger(messageId) ? this.voicemailOf(messageId) : null
    if (!vm) throw new RoomError(404, 'There is no such voicemail.')
    return { recordingId: vm.recording_id }
  }

  /** What deleting this Phone message means: a voicemail's sound is deleted at Telnyx first (its id here), a missed call's line has none. */
  voicemailToDelete(email: string, messageId: number): { recordingId: string | null } {
    this.teammate(email)
    if (!Number.isInteger(messageId)) throw new RoomError(404, 'There is no such message.')
    const vm = this.voicemailOf(messageId)
    if (vm) return { recordingId: vm.recording_id }
    const posted = this.desk?.phoneMessage(messageId) ?? null
    if (!posted) throw new RoomError(404, 'There is no such message.')
    // A 911 notice is a record, and is kept.
    if (posted.kind === 'emergency') throw new RoomError(403, 'A 911 notice is kept.')
    return { recordingId: null }
  }

  /** The router deleted the sound at Telnyx (or there was none): the message goes from the Phone conversation, for everyone. */
  voicemailDeleted(email: string, messageId: number, now: number): void {
    this.teammate(email)
    this.sql.run('UPDATE phone_voicemails SET deleted_at = ? WHERE message_id = ?', now, messageId)
    this.desk?.remove(messageId, now)
  }

  // --- The log and the chores --------------------------------------------------------

  /** This person's calls out, and every call in (they are the line's, not a person's), newest first. */
  recent(email: string, limit = 20): CallLogRow[] {
    this.require(email)
    return this.sql
      .all<CallRow>(`SELECT * FROM phone_calls WHERE email = ? OR direction = 'in' ORDER BY id DESC LIMIT ?`, email, limit)
      .map((r) => {
        const inbound = r.direction === 'in'
        const number = inbound ? (r.from_number ?? '') : r.to_number
        return {
          id: r.id,
          at: r.at,
          direction: inbound ? 'in' : 'out',
          number,
          display: number ? displayNumber(number) : 'Unknown number',
          outcome: r.outcome,
          reason: r.reason,
          minutes: r.minutes,
          emergency: r.emergency === 1,
          answeredBy: r.answered_by ? nameFromEmail(r.answered_by) : null,
        }
      })
  }

  /** Whether the day's balance check is still to do: once a UTC day, and done only when `balanceChecked` says it was read. */
  balanceDue(now: number): boolean {
    return this.sql.all<{ value: number }>(`SELECT value FROM phone_meta WHERE key = 'balance_day'`)[0]?.value !== this.day(now)
  }

  /** The balance was read: no more checks today. A read that failed leaves it due, so the next run tries again. */
  balanceChecked(now: number): void {
    this.sql.run(`INSERT INTO phone_meta (key, value) VALUES ('balance_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, this.day(now))
  }

  private day = (now: number): number => Math.floor(now / (24 * 60 * MINUTE))

  /**
   * The cron's tidy-up: what has expired goes, and a call in that has been worked for ten minutes without coming to anything (an
   * event Telnyx never delivered) is wound up: its legs are hung up, and a call that came to nothing is a missed call. Said as
   * actions, as everything else is.
   */
  sweep(now: number): PhoneAction[] {
    this.sql.run('DELETE FROM phone_tickets WHERE expires_at <= ?', now)
    this.sql.run('DELETE FROM phone_events WHERE at <= ?', now - KEEP_MS)
    this.sql.run('DELETE FROM phone_hangups WHERE at <= ?', now - HOUR_MS)
    this.sql.run('DELETE FROM phone_notices WHERE at <= ?', now - KEEP_MS)
    const actions: PhoneAction[] = []
    // A call still being worked after ten minutes has lost an event; and a caller still on the line long after the voicemail should
    // have ended (a silent caller, a robocall, a greeting or recording that never finished) is let go, so it cannot run up the month.
    const stale = this.sql.all<CallRow>(
      `SELECT c.* FROM phone_calls c JOIN phone_legs a ON a.call_id = c.id AND a.role = 'caller'
       WHERE c.direction = 'in' AND (
         (c.closed = 0 AND c.outcome = 'ringing' AND c.at <= ?)
         OR (c.stage = 'voicemail' AND a.ended_at IS NULL AND a.answered_at IS NOT NULL AND a.answered_at <= ?))`,
      now - STALE_CALL_MS,
      now - VOICEMAIL_DEADLINE_MS,
    )
    for (const c of stale) {
      const a = this.callerLeg(c.id)
      if (a.leg && a.ended_at === null) actions.push({ do: 'hangup', leg: a.leg })
      // The caller's leg is over from here on, so nothing is rung or said for it, and what it ran is counted.
      this.sql.run('UPDATE phone_legs SET ended_at = ? WHERE id = ? AND ended_at IS NULL', now, a.id)
      actions.push(...this.callOver(c, now), ...this.settleLegs(c.id))
      // A message that was being recorded and never arrived is a missed call all the same.
      const left = this.callRow(c.id) as CallRow
      if (left.closed === 0) this.markMissed(left, now)
    }
    return actions
  }
}

// ---------------------------------------------------------------------------
// Crossing the Durable Object boundary, as in room.ts and workspace.ts: ONE method on the object, the core's methods by
// name, its refusals as data.

export const PHONE_METHODS = [
  'status',
  'ack',
  'saveAddress',
  'addressRegistered',
  'confirmAddress',
  'credentialOf',
  'saveCredential',
  'issueTicket',
  'notify911',
  'webhook',
  'dialStarted',
  'dialFailed',
  'pendingHangups',
  'hangupDone',
  'recent',
  'balanceDue',
  'balanceChecked',
  'sweep',
  'eligible',
  'emergencyNumber',
  'saveSettings',
  'legStarted',
  'legFailed',
  'voicemailToPlay',
  'voicemailToDelete',
  'voicemailDeleted',
] as const satisfies ReadonlyArray<keyof PhoneCore>
export type PhoneMethod = (typeof PHONE_METHODS)[number]

export type PhoneInvokeResult = { ok: true; value: unknown } | { ok: false; status: RoomError['status']; message: string }

export function invokePhone(core: PhoneCore, method: string, args: unknown[]): PhoneInvokeResult {
  if (!(PHONE_METHODS as readonly string[]).includes(method)) return { ok: false, status: 400, message: 'unknown method' }
  try {
    const fn = core[method as PhoneMethod] as (...a: unknown[]) => unknown
    return { ok: true, value: fn.apply(core, args) }
  } catch (err) {
    if (err instanceof RoomError) return { ok: false, status: err.status, message: err.message }
    throw err
  }
}

export type PhoneClient = {
  [K in PhoneMethod]: (...args: Parameters<PhoneCore[K]>) => Promise<ReturnType<PhoneCore[K]>>
}

export function phoneClient(invoke: (method: PhoneMethod, args: unknown[]) => Promise<PhoneInvokeResult> | PhoneInvokeResult): PhoneClient {
  const client = {} as Record<PhoneMethod, (...args: unknown[]) => Promise<unknown>>
  for (const method of PHONE_METHODS) {
    client[method] = async (...args) => {
      const res = await invoke(method, args)
      if (!res.ok) throw new RoomError(res.status, res.message)
      return res.value
    }
  }
  return client as unknown as PhoneClient
}
