# Conversations is a merge of two reads: one row per person, joined by address, and a part that is down is said, not hidden

Status: accepted. **Superseded in part by [0014](0014-conversations-is-split-back-into-inbox-and-meet-and-the-old-addresses-redirect.md): the one Conversations tab is split into Inbox (email) and Meet (chat); the merge below is what Today and People still use and what each tab's list is cut from.** Builds on
[0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md). The contract it implements is
`packages/workspace/src/rows.ts` (its header states the rule) and `inbox-for-space.ts` / `meet-for-space.ts`; this record is where
the front door explains why it merges the way it does.

## What is merged, and where

`GET /api/conversations` asks the inbox (`SpaceInbox.people`) and meet (`SpaceMeet.conversations`) at once, over service bindings,
each read given `ANSWER_WITHIN_MS`, and merges the two answers in `src/conversations.ts` (pure, no I/O). Nothing is stored. The
assertion the space received is handed to both unchanged and each verifies it again (workspace ADR 0001). The Worker never names a
person to an app.

## The rule

- **One row per person.** A person is what joined on a lowercase address (`normalizeAddress`, which the apps apply on the way out, so
  the space compares and never normalises). A row is anchored on a team person or a meet person; the inbox's contacts attach to it.
  A contact with several addresses joins on any of them. A teammate joins on BOTH their `address` and their `signIn` (meet knows them by
  the second, the inbox by either), so one teammate can have two inbox contacts and the row's `mail` is a list.
- **A contact joins whoever holds its address.** Two inbox contacts that shared an address would therefore be one row; the inbox keeps an
  address to one contact, so that cannot come from it. Two anchors (two meet people, or a team person and a meet
  person) are never merged with each other, and a contact that reaches two of them goes to the first. If two rows would still take the
  same key, the second's is told apart by its id, because the key is a React key and must be unique.
- **One row per channel**, from meet.
- **A row's time is its newest item from any source**, and its text and how-it-came are that same item's. A tie goes to the inbox.
- **A row exists only if it has an item.** A person with an address and nothing said is in People, not here. A direct message nobody has
  written in has no row.
- **Unread is a sum of two units.** The inbox counts conversations (it keeps no count of messages); meet counts messages. The row
  holds one number, and the badge says what it is made of (its tooltip and its label: "1 unread email conversation and 3 unread chat
  messages"), with one line at the foot of the list. A conversation two of one person's contacts are both on is counted once.
- **A thread with several people on it is listed once** (it was once "shown under each of them", and was changed). It is a row under the
  one OUTSIDE person who last wrote on it: the contact of the newest message that came in, and when people tie, or when nobody outside has written on it, the one with a display name
  over a bare address (`placedUnder`, `packages/inbox/src/store/placement.ts`). **"Outside" excludes the owner's own addresses (every Gmail account the owner connected, and the business mailboxes') and the
  team's**: they rank behind every outsider whoever wrote last, and own a thread's row only when no outsider is on it (an outsider writes to `tessa@northfield.example` and Tessa answers from
  `hello@northfield.example` with `support@northfield.example` copied: the conversation is the outsider's row, not a row for "Tessa"). The inbox says which person on each line it answers (`InboxThreadLine.listed`, always
  present: the inbox and the space ship in one Worker) and the merge keeps only the lines listed under a person. **Why:** a relay service puts one conversation on two addresses (a
  classifieds listing uses `<hash>@reply.listings.example`, no name, and `<hash>@sale.listings.example`, "Seller (Harbour Road roof box)"), and listing the thread under each
  gave the owner two rows for one conversation, one of them titled by a hash. **What did not change:** the row still names the others on its threads (`sharedWith`, "with ..."); a search
  that matches any of them still finds the thread (a hit is a conversation, not a row, and it leads with and opens the person the lists put it under); a person's own page and pane still
  hold every thread they are on, listed under them or not (the `everything` view does not apply the rule); and the left menu's counts still equal the rows, because `rowCounts` counts a
  conversation under its listed person only and `packages/space/test/nav-counts.test.ts` and `placement-parity.test.ts` hold the two together. **A Client's list is placed apart:** the rule holds for the Inbox, Unread, Bulk, Closed, Drafts and each mailbox, but in a Client's list a thread is placed among that Client's people only (the contacts linked
  to the Client on it), by the same rule, so a thread a Client's person is on is never lost from the Client's list because an outsider wrote last: it is the outsider's row in the Inbox and
  the Client person's row in the Client's list, once each (`InboxThreadLine.listedInClient`, `placeConversation`; the Client's count follows the same rule). The reply going to all is
  unchanged (ADR 0004). Today's waiting list was already one row per thread; it now leads with and opens the person the lists put the thread under.

## The filters

The main list is the inbox's open, non-Bulk conversations **of every mailbox**, with direct messages and channels, as the inbox's own
Inbox view and the contract's header have it. Two more lists are asked for by name: **Bulk** (`include: ['bulk']`, open Bulk of every
mailbox) and **Closed** (`include: ['closed']`), which are out of the main list. **Each business mailbox is a chip that
narrows the list to it** (open, non-Bulk, that mailbox, from the mailboxes the inbox's answer shows, with its unread count); its
conversations stay in All. Bulk, Closed and the mailbox lists are mail only, so they do not ask meet. All, Outside and Team are cuts of the main list, made in the
page.

**A business mailbox stays in the main list.** A business mailbox's customer mail must sit beside everything else, or the owner
misses a customer; so a row whose newest mail came to a business mailbox says which one (a tag with the mailbox's name), and the chip
is only a narrowing filter. A person with mail in both Gmail and a business mailbox is one row in All, counting both; narrowed to the
mailbox, the row counts and times that mailbox's mail alone. (An early version kept business mail out of the main list
on a misreading of the filter rule; the contract and the inbox's Inbox view had it right.)

## One part down, the other shows

A read that throws, hangs past `ANSWER_WITHIN_MS` or answers a shape that is not the contract's (checked, never half read) is
`could-not-be-reached` with its reason; the other part's rows are on screen and a line says which part is missing, in a warning colour.
An app that answers **no** (`Refused`: not admitted, not signed in) is `not-open-to-you`, drawn quietly with a lock: nothing is down, and
the page does not say it is. The reads wait for no longer than the contract's four seconds each, in parallel, so the list is as slow as
the slower part and never slower than that. A thrown error's message is never passed to the page.

## What a row opens

A row opens that person's or channel's conversation in the space, at `/conversations/<its key>`
([ADR 0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md)). It once opened in a new tab in the app of
its newest item (the row's `opens` field, now gone). A search hit still opens its email in the inbox.

## Live updates

- **Chat** comes over meet's socket. The page asks `GET /api/live` (meet's `ticket`, which the Worker checks has `socketPath` under
  meet's socket route) and opens that path on the **space's own origin**; the Worker hands the browser's upgrade request to meet through
  the binding (`MEET.fetch`) as the same upgrade request, built afresh with the same URL, method and headers, so meet's own-origin check passes. A frame means only "read the list again" (debounced); a frame
  never edits the list. The ticket is a GET so that nothing else on the space has to accept a write; it is spent on first use and its answer is
  never cached. The forwarded request has no Cookie: meet opens the socket by its ticket and reads no cookie, and
  the space forwards to its apps without cookies ([ADR 0002](0002-forms-is-a-frame-on-its-own-admin-with-a-day-long-sign-in-of-its-own.md)). It keeps the Upgrade, Origin and Sec-WebSocket headers, and the assertion header the Worker already verified.
- **Mail** has no stream through the entrypoint, so the list is read again when the page is shown again and once a minute while it is
  visible, as the inbox's own page does for its mail (it also depends on no push). The cost is one read of the inbox a minute from an open
  tab.
- Only the socket's own path reaches meet: the binding's `fetch` serves nothing else, and the space routes nothing else to it.

## What is not decided here

- Whether the inbox's own `QUEUE_PAGE` (200) is enough for the main list: past it the list has a Load older control at its foot, which reads further ([0022](0022-a-list-reads-further-by-a-position-and-a-view-is-narrowed-before-it-is-cut.md)).
- Conversation view, reply, mark read: ADR 0004.
- Chat search: when meet has one, the search box gains a chat source; until then the results say chat cannot be searched yet.
