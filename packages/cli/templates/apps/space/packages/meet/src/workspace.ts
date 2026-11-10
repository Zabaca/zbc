// The workspace: every rule about who may see, say and change what in channels and direct messages.
//
// WorkspaceCore runs INSIDE the Workspace Durable Object, over the object's synchronous SQLite, and never calls
// the network, exactly as RoomCore does (docs/adr/0001, section 2; docs/adr/0003). Nothing here awaits, so every
// method is one step: it checks all of its rules first, then writes. The Worker's router does everything external
// (the doors, the email, the clock) and hands this core a credential's meaning, never the credential:
//
//   { via: 'access',  email }  a teammate: the router has verified the Access assertion
//   { via: 'session', hash  }  a guest: the hash of the cookie's token, looked up here
//   { via: 'socket',  person } the object's own sockets: the ticket was spent when the socket opened
//
// The router builds the Actor from the PATH's door, so a guest cookie can never become an `access` Actor and an
// assertion header can never become a `session` one. This core then checks the kind again where it matters.
//
// What a change tells whom is not done here either: each accepted change is recorded in the change feed and
// pushed onto `outbox` as an Effect (who to tell, which sockets to close); the object's adapter drains the
// outbox after every call and does the sending. Tests drain it into a recorder.
//
// Hashes (a token's, a code's) are made by the router, because WebCrypto's digest is asynchronous and this core
// is not. Every method that needs the time takes `now`.

import { CHAT_MAX, CHAT_RATE, normalizeRoomName } from './model'
import type { PhoneDesk } from './phone'
import type { PhoneMessage } from './phone-model'
import { RoomError, type Sql, cleanMessage, cleanName } from './room'
import { CALL_KINDS, COMPOSE_KEY, COMPOSE_KEY_KEPT_MS, type Install } from '@space/workspace'
import {
  type Bootstrap,
  type SiteView,
  type CallBeginRaw,
  type CallRecordRaw,
  CHANGES_KEEP_MS,
  CHANGES_MAX,
  CHANNELS_MAX,
  CODES_PER_ADDRESS_PER_DAY,
  CODES_PER_ADDRESS_PER_HOUR,
  CODE_TRIES,
  CODE_TTL_MS,
  DAY,
  type CatchUp,
  type Change,
  type ConversationView,
  GUEST_SESSION_MS,
  HISTORY_PAGE,
  HOUR,
  type MeView,
  NUDGE_AFTER_MS,
  NUDGE_EVERY_MS,
  NUDGE_RESERVE,
  type PersonKind,
  type PersonStatus,
  PHONE_NAME,
  PHONE_SENDER,
  type PersonView,
  type Privacy,
  type SpaceCallRaw,
  type SpaceCallWhy,
  type SpaceBrowsableRaw,
  type SpaceChangeRaw,
  type SpaceChannelDetailRaw,
  type SpaceChannelRaw,
  type SpaceDirectRaw,
  type SpaceHistoryRaw,
  type SpaceInvitedRaw,
  type SpaceEditedRaw,
  type SpaceMadeRaw,
  type SpaceMeRaw,
  type SpaceMemberRaw,
  type SpaceOverviewRaw,
  type SpacePerson,
  type SpacePhoneRaw,
  type SpacePostRaw,
  type SpaceReachableRaw,
  SENDS_PER_HOUR,
  SESSION_RENEW_AFTER_MS,
  type StructureWhy,
  TICKET_TTL_MS,
  WRONG_CODES_LOCK,
  type WMessage,
  cleanChannelName,
  cleanLine,
  nameFromEmail,
  normalizeEmail,
} from './workspace-model'

/** What the operator's counts read of the Workspace object (WorkspaceDO.counts): its tables and the phone's, and the three told apart by a column. Constants, never a caller's. */
export const WORKSPACE_COUNTED = {
  tables: ['people', 'conversations', 'conv_members', 'messages', 'changes', 'guest_sessions', 'compose_keys', 'space_calls', 'phone_profiles', 'phone_calls', 'phone_voicemails', 'phone_legs'],
  grouped: [
    { table: 'people', by: 'kind' },
    { table: 'people', by: 'status' },
    { table: 'conversations', by: 'kind' },
  ],
} as const

/** The tables as first written. Every later table is appended to ADDED_TABLES and every later column to ADDITIONS (docs/adr/0001, section 2: storage is migrated forward, never rebuilt). Never edit a statement here. */
export const WS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT,
    created_at INTEGER NOT NULL,
    signed_in_at INTEGER,
    nudges_off INTEGER NOT NULL DEFAULT 0,
    last_nudge_at INTEGER NOT NULL DEFAULT 0,
    acked_privacy_at INTEGER,
    rate_window_at INTEGER NOT NULL DEFAULT 0,
    rate_count INTEGER NOT NULL DEFAULT 0
  )`,
  // A channel or a direct message. A direct message is named by its two people, smaller id first.
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT,
    privacy TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    dm_a TEXT,
    dm_b TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversations_dm ON conversations (dm_a, dm_b) WHERE kind = 'dm'`,
  // Who is in a conversation, and how far each has read.
  `CREATE TABLE IF NOT EXISTS conv_members (
    conv_id INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    added_by TEXT,
    added_at INTEGER NOT NULL,
    last_read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conv_id, person_id)
  )`,
  // One rising id for the whole workspace. AUTOINCREMENT, so an id is never reused after a delete.
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    edited_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS messages_conv ON messages (conv_id, id)`,
  // The change feed. `person_id` limits a change to one person (their read mark); `subject` lets the person a
  // structure change is about see it after they are no longer in the conversation; `ref` is a message id.
  `CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    conv_id INTEGER,
    person_id TEXT,
    subject TEXT,
    ref INTEGER,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS changes_ref ON changes (ref)`,
  // Guest sign-in. A code is kept hashed, one per address.
  `CREATE TABLE IF NOT EXISTS codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  )`,
  // Every email meet sent (kind 'code', 'invite' or 'nudge') and every wrong code entered against a live one
  // (kind 'wrong'), for the limits. A request for a code that sends nothing writes nothing here: only an address
  // that is really invited costs a row, so a flood of made-up addresses cannot grow it or slow the object.
  `CREATE TABLE IF NOT EXISTS mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    email TEXT NOT NULL,
    kind TEXT NOT NULL
  )`,
  // Both limits read it by time, and by address and kind and time: neither may scan the table.
  `CREATE INDEX IF NOT EXISTS mail_log_at ON mail_log (at)`,
  `CREATE INDEX IF NOT EXISTS mail_log_email ON mail_log (email, kind, at)`,
  `CREATE TABLE IF NOT EXISTS guest_sessions (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    hash TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    session_id TEXT,
    ends_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
]

/**
 * Whole tables added after WS_SCHEMA. Append only; every one is `CREATE TABLE IF NOT EXISTS`, run on every boot. The phone's
 * tables live in this object's storage too but are PhoneCore's (phone.ts, docs/adr/0004): it makes them, not this list.
 */
export const WS_ADDED_TABLES: string[] = [
  // The compose keys the space sends with a post (packages/workspace/src/asking.ts, "WHEN A KEY IS USED UP"). A row means the
  // key's first use POSTED, so the key is held; a refused or failed use writes none, which is what releases it. `result` is the
  // first post as JSON, so a repeat can say how the first went. Kept COMPOSE_KEY_KEPT_MS, then dropped.
  `CREATE TABLE IF NOT EXISTS compose_keys (
    person_id TEXT NOT NULL,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (person_id, key)
  )`,
  // The calls the workspace knows a place for: a huddle (its conversation), a call link or a meeting (its home, the space's conversation key), a New call (none).
  // The call itself is a Room, and the ledger instance indexes every call; this says whose it is, what it is for, and for a meeting when and who is invited.
  // `invitees` is JSON: [{ name, address }]. A call made before this table existed has no row and is the ledger's alone.
  `CREATE TABLE IF NOT EXISTS space_calls (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    person_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    conv_id INTEGER,
    home TEXT,
    title TEXT,
    starts_at INTEGER,
    invitees TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS space_calls_conv ON space_calls (conv_id, at)`,
  `CREATE INDEX IF NOT EXISTS space_calls_home ON space_calls (home, at)`,
  `CREATE INDEX IF NOT EXISTS space_calls_person ON space_calls (person_id, at)`,
]

/** Columns added to WS_SCHEMA's tables. Append only; a column is added on the next boot of an instance that lacks it. */
export const WS_ADDITIONS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  // What a message from the phone carries beside its text, as JSON (a voicemail's id and length, a missed call's number). Null for every message a person wrote.
  { table: 'messages', column: 'extra', definition: 'TEXT' },
]

/**
 * The name of the one Workspace instance, the same in every install. It is the code's author's name because the first workspace was made under it, and it stays: a store is found by its Worker, its class and
 * this name, so another name here would leave every existing install with a new, empty workspace beside its conversations.
 */
export const WORKSPACE_NAME = 'zabaca'

/** Calls: how many New calls the overview lists, how many cards one question returns, and how far from now a meeting may be booked. */
export const NEW_CALLS_LISTED = 10
export const CARDS_ASKED = 20
export const CARDS_LISTED = 40
export const MEETINGS_LISTED = 100
export const MEETING_INVITEES_MAX = 20
/** A meeting booked for a time a little past is accepted (a clock a minute out); one further back is a mistake. */
export const MEETING_PAST_MS = 5 * 60_000
export const MEETING_AHEAD_MS = 366 * 24 * 60 * 60_000

export type Actor = { via: 'access'; email: string } | { via: 'session'; hash: string } | { via: 'socket'; person: string }

/** What a call asks the adapter to do once it has returned. */
export type Effect =
  | { t: 'deliver'; people: string[]; change: Change }
  | { t: 'close'; person: string; code: number; reason: string; session?: string }

interface PersonRow {
  id: string
  email: string
  name: string
  kind: PersonKind
  status: PersonStatus
  invited_by: string | null
  created_at: number
  signed_in_at: number | null
  nudges_off: number
  last_nudge_at: number
  acked_privacy_at: number | null
  rate_window_at: number
  rate_count: number
}

interface ConvRow {
  id: number
  kind: 'channel' | 'dm' | 'phone'
  name: string | null
  privacy: Privacy | null
  created_by: string | null
  created_at: number
  archived_at: number | null
  dm_a: string | null
  dm_b: string | null
}

interface MessageRow {
  id: number
  conv_id: number
  person_id: string
  text: string
  at: number
  edited_at: number | null
  extra: string | null
}

interface CallRow {
  name: string
  kind: SpaceCallRaw['kind']
  person_id: string
  at: number
  conv_id: number | null
  home: string | null
  title: string | null
  starts_at: number | null
  invitees: string
}

interface ChangeRow {
  seq: number
  at: number
  kind: Change['kind']
  conv_id: number | null
  person_id: string | null
  subject: string | null
  ref: number | null
  data: string
}

export interface NudgeDue {
  person: string
  email: string
  name: string
  kind: PersonKind
  senders: Array<{ name: string; count: number }>
  total: number
}

/** What an invitation needs the router to send: the router builds the email, the core decides who gets one. */
export interface InviteMail {
  to: string
  inviter: string
  channel: string
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const newId = () => hex(crypto.getRandomValues(new Uint8Array(8)))

export class WorkspaceCore {
  /** What the last call decided: drained by the adapter after every call. */
  outbox: Effect[] = []

  constructor(
    private readonly sql: Sql,
    /** The company's install (packages/workspace): who is a teammate and who owns it. Read at every use so a test can change who is on it. */
    private readonly install: () => Install,
  ) {
    for (const stmt of WS_SCHEMA) this.sql.run(stmt)
    for (const stmt of WS_ADDED_TABLES) this.sql.run(stmt)
    const have = new Map<string, Set<string>>()
    for (const { table, column, definition } of WS_ADDITIONS) {
      if (!have.has(table)) have.set(table, new Set(this.sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)))
      if (!have.get(table)?.has(column)) this.sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  takeOutbox(): Effect[] {
    const out = this.outbox
    this.outbox = []
    return out
  }

  /**
   * Who the space's live object is told about a delivered change: the TEAMMATES among `people`, by the address that names them,
   * each with the key the space's page opens that conversation by (`chat:channel:<n>`, `chat:<the other person's id>` for a direct message, `phone`), or none when the change is not one conversation's. Guests are
   * not here: they keep their own sockets on this object. A direct message's key differs for each of its two people, which is why this answers per person. Reads only.
   */
  liveTargets(people: string[], conv: number | null): { email: string; key?: string }[] {
    const c = conv === null ? null : this.conv(conv)
    const out: { email: string; key?: string }[] = []
    for (const id of people) {
      const p = this.personById(id)
      if (!p || p.kind !== 'teammate' || p.status !== 'active') continue
      const other = c?.kind === 'dm' ? (c.dm_a === id ? c.dm_b : c.dm_a) : null
      const key = c === null ? undefined : c.kind === 'channel' ? `chat:channel:${c.id}` : c.kind === 'phone' ? 'phone' : other ? `chat:${other}` : undefined
      out.push({ email: p.email, ...(key !== undefined && { key }) })
    }
    return out
  }

  // --- Who is asking ---------------------------------------------------------

  /** Whether an address is one of the company's people, by the address that names them or the one they sign in with. */
  private onList(email: string): boolean {
    const install = this.install()
    return install.person(email) !== null || install.personBySignIn(email) !== null
  }

  private personById(id: string): PersonRow | null {
    return this.sql.all<PersonRow>('SELECT * FROM people WHERE id = ?', id)[0] ?? null
  }

  private personByEmail(email: string): PersonRow | null {
    return this.sql.all<PersonRow>('SELECT * FROM people WHERE email = ?', email)[0] ?? null
  }

  /** The company and its owner, as the page words them to a signed-in person (`Bootstrap.site`). */
  private siteView(): SiteView {
    const install = this.install()
    const owner = install.owner()
    return { company: install.company.name, owner: { name: owner.name, address: owner.address } }
  }

  /** The install's owner's name, for the refusals that say who can do the thing. */
  private ownerName(): string {
    return this.install().owner().name
  }

  private isOwner(p: PersonRow): boolean {
    if (p.kind !== 'teammate') return false
    const install = this.install()
    const person = install.person(p.email)
    return person !== null && install.isOwner(person)
  }

  /**
   * Who this call is for. A teammate arrives by an Access assertion the router verified: their address must be on
   * the list (the Worker's own check, so a widened Access application still lets nobody in), and their first
   * arrival makes them a person, or turns a guest with that address into the teammate they now are, keeping
   * their channels and history and ending their guest sessions. A guest arrives by a session cookie's hash.
   */
  private resolve(actor: Actor, now: number): PersonRow {
    if (actor.via === 'socket') {
      const p = this.personById(actor.person)
      if (!p || p.status !== 'active') throw new RoomError(401, 'You are signed out.')
      return p
    }
    if (actor.via === 'access') {
      const email = normalizeEmail(actor.email)
      if (!email || !this.onList(email)) throw new RoomError(403, `This address is not on the ${this.install().company.name} list.`)
      let p = this.personByEmail(email)
      if (!p) {
        const id = newId()
        this.sql.run(
          `INSERT INTO people (id, email, name, kind, status, created_at, signed_in_at) VALUES (?, ?, ?, 'teammate', 'active', ?, ?)`,
          id,
          email,
          this.install().person(email)?.name ?? nameFromEmail(email),
          now,
          now,
        )
        const first = this.personById(id) as PersonRow
        this.joinPhone(first, now)
        return first
      }
      if (p.kind === 'guest') {
        // One address, one person: the guest becomes the teammate, and the guest door stops serving the address.
        this.sql.run(`UPDATE people SET kind = 'teammate', status = 'active' WHERE id = ?`, p.id)
        this.sql.run('DELETE FROM guest_sessions WHERE person_id = ?', p.id)
        this.sql.run('DELETE FROM tickets WHERE person_id = ?', p.id)
        this.sql.run('DELETE FROM codes WHERE email = ?', email)
        this.outbox.push({ t: 'close', person: p.id, code: 4401, reason: `Sign in through ${this.install().company.name}.`, session: undefined })
        this.change('structure', now, { data: { conv: null, why: 'person', person: p.id }, subject: p.id })
        p = this.personById(p.id) as PersonRow
      } else if (p.status === 'former') {
        this.sql.run(`UPDATE people SET status = 'active' WHERE id = ?`, p.id)
        p = this.personById(p.id) as PersonRow
      }
      if (p.status !== 'active') throw new RoomError(403, 'You are not in this workspace.')
      if (p.signed_in_at === null) this.sql.run('UPDATE people SET signed_in_at = ? WHERE id = ?', now, p.id)
      // Every person of the company is in the Phone conversation from the moment they are on the list, and no one else ever is.
      this.joinPhone(p, now)
      return p
    }
    const s = this.sql.all<{ id: string; person_id: string; expires_at: number; last_used_at: number }>(
      'SELECT id, person_id, expires_at, last_used_at FROM guest_sessions WHERE token_hash = ?',
      actor.hash,
    )[0]
    if (!s || s.expires_at <= now) throw new RoomError(401, 'You are signed out.')
    const p = this.personById(s.person_id)
    // The guest door no longer serves an address that has joined the teammate list.
    if (!p || p.kind !== 'guest' || p.status !== 'active' || this.onList(p.email)) throw new RoomError(401, 'You are signed out.')
    if (now - s.last_used_at >= SESSION_RENEW_AFTER_MS) {
      this.sql.run('UPDATE guest_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', now, now + GUEST_SESSION_MS, s.id)
    }
    return p
  }

  private requireTeammate(p: PersonRow): void {
    if (p.kind !== 'teammate') throw new RoomError(403, `Only ${this.install().company.name} people can do that.`)
  }

  // --- The Phone conversation ----------------------------------------------------

  private phoneConv(): ConvRow | null {
    return this.sql.all<ConvRow>(`SELECT * FROM conversations WHERE kind = 'phone' ORDER BY id LIMIT 1`)[0] ?? null
  }

  /** The Phone conversation, made the first time it is needed. There is one, and it is private by kind: nothing adds a person to it but `joinPhone`. */
  private ensurePhoneConv(now: number): ConvRow {
    const held = this.phoneConv()
    if (held) return held
    const row = this.sql.all<{ id: number }>(
      `INSERT INTO conversations (kind, name, privacy, created_by, created_at) VALUES ('phone', ?, 'private', NULL, ?) RETURNING id`,
      PHONE_NAME,
      now,
    )[0] as { id: number }
    return this.conv(row.id) as ConvRow
  }

  /** A teammate on the list is a member of the Phone conversation; this is the only way anyone becomes one. Guests never reach it. */
  private joinPhone(p: PersonRow, now: number): void {
    if (p.kind !== 'teammate' || p.status !== 'active' || !this.onList(p.email)) return
    const c = this.ensurePhoneConv(now)
    if (!this.isMember(c.id, p.id)) this.addToConversation(c.id, p.id, null, now)
  }

  /**
   * What the phone core may do here, and nothing else: post as "Phone", remove what it posted, and ask who is owed an email. It is
   * handed to the phone core by whoever builds both (the Workspace object, or a test), and is deliberately not among the methods
   * the router can call by name (WS_METHODS): the router has no way to post as the phone.
   */
  phoneDesk(): PhoneDesk {
    return {
      post: (text, phone, now) => {
        const c = this.ensurePhoneConv(now)
        // Everyone on the list is in it before the message goes, so a person who has not opened meet yet is told of it too.
        for (const r of this.sql.all<PersonRow>(`SELECT * FROM people WHERE kind = 'teammate' AND status = 'active'`)) this.joinPhone(r, now)
        const row = this.sql.all<{ id: number }>('INSERT INTO messages (conv_id, person_id, text, at, extra) VALUES (?, ?, ?, ?, ?) RETURNING id', c.id, PHONE_SENDER, text, now, JSON.stringify(phone))[0] as { id: number }
        const message: WMessage = { id: row.id, conv: c.id, person: PHONE_SENDER, name: PHONE_NAME, text, at: now, editedAt: null, phone }
        this.change('message', now, { conv: c.id, ref: row.id, data: { conv: c.id, message } })
        return row.id
      },
      phoneMessage: (messageId) => {
        const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE id = ? AND person_id = ?', messageId, PHONE_SENDER)[0]
        return row?.extra ? (JSON.parse(row.extra) as PhoneMessage) : null
      },
      remove: (messageId, now) => {
        const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE id = ? AND person_id = ?', messageId, PHONE_SENDER)[0]
        if (!row) return
        this.sql.run('DELETE FROM messages WHERE id = ?', row.id)
        this.sql.run('DELETE FROM changes WHERE ref = ?', row.id)
        this.change('delete', now, { conv: row.conv_id, data: { conv: row.conv_id, id: row.id, author: PHONE_SENDER } })
      },
      audience: (now) => {
        const budget = SENDS_PER_HOUR - this.sendsInLastHour(now)
        if (budget <= 0) return []
        const rows = this.sql.all<PersonRow>(`SELECT * FROM people WHERE kind = 'teammate' AND status = 'active' AND nudges_off = 0 ORDER BY created_at, id`).filter((r) => this.onList(r.email))
        const chosen = rows.slice(0, budget)
        for (const r of chosen) this.sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, ?, 'voicemail')`, now, r.email)
        return chosen.map((r) => r.email)
      },
    }
  }

  // --- Conversations: reading what exists -------------------------------------

  private conv(id: number): ConvRow | null {
    return Number.isInteger(id) ? (this.sql.all<ConvRow>('SELECT * FROM conversations WHERE id = ?', id)[0] ?? null) : null
  }

  private isMember(convId: number, personId: string): boolean {
    return this.sql.all('SELECT 1 FROM conv_members WHERE conv_id = ? AND person_id = ?', convId, personId).length > 0
  }

  private memberIds(convId: number): string[] {
    return this.sql.all<{ person_id: string }>('SELECT person_id FROM conv_members WHERE conv_id = ? ORDER BY added_at, person_id', convId).map((r) => r.person_id)
  }

  /** A conversation this person is in and that is not archived, or a refusal that says nothing about one they may not see. */
  private mine(p: PersonRow, convId: number): ConvRow {
    const c = this.conv(convId)
    if (!c || c.archived_at !== null || !this.isMember(c.id, p.id)) throw new RoomError(404, 'There is no such conversation.')
    return c
  }

  private maxMessageId(convId: number): number {
    return this.sql.all<{ m: number | null }>('SELECT MAX(id) AS m FROM messages WHERE conv_id = ?', convId)[0]?.m ?? 0
  }

  /** Whether two people are both in the same channel that is still open to talk in. */
  private sharesChannel(a: string, b: string): boolean {
    return (
      this.sql.all(
        `SELECT 1 FROM conv_members x JOIN conv_members y ON x.conv_id = y.conv_id JOIN conversations c ON c.id = x.conv_id
         WHERE x.person_id = ? AND y.person_id = ? AND c.kind = 'channel' AND c.archived_at IS NULL LIMIT 1`,
        a,
        b,
      ).length > 0
    )
  }

  /** Whether `p` may see `other` at all: teammates see every teammate, everyone sees who shares a channel or a direct message with them. */
  private canSee(p: PersonRow, other: PersonRow): boolean {
    if (p.id === other.id) return true
    if (other.status !== 'active') return false
    if (p.kind === 'teammate' && other.kind === 'teammate') return true
    if (this.sharesChannel(p.id, other.id)) return true
    return (
      this.sql.all(
        `SELECT 1 FROM conv_members x JOIN conv_members y ON x.conv_id = y.conv_id JOIN conversations c ON c.id = x.conv_id
         WHERE x.person_id = ? AND y.person_id = ? AND c.kind = 'dm' AND c.archived_at IS NULL LIMIT 1`,
        p.id,
        other.id,
      ).length > 0
    )
  }

  private unreadFor(convId: number, personId: string, lastRead: number): number {
    return (
      this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND id > ? AND person_id != ?', convId, lastRead, personId)[0]?.n ?? 0
    )
  }

  private view(c: ConvRow, personId: string): ConversationView {
    const mem = this.sql.all<{ last_read: number }>('SELECT last_read FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, personId)[0]
    const lastRead = mem?.last_read ?? 0
    const last = this.sql.all<{ id: number; at: number }>('SELECT id, at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1', c.id)[0] ?? null
    return {
      id: c.id,
      kind: c.kind,
      name: c.kind === 'dm' ? null : c.name,
      privacy: c.privacy,
      createdBy: c.created_by,
      members: this.memberIds(c.id),
      unread: this.unreadFor(c.id, personId, lastRead),
      lastRead,
      last,
    }
  }

  private personView(row: PersonRow, forTeammate: boolean): PersonView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      ...(forTeammate ? { email: row.email, invitedBy: row.kind === 'guest' ? row.invited_by : null } : {}),
      invited: row.kind === 'guest' && row.signed_in_at === null,
    }
  }

  private meView(p: PersonRow): MeView {
    return { id: p.id, name: p.name, email: p.email, kind: p.kind, owner: this.isOwner(p), nudgesOff: p.nudges_off === 1, privacyAcked: p.acked_privacy_at !== null }
  }

  /** Everything the page needs to draw itself, and `seq`: where the socket's catch-up starts. */
  bootstrap(actor: Actor, now: number): Bootstrap {
    const p = this.resolve(actor, now)
    const convs = this.sql.all<ConvRow>(
      `SELECT c.* FROM conversations c JOIN conv_members m ON m.conv_id = c.id
       WHERE m.person_id = ? AND c.archived_at IS NULL ORDER BY c.id`,
      p.id,
    )
    const conversations = convs.map((c) => this.view(c, p.id))
    // The people this person can name: every teammate (to a teammate), and everyone in their conversations, whatever
    // their status now, so a message's author is always a known name.
    const ids = new Set<string>([p.id])
    for (const c of conversations) for (const m of c.members) ids.add(m)
    if (p.kind === 'teammate') {
      for (const r of this.sql.all<{ id: string }>(`SELECT id FROM people WHERE kind = 'teammate' AND status = 'active'`)) ids.add(r.id)
    }
    const people: PersonView[] = []
    for (const id of ids) {
      const row = this.personById(id)
      if (!row) continue
      if (row.id !== p.id && row.status === 'active' && !this.canSee(p, row)) continue
      people.push(this.personView(row, p.kind === 'teammate'))
    }
    const browse =
      p.kind === 'teammate'
        ? this.sql
            .all<{ id: number; name: string; n: number }>(
              `SELECT c.id, c.name, (SELECT COUNT(*) FROM conv_members WHERE conv_id = c.id) AS n FROM conversations c
               WHERE c.kind = 'channel' AND c.privacy = 'open' AND c.archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM conv_members m WHERE m.conv_id = c.id AND m.person_id = ?)
               ORDER BY c.name COLLATE NOCASE`,
              p.id,
            )
            .map((r) => ({ id: r.id, name: r.name, memberCount: r.n }))
        : []
    return { me: this.meView(p), people, conversations, browse, seq: this.headSeq(), site: this.siteView() }
  }

  private message(row: MessageRow): WMessage {
    if (row.person_id === PHONE_SENDER) {
      const phone = row.extra ? (JSON.parse(row.extra) as PhoneMessage) : undefined
      return { id: row.id, conv: row.conv_id, person: PHONE_SENDER, name: PHONE_NAME, text: row.text, at: row.at, editedAt: row.edited_at, ...(phone ? { phone } : {}) }
    }
    const who = this.personById(row.person_id)
    const huddle = row.extra ? (JSON.parse(row.extra) as { huddle?: unknown }).huddle : undefined
    return {
      id: row.id,
      conv: row.conv_id,
      person: row.person_id,
      name: who?.name ?? 'Deleted person',
      text: row.text,
      at: row.at,
      editedAt: row.edited_at,
      ...(typeof huddle === 'string' ? { huddle } : {}),
    }
  }

  /** A page of a conversation's history, oldest first: the newest HISTORY_PAGE, or the page before `before`. */
  history(actor: Actor, convId: number, before: number | null, now: number): { messages: WMessage[]; more: boolean } {
    const p = this.resolve(actor, now)
    const c = this.mine(p, convId)
    const rows = this.sql.all<MessageRow>(
      `SELECT * FROM messages WHERE conv_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      c.id,
      before,
      before,
      HISTORY_PAGE + 1,
    )
    const more = rows.length > HISTORY_PAGE
    return { messages: rows.slice(0, HISTORY_PAGE).reverse().map((r) => this.message(r)), more }
  }

  // --- The change feed --------------------------------------------------------

  private headSeq(): number {
    return this.sql.all<{ m: number | null }>('SELECT MAX(seq) AS m FROM changes')[0]?.m ?? this.meta('pruned_through')
  }

  private meta(key: string): number {
    return this.sql.all<{ value: number }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value ?? 0
  }

  private toChange(r: ChangeRow): Change {
    return { seq: r.seq, at: r.at, kind: r.kind, data: JSON.parse(r.data) } as Change
  }

  /**
   * Record a change and queue it for the people who may see it: the conversation's members, the one person a
   * change is limited to, and a structure change's subject. An open channel's structure reaches every teammate,
   * because each has it in a list of channels to join.
   */
  private change(
    kind: Change['kind'],
    now: number,
    o: { conv?: number; person?: string; subject?: string; ref?: number; data: object; to?: string[] },
  ): Change {
    const row = this.sql.all<{ seq: number }>(
      'INSERT INTO changes (at, kind, conv_id, person_id, subject, ref, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq',
      now,
      kind,
      o.conv ?? null,
      o.person ?? null,
      o.subject ?? null,
      o.ref ?? null,
      JSON.stringify(o.data),
    )[0] as { seq: number }
    const change = { seq: row.seq, at: now, kind, data: o.data } as Change
    const audience = new Set<string>(o.to ?? [])
    if (o.person) audience.add(o.person)
    else {
      if (o.conv !== undefined) for (const id of this.memberIds(o.conv)) audience.add(id)
      if (o.subject) audience.add(o.subject)
      if (kind === 'structure' && o.conv !== undefined && this.conv(o.conv)?.privacy === 'open') {
        for (const r of this.sql.all<{ id: string }>(`SELECT id FROM people WHERE kind = 'teammate' AND status = 'active'`)) audience.add(r.id)
      }
    }
    const active = [...audience].filter((id) => this.personById(id)?.status === 'active' || id === o.subject)
    if (active.length > 0) this.outbox.push({ t: 'deliver', people: active, change })
    return change
  }

  /** Whether this person may be sent this stored change now. Membership is read at catch-up time, so a removed person is sent nothing new. */
  private visibleTo(r: ChangeRow, p: PersonRow): boolean {
    if (r.person_id) return r.person_id === p.id
    if (r.subject === p.id) return true
    if (r.conv_id === null) return false
    if (this.isMember(r.conv_id, p.id)) return true
    return r.kind === 'structure' && p.kind === 'teammate' && this.conv(r.conv_id)?.privacy === 'open'
  }

  /** Everything after `since` this person may see, or the word to reload when they are too far behind. */
  catchUp(actor: Actor, since: number, now: number): CatchUp {
    const p = this.resolve(actor, now)
    if (!Number.isInteger(since) || since < 0) return { reload: true }
    const head = this.headSeq()
    if (since > head || since < this.meta('pruned_through')) return { reload: true }
    const rows = this.sql.all<ChangeRow>('SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?', since, CHANGES_MAX + 1)
    if (rows.length > CHANGES_MAX) return { reload: true }
    return { reload: false, changes: rows.filter((r) => this.visibleTo(r, p)).map((r) => this.toChange(r)), seq: head }
  }

  // --- Messages ----------------------------------------------------------------

  /** How many messages this person has sent in the current window (the rate limit's count). */
  private sendCount(p: PersonRow, now: number): number {
    return p.rate_window_at + CHAT_RATE.windowMs > now ? p.rate_count : 0
  }

  /** The text of a message as it will be kept, or the refusal that stops it. */
  private checkedText(rawText: unknown): string {
    const text = cleanMessage(rawText)
    if (text === '') throw new RoomError(400, 'Write something first.')
    if (text.length > CHAT_MAX) throw new RoomError(400, `A message is at most ${CHAT_MAX.toLocaleString('en-US')} characters.`)
    return text
  }

  send(actor: Actor, convId: number, rawText: unknown, now: number): { message: WMessage } {
    const p = this.resolve(actor, now)
    return this.post(p, this.mine(p, convId), rawText, now, null)
  }

  /** One message from this person in a conversation they are in; `huddle` names the call a huddle's announcement is about. */
  private post(p: PersonRow, c: ConvRow, rawText: unknown, now: number, huddle: string | null): { message: WMessage } {
    // Only the phone posts in the Phone conversation.
    if (c.kind === 'phone') throw new RoomError(403, 'Only the phone posts in the Phone conversation.')
    // A direct message whose other person has been removed has no one to hear it.
    if (c.kind === 'dm' && this.memberIds(c.id).length < 2) throw new RoomError(409, 'That person is no longer in this workspace.')
    const text = this.checkedText(rawText)
    let count = this.sendCount(p, now)
    const windowAt = count === 0 ? now : p.rate_window_at
    if (count >= CHAT_RATE.max) throw new RoomError(429, 'You are sending too fast. Wait a moment.')
    count += 1
    this.sql.run('UPDATE people SET rate_window_at = ?, rate_count = ? WHERE id = ?', windowAt, count, p.id)
    const row = this.sql.all<{ id: number }>(
      'INSERT INTO messages (conv_id, person_id, text, at, extra) VALUES (?, ?, ?, ?, ?) RETURNING id',
      c.id,
      p.id,
      text,
      now,
      huddle === null ? null : JSON.stringify({ huddle }),
    )[0] as { id: number }
    const message: WMessage = { id: row.id, conv: c.id, person: p.id, name: p.name, text, at: now, editedAt: null, ...(huddle === null ? {} : { huddle }) }
    this.change('message', now, { conv: c.id, ref: row.id, data: { conv: c.id, message } })
    // Sending reads everything before it: you are in the conversation. A read mark is only news to the person's
    // other devices when it clears something; otherwise the position moves quietly (it places the "New" line).
    const held = this.sql.all<{ last_read: number }>('SELECT last_read FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, p.id)[0]?.last_read ?? 0
    if (this.unreadFor(c.id, p.id, held) === 0) this.sql.run('UPDATE conv_members SET last_read = ? WHERE conv_id = ? AND person_id = ?', row.id, c.id, p.id)
    else this.setRead(c.id, p.id, row.id, now)
    return { message }
  }

  edit(actor: Actor, messageId: number, rawText: unknown, now: number): { message: WMessage } {
    const p = this.resolve(actor, now)
    const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE id = ?', messageId)[0]
    if (!row) throw new RoomError(404, 'There is no such message.')
    const c = this.mine(p, row.conv_id)
    if (row.person_id !== p.id) throw new RoomError(403, 'You can edit only your own messages.')
    const text = cleanMessage(rawText)
    if (text === '') throw new RoomError(400, 'A message cannot be empty. Delete it instead.')
    if (text.length > CHAT_MAX) throw new RoomError(400, `A message is at most ${CHAT_MAX.toLocaleString('en-US')} characters.`)
    this.sql.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, now, row.id)
    // The feed keeps the latest text only: an earlier edit of this message is dropped, and the message's own
    // entry (if the feed still holds it) is rewritten, so a browser catching up never sees a stale version.
    this.sql.run(`DELETE FROM changes WHERE ref = ? AND kind = 'edit'`, row.id)
    const fresh = this.message({ ...row, text, edited_at: now })
    this.sql.run(`UPDATE changes SET data = ? WHERE ref = ? AND kind = 'message'`, JSON.stringify({ conv: c.id, message: fresh }), row.id)
    // A compose key's kept first post follows the edit, so a repeat within the day answers with the words as they are now.
    this.sql.run(`UPDATE compose_keys SET result = json_set(result, '$.message.text', ?, '$.message.editedAt', ?) WHERE json_extract(result, '$.message.id') = ?`, text, now, row.id)
    this.change('edit', now, { conv: c.id, ref: row.id, data: { conv: c.id, id: row.id, text, editedAt: now } })
    return { message: fresh }
  }

  /** The author deletes their own; the Owner deletes another's in a conversation they are in. Nothing of it is kept. */
  deleteMessage(actor: Actor, messageId: number, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE id = ?', messageId)[0]
    if (!row) throw new RoomError(404, 'There is no such message.')
    const c = this.mine(p, row.conv_id)
    // A voicemail is deleted through the phone's own route, which deletes its sound at Telnyx first.
    if (c.kind === 'phone') throw new RoomError(403, 'Delete a voicemail or a missed call from the Phone.')
    if (row.person_id !== p.id && !this.isOwner(p)) throw new RoomError(403, 'You can delete only your own messages.')
    this.sql.run('DELETE FROM messages WHERE id = ?', row.id)
    this.sql.run('DELETE FROM changes WHERE ref = ?', row.id)
    // A compose key keeps the first post to answer a repeat with: the key stays held, but nothing of the words is kept.
    this.sql.run(`UPDATE compose_keys SET result = json_set(result, '$.message.text', '') WHERE json_extract(result, '$.message.id') = ?`, row.id)
    this.change('delete', now, { conv: c.id, data: { conv: c.id, id: row.id, author: row.person_id } })
    return { ok: true }
  }

  // --- Unread ------------------------------------------------------------------

  private setRead(convId: number, personId: string, upTo: number, now: number): void {
    const m = this.sql.all<{ last_read: number }>('SELECT last_read FROM conv_members WHERE conv_id = ? AND person_id = ?', convId, personId)[0]
    if (!m) return
    const to = Math.min(Math.max(upTo, m.last_read), this.maxMessageId(convId))
    if (to === m.last_read) return
    this.sql.run('UPDATE conv_members SET last_read = ? WHERE conv_id = ? AND person_id = ?', to, convId, personId)
    // Only this person's other devices need it: it clears their count there.
    this.change('read', now, { conv: convId, person: personId, data: { conv: convId, upTo: to, unread: this.unreadFor(convId, personId, to) } })
  }

  markRead(actor: Actor, convId: number, upTo: unknown, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    const c = this.mine(p, convId)
    if (typeof upTo !== 'number' || !Number.isInteger(upTo) || upTo < 0) throw new RoomError(400, 'bad request')
    this.setRead(c.id, p.id, upTo, now)
    return { ok: true }
  }

  // --- What the space asks ----------------------------------------------------------
  // The space (packages/space) asks meet through its named entrypoint (space-meet.ts), always as a TEAMMATE who came in at the
  // Access door: the actor is `access`, and a guest never reaches the space. Each method is one step, like every other here.
  // The visibility rule is the one meet already has: the direct messages the person is in and the channels they belong to,
  // and nothing else (an open channel they have not joined, another pair's direct message, an archived channel, and the
  // Phone conversation, which comes with calls, are not here).

  private asTeammate(actor: Actor, now: number): PersonRow {
    if (actor.via !== 'access') throw new RoomError(403, `Only ${this.install().company.name} people can do that.`)
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    return p
  }

  private spacePerson(row: PersonRow): SpacePerson {
    return { id: row.id, name: row.name, kind: row.kind, email: row.email }
  }

  private newestIn(convId: number): WMessage | null {
    const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1', convId)[0]
    return row ? this.message(row) : null
  }

  /** A conversation the space may show: the person is in it, it is not archived, and it is not the Phone conversation. */
  private mineForSpace(p: PersonRow, convId: unknown): ConvRow {
    if (typeof convId !== 'number' || !Number.isInteger(convId)) throw new RoomError(400, 'bad request')
    const c = this.mine(p, convId)
    if (c.kind === 'phone') throw new RoomError(404, 'There is no such conversation.')
    return c
  }

  /** Per person the direct message with them, and each channel the asker is in; each with its newest message and unread. */
  spaceOverview(actor: Actor, now: number): SpaceOverviewRaw {
    const p = this.asTeammate(actor, now)
    const convs = this.sql.all<ConvRow>(
      `SELECT c.* FROM conversations c JOIN conv_members m ON m.conv_id = c.id
       WHERE m.person_id = ? AND c.archived_at IS NULL AND c.kind != 'phone' ORDER BY c.id`,
      p.id,
    )
    const direct: SpaceDirectRaw[] = []
    const channels: SpaceChannelRaw[] = []
    for (const c of convs) {
      const v = this.view(c, p.id)
      if (c.kind === 'dm') {
        // A direct message whose other person has been removed has nobody on its other side: nothing to draw a row for.
        const other = v.members.filter((id) => id !== p.id).map((id) => this.personById(id))[0]
        if (!other) continue
        direct.push({ conv: c.id, other: this.spacePerson(other), newest: this.newestIn(c.id), unread: v.unread })
      } else {
        channels.push({ conv: c.id, name: c.name ?? '', privacy: c.privacy ?? 'private', members: v.members.length, createdAt: c.created_at, newest: this.newestIn(c.id), unread: v.unread })
      }
    }
    const pc = this.phoneConv()
    const phone = pc && this.isMember(pc.id, p.id) ? { conv: pc.id, newest: this.newestIn(pc.id), unread: this.view(pc, p.id).unread } : null
    const calls = this.sql
      .all<CallRow>(`SELECT * FROM space_calls WHERE kind = 'new' AND person_id = ? ORDER BY at DESC, name LIMIT ?`, p.id, NEW_CALLS_LISTED)
      .map((r) => this.callRaw(r, p))
    return { me: this.spacePerson(p), direct, channels, phone, calls }
  }

  // --- Calls ---------------------------------------------------------------------------------------------------------
  // A call is a Room; the ledger instance indexes it. This is what the WORKSPACE knows about a call: whose it is and what for. A huddle
  // is made in a conversation by anyone in it (a guest included: the guests' door asks these same methods as a `session` actor), the
  // rest by a teammate. The router makes the Room between `callBegin` and `callRecord` (it is the only part that can), checks the meter
  // before it does, and a Room made for a record that then fails is a call nobody is told about: harmless, and listed in the ledger.

  private callRaw(r: CallRow, p: PersonRow): SpaceCallRaw {
    return {
      name: r.name,
      kind: r.kind,
      by: r.person_id,
      byName: this.personById(r.person_id)?.name ?? 'Deleted person',
      at: r.at,
      conv: r.conv_id,
      home: r.home,
      title: r.title,
      startsAt: r.starts_at,
      invitees: JSON.parse(r.invitees) as SpaceCallRaw['invitees'],
      mine: r.person_id === p.id,
    }
  }

  private activeConv(convId: number | null): boolean {
    return convId !== null && this.conv(convId)?.archived_at === null
  }

  /** Whether a person is among the addresses a meeting invites: by the address meet knows them by, or the one the declaration names them by. */
  private invitedTo(p: PersonRow, r: CallRow): boolean {
    const mine = new Set([p.email, this.install().personBySignIn(p.email)?.address].flatMap((a) => (a ? [a.toLowerCase()] : [])))
    return (JSON.parse(r.invitees) as SpaceCallRaw['invitees']).some((i) => i.address !== null && mine.has(i.address.toLowerCase()))
  }

  /** Why a recorded call is this person's, or null when it is not. */
  private whyVisible(p: PersonRow, r: CallRow): SpaceCallWhy | null {
    if (r.person_id === p.id) return 'started'
    if (r.kind === 'huddle' && this.activeConv(r.conv_id) && this.isMember(r.conv_id as number, p.id)) return 'conversation'
    if (r.kind === 'meeting' && ((this.activeConv(r.conv_id) && this.isMember(r.conv_id as number, p.id)) || this.invitedTo(p, r))) return 'invited'
    return null
  }

  private callRow(name: string): CallRow | null {
    return this.sql.all<CallRow>('SELECT * FROM space_calls WHERE name = ?', name)[0] ?? null
  }

  private heldCall(p: PersonRow, key: string): CallRow | null {
    const held = this.sql.all<{ result: string }>('SELECT result FROM compose_keys WHERE person_id = ? AND key = ?', p.id, `call:${key}`)[0]
    return held ? this.callRow((JSON.parse(held.result) as { call: string }).call) : null
  }

  /**
   * Step one of a keyed write that makes a call. A key that has made a call already answers that call (a repeat does nothing more). A
   * huddle is checked here too, before anything is made: the asker is in the conversation, it is not the Phone one, a direct message still
   * has its other person, and the rate limit for messages has room, because the huddle posts one. A refusal records nothing and releases the key.
   */
  callBegin(actor: Actor, key: unknown, kind: unknown, convId: unknown, now: number): CallBeginRaw {
    const p = this.resolve(actor, now)
    if (typeof key !== 'string' || !COMPOSE_KEY.test(key) || !CALL_KINDS.includes(kind as never)) throw new RoomError(400, 'bad request')
    if (kind !== 'huddle') this.requireTeammate(p)
    this.sql.run('DELETE FROM compose_keys WHERE at <= ?', now - COMPOSE_KEY_KEPT_MS)
    const held = this.heldCall(p, key)
    if (held) return { held: this.callRaw(held, p) }
    if (kind === 'huddle') {
      if (typeof convId !== 'number' || !Number.isInteger(convId)) throw new RoomError(400, 'bad request')
      const c = this.mine(p, convId)
      if (c.kind === 'phone') throw new RoomError(404, 'There is no such conversation.')
      if (c.kind === 'dm' && this.memberIds(c.id).length < 2) throw new RoomError(409, 'That person is no longer in this workspace.')
      if (this.sendCount(p, now) >= CHAT_RATE.max) throw new RoomError(429, 'You are sending too fast. Wait a moment.')
    }
    return { held: null }
  }

  /**
   * Step two: the call exists (the router made its Room), so say whose it is and what it is for, in one step with the key's record. A huddle
   * also posts its message. Everything that can refuse is checked before the first write.
   */
  callRecord(actor: Actor, key: unknown, spec: unknown, name: unknown, link: unknown, now: number): CallRecordRaw {
    const p = this.resolve(actor, now)
    if (typeof key !== 'string' || !COMPOSE_KEY.test(key)) throw new RoomError(400, 'bad request')
    const s = (spec ?? {}) as { kind?: unknown; convId?: unknown; home?: unknown; title?: unknown; startsAt?: unknown; invitees?: unknown }
    const room = typeof name === 'string' ? normalizeRoomName(name) : null
    if (!room || !CALL_KINDS.includes(s.kind as never) || typeof link !== 'string' || link.length > 300) throw new RoomError(400, 'bad request')
    const kind = s.kind as SpaceCallRaw['kind']
    if (kind !== 'huddle') this.requireTeammate(p)
    const held = this.heldCall(p, key)
    if (held) return { repeated: true, call: this.callRaw(held, p), message: null }

    const home = typeof s.home === 'string' && s.home.trim() !== '' ? s.home.trim() : null
    if (home !== null && home.length > 320) throw new RoomError(400, 'bad request')
    const title = cleanLine(s.title, kind === 'meeting' ? 80 : 60)
    let conv: ConvRow | null = null
    if (typeof s.convId === 'number' && Number.isInteger(s.convId)) {
      conv = this.mine(p, s.convId)
      if (conv.kind === 'phone') throw new RoomError(404, 'There is no such conversation.')
    }
    let startsAt: number | null = null
    let invitees: SpaceCallRaw['invitees'] = []
    if (kind === 'huddle') {
      if (!conv) throw new RoomError(400, 'bad request')
      if (conv.kind === 'dm' && this.memberIds(conv.id).length < 2) throw new RoomError(409, 'That person is no longer in this workspace.')
      if (this.sendCount(p, now) >= CHAT_RATE.max) throw new RoomError(429, 'You are sending too fast. Wait a moment.')
    } else if (kind === 'link') {
      if (home === null || conv) throw new RoomError(400, 'bad request')
    } else if (kind === 'meeting') {
      if (title === '') throw new RoomError(400, 'A meeting needs a title.')
      if (typeof s.startsAt !== 'number' || !Number.isInteger(s.startsAt) || s.startsAt < now - MEETING_PAST_MS || s.startsAt > now + MEETING_AHEAD_MS) {
        throw new RoomError(400, 'A meeting needs a time between now and a year ahead.')
      }
      startsAt = s.startsAt
      if ((conv === null) === (home === null)) throw new RoomError(400, 'A meeting is made in one conversation.')
      invitees = conv
        ? this.memberIds(conv.id)
            .filter((id) => id !== p.id)
            .flatMap((id) => {
              const who = this.personById(id)
              return who && who.status === 'active' ? [{ name: who.name, address: who.email }] : []
            })
        : this.cleanInvitees(s.invitees)
    } else if (conv || home !== null) {
      // A New call has no conversation and no home.
      throw new RoomError(400, 'bad request')
    }

    this.sql.run(
      'INSERT INTO space_calls (name, kind, person_id, at, conv_id, home, title, starts_at, invitees) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      room,
      kind,
      p.id,
      now,
      conv?.id ?? null,
      home,
      title === '' ? null : title,
      startsAt,
      JSON.stringify(invitees),
    )
    const message = kind === 'huddle' && conv ? this.post(p, conv, `Started a huddle: ${link}`, now, room).message : null
    this.sql.run('INSERT INTO compose_keys (person_id, key, at, result) VALUES (?, ?, ?, ?)', p.id, `call:${key}`, now, JSON.stringify({ call: room }))
    return { repeated: false, call: this.callRaw(this.callRow(room) as CallRow, p), message }
  }

  private cleanInvitees(raw: unknown): SpaceCallRaw['invitees'] {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw) || raw.length > MEETING_INVITEES_MAX) throw new RoomError(400, `A meeting invites at most ${MEETING_INVITEES_MAX} people.`)
    const seen = new Set<string>()
    const out: SpaceCallRaw['invitees'] = []
    for (const i of raw as Array<{ name?: unknown; address?: unknown }>) {
      const address = i && typeof i === 'object' && i.address !== null && i.address !== undefined ? normalizeEmail(i.address) : null
      if (i && typeof i === 'object' && i.address !== null && i.address !== undefined && address === null) throw new RoomError(400, 'An invited address is not an email address.')
      const name = i && typeof i === 'object' ? cleanLine(i.name, 80) : ""
      if (name === '' && address === null) throw new RoomError(400, 'Each person invited has a name or an address.')
      const id = address ?? name.toLowerCase()
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ name: name || (address as string), address })
    }
    return out
  }

  /**
   * How each of these calls (a name, and who the ledger says made it) stands with the asker: why it is theirs, or null when it is not, and what the
   * workspace knows of it. A call with no record here is one made before calls came to the space (by the owner, at /start), or by /start since: the ledger's maker decides.
   */
  spaceRelate(actor: Actor, entries: unknown, now: number): Array<{ name: string; why: SpaceCallWhy | null; row: SpaceCallRaw | null }> {
    const p = this.asTeammate(actor, now)
    if (!Array.isArray(entries) || entries.length > 100) throw new RoomError(400, 'bad request')
    const declared = this.install().personBySignIn(p.email)?.address ?? null
    return (entries as Array<{ name?: unknown; startedBy?: unknown }>).map((e) => {
      if (!e || typeof e.name !== 'string' || (e.startedBy !== null && typeof e.startedBy !== 'string')) throw new RoomError(400, 'bad request')
      const r = this.callRow(e.name)
      if (r) return { name: e.name, why: this.whyVisible(p, r), row: this.callRaw(r, p) }
      const own = e.startedBy === null ? this.isOwner(p) : declared !== null && e.startedBy === declared
      return { name: e.name, why: own ? ('started' as const) : null, row: null }
    })
  }

  /** The cards of these conversations (their huddles and meetings) and these homes (their call links and meetings), newest first. */
  spaceCards(actor: Actor, want: unknown, now: number): SpaceCallRaw[] {
    const p = this.asTeammate(actor, now)
    const w = (want ?? {}) as { conversationIds?: unknown; homes?: unknown }
    const ids = Array.isArray(w.conversationIds) ? w.conversationIds : []
    const homes = Array.isArray(w.homes) ? w.homes : []
    if (ids.length > CARDS_ASKED || homes.length > CARDS_ASKED || !ids.every((i) => typeof i === 'number' && Number.isInteger(i)) || !homes.every((h) => typeof h === 'string' && h.length <= 320)) {
      throw new RoomError(400, 'bad request')
    }
    const convs = (ids as number[]).filter((id) => this.activeConv(id) && this.isMember(id, p.id))
    const rows: CallRow[] = []
    if (convs.length > 0) {
      rows.push(...this.sql.all<CallRow>(`SELECT * FROM space_calls WHERE kind IN ('huddle', 'meeting') AND conv_id IN (${convs.map(() => '?').join(',')}) ORDER BY at DESC LIMIT ?`, ...convs, CARDS_LISTED))
    }
    if (homes.length > 0) {
      rows.push(...this.sql.all<CallRow>(`SELECT * FROM space_calls WHERE kind IN ('link', 'meeting') AND home IN (${homes.map(() => '?').join(',')}) ORDER BY at DESC LIMIT ?`, ...(homes as string[]), CARDS_LISTED))
    }
    return rows
      .filter((r, i) => rows.findIndex((o) => o.name === r.name) === i && this.whyVisible(p, r) !== null)
      .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
      .slice(0, CARDS_LISTED)
      .map((r) => this.callRaw(r, p))
  }

  /** Meetings starting in [from, until) the asker made or is invited to, soonest first. */
  spaceMeetings(actor: Actor, from: unknown, until: unknown, now: number): SpaceCallRaw[] {
    const p = this.asTeammate(actor, now)
    if (typeof from !== 'number' || typeof until !== 'number' || !Number.isFinite(from) || !Number.isFinite(until) || until < from || until - from > 400 * DAY) throw new RoomError(400, 'bad request')
    return this.sql
      .all<CallRow>(`SELECT * FROM space_calls WHERE kind = 'meeting' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, name LIMIT 500`, from, until)
      .filter((r) => this.whyVisible(p, r) !== null)
      .slice(0, MEETINGS_LISTED)
      .map((r) => this.callRaw(r, p))
  }

  /** The Phone conversation as the space draws it: a page of its messages (voicemails, missed calls, 911 notices), oldest first, and the unread count. */
  spacePhone(actor: Actor, before: unknown, now: number): SpacePhoneRaw {
    const p = this.asTeammate(actor, now)
    const c = this.phoneConv()
    if (!c || !this.isMember(c.id, p.id)) throw new RoomError(404, 'There is no such conversation.')
    if (before !== null && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) throw new RoomError(400, 'bad request')
    return { conv: c.id, unread: this.view(c, p.id).unread, ...this.history(actor, c.id, before, now) }
  }

  /** Mark the Phone conversation read up to a message; answers where the position is now. */
  spacePhoneRead(actor: Actor, upTo: unknown, now: number): { conv: number; upTo: number } {
    const p = this.asTeammate(actor, now)
    const c = this.phoneConv()
    if (!c || !this.isMember(c.id, p.id)) throw new RoomError(404, 'There is no such conversation.')
    this.markRead(actor, c.id, upTo, now)
    return { conv: c.id, upTo: this.sql.all<{ last_read: number }>('SELECT last_read FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, p.id)[0]?.last_read ?? 0 }
  }

  /** A direct message's or channel's history, as `history` with the asker's id beside it. Not the Phone conversation. */
  spaceHistory(actor: Actor, convId: unknown, before: unknown, now: number): SpaceHistoryRaw {
    const p = this.asTeammate(actor, now)
    const c = this.mineForSpace(p, convId)
    if (before !== null && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) throw new RoomError(400, 'bad request')
    return { me: p.id, owner: this.isOwner(p), ...this.history(actor, c.id, before, now) }
  }

  /** Mark a conversation read up to a message id; answers where the position is now (it never moves back, and stops at the newest message). */
  spaceMarkRead(actor: Actor, convId: unknown, upTo: unknown, now: number): { conv: number; upTo: number } {
    const p = this.asTeammate(actor, now)
    const c = this.mineForSpace(p, convId)
    this.markRead(actor, c.id, upTo, now)
    const at = this.sql.all<{ last_read: number }>('SELECT last_read FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, p.id)[0]?.last_read ?? 0
    return { conv: c.id, upTo: at }
  }

  /**
   * One post, once per compose key. A key whose first use POSTED is held: the repeat posts nothing, opens no direct message and
   * answers `repeated` with the first post. A first use that was refused (the text, the rate limit, a target that is not there)
   * writes nothing and records nothing, which releases the key. Everything that can refuse is checked BEFORE the first write, so a
   * refusal leaves no direct message opened either. The send and the key's record are one step, so there is no in-between state.
   */
  spacePost(actor: Actor, key: unknown, target: unknown, rawText: unknown, now: number): SpacePostRaw {
    const p = this.asTeammate(actor, now)
    if (typeof key !== 'string' || !COMPOSE_KEY.test(key)) throw new RoomError(400, 'bad request')
    this.sql.run('DELETE FROM compose_keys WHERE at <= ?', now - COMPOSE_KEY_KEPT_MS)
    const held = this.sql.all<{ result: string }>('SELECT result FROM compose_keys WHERE person_id = ? AND key = ?', p.id, key)[0]
    if (held) return { ...(JSON.parse(held.result) as { conv: number; message: WMessage }), me: p.id, owner: this.isOwner(p), repeated: true }
    const t = target as { conversationId?: unknown; personId?: unknown } | null
    if (!t || typeof t !== 'object') throw new RoomError(400, 'bad request')
    const text = this.checkedText(rawText)
    if (this.sendCount(p, now) >= CHAT_RATE.max) throw new RoomError(429, 'You are sending too fast. Wait a moment.')
    let convId: number
    if (t.conversationId !== undefined) {
      convId = this.mineForSpace(p, t.conversationId).id
    } else if (typeof t.personId === 'string') {
      const other = this.personById(t.personId)
      const existing = other ? this.dmBetween(p.id, other.id) : null
      if (existing && existing.archived_at === null && other?.status === 'active' && this.isMember(existing.id, p.id) && this.isMember(existing.id, other.id)) convId = existing.id
      else convId = this.openDm(actor, t.personId, now).conversation.id
    } else {
      throw new RoomError(400, 'bad request')
    }
    const { message } = this.send(actor, convId, text, now)
    this.sql.run('INSERT INTO compose_keys (person_id, key, at, result) VALUES (?, ?, ?, ?)', p.id, key, now, JSON.stringify({ conv: convId, message }))
    return { repeated: false, conv: convId, message, me: p.id, owner: this.isOwner(p) }
  }

  // --- Messages and a person's own settings, for the space ---------------------------------
  // What only /start did in chat besides channel admin: the people a first direct message can go to, editing and deleting a message, and a person's own settings. Each is
  // the core's own method called as the teammate who is asking, so /start's rules and words are not written a second time. What is added is the scoping: a message in a
  // conversation the asker is not in is `not-found` in the same words as a message that is not there (the core says "no such conversation" for one and "no such message" for
  // the other, which tells a teammate which message numbers exist in a private channel), and the Phone conversation is the phone's own to delete from.

  /** A message in a conversation the asker is in, as the space may edit or delete it. The refusal for any other is one: there is no such message. */
  private messageInMyConversation(p: PersonRow, messageId: unknown): MessageRow {
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) throw new RoomError(400, 'bad request')
    const row = this.sql.all<MessageRow>('SELECT * FROM messages WHERE id = ?', messageId)[0]
    const c = row ? this.conv(row.conv_id) : null
    if (!row || !c || c.archived_at !== null || c.kind === 'phone' || !this.isMember(c.id, p.id)) throw new RoomError(404, 'There is no such message.')
    return row
  }

  /** Whether the asker has a direct message with this person that has something in it, and so a conversation to open. */
  private directWith(p: PersonRow, otherId: string): boolean {
    const dm = this.dmBetween(p.id, otherId)
    return dm !== null && dm.archived_at === null && this.isMember(dm.id, p.id) && this.isMember(dm.id, otherId) && this.maxMessageId(dm.id) > 0
  }

  /**
   * The people `openDm` would let the asker open a direct message with now: any teammate, a guest who shares a channel with them, and anyone they already have a direct
   * message with (an existing one is always open to its two people). Active people only, and not the asker. A guest who shares nothing with the asker is not listed.
   */
  spaceMessageable(actor: Actor, now: number): SpaceReachableRaw[] {
    const p = this.asTeammate(actor, now)
    return this.sql
      .all<PersonRow>(`SELECT * FROM people WHERE status = 'active' AND id != ? ORDER BY name COLLATE NOCASE, id`, p.id)
      .filter((who) => this.dmBetween(p.id, who.id) !== null || who.kind === 'teammate' || this.sharesChannel(p.id, who.id))
      .map((who) => ({ person: this.spacePerson(who), direct: this.directWith(p, who.id) }))
  }

  /** Edit one of the asker's own messages: `edit`'s rules and words. */
  spaceEdit(actor: Actor, messageId: unknown, rawText: unknown, now: number): SpaceEditedRaw {
    const p = this.asTeammate(actor, now)
    const row = this.messageInMyConversation(p, messageId)
    return { me: p.id, owner: this.isOwner(p), message: this.edit(actor, row.id, rawText, now).message }
  }

  /** Delete a message for everyone: `deleteMessage`'s rules and words (the author's own, or any in a conversation the owner is in). */
  spaceDelete(actor: Actor, messageId: unknown, now: number): { conv: number; id: number } {
    const p = this.asTeammate(actor, now)
    const row = this.messageInMyConversation(p, messageId)
    this.deleteMessage(actor, row.id, now)
    return { conv: row.conv_id, id: row.id }
  }

  private spaceMeOf(p: PersonRow): SpaceMeRaw {
    const fresh = this.personById(p.id) as PersonRow
    return { me: this.spacePerson(fresh), owner: this.isOwner(fresh), nudgesOff: fresh.nudges_off === 1, privacyAcked: fresh.acked_privacy_at !== null }
  }

  /** The asker's own settings. */
  spaceMe(actor: Actor, now: number): SpaceMeRaw {
    return this.spaceMeOf(this.asTeammate(actor, now))
  }

  /**
   * Change the asker's name in chat, or whether the nudge is wanted: `updateMe`'s rules and words. Tighter than /start in one place: `nudgesOff` must be a boolean when it is given
   * (`updateMe` reads anything else as "on", so a malformed body would switch the nudge back on), and a patch with neither is refused rather than quietly nothing.
   */
  spaceUpdateMe(actor: Actor, patch: unknown, now: number): SpaceMeRaw {
    const p = this.asTeammate(actor, now)
    const asked = patch && typeof patch === 'object' ? (patch as { name?: unknown; nudgesOff?: unknown }) : null
    if (!asked || (asked.name === undefined && asked.nudgesOff === undefined) || (asked.nudgesOff !== undefined && typeof asked.nudgesOff !== 'boolean')) throw new RoomError(400, 'bad request')
    this.updateMe(actor, { name: asked.name, nudgesOff: asked.nudgesOff }, now)
    return this.spaceMeOf(p)
  }

  /** The asker acknowledges the privacy note: `ackPrivacy`. */
  spaceAckPrivacy(actor: Actor, now: number): SpaceMeRaw {
    const p = this.asTeammate(actor, now)
    this.ackPrivacy(actor, now)
    return this.spaceMeOf(p)
  }

  // --- Channel admin for the space ----------------------------------------------------------------------------------------------
  // New channel, Invite a guest, Archive and what goes with them, asked by the space as the teammate who is asking (the same actor /start's door builds).
  // The rules are the channel methods below, called as they are; what is added here is the answer the space draws from (who is in a channel and what the asker
  // may do with each), the two writes that carry a compose key (a channel made, a guest invited), and the scoping that keeps a private channel's people from
  // anyone outside it. Compose keys are kept in `compose_keys` under a prefix of their own, so a key cannot collide with a post's or a call's.

  /** A channel the asker is in, as the space may show it: not archived, not a direct message, not the Phone conversation. Otherwise the refusal says nothing about one they may not see. */
  private channelOfMine(p: PersonRow, convId: unknown): ConvRow {
    const c = this.mineForSpace(p, convId)
    if (c.kind !== 'channel') throw new RoomError(404, 'There is no such channel.')
    return c
  }

  private channelDetail(p: PersonRow, c: ConvRow): SpaceChannelDetailRaw {
    const owner = this.isOwner(p)
    const memberIds = this.memberIds(c.id)
    const members: SpaceMemberRaw[] = []
    for (const id of memberIds) {
      const who = this.personById(id)
      if (!who) continue
      const isGuest = who.kind === 'guest'
      const dm = id === p.id ? null : this.dmBetween(p.id, id)
      members.push({
        person: this.spacePerson(who),
        invited: isGuest && who.signed_in_at === null,
        you: id === p.id,
        direct: dm !== null && dm.archived_at === null && this.isMember(dm.id, p.id) && this.maxMessageId(dm.id) > 0,
        may: {
          // As the members panel offered them: a teammate in the channel takes a guest out; the owner removes any guest, a teammate the guests they invited;
          // the owner deletes anyone but themself.
          takeOut: id !== p.id && isGuest,
          removeFromWorkspace: id !== p.id && isGuest && (owner || who.invited_by === p.id),
          deleteEverything: id !== p.id && owner,
        },
      })
    }
    const inChannel = new Set(memberIds)
    const addable = this.sql
      .all<PersonRow>(`SELECT * FROM people WHERE status = 'active' ORDER BY name COLLATE NOCASE, id`)
      .filter((who) => !inChannel.has(who.id) && this.canSee(p, who))
      .map((who) => this.spacePerson(who))
    return {
      conv: c.id,
      name: c.name ?? '',
      privacy: c.privacy ?? 'private',
      createdByMe: c.created_by === p.id,
      members,
      addable,
      // Every teammate in a channel renames, leaves, adds and invites; its maker archives it, and so does the owner.
      may: { rename: true, leave: true, archive: c.created_by === p.id || owner, add: true, invite: true },
    }
  }

  /** A channel the asker is in, with its people. Not-found for any other, an open one included: reading one means joining it. */
  spaceChannel(actor: Actor, convId: unknown, now: number): SpaceChannelDetailRaw {
    const p = this.asTeammate(actor, now)
    return this.channelDetail(p, this.channelOfMine(p, convId))
  }

  /** The open channels the asker has not joined: a name and a count. */
  spaceBrowse(actor: Actor, now: number): SpaceBrowsableRaw[] {
    const p = this.asTeammate(actor, now)
    return this.sql
      .all<{ id: number; name: string; n: number }>(
        `SELECT c.id, c.name, (SELECT COUNT(*) FROM conv_members WHERE conv_id = c.id) AS n FROM conversations c
         WHERE c.kind = 'channel' AND c.privacy = 'open' AND c.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM conv_members m WHERE m.conv_id = c.id AND m.person_id = ?)
         ORDER BY c.name COLLATE NOCASE`,
        p.id,
      )
      .map((r) => ({ conv: r.id, name: r.name, members: r.n }))
  }

  private composeKey(key: unknown): string {
    if (typeof key !== 'string' || !COMPOSE_KEY.test(key)) throw new RoomError(400, 'bad request')
    return key
  }

  private heldKey<T>(p: PersonRow, held: string): T | null {
    const row = this.sql.all<{ result: string }>('SELECT result FROM compose_keys WHERE person_id = ? AND key = ?', p.id, held)[0]
    return row ? (JSON.parse(row.result) as T) : null
  }

  /**
   * Make a channel, once per key. A key that made one answers that channel (a repeat makes nothing); a refusal (a name is needed, the name is taken,
   * too many channels) records nothing, which releases the key. The channel and the key's record are one step.
   */
  spaceCreateChannel(actor: Actor, key: unknown, name: unknown, privacy: unknown, now: number): SpaceMadeRaw {
    const p = this.asTeammate(actor, now)
    const k = `channel:${this.composeKey(key)}`
    this.sql.run('DELETE FROM compose_keys WHERE at <= ?', now - COMPOSE_KEY_KEPT_MS)
    const held = this.heldKey<{ conv: number }>(p, k)
    if (held) return { repeated: true, channel: this.channelDetail(p, this.channelOfMine(p, held.conv)) }
    const made = this.createChannel(actor, name, privacy, now)
    this.sql.run('INSERT INTO compose_keys (person_id, key, at, result) VALUES (?, ?, ?, ?)', p.id, k, now, JSON.stringify({ conv: made.conversation.id }))
    return { repeated: false, channel: this.channelDetail(p, this.channelOfMine(p, made.conversation.id)) }
  }

  /**
   * Invite a guest into a channel the asker is in, once per key. The invite's own rules decide (a teammate's address is refused, the hour's emails are
   * counted); what comes back is the one email the caller sends. A key that invited already answers the guest and no email, and says whether the first
   * email is known to have left (`spaceInviteSent` records it), pessimistically: unknown reads as not sent, so the person inviting again is a resend.
   */
  spaceInvite(actor: Actor, key: unknown, convId: unknown, rawEmail: unknown, rawName: unknown, now: number): SpaceInvitedRaw {
    const p = this.asTeammate(actor, now)
    const k = `invite:${this.composeKey(key)}`
    this.sql.run('DELETE FROM compose_keys WHERE at <= ?', now - COMPOSE_KEY_KEPT_MS)
    const held = this.heldKey<{ conv: number; person: string; mailed: boolean }>(p, k)
    if (held) {
      const who = this.personById(held.person)
      if (who) return { repeated: true, conv: held.conv, person: this.spacePerson(who), mail: null, mailed: held.mailed }
    }
    const c = this.channelOfMine(p, convId)
    const done = this.invite(actor, c.id, rawEmail, rawName, now)
    this.sql.run('INSERT INTO compose_keys (person_id, key, at, result) VALUES (?, ?, ?, ?)', p.id, k, now, JSON.stringify({ conv: c.id, person: done.person.id, mailed: false }))
    const guest = this.personById(done.person.id) as PersonRow
    return { repeated: false, conv: c.id, person: this.spacePerson(guest), mail: done.mail, mailed: false }
  }

  /** Record whether the invitation's email left, for a repeat of the key to say. Best effort: nothing depends on it. */
  spaceInviteSent(actor: Actor, key: unknown, mailed: unknown, now: number): { ok: true } {
    const p = this.asTeammate(actor, now)
    const k = `invite:${this.composeKey(key)}`
    const held = this.heldKey<{ conv: number; person: string; mailed: boolean }>(p, k)
    if (held) this.sql.run('UPDATE compose_keys SET result = ? WHERE person_id = ? AND key = ?', JSON.stringify({ ...held, mailed: mailed === true }), p.id, k)
    return { ok: true }
  }

  /**
   * One change to a channel: the channel method of that name, with its rules and its words. `archive` is asked in a channel the asker is in; `remove-guest` and `delete-person` in a channel
   * the asker is in with the person, as the members panel offered them, so a person who is in no channel of the asker's is not found. Answers the channel as it
   * stands, or null when the asker is no longer in it (they left it, it was archived).
   */
  spaceChange(actor: Actor, convId: unknown, change: SpaceChangeRaw, now: number): { conv: number; channel: SpaceChannelDetailRaw | null } {
    const p = this.asTeammate(actor, now)
    if (typeof convId !== 'number' || !Number.isInteger(convId) || !change || typeof change !== 'object') throw new RoomError(400, 'bad request')
    const person = (change as { personId?: unknown }).personId
    switch (change.do) {
      case 'join':
        this.joinChannel(actor, convId, now)
        break
      case 'leave':
        this.leaveChannel(actor, convId, now)
        break
      case 'archive':
        // As remove-guest and delete-person: in a channel the asker is in. The core would let the owner archive a private channel he is not in (the id is all it asks), which /start's page
        // could not reach, so the space does not offer it either.
        this.channelOfMine(p, convId)
        this.archiveChannel(actor, convId, now)
        break
      case 'rename':
        this.renameChannel(actor, convId, change.name, now)
        break
      case 'add':
        this.addMember(actor, convId, person as string, now)
        break
      case 'take-out':
        this.removeMember(actor, convId, person as string, now)
        break
      case 'remove-guest':
      case 'delete-person': {
        const c = this.channelOfMine(p, convId)
        if (typeof person !== 'string' || !this.isMember(c.id, person)) throw new RoomError(404, 'That person is not in this channel.')
        if (change.do === 'remove-guest') this.removePerson(actor, person, now)
        else this.deletePerson(actor, person, now)
        break
      }
      default:
        throw new RoomError(400, 'bad request')
    }
    const c = this.conv(convId)
    const still = c && c.kind === 'channel' && c.archived_at === null && this.isMember(c.id, p.id)
    return { conv: convId, channel: still ? this.channelDetail(p, c) : null }
  }

  // --- Channels ----------------------------------------------------------------

  private addToConversation(convId: number, personId: string, addedBy: string | null, now: number): void {
    // History from before you came is not unread.
    this.sql.run(
      'INSERT OR IGNORE INTO conv_members (conv_id, person_id, added_by, added_at, last_read) VALUES (?, ?, ?, ?, ?)',
      convId,
      personId,
      addedBy,
      now,
      this.maxMessageId(convId),
    )
  }

  private structure(convId: number | null, why: StructureWhy, now: number, o: { person?: string; subject?: string } = {}): void {
    this.change('structure', now, {
      ...(convId === null ? {} : { conv: convId }),
      ...(o.subject ? { subject: o.subject } : {}),
      data: { conv: convId, why, ...(o.person ? { person: o.person } : {}) },
    })
  }

  private channelNameTaken(name: string, exceptId = 0): boolean {
    return (
      this.sql.all(`SELECT 1 FROM conversations WHERE kind = 'channel' AND archived_at IS NULL AND lower(name) = lower(?) AND id != ?`, name, exceptId).length > 0
    )
  }

  createChannel(actor: Actor, rawName: unknown, privacy: unknown, now: number): { conversation: ConversationView } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const name = cleanChannelName(rawName)
    if (name === '') throw new RoomError(400, 'Give the channel a name.')
    if (privacy !== 'open' && privacy !== 'private') throw new RoomError(400, 'A channel is open or private.')
    if (this.channelNameTaken(name)) throw new RoomError(409, 'There is already a channel with that name.')
    const count = this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE kind = 'channel' AND archived_at IS NULL`)[0]?.n ?? 0
    if (count >= CHANNELS_MAX) throw new RoomError(409, 'There are too many channels. Archive one first.')
    const row = this.sql.all<{ id: number }>(
      `INSERT INTO conversations (kind, name, privacy, created_by, created_at) VALUES ('channel', ?, ?, ?, ?) RETURNING id`,
      name,
      privacy,
      p.id,
      now,
    )[0] as { id: number }
    this.addToConversation(row.id, p.id, p.id, now)
    this.structure(row.id, 'created', now)
    return { conversation: this.view(this.conv(row.id) as ConvRow, p.id) }
  }

  private openChannel(convId: number): ConvRow {
    const c = this.conv(convId)
    if (!c || c.kind !== 'channel' || c.archived_at !== null) throw new RoomError(404, 'There is no such channel.')
    return c
  }

  joinChannel(actor: Actor, convId: number, now: number): { conversation: ConversationView } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.openChannel(convId)
    // A private channel does not exist for someone who is not in it.
    if (c.privacy !== 'open') throw new RoomError(404, 'There is no such channel.')
    if (!this.isMember(c.id, p.id)) {
      this.addToConversation(c.id, p.id, p.id, now)
      this.structure(c.id, 'joined', now, { person: p.id, subject: p.id })
    }
    return { conversation: this.view(c, p.id) }
  }

  leaveChannel(actor: Actor, convId: number, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.mine(p, convId)
    if (c.kind !== 'channel') throw new RoomError(400, c.kind === 'phone' ? 'The Phone conversation cannot be left.' : 'A direct message cannot be left.')
    this.sql.run('DELETE FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, p.id)
    this.structure(c.id, 'left', now, { person: p.id, subject: p.id })
    return { ok: true }
  }

  renameChannel(actor: Actor, convId: number, rawName: unknown, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.mine(p, convId)
    if (c.kind !== 'channel') throw new RoomError(400, 'Only a channel has a name.')
    const name = cleanChannelName(rawName)
    if (name === '') throw new RoomError(400, 'Give the channel a name.')
    if (this.channelNameTaken(name, c.id)) throw new RoomError(409, 'There is already a channel with that name.')
    this.sql.run('UPDATE conversations SET name = ? WHERE id = ?', name, c.id)
    this.structure(c.id, 'renamed', now)
    return { ok: true }
  }

  /** The channel's maker archives it, and so does the Owner (any channel, though he reads only his own). */
  archiveChannel(actor: Actor, convId: number, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.openChannel(convId)
    // A private channel does not exist for a teammate who is not in it, unless he is the Owner.
    if (c.privacy === 'private' && !this.isMember(c.id, p.id) && !this.isOwner(p)) throw new RoomError(404, 'There is no such channel.')
    if (!(c.created_by === p.id && this.isMember(c.id, p.id)) && !this.isOwner(p)) throw new RoomError(403, `Only the person who made a channel, or ${this.ownerName()}, can archive it.`)
    const audience = this.memberIds(c.id)
    this.sql.run('UPDATE conversations SET archived_at = ? WHERE id = ?', now, c.id)
    // Told to the people in it before they are dropped from the list; the memberships stay with the history.
    this.change('structure', now, { conv: c.id, data: { conv: c.id, why: 'archived' }, to: audience })
    // A guest whose last channel this was is removed from the workspace, as when they are taken out of it.
    for (const id of audience) {
      const who = this.personById(id)
      if (who?.kind === 'guest' && who.status === 'active' && this.channelCount(id) === 0) this.dropPerson(who, now, false)
    }
    return { ok: true }
  }

  /** How many channels (not direct messages) that are not archived this person is in. */
  private channelCount(personId: string): number {
    return (
      this.sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM conv_members m JOIN conversations c ON c.id = m.conv_id WHERE m.person_id = ? AND c.kind = 'channel' AND c.archived_at IS NULL`,
        personId,
      )[0]?.n ?? 0
    )
  }

  /** A teammate in a channel adds a teammate, or a guest they can see. */
  addMember(actor: Actor, convId: number, personId: string, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.mine(p, convId)
    if (c.kind !== 'channel') throw new RoomError(400, 'People are added to a channel.')
    const target = typeof personId === 'string' ? this.personById(personId) : null
    if (!target || target.status !== 'active' || !this.canSee(p, target)) throw new RoomError(404, 'There is no such person.')
    if (!this.isMember(c.id, target.id)) {
      this.addToConversation(c.id, target.id, p.id, now)
      this.structure(c.id, 'added', now, { person: target.id, subject: target.id })
    }
    return { ok: true }
  }

  /** A teammate in a channel takes a guest out of it. A guest left in no channel is removed from the workspace. */
  removeMember(actor: Actor, convId: number, personId: string, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.mine(p, convId)
    if (c.kind !== 'channel') throw new RoomError(400, 'People are removed from a channel.')
    const target = typeof personId === 'string' ? this.personById(personId) : null
    if (!target || !this.isMember(c.id, target.id)) throw new RoomError(404, 'That person is not in this channel.')
    if (target.kind !== 'guest') throw new RoomError(403, 'A teammate leaves a channel on their own.')
    this.sql.run('DELETE FROM conv_members WHERE conv_id = ? AND person_id = ?', c.id, target.id)
    this.structure(c.id, 'removed', now, { person: target.id, subject: target.id })
    if (this.channelCount(target.id) === 0) this.dropPerson(target, now, false)
    return { ok: true }
  }

  /**
   * Add a guest by name and address to a channel the teammate is in. The router sends the one email this returns;
   * the core only decides it is allowed and counts it. A teammate's address is refused: add that person instead.
   */
  invite(actor: Actor, convId: number, rawEmail: unknown, rawName: unknown, now: number): { person: PersonView; mail: InviteMail } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const c = this.mine(p, convId)
    if (c.kind !== 'channel') throw new RoomError(400, 'Guests are invited to a channel.')
    const email = normalizeEmail(rawEmail)
    if (!email) throw new RoomError(400, 'That does not look like an email address.')
    const name = typeof rawName === 'string' ? cleanName(rawName) : ''
    if (typeof rawName !== 'string' || rawName.trim() === '') throw new RoomError(400, 'Give the guest a name.')
    const existing = this.personByEmail(email)
    if (this.onList(email) || existing?.kind === 'teammate') {
      throw new RoomError(409, `That address belongs to a ${this.install().company.name} person. Add them to the channel instead.`)
    }
    if (this.sendsInLastHour(now) >= SENDS_PER_HOUR) throw new RoomError(429, 'meet has sent as many emails as it may this hour. Try again later.')
    let guest = existing
    if (!guest) {
      const id = newId()
      this.sql.run(`INSERT INTO people (id, email, name, kind, status, invited_by, created_at) VALUES (?, ?, ?, 'guest', 'active', ?, ?)`, id, email, name, p.id, now)
      guest = this.personById(id) as PersonRow
    } else if (guest.status !== 'active') {
      this.sql.run(`UPDATE people SET status = 'active', name = ?, invited_by = ? WHERE id = ?`, name, p.id, guest.id)
      guest = this.personById(guest.id) as PersonRow
    }
    this.sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, ?, 'invite')`, now, email)
    if (!this.isMember(c.id, guest.id)) {
      this.addToConversation(c.id, guest.id, p.id, now)
      this.structure(c.id, 'added', now, { person: guest.id, subject: guest.id })
    }
    return { person: this.personView(guest, true), mail: { to: email, inviter: p.name, channel: c.name ?? '' } }
  }

  // --- Direct messages -----------------------------------------------------------

  /** Open the direct message with someone you can see (making it the first time). It is one to one. */
  openDm(actor: Actor, personId: string, now: number): { conversation: ConversationView } {
    const p = this.resolve(actor, now)
    const other = typeof personId === 'string' ? this.personById(personId) : null
    if (!other || other.id === p.id || other.status !== 'active') throw new RoomError(404, 'There is no such person.')
    const existing = this.dmBetween(p.id, other.id)
    if (!existing) {
      // A teammate may open one with any teammate or a guest they share a channel with; a guest with the people
      // they share a channel with. An existing one is always open to its two people (above).
      const allowed = p.kind === 'teammate' && other.kind === 'teammate' ? true : this.sharesChannel(p.id, other.id)
      if (!allowed) throw new RoomError(404, 'There is no such person.')
    }
    const [a, b] = p.id < other.id ? [p.id, other.id] : [other.id, p.id]
    let id = existing?.id
    if (id === undefined) {
      id = (this.sql.all<{ id: number }>(`INSERT INTO conversations (kind, created_by, created_at, dm_a, dm_b) VALUES ('dm', ?, ?, ?, ?) RETURNING id`, p.id, now, a, b)[0] as { id: number }).id
    }
    for (const who of [p.id, other.id]) {
      if (!this.isMember(id, who)) this.addToConversation(id, who, p.id, now)
    }
    this.structure(id, 'created', now)
    return { conversation: this.view(this.conv(id) as ConvRow, p.id) }
  }

  private dmBetween(x: string, y: string): ConvRow | null {
    const [a, b] = x < y ? [x, y] : [y, x]
    return this.sql.all<ConvRow>(`SELECT * FROM conversations WHERE kind = 'dm' AND dm_a = ? AND dm_b = ?`, a, b)[0] ?? null
  }

  // --- Me -------------------------------------------------------------------------

  updateMe(actor: Actor, patch: { name?: unknown; nudgesOff?: unknown }, now: number): { me: MeView } {
    const p = this.resolve(actor, now)
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || patch.name.trim() === '') throw new RoomError(400, 'Your name cannot be empty.')
      this.sql.run('UPDATE people SET name = ? WHERE id = ?', cleanName(patch.name), p.id)
    }
    if (patch.nudgesOff !== undefined) this.sql.run('UPDATE people SET nudges_off = ? WHERE id = ?', patch.nudgesOff === true ? 1 : 0, p.id)
    return { me: this.meView(this.personById(p.id) as PersonRow) }
  }

  ackPrivacy(actor: Actor, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.sql.run('UPDATE people SET acked_privacy_at = ? WHERE id = ? AND acked_privacy_at IS NULL', now, p.id)
    return { ok: true }
  }

  // --- Removing and deleting people -----------------------------------------------

  /** Ends the person's sessions and sockets and takes them out of every conversation; their messages stay under their name. */
  private dropPerson(target: PersonRow, now: number, purge: boolean): void {
    const convs = this.sql.all<{ conv_id: number }>('SELECT conv_id FROM conv_members WHERE person_id = ?', target.id).map((r) => r.conv_id)
    const touched = new Set(convs)
    if (purge) {
      for (const r of this.sql.all<{ conv_id: number }>('SELECT DISTINCT conv_id FROM messages WHERE person_id = ?', target.id)) touched.add(r.conv_id)
      const ids = this.sql.all<{ id: number }>('SELECT id FROM messages WHERE person_id = ?', target.id).map((r) => r.id)
      for (const id of ids) this.sql.run('DELETE FROM changes WHERE ref = ?', id)
      this.sql.run('DELETE FROM messages WHERE person_id = ?', target.id)
    }
    // The people left in each conversation are told after the person is out of it.
    this.sql.run('DELETE FROM conv_members WHERE person_id = ?', target.id)
    this.sql.run('DELETE FROM compose_keys WHERE person_id = ?', target.id)
    this.sql.run('DELETE FROM guest_sessions WHERE person_id = ?', target.id)
    this.sql.run('DELETE FROM tickets WHERE person_id = ?', target.id)
    this.sql.run('DELETE FROM codes WHERE email = ?', target.email)
    if (purge) {
      // A deletion request: the name and address go too, so nothing of the person is kept.
      this.sql.run(`UPDATE people SET status = 'removed', name = 'Deleted person', email = ? WHERE id = ?`, `deleted-${target.id}@invalid`, target.id)
    } else {
      this.sql.run(`UPDATE people SET status = 'removed' WHERE id = ?`, target.id)
    }
    this.outbox.push({ t: 'close', person: target.id, code: 4403, reason: 'You were removed.' })
    for (const id of touched) this.structure(id, purge ? 'purged' : 'removed', now, { person: target.id, subject: target.id })
  }

  /** Remove a guest from the workspace: the Owner any guest, a teammate a guest they invited. */
  removePerson(actor: Actor, personId: string, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    this.requireTeammate(p)
    const target = typeof personId === 'string' ? this.personById(personId) : null
    if (!target || target.status !== 'active') throw new RoomError(404, 'There is no such person.')
    if (target.kind !== 'guest') throw new RoomError(403, `A ${this.install().company.name} person is removed by taking them off the list.`)
    if (!this.isOwner(p) && target.invited_by !== p.id) throw new RoomError(403, 'You can remove only a guest you invited.')
    this.dropPerson(target, now, false)
    return { ok: true }
  }

  /** Delete a person and everything they wrote, on request. Only the Owner. */
  deletePerson(actor: Actor, personId: string, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    if (!this.isOwner(p)) throw new RoomError(403, `Only ${this.ownerName()} can delete a person.`)
    const target = typeof personId === 'string' ? this.personById(personId) : null
    if (!target || target.id === p.id) throw new RoomError(404, 'There is no such person.')
    this.dropPerson(target, now, true)
    return { ok: true }
  }

  // --- The guests' door: codes and sessions ---------------------------------------

  /** Rows older than the longest limit (a day) are of no use; the cron drops them. */
  private pruneMailLog(now: number): void {
    this.sql.run('DELETE FROM mail_log WHERE at < ?', now - DAY - HOUR)
  }

  /** Every kind of email counts against the one hourly allowance: codes, invitations, nudges and voicemail notices. */
  private sendsInLastHour(now: number): number {
    return this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_log WHERE kind IN ('code', 'invite', 'nudge', 'voicemail') AND at > ?`, now - HOUR)[0]?.n ?? 0
  }

  private logged(email: string, kind: 'code' | 'wrong', since: number): number {
    return this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM mail_log WHERE email = ? AND kind = ? AND at > ?', email, kind, since)[0]?.n ?? 0
  }

  /** An address with too many wrong codes in the last hour is shut for the rest of it, whatever code it is sent. */
  private lockedOut(email: string, now: number): boolean {
    return this.logged(email, 'wrong', now - HOUR) >= WRONG_CODES_LOCK
  }

  /**
   * Asking for a code. The reply is the same for every address, whatever happens: an address nobody invited, a
   * teammate's, a removed guest's, a real guest's, and a real guest who has asked too often. `send` tells the router
   * whether to email, and the router tells the page nothing different. Nothing is refused out loud, so no limit tells
   * a stranger who is invited. An address that is not an invited guest costs one indexed read and no write; the router's
   * per-IP limit (workspace-routes.ts) is what stops a flood of them.
   *
   * For a real guest: at most 5 codes an hour and 10 a day to one address (a stranger cannot use it to fill someone's
   * inbox), no new code after 10 wrong ones in an hour (a new code does not reset that), and 50 emails an hour in all.
   */
  requestCode(rawEmail: unknown, codeHash: string, now: number): { send: boolean } {
    const email = normalizeEmail(rawEmail)
    if (!email) throw new RoomError(400, 'That does not look like an email address.')
    const p = this.personByEmail(email)
    if (!p || p.kind !== 'guest' || p.status !== 'active' || this.onList(email)) return { send: false }
    if (this.lockedOut(email, now)) return { send: false }
    if (this.logged(email, 'code', now - HOUR) >= CODES_PER_ADDRESS_PER_HOUR) return { send: false }
    if (this.logged(email, 'code', now - DAY) >= CODES_PER_ADDRESS_PER_DAY) return { send: false }
    if (this.sendsInLastHour(now) >= SENDS_PER_HOUR) return { send: false }
    this.sql.run(
      `INSERT INTO codes (email, code_hash, expires_at, tries) VALUES (?, ?, ?, 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0`,
      email,
      codeHash,
      now + CODE_TTL_MS,
    )
    this.sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, ?, 'code')`, now, email)
    return { send: true }
  }

  /**
   * Entering a code: right once, within 10 minutes, not after 5 wrong ones on it, and not at all while the address is
   * locked out by wrong ones across codes. Only a wrong code against a live one writes anything. The router has
   * already made the session's hash.
   */
  verifyCode(rawEmail: unknown, codeHash: string, sessionHash: string, label: string, now: number): { sessionId: string; expiresAt: number } {
    const refuse = () => new RoomError(401, 'That code did not work. Ask for a new one.')
    const email = normalizeEmail(rawEmail)
    if (!email) throw refuse()
    const row = this.sql.all<{ code_hash: string; expires_at: number; tries: number }>('SELECT code_hash, expires_at, tries FROM codes WHERE email = ?', email)[0]
    if (!row) throw refuse()
    if (row.expires_at <= now) {
      this.sql.run('DELETE FROM codes WHERE email = ?', email)
      throw refuse()
    }
    if (this.lockedOut(email, now)) throw refuse()
    if (row.code_hash !== codeHash) {
      this.sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, ?, 'wrong')`, now, email)
      if (row.tries + 1 >= CODE_TRIES) this.sql.run('DELETE FROM codes WHERE email = ?', email)
      else this.sql.run('UPDATE codes SET tries = tries + 1 WHERE email = ?', email)
      throw refuse()
    }
    this.sql.run('DELETE FROM codes WHERE email = ?', email)
    const p = this.personByEmail(email)
    if (!p || p.kind !== 'guest' || p.status !== 'active' || this.onList(email)) throw refuse()
    const id = newId()
    const expiresAt = now + GUEST_SESSION_MS
    this.sql.run('INSERT INTO guest_sessions (id, person_id, token_hash, created_at, last_used_at, expires_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)', id, p.id, sessionHash, now, now, expiresAt, label.slice(0, 80))
    if (p.signed_in_at === null) this.sql.run('UPDATE people SET signed_in_at = ? WHERE id = ?', now, p.id)
    return { sessionId: id, expiresAt }
  }

  /** A guest's signed-in devices. `current` marks the one asking. */
  sessions(actor: Actor, now: number): { sessions: Array<{ id: string; label: string; createdAt: number; lastUsedAt: number; current: boolean }> } {
    const p = this.resolve(actor, now)
    if (actor.via !== 'session') throw new RoomError(403, 'Only a guest has devices to sign out.')
    const rows = this.sql.all<{ id: string; label: string; created_at: number; last_used_at: number; token_hash: string }>(
      'SELECT id, label, created_at, last_used_at, token_hash FROM guest_sessions WHERE person_id = ? AND expires_at > ? ORDER BY last_used_at DESC',
      p.id,
      now,
    )
    return { sessions: rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.token_hash === actor.hash })) }
  }

  /** Sign one of a guest's own devices out: its socket closes at once. */
  endSession(actor: Actor, sessionId: string, now: number): { ok: true } {
    const p = this.resolve(actor, now)
    if (actor.via !== 'session') throw new RoomError(403, 'Only a guest has devices to sign out.')
    const gone = this.sql.all<{ id: string }>('DELETE FROM guest_sessions WHERE id = ? AND person_id = ? RETURNING id', sessionId, p.id)
    if (gone.length === 0) throw new RoomError(404, 'There is no such device.')
    this.sql.run('DELETE FROM tickets WHERE session_id = ?', sessionId)
    this.outbox.push({ t: 'close', person: p.id, code: 4401, reason: 'You were signed out.', session: sessionId })
    return { ok: true }
  }

  /** This device signs out. */
  signOut(actor: Actor, now: number): { ok: true } {
    this.resolve(actor, now)
    if (actor.via !== 'session') throw new RoomError(403, 'Only a guest signs out here.')
    const s = this.sql.all<{ id: string }>('SELECT id FROM guest_sessions WHERE token_hash = ?', actor.hash)[0]
    if (s) this.endSession(actor, s.id, now)
    return { ok: true }
  }

  // --- Sockets ----------------------------------------------------------------------

  /**
   * A ticket for one socket, made at either door. The router made the hash. It names the person and when their
   * sign-in ends: a guest's session expiry, a teammate's assertion expiry (`accessEndsAt`).
   */
  issueTicket(actor: Actor, ticketHash: string, accessEndsAt: number, now: number): { endsAt: number } {
    const p = this.resolve(actor, now)
    this.sql.run('DELETE FROM tickets WHERE expires_at <= ?', now)
    let endsAt = accessEndsAt
    let sessionId: string | null = null
    if (actor.via === 'session') {
      const s = this.sql.all<{ id: string; expires_at: number }>('SELECT id, expires_at FROM guest_sessions WHERE token_hash = ?', actor.hash)[0]
      if (!s) throw new RoomError(401, 'You are signed out.')
      endsAt = s.expires_at
      sessionId = s.id
    } else if (actor.via === 'socket') {
      throw new RoomError(403, 'No.')
    }
    this.sql.run('INSERT INTO tickets (hash, person_id, session_id, ends_at, expires_at) VALUES (?, ?, ?, ?, ?)', ticketHash, p.id, sessionId, endsAt, now + TICKET_TTL_MS)
    return { endsAt }
  }

  /** Spend a ticket: once, within 60 seconds, for a person still in the workspace. */
  redeemTicket(ticketHash: string, now: number): { person: string; session: string | null; endsAt: number } {
    const t = this.sql.all<{ person_id: string; session_id: string | null; ends_at: number; expires_at: number }>('DELETE FROM tickets WHERE hash = ? RETURNING person_id, session_id, ends_at, expires_at', ticketHash)[0]
    if (!t || t.expires_at <= now || t.ends_at <= now) throw new RoomError(401, 'That ticket is not good.')
    const p = this.personById(t.person_id)
    if (!p || p.status !== 'active') throw new RoomError(401, 'That ticket is not good.')
    return { person: p.id, session: t.session_id, endsAt: t.ends_at }
  }

  // --- Timed work: the cron's questions -----------------------------------------------

  /**
   * Tidy up, and sync the teammate list into the people: a teammate taken off the list becomes a former teammate
   * (their sockets close, and the person stays with their messages), and a guest whose address is now on the list
   * loses the guest door. Also drops what has expired.
   */
  maintain(now: number): { former: number } {
    let former = 0
    for (const p of this.sql.all<PersonRow>(`SELECT * FROM people WHERE status = 'active' AND kind = 'teammate'`)) {
      if (!this.onList(p.email)) {
        this.sql.run(`UPDATE people SET status = 'former' WHERE id = ?`, p.id)
        this.outbox.push({ t: 'close', person: p.id, code: 4403, reason: `You are no longer on the ${this.install().company.name} list.` })
        former += 1
      }
    }
    for (const p of this.sql.all<PersonRow>(`SELECT * FROM people WHERE status = 'active' AND kind = 'guest'`)) {
      if (this.onList(p.email)) this.outbox.push({ t: 'close', person: p.id, code: 4401, reason: `Sign in through ${this.install().company.name}.` })
    }
    const cutoff = now - CHANGES_KEEP_MS
    const dropped = this.sql.all<{ m: number | null }>('SELECT MAX(seq) AS m FROM changes WHERE at < ?', cutoff)[0]?.m
    if (dropped) {
      this.sql.run('DELETE FROM changes WHERE seq <= ?', dropped)
      this.sql.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = MAX(value, excluded.value)', 'pruned_through', dropped)
    }
    this.sql.run('DELETE FROM tickets WHERE expires_at <= ?', now)
    this.sql.run('DELETE FROM codes WHERE expires_at <= ?', now)
    this.sql.run('DELETE FROM guest_sessions WHERE expires_at <= ?', now)
    this.sql.run('DELETE FROM compose_keys WHERE at <= ?', now - COMPOSE_KEY_KEPT_MS)
    this.pruneMailLog(now)
    return { former }
  }

  /**
   * Who is owed an email: a person with a direct message unread for 15 minutes, nobody who has the space open (a guest's open socket on this object: `online`, their ids; a teammate's page on ANY tab: `openAddresses`,
   * asked of the space's live object by the adapter), no nudge in the last hour, and nudges not turned off. One per person, naming who wrote and how many.
   * Only messages newer than the person's last nudge count, so a waiting message is told once: one episode, one email,
   * not one an hour for ever. Channels never. Nudges share the hourly email allowance (a few places are kept back for
   * sign-in codes). The text of a message is not read here, let alone returned.
   */
  dueNudges(now: number, online: string[], openAddresses: string[] = []): NudgeDue[] {
    const budget = SENDS_PER_HOUR - NUDGE_RESERVE - this.sendsInLastHour(now)
    if (budget <= 0) return []
    const away = new Set(online)
    const open = new Set(openAddresses.map((a) => a.trim().toLowerCase()))
    const due: NudgeDue[] = []
    const people = this.sql.all<PersonRow>(`SELECT * FROM people WHERE status = 'active' AND nudges_off = 0 AND last_nudge_at <= ?`, now - NUDGE_EVERY_MS)
    for (const p of people) {
      if (away.has(p.id) || open.has(p.email.trim().toLowerCase())) continue
      const rows = this.sql.all<{ person_id: string; n: number; oldest: number }>(
        `SELECT m.person_id AS person_id, COUNT(*) AS n, MIN(m.at) AS oldest
         FROM messages m JOIN conversations c ON c.id = m.conv_id JOIN conv_members cm ON cm.conv_id = c.id AND cm.person_id = ?
         WHERE c.kind = 'dm' AND c.archived_at IS NULL AND m.id > cm.last_read AND m.person_id != ? AND m.at > ?
         GROUP BY m.person_id`,
        p.id,
        p.id,
        p.last_nudge_at,
      )
      if (rows.length === 0 || Math.min(...rows.map((r) => r.oldest)) > now - NUDGE_AFTER_MS) continue
      const senders = rows.map((r) => ({ name: this.personById(r.person_id)?.name ?? 'Someone', count: r.n }))
      due.push({ person: p.id, email: p.email, name: p.name, kind: p.kind, senders, total: senders.reduce((a, s) => a + s.count, 0) })
      if (due.length >= budget) break
    }
    return due
  }

  /** The cron's one call: tidy up, then say who is owed a nudge. One request to the object every 5 minutes, not two. */
  sweep(now: number, online: string[], openAddresses: string[] = []): NudgeDue[] {
    this.maintain(now)
    return this.dueNudges(now, online, openAddresses)
  }

  /** The router sent these: each is told no more about those messages, and counts against the hour's emails. */
  nudgeSent(personIds: string[], now: number): void {
    for (const id of personIds) {
      this.sql.run('UPDATE people SET last_nudge_at = ? WHERE id = ?', now, id)
      this.sql.run(`INSERT INTO mail_log (at, email, kind) VALUES (?, (SELECT email FROM people WHERE id = ?), 'nudge')`, now, id)
    }
  }
}

// ---------------------------------------------------------------------------
// Crossing the Durable Object boundary, as in room.ts: ONE method on the object, the core's methods by name, its
// refusals as data (Workers RPC would lose a RoomError's status).

/** The core's methods the Worker may call. `catchUp` is the object's own (a socket's `hello`). */
export const WS_METHODS = [
  'bootstrap',
  'history',
  'send',
  'edit',
  'deleteMessage',
  'markRead',
  'createChannel',
  'joinChannel',
  'leaveChannel',
  'renameChannel',
  'archiveChannel',
  'addMember',
  'removeMember',
  'invite',
  'openDm',
  'updateMe',
  'ackPrivacy',
  'removePerson',
  'deletePerson',
  'requestCode',
  'verifyCode',
  'sessions',
  'endSession',
  'signOut',
  'issueTicket',
  'spaceOverview',
  'spaceHistory',
  'spaceMarkRead',
  'spacePost',
  'spaceChannel',
  'spaceBrowse',
  'spaceCreateChannel',
  'spaceInvite',
  'spaceInviteSent',
  'spaceChange',
  'spaceMessageable',
  'spaceEdit',
  'spaceDelete',
  'spaceMe',
  'spaceUpdateMe',
  'spaceAckPrivacy',
  'callBegin',
  'callRecord',
  'spaceRelate',
  'spaceCards',
  'spaceMeetings',
  'spacePhone',
  'spacePhoneRead',
  'redeemTicket',
  'maintain',
  'dueNudges',
  'sweep',
  'nudgeSent',
] as const satisfies ReadonlyArray<keyof WorkspaceCore>
export type WsMethod = (typeof WS_METHODS)[number]

export type WsInvokeResult = { ok: true; value: unknown } | { ok: false; status: RoomError['status']; message: string }

export function invokeWorkspace(core: WorkspaceCore, method: string, args: unknown[]): WsInvokeResult {
  if (!(WS_METHODS as readonly string[]).includes(method)) return { ok: false, status: 400, message: 'unknown method' }
  try {
    const fn = core[method as WsMethod] as (...a: unknown[]) => unknown
    return { ok: true, value: fn.apply(core, args) }
  } catch (err) {
    if (err instanceof RoomError) return { ok: false, status: err.status, message: err.message }
    throw err
  }
}

export type WorkspaceClient = {
  [K in WsMethod]: (...args: Parameters<WorkspaceCore[K]>) => Promise<ReturnType<WorkspaceCore[K]>>
}

export function workspaceClient(invoke: (method: WsMethod, args: unknown[]) => Promise<WsInvokeResult> | WsInvokeResult): WorkspaceClient {
  const client = {} as Record<WsMethod, (...args: unknown[]) => Promise<unknown>>
  for (const method of WS_METHODS) {
    client[method] = async (...args) => {
      const res = await invoke(method, args)
      if (!res.ok) throw new RoomError(res.status, res.message)
      return res.value
    }
  }
  return client as unknown as WorkspaceClient
}
