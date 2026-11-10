/**
 * The Clients part's schema, and the thing that applies it. A copy of the knowledge app's runner (packages/knowledge/src/schema.ts), which is a copy of the inbox's (packages/inbox/src/store/schema.ts), whose reasons hold here
 * unchanged:
 *
 * A Durable Object's SQLite has no `migrations_dir`, so the migrations are code, and the object's constructor applies whatever is missing inside `blockConcurrencyWhile` before a request is served. `migrate` takes a
 * `ClientsSql`, not a `DurableObjectState`, and imports nothing from `cloudflare:workers`, so the real migrations run under `bun test` against a real SQLite.
 *
 * THE RULE FOR ADDING ONE: APPEND. Never edit a statement that has shipped, and never reorder: the applied version is the array's length, so an insertion in the middle silently re-numbers everything after it.
 * test/schema.test.ts pins the version.
 *
 * A store migrated by a NEWER build and read by an older one is refused, loudly (see `migrate`).
 */

export type ClientsMigration = string

/** Applied in order, once each, ever. `clients_meta` holds the count applied. */
export const CLIENTS_MIGRATIONS: readonly ClientsMigration[] = [
  // 0 ── the whole list of Clients of an install.
  //
  // `client` is a Client: its number (the id every link and address names, a whole number from 1, the row id itself so no number is ever reused: nothing deletes a Client), its name and legal name, who made
  // it and when, who last changed its own fields and when, who archived it and when, and a `revision` that counts changes to its own fields (an edit names the one it was shown). Times are ISO text.
  //
  // `client_source` is the source's part of a Client that a source brought in, one row per such Client, and the Client's number is unique in it: the source's NAME and the source's id for the Client
  // (`external_id`, text: a source's ids are its own business) are the key a push finds the Client by. `said` is what the source last said of the name and legal name, as JSON, whole (the Client's own
  // are cut shorter): a Client's name follows the source's only while it still equals what the source last said, which is how an edit made in the space stands. `extra` is whatever else the source
  // says, as JSON, which the part shows and never reads. `gone_since` is when the source said the Client is gone; the Client is kept as it is.
  //
  // `client_source_state` is when a source was last heard from and when it last sent the full set. One row per source name.
  //
  // `audit` is who did what: the actor (a person's address, or `source:` and the source's name), the action, the subject, and a JSON snapshot before and after. It never holds a secret.
  `
  CREATE TABLE "client" (
    "number" INTEGER PRIMARY KEY CHECK ("number" >= 1),
    "name" TEXT NOT NULL CHECK (length("name") BETWEEN 1 AND 80),
    "legal_name" TEXT CHECK ("legal_name" IS NULL OR length("legal_name") BETWEEN 1 AND 120),
    "created_at" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "archived_at" TEXT,
    "archived_by" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE "client_source" (
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "client_number" INTEGER NOT NULL UNIQUE REFERENCES "client" ("number"),
    "url" TEXT,
    "said" TEXT NOT NULL,
    "extra" TEXT NOT NULL,
    "gone_since" TEXT,
    PRIMARY KEY ("source", "external_id")
  );

  CREATE TABLE "client_source_state" (
    "source" TEXT PRIMARY KEY,
    "last_push_at" TEXT,
    "last_sync_at" TEXT,
    "synced_count" INTEGER
  );

  CREATE TABLE "audit" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "at" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT
  );
  CREATE INDEX "audit_at_idx" ON "audit" ("at");
  `,
]

/** The version a fully migrated store reports. */
export const CLIENTS_VERSION = CLIENTS_MIGRATIONS.length

/**
 * Enough of Cloudflare's `SqlStorage` for the store. Declared rather than imported so nothing here depends on the Workers types being in scope. A SUBSET on purpose: widening it is a decision, not an accident.
 */
export type ClientsSql = {
  exec: (query: string, ...bindings: unknown[]) => SqlCursor
}

export type SqlCursor = {
  toArray: () => Record<string, unknown>[]
  one: () => Record<string, unknown>
  readonly rowsWritten: number
}

/**
 * Bring storage up to date, and answer with the version it is now at. Idempotent and cheap on the common path (an up-to-date object reads one row and writes nothing): it runs on every construction of the object,
 * which is every wake from hibernation.
 *
 * It throws on a version from the future. A store migrated by a NEWER deploy and then read by an older one is a rollback, and there is nothing honest this function could do about it: it cannot un-apply a migration,
 * and pretending the schema is what this build expects is how a read silently returns the wrong columns. It shuts the object loudly rather than answering it wrongly.
 */
export function migrate(sql: ClientsSql): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS "clients_meta" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'version'),
    "applied" INTEGER NOT NULL
  )`)

  const row = sql.exec(`SELECT applied FROM clients_meta WHERE id = 'version'`).toArray()[0]
  const applied = row ? Number(row.applied) : 0

  if (applied > CLIENTS_MIGRATIONS.length) {
    throw new Error(
      `Clients storage is at version ${applied}, but this build only knows ${CLIENTS_MIGRATIONS.length}. ` +
        'This is an older deploy reading a store a newer one migrated; deploy forwards rather than back.',
    )
  }

  for (let version = applied; version < CLIENTS_MIGRATIONS.length; version += 1) {
    sql.exec(CLIENTS_MIGRATIONS[version] as string)
  }

  if (applied !== CLIENTS_MIGRATIONS.length) {
    sql.exec(
      `INSERT INTO clients_meta (id, applied) VALUES ('version', ?1)
         ON CONFLICT(id) DO UPDATE SET applied = excluded.applied`,
      CLIENTS_MIGRATIONS.length,
    )
  }

  return CLIENTS_MIGRATIONS.length
}
