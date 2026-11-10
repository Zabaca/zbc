-- The forms service: the typed-name-only mode for a signature.
--
-- 1 when the signer may adopt a signature or initials only by typing their own name into a blank field: no drawing, no
-- picture. For a consent the IRS rules ask to be signed that way (Rev. Proc. 2013-14 sec. 6.02): a drawn or uploaded
-- signature is not a valid method there. Set by the operator at Send, like `sensitive`, and never changed after the send.
ALTER TABLE envelopes ADD COLUMN typed_only INTEGER NOT NULL DEFAULT 0 CHECK (typed_only IN (0, 1));
