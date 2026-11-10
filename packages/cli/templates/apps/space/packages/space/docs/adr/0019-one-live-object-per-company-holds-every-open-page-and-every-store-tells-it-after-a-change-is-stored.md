# One live object per company holds every open page, and every store tells it after a change is stored

Status: accepted. The reason for it: the page should stop polling.
**Amends [0016](0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md)'s team socket** (it is gone: a teammate's page no longer opens a socket on meet's Workspace object) and the lists' "read again every minute" ([0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md)). The sign-in rule is still the company layer's [ADR 0003](../../../workspace/docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md).

## Decision

**One Durable Object class, `LiveDO`, one object per company (named `LIVE_NAME`), holds the one WebSocket of every open team page.** It is hibernating, as meet's are: an idle page costs nothing and the page's ping is answered by the runtime without waking it. It holds **no store**. It knows which people have the space open and, when a store tells it, sends each of those people's pages a frame. A frame names a **part** (mail, chat, calls, documents, knowledge) and, when exactly one conversation changed, the **conversation's key**; it never carries what changed, and it never names a call (a call's name is its link).

**Every store tells it after the change is stored, never before, and a failed tell never fails or slows the change.** `tellLive` (packages/workspace/src/live.ts) starts the message and returns at once; where the object is not bound, is down or refuses, the reason is logged and the message dropped. A Worker request is kept alive for the message with `ctx.waitUntil`; a Durable Object has none and needs none.

| Store | Where it tells | Part | Who |
|---|---|---|---|
| The inbox | `InboxDO.call` after a call on `CHANGING_CALLS` (a sync, a Cloudflare arrival, a send, a read mark, a close, a draft written by Claude or the assistant, a contact saved, a bounce, a restore's arming), after the alarm, and on every start of the object (where a restore takes effect) | mail | the owner who signs in as the inbox's owner |
| Meet's Workspace object | `flush`, after each change it already sends to sockets, naming the teammates (guests keep their own sockets) and each one's key for the conversation | chat | the conversation's teammates |
| A call's object (`RoomDO`) | `invoke`, when who is in the call changes (counted before and after without dropping anyone, so a person a later call drops is seen to go) or a call is made; and its alarm, set when someone joins, which drops whoever has been quiet for 30 seconds and tells (the last person to go is followed by no other call) | calls | everyone with the space open |
| Forms | the `Db` every write goes through (`watched`, packages/forms/src/live.ts): after each committed batch, which is every envelope event, and the hourly sweep | documents | the install's team |
| The knowledge store | `KnowledgeDO.call` after a change or a proposal | knowledge | the owners |

**The page holds one connection per tab**, in the shell (`LiveProvider`, src/client/liveHub.tsx), whichever tab the person is on. A screen says which parts it draws (`useLive(parts, handler)`) and is called, once for a burst, when one moves; the screens on view are the screens mounted. **An open conversation is read again only when the message named it or named none** (`readsOpen`). On **reconnecting**, every screen on view reads again; on **being shown again** each screen reads (as before), and the **60 second read is ten minutes**, the net for a lost message. Today, the Inbox and Meet lists, the menu's counts, the chat unread count in the title, People, the Knowledge tab and the Forms envelope screens subscribe; a conversation's call card no longer polls for who is in the call (its clock still ticks).

**The sign-in check is the one per request.** `GET /api/live` is behind the same check as every team path, same-origin only (a socket's Origin must be this site's), and the Worker hands the object the person's sign-in address and the end of the Access assertion it verified. The object trusts those two headers because only the Worker reaches it. **The socket closes when the sign-in ends**: an alarm cuts off every socket whose assertion has passed (close code 4401, which the page reads as "go quiet"; its reads show the sign-in notice).

**Meet's nudge asks the live object who has the space open** (`openPeople`), so a teammate is not emailed about a direct message while they have any tab open. Not knowing (no object bound, down, slow) is "nobody": an email that should have been held back goes out, which is a nuisance and never a lost message.

**Channel guests keep their own connection** on meet's Workspace object, unchanged (`/w/api/socket`). Meet's team ticket and team socket (`MeetTicket`, `MEET_SOCKET_PATH`, the part's `ticket`, `/api/live` as a ticket, `/api/w/socket`) are deleted in the same change.

## Why

- Nothing is copied into a store of the space's own. Every screen reads its stores directly, so the only thing worth pushing is "read again".
- A message that names no change cannot be wrong about it, and cannot leak: the page's reads apply every rule. The people a message names only decide whose page is told; a person who is not told still sees everything they may, on the next read.
- Telling after the store keeps "never before" true by construction: a Durable Object's output gate holds the message until the write is confirmed, and every other store tells from the line after its write.
- One connection per tab, held by the shell, costs one hibernating socket however many screens are on view.

## What it does not do

- It does not make delivery reliable. A message can be lost (the object restarted, the socket was down); the page reads again on reconnecting, when shown and every ten minutes. Nothing depends on a message arriving.
- It does not name a mail conversation. A person's conversation is joined across their addresses, which the inbox's calls do not all carry, so an open email conversation reads again for any mail change.
- It does not tell for a write no live screen follows (a device, a sending switch, the spam check's switch, a compose key's bookkeeping): `UNFOLLOWED_CALLS` in packages/inbox/src/live.ts. A test holds `CHANGING_CALLS` and `UNFOLLOWED_CALLS` to every name the inbox's `call` accepts, so a new method is put in one on purpose.

## Deploying

A new class: `LiveDO` is listed under `exports` in `wrangler.jsonc` (with no `state`, which creates it) and bound as `LIVE`; no transfer, no `migrations`. A plain apply of `space` is right. Undoing it is a forward change (stop telling and stop opening the socket, keep `LiveDO` declared): an older build whose wrangler file lacks the class could be read by Cloudflare as deleting it (unverified; the object holds nothing a person owns, so the cost would be every page reconnecting).

## Reading an older note

Where an older note says the page opens meet's socket with a ticket from `/api/live`, or that mail is read again once a minute, read this ADR.
