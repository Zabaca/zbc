# The inbox's other views come in; the sender serves both kinds of device; the old address moves people only when told

Status: accepted. Builds on
[0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md) and on the contract in `packages/workspace`
(`inbox-for-space.ts`, and its new `inbox-views.ts`). The three constraints below are the owner's.

## Where they sit

**The inbox's views, mailboxes and Clients sit as a tree under Conversations, and rows carry Client pills.** This replaces
an earlier placement (filters on the list plus a settings menu) of the inbox's views.

- **A tree under Conversations in the rail** (while that tab is the page), shaped like the inbox's own left menu: **Views** (Inbox, Unread, Drafts, Bulk, Closed, each with the inbox's
  count and, in the accent, how many are unread); **Mailboxes** (each business mailbox with its count, and its Knowledge base under it); **Clients** (each Client with its open
  conversations); **People** (Contacts, which is the People tab); and **Settings at the foot** with the lines the inbox says there (Gmail live and its last push, each mailbox's last mail,
  amber when one needs a look). Picking an item narrows the list: the view is in the address (`/conversations?view=bulk`, `mailbox:<id>`, `client:<id>`, `unread`, `drafts`), so the tree and the
  list agree, a link keeps it, and opening a conversation keeps it. **The Bulk, Closed and mailbox chips are gone**; All, Outside and Team stay as three small chips because the menu has no
  equivalent. On a phone, where the rail is a strip of tabs, a button above the list names the view and its count and opens a **sheet** with the same items and Settings.
- **The counts are the inbox's own, in the list's unit** (a count that disagreed with its list, "Inbox 7" over a list of 4 rows, read as a fault). They come from one read, `navigation`, and are counts of
  ROWS: a row of the list is a person, so a person with two open threads is one row, and a thread two people are on is a row under one of them (a row under each at first, ADR 0003). They were first counts of conversations with a note
  under them saying so; a note under a badge does not make a number that disagrees with its list read right. The inbox counts them over every conversation (`src/store/row-counts.ts`), not cut
  to the newest screen the lists show, so past that screen a count can be larger than the list. A Client's number is the people linked to it on its open conversations, a thread being placed among the Client's people only (ADR 0003).
  **A view lists what its count counts:** Drafts asks for every conversation with a draft, open, closed or Bulk (`/api/conversations?view=drafts`); a Client asks for its open
  conversations, Bulk included (`?view=client`), and the page keeps that Client's people; Unread is, like the Inbox, open mail that is not Bulk, and its count is email conversations while the list
  also keeps people with unread chat (the tree says so). A draft on no conversation is in no row (the count has it, the list cannot). A sheet's items are places: Inbox from another view goes to the
  main list, not back to the view it left. **Contacts**, before the People tab holds them, opens the inbox's own contacts in a new tab (`/?go=contacts`) and says the People tab replaces it.
- **Client pills on rows**, as the inbox's own rows have them: a person linked to a Client shows its name as a small pill (one for each Client their addresses belong to), and the line under
  the name is then who they are (their address). The inbox's dashed "?" pill for a Client it only *suggests* is carried too: `InboxPerson.suggestedClient` is the inbox's own
  suggestion for a contact with none linked, display only, read as none from an inbox that predates it and absent while the site's Client list does not answer. Confirming a link stays in the
  inbox (the Client's page in Settings lists the suggestions with Link) until the People tab takes it over.

## What came in, and who may do it

Settings (notifications, Claude's sending switch, the mailboxes and the spam check, the Gmail connection, restore), the knowledge base, Clients, and the draft chat on every
draft the space shows. Each view is one method of the inbox's `SpaceInbox` (twenty new ones, the menu's `navigation` among them) that calls the very
store or module method the inbox's own route calls, with the owner as the actor, so every rule of that route stays; the space adds none and removes none. **Every write is the owner
acting through the owner's verified assertion**: the inbox verifies it again against the space application's audience and admits its owner only; a service token is never admitted; and the
switches, restore and the knowledge base refuse any actor but the owner's address in the store as well. **Claude's sending switch is the owner's to flip and never Claude's**: the space has no path
that acts as Claude, and Claude's script reaches the inbox on its own address with its own token, which is unchanged.

The Worker carries them as `GET /api/inbox/<read>` and `POST /api/inbox/<write>` (`src/views.ts`): one call each, the assertion passed along unread, the answer checked against the
contract's shape before the page sees it (never half read), a read given `ANSWER_WITHIN_MS`, a write `WRITE_WITHIN_MS` and **never retried**. A write the space loses track of is
`outcome-unknown`, and the page says to look and offers no second try, as for a send.

## No compose key, and what makes each write safe to repeat instead

A compose key exists so that something that goes out goes out once. None of these writes sends anything. Each is made safe another way, written once in
`packages/workspace/src/inbox-views.ts`: the two switches and linking a Client set a value (twice is once); an edit, removal, approval or rejection names the version of the
knowledge entry the owner was shown, and one over a screen that moved on is `conflict`; a device is added by its push address; a restore names a one-time token and must send the token and the
bookmark back; a chat turn names the draft and the revision shown, so a second press after the first revised it is `conflict` and the model is not asked again; and adding a
knowledge entry is refused as `conflict` when an active entry on that mailbox already says the same (`SpaceStore.addKnowledgeOnce`, one transaction), which is the one write that
had nothing of its own to stop a repeat and is why the add is not the inbox page's `addKnowledge`.

## Restore asks, and the knowledge base is read before it is changed

Restore is the inbox page's two steps, unchanged and in the same words: the first call resolves a time or a bookmark and answers a token and changes nothing; the page then shows what would be
replaced, that sent mail will look unsent ("do not send them a second time") and that Gmail may need reconnecting; only a second press, "Yes, restore the store", makes it, sending back the
token and the bookmark it named. The method asks for the object's restart afterwards in a call of its own, as the route does, and nothing else asks for it. Turning Claude's sending on asks
once in the page; turning it off does not. A removal of a device, of a knowledge entry, and a disconnect of Gmail each ask. Nothing asks in a dialog: the viewer shows none.

## Notifications: two kinds of device, one sender, no gap

A device's notifications are tied to the sender's key and the page that subscribed. The space subscribes with the **inbox's own public key** and hands the subscription to the inbox, which
marks it as the space's. The inbox's sender then serves both kinds, with one payload for each (`deliver.ts`): the inbox's is exactly what it was; the space's also carries the sender's address,
which the space's service worker opens as `/conversations/<address>` (a summary and the test carry none and open the list). The space's worker keeps nothing and answers no request.
**So the move cannot leave the owner without notifications**: the old device keeps working until the owner removes it, from the space's Settings, once the space is turned on on that phone
or Mac; until then an email notifies both (twice), which the page says. A link that names one of a person's addresses opens their conversation even when the list keys the row by another.

**The origin is a row of `setting`, not a column.** A migration would be one-way (an older Worker refuses a store a newer one migrated), and a rollback of the notification sender is the one
thing that must stay possible. The row is read by name only, so an older Worker ignores it and sends the inbox's payload; the tap then opens the list. The row goes with the device.

## The old address moves people only when told, and only the page

`apps.inbox.sendPeopleToSpace` in the declaration is `false`; deploying the views moves nobody. On, a person's browser asking for the bare page (`/`, `/index.html`) is sent to Conversations.
Never redirected: all of `/api` (Claude's script, and the Gmail connection's paths, because Google returns to a fixed address and the check cookie is set on the address the connection starts from),
`/sw.js`, the manifest, icons and assets (so a device that has the inbox installed keeps receiving notifications and its worker keeps updating), `inbox-push.<your-domain>`, Claude's token, any write,
**any fetch that is not a top-level document navigation** (the installed app's worker fetches `/` itself to keep its shell, and a cross-origin redirect there would make every new worker fail to
install: only `Sec-Fetch-Dest: document`, or `Sec-Fetch-Mode: navigate` where no destination is sent, is redirected), and **a root that names a conversation or the contacts** (`/?c=`, `/?go=contacts`): an inbox device's notification tap, and the space's own "Edit in the inbox". The space does not do everything the inbox's page does (a draft
editor, a new email, mark as spam, merging contacts are not among the views the space carries; Close and Reopen came to the conversation later), so those stay one tap away rather than behind a redirect that sends the person back.

## Rejected

- **A column for the origin**: see above.
- **Notifying a space device from the space's own sender**: a second sender is a second key and a second rule for which mail is owed one (no second notification system).
- **Redirecting every path but `/api`**: breaks an installed inbox app's worker updates and the tap on its notifications, for no gain.
- **A compose key for knowledge adds**: the key store is shaped by sends; the content check is smaller and says why in words.
