# A lead is a request on a contact, kept in the inbox's store

Status: accepted. The board, a person's leads and a lead made by hand are built here; the door a company's site sends requests through and the notification of a new lead are the next step, over the same store method.

## Context

A company that takes requests on its own site (a quote form, a booking form) wants them where it works the people who sent them: beside their mail, on their page, on a board by stage. Kept on the site, the same person is worked in two places, and every company that wants a pipeline builds one again.

## Decisions

1. **A lead is its own record on a contact, not a mark on the person.** What they asked for (the company's fields), its stage, where it came from, when, and who moved it last. A person can have several over time; a second request while one is open is folded into it (one more request, the newest values over the old, a blank never over a value), and a request after it is settled is a new lead.
2. **It lives in the inbox's store** (migration 21, `lead` and `lead_request`), because a lead hangs on a contact and contacts are the inbox's: a merge moves the absorbed contact's leads to the survivor and names them in its audit entry, and its undo moves exactly those back. No foreign key to `contact`, for the same reason the merge needs to move them first.
3. **The stages and the fields are the install's** (the declaration's `leads`, the `leads` switch): stages in order, at least one open and one settled (one settled stage, or won and lost apart: the company's choice), fields by key. The store keeps ids and keys and knows no words; the part checks every stage and field against the install before it writes.
4. **A lead belongs to a mailbox, and whoever is on it sees and works the leads**, the owner always: the same rule as the mail (ADR 0004), cut by the person's scope in every read and write. The mailbox is kept on each lead by its address, so a lead stays with the mailbox it was made in.
5. **A request from a site is matched to a person by its email address, else its number** (the inbox's one spelling of each); a blank or a number the inbox cannot read keys on nothing, and a request with neither is refused, so numberless requests never fold onto one person. The site's own id for each request is kept (`lead_request`), so a send repeated after a lost answer changes nothing.

## Consequences

- Migration 21 is one-way as every migration here is: bookmark before the deploy; an undo build keeps migrations 12 to 21. It adds two tables and touches no row.
- A stage taken out of the declaration later leaves the leads that hold it as they are; the board draws such a stage under its id after the declared ones.
- Won becoming a Client is not built: a won lead stays a contact.
