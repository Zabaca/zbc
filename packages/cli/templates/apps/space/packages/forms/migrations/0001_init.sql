-- The forms service, first migration: every table the service will have, so later work adds behaviour and no
-- migration unless it must.
-- At first only `clients` and `audit` are written; every other table waits, empty, for the signing core and after.
--
-- Three rules this file enforces and a test pins (test/records.test.ts):
--  * An EVENT is never updated, and is deleted only after its envelope has a tombstone (a purge).
--  * A PUBLISHED form version is never changed or deleted.
--  * Every table a client owns carries the client's id, so a later client login is a scope, not a migration.
--
-- Ids are random text (a UUID), never a counter: an envelope's id shows up in a tombstone and in the
-- certificate of completion, and an enumerable id would invite guessing. Times are ISO 8601 UTC text.
-- Names and email addresses stay readable (lists and emails need them); every ANSWER, FIELD VALUE and TOKEN
-- is stored encrypted with the envelope's own key (`*_enc`, src/vault.ts), and every R2 object likewise.

CREATE TABLE clients (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40),
  display_name   TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  legal_name     TEXT NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 120),
  -- #rrggbb. Three small tests rather than one long GLOB: D1 refuses a LIKE or GLOB pattern over 50 bytes.
  accent_color   TEXT NOT NULL DEFAULT '#1f4e79' CHECK (length(accent_color) = 7 AND substr(accent_color, 1, 1) = '#' AND substr(accent_color, 2) NOT GLOB '*[^0-9a-fA-F]*'),
  -- The logo is public (an email loads it from /api/logo/<id>), so it is the one object stored without a key.
  logo_key       TEXT,
  logo_type      TEXT CHECK (logo_type IN ('image/png', 'image/jpeg')),
  logo_sha256    TEXT,
  -- Replies to every signing email go here (Reply-To), so a signer's question reaches the business.
  reply_to       TEXT NOT NULL CHECK (reply_to LIKE '_%@_%._%'),
  -- JSON array of addresses that get a copy of every finished document, like any recipient.
  copy_addresses TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(copy_addresses) AND json_type(copy_addresses) = 'array'),
  time_zone      TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  -- How long finished records are kept. 7 years unless the client's own rules say otherwise.
  retention_years INTEGER NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 50),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE forms (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX forms_client ON forms(client_id);

-- A version is the whole frozen definition and its hash. A draft has published_at NULL and may change;
-- once published it never does (the triggers below), so a sent form is pinned to what its signer answered.
CREATE TABLE form_versions (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  form_id         TEXT NOT NULL REFERENCES forms(id),
  version         INTEGER NOT NULL CHECK (version >= 1),
  definition      TEXT NOT NULL CHECK (json_valid(definition)),
  definition_hash TEXT NOT NULL,
  published_at    TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (form_id, version)
);
CREATE TRIGGER form_versions_published_never_updated BEFORE UPDATE ON form_versions
  WHEN OLD.published_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a published form version never changes'); END;
-- Nor replaced: INSERT OR REPLACE deletes the old row without firing the delete trigger below.
CREATE TRIGGER form_versions_published_never_replaced BEFORE INSERT ON form_versions
  WHEN EXISTS (SELECT 1 FROM form_versions WHERE published_at IS NOT NULL AND (id = NEW.id OR (form_id = NEW.form_id AND version = NEW.version)))
  BEGIN SELECT RAISE(ABORT, 'a published form version is never replaced'); END;
CREATE TRIGGER form_versions_published_never_deleted BEFORE DELETE ON form_versions
  WHEN OLD.published_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a published form version is never deleted'); END;

-- A PDF uploaded to be signed: as received, and the working copy (decrypted, restrictions removed, XFA
-- dropped) every later step reads. Encrypted with a key of its own, because no envelope exists yet.
CREATE TABLE source_documents (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  name            TEXT NOT NULL,
  original_key    TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  original_size   INTEGER NOT NULL,
  working_key     TEXT NOT NULL,
  working_sha256  TEXT NOT NULL,
  working_size    INTEGER NOT NULL,
  page_count      INTEGER NOT NULL,
  inspection      TEXT NOT NULL CHECK (json_valid(inspection)),
  fields          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields)),
  wrapped_key     TEXT NOT NULL,
  key_version     INTEGER NOT NULL,
  uploaded_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX source_documents_client ON source_documents(client_id);

CREATE TABLE envelopes (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES clients(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('form', 'document')),
  form_version_id      TEXT REFERENCES form_versions(id),
  source_document_id   TEXT REFERENCES source_documents(id),
  title                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'prepared', 'sealing', 'completed', 'declined', 'cancelled', 'expired')),
  order_mode           TEXT NOT NULL DEFAULT 'sequential' CHECK (order_mode IN ('sequential', 'parallel')),
  note                 TEXT,
  expires_at           TEXT,
  reminder_every_days  INTEGER NOT NULL DEFAULT 3,
  reminder_max         INTEGER NOT NULL DEFAULT 3,
  created_by           TEXT NOT NULL,
  sent_by              TEXT,
  created_at           TEXT NOT NULL,
  sent_at              TEXT,
  -- The fixed PDF a signer is asked to sign, and the finished, sealed one. SHA-256, lowercase hex.
  prepared_key         TEXT,
  prepared_sha256      TEXT,
  prepared_size        INTEGER,
  finished_key         TEXT,
  finished_sha256      TEXT,
  finished_size        INTEGER,
  -- The envelope's data key, wrapped by the master key, and the master's version.
  wrapped_key          TEXT NOT NULL,
  key_version          INTEGER NOT NULL,
  completed_at         TEXT,
  -- When the daily purge deletes it: the client's retention after completion, or 90 days after an
  -- envelope stopped without finishing.
  purge_at             TEXT,
  CHECK ((kind = 'form' AND form_version_id IS NOT NULL) OR (kind = 'document' AND source_document_id IS NOT NULL) OR status = 'draft')
);
CREATE INDEX envelopes_client_status ON envelopes(client_id, status);
CREATE INDEX envelopes_purge ON envelopes(purge_at) WHERE purge_at IS NOT NULL;

CREATE TABLE recipients (
  id               TEXT PRIMARY KEY,
  envelope_id      TEXT NOT NULL REFERENCES envelopes(id),
  client_id        TEXT NOT NULL REFERENCES clients(id),
  role             TEXT NOT NULL,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'signer' CHECK (kind IN ('signer', 'copy')),
  position         INTEGER NOT NULL CHECK (position >= 1),
  -- The link carries a random 256-bit token. Lookup is by its hash; the token itself is kept encrypted with
  -- the envelope's key so a reminder can resend the same link.
  token_hash       TEXT UNIQUE,
  token_enc        TEXT,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'opened', 'consented', 'signed', 'declined')),
  consent_version  TEXT,
  consent_at       TEXT,
  opened_at        TEXT,
  signed_at        TEXT,
  declined_at      TEXT,
  decline_reason   TEXT,
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (envelope_id, position)
);
CREATE INDEX recipients_envelope ON recipients(envelope_id);

-- A field on the prepared document: a box as fractions of the page as shown, from its top-left corner.
CREATE TABLE fields (
  id             TEXT PRIMARY KEY,
  envelope_id    TEXT NOT NULL REFERENCES envelopes(id),
  client_id      TEXT NOT NULL REFERENCES clients(id),
  recipient_id   TEXT NOT NULL REFERENCES recipients(id),
  type           TEXT NOT NULL CHECK (type IN ('signature', 'initials', 'date', 'text', 'checkbox')),
  page           INTEGER NOT NULL CHECK (page >= 0),
  x              REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y              REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  width          REAL NOT NULL CHECK (width > 0 AND width <= 1),
  height         REAL NOT NULL CHECK (height > 0 AND height <= 1),
  required       INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  label          TEXT,
  -- The name of the PDF's own field this one fills, when it was detected in the file.
  pdf_field_name TEXT,
  CHECK (x + width <= 1.0000001 AND y + height <= 1.0000001)
);
CREATE INDEX fields_envelope ON fields(envelope_id);

CREATE TABLE field_values (
  field_id     TEXT PRIMARY KEY REFERENCES fields(id),
  envelope_id  TEXT NOT NULL REFERENCES envelopes(id),
  client_id    TEXT NOT NULL REFERENCES clients(id),
  value_enc    TEXT NOT NULL,
  filled_by    TEXT NOT NULL REFERENCES recipients(id),
  filled_at    TEXT NOT NULL
);

CREATE TABLE answers (
  envelope_id  TEXT NOT NULL REFERENCES envelopes(id),
  client_id    TEXT NOT NULL REFERENCES clients(id),
  question_id  TEXT NOT NULL,
  value_enc    TEXT NOT NULL,
  answered_at  TEXT NOT NULL,
  PRIMARY KEY (envelope_id, question_id)
);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  envelope_id  TEXT NOT NULL REFERENCES envelopes(id),
  client_id    TEXT NOT NULL REFERENCES clients(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  question_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX uploads_envelope ON uploads(envelope_id);

CREATE TABLE signature_adoptions (
  id           TEXT PRIMARY KEY,
  envelope_id  TEXT NOT NULL REFERENCES envelopes(id),
  client_id    TEXT NOT NULL REFERENCES clients(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  kind         TEXT NOT NULL CHECK (kind IN ('signature', 'initials')),
  method       TEXT NOT NULL CHECK (method IN ('drawn', 'typed', 'uploaded')),
  image_key    TEXT,
  image_sha256 TEXT,
  typed_text   TEXT,
  typed_font   TEXT,
  adopted_at   TEXT NOT NULL,
  UNIQUE (recipient_id, kind)
);

-- What stays of a purged envelope: enough to say it existed and to match a copy someone still holds.
CREATE TABLE tombstones (
  envelope_id      TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  title            TEXT NOT NULL,
  completed_at     TEXT,
  finished_sha256  TEXT,
  chain_last_hash  TEXT,
  purged_at        TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('retention', 'unfinished', 'operator'))
);
-- A tombstone is what lets an envelope's events be deleted, so it must not be removable: otherwise write one, delete the
-- last events, delete the tombstone, and the chain would still verify. It keeps the chain's last hash to match a copy against.
-- (Nor replaced: INSERT OR REPLACE deletes the old row without firing a delete trigger, so a second tombstone for the same
-- envelope is refused before any conflict is resolved.)
CREATE TRIGGER tombstones_written_once BEFORE INSERT ON tombstones
  WHEN EXISTS (SELECT 1 FROM tombstones WHERE envelope_id = NEW.envelope_id)
  BEGIN SELECT RAISE(ABORT, 'a tombstone is never replaced'); END;
CREATE TRIGGER tombstones_never_updated BEFORE UPDATE ON tombstones
  BEGIN SELECT RAISE(ABORT, 'a tombstone is never changed'); END;
CREATE TRIGGER tombstones_never_deleted BEFORE DELETE ON tombstones
  BEGIN SELECT RAISE(ABORT, 'a tombstone is never deleted'); END;

-- The log. Each event's hash covers its own fields and the one before (src/events.ts), so a changed or
-- removed event breaks every hash after it. The triggers are the database's half of "refuses edits".
CREATE TABLE events (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  client_id   TEXT NOT NULL REFERENCES clients(id),
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  at          TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('operator', 'recipient', 'system', 'agent')),
  actor_email TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  device      TEXT,
  details     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  doc_hash    TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  PRIMARY KEY (envelope_id, seq)
);
-- An event is appended, and only at the end of its envelope's chain: its sequence number is the next one and its
-- previous hash is the last event's hash (64 zeros for the first). BEFORE INSERT fires before a conflict is resolved, so
-- this also stops INSERT OR REPLACE swapping a row, which would otherwise pass in silence (recursive triggers are off,
-- so a REPLACE does not fire the delete trigger below). The wording of the sequence refusal contains "UNIQUE constraint
-- failed" on purpose: src/events.ts retries a writer that lost a race on exactly that text.
CREATE TRIGGER events_append_only BEFORE INSERT ON events
  WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE envelope_id = NEW.envelope_id)
    OR NEW.prev_hash IS NOT COALESCE((SELECT hash FROM events WHERE envelope_id = NEW.envelope_id ORDER BY seq DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000')
  BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: events.envelope_id, events.seq (an event follows the last one and its hash)'); END;
-- An event belongs to the client its envelope belongs to.
CREATE TRIGGER events_same_client BEFORE INSERT ON events
  WHEN NEW.client_id IS NOT (SELECT client_id FROM envelopes WHERE id = NEW.envelope_id)
  BEGIN SELECT RAISE(ABORT, 'an event carries its envelope''s client'); END;
CREATE TRIGGER events_never_updated BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'an event is never changed'); END;
-- A purge writes the tombstone first, then deletes the events: nothing else may remove one.
CREATE TRIGGER events_deleted_only_when_purged BEFORE DELETE ON events
  WHEN NOT EXISTS (SELECT 1 FROM tombstones WHERE tombstones.envelope_id = OLD.envelope_id)
  BEGIN SELECT RAISE(ABORT, 'an event is deleted only when its envelope has been purged'); END;

-- Every message, recorded as pending BEFORE it leaves, then sent or failed with the reason
-- (the usual sent-mail pattern). No mail goes out without its row.
CREATE TABLE mail (
  id           TEXT PRIMARY KEY,
  client_id    TEXT REFERENCES clients(id),
  envelope_id  TEXT REFERENCES envelopes(id),
  recipient_id TEXT REFERENCES recipients(id),
  kind         TEXT NOT NULL,
  to_email     TEXT NOT NULL,
  to_name      TEXT,
  from_name    TEXT NOT NULL,
  reply_to     TEXT,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error        TEXT,
  message_id   TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX mail_envelope ON mail(envelope_id);

-- Operator changes to clients, forms and documents: actor, before and after, written in the same batch as
-- the change (src/store.ts). Whole-database restore is D1 Time Travel (30 days).
CREATE TABLE audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  client_id TEXT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before    TEXT,
  after     TEXT
);
CREATE INDEX audit_client ON audit(client_id, id DESC);
CREATE INDEX audit_entity ON audit(entity, entity_id);

