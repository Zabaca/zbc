# Meet's chat, calls and phone run in the space's Worker, and meet's two stores are handed to it

Status: accepted: one app at the space's address, each store moved by Cloudflare's transfer. This is the second stage of the move.
**Supersedes [0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md)'s "the apps keep their data" for meet** (the inbox is the one app left); amends [0009](0009-calls-are-cards-in-their-conversation-and-the-phone-is-meets-screen-held-by-the-shell.md)
(the phone's requests and the live socket are handed to meet's part in this Worker, not forwarded over a binding) and [0012](0012-channel-admin-is-meets-answer-drawn-in-the-conversation-and-the-invitation-is-the-one-email-it-causes.md) / [0013](0013-messages-and-settings-in-the-space-chat-is-meets-answer-drawn-where-the-conversation-is.md)
(meet's answer is a call in this Worker). The sign-in rule is the company layer's [ADR 0003](../../../workspace/docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md), which this extends to meet.
Followed by [0017](0017-the-inbox-runs-in-the-spaces-worker-and-its-store-is-handed-to-it.md), which takes the inbox in the same way (its table of what each Worker is supersedes the one below for the inbox and the knowledge forwarder). Follows [0015](0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md), whose shape (safe defaults, step files, a guard, a separate cleanup commit) this repeats.

## What changed

- **Meet's chat, channels, calls (huddles, call links, meetings, past calls with their saved chat), the Phone conversation, the dial pad's requests and the live socket** run in the Worker: `createMeetPartFactory` (`packages/meet/src/space-part.ts`) makes one value, called with the person the one sign-in check named (`SignedIn`).
  Its methods are `MeetForSpace` (the contract, now taking `SignedIn` where it took the Access assertion); its `fetch` hands the browser's socket upgrade and the dial pad's requests to meet's own routes (`space-app.ts`), which are `mountSocket` and `mountPhoneTeammates` and nothing else of meet's.
  The person is put in a `WeakMap` keyed by the very Request the app is handed, as forms' operator is, so it is for that request alone. Meet keeps the one rule that is its own: the person is one of the install's people (its `asAsker`), in the words the space has always shown.
- **Meet's two Durable Object classes are handed to this Worker by Cloudflare's transfer** (two classes in the same deploys): `WorkspaceDO` (the one object that holds every channel and chat) and `RoomDO` (one per call, and the usage ledger). Nothing is copied. They are found by the same fixed names (`WORKSPACE_NAME`, `LEDGER_NAME`, a call's name).
  The classes are defined in one file each (`packages/meet/src/workspace-do.ts`, `do.ts`) that both Workers build from, and `src/index.ts` exports them. `packages/meet/src/company.ts` takes the install from an alias (`@meet/declaration`), as forms' and the knowledge app's do, so a client's space built with `SPACE_DECLARATION` serves that company's people in the objects too.
- **Meet's sending, its phone secrets and its sweep are here:** the one `EMAIL` binding now allows the install's meet sender beside its forms sender; the phone's four Telnyx secrets are pushed when the secrets file holds all four (an install with no phone has none); the five-minute sweep (nudges, tidy-up, the phone's chores) is this Worker's `scheduled` handler from the move's step 5. The address meet's links are made from is its own var (`MEET_APP_ORIGIN`, meet's own host until the cutover); this Worker's `APP_ORIGIN` is forms'.
  **What did not move at this stage:** the call API and its SFU and TURN credentials, the channel guests' sign-in (and the per-caller limit on it), their pages and their socket, and Telnyx's webhook stayed on the meet Worker (meet's own host), reaching the same objects through bindings to this Worker's classes, until the guest paths moved here ([0018](0018-guests-and-signers-use-three-open-paths-of-the-spaces-host-with-no-sign-in-and-a-policy-that-keeps-their-pages-to-those-paths.md)) and the cutover.

## What each Worker was at this stage

| Worker | Is | Until |
|---|---|---|
| `space` | the page, the one sign-in check, forms' operator API and reads, the knowledge base and its store, meet's chat, calls, phone and live socket and its two stores, the Inbox tab (drawn from the inbox) | it is the whole app (the end state) |
| `meet` | the guests' side at meet's own host: call pages and API, channel guests, Telnyx's webhook, the guests' emails; both classes kept in its code and bound to the space's by name | the guest paths move in; the cutover deletes it |
| `forms` | the signers' pages and API, the hourly sweep, the database's migrations | the cutover, when the space is the only Worker |
| `knowledge` | a forwarder for the inbox's assistants | the inbox moves in; deleted at the cutover |
| `inbox` | unchanged: a Worker of its own behind a service binding, verifying the forwarded assertion | the inbox moves in |

The meet Worker is the exception to "no compatibility shims" the move itself plans (a deployed Worker, not a forwarding module, needed because outsiders' links and Telnyx name it); nothing may be added to it.

## Reading an older note

Until the cleanup that followed the move of this stage, the meet Worker also exported `SpaceMeet`, the old named entrypoint the LIVE space bound, which verified the Access assertion the space forwarded against `SPACE_ACCESS_AUD` and then called the very methods this Worker now calls in-process (`space-entry.ts`), so that the old space kept its Meet tab
through the steps that came before the new space was deployed and could be put back until then. The new space did not bind it. The cleanup deleted it, the var, the `space-access` import of the meet instance, the `space` option of meet's router and its assertion-checked `/space/phone` mount, and the step files of the transfer
(`wrangler.transfer-*.jsonc`, `wrangler.back-*.jsonc`) and `DO_TRANSFER_STEP`. **A note in a README, ADR, runbook or code comment that says the space binds `MEET`, forwards the assertion to meet, or that meet holds `SPACE_ACCESS_AUD`, was true until then and is not now.**
Those notes are left as the record of what was built and deployed at the time; this section is the one place that says so.

## Consequences

- **Every change to meet reaches two Workers, and only by an apply of each** (both build the classes; the space runs the part; meet's own Worker runs the guests' side). Neither is in CI. Apply `meet`, then `space`.
- **A bad deploy of the space now takes chat and calls down with the page**, as with every change that ships in the one Worker; meet's own host (guests, call pages) keeps working through its own Worker as long as the space's classes exist.
- **The sweep is in one Worker at a time:** meet's before the move, the space's after, none between steps 4 and 5 (the step files carry the cron, and `"crons": []` clears the other explicitly), so a nudge email is never sent twice.
- **The way back is zbc applies** (the rehearsed reverse, three deploys), never `wrangler rollback`. A plain apply during the move was guarded by the live bindings of both classes on both Workers (`classHome`, kept in the infra module for the next move); the defaults were the safe state before the move and the cleanup made the end state the default.
- **A moved object that is awake through the hand-over keeps running its old Worker's code until it restarts; one that is asleep at the hand-over wakes on the new Worker's** (seen in the first rehearsal and in the one before this stage). The Workspace object and the ledger have an explicit restart (an abort), a bookmark, a restore and a counts read, reachable only by the owner through the space (`POST /api/meet/store/{restart,bookmark,restore,counts}`, body `{"object": "workspace" | "ledger"}`); they touch no message, call or person and name no other object. A call's own object is never named: an idle one woke on the new code. The restart closes the Workspace object's sockets, which reconnect.
- **The rehearsal settled** two classes in the same deploys, a Vite giver going from `migrations` to `exports`, hibernating sockets and alarms across a transfer, a socket upgrade through a `script_name` binding, the receiver's default provisioning nothing, and `ctx.id.name`. **What only a live run shows**: meet's own deployed history, the giver's deploy with a socket open on it, and the restore route against a live object.
- **A move's own record** (the counts before and after, the bookmarks, any deviation) is written by whoever runs it, with the install; this ADR is not where it goes.
