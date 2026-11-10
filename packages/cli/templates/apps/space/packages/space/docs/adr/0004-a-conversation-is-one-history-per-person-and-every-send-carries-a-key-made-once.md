# A conversation is one history per person; every send carries a key made once, and a send the space loses track of is never offered again

Status: accepted. **Superseded in part by [0014](0014-conversations-is-split-back-into-inbox-and-meet-and-the-old-addresses-redirect.md): a conversation opened in the Inbox is the person's emails and one opened in Meet their direct message or a channel, no longer one history; the compose keys and "never offered again" below stand.** Builds on
[0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md) and on the contract in
`packages/workspace` (`inbox-for-space.ts`, `meet-for-space.ts`, `asking.ts`). Nothing in the contract or in the inbox's and meet's
entrypoints changed.

## What opens, and how it is found

A row opens at `/conversations/<its key>` (the key `rows.ts` fixes: an address, `mail:<contactId>`, `chat:<personId>` or
`chat:channel:<n>`). `GET /api/conversation?key=` finds the row again by running the list's own merge over **every** conversation the
inbox has with the person (open, closed or Bulk: `View` gains `everything`, which no list can ask for) and meet's overview, scoped to the
address when the key is one (and to both of a teammate's addresses). So a row opened from Bulk or Closed is there, and the name, side,
business and chat side come from the one merge, not a second reading of them. Then the history: `messagesWith` for each of the row's inbox
contacts, meet's `history` for its direct message or channel, and `drafts`, in parallel, each given `ANSWER_WITHIN_MS`. A source that does not
answer is said in a line and the other's history shows; a key that no row has is a 404, and one that cannot be looked up because a part is down is a 503 that says which.

## One history

Emails and direct messages are merged by time (`src/history.ts`, pure). The two apps page their own history by the id of the oldest message
held, and a page of mail and a page of chat reach back different distances, so showing both as they came would put old mail beside a chat
that stops yesterday with the chat between missing. **The merge shows only as far back as every source that has more has been read**; what
is older is held and appears when the source that stopped first is paged. "Earlier messages" pages exactly those sources. An email that two of
a person's contacts are both on (a teammate known by two addresses) is one entry. Each email sits under a heading with its subject and, on a
shared thread, "with" the others; the thread is in the history of every outsider on it, though the list has a row for it under only one of them (ADR 0003).

## Who a reply goes to

An outside person is answered by **email**, in the thread the sender chooses (the newest open one until then), through `send`'s reply variant.
A teammate is answered by **direct message** (`post`), and by email only when they have no direct message. A channel is a post. Someone with
both an email thread and a direct message (a channel guest who also emails) opens on email, with a one-tap switch to a direct message:
email-only people get email, and chat-only people get chat. The default thread is the **newest open one** (open before closed, newest first within each; the order comes from the newest message of each thread in
the history, since the contract's thread has no time of its own). A teammate or channel guest meet lists a direct message with that has nothing in it yet
is written to by `personId` (meet opens the direct message as it posts); someone meet does not list at all cannot be named by the space and gets email only.
A text or a note cannot be answered by the inbox (`canReply` false), so the box says so (and that Claude can draft a text, which is sent by hand and marked sent here). A new email to an address with no thread is not here: it needs a subject, and is the inbox's compose.
**A thread with other people on it is answered to all of them** (`copyEveryone: true`); the line over the box says so by name. The page
decides this from the thread it was shown, and the inbox applies it at send. A row that joins two of the inbox's contacts (a teammate known by two
addresses) never names one of them as "also on" the other's thread: the answer drops the row's own contacts, or it would read "Reply all to Priya and Priya".

## The compose key, and what a person is told

Every compose carries one key, made by the page when the compose begins (`crypto.randomUUID()` without its dashes) and kept until the message
has gone. A double press, a refusal followed by Send, and a repeat after the page lost track all carry the same one, and the apps do the rest
(contract, `COMPOSE_KEY_KEPT_MS`). Each outcome has its own words (`src/client/compose.ts`, one function per case):

- **sent**: the compose is finished, a new key for the next message, "Sent." If the inbox says `sending` (Gmail never said), a warning to check Sent.
- **repeated**: the first send's result, "That was already sent the first time. Nothing new went out." (or still being sent, or Gmail never said).
- **refused**: the app's own words ("A new message arrived in this conversation. Read it, then press Send again."), the text and the key kept, Send
  ready. On a conflict the page also reads the conversation again, so the new mail is on screen and the reply names its new position.
- **failed** (`broken`: the app knows nothing went out): the same, after "Nothing was sent."
- **outcome unknown**: the binding threw, nothing came within `WRITE_WITHIN_MS`, the answer was not the shape the contract says, or the Worker
  itself failed after it may have sent (a 5xx, a dropped connection). **There is no Send**, only where to check (Sent in the mail, the
  conversation) and "Write another message", which makes a new key. The Worker never retries a write.

## The Worker accepts three writes, as POSTs on their own paths

`/api/email`, `/api/chat` and `/api/read` are the only POSTs; everything else is still a 405 (the Forms tab aside). The Access cookie rides on any
request a browser makes to this host, including one a page elsewhere makes, and the edge then adds the header this Worker trusts. So a write
must also carry this host's own `Origin` (a browser always sends one on a POST), be `application/json` (a form on another site cannot send it
without a preflight this host refuses) and be under 400 KB, **read with a cap** (a chunked body has no Content-Length to refuse early, and one that lies about it
must not be read to the end: past the cap it is a 413 and the rest is not read). The sign-in check still runs first, so no sign-in is a 401 at every method and path.
As defence in depth the space's whole-host Access application sets its session cookie `SameSite=Lax` (`space-access`, ADR 0002), so a browser does not carry it
on a cross-site POST at all.

## Opening marks it read, in both apps: what is on screen, and no more

`GET /api/conversation` changes nothing. It carries the marks (`read`). `messagesWith` answers every thread the person has at its current position, but
the history shows only the newest page, and only as far back as every source with more has been read; marking every unread thread would mark read in
Gmail an email hidden behind "Earlier messages", or thirty Bulk threads older than the page, that nobody saw. So **a thread is marked only if one of its
messages is among the entries drawn** (a page is the newest messages, so one drawn means its newest is), at the `through` of this answer; and the chat is
marked only if a chat message is drawn, up to the newest drawn. The page posts them to `/api/read` once the conversation is on screen and the tab is
visible, once for each position (a message that arrives while it is open is a new one). The inbox marks read in Gmail as it does today. If mail arrived
after the position read to, the inbox refuses that thread (`conflict`) and the page reads again so the new mail is seen first. One app's trouble never
stops the other's mark.

## Drafts

Drafts on the person's threads, or addressed to their contacts, sit **in their own thread at the time they were made** (Claude's reply to a thread
follows the message it answers, under that thread's heading; a draft on no thread is a run of its own, "Draft to <name>"). A draft is never held back by
the paging cutoff: one waiting on the person is always on screen. The card says who wrote it (Claude, the assistant, the owner), **To with its address and every
Cc with name and address**, what it says, **Send as it stands** (the held-draft variant, with the revision shown and the thread's `through` from this answer,
with a key of its own) and **Edit in the inbox** (a link: the contract has no way to edit a draft).

**A held-draft send goes to everyone the draft names, so the card shows everyone.** A draft Claude made with `copyEveryone` carries a Cc, and a card that
said only "To Dana" would have sent the email to Marcus unseen. The contract's `InboxDraft` therefore carries `cc` (names and addresses; `to` was already the
address), the inbox fills it from the draft row's Cc header (the name the header gave, else the one the inbox knows, else the address; an entry that is no
address is kept as written, so a Cc is never shortened), and **the space keeps a fail-safe**: a draft whose answer has no `cc` at all (an inbox that predates
the field) is `cc: null`, not sendable from here, and offers Edit in the inbox only. A send Gmail never confirmed is shown with no way to send it. A draft
on a thread this answer does not hold is not sendable from here.

## Live

Chat arrives over the live socket: its frame already means "read again" (debounced), and the list's reading again bumps a counter the open
conversation also reads on, quietly, merging the fresh newest page with the older pages already paged back (`refreshSources`) so nothing the
person scrolled to disappears and no gap opens. Mail is read again when the page is shown again and once a minute, as for the list. A refresh that fails
leaves what is on screen.

## What is not here

The People fields (business, role, notes) are in a later record (0009); the profile is the inbox contact (name, addresses, Client) or the company layer's person.
Huddles, calls and the call link (0009), and document cards (0010), are in later records too. Editing a draft, a new email to an address with no thread, a direct message to a person meet does not list, and meet's channel members
need the contract to grow and are not faked. A search hit still opens its email in the inbox, since a hit names a conversation and not a person.
