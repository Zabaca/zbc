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

  // 2 ── the busy blocks (the space's ADR 0024): a "Busy" event the calendar keeps on one of the owner's calendars for a meeting that makes them busy on another.
  //
  // `blocking` is the owner's setting, one row: `enabled` is the switch (off at first), `problem` is the last failure to write or remove blocks in a sentence, `retry_at` when to try again, `failures` how many runs in a row failed (the backoff).
  // `account.blocks` is whether an account takes part (it gives its busy times and receives blocks): every account does at first, and the owner may take one out.
  // `event.block` is set on an event that is one of the calendar's own blocks, as read back from Google (the private extended property the block was made with); it holds the meeting key the block stands for. A block is never drawn, never counted busy for
  // Claude and never the source of another block, so every read of `event` for a screen or for Claude leaves out `block IS NOT NULL`.
  `
  ALTER TABLE "account" ADD COLUMN "blocks" INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE "event" ADD COLUMN "block" TEXT;
  CREATE INDEX "event_block_idx" ON "event" ("block") WHERE "block" IS NOT NULL;
  CREATE TABLE "blocking" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'blocking'),
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "problem" TEXT,
    "retry_at" INTEGER,
    "failures" INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO "blocking" ("id") VALUES ('blocking');
  `,

  // 3 ── whose block it is: the install key in the mark (`spaceBlockBy`), so two spaces on one Google account neither remove nor make again each other's blocks. Null for a block marked before the mark named an install: it is read as this install's.
  `
  ALTER TABLE "event" ADD COLUMN "block_by" TEXT;
  `,

  // 4 ── booking links (the space's ADR 0025): a page where a visitor with no sign-in picks a free time and the calendar makes the event.
  //
  // `booking_link` is what the owner sets: the address's last part (`slug`, unique), the name and description a visitor reads, the account whose own calendar a booking is made on, the length, the hours of each weekday as JSON (`hours`, on the company's clock),
  // the least notice, how far ahead, the gap kept around other meetings, an optional most-per-day (`per_day`) and whether it is on. Deleting a link deletes this row alone; its bookings stay (they are events at Google).
  //
  // `booking` is the record of what a link did, one row for each time a visitor took. `link_id` names a link that may be gone, so it is not a foreign key, and `link_name` is the name it had. The calendar and the event it was made on are kept with it, since the link's
  // account may change later: `event_id` is DERIVED from the booking's own id (the same blocks' way, `bookingEventId`), so an insert whose outcome nobody knows is found again and never doubled. `state` is `held` (the time is taken in the store and Google has not said:
  // no other visitor can have it), `booked` (Google made the event) or `cancelled` (the visitor cancelled); "removed at Google" is not stored, it is read from the calendar's own copy. `moving_start`, `moving_end` and `moving_at` hold the time a move is
  // asking for while Google has not answered it. `manage_hash` is the SHA-256 of the booking's secret, which is shown to the visitor once and kept nowhere else; `network` is a keyed hash of the visitor's network address (never the address), and the two
  // counters of use, `visitor_email` and `network`, are what the limits count. `checked` says whether Google was asked at the moment of booking (`google`) or the calendar's own copy was used for an account Google could not be asked about (`copy`).
  //
  // `booking_meta` holds the one value kept for hashing: a random pepper made on first use, so a hash of a network address cannot be worked back by trying every address.
  `
  CREATE TABLE "booking_link" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "account" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "hours" TEXT NOT NULL,
    "notice_minutes" INTEGER NOT NULL,
    "ahead_days" INTEGER NOT NULL,
    "gap_minutes" INTEGER NOT NULL,
    "per_day" INTEGER,
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "created_at" INTEGER NOT NULL,
    "changed_at" INTEGER NOT NULL
  );

  CREATE TABLE "booking" (
    "id" TEXT PRIMARY KEY,
    "link_id" TEXT NOT NULL,
    "link_name" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "calendar_id" TEXT NOT NULL,
    "calendar_google_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "moving_start" INTEGER,
    "moving_end" INTEGER,
    "moving_at" INTEGER,
    "visitor_name" TEXT NOT NULL,
    "visitor_email" TEXT NOT NULL,
    "note" TEXT,
    "manage_hash" TEXT NOT NULL UNIQUE,
    "state" TEXT NOT NULL CHECK ("state" IN ('held', 'booked', 'cancelled')),
    "checked" TEXT NOT NULL DEFAULT 'copy' CHECK ("checked" IN ('google', 'copy')),
    "moves" INTEGER NOT NULL DEFAULT 0,
    "network" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "booked_at" INTEGER,
    "cancelled_at" INTEGER
  );
  CREATE INDEX "booking_link_idx" ON "booking" ("link_id", "start_ms");
  CREATE INDEX "booking_time_idx" ON "booking" ("state", "start_ms");
  CREATE INDEX "booking_visitor_idx" ON "booking" ("visitor_email", "created_at");
  CREATE INDEX "booking_network_idx" ON "booking" ("network", "created_at");

  CREATE TABLE "booking_meta" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'booking'),
    "pepper" TEXT NOT NULL
  );
  `,

  // 5 ── what the per-address limits count (the space's ADR 0025): `visitor_key` is the visitor's address in its canonical form (lower case, no `+tag`, no dots for Gmail's own domains), so one inbox written several ways is one key; `visitor_email`
  // stays the address as typed, which is the one invited. A row made before this one is keyed by its address as typed.
  `
  ALTER TABLE "booking" ADD COLUMN "visitor_key" TEXT NOT NULL DEFAULT '';
  UPDATE "booking" SET "visitor_key" = "visitor_email";
  CREATE INDEX "booking_visitor_key_idx" ON "booking" ("visitor_key", "created_at");
  `,

  // 6 ── where a link's meetings are held (the space's ADR 0026): `where_kind` is `meet` (Google Meet, every link made before) or `space` (a call in the space's own Meet). A booking keeps what it was booked with (`booking.where_kind`), and, for a call in
  // the space, the call's name and address (`call_name`, `call_link`: the call is made for the booking and is the event's place) the start its window was last set for (`call_start`: a move that did not reach the call is found by it and tried again), and whether it has been closed since the booking was cancelled (`call_closed`; a close that did not go through is tried again).
  `
  ALTER TABLE "booking_link" ADD COLUMN "where_kind" TEXT NOT NULL DEFAULT 'meet';
  ALTER TABLE "booking" ADD COLUMN "where_kind" TEXT NOT NULL DEFAULT 'meet';
  ALTER TABLE "booking" ADD COLUMN "call_name" TEXT;
  ALTER TABLE "booking" ADD COLUMN "call_link" TEXT;
  ALTER TABLE "booking" ADD COLUMN "call_start" INTEGER;
  ALTER TABLE "booking" ADD COLUMN "call_closed" INTEGER NOT NULL DEFAULT 0;
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
