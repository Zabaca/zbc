# Forms is a frame on its own admin, with a day-long sign-in of its own

Status: accepted. Builds on
[0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md).

**Replaced in part by [0007](0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md) : the Forms tab is no longer a frame.** What stands from this
record: the two sign-ins on one host (the Forms application, its cookie path, the audiences, the daily code), the reads, `forwardRequest` taking the cookie off, and the first-visit
recovery (`recover.ts`). What 0007 replaces: the frame itself, "What the frame carries", "Never sign in inside the frame" (a lost session now reloads the page itself), the `/forms/app/` and
`/forms/assets/*` prefixes, and `frame.ts`. Read the sections below as the history of how the frame worked.

## What the Forms tab is

The space owns `/forms`: the same shell as every tab, with the four tabs beside it. The Forms screen in it is a frame on forms' own
admin page, not a re-drawing of it. The forms admin kept its screens, its API and its tests; it learned to be served from the
space's address (its page names its files under `/forms/assets/`, its API calls follow the address the page was opened at). The
space hands three prefixes to the forms Worker over a service binding, with the Access assertion header passed along and the cookie
dropped: `/forms/app/` (forms' `/admin/`), `/forms/api/*` (forms' `/admin/api/*`) and `/forms/assets/*` (the page's files). The URL keeps the
space's host, so forms' own cross-site check sees the Origin the browser sent. Nothing else of forms' is reachable through the space:
the signer's pages and API stay on the forms host, and a path under `/forms` that is none of the three is the
space's own page. A frame, not a component, because forms is a separate app with its own build, tests and release; the cost is that forms'
own header and navigation show inside the frame, and the tab's page is not a single document.

## Two sign-ins on one host

A month for the space and a day for Forms cannot be one Access application. The Forms application is a second one, on
the `/forms` path of the same host, and Access answers a request with the most specific application it has. So the assertion on a
`/forms` request is for the Forms application's audience and on every other path for the space's. The space's Worker checks the audience
the path calls for (`CF_ACCESS_AUD_FORMS` on `/forms` and under it, `CF_ACCESS_AUD` elsewhere), and forms checks the same assertion
again against the Forms application's audience with the company layer's header-only check. A Forms assertion is no good on `/today`
and the space's is no good on `/forms`, and each Worker refuses an unset audience for its paths. The application is its own zbc
instance (`space-forms-access`, shaped like the inbox's) because two Workers need its audience, and forms imports it so that the Worker which
checks the audience is deployed after the application that issues it.

The declaration says this as `apps.forms.tab: "forms"`: the app's screens live under that tab, its Access application is the tab's path of
the space's host with the app's own session length, and its old `door` is the address that redirects.

## The old address

`forms.<your-domain>/admin` redirects a read of the page, at any path under it, to the Forms tab (a 302, the browser keeping the fragment, so a
bookmarked `#/clients` lands there). The same page asked at the space's address is served, which is how the space asks, and a local run
serves it where it is. `/admin/api` is not redirected. There is no machine path under `/admin` today; Claude's door will
be one and stays on the forms host, outside the redirect. The Access application that used to sit on `forms.<your-domain>/admin` is no
longer managed by anything and is left in Zero Trust for a person to delete once the space works.

## What the frame carries

The admin's own brand bar and "Signed in as" line are not drawn inside the space, which names the company and the person; its section
navigation (Clients, Envelopes, Forms, Documents, Seal, History) stays. A client's logo is asked for as `/forms/logo/<id>`, which the
space forwards to forms' public `/api/logo/<id>` (and marks private), so the image stays on the space's address.

## The reads

`SpaceForms`, forms' entrypoint for Today and People (title, state and the names of signers who have not signed, never an answer),
took the assertion as an argument and checked it against the space application's audience, not the Forms one: that is the assertion the
space holds. See `packages/workspace/docs/adr/0001`. **Since [0015](0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md)) the same reads run inside the
space's Worker and take the person its one check named (`packages/workspace/docs/adr/0003`); the old `SpaceForms` entrypoint is deleted (see 0015).**

## How the two sessions share a host

Measured live, with a real one-time-PIN sign-in in headless Chrome:

- **The cookie's path is what keeps them apart.** With Cloudflare's `path_cookie_attribute` off (its default), both applications write
  the one `CF_Authorization` cookie on the host with Path=/, and the Forms application's replaces the space's: a month's session falls to
  a day. On, the Forms application's cookie is Path=/forms and a day, and the space's (Path=/, a month) is never touched. The Forms
  application sets it (`pathCookieAttribute` in `space-forms-access.ts`, taught to the `cloudflare-access` module, which reports it
  on apply); the space's and the inbox's do not.
- **Access's gate reads only the FIRST `CF_Authorization` in the Cookie header.** Browsers send the longer path first, so on `/forms` the
  Forms cookie is first and wins, and on every other path only the space's matches. **The nesting works only because browsers order
  cookies by path length.** A replay with the space's cookie first and the Forms cookie second got a sign-in redirect although a valid
  Forms cookie was in the header.
- **So the space must never rebuild a Cookie header.** What it forwards to forms has the cookie taken off altogether (`forwardRequest`,
  `src/forms.ts`), and it must stay so: a forwarded or reassembled header in another order would put the wrong cookie first.
- **Access matches paths without regard to case; cookie paths are case-sensitive.** `/FORMS/app/` reaches the Forms application
  carrying only the space's cookie. The space's own links are lowercase, and the Worker checks `/forms` without regard to case too
  (`audienceFor`, `src/app.ts`), so an upper-case spelling gets the Forms audience's check and is the space's own page, never forms'
  (`formsPathFor` is exact). A typed `/FORMS/...` may also loop at Access's sign-in: the Forms cookie is Path=/forms and is never sent
  to `/FORMS`. Nothing links there and the space's links stay lowercase, so this is left as it is.
- **A frame may be signed in silently, or may not.** A frame of `/forms/app/` on a Today page got the Forms session silently through
  the team domain in headless Chrome with default cookies. Where third-party cookies are blocked (Safari's default) the team domain's
  cookie is not sent inside a frame and that re-issue probably fails. The design therefore never depends on it.
- **The daily code exists only because Zero Trust's global session is 24h** (`session_duration` on the organisation is null today,
  which Cloudflare treats as a day). The global session does not cap an application's own (the space's and the inbox's are a month,
  longer than it); it decides whether renewing an expired application session needs a code. At a day or shorter every renewal does, so
  Forms asks daily; if anyone raises it, an expired day's session renews silently, Forms stops asking, and nothing in any file changes. The `cloudflare-access` module prints the global session on every apply
  (`globalSessionNote`) and says so when a day's application will no longer ask again daily.

## Never sign in inside the frame

Access can send a whole page to its sign-in and cannot send a frame: its sign-in page refuses framing. So the space never signs in
inside the frame. When the frame leaves the space's origin (`frameLeftTheSpace`, on the frame's `load`) or the admin inside it says its
sign-in ended (forms' `SignedOut`, which posts `forms-session-lost` to its parent, checked for origin, frame and word by
`isSessionLost`), the space reloads `/forms` as a whole page. A load of `/forms` is
covered by the Forms application, which renews its session before the frame loads. One renewal per three minutes (`renewSignIn`, as the recovery below is once per two): a refusal that does not
go away, on a phone where a reload takes half a minute, is shown after the first renewal and not reloaded about every quarter minute for good. After that the person is shown a link, never a loop, and where there is no storage to remember a try in nothing reloads. For the same reason
the Forms tab's link is a full page load (`ownSignIn` in `/api/me`), not a move inside the page.

A failed call is not by itself the sign-in ending: a `fetch` cannot tell a dropped connection from Access's redirect, and reloading on
a blip as someone presses Save would throw away what they typed (a new client, an envelope's recipients, the seal screen's poll). So
the admin probes `/me` with the redirect left unfollowed (`signInEnded`, `packages/forms/src/client/base.ts`): only an
`opaqueredirect` or a 401 tells the space; anything else, or no answer, keeps the in-page "Reload the page" message with the input
still there. A 401 or a followed redirect on the call itself is already the answer and needs no probe.

## A first visit to /forms with no space session

`/forms` is the Forms application's and the page's own files (`/assets/...`) are the space's. Someone who opens `/forms` with only the
Forms session (the first visit after a month, or an old bookmark of the forms admin address) gets the page and none of its files, and a blank
screen. The page therefore carries a small inline script ahead of its files (`src/recover.ts`, put in the page by `vite.config.ts` and
allowed in the content security policy by its hash, from the one source): when one of the page's own files fails on a `/forms` path it
remembers the place and sends the whole page through `/today`, which Access signs in to, and the page returns to where it was
(`takeRecovery`, only to a place in the Forms tab, only within ten minutes, once). One try per two minutes. The alternative, serving
the page's files under `/forms`, was not taken: the shell's `/api/me` would need the same, and the page would be two copies of itself.

## What this does not settle

Whether the frame works in Safari with third-party cookies blocked is not shown by anything here, only that nothing depends on it: a
frame that is not signed in is reloaded as a whole page. A check after a deploy should include a phone
in Safari, which is where it would show.

## The space's cookie is SameSite=Lax

Once the space accepts writes (a reply, a post, a mark read, ADR 0004), its whole-host application (`space-access`) sets `same_site_cookie_attribute: lax`
(the module's `sameSiteCookieAttribute`, compared on every apply the way `pathCookieAttribute` is): a browser does not send the Access cookie on a
cross-site POST, so a page elsewhere cannot make it carry the sign-in into one. The Worker's own `Origin` and JSON checks stay; this is the second layer.
What Lax does not break, as checked: Access's callback and the first-visit detour are top-level GETs, and the live socket and the Forms frame are
same-site (the Forms frame is the space's own address). **The Forms application (`space-forms-access`) is left as it is on purpose:** its silent renewal runs
inside the frame and crosses sites, and a Lax cookie would stop it. **A cookie already issued keeps `SameSite=None` until its session ends** (a month for the
space's, so the setting is fully in effect a month after the apply; a new sign-in gets Lax at once).
