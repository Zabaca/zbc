# Conversations is split back into Inbox and Meet, and the old addresses redirect

Status: accepted. The owner's call: keep Chat / Channels / Calls and Phone as a Meet top-level tab, do not combine them into Conversations, and rename Conversations back to Inbox.
**Supersedes [0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md) and [0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md) as
the shape of the two tabs**: a tab no longer holds email and chat together. The merge (`mergeConversations`) and the rows (`PersonRow`, `ChannelRow`, ...) are unchanged and are what both tabs are drawn
from; People and Today still merge across both, since a person is one person. Supersedes [0008](0008-knowledge-is-the-fifth-tab-and-the-only-place-knowledge-changes.md)'s "five tabs": the space has
six, and `TABS` in the company layer (`packages/workspace/src/install.ts`) is the one list.

## What is true now

- **Six tabs, in order: Today, Inbox, Meet, Forms, People, Knowledge** (`/inbox`, `/meet`). The tab ids are `inbox` and `meet`; `conversations` is gone from `TABS` and from the declaration's tab ids.
- **Inbox is email alone.** Email conversations, Drafts (and the drafts on no conversation), the inbox's views tree under it (Inbox, Unread, Drafts, Bulk, Closed, mailboxes, Clients, Contacts),
  Client pills, search over mail, New email, Close, Mark as spam, Send for signature. No channel, direct message, call or Phone row is in its list and no chat part is asked for or named: the list is
  `GET /api/conversations?scope=mail`, which asks the inbox alone, and a conversation opened in it is `GET /api/conversation?key=&scope=mail`, which holds the person's emails and no direct message.
- **Meet is chat, calls and the Phone.** Channels, direct messages, the Phone conversation and calls with no conversation as rows (`?scope=chat`, which asks meet alone), New call, New message, New
  channel and Browse channels, the live socket (opened by Meet's list only, so the Inbox opens no socket), and a menu of its own: **All, Chat, Channels, Calls** and, for a person who has a Phone
  row (or a browser phone set up), **Phone** (a tree under Meet on a computer, a sheet from the button above the list on a phone). The views are in the address (`/meet?view=channels`); Calls is
  the past calls' own list (`CallsList`). A conversation opened in it is `scope=chat`: the channel's or the direct message's history and the chat reply, no email, no Send for signature.
- **The components are the ones that drew them inside Conversations**: `Conversations.tsx` draws either list by `scope`, `Conversation.tsx` either conversation, and `CallPane`, `PhonePane`,
  `Channels`, `NewMessage`, `CallsList`, `NewEmail` and `DraftPane` are the same files, with their paths and Back links pointed at their tab.
- **Two keys name one person in both tabs.** A person with email and a direct message is a row in each tab under the same key (their first address); the Worker finds the row by that key or any
  address it holds, so `/inbox/<address>` and `/meet/<address>` are both there. A person with only one side is not found in the other tab: the pane says so and points at the other tab.
- **People shows both.** A person's page has **Open email** (to the Inbox) and **Open chat** (to Meet), each only where something has been said on that side (`PeopleEntry.said`).
- **Today opens each row where the work is**: mail, replies and email drafts in the Inbox, direct messages, the Phone and a meeting made in a direct message, a channel, or no conversation in
  Meet. A meeting made from an email conversation, and a signed document, open in the tab the conversation is in (`conversationTab`, from the ref's app).
- **Notifications**: the inbox sends mail, so a tap opens `/inbox/<address>`, and a summary or the test opens `/inbox`.

## Every old address lands on the same thing

`/conversations`, `/conversations/<key>` and `/conversations/draft/<id>` were linked from bookmarks, notifications, links in drafts the assistant had written, Today, and meet's emails and `/start`. The Worker
answers each with a **302 to the new path, query kept** (`src/legacy.ts`), behind the same sign-in as everything else:

| Old | Lands on |
|---|---|
| `/conversations`, `/conversations?view=bulk` | `/inbox`, `/inbox?view=bulk` |
| `/conversations?view=calls` | `/meet?view=calls` |
| `/conversations/<address>`, `/conversations/mail:<contact>` | `/inbox/<same>` |
| `/conversations/draft/<id>` | `/inbox/draft/<id>` |
| `/conversations/chat:channel:<n>`, `/conversations/chat:<person>`, `/conversations/call:<name>`, `/conversations/phone` | `/meet/<same>` |

A 302 and not a 301, so no browser keeps the old answer for good. **The redirect is kept for good**, not for a migration cycle: the old addresses sit in mail already sent (meet's nudge emails said `https://space.northfield.example/conversations`) and in notifications and bookmarks that nobody will ever re-make. A bare `/conversations` from an old nudge email, which was about unread direct messages, lands on `/inbox`, not on Meet: the bare list was the Inbox's, and the redirect cannot tell what the mail was about. The new nudge says `/meet`. An address that was a direct message with a person who has no email lands in the Inbox, finds nothing, and the pane says "If it
was a chat, it is in Meet" with the link. meet's `/start` now redirects to `/meet`, and its nudge, voicemail and 911 emails link to `/meet` and `/meet/phone`.

## Why not the alternatives

- **One tab with a switch (Email / Chat) at the top**: it is what Conversations was, under another name; the owner asked for the two to stop being combined.
- **A 301**: a permanent answer is kept by browsers, and the Inbox and Meet are one decision away from moving again.
- **Keeping `/conversations` as an alias that draws the page**: two addresses for one thing, and a link that never learns the new one. A redirect makes every link, whenever it was made, end on the new path.
