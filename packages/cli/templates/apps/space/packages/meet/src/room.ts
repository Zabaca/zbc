// One call's state and every rule about changing it.
//
// RoomCore runs INSIDE the Room's Durable Object, over the DO's synchronous
// SQLite, and never calls the network. That placement is the concurrency story:
// a DO handles one call at a time and none of these methods awaits anything, so
// "the 9th person is refused" and "a seat is taken or not" are true without
// locks. The Worker (app.ts) does everything external (the SFU, TURN, Access)
// and tells the Room what succeeded; this file only keeps who is in the call and
// what each person is sending.
//
// The same class runs over bun:sqlite in the tests, through the two-method Sql
// interface below, so the rules are tested against the real SQL.
//
// Members are known by the SHA-256 of a random token their browser keeps in that
// tab's session storage. The Room stores only the hash. Every media request
// names the member's current GENERATION: a join, or a rejoin with the same
// token, starts a new one, so a reply meant for a replaced connection cannot
// change the new one. A `record*` method answers false when the generation has
// moved on, which tells the router to close what it just created.
//
// Every method that needs the time takes `now`, so tests pin it.

import { CHAT_MAX, CHAT_PAGE, CHAT_RATE, CHAT_ROOM_CAP, MEMBER_TIMEOUT_MS, NAME_MAX, ROOM_CAP, isKind, qualityFor, rateBps } from './model'
import type { ChatDelta, ChatMessage, Kind, RoomInfo, Snapshot, SnapshotMember } from './model'
import type { IceServer } from './realtime'

/** What the operator's counts read of a call's object and of the ledger (RoomDO.counts). Constants, never a caller's. */
export const ROOM_COUNTED = ['room', 'members', 'messages', 'calls', 'usage', 'orphans', 'pubs', 'subs'] as const

/**
 * How many rows each of these tables holds, for the operator who moves the stores between Workers: the counts read before and
 * after a move must be equal. The table names are this file's own constants, never a caller's, a table the object has not made yet is 0, and the answer is numbers under names: nothing
 * of a message, a call or a person.
 */
export function countRows(sql: Sql, tables: readonly string[], grouped: readonly { table: string; by: string }[] = []): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = rowsOf(sql, `SELECT COUNT(*) AS n FROM ${t}`)
  // `by` is a column of that table, a constant here too: the count of each of its values (people by kind, conversations by kind).
  for (const { table, by } of grouped) {
    try {
      for (const r of sql.all<{ v: string | null; n: number }>(`SELECT ${by} AS v, COUNT(*) AS n FROM ${table} GROUP BY ${by}`)) out[`${table}:${r.v ?? 'none'}`] = r.n
    } catch {
      // The table is not there yet: nothing to count.
    }
  }
  return out
}

const rowsOf = (sql: Sql, query: string): number => {
  try {
    return sql.all<{ n: number }>(query)[0]?.n ?? 0
  } catch {
    return 0
  }
}

/** The DO instance that holds the service-wide usage ledger. Same class as a Room, used only for its `usage` table. */
export const LEDGER_NAME = '_ledger'

/** The synchronous SQL surface RoomCore needs: the DO's storage.sql or bun:sqlite. */
export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  run(sql: string, ...params: unknown[]): void
}

/**
 * The tables as first written, plus the orphans table the first deploy added. FROZEN:
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that exists, and a call someone has started keeps
 * its storage. So never edit a statement here. A new COLUMN goes in ADDITIONS, a new TABLE in ADDED_TABLES (both
 * below), and `migrate()` brings every call up to date on its next boot.
 */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    pending_bytes REAL NOT NULL DEFAULT 0,
    flushed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    send_session TEXT,
    recv_session TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    camera_off INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_meter INTEGER NOT NULL
  )`,
  // One row per thing a member is publishing. `v` is the member's counter at the
  // time, so publishing the same kind again is a different publication.
  `CREATE TABLE IF NOT EXISTS pubs (
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    v INTEGER NOT NULL,
    track_name TEXT NOT NULL,
    mid TEXT NOT NULL,
    PRIMARY KEY (member_id, kind)
  )`,
  // One row per track a member pulled in. The mid is what closing it needs.
  `CREATE TABLE IF NOT EXISTS subs (
    member_id TEXT NOT NULL,
    pub_member_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    v INTEGER NOT NULL,
    track_name TEXT NOT NULL,
    mid TEXT NOT NULL,
    PRIMARY KEY (member_id, pub_member_id, kind, v)
  )`,
  // Tracks at the SFU that nobody in the Room owns any more (their member was reaped, left, or rejoined).
  // The router closes them; a row stays until the SFU has taken the close (see takeOrphans).
  `CREATE TABLE IF NOT EXISTS orphans (session TEXT NOT NULL, mid TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)`,
  // The ledger instance: bytes per UTC month.
  `CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, bytes REAL NOT NULL)`,
]

/**
 * Whole tables added after SCHEMA was frozen, in order. Append only. Every one is `CREATE TABLE IF NOT EXISTS`, run
 * on every boot of any call that has data, so a call started before a table existed gets it on its next boot.
 * (A column added to a table that already exists goes in ADDITIONS instead.)
 */
export const ADDED_TABLES = [
  // Chat. `name` is the sender's name when they sent it: members are deleted when they leave, messages stay.
  // AUTOINCREMENT so an id is never reused after a delete, and a browser that has seen id N never mistakes a new
  // message for an old one.
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // The ledger instance's index of the calls a person has started (the past-calls list). A Room never reads it.
  `CREATE TABLE IF NOT EXISTS calls (name TEXT PRIMARY KEY, started_at INTEGER NOT NULL)`,
]

/**
 * Columns added to SCHEMA's tables, in order. Append only; a column is added to any call that lacks it.
 * The first deploy already had `members.ice` and `ice_expires`, so its calls skip those two.
 */
export const ADDITIONS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  { table: 'members', column: 'ice', definition: 'TEXT' },
  { table: 'members', column: 'ice_expires', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'room', column: 'offered_bytes', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'room', column: 'offered_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'orphans', column: 'created_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'orphans', column: 'next_try_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Chat's rate limit: the start of the member's current window and how many they have sent in it.
  { table: 'members', column: 'chat_window_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'members', column: 'chat_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Seats taken over the life of the call, for the list of calls. Calls started before this count from their next new member.
  { table: 'room', column: 'people', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Who made the call, as the address that names them in the declaration, so Today can show a person the calls that are theirs. A call
  // made before this column existed has none: only the owner could make calls then, and the space reads a missing one as the owner's.
  { table: 'calls', column: 'started_by', definition: 'TEXT' },
  // When the last person left, so a call card can say how long it ran. Null for a call that ended before this column existed, and while anyone is in it.
  { table: 'room', column: 'ended_at', definition: 'INTEGER' },
  // When the first person took a seat: with `ended_at`, how long the call ran. A call that began before this column existed has none.
  { table: 'room', column: 'opened_at', definition: 'INTEGER' },
]

export class RoomError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
    message: string,
  ) {
    super(message)
  }
}

interface MemberRow {
  id: string
  token_hash: string
  name: string
  generation: number
  seq: number
  send_session: string | null
  recv_session: string | null
  ice: string | null
  ice_expires: number
  muted: number
  camera_off: number
  joined_at: number
  last_seen: number
  last_meter: number
  chat_window_at: number
  chat_count: number
}

/** The Room offers its estimate to the ledger at most this often, and at once when the last person leaves. */
export const USAGE_FLUSH_MS = 10_000
/** Bytes offered to the router count as handed over for this long. If the write never comes back they are offered again after it. */
export const USAGE_LEASE_MS = 30_000
/** A rejoin reuses a member's relay credentials while they have at least this long left. */
export const ICE_MARGIN_MS = 30 * 60_000
/** An orphaned track the SFU will not close is tried again with growing pauses, and given up on after this long. */
export const ORPHAN_GIVE_UP_MS = 10 * 60_000
export const orphanBackoffMs = (tries: number): number => Math.min(60_000, 2_000 * 2 ** tries)

export interface Orphan {
  /** The row, handed back to `closedOrphans` once the SFU has closed the track. */
  id: number
  session: string
  mid: string
}

/** One check-in never counts more than this much time, so a long gap is not billed as streaming. */
export const METER_STEP_CAP_MS = 10_000

export interface Publication {
  kind: Kind
  trackName: string
  v: number
  mid: string
}
export interface Wanted {
  memberId: string
  kind: Kind
  v: number
}
export interface Pulled extends Wanted {
  trackName: string
  mid: string
}

export class RoomCore {
  /** Whether this instance has ever been written to. A name nobody started stays untouched: no schema, no storage. */
  private ready: boolean

  constructor(private readonly sql: Sql) {
    this.ready = sql.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").length > 0
    // An instance that has data is migrated on every boot, so a call started by an earlier commit keeps working.
    if (this.ready) this.migrate()
  }

  /**
   * Bring this instance's storage to today's shape: the frozen tables, then the tables in ADDED_TABLES, then
   * every column in ADDITIONS that the table lacks (`ALTER TABLE ADD COLUMN`, guarded by `PRAGMA table_info`). Safe on every boot and on
   * a call started by any earlier commit.
   */
  private migrate(): void {
    for (const stmt of SCHEMA) this.sql.run(stmt)
    for (const stmt of ADDED_TABLES) this.sql.run(stmt)
    const have = new Map<string, Set<string>>()
    for (const { table, column, definition } of ADDITIONS) {
      if (!have.has(table)) have.set(table, new Set(this.sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)))
      if (!have.get(table)?.has(column)) this.sql.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.ready = true
  }

  // --- The room -------------------------------------------------------------

  exists(): boolean {
    return this.ready && this.sql.all('SELECT 1 FROM room WHERE id = 1').length > 0
  }

  create(name: string, now: number): void {
    if (this.exists()) throw new RoomError(409, 'room exists')
    this.migrate()
    this.sql.run('INSERT INTO room (id, name, created_at, flushed_at) VALUES (1, ?, ?, ?)', name, now, now)
  }

  // THE THREE BELOW ARE THE OBJECT'S OWN (src/do.ts), for telling the space's live object when who is in the call changes. They are not on
  // ROOM_METHODS: no caller reaches them. None of the three but `reapNow` writes.

  /** How many are in the call right now, WITHOUT dropping anyone who has timed out: the count before a call is the count the last call left, so a person a later call drops is seen to go. 0 for a call that does not exist. */
  presentNow(): number {
    return this.exists() ? this.members().length : 0
  }

  /** When the next person present would be dropped for not being heard from (ms), or null when nobody is in the call. */
  nextReapAt(): number | null {
    if (!this.exists()) return null
    const oldest = this.sql.all<{ at: number | null }>('SELECT MIN(last_seen) AS at FROM members')[0]?.at
    return typeof oldest === 'number' ? oldest + MEMBER_TIMEOUT_MS + 1 : null
  }

  /** Drop everyone not heard from for MEMBER_TIMEOUT_MS as of `now`: the alarm's work, for a call nobody is calling. */
  reapNow(now: number): void {
    this.reap(now)
  }

  /** How many are in the call now, for the lobby. */
  info(now: number): RoomInfo {
    this.reap(now)
    const count = this.members().length
    return { count, cap: ROOM_CAP, full: count >= ROOM_CAP }
  }

  // --- Members --------------------------------------------------------------

  /**
   * Take a seat, or take the same seat again after a refresh or a drop (same
   * token): a new generation, no sessions, nothing published or pulled until the
   * browser does it again. `pausedUntil` is set when the usage meter has
   * tripped: it refuses a new person and lets a returning one back in.
   */
  join(
    tokenHash: string,
    memberId: string,
    rawName: string,
    now: number,
    pausedUntil: string | null,
  ): { memberId: string; generation: number; snapshot: Snapshot; ice: IceServer[] | null; chatLast: number } {
    this.requireRoom()
    this.reap(now)
    const name = cleanName(rawName)
    const existing = this.byToken(tokenHash)
    if (existing) {
      // Relay credentials this person still holds are handed back, so a rejoin never mints more. While the
      // meter has tripped, someone with none left is refused like a new person: nothing new is issued.
      const ice = existing.ice && existing.ice_expires > now + ICE_MARGIN_MS ? (JSON.parse(existing.ice) as IceServer[]) : null
      if (!ice && pausedUntil) throw new RoomError(403, `Calls are paused until ${pausedUntil}.`)
      // The old connection's tracks are closed at the SFU by the router, so an old tab left open stops receiving.
      this.orphan(existing, now)
      this.sql.run(
        'UPDATE members SET generation = generation + 1, name = ?, send_session = NULL, recv_session = NULL, last_seen = ?, last_meter = ? WHERE id = ?',
        name,
        now,
        now,
        existing.id,
      )
      this.sql.run('DELETE FROM pubs WHERE member_id = ?', existing.id)
      this.sql.run('DELETE FROM subs WHERE member_id = ?', existing.id)
      this.bump()
      return { memberId: existing.id, generation: existing.generation + 1, snapshot: this.snapshot(now), ice, chatLast: this.chatSince(null).last }
    }
    // The usage meter has tripped: a new person may not take a seat.
    if (pausedUntil) throw new RoomError(403, `Calls are paused until ${pausedUntil}.`)
    if (this.members().length >= ROOM_CAP) throw new RoomError(409, 'This call is full.')
    this.sql.run(
      'INSERT INTO members (id, token_hash, name, generation, joined_at, last_seen, last_meter) VALUES (?, ?, ?, 1, ?, ?, ?)',
      memberId,
      tokenHash,
      name,
      now,
      now,
      now,
    )
    this.sql.run('UPDATE room SET people = people + 1, opened_at = COALESCE(opened_at, ?) WHERE id = 1', now)
    this.bump()
    return { memberId, generation: 1, snapshot: this.snapshot(now), ice: null, chatLast: this.chatSince(null).last }
  }

  /**
   * The router made this member's two SFU sessions (and, when the join did not
   * reuse any, fresh relay credentials to keep). False if the member has moved on since.
   */
  setSessions(
    tokenHash: string,
    generation: number,
    sendSession: string,
    recvSession: string,
    ice: { servers: IceServer[]; expiresAt: number } | null,
    now: number,
  ): boolean {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return false
    this.sql.run('UPDATE members SET send_session = ?, recv_session = ? WHERE id = ?', sendSession, recvSession, m.id)
    if (ice) this.sql.run('UPDATE members SET ice = ?, ice_expires = ? WHERE id = ?', JSON.stringify(ice.servers), ice.expiresAt, m.id)
    return true
  }

  /** The two SFU sessions of the member's current connection, for the requests that need only those. */
  sessions(tokenHash: string, generation: number, now: number): { sendSession: string | null; recvSession: string | null } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    return { sendSession: m.send_session, recvSession: m.recv_session }
  }

  /**
   * The heartbeat and the read: marks the member present, takes their flags,
   * adds to the usage estimate, and returns the call as it stands. It also
   * carries what the router has to do outside: the usage to offer the ledger
   * every so often (`usage`, bytes) and the tracks to close at the SFU
   * (`orphans`). All of it comes in the one reply, so the check-in every 2
   * seconds costs one Durable Object request.
   */
  checkIn(
    tokenHash: string,
    generation: number,
    flags: { muted: boolean; cameraOff: boolean },
    now: number,
    /**
     * The newest message id this browser already holds (0 for none): the reply carries what came after. Null
     * (not asked) carries no messages, which is what a tab still running code from before chat gets.
     */
    since: number | null = null,
  ): { snapshot: Snapshot; usage: number; orphans: Orphan[]; chat: ChatDelta } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    const muted = flags.muted ? 1 : 0
    const cameraOff = flags.cameraOff ? 1 : 0
    if (muted !== m.muted || cameraOff !== m.camera_off) this.bump()
    this.sql.run(
      'UPDATE members SET muted = ?, camera_off = ?, last_seen = ?, last_meter = ? WHERE id = ?',
      muted,
      cameraOff,
      now,
      now,
      m.id,
    )
    this.accrue(m, now)
    return { snapshot: this.snapshot(now), usage: this.claimUsage(now), orphans: this.takeOrphans(now), chat: this.chatSince(since) }
  }

  /**
   * Leave on purpose. Their tracks become orphans for the router to close; a
   * stale generation does nothing. `usage` is what the Room has estimated and
   * not yet handed over, offered at once if they were the last one.
   */
  leave(tokenHash: string, generation: number, now: number): { usage: number } | null {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return null
    this.accrue(m, now)
    this.remove(m, now)
    this.bump()
    return { usage: this.claimUsage(now) }
  }

  // --- Chat -----------------------------------------------------------------
  //
  // Delivery rides the check-in: the reply carries the messages after the id the browser last saw, so there is no
  // second connection to keep and nothing new to reconnect. A message reaches the others within a check-in (2 s).
  // Only a joined member can send or read; a call's saved chat is read and deleted by the owner through SpaceMeet (space-meet.ts).

  /** Send a message as this member. Returns it as stored. */
  chat(tokenHash: string, generation: number, rawText: unknown, now: number): ChatMessage {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    const text = cleanMessage(rawText)
    if (text === '') throw new RoomError(400, 'Write something to send.')
    if (text.length > CHAT_MAX) throw new RoomError(400, `A message can be up to ${CHAT_MAX.toLocaleString('en-US')} characters.`)
    const windowOpen = now - m.chat_window_at < CHAT_RATE.windowMs
    const sent = windowOpen ? m.chat_count : 0
    if (sent >= CHAT_RATE.max) throw new RoomError(429, 'You are sending messages too fast. Wait a few seconds.')
    if (this.messageCount() >= CHAT_ROOM_CAP) throw new RoomError(429, 'This chat is full.')
    this.sql.run(
      'UPDATE members SET chat_window_at = ?, chat_count = ? WHERE id = ?',
      windowOpen ? m.chat_window_at : now,
      sent + 1,
      m.id,
    )
    const row = this.sql.all<{ id: number }>(
      'INSERT INTO messages (member_id, name, text, at) VALUES (?, ?, ?, ?) RETURNING id',
      m.id,
      m.name,
      text,
      now,
    )[0] as { id: number }
    return { id: row.id, memberId: m.id, name: m.name, text, at: now }
  }

  /** The messages after `since`, oldest first, at most CHAT_PAGE of them, and the newest id in the call. Null: none, just the newest id. */
  private chatSince(since: number | null): ChatDelta {
    const after = since !== null && Number.isInteger(since) && since > 0 ? since : 0
    const messages =
      since === null
        ? []
        : this.sql.all<ChatMessage>(
            'SELECT id, member_id AS memberId, name, text, at FROM messages WHERE id > ? ORDER BY id LIMIT ?',
            after,
            CHAT_PAGE,
          )
    const last = this.sql.all<{ last: number }>('SELECT COALESCE(MAX(id), 0) AS last FROM messages')[0]?.last ?? 0
    return { messages, last }
  }

  private messageCount(): number {
    return this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages')[0]?.n ?? 0
  }

  /** For the list of calls: how the call went. A name nobody started is a 404 and nothing is written. */
  summary(now: number): { startedAt: number; people: number; messages: number; present: number; endedAt: number | null; openedAt: number | null } {
    this.requireRoom()
    this.reap(now)
    const r = this.sql.all<{ created_at: number; people: number; ended_at: number | null; opened_at: number | null }>('SELECT created_at, people, ended_at, opened_at FROM room WHERE id = 1')[0] as {
      created_at: number
      people: number
      ended_at: number | null
      opened_at: number | null
    }
    const present = this.members().length
    return { startedAt: r.created_at, people: Math.max(r.people, present), messages: this.messageCount(), present, endedAt: present > 0 ? null : r.ended_at, openedAt: r.opened_at }
  }

  /** Every message, oldest first, for the owner to read after the call. */
  history(): ChatMessage[] {
    this.requireRoom()
    return this.sql.all<ChatMessage>('SELECT id, member_id AS memberId, name, text, at FROM messages ORDER BY id LIMIT ?', CHAT_ROOM_CAP)
  }

  /**
   * Remove every message for good. Refused while anyone is in the call: their browsers would go on sending
   * into a chat whose past the start page no longer shows.
   */
  deleteMessages(now: number): number {
    this.requireRoom()
    this.reap(now)
    if (this.members().length > 0) throw new RoomError(409, 'Someone is in this call right now. Delete its messages once everyone has left.')
    const n = this.messageCount()
    this.sql.run('DELETE FROM messages')
    return n
  }

  // --- Publishing -----------------------------------------------------------

  /** Names for tracks about to be published. Nothing is recorded until `recordPublished`. */
  planPublish(
    tokenHash: string,
    generation: number,
    kinds: unknown,
    now: number,
  ): { sendSession: string; tracks: Array<{ kind: Kind; trackName: string; v: number }> } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(isKind) || new Set(kinds).size !== kinds.length) {
      throw new RoomError(400, 'unknown track kind')
    }
    if (!m.send_session) throw new RoomError(409, 'not connected yet')
    const held = new Set(this.sql.all<{ kind: string }>('SELECT kind FROM pubs WHERE member_id = ?', m.id).map((r) => r.kind))
    if (kinds.some((k) => held.has(k))) throw new RoomError(409, 'already publishing that')
    const tracks = kinds.map((kind, i) => {
      const v = m.seq + 1 + i
      return { kind, trackName: `${kind}-${v}`, v }
    })
    this.sql.run('UPDATE members SET seq = seq + ? WHERE id = ?', kinds.length, m.id)
    return { sendSession: m.send_session, tracks }
  }

  /** The SFU accepted these. False when the member has moved on, so the router must close them. */
  recordPublished(tokenHash: string, generation: number, pubs: Publication[], now: number): boolean {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return false
    for (const p of pubs) {
      this.sql.run(
        'INSERT OR REPLACE INTO pubs (member_id, kind, v, track_name, mid) VALUES (?, ?, ?, ?, ?)',
        m.id,
        p.kind,
        p.v,
        p.trackName,
        p.mid,
      )
    }
    if (pubs.length > 0) this.bump()
    return true
  }

  planUnpublish(
    tokenHash: string,
    generation: number,
    kinds: unknown,
    now: number,
  ): { sendSession: string | null; items: Array<{ kind: Kind; mid: string }> } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    if (!Array.isArray(kinds) || !kinds.every(isKind)) throw new RoomError(400, 'unknown track kind')
    const items = this.sql
      .all<{ kind: Kind; mid: string }>('SELECT kind, mid FROM pubs WHERE member_id = ?', m.id)
      .filter((r) => kinds.includes(r.kind))
    return { sendSession: m.send_session, items }
  }

  recordUnpublished(tokenHash: string, generation: number, kinds: Kind[], now: number): void {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return
    for (const kind of kinds) this.sql.run('DELETE FROM pubs WHERE member_id = ? AND kind = ?', m.id, kind)
    this.bump()
  }

  // --- Subscribing ----------------------------------------------------------

  /**
   * Turn "I want Ana's camera" into the publisher's session and track name.
   * People and kinds that are not there (any more) are left out, and so is
   * anything this member already pulled in.
   */
  resolveSubscribe(
    tokenHash: string,
    generation: number,
    wants: unknown,
    now: number,
  ): { recvSession: string; items: Array<Wanted & { sessionId: string; trackName: string }> } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    if (!m.recv_session) throw new RoomError(409, 'not connected yet')
    if (!Array.isArray(wants)) throw new RoomError(400, 'wants must be a list')
    const items: Array<Wanted & { sessionId: string; trackName: string }> = []
    for (const w of wants as Array<Partial<Wanted>>) {
      if (typeof w?.memberId !== 'string' || !isKind(w.kind) || typeof w.v !== 'number') throw new RoomError(400, 'bad request')
      if (w.memberId === m.id) continue
      const row = this.sql.all<{ track_name: string; send_session: string | null }>(
        `SELECT p.track_name, m.send_session FROM pubs p JOIN members m ON m.id = p.member_id
         WHERE p.member_id = ? AND p.kind = ? AND p.v = ?`,
        w.memberId,
        w.kind,
        w.v,
      )[0]
      if (!row || !row.send_session) continue
      const held = this.sql.all(
        'SELECT 1 FROM subs WHERE member_id = ? AND pub_member_id = ? AND kind = ? AND v = ?',
        m.id,
        w.memberId,
        w.kind,
        w.v,
      )
      if (held.length > 0) continue
      items.push({ memberId: w.memberId, kind: w.kind, v: w.v, sessionId: row.send_session, trackName: row.track_name })
    }
    return { recvSession: m.recv_session, items }
  }

  recordSubscribed(tokenHash: string, generation: number, pulled: Pulled[], now: number): boolean {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return false
    for (const p of pulled) {
      this.sql.run(
        'INSERT OR REPLACE INTO subs (member_id, pub_member_id, kind, v, track_name, mid) VALUES (?, ?, ?, ?, ?, ?)',
        m.id,
        p.memberId,
        p.kind,
        p.v,
        p.trackName,
        p.mid,
      )
    }
    return true
  }

  planUnsubscribe(
    tokenHash: string,
    generation: number,
    wants: unknown,
    now: number,
  ): { recvSession: string | null; items: Array<Wanted & { mid: string }> } {
    this.reap(now)
    const m = this.member(tokenHash, generation)
    if (!Array.isArray(wants)) throw new RoomError(400, 'wants must be a list')
    const items: Array<Wanted & { mid: string }> = []
    for (const w of wants as Array<Partial<Wanted>>) {
      if (typeof w?.memberId !== 'string' || !isKind(w.kind) || typeof w.v !== 'number') throw new RoomError(400, 'bad request')
      const row = this.sql.all<{ mid: string }>(
        'SELECT mid FROM subs WHERE member_id = ? AND pub_member_id = ? AND kind = ? AND v = ?',
        m.id,
        w.memberId,
        w.kind,
        w.v,
      )[0]
      if (row) items.push({ memberId: w.memberId, kind: w.kind, v: w.v, mid: row.mid })
    }
    return { recvSession: m.recv_session, items }
  }

  recordUnsubscribed(tokenHash: string, generation: number, items: Wanted[], now: number): void {
    this.reap(now)
    const m = this.current(tokenHash, generation)
    if (!m) return
    for (const w of items) {
      this.sql.run('DELETE FROM subs WHERE member_id = ? AND pub_member_id = ? AND kind = ? AND v = ?', m.id, w.memberId, w.kind, w.v)
    }
  }

  // --- The usage estimate ---------------------------------------------------

  /**
   * What this Room has estimated and the ledger has not been given, offered at
   * most every USAGE_FLUSH_MS and at once when nobody is left in the call. The
   * bytes offered are CLAIMED (`offered_bytes`, leased for USAGE_LEASE_MS), so a
   * second check-in arriving before the first one's write is acknowledged is
   * offered only what is new. Nothing is cleared until `ackUsage`: a write that
   * fails loses nothing, because the lease runs out and the bytes are offered
   * again. A lost acknowledgement counts them twice, which errs high, as the
   * meter should.
   */
  private claimUsage(now: number): number {
    const r = this.sql.all<{ pending_bytes: number; flushed_at: number; offered_bytes: number; offered_at: number }>(
      'SELECT pending_bytes, flushed_at, offered_bytes, offered_at FROM room WHERE id = 1',
    )[0]
    if (!r) return 0
    // With nobody left there is no later check-in to offer a leased claim again, so an empty Room offers
    // everything it holds, lease or not (a claim that was in fact written then counts twice: that errs high).
    const empty = this.members().length === 0
    const live = !empty && now - r.offered_at < USAGE_LEASE_MS
    const claimed = live ? r.offered_bytes : 0
    const amount = r.pending_bytes - claimed
    if (amount <= 0) return 0
    if (!empty && now - r.flushed_at < USAGE_FLUSH_MS) return 0
    // The lease is dated from the OLDEST claim still out, never refreshed by a newer one: otherwise bytes
    // from a write that failed would stay claimed for as long as new claims kept coming, and never go in.
    this.sql.run(
      'UPDATE room SET offered_bytes = pending_bytes, offered_at = ?, flushed_at = ? WHERE id = 1',
      claimed > 0 ? r.offered_at : now,
      now,
    )
    return amount
  }

  /** The ledger has these bytes now: take exactly them off, whatever has been added since. */
  ackUsage(bytes: number): void {
    this.sql.run(
      'UPDATE room SET pending_bytes = MAX(0, pending_bytes - ?), offered_bytes = MAX(0, offered_bytes - ?) WHERE id = 1',
      bytes,
      bytes,
    )
  }

  // --- Tracks at the SFU nobody owns ------------------------------------------

  /**
   * The tracks due to be closed now. Each is pushed back as it is handed out
   * (2 s, 4 s, 8 s, up to a minute) and stays until `closedOrphans` says the SFU
   * took the close, so a failed attempt, a crashed request or a busy SFU all
   * come round again. A track still open after ORPHAN_GIVE_UP_MS is given up on.
   */
  takeOrphans(now: number): Orphan[] {
    if (!this.ready) return []
    this.sql.run('UPDATE orphans SET created_at = ? WHERE created_at = 0', now) // rows from before the column existed
    this.sql.run('DELETE FROM orphans WHERE created_at < ?', now - ORPHAN_GIVE_UP_MS)
    const rows = this.sql.all<Orphan & { tries: number }>(
      'SELECT rowid AS id, session, mid, tries FROM orphans WHERE next_try_at <= ? ORDER BY rowid',
      now,
    )
    for (const r of rows)
      this.sql.run('UPDATE orphans SET tries = tries + 1, next_try_at = ? WHERE rowid = ?', now + orphanBackoffMs(r.tries), r.id)
    return rows.map(({ id, session, mid }) => ({ id, session, mid }))
  }

  /**
   * The SFU closed these. Matched on the track as well as the row: the table has no INTEGER PRIMARY KEY, so
   * SQLite reuses a rowid once its row is gone, and a slow acknowledgement must not delete a newer orphan
   * that was given the same one.
   */
  closedOrphans(items: Array<{ id: number; session: string; mid: string }>): void {
    for (const o of items) this.sql.run('DELETE FROM orphans WHERE rowid = ? AND session = ? AND mid = ?', o.id, o.session, o.mid)
  }

  /** Tracks the router made at the SFU and could not keep (it lost a race with a leave or a rejoin) and could not close either. */
  addOrphans(items: Array<{ session: string; mid: string }>, now: number): void {
    for (const o of items) this.sql.run('INSERT INTO orphans (session, mid, created_at) VALUES (?, ?, ?)', o.session, o.mid, now)
  }

  // --- The ledger instance --------------------------------------------------

  addUsage(month: string, bytes: number): void {
    this.migrate()
    this.sql.run(
      'INSERT INTO usage (month, bytes) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET bytes = bytes + excluded.bytes',
      month,
      bytes,
    )
  }

  usageFor(month: string): number {
    if (!this.ready) return 0
    return this.sql.all<{ bytes: number }>('SELECT bytes FROM usage WHERE month = ?', month)[0]?.bytes ?? 0
  }

  /** The past-calls index (the ledger instance): a call a person has started, and who made it. Only ever written by the start route. */
  recordCall(name: string, now: number, startedBy: string | null = null): void {
    this.migrate()
    this.sql.run('INSERT OR IGNORE INTO calls (name, started_at, started_by) VALUES (?, ?, ?)', name, now, startedBy)
  }

  /** One call of the index (the ledger instance), or null: who made it and when. */
  indexed(name: string): { name: string; startedAt: number; startedBy: string | null } | null {
    if (!this.ready) return null
    return this.sql.all<{ name: string; startedAt: number; startedBy: string | null }>('SELECT name, started_at AS startedAt, started_by AS startedBy FROM calls WHERE name = ?', name)[0] ?? null
  }

  /**
   * One page of the calls, newest first (ties by name). `after` is the last call of the page before: the next page
   * starts just past it, so a call started while the owner is paging neither repeats nor hides another.
   * `next` is that cursor for the page after this one, or null at the end.
   */
  listCalls(
    limit: number,
    after: { startedAt: number; name: string } | null = null,
  ): { calls: Array<{ name: string; startedAt: number; startedBy: string | null }>; next: { startedAt: number; name: string } | null } {
    if (!this.ready) return { calls: [], next: null }
    const rows = this.sql.all<{ name: string; startedAt: number; startedBy: string | null }>(
      `SELECT name, started_at AS startedAt, started_by AS startedBy FROM calls
       WHERE ? IS NULL OR started_at < ? OR (started_at = ? AND name > ?)
       ORDER BY started_at DESC, name LIMIT ?`,
      after?.startedAt ?? null,
      after?.startedAt ?? 0,
      after?.startedAt ?? 0,
      after?.name ?? '',
      limit + 1,
    )
    const calls = rows.slice(0, limit)
    const last = calls.at(-1)
    return { calls, next: rows.length > limit && last ? { startedAt: last.startedAt, name: last.name } : null }
  }

  // --- Internals ------------------------------------------------------------

  private requireRoom(): void {
    if (!this.exists()) throw new RoomError(404, 'This is not a call.')
  }

  private members(): MemberRow[] {
    return this.sql.all<MemberRow>('SELECT * FROM members ORDER BY joined_at, id')
  }

  private byToken(tokenHash: string): MemberRow | undefined {
    return this.sql.all<MemberRow>('SELECT * FROM members WHERE token_hash = ?', tokenHash)[0]
  }

  /** The member for this token and generation, or an error saying which part is wrong. */
  private member(tokenHash: string, generation: number): MemberRow {
    this.requireRoom()
    const m = this.byToken(tokenHash)
    if (!m) throw new RoomError(401, 'You are not in this call.')
    if (m.generation !== generation) throw new RoomError(409, 'This connection was replaced.')
    return m
  }

  /** Like `member`, but null instead of an error: the answer a `record*` or `leave` gives a late reply. */
  private current(tokenHash: string, generation: number): MemberRow | null {
    const m = this.exists() ? this.byToken(tokenHash) : undefined
    return m && m.generation === generation ? m : null
  }

  private bump(): void {
    this.sql.run('UPDATE room SET revision = revision + 1 WHERE id = 1')
  }

  /** Queue the member's tracks at the SFU, on both their sessions, to be closed. */
  private orphan(m: MemberRow, now: number): void {
    if (m.send_session) {
      for (const { mid } of this.sql.all<{ mid: string }>('SELECT mid FROM pubs WHERE member_id = ? ORDER BY rowid', m.id)) {
        this.sql.run('INSERT INTO orphans (session, mid, created_at) VALUES (?, ?, ?)', m.send_session, mid, now)
      }
    }
    if (m.recv_session) {
      for (const { mid } of this.sql.all<{ mid: string }>('SELECT mid FROM subs WHERE member_id = ? ORDER BY rowid', m.id)) {
        this.sql.run('INSERT INTO orphans (session, mid, created_at) VALUES (?, ?, ?)', m.recv_session, mid, now)
      }
    }
  }

  /** `at` is when the person left: their leave, or for one dropped as gone, the last time they were heard from. */
  private remove(m: MemberRow, now: number, at: number = now): void {
    this.orphan(m, now)
    this.sql.run('DELETE FROM pubs WHERE member_id = ?', m.id)
    this.sql.run('DELETE FROM subs WHERE member_id = ?', m.id)
    this.sql.run('DELETE FROM members WHERE id = ?', m.id)
    if (this.members().length === 0) this.sql.run('UPDATE room SET ended_at = ? WHERE id = 1', at)
  }

  /** Drop everyone not heard from for MEMBER_TIMEOUT_MS, and queue their tracks to be closed (docs/adr/0001, section 2). */
  private reap(now: number): void {
    if (!this.exists()) return
    const gone = this.sql.all<MemberRow>('SELECT * FROM members WHERE last_seen < ?', now - MEMBER_TIMEOUT_MS)
    for (const m of gone) this.remove(m, now, m.last_seen)
    if (gone.length > 0) this.bump()
  }

  /** Add the bytes this member was sent since their last check-in, at the send caps, to the Room's estimate. */
  private accrue(m: MemberRow, now: number): void {
    const seconds = Math.min(METER_STEP_CAP_MS, Math.max(0, now - m.last_meter)) / 1000
    if (seconds === 0) return
    const quality = qualityFor(this.members().length)
    const pulled = this.sql.all<{ kind: Kind }>(
      `SELECT s.kind FROM subs s JOIN pubs p
         ON p.member_id = s.pub_member_id AND p.kind = s.kind AND p.v = s.v
       WHERE s.member_id = ?`,
      m.id,
    )
    const bps = pulled.reduce((sum, r) => sum + rateBps(r.kind, quality), 0)
    if (bps > 0) this.sql.run('UPDATE room SET pending_bytes = pending_bytes + ? WHERE id = 1', (bps * seconds) / 8)
  }

  private snapshot(now: number): Snapshot {
    this.reap(now)
    const rows = this.members()
    const pubs = this.sql.all<{ member_id: string; kind: Kind; v: number }>('SELECT member_id, kind, v FROM pubs ORDER BY v')
    const members: SnapshotMember[] = rows.map((m) => ({
      id: m.id,
      name: m.name,
      muted: m.muted === 1,
      cameraOff: m.camera_off === 1,
      publishing: pubs.filter((p) => p.member_id === m.id).map((p) => ({ kind: p.kind, v: p.v })),
    }))
    const revision = this.sql.all<{ revision: number }>('SELECT revision FROM room WHERE id = 1')[0]?.revision ?? 0
    return { revision, count: rows.length, cap: ROOM_CAP, quality: qualityFor(rows.length), members }
  }
}

/**
 * A message as it is kept: line breaks normalised, control characters and the bidirectional overrides (which can
 * make text read backwards, a spoofing trick) removed, the ends trimmed. It stays text; the browser never treats it
 * as HTML. The length is checked on this, after cleaning.
 */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // the control characters themselves are what is being removed
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** A name as people see it: one line, trimmed, at most NAME_MAX characters. Empty becomes "Guest". */
export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : ''
  return s || 'Guest'
}

// ---------------------------------------------------------------------------
// Crossing the Durable Object boundary.
//
// Workers RPC does not carry an Error subclass's own fields across, so a
// RoomError's HTTP status would arrive as a bare Error and every refusal would
// look like a 500. Instead the DO exposes ONE method, `invoke`, which runs a
// RoomCore method and returns its value or its RoomError as data; the Worker's
// RoomClient turns that back into a thrown RoomError. Tests build the same
// RoomClient over an in-process RoomCore through the same `invokeCore`.

/** The RoomCore methods callable from the Worker. Anything else is refused. */
export const ROOM_METHODS = [
  'exists',
  'create',
  'info',
  'join',
  'setSessions',
  'sessions',
  'checkIn',
  'leave',
  'planPublish',
  'recordPublished',
  'planUnpublish',
  'recordUnpublished',
  'resolveSubscribe',
  'recordSubscribed',
  'planUnsubscribe',
  'recordUnsubscribed',
  'chat',
  'summary',
  'history',
  'deleteMessages',
  'recordCall',
  'indexed',
  'listCalls',
  'addUsage',
  'ackUsage',
  'takeOrphans',
  'closedOrphans',
  'addOrphans',
  'usageFor',
] as const satisfies ReadonlyArray<keyof RoomCore>
export type RoomMethod = (typeof ROOM_METHODS)[number]

export type InvokeResult = { ok: true; value: unknown } | { ok: false; status: RoomError['status']; message: string }

export function invokeCore(core: RoomCore, method: string, args: unknown[]): InvokeResult {
  if (!(ROOM_METHODS as readonly string[]).includes(method)) return { ok: false, status: 400, message: 'unknown method' }
  try {
    const fn = core[method as RoomMethod] as (...a: unknown[]) => unknown
    return { ok: true, value: fn.apply(core, args) }
  } catch (err) {
    if (err instanceof RoomError) return { ok: false, status: err.status, message: err.message }
    throw err
  }
}

export type RoomClient = {
  [K in RoomMethod]: (...args: Parameters<RoomCore[K]>) => Promise<ReturnType<RoomCore[K]>>
}

export function roomClient(invoke: (method: RoomMethod, args: unknown[]) => Promise<InvokeResult> | InvokeResult): RoomClient {
  const client = {} as Record<RoomMethod, (...args: unknown[]) => Promise<unknown>>
  for (const method of ROOM_METHODS) {
    client[method] = async (...args) => {
      const res = await invoke(method, args)
      if (!res.ok) throw new RoomError(res.status, res.message)
      return res.value
    }
  }
  return client as unknown as RoomClient
}
