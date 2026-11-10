# Knowledge is the fifth tab, and the only place knowledge changes

> **Amended by [0015](0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md):** the knowledge app runs in the space's Worker and its store belongs to it; the Knowledge tab calls it in-process with the person the one sign-in check named, and there is no `SpaceKnowledge` entrypoint or `KNOWLEDGE` service binding. Where this note says either, read it as it was before that.

Status: accepted. **Supersedes [0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md)'s "four tabs"**: the space has five (six since [0014](0014-conversations-is-split-back-into-inbox-and-meet-and-the-old-addresses-redirect.md), which splits Conversations into Inbox and Meet), and `TABS` in the company layer
(`packages/workspace/src/install.ts`) is the one list. The knowledge app's own decision is `packages/knowledge/docs/adr/0001`; the inbox's is `packages/inbox/docs/adr/0002`.

## What is added, and where it sits

- **A fifth tab, Knowledge, after People:** down the side on a computer, in the strip across the top on a phone, in every install (the tab list is the same in every install, and an install with
  no knowledge app behind it shows the tab saying Knowledge could not be reached, as any part that does not answer does). The strip of five and the
  gear fits at 390 pixels: each takes about 65 pixels and "Conversations" shortens to an ellipsis, as the strip already allows.
- **One knowledge base for the organisation, with a row of choices at the top:** All, then each business of the company declaration (for example Northfield Works and a second business the install declares, Harbour Supply). Picking one shows exactly what that
  business's assistant reads (its active entries) with the waiting and removed ones marked for it beside them. The choice is in the address (`/knowledge?business=<business-id>`), so it can be bookmarked and
  the back button undoes it. The base is read whole once and filtered on the page, so a proposed change always has the entry it would change at hand to be compared with, whichever business is chosen.
- **Each entry names its businesses** as small pills, and a change of businesses is a version: History says "Now for Northfield Works and Harbour Supply (was Harbour Supply)", with who and when, because it decides which
  customers an assistant tells the entry to. Adding an entry asks for a title, the words and at least one business (the button waits for one); "Every business" ticks the declared businesses and what is stored is that
  list, so a business added later starts with none.
- **A proposal gone out of date is marked and can only be rejected.** Claude's proposed change records the version of the entry it was written against. If the entry has since been changed (its words or its
  businesses), is not active, or is gone, the card says **Out of date**, offers Reject and History and nothing else, and says why: approving it would put an old price back or a business back that the owner took off. The
  knowledge app refuses the approval as a conflict as well; the page does not offer what the app would refuse.

## The only place knowledge changes

The Knowledge item under each mailbox in the Conversations tree and the "Knowledge base" section of Settings are gone, and the inbox's own Knowledge page is one line linking here. An entry added
or changed anywhere else would be a second place to look for what an assistant says to a customer.

## How the tab is asked

`GET /api/knowledge` and `POST /api/knowledge` are one call each to the knowledge app's `SpaceKnowledge` entrypoint over the `KNOWLEDGE` service binding, with the assertion the request arrived with, which the
app verifies again against the space application's audience before it admits the install's owner and nobody else (the company layer's ADR 0001: no service token, no teammate). The space stores nothing.
A read waits four seconds and, unanswered, shows the tab as could not be reached with a way to try again, while the other tabs keep working; a write is never retried, and one the space lost track of is
"it may have been done: look, and do not press it again until you have", as every write here. An answer that is not the contract's shape is never half read.

## Why not the alternatives

- **A section of Settings** (where it first sat, [0005](0005-the-inbox-s-other-views-come-in-the-sender-serves-both-kinds-of-device-and-the-old-address-moves-people-only-when-told.md)): Settings is the inbox's other views, and the knowledge base is no longer the inbox's. A place of its own is where the owner looks for what the assistants say.
- **A tab per business:** three tabs where one row of choices does, and an entry marked for several would appear in each.
- **Filtering on the server:** the contract allows it (`knowledge(assertion, business?)`) and Claude's script uses it, but the page needs the whole base to judge whether a proposal is out of date.
