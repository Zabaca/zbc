# Chat: messages in the Room, delivered on the check-in, saved until the owner deletes them, listed from the ledger

Status: accepted.

The first version of meet left chat out of scope; it was added after the first calls. What chat is: text only, in the
call; links clickable; names and times shown; a late joiner sees the messages so far; an unread badge, and a sheet over
the grid on a phone; messages are **kept after the call** and the owner's start page lists past calls and opens each one's
chat read-only, with a delete per call that removes its messages for good; guests are told, in one line, that the
messages are saved; and the safety rules in section 4.

## 1. Messages live in the Room, and ride the check-in

A message is a row in the call's own Durable Object (`messages`, in `src/room.ts`), written by `RoomCore.chat`.
Sending is `POST /api/rooms/<name>/chat`. Reading is not a route: the 2-second check-in already asks the Room for the
call, and now carries `since` (the newest message id the browser holds) and gets back the messages after it, at most
200 (`CHAT_PAGE`), oldest first, plus the newest id in the call. A check-in with no `since` at all (a tab still running code from before chat) is sent no messages, only the newest id. A late joiner holds nothing, so it asks from 0 and is
sent the whole history over as many check-ins as it takes (200 per 2 s). Joining says how far the history goes
(`chatLast`), so what was there when someone arrived is never "unread".

**Why.** One Durable Object request per check-in is already the cost of being in a call; messages add one request per
message and nothing per second. There is no second connection to open, authenticate, keep alive or reconnect, and
"only joined members of this room can read it" is the check-in's own rule (a token, a generation, a seat), with no new
door to get wrong. A WebSocket on the Room would make delivery instant but adds a socket's lifecycle, its own
authentication, and hibernation behaviour to a prototype that exists to answer other questions.

**Cost.** A message reaches the others up to 2 seconds late (about 1 s on average), and your own appears at once because
the send's reply carries it. If that feels slow in use, the fix is small: check in every second while the panel
is open (the Room's cost is one request per check-in, so 1,800 more an hour for that person), and only then a socket.

## 2. Storage, migration, and the limits

`messages(id AUTOINCREMENT, member_id, name, text, at)`. The sender's **name at the time** is stored with the message,
because members are deleted when they leave and the messages must stay readable. `AUTOINCREMENT`, so an id is never
reused after a delete and a browser that has seen id N cannot mistake a new message for an old one.

A call that has already started keeps its storage (ADR 0001, section 2), so this adds, never rebuilds: a new
`ADDED_TABLES` list of `CREATE TABLE IF NOT EXISTS` statements, run on every boot of any call that has data, for the
`messages` table (and `calls`, section 3); and three more entries in `ADDITIONS` (`members.chat_window_at`,
`members.chat_count`, `room.people`) added by `ALTER TABLE`. `SCHEMA` stays frozen. `test/room.test.ts` opens a
call built with the deploy-before-chat schema (`SCHEMA_V3`) and checks that chat works in it.

The limits live in `src/model.ts` and are enforced in the Room: a message is at most 2,000 characters, checked after
cleaning; a member may send 6 messages in each 10 seconds (the window is on the member row, so a refresh does not
reset it, and a person is held up only by their own sends); a call keeps at most 2,000 messages, after which sends are
refused ("This chat is full."), a backstop so a leaked link cannot fill a Durable Object. Cleaning removes control
characters and the bidirectional overrides and tidies line breaks; it does not escape anything, because the browser
never treats a message as HTML (section 4).

## 3. The past-calls list comes from the ledger instance, and each call reports its own numbers

The owner's page needs the calls so far. Two homes were possible: an index in the ledger Durable Object (`_ledger`,
which already holds the usage ledger), or D1.

**Chosen: the ledger.** `/start/api/rooms` writes one row (`calls(name, started_at)`) when it makes a call, and is the
only writer, so a name nobody started is never in it. `GET /start/api/calls` reads one page of names there (50 by default,
newest first, a keyset cursor of start time and name so nothing repeats or hides while the owner pages; the start page's
"Show older calls" asks for the next) and asks each call's Room for its own summary (`startedAt`, `people`, `messages`, `present`) in parallel, so there is no counter to
keep in step with the messages: the Room is the one source of every number. This is the package's existing pattern (one
more table in the instance that already keeps the month's bytes), needs no new binding or provisioning, and `bun test`
drives it over the same in-memory SQLite as everything else.

**Why not D1.** The package has none. Adding it means a zbc module change, a database to provision, and migrations
that `zbc apply` does not run (a migration nobody applied by hand breaks the Worker that needs it), for a list of at most a few hundred rows.

**Cost.** A page is up to 50 Durable Object requests (100 at most). A call started before this change is not in the index (there is
no way to enumerate Durable Objects) and has no messages either; it just does not appear. "People" counts seats taken
over the call's life, so someone who refreshes in a new tab counts again. A call that cannot be read is left out of
the list rather than failing it.

## 4. Safety

- **Text, never HTML.** Messages are rendered as React text nodes. A link is an `<a>` only for an address that parses as
  `http` or `https` with a host and no embedded sign-in (`src/web/call/chat.ts`), with `target="_blank"` and
  `rel="noopener noreferrer nofollow"`; `javascript:`, `data:`, `ftp:` and `https://bank.example@evil.test` stay text.
- **Who.** Only a joined member of that call can send or read it: every chat request needs the member token and the
  current generation, and a call is its own Durable Object, so nothing crosses calls (tested with two calls).
  Only an owner, through `/start/api` with the Worker verifying the Access assertion as it does for starting a call, can
  list, read past calls or delete. There is no route that edits or deletes one message.
- **Ghosts.** A name nobody started answers 404 on every chat and start route and writes nothing (tested by counting
  writes, as for join).
- **Lookalike links.** A link whose host is not plain ASCII shows the address it really opens (the encoded `xn--` form), so a
  Cyrillic letter cannot pass for a Latin one.
- **Told.** The panel says "Messages in this chat are saved.", and so does the lobby ("This call has a chat. ..."), so a
  guest who never opens the panel is still told before joining.
- **Another site.** The delete requires the same cross-site refusal as starting a call, since the Access cookie rides
  along on any page's request.

## 5. Kept until the owner deletes; what delete means

Messages stay until the owner deletes them; there is no expiry. Guests are told by one line in the panel ("Messages in
this chat are saved."). Delete removes the call's rows from its storage and nothing else is kept by this app (no log of
text, no copy in the index). It is **refused while anyone is in the call**: their browsers would carry on sending into a
chat whose past the page no longer shows. After a delete the call stays in the list with 0 messages. Whether Cloudflare
keeps storage snapshots beneath the Durable Object API is not something this package controls and it has not been
checked.

A person dropped for 30 s of silence and let back in with the same token is a new Member with a new id, so their earlier
messages carry an id the call no longer knows. The tab keeps every id it has had in session storage beside its token,
so those messages stay "yours" (colour, never unread) after a rejoin or a refresh.

## 6. A stand-in SFU for development

`src/dev-realtime.ts` accepts every publish and subscribe and carries no media. It is used only when `FAKE_REALTIME=1`
is set and the request is for a localhost host (the same two conditions as the Access bypass), so a deployed Worker
cannot use it. It lets `scripts/chat.ts` run two real tabs against the real Worker and Durable Objects with no secrets.
