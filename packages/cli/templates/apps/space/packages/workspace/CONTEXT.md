# workspace: Context

The company layer shared by the space (the front door and the one Worker) and the four apps it runs, inbox, forms, meet and knowledge: one place that says
which company an install is, who its people are, how a sign-in becomes a person, where the space is and which tabs it has (of the layer's seven), and which features are on.
A library, not a service: nothing here runs on its own, and each app imports it.

Not meet's "workspace" (channels and direct messages in the meet package). This package's word for one company's
set-up is **install**.

## Glossary

- **Company**: the business an install serves: its name, domain, time zone, and optionally logo and accent color.
  Any company may be served. No company is the operator's: there is no `own`, and no switch is any company's alone (the company layer's [ADR 0004](docs/adr/0004-every-feature-is-a-switch-any-install-may-turn-on-and-the-tabs-are-the-installs.md)).
- **Install**: one running copy of the workspace for one company, in that company's own Cloudflare account. Code: `Install` (`createInstall`).
- **Declaration**: the one JSON file that describes an install, `workspace.json` in the install's environment folder. Read by the deploy (Access's allow list) and by the Workers, so the two cannot disagree. JSON and not
  `.ts` because zbc imports every `.ts` in an environment's folder and demands a module instance from it.
- **Person**: someone in the company, with an `address` (names them, recorded as the actor), a `signIn` address
  (where Access sends their code; the work address unless declared otherwise, which is how a Gmail user is a person),
  a **role** and the shared addresses they are on.
- **Role**: `owner` or `member`. An owner is on every shared address. An install has at least one owner.
- **The install's owner** (`install.owner()`): the first owner the declaration lists. The one person the inbox admits (it has no members yet), the one its refusals and labels name ("Only Tessa can switch
  Claude's sending on or off"), and who "the owner" in a mail or a notice means. Other owners work meet and forms; they are not the inbox's owner until people are kept by the space.
- **Mail name** (a person's optional `mailName`, `mailNameOf(person)`): the name their outgoing mail carries in its From line ("Tessa Marlow" in `Tessa Marlow <tessa@northfield.example>`), where it is not their `name`, the short
  name the space says them by ("Tessa"). Left out, the mail carries `name`. One plain line with no quote or angle bracket, since it goes into a header.
- **Sign-in address**: the address a verified Access assertion carries. The only thing that decides who is asking;
  two people cannot share one.
- **Space**: the one address the company's team signs in at and works in, `space.<domain>` (Northfield Works' is `space.northfield.example`),
  declared as `space` with its host and a sign-in length (a month). The whole host is behind Access, except three paths that guests and signers use and that need no sign-in, each answered with its own
  credential and nothing else: `/r/` a call, `/w/` a channel's guests and `/s/` a signer (`GUEST_PREFIXES`, the workspace package's `src/guests.ts`; they are the layer's and are not declared; the space's ADR 0018).
  The four apps have no hosts of their own: the space's host is the only one, and the old per-app links are not served. Built by the space package.
- **Forms' sign-in** (`forms`): the Forms tab has an Access application of its own, on `space.<domain>/forms`, with a sign-in length of its own (a day, where the space's is a month), because forms holds the
  answers people give to a document. `install.accessApplication('forms')` is that application, `install.tabPath('forms')` its path, and `ownSignIn` marks the tab. Why and how: the space's ADR 0002.
- **Push host** (`gmailPush`): the machine address Google's Pub/Sub delivers Gmail's push to (for example `inbox-push.northfield.example`), a second Custom Domain of the space's Worker with no Access application. Present exactly where the
  `gmail` switch is on, beside the **Google app** (`googleApp`: the install's own OAuth client id and the Pub/Sub topic Gmail's watch publishes to). `install.gmailPushHost()`, `install.googleApp()`.
- **Senders** (`senders`, `install.sender('forms' | 'meet')`): the addresses Forms' signing mail and Meet's invitations and notices go out from, each on the company's own domain (the Worker's send binding allows exactly them);
  the company's `forms@` and `meet@` unless declared (Northfield Works': `forms@northfield.example` and `meet@northfield.example`).
- **Signing service** (`formsService`, `install.formsService()`): what Forms calls itself to a signer ("Northfield Forms": the "via" in a signer's mail, the seal's subject), the **contact** address a person writes to about the service
  and their information, and who **runs** it (`runBy`: a short name, a legal name, the mailing line of the email footer, a site). The contact is required (it is published, so it is never taken from a person's own address,
  ADR 0006); left out, the service is "<company> Forms" and the company itself runs it. Forms' consent, terms and notice keep their sentences and take only these names (ADR 0005; `ownCompanyOnly` below picks between two wordings Forms owns). A company whose Forms another company runs declares who. `ownCompanyOnly: true` (left out by every install that sends for its clients) says Forms sends only for the install's own company: a signer then sees no "via" and no separate party, anywhere (ADR 0005); the company must be the runner (name and legal name), Forms refuses signing for any other business, and it is set when the install is created and never flipped on a live one.
  Claude acts for the install's own company, never the runner: the company's name and its **legal name** (`company.legalName`, "Northfield Works LLC"; the name where left out) are what a certificate and the privacy notice say of Claude's principal.
- **Business mailboxes** (`cloudflareMailboxes`, `install.cloudflareMailboxes()`): the mailboxes fed by Cloudflare Email Routing, each one of a business's: address, name, a short name for sentences and whether its
  spam check begins on. Their **persona** (the assistant's voice) and **spam questions** (what the spam check asks the model) are the install's **content**, a file beside the declaration (`workspace-content.json`) read by the inbox; a mailbox with
  none gets no assistant and no spam check (ADR 0006). A business mailbox, and a mailbox on the install's own mail server (`hostedMailboxes`), also names its **people** (`people`, `install.mailboxPeople(address)`): the work addresses of people of the
  install who are on it, who see its mail in the Inbox and send from it; left out, the owner alone. A name that is not a person of the install is refused when the declaration is read. A Gmail account is its connector's and
  the Telegram mailbox the owner's, so neither is declared. The inbox's rule and its store are the inbox package's `docs/adr/0004`.
- **Origin**: every link the parts make is on the install's space host (`install.url()`); no setting names it (ADR 0005).
- **Agent** (`agent`): Claude's path of the space, only where the `claudeScript` switch is on (below). The name of the service token the path admits is not the declaration's: it is the install file's (`access.agent.token`; the **install file**, below).
- **Install file** (`workspace-install.json` beside the declaration; the kit's `install-file.ts`): what an install is made of in its own Cloudflare account: the account, the Worker, every store, bucket, queue and database name, the Access applications and policies and the machine doors' token names, the Realtime ids and the NAMES (never values) of its secrets. It is read against the declaration (a feature on needs its names; a name for a feature that is off is refused) by the install kit, which makes the zbc instances and the Worker's settings from the pair ([ADR 0007](docs/adr/0007-the-install-kit-makes-an-installs-instances-and-worker-settings-from-its-declaration-and-install-file.md)).
- **Shared address**: a public address on the company's domain that several people work together (info@,
  estimates@). Declared once; a person is on some of them.
- **Business**: one of the businesses a company runs, declared as `businesses`: an id (a slug), a name and the **mailbox**
  addresses that draft for it. An install's are listed in its declaration and nowhere else.
  An address is in at most one business. A declaration that lists none has one business, the company itself, with no mailboxes
  (`install.businesses()`, `install.businessOf(address)`). What the knowledge base marks its entries with;
  the declaration is the one file the inbox, the space and the knowledge app all read,
  so they cannot disagree about the list.
- **Knowledge base**: the install's one set of entries, each marked with the **businesses** it is for, which an assistant reads
  (its own business's active entries only) when the owner asks it for a reply. Kept by the knowledge app (the knowledge package,
  whose `CONTEXT.md` defines entry, status, version and proposal); this package holds only its contract (`src/knowledge.ts`).
- **Client**: a business the company serves and groups people, mail and documents under. The space's own (`ClientsForSpace`, `ClientsForInbox`, `ClientsForSource`, contract `src/clients.ts`; kept by the clients package, whose `CONTEXT.md` defines number, source part, said, gone and the full send). Nothing in the core Client names a source's fields.
- **Clients door** (`clientsDoor` in the declaration, `Install.clientsDoor()`): the third machine path of the space, where an outside system that keeps Clients of its own pushes them in with a service token of its own (named in the install file). Present exactly where the `clientDirectory` switch is on (its only meaning: the install has a source of Clients that pushes). Names the **source** (what its Clients are called: "northfield.example"). May also declare `suggestByAddressKey` (the key of the source's extra fields whose address the inbox suggests a Client by) and `fields` (a label, a kind of text or time, and a list flag per extra key, which is all the space knows of what a source's fields mean). An install without it makes its Clients in its own space.
- **Switch**: an on-or-off feature of the install. All default off, and any install may turn any on (`SWITCHES`): a switch is ALLOWED exactly where the declaration gives the settings it needs and REFUSED without them
  (`parseDeclaration` fails at deploy, naming what is missing), and a setting is refused where its switch is off. What each needs: `gmail` its push host and its **Google app**; `hostedMailboxes` at least one **hosted
  mailbox** (a mailbox on the install's own mail server over JMAP: address, name, door, and the NAME of the secret that holds its key); `phone` its **phone list** (`phone.people`: who has the dial pad and the number each one's 911
  calls leave from, `line` for the install's own number, for one person only); `claudeScript` its `agent` door; `telegram` its bridge's door; `clientDirectory` its Clients door; `assistant` at least one business with a mailbox, which it
  drafts for; `calls` and `manyClients` nothing. `install.has(sw)` is what every part reads (meet refuses a call and answers none of the call API where `calls` is off; meet has no phone, Telnyx, dial pad or Phone conversation where
  `phone` is off; the inbox has no Gmail connection, mail-server mailbox, assistant, spam check or Telegram bridge where its switch is off; the space's Worker answers a path whose switch is off as a path that is not there and has no
  push host where `gmail` is off); `install.switches()` is what the page is told (`/api/me`'s `switches`).
- **Identity**: what the sign-in check returns: a `person` of this install, or (where the app says it takes one) a
  `service` token. A person of another install is refused even when Cloudflare signed their assertion.
- **Tab**: one of the space's seven, Today, Inbox, Meet, Calendar, Forms, People and Knowledge, in that order (`TABS`), of which an install has the ones its switches give it (`Install.tabs`, `hasTab`): **Calendar only where `gmail` is
  on** (a calendar is a Google account's), **Inbox only where the install has a mailbox of any kind** (`Install.hasMailbox`: Gmail, a mailbox on its mail server, Telegram, or a business mailbox it declares); every other tab is every
  install's. This replaces "the same seven tabs in every install" (ADR 0004). The space opens on Today (`HOME_TAB`), which every install has.
- **Entrypoint (for the space)**: the named RPC `WorkerEntrypoint` an app that is still a Worker of its own exports for the space and the space reaches by a
  service binding, inside the account: none is left: the inbox's `SpaceInbox` (and forms' `SpaceForms`, the knowledge app's `SpaceKnowledge` and meet's `SpaceMeet`) are deleted; those parts run in the
  space's Worker, see **Part** below. Its interface is in this package (`InboxForSpace`, `MeetForSpace`), method by method, so the app and the space build to one shape. Not a route, and
  not reachable from the internet or through Access. Prior art: the inbox's former binding to a site's `ClientDirectory`, the space's last service binding, which the Clients part's inbox face replaced, in-process; the inbox is a **Part** (below).
- **Part**: an app's code that runs inside the space's Worker: forms (`FormsForSpace`) and the knowledge app (`KnowledgeForSpace`), meet (`MeetForSpace`) and the inbox (`InboxForSpace`).
  Called as a function, not through a binding, with the person the space's one sign-in check named (**SignedIn**) as the first argument.
  [ADR 0003](docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md).
- **SignedIn**: the person the space's one check named and when the assertion ends (`SignedIn`, made only by `signedIn(person, exp)`). What a part is handed in place of an `Assertion`.
- **Knowledge entrypoints**: the knowledge app (the knowledge package) has two faces. `KnowledgeForSpace` (`knowledge`, `changeKnowledge`) is the Knowledge tab's and is a **part**: it admits the
  install's owner only, and the knowledge store it runs over is a Durable Object class the space's Worker owns (handed over by Cloudflare's Durable Object transfer). The inbox's face
  (`KnowledgeForInbox`: `activeFor`, `readBase`, `propose`) is the inbox's, called in-process in the space's Worker (it was an entrypoint of a `knowledge` Worker, deleted), and takes NO assertion: it has
  no route, and the only thing it can write is a proposal. The contract is `src/knowledge.ts`.
- **Assertion (forwarded)**: GONE. Once, the space passed the Access assertion it received as the first argument of every entrypoint method of an app that was still a Worker of its own, and each
  app verified it itself against the space application's audience. Every part is in the space's Worker now and is handed the person the one check named (**SignedIn**); the `Assertion` type, `identifyForSpace` and the audience var are deleted.
  [ADR 0001](docs/adr/0001-the-apps-verify-the-assertion-the-space-forwards.md) is the record, superseded by ADR 0003.
- **Reply**: what every entrypoint method answers (`SpaceReply`): the value, a **refusal** or a **failure**, as data and never
  an exception.
- **Refusal**: an app said no, knowing who was asking (`Refused`; reasons `not-signed-in`, `not-admitted`, `not-found`,
  `bad-request`, `conflict`, `limit`). The space shows the rest and does not say "could not be reached".
- **Failure**: an app could not do what was asked (`Failed`, reason `broken` and nothing else: the only failure an app may
  return). The space shows that **part** as could not be reached.
- **Unanswered**: the space's own failure, which no app can make (`Unanswered`): `unreachable` (the binding threw),
  `timed-out` (a READ not answered within `ANSWER_WITHIN_MS`, 4 seconds), `not-understood` (not the contract's shape), and
  `outcome-unknown` (a WRITE the space lost track of). The space shows that part as could not be reached.
- **Read and write**: a read is awaited `ANSWER_WITHIN_MS`; a write (the inbox's `send`, `markRead`, `closeConversations` and
  `reopenConversations`, meet's `post` and `markRead`) is awaited `WRITE_WITHIN_MS` (30 seconds, past the inbox's own 25 for Gmail). A write the space loses track of is
  "outcome unknown" and is never retried by the space. **The exception is a write that is idempotent and re-guarded** (the inbox's
  `markRead`, `closeConversations` and `reopenConversations`, meet's `markRead`): doing it twice is doing it once, and the position it
  names (`through`) is checked afresh on every call, so a lost answer is not an unknown outcome. The space asks for it on the read path
  (`reach`, waiting `WRITE_WITHIN_MS`), reads the state again when no answer comes, and shows how it stands; pressing it again is safe.
- **Compose key**: the `ComposeKey` the space chooses once per message being written and sends with every `send` variant and
  every `post`. The app HOLDS it (at least `COMPOSE_KEY_KEPT_MS`, a day) only while the first use may have sent something: in
  progress, sent, or the inbox's own `sending`; a repeat of a held key answers `Repeated` and nothing new is sent. A first use
  that was refused or failed (`broken`, nothing went out) RELEASES the key, so Send pressed again in the same compose sends.
  An app that cannot tell answers success with status `sending` and holds the key. An `in-progress` record older than
  `WRITE_WITHIN_MS` answers as done with `sending`. The inbox's tests and meet's each prove both cases.
- **Live object**: a teammate's page holds one socket, to the company's `LiveDO` (`LIVE_SOCKET_PATH`, `/api/live`), told after a store has stored a change with a `LiveMessage` (a part, the people, perhaps the conversation; never what changed: `live.ts`). Meet's old team socket and ticket are gone; `MeetForSpace.fetch` serves the phone's prefix only.
- **Part**: one of the three things the space draws from: mail (the inbox), chat (meet), documents (forms) (`SPACE_PARTS`).
- **Address (normalised)**: the one spelling every side compares an email address in (`normalizeAddress`): bare, lowercase, a
  display name stripped, nothing else folded. The key of every join in the space, and the spelling of EVERY address an app puts
  in an answer; the forms, inbox and meet tests each prove that.
- **Row**: one line of Conversations (`ConversationRow`). A **person row** is one person joined by normalised address across the
  inbox's contacts, the team and meet's people (a teammate is joined on both their `address` and their `signIn`, so a person can have two
  inbox contacts: `mail` is a list); a **channel row** is one meet channel. A row's time is its newest item from any
  source, its unread the sum of the sides', its **kind** (how it came) the newest item's. The merge is the space's; the
  shapes are here (`PersonRow`, `ChannelRow`, `ConversationList`).

## What each app calls

- `createInstall(json)`: once, at start, with the declaration the deploy bundled.
- `identify(install, headers, { fetch, aud, now }, { allowServiceTokens? })`: the sign-in check, in place of the
  app's own copy of the verifier and its list of people.
- `install.has('calls')`, `install.switches()`, `install.hasTab('calendar')`, `install.googleApp()`, `install.hostedMailboxes()`, `install.phonePeople()`, `install.isOwner(person)`, `install.owner()`, `mailNameOf(person)`, `install.sharedAddressesOf(person)`, `install.tabs('today')`,
  `install.url()`, `install.company`, `install.sender(app)`, `install.formsService()`.
- `install.accessApplication('space')` (or `'forms'`, Forms' day-long application on the tab's path): for the zbc instance file, in place of a hand-written Access block.

## What the space asks of the apps

Every method takes the `SignedIn` person first and answers a `SpaceReply`.

- `InboxForSpace`: `people`, `messagesWith` (paged by `before`, with `more`), `drafts` (no `through`: a draft is sent with the thread's own), `send`
  (every variant keyed), `markRead` (a per-item `Refused` or `Failed`), `search`. Beyond these the inbox's other views, and then
  `closeConversations` (each conversation at its `through`, refused with `conflict` when mail arrived after it, as the inbox's own
  Close is) and `reopenConversations` (by id); both idempotent, so keyless, and per-item answers like `markRead`. The contacts for People
  (`inbox-people.ts`): `contacts` (every contact that is a person, automated senders counted and left out), `contact` (with its note), `saveContactProfile`
  (business, role and notes at the revision the caller was shown), `mergeContacts` (at both revisions; answers a `mergeId`) and `undoContactMerge` (by that number).
  A contact's `rev` goes up on a save and on a merge or its undo, never down, and a write over a stale one is `conflict` with nothing changed.
- `MeetForSpace`: `conversations` (with the Phone conversation's summary and the person's New calls), `history`, `post` (keyed), `markRead`,
  `liveCalls` (the calls with someone in them that are the asker's, with why: made, invited, or a huddle in their conversation), and `startHuddle`, `startCall` and `bookMeeting` (each
  keyed, each answering a `MeetCall` that carries its link, made by meet from its public address), `cards`, `calls` (past calls, paged by meet's cursor), `callChat`, `deleteCallChat`, `meetings`, `usage`,
  `phoneConversation` and `phoneRead`; and `fetch` for the dial pad's own requests under `MEET_PHONE_PATH`. Meet sends no email for any of them. `CallRow` and `PhoneRow` join the rows.
  meet has no switch and no host of its own (the declaration names no app).
- `FormsForSpace`: `documentsOn`, `documents`. A document's title and state, counts, and the names of the signers who have
  not signed; never what it holds. Documents per conversation are joined by the envelope's ref (the space's ADR 0010).
- `refused`, `failed`, `answered`, `repeated`: build an app's reply; `unanswered`: the space's own. `refusedForSignIn`: the
  layer's sign-in refusals as the space sees them.
- Three values are COPIES, since this package cannot import the apps, and each app's test pins its own equal: `DocumentState`
  (to forms' `EnvelopeStatus`), `MailKind` (to the inbox's `IdentityKind`) and `SNIPPET_CHARS` (to the inbox's
  `EXCERPT_CHARS`, and that meet's cut is as long).
- The audience: the space's Worker takes the `space-access` instance's `aud` output as `CF_ACCESS_AUD` (the install's `space-access` instance file). No other Worker takes it: the inbox and meet took it as `SPACE_ACCESS_AUD` while they were Workers of their own, and none does now.

## The inbox on this layer

The inbox's Access was not the same shape as forms' and meet's; what carries the difference:

- **The inbox has no address for people.** The declaration names it twice: `gmailPush.host` (the machine address Google's push calls,
  with no Access application on it) and `agent` (the `path` below; only where the `claudeScript` switch is on, and the
  two come together; the name of the token Claude's script signs in as is the install file's). It names no Access policy, no sign-in length and no redirect to the space. The space admits a service token only for an install with that switch, and only the one whose
  client id is its `INBOX_ACCESS_CLIENT_ID`.
- **Claude's door on the space.** `agent.path` ("/agent/inbox") names the one path of the
  space's host where that token is let in, through an Access application of its own that admits the token and no person
  (the install's `space-agent-access` instance file). `install.agentDoor()` returns it (path, the host and path Access protects, the
  address) and `agentRoute()` says which request paths are on it and what inbox path they stand for; the declaration refuses it without the `claudeScript` switch, or on the space's `/api` or a tab. This is the one exception to "no service token comes through
  the space": [ADR 0002](docs/adr/0002-one-service-token-comes-through-the-space-on-one-path-to-one-app.md). The request is checked once, in the space, and handed to the inbox's router in-process with the token that check verified; the inbox's `ClaudeInbox` entrypoint is deleted.
- **Audience length.** The inbox's old check took 32 or more hex characters; the layer's `AUD_TAG` is exactly 64. The live
  audience is 64, so the inbox moved onto the layer's check unchanged in effect.
- **The cookie.** The inbox's old check also read the `CF_Authorization` cookie; it now reads the header only. That is safe
  because the inbox's Access application covers the whole host, so the header is on every request it answers.
