/**
 * The calendar's schema, and the thing that applies it. A copy of the knowledge app's runner (packages/knowledge/src/schema.ts), which is a copy of the inbox's, whose reasons hold here unchanged:
 *
 * A Durable Object's SQLite has no `migrations_dir`, so the migrations are code, and the object's constructor applies whatever is missing inside `blockConcurrencyWhile` before a request is served.
 * `migrate` takes a `CalendarSql`, not a `DurableObjectState`, and imports nothing from `cloudflare:workers`, so the real migrations run under `bun test` against a real SQLite.
 *
 * THE RULE FOR ADDING ONE: APPEND. Never edit a statement that has shipped, and never reorder: the applied version is the array's length, so an insertion in the middle silently re-numbers everything after it.
 * test/schema.test.ts pins the version. A store migrated by a NEWER build and read by an older one is refused, loudly (see `migrate`).
 *
 * THIS STORE IS A COPY OF GOOGLE'S. Everything in it can be read again from Google (a full sync per calendar), so the worst a lost or wrong store costs is a re-read; nothing here is the only copy of anything,
 * and no refresh token is in it (the grant is the inbox's: packages/space/docs/adr/0020).
 */

export type CalendarMigration = string

/** Applied in order, once each, ever. `calendar_meta` holds the count applied. */
export const CALENDAR_MIGRATIONS: readonly CalendarMigration[] = [
  // 0 ── the calendar of an install.
  //
  // `account` is a Google account the inbox holds a grant for, as the inbox last told us: the label mail calls it, a colour slot (`hue`: 0 to 5, given once, in the order the accounts were first seen, so an
  // account keeps its colour), and its `state` (`live`, `lapsed`, `needs-calendar`, `disconnected`; whether the first read is still owed is worked out from its calendars, not stored). `list_token` is Google's sync token
  // for the account's list of calendars; `list_dirty` says the list is owed a read (a push, a new account, a lost token).
  //
  // `calendar` is one calendar of an account. Its `id` is the account's address and Google's id joined by `|`. `shown` is whether its events are kept and drawn; `shown_set` is 1 once the owner has chosen, so a later
  // change in Google's list never overrides the choice. `sync_token` is Google's token for its events (null: the first full read is owed), `full_at` when the events were last read in full and `synced_at` when they
  // were last brought up to date at all, `window_from` and `window_to` the span the full read covered (the token keeps that span, so a rolling window is a new full read: a week at most). `dirty` says changes are owed
  // (a push arrived). `problem` is the last failure in a sentence, `retry_at` when to try again, `failures` how many in a row (the backoff). The `channel_*` columns are the same for the push channel on its own: a calendar whose
  // channel Google would not make still syncs (the safety resync reads it), and says so, and is tried again later.
  //
  // `event` is one event of one calendar as it stands (singleEvents: repeating events are already expanded by Google, so there is no repeat arithmetic here). `start_ms` and `end_ms` are what the agenda is cut on; an
  // all-day event also keeps its first day and its day after the last (`start_date`, `end_date`, as Google gives them), because the day must not move with the reader's zone. The text is untrusted and kept as text.
  //
  // `channel` is a Google push notification channel: one per shown calendar's events (`calendar_id` set) and one per account's list of calendars (`calendar_id` null). `token` is the secret Google sends back with
  // every notification, `resource_id` is what Google says the channel watches (both are checked), `expires_at` is when Google ends it (a channel is replaced before then), and `retire` marks one to be stopped at Google
  // and forgotten (its calendar was hidden). `push_at` is the last notification.
  `
  CREATE TABLE "account" (
    "address" TEXT PRIMARY KEY,
    "label" TEXT NOT NULL,
    "hue" INTEGER NOT NULL,
    "state" TEXT NOT NULL CHECK ("state" IN ('live', 'lapsed', 'needs-calendar', 'disconnected')),
    "list_token" TEXT,
    "list_synced_at" INTEGER,
    "list_dirty" INTEGER NOT NULL DEFAULT 1,
    "list_problem" TEXT,
    "list_retry_at" INTEGER,
    "list_failures" INTEGER NOT NULL DEFAULT 0,
    "channel_problem" TEXT,
    "channel_retry_at" INTEGER,
    "channel_failures" INTEGER NOT NULL DEFAULT 0,
    "checked_at" INTEGER,
    "first_seen_at" INTEGER NOT NULL
  );

  CREATE TABLE "calendar" (
    "id" TEXT PRIMARY KEY,
    "account" TEXT NOT NULL REFERENCES "account" ("address"),
    "google_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "is_primary" INTEGER NOT NULL DEFAULT 0,
    "owned" INTEGER NOT NULL DEFAULT 0,
    "shown" INTEGER NOT NULL,
    "shown_set" INTEGER NOT NULL DEFAULT 0,
    "sync_token" TEXT,
    "window_from" INTEGER,
    "window_to" INTEGER,
    "full_at" INTEGER,
    "synced_at" INTEGER,
    "dirty" INTEGER NOT NULL DEFAULT 0,
    "problem" TEXT,
    "retry_at" INTEGER,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "channel_problem" TEXT,
    "channel_retry_at" INTEGER,
    "channel_failures" INTEGER NOT NULL DEFAULT 0,
    UNIQUE ("account", "google_id")
  );
  CREATE INDEX "calendar_account_idx" ON "calendar" ("account");

  CREATE TABLE "event" (
    "calendar_id" TEXT NOT NULL REFERENCES "calendar" ("id"),
    "id" TEXT NOT NULL,
    "ical_uid" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "description" TEXT,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "all_day" INTEGER NOT NULL,
    "start_date" TEXT,
    "end_date" TEXT,
    "status" TEXT NOT NULL CHECK ("status" IN ('confirmed', 'tentative')),
    "response" TEXT,
    "organizer_name" TEXT,
    "organizer_email" TEXT,
    "guests" TEXT NOT NULL DEFAULT '[]',
    "guests_left" INTEGER NOT NULL DEFAULT 0,
    "video_link" TEXT,
    "html_link" TEXT,
    "free" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("calendar_id", "id")
  );
  CREATE INDEX "event_time_idx" ON "event" ("end_ms", "start_ms");
  CREATE INDEX "event_uid_idx" ON "event" ("ical_uid");

  CREATE TABLE "channel" (
    "id" TEXT PRIMARY KEY,
    "account" TEXT NOT NULL REFERENCES "account" ("address"),
    "calendar_id" TEXT REFERENCES "calendar" ("id"),
    "resource_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL,
    "push_at" INTEGER,
    "retire" INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX "channel_account_idx" ON "channel" ("account");
  CREATE INDEX "channel_calendar_idx" ON "channel" ("calendar_id");
  `,

  // 1 ── whether the account's grant also lets the calendar create and change events (Connect calendar asks for `calendar.events` beside `calendar.readonly`, so each account is connected once before booking).
  // As the inbox last told us, like `state`. Reading never needs it (an account without it is `live` all the same); Settings says editing needs Connect calendar again, and booking will check it.
  `
  ALTER TABLE "account" ADD COLUMN "events" INTEGER NOT NULL DEFAULT 0;
  `,
]

/** The version a fully migrated store reports. */
export const CALENDAR_VERSION = CALENDAR_MIGRATIONS.length

/**
 * Enough of Cloudflare's `SqlStorage` for the store. Declared rather than imported so nothing here depends on the Workers types being in scope. A SUBSET on purpose: widening it is a decision, not an accident.
 */
export type CalendarSql = {
  exec: (query: string, ...bindings: unknown[]) => SqlCursor
}

export type SqlCursor = {
  toArray: () => Record<string, unknown>[]
  one: () => Record<string, unknown>
  readonly rowsWritten: number
}

/**
 * Bring storage up to date, and answer with the version it is now at. Idempotent and cheap on the common path (an up-to-date object reads one row and writes nothing): it runs on every construction of the
 * object, which is every wake from hibernation. It throws on a version from the future: it cannot un-apply a migration, and pretending the schema is what this build expects is how a read silently returns the wrong
 * columns. It shuts the object loudly rather than answering it wrongly.
 */
export function migrate(sql: CalendarSql): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS "calendar_meta" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'version'),
    "applied" INTEGER NOT NULL
  )`)

  const row = sql.exec(`SELECT applied FROM calendar_meta WHERE id = 'version'`).toArray()[0]
  const applied = row ? Number(row.applied) : 0

  if (applied > CALENDAR_MIGRATIONS.length) {
    throw new Error(
      `Calendar storage is at version ${applied}, but this build only knows ${CALENDAR_MIGRATIONS.length}. ` +
        'This is an older deploy reading a store a newer one migrated; deploy forwards rather than back.',
    )
  }

  for (let version = applied; version < CALENDAR_MIGRATIONS.length; version += 1) {
    sql.exec(CALENDAR_MIGRATIONS[version] as string)
  }

  if (applied !== CALENDAR_MIGRATIONS.length) {
    sql.exec(
      `INSERT INTO calendar_meta (id, applied) VALUES ('version', ?1)
         ON CONFLICT(id) DO UPDATE SET applied = excluded.applied`,
      CALENDAR_MIGRATIONS.length,
    )
  }

  return CALENDAR_MIGRATIONS.length
}
