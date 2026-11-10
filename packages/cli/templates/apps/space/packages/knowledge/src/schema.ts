/**
 * The knowledge app's schema, and the thing that applies it. A copy of the inbox's runner (packages/inbox/src/store/schema.ts), whose
 * reasons hold here unchanged:
 *
 * A Durable Object's SQLite has no `migrations_dir`, so the migrations are code, and the object's constructor applies whatever is
 * missing inside `blockConcurrencyWhile` before a request is served. `migrate` takes a `KnowledgeSql`, not a `DurableObjectState`,
 * and imports nothing from `cloudflare:workers`, so the real migrations run under `bun test` against a real SQLite.
 *
 * THE RULE FOR ADDING ONE: APPEND. Never edit a statement that has shipped, and never reorder: the applied version is the array's
 * length, so an insertion in the middle silently re-numbers everything after it. test/schema.test.ts pins the version.
 *
 * A store migrated by a NEWER build and read by an older one is refused, loudly (see `migrate`).
 */

export type KnowledgeMigration = string

/** Applied in order, once each, ever. `knowledge_meta` holds the count applied. */
export const KNOWLEDGE_MIGRATIONS: readonly KnowledgeMigration[] = [
  // 0 ── the whole knowledge base of an install.
  //
  // `knowledge_entry` is a title, a body, a `status` (`active` is what the assistants read, `proposed` is what Claude suggested and
  // the owner has not approved, `removed` is kept and read by nobody), who proposed it, and, for a proposed CHANGE, the entry it
  // would change (`replaces`) and the version of that entry the proposal was written against (`replaces_version`). A proposal
  // copies the entry's words and businesses as they stood then, so approving it once the entry has moved on would write the old copy
  // back over the owner's later edit: approve is refused as a conflict when the version has moved. It holds the entry as it is now.
  //
  // (Migration 0 carries `replaces_version` because it has not shipped; once the knowledge Worker is applied this migration is
  // never edited, and a later column is a migration 1.)
  //
  // `knowledge_entry_business` is the businesses the entry is for NOW: the declaration's business ids (no foreign key: the list is
  // the declaration's, a file, and an id that later leaves it must not make the entry unreadable). An assistant reads the active
  // entries joined here on its business.
  //
  // `knowledge_version` is append-only: every version of an entry, who wrote it and when, with its title, its body and its
  // businesses (a JSON list of ids) at that version. Never updated, never deleted. A change of businesses alone is a version,
  // because it decides which customers are told the entry.
  //
  // `audit` is who did what: the actor (a person's address, or `agent:` and a token's client id), the action, the subject, and a
  // JSON snapshot before and after. It never holds a secret. There is no source reference: nothing is carried or moved in.
  `
  CREATE TABLE "knowledge_entry" (
    "id" TEXT PRIMARY KEY,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('active', 'proposed', 'removed')),
    "proposed_by" TEXT,
    "replaces" TEXT REFERENCES "knowledge_entry" ("id"),
    "replaces_version" INTEGER,
    "created_at" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL
  );
  CREATE INDEX "knowledge_entry_status_idx" ON "knowledge_entry" ("status", "created_at");

  CREATE TABLE "knowledge_entry_business" (
    "entry_id" TEXT NOT NULL REFERENCES "knowledge_entry" ("id"),
    "business_id" TEXT NOT NULL,
    PRIMARY KEY ("entry_id", "business_id")
  );
  CREATE INDEX "knowledge_entry_business_idx" ON "knowledge_entry_business" ("business_id");

  CREATE TABLE "knowledge_version" (
    "seq" INTEGER PRIMARY KEY AUTOINCREMENT,
    "entry_id" TEXT NOT NULL REFERENCES "knowledge_entry" ("id"),
    "by" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "businesses" TEXT NOT NULL
  );
  CREATE INDEX "knowledge_version_entry_idx" ON "knowledge_version" ("entry_id", "seq");

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
export const KNOWLEDGE_VERSION = KNOWLEDGE_MIGRATIONS.length

/**
 * Enough of Cloudflare's `SqlStorage` for the store. Declared rather than imported so nothing here depends on the Workers types
 * being in scope. A SUBSET on purpose: widening it is a decision, not an accident.
 */
export type KnowledgeSql = {
  exec: (query: string, ...bindings: unknown[]) => SqlCursor
}

export type SqlCursor = {
  toArray: () => Record<string, unknown>[]
  one: () => Record<string, unknown>
  readonly rowsWritten: number
}

/**
 * Bring storage up to date, and answer with the version it is now at. Idempotent and cheap on the common path (an up-to-date object
 * reads one row and writes nothing): it runs on every construction of the object, which is every wake from hibernation.
 *
 * It throws on a version from the future. A store migrated by a NEWER deploy and then read by an older one is a rollback, and there
 * is nothing honest this function could do about it: it cannot un-apply a migration, and pretending the schema is what this build
 * expects is how a read silently returns the wrong columns. It shuts the object loudly rather than answering it wrongly.
 */
export function migrate(sql: KnowledgeSql): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS "knowledge_meta" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'version'),
    "applied" INTEGER NOT NULL
  )`)

  const row = sql.exec(`SELECT applied FROM knowledge_meta WHERE id = 'version'`).toArray()[0]
  const applied = row ? Number(row.applied) : 0

  if (applied > KNOWLEDGE_MIGRATIONS.length) {
    throw new Error(
      `Knowledge storage is at version ${applied}, but this build only knows ${KNOWLEDGE_MIGRATIONS.length}. ` +
        'This is an older deploy reading a store a newer one migrated; deploy forwards rather than back.',
    )
  }

  for (let version = applied; version < KNOWLEDGE_MIGRATIONS.length; version += 1) {
    sql.exec(KNOWLEDGE_MIGRATIONS[version] as string)
  }

  if (applied !== KNOWLEDGE_MIGRATIONS.length) {
    sql.exec(
      `INSERT INTO knowledge_meta (id, applied) VALUES ('version', ?1)
         ON CONFLICT(id) DO UPDATE SET applied = excluded.applied`,
      KNOWLEDGE_MIGRATIONS.length,
    )
  }

  return KNOWLEDGE_MIGRATIONS.length
}
