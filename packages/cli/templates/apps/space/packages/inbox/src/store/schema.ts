/**
 * The inbox's schema, and the thing that applies it.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
 * A Durable Object's SQLite has no `migrations_dir`. Nothing runs a `.sql` file
 * against it and `wrangler d1 migrations apply` cannot see it, so the equivalent
 * is code, and it runs itself: the object's constructor applies whatever is
 * missing inside `blockConcurrencyWhile`, before a single request is served.
 * There is no forgetting a migration; the storage and the schema are one deploy.
 * It is a small runner of the shape any Durable Object store needs.
 *
 * ── WHY IT TAKES A PORT ──────────────────────────────────────────────────
 * `migrate` takes an `InboxSql`, not a `DurableObjectState`, and this module
 * imports nothing from `cloudflare:workers`, so the real migrations run under
 * `bun test` against a real SQLite (test-support/sql-over-sqlite.ts).
 *
 * ── THE RULE FOR ADDING ONE ──────────────────────────────────────────────
 * APPEND. Never edit a statement that has shipped, and never reorder: the applied
 * version is the array's length, so an insertion in the middle silently
 * re-numbers everything after it and a deployed object skips a migration it has
 * not run. test/schema.test.ts pins the version.
 *
 * ── WHAT EACH MIGRATION HOLDS, AND WHY A LATER ONE CAN ADD MORE ──────────
 * Migration 0 had no Gmail. Migration 2 (connecting Gmail, the fill, push, the daily job)
 * added `mailbox`, `conversation.mailbox_id` and the thread id,
 * and the Gmail columns on `message`. Migration 3 (read and closed kept in step with
 * Gmail) added the read and closed stamps on `message`. Migration 4
 * (sending by the owner) added a draft's revision and a message's
 * Reply-To. Migration 5 (Clients) added the Client assignment on
 * `contact`. Migration 6 (Claude sends on the owner's instruction) added the
 * `setting` table for Claude's sending switch and the instruction recorded on a send.
 * Notifications added
 * migration 7: the `device` table and a message's notification marks. A business mailbox fed by Cloudflare
 * added migration 8: the mailbox
 * table made again to allow a second kind, and what a message from Cloudflare needs. The assistant
 * added migration 9: whether it runs, who set a sort, the work it owes, what each call
 * cost, and the knowledge base's shape. The draft chat and the knowledge base's page added migration 10: the
 * chat's turns and a proposed change's target. The spam check added migration 11: what the spam classifier said
 * of a message. Several Gmail accounts added migration 14: when a grant lapsed, and the label of the account that already exists. The Telegram bridge
 * added migration 16: the mailbox table made again for a third kind, and what a Telegram chat, person and message need. Its groups and channels added migration 17: a chat's kind, a supergroup's or channel's own position, the identity that stands for a group, and whether a group message is addressed to the owner. A mailbox on the install's own mail server added migration 18: the mailbox table made again for a fourth kind (read and written over JMAP) and the server's own message and thread ids. Mailbox people added migration 19: the people of every mailbox. The calendar summary added migration 20: what an email's calendar part says, on the message.
 * There is NO approval column anywhere: Claude's send is
 * authorised by the owner's instruction, recorded with each send, in place of an approval step.
 * `message.status` already names every status that is used, because SQLite
 * cannot alter a CHECK and a rebuild of the largest table is not a migration to
 * write twice.
 */

export type InboxMigration = string

/**
 * Applied in order, once each, ever. `inbox_meta` holds the count applied. Each
 * entry may hold several statements; a Durable Object's SQLite runs them in one
 * implicit transaction per `exec`, so a half-applied migration is not reachable.
 */
export const INBOX_MIGRATIONS: readonly InboxMigration[] = [
  // 0 ── people, their addresses, conversations, messages, and the audit log.
  //
  // ── A CONTACT IS A PERSON AND AN IDENTITY IS ONE WAY TO REACH THEM ─────
  // Two addresses and a phone number are one contact with three identities.
  // `identity` is unique per (kind, address) and belongs to exactly one contact,
  // so merging two contacts later moves identities and nothing else, which is
  // what makes a merge undoable. A contact has NO Client column yet: grouping by
  // Client arrives with migration 5, and it reads the Clients part's list rather than keeping one.
  //
  // ── A CONVERSATION KNOWS ITS PEOPLE ONLY THROUGH `participant` ─────────
  // Not through a `contact_id` on the conversation. After a merge the
  // conversations follow the identities with no rewrite, and a thread with three
  // people is the same shape as a text with one.
  //
  // ── `message.identity_id` IS WHO IT IS TO (OR FROM) ────────────────────
  // `conversation_id` is NULL for a draft that has not been filed: a new email
  // to a contact has no thread until it is sent. Marking a draft sent files it on
  // the contact's manual conversation for that channel.
  //
  // `source_ref` is unique and is how the Outbox carry is idempotent: a second
  // run finds `outbox:<id>` and does nothing to it.
  //
  // ⚠️ `created_by`, `updated_by` and `sent_by` come ONLY from the verified
  // Access identity, never from a request body. A person is their address and
  // an agent is `agent:` and its token's client id, so the column answers which
  // kind made a change without a second column to be wrong about.
  `
  CREATE TABLE "contact" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "created_by" TEXT NOT NULL
  );

  CREATE TABLE "identity" (
    "id" TEXT PRIMARY KEY,
    "contact_id" TEXT NOT NULL REFERENCES "contact" ("id"),
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    UNIQUE ("kind", "address")
  );
  CREATE INDEX "identity_contact_idx" ON "identity" ("contact_id");

  CREATE TABLE "conversation" (
    "id" TEXT PRIMARY KEY,
    "created_at" TEXT NOT NULL,
    "last_activity_at" TEXT NOT NULL
  );
  CREATE INDEX "conversation_activity_idx" ON "conversation" ("last_activity_at");

  CREATE TABLE "participant" (
    "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id"),
    "identity_id" TEXT NOT NULL REFERENCES "identity" ("id"),
    "role" TEXT NOT NULL CHECK ("role" IN ('from', 'to', 'cc')),
    PRIMARY KEY ("conversation_id", "identity_id")
  );
  CREATE INDEX "participant_identity_idx" ON "participant" ("identity_id");

  CREATE TABLE "message" (
    "id" TEXT PRIMARY KEY,
    "conversation_id" TEXT REFERENCES "conversation" ("id"),
    "identity_id" TEXT NOT NULL REFERENCES "identity" ("id"),
    "direction" TEXT NOT NULL CHECK ("direction" IN ('in', 'out')),
    "status" TEXT NOT NULL CHECK ("status" IN ('draft', 'sending', 'sent', 'manual-sent', 'failed')),
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "why" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "sent_at" TEXT,
    "sent_by" TEXT,
    "source_ref" TEXT UNIQUE
  );
  CREATE INDEX "message_conversation_idx" ON "message" ("conversation_id");
  CREATE INDEX "message_identity_idx" ON "message" ("identity_id");
  CREATE INDEX "message_status_idx" ON "message" ("status", "created_at");

  -- Append-only in effect: nothing in the store updates or deletes a row.
  -- "before" and "after" are JSON snapshots, and must never hold a secret (the
  -- Gmail refresh token arrives with step 2 and is kept out of here by design).
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

  // 1 ── what the owner deleted from the carry.
  //
  // The Outbox carry is re-run until the Outbox is retired, and finds an entry
  // again by `message.source_ref`. A deleted draft has no row left to find, so
  // without this the next run would create it again. One row per deleted carried
  // draft, keyed by the same `outbox:<id>`; the carry skips what is listed here.
  // Never read for anything else, and never deleted from.
  `
  CREATE TABLE "outbox_tombstone" (
    "source_ref" TEXT PRIMARY KEY,
    "deleted_at" TEXT NOT NULL,
    "deleted_by" TEXT NOT NULL
  );
  `,

  // 2 ── Gmail: one mailbox, and the columns a received message needs.
  //
  // ── THE MAILBOX IS ONE ROW AND THE ONLY HOME OF THE TOKEN ──────────────
  // `refresh_token` is the key that can read, send and relabel the owner's mail. It
  // lives here and nowhere else: no route returns it (the status shape has no
  // field for it), and the audit log never records it (the connect and
  // disconnect entries carry the address and the granted scopes only). It is NULL
  // after a disconnect, which is also how "connected" is decided. NOT encrypted
  // at the application level, on purpose: the only place a key for that could
  // live is the install's secrets file, which whoever can deploy code that reads
  // this store can already decrypt.
  //
  // `history_id` is the CURSOR, Gmail's own position in the mailbox's change
  // history, and it is the truth: a push is only a hint that it moved. It is NULL
  // until the first fill completes, which is how a mailbox with no cursor is told
  // from one that has caught up.
  //
  // `job` is the resumable work a Worker invocation cannot finish in one go (the
  // first fill, and a resync after the cursor went stale), as JSON: its query, its
  // page token and what is left to do. It exists because a subrequest budget is a
  // hard limit, so a thirty-day fill is many short runs and not one long one.
  //
  // `push_seq` and `synced_seq` are how "changes are pending" survives a push
  // that arrives DURING a sync: a push bumps the first, a sync that starts at
  // seq N and completes records N in the second, and anything higher is still
  // owed. A single flag would be cleared by the sync that had not seen the push.
  //
  // `push_suspect_at` is set by the daily pass when it found new mail although no
  // push had arrived for a day, which means pushes are broken. A later push
  // clears it by being newer.
  //
  // ── A CONVERSATION'S MAILBOX IS WHAT MAKES IT A GMAIL ONE ──────────────
  // `conversation.mailbox_id` is NULL for a manual conversation (a text, a DM,
  // the carried Outbox entries). A Gmail thread is unique per mailbox, and a
  // manual conversation must never be found as a Gmail thread or the reverse, so
  // everything that looks up a manual conversation filters on NULL.
  //
  // ── WHAT A RECEIVED MESSAGE ADDS ───────────────────────────────────────
  // `gmail_id` is unique per mailbox, which is what makes every ingest an upsert
  // and a duplicate push store one message. `labels` is Gmail's label ids as JSON:
  // the envelope facts (category tab, whether it is unread, whether it is in the
  // Inbox) are all in it, and read and closed state are DERIVED from it (migration 3),
  // so nothing about them is stored twice. `from_header`, `to_header` and
  // `cc_header` are what the sender wrote, decoded for reading; the people are
  // in `participant` and `identity`, which is what queries use.
  `
  CREATE TABLE "mailbox" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('gmail')),
    "address" TEXT NOT NULL,
    "refresh_token" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '',
    "history_id" TEXT,
    "watch_expiry" TEXT,
    "connected_at" TEXT NOT NULL,
    "connected_by" TEXT NOT NULL,
    "last_push_at" TEXT,
    "last_sync_at" TEXT,
    "last_error" TEXT,
    "last_error_at" TEXT,
    "last_resync_at" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "push_seq" INTEGER NOT NULL DEFAULT 0,
    "synced_seq" INTEGER NOT NULL DEFAULT 0,
    "push_suspect_at" TEXT,
    "job" TEXT,
    UNIQUE ("kind", "address")
  );

  ALTER TABLE "conversation" ADD COLUMN "mailbox_id" TEXT REFERENCES "mailbox" ("id");
  ALTER TABLE "conversation" ADD COLUMN "gmail_thread_id" TEXT;
  CREATE UNIQUE INDEX "conversation_thread_idx" ON "conversation" ("mailbox_id", "gmail_thread_id")
    WHERE "gmail_thread_id" IS NOT NULL;

  ALTER TABLE "message" ADD COLUMN "mailbox_id" TEXT REFERENCES "mailbox" ("id");
  ALTER TABLE "message" ADD COLUMN "gmail_id" TEXT;
  ALTER TABLE "message" ADD COLUMN "rfc_message_id" TEXT;
  ALTER TABLE "message" ADD COLUMN "in_reply_to" TEXT;
  ALTER TABLE "message" ADD COLUMN "from_header" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "message" ADD COLUMN "to_header" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "message" ADD COLUMN "cc_header" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "message" ADD COLUMN "sender_date" TEXT;
  ALTER TABLE "message" ADD COLUMN "snippet" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "message" ADD COLUMN "body_truncated" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "message" ADD COLUMN "attachments" TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE "message" ADD COLUMN "labels" TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE "message" ADD COLUMN "list_unsubscribe" INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX "message_gmail_idx" ON "message" ("mailbox_id", "gmail_id")
    WHERE "gmail_id" IS NOT NULL;
  `,

  // 3 ── read and closed: who, and when.
  //
  // ── THESE ARE STAMPS, NOT THE STATE, FOR AN EMAIL CONVERSATION ─────────
  // Gmail's labels are the truth there: a conversation is unread while any message
  // carries UNREAD and open while any carries INBOX, derived on every read from
  // `message.labels`. These columns only say WHO made the last change and WHEN, so
  // the page can say "read by Tessa" or "archived in Gmail". Every place that
  // writes a message's labels keeps the stamps true to them: a message with UNREAD
  // has no read stamp, one without has one; the same for INBOX and closed. They
  // are written across the whole conversation,
  // so there is no message-level state that disagrees with the conversation's.
  //
  // ── FOR A MANUAL CONVERSATION THEY ARE THE WHOLE STATE ──────────────────
  // A text or a DM has no Gmail side, so its read and closed state is these
  // columns alone: unread while a non-draft message has no read stamp, open while
  // one has no closed stamp. Everything on such a conversation is something the owner
  // sent and marked sent by hand, so nothing is owed on it: it is filed read and
  // closed, which is Gmail's rule for a sent-only conversation too. Reopening it,
  // or closing it again, is the inbox's alone.
  //
  // NULL means unread, or open. A draft carries neither stamp and never counts.
  //
  // ── THE BACKFILL ────────────────────────────────────────────────────────
  // A message already held is stamped as Gmail has it, by `gmail`, at the time the
  // inbox stored it (that is when the inbox learned it, and Gmail's own time for
  // the change is not known); a message marked sent by hand is stamped read and
  // closed by whoever marked it, at the time it was sent (or filed, when no time
  // was recorded). Without this, every held message would read as unread and open
  // on the first deploy.
  `
  ALTER TABLE "message" ADD COLUMN "read_at" TEXT;
  ALTER TABLE "message" ADD COLUMN "read_by" TEXT;
  ALTER TABLE "message" ADD COLUMN "closed_at" TEXT;
  ALTER TABLE "message" ADD COLUMN "closed_by" TEXT;

  UPDATE "message" SET
    "read_at" = CASE WHEN EXISTS (SELECT 1 FROM json_each("message"."labels") WHERE "value" = 'UNREAD')
                     THEN NULL ELSE "created_at" END,
    "read_by" = CASE WHEN EXISTS (SELECT 1 FROM json_each("message"."labels") WHERE "value" = 'UNREAD')
                     THEN NULL ELSE 'gmail' END,
    "closed_at" = CASE WHEN EXISTS (SELECT 1 FROM json_each("message"."labels") WHERE "value" = 'INBOX')
                       THEN NULL ELSE "created_at" END,
    "closed_by" = CASE WHEN EXISTS (SELECT 1 FROM json_each("message"."labels") WHERE "value" = 'INBOX')
                       THEN NULL ELSE 'gmail' END
  WHERE "gmail_id" IS NOT NULL;

  UPDATE "message" SET
    "read_at" = coalesce("sent_at", "created_at"),
    "read_by" = coalesce("sent_by", "created_by"),
    "closed_at" = coalesce("sent_at", "created_at"),
    "closed_by" = coalesce("sent_by", "created_by")
  WHERE "gmail_id" IS NULL AND "status" != 'draft';
  `,

  // 4 ── sending: what a draft is held to, and where a reply goes.
  //
  // ── `rev` IS HOW A SEND NAMES WHAT IT WAS SHOWN ────────────────────────
  // Every edit of a draft adds one. A send carries the revision its author saw, and
  // the claim that moves the draft to `sending` is conditional on it, so a draft
  // edited between the screen and the press (by the other of the owner and Claude, or
  // from another tab) is refused with a 409 and shown again, never sent with words
  // nobody read. Nothing but a draft is ever edited, so it is 0 on every other row.
  // It is a counter and not a hash because the store is synchronous SQL and a counter
  // cannot collide.
  //
  // ── `reply_to_header` IS NULL UNTIL IT IS KNOWN ────────────────────────
  // A reply goes to the newest inbound message's Reply-To, else its From, and
  // nothing recorded it before this migration. NULL is "not recorded" (every message
  // stored before this migration), '' is "has none", and anything else is the header
  // as written, decoded. A message stored before is read back from Gmail the first
  // time a reply is drafted on its conversation (Mailroom.createDraft), because the
  // difference between the From and the Reply-To of a form-handling service is the
  // difference between answering the customer and answering the machine.
  `
  ALTER TABLE "message" ADD COLUMN "rev" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "message" ADD COLUMN "reply_to_header" TEXT;
  `,

  // 5 ── a contact's Client.
  //
  // ── AN ID, WITH NOTHING TO HOLD IT TO ───────────────────────────────────
  // `client_id` is the id of a Client in the Clients part's store, which owns Clients
  // and is the only place that can say one exists. There is no foreign key and
  // there cannot be: the two live in different stores. What stands in for one is
  // the Client directory (src/clients.ts), which the Worker asks before it writes
  // an assignment, so an id the part does not list is refused and nothing here
  // points at a Client that was never there. Nothing deletes a Client today, so a
  // dangling id needs a deletion that does not exist yet; if one is ever built,
  // that is where it has to answer for these.
  //
  // It is NULL for most contacts and stays NULL unless somebody sets it: the owner
  // or the agent, by an explicit assignment, which is audited with its actor. Nothing
  // sets it by matching an address; a suggestion is computed and shown, and takes
  // effect only when it is accepted, which is an assignment like any other (nothing
  // here attaches anything to a Client by matching on an address). A contact belongs
  // to at most one Client, because nothing asked for people shared across Clients.
  //
  // `client_set_by` and `client_set_at` say who assigned it and when, and are
  // NULL exactly when `client_id` is. A merge that hands the survivor the other
  // contact's Client carries these across with it.
  `
  ALTER TABLE "contact" ADD COLUMN "client_id" INTEGER;
  ALTER TABLE "contact" ADD COLUMN "client_set_by" TEXT;
  ALTER TABLE "contact" ADD COLUMN "client_set_at" TEXT;
  CREATE INDEX "contact_client_idx" ON "contact" ("client_id") WHERE "client_id" IS NOT NULL;
  `,

  // 6 ── Claude's sending: the switch and the instruction a send carries.
  //
  // ── `setting` IS A KEY AND A VALUE, AND ABSENT MEANS OFF ────────────────
  // The one setting is `claude_sending`, 'on' or 'off'. No row is "off": a store that
  // has never been touched, and one restored from a copy that predates this, both leave
  // Claude unable to send, so turning it on is always something the owner did and the audit
  // says when. `updated_by` is the address that flipped it, which only the owner can.
  //
  // ── THE INSTRUCTION IS THREE COLUMNS ON THE MESSAGE ─────────────────────
  // A Claude send is the draft itself moving through claimed to sent, so the draft it
  // came from and the message that went out are one row, and the instruction lives on
  // it: what the owner said (`instruction_text`), where (`instruction_where`) and when
  // (`instruction_at`, as Claude states it). The three are NULL together, and they are
  // written at the CLAIM, before Gmail is asked, so a send whose outcome is never known
  // still carries the words it went out on. They are cleared again when the claim is
  // released or the owner says it did not go out, because an instruction covers one attempt
  // and not the draft for ever. (The audit keeps every one.) Nothing is added to
  // `message.status`: SQLite cannot alter its CHECK, and it already names every status.
  `
  CREATE TABLE "setting" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL
  );

  ALTER TABLE "message" ADD COLUMN "instruction_text" TEXT;
  ALTER TABLE "message" ADD COLUMN "instruction_where" TEXT;
  ALTER TABLE "message" ADD COLUMN "instruction_at" TEXT;
  `,

  // 7 ── notifications: the owner's devices, and whether a message owes one.
  //
  // ── A DEVICE IS ONE BROWSER WHERE THE OWNER TURNED NOTIFICATIONS ON ─────────
  // `endpoint` is the address the browser's push service gave it, and is unique, so
  // turning notifications on again in the same browser updates its row instead of
  // adding a second. `p256dh` and `auth` are the browser's two keys, which every
  // notification is encrypted to; no route returns them and the audit never records
  // them (nor the address). `label` is read from the browser that turned it on. The
  // last delivery and the last failure are stamps, so Settings can say which device
  // has stopped; a device the push service says is gone is deleted, and the audit
  // says it went. `last_outcome` is how the last failure was read (refused, failed,
  // too-large), so Settings offers "turn notifications on again" only for a refusal.
  // `delivered` and `failed` count every answer, for the first
  // week's comparison the runbook asks for.
  //
  // ── TWO MARKS ON A MESSAGE, NOT A TABLE ─────────────────────────────────
  // `notify` is NULL (never owed: every message stored before this, and everything
  // the rule turned down or never asked about), 'owed' (the rule said yes when the
  // sync stored it), then 'sent' or 'dropped' (owed past the hour, or with nowhere to
  // send it). `notified_at` is when it stopped being owed. The message is already the
  // unit stored once, so these are all the record one email, one notification needs.
  // Nothing stored before this deploy reads as owed, so the deploy notifies about
  // nothing old.
  `
  CREATE TABLE "device" (
    "id" TEXT PRIMARY KEY,
    "endpoint" TEXT NOT NULL UNIQUE,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "added_at" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "last_delivered_at" TEXT,
    "last_failed_at" TEXT,
    "last_failure" TEXT,
    "last_outcome" TEXT,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0
  );

  ALTER TABLE "message" ADD COLUMN "notify" TEXT CHECK ("notify" IN ('owed', 'sent', 'dropped'));
  ALTER TABLE "message" ADD COLUMN "notified_at" TEXT;
  CREATE INDEX "message_notify_idx" ON "message" ("notify") WHERE "notify" = 'owed';
  `,

  // 8 ── a second kind of mailbox, fed by Cloudflare.
  //
  // ── THE MAILBOX TABLE IS REBUILT, BECAUSE SQLITE CANNOT ALTER A CHECK ───
  // Migration 2 wrote `kind IN ('gmail')`. A second kind needs the table made again, and `conversation.mailbox_id`,
  // `message.mailbox_id` (and `arrival_owed`, below) reference it. How it is done, and why in this order, because the
  // textbook order fails here (found by running it with the checks enforced, which is how a Durable Object's SQLite runs):
  //   - `PRAGMA foreign_keys = OFF` does nothing: the whole `exec` is one transaction and SQLite ignores that pragma
  //     inside one. `PRAGMA defer_foreign_keys = ON` is what holds: the checks wait for the commit (and the pragma switches
  //     itself off there).
  //   - The textbook rebuild (create a new table, copy into it, drop the old one, rename the new) FAILS at the commit with
  //     "FOREIGN KEY constraint failed": dropping the old table counts a violation for every row that pointed at it, and only
  //     a row inserted into a table NAMED `mailbox` takes one off again, which the copy into the differently named new table
  //     never does. So the rows are copied aside first, the old table dropped, the new one created under its own name, and the
  //     rows put back into it; each insert settles the references to that row, and nothing is left at the commit. The ids are
  //     copied as they were.
  //   - Dropping a parent also deletes its rows first, and a foreign key with an ON DELETE action would act on that. Neither
  //     reference has one (the default is no action), so no child row is touched. test/schema.test.ts runs this over a store
  //     holding a Gmail mailbox, a conversation and a message that point at it, with the checks enforced, and finds them all.
  // The existing Gmail row is copied column for column, token and cursor included, and gets the defaults of the two new columns.
  // Nothing else about it changes.
  //
  // ── WHAT A CLOUDFLARE MAILBOX USES OF THE ROW ───────────────────────────
  // `display_name` is the mark on its conversations (the business's name); `last_arrival_at` is when mail last arrived
  // for it. The existing `last_error` and `last_error_at` are its last FILING error (a message kept in the bucket that the
  // inbox could not file), and `connected_at` and `connected_by` are when mail first arrived and the actor then, as
  // for Gmail. It never has a token, a cursor or a job. Cloudflare mailboxes are declared in the deploy config and the
  // row is made the first time mail arrives for one; nothing adds one from the page.
  //
  // ── WHAT A CLOUDFLARE CONVERSATION AND MESSAGE ADD ──────────────────────
  // `conversation.subject_key` is the subject as threading compares it (Re: and Fwd: stripped, lower case), kept so
  // rule 2 of threading is one indexed read and not a scan. `conversation.sort` is the assistant's sort, NULL until
  // something sorts it; a later migration's code writes it, and the queue already reads it (Bulk for a Cloudflare mailbox is the
  // sort: spam, promotional or newsletter).
  //
  // `message.arrival_key` is what makes a delivery that happens twice store one message: the Message-ID
  // as written (with its brackets), or `hash:` and the SHA-256 of the raw bytes for a message that has none. Unique per
  // mailbox. It is NOT `rfc_message_id`, which Gmail mail also fills and where one Message-ID can be on two Gmail
  // messages (a note to oneself), so a unique index there would refuse real mail. `message.raw_key` is the object in
  // the raw-mail bucket holding the message as it came, for the script and for a later look; NULL on everything else.
  //
  // ── `arrival_owed` IS WHAT THE ALARM FILES ──────────────────────────────
  // The entrance writes the raw copy to the bucket FIRST and then asks the store to file it. When filing fails
  // (the parser threw, the write failed) one row here says which raw copy is owed, with the envelope and the arrival
  // time the Worker saw, and the Durable Object's alarm files it later with a backoff, from the kept copy. Deleted in the
  // same transaction as the filing it was for. A sender is never asked to send twice because the inbox hiccuped.
  // A copy that still cannot be filed after a bounded number of attempts is GIVEN UP ON (`gave_up_at`): the row stays, so
  // the mailbox keeps saying it holds unfiled mail, and the raw copy is kept, but nothing retries it. A mailbox's
  // `last_error` is cleared when no row is left for it.
  `
  PRAGMA defer_foreign_keys = ON;

  CREATE TABLE "mailbox_copy" AS SELECT * FROM "mailbox";
  DROP TABLE "mailbox";

  CREATE TABLE "mailbox" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('gmail', 'cloudflare')),
    "address" TEXT NOT NULL,
    "refresh_token" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '',
    "history_id" TEXT,
    "watch_expiry" TEXT,
    "connected_at" TEXT NOT NULL,
    "connected_by" TEXT NOT NULL,
    "last_push_at" TEXT,
    "last_sync_at" TEXT,
    "last_error" TEXT,
    "last_error_at" TEXT,
    "last_resync_at" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "push_seq" INTEGER NOT NULL DEFAULT 0,
    "synced_seq" INTEGER NOT NULL DEFAULT 0,
    "push_suspect_at" TEXT,
    "job" TEXT,
    "display_name" TEXT NOT NULL DEFAULT '',
    "last_arrival_at" TEXT,
    UNIQUE ("kind", "address")
  );

  INSERT INTO "mailbox" ("id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job")
  SELECT "id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job"
  FROM "mailbox_copy";

  DROP TABLE "mailbox_copy";

  ALTER TABLE "conversation" ADD COLUMN "subject_key" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "sort" TEXT CHECK ("sort" IN ('customer', 'spam', 'promotional', 'newsletter'));
  CREATE INDEX "conversation_subject_idx" ON "conversation" ("mailbox_id", "subject_key") WHERE "subject_key" IS NOT NULL;

  ALTER TABLE "message" ADD COLUMN "arrival_key" TEXT;
  ALTER TABLE "message" ADD COLUMN "raw_key" TEXT;
  CREATE UNIQUE INDEX "message_arrival_idx" ON "message" ("mailbox_id", "arrival_key") WHERE "arrival_key" IS NOT NULL;
  CREATE INDEX "message_rfc_idx" ON "message" ("mailbox_id", "rfc_message_id") WHERE "rfc_message_id" IS NOT NULL;

  CREATE TABLE "arrival_owed" (
    "raw_key" TEXT PRIMARY KEY,
    "mailbox_id" TEXT NOT NULL REFERENCES "mailbox" ("id"),
    "envelope_from" TEXT NOT NULL,
    "envelope_to" TEXT NOT NULL,
    "received_at" TEXT NOT NULL,
    "owed_at" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TEXT NOT NULL,
    "last_error" TEXT,
    "gave_up_at" TEXT
  );
  `,

  // 9 ── the assistant on a Cloudflare mailbox.
  //
  // ── WHETHER IT RUNS IS ON THE MAILBOX ROW ───────────────────────────────
  // `mailbox.assistant` is 1 when the assistant runs on that mailbox. It starts as the deploy config declares
  // (`assistant: true` on the declared mailbox, src/cloudflare/declared.ts) and follows the declaration for as long as
  // `assistant_set_by` is NULL; the first time the owner flips the switch it is stamped with who and when, and from then on
  // the switch decides, so a redeploy never turns back on what the owner turned off. A Gmail row is always 0 and nothing reads it
  // for one: the assistant refuses any conversation whose mailbox is not a Cloudflare one that says it runs.
  //
  // ── A SORT KNOWS WHO MADE IT ────────────────────────────────────────────
  // `conversation.sort` is migration 8's. `sort_by` is the actor that last set it (`assistant`, the owner's address, or
  // `agent:` and a token) and `sort_at` when. The assistant sorts again on each new message EXCEPT on a conversation whose
  // `sort_by` is somebody else, which is how a sort the owner set sticks.
  //
  // `assist_failed_at` and `assist_failed_reason` are set on a conversation the assistant gave up on (no key, a model
  // outage past its retries, a draft it could not write): it stays in the Inbox with no sort, says so, and the owner was
  // notified anyway. A later successful pass, or somebody setting the sort, clears them. `assist_note` and `assist_note_at` are a
  // line for the owner that the assistant leaves when a follow-up came in and the draft waiting was not its to change (the owner edited it):
  // each pass writes or clears it, and the screen shows it over the messages only while a draft waits.
  //
  // ── ASSIST_OWED IS THE WORK THE ALARM DOES ──────────────────────────────
  // Filing a message in a mailbox the assistant runs on writes one row here IN THE SAME TRANSACTION as the message, so a
  // message is never filed without its sorting being owed, and the alarm does it (the entrance never waits on a model).
  // (Not for a message from the mailbox's own address: nothing sorts or answers our own mail.) Keyed by the message, so one
  // message owes once. `owed_at` is when Cloudflare's handler received the message, which is what the 50 minutes before the
  // assistant gives up are counted from (so the notification for a message it gave up on is still inside the hour); for a draft
  // asked for by setting a sort it is when it was asked. `notify` is 1 for a message that arrived (its sort ends in a
  // notification if it is a customer's) and 0 for a draft the owner or Claude asked for by setting the sort to customer (the owner is
  // looking, so nothing is sent to their phone). A failed call counts an attempt and moves `next_try_at`; there is no
  // "gave up" state here: giving up deletes the row and writes the failure on the conversation, in one transaction, which
  // is also the one that applies a success. That one transaction is what stops a retry from drafting twice: a draft
  // exists only when the row that asked for it was deleted by the same commit.
  //
  // ── USAGE IS ONE ROW PER CALL TO THE MODEL ──────────────────────────────
  // Whatever the call came to, including the ones that failed (zero tokens: the API answered with no usage) and the ones
  // that answered with something unreadable (billed, so their tokens are here). `outcome` is `ok`, `error` or
  // `unreadable`. Claude's script sums the rows over a period for the first week's report; nothing here is a price.
  //
  // ── THE KNOWLEDGE BASE'S SHAPE (READ BY NOTHING NOW) ───────────────────────────────
  // The knowledge base moved to the knowledge app (packages/knowledge; docs/adr/0002). These tables are left exactly as they are: the store of live mail is never
  // migrated for it, and going back is redeploying the previous builds. Migrations are appended, never edited, so what follows describes them as they were made.
  // `knowledge_entry` is per mailbox: a title, a body, `status` (`active` is what the assistant reads, `proposed` is what
  // Claude suggested and the owner has not approved, `removed` is kept and read by nobody) and who proposed it. `source_ref`
  // is unique and is how a one-time carry from an earlier app was made idempotent (`<source>:<id>`). `knowledge_version`
  // is append-only: every version of an entry's title and body, who wrote it and when, never updated and never deleted.
  // Empty is fine: the assistant drafts without it, conservatively, and says what was missing.
  `
  ALTER TABLE "mailbox" ADD COLUMN "assistant" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "mailbox" ADD COLUMN "assistant_set_by" TEXT;
  ALTER TABLE "mailbox" ADD COLUMN "assistant_set_at" TEXT;

  ALTER TABLE "conversation" ADD COLUMN "sort_by" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "sort_at" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "assist_failed_at" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "assist_failed_reason" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "assist_note" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "assist_note_at" TEXT;

  CREATE TABLE "assist_owed" (
    "message_id" TEXT PRIMARY KEY REFERENCES "message" ("id"),
    "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id"),
    "mailbox_id" TEXT NOT NULL REFERENCES "mailbox" ("id"),
    "owed_at" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TEXT NOT NULL,
    "last_error" TEXT,
    "notify" INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX "assist_owed_conversation_idx" ON "assist_owed" ("conversation_id");

  CREATE TABLE "assistant_usage" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "at" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL CHECK ("outcome" IN ('ok', 'error', 'unreadable')),
    "error" TEXT
  );
  CREATE INDEX "assistant_usage_at_idx" ON "assistant_usage" ("at");

  CREATE TABLE "knowledge_entry" (
    "id" TEXT PRIMARY KEY,
    "mailbox_id" TEXT NOT NULL REFERENCES "mailbox" ("id"),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('active', 'proposed', 'removed')),
    "proposed_by" TEXT,
    "created_at" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "source_ref" TEXT UNIQUE
  );
  CREATE INDEX "knowledge_entry_mailbox_idx" ON "knowledge_entry" ("mailbox_id", "status");

  CREATE TABLE "knowledge_version" (
    "seq" INTEGER PRIMARY KEY AUTOINCREMENT,
    "entry_id" TEXT NOT NULL REFERENCES "knowledge_entry" ("id"),
    "by" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL
  );
  CREATE INDEX "knowledge_version_entry_idx" ON "knowledge_version" ("entry_id", "seq");
  `,

  // 10 ── the draft chat and a proposed change.
  //
  // ── THE DRAFT CHAT IS KEPT PER DRAFT ────────────────────────────────────
  // `draft_chat` has one row per turn: the owner's words (`instruction`, NULL on a note the assistant left by itself over a
  // draft that was not its to change), what the assistant answered (`note`), whether the turn changed the draft
  // (`revised`) and from which revision to which (`rev_before`, `rev_after`). Keyed by the draft's message id with no
  // foreign key on purpose: a draft that is deleted takes its chat with it in the same transaction (store.deleteDraft), and
  // a draft that is sent keeps its turns, which nothing reads. A turn is only ever added, never edited. `by` is who asked
  // (the owner's address) or `assistant` for its own note.
  //
  // ── A PROPOSED CHANGE NAMES THE ENTRY IT WOULD CHANGE ───────────────────
  // `knowledge_entry.replaces` is set on a proposal that is a change to an entry (Claude's, through the script) and holds
  // the id of that entry. Approving it applies the proposal's title and body to that entry as an edit by the owner (a new
  // version, so the history shows the change) and removes the proposal. A proposal that adds an entry has none.
  //
  // `conversation.assist_note` and `assist_note_at` (migration 9) are no longer written: the sentence they held ("a new message
  // came in over a draft that was not the assistant's") is a turn of the draft's chat now. They stay, empty, because dropping a
  // column is its own one-way change.
  `
  CREATE TABLE "draft_chat" (
    "seq" INTEGER PRIMARY KEY AUTOINCREMENT,
    "draft_id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "instruction" TEXT,
    "note" TEXT NOT NULL,
    "revised" INTEGER NOT NULL DEFAULT 0,
    "rev_before" INTEGER NOT NULL,
    "rev_after" INTEGER
  );
  CREATE INDEX "draft_chat_draft_idx" ON "draft_chat" ("draft_id", "seq");

  ALTER TABLE "knowledge_entry" ADD COLUMN "replaces" TEXT;
  `,

  // 11 ── what the spam classifier said of a message. A Cloudflare mailbox's Inbox and Bulk follow the same rules as Gmail's, and the spam check is
  // a Cloudflare-hosted classifier model.
  //
  // Three nullable columns on `message` hold the facts: the probability that the message is unsolicited, the kind the classifier chose from
  // a closed list, and the model that said so. NULL means NOT JUDGED (the mailbox's switch was off, the binding was missing, the
  // call failed or timed out, a rule had already settled the mail, or a Client's people wrote) and is never folded into a low
  // score. What the score MEANS is code (`CLEF_JUNK_THRESHOLD` in src/queue.ts), so moving it is a deploy and not a migration.
  // Messages that came before are not backfilled.
  //
  // THE SORT COLUMNS ARE LEFT WHERE THEY ARE. `conversation.sort`, `sort_by` and `sort_at` (migrations 8 and 9) were the
  // assistant's sort of a conversation (customer, spam, promotional or newsletter). Nothing writes the assistant's sort any more;
  // what they hold now is a person's call (src/store/assist.ts `setSpam`): `sort` = 'spam' with `sort_by` the person's address is
  // the owner or Claude moving a conversation to Bulk, and a NULL `sort` with `sort_by` a person's address is moving it back to the
  // Inbox. A row the old assistant wrote (its `sort_by` is `assistant` or NULL) is read as no call at all. SQLite cannot alter the
  // CHECK that lists the four old words, which is why the column keeps its name and its list; a person's old 'promotional' or
  // 'newsletter' is still read as Bulk. `assist_owed` (migration 9) and `assist_failed_at`, `assist_failed_reason` are no longer
  // written or read either, and `assist_note` and `assist_note_at` stay as migration 10 left them: dropping a column or a table is
  // its own one-way change, and nothing here needs it.
  `
  ALTER TABLE "message" ADD COLUMN "clef_junk" REAL;
  ALTER TABLE "message" ADD COLUMN "clef_category" TEXT;
  ALTER TABLE "message" ADD COLUMN "clef_model" TEXT;
  `,

  // 12 ── a contact's profile: the business they are with, their role there, and a note about them, and the revision that guards them.
  // (People in the space.) The three fields are what the owner knows about a person that
  // no address says; they are kept on the contact because a contact IS the person (an identity is one way to reach them).
  //
  // ── ONE-WAY, AND THE SMALLEST IT CAN BE ─────────────────────────────────
  // Four columns added to `contact`, each NOT NULL with a default, so no row is rewritten or touched by the migration and every contact starts with
  // empty fields and revision 0. No table, no index, no backfill. A build before this one refuses a store at version 13 (`migrate`, below), so the
  // earlier build must never be redeployed as it was, and a restore to the bookmark does not help (the new build migrates the restored store again).
  // How the deploy is undone is a build of the old code that keeps THIS entry in the list.
  //
  // `profile_rev` is the revision a write must name: it goes up by one when the three fields change, the contact is renamed, an address is split off it or a merge changes it, and never down
  // (an undone merge goes up too), so a screen read before any of that cannot write over it. Nothing else reads these columns but the space's
  // People (src/store/space.ts), the merge and its undo (src/store/store.ts); the inbox's own page does not show them.
  `
  ALTER TABLE "contact" ADD COLUMN "business" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "contact" ADD COLUMN "role" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "contact" ADD COLUMN "notes" TEXT NOT NULL DEFAULT '';
  ALTER TABLE "contact" ADD COLUMN "profile_rev" INTEGER NOT NULL DEFAULT 0;
  `,

  // 13 ── what Cloudflare reported of the mail the inbox sent as a Cloudflare mailbox. Cloudflare's Email Sending publishes an event for each
  // recipient of each message to a queue (delivered, deferred, bounced, failed, rejected, complained), and the Worker's queue handler
  // keeps each one here, one row each, never updated: the event id is the key, so a report delivered twice is one row.
  //
  // `provider_id` is the id Cloudflare gave the message when it accepted it (the binding's `messageId`), with no angle brackets;
  // the sent message is filed under `<that id>` as its `rfc_message_id`, so a message is matched to its reports by comparing the two
  // at READ time and not by a column written at arrival. That is on purpose: a report can arrive before the send has been filed
  // (the queue is fast, the filing is the next step), and a report that matches nothing yet is simply kept until it does.
  // `at` is the report's own timestamp (its metadata's eventTimestamp), `kept_at` is when this inbox wrote it. Nothing is stored
  // of the subject, the sender or the account: the message already holds those. `reason` is Cloudflare's words, cut short.
  //
  // This migration is the only change delivery reports make to the store; the message table is not touched, and nothing is dropped.
  `
  CREATE TABLE "delivery_event" (
    "event_id" TEXT PRIMARY KEY,
    "provider_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "state" TEXT NOT NULL CHECK ("state" IN ('delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained')),
    "terminal" INTEGER NOT NULL CHECK ("terminal" IN (0, 1)),
    "reason" TEXT NOT NULL DEFAULT '',
    "at" TEXT NOT NULL,
    "kept_at" TEXT NOT NULL
  );
  CREATE INDEX "delivery_event_provider_idx" ON "delivery_event" ("provider_id");
  `,

  // 14 ── several Gmail accounts (the owner may connect more than one).
  //
  // ── THE TABLE ALREADY HELD MANY ─────────────────────────────────────────
  // `mailbox` is unique on (kind, address), and the cursor, the watch, the job, the push counters and the error all live on the row, with every
  // conversation and message pointing at its row. Nothing about a second Gmail row needs a table or an index; the code that assumed one was code
  // (`mailboxRow()` meant "the first Gmail row"), and it now names a row. What is new is two small things on the row:
  //   - `grant_lapsed_at`: when Google said this account's grant is gone (invalid_grant: the app is in testing, so a grant ends after 7 days, or it was revoked).
  //     NULL while the grant works. Set by the first call that finds it gone, cleared by connecting the account again (or disconnecting it). It is what makes the
  //     inbox say, in words and by name, which account needs connecting again, instead of a sync error that reads like any other.
  //   - `display_name` (already there, '' for a Gmail row until now): the short label the account's conversations carry as a pill, the way a business mailbox's
  //     name does. The one existing account is given its label here ("northfield" for tessa@northfield.example; the part before the @ for a gmail.com address, the domain's
  //     first label for any other); a new one is labelled when it is connected (src/gmail/account.ts), and a row with none is shown by its address.
  //
  // ── ONE-WAY, AND THE SMALLEST IT CAN BE ─────────────────────────────────
  // One nullable column and one UPDATE of a single row; nothing dropped, no row rewritten. A build before this one refuses a store at version 15
  // (`migrate`, below), so never redeploy an older commit as it was: keep every migration in the list, undo by a build of the old code that still carries
  // this one, and take a bookmark (scripts/inbox.ts bookmark) before applying. Code that does not know several accounts also does not need to: it reads
  // the first row, and a store holding more only matters once a second account is connected.
  `
  ALTER TABLE "mailbox" ADD COLUMN "grant_lapsed_at" TEXT;

  UPDATE "mailbox" SET "display_name" =
    CASE WHEN instr("address", '@') = 0 THEN "address"
         WHEN lower("address") LIKE '%@gmail.com' THEN substr("address", 1, instr("address", '@') - 1)
         WHEN instr(substr("address", instr("address", '@') + 1), '.') = 0 THEN "address"
         ELSE substr(substr("address", instr("address", '@') + 1), 1,
                     instr(substr("address", instr("address", '@') + 1), '.') - 1) END
   WHERE "kind" = 'gmail' AND "display_name" = '';
  `,

  // 15 ── which calendar event a message is about (so that when one event is updated several times, Today and the Inbox show only the latest).
  // Google Calendar sends a new email per update and its subject carries the time, so each is a thread of its own. `event_key` is the event's identity
  // (the iCalendar UID, or the id inside the `eid` of Google Calendar's links: src/calendar-event.ts), `event_kind` is 'update' (an invitation or an
  // update) or 'cancel'. Both NULL for every other message. The older conversations of one event are closed when a newer one arrives
  // (`MailStore.supersededEvents`, the Mailroom's sweep), and the Gmail mail already stored is read again from Gmail once for its key (`Mailroom.keyStoredCalendarMail`); a message that pass found not to be calendar mail has `event_kind` 'none' and no key.
  //
  // ── ONE-WAY, AND THE SMALLEST IT CAN BE ─────────────────────────────────
  // Two nullable columns and a partial index; no row is rewritten. A build before this one refuses a store at version 16 (`migrate`, below), so never
  // redeploy an older commit as it was: keep every migration in the list, undo by a build of the old code that still carries this one, and take a
  // bookmark (scripts/inbox.ts bookmark) before applying.
  `
  ALTER TABLE "message" ADD COLUMN "event_key" TEXT;
  ALTER TABLE "message" ADD COLUMN "event_kind" TEXT;
  CREATE INDEX "message_event_idx" ON "message" ("mailbox_id", "event_key") WHERE "event_key" IS NOT NULL;
  `,

  // 16 ── a third kind of mailbox, fed by the Telegram bridge.
  //
  // ── ONE-WAY, AND THE ONE REBUILD OF `mailbox` SINCE MIGRATION 8 ─────────────────────────────────────
  // SQLite cannot alter a CHECK, and `kind IN ('gmail', 'cloudflare')` must become `('gmail', 'cloudflare', 'telegram')`. The table is made again exactly as
  // migration 8 did it, for the reasons its comment gives (read them before touching this): `PRAGMA defer_foreign_keys = ON`, the rows copied aside, the old table
  // dropped, the new one created under its own name and the rows put back, so the checks at the commit find every reference settled. Five tables point at `mailbox`
  // (`conversation`, `message`, `arrival_owed`, `assist_owed`, `knowledge_entry`) and none has an ON DELETE action, so no child row is touched. Every column is copied
  // by name, token and cursor and job included, and the three new ones take their defaults. A build before this one refuses a store at version 17 (`migrate`,
  // below), so never redeploy an older commit as it was: keep every migration in the list, undo by a build of the old code that still carries this one, and
  // take a bookmark (scripts/inbox.ts bookmark) before applying. test/schema.test.ts runs it over a store holding all three other kinds of row, with the checks enforced.
  //
  // ── WHAT A TELEGRAM MAILBOX USES OF THE ROW ──────────────────────────────────────────────────────────
  // One row for the owner's one account: `address` is their Telegram user id, `display_name` is "Telegram" (the pill). `history_id` holds Telegram's position for the account
  // (updates.getState: pts, qts, date, seq, as JSON), the cursor a reconnect catches up from; it is written in the SAME transaction as the batch it follows, so a
  // position never gets ahead of what is stored. `last_push_at` is when the bridge last pushed, `last_error` and `last_error_at` are what it last reported wrong
  // (the login ended). The three new columns: `checked_in_at`, written at most once a minute from the bridge's work requests (which are its heartbeat);
  // `bridge_state` and `bridge_state_at`, what the bridge last said of itself (live, catching-up, signed-out). A Gmail or Cloudflare row never has any of them.
  //
  // ── WHAT A TELEGRAM CONVERSATION, IDENTITY AND MESSAGE ADD ─────────────────────────────────────────
  // `conversation.telegram_chat_id` finds the conversation of a chat, unique per mailbox as a Gmail thread is. `telegram_person` holds what only Telegram knows of a person
  // an identity stands for, one row per Telegram identity (a table of its own, so the shared `identity` table keeps its shape): `bot` is 1 for a bot, which is what the
  // rule for automated senders reads (src/automated.ts) to file a bot's chat in Bulk (Telegram says which a user is), and `username` is shown only as a name, never as the
  // address (a username changes; the id does not). `message.telegram_msg_id` is Telegram's own id of the
  // message: a deletion for a person's chat or a small group names ids and no chat (their ids are one sequence for the account), so it is found by this and not by the
  // arrival key, which is `<chat id>:<message id>` and is what makes a push repeated after a timeout store one message. `edited_at` and `deleted_at` are the edit and
  // the deletion for everyone: an edit replaces the text, a deletion removes it and leaves the row.
  `
  PRAGMA defer_foreign_keys = ON;

  CREATE TABLE "mailbox_copy" AS SELECT * FROM "mailbox";
  DROP TABLE "mailbox";

  CREATE TABLE "mailbox" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('gmail', 'cloudflare', 'telegram')),
    "address" TEXT NOT NULL,
    "refresh_token" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '',
    "history_id" TEXT,
    "watch_expiry" TEXT,
    "connected_at" TEXT NOT NULL,
    "connected_by" TEXT NOT NULL,
    "last_push_at" TEXT,
    "last_sync_at" TEXT,
    "last_error" TEXT,
    "last_error_at" TEXT,
    "last_resync_at" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "push_seq" INTEGER NOT NULL DEFAULT 0,
    "synced_seq" INTEGER NOT NULL DEFAULT 0,
    "push_suspect_at" TEXT,
    "job" TEXT,
    "display_name" TEXT NOT NULL DEFAULT '',
    "last_arrival_at" TEXT,
    "assistant" INTEGER NOT NULL DEFAULT 0,
    "assistant_set_by" TEXT,
    "assistant_set_at" TEXT,
    "grant_lapsed_at" TEXT,
    "checked_in_at" TEXT,
    "bridge_state" TEXT CHECK ("bridge_state" IN ('live', 'catching-up', 'signed-out')),
    "bridge_state_at" TEXT,
    UNIQUE ("kind", "address")
  );

  INSERT INTO "mailbox" ("id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job", "display_name", "last_arrival_at",
    "assistant", "assistant_set_by", "assistant_set_at", "grant_lapsed_at")
  SELECT "id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job", "display_name", "last_arrival_at",
    "assistant", "assistant_set_by", "assistant_set_at", "grant_lapsed_at"
  FROM "mailbox_copy";

  DROP TABLE "mailbox_copy";

  ALTER TABLE "conversation" ADD COLUMN "telegram_chat_id" TEXT;
  CREATE UNIQUE INDEX "conversation_telegram_idx" ON "conversation" ("mailbox_id", "telegram_chat_id")
    WHERE "telegram_chat_id" IS NOT NULL;

  CREATE TABLE "telegram_person" (
    "identity_id" TEXT PRIMARY KEY REFERENCES "identity" ("id"),
    "bot" INTEGER NOT NULL CHECK ("bot" IN (0, 1)),
    "username" TEXT
  );

  ALTER TABLE "message" ADD COLUMN "telegram_msg_id" INTEGER;
  ALTER TABLE "message" ADD COLUMN "edited_at" TEXT;
  ALTER TABLE "message" ADD COLUMN "deleted_at" TEXT;
  CREATE INDEX "message_telegram_idx" ON "message" ("mailbox_id", "telegram_msg_id") WHERE "telegram_msg_id" IS NOT NULL;
  `,

  // 17 ── groups and channels.
  //
  // ── ONE-WAY, AND THE SMALLEST IT CAN BE ──────────────────────────────────────────────────────────────
  // Four nullable columns; no table is made again and no row is rewritten. A build before this one refuses a store at version 18 (`migrate`, below), so never redeploy an older commit
  // as it was: keep every migration in the list, undo by a build of the old code that still carries this one, and take a bookmark (scripts/inbox.ts bookmark) before applying.
  //
  // `conversation.telegram_kind` is what kind of chat a Telegram conversation is: 'user', 'bot', 'group' or 'channel'. NULL for the one-to-one conversations migration 16 made (a one-to-one
  // chat is whatever its person is: `telegram_person.bot`), which is why nothing is rewritten. `conversation.telegram_pts` is a supergroup's or a channel's own position (its pts, which
  // the account's position does not cover), written in the same transaction as the batch it follows; NULL for every other chat.
  // `telegram_person.chat` marks the identity that stands for a group or a channel ('group' or 'channel'), the contact the group's conversation is filed under; NULL for a person or a bot.
  // `message.telegram_to_me` is, for a message in a group from somebody else, 1 when it mentions the owner or replies to one of their messages and 0 when it does not; NULL
  // everywhere else. It is what Needs reply, ringing and reopening read, and is set once, when the message arrives.
  `
  ALTER TABLE "conversation" ADD COLUMN "telegram_kind" TEXT;
  ALTER TABLE "conversation" ADD COLUMN "telegram_pts" INTEGER;
  ALTER TABLE "telegram_person" ADD COLUMN "chat" TEXT;
  ALTER TABLE "message" ADD COLUMN "telegram_to_me" INTEGER;
  `,

  // 18 ── a fourth kind of mailbox, read and written over JMAP on the install's own mail server.
  //
  // ── ONE-WAY, AND THE THIRD REBUILD OF `mailbox` ─────────────────────────────────────────────────────────────────
  // SQLite cannot alter a CHECK, and `kind IN ('gmail', 'cloudflare', 'telegram')` must become `('gmail', 'cloudflare', 'telegram', 'jmap')`. The table is made again exactly as migrations 8 and 16
  // did it, for the reasons migration 8's comment gives (read them before touching this): `PRAGMA defer_foreign_keys = ON`, the rows copied aside, the old table dropped, the new one created under its
  // own name and the rows put back, so the checks at the commit find every reference settled. Five tables point at `mailbox` (`conversation`, `message`, `arrival_owed`, `assist_owed`,
  // `knowledge_entry`) and none has an ON DELETE action, so no child row is touched. Every column is copied by name, and the table gains NO column: a JMAP mailbox's push subscription is a `setting` row
  // (`jmap-push:<mailbox id>`), so a Gmail, Cloudflare or Telegram row comes out of this exactly as it went in. A build before this one refuses a store at version 19 (`migrate`, below), so never
  // redeploy an older commit as it was: keep every migration in the list, undo by a build of the old code that still carries this one, and take a bookmark (scripts/inbox.ts bookmark) before applying.
  // test/schema-jmap.test.ts runs it over a store holding all three other kinds of row, with the checks enforced.
  //
  // ── WHAT A JMAP MAILBOX USES OF THE ROW ─────────────────────────────────────────────────────────────────────────
  // One row per mailbox the deploy declares: `address` is its address, `display_name` the pill. `history_id` holds the server's state strings (the Email and Mailbox states, as JSON), the cursor a
  // sync continues from; it is written in the SAME transaction as the page it follows, so it never runs ahead of what is stored. `job` is a fill or a resync, as Gmail's is. `push_seq`, `synced_seq`,
  // `last_push_at`, `last_sync_at`, `last_error`, `last_error_at` and `retry_count` mean what they mean for Gmail. `grant_lapsed_at` is when the server refused the space's credential (nothing syncs or
  // sends for the mailbox until a deploy changes it). It never has a `refresh_token`: the credential is a secret of the Worker, not a row.
  //
  // ── WHAT A JMAP CONVERSATION AND MESSAGE ADD ────────────────────────────────────────────────────────────────────
  // `conversation.jmap_thread_id` and `message.jmap_id` are the server's own ids, each unique per mailbox as a Gmail thread and a Gmail id are (so every ingest is an upsert and a repeated sync stores a
  // message once). They are NOT Gmail's columns reused: every query that reads `gmail_id` or `gmail_thread_id` keeps meaning Gmail.
  `
  PRAGMA defer_foreign_keys = ON;

  CREATE TABLE "mailbox_copy" AS SELECT * FROM "mailbox";
  DROP TABLE "mailbox";

  CREATE TABLE "mailbox" (
    "id" TEXT PRIMARY KEY,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('gmail', 'cloudflare', 'telegram', 'jmap')),
    "address" TEXT NOT NULL,
    "refresh_token" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '',
    "history_id" TEXT,
    "watch_expiry" TEXT,
    "connected_at" TEXT NOT NULL,
    "connected_by" TEXT NOT NULL,
    "last_push_at" TEXT,
    "last_sync_at" TEXT,
    "last_error" TEXT,
    "last_error_at" TEXT,
    "last_resync_at" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "push_seq" INTEGER NOT NULL DEFAULT 0,
    "synced_seq" INTEGER NOT NULL DEFAULT 0,
    "push_suspect_at" TEXT,
    "job" TEXT,
    "display_name" TEXT NOT NULL DEFAULT '',
    "last_arrival_at" TEXT,
    "assistant" INTEGER NOT NULL DEFAULT 0,
    "assistant_set_by" TEXT,
    "assistant_set_at" TEXT,
    "grant_lapsed_at" TEXT,
    "checked_in_at" TEXT,
    "bridge_state" TEXT CHECK ("bridge_state" IN ('live', 'catching-up', 'signed-out')),
    "bridge_state_at" TEXT,
    UNIQUE ("kind", "address")
  );

  INSERT INTO "mailbox" ("id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job", "display_name", "last_arrival_at",
    "assistant", "assistant_set_by", "assistant_set_at", "grant_lapsed_at", "checked_in_at", "bridge_state", "bridge_state_at")
  SELECT "id", "kind", "address", "refresh_token", "scopes", "history_id", "watch_expiry",
    "connected_at", "connected_by", "last_push_at", "last_sync_at", "last_error", "last_error_at", "last_resync_at",
    "retry_count", "push_seq", "synced_seq", "push_suspect_at", "job", "display_name", "last_arrival_at",
    "assistant", "assistant_set_by", "assistant_set_at", "grant_lapsed_at", "checked_in_at", "bridge_state", "bridge_state_at"
  FROM "mailbox_copy";

  DROP TABLE "mailbox_copy";

  ALTER TABLE "conversation" ADD COLUMN "jmap_thread_id" TEXT;
  CREATE UNIQUE INDEX "conversation_jmap_thread_idx" ON "conversation" ("mailbox_id", "jmap_thread_id")
    WHERE "jmap_thread_id" IS NOT NULL;

  ALTER TABLE "message" ADD COLUMN "jmap_id" TEXT;
  CREATE UNIQUE INDEX "message_jmap_idx" ON "message" ("mailbox_id", "jmap_id")
    WHERE "jmap_id" IS NOT NULL;
  `,

  // 19 ── every mailbox has people.
  //
  // A mailbox is one person's (a Gmail account they connected) or a list's (a shared mailbox), and the inbox shows a person only the mailboxes they are on (src/queue.ts `canSee`). The people are rows of a table of their own,
  // `mailbox_person`: the mailbox, the person by their work address (the declaration's `people` address, which is the actor every write stamps; the address they sign in with is only how Access names them), and who put them there and when. A table and not a column, because a shared mailbox has several and a person may
  // be on several; and no foreign key to `mailbox`, because that table has been made again three times (migrations 8, 16 and 18) and a reference into it would have to be settled again by every one to come.
  //
  // ── ONE-WAY, AND WHAT IT FILLS ─────────────────────────────────────────────────────────────────────────────────
  // It adds a table and an index and rewrites nothing: no row of any other table is touched. A build before this one refuses a store at version 20 (`migrate`, below), so never redeploy an older commit as it was: keep every
  // migration in the list, undo by a build of the old code that still carries this one, and take a bookmark (scripts/inbox.ts bookmark) before applying. test/schema-people.test.ts runs it over a store with today's schema.
  //
  // It fills the one thing the store knows on its own: a Gmail account is its connector's (`connected_by`, the owner's address, since only the owner has ever connected one). The other kinds (a business mailbox, a mailbox on
  // the mail server, Telegram) are the declaration's to say, and the store has no declaration, so they are filled when the object starts, before it serves a request (`settleMailboxPeople`, src/store/people.ts): the people
  // the install declares, else the install's owner. So for an install with one owner every account the owner connected is theirs, and every declared business mailbox is shared with the owner alone, whatever the
  // order the migration and the first start happen in: nothing is served between them.
  `
  CREATE TABLE "mailbox_person" (
    "mailbox_id" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "added_at" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    PRIMARY KEY ("mailbox_id", "person")
  );
  CREATE INDEX "mailbox_person_person_idx" ON "mailbox_person" ("person");

  INSERT INTO "mailbox_person" ("mailbox_id", "person", "added_at", "added_by")
  SELECT "id", lower(trim("connected_by")), "connected_at", 'migration 19'
    FROM "mailbox"
   WHERE "kind" = 'gmail' AND trim("connected_by") != '' AND "connected_by" NOT LIKE 'agent:%';
  `,

  // 20 ── what an email's calendar part says, kept on the message (so a conversation shows an invitation, an update, a cancellation or a guest's answer in place of an empty bubble).
  // `calendar` is the summary the inbox reads ONCE when the mail arrives (src/calendar-summary.ts, and the workspace's `CalendarSummary`) as JSON: what the part is, the first event's title, time, place, organizer and guests. NULL means the message
  // was not looked at (stored before this column, or its calendar bytes could not be fetched at arrival); the text `none` means it was looked at and has no summary, so the one-time pass (`Mailroom.summariseStoredCalendarMail`, a setting row says
  // done) never reads it again. Nothing else changes: the event key and its closing (migration 15) are untouched.
  //
  // ── ONE-WAY, AND THE SMALLEST IT CAN BE ─────────────────────────────────
  // One nullable column; no index, no backfill, no row rewritten. A build before this one refuses a store at version 21 (`migrate`, below), so never redeploy an older commit as it was: keep every migration in the list, undo by a build of the old
  // code that still carries this one (an undo build keeps migrations 12 to 20), and take a bookmark (scripts/inbox.ts bookmark) before applying. test/schema-calendar.test.ts runs it over a store with today's schema.
  `
  ALTER TABLE "message" ADD COLUMN "calendar" TEXT;
  `,
]

/** The version a fully migrated inbox reports. */
export const INBOX_VERSION = INBOX_MIGRATIONS.length

/**
 * Enough of Cloudflare's `SqlStorage` for the store. Declared rather than
 * imported so nothing here depends on the Workers types being in scope. A SUBSET
 * on purpose: widening it is a decision, not an accident.
 */
export type InboxSql = {
  exec: (query: string, ...bindings: unknown[]) => SqlCursor
}

export type SqlCursor = {
  toArray: () => Record<string, unknown>[]
  one: () => Record<string, unknown>
  readonly rowsWritten: number
}

/**
 * Bring storage up to date, and answer with the version it is now at.
 *
 * Idempotent and cheap on the common path: an object that is up to date reads
 * one row and writes nothing. It runs on EVERY construction of the object, which
 * is every time it is woken from hibernation, so it has to be.
 *
 * It throws on a version from the future. A store migrated by a NEWER deploy and
 * then read by an older one is a rollback, and there is nothing honest this
 * function could do about it: it cannot un-apply a migration, and pretending the
 * schema is what this build expects is how a read silently returns the wrong
 * columns. It shuts the inbox loudly rather than answering it wrongly.
 */
export function migrate(sql: InboxSql): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS "inbox_meta" (
    "id" TEXT PRIMARY KEY CHECK ("id" = 'version'),
    "applied" INTEGER NOT NULL
  )`)

  const row = sql.exec(`SELECT applied FROM inbox_meta WHERE id = 'version'`).toArray()[0]
  const applied = row ? Number(row.applied) : 0

  if (applied > INBOX_MIGRATIONS.length) {
    throw new Error(
      `Inbox storage is at version ${applied}, but this build only knows ${INBOX_MIGRATIONS.length}. ` +
        'This is an older deploy reading a store a newer one migrated; deploy forwards rather than back.',
    )
  }

  for (let version = applied; version < INBOX_MIGRATIONS.length; version += 1) {
    sql.exec(INBOX_MIGRATIONS[version] as string)
  }

  if (applied !== INBOX_MIGRATIONS.length) {
    sql.exec(
      `INSERT INTO inbox_meta (id, applied) VALUES ('version', ?1)
         ON CONFLICT(id) DO UPDATE SET applied = excluded.applied`,
      INBOX_MIGRATIONS.length,
    )
  }

  return INBOX_MIGRATIONS.length
}
