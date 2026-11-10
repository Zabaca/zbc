-- The forms service: the conversation an envelope was sent from.
--
-- The space sends a document from a conversation and shows it there as a card. An envelope may carry that conversation: which app
-- holds it (`inbox`: a person's mail contact; `meet`: a direct message or a channel) and its id in that app. Both are NULL for an envelope sent from
-- Forms, and for every envelope that exists today. Set once, when the draft is made, and never changed after.
--
-- The link lives in these two columns and nowhere else: it is not written into any event, because every event is sealed into the PDF each signer receives.
--
-- ADDITIVE, so it is safe to apply before the code that reads it and while the old code is still running: two nullable columns, an index and two triggers,
-- no row touched. The deploy order with the space, and what to check, are in ONE place: packages/space/README.md, "After documents come to a conversation".

-- The id first, so the app's check can name it. A column's check is tested when its own column is written, so "both or none" is held in both directions
-- by the app's check (an app with no id) and by the two triggers (an id with no app); the values are held by the column checks.
ALTER TABLE envelopes ADD COLUMN conversation_id TEXT CHECK (conversation_id IS NULL OR length(conversation_id) BETWEEN 1 AND 200);
ALTER TABLE envelopes ADD COLUMN conversation_app TEXT CHECK (conversation_app IS NULL OR (conversation_app IN ('inbox', 'meet') AND conversation_id IS NOT NULL));
CREATE INDEX envelopes_conversation ON envelopes(conversation_app, conversation_id) WHERE conversation_app IS NOT NULL;

CREATE TRIGGER envelopes_conversation_pair_insert BEFORE INSERT ON envelopes
WHEN (NEW.conversation_app IS NULL) <> (NEW.conversation_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'an envelope names a conversation by its app and its id together');
END;

CREATE TRIGGER envelopes_conversation_pair_update BEFORE UPDATE OF conversation_app, conversation_id ON envelopes
WHEN (NEW.conversation_app IS NULL) <> (NEW.conversation_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'an envelope names a conversation by its app and its id together');
END;
