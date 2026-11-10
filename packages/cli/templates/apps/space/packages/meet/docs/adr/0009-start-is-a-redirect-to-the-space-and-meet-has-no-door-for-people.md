# /start is a redirect to the space, and meet has no door for people

Status: accepted. The last step of retiring `/start`. Supersedes section 3 of [0001](0001-sfu-only-rules-in-the-room-access-on-start.md) (Access on `/start` alone, and the Worker checking the assertion) and the teammates' door of [0003](0003-workspace-one-object-two-doors-live-sockets-emailed-codes.md); the rest of both stands.

## What was decided

**`/start` and `/start/` are a plain 302 to the space's Conversations, for anyone, any method of reading, any browser.** The address is the install's (`install.tabs()`), not a literal of meet's, so a client company's meet sends to its own space. The answer is not cached. There is no switch: `apps.meet.sendPeopleToSpace` is removed from the company declaration, and so is the inbox's (neither app has an address to redirect from any more; both have `door: null`).

**Nothing under `/start/api` answers.** The Worker keeps `/start/api/*` before the asset router and answers a 404 in meet's words, so a tab left open at the old page gets an error it can show, not the single-page app's `index.html` (a 200 that its JSON parsing would read as an empty answer). The routes themselves are deleted: the call tools (usage, make a call, past calls, one call's chat, delete its messages), the teammates' workspace API and the phone's under it. Everything they did the space does through `SpaceMeet` (ADR 0006 to 0008) and `/space/phone`.

**meet has no Access application.** The declaration gives `apps.meet` a host and nothing else, the zbc instance has no `access` block, the Worker is no longer given `CF_ACCESS_AUD`, and the only audience it knows is the space's (`SPACE_ACCESS_AUD`). The application on `<meet-host>/start` is deleted in Zero Trust, by hand (no `zbc apply` deletes one), in the sitting of the deploy, rather than left for later. It cannot be taken back exactly: an earlier meet's apply makes a new application with a new audience.

**The emails to teammates say the space.** The unread-message nudge links to Conversations; the voicemail and the 911 notice to its Phone conversation; a guest's nudge and invitation still link to `/w`. The home page of the meet host links to the space (a literal pinned equal to the declaration by a test, because the declaration names the company's people and is not bundled into a public page).

**Kept, because outsiders and the space use them:** `/`, `/w` and the guests' workspace, `/r/<name>`, the call API, the guests' API and socket, the phone's webhook, the `SpaceMeet` entrypoint, and the page code the space draws from (the phone's screens and hook, the API helper's `ApiError`, the link parser).

## What it costs

- The Workspace page of `/w` is now the guests' alone. Its screens for a teammate (channel admin, the phone, the call tools) are deleted from it, including the conversation pane's rename, leave, archive and members administration and the sidebar's New channel and Browse. A guest sees the people of a channel and can message them, and nothing more.
- The tests drive a teammate through a door that exists only in the test harness (`Harness.teammateApp`, mounting the same handlers behind a signed assertion at `/tm/w`) because most of the Workspace's rules are about a teammate as the actor. The real router answers nothing there, and a test says so.
- The live browser checks for the teammates' page (`test:workspace`, `test:phone`) are deleted with their subject; the guests' flows are covered by the router tests and, after a deploy, by the hand check in the README (`Retiring /start`, check 3); the space's own end-to-end tests cover what a teammate does.
- A call made in a local run needs `POST /api/dev/rooms` (a localhost run with the bypass only), since the route that made one is gone.
