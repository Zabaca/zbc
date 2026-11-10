-- The forms service, second migration: what the signing core needs beyond the first migration's tables.
--
--  * `instructions` and `instruction_uses`: the owner's word for one action Claude takes, append-only like events, and the
--    single use of each. `settings`: Claude's sending switch, off by default.
--  * Columns the envelope's life needs: its expiry in days (the date is set at Send), whether it holds a sensitive
--    answer (that decides how the finished document is delivered), when it began sealing (so the sweep does not race a
--    live completion), when a recipient was last emailed (reminders count from it), and what a message was about.
--
-- Later work adds no table of its own unless it must: a table it needs goes in the next numbered migration.

ALTER TABLE envelopes ADD COLUMN expires_in_days INTEGER NOT NULL DEFAULT 30 CHECK (expires_in_days BETWEEN 1 AND 365);
-- 1 when any answer is sensitive or the operator marked a PDF send so: the finished document goes by private link, never attached.
ALTER TABLE envelopes ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1));
ALTER TABLE envelopes ADD COLUMN sealing_at TEXT;
-- How many times the sweep has tried to seal it again: it gives up after a few and tells the operator, and the envelope is purged one day.
ALTER TABLE envelopes ADD COLUMN sealing_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE recipients ADD COLUMN notified_at TEXT;
-- Bumped by every save of a field value. Finish is written only if it is still what Finish read, so every value in the sealed
-- PDF is one the signer's `signed` event hashed.
ALTER TABLE recipients ADD COLUMN values_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE mail ADD COLUMN instruction_id TEXT;
-- What a message was about that the envelope does not hold (a cancel reason, who declined). Never an answer.
ALTER TABLE mail ADD COLUMN data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data));
ALTER TABLE mail ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- The owner's words, as Claude received them, for ONE action on ONE envelope. Claude's own account, not proof: the app cannot see a
-- chat. `channel` can only be a session with Claude: never this app, an email, or any other message, even one from the owner's address.
CREATE TABLE instructions (
  id                TEXT PRIMARY KEY,
  envelope_id       TEXT NOT NULL REFERENCES envelopes(id),
  client_id         TEXT NOT NULL REFERENCES clients(id),
  action            TEXT NOT NULL CHECK (action IN ('send', 'remind', 'cancel', 'correct-recipient')),
  words             TEXT NOT NULL CHECK (length(words) BETWEEN 1 AND 2000),
  channel           TEXT NOT NULL CHECK (channel = 'session'),
  said_at           TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  recorded_by       TEXT NOT NULL,
  -- For a send: the fingerprint of the draft as it stood. A draft edited afterwards is not covered.
  draft_fingerprint TEXT,
  -- For a reminder or a correction: the one recipient (and, for a correction, the new address) it covers, as JSON.
  target            TEXT CHECK (target IS NULL OR json_valid(target)),
  -- SHA-256 over the row's fields, which the event records instead of the words.
  sha256            TEXT NOT NULL,
  CHECK (action <> 'send' OR draft_fingerprint IS NOT NULL)
);
CREATE INDEX instructions_envelope ON instructions(envelope_id);
CREATE TRIGGER instructions_never_updated BEFORE UPDATE ON instructions
  BEGIN SELECT RAISE(ABORT, 'an instruction is never changed'); END;
CREATE TRIGGER instructions_deleted_only_when_purged BEFORE DELETE ON instructions
  WHEN NOT EXISTS (SELECT 1 FROM tombstones WHERE tombstones.envelope_id = OLD.envelope_id)
  BEGIN SELECT RAISE(ABORT, 'an instruction is deleted only when its envelope has been purged'); END;

-- An instruction is used once. The primary key is what stops two requests racing to use the same one.
CREATE TABLE instruction_uses (
  instruction_id TEXT PRIMARY KEY REFERENCES instructions(id),
  envelope_id    TEXT NOT NULL REFERENCES envelopes(id),
  used_at        TEXT NOT NULL
);
CREATE TRIGGER instruction_uses_never_updated BEFORE UPDATE ON instruction_uses
  BEGIN SELECT RAISE(ABORT, 'an instruction use is never changed'); END;
CREATE TRIGGER instruction_uses_deleted_only_when_purged BEFORE DELETE ON instruction_uses
  WHEN NOT EXISTS (SELECT 1 FROM tombstones WHERE tombstones.envelope_id = OLD.envelope_id)
  BEGIN SELECT RAISE(ABORT, 'an instruction use is deleted only when its envelope has been purged'); END;

-- Settings the owner changes. `agent_sending` is Claude's sending switch: 'off' until the owner turns it on, and only an operator can.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('agent_sending', 'off', '2026-10-31T00:00:00.000Z', 'migration');
