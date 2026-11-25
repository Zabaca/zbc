# The texts bridge's wire

The contract between the inbox and the **texts bridge**, a program on a machine of the install's own that is paired with the owner's phone (as Messages for web is) and pushes the owner's texts to the inbox. The contract is owned by the inbox: its types and its bounded parser are `src/texts/wire.ts` (zero dependencies, no I/O), and that file is the source of truth where this page and the code differ. The bridge restates the types in its own language and a test of the install's runs the bridge's recorded requests through the inbox's parser, so the two cannot drift.

The decisions behind it are ADR 0001 decision 36 (`adr/0001-the-inbox-is-its-own-worker-over-gmail.md`); the door's deploy and hand tests are `runbooks/inbox-texts-bridge.md`.

## The door

- **Path:** `https://<space host>/agent/texts/api/<call>`, a `POST` of one JSON body (`Content-Type: application/json`, at most 2,000,000 bytes). The door admits one thing: the bridge's service token, sent as the two headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Claude's token and the Telegram bridge's token are refused there (403) and this one is refused on theirs.
- **Answers:** 200 with a JSON body; 400 a body that is not JSON; 401 no token (or the token of another door); 403 the wrong token, a person, or a cross-site request; 404 any other path or method, or the `texts` switch off for the install; 409 the bridge's account id is not the one this inbox holds (nothing stored); 422 a body the parser refused, with `{ "error": "<which field and what it wants>" }`.
- **Every answer is `no-store`** and is never framed.

## The shapes, in words

- **Ids** (`account.id`, a chat's `id`, a message's `id`) are the bridge's own: 1 to 100 of letters, digits and `. _ = ~ -`, **never a colon** (the inbox's key for a message is `<chat id>:<message id>`). If the phone's id holds anything else, the bridge encodes it the same way every time (base64url without padding is fine) and uses that everywhere. `account.id` names the paired phone and never changes: the inbox holds ONE texts account and answers 409 to another.
- **Times** are ISO 8601 with a zone (`2026-01-05T17:03:09Z`). The inbox stores them in UTC.
- **A chat** is `{ id, kind, name, address?, members? }`. `kind` is `person`, `short-code`, `named-sender`, `business` or `group`. `name` is as the phone names the chat (may be empty; control characters become spaces and a name over 200 characters is cut, never refused, because a name is a label and not an identity). `address` is the other side's identity and its spelling depends on the kind: a `person`'s E.164 number (`+15555550123`: a plus, 7 to 15 digits, the first not 0; a number the bridge cannot put in E.164 is not a person, it goes as a `named-sender` with the digits as the name), a `short-code`'s digits (3 to 8, no plus), a `named-sender`'s name as the phone has it, a `business` chat's id; a `group` has none. Every kind but `person` and `group` is an **automated sender**: the inbox files it under Bulk and never joins it to a person. A business that texts from an ordinary number cannot be told from a person and is a `person`.
- **A message** is `{ chatId, id, at, out, text, read, sender? }`. `out` is the owner's own text (sent from their phone or another device); `text` is plain, at most 20,000 characters, and a message with no words carries a bracketed label (`[Photo]`, `[Voice note]`, `[Video]`, `[File]`, `[Contact]`, `[Location]`): files are not carried yet. `read` is the phone's state (an `out` message is read). `sender` is `{ address?, name }`, required for a message in a group and ignored in any other chat (the inbox takes the sender from the chat there).
- **Nothing is kept out for its kind.** A business sender's text and a sign-in code are pushed like any other. The one exclusion is the **left-out list**, which the bridge drops at its own edge on every path (the fill, the catch-up, the live stream) and which the inbox refuses again.
- **Unknown fields are dropped, not refused**, so a bridge may send more than the inbox reads yet. A wrong shape is refused whole with the field named.

## The five calls

### `push`

The messages, with the chats they are in. Every message's chat must be described in the same push's `chats` (the inbox does not keep a chat's description between pushes). At most 500 messages and 200 chats; a fill is sent in batches under these, oldest first. A push repeated after a timeout stores each message once.

`mirror: true` means **history only**: the messages were read from the phone's history for the first fill or for a Bring back. Each is filed with the `read` it carries, and on a conversation the owner closed it is filed closed, so it never reopens one. Everything that may be news is sent **without** `mirror`, a catch-up of a gap in the live stream included: those texts are filed as they arrive (unread, open) and a text from the other side reopens a closed conversation.

```json
{
  "account": { "id": "phone-1" },
  "mirror": false,
  "chats": [
    { "id": "c-101", "kind": "person", "name": "Dana Whitfield", "address": "+15555550123" },
    { "id": "c-202", "kind": "short-code", "name": "55501", "address": "55501" },
    { "id": "c-303", "kind": "named-sender", "name": "Example Bank", "address": "ExampleBank" }
  ],
  "messages": [
    { "chatId": "c-101", "id": "m-9001", "at": "2026-01-05T17:03:09Z", "out": false, "read": false, "text": "Running ten minutes late", "sender": { "address": "+15555550123", "name": "Dana Whitfield" } },
    { "chatId": "c-101", "id": "m-9002", "at": "2026-01-05T17:04:40Z", "out": true, "read": true, "text": "No problem" },
    { "chatId": "c-202", "id": "m-9003", "at": "2026-01-05T17:05:00Z", "out": false, "read": false, "text": "Your code is 000000" }
  ]
}
```

Answer (`PushResult`):

```json
{ "stored": 3, "repeated": 0, "leftOut": 0, "groups": 0, "skipped": 0, "leftOutChats": [] }
```

`leftOut` counts messages of chats on the left-out list (not stored; `leftOutChats` names them, so a bridge that missed the list learns it here). `groups` counts messages of a `group` chat: groups are not carried yet, so they are refused and counted, never an error. `skipped` counts messages whose chat the push did not describe.

### `events`

What the phone changed: edits, deletions and read marks. All three arrays may be empty (`edits` and `deletions` are required, `reads` may be absent). A deletion names its chat and the message ids; deleting a text is not carried, so a deletion is counted in `ignored` and changes nothing. A read mark says the owner read the chat on the phone: every incoming message of the chat sent at or before `upTo` is read in the inbox (it is never sent back to the phone and never marks anything unread).

```json
{
  "account": { "id": "phone-1" },
  "edits": [{ "chatId": "c-101", "id": "m-9001", "text": "Running fifteen minutes late", "at": "2026-01-05T17:06:00Z" }],
  "deletions": [{ "chatId": "c-101", "ids": ["m-9002"], "at": "2026-01-05T17:07:00Z" }],
  "reads": [{ "chatId": "c-101", "upTo": "2026-01-05T17:05:00Z", "at": "2026-01-05T17:08:00Z" }]
}
```

Answer: `{ "edited": 1, "ignored": 1, "read": 1, "unknown": 0 }`. A name of a message or chat the inbox does not hold (older than the fill, never carried, left out) is counted in `unknown`.

### `work`

What the bridge is owed. **It is the heartbeat**: the bridge asks every few seconds and the inbox records "checked in" from it (at most once a minute). The request carries the **capability flags** of this bridge: `sends`, `media`, `pictures` (booleans, all absent from a bridge that takes none of them; a later version offers sends, read marks and files only to a bridge that says it takes them). `newest: true` also answers the newest message held per chat, which is what the bridge's catch-up on every reconnect compares the phone's own listing against (the phone's conversations by last activity, each one newer than what the inbox holds read back).

```json
{ "account": { "id": "phone-1" }, "newest": true }
```

```json
{
  "leftOut": ["c-404"],
  "newest": {
    "c-101": { "id": "m-9002", "at": "2026-01-05T17:04:40.000Z" },
    "c-202": { "id": "m-9003", "at": "2026-01-05T17:05:00.000Z" }
  },
  "owed": [{ "kind": "fill", "chatId": "c-404", "days": 30 }]
}
```

- `leftOut` is the **whole** left-out list every time (at most 1,000 chat ids). Nothing of these chats is pushed, on any path, from the moment the bridge has the list, and the bridge reads the list before it fills anything.
- `owed` is what the inbox asks the bridge to do, oldest first, at most 50, offered again by every request until it is settled. Today there is one kind, a **fill**: the owner brought a chat back from the left-out list, so the bridge reads that chat's last `days` (30) days from the phone, pushes them with `mirror: true`, and reports the outcome. A bridge ignores an item of a kind it does not know and never reports it.
- `newest` is keyed by chat id; `at` is ISO UTC. Message ids are not ordered, so the comparison is by time.

### `outcomes`

What became of the work it was owed.

```json
{
  "account": { "id": "phone-1" },
  "outcomes": [
    { "kind": "fill", "chatId": "c-404", "ok": true },
    { "kind": "fill", "chatId": "c-505", "ok": false, "reason": "CONVERSATION_NOT_FOUND" }
  ]
}
```

A `reason` is a short code of 1 to 120 plain characters (`A-Z a-z 0-9 _ space ( ) . : -`), never a message's text. Answer: `{ "settled": 2, "unknown": 0 }` (`unknown` is an outcome that names nothing owed). A failed fill is audited and kept: the space offers it again in `work` after ten minutes, up to five tries, and the owner's Settings shows the failure in words; the bridge keeps no memory of it across a restart and need not. After the fifth failure the space stops offering it until the owner presses Bring back again.

### `status`

What the bridge says of itself. It is sent when the state changes and may be repeated.

```json
{ "account": { "id": "phone-1" }, "state": "phone-not-answering", "since": "2026-01-05T16:40:00Z" }
```

`state` is one of `live`, `catching-up`, `phone-not-answering` (`since`, an ISO time, is required), `signed-out` (Google ended the bridge's sign-in; only the owner can sign in again; `reason` may carry a short code) and `session-taken` (another browser took the Messages for web session; the bridge is waiting to take it back). Answer: `{ "state": "phone-not-answering" }`. Whatever it last said, the bridge counts as **not checked in** after five minutes with no `work` request, and the space shows that in amber.

## What this contract does not carry yet

Sends (a new kind of work, offered only to a bridge whose request says `sends: true`), read marks from the inbox to the phone, and files (the `media` and `pictures` flags, two more calls). Groups are described (`kind: "group"`, `members`) and refused whole and counted until they are carried.
