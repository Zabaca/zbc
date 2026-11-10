# Forms' screens are the space's own page, and forms keeps the API

Status: accepted. Forms' screens move into the space
app itself, with no frame. Replaces the frame in [0002](0002-forms-is-a-frame-on-its-own-admin-with-a-day-long-sign-in-of-its-own.md); what 0002 says
about the two sign-ins on one host (the Forms application, its cookie path, the audiences, the daily code) still stands.

**Amended by [0015](0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md):** forms' operator API and reads now run INSIDE the space's Worker, so the space no longer forwards to a forms Worker over a service binding (the two prefixes, `/forms/api/*` and `/forms/logo/*`, are answered by forms' own app in-process, for the operator the one sign-in check named, and no assertion goes along). The section "What is imported from forms" below is replaced by this: the space bundles ALL of forms' code, and the production workflow's `space-imports` filter is `packages/forms/**`. Where the text below says the assertion goes along or that a service binding is stood in for, read that as it was before 0015.

## What changed

The Forms tab drew a frame on forms' own admin page. It now draws the admin's screens (clients, a client, envelopes, an envelope, Send, forms and their
builder, documents and the PDF placement screen, the seal, the history) as components of the space's own page, in the space's look, with the four tabs and
a rail beside them. There is no frame, no second document, and no brand bar or "Signed in as" line to hide.

**Moved into `packages/space/src/client/forms/`, and deleted from `packages/forms`:** every screen, the admin's calls (`api.ts`, `formsApi.ts`,
`documents/api.ts`), its route table and its page (`admin/index.html`, `admin-assets.ts`, the `admin` build entry), forms' "inside the space" header
switch, its `/admin/` page and `/forms/assets/*` routes, and the `/admin/*` headers. Forms' tests of those (`admin-base`, `admin-build`) and its browser
tests of the screens moved with them (`packages/space/e2e`), and `scripts/shot.ts` (every screen at two widths) is `FORMS_SHOTS=<dir> bun test e2e/screens.test.ts` in the space.

**Kept in forms, unchanged for everything outsiders use:** the operator API (`/admin/api/*`), the signer's pages and API, a client's logo
(`/api/logo/<id>`), the privacy notice, the landing page. `forms.<your-domain>/admin` still redirects a read to the Forms tab (a bookmark of
`#/clients/<id>` keeps its fragment through the redirect, and the tab turns it into the screen's own address); forms has no page there any more, so a local run
and an install whose forms is not in the space say so with a 404.

**The space forwards two prefixes, not four:** `/forms/api/*` (forms' `/admin/api/*`) and `/forms/logo/*` (forms' `/api/logo/*`). `/forms/app/` and
`/forms/assets/*` are gone; a path under `/forms` that is neither is the page. The assertion goes along and the cookie never does, as before.

## Loaded when the tab is first opened

The screens, forms' rules, the builder and Tailwind's utilities are a chunk of their own (`React.lazy` in `App.tsx`), loaded the first time the Forms tab is the page, so the other tabs' page is not made larger by them, on a phone too.
The rail's tree of sections is outside it (`forms/FormsTree.tsx`, with the sections in `forms/sections.ts`, which hold no screen). In a production build the main script went from 434 KB to 326 KB and its stylesheet from 50 KB to 26 KB; the Forms
chunk is 108 KB and 24 KB, and the page viewer's chunk (pdf.js, 558 KB) was already loaded only for the placement screen.

## Where the screens are on the address

Paths of the space under the tab's own: `/forms` is the clients, then `/forms/clients/<id>`, `/forms/envelopes`, `/forms/envelopes/<id>` (and `/answers`),
`/forms/send`, `/forms/forms` (and `/<id>`, the builder), `/forms/documents` (and `/<id>`, the placement screen), `/forms/seal`, `/forms/history`. The admin
kept its place in the address's fragment (`#/clients/abc`); that is the old address's, kept alive in `legacyPlace` (`route.ts`) for the bookmark above and nothing else.
No screen is called `api` or `logo`. Today opens a document at `/forms/envelopes/<id>` (`documentPath`, `day.ts`), with a full page load, which is what renews the Forms day-long sign-in; `legacyPlace` is for old bookmarks only. The rail shows the six sections as a tree under the Forms tab, shaped like the inbox's views under Conversations; on a phone, where the rail is a
strip of four tabs, they are a row of chips above the screen. A screen's own links are the admin's `href()`; a click on one moves inside the page, and a screen's own moves
(`go()`) push the address and tell the page the way the browser's Back does, so the address and the screen cannot part.

## The look: Tailwind inside the space

The screens were written in Tailwind v4 and stay so, because rewriting 3,500 lines of markup to the space's class names would change what they do for no gain. The space adds
Tailwind's theme and utilities only, no preflight (which would reset the whole page), and gives the admin's colour names the space's own colours (`forms/forms.css`: `--color-card` is
`var(--panel)`, `--color-border` is `var(--line2)`, `--color-primary` is the accent). The little of preflight the screens need is written under `.forms-tab`. The layers are ordered
`theme, base, components, utilities` at the top of `style.css`, and the space's own rules about bare elements (`a`, `h1`, `p`) sit in `base`, so a utility on a link or a heading beats them;
everything else in the space's CSS is outside the layers and beats a utility where it names the same thing, which the screens never do (they use none of the space's class names). The
builder's live preview is the customer's own screen and keeps its light card.

## What is imported from forms

The screens use rules forms also runs, and two components of the signer's side (`FormRunner`: the builder's preview is the very screen a customer gets; `PdfPages`: the page viewer and its WASM path). The space imports them by path through the
workspace package (`@space/forms/src/...`) rather than copying them: one copy, so the Worker, the signer and the screens cannot disagree about a rule. pdf.js and its WASM are in the space's build, from the same plugin forms' own build uses, so the worker
and the decoders are the space's own files under `/assets/`, found from the folder the script was loaded from. **This was the one list of those files until 0015, which makes the whole of `packages/forms` the space's bundle (`test/forms-imports.test.ts` now holds the workflow's `space-imports` filter, `packages/forms/**`, to that). The files the screens named, for the record:**

- `packages/forms/pdfjs-wasm.ts`: the build plugin that copies pdf.js's WASM decoders, used by both builds
- `packages/forms/src/forms/definition.ts`: the form definition, its visibility and validation rules
- `packages/forms/src/fields.ts`: the field catalog, boxes and checks
- `packages/forms/src/documents/shared.ts`: the document and placement shapes
- `packages/forms/src/settings.ts`: the sender's name, the logo's size limit
- `packages/forms/src/sendWarning.ts`: what Send tells the operator not to send
- `packages/forms/src/vocab.ts`: the envelope statuses
- `packages/forms/src/pdf/geometry.ts`: a box as fractions of a page, and rotation
- `packages/forms/src/pdf/glyphs.ts` and `packages/forms/src/pdf/coverage.ts`: which characters a PDF can print (`definition.ts` and `fields.ts` run them)
- `packages/forms/src/public/FormRunner.tsx`: the one-question-at-a-time screen, which the builder previews
- `packages/forms/src/public/PdfPages.tsx`: pdf.js drawing a document's pages

**The cost:** a change to one of them changes the space's bundle too, and an install may deploy forms from CI and the space by hand. So a push that changes one deploys forms with it and leaves the live space on the old copy until someone runs
`bunx @zabaca/zbc apply <env> space`. A deploy workflow can say so, in the run's summary (a `space-apply-warning`), whenever one of these files changes (since 0015, whenever anything under `packages/forms/**` changes); it deploys nothing.

## The sign-in without a frame

`/forms` and everything under it is still the Forms application's, a day (0002); the page's files and `/api/me` are the space's. Two things follow.

- **A call that finds the Forms session gone reloads the page, once.** The tab opens with a full page load (`ownSignIn` in `/api/me`, unchanged), which Access can send to its sign-in, so a day's
  session is renewed before a screen is drawn. A screen left open past the day, or reached by the browser's Back from another tab, finds it gone on its first call: Access's redirect (which a fetch cannot follow,
  so it shows as a network error), or forms' 401. The admin's calls tell a lost sign-in from a dropped connection as before: a failed call is probed at `/forms/api/me` with the redirect left unfollowed,
  and only an `opaqueredirect` or a 401 is the sign-in ending; anything else keeps the screen and what was typed (`signInEnded`, `session.ts`). The page then reloads its own address, which is under the Forms application, and
  Access signs the person in and brings them back to it. One reload per three minutes (`renewSignIn`, kept from the frame's recovery): a refusal that does not go away is a sentence ("Your sign-in has ended. Reload the
  page to sign in again."), never a loop, and with no storage to remember a try in nothing reloads.
- **`recover.ts` stays.** Its first-visit detour is still needed, and for the same reason as before. The page's own files (`/assets/...`) are the space's application, a month; `/forms` is the Forms application. A person
  with only the Forms session (the first visit after the month ended, or a bookmark of the old forms admin address, which redirects to `/forms`) gets the page and none of its files, and, since the whole screen is
  the space's bundle now, a blank page. The inline script still sends the whole page through `/today`, which Access can sign in to, and the page returns to the place it was. The remembered place is now a path
  (`/forms/clients/abc`) and `takeRecovery` takes any place in the tab, so nothing changed there but that the place is the real address.

**Removed because only the frame needed them:** `frame.ts` (the frame's `load` check, the `postMessage` from the admin and its origin, frame and word check) and forms' `sessionLost()`/`SESSION_LOST`, the "Your Forms sign-in could not be
renewed" notice in the frame, and the Forms tab's `.frame` styles.

## Three content security policies: the page's, a script's, none

The Worker used to set the page's content security policy on every file it served. pdf.js decodes JPEG 2000, JBIG2 and fax images with WebAssembly in its own worker, and the policy that governs a worker is the one its own response carries: the page's has no
`'wasm-unsafe-eval'`, so the worker was refused the compile and fell back to the slower JavaScript decoders. The browser test for a JPX image under the space's policy (`e2e/documents.test.ts`) showed exactly that. Now (`page()` in `app.ts`):

- **HTML** carries the page's policy, as before (`script-src 'self'` and the recovery script's hash, no WebAssembly).
- **A script** (`/assets/*.js` and `.mjs`: a chunk, pdf.js's worker; and the service worker) carries `SCRIPT_POLICY`: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'`. It may load from its own address and compile WebAssembly, and no more; the image is drawn by the
  WASM decoder fetched from the space's own `/assets/pdfjs-wasm/`.
- **Anything else** (an image, a style, the manifest) carries none: nothing is governed through it.

## A chunk that fails to load

The Forms tab's chunk is loaded when it is first opened. A page opened before a deploy, then moved by Back to a Forms screen, asks for a chunk whose old address now answers with the page's HTML, and `import()` rejects. A boundary around it
(`src/client/Boundary.tsx`) keeps the shell and shows "Forms could not be opened. The space may have been updated since this page was loaded." with a Reload button, instead of a blank page (`test/boundary.test.tsx`).

## A window on a Forms screen is a window of the space

The service worker brings a window of the space forward when a notification is tapped (`isAppWindow`, `sw-push.ts`). It used to skip `/forms/...` because the frame's page lived there. A window on a screen of the Forms tab
is now an ordinary page of the space and counts; forms' API answers and logos (`/forms/api/`, `/forms/logo/`, such as a finished PDF opened in its own tab) still do not.

## Tests

The Worker's forwarding, audiences and refusals: `test/app.test.ts`. The screens as a page runs them, the address, a click, a lost sign-in: `test/forms-tab.test.tsx` and `test/recover.test.ts`. The built bundle (the worker and the WASM, no
address of forms' in a file, the styles): `test/forms-build.test.ts`. The screens in a real browser over forms' real Worker (workerd, a local D1 and R2) behind the space's production bundle: `e2e/` (see the README, "Seeing the Forms tab's screens"). **A local preview has no
service binding to forms**, so the browser stands in for it: `e2e/stack.ts` hands the page's calls to `/forms/api/*` and `/forms/logo/*` to forms' own test server at the path the Worker's `formsPathFor` gives, with the Origin forms'
cross-site check compares. The Worker's own forwarding is pinned by the bun test above, not by the e2e; the e2e shows the screens, the CSP pdf.js draws under, and the flows.

## What this does not settle

Nothing here has run against Access: the reload on a lost session is shown with a 401 standing in for Access's redirect, and the redirect case with the probe's `opaqueredirect` in a bun test. A check after the deploy should include a Forms tab left open past a day or a code asked once and not twice, which is where it would show.
