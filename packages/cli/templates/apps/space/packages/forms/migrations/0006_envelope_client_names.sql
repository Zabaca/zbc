-- forms: the business's names as an envelope was sent (a follow-up to the Client link; the space's ADR 0021, section 6).
--
-- A client row's name and legal name are a COPY of its Client's, which the Clients part rewrites when the Client is renamed. The consent a signer is shown, its terms PDF and the certificate of completion print them, so a finished
-- envelope's web certificate would drift from its sealed PDF after a rename. The envelope keeps the two names it was SENT under, taken from the row in the same batch as the send, and prints those. Written once by send, never by anything
-- else, and in no event: every event is sealed into the PDF a signer receives, and no hash changes.
--
-- NULL is an envelope sent before this (or still a draft): it prints the row as it is now, and the certificate's consent note says so when the business was renamed since a signer agreed. Both are set together or neither is.
--
-- ADDITIVE, so it is safe to apply before the code that reads it and while the old code is still running (which ignores the columns): two nullable columns, no row touched.
ALTER TABLE envelopes ADD COLUMN client_legal_name TEXT CHECK (client_legal_name IS NULL OR length(client_legal_name) BETWEEN 1 AND 120);
ALTER TABLE envelopes ADD COLUMN client_display_name TEXT CHECK ((client_display_name IS NULL) = (client_legal_name IS NULL) AND (client_display_name IS NULL OR length(client_display_name) BETWEEN 1 AND 80));
