# The workspace: one object for every conversation, two doors chosen by path, live sockets opened with tickets, emailed codes for guests, nudges sent by the router

Status: accepted. The identity model (teammates and guests) and the sign-in length (30 days) are decisions of the product; this records the choices that shape the code.

Since [0009](0009-start-is-a-redirect-to-the-space-and-meet-has-no-door-for-people.md) there is one door of meet's own, the guests'. Where this says "teammates' door" (`/start/api/w`, Access in front), read the space's entrypoint, `SpaceMeet`; the rules behind it are unchanged.

Channels and direct messages live beside calls, in the same Worker at the same address. Five choices.

## 1. One Workspace object holds every conversation

`WorkspaceDO` (`src/workspace-do.ts`) is one SQLite-backed Durable Object, named for the install (`WORKSPACE_NAME`), holding
people, invitations, guest codes and sessions, socket tickets, channels and who is in each, direct messages, messages,
read positions, the change feed and the nudge state. It is a class of its own, not the call Room's: the Room class also
serves as the usage ledger and carries the past-calls index, and a workspace's tables do not belong in every call. A
second workspace later is a second instance of the same class.

**Why one object.** A few dozen people and their text are far inside one object's 10 GB and about 1,000 requests a
second, and one object makes "who may see this", unread counts and "who to tell" one step with nothing to keep
consistent between objects. **Cost.** A much bigger workspace would split conversations into their own objects, a
rebuild of the storage and not of the screens.

**The split is ADR 0001's, section 2.** `WorkspaceCore` (`src/workspace.ts`) holds every rule over the object's
synchronous SQL and never calls the network. It is handed an **Actor** (a teammate's verified address, a guest
session's hash, or the object's own socket), never a credential, and every call checks all its rules before it writes.
Each accepted change goes into the change feed and onto an outbox as an Effect (who to tell, which sockets to close);
the object's adapter drains the outbox after every call, and the tests drain it into a recorder. The router does
everything external: the doors, input checks, the email. Hashes (a token's, a code's) are made by the router, because
WebCrypto's digest is asynchronous and the core must not await.

**Migration, ADR 0001's rules.** The Room class and every call's storage are untouched. `wrangler.jsonc` gains a new
entry, `v2` adding the `WorkspaceDO` SQLite class, and `v1` is not edited (a test pins both). The workspace's own
storage follows the same rule from its first day: `WS_SCHEMA` is frozen as first written; a later table is appended to
`WS_ADDED_TABLES` (`CREATE TABLE IF NOT EXISTS`, every boot) and a later column to `WS_ADDITIONS` (`ALTER TABLE ADD
COLUMN`, guarded by `PRAGMA table_info`). Both lists are empty today.

## 2. Two doors into one Worker; the path chooses the door and a credential never does

| Path | Who | Credential, checked by the Worker |
|---|---|---|
| `/start/api/w/*` | the install's people (teammates) | A Cloudflare Access assertion: signature, this application's audience, not expired, then an address on the teammate list |
| `/api/w/auth/*` | anyone | none: asking for a code, entering it |
| `/api/w/*` | channel guests | meet's session cookie, whose hash the workspace holds, unexpired, for a guest who is not removed |
| `/api/w/socket` | both | a socket ticket, and an Origin of this site |
| `/start/api/rooms`, `usage`, `calls*` | an owner | an Access assertion for an owner of the install |

Each route takes exactly one kind of sign-in. A guest cookie sent to a teammate route is not looked at, so the request
has no assertion and is refused; an assertion header sent to a guest route is not looked at either. The guest cookie
is HttpOnly, Secure (off only on a localhost run), SameSite=Lax and scoped to `/api/w`, so a browser never sends it to
`/start`. Writes from other sites are refused on both doors. The two doors share every handler (`workspaceApi` in
`src/workspace-routes.ts`) and differ only in the Actor they build; the core checks the Actor's kind again for what
only one kind may do.

Everything under `/start/api` that is not `/start/api/w` stays owner-only by default: the group asks for the Owner
after Access, so a route added later and forgotten is refused to every other teammate.

**One teammate list, read twice** (`src/teammates.ts`, which also holds the session length). The deploy instance reads
it as Access's allow list and the Worker reads it for its own check, so a widened Access application would still not
let an address off the list in. Adding a person is one line and `zbc apply <env> meet`.
The same file holds `ACCESS_SESSION_DURATION` (`720h`, 30 days), which also covers the owner's call page.

> **Amended.** `src/teammates.ts`, `TEAMMATES` and `ACCESS_SESSION_DURATION` no
> longer exist. The teammate list is the people of the company declaration (the
> install's `workspace.json`), read by the deploy instance
> (`install.accessApplication('meet')`) and by the Worker (`src/company.ts`), so
> the two still cannot disagree; the session length (still `720h`) is meet's
> `sessionDuration` in that file. Adding a person is one entry there and the same apply.

**One address, one person.** An address is a teammate if it is on the list and otherwise a guest, never both. Inviting
a teammate's address as a guest is refused ("add them to the channel instead"); the guest sign-in sends nothing to it
and answers as for any address it will not serve. A guest whose address joins the list stays one person: their first
Access sign-in turns them into a teammate with channels and history kept, their guest sessions end, and the guest door
stops serving the address at once. A teammate taken off the list becomes a former teammate at the next cron (or
refused at the Worker's own check the moment the file is applied), keeping their messages under their name.

**Visibility.** A teammate sees every teammate and the guests who share a channel with them; a guest sees only the
people who share a channel with them. Open channels are listed to every teammate ("Browse"), but **reading one means
joining it**, so no teammate reads a conversation they are not in; private channels do not exist to anyone outside
them (a refusal says "no such channel", not "forbidden"). A direct message is one to one, opened between people who
can see each other and then open to those two for good.

## 3. Live delivery: hibernating WebSockets opened with single-use tickets, and a change feed that catches up

These are the first sockets in this repo. A page asks its own door for a **ticket** (`POST .../ticket`): a random
value, kept hashed in the workspace for 60 seconds, spent on first use, naming the person and when their sign-in
ends (a guest session's expiry, or a teammate's assertion's). The socket opens on one public path with the ticket and an
Origin of this site, so the live connection depends on neither Access passing a WebSocket through nor a cookie riding
an upgrade, and both doors open sockets the same way. The router builds the headers it forwards to the object itself.

The object uses the hibernation API (`acceptWebSocket`, tags `p:<person>` and `s:<session>`, an attachment on each
socket), so an idle socket costs nothing in time, and answers `ping` itself without waking. A socket ends with its
sign-in: an alarm closes it at the sign-in's end, and sign-out, removal and leaving the list close it at once (codes
4401 and 4403; the page reloads a teammate through Access and shows a guest the sign-in).

**The change feed.** Every message, edit, delete, read mark and structure change is a numbered change. A page asks
once for everything (`bootstrap`, with the newest number) and the socket's first frame, `hello`, carries the number of
the last change it holds; the object answers with every change after it that this person may see, then pushes
each new one only to the people who may see it. Nothing is pushed before the answer, so a page sees them in order. More
than 1,000 changes behind, or behind the 30 days the feed keeps, is told to reload. A change at or below the number a
page has applied is ignored, so none counts twice. A deleted message leaves no trace of its text in the feed. Writes
(send, edit, delete) go over HTTP and get a normal reply or error. Read marks go over the socket as well as HTTP.

**Cost.** This is the in-call chat's cursor (ADR 0002) widened to every change and pushed instead of polled. A person's
phone that slept catches up the same way as a tab that lost its network. Networks that block WebSockets get no fallback
in this version.

## 4. Guests sign in with meet's own emailed code, and meet keeps and can end their sessions

A guest is invited into a channel by a teammate (name and address). The sign-in page asks for an address and, if it
belongs to an invited guest who has not been removed, emails a 6-digit code: valid 10 minutes, used once, dead after 5
wrong tries, stored hashed. The reply is the same for every address, and nothing is sent to one nobody invited, to a
teammate's or to a removed guest's.

**Nothing in the sign-in is refused out loud, and a stranger's request costs the object almost nothing.** The route is
open to anyone, so it is the one place a script can spend the workspace's time and the account's reads. Three layers:

- **Per caller, before the object.** `/api/w/auth/*` passes Cloudflare's Rate Limiting binding first (`AUTH_LIMIT`,
  `wrangler.jsonc` `ratelimits`, 10 tries a minute per `cf-connecting-ip`, namespace 7302; forms declares 7301 the same
  way, so each Worker's namespace id must be unique in the account). The zbc cloudflare module deploys `wrangler.jsonc` as written, so the binding needs nothing in the deploy
  instance. A refused try never reaches the object. The binding is absent in a local run, where nothing is limited.
- **An address that is not an invited guest costs one indexed read and no write.** There are no "request" rows: the
  log (`mail_log`, indexed by time and by address, kind and time) holds only emails sent and wrong codes entered against
  a live code, so a flood of made-up addresses cannot grow it or slow the object, and the cron prunes it daily.
- **For a real guest the limits answer with the same reply as for a stranger, and send nothing:** 5 codes an hour and 10
  a day to one address (so the sign-in cannot be used to fill someone's inbox), no new code and no right one once 10
  wrong ones have been entered in the hour (across codes: a new code does not reset the count), and 50 emails an hour in
  all, shared with invitations and nudges. Because none of these says no, none tells a stranger who is invited. The cost
  is that a stranger who knows a guest's address can shut that guest out of new sign-ins: for up to an hour by entering
  wrong codes, and for about a day by asking for codes until the daily 10 are used. Guests already signed in are
  unaffected. The daily cap is kept knowing this; the alternative, dropping it, lets a stranger send one guest up to
  about 120 code emails a day (5 an hour) and so fill their inbox.

**Where the page is.** The sign-in lives at `/w`, not at `/`: `/` stays the page for people who
arrive without a link and points at `/w` and `/start`, and the invitation email links straight to `/w`.

The code email carries **no link that signs anyone in**: Cloudflare's own sign-in troubleshooting notes that email
security tools follow links and spend one-time codes before the person can, and a code can be read on a phone and
typed on a laptop. A successful code makes a random session token; the workspace stores only its hash, so a session
can be listed and ended (a guest sees their devices and can sign any out, and removal ends every one), which a signed
cookie cannot do. A session lasts 30 days from its last use, and the cookie is set again on every
answered request so it lasts as long as the session does.

**Cost.** This is the package's own security code, so a mistake here exposes the guests' channels, not the workspace. The
tests drive every route with the wrong door's credential.

## 5. Nudges: a cron asks the workspace who is owed one, and the router sends

A cron every 5 minutes (`wrangler.jsonc` `triggers.crons`, `src/cron.ts`) makes one request to the object (`sweep`: tidy
up, then ask). The object answers who has had a direct message unread for 15 minutes, has no open socket (only the
object knows), had no nudge in the last hour and has not turned them off. **Only messages newer than the person's last
nudge count**, so a waiting message is told of once: one episode, one email, not one an hour for ever. The router sends one email each, from
the install's meet address (`meet@<your-domain>`) through the Worker's `send_email` binding, naming who wrote and how many and never what, with a
link to the person's own door (`/start` or `/w`), and then tells the workspace which were sent, so a send that failed is
tried again on the next run. Channels send no nudges. Each sent nudge is a row in the same log as the codes and
invitations and counts against the same 50 an hour, with 10 places kept back so nudges cannot crowd out sign-in codes.
The core stays off the network, as in section 1.

**Names in email.** Subjects are fixed text ("You have a direct message waiting on meet", "You were added to a channel on
meet"). A name someone chose, and a channel's name, appear only in the body, with `:`, `/`, `@`, `<`, `>` and `\` taken
out so they cannot be written to look like a link or a sender.

## Not changed

Calls, in-call chat, the owner's call tools and the past-calls list are as ADRs 0001 and 0002 left them. `/start` is now
the workspace, and the call tools are one click in, under "Call tools", for an owner alone. A call's chat stays in the
call; nothing is moved into a channel.

## Choices that might surprise

- **An owner deletes another person's message only in a conversation the owner is in.** An owner reads only the
  conversations they are in; ids of messages they cannot see are no handle they could use. "Delete a person" (every
  message they wrote, wherever) is the tool for the rest.
- **Reading an open channel means joining it.** Every teammate is shown the open channels and may join; joining is one
  click and keeps "I read only what I am in" true.
- **Deleting a person also blanks their name and address** (the person stays as "Deleted person" so earlier structure
  does not break), along with every message they wrote and their read positions: a deletion request should not leave
  the address behind. Inviting that address again makes a new person.
- **Archiving a channel removes the guests whose last channel it was**, as taking them out of it does. A teammate also
  removes a guest they invited; the page shows the button to the inviter (a teammate is told who invited each guest),
  not only to an owner.
- **A teammate is taken off the list by editing the file; the workspace cannot do it.** Remove (as opposed to delete)
  is for guests; for a teammate the page tells you to take them off the list. Their seat in Zero Trust is a hand step.
- **The cron's request count is part of the cost estimate:** one request per 5 minutes is about 8,600 a month, so a
  small install stays near 26,000 requests a month of the 1 million included.
