// The schemas older commits created, frozen as they were, so a test can build a call's storage the way
// it was when it was started and open it with today's code. A call Tessa has already started must
// survive every later schema change: see `migrate()` in src/room.ts.

const TABLES_V1 = [
  `CREATE TABLE room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    pending_bytes REAL NOT NULL DEFAULT 0,
    flushed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE members (
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
  `CREATE TABLE pubs (
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    v INTEGER NOT NULL,
    track_name TEXT NOT NULL,
    mid TEXT NOT NULL,
    PRIMARY KEY (member_id, kind)
  )`,
  `CREATE TABLE subs (
    member_id TEXT NOT NULL,
    pub_member_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    v INTEGER NOT NULL,
    track_name TEXT NOT NULL,
    mid TEXT NOT NULL,
    PRIMARY KEY (member_id, pub_member_id, kind, v)
  )`,
  `CREATE TABLE usage (month TEXT PRIMARY KEY, bytes REAL NOT NULL)`,
]

/** The first commit. Never deployed, but its shape is the base the others add to. */
export const SCHEMA_V1 = TABLES_V1

/** The first deploy. Adds relay credentials to members and the orphans table. */
export const SCHEMA_V2 = [
  TABLES_V1[0] as string,
  (TABLES_V1[1] as string).replace('recv_session TEXT,', 'recv_session TEXT,\n    ice TEXT,\n    ice_expires INTEGER NOT NULL DEFAULT 0,'),
  ...TABLES_V1.slice(2),
  `CREATE TABLE orphans (session TEXT NOT NULL, mid TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)`,
]

/**
 * Today's deploy before chat (the tables as the last commit left them, with every column ADDITIONS had added):
 * the shape every call Tessa has already started has in production.
 */
export const SCHEMA_V3 = SCHEMA_V2.map((stmt) =>
  stmt
    .replace('flushed_at INTEGER NOT NULL\n  )', 'flushed_at INTEGER NOT NULL,\n    offered_bytes REAL NOT NULL DEFAULT 0,\n    offered_at INTEGER NOT NULL DEFAULT 0\n  )')
    .replace('tries INTEGER NOT NULL DEFAULT 0)', 'tries INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0)'),
)

/**
 * The phone's tables as calls out left them, with the `nonce` column its ADDITIONS had added: the shape a workspace has
 * that was started before calls in (docs/adr/0005). Frozen; never edit a statement here. With the workspace's WS_SCHEMA it is
 * what a Workspace object held in storage before calls in.
 */
export const PHONE_V1 = [
  `CREATE TABLE phone_profiles (
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
  `CREATE TABLE phone_tickets (
    hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    e164 TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE phone_calls (
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
    counted INTEGER NOT NULL DEFAULT 0,
    nonce TEXT
  )`,
  `CREATE INDEX phone_calls_email ON phone_calls (email, id)`,
  `CREATE TABLE phone_minutes (month TEXT PRIMARY KEY, minutes INTEGER NOT NULL)`,
  `CREATE TABLE phone_alerts (month TEXT NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (month, level))`,
  `CREATE TABLE phone_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE phone_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT)`,
  `CREATE TABLE phone_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE phone_hangups (leg TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
]
