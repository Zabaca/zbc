# meet

Browser video calls, through Cloudflare's Realtime SFU with its TURN relay as the fallback.
A prototype for finding out whether a call a company runs itself can be good with noise cancellation,
background blur and screen sharing, on the phones, laptops and networks guests really bring. Up to 8 people.

**This package is a library, with no Worker of its own.** meet's chat, calls and phone for a company's people run IN the space's Worker (`src/space-part.ts`, called with the person the space's one sign-in check named), over two Durable Object stores (the Workspace and the call objects) that the space's Worker owns ([space ADR 0016](../space/docs/adr/0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md)). The guests' side is the space's too: the call API under `/r/api` (Telnyx's webhook at `/r/api/phone/webhook`) and the channel guests' API under `/w/api`; the page is this package's bundle built into the space (`packages/space/vite.guest-meet.config.ts`) and served at `/r/<name>` and `/w/` with no sign-in, and every link meet sends is on the install's space host ([space ADR 0018](../space/docs/adr/0018-guests-and-signers-use-three-open-paths-of-the-spaces-host-with-no-sign-in-and-a-policy-that-keeps-their-pages-to-those-paths.md)). meet has no host, Worker, instance or Access application of its own.

Beside the calls, a workspace of channels and direct messages: a company's people work in the space, which calls meet in-process; guests invited to a channel sign in at `/w/` with a 6-digit code meet emails. There is no team page in meet: everything a teammate does is in the space. The workspace has text, live delivery, unread marks and an email for a direct message left unread.

Beside both, a phone for the company's people, drawn in the space: dial any US number from the browser, with the company's number as the caller ID,
under a monthly minute cap, with 911 and an email to the owner whenever anyone dials it; and take calls to the number: it rings every
person with meet open, then a cell, then takes a voicemail that lands in a Phone conversation only the company's people are in. Telnyx, behind one client
([ADR 0004](docs/adr/0004-phone-telnyx-behind-one-client-calls-held-until-meet-approves-rules-in-the-workspace-object.md) for calls out,
[ADR 0005](docs/adr/0005-phone-calls-in-call-control-commands-ring-every-phone-then-the-cell-then-voicemail-in-the-phone-conversation.md)
for calls in). Phones in meet calls are not built. The phone is hidden until the Telnyx account's four secrets are in the install's secrets (below).

- Vocabulary is normative: [`CONTEXT.md`](CONTEXT.md). Read it first.
- Decisions: [`docs/adr/`](docs/adr/).
- Deployed with the space: `bunx @zabaca/zbc apply <env> space` (there is no `meet` instance). `dev/` holds a LOCAL Worker for `bun run dev` and the live browser checks below (never deployed). A deploy restarts the Worker, so a call in progress drops: deploy while no call is running.

## Routes

All of them are the space's Worker's, at `src/space-guests.ts` (the guest paths, open with no sign-in, each answered with its own credential) and `src/space-app.ts` (the team's socket and phone, for the person the space's check named). The local Worker (`dev/worker.ts`) mounts the guest paths and one development route.

| Path | Who | What |
|---|---|---|
| `/r/<name>` | anyone with the link | The lobby, then the call (the guest bundle's page). `?relay=1` forces the TURN relay (a test switch); `?blur=canvas` forces the canvas path for blur; `?debug=1` shows the diagnostics panel (what the sound is doing) in the lobby and the call, for a screenshot when something goes wrong |
| `/w/` | guests | The guest sign-in (an address, then the emailed code), then the same workspace, with only their channels |
| `GET /r/api/rooms/<name>` | anyone | Is it a call, how many are in it, is it paused |
| `POST /r/api/rooms/<name>/{join,checkin,publish,unpublish,subscribe,renegotiate,unsubscribe,leave}` | a member (token header) | The call. Joining needs no sign-in |
| `POST /r/api/rooms/<name>/chat` | a member (token header) | Send a chat message. Reading is the check-in's reply (`since` in, `chat` out) |
| `POST /w/api/auth/{request,verify}` | anyone | A guest asks for a code and enters it; the same reply for every address, limited per caller (10 a minute) by a Rate Limiting binding before the workspace is asked anything. Sets the session cookie, scoped to `/w/api` |
| `/w/api/*` | a guest (session cookie) | The workspace API: bootstrap, ticket, messages, read marks, settings, plus the guest's devices (`/sessions`) and `/signout` |
| `GET /w/api/socket?ticket=` | a ticket from a guest's session | The live connection (WebSocket). The ticket is spent on first use and lasts 60 seconds |
| `POST /r/api/phone/webhook` | Telnyx | Calls parked at Telnyx, calls to the number and what happens to each leg arrive here; read only when signed by Telnyx (Ed25519, within 5 minutes). 404 until the phone is configured |
| `/api/phone/dev/*` | a localhost run with `FAKE_TELNYX=1` | The stand-in phone reports its calls here as Telnyx's webhook would. 404 anywhere else |
| `POST /w/api/conversations/<id>/huddle` | anyone in the conversation (a guest's session) | Start a huddle: a call made for the conversation under the meter, announced by one message with its link (the compose key is the page's, once per press) |
| `GET /space/phone[/...]` | the space only: `src/space-app.ts` mounts it in the space's Worker for the person its check named | The phone: status, acknowledge, the 911 address, a login token, the approval for one call, the 911 report, the log, the line's settings, and a voicemail's sound and its deletion, for the dial pad drawn in the space (a person named on the phone list; no guest has any of it) |
| `POST /api/dev/rooms` | a localhost run with `ALLOW_UNAUTHENTICATED=1`, in the local Worker only | Make a call, for the live checks. Not in the space; the space makes calls in production |

## Run it

```bash
bun install
cd packages/meet
bun run dev          # http://localhost:4812, the LOCAL Worker (dev/) + Durable Objects + the guest page via the vite plugin
bun test test        # the room's rules, the door, and the browser's pure logic (sound decisions too). No network
bun run test:audio   # the sound features in real Chrome with a stubbed call API: no secrets, no SFU (below)
bun run test:chat    # chat between real tabs, with a stand-in SFU: no secrets (below)
bun run telnyx:setup # the one-time Telnyx account setup: a dry run unless given --apply (below)
bunx tsc --noEmit
bun run build        # builds the local Worker and page (dist/); the space builds the page it serves itself
```

Calls need the two secrets, so `bun run dev` against the real SFU wants `packages/meet/dev/.dev.vars` (gitignored; wrangler never
uploads it; it sits beside the local Worker's wrangler file). Make it from the install's sops file without printing a secret
(`<secrets.yaml>` is your environment's encrypted secrets file):

```bash
cd packages/meet
{
  printf 'MEET_REALTIME_APP_SECRET='; sops -d --extract '["MEET_REALTIME_APP_SECRET"]' <secrets.yaml>
  printf '\nMEET_TURN_KEY_TOKEN=';     sops -d --extract '["MEET_TURN_KEY_TOKEN"]' <secrets.yaml>
  printf '\nALLOW_UNAUTHENTICATED=1\n'
} > dev/.dev.vars
```

`ALLOW_UNAUTHENTICATED=1` turns on `POST /api/dev/rooms` and the development mail route, on a localhost host only. It is
how a local run starts a call. (The two no-secret checks below pass the same flags in the environment instead, as shown.)

## The live check

With `bun run dev` running and the `dev/.dev.vars` above, `bun run test:live` (or
`bun scripts/live.ts --shots <dir>`) drives Chrome with its fake camera and microphone against the real SFU:
two tabs connect and their received audio and video packets keep rising, noise cancellation and blur switch
without the call dropping (and the published sound is quieter with noise cancellation on), mute and camera-off
show to the other tab, a fake screen share appears and stops and can start again, a tab forced onto the relay
connects over a relay pair, a forced reconnect and a refresh both land back as the same person. It uses a few
MB of the free 1,000 GB. If Playwright's own browser is not installed, pass `--chrome <path to Chrome>`. With
`--video person.y4m` Chrome's fake camera plays that file instead of its test pattern.

It also checks the sound features against the real SFU: the level bar on your own tile moves with the fake
microphone, and a tab whose noise-cancellation worklet cannot load, and one whose worklet loads and outputs
silence, each send the raw microphone track, say so, and are still heard by the other tab (its audio bytes keep
arriving, and its tile lights while it talks; this one plays a speech-like file as its microphone, because the
Self-check rightly ignores Chrome's own beeps).

What the checks cannot judge is how it sounds and looks to people: noise cancellation, blur quality and phone
performance are for a person to judge by trying a call on real devices.

## The sound check

`bun run test:audio` (or `bun scripts/audio.ts --shots <dir>`) needs only `bun run dev`: it drives Chrome with
its fake microphone against the real page, and answers the call API itself, so it runs in a worktree with no
secrets. It checks the level bar (lobby and own tile, noise cancellation on and off, empty while muted, and
still moving while the audio context is asleep), the Self-check (a worklet that outputs silence, one that cannot
load, an audio context that never starts, and a processed path that dies mid-call, each ending with the raw
microphone track on the sender and the notice shown; the switch testing the path again; a context that stops
and runs again; a Safari that holds the worklet until a tap, with and without the tap), the microphone picker in the lobby and in the call (the published track stays the same), a remote
person's Speaking light (a real WebRTC loopback stands in for the SFU), the Not arriving flag ("No sound arriving"), a
microphone the SFU refuses, and `?debug=1`. What it cannot check is the SFU: that audio reaches the other tab
after a fallback is in `bun run test:live`.

## The chat check

`bun run test:chat` (or `bun scripts/chat.ts --shots <dir>`) needs a dev server started with the stand-in SFU, which
carries no media and is honoured on a localhost host alone (`src/dev-realtime.ts`):

```bash
FAKE_REALTIME=1 CLOUDFLARE_INCLUDE_PROCESS_ENV=true ALLOW_UNAUTHENTICATED=1 bun run dev
```

It drives three real tabs through the real Worker and Durable Objects: a message each way with names and times, the
unread badge, a link that opens in a new tab with `rel="noopener noreferrer nofollow"`, markup shown as text, a late
joiner who sees the history (and does not count it as unread), the length and rate limits, and a name nobody started taking no message. (The past calls list, its saved chat and deleting it are the space's, and its own checks cover them.) The rules themselves
(membership, rate, length, delete, owner-only routes, ghost rooms, migration of an old call) are in
`test/chat.test.ts` and `test/room.test.ts`.

## The Telnyx account

The phone shows nobody a dial pad until all four of these are in the install's secrets (sops) and
the space is applied: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` (the webhook's public key, from the portal), `TELNYX_CONNECTION_ID` and
`TELNYX_NUMBER` (E.164, the install's own line). The deploy instance pushes them only when sops holds all four and fails to load when it holds some. Once
the account exists, with `SPACE_DECLARATION` naming the install's `workspace.json`: `bun scripts/telnyx-setup.ts` (a dry run that reads the account), then `--apply`, then `--apply
--buy` (which spends money: a number is a monthly charge, and a rerun never buys a second one unless given `--buy-another`); it prints the ids to put in sops and the steps it cannot do (prepaid
balance with automatic top-up off, the public key, the Free Caller Registry). The hand test is at the end of ADR 0004, and
calls in have their own at the end of ADR 0005: what Telnyx's documentation did not settle (that a call to the number reaches the
webhook, that an unanswered caller keeps hearing ringing, the press-1 event's fields, the recording event's fields, how long Telnyx
keeps a recording) is listed there, each as a step. In the page, set the cell and the ring time in the Phone panel first: with no cell,
an unanswered call goes straight to voicemail. The page's content security policy names `wss://rtc.telnyx.com`; if the dial pad says "Not connected", that policy is the first thing to look at. The dial pad drawn in the space has to be tried against a real Telnyx account once before it is trusted: nothing in the tests reaches Telnyx.

## Running notes

- **People.** A person is one entry in the install's company declaration (the file the workspace package reads, which the inbox, forms and the space read too). Adding or removing one is that edit and an apply of the space; the person's seat in Zero Trust is freed by hand if they leave (the account sets no seat expiry). Access's allow list in Zero Trust is every person's sign-in address in the declaration, and its session length is the declaration's.
- **Email.** meet sends mail through the `send_email` binding (`EMAIL`): the guest's invitation, their sign-in codes, the unread-direct-message nudge, a voicemail notice and the 911 notice. The one email the space makes meet send is the invitation when a teammate presses Invite (once per compose key). The first invitation to an outside address shows whether a guest's email lands in an inbox or in spam. If an invitation does not leave, the page says the person is in the channel but the email could not be sent and that pressing Invite again sends it: the `EMAIL` binding is the first thing to look at (it is the sign-in codes' binding too).
- **The nudge's timer.** The 15-minute unread nudge is meet's own, on its own timer (every 5 minutes, `wrangler.jsonc`); the person's setting only says whether it is wanted.
- **Switches.** The phone is a company-layer switch (`phone`): an install without it has no Telnyx, no dial pad and no webhook, whatever secrets the Worker holds; with it on, only the people named in the declaration's `phone.people` see the dial pad.

## Shape

- `src/room.ts`: every rule about a call, over the Durable Object's synchronous SQL. Never calls the network.
- `src/app.ts`: the call routes and the owner's tools, and the Access check. Everything external (the SFU, TURN, Access keys,
  the workspace object, the mailer) arrives as `Deps`, so `bun test` drives real requests through it with fakes.
- `src/workspace.ts`: every rule about channels, direct messages and people, over the Workspace object's SQL. Never
  calls the network ([ADR 0003](docs/adr/0003-workspace-one-object-two-doors-live-sockets-emailed-codes.md)).
  `src/workspace-do.ts` is its object (WebSockets, the alarm), `src/workspace-routes.ts` its two doors,
  `src/workspace-model.ts` the shapes and limits both sides share, `src/workspace-sockets.ts` the pure socket decisions,
  `src/mail.ts` the three emails, `src/cron.ts` the nudge sweep, `src/door.ts` what the two routers share, and
  `src/company.ts` the company this Worker serves (the install's declaration, read through `packages/workspace`: the teammate list, who owns it, the Access session length). There is no bar of links to the other apps: the team's one address is the space.
- `src/space-meet.ts`: what meet answers the space: the logic of `SpaceMeet` (the contract's name; the space's Worker calls it in-process through `src/space-part.ts`, shapes in `packages/workspace/src/meet-for-space.ts`). The core's
  side is `WorkspaceCore.space*` in `src/workspace.ts`. `src/web/site.ts` is the address call links are built on and recognised from.
- `src/phone.ts`: every rule about the phone (who may call, which number, whether, the meter), over the Workspace object's SQL;
  never calls the network ([ADR 0004](docs/adr/0004-phone-telnyx-behind-one-client-calls-held-until-meet-approves-rules-in-the-workspace-object.md)).
  `src/phone-routes.ts` its three doors and what the router does, `src/phone-model.ts` the number and address rules both sides
  share, `src/phone-line.ts` the line's settings (and the secrets list), `src/telnyx.ts` everything said to or heard from Telnyx,
  `src/telnyx-setup.ts` the account setup, `src/dev-telnyx.ts` a stand-in for local checks, and `src/web/phone/` the page's phone
  (Telnyx's SDK or the stand-in, the pure dial-pad logic, the hook that holds a call, the panel).
- `src/calls.ts`: making a call for every door that does (the meter, a name, the Room, the ledger's index, then the workspace's record). `src/space-app.ts` also mounts the phone's requests the space forwards, checked against the space's application. The calls' logic for the space is in `src/space-meet.ts` and its rules in `WorkspaceCore.call*` and `space*` (`src/workspace.ts`, table `space_calls`); [ADR 0006](docs/adr/0006-calls-in-the-space-a-call-is-a-room-with-a-record-of-what-it-is-for-and-every-link-is-meets-own.md).
- `src/dev-realtime.ts`: an SFU that carries no media, for local checks only.
- `src/realtime.ts`: a small typed client for the SFU's sessions and tracks API and the TURN credential call.
- The sign-in check is the company layer's (`packages/workspace`, `identify`); meet keeps no verifier of its own.
- `src/web/workspace/`: the workspace page: `store.ts` (what the page holds and how changes apply to it, pure),
  `connection.ts` (the socket, its backoff and what to do when a ticket is refused), `links.ts` ("Join call"),
  `api.ts` (the requests at either door) and the components.
- `src/web/call/`: the browser's call controller, its first-in-first-out queues, the reconciler and the quality
  step; `audio-health.ts` holds the pure sound decisions (level, speaking, the Self-check, the Not arriving
  watch). `src/web/effects/`: the microphone graph (RNNoise, with its level readers and the one shared
  AudioContext in `levels.ts`), the camera and blur, screen capture.
- `public/models/selfie_segmenter.tflite`: MediaPipe's selfie model (Apache-2.0), 250 KB, served from this app's
  own assets. The 14.5 MB engine comes from `node_modules` at build time and loads only the first time blur is
  turned on.
