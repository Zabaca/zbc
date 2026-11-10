-- forms: the Client a signing-settings row belongs to (the space's ADR 0021).
--
-- A Client is the space's, and has a number there. A row of this table keeps its text id for good (14 tables point at it, every event's hash includes it, every signing email loads the logo by it); it becomes that Client's
-- SIGNING SETTINGS (short name, reply address, copies, colour, logo, time zone, years kept) by carrying the Client's number. NULL is a row made before this: it keeps signing exactly as it did, is listed in Forms as "not linked to a Client",
-- and is linked by hand (Link, or Make a Client). Nothing is matched by name.
--
-- ADDITIVE, so it is safe to apply before the code that reads it and while the old code is still running (which ignores the column): one nullable column and one index, no row touched, no id changed. At most one row per Client.
ALTER TABLE clients ADD COLUMN client_number INTEGER CHECK (client_number IS NULL OR client_number >= 1);
CREATE UNIQUE INDEX clients_client_number ON clients(client_number) WHERE client_number IS NOT NULL;
