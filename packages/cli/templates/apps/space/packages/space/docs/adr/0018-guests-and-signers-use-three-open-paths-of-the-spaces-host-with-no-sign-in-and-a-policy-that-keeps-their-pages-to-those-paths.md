# Guests and signers use three open paths of the space's host, with no sign-in, and a policy that keeps their pages to those paths

Status: accepted. A stage of the move to one Worker, after [0017](0017-the-inbox-runs-in-the-spaces-worker-and-its-store-is-handed-to-it.md).
**Supersedes [0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md)'s "outsiders keep their addresses"** for call guests, channel guests and signers; amends [0016](0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md)
(the call API, the guests' sign-in and Telnyx's webhook are this Worker's now, not the `meet` Worker's) and [0015](0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md) (forms' public API and its hourly sweep run here).
The sign-in rule for everything else is still the company layer's [ADR 0003](../../../workspace/docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md).

## The paths

Three prefixes of `space.<company domain>` need no sign-in. They are the layer's (`GUEST_PREFIXES`, `packages/workspace/src/guests.ts`), and the Access applications, the Worker's router and the build all read that one list.

| Prefix | Who | Page | API | The page's files |
|---|---|---|---|---|
| `/r/` | anyone with a call's link | `/r/<name>` | `/r/api/...` (meet's call routes; Telnyx's webhook at `/r/api/phone/webhook`) | `/r/_/...` |
| `/w/` | a channel's guests | `/w/` | `/w/api/...` (the emailed-code sign-in, their channels, their live socket `/w/api/socket`) | `/r/_/...` (one bundle serves both) |
| `/s/` | a signer | `/s/<token>` | `/s/api/...` (forms' public API: `/s/api/s/<token>/...`, a client's logo `/s/api/logo/<id>`) | `/s/_/...` |

Everything else on the host is behind the sign-in, as before. Each API path goes to the part that always answered it, with the credential that path takes and nothing else: a call's name and member token, meet's session cookie (now `Path=/w/api`) or a socket ticket,
Telnyx's signature, a signer's private link. `AUTH_LIMIT` and `PUBLIC_LIMIT` (new namespace ids, 7304 and 7303) limit the guests' sign-in and forms' public API per caller as before.

## The edge: a bypass, in code

Each prefix is an Access application of its own with Cloudflare's Bypass policy for everyone (`space-guest-calls`, `space-guest-chat`, `space-guest-signing` in the install's infra environment; the `cloudflare-access` module learned `bypass: true`, with its own policy reader so that a bypass can never be read as a people policy and a people policy that gains an
`everyone` rule is still rewritten). The domain is the prefix's subtree, `space.<company domain>/r/*`, never the bare prefix, so it can match nothing of the team's own (`/sw.js`, `/recover`). Access serves the most specific application, which is the assumption the live outside checks prove (it is the same one the Forms application relies on at `/forms`).
Bare `/w` is not opened by the edge; the Worker sends it on to `/w/` and every link we send says `/w/`.

## The Worker: answered first, never by the person check

`app.ts` calls the guest door (`src/guests.ts`) ahead of Claude's door and of `whoIsAsking`. A path under a prefix gets an answer from there and nothing else; any other path goes on to the checks as ever. Two things follow, and a test holds each.

- **A team assertion opens nothing of a guest's, and a guest's credential opens nothing of the team's.** The guest side is handed the request without the Access assertion, the Access cookies (by name; the guest's own cookie stays) and the service token's headers (`asGuest`), and the person check is not run for it; no team path reads a guest cookie.
- **An unknown path under a prefix is a 404, never the team's page.** The asset router's answer for a missing file is the team's `index.html`, so a guest page is served only if it carries `<meta name="guest-bundle">` (a missing bundle is a 503) and a missing guest file is a 404 whatever the router said.

## What a guest page cannot reach

A guest page is on the team's origin, so a signed-in person's browser would send the team's cookie to anything the page asked of the host. Two things keep a page to its own paths, and neither alone is enough.

1. **A content policy whose every source is a path** (`policyFor`): scripts, styles, images, fonts, workers and connections may come from the bundle's folder (`/r/_/`, `/s/_/`) and the guest API (`/r/api/`, `/w/api/` and `wss://` its socket, or `/s/api/`) and from nothing else of the host; `default-src 'none'`, no `'unsafe-inline'` or `'unsafe-eval'` for script (`'wasm-unsafe-eval'` for the noise suppression, the blur and pdf.js), no frames, forms, `<base>` or plugins, no framing of the page. The policy rides on the pages and on every script (a worker is governed by the policy of its own response).
   Measured in headless Chromium against the built bundles under this exact policy: the call lobby's noise-suppression worklet and wasm run, the blur's engine and model run, and the signer page renders a real PDF through pdf.js, all with no policy violation.
2. **No outsider's words become markup or script.** The two bundles draw text only (a test over their sources refuses `dangerouslySetInnerHTML`, `innerHTML`, `eval` and the like). The team's writes also keep needing the page's own header and `Origin`, which a guest page could still send; this is why the first item is the point, and why it must stay: **a new directive that names a whole-host source (`'self'`, `https://space.<company domain>`) in a guest policy is a hole**, and a test fails it.

The bundles are served from their own folders and built separately (`vite.guest-meet.config.ts`, `vite.guest-forms.config.ts`, after the space's own build), so the team page's files (`/assets/...`) still need the sign-in. Page and files carry no referrer, no cache for a page, no framing, no indexing.

## What every email now links

*(Amended by workspace ADR 0005: the address is the install's space host, read from the declaration by forms' signing core and meet's wiring, and `MEET_APP_ORIGIN` and `APP_ORIGIN` are no longer settings of the Worker.)* `MEET_APP_ORIGIN`, `APP_ORIGIN` (forms') and both old Workers' `APP_ORIGIN` are `https://space.<company domain>`: a call link is `/r/<name>`, a channel invitation and a nudge to a guest `/w/`, a signing request, reminder and completion `/s/<token>`, and a client's logo in an email `/s/api/logo/<id>`. The page makes and recognises call links on the same address (`Me.apps.meet` is the space's). Meet's and forms' own hosts kept answering until the cutover for links already sent, with their pages calling the new API paths (and the old ones, for a tab loaded before the move); after the cutover an old link simply stops: nothing redirects it.

## The sweep and the migrations

Forms' hourly sweep is this Worker's third cron (`0 * * * *`); forms' Worker clears its own. Forms' D1 migrations are applied by this Worker's instance (`migrations_dir` names forms' folder); the `forms` instance no longer migrates. CI's `deploy-forms` **stayed until the cutover**: the old Worker serves signers on links already sent and must keep the code the database is migrated for.

## Consequences

- **Every change to forms or meet reached three Workers by hand-applied deploys** until the cutover (forms and meet in CI or by hand, the space by hand). Apply `forms` and `meet`, then `space`.
- **The edge and the Worker can disagree only by someone editing one by hand.** The Worker answers a guest path whatever the edge does, so a deleted bypass makes guests see a sign-in page (visible, safe); an extra bypass on a team path would show a team page's request with no assertion, which the Worker refuses with a 401 (visible, safe).
- **What no test here can show** is the live edge: that Access really serves the bypass on `/r/*` and not on `/sw.js`, and that a real call, a real emailed code and a real signing run through the new paths. Outside checks and a hand test cover those.
