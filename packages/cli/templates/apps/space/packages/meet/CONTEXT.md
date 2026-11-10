# meet: Context

Normative glossary for meet, browser video calls (at `<space host>/r/`), and the workspace of channels and direct
messages beside them. The owner of an install holds
a call with people outside the company to find out whether a call the company runs itself
can be good with three features (noise cancellation, background blur, screen
sharing) on the phones, laptops and networks guests really bring. It is a
prototype, not a product. The decisions that shape the code are in [`docs/adr/`](docs/adr/).

If a word here starts meaning two things, stop and fix this file first.

## Glossary

- **Call**: one meeting. Exists only once a teammate **starts** it. Addressed by its
  **Call name** and held by one Durable Object (a **Room**, in the code),
  so nothing ever crosses calls.

- **Call name**: 20 characters from an alphabet without lookalikes (100
  bits), made by the server and shown in groups of five
  (`k7m2q-x9frt-n4w6h-bc8jd`). It is the only lock on a call: the **Call link**
  `<space host>/r/<name>` is the invitation. A name nobody started answers
  "This is not a call." and creates nothing. Links do not expire.

- **Start**: making a call. Only a signed-in teammate can, in the space (New call, a huddle); everything else about a call needs
  no sign-in ([ADR 0001](docs/adr/0001-sfu-only-rules-in-the-room-access-on-start.md), section 3, as it stood when meet had a `/start` page of its own).
  **`/start`** itself is gone, and so is the host it was on.

- **Member**: one person in one call (never a person in the workspace: those are **People**, below). Known to the server by the hash of a
  random **Member token** their tab keeps in session storage, so a refresh lands
  back as the same Member. Names are optional, one line, at most 40 characters
  ("Guest" when empty). Inside a call there are no roles: the owner joins like any
  guest, and nobody can mute, remove or admit anyone else.

- **Generation**: a number a Member's connection carries. A join, or a rejoin
  under the same token (a refresh, a reconnect), starts the next one. Every media
  request names the current Generation, so a reply meant for a replaced
  connection cannot change the new one.

- **Relay credentials**: what a browser needs to use the relay, made once per
  Member and kept in the Room for 8 hours. A rejoin gets the same ones back while
  at least 30 minutes remain, so reconnecting never mints more. While the Meter
  has tripped, a rejoin without such credentials is refused like a new person.

- **Seat**: one of the **8** places in a call (`ROOM_CAP`). The 9th person is told
  the call is full. A Member who is already in can always take their own Seat
  back.

- **Orphan**: a track at the SFU that nobody in the call owns any more (its
  Member was dropped, left, or rejoined). The router closes it
  ([ADR 0001](docs/adr/0001-sfu-only-rules-in-the-room-access-on-start.md), section 2).

- **Check-in**: what a browser does every 2 seconds. It is the heartbeat (a
  Member not heard from for 30 seconds drops off everyone's list) and the read:
  it returns the **Snapshot** and the **Chat** messages after the newest one the
  browser holds.

- **Snapshot**: the call as one Check-in sees it: a revision, the count, the
  **Quality step**, and each Member with their name, whether they are muted or
  have their camera off, and the kinds they are **publishing**. It never carries
  a session id, a track name, a token or a credential.

- **Kind**: what a Member can publish: `mic`, `camera`, `screen` and
  `screenAudio` (the sound that comes with a share). Each publication has a
  version `v`, so a share stopped and started again is a new publication, not
  the old one.

- **Publish / Subscribe**: a Member's browser sends its microphone, camera and
  any share up to the SFU once, on its **sending connection**, and asks for
  everyone else's, by Member and Kind (never by session), on its **receiving
  connection**. Each connection has its own first-in-first-out queue, and the
  receiving one holds the next request until the SFU's offer has been answered.

- **SFU**: Cloudflare's Realtime selective forwarding unit. Media goes through
  it, never browser to browser, so a call can hold more than 4 people.
  **Relay** is Cloudflare's TURN: the fallback for networks that block direct
  media, free alongside the SFU. The **Link badge** says **Direct** or
  **Relayed**; the test switch `?relay=1` forces the relay.

- **Quality step**: up to 4 people each camera goes up at 1280x720 and 1.0 Mbps;
  from 5 it steps down to 640x360 and 0.4 Mbps. A share is capped at 1.5 Mbps and
  15 frames a second, marked as detail so text stays sharp. Applied by each
  sender, with no renegotiation.

- **Effects**: everything is applied in the sender's browser, before the sound or
  picture leaves it, and each switches during a call without a reconnect.
  - **Noise cancellation**: RNNoise in an AudioWorklet. The graph is microphone,
    (worklet), destination; the published track never changes, so switching it is
    gapless. The one exception is the **Self-check** below, which publishes the raw
    microphone track instead.
  - **Blur**: MediaPipe's segmenter plus a WebGL pass, swapped in with
    `replaceTrack`. Its engine downloads the first time it is turned on.
  - **Camera off**: stops the camera (its light goes out) and sends a black
    placeholder at one frame a second, so the publication is not dropped.
  - **Share**: `getDisplayMedia`; the person picks the screen, a window or a tab
    in the browser's own picker.

- **Chat**: text messages inside a call, in a panel beside the grid (a sheet over
  it on a phone). A **Message** is text only, at most 2,000 characters, kept with
  its sender's name and the time. Only Members of that call can send or read it, a
  Member may send 6 in 10 seconds, and a call keeps at most 2,000. A late joiner is
  sent the messages so far. The panel says "Messages in this chat are saved." because
  they are **saved after the call** until the owner deletes them
  ([ADR 0002](docs/adr/0002-chat-in-the-room-on-the-check-in-saved-until-the-owner-deletes.md)).
  The **unread badge** on the Chat button counts what others sent since you
  arrived or last had the panel open; the history you arrived to is not unread.

- **Past call**: a call a teammate has started, as the space lists it: when it
  began, how many people took a seat, how many messages, and whether anyone is in it
  now. The owner can open its chat to read (never to write in) and delete its messages for
  good, which is refused while anyone is in the call. The list is an index in the
  Ledger instance of the calls started, each with who made it (`started_by`, the
  declaration's address; a call made before the column has none and is read as the owner's);
  each call reports its own numbers. The space's Today asks the index for the calls with
  someone in them that a person made (`SpaceMeet.liveCalls`;
  [packages/space ADR 0006](../space/docs/adr/0006-today-is-seven-reads-cut-on-the-companys-day-each-row-opens-where-the-work-is.md)).

- **Level**: how loud a sound is right now, from 0 to 100, drawn as a bar. On
  your own tile and in the lobby it is the sound that is being sent (the processed
  sound with noise cancellation on, the raw microphone with it off, empty while you
  are muted; while the audio context is asleep it is read from the sender's own
  statistics instead, in a call); on someone else's tile it is the sound that is
  arriving. Not the **Meter** below, which is the cost estimate.

- **Speaking light**: a tile's outline, on while that person's Level is above a
  threshold and for half a second after, so a pause between words does not flicker.

- **Self-check**: the browser watching what it sends. A graph can look alive and
  send silence: an audio context that never started (Safari and iOS want a tap
  first), or a worklet that loads and outputs nothing. When the context has not been
  running for 1.5 s after the person's first tap, or the processed sound has been
  exactly silent for 2 s while the microphone carried speech (at least four readings
  in a row, with pauses), the browser publishes the **raw microphone track** with
  `replaceTrack` and says so: "Noise cancellation couldn't start in this browser;
  sending your mic without it." if it never worked, "Noise cancellation stopped
  working; sending your mic without it." if it had. A worklet that has not loaded
  after 3 s is given up on the same way, so Join still comes up. Exact silence alone
  is not a fault (RNNoise turns a steady fan to exactly zero), so a dead path is
  found when its owner next speaks; nothing is judged while the tab is hidden. The
  fallback is not for good: switching noise cancellation on again tests the path
  once more (and falls back again if it is still dead), and a fallback caused by the
  context lifts by itself once the context has run for a second.

- **Not arriving**: a person who is publishing sound while none of it has reached
  this browser for 5 s. Their tile says "No sound arriving", so "they are silent"
  and "their sound is not reaching me" look different. A person who is muted is not
  this: muting keeps sending silence frames.

- **Diagnostics**: the panel behind `?debug=1` (in the lobby and the call): audio
  context state, the path the sound takes, the sent track's state, the microphone,
  the bytes of audio sent and received per person, and the browser. For a
  screenshot when something goes wrong.

- **Meter**: the estimate of what the month has cost, counted at the send caps
  of every track each Member receives and added to the **Ledger** every 10 seconds, and at once when the last person leaves.
  Past **800 GB** (of the free 1,000 GB, `TRIP_GB`), new joins and new calls are
  refused until the first of next month; people already in a call carry on.
  The **Ledger** is one more Durable Object instance (`_ledger`) keeping bytes
  per UTC month.

## The workspace

Everything below is [ADR 0003](docs/adr/0003-workspace-one-object-two-doors-live-sockets-emailed-codes.md). "Member"
is taken (one person in one call), so the workspace says **Person**. "Call guest" is an anonymous Member of a call;
"channel guest" is below.

- **Workspace**: the one Durable Object (`WorkspaceDO`, named for the company) holding every Conversation, Person and
  Message. Its rules are `WorkspaceCore`, which never calls the network.

- **Person**: anyone with a sign-in to the workspace, of one of two kinds, with one lowercase address each. A
  teammate's address is never a guest, and a guest who joins the Teammate list stays one Person.

- **Teammate**: a person of the company, on the **Teammate list** (the people of the install's company declaration, read through `packages/workspace`; the same list is Access's allow list),
  who signs in through Cloudflare Access at the space. Sees every teammate, the open channels (to join) and the guests who
  share a channel with them; makes channels, invites guests, adds people. **Owner**: a teammate (the owner in the declaration) who also removes
  any guest, deletes a person on request, archives any channel, and deletes another's message in a conversation they are in.

- **Channel guest** (a **guest** in the page): a Person a teammate invited into a channel by name and address, who
  signs in at `/w` with a **Sign-in code** (the invitation email links there). Sees only their channels and the people who share one with them, can message
  any of those people, and never makes a channel or invites, adds or removes anyone. Takes no Zero Trust seat.

- **Invitation**: the email a teammate's invite sends a guest, from the install's meet sender address (`meet@<your-domain>`), naming who invited and the channel.

- **Sign-in code**: six digits meet emails to an invited guest. Lasts 10 minutes, works once, dies after 5 wrong tries,
  stored hashed. For a real guest 5 an hour and 10 a day to one address, none after 10 wrong ones in an hour (across
  codes), and 50 emails an hour in all (codes, invitations and nudges); past a limit nothing is sent and the page says
  the same as for any address. The sign-in is also limited per caller (10 tries a minute) before it reaches the
  Workspace. The email has no link that signs anyone in.

- **Guest session**: the random token in the guest cookie (HttpOnly, Secure, SameSite=Lax, path `/api/w`). The Workspace
  keeps only its hash, so it can be listed and ended. 30 days from its last use; the cookie is set again as it is used.

- **Door**: how a request proves who it is, chosen by its path and never by its credential. The **guests' door** is `/api/w` (session
  cookie). A teammate's door was `/start/api/w` (an Access assertion for meet's own application); it is gone, and teammates reach
  the same rules through the **space's entrypoint** (`SpaceMeet`, with the person the space's sign-in check named), as the same teammate.

- **Channel**: a named conversation, **open** (listed to every teammate, who can join or leave it) or **private** (only
  the people added; to everyone else it does not exist). Reading an open channel means being in it. Archiving takes it
  off every list and stops new messages.

- **Direct message** (DM): a one-to-one conversation between two people who can see each other. A **Conversation** is a
  channel or a DM.

- **Message** (in a conversation): text, as the in-call chat's (2,000 characters, the same cleaning, 6 in 10 seconds,
  links by the same rule, and a link to a call on this site reads "Join call"), but belonging to a Person, kept until
  deleted, edited or deleted by its author (or the Owner for another's), one rising id for the whole workspace.

- **Change**: one numbered entry in the change feed: a message, edit, delete, read mark or structure change. A page asks
  for everything once and then for "everything after change N"; the Workspace sends each change only to the people who
  may see it, and tells a page too far behind (1,000 changes, or 30 days) to reload.

- **Socket ticket**: a random value from a guest's session, kept hashed for 60 seconds and spent on first use, that opens
  the guests' live WebSocket (`/w/api/socket`). It names the Person and when their sign-in ends; the socket closes then.

- **Unread**: a conversation's messages from others after the Person's read position (kept per Person and conversation;
  sending moves it, reading marks it, and it syncs across their devices). A message you sent is never unread to you.

- **Nudge**: the email for a DM unread 15 minutes by a Person with no open socket, at most one an hour, naming who wrote
  and how many and never what; teammates and guests alike; none for a channel; off by a setting. A message is told of
  once (only messages newer than the last nudge count), and nudges count against the hour's emails. Subjects are fixed
  text, and chosen names appear only in the body.

## Answering the space

The space (`packages/space`) is where the team works; meet answers it and keeps its own rules.
The shapes are the company layer's (`packages/workspace`: `meet-for-space.ts`, `asking.ts`, and its ADR 0003); the logic is
`src/space-meet.ts`. **It runs IN THE SPACE'S WORKER** (`src/space-part.ts`, called with the person the space's one sign-in check named), over the Workspace and call objects that belong to that Worker ([the space's ADR 0016](../space/docs/adr/0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md)); the guests' side is the space's too, and meet has no Worker of its own.

- **SpaceMeet**: the contract of what the space asks of meet, answered in-process by `spaceMeet` with a `SignedIn` (the person the space's one sign-in check named). Its methods are the contract's (`packages/workspace/src/meet-for-space.ts`: the chat's five, the calls', the **channel admin**'s and the six of
  **messages and settings**, below) and a `fetch` for the socket's and the phone's paths alone. Each method asks the Workspace object as `{ via: 'access', email }` (a teammate, the actor the core's rules are written for), and answers
  a reply as data: the value, a refusal (meet's `RoomError` status as the contract's reason) or `broken`. Nothing is thrown across
  the seam. An earlier design reached meet through a named service entrypoint, each method taking the Access assertion the space forwarded and verifying it itself against the space's application; the contract kept the name.
- **What the space sees**: only the direct messages the person is in and the channels they belong to, as `bootstrap` already
  decides it (workspace.ts, "What the space asks"). Not an open channel they have not joined, another pair's direct message, an
  archived channel or the Phone conversation; all of those are `not-found`, and a guest is no one the space
  can ask for.
- **Channel admin** ([ADR 0007](docs/adr/0007-channel-admin-in-the-space-the-same-rules-asked-as-the-same-teammate-one-email-once-per-key.md)): what meet's own team page once did, asked of `SpaceMeet` with meet's rules unchanged and in meet's words. `channel` (the people of a channel the person is in, each with what they may do with them, and who can be added), `browseChannels` (open channels not joined: a name and a count), `createChannel` and `inviteGuest` (each with a compose key, kept as `channel:<key>` and `invite:<key>`), and `changeChannel` (join, leave, rename, archive, add, take out, remove a guest, delete a person: no key). **`inviteGuest` is the one email meet sends for the space**: the guest's invitation, from the install's meet sender address, linking to `/w`, when a teammate presses Invite, once per key. A guest never reaches the space and signs in at `/w`.
- **Compose key**: the key the space chooses once per message being written and sends with every `post`. A post that went out holds
  its key for a day (table `compose_keys`, with the first post kept to answer a repeat with, its words blanked if the message is
  deleted); a repeat answers Repeated and posts nothing, opens no second direct message. A post that was refused (the limit, the
  text, a target that is not there) or failed records nothing, so the same key posts next time. Everything that can refuse is
  checked before the first write.
- **Team socket**: a teammate's page opens no socket on this object. The space's live object holds it ([the space's ADR 0019](../space/docs/adr/0019-one-live-object-per-company-holds-every-open-page-and-every-store-tells-it-after-a-change-is-stored.md)); this object tells that object after it stores a change (`src/workspace-live.ts`) and asks it who has the space open for the nudge rule. Guests keep `/w/api/socket` here.
- **Call link**: built by the Worker from the install's space host (`appOriginOf`, `src/wiring.ts`; there is no address var), and by a page on the address it was opened at, which is the space's (`src/web/site.ts`).
  A link copied or pasted inside the space opens on `<space host>/r/`, which needs no sign-in; on a localhost run the page's own address
  is the public one.

- **Huddle**: a call started in a direct message or channel by anyone in it (a channel guest too, at `/w`), under the Meter, announced by one message that carries its link. A **Call link** made from an email conversation, a **New call** and a **Meeting** (a call booked with a time, the people invited, its name made ahead) are the other kinds. The Workspace keeps what each is for (`space_calls`); the Room and the Ledger do not know. A **card** is a call with its state: who is in it, when the first person took a seat and the last left. Meet sends no email for any of them. [ADR 0006](docs/adr/0006-calls-in-the-space-a-call-is-a-room-with-a-record-of-what-it-is-for-and-every-link-is-meets-own.md).
- **Messages and settings** ([ADR 0008](docs/adr/0008-messages-and-settings-in-the-space-the-same-core-methods-asked-as-the-same-teammate-and-a-message-in-a-conversation-you-are-not-in-does-not-exist.md)): the rest of what meet's own team page did in chat, asked of `SpaceMeet` as the same teammate: `peopleToMessage` (who a direct message may be started with, and whether it has something in it), `editMessage` and `deleteMessage` (the core's own rules and words; a message in a conversation the asker is not in, or that is not there, is the one refusal "There is no such message."), `me`, `updateMe` (a name, and `nudgesOff`, which must be a boolean) and `acknowledgePrivacy`. A first message to someone is `post` by `personId`, once per compose key, as before. Every message the space is given says what the person may do with it (`may`). None carries a key and none sends an email.
- **/start, retired**: there is no switch and no page. `/start` and `/start/` redirect to the space for anyone; the emails to teammates link to the space (`mail.ts`, `conversationsUrl`); meet has no Access application. What `/start` did is in the space (**Channel admin**, **Messages and settings**, calls, the Phone).

## The phone

Everything below is [ADR 0004](docs/adr/0004-phone-telnyx-behind-one-client-calls-held-until-meet-approves-rules-in-the-workspace-object.md)
(calls out) and [ADR 0005](docs/adr/0005-phone-calls-in-call-control-commands-ring-every-phone-then-the-cell-then-voicemail-in-the-phone-conversation.md)
(calls in). A **call** here is a phone call; the video **Call** above is unchanged.

- **The line**: the company's one number at Telnyx, shown to the person called with the company's name as the caller name. Its
  settings are written down in `src/phone-line.ts` and applied to Telnyx by `scripts/telnyx-setup.ts`.

- **Phone person**: a person with the dial pad: on the Teammate list AND named in the install's declaration (`phone.people`, with the number their 911 calls leave from), with the `phone` switch on. Never a guest, and never a
  teammate who is not named, whatever Access says. Their **emergency number** is the number their 911 calls leave from.

- **Dial pad** (the Phone, drawn in the space): a number box that takes any common US format, a keypad, Call, and while a
  call is on its number, state, timer, mute, tones (DTMF) and Hang up; the month's minutes; the person's recent calls; the 911
  setup. A call goes on while another screen is open, with a bar to hang up.

- **Parked call**: Telnyx's connection holds every call from a browser until meet's webhook says where it goes. meet answers
  with a dial from the line, or hangs the call up. A call to the number is parked too, and meet leaves it unanswered (so the caller
  hears ringing) until someone takes it or the voicemail starts.

- **Ticket**: the approval the page gets before it dials: random, kept hashed, good 60 seconds, for one number, spent by one call.
  The parked call must present it; the webhook runs the rules again. 911 is the only call with none.

- **Phone meter**: the month's phone minutes (`LINE.monthlyMinutes`, 1,000), each answered call rounded up to the minute and
  counted once when it ends. New calls are refused past it; the owner is emailed at 80% and 100%. Not the **Meter** above (the video
  allowance).

- **911 address**: the street address a person gives before their first call, registered at Telnyx on their emergency number. A
  call out waits until Telnyx holds it. The person acknowledges, once, a notice of when 911 from meet may not work. When 911 is
  dialed the owner is emailed who and from which address, and the same is posted in the Phone conversation, where it is kept.

- **Call in**: a call to the company's number, or to a Phone person's own 911 number (a dispatcher's callback is one, and rings like any
  other). It is worked in three **stages**, and is never refused or cut short by the month's cap: **meet** (every Phone person with a
  phone registered rings at once for the **ring time**, 20 seconds by default; the first to answer takes it and the rest are let go),
  then the **cell** (if one is set and the month's minutes are not used up), then the **voicemail**. A call in is a row of the call log
  (`direction` in), shown to every Phone person: `answered`, `forwarded`, `voicemail` or `missed`.

- **Ring leg**: one call meet makes to one teammate's browser phone for a call in (a Dial to their SIP address), linked to the
  parked call and not bridged until meet says so. The **cell leg** is the same for the cell. A leg has a row before Telnyx names it,
  so an event that arrives early still finds it; a leg is told by Telnyx's id, or by client state **with** the call's nonce and the
  leg's row, never by client state alone.

- **Line settings**: the cell unanswered calls go to (none by default: no number is in the repo) and the ring time, 5 to 40 seconds.
  Set in the Phone panel by the line's owner alone (an owner in the company declaration; other Phone people see them read-only); kept in `phone_settings`. The cell's own ring is fixed at 15 seconds.

- **Screening**: the cell, once it answers, is asked to press 1 ("Call for <company name>. Press 1 to answer."). Anything else, or nothing (its
  own voicemail answering), lets the cell go and sends the caller to the voicemail.

- **Voicemail**: a spoken greeting (Telnyx's voice), a beep and a recording of at most 3 minutes on the caller's leg. The only thing
  meet ever records, and only on a call nobody took: **no live call is ever recorded**. The sound stays at Telnyx, named by its id; it
  plays only through the space's phone route (`/space/phone/voicemail/<id>/audio`; meet fetches it each time and passes it on, so a browser never has a Telnyx address) and is
  deleted at Telnyx when a teammate deletes the voicemail. It is kept until then (Telnyx's own limit is a year, ADR 0005).

- **Phone conversation**: the conversation (kind `phone`, named "Phone") every teammate is in from the moment they are on the list
  and no guest ever is, in which "Phone", a sender that is not a Person, posts a **voicemail** (the caller's number, its length, a player
  and Call back), a **missed call** (a line, and Call back) and a **911 notice**. Nobody writes in it, adds anyone to it, leaves it or
  archives it. Unread, live delivery and the change feed are the workspace's. A voicemail is also emailed (number and length, never the
  sound) to each teammate under the direct-message email switch.

- **Phone desk** (`PhoneDesk`, workspace.ts): what the phone core may do in the workspace, and nothing else: post as Phone, remove what
  it posted, and ask who is owed an email. Not among the methods the router can call by name.

## Not here

Recording, a host role in a call, muting or removing others in a call, expiring
links, calls of more than 8, simulcast, end-to-end encryption. In the workspace: push notifications, @mentions,
files, reactions, threads, search, group DMs, online dots or a fallback for networks that block WebSockets.

The phone has no phones in meet calls and no dial-in, no greeting in a person's own voice (Telnyx's voice speaks
it), no transcription of a voicemail, and no recording of any live call.
